import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import Stripe from 'stripe';

// --- Notificaciones / Email ---
import { Resend } from 'resend';          // npm i resend
import nodemailer from 'nodemailer';      // npm i nodemailer

// --- Registro en DB (opcional) ---
import pg from 'pg';                       // npm i pg
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
 * ⚠️ IMPORTANTE: debe ir ANTES de express.json()
 * y debe usar body "raw" para verificar firma.
 */
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Cargamos line items para el email/registro
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });

        const customerEmail = session.customer_details?.email || session.customer_email;
        const name = session.customer_details?.name || session.metadata?.name;
        const phone = session.customer_details?.phone || session.metadata?.phone;
        const shipping = session.shipping_details?.address;
        const metadata = session.metadata || {};
        const amountTotal = (session.amount_total ?? 0) / 100;
        const currency = (session.currency || 'eur').toUpperCase();

        // 1) Email al corporativo
        await sendAdminEmail({
          session,
          lineItems: lineItems?.data || [],
          customerEmail,
          name,
          phone,
          amountTotal,
          currency,
          metadata,
          shipping,
        });

        // 2) Registro en DB (si DATABASE_URL está configurado)
        await logOrder({
          sessionId: session.id,
          amountTotal,
          currency,
          customerEmail,
          name,
          phone,
          lineItems: lineItems?.data || [],
          metadata,
          shipping,
          status: 'paid',
          createdAt: new Date().toISOString(),
        });

        console.log('✅ checkout.session.completed', session.id);
        break;
      }

      case 'invoice.payment_succeeded': {
        // Útil para renovaciones de suscripción
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
        // Otros eventos que no procesamos
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[webhook] error procesando evento:', err);
    return res.status(500).send('Error procesando el evento');
  }
});

// Resto de middleware después del webhook
app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/**
 * Crear sesión de Checkout
 * Reenvía a Stripe los items y, si llegan, customer_email / metadata
 */
app.post('/create-checkout-session', async (req, res) => {
  try {
    const {
      items = [],
      mode = 'payment',
      success_url,
      cancel_url,
      // Datos opcionales que puede mandarte el front (/checkout)
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

      // Si el front envía email/teléfono/nombre como metadata o customer
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

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

/* ----------------- Helpers ----------------- */

// Email corporativo (elige Resend o SMTP abajo)
async function sendAdminEmail({ session, lineItems, customerEmail, name, phone, amountTotal, currency, metadata, shipping }) {
  const to = process.env.CORPORATE_EMAIL || 'pedidos@tudominio.com';
  const from = process.env.CORPORATE_FROM || 'no-reply@tu-dominio.com';

  const itemsText = (lineItems || [])
    .map(li => `• ${li.description} x${li.quantity} — ${(li.amount_total / 100).toFixed(2)} ${currency}`)
    .join('\n');

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

  // --- Opción A: Resend ---
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

  // --- Opción B: SMTP ---
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from,
      to,
      subject: `Nuevo pedido — ${amountTotal.toFixed(2)} ${currency}`,
      text: bodyText
    });
    return;
  }

  // Si no hay proveedor configurado, al menos deja constancia en logs
  console.warn('[email] No hay RESEND_API_KEY ni SMTP configurado. Email no enviado.');
}

// Registro en DB (Postgres en Render/Supabase). Si no hay DATABASE_URL, se omite.
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

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
