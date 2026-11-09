# Backend local

## Configuración inicial

Desde la raíz del proyecto:

1. Copiá `.env.example` a `.env`.
2. Elegí una contraseña local para `DB_PASSWORD`.
3. Generá una clave JWT con `node -p "require('node:crypto').randomBytes(32).toString('hex')"` y guardala en `AUTH_JWT_SECRET`. No la subas a Git ni la compartas.
4. Iniciá PostgreSQL y aplicá las migraciones:

   ```powershell
   docker compose up -d
   npm run db:migrate --prefix backend
   ```

5. Para crear la cuenta inicial, completá temporalmente `BOOTSTRAP_STORE_NAME`, `BOOTSTRAP_EMAIL` y `BOOTSTRAP_PASSWORD` en `.env`. Usá una contraseña de al menos 12 caracteres. Ejecutá:

   ```powershell
   npm run auth:bootstrap --prefix backend
   ```

   El comando solo crea el primer usuario y se niega a continuar si ya existe uno. Anotá el ID de la tienda interna que imprime; se usa para autorizar la integración. Después, borrá los tres valores `BOOTSTRAP_*` de `.env`.
6. Iniciá la API:

   ```powershell
   npm run dev --prefix backend
   ```

### Recuperar el acceso de la cuenta propietaria

Si olvidaste el email, ejecutá `npm run auth:reset-owner --prefix backend` para mostrar localmente los emails de las cuentas propietarias. Para cambiar la contraseña, cargá el email elegido y una contraseña nueva (mínimo 12 caracteres) en variables temporales de PowerShell y ejecutá el mismo comando. No vuelvas a usar `auth:bootstrap`: solo funciona cuando todavía no hay usuarios.

## Conectar una tienda de prueba de Tiendanube

1. Creá un usuario propietario con `auth:bootstrap` si todavía no lo hiciste.
2. En el Portal de Partners, configurá los permisos `read_products`, `write_products` y `read_orders`. `read_orders` permite consultar pedidos y activar sus notificaciones. Esta primera versión usa una ubicación única; no necesita permisos de ubicaciones.
3. Configurá la URL de retorno de la aplicación con la misma URL HTTPS pública que pondrás en `TIENDANUBE_REDIRECT_URI`, terminando en `/api/integrations/tiendanube/callback`.
4. Copiá el ID de aplicación a `TIENDANUBE_CLIENT_ID` y su secreto a `TIENDANUBE_CLIENT_SECRET` en `.env`. No los compartas ni los subas a Git.
5. Generá una clave de cifrado independiente y guardala en `TIENDANUBE_TOKEN_ENCRYPTION_KEY`:

   ```powershell
   node -p "require('node:crypto').randomBytes(32).toString('hex')"
   ```

6. Para recibir el callback durante las pruebas locales, exponé el puerto 3000 con un túnel HTTPS temporal. Actualizá tanto el Portal de Partners como `TIENDANUBE_REDIRECT_URI` si cambia la URL del túnel.
7. Con el servidor levantado, iniciá la autorización desde un usuario `owner` o `admin` mediante `GET /api/stores/:storeId/integrations/tiendanube/authorize` con su JWT. El servidor genera y valida `state`, y devuelve una `authorizationUrl` para abrir en el navegador.
8. Consultá `GET /api/stores/:storeId/integrations/tiendanube/status` para confirmar la conexión. El token se cifra con AES-256-GCM y nunca se devuelve en las respuestas.
9. Configurá `TIENDANUBE_USER_AGENT` en `.env` con el nombre de la aplicación y un email de contacto o URL, según el formato del ejemplo. La API exige este encabezado en cada solicitud.
10. Consultá `GET /api/stores/:storeId/integrations/tiendanube/products?page=1` para ver una página de productos y variantes en modo de solo lectura. Devuelve hasta 30 productos por página, incluyendo SKU y stock; no guarda datos ni cambia la tienda.
11. Para importar las páginas del catálogo al inventario local, usá `POST /api/stores/:storeId/integrations/tiendanube/products/import?page=1` y continuá con las páginas indicadas. La primera importación crea productos/variantes vinculados por sus IDs de Tiendanube, guarda la primera foto disponible y registra el stock disponible como entradas iniciales en una ubicación local. Las importaciones repetidas actualizan nombre, foto, SKU y atributos del catálogo, pero no vuelven a sumar stock ni escriben cambios en Tiendanube. Si hay varias ubicaciones activas, creá o elegí una ubicación activa llamada `Stock general` antes de importar.
12. Al terminar la importación completa, StockControll registra webhooks de pedidos para `order/created`, `order/updated`, `order/edited`, `order/paid`, `order/cancelled` y `order/voided`. El endpoint público debe seguir disponible por HTTPS en el mismo host de `TIENDANUBE_REDIRECT_URI`; durante las pruebas, mantené activo el túnel HTTPS. Los webhooks se verifican con la firma HMAC de Tiendanube. Un pedido descuenta stock interno al crearse; si se cancela o se anula, se revierte ese movimiento. El estado de pago se guarda por separado para distinguir pedidos pagados de pendientes. Esta sincronización no escribe cambios de stock en Tiendanube.
13. Desde la sección Estadísticas, un usuario `owner` o `admin` puede sincronizar pedidos anteriores. La importación es paginada, idempotente y no altera el stock: el stock inicial ya refleja el inventario actual de Tiendanube y volver a descontar ventas pasadas lo duplicaría. Se admiten hasta 10.000 pedidos por sincronización.
14. `GET /api/stores/:storeId/analytics/products?months=12` devuelve los 10 productos más vendidos, unidades por variante, ventas mensuales por producto y tendencia comparando los últimos tres meses completos con los tres anteriores. `months` acepta 6, 12 o 24. Solo se cuentan pedidos pagados, no cancelados ni anulados. Los informes requieren membresía en la tienda; el historial completo solo lo pueden sincronizar `owner` y `admin`.

## Autenticación y rutas

- `POST /api/auth/login` recibe `{"email":"...","password":"..."}` y devuelve un JWT de acceso que vence en 30 minutos.
- Enviá el token como `Authorization: Bearer <token>`.
- `GET /api/stores/:storeId/inventory/balances` requiere membresía en esa tienda. Acepta filtros opcionales `productVariantId` y `locationId`.
- `POST /api/stores/:storeId/inventory/movements` requiere rol `owner`, `admin` o `manager`. El rol `staff` puede consultar saldos, pero no modificar el inventario.

El `storeId` se toma de la ruta y se verifica contra las membresías del usuario autenticado. No se acepta un `storeId` en el cuerpo del movimiento. El registro público y la gestión de usuarios se mantienen deshabilitados; las credenciales se crean mediante el comando de bootstrap hasta implementar invitaciones y administración de miembros.
