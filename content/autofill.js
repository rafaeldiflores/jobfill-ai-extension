/**
 * JobFill AI - Content Script
 * Heuristic Autofill Engine & Claude AI Assistant for Job Application Forms
 */

(function () {
  if (window.__JOBFILL_AI_LOADED__) return;
  window.__JOBFILL_AI_LOADED__ = true;

  // El content script corre en todos los frames (all_frames) para llegar a
  // los formularios embebidos en iframes. El widget, los diálogos y la
  // orquestación de "Postular" viven SOLO en el frame principal; los iframes
  // exponen una API mínima (JobFillFrame, abajo) que el service worker llama.
  const IS_TOP_FRAME = (() => { try { return window.top === window; } catch (e) { return false; } })();

  // Selectores por portal y elección de opciones (content/portals.js).
  const Portals = self.JobFillPortals;

  let activeProfile = null;
  let currentAiBtn = null;

  /**
   * Un `<dialog>` nativo abierto con `showModal()` — como el modal "Aplicar"
   * de Easy Apply en LinkedIn — se pinta en el TOP LAYER del navegador, una
   * capa por ENCIMA de todo el documento normal que ningún z-index, por alto
   * que sea, puede superar. Es la causa real de "al mostrar el popup deja de
   * funcionar": el widget flotante y los diálogos propios seguían viéndose,
   * pero quedaban detrás del backdrop del modal en el hit-test — los clics
   * nunca les llegaban.
   *
   * Se probó primero promover nuestros propios elementos al top layer con la
   * Popover API (`showPopover()`), pero verificado contra el modal real de
   * LinkedIn, NO alcanza: Easy Apply reabre/reemplaza su `<dialog>` en cada
   * paso del formulario, lo que lo vuelve a empujar al frente del top layer
   * después de nuestro popover, y el clic se pierde igual. La única forma
   * fiable es no competir por ORDEN dentro del top layer, sino vivir DENTRO
   * del propio `<dialog>` ajeno: un hijo de un elemento ya en el top layer
   * hereda esa posición sin depender de en qué orden se abrió cada cosa —
   * confirmado en vivo contra el modal de Easy Apply antes de fijar este
   * enfoque. `position: fixed` en nuestros elementos se sigue calculando
   * contra el viewport igual que si vivieran en `document.body`: un
   * `<dialog>` no crea un nuevo "containing block" para descendientes fixed
   * por el solo hecho de estar en el top layer.
   */
  function currentTopLayerHost() {
    return document.querySelector("dialog[open]") || document.body;
  }

  function attachToTopLayerHost(el) {
    const host = currentTopLayerHost();
    if (el.parentNode !== host) host.appendChild(el);
  }

  /**
   * El widget flotante se crea UNA vez al cargar la página, casi siempre
   * antes de que exista ningún `<dialog>` — así que necesita un vigía que lo
   * reubique cuando un modal ajeno aparezca (o desaparezca) después. Los
   * demás elementos (botón ✨, diálogos propios, toasts) se crean bajo
   * demanda mientras el usuario interactúa, así que simplemente preguntan por
   * el host correcto en el momento de aparecer — no necesitan este vigía.
   */
  let topLayerWatcherAttached = false;
  function ensureTopLayerWatcher() {
    if (topLayerWatcherAttached) return;
    topLayerWatcherAttached = true;

    let pending = false;
    const recheck = () => {
      pending = false;
      const widget = document.querySelector(".jobfill-floating-container");
      if (widget) attachToTopLayerHost(widget);
    };

    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(recheck, 200);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  }

  /**
   * Año de egreso a partir de lo que el perfil tenga guardado en
   * `education[].year`, que en la práctica llega en formas muy distintas:
   * "2022", 2022, "2018-2022", "2018 a 2022". Se toma SIEMPRE el último año
   * de cuatro dígitos: en un rango es el de egreso, y en un valor simple es
   * el único que hay. Sin ningún año reconocible devuelve "" — el motor trata
   * eso como "sin dato" y no toca el campo.
   */
  function extractGraduationYear(rawYear) {
    if (rawYear === undefined || rawYear === null) return "";
    const years = String(rawYear).match(/\b(19|20)\d{2}\b/g);
    return years ? years[years.length - 1] : "";
  }

  function normalizeText(str) {
    if (!str) return "";
    return str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const FIELD_RULES = [
    {
      key: "rut",
      regex: /(rut|run|dni|c[eé]dula|identificaci[oó]n|national[\s_-]?id|tax[\s_-]?id|documento[\s_-]?(de[\s_-]?)?identidad|nif|nie|carnet|passport|pasaporte)/i,
      getValue: (p) => p.rut
    },
    {
      key: "fullName",
      regex: /^(full[\s_-]?name|nombre[\s_-]?completo|candidate[\s_-]?name|your[\s_-]?name|nombre[\s_-]?y[\s_-]?apellidos|nombre$|name$)/i,
      getValue: (p) => p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim()
    },
    {
      key: "firstName",
      // "nombre" a secas solo cuenta si NO va seguido de un calificador que
      // apunte a otra entidad: "Nombre de la empresa", "Nombre del proyecto",
      // "Nombre de usuario", "Nombre de la universidad" y "Nombre de contacto
      // de emergencia" NO son el nombre de pila del candidato. Sin esta
      // exclusión, esta regla (que además está temprana en el array) secuestraba
      // todos esos campos.
      regex: /(first[\s_-]?name|primer[\s_-]?nombre|given[\s_-]?name|fname|forename|nombre(?!\s*(?:completo|y\s+apellido))(?!.*apellido)(?!\s+(?:de|del)\s+(?:la\s+|el\s+|tu\s+|su\s+)?(?:empresa|compa[ñn][ií]a|organizaci[oó]n|instituci[oó]n|universidad|proyecto|usuario|contacto|referencia|supervisor|jefatura|emergencia))|candidate[\s_-]?first)/i,
      getValue: (p) => p.firstName || (p.fullName ? p.fullName.split(" ")[0] : "")
    },
    {
      // "Segundo Nombre" (middle name) es un campo real y DISTINTO del apellido
      // en formularios formales chilenos ("Nombre / Segundo Nombre / Apellido
      // Paterno / Apellido Materno"). Antes vivía por error dentro del regex de
      // "lastName" (ver abajo) — un formulario con esos 4 campos recibía el
      // APELLIDO completo en la casilla de segundo nombre.
      key: "middleName",
      regex: /(segundo[\s_-]?nombre|middle[\s_-]?name)/i,
      getValue: (p) => p.middleName
    },
    {
      // "primer apellido" NO va aquí: en español es sinónimo de "apellido
      // paterno" (legalmente el primer apellido de una persona), y esa
      // combinación específica ya la cubre la regla lastNamePaternal de abajo,
      // con un match más largo que le gana por puntaje. Repetirlo aquí
      // empataría el puntaje de ambas reglas para ese label, y en un empate
      // gana la primera del array — esta, la genérica — devolviendo el
      // apellido completo en un campo que solo quiere el paterno.
      key: "lastName",
      regex: /(last[\s_-]?name|apellidos?|family[\s_-]?name|lname|surname|candidate[\s_-]?last)/i,
      getValue: (p) => p.lastName || (p.fullName ? p.fullName.split(" ").slice(1).join(" ") : "")
    },
    {
      // Formularios chilenos suelen pedir el apellido paterno y materno como
      // DOS campos separados. La regla "lastName" de arriba matchea ambos por
      // igual (los dos contienen "apellido") y les pegaba el mismo valor
      // completo a los dos — el bug real: "Díaz Flores" en el campo paterno Y
      // en el materno. Estas dos reglas son más específicas (match más largo:
      // "apellido paterno" vs "apellido" a secas), así que el motor de scoring
      // las prefiere automáticamente sobre la genérica cuando el label trae la
      // palabra completa "paterno"/"materno".
      key: "lastNamePaternal",
      regex: /(apellido[\s_-]?paterno|primer[\s_-]?apellido(?!\s+materno)|paternal[\s_-]?surname|father'?s?[\s_-]?last[\s_-]?name|surname[\s_-]?1)/i,
      // Convención chilena: el campo "Apellido" del perfil guarda ambos
      // apellidos juntos ("Díaz Flores"). Sin un campo explícito de paterno,
      // se toma la PRIMERA palabra — es lo mismo que ya hace este archivo para
      // derivar firstName/lastName desde fullName (línea 44/49), no una
      // heurística nueva.
      getValue: (p) => p.lastNamePaternal || (p.lastName ? p.lastName.trim().split(/\s+/)[0] : "")
    },
    {
      key: "lastNameMaternal",
      regex: /(apellido[\s_-]?materno|segundo[\s_-]?apellido|maternal[\s_-]?surname|mother'?s?[\s_-]?last[\s_-]?name|surname[\s_-]?2)/i,
      getValue: (p) => p.lastNameMaternal || (p.lastName ? p.lastName.trim().split(/\s+/).slice(1).join(" ") : "")
    },
    {
      key: "email",
      regex: /(email|e-mail|correo|correo[\s_-]?electronico|candidate[\s_-]?email)/i,
      getValue: (p) => p.email
    },
    {
      key: "phone",
      regex: /(phone|telephone|tel[eé]fono|celular|mobile|phone[\s_-]?number|candidate[\s_-]?phone|numero[\s_-]?contacto)/i,
      getValue: (p) => p.phone
    },
    {
      // "fecha de nacimiento" ancla en "fecha", así que no compite con "país
      // de nacimiento" (un campo real y distinto que algunos formularios piden
      // aparte) — ese no tiene la palabra "fecha", no hace falta excluirlo a mano.
      key: "birthDate",
      regex: /(fecha[\s_-]?de[\s_-]?nacimiento|fecha[\s_-]?nacimiento|date[\s_-]?of[\s_-]?birth|birth[\s_-]?date|birthday)/i,
      // Sin derivación posible: a diferencia de firstName/lastName (que se
      // pueden partir de fullName), no hay ningún otro dato del que inferir de
      // forma segura una fecha de nacimiento. Vacío si el usuario no lo cargó.
      getValue: (p) => p.birthDate
    },
    {
      key: "country",
      regex: /(country|nationality|pa[ií]s|nacionalidad|citizenship)/i,
      getValue: (p) => p.country
    },
    {
      key: "city",
      regex: /(city|ciudad|municipio|provincia|state|region|location|ubicaci[oó]n)/i,
      getValue: (p) => p.city
    },
    {
      key: "address",
      regex: /(address|direcci[oó]n|domicilio|street|calle)/i,
      getValue: (p) => p.address
    },
    {
      key: "postalCode",
      regex: /(zip|postal|c[oó]digo[\s_-]?postal|pincode)/i,
      getValue: (p) => p.postalCode
    },
    {
      key: "linkedinUrl",
      regex: /(linkedin|linked[\s_-]?in|perfil[\s_-]?linkedin)/i,
      getValue: (p) => p.linkedinUrl
    },
    {
      key: "githubUrl",
      regex: /(github|git[\s_-]?hub|repositorio)/i,
      getValue: (p) => p.githubUrl
    },
    {
      key: "portfolioUrl",
      regex: /(portfolio|portafolio|website|sitio[\s_-]?web|personal[\s_-]?url|blog)/i,
      getValue: (p) => p.portfolioUrl || p.websiteUrl
    },
    {
      key: "twitterUrl",
      regex: /(twitter|x[\s_-]?handle|x[\s_-]?profile)/i,
      getValue: (p) => p.twitterUrl
    },
    {
      key: "currentTitle",
      regex: /(current[\s_-]?title|job[\s_-]?title|current[\s_-]?position|\bposition\b|cargo[\s_-]?actual|puesto[\s_-]?actual|posici[oó]n|t[ií]tulo[\s_-]?profesional|headline|professional[\s_-]?title|titular)/i,
      getValue: (p) => p.currentTitle || p.headline || p.cvDatabase?.experiences?.[0]?.role || ""
    },
    {
      key: "currentCompany",
      // Incluye "nombre de la empresa" / "empresa" a secas: son la forma más
      // común de pedir el empleador actual en formularios en español, y antes
      // no matcheaban con nada (la regla exigía "empresa_actual").
      regex: /(current[\s_-]?company|empresa[\s_-]?actual|empleador[\s_-]?actual|employer|company[\s_-]?name|nombre\s+(?:de\s+la\s+|del?\s+)?(?:empresa|compa[ñn][ií]a)|^empresa$|\bcompa[ñn][ií]a\b)/i,
      getValue: (p) => p.currentCompany || p.cvDatabase?.experiences?.[0]?.company || ""
    },
    {
      key: "previousCompany",
      regex: /(previous[\s_-]?company|past[\s_-]?company|previous[\s_-]?employer|past[\s_-]?employer|empresa[\s_-]?anterior|antigua[\s_-]?empresa|empleador[\s_-]?previo)/i,
      getValue: (p) => p.cvDatabase?.experiences?.[1]?.company || p.cvDatabase?.experiences?.[0]?.company || ""
    },
    {
      key: "previousRole",
      regex: /(previous[\s_-]?role|past[\s_-]?role|previous[\s_-]?position|past[\s_-]?position|cargo[\s_-]?anterior|puesto[\s_-]?anterior|t[ií]tulo[\s_-]?previo)/i,
      getValue: (p) => p.cvDatabase?.experiences?.[1]?.role || p.cvDatabase?.experiences?.[0]?.role || ""
    },
    {
      key: "skillsExperience",
      regex: /(years[\s_]*of[\s_]*(?:work[\s_]*)?experience|a[ñn]os[\s_]*de[\s_]*experiencia|cu[aá]ntos[\s_]*a[ñn]os|experience[\s_]*with|experiencia[\s_]*con)/i,
      getValue: (p, ctx) => {
        // If question asks for years with a specific tech, check if candidate has it
        const norm = normalizeText(ctx || "");
        const skillsList = (p.skills || "").toLowerCase();
        const cvRaw = (p.resumeText || "").toLowerCase();
        
        // Match tech mentioned in the question
        const words = norm.split(" ").filter(w => w.length > 2);
        const hasSpecificTech = words.some(w => skillsList.includes(w) || cvRaw.includes(w));
        
        if (hasSpecificTech) {
          return p.yearsOfExperience || "3";
        }
        return p.yearsOfExperience || "3";
      }
    },
    {
      key: "yearsOfExperience",
      regex: /(years[\s_]*of[\s_]*experience|a[ñn]os[\s_]*de[\s_]*experiencia|experiencia[\s_]*total|experience[\s_]*years)/i,
      getValue: (p) => p.yearsOfExperience
    },
    {
      key: "salaryExpectation",
      regex: /(salary|salario|remuneraci[oó]n|pretensi[oó]n|pretensiones|compensation|expectativa[\s_-]?salarial|desired[\s_-]?salary|renta[\s_-]?l[ií]quida|sueldo)/i,
      getValue: (p, ctx) => {
        // If input only accepts numbers (like Getonbrd CLP salary), return clean digits
        const norm = (ctx || "").toLowerCase();
        const rawSalary = p.salaryExpectation || "";
        if (norm.includes("clp") || norm.includes("número") || norm.includes("monto")) {
          const digits = rawSalary.replace(/[^\d]/g, "");
          return digits || rawSalary;
        }
        return rawSalary ? `${rawSalary} ${p.currency || ""}`.trim() : "";
      }
    },
    {
      key: "noticePeriod",
      regex: /(notice[\s_-]?period|disponibilidad|preaviso|availability|start[\s_-]?date|fecha[\s_-]?incorporaci[oó]n)/i,
      getValue: (p) => p.noticePeriod
    },
    // Legal / EEO: existían en el esquema del perfil desde el principio, pero
    // sin NINGUNA regla que las reconociera — solo un respaldo para grupos de
    // radio/checkbox (más abajo en este archivo) cubría legallyAuthorized y
    // requiresSponsorship, y willingToRelocate/workPreference/gender no tenían
    // absolutamente ninguna cobertura. Un formulario que las pidiera como
    // <select> (lo más común) quedaba con esos campos vacíos siempre.
    {
      key: "legallyAuthorized",
      regex: /(legally[\s_-]?authorized|autorizad[oa]?[\s_-]?(?:para|a)?[\s_-]?trabajar|work[\s_-]?permit|permiso[\s_-]?de[\s_-]?trabajo|authorized[\s_-]?to[\s_-]?work)/i,
      getValue: (p) => p.legallyAuthorized
    },
    {
      key: "requiresSponsorship",
      regex: /(sponsorship|patrocinio|visa|visado|requiere[\s_-]?patrocinio)/i,
      // La pregunta casi siempre se formula en positivo ("¿requieres
      // patrocinio?"), así que se invierte el valor guardado ("no requiero" =
      // profile "no") a lo que hay que responder. Un <select> con las opciones
      // invertidas es indistinguible de uno normal por el label del campo, así
      // que esto es lo mejor que se puede hacer sin ver las opciones — el
      // respaldo de radio/checkbox más abajo sigue cubriendo ese caso mejor,
      // comparando contra el texto real de cada opción.
      getValue: (p) => p.requiresSponsorship
    },
    {
      key: "willingToRelocate",
      regex: /(willing[\s_-]?to[\s_-]?relocate|relocation|reubicaci[oó]n|reubicarte|disposici[oó]n[\s_-]?a[\s_-]?(?:la[\s_-]?)?reubicaci[oó]n|open[\s_-]?to[\s_-]?relocat)/i,
      getValue: (p) => p.willingToRelocate
    },
    {
      key: "workPreference",
      regex: /(work[\s_-]?preference|modalidad[\s_-]?de[\s_-]?trabajo|modalidad[\s_-]?preferida|preferred[\s_-]?work[\s_-]?mode|work[\s_-]?mode|work[\s_-]?arrangement)/i,
      getValue: (p) => p.workPreference
    },
    {
      // Vacío por defecto (ver options.html): a diferencia del resto de estas
      // reglas, aquí "sin dato" es la respuesta correcta más a menudo que no —
      // getValue devuelve "" cuando el usuario no eligió nada, y una regla que
      // no da valor simplemente no se aplica (el motor pasa a la siguiente).
      key: "gender",
      regex: /(^gender$|g[eé]nero|sexo(?!\s+de\s+la\s+empresa))/i,
      getValue: (p) => (p.gender === "female" ? "Femenino" : p.gender === "male" ? "Masculino" : p.gender === "other" ? "Otro" : "")
    },
    {
      key: "englishLevel",
      regex: /(english|ingl[eé]s|idioma[\s_-]?ingl[eé]s|language[\s_-]?level|english[\s_-]?level)/i,
      getValue: (p) => p.englishLevel
    },
    {
      key: "degree",
      regex: /(degree|t[ií]tulo[\s_-]?acad[eé]mico|carrera|estudios|licenciatura|ingenier[ií]a)/i,
      getValue: (p) => p.degree
    },
    {
      key: "university",
      regex: /(university|universidad|instituci[oó]n|college|school|facultad)/i,
      getValue: (p) => p.university
    },
    {
      // "Overall Result (GPA)" en Workday, "Promedio" en portales locales.
      // Token distintivo: `gpa` con límite de palabra no colisiona con nada
      // más del formulario.
      key: "gpa",
      regex: /\bgpa\b|promedio(?:[\s_-]?de[\s_-]?notas)?|overall[\s_-]?result|grade[\s_-]?point/i,
      getValue: (p) => p.gpa
    },
    {
      // Año de egreso/titulación. El label de Workday es "To (Actual or
      // Expected)" — un "To" a secas sería peligrosísimo (la sección de
      // experiencia laboral también tiene From/To y quedaría el año de
      // estudios en el cargo), así que se exige la frase completa que
      // distingue al campo de educación.
      //
      // No hay regla equivalente para el "From": el perfil guarda UN año por
      // estudio (el de egreso), no un rango. Rellenar el año de inicio
      // exigiría inventarlo restando una duración supuesta.
      key: "educationEndYear",
      regex: /to[\s_-]?\(actual[\s_-]?or[\s_-]?expected\)|a[ñn]o[\s_-]?de[\s_-]?(?:egreso|titulaci[oó]n)|graduation[\s_-]?year/i,
      getValue: (p) => extractGraduationYear(p.cvDatabase?.education?.[0]?.year)
    },
    {
      // "Field of Study" (Workday y similares): un typeahead, no un texto
      // libre — se rellena vía commitComboboxSelectionIfNeeded (detecta el
      // contenedor `multiSelectContainer`). Sin un campo dedicado en el
      // perfil, reutiliza `degree`: en la mayoría de los formularios el
      // nombre de la carrera ES la disciplina que este campo pide. Si el
      // sitio lista sus opciones en otro idioma y ninguna refleja lo
      // tecleado, el motor de combobox simplemente no elige nada — no inventa
      // una opción parecida.
      key: "fieldOfStudy",
      regex: /field[\s_-]?of[\s_-]?study|campo[\s_-]?de[\s_-]?estudio|especialidad|\bmajor\b/i,
      getValue: (p) => p.degree
    },
    {
      key: "skills",
      regex: /(skills|technolog(?:y|ies)|habilidades|competencias|tecnolog[ií]as|stack)/i,
      getValue: (p) => p.skills
    },
    {
      key: "summary",
      regex: /(summary|resumen|about[\s_-]?you|sobre[\s_-]?ti|cover[\s_-]?letter|carta[\s_-]?de[\s_-]?presentaci[oó]n|presentaci[oó]n|bio|mensaje|introduction)/i,
      getValue: (p) => p.summary
    },
    {
      key: "resumeText",
      regex: /(curriculum|resume|cv|curriculum[\s_-]?vitae|hoja[\s_-]?de[\s_-]?vida|paste[\s_-]?resume|paste[\s_-]?cv|texto[\s_-]?cv)/i,
      getValue: (p) => p.resumeText || p.summary
    }
  ];

  /**
   * Pide el perfil al service worker. Distingue "no hay perfil" de "no hay
   * conexión con la extensión": antes ambos caían en el mismo aviso de
   * "configura tus datos", y tras recargar la extensión con la pestaña
   * abierta el usuario iba a revisar un perfil que estaba bien.
   */
  const ORPHANED_CONTEXT_MSG = "Esta pestaña perdió la conexión con JobFill AI (la extensión se recargó o actualizó). Recarga la página (F5) y vuelve a intentarlo.";

  async function loadProfile() {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_PROFILE" }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(ORPHANED_CONTEXT_MSG));
            return;
          }
          if (response && response.success && response.profile) {
            activeProfile = response.profile;
            resolve(activeProfile);
          } else {
            resolve(null);
          }
        });
      } catch (e) {
        // sendMessage lanza de forma síncrona si el contexto ya se invalidó.
        reject(new Error(ORPHANED_CONTEXT_MSG));
      }
    });
  }

  function setElementValue(el, value) {
    if (!el || value === undefined || value === null || value === "") return false;

    // Rich Text / Trix Editor (Getonbrd / Modern Portals)
    if (el.tagName === "TRIX-EDITOR") {
      if (el.editor && typeof el.editor.loadHTML === "function") {
        el.editor.loadHTML(value);
      } else {
        el.innerText = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      el.classList.add("jobfill-highlight-success");
      setTimeout(() => el.classList.remove("jobfill-highlight-success"), 2500);
      return true;
    }

    // ContentEditable elements
    if (el.isContentEditable) {
      el.innerText = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: String(value) }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      el.classList.add("jobfill-highlight-success");
      setTimeout(() => el.classList.remove("jobfill-highlight-success"), 2500);
      return true;
    }

    // React 16-19 / Modern framework value tracker bypass
    const tracker = el._valueTracker;
    if (tracker) {
      tracker.setValue("");
    }

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (el.tagName === "TEXTAREA" && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(el, value);
    } else if (el.tagName === "INPUT" && nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    // Comprehensive synthetic events for React, Angular, Vue, Svelte, Web Components
    try {
      el.dispatchEvent(new Event("keydown", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("keypress", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("keyup", { bubbles: true, composed: true }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: String(value) }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    } catch (e) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    el.classList.add("jobfill-highlight-success");
    setTimeout(() => {
      el.classList.remove("jobfill-highlight-success");
    }, 2500);

    return true;
  }

  /**
   * Confirma la selección de un `<input role="combobox">` (react-select y
   * librerías similares — el caso real que lo motivó: el selector de país del
   * widget de teléfono en formularios de Greenhouse). Escribir texto ahí SOLO
   * filtra la lista de opciones que la librería re-renderiza; el valor que el
   * formulario usa de verdad para validar/enviar sigue vacío hasta que se
   * hace clic en una opción — un simple `.value = "Chile"` deja el campo con
   * texto tipeado pero SIN nada seleccionado, y el envío fallaría igual.
   *
   * No se asume que la lista de opciones que aparece es la correcta: puede
   * haber más de un `[role="listbox"]` en la página (un widget vecino no
   * relacionado, ya montado aunque cerrado — es justo lo que pasa en este
   * mismo formulario de Greenhouse con el selector de código telefónico). Se
   * identifica el listbox correcto por ser el que de verdad reflejó lo que se
   * escribió (su primera opción CONTIENE el valor tecleado), no por ser el
   * primero que aparezca en el documento. Si ninguno da esa confianza, no se
   * hace clic en nada — mismo comportamiento que hoy, sin regresión.
   */
  /**
   * Decide CUÁL opción hay que clicar, dada la lista de listboxes presentes en
   * el documento — separada de `commitComboboxSelectionIfNeeded` a propósito
   * para que sea una función pura y síncrona, testeable sin DOM real ni
   * temporizadores (mismo criterio que ya se usó para `computeCropRect`).
   *
   * Devuelve el elemento opción a clicar, o `null` si ningún listbox refleja
   * con confianza lo que se escribió.
   */
  /**
   * Equivalente en inglés del área de estudios, para reintentar la búsqueda
   * cuando el formulario lista sus opciones en inglés y el perfil está en
   * español. Es una tabla corta y deliberadamente conservadora: solo áreas
   * cuya traducción es unívoca. Ante cualquier duda no devuelve nada y el
   * campo se queda vacío, que es preferible a seleccionar una carrera que no
   * es la del candidato.
   *
   * Se compara sobre el texto normalizado y por CONTENIDO, no por igualdad:
   * el perfil guarda "Ingeniería Civil en Informática", no "informatica".
   */
  const STUDY_FIELD_TRANSLATIONS = [
    { re: /inform[aá]tic|computaci[oó]n|computer/i, en: "Computer Science" },
    { re: /sistemas/i, en: "Information Systems" },
    { re: /software/i, en: "Software Engineering" },
    { re: /industrial/i, en: "Industrial Engineering" },
    { re: /civil(?!\s+en)/i, en: "Civil Engineering" },
    { re: /electr[oó]nic/i, en: "Electronics" },
    { re: /el[eé]ctric/i, en: "Electrical Engineering" },
    { re: /mec[aá]nic/i, en: "Mechanical Engineering" },
    { re: /telecomunicaci/i, en: "Telecommunications" },
    { re: /comercial|negocios|administraci[oó]n de empresas/i, en: "Business Administration" },
    { re: /contabilidad|contador|auditor[ií]a/i, en: "Accounting" },
    { re: /econom[ií]a/i, en: "Economics" },
    { re: /marketing|mercadotecnia/i, en: "Marketing" },
    { re: /dise[ñn]o/i, en: "Design" },
    { re: /derecho|abogac[ií]a/i, en: "Law" },
    { re: /psicolog[ií]a/i, en: "Psychology" },
    { re: /matem[aá]tic/i, en: "Mathematics" },
    { re: /estad[ií]stic/i, en: "Statistics" },
    { re: /datos|data/i, en: "Data Science" }
  ];

  function translateStudyFieldToEnglish(text) {
    if (!text) return "";
    const norm = normalizeText(text);
    if (!norm) return "";
    const match = STUDY_FIELD_TRANSLATIONS.find(entry => entry.re.test(norm));
    return match ? match.en : "";
  }

  function findMatchingComboboxOption(listboxes, typedValue) {
    const typedNorm = normalizeText(typedValue);
    if (!typedNorm) return null;

    for (const listbox of listboxes) {
      const firstOption = listbox.querySelector('[role="option"]');
      if (!firstOption) continue;
      if (!normalizeText(firstOption.innerText || "").includes(typedNorm)) continue;
      return firstOption;
    }
    return null;
  }

  async function commitComboboxSelectionIfNeeded(el, typedValue) {
    // `role="combobox"` cubre react-select y similares (el caso original,
    // Greenhouse). Workday usa el mismo patrón de "escribir filtra, hay que
    // clicar para confirmar" pero sin ese role — su input vive dentro de un
    // contenedor propio (`multiSelectContainer`, visto en el campo "Field of
    // Study"), así que se detecta por ahí también.
    const isReactSelectCombobox = el && el.getAttribute("role") === "combobox";
    const isWorkdayMultiSelect = el && !!el.closest("[data-automation-id='multiSelectContainer']");
    if (!el || (!isReactSelectCombobox && !isWorkdayMultiSelect)) return false;

    try {
      // Un ciclo de render de React no es instantáneo tras despachar los
      // eventos de input — hay que esperar un instante a que la librería
      // termine de filtrar y montar la lista antes de buscarla.
      await new Promise(r => setTimeout(r, 200));

      let option = findMatchingComboboxOption(document.querySelectorAll('[role="listbox"]'), typedValue);

      // Reintento en inglés: muchos formularios internacionales (Workday es el
      // caso típico) listan sus opciones en inglés aunque el resto del sitio
      // esté en español, así que "Ingeniería en Informática" no encuentra
      // nada aunque "Computer Science" sí exista en la lista. Se vuelve a
      // teclear con el término equivalente y se busca otra vez.
      if (!option) {
        const englishTerm = translateStudyFieldToEnglish(typedValue);
        if (englishTerm) {
          setElementValue(el, englishTerm);
          await new Promise(r => setTimeout(r, 300));
          option = findMatchingComboboxOption(document.querySelectorAll('[role="listbox"]'), englishTerm);
        }
      }

      if (!option) return false;

      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
      option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }));
      option.click();
      return true;
    } catch (e) {
      console.warn("[JobFill AI] No se pudo confirmar la selección del combobox:", e);
      return false;
    }
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  function isShown(node) {
    if (!node || !node.isConnected) return false;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden";
  }

  /** Listbox que el control declara con aria-controls/aria-owns (puede existir desde antes, oculto). */
  function controlledListbox(el) {
    const ids = `${el.getAttribute("aria-controls") || ""} ${el.getAttribute("aria-owns") || ""}`.trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const node = rootOf(el).getElementById(id) || document.getElementById(id);
      const lb = node && (node.getAttribute("role") === "listbox" ? node : node.querySelector('[role="listbox"]'));
      if (isShown(lb)) return lb;
    }
    return null;
  }

  /**
   * Abre la lista de un dropdown personalizado y devuelve su
   * `[role="listbox"]` — el que aparece COMO CONSECUENCIA (o el que el
   * control declara con aria-controls), nunca "el primero del documento":
   * puede haber otro montado de un campo vecino.
   *
   * Cada librería abre con un evento distinto: MUI y react-select con
   * mousedown, Workday / Headless UI / Angular Material con click. Se prueba
   * primero mousedown y, solo si no apareció nada, click (hacer ambos
   * seguidos cerraría la lista en las que alternan).
   */
  async function openListboxFor(el) {
    const before = new Set(document.querySelectorAll('[role="listbox"]'));
    const fresh = () => controlledListbox(el) || Array.from(document.querySelectorAll('[role="listbox"]')).find(lb => !before.has(lb) && isShown(lb)) || null;
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, button: 0 }));
    await wait(220);
    let lb = fresh();
    if (lb) return lb;
    el.click();
    await wait(350);
    lb = fresh();
    if (lb) return lb;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true, composed: true }));
    await wait(250);
    return fresh();
  }

  function closeListbox(el, listbox) {
    const esc = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, composed: true });
    (listbox.querySelector('[role="option"]') || listbox).dispatchEvent(esc);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, composed: true }));
    setTimeout(() => { if (isShown(listbox)) el.click(); }, 120);
  }

  /**
   * Rellena un dropdown personalizado (Workday, MUI, Angular Material,
   * Headless UI, cualquier `aria-haspopup="listbox"` o `role="combobox"` que
   * no es un input): abre la lista, `pickIndex` elige entre las opciones que
   * el sitio ofrece de verdad y se hace clic en esa. Sin opción que calce,
   * se cierra sin tocar nada.
   */
  async function fillDropdown(el, pickIndex) {
    try {
      const listbox = await openListboxFor(el);
      if (!listbox) return false;
      const options = Array.from(listbox.querySelectorAll('[role="option"]'));
      const index = pickIndex(options.map(o => ({ text: (o.getAttribute("aria-label") || o.textContent || "").trim(), value: o.getAttribute("data-value") || "" })));
      const option = options[index];
      if (!option || option.getAttribute("aria-disabled") === "true") {
        closeListbox(el, listbox);
        return false;
      }
      option.scrollIntoView?.({ block: "nearest" });
      option.click();
      await wait(150);
      // Radix y otras eligen en pointerup, no en click.
      if (option.isConnected && isShown(listbox) && option.getAttribute("aria-selected") !== "true") {
        option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse" }));
        option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, button: 0 }));
        await wait(120);
      }
      if (isShown(listbox)) closeListbox(el, listbox);
      el.classList.add("jobfill-highlight-success");
      setTimeout(() => el.classList.remove("jobfill-highlight-success"), 2500);
      return true;
    } catch (e) {
      // Un widget que se comporta distinto a lo esperado deja el campo sin
      // tocar, nunca tumba la pasada completa.
      console.warn("[JobFill AI] No se pudo usar el dropdown:", e);
      return false;
    }
  }

  /**
   * El "Degree" de Workday (y otros ATS): un NIVEL estandarizado, no el
   * nombre de la carrera — se clasifica el perfil y se busca esa categoría
   * entre las opciones reales. Solo actúa si el contexto matchea la regla
   * `degree` del motor genérico.
   */
  async function tryFillDegreeDropdown(el, profile, textContext) {
    const degreeRule = FIELD_RULES.find(r => r.key === "degree");
    if (!degreeRule || !degreeRule.regex.test(textContext)) return false;
    const level = classifyDegreeLevel(profile.degree || "");
    if (!level) return false;
    return fillDropdown(el, options => findMatchingDegreeOptionIndex(options.map(o => o.text), level));
  }

  /**
   * Elige en un <select> la opción que corresponde a `targetText` (ver
   * JobFillPortals.pickOptionIndex: nunca elige el placeholder).
   */
  function setSelectValue(select, targetText) {
    if (!select || !targetText) return false;
    const options = Array.from(select.options);
    return selectOptionAt(select, Portals.pickOptionIndex(options.map(o => ({ text: o.text, value: o.value })), targetText));
  }

  /** Marca la opción `index` del <select> y avisa a la página (y a Select2/Chosen/bootstrap-select). */
  function selectOptionAt(select, index) {
    if (index < 0 || !select.options[index]) return false;
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    // Chosen solo se redibuja con su evento propio (jQuery lo escucha como
    // un evento nativo más). Select2 y bootstrap-select ya escuchan "change".
    select.dispatchEvent(new Event("chosen:updated", { bubbles: true }));
    const visible = enhancedSelectUi(select) || select;
    visible.classList.add("jobfill-highlight-success");
    setTimeout(() => visible.classList.remove("jobfill-highlight-success"), 2500);
    return true;
  }

  /**
   * UI visible de un <select> "mejorado" por un plugin (Select2, Chosen,
   * bootstrap-select, Tom Select), que deja el <select> real oculto. Choices.js
   * no se incluye: borra del <select> las opciones no elegidas, así que
   * escribir ahí no sirve.
   */
  function enhancedSelectUi(select) {
    const next = select.nextElementSibling;
    if (next && next.matches(".select2, .select2-container, .chosen-container, .ts-wrapper")) return next;
    const wrap = select.closest(".bootstrap-select");
    return wrap || null;
  }

  /**
   * Grupos de radio/checkbox de OPCIÓN ÚNICA que el motor genérico de
   * `executeAutofill` no sabe rellenar: ese motor (más abajo, sección
   * `applyRuleValue`) solo marca una opción cuando el valor guardado es
   * literalmente "yes" — no tiene forma de marcar la opción "no" de un grupo
   * binario, y mucho menos elegir entre un enum de 3+ alternativas como
   * modalidad de trabajo o género.
   *
   * Antes esto se resolvía con dos bloques `if/else` escritos a mano, uno por
   * cada campo (legallyAuthorized, requiresSponsorship) — funcionaban, pero
   * cualquier campo nuevo de este mismo tipo (willingToRelocate,
   * workPreference, gender) se quedaba sin ningún respaldo hasta que alguien
   * copiara y adaptara el bloque a mano. Esta tabla es esa misma lógica
   * generalizada: cómo reconocer el GRUPO en el formulario (`groupRegex`), y
   * para cada valor posible del perfil, qué palabras identifican la opción
   * correspondiente dentro del grupo (`optionVariants`).
   */
  const RADIO_GROUP_FIELDS = [
    {
      profileKey: "requiresSponsorship",
      groupRegex: /sponsorship|patrocinio|visa|visado|requiere[\s_-]?patrocinio/i,
      optionVariants: { yes: ["yes", "si", "true"], no: ["no", "false"] }
    },
    {
      profileKey: "legallyAuthorized",
      groupRegex: /authorized|autorizado|legalmente|work[\s_-]?permit|permiso[\s_-]?de[\s_-]?trabajo/i,
      optionVariants: { yes: ["yes", "si", "true"], no: ["no", "false"] }
    },
    {
      profileKey: "willingToRelocate",
      groupRegex: /willing[\s_-]?to[\s_-]?relocate|relocation|reubicaci[oó]n|reubicarte|mudarte|trasladarte/i,
      optionVariants: { yes: ["yes", "si", "true"], no: ["no", "false"] }
    },
    {
      profileKey: "workPreference",
      groupRegex: /work[\s_-]?preference|modalidad[\s_-]?de[\s_-]?trabajo|modalidad[\s_-]?preferida|work[\s_-]?mode|work[\s_-]?arrangement/i,
      optionVariants: {
        remote: ["remote", "remoto", "teletrabajo"],
        hybrid: ["hybrid", "hibrido", "mixto"],
        onsite: ["onsite", "on site", "on-site", "presencial", "in office", "oficina"]
      }
    },
    {
      profileKey: "gender",
      groupRegex: /^gender$|g[eé]nero|sexo/i,
      optionVariants: {
        female: ["female", "woman", "femenino", "mujer"],
        male: ["male", "man", "masculino", "hombre"],
        other: ["other", "otro", "otra", "prefer not", "prefiero no"]
      }
    }
  ];

  /**
   * ¿El texto de ESTA opción del grupo (su `value`, o el texto del formulario
   * a su alrededor) corresponde a alguna de las variantes dadas?
   *
   * Se compara por PALABRA COMPLETA (`\b...\b`), no por substring: sin el
   * límite de palabra, la variante "no" matchearía dentro de "Noruega", y la
   * variante "male" matchearía dentro de "female" — ambos son el tipo exacto
   * de falso positivo que un simple `.includes()` produciría aquí.
   */
  function matchesAnyOptionVariant(text, variants) {
    const norm = normalizeText(text || "");
    return variants.some(variant => {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(norm);
    });
  }

  /**
   * El "Degree" de Workday (y de otros ATS con el mismo patrón) no es un
   * campo de texto libre: es un NIVEL estandarizado — "Bachelor of Science
   * (BS)", "Masters of Arts (MA)", "FPII/Higher Technical Diploma" — nunca el
   * nombre de la carrera. El perfil guarda el nombre ("Ingeniería en
   * Informática"), así que hace falta traducir uno al otro. No se intenta un
   * match exacto de texto (cada sitio redacta las opciones distinto); se
   * clasifica el perfil en una categoría amplia y luego se busca esa
   * categoría, con sinónimos, en las opciones reales que ofrezca el sitio.
   *
   * Orden intencional: de más específico (doctorado) a menos, porque un
   * texto puede matchear más de un patrón ("Magíster en Ingeniería" toca
   * tanto `master` como `bachelor` vía "ingenier") y debe ganar el más alto.
   */
  const DEGREE_LEVEL_PATTERNS = [
    { level: "phd", re: /doctor|ph\.?\s?d\b/i },
    { level: "master", re: /master|maestr[ií]a|mag[ií]ster|mba/i },
    { level: "bachelor", re: /ingenier[ií]a|licenciatura|licenciado|bachelor/i },
    { level: "associate", re: /t[eé]cnico|technical|associate|diploma/i },
    { level: "highschool", re: /media|secundari[ao]|high\s?school|bachillerato/i }
  ];

  function classifyDegreeLevel(text) {
    if (!text) return null;
    for (const { level, re } of DEGREE_LEVEL_PATTERNS) {
      if (re.test(text)) return level;
    }
    return null;
  }

  const DEGREE_LEVEL_OPTION_KEYWORDS = {
    phd: [/doctor/i, /ph\.?\s?d/i],
    master: [/master/i, /mag[ií]ster/i, /mba/i],
    bachelor: [/bachelor/i, /licenciatura/i, /professional/i, /^ingenier/i],
    associate: [/associate/i, /t[eé]cnic/i, /^diploma/i],
    highschool: [/high\s?school/i, /secondary/i, /bachillerato/i]
  };

  /**
   * Dado el nivel ya clasificado, busca en las opciones REALES del sitio (no
   * en una lista fija propia, que quedaría desactualizada) cuál corresponde.
   * Sin match — nivel no reconocido o ninguna opción del sitio lo nombra —
   * no se elige nada: adivinar aquí firmaría el formulario con un nivel de
   * estudios que no es el del candidato.
   */
  function findMatchingDegreeOptionIndex(optionTexts, level) {
    const patterns = DEGREE_LEVEL_OPTION_KEYWORDS[level];
    if (!patterns) return -1;
    return optionTexts.findIndex(text => patterns.some(p => p.test(text)));
  }

  function stemWord(word) {
    return word.replace(/(?:es|as|os|ar|er|ir|ado|ido|ando|iendo|cion|s)$/i, "");
  }

  function matchesQaAdvanced(formContext, qaKeywords) {
    const normContext = normalizeText(formContext);
    const contextWords = normContext.split(" ").filter(w => w.length > 2);
    const contextStems = contextWords.map(stemWord);

    const kwPhrases = qaKeywords.split(/[,;\n]+/).map(k => normalizeText(k)).filter(Boolean);
    
    return kwPhrases.some(phrase => {
      if (normContext.includes(phrase)) return true;
      const phraseWords = phrase.split(" ").filter(w => w.length > 2);
      if (phraseWords.length === 0) return false;
      
      return phraseWords.every(pw => {
        const pwStem = stemWord(pw);
        return contextStems.some(cs => cs.includes(pwStem) || pwStem.includes(cs));
      });
    });
  }

  /**
   * Busca el texto visible más cercano a `el` por posición real en pantalla
   * (arriba o a la izquierda), sin depender de ningún nombre de clase CSS.
   * Solo se invoca como último recurso desde getFieldContext — ver el
   * comentario en el call site sobre cuándo se activa.
   */
  function findLabelByVisualProximity(el) {
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0 && elRect.height === 0) return "";

    // Acotar la búsqueda a un ancestro razonable en vez de todo el documento:
    // evita agarrar texto de secciones completamente distintas de la página.
    let scopeRoot = el;
    for (let i = 0; i < 8 && scopeRoot.parentElement && scopeRoot.parentElement !== document.body; i++) {
      scopeRoot = scopeRoot.parentElement;
    }

    let candidates;
    try {
      candidates = Array.from(scopeRoot.querySelectorAll("label, span, div, p, td, th, dt, strong, b, legend"));
    } catch (e) {
      return "";
    }

    let best = "";
    let bestScore = Infinity;

    for (const node of candidates) {
      if (node.contains(el) || el.contains(node)) continue;
      if (node.children.length > 2) continue; // probablemente un contenedor, no el texto del label
      const text = node.innerText?.trim();
      if (!text || text.length < 2 || text.length > 100) continue;

      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const isAbove = r.bottom <= elRect.top + 4;
      const isLeft = r.right <= elRect.left + 4;
      const horizontallyAligned = r.left < elRect.right && r.right > elRect.left - 40;
      const verticallyAligned = r.top < elRect.bottom + 10 && r.bottom > elRect.top - 10;

      if (!((isAbove && horizontallyAligned) || (isLeft && verticallyAligned))) continue;

      const dx = isLeft ? (elRect.left - r.right) : 0;
      const dy = isAbove ? (elRect.top - r.bottom) : 0;
      const score = Math.sqrt(dx * dx + dy * dy);

      if (score < bestScore) {
        bestScore = score;
        best = text;
      }
    }

    return best;
  }

  /**
   * Devuelve el contexto del campo SEPARADO POR ORIGEN, no como un solo string.
   *
   * El origen importa muchísimo para la precisión: el <label> visible del campo
   * es evidencia fortísima de qué campo es, mientras que el blob de atributos
   * (name/id generados) o el texto de un elemento vecino son pistas débiles y
   * ruidosas. Aplanarlo todo en un string hacía que un match accidental en el
   * texto vecino pesara igual que el label real del campo.
   */
  /**
   * Documento o ShadowRoot donde vive el campo: `label[for]` y
   * `aria-labelledby` apuntan a ids de ESE árbol, no del documento, cuando
   * el formulario usa web components (SuccessFactors, SmartRecruiters).
   */
  function rootOf(el) {
    const r = el.getRootNode?.();
    return r && typeof r.getElementById === "function" ? r : document;
  }

  function getFieldContextParts(el) {
    const label = [];
    const attrs = [];
    const nearby = [];

    if (el.id) attrs.push(el.id);
    if (el.name) attrs.push(el.name);
    if (el.placeholder) attrs.push(el.placeholder);
    if (el.title) attrs.push(el.title);
    if (el.getAttribute("aria-label")) attrs.push(el.getAttribute("aria-label"));
    if (el.getAttribute("aria-description")) attrs.push(el.getAttribute("aria-description"));
    if (el.getAttribute("data-automation-id")) attrs.push(el.getAttribute("data-automation-id"));
    if (el.getAttribute("data-testid")) attrs.push(el.getAttribute("data-testid"));
    if (el.getAttribute("data-test-form-builder-element")) attrs.push(el.getAttribute("data-test-form-builder-element"));

    // Check LinkedIn / Modern fieldset & legend context
    const fieldset = el.closest("fieldset, [role='radiogroup'], [role='group']");
    if (fieldset) {
      const legend = fieldset.querySelector("legend, [role='heading'], .fb-form-element-label, .t-14, .label");
      if (legend && legend.innerText) label.push(legend.innerText);
      // La pregunta del grupo suele vivir FUERA de él y enlazada por ARIA
      // (MUI RadioGroup, radios dibujados con role=radio).
      const groupLabel = fieldset.getAttribute("aria-label");
      if (groupLabel) label.push(groupLabel);
      const groupLabelledBy = fieldset.getAttribute("aria-labelledby");
      if (groupLabelledBy) {
        groupLabelledBy.split(/\s+/).forEach(id => {
          const node = id && rootOf(el).getElementById(id);
          if (node && node.innerText) label.push(node.innerText);
        });
      }
    }

    const labelledBy = el.getAttribute("aria-labelledby") || el.getAttribute("aria-describedby");
    if (labelledBy) {
      labelledBy.split(" ").forEach(id => {
        try {
          const labelEl = rootOf(el).getElementById(id);
          if (labelEl && labelEl.innerText) label.push(labelEl.innerText);
        } catch (e) {}
      });
    }

    if (el.id) {
      try {
        const forLabel = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forLabel && forLabel.innerText) label.push(forLabel.innerText);
      } catch (e) {}
    }

    const parentLabel = el.closest("label, .fb-form-element-label, .gb-label, .form-label");
    if (parentLabel && parentLabel.innerText) label.push(parentLabel.innerText);

    const context = label; // los pasos siguientes empujan etiquetas reales
    let foundContainerLabel = false;
    const container = el.closest(".form-group, .field, [class*='question'], [class*='field'], [class*='form-row'], .fb-single-line-text, .fb-dropdown, .gb-form-group, .input-container");
    if (container) {
      const labelEl = container.querySelector("label, .label, [class*='label'], [class*='title'], [class*='heading'], h3, h4, legend, span.label-text, p.help-block");
      if (labelEl && labelEl.innerText && labelEl.innerText.length < 180) {
        context.push(labelEl.innerText);
        foundContainerLabel = true;
      }
    }

    // Respaldo para widgets sin ninguna clase semántica reconocible (p. ej. los
    // componentes <lyte-input>/<crux-*-component> de Zoho Recruit): el label
    // real vive como HERMANO ANTERIOR de un ancestro varios niveles arriba, no
    // dentro de ningún contenedor con clase reconocible. Un simple
    // `el.closest("div")` se queda pegado en el primer <div> envoltorio
    // inmediato (normalmente vacío) y nunca sube lo suficiente — por eso
    // formularios enteros (Zoho Recruit y similares) no detectaban NINGÚN
    // campo. Se sube ancestro por ancestro buscando un label hermano o interno.
    let foundAncestorLabel = false;
    if (!foundContainerLabel) {
      let node = el.parentElement;
      for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
        const prevSibling = node.previousElementSibling;
        if (prevSibling && (prevSibling.tagName === "LABEL" || /label/i.test(prevSibling.className || "")) && prevSibling.innerText?.trim() && prevSibling.innerText.length < 180) {
          context.push(prevSibling.innerText);
          foundAncestorLabel = true;
          break;
        }
        const innerLabel = node.querySelector?.("label, [class*='label']");
        if (innerLabel && innerLabel.innerText?.trim() && innerLabel.innerText.length < 180) {
          context.push(innerLabel.innerText);
          foundAncestorLabel = true;
          break;
        }
        node = node.parentElement;
      }
    }

    // Último recurso, solo si TODO lo anterior (clase semántica + caminata de
    // ancestros) no encontró nada: buscar el texto visible más cercano al campo
    // por POSICIÓN EN PANTALLA (arriba o a la izquierda), igual que hace el
    // autofill nativo del navegador. Es más caro y algo menos preciso que un
    // selector afinado a un sitio conocido, así que nunca reemplaza los pasos
    // anteriores — solo cubre el hueco cuando el sitio usa un esquema de
    // marcado que nunca hemos visto y ni siquiera tiene una jerarquía DOM
    // razonable entre el label y el campo.
    if (!foundContainerLabel && !foundAncestorLabel) {
      const proximityLabel = findLabelByVisualProximity(el);
      if (proximityLabel) context.push(proximityLabel);
    }

    let prev = el.previousElementSibling;
    if (prev && (prev.tagName === "LABEL" || prev.tagName === "SPAN" || prev.tagName === "P" || prev.tagName === "H4") && prev.innerText && prev.innerText.length < 120) {
      nearby.push(prev.innerText);
    }

    const clean = arr => arr.join(" ").replace(/\s+/g, " ").trim();
    return { label: clean(label), attrs: clean(attrs), nearby: clean(nearby) };
  }

  // Contexto aplanado — se mantiene para todo lo que solo necesita "todo el
  // texto asociado al campo" (extracción de preguntas, detección de límite de
  // caracteres, banco de Q&A). El matching de reglas NO lo usa: necesita saber
  // de qué origen vino cada match para poder ponderarlo.
  function getFieldContext(el) {
    const parts = getFieldContextParts(el);
    return [parts.label, parts.attrs, parts.nearby].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  const AUTOFILLABLE_SELECTOR =
    "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='file']), textarea, select, trix-editor, [contenteditable='true'], " +
    // Controles personalizados: dropdowns (Workday, MUI, Angular Material,
    // Headless UI) y radios/checkbox dibujados con divs (role=radio/checkbox).
    "button[aria-haspopup='listbox'], [role='button'][aria-haspopup='listbox'], [role='combobox']:not(input), mat-select, [role='radio']:not(input), [role='checkbox']:not(input)";

  function isBoxVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return !(style.display === "none" || style.visibility === "hidden" || style.opacity === "0");
  }

  function isFillableVisible(el) {
    if (el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true") return false;
    if (isBoxVisible(el)) return true;
    // Radios y checkbox con estilo propio: el input real está oculto (opacity
    // 0, 0×0) y lo que se ve es su <label>.
    const type = (el.type || "").toLowerCase();
    if (el.tagName === "INPUT" && (type === "radio" || type === "checkbox")) {
      const label = el.labels?.[0] || el.closest("label");
      return Boolean(label && isBoxVisible(label));
    }
    // <select> oculto por Select2/Chosen/bootstrap-select: se ve su UI.
    if (el.tagName === "SELECT") {
      const ui = enhancedSelectUi(el);
      return Boolean(ui && isBoxVisible(ui));
    }
    return false;
  }

  /**
   * Controles personalizados que contienen su propio input (patrón ARIA 1.1:
   * div role=combobox > input) se rellenan por el input, no por el div.
   */
  function isWrapperOfInput(el) {
    return el.tagName !== "INPUT" && el.getAttribute("role") === "combobox" && Boolean(el.querySelector("input:not([type='hidden'])"));
  }

  /**
   * Intenta rellenar UN campo con todo el motor (Q&A personalizado, campos
   * flexibles, FIELD_RULES ponderadas por origen, respaldo de radio/checkbox).
   * Extraído del bucle de `executeAutofill` para poder reutilizarlo desde el
   * MutationObserver que sigue mirando la página después del primer pase (ver
   * `watchForLateFields`): un formulario de varios pasos, o que revela
   * preguntas al hacer scroll, agrega campos DESPUÉS del clic — un escaneo de
   * una sola pasada nunca los llega a ver.
   */
  async function tryFillField(el, profile) {
    const contextParts = getFieldContextParts(el);
      const textContext = [contextParts.label, contextParts.attrs, contextParts.nearby].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const normContext = normalizeText(textContext);
      const inputType = (el.type || "").toLowerCase();
      const kind = choiceKind(el);

      // Dropdown personalizado con la pregunta de estudios: nivel, no carrera.
      if (kind === "dropdown" && await tryFillDegreeDropdown(el, profile, textContext)) return true;

      let ruleMatched = false;

      const applyRuleValue = async (val) => {
        if (kind === "select") {
          return setSelectValue(el, val);
        }
        if (kind === "dropdown") {
          return fillDropdown(el, options => Portals.pickOptionIndex(options, val));
        }
        if (kind === "radio" || kind === "checkbox") {
          if (val === "yes" || val === "true" || val === true) {
            // Un checkbox suelto ("Estoy autorizado a trabajar en Chile") se
            // marca; en un grupo de radios solo la opción "Sí"/"Yes".
            const own = choiceOptionText(el);
            const isYesOption = matchesAnyOptionVariant(own, ["yes", "si", "true", "1"]);
            if (isYesOption || (kind === "checkbox" && !matchesAnyOptionVariant(own, ["no", "false"]))) {
              return checkChoice(el);
            }
          }
          return false;
        }
        setElementValue(el, val);
        // Un <input role="combobox"> (react-select y similares: el selector de
        // país del widget de teléfono es el caso real que lo motivó) NO se
        // rellena escribiendo texto — eso solo filtra su lista de opciones. El
        // valor que el formulario de verdad usa para validar/enviar queda
        // vacío hasta que se CONFIRMA una opción, así que sin este paso el
        // campo se ve lleno pero el envío fallaría igual.
        await commitComboboxSelectionIfNeeded(el, val);
        return true;
      };

      // El tipo nativo del input es evidencia más fuerte que cualquier texto:
      // un type="email" ES un email sin importar cómo se llame el label.
      const typeRule = inputType === "email" ? FIELD_RULES.find(r => r.key === "email")
        : inputType === "tel" ? FIELD_RULES.find(r => r.key === "phone")
        : null;
      if (typeRule) {
        const val = typeRule.getValue(profile, textContext);
        if (val && await applyRuleValue(val)) { ruleMatched = true; }
      }

      // Selección PONDERADA en vez de "la primera regla del array que matchee".
      // El orden del array no es una jerarquía de precisión, y con first-match
      // -wins reglas amplias y tempranas (p. ej. `nombre` en firstName)
      // secuestraban campos que pertenecían a reglas más específicas y tardías
      // ("Nombre de la empresa" se llenaba con el nombre de pila). Ahora cada
      // regla se puntúa por DÓNDE matcheó (el label del campo vale mucho más
      // que un atributo generado o el texto de un vecino) y por cuán específico
      // fue el match (un match más largo es menos accidental).
      //
      // Se calcula ANTES de los campos personalizados (más abajo) y se
      // reutiliza: si la regla mejor puntuada matcheó por LABEL — el origen de
      // más peso, el enunciado real de la pregunta — gana siempre sobre un
      // campo flexible del usuario. Bug real que motivó esto: un campo
      // personalizado "Licencia de conducir" con el keyword suelto "número"
      // le robó el campo "Ingresar RUT con puntos y número verificador" a la
      // regla curada de RUT, porque "número" aparece en las dos etiquetas sin
      // relación real entre sí. Un match por label de una regla del sistema es
      // más confiable que un keyword corto y genérico escrito a mano.
      const ORIGIN_WEIGHT = { label: 100, attrs: 60, nearby: 30 };
      let scored = [];
      if (!ruleMatched) {
        for (const rule of FIELD_RULES) {
          let bestWeight = 0;
          let matchLength = 0;

          for (const origin of ["label", "attrs", "nearby"]) {
            const raw = contextParts[origin];
            if (!raw) continue;
            const m = raw.match(rule.regex) || normalizeText(raw).match(rule.regex);
            if (m && ORIGIN_WEIGHT[origin] > bestWeight) {
              bestWeight = ORIGIN_WEIGHT[origin];
              matchLength = m[0].length;
            }
          }

          if (bestWeight > 0) scored.push({ rule, originWeight: bestWeight, score: bestWeight + matchLength });
        }

        scored.sort((a, b) => b.score - a.score);

        if (scored[0]?.originWeight === ORIGIN_WEIGHT.label) {
          const val = scored[0].rule.getValue(profile, textContext);
          if (val && await applyRuleValue(val)) { ruleMatched = true; }
        }
      }

      // 1. Banco de Q&A personalizado (solo si ninguna regla del sistema ya
      //    reclamó este campo con alta confianza — ver el guard de arriba).
      if (!ruleMatched && (el.tagName === "TEXTAREA" || el.tagName === "TRIX-EDITOR" || el.isContentEditable) && profile.customQA && Array.isArray(profile.customQA)) {
        for (let qa of profile.customQA) {
          if (!qa.keywords || !qa.answer) continue;
          if (matchesQaAdvanced(textContext, qa.keywords)) {
            setElementValue(el, qa.answer);
            return true;
          }
        }
      }

      // 2. Campos personalizados del usuario (idem).
      if (!ruleMatched && profile.customFields && Array.isArray(profile.customFields)) {
        for (let cf of profile.customFields) {
          if (!cf.value) continue;
          const searchTerms = `${cf.label || ""} ${cf.keywords || ""}`;
          if (matchesQaAdvanced(textContext, searchTerms)) {
            if (kind === "select") return setSelectValue(el, cf.value);
            if (kind === "dropdown") return fillDropdown(el, options => Portals.pickOptionIndex(options, cf.value));
            if (kind === "radio" || kind === "checkbox") {
              if (Portals.pickOptionIndex([choiceOptionText(el)], cf.value) !== 0) continue;
              return checkChoice(el);
            }
            setElementValue(el, cf.value);
            return true;
          }
        }
      }

      // 4. Resto de FIELD_RULES por puntaje (reutiliza `scored`, ya calculado
      //    arriba — la regla de label ya se intentó; esto cubre attrs/nearby y
      //    el caso de que la de label no tuviera dato cargado en el perfil).
      if (!ruleMatched) {
        for (const { rule } of scored) {
          const val = rule.getValue(profile, textContext);
          if (!val) continue;
          if (await applyRuleValue(val)) { ruleMatched = true; }
          break;
        }
      }

      // 3. Respaldo para grupos de radio/checkbox de opción única (ver
      // RADIO_GROUP_FIELDS): el motor genérico de arriba solo sabe marcar una
      // opción cuando el valor es literalmente "yes" — nunca "no", y nunca un
      // enum de 3+ alternativas (modalidad, género).
      if (!ruleMatched && kind !== "text") {
        for (const field of RADIO_GROUP_FIELDS) {
          if (!field.groupRegex.test(textContext) && !field.groupRegex.test(normContext)) continue;

          // Se identificó a qué campo pertenece este grupo — a partir de aquí
          // siempre se sale del bucle: no tiene sentido seguir probando el
          // regex de otros campos una vez que se sabe de cuál se trata.
          const answer = profile[field.profileKey];
          if (!answer) break; // el usuario no cargó este dato: no se adivina

          const variants = field.optionVariants[answer];
          if (!variants) break; // valor guardado fuera de la tabla esperada

          // Mismo campo como <select> o dropdown ("Sí"/"No", "Remoto"…).
          if (kind === "select") {
            ruleMatched = selectOptionAt(el, Portals.pickVariantIndex(Array.from(el.options).map(o => ({ text: o.text, value: o.value })), variants));
          } else if (kind === "dropdown") {
            ruleMatched = await fillDropdown(el, options => Portals.pickVariantIndex(options, variants));
          } else if (matchesAnyOptionVariant(choiceOptionText(el) || textContext, variants)) {
            ruleMatched = checkChoice(el);
          }
          break;
        }
      }

      return ruleMatched;
  }

  /**
   * Campos obligatorios (`required`/`aria-required`) que quedaron sin valor
   * tras el autorrelleno. Antes el único feedback era un contador — un campo
   * obligatorio sin match pasaba desapercibido hasta que el sitio rechazaba
   * el envío. Los de radio/checkbox se excluyen: el estado de un GRUPO no se
   * lee de un input individual, y marcarlos todos como "faltantes" sería ruido.
   */
  function listMissingRequiredFields(inputs) {
    const missing = [];
    for (const el of inputs) {
      const isRequired = el.required || el.getAttribute("aria-required") === "true";
      if (!isRequired) continue;
      const kind = choiceKind(el);
      if (kind === "radio" || kind === "checkbox") continue;
      if (kind === "dropdown") {
        if (!dropdownHasValue(el)) missing.push({ el, label: readableFieldLabel(el) });
        continue;
      }
      const value = el.isContentEditable ? el.innerText : el.value;
      if (value && value.trim()) continue;
      missing.push({ el, label: readableFieldLabel(el) });
    }
    return missing;
  }

  /**
   * Nombre legible de un campo para mostrárselo al usuario. El contexto crudo
   * junta el <label for>, el label padre y el del contenedor — casi siempre el
   * MISMO texto dos o tres veces, con asteriscos de "obligatorio" — y el aviso
   * de faltantes salía como "Nombre (First Name) * Nombre (First Name) …".
   */
  function readableFieldLabel(el) {
    const parts = getFieldContextParts(el);
    const raw = parts.label || el.getAttribute("aria-label") || el.placeholder || el.name || "";
    const firstLine = raw.split(/\n/)[0];
    const cleaned = firstLine.replace(/[*:]+/g, " ").replace(/\s+/g, " ").trim();
    // Si el mismo texto quedó repetido ("Email Email"), se conserva una vez.
    const half = cleaned.slice(0, Math.ceil(cleaned.length / 2)).trim();
    const deduped = half && cleaned === `${half} ${half}` ? half : cleaned;
    if (!deduped) return "campo sin nombre";
    return deduped.length > 36 ? `${deduped.slice(0, 35).trim()}…` : deduped;
  }

  /**
   * Marca en la página los obligatorios que quedaron vacíos, para que se
   * vean sin tener que leer el aviso. La marca se quita sola en cuanto el
   * usuario escribe en el campo.
   */
  function highlightMissingFields(missing) {
    for (const { el } of missing) {
      el.classList.add("jobfill-highlight-missing");
      const clear = () => {
        el.classList.remove("jobfill-highlight-missing");
        el.removeEventListener("input", clear);
        el.removeEventListener("change", clear);
      };
      el.addEventListener("input", clear);
      el.addEventListener("change", clear);
    }
  }

  function buildAutofillSummary(filledCount, keptCount, missing) {
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const parts = [];
    parts.push(filledCount
      ? `⚡ ${plural(filledCount, "campo rellenado", "campos rellenados")}.`
      : "No había campos vacíos que JobFill AI supiera rellenar.");
    if (keptCount) parts.push(`${plural(keptCount, "campo ya tenía", "campos ya tenían")} datos y se respetaron.`);
    if (missing.length) {
      const names = missing.slice(0, 3).map(m => m.label).join(", ");
      const list = `${names}${missing.length > 3 ? "…" : ""}`;
      // Sin punto final si la lista ya cierra con "…" (evita "….").
      parts.push(`Faltan ${plural(missing.length, "obligatorio", "obligatorios")} (marcados en amarillo): ${list}${list.endsWith("…") ? "" : "."}`);
    }
    return parts.join(" ");
  }

  /**
   * Sigue mirando la página un rato después del primer pase para rellenar
   * campos que aparezcan DESPUÉS del clic — un formulario de varios pasos, un
   * campo condicional que se revela al responder otra pregunta, o contenido
   * que carga al hacer scroll. Sin esto, esos campos quedaban fuera para
   * siempre porque el escaneo original era de una sola pasada.
   *
   * Se desconecta solo a los pocos segundos: observar indefinidamente
   * costaría batería/CPU en páginas que siguen mutando por su cuenta (SPAs
   * con animaciones, contadores, etc.) sin ningún beneficio real — pasado ese
   * margen, el usuario ya puede volver a pulsar "Auto-Rellenar" a mano.
   */
  /**
   * Envuelve `tryFillField` para que UN campo problemático no tumbe la pasada
   * entera. Sin esto, una excepción a mitad del bucle (un widget exótico, un
   * nodo que el framework reemplazó justo entonces) abortaba todos los campos
   * RESTANTES y también el resumen final: el usuario se quedaba con un
   * formulario a medio rellenar y sin ningún aviso de que algo falló.
   *
   * Descarta además los nodos que ya no están en el documento. Entre el
   * escaneo inicial y el turno de este campo hay varios `await` (los combobox
   * esperan a que la librería monte su lista), tiempo más que suficiente para
   * que una SPA re-renderice el formulario por debajo. Escribir en un nodo
   * desprendido no hace nada visible, pero sí sumaría al contador de
   * "campos rellenados" — un resumen que miente es peor que uno bajo.
   */
  /**
   * ¿El campo ya tiene un valor que hay que respetar? El autorrelleno antes
   * escribía encima de todo: lo que el usuario había tecleado a mano, lo que
   * el portal precargó desde su cuenta y — lo peor — las respuestas que la IA
   * acababa de redactar (una Q&A guardada que calzara con la pregunta pisaba
   * la respuesta generada). Ahora solo se rellena lo vacío; para reemplazar
   * un valor basta con borrarlo y volver a pulsar Autorrellenar.
   */
  function fieldAlreadyHasValue(el) {
    const type = (el.type || "").toLowerCase();
    const kind = choiceKind(el);

    if (kind === "dropdown") return dropdownHasValue(el);
    if (kind === "radio" && el.tagName !== "INPUT") {
      const group = el.closest("[role='radiogroup']");
      return group ? Boolean(group.querySelector("[aria-checked='true']")) : el.getAttribute("aria-checked") === "true";
    }
    if (kind === "checkbox" && el.tagName !== "INPUT") return el.getAttribute("aria-checked") === "true";
    if (el.tagName === "TRIX-EDITOR" || el.isContentEditable) return Boolean((el.innerText || "").trim());
    if (el.tagName === "SELECT") {
      // La opción 0 suele ser el placeholder ("Selecciona…"): solo cuenta
      // como elegido algo distinto de ella.
      return el.selectedIndex > 0 && Boolean((el.value || "").trim());
    }
    if (type === "checkbox") return el.checked;
    if (type === "radio") {
      if (!el.name) return el.checked;
      const scope = el.form || document;
      return Boolean(scope.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`));
    }

    const value = (el.value || "").trim();
    // Un prefijo de país precargado ("+56", "+1") no es un teléfono cargado.
    if (type === "tel" && /^\+?\d{0,4}$/.test(value)) return false;
    return value.length > 0;
  }

  /**
   * Tipo de control, sin importar cómo esté dibujado: "select" (nativo),
   * "dropdown" (personalizado), "radio", "checkbox" (nativos o role=) o "text".
   */
  function choiceKind(el) {
    const tag = el.tagName;
    const type = (el.type || "").toLowerCase();
    const role = el.getAttribute?.("role") || "";
    if (tag === "SELECT") return "select";
    if (tag === "INPUT") return type === "radio" || type === "checkbox" ? type : "text";
    if (role === "radio" || role === "checkbox") return role;
    if (tag === "TEXTAREA" || tag === "TRIX-EDITOR" || el.isContentEditable) return "text";
    if (tag === "MAT-SELECT" || role === "combobox" || el.getAttribute?.("aria-haspopup") === "listbox") return "dropdown";
    return "text";
  }

  /**
   * ¿El dropdown personalizado ya tiene algo elegido? Se mira el texto que
   * muestra (sin el placeholder "Select One"/"Selecciona…"), las clases de
   * "vacío" de Angular Material y el input oculto que acompaña a MUI.
   */
  function dropdownHasValue(el) {
    if (/\bmat-(?:mdc-)?select-empty\b/.test(el.className || "")) return false;
    const hidden = el.parentElement?.querySelector("input[aria-hidden='true'], input.MuiSelect-nativeInput");
    if (hidden) return Boolean((hidden.value || "").trim());
    const text = (el.innerText || el.textContent || "").replace(/[\u200b\u00a0]/g, " ").trim();
    return Boolean(text) && !self.JobFillPortals.isPlaceholderOption(text.split("\n")[0]);
  }

  /** Texto de UNA opción de un grupo: su value y su propia etiqueta ("1 Sí"), no la pregunta. */
  function choiceOptionText(el) {
    if (el.tagName === "INPUT") {
      const label = el.labels?.[0] || el.closest("label");
      return `${el.value || ""} ${label ? label.innerText || "" : ""}`.trim();
    }
    return (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim();
  }

  /**
   * Marca un radio/checkbox. Con `click()` y no con `checked = true`: React,
   * Vue y Angular escuchan el click en estos controles, así que un
   * `checked = true` se veía marcado pero el formulario no se enteraba.
   */
  function checkChoice(el) {
    if (el.tagName === "INPUT") {
      if (el.checked) return true;
      el.click();
      if (!el.checked) {
        el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
    } else if (el.getAttribute("aria-checked") !== "true") {
      el.click();
    }
    const visible = el.tagName === "INPUT" && !isBoxVisible(el) ? (el.labels?.[0] || el.closest("label") || el) : el;
    visible.classList.add("jobfill-highlight-success");
    setTimeout(() => visible.classList.remove("jobfill-highlight-success"), 2500);
    return true;
  }

  async function fillFieldSafely(el, profile) {
    if (!el || !el.isConnected) return false;
    if (fieldAlreadyHasValue(el)) return false;
    try {
      return await tryFillField(el, profile);
    } catch (e) {
      console.warn("[JobFill AI] Campo omitido por un error al rellenarlo:", el.name || el.id || el.tagName, e);
      return false;
    }
  }

  let activeLateFieldObserver = null;
  function watchForLateFields(profile, alreadyProcessed) {
    if (activeLateFieldObserver) activeLateFieldObserver.disconnect();

    let lateFilledCount = 0;
    let pending = false;

    const scanForNewFields = async () => {
      pending = false;
      const found = collectFillableFields().filter(el => !alreadyProcessed.has(el));

      for (const el of found) {
        alreadyProcessed.add(el);
        if (await fillFieldSafely(el, profile)) lateFilledCount++;
      }
    };

    const observer = new MutationObserver(() => {
      // Varias mutaciones llegan juntas (un framework re-renderiza de a
      // varios nodos) — se procesan como un solo lote en el próximo tick en
      // vez de una vez por mutación individual.
      if (pending) return;
      pending = true;
      setTimeout(scanForNewFields, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    activeLateFieldObserver = observer;

    setTimeout(() => {
      observer.disconnect();
      if (activeLateFieldObserver === observer) activeLateFieldObserver = null;
      if (lateFilledCount > 0) {
        showToast(`⚡ +${lateFilledCount} campo${lateFilledCount > 1 ? "s" : ""} más, aparecieron después del primer rellenado.`, "success");
      }
    }, 6000);
  }

  // Dos pasadas simultáneas (doble clic en el widget, o el popup disparando
  // una mientras el botón flotante ya lanzó otra) se pisan entre sí: las dos
  // escriben los mismos campos y, sobre todo, las confirmaciones asíncronas
  // de los combobox se entrelazan — una abre su lista de opciones mientras la
  // otra la está leyendo, y terminan eligiendo la opción equivocada.
  let autofillInProgress = false;

  /**
   * Campos rellenables visibles de ESTE frame, incluidos los que viven en
   * Shadow DOM abierto (web components de SuccessFactors, SmartRecruiters…).
   */
  function collectFillableFields() {
    return Portals.deepQuerySelectorAll(AUTOFILLABLE_SELECTOR, document, isOwnUi).filter(el => !isWrapperOfInput(el) && isFillableVisible(el));
  }

  /**
   * Rellena el frame actual y, desde el frame principal, también los iframes
   * de la pestaña (Greenhouse, Workable, iCIMS o Indeed embebidos en el sitio
   * de la empresa). En los iframes corre en modo `quiet`: el resumen único lo
   * muestra el frame principal con el total.
   */
  async function executeAutofill({ quiet = false } = {}) {
    if (autofillInProgress) return { count: 0, alreadyRunning: true };
    autofillInProgress = true;

    try {
      let profile;
      try {
        profile = await loadProfile();
      } catch (e) {
        if (!quiet) showToast(e.message, "error");
        return { count: 0, error: e.message };
      }
      if (!profile) {
        if (!quiet) showToast("Por favor abre JobFill AI y configura tus datos.", "error");
        return { count: 0 };
      }

      // Todo el documento (y sus shadow roots), filtrado por visibilidad para
      // los DOM dinámicos (LinkedIn, Getonbrd)
      const inputs = collectFillableFields();

      let filledCount = 0;
      let keptCount = 0;
      for (const el of inputs) {
        if (fieldAlreadyHasValue(el)) {
          keptCount++;
          continue;
        }
        if (await fillFieldSafely(el, profile)) filledCount++;
      }

      const missingRequired = listMissingRequiredFields(inputs);
      highlightMissingFields(missingRequired);
      watchForLateFields(profile, new Set(inputs));
      if (quiet) return { count: filledCount, kept: keptCount, missing: missingRequired.length };

      const frames = IS_TOP_FRAME ? await sendToWorker("AUTOFILL_SUBFRAMES") : null;
      if (frames?.success && frames.frames > 0) {
        filledCount += frames.count;
        keptCount += frames.kept;
      }
      const summary = buildAutofillSummary(filledCount, keptCount, missingRequired);
      const note = frames?.frames > 0 && frames.count > 0 ? ` Incluye ${frames.count} dentro de un formulario embebido.` : "";
      showToast(summary + note, missingRequired.length ? "info" : (filledCount ? "success" : "info"));

      return { count: filledCount };
    } finally {
      // En `finally`: si algo revienta antes de tiempo, el flag NO puede
      // quedarse encendido — dejaría el autorrelleno muerto para el resto de
      // la vida de la pestaña, sin ninguna pista de por qué.
      autofillInProgress = false;
    }
  }

  // El usuario puede cerrar el conjunto de botones (✕ del pill) cuando estorba
  // sobre el contenido de la página. Sin este flag, el MutationObserver que
  // vigila cambios en el DOM (Easy Apply, pasos de Getonbrd, etc.) volvía a
  // llamar `initFloatingWidget()` en la siguiente mutación y, como el widget
  // ya no estaba en el documento, lo recreaba de inmediato — cerrarlo no
  // servía de nada en cualquier página remotamente dinámica.
  let widgetDismissed = false;

  /**
   * Interruptor global (popup o botón ⏻ del widget). Arranca en `false` y
   * solo pasa a `true` después de leer storage: así, en una instalación
   * apagada, el widget nunca alcanza a parpadear en pantalla al cargar.
   * `widgetCollapsed` es la preferencia de ver el widget minimizado a un
   * botón redondo; vale para todas las páginas.
   */
  let extensionEnabled = false;
  let widgetCollapsed = false;
  // Se usa `vaultLastSync` (no el token) como señal de "vault conectado": el
  // content script no necesita ver credenciales para decidir si mostrar un botón.
  let vaultConnected = false;

  /** Referencias a nodos dentro del Shadow DOM del widget (null si no existe). */
  let widgetRefs = null;

  let currentActiveTarget = null;
  let repositionListenerAttached = false;

  // Última posición conocida del cursor, en px CSS del viewport — respaldo del
  // botón manual de captura de cargo: si el DOM no da ningún título legible, se
  // recorta la captura de pantalla alrededor de ESTA posición. Un simple
  // mousemove pasivo es barato (solo dos asignaciones numéricas); no hace falta
  // debounce porque no dispara ningún trabajo, solo registra el dato para
  // cuando el usuario pulse el botón.
  let lastMouseX = 0;
  let lastMouseY = 0;
  document.addEventListener("mousemove", e => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, { passive: true });

  function updateAiButtonPosition() {
    if (!currentAiBtn || !currentActiveTarget) return;
    const rect = currentActiveTarget.getBoundingClientRect();
    
    // Hide if out of viewport
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.width === 0 || rect.height === 0) {
      currentAiBtn.style.display = "none";
      return;
    }
    
    currentAiBtn.style.display = "inline-flex";
    const topPos = window.scrollY + rect.top + 6;
    const rightPos = window.innerWidth - (window.scrollX + rect.right) + 6;

    currentAiBtn.style.top = `${topPos}px`;
    currentAiBtn.style.right = `${Math.max(10, rightPos)}px`;
  }

  function attachAiButtonToTextarea(targetEl) {
    // Si ya está adjunto a ESTE MISMO campo, reposicionar en vez de destruir y
    // recrear. En páginas con DOM muy dinámico (mutaciones periódicas ajenas a
    // la extensión, o un framework que re-renderiza el campo) un `focusin`
    // puede repetirse sin que el usuario haya cambiado de campo. Recrear el
    // botón en ese instante es peligroso: si el usuario ya inició un clic
    // (entre `mousedown` y `click`), el botón que recibía el evento desaparece
    // del DOM a mitad de camino y el clic no llega a ningún listener — sin
    // ningún error visible, el botón simplemente "no hace nada".
    if (currentActiveTarget === targetEl && currentAiBtn && document.body.contains(currentAiBtn)) {
      updateAiButtonPosition();
      return;
    }

    removeAiButton();

    const rect = targetEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const btn = document.createElement("button");
    btn.className = "jobfill-ai-btn";
    btn.type = "button";
    btn.innerHTML = `<span>✨</span>`;
    btn.title = "Redactar con Claude IA";

    currentActiveTarget = targetEl;
    currentAiBtn = btn;
    updateAiButtonPosition();

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleGenerateAiAnswer(targetEl, btn);
    });

    attachToTopLayerHost(btn);

    if (!repositionListenerAttached) {
      window.addEventListener("scroll", updateAiButtonPosition, { passive: true });
      window.addEventListener("resize", updateAiButtonPosition, { passive: true });
      repositionListenerAttached = true;
    }
  }

  function removeAiButton() {
    if (currentAiBtn && currentAiBtn.parentNode) {
      currentAiBtn.parentNode.removeChild(currentAiBtn);
    }
    currentAiBtn = null;
    currentActiveTarget = null;
  }

  /** "entre 300 y 2000 caracteres" / "between 300 and 2000 characters". */
  const RANGE_LENGTH_RE = /(?:entre|between)\s*(\d{2,5})\s*(?:y|and|-|–)\s*(\d{2,5})\s*(?:caracteres|car[aá]cteres|chars|characters)/i;

  /**
   * Mínimo de caracteres que el formulario EXIGE para aceptar el envío.
   *
   * Sin esto, una respuesta correcta pero breve (típicamente una pregunta
   * logística, que se responde en dos frases) es rechazada por el propio
   * formulario: Getonbrd pide "entre 300 y 2000 caracteres" y descarta lo que no
   * llegue. El mínimo no es una preferencia de estilo, es un requisito de envío.
   */
  function detectFieldMinimumLength(el) {
    if (!el) return null;

    const context = getFieldContext(el);
    const match = context.match(RANGE_LENGTH_RE)
      || context.match(/(?:m[ií]nimo|min\.?|al menos|as least|at least)[:\s]*(\d{2,5})\s*(?:caracteres|car[aá]cteres|chars|characters)/i);

    if (!match) return null;
    const min = parseInt(match[1], 10);
    // Un mínimo por debajo de 50 no condiciona nada, y uno enorme sería un
    // número mal leído del contexto.
    return min >= 50 && min <= 5000 ? min : null;
  }

  function detectFieldCharacterLimit(el) {
    if (!el) return null;

    if (el.maxLength && el.maxLength > 0 && el.maxLength < 50000) {
      return el.maxLength;
    }
    const dataMax = el.getAttribute("data-maxlength") || el.getAttribute("data-max-length") || el.getAttribute("data-max-chars") || el.getAttribute("data-character-limit");
    if (dataMax && parseInt(dataMax, 10) > 0) {
      return parseInt(dataMax, 10);
    }

    const context = getFieldContext(el);
    // Un rango ("entre 300 y 2000 caracteres", Getonbrd) aporta el techo en su
    // segundo número. Va primero porque los patrones de abajo no lo reconocen y
    // el campo se quedaba sin límite detectado.
    const rangeMatch = context.match(RANGE_LENGTH_RE);
    if (rangeMatch) {
      const max = parseInt(rangeMatch[2], 10);
      if (max >= 20 && max <= 10000) return max;
    }

    const charLimitMatch = context.match(/(?:m[aá]ximo|max|l[ií]mite|hasta|limit)[:\s]*(\d{2,5})\s*(?:caracteres|car[aá]cteres|chars|characters|letras)/i)
      || context.match(/(\d{2,5})\s*(?:caracteres|car[aá]cteres|chars|characters)\s*(?:m[aá]ximo|max|como m[aá]ximo)/i)
      || context.match(/\/\s*(\d{2,5})\s*(?:caracteres|chars|\))/i);

    if (charLimitMatch && charLimitMatch[1]) {
      const limit = parseInt(charLimitMatch[1], 10);
      if (limit >= 20 && limit <= 10000) return limit;
    }

    const wordLimitMatch = context.match(/(?:m[aá]ximo|max|l[ií]mite|hasta|limit)[:\s]*(\d{2,4})\s*(?:palabras|words)/i);
    if (wordLimitMatch && wordLimitMatch[1]) {
      return Math.floor(parseInt(wordLimitMatch[1], 10) * 6.5);
    }

    return null;
  }

  function enforceSafeCharacterLimit(text, limit) {
    if (!text || !limit || text.length <= limit) return text;
    const truncated = text.slice(0, limit);

    // Look for last period, exclamation, or question mark
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf(". "),
      truncated.lastIndexOf(".\n"),
      truncated.lastIndexOf("! "),
      truncated.lastIndexOf("? ")
    );

    if (lastSentenceEnd > limit * 0.6) {
      return truncated.slice(0, lastSentenceEnd + 1).trim();
    }

    // Sin punto final cercano: cerrar con "." en vez de "...". Un "..." se lee
    // como una idea cortada a medias en una respuesta de postulación laboral,
    // algo que nunca debe pasar aunque la última cláusula quede incompleta.
    const lastSpace = truncated.lastIndexOf(" ");
    const cut = lastSpace > limit * 0.5 ? truncated.slice(0, lastSpace) : truncated;
    const closed = cut.trim().replace(/[,;:\-–—]+$/, "");
    return /[.!?]$/.test(closed) ? closed : `${closed}.`;
  }

  function cleanQuestionText(raw) {
    return raw
      // Numeración de listado ("1. ", "2) ") que anteponen formularios como
      // HiringRoom: no aporta nada a la pregunta y ensucia la detección.
      .replace(/^\s*\d{1,2}\s*[.)]\s+/, "")
      .replace(/urn:li:[^\s]+/gi, "")
      .replace(/single-line-text-form-component[^\s]*/gi, "")
      .replace(/job_application(_\w+|\[[^\]]*\])*/gi, "")
      .replace(/question_\d+/gi, "")
      .replace(/data-test-[^\s]*/gi, "")
      .replace(/ember\d+/gi, "")
      .replace(/\*\s*(requerido|obligatorio|required)/gi, "")
      .replace(/\((requerido|obligatorio|required|opcional|optional)\)/gi, "")
      // Etiquetas de la barra de un editor enriquecido que hayan sobrevivido al
      // filtrado estructural (algunos editores las ponen en <span>, no en
      // <button>). Se exige una racha de 3 o más seguidas para no borrar una
      // palabra legítima del enunciado: "Code" o "Link" sueltos pueden ser parte
      // de la pregunta, pero "Bold Italic Strikethrough" nunca lo es.
      .replace(
        /(?:\b(?:bold|italic|strikethrough|underline|link|heading|quote|code|bullets|numbers|decrease level|increase level|attach files|undo|redo|negrita|cursiva|tachado|subrayado|enlace|encabezado|cita|c[oó]digo|vi[nñ]etas|n[uú]meros|disminuir nivel|aumentar nivel|adjuntar archivos|deshacer|rehacer)\b[\s,]*){3,}/gi,
        " "
      )
      // Mensajes de validación y avisos del formulario: describen el campo, no
      // preguntan nada, y contaminan tanto el enunciado como la detección de idioma.
      .replace(/[^.!?]*\b(?:no puede estar en blanco|no puede quedar vac[ií]o|es obligatorio|campo requerido|can't be blank|cannot be blank|is required)\b[^.!?]*[.!?]?/gi, " ")
      .replace(/[^.!?]*\b(?:aseg[uú]rate|aseg[uú]rese|make sure|ensure)\b[^.!?]*\b(?:caracteres|characters)\b[^.!?]*[.!?]?/gi, " ")
      .replace(/[^.!?]*\b(?:guardaremos este campo|we'll save this field|se guardar[aá] para futuras)\b[^.!?]*[.!?]?/gi, " ")
      // Contador de caracteres suelto ("0", "0/2000") que queda tras lo anterior.
      .replace(/(?:^|\s)\d{1,5}\s*\/\s*\d{1,5}(?=\s|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // Un contador "0" pegado al final tras quitar su etiqueta.
      .replace(/\s+\d{1,5}$/, "")
      .trim();
  }

  /**
   * Muletillas de placeholder que NO son preguntas. Un placeholder así es
   * idéntico en todos los campos del formulario, así que usarlo como pregunta
   * hace que campos distintos generen la misma consulta.
   */
  const GENERIC_PLACEHOLDER_RE = /^(ingresa|ingrese|escribe|escriba|introduce|introduzca|complete|completa|tu|su|type|enter|write|your)\b[\s\S]{0,40}$/i;

  function isGenericPlaceholder(placeholder) {
    const text = placeholder.trim().replace(/[.…]+$/, "");
    // Si contiene un signo de interrogación es una pregunta de verdad, no una
    // muletilla, por más que empiece por "Describe" o "Cuéntanos".
    if (/[?¿]/.test(text)) return false;
    return GENERIC_PLACEHOLDER_RE.test(text);
  }

  /**
   * Sube por los ancestros buscando el bloque más grande que todavía contenga
   * ESTE campo y ningún otro, y devuelve su texto como pregunta.
   *
   * Pensado para formularios CSS-in-JS (HiringRoom y similares) donde no hay
   * ninguna pista semántica: ni id, ni name, ni label asociado, ni clases
   * legibles. El texto de la pregunta solo existe como contenido de un div
   * ancestro, y la única forma fiable de saber que ese texto pertenece a este
   * campo y no a otro es exigir que el bloque no contenga más campos.
   */
  /**
   * Texto de un bloque descartando el "cromo" del formulario: barras de
   * herramientas de editores enriquecidos (Trix en Getonbrd, Quill, TinyMCE),
   * botones, contadores y mensajes de validación.
   *
   * Sin esto, el enunciado que se lee en un campo con editor enriquecido llega
   * como "Cuéntanos sobre tu experiencia... Bold Italic Strikethrough Link
   * Heading Quote Code Bullets Numbers ... Attach Files 0 Asegúrate que el largo
   * sea entre 300 y 2000 caracteres." — la pregunta real sepultada entre las
   * etiquetas de los botones. Se elimina por ESTRUCTURA (los nodos que no son
   * enunciado) en vez de por lista de palabras, que dependería del idioma y del
   * editor concreto.
   */
  function readBlockText(node) {
    let clone;
    try {
      clone = node.cloneNode(true);
    } catch (e) {
      return (node.innerText || "").trim();
    }

    clone.querySelectorAll(
      "trix-toolbar, [role='toolbar'], [class*='toolbar'], button, [role='button'], " +
      "select, option, [class*='counter'], [class*='char-count'], [class*='error'], " +
      "[class*='invalid'], [class*='validation'], script, style, svg"
    ).forEach(n => n.remove());

    // El clon no está renderizado, así que innerText cae a textContent: se
    // normalizan los saltos que el marcado deja entre nodos.
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findQuestionByAncestorBlock(el) {
    let node = el.parentElement;
    let best = null;

    for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
      const controls = node.querySelectorAll(
        "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select, [contenteditable='true']"
      );
      // En cuanto el bloque abarca otro campo deja de describir solo a este:
      // seguir subiendo devolvería las preguntas del formulario entero juntas.
      if (controls.length !== 1) break;

      const text = readBlockText(node);
      // Se queda con el texto del bloque MÁS AMPLIO que sigue siendo de este
      // campo: el div inmediato suele envolver solo al input y venir vacío,
      // mientras que el enunciado vive uno o dos niveles más arriba.
      if (text.length >= 8 && text.length <= 400) best = text;

      node = node.parentElement;
    }

    return best;
  }

  function extractHumanQuestion(el) {
    let questionCandidates = [];

    // 1. Explicit <label for="...">  — la fuente más específica: apunta exactamente a este campo.
    if (el.id) {
      try {
        const label = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && label.innerText) questionCandidates.push(label.innerText);
      } catch (e) {}
    }

    // 2. aria-labelledby o aria-describedby — igual de específico (ids exactos).
    const labelledBy = el.getAttribute("aria-labelledby") || el.getAttribute("aria-describedby");
    if (labelledBy) {
      const parts = labelledBy.split(" ").map(id => {
        try {
          const labelEl = rootOf(el).getElementById(id);
          return labelEl && labelEl.innerText ? labelEl.innerText : "";
        } catch (e) { return ""; }
      }).filter(Boolean);
      if (parts.length) questionCandidates.push(parts.join(" "));
    }

    // 3. <label> que envuelve directamente el campo.
    const parentLabel = el.closest("label, .fb-form-element-label, .gb-label, .form-label");
    if (parentLabel && parentLabel.innerText) questionCandidates.push(parentLabel.innerText);

    // 4. Bloque contenedor angosto de ESTE campo (Getonbrd: .gb-form-group / .input-container
    // envuelve un único input, así que su label es tan específico como el del propio campo).
    const container = el.closest(".form-group, .field, [class*='question'], [class*='field'], [class*='form-row'], .fb-single-line-text, .fb-dropdown, .gb-form-group, .input-container");
    if (container) {
      const labelEl = container.querySelector("label, .label, [class*='label'], [class*='title'], [class*='heading'], h3, h4, legend, span.label-text, p.help-block");
      if (labelEl && labelEl.innerText && labelEl.innerText.length < 350) {
        questionCandidates.push(labelEl.innerText);
      }
    }

    // 5. Fieldset legend / role=heading — ÚLTIMO recurso, no primero: un <fieldset> a
    // menudo envuelve TODO un bloque de "preguntas adicionales" (varias preguntas
    // distintas comparten el mismo fieldset ancestro), así que su legend describe la
    // sección completa, no este campo puntual. Priorizarlo antes que el label/contenedor
    // específico del campo hacía que TODAS las preguntas de esa sección recibieran el
    // mismo título genérico de sección — la causa del desfase pregunta/respuesta en
    // Getonbrd cuando varias preguntas personalizadas comparten fieldset.
    const fieldset = el.closest("fieldset, [role='radiogroup'], [role='group']");
    if (fieldset) {
      const legend = fieldset.querySelector("legend, [role='heading'], .fb-form-element-label, .t-14, .label");
      if (legend && legend.innerText) questionCandidates.push(legend.innerText);
    }

    // 6. Elemento anterior si es un heading/label.
    let prev = el.previousElementSibling;
    if (prev && (prev.tagName === "LABEL" || prev.tagName === "SPAN" || prev.tagName === "P" || prev.tagName === "H3" || prev.tagName === "H4") && prev.innerText && prev.innerText.length < 250) {
      questionCandidates.push(prev.innerText);
    }

    // 6.5. Bloque ancestro que contiene UN ÚNICO campo (HiringRoom y cualquier
    // otro formulario hecho con styled-components / CSS-in-JS). Ahí las clases
    // son hashes (`sc-gtsrHT eqrnRd`) y los campos no traen id, name, aria-label
    // ni <label for>: los pasos 1-6 fallan todos y la pregunta real solo existe
    // como texto de un div ancestro. Sin este paso se caía al placeholder, que
    // en HiringRoom es "Ingresa tu respuesta..." para TODAS las preguntas — así
    // que las 4 preguntas del formulario llegaban a Claude como el mismo texto
    // vacío de contenido y las respuestas no guardaban relación con lo que se
    // preguntaba.
    //
    // La condición de "un único campo" es lo que lo hace seguro: se sube
    // mientras el bloque siga conteniendo exactamente este control, y se para
    // en cuanto abarque dos o más. Así nunca devuelve el texto del formulario
    // completo (que mezclaría las 4 preguntas), solo el bloque de este campo.
    const ancestorBlockQuestion = findQuestionByAncestorBlock(el);
    if (ancestorBlockQuestion) questionCandidates.push(ancestorBlockQuestion);

    // 7. Atributos de respaldo.
    if (el.getAttribute("aria-label")) questionCandidates.push(el.getAttribute("aria-label"));
    // El placeholder va al final y solo si NO es una muletilla genérica: un
    // "Ingresa tu respuesta..." es indistinguible entre campos y convierte
    // preguntas distintas en la misma consulta a Claude. Mejor no ofrecer
    // pregunta (el llamador avisa al usuario) que ofrecer una falsa.
    if (el.placeholder && el.placeholder.length > 5 && !isGenericPlaceholder(el.placeholder)) {
      questionCandidates.push(el.placeholder);
    }

    // Usar la PRIMERA fuente válida (en orden de confianza) en vez de concatenar
    // las 7: unirlas todas duplicaba el mismo texto (label + aria-labelledby
    // apuntando al mismo elemento) y colaba texto ajeno a la pregunta real
    // (p. ej. un contenedor amplio que también capturaba un aviso
    // "(obligatorio)" o el label de un campo vecino). Eso generaba preguntas
    // ilegibles enviadas a Claude y contaminaba la detección de idioma.
    for (const raw of questionCandidates) {
      if (!raw) continue;
      const cleaned = cleanQuestionText(raw);
      if (cleaned.length >= 3) return cleaned;
    }

    return getFieldContext(el);
  }

  /**
   * Texto completo de la oferta (no solo título/empresa), para que Claude pueda
   * anclar la respuesta a los requisitos y palabras clave reales del puesto en
   * vez de generalizar a partir de un simple título de cargo.
   */
  /**
   * ─── CONTEXTO DE LA OFERTA, PERSISTIDO ENTRE PÁGINAS ───────────────────────
   *
   * El formulario de postulación y la publicación de la oferta casi nunca son la
   * misma página, y a veces ni el mismo dominio: en HiringRoom el formulario vive
   * en /jobs/answer-questions/<hash>, una página que NO contiene el cargo, la
   * empresa ni la descripción. Leyendo solo la página actual, Claude redactaba a
   * ciegas sobre el puesto y el "cargo" detectado era el <h1> de turno
   * ("Responde estas preguntas").
   *
   * Por eso el contexto se captura cuando el usuario pasa por la oferta y se
   * guarda; al llegar al formulario se reutiliza. La fuente es el DOM, que ya
   * tiene el texto exacto y estructurado.
   *
   * Se descarta en cuanto deja de ser válido: al detectar una postulación
   * enviada, o al caducar. Un contexto viejo es peor que ninguno, porque
   * produce respuestas convincentes sobre el puesto equivocado.
   */
  // Lista de ofertas recientes, no una sola: postular pasando por varios
  // portales es lo normal (se abren 3 ofertas en pestañas y se postula a la
  // segunda). Con una única clave global, la última oferta vista pisaba a las
  // demás y el formulario redactaba sobre el puesto equivocado — con una
  // respuesta impecable, que es lo que lo hace peligroso.
  const JOB_CONTEXTS_KEY = "recentJobContexts";
  const MAX_JOB_CONTEXTS = 6;
  const JOB_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000; // 6 h: una sesión de búsqueda

  /**
   * Señales de que la postulación ya se envió: el contexto deja de servir.
   *
   * Se comparan sobre texto normalizado (sin tildes y en minúsculas), así que
   * aquí van SIN tildes: "postulacion enviada" cubre también "postulación
   * enviada". Cubre español, inglés y portugués, que es lo que usan los
   * portales de la región (Gupy y Bumeran publican en pt-BR).
   */
  const SUBMISSION_SIGNALS = [
    // Español
    "postulacion enviada", "postulacion exitosa", "postulacion recibida", "gracias por postular",
    "hemos recibido tu postulacion", "recibimos tu postulacion", "tu postulacion fue enviada",
    "candidatura enviada", "solicitud enviada", "ya postulaste", "postulaste a este aviso",
    "tu solicitud ha sido enviada", "gracias por tu interes",
    // Inglés
    "application submitted", "application received", "application sent", "thank you for applying",
    "we received your application", "your application has been sent", "successfully applied",
    "you have already applied", "thanks for applying",
    // Portugués
    "candidatura enviada", "inscricao enviada", "obrigado por se candidatar", "recebemos sua candidatura"
  ];

  function normalizeForSignals(text) {
    return (text || "").normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "").toLowerCase();
  }

  function pageShowsSubmissionSignal() {
    const text = normalizeForSignals(document.body?.innerText || "").slice(0, 5000);
    return SUBMISSION_SIGNALS.some(signal => text.includes(signal));
  }

  /**
   * Títulos de página que NO son un cargo. Un <h1> es el último recurso de la
   * cascada y en una página de formulario suele ser el título de la pantalla
   * ("Responde estas preguntas"), que cacheado como cargo contamina el contexto.
   */
  const NON_TITLE_PATTERNS = /^(responde|postula|postular|aplica|apply|application|formulario|preguntas|questions|completa|complete|gracias|thank|inicia sesi[oó]n|sign in|log in|registr|crea tu|create)/i;

  function firstMatchingText(selectors, { min, max, reject } = {}) {
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) { continue; }

      for (const node of nodes) {
        const text = node?.innerText?.trim().replace(/\s+/g, " ");
        if (!text || text.length < min || text.length > max) continue;
        if (reject && reject.test(text)) continue;
        return text;
      }
    }
    return "";
  }

  function extractJobTitle() {
    // Ordenados de más específico a más genérico: un selector propio del portal
    // es fiable; un <h1> puede ser cualquier cosa.
    return firstMatchingText([
      // Datos estructurados (los publican varios portales)
      "[itemprop='title']",
      // LinkedIn
      ".jobs-unified-top-card__job-title", ".job-details-jobs-unified-top-card__job-title",
      ".topcard__title", ".t-24.job-details-jobs-unified-top-card__job-title",
      // Workday
      "[data-automation-id='jobPostingHeader']",
      // Lever
      ".posting-headline h2",
      // Greenhouse
      ".app-title", ".job__title h1", "#header .app-title",
      // SmartRecruiters / Teamtailor / Recruitee / Workable
      ".job-title", "[data-test='job-title']", ".careers-hero h1", ".job-header__title",
      // Getonbrd
      ".gb-job-title", "#job-title",
      // Computrabajo: verificado contra el DOM real. La vista de resultados es
      // maestro-detalle (lista a la izquierda, oferta abierta a la derecha) sin
      // navegar de página, y el título del panel de detalle es un <p
      // class="title_offer">, no un h1/h2 — por eso el <h1> de la página
      // ("287 Ofertas de trabajo de ia en Chile", el título de la BÚSQUEDA
      // completa) se colaba como si fuera el cargo. Es la página de detalle
      // standalone (otra URL) la que sí trae un <h1> correcto y único, cubierta
      // por el <h1> genérico al final de esta lista.
      ".title_offer",
      // Bumeran / Laborum / Trabajando / Indeed
      ".box_detail h1", "[class*='JobTitle']", ".job-detail__title", ".title-jobs",
      "h1[data-testid='jobsearch-JobInfoHeader-title']",
      // Workable
      "[data-ui='job-title']"
    ], { min: 3, max: 120, reject: NON_TITLE_PATTERNS })
      // JSON-LD antes que los genéricos: un <h1> puede ser cualquier cosa.
      || jsonLdTitle()
      || firstMatchingText(["[class*='job-title']", "[class*='jobtitle']", "h1.title", "h1"], { min: 3, max: 120, reject: NON_TITLE_PATTERNS });
  }

  function extractCompanyName() {
    return Portals.cleanCompanyName(extractCompanyNameRaw());
  }

  function extractCompanyNameRaw() {
    return firstMatchingText([
      "[itemprop='hiringOrganization']",
      // LinkedIn
      ".jobs-unified-top-card__company-name", ".job-details-jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
      // Workday / Lever / Greenhouse
      "[data-automation-id='jobPostingCompany']", ".posting-categories .sort-by-team", ".company-name",
      // SmartRecruiters / Teamtailor / Workable
      "[data-test='company-name']", ".job-header__company", ".company__name",
      // Computrabajo: el panel de detalle (misma estructura maestro-detalle
      // que .title_offer arriba) enlaza la empresa con /empresas/ en el href,
      // sin ninguna clase semántica propia — verificado contra el DOM real.
      ".box_detail.post a[href*='/empresas/']",
      // Getonbrd / Bumeran / Indeed
      ".gb-company-name", "[class*='company-name']", "[class*='CompanyName']",
      "[data-testid='inlineHeader-companyName']"
    ], { min: 2, max: 80 })
      || jsonLdCompany()
      || firstMatchingText(["[class*='employer']", "[class*='company']"], { min: 2, max: 80 });
  }

  /**
   * Ofertas recientes vigentes, más nueva primero.
   *
   * Solo se exige `title`: la descripción puede venir vacía en una captura
   * manual por visión (el respaldo de pantalla solo lee el título, nunca la
   * descripción completa) o si el usuario la dejó en blanco a propósito en el
   * panel de revisión — un cargo sin descripción sigue siendo útil para
   * identificar la oferta, aunque el prompt tenga menos con qué trabajar.
   */
  async function loadJobContexts() {
    try {
      const stored = (await chrome.storage.local.get(JOB_CONTEXTS_KEY))[JOB_CONTEXTS_KEY];
      if (!Array.isArray(stored)) return [];
      const now = Date.now();
      return stored
        .filter(c => c && c.title && now - c.capturedAt < JOB_CONTEXT_TTL_MS)
        .sort((a, b) => b.capturedAt - a.capturedAt);
    } catch (e) {
      console.warn("[JobFill AI] No se pudo leer el contexto cacheado:", e);
      return [];
    }
  }

  /**
   * Devuelve si el guardado se completó. Los dos fallos reales aquí son la
   * cuota de `chrome.storage.local` (una descripción de oferta larga por cada
   * oferta cacheada suma rápido) y la pestaña huérfana tras recargar la
   * extensión. Antes ambos rompían sin capturar y el llamador seguía como si
   * hubiera guardado, mostrando "✓ Cargo guardado" sobre algo que se perdió.
   */
  async function saveJobContexts(contexts) {
    try {
      await chrome.storage.local.set({ [JOB_CONTEXTS_KEY]: contexts.slice(0, MAX_JOB_CONTEXTS) });
      return true;
    } catch (e) {
      console.warn("[JobFill AI] No se pudo guardar el cargo en el almacenamiento local:", e);
      return false;
    }
  }


  /**
   * Puntúa cuánto encaja una oferta guardada con la página actual.
   *
   * Con varios portales abiertos a la vez, "la más reciente" es una apuesta
   * mala: se postula a la segunda oferta abierta tan a menudo como a la última.
   * Se buscan pruebas de relación —mismo dominio, la página nombra el cargo o la
   * empresa, se llegó desde la oferta— y la recencia solo desempata.
   */
  function scoreJobContext(context, pageText, referrerHost) {
    let score = 0;
    const title = normalizeForSignals(context.title);
    const company = normalizeForSignals(context.company || "");

    if (context.host === location.hostname) score += 50;
    if (referrerHost && referrerHost === context.host) score += 40;
    // La prueba más fuerte: el formulario menciona el cargo al que postulas.
    if (title.length > 6 && pageText.includes(title)) score += 100;
    if (company.length > 2 && pageText.includes(company)) score += 60;
    // Desempate por recencia, deliberadamente pequeño (máx. 10 puntos).
    const ageHours = (Date.now() - context.capturedAt) / 3600000;
    score += Math.max(0, 10 - ageHours);
    return score;
  }

  /**
   * Devuelve el contexto a usar: el de ESTA página si es fiable, y si no, la
   * oferta guardada que mejor encaje.
   */
  async function resolveJobContext() {
    const { text: description, reliable } = extractJobDescriptionWithSource();
    const title = extractJobTitle();

    // La página actual solo gana a la caché si su oferta viene de una fuente
    // fiable. En el formulario de HiringRoom el respaldo genérico devuelve el
    // texto del propio formulario: preferirlo descartaría el contexto bueno
    // capturado en la oferta y se redactaría sobre la nada.
    if (reliable && description && description.length >= 400 && title) {
      return { title, company: extractCompanyName(), description, fromCache: false, candidates: [] };
    }

    const contexts = await loadJobContexts();
    if (contexts.length) {
      const pageText = normalizeForSignals(document.body?.innerText || "").slice(0, 6000);
      let referrerHost = "";
      try { referrerHost = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) {}

      const ranked = contexts
        .map(c => ({ context: c, score: scoreJobContext(c, pageText, referrerHost) }))
        .sort((a, b) => b.score - a.score);

      const best = ranked[0];
      // Sin ninguna prueba de relación (solo recencia) y con varias ofertas
      // guardadas, elegir por nuestra cuenta sería adivinar: se marca para que
      // el usuario confirme cuál es en el diálogo.
      const hasEvidence = best.score >= 40;
      return {
        title: best.context.title,
        company: Portals.cleanCompanyName(best.context.company),
        description: best.context.description,
        fromCache: true,
        capturedAt: best.context.capturedAt,
        uncertain: !hasEvidence && ranked.length > 1,
        candidates: ranked.map(r => r.context)
      };
    }

    // Sin contexto fiable: mejor lo poco que dé esta página que nada.
    return { title, company: extractCompanyName(), description: description || "", fromCache: false, candidates: [] };
  }

  /**
   * Al detectar una postulación enviada se descarta SOLO la oferta a la que se
   * postuló, no todas: con varios portales abiertos, las demás siguen vigentes.
   */
  async function clearJobContextIfSubmitted() {
    try {
      const contexts = await loadJobContexts();
      if (!contexts.length) return;

      const pageText = normalizeForSignals(document.body?.innerText || "").slice(0, 6000);
      let referrerHost = "";
      try { referrerHost = document.referrer ? new URL(document.referrer).hostname : ""; } catch (e) {}

      const ranked = contexts
        .map(c => ({ context: c, score: scoreJobContext(c, pageText, referrerHost) }))
        .sort((a, b) => b.score - a.score);

      const submitted = ranked[0];
      if (submitted.score < 40) return; // sin pruebas de a cuál se postuló, no se toca nada

      await saveJobContexts(contexts.filter(c => c !== submitted.context));
      console.log("[JobFill AI] Postulación enviada:", submitted.context.title, "— oferta descartada del contexto.");
    } catch (e) {
      console.warn("[JobFill AI] No se pudo limpiar el contexto:", e);
    }
  }

  /**
   * ¿Esta página es la publicación de una oferta?
   *
   * Sirve para autorizar el respaldo genérico de extracción, que lee el cuerpo
   * de la página. Sin esta comprobación, una página de formulario (que no
   * contiene la oferta) devolvería su propio texto como "descripción del
   * puesto", y se cachearía como contexto: el peor resultado posible, porque
   * Claude redactaría con basura creyendo tener la oferta.
   */
  function looksLikeJobPosting() {
    if (/\/(jobs?|empleos?|trabajos?|vacantes?|careers?|puestos?|ofertas?)\//i.test(location.pathname)) return true;
    const text = (document.body?.innerText || "").toLowerCase().slice(0, 3000);
    const markers = ["postular", "postúlate", "apply now", "descripción del puesto", "job description", "requisitos", "requirements", "responsabilidades", "responsibilities"];
    return markers.filter(m => text.includes(m)).length >= 2;
  }

  /**
   * Oferta publicada como datos estructurados schema.org/JobPosting (la
   * publican Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Teamtailor,
   * Personio, Getonbrd y casi cualquier sitio que quiera salir en Google
   * Jobs). Acepta un objeto, un array o un `@graph` (WordPress/Yoast).
   */
  function findJobPostingJsonLd() {
    const isPosting = o => o && (o["@type"] === "JobPosting" || (Array.isArray(o["@type"]) && o["@type"].includes("JobPosting")));
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent);
        const entries = (Array.isArray(parsed) ? parsed : [parsed])
          .flatMap(o => (o && Array.isArray(o["@graph"]) ? o["@graph"] : [o]));
        const posting = entries.find(isPosting);
        if (posting) return posting;
      } catch (e) { /* JSON-LD malformado: se ignora y se sigue con el DOM */ }
    }
    return null;
  }

  /** Texto plano de un valor JSON-LD (la descripción suele venir en HTML). DOMParser es inerte: no carga imágenes ni ejecuta nada. */
  function jsonLdText(value) {
    const doc = new DOMParser().parseFromString(String(value || ""), "text/html");
    return (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function jsonLdTitle() {
    const t = jsonLdText(findJobPostingJsonLd()?.title);
    return t.length >= 3 && t.length <= 120 && !NON_TITLE_PATTERNS.test(t) ? t : "";
  }

  function jsonLdCompany() {
    const org = findJobPostingJsonLd()?.hiringOrganization;
    const t = jsonLdText(typeof org === "string" ? org : org?.name);
    return t.length >= 2 && t.length <= 80 ? t : "";
  }

  function extractJobPostingJsonLd() {
    const posting = findJobPostingJsonLd();
    if (!posting?.description) return "";
    const text = jsonLdText(posting.description);
    return text.length > 200 ? text.slice(0, 6000) : "";
  }

  /**
   * Bloques de texto enriquecido que componen la oferta cuando NO hay un único
   * contenedor que la envuelva.
   *
   * Getonbrd es el caso: la oferta se reparte en varios `div.gb-rich-txt`
   * (descripción, funciones, requisitos, beneficios), no existe <main>, y
   * ningún selector de contenedor casa. El resultado era una descripción VACÍA
   * — Claude redactaba sin conocer el puesto y nadie se enteraba.
   */
  function extractRichTextBlocks() {
    const blocks = [...document.querySelectorAll("[class*='rich-txt'], [class*='rich-text'], [class*='richtext']")]
      .map(n => (n.innerText || "").trim())
      .filter(t => t.length > 80);

    if (!blocks.length) return "";
    // Se deduplica: los contenedores anidados repiten el texto de sus hijos.
    const unique = blocks.filter((t, i) => !blocks.some((other, j) => j !== i && other.length > t.length && other.includes(t)));
    return unique.join("\n\n").slice(0, 6000);
  }

  /**
   * Último recurso: el bloque de texto más sustancial de la página, excluyendo
   * navegación, pies y formularios. Solo se usa en páginas que parecen una
   * oferta publicada.
   */
  function extractLargestTextBlock() {
    if (!looksLikeJobPosting()) return "";

    let best = "";
    for (const node of document.querySelectorAll("article, section, div")) {
      // Un bloque que contiene el formulario no es la descripción del puesto.
      if (node.querySelector("form, textarea, input[type='file']")) continue;
      if (node.closest("nav, header, footer, aside")) continue;

      const text = (node.innerText || "").trim();
      if (text.length > best.length && text.length >= 400 && text.length <= 15000) {
        best = text;
      }
    }
    return best.slice(0, 6000);
  }

  /**
   * Devuelve la descripción y DE DÓNDE salió.
   *
   * La procedencia importa tanto como el texto: `largest-block` es una
   * heurística de último recurso que en una página de formulario puede devolver
   * el texto del propio formulario. Ese texto NUNCA debe cachearse como oferta
   * ni preferirse sobre un contexto bueno ya guardado — produciría respuestas
   * seguras de sí mismas sobre un puesto inexistente.
   *
   * Se distingue por procedencia y no por heurísticas sobre la página porque
   * estas últimas no discriminan: una oferta real de Getonbrd tiene 25 campos
   * de formulario (el modal de "reportar aviso"), así que "parece formulario"
   * no significa "no es una oferta".
   */
  function extractJobDescriptionWithSource() {
    // Fuente preferida: datos estructurados. Cuando existen son exactos y ya
    // vienen sin el "cromo" de la página.
    const structured = extractJobPostingJsonLd();
    if (structured) return { text: structured, source: "json-ld", reliable: true };

    const selectors = [
      // LinkedIn (página de detalle y modal de Easy Apply)
      ".jobs-description__content", ".jobs-box__html-content", "#job-details",
      // Greenhouse
      "#content .job__description", "#job-content", "#app-body",
      // Getonbrd
      ".job-description", ".gb-job-description", "[class*='job-description']",
      // Computrabajo: verificado contra el DOM real (panel maestro-detalle).
      ".description_offer",
      // Workday
      "[data-automation-id='jobPostingDescription']",
      // Lever
      ".posting-description", ".section-wrapper.page-full-width",
      // Microdatos schema.org (muchos sitios de empleo propios)
      "[itemprop='description']",
      // Workable / SmartRecruiters / Ashby
      "[data-ui='job-description']", ".job-sections", "[class*='descriptionText']",
      // Genérico de respaldo
      "[class*='jobdescription']", "[class*='job_description']", "main"
    ];

    for (const sel of selectors) {
      const node = document.querySelector(sel);
      const text = node?.innerText?.trim();
      if (text && text.length > 100) {
        return { text: text.slice(0, 6000), source: "selector", reliable: true };
      }
    }

    // Sitios donde la oferta se reparte en varios bloques sin contenedor común
    // (Getonbrd): sigue siendo una fuente fiable, apunta a contenido editorial.
    const rich = extractRichTextBlocks();
    if (rich) return { text: rich, source: "rich-text", reliable: true };

    // Último recurso, NO fiable: puede ser el texto de un formulario.
    const largest = extractLargestTextBlock();
    if (largest) return { text: largest, source: "largest-block", reliable: false };

    return { text: "", source: "", reliable: false };
  }

  function extractJobDescription() {
    return extractJobDescriptionWithSource().text;
  }

  /**
   * Respuestas ya redactadas por Claude en ESTE formulario, por campo. Se envían
   * en la siguiente llamada para que el modelo no entregue tres párrafos casi
   * calcados (misma apertura, mismo proyecto) a tres preguntas distintas: el
   * reclutador las lee juntas y la plantilla queda a la vista.
   *
   * Es un Map (clave = el propio elemento) y no un array para que regenerar la
   * respuesta de un campo REEMPLACE la anterior en vez de acumular una versión
   * obsoleta que luego el modelo intentaría evitar repetir.
   */
  const generatedAnswersByField = new Map();

  function rememberGeneratedAnswer(el, answer) {
    generatedAnswersByField.set(el, answer);
  }

  function getPreviousAnswers(currentEl) {
    const answers = [];
    for (const [el, answer] of generatedAnswersByField) {
      // Excluir el propio campo: al regenerar, su respuesta anterior se descarta,
      // no es algo de lo que haya que diferenciarse.
      if (el === currentEl) continue;
      // Un campo ya editado a mano o desmontado del DOM ya no representa lo que
      // el reclutador va a leer.
      if (!el.isConnected) continue;
      if (typeof el.value === "string" && el.value.trim() !== answer.trim()) continue;
      answers.push(answer);
    }
    return answers;
  }

  /**
   * Muestra la pregunta que se interpretó del DOM y espera la confirmación del
   * usuario antes de llamar a Claude.
   *
   * El texto es EDITABLE a propósito: cuando la extracción falla (formularios
   * sin marcado semántico, enunciados partidos en varios nodos), esta ventana
   * deja de ser solo un aviso y pasa a ser el arreglo — el usuario corrige el
   * enunciado y obtiene igualmente su respuesta, sin depender de que la
   * extensión entienda ese sitio.
   *
   * Devuelve la pregunta confirmada (posiblemente editada) o null si se cancela.
   */
  /**
   * Estilos del diálogo, incrustados en su propio Shadow DOM en vez de vivir en
   * autofill.css. Un componente en Shadow DOM no hereda los estilos de la
   * página, así que tendría que cargarlos por <link> desde el paquete de la
   * extensión — lo que añade tres formas de fallar: depender de declararlo en
   * web_accessible_resources, un parpadeo sin estilos mientras la hoja carga, y
   * un diálogo crudo si la carga falla. Incrustarlos elimina las tres.
   * Se incluyen las animaciones porque las de la hoja global no cruzan el shadow.
   */
  const CONFIRM_DIALOG_STYLES = `
    @keyframes jf-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes jf-pop-in {
      from { opacity: 0; transform: translateY(8px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    :host { all: initial; }
    .jobfill-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(15, 23, 42, 0.5);
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
      animation: jf-fade-in 0.15s ease;
    }
    .jobfill-confirm {
      box-sizing: border-box;
      width: min(560px, 100%);
      max-height: 90vh;
      overflow-y: auto;
      padding: 22px;
      border-radius: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #f8fafc;
      background: #0f172a;
      border: 1px solid rgba(148, 163, 184, 0.18);
      box-shadow: 0 24px 60px -16px rgba(2, 6, 23, 0.7), 0 2px 8px rgba(2, 6, 23, 0.3);
      animation: jf-pop-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .jobfill-confirm h3 {
      margin: 0 0 6px;
      font-size: 15.5px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    @media (prefers-reduced-motion: reduce) {
      .jobfill-overlay, .jobfill-confirm { animation: none; }
    }
    .jobfill-confirm p {
      margin: 0 0 14px;
      font-size: 12.5px;
      line-height: 1.5;
      color: #94a3b8;
    }
    .jobfill-confirm strong { color: #cbd5e1; }
    .jobfill-confirm textarea {
      box-sizing: border-box;
      display: block;
      width: 100%;
      min-height: 88px;
      padding: 11px 13px;
      border-radius: 9px;
      font-family: inherit;
      font-size: 13.5px;
      line-height: 1.5;
      color: #f8fafc;
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.14);
      resize: vertical;
    }
    .jobfill-confirm textarea:focus {
      outline: none;
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
    }
    .jobfill-confirm-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 9px;
      margin-top: 16px;
    }
    .jobfill-confirm button {
      flex: 1 1 auto;
      padding: 10px 16px;
      border: 1px solid transparent;
      border-radius: 9px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.15s ease;
    }
    .jobfill-confirm button:hover { filter: brightness(1.12); }
    .jobfill-confirm button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
    .jobfill-confirm-ok {
      color: #fff;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      box-shadow: 0 6px 16px -6px rgba(99, 102, 241, 0.7);
    }
    .jobfill-confirm-cancel {
      color: #cbd5e1;
      background: transparent;
      border-color: rgba(255, 255, 255, 0.18);
    }
    .jobfill-confirm-skip {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-top: 14px;
      font-size: 12px;
      color: #94a3b8;
      cursor: pointer;
    }
    .jobfill-confirm-skip input { cursor: pointer; }
    .jobfill-field {
      margin-bottom: 12px;
    }
    .jobfill-field label {
      display: block;
      margin-bottom: 5px;
      font-size: 11.5px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .jobfill-field input[type="text"] {
      box-sizing: border-box;
      width: 100%;
      padding: 9px 11px;
      border-radius: 8px;
      font-family: inherit;
      font-size: 13.5px;
      color: #f8fafc;
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.14);
    }
    .jobfill-field input[type="text"]:focus {
      outline: none;
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
    }
    .jobfill-field textarea { min-height: 60px; }
    .jobfill-panel-source {
      margin: -4px 0 14px;
      font-size: 11.5px;
      color: #64748b;
    }
    .jobfill-confirm-danger {
      color: #fca5a5;
      background: transparent;
      border-color: rgba(248, 113, 113, 0.35);
      flex: 0 0 auto;
    }
    .jobfill-context {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 9px;
      font-size: 12px;
      line-height: 1.45;
      color: #cbd5e1;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.3);
    }
    .jobfill-context strong { color: #f8fafc; }
    .jobfill-context > div { flex: 1; min-width: 0; }
    .jobfill-context-uncertain {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.4);
    }
    .jobfill-context-select {
      box-sizing: border-box;
      width: 100%;
      margin-top: 9px;
      padding: 7px 9px;
      border-radius: 7px;
      font-family: inherit;
      font-size: 12.5px;
      color: #f8fafc;
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.16);
      cursor: pointer;
    }
    .jobfill-context-select:focus {
      outline: none;
      border-color: #6366f1;
    }`;

  /** Estilos extra del diálogo de cobertura (se suman a los del de confirmación). */
  const COVERAGE_DIALOG_STYLES = `
    .jobfill-group {
      margin-top: 14px;
      padding: 13px 14px;
      border-radius: 10px;
      background: rgba(148, 163, 184, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .jobfill-group h4 {
      margin: 0 0 4px;
      font-size: 12.5px;
      font-weight: 700;
      color: #e2e8f0;
    }
    .jobfill-group-hint {
      margin: 0 0 10px !important;
      font-size: 11.5px !important;
      line-height: 1.45 !important;
    }
    .jobfill-terms {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .jobfill-term {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 11px;
      border-radius: 999px;
      font-size: 12.5px;
      color: #e2e8f0;
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.12);
      cursor: pointer;
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }
    .jobfill-term:hover { border-color: rgba(99, 102, 241, 0.6); }
    .jobfill-term:has(input:checked) {
      background: rgba(99, 102, 241, 0.22);
      border-color: #6366f1;
    }
    .jobfill-term input { cursor: pointer; margin: 0; }`;

  /**
   * Pregunta qué tecnologías/requisitos que pide la oferta y NO están en el
   * perfil guardado, el usuario realmente domina — ANTES de generar la
   * respuesta, no después. Preguntarlo recién con el texto ya escrito es
   * ilógico: para entonces Claude ya redactó sin saber si esa habilidad es
   * real, y "reescribir" gasta una segunda llamada por algo que se pudo saber
   * de entrada. Lo confirmado aquí se manda como `mustCover` en la ÚNICA
   * llamada de generación.
   *
   * No requiere llamar a Claude: `unbacked` es una comparación local entre la
   * oferta y el perfil (ver `handlePreviewUnbackedTerms` en el service
   * worker), así que este paso es instantáneo y no consume tokens.
   */
  function confirmSkillsBeforeGenerating(unbackedTerms) {
    if (!unbackedTerms || !unbackedTerms.length) return Promise.resolve(null);

    return new Promise(resolve => {
      const host = document.createElement("div");
      host.className = "jobfill-dialog-host";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CONFIRM_DIALOG_STYLES + COVERAGE_DIALOG_STYLES;

      const item = term => `
        <label class="jobfill-term">
          <input type="checkbox" value="${escapeHtml(term)}">
          <span>${escapeHtml(term)}</span>
        </label>`;

      const overlay = document.createElement("div");
      overlay.className = "jobfill-overlay";
      overlay.innerHTML = `
        <div class="jobfill-confirm" role="dialog" aria-modal="true" aria-label="Confirmar habilidades antes de redactar">
          <h3>🎯 Antes de redactar</h3>
          <p>La oferta pide esto y no está en tu perfil guardado. Marca <strong>solo</strong> lo que realmente domines — se incluirá en la respuesta desde el principio.</p>
          <div class="jobfill-group">
            <div class="jobfill-terms">${unbackedTerms.map(item).join("")}</div>
          </div>
          <div class="jobfill-confirm-actions">
            <button class="jobfill-confirm-ok" type="button">✓ Continuar</button>
            <button class="jobfill-confirm-cancel" type="button">Omitir</button>
          </div>
        </div>`;

      shadow.append(style, overlay);
      attachToTopLayerHost(host);

      let settled = false;
      const close = result => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        host.remove();
        resolve(result);
      };

      function onKeydown(e) {
        if (e.key === "Escape") {
          e.stopPropagation();
          close(null);
        }
      }

      shadow.querySelector(".jobfill-confirm-ok").addEventListener("click", () => {
        const checked = [...shadow.querySelectorAll(".jobfill-terms input:checked")].map(c => c.value);
        close(checked);
      });
      shadow.querySelector(".jobfill-confirm-cancel").addEventListener("click", () => close(null));
      overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
      document.addEventListener("keydown", onKeydown, true);
    });
  }

  /**
   * Revisión de cobertura: muestra qué requisitos de la oferta no quedaron en la
   * respuesta y deja que el usuario decida cuáles incluir.
   *
   * Los dos grupos tienen naturaleza distinta y por eso se presentan separados:
   *  - `omitted` viene respaldado por el perfil, así que va premarcado: es una
   *    omisión, no una decisión.
   *  - `unbacked` NO está respaldado por nada, así que va desmarcado y se
   *    pregunta. Aquí el usuario es la única fuente válida: su perfil guardado
   *    está incompleto, pero solo él sabe si domina algo de verdad.
   *
   * Devuelve null si no hay nada que revisar o si se descarta.
   */
  function reviewRequirementCoverage(coverage, jobDescription) {
    const omitted = coverage?.omitted || [];
    const unbacked = coverage?.unbacked || [];
    if (!jobDescription || (!omitted.length && !unbacked.length)) return Promise.resolve(null);

    return new Promise(resolve => {
      const host = document.createElement("div");
      host.className = "jobfill-dialog-host";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CONFIRM_DIALOG_STYLES + COVERAGE_DIALOG_STYLES;

      const item = (term, group, checked) => `
        <label class="jobfill-term">
          <input type="checkbox" value="${escapeHtml(term)}" data-group="${group}" ${checked ? "checked" : ""}>
          <span>${escapeHtml(term)}</span>
        </label>`;

      const overlay = document.createElement("div");
      overlay.className = "jobfill-overlay";
      overlay.innerHTML = `
        <div class="jobfill-confirm" role="dialog" aria-modal="true" aria-label="Revisar cobertura de requisitos">
          <h3>🎯 Cobertura de la oferta</h3>
          <p>Estos requisitos aparecen en la oferta pero no en la respuesta. Marca los que quieras incluir y se reescribirá.</p>

          ${omitted.length ? `
            <div class="jobfill-group">
              <h4>Tu perfil ya lo respalda — se omitió</h4>
              <p class="jobfill-group-hint">Perder el match por no mencionarlo es el error más caro y el más fácil de evitar.</p>
              <div class="jobfill-terms">${omitted.map(t => item(t, "omitted", true)).join("")}</div>
            </div>` : ""}

          ${unbacked.length ? `
            <div class="jobfill-group">
              <h4>La oferta lo pide y no está en tu perfil</h4>
              <p class="jobfill-group-hint">Marca <strong>solo</strong> lo que realmente domines: tu perfil guardado está incompleto, pero en una entrevista te preguntarán por lo que escribas.</p>
              <div class="jobfill-terms">${unbacked.map(t => item(t, "unbacked", false)).join("")}</div>
              <label class="jobfill-confirm-skip">
                <input type="checkbox" class="jobfill-save-profile" checked>
                Guardar lo marcado en mi perfil para las próximas postulaciones
              </label>
            </div>` : ""}

          <div class="jobfill-confirm-actions">
            <button class="jobfill-confirm-ok" type="button">↻ Reescribir incluyéndolos</button>
            <button class="jobfill-confirm-cancel" type="button">Dejar como está</button>
          </div>
        </div>`;

      shadow.append(style, overlay);
      attachToTopLayerHost(host);

      let settled = false;
      const close = result => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        host.remove();
        resolve(result);
      };

      function onKeydown(e) {
        if (e.key === "Escape") {
          e.stopPropagation();
          close(null);
        }
      }

      shadow.querySelector(".jobfill-confirm-ok").addEventListener("click", () => {
        const checked = [...shadow.querySelectorAll(".jobfill-terms input:checked")];
        if (!checked.length) {
          close(null);
          return;
        }
        const saveToProfile = shadow.querySelector(".jobfill-save-profile")?.checked;
        close({
          terms: checked.map(c => c.value),
          // Solo se guardan en el perfil los que el usuario confirmó tener y no
          // estaban registrados; los omitidos ya figuran ahí.
          termsToSaveInProfile: saveToProfile
            ? checked.filter(c => c.dataset.group === "unbacked").map(c => c.value)
            : []
        });
      });
      shadow.querySelector(".jobfill-confirm-cancel").addEventListener("click", () => close(null));
      overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
      document.addEventListener("keydown", onKeydown, true);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function confirmQuestionWithUser(questionText, isAmbiguous = false, jobContext = null) {
    return new Promise(resolve => {
      // Con qué oferta se va a redactar. Solo se muestra cuando viene de la
      // caché: si sale de la página actual es evidente y añadiría ruido.
      let contextLine = "";
      const candidates = jobContext?.candidates || [];
      if (jobContext && jobContext.fromCache && jobContext.title) {
        const describe = ctx => {
          const minutes = Math.round((Date.now() - (ctx.capturedAt || Date.now())) / 60000);
          const when = minutes < 1 ? "recién" : minutes < 60 ? `hace ${minutes} min` : `hace ${Math.round(minutes / 60)} h`;
          return `${ctx.title}${ctx.company ? ` — ${ctx.company}` : ""} (${when})`;
        };

        // Con varias ofertas guardadas se ofrece elegir. Cuando además no hay
        // pruebas de a cuál corresponde este formulario (`uncertain`), la
        // elección deja de ser una comodidad y pasa a ser necesaria: redactar
        // con la oferta equivocada produce una respuesta convincente y errónea.
        const selector = candidates.length > 1
          ? `<select class="jobfill-context-select">
               ${candidates.map((c, i) => `<option value="${i}"${c.title === jobContext.title && c.capturedAt === jobContext.capturedAt ? " selected" : ""}>${escapeHtml(describe(c))}</option>`).join("")}
             </select>`
          : "";

        contextLine = `
          <div class="jobfill-context${jobContext.uncertain ? " jobfill-context-uncertain" : ""}">
            <span>${jobContext.uncertain ? "❓" : "📄"}</span>
            <div>
              <div>${jobContext.uncertain
                ? "Esta página no incluye la oferta y no se pudo determinar a cuál corresponde. <strong>Confirma el puesto</strong> antes de redactar:"
                : `Se redactará para <strong>${escapeHtml(jobContext.title)}</strong>${jobContext.company ? ` en ${escapeHtml(jobContext.company)}` : ""}, según la oferta que viste. Esta página no la incluye.`}</div>
              ${selector}
            </div>
          </div>`;
      }
      const host = document.createElement("div");
      host.className = "jobfill-dialog-host";
      // Shadow DOM: los formularios de postulación traen CSS agresivo (resets
      // globales, !important sobre button/textarea) que deformaría el diálogo.
      const shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = CONFIRM_DIALOG_STYLES;

      const overlay = document.createElement("div");
      overlay.className = "jobfill-overlay";
      overlay.innerHTML = `
        <div class="jobfill-confirm" role="dialog" aria-modal="true" aria-label="Confirmar pregunta">
          <h3>${isAmbiguous ? "⚠️ Revisa esta pregunta" : "¿Es esta la pregunta?"}</h3>
          <p>${isAmbiguous
            ? "Este formulario no identifica sus campos con claridad y varios comparten el mismo texto, así que el enunciado leído probablemente <strong>no</strong> corresponde a este campo. Cópialo del formulario y pégalo aquí para obtener una respuesta correcta."
            : "JobFill AI leyó este enunciado del formulario. Si no coincide con lo que ves en pantalla, corrígelo aquí antes de redactar."}</p>
          <textarea class="jobfill-confirm-input" spellcheck="false"></textarea>
          ${contextLine}
          <div class="jobfill-confirm-actions">
            <button class="jobfill-confirm-ok" type="button">✨ Redactar respuesta</button>
            <button class="jobfill-confirm-cancel" type="button">Cancelar</button>
          </div>
          ${isAmbiguous || jobContext?.uncertain ? "" : `<label class="jobfill-confirm-skip">
            <input type="checkbox" class="jobfill-confirm-skip-input">
            No volver a preguntar (se puede reactivar en opciones)
          </label>`}
        </div>`;

      shadow.append(style, overlay);
      attachToTopLayerHost(host);

      const input = shadow.querySelector(".jobfill-confirm-input");
      const skipBox = shadow.querySelector(".jobfill-confirm-skip-input");
      input.value = questionText;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);

      let settled = false;
      const close = result => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        host.remove();
        resolve(result);
      };

      function onKeydown(e) {
        if (e.key === "Escape") {
          e.stopPropagation();
          close(null);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.stopPropagation();
          accept();
        }
      }

      function accept() {
        const edited = input.value.trim();
        if (!edited) {
          input.focus();
          return;
        }
        // skipBox no existe en el caso ambiguo (ahí siempre se pregunta).
        if (skipBox && skipBox.checked) {
          // Persistir la preferencia; si el guardado falla, la confirmación
          // simplemente seguirá apareciendo — nunca se pierde la respuesta.
          try {
            chrome.storage.local.set({ confirmQuestionBeforeAi: false });
          } catch (e) {
            console.warn("[JobFill AI] No se pudo guardar la preferencia:", e);
          }
        }
        // La oferta elegida se devuelve junto con la pregunta: el usuario puede
        // haber corregido cuál es el puesto en el mismo diálogo.
        const select = shadow.querySelector(".jobfill-context-select");
        const chosen = select ? candidates[parseInt(select.value, 10)] : null;
        close({ question: edited, chosenContext: chosen || null });
      }

      shadow.querySelector(".jobfill-confirm-ok").addEventListener("click", accept);
      shadow.querySelector(".jobfill-confirm-cancel").addEventListener("click", () => close(null));
      // Clic fuera del cuadro = cancelar, como en cualquier modal.
      overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
      document.addEventListener("keydown", onKeydown, true);
    });
  }

  /**
   * Detecta todas las preguntas abiertas visibles en la página, con la misma
   * heurística que ya decide cuándo mostrar el botón ✨ individual (ver el
   * listener de `focusin`). Dos campos que resuelven al MISMO enunciado se
   * excluyen ambos del lote — mismo criterio de "ambiguo" que en el flujo de
   * una sola pregunta: adivinar a cuál pertenece produciría una respuesta
   * convincente sobre el campo equivocado.
   */
  function detectAnswerableQuestions() {
    const candidates = Array.from(
      document.querySelectorAll("textarea, [contenteditable='true'], input[type='text'], input:not([type])")
    ).filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (el.tagName === "INPUT") {
        const ctx = getFieldContext(el);
        return ctx.length > 25 && /(describa|por qu[eé]|cu[aá]l|cu[aá]ntos|why|how|explain|tell|resume|cu[eé]ntanos)/i.test(ctx);
      }
      return true;
    });

    const byQuestion = new Map();
    for (const el of candidates) {
      const question = extractHumanQuestion(el);
      if (!question || question.length < 3) continue;
      byQuestion.set(question, byQuestion.has(question) ? "ambiguous" : el);
    }

    const items = [];
    for (const [question, elOrFlag] of byQuestion) {
      if (elOrFlag === "ambiguous") continue;
      items.push({ el: elOrFlag, question });
    }
    return items;
  }

  /**
   * Recuadro de revisión del lote: lista TODAS las preguntas detectadas para
   * que el usuario confirme que coinciden con el formulario real antes de
   * gastar la única llamada agrupada — mismo espíritu que el diálogo de "¿es
   * esta la pregunta?" de una sola pregunta, pero para el lote completo.
   */
  function confirmBatchQuestions(items) {
    return new Promise(resolve => {
      const host = document.createElement("div");
      host.className = "jobfill-dialog-host";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CONFIRM_DIALOG_STYLES + COVERAGE_DIALOG_STYLES;

      const row = (item, idx) => `
        <label class="jobfill-term" style="align-items: flex-start;">
          <input type="checkbox" data-idx="${idx}" checked>
          <textarea class="jobfill-confirm-input jobfill-batch-row" data-idx="${idx}" spellcheck="false" rows="2">${escapeHtml(item.question)}</textarea>
        </label>`;

      const overlay = document.createElement("div");
      overlay.className = "jobfill-overlay";
      overlay.innerHTML = `
        <div class="jobfill-confirm" role="dialog" aria-modal="true" aria-label="Confirmar preguntas a responder">
          <h3>¿Son estas las preguntas a responder?</h3>
          <p>Se detectaron ${items.length} pregunta${items.length > 1 ? "s" : ""} abierta${items.length > 1 ? "s" : ""} en este formulario. Desmarca las que no correspondan y corrige el texto si hace falta — se responden todas con una sola llamada.</p>
          <div class="jobfill-group"><div class="jobfill-terms">${items.map(row).join("")}</div></div>
          <div class="jobfill-confirm-actions">
            <button class="jobfill-confirm-ok" type="button">✨ Responder todas</button>
            <button class="jobfill-confirm-cancel" type="button">Cancelar</button>
          </div>
        </div>`;

      shadow.append(style, overlay);
      attachToTopLayerHost(host);

      let settled = false;
      const close = result => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        host.remove();
        resolve(result);
      };
      function onKeydown(e) { if (e.key === "Escape") { e.stopPropagation(); close(null); } }

      shadow.querySelector(".jobfill-confirm-ok").addEventListener("click", () => {
        const rows = [...shadow.querySelectorAll(".jobfill-term")];
        const picked = [];
        rows.forEach((rowEl, idx) => {
          const checked = rowEl.querySelector("input[type='checkbox']").checked;
          if (!checked) return;
          const editedText = rowEl.querySelector("textarea").value.trim();
          if (editedText.length < 3) return;
          picked.push({ el: items[idx].el, question: editedText });
        });
        close(picked.length ? picked : null);
      });
      shadow.querySelector(".jobfill-confirm-cancel").addEventListener("click", () => close(null));
      overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
      document.addEventListener("keydown", onKeydown, true);
    });
  }

  /**
   * Punto de entrada del botón "Responder todas": detecta, confirma, pregunta
   * habilidades no respaldadas UNA vez por formulario y manda un único
   * ASK_CLAUDE_AI_BATCH — la alternativa a llamar a la API una vez por campo.
   */
  async function handleAnswerAllQuestions(btn) {
    const allDetected = detectAnswerableQuestions();
    if (!allDetected.length) {
      showToast("No se detectaron preguntas abiertas en este formulario.", "info");
      return;
    }

    // Tope de seguridad de coste: una página con muchos textareas (un foro
    // embebido, un editor de perfil completo) haría un prompt enorme en una
    // sola llamada, que es justo lo que este modo existe para evitar. Se
    // avisa en vez de recortar en silencio: el usuario decide si responde el
    // resto en una segunda tanda.
    const MAX_BATCH_QUESTIONS = 12;
    const detected = allDetected.slice(0, MAX_BATCH_QUESTIONS);
    if (allDetected.length > detected.length) {
      showToast(`Se detectaron ${allDetected.length} preguntas; se responderán las primeras ${detected.length} para no disparar el coste.`, "info");
    }

    const picked = await confirmBatchQuestions(detected);
    if (!picked) {
      showToast("Redacción por lote cancelada.", "info");
      return;
    }

    const jobContext = await resolveJobContext();

    let confirmedSkills = [];
    try {
      const unbackedPreview = await previewUnbackedTerms(jobContext);
      if (unbackedPreview.length) {
        const skillPick = await confirmSkillsBeforeGenerating(unbackedPreview);
        if (skillPick && skillPick.length) {
          confirmedSkills = skillPick;
          await addSkillsToProfile(confirmedSkills);
        }
      }
    } catch (e) {
      console.warn("[JobFill AI] No se pudo previsualizar habilidades para el lote:", e);
    }

    const items = picked.map((item, idx) => ({
      id: `q${idx}`,
      question: item.question,
      maxCharacters: detectFieldCharacterLimit(item.el),
      minCharacters: detectFieldMinimumLength(item.el)
    }));

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = `Redactando ${items.length} respuestas...`;

    try {
      const response = await new Promise((resolve, reject) => {
        let settled = false;
        const safetyTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Tiempo de espera agotado esperando el lote de respuestas."));
        }, 90000);
        try {
          chrome.runtime.sendMessage({
            type: "ASK_CLAUDE_AI_BATCH",
            payload: {
              items,
              jobTitle: jobContext.title,
              companyName: jobContext.company,
              jobDescription: jobContext.description,
              mustCover: confirmedSkills
            }
          }, res => {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || "Error al comunicar con la extensión."));
            } else {
              resolve(res);
            }
          });
        } catch (e) {
          if (!settled) { settled = true; clearTimeout(safetyTimer); reject(e); }
        }
      });

      if (!response || !response.success) {
        throw new Error(response?.error || "El service worker no pudo responder el lote.");
      }

      const resultsById = new Map(response.results.map(r => [r.id, r.answer]));
      let filledCount = 0;
      picked.forEach((item, idx) => {
        const answer = resultsById.get(`q${idx}`);
        if (!answer) return;
        const maxCharacters = items[idx].maxCharacters;
        const finalAnswer = maxCharacters ? enforceSafeCharacterLimit(answer, maxCharacters) : answer;
        setElementValue(item.el, finalAnswer);
        rememberGeneratedAnswer(item.el, finalAnswer);
        item.el.classList.add("jobfill-highlight-ai");
        setTimeout(() => item.el.classList.remove("jobfill-highlight-ai"), 2500);
        filledCount++;
      });

      const missing = response.missingIds?.length || 0;
      showToast(
        `✨ ${filledCount} respuesta${filledCount === 1 ? "" : "s"} redactada${filledCount === 1 ? "" : "s"} con una sola llamada.` +
          (missing ? ` (${missing} sin respuesta, revísalas manualmente)` : "") +
          providerNote(response),
        filledCount ? "success" : "error"
      );

      // No se ofrece "reescribir incluyéndolos" aquí: eso significaría una
      // segunda llamada a la API, justo lo que este modo agrupado evita. Se
      // avisa igual de qué quedó fuera, para que el usuario lo agregue a mano.
      const omitted = response.coverage?.omitted || [];
      if (omitted.length) {
        showToast(`💡 Tu perfil respalda esto y ninguna respuesta lo mencionó: ${omitted.join(", ")}.`, "info");
      }
    } catch (err) {
      console.error("[JobFill AI] Error en el lote de respuestas:", err);
      showToast(err?.message || "Error al invocar Claude IA en modo lote.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function handleGenerateAiAnswer(textarea, btn) {
    const extractedQuestion = extractHumanQuestion(textarea);
    if (!extractedQuestion || extractedQuestion.length < 3) {
      showToast("No se pudo identificar la pregunta asociada a este campo.", "error");
      return;
    }

    // Salvavidas genérico (no atado a ningún sitio): si otro campo visible de la
    // página resuelve exactamente a la misma pregunta, la extracción está
    // devolviendo un texto compartido en vez del enunciado propio de este campo.
    // Es la firma exacta del fallo de HiringRoom — donde los 4 campos caían al
    // placeholder "Ingresa tu respuesta..." — y ocurriría igual en cualquier otro
    // formulario sin marcado semántico. Generar igualmente produce una respuesta
    // impecable que contesta otra cosa: un fallo silencioso que el usuario solo
    // detecta releyendo.
    const isAmbiguous = Array.from(
      document.querySelectorAll("textarea, [contenteditable='true']")
    ).some(other => {
      if (other === textarea) return false;
      const rect = other.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return extractHumanQuestion(other) === extractedQuestion;
    });

    if (isAmbiguous) {
      console.warn("[JobFill AI] Pregunta ambigua: varios campos resuelven a", JSON.stringify(extractedQuestion));
    }
    console.log("[JobFill AI] Campo:", textarea.name || textarea.id || "(sin nombre)", "| Pregunta interpretada:", JSON.stringify(extractedQuestion));

    // Confirmación previa (activada por defecto): el usuario ve el enunciado que
    // se interpretó y lo acepta o lo corrige. Es lo que convierte un fallo de
    // extracción en algo visible y reparable en el momento, en vez de una
    // respuesta impecable que contesta otra pregunta.
    let askBeforeGenerating = true;
    try {
      const prefs = await chrome.storage.local.get("confirmQuestionBeforeAi");
      askBeforeGenerating = prefs.confirmQuestionBeforeAi !== false;
    } catch (e) {
      // Si el storage falla, se pregunta: ante la duda, que decida el usuario.
      console.warn("[JobFill AI] No se pudo leer la preferencia de confirmación:", e);
    }

    // Se resuelve ANTES del diálogo para poder mostrar con qué oferta se va a
    // redactar: si el contexto viene de la caché y es de otro puesto, el usuario
    // lo ve aquí. Sin mostrarlo, una oferta cacheada equivocada produce una
    // respuesta convincente sobre el puesto que no es — el mismo fallo silencioso
    // que la pregunta mal extraída.
    let jobContext = await resolveJobContext();
    if (jobContext.fromCache) {
      console.log("[JobFill AI] Usando contexto de oferta cacheado:", jobContext.title);
    }

    let questionText = extractedQuestion;
    // Se pregunta también cuando no se pudo determinar a qué oferta pertenece
    // este formulario: elegir por nuestra cuenta entre varias sería adivinar, y
    // el error resultante es invisible (una respuesta impecable sobre otro puesto).
    if (askBeforeGenerating || isAmbiguous || jobContext.uncertain) {
      // El caso ambiguo SIEMPRE pregunta, aunque la confirmación esté desactivada:
      // ahí se sabe que la extracción es poco fiable, y el diálogo es la vía de
      // reparación. Desactivar la confirmación silencia el caso normal, no este.
      const confirmed = await confirmQuestionWithUser(extractedQuestion, isAmbiguous, jobContext);
      if (!confirmed) {
        showToast("Redacción cancelada.", "info");
        return;
      }
      questionText = confirmed.question;
      if (confirmed.chosenContext) {
        jobContext = {
          ...jobContext,
          title: confirmed.chosenContext.title,
          company: confirmed.chosenContext.company,
          description: confirmed.chosenContext.description,
          capturedAt: confirmed.chosenContext.capturedAt
        };
      }
    }

    // Se pregunta ANTES de generar qué pide la oferta que el perfil no
    // respalda — no después, con el texto ya escrito sobre una habilidad sin
    // confirmar (ver confirmSkillsBeforeGenerating). Comprobación local, sin
    // llamar a Claude: no cuesta tokens ni tiempo de red.
    let confirmedSkills = [];
    let askedSkillTerms = [];
    try {
      const unbackedPreview = await previewUnbackedTerms(jobContext);
      if (unbackedPreview.length) {
        askedSkillTerms = unbackedPreview;
        const picked = await confirmSkillsBeforeGenerating(unbackedPreview);
        if (picked && picked.length) {
          confirmedSkills = picked;
          await addSkillsToProfile(confirmedSkills);
        }
      }
    } catch (e) {
      console.warn("[JobFill AI] No se pudo previsualizar habilidades no respaldadas:", e);
    }

    const maxCharacters = detectFieldCharacterLimit(textarea);
    const minCharacters = detectFieldMinimumLength(textarea);

    btn.classList.add("jobfill-loading");
    btn.title = `Generando respuesta a: "${questionText.slice(0, 120)}"${maxCharacters ? ` (máx ${maxCharacters} car.)` : ""}`;

    const basePayload = {
      question: questionText,
      fieldType: "textarea",
      jobTitle: jobContext.title,
      companyName: jobContext.company,
      jobDescription: jobContext.description,
      maxCharacters,
      minCharacters,
      previousAnswers: getPreviousAnswers(textarea),
      mustCover: confirmedSkills
    };

    const applyAnswer = (answer, result = null) => {
      const finalAnswer = maxCharacters ? enforceSafeCharacterLimit(answer, maxCharacters) : answer;
      setElementValue(textarea, finalAnswer);
      rememberGeneratedAnswer(textarea, finalAnswer);
      textarea.classList.add("jobfill-highlight-ai");
      setTimeout(() => textarea.classList.remove("jobfill-highlight-ai"), 2500);
      const vetoed = result?.vetoedInAnswer || [];
      showToast(
        vetoed.length
          ? `⚠️ La respuesta menciona ${vetoed.join(", ")}, que tus reglas vetan. Revísala antes de enviar.${providerNote(result)}`
          : `✨ Respuesta redactada (${finalAnswer.length}${maxCharacters ? `/${maxCharacters}` : ""} caracteres).${providerNote(result)}`,
        vetoed.length ? "error" : "success"
      );
      return finalAnswer;
    };

    try {
      const result = await requestClaudeAnswer(basePayload);
      applyAnswer(result.answer, result);

      // Verificación de cobertura: qué requisitos de la oferta quedaron fuera de
      // la respuesta. Se hace DESPUÉS de rellenar para que el usuario ya tenga
      // algo utilizable aunque descarte la revisión. Solo mira `omitted` (lo
      // que el perfil respalda pero el texto no mencionó): "unbacked" ya se
      // preguntó ANTES de generar, así que se descarta aquí para no repetir
      // la misma pregunta sobre lo que el usuario ya contestó (sí o no).
      const postGenCoverage = {
        omitted: result.coverage?.omitted || [],
        unbacked: (result.coverage?.unbacked || []).filter(
          t => !askedSkillTerms.some(a => a.toLowerCase() === t.toLowerCase())
        )
      };
      const decision = await reviewRequirementCoverage(postGenCoverage, jobContext.description);

      if (decision && decision.terms.length) {
        btn.classList.add("jobfill-loading");
        const improved = await requestClaudeAnswer({ ...basePayload, mustCover: decision.terms });
        applyAnswer(improved.answer, improved);

        if (decision.termsToSaveInProfile.length) {
          await addSkillsToProfile(decision.termsToSaveInProfile);
        }
      }

      removeAiButton();
    } catch (err) {
      console.error("[JobFill AI] Error al generar la respuesta:", err);
      showToast(err?.message || "Error al invocar Claude IA.", "error");
    } finally {
      btn.classList.remove("jobfill-loading");
      btn.innerHTML = `<span>✨</span>`;
      btn.title = "Redactar con Claude IA";
    }
  }

  /**
   * Envuelve la llamada al service worker en una promesa, con su watchdog.
   *
   * Se necesita encadenar llamadas (generar → revisar cobertura → regenerar
   * incluyendo lo confirmado), y con callbacks anidados ese flujo se vuelve
   * ilegible y duplica el manejo de errores en cada nivel.
   */
  function requestClaudeAnswer(payload) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const safetyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Tiempo de espera agotado (65s) esperando a Claude. Revisa tu conexión a internet."));
      }, 65000);

      const finish = fn => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        fn();
      };

      try {
        chrome.runtime.sendMessage({ type: "ASK_CLAUDE_AI", payload }, response => {
          finish(() => {
            if (chrome.runtime.lastError) {
              const msg = chrome.runtime.lastError.message || "";
              console.error("[JobFill AI] chrome.runtime.lastError:", msg);
              const orphaned = /context invalidated|extension context|receiving end does not exist|message port closed/i.test(msg);
              reject(new Error(orphaned
                ? "Esta pestaña perdió la conexión con la extensión. Recarga la página (F5) y vuelve a intentarlo."
                : (msg || "Error al comunicar con la extensión. Recarga la pestaña.")));
              return;
            }

            if (response && response.success && response.answer) {
              resolve({ answer: response.answer, coverage: response.coverage, provider: response.provider, fallbackReason: response.fallbackReason, vetoedInAnswer: response.vetoedInAnswer || [] });
            } else {
              reject(new Error(response?.error || "El service worker se cerró antes de responder. Recarga la extensión en chrome://extensions e inténtalo de nuevo."));
            }
          });
        });
      } catch (err) {
        // sendMessage lanza de forma síncrona cuando este content script quedó
        // huérfano: pasa siempre que se recarga la extensión con la pestaña abierta.
        finish(() => {
          const orphaned = /context invalidated|extension context|receiving end does not exist/i.test(err?.message || "");
          reject(new Error(orphaned
            ? "La extensión se recargó y esta pestaña quedó desconectada. Recarga la página (F5) y vuelve a intentarlo."
            : `Error al invocar Claude IA: ${err?.message || err}`));
        });
      }
    });
  }

  /**
   * Computación local en el service worker (sin llamar a Claude): qué pide la
   * oferta que el perfil no respalda. Se usa para preguntar ANTES de generar.
   * Watchdog corto porque no hay red de por medio, solo comparación de texto.
   */
  function previewUnbackedTerms(jobContext) {
    return new Promise(resolve => {
      let settled = false;
      const safetyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve([]);
      }, 5000);

      try {
        chrome.runtime.sendMessage({
          type: "PREVIEW_UNBACKED_TERMS",
          payload: { jobTitle: jobContext.title, jobDescription: jobContext.description }
        }, response => {
          if (settled) return;
          settled = true;
          clearTimeout(safetyTimer);
          // Sin bloquear el flujo de redacción por esto: si falla, simplemente
          // no se pregunta nada por adelantado (mismo resultado que antes de
          // que existiera este paso).
          resolve(response?.success ? (response.unbacked || []) : []);
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(safetyTimer);
          resolve([]);
        }
      }
    });
  }

  /**
   * Añade al perfil las capacidades que el usuario confirmó tener y que no
   * estaban registradas. Ataca la causa de fondo: el perfil guardado va por
   * detrás de la experiencia real, así que cada confirmación lo pone al día y
   * la próxima postulación ya parte con ese dato.
   */
  async function addSkillsToProfile(terms) {
    try {
      // `candidateBase.skills` es único (ya no hay un `profiles[]` duplicado
      // que mantener sincronizado) — el rediseño de datos simplificó esto de
      // "escribir en dos sitios a la vez" a un solo guardado.
      const stored = await chrome.storage.local.get("candidateBase");
      const candidateBase = stored.candidateBase || {};
      const current = (candidateBase.skills || "").trim();
      const existing = current.split(/[,;\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      const additions = terms.filter(t => !existing.includes(t.toLowerCase()));
      if (!additions.length) return;

      const merged = current ? `${current}, ${additions.join(", ")}` : additions.join(", ");
      await chrome.storage.local.set({ candidateBase: { ...candidateBase, skills: merged } });
      showToast(`Añadido a tu perfil: ${additions.join(", ")}.`, "info");
    } catch (e) {
      // No es crítico: la respuesta ya se generó con esos términos.
      console.warn("[JobFill AI] No se pudo actualizar el perfil:", e);
    }
  }

  /**
   * Captura manual del cargo: dispara con el botón del widget, el atajo de
   * teclado, o el botón configurable del mouse remapeado a ese atajo.
   *
   * Reemplaza la captura automática (MutationObserver + debounce) que existía
   * antes: en páginas con DOM muy dinámico esa captura periódica competía con
   * el botón ✨ por los mismos ciclos de re-adjuntado y era la raíz del bug de
   * "el botón no hace nada" que se depuró en Laborum. Al ser manual, la
   * captura solo ocurre en el instante exacto que el usuario decide, y el
   * resultado se le muestra ANTES de guardarse — nunca queda la duda de si de
   * verdad extrajo el cargo correcto.
   *
   * DOM primero (gratis, exacto); la visión de Claude sobre un recorte de
   * pantalla alrededor del cursor es el respaldo, solo cuando el DOM no dio
   * ningún título.
   */
  async function manualCaptureJobContext(btn) {
    if (btn) {
      btn.disabled = true;
      btn.dataset.originalText = btn.textContent;
      btn.textContent = "Leyendo página...";
    }

    try {
      const { text: description, reliable } = extractJobDescriptionWithSource();
      const domTitle = extractJobTitle();

      if (domTitle) {
        openJobContextPanel({
          title: domTitle,
          company: extractCompanyName(),
          description: reliable ? description : "",
          source: "dom"
        });
        return;
      }

      // Respaldo: el DOM no dio ningún título. Se recorta la captura de
      // pantalla alrededor del cursor — se asume que el usuario pulsó el
      // botón/atajo estando cerca del título del puesto en pantalla, que es la
      // instrucción que el propio flujo debería darle si esto falla seguido.
      if (btn) btn.textContent = "Leyendo pantalla...";
      const visionResult = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({
            type: "CAPTURE_JOB_TITLE_NEAR_MOUSE",
            payload: { x: lastMouseX, y: lastMouseY, dpr: window.devicePixelRatio || 1 }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || "Error al comunicar con la extensión."));
            } else {
              resolve(response);
            }
          });
        } catch (e) {
          reject(e);
        }
      });

      if (!visionResult?.success) {
        showToast(visionResult?.error || "No se pudo identificar el cargo en esta página. Acércate al título con el mouse antes de pulsar el botón.", "error");
        return;
      }

      openJobContextPanel({
        title: visionResult.title,
        company: "",
        description: "",
        source: "vision"
      });
    } catch (e) {
      console.error("[JobFill AI] Error en la captura manual del cargo:", e);
      showToast(`Error al capturar el cargo: ${e?.message || e}`, "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || "📄 Guardar cargo";
      }
    }
  }

  /**
   * Panel de revisión/edición del cargo capturado. Nunca se guarda a ciegas:
   * el usuario ve exactamente lo que se extrajo (por DOM o por visión) y puede
   * corregirlo antes de confirmar — es la garantía de que "el cargo en caché"
   * es realmente el cargo, no una suposición del extractor.
   */
  function openJobContextPanel(initial) {
    const host = document.createElement("div");
    host.className = "jobfill-dialog-host";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CONFIRM_DIALOG_STYLES;

    const sourceLabel = initial.source === "vision"
      ? "🖼️ Leído de la captura de pantalla cerca del cursor — revisa que sea correcto."
      : initial.source === "cache"
        ? "📄 Cargo guardado actualmente."
        : "📄 Leído del DOM de esta página.";

    const overlay = document.createElement("div");
    overlay.className = "jobfill-overlay";
    overlay.innerHTML = `
      <div class="jobfill-confirm" role="dialog" aria-modal="true" aria-label="Revisar cargo capturado">
        <h3>📄 Cargo capturado</h3>
        <p class="jobfill-panel-source">${escapeHtml(sourceLabel)}</p>

        <div class="jobfill-field">
          <label for="jf-panel-title">Cargo</label>
          <input type="text" id="jf-panel-title" spellcheck="false">
        </div>
        <div class="jobfill-field">
          <label for="jf-panel-company">Empresa</label>
          <input type="text" id="jf-panel-company" spellcheck="false">
        </div>
        <div class="jobfill-field">
          <label for="jf-panel-desc">Descripción de la oferta (opcional, mejora las respuestas)</label>
          <textarea id="jf-panel-desc" spellcheck="false"></textarea>
        </div>

        <div class="jobfill-confirm-actions">
          <button class="jobfill-confirm-ok" type="button">✓ Guardar cargo</button>
          <button class="jobfill-confirm-cancel" type="button">Cancelar</button>
          ${initial.source === "cache" ? `<button class="jobfill-confirm-danger" type="button">Descartar</button>` : ""}
        </div>
      </div>`;

    shadow.append(style, overlay);
    attachToTopLayerHost(host);

    const titleInput = shadow.querySelector("#jf-panel-title");
    const companyInput = shadow.querySelector("#jf-panel-company");
    const descInput = shadow.querySelector("#jf-panel-desc");
    titleInput.value = initial.title || "";
    companyInput.value = initial.company || "";
    descInput.value = initial.description || "";
    titleInput.focus();

    const close = () => host.remove();

    shadow.querySelector(".jobfill-confirm-cancel").addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function onKeydown(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKeydown); close(); }
    });

    const dangerBtn = shadow.querySelector(".jobfill-confirm-danger");
    if (dangerBtn) {
      dangerBtn.addEventListener("click", async () => {
        try {
          const contexts = await loadJobContexts();
          await saveJobContexts(contexts.filter(c => c.url !== initial.url));
          await refreshCacheChip();
          showToast("Cargo descartado.", "info");
        } catch (e) {
          console.warn("[JobFill AI] No se pudo descartar el cargo:", e);
        }
        close();
      });
    }

    shadow.querySelector(".jobfill-confirm-ok").addEventListener("click", async () => {
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        return;
      }

      const entry = {
        title,
        company: companyInput.value.trim(),
        description: descInput.value.trim(),
        url: initial.url || location.href,
        host: location.hostname,
        capturedAt: Date.now()
      };

      try {
        const contexts = await loadJobContexts();
        const deduped = contexts.filter(c => c.url !== entry.url && !(c.title === entry.title && c.host === entry.host));
        const saved = await saveJobContexts([entry, ...deduped]);
        await refreshCacheChip();
        if (!saved) {
          // A propósito NO se cierra el panel: guarda lo que el usuario ya
          // escribió (título corregido, descripción) para que pueda
          // reintentar sin volver a teclearlo todo.
          showToast("No se pudo guardar el cargo (almacenamiento lleno o pestaña desconectada). Recarga la página e inténtalo de nuevo.", "error");
          return;
        }
        showToast(`✓ Cargo guardado: "${entry.title}"${entry.company ? ` en ${entry.company}` : ""}.`, "success");
      } catch (e) {
        console.error("[JobFill AI] No se pudo guardar el cargo:", e);
        showToast("No se pudo guardar el cargo.", "error");
      }
      close();
    });
  }

  /**
   * Actualiza el chip "Cargo en caché" del widget flotante con la oferta más
   * reciente guardada. Se llama tras guardar/descartar y al iniciar el widget,
   * para que el chip nunca muestre un cargo que ya no está vigente.
   */
  async function refreshCacheChip() {
    const chip = widgetRefs?.chip;
    if (!chip) return;

    const contexts = await loadJobContexts();
    const latest = contexts[0]; // loadJobContexts ya ordena por más reciente

    if (!latest) {
      chip.hidden = true;
      return;
    }

    chip.hidden = false;
    widgetRefs.chipText.textContent = `${latest.title}${latest.company ? ` — ${latest.company}` : ""}`;
    chip.title = `Cargo guardado: ${widgetRefs.chipText.textContent}. Clic para ver o editar.`;
    chip.dataset.contextUrl = latest.url;
  }

  /**
   * Nota para el toast de éxito cuando no respondió Claude: el usuario debe
   * saber que el texto lo escribió otro modelo (y por qué), sobre todo si fue
   * un respaldo automático por falta de saldo.
   */
  function providerNote(result) {
    if (result?.provider !== "gemini") return "";
    return result.fallbackReason
      ? " Redactó Gemini: Claude se quedó sin saldo."
      : " Redactó Gemini.";
  }

  function showToast(message, type = "info") {
    const existing = document.querySelector(".jobfill-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `jobfill-toast jobfill-toast-${type}`;
    
    let icon = "ℹ️";
    if (type === "success") icon = "✅";
    if (type === "error") icon = "⚠️";

    // textContent, nunca innerHTML: `message` arrastra texto de la página
    // (título del cargo, empresa, mensajes de error) y el toast vive en el DOM
    // del portal. Con innerHTML, un título de oferta como `<img onerror=…>`
    // se ejecutaba en el origen del portal (p. ej. linkedin.com).
    const iconSpan = document.createElement("span");
    iconSpan.textContent = icon;
    const messageSpan = document.createElement("span");
    messageSpan.textContent = String(message);
    toast.append(iconSpan, messageSpan);
    attachToTopLayerHost(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-8px)";
      setTimeout(() => toast.remove(), 350);
    }, 3800);
  }

  /**
   * Estilos del widget flotante. Viven dentro de su Shadow DOM: antes eran
   * clases globales en autofill.css y cualquier regla del portal sobre
   * `button` o `div` (tamaños, fuentes, `all: unset`…) deformaba el widget.
   */
  const WIDGET_STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .dock {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483640;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
      user-select: none;
      animation: jf-rise 0.28s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .panel {
      width: 276px;
      padding: 10px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      border: 1px solid rgba(148, 163, 184, 0.18);
      box-shadow: 0 18px 40px -12px rgba(2, 6, 23, 0.55), 0 2px 6px rgba(2, 6, 23, 0.25);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 2px 2px 4px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: #f8fafc;
    }
    .logo {
      display: inline-grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 7px;
      font-size: 12px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.45);
    }
    .hdr-actions { display: inline-flex; gap: 2px; }
    .icon {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: #94a3b8;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .icon:hover { background: rgba(148, 163, 184, 0.14); color: #f8fafc; }
    .icon.power:hover { background: rgba(248, 113, 113, 0.14); color: #fca5a5; }

    .job {
      display: flex;
      flex-direction: column;
      gap: 1px;
      width: 100%;
      padding: 7px 10px;
      border: 1px solid rgba(99, 102, 241, 0.32);
      border-radius: 10px;
      background: rgba(99, 102, 241, 0.1);
      text-align: left;
      font: inherit;
      color: inherit;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .job:hover { border-color: rgba(129, 140, 248, 0.7); background: rgba(99, 102, 241, 0.16); }
    .job-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #a5b4fc;
    }
    .job-text {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 12px;
      font-weight: 600;
      color: #e0e7ff;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 34px;
      padding: 8px 12px;
      border-radius: 10px;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
      transition: transform 0.15s ease, filter 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }
    .btn:disabled { opacity: 0.6; cursor: progress; transform: none !important; }
    .btn.primary {
      width: 100%;
      border: 0;
      color: #fff;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      box-shadow: 0 6px 16px -6px rgba(99, 102, 241, 0.7);
    }
    .btn.primary:hover { filter: brightness(1.08); transform: translateY(-1px); }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .btn.secondary {
      padding: 8px 6px;
      white-space: nowrap;
      font-size: 11.5px;
      color: #e2e8f0;
      background: rgba(30, 41, 59, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.2);
    }
    .btn.secondary:hover { border-color: rgba(129, 140, 248, 0.6); background: #1e293b; }
    .btn.wide { width: 100%; }
    .btn.secondary.accent { border-color: rgba(129, 140, 248, 0.55); color: #e0e7ff; background: rgba(99, 102, 241, 0.18); }

    .launcher {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 50%;
      font-size: 18px;
      color: #fff;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      box-shadow: 0 10px 24px -8px rgba(99, 102, 241, 0.75), 0 2px 6px rgba(2, 6, 23, 0.3);
      cursor: pointer;
      transition: transform 0.18s ease, filter 0.18s ease;
    }
    .launcher:hover { transform: translateY(-2px) scale(1.04); filter: brightness(1.08); }

    .dock[data-collapsed="true"] .panel { display: none; }
    .dock[data-collapsed="false"] .launcher { display: none; }

    button:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }

    @keyframes jf-rise {
      from { opacity: 0; transform: translateY(10px) scale(0.98); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dock { animation: none; }
      .btn, .launcher, .icon, .job { transition: none; }
    }`;

  function initFloatingWidget() {
    if (!extensionEnabled || widgetDismissed) return;

    // El observer que dispara esto corre en CADA mutación del documento —
    // salir aquí si el widget ya existe evita repetir, en páginas ajenas muy
    // activas, el trabajo más caro de abajo (extractJobTitle recorre ~20
    // selectores) en cada tick.
    if (document.querySelector(".jobfill-floating-container")) return;

    // "Guardar cargo" existe justamente para usarse ANTES de que exista el
    // formulario: en portales como Workday, la página de la oferta y la del
    // formulario de postulación son rutas distintas, así que exigir un
    // formulario aquí escondía la herramienta en la única página donde tiene
    // sentido capturar el cargo. Se muestra si hay campos de formulario O si
    // la página resuelve a un título de oferta reconocible (misma detección
    // que ya usa la captura manual, verificada contra el DOM real).
    const hasForms = document.querySelector("input, textarea, select, form");
    if (!hasForms && !extractJobTitle()) return;

    // El host conserva la clase `jobfill-floating-container`: el vigía del
    // top layer y la guarda de arriba lo buscan por ella.
    const host = document.createElement("div");
    host.className = "jobfill-floating-container";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = WIDGET_STYLES;

    const dock = document.createElement("div");
    dock.className = "dock";
    dock.dataset.collapsed = String(widgetCollapsed);
    // Todo el texto es fijo (sin datos de la página): el título del cargo se
    // escribe después con textContent en refreshCacheChip.
    dock.innerHTML = `
      <button type="button" class="launcher" title="Abrir JobFill AI" aria-label="Abrir JobFill AI">⚡</button>
      <section class="panel" aria-label="JobFill AI">
        <header>
          <span class="brand"><span class="logo" aria-hidden="true">⚡</span>JobFill AI</span>
          <span class="hdr-actions">
            <button type="button" class="icon" data-action="collapse" title="Minimizar" aria-label="Minimizar">–</button>
            <button type="button" class="icon power" data-action="power" title="Desactivar JobFill AI en todas las páginas" aria-label="Desactivar en todas las páginas">⏻</button>
            <button type="button" class="icon" data-action="close" title="Ocultar en esta página (vuelve al recargar)" aria-label="Ocultar en esta página">✕</button>
          </span>
        </header>
        <button type="button" class="job" hidden>
          <span class="job-label">Cargo guardado</span>
          <span class="job-text"></span>
        </button>
        <button type="button" class="btn primary" data-action="autofill">⚡ Autorrellenar formulario</button>
        <div class="row">
          <button type="button" class="btn secondary" data-action="answer-all" title="Detecta todas las preguntas abiertas del formulario y las responde con una sola llamada a la IA">✨ Responder todas</button>
          <button type="button" class="btn secondary" data-action="capture" title="Lee el cargo de esta página y lo guarda para usarlo al postular (atajo: Ctrl+Shift+0, configurable en chrome://extensions/shortcuts)">📄 Guardar cargo</button>
        </div>
        <div class="row" data-vault-row hidden>
          <button type="button" class="btn secondary accent" data-action="apply" title="Adapta tu CV a esta oferta, genera el PDF, lo adjunta al formulario y lo autorrellena">🚀 Postular</button>
          <button type="button" class="btn secondary" data-action="register" title="Crea o actualiza &quot;Empresa - Cargo&quot; en el Tracker de tu vault, con estado Postulado">📌 Registrar</button>
        </div>
      </section>`;

    const $ = selector => dock.querySelector(selector);
    const setCollapsed = collapsed => {
      widgetCollapsed = collapsed;
      dock.dataset.collapsed = String(collapsed);
      chrome.storage.local.set({ widgetCollapsed: collapsed }).catch(() => {});
    };

    $(".launcher").addEventListener("click", () => setCollapsed(false));
    $('[data-action="collapse"]').addEventListener("click", () => setCollapsed(true));
    $('[data-action="close"]').addEventListener("click", () => {
      widgetDismissed = true;
      teardownPageUi();
    });
    $('[data-action="power"]').addEventListener("click", async () => {
      await chrome.storage.local.set({ extensionEnabled: false });
      // No se espera a storage.onChanged: el aviso tiene que salir DESPUÉS de
      // desmontar, y solo en esta pestaña (no en todas las abiertas).
      applyEnabledState(false);
      showToast("JobFill AI desactivada en todas las páginas. Reactívala desde el ícono ⚡ de la barra del navegador.", "info");
    });
    $(".job").addEventListener("click", async () => {
      const contexts = await loadJobContexts();
      const latest = contexts[0];
      if (!latest) return;
      openJobContextPanel({ ...latest, source: "cache" });
    });
    $('[data-action="autofill"]').addEventListener("click", () => executeAutofill());
    const answerAllBtn = $('[data-action="answer-all"]');
    answerAllBtn.addEventListener("click", () => handleAnswerAllQuestions(answerAllBtn));
    const captureBtn = $('[data-action="capture"]');
    captureBtn.addEventListener("click", () => manualCaptureJobContext(captureBtn));
    const vaultRow = $("[data-vault-row]");
    vaultRow.hidden = !vaultConnected;
    const registerBtn = $('[data-action="register"]');
    registerBtn.addEventListener("click", () => registerApplicationFromPage(registerBtn));
    const applyBtn = $('[data-action="apply"]');
    applyBtn.addEventListener("click", () => runApplyFlow(applyBtn));

    widgetRefs = { host, chip: $(".job"), chipText: $(".job-text"), vaultRow };

    shadow.append(style, dock);
    attachToTopLayerHost(host);
    ensureTopLayerWatcher();

    refreshCacheChip();
  }

  /**
   * "📌 Registrar postulación": confirma empresa y cargo (detectados de la
   * página o del cargo guardado) y los envía al Tracker del vault. Siempre
   * con confirmación: escribir en el vault es un commit, no algo que deba
   * pasar por un clic accidental.
   */
  async function registerApplicationFromPage(btn) {
    let ctx = {};
    try { ctx = await resolveJobContext(); } catch (e) { /* se completa a mano */ }

    const input = await confirmApplicationDetails({
      empresa: ctx.company || extractCompanyName() || "",
      cargo: ctx.title || extractJobTitle() || ""
    });
    if (!input) return;

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Registrando…";
    try {
      const response = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: "VAULT_REGISTER_APPLICATION",
          payload: { ...input, url: location.href, canal: location.hostname.replace(/^www\./, "") }
        }, r => resolve(chrome.runtime.lastError ? { success: false, error: ORPHANED_CONTEXT_MSG } : r));
      });
      if (response?.success) showToast(`📌 Registrada en tu Tracker: ${response.name}`, "success");
      else showToast(response?.error || "No se pudo registrar la postulación.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function confirmApplicationDetails(initial) {
    return new Promise(resolve => {
      const host = document.createElement("div");
      host.className = "jobfill-dialog-host";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CONFIRM_DIALOG_STYLES;

      const overlay = document.createElement("div");
      overlay.className = "jobfill-overlay";
      overlay.innerHTML = `
        <div class="jobfill-confirm" role="dialog" aria-modal="true" aria-label="Registrar postulación">
          <h3>📌 Registrar postulación</h3>
          <p>Se crea (o actualiza) la nota <strong>Empresa - Cargo</strong> en el Tracker de tu vault, con estado <strong>Postulado</strong> y la fecha de hoy.</p>
          <div class="jobfill-field">
            <label for="jf-reg-empresa">Empresa</label>
            <input type="text" id="jf-reg-empresa" spellcheck="false">
          </div>
          <div class="jobfill-field">
            <label for="jf-reg-cargo">Cargo</label>
            <input type="text" id="jf-reg-cargo" spellcheck="false">
          </div>
          <div class="jobfill-confirm-actions">
            <button class="jobfill-confirm-ok" type="button">📌 Registrar</button>
            <button class="jobfill-confirm-cancel" type="button">Cancelar</button>
          </div>
        </div>`;
      shadow.append(style, overlay);
      attachToTopLayerHost(host);

      const empresa = shadow.getElementById("jf-reg-empresa");
      const cargo = shadow.getElementById("jf-reg-cargo");
      // Con .value, nunca interpolado en el HTML: el texto viene de la página.
      empresa.value = initial.empresa;
      cargo.value = initial.cargo;
      (initial.empresa ? cargo : empresa).focus();

      let settled = false;
      const close = result => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        host.remove();
        resolve(result);
      };
      function onKeydown(e) { if (e.key === "Escape") { e.stopPropagation(); close(null); } }
      document.addEventListener("keydown", onKeydown, true);

      shadow.querySelector(".jobfill-confirm-ok").addEventListener("click", () => {
        const e = empresa.value.trim();
        const c = cargo.value.trim();
        if (!e || !c) {
          (e ? cargo : empresa).focus();
          return;
        }
        close({ empresa: e, cargo: c });
      });
      shadow.querySelector(".jobfill-confirm-cancel").addEventListener("click", () => close(null));
    });
  }

  // ─── 🚀 Postular en 1 flujo ────────────────────────────────────────────────
  //
  // Oferta leída de la página → CV adaptado por el postulador (mismo proceso
  // que el artefacto de claude.ai) → PDF adjunto al campo de CV → formulario
  // autorrellenado → registro en el Tracker con confirmación.

  let activeApplyFlow = null;

  const APPLY_STEPS = [
    ["contexto", "Leer tu BASE y CVs base"],
    ["perfil", "Elegir el CV base"],
    ["adaptar", "Adaptar el CV a la oferta"],
    ["validar", "Verificar reglas y 1 página"],
    ["ajustar", "Ajustar lo que no pasa"],
    ["pdf", "Generar el PDF (queda en tu vault)"],
    ["revisar", "Revisar el CV (tú decides si se adjunta)"],
    ["adjuntar", "Adjuntar el PDF al formulario"],
    ["rellenar", "Autorrellenar el formulario"]
  ];

  const APPLY_FLOW_STYLES = `
    .jf-steps { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 6px; }
    .jf-steps li { display: flex; gap: 10px; align-items: baseline; font-size: 13px; color: #64748b; }
    .jf-steps li::before { content: "○"; width: 14px; flex-shrink: 0; text-align: center; }
    .jf-steps li.is-active { color: #e0e7ff; font-weight: 600; }
    .jf-steps li.is-active::before { content: "◐"; color: #a5b4fc; }
    .jf-steps li.is-done { color: #94a3b8; }
    .jf-steps li.is-done::before { content: "✓"; color: #34d399; }
    .jf-steps li.is-skip { display: none; }
    .jf-steps li.is-error { color: #fca5a5; font-weight: 600; }
    .jf-steps li.is-error::before { content: "✗"; color: #f87171; }
    .jf-detail { margin: 10px 0 0 !important; min-height: 18px; }
    .jf-result { margin-top: 14px; display: grid; gap: 8px; font-size: 12.5px; color: #cbd5e1; }
    .jf-result .ok { color: #6ee7b7; }
    .jf-result .warn { color: #fbbf24; }
    .jf-result .err { color: #fca5a5; }
    .jf-result ul { margin: 0; padding-left: 18px; }
    .jobfill-confirm.is-wide { width: min(880px, 100%); }
    /* Con la vista previa el diálogo se alarga: los botones quedan fijos abajo. */
    .jobfill-confirm.is-wide .jobfill-confirm-actions { position: sticky; bottom: -22px; margin: 14px -22px -22px; padding: 12px 22px; background: #0f172a; border-top: 1px solid rgba(148, 163, 184, 0.18); flex-wrap: wrap; }
    .jf-preview { margin-top: 14px; padding: 14px; border-radius: 12px; background: #334155; max-height: 62vh; overflow: auto; }
    .jf-preview-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 0 0 10px; font-size: 12px; color: #cbd5e1; }
    .jf-preview-bar .warn { color: #fbbf24; }
    .jf-paper { display: block; margin: 0 auto; width: 8.5in; min-height: 11in; box-sizing: border-box; padding: 1.27cm; background: #fff; box-shadow: 0 10px 30px -10px rgba(2, 6, 23, 0.6); }
    .jf-preview-empty { font-size: 12.5px; color: #cbd5e1; }
    .jf-revise { margin-top: 14px; }
    .jf-revise label { display: block; font-size: 12.5px; font-weight: 600; color: #e2e8f0; margin-bottom: 6px; }
    .jf-revise textarea { box-sizing: border-box; width: 100%; min-height: 64px; resize: vertical; padding: 9px 11px; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.3); background: #1e293b; color: #f8fafc; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .jf-revise textarea:focus { outline: 2px solid #818cf8; outline-offset: 1px; }
    .jf-revise-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 8px; font-size: 11.5px; color: #94a3b8; }
    .jf-revise-row button { flex: 0 0 auto; }
    .jf-register { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(148, 163, 184, 0.18); }
    [hidden] { display: none !important; }`;

  function openApplyFlowDialog() {
    const host = document.createElement("div");
    host.className = "jobfill-dialog-host";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CONFIRM_DIALOG_STYLES + APPLY_FLOW_STYLES;
    const overlay = document.createElement("div");
    overlay.className = "jobfill-overlay";
    overlay.innerHTML = `
      <div class="jobfill-confirm" role="dialog" aria-modal="true" aria-label="Postular">
        <h3>🚀 Postular a esta oferta</h3>
        <p class="jf-offer"></p>
        <ul class="jf-steps">${APPLY_STEPS.map(([id, label]) => `<li data-step="${id}">${label}</li>`).join("")}</ul>
        <p class="jf-detail"></p>
        <div class="jf-result" hidden></div>
        <div class="jf-preview" hidden></div>
        <div class="jf-revise" hidden>
          <label for="jf-revise-text">✎ ¿Quieres cambiar algo del CV?</label>
          <textarea id="jf-revise-text" maxlength="1000" placeholder="Ej: acorta el resumen, pon MAZA antes que MedInfo, usa &quot;APIs REST&quot; como dice la oferta…"></textarea>
          <div class="jf-revise-row">
            <span>Se aplica solo con hechos de tu BASE y vuelve a pasar por el verificador.</span>
            <button class="jobfill-confirm-cancel" type="button" data-act="revise">✎ Aplicar cambio</button>
          </div>
        </div>
        <div class="jf-register" hidden>
          <div class="jobfill-field"><label for="jf-ap-empresa">Empresa</label><input type="text" id="jf-ap-empresa" spellcheck="false"></div>
          <div class="jobfill-field"><label for="jf-ap-cargo">Cargo</label><input type="text" id="jf-ap-cargo" spellcheck="false"></div>
        </div>
        <div class="jobfill-confirm-actions">
          <button class="jobfill-confirm-ok" type="button" data-act="attach" hidden>✓ Se ve bien: adjuntar y rellenar</button>
          <button class="jobfill-confirm-ok" type="button" data-act="retry" hidden>↻ Reintentar</button>
          <button class="jobfill-confirm-cancel" type="button" data-act="open" hidden>↗ Abrir PDF</button>
          <button class="jobfill-confirm-ok" type="button" data-act="register" hidden>📌 Registrar en el Tracker</button>
          <button class="jobfill-confirm-cancel" type="button" data-act="download" hidden>⬇ Descargar PDF</button>
          <button class="jobfill-confirm-cancel" type="button" data-act="close">Cerrar</button>
        </div>
      </div>`;
    shadow.append(style, overlay);
    attachToTopLayerHost(host);

    const $s = sel => shadow.querySelector(sel);
    const order = APPLY_STEPS.map(([id]) => id);
    let current = -1;

    const ui = {
      shadow,
      setOffer(text) { $s(".jf-offer").textContent = text; },
      setStep(step, detail = "") {
        const idx = order.indexOf(step);
        if (idx === -1) return;
        // Un solo paso activo: al pedir un cambio el flujo vuelve de
        // "Revisar" a "Verificar"/"Ajustar".
        shadow.querySelectorAll(".jf-steps li.is-active").forEach(li => li.classList.replace("is-active", "is-done"));
        order.forEach((id, i) => {
          const li = $s(`[data-step="${id}"]`);
          if (i < idx && li.classList.contains("is-active")) li.classList.replace("is-active", "is-done");
          else if (i < idx && !li.classList.contains("is-done")) li.classList.add(id === "ajustar" || id === "perfil" ? "is-skip" : "is-done");
        });
        $s(`[data-step="${step}"]`).classList.remove("is-skip", "is-error");
        $s(`[data-step="${step}"]`).classList.add("is-active");
        current = idx;
        $s(".jf-detail").textContent = detail;
      },
      finishSteps(upTo) {
        const last = upTo ? order.indexOf(upTo) : order.length - 1;
        order.forEach((id, i) => {
          const li = $s(`[data-step="${id}"]`);
          if (li.classList.contains("is-active") || (i <= last && !li.classList.contains("is-done") && !li.classList.contains("is-skip") && i <= current)) {
            li.classList.remove("is-active");
            li.classList.add("is-done");
          }
        });
        $s(".jf-detail").textContent = "";
      },
      /** Marca en rojo el paso en curso (el que falló). */
      markError() {
        const li = shadow.querySelector(".jf-steps li.is-active");
        if (li) li.classList.replace("is-active", "is-error");
      },
      clearResult() {
        const box = $s(".jf-result");
        box.replaceChildren();
        box.hidden = true;
      },
      showRetry(label, onRetry) {
        const btn = $s('[data-act="retry"]');
        btn.textContent = label;
        btn.disabled = false;
        btn.hidden = false;
        btn.onclick = () => { btn.disabled = true; onRetry(); };
      },
      hideRetry() { $s('[data-act="retry"]').hidden = true; },
      /**
       * Vista previa del CV con la misma plantilla del PDF. Va en su propio
       * Shadow DOM: ni el CSS del portal ni el del diálogo la alteran.
       */
      showPreview(html, { paginas } = {}) {
        const box = $s(".jf-preview");
        box.replaceChildren();
        const bar = document.createElement("div");
        bar.className = "jf-preview-bar";
        const title = document.createElement("span");
        title.textContent = "Vista previa (misma plantilla del PDF)";
        const pages = document.createElement("span");
        if (paginas) {
          pages.textContent = paginas === 1 ? "1 página" : `${paginas} páginas`;
          if (paginas > 1) pages.className = "warn";
        }
        bar.append(title, pages);
        box.appendChild(bar);

        const cv = sanitizeCvHtml(html);
        if (!cv) {
          const empty = document.createElement("p");
          empty.className = "jf-preview-empty";
          empty.textContent = "Tu postulador no devolvió la vista previa. Revisa el PDF con ↗ Abrir PDF o ⬇ Descargar PDF antes de adjuntarlo.";
          box.appendChild(empty);
        } else {
          const paper = document.createElement("div");
          paper.className = "jf-paper";
          const root = paper.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent = cv.css;
          root.append(style, cv.body);
          box.appendChild(paper);
          // A escala del ancho disponible (la hoja Carta mide 816 px).
          requestAnimationFrame(() => {
            const avail = box.clientWidth - 28;
            paper.style.zoom = String(Math.min(1, Math.max(0.4, avail / 816)));
          });
        }
        $s(".jobfill-confirm").classList.add("is-wide");
        box.hidden = false;
      },
      showOpen(onOpen) {
        const btn = $s('[data-act="open"]');
        btn.hidden = false;
        btn.onclick = onOpen;
      },
      showRevise(onSubmit) {
        const box = $s(".jf-revise");
        const text = $s("#jf-revise-text");
        const btn = $s('[data-act="revise"]');
        box.hidden = false;
        btn.disabled = false;
        btn.onclick = () => {
          const value = text.value.trim();
          if (!value) { text.focus(); return; }
          onSubmit(value);
          text.value = "";
        };
      },
      /** Oculta lo que depende del CV mostrado mientras se genera otro. */
      hideReviewActions() {
        for (const act of ["attach", "open", "download", "retry"]) $s(`[data-act="${act}"]`).hidden = true;
        $s(".jf-revise").hidden = true;
      },
      showAttach(onAttach) {
        const btn = $s('[data-act="attach"]');
        btn.hidden = false;
        btn.disabled = false;
        btn.onclick = () => { btn.hidden = true; $s(".jf-revise").hidden = true; onAttach(); };
      },
      showResult(lines) {
        const box = $s(".jf-result");
        box.replaceChildren();
        for (const { text, tone = "", items } of lines) {
          const div = document.createElement("div");
          if (tone) div.className = tone;
          div.textContent = text;
          if (items?.length) {
            const ul = document.createElement("ul");
            for (const it of items) { const li = document.createElement("li"); li.textContent = it; ul.appendChild(li); }
            div.appendChild(ul);
          }
          box.appendChild(div);
        }
        box.hidden = false;
      },
      showRegister(empresa, cargo, onRegister) {
        $s(".jf-register").hidden = false;
        $s("#jf-ap-empresa").value = empresa || "";
        $s("#jf-ap-cargo").value = cargo || "";
        const btn = $s('[data-act="register"]');
        btn.hidden = false;
        btn.onclick = () => onRegister($s("#jf-ap-empresa").value.trim(), $s("#jf-ap-cargo").value.trim(), btn);
      },
      showDownload(onDownload) {
        const btn = $s('[data-act="download"]');
        btn.hidden = false;
        btn.onclick = onDownload;
      },
      close() {
        document.removeEventListener("keydown", onKeydown, true);
        host.remove();
        if (activeApplyFlow === ui) activeApplyFlow = null;
      }
    };
    function onKeydown(e) { if (e.key === "Escape") { e.stopPropagation(); ui.close(); } }
    document.addEventListener("keydown", onKeydown, true);
    $s('[data-act="close"]').addEventListener("click", () => ui.close());
    return ui;
  }

  /** Hosts de la propia extensión: la búsqueda profunda no entra en ellos. */
  function isOwnUi(el) {
    return Boolean(el.closest?.(".jobfill-floating-container, .jobfill-dialog-host"));
  }

  /** Texto de contexto de un <input type=file> o una zona de soltar, para puntuarlo. */
  function fileTargetText(el) {
    const attrs = ["id", "name", "data-automation-id", "data-testid", "data-test", "data-ui", "data-field", "aria-label"]
      .map(a => el.getAttribute?.(a) || "").join(" ");
    const labelParts = [getFieldContext(el)];
    const container = el.closest("label, fieldset, .form-group, .field, [class*='upload' i], [class*='file' i], [class*='dropzone' i], [class*='drop-zone' i], [class*='resume' i], [class*='attachment' i], [data-automation-id*='upload' i]");
    if (container && container.innerText) labelParts.push(container.innerText.slice(0, 200));
    return { attrs, label: labelParts.join(" ") };
  }

  /**
   * Mejor destino para el CV en ESTE frame: un <input type=file> (también
   * dentro de Shadow DOM) o, si la zona no tiene input, la zona de soltar.
   * Devuelve { el, kind, score } o { el: null, reason }.
   *
   * Solo se adjunta a algo identificado como CV (puntaje ≥ 60). Un campo
   * neutro (15) cuenta solo si es el ÚNICO campo de archivo del frame: con
   * varios campos ambiguos (CV, carta, certificados) no se adivina.
   */
  function findCvTarget() {
    const portalHits = new Set();
    for (const sel of Portals.PORTAL_CV_SELECTORS) {
      try { Portals.deepQuerySelectorAll(sel, document, isOwnUi).forEach(el => portalHits.add(el)); } catch (e) { /* selector no soportado */ }
    }
    const inputs = Portals.deepQuerySelectorAll('input[type="file"]', document, isOwnUi).filter(i => !i.disabled);
    const scored = inputs.map(el => {
      const { attrs, label } = fileTargetText(el);
      return { el, kind: "input", score: Portals.scoreCvCandidate({ portalMatch: portalHits.has(el), attrs, label, accept: el.accept }) };
    });

    // Zonas de soltar SIN input adentro (con input, ya se puntuó el input).
    const zones = Portals.deepQuerySelectorAll(Portals.DROPZONE_SELECTOR, document, isOwnUi)
      .filter(z => !z.querySelector('input[type="file"]') && !z.parentElement?.closest(Portals.DROPZONE_SELECTOR));
    for (const el of zones) {
      const { attrs, label } = fileTargetText(el);
      scored.push({ el, kind: "dropzone", score: Portals.scoreCvCandidate({ attrs, label }) });
    }

    const total = inputs.length + zones.length;
    const best = scored.filter(c => c.score >= 60).sort((a, b) => b.score - a.score)[0];
    if (best) return best;
    const neutral = scored.filter(c => c.score > 0);
    if (total === 1 && neutral.length === 1) return neutral[0];
    return { el: null, score: 0, total, reason: total ? "no se identificó con certeza cuál es el campo del CV" : "la página no tiene un campo para subir archivos" };
  }

  /** Lo que el service worker necesita para elegir frame, sin tocar nada. */
  function probeCvTarget() {
    const t = findCvTarget();
    const filled = t.kind === "input" && t.el.files?.length > 0;
    return { score: filled ? 0 : t.score, total: t.total ?? 1, filled, kind: t.kind || "", reason: filled ? "el campo del CV ya tiene un archivo (no se reemplaza)" : t.reason || "" };
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /**
   * Adjunta el PDF al campo del CV de ESTE frame. Mismo principio que el
   * autorrelleno: nunca se reemplaza un archivo que el usuario ya eligió.
   *
   * Con un input: DataTransfer → `input.files` + eventos input/change que
   * burbujean (así lo ven React/Vue/Angular, que escuchan en la raíz). Con una
   * zona sin input: dragenter/dragover/drop sintéticos con el mismo
   * DataTransfer, que es lo que hace el navegador al soltar un archivo.
   */
  function attachPdfToForm(base64, fileName) {
    const target = findCvTarget();
    if (!target.el) return { attached: false, reason: target.reason };
    const file = new File([base64ToBytes(base64)], fileName, { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);

    if (target.kind === "input") {
      const input = target.el;
      if (input.files && input.files.length) return { attached: false, reason: "el campo del CV ya tiene un archivo (no se reemplaza)" };
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { attached: true, kind: "input" };
    }

    for (const type of ["dragenter", "dragover", "drop"]) {
      target.el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
    }
    return { attached: true, kind: "dropzone" };
  }

  /**
   * HTML de la vista previa (viene de TU postulador, pero igual se trata
   * como no confiable): sin scripts, iframes ni atributos on*, enlaces a
   * pestaña nueva. Las reglas de `html`/`body` se reescriben a `.cv-body`
   * porque dentro de un Shadow DOM no existen esos elementos.
   */
  function sanitizeCvHtml(html) {
    if (!html || typeof html !== "string") return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const css = [...doc.querySelectorAll("style")].map(st => st.textContent).join("\n")
      .replace(/@page[^{]*\{[^}]*\}/g, "")
      .replace(/(^|[\s,}])html\s*\{/g, "$1.cv-html {")
      .replace(/(^|[\s,}])body\s*\{/g, "$1.cv-body {");
    doc.querySelectorAll("script, iframe, object, embed, link, meta, base, form, style").forEach(n => n.remove());
    // La plantilla no usa imágenes; una externa haría una petición desde el portal.
    doc.querySelectorAll("img").forEach(img => { if (!/^data:image\//i.test(img.getAttribute("src") || "")) img.remove(); });
    for (const el of doc.body.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      }
      if (el.tagName === "A") { el.target = "_blank"; el.rel = "noopener noreferrer"; }
    }
    if (!doc.body.textContent.trim()) return null;
    const body = document.createElement("div");
    body.className = "cv-body cv-html";
    body.append(...[...doc.body.childNodes].map(n => document.importNode(n, true)));
    return { css, body };
  }

  /** Abre el PDF en una pestaña nueva (visor de PDF del navegador). */
  function openPdf(base64) {
    const url = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: "application/pdf" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function downloadPdf(base64, fileName) {
    const url = URL.createObjectURL(new Blob([base64ToBytes(base64)], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function sendToWorker(type, payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, payload }, r => resolve(chrome.runtime.lastError ? { success: false, error: ORPHANED_CONTEXT_MSG } : r || { success: false, error: "Sin respuesta del service worker." }));
      } catch (e) {
        resolve({ success: false, error: ORPHANED_CONTEXT_MSG });
      }
    });
  }

  async function runApplyFlow(btn) {
    if (activeApplyFlow) return;
    let job = {};
    try { job = await resolveJobContext(); } catch (e) { /* se valida abajo */ }
    let oferta = (job.description || "").trim();
    let empresa = Portals.cleanCompanyName(job.company) || extractCompanyName() || "";
    let cargo = job.title || extractJobTitle() || "";
    if (oferta.length < 80) {
      // Formulario embebido: la oferta puede estar dentro del iframe del ATS.
      const fromFrames = await sendToWorker("FRAMES_JOB_CONTEXT");
      if (fromFrames?.description) {
        // El cargo y la empresa del iframe mandan: el <h1> del sitio que lo
        // envuelve suele ser "Trabaja con nosotros", no el cargo.
        oferta = fromFrames.description.trim();
        empresa = Portals.cleanCompanyName(fromFrames.company) || empresa;
        cargo = fromFrames.title || cargo;
      }
    }
    if (oferta.length < 80) {
      showToast("No encontré la descripción de la oferta en esta página. Abre la oferta y guárdala con 📄 Guardar cargo, y después vuelve al formulario.", "error");
      return;
    }

    btn.disabled = true;
    const ui = openApplyFlowDialog();
    activeApplyFlow = ui;
    ui.setOffer(`${cargo || "Cargo sin detectar"}${empresa ? ` · ${empresa}` : ""}${job.fromCache ? " (oferta guardada)" : ""}`);
    ui.setStep("contexto", "Conectando con tu vault…");

    // Cada intento pide al worker que adapte; "Reintentar" repite con
    // `resume: true` y el worker sigue desde su punto de control (no vuelve a
    // adaptar ni a gastar lo que ya salió bien).
    const requestChange = cambio => {
      ui.setStep("revisar", "Aplicando tu cambio…");
      attempt({ resume: true, cambio });
    };

    const attempt = async (payload) => {
      ui.hideReviewActions();
      ui.clearResult();
      btn.disabled = true;
      try {
        const res = await sendToWorker("APPLY_ADAPT_CV", payload);
        if (!res?.success) {
          const err = new Error(res?.error || "No se pudo adaptar el CV.");
          err.retryable = Boolean(res?.retryable);
          throw err;
        }

        if (!res.ok) {
          ui.finishSteps("validar");
          ui.showResult([
            { text: "✗ El CV adaptado no pasa las reglas de tu verificador, así que no se generó el PDF.", tone: "err", items: res.hallazgos.filter(h => h.nivel === "error").map(h => h.detalle) },
            { text: res.canRetry
              ? "Puedes pedir otro ajuste automático, o abrirlo en el Postulador de claude.ai para ajustarlo a mano. El formulario no se tocó."
              : "Ábrelo en el Postulador de claude.ai para ajustarlo a mano; el formulario no se tocó." }
          ]);
          ui.showPreview(res.html, { paginas: res.paginas });
          ui.showRevise(requestChange);
          if (res.canRetry) ui.showRetry("↻ Intentar otro ajuste", () => { ui.setStep("ajustar", "Pidiendo otro ajuste…"); attempt({ resume: true }); });
          return;
        }

        // Pausa: nada se adjunta sin que el usuario vea el CV y lo apruebe.
        ui.setStep("revisar", "Revisa el CV. No se adjunta nada hasta que confirmes.");
        ui.showResult(cvSummaryLines(res));
        ui.showPreview(res.html, { paginas: res.paginas });
        ui.showDownload(() => downloadPdf(res.base64, res.archivo));
        ui.showOpen(() => openPdf(res.base64));
        ui.showRevise(requestChange);
        ui.showAttach(() => completeApplyFlow(ui, res, { empresa, cargo }).catch(err => {
          ui.markError();
          clearFlowDetail(ui);
          ui.showResult([{ text: `✗ ${err.message}`, tone: "err" }, { text: "El PDF sigue disponible: descárgalo y súbelo a mano." }]);
        }));
      } catch (err) {
        ui.markError();
        clearFlowDetail(ui);
        ui.showResult([
          { text: `✗ ${err.message}`, tone: "err" },
          err.retryable ? { text: "Lo que ya estaba listo (perfil, CV adaptado, verificación) quedó guardado: Reintentar sigue desde el paso que falló." } : null
        ].filter(Boolean));
        if (err.retryable) ui.showRetry("↻ Reintentar", () => attempt({ resume: true }));
      } finally {
        btn.disabled = false;
      }
    };

    await attempt({ oferta, empresa, cargo });
  }

  /** Resumen del CV generado: primera línea + cobertura, faltantes y avisos. */
  function cvSummaryLines(res) {
    const warnings = res.hallazgos.filter(h => h.nivel !== "error").map(h => h.detalle);
    return [
      { text: `✓ CV ${res.perfil} adaptado${res.cambios ? ` con ${res.cambios === 1 ? "tu cambio" : `tus ${res.cambios} cambios`}` : ""}${res.ajustado ? " (con un ajuste automático)" : ""} y guardado en tu vault: cv/generados/${res.archivo}`, tone: "ok" },
      res.nota ? { text: `Sobre tu cambio: ${res.nota}`, tone: "warn" } : null,
      res.cobertura ? { text: `Requisitos de la oferta respaldados por tu grafo: ${res.cobertura}` } : null,
      res.faltantes?.length ? { text: "Sin respaldo en tu BASE (no se mencionan en el CV):", tone: "warn", items: res.faltantes } : null,
      warnings.length ? { text: "Avisos del verificador:", tone: "warn", items: warnings } : null
    ].filter(Boolean);
  }

  /** Con el PDF listo: adjuntar, autorrellenar, mostrar el resultado y ofrecer descarga y registro. */
  async function completeApplyFlow(ui, res, { empresa, cargo }) {
    ui.setStep("adjuntar", "Buscando el campo para subir el CV…");
    const attach = await sendToWorker("APPLY_ATTACH_CV", { base64: res.base64, archivo: res.archivo });
    ui.setStep("rellenar", "Rellenando el resto del formulario…");
    const fill = await executeAutofill();
    ui.finishSteps();

    const [cvLine, ...details] = cvSummaryLines(res);
    ui.showResult([
      cvLine,
      attach.attached
        ? { text: `✓ PDF adjuntado al campo del CV${attach.inFrame ? " (formulario embebido)" : ""}. Revísalo antes de enviar.`, tone: "ok" }
        : attach.pending
          ? { text: "⏳ Este paso del formulario aún no pide el CV: se adjuntará solo cuando aparezca el campo (en esta pestaña, durante 30 min).", tone: "warn" }
          : { text: `⚠ No se adjuntó automáticamente: ${attach.reason || attach.error || "error desconocido"}. Descárgalo y súbelo a mano.`, tone: "warn" },
      { text: fill?.count ? `✓ ${fill.count === 1 ? "1 campo del formulario rellenado" : `${fill.count} campos del formulario rellenados`}.` : "Formulario sin campos vacíos que rellenar." },
      ...details
    ]);

    ui.showDownload(() => downloadPdf(res.base64, res.archivo));
    ui.showRegister(res.empresa || empresa, res.cargo || cargo, async (emp, car, regBtn) => {
      if (!emp || !car) return;
      regBtn.disabled = true;
      const r = await sendToWorker("VAULT_REGISTER_APPLICATION", {
        empresa: emp, cargo: car, url: location.href, canal: location.hostname.replace(/^www\./, ""),
        cvPerfil: res.perfil, cvPdf: res.archivo, area: res.area, keywordsCubiertas: res.cobertura
      });
      if (r?.success) {
        regBtn.textContent = "✓ Registrada";
        showToast(`📌 Registrada en tu Tracker: ${r.name}`, "success");
      } else {
        regBtn.disabled = false;
        showToast(r?.error || "No se pudo registrar la postulación.", "error");
      }
    });
  }

  function clearFlowDetail(ui) {
    const d = ui.shadow.querySelector(".jf-detail");
    if (d) d.textContent = "";
  }

  /**
   * API de este frame para el service worker (chrome.scripting corre en el
   * mismo mundo aislado que el content script). Nunca la ve la página: vive
   * en el mundo aislado, no en `window` de la página.
   */
  globalThis.JobFillFrame = {
    probeCv: () => extensionEnabled ? probeCvTarget() : { score: 0, total: 0, reason: "JobFill AI está apagado" },
    attachCv: (base64, fileName) => extensionEnabled ? attachPdfToForm(base64, fileName) : { attached: false, reason: "JobFill AI está apagado" },
    autofill: () => (IS_TOP_FRAME || !extensionEnabled) ? { skipped: true } : executeAutofill({ quiet: true }),
    job: () => {
      const { text, reliable } = extractJobDescriptionWithSource();
      return { title: extractJobTitle(), company: extractCompanyName(), text, reliable };
    }
  };

  /*
   * CV pendiente (formularios de varios pasos). Mientras el service worker
   * tenga un PDF pendiente para esta pestaña, cada frame vigila si aparece el
   * campo del CV y lo reclama una sola vez. Fuera de ese estado no se busca
   * nada: la búsqueda profunda no corre en cada mutación de cada página.
   */
  let pendingCvWatch = false;
  let pendingCvTimer = null;
  const offeredCvTargets = new WeakSet();

  function setPendingCvWatch(active) {
    pendingCvWatch = active;
    clearTimeout(pendingCvTimer);
    if (active) schedulePendingCvCheck();
  }

  function schedulePendingCvCheck() {
    if (!pendingCvWatch || pendingCvTimer) return;
    pendingCvTimer = setTimeout(checkPendingCv, 700);
  }

  async function checkPendingCv() {
    pendingCvTimer = null;
    if (!pendingCvWatch || !extensionEnabled) return;
    const target = findCvTarget();
    if (!target.el || offeredCvTargets.has(target.el)) return;
    offeredCvTargets.add(target.el);
    if (target.kind === "input" && target.el.files?.length) return;

    const claim = await sendToWorker("CLAIM_PENDING_CV");
    if (!claim?.base64) return;
    const result = attachPdfToForm(claim.base64, claim.archivo);
    showToast(result.attached
      ? `📎 CV adaptado adjuntado: ${claim.archivo}. Revísalo antes de enviar.`
      : `No se pudo adjuntar el CV adaptado: ${result.reason}. Descárgalo desde tu vault (cv/generados).`,
      result.attached ? "success" : "error");
  }

  /** Quita de la página todo lo que la extensión dibuja de forma persistente. */
  function teardownPageUi() {
    document.querySelector(".jobfill-floating-container")?.remove();
    widgetRefs = null;
    removeAiButton();
  }

  /** Aplica el interruptor global en esta pestaña, sin recargar. */
  function applyEnabledState(enabled) {
    extensionEnabled = enabled;
    if (enabled && IS_TOP_FRAME) initFloatingWidget();
    else if (!enabled) teardownPageUi();
  }

  document.addEventListener("focusin", (e) => {
    if (!extensionEnabled) return;
    const el = e.target;
    if (!el) return;

    if (el.tagName === "TEXTAREA" || el.tagName === "TRIX-EDITOR" || el.isContentEditable) {
      attachAiButtonToTextarea(el);
    } else if (el.tagName === "INPUT" && (el.type === "text" || !el.type)) {
      const ctx = getFieldContext(el);
      // If the text input is a question / description field
      if (ctx.length > 25 && /(describa|por qu[eé]|cu[aá]l|cu[aá]ntos|why|how|explain|tell|resume|cu[eé]ntanos)/i.test(ctx)) {
        attachAiButtonToTextarea(el);
      }
    }
  });

  document.addEventListener("click", (e) => {
    // Un clic dentro de un diálogo propio (confirmar pregunta, cobertura,
    // panel de cargo) llega aquí retargeteado al host del Shadow DOM, que no
    // es ni el botón AI ni el campo activo — sin este guard, cualquier clic en
    // "Aceptar" del diálogo borraba el botón ANTES de que el código volviera a
    // usarlo para mostrar el spinner de "cargando", dejándolo aplicado a un
    // nodo ya desprendido del documento (por eso el spinner nunca se veía).
    if (e.target.closest && e.target.closest(".jobfill-dialog-host")) return;
    if (currentAiBtn && !currentAiBtn.contains(e.target) && e.target !== currentActiveTarget) {
      removeAiButton();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "CV_PENDING") {
      setPendingCvWatch(message.active === true);
      return false;
    }

    // El popup envía a todos los frames; responde solo el principal, que
    // además rellena los iframes (AUTOFILL_SUBFRAMES) y suma el total.
    if (!IS_TOP_FRAME) return false;

    if (message.type === "TRIGGER_AUTOFILL") {
      if (!extensionEnabled) {
        sendResponse({ success: false, count: 0, disabled: true });
        return false;
      }
      executeAutofill().then(res => sendResponse(res));
      return true;
    }

    if (message.type === "APPLY_PROGRESS") {
      activeApplyFlow?.setStep(message.step, message.detail);
      return false;
    }

    if (message.type === "CAPTURE_JOB_CONTEXT_HOTKEY") {
      // El atajo de teclado (Ctrl+Shift+0 por defecto, o el botón del mouse
      // remapeado a esa combinación) dispara la misma captura manual que el
      // botón del widget — se le pasa `null` como botón porque no hay uno
      // visible que poner en estado "cargando".
      if (extensionEnabled) manualCaptureJobContext(null);
      return false;
    }
  });

  // La captura del cargo ya NO es automática (ver manualCaptureJobContext): en
  // páginas con DOM muy dinámico, la captura periódica que corría antes en
  // cada mutación competía por los mismos ciclos de re-adjuntado con el botón
  // ✨ y era la raíz de un bug real ("el botón no hace nada", depurado en
  // Laborum). Lo único que se sigue vigilando en segundo plano es el envío de
  // la postulación, para descartar del caché la oferta ya enviada — es una
  // lectura, casi nunca escribe, y no compite por el mismo DOM que el botón.
  let submissionCheckTimer = null;
  function scheduleSubmissionCheck() {
    clearTimeout(submissionCheckTimer);
    submissionCheckTimer = setTimeout(() => {
      if (pageShowsSubmissionSignal()) clearJobContextIfSubmitted();
    }, 1500);
  }

  // Dynamic MutationObserver to monitor LinkedIn Easy Apply / Getonbrd modals & step transitions
  const observer = new MutationObserver(() => {
    if (!extensionEnabled) return;
    schedulePendingCvCheck();
    if (!IS_TOP_FRAME) return;
    initFloatingWidget();
    // Cubre las SPA: en LinkedIn o Getonbrd la pantalla de "postulación
    // enviada" aparece sin recargar la página, así que un chequeo único al
    // cargar nunca la vería.
    scheduleSubmissionCheck();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // El interruptor se cambia desde el popup o desde otra pestaña: todas las
  // pestañas abiertas reaccionan al instante, sin recargar.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) applyEnabledState(changes.extensionEnabled.newValue !== false);
    if (changes.vaultLastSync) {
      vaultConnected = Boolean(changes.vaultLastSync.newValue);
      if (widgetRefs?.vaultRow) widgetRefs.vaultRow.hidden = !vaultConnected;
    }
    if (changes.widgetCollapsed) {
      widgetCollapsed = changes.widgetCollapsed.newValue === true;
      const dock = widgetRefs?.host.shadowRoot.querySelector(".dock");
      if (dock) dock.dataset.collapsed = String(widgetCollapsed);
    }
  });

  // Arranque: primero se lee el interruptor, recién después se dibuja algo.
  chrome.storage.local.get(["extensionEnabled", "widgetCollapsed", "vaultLastSync"]).then(prefs => {
    widgetCollapsed = prefs.widgetCollapsed === true;
    vaultConnected = Boolean(prefs.vaultLastSync);
    const start = () => {
      applyEnabledState(prefs.extensionEnabled !== false);
      // Un paso nuevo del formulario puede ser una página nueva (Taleo,
      // iCIMS): se pregunta si quedó un CV pendiente. Solo el frame principal
      // y los iframes con campos preguntan; los de anuncios no despiertan al
      // service worker.
      if (extensionEnabled && (IS_TOP_FRAME || document.querySelector("input, textarea, select"))) {
        sendToWorker("HAS_PENDING_CV").then(r => { if (r?.pending) setPendingCvWatch(true); });
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }).catch(() => {
    // Contexto de extensión invalidado (se recargó con la pestaña abierta):
    // no hay nada que dibujar hasta que el usuario recargue la página.
  });
})();
