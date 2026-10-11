const path = require('node:path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const settings = require('./settings');
const agenda = require('./services/agenda');
const stock = require('./services/stock');
const tn = require('./services/tiendanube');
const { log } = require('./services/log');
const { HttpError } = require('./util');

function seed() {
  const { n } = db.one('SELECT COUNT(*) AS n FROM services');
  if (n === 0) {
    db.run(`INSERT INTO services (name, description, duration_min, price, deposit_amount, sort) VALUES
      ('Bronceado orgánico (spray)', 'Bronceado sin sol con solución orgánica. Resultado natural en 24 hs.', 30, 25000, 8000, 1),
      ('Bronceado + exfoliación', 'Exfoliación corporal previa para un bronceado más parejo y duradero.', 60, 38000, 12000, 2)`);
  }
  const hours = db.one('SELECT COUNT(*) AS n FROM business_hours').n;
  if (hours === 0) {
    for (let d = 1; d <= 5; d++) db.run(`INSERT INTO business_hours (weekday, start_time, end_time) VALUES (?, '10:00', '19:00')`, d);
    db.run(`INSERT INTO business_hours (weekday, start_time, end_time) VALUES (6, '10:00', '14:00')`);
  }
}

function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  // Se guarda el body crudo para validar la firma de los webhooks de Tienda Nube.
  app.use(express.json({ limit: '1mb', verify: (req, res, buf) => (req.rawBody = buf) }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', (req, res) => {
    const { sid, user } = auth.login(req.body && req.body.username, req.body && req.body.password);
    auth.setSessionCookie(req, res, sid);
    res.json({ user });
  });
  app.post('/api/auth/logout', (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });
  app.get('/api/auth/me', (req, res) => {
    const user = auth.sessionUser(req);
    if (!user) throw new HttpError(401, 'No hay sesión');
    res.json({ user, business_name: settings.get('business_name') });
  });

  app.use('/api/public', require('./routes/public'));
  app.use('/api/webhooks', require('./routes/webhooks'));
  app.use('/api/admin', require('./routes/admin'));

  // Redirect URL de la app de Tienda Nube (OAuth). Requiere estar logueado en el panel.
  app.get('/integraciones/tiendanube/callback', async (req, res) => {
    if (!auth.sessionUser(req)) return res.redirect('/admin/?error=' + encodeURIComponent('Ingresá al panel y volvé a conectar Tienda Nube'));
    try {
      await tn.exchangeCode(String(req.query.code || ''));
      res.redirect('/admin/#config?tn=ok');
    } catch (err) {
      log('tiendanube', 'error', `Error conectando la tienda: ${err.message}`);
      res.redirect('/admin/?error=' + encodeURIComponent(`No se pudo conectar Tienda Nube: ${err.message}`));
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    if (err.type && err.status) return res.status(err.status).json({ error: err.message });
    // Errores de las APIs externas (Mercado Pago / Tienda Nube): no se reenvía su código (ej. un 401 de ellos).
    if (err.message && (err.message.startsWith('HTTP ') || err.name === 'TimeoutError')) {
      return res.status(502).json({ error: `Error de la integración: ${err.message}` });
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}

function bootstrap({ dbFile } = {}) {
  db.init(dbFile);
  seed();
  stock.setChangeListener((productId, opts) => tn.schedulePush(productId, opts));
  return createApp();
}

if (require.main === module) {
  const app = bootstrap();
  const admin = auth.ensureAdmin();
  if (admin) {
    console.log('──────────────────────────────────────────────');
    console.log(` Usuario administrador creado: ${admin.username}`);
    if (admin.generated) console.log(` Contraseña: ${admin.password}  (cambiala desde el panel)`);
    console.log('──────────────────────────────────────────────');
  }
  setInterval(() => agenda.expirePending(), 60e3).unref();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Sistema funcionando en http://localhost:${port}`);
    console.log(`  Reservas online: http://localhost:${port}/`);
    console.log(`  Panel:           http://localhost:${port}/admin/`);
    if (!settings.publicUrl().startsWith('https://')) {
      console.log('  Aviso: configurá la URL pública (https) para recibir los webhooks de Mercado Pago y Tienda Nube.');
    }
  });
}

module.exports = { createApp, bootstrap };
