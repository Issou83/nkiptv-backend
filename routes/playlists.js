const express = require('express')
const axios = require('axios')
const User = require('../models/User')
const { auth } = require('../middleware/auth')
const router = express.Router()

// ── GET /api/playlists ────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const user = await User.findById(req.user._id)
  res.json({ success: true, data: user.playlists })
})

// ── POST /api/playlists ───────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { name, url, type = 'm3u' } = req.body
    if (!name || !url) {
      return res.status(400).json({ success: false, message: 'Nom et URL requis' })
    }

    const user = await User.findById(req.user._id)
    if (!user.isPremium()) {
      return res.status(403).json({
        success: false, message: 'Import M3U disponible en Premium',
      })
    }
    if (user.playlists.length >= 10) {
      return res.status(400).json({ success: false, message: 'Maximum 10 playlists atteint' })
    }

    // Tester et parser la playlist
    const parsed = await parseM3U(url)

    user.playlists.push({
      name, url, type,
      channelCount: parsed.length,
      lastSync: new Date(),
      active: true,
    })
    await user.save()

    res.status(201).json({
      success: true,
      message: `Playlist importée : ${parsed.length} chaînes`,
      data: user.playlists,
    })
  } catch (err) {
    res.status(400).json({ success: false, message: `Impossible de charger la playlist : ${err.message}` })
  }
})

// ── PUT /api/playlists/:index ──────────────────────────────────────────────────
router.put('/:index', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const playlist = user.playlists[parseInt(req.params.index)]
    if (!playlist) return res.status(404).json({ success: false, message: 'Playlist introuvable' })

    const { name, active } = req.body
    if (name) playlist.name = name
    if (active !== undefined) playlist.active = active

    await user.save()
    res.json({ success: true, data: user.playlists })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── DELETE /api/playlists/:index ───────────────────────────────────────────────
router.delete('/:index', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    user.playlists.splice(parseInt(req.params.index), 1)
    await user.save()
    res.json({ success: true, data: user.playlists })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /api/playlists/:index/channels ────────────────────────────────────────
// Récupérer les chaînes d'une playlist importée
router.get('/:index/channels', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
    const playlist = user.playlists[parseInt(req.params.index)]
    if (!playlist) return res.status(404).json({ success: false, message: 'Playlist introuvable' })

    const channels = await parseM3U(playlist.url)
    res.json({ success: true, data: channels, count: channels.length })
  } catch (err) {
    res.status(400).json({ success: false, message: `Erreur lecture playlist : ${err.message}` })
  }
})

// ── Utilitaire : parser une URL M3U ───────────────────────────────────────────
async function parseM3U(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': 'VLC/3.0.0' },
    maxContentLength: 10 * 1024 * 1024, // 10MB max
  })

  const lines = response.data.split('\n')
  const channels = []
  let current = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#EXTINF:')) {
      // Parser les attributs
      const nameMatch = trimmed.match(/,(.+)$/)
      const logoMatch = trimmed.match(/tvg-logo="([^"]*)"/)
      const idMatch = trimmed.match(/tvg-id="([^"]*)"/)
      const groupMatch = trimmed.match(/group-title="([^"]*)"/)
      const countryMatch = trimmed.match(/tvg-country="([^"]*)"/)

      current = {
        name: nameMatch?.[1]?.trim() || 'Chaîne inconnue',
        logo: logoMatch?.[1] || null,
        tvgId: idMatch?.[1] || null,
        group: groupMatch?.[1] || 'Général',
        country: countryMatch?.[1] || null,
      }
    } else if (trimmed.startsWith('http') && current.name) {
      channels.push({ ...current, url: trimmed })
      current = {}
    }
  }

  return channels
}

module.exports = router
