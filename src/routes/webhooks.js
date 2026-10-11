const express = require('express');
const mp = require('../services/mercadopago');
const tn = require('../services/tiendanube');
const payments = require('../services/payments');
const { log } = require('../services/log');

const router = express.Router();

// Notificaciones de Mercado Pago (Webhooks e IPN).
router.post('/mercadopago', async (req, res) => {
  const body = req.body || {};
  const type = body.type || body.topic || req.query.type || req.query.topic;
  const dataId = String((body.data && body.data.id) || req.query['data.id'] || req.query.id || '');

  if (!mp.verifySignature(req.headers, req.query['data.id'] || dataId)) {
    log('mercadopago', 'warn', 'Notificación con firma inválida rechazada');
    return res.status(401).json({ error: 'firma inválida' });
  }
  if (type !== 'payment' || !dataId) return res.sendStatus(200);

  try {
    await payments.processPayment(dataId);
    res.sendStatus(200);
  } catch (err) {
    log('mercadopago', 'error', `Error procesando el pago ${dataId}: ${err.message}`);
    res.sendStatus(500); // Mercado Pago reintenta
  }
});

// Webhooks de Tienda Nube (órdenes creadas/canceladas, productos eliminados).
router.post('/tiendanube', async (req, res) => {
  const signature = req.headers['x-linkedstore-hmac-sha256'] || req.headers['http_x_linkedstore_hmac_sha256'];
  if (!tn.verifyWebhook(req.rawBody, signature)) {
    log('tiendanube', 'warn', 'Webhook con firma inválida rechazado');
    return res.status(401).json({ error: 'firma inválida' });
  }
  try {
    await tn.handleWebhook(req.body || {});
    res.sendStatus(200);
  } catch (err) {
    log('tiendanube', 'error', `Error procesando webhook ${req.body && req.body.event}: ${err.message}`);
    res.sendStatus(500);
  }
});

module.exports = router;
