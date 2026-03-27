const express = require('express')
const bcrypt = require('bcryptjs')
const User = require('../models/User')
const { auth } = require('../middleware/auth')
const router = express.Router()

// ── GET /api/profiles ─────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const user = await User.findById(req.user._id)
  res.json({
    success: true,
    data: user.profiles,
    activeProfileId: user.activeProfileId,
  })
})

// ── POST /api/profiles ────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    if (user.profiles.length >= 5) {
      return res.status(400).json({ success: false, message: 'Maximum 5 profils atteint' })
    }

    const { name, avatar, isKid, language } = req.body
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Nom requis' })

    user.profiles.push({ name: name.trim(), avatar: avatar || '👤', isKid: !!isKid, language: language || 'fr' })
    await user.save()

    res.status(201).json({ success: true, data: user.profiles })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── PUT /api/profiles/:profileId ──────────────────────────────────────────────
router.put('/:profileId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const profile = user.profiles.id(req.params.profileId)
    if (!profile) return res.status(404).json({ success: false, message: 'Profil introuvable' })

    const { name, avatar, isKid, language } = req.body
    if (name) profile.name = name.trim()
    if (avatar !== undefined) profile.avatar = avatar
    if (isKid !== undefined) profile.isKid = isKid
    if (language) profile.language = language

    await user.save()
    res.json({ success: true, data: profile })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── DELETE /api/profiles/:profileId ───────────────────────────────────────────
router.delete('/:profileId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    if (user.profiles.length <= 1) {
      return res.status(400).json({ success: false, message: 'Impossible de supprimer le dernier profil' })
    }

    user.profiles = user.profiles.filter(p => p._id.toString() !== req.params.profileId)
    if (user.activeProfileId?.toString() === req.params.profileId) {
      user.activeProfileId = user.profiles[0]._id
    }
    await user.save()
    res.json({ success: true, data: user.profiles })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /api/profiles/:profileId/activate ────────────────────────────────────
router.post('/:profileId/activate', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const profile = user.profiles.id(req.params.profileId)
    if (!profile) return res.status(404).json({ success: false, message: 'Profil introuvable' })

    // Vérifier le PIN si profil protégé
    if (profile.pin) {
      const { pin } = req.body
      if (!pin) return res.status(401).json({ success: false, message: 'PIN requis' })
      const ok = await bcrypt.compare(String(pin), profile.pin)
      if (!ok) return res.status(401).json({ success: false, message: 'PIN incorrect' })
    }

    user.activeProfileId = profile._id
    await user.save()
    res.json({ success: true, data: profile })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── PUT /api/profiles/:profileId/pin ─────────────────────────────────────────
router.put('/:profileId/pin', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const profile = user.profiles.id(req.params.profileId)
    if (!profile) return res.status(404).json({ success: false, message: 'Profil introuvable' })

    const { pin } = req.body
    if (!pin || String(pin).length !== 4 || !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ success: false, message: 'PIN : 4 chiffres requis' })
    }

    const salt = await bcrypt.genSalt(10)
    profile.pin = await bcrypt.hash(String(pin), salt)
    await user.save()

    res.json({ success: true, message: 'PIN défini' })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /api/profiles/:profileId/history ────────────────────────────────────
router.post('/:profileId/history', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const profile = user.profiles.id(req.params.profileId)
    if (!profile) return res.status(404).json({ success: false, message: 'Profil introuvable' })

    const { channelId, channelName, duration } = req.body
    // Retirer l'ancienne entrée si elle existe
    profile.watchHistory = profile.watchHistory.filter(h => h.channelId !== channelId)
    // Ajouter en début
    profile.watchHistory.unshift({ channelId, channelName, duration, watchedAt: new Date() })
    // Garder les 100 dernières
    if (profile.watchHistory.length > 100) profile.watchHistory = profile.watchHistory.slice(0, 100)

    await user.save()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

module.exports = router
