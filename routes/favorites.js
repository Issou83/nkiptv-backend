const express = require('express')
const User = require('../models/User')
const Channel = require('../models/Channel')
const { auth } = require('../middleware/auth')
const router = express.Router()

// ── GET /api/favorites ────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { profileId } = req.query
    const user = await User.findById(req.user._id)

    let favIds
    if (profileId) {
      const profile = user.profiles.id(profileId)
      favIds = profile?.favorites || []
    } else {
      const profile = user.getActiveProfile()
      favIds = profile?.favorites || []
    }

    if (!favIds.length) return res.json({ success: true, data: [] })

    const channels = await Channel.find({ id: { $in: favIds }, isActive: true }).lean()

    // Préserver l'ordre des favoris
    const channelMap = Object.fromEntries(channels.map(c => [c.id, c]))
    const ordered = favIds.map(id => channelMap[id]).filter(Boolean)

    res.json({ success: true, data: ordered })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /api/favorites/:channelId ────────────────────────────────────────────
router.post('/:channelId', auth, async (req, res) => {
  try {
    const { profileId } = req.query
    const user = await User.findById(req.user._id)

    const profile = profileId
      ? user.profiles.id(profileId)
      : user.getActiveProfile()

    if (!profile) return res.status(404).json({ success: false, message: 'Profil introuvable' })
    if (profile.favorites.includes(req.params.channelId)) {
      return res.json({ success: true, message: 'Déjà en favori' })
    }

    profile.favorites.push(req.params.channelId)
    await user.save()

    // Incrémenter le compteur favoris de la chaîne
    Channel.findOneAndUpdate({ id: req.params.channelId }, { $inc: { favoriteCount: 1 } }).exec()

    res.json({ success: true, message: 'Ajouté aux favoris', data: profile.favorites })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── DELETE /api/favorites/:channelId ──────────────────────────────────────────
router.delete('/:channelId', auth, async (req, res) => {
  try {
    const { profileId } = req.query
    const user = await User.findById(req.user._id)

    const profile = profileId
      ? user.profiles.id(profileId)
      : user.getActiveProfile()

    if (!profile) return res.status(404).json({ success: false, message: 'Profil introuvable' })

    profile.favorites = profile.favorites.filter(id => id !== req.params.channelId)
    await user.save()

    Channel.findOneAndUpdate({ id: req.params.channelId }, { $inc: { favoriteCount: -1 } }).exec()

    res.json({ success: true, message: 'Retiré des favoris', data: profile.favorites })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── PUT /api/favorites/reorder ────────────────────────────────────────────────
router.put('/reorder', auth, async (req, res) => {
  try {
    const { favorites, profileId } = req.body
    if (!Array.isArray(favorites)) {
      return res.status(400).json({ success: false, message: 'Array de favoris requis' })
    }

    const user = await User.findById(req.user._id)
    const profile = profileId
      ? user.profiles.id(profileId)
      : user.getActiveProfile()

    if (!profile) return res.status(404).json({ success: false, message: 'Profil introuvable' })

    // Garder seulement les IDs qui étaient déjà en favori
    profile.favorites = favorites.filter(id => profile.favorites.includes(id))
    await user.save()

    res.json({ success: true, data: profile.favorites })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

module.exports = router
