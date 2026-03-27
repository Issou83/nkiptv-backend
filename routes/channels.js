const express = require('express')
const Channel = require('../models/Channel')
const { auth, optionalAuth } = require('../middleware/auth')
const router = express.Router()

/**
 * Enrichit un channel lean() avec :
 *  - bestStreamUrl : fallback vers streams[0].url si null
 *  - proxyUrl      : URL proxy prête à l'emploi (évite les problèmes CORS côté frontend)
 */
function enrichChannel(channel) {
  const appUrl = process.env.APP_URL || ''

  // Fallback: si bestStreamUrl n'est pas encore défini, utiliser le premier stream
  if (!channel.bestStreamUrl && channel.streams?.length > 0) {
    // Préférer un stream online, sinon le premier disponible
    const best = channel.streams.find(s => s.status === 'online') || channel.streams[0]
    channel.bestStreamUrl = best.url
  }

  // Construire l'URL proxy avec referrer/ua si connus
  if (channel.bestStreamUrl && appUrl) {
    try {
      const best = channel.streams?.find(s => s.url === channel.bestStreamUrl)
      const proxyUrl = new URL(`${appUrl}/api/proxy/stream`)
      proxyUrl.searchParams.set('url', channel.bestStreamUrl)
      if (best?.httpReferrer) proxyUrl.searchParams.set('referrer', best.httpReferrer)
      if (best?.userAgent)    proxyUrl.searchParams.set('ua',       best.userAgent)
      channel.proxyUrl = proxyUrl.toString()
    } catch {
      channel.proxyUrl = null
    }
  }
  return channel
}

// ── GET /api/channels ─────────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      page = 1, limit = 50, country, category,
      search, hasStream, sort = 'viewCount', featured,
    } = req.query

    const filter = { isActive: true }
    if (country)             filter.country    = country.toUpperCase()
    if (category)            filter.categories = category
    if (hasStream === 'true') filter.hasStream  = true
    if (featured  === 'true') filter.isFeatured = true

    let query
    if (search && search.trim()) {
      query = Channel.find({ ...filter, $text: { $search: search } }, { score: { $meta: 'textScore' } })
      if (!sort || sort === 'relevance') query = query.sort({ score: { $meta: 'textScore' } })
    } else {
      query = Channel.find(filter)
    }

    const sortMap = {
      viewCount: { viewCount: -1 },
      name:      { name: 1 },
      newest:    { createdAt: -1 },
      rating:    { rating: -1 },
    }
    if (sort !== 'relevance') query = query.sort(sortMap[sort] || { viewCount: -1 })

    const total    = await Channel.countDocuments(filter)
    const channels = await query
      .skip((parseInt(page) - 1) * Math.min(parseInt(limit), 200))
      .limit(Math.min(parseInt(limit), 200))
      .select('-__v -lastSyncedAt')
      .lean()

    res.json({
      success: true,
      data: channels.map(enrichChannel),
      pagination: {
        total,
        page:  parseInt(page),
        pages: Math.ceil(total / Math.min(parseInt(limit), 200)),
        limit: Math.min(parseInt(limit), 200),
      },
    })
  } catch (err) {
    console.error('Channels error:', err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/channels/stats ────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [total, withStream, countries, categories] = await Promise.all([
      Channel.countDocuments({ isActive: true }),
      Channel.countDocuments({ isActive: true, hasStream: true }),
      Channel.distinct('country',    { isActive: true }),
      Channel.distinct('categories', { isActive: true }),
    ])
    res.json({
      success: true,
      data: {
        total, withStream,
        countries:  countries.filter(Boolean).length,
        categories: categories.filter(Boolean).length,
        lastSync:   new Date(),
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/channels/categories ──────────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const cats = await Channel.aggregate([
      { $match: { isActive: true, hasStream: true } },
      { $unwind: '$categories' },
      { $group: { _id: '$categories', count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
      { $project: { name: '$_id', count: 1, _id: 0 } },
    ])
    res.json({ success: true, data: cats })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/channels/countries ────────────────────────────────────────────────
router.get('/countries', async (req, res) => {
  try {
    const countries = await Channel.aggregate([
      { $match: { isActive: true, hasStream: true } },
      { $group: { _id: '$country', count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
      { $project: { code: '$_id', count: 1, _id: 0 } },
    ])
    res.json({ success: true, data: countries.filter(c => c.code) })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/channels/featured ─────────────────────────────────────────────────
router.get('/featured', async (req, res) => {
  try {
    const channels = await Channel.find({ isActive: true, isFeatured: true, hasStream: true })
      .sort({ viewCount: -1 })
      .limit(20)
      .lean()
    res.json({ success: true, data: channels.map(enrichChannel) })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/channels/:id ─────────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.id, isActive: true }).lean()
    if (!channel) return res.status(404).json({ success: false, message: 'Chaîne introuvable' })

    // Incrémenter les vues (non-bloquant)
    Channel.findOneAndUpdate({ id: req.params.id }, { $inc: { viewCount: 1 } }).exec()

    res.json({ success: true, data: enrichChannel(channel) })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /api/channels/:id/rate ───────────────────────────────────────────────
router.post('/:id/rate', auth, async (req, res) => {
  try {
    const { rating } = req.body
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Note entre 1 et 5' })
    }
    const channel = await Channel.findOne({ id: req.params.id })
    if (!channel) return res.status(404).json({ success: false, message: 'Chaîne introuvable' })

    const newCount   = channel.ratingCount + 1
    channel.rating      = ((channel.rating * channel.ratingCount) + rating) / newCount
    channel.ratingCount = newCount
    await channel.save()

    res.json({ success: true, data: { rating: channel.rating, count: channel.ratingCount } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /api/channels/admin/sync ─────────────────────────────────────────────
// Déclenche une synchronisation manuelle (admin seulement)
router.post('/admin/sync', auth, async (req, res) => {
  try {
    const { sync } = require('../services/iptvSync')
    res.json({ success: true, message: 'Sync démarrée en arrière-plan' })
    // Lancer la sync de manière non-bloquante
    sync().then(result => {
      console.log('✅ Sync admin terminée:', result)
    }).catch(err => {
      console.error('❌ Sync admin échouée:', err.message)
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur sync: ' + err.message })
  }
})

module.exports = router
