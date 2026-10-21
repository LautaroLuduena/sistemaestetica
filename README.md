# Sistema para estética

Sistema web para un centro de estética / bronceado con:

- **Reservas online**: las clientas eligen servicio, día y horario, y pagan una **seña con Mercado Pago** para confirmar el turno.
- **Agenda**: turnos web y cargados en el local, reprogramación, cancelación con devolución de seña, "no vino", link de pago de seña por WhatsApp.
- **Stock**: productos con ajustes (entrada, salida/rotura, conteo físico), historial de movimientos y alertas de stock mínimo. Sin módulo de compras.
- **Caja**: apertura/cierre con arqueo, ventas de productos y servicios, cobro del saldo de los turnos, señas, ingresos/egresos, y cobro con **link/QR de Mercado Pago**.
- **Tienda Nube**: los productos y el stock se replican en la tienda online, y las ventas de la web descuentan el stock del sistema.

## Requisitos

- Node.js **22.13 o superior** (usa la base SQLite que viene incluida en Node, no hace falta instalar una base de datos).

## Puesta en marcha

```bash
npm install
ADMIN_PASSWORD=una-clave-segura npm start
```

- Página de reservas: `http://localhost:3000/`
- Panel: `http://localhost:3000/admin/` (usuario `admin`; si no definís `ADMIN_PASSWORD`, la contraseña se genera y se muestra en la consola la primera vez).

Los datos se guardan en `data/estetica.db`. **Hacé backup de ese archivo** periódicamente.

Tests: `npm test`

## Primeros pasos en el panel

1. **Configuración → Negocio y agenda**: nombre, teléfono, dirección, **URL pública** (ver abajo), cantidad de camas/cabinas (turnos simultáneos), intervalo entre turnos, minutos para pagar la seña.
2. **Servicios**: precio, duración y **seña** de cada servicio (si la seña es 0, el turno se confirma sin pago).
3. **Horarios**: franjas de atención por día y feriados / vacaciones.
4. **Mercado Pago** y **Tienda Nube** (abajo).

## Publicación (URL pública)

Para que Mercado Pago y Tienda Nube avisen automáticamente los pagos y las ventas, el sistema tiene que estar publicado en internet con **https** (por ejemplo en un VPS con Nginx + certificado de Let's Encrypt, Railway, Render, etc.) y esa URL cargada en *Configuración → URL pública*.

Si el sistema está detrás de un proxy, ya está configurado `trust proxy`. Asegurate de que el disco donde está `data/` sea persistente.

## Mercado Pago (seña de los turnos y cobros en caja)

1. Entrá a [Mercado Pago Developers → Tus integraciones](https://www.mercadopago.com.ar/developers/panel/app) y creá una aplicación (Checkout Pro / pagos online).
2. Copiá el **Access Token** y la **Public Key** en *Configuración → Mercado Pago*. Para probar usá las credenciales de prueba (`TEST-…`) y usuarios de prueba.
3. En la aplicación de Mercado Pago, sección **Webhooks**, configurá la URL `https://TU-DOMINIO/api/webhooks/mercadopago` con el evento **Pagos**, y pegá la **clave secreta** en el sistema (valida que las notificaciones sean auténticas).

Cómo funciona la seña:

- Al reservar, el turno queda **"Esperando seña"** y el horario se bloquea durante los minutos configurados.
- Se genera un checkout de Mercado Pago (solo pagos que se aprueban al instante: tarjeta, dinero en cuenta; se excluyen Rapipago/Pago Fácil).
- Cuando el pago se aprueba, el turno pasa a **Confirmado** y la seña se registra en la caja (o en "movimientos con la caja cerrada" si estaba cerrada).
- Si no se paga a tiempo, el turno **vence** y el horario se libera. Si el pago llega tarde y el horario ya se ocupó, el turno queda marcado para reprogramar o devolver.
- Al cobrar en el local, el saldo ya descuenta la seña. Al cancelar un turno se puede **devolver la seña** automáticamente.

### Verificación automática de pagos

Además del webhook, el sistema consulta a Mercado Pago **cada minuto** si las reservas que esperan la seña (y los cobros con link/QR de la caja) ya se pagaron, buscando los pagos por su referencia. Así el turno se confirma aunque el webhook falle o no esté configurado. Se puede desactivar en *Configuración → Mercado Pago*, y en cada turno hay un botón **Verificar pago en Mercado Pago**.

## WhatsApp (confirmación automática del turno)

Cuando se acredita la seña (online o cobrada en el local), el sistema le envía a la clienta un WhatsApp confirmando el turno, con las **indicaciones** configuradas (cómo venir preparada, etc.).

Usa la API oficial de WhatsApp de Meta (WhatsApp Cloud API), que exige una **plantilla aprobada**. Los pasos están en *Configuración → WhatsApp*. Resumen:

1. App de tipo Empresa en [developers.facebook.com](https://developers.facebook.com/apps) con el producto WhatsApp y un número verificado.
2. Token permanente de un usuario de sistema (permisos `whatsapp_business_messaging` y `whatsapp_business_management`).
3. Plantilla de categoría *Utilidad*, idioma Español (ARG), llamada `confirmacion_turno`:
   ```
   ¡Hola {{1}}! Tu turno de {{2}} está confirmado ✅
   📅 {{3}} a las {{4}}
   Para tener en cuenta: {{5}}
   ¡Te esperamos!
   ```
4. Cargar token, Phone number ID y plantilla, enviar un mensaje de prueba y activar el envío automático.

Meta cobra cada mensaje de plantilla de utilidad (unos pocos centavos de dólar). Mientras no esté configurado, cada turno tiene el botón **Abrir WhatsApp con el mensaje** para mandarlo a mano.

## Tienda Nube (productos y stock)

**Opción A (recomendada)** – crear una app:

1. En el [Portal de Socios de Tienda Nube](https://partners.tiendanube.com) creá una app con permisos de **Products** (lectura y escritura) y **Orders** (lectura).
2. Como URL de redirección poné `https://TU-DOMINIO/integraciones/tiendanube/callback`.
3. Cargá el **App ID** y el **Client Secret** en *Configuración → Tienda Nube*, guardá y tocá **Conectar con Tienda Nube** (estando logueada en el panel).

**Opción B** – si ya tenés un access token y el store id, cargalos directamente.

Después:

- **Importar productos de Tienda Nube**: trae los productos (cada variante es un producto) y los vincula por SKU.
- **Registrar webhooks**: suscribe el sistema a `order/created`, `order/cancelled` y `product/deleted`.
- **Enviar todo el stock**: publica / actualiza todos los productos en la web.

Sincronización:

| Qué pasa | Efecto |
|---|---|
| Alta / edición de producto en el sistema | Se crea / actualiza en Tienda Nube (si "Publicar en Tienda Nube" está marcado) |
| Venta en caja, ajuste de stock, anulación | Se envía el nuevo stock a Tienda Nube |
| Orden nueva en Tienda Nube | Se descuenta el stock en el sistema |
| Orden cancelada en Tienda Nube | Se repone el stock en el sistema |

Los errores de sincronización se ven en el listado de stock y en *Configuración → Tienda Nube*.

### Ventas web

Cada venta de Tienda Nube aparece en la sección **Ventas web** con todo lo necesario para despacharla y controlarla:

- **Cliente:** nombre, DNI, email, teléfono (con acceso directo a WhatsApp) y nota de la compra. La clienta también se agrega a *Clientas*.
- **Envío:** dirección completa, código postal, ciudad, provincia, método de envío, costo y seguimiento, con un botón para copiar los datos (o "Retira en local").
- **Productos:** detalle con SKU, cantidades, precios, descuentos, envío y total, y si cada producto está vinculado al stock.
- **Pago:** estado en Tienda Nube, medio, cuotas, N° de operación y fecha. Si se cobró con Mercado Pago en la misma cuenta, el botón **Corroborar pago en Mercado Pago** consulta el pago real (estado, importe cobrado, neto recibido) y avisa si no coincide con el total.

Las ventas llegan al instante por webhook (`order/created`, `order/paid`, `order/updated`, `order/packed`, `order/fulfilled`, `order/cancelled`) y, como respaldo, el sistema consulta Tienda Nube cada 5 minutos. La primera sincronización trae los últimos 30 días como historial **sin mover el stock**. Las ventas web no se suman a la caja del local (se cobran online).

## Estructura

```
src/
  server.js            servidor Express y arranque
  db.js                esquema SQLite
  settings.js          configuración editable desde el panel
  auth.js              usuarios y sesiones
  services/
    agenda.js          disponibilidad, reservas y estados de turnos
    payments.js        señas, cobros y verificación automática de pagos
    whatsapp.js        confirmación de turnos por WhatsApp (API de Meta)
    mercadopago.js     cliente de la API de Mercado Pago
    tiendanube.js      cliente y sincronización con Tienda Nube
    weborders.js       ventas web (órdenes de Tienda Nube)
    stock.js           movimientos de stock
    cash.js            caja, ventas y movimientos
  routes/              API pública, panel y webhooks
public/
  index.html           reservas online
  reserva.html         estado de la reserva (vuelta de Mercado Pago)
  admin/               panel de administración
test/                  tests de los flujos principales
```
