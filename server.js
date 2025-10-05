// server.js (ESM, completo)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import Stripe from 'stripe';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import pg from 'pg';
import PDFDocument from 'pdfkit';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ====== ENV / Marca ======
const BRAND = process.env.BRAND_NAME || "Guarros Extremeños";
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#D62828';
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || '';
const API_PUBLIC_BASE = process.env.API_PUBLIC_BASE || 'https://guarros-extremenos-api.onrender.com';
const PORTAL_RETURN_URL = process.env.CUSTOMER_PORTAL_RETURN_URL || 'https://guarrosextremenos.com/account';
const BILLING_PORTAL_CONFIG = process.env.STRIPE_BILLING_PORTAL_CONFIG || null;

// ====== CORS ======
const exactOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const baseDomains = (process.env.ALLOWED_DOMAINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isOriginAllowed(origin) {
  if (!origin) return true;
  try {
    if (exactOrigins.includes(origin)) return true;
    const u = new URL(origin);
    const host = (u.hostname || '').toLowerCase();
    return baseDomains.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}
const corsOptions = {
  origin: (origin, cb) => isOriginAllowed(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
};

// ====== DB ======
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { require: true, rejectUnauthorized: false } })
  : null;

// ====== Utils ======
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function currencyFormat(amount = 0, currency = 'EUR') {
  try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(Number(amount)); }
  catch { return `${Number(amount).toFixed(2)} ${(currency||'EUR').toUpperCase()}`; }
}
function formatLineItemsHTML(lineItems = [], currency = 'EUR') {
  if (!Array.isArray(lineItems) || !lineItems.length)
    return '<tr><td colspan="3" style="padding:8px 0;color:#6b7280">No hay productos.</td></tr>';
  return lineItems.map(li => {
    const total = currencyFormat((li.amount_total ?? li.amount ?? 0)/100, currency);
    const unit = li?.price?.unit_amount != null ? currencyFormat(li.price.unit_amount/100, currency) : null;
    return `
      <tr>
        <td style="padding:10px 0; font-size:14px; color:#111827;">
          ${escapeHtml(li.description || '')}
          ${unit ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">Precio unidad: ${unit}</div>` : ``}
        </td>
        <td style="padding:10px 0; font-size:14px; color:#111827; text-align:center; white-space:nowrap;">x${li.quantity || 1}</td>
        <td style="padding:10px 0; font-size:14px; color:#111827; text-align:right; white-space:nowrap;">${total}</td>
      </tr>
    `;
  }).join('');
}
function emailShell({ title, headerLabel, bodyHTML, footerHTML }) {
  const logoBlock = BRAND_LOGO_URL
    ? `<img src="${BRAND_LOGO_URL}" alt="${escapeHtml(BRAND)}" width="200" style="display:block; max-width:200px; width:100%; height:auto; margin:0 auto 8px;" />`
    : `<div style="font-size:20px; font-weight:700; color:${BRAND_PRIMARY}; text-align:center; margin-bottom:8px;">${escapeHtml(BRAND)}</div>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escapeHtml(title)}</title></head>
<body style="margin:0; padding:0; background:#f3f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6; padding:24px 0;">
    <tr><td>
      <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:24px; text-align:center; background:#ffffff;">
          ${logoBlock}
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif; font-size:22px; font-weight:800; color:${BRAND_PRIMARY}; letter-spacing:0.3px;">${escapeHtml(headerLabel)}</div>
        </td></tr>
        ${bodyHTML}
        <tr><td style="padding:16px 24px 24px; background:#ffffff;">
          <div style="height:1px; background:#e5e7eb; margin-bottom:12px;"></div>
          ${footerHTML}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
// boolean helper
function bool(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return ['true','1','yes','y','on'].includes(s);
}

// ====== PDF Recibo Propio ======
async function createPaidReceiptPDF({ invoiceNumber, total, currency='EUR', lineItems=[], customer={}, paidAt=new Date(), brand=BRAND, logoUrl=BRAND_LOGO_URL }) {
  const addrObj = (customer.address && typeof customer.address === 'object') ? customer.address : null;
  const line1   = addrObj?.line1 || (typeof customer.address === 'string' ? customer.address : '') || customer.line1 || '';
  const line2   = addrObj?.line2 || customer.line2 || '';
  const city    = customer.city || addrObj?.city || '';
  const state   = customer.state || addrObj?.state || '';
  const postal  = customer.postal || customer.postal_code || addrObj?.postal_code || customer.zip || '';
  const country = customer.country || addrObj?.country || '';
  const cityLine   = [postal, city || state].filter(Boolean).join(' ');
  const addressStr = [line1, line2, cityLine, country].filter(Boolean).join('\n');

  const items = (lineItems || []).map(li => ({
    description: li?.description || 'Producto',
    quantity: li?.quantity || 1,
    totalCents: Number(li?.amount_total ?? li?.amount ?? 0),
    unitCents: (li?.price?.unit_amount ?? null),
    currency: (li?.currency || currency || 'EUR').toUpperCase()
  }));

  const company = {
    name: process.env.COMPANY_NAME || brand || 'Tu Empresa',
    taxId: process.env.COMPANY_TAX_ID || '',
    address: process.env.COMPANY_ADDRESS || '',
    city: process.env.COMPANY_CITY || '',
    postal: process.env.COMPANY_POSTAL || '',
    country: process.env.COMPANY_COUNTRY || 'España',
    serie: process.env.RECEIPT_SERIE || 'WEB',
  };

  const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', chunks.push.bind(chunks));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  try {
    if (logoUrl) {
      const resp = await fetch(logoUrl);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        doc.image(buf, { fit: [140, 60], align: 'left' });
      } else {
        doc.font('Helvetica-Bold').fontSize(20).fillColor('#000').text(brand, { align: 'left' });
      }
    } else {
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#000').text(brand, { align: 'left' });
    }
  } catch {
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#000').text(brand, { align: 'left' });
  }

  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#D62828').text('RECIBO DE PAGO', { align: 'right' });

  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#111');
  const leftX = doc.x, topY = doc.y;

  const emisor = [
    company.name,
    company.taxId ? `NIF: ${company.taxId}` : null,
    company.address,
    [company.postal, company.city].filter(Boolean).join(' '),
    company.country
  ].filter(Boolean).join('\n');
  doc.text(emisor, leftX, topY, { width: 260 });

  const rightX = 300;
  const paidFmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(paidAt);
  const invText = [
    `Nº Recibo: ${company.serie}-${invoiceNumber || 's/n'}`,
    `Fecha de pago: ${paidFmt}`,
    `Estado: PAGADO`,
  ].join('\n');
  doc.text(invText, rightX, topY, { align: 'right' });
  doc.moveDown(1);

  // Cliente (alineado derecha, con dirección)
  if (customer && (customer.name || customer.email || addressStr)) {
    const pageWidth = doc.page.width;
    const { right } = doc.page.margins;
    const colWidth = 260;
    const xRight   = pageWidth - right - colWidth;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
       .text('Cliente', xRight, doc.y, { width: colWidth, align: 'right' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#111');
    const custLines = [
      customer.name,
      customer.email,
      addressStr || null
    ].filter(Boolean).join('\n');
    doc.text(custLines || '-', xRight, doc.y, { width: colWidth, align: 'right' });
  }

  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(10);

  const xDesc = 56,  wDesc = 280;
  const xQty  = 336, wQty  = 60;
  const xTot  = 396, wTot  = 140;

  const hOf = (text, width, options = {}) =>
    doc.heightOfString(String(text ?? ''), { width, ...options });

  const headerY = doc.y;
  const h1 = hOf('Concepto', wDesc, { align: 'left'  });
  const h2 = hOf('Cant.',    wQty,  { align: 'right' });
  const h3 = hOf('Total',    wTot,  { align: 'right' });
  const headerH = Math.max(h1, h2, h3);

  doc.text('Concepto', xDesc, headerY, { width: wDesc, align: 'left'  });
  doc.text('Cant.',    xQty,  headerY, { width: wQty,  align: 'right' });
  doc.text('Total',    xTot,  headerY, { width: wTot,  align: 'right' });

  const sepY = headerY + headerH + 4;
  doc.save();
  doc.lineWidth(0.7).strokeColor('#e5e7eb')
     .moveTo(56, sepY).lineTo(56 + 480, sepY).stroke();
  doc.restore();

  doc.font('Helvetica').fontSize(10);

  let y = sepY + 6;
  let sumCents = 0;

  items.forEach((it) => {
    const desc = it.description || 'Producto';
    const qty  = `x${it.quantity || 1}`;
    const totalCents = Number(it.totalCents || 0);
    sumCents += totalCents;
    const totalFmt = currencyFormat(totalCents / 100, (it.currency || currency));

    const hDesc = hOf(desc, wDesc, { align: 'left'  });
    const hQty  = hOf(qty,  wQty,  { align: 'right' });
    const hTot  = hOf(totalFmt, wTot, { align: 'right' });

    const rowHeight = Math.max(hDesc, hQty, hTot);
    const padY = 2;

    doc.text(desc,      xDesc, y, { width: wDesc, align: 'left'  });
    doc.text(qty,       xQty,  y, { width: wQty,  align: 'right' });
    doc.text(totalFmt,  xTot,  y, { width: wTot,  align: 'right' });

    y += rowHeight + padY;
  });

  doc.y = y;

  doc.moveDown(0.5);
  doc.rect(56, doc.y, 480, 0.7).fill('#e5e7eb').fillColor('#111');
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(11);
  const sumFmt = currencyFormat(sumCents / 100, (currency || 'EUR'));
  doc.text('Total pagado', 56, doc.y, { width: 340, align: 'left' });
  doc.text(sumFmt,        396, doc.y, { width: 140, align: 'right' });
  doc.moveDown(0.8);

  doc.save();
  doc.rotate(-10, { origin: [400, doc.y] });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#D62828');
  doc.text('PAGADO', 320, doc.y - 12, { opacity: 0.6 });
  doc.restore();

  doc.moveDown(1.6);
  doc.font('Helvetica').fontSize(9).fillColor('#444');

  const pageWidth = doc.page.width;
  const { right } = doc.page.margins;
  const colWidth = 300;
  const xRightCol = pageWidth - right - colWidth;

  doc.text(
    'Este documento sirve como justificación de pago. Para información fiscal detallada, también se adjunta la factura oficial.',
    xRightCol,
    doc.y,
    { width: colWidth, align: 'left' }
  );

  doc.end();
  return await done;
}

// ====== Email / Envío ======
async function sendViaGmailSMTP({ from, to, subject, text, html, attachments }) {
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(port) === '465';
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port, secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: true, debug: true,
  });
  await transporter.verify();
  const info = await transporter.sendMail({ from, to, subject, text, html, attachments });
  console.log('[smtp] Message sent:', info.messageId, 'accepted:', info.accepted, 'rejected:', info.rejected);
  return info;
}

function manageSubscriptionButtonHTML(customerId) {
  if (!customerId) return '';
  const link = `${API_PUBLIC_BASE}/billing-portal/link?customer_id=${encodeURIComponent(customerId)}&return=${encodeURIComponent(PORTAL_RETURN_URL)}`;
  return `
    <div style="text-align:center; margin:16px 0 6px;">
      <a href="${link}"
         style="display:inline-block; background:${BRAND_PRIMARY};
                color:#fff; text-decoration:none; font-weight:700;
                padding:10px 16px; border-radius:10px; letter-spacing:.2px">
        Gestionar suscripción
      </a>
    </div>
    <p style="margin:6px 0 0; font:12px system-ui; color:#6b7280; text-align:center;">
      Puedes pausar o cancelar cuando quieras
    </p>
  `;
}

// === Email Confirmación (COMBINE=false) ===
async function sendCustomerEmail({ to, name, amountTotal, currency, lineItems, orderId, supportEmail, brand, isSubscription, customerId }) {
  if (!to) { console.warn('[email cliente] Falta "to"'); return; }
  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const replyTo = process.env.SUPPORT_EMAIL || supportEmail || 'soporte@guarrosextremenos.com';
  const totalFmt = currencyFormat(Number(amountTotal || 0), currency || 'EUR');
  const itemsHTML = formatLineItemsHTML(lineItems, currency || 'EUR');

  const wantBcc = String(process.env.CUSTOMER_BCC_CORPORATE || '').toLowerCase() === 'true';
  const corp = (process.env.CORPORATE_EMAIL || '').toLowerCase();
  const dest = String(to || '').toLowerCase();
  const bccList = wantBcc && corp && corp !== dest ? [process.env.CORPORATE_EMAIL] : [];

  const subject = isSubscription
    ? `✅ Suscripción activada ${orderId ? `#${orderId}` : ''} — ${brand || BRAND}`
    : `✅ Confirmación de pedido ${orderId ? `#${orderId}` : ''} — ${brand || BRAND}`;

  const intro = isSubscription
    ? `¡Gracias por suscribirte a ${brand || BRAND}! Tu suscripción ha quedado activada correctamente.`
    : `¡Gracias por tu compra en ${brand || BRAND}! Tu pago se ha recibido correctamente.`;

  const afterTableNote = `
  <tr><td style="padding:12px 24px 0; background:#ffffff;">
    <p style="margin:0 0 6px; font:13px system-ui; color:#374151;">
      ${isSubscription
        ? 'Tu suscripción se renovará automáticamente cada mes.'
        : 'En breve prepararemos tu pedido.'}
    </p>
  </td></tr>
  ${isSubscription ? `<tr><td style="padding:0 24px 8px; background:#ffffff;">${manageSubscriptionButtonHTML(customerId)}</td></tr>` : ''}
  <tr><td style="padding:0 24px 0; background:#ffffff;">
    <p style="margin:0 0 6px; font:13px system-ui; color:#374151;">
      Si necesitas cualquier ayuda, responde a este correo o escríbenos a <strong>soporte@guarrosextremenos.com</strong>.
    </p>
  </td></tr>
`;

  const bodyHTML = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111827;">${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}</p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">${escapeHtml(intro)}</p>
</td></tr>
<tr><td style="padding:0 24px 8px; background:#ffffff;"><div style="height:1px; background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 24px 0; background:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Total</th>
      </tr>
    </thead>
    <tbody>${itemsHTML}</tbody>
    <tfoot>
      <tr><td colspan="3"><div style="height:1px; background:#e5e7eb;"></div></td></tr>
      <tr>
        <td style="padding:12px 0; font-size:14px; color:#111827; font-weight:700;">Total ${isSubscription ? 'primer cargo' : ''}</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111827; font-weight:800; text-align:right;">${escapeHtml(totalFmt)}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>
${afterTableNote}`;

  const html = emailShell({
    title: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    headerLabel: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    bodyHTML,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand || BRAND)}. Todos los derechos reservados.</p>`
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from,
      to,
      ...(bccList.length ? { bcc: bccList } : {}),
      reply_to: replyTo,
      subject,
      html
    });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, html });
    return;
  }
  console.warn('[email cliente] Sin proveedor email configurado');
}

// === Email Combinado (COMBINE=true) ===
async function sendCustomerOrderAndInvoiceEmail({
  to, name, invoiceNumber, total, currency, pdfUrl,
  lineItems = [], brand = BRAND, isSubscription = false,
  alsoBccCorporate = false, customer = {}, customerId
}) {
  if (!to) return;

  const receiptBuffer = await createPaidReceiptPDF({
    invoiceNumber, total, currency, lineItems, customer, paidAt: new Date(), brand, logoUrl: BRAND_LOGO_URL,
  });
  const attachments = [{ filename: `recibo-${invoiceNumber || 'pago'}.pdf`, content: receiptBuffer, contentType: 'application/pdf' }];

  const ATTACH_STRIPE_INVOICE = String(process.env.ATTACH_STRIPE_INVOICE || 'false') === 'true';
  if (ATTACH_STRIPE_INVOICE && pdfUrl) {
    try {
      const resp = await fetch(pdfUrl);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        attachments.push({ filename: `stripe-invoice-${invoiceNumber || 'pago'}.pdf`, content: buf, contentType: 'application/pdf' });
      }
    } catch (e) { console.warn('[email combine] No se pudo descargar invoice_pdf:', e?.message || e); }
  }

  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const wantBcc = alsoBccCorporate && process.env.CORPORATE_EMAIL;
  const subject = isSubscription
    ? `✅ Suscripción activada ${invoiceNumber ? `#${invoiceNumber}` : ''} — ${brand || BRAND}`
    : `✅ Confirmación de pedido ${invoiceNumber ? `#${invoiceNumber}` : ''} — ${brand || BRAND}`;

  const intro = isSubscription
    ? `¡Gracias por suscribirte a ${brand || BRAND}! Tu suscripción ha quedado activada correctamente.`
    : `¡Gracias por tu compra en ${brand || BRAND}! Tu pago se ha recibido correctamente.`;

  const totalFmt = currencyFormat(Number(total || 0), currency || 'EUR');
  const itemsHTML = formatLineItemsHTML(lineItems, currency || 'EUR');

  const afterAttachmentsNote = `
  <tr><td style="padding:12px 24px 6px; background:#ffffff;">
    <p style="margin:0 0 6px; font:12px system-ui; color:#6b7280;">
      Adjuntamos tu recibo en PDF${ATTACH_STRIPE_INVOICE ? ' y la factura oficial de Stripe' : ''}.
    </p>
  </td></tr>
  ${isSubscription ? `<tr><td style="padding:0 24px 8px; background:#ffffff;">${manageSubscriptionButtonHTML(customerId)}</td></tr>` : ''}
  <tr><td style="padding:0 24px 0; background:#ffffff;">
    <p style="margin:0 0 6px; font:13px system-ui; color:#374151;">
      Si necesitas cualquier ayuda, responde a este correo o escríbenos a <strong>soporte@guarrosextremenos.com</strong>.
    </p>
  </td></tr>`;

  const bodyHTML = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111827;">${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}</p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">${escapeHtml(intro)}</p>
</td></tr>
<tr><td style="padding:0 24px 8px; background:#ffffff;"><div style="height:1px; background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 24px 0; background:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Total</th>
      </tr>
    </thead>
    <tbody>${itemsHTML}</tbody>
    <tfoot>
      <tr><td colspan="3"><div style="height:1px; background:#e5e7eb;"></div></td></tr>
      <tr>
        <td style="padding:12px 0; font-size:14px; color:#111827; font-weight:700;">Total ${isSubscription ? 'primer cargo' : ''}</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111827; font-weight:800; text-align:right;">${escapeHtml(totalFmt)}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>
${afterAttachmentsNote}`;

  const html = emailShell({
    title: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    headerLabel: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    bodyHTML,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand || BRAND)}. Todos los derechos reservados.</p>`
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from, to, ...(wantBcc ? { bcc: [process.env.CORPORATE_EMAIL] } : {}), subject, html, attachments });
  } else if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, html, attachments });
  } else {
    console.warn('[email combine] Sin proveedor email configurado');
  }
}

// Email interno admin
async function sendAdminEmail({
  session,
  lineItems = [],
  customerEmail,
  name,
  phone,
  amountTotal,
  currency = 'EUR',
  metadata = {},
  shipping = {}
}) {
  const to = process.env.CORPORATE_EMAIL || process.env.SMTP_USER;
  if (!to) { console.warn('[sendAdminEmail] CORPORATE_EMAIL/SMTP_USER no definido'); return; }

  const from = process.env.CORPORATE_FROM || process.env.CUSTOMER_FROM || 'no-reply@guarrosextremenos.com';
  const subject = `🧾 Nuevo ${session?.mode === 'subscription' ? 'alta de suscripción' : 'pedido'} — ${session?.id || ''}`;
  const itemsHTML = formatLineItemsHTML(lineItems, currency);
  const totalFmt = currencyFormat(Number(amountTotal || 0), currency);

  const metaHTML = Object.entries(metadata || {})
    .filter(([k,v]) => v != null && v !== '')
    .map(([k,v]) => `<li><b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}</li>`)
    .join('');

  const shipHTML = Object.entries(shipping || {})
    .filter(([k,v]) => v != null && v !== '')
    .map(([k,v]) => `<li><b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}</li>`)
    .join('');

  const whoHTML = `
    <ul style="margin:0; padding-left:16px; color:#111827; font:14px system-ui;">
      <li><b>Nombre:</b> ${escapeHtml(name || '-')}</li>
      <li><b>Email:</b> ${escapeHtml(customerEmail || '-')}</li>
      <li><b>Teléfono:</b> ${escapeHtml(phone || '-')}</li>
      <li><b>Session ID:</b> ${escapeHtml(session?.id || '-')}</li>
      <li><b>Modo:</b> ${escapeHtml(session?.mode || '-')}</li>
    </ul>
    ${metaHTML ? `<p style="margin:10px 0 0; font:13px system-ui; color:#374151;"><b>Metadata:</b></p><ul style="margin:6px 0 0; padding-left:16px; font:13px system-ui; color:#374151;">${metaHTML}</ul>` : ''}
    ${shipHTML ? `<p style="margin:10px 0 0; font:13px system-ui; color:#374151;"><b>Shipping:</b></p><ul style="margin:6px 0 0; padding-left:16px; font:13px system-ui; color:#374151;">${shipHTML}</ul>` : ''}
  `;

  const bodyHTML = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111827;">
    Nuevo ${session?.mode === 'subscription' ? 'ALTA DE SUSCRIPCIÓN' : 'PEDIDO'} desde la web.
  </p>
  ${whoHTML}
</td></tr>

<tr><td style="padding:12px 24px 8px; background:#ffffff;"><div style="height:1px; background:#e5e7eb;"></div></td></tr>

<tr><td style="padding:8px 24px 0; background:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase;">Total</th>
      </tr>
    </thead>
    <tbody>${itemsHTML}</tbody>
    <tfoot>
      <tr><td colspan="3"><div style="height:1px; background:#e5e7eb;"></div></td></tr>
      <tr>
        <td style="padding:12px 0; font-size:14px; color:#111827; font-weight:700;">Total</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111827; font-weight:800; text-align:right;">${escapeHtml(totalFmt)}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>`;

  const html = emailShell({
    title: 'Nuevo pedido',
    headerLabel: 'Nuevo pedido web',
    bodyHTML,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(BRAND)} — ${new Date().toLocaleString('es-ES')}</p>`
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from, to, subject, html });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, html });
    return;
  }
  console.warn('[sendAdminEmail] sin proveedor email configurado');
}

// === Emails al cancelar suscripción (cliente + admin)
async function sendSubscriptionCanceledEmails({
  toCustomer, customerName, customerId, subscriptionId,
  corporateEmail,
  brand = BRAND
}) {
  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const corpTo = corporateEmail || process.env.CORPORATE_EMAIL || process.env.SMTP_USER;

  // Cliente
  const subjectCustomer = `❌ Suscripción cancelada — ${brand}`;
  const bodyCustomer = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111827;">${customerName ? `Hola ${escapeHtml(customerName)},` : 'Hola,'}</p>
  <p style="margin:0 0 10px; font:14px system-ui; color:#374151;">
    Te confirmamos que tu suscripción ha sido <strong>cancelada</strong>. Ya no se realizarán más cargos.
  </p>
  <p style="margin:0 0 8px; font:13px system-ui; color:#6b7280;">
    ID cliente: ${escapeHtml(customerId || '-')}<br/>
    ID suscripción: ${escapeHtml(subscriptionId || '-')}
  </p>
  <p style="margin:12px 0 0; font:13px system-ui; color:#374151;">
    Si ha sido un error o quieres reactivarla, contesta a este correo y te ayudamos en seguida.
  </p>
</td></tr>`;
  const htmlCustomer = emailShell({
    title: 'Suscripción cancelada',
    headerLabel: 'Suscripción cancelada',
    bodyHTML: bodyCustomer,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand)}.</p>`
  });

  // Admin
  const subjectAdmin = `⚠️ Baja de suscripción — ${subscriptionId || ''}`;
  const bodyAdmin = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 10px; font:14px system-ui; color:#111827;">
    Se ha cancelado una suscripción.
  </p>
  <ul style="margin:0; padding-left:16px; color:#111827; font:14px system-ui;">
    <li><b>Cliente:</b> ${escapeHtml(customerName || '-')}</li>
    <li><b>Email:</b> ${escapeHtml(toCustomer || '-')}</li>
    <li><b>Customer ID:</b> ${escapeHtml(customerId || '-')}</li>
    <li><b>Subscription ID:</b> ${escapeHtml(subscriptionId || '-')}</li>
  </ul>
</td></tr>`;
  const htmlAdmin = emailShell({
    title: 'Baja de suscripción',
    headerLabel: 'Baja de suscripción',
    bodyHTML: bodyAdmin,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(brand)} — ${new Date().toLocaleString('es-ES')}</p>`
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    if (toCustomer) await resend.emails.send({ from, to: toCustomer, subject: subjectCustomer, html: htmlCustomer });
    if (corpTo) await resend.emails.send({ from, to: corpTo, subject: subjectAdmin, html: htmlAdmin });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    if (toCustomer) await sendViaGmailSMTP({ from, to: toCustomer, subject: subjectCustomer, html: htmlCustomer });
    if (corpTo) await sendViaGmailSMTP({ from, to: corpTo, subject: subjectAdmin, html: htmlAdmin });
    return;
  }
  console.warn('[sendSubscriptionCanceledEmails] No hay proveedor de email configurado');
}

// === Email cancelación programada (opcional)
async function sendSubscriptionScheduledCancelEmail({
  toCustomer, customerName, customerId, subscriptionId, cancelAt,
  brand = BRAND
}) {
  if (!toCustomer) return;
  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const subject = `⏳ Cancelación programada de tu suscripción — ${brand}`;
  const when = cancelAt ? new Date(cancelAt * 1000) : null;
  const whenTxt = when ? when.toLocaleString('es-ES', { dateStyle: 'medium' }) : 'fin de ciclo';

  const body = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111827;">${customerName ? `Hola ${escapeHtml(customerName)},` : 'Hola,'}</p>
  <p style="margin:0 0 10px; font:14px system-ui; color:#374151;">
    Has solicitado cancelar tu suscripción al <strong>final del periodo</strong>. Dejará de renovarse el <strong>${escapeHtml(whenTxt)}</strong>.
  </p>
  <p style="margin:0 0 8px; font:13px system-ui; color:#6b7280;">
    ID cliente: ${escapeHtml(customerId || '-')}<br/>
    ID suscripción: ${escapeHtml(subscriptionId || '-')}
  </p>
  <p style="margin:12px 0 0; font:13px system-ui; color:#374151;">
    Si quieres reactivarla o cancelar inmediatamente, usa el botón de gestión o contesta a este correo.
  </p>
</td></tr>
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  ${manageSubscriptionButtonHTML(customerId)}
</td></tr>
`;

  const html = emailShell({
    title: 'Cancelación programada',
    headerLabel: 'Cancelación programada',
    bodyHTML: body,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand)}.</p>`
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from, to: toCustomer, subject, html });
  } else if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to: toCustomer, subject, html });
  } else {
    console.warn('[sendSubscriptionScheduledCancelEmail] Sin proveedor de email configurado');
  }
}

// ====== Middl. y logs ======
app.use(morgan('tiny'));

// ====== Webhook Stripe (RAW) ======
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature error:', err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // dedup
  async function dedupEvent(eventId) {
    if (!pool) return true;
    const r = await pool.query(
      `INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventId]
    );
    return r.rowCount === 1;
  }
  try {
    const isNew = await dedupEvent(event.id);
    if (!isNew) return res.status(200).json({ ok: true, dedup: true });
  } catch (e) { console.error('[webhook] dedup error:', e?.message || e); }

  console.log('[webhook] EVENT', { id: event.id, type: event.type, livemode: event.livemode, created: event.created });

  // helpers DB
  async function logOrder(order) {
    if (!pool) { console.warn('[db] no DATABASE_URL'); return; }
    const text = `
      INSERT INTO orders (session_id, email, name, phone, total, currency, items, metadata, shipping, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (session_id) DO NOTHING
    `;
    const values = [
      order.sessionId, order.customerEmail || null, order.name || null, order.phone || null,
      order.amountTotal || 0, order.currency || 'EUR',
      JSON.stringify(order.lineItems || []), JSON.stringify(order.metadata || {}), JSON.stringify(order.shipping || {}),
      order.status || 'paid', order.createdAt || new Date().toISOString(),
    ];
    await pool.query(text, values);
  }
  async function logOrderItems(sessionId, lineItems, currency) {
    if (!pool || !Array.isArray(lineItems)) return;
    const text = `
      insert into order_items
        (session_id, description, product_id, price_id, quantity, unit_amount_cents, amount_total_cents, currency, raw)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict do nothing
    `;
    for (const li of lineItems) {
      const vals = [
        sessionId,
        li.description || null,
        li.price?.product || null,
        li.price?.id || null,
        li.quantity || 1,
        li.price?.unit_amount ?? null,
        (li.amount_total ?? li.amount ?? 0),
        (li.currency || currency || 'eur').toUpperCase(),
        JSON.stringify(li),
      ];
      await pool.query(text, vals);
    }
  }
  async function upsertSubscriber({ customer_id, subscription_id=null, email, plan, status, name=null, phone=null, address=null, city=null, postal=null, country=null, meta=null }) {
    if (!pool) return null;
    const text = `
      INSERT INTO subscribers (
        customer_id, subscription_id, email, plan, status,
        name, phone, address, city, postal, country, meta,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, timezone('utc',now()), timezone('utc',now())
      )
      ON CONFLICT (customer_id) DO UPDATE
      SET subscription_id = COALESCE(EXCLUDED.subscription_id, subscribers.subscription_id),
          email = COALESCE(EXCLUDED.email, subscribers.email),
          plan  = COALESCE(EXCLUDED.plan,  subscribers.plan),
          status= COALESCE(EXCLUDED.status,subscribers.status),
          name  = COALESCE(EXCLUDED.name,  subscribers.name),
          phone = COALESCE(EXCLUDED.phone, subscribers.phone),
          address=COALESCE(EXCLUDED.address,subscribers.address),
          city  = COALESCE(EXCLUDED.city,  subscribers.city),
          postal= COALESCE(EXCLUDED.postal,subscribers.postal),
          country=COALESCE(EXCLUDED.country,subscribers.country),
          meta  = COALESCE(EXCLUDED.meta,  subscribers.meta),
          updated_at = timezone('utc', now())
      RETURNING *;
    `;
    const values = [customer_id, subscription_id, email, plan, status, name, phone, address, city, postal, country, meta ? JSON.stringify(meta) : null];
    const { rows } = await pool.query(text, values);
    return rows[0];
  }
  async function markSubscriptionCanceled({ subscription_id }) {
    if (!pool) return;
    await pool.query(`UPDATE subscribers SET status='canceled', canceled_at=now() WHERE subscription_id=$1`, [subscription_id]);
  }
  async function markSubscriptionScheduledCancel({ subscription_id, cancel_at_epoch }) {
    if (!pool) return;
    const ts = cancel_at_epoch ? new Date(cancel_at_epoch * 1000).toISOString() : null;
    await pool.query(
      `UPDATE subscribers SET cancel_at = $2, status = COALESCE(status,'active'), updated_at = timezone('utc', now())
       WHERE subscription_id = $1`,
      [subscription_id, ts]
    );
  }
  async function logSubscriptionInvoice({ invoice, items=[] }) {
    if (!pool) return;
    const text = `
      INSERT INTO subscription_invoices
        (invoice_id, subscription_id, customer_id, amount_paid, currency,
         invoice_number, hosted_invoice_url, invoice_pdf, lines, paid_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (invoice_id) DO NOTHING
    `;
    const values = [
      invoice.id, invoice.subscription || null, invoice.customer || null,
      invoice.amount_paid ?? invoice.amount_due ?? 0,
      (invoice.currency || 'eur').toUpperCase(),
      invoice.number || null, invoice.hosted_invoice_url || null, invoice.invoice_pdf || null,
      JSON.stringify(items || []),
      invoice.status === 'paid' ? new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000).toISOString() : null
    ];
    await pool.query(text, values);
  }

  // address resolver
  async function resolveCheckoutAddress(stripeClient, invoice) {
    const normalize = (a, meta = {}) => {
      if (!a && !meta) return null;
      const o = (a && typeof a === 'object') ? a : {};
      const line1 = o.line1 || meta.address || '';
      const line2 = o.line2 || '';
      const city  = o.city  || meta.city    || '';
      const state = o.state || '';
      const postal_code = o.postal_code || meta.postal || meta.postal_code || '';
      const country = o.country || meta.country || '';
      if (!line1 && !city && !postal_code && !country) return null;
      return { line1, line2, city, state, postal_code, country };
    };
    let norm = normalize(invoice.customer_details?.address) || normalize(invoice.customer_address);
    if (norm) return norm;
    if (invoice.payment_intent) {
      try {
        const pi = await stripeClient.paymentIntents.retrieve(invoice.payment_intent, { expand: ['latest_charge'] });
        let charge = pi.latest_charge;
        if (charge && typeof charge !== 'object') charge = await stripeClient.charges.retrieve(charge);
        norm = normalize(charge?.shipping?.address) || normalize(charge?.billing_details?.address);
        if (norm) return norm;
      } catch (e) { console.warn('[resolveCheckoutAddress] PI/Charge error:', e?.message || e); }
    }
    if (invoice.customer) {
      try {
        const cust = await stripeClient.customers.retrieve(invoice.customer);
        norm = normalize(cust?.shipping?.address) || normalize(cust?.address);
        if (norm) return norm;
      } catch (e) { console.warn('[resolveCheckoutAddress] customer error:', e?.message || e); }
    }
    try {
      if (invoice.customer) {
        const sessions = await stripeClient.checkout.sessions.list({ customer: invoice.customer, limit: 5 });
        const completed = (sessions?.data || []).find(s => s.status === 'complete') || sessions?.data?.[0];
        if (completed) {
          norm = normalize(completed.shipping_details?.address);
          if (norm) return norm;
          const meta = completed.metadata || {};
          norm = normalize(null, { address: meta.address, city: meta.city, postal: meta.postal, country: meta.country });
          if (norm) return norm;
        }
      }
    } catch (e) { console.warn('[resolveCheckoutAddress] sessions.list error:', e?.message || e); }
    norm = normalize(null, { address: invoice.metadata?.address, city: invoice.metadata?.city, postal: invoice.metadata?.postal, country: invoice.metadata?.country });
    if (norm) return norm;
    return invoice.customer_details?.address || { country: invoice.customer_details?.address?.country || '' };
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        let lineItems = [];
        try {
          const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] });
          lineItems = li?.data || [];
        } catch (e) { console.warn('[webhook] listLineItems error:', e.message); }

        const customerEmail = session.customer_details?.email || session.customer_email;
        const name = session.customer_details?.name || session.metadata?.name;
        const phone = session.customer_details?.phone || session.metadata?.phone;
        const shipping = session.shipping_details?.address;
        const metadata = session.metadata || {};
        const amountTotal = (session.amount_total ?? 0) / 100;
        const currency = (session.currency || 'eur').toUpperCase();
        const isSubscription = session.mode === 'subscription' || lineItems.some(li => li?.price?.recurring);

        if (isSubscription && session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            const cust = await stripe.customers.retrieve(session.customer);
            await upsertSubscriber({
              customer_id: sub.customer, subscription_id: sub.id,
              email: cust?.email || session.customer_details?.email || session.customer_email || null,
              name: cust?.name || session.customer_details?.name || null,
              plan: sub.items?.data?.[0]?.price?.id || null,
              status: sub.status, meta: sub.metadata || {}
            });
          } catch (e) { console.error('[webhook] suscripción (alta) ERROR:', e); }
        }

        try {
          await sendAdminEmail({ session, lineItems, customerEmail, name, phone, amountTotal, currency, metadata, shipping });
          console.log('📧 Email admin enviado OK');
        } catch (e) { console.error('📧 Email admin ERROR:', e); }

        const combine = String(process.env.COMBINE_CONFIRMATION_AND_INVOICE || 'true').toLowerCase() !== 'false';
        if (!combine) {
          try {
            await sendCustomerEmail({
              to: customerEmail, name, amountTotal, currency,
              lineItems, orderId: session.id,
              supportEmail: process.env.SUPPORT_EMAIL,
              brand: BRAND, isSubscription,
              customerId: session.customer
            });
            console.log('📧 Email cliente enviado OK (solo confirmación)');
          } catch (e) { console.error('📧 Email cliente (confirmación) ERROR:', e); }
        } else {
          console.log('[combine=true] correo al cliente se enviará en invoice.payment_succeeded');
        }

        try {
          await logOrder({
            sessionId: session.id, amountTotal, currency, customerEmail, name, phone,
            lineItems, metadata, shipping, status: 'paid', createdAt: new Date().toISOString(),
          });
          await logOrderItems(session.id, lineItems, currency);
          console.log('🗄️ Pedido registrado OK');
        } catch (e) { console.error('🗄️ Registro en DB ERROR:', e); }

        console.log('✅ checkout.session.completed', session.id);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        let to = invoice.customer_email || invoice.customer_details?.email || null;
        if (!to && invoice.customer) {
          try { const cust = await stripe.customers.retrieve(invoice.customer); to = cust?.email || null; } catch {}
        }
        const name = invoice.customer_name || invoice.customer_details?.name || '';
        let pdfUrl = invoice.invoice_pdf;
        if (!pdfUrl) {
          for (let i=0; i<3 && !pdfUrl; i++) {
            await new Promise(r => setTimeout(r, 3000));
            try { const inv2 = await stripe.invoices.retrieve(invoice.id); pdfUrl = inv2.invoice_pdf || null; } catch {}
          }
        }
        let invItems = [];
        try {
          const li = await stripe.invoices.listLineItems(invoice.id, { limit: 100, expand: ['data.price.product'] });
          invItems = li?.data || [];
        } catch (e) { console.warn('[invoice.email] listLineItems error:', e?.message || e); }

        if (invoice.subscription) await logSubscriptionInvoice({ invoice, items: invItems });

        const isSubscription = !!invoice.subscription || invItems.some(it => it?.price?.recurring);
        const currency = (invoice.currency || 'eur').toUpperCase();
        const total = (invoice.amount_paid ?? invoice.amount_due ?? 0) / 100;
        const invoiceNumber = invoice.number || invoice.id;

        const resolvedAddress = await resolveCheckoutAddress(stripe, invoice);
        const customerForPDF = { name, email: to, address: resolvedAddress };

        const combine = String(process.env.COMBINE_CONFIRMATION_AND_INVOICE || 'true').toLowerCase() !== 'false';
        if (combine && to) {
          await sendCustomerOrderAndInvoiceEmail({
            to, name, invoiceNumber, total, currency, pdfUrl,
            lineItems: invItems, brand: BRAND, isSubscription,
            alsoBccCorporate: String(process.env.CUSTOMER_BCC_CORPORATE || '').toLowerCase() === 'true',
            customer: customerForPDF, customerId: invoice.customer
          });
          console.log('📧 Combinado enviado →', to);
        }
        console.log('✅ invoice.payment_succeeded', invoice.id);
        break;
      }

      // === CANCELACIÓN PROGRAMADA / CAMBIOS DE ESTADO ===
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const prev = event.data.previous_attributes || {};
        try {
          const nowCancelAtPeriodEnd = bool(sub.cancel_at_period_end);
          const beforeCancelAtPeriodEnd = bool(prev.cancel_at_period_end ?? false);
          const nowStatus = sub.status;
          const beforeStatus = prev.status;

          // Programación de cancelación (de false -> true)
          if (!beforeCancelAtPeriodEnd && nowCancelAtPeriodEnd) {
            await markSubscriptionScheduledCancel({
              subscription_id: sub.id,
              cancel_at_epoch: sub.cancel_at || sub.current_period_end
            });

            const sendScheduledMail = String(process.env.EMAIL_ON_SCHEDULED_CANCEL || 'true').toLowerCase() !== 'false';
            if (sendScheduledMail) {
              let to = null, name = '';
              try {
                const cust = await stripe.customers.retrieve(sub.customer);
                to = cust?.email || null;
                name = cust?.name || '';
              } catch (e) { console.warn('[updated] get customer warn:', e?.message || e); }

              try {
                await sendSubscriptionScheduledCancelEmail({
                  toCustomer: to,
                  customerName: name,
                  customerId: sub.customer,
                  subscriptionId: sub.id,
                  cancelAt: sub.cancel_at || sub.current_period_end
                });
                console.log('📧 Email cancelación programada enviado');
              } catch (e) {
                console.error('📧 Email cancelación programada ERROR:', e);
              }
            }
          }

          // Transición a canceled (poco común pero posible desde updated)
          const becameCanceled = (beforeStatus && beforeStatus !== 'canceled') && nowStatus === 'canceled';
          if (becameCanceled) {
            await markSubscriptionCanceled({ subscription_id: sub.id });

            let to = null, name = '';
            try {
              const cust = await stripe.customers.retrieve(sub.customer);
              to = cust?.email || null;
              name = cust?.name || '';
            } catch (e) { console.warn('[updated->canceled] get customer warn:', e?.message || e); }

            try {
              await sendSubscriptionCanceledEmails({
                toCustomer: to,
                customerName: name,
                customerId: sub.customer,
                subscriptionId: sub.id,
                corporateEmail: process.env.CORPORATE_EMAIL,
                brand: BRAND
              });
              console.log('📧 Emails de cancelación (desde updated) enviados OK');
            } catch (e) {
              console.error('📧 Emails de cancelación (desde updated) ERROR:', e);
            }
          }

          // Mantener ficha sincronizada
          try {
            await upsertSubscriber({
              customer_id: sub.customer, subscription_id: sub.id,
              email: null, name: null,
              plan: sub.items?.data?.[0]?.price?.id || null,
              status: sub.status, meta: sub.metadata || {}
            });
          } catch (e) { console.error('[updated] upsertSubscriber ERROR:', e); }

        } catch (e) {
          console.error('[webhook] subscription.updated ERROR:', e);
        }
        break;
      }

      // === CANCELACIÓN EFECTIVA ===
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        try {
          await markSubscriptionCanceled({ subscription_id: sub.id });

          let to = null, name = '';
          try {
            const cust = await stripe.customers.retrieve(sub.customer);
            to = cust?.email || null;
            name = cust?.name || '';
          } catch (e) {
            console.warn('[deleted] get customer warn:', e?.message || e);
          }

          try {
            await sendSubscriptionCanceledEmails({
              toCustomer: to,
              customerName: name,
              customerId: sub.customer,
              subscriptionId: sub.id,
              corporateEmail: process.env.CORPORATE_EMAIL,
              brand: BRAND
            });
            console.log('📧 Emails de cancelación enviados OK');
          } catch (e) {
            console.error('📧 Emails de cancelación ERROR:', e);
          }

          console.log('✅ subscription.deleted', sub.id);
        } catch (e) {
          console.error('[webhook] subscription.deleted ERROR:', e);
        }
        break;
      }

      case 'invoice.payment_failed':
        console.warn('⚠️ invoice.payment_failed', event.data.object.id);
        break;

      default:
        console.log('ℹ️ Evento ignorado:', event.type);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ====== CORS + JSON (después del webhook RAW) ======
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// ====== Rutas públicas ======
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Crear/actualizar Customer desde el front (one-time)
async function upsertStripeCustomerFromFront(stripeClient, payload) {
  const email = payload?.customer?.email;
  if (!email) return null;
  const addr = {
    line1: payload?.shipping_address?.address || payload?.metadata?.address || '',
    line2: payload?.shipping_address?.line2 || '',
    city:  payload?.shipping_address?.city || payload?.metadata?.city || '',
    postal_code: payload?.shipping_address?.postal_code || payload?.metadata?.postal || '',
    country: payload?.shipping_address?.country || payload?.metadata?.country || 'ES',
    state: payload?.shipping_address?.state || '',
  };
  const hasLine1 = !!addr.line1;
  let customer = null;
  try {
    const list = await stripeClient.customers.list({ email, limit: 1 });
    customer = list.data[0] || null;
  } catch {}
  const base = { email, name: payload?.customer?.name || payload?.metadata?.name || undefined, phone: payload?.customer?.phone || payload?.metadata?.phone || undefined };
  try {
    if (!customer) {
      customer = await stripeClient.customers.create({ ...base, ...(hasLine1 ? { address: addr, shipping: { name: base.name || email, address: addr } } : {}) });
    } else {
      const update = { ...base };
      if (hasLine1) { update.address = addr; update.shipping = { name: base.name || customer.name || email, address: addr }; }
      customer = await stripeClient.customers.update(customer.id, update);
    }
  } catch {}
  return customer;
}

// Normalizadores de items/precios
function resolvePriceAlias(maybePrice) {
  if (!maybePrice) return null;
  const alias = String(maybePrice).trim();
  const map = {
    'price_sub_500': process.env.SUB_500_PRICE_ID,
    'sub_500':       process.env.SUB_500_PRICE_ID,
    'plan_500':      process.env.SUB_500_PRICE_ID,
    'price_sub_1000':process.env.SUB_1000_PRICE_ID,
    'sub_1000':      process.env.SUB_1000_PRICE_ID,
    'plan_1000':     process.env.SUB_1000_PRICE_ID,
  };
  if (alias.startsWith('price_')) return alias;
  return map[alias] || alias;
}
function sanitizeLineItems(rawItems = []) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((it) => {
    const out = { quantity: Number(it?.quantity || 1) };
    const incoming = it?.price || it?.priceId;
    if (incoming) out.price = resolvePriceAlias(incoming);
    if (!out.price && it?.price_data) return { ...it, quantity: out.quantity };
    return out;
  });
}

// Checkout (one-time)
app.post('/create-checkout-session', async (req, res) => {
  try {
    let { items, mode='payment', success_url, cancel_url, customer, shipping_address, metadata, price, quantity } = req.body || {};
    if (!success_url || !cancel_url) return res.status(400).json({ error: 'Missing success_url/cancel_url' });
    if ((!items || !Array.isArray(items) || items.length===0) && price) items = [{ price, quantity: Number(quantity || 1) }];
    if (!Array.isArray(items) || items.length===0) return res.status(400).json({ error: 'Missing items or price' });

    const isSubscription = mode === 'subscription';
    const normalizedItems = sanitizeLineItems(items);
    const invalid = normalizedItems.find(it => it.price && !String(it.price).startsWith('price_'));
    if (invalid) return res.status(400).json({ error: `Invalid price id: ${invalid.price}` });

    const hasFrontAddress =
      !!(shipping_address?.address || metadata?.address) &&
      !!(shipping_address?.city    || metadata?.city) &&
      !!(shipping_address?.postal  || shipping_address?.postal_code || metadata?.postal);

    let customerId;
    if (customer?.id && String(customer.id).startsWith('cus_')) customerId = customer.id;
    else if (hasFrontAddress && (customer?.email || metadata?.email)) {
      const cust = await upsertStripeCustomerFromFront(stripe, {
        customer: { email: customer?.email || metadata?.email, name: customer?.name, phone: customer?.phone },
        shipping_address, metadata
      });
      customerId = cust?.id;
    }

    const sessionParams = {
      mode,
      line_items: normalizedItems,
      success_url, cancel_url,
      allow_promotion_codes: true,
      ...(customerId
        ? { customer: customerId, billing_address_collection: 'auto' }
        : { customer_email: customer?.email || metadata?.email, customer_creation: 'always', billing_address_collection: 'required' }
      ),
      metadata: {
        ...(metadata || {}),
        name:  customer?.name  ?? metadata?.name,
        phone: customer?.phone ?? metadata?.phone,
        address: shipping_address?.address     ?? metadata?.address,
        city:    shipping_address?.city        ?? metadata?.city,
        postal:  shipping_address?.postal_code ?? metadata?.postal,
        country: shipping_address?.country     ?? metadata?.country,
        source: (metadata?.source || 'guarros-front'),
      },
      phone_number_collection: { enabled: true },
    };

    if (!customerId) sessionParams.shipping_address_collection = { allowed_countries: ['ES', 'PT'] };

    if (!isSubscription) {
      sessionParams.invoice_creation = {
        enabled: true,
        invoice_data: {
          description: 'Pedido web Guarros Extremeños',
          footer: 'Gracias por su compra. Soporte: soporte@guarrosextremenos.com'
        }
      };
      if (process.env.STRIPE_SHIPPING_RATE_ID) {
        sessionParams.shipping_options = [{ shipping_rate: process.env.STRIPE_SHIPPING_RATE_ID }];
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Suscripción (Checkout Session)
app.post('/create-subscription-session', async (req, res) => {
  try {
    const { price, quantity = 1, success_url, cancel_url, customer } = req.body || {};
    if (!price) return res.status(400).json({ error: 'Missing price' });
    if (!success_url || !cancel_url) return res.status(400).json({ error: 'Missing URLs' });

    const realPrice = resolvePriceAlias(price);
    if (!realPrice || !String(realPrice).startsWith('price_')) {
      return res.status(400).json({ error: `Invalid price id: ${price}` });
    }

    let customerId;
    if (customer?.email) {
      try {
        const list = await stripe.customers.list({ email: customer.email, limit: 1 });
        const exists = list.data[0];
        if (exists) {
          customerId = exists.id;
          await stripe.customers.update(customerId, {
            name:  customer.name  || undefined,
            phone: customer.phone || undefined,
          });
        } else {
          const created = await stripe.customers.create({
            email: customer.email,
            name:  customer.name  || undefined,
            phone: customer.phone || undefined,
          });
          customerId = created.id;
        }
      } catch (e) { console.warn('[create-subscription-session] upsert customer warn:', e?.message || e); }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ...(customerId ? { customer: customerId } : {}),
      success_url, cancel_url,
      allow_promotion_codes: true,
      line_items: [{ price: realPrice, quantity }],
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['ES', 'PT'] },
      phone_number_collection: { enabled: true },
      ...(customerId ? { customer_update: { address: 'auto', name: 'auto', shipping: 'auto' } } : {}),
      automatic_tax: { enabled: false },
      metadata: { source: 'guarros-front-subscription' },
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('create-subscription-session error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Billing Portal (POST programático)
app.post('/billing-portal', async (req, res) => {
  try {
    const { customer_id, return_url } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: 'Missing customer_id' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url: return_url || PORTAL_RETURN_URL,
      ...(BILLING_PORTAL_CONFIG ? { configuration: BILLING_PORTAL_CONFIG } : {})
    });
    return res.json({ url: portal.url });
  } catch (e) {
    console.error('billing-portal error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// Billing Portal (GET para correos → redirige)
app.get('/billing-portal/link', async (req, res) => {
  try {
    const customer_id = req.query.customer_id;
    const return_url = req.query.return || PORTAL_RETURN_URL;
    if (!customer_id) return res.status(400).send('Missing customer_id');
    const portal = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url,
      ...(BILLING_PORTAL_CONFIG ? { configuration: BILLING_PORTAL_CONFIG } : {})
    });
    return res.redirect(302, portal.url);
  } catch (e) {
    console.error('billing-portal/link error:', e);
    return res.status(500).send('Error creating portal session');
  }
});

// Contacto
app.post('/contact', async (req, res) => {
  try {
    const { name, email, message, company, source } = req.body || {};
    if (company && company.trim() !== '') return res.json({ ok: true }); // honeypot
    if (!name || !email || !message) return res.status(400).json({ ok:false, error:'Faltan campos requeridos.' });

    const brand = BRAND;
    const fromUser = process.env.CUSTOMER_FROM || 'soporte@guarrosextremenos.com';
    const toUser = String(email).trim().toLowerCase();
    const corpTo = process.env.CORPORATE_EMAIL || 'pedidos@tudominio.com';
    const corpFrom = process.env.CORPORATE_FROM || fromUser;

    const subjectUser = `Hemos recibido tu mensaje — ${brand}`;
    const subjectCorp = `📨 Nuevo contacto — ${brand}`;

    const htmlUser = `
      <p>Hola ${escapeHtml(name)},</p>
      <p>¡Gracias por escribirnos! Hemos recibido tu mensaje y te responderemos lo antes posible.</p>
      <p style="color:#374151; white-space:pre-wrap; border-left:3px solid #e5e7eb; padding-left:10px;">${escapeHtml(message)}</p>
      <p>Un saludo,<br/>Equipo ${escapeHtml(brand)}</p>
    `;
    const htmlCorp = `
      <p><strong>Nuevo contacto</strong> desde la web (${escapeHtml(source || 'contact')}):</p>
      <p><strong>Nombre:</strong> ${escapeHtml(name)}<br/>
         <strong>Email:</strong> ${escapeHtml(email)}</p>
      <p style="color:#374151; white-space:pre-wrap; border-left:3px solid #e5e7eb; padding-left:10px;">${escapeHtml(message)}</p>
    `;

    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: fromUser, to: toUser, subject: subjectUser,
        html: emailShell({
          title: subjectUser, headerLabel: 'Mensaje recibido',
          bodyHTML: `<tr><td style="padding:0 24px 16px; background:#ffffff;">${htmlUser}</td></tr>`,
          footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand)}</p>`
        }),
      });
      await resend.emails.send({
        from: corpFrom, to: corpTo, subject: subjectCorp,
        html: emailShell({
          title: subjectCorp, headerLabel: 'Nuevo contacto web',
          bodyHTML: `<tr><td style="padding:0 24px 16px; background:#ffffff;">${htmlCorp}</td></tr>`,
          footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(brand)}</p>`
        }),
      });
    } else if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      await sendViaGmailSMTP({
        from: fromUser, to: toUser, subject: subjectUser,
        html: emailShell({
          title: subjectUser, headerLabel: 'Mensaje recibido',
          bodyHTML: `<tr><td style="padding:0 24px 16px; background:#ffffff;">${htmlUser}</td></tr>`,
          footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand)}</p>`
        }),
      });
      await sendViaGmailSMTP({
        from: corpFrom, to: corpTo, subject: subjectCorp,
        html: emailShell({
          title: subjectCorp, headerLabel: 'Nuevo contacto web',
          bodyHTML: `<tr><td style="padding:0 24px 16px; background:#ffffff;">${htmlCorp}</td></tr>`,
          footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">${escapeHtml(brand)}</p>`
        }),
      });
    } else return res.status(500).json({ ok:false, error:'No hay proveedor de email configurado.' });

    return res.json({ ok: true });
  } catch (e) {
    console.error('[POST /contact] error:', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
});

// Tests
app.post('/test-email', async (req, res) => {
  try {
    const to = process.env.CORPORATE_EMAIL || (process.env.SMTP_USER || 'destino@tudominio.com');
    const from = process.env.CORPORATE_FROM || process.env.SMTP_USER || 'no-reply@example.com';
    const subject = 'Prueba email backend';
    const text = `Hola, prueba enviada a las ${new Date().toISOString()}`;
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const info = await resend.emails.send({ from, to, subject, text });
      return res.json({ ok: true, provider: 'resend', id: info?.id || null });
    }
    const info = await sendViaGmailSMTP({ from, to, subject, text });
    return res.json({ ok: true, provider: 'smtp', messageId: info.messageId });
  } catch (e) {
    console.error('[/test-email] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health-db', async (req, res) => {
  try {
    if (!pool) throw new Error('DATABASE_URL no configurado');
    const r = await pool.query('select now() as now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error('[/health-db] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== Start ======
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
