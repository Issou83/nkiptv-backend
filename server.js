/** * NKiptv Backend — Serveur principal Express * Port: 3001 (dev) | Variable d'env PORT (prod) */
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

// ── Vérification des variables d'environnement requises ───────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET']
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`[WARN] Variable d'env manquante: ${key} — certaines features seront cassées`)
  }
})

// ── Connexion DB ──────────────────────────────────────────────────────────────
connectDB()

// ── Sécurité ──────────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Désactivé pour le streaming HLS
}))

// CORS : origin '*' requis pour que HLS.js charge les segments .ts sans blocage
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Range'],
}))

// ── Middleware généraux ───────────────────────────────────────────────────────
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/api/proxy')) return false
    return compression.filter(req, res)
  },
}))

app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'))

// Webhook Stripe doit recevoir le raw body AVANT express.json()
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// ── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === 'development' ? 5000 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes, réessayez dans 15 minutes' },
  skip: (req) => req.path.startsWith('/proxy'),
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Trop de tentatives de connexion' },
})

app.use('/api', apiLimiter)
app.use('/auth/login', authLimiter)
app.use('/auth/register', authLimiter)

// ── Health check (Render.com) ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }))

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'))
app.use('/api/channels', require('./routes/channels'))
app.use('/api/proxy', require('./routes/proxy'))
app.use('/api/favorites', require('./routes/favorites'))
app.use('/api/profiles', require('./routes/profiles'))
app.use('/api/epg', require('./routes/epg'))
app.use('/api/playlists', require('./routes/playlists'))
app.use('/api/subscriptions', require('./routes/subscriptions'))
app.use('/api/admin', require('./routes/admin'))
app.use('/api/streams', require('./routes/streams'))

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

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route ' + req.method + ' ' + req.path + ' introuvable' })
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
  console.log('NKiptv API v2.0 demarree sur le port ' + PORT + ' [' + NODE_ENV + ']')
  console.log(' -> Health : http://localhost:' + PORT + '/api/health')

  // Synchronisation automatique toutes les 12h
  const syncHours = parseInt(process.env.SYNC_INTERVAL_HOURS) || 12
  cron.schedule('0 */' + syncHours + ' * * *', async () => {
    console.log('Lancement sync planifiee...')
    try {
      const { sync } = require('./services/iptvSync')
      await sync()
    } catch (err) {
      console.error('Sync planifiee echouee:', err.message)
    }
  })

  setTimeout(async () => {
    const Channel = require('./models/Channel')
    const count = await Channel.countDocuments().catch(() => 0)
    if (count === 0) {
      console.log('Base vide - premiere synchronisation...')
      const { sync } = require('./services/iptvSync')
      sync().catch(err => console.error('Sync initiale echouee:', err.message))
    } else {
      console.log(count + ' chaines en base')
    }

    // Seed des chaînes françaises directes
    const { seedIfNeeded } = require('./services/seedFrenchChannels')
    seedIfNeeded().catch(err => console.error('Seed FR echoue:', err.message))

    // Migration one-shot : corrige les bestStreamUrl DASH → HLS
    const dashCount = await Channel.countDocuments({ bestStreamUrl: { $regex: /\.mpd$/i } }).catch(() => 0)
    if (dashCount > 0) {
      console.log('Migration DASH->HLS : ' + dashCount + ' chaine(s) a corriger...')
      const channels = await Channel.find({ bestStreamUrl: { $regex: /\.mpd$/i } }).catch(() => [])
      let fixed = 0
      for (const ch of channels) {
        const hlsStream = (ch.streams || []).find(s => s.url && s.url.includes('.m3u8'))
        if (hlsStream) {
          ch.bestStreamUrl = hlsStream.url
          ch.proxyUrl = (process.env.APP_URL || 'https://nkiptv-backend-production.up.railway.app') + '/api/proxy/stream?url=' + encodeURIComponent(hlsStream.url)
          await ch.save().catch(() => {})
          fixed++
        }
      }
      console.log('Migration terminee : ' + fixed + '/' + dashCount + ' corrigee(s)')
    }

    // ── Observatoire : StreamMonitor + AutoHealer ─────────────────────────────
    if (process.env.OBSERVATORY_ENABLED !== 'false') {
      const { startScheduler: startMonitor } = require('./services/StreamMonitor')
      const { startScheduler: startHealer } = require('./services/AutoHealer')
      startMonitor()
      startHealer()

      if (process.env.DISCOVERY_ENABLED === 'true') {
        const discoveryHours = parseInt(process.env.DISCOVERY_INTERVAL_HOURS) || 24
        cron.schedule('0 0 */' + discoveryHours + ' * *', async () => {
          console.log('Lancement decouverte planifiee...')
          const { discover } = require('./services/SourceDiscovery')
          discover().catch(err => console.error('Decouverte echouee:', err.message))
        })
        console.log('Decouverte automatique activee (toutes les ' + discoveryHours + 'h)')
      }
    }

    // ── StreamHealer : guérison automatique des chaînes status='down' ─────────
    const { startStreamHealer } = require('./services/streamHealer')
    startStreamHealer()

    // ── France TV : refresh des URLs signées toutes les 4 jours ───────────────
    const { startRefreshSchedule } = require('./services/franceTvService')
    startRefreshSchedule()

  }, 3000)
})

module.exports = app
