# Lavandería Zañartu 1100 — Git deploy

Esta variante deja `worker.js` en la raíz para evitar errores de ruta en Cloudflare Builds.

## Estructura que debe quedar en GitHub

```
/
  worker.js
  wrangler.toml
  package.json
  schema.sql
  migration_ip_pickup.sql
  public/
    index.html
    styles.css
    app.js
```

## Antes de desplegar

1. Crea la base D1 si aún no existe:
   `npx wrangler d1 create zanartu-lavanderia`
2. Copia el `database_id` que entrega Cloudflare.
3. Reemplaza `REEMPLAZAR_CON_DATABASE_ID` dentro de `wrangler.toml`.
4. Inicializa una base nueva:
   `npx wrangler d1 execute zanartu-lavanderia --remote --file=schema.sql`
5. En Cloudflare Builds usa como Deploy command:
   `npx wrangler deploy`

Si ya existía la base de la V1, ejecuta `migration_ip_pickup.sql` una sola vez antes del deploy.
