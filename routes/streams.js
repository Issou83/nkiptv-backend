/**
 * NKiptv â routes/streams.js
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 * API REST pour l'observatoire des flux dÃ©couverts automatiquement.
 *
 * Endpoints :
 *   GET  /api/streams               Liste paginÃ©e avec filtres + statuts
 *   GET  /api/streams/stats         Statistiques globales de l'observatoire
 *   GET  /api/streams/:id           DÃ©tail complet + historique d'un flux
 *   POST /api/streams/discover      DÃ©clenche un cycle de dÃ©couverte manuellement
 *   POST /api/streams/monitor       DÃ©clenche un cycle de monitoring manuellement
 *   POST /api/streams/heal          DÃ©clenche un cycle AutoHealer manuellement
 *   POST /api/streams/:id/recheck   Force la re-vÃ©rification d'un flux spÃ©cifique
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 */
'use strict'

const express          = require('express')
const DiscoveredStream = require('../models/DiscoveredStream')
const { auth }         = require('../middleware/auth')

// Chargement lazy des services pour Ã©viter les imports circulaires
const getDiscovery = () => require('../services/SourceDiscovery')
const getMonitor   = () => require('../services/StreamMonitor')
const getHealer    = () => require('../services/AutoHealer')

const router = express.Router()

// ââ GET /api/streams ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ParamÃ¨tres : page, limit, status, group, country, search, sort, source
router.get('/', async (req, res) => {
  try {
    const {
      page     = 1,
      limit    = 50,
      status,
      group,
      country,
      search,
      sort     = 'lastChecked',
      source,
    } = req.query

    const filter = {}
    if (status)  filter.status     = { $in: status.split(',') }
    if (group)   filter.groupTitle = group
    if (country) filter.country    = country.toUpperCase()
    if (source)  filter.source     = { $regex: source, $options: 'i' }

    let query
    if (search?.trim()) {
      query = DiscoveredStream.find(
        { ...filter, $text: { $search: search } },
        { score: { $meta: 'textScore' } }
      ).sort({ score: { $meta: 'textScore' } })
    } else {
      const sortMap = {
        lastChecked: { lastChecked: -1 },
        name:        { name: 1 },
        uptime:      { uptime: -1 },
        newest:      { createdAt: -1 },
        responseTime: { responseTime: 1 },
      }
      query = DiscoveredStream.find(filter).sort(sortMap[sort] || { lastChecked: -1 })
    }

    const pageNum  = Math.max(1, parseInt(page))
    const pageSize = Math.min(200, Math.max(1, parseInt(limit)))
    const total    = await DiscoveredStream.countDocuments(filter)

    const streams  = await query
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize)
      .select('-checkHistory -urlHistory -__v')  // Champs lourds exclus de la liste
      .lean()

    res.json({
      success: true,
      data: streams,
      pagination: {
        total,
        page:  pageNum,
        pages: Math.ceil(total / pageSize),
        limit: pageSize,
      },
    })
  } catch (err) {
    console.error('[streams] GET /:', err.message)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ââ GET /api/streams/stats ââââââââââââââââââââââââââââââââââââââââââââââââââââ
router.get('/stats', async (req, res) => {
  try {
    const [
      total,
      byStatus,
      avgUptime,
      topGroups,
      topSources,
      recentlyActive,
    ] = await Promise.all([
      DiscoveredStream.countDocuments(),

      // Distribution par statut
      DiscoveredStream.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Uptime moyen global
      DiscoveredStream.aggregate([
        { $match: { checkCount: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$uptime' } } },
      ]),

      // Top groupes (catÃ©gories)
      DiscoveredStream.aggregate([
        { $match: { groupTitle: { $ne: null }, status: 'active' } },
        { $group: { _id: '$groupTitle', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
        { $project: { name: '$_id', count: 1, _id: 0 } },
      ]),

      // Top sources
      DiscoveredStream.aggregate([
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
        { $project: { name: '$_id', count: 1, _id: 0 } },
      ]),

      // Flux devenus actifs dans les derniÃ¨res 24h
      DiscoveredStream.countDocuments({
        status:      'active',
        lastChecked: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }),
    ])

    const statusMap = {}
    byStatus.forEach(({ _id, count }) => { statusMap[_id] = count })

    res.json({
      success: true,
      data: {
        total,
        byStatus: statusMap,
        avgUptime:     avgUptime[0]?.avg ? Math.round(avgUptime[0].avg) : null,
        topGroups,
        topSources,
        recentlyActive,
        generatedAt:   new Date().toISOString(),
      },
    })
  } catch (err) {
    console.error('[streams] GET /stats:', err.message)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ââ GET /api/streams/:id ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Retourne toutes les informations d'un flux, y compris l'historique complet
router.get('/:id', async (req, res) => {
  try {
    const stream = await DiscoveredStream
      .findById(req.params.id)
      .select('-__v')
      .lean()

    if (!stream) {
      return res.status(404).json({ success: false, message: 'Flux introuvable' })
    }

    res.json({ success: true, data: stream })
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'ID invalide' })
    }
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ââ POST /api/streams/discover ââââââââââââââââââââââââââââââââââââââââââââââââ
// DÃ©clenche manuellement un cycle de dÃ©couverte GitHub (admin uniquement)
router.post('/discover', auth, async (req, res) => {
  res.json({ success: true, message: 'Cycle de dÃ©couverte lancÃ© en arriÃ¨re-plan' })

  // ExÃ©cution asynchrone non-bloquante
  setImmediate(async () => {
    try {
      const result = await getDiscovery().discover()
      console.log('[streams] Discover cycle done:', result)
    } catch (err) {
      console.error('[streams] Discover cycle error:', err.message)
    }
  })
})

// ââ POST /api/streams/monitor âââââââââââââââââââââââââââââââââââââââââââââââââ
// DÃ©clenche manuellement un cycle de monitoring (admin uniquement)
router.post('/monitor', auth, async (req, res) => {
  const { status = 'pending' } = req.body
  const validStatuses = ['pending', 'active', 'inactive']

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: `Status invalide. Valeurs: ${validStatuses.join(', ')}` })
  }

  res.json({ success: true, message: `Cycle de monitoring [${status}] lancÃ© en arriÃ¨re-plan` })

  setImmediate(async () => {
    try {
      const result = await getMonitor().runCycle(status, 0)
      console.log('[streams] Monitor cycle done:', result)
    } catch (err) {
      console.error('[streams] Monitor cycle error:', err.message)
    }
  })
})

// ââ POST /api/streams/heal ââââââââââââââââââââââââââââââââââââââââââââââââââââ
// DÃ©clenche manuellement un cycle AutoHealer (admin uniquement)
router.post('/heal', auth, async (req, res) => {
  res.json({ success: true, message: 'Cycle AutoHealer lancÃ© en arriÃ¨re-plan' })

  setImmediate(async () => {
    try {
      const result = await getHealer().runHealCycle()
      console.log('[streams] Heal cycle done:', result)
    } catch (err) {
      console.error('[streams] Heal cycle error:', err.message)
    }
  })
})

// ââ POST /api/streams/:id/recheck âââââââââââââââââââââââââââââââââââââââââââââ
// Force la re-vÃ©rification immÃ©diate d'un flux spÃ©cifique
router.post('/:id/recheck', auth, async (req, res) => {
  try {
    const stream = await DiscoveredStream.findById(req.params.id).lean()
    if (!stream) {
      return res.status(404).json({ success: false, message: 'Flux introuvable' })
    }

    // Lancer en arriÃ¨re-plan sans bloquer la rÃ©ponse
    res.json({ success: true, message: 'Re-vÃ©rification lancÃ©e', streamId: req.params.id })

    setImmediate(async () => {
      try {
        const result = await getMonitor().checkOne(stream)
        console.log('[streams] Recheck done:', result)
      } catch (err) {
        console.error('[streams] Recheck error:', err.message)
      }
    })
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'ID invalide' })
    }
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

module.exports = router
