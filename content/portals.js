/**
 * JobFill AI - Compatibilidad con portales de empleo (ATS).
 *
 * Todo lo que depende de CÓMO arma cada portal su formulario vive aquí, para
 * que autofill.js no crezca con casos por portal:
 *
 *  - Qué campo es el del CV: selectores conocidos por ATS + nombres de
 *    atributo (id/name/data-*) + texto de la etiqueta, con un puntaje.
 *  - Zonas de "arrastra tu CV aquí" que no exponen un <input type=file>.
 *  - Búsqueda que entra en Shadow DOM abierto (SuccessFactors/UI5,
 *    SmartRecruiters y otros formularios con web components).
 *
 * Los iframes (Greenhouse/Workable/iCIMS/Indeed embebidos en el sitio de la
 * empresa) no se resuelven aquí: el content script corre en cada frame
 * (`all_frames`) y el service worker elige el frame con mejor puntaje.
 *
 * Se carga ANTES de autofill.js en el mismo mundo aislado. Las funciones de
 * puntaje son puras (texto → número) para poder probarlas sin DOM.
 */
(function (root) {
  "use strict";

  /**
   * Selectores del campo del CV por portal. Un match aquí es la señal más
   * fuerte: el portal nombra el campo así en todas sus ofertas.
   * Fuentes: DOM de cada ATS según extensiones open source que los
   * mantienen (job_app_filler, Autofill-Jobs) y la documentación pública
   * de sus formularios embebibles.
   */
  const PORTAL_CV_SELECTORS = [
    // Greenhouse (boards clásico y job-boards React)
    "input#resume", "input[name='resume']", "#resume_fieldset input[type='file']",
    "[data-field='resume'] input[type='file']", ".file-upload input[id*='resume' i]",
    // Lever
    "input#resume-upload-input", "input[name='resume'][type='file']",
    // Workday (paso "Mi experiencia" y "Autocompletar con CV")
    "input[data-automation-id='file-upload-input-ref']",
    // Ashby
    "input#_systemfield_resume", "[id*='systemfield_resume' i] input[type='file']",
    // LinkedIn Easy Apply
    "input[id*='jobs-document-upload-file-input-upload-resume']", "input[id*='upload-resume' i]",
    // Workable
    "[data-ui='resume'] input[type='file']", "input[data-ui='resume']",
    // SmartRecruiters / Teamtailor / Recruitee / Personio / BambooHR
    "input[name='candidate[resume]']", "input[name*='resume' i][type='file']",
    "input[name*='curriculum' i][type='file']", "input[name='cv'][type='file']",
    "input[data-testid*='resume' i][type='file']", "input[data-test*='resume' i][type='file']"
  ];

  /**
   * Zonas de soltar archivo. Casi siempre traen un <input type=file> oculto
   * adentro (y se usa ese); el drop sintético es solo para las que no.
   */
  const DROPZONE_SELECTOR = [
    "[data-automation-id='file-upload-drop-zone']", // Workday
    ".drop-zone", "[class*='dropzone' i]", "[class*='drop-zone' i]", "[class*='drop_zone' i]",
    "[data-testid*='dropzone' i]", "[data-ui*='dropzone' i]", "[class*='file-drop' i]", "[class*='filedrop' i]"
  ].join(", ");

  // Bordes explícitos en vez de \b, que no funciona junto a letras con
  // tilde ("Résumé"). El "(?![a-z])" final deja fuera "resumen" (español).
  const CV_TEXT_RE = /(?:^|[^a-z0-9])(cv|c\.v\.|curr[ií]cul[a-zá-ú]*|resume|r[ée]sum[ée]|hoja de vida)(?![a-z])/i;
  const NOT_CV_TEXT_RE = /(carta|cover|motivaci|foto|photo|imagen|image|avatar|portafolio|portfolio|certificad|t[ií]tulo|diploma|transcript|licencia|referencia|recommendation)/i;
  const CV_ATTR_TOKENS = new Set(["cv", "resume", "curriculum", "curriculo", "curriculumvitae", "resumefile", "cvfile", "uploadresume"]);

  /** Tokens de un atributo: "candidate[resume]" → ["candidate", "resume"]. */
  function attrTokens(value) {
    return String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function acceptsPdf(accept) {
    return !accept || /pdf|application\/\*|\*\/\*|\.doc/i.test(accept);
  }

  /**
   * Puntaje de "este campo es el del CV", a partir de su texto. 0 = no es.
   *   100 selector propio del portal · 80 atributo (id/name/data-*)
   *    60 etiqueta o texto cercano · 15 campo neutro que acepta PDF
   * Un campo con texto de carta/foto/certificado queda en 0 aunque el
   * contenedor mencione el CV (el bloque "Documentos" suele listar ambos).
   */
  function scoreCvCandidate({ portalMatch = false, attrs = "", label = "", accept = "" } = {}) {
    if (!acceptsPdf(accept)) return 0;
    const tokens = attrTokens(attrs);
    const attrIsCv = tokens.some(t => CV_ATTR_TOKENS.has(t));
    const attrNotCv = NOT_CV_TEXT_RE.test(attrs);
    // Con ambos términos en la etiqueta gana el que aparece primero:
    // "Carta de presentación (adjunta aparte del CV)" es la carta;
    // "CV en PDF, sin foto" es el CV.
    const labelText = String(label);
    const cvAt = labelText.search(CV_TEXT_RE);
    const notAt = labelText.search(NOT_CV_TEXT_RE);

    if (attrNotCv && !attrIsCv) return 0;
    if (portalMatch) return 100;
    if (attrIsCv) return 80;
    if (cvAt !== -1 && (notAt === -1 || cvAt < notAt)) return 60;
    if (notAt !== -1) return 0;
    return 15;
  }

  /**
   * querySelectorAll que también entra en Shadow DOM abierto. `skip(el)`
   * excluye subárboles (los hosts de la propia extensión).
   */
  function deepQuerySelectorAll(selector, rootNode = document, skip = () => false) {
    const out = [];
    const visit = node => {
      for (const el of node.querySelectorAll(selector)) if (!skip(el)) out.push(el);
      for (const host of node.querySelectorAll("*")) {
        if (host.shadowRoot && !skip(host)) visit(host.shadowRoot);
      }
    };
    visit(rootNode);
    return out;
  }

  /** Portal por hostname, para mensajes y diagnóstico (no decide nada crítico). */
  function detectPortal(hostname = "") {
    const h = String(hostname).toLowerCase();
    const known = [
      ["greenhouse", /greenhouse\.io$/], ["lever", /lever\.co$/], ["workday", /myworkdayjobs\.com$|workday\.com$/],
      ["ashby", /ashbyhq\.com$/], ["linkedin", /linkedin\.com$/], ["workable", /workable\.com$/],
      ["smartrecruiters", /smartrecruiters\.com$/], ["teamtailor", /teamtailor\.com$/], ["bamboohr", /bamboohr\.com$/],
      ["icims", /icims\.com$/], ["taleo", /taleo\.net$/], ["successfactors", /successfactors\.(com|eu)$|sapsf\./],
      ["recruitee", /recruitee\.com$/], ["personio", /personio\.(de|com)$/], ["indeed", /indeed\.com$/],
      ["getonbrd", /getonbrd\.com$/], ["computrabajo", /computrabajo\.com$/], ["laborum", /laborum\.cl$/],
      ["bumeran", /bumeran\.com/], ["trabajando", /trabajando\.(cl|com)$/], ["buk", /buk\.(cl|co|pe|mx)$/],
      ["hiringroom", /hiringroom\.com$/], ["zoho", /zohorecruit\.com$/], ["jobvite", /jobvite\.com$/]
    ];
    return (known.find(([, re]) => re.test(h)) || [""])[0];
  }

  /**
   * Elige en qué frame adjuntar el CV, a partir del sondeo de cada uno
   * ([{ frameId, result: { score, total, filled, reason } }]). Lo usa el
   * service worker.
   *   - Un frame con un campo identificado como CV (≥ 60) gana; el de mayor
   *     puntaje, y el principal si empatan.
   *   - Un campo neutro solo vale si es el único campo de archivo de TODA
   *     la pestaña.
   *   - Sin ningún campo de archivo en la pestaña → `pending`: es un
   *     formulario de varios pasos y el campo aparecerá más adelante.
   */
  function pickCvFrame(probes) {
    const list = (probes || []).filter(p => p && p.result);
    const total = list.reduce((n, p) => n + (p.result.total || 0), 0);
    const ranked = list.filter(p => p.result.score > 0)
      .sort((a, b) => b.result.score - a.result.score || a.frameId - b.frameId);
    const best = ranked[0];
    if (best && (best.result.score >= 60 || (total === 1 && ranked.length === 1))) {
      return { frameId: best.frameId };
    }
    if (total === 0) return { frameId: null, pending: true, reason: "todavía no aparece el campo para subir el CV" };
    const filled = list.find(p => p.result.filled);
    return { frameId: null, reason: filled ? filled.result.reason : "no se identificó con certeza cuál es el campo del CV" };
  }

  /* ─── Opciones de listas (select nativo y dropdowns personalizados) ─── */

  function normOption(text) {
    return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[\u200b\u00a0]/g, " ").replace(/[^a-z0-9+#.\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  /**
   * Texto de "todavía no eligió nada": "Select...", "Seleccione", "-- Elige --",
   * "Choose one", "Please select". También vacío. Es la opción 0 de casi
   * todos los <select> y el texto de un dropdown personalizado sin valor.
   */
  const PLACEHOLDER_RE = /^(?:-+\s*)?(?:select|seleccion|selecciona|seleccione|elige|elija|escoge|choose|pick|please select|por favor|none selected|ninguno seleccionado|opcion|option)\b|^-+$|^\.{3}$/i;

  function isPlaceholderOption(text) {
    const n = normOption(text);
    return !n || PLACEHOLDER_RE.test(n) || PLACEHOLDER_RE.test(String(text || "").trim());
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Índice de la opción que corresponde a `target`, o -1. Nunca elige un
   * placeholder. Orden de confianza:
   *   1. igual (texto o value) · 2. contiene / contenido, como palabra y luego
   *   como texto (4+ letras)
   *   3. nivel CEFR (B2) · 4. más palabras en común (mínimo 1)
   * `options` es [{ text, value }] o una lista de textos.
   */
  function pickOptionIndex(options, target) {
    const opts = (options || []).map(o => (typeof o === "string" ? { text: o, value: "" } : { text: o.text || "", value: o.value || "" }));
    const t = normOption(target);
    if (!t) return -1;
    const usable = opts.map((o, i) => ({ i, text: normOption(o.text), value: normOption(o.value), raw: o.text }))
      .filter(o => !isPlaceholderOption(o.raw) && (o.text || o.value));

    let hit = usable.find(o => o.text === t || (o.value && o.value === t));
    if (hit) return hit.i;

    const wordIn = (needle, hay) => needle.length > 1 && new RegExp(`(?:^|\\s)${escapeRe(needle)}(?:\\s|$)`).test(hay);
    hit = usable.find(o => o.text && (wordIn(t, o.text) || wordIn(o.text, t)));
    if (hit) return hit.i;

    // Contiene sin límite de palabra ("Chile" ⊂ "Chilean"), solo con 4+ letras.
    hit = usable.find(o => o.text && ((t.length >= 4 && o.text.includes(t)) || (o.text.length >= 4 && t.includes(o.text))));
    if (hit) return hit.i;

    const cefr = String(target).match(/\b([ABC][12])\b/i);
    if (cefr) {
      hit = usable.find(o => new RegExp(`\\b${cefr[1]}\\b`, "i").test(`${o.text} ${o.value}`));
      if (hit) return hit.i;
    }

    const words = t.split(" ").filter(w => w.length > 2);
    let best = -1, bestScore = 0;
    for (const o of usable) {
      const hay = ` ${o.text} ${o.value} `;
      const score = words.filter(w => hay.includes(` ${w} `)).length;
      if (score > bestScore) { bestScore = score; best = o.i; }
    }
    return best;
  }

  /** Índice de la opción cuyo texto es una de las variantes (palabra completa): "Sí"/"Yes" para yes. */
  function pickVariantIndex(options, variants) {
    const texts = (options || []).map(o => normOption(typeof o === "string" ? o : `${o.text || ""} ${o.value || ""}`));
    return texts.findIndex((text, i) => {
      const raw = typeof options[i] === "string" ? options[i] : options[i].text;
      if (isPlaceholderOption(raw)) return false;
      return variants.some(v => new RegExp(`(?:^|\\s)${escapeRe(normOption(v))}(?:\\s|$)`).test(text));
    });
  }

  /**
   * Nombre de empresa limpio. El elemento de la empresa en LinkedIn y otros
   * portales trae pegado el botón "Follow"/"Seguir", la fecha y "Last replied
   * to candidates…"; al aplanar el texto quedaba "3IT Follow August 31, 2026
   * Last replied to candidates about 4 hours ago" y eso llegaba al CV y al
   * Tracker. Se corta en el primer marcador de ese ruido.
   */
  const COMPANY_NOISE_RE = new RegExp([
    "\\s+(?:follow|following|seguir|siguiendo)\\b",
    "\\s+(?:posted|reposted|publicad[oa]|last replied|actively|responds?|hace\\s+\\d|\\d+\\s+(?:minutes?|hours?|days?|weeks?|months?)\\s+ago)\\b",
    "\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\\s+\\d{1,2}\\b",
    "\\s+\\d{1,2}\\s+de\\s+[a-záéíóú]+\\s+de\\s+\\d{4}",
    "\\s+[·•|]\\s+",
    "\\s+\\d[\\d.,]*\\s*(?:followers|seguidores|employees|empleados)\\b"
  ].join("|"), "i");

  function cleanCompanyName(text) {
    const first = String(text || "").split(/\n/).map(l => l.trim()).find(Boolean) || "";
    const cut = first.search(COMPANY_NOISE_RE);
    return (cut > 0 ? first.slice(0, cut) : first).replace(/\s+/g, " ").trim().slice(0, 80);
  }

  /**
   * Valor para un <input type="number">, o null si no hay uno sensato.
   * Chrome rechaza cualquier texto no numérico ("The specified value
   * '19974960-9' cannot be parsed") y el campo queda vacío en silencio:
   *   - RUT "19.974.960-9" → "19974960" (el cuerpo: un campo numérico no
   *     puede llevar el dígito verificador, que puede ser K),
   *   - teléfono "+56 9 1234 5678" → "56912345678",
   *   - "3,5" → "3.5"; "$1.200.000" → "1200000",
   *   - texto sin número ("No especificado") → null: no se toca el campo.
   * Respeta min/max del campo.
   */
  function toNumberInputValue(value, { min, max } = {}) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    let out = null;
    const rut = raw.match(/^(\d{1,2}(?:\.?\d{3}){2})-?[\dkK]$/);
    if (rut && /[-.]|[kK]$/.test(raw)) out = rut[1].replace(/\./g, "");
    else if (/^-?\d+(?:[.,]\d+)?$/.test(raw)) out = raw.replace(",", ".");
    else if (/^[\s$+()\d.\-]+$/.test(raw) && /\d/.test(raw)) out = raw.replace(/\D/g, "");
    if (out === null || out === "") return null;
    const n = Number(out);
    if (!Number.isFinite(n)) return null;
    if (min !== undefined && min !== "" && n < Number(min)) return null;
    if (max !== undefined && max !== "" && n > Number(max)) return null;
    return out;
  }

  root.JobFillPortals = {
    toNumberInputValue,
    cleanCompanyName,
    PLACEHOLDER_RE,
    isPlaceholderOption,
    pickOptionIndex,
    pickVariantIndex,
    pickCvFrame,
    PORTAL_CV_SELECTORS,
    DROPZONE_SELECTOR,
    attrTokens,
    acceptsPdf,
    scoreCvCandidate,
    deepQuerySelectorAll,
    detectPortal
  };
})(typeof self !== "undefined" ? self : globalThis);
