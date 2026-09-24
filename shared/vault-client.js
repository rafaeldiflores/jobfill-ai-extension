/**
 * JobFill AI - Conexión con el vault a través del servidor MCP "postulador".
 *
 * El postulador (rdf-grafo/postulador-mcp) es un Cloudflare Worker con OAuth
 * 2.1 y login de GitHub para un único usuario, con listas blancas de rutas.
 * La extensión se conecta como un cliente MÁS, igual que claude.ai:
 *
 *   extensión ──OAuth (PKCE + registro dinámico)──▶ Worker ──▶ rdf-vault
 *     ├─ cv_contexto          → BASE_Experiencia.md + reglas (solo lectura)
 *     └─ postulacion_guardar  → postulaciones/Empresa - Cargo.md (Tracker)
 *
 * Por qué así y no con un token de GitHub en la extensión: un token
 * fine-grained no se puede limitar por carpeta, así que vería TODO el vault
 * privado. El Worker ya aplica "lee solo la BASE, escribe solo el Tracker" y
 * nunca permite escribir la BASE.
 *
 * Script clásico (sin módulos), como shared/ai-client.js. Las funciones
 * puras están separadas de las que tocan red o `chrome.*` para testearlas.
 */
(function (root) {
  "use strict";

  const PROTOCOL_VERSION = "2025-06-18";
  const CLIENT_NAME = "JobFill AI (extensión de navegador)";

  // ─── Funciones puras ─────────────────────────────────────────────────────

  /** URL base del Worker, sin barra final ni `/mcp` (el usuario puede pegar cualquiera de las dos). */
  function normalizeServerUrl(input) {
    const raw = String(input || "").trim().replace(/\/+$/, "").replace(/\/mcp$/i, "");
    if (!raw) return "";
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch (e) {
      throw new Error("La URL del postulador no es válida.");
    }
    // Credenciales OAuth solo por HTTPS (localhost se permite para desarrollo).
    if (url.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
      throw new Error("El postulador debe usar https://");
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }

  function base64Url(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(byteLength = 32) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  /** PKCE S256: challenge = base64url(sha256(verifier)). */
  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
  }

  function buildAuthorizeUrl(authorizationEndpoint, { clientId, redirectUri, codeChallenge, state }) {
    const url = new URL(authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /**
   * Respuesta MCP por Streamable HTTP: puede llegar como JSON plano o como
   * stream SSE (`data: {...}` por evento). Devuelve el mensaje JSON-RPC con
   * el `id` pedido.
   */
  function parseMcpResponse(contentType, body, id) {
    const messages = [];
    if (/text\/event-stream/i.test(contentType || "")) {
      for (const block of String(body).split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try { messages.push(JSON.parse(data)); } catch (e) { /* evento no JSON: se ignora */ }
      }
    } else if (String(body).trim()) {
      const parsed = JSON.parse(body);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    return messages.find(m => m && m.id === id) || null;
  }

  /**
   * Resultado de una herramienta del postulador: el Worker devuelve
   * `content[0].text` con JSON, o `isError` con un texto legible.
   */
  function parseToolResult(result) {
    const text = (result?.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    if (result?.isError) throw new Error(text || "El postulador devolvió un error.");
    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }

  /** Datos de una postulación para el Tracker, validados como los valida el Worker. */
  function buildApplicationPayload({ empresa, cargo, url, canal, notas, cvPerfil, cvPdf, area, keywordsCubiertas, fecha }) {
    const clip = (v, n) => String(v || "").trim().slice(0, n);
    const payload = {
      empresa: clip(empresa, 120),
      cargo: clip(cargo, 200),
      estado: "Postulado",
      // Fecha en Chile, igual que el artefacto Postulador: con UTC, una
      // postulación hecha de noche quedaba registrada con el día siguiente.
      fecha: clip(fecha || new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" }), 10)
    };
    if (!payload.empresa) throw new Error("Falta la empresa.");
    if (!payload.cargo) throw new Error("Falta el cargo.");
    if (url) payload.url = clip(url, 500);
    if (canal) payload.canal = clip(canal, 120);
    if (cvPerfil) payload.cv_perfil = clip(cvPerfil, 60);
    if (cvPdf) payload.cv_pdf = clip(cvPdf, 200);
    if (area) payload.area = clip(area, 200);
    if (keywordsCubiertas) payload.keywords_cubiertas = clip(keywordsCubiertas, 1000);
    if (notas) payload.notas = clip(notas, 2000);
    return payload;
  }

  // ─── OAuth (red + chrome.identity) ───────────────────────────────────────

  async function discoverOAuth(serverUrl) {
    const origin = new URL(serverUrl).origin;
    try {
      const res = await fetch(`${origin}/.well-known/oauth-authorization-server`);
      if (res.ok) {
        const meta = await res.json();
        if (meta.authorization_endpoint && meta.token_endpoint) return meta;
      }
    } catch (e) { /* se usan las rutas por defecto del postulador */ }
    return {
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`
    };
  }

  async function registerClient(meta, redirectUri) {
    if (!meta.registration_endpoint) throw new Error("El servidor no permite registrar clientes (falta registration_endpoint).");
    const res = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    });
    if (!res.ok) throw new Error(`No se pudo registrar la extensión en el postulador (${res.status}).`);
    const data = await res.json();
    if (!data.client_id) throw new Error("El postulador no devolvió client_id.");
    return data.client_id;
  }

  async function tokenRequest(tokenEndpoint, params) {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const err = new Error(data.error_description || data.error || `Token rechazado (${res.status}).`);
      err.status = res.status;
      throw err;
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null
    };
  }

  /**
   * Login completo: descubrimiento → registro dinámico → autorización con
   * PKCE en la ventana de chrome.identity (ahí el usuario entra con GitHub)
   * → canje del código. Devuelve lo que hay que guardar en `vaultAuth`.
   */
  async function connect(serverUrlInput) {
    const serverUrl = normalizeServerUrl(serverUrlInput);
    if (!serverUrl) throw new Error("Pega la URL de tu postulador (p. ej. https://postulador-mcp.tu-cuenta.workers.dev).");

    const meta = await discoverOAuth(serverUrl);
    const redirectUri = chrome.identity.getRedirectURL("vault");
    const clientId = await registerClient(meta, redirectUri);

    const verifier = randomString(48);
    const state = randomString(16);
    const authorizeUrl = buildAuthorizeUrl(meta.authorization_endpoint, {
      clientId, redirectUri, codeChallenge: await pkceChallenge(verifier), state
    });

    const redirected = await chrome.identity.launchWebAuthFlow({ url: authorizeUrl, interactive: true });
    const params = new URL(redirected).searchParams;
    if (params.get("error")) throw new Error(`Acceso denegado: ${params.get("error_description") || params.get("error")}`);
    if (params.get("state") !== state) throw new Error("La respuesta del login no corresponde a esta solicitud (state distinto).");
    const code = params.get("code");
    if (!code) throw new Error("El login no devolvió un código de autorización.");

    const tokens = await tokenRequest(meta.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier
    });
    return { serverUrl, clientId, tokenEndpoint: meta.token_endpoint, ...tokens, connectedAt: Date.now() };
  }

  async function refresh(auth) {
    if (!auth?.refreshToken) throw new Error("La sesión con el vault expiró. Vuelve a conectar.");
    const tokens = await tokenRequest(auth.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: auth.clientId
    });
    return { ...auth, ...tokens, refreshToken: tokens.refreshToken || auth.refreshToken };
  }

  // ─── MCP (Streamable HTTP) ───────────────────────────────────────────────

  async function mcpPost(serverUrl, accessToken, sessionId, message) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
      headers["mcp-protocol-version"] = PROTOCOL_VERSION;
    }
    const res = await fetch(`${serverUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
    if (res.status === 401) {
      const err = new Error("No autorizado por el postulador.");
      err.status = 401;
      throw err;
    }
    if (!res.ok && res.status !== 202) throw new Error(`El postulador respondió ${res.status}.`);
    const body = res.status === 202 ? "" : await res.text();
    return { res, body, sessionId: res.headers.get("mcp-session-id") || sessionId };
  }

  /** initialize → notifications/initialized → tools/call. Una sesión por llamada: son operaciones esporádicas. */
  async function callTool(serverUrl, accessToken, name, args) {
    const init = await mcpPost(serverUrl, accessToken, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "1" } }
    });
    const initReply = parseMcpResponse(init.res.headers.get("content-type"), init.body, 1);
    if (!initReply || initReply.error) throw new Error(`No se pudo iniciar la sesión MCP: ${initReply?.error?.message || "sin respuesta"}`);

    await mcpPost(serverUrl, accessToken, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });

    const call = await mcpPost(serverUrl, accessToken, init.sessionId, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args || {} }
    });
    const reply = parseMcpResponse(call.res.headers.get("content-type"), call.body, 2);
    if (!reply) throw new Error(`El postulador no respondió a ${name}.`);
    if (reply.error) throw new Error(`${name}: ${reply.error.message}`);
    return parseToolResult(reply.result);
  }

  /**
   * Llama una herramienta con el `auth` guardado; si el token expiró lo
   * renueva UNA vez. Devuelve { data, auth } para que el llamador guarde el
   * auth renovado.
   */
  async function callWithAuth(auth, name, args) {
    let current = auth;
    if (current.expiresAt && current.expiresAt - Date.now() < 60_000) current = await refresh(current);
    try {
      return { data: await callTool(current.serverUrl, current.accessToken, name, args), auth: current };
    } catch (err) {
      if (err.status !== 401) throw err;
      current = await refresh(current);
      return { data: await callTool(current.serverUrl, current.accessToken, name, args), auth: current };
    }
  }

  root.JobFillVault = {
    normalizeServerUrl,
    pkceChallenge,
    buildAuthorizeUrl,
    parseMcpResponse,
    parseToolResult,
    buildApplicationPayload,
    connect,
    refresh,
    callTool,
    callWithAuth
  };
})(typeof self !== "undefined" ? self : globalThis);
