import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Stripe from 'stripe'

const app = express()
const PORT = process.env.PORT || 4242
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const ALLOWED_COUNTRIES = (process.env.ALLOWED_COUNTRIES || 'ES').split(',').map(s=>s.trim()).filter(Boolean)
const SHIPPING_RATES = (process.env.SHIPPING_RATES || '').split(',').map(s=>s.trim()).filter(Boolean)
const ENABLE_AUTOMATIC_TAX = (process.env.ENABLE_AUTOMATIC_TAX || 'true') === 'true'

if (!STRIPE_SECRET_KEY) {
  console.error('❌ Missing STRIPE_SECRET_KEY in environment')
  process.exit(1)
}

const stripe = new Stripe(STRIPE_SECRET_KEY)

const allowList = [
  process.env.FRONTEND_URL,           // prod, p.ej. https://guarros-extremenos-front.vercel.app
  process.env.FRONTEND_URL_2 || "",   // opcional, otro dominio
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // permite llamadas servidor-servidor o curl
    try {
      const host = new URL(origin).host;
      const isVercelPreview = /\.vercel\.app$/.test(host);
      if (allowList.includes(origin) || isVercelPreview) {
        return callback(null, true);
      }
    } catch (_) {}
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  optionsSuccessStatus: 200,
}));

app.use(express.json())

// Health
app.get('/health', (_, res) => res.json({ ok: true }))

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items = [], mode = 'payment', success_url, cancel_url, customer_email, metadata = {} } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No line items provided' })
    for (const li of items) {
      if (!li.price || typeof li.quantity !== 'number') return res.status(400).json({ error: 'Invalid line item: need price + quantity' })
    }
    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: items,
      success_url: success_url || `${FRONTEND_URL}/success`,
      cancel_url: cancel_url || `${FRONTEND_URL}/cancel`,
      customer_email,
      shipping_address_collection: { allowed_countries: ALLOWED_COUNTRIES },
      shipping_options: SHIPPING_RATES.length ? SHIPPING_RATES.map(id => ({ shipping_rate: id })) : undefined,
      automatic_tax: { enabled: ENABLE_AUTOMATIC_TAX },
      phone_number_collection: { enabled: true },
      metadata
    })
    res.json({ url: session.url, id: session.id })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
})

// --- WEBHOOK (Stripe) ---
import Stripe from 'stripe';
import fetch from 'node-fetch';

// ⚠️ Webhook debe usar body "raw" (lo tienes configurado abajo)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = endpointSecret
      ? stripe.webhooks.constructEvent(req.body, sig, endpointSecret)
      : JSON.parse(req.body); // solo para pruebas locales sin verificación
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Helpers
  const sendEmail = async ({ to, subject, html }) => {
    const RESEND_API_KEY = process.env.RESEND_API_KEY; // opcional (o usa tu proveedor SMTP)
    const FROM = process.env.EMAIL_FROM || 'no-reply@guarrosextremenos.com';
    if (!RESEND_API_KEY) {
      console.warn('⚠️ RESEND_API_KEY no definido. Email no enviado.');
      return;
    }
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!resp.ok) {
      const errTxt = await resp.text();
      console.error('❌ Error enviando email:', errTxt);
    }
  };

  const buildOrderHTML = (order) => {
    const itemsHTML = order.items.map(i =>
      `<li>${i.quantity} × ${i.name} — ${i.price_unit} ${order.currency.toUpperCase()}</li>`
    ).join('');
    return `
      <div style="font-family:system-ui,Segoe UI,Arial">
        <h2>Gracias por tu compra 🎉</h2>
        <p>Pedido <b>${order.id}</b></p>
        <ul>${itemsHTML}</ul>
        <p><b>Total:</b> ${order.amount_total} ${order.currency.toUpperCase()}</p>
        <p>Enviaremos tu pedido a:<br>
        ${order.customer_details?.name || ''}<br>
        ${order.customer_details?.email || ''}<br>
        ${order.shipping_details?.address?.line1 || ''} ${order.shipping_details?.address?.line2 || ''}<br>
        ${order.shipping_details?.address?.postal_code || ''} ${order.shipping_details?.address?.city || ''}, ${order.shipping_details?.address?.country || ''}</p>
        <hr/>
        <p>Guarros Extremeños — El único “guarro” que querrás en tu mesa 🐖</p>
      </div>
    `;
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      // 1) Obtenemos la sesión completa con line_items
      const session = await stripe.checkout.sessions.retrieve(
        event.data.object.id,
        { expand: ['line_items.data.price.product', 'customer', 'subscription'] }
      );

      // 2) Montamos un “pedido” sencillo
      const order = {
        id: session.id,
        mode: session.mode, // 'payment' | 'subscription'
        amount_total: (session.amount_total ?? 0) / 100,
        currency: session.currency || 'eur',
        customer_details: session.customer_details || null,
        shipping_details: session.shipping_details || null,
        items: (session.line_items?.data || []).map(li => ({
          name: li.description,
          quantity: li.quantity,
          price_unit: (li.amount_subtotal ?? 0) / 100,
        })),
        // lo puedes ampliar con session.metadata si necesitas más datos
      };

      // 3) “Guardar pedido”: ahora mismo en Stripe tienes todo (pagos/clientes/subscriptions).
      // Si quieres persistirlo fuera, añade aquí tu DB o un webhook a tu ERP/Google Sheets.
      console.log('✅ Pedido completado:', JSON.stringify(order, null, 2));

      // 4) Email al cliente (si tenemos su correo)
      const to = order.customer_details?.email || process.env.FALLBACK_EMAIL_TO;
      if (to) {
        await sendEmail({
          to,
          subject: order.mode === 'subscription'
            ? '¡Suscripción activada — Guarros Extremeños!'
            : '¡Pedido confirmado — Guarros Extremeños!',
          html: buildOrderHTML(order),
        });
      }

      // 5) (Opcional) Email interno notificación de nuevo pedido
      if (process.env.NOTIFY_NEW_ORDER_TO) {
        await sendEmail({
          to: process.env.NOTIFY_NEW_ORDER_TO,
          subject: `Nuevo ${order.mode === 'subscription' ? 'ALTA de suscripción' : 'pedido'} — ${order.amount_total} ${order.currency.toUpperCase()}`,
          html: `<pre>${JSON.stringify(order, null, 2)}</pre>`,
        });
      }

      break;
    }

    case 'invoice.payment_succeeded': {
      // Pagos recurrentes de suscripciones (renovaciones)
      const invoice = event.data.object;
      console.log('ℹ️ Renovación pagada:', invoice.id);
      // Aquí podrías enviar email de “renovación cobrada” si quieres.
      break;
    }

    default:
      console.log(`ℹ️ Event no manejado: ${event.type}`);
  }

  res.json({ received: true });
});


app.listen(PORT, () => console.log(`✅ Server on http://localhost:${PORT}`))
