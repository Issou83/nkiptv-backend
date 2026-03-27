const express = require('express')
const EpgProgram = require('../models/EpgProgram')
const Channel = require('../models/Channel')
const { optionalAuth } = require('../middleware/auth')
const router = express.Router()

// ── GET /api/epg/:channelId/now ───────────────────────────────────────────────
router.get('/:channelId/now', optionalAuth, async (req, res) => {
  try {
    const now = new Date()
    const program = await EpgProgram.findOne({
      channelId: req.params.channelId,
      start: { $lte: now },
      stop: { $gte: now },
    })

    if (!program) {
      return res.json({ success: true, data: null })
    }

    const next = await EpgProgram.findOne({
      channelId: req.params.channelId,
      start: { $gt: now },
    }).sort({ start: 1 })

    // Calculer le pourcentage d'avancement
    const total = program.stop - program.start
    const elapsed = now - program.start
    const progress = Math.round((elapsed / total) * 100)

    res.json({
      success: true,
      data: {
        current: { ...program.toObject(), progress },
        next: next || null,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur EPG' })
  }
})

// ── GET /api/epg/:channelId/upcoming ─────────────────────────────────────────
router.get('/:channelId/upcoming', optionalAuth, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24
    const now = new Date()
    const end = new Date(now.getTime() + hours * 60 * 60 * 1000)

    const programs = await EpgProgram.find({
      channelId: req.params.channelId,
      start: { $gte: now, $lte: end },
    }).sort({ start: 1 }).limit(50)

    res.json({ success: true, data: programs })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur EPG' })
  }
})

// ── GET /api/epg/:channelId ───────────────────────────────────────────────────
// Guide complet sur 7 jours
router.get('/:channelId', optionalAuth, async (req, res) => {
  try {
    const now = new Date()
    const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const weekStart = new Date(now.getTime() - 24 * 60 * 60 * 1000) // 1 jour en arrière

    const programs = await EpgProgram.find({
      channelId: req.params.channelId,
      start: { $gte: weekStart, $lte: weekEnd },
    }).sort({ start: 1 })

    // Grouper par date
    const grouped = {}
    for (const prog of programs) {
      const date = prog.start.toISOString().split('T')[0]
      if (!grouped[date]) grouped[date] = []
      grouped[date].push(prog)
    }

    res.json({ success: true, data: grouped })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur EPG' })
  }
})

// ── GET /api/epg/grid ─────────────────────────────────────────────────────────
// Grille EPG multi-chaînes (type TéléStar)
router.get('/grid/now', optionalAuth, async (req, res) => {
  try {
    const { country, category } = req.query
    const now = new Date()
    const end = new Date(now.getTime() + 3 * 60 * 60 * 1000) // 3h de grille

    // Récupérer les chaînes filtrées
    const channelFilter = { isActive: true, hasStream: true }
    if (country) channelFilter.country = country.toUpperCase()
    if (category) channelFilter.categories = category

    const channels = await Channel.find(channelFilter).limit(50).lean()
    const channelIds = channels.map(c => c.id)

    const programs = await EpgProgram.find({
      channelId: { $in: channelIds },
      stop: { $gte: now },
      start: { $lte: end },
    }).sort({ start: 1 })

    const progByChannel = {}
    for (const p of programs) {
      if (!progByChannel[p.channelId]) progByChannel[p.channelId] = []
      progByChannel[p.channelId].push(p)
    }

    const grid = channels.map(ch => ({
      channel: ch,
      programs: progByChannel[ch.id] || [],
    }))

    res.json({ success: true, data: grid, timeRange: { start: now, end } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur grille EPG' })
  }
})

module.exports = router
