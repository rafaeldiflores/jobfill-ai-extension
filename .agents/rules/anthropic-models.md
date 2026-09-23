# Regla Obligatoria de Modelos Anthropic (Claude)

**NUNCA SALIR DE SONNET 5 Y HAIKU 4.5 EN NINGUNA OPCIÓN NI NADA DE LA APP.**

Los modelos anteriores ya no existen y no responden a la API key de Anthropic en este proyecto.

Cuando se requiera interactuar con la API de Anthropic o modificar lógica de modelos en el código de esta extensión, **SIEMPRE** deben usarse estrictamente los siguientes identificadores:
- **Sonnet 5**: Utilizar literalmente `claude-sonnet-5`.
- **Haiku 4.5**: Utilizar literalmente `claude-haiku-4-5`.

Estos IDs están completos tal cual: **nunca agregar sufijos de fecha** (`-20251001` y similares son inválidos y devuelven 404).

Está terminantemente prohibido hacer fallbacks a modelos como `claude-3-opus`, `claude-3-sonnet` clásico, `claude-2.1`, etc.
