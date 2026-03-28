/**
 * NKiptv Backend â Serveur principal Express
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

connectDB()

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}))

app.use(cors({
  origin: (origin, cb) => {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5173',
      /\.vercel\.app$/,
    ]
    if (!origin) return cb(null, true)
    const ok = allowed.some(p => (p instanceof RegExp ? p.test(origin) : p === origin))
    cb(ok ? null : new Error('CORS: origine non autorisÃ©e'), ok)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(compression())
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'))

app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === 'development' ? 1000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requÃªtes, rÃ©essayez dans 15 minutes' },
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Trop de tentatives de connexion' },
})

app.use('/api', apiLimiter)
app.use('/auth/login', authLimiter)
app.use('/auth/register', authLimiter)

app.use('/auth',          require('./routes/auth'))
app.use('/api/channels',  require('./routes/channels'))
app.use('/api/proxy',     require('./routes/proxy'))
app.use('/api/favorites', require('./routes/favorites'))
app.use('/api/profiles',  require('./routes/profiles'))
app.use('/api/epg',       require('./routes/epg'))
app.use('/api/playlists', require('./routes/playlists'))
app.use('/api/subscriptions', require('./routes/subscriptions'))
app.use('/api/admin',     require('./routes/admin'))
app.use('/api/streams',   require('./routes/streams'))

app.get('/api/health', async (req, res) => {
  const mongoose = require('mongoose')
  res.json({
    success: true, status: 'ok', version: '2.0.0', env: NODE_ENV,
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(), timestamp: new Date().toISOString(),
  })
})

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} introuvable` })
})

app.use((err, req, res, next) => {
  console.error('Error:', err.message)
  if (err.message?.includes('CORS')) {
    return res.status(403).json({ success: false, message: 'CORS: origine non autorisÃ©e' })
  }
  res.status(err.status || 500).json({
    success: false,
    message: NODE_ENV === 'production' ? 'Erreur interne' : err.message,
  })
})

app.listen(PORT, () => {
  console.log(`\nð NKiptv API v2.0 dÃ©marrÃ©e sur le port ${PORT} [${NODE_ENV}]`)
  console.log(`   â Health : http://localhost:${PORT}/api/health\n`)

  const syncHours = parseInt(process.env.SYNC_INTERVAL_HOURS) || 12
  cron.schedule(`0 */${syncHours} * * *`, async () => {
    try { const { sync } = require('./services/iptvSync'); await sync() }
    catch (err) { console.error('Sync Ã©chouÃ©e:', err.message) }
  })

  setTimeout(async () => {
    const Channel = require('./models/Channel')
    const count = await Channel.countDocuments().catch(() => 0)
    if (count === 0) {
      const { sync } = require('./services/iptvSync')
      sync().catch(err => console.error('Sync initiale:', err.message))
    }
    const { seedIfNeeded } = require('./services/seedFrenchChannels')
    seedIfNeeded().catch(err => console.error('Seed FR:', err.message))
  }, 3000)

  if (process.env.OBSERVATORY_ENABLED !== 'false') {
    const { startScheduler: startMonitor } = require('./services/StreamMonitor')
    const { startScheduler: startHealer  } = require('./services/AutoHealer')
    startMonitor()
    startHealer()
    if (process.env.DISCOVERY_ENABLED === 'true') {
      const dh = parseInt(process.env.DISCOVERY_INTERVAL_HOURS) || 24
      cron.schedule(`0 0 */${dh} * *`, () => {
        require('./services/SourceDiscovery').discover().catch(e => console.error(e))
      })
    }
  }
})

module.exports = app
