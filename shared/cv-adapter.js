/**
 * JobFill AI - Adaptación del CV a la oferta ("Postular en 1 flujo").
 *
 * Es el MISMO proceso del artefacto Postulador (rdf-grafo/postulador/index.html),
 * portado para correr en la página de la oferta: ahí JobFill ya tiene la
 * empresa, el cargo y la descripción completa en tiempo real, sin copiar y
 * pegar. Un CV debe salir igual se genere desde claude.ai o desde aquí, así
 * que los prompts, las reglas de respaldo y el nombre del PDF son copia fiel
 * de los del artefacto. Si cambian allá, hay que cambiarlos aquí.
 *
 * Solo funciones puras (prompts, parseo, nombres): la orquestación con red
 * (MCP + IA) vive en el service worker. Script clásico, igual que el resto
 * de shared/.
 */
(function (root) {
  "use strict";

  /**
   * Respaldo de las reglas de redacción cuando el vault no tiene
   * cv/instrucciones.md. Copia literal de REGLAS en postulador/index.html:
   * {TITULO}, {FECHAS} y {VETOS} se reemplazan con las reglas del vault.
   */
  const REGLAS_RESPALDO = `REGLAS (obligatorias, vienen de la BASE de Rafa):
- Solo hechos de la BASE. Selecciona logros por su id. Nunca inventes métricas; una métrica vacía no recibe número.
- Una métrica marcada ESTIMADA no se imprime: se omite el número. La palabra ESTIMADA nunca aparece.
- Certificaciones en curso: "en curso" o "en preparación", NUNCA con fecha de verificación.
- MedInfo NUNCA se omite en un CV de IA. El Sistema de postulaciones NUNCA va en un CV.
- Cadena canónica de MAZA, literal y como oración aparte: "en pruebas cerradas para Google Play (vX), con 14 talleres y ~100 vehículos en uso real. Volumen procesado: 561 órdenes y 2.605 cambios de estado." (copia la versión exacta del CV base). En un CV de Datos/BI se omite la oración del volumen porque va el logro maza-data-vol-01.
- Título profesional LITERAL, carácter por carácter: "{TITULO}". Nunca cambies su género ni su terminación (NO "Informático"), ni lo abrevies ("Ing."). En Educación el grado se escribe como en el CV base.
- Fechas fijas (no las cambies): {FECHAS}. Textos vetados: {VETOS}.
- Formato EXACTO (Markdown): frontmatter con titulo; luego EXACTAMENTE 4 secciones en este orden:
  "## RESUMEN PROFESIONAL" (un párrafo de máximo ~450 caracteres = 4 líneas),
  "## HABILIDADES TÉCNICAS" (viñetas "- **Categoría:** …"),
  "## EXPERIENCIA PROFESIONAL" (título estándar: los ATS lo reconocen; el área de la oferta ya va en el subtítulo),
  "## EDUCACIÓN Y CERTIFICACIONES".
  Cada experiencia: "### Cargo | Empresa (Mes Año – Mes Año|Presente)" y viñetas "- **Etiqueta:** Verbo + tecnología exacta + resultado.".
- Máximo 8 viñetas de experiencia en total. Para acortar se BORRAN viñetas, nunca se agregan.
- El titulo (subtítulo bajo el nombre) = "{TITULO} | <cargo exacto de la oferta, copiado tal cual> (<3-4 tecnologías centrales de la oferta que la BASE respalde>)".
- Palabras clave (así puntúan los ATS: coincidencia literal): usa la forma EXACTA de la oferta cuando la BASE la respalda (si dice "APIs REST", no "servicios RESTful"); nombra las herramientas requeridas de la oferta en HABILIDADES y también dentro de una viñeta de experiencia que las use; siglas expandidas una vez ("Inteligencia Artificial (IA)"); términos centrales también en inglés una vez. Nada de relleno ni términos que la BASE no respalde.
- Viñetas: empiezan con verbo en pasado ("Desarrollé", "Implementé") y, cuando la BASE tiene la cifra, incluyen el número. Sin tablas, emojis ni símbolos decorativos.`;

  /** Límites de texto de la oferta, iguales a los del artefacto. */
  const OFERTA_MAX_PERFIL = 6000;
  const OFERTA_MAX_ADAPTAR = 9000;

  /** Reglas con los datos del vault (instrucciones.md si existe; si no, el respaldo). */
  function reglasCon(ctx) {
    const reglas = ctx?.reglas || {};
    return String(ctx?.instrucciones || REGLAS_RESPALDO)
      .replaceAll("{TITULO}", reglas.titulo_profesional || "Ingeniero en Informática")
      .replaceAll("{FECHAS}", Object.entries(reglas.fechas_fijas || {}).map(([k, v]) => `${k} desde ${v}`).join("; "))
      .replaceAll("{VETOS}", (reglas.nunca_incluir || []).join(", "));
  }

  /** Título de un CV base (del frontmatter `titulo: "…"`). */
  function tituloDePerfil(markdown) {
    return ((String(markdown || "").match(/^titulo:\s*"?([^"\n]+?)"?\s*$/m) || [])[1] || "").trim();
  }

  function buildProfilePickPrompt(perfiles, oferta) {
    const opciones = perfiles.map(p => `- ${p.perfil}: ${tituloDePerfil(p.markdown)}`).join("\n");
    return `Elige el CV base que mejor calza con esta oferta. Opciones:\n${opciones}\n\nResponde solo JSON: {"perfil": "<nombre exacto de la opción>"}\n\nOFERTA:\n${String(oferta).slice(0, OFERTA_MAX_PERFIL)}`;
  }

  /** Perfil elegido por el modelo, o el primero si respondió algo que no existe. */
  function resolvePerfil(perfiles, respuesta) {
    return perfiles.find(p => p.perfil === respuesta?.perfil)?.perfil || perfiles[0]?.perfil;
  }

  /**
   * Bloque ESTABLE (rol + REGLAS + BASE) que va como `system` con
   * cache_control: es idéntico en adaptar, ajustar y pedir cambio, y entre
   * ofertas, así que desde la segunda llamada se lee de caché (~10% del
   * costo y no cuenta para el límite de tokens por minuto de Claude). Con
   * `{ cached: true }` los prompts de abajo no lo repiten.
   */
  function buildCvSystem(ctx) {
    return `Eres el asistente de CVs de Rafa. La BASE DE EXPERIENCIA es la única fuente de hechos: nunca inventes nada que no esté ahí.

${reglasCon(ctx)}

=== BASE DE EXPERIENCIA ===
${ctx.base}`;
  }

  function buildAdaptPrompt(ctx, perfil, oferta, { cached = false } = {}) {
    const base = ctx.perfiles.find(p => p.perfil === perfil)?.markdown || "";
    return `Eres el asistente de CVs de Rafa. Adapta su CV base "${perfil}" a la OFERTA, usando la BASE de experiencia como única fuente de hechos.
${cached ? "" : `
${reglasCon(ctx)}
`}
Responde SOLO JSON con esta forma:
{"empresa": "...", "cargo": "cargo exacto de la oferta", "area": "área corta", "markdown": "el CV completo en el formato exacto", "keywords_oferta": ["..."], "keywords_cubiertas": ["..."], "keywords_faltantes": ["términos pedidos que la BASE no respalda"]}

=== CV BASE (${perfil}) ===
${base}
${cached ? "" : `
=== BASE DE EXPERIENCIA ===
${ctx.base}
`}
=== OFERTA ===
${String(oferta).slice(0, OFERTA_MAX_ADAPTAR)}`;
  }

  /** Corrección mínima a partir de los hallazgos del verificador (cv_validar). */
  function buildFixPrompt(ctx, markdown, validacion, { cached = false } = {}) {
    const v = validacion || {};
    return `Corrige este CV para que pase TODAS las reglas y quepa en 1 página, cambiando lo mínimo. Problemas detectados por el verificador:
${(v.hallazgos || []).map(h => "- " + h.detalle).join("\n")}
${v.lineasDeMas > 0 ? `Sobran ~${v.lineasDeMas} líneas: borra viñetas de menor relevancia para la oferta (nunca agregues).` : ""}
${v.lineasResumen > 4 ? "Acorta el Resumen a 4 líneas (~450 caracteres) manteniendo la cadena canónica literal." : ""}
${cached ? "" : `
${reglasCon(ctx)}
`}
Responde SOLO JSON: {"markdown": "el CV corregido completo"}

=== CV ===
${markdown}`;
  }

  /**
   * Repara sin IA lo estructural que el modelo a veces rompe y que el
   * postulador rechaza de plano. El Worker (rdf-grafo/cv/src/parse.ts) lee el
   * frontmatter con gray-matter (YAML) y exige `titulo` como texto; falla con
   * "El CV necesita titulo en el frontmatter" si falta, pero también si el
   * YAML no es válido (comillas dentro de comillas, ": " sin comillas) o si
   * el CV llegó con "\n" literales. Por eso el frontmatter se REESCRIBE
   * siempre desde cero, con el titulo como string JSON (YAML válido), en vez
   * de confiar en el que escribió el modelo:
   *   - "\n" literales → saltos de línea reales (si no hay ninguno real),
   *   - quita un bloque ``` que envuelva el CV y el texto previo al CV,
   *   - titulo: el del modelo (`titulo:`/`title:`, con o sin comillas) o,
   *     si no hay, `tituloRespaldo` (titulo del CV anterior o "{TITULO} | <cargo>"),
   *   - `perfil`, si venía, se conserva.
   * El cuerpo (secciones, viñetas) no se toca: eso lo juzga el verificador.
   */
  function normalizeCvMarkdown(markdown, tituloRespaldo) {
    let md = String(markdown || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!md.includes("\n") && md.includes("\\n")) md = md.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    md = md.trim();
    const fenced = md.match(/```(?:markdown|md|yaml)?\n([\s\S]*?)\n```/i);
    if (fenced && fenced[1].includes("## ")) md = fenced[1].trim();

    // Frontmatter del modelo (puede venir después de un texto de cortesía).
    let head = "";
    let body = md;
    const fm = md.match(/(?:^|\n)---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (fm && (fm.index === 0 || !md.slice(0, fm.index).includes("## "))) {
      head = fm[1];
      body = md.slice(fm.index + fm[0].length);
    }
    // Lo que venga antes de la primera sección no es CV ("Aquí está tu CV:").
    const firstSection = body.search(/^## /m);
    if (firstSection > 0) body = body.slice(firstSection);
    body = body.trim();

    const field = key => {
      const m = head.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, "mi"));
      if (!m) return "";
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v.replace(/\\"/g, '"').replace(/''/g, "'").trim();
    };
    const titulo = field("titulo") || field("title") || String(tituloRespaldo || "").trim();
    const perfil = field("perfil");

    if (!titulo) return body;
    const lines = [`titulo: ${JSON.stringify(titulo)}`];
    if (perfil) lines.push(`perfil: ${JSON.stringify(perfil)}`);
    return `---\n${lines.join("\n")}\n---\n${body}`;
  }

  /**
   * Hallazgos a partir del rechazo de cv_generar_pdf del Worker, que ya
   * verifica reglas y 1 página: "Error: No se genera: A · B" o
   * "No se genera: ocupa 2 páginas (sobran ~3 líneas)".
   */
  function hallazgosDeRechazo(message) {
    const text = String(message || "").replace(/^\s*Error:\s*/i, "").replace(/^\s*No se genera:\s*/i, "").trim();
    const partes = text.split(/\s+·\s+/).map(t => t.trim()).filter(Boolean);
    const sobran = text.match(/sobran\s*~?\s*(\d+(?:[.,]\d+)?)\s*l[ií]neas/i);
    return {
      ok: false,
      hallazgos: (partes.length ? partes : [text || "El postulador rechazó el CV."]).map(detalle => ({ nivel: "error", detalle })),
      lineasDeMas: sobran ? Math.ceil(Number(sobran[1].replace(",", "."))) : 0
    };
  }

  const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inlineMd = s => escHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  /**
   * Vista previa del CONTENIDO sin abrir un navegador en Cloudflare: la
   * misma estructura y CSS que renderHtml del Worker (rdf-grafo/cv/src/
   * render.ts), con el encabezado desde "Mis datos". El PDF exacto se abre
   * aparte. Tolerante: lo que el Worker rechazaría se muestra igual.
   */
  function renderCvPreviewHtml(markdown, header = {}) {
    const md = String(markdown || "");
    const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
    const titulo = fm ? tituloDePerfil(fm[0]) : "";
    const body = fm ? md.slice(fm[0].length) : md;
    let html = "";
    let list = false;
    const closeList = () => { if (list) { html += "</ul>"; list = false; } };
    let open = false;
    for (const raw of body.split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      if (line.startsWith("## ")) { closeList(); if (open) html += "</section>"; html += `<section><h2>${inlineMd(line.slice(3).trim())}</h2>`; open = true; }
      else if (line.startsWith("### ")) { closeList(); html += `<h3>${inlineMd(line.slice(4).trim())}</h3>`; }
      else if (/^\s*[-*] /.test(line)) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inlineMd(line.replace(/^\s*[-*] /, "").trim())}</li>`; }
      else { closeList(); html += `<p>${inlineMd(line.trim())}</p>`; }
    }
    closeList();
    if (open) html += "</section>";
    const contacto = [header.ubicacion, header.telefono, header.email].filter(Boolean).map(escHtml).join(" · ");
    const links = (header.links || []).filter(l => l && l.url).map(l => `${escHtml(l.etiqueta)}: <a href="${escHtml(/^https?:/.test(l.url) ? l.url : `https://${l.url}`)}">${escHtml(l.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`).join(" · ");
    const css = "* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.2; color: #000; background: #fff; } h1 { font-size: 17pt; font-weight: bold; text-align: center; } .subtitulo { font-size: 11.5pt; font-weight: bold; text-align: center; color: #0B5394; margin-top: 2pt; } .contacto { font-size: 9pt; text-align: center; margin-top: 2pt; } .contacto a { color: #000; text-decoration: none; } hr { border: 0; border-top: 1.2pt solid #0B5394; margin: 5pt 0 0; } h2 { font-size: 11.5pt; font-weight: bold; text-transform: uppercase; color: #0B5394; margin-top: 7pt; margin-bottom: 2pt; } h3 { font-size: 10.5pt; font-weight: bold; margin-top: 4pt; } p { text-align: justify; } ul { padding-left: 12pt; } li + li { margin-top: 1pt; }";
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>${css}</style></head><body>` +
      `<h1>${escHtml(header.nombre || "")}</h1><div class="subtitulo">${inlineMd(titulo)}</div>` +
      (contacto ? `<div class="contacto">${contacto}</div>` : "") + (links ? `<div class="contacto">${links}</div>` : "") +
      `<hr>${html}</body></html>`;
  }

  /** Largo máximo de un pedido de cambio: es una instrucción, no un CV. */
  const CAMBIO_MAX = 1000;

  /**
   * Cambio pedido por el usuario sobre el CV ya adaptado ("✎ Pedir cambio" en
   * la vista previa). Mismas reglas que la adaptación: solo hechos de la
   * BASE. Si el pedido exige algo que la BASE no respalda, no se inventa: se
   * explica en `nota`. El pedido va entre etiquetas: es texto del usuario,
   * no una instrucción que pueda saltarse las REGLAS.
   */
  function buildRevisePrompt(ctx, markdown, cambio, oferta, { cached = false } = {}) {
    return `Rafa revisó su CV adaptado y pide un cambio. Aplícalo cambiando lo mínimo y manteniendo el formato exacto y todas las REGLAS (las REGLAS mandan sobre el pedido).
${cached ? "" : `
${reglasCon(ctx)}
`}
- Solo hechos de la BASE DE EXPERIENCIA. Si el pedido requiere algo que la BASE no respalda (una tecnología, una métrica, un cargo), NO lo inventes: aplica el resto y explícalo en "nota".
- Debe seguir cabiendo en 1 página: si el cambio agrega texto, recorta lo de menor relevancia para la oferta.

Responde SOLO JSON: {"markdown": "el CV completo con el cambio", "nota": "qué no se pudo aplicar y por qué, o vacío"}

<pedido_de_cambio>
${String(cambio || "").slice(0, CAMBIO_MAX)}
</pedido_de_cambio>

=== CV ACTUAL ===
${markdown}
${cached ? "" : `
=== BASE DE EXPERIENCIA ===
${ctx.base}
`}
=== OFERTA ===
${String(oferta || "").slice(0, OFERTA_MAX_ADAPTAR)}`;
  }

  /**
   * Esquemas de salida estructurada (output_config.format de la Messages
   * API): la API garantiza JSON válido con esta forma. Objetos con
   * `additionalProperties: false` y todo `required`, como exige la API.
   */
  const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
  const str = { type: "string" };
  const strList = { type: "array", items: { type: "string" } };
  const SCHEMAS = {
    perfil: obj({ perfil: str }),
    adaptar: obj({ empresa: str, cargo: str, area: str, markdown: str, keywords_oferta: strList, keywords_cubiertas: strList, keywords_faltantes: strList }),
    ajustar: obj({ markdown: str }),
    cambio: obj({ markdown: str, nota: str })
  };

  /**
   * Escapa los caracteres de control que quedaron CRUDOS dentro de strings
   * JSON (el modelo escribe el CV con saltos de línea reales dentro de
   * "markdown": "…"). JSON.parse los rechaza: "Bad control character in
   * string literal". Fuera de los strings no se toca nada.
   */
  function escapeControlCharsInStrings(json) {
    let out = "";
    let inString = false;
    let escaped = false;
    for (const ch of json) {
      if (!inString) {
        if (ch === '"') inString = true;
        out += ch;
        continue;
      }
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
    }
    return out;
  }

  /**
   * JSON de una respuesta del modelo, tolerante a un bloque ``` o a texto
   * alrededor (se toma del primer `{` al último `}`) y a caracteres de
   * control crudos dentro de los strings. Con salida estructurada no debería
   * hacer falta; es la red para el respaldo y para respuestas antiguas.
   */
  function parseJsonReply(text) {
    const raw = String(text || "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("La IA no devolvió JSON (respuesta vacía o cortada). Pulsa Reintentar.");
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (e) {
      try {
        return JSON.parse(escapeControlCharsInStrings(slice));
      } catch (e2) {
        const err = new Error(`La IA devolvió un JSON mal formado (${e2.message}). Pulsa Reintentar.`);
        err.badJson = true;
        throw err;
      }
    }
  }

  /** Fecha AAAA-MM-DD en Chile, igual que `hoy()` del artefacto. */
  function hoy(d = new Date()) {
    return d.toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
  }

  function slug(s) {
    return String(s || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  }

  /** Mismo nombre que genera el artefacto: CV_RDF_<Empresa>_<Cargo>_<AAAAMMDD>. */
  function pdfFileName({ empresa, cargo, perfil }, date = new Date()) {
    return `CV_RDF_${slug(empresa || "Empresa")}_${slug(cargo || perfil)}_${hoy(date).replaceAll("-", "")}`;
  }

  /** Cobertura para el Tracker, con el mismo formato que registra el artefacto. */
  function coberturaTexto(brechas, keywordsCubiertas) {
    const RESPALDADAS = ["demostrada", "declarada", "mencionada"];
    if (brechas && Array.isArray(brechas.requisitos)) {
      const ok = brechas.requisitos.filter(q => RESPALDADAS.includes(q.nivel)).map(q => q.termino);
      const total = brechas.cobertura?.total ?? brechas.requisitos.length;
      const respaldadas = brechas.cobertura?.respaldadas ?? ok.length;
      return total ? `${Math.round((respaldadas / total) * 100)}% (${ok.join(", ")})` : undefined;
    }
    const kw = (keywordsCubiertas || []).filter(Boolean);
    return kw.length ? `${kw.join(", ")} [estimada]` : undefined;
  }

  root.JobFillCv = {
    REGLAS_RESPALDO,
    reglasCon,
    buildProfilePickPrompt,
    resolvePerfil,
    buildAdaptPrompt,
    buildFixPrompt,
    CAMBIO_MAX,
    buildRevisePrompt,
    normalizeCvMarkdown,
    SCHEMAS,
    escapeControlCharsInStrings,
    buildCvSystem,
    hallazgosDeRechazo,
    renderCvPreviewHtml,
    tituloDePerfil,
    parseJsonReply,
    hoy,
    slug,
    pdfFileName,
    coberturaTexto
  };
})(typeof self !== "undefined" ? self : globalThis);
