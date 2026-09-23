# ⚡ JobFill AI - Extensión para Auto-rellenar Formularios de Empleo

Extensión de navegador (Manifest V3) para Chrome, Edge y Brave que guarda tus datos profesionales de forma 100% segura y local, rellenando formularios de postulación laboral con un solo clic y redactando respuestas a preguntas abiertas usando **Codex IA (Anthropic)**.

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
   - 🤖 **Codex IA:** Pega tu **Anthropic API Key** (`sk-ant-...`) y pulsa *"⚡ Probar Conexión"*.
3. Haz clic en **"💾 Guardar Cambios"**.

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
4. Para las preguntas abiertas de texto largo, haz clic en el recuadro de texto y pulsa el botón **"✨ Redactar con Codex IA"** para que genere una respuesta adaptada en segundos.

---

## 🔒 Privacidad y Seguridad

- **100% Local:** Tus datos personales nunca se envían a ningún servidor intermedio; residen en el almacenamiento cifrado local de tu navegador (`chrome.storage.local`).
- **Llamadas directas a Codex:** Las solicitudes de redacción viajan directamente y encriptadas desde tu navegador a los servidores oficiales de Anthropic (`api.anthropic.com`).
