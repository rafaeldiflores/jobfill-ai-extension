/**
 * JobFill AI - Options Script
 */

/**
 * Extrae el texto de una respuesta de la Messages API de Anthropic.
 *
 * NUNCA asumir que content[0] es el bloque de texto: si el modelo razona, los
 * primeros bloques son de tipo "thinking" y content[0].text es undefined.
 */
/**
 * Escapa un valor del usuario antes de meterlo en un template de innerHTML.
 * Las tarjetas de Q&A, campos flexibles, cargos y proyectos se arman con
 * `value="${...}"` y `<textarea>${...}</textarea>`: sin escapar, un valor con
 * comillas (`Proyecto "MAZA"`) cortaba el atributo y el resto se PERDÍA al
 * guardar, y un `</textarea>` en una respuesta rompía la tarjeta entera.
 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function extractClaudeText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter(b => b?.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("")
    .trim();
}

/**
 * Ajustes GLOBALES de la extensión: valen para todos los perfiles y viven en la
 * raíz de chrome.storage.local, no dentro de `profiles[]`. Se excluyen al leer y
 * escribir el perfil activo; si alguno se colara, cada perfil guardaría su
 * propia copia de un ajuste que no le pertenece (y un checkbox entraría además
 * como la cadena "on" que FormData produce, no como booleano).
 */
const GLOBAL_SETTING_KEYS = [
  "aiProvider",
  "claudeApiKey",
  "vertexApiKey",
  "aiFallbackToGemini",
  "claudeModel",
  "claudeModelSimple",
  "aiTone",
  "customAiInstructions",
  "confirmQuestionBeforeAi",
  "notifyJobCapture"
];

/**
 * Rediseño de datos: `profiles[]` (identidad completa duplicada por perfil,
 * más un "espejo" que copiaba el perfil activo a la raíz de storage en cada
 * guardado) se reemplaza por `candidateBase` (única) + `cvIndexes` (solo la
 * faceta: nombre, keywords, título objetivo). El resto de este archivo sigue
 * operando sobre objetos "con forma de perfil completo" — CERO cambios en la
 * UI ni en `loadActiveProfileIntoDOM`/`saveActiveProfileFromDOM`/el parseo de
 * CV — estas dos funciones son el único puente hacia/desde el esquema real.
 */
const CV_INDEX_OWN_FIELDS = ["id", "name", "targetRole", "keywords"];

/** Etiquetas legibles de los campos que se pueden completar desde un .md. */
const MD_FIELD_LABELS = {
  fullName: "Nombre completo", firstName: "Nombre", middleName: "Segundo nombre", lastName: "Apellidos",
  lastNamePaternal: "Apellido paterno", lastNameMaternal: "Apellido materno", email: "Email", phone: "Teléfono",
  linkedinUrl: "LinkedIn", githubUrl: "GitHub", portfolioUrl: "Portafolio", city: "Ciudad", country: "País",
  englishLevel: "Nivel de inglés", noticePeriod: "Disponibilidad", degree: "Título", university: "Institución",
  skills: "Habilidades"
};

/** Credenciales que nunca salen ni entran por un archivo de respaldo. */
const BACKUP_EXCLUDED_KEYS = ["claudeApiKey", "vertexApiKey", "vertexProjectId", "vertexRegion"];

/** `candidateBase` + cada `cvIndexes[]` → un array de objetos "con forma de perfil". */
function profilesFromCandidateData(candidateBase, cvIndexes) {
  const base = candidateBase || {};
  const list = Array.isArray(cvIndexes) && cvIndexes.length ? cvIndexes : [{ id: "idx_default", area: "Perfil Principal", keywords: "", targetRole: "" }];
  return list.map(idx => ({
    ...base,
    id: idx.id,
    name: idx.area,
    targetRole: idx.targetRole || "",
    keywords: idx.keywords || ""
  }));
}

/** El inverso: separa `localProfiles` (forma vieja) en candidateBase + cvIndexes. */
function candidateDataFromProfiles(localProfiles, activeProfileId) {
  const active = localProfiles.find(p => p.id === activeProfileId) || localProfiles[0] || {};

  // Se derivan de CV_INDEX_OWN_FIELDS en vez de destructurarlos a mano: con
  // dos listas separadas, agregar un campo propio del índice a una y olvidarla
  // en la otra lo dejaría filtrándose a `candidateBase` (compartido entre
  // todos los índices) sin que nada lo avise.
  const candidateBase = {};
  Object.keys(active).forEach(k => {
    if (!CV_INDEX_OWN_FIELDS.includes(k)) candidateBase[k] = active[k];
  });

  const cvIndexes = localProfiles.map(p => ({
    id: p.id,
    area: p.name || p.targetRole || "Perfil",
    keywords: p.keywords || "",
    targetRole: p.targetRole || p.headline || ""
  }));

  return { candidateBase, cvIndexes, activeCvIndexId: activeProfileId, schemaVersion: 2 };
}

/**
 * Los campos compartidos (todo salvo `CV_INDEX_OWN_FIELDS`) deben ser
 * IDÉNTICOS en cada objeto de `localProfiles`, porque en el esquema real hay
 * un solo `candidateBase`. Sin este paso, editar el email con el índice
 * "Backend" activo y luego cambiar a "Frontend" mostraría el email VIEJO —
 * cada entrada en memoria todavía carga su propia copia de cuando se leyeron.
 * Se llama justo después de `saveActiveProfileFromDOM()`, antes de cualquier
 * cambio de índice o guardado.
 */
function syncSharedFieldsAcrossProfiles(source, allProfiles) {
  // Los llamadores pasan `localProfiles.find(...)`, que devuelve undefined si
  // el id activo quedó desincronizado del array (p. ej. tras eliminar un
  // índice). Sin esta guarda, `Object.keys(undefined)` reventaría el guardado
  // entero por un caso de borde recuperable.
  if (!source) return;

  const shared = {};
  Object.keys(source).forEach(k => {
    if (!CV_INDEX_OWN_FIELDS.includes(k)) shared[k] = source[k];
  });
  allProfiles.forEach(p => { if (p !== source) Object.assign(p, shared); });
}

document.addEventListener("DOMContentLoaded", async () => {
  const profileForm = document.getElementById("profileForm");
  const saveStatus = document.getElementById("saveStatus");
  const tabTitle = document.getElementById("tabTitle");
  const navItems = document.querySelectorAll(".nav-item");
  const tabPanels = document.querySelectorAll(".tab-panel");
  const btnToggleKey = document.getElementById("btnToggleKey");
  const btnTestClaude = document.getElementById("btnTestClaude");
  const claudeTestResult = document.getElementById("claudeTestResult");
  const claudeApiKeyInput = document.getElementById("claudeApiKey");
  const aiProviderSelect = document.getElementById("aiProvider");
  const vertexApiKeyInput = document.getElementById("vertexApiKey");
  const btnToggleVertexKey = document.getElementById("btnToggleVertexKey");
  const aiFallbackCheckbox = document.getElementById("aiFallbackToGemini");
  const geminiFallbackGroup = document.getElementById("geminiFallbackGroup");

  /**
   * Ajustes de IA tal como están AHORA en los inputs (aunque no se hayan
   * guardado): "Probar Conexión" y "Estructurar CV" deben usar lo que el
   * usuario acaba de escribir, no lo último guardado.
   */
  function aiSettingsFromDOM() {
    return JobFillAi.readAiSettings({
      aiProvider: aiProviderSelect?.value,
      claudeApiKey: claudeApiKeyInput?.value,
      vertexApiKey: vertexApiKeyInput?.value,
      aiFallbackToGemini: aiFallbackCheckbox ? aiFallbackCheckbox.checked : true
    });
  }

  /** El respaldo con Gemini solo tiene sentido cuando Claude es el principal. */
  function syncProviderFields() {
    if (geminiFallbackGroup) geminiFallbackGroup.hidden = aiProviderSelect?.value === "gemini";
  }
  aiProviderSelect?.addEventListener("change", () => {
    syncProviderFields();
    claudeTestResult.className = "api-test-badge";
  });
  const btnAddQa = document.getElementById("btnAddQa");
  const qaList = document.getElementById("qaList");
  const btnAddCustomField = document.getElementById("btnAddCustomField");
  const customFieldsList = document.getElementById("customFieldsList");
  const btnExportJson = document.getElementById("btnExportJson");
  const btnImportJson = document.getElementById("btnImportJson");
  const importFileInput = document.getElementById("importFileInput");

  // Global Master Profile Elements
  const globalProfileSelect = document.getElementById("globalProfileSelect");
  const btnGlobalNewProfile = document.getElementById("btnGlobalNewProfile");
  const btnGlobalRenameProfile = document.getElementById("btnGlobalRenameProfile");
  const btnGlobalDeleteProfile = document.getElementById("btnGlobalDeleteProfile");

  // CV Specific Elements
  const profileTargetRoleInput = document.getElementById("profileTargetRole");
  const profileKeywordsInput = document.getElementById("profileKeywords");
  const btnUploadCvFile = document.getElementById("btnUploadCvFile");
  const cvFileInput = document.getElementById("cvFileInput");
  const resumeTextInput = document.getElementById("resumeText");
  const btnParseCvToDb = document.getElementById("btnParseCvToDb");
  const cvParseStatus = document.getElementById("cvParseStatus");
  const cvDbStatsBadge = document.getElementById("cvDbStatsBadge");
  const btnAddCvExp = document.getElementById("btnAddCvExp");
  const btnAddCvProj = document.getElementById("btnAddCvProj");
  const cvExperiencesList = document.getElementById("cvExperiencesList");
  const cvProjectsList = document.getElementById("cvProjectsList");

  // Progress Bar Elements
  const cvProgressBarContainer = document.getElementById("cvProgressBarContainer");
  const cvProgressStepText = document.getElementById("cvProgressStepText");
  const cvProgressPercentage = document.getElementById("cvProgressPercentage");
  const cvProgressFill = document.getElementById("cvProgressFill");

  let localMarkdownSources = [];
  let localProfiles = [];
  let activeProfileId = "prof_default";
  let localQA = [];
  let localCustomFields = [];
  let localCvDatabase = { rawText: "", experiences: [], projects: [], education: [] };
  let progressInterval = null;

  // Tab switching
  navItems.forEach(item => {
    item.addEventListener("click", () => {
      navItems.forEach(i => i.classList.remove("active"));
      tabPanels.forEach(p => p.classList.remove("active"));

      item.classList.add("active");
      // Un ítem puede mostrar VARIAS secciones apiladas ("Mis datos" agrupa
      // contacto, redes, experiencia, educación y legal): antes eran cinco
      // pestañas separadas para datos que se llenan de una sola vez.
      item.getAttribute("data-tab").split(/\s+/).forEach(id => {
        document.getElementById(id)?.classList.add("active");
      });

      tabTitle.textContent = item.querySelector("span:last-child").textContent;
      document.querySelector(".main-content")?.scrollTo({ top: 0 });
      if (item.getAttribute("data-tab") === "tab-home") renderSetupChecklist();
    });
  });

  // Load storage and initialize profiles.
  //
  // Se le pide al service worker que confirme la migración al esquema
  // candidateBase+cvIndexes ANTES de leer: cubre el caso de haber importado
  // (btnImportJson, más abajo) un respaldo JSON pre-rediseño —
  // `chrome.storage.local.set()` no dispara `onInstalled` por sí solo, así
  // que sin este paso un respaldo viejo quedaría en el esquema viejo para
  // siempre tras importarlo.
  await new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "ENSURE_SCHEMA_MIGRATED" }, () => resolve());
    } catch (e) {
      resolve();
    }
  });

  const storedData = await chrome.storage.local.get(null);

  if (storedData) {
    // Load Global API Key & Global Settings
    if (storedData.claudeApiKey && claudeApiKeyInput) claudeApiKeyInput.value = storedData.claudeApiKey;
    if (aiProviderSelect) aiProviderSelect.value = storedData.aiProvider === "gemini" ? "gemini" : "anthropic";
    if (storedData.vertexApiKey && vertexApiKeyInput) vertexApiKeyInput.value = storedData.vertexApiKey;
    if (aiFallbackCheckbox) aiFallbackCheckbox.checked = storedData.aiFallbackToGemini !== false;
    syncProviderFields();
    if (storedData.aiTone && document.getElementById("aiTone")) document.getElementById("aiTone").value = storedData.aiTone;
    if (storedData.customAiInstructions && document.getElementById("customAiInstructions")) document.getElementById("customAiInstructions").value = storedData.customAiInstructions;
    // Sin valor guardado, la confirmación va activada (el checkbox ya viene
    // marcado en el HTML): solo hay que desmarcarlo si se guardó un false.
    const confirmBox = document.getElementById("confirmQuestionBeforeAi");
    if (confirmBox) confirmBox.checked = storedData.confirmQuestionBeforeAi !== false;

    // Camino normal: el esquema real (candidateBase único + cvIndexes). Los
    // tres branches de abajo son un respaldo defensivo por si el mensaje de
    // arriba no llegó a tiempo (pestaña ya abierta cuando se recargó la
    // extensión, por ejemplo) y la migración de verdad no corrió todavía.
    if (storedData.schemaVersion === 2 && storedData.candidateBase) {
      localProfiles = profilesFromCandidateData(storedData.candidateBase, storedData.cvIndexes);
      activeProfileId = storedData.activeCvIndexId || localProfiles[0].id;
    } else if (storedData.profiles && Array.isArray(storedData.profiles) && storedData.profiles.length > 0) {
      localProfiles = [...storedData.profiles];
      activeProfileId = storedData.activeProfileId || localProfiles[0].id;
    } else if (storedData.cvProfiles && Array.isArray(storedData.cvProfiles) && storedData.cvProfiles.length > 0) {
      localProfiles = storedData.cvProfiles.map(p => ({
        ...p,
        firstName: storedData.firstName || "",
        lastName: storedData.lastName || "",
        fullName: storedData.fullName || "",
        rut: storedData.rut || "",
        email: storedData.email || "",
        phone: storedData.phone || "",
        country: storedData.country || "Chile",
        city: storedData.city || "",
        address: storedData.address || "",
        postalCode: storedData.postalCode || "",
        linkedinUrl: storedData.linkedinUrl || "",
        githubUrl: storedData.githubUrl || "",
        portfolioUrl: storedData.portfolioUrl || "",
        headline: p.targetRole || storedData.headline || "",
        summary: storedData.summary || "",
        skills: p.keywords || storedData.skills || "",
        customQA: storedData.customQA || [],
        customFields: storedData.customFields || []
      }));
      activeProfileId = storedData.activeCvProfileId || localProfiles[0].id;
    } else {
      localProfiles = [
        {
          id: "prof_default",
          name: "Perfil Principal (Full Stack / General)",
          targetRole: storedData.headline || "Senior Full Stack Developer",
          keywords: storedData.skills || "full stack, react, node, python, software engineer",
          firstName: storedData.firstName || "",
          lastName: storedData.lastName || "",
          fullName: storedData.fullName || "",
          rut: storedData.rut || "",
          email: storedData.email || "",
          phone: storedData.phone || "",
          country: storedData.country || "Chile",
          city: storedData.city || "",
          address: storedData.address || "",
          postalCode: storedData.postalCode || "",
          linkedinUrl: storedData.linkedinUrl || "",
          githubUrl: storedData.githubUrl || "",
          portfolioUrl: storedData.portfolioUrl || "",
          headline: storedData.headline || "Senior Full Stack Developer",
          summary: storedData.summary || "Profesional con amplia experiencia en desarrollo web...",
          skills: storedData.skills || "React, Node.js, TypeScript, Python, SQL",
          degree: storedData.degree || "Ingeniería en Informática",
          university: storedData.university || "",
          yearsOfExperience: storedData.yearsOfExperience || "3",
          salaryExpectation: storedData.salaryExpectation || "",
          resumeText: storedData.resumeText || "",
          cvDatabase: storedData.cvDatabase || { rawText: "", experiences: [], projects: [], education: [] },
          customQA: storedData.customQA || [],
          customFields: storedData.customFields || []
        }
      ];
      activeProfileId = "prof_default";
    }

    loadActiveProfileIntoDOM();
    renderGlobalProfileSelector();
    renderSetupChecklist();
  }

  // Profile-Centric DOM Load
  function loadActiveProfileIntoDOM() {
    const current = localProfiles.find(p => p.id === activeProfileId) || localProfiles[0];
    if (!current) return;

    activeProfileId = current.id;

    // Populate all form elements from current active profile
    Object.keys(current).forEach(key => {
      const field = profileForm.elements[key];
      if (field && !GLOBAL_SETTING_KEYS.includes(key)) {
        field.value = current[key] !== undefined ? current[key] : "";
      }
    });

    if (profileTargetRoleInput) profileTargetRoleInput.value = current.targetRole || current.headline || "";
    // SIN fallback a `skills`: las keywords son la señal que distingue a ESTE
    // índice de los demás. `skills` ahora es compartido entre todos, así que
    // usarlo de respaldo llenaría cada faceta con la misma lista larga, todas
    // puntuarían igual contra cualquier oferta y la selección de índice
    // quedaría siempre "ambigua". Vacío es una respuesta válida: significa
    // "sin señal propia", y selectBestCvIndex ya cae al índice activo.
    if (profileKeywordsInput) profileKeywordsInput.value = current.keywords || "";
    if (resumeTextInput) resumeTextInput.value = current.resumeText || current.cvDatabase?.rawText || "";

    localQA = current.customQA ? [...current.customQA] : [];
    localCustomFields = current.customFields ? [...current.customFields] : [];
    localCvDatabase = current.cvDatabase || { rawText: "", experiences: [], projects: [], education: [] };
    localMarkdownSources = Array.isArray(current.markdownSources) ? [...current.markdownSources] : [];
    renderMarkdownSources();

    renderQaList();
    renderCustomFieldsList();
    renderCvDatabase();
  }

  // Profile-Centric DOM Save
  function saveActiveProfileFromDOM() {
    const current = localProfiles.find(p => p.id === activeProfileId);
    if (!current) return;

    // Read all inputs into active profile
    const formData = new FormData(profileForm);
    formData.forEach((val, key) => {
      if (!GLOBAL_SETTING_KEYS.includes(key)) {
        current[key] = val;
      }
    });

    current.targetRole = profileTargetRoleInput?.value?.trim() || current.headline || "";
    // Ver el comentario en loadActiveProfileIntoDOM: sin fallback a `skills`.
    current.keywords = profileKeywordsInput?.value?.trim() || "";
    current.resumeText = resumeTextInput?.value?.trim() || "";
    current.customQA = extractQaFromDOM();
    current.customFields = extractCustomFieldsFromDOM();
    current.cvDatabase = extractCvDatabaseFromDOM();
    current.markdownSources = localMarkdownSources;
  }

  function renderGlobalProfileSelector() {
    if (!globalProfileSelect) return;
    globalProfileSelect.innerHTML = "";

    localProfiles.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name} ${p.targetRole ? `— [${p.targetRole}]` : ""}`;
      if (p.id === activeProfileId) opt.selected = true;
      globalProfileSelect.appendChild(opt);
    });
  }

  if (globalProfileSelect) {
    globalProfileSelect.addEventListener("change", async () => {
      saveActiveProfileFromDOM();
      // Los campos compartidos (todo salvo nombre/keywords/targetRole) deben
      // propagarse a TODOS los índices antes de cambiar — si no, el índice al
      // que se cambia todavía carga la copia vieja de cuando se leyó storage.
      syncSharedFieldsAcrossProfiles(localProfiles.find(p => p.id === activeProfileId), localProfiles);

      activeProfileId = globalProfileSelect.value;
      loadActiveProfileIntoDOM();

      const selected = localProfiles.find(p => p.id === activeProfileId);
      await chrome.storage.local.set(candidateDataFromProfiles(localProfiles, activeProfileId));

      showSaveFeedback(`🎯 Perfil activo: "${selected?.name}"`);
    });
  }

  if (btnGlobalNewProfile) {
    btnGlobalNewProfile.addEventListener("click", () => {
      const name = prompt("Nombre de la nueva versión de Perfil / CV (Ej: 'Senior Backend Developer', 'Tech Lead', 'Data Engineer'):");
      if (!name || !name.trim()) return;

      saveActiveProfileFromDOM();
      const currentProfile = localProfiles.find(p => p.id === activeProfileId);
      syncSharedFieldsAcrossProfiles(currentProfile, localProfiles);

      const newId = `prof_${Date.now()}`;
      // Hereda TODO lo compartido del candidato (identidad completa, CV, Q&A,
      // campos personalizados) — ya no hace falta volver a cargar el CV por
      // cada faceta nueva. Solo cambia lo propio de ESTE índice: nombre,
      // keywords y el título con el que se presenta esta faceta.
      const newProfile = { ...currentProfile, id: newId, name: name.trim(), targetRole: name.trim(), keywords: "" };

      localProfiles.push(newProfile);
      activeProfileId = newId;
      renderGlobalProfileSelector();
      loadActiveProfileIntoDOM();

      scheduleSave();

      // Switch to CV tab automatically (ahí viven las keywords/título objetivo).
      const cvTabBtn = document.querySelector('[data-tab="tab-profiles"]');
      if (cvTabBtn) cvTabBtn.click();
    });
  }

  if (btnGlobalRenameProfile) {
    btnGlobalRenameProfile.addEventListener("click", () => {
      const current = localProfiles.find(p => p.id === activeProfileId);
      if (!current) return;
      const newName = prompt("Nuevo nombre para este perfil:", current.name);
      if (newName && newName.trim()) {
        current.name = newName.trim();
        renderGlobalProfileSelector();
        scheduleSave();
      }
    });
  }

  if (btnGlobalDeleteProfile) {
    btnGlobalDeleteProfile.addEventListener("click", () => {
      if (localProfiles.length <= 1) {
        alert("Debes mantener al menos un perfil.");
        return;
      }
      const current = localProfiles.find(p => p.id === activeProfileId);
      if (confirm(`¿Estás seguro de eliminar el perfil "${current?.name}"?`)) {
        localProfiles = localProfiles.filter(p => p.id !== activeProfileId);
        activeProfileId = localProfiles[0].id;
        renderGlobalProfileSelector();
        loadActiveProfileIntoDOM();
        scheduleSave();
      }
    });
  }

  /**
   * Guarda TODO (perfil compartido, índices y ajustes globales). Antes solo
   * ocurría al pulsar "Guardar Cambios" — y el formulario exigía email y
   * teléfono (`required`), así que ni siquiera se podía guardar la API key
   * sin completarlos. Ahora se guarda solo, unos instantes después de cada
   * cambio (ver scheduleSave).
   */
  async function persistAll() {
    saveActiveProfileFromDOM();
    syncSharedFieldsAcrossProfiles(localProfiles.find(p => p.id === activeProfileId), localProfiles);

    const storagePayload = {
      ...candidateDataFromProfiles(localProfiles, activeProfileId),
      aiProvider: aiProviderSelect?.value === "gemini" ? "gemini" : "anthropic",
      claudeApiKey: claudeApiKeyInput?.value?.trim() || "",
      vertexApiKey: vertexApiKeyInput?.value?.trim() || "",
      aiFallbackToGemini: aiFallbackCheckbox ? aiFallbackCheckbox.checked : true,
      aiTone: document.getElementById("aiTone")?.value || "profesional y persuasivo",
      customAiInstructions: document.getElementById("customAiInstructions")?.value || "",
      // El content script trata cualquier valor distinto de false como "sí
      // preguntar", así que un checkbox ausente deja la confirmación activa.
      confirmQuestionBeforeAi: document.getElementById("confirmQuestionBeforeAi")?.checked !== false
    };

    await chrome.storage.local.set(storagePayload);
    renderGlobalProfileSelector();
    showSaveFeedback("✓ Guardado");
    if (document.getElementById("tab-home")?.classList.contains("active")) renderSetupChecklist();
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveStatus.textContent = "Guardando…";
    saveStatus.classList.add("show");
    saveTimer = setTimeout(() => { persistAll().catch(err => showSaveFeedback(`⚠️ No se pudo guardar: ${err.message}`)); }, 600);
  }

  profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearTimeout(saveTimer);
    await persistAll();
  });

  // Autoguardado: cualquier cambio en el formulario. Los <input type=file>
  // se excluyen: su "cambio" es elegir un archivo, que tiene su propio flujo.
  profileForm.addEventListener("input", e => { if (e.target.type !== "file") scheduleSave(); });
  profileForm.addEventListener("change", e => { if (e.target.type !== "file") scheduleSave(); });

  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      clearTimeout(saveTimer);
      persistAll();
    }
  });

  let feedbackTimer = null;
  function showSaveFeedback(msg) {
    clearTimeout(feedbackTimer);
    saveStatus.textContent = msg;
    saveStatus.classList.add("show");
    feedbackTimer = setTimeout(() => {
      saveStatus.classList.remove("show");
    }, 2500);
  }

  // Toggle API Key visibility
  function wireVisibilityToggle(button, input) {
    button?.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.textContent = reveal ? "🔒" : "👁️";
    });
  }
  wireVisibilityToggle(btnToggleKey, claudeApiKeyInput);
  wireVisibilityToggle(btnToggleVertexKey, vertexApiKeyInput);

  // Probar conexión: cada proveedor configurado POR SEPARADO, con los dos
  // modelos que usa la extensión. Se llama a `callProvider` y no a `callAi`
  // a propósito: `callAi` saltaría a Gemini si Claude no tiene saldo, y la
  // prueba diría "OK" escondiendo justo el problema que hay que ver.
  btnTestClaude.addEventListener("click", async () => {
    const ai = aiSettingsFromDOM();
    const problem = JobFillAi.aiSettingsProblem(ai);
    if (problem) {
      claudeTestResult.textContent = `⚠️ ${problem}`;
      claudeTestResult.className = "api-test-badge show error";
      return;
    }

    const providers = [];
    if (ai.anthropicKey) providers.push("anthropic");
    if (ai.geminiKey) providers.push("gemini");

    claudeTestResult.textContent = `⏳ Probando ${providers.map(JobFillAi.describeProvider).join(" y ")}...`;
    claudeTestResult.className = "api-test-badge show";

    const results = [];
    for (const provider of providers) {
      for (const model of [JobFillAi.MODEL_SONNET, JobFillAi.MODEL_HAIKU]) {
        try {
          const data = await JobFillAi.callProvider(ai, provider, {
            model,
            body: {
              max_tokens: 20,
              messages: [{ role: "user", content: "Responde únicamente con 'OK' para verificar la conexión." }],
              ...(provider === "anthropic" ? { thinking: { type: "disabled" } } : {})
            },
            timeoutMs: 30000
          });
          results.push({ provider, label: data._model, ok: true, reply: extractClaudeText(data) || "(sin texto)" });
        } catch (err) {
          results.push({ provider, label: `${JobFillAi.describeProvider(provider)} · ${model}`, ok: false, error: err.message });
        }
      }
    }

    const primaryOk = results.filter(r => r.provider === ai.provider).every(r => r.ok);
    claudeTestResult.textContent = results
      .map(r => r.ok ? `✅ ${r.label}: "${r.reply}"` : `❌ ${r.label}: ${r.error}`)
      .join("  ·  ");
    claudeTestResult.className = `api-test-badge show ${results.every(r => r.ok) ? "success" : "error"}`;

    // Se persisten las credenciales solo si el proveedor PRINCIPAL respondió.
    if (primaryOk) {
      await chrome.storage.local.set({
        aiProvider: ai.provider,
        claudeApiKey: ai.anthropicKey,
        vertexApiKey: ai.geminiKey,
        aiFallbackToGemini: ai.fallbackToGemini
      });
    }
  });

  // QA Management
  function renderQaList() {
    qaList.innerHTML = "";

    if (localQA.length === 0) {
      qaList.innerHTML = `<div style="color: #64748b; font-size: 13px;">No hay preguntas frecuentes registradas. Pulsa "+ Agregar Nueva Pregunta".</div>`;
      return;
    }

    localQA.forEach((qa, idx) => {
      const card = document.createElement("div");
      card.className = "qa-card";
      card.innerHTML = `
        <div class="qa-header">
          <label>Palabras clave (separadas por coma):</label>
          <button type="button" class="btn-delete-qa" data-idx="${idx}">✕ Eliminar</button>
        </div>
        <input type="text" class="qa-keywords-input" value="${escapeHtml(qa.keywords)}" placeholder="ej: motivacion, por que quieres trabajar, why work here">
        <label style="margin-top: 4px;">Respuesta predefinida:</label>
        <textarea class="qa-answer-input" rows="3" placeholder="Escribe tu respuesta aquí...">${escapeHtml(qa.answer)}</textarea>
      `;
      qaList.appendChild(card);
    });

    qaList.querySelectorAll(".btn-delete-qa").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        localQA = extractQaFromDOM();
        localQA.splice(idx, 1);
        renderQaList();
        scheduleSave();
      });
    });
  }

  function extractQaFromDOM() {
    const cards = qaList.querySelectorAll(".qa-card");
    const items = [];
    cards.forEach((card, idx) => {
      const kw = card.querySelector(".qa-keywords-input")?.value || "";
      const ans = card.querySelector(".qa-answer-input")?.value || "";
      if (kw || ans) {
        items.push({ id: `qa_${idx + 1}`, keywords: kw, answer: ans });
      }
    });
    return items;
  }

  btnAddQa.addEventListener("click", () => {
    localQA = extractQaFromDOM();
    localQA.push({ id: `qa_${Date.now()}`, keywords: "", answer: "" });
    renderQaList();
  });

  // Custom Fields Management
  function renderCustomFieldsList() {
    customFieldsList.innerHTML = "";

    if (localCustomFields.length === 0) {
      customFieldsList.innerHTML = `<div style="color: #64748b; font-size: 13px;">No hay campos personalizados configurados. Pulsa "+ Agregar Campo Personalizado".</div>`;
      return;
    }

    localCustomFields.forEach((cf, idx) => {
      const card = document.createElement("div");
      card.className = "qa-card";
      card.innerHTML = `
        <div class="qa-header">
          <label><strong>Nombre / Etiqueta del Campo:</strong></label>
          <button type="button" class="btn-delete-cf" data-idx="${idx}">✕ Eliminar</button>
        </div>
        <input type="text" class="cf-label-input" value="${escapeHtml(cf.label)}" placeholder="Ej: Licencia de Conducir, Renta Líquida, Nacionalidad">
        
        <label style="margin-top: 6px;"><strong>Valor a rellenar:</strong></label>
        <input type="text" class="cf-value-input" value="${escapeHtml(cf.value)}" placeholder="Ej: Clase B al día / $2.000.000 CLP / Chilena">

        <label style="margin-top: 6px;"><strong>Palabras clave y sinónimos (separadas por comas):</strong></label>
        <input type="text" class="cf-keywords-input" value="${escapeHtml(cf.keywords)}" placeholder="Ej: licencia, conducir, driver license, carnet conducir">
      `;
      customFieldsList.appendChild(card);
    });

    customFieldsList.querySelectorAll(".btn-delete-cf").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        localCustomFields = extractCustomFieldsFromDOM();
        localCustomFields.splice(idx, 1);
        renderCustomFieldsList();
        scheduleSave();
      });
    });
  }

  function extractCustomFieldsFromDOM() {
    const cards = customFieldsList.querySelectorAll(".qa-card");
    const items = [];
    cards.forEach((card, idx) => {
      const label = card.querySelector(".cf-label-input")?.value?.trim() || "";
      const val = card.querySelector(".cf-value-input")?.value?.trim() || "";
      const kw = card.querySelector(".cf-keywords-input")?.value?.trim() || "";
      if (label || val || kw) {
        items.push({ id: `cf_${idx + 1}`, label, value: val, keywords: kw });
      }
    });
    return items;
  }

  btnAddCustomField.addEventListener("click", () => {
    localCustomFields = extractCustomFieldsFromDOM();
    localCustomFields.push({ id: `cf_${Date.now()}`, label: "", value: "", keywords: "" });
    renderCustomFieldsList();
  });

  // CV Database Management & AI Parser
  async function extractPdfTextLocally(file) {
    // Try PdfTextExtractor class from pdf-parser.js first (most reliable)
    if (typeof PdfTextExtractor !== "undefined") {
      try {
        const result = await PdfTextExtractor.extractText(file);
        if (result && result.text && result.text.length > 30) {
          return result;
        }
      } catch (e) {
        console.warn("PdfTextExtractor failed, trying pdfjsLib directly:", e.message);
      }
    }

    // Direct pdfjsLib fallback
    const pdfLib = window.pdfjsLib || globalThis.pdfjsLib || window["pdfjs-dist/build/pdf"];
    if (pdfLib) {
      try {
        try {
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
            pdfLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("options/pdf.worker.min.js");
          } else {
            pdfLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
          }
        } catch (e) {
          pdfLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
        }

        const arrayBuffer = await file.arrayBuffer();
        const typedArray = new Uint8Array(arrayBuffer);
        const loadingTask = pdfLib.getDocument({
          data: typedArray,
          cMapPacked: true
        });

        const pdf = await loadingTask.promise;
        const pageTexts = [];

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const textContent = await page.getTextContent({ normalizeWhitespace: true });
          
          let lastY = null;
          let pageString = "";

          for (const item of textContent.items) {
            if (!item.str && item.str !== " ") continue;
            const currentY = item.transform ? item.transform[5] : 0;
            if (lastY !== null && Math.abs(currentY - lastY) > 6) {
              pageString += "\n";
            } else if (pageString.length > 0 && !pageString.endsWith(" ") && !item.str.startsWith(" ")) {
              pageString += " ";
            }
            pageString += item.str;
            lastY = currentY;
          }

          const cleaned = pageString.trim();
          if (cleaned) pageTexts.push(cleaned);
        }

        if (pageTexts.length > 0) {
          return {
            text: pageTexts.join("\n\n--- Salto de Página ---\n\n"),
            pageCount: pdf.numPages
          };
        }
      } catch (pdfErr) {
        console.warn("pdfjsLib extraction failed:", pdfErr.message);
      }
    }

    // Last-resort raw byte extraction
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let rawStr = "";
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        if ((c >= 32 && c <= 126) || c === 10 || c === 13 || (c >= 160 && c <= 255)) {
          rawStr += String.fromCharCode(c);
        }
      }
      const textMatches = rawStr.match(/\(([^\)\\]{2,})\)/g) || [];
      const extracted = textMatches.map(m => m.slice(1, -1)).filter(s => s.length > 2).join(" ");
      if (extracted.length > 50) {
        return { text: extracted, pageCount: 1 };
      }
    } catch (rawErr) {
      console.warn("Raw byte extraction failed:", rawErr.message);
    }

    throw new Error("No se pudo extraer texto digital del PDF. Verifica que el archivo no esté corrupto y que no sea un escaneo de imagen.");
  }

  if (btnUploadCvFile && cvFileInput) {
    btnUploadCvFile.addEventListener("click", () => {
      cvFileInput.value = ""; // Reset file input so re-uploading works immediately every time
      cvFileInput.click();
    });

    cvFileInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const fileName = file.name.toLowerCase();

      // Un .md es fuente de verdad, no un CV que haya que interpretar con IA.
      if (fileName.endsWith(".md") || fileName.endsWith(".markdown")) {
        e.target.value = "";
        await importMarkdownFiles([file]);
        return;
      }

      if (fileName.endsWith(".pdf") || file.type === "application/pdf") {
        cvParseStatus.textContent = `⏳ Extrayendo texto del documento PDF "${file.name}"...`;
        cvParseStatus.className = "api-test-badge show";

        try {
          const result = await extractPdfTextLocally(file);
          resumeTextInput.value = result.text;
          cvParseStatus.textContent = `✅ ¡PDF "${file.name}" procesado con éxito (${result.pageCount} pág)! Pulsa "Convertir CV en Base de Datos".`;
          cvParseStatus.className = "api-test-badge show success";
        } catch (pdfErr) {
          cvParseStatus.textContent = `❌ Error al leer PDF: ${pdfErr.message}`;
          cvParseStatus.className = "api-test-badge show error";
        }
      } else {
        const reader = new FileReader();
        reader.onload = (event) => {
          resumeTextInput.value = event.target.result;
          cvParseStatus.textContent = `📄 Archivo "${file.name}" cargado. Pulsa "Convertir CV en Base de Datos".`;
          cvParseStatus.className = "api-test-badge show success";
        };
        reader.readAsText(file);
      }
    });
  }

  // Animated Progress Bar Controller
  function updateProgressUI(percent, stepText) {
    if (!cvProgressBarContainer) return;
    cvProgressBarContainer.style.display = "block";
    cvProgressPercentage.textContent = `${percent}%`;
    cvProgressFill.style.width = `${percent}%`;
    if (stepText) {
      cvProgressStepText.textContent = stepText;
      if (cvParseStatus) {
        cvParseStatus.textContent = stepText;
        cvParseStatus.className = percent >= 100 ? "api-test-badge show success" : "api-test-badge show";
      }
    }
  }

  function startProgressSimulation() {
    if (progressInterval) clearInterval(progressInterval);
    updateProgressUI(10, "📄 [10%] Leyendo documento y extrayendo secciones...");

    let current = 10;
    progressInterval = setInterval(() => {
      if (current < 30) {
        current += 3;
        updateProgressUI(current, `🧠 [${current}%] Analizando historial de cargos y logros...`);
      } else if (current < 55) {
        current += 4;
        updateProgressUI(current, `🚀 [${current}%] Extrayendo proyectos y stack tecnológico...`);
      } else if (current < 75) {
        current += 3;
        updateProgressUI(current, `⚙️ [${current}%] Estructurando Base de Datos de Cargos...`);
      } else if (current < 90) {
        current += 2;
        updateProgressUI(current, `🤖 [${current}%] Sintetizando perfil integral y datos de contacto...`);
      } else if (current >= 90) {
        // Stop incrementing but don't clear — wait for completeProgress
        updateProgressUI(92, `⏳ [92%] Esperando respuesta de Claude IA...`);
      }
    }, 350);

    // Safety net: if after 60 seconds we're still going, force-complete
    setTimeout(() => {
      if (progressInterval) {
        console.warn("Progress safety timeout triggered after 60s");
        completeProgress(false, "⚠️ [100%] Tiempo de espera agotado. Intenta nuevamente.");
      }
    }, 60000);
  }

  function completeProgress(isSuccess, message) {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    const finalMsg = message || (isSuccess ? "✅ [100%] ¡Base de Datos estructurada con éxito!" : "⚠️ [100%] Estructuración finalizada.");
    updateProgressUI(100, finalMsg);
    if (btnParseCvToDb) btnParseCvToDb.disabled = false;
    
    setTimeout(() => {
      if (cvProgressBarContainer) {
        cvProgressBarContainer.style.display = "none";
        cvProgressFill.style.width = "0%";
      }
    }, 5000);

    const dbSection = document.getElementById("cvDatabaseSection");
    if (dbSection) {
      setTimeout(() => dbSection.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    }
  }

  async function parseCvWithClaudeOrFallback(cvText, ai, model) {
    if (!JobFillAi.hasAiCredentials(ai)) {
      fallbackToLocalParsing(cvText, "Sin credenciales de Claude");
      return;
    }

    const systemPrompt = `Eres un sistema experto en análisis y estructuración de Currículum Vitae profesional para postulaciones laborales.
Tu tarea es analizar el texto de un CV y devolver ÚNICAMENTE un objeto JSON válido con la siguiente estructura completa (sin markdown, sin explicaciones):
{
  "firstName": "Primer Nombre (si se detecta)",
  "lastName": "Apellidos (si se detecta)",
  "fullName": "Nombre Completo del candidato",
  "email": "correo@ejemplo.com (si se detecta)",
  "phone": "+56 9 1234 5678 (si se detecta)",
  "rut": "RUT o DNI (si se detecta)",
  "city": "Ciudad (si se detecta)",
  "country": "País (si se detecta)",
  "linkedinUrl": "URL de LinkedIn (si se detecta)",
  "githubUrl": "URL de GitHub (si se detecta)",
  "portfolioUrl": "URL de Portafolio o Web (si se detecta)",
  "headline": "Titular profesional recomendado (ej: Senior Full Stack Developer)",
  "summary": "Resumen profesional convincente de 3-4 líneas resumiendo la experiencia clave",
  "skills": "Habilidades y tecnologías separadas por comas (ej: React, Node.js, Python, PostgreSQL, AWS)",
  "degree": "Título académico principal (ej: Ingeniería en Informática)",
  "university": "Universidad o Institución educativa",
  "yearsOfExperience": "Años estimados de experiencia profesional (ej: 5)",
  "experiences": [
    {
      "id": "exp_1",
      "company": "Nombre de la Empresa",
      "role": "Cargo o Título",
      "period": "Año/Mes inicio - Fin o Presente (ej: 2022 - Presente)",
      "description": "Resumen claro de responsabilidades principales",
      "achievements": "Logros clave cuantitativos o hitos alcanzados (ej: Aumento del 35% en rendimiento)",
      "technologies": "Tecnologías y herramientas usadas en este cargo"
    }
  ],
  "projects": [
    {
      "id": "proj_1",
      "name": "Nombre del Proyecto",
      "description": "Objetivo del proyecto e impacto",
      "technologies": "Tecnologías utilizadas"
    }
  ],
  "education": [
    {
      "id": "edu_1",
      "degree": "Título académico obtenido",
      "institution": "Universidad o Institución",
      "year": "Año de graduación o período"
    }
  ]
}`;

    let lastErrorMsg = "";

    try {
      // max_tokens holgado: el JSON de un CV con varios cargos y proyectos
      // supera fácilmente 3000 tokens, y un JSON cortado a la mitad no parsea
      // y termina en el parser local (mucho peor) sin que se note por qué.
      const data = await JobFillAi.callAi(ai, {
        model,
        max_tokens: 8000,
        thinking: { type: "disabled" },
        system: systemPrompt,
        messages: [{ role: "user", content: `Analiza y extrae TODOS los datos personales, contacto, resumen, habilidades y Base de Datos del siguiente CV:\n\n${cvText}` }],
        timeoutMs: 90000
      });

      const rawReply = extractClaudeText(data);
      const cleaned = rawReply.replace(/```json/gi, "").replace(/```/g, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (jsonErr) {
        console.warn("Claude returned invalid JSON, falling back to local parser:", cleaned.slice(0, 200));
        fallbackToLocalParsing(cvText, "Claude devolvió JSON inválido");
        return;
      }

      parsed.rawText = cvText;
      parsed.parsedAt = new Date().toISOString();

      localCvDatabase = {
        rawText: cvText,
        parsedAt: parsed.parsedAt,
        experiences: parsed.experiences || [],
        projects: parsed.projects || [],
        education: parsed.education || []
      };
      renderCvDatabase();

      // Populate entire profile fields across all tabs
      applyFullProfileExtraction(parsed, cvText);

      completeProgress(true, `✅ [100%] ¡Perfil completo y Base de Datos autocompletados con éxito por Claude! (${localCvDatabase.experiences.length} cargos, ${localCvDatabase.projects.length} proyectos)`);
      return;
    } catch (err) {
      lastErrorMsg = err.message || "Error de red";
    }

    // Claude call failed or timed out: activate instant local fallback
    fallbackToLocalParsing(cvText, lastErrorMsg);
  }

  if (btnParseCvToDb) {
    btnParseCvToDb.addEventListener("click", async () => {
      const text = resumeTextInput.value.trim();
      const currentModel = JobFillAi.MODEL_SONNET;

      if (!text || text.length < 20) {
        cvParseStatus.textContent = "⚠️ Pega el texto de tu CV o sube un archivo antes de estructurarlo.";
        cvParseStatus.className = "api-test-badge show error";
        return;
      }

      // Prevent double-click
      if (btnParseCvToDb.disabled) return;

      saveActiveProfileFromDOM();

      // Lo escrito en la pestaña de IA manda; si está vacío, se usa lo guardado.
      let currentAi = aiSettingsFromDOM();
      if (!JobFillAi.hasAiCredentials(currentAi)) {
        currentAi = JobFillAi.readAiSettings(await chrome.storage.local.get(null));
      }

      startProgressSimulation();
      btnParseCvToDb.disabled = true;

      // Execute parsing with automatic fallback and guaranteed error recovery
      try {
        await parseCvWithClaudeOrFallback(text, currentAi, currentModel);
      } catch (fatalErr) {
        console.error("Fatal CV parsing error:", fatalErr);
        try {
          fallbackToLocalParsing(text, fatalErr.message);
        } catch (fallbackErr) {
          console.error("Even local fallback failed:", fallbackErr);
          completeProgress(false, `❌ Error crítico al procesar CV: ${fallbackErr.message}`);
        }
      } finally {
        // ALWAYS re-enable the button and clean up progress no matter what
        if (btnParseCvToDb.disabled) {
          btnParseCvToDb.disabled = false;
        }
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
      }
    });
  }

  function parseCvLocally(cvText) {
    const lines = cvText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("--- Salto de Página"));

    const experiences = [];
    const projects = [];
    const education = [];

    // ── PASS 1: Extract contact data with robust regexes ──
    const emailMatch = cvText.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/);
    const phoneMatch = cvText.match(/(?:\+\d{1,3}[\s\-.]?)?\(?\d{1,4}\)?[\s\-.]?\d{2,5}[\s\-.]?\d{2,5}(?:[\s\-.]?\d{1,4})?/);
    const rutMatch = cvText.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-?[0-9kK]\b/);
    const linkedinMatch = cvText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_\-]+\/?/i);
    const githubMatch = cvText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[a-zA-Z0-9_\-]+\/?/i);
    const portfolioMatch = cvText.match(/(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9\-]+\.(?:dev|io|com|me|app|tech|site|page)(?:\/[a-zA-Z0-9_\-]*)?/i);
    const cityCountryMatch = cvText.match(/(?:santiago|valparaíso|concepción|viña del mar|antofagasta|temuco|la serena|iquique|rancagua|talca|arica|puerto montt|punta arenas|buenos aires|lima|bogotá|medellín|quito|cdmx|madrid|barcelona|ciudad de méxico|new york|san francisco|london|berlin|toronto)(?:\s*[,\-–]\s*(?:chile|argentina|perú|colombia|ecuador|méxico|españa|usa|uk|germany|canada|brasil|brazil))?/i);

    // ── PASS 2: Expanded tech keyword detection ──
    const TECH_KEYWORDS = [
      "JavaScript", "TypeScript", "Python", "React", "React Native", "Node.js", "Vue", "Vue.js",
      "Angular", "Next.js", "Nuxt", "Svelte", "Express", "NestJS",
      "Java", "Spring Boot", "Spring", "C#", ".NET", "ASP.NET", "PHP", "Laravel", "Symfony",
      "Go", "Golang", "Rust", "C++", "C", "Swift", "Kotlin", "Dart", "Flutter", "Ruby", "Rails",
      "SQL", "PostgreSQL", "MySQL", "MariaDB", "MongoDB", "Redis", "DynamoDB", "Elasticsearch",
      "SQLite", "Oracle", "SQL Server", "Cassandra", "Firebase", "Supabase",
      "Docker", "Kubernetes", "K8s", "AWS", "Azure", "GCP", "Google Cloud", "Terraform",
      "Ansible", "Jenkins", "GitHub Actions", "GitLab CI",
      "Git", "GraphQL", "REST", "REST APIs", "gRPC", "WebSocket",
      "Tailwind", "TailwindCSS", "Bootstrap", "Material UI", "Chakra UI",
      "HTML5", "HTML", "CSS3", "CSS", "SASS", "SCSS", "LESS",
      "Linux", "Ubuntu", "Nginx", "Apache",
      "FastAPI", "Django", "Flask", "Celery",
      "CI/CD", "DevOps", "SRE", "Jest", "Cypress", "Selenium", "Playwright",
      "Microservicios", "Microservices", "Serverless", "Lambda",
      "Agile", "Scrum", "Kanban", "Jira", "Confluence", "Figma", "Notion",
      "TDD", "BDD", "Clean Architecture", "SOLID", "Design Patterns",
      "Machine Learning", "Deep Learning", "TensorFlow", "PyTorch", "Pandas", "NumPy",
      "Power BI", "Tableau", "Looker", "Airflow", "Spark", "Hadoop",
      "Webpack", "Vite", "Babel", "ESLint", "Prettier",
      "OAuth", "JWT", "Auth0", "Stripe", "Twilio", "SendGrid"
    ];

    const detectedTech = TECH_KEYWORDS.filter(t => {
      try {
        return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cvText);
      } catch (e) { return false; }
    });

    // ── PASS 3: Detect section boundaries ──
    const SECTION_HEADERS = {
      experience: /^(?:experiencia\s*(?:laboral|profesional)?|historial\s*laboral|trayectoria\s*(?:profesional|laboral)?|work\s*experience|employment\s*(?:history)?|professional\s*experience)/i,
      education: /^(?:educaci[oó]n|estudios|formaci[oó]n\s*(?:acad[eé]mica)?|education|academic\s*(?:background|history)?|certificaciones?\s*(?:y\s*educaci[oó]n)?)/i,
      projects: /^(?:proyectos?\s*(?:destacados?|personales|relevantes)?|projects?\s*(?:highlights?)?|portafolio)/i,
      skills: /^(?:habilidades|skills|conocimientos|competencias|tecnolog[ií]as|stack\s*(?:tecnol[oó]gico)?|tech\s*stack|herramientas|tools)/i,
      summary: /^(?:perfil\s*(?:profesional)?|resumen\s*(?:profesional|ejecutivo)?|sobre\s*m[ií]|acerca\s*de|about\s*me|professional\s*(?:summary|profile)|summary|objective)/i,
      languages: /^(?:idiomas|languages)/i
    };

    // Map each line to its section
    let currentSection = "header"; // Lines before first section header
    const sectionLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let foundSection = null;

      for (const [sectionName, regex] of Object.entries(SECTION_HEADERS)) {
        if (regex.test(line)) {
          foundSection = sectionName;
          break;
        }
      }

      if (foundSection) {
        currentSection = foundSection;
        continue; // Skip the header line itself
      }

      sectionLines.push({ text: line, section: currentSection, index: i });
    }

    // ── PASS 4: Extract name from header area ──
    const headerLines = sectionLines.filter(l => l.section === "header");
    let fullNameGuess = "";
    let firstNameGuess = "";
    let lastNameGuess = "";

    // Name is usually the first non-contact, non-URL, short line
    const nameRegex = /^[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+(?:\s+[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+){1,4}$/;
    for (const hl of headerLines.slice(0, 8)) {
      const t = hl.text;
      if (t.length > 4 && t.length < 50
        && !t.includes("@") && !t.includes("http") && !t.includes("linkedin")
        && !t.includes("github") && !/^\+?\d/.test(t)
        && !t.includes("CV") && !t.includes("Curriculum") && !t.includes("Vitae")
        && !t.includes("Resumen") && !t.includes("Perfil")
        && !/^\d{1,2}[\.\-]/.test(t)
        && (nameRegex.test(t) || /^[A-ZÁÉÍÓÚÑÜ\s]+$/.test(t))) {
        fullNameGuess = t.replace(/\s+/g, " ").trim();
        // Handle ALL CAPS names
        if (/^[A-ZÁÉÍÓÚÑÜ\s]+$/.test(fullNameGuess)) {
          fullNameGuess = fullNameGuess.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
        }
        const nameParts = fullNameGuess.split(" ");
        firstNameGuess = nameParts[0] || "";
        lastNameGuess = nameParts.slice(1).join(" ") || "";
        break;
      }
    }

    // ── PASS 5: Extract headline from header (line after name, before sections) ──
    let detectedHeadline = "";
    const headlineKeywords = /(?:developer|desarrollador|engineer|ingeniero|architect|arquitecto|designer|diseñador|analyst|analista|consultant|consultor|manager|gerente|director|lead|líder|senior|junior|full.?stack|front.?end|back.?end|devops|data|cloud|mobile|web|software|product|project|scrum|qa|ux|ui)/i;
    for (const hl of headerLines.slice(0, 10)) {
      if (hl.text !== fullNameGuess && hl.text.length > 5 && hl.text.length < 80
        && headlineKeywords.test(hl.text)
        && !hl.text.includes("@") && !hl.text.includes("http")) {
        detectedHeadline = hl.text;
        break;
      }
    }

    // ── PASS 6: Extract summary from "summary"/"about" section or header description ──
    let detectedSummary = "";
    const summaryLines = sectionLines.filter(l => l.section === "summary");
    if (summaryLines.length > 0) {
      detectedSummary = summaryLines.map(l => l.text).join(" ").slice(0, 500);
    } else {
      // Try finding long paragraph lines in header section
      const longHeaderLines = headerLines.filter(l =>
        l.text.length > 60 && !l.text.includes("@") && !l.text.includes("http")
        && !nameRegex.test(l.text) && !headlineKeywords.test(l.text.slice(0, 30))
      );
      if (longHeaderLines.length > 0) {
        detectedSummary = longHeaderLines.map(l => l.text).join(" ").slice(0, 500);
      }
    }

    // ── PASS 7: Parse experience entries ──
    const dateRangeRegex = /(\b(?:20\d\d|19\d\d)\b(?:\s*[-–—a/]\s*(?:presente|actualidad|current|present|\b(?:20\d\d|19\d\d)\b))|\b(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\s*[-–—a/]\s*(?:presente|actualidad|current|present|[a-z]+\.?\s+\d{4}))/i;
    const expLines = sectionLines.filter(l => l.section === "experience");
    let currentExpObj = null;

    for (let i = 0; i < expLines.length; i++) {
      const line = expLines[i].text;
      const dateMatch = line.match(dateRangeRegex);
      const nextLine = expLines[i + 1]?.text || "";
      const nextDateMatch = nextLine.match(dateRangeRegex);

      // Detect a new experience block: line with date, or short line followed by date line
      const isNewExp = dateMatch || (line.length < 80 && !line.startsWith("•") && !line.startsWith("-") && !line.startsWith("*") && nextDateMatch);

      if (isNewExp) {
        // Save previous exp
        if (currentExpObj && (currentExpObj.company || currentExpObj.role)) {
          experiences.push(currentExpObj);
        }

        let period = dateMatch ? dateMatch[0] : (nextDateMatch ? nextDateMatch[0] : "");
        let textWithoutDate = line.replace(dateRangeRegex, "").trim().replace(/^[|\-–—,]+\s*/, "").replace(/\s*[|\-–—,]+$/, "");

        // If the date was on the next line, consume it
        if (!dateMatch && nextDateMatch) {
          period = nextDateMatch[0];
          // Next line might have more info besides the date
          const nextLineExtra = nextLine.replace(dateRangeRegex, "").trim();
          if (nextLineExtra.length > 3) textWithoutDate += " " + nextLineExtra;
          i++; // skip the date line
        }

        // Split role / company
        let company = "";
        let role = "";
        const separators = /\s*(?:\||\bat\b|\ben\b|–|—)\s*/i;

        if (separators.test(textWithoutDate)) {
          const parts = textWithoutDate.split(separators).map(s => s.trim()).filter(Boolean);
          if (parts.length >= 2) {
            role = parts[0];
            company = parts.slice(1).join(" ");
          } else {
            role = parts[0] || textWithoutDate;
          }
        } else {
          // Check if next non-date line is the company name
          const peek = expLines[i + 1]?.text || "";
          if (peek.length > 2 && peek.length < 60 && !peek.startsWith("•") && !peek.startsWith("-") && !peek.match(dateRangeRegex)) {
            role = textWithoutDate;
            company = peek;
            i++;
          } else {
            role = textWithoutDate;
          }
        }

        currentExpObj = {
          id: `exp_${experiences.length + 1}`,
          company: company || "",
          role: role || "",
          period: period,
          description: "",
          achievements: "",
          technologies: ""
        };
        continue;
      }

      // Append content to current experience
      if (currentExpObj) {
        if (/^(?:logros?|achievements?|impacto|resultados?|key\s*results?)\s*:?/i.test(line)) {
          const content = line.replace(/^(?:logros?|achievements?|impacto|resultados?|key\s*results?)\s*:?\s*/i, "");
          if (content) currentExpObj.achievements += (currentExpObj.achievements ? "\n" : "") + content;
        } else if (/^(?:tecnolog[ií]as?|stack|tools?|tech)\s*:?/i.test(line)) {
          currentExpObj.technologies = line.replace(/^(?:tecnolog[ií]as?|stack|tools?|tech)\s*:?\s*/i, "");
        } else if (/^[•\-\*▸▹➤➜→‣⁃]\s*/.test(line)) {
          const cleanBullet = line.replace(/^[•\-\*▸▹➤➜→‣⁃]\s*/, "");
          // Classify as achievement if it has metrics or impact words
          if (/(?:\d+%|\$[\d,.]+|USD|CLP|reducción|aumento|incremento|optimiz|mejor|lider[eéó]|implement[eéó]|diseñ[eéó]|migr[eéó]|automatiz|reduj|aument|deliver|reduced|increased|led|built|created|launched)/i.test(cleanBullet)) {
            currentExpObj.achievements += (currentExpObj.achievements ? "\n" : "") + "• " + cleanBullet;
          } else {
            currentExpObj.description += (currentExpObj.description ? "\n" : "") + "• " + cleanBullet;
          }
        } else if (line.length > 10 && currentExpObj.description.length < 500) {
          currentExpObj.description += (currentExpObj.description ? " " : "") + line;
        }
      }
    }

    if (currentExpObj && (currentExpObj.company || currentExpObj.role)) {
      experiences.push(currentExpObj);
    }

    // Auto-detect technologies per experience if empty
    experiences.forEach(exp => {
      if (!exp.technologies && exp.description) {
        const expTech = TECH_KEYWORDS.filter(t => {
          try {
            return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(exp.description + " " + exp.achievements);
          } catch (e) { return false; }
        });
        exp.technologies = expTech.join(", ");
      }
    });

    // ── PASS 8: Parse education ──
    const eduLines = sectionLines.filter(l => l.section === "education");
    const eduTitleRegex = /(?:ingenier[ií]a|licenciatura|t[eé]cnico|t[ií]tulo|bachelor|master|mba|mag[ií]ster|doctorado|phd|diplomado|bootcamp|certificaci[oó]n|degree|associate)/i;
    const institutionRegex = /(?:universidad|university|instituto|institute|college|escuela|school|academia|academy|u\.\s|univ\.|politécnic)/i;

    for (let i = 0; i < eduLines.length; i++) {
      const line = eduLines[i].text;
      const nextLine = eduLines[i + 1]?.text || "";
      const yearMatch = (line + " " + nextLine).match(/\b(20\d\d|19\d\d)\b/);

      if (eduTitleRegex.test(line) || institutionRegex.test(line)) {
        let degree = "";
        let institution = "";

        if (eduTitleRegex.test(line) && institutionRegex.test(line)) {
          // Both on same line, try to split
          degree = line;
          institution = line;
        } else if (eduTitleRegex.test(line)) {
          degree = line;
          if (institutionRegex.test(nextLine) || (nextLine.length > 3 && nextLine.length < 80 && !nextLine.match(dateRangeRegex))) {
            institution = nextLine;
            i++;
          }
        } else if (institutionRegex.test(line)) {
          institution = line;
          if (eduTitleRegex.test(nextLine)) {
            degree = nextLine;
            i++;
          } else {
            degree = line;
          }
        }

        education.push({
          id: `edu_${education.length + 1}`,
          degree: degree.trim(),
          institution: institution.trim(),
          year: yearMatch ? yearMatch[0] : ""
        });
      }
    }

    // ── PASS 9: Parse projects ──
    const projLines = sectionLines.filter(l => l.section === "projects");
    let currentProj = null;

    for (let i = 0; i < projLines.length; i++) {
      const line = projLines[i].text;

      if (line.length < 80 && !line.startsWith("•") && !line.startsWith("-") && !line.startsWith("*")) {
        if (currentProj && currentProj.name) projects.push(currentProj);
        currentProj = {
          id: `proj_${projects.length + 1}`,
          name: line,
          description: "",
          technologies: ""
        };
      } else if (currentProj) {
        if (/^(?:tecnolog[ií]as?|stack|tools?|tech)\s*:?/i.test(line)) {
          currentProj.technologies = line.replace(/^(?:tecnolog[ií]as?|stack|tools?|tech)\s*:?\s*/i, "");
        } else {
          const clean = line.replace(/^[•\-\*▸]\s*/, "");
          currentProj.description += (currentProj.description ? " " : "") + clean;
        }
      }
    }
    if (currentProj && currentProj.name) projects.push(currentProj);

    // Auto-fill project tech if empty
    projects.forEach(proj => {
      if (!proj.technologies && proj.description) {
        const projTech = TECH_KEYWORDS.filter(t => {
          try {
            return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(proj.description);
          } catch (e) { return false; }
        });
        proj.technologies = projTech.join(", ");
      }
    });

    // ── PASS 10: Extract city/country ──
    let city = "";
    let country = "";
    if (cityCountryMatch) {
      const parts = cityCountryMatch[0].split(/\s*[,\-–]\s*/);
      city = parts[0]?.trim() || "";
      country = parts[1]?.trim() || "";
      // Capitalize
      city = city.charAt(0).toUpperCase() + city.slice(1);
      if (country) country = country.charAt(0).toUpperCase() + country.slice(1);
    }

    // ── PASS 11: Calculate years of experience ──
    let yearsOfExperience = "";
    const allYears = [...cvText.matchAll(/\b(20\d\d|19\d\d)\b/g)].map(m => parseInt(m[1]));
    if (allYears.length >= 2) {
      const minYear = Math.min(...allYears);
      const maxYear = Math.max(...allYears);
      const currentYear = new Date().getFullYear();
      const endYear = /presente|actualidad|current|present/i.test(cvText) ? currentYear : maxYear;
      yearsOfExperience = String(Math.max(1, endYear - minYear));
    }

    // ── Final headline fallback ──
    if (!detectedHeadline) {
      detectedHeadline = experiences[0]?.role || "";
    }

    // ── Final summary fallback ──
    if (!detectedSummary && experiences.length > 0) {
      const topRoles = experiences.slice(0, 2).map(e => e.role).filter(Boolean).join(", ");
      const topCompanies = experiences.slice(0, 2).map(e => e.company).filter(Boolean).join(", ");
      detectedSummary = `Profesional con experiencia en ${topRoles}${topCompanies ? ` en ${topCompanies}` : ""}. Tecnologías: ${detectedTech.slice(0, 8).join(", ")}.`;
    }

    return {
      firstName: firstNameGuess,
      lastName: lastNameGuess,
      fullName: fullNameGuess,
      email: emailMatch ? emailMatch[0] : "",
      phone: phoneMatch ? phoneMatch[0] : "",
      rut: rutMatch ? rutMatch[0] : "",
      city: city,
      country: country,
      linkedinUrl: linkedinMatch ? (linkedinMatch[0].startsWith("http") ? linkedinMatch[0] : `https://${linkedinMatch[0]}`) : "",
      githubUrl: githubMatch ? (githubMatch[0].startsWith("http") ? githubMatch[0] : `https://${githubMatch[0]}`) : "",
      portfolioUrl: portfolioMatch && !linkedinMatch?.[0]?.includes(portfolioMatch[0]) && !githubMatch?.[0]?.includes(portfolioMatch[0])
        ? (portfolioMatch[0].startsWith("http") ? portfolioMatch[0] : `https://${portfolioMatch[0]}`) : "",
      headline: detectedHeadline,
      summary: detectedSummary,
      skills: detectedTech.join(", "),
      degree: education[0]?.degree || "",
      university: education[0]?.institution || "",
      yearsOfExperience: yearsOfExperience,
      experiences,
      projects,
      education,
      rawText: cvText,
      parsedAt: new Date().toISOString()
    };
  }

  function fallbackToLocalParsing(text, reason = "") {
    const localParsed = parseCvLocally(text);
    localCvDatabase = {
      rawText: text,
      parsedAt: localParsed.parsedAt,
      experiences: localParsed.experiences || [],
      projects: localParsed.projects || [],
      education: localParsed.education || []
    };
    renderCvDatabase();

    applyFullProfileExtraction(localParsed, text);

    completeProgress(true, `✅ [100%] ¡Perfil y Base de Datos completados con Motor Nativo! (${localCvDatabase.experiences.length} cargos, ${localCvDatabase.projects.length} proyectos)`);
  }

  function applyFullProfileExtraction(data, rawText) {
    const current = localProfiles.find(p => p.id === activeProfileId);
    if (!current) return;

    // Apply personal info if found and empty or update
    if (data.firstName) current.firstName = data.firstName;
    if (data.lastName) current.lastName = data.lastName;
    if (data.fullName) current.fullName = data.fullName;
    if (data.email) current.email = data.email;
    if (data.phone) current.phone = data.phone;
    if (data.rut) current.rut = data.rut;
    if (data.city) current.city = data.city;
    if (data.country) current.country = data.country;
    if (data.linkedinUrl) current.linkedinUrl = data.linkedinUrl;
    if (data.githubUrl) current.githubUrl = data.githubUrl;
    if (data.portfolioUrl) current.portfolioUrl = data.portfolioUrl;
    if (data.headline) {
      current.headline = data.headline;
      current.targetRole = data.headline;
    }
    if (data.summary) current.summary = data.summary;
    if (data.skills) {
      current.skills = data.skills;
      current.keywords = data.skills;
    }
    if (data.degree) current.degree = data.degree;
    if (data.university) current.university = data.university;
    if (data.yearsOfExperience) current.yearsOfExperience = String(data.yearsOfExperience);

    current.resumeText = rawText;
    current.cvDatabase = {
      rawText: rawText,
      parsedAt: data.parsedAt || new Date().toISOString(),
      experiences: data.experiences || [],
      projects: data.projects || [],
      education: data.education || []
    };

    syncSharedFieldsAcrossProfiles(current, localProfiles);

    // Update DOM inputs across all tabs
    loadActiveProfileIntoDOM();
    renderGlobalProfileSelector();

    // Persist immediately
    chrome.storage.local.set(candidateDataFromProfiles(localProfiles, activeProfileId));
  }

  function renderCvDatabase() {
    if (!cvExperiencesList || !cvProjectsList) return;

    cvExperiencesList.innerHTML = "";
    cvProjectsList.innerHTML = "";

    const exps = localCvDatabase.experiences || [];
    const projs = localCvDatabase.projects || [];

    if (cvDbStatsBadge) {
      cvDbStatsBadge.textContent = `${exps.length} Cargo${exps.length === 1 ? "" : "s"} | ${projs.length} Proyecto${projs.length === 1 ? "" : "s"}`;
    }

    if (exps.length === 0) {
      cvExperiencesList.innerHTML = `<div style="color: #64748b; font-size: 13px;">No hay cargos registrados. Pulsa "+ Agregar Cargo" o convierte tu CV con IA.</div>`;
    } else {
      exps.forEach((exp, idx) => {
        const card = document.createElement("div");
        card.className = "cv-exp-card";
        card.innerHTML = `
          <div class="qa-header">
            <span style="font-weight:700; color:#a5b4fc; font-size:13px;">💼 Cargo #${idx + 1}</span>
            <button type="button" class="btn-delete-cv-exp btn-delete-cf" data-idx="${idx}">✕ Eliminar</button>
          </div>
          <div class="cv-exp-grid">
            <div>
              <label>Empresa:</label>
              <input type="text" class="cv-exp-company" value="${escapeHtml(exp.company)}" placeholder="Ej: Tech Corp">
            </div>
            <div>
              <label>Cargo / Rol:</label>
              <input type="text" class="cv-exp-role" value="${escapeHtml(exp.role)}" placeholder="Ej: Senior Full Stack Developer">
            </div>
            <div>
              <label>Período:</label>
              <input type="text" class="cv-exp-period" value="${escapeHtml(exp.period)}" placeholder="Ej: 2022 - Presente">
            </div>
          </div>
          <div>
            <label style="margin-top: 4px;">Responsabilidades Principales:</label>
            <textarea class="cv-exp-desc" rows="2" placeholder="Resumen de responsabilidades...">${escapeHtml(exp.description)}</textarea>
          </div>
          <div>
            <label style="margin-top: 4px;">Logros Clave y Métricas (Utilizados por Claude para argumentar idoneidad en postulaciones):</label>
            <textarea class="cv-exp-achieve" rows="2" placeholder="Ej: Aumento del 40% en performance, reducción de costos AWS en 25%...">${escapeHtml(exp.achievements)}</textarea>
          </div>
          <div>
            <label style="margin-top: 4px;">Tecnologías Utilizadas:</label>
            <input type="text" class="cv-exp-tech" value="${escapeHtml(exp.technologies)}" placeholder="Ej: React, Python, PostgreSQL, Docker, AWS">
          </div>
        `;
        cvExperiencesList.appendChild(card);
      });
    }

    if (projs.length === 0) {
      cvProjectsList.innerHTML = `<div style="color: #64748b; font-size: 13px;">No hay proyectos registrados. Pulsa "+ Agregar Proyecto".</div>`;
    } else {
      projs.forEach((proj, idx) => {
        const card = document.createElement("div");
        card.className = "cv-exp-card";
        card.innerHTML = `
          <div class="qa-header">
            <span style="font-weight:700; color:#a5b4fc; font-size:13px;">🚀 Proyecto #${idx + 1}</span>
            <button type="button" class="btn-delete-cv-proj btn-delete-cf" data-idx="${idx}">✕ Eliminar</button>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label>Nombre del Proyecto:</label>
              <input type="text" class="cv-proj-name" value="${escapeHtml(proj.name)}" placeholder="Ej: Plataforma de E-Commerce">
            </div>
            <div>
              <label>Stack Tecnológico:</label>
              <input type="text" class="cv-proj-tech" value="${escapeHtml(proj.technologies)}" placeholder="Ej: FastAPI, React, Redis">
            </div>
          </div>
          <div>
            <label style="margin-top: 4px;">Descripción e Impacto:</label>
            <textarea class="cv-proj-desc" rows="2" placeholder="Objetivo del proyecto e impacto alcanzado...">${escapeHtml(proj.description)}</textarea>
          </div>
        `;
        cvProjectsList.appendChild(card);
      });
    }

    // Attach delete listeners
    cvExperiencesList.querySelectorAll(".btn-delete-cv-exp").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        localCvDatabase = extractCvDatabaseFromDOM();
        localCvDatabase.experiences.splice(idx, 1);
        renderCvDatabase();
        scheduleSave();
      });
    });

    cvProjectsList.querySelectorAll(".btn-delete-cv-proj").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        localCvDatabase = extractCvDatabaseFromDOM();
        localCvDatabase.projects.splice(idx, 1);
        renderCvDatabase();
        scheduleSave();
      });
    });
  }

  function extractCvDatabaseFromDOM() {
    if (!cvExperiencesList || !cvProjectsList) return localCvDatabase;

    const expCards = cvExperiencesList.querySelectorAll(".cv-exp-card");
    const experiences = [];
    expCards.forEach((card, idx) => {
      const company = card.querySelector(".cv-exp-company")?.value?.trim() || "";
      const role = card.querySelector(".cv-exp-role")?.value?.trim() || "";
      const period = card.querySelector(".cv-exp-period")?.value?.trim() || "";
      const description = card.querySelector(".cv-exp-desc")?.value?.trim() || "";
      const achievements = card.querySelector(".cv-exp-achieve")?.value?.trim() || "";
      const technologies = card.querySelector(".cv-exp-tech")?.value?.trim() || "";
      if (company || role || description || achievements) {
        experiences.push({ id: `exp_${idx + 1}`, company, role, period, description, achievements, technologies });
      }
    });

    const projCards = cvProjectsList.querySelectorAll(".cv-exp-card");
    const projects = [];
    projCards.forEach((card, idx) => {
      const name = card.querySelector(".cv-proj-name")?.value?.trim() || "";
      const technologies = card.querySelector(".cv-proj-tech")?.value?.trim() || "";
      const description = card.querySelector(".cv-proj-desc")?.value?.trim() || "";
      if (name || description) {
        projects.push({ id: `proj_${idx + 1}`, name, technologies, description });
      }
    });

    return {
      rawText: resumeTextInput?.value || "",
      parsedAt: localCvDatabase.parsedAt || new Date().toISOString(),
      experiences,
      projects,
      education: localCvDatabase.education || []
    };
  }

  if (btnAddCvExp) {
    btnAddCvExp.addEventListener("click", () => {
      localCvDatabase = extractCvDatabaseFromDOM();
      if (!localCvDatabase.experiences) localCvDatabase.experiences = [];
      localCvDatabase.experiences.push({ id: `exp_${Date.now()}`, company: "", role: "", period: "", description: "", achievements: "", technologies: "" });
      renderCvDatabase();
    });
  }

  if (btnAddCvProj) {
    btnAddCvProj.addEventListener("click", () => {
      localCvDatabase = extractCvDatabaseFromDOM();
      if (!localCvDatabase.projects) localCvDatabase.projects = [];
      localCvDatabase.projects.push({ id: `proj_${Date.now()}`, name: "", technologies: "", description: "" });
      renderCvDatabase();
    });
  }

  // ─── Fuente de verdad en Markdown ─────────────────────────────────────────
  // Búsquedas perezosas (no `const` de módulo): loadActiveProfileIntoDOM()
  // llama a renderMarkdownSources() durante el arranque, ANTES de que la
  // ejecución llegue a esta parte del archivo.
  const mdDropzone = document.getElementById("mdDropzone");
  const mdFileInput = document.getElementById("mdFileInput");
  const btnApplyMdFields = document.getElementById("btnApplyMdFields");

  function parsedMarkdown() {
    return localMarkdownSources.length ? JobFillMarkdown.parseMarkdownSources(localMarkdownSources) : null;
  }

  function formatBytes(n) {
    return n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
  }

  /** Tarjeta por archivo, con lo que se entendió de él (o por qué no sirve). */
  function renderMarkdownSources() {
    const mdSourcesList = document.getElementById("mdSourcesList");
    if (!mdSourcesList) return;
    mdSourcesList.replaceChildren();

    for (const source of localMarkdownSources) {
      const parsed = JobFillMarkdown.parseMarkdownSources([source]);
      const summary = JobFillMarkdown.summarizeParsed(parsed);

      const card = document.createElement("div");
      card.className = "md-source-card";

      const head = document.createElement("div");
      head.className = "md-source-head";
      const name = document.createElement("strong");
      name.textContent = `📄 ${source.name}`;
      const meta = document.createElement("span");
      meta.className = "md-source-meta";
      meta.textContent = `${formatBytes(source.content.length)} · importado ${new Date(source.importedAt).toLocaleString("es-CL")}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn-delete-cf";
      remove.textContent = "Quitar";
      remove.addEventListener("click", () => {
        localMarkdownSources = localMarkdownSources.filter(s => s.name !== source.name);
        syncStructuredDbFromMarkdown();
        renderMarkdownSources();
        scheduleSave();
      });
      head.append(name, meta, remove);

      const facts = document.createElement("ul");
      facts.className = "md-source-facts";
      const fact = (text, tone = "") => {
        const li = document.createElement("li");
        li.textContent = text;
        if (tone) li.className = tone;
        facts.appendChild(li);
      };
      if (summary.sections) fact(`✓ ${summary.sections} experiencias/proyectos con ${summary.achievements} logros`);
      else fact("⚠️ No se encontraron secciones de experiencia (encabezados ## con logros en viñetas).", "warn");
      fact(summary.hasRules ? "✓ REGLAS DE USO: se aplican literalmente en cada respuesta" : "Sin sección REGLAS DE USO (opcional)");
      if (summary.excluded.length) fact(`🚫 Nunca se envían (su nota dice "NUNCA va en un CV"): ${summary.excluded.join(", ")}`);
      if (summary.estimatedMetricsRemoved) fact(`🚫 ${summary.estimatedMetricsRemoved} métricas ESTIMADA se omiten siempre`);

      card.append(head, facts);
      mdSourcesList.appendChild(card);
    }

    renderDetectedFields();
  }

  /** Campos que el .md trae, para ofrecer completar los vacíos de "Mis datos". */
  function renderDetectedFields() {
    const mdDetectedFields = document.getElementById("mdDetectedFields");
    const mdDetectedList = document.getElementById("mdDetectedList");
    if (!mdDetectedFields) return;
    const parsed = parsedMarkdown();
    const fields = parsed ? JobFillMarkdown.markdownToProfileFields(parsed) : {};
    const keys = Object.keys(fields).filter(k => MD_FIELD_LABELS[k]);
    mdDetectedFields.hidden = keys.length === 0;
    mdDetectedList.replaceChildren();
    for (const key of keys) {
      const dt = document.createElement("dt");
      dt.textContent = MD_FIELD_LABELS[key];
      const dd = document.createElement("dd");
      dd.textContent = fields[key].length > 140 ? `${fields[key].slice(0, 140)}…` : fields[key];
      mdDetectedList.append(dt, dd);
    }
  }

  /**
   * La base estructurada (cargos/logros/tecnologías) se regenera desde el
   * .md: la usan el ranking por oferta y la verificación de requisitos. Sin
   * .md, se conserva la que haya (CV procesado o editado a mano).
   */
  function syncStructuredDbFromMarkdown() {
    const parsed = parsedMarkdown();
    if (!parsed || !parsed.sections.length) return;
    localCvDatabase = JobFillMarkdown.markdownToCvDatabase(parsed, "");
    renderCvDatabase();
  }

  async function importMarkdownFiles(fileList) {
    const files = [...fileList].filter(f => /\.(md|markdown)$/i.test(f.name) || f.type === "text/markdown");
    if (!files.length) {
      showSaveFeedback("⚠️ Solo se aceptan archivos .md");
      return;
    }
    const t0 = performance.now();
    for (const file of files) {
      const content = await file.text();
      const entry = { name: file.name, content, importedAt: Date.now() };
      // Reimportar el mismo archivo lo REEMPLAZA: así se actualiza la BASE.
      const idx = localMarkdownSources.findIndex(s => s.name === file.name);
      if (idx >= 0) localMarkdownSources[idx] = entry;
      else localMarkdownSources.push(entry);
    }
    syncStructuredDbFromMarkdown();
    renderMarkdownSources();
    await persistAll();
    showSaveFeedback(`✓ ${files.length} archivo${files.length > 1 ? "s" : ""} importado${files.length > 1 ? "s" : ""} en ${Math.max(1, Math.round(performance.now() - t0))} ms`);
  }

  if (mdDropzone && mdFileInput) {
    mdDropzone.addEventListener("click", () => mdFileInput.click());
    mdDropzone.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); mdFileInput.click(); }
    });
    mdFileInput.addEventListener("change", () => {
      importMarkdownFiles(mdFileInput.files);
      mdFileInput.value = "";
    });
    ["dragenter", "dragover"].forEach(type => mdDropzone.addEventListener(type, e => {
      e.preventDefault();
      mdDropzone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach(type => mdDropzone.addEventListener(type, e => {
      e.preventDefault();
      mdDropzone.classList.remove("is-dragging");
    }));
    mdDropzone.addEventListener("drop", e => importMarkdownFiles(e.dataTransfer.files));
  }

  btnApplyMdFields?.addEventListener("click", () => {
    const parsed = parsedMarkdown();
    if (!parsed) return;
    const fields = JobFillMarkdown.markdownToProfileFields(parsed);
    let filled = 0;
    for (const [key, value] of Object.entries(fields)) {
      const input = profileForm.elements[key];
      // Solo lo vacío: nunca se pisa algo que el usuario ya escribió.
      if (!input || (input.value || "").trim()) continue;
      if (input.tagName === "SELECT" && ![...input.options].some(o => o.value === value)) continue;
      input.value = value;
      filled++;
    }
    showSaveFeedback(filled ? `✓ ${filled} campos completados desde tu .md` : "Tus datos ya estaban completos: no se cambió nada");
    if (filled) scheduleSave();
  });

  // ─── Inicio: checklist de configuración ──────────────────────────────────
  async function renderSetupChecklist() {
    const container = document.getElementById("setupSteps");
    if (!container) return;
    const stored = await chrome.storage.local.get(null);
    const base = stored.candidateBase || {};
    const mdCount = (base.markdownSources || []).length;
    const expCount = base.cvDatabase?.experiences?.length || 0;
    const ai = JobFillAi.readAiSettings(stored);

    const steps = [
      {
        done: mdCount > 0 || expCount > 0,
        title: "Carga tu experiencia",
        detail: mdCount ? `${mdCount} archivo${mdCount > 1 ? "s" : ""} .md como fuente de verdad` : expCount ? `${expCount} cargos cargados desde tu CV` : "Importa tu BASE en Markdown (instantáneo) o tu CV",
        tab: "tab-source",
        action: "Ir a Fuente de verdad"
      },
      {
        done: JobFillAi.hasAiCredentials(ai),
        title: "Conecta la IA",
        detail: JobFillAi.hasAiCredentials(ai)
          ? `${JobFillAi.describeProvider(ai.provider)}${JobFillAi.hasGeminiFallback(ai) ? " + respaldo Gemini" : ""}`
          : "Pega tu API Key de Claude (o de Gemini)",
        tab: "tab-claude",
        action: "Ir a Inteligencia artificial"
      },
      {
        done: Boolean(base.email && base.phone && (base.firstName || base.fullName)),
        title: "Revisa tus datos de contacto",
        detail: base.email ? `${base.fullName || base.firstName || ""} · ${base.email}${base.phone ? ` · ${base.phone}` : " · falta teléfono"}` : "Nombre, email y teléfono (tu .md puede completarlos)",
        tab: "tab-personal tab-links tab-experience tab-education tab-legal",
        action: "Ir a Mis datos"
      }
    ];

    container.replaceChildren();
    steps.forEach((step, i) => {
      const card = document.createElement("div");
      card.className = `setup-step ${step.done ? "is-done" : ""}`;
      const badge = document.createElement("div");
      badge.className = "setup-step-badge";
      badge.textContent = step.done ? "✓" : String(i + 1);
      const text = document.createElement("div");
      text.className = "setup-step-text";
      const title = document.createElement("strong");
      title.textContent = step.title;
      const detail = document.createElement("span");
      detail.textContent = step.detail;
      text.append(title, detail);
      const go = document.createElement("button");
      go.type = "button";
      go.className = step.done ? "btn-secondary" : "btn-primary";
      go.textContent = step.done ? "Revisar" : step.action;
      go.addEventListener("click", () => document.querySelector(`.nav-item[data-tab="${step.tab}"]`)?.click());
      card.append(badge, text, go);
      container.appendChild(card);
    });
  }

  // Backup - Export
  if (btnExportJson) {
    btnExportJson.addEventListener("click", async () => {
      const allData = await chrome.storage.local.get(null);
      // Las API keys NO van en el respaldo: es un archivo que termina en
      // Descargas, Drive o un correo, y con la key cualquiera puede gastar tu
      // saldo. Al importarlo, las keys que ya tengas configuradas se
      // conservan (storage.set fusiona).
      for (const key of BACKUP_EXCLUDED_KEYS) delete allData[key];
      const blob = new Blob([JSON.stringify(allData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `JobFill_AI_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      // Revocar en el mismo tick puede cancelar la descarga en algunos navegadores.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  // Backup - Import
  if (btnImportJson && importFileInput) {
    btnImportJson.addEventListener("click", () => {
      importFileInput.click();
    });

    importFileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const importedData = JSON.parse(event.target.result);

          // Solo se acepta algo con forma de respaldo de JobFill AI: un JSON
          // cualquiera (o un array) se escribía tal cual en storage.
          const isPlainObject = importedData && typeof importedData === "object" && !Array.isArray(importedData);
          const looksLikeBackup = isPlainObject && (importedData.candidateBase || Array.isArray(importedData.profiles));
          if (!looksLikeBackup) {
            alert("❌ Ese archivo no parece un respaldo de JobFill AI (no trae datos de perfil).");
            return;
          }
          // Un respaldo nunca debería traer keys (ya no se exportan), pero uno
          // viejo sí: no se deja que pise las que están configuradas ahora.
          for (const key of BACKUP_EXCLUDED_KEYS) delete importedData[key];

          // Respaldo PRE-rediseño (trae `profiles[]`, no `candidateBase`):
          // hay que borrar el esquema nuevo actual antes de escribirlo. Si no,
          // `set()` fusiona y sobreviven tanto el `candidateBase` viejo como
          // `schemaVersion: 2`, así que la migración se salta por "ya
          // migrado" y el `profiles[]` recién importado nunca se convierte:
          // la importación no haría nada visible.
          const esRespaldoViejo = !importedData.candidateBase && Array.isArray(importedData.profiles);
          if (esRespaldoViejo) {
            await chrome.storage.local.remove(["candidateBase", "cvIndexes", "activeCvIndexId", "schemaVersion"]);
          }

          await chrome.storage.local.set(importedData);
          alert("✅ Respaldo importado con éxito. Se recargará la página.");
          location.reload();
        } catch (err) {
          alert("❌ Error al importar JSON: Formato inválido.");
        }
      };
      reader.readAsText(file);
    });
  }
});
