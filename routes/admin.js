const express = require('express')
const User = require('../models/User')
const Channel = require('../models/Channel')
const { auth, adminOnly } = require('../middleware/auth')
const router = express.Router()

router.use(auth, adminOnly)

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers, premiumUsers, proUsers, totalChannels, onlineChannels,
      newUsersToday, newUsersWeek,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ 'plan.type': 'premium' }),
      User.countDocuments({ 'plan.type': 'pro' }),
      Channel.countDocuments({ isActive: true }),
      Channel.countDocuments({ isActive: true, hasStream: true }),
      User.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      User.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
    ])

    const mrr = (premiumUsers * 4.99) + (proUsers * 9.99)

    res.json({
      success: true,
      data: {
        users: { total: totalUsers, premium: premiumUsers, pro: proUsers, free: totalUsers - premiumUsers - proUsers },
        channels: { total: totalChannels, online: onlineChannels },
        growth: { today: newUsersToday, week: newUsersWeek },
        revenue: { mrr: mrr.toFixed(2), arr: (mrr * 12).toFixed(2) },
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, plan, role, sort = 'newest' } = req.query
    const filter = {}
    if (search) filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ]
    if (plan) filter['plan.type'] = plan
    if (role) filter.role = role

    const sortMap = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { name: 1 } }

    const total = await User.countDocuments(filter)
    const users = await User.find(filter)
      .select('-password -refreshTokens -emailVerifyToken -passwordResetToken')
      .sort(sortMap[sort] || { createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))

    res.json({
      success: true,
      data: users,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── PUT /api/admin/users/:id ──────────────────────────────────────────────────
router.put('/users/:id', async (req, res) => {
  try {
    const { role, plan, isBanned, banReason, isActive } = req.body
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ success: false, message: 'Utilisateur introuvable' })
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'Impossible de modifier son propre compte' })
    }

    if (role !== undefined) user.role = role
    if (plan !== undefined) user.plan.type = plan
    if (isBanned !== undefined) {
      user.isBanned = isBanned
      if (isBanned) user.banReason = banReason || 'Violation des CGU'
    }
    if (isActive !== undefined) user.isActive = isActive

    await user.save()
    res.json({ success: true, data: user.toSafeJSON() })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/admin/channels ───────────────────────────────────────────────────
router.get('/channels', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, country, hasStream, isFeatured } = req.query
    const filter = {}
    if (search) filter.$text = { $search: search }
    if (country) filter.country = country
    if (hasStream !== undefined) filter.hasStream = hasStream === 'true'
    if (isFeatured !== undefined) filter.isFeatured = isFeatured === 'true'

    const total = await Channel.countDocuments(filter)
    const channels = await Channel.find(filter)
      .sort({ viewCount: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))

    res.json({
      success: true,
      data: channels,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / limit) },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── PUT /api/admin/channels/:id ───────────────────────────────────────────────
router.put('/channels/:id', async (req, res) => {
  try {
    const allowed = ['name', 'isActive', 'isFeatured', 'isPremium', 'categories', 'logo']
    const update = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key]
    }

    const channel = await Channel.findOneAndUpdate({ id: req.params.id }, update, { new: true })
    if (!channel) return res.status(404).json({ success: false, message: 'Chaîne introuvable' })
    res.json({ success: true, data: channel })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /api/admin/channels/sync ─────────────────────────────────────────────
// Lancer une synchronisation manuelle depuis iptv-org
router.post('/channels/sync', async (req, res) => {
  try {
    const syncService = require('../services/iptvSync')
    res.json({ success: true, message: 'Synchronisation lancée en arrière-plan' })
    syncService.sync().then(result => {
      console.log('Sync terminée:', result)
    }).catch(err => console.error('Sync error:', err))
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lancement sync' })
  }
})

// ── GET /api/admin/logs ───────────────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  // Dans une vraie appli, lire les logs depuis une DB ou un service de logging
  res.json({ success: true, data: [], message: 'Connectez un service de logging (LogDNA, Datadog...)' })
})

module.exports = router
