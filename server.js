import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import Stripe from 'stripe';

// --- Notificaciones / Email ---
import { Resend } from 'resend';          // opcional (si usas Resend)
import nodemailer from 'nodemailer';      // SMTP (Gmail u otro)

// --- Registro en DB (Supabase / Postgres) ---
import pg from 'pg';
const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// CORS (para el front)
const allowList = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowList.length === 0 || allowList.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
};

app.use(morgan('tiny'));

/**
 * WEBHOOK de Stripe
 * ⚠️ Debe ir ANTES de express.json() y usar body "raw" para verificar firma.
 */
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

  // ✅ ACK rápido; lo pesado corre en background
  res.status(200).json({ received: true });

  queueMicrotask(async () => {
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;

          // Line items (para email/registro)
          let lineItems = [];
          try {
            const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
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

          // Email ADMIN (no bloqueante)
          try {
            await sendAdminEmail({
              session, lineItems, customerEmail, name, phone,
              amountTotal, currency, metadata, shipping,
            });
            console.log('📧 Email admin enviado OK');
          } catch (e) {
            console.error('📧 Email admin ERROR:', e);
          }

          // 🔹 NUEVO: Email CLIENTE (no bloqueante)
          try {
            await sendCustomerEmail({
              to: customerEmail,
              name,
              amountTotal,
              currency,
              lineItems,
              orderId: session.id,
              supportEmail: process.env.SUPPORT_EMAIL,
              brand: "Guarros Extremeños",
            });
            console.log('📧 Email cliente enviado OK');
          } catch (e) {
            console.error('📧 Email cliente ERROR:', e);
          }

          // Registro en DB (no bloqueante)
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

            // También guardamos líneas normalizadas
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
          console.log('✅ invoice.payment_succeeded', invoice.id);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          console.warn('⚠️ invoice.payment_failed', invoice.id);
          break;
        }

        default:
          console.log('ℹ️ Evento ignorado:', event.type);
      }
    } catch (err) {
      console.error('[webhook bg] error:', err);
    }
  });
});

// Resto de middleware después del webhook
app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/**
 * Crear sesión de Checkout
 */
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

    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'Missing items' });
    if (!success_url || !cancel_url)
      return res.status(400).json({ error: 'Missing success_url/cancel_url' });

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

// 1) Ping a la base de datos
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

// 2) Inserción mínima en la tabla orders
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

// 3) Prueba de email (prioriza Resend si está configurado)
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

    // Fallback SMTP (Render suele bloquear SMTP; úsalo solo si tu plan lo permite)
    const info = await sendViaGmailSMTP({ from, to, subject, text });
    return res.json({ ok: true, provider: 'smtp', messageId: info.messageId });
  } catch (e) {
    console.error('[/test-email] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 4) 🔹 NUEVO: prueba de email al cliente
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
      brand: "Guarros Extremeños",
    });
    res.json({ ok: true, to });
  } catch (e) {
    console.error('[/test-email-customer] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------- MÉTRICAS (lee vistas en la DB) ----------------- */
app.get('/metrics/overview', async (req, res) => {
  try {
    if (!pool) throw new Error('DATABASE_URL no configurado');
    const [daily, monthly, mix, top] = await Promise.all([
      pool.query('select * from v_revenue_daily_90d'),
      pool.query('select * from v_revenue_monthly_12m'),
      pool.query('select * from v_mix_subscription_90d'),
      pool.query('select * from v_top_products_90d'),
    ]);
    res.json({
      ok: true,
      daily: daily.rows,
      monthly: monthly.rows,
      mix: mix.rows,
      top: top.rows,
    });
  } catch (e) {
    console.error('[/metrics/overview] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

/* ----------------- Helpers ----------------- */

// Email corporativo — intenta Resend; si no, SMTP
async function sendAdminEmail({ session, lineItems, customerEmail, name, phone, amountTotal, currency, metadata, shipping }) {
  const to = process.env.CORPORATE_EMAIL || 'pedidos@tudominio.com';
  const from = process.env.CORPORATE_FROM || process.env.SMTP_USER || 'no-reply@tu-dominio.com';

  const itemsText = formatLineItemsPlain(lineItems, currency);

  const bodyText = `
Nuevo pedido completado (Stripe)

Cliente: ${name || '(sin nombre)'} <${customerEmail || 'sin email'}>
Teléfono: ${phone || '-'}

Total: ${amountTotal.toFixed(2)} ${currency}
Session ID: ${session.id}

Dirección:
${shipping?.line1 || ''} ${shipping?.line2 || ''}
${shipping?.postal_code || ''} ${shipping?.city || ''}
${shipping?.country || ''}

Productos:
${itemsText}

Metadata:
${JSON.stringify(metadata || {}, null, 2)}
  `.trim();

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from,
      to,
      subject: `Nuevo pedido — ${amountTotal.toFixed(2)} ${currency}`,
      text: bodyText
    });
    return;
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject: `Nuevo pedido — ${amountTotal.toFixed(2)} ${currency}`, text: bodyText });
    return;
  }

  console.warn('[email] No hay RESEND_API_KEY ni SMTP configurado. Email no enviado.');
}

// 🔹 NUEVO: Email al cliente
async function sendCustomerEmail({ to, name, amountTotal, currency, lineItems, orderId, supportEmail, brand = "Guarros Extremeños" }) {
  if (!to) return;
  const C = (currency || 'EUR').toUpperCase();
  const totalFmt = (Number(amountTotal || 0)).toFixed(2) + ' ' + C;
  const itemsTxt = formatLineItemsPlain(lineItems, C);
  const from = process.env.CUSTOMER_FROM || process.env.CORPORATE_FROM || 'no-reply@guarrosextremenos.com';
  const replyTo = process.env.SUPPORT_EMAIL || supportEmail || 'soporte@guarrosextremenos.com';

  const subject = `✅ Confirmación de pedido ${orderId ? `#${orderId}` : ''} — ${brand}`;
  const text = `
Hola${name ? ' ' + name : ''},

¡Gracias por tu compra en ${brand}! Tu pago se ha recibido correctamente.

Resumen del pedido:
${itemsTxt}

Total pagado: ${totalFmt}
${orderId ? `ID de pedido (Stripe): ${orderId}\n` : ''}

En breve recibirás otra comunicación si tu pedido requiere información adicional de envío o de suscripción.

Si tienes cualquier duda, responde a este correo o escríbenos a ${replyTo}.

Un saludo,
Equipo ${brand}
  `.trim();

  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from,
      to,
      reply_to: replyTo,
      subject,
      text,
    });
    return;
  }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaGmailSMTP({ from, to, subject, text });
    return;
  }

  console.warn('[email-customer] No hay RESEND_API_KEY ni SMTP configurado. Email cliente no enviado.');
}

// Formateo simple de líneas
function formatLineItemsPlain(lineItems = [], currency = 'EUR') {
  const C = String(currency || 'EUR').toUpperCase();
  const lines = (lineItems || []).map(li => {
    const total = ((li.amount_total ?? 0) / 100).toFixed(2);
    return `• ${li.description} x${li.quantity} — ${total} ${C}`;
    // Si quieres mostrar precio unitario, puedes leer li.price?.unit_amount
  });
  return lines.length ? lines.join('\n') : '—';
}

// Transporte SMTP con verificación y logs (Gmail App Password o cualquier SMTP)
async function sendViaGmailSMTP({ from, to, subject, text }) {
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(port) === '465'; // 465 = SSL; 587 = STARTTLS
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,              // smtp.gmail.com
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,            // tu_cuenta@gmail.com
      pass: process.env.SMTP_PASS,            // App Password (16 chars)
    },
    logger: true,
    debug: true,
  });

  await transporter.verify();
  console.log('[smtp] transporter.verify() OK');

  const info = await transporter.sendMail({ from, to, subject, text });
  console.log('[smtp] Message sent:', info.messageId, 'accepted:', info.accepted, 'rejected:', info.rejected);
  return info;
}

// Pool de Postgres (Supabase) con SSL tolerante
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        require: true,
        rejectUnauthorized: false
      },
    })
  : null;

// Guarda el pedido (cabecera)
async function logOrder(order) {
  if (!pool) {
    console.warn('[db] DATABASE_URL no configurado. No se guardará el pedido.');
    return;
  }
  const text = `
    INSERT INTO orders
      (session_id, email, name, phone, total, currency, items, metadata, shipping, status, created_at)
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

// Guarda líneas normalizadas
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
