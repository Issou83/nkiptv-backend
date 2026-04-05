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
app.use(compression({
  filter: (req, res) => {
    // Ne pas compresser les routes proxy HLS : la compression bufferise les streams
    // et crée des stalls cycliques de 4-6 s sur les chaînes live
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
// API générale : 500 req / 15 min par IP
// ⚠️  NE PAS appliquer à /api/proxy : un stream HLS fait ~30 req/min
//     (refresh manifest + segments vidéo + segments audio) → dépasserait en < 2 min.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: NODE_ENV === 'development' ? 5000 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes, réessayez dans 15 minutes' },
  skip: (req) => req.path.startsWith('/proxy'),  // Exclure le streaming HLS
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
app.use('/auth',          require('./routes/auth'))
app.use('/api/channels',  require('./routes/channels'))
app.use('/api/proxy',     require('./routes/proxy'))
app.use('/api/favorites', require('./routes/favorites'))
app.use('/api/profiles',  require('./routes/profiles'))
app.use('/api/epg',       require('./routes/epg'))
app.use('/api/playlists', require('./routes/playlists'))
app.use('/api/subscriptions', require('./routes/subscriptions'))
app.use('/api/admin',     require('./routes/admin'))
app.use('/api/streams',   require('./routes/streams'))   // Observatoire des flux découverts

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

  // Première sync au démarrage si la DB est vide + seed chaînes FR
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
    // Seed des chaînes françaises directes (BFM, TV5MONDE, France24, etc.)
    const { seedIfNeeded } = require('./services/seedFrenchChannels')
    seedIfNeeded().catch(err => console.error('Seed FR échoué:', err.message))

    // Migration one-shot : corrige les bestStreamUrl DASH → HLS
    const dashCount = await Channel.countDocuments({ bestStreamUrl: { $regex: /\.mpd$/i } }).catch(() => 0)
    if (dashCount > 0) {
      console.log(`🔧 Migration DASH→HLS : ${dashCount} chaîne(s) à corriger...`)
      const channels = await Channel.find({ bestStreamUrl: { $regex: /\.mpd$/i } }).catch(() => [])
      let fixed = 0
      for (const ch of channels) {
        const hlsStream = (ch.streams || []).find(s => s.url && s.url.includes('.m3u8'))
        if (hlsStream) {
          ch.bestStreamUrl = hlsStream.url
          ch.proxyUrl = `${process.env.APP_URL || 'https://nkiptv-backend-production.up.railway.app'}/api/proxy/stream?url=${encodeURIComponent(hlsStream.url)}`
          await ch.save().catch(() => {})
          fixed++
        }
      }
      console.log(`✅ Migration terminée : ${fixed}/${dashCount} corrigée(s)`)
    }
  }, 3000)

  // ── Observatoire : StreamMonitor + AutoHealer ─────────────────────────────
  if (process.env.OBSERVATORY_ENABLED !== 'false') {
    const { startScheduler: startMonitor  } = require('./services/StreamMonitor')
    const { startScheduler: startHealer   } = require('./services/AutoHealer')
    const { startScheduler: startChannelHealer } = require('./services/streamHealerScheduler')
    startMonitor()
    startHealer()
    startChannelHealer()

    // Découverte GitHub toutes les 24h si activée
    if (process.env.DISCOVERY_ENABLED === 'true') {
      const discoveryHours = parseInt(process.env.DISCOVERY_INTERVAL_HOURS) || 24
      cron.schedule(`0 0 */${discoveryHours} * *`, async () => {
        console.log('🔭 Lancement découverte planifiée...')
        const { discover } = require('./services/SourceDiscovery')
        discover().catch(err => console.error('Découverte échouée:', err.message))
      })
      console.log(`🔭 Découverte automatique activée (toutes les ${discoveryHours}h)`)
    }
  }
})

module.exports = app
