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


## QR general de la página

La interfaz genera automáticamente un QR con la URL base donde esté publicada la app.
No es necesario editar el enlace cuando cambie el dominio de Cloudflare.

El QR ignora parámetros como `?tower=1&machine=T1-W1`, por lo que siempre funciona
como acceso general a la lavandería.


## V6 - sincronización entre navegadores

Cambios:
- La vista `Todas` permite seleccionar máquinas de Torre 1 o Torre 2 sin cambiar el filtro.
- La torre guardada arriba corresponde al departamento del residente, no restringe la torre de la máquina.
- Al seleccionar una máquina se crea un hold temporal de 2 minutos en D1.
- Otro navegador verá la máquina como `Seleccionada` y no podrá tomarla mientras el hold esté activo.
- El navegador que la seleccionó la verá como `Seleccionada por ti`.
- Si no se confirma el ciclo, el hold se libera automáticamente al cabo de 2 minutos.
- El estado se sincroniza cada 1 segundo y también al volver a la pestaña, recuperar conexión o enfocar la ventana.
- Al iniciar o liberar una máquina la vista se actualiza inmediatamente.
- La selección se distingue por navegador con un token local; la regla de `Finalizar antes` sigue siendo por IP.

### Migración necesaria si la base ya existe

Ejecutar una sola vez:

```bash
npx wrangler d1 execute zanartu-lavanderia --remote --file=migration_machine_holds.sql
```

Después dejar el deploy normal:

```bash
npx wrangler deploy
```
