/**
 * NKiptv Backend — Serveur principal Express
 * Port: 3001 (dev) | Variable d'env PORT (prod)
 */
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const compression = require('compression')
const morgan = require('morgan')
const rateLimit = require('express-rate-limit')
const cron = require('node-cron')
const connectDB = require('./config/database')

const app = express()
const PORT = process.env.PORT || 3001
const NODE_ENV = process.env.NODE_ENV || 'development'

// ── Connexion DB ──────────────────────────────────────────────────────────────
connectDB()

// ── Sécurité ──────────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,   // Désactivé pour le streaming HLS
}))

app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5173',
      /\.vercel\.app$/,
    ]
    if (!origin) return cb(null, true)  // Postman, curl
    const ok = allowed.some(p => (p instanceof RegExp ? p.test(origin) : p === origin))
    cb(ok ? null : new Error('CORS: origine non autorisée'), ok)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// ── Middleware généraux ────────────────────────────────────────────────────────
app.use(compression())
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'))

// Webhook Stripe doit recevoir le raw body AVANT express.json()
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: NODE_ENV === 'development' ? 1000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes, réessayez dans 15 minutes' },
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Trop de tentatives de connexion' },
})

app.use('/api', apiLimiter)
app.use('/auth/login', authLimiter)
app.use('/auth/register', authLimiter)

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',          require('./routes/auth'))
app.use('/api/channels',  require('./routes/channels'))
app.use('/api/proxy',     require('./routes/proxy'))
app.use('/api/favorites', require('./routes/favorites'))
app.use('/api/profiles',  require('./routes/profiles'))
app.use('/api/epg',       require('./routes/epg'))
app.use('/api/playlists', require('./routes/playlists'))
app.use('/api/subscriptions', require('./routes/subscriptions'))
app.use('/api/admin',     require('./routes/admin'))

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const mongoose = require('mongoose')
  res.json({
    success: true,
    status: 'ok',
    version: '2.0.0',
    env: NODE_ENV,
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  })
})

// ── 404 ────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} introuvable` })
})

// ── Gestion d'erreurs globale ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error:', err.message)
  if (err.message?.includes('CORS')) {
    return res.status(403).json({ success: false, message: 'CORS: origine non autorisée' })
  }
  res.status(err.status || 500).json({
    success: false,
    message: NODE_ENV === 'production' ? 'Erreur interne' : err.message,
  })
})

// ── Démarrage du serveur ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 NKiptv API v2.0 démarrée sur le port ${PORT} [${NODE_ENV}]`)
  console.log(`   → Health : http://localhost:${PORT}/api/health\n`)

  // Synchronisation automatique toutes les 12h
  const syncHours = parseInt(process.env.SYNC_INTERVAL_HOURS) || 12
  cron.schedule(`0 */${syncHours} * * *`, async () => {
    console.log('⏰ Lancement sync planifiée...')
    try {
      const { sync } = require('./services/iptvSync')
      await sync()
    } catch (err) {
      console.error('Sync planifiée échouée:', err.message)
    }
  })

  // Première sync au démarrage si la DB est vide
  setTimeout(async () => {
    const Channel = require('./models/Channel')
    const count = await Channel.countDocuments().catch(() => 0)
    if (count === 0) {
      console.log('📺 Base vide — première synchronisation...')
      const { sync } = require('./services/iptvSync')
      sync().catch(err => console.error('Sync initiale échouée:', err.message))
    } else {
      console.log(`📺 ${count} chaînes en base`)
    }
  }, 3000)
})

module.exports = app
