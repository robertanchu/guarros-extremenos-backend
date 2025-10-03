import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import pg from 'pg';
import PDFDocument from 'pdfkit';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
ENV recomendadas:
- STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- RESEND_API_KEY  (o SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)
- DATABASE_URL    (SSL on, rejectUnauthorized=false)
- CORPORATE_EMAIL, CORPORATE_FROM, CUSTOMER_FROM, SUPPORT_EMAIL
- BRAND_NAME, BRAND_PRIMARY (#D62828), BRAND_LOGO_URL
- ALLOWED_ORIGINS (comma), ALLOWED_DOMAINS (comma)
- COMBINE_CONFIRMATION_AND_INVOICE = true|false
- ATTACH_STRIPE_INVOICE = true|false
- COMPANY_NAME, COMPANY_TAX_ID, COMPANY_ADDRESS, COMPANY_CITY, COMPANY_POSTAL, COMPANY_COUNTRY, RECEIPT_SERIE
*/

// ---------- CORS ----------
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
  } catch {
    return false;
  }
}

const corsOptions = {
  origin: (origin, cb) => isOriginAllowed(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
};

app.use(morgan('tiny'));

// Helper espera
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ======================================================
   ==========   WEBHOOK STRIPE (ACK RÁPIDO)    ==========
   ====================================================== */
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('[webhook] EVENT', { id: event.id, type: event.type, livemode: !!event.livemode, created: event.created });
  res.status(200).json({ received: true });

  queueMicrotask(async () => {
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;

          // Line items de la sesión
          let lineItems = [];
          try {
            const li = await stripe.checkout.sessions.listLineItems(session.id, {
              limit: 100,
              expand: ['data.price.product']
            });
            lineItems = li?.data || [];
          } catch (e) {
            console.warn('[webhook] listLineItems error:', e.message);
          }

          const customerEmail = session.customer_details?.email || session.customer_email;
          const name = session.customer_details?.name || session.metadata?.name;
          const phone = session.customer_details?.phone || session.metadata?.phone;
          const shipping = session.shipping_details?.address;
          const metadata = session.metadata || {};
          const amountTotal = (session.amount_total ?? 0) / 100;
          const currency = (session.currency || 'eur').toUpperCase();

          const isSubscription =
            session.mode === 'subscription' ||
            (Array.isArray(lineItems) && lineItems.some(li => li?.price?.recurring));

          // Email admin
          try {
            await sendAdminEmail({ session, lineItems, customerEmail, name, phone, amountTotal, currency, metadata, shipping });
            console.log('📧 Email admin enviado OK');
          } catch (e) {
            console.error('📧 Email admin ERROR:', e);
          }

          const combine = String(process.env.COMBINE_CONFIRMATION_AND_INVOICE || 'true').toLowerCase() !== 'false';

          // COMBINE=false → Solo CONFIRMACIÓN (sin adjuntos) en checkout
          if (!combine) {
            try {
              await sendCustomerEmail({
                to: customerEmail, name, amountTotal, currency,
                lineItems, orderId: session.id,
                supportEmail: process.env.SUPPORT_EMAIL,
                brand: process.env.BRAND_NAME || "Guarros Extremeños",
                isSubscription,
              });
              console.log('📧 Email cliente enviado OK (solo confirmación)');
            } catch (e) {
              console.error('📧 Email cliente (confirmación) ERROR:', e);
            }
          } else {
            console.log('📧 [combine=true] No enviamos correo al cliente en checkout; se enviará combinado en invoice.payment_succeeded');
          }

          // Registro en DB
          try {
            await logOrder({
              sessionId: session.id,
              amountTotal,
              currency,
              customerEmail,
              name,
              phone,
              lineItems,
              metadata,
              shipping,
              status: 'paid',
              createdAt: new Date().toISOString(),
            });
            await logOrderItems(session.id, lineItems, currency);
            console.log('🗄️ Pedido registrado OK');
          } catch (e) {
            console.error('🗄️ Registro en DB ERROR:', e);
          }

          console.log('✅ Procesado checkout.session.completed', session.id);
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          try {
            // Email destino
            let to = invoice.customer_email || invoice.customer_details?.email || null;
            if (!to && invoice.customer) {
              try {
                const cust = await stripe.customers.retrieve(invoice.customer);
                to = cust?.email || null;
              } catch (e) {
                console.warn('[invoice.email] retrieve customer error:', e?.message || e);
              }
            }

            const name =
              invoice.customer_name ||
              invoice.customer_details?.name ||
              invoice.customer?.name || '';

            // PDF de factura (con reintentos; sólo para attach opcional)
            let pdfUrl = invoice.invoice_pdf;
            if (!pdfUrl) {
              for (let i = 0; i < 3 && !pdfUrl; i++) {
                await wait(3000);
                try {
                  const inv2 = await stripe.invoices.retrieve(invoice.id);
                  pdfUrl = inv2.invoice_pdf || null;
                  console.log(`[invoice.retry] intento ${i + 1}: invoice_pdf ${pdfUrl ? 'OK' : 'aún no'}`);
                } catch (e) {
                  console.warn('[invoice.retry] retrieve error:', e?.message || e);
                }
              }
            }

            // Líneas de la factura (para recibo propio)
            let invItems = [];
            try {
              const li = await stripe.invoices.listLineItems(invoice.id, {
                limit: 100,
                expand: ['data.price.product']
              });
              invItems = li?.data || [];
            } catch (e) {
              console.warn('[invoice.email] listLineItems error:', e?.message || e);
            }

            const isSubscription =
              !!invoice.subscription || (Array.isArray(invItems) && invItems.some(it => it?.price?.recurring));
            const currency = (invoice.currency || 'eur').toUpperCase();
            const total = (invoice.amount_paid ?? invoice.amount_due ?? 0) / 100;
            const invoiceNumber = invoice.number || invoice.id;

            // Dirección del cliente para el PDF (enriquecida)
            const resolvedAddress = await resolveCheckoutAddress(stripe, invoice);

            const customerForPDF = {
              name,
              email: to,
              address: resolvedAddress
            };

            const combine = String(process.env.COMBINE_CONFIRMATION_AND_INVOICE || 'true').toLowerCase() !== 'false';

            if (combine && to) {
              // COMBINE=true → Confirmación + Recibo propio + (opcional) Factura Stripe
              await sendCustomerOrderAndInvoiceEmail({
                to, name, invoiceNumber, total, currency,
                pdfUrl, lineItems: invItems,
                brand: process.env.BRAND_NAME || "Guarros Extremeños",
                isSubscription,
                alsoBccCorporate: String(process.env.CUSTOMER_BCC_CORPORATE || '').toLowerCase() === 'true',
                customer: customerForPDF
              });
              console.log('📧 Email combinado (confirmación + recibo [+ factura]) enviado OK →', to);
            } else {
              // COMBINE=false → no se envía correo al cliente aquí
              console.log('[invoice.email] combine=false → no se envía correo al cliente en invoice.payment_succeeded');
            }
          } catch (e) {
            console.error('📧 invoice.payment_succeeded handler ERROR:', e);
          }
          console.log('✅ invoice.payment_succeeded', invoice.id);
          break;
        }

        case 'invoice.payment_failed':
          console.warn('⚠️ invoice.payment_failed', event.data.object.id);
          break;

        default:
          console.log('ℹ️ Evento ignorado:', event.type);
      }
    } catch (err) {
      console.error('[webhook bg] error:', err);
    }
  });
});

// ==============================================
// ==========     API REST / HEALTH     =========
// ==============================================
app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Crear sesión de Checkout
app.post('/create-checkout-session', async (req, res) => {
  try {
    const {
      items = [],
      mode = 'payment',
      success_url,
      cancel_url,
      customer,
      shipping_address,
      metadata
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Missing items' });
    if (!success_url || !cancel_url) return res.status(400).json({ error: 'Missing success_url/cancel_url' });

    const isSubscription = mode === 'subscription';

// Si el front te pasa un customer.id existente, úsalo:
const customerId = customer?.id && String(customer.id).startsWith('cus_') ? customer.id : undefined;

const sessionParams = {
  mode,
  line_items: items,
  success_url,
  cancel_url,
  allow_promotion_codes: true,

  // Si ya tienes un Customer, pásalo; si no, crea uno nuevo siempre
  ...(customerId ? { customer: customerId } : {
    customer_email: customer?.email || undefined,
    customer_creation: 'always', // crea un Customer para guardar datos
  }),

  // Forzar recogida de direcciones
  billing_address_collection: 'required',
  shipping_address_collection: { allowed_countries: ['ES', 'PT'] },

  // Metadatos (fallback de dirección por si hiciera falta luego)
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

// ⚠️ Solo puedes usar customer_update si estás pasando customer (ID existente)
if (customerId) {
  sessionParams.customer_update = { address: 'auto', name: 'auto', shipping: 'auto' };
}

// Facturación automática (solo pagos one-time; en subs la genera el ciclo)
if (!isSubscription) {
  sessionParams.invoice_creation = {
    enabled: true,
    invoice_data: {
      description: 'Pedido web Guarros Extremeños',
      footer: 'Gracias por su compra. Soporte: soporte@guarrosextremenos.com'
    }
  };
}

// Opcional: tarifa de envío fija
if (!isSubscription && process.env.STRIPE_SHIPPING_RATE_ID) {
  sessionParams.shipping_options = [{ shipping_rate: process.env.STRIPE_SHIPPING_RATE_ID }];
}


// ============================
// ========== TESTS ===========
// ============================
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

// ================================
// ==========    START    =========
// ================================
app.listen(PORT, () => console.log(`API listening on :${PORT}`));

/* ===========================================================
   ======================  HELPERS  ==========================
   =========================================================== */

const BRAND = process.env.BRAND_NAME || "Guarros Extremeños";
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#D62828';
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || '';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function currencyFormat(amount = 0, currency = 'EUR') {
  try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(Number(amount)); }
  catch { return `${Number(amount).toFixed(2)} ${(currency||'EUR').toUpperCase()}`; }
}

function formatLineItemsPlain(lineItems = [], currency = 'EUR') {
  const lines = (lineItems || []).map(li => `• ${li.description} x${li.quantity} — ${currencyFormat((li.amount_total ?? li.amount ?? 0)/100, currency)}`);
  return lines.length ? lines.join('\n') : '—';
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

/* ---------- PDF Recibo (PAGADO) ---------- */
async function createPaidReceiptPDF({
  invoiceNumber,
  total,
  currency = 'EUR',
  lineItems = [],
  customer = {},
  paidAt = new Date(),
  brand = BRAND,
  logoUrl = BRAND_LOGO_URL,
}) {
  // Normaliza address (string u objeto tipo Stripe)
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
    totalCents: typeof li?.amount_total === 'number' ? li.amount_total : (typeof li?.amount === 'number' ? li.amount : 0),
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

  // Header: logo o marca
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

  // Datos emisor / recibo
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
  doc.text(invText, rightX, topY, { align: 'left' });

  doc.moveDown(1);

  // --- Cliente (columna derecha, alineado a la derecha) ---
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

  // --- Tabla: Cabecera alineada ---
  doc.font('Helvetica-Bold').fontSize(10);

  // Definición de columnas (coincide con filas)
  const xDesc = 56,  wDesc = 280;
  const xQty  = 336, wQty  = 60;
  const xTot  = 396, wTot  = 140;

  // helper para medir altura sin mover cursor
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

  // línea separadora
  const sepY = headerY + headerH + 4;
  doc.save();
  doc.lineWidth(0.7).strokeColor('#e5e7eb')
     .moveTo(56, sepY).lineTo(56 + 480, sepY).stroke();
  doc.restore();

  // --- Filas (alineadas por fila) ---
  doc.font('Helvetica').fontSize(10);

  let y = sepY + 6; // punto de inicio para las filas
  let sumCents = 0;

  items.forEach((it) => {
    const desc = it.description || 'Producto';
    const qty  = `x${it.quantity || 1}`;
    const totalCents = Number(it.totalCents || 0);
    sumCents += totalCents;
    const totalFmt = currencyFormat(totalCents / 100, it.currency);

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

  // Sitúa el cursor al final de la tabla
  doc.y = y;

  // Separador bajo filas
  doc.moveDown(0.5);
  doc.rect(56, doc.y, 480, 0.7).fill('#e5e7eb').fillColor('#111');
  doc.moveDown(0.6);

  // Total
  doc.font('Helvetica-Bold').fontSize(11);
  const sumFmt = currencyFormat(sumCents / 100, (currency || 'EUR'));
  doc.text('Total pagado', 56, doc.y, { width: 340, align: 'left' });
  doc.text(sumFmt,        396, doc.y, { width: 140, align: 'right' });
  doc.moveDown(0.8);

  // Sello PAGADO
  doc.save();
  doc.rotate(-10, { origin: [400, doc.y] });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#16a34a');
  doc.text('PAGADO', 320, doc.y - 12, { opacity: 0.6 });
  doc.restore();

  // Pie (columna derecha)
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

/* ---------- Resolver dirección real del checkout ---------- */
// Saca address de: invoice.customer_details.address -> PaymentIntent.latest_charge.shipping/billing -> Customer.shipping/address -> Checkout Session metadata
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

  // 1) La propia invoice
  let addr = invoice.customer_details?.address || invoice.customer_address || null;
  let norm = normalize(addr);
  if (norm) return norm;

  // 2) PaymentIntent -> Charge -> shipping/billing
  if (invoice.payment_intent) {
    try {
      const pi = await stripeClient.paymentIntents.retrieve(invoice.payment_intent, { expand: ['latest_charge'] });
      let charge = pi.latest_charge;
      if (charge && typeof charge !== 'object') {
        charge = await stripeClient.charges.retrieve(charge);
      }
      const ship = charge?.shipping?.address || null;
      const bill = charge?.billing_details?.address || null;
      norm = normalize(ship) || normalize(bill);
      if (norm) return norm;
    } catch (e) {
      console.warn('[resolveCheckoutAddress] PI/Charge error:', e?.message || e);
    }
  }

  // 3) Customer
  if (invoice.customer) {
    try {
      const cust = await stripeClient.customers.retrieve(invoice.customer);
      norm = normalize(cust?.shipping?.address) || normalize(cust?.address);
      if (norm) return norm;
    } catch (e) {
      console.warn('[resolveCheckoutAddress] customer error:', e?.message || e);
    }
  }

  // 4) Últimas Checkout Sessions
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
  } catch (e) {
    console.warn('[resolveCheckoutAddress] sessions.list error:', e?.message || e);
  }

  // 5) Metadata de la invoice
  norm = normalize(null, {
    address: invoice.metadata?.address,
    city:    invoice.metadata?.city,
    postal:  invoice.metadata?.postal,
    country: invoice.metadata?.country
  });
  if (norm) return norm;

  // 6) Último recurso: país si existe
  return invoice.customer_details?.address || { country: invoice.customer_details?.address?.country || '' };
}

/* ---------- Email ADMIN ---------- */
async function sendAdminEmail({ session, lineItems, customerEmail, name, phone, amountTotal, currency, metadata, shipping }) {
  const to = process.env.CORPORATE_EMAIL || 'pedidos@tudominio.com';
  const from = process.env.CORPORATE_FROM || process.env.SMTP_USER || 'no-reply@tu-dominio.com';

  const itemsPlain = formatLineItemsPlain(lineItems, currency);
  const itemsHTML = formatLineItemsHTML(lineItems, currency);
  const totalFmt = currencyFormat(amountTotal, currency);

  const text = `
Nuevo pedido completado (Stripe)

Cliente: ${name || '(sin nombre)'} <${customerEmail || 'sin email'}>
Teléfono: ${phone || '-'}

Total: ${totalFmt}
Session ID: ${session.id}

Dirección:
${shipping?.line1 || ''} ${shipping?.line2 || ''}
${shipping?.postal_code || ''} ${shipping?.city || ''}
${shipping?.country || ''}

Productos:
${itemsPlain}

Metadata:
${JSON.stringify(metadata || {}, null, 2)}
`.trim();

  const bodyHTML = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:14px/1.5 system-ui; color:#374151;">
    <strong>Cliente:</strong> ${escapeHtml(name || '(sin nombre)')} &lt;${escapeHtml(customerEmail || 'sin email')}&gt;<br/>
    <strong>Teléfono:</strong> ${escapeHtml(phone || '-')}
  </p>
  <div style="height:1px; background:#e5e7eb;"></div>
</td></tr>
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
</td></tr>
<tr><td style="padding:8px 24px 8px; background:#ffffff;">
  <div style="font:12px system-ui; color:#6b7280;">
    <strong>Session ID:</strong> ${escapeHtml(session.id)}<br/>
    <strong>Dirección:</strong> ${escapeHtml([shipping?.line1, shipping?.line2].filter(Boolean).join(' ') || '')}<br/>
    ${escapeHtml([shipping?.postal_code, shipping?.city, shipping?.country].filter(Boolean).join(' ') || '')}<br/>
    <strong>Metadata:</strong><pre style="white-space:pre-wrap; font-size:12px; color:#374151; background:#f9fafb; border:1px solid #e5e7eb; padding:8px; border-radius:8px;">${escapeHtml(JSON.stringify(metadata || {}, null, 2))}</pre>
  </div>
</td></tr>`;

  const html = emailShell({
    title: `Nuevo pedido — ${totalFmt}`,
    headerLabel: `Nuevo pedido — ${totalFmt}`,
    bodyHTML,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(BRAND)}. Todos los derechos reservados.</p>`
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from, to, subject: `🧾 Nuevo pedido — ${totalFmt}`, text, html });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject: `🧾 Nuevo pedido — ${totalFmt}`, text, html });
    return;
  }
  console.warn('[email admin] Sin proveedor email configurado');
}

/* ---------- Email cliente (solo confirmación; SIN adjuntos) ---------- */
async function sendCustomerEmail({ to, name, amountTotal, currency, lineItems, orderId, supportEmail, brand, isSubscription }) {
  if (!to) { console.warn('[email cliente] Falta "to"'); return; }
  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const replyTo = process.env.SUPPORT_EMAIL || supportEmail || 'soporte@guarrosextremenos.com';
  const totalFmt = currencyFormat(Number(amountTotal || 0), currency || 'EUR');
  const itemsPlain = formatLineItemsPlain(lineItems, currency || 'EUR');
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

  const text = [
    name ? `Hola ${name},` : 'Hola,', '',
    intro, '', 'Resumen:', itemsPlain, '',
    `Total ${isSubscription ? 'del primer cargo' : 'pagado'}: ${totalFmt}`,
    orderId ? `ID de ${isSubscription ? 'suscripción/pedido' : 'pedido'} (Stripe): ${orderId}` : '',
    '', `Si tienes cualquier duda, responde a este correo o escríbenos a ${replyTo}.`,
    '', `Un saludo,`, `Equipo ${brand || BRAND}`
  ].filter(Boolean).join('\n');

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
</td></tr>`;

  const html = emailShell({
    title: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    headerLabel: isSubscription ? 'Suscripción activada' : 'Confirmación de pedido',
    bodyHTML,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand || BRAND)}. Todos los derechos reservados.</p>`
  });

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from, to, ...(bccList.length ? { bcc: bccList } : {}), reply_to: replyTo, subject, text, html });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, text, html });
    return;
  }
  console.warn('[email cliente] Sin proveedor email configurado');
}

/* ---------- Email combinado: Confirmación + Recibo + (Factura Stripe opcional) ---------- */
async function sendCustomerOrderAndInvoiceEmail({
  to, name, invoiceNumber, total, currency, pdfUrl, lineItems,
  brand, isSubscription, alsoBccCorporate,
  customer
}) {
  if (!to)  { console.warn('[combined email] Falta "to"'); return; }

  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const replyTo = process.env.SUPPORT_EMAIL || 'soporte@guarrosextremenos.com';
  const subject = isSubscription
    ? `✅ Suscripción activada — Factura ${invoiceNumber ? `#${invoiceNumber}` : ''} — ${brand || BRAND}`
    : `✅ Confirmación de pedido — Factura ${invoiceNumber ? `#${invoiceNumber}` : ''} — ${brand || BRAND}`;

  // Recibo propio (siempre)
  const receiptBuf = await createPaidReceiptPDF({
    invoiceNumber, total, currency, lineItems,
    brand, logoUrl: BRAND_LOGO_URL,
    customer: customer || { name, email: to },
    paidAt: new Date()
  });
  const receiptB64 = receiptBuf.toString('base64');

  const attachments = [{
    filename: `Recibo-${invoiceNumber || 'pedido'}.pdf`,
    content: receiptB64
  }];

  // Factura Stripe (opcional por ENV)
  const attachStripe = String(process.env.ATTACH_STRIPE_INVOICE || 'true').toLowerCase() !== 'false';
  if (attachStripe && pdfUrl) {
    const resp = await fetch(pdfUrl);
    if (resp.ok) {
      const stripeB64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
      attachments.push({
        filename: `Factura-${invoiceNumber || 'pedido'}.pdf`,
        content: stripeB64
      });
    } else {
      console.warn('[combined email] No se pudo descargar PDF de Stripe:', resp.status);
    }
  }

  // Normaliza items para helpers de HTML
  const mapped = (lineItems || []).map(li => ({
    description: li?.description,
    quantity: li?.quantity || 1,
    amount_total: li?.amount ?? li?.amount_total ?? 0,
    currency: (li?.currency || currency || 'eur'),
    price: { unit_amount: li?.price?.unit_amount ?? null, recurring: li?.price?.recurring || null }
  }));

  const totalFmt = currencyFormat(Number(total || 0), currency || 'EUR');
  const itemsHTML = formatLineItemsHTML(mapped, currency || 'EUR');
  const itemsPlain = formatLineItemsPlain(mapped, currency || 'EUR');

  const intro = isSubscription
    ? `¡Gracias por suscribirte a ${brand || BRAND}! Tu suscripción ha quedado activada correctamente.`
    : `¡Gracias por tu compra en ${brand || BRAND}! Tu pago se ha recibido correctamente.`;

  const text = [
    name ? `Hola ${name},` : 'Hola,', '',
    intro, '', 'Resumen:', itemsPlain, '',
    `Total: ${totalFmt}`,
    invoiceNumber ? `Factura: ${invoiceNumber}` : '',
    '', 'Adjuntamos tu recibo en PDF' + (attachStripe ? ' y la factura oficial de Stripe.' : '.'),
    '', `Si tienes cualquier duda, responde a este correo o escríbenos a ${replyTo}.`,
    '', `Un saludo,`, `Equipo ${brand || BRAND}`
  ].join('\n');

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
        <td style="padding:12px 0; font-size:14px; color:#111827; font-weight:700;">Total</td>
        <td></td>
        <td style="padding:12px 0; font-size:16px; color:#111827; font-weight:800; text-align:right;">${escapeHtml(totalFmt)}</td>
      </tr>
    </tfoot>
  </table>
</td></tr>`;

  const html = emailShell({
    title: 'Confirmación de pedido y factura',
    headerLabel: 'Confirmación de pedido y factura',
    bodyHTML,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand || BRAND)}. Todos los derechos reservados.</p>`
  });

  const bccList = [];
  if (alsoBccCorporate && process.env.CORPORATE_EMAIL) {
    const corp = (process.env.CORPORATE_EMAIL || '').toLowerCase();
    const dest = String(to || '').toLowerCase();
    if (corp && corp !== dest) bccList.push(process.env.CORPORATE_EMAIL);
  }

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from, to, ...(bccList.length ? { bcc: bccList } : {}), reply_to: replyTo, subject, text, html, attachments });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, text, html, attachments });
    return;
  }
  console.warn('[combined email] Sin proveedor email configurado');
}

/* ---------- SMTP fallback ---------- */
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

/* ========================= DB (POOL) ========================= */
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { require: true, rejectUnauthorized: false } })
  : null;

async function logOrder(order) {
  if (!pool) { console.warn('[db] DATABASE_URL no configurado. No se guardará el pedido.'); return; }
  const text = `
    INSERT INTO orders (session_id, email, name, phone, total, currency, items, metadata, shipping, status, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (session_id) DO NOTHING
  `;
  const values = [
    order.sessionId,
    order.customerEmail || null,
    order.name || null,
    order.phone || null,
    order.amountTotal || 0,
    order.currency || 'EUR',
    JSON.stringify(order.lineItems || []),
    JSON.stringify(order.metadata || {}),
    JSON.stringify(order.shipping || {}),
    order.status || 'paid',
    order.createdAt || new Date().toISOString(),
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
