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

1. **📚 Fuente de verdad:** arrastra tus archivos **.md** (p. ej. `BASE_Experiencia.md`). Se leen al instante y sin IA:
   - Las **REGLAS DE USO** del archivo se aplican literalmente en cada respuesta.
   - Las métricas marcadas **ESTIMADA** y las secciones con `Nota: … NUNCA va en un CV` nunca se envían a la IA.
   - Para cada oferta se envían solo las experiencias y logros más relevantes (más rápido y más barato).
   - "Completar Mis datos" llena los campos vacíos (nombre, contacto, links, stack, estudios) desde el archivo.
   - Para actualizar, vuelve a importar el mismo archivo. ¿Sin .md? Hay una opción plegada para usar un CV en PDF o texto.
2. **🤖 Inteligencia artificial:** pega tu **Anthropic API Key** (`sk-ant-...`). Opcional: una **API Key de Vertex AI** (`AQ.…`) para que **Gemini responda si Claude se queda sin saldo**. *"⚡ Probar Conexión"* prueba cada proveedor por separado.
3. **👤 Mis datos:** revisa contacto, renta, disponibilidad y la sección legal. Las preguntas legales empiezan **sin responder**: solo se rellenan si tú eliges una opción.

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
- `shared/ai-client.js` es el único cliente de IA (Claude + respaldo Gemini); no agregues `fetch()` a proveedores en otros archivos.
- El autorrelleno **nunca pisa un campo que ya tiene valor**; para reemplazarlo, bórralo y vuelve a autorrellenar.
