// server.js — Backend ESM completo y ordenado
// -------------------------------------------
// Requisitos Node 18+ (ESM). Instala dependencias:
// npm i express cors morgan stripe resend nodemailer pdfkit pg dotenv

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

// ---------------------------
// Configuración principal
// ---------------------------
const app = express();
const PORT = process.env.PORT || 10000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Marca
const BRAND = process.env.BRAND_NAME || 'Guarros Extremeños';
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#D62828';
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || ''; // URL pública del logo horizontal

// Front y CORS
const API_PUBLIC_BASE = process.env.API_PUBLIC_BASE || 'https://guarros-extremenos-api.onrender.com';
const PORTAL_RETURN_URL = process.env.CUSTOMER_PORTAL_RETURN_URL || 'https://guarrosextremenos.com/account';
const BILLING_PORTAL_CONFIG = process.env.STRIPE_BILLING_PORTAL_CONFIG || null;

// Planes de suscripción (dos niveles)
const SUB_500_PRICE_ID = process.env.SUB_500_PRICE_ID || process.env.VITE_SUB_500_PRICE_ID; // price_...
const SUB_1000_PRICE_ID = process.env.SUB_1000_PRICE_ID || process.env.VITE_SUB_1000_PRICE_ID; // price_...

// Envío de emails
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_SECURE = String(SMTP_PORT) === '465';

// Remitentes
const CUSTOMER_FROM = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
const CORPORATE_EMAIL = process.env.CORPORATE_EMAIL || process.env.SMTP_USER || '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'soporte@guarrosextremenos.com';

// Comportamiento de email
const COMBINE_CONFIRMATION_AND_INVOICE = String(process.env.COMBINE_CONFIRMATION_AND_INVOICE || 'true') !== 'false';
const ATTACH_STRIPE_INVOICE = String(process.env.ATTACH_STRIPE_INVOICE || 'false') === 'true';
const CUSTOMER_BCC_CORPORATE = String(process.env.CUSTOMER_BCC_CORPORATE || 'false') === 'true';

// Empresa (recibo PDF)
const COMPANY = {
  name: process.env.COMPANY_NAME || BRAND,
  taxId: process.env.COMPANY_TAX_ID || '',
  address: process.env.COMPANY_ADDRESS || '',
  city: process.env.COMPANY_CITY || '',
  postal: process.env.COMPANY_POSTAL || '',
  country: process.env.COMPANY_COUNTRY || 'España',
  serie: process.env.RECEIPT_SERIE || 'WEB',
};

// BBDD
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { require: true, rejectUnauthorized: false },
    })
  : null;

// ---------------------------
// Utilidades
// ---------------------------
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const fmt = (amount = 0, currency = 'EUR') => {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
};

const lineItemsHTML = (items = [], currency = 'EUR') =>
  (items || []).length
    ? items
        .map((li) => {
          const total = fmt((li.amount_total ?? li.amount ?? 0) / 100, currency);
          const unit = li?.price?.unit_amount != null ? fmt(li.price.unit_amount / 100, currency) : null;
          return `
<tr>
  <td style="padding:10px 0; font-size:14px; color:#111827;">
    ${escapeHtml(li.description || '')}
    ${unit ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">Precio unidad: ${unit}</div>` : ''}
  </td>
  <td style="padding:10px 0; font-size:14px; text-align:center; white-space:nowrap;">x${li.quantity || 1}</td>
  <td style="padding:10px 0; font-size:14px; text-align:right; white-space:nowrap;">${total}</td>
</tr>`;
        })
        .join('')
    : `<tr><td colspan="3" style="padding:8px 0;color:#6b7280">Sin productos</td></tr>`;

const emailShell = ({ title, header, body, footer }) => `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(
  title
)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
<tr><td>
<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
<tr><td style="padding:24px;text-align:center;">
  ${
    BRAND_LOGO_URL
      ? `<img src="${BRAND_LOGO_URL}" alt="${escapeHtml(BRAND)}" width="200" style="display:block;margin:0 auto 8px;max-width:200px;height:auto"/>`
      : `<div style="font-size:20px;font-weight:800;color:${BRAND_PRIMARY};text-align:center;margin-bottom:8px">${escapeHtml(
          BRAND
        )}</div>`
  }
  <div style="font:800 20px system-ui; color:${BRAND_PRIMARY}; letter-spacing:.3px">${escapeHtml(header)}</div>
</td></tr>
${body}
<tr><td style="padding:16px 24px 24px;">
  <div style="height:1px;background:#e5e7eb;margin-bottom:12px"></div>
  ${footer}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

// Botón “Gestionar suscripción”
const manageButtonHTML = (customerId) => {
  if (!customerId) return '';
  const link = `${API_PUBLIC_BASE}/billing-portal/link?customer_id=${encodeURIComponent(
    customerId
  )}&return=${encodeURIComponent(PORTAL_RETURN_URL)}`;
  return `
  <div style="text-align:center;margin:16px 0 6px;">
    <a href="${link}" style="display:inline-block;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;font-weight:800;padding:10px 16px;border-radius:10px;letter-spacing:.2px">Gestionar suscripción</a>
  </div>
  <p style="margin:6px 0 0; font:12px system-ui; color:#6b7280; text-align:center;">Puedes pausar o cancelar cuando quieras</p>`;
};

// ---------------------------
// PDF de recibo “PAGADO”
// ---------------------------
async function buildReceiptPDF({ invoiceNumber, total, currency = 'EUR', lineItems = [], customer = {}, paidAt = new Date() }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
  const bufs = [];
  const done = new Promise((res, rej) => {
    doc.on('data', (b) => bufs.push(b));
    doc.on('end', () => res(Buffer.concat(bufs)));
    doc.on('error', rej);
  });

  // Logo / marca
  try {
    if (BRAND_LOGO_URL) {
      const r = await fetch(BRAND_LOGO_URL);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        doc.image(buf, { fit: [140, 60], align: 'left' });
      } else {
        doc.font('Helvetica-Bold').fontSize(20).text(BRAND, { align: 'left' });
      }
    } else {
      doc.font('Helvetica-Bold').fontSize(20).text(BRAND, { align: 'left' });
    }
  } catch {
    doc.font('Helvetica-Bold').fontSize(20).text(BRAND, { align: 'left' });
  }

  // Título
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#D62828').text('RECIBO DE PAGO', { align: 'right' });

  // Emisor / recibo info
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#111');
  const leftX = doc.x,
    topY = doc.y;

  const emisor = [
    COMPANY.name,
    COMPANY.taxId ? `NIF: ${COMPANY.taxId}` : null,
    COMPANY.address,
    [COMPANY.postal, COMPANY.city].filter(Boolean).join(' '),
    COMPANY.country,
  ]
    .filter(Boolean)
    .join('\n');
  doc.text(emisor, leftX, topY, { width: 260 });

  const paidFmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(paidAt);
  const invText = [`Nº Recibo: ${COMPANY.serie}-${invoiceNumber || 's/n'}`, `Fecha de pago: ${paidFmt}`, `Estado: PAGADO`].join(
    '\n'
  );
  doc.text(invText, 300, topY, { align: 'right' });
  doc.moveDown(1);

  // Cliente (a la derecha)
  const addr = customer?.address || {};
  const line1 = addr.line1 || customer.line1 || '';
  const line2 = addr.line2 || customer.line2 || '';
  const postal = addr.postal_code || customer.postal || '';
  const city = addr.city || customer.city || '';
  const country = addr.country || customer.country || '';

  if (customer && (customer.name || customer.email || line1 || line2 || postal || city || country)) {
    const pageWidth = doc.page.width;
    const { right } = doc.page.margins;
    const colWidth = 260;
    const xRight = pageWidth - right - colWidth;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Cliente', xRight, doc.y, { width: colWidth, align: 'right' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10);
    const custLines = [
      customer.name,
      customer.email,
      [line1, line2].filter(Boolean).join(' '),
      [postal, city].filter(Boolean).join(' '),
      country,
    ]
      .filter(Boolean)
      .join('\n');
    doc.text(custLines || '-', xRight, doc.y, { width: colWidth, align: 'right' });
  }

  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(10);

  // Cabecera tabla (alineada)
  const xDesc = 56,
    wDesc = 280;
  const xQty = 336,
    wQty = 60;
  const xTot = 396,
    wTot = 140;

  const hOf = (text, width, options = {}) => doc.heightOfString(String(text ?? ''), { width, ...options });

  const headerY = doc.y;
  const headerH = Math.max(hOf('Concepto', wDesc), hOf('Cant.', wQty, { align: 'right' }), hOf('Total', wTot, { align: 'right' }));
  doc.text('Concepto', xDesc, headerY, { width: wDesc });
  doc.text('Cant.', xQty, headerY, { width: wQty, align: 'right' });
  doc.text('Total', xTot, headerY, { width: wTot, align: 'right' });

  const sepY = headerY + headerH + 4;
  doc.save();
  doc.lineWidth(0.7).strokeColor('#e5e7eb').moveTo(56, sepY).lineTo(536, sepY).stroke();
  doc.restore();

  // Filas
  doc.font('Helvetica').fontSize(10);

  let y = sepY + 6;
  let sumCents = 0;

  (lineItems || []).forEach((it) => {
    const desc = it.description || 'Producto';
    const qty = `x${it.quantity || 1}`;
    const totalCents = Number(it.totalCents ?? it.amount_total ?? it.amount ?? 0);
    sumCents += totalCents;
    const totalFmt = fmt(totalCents / 100, currency);

    const rowH = Math.max(hOf(desc, wDesc), hOf(qty, wQty, { align: 'right' }), hOf(totalFmt, wTot, { align: 'right' }));
    doc.text(desc, xDesc, y, { width: wDesc });
    doc.text(qty, xQty, y, { width: wQty, align: 'right' });
    doc.text(totalFmt, xTot, y, { width: wTot, align: 'right' });
    y += rowH + 2;
  });

  doc.y = y;
  doc.moveDown(0.5);
  doc.rect(56, doc.y, 480, 0.7).fill('#e5e7eb').fillColor('#111');
  doc.moveDown(0.6);

  // Total
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total pagado', 56, doc.y, { width: 340 });
  doc.text(fmt(sumCents / 100, currency), 396, doc.y, { width: 140, align: 'right' });
  doc.moveDown(0.8);

  // Sello PAGADO
  doc.save();
  doc.rotate(-10, { origin: [400, doc.y] });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#D62828');
  doc.text('PAGADO', 320, doc.y - 12, { opacity: 0.6 });
  doc.restore();

  // Nota lateral (derecha)
  doc.moveDown(1.4);
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  const pageWidth = doc.page.width;
  const { right } = doc.page.margins;
  const colWidth = 300;
  const xRightCol = pageWidth - right - colWidth;
  doc.text(
    'Este documento sirve como justificación de pago. Para información fiscal detallada, también se adjunta la factura oficial.',
    xRightCol,
    doc.y,
    { width: colWidth }
  );

  doc.end();
  return await done;
}

// ---------------------------
// Emails
// ---------------------------
async function sendSMTP({ from, to, subject, html, attachments }) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transporter.verify();
  const info = await transporter.sendMail({ from, to, subject, html, attachments });
  return info;
}

async function sendEmail({ to, subject, html, attachments, bcc = [] }) {
  if (RESEND_API_KEY) {
    const resend = new Resend(RESEND_API_KEY);
    await resend.emails.send({ from: CUSTOMER_FROM, to, subject, html, ...(bcc.length ? { bcc } : {}), attachments });
    return;
  }
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    await sendSMTP({ from: CUSTOMER_FROM, to, subject, html, attachments });
    return;
  }
  console.warn('[email] No hay proveedor configurado');
}

async function sendAdminEmail({ session, items = [], customerEmail, name, phone, amountTotal, currency, metadata = {}, shipping = {} }) {
  if (!CORPORATE_EMAIL) return;
  const subject = `🧾 ${session?.mode === 'subscription' ? 'Suscripción' : 'Pedido'} — ${session?.id || ''}`;

  const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 10px; font:15px system-ui; color:#111">Nuevo ${session?.mode === 'subscription' ? 'ALTA DE SUSCRIPCIÓN' : 'PEDIDO'}</p>
  <ul style="margin:0;padding-left:16px;color:#111;font:14px system-ui">
    <li><b>Nombre:</b> ${escapeHtml(name || '-')}</li>
    <li><b>Email:</b> ${escapeHtml(customerEmail || '-')}</li>
    <li><b>Teléfono:</b> ${escapeHtml(phone || '-')}</li>
    <li><b>Session:</b> ${escapeHtml(session?.id || '-')}</li>
    <li><b>Modo:</b> ${escapeHtml(session?.mode || '-')}</li>
  </ul>
</td></tr>
<tr><td style="padding:12px 24px 8px;"><div style="height:1px;background:#e5e7eb;"></div></td></tr>
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
        <td style="padding:12px 0; font-size:16px; color:#111; font-weight:800; text-align:right;">${fmt(
          Number(amountTotal || 0),
          currency
        )}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>`;

  const html = emailShell({
    title: 'Nuevo pedido',
    header: 'Nuevo pedido web',
    body,
    footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)} — ${new Date().toLocaleString(
      'es-ES'
    )}</p>`,
  });

  await sendEmail({ to: CORPORATE_EMAIL, subject, html });
}

async function sendCustomerConfirmationOnly({ to, name, amountTotal, currency, items, orderId, isSubscription, customerId }) {
  if (!to) return;
  const subject = isSubscription
    ? `✅ Suscripción activada ${orderId ? `#${orderId}` : ''} — ${BRAND}`
    : `✅ Confirmación de pedido ${orderId ? `#${orderId}` : ''} — ${BRAND}`;

  const intro = isSubscription
    ? `¡Gracias por suscribirte a ${BRAND}! Tu suscripción ha quedado activada correctamente.`
    : `¡Gracias por tu compra en ${BRAND}! Tu pago se ha recibido correctamente.`;

  const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111;">${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}</p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">${escapeHtml(intro)}</p>
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
        <td style="padding:12px 0; font-size:14px; color:#111; font-weight:700;">Total ${
          isSubscription ? 'primer cargo' : ''
        }</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111; font-weight:800; text-align:right;">${fmt(
          Number(amountTotal || 0),
          currency
        )}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>
${isSubscription ? `<tr><td style="padding:0 24px 8px;">${manageButtonHTML(customerId)}</td></tr>` : ''}`;

  const html = emailShell({
    title: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    header: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    body,
    footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(
      BRAND
    )}. Todos los derechos reservados.</p>`,
  });

  const bcc = CUSTOMER_BCC_CORPORATE && CORPORATE_EMAIL ? [CORPORATE_EMAIL] : [];
  await sendEmail({ to, subject, html, bcc });
}

async function sendCustomerCombined({ to, name, invoiceNumber, total, currency, items, customer, pdfUrl, isSubscription, customerId }) {
  if (!to) return;

  // Recibo propio
  const receiptBuf = await buildReceiptPDF({
    invoiceNumber,
    total,
    currency,
    lineItems: items.map((it) => ({
      description: it.description,
      quantity: it.quantity || 1,
      totalCents: it.amount_total ?? it.amount ?? 0,
    })),
    customer,
    paidAt: new Date(),
  });

  const attachments = [
    { filename: `recibo-${invoiceNumber || 'pago'}.pdf`, content: receiptBuf, contentType: 'application/pdf' },
  ];

  if (ATTACH_STRIPE_INVOICE && pdfUrl) {
    try {
      const r = await fetch(pdfUrl);
      if (r.ok) {
        const b = Buffer.from(await r.arrayBuffer());
        attachments.push({ filename: `stripe-invoice-${invoiceNumber || 'pago'}.pdf`, content: b, contentType: 'application/pdf' });
      }
    } catch (e) {
      console.warn('[combined] No se pudo descargar invoice_pdf:', e?.message || e);
    }
  }

  const subject = isSubscription ? `✅ Suscripción activada — ${BRAND}` : `✅ Confirmación de pedido — ${BRAND}`;

  const intro = isSubscription
    ? `¡Gracias por suscribirte a ${BRAND}! Tu suscripción ha quedado activada correctamente.`
    : `¡Gracias por tu compra en ${BRAND}! Tu pago se ha recibido correctamente.`;

  const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111;">${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}</p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">${escapeHtml(intro)}</p>
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
        <td style="padding:12px 0; font-size:14px; color:#111; font-weight:700;">Total ${
          isSubscription ? 'primer cargo' : ''
        }</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111; font-weight:800; text-align:right;">${fmt(
          Number(total || 0),
          currency
        )}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>
<tr><td style="padding:12px 24px 6px;">
  <p style="margin:0 0 6px; font:12px system-ui; color:#6b7280;">
    Adjuntamos tu recibo PDF${ATTACH_STRIPE_INVOICE ? ' y la factura oficial de Stripe' : ''}.
  </p>
</td></tr>
${isSubscription ? `<tr><td style="padding:0 24px 8px;">${manageButtonHTML(customerId)}</td></tr>` : ''}`;

  const html = emailShell({
    title: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    header: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    body,
    footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(
      BRAND
    )}. Todos los derechos reservados.</p>`,
  });

  await sendEmail({ to, subject, html, attachments });
}

async function sendCancelEmails({ toCustomer, customerName, customerId, subscriptionId }) {
  // Cliente
  if (toCustomer) {
    const subject = `❌ Suscripción cancelada — ${BRAND}`;
    const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111;">${customerName ? `Hola ${escapeHtml(customerName)},` : 'Hola,'}</p>
  <p style="margin:0 0 10px; font:14px system-ui; color:#374151;">Tu suscripción ha sido <strong>cancelada</strong>. No se generarán más cargos.</p>
  <p style="margin:0 0 8px; font:13px system-ui; color:#6b7280;">
    ID cliente: ${escapeHtml(customerId || '-')}, ID suscripción: ${escapeHtml(subscriptionId || '-')}
  </p>
</td></tr>`;
    const html = emailShell({
      title: 'Suscripción cancelada',
      header: 'Suscripción cancelada',
      body,
      footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(
        BRAND
      )}.</p>`,
    });
    await sendEmail({ to: toCustomer, subject, html });
  }

  // Admin
  if (CORPORATE_EMAIL) {
    const subject = `⚠️ Baja de suscripción — ${subscriptionId || ''}`;
    const body = `
<tr><td style="padding:0 24px 8px;">
  <p style="margin:0 0 10px; font:14px system-ui; color:#111;">Se ha cancelado una suscripción.</p>
  <ul style="margin:0; padding-left:16px; color:#111; font:14px system-ui;">
    <li><b>Cliente:</b> ${escapeHtml(customerName || '-')}</li>
    <li><b>Email:</b> ${escapeHtml(toCustomer || '-')}</li>
    <li><b>Customer ID:</b> ${escapeHtml(customerId || '-')}</li>
    <li><b>Subscription ID:</b> ${escapeHtml(subscriptionId || '-')}</li>
  </ul>
</td></tr>`;
    const html = emailShell({
      title: 'Baja de suscripción',
      header: 'Baja de suscripción',
      body,
      footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)} — ${new Date().toLocaleString(
        'es-ES'
      )}</p>`,
    });
    await sendEmail({ to: CORPORATE_EMAIL, subject, html });
  }
}

// ---------------------------
// CORS y parsers
// ---------------------------
const allowOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowDomains = (process.env.ALLOWED_DOMAINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const originOk = (origin) => {
  if (!origin) return true;
  if (allowOrigins.includes(origin)) return true;
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return allowDomains.some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
};

app.use(
  cors({
    origin: (origin, cb) => (originOk(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin))),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);
app.use(morgan('tiny'));
app.use(express.json());

// ---------------------------
// Endpoints públicos
// ---------------------------

// Ping de salud
app.get('/health', (req, res) => res.json({ ok: true, service: 'api', ts: new Date().toISOString() }));

// Crear sesión de checkout (compra única)
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items = [], success_url, cancel_url, customer_update } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items vacíos' });

    const line_items = items.map((it) => {
      if (it.price) return { price: it.price, quantity: it.quantity || 1 };
      if (it.priceId) return { price: it.priceId, quantity: it.quantity || 1 };
      return null;
    }).filter(Boolean);

    if (!line_items.length) return res.status(400).json({ error: 'Sin price válidos' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://guarrosextremenos.com/success',
      cancel_url: cancel_url || 'https://guarrosextremenos.com/cancel',
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      customer_creation: 'if_required', // solo permitido en mode=payment
      // customer_update: { address: 'auto' } // ⚠️ No permitido en mode=payment en algunos contexts
    });

    res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: e.message || 'Error' });
  }
});

// Crear sesión de suscripción (dos planes posibles)
app.post('/create-subscription-session', async (req, res) => {
  try {
    const { plan, customer_info = {}, success_url, cancel_url } = req.body || {};
    const priceId =
      plan === 'price_1000' || plan === SUB_1000_PRICE_ID
        ? SUB_1000_PRICE_ID
        : plan === 'price_500' || plan === SUB_500_PRICE_ID
        ? SUB_500_PRICE_ID
        : null;

    if (!priceId) return res.status(400).json({ error: 'Plan no válido' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: success_url || 'https://guarrosextremenos.com/success',
      cancel_url: cancel_url || 'https://guarrosextremenos.com/cancel',
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      subscription_data: {
        metadata: {
          source: 'guarros-front',
          ...(customer_info?.email ? { email: customer_info.email } : {}),
          ...(customer_info?.name ? { name: customer_info.name } : {}),
          ...(customer_info?.phone ? { phone: customer_info.phone } : {}),
        },
      },
      customer_update: { address: 'auto', name: 'auto' }, // permitido en suscripciones
      metadata: {
        source: 'guarros-front',
        ...(customer_info?.email ? { email: customer_info.email } : {}),
        ...(customer_info?.name ? { name: customer_info.name } : {}),
        ...(customer_info?.phone ? { phone: customer_info.phone } : {}),
      },
    });

    res.json({ url: session.url, id: session.id });
  } catch (e) {
    console.error('create-subscription-session error:', e);
    res.status(500).json({ error: e.message || 'Error' });
  }
});

// Enlace al Billing Portal (para “Gestionar suscripción”)
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

// ---------------------------
// Webhook (RAW) — Stripe
// ---------------------------
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature error:', err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotencia
  const seen = async (id) => {
    if (!pool) return true;
    const q = `INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`;
    const r = await pool.query(q, [id]);
    return r.rowCount === 1;
  };
  try {
    const fresh = await seen(event.id);
    if (!fresh) return res.status(200).json({ ok: true, dedup: true });
  } catch (e) {
    console.error('[webhook] dedup error:', e?.message || e);
  }

  console.log('[webhook] EVENT', { id: event.id, type: event.type, livemode: event.livemode, created: event.created });

  // Helpers DB
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
      o.sessionId,
      o.email || null,
      o.name || null,
      o.phone || null,
      o.amountTotal || 0,
      o.currency || 'EUR',
      JSON.stringify(o.items || []),
      JSON.stringify(o.metadata || {}),
      JSON.stringify(o.shipping || {}),
      o.status || 'paid',
      JSON.stringify(o.customer_details || {}),
    ];
    await pool.query(text, vals);
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
        sessionId,
        li.description || null,
        li.price?.product || null,
        li.price?.id || null,
        li.quantity || 1,
        li.price?.unit_amount ?? null,
        li.amount_total ?? li.amount ?? 0,
        (li.currency || currency || 'eur').toUpperCase(),
        JSON.stringify(li),
      ];
      await pool.query(text, vals);
    }
  };

  const upsertSubscriber = async ({
    customer_id,
    subscription_id = null,
    email,
    plan,
    status,
    name = null,
    phone = null,
    address = null,
    city = null,
    postal = null,
    country = null,
    meta = null,
  }) => {
    if (!pool) return null;
    const text = `
      INSERT INTO subscribers (
        customer_id, subscription_id, email, plan, status,
        name, phone, address, city, postal, country, meta,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW()
      )
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
    const values = [
      customer_id,
      subscription_id,
      email,
      plan,
      status,
      name,
      phone,
      address,
      city,
      postal,
      country,
      meta ? JSON.stringify(meta) : null,
    ];
    const { rows } = await pool.query(text, values);
    return rows[0];
  };

  const markCanceled = async (subscription_id) => {
    if (!pool) return;
    await pool.query(`UPDATE subscribers SET status='canceled', canceled_at=NOW() WHERE subscription_id=$1`, [
      subscription_id,
    ]);
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        const isSub = session.mode === 'subscription' || !!session.subscription;

        // Items del checkout
        let items = [];
        try {
          const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] });
          items = li?.data || [];
        } catch (e) {
          console.warn('[listLineItems warn]', e?.message || e);
        }

        const currency = (session.currency || 'eur').toUpperCase();
        const amountTotal = (session.amount_total ?? 0) / 100;
        const email = session.customer_details?.email || session.customer_email || null;
        const name = session.customer_details?.name || null;
        const phone = session.customer_details?.phone || null;
        const metadata = session.metadata || {};
        const shipping = session.shipping_details?.address
          ? { name: session.shipping_details?.name || null, ...session.shipping_details.address }
          : {};

        // Log pedido + items
        await logOrder({
          sessionId: session.id,
          email,
          name,
          phone,
          amountTotal,
          currency,
          items,
          metadata,
          shipping,
          status: session.payment_status || session.status || 'unknown',
          customer_details: session.customer_details || {},
        });
        await logOrderItems(session.id, items, currency);

        // Alta/actualización de suscriptor si procede
        if (isSub && session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            const cust = session.customer ? await stripe.customers.retrieve(session.customer) : null;
            await upsertSubscriber({
              customer_id: sub.customer,
              subscription_id: sub.id,
              email: cust?.email || email || null,
              name: cust?.name || name || null,
              plan: sub.items?.data?.[0]?.price?.id || null,
              status: sub.status,
              meta: sub.metadata || {},
              address: cust?.address?.line1 || null,
              city: cust?.address?.city || null,
              postal: cust?.address?.postal_code || null,
              country: cust?.address?.country || null,
            });
          } catch (e) {
            console.error('[suscripción (alta) ERROR]', e);
          }
        }

        // Email admin
        try {
          await sendAdminEmail({
            session,
            items,
            customerEmail: email,
            name,
            phone,
            amountTotal,
            currency,
            metadata,
            shipping,
          });
          console.log('📧 Email admin enviado OK');
        } catch (e) {
          console.error('📧 Email admin ERROR:', e);
        }

        // Email cliente (según combine)
        if (!COMBINE_CONFIRMATION_AND_INVOICE) {
          try {
            await sendCustomerConfirmationOnly({
              to: email,
              name,
              amountTotal,
              currency,
              items,
              orderId: session.id,
              isSubscription: isSub,
              customerId: session.customer,
            });
            console.log('📧 Email cliente enviado OK (confirmación solo)');
          } catch (e) {
            console.error('📧 Email cliente ERROR:', e);
          }
        } else {
          console.log('[combine=true] El correo al cliente se envía con invoice.payment_succeeded');
        }

        console.log('✅ checkout.session.completed', session.id);
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        let to = inv.customer_email || inv.customer_details?.email || null;
        if (!to && inv.customer) {
          try {
            const cust = await stripe.customers.retrieve(inv.customer);
            to = cust?.email || to;
          } catch {}
        }
        const name = inv.customer_name || inv.customer_details?.name || '';
        let pdfUrl = inv.invoice_pdf;
        if (!pdfUrl) {
          // reintento (a veces tarda en generarse)
          for (let i = 0; i < 3 && !pdfUrl; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            try {
              const inv2 = await stripe.invoices.retrieve(inv.id);
              pdfUrl = inv2.invoice_pdf || null;
            } catch {}
          }
        }

        // line items de la invoice
        let items = [];
        try {
          const li = await stripe.invoices.listLineItems(inv.id, { limit: 100, expand: ['data.price.product'] });
          items = li?.data || [];
        } catch (e) {
          console.warn('[invoice listLineItems warn]', e?.message || e);
        }

        // Log de invoice de suscripción (si aplica)
        if (inv.subscription && pool) {
          const text = `
            INSERT INTO subscription_invoices
              (invoice_id, subscription_id, customer_id, amount_paid, currency, invoice_number, hosted_invoice_url, invoice_pdf, lines, paid_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (invoice_id) DO NOTHING
          `;
          const vals = [
            inv.id,
            inv.subscription || null,
            inv.customer || null,
            inv.amount_paid ?? inv.amount_due ?? 0,
            (inv.currency || 'eur').toUpperCase(),
            inv.number || null,
            inv.hosted_invoice_url || null,
            inv.invoice_pdf || null,
            JSON.stringify(items || []),
            inv.status === 'paid'
              ? new Date((inv.status_transitions?.paid_at || inv.created) * 1000).toISOString()
              : null,
          ];
          await pool.query(text, vals);
        }

        if (COMBINE_CONFIRMATION_AND_INVOICE) {
          try {
            await sendCustomerCombined({
              to,
              name,
              invoiceNumber: inv.number || inv.id,
              total: (inv.amount_paid ?? inv.amount_due ?? 0) / 100,
              currency: (inv.currency || 'eur').toUpperCase(),
              items,
              customer: inv.customer_details || {},
              pdfUrl,
              isSubscription: !!inv.subscription || items.some((x) => x?.price?.recurring),
              customerId: inv.customer,
            });
            console.log('📧 Combinado enviado →', to);
          } catch (e) {
            console.error('📧 Combinado ERROR:', e);
          }
        }

        console.log('✅ invoice.payment_succeeded', inv.id);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        try {
          // Resolver email/nombre
          let email = null;
          let name = '';
          try {
            const cust = await stripe.customers.retrieve(sub.customer);
            email = cust?.email || email;
            name = cust?.name || name;
          } catch {}
          if (!email) {
            try {
              const invs = await stripe.invoices.list({ subscription: sub.id, limit: 1 });
              const inv = invs?.data?.[0];
              if (inv) {
                email = inv.customer_email || inv.customer_details?.email || email;
                name = inv.customer_name || inv.customer_details?.name || name;
              }
            } catch {}
          }
          if (!email) {
            try {
              const sessions = await stripe.checkout.sessions.list({ customer: sub.customer, limit: 5 });
              const completed = (sessions?.data || []).find((s) => s.status === 'complete') || sessions?.data?.[0];
              if (completed) {
                email = completed.customer_details?.email || completed.customer_email || email;
                name = completed.customer_details?.name || name;
              }
            } catch {}
          }
          // Marcar en DB
          await markCanceled(sub.id);
          // Emails
          await sendCancelEmails({
            toCustomer: email,
            customerName: name,
            customerId: sub.customer,
            subscriptionId: sub.id,
          });
          console.log('✅ customer.subscription.deleted', sub.id);
        } catch (e) {
          console.error('[cancel ERROR]', e?.message || e);
        }
        break;
      }

      default: {
        // Otros eventos no críticos
        // console.log('ℹ️ Evento ignorado:', event.type);
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('[webhook handler ERROR]', e);
    res.status(500).json({ error: e.message || 'Webhook error' });
  }
});

// ---------------------------
// Endpoints de test rápidos
// ---------------------------

// Test email (admin)
app.get('/test-email', async (req, res) => {
  try {
    if (!CORPORATE_EMAIL) return res.status(400).json({ ok: false, error: 'CORPORATE_EMAIL no definido' });

    const html = emailShell({
      title: 'Test',
      header: 'Prueba de correo',
      body: `<tr><td style="padding:0 24px 12px;">Esto es un test de ${escapeHtml(BRAND)}</td></tr>`,
      footer: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)}</p>`,
    });

    await sendEmail({ to: CORPORATE_EMAIL, subject: `Test ${BRAND}`, html });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

// Test conexión DB
app.get('/test-db-ping', async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ ok: false, error: 'DATABASE_URL no configurada' });
    const { rows } = await pool.query('select now() as now');
    res.json({ ok: true, now: rows[0]?.now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

// Raíz
app.get('/', (req, res) => res.status(404).send('Not found'));

// ---------------------------
// Arranque
// ---------------------------
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
