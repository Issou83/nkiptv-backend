const express = require('express')
const axios = require('axios')
const Channel = require('../models/Channel')
const { optionalAuth } = require('../middleware/auth')
const router = express.Router()

const TIMEOUT = 30000
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1']

const isBlockedHost = (url) => {
  try {
    const host = new URL(url).hostname
    return BLOCKED_HOSTS.includes(host) || host.startsWith('192.168.') || host.startsWith('10.')
  } catch { return true }
}

// ── GET /api/proxy/best/:channelId ────────────────────────────────────────────
// Backend choisit & pipe le meilleur stream
router.get('/best/:channelId', optionalAuth, async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.channelId, isActive: true, hasStream: true })
    if (!channel || !channel.streams?.length) {
      return res.status(404).json({ success: false, message: 'Aucun stream disponible' })
    }

    // Essayer les streams dans l'ordre (d'abord online, puis unknown)
    const sorted = channel.streams.sort((a, b) => {
      const order = { online: 0, unknown: 1, checking: 2, offline: 3 }
      return (order[a.status] ?? 3) - (order[b.status] ?? 3)
    })

    for (const stream of sorted) {
      if (isBlockedHost(stream.url)) continue
      try {
        await pipeStream(stream.url, stream, res)
        return
      } catch { continue }
    }

    res.status(503).json({ success: false, message: 'Tous les streams sont hors ligne' })
  } catch (err) {
    console.error('Proxy best error:', err.message)
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erreur proxy' })
  }
})

// ── GET /api/proxy/stream ─────────────────────────────────────────────────────
// Proxy d'une URL directe (passée en paramètre)
router.get('/stream', optionalAuth, async (req, res) => {
  const { url, country } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })

  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }

  if (isBlockedHost(decoded)) {
    return res.status(403).json({ success: false, message: 'Hôte non autorisé' })
  }

  try {
    await pipeStream(decoded, { httpReferrer: decoded }, res)
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ success: false, message: 'Stream inaccessible' })
  }
})

// ── GET /api/proxy/m3u ────────────────────────────────────────────────────────
// Télécharge & réécrit une playlist M3U (URLs internes → proxifiées)
router.get('/m3u', optionalAuth, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })

  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }

  try {
    const response = await axios.get(decoded, {
      timeout: TIMEOUT,
      responseType: 'text',
      headers: { 'User-Agent': 'VLC/3.0.0' },
    })

    const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
    let m3u = response.data

    // Réécrire les URLs http:// et https:// vers le proxy
    m3u = m3u.replace(/(https?:\/\/[^\s"]+\.m3u8[^\s"]*)/g, (match) => {
      return `${baseUrl}/api/proxy/stream?url=${encodeURIComponent(match)}`
    })

    res.set('Content-Type', 'application/x-mpegURL')
    res.send(m3u)
  } catch (err) {
    res.status(502).json({ success: false, message: 'Impossible de récupérer la playlist' })
  }
})

// ── GET /api/proxy/check ──────────────────────────────────────────────────────
// Vérifier si un stream est accessible (HEAD request)
router.get('/check', optionalAuth, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })

  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }

  try {
    const start = Date.now()
    await axios.head(decoded, {
      timeout: 8000,
      headers: {
        'User-Agent': 'VLC/3.0.0',
        'Accept': '*/*',
      },
    })
    res.json({ success: true, online: true, responseTime: Date.now() - start })
  } catch {
    res.json({ success: true, online: false })
  }
})

// ── GET /api/proxy/resolve/:channelId ─────────────────────────────────────────
// Résoudre l'URL sans streamer (pour players externes)
router.get('/resolve/:channelId', async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.channelId, hasStream: true })
    if (!channel) return res.status(404).json({ success: false, message: 'Chaîne introuvable' })

    const streams = channel.streams.filter(s => s.status !== 'offline')
    res.json({
      success: true,
      data: {
        channelId: channel.id,
        name: channel.name,
        streams: streams.map(s => ({
          url: s.url,
          quality: s.quality,
          status: s.status,
        })),
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── Utilitaire : pipe un stream HLS vers le client ────────────────────────────
async function pipeStream(url, streamInfo, res) {
  const headers = {
    'User-Agent': streamInfo.userAgent || 'VLC/3.0.0 LibVLC/3.0.0',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
  }
  if (streamInfo.httpReferrer) headers['Referer'] = streamInfo.httpReferrer

  const upstream = await axios({
    method: 'GET',
    url,
    headers,
    responseType: 'stream',
    timeout: TIMEOUT,
    maxRedirects: 5,
  })

  const contentType = upstream.headers['content-type'] || 'application/x-mpegURL'
  res.set({
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache, no-store',
    'X-Accel-Buffering': 'no',
  })

  upstream.data.pipe(res)

  upstream.data.on('error', (err) => {
    console.error('Stream pipe error:', err.message)
    if (!res.headersSent) res.status(502).end()
  })

  res.on('close', () => upstream.data.destroy())
}

module.exports = router
