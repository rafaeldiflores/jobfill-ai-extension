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

  root.JobFillPortals = {
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
