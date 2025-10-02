import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import Stripe from 'stripe';

// --- Notificaciones / Email ---
import { Resend } from 'resend';          // API (recomendada en Render)
import nodemailer from 'nodemailer';      // SMTP (fallback si tu plan lo permite)

// --- Registro en DB (Supabase / Postgres) ---
import pg from 'pg';
const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// CORS (para el front)
const allowList = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => (!origin || allowList.length === 0 || allowList.includes(origin)) ? cb(null, true) : cb(new Error('Not allowed by CORS: ' + origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
};

app.use(morgan('tiny'));

/* ========================= WEBHOOK (ACK RÁPIDO) ========================= */
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

  // OK inmediato; lo pesado corre detrás
  res.status(200).json({ received: true });

  queueMicrotask(async () => {
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;

          // Line items
          let lineItems = [];
          try {
            const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] });
            lineItems = li?.data || [];
          } catch (e) {
            console.warn('[webhook] no se pudieron leer lineItems:', e.message);
          }

          const customerEmail = session.customer_details?.email || session.customer_email;
          const name = session.customer_details?.name || session.metadata?.name;
          const phone = session.customer_details?.phone || session.metadata?.phone;
          const shipping = session.shipping_details?.address;
          const metadata = session.metadata || {};
          const amountTotal = (session.amount_total ?? 0) / 100;
          const currency = (session.currency || 'eur').toUpperCase();

          // ⬇️ NUEVO: detectar si es suscripción (modo o alguna línea recurring)
          const isSubscription =
            session.mode === 'subscription' ||
            (Array.isArray(lineItems) && lineItems.some(li => li?.price?.recurring));

          // Admin
          try {
            await sendAdminEmail({
              session, lineItems, customerEmail, name, phone,
              amountTotal, currency, metadata, shipping,
            });
            console.log('📧 Email admin enviado OK');
          } catch (e) {
            console.error('📧 Email admin ERROR:', e);
          }

          // Cliente (con copy distinto si es suscripción)
          try {
            await sendCustomerEmail({
              to: customerEmail,
              name,
              amountTotal,
              currency,
              lineItems,
              orderId: session.id,
              supportEmail: process.env.SUPPORT_EMAIL,
              brand: process.env.BRAND_NAME || "Guarros Extremeños",
              isSubscription, // ⬅️ pasa el flag
            });
            console.log('📧 Email cliente enviado OK');
          } catch (e) {
            console.error('📧 Email cliente ERROR:', e);
          }

          // DB
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

        // ⬇️ NUEVO: cuando la factura está lista, enviamos PDF adjunto
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;

          try {
            const to = invoice.customer_email;
            const name = invoice.customer_name || invoice.customer_details?.name || '';
            const pdfUrl = invoice.invoice_pdf; // URL pública temporal
            const invoiceNumber = invoice.number || invoice.id;
            const currency = (invoice.currency || 'eur').toUpperCase();
            const total = (invoice.amount_paid ?? invoice.amount_due ?? 0) / 100;

            if (to && pdfUrl) {
              await sendInvoiceEmail({
                to,
                name,
                invoiceNumber,
                total,
                currency,
                pdfUrl,
                brand: process.env.BRAND_NAME || "Guarros Extremeños",
                alsoToCorporate: String(process.env.INVOICE_BCC_CORPORATE || '').toLowerCase() === 'true',
              });
              console.log('📧 Factura enviada al cliente OK');
            } else {
              console.warn('[invoice.email] Falta to o pdfUrl → no se envía email de factura');
            }
          } catch (e) {
            console.error('📧 Envío de factura ERROR:', e);
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

/* ========================= API REST ========================= */
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

    const shippingRate = process.env.STRIPE_SHIPPING_RATE_ID;
    const isSubscription = mode === 'subscription';

    const sessionParams = {
      mode,
      line_items: items,
      success_url,
      cancel_url,
      allow_promotion_codes: true,
      customer_email: customer?.email || undefined,
      customer_creation: 'if_required',
      metadata: {
        ...(metadata || {}),
        name: customer?.name || metadata?.name,
        phone: customer?.phone || metadata?.phone,
        address: shipping_address?.address || metadata?.address,
        city: shipping_address?.city || metadata?.city,
        postal: shipping_address?.postal_code || metadata?.postal,
        country: shipping_address?.country || metadata?.country,
        source: (metadata?.source || 'guarros-front')
      },
      billing_address_collection: 'auto'
    };

    if (!isSubscription && shippingRate) {
      sessionParams.shipping_address_collection = { allowed_countries: ['ES', 'PT'] };
      sessionParams.shipping_options = [{ shipping_rate: shippingRate }];
      sessionParams.invoice_creation = { enabled: true };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ----------------- ENDPOINTS DE PRUEBA ----------------- */
app.get('/test-db-ping', async (req, res) => {
  try {
    if (!pool) throw new Error('DATABASE_URL no configurado');
    const r = await pool.query('select now() as now');
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error('[/test-db-ping] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/test-db-insert', async (req, res) => {
  try {
    if (!pool) throw new Error('DATABASE_URL no configurado');
    await pool.query(
      `insert into orders (session_id, email, name, total, currency, items, metadata, shipping, status, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (session_id) do nothing`,
      [
        'test_session_' + Date.now(),
        'test@example.com',
        'Pedido de prueba',
        12.34,
        'EUR',
        JSON.stringify([]),
        JSON.stringify({ test: true }),
        JSON.stringify({}),
        'paid',
        new Date().toISOString()
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[/test-db-insert] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

app.post('/test-email-customer', async (req, res) => {
  try {
    const to = req.body?.to || req.query?.to || 'tu-correo-de-prueba@ejemplo.com';
    await sendCustomerEmail({
      to,
      name: 'Cliente de prueba',
      amountTotal: 123.45,
      currency: 'EUR',
      orderId: 'test_' + Date.now(),
      lineItems: [
        { description: 'Jamón Canalla', quantity: 1, amount_total: 9999, currency: 'eur' },
        { description: 'Loncheado', quantity: 2, amount_total: 1599, currency: 'eur' },
      ],
      brand: process.env.BRAND_NAME || "Guarros Extremeños",
      isSubscription: false,
    });
    res.json({ ok: true, to });
  } catch (e) {
    console.error('[/test-email-customer] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------- MÉTRICAS ----------------- */
app.get('/metrics/overview', async (req, res) => {
  try {
    if (!pool) throw new Error('DATABASE_URL no configurado');
    const [daily, monthly, mix, top] = await Promise.all([
      pool.query('select * from v_revenue_daily_90d'),
      pool.query('select * from v_revenue_monthly_12m'),
      pool.query('select * from v_mix_subscription_90d'),
      pool.query('select * from v_top_products_90d'),
    ]);
    res.json({ ok: true, daily: daily.rows, monthly: monthly.rows, mix: mix.rows, top: top.rows });
  } catch (e) {
    console.error('[/metrics/overview] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

/* ========================= HELPERS EMAIL ========================= */
// Branding
const BRAND = process.env.BRAND_NAME || "Guarros Extremeños";
const BRAND_PRIMARY = process.env.BRAND_PRIMARY || '#D62828';
const BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || '';

// Escapes HTML
function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function currencyFormat(amount = 0, currency = 'EUR') {
  try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(Number(amount)); }
  catch { return `${Number(amount).toFixed(2)} ${(currency||'EUR').toUpperCase()}`; }
}

function formatLineItemsPlain(lineItems = [], currency = 'EUR') {
  const lines = (lineItems || []).map(li => `• ${li.description} x${li.quantity} — ${currencyFormat((li.amount_total ?? 0)/100, currency)}`);
  return lines.length ? lines.join('\n') : '—';
}

function formatLineItemsHTML(lineItems = [], currency = 'EUR') {
  if (!Array.isArray(lineItems) || !lineItems.length)
    return '<tr><td colspan="3" style="padding:8px 0;color:#6b7280">No hay productos.</td></tr>';
  return lineItems.map(li => {
    const total = currencyFormat((li.amount_total ?? 0)/100, currency);
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

/* ---------- Email ADMIN (HTML + texto) ---------- */
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
  <p style="margin:0 0 12px; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif; color:#374151;">
    <strong>Cliente:</strong> ${escapeHtml(name || '(sin nombre)')} &lt;${escapeHtml(customerEmail || 'sin email')}&gt;<br/>
    <strong>Teléfono:</strong> ${escapeHtml(phone || '-')}
  </p>
  <div style="height:1px; background:#e5e7eb;"></div>
</td></tr>
<tr><td style="padding:8px 24px 0; background:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Total</th>
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
  <div style="font:12px system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif; color:#6b7280;">
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
    await resend.emails.send({
      from,
      to,
      subject: `🧾 Nuevo pedido — ${totalFmt}`,
      text,
      html
    });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject: `🧾 Nuevo pedido — ${totalFmt}`, text, html });
    return;
  }
  console.warn('[email admin] No hay RESEND_API_KEY ni SMTP configurado. Email no enviado.');
}

/* ---------- Email CLIENTE (HTML + texto + BCC opcional + SUSCRIPCIÓN) ---------- */
async function sendCustomerEmail({ to, name, amountTotal, currency, lineItems, orderId, supportEmail, brand, isSubscription }) {
  if (!to) return;
  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const replyTo = process.env.SUPPORT_EMAIL || supportEmail || 'soporte@guarrosextremenos.com';
  const totalFmt = currencyFormat(Number(amountTotal || 0), currency || 'EUR');
  const itemsPlain = formatLineItemsPlain(lineItems, currency || 'EUR');
  const itemsHTML = formatLineItemsHTML(lineItems, currency || 'EUR');

  // evita duplicados si el destinatario es el corporativo
  const bccList = [];
  const wantBcc = String(process.env.CUSTOMER_BCC_CORPORATE || '').toLowerCase() === 'true';
  const corp = (process.env.CORPORATE_EMAIL || '').toLowerCase();
  const dest = String(to || '').toLowerCase();
  if (wantBcc && corp && corp !== dest) bccList.push(process.env.CORPORATE_EMAIL);

  // Copy distinto si es suscripción
  const subject = isSubscription
    ? `✅ Suscripción activada ${orderId ? `#${orderId}` : ''} — ${brand || BRAND}`
    : `✅ Confirmación de pedido ${orderId ? `#${orderId}` : ''} — ${brand || BRAND}`;

  const intro = isSubscription
    ? `¡Gracias por suscribirte a ${brand || BRAND}! Tu suscripción ha quedado activada correctamente.`
    : `¡Gracias por tu compra en ${brand || BRAND}! Tu pago se ha recibido correctamente.`;

  const text = [
    name ? `Hola ${name},` : 'Hola,',
    '',
    intro,
    '',
    'Resumen:',
    itemsPlain,
    '',
    `Total ${isSubscription ? 'del primer cargo' : 'pagado'}: ${totalFmt}`,
    orderId ? `ID de ${isSubscription ? 'suscripción/pedido' : 'pedido'} (Stripe): ${orderId}` : '',
    '',
    `Si tienes cualquier duda, responde a este correo o escríbenos a ${replyTo}.`,
    '',
    `Un saludo,`,
    `Equipo ${brand || BRAND}`
  ].filter(Boolean).join('\n');

  const bodyHTML = `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:15px system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif; color:#111827;">
    ${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}
  </p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">
    ${escapeHtml(intro)}
  </p>
</td></tr>
<tr><td style="padding:0 24px 8px; background:#ffffff;"><div style="height:1px; background:#e5e7eb;"></div></td></tr>
<tr><td style="padding:8px 24px 0; background:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial,'Noto Sans',sans-serif;">
    <thead>
      <tr>
        <th align="left"  style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Producto</th>
        <th align="center"style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Cant.</th>
        <th align="right" style="padding:10px 0; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Total</th>
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
${orderId ? `
<tr><td style="padding:0 24px 12px; background:#ffffff;">
  <div style="font:12px system-ui; color:#6b7280;">ID de ${isSubscription ? 'suscripción/pedido' : 'pedido'} (Stripe): <span style="color:#374151;">${escapeHtml(orderId)}</span></div>
</td></tr>` : ''}
<tr><td style="padding:8px 24px 16px; background:#ffffff;">
  <p style="margin:0; font:13px system-ui; color:#374151;">
    Si tienes cualquier duda, responde a este correo o escríbenos a
    <a href="mailto:${escapeHtml(replyTo)}" style="color:${BRAND_PRIMARY}; text-decoration:none;">${escapeHtml(replyTo)}</a>.
  </p>
</td></tr>`;

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
      text,
      html
    });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, text, html });
    return;
  }
  console.warn('[email cliente] No hay RESEND_API_KEY ni SMTP configurado. Email no enviado.');
}

/* ---------- Email FACTURA (descarga PDF y adjunta) ---------- */
async function sendInvoiceEmail({ to, name, invoiceNumber, total, currency, pdfUrl, brand, alsoToCorporate }) {
  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const replyTo = process.env.SUPPORT_EMAIL || 'soporte@guarrosextremenos.com';
  const subject = `🧾 Factura ${invoiceNumber ? `#${invoiceNumber}` : ''} — ${brand || BRAND}`;
  const totalFmt = currencyFormat(Number(total || 0), currency || 'EUR');

  // descarga PDF (Node 18+ trae fetch nativo)
  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`No se pudo descargar la factura PDF (${resp.status})`);
  const buf = Buffer.from(await resp.arrayBuffer());

  const text = [
    name ? `Hola ${name},` : 'Hola,',
    '',
    `Adjuntamos tu factura ${invoiceNumber ? `#${invoiceNumber}` : ''} por un importe de ${totalFmt}.`,
    '',
    'Gracias por confiar en nosotros.',
    '',
    `Un saludo,`,
    `Equipo ${brand || BRAND}`
  ].join('\n');

  const html = emailShell({
    title: `Factura ${invoiceNumber || ''}`,
    headerLabel: `Factura ${invoiceNumber || ''}`,
    bodyHTML: `
<tr><td style="padding:0 24px 8px; background:#ffffff;">
  <p style="margin:0 0 12px; font:15px system-ui; color:#111827;">
    ${name ? `Hola ${escapeHtml(name)},` : 'Hola,'}
  </p>
  <p style="margin:0 0 12px; font:14px system-ui; color:#374151;">
    Adjuntamos tu factura ${invoiceNumber ? `<strong>#${escapeHtml(invoiceNumber)}</strong>` : ''} por un importe de <strong>${escapeHtml(totalFmt)}</strong>.
  </p>
</td></tr>`,
    footerHTML: `<p style="margin:0; font:11px system-ui; color:#9ca3af;">© ${new Date().getFullYear()} ${escapeHtml(brand || BRAND)}. Todos los derechos reservados.</p>`
  });

  const attachments = [{ filename: `Factura-${invoiceNumber || 'pedido'}.pdf`, content: buf.toString('base64') }];

  const bccList = [];
  if (alsoToCorporate && process.env.CORPORATE_EMAIL) {
    bccList.push(process.env.CORPORATE_EMAIL);
  }

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from, to,
      ...(bccList.length ? { bcc: bccList } : {}),
      reply_to: replyTo,
      subject, text, html,
      attachments
    });
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, text, html, attachments });
    return;
  }
  console.warn('[invoice email] No hay RESEND_API_KEY ni SMTP configurado. Email no enviado.');
}

/* ---------- SMTP fallback (HTML soportado + adjuntos) ---------- */
async function sendViaGmailSMTP({ from, to, subject, text, html, attachments }) {
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(port) === '465';
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
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
      li.amount_total ?? 0,
      (li.currency || currency || 'eur').toUpperCase(),
      JSON.stringify(li),
    ];
    await pool.query(text, vals);
  }
}
