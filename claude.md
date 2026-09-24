# ⚡ JobFill AI - Extensión para Auto-rellenar Formularios de Empleo

Extensión de navegador (Manifest V3) para Chrome, Edge y Brave que guarda tus datos profesionales de forma 100% segura y local, rellenando formularios de postulación laboral con un solo clic y redactando respuestas a preguntas abiertas usando **Claude IA (Anthropic)**.

---

## 🚀 Pasos para Instalar la Extensión en tu Navegador (Chrome / Edge / Brave)

1. Abre tu navegador y ve a la página de extensiones:
   - **En Google Chrome / Brave:** Escribe en la barra de direcciones `chrome://extensions`
   - **En Microsoft Edge:** Escribe en la barra de direcciones `edge://extensions`
2. Activa el interruptor **"Modo de desarrollador"** (ubicado en la esquina superior derecha).
3. Haz clic en el botón **"Cargar descomprimida"** (o *"Load unpacked"*).
4. Selecciona la carpeta donde está la extensión:
   ```
   C:\Proyectos IT\jobfill-ai-extension
   ```
5. ¡Listo! Verás el icono de **JobFill AI** ⚡ en la barra de herramientas de tu navegador. (Te sugerimos fijar el icono en la barra de extensiones).

---

## ⚙️ Configuración Inicial

Abre el icono de **JobFill AI** → ⚙️. La sección **🏠 Inicio** muestra los 3 pasos y cuáles faltan. Todo se **guarda solo** mientras escribes (o con Ctrl+S).

1. **📚 Fuente de verdad:** lo ideal es **🔗 Conectar con tu vault**: pega la URL de tu postulador (`https://postulador-mcp.<cuenta>.workers.dev`) y entra con GitHub. La BASE se sincroniza sola (al abrir opciones si tiene más de 30 min y al iniciar el navegador si tiene más de 6 h), con tus reglas `nunca_incluir` del vault. JobFill **nunca escribe tu BASE**: el postulador solo le permite leerla. También puedes arrastrar tus archivos **.md** a mano. En ambos casos se leen al instante y sin IA:
   - Las **REGLAS DE USO** del archivo se aplican literalmente en cada respuesta.
   - Las métricas marcadas **ESTIMADA** y las secciones con `Nota: … NUNCA va en un CV` nunca se envían a la IA.
   - Para cada oferta se envían solo las experiencias y logros más relevantes (más rápido y más barato).
   - "Completar Mis datos" llena los campos vacíos (nombre, contacto, links, stack, estudios) desde el archivo.
   - Para actualizar, vuelve a importar el mismo archivo. ¿Sin .md? Hay una opción plegada para usar un CV en PDF o texto.
2. **🤖 Inteligencia artificial:** pega tu **Anthropic API Key** (`sk-ant-...`). Opcional: una **API Key de Vertex AI** (`AQ.…`) para que **Gemini responda si Claude se queda sin saldo**. *"⚡ Probar Conexión"* prueba cada proveedor por separado.
3. **👤 Mis datos:** revisa contacto, renta, disponibilidad y la sección legal. Las preguntas legales empiezan **sin responder**: solo se rellenan si tú eliges una opción.

Con el vault conectado, el panel flotante suma dos botones:

- **🚀 Postular**: todo el Postulador sin salir del portal. Lee la oferta de la página en tiempo real, elige tu CV base, lo adapta con tus instrucciones del vault (`cv/instrucciones.md`), genera el PDF con tu postulador, que **al generarlo verifica** reglas y 1 página (un solo navegador en Cloudflare; si lo rechaza, un ajuste automático y se genera de nuevo, con una pausa de 20 s entre generaciones para no saturarlo) y **te muestra la vista previa** del contenido (con opción de abrir o descargar el PDF exacto). Las REGLAS y la BASE van a Claude en un bloque cacheado: desde la segunda llamada cuestan ~10% y no cuentan para el límite por minuto. Desde ahí puedes **✎ Pedir cambio** (se aplica solo con hechos de tu BASE, vuelve a pasar por el verificador y genera otro PDF). Solo cuando confirmas con "✓ Se ve bien", **lo adjunta al campo del CV** del formulario y autorrellena el resto. Si Claude responde que se alcanzó el límite por minuto, espera y reintenta solo; si aun así falla, **↻ Reintentar** retoma desde el paso que falló sin volver a adaptar. Al final muestra la cobertura según tu grafo y te deja registrar la postulación con el CV usado. Si el CV no pasa el verificador, no se genera PDF ni se toca el formulario.
- **📌 Registrar**: registra la postulación en el Tracker sin adaptar el CV.

El registro en el Tracker siempre pide confirmación: nunca es automático.

**🚀 Postular** funciona en la mayoría de los portales. Encuentra el formulario aunque esté dentro de un iframe (Greenhouse, Workable, iCIMS o Indeed embebidos en el sitio de la empresa) o en Shadow DOM (SuccessFactors, SmartRecruiters). Reconoce el campo del CV por los selectores de cada ATS (Greenhouse, Lever, Workday, Ashby, LinkedIn, Workable, Teamtailor y otros), por el nombre del campo o por su etiqueta. Si el portal solo ofrece una zona de "arrastra tu CV", suelta el archivo ahí. En formularios de varios pasos (LinkedIn Easy Apply, Workday, Taleo), si el campo del CV todavía no aparece, el PDF queda **pendiente** y se adjunta solo al llegar a ese paso (misma pestaña, 30 min). Si no está seguro de cuál es el campo del CV, no adjunta nada y te deja el botón de descarga.

Extras: **💬 Respuestas guardadas** (Q&A y campos flexibles), **🎯 Perfiles de CV** (facetas con palabras clave, opcional) y **💾 Respaldo**.

> **Apagar la extensión:** el interruptor del popup (o el botón ⏻ del panel flotante) la desactiva en todas las páginas al instante; el ícono muestra "OFF" mientras esté apagada.

---

## 🧪 Cómo Probar la Extensión

1. Abre el archivo de prueba incluido en tu navegador:
   ```
   C:\Proyectos IT\jobfill-ai-extension\test-form.html
   ```
2. Verás un formulario típico de postulación.
3. Puedes rellenarlo de dos formas:
   - **Opción A:** Pulsando el botón flotante morado **"⚡ JobFill AI"** en la esquina inferior derecha.
   - **Opción B:** Abriendo el icono de la extensión y pulsando **"Auto-Rellenar Formulario"**.
4. Para las preguntas abiertas de texto largo, haz clic en el recuadro de texto y pulsa el botón **"✨ Redactar con Claude IA"** para que genere una respuesta adaptada en segundos.

---

## 🔒 Privacidad y Seguridad

- **100% Local:** Tus datos personales nunca se envían a ningún servidor intermedio; residen en el almacenamiento local de tu navegador (`chrome.storage.local`). Ojo: ese almacenamiento **no está cifrado**; la API key queda legible para quien tenga acceso a tu perfil del navegador.
- **Respaldos sin credenciales:** el JSON de "Exportar Perfil" no incluye tus API keys, y al importar un respaldo se conservan las que ya tengas configuradas.
- **Llamadas directas a Claude:** Las solicitudes de redacción viajan directamente (HTTPS) desde tu navegador a Anthropic (`api.anthropic.com`) o a Google Cloud (`aiplatform.googleapis.com`, Gemini) según el proveedor elegido o el respaldo. Toda la lógica de llamada vive en `shared/ai-client.js`.

---

## 🛠️ Desarrollo

- `npm test` corre la suite completa (sin dependencias). Carga el código **real** de la extensión (nunca copias) y verifica la sintaxis de cada script. GitHub Actions la corre en cada push (`.github/workflows/ci.yml`).
- `shared/vault-client.js` es el cliente OAuth 2.1 (registro dinámico + PKCE con `chrome.identity`) y MCP (Streamable HTTP) del postulador (`rdf-grafo/postulador-mcp`). El token del vault no sale en los respaldos ni llega a las páginas.
- `content/portals.js` concentra lo específico de cada portal: selectores del CV por ATS, puntaje de "¿es el campo del CV?", búsqueda en Shadow DOM y elección del frame. El content script corre con `all_frames`: el widget y la orquestación viven solo en el frame principal, y el service worker llama a la API `JobFillFrame` de cada frame con `chrome.scripting.executeScript` (mismo mundo aislado).
- `shared/ai-client.js` es el único cliente de IA (Claude + respaldo Gemini); no agregues `fetch()` a proveedores en otros archivos.
- El autorrelleno cubre también controles personalizados: dropdowns con `aria-haspopup="listbox"` o `role="combobox"` (Workday, MUI, Angular Material, Headless UI), `<select>` ocultos por Select2, Chosen o bootstrap-select, radios de MUI y `role="radio"`/`role="checkbox"`. Los radios se marcan con `click()` para que React/Vue se enteren. Qué opción elegir lo decide `JobFillPortals.pickOptionIndex` / `pickVariantIndex`, que nunca eligen el placeholder.
- El autorrelleno **nunca pisa un campo que ya tiene valor**; para reemplazarlo, bórralo y vuelve a autorrellenar.
