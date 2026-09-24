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
    return (String(markdown || "").match(/titulo:\s*"([^"]+)"/) || [])[1] || "";
  }

  function buildProfilePickPrompt(perfiles, oferta) {
    const opciones = perfiles.map(p => `- ${p.perfil}: ${tituloDePerfil(p.markdown)}`).join("\n");
    return `Elige el CV base que mejor calza con esta oferta. Opciones:\n${opciones}\n\nResponde solo JSON: {"perfil": "<nombre exacto de la opción>"}\n\nOFERTA:\n${String(oferta).slice(0, OFERTA_MAX_PERFIL)}`;
  }

  /** Perfil elegido por el modelo, o el primero si respondió algo que no existe. */
  function resolvePerfil(perfiles, respuesta) {
    return perfiles.find(p => p.perfil === respuesta?.perfil)?.perfil || perfiles[0]?.perfil;
  }

  function buildAdaptPrompt(ctx, perfil, oferta) {
    const base = ctx.perfiles.find(p => p.perfil === perfil)?.markdown || "";
    return `Eres el asistente de CVs de Rafa. Adapta su CV base "${perfil}" a la OFERTA, usando la BASE de experiencia como única fuente de hechos.

${reglasCon(ctx)}

Responde SOLO JSON con esta forma:
{"empresa": "...", "cargo": "cargo exacto de la oferta", "area": "área corta", "markdown": "el CV completo en el formato exacto", "keywords_oferta": ["..."], "keywords_cubiertas": ["..."], "keywords_faltantes": ["términos pedidos que la BASE no respalda"]}

=== CV BASE (${perfil}) ===
${base}

=== BASE DE EXPERIENCIA ===
${ctx.base}

=== OFERTA ===
${String(oferta).slice(0, OFERTA_MAX_ADAPTAR)}`;
  }

  /** Corrección mínima a partir de los hallazgos del verificador (cv_validar). */
  function buildFixPrompt(ctx, markdown, validacion) {
    const v = validacion || {};
    return `Corrige este CV para que pase TODAS las reglas y quepa en 1 página, cambiando lo mínimo. Problemas detectados por el verificador:
${(v.hallazgos || []).map(h => "- " + h.detalle).join("\n")}
${v.lineasDeMas > 0 ? `Sobran ~${v.lineasDeMas} líneas: borra viñetas de menor relevancia para la oferta (nunca agregues).` : ""}
${v.lineasResumen > 4 ? "Acorta el Resumen a 4 líneas (~450 caracteres) manteniendo la cadena canónica literal." : ""}

${reglasCon(ctx)}

Responde SOLO JSON: {"markdown": "el CV corregido completo"}

=== CV ===
${markdown}`;
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
  function buildRevisePrompt(ctx, markdown, cambio, oferta) {
    return `Rafa revisó su CV adaptado y pide un cambio. Aplícalo cambiando lo mínimo y manteniendo el formato exacto y todas las REGLAS (las REGLAS mandan sobre el pedido).

${reglasCon(ctx)}

- Solo hechos de la BASE DE EXPERIENCIA. Si el pedido requiere algo que la BASE no respalda (una tecnología, una métrica, un cargo), NO lo inventes: aplica el resto y explícalo en "nota".
- Debe seguir cabiendo en 1 página: si el cambio agrega texto, recorta lo de menor relevancia para la oferta.

Responde SOLO JSON: {"markdown": "el CV completo con el cambio", "nota": "qué no se pudo aplicar y por qué, o vacío"}

<pedido_de_cambio>
${String(cambio || "").slice(0, CAMBIO_MAX)}
</pedido_de_cambio>

=== CV ACTUAL ===
${markdown}

=== BASE DE EXPERIENCIA ===
${ctx.base}

=== OFERTA ===
${String(oferta || "").slice(0, OFERTA_MAX_ADAPTAR)}`;
  }

  /**
   * JSON de una respuesta del modelo, tolerante a un bloque ``` o a texto
   * alrededor: se toma del primer `{` al último `}`.
   */
  function parseJsonReply(text) {
    const raw = String(text || "").replace(/```(?:json)?/gi, "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("La IA no devolvió JSON.");
    return JSON.parse(raw.slice(start, end + 1));
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
    parseJsonReply,
    hoy,
    slug,
    pdfFileName,
    coberturaTexto
  };
})(typeof self !== "undefined" ? self : globalThis);
