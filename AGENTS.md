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

1. Haz clic en el icono de **JobFill AI** y presiona el engranaje ⚙️ o *"Editar Datos Completos"*.
2. Rellena tus pestañas con tus datos:
   - 👤 **Datos Personales** (Nombre, **RUT / DNI**, Email, Teléfono, Ubicación).
   - 🔗 **Redes y Enlaces** (LinkedIn, GitHub, Portafolio).
   - 💼 **Experiencia y Salario** (Cargo, Años de experiencia, Pretensiones, Inglés).
   - 🎓 **Educación y Habilidades** (Tu stack técnico, ej: JavaScript, Python, etc.).
   - 🧩 **Campos Flexibles** (Agrega cualquier dato extra: *Licencia de conducir, Renta líquida, etc.* con sus palabras clave).
   - 🤖 **Claude IA:** pega tu **Anthropic API Key** (`sk-ant-...`). Opcional: una **API Key de Vertex AI** (modo express, `AQ.…`) para que **Gemini responda automáticamente si Claude se queda sin saldo**, o para usar Gemini como modelo principal. Pulsa *"⚡ Probar Conexión"*: prueba cada proveedor por separado.
3. Haz clic en **"💾 Guardar Cambios"**.

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
