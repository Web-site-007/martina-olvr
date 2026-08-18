require('dotenv').config();
const crypto = require('crypto');
const { MercadoPagoConfig, Order } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 15000 }
});
const orderClient = new Order(client);

function validateWebhookSignature(query, headers) {
  const signature = headers['x-signature'];
  const requestId = headers['x-request-id'];
  if (!signature || !requestId) return false;

  const parts = {};
  signature.split(',').forEach(p => {
    const [key, val] = p.split('=');
    parts[key] = val;
  });
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const dataId = query['data.id'];
  if (!dataId) return false;

  const template = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;

  const hmac = crypto.createHmac('sha256', secret).update(template).digest('hex');
  return hmac === v1;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  console.log('Webhook recebido:', JSON.stringify(body, null, 2));

  if (!validateWebhookSignature(req.query, req.headers)) {
    console.warn('Webhook: assinatura inválida!');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const orderId = body.data && body.data.id;
  const action = body.action;
  console.log(`Webhook: Order ${orderId} — ação: ${action}`);

  if (orderId) {
    try {
      const order = await orderClient.get({ id: orderId });
      console.log(`Order ${orderId} status: ${order.status} (${order.status_detail})`);
    } catch (err) {
      console.error(`Erro ao consultar order ${orderId}:`, err.message);
    }
  }

  return res.status(200).json({ received: true });
};
