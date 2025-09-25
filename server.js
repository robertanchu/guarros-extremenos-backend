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

app.use(cors({ origin: FRONTEND_URL }))
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

// Webhook skeleton
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature']
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET
  let event
  try {
    event = endpointSecret
      ? new Stripe(STRIPE_SECRET_KEY).webhooks.constructEvent(req.body, sig, endpointSecret)
      : JSON.parse(req.body)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return res.sendStatus(400)
  }
  switch (event.type) {
    case 'checkout.session.completed':
      console.log('✅ Checkout completed:', event.data.object.id)
      break
    case 'invoice.payment_succeeded':
      console.log('✅ Subscription payment succeeded:', event.data.object.id)
      break
    default:
      console.log(`ℹ️ Event: ${event.type}`)
  }
  res.json({ received: true })
})

app.listen(PORT, () => console.log(`✅ Server on http://localhost:${PORT}`))
