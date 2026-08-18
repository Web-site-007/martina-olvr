require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Detect card brand from number
function detectCardBrand(number) {
  const n = number.replace(/\D/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'master';
  if (/^6(?:011|5)/.test(n)) return 'master';
  if (/^(4011|4312|4573|4574|5041|5066|5067|6277|6362|6504|6505|6516)/.test(n)) return 'elo';
  if (/^3[47]/.test(n)) return 'amex';
  return 'master';
}

// Planos
const PLANS = {
  mensal: { name: 'Assinatura Mensal - Martina Olvr', price: '15.00', months: 1 },
  trimestral: { name: 'Assinatura Trimestral - Martina Olvr', price: '60.00', months: 3 },
  semestral: { name: 'Assinatura Semestral - Martina Olvr', price: '105.00', months: 6 }
};

const SITE_URL = process.env.MP_SITE_URL || 'http://localhost:8080';

// Raw HTTP POST to Mercado Pago
function mpPost(path, body, idempotencyKey, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.mercadopago.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
        'Content-Length': Buffer.byteLength(data),
        ...extraHeaders
      },
      timeout: 15000
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Resposta inválida do MP')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-meli-session-id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const {
    plan, paymentMethod, cardToken, installments, cardNumber,
    payerEmail, payerFirstName, payerLastName, payerDoc,
    payerZipCode, payerStreet, payerStreetNumber, payerCity, payerState
  } = body;

  const deviceId = req.headers['x-meli-session-id'] || '';

  if (!plan || !PLANS[plan]) {
    return res.status(400).json({ error: 'Plano inválido' });
  }

  const planData = PLANS[plan];
  const idempotencyKey = uuidv4();

  try {
    let paymentMethodObj = {};
    const brand = cardNumber ? detectCardBrand(cardNumber) : 'master';

    if (paymentMethod === 'credit_card') {
      if (!cardToken) {
        return res.status(400).json({ error: 'Token do cartão obrigatório' });
      }
      paymentMethodObj = {
        id: brand,
        type: 'credit_card',
        token: cardToken,
        installments: installments || 1
      };
    } else if (paymentMethod === 'pix') {
      paymentMethodObj = { id: 'pix', type: 'bank_transfer' };
    } else if (paymentMethod === 'boleto') {
      paymentMethodObj = { id: 'boleto', type: 'bank_transfer' };
    } else {
      return res.status(400).json({ error: 'Método de pagamento inválido' });
    }

    const brandNames = { visa: 'VISA', master: 'MASTER', elo: 'ELO', amex: 'AMEX' };
    const statementDescriptor = (brandNames[brand] || 'MASTER').substring(0, 12);

    const payer = {
      email: payerEmail || 'testuser@testuser.com',
      entity_type: 'individual'
    };
    if (payerFirstName) payer.first_name = payerFirstName;
    if (payerLastName) payer.last_name = payerLastName;
    if (payerDoc) payer.identification = { type: 'CPF', number: payerDoc };
    if (payerZipCode || payerStreet || payerCity || payerState) {
      payer.address = {};
      if (payerStreet) payer.address.street_name = payerStreet;
      if (payerStreetNumber) payer.address.street_number = payerStreetNumber;
      if (payerZipCode) payer.address.zip_code = payerZipCode;
      if (payerCity) payer.address.city = payerCity;
      if (payerState) payer.address.state = payerState;
    }

    const orderBody = {
      type: 'online',
      processing_mode: 'automatic',
      ...(paymentMethod === 'credit_card' ? { capture_mode: 'automatic' } : {}),
      total_amount: planData.price,
      description: planData.name,
      external_reference: `martina-${plan}-${Date.now()}`,
      payer,
      additional_info: {
        'payer.registration_date': new Date().toISOString()
      },
      transactions: {
        payments: [{
          amount: planData.price,
          payment_method: {
            ...paymentMethodObj,
            statement_descriptor: statementDescriptor
          }
        }]
      },
      items: [{
        title: planData.name,
        description: `Assinatura ${plan} - Martina Olvr - ${planData.months} mes(es) de acesso ao conteudo exclusivo`,
        unit_price: planData.price,
        quantity: 1,
        category_id: 'subscription',
        picture_url: SITE_URL + '/images/avatar.jpg'
      }]
    };

    const extraHeaders = {};
    if (deviceId) extraHeaders['X-meli-session-id'] = deviceId;

    const result = await mpPost('/v1/orders', orderBody, idempotencyKey, extraHeaders);

    if (result.errors || result.status === 400) {
      const errMsg = result.errors
        ? result.errors.map(e => e.details ? e.details.join('; ') : e.message).join(' | ')
        : 'Erro ao criar order';
      throw new Error(errMsg);
    }

    return res.status(200).json({ id: result.id, status: result.status, detail: result });
  } catch (err) {
    console.error('Erro ao criar order:', err.message);
    const errMsg = err.errors
      ? err.errors.map(e => e.details ? e.details.join('; ') : e.message).join(' | ')
      : (err.message || 'Erro interno');
    return res.status(500).json({ error: errMsg });
  }
};
