/**
 * JobFill AI - Cliente único de Claude (Anthropic API directa o Google Vertex AI).
 *
 * Este archivo es la ÚNICA implementación de la llamada a Claude. Lo cargan
 * tanto el service worker (`importScripts`) como la página de opciones
 * (`<script>`), porque antes cada uno tenía su propio `fetch()` a Anthropic y
 * así fue como se desincronizaron los IDs de modelo entre archivos. Agregar un
 * proveedor (Vertex) en tres copias habría repetido el mismo error.
 *
 * Script clásico sin módulos a propósito: el service worker del manifest no
 * es `type: "module"` y la extensión no tiene bundler. Expone todo bajo
 * `self.JobFillAi`.
 *
 * Proveedores:
 *  - "anthropic": POST api.anthropic.com/v1/messages con `x-api-key`.
 *  - "vertex":    POST .../publishers/anthropic/models/{modelo}:rawPredict.
 *    Mismo cuerpo que la Messages API, salvo que el modelo va en la URL (no en
 *    el body) y se agrega `anthropic_version: "vertex-2023-10-16"`.
 *    Credencial: una API key de Google Cloud (header `x-goog-api-key`) o un
 *    access token OAuth (`ya29.…`, de `gcloud auth print-access-token`), que
 *    se envía como `Authorization: Bearer`. Se distinguen por el prefijo.
 */
(function (root) {
  "use strict";

  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
  const DEFAULT_VERTEX_REGION = "global";
  const DEFAULT_TIMEOUT_MS = 60000;

  /** Los únicos dos modelos del proyecto (ver .agents/rules/anthropic-models.md). */
  const MODEL_SONNET = "claude-sonnet-5";
  const MODEL_HAIKU = "claude-haiku-4-5";

  /**
   * IDs a probar en Vertex, en orden. Vertex publica los modelos más nuevos
   * con el ID sin versión (Sonnet 5), pero los de snapshot fechado (Haiku 4.5)
   * con separador `@`. El sufijo con `@` es propio de Vertex: la prohibición de
   * "sufijos de fecha" en las reglas del proyecto aplica al guion (`-20251001`),
   * que Anthropic rechaza con 404. Si Vertex no reconoce el primero (404), se
   * prueba el siguiente.
   */
  const VERTEX_MODEL_IDS = {
    [MODEL_SONNET]: ["claude-sonnet-5"],
    [MODEL_HAIKU]: ["claude-haiku-4-5@20251001", "claude-haiku-4-5"]
  };

  /** Cualquier nombre de modelo se reduce a uno de los dos permitidos. */
  function canonicalModel(model) {
    return String(model || "").toLowerCase().includes("haiku") ? MODEL_HAIKU : MODEL_SONNET;
  }

  /** Quita espacios, saltos y comillas que se cuelan al copiar/pegar una clave. */
  function cleanCredential(value) {
    return String(value || "").replace(/[\r\n\t\s"']/g, "");
  }

  /**
   * Lee los ajustes de IA desde lo guardado en storage (o desde los inputs de
   * la página de opciones, con las mismas claves). Sin `aiProvider` guardado
   * se asume Anthropic: es lo que usaban todas las instalaciones previas.
   */
  function readAiSettings(source) {
    const s = source || {};
    return {
      provider: s.aiProvider === "vertex" ? "vertex" : "anthropic",
      anthropicKey: cleanCredential(s.claudeApiKey),
      vertexCredential: cleanCredential(s.vertexApiKey),
      vertexProjectId: String(s.vertexProjectId || "").trim(),
      vertexRegion: String(s.vertexRegion || "").trim() || DEFAULT_VERTEX_REGION
    };
  }

  /** `null` si se puede llamar a Claude; si no, qué falta, en palabras del usuario. */
  function aiSettingsProblem(settings) {
    if (settings.provider === "vertex") {
      if (!settings.vertexCredential) return "Falta la API Key (o access token) de Vertex AI. Ingrésala en la pestaña '🤖 Claude IA'.";
      if (!settings.vertexProjectId) return "Falta el ID del proyecto de Google Cloud para Vertex AI. Ingrésalo en la pestaña '🤖 Claude IA'.";
      if (!/^[a-z0-9-]+$/.test(settings.vertexRegion)) return `La región de Vertex AI "${settings.vertexRegion}" no es válida (ej: global, us-east5, europe-west1).`;
      return null;
    }
    if (!settings.anthropicKey) return "No se ha configurado la API Key de Claude. Ingrésala en la pestaña '🤖 Claude IA'.";
    return null;
  }

  function hasAiCredentials(storageOrSettings) {
    const settings = storageOrSettings && storageOrSettings.provider ? storageOrSettings : readAiSettings(storageOrSettings);
    return aiSettingsProblem(settings) === null;
  }

  function describeProvider(settings) {
    return settings.provider === "vertex"
      ? `Vertex AI (${settings.vertexProjectId || "sin proyecto"} · ${settings.vertexRegion})`
      : "Anthropic API";
  }

  /** Un access token OAuth de Google empieza con "ya29."; lo demás se trata como API key. */
  function isGoogleAccessToken(credential) {
    return /^ya29\./.test(credential);
  }

  // `vertexModelId` va sin codificar: sale de VERTEX_MODEL_IDS (constante
  // propia) y Vertex documenta el `@` literal en la ruta; codificarlo a %40
  // produce una URL distinta a la documentada.
  function vertexEndpoint(settings, vertexModelId) {
    const region = settings.vertexRegion;
    // La región "global" no lleva prefijo de host; las regionales sí.
    const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${encodeURIComponent(settings.vertexProjectId)}` +
      `/locations/${region}/publishers/anthropic/models/${vertexModelId}:rawPredict`;
  }

  /**
   * Arma las peticiones HTTP candidatas (en orden) para un modelo. Función
   * pura, sin red: es lo que prueban los tests.
   *
   * `body` es un cuerpo de la Messages API SIN `model`.
   */
  function buildClaudeRequests(settings, model, body) {
    const canonical = canonicalModel(model);

    if (settings.provider === "vertex") {
      const credential = settings.vertexCredential;
      const authHeader = isGoogleAccessToken(credential)
        ? { authorization: `Bearer ${credential}` }
        : { "x-goog-api-key": credential };
      return VERTEX_MODEL_IDS[canonical].map(vertexModelId => ({
        sentModel: vertexModelId,
        url: vertexEndpoint(settings, vertexModelId),
        headers: { "content-type": "application/json", ...authHeader },
        body: { anthropic_version: VERTEX_ANTHROPIC_VERSION, ...body }
      }));
    }

    return [{
      sentModel: canonical,
      url: ANTHROPIC_URL,
      headers: {
        "x-api-key": settings.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: { model: canonical, ...body }
    }];
  }

  /** Error con `status` HTTP y un mensaje que el usuario pueda accionar. */
  function friendlyError(settings, status, rawMessage) {
    const raw = rawMessage || `Error ${status}`;
    const lower = raw.toLowerCase();
    let message;

    if (settings.provider === "vertex") {
      if (lower.includes("api keys are not supported") || lower.includes("api key not valid")) {
        message = `Vertex AI rechazó la API Key (${raw}). Si tu proyecto no acepta API keys para modelos de Anthropic, pega en su lugar un access token de "gcloud auth print-access-token" (dura 1 hora).`;
      } else if (status === 401) {
        message = `Error 401 Vertex AI: credencial inválida o token expirado (los access tokens duran 1 hora). Detalle: ${raw}`;
      } else if (status === 403) {
        message = `Error 403 Vertex AI: sin permiso. Revisa que la API "Vertex AI" esté habilitada en el proyecto, que Claude esté habilitado en Model Garden y que la cuenta de la credencial tenga el rol "Vertex AI User". Detalle: ${raw}`;
      } else if (status === 429) {
        message = `Error 429 Vertex AI: cuota agotada para este modelo/región. Pide más cuota en la consola de Google Cloud o prueba la región "global". Detalle: ${raw}`;
      } else if (status === 404) {
        message = `Error 404 Vertex AI: el modelo no está disponible en la región "${settings.vertexRegion}" o no está habilitado en Model Garden. Detalle: ${raw}`;
      } else {
        message = `Error Vertex AI (${status}): ${raw}`;
      }
    } else if (status === 401) {
      message = "Error 401: Tu API Key de Claude es inválida o no autorizada. Cópiala directamente desde console.anthropic.com.";
    } else if (status === 429 || lower.includes("credit") || lower.includes("balance")) {
      message = `Error 429 Anthropic: Saldo agotado o límite de uso alcanzado (${raw}). Recarga saldo en console.anthropic.com.`;
    } else {
      message = `Error Anthropic (${status}): ${raw}`;
    }

    const err = new Error(message);
    err.status = status;
    return err;
  }

  /**
   * Llama a Claude con el proveedor configurado y devuelve el JSON de la
   * Messages API (idéntico en ambos proveedores).
   *
   * Solo se pasa al siguiente ID candidato ante un 404 (modelo no encontrado):
   * cualquier otro error (credencial, cuota, permisos) fallaría igual con el
   * siguiente, y reintentar solo escondería la causa.
   */
  async function callClaude(settings, { model, system, messages, max_tokens = 1500, thinking, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const problem = aiSettingsProblem(settings);
    if (problem) throw new Error(problem);

    const body = { max_tokens, messages };
    if (thinking) body.thinking = thinking;
    if (system) body.system = system;

    const candidates = buildClaudeRequests(settings, model, body);
    let lastError = null;

    for (const request of candidates) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      console.log(`[JobFill AI] Llamando a Claude vía ${describeProvider(settings)} — modelo: "${request.sentModel}" (max_tokens: ${max_tokens})`);

      let response;
      try {
        response = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal
        });
      } catch (err) {
        const timeoutMsg = `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s) al conectar con Claude vía ${describeProvider(settings)}.`;
        throw new Error(err.name === "AbortError" ? timeoutMsg : `Error de red al conectar con ${describeProvider(settings)}: ${err.message}`);
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok) return response.json();

      // Anthropic y Google devuelven ambos `{ error: { message } }`; Vertex a
      // veces envuelve el error en un array de un elemento.
      const errorData = await response.json().catch(() => ({}));
      const errorObj = Array.isArray(errorData) ? errorData[0]?.error : errorData?.error;
      const rawMessage = errorObj?.message || `${response.status} ${response.statusText}`;

      console.error("[JobFill AI] Claude rechazó la petición:", {
        provider: settings.provider, status: response.status, model: request.sentModel, error: errorObj || errorData
      });

      lastError = friendlyError(settings, response.status, rawMessage);
      if (response.status !== 404) throw lastError;
    }

    throw lastError || new Error("No se pudo conectar con Claude (sin respuesta del servidor).");
  }

  root.JobFillAi = {
    MODEL_SONNET,
    MODEL_HAIKU,
    VERTEX_MODEL_IDS,
    canonicalModel,
    readAiSettings,
    aiSettingsProblem,
    hasAiCredentials,
    describeProvider,
    buildClaudeRequests,
    callClaude
  };
})(typeof self !== "undefined" ? self : globalThis);
