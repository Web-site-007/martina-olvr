require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { MercadoPagoConfig, Order } = require('mercadopago');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;

// MercadoPago Config
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 15000 }
});
const orderClient = new Order(client);

// Raw HTTP helper for Orders API (bypasses SDK validation for bank_transfer)
async function mpPost(path, body, idempotencyKey, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
      'Content-Length': Buffer.byteLength(data),
      ...extraHeaders
    };
    const req = https.request({
      hostname: 'api.mercadopago.com',
      port: 443,
      path,
      method: 'POST',
      headers
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Resposta inválida do MP')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Site URL
const SITE_URL = process.env.MP_SITE_URL || (process.env.VERCEL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`);
const NOTIFICATION_URL = process.env.MP_NOTIFICATION_URL || `${SITE_URL}/webhooks/mercadopago`;

// Planos
const PLANS = {
  mensal: { name: 'Assinatura Mensal - Martina Olvr', price: '15.00', months: 1 },
  trimestral: { name: 'Assinatura Trimestral - Martina Olvr', price: '60.00', months: 3 },
  semestral: { name: 'Assinatura Semestral - Martina Olvr', price: '105.00', months: 6 }
};

// Card brand mapping (bin prefix -> brand)
function detectCardBrand(number) {
  const n = number.replace(/\D/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'master';
  if (/^6(?:011|5)/.test(n)) return 'master'; // Discover ( usa rede master no MP)
  if (/^(4011|4312|4573|4574|5041|5066|5067|6277|6362|6504|6505|6516)/.test(n)) return 'elo';
  if (/^3[47]/.test(n)) return 'amex';
  return 'master'; // fallback
}

// Parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Create Order
async function handleCreateOrder(req, res) {
  const body = await parseBody(req);
  const {
    plan, paymentMethod, cardToken, installments, cardNumber,
    // Normalized payer fields (work for all payment methods)
    payerEmail, payerFirstName, payerLastName, payerDoc,
    // Address fields
    payerZipCode, payerStreet, payerStreetNumber, payerCity, payerState
  } = body;

  // Get Device ID from header
  const deviceId = req.headers['x-meli-session-id'] || '';

  if (!plan || !PLANS[plan]) {
    return sendJSON(res, 400, { error: 'Plano inválido' });
  }

  const planData = PLANS[plan];
  const idempotencyKey = uuidv4();

  try {
    let paymentMethodObj = {};

    const brand = cardNumber ? detectCardBrand(cardNumber) : 'master';

    if (paymentMethod === 'credit_card') {
      if (!cardToken) {
        return sendJSON(res, 400, { error: 'Token do cartão obrigatório' });
      }
      paymentMethodObj = {
        id: brand,
        type: 'credit_card',
        token: cardToken,
        installments: installments || 1
      };
    } else if (paymentMethod === 'pix') {
      paymentMethodObj = {
        id: 'pix',
        type: 'bank_transfer'
      };
    } else if (paymentMethod === 'boleto') {
      paymentMethodObj = {
        id: 'boleto',
        type: 'bank_transfer'
      };
    } else {
      return sendJSON(res, 400, { error: 'Método de pagamento inválido' });
    }

    // statement_descriptor based on card brand
    const brandNames = { visa: 'VISA', master: 'MASTER', elo: 'ELO', amex: 'AMEX' };
    const statementDescriptor = (brandNames[brand] || 'MASTER').substring(0, 12);

    // Build payer object
    const payer = {
      email: payerEmail || '',
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

    // Get client IP for fraud prevention
    const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';

    const orderBody = {
      type: 'online',
      processing_mode: 'automatic',
      ...(paymentMethod === 'credit_card' ? { capture_mode: 'automatic' } : {}),
      total_amount: planData.price,
      description: planData.name,
      external_reference: `martina-${plan}-${Date.now()}`,
      payer,
      additional_info: {
        'payer.registration_date': new Date().toISOString(),
        ...(clientIp ? { 'payer.ip_address': clientIp } : {})
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

    // Forward Device ID for fraud prevention
    const extraHeaders = {};
    if (deviceId) extraHeaders['X-meli-session-id'] = deviceId;

    // Use raw HTTP to bypass SDK validation (SDK rejects bank_transfer and notification_url)
    const result = await mpPost('/v1/orders', orderBody, idempotencyKey, extraHeaders);

    if (result.errors || result.status === 400) {
      const errMsg = result.errors
        ? result.errors.map(e => e.details ? e.details.join('; ') : e.message).join(' | ')
        : 'Erro ao criar order';
      throw new Error(errMsg);
    }

    sendJSON(res, 200, { id: result.id, status: result.status, detail: result });
  } catch (err) {
    console.error('Erro ao criar order:', JSON.stringify(err, null, 2));
    const errMsg = err.errors
      ? err.errors.map(e => e.details ? e.details.join('; ') : e.message).join(' | ')
      : (err.cause ? JSON.stringify(err.cause) : (err.message || 'Erro interno'));
    sendJSON(res, 500, { error: errMsg });
  }
}

// Get Order Status
async function handleGetOrder(req, res, orderId) {
  try {
    const result = await orderClient.get({ id: orderId });
    sendJSON(res, 200, { id: result.id, status: result.status, status_detail: result.status_detail });
  } catch (err) {
    console.error('Erro ao consultar order:', err);
    sendJSON(res, 500, { error: err.message || 'Erro interno' });
  }
}

// Get Public Key
function handlePublicKey(req, res) {
  sendJSON(res, 200, { publicKey: process.env.MP_PUBLIC_KEY });
}

// Validate webhook signature (HMAC SHA256)
function validateWebhookSignature(req, body) {
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!signature || !requestId) return false;

  // Extract ts and v1 from x-signature
  const parts = {};
  signature.split(',').forEach(p => {
    const [key, val] = p.split('=');
    parts[key] = val;
  });
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  // Get data.id from query params (lowercase)
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const dataId = urlObj.searchParams.get('data.id');
  if (!dataId) return false;

  // Build template: id:[data.id];request-id:[x-request-id];ts:[ts];
  const template = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;

  // Calculate HMAC SHA256
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('MP_WEBHOOK_SECRET não configurado — pulando validação HMAC');
    return true; // Skip validation if secret not set (dev mode)
  }

  const hmac = crypto.createHmac('sha256', secret).update(template).digest('hex');
  return hmac === v1;
}

// Webhook
async function handleWebhook(req, res) {
  const body = await parseBody(req);
  console.log('Webhook recebido:', JSON.stringify(body, null, 2));

  // Validate signature
  if (!validateWebhookSignature(req, body)) {
    console.warn('Webhook: assinatura inválida!');
    sendJSON(res, 401, { error: 'Invalid signature' });
    return;
  }

  // Process notification
  const orderId = body.data && body.data.id;
  const action = body.action;
  console.log(`Webhook: Order ${orderId} — ação: ${action}`);

  // After confirming receipt, fetch full order details
  if (orderId) {
    try {
      const order = await orderClient.get({ id: orderId });
      console.log(`Order ${orderId} status: ${order.status} (${order.status_detail})`);
    } catch (err) {
      console.error(`Erro ao consultar order ${orderId}:`, err.message);
    }
  }

  // Must respond 200/201 within 22 seconds
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ received: true }));
}

// Helper: send JSON
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Request handler (works both standalone and as Vercel serverless function)
const handler = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  let url = req.url.split('?')[0];

  // API Routes
  if (url === '/api/create-order' && req.method === 'POST') {
    return handleCreateOrder(req, res);
  }
  if (url === '/api/public-key' && req.method === 'GET') {
    return handlePublicKey(req, res);
  }
  if (url.startsWith('/api/order/') && req.method === 'GET') {
    const orderId = url.split('/api/order/')[1];
    return handleGetOrder(req, res, orderId);
  }
  if (url === '/webhooks/mercadopago' && req.method === 'POST') {
    return handleWebhook(req, res);
  }
  // OAuth endpoints (required for quality measurement)
  if (url === '/oauth/authorize' && req.method === 'GET') {
    res.writeHead(302, { 'Location': `https://www.mercadopago.com.br/authorization?client_id=${process.env.MP_APP_ID || ''}&response_type=code&platform_id=mp` });
    return res.end();
  }
  if (url === '/oauth/callback' && req.method === 'GET') {
    sendJSON(res, 200, { status: 'ok', message: 'OAuth callback received' });
    return;
  }

  // Static files
  if (url === '/') url = '/index.html';
  const filePath = path.join(__dirname, url);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
};

// Export for Vercel serverless
module.exports = handler;

// Local development: start server directly
if (!process.env.VERCEL) {
  const server = http.createServer(handler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}
