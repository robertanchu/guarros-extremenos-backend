# Guarros Extremeños — Backend Stripe
Node/Express para Stripe Checkout (pago único y suscripción), con dirección y tarifas de envío.

## Setup
```
cp .env.example .env
# Edita .env con tu STRIPE_SECRET_KEY y FRONTEND_URL
npm install
npm run dev
```
Endpoint: `POST /create-checkout-session` recibe `{ mode, items:[{price,quantity}], success_url, cancel_url, customer_email, metadata }` y responde `{url,id}`.

Webhook opcional en `POST /webhook` (configura `STRIPE_WEBHOOK_SECRET`).
