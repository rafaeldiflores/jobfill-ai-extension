/**
 * JobFill AI - Service Worker (Manifest V3)
 * Handles background operations, Anthropic Claude API requests, and default state.
 */

// Cliente único de IA (Claude, con respaldo en Gemini vía Vertex AI),
// compartido con opciones y popup. Ruta absoluta: importScripts resuelve
// relativo al SW.
importScripts("/shared/ai-client.js");

// `targetRole` vacío por defecto: alimenta `headline`, que el autofill escribe
// en campos "Job Title"/"Titular" y que el prompt le pasa a Claude como el cargo
// del candidato. Un default de "Senior Full Stack Developer" es una declaración
// de seniority que el usuario nunca hizo.
const createDefaultProfileObj = (id = "prof_default", name = "Perfil Principal", targetRole = "") => ({
  id,
  name,
  targetRole,
  keywords: "",
  
  // Datos Personales & Contacto
  firstName: "",
  // "Segundo Nombre" (middle name) vivía por error dentro de la regla de
  // lastName en content/autofill.js: un formulario formal chileno con los 4
  // campos "Nombre / Segundo Nombre / Apellido Paterno / Apellido Materno"
  // recibía el APELLIDO en el campo de segundo nombre. Vacío a propósito, como
  // el resto: no todos tienen segundo nombre y no hay de dónde derivarlo.
  middleName: "",
  lastName: "",
  // Overrides opcionales: por defecto se derivan de `lastName` partiéndolo por
  // espacio (primera palabra = paterno, resto = materno) — igual que
  // firstName/lastName ya se derivan de fullName más abajo. Solo hacen falta
  // si esa partida simple no calza con el apellido real del usuario (compuesto,
  // con partícula, etc.).
  lastNamePaternal: "",
  lastNameMaternal: "",
  fullName: "",
  rut: "",
  email: "",
  phone: "",
  // Formato ISO (AAAA-MM-DD): es lo que un <input type="date"> nativo espera y
  // devuelve, así que options.html usa ese tipo de campo para no tener que
  // parsear formatos regionales ambiguos (¿05/03 es 5 de marzo o mayo 3?).
  // Vacío a propósito — sin dato del usuario, jamás se inventa una fecha.
  birthDate: "",
  country: "Chile",
  // Vacía: una ciudad por defecto la escribe el autofill como si fuera tuya.
  city: "",
  address: "",
  postalCode: "",
  
  // Redes y Enlaces
  linkedinUrl: "",
  githubUrl: "",
  portfolioUrl: "",
  twitterUrl: "",
  websiteUrl: "",

  // Experiencia y Titular
  headline: targetRole,
  currentCompany: "",
  currentTitle: "",
  // NADA de datos inventados por defecto. Todo lo que quede aquí se envía a
  // reclutadores reales como si fuera cierto: el motor de autofill lo escribe en
  // los formularios y el prompt le dice a Claude que la Base de Datos es la
  // verdad del candidato. Un default "plausible" (3 años de experiencia, un
  // título, una licencia) no se nota y se convierte en una mentira firmada por
  // el usuario; un default vacío se nota de inmediato y se corrige.
  yearsOfExperience: "",
  noticePeriod: "",
  salaryExpectation: "",
  currency: "CLP",
  // Debe coincidir literalmente con un <option value="..."> de #englishLevel en
  // options.html (mismo bug que aiTone: "Intermedio (B2)" no calzaba con
  // "Intermedio (B1/B2)" y el select quedaba sin selección real).
  englishLevel: "",
  summary: "",

  // Educación y Skills
  degree: "",
  university: "",
  // Promedio / GPA: formularios tipo Workday ("Overall Result (GPA)") lo
  // piden como campo aparte. Vacío por defecto — se escribe tal cual, sin
  // convertir entre escalas (1-7 chilena, 0-4 GPA, 0-10): traducirlo por
  // nuestra cuenta produciría una nota que el candidato nunca declaró.
  gpa: "",
  skills: "",
  resumeText: "",

  // Legal / EEO — vacíos a propósito: son declaraciones con consecuencias
  // legales en una postulación. Con un default, la extensión respondía
  // automáticamente preguntas de autorización de trabajo y patrocinio de visa
  // que el usuario nunca configuró.
  legallyAuthorized: "",
  requiresSponsorship: "",
  willingToRelocate: "",
  workPreference: "",
  gender: "",

  // Base de Datos Estructurada de CV
  // Vacía a propósito: cualquier experiencia/proyecto/título precargado aquí
  // termina citado como real en respuestas enviadas a reclutadores.
  cvDatabase: {
    rawText: "",
    parsedAt: null,
    experiences: [],
    projects: [],
    education: []
  },

  customQA: [],

  // Vacío: el motor de autofill escribe estos valores directamente en los
  // formularios. Un default de "Licencia de Conducir: Clase B al día" o una
  // pretensión de renta se envía tal cual sin que el usuario lo haya escrito.
  customFields: []
});

/**
 * Enrutado de modelo por complejidad de la pregunta. No es configurable a
 * propósito: la elección correcta la determina el TIPO de pregunta, no una
 * preferencia. Una pregunta de disponibilidad es una consulta de datos del
 * perfil y Haiku la resuelve igual por una fracción del coste; una de
 * experiencia decide si te llaman a entrevista y ahí ahorrar sale caro.
 */
const MODEL_COMPLEX = "claude-sonnet-5";
const MODEL_SIMPLE = "claude-haiku-4-5";

/**
 * Rediseño de datos: reemplaza `profiles[]` (identidad completa duplicada por
 * perfil — ~35 campos repetidos, más un "espejo" que copiaba el perfil activo
 * a la raíz de storage) por una BASE ÚNICA del candidato más varios ÍNDICES
 * livianos que solo distinguen la FACETA con la que se postula.
 *
 * `candidateBase`: identidad, contacto, legal, CV completo (experiencias,
 * proyectos, educación, Q&A, campos personalizados) — UNA sola vez. Reutiliza
 * `createDefaultProfileObj` como plantilla de campos para no duplicar esa
 * lista (y sus comentarios) en dos sitios.
 *
 * `cvIndexes`: solo `id`, `area` (nombre de la faceta), `keywords` (para
 * elegir cuál calza con una oferta) y `targetRole` (título/headline propio de
 * esa faceta, si se quiere distinto del genérico). NO copian experiencias ni
 * proyectos — el catálogo es compartido y se rankea por relevancia a la
 * oferta (`rankForJob`/`relevanceToJob`, ya existentes) sin importar qué
 * índice esté activo. Antes, agregar un cargo nuevo obligaba a repetirlo en
 * cada perfil o quedaba invisible para los demás.
 */
function createDefaultCandidateBase() {
  const { id, name, targetRole, keywords, ...sharedFields } = createDefaultProfileObj();
  return sharedFields;
}

function createDefaultCvIndex(id = "idx_default", area = "Perfil Principal", targetRole = "") {
  return { id, area, keywords: "", targetRole };
}

/** Campos que le pertenecen al ÍNDICE, no al candidato — el resto es compartido. */
const CV_INDEX_OWN_FIELDS = ["id", "name", "targetRole", "keywords"];

/**
 * Proyecta `candidateBase` (+ el `targetRole` del índice activo, como
 * override de `headline`) a la raíz del objeto de storage — es la forma
 * "aplanada" que espera `content/autofill.js` (lee `profile.rut`,
 * `profile.email`, etc. directo de la raíz; nunca entra a objetos anidados).
 * Reemplaza al viejo "espejo" que copiaba el perfil activo a la raíz en cada
 * guardado desde options.js/popup.js — ahora se calcula una sola vez, al leer.
 */
function buildAutofillProfileView(storage) {
  const candidateBase = storage.candidateBase || {};
  const cvIndexes = storage.cvIndexes || [];
  const activeIndex = cvIndexes.find(i => i.id === storage.activeCvIndexId) || cvIndexes[0];

  // Las credenciales de IA y el respaldo del esquema viejo NO viajan al
  // content script: este objeto llega a cada página donde corre el autofill,
  // y el content script jamás llama a la API (lo hace este service worker).
  const {
    // vertexProjectId/vertexRegion: restos de una versión previa, por si
    // quedaron en storage.
    claudeApiKey, vertexApiKey, vertexProjectId, vertexRegion,
    profiles_backup_v1, ...safeStorage
  } = storage;

  return {
    ...safeStorage,
    ...candidateBase,
    headline: activeIndex?.targetRole || candidateBase.headline || candidateBase.currentTitle || ""
  };
}

/**
 * Convierte el `profiles[]` viejo (identidad completa duplicada por perfil) al
 * nuevo esquema. No destructiva: el llamador conserva `profiles[]` intacto
 * como `profiles_backup_v1` hasta confirmar que todo funciona.
 *
 * `candidateBase` toma los campos compartidos del perfil MÁS COMPLETO (más
 * campos de texto no vacíos; desempate por el perfil activo) — no se hace un
 * merge campo a campo entre perfiles, porque eso mezclaría datos del mismo
 * candidato pero de momentos distintos en que llenó cada uno (el email de un
 * perfil con el teléfono desactualizado de otro).
 *
 * `experiences`/`projects`/`education` sí se UNEN entre todos los perfiles,
 * deduplicando por contenido — es exactamente lo que hoy se pierde: un cargo
 * cargado solo en el perfil "Backend" no existía para el perfil "Frontend".
 */
function migrateProfilesToCandidateSchema(profilesList, activeProfileId) {
  const list = Array.isArray(profilesList) && profilesList.length ? profilesList : [createDefaultProfileObj()];

  const completeness = p => Object.values(p).filter(v => typeof v === "string" && v.trim()).length;
  const richest = [...list].sort((a, b) => {
    if (a.id === activeProfileId) return -1;
    if (b.id === activeProfileId) return 1;
    return completeness(b) - completeness(a);
  })[0];

  const dedupeByKey = (items, keyFn, prefix) => {
    const seen = new Map();
    let counter = 1;
    for (const item of items) {
      const key = keyFn(item);
      if (!key || seen.has(key)) continue;
      seen.set(key, { ...item, id: item.id || `${prefix}_${counter++}` });
    }
    return [...seen.values()];
  };

  const dedupeByText = (items, keyFn) => {
    const seen = new Set();
    return items.filter(item => {
      const key = keyFn(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const { id, name, targetRole, keywords, cvDatabase, customQA, customFields, ...sharedIdentity } = richest;
  const candidateBase = {
    ...createDefaultCandidateBase(),
    ...sharedIdentity,
    cvDatabase: {
      rawText: richest.cvDatabase?.rawText || richest.resumeText || "",
      parsedAt: richest.cvDatabase?.parsedAt || null,
      experiences: dedupeByKey(
        list.flatMap(p => p.cvDatabase?.experiences || []),
        e => `${(e.company || "").toLowerCase()}|${(e.role || "").toLowerCase()}|${(e.period || "").toLowerCase()}`,
        "exp"
      ),
      projects: dedupeByKey(
        list.flatMap(p => p.cvDatabase?.projects || []),
        pr => `${(pr.name || "").toLowerCase()}|${(pr.technologies || "").toLowerCase()}`,
        "proj"
      ),
      education: dedupeByKey(
        list.flatMap(p => p.cvDatabase?.education || []),
        ed => `${(ed.degree || "").toLowerCase()}|${(ed.institution || "").toLowerCase()}`,
        "edu"
      )
    },
    customQA: dedupeByText(
      list.flatMap(p => p.customQA || []),
      qa => (qa.question || qa.keywords || "").toLowerCase().trim()
    ),
    customFields: dedupeByText(
      list.flatMap(p => p.customFields || []),
      cf => `${(cf.label || "").toLowerCase()}|${(cf.value || "").toLowerCase()}`
    )
  };

  const cvIndexes = list.map(p => ({
    id: p.id,
    area: p.name || p.targetRole || "Perfil",
    keywords: p.keywords || "",
    targetRole: p.targetRole || p.headline || ""
  }));

  const activeCvIndexId = list.some(p => p.id === activeProfileId) ? activeProfileId : list[0].id;

  return { candidateBase, cvIndexes, activeCvIndexId };
}

const DEFAULT_GLOBAL_SETTINGS = {
  schemaVersion: 2,
  candidateBase: createDefaultCandidateBase(),
  cvIndexes: [ createDefaultCvIndex() ],
  activeCvIndexId: "idx_default",
  // Proveedor principal: "anthropic" (Claude, API key sk-ant-…) o "gemini"
  // (Vertex AI modo express, API key de Google Cloud). Con Claude como
  // principal y una key de Gemini cargada, Gemini responde automáticamente
  // cuando Claude se queda sin saldo (ver shared/ai-client.js).
  aiProvider: "anthropic",
  claudeApiKey: "",
  vertexApiKey: "",
  aiFallbackToGemini: true,
  // Debe coincidir literalmente con un <option value="..."> de #aiTone en
  // options.html — "professional" (inglés) no calzaba con ninguno, así que el
  // select quedaba sin selección real y el prompt de sistema mezclaba idiomas
  // ("tono professional, asertivo y seguro").
  aiTone: "profesional y persuasivo",
  customAiInstructions: "Responde de forma clara, natural y concisa en primera persona, adaptándote exactamente al idioma de la pregunta. Resalta la experiencia técnica y capacidad de resolución de problemas."
};

/**
 * Migra lo que haya en storage al esquema candidateBase+cvIndexes si todavía
 * no está migrado. Extraída de `onInstalled` para poder invocarla también a
 * demanda (`ENSURE_SCHEMA_MIGRATED`, más abajo) — options.js la dispara antes
 * de leer, por si el usuario acaba de IMPORTAR un respaldo JSON viejo:
 * `chrome.storage.local.set()` no reactiva `onInstalled` (ese evento es solo
 * de instalación/actualización de la extensión), así que sin este segundo
 * disparador un respaldo pre-rediseño quedaría en el esquema viejo para
 * siempre tras importarlo.
 */
async function ensureSchemaMigrated() {
  const existing = await chrome.storage.local.get(null);
  if (existing.schemaVersion === 2) return;

  const initial = { ...DEFAULT_GLOBAL_SETTINGS, ...existing };

  // Compatibilidad con el formato viejo de perfil único aplanado en la raíz
  // (previo incluso a `profiles[]`): si no hay `profiles[]` pero sí hay datos
  // sueltos en la raíz, se arman como UN perfil antes de migrar — mismo
  // comportamiento que tenía esta función antes del rediseño.
  const profilesList = Array.isArray(existing.profiles) && existing.profiles.length
    ? existing.profiles
    : [(() => {
        const flat = createDefaultProfileObj(
          "prof_default",
          existing.headline || "Perfil Principal",
          existing.headline || ""
        );
        Object.keys(flat).forEach(k => {
          if (existing[k] !== undefined && existing[k] !== null) flat[k] = existing[k];
        });
        return flat;
      })()];

  const migrated = migrateProfilesToCandidateSchema(profilesList, existing.activeProfileId);
  initial.candidateBase = migrated.candidateBase;
  initial.cvIndexes = migrated.cvIndexes;
  initial.activeCvIndexId = migrated.activeCvIndexId;
  initial.schemaVersion = 2;

  // No destructivo: se conserva profiles[] tal cual bajo otra clave hasta
  // confirmar que todo funciona — permite revertir sin perder datos.
  if (Array.isArray(existing.profiles) && existing.profiles.length) {
    initial.profiles_backup_v1 = existing.profiles;
  }

  // Claves del esquema viejo que hay que ELIMINAR de verdad, no solo omitir
  // del objeto que se escribe: `chrome.storage.local.set()` FUSIONA (solo
  // toca las claves que recibe), así que un `delete` sobre el payload deja la
  // clave viva en storage. Sin este `remove`, justo después de migrar
  // quedarían TRES copias del CV —`profiles`, `profiles_backup_v1` y
  // `candidateBase`— es decir, más duplicación que antes del rediseño, que es
  // exactamente lo que este cambio venía a eliminar.
  //
  // Los campos sueltos de la raíz son los del viejo "espejo" del perfil
  // activo; se derivan de la propia plantilla del candidato para no mantener
  // una lista a mano que se desincronice al agregar un campo nuevo. Los
  // ajustes globales (API key, tono, instrucciones) NO están en esa
  // plantilla, así que no se tocan.
  const staleRootKeys = [
    "profiles", "activeProfileId", "cvProfiles", "activeCvProfileId",
    ...Object.keys(createDefaultCandidateBase())
  ];
  staleRootKeys.forEach(k => { delete initial[k]; });

  await chrome.storage.local.set(initial);
  await chrome.storage.local.remove(staleRootKeys);
  console.log("JobFill AI inicializado con esquema candidateBase + cvIndexes (v2).");
}

chrome.runtime.onInstalled.addListener(ensureSchemaMigrated);

/**
 * Nunca dejar que un rechazo llegue al content script sin texto: si `error` no es
 * un Error real, `error.message` es undefined y la UI muestra un mensaje genérico
 * que oculta la causa.
 */
function describeError(error) {
  if (!error) return "Error desconocido en el service worker.";
  return error.message || String(error);
}

/**
 * MV3 keep-alive.
 * Chrome suspende el service worker tras ~30s de inactividad y un fetch en vuelo
 * no reinicia ese temporizador de forma fiable. Si el worker muere durante la
 * llamada a Anthropic, sendResponse nunca se ejecuta y el content script recibe
 * `undefined`. Un ping periódico a una API de chrome mantiene vivo el worker
 * mientras haya alguna petición larga en curso.
 */
let keepAliveTimer = null;
let keepAliveHolders = 0;

function startKeepAlive() {
  keepAliveHolders++;
  if (keepAliveTimer !== null) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  keepAliveHolders = Math.max(0, keepAliveHolders - 1);
  if (keepAliveHolders === 0 && keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function withKeepAlive(operation) {
  startKeepAlive();
  try {
    return await operation();
  } finally {
    stopKeepAlive();
  }
}

// Communication bridge
//
// SAVE_PROFILE / TEST_CLAUDE_API / PARSE_CV_TO_DATABASE fueron eliminados: nada
// en content/, popup/ u options/ los envía — options.js prueba la conexión y
// parsea el CV con sus propios fetch() directos a Anthropic. Mantener ambas
// implementaciones en paralelo fue justo lo que dejó desincronizados los IDs
// de modelo entre archivos; ASK_CLAUDE_AI (el único camino real) es la única
// llamada a Anthropic que vive en este service worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ASK_CLAUDE_AI") {
    withKeepAlive(() => handleClaudeGeneration(message.payload))
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: describeError(error) }));
    return true;
  }

  if (message.type === "ASK_CLAUDE_AI_BATCH") {
    withKeepAlive(() => handleClaudeGenerationBatch(message.payload))
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: describeError(error) }));
    return true;
  }

  if (message.type === "PREVIEW_UNBACKED_TERMS") {
    // Computación local (sin llamar a Anthropic): no necesita keepAlive por
    // tiempo largo ni gastar tokens, es solo para preguntar antes de redactar.
    handlePreviewUnbackedTerms(message.payload || {})
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: describeError(error) }));
    return true;
  }

  if (message.type === "ENSURE_SCHEMA_MIGRATED") {
    ensureSchemaMigrated()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_PROFILE") {
    // content/autofill.js lee cada campo del candidato como `profile.X` en la
    // RAÍZ del objeto (así funcionaba con el viejo "espejo" del perfil activo,
    // y sigue así para no tener que tocar ese archivo) — se proyecta
    // `candidateBase` a la raíz para que sea compatible sin cambios.
    chrome.storage.local.get(null).then(storage => {
      sendResponse({ success: true, profile: buildAutofillProfileView(storage) });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === "CAPTURE_JOB_TITLE_NEAR_MOUSE") {
    // Respaldo del botón manual: solo se usa cuando el DOM no dio ningún cargo
    // legible. captureVisibleTab exige el tabId/windowId del remitente, no del
    // mensaje — un content script no puede llamarlo directo.
    withKeepAlive(() => captureJobTitleNearMouse(sender.tab, message.payload))
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ success: false, error: describeError(error) }));
    return true;
  }
});

// El atajo de teclado (chrome://extensions/shortcuts) dispara la MISMA
// captura manual que el botón del widget flotante — es solo una segunda forma
// de invocarla, así que se reenvía como un mensaje idéntico al que dispararía
// el propio botón, en vez de duplicar la lógica de captura aquí.
/**
 * Interruptor global (popup / widget): `extensionEnabled === false` apaga la
 * extensión en todas las pestañas. El content script reacciona solo al cambio
 * de storage; aquí solo se refleja en el ícono, para que se note sin abrir
 * el popup que está apagada.
 */
function renderActionBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
  chrome.action.setTitle({ title: enabled ? "JobFill AI" : "JobFill AI (desactivada)" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.extensionEnabled) {
    renderActionBadge(changes.extensionEnabled.newValue !== false);
  }
});

// El badge no persiste entre reinicios del navegador: se recalcula cada vez
// que el service worker arranca.
chrome.storage.local.get("extensionEnabled").then(s => renderActionBadge(s.extensionEnabled !== false));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "capture-job-context" || !tab?.id) return;
  const { extensionEnabled } = await chrome.storage.local.get("extensionEnabled");
  if (extensionEnabled === false) return;
  chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_JOB_CONTEXT_HOTKEY" }).catch(err => {
    // Pasa si la pestaña activa no tiene el content script inyectable (una
    // página chrome://, o el content script aún no cargó) — no es un error
    // que el usuario necesite ver, el atajo simplemente no aplica ahí.
    console.warn("[JobFill AI] Atajo de captura: no se pudo avisar a la pestaña activa:", err);
  });
});

/**
 * Recorta la captura de la pestaña visible alrededor del cursor y le pide a
 * Claude (visión) que lea SOLO el cargo/título del puesto en esa región.
 *
 * Respaldo de último recurso: se usa cuando la extracción por DOM no encontró
 * ningún título legible. `dpr` viene del content script porque
 * `captureVisibleTab` produce la imagen en píxeles de DISPOSITIVO, mientras
 * que las coordenadas del mouse que reporta el navegador están en píxeles CSS
 * — sin ese factor, el recorte queda descentrado en cualquier pantalla con
 * escalado (el mismo desfase de coordenadas que costó tiempo diagnosticar en
 * la sesión de depuración de Laborum).
 */
async function captureJobTitleNearMouse(tab, { x, y, dpr }) {
  if (!tab?.windowId) throw new Error("No se pudo identificar la pestaña activa.");

  const ai = JobFillAi.readAiSettings(await chrome.storage.local.get(null));
  if (!JobFillAi.hasAiCredentials(ai)) {
    throw new Error("Configura tu API Key de Claude o de Gemini para usar la captura por pantalla.");
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const fullBlob = await (await fetch(dataUrl)).blob();
  const fullBitmap = await createImageBitmap(fullBlob);

  const { cropX, cropY, cropW, cropH } = computeCropRect(fullBitmap.width, fullBitmap.height, x, y, dpr);

  const cropBitmap = await createImageBitmap(fullBitmap, cropX, cropY, cropW, cropH);
  const canvas = new OffscreenCanvas(cropW, cropH);
  canvas.getContext("2d").drawImage(cropBitmap, 0, 0);
  const cropBlob = await canvas.convertToBlob({ type: "image/png" });
  const base64 = arrayBufferToBase64(await cropBlob.arrayBuffer());

  const data = await callAnthropicMessagesApi({
    ai,
    model: MODEL_SIMPLE,
    max_tokens: 60,
    system: "Lees fragmentos de pantalla de portales de empleo para extraer el título del cargo/puesto de trabajo. Respondes ÚNICAMENTE con el título tal como aparece en la imagen, sin comillas ni explicación. Si no hay ningún título de cargo visible en la imagen, respondes exactamente: NONE.",
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        { type: "text", text: "¿Qué título de cargo/puesto de trabajo aparece en esta imagen?" }
      ]
    }]
  });

  const title = extractTextFromResponse(data).trim();
  if (!title || title.toUpperCase() === "NONE") {
    return { success: false, error: "No se detectó ningún cargo en esa zona de la pantalla." };
  }
  return { success: true, title };
}

/**
 * Rectángulo de recorte de 1000×1000 px CSS centrado en el cursor, convertido
 * a píxeles de DISPOSITIVO y sujeto a los bordes reales de la imagen.
 *
 * `captureVisibleTab` produce la imagen en píxeles de dispositivo, pero las
 * coordenadas del mouse que reporta el navegador vienen en píxeles CSS — sin
 * multiplicar por `dpr`, el recorte queda descentrado en cualquier pantalla
 * con escalado (el mismo desfase de coordenadas que costó tiempo diagnosticar
 * en la sesión de depuración de Laborum). Función pura y testeable a propósito:
 * es la parte de esta captura con más aritmética y más fácil de desalinear sin
 * que se note hasta que alguien mira el recorte y no ve nada útil.
 */
function computeCropRect(imgWidth, imgHeight, x, y, dpr) {
  const scale = dpr && dpr > 0 ? dpr : 1;
  const cropSize = 1000; // en CSS px, tal como se pidió.
  const cropW = Math.min(Math.round(cropSize * scale), imgWidth);
  const cropH = Math.min(Math.round(cropSize * scale), imgHeight);
  // Centrado en el cursor, pero sujeto a los bordes de la imagen — un recorte
  // que se saliera del canvas real produciría una imagen vacía o distorsionada.
  const cropX = Math.max(0, Math.min(Math.round(x * scale - cropW / 2), imgWidth - cropW));
  const cropY = Math.max(0, Math.min(Math.round(y * scale - cropH / 2), imgHeight - cropH));
  return { cropX, cropY, cropW, cropH };
}

/**
 * `btoa` no acepta un ArrayBuffer y `String.fromCharCode(...bytes)` revienta
 * la pila con imágenes de varios cientos de KB (el límite de argumentos de una
 * llamada a función) — se recorre en bloques.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Llama a la IA con el proveedor configurado: Claude, con respaldo automático
 * en Gemini si Claude se queda sin saldo. La implementación vive en
 * shared/ai-client.js, compartida con options.js; la respuesta siempre llega
 * en formato Messages API, responda quien responda.
 *
 * `thinking: disabled` siempre: Sonnet 5 activa "adaptive thinking" por
 * defecto si se omite, y los tokens de razonamiento se descuentan de
 * max_tokens — con presupuestos pequeños se agotan antes de emitir texto y la
 * respuesta llega vacía. Aquí siempre queremos texto directo y acotado.
 */
async function callAnthropicMessagesApi({ ai, model, system, messages, max_tokens = 1500 }) {
  return JobFillAi.callAi(ai, {
    model,
    system,
    messages,
    max_tokens,
    thinking: { type: "disabled" }
  });
}

/** Quién respondió, para avisarle al usuario cuando no fue Claude. */
function providerInfo(data) {
  return { provider: data?._provider || "anthropic", fallbackReason: data?._fallbackReason || null };
}

/**
 * Extrae el texto de una respuesta de la Messages API.
 *
 * NUNCA asumir que content[0] es el bloque de texto: los modelos actuales pueden
 * devolver bloques de `thinking` antes del texto, y en ese caso content[0].text
 * es undefined. Hay que concatenar todos los bloques de tipo "text".
 */
function extractTextFromResponse(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];

  const u = data?.usage || {};
  console.log("[JobFill AI] Respuesta de Anthropic:", {
    stop_reason: data?.stop_reason,
    bloques: blocks.map(b => b?.type),
    tokens_input_frescos: u.input_tokens ?? 0,
    tokens_leidos_de_cache: u.cache_read_input_tokens ?? 0,
    tokens_escritos_a_cache: u.cache_creation_input_tokens ?? 0,
    tokens_output: u.output_tokens ?? 0
  });

  const text = blocks
    .filter(b => b?.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("")
    .trim();

  if (!text && data?.stop_reason === "max_tokens") {
    throw new Error("Claude agotó el límite de tokens antes de escribir la respuesta. Aumenta max_tokens.");
  }

  return text;
}

function detectQuestionLanguage(text) {
  if (!text) return "es";
  const norm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Señal fuerte pero NO decisiva por sí sola: acumula puntos en vez de forzar
  // "es" de forma incondicional. Antes, un solo "ñ" o "¿" colado desde texto
  // ajeno a la pregunta (p. ej. el título del puesto en español, o una nota de
  // "(obligatorio)" que se escapó de la limpieza) volteaba TODA la detección a
  // español aunque la pregunta real fuera 100% en inglés.
  const spanishCharMatches = (text.match(/[¿¡ñÑ]/g) || []).length;

  const spanishTokens = [
    "por que", "cual", "cuales", "como", "cuanto", "cuantos", "donde", "cuando",
    "experiencia", "describa", "describir", "describe", "cuentanos", "sobre ti",
    "puesto", "cargo", "empresa", "trabajo", "trabajar", "motivo", "motivacion",
    "logro", "desafio", "reto", "tecnologias", "habilidades", "disponibilidad",
    "renta", "sueldo", "salario", "pretension", "postulacion", "postular", "anos",
    "usted", "para ti", "con nosotros", "en nuestro", "tu perfil"
  ];

  const englishTokens = [
    "why", "what", "how", "when", "where", "who", "which",
    "experience", "describe", "tell us", "about you", "yourself",
    "position", "role", "company", "work", "job", "motivation",
    "achievement", "challenge", "technologies", "skills", "availability",
    "salary", "compensation", "expectation", "apply", "application", "years",
    "with us", "at our", "your background", "please"
  ];

  let esScore = spanishCharMatches * 3;
  let enScore = 0;

  for (const token of spanishTokens) {
    if (norm.includes(token)) esScore += 2;
  }

  for (const token of englishTokens) {
    if (norm.includes(token)) enScore += 2;
  }

  const words = norm.split(/\s+/);
  // Palabras de una sola letra ("a", "o", "y") fuera de las listas: "a" es a la
  // vez artículo español y artículo indefinido inglés larguísimamente frecuente,
  // así que sumaba puntos de español a prácticamente cualquier frase en inglés.
  const esCommon = ["de", "la", "el", "en", "que", "los", "del", "se", "las", "por", "un", "para", "con", "una", "su", "al", "lo", "como", "mas", "pero", "sus", "le", "ya", "tu", "te", "mi", "ti"];
  const enCommon = ["the", "be", "to", "of", "and", "in", "that", "have", "it", "for", "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their", "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me"];

  for (const w of words) {
    if (esCommon.includes(w)) esScore += 1;
    if (enCommon.includes(w)) enScore += 1;
  }

  return esScore >= enScore ? "es" : "en";
}

/**
 * Vocabulario para detectar requisitos de la oferta que el perfil NO respalda.
 *
 * Solo se usa para ESA detección: la cobertura de lo que el candidato sí tiene
 * se calcula sin vocabulario, cruzando sus propios términos con la oferta, así
 * que esta lista no limita lo que se puede reconocer del candidato — solo lo que
 * se le sabe preguntar cuando la oferta pide algo que su perfil no menciona.
 */
const REQUIREMENT_VOCABULARY = [
  "JavaScript", "TypeScript", "Python", "React", "React Native", "Node.js", "Vue", "Vue.js",
  "Angular", "Next.js", "Nuxt", "Svelte", "Express", "NestJS", "Ionic", "Capacitor",
  "Java", "Spring Boot", "Spring", "C#", ".NET", "ASP.NET", "PHP", "Laravel", "Symfony",
  "Go", "Golang", "Rust", "C++", "Swift", "Kotlin", "Dart", "Flutter", "Ruby", "Rails",
  "SQL", "PostgreSQL", "MySQL", "MariaDB", "MongoDB", "Redis", "DynamoDB", "Elasticsearch",
  "SQLite", "Oracle", "SQL Server", "BigQuery", "Firestore", "Firebase", "Supabase",
  "Docker", "Kubernetes", "AWS", "Azure", "GCP", "Google Cloud", "Cloudflare", "Terraform",
  "Ansible", "Jenkins", "GitHub Actions", "GitLab CI", "Vercel", "Netlify",
  "Git", "GraphQL", "REST", "gRPC", "WebSocket", "Webhooks",
  "Tailwind", "Bootstrap", "Material UI", "HTML", "CSS", "SASS", "SCSS",
  "Linux", "Nginx", "Apache", "FastAPI", "Django", "Flask", "Celery",
  "CI/CD", "DevOps", "SRE", "Jest", "Cypress", "Selenium", "Playwright",
  "Microservicios", "Microservices", "Serverless", "Lambda",
  "Agile", "Scrum", "Kanban", "Jira", "Confluence", "Figma", "Notion",
  "TDD", "BDD", "Clean Architecture", "SOLID",
  "Machine Learning", "Deep Learning", "TensorFlow", "PyTorch", "Pandas", "NumPy",
  "Power BI", "Tableau", "Looker", "Looker Studio", "Airflow", "Spark", "Hadoop", "ETL",
  "Webpack", "Vite", "ESLint", "OAuth", "JWT", "Auth0", "Stripe", "Mercado Pago",
  "RPA", "n8n", "Zapier", "Make", "LangChain", "RAG", "OpenAI", "Claude", "Gemini"
];

/**
 * ¿Aparece `term` como término independiente dentro de `text`?
 *
 * No sirve \b: los términos técnicos reales llevan símbolos que \b no delimita
 * ("C++", ".NET", "Node.js"), y con \b un "C" haría match dentro de "C#". Se
 * delimita por separadores explícitos.
 */
function termAppearsIn(term, text) {
  if (!term || !text) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(?:^|[\\s,;:.()/\\[\\]"'-])${escaped}(?=[\\s,;:.()/\\[\\]"'-]|$)`, "i").test(text);
  } catch (e) {
    return false;
  }
}

/** Cuántos términos propios de un cargo/proyecto menciona la oferta. */
function relevanceToJob(jobText, ...fields) {
  const text = fields.filter(Boolean).join(" ");
  if (!text || !jobText) return 0;
  // Misma señal que usa la verificación de cobertura, así que el material que se
  // selecciona aquí es exactamente el que después se mide como cubierto.
  const terms = text.split(/[,;|\n]/).map(t => t.trim()).filter(t => t.length >= 2 && t.length <= 40);
  return terms.filter(term => termAppearsIn(term, jobText)).length;
}

/**
 * Ordena por relevancia para la oferta conservando el orden original como
 * desempate: el CV viene en orden cronológico inverso, así que entre dos cargos
 * igual de relevantes gana el más reciente.
 */
function rankForJob(items, scorer) {
  return items
    .map((item, index) => ({ item, index, score: scorer(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * Puntúa cuánto encaja un ÍNDICE de CV con una oferta.
 *
 * Antes esto también sumaba puntos por tecnologías coincidentes en el CV de
 * cada perfil — pero ese CV era una copia PROPIA de cada perfil, y ahora es un
 * catálogo COMPARTIDO entre todos los índices (ver el rediseño de datos): esa
 * señal daría el mismo puntaje a todos, así que ya no distingue nada. La única
 * señal real que queda es `keywords`, la declaración explícita del usuario
 * sobre para qué sirve esa faceta ("backend, python"). Reutiliza
 * `termAppearsIn` (límite de palabra real, no `includes()` crudo).
 */
function scoreCvIndexForJob(index, jobText) {
  if (!index.keywords) return 0;
  const kwList = index.keywords.split(",").map(k => k.trim()).filter(Boolean);
  return kwList.filter(k => termAppearsIn(k, jobText)).length * 30;
}

/**
 * Elige qué índice de CV usar para redactar, en vez del `Array.find` de antes
 * que comparaba `keywords` solo contra título+empresa (ni siquiera la
 * descripción) y se quedaba con el PRIMERO que matcheaba sin comparar contra
 * los demás.
 *
 * Puntúa TODOS los índices contra título+descripción completa y se queda con
 * el mejor. Si el segundo puesto queda muy cerca del primero (dentro de un 20%
 * relativo) y ambos tienen señal real, se marca `uncertain: true` — mismo
 * criterio de "sin pruebas suficientes, no adivines" que ya se usa para la
 * oferta cacheada ambigua en `content/autofill.js`.
 */
function selectBestCvIndex(cvIndexes, jobTitle, jobDescription, activeCvIndexId) {
  if (!cvIndexes || !cvIndexes.length) {
    return { index: null, uncertain: false, candidates: [] };
  }

  const fallback = () => cvIndexes.find(i => i.id === activeCvIndexId) || cvIndexes[0];
  const jobText = `${jobTitle || ""} ${jobDescription || ""}`.trim();
  if (!jobText) {
    return { index: fallback(), uncertain: false, candidates: [] };
  }

  const ranked = cvIndexes
    .map(index => ({ index, score: scoreCvIndexForJob(index, jobText) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best.score === 0) {
    // Ningún índice dio señal real: adivinar entre ellos sería peor que caer
    // al que el usuario ya dejó marcado como activo.
    return { index: fallback(), uncertain: false, candidates: ranked };
  }

  const second = ranked[1];
  const uncertain = Boolean(second) && second.score > 0 && (best.score - second.score) < best.score * 0.2;
  return { index: best.index, uncertain, candidates: ranked };
}

/** Cuántos cargos y proyectos se envían con todo el detalle. */
const MAX_DETAILED_EXPERIENCES = 4;
const MAX_DETAILED_PROJECTS = 3;

/**
 * Cruza la oferta, el perfil y la respuesta generada para detectar dos huecos
 * que hacen perder match en un filtro automático:
 *
 *  - `omitted`: la oferta lo pide, el candidato SÍ lo tiene en su perfil, y la
 *    respuesta no lo mencionó. Es el fallo más caro y el más fácil de arreglar:
 *    se pierde el match por omisión, no por falta de experiencia.
 *  - `unbacked`: la oferta lo pide y el perfil no lo menciona. NO se afirma nada
 *    aquí — se le pregunta al usuario, que es quien sabe si lo domina. El perfil
 *    guardado es un proxy incompleto de su experiencia real.
 */
function analyzeRequirementCoverage({ profileTerms, jobDescription, answer }) {
  if (!jobDescription) return { omitted: [], unbacked: [] };

  const omitted = profileTerms.filter(
    term => termAppearsIn(term, jobDescription) && !termAppearsIn(term, answer)
  );

  const unbacked = REQUIREMENT_VOCABULARY.filter(
    term => termAppearsIn(term, jobDescription) && !profileTerms.some(pt => pt.toLowerCase() === term.toLowerCase())
  );

  // Tope defensivo: una oferta larga puede citar decenas de tecnologías, y una
  // lista interminable deja de ser accionable para el usuario.
  return { omitted: omitted.slice(0, 8), unbacked: unbacked.slice(0, 10) };
}

/**
 * Términos que el candidato declara como propios, reunidos de toda la base
 * (habilidades, tecnologías por cargo, por proyecto y campos libres). Son la
 * base para medir cobertura sin depender de ningún vocabulario fijo.
 *
 * Toma un solo `candidateBase` — antes recibía perfil + su CV + el storage
 * completo por separado porque cada perfil duplicaba su propio CV; ahora hay
 * un único catálogo compartido, así que un solo objeto alcanza.
 */
function collectProfileTerms(candidateBase) {
  const cvDb = candidateBase.cvDatabase || {};
  const sources = [
    candidateBase.skills,
    ...(cvDb.experiences || []).map(e => e.technologies),
    ...(cvDb.projects || []).map(pr => pr.technologies),
    ...(candidateBase.customFields || []).map(cf => cf.value)
  ];

  const terms = new Set();
  for (const source of sources) {
    if (typeof source !== "string") continue;
    for (const raw of source.split(/[,;|\n]/)) {
      const term = raw.trim();
      // Un término de 1 carácter ("C", "R") produce ruido, y uno larguísimo es
      // una frase, no una tecnología comparable contra la oferta.
      if (term.length >= 2 && term.length <= 40) terms.add(term);
    }
  }
  return [...terms];
}

/**
 * Versión "unbacked" adelantada: qué pide la oferta que el perfil guardado no
 * respalda. Es una computación local (sin llamar a Claude) para poder
 * preguntarle al usuario "¿dominas esto?" ANTES de gastar una llamada
 * redactando una respuesta — preguntar recién después de escribir el texto es
 * ilógico: para entonces ya se generó contenido sobre información sin
 * confirmar. `omitted` (lo que el perfil sí respalda pero la respuesta no
 * mencionó) sigue calculándose después, porque depende del texto ya escrito.
 *
 * Ya no necesita elegir un índice: el catálogo del que salen los términos es
 * el mismo (`candidateBase`) sin importar cuál esté activo.
 */
async function handlePreviewUnbackedTerms({ jobDescription }) {
  const profile = await chrome.storage.local.get(null);
  const candidateBase = profile.candidateBase || {};

  const { unbacked } = analyzeRequirementCoverage({
    profileTerms: collectProfileTerms(candidateBase),
    jobDescription,
    answer: ""
  });

  return { success: true, unbacked };
}

/**
 * Clasifica QUÉ te está pidiendo la pregunta, que no siempre es "véndete".
 *
 * Sin esto, las reglas de logro y "nunca declares una carencia" del system
 * prompt convertían CUALQUIER pregunta en un pitch de logros: a "Comenta tu
 * disponibilidad para trabajar de forma híbrida en Providencia" el modelo
 * respondía con arquitectura serverless y métricas de reducción de tiempos, sin
 * mencionar jamás la disponibilidad. Una pregunta logística quiere un dato, no
 * una hazaña.
 */
/**
 * Clasificación determinista. Devuelve también `matched`: si NINGUNA palabra
 * clave reconoció la pregunta, el "experience" que se retorna es un default
 * por descarte, no una decisión real — el llamador puede usar `matched` para
 * decidir si vale la pena pedirle una segunda opinión a un modelo antes de
 * confiar en ese default (ver `classifyIntentWithAI`).
 */
function classifyQuestionIntent(text) {
  if (!text) return { intent: "experience", matched: false };
  // Mismo saneado de tildes que detectQuestionLanguage. El rango de diacríticos
  // se construye desde string para que los caracteres combinantes no queden
  // literales (e invisibles) en el fuente.
  const DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");
  const norm = text.toLowerCase().normalize("NFD").replace(DIACRITICS, "");

  // Preguntas de DATO puntual del perfil: no piden narrativa ni juicio, piden
  // recitar un hecho — condiciones del puesto (disponibilidad, renta,
  // ubicación) o credenciales (título, casa de estudios, año de egreso). Ambas
  // se responden igual: el dato, sin STAR ni relleno.
  const logisticsTokens = [
    "disponibilidad", "disponible", "hibrid", "presencial", "remoto", "teletrabajo",
    "modalidad", "horario", "jornada", "turnos", "mudarte", "mudarse", "trasladarte",
    "reubicar", "residir", "vives", "resides", "viajar", "movilizarte", "comenzar",
    "incorporarte", "incorporacion", "aviso previo", "preaviso", "renta", "sueldo",
    "salario", "pretension", "pretensiones", "expectativa de renta", "licencia de conducir",
    "visa", "permiso de trabajo", "situacion militar", "nacionalidad", "edad",
    "availability", "available", "hybrid", "on-site", "onsite", "remote", "relocate",
    "relocation", "commute", "start date", "notice period", "salary", "compensation",
    "expected pay", "work permit", "driver's license", "willing to",
    // Credenciales académicas: piden recitar título/institución/año, no narrar
    // la formación. Es "titulo academico"/"titulo profesional" y no solo
    // "titulo" a secas, para no atrapar preguntas como "¿qué título le darías
    // a este proyecto?" o cualquier otro uso de la palabra fuera de contexto.
    "titulo academico", "titulo profesional", "grado academico", "ano de titulacion",
    "casa de estudios", "donde te titulaste", "donde estudiaste", "donde lo obtuvo",
    "donde la obtuvo", "nivel educacional", "nivel de estudios",
    "academic degree", "field of study", "graduation year", "where did you study",
    "alma mater", "degree obtained"
  ];

  // Motivación / fit cultural: se responden conectando con la oferta, no con métricas.
  const motivationTokens = [
    "por que te interesa", "por que quieres", "que te motiva", "por que postulas",
    "por que nuestra", "por que la empresa", "que te llama la atencion", "que esperas",
    "why do you want", "why are you interested", "what motivates", "why our",
    "why this role", "what attracts"
  ];

  // Marcadores EXPLÍCITOS de "cuéntame un caso real". Se evalúan ANTES que los
  // logísticos porque mandan sobre ellos: "Describe tu experiencia liderando
  // equipos remotos" contiene "remoto", pero no es una pregunta logística — y
  // clasificarla como tal la haría responder en dos frases secas y sin logros,
  // justo lo contrario de lo que pide.
  const experienceOverrideTokens = [
    "tu experiencia", "su experiencia", "que experiencia", "experiencia en",
    "experiencia con", "experiencia lider", "experiencia trabajando", "anos de experiencia",
    "un logro", "logros", "cuentanos un", "cuentame un", "describe un", "describa un",
    "ejemplo de", "un caso", "un proyecto", "proyecto en el que", "desafio", "reto que",
    "your experience", "experience with", "experience in", "experience leading",
    "describe a", "tell us about a time", "tell me about a time", "give an example",
    "a project where", "achievement", "have you worked", "have you used", "has utilizado"
  ];

  for (const token of motivationTokens) {
    if (norm.includes(token)) return { intent: "motivation", matched: true };
  }
  for (const token of experienceOverrideTokens) {
    if (norm.includes(token)) return { intent: "experience", matched: true };
  }
  for (const token of logisticsTokens) {
    if (norm.includes(token)) return { intent: "logistics", matched: true };
  }
  return { intent: "experience", matched: false };
}

/** Compatibilidad: código y tests existentes que solo necesitan el string. */
function detectQuestionIntent(text) {
  return classifyQuestionIntent(text).intent;
}

/**
 * Respaldo por IA para cuando el clasificador por palabras clave no reconoce
 * NINGUNA señal — el caso que antes se resolvía en silencio como "experience"
 * por descarte, aunque fuera un dato puntual con una redacción que nadie
 * había anticipado (así se coló "Indique su título académico, año de
 * titulación..." antes de agregar esas palabras clave a mano).
 *
 * Deliberadamente NO se llama para toda pregunta: el camino determinista ya
 * cubre la enorme mayoría con costo cero, y duplicar la llamada en cada
 * pregunta anularía el ahorro de enrutar preguntas simples a Haiku. Esta
 * llamada SÍ usa Haiku — es una clasificación de una palabra, no redacción —
 * y solo se paga en el subconjunto que el diccionario no reconoce.
 */
async function classifyIntentWithAI(question, ai) {
  try {
    const data = await callAnthropicMessagesApi({
      ai,
      model: MODEL_SIMPLE,
      max_tokens: 10,
      system: "Clasificas preguntas de formularios de postulación laboral en una sola palabra:\nLOGISTICS: pide un dato puntual del candidato, sin narrativa — disponibilidad, modalidad de trabajo, ubicación, renta, licencias, o una credencial académica (título, institución, año de titulación).\nMOTIVATION: pregunta por qué le interesa el puesto o la empresa.\nEXPERIENCE: pide narrar un caso, logro, proyecto o capacidad técnica.\nResponde ÚNICAMENTE con una de esas tres palabras en mayúsculas, nada más — ni explicación ni puntuación.",
      messages: [{ role: "user", content: [{ type: "text", text: question }] }]
    });
    const raw = extractTextFromResponse(data).trim().toUpperCase();
    if (raw.includes("LOGISTICS")) return "logistics";
    if (raw.includes("MOTIVATION")) return "motivation";
    return "experience";
  } catch (e) {
    // Sin respaldo disponible (sin red, API caída): el default seguro de
    // siempre. Nunca debe bloquear la generación de la respuesta.
    console.warn("[JobFill AI] Respaldo de clasificación por IA falló, se usa 'experience' por defecto:", e);
    return "experience";
  }
}

/**
 * Quita la sintaxis Markdown más común (negrita, cursiva, encabezados,
 * viñetas) conservando el contenido. Respaldo mecánico de la regla del prompt
 * que prohíbe Markdown: el campo de destino es texto plano, no un visor que
 * interprete formato, así que "**2.000.000 CLP**" debe llegar como
 * "2.000.000 CLP" — nunca con los asteriscos incluidos. Una instrucción en el
 * prompt no es una garantía; esto lo es.
 *
 * Deliberadamente NO toca guiones bajos sueltos (`_`): son comunes en texto
 * técnico legítimo (nombres de variables, snake_case) y tratarlos como cursiva
 * corrompería más de lo que arregla.
 */
function stripMarkdownFormatting(text) {
  if (!text) return text;
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1") // negrita+cursiva ***texto***
    .replace(/\*\*(.+?)\*\*/g, "$1")     // negrita **texto**
    .replace(/__(.+?)__/g, "$1")         // negrita __texto__
    .replace(/\*(.+?)\*/g, "$1")         // cursiva *texto*
    .replace(/^#{1,6}\s+/gm, "")         // encabezados # Texto
    .replace(/^\s*[-*+]\s+/gm, "")       // viñetas - Texto / * Texto
    .replace(/^\s*\d+\.\s+/gm, "")       // listas numeradas 1. Texto
    .trim();
}

/**
 * Recorta `text` a `limit` caracteres SIN dejar una idea visiblemente cortada.
 * Prioridad: 1) cortar en el último punto/!/? cercano al límite (respuesta
 * completa); 2) si no hay uno cercano, cortar en el último espacio y cerrar con
 * un punto — nunca con "..." (se lee como una respuesta inacabada en una
 * postulación laboral, algo que nunca debe pasar).
 */
function closeSentenceCleanly(text, limit) {
  const truncated = text.slice(0, limit);

  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? ")
  );
  if (lastSentenceEnd > limit * 0.6) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }

  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > limit * 0.5 ? truncated.slice(0, lastSpace) : truncated;
  const closed = cut.trim().replace(/[,;:\-–—]+$/, "");
  return /[.!?]$/.test(closed) ? closed : `${closed}.`;
}

function calculateTargetCharacterWindow(maxCharacters) {
  if (!maxCharacters || maxCharacters <= 40) {
    return { targetMin: 350, targetMax: 550, isLimited: false };
  }

  let targetMax = Math.floor(maxCharacters * 0.84); // 16% under max
  let targetMin = Math.max(35, Math.floor(maxCharacters * 0.80)); // 20% under max

  // Ensure margin is at least 28 characters if possible
  if (maxCharacters - targetMax < 28 && maxCharacters > 60) {
    targetMax = maxCharacters - 28;
    targetMin = Math.max(30, targetMax - 30);
  }

  // Ensure margin does not exceed 124 characters
  if (maxCharacters - targetMax > 124) {
    targetMax = maxCharacters - 124;
    targetMin = Math.max(100, targetMax - 100);
  }

  // Techo natural: un campo generoso (2000 caracteres es común en Getonbrd,
  // Laborum) NO es una invitación a llenarlo. Antes el objetivo escalaba
  // linealmente con el máximo del campo (~84% de 2000 ≈ 1780), y eso era
  // justo lo que producía las respuestas "currículum completo" — el modelo
  // apunta a donde se le dice que apunte. Una respuesta de entrevista natural
  // rara vez pasa de ~750 caracteres aunque el formulario permita mucho más;
  // dejar de perseguir el techo del campo cuando sobra espacio es lo que
  // separa una respuesta completa de una que enumera todo el perfil.
  const NATURAL_CEILING = 750;
  if (targetMax > NATURAL_CEILING) {
    targetMax = NATURAL_CEILING;
    targetMin = Math.max(450, targetMax - 200);
  }

  return { targetMin, targetMax, isLimited: true };
}

/**
 * System prompt compartido por la generación de una sola pregunta y por el
 * modo agrupado (ver `handleClaudeGenerationBatch`). Extraído a una función
 * para que ambos caminos usen exactamente las mismas reglas de voz, tono y
 * honestidad — mantenerlo duplicado en dos sitios es como se desincronizan
 * silenciosamente sin que ningún test lo note.
 *
 * `extraRules` deja espacio para instrucciones que solo aplican a un modo (el
 * formato de salida JSON del modo agrupado) sin ensuciar el prompt de la
 * pregunta única, que además se cachea byte a byte entre preguntas.
 */
function buildSystemPrompt(profile, extraRules = "") {
  return `Eres un asistente de redacción experto y estratega de carrera para postulaciones de empleo. Tu objetivo es generar una respuesta idónea, auténtica, personalizada y convincente para una pregunta de postulación laboral.

DIRECTRICES DE COMPRENSIÓN PROFUNDA:
1. ANÁLISIS EXHAUSTIVO DE LA PREGUNTA: Identifica la intención exacta del reclutador (ej. Desafío técnico resuelto, Motivación por la empresa/cultura, Liderazgo, Aporte técnico al equipo o Logros medibles). Responde DIRECTAMENTE a lo que se pregunta desde la primera palabra, sin rodeos.
2. CERO RELLENO / CERO INTRODUCCIONES CLICHÉ: Prohibido empezar con frases vacías como "Como profesional apasionado...", "A lo largo de mi carrera...", "En mi experiencia...". Ve directo al núcleo de la respuesta.
2.b. LA PRIMERA FRASE RESPONDE LA PREGUNTA LITERAL: tu frase inicial debe contener el objeto exacto de la pregunta (si preguntan por servicios cloud, nómbralos; si preguntan por disponibilidad, declara la disponibilidad; si preguntan por un equipo, habla del equipo). Está PROHIBIDO abrir con una fórmula de autoventa genérica reutilizable en cualquier pregunta — en particular "Mi mayor fortaleza es...", "Mi principal fortaleza...", "Soy un profesional que...", "Destaco por..." — porque delata una respuesta de plantilla ante el reclutador. Si tu primera frase serviría igual para otra pregunta distinta, reescríbela.
3. LA FORMA LA DICTA LA PREGUNTA, NO UNA PLANTILLA: no existe una estructura obligatoria. Cada pregunta pide una forma distinta y debes adoptar la suya: una pregunta que empieza con "¿qué herramientas...?" se responde nombrándolas; una que pide un caso concreto se responde narrando ese caso; una de opinión o enfoque se responde con un criterio propio, no con un currículum. Está PROHIBIDO forzar toda respuesta al molde "logro + tecnología + porcentaje": aplicado a tres preguntas seguidas delata texto generado y aburre al reclutador.
3.b. LAS MÉTRICAS SON UN RECURSO, NO UN REQUISITO: incluye una cifra SOLO si está en la Base de Datos Y responde a lo que se preguntó. Una respuesta sin números puede ser excelente. Nunca metas un porcentaje porque "suena profesional", nunca repitas la misma cifra en varias respuestas del formulario, y jamás inventes una que no esté en la Base de Datos.
3.c. SUENA A PERSONA, NO A PLANTILLA: escribe como escribiría un buen profesional contestando con calma — frases de largo variado, lenguaje directo y concreto. Evita el registro de folleto corporativo ("soluciones robustas y escalables de punta a punta", "impacto medible en el negocio") y las cadenas de adjetivos vacíos. Si una frase no sobreviviría dicha en voz alta en una entrevista, reescríbela.
4. VOZ Y TONO: Primera persona (yo / I), tono ${profile.aiTone || "profesional y persuasivo"}, asertivo y seguro. TEXTO PLANO, SIN MARKDOWN: la respuesta se pega directo en un campo de formulario, no en un visor que interprete formato. Prohibido usar **negrita**, *cursiva*, encabezados con #, viñetas con - o *, o cualquier otra sintaxis Markdown — esos símbolos aparecerían literales (asteriscos y todo) en lo que lee el reclutador. Texto corrido, nada más.
5. IDIOMA: El mensaje del usuario indica explícitamente el idioma exigido para ESTA pregunta puntual (varía por pregunta). Síguelo de forma estricta y total.
6. LONGITUD: El mensaje del usuario indica el rango de longitud exigido para ESTE campo puntual (varía por campo). Respétalo de forma estricta.
7. CONCRECIÓN OBLIGATORIA — LO QUE PUEDES AFIRMAR: cada afirmación debe estar respaldada por una de estas dos fuentes, y por ninguna otra: (a) la Base de Datos del candidato (cargos, logros, tecnologías, proyectos) que se te entrega en el mensaje del usuario, o (b) los puntos que el propio candidato haya CONFIRMADO explícitamente en este mensaje bajo "EXPERIENCIA CONFIRMADA POR EL CANDIDATO". La Base de Datos es un registro incompleto de su carrera —hay experiencia real suya que no está escrita ahí—, y por eso una confirmación suya vale como hecho: él es la autoridad sobre su experiencia, no el archivo. Lo que sigue terminantemente prohibido es que TÚ añadas por tu cuenta lo que ninguna de las dos fuentes respalda: inventar una cifra, un año, una certificación, un cliente, un cargo o una tecnología que nadie te ha dado. También está prohibido responder con generalidades vagas ("tengo experiencia relevante", "soy un buen candidato") cuando hay un dato concreto disponible para usar en su lugar.
8. VERIFICACIÓN FINAL DE IDIOMA: Antes de responder, confirma que el 100% de tu texto está en el idioma indicado en la regla 5 para esta pregunta puntual. No mezcles idiomas ni traduzcas parcialmente.
9. USO DE LA DESCRIPCIÓN COMPLETA DE LA OFERTA (si se entrega): identifica los requisitos, tecnologías y responsabilidades específicas mencionadas en la oferta, y prioriza en tu respuesta los cargos/proyectos/tecnologías reales del candidato que mejor calcen con ellos. Nunca afirmes que el candidato cumple un requisito que no esté respaldado (por su Base de Datos o por una confirmación explícita suya incluida en este mensaje).
9.b. USA EL TÉRMINO LITERAL DE LA OFERTA: cuando el candidato tenga una experiencia y la oferta la nombre con una palabra concreta, escribe ESA palabra, no un sinónimo ni una paráfrasis. Si la oferta dice "GCP" no escribas "la nube de Google"; si dice "Looker Studio" no escribas "paneles de analítica". Estas respuestas suelen pasar por un cribado automático que busca los términos tal cual aparecen en la oferta, y una paráfrasis correcta puede no contar como coincidencia. Esto NO es rellenar de palabras clave: solo aplica a lo que el candidato realmente tiene, se escribe dentro de una frase con sentido, y jamás como un listado pegado al final.
10. PROHIBIDO NEGAR O MINIMIZAR EXPERIENCIA (SOLO EN PREGUNTAS SOBRE EXPERIENCIA): Nunca uses frases que declaren una carencia ("no cuento con experiencia formal en...", "mi fortaleza real está en X, no en Y", "no tengo experiencia en..."). Toda respuesta debe ser POSITIVA hacia la postulación. Si la pregunta apunta a un área sin match exacto y evidente en la Base de Datos, busca el trabajo real más cercano o transferible (ej. diseño de dashboards, decisiones de UX en una herramienta interna, estructuración de flujos de usuario) y preséntalo con seguridad como evidencia de esa capacidad, conectando explícitamente por qué aplica — sin declarar jamás una ausencia.
    Cómo se concilia con la regla 7: la 7 fija QUÉ HECHOS puedes usar (solo los de la Base de Datos, sin excepción); la 10 fija CÓMO LOS ENCUADRAS (siempre en positivo, eligiendo el hecho real más cercano en vez de admitir un vacío). Reencuadrar un hecho real como evidencia transferible está permitido; inventar el hecho, la cifra, el cargo, el título o la certificación NO lo está, nunca.
11. NO TODA PREGUNTA PIDE UN LOGRO — RESPETA EL TIPO DE PREGUNTA: el mensaje del usuario declara el TIPO de esta pregunta puntual (logística, motivación o experiencia) y las instrucciones propias de ese tipo. La regla 10 (reencuadre positivo de experiencia) aplica ÚNICAMENTE a preguntas de tipo experiencia. En una pregunta LOGÍSTICA (disponibilidad, modalidad híbrida/remota, ubicación, fecha de inicio, renta, licencia, visa, credencial académica) el reclutador espera un DATO claro y directo: responderla con arquitectura, stack o métricas de proyectos es una respuesta fallida por más impresionante que suene, porque no contesta lo que se preguntó. Contesta el dato y detente.
12. UN HILO CENTRAL, NO UN RESUMEN DE CV: para preguntas de experiencia, la Base de Datos del candidato puede traer 4 cargos y 3 proyectos — eso es material para ELEGIR, no una lista que haya que agotar. Escoge el UNO o, como mucho, los DOS elementos (un cargo, o un cargo y un proyecto relacionado) que mejor respondan exactamente lo que se preguntó, y desarrolla ESOS con algo de detalle real. Nombrar de pasada cuatro proyectos y tres tecnologías distintas en una sola respuesta no la hace más completa, se lee como una enumeración de currículum, no como la respuesta que daría una persona real en una conversación. Señal de que te desviaste: si tu borrador salta de un proyecto a otro con una frase de transición forzada ("Ese mismo enfoque lo apliqué en...", "Esa misma capacidad la uso en...") solo para meter un segundo o tercer ejemplo, bórralo y quédate con el primero. Menos hechos bien desarrollados es mejor que muchos hechos mencionados de pasada.
${extraRules}
${profile.customAiInstructions ? `Instrucciones adicionales del usuario: ${profile.customAiInstructions}` : ""}`;
}

/**
 * Resuelve el perfil aplicable a esta oferta y arma los bloques de contexto
 * (completo y reducido/logístico) que se le mandan a Claude. Extraído fuera
 * de `handleClaudeGeneration` porque el modo agrupado (`handleClaudeGenerationBatch`)
 * necesita EXACTAMENTE el mismo contexto una sola vez para todas sus
 * preguntas — reconstruirlo por separado sería duplicar ~180 líneas que ya
 * tienen su propio historial de bugs (perfil equivocado, CV duplicado, etc.).
 */
function resolveCandidateContext(profile, jobTitle, jobDescription) {
  const candidateBase = profile.candidateBase || {};
  const cvIndexes = profile.cvIndexes || [];
  const indexSelection = selectBestCvIndex(cvIndexes, jobTitle, jobDescription, profile.activeCvIndexId);
  const activeIndex = indexSelection.index;

  if (cvIndexes.length > 1) {
    console.log(
      "[JobFill AI] Índice de CV elegido:", activeIndex?.area || "(ninguno)",
      "| candidatos:", indexSelection.candidates.map(c => `${c.index.area}=${c.score}`).join(", "),
      indexSelection.uncertain ? "| AMBIGUO (puntajes muy cerca)" : ""
    );
  }

  // El índice solo aporta un override de título/headline para ESTA faceta —
  // todo lo demás (identidad, CV, legal) es el mismo `candidateBase` sin
  // importar qué índice esté activo.
  const p = { ...candidateBase, headline: activeIndex?.targetRole || candidateBase.headline || candidateBase.currentTitle || "" };
  const cvDb = p.cvDatabase || {};
  const targetResumeText = p.resumeText || cvDb.rawText || "";
  const matchedProfileName = activeIndex?.area || activeIndex?.targetRole || "";

  // Sin material real del candidato, la regla "no niegues experiencia" del
  // prompt empuja al modelo a producir una respuesta convincente sostenida por
  // nada — es decir, inventada, y firmada por el usuario ante un reclutador.
  // Mejor fallar de forma visible que redactar algo verosímil y falso.
  const hasRealCandidateData = Boolean(
    (cvDb.experiences && cvDb.experiences.length > 0) ||
    (cvDb.projects && cvDb.projects.length > 0) ||
    (targetResumeText && targetResumeText.trim().length > 80) ||
    (p.summary && p.summary.trim().length > 40) ||
    (p.skills && p.skills.trim().length > 10)
  );

  if (!hasRealCandidateData) {
    throw new Error("Tu perfil no tiene experiencia, proyectos ni CV cargados todavía. Complétalo en las opciones de JobFill AI antes de generar respuestas: sin datos reales, la IA solo puede inventar.");
  }

  // ─── SELECCIÓN DE MATERIAL POR RELEVANCIA PARA ESTA OFERTA ─────────────────
  //
  // El CV entero se enviaba en cada pregunta. Se recorta, pero filtrando por la
  // OFERTA y no por la pregunta: la oferta es la misma durante todo el
  // formulario, así que el bloque sigue siendo idéntico entre preguntas y el
  // caché de Anthropic lo sigue reutilizando.
  //
  // Filtrar por pregunta sería la intuición natural y resulta CONTRAPRODUCENTE:
  // el bloque cambiaría en cada llamada, cada una escribiría una entrada de
  // caché que nadie llega a leer, y en un formulario de 5 preguntas se acaba
  // pagando más que enviando el CV completo cacheado (≈10.500 tokens frente a
  // ≈8.700). Filtrando por oferta se ahorra ~60% y se conserva el caché.
  const jobText = `${jobDescription || ""} ${jobTitle || ""}`;

  let experiencesContext = "";
  if (cvDb.experiences && cvDb.experiences.length > 0) {
    const ranked = rankForJob(cvDb.experiences, exp => relevanceToJob(jobText, exp.technologies, exp.role, exp.achievements));
    const detailed = ranked.slice(0, MAX_DETAILED_EXPERIENCES);
    const rest = ranked.slice(MAX_DETAILED_EXPERIENCES);

    experiencesContext = detailed.map(({ item: exp }, idx) => `
[CARGO PREVIO ${idx + 1}]: ${exp.role} en ${exp.company} (${exp.period || ""})
- Responsabilidades: ${exp.description || "N/A"}
- Logros clave: ${exp.achievements || "N/A"}
- Tecnologías: ${exp.technologies || "N/A"}
`).join("\n");

    // El resto NO se elimina —negar un cargo que existe sería peor que omitir
    // detalle— pero se resume en una línea: sigue disponible para responder
    // "¿cuántos años llevas?" o "¿dónde trabajaste?" sin costar 300 tokens cada uno.
    if (rest.length) {
      experiencesContext += `\n[OTROS CARGOS DEL CANDIDATO, en resumen]\n${rest.map(({ item: exp }) =>
        `- ${exp.role} en ${exp.company} (${exp.period || "sin fecha"})${exp.technologies ? ` — ${exp.technologies}` : ""}`
      ).join("\n")}\n`;
    }
  }

  let projectsContext = "";
  if (cvDb.projects && cvDb.projects.length > 0) {
    const ranked = rankForJob(cvDb.projects, proj => relevanceToJob(jobText, proj.technologies, proj.name, proj.description));
    const detailed = ranked.slice(0, MAX_DETAILED_PROJECTS);
    const rest = ranked.slice(MAX_DETAILED_PROJECTS);

    projectsContext = detailed.map(({ item: proj }, idx) => `
[PROYECTO ${idx + 1}]: ${proj.name}
- Descripción: ${proj.description || "N/A"}
- Stack: ${proj.technologies || "N/A"}
`).join("\n");

    if (rest.length) {
      projectsContext += `\n[OTROS PROYECTOS, en resumen]\n${rest.map(({ item: proj }) =>
        `- ${proj.name}${proj.technologies ? ` — ${proj.technologies}` : ""}`
      ).join("\n")}\n`;
    }
  }

  /**
   * El CV crudo solo se envía cuando aporta algo que la BD estructurada no tiene.
   *
   * Los cargos y proyectos de la BD se EXTRAEN de ese mismo texto, así que
   * mandar ambos duplicaba el contenido: hasta 12.000 caracteres (~3.300 tokens)
   * repitiendo lo que las secciones de arriba ya dicen mejor ordenado. Cuando la
   * BD está bien poblada, el texto crudo es puro peso muerto; cuando está vacía
   * o es mínima, es la ÚNICA fuente real y se envía (con un tope más ajustado).
   */
  const structuredIsRich = (cvDb.experiences?.length || 0) >= 2
    || ((cvDb.experiences?.length || 0) >= 1 && (cvDb.projects?.length || 0) >= 1);

  const resumeTextBlock = !targetResumeText
    ? ""
    : structuredIsRich
      ? ""
      : `\n--- TEXTO BASE DEL CV ---\n${targetResumeText.slice(0, 8000)}`;

  let customQaContext = "";
  if (p.customQA && p.customQA.length > 0) {
    // El formulario de Opciones guarda `keywords` (para MATCHEAR la pregunta
    // del formulario, en content/autofill.js), no un enunciado de pregunta —
    // nunca hubo un campo `question`. Citar `qa.question` aquí imprimía
    // literalmente "undefined" en el prompt para cada Q&A personalizado desde
    // que existe esta función.
    customQaContext = p.customQA.map((qa, idx) => `
[Q&A PERSONALIZADO ${idx + 1}] (se activa si la pregunta del formulario se relaciona con: "${qa.keywords || ""}"):
- Respuesta de referencia: ${qa.answer}
`).join("\n");
  }

  let customFieldsContext = "";
  if (p.customFields && p.customFields.length > 0) {
    customFieldsContext = p.customFields.map((cf, idx) => `- ${cf.label}: ${cf.value}`).join("\n");
  }

  /**
   * Perfil REDUCIDO para preguntas logísticas.
   *
   * Una pregunta de disponibilidad, renta o ubicación se responde con cuatro
   * datos del perfil: mandar además el CV completo (12.000 caracteres) y la
   * oferta entera (6.000) son ~4.500 tokens por cada dos frases de respuesta, y
   * encima el prompt PROHÍBE usar ese material en este tipo de pregunta. Es
   * decir, se pagaba por enviar contexto que el modelo tenía prohibido usar.
   */
  // Preguntas de credencial académica ("¿título, año, dónde lo obtuvo?") caen
  // en este mismo bucket reducido — necesitan degree/university/education,
  // que antes no vivían aquí porque el bucket solo pensaba en disponibilidad.
  const educationEntries = (cvDb.education || [])
    .map(ed => `${ed.degree || ""}${ed.institution ? ` — ${ed.institution}` : ""}${ed.year ? ` (${ed.year})` : ""}`.trim())
    .filter(Boolean);

  // Un dato ausente se declara como "No especificado", NUNCA con un valor
  // plausible ("3 años", "Inmediata", "Intermedio"): el modelo trata este
  // bloque como la verdad del candidato y lo afirma ante el reclutador. Con
  // "No especificado", la regla de logística ("no inventes datos que el perfil
  // no trae") lo hace responder sin comprometer una cifra falsa.
  const logisticsContext = `
PERFIL DEL CANDIDATO (datos para preguntas de disponibilidad, condiciones y credenciales académicas):
- Nombre: ${p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim() || "Candidato"}
- Título/Cargo Objetivo: ${p.headline || p.currentTitle || "Profesional"}
- Años de Experiencia: ${p.yearsOfExperience ? `${p.yearsOfExperience} años` : "No especificado"}
- Nivel de Inglés: ${p.englishLevel || "No especificado"}
- Ubicación: ${[p.city, p.country].filter(Boolean).join(", ") || "No especificada"}
- Disponibilidad: ${p.noticePeriod || "No especificada"}
- Pretensiones Salariales: ${p.salaryExpectation ? `${p.salaryExpectation} ${p.currency || "CLP"}` : "No especificadas"}
- Título Académico: ${p.degree || "No especificado"}
- Casa de Estudios: ${p.university || "No especificada"}
${educationEntries.length ? `- Educación registrada: ${educationEntries.join(" | ")}` : ""}
${customFieldsContext ? `\n--- CAMPOS PERSONALIZADOS DEL CANDIDATO ---\n${customFieldsContext}` : ""}
${customQaContext ? `\n--- BANCO DE PREGUNTAS Y RESPUESTAS FRECUENTES DEL CANDIDATO ---\n${customQaContext}` : ""}
`.trim();

  const candidateContext = `
PERFIL DEL CANDIDATO:
- Nombre: ${p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim() || "Candidato"}
- RUT / DNI: ${p.rut || "No especificado"}
- Título/Cargo Objetivo: ${p.headline || p.currentTitle || "Profesional"}
- Años de Experiencia: ${p.yearsOfExperience ? `${p.yearsOfExperience} años` : "No especificado"}
- Habilidades Clave: ${p.skills || ""}
- Nivel de Inglés: ${p.englishLevel || "No especificado"}
- Educación: ${p.degree || ""} (${p.university || ""})
- Resumen Profesional: ${p.summary || ""}
- Disponibilidad: ${p.noticePeriod || "No especificada"}
- Pretensiones Salariales: ${p.salaryExpectation ? `${p.salaryExpectation} ${p.currency || "CLP"}` : "No especificadas"}
${matchedProfileName ? `- Versión de Perfil / CV Aplicada: ${matchedProfileName}` : ""}
${customFieldsContext ? `\n--- CAMPOS PERSONALIZADOS DEL CANDIDATO ---\n${customFieldsContext}` : ""}
${customQaContext ? `\n--- BANCO DE PREGUNTAS Y RESPUESTAS FRECUENTES DEL CANDIDATO ---\n${customQaContext}` : ""}

--- BASE DE DATOS DE EXPERIENCIA LABORAL Y CARGOS ---
${experiencesContext || "Sin cargos desglosados en BD"}

--- PROYECTOS DESTACADOS ---
${projectsContext || "Sin proyectos en BD"}
${resumeTextBlock}
`.trim();

  return { p, cvDb, matchedProfileName, hasRealCandidateData, logisticsContext, candidateContext };
}

async function handleClaudeGeneration({ question, fieldType, jobTitle, companyName, jobDescription, maxCharacters, minCharacters, previousAnswers, mustCover }) {
  const profile = await chrome.storage.local.get(null);

  const ai = JobFillAi.readAiSettings(profile);
  const aiProblem = JobFillAi.aiSettingsProblem(ai);
  if (aiProblem) throw new Error(aiProblem);

  const { p, matchedProfileName, hasRealCandidateData, logisticsContext, candidateContext } =
    resolveCandidateContext(profile, jobTitle, jobDescription);

  // Sin material real del candidato, la regla "no niegues experiencia" del
  // prompt empuja al modelo a producir una respuesta convincente sostenida por
  // nada — es decir, inventada, y firmada por el usuario ante un reclutador.
  // Mejor fallar de forma visible que redactar algo verosímil y falso.
  if (!hasRealCandidateData) {
    throw new Error("Tu perfil no tiene experiencia, proyectos ni CV cargados todavía. Complétalo en las opciones de JobFill AI antes de generar respuestas: sin datos reales, la IA solo puede inventar.");
  }

  // Detect Question Language with high precision.
  // Solo la pregunta, NUNCA el jobTitle: un cargo en español ("Desarrollador
  // Senior") no dice nada del idioma de la pregunta de screening, y mezclarlo
  // aquí forzaba respuestas en español a preguntas 100% en inglés cuando el
  // puesto estaba publicado en un mercado hispanohablante.
  const detectedLang = detectQuestionLanguage(question);
  const isEnglish = detectedLang === "en";

  // Híbrido: el diccionario decide gratis e instantáneo en el caso común: solo
  // cuando NINGUNA palabra clave reconoce la pregunta se paga una consulta
  // mínima a Haiku para no adivinar en silencio (ver classifyIntentWithAI).
  const intentGuess = classifyQuestionIntent(question);
  const questionIntent = intentGuess.matched
    ? intentGuess.intent
    : await classifyIntentWithAI(question, ai);

  console.log(
    "[JobFill AI] Idioma detectado:", detectedLang, "| Tipo:", questionIntent,
    intentGuess.matched ? "(palabra clave)" : "(respaldo IA)",
    "| Pregunta recibida:", JSON.stringify(question)
  );

  // Calculate target character window (15%-18% margin or 28-124 chars under max)
  const charWindow = calculateTargetCharacterWindow(maxCharacters);

  // languageRule / lengthRule con el valor YA RESUELTO (idioma detectado, ventana
  // de caracteres del campo puntual) NUNCA van en el system prompt: varían en
  // cada pregunta, así que si vivieran ahí invalidarían el cache de Anthropic en
  // cada llamada. En vez de eso, el system prompt solo referencia genéricamente
  // "el idioma indicado en el mensaje del usuario" / "el rango de longitud
  // indicado en el mensaje del usuario", y el valor concreto va en el bloque
  // variable del mensaje de usuario (después del breakpoint de caché). Esto deja
  // el system prompt 100% estático — se cachea una sola vez por sesión del
  // usuario, no una vez por pregunta.
  const languageRule = isEnglish
    ? `MANDATORY: THIS SPECIFIC QUESTION IS IN ENGLISH. Write your response 100% in ENGLISH, naturally and persuasively, even if the candidate's CV/data is in Spanish.`
    : `OBLIGATORIO: ESTA PREGUNTA PUNTUAL ESTÁ EN ESPAÑOL. Redacta tu respuesta 100% en ESPAÑOL de forma natural y persuasiva, incluso si el CV/datos del candidato estuvieran en inglés.`;

  // Instrucciones propias del TIPO de pregunta. Van en el bloque variable (no en
  // el system prompt) porque cambian pregunta a pregunta: en el system prompt
  // invalidarían la caché de Anthropic en cada llamada.
  const intentRules = {
    logistics: `TIPO DE ESTA PREGUNTA: DATO PUNTUAL (logística/condiciones del puesto O credencial académica).
- El reclutador pide un DATO concreto — disponibilidad, modalidad, ubicación, fecha de inicio, renta, licencia, O título/institución/año de titulación —, no una demostración de talento ni el relato de la formación.
- Responde el dato en la PRIMERA frase, de forma afirmativa y sin rodeos, usando los campos reales del perfil (Disponibilidad, Ubicación, Pretensiones Salariales, Educación, Campos Personalizados). Menciona explícitamente los términos de la pregunta (p. ej. la modalidad y la comuna/ciudad que nombra, o el nombre exacto del título y la institución si preguntan por eso).
- PROHIBIDO en esta pregunta: métricas, nombres de proyectos, listados de stack tecnológico o narración de logros/experiencia laboral — aunque la pregunta mencione de paso el título profesional, no es una invitación a conectar la carrera completa con él.
- Extensión: 1 a 3 frases. Una respuesta correcta aquí es breve; rellenar para alcanzar un mínimo la empeora.
- No inventes datos que el perfil no trae (una dirección exacta, un tiempo de traslado, una fecha concreta, un año de titulación que no está registrado): confirma solo lo que el perfil sí respalda.`,
    motivation: `TIPO DE ESTA PREGUNTA: MOTIVACIÓN / INTERÉS EN EL PUESTO O LA EMPRESA.
- Conecta lo que la DESCRIPCIÓN DE LA OFERTA plantea (producto, problema, tecnologías, propósito) con la trayectoria real del candidato.
- Prioriza el porqué sobre el currículum: puedes citar UN hecho real como respaldo, pero la respuesta debe explicar el interés, no enumerar logros.
- Nada de halagos genéricos aplicables a cualquier empresa ("empresa líder e innovadora"): apóyate en algo específico de esta oferta.`,
    experience: `TIPO DE ESTA PREGUNTA: EXPERIENCIA / CAPACIDAD TÉCNICA.
- Responde el objeto EXACTO de la pregunta con material real del perfil. Si pregunta por un dominio puntual (p. ej. servicios cloud), nombra esos elementos concretos; no narres el proyecto completo por defecto.
- Ajusta la forma a lo que se pide: una pregunta de inventario ("qué has usado") pide los elementos concretos y para qué los usaste; una pregunta de caso ("describe un proyecto/desafío") sí pide una narración breve con contexto, decisión y desenlace. No apliques el molde de una a la otra.
- Puedes apoyarte en una cifra real de la Base de Datos si viene al caso, pero no la fuerces: mejor un detalle técnico específico y verdadero (una decisión de diseño, un problema resuelto, por qué elegiste esa herramienta) que un porcentaje pegado al final.`
  };
  const intentRule = intentRules[questionIntent] || intentRules.experience;

  // Anti-repetición: sin esto, el mismo perfil + el mismo prompt hacen que todas
  // las preguntas del formulario abran igual y narren el mismo proyecto, y el
  // reclutador recibe tres párrafos casi calcados. El modelo no puede evitar lo
  // que no ve, así que se le pasan las respuestas ya generadas en ESTE formulario.
  const priorAnswers = Array.isArray(previousAnswers)
    ? previousAnswers.filter(a => typeof a === "string" && a.trim().length > 0).slice(-4)
    : [];
  const antiRepetitionRule = priorAnswers.length
    ? `\nRESPUESTAS QUE YA ESCRIBISTE EN ESTE MISMO FORMULARIO (el reclutador las leerá juntas):
${priorAnswers.map((a, i) => `[YA ENVIADA ${i + 1}]: "${a.slice(0, 400)}"`).join("\n")}

CÓMO USAR ESTO — LA RELEVANCIA MANDA SOBRE LA VARIEDAD:
- Diferénciate en la FORMA siempre: no repitas la frase de apertura, la estructura ni las mismas cifras de las respuestas anteriores.
- En el FONDO, la pregunta manda. Si el proyecto que mejor responde ESTA pregunta ya apareció antes, ÚSALO IGUAL: entra por otro ángulo del mismo proyecto (otra decisión técnica, otra dificultad, otro rol dentro de él) en vez de cambiarlo por material que no viene al caso.
- PROHIBIDO responder con un proyecto peor solo por variar: si te preguntan por IA y tu trabajo real de IA ya se mencionó, sigue hablando de IA — nunca lo sustituyas por un proyecto de otro dominio. Una respuesta variada pero fuera de tema es peor que una que repite proyecto, porque no contesta lo que se preguntó.`
    : "";

  // Términos que el USUARIO confirmó explícitamente que domina, en respuesta a
  // la verificación de cobertura. No están (todavía) en su perfil guardado, pero
  // eso no los hace falsos: el perfil es un registro incompleto y él es la
  // autoridad sobre su propia experiencia. Por eso entran como hechos válidos —
  // lo que sigue prohibido es que el MODELO se los invente por su cuenta.
  const confirmedTerms = Array.isArray(mustCover)
    ? mustCover.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()).slice(0, 12)
    : [];
  const mustCoverRule = confirmedTerms.length
    ? `\nEXPERIENCIA CONFIRMADA POR EL CANDIDATO PARA ESTA RESPUESTA:
${confirmedTerms.map(t => `- ${t}`).join("\n")}

El candidato acaba de confirmar que domina estos puntos aunque no figuren en su Base de Datos (su perfil guardado está incompleto). Trátalos como CIERTOS e inclúyelos de forma natural, usando el término tal como lo escribe la oferta. Dos límites: intégralos donde vengan al caso para ESTA pregunta —no los enumeres al final como una lista pegada—, y no inventes a su alrededor detalles que nadie te ha dado (cifras, años de uso, nombres de clientes o proyectos concretos).`
    : "";

  // Ventana de longitud efectiva. El orden importa y no es obvio:
  //
  // 1. Un MÍNIMO exigido por el formulario manda sobre todo lo demás, incluida
  //    la brevedad de una pregunta logística: por debajo de esa cifra el sitio
  //    RECHAZA el envío, y una respuesta breve y perfecta que no se puede enviar
  //    no sirve de nada.
  // 2. Cuando hay mínimo y máximo (un rango tipo "entre 300 y 2000 caracteres"),
  //    la referencia es el MÍNIMO, no el máximo: apuntar al techo de un rango
  //    ancho produce parrafadas de 1.800 caracteres que nadie pidió.
  // 3. Sin mínimo, se mantiene el comportamiento anterior (rozar el máximo, o
  //    la brevedad logística cuando no hay límite alguno).
  const floor = minCharacters || null;
  const ceiling = charWindow.isLimited ? charWindow.targetMax : null;
  const floorTarget = floor ? Math.min(floor + 400, ceiling || floor + 400) : null;

  // Preguntas de MONTO puro (renta, sueldo, pretensiones): piden una cifra,
  // no una frase de acompañamiento. Se distinguen del resto de "logistics"
  // porque disponibilidad/ubicación sí necesitan una oración completa para
  // sonar natural ("Tengo disponibilidad para modalidad híbrida..."), mientras
  // que "Mis pretensiones de renta líquida son $2.000.000 CLP. Esta cifra
  // refleja mi formación en..." es puro relleno: la pregunta no pidió que se
  // justificara la cifra con la carrera completa.
  const AMOUNT_QUESTION_RE = /\b(renta|sueldo|salari\w*|pretension(es)?|remuneracion|l[ií]quido|bruto|compensation|salary|expected pay)\b/i;
  const isAmountQuestion = questionIntent === "logistics" && AMOUNT_QUESTION_RE.test(question);

  // Rango efectivo único, para que todas las menciones a la longitud (la regla,
  // la línea del bloque variable y la instrucción final) digan lo mismo. Antes
  // vivía duplicado en tres sitios y bastaba tocar uno para que el prompt se
  // contradijera a sí mismo.
  const effectiveMin = floor
    ? floor + 80
    : isAmountQuestion ? 15 : (charWindow.isLimited ? charWindow.targetMin : 350);
  const effectiveMax = floor
    ? floorTarget
    : isAmountQuestion ? 50 : (charWindow.isLimited ? charWindow.targetMax : 550);

  const lengthRule = floor
    ? `LONGITUD EXIGIDA POR EL FORMULARIO PARA ESTE CAMPO:
- MÍNIMO OBLIGATORIO: ${floor} caracteres. El formulario RECHAZA el envío por debajo de esa cifra, así que quedarte corto invalida la respuesta por buena que sea.
- RANGO OBJETIVO: entre ${floor + 80} y ${floorTarget} caracteres.${ceiling ? `\n- NO excedas ${ceiling} caracteres bajo ninguna circunstancia (límite del campo: ${maxCharacters}).` : ""}
${questionIntent === "logistics"
  ? `- ESTA PREGUNTA ES LOGÍSTICA y su dato se contesta en una frase, pero el mínimo obliga a extenderse: da el dato en la PRIMERA frase y complétala con contexto verdadero y pertinente a lo que se pregunta (tu situación respecto a esa modalidad, ubicación o plazo, cómo te organizas, tu disposición). Aun así NO metas logros, métricas ni tecnologías para rellenar: alargar con material ajeno a la pregunta es peor que un estilo escueto.`
  : `- Desarrolla con material real y pertinente. Nunca rellenes ni repitas la misma idea con otras palabras para alcanzar la cifra.`}
- Nunca termines con puntos suspensivos ("...") ni dejes una frase a medias.`
    : isAmountQuestion
      ? `LONGITUD PARA ESTE CAMPO PUNTUAL: esta pregunta pide una CIFRA, no una respuesta redactada.
- Entrega ÚNICAMENTE el monto con su moneda (p. ej. "$2.000.000 CLP", o "2.000.000 CLP líquidos" si la pregunta especifica líquido/bruto). Nada de oraciones completas.
- PROHIBIDO justificar la cifra con formación, años de experiencia, stack tecnológico o disponibilidad — la pregunta no pidió nada de eso, solo el número.
- Objetivo: ${effectiveMin}-${effectiveMax} caracteres.${ceiling ? ` No excedas ${ceiling} caracteres bajo ninguna circunstancia (límite del campo: ${maxCharacters}).` : ""}`
    : charWindow.isLimited
      ? `OBJETIVO DE LONGITUD Y MARGEN DE SEGURIDAD PARA ESTE CAMPO PUNTUAL:
- Límite máximo del formulario: ${maxCharacters} caracteres.
- RANGO OBJETIVO DE TU RESPUESTA: Entre ${charWindow.targetMin} y ${charWindow.targetMax} caracteres (debes situarte entre 15% y 18% por debajo del máximo para garantizar que entre holgadamente sin cortes).
- NO excedas ${charWindow.targetMax} caracteres bajo ninguna circunstancia. Termina la idea con punto final dentro de este rango. Nunca termines con puntos suspensivos ("...") ni dejes una frase a medias: si te vas a quedar corto de espacio, cierra la idea antes, no la dejes inconclusa.${questionIntent === "logistics" ? `
- EXCEPCIÓN POR SER UNA PREGUNTA LOGÍSTICA: el mínimo de ${charWindow.targetMin} caracteres NO aplica aquí. El máximo sigue siendo obligatorio, pero puedes quedarte muy por debajo: 1 a 3 frases bastan. No rellenes con logros ni tecnologías para alcanzar el rango.` : ""}`
      : questionIntent === "logistics"
        // Una pregunta logística sin límite de campo NO hereda el mínimo de 350
        // caracteres: obligar a rellenar hasta ahí es exactamente lo que empuja al
        // modelo a pegar logros y stack a una respuesta que solo pedía un dato.
        ? `LONGITUD PARA ESTE CAMPO PUNTUAL: Sé breve — basta con 1 a 3 frases. NO hay mínimo que cumplir: si el dato queda claro en una frase, entrega una frase. Alargar una respuesta logística con material de relleno la empeora. Nunca termines con puntos suspensivos ("...") ni dejes una frase a medias.`
        : `LONGITUD IDEAL PARA ESTE CAMPO PUNTUAL: Redacta una respuesta de alto impacto de entre 350 y 550 caracteres (~60 a 90 palabras), concisa y contundente. Nunca termines con puntos suspensivos ("...") ni dejes una frase a medias.`;

  const systemPrompt = buildSystemPrompt(profile);

  // Bloque ESTABLE: idéntico byte a byte para todas las preguntas de ESTA misma
  // postulación (mismo candidato + misma oferta). Se marca con cache_control
  // para que Anthropic lo cachee tras la primera pregunta del formulario, y las
  // siguientes preguntas del mismo formulario lo lean a ~10% del precio en vez
  // de reprocesar el CV completo y la descripción de la oferta cada vez.
  // Una pregunta logística no lleva CV ni descripción de la oferta: el prompt le
  // prohíbe expresamente usar logros, proyectos y tecnologías, así que enviarlos
  // solo consume tokens. Se conserva el cargo y la empresa, que sí sirven para
  // redactar con naturalidad ("...para incorporarme como Full-Stack en 3IT").
  const isSimpleQuestion = questionIntent === "logistics";

  const stableContextBlock = isSimpleQuestion
    ? `${logisticsContext}

CONTEXTO DE LA OFERTA LABORAL:
- Empresa: ${companyName || "No especificada"}
- Puesto al que postula: ${jobTitle || "No especificado"}`
    : `${candidateContext}

CONTEXTO DE LA OFERTA LABORAL:
- Empresa: ${companyName || "No especificada"}
- Puesto al que postula: ${jobTitle || "No especificado"}
${jobDescription ? `\nDESCRIPCIÓN COMPLETA DE LA OFERTA (úsala para detectar requisitos, tecnologías y responsabilidades específicas del puesto, y conectar la respuesta con ellas cuando encajen con la experiencia real del candidato):\n${jobDescription}` : ""}`;

  // Bloque VARIABLE: cambia en cada pregunta (idioma detectado, ventana de
  // caracteres del campo, la pregunta en sí). Va DESPUÉS del breakpoint de
  // caché — nunca antes, o cada pregunta escribiría una entrada de caché
  // distinta y ninguna se llegaría a leer.
  const variableInstructionBlock = `- Idioma exigido para esta pregunta: ${isEnglish ? "ENGLISH" : "ESPAÑOL"}
${floor
  ? `- Longitud requerida: entre ${effectiveMin} y ${effectiveMax} caracteres (mínimo obligatorio del formulario: ${floor}${ceiling ? `, máximo: ${maxCharacters}` : ""})`
  : isAmountQuestion
    ? `- Longitud requerida: entre ${effectiveMin} y ${effectiveMax} caracteres (esta pregunta pide solo una cifra, no una respuesta redactada)`
    : charWindow.isLimited
      ? `- Longitud requerida: entre ${effectiveMin} y ${effectiveMax} caracteres (límite máximo del campo: ${maxCharacters})`
      : ""}
${languageRule}
${lengthRule}

${intentRule}
${mustCoverRule}
${antiRepetitionRule}

PREGUNTA DEL FORMULARIO DE POSTULACIÓN:
"${question}"

Antes de escribir, verifica: ¿tu respuesta contesta ESTA pregunta puntual y no otra? Si la respuesta que ibas a dar encajaría igual de bien en otra pregunta del formulario, no está respondiendo esta.

${isEnglish ? `Generate an exceptional, persuasive, and directly focused answer in ENGLISH for this application question (target: ${effectiveMin}-${effectiveMax} characters):` : `Genera una respuesta excepcional, persuasiva y directamente enfocada en ESPAÑOL para esta pregunta (objetivo: ${effectiveMin}-${effectiveMax} caracteres):`}`;

  // Enrutado por complejidad: una pregunta logística es una consulta de datos
  // ("¿disponibilidad?" → un campo del perfil, dos frases), no un ejercicio de
  // redacción persuasiva. Ahí Haiku 4.5 da el mismo resultado por una fracción
  // del coste. Las preguntas de experiencia y motivación se quedan en Sonnet:
  // son las que deciden si te llaman a entrevista, y ahorrar ahí sale caro.
  const modelToUse = isSimpleQuestion ? MODEL_SIMPLE : MODEL_COMPLEX;

  // Margen holgado: la longitud final se recorta después con charWindow, así que
  // un presupuesto ajustado solo consigue truncar la respuesta a medias.
  const tokensToUse = charWindow.isLimited
    ? Math.min(1200, Math.max(300, Math.ceil(charWindow.targetMax / 1.8)))
    : 800;

  // El caché de Anthropic exige un mínimo de tokens por bloque; por debajo, la
  // marca se ignora sin avisar. El bloque logístico es pequeño a propósito, así
  // que marcarlo no aportaría nada y además pagaría el recargo de escritura de
  // caché en la primera llamada.
  const CACHE_MIN_CHARS = 4000;
  const stableBlock = { type: "text", text: stableContextBlock };
  if (stableContextBlock.length >= CACHE_MIN_CHARS) {
    stableBlock.cache_control = { type: "ephemeral" };
  }

  console.log(`[JobFill AI] Tipo: ${questionIntent} → modelo: ${modelToUse} | contexto: ${stableContextBlock.length} car.${stableBlock.cache_control ? " (cacheado)" : ""}`);

  const data = await callAnthropicMessagesApi({
    ai,
    model: modelToUse,
    max_tokens: tokensToUse,
    // "system" como array de bloques: permite marcar cache_control en el único
    // bloque, que además es 100% estático (no lleva idioma/longitud/pregunta),
    // así que se reutiliza entre TODAS las llamadas de este usuario, no solo
    // dentro de una misma postulación.
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: [stableBlock, { type: "text", text: variableInstructionBlock }]
    }]
  });

  let answer = extractTextFromResponse(data);

  if (!answer) {
    throw new Error("Claude devolvió una respuesta vacía. Revisa la consola del service worker para ver los bloques recibidos.");
  }

  // Respaldo mecánico: la regla 4 le prohíbe usar Markdown, pero una
  // instrucción en el prompt no es una garantía — si igual se cuela
  // "**negrita**" o un encabezado "# ", el campo de destino es texto plano y
  // esos símbolos quedarían literales, asteriscos y todo, delante del
  // reclutador. Se limpia la sintaxis más común sin tocar el texto real.
  answer = stripMarkdownFormatting(answer);

  // Enforce boundary safety: if answer exceeds targetMax, trim cleanly at last period.
  // NUNCA dejar "..." colgando: en una respuesta de postulación laboral se lee como
  // una idea cortada a medias, no como una elección de estilo. Si no hay un punto
  // final cercano, se cierra la última cláusula con un punto en vez de puntos
  // suspensivos — se pierde algo de idea, pero la respuesta se ve terminada.
  const limitToEnforce = charWindow.isLimited ? charWindow.targetMax : null;
  if (limitToEnforce && answer.length > limitToEnforce) {
    answer = closeSentenceCleanly(answer, limitToEnforce);
  }

  // Cobertura de requisitos: se calcula sobre la respuesta YA recortada, que es
  // la que el reclutador leerá — un término que solo aparecía en el fragmento
  // truncado no cuenta como cubierto.
  //
  // Las preguntas logísticas se excluyen: su respuesta correcta es un dato breve
  // sin tecnologías, así que medir cobertura ahí solo produciría avisos que
  // empujan a arruinarla metiendo stack donde no corresponde.
  const coverage = questionIntent === "logistics"
    ? { omitted: [], unbacked: [] }
    : analyzeRequirementCoverage({
        profileTerms: collectProfileTerms(p),
        jobDescription,
        answer
      });

  // Lo ya confirmado en esta ronda no vuelve a preguntarse.
  coverage.unbacked = coverage.unbacked.filter(
    term => !confirmedTerms.some(c => c.toLowerCase() === term.toLowerCase())
  );

  return { success: true, answer, coverage, ...providerInfo(data) };
}

/**
 * Responde TODAS las preguntas detectadas en el formulario con una sola
 * llamada a Anthropic. Simplificaciones frente al modo de una pregunta:
 * un solo modelo (Sonnet) para todo el lote, intent solo por palabra clave
 * (sin respaldo de IA por pregunta, para no reintroducir la iteración de
 * llamadas), y mustCover compartido por todo el formulario.
 */
async function handleClaudeGenerationBatch({ items: rawItems, jobTitle, companyName, jobDescription, mustCover }) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw new Error("No hay preguntas para responder.");
  }

  // Tope propio, además del que ya aplica el content script: este handler
  // recibe un payload de otro contexto y no debe confiar en que venga
  // acotado. Sin esto, un lote inesperadamente grande se traduce en una sola
  // llamada carísima que nadie pidió.
  const MAX_BATCH_ITEMS = 12;
  const items = rawItems
    .filter(item => item && typeof item.id === "string" && typeof item.question === "string" && item.question.trim())
    .slice(0, MAX_BATCH_ITEMS);

  if (!items.length) {
    throw new Error("El lote no traía ninguna pregunta válida.");
  }

  const profile = await chrome.storage.local.get(null);
  const ai = JobFillAi.readAiSettings(profile);
  const aiProblem = JobFillAi.aiSettingsProblem(ai);
  if (aiProblem) throw new Error(aiProblem);

  const { p, hasRealCandidateData, candidateContext } =
    resolveCandidateContext(profile, jobTitle, jobDescription);

  if (!hasRealCandidateData) {
    throw new Error("Tu perfil no tiene experiencia, proyectos ni CV cargados todavía. Complétalo en las opciones de JobFill AI antes de generar respuestas.");
  }

  const confirmedTerms = Array.isArray(mustCover)
    ? mustCover.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()).slice(0, 12)
    : [];
  const mustCoverRule = confirmedTerms.length
    ? `\nEXPERIENCIA CONFIRMADA POR EL CANDIDATO PARA ESTE FORMULARIO:\n${confirmedTerms.map(t => `- ${t}`).join("\n")}\nTrátalos como CIERTOS e inclúyelos donde vengan al caso en cualquiera de las respuestas (no en todas). No inventes detalles a su alrededor.`
    : "";

  const INTENT_LABELS = {
    logistics: "DATO PUNTUAL (logística/condiciones/credencial académica): responde el dato en la primera frase, sin métricas ni stack, 1-3 frases si no hay mínimo.",
    motivation: "MOTIVACIÓN/INTERÉS: conecta la oferta con la trayectoria real, sin halagos genéricos.",
    experience: "EXPERIENCIA/CAPACIDAD TÉCNICA: responde el objeto exacto de la pregunta con un solo hilo central."
  };

  const questionBlocks = items.map(item => {
    const isEnglish = detectQuestionLanguage(item.question) === "en";
    const questionIntent = classifyQuestionIntent(item.question).intent || "experience";
    const charWindow = calculateTargetCharacterWindow(item.maxCharacters);
    const floor = item.minCharacters || null;
    const ceiling = charWindow.isLimited ? charWindow.targetMax : null;
    const effectiveMin = floor ? floor + 80 : (charWindow.isLimited ? charWindow.targetMin : 350);
    const effectiveMax = floor ? Math.min(floor + 400, ceiling || floor + 400) : (charWindow.isLimited ? charWindow.targetMax : 550);

    return `[PREGUNTA id="${item.id}"]
Texto: "${item.question}"
Idioma exigido: ${isEnglish ? "ENGLISH" : "ESPAÑOL"}
Tipo: ${INTENT_LABELS[questionIntent]}
Longitud objetivo: entre ${effectiveMin} y ${effectiveMax} caracteres${ceiling ? ` (máximo absoluto del campo: ${item.maxCharacters})` : ""}`;
  }).join("\n\n");

  const BATCH_JSON_RULE = `13. FORMATO DE SALIDA DE ESTE MODO AGRUPADO: el mensaje del usuario trae VARIAS preguntas del MISMO formulario, cada una con su id, idioma y longitud objetivo. Responde con un único objeto JSON, sin texto antes ni después ni bloque \`\`\`, exactamente: {"answers":[{"id":"<id tal cual se dio>","answer":"<texto plano>"}]}. Un elemento por pregunta, en cualquier orden. Cada "answer" sigue todas las reglas anteriores para SU propia pregunta. Diferénciate en la forma entre respuestas del mismo lote.`;

  const systemPrompt = buildSystemPrompt(profile, BATCH_JSON_RULE);
  const stableBlock = { type: "text", text: `${candidateContext}\n\nCONTEXTO DE LA OFERTA LABORAL:\n- Empresa: ${companyName || "No especificada"}\n- Puesto al que postula: ${jobTitle || "No especificado"}${jobDescription ? `\n\nDESCRIPCIÓN COMPLETA DE LA OFERTA:\n${jobDescription}` : ""}` };
  const userBlock = { type: "text", text: `${mustCoverRule}\n\nPREGUNTAS DE ESTE FORMULARIO (respóndelas TODAS):\n\n${questionBlocks}` };

  const tokensToUse = Math.min(8000, Math.max(1200, items.reduce((sum, item) => {
    const w = calculateTargetCharacterWindow(item.maxCharacters);
    return sum + Math.ceil((w.isLimited ? w.targetMax : 550) / 1.8) + 120;
  }, 0)));

  console.log(`[JobFill AI] Lote de ${items.length} preguntas -> modelo: ${MODEL_COMPLEX}`);

  const data = await callAnthropicMessagesApi({
    ai,
    model: MODEL_COMPLEX,
    max_tokens: tokensToUse,
    system: [{ type: "text", text: systemPrompt }],
    messages: [{ role: "user", content: [stableBlock, userBlock] }]
  });

  const rawText = extractTextFromResponse(data);
  if (!rawText) throw new Error("Claude devolvió una respuesta vacía para el lote de preguntas.");

  let parsed;
  try {
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("[JobFill AI] No se pudo parsear la respuesta agrupada:", rawText);
    throw new Error("Claude no devolvió el formato esperado para el lote. Intenta responder las preguntas de a una.");
  }

  const answersById = new Map(
    (Array.isArray(parsed?.answers) ? parsed.answers : [])
      .filter(a => a && typeof a.id === "string" && typeof a.answer === "string")
      .map(a => [a.id, stripMarkdownFormatting(a.answer)])
  );

  const results = items.map(item => {
    let answer = answersById.get(item.id) || "";
    const w = calculateTargetCharacterWindow(item.maxCharacters);
    const limitToEnforce = w.isLimited ? w.targetMax : null;
    if (answer && limitToEnforce && answer.length > limitToEnforce) {
      answer = closeSentenceCleanly(answer, limitToEnforce);
    }
    return { id: item.id, answer };
  });

  if (results.every(r => !r.answer)) {
    throw new Error("Claude no devolvió respuesta para ninguna de las preguntas del lote.");
  }

  const coverage = analyzeRequirementCoverage({
    profileTerms: collectProfileTerms(p),
    jobDescription,
    answer: results.map(r => r.answer).join("\n")
  });
  coverage.unbacked = coverage.unbacked.filter(
    term => !confirmedTerms.some(c => c.toLowerCase() === term.toLowerCase())
  );

  return { success: true, results, coverage, missingIds: results.filter(r => !r.answer).map(r => r.id), ...providerInfo(data) };
}
