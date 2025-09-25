// server.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Stripe from 'stripe'

/* ========= Config básica ========= */
const app = express()
const PORT = process.env.PORT || 4242

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
if (!STRIPE_SECRET_KEY) {
  console.error('❌ Falta STRIPE_SECRET_KEY en el entorno')
  process.exit(1)
}
const stripe = new Stripe(STRIPE_SECRET_KEY)

/* ========= CORS (permitir tu front) =========
   FRONTEND_URL debe incluir protocolo, p.ej. https://tuapp.vercel.app
   FRONTEND_URL_2 opcional (otro dominio o preview)
*/
const ALLOW = [process.env.FRONTEND_URL, process.env.FRONTEND_URL_2].filter(Boolean)
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true) // permite curl/SSR
    try {
      // Acepta el dominio exacto en ALLOW y (opcional) previews *.vercel.app
      if (ALLOW.includes(origin)) return cb(null, true)
      const host = new URL(origin).host
      if (/\.vercel\.app$/.test(host)) return cb(null, true) // quita esta línea si no quieres previews
    } catch {}
    return cb(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature'],
  optionsSuccessStatus: 200,
}

/* ========= WEBHOOK (ANTES del json parser) ========= */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event
  try {
    event = endpointSecret
      ? stripe.webhooks.constructEvent(req.body, sig, endpointSecret)
      : JSON.parse(req.body) // solo sin verificación (no usar en producción)
  } catch (err) {
    console.error('❌ Webhook signature failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
          expand: ['line_items.data.price.product', 'customer', 'subscription'],
        })
        // Aquí puedes guardar el pedido en DB y mandar email
        console.log('✅ Pedido completado:', {
          id: session.id,
          mode: session.mode,
          amount_total: (session.amount_total ?? 0) / 100,
          currency: session.currency,
          customer: session.customer_details?.email,
        })
        break
      }
      case 'invoice.payment_succeeded': {
        console.log('ℹ️ Renovación de suscripción cobrada:', event.data.object.id)
        break
      }
      default:
        console.log('ℹ️ Evento no manejado:', event.type)
    }
    res.json({ received: true })
  } catch (err) {
    console.error('❌ Error procesando webhook:', err)
    res.status(500).json({ error: 'Webhook handler error' })
  }
})

/* ========= Parsers y CORS para el resto de rutas ========= */
app.use(cors(corsOptions))
app.use(express.json())

/* ========= Health ========= */
app.get('/health', (_, res) => res.json({ ok: true }))

/* ========= Crear sesión de Checkout ========= */
app.post('/create-checkout-session', async (req, res) => {
  try {
    const {
      items = [],            // [{ price:'price_...', quantity: 1 }]
      mode = 'payment',      // 'payment' | 'subscription'
      success_url,
      cancel_url,
      customer_email,
      metadata = {},
    } = req.body || {}

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No line items provided' })
    }
    for (const li of items) {
      if (!li.price || typeof li.quantity !== 'number') {
        return res.status(400).json({ error: 'Invalid line item: need price + quantity' })
      }
    }

    // Allowed countries (env: "ES,PT,FR")
    const allowedCountries = (process.env.ALLOWED_COUNTRIES || 'ES')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    // Shipping rates (env: "shr_...,shr_..."), filtramos basura
    const shippingRateIds = (process.env.SHIPPING_RATES || '')
      .split(',')
      .map(s => s.trim())
      .filter(id => /^shr_/.test(id))

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: items,
      success_url: success_url || `${process.env.FRONTEND_URL}/success`,
      cancel_url: cancel_url || `${process.env.FRONTEND_URL}/cancel`,
      customer_email,
      shipping_address_collection: { allowed_countries: allowedCountries },
      shipping_options: shippingRateIds.length
        ? shippingRateIds.map(id => ({ shipping_rate: id }))
        : undefined,
      automatic_tax: { enabled: (process.env.ENABLE_AUTOMATIC_TAX || 'true') === 'true' },
      phone_number_collection: { enabled: true },
      metadata,
    })

    res.json({ url: session.url, id: session.id })
  } catch (e) {
    console.error('❌ Error creando sesión:', e)
    res.status(500).json({ error: e.message })
  }
})

/* ========= Arrancar ========= */
app.listen(PORT, () => {
  console.log(`✅ API on :${PORT}`)
})
