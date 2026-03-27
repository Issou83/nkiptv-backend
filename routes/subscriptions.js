const express = require('express')
const User = require('../models/User')
const { auth } = require('../middleware/auth')
const router = express.Router()

// Plans disponibles
const PLANS = {
  free: { name: 'Gratuit', price: 0, channels: 500, profiles: 1, quality: 'SD', features: [] },
  premium: {
    name: 'Premium', price: 4.99, channels: 10000, profiles: 3, quality: 'HD',
    features: ['EPG 7 jours', 'Favoris illimités', 'Import M3U', 'Sans pub'],
    stripePriceId: process.env.STRIPE_PRICE_PREMIUM,
  },
  pro: {
    name: 'Pro', price: 9.99, channels: 10000, profiles: 5, quality: '4K',
    features: ['Tout Premium', 'Multi-écrans', 'Support prioritaire', 'API accès', 'Catchup TV'],
    stripePriceId: process.env.STRIPE_PRICE_PRO,
  },
}

// ── GET /api/subscriptions/plans ──────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({ success: true, data: PLANS })
})

// ── GET /api/subscriptions/status ────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  const user = await User.findById(req.user._id)
  res.json({
    success: true,
    data: {
      plan: user.plan.type,
      isPremium: user.isPremium(),
      currentPeriodEnd: user.plan.currentPeriodEnd,
      cancelAtPeriodEnd: user.plan.cancelAtPeriodEnd,
      limits: PLANS[user.plan.type],
    },
  })
})

// ── POST /api/subscriptions/checkout ─────────────────────────────────────────
router.post('/checkout', auth, async (req, res) => {
  try {
    const { plan } = req.body
    if (!['premium', 'pro'].includes(plan)) {
      return res.status(400).json({ success: false, message: 'Plan invalide' })
    }

    // Si Stripe n'est pas configuré, simuler pour le dev
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.startsWith('sk_test_...')) {
      return res.json({
        success: true,
        message: 'Mode démo — Stripe non configuré',
        data: {
          checkoutUrl: null,
          sessionId: 'demo_session',
          demo: true,
        },
      })
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    const planData = PLANS[plan]
    const user = await User.findById(req.user._id)

    // Créer ou récupérer le customer Stripe
    let customerId = user.plan.stripeCustomerId
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user._id.toString() },
      })
      customerId = customer.id
      user.plan.stripeCustomerId = customerId
      await user.save()
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: planData.stripePriceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { userId: user._id.toString(), plan },
    })

    res.json({ success: true, data: { checkoutUrl: session.url, sessionId: session.id } })
  } catch (err) {
    console.error('Checkout error:', err)
    res.status(500).json({ success: false, message: 'Erreur paiement' })
  }
})

// ── DELETE /api/subscriptions ─────────────────────────────────────────────────
router.delete('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    if (user.plan.type === 'free') {
      return res.status(400).json({ success: false, message: 'Aucun abonnement actif' })
    }

    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.startsWith('sk_test_...')) {
      user.plan.type = 'free'
      user.plan.currentPeriodEnd = null
      await user.save()
      return res.json({ success: true, message: 'Abonnement annulé (mode démo)' })
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    if (user.plan.stripeSubscriptionId) {
      await stripe.subscriptions.update(user.plan.stripeSubscriptionId, {
        cancel_at_period_end: true,
      })
      user.plan.cancelAtPeriodEnd = true
      await user.save()
    }

    res.json({ success: true, message: 'Abonnement annulé à la fin de la période' })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur annulation' })
  }
})

// ── POST /api/subscriptions/webhook ──────────────────────────────────────────
// Webhook Stripe (raw body requis)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.sendStatus(200)

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
  const sig = req.headers['stripe-signature']

  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode === 'subscription') {
          const user = await User.findById(session.metadata.userId)
          if (user) {
            user.plan.type = session.metadata.plan
            user.plan.stripeSubscriptionId = session.subscription
            user.plan.cancelAtPeriodEnd = false
            await user.save()
          }
        }
        break
      }
      case 'invoice.paid': {
        const invoice = event.data.object
        if (invoice.subscription) {
          const user = await User.findOne({ 'plan.stripeSubscriptionId': invoice.subscription })
          if (user) {
            user.plan.currentPeriodEnd = new Date(invoice.lines.data[0].period.end * 1000)
            await user.save()
          }
        }
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const user = await User.findOne({ 'plan.stripeSubscriptionId': sub.id })
        if (user) {
          user.plan.type = 'free'
          user.plan.stripeSubscriptionId = null
          user.plan.currentPeriodEnd = null
          await user.save()
        }
        break
      }
    }
    res.sendStatus(200)
  } catch (err) {
    console.error('Webhook handler error:', err)
    res.sendStatus(500)
  }
})

module.exports = router
