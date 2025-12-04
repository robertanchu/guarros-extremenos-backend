// server.js — Backend v3.1 (Final: Proxy + Filtro Activas + Renovaciones + Cobro Día 1)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import Stripe from 'stripe';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import pg from 'pg';
import rateLimit from 'express-rate-limit';

const { Pool } = pg;

const app = express();

// 🟢 CRÍTICO PARA RENDER: Permite que el Rate Limit funcione tras el proxy
app.set('trust proxy', 1); 

const PORT = process.env.PORT || 10000;

// ===== Stripe =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ===== Marca / Config =====
const BRAND = process.env.BRAND_NAME || 'Guarros Extremeños';
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#D62828';
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || '';
const API_PUBLIC_BASE = process.env.API_PUBLIC_BASE || 'https://guarros-extremenos-api.onrender.com';
const FRONT_BASE = (process.env.FRONT_BASE || 'https://guarrosextremenos.com').replace(/\/+$/, '');
const PORTAL_RETURN_URL = process.env.CUSTOMER_PORTAL_RETURN_URL || `${FRONT_BASE}/account`;
const BILLING_PORTAL_CONFIG = process.env.STRIPE_BILLING_PORTAL_CONFIG || null;

// customer.updated solo si ya existe suscriptor en BD
const SEND_CUSTOMER_UPDATED_ONLY_IF_KNOWN = true;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = String(SMTP_PORT) === '465';

const CUSTOMER_FROM = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
const CORPORATE_EMAIL = process.env.CORPORATE_EMAIL || process.env.SMTP_USER || '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'soporte@guarrosextremenos.com';

const COMBINE_CONFIRMATION_AND_INVOICE = String(process.env.COMBINE_CONFIRMATION_AND_INVOICE || 'true') !== 'false';
const ATTACH_STRIPE_INVOICE = String(process.env.ATTACH_STRIPE_INVOICE || 'false') === 'true';
const CUSTOMER_BCC_CORPORATE = String(process.env.CUSTOMER_BCC_CORPORATE || 'false') === 'true';

// ===== Rate Limiter (Anti-Spam) =====
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // max 5 correos por IP
  message: { error: 'Demasiados intentos, por favor espera un poco.' },
  standardHeaders: true, 
  legacyHeaders: false,
});

// ===== Tabla de precios de suscripción (centimos) =====
const SUB_PRICE_TABLE = Object.freeze({
  100: 4600, 
  200: 5800, 
  300: 6900, 
  400: 8000, 
  500: 9100, 
  600: 10300,
  700: 11400, 
  800: 12500, 
  900: 13600, 
  1000: 14800, 
  1500: 20400, 
  2000: 26000,
});
const ALLOWED_SUB_GRAMS = Object.keys(SUB_PRICE_TABLE).map(Number);

// ===== DB =====
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { require: true, rejectUnauthorized: false }, max: 5 })
  : null;

if (!pool) {
  console.error('\n🚨 [ERROR FATAL] NO SE DETECTÓ DATABASE_URL 🚨\n');
} else {
  console.log('✅ Conexión a Base de Datos configurada');
}

async function dbQuery(text, params) {
  if (!pool) throw new Error('DB query failed: No connection pool.');
  try { return await pool.query(text, params); }
  catch (e) { console.error('[DB QUERY ERROR]', e.message); throw e; }
}

// Inicialización de tablas
(async () => {
  if (!pool) return;
  await dbQuery(`CREATE TABLE IF NOT EXISTS processed_events(event_id text PRIMARY KEY, created_at timestamptz DEFAULT now())`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS mailed_invoices(invoice_id text PRIMARY KEY, sent_at timestamptz DEFAULT now())`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS orders(session_id text PRIMARY KEY, email text, name text, phone text, total numeric, currency text, items jsonb, metadata jsonb, shipping jsonb, status text, customer_details jsonb, address text, city text, postal text, country text, created_at timestamptz DEFAULT now())`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS order_items(id SERIAL PRIMARY KEY, session_id text REFERENCES orders(session_id), description text, product_id text, price_id text, quantity int, unit_amount_cents int, amount_total_cents int, currency text, raw jsonb)`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS subscribers(customer_id text PRIMARY KEY, subscription_id text, email text, plan text, status text, name text, phone text, address text, city text, postal text, country text, meta jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), canceled_at timestamptz)`);
})();

// ===== Utils =====
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const fmt = (amount = 0, currency = 'EUR') => {
  try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(Number(amount)); }
  catch { return `${Number(amount).toFixed(2)} ${currency}`; }
};
const toAbsoluteUrl = (u) => {
  if (!u) return null;
  try {
    if (/^https?:\/\//i.test(u)) return u;
    const clean = String(u).startsWith('/') ? u : `/${u}`;
    return `${FRONT_BASE}${clean}`;
  } catch { return null; }
};
const preferShippingThenBilling = (session) => {
  const billing = session?.customer_details || {};
  const shipping = session?.shipping_details || {};
  return { 
    name: shipping?.name || billing?.name || null,
    email: billing?.email || session?.customer_email || null,
    phone: billing?.phone || null,
    address: shipping?.address || billing?.address || null
  };
};
const fmtAddressHTML = (cust = {}, fallback = {}) => {
  const addr = cust?.address || fallback?.address || null;
  const lines = [cust?.name || fallback?.name, cust?.email, cust?.phone, addr?.line1, addr?.line2, [addr?.postal_code, addr?.city].filter(Boolean).join(' '), addr?.state, addr?.country].filter(Boolean);
  return lines.length ? lines.map(escapeHtml).join('<br/>') : '<em>-</em>';
};
const extractInvoiceCustomer = (inv) => ({
  name: inv?.customer_details?.name ?? inv?.customer_name ?? inv?.customer_shipping?.name ?? null,
  email: inv?.customer_details?.email ?? inv?.customer_email ?? null,
  phone: inv?.customer_details?.phone ?? null,
  address: inv?.customer_details?.address ?? inv?.customer_address ?? inv?.customer_shipping?.address ?? null
});

// ===== Email layout =====
function emailShell({ header, body, footer }) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;padding:0;background:#f3f4f6;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6; padding:24px 0;"><tr><td><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)"><tr><td style="padding:24px;text-align:center;">${BRAND_LOGO_URL ? `<img src="${BRAND_LOGO_URL}" alt="${escapeHtml(BRAND)}" width="200" style="display:block;margin:0 auto 8px;max-width:200px;height:auto"/>` : `<div style="font-size:20px;font-weight:800;color:${BRAND_PRIMARY};text-align:center;margin-bottom:8px">${escapeHtml(BRAND)}</div>`}<div style="font:800 20px system-ui; color:${BRAND_PRIMARY}; letter-spacing:.3px">${escapeHtml(header)}</div></td></tr>${body}<tr><td style="padding:16px 24px 24px;"><div style="height:1px;background:#e5e7eb;margin-bottom:12px"></div>${footer}</td></tr></table></td></tr></table></body></html>`;
}
const lineItemsHTML = (items = [], currency = 'EUR') => (items || []).length ? items.map(li => {
  const total = (li.amount_total ?? li.amount ?? 0) / 100;
  const unit = li?.price?.unit_amount != null ? (li.price.unit_amount / 100) : null;
  return `<tr><td style="padding:10px 0; font-size:14px; color:#111827;">${escapeHtml(li.description || '')}${unit ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">Precio unidad: ${unit.toLocaleString('es-ES', { style: 'currency', currency })}</div>` : ''}</td><td style="padding:10px 0; font-size:14px; text-align:center; white-space:nowrap;">x${li.quantity || 1}</td><td style="padding:10px 0; font-size:14px; text-align:right; white-space:nowrap;">${total.toLocaleString('es-ES', { style: 'currency', currency })}</td></tr>`;
}).join('') : `<tr><td colspan="3" style="padding:8px 0;color:#6b7280">Sin productos</td></tr>`;

// ===== PDF =====
async function buildReceiptPDF({ invoiceNumber, total, currency = 'EUR', customer = {}, items = [], paidAt = new Date() }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
  const bufs = [];
  const done = new Promise((res, rej) => { doc.on('data', b => bufs.push(b)); doc.on('end', () => res(Buffer.concat(bufs))); doc.on('error', rej); });
  try {
    if (BRAND_LOGO_URL) {
      const r = await fetch(BRAND_LOGO_URL);
      if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); doc.image(buf, 56, 56, { fit: [140, 60] }); }
      else doc.font('Helvetica-Bold').fontSize(20).text(BRAND, 56, 56);
    } else doc.font('Helvetica-Bold').fontSize(20).text(BRAND, 56, 56);
  } catch { doc.font('Helvetica-Bold').fontSize(20).text(BRAND, 56, 56); }

  doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND_PRIMARY).text('RECIBO DE PAGO', 56, 56, { align: 'right' });
  doc.moveDown(3.2);
  doc.font('Helvetica').fontSize(10).fillColor('#111');
  const paidFmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(paidAt);
  doc.text([`Nº Recibo: ${invoiceNumber || 's/n'}`, `Fecha de pago: ${paidFmt}`, `Estado: PAGADO`].join('\n'), 56, 56 + 70, { width: 200 });

  const addr = customer?.address || {};
  const custLines = [customer?.name, customer?.email, customer?.phone, addr.line1, addr.line2, [addr.postal_code, addr.city].filter(Boolean).join(' '), addr.state, addr.country].filter(Boolean).join('\n');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Cliente', 316, 146, { width: 220, align: 'right' });
  doc.moveDown(0.1);
  doc.font('Helvetica').fontSize(10).text(custLines || '-', 316, doc.y, { width: 220, align: 'right' });

  doc.moveDown(1.2); doc.rect(56, doc.y + 4, 480, 0.7).fill('#e5e7eb').fillColor('#111'); doc.moveDown(1.2);
  doc.font('Helvetica-Bold').fontSize(10);
  const startY = doc.y;
  doc.text('Concepto', 56, startY, { width: 280 }); doc.text('Cant.', 336, startY, { width: 60, align: 'right' }); doc.text('Total', 396, startY, { width: 140, align: 'right' });
  doc.moveDown(0.3); doc.rect(56, doc.y, 480, 0.7).fill('#e5e7eb').fillColor('#111'); doc.moveDown(0.6);

  doc.font('Helvetica').fontSize(10);
  let grand = 0;
  for (const li of (items || [])) {
    const lineTotal = (li.amount_total ?? li.amount ?? 0) / 100;
    grand += lineTotal;
    const y = doc.y;
    doc.text(li.description || '', 56, y, { width: 280 }); doc.text(String(li.quantity || 1), 336, y, { width: 60, align: 'right' }); doc.text(fmt(lineTotal, currency), 396, y, { width: 140, align: 'right' });
    doc.moveDown(0.4);
  }
  doc.moveDown(0.4); doc.rect(56, doc.y, 480, 0.7).fill('#e5e7eb').fillColor('#111'); doc.moveDown(0.6);
  doc.font('Helvetica-Bold'); doc.text('Total', 56, doc.y, { width: 280 }); doc.text(fmt(grand || total || 0, currency), 396, doc.y, { width: 140, align: 'right' });
  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text('Documento justificativo de pago.', 56, doc.y, { width: 480, align: 'right' });
  doc.end();
  return await done;
}

// ===== Email Sending =====
async function sendSMTP({ from, to, subject, html, attachments, bcc = [] }) {
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await transporter.verify();
  return transporter.sendMail({ from, to, subject, html, attachments, ...(bcc.length ? { bcc } : {}) });
}
async function sendEmail({ to, subject, html, attachments, bcc = [] }) {
  if (RESEND_API_KEY) {
    const resend = new Resend(RESEND_API_KEY);
    await resend.emails.send({ from: CUSTOMER_FROM, to, subject, html, attachments, ...(bcc.length ? { bcc } : {}) });
    return;
  }
  if (SMTP_HOST && SMTP_USER) { await sendSMTP({ from: CUSTOMER_FROM, to, subject, html, attachments, bcc }); return; }
  console.warn('[email] No provider configured');
}
async function sendAdminEmail({ session, items, customerEmail, name, phone, amountTotal, currency, customer_details, shipping }) {
  if (!CORPORATE_EMAIL) return;
  const body = `<tr><td style="padding:0 24px 8px;"><p style="margin:0 0 10px; font:15px system-ui; color:#111">Nuevo ${session?.mode === 'subscription' ? 'ALTA DE SUSCRIPCIÓN' : 'PEDIDO'}</p><ul style="margin:0;padding-left:16px;color:#111;font:14px system-ui"><li><b>Nombre:</b> ${escapeHtml(name || '-')}</li><li><b>Email:</b> ${escapeHtml(customerEmail || '-')}</li><li><b>Teléfono:</b> ${escapeHtml(phone || '-')}</li><li><b>Sesión:</b> ${escapeHtml(session?.id || '-')}</li></ul></td></tr><tr><td style="padding:8px 24px;"><div style="height:1px;background:#e5e7eb;"></div><p style="margin:8px 0 6px; font:600 13px system-ui; color:#111">Dirección</p><div style="font:13px system-ui; color:#374151">${fmtAddressHTML(customer_details || {}, { address: shipping, name })}</div></td></tr><tr><td style="padding:8px 24px 0;"><table role="presentation" width="100%">${lineItemsHTML(items, currency)}<tfoot><tr><td colspan="3"><div style="height:1px;background:#e5e7eb;"></div></td></tr><tr><td>Total</td><td></td><td align="right">${fmt(Number(amountTotal || 0), currency)}</td></tr></tfoot></table></td></tr>`;
  await sendEmail({ to: CORPORATE_EMAIL, subject: `Nuevo pedido - ${BRAND}`, html: emailShell({ header: 'Nuevo pedido web', body, footer: '' }) });
}

// 🟢 NUEVO: EMAIL AL ADMIN CUANDO SE RENUEVA (PAGO RECURRENTE)
async function sendAdminRenewalEmail({ customer, total, currency, subscriptionId, invoiceId }) {
  if (!CORPORATE_EMAIL) return;
  const subject = `🔄 Renovación suscripción — ${escapeHtml(customer.name || customer.email)}`;
  const body = `
<tr><td style="padding:0 24px 12px;">
  <p style="margin:0 0 10px; font:15px system-ui; color:#111">Se ha renovado una suscripción.</p>
  <ul style="margin:0;padding-left:16px;color:#111;font:14px system-ui">
    <li><b>Cliente:</b> ${escapeHtml(customer.name || '-')}</li>
    <li><b>Email:</b> ${escapeHtml(customer.email || '-')}</li>
    <li><b>Importe:</b> ${fmt(Number(total || 0), currency)}</li>
    <li><b>ID Suscripción:</b> ${escapeHtml(subscriptionId)}</li>
    <li><b>ID Factura:</b> ${escapeHtml(invoiceId)}</li>
  </ul>
</td></tr>`;

  const html = emailShell({
      header: 'Suscripción Renovada',
      body,
      footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)} — ${new Date().toLocaleString('es-ES')}</p>`
  });
  await sendEmail({ to: CORPORATE_EMAIL, subject, html });
}

async function sendCustomerConfirmationOnly({ to, name, amountTotal, currency, items, isSubscription, customerId, customer_details, shipping }) {
  if (!to) return;
  const intro = isSubscription ? `Suscripción activada correctamente.` : `Tu pago se ha recibido correctamente.`;
  const body = `<tr><td style="padding:0 24px 8px;"><p>Hola ${escapeHtml(name || '')},</p><p>${escapeHtml(intro)}</p></td></tr><tr><td style="padding:8px 24px;"><div style="height:1px;background:#e5e7eb;"></div><div style="font:13px system-ui;">${fmtAddressHTML(customer_details || {}, { address: shipping, name })}</div></td></tr><tr><td style="padding:8px 24px 0;"><table role="presentation" width="100%">${lineItemsHTML(items, currency)}<tfoot><tr><td>Total</td><td></td><td align="right">${fmt(Number(amountTotal || 0), currency)}</td></tr></tfoot></table></td></tr>${isSubscription ? `<tr><td style="padding:0 24px 12px; text-align:center;"><a href="${API_PUBLIC_BASE}/billing-portal/link?customer_id=${encodeURIComponent(customerId || '')}&return=${encodeURIComponent(PORTAL_RETURN_URL)}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;padding:10px 16px;border-radius:10px;">Gestionar suscripción</a></td></tr>` : ''}`;
  await sendEmail({ to, subject: 'Confirmación de pedido', html: emailShell({ header: 'Pedido confirmado', body, footer: '' }) });
}

// 🟢 MODIFICADO: Recibe flag `isRenewal` para cambiar el texto
async function sendCustomerCombined({ to, name, invoiceNumber, total, currency, items, customer, pdfUrl, isSubscription, isRenewal, customerId }) {
  if (!to) return;
  const receiptBuf = await buildReceiptPDF({ invoiceNumber, total, currency, customer, items });
  const attachments = [{ filename: `recibo-${invoiceNumber || 'pago'}.pdf`, content: receiptBuf, contentType: 'application/pdf' }];
  if (ATTACH_STRIPE_INVOICE && pdfUrl) {
    try {
      const r = await fetch(pdfUrl);
      if (r.ok) attachments.push({ filename: `factura-${invoiceNumber}.pdf`, content: Buffer.from(await r.arrayBuffer()), contentType: 'application/pdf' });
    } catch {}
  }

  // Lógica de texto dinámica
  let subject = 'Confirmación de pedido';
  let header = 'Pago recibido';
  let intro = 'Adjunto encontrarás el recibo de tu compra.';

  if (isSubscription) {
      if (isRenewal) {
        subject = '✅ Suscripción renovada';
        header = 'Suscripción renovada';
        intro = 'Hemos procesado la renovación de tu suscripción correctamente. Adjunto tienes el recibo.';
      } else {
        subject = 'Suscripción activada';
        header = 'Suscripción activada';
        intro = 'Gracias por suscribirte. Aquí tienes el recibo de tu primer pago.';
      }
  }

  const body = `<tr><td style="padding:0 24px 8px;"><p>Hola ${escapeHtml(name || '')},</p><p>${escapeHtml(intro)}</p></td></tr><tr><td style="padding:8px 24px;"><div style="height:1px;background:#e5e7eb;"></div><p style="margin:8px 0 6px; font:600 13px system-ui; color:#111">Dirección</p><div style="font:13px system-ui; color:#374151">${fmtAddressHTML(customer)}</div></td></tr><tr><td style="padding:0 24px 8px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr><tr><td style="padding:8px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui;"><thead><tr><th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Producto</th><th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Cant.</th><th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Total</th></tr></thead><tbody>${lineItemsHTML(items, currency)}</tbody><tfoot><tr><td colspan="3"><div style="height:1px;background:#e5e7eb;"></div></td></tr><tr><td style="padding:12px 0; font-size:14px; color:#111; font-weight:700;">Total ${isSubscription ? 'cuota' : ''}</td><td></td><td style="padding:12px 0; font-size:16px; color:#111; font-weight:800; text-align:right;">${fmt(Number(total || 0), currency)}</td></tr></tfoot></table></td></tr>${isSubscription ? `<tr><td style="padding:0 24px 12px; text-align:center;"><a href="${API_PUBLIC_BASE}/billing-portal/link?customer_id=${encodeURIComponent(customerId || '')}&return=${encodeURIComponent(PORTAL_RETURN_URL)}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;font-weight:800;padding:10px 16px;border-radius:10px;letter-spacing:.2px">Gestionar suscripción</a></td></tr>` : ''}`;

  await sendEmail({ to, subject, html: emailShell({ header, body, footer: '' }), attachments });
}

async function sendCancelEmails({ customerEmail, name, subId }) {
  if (customerEmail) await sendEmail({ to: customerEmail, subject: 'Suscripción cancelada', html: emailShell({ header: 'Suscripción cancelada', body: `<tr><td style="padding:0 24px;"><p>Hola ${escapeHtml(name)}, tu suscripción ${escapeHtml(subId)} ha sido cancelada.</p></td></tr>`, footer: '' }) });
}
async function sendCustomerUpdatedEmails({ cust, summaryHtml }) {
  if (cust.email) await sendEmail({ to: cust.email, subject: 'Datos actualizados', html: emailShell({ header: 'Datos actualizados', body: `<tr><td style="padding:0 24px;"><p>${summaryHtml}</p></td></tr>`, footer: '' }) });
}
async function sendContactEmails(payload) {
  const { email, subject, message } = payload;
  const bodyAdmin = `<tr><td style="padding:0 24px;"><p>Contacto de: ${escapeHtml(email)}</p><p>${escapeHtml(message)}</p></td></tr>`;
  await sendEmail({ to: CORPORATE_EMAIL, replyTo: email, subject: `Contacto: ${subject}`, html: emailShell({ header: 'Nuevo mensaje', body: bodyAdmin, footer: '' }) });
  const bodyUser = `<tr><td style="padding:0 24px;"><p>Hemos recibido tu mensaje sobre "${escapeHtml(subject)}". Te contestaremos pronto.</p></td></tr>`;
  await sendEmail({ to: email, subject: 'Mensaje recibido', html: emailShell({ header: 'Mensaje recibido', body: bodyUser, footer: '' }) });
}

// ===== Express Config =====
const allowOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => (!origin || allowOrigins.includes(origin) || origin.includes('guarrosextremenos.com') || origin.includes('vercel.app')) ? cb(null, true) : cb(new Error('CORS')),
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature']
}));
app.use(morgan('tiny'));

// Webhook (raw body)
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.error('Webhook Error:', err.message); return res.status(400).send(`Webhook Error: ${err.message}`); }

  const seen = async (id) => {
    if (!pool) return true;
    const r = await dbQuery(`INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`, [id]);
    return r.rowCount === 1;
  };
  if (!(await seen(event.id))) return res.json({ received: true, dedup: true });

  try {
    if (event.type === 'checkout.session.completed') {
       const session = event.data.object;
       const isSub = session.mode === 'subscription';
       const person = preferShippingThenBilling(session);
       const currency = (session.currency || 'eur').toUpperCase();
       const amountTotal = (session.amount_total ?? 0) / 100;
       let items = []; 
       try { items = (await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 })).data; } catch {}
       
       await logOrder({
          sessionId: session.id,
          email: person.email, name: person.name, phone: person.phone,
          amountTotal, currency, items, metadata: session.metadata, shipping: session.shipping_details,
          status: session.payment_status,
          customer_details: { name: person.name, email: person.email, phone: person.phone, address: person.address },
          address: person.address?.line1, city: person.address?.city, postal: person.address?.postal_code, country: person.address?.country
       });
       await logOrderItems(session.id, items, currency);

       if (isSub && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const cust = session.customer ? await stripe.customers.retrieve(session.customer) : null;
          await upsertSubscriber({
            customer_id: sub.customer,
            subscription_id: sub.id,
            email: cust?.email || person.email,
            name: cust?.name || person.name,
            phone: cust?.phone || person.phone,
            plan: sub.items?.data?.[0]?.price?.id,
            status: sub.status,
            meta: { ...sub.metadata },
            address: person.address?.line1, city: person.address?.city, postal: person.address?.postal_code, country: person.address?.country
          });
       }

       if (!isSub) {
         await sendAdminEmail({ session, items, customerEmail: person.email, name: person.name, amountTotal, currency, customer_details: session.customer_details, shipping: session.shipping_details });
         if (COMBINE_CONFIRMATION_AND_INVOICE) {
            await sendCustomerCombined({ to: person.email, name: person.name, invoiceNumber: session.id, total: amountTotal, currency, items, customer: person });
         } else {
            await sendCustomerConfirmationOnly({ to: person.email, name: person.name, amountTotal, currency, items, orderId: session.id });
         }
       }
    } else if (event.type === 'customer.subscription.created') {
       const sub = event.data.object;
       const cust = await stripe.customers.retrieve(sub.customer);
       await upsertSubscriber({
         customer_id: sub.customer, subscription_id: sub.id,
         email: cust.email, name: cust.name, phone: cust.phone,
         plan: sub.items?.data?.[0]?.price?.id, status: sub.status,
         meta: sub.metadata, address: cust.address?.line1, city: cust.address?.city, postal: cust.address?.postal_code, country: cust.address?.country
       });

       if (CORPORATE_EMAIL) await sendEmail({ to: CORPORATE_EMAIL, subject: 'Nueva suscripción', html: emailShell({ header: 'Nueva suscripción', body: `<tr><td>${cust.email}</td></tr>`, footer: '' }) });
       if (!COMBINE_CONFIRMATION_AND_INVOICE && cust.email) {
         await sendCustomerConfirmationOnly({ to: cust.email, name: cust.name, isSubscription: true, customerId: sub.customer, items: [] });
       }
    } else if (event.type === 'invoice.payment_succeeded') {
       const inv = event.data.object;
       
       // 🟢 DETECTAR RENOVACIÓN
       const isSubscription = !!inv.subscription;
       const billingReason = inv.billing_reason; // 'subscription_cycle' significa renovación automática
       const isRenewal = isSubscription && billingReason === 'subscription_cycle';

       const cust = extractInvoiceCustomer(inv);

       // 1. AVISAR AL ADMIN (Solo si es renovación)
       if (isRenewal) {
          await sendAdminRenewalEmail({ 
            customer: cust, 
            total: inv.amount_paid / 100, 
            currency: (inv.currency || 'eur').toUpperCase(), 
            subscriptionId: inv.subscription, 
            invoiceId: inv.number || inv.id 
          });
       }

       // 2. EMAIL AL CLIENTE (Si es combinado o renovación)
       if (COMBINE_CONFIRMATION_AND_INVOICE) {
          let items = [];
          try { items = (await stripe.invoices.listLineItems(inv.id)).data; } catch {}
          
          await sendCustomerCombined({ 
             to: cust.email, 
             name: cust.name, 
             invoiceNumber: inv.number, 
             total: inv.amount_paid/100, 
             currency: inv.currency.toUpperCase(), 
             items, 
             customer: cust, 
             pdfUrl: inv.invoice_pdf, 
             isSubscription, 
             isRenewal, // Flag para cambiar texto
             customerId: inv.customer 
          });
       }
    } else if (event.type === 'customer.subscription.deleted') {
       const sub = event.data.object;
       await markCanceled(sub.id);
       const cust = await stripe.customers.retrieve(sub.customer);
       await sendCancelEmails({ customerEmail: cust.email, name: cust.name, subId: sub.id });
    } else if (event.type === 'customer.updated') {
       const cust = event.data.object;
       if (await subscriberExists(cust.id)) {
          const summary = summarizeCustomerChanges(event.data.previous_attributes, cust);
          await sendCustomerUpdatedEmails({ cust, summaryHtml: summary });
       }
    }
  } catch (e) { console.error('Webhook Logic Error:', e); }

  res.json({ received: true });
});

app.use(express.json());

// ===== RUTAS PÚBLICAS =====

// 1. Configuración (Precios dinámicos)
app.get('/api/config', (req, res) => {
  res.json({
    subscriptionTable: SUB_PRICE_TABLE, 
    allowedGrams: ALLOWED_SUB_GRAMS,
  });
});

// 2. Resolver Precios
app.post('/prices/resolve', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Ids required' });
  try {
    const results = await Promise.allSettled(ids.map(id => stripe.prices.retrieve(id, { expand: ['product'] })));
    const prices = {};
    results.forEach(r => { if(r.status === 'fulfilled') prices[r.value.id] = { id: r.value.id, unit_amount: r.value.unit_amount, currency: r.value.currency }; });
    res.json({ prices });
  } catch { res.status(500).json({ error: 'Error resolving prices' }); }
});

// 3. Recuperar Suscripción (Magic Link: Solo Activas)
app.post('/api/recover-subscription', contactLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    const customers = await stripe.customers.list({ email, limit: 5, expand: ['data.subscriptions'] });

    if (!customers.data.length) {
      await new Promise(r => setTimeout(r, 1000));
      return res.json({ ok: true });
    }

    const linksData = await Promise.all(customers.data.map(async (c) => {
       const hasActive = c.subscriptions?.data?.some(s => ['active', 'trialing', 'past_due'].includes(s.status));
       if (!hasActive) return null;

       try {
         const session = await stripe.billingPortal.sessions.create({ customer: c.id, return_url: PORTAL_RETURN_URL });
         const addr = c.shipping?.address || c.address;
         const label = addr ? `${addr.line1} (${addr.city || ''})` : 'Sin dirección';
         
         const sub = c.subscriptions.data.find(s => ['active', 'trialing', 'past_due'].includes(s.status));
         const price = sub ? (sub.plan.amount/100) + '€' : '';

         return { url: session.url, label: `Suscripción activa ${price ? `(${price})` : ''} — ${label}` };
       } catch { return null; }
    }));

    const validLinks = linksData.filter(Boolean);

    if (validLinks.length) {
      const btns = validLinks.map(l => `
        <div style="margin:16px 0; background:#f9fafb; padding:12px; border-radius:8px; border:1px solid #e5e7eb;">
          <p style="margin:0 0 8px; font-weight:bold; color:#333;">${escapeHtml(l.label)}</p>
          <a href="${l.url}" style="display:inline-block; background:${BRAND_PRIMARY}; color:#fff; padding:10px 16px; text-decoration:none; border-radius:6px; font-weight:bold;">Gestionar</a>
        </div>`).join('');
      
      const html = emailShell({ 
        header: 'Tus suscripciones', 
        body: `<tr><td style="padding:0 24px 12px;">
          <p style="margin:0 0 16px;">Aquí tienes el acceso a tus suscripciones <b>activas</b>:</p>
          ${btns}
        </td></tr>`, 
        footer: '' 
      });
      
      await sendEmail({ to: email, subject: 'Gestión de suscripciones', html });
    }
    res.json({ ok: true });

  } catch (e) { 
    console.error(e); 
    res.status(500).json({ error: 'Error' }); 
  }
});

// 4. Contacto
app.post('/api/contact', contactLimiter, (req, res) => {
  const { email, subject, message } = req.body;
  if (!email || !message) return res.status(400).json({ error: 'Faltan datos' });
  res.json({ ok: true });
  sendContactEmails(req.body);
});

// 5. Create Checkout
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, success_url, cancel_url, metadata } = req.body;
    const line_items = [];
    for (const it of items) {
       const price = await stripe.prices.retrieve(it.price);
       line_items.push({ price: it.price, quantity: it.quantity });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', line_items, success_url, cancel_url,
      allow_promotion_codes: true, billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['ES', 'FR', 'PT', 'DE', 'IT', 'BE', 'NL'] },
      metadata: { source: 'front', ...metadata }
    });
    res.json({ url: session.url, id: session.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. Create Subscription (COBRO EL DÍA 1)
app.post('/create-subscription-session', async (req, res) => {
  try {
    const { grams, success_url, cancel_url, metadata } = req.body;
    const g = Number(grams);
    if (!ALLOWED_SUB_GRAMS.includes(g)) return res.status(400).json({ error: 'Gramos inválidos' });
    
    // --- CÁLCULO FECHA COBRO (DÍA 1 SIGUIENTE MES) ---
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    nextMonth.setHours(12, 0, 0, 0); // Evitar problemas de zona horaria
    const anchorTimestamp = Math.floor(nextMonth.getTime() / 1000);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ 
        quantity: 1,
        price_data: { 
          currency: 'eur', 
          unit_amount: SUB_PRICE_TABLE[g], 
          recurring: { interval: 'month' }, 
          product_data: { name: `Suscripción Jamón Canalla — ${g} g/mes` } 
        } 
      }],
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['ES', 'FR', 'PT', 'DE', 'IT', 'BE', 'NL'] },
      metadata: { subscription_grams: String(g), ...metadata },
      // 🟢 ANCLAJE DE FACTURACIÓN AL DÍA 1
      subscription_data: {
        billing_cycle_anchor: anchorTimestamp,
      },
      success_url, cancel_url
    });
    res.json({ url: session.url, id: session.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/billing-portal/link', async (req, res) => {
  try {
    const { customer_id, return: ret } = req.query;
    if (!customer_id) return res.status(400).send('Missing customer_id');
    const session = await stripe.billingPortal.sessions.create({ customer: customer_id, return_url: ret || PORTAL_RETURN_URL });
    res.redirect(session.url);
  } catch { res.status(500).send('Error'); }
});

app.get('/test-email', async (req, res) => {
  if (!CORPORATE_EMAIL) return res.status(400).json({ error: 'No corporate email' });
  await sendEmail({ to: CORPORATE_EMAIL, subject: 'Test', html: 'Test OK' });
  res.json({ ok: true });
});

app.get('/', (req, res) => res.status(404).send('Not found'));
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));