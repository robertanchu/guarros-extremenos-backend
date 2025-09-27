import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const allowList = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowList.length === 0 || allowList.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  maxAge: 600
};

app.use(morgan('tiny'));

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case 'checkout.session.completed':
      console.log('✅ checkout.session.completed', event.data.object.id);
      break;
    case 'invoice.payment_succeeded':
      console.log('✅ invoice.payment_succeeded', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      console.warn('⚠️ invoice.payment_failed', event.data.object.id);
      break;
    default: break;
  }
  res.json({ received: true });
});

app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items = [], mode = 'payment', success_url, cancel_url } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Missing items' });
    if (!success_url || !cancel_url) return res.status(400).json({ error: 'Missing success_url/cancel_url' });

    const shippingRate = process.env.STRIPE_SHIPPING_RATE_ID;
    const isSubscription = mode === 'subscription';

    const sessionParams = {
      mode,
      line_items: items,
      success_url,
      cancel_url,
      allow_promotion_codes: true
    };

    if (!isSubscription && shippingRate) {
      sessionParams.shipping_address_collection = { allowed_countries: ['ES','PT'] };
      sessionParams.shipping_options = [{ shipping_rate: shippingRate }];
      sessionParams.invoice_creation = { enabled: true };
      sessionParams.billing_address_collection = 'auto';
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
