/**
 * JobFill AI - Fuente de verdad en Markdown.
 *
 * El usuario mantiene su experiencia en archivos .md (p. ej. BASE_Experiencia.md
 * de su vault). Este módulo los convierte, LOCALMENTE y en milisegundos, en:
 *  - datos para los campos del formulario (identidad, contacto, stack, estudios),
 *  - la base estructurada `cvDatabase` que usa el resto de la extensión,
 *  - el contexto que se le entrega a la IA, elegido por relevancia a la oferta.
 *
 * Reemplaza al camino CV → PDF → extracción → IA → JSON (hasta 90 s y con
 * pérdida: la IA resumía y se caían las REGLAS DE USO del propio usuario).
 *
 * Formato esperado (tolerante: lo que no calza se conserva como texto):
 *
 *   ## REGLAS DE USO            → se pasan LITERALES al prompt
 *   ## IDENTIDAD                → "Nombre: …", "Contacto: …", "LinkedIn: …"
 *   ## CADENAS CANONICAS        → frases que deben usarse tal cual
 *   ## Proyecto - Desc (período)
 *   Rol: …
 *   ### Subgrupo
 *   - [id] Título del logro
 *     tec: …   metrica: …   contexto: …   verificable: …
 *   ## STACK TECNICO …          → "Categoría: a, b, c"
 *   ## EDUCACION …
 *
 * Garantías deterministas (no dependen de que el modelo obedezca):
 *  - Una sección con "Nota: … NUNCA va en un CV" no se envía nunca.
 *  - Una métrica marcada "ESTIMADA" se elimina antes de enviar: el modelo no
 *    puede escribir un número que nunca recibió.
 *  - El preámbulo del archivo ("este archivo no se envía a nadie") se descarta:
 *    dirigido a humanos, podía hacer que el modelo se negara a usar los datos.
 *
 * Script clásico (sin módulos) por la misma razón que shared/ai-client.js:
 * lo cargan el service worker (importScripts) y la página de opciones.
 */
(function (root) {
  "use strict";

  const SPECIAL_SECTIONS = {
    rules: /^reglas/,
    identity: /^identidad/,
    canonical: /^cadenas canonicas/,
    stack: /^(stack|habilidades)/,
    education: /^(educacion|formacion|estudios)/,
    other: /^otros?$/
  };

  /** Sin tildes y en minúsculas, para comparar encabezados y claves. */
  function norm(text) {
    return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  const NEVER_IN_CV_RE = /nunca\s+va\s+en\s+(un\s+)?cv/i;
  const ESTIMATED_RE = /estimad[ao]/i;
  const NOISE_LINE_RE = /^(nodo:|verificable:|={3,}|-{3,}$)/i;

  /** Quita un frontmatter YAML inicial (`---\n…\n---`). */
  function stripFrontmatter(md) {
    return md.replace(/^---\n[\s\S]*?\n---\n?/, "");
  }

  /** Separa un .md en secciones de nivel 2 (`## `). Lo previo al primer `##` es preámbulo. */
  function splitSections(md) {
    const sections = [];
    let current = null;
    for (const line of stripFrontmatter(md.replace(/\r\n?/g, "\n")).split("\n")) {
      const h2 = line.match(/^##\s+(.+?)\s*$/);
      if (h2 && !line.startsWith("###")) {
        current = { heading: h2[1], lines: [] };
        sections.push(current);
      } else if (current) {
        current.lines.push(line);
      }
    }
    return sections;
  }

  /** "MAZA - SaaS de gestion (May 2024 - presente)" → { title, period }. */
  function parseHeading(heading) {
    const m = heading.match(/^(.*?)\s*\(([^()]*\d{4}[^()]*)\)\s*$/);
    return m ? { title: m[1].trim(), period: m[2].trim() } : { title: heading.trim(), period: "" };
  }

  /**
   * Logros de una sección: `- [id] Título` seguido de líneas indentadas
   * `clave: valor`. Una viñeta sin `[id]` también cuenta (título libre).
   */
  function parseAchievements(lines, stats = {}) {
    const achievements = [];
    let group = "";
    let current = null;

    for (const raw of lines) {
      const h3 = raw.match(/^###\s+(.+)/);
      if (h3) { group = h3[1].trim(); current = null; continue; }

      const bullet = raw.match(/^[-*]\s+(?:\[([^\]]+)\]\s*)?(.+)$/);
      if (bullet) {
        current = { id: bullet[1] || "", title: bullet[2].trim(), group, tec: "", metrica: "", contexto: "" };
        achievements.push(current);
        continue;
      }

      const kv = raw.match(/^\s+(tec|metrica|métrica|contexto|verificable):\s*(.*)$/i);
      if (kv && current) {
        const key = norm(kv[1]);
        if (key === "verificable") continue;
        let value = kv[2].trim();
        // Garantía determinista: una cifra ESTIMADA nunca sale de aquí.
        if (key === "metrica" && ESTIMATED_RE.test(value)) {
          value = "";
          stats.estimatedRemoved = (stats.estimatedRemoved || 0) + 1;
        }
        current[key] = value;
      }
    }
    return achievements;
  }

  /** Líneas "Clave: valor" de primer nivel (Rol, Estado, Nota, Nombre, …). */
  function parseKeyValues(lines) {
    const out = {};
    for (const line of lines) {
      const m = line.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ ]{2,40}):\s*(.+)$/);
      if (m) out[norm(m[1])] = m[2].trim();
    }
    return out;
  }

  /** Texto limpio de una sección (sin ruido de vault ni líneas vacías repetidas). */
  function cleanBody(lines) {
    return lines
      .filter(l => !NOISE_LINE_RE.test(l.trim()))
      .join("\n")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Interpreta uno o varios archivos .md. `sources`: [{ name, content }].
   * Las secciones de varios archivos se suman; lo especial (reglas,
   * identidad…) se concatena en orden.
   */
  /**
   * `vetoed`: términos que el usuario vetó en su vault (reglas.nunca_incluir
   * del postulador, p. ej. "Sistema de Postulaciones"). Una sección cuyo
   * título contenga uno se excluye igual que las marcadas "NUNCA va en un CV".
   */
  function parseMarkdownSources(sources, { vetoed = [] } = {}) {
    const vetoedNorm = vetoed.map(norm).filter(Boolean);
    const result = {
      rules: [], identity: {}, identityText: [], canonical: [], stack: [], education: [], other: [],
      sections: [], excludedSections: [], estimatedRemoved: 0
    };
    const stats = { estimatedRemoved: 0 };

    for (const source of sources || []) {
      if (!source || typeof source.content !== "string") continue;
      for (const section of splitSections(source.content)) {
        const key = norm(section.heading);
        const special = Object.keys(SPECIAL_SECTIONS).find(k => SPECIAL_SECTIONS[k].test(key));
        const body = cleanBody(section.lines);

        if (special === "identity") {
          Object.assign(result.identity, parseKeyValues(section.lines));
          result.identityText.push(body);
        } else if (special) {
          result[special].push(body);
        } else {
          const { title, period } = parseHeading(section.heading);
          const kv = parseKeyValues(section.lines);
          const entry = {
            title,
            period,
            role: kv.rol || "",
            status: kv.estado || "",
            achievements: parseAchievements(section.lines, stats),
            body,
            source: source.name || ""
          };
          const isVetoed = vetoedNorm.some(v => norm(title).includes(v));
          if (NEVER_IN_CV_RE.test(kv.nota || "") || isVetoed) result.excludedSections.push(title);
          else result.sections.push(entry);
        }
      }
    }
    result.estimatedRemoved = stats.estimatedRemoved;
    return result;
  }

  // ─── Relevancia a la oferta ──────────────────────────────────────────────

  /** Palabras vacías (es/en) que no dicen nada sobre el puesto. */
  const STOPWORDS = new Set((
    "de la el en y a los las del se por un una con para que es al lo como mas o su sus no si ya " +
    "tu te mi ti nos nuestro nuestra buscamos busca deseable experiencia ano anos trabajo equipo empresa " +
    "cargo puesto rol perfil requisitos conocimiento conocimientos manejo uso nivel sobre entre desde hasta " +
    "the and of to in for with on at by from or an be are is you your our we will as this that have has " +
    "experience years team role job work skills knowledge strong plus nice required requirements"
  ).split(" "));

  /**
   * Palabras significativas de la oferta: sin tildes, sin palabras vacías,
   * de 3+ letras (o siglas técnicas cortas como "ai", "ml", "bi", "go").
   */
  function jobKeywords(jobText) {
    const words = norm(jobText).split(/[^a-z0-9+#.]+/).map(w => w.replace(/^\.+|\.+$/g, ""));
    return [...new Set(words.filter(w => (w.length >= 3 || /^(ai|ml|bi|go|ui|ux|qa|js|ts)$/.test(w)) && !STOPWORDS.has(w)))];
  }

  /** Cuántas palabras de la oferta aparecen en un texto. */
  function keywordHits(text, keywords) {
    const normalized = ` ${norm(text).replace(/[^a-z0-9+#.]+/g, " ")} `;
    return keywords.filter(k => normalized.includes(` ${k} `)).length;
  }

  function achievementText(a) {
    return `${a.title} ${a.tec} ${a.metrica} ${a.contexto} ${a.group}`;
  }

  /** Relevancia de una sección a la oferta: palabras de la oferta presentes en ella. */
  function sectionRelevance(section, keywords) {
    if (!keywords.length) return 0;
    const text = [section.title, section.role, section.status, ...section.achievements.map(achievementText)].join(" ");
    return keywordHits(text, keywords);
  }

  function formatAchievement(a) {
    const details = [
      a.tec && `tec: ${a.tec}`,
      a.metrica && `métrica: ${a.metrica}`,
      a.contexto && `contexto: ${a.contexto}`
    ].filter(Boolean).join(" · ");
    return `- ${a.title}${details ? ` (${details})` : ""}`;
  }

  /**
   * Sección con detalle, limitada a los `maxAchievements` logros más
   * relevantes para la oferta (en su orden original). Una sección como MAZA
   * trae ~50 logros: enviarlos todos en cada pregunta es más lento y más
   * caro, y el modelo igual debe elegir uno o dos (regla 12 del prompt).
   */
  function formatSectionDetailed(section, keywords, maxAchievements) {
    const head = `### ${section.title}${section.period ? ` (${section.period})` : ""}`;
    const lines = [head];
    if (section.role) lines.push(`Rol: ${section.role}`);
    if (section.status) lines.push(`Estado: ${section.status}`);

    const chosen = new Set(
      section.achievements
        .map((a, index) => ({ index, score: keywordHits(achievementText(a), keywords) }))
        .sort((x, y) => y.score - x.score || x.index - y.index)
        .slice(0, maxAchievements)
        .map(x => x.index)
    );

    let group = null;
    section.achievements.forEach((a, index) => {
      if (!chosen.has(index)) return;
      if (a.group && a.group !== group) { group = a.group; lines.push(`[${group}]`); }
      lines.push(formatAchievement(a));
    });
    const omitted = section.achievements.length - chosen.size;
    if (omitted > 0) lines.push(`(+${omitted} logros más de esta experiencia, menos relacionados con esta oferta)`);
    return lines.join("\n");
  }

  /** Tecnologías declaradas en una sección (de las líneas `tec:`), para el resumen. */
  function sectionTerms(section) {
    const raw = section.achievements.map(a => a.tec).join(",");
    return [...new Set(raw.split(/[,;|]/).map(t => t.trim()).filter(t => t.length >= 2 && t.length <= 40))];
  }

  function formatSectionSummary(section) {
    const tech = sectionTerms(section).slice(0, 8).join(", ");
    return `- ${section.title}${section.period ? ` (${section.period})` : ""}${section.role ? ` — ${section.role}` : ""}${tech ? ` — ${tech}` : ""}`;
  }

  /**
   * Contexto del candidato para el prompt, a partir del Markdown.
   *
   * Las secciones se ordenan por relevancia a la OFERTA (no a la pregunta):
   * así el bloque es idéntico en todas las preguntas del mismo formulario y
   * la caché de Anthropic lo reutiliza — igual que el camino estructurado.
   * Las `maxDetailed` más relevantes van completas; el resto, en una línea
   * (no se niega experiencia que existe, solo se resume). Empate: se conserva
   * el orden del archivo, que el usuario ya escribe por importancia.
   */
  function buildMarkdownContext(parsed, jobText, { maxDetailed = 4, maxAchievements = 10, vetoed = [] } = {}) {
    const keywords = jobKeywords(jobText || "");
    const ranked = parsed.sections
      .map((section, index) => ({ section, index, score: sectionRelevance(section, keywords) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const detailed = ranked.slice(0, maxDetailed).map(r => formatSectionDetailed(r.section, keywords, maxAchievements));
    const rest = ranked.slice(maxDetailed).map(r => formatSectionSummary(r.section));

    const block = (title, parts) => (parts.length ? `--- ${title} ---\n${parts.join("\n\n")}` : "");
    return [
      block("REGLAS DEL CANDIDATO (escritas por él; OBLIGATORIAS en cada respuesta)", parsed.rules),
      vetoed.length ? `--- TÉRMINOS VETADOS POR EL CANDIDATO (NUNCA los escribas) ---\n${vetoed.join(", ")}` : "",
      block("IDENTIDAD", parsed.identityText),
      block("FRASES CANÓNICAS (úsalas tal cual cuando las cites)", parsed.canonical),
      block("EXPERIENCIA Y PROYECTOS MÁS RELEVANTES PARA ESTA OFERTA", detailed),
      rest.length ? `--- OTRA EXPERIENCIA (resumen) ---\n${rest.join("\n")}` : "",
      block("STACK TÉCNICO", parsed.stack),
      block("EDUCACIÓN Y CERTIFICACIONES", parsed.education),
      block("OTROS", parsed.other)
    ].filter(Boolean).join("\n\n");
  }

  // ─── Mapeo a los campos del perfil ───────────────────────────────────────

  const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
  const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;

  function asUrl(value) {
    const v = String(value || "").trim().split(/\s+/)[0];
    if (!v) return "";
    return /^https?:\/\//i.test(v) ? v : `https://${v}`;
  }

  /** Nivel de inglés del select de opciones, a partir del MCER que aparezca. */
  function englishLevelFrom(text) {
    const t = norm(text);
    if (!/ingles|english/.test(t)) return "";
    const m = t.match(/\b([abc][12])\b/);
    if (!m) return /nativ/.test(t) ? "Nativo / Bilingüe" : "";
    if (m[1].startsWith("a")) return "Básico (A1/A2)";
    if (m[1].startsWith("b")) return "Intermedio (B1/B2)";
    return "Avanzado / Fluido (C1/C2)";
  }

  /**
   * Nombre completo → partes, con la convención chilena de dos apellidos:
   * 4 palabras = nombre, segundo nombre, paterno, materno; 3 = nombre,
   * paterno, materno; 2 = nombre, apellido. Con más palabras (partículas,
   * nombres compuestos) no se adivina: solo se llena el nombre completo.
   */
  function splitFullName(fullName) {
    const words = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    const out = { fullName: words.join(" ") };
    if (words.length === 2) Object.assign(out, { firstName: words[0], lastName: words[1] });
    if (words.length === 3) Object.assign(out, { firstName: words[0], lastName: `${words[1]} ${words[2]}`, lastNamePaternal: words[1], lastNameMaternal: words[2] });
    if (words.length === 4) Object.assign(out, { firstName: words[0], middleName: words[1], lastName: `${words[2]} ${words[3]}`, lastNamePaternal: words[2], lastNameMaternal: words[3] });
    return out;
  }

  /**
   * Campos del formulario que se pueden completar desde el Markdown. Solo lo
   * que el archivo dice explícitamente: lo que no aparece no se devuelve (y
   * nunca se inventa un valor "plausible").
   */
  function markdownToProfileFields(parsed) {
    const id = parsed.identity;
    const fields = {};
    const set = (key, value) => { if (value && String(value).trim()) fields[key] = String(value).trim(); };

    Object.assign(fields, id.nombre ? splitFullName(id.nombre) : {});
    const contact = [id.contacto, id.email, id.correo, id.telefono].filter(Boolean).join(" ");
    set("email", (contact.match(EMAIL_RE) || [])[0]);
    set("phone", (contact.match(PHONE_RE) || [])[0]);
    set("linkedinUrl", id.linkedin && asUrl(id.linkedin));
    set("githubUrl", id.github && asUrl(id.github));
    set("portfolioUrl", (id.portafolio || id.portfolio || id.web) && asUrl(id.portafolio || id.portfolio || id.web));
    set("englishLevel", englishLevelFrom(id.idiomas || id.idioma || ""));
    set("noticePeriod", id.disponibilidad && id.disponibilidad.split(/[.;]/)[0]);

    if (id.ubicacion) {
      const firstPlace = id.ubicacion.split("/")[0].trim();
      const parts = firstPlace.split(",").map(p => p.trim()).filter(Boolean);
      if (parts.length) set("city", parts[parts.length - 1] === "Chile" ? parts[parts.length - 2] : parts[parts.length - 1]);
      if (/chile/i.test(id.ubicacion)) set("country", "Chile");
    }

    // Stack: todas las líneas "Categoría: a, b, c" de la sección de stack.
    const skills = parsed.stack.join("\n").split("\n")
      .map(l => (l.match(/^[^:]{2,40}:\s*(.+)$/) || [])[1])
      .filter(Boolean);
    set("skills", skills.join(", "));

    // Estudios: "Carrera | Institución (período)".
    const eduLine = parsed.education.join("\n").split("\n").find(l => l.includes("|"));
    if (eduLine) {
      const [degree, rest] = eduLine.split("|").map(s => s.trim());
      set("degree", degree);
      set("university", (rest || "").replace(/\s*\([^)]*\)\s*$/, ""));
    } else if (id.titulo) {
      set("degree", id.titulo);
    }

    return fields;
  }

  /**
   * `cvDatabase` equivalente (cargos con logros y tecnologías), para que lo
   * que ya existe — ranking por oferta, cobertura de requisitos, la
   * verificación de "hay datos reales" — funcione igual con el Markdown.
   */
  function markdownToCvDatabase(parsed, rawText) {
    return {
      rawText: rawText || "",
      parsedAt: new Date().toISOString(),
      experiences: parsed.sections.map((s, i) => ({
        id: `md_${i + 1}`,
        company: s.title,
        role: s.role,
        period: s.period,
        description: s.status,
        achievements: s.achievements.map(a => `${a.title}${a.metrica ? ` (${a.metrica})` : ""}`).join("; "),
        technologies: sectionTerms(s).join(", ")
      })),
      projects: [],
      education: []
    };
  }

  /** Resumen para mostrarle al usuario qué se entendió del archivo. */
  function summarizeParsed(parsed) {
    return {
      sections: parsed.sections.length,
      achievements: parsed.sections.reduce((n, s) => n + s.achievements.length, 0),
      hasRules: parsed.rules.length > 0,
      excluded: parsed.excludedSections,
      estimatedMetricsRemoved: parsed.estimatedRemoved
    };
  }

  /** Términos vetados que aparecen en un texto (sin tildes ni mayúsculas). */
  function findVetoedTerms(text, vetoed = []) {
    const t = norm(text);
    return vetoed.filter(v => v && t.includes(norm(v)));
  }

  root.JobFillMarkdown = {
    findVetoedTerms,
    parseMarkdownSources,
    buildMarkdownContext,
    markdownToProfileFields,
    markdownToCvDatabase,
    summarizeParsed,
    jobKeywords,
    splitFullName,
    englishLevelFrom
  };
})(typeof self !== "undefined" ? self : globalThis);
