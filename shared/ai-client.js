/**
 * JobFill AI - Cliente único de IA: Claude (Anthropic) con respaldo en Gemini
 * (Google Vertex AI).
 *
 * Este archivo es la ÚNICA implementación de la llamada a la IA. Lo cargan el
 * service worker (`importScripts`), la página de opciones y el popup
 * (`<script>`). Antes cada uno tenía su propio `fetch()` a Anthropic, y así fue
 * como se desincronizaron los IDs de modelo entre archivos.
 *
 * Script clásico sin módulos a propósito: el service worker del manifest no
 * es `type: "module"` y la extensión no tiene bundler. Expone todo bajo
 * `self.JobFillAi`.
 *
 * Proveedores:
 *  - "anthropic": POST api.anthropic.com/v1/messages con `x-api-key`.
 *  - "gemini":    POST aiplatform.googleapis.com/v1/publishers/google/models/
 *    {modelo}:generateContent con `x-goog-api-key` (Vertex AI "modo express":
 *    una API key, sin proyecto ni región).
 *
 * El resto de la extensión habla SIEMPRE en formato de la Messages API de
 * Anthropic (system, messages con bloques, `content[].text`, `stop_reason`).
 * Cuando responde Gemini, este archivo traduce la petición y la respuesta, así
 * que prompts, caché y parseo no necesitan saber qué modelo contestó.
 *
 * Respaldo: si el proveedor principal es Claude y falla por SALDO o CAPACIDAD
 * (créditos agotados, 429, 529 sobrecargado), la misma petición se repite con
 * Gemini. Un error de credencial (401) o de petición NO activa el respaldo:
 * eso hay que arreglarlo, no esconderlo detrás de otro modelo.
 */
(function (root) {
  "use strict";

  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const GEMINI_BASE_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models";
  const DEFAULT_TIMEOUT_MS = 60000;

  /** Los únicos dos modelos de Claude del proyecto (ver .agents/rules/anthropic-models.md). */
  const MODEL_SONNET = "claude-sonnet-5";
  const MODEL_HAIKU = "claude-haiku-4-5";

  /**
   * Equivalente en Gemini de cada modelo de Claude, en orden de preferencia:
   * Gemini 3.8 Flash para todo (elección del usuario), con 2.5 Flash como red
   * de seguridad. Se prueba el siguiente candidato si el anterior da 404,
   * 429 (cuota de ese modelo) o 400 que no sea de la API key (p. ej. un
   * `thinkingConfig` que ese modelo no acepta). Sin la variante `-preview`:
   * verificado en la cuenta real, `gemini-3.8-flash` existe en modo express y
   * la preview da 404 en su región (southamerica-west1): era una llamada
   * perdida en cada respaldo.
   *
   * Razonamiento: Gemini razona por defecto y esos tokens salen de
   * `maxOutputTokens` — el mismo problema por el que se desactiva el thinking
   * de Sonnet 5: con presupuestos chicos la respuesta llega vacía. Gemini 3 lo
   * regula con `thinkingLevel` (no se puede apagar del todo, así que se suma
   * margen con `extraOutputTokens`); 2.5 Flash con `thinkingBudget: 0`.
   * Nivel "low" para todo: 3.8 Flash rechaza "minimal" con un 400
   * ("Thinking level is unsupported: THINKING_LEVEL_MINIMAL").
   */
  const GEMINI_3_8_FLASH_IDS = ["gemini-3.8-flash"];
  const GEMINI_2_5_FLASH = { id: "gemini-2.5-flash", thinkingConfig: { thinkingBudget: 0 }, extraOutputTokens: 0 };
  const gemini38 = thinkingLevel => GEMINI_3_8_FLASH_IDS.map(id => ({ id, thinkingConfig: { thinkingLevel }, extraOutputTokens: 1024 }));

  const GEMINI_MODELS = {
    [MODEL_SONNET]: [...gemini38("low"), GEMINI_2_5_FLASH],
    [MODEL_HAIKU]: [...gemini38("low"), GEMINI_2_5_FLASH]
  };

  const PROVIDER_LABELS = { anthropic: "Claude (Anthropic)", gemini: "Gemini (Vertex AI)" };

  /** Cualquier nombre de modelo se reduce a uno de los dos de Claude permitidos. */
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
   * se asume Anthropic: es lo que usaban todas las instalaciones previas. El
   * respaldo viene activado salvo que se haya desactivado explícitamente —
   * igual no hace nada mientras no haya una key de Gemini.
   */
  function readAiSettings(source) {
    const s = source || {};
    return {
      provider: s.aiProvider === "gemini" ? "gemini" : "anthropic",
      anthropicKey: cleanCredential(s.claudeApiKey),
      geminiKey: cleanCredential(s.vertexApiKey),
      fallbackToGemini: s.aiFallbackToGemini !== false
    };
  }

  function credentialFor(settings, provider) {
    return provider === "gemini" ? settings.geminiKey : settings.anthropicKey;
  }

  /** `null` si el proveedor principal se puede llamar; si no, qué falta. */
  function aiSettingsProblem(settings) {
    if (settings.provider === "gemini" && !settings.geminiKey) {
      return "Falta la API Key de Vertex AI (Gemini). Ingrésala en la pestaña '🤖 Claude IA'.";
    }
    if (settings.provider === "anthropic" && !settings.anthropicKey) {
      return "No se ha configurado la API Key de Claude. Ingrésala en la pestaña '🤖 Claude IA'.";
    }
    return null;
  }

  function hasAiCredentials(storageOrSettings) {
    const settings = storageOrSettings && storageOrSettings.provider ? storageOrSettings : readAiSettings(storageOrSettings);
    return aiSettingsProblem(settings) === null;
  }

  /** ¿Hay un respaldo de Gemini utilizable detrás de Claude? */
  function hasGeminiFallback(settings) {
    return settings.provider === "anthropic" && settings.fallbackToGemini && Boolean(settings.geminiKey);
  }

  function describeProvider(provider) {
    return PROVIDER_LABELS[provider] || provider;
  }

  // ─── Traducción Messages API ⇄ Gemini generateContent (funciones puras) ────

  /** Bloques de contenido de Anthropic → `parts` de Gemini. `cache_control` no aplica y se descarta. */
  function toGeminiParts(content) {
    if (typeof content === "string") return [{ text: content }];
    return (Array.isArray(content) ? content : [])
      .map(block => {
        if (block?.type === "text" && typeof block.text === "string") return { text: block.text };
        if (block?.type === "image" && block.source?.type === "base64") {
          return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
        }
        return null;
      })
      .filter(Boolean);
  }

  function toGeminiRequest(body, geminiModel) {
    const request = {
      contents: (body.messages || []).map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: toGeminiParts(m.content)
      })),
      generationConfig: {
        maxOutputTokens: (body.max_tokens || 1500) + geminiModel.extraOutputTokens,
        thinkingConfig: geminiModel.thinkingConfig
      }
    };
    if (body.system) {
      const systemParts = toGeminiParts(body.system);
      if (systemParts.length) request.systemInstruction = { parts: systemParts };
    }
    return request;
  }

  /** Motivos por los que Gemini corta una respuesta por política, no por longitud. */
  const GEMINI_BLOCK_REASONS = ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "LANGUAGE", "OTHER"];

  /**
   * Respuesta de Gemini → forma de la Messages API. Las partes con
   * `thought: true` son razonamiento interno y nunca se devuelven como texto.
   */
  function fromGeminiResponse(json, geminiModelId) {
    if (json?.promptFeedback?.blockReason) {
      throw new Error(`Gemini bloqueó la petición (${json.promptFeedback.blockReason}).`);
    }
    const candidate = json?.candidates?.[0];
    const finishReason = candidate?.finishReason || "";
    const text = (candidate?.content?.parts || [])
      .filter(p => typeof p.text === "string" && !p.thought)
      .map(p => p.text)
      .join("");

    if (!text && GEMINI_BLOCK_REASONS.includes(finishReason)) {
      throw new Error(`Gemini no devolvió texto (motivo: ${finishReason}).`);
    }

    const usage = json?.usageMetadata || {};
    return {
      model: geminiModelId,
      content: text ? [{ type: "text", text }] : [],
      stop_reason: finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
      usage: {
        input_tokens: usage.promptTokenCount || 0,
        output_tokens: usage.candidatesTokenCount || 0
      }
    };
  }

  /**
   * Peticiones HTTP candidatas (en orden) para un proveedor y un modelo de
   * Claude. Función pura, sin red: es lo que prueban los tests.
   * `body` es un cuerpo de la Messages API SIN `model`.
   */
  function buildRequests(settings, provider, model, body) {
    const canonical = canonicalModel(model);

    if (provider === "gemini") {
      return GEMINI_MODELS[canonical].map(geminiModel => ({
        provider,
        sentModel: geminiModel.id,
        url: `${GEMINI_BASE_URL}/${geminiModel.id}:generateContent`,
        headers: { "content-type": "application/json", "x-goog-api-key": settings.geminiKey },
        body: toGeminiRequest(body, geminiModel),
        parse: json => fromGeminiResponse(json, geminiModel.id)
      }));
    }

    return [{
      provider,
      sentModel: canonical,
      url: ANTHROPIC_URL,
      headers: {
        "x-api-key": settings.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: { model: canonical, ...body },
      parse: json => json
    }];
  }

  // ─── Errores ───────────────────────────────────────────────────────────────

  /**
   * ¿El fallo de Claude es por plata o capacidad? Anthropic informa el saldo
   * agotado como 400 "Your credit balance is too low…", no como 402/429, así
   * que el status solo no alcanza: también se mira el mensaje.
   */
  function isCreditOrCapacityError(status, rawMessage) {
    const lower = String(rawMessage || "").toLowerCase();
    return status === 402 || status === 429 || status === 529 ||
      lower.includes("credit balance") || lower.includes("billing") || lower.includes("overloaded");
  }

  /**
   * Límite por minuto (429) o Anthropic saturado (529): se espera lo que
   * pide el servidor y se reintenta el MISMO pedido, hasta 2 veces. Pasa
   * seguido en "Postular": adaptar el CV manda la BASE completa (decenas de
   * miles de tokens de entrada) y el ajuste llega segundos después, dentro
   * del mismo minuto. Esperas de más de un minuto no se reintentan aquí: ahí
   * el usuario decide (botón Reintentar) o responde Gemini.
   */
  const RATE_LIMIT_RETRIES = 2;
  const RATE_LIMIT_MAX_WAIT_MS = 60000;
  const RATE_LIMIT_DEFAULT_WAIT_MS = 15000;

  /** Milisegundos a esperar según `retry-after` (segundos o fecha HTTP), o null. */
  function retryAfterMs(headers, now = Date.now()) {
    const raw = headers?.get?.("retry-after");
    if (!raw) return null;
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - now) : null;
  }

  /** Cuánto esperar antes del reintento `attempt` (0, 1…), o null si no conviene reintentar. */
  function rateLimitWait(status, headers, attempt) {
    if (status !== 429 && status !== 529) return null;
    if (attempt >= RATE_LIMIT_RETRIES) return null;
    const asked = retryAfterMs(headers);
    const wait = asked ?? RATE_LIMIT_DEFAULT_WAIT_MS * (attempt + 1);
    return wait <= RATE_LIMIT_MAX_WAIT_MS ? wait : null;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Error con `status` HTTP, bandera de saldo y un mensaje que el usuario pueda accionar. */
  function friendlyError(provider, status, rawMessage) {
    const raw = rawMessage || `Error ${status}`;
    const lower = raw.toLowerCase();
    const outOfCredit = provider === "anthropic" && isCreditOrCapacityError(status, raw);
    let message;

    if (provider === "gemini") {
      if (status === 401 || status === 403 || lower.includes("api key not valid")) {
        message = `Gemini rechazó la API Key de Vertex AI (${status}). Revísala en Google Cloud → Credenciales. Detalle: ${raw}`;
      } else if (status === 429) {
        message = `Gemini: cuota agotada (429). El modo express de Vertex AI tiene cuotas bajas; espera un momento o revisa la facturación del proyecto. Detalle: ${raw}`;
      } else {
        message = `Error Gemini (${status}): ${raw}`;
      }
    } else if (status === 401) {
      message = "Error 401: Tu API Key de Claude es inválida o no autorizada. Cópiala directamente desde console.anthropic.com.";
    } else if (status === 429 && !/credit balance|billing/.test(lower)) {
      message = `Claude: se alcanzó el límite de uso por minuto de tu cuenta (429). Espera unos segundos y pulsa Reintentar. Detalle: ${raw}`;
    } else if (status === 529 || lower.includes("overloaded")) {
      message = `Claude está saturado en este momento (${status}). Espera unos segundos y pulsa Reintentar.`;
    } else if (outOfCredit) {
      message = `Claude sin saldo o sin capacidad (${status}): ${raw}. Recarga saldo en console.anthropic.com o configura el respaldo con Gemini.`;
    } else {
      message = `Error Anthropic (${status}): ${raw}`;
    }

    const err = new Error(message);
    err.status = status;
    err.provider = provider;
    err.outOfCredit = outOfCredit;
    return err;
  }

  /**
   * Llama a UN proveedor. Solo se pasa al siguiente modelo candidato ante 404
   * (modelo inexistente) o, en Gemini, 429 (cuota de ese modelo) y 400 ajeno a
   * la key (configuración que ese modelo no acepta). Cualquier otro error
   * fallaría igual con el siguiente, y reintentar escondería la causa.
   */
  async function callProvider(settings, provider, { model, body, timeoutMs, onRetry }) {
    const candidates = buildRequests(settings, provider, model, body);
    let lastError = null;

    for (let i = 0, attempt = 0; i < candidates.length; i++) {
      const request = candidates[i];
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      console.log(`[JobFill AI] Llamando a ${describeProvider(provider)} — modelo: "${request.sentModel}" (max_tokens: ${body.max_tokens})`);

      let response;
      try {
        response = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal
        });
      } catch (err) {
        const netErr = new Error(err.name === "AbortError"
          ? `Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s) con ${describeProvider(provider)}.`
          : `Error de red al conectar con ${describeProvider(provider)}: ${err.message}`);
        netErr.provider = provider;
        throw netErr;
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok) {
        const parsed = request.parse(await response.json());
        return { ...parsed, _provider: provider, _model: request.sentModel };
      }

      // Anthropic y Google devuelven ambos `{ error: { message } }`; Google a
      // veces lo envuelve en un array de un elemento.
      const errorData = await response.json().catch(() => ({}));
      const errorObj = Array.isArray(errorData) ? errorData[0]?.error : errorData?.error;
      const rawMessage = errorObj?.message || `${response.status} ${response.statusText}`;

      // En una sola línea de texto: al copiar desde la consola, un objeto
      // suelto se pega como "[object Object]" y se pierde la causa real.
      const errorType = errorObj?.type ? ` [${errorObj.type}]` : "";
      console.error(`[JobFill AI] ${describeProvider(provider)} rechazó la petición — HTTP ${response.status}${errorType}, modelo "${request.sentModel}": ${rawMessage}`);

      lastError = friendlyError(provider, response.status, rawMessage);

      // Límite por minuto / saturación de Claude: mismo pedido, tras esperar.
      const waitMs = provider === "anthropic" && !/credit balance|billing/i.test(rawMessage)
        ? rateLimitWait(response.status, response.headers, attempt) : null;
      if (waitMs !== null) {
        attempt++;
        console.warn(`[JobFill AI] Claude pidió esperar (HTTP ${response.status}); reintento ${attempt}/${RATE_LIMIT_RETRIES} en ${Math.round(waitMs / 1000)} s.`);
        try { onRetry?.({ status: response.status, waitMs, attempt }); } catch (e) { /* solo informativo */ }
        await sleep(waitMs);
        i--; // repite este mismo candidato
        continue;
      }
      if (response.status === 429 || response.status === 529) lastError.rateLimited = true;

      const tryNextModel = response.status === 404 ||
        (provider === "gemini" && (response.status === 429 || (response.status === 400 && !/api key/i.test(rawMessage))));
      if (!tryNextModel) throw lastError;
    }

    throw lastError || new Error(`Sin respuesta de ${describeProvider(provider)}.`);
  }

  /**
   * Llama a la IA con el proveedor configurado y devuelve el JSON en formato
   * Messages API, más `_provider` / `_model` (quién respondió de verdad) y
   * `_fallbackReason` cuando respondió Gemini por un fallo de Claude.
   *
   * `thinking` solo se envía a Anthropic; Gemini se configura por modelo
   * (ver GEMINI_MODELS).
   */
  async function callAi(settings, { model, system, messages, max_tokens = 1500, thinking, timeoutMs = DEFAULT_TIMEOUT_MS, onRetry }) {
    const problem = aiSettingsProblem(settings);
    if (problem) throw new Error(problem);

    const body = { max_tokens, messages };
    if (system) body.system = system;

    if (settings.provider === "gemini") {
      return callProvider(settings, "gemini", { model, body, timeoutMs, onRetry });
    }

    try {
      return await callProvider(settings, "anthropic", {
        model,
        body: thinking ? { ...body, thinking } : body,
        timeoutMs,
        onRetry
      });
    } catch (claudeError) {
      if (!claudeError.outOfCredit || !hasGeminiFallback(settings)) throw claudeError;

      console.warn("[JobFill AI] Claude sin saldo/capacidad — reintentando con Gemini:", claudeError.message);
      try {
        const data = await callProvider(settings, "gemini", { model, body, timeoutMs });
        return { ...data, _fallbackReason: claudeError.message };
      } catch (geminiError) {
        throw new Error(`${claudeError.message} — Y el respaldo con Gemini también falló: ${geminiError.message}`);
      }
    }
  }

  root.JobFillAi = {
    MODEL_SONNET,
    MODEL_HAIKU,
    GEMINI_MODELS,
    canonicalModel,
    readAiSettings,
    aiSettingsProblem,
    hasAiCredentials,
    hasGeminiFallback,
    describeProvider,
    isCreditOrCapacityError,
    retryAfterMs,
    rateLimitWait,
    toGeminiRequest,
    fromGeminiResponse,
    buildRequests,
    callProvider,
    callAi
  };
})(typeof self !== "undefined" ? self : globalThis);
