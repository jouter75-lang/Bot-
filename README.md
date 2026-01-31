# Discord Template Migrator (safe)

Bot para migrar/actualizar roles y canales desde una plantilla JSON accesible por URL.
Incluye dry-run por defecto, token de confirmación y archivado (renombrado) en vez de borrar.

Comandos slash principales:
- /load-template url:<url> dry_run:<true|false> — descarga la plantilla, muestra resumen y genera token.
- /apply-template token:<token> — aplica los cambios (o sólo simula si dry-run=true).

Despliegue básico:
1. Crear app y bot en Discord Developer Portal. Copia BOT_TOKEN y CLIENT_ID.
2. Clona repo, añade archivos y sube a GitHub.
3. Rellenar `.env` y dar permisos al bot (Manage Roles, Manage Channels).
4. Desplegar en Railway/Render/Heroku o usar VPS. Añade variables de entorno en la plataforma.

Sobre plantillas y URLs:
- El bot descarga plantillas JSON públicas (raw GitHub, S3 público, etc).
- Para URLs privadas se necesita un endpoint con autenticación; el bot puede enviar headers si adaptas el fetch.
- Los Discord Server Template links crean servidores nuevos; para aplicar su estructura a un servidor existente debes convertir la template a JSON y usar este bot para aplicar.

Seguridad:
- Dry-run por defecto.
- Token de confirmación con caducidad 10 min.
- No borra; renombra "OLD-" elementos no incluidos.
- Probar siempre en servidor de pruebas.