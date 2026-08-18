require('dotenv').config();
const { MercadoPagoConfig, Order } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 15000 }
});
const orderClient = new Order(client);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Order ID obrigatório' });

  try {
    const result = await orderClient.get({ id });
    return res.status(200).json({ id: result.id, status: result.status, status_detail: result.status_detail });
  } catch (err) {
    console.error('Erro ao consultar order:', err.message);
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
};
