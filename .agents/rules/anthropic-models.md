# Regla Obligatoria de Modelos Anthropic (Claude)

**NUNCA SALIR DE SONNET 5 Y HAIKU 4.5 EN NINGUNA OPCIÓN NI NADA DE LA APP.**

Los modelos anteriores ya no existen y no responden a la API key de Anthropic en este proyecto.

Cuando se requiera interactuar con la API de Anthropic o modificar lógica de modelos en el código de esta extensión, **SIEMPRE** deben usarse estrictamente los siguientes identificadores:
- **Sonnet 5**: Utilizar literalmente `claude-sonnet-5`.
- **Haiku 4.5**: Utilizar literalmente `claude-haiku-4-5`.

Estos IDs están completos tal cual: **nunca agregar sufijos de fecha** (`-20251001` y similares son inválidos y devuelven 404).

**Respaldo con Gemini (pedido explícito del usuario):** además de Claude, la extensión puede usar Gemini vía Vertex AI (modo express, API key) como respaldo cuando Claude se queda sin saldo, o como modelo principal si el usuario lo elige. El mapeo vive SOLO en `GEMINI_MODELS` de `shared/ai-client.js`: **Gemini 3.8 Flash** para ambos (`gemini-3.8-flash`, luego `gemini-3.8-flash-preview`), con `gemini-2.5-flash` como último recurso si el ID de 3.8 no existe en el modo express. El resto del código sigue usando únicamente los dos IDs de Claude de arriba.
