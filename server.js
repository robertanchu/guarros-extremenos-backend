// server.js — pedidos y suscripciones con emails (alta, cobro, cancelación) y recibo PDF
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import Stripe from 'stripe';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import pg from 'pg';
const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 10000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ===== Marca / Config =====
const BRAND = process.env.BRAND_NAME || 'Guarros Extremeños';
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#D62828';
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || '';
const API_PUBLIC_BASE = process.env.API_PUBLIC_BASE || 'https://guarros-extremenos-api.onrender.com';
const FRONT_BASE = (process.env.FRONT_BASE || 'https://guarrosextremenos.com').replace(/\/+$/, '');
const PORTAL_RETURN_URL = process.env.CUSTOMER_PORTAL_RETURN_URL || `${FRONT_BASE}/account`;
const BILLING_PORTAL_CONFIG = process.env.STRIPE_BILLING_PORTAL_CONFIG || null;

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

// ===== Tabla de precios de suscripción (centimos) =====
const SUB_PRICE_TABLE = Object.freeze({
  100: 4600, 200: 5800, 300: 6900, 400: 8000, 500: 9100, 600: 10300,
  700: 11400, 800: 12500, 900: 13600, 1000: 14800, 1500: 20400, 2000: 26000,
});
const ALLOWED_SUB_GRAMS = Object.keys(SUB_PRICE_TABLE).map(Number);

// ===== DB =====
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { require: true, rejectUnauthorized: false }, max: 5 })
  : null;

async function dbQuery(text, params) {
  if (!pool) return { rows: [], rowCount: 0 };
  try { return await pool.query(text, params); }
  catch (e) { console.error('[DB ERROR]', e?.message || e); return { rows: [], rowCount: 0, error: e }; }
}

// Crea tablas de idempotencia si no existen
(async () => {
  if (!pool) return;
  await dbQuery(`CREATE TABLE IF NOT EXISTS processed_events(
    event_id text PRIMARY KEY,
    created_at timestamptz DEFAULT now()
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS mailed_invoices(
    invoice_id text PRIMARY KEY,
    sent_at timestamptz DEFAULT now()
  )`);
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
  const address = shipping?.address || billing?.address || null;
  const name = shipping?.name || billing?.name || null;
  const phone = billing?.phone || null;
  const email = billing?.email || session?.customer_email || null;
  return { name, email, phone, address };
};

const fmtAddressHTML = (cust = {}, fallback = {}) => {
  const addr =
    cust?.address ||
    fallback?.address ||
    null;
  const lines = [
    cust?.name || fallback?.name,
    cust?.email,
    cust?.phone,
    addr?.line1,
    addr?.line2,
    [addr?.postal_code, addr?.city].filter(Boolean).join(' '),
    addr?.state,
    addr?.country
  ].filter(Boolean);
  if (!lines.length) return '<em>-</em>';
  return lines.map(escapeHtml).join('<br/>');
};

const extractInvoiceCustomer = (inv) => {
  // Robusto: distintos campos según versión/flujo
  const name =
    inv?.customer_details?.name ??
    inv?.customer_name ??
    inv?.customer_shipping?.name ??
    null;

  const email =
    inv?.customer_details?.email ??
    inv?.customer_email ??
    null;

  const phone =
    inv?.customer_details?.phone ??
    null;

  const address =
    inv?.customer_details?.address ??
    inv?.customer_address ??
    inv?.customer_shipping?.address ??
    null;

  return { name, email, phone, address };
};

// ===== Email layout =====
function emailShell({ title, header, body, footer }) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
  <body style="margin:0;padding:0;background:#f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr><td>
      <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
        <tr><td style="padding:24px;text-align:center;">
          ${BRAND_LOGO_URL ? `<img src="${BRAND_LOGO_URL}" alt="${escapeHtml(BRAND)}" width="200" style="display:block;margin:0 auto 8px;max-width:200px;height:auto"/>` : `<div style="font-size:20px;font-weight:800;color:${BRAND_PRIMARY};text-align:center;margin-bottom:8px">${escapeHtml(BRAND)}</div>`}
          <div style="font:800 20px system-ui; color:${BRAND_PRIMARY}; letter-spacing:.3px">${escapeHtml(header)}</div>
        </td></tr>
        ${body}
        <tr><td style="padding:16px 24px 24px;"><div style="height:1px;background:#e5e7eb;margin-bottom:12px"></div>${footer}</td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

const lineItemsHTML = (items = [], currency = 'EUR') =>
  (items || []).length
    ? items.map(li => {
      const total = (li.amount_total ?? li.amount ?? 0) / 100;
      const unit = li?.price?.unit_amount != null ? (li.price.unit_amount / 100) : null;
      return `<tr>
  <td style="padding:10px 0; font-size:14px; color:#111827;">${escapeHtml(li.description || '')}${unit ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">Precio unidad: ${unit.toLocaleString('es-ES', { style: 'currency', currency })}</div>` : ''}</td>
  <td style="padding:10px 0; font-size:14px; text-align:center; white-space:nowrap;">x${li.quantity || 1}</td>
  <td style="padding:10px 0; font-size:14px; text-align:right; white-space:nowrap;">${total.toLocaleString('es-ES', { style: 'currency', currency })}</td>
</tr>`;
    }).join('')
    : `<tr><td colspan="3" style="padding:8px 0;color:#6b7280">Sin productos</td></tr>`;

// ===== PDF =====
async function buildReceiptPDF({ invoiceNumber, total, currency = 'EUR', customer = {}, items = [], paidAt = new Date() }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
  const bufs = [];
  const done = new Promise((res, rej) => { doc.on('data', b => bufs.push(b)); doc.on('end', () => res(Buffer.concat(bufs))); doc.on('error', rej); });

  try {
    if (BRAND_LOGO_URL) {
      const r = await fetch(BRAND_LOGO_URL);
      if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); doc.image(buf, 56, 56, { fit: [140, 60] }); }
      else { doc.font('Helvetica-Bold').fontSize(20).text(BRAND, 56, 56); }
    } else { doc.font('Helvetica-Bold').fontSize(20).text(BRAND, 56, 56); }
  } catch { doc.font('Helvetica-Bold').fontSize(20).text(BRAND, 56, 56); }

  doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND_PRIMARY).text('RECIBO DE PAGO', 56, 56, { align: 'right' });
  doc.moveDown(3.2);

  doc.font('Helvetica').fontSize(10).fillColor('#111');
  const paidFmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(paidAt);
  const invText = [`Nº Recibo: ${invoiceNumber || 's/n'}`, `Fecha de pago: ${paidFmt}`, `Estado: PAGADO`].join('\n');
  doc.text(invText, 56, 56 + 70, { width: 200 });

  // Cliente (derecha)
  const addr = customer?.address || {};
  const custLines = [
    customer?.name,
    customer?.email,
    customer?.phone,
    addr.line1,
    addr.line2,
    [addr.postal_code, addr.city].filter(Boolean).join(' '),
    addr.state,
    addr.country
  ].filter(Boolean).join('\n');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Cliente', 316, 146, { width: 220, align: 'right' });
  doc.moveDown(0.1);
  doc.font('Helvetica').fontSize(10).text(custLines || '-', 316, doc.y, { width: 220, align: 'right' });

  doc.moveDown(1.2);
  doc.rect(56, doc.y + 4, 480, 0.7).fill('#e5e7eb').fillColor('#111');
  doc.moveDown(1.2);

  // Cabecera tabla
  doc.font('Helvetica-Bold').fontSize(10);
  const startY = doc.y;
  doc.text('Concepto', 56, startY, { width: 280 });
  doc.text('Cant.', 336, startY, { width: 60, align: 'right' });
  doc.text('Total', 396, startY, { width: 140, align: 'right' });
  doc.moveDown(0.3);
  doc.rect(56, doc.y, 480, 0.7).fill('#e5e7eb').fillColor('#111');
  doc.moveDown(0.6);

  // Líneas
  doc.font('Helvetica').fontSize(10);
  let grand = 0;
  for (const li of (items || [])) {
    const qty = li.quantity || 1;
    const desc = li.description || '';
    const lineTotal = (li.amount_total ?? li.amount ?? 0) / 100;
    grand += lineTotal;
    const y = doc.y;
    doc.text(desc, 56, y, { width: 280 });
    doc.text(String(qty), 336, y, { width: 60, align: 'right' });
    doc.text(fmt(lineTotal, currency), 396, y, { width: 140, align: 'right' });
    doc.moveDown(0.4);
  }

  // Total
  doc.moveDown(0.4);
  doc.rect(56, doc.y, 480, 0.7).fill('#e5e7eb').fillColor('#111');
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold');
  doc.text('Total', 56, doc.y, { width: 280 });
  doc.text(fmt(grand || total || 0, currency), 396, doc.y, { width: 140, align: 'right' });
  doc.moveDown(1.2);

  // Nota
  doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(
    'Este documento sirve como justificación de pago. Para información fiscal consulte la factura de Stripe adjunta (si procede).',
    56, doc.y, { width: 480, align: 'right' }
  );

  doc.end();
  return await done;
}

// ===== Email =====
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
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) { await sendSMTP({ from: CUSTOMER_FROM, to, subject, html, attachments, bcc }); return; }
  console.warn('[email] No provider configured');
}

// Email admin (altas / pedidos)
async function sendAdminEmail({ session, items = [], customerEmail, name, phone, amountTotal, currency, customer_details, shipping }) {
  if (!CORPORATE_EMAIL) return;
  const subject = (session?.mode === 'subscription' ? 'Suscripción' : 'Pedido') + ' - ' + (session?.id || '');
  const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 10px; font:15px system-ui; color:#111">Nuevo ${session?.mode === 'subscription' ? 'ALTA DE SUSCRIPCIÓN' : 'PEDIDO'}</p>
  <ul style="margin:0;padding-left:16px;color:#111;font:14px system-ui">
    <li><b>Nombre:</b> ${escapeHtml(name || '-')}</li>
    <li><b>Email:</b> ${escapeHtml(customerEmail || '-')}</li>
    <li><b>Teléfono:</b> ${escapeHtml(phone || '-')}</li>
    <li><b>Sesión:</b> ${escapeHtml(session?.id || '-')}</li>
    <li><b>Modo:</b> ${escapeHtml(session?.mode || '-')}</li>
  </ul>
</td></tr>
<tr><td style="padding:8px 24px;">
  <div style="height:1px;background:#e5e7eb;"></div>
  <p style="margin:8px 0 6px; font:600 13px system-ui; color:#111">Dirección</p>
  <div style="font:13px system-ui; color:#374151">${fmtAddressHTML(customer_details || {}, { address: shipping, name })}</div>
</td></tr>
<tr><td style="padding:8px 24px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Total</th>
      </tr>
    </thead>
    <tbody>${lineItemsHTML(items, currency)}</tbody>
    <tfoot>
      <tr><td colspan="3"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
      <tr>
        <td style="padding:12px 0; font-size:14px; color:#111; font-weight:700;">Total</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111; font-weight:800; text-align:right;">${fmt(Number(amountTotal || 0), currency)}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>`;
  const html = emailShell({ title: 'Nuevo pedido', header: 'Nuevo pedido web', body, footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)} — ${new Date().toLocaleString('es-ES')}</p>` });
  await sendEmail({ to: CORPORATE_EMAIL, subject, html });
}

// Email cliente (confirmación sin adjunto)
async function sendCustomerConfirmationOnly({ to, name, amountTotal, currency, items, orderId, isSubscription, customerId, customer_details, shipping }) {
  if (!to) return;
  const subject = (isSubscription ? 'Confirmación suscripción' : 'Confirmación de pedido') + (orderId ? ' #' + orderId : '') + ' — ' + BRAND;
  const intro = isSubscription ? `Gracias por suscribirte a ${BRAND}. Tu suscripción ha quedado activada correctamente.` : `Gracias por tu compra en ${BRAND}. Tu pago se ha recibido correctamente.`;
  const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111;">${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}</p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">${escapeHtml(intro)}</p>
</td></tr>
<tr><td style="padding:8px 24px;">
  <div style="height:1px;background:#e5e7eb;"></div>
  <p style="margin:8px 0 6px; font:600 13px system-ui; color:#111">Dirección</p>
  <div style="font:13px system-ui; color:#374151">${fmtAddressHTML(customer_details || {}, { address: shipping, name })}</div>
</td></tr>
<tr><td style="padding:0 24px 8px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 24px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Total</th>
      </tr>
    </thead>
    <tbody>${lineItemsHTML(items, currency)}</tbody>
    <tfoot>
      <tr><td colspan="3"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
      <tr>
        <td style="padding:12px 0; font-size:14px; color:#111; font-weight:700;">Total ${isSubscription ? 'primer cargo' : ''}</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111; font-weight:800; text-align:right;">${fmt(Number(amountTotal || 0), currency)}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>
${isSubscription ? `<tr><td style="padding:0 24px 12px; text-align:center;"><a href="${API_PUBLIC_BASE}/billing-portal/link?customer_id=${encodeURIComponent(customerId || '')}&return=${encodeURIComponent(PORTAL_RETURN_URL)}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;font-weight:800;padding:10px 16px;border-radius:10px;letter-spacing:.2px">Gestionar suscripción</a></td></tr>` : ''}`;
  const html = emailShell({ title: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido', header: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido', body, footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(BRAND)}. Todos los derechos reservados.</p>` });
  const bcc = CUSTOMER_BCC_CORPORATE && CORPORATE_EMAIL ? [CORPORATE_EMAIL] : [];
  await sendEmail({ to, subject, html, bcc });
}

// Email cliente (combinado con PDF propio y opcional factura Stripe)
async function sendCustomerCombined({ to, name, invoiceNumber, total, currency, items, customer, pdfUrl, isSubscription, customerId }) {
  if (!to) return;
  const receiptBuf = await buildReceiptPDF({ invoiceNumber, total, currency, customer, items, paidAt: new Date() });
  const attachments = [{ filename: `recibo-${invoiceNumber || 'pago'}.pdf`, content: receiptBuf, contentType: 'application/pdf' }];
  if (ATTACH_STRIPE_INVOICE && pdfUrl) {
    try {
      const r = await fetch(pdfUrl);
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); attachments.push({ filename: `stripe-invoice-${invoiceNumber || 'pago'}.pdf`, content: b, contentType: 'application/pdf' }); }
    } catch { }
  }
  const subject = (isSubscription ? 'Confirmación suscripción' : 'Confirmación de pedido') + ' — ' + BRAND;
  const intro = isSubscription ? `Gracias por suscribirte a ${BRAND}. Tu suscripción ha quedado activada correctamente.` : `Gracias por tu compra en ${BRAND}. Tu pago se ha recibido correctamente.`;
  const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111;">${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}</p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">${escapeHtml(intro)}</p>
</td></tr>
<tr><td style="padding:8px 24px;">
  <div style="height:1px;background:#e5e7eb;"></div>
  <p style="margin:8px 0 6px; font:600 13px system-ui; color:#111">Dirección</p>
  <div style="font:13px system-ui; color:#374151">${fmtAddressHTML(customer)}</div>
</td></tr>
<tr><td style="padding:0 24px 8px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 24px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Total</th>
      </tr>
    </thead>
    <tbody>${lineItemsHTML(items, currency)}</tbody>
    <tfoot>
      <tr><td colspan="3"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
      <tr>
        <td style="padding:12px 0; font-size:14px; color:#111; font-weight:700;">Total ${isSubscription ? 'primer cargo' : ''}</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111; font-weight:800; text-align:right;">${fmt(Number(total || 0), currency)}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>
${isSubscription ? `<tr><td style="padding:0 24px 12px; text-align:center;"><a href="${API_PUBLIC_BASE}/billing-portal/link?customer_id=${encodeURIComponent(customerId || '')}&return=${encodeURIComponent(PORTAL_RETURN_URL)}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;font-weight:800;padding:10px 16px;border-radius:10px;letter-spacing:.2px">Gestionar suscripción</a></td></tr>` : ''}`;
  const html = emailShell({ title: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido', header: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido', body, footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(BRAND)}. Todos los derechos reservados.</p>` });
  await sendEmail({ to, subject, html, attachments });
}

// ===== Email cancelación (cliente + admin)
async function sendCancelEmails({ customerEmail, name, subId, customerAddress, isFromUpdated=false }) {
  const subject = `🛑 Suscripción cancelada — ${BRAND}`;
  const bodyCustomer = `
<tr><td style="padding:0 24px 12px;">
  <p style="margin:0 0 10px; font:15px system-ui; color:#111;">${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}</p>
  <p style="margin:0 0 10px; font:14px system-ui; color:#374151;">Hemos procesado la cancelación de tu suscripción.</p>
  <p style="margin:0 0 10px; font:13px system-ui; color:#6b7280;">ID suscripción: <b>${escapeHtml(subId || '-')}</b></p>
  <div style="height:1px;background:#e5e7eb;margin:10px 0;"></div>
  <p style="margin:0 0 6px; font:600 13px system-ui; color:#111">Tus datos</p>
  <div style="font:13px system-ui; color:#374151">${fmtAddressHTML({ address: customerAddress, name, email: customerEmail })}</div>
</td></tr>`.trim();

  const htmlCustomer = emailShell({
    title: 'Suscripción cancelada',
    header: 'Suscripción cancelada',
    body: bodyCustomer,
    footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">Si no reconoces esta acción, responde a este correo o escríbenos a ${escapeHtml(SUPPORT_EMAIL)}.</p>`
  });

  // Cliente
  if (customerEmail) {
    await sendEmail({ to: customerEmail, subject, html: htmlCustomer });
  }

  // Admin
  if (CORPORATE_EMAIL) {
    const bodyAdmin = `
<tr><td style="padding:0 24px 12px;">
  <p style="margin:0 0 10px; font:15px system-ui; color:#111;">Se ha cancelado una suscripción${isFromUpdated ? ' (vía customer.subscription.updated)' : ''}.</p>
  <ul style="margin:0;padding-left:16px;color:#111;font:14px system-ui">
    <li><b>ID suscripción:</b> ${escapeHtml(subId || '-')}</li>
    <li><b>Nombre:</b> ${escapeHtml(name || '-')}</li>
    <li><b>Email:</b> ${escapeHtml(customerEmail || '-')}</li>
  </ul>
  <div style="height:1px;background:#e5e7eb;margin:10px 0;"></div>
  <p style="margin:0 0 6px; font:600 13px system-ui; color:#111">Dirección</p>
  <div style="font:13px system-ui; color:#374151">${fmtAddressHTML({ address: customerAddress, name, email: customerEmail })}</div>
</td></tr>`.trim();

    const htmlAdmin = emailShell({
      title: 'Suscripción cancelada',
      header: 'Suscripción cancelada',
      body: bodyAdmin,
      footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)} — ${new Date().toLocaleString('es-ES')}</p>`
    });

    await sendEmail({ to: CORPORATE_EMAIL, subject: `Cancelación suscripción — ${BRAND}`, html: htmlAdmin });
  }
}

async function fetchCustomerBasics(customerId) {
  if (!customerId) return { email: null, name: null, address: null };
  try {
    const cust = await stripe.customers.retrieve(customerId);
    return {
      email: cust?.email || null,
      name: cust?.name || null,
      address: cust?.address || null,
    };
  } catch {
    return { email: null, name: null, address: null };
  }
}

// ===== CORS / logging =====
const allowOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowDomains = (process.env.ALLOWED_DOMAINS || 'guarrosextremenos.com,vercel.app').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const originOk = (origin) => {
  if (!origin) return true;
  if (allowOrigins.includes(origin)) return true;
  try { const h = new URL(origin).hostname.toLowerCase(); return allowDomains.some(d => h === d || h.endsWith('.' + d)); } catch { return false; }
};
app.use(cors({
  origin: (origin, cb) => (originOk(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin))),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature'],
  maxAge: 600,
}));
app.use(morgan('tiny'));

// ===== RAW body para webhook =====
app.use('/webhook', express.raw({ type: '*/*' }));

app.get('/health', (req, res) => res.json({ ok: true, service: 'api', ts: new Date().toISOString() }));

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature error:', err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotencia por evento
  const seen = async (id) => {
    if (!pool) return true;
    const q = `INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`;
    const r = await dbQuery(q, [id]); if (r?.error) return true; return r.rowCount === 1;
  };
  try { const fresh = await seen(event.id); if (!fresh) return res.status(200).json({ ok: true, dedup: true }); }
  catch (e) { console.error('[webhook] dedup error:', e?.message || e); }

  console.log('[webhook] EVENT', { id: event.id, type: event.type, livemode: event.livemode, created: event.created });

  const markInvoiceMailedOnce = async (invoiceId) => {
    if (!pool || !invoiceId) return true;
    const r = await dbQuery(`INSERT INTO mailed_invoices(invoice_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING invoice_id`, [invoiceId]);
    return r?.rowCount === 1; // true => primera vez; false => ya enviado
  };

  const logOrder = async (o) => {
    if (!pool) return;
    const text = `
      INSERT INTO orders (session_id, email, name, phone, total, currency, items, metadata, shipping, status, customer_details, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
      ON CONFLICT (session_id) DO UPDATE SET
        email=EXCLUDED.email, name=EXCLUDED.name, phone=EXCLUDED.phone,
        total=EXCLUDED.total, currency=EXCLUDED.currency, items=EXCLUDED.items,
        metadata=EXCLUDED.metadata, shipping=EXCLUDED.shipping, status=EXCLUDED.status,
        customer_details=EXCLUDED.customer_details
    `;
    const vals = [
      o.sessionId, o.email || null, o.name || null, o.phone || null,
      o.amountTotal || 0, o.currency || 'EUR',
      JSON.stringify(o.items || []), JSON.stringify(o.metadata || {}),
      JSON.stringify(o.shipping || {}), o.status || 'paid',
      JSON.stringify(o.customer_details || {}),
    ];
    await dbQuery(text, vals);
  };

  const logOrderItems = async (sessionId, items, currency) => {
    if (!pool || !Array.isArray(items)) return;
    const text = `
      INSERT INTO order_items
        (session_id, description, product_id, price_id, quantity, unit_amount_cents, amount_total_cents, currency, raw)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT DO NOTHING
    `;
    for (const li of items) {
      const vals = [
        sessionId, li.description || null, li.price?.product || null, li.price?.id || null,
        li.quantity || 1, li.price?.unit_amount ?? null, li.amount_total ?? li.amount ?? 0,
        (li.currency || currency || 'eur').toUpperCase(), JSON.stringify(li),
      ];
      await dbQuery(text, vals);
    }
  };

  const upsertSubscriber = async ({ customer_id, subscription_id = null, email, plan, status, name = null, phone = null, address = null, city = null, postal = null, country = null, meta = null }) => {
    if (!pool) return null;
    const text = `
      INSERT INTO subscribers (customer_id, subscription_id, email, plan, status, name, phone, address, city, postal, country, meta, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW())
      ON CONFLICT (customer_id) DO UPDATE SET
        subscription_id = COALESCE(EXCLUDED.subscription_id, subscribers.subscription_id),
        email  = COALESCE(EXCLUDED.email,  subscribers.email),
        plan   = COALESCE(EXCLUDED.plan,   subscribers.plan),
        status = COALESCE(EXCLUDED.status, subscribers.status),
        name   = COALESCE(EXCLUDED.name,   subscribers.name),
        phone  = COALESCE(EXCLUDED.phone,  subscribers.phone),
        address= COALESCE(EXCLUDED.address,subscribers.address),
        city   = COALESCE(EXCLUDED.city,   subscribers.city),
        postal = COALESCE(EXCLUDED.postal, subscribers.postal),
        country= COALESCE(EXCLUDED.country,subscribers.country),
        meta   = COALESCE(EXCLUDED.meta,   subscribers.meta),
        updated_at = NOW()
      RETURNING *;
    `;
    const values = [customer_id, subscription_id, email, plan, status, name, phone, address, city, postal, country, meta ? JSON.stringify(meta) : null];
    const { rows } = await dbQuery(text, values);
    return rows?.[0] || null;
  };

  const markCanceled = async (subscription_id) => { if (!pool) return; await dbQuery(`UPDATE subscribers SET status='canceled', canceled_at=NOW() WHERE subscription_id=$1`, [subscription_id]); };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const isSub = session.mode === 'subscription' || !!session.subscription;

        // Persona/dirección prioritizando envío
        const person = preferShippingThenBilling(session);

        const currency = (session.currency || 'eur').toUpperCase();
        const amountTotal = (session.amount_total ?? 0) / 100;
        const email = person.email || null;
        const name = person.name || null;
        const phone = person.phone || null;
        const metadata = session.metadata || {};
        const shipping = session.shipping_details?.address
          ? { name: session.shipping_details?.name || null, ...session.shipping_details.address }
          : null;

        // Líneas
        let items = [];
        try {
          const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] });
          items = li?.data || [];
        } catch (e) { console.warn('[listLineItems warn]', e?.message || e); }

        await logOrder({
          sessionId: session.id,
          email, name, phone,
          amountTotal, currency,
          items, metadata, shipping,
          status: session.payment_status || session.status || 'unknown',
          customer_details: { name: person.name, email: person.email, phone: person.phone, address: person.address || null },
        });
        await logOrderItems(session.id, items, currency);

        // Alta suscriptor (si aplica)
        if (isSub && session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            const cust = session.customer ? await stripe.customers.retrieve(session.customer) : null;
            await upsertSubscriber({
              customer_id: sub.customer,
              subscription_id: sub.id,
              email: cust?.email || email || null,
              name: cust?.name || name || null,
              plan: sub.items?.data?.[0]?.price?.id || (sub.metadata?.subscription_grams ? `g${sub.metadata.subscription_grams}` : null),
              status: sub.status,
              meta: { ...sub.metadata },
              address: (cust?.address?.line1 || person?.address?.line1 || null),
              city: (cust?.address?.city || person?.address?.city || null),
              postal: (cust?.address?.postal_code || person?.address?.postal_code || null),
              country: (cust?.address?.country || person?.address?.country || null),
            });
          } catch (e) { console.error('[suscripción alta ERROR]', e); }
        }

        // Admin siempre
        try {
          await sendAdminEmail({
            session, items, customerEmail: email, name, phone,
            amountTotal, currency,
            customer_details: { name: person.name, email: person.email, phone: person.phone, address: person.address || null },
            shipping: session.shipping_details || {},
          });
        } catch (e) { console.error('Email admin ERROR:', e); }

        // Cliente:
        if (!isSub) {
          // One-off: siempre aquí
          try {
            if (COMBINE_CONFIRMATION_AND_INVOICE) {
              await sendCustomerCombined({
                to: email, name,
                invoiceNumber: session.id, total: amountTotal, currency,
                items,
                customer: { name: person.name, email: person.email, phone: person.phone, address: person.address || null },
                pdfUrl: null,
                isSubscription: false,
                customerId: session.customer,
              });
            } else {
              await sendCustomerConfirmationOnly({
                to: email, name, amountTotal, currency, items, orderId: session.id,
                isSubscription: false, customerId: session.customer,
                customer_details: { name: person.name, email: person.email, phone: person.phone, address: person.address || null },
                shipping: session.shipping_details || {},
              });
            }
          } catch (e) { console.error('Email cliente ONE-OFF ERROR:', e); }
        } else {
          // Suscripción:
          //   COMBINE=true => NO enviar aquí (solo en invoice.payment_succeeded)
          //   COMBINE=false => enviar confirmación aquí
          if (!COMBINE_CONFIRMATION_AND_INVOICE) {
            try {
              await sendCustomerConfirmationOnly({
                to: email, name, amountTotal, currency, items, orderId: session.id,
                isSubscription: true, customerId: session.customer,
                customer_details: { name: person.name, email: person.email, phone: person.phone, address: person.address || null },
                shipping: session.shipping_details || {},
              });
            } catch (e) { console.error('Email cliente SUBS (confirmación) ERROR:', e); }
          }
        }

        res.status(200).json({ received: true });
        return;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;

        // Idempotencia por factura: si ya enviamos, salimos
        const firstTime = await markInvoiceMailedOnce(inv.id);
        if (!firstTime) { return res.status(200).json({ received: true, mailed: 'skipped-duplicate' }); }

        // Cliente/dirección robusto
        const customerForPdf = extractInvoiceCustomer(inv);
        let to = customerForPdf.email;
        if (!to && inv.customer) {
          try { const cust = await stripe.customers.retrieve(inv.customer); to = cust?.email || to; } catch {}
        }
        const name = customerForPdf.name || '';

        // Adjuntar PDF de Stripe (opcional)
        let pdfUrl = inv.invoice_pdf;
        if (!pdfUrl) {
          for (let i = 0; i < 3 && !pdfUrl; i++) {
            await new Promise(r => setTimeout(r, 3000));
            try { const inv2 = await stripe.invoices.retrieve(inv.id); pdfUrl = inv2.invoice_pdf || null; } catch { }
          }
        }

        // Líneas
        let items = [];
        try { const li = await stripe.invoices.listLineItems(inv.id, { limit: 100, expand: ['data.price.product'] }); items = li?.data || []; }
        catch (e) { console.warn('[invoice listLineItems warn]', e?.message || e); }

        if (COMBINE_CONFIRMATION_AND_INVOICE) {
          try {
            await sendCustomerCombined({
              to,
              name,
              invoiceNumber: inv.number || inv.id,
              total: (inv.amount_paid ?? inv.amount_due ?? 0) / 100,
              currency: (inv.currency || 'eur').toUpperCase(),
              items,
              customer: customerForPdf,
              pdfUrl,
              isSubscription: !!inv.subscription || items.some(x => x?.price?.recurring),
              customerId: inv.customer,
            });
          } catch (e) { console.error('Combinado ERROR:', e); }
        }

        res.status(200).json({ received: true });
        return;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        try { await markCanceled(sub.id); } catch (e) { console.error('[cancel ERROR]', e?.message || e); }
        try {
          const basics = await fetchCustomerBasics(sub.customer);
          await sendCancelEmails({
            customerEmail: basics.email,
            name: basics.name,
            subId: sub.id,
            customerAddress: basics.address,
          });
        } catch (e) { console.error('[cancel email ERROR]', e?.message || e); }
        res.status(200).json({ received: true });
        return;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const prev = event.data.previous_attributes || {};
        if (sub?.status === 'canceled' || prev?.status === 'canceled') {
          try { await markCanceled(sub.id); } catch (e) { console.error('[cancel mark (updated) ERROR]', e?.message || e); }
          try {
            const basics = await fetchCustomerBasics(sub.customer);
            await sendCancelEmails({
              customerEmail: basics.email,
              name: basics.name,
              subId: sub.id,
              customerAddress: basics.address,
              isFromUpdated: true,
            });
          } catch (e) { console.error('[cancel (updated) email ERROR]', e?.message || e); }
        }
        res.status(200).json({ received: true });
        return;
      }

      default:
        return res.status(200).json({ received: true });
    }
  } catch (e) {
    console.error('[webhook handler FATAL]', e);
    res.status(200).json({ received: true, soft_error: true });
  }
});

// ===== JSON normal después de /webhook =====
app.use(express.json());

// ===== Checkout one-off =====
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items = [], success_url, cancel_url, metadata = {} } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items vacíos' });

    const line_items = [];
    for (const it of items) {
      const priceId = it.price || it.priceId;
      if (!priceId) continue;
      const price = await stripe.prices.retrieve(String(priceId), { expand: ['product'] });

      const imgAbs = toAbsoluteUrl(it.image);
      const product_data = { name: String(it.title || it.name || price.product?.name || 'Producto') };
      if (imgAbs) { try { new URL(imgAbs); product_data.images = [imgAbs]; } catch { } }

      line_items.push({
        quantity: it.quantity || 1,
        price_data: {
          currency: (price.currency || 'eur').toLowerCase(),
          unit_amount: price.unit_amount,
          product_data,
        },
      });
    }
    if (!line_items.length) return res.status(400).json({ error: 'Sin price válidos' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || `${FRONT_BASE}/success`,
      cancel_url: cancel_url || `${FRONT_BASE}/cancel`,
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['ES', 'FR', 'DE', 'IT', 'PT', 'BE', 'NL', 'IE', 'GB'] },
      phone_number_collection: { enabled: true },
      metadata: { source: 'guarros-front', ...metadata },
    });

    res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: e.message || 'Error' });
  }
});

// ===== Checkout suscripción =====
app.options('/create-subscription-session', cors());
app.post('/create-subscription-session', async (req, res) => {
  try {
    const { grams, currency = 'eur', metadata = {}, success_url, cancel_url } = req.body || {};
    const g = Number(grams);
    if (!g || !ALLOWED_SUB_GRAMS.includes(g)) return res.status(400).json({ error: 'Cantidad inválida. Debe ser una de: ' + ALLOWED_SUB_GRAMS.join(', ') });
    const amount = SUB_PRICE_TABLE[g];

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amount,
          recurring: { interval: 'month' },
          product_data: { name: `Suscripción Jamón Canalla — ${g} g/mes` },
        },
      }],
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['ES', 'FR', 'DE', 'IT', 'PT', 'BE', 'NL', 'IE', 'GB'] },
      phone_number_collection: { enabled: true },
      success_url: success_url || `${FRONT_BASE}/success`,
      cancel_url: cancel_url || `${FRONT_BASE}/cancel`,
      metadata: { ...metadata, source: 'guarros-front', subscription_grams: String(g), pricing_model: 'fixed_table_g' },
    });

    return res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error('create-subscription-session error:', e);
    res.status(500).json({ error: e.message || 'Error' });
  }
});

// ===== Portal de cliente =====
app.get('/billing-portal/link', async (req, res) => {
  try {
    const { customer_id, return: ret } = req.query;
    if (!customer_id) return res.status(400).send('customer_id requerido');
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url: ret || PORTAL_RETURN_URL,
      ...(BILLING_PORTAL_CONFIG ? { configuration: BILLING_PORTAL_CONFIG } : {}),
    });
    res.redirect(portalSession.url);
  } catch (e) {
    console.error('billing-portal/link error:', e);
    res.status(500).send('Error creating portal session.');
  }
});

// ===== Test email =====
app.get('/test-email', async (req, res) => {
  try {
    if (!CORPORATE_EMAIL) return res.status(400).json({ ok: false, error: 'CORPORATE_EMAIL no definido' });
    const html = emailShell({ title: 'Test', header: 'Prueba de correo', body: `<tr><td style="padding:0 24px 12px;">Esto es un test de ${escapeHtml(BRAND)}</td></tr>`, footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)}</p>` });
    await sendEmail({ to: CORPORATE_EMAIL, subject: 'Test ' + BRAND, html });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message || 'error' }); }
});

app.get('/', (req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => { console.log(`API listening on :${PORT}`); });
