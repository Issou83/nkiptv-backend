const express = require('express')
const Channel = require('../models/Channel')
const { auth, optionalAuth } = require('../middleware/auth')
const router = express.Router()

// ── GET /api/channels ─────────────────────────────────────────────────────────
// Paramètres : page, limit, country, category, search, hasStream, sort
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      page = 1, limit = 50, country, category,
      search, hasStream, sort = 'viewCount', featured,
    } = req.query

    const filter = { isActive: true }
    if (country) filter.country = country.toUpperCase()
    if (category) filter.categories = category
    if (hasStream === 'true') filter.hasStream = true
    if (featured === 'true') filter.isFeatured = true

    // Texte de recherche avec MongoDB full-text search
    let query
    if (search && search.trim()) {
      query = Channel.find({ ...filter, $text: { $search: search } }, { score: { $meta: 'textScore' } })
      if (!sort || sort === 'relevance') query = query.sort({ score: { $meta: 'textScore' } })
    } else {
      query = Channel.find(filter)
    }

    const sortMap = {
      viewCount: { viewCount: -1 },
      name: { name: 1 },
      newest: { createdAt: -1 },
      rating: { rating: -1 },
    }
    if (sort !== 'relevance') query = query.sort(sortMap[sort] || { viewCount: -1 })

    const total = await Channel.countDocuments(filter)
    const channels = await query
      .skip((page - 1) * Math.min(limit, 200))
      .limit(Math.min(parseInt(limit), 200))
      .select('-__v -lastSyncedAt')
      .lean()

    res.json({
      success: true,
      data: channels,
      pagination: {
        total, page: parseInt(page),
        pages: Math.ceil(total / limit),
        limit: parseInt(limit),
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
      Channel.distinct('country', { isActive: true }),
      Channel.distinct('categories', { isActive: true }),
    ])
    res.json({
      success: true,
      data: {
        total, withStream,
        countries: countries.filter(Boolean).length,
        categories: categories.filter(Boolean).length,
        lastSync: new Date(),
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
      { $sort: { count: -1 } },
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
      { $sort: { count: -1 } },
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
    res.json({ success: true, data: channels })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/channels/:id ─────────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.id, isActive: true })
    if (!channel) return res.status(404).json({ success: false, message: 'Chaîne introuvable' })

    // Incrémenter le compteur de vues (non-bloquant)
    Channel.findByIdAndUpdate(channel._id, { $inc: { viewCount: 1 } }).exec()

    res.json({ success: true, data: channel })
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

    // Moyenne mobile simple
    const newCount = channel.ratingCount + 1
    channel.rating = ((channel.rating * channel.ratingCount) + rating) / newCount
    channel.ratingCount = newCount
    await channel.save()

    res.json({ success: true, data: { rating: channel.rating, count: channel.ratingCount } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

module.exports = router
