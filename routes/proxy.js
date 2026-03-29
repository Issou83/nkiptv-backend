const express = require('express')
const axios = require('axios')
const Channel = require('../models/Channel')
const { optionalAuth } = require('../middleware/auth')
const router = express.Router()

const TIMEOUT = 30000
const CDN_TIMEOUT_MS = 12000   // AbortController : abandon CDN après 12 s
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
        // Rediriger vers /stream?url=... pour bénéficier de la réécriture M3U8
        const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
        return res.redirect(302, `${appUrl}/api/proxy/stream?url=${encodeURIComponent(stream.url)}`)
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
// Pour les playlists M3U8 : réécrit les URLs relatives ET absolues vers le proxy
// Pour les segments binaires (.ts) : pipe en une seule requête (évite le double-fetch)
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
    // AbortController : coupe la connexion CDN si elle tarde trop (évite que Railway
    // attende 30 s et que HLS.js déclenche audioTrackLoadTimeOut côté client)
    const controller = new AbortController()
    const cdnTimer = setTimeout(() => controller.abort(), CDN_TIMEOUT_MS)
    const t0 = Date.now()

    let upstream
    try {
      upstream = await axios.get(decoded, {
        timeout: TIMEOUT,
        responseType: 'stream',
        signal: controller.signal,
        headers: {
          'User-Agent': 'VLC/3.0.0 LibVLC/3.0.0',
          'Accept': '*/*',
          'Accept-Encoding': 'identity',
          'Referer': decoded,
        },
        maxRedirects: 5,
      })
    } catch (fetchErr) {
      clearTimeout(cdnTimer)
      if (fetchErr.code === 'ERR_CANCELED' || fetchErr.name === 'AbortError') {
        console.warn(`[proxy] CDN timeout (>${CDN_TIMEOUT_MS}ms) for ${decoded.slice(0, 80)}`)
        return res.status(504).json({ success: false, message: `CDN timeout après ${CDN_TIMEOUT_MS / 1000}s` })
      }
      throw fetchErr
    }
    clearTimeout(cdnTimer)
    console.log(`[proxy] CDN responded in ${Date.now() - t0}ms — ${decoded.slice(0, 80)}`)

    const contentType = upstream.headers['content-type'] || ''
    const isM3U8 = contentType.includes('mpegurl') || contentType.includes('m3u') ||
                   decoded.includes('.m3u8') || decoded.includes('.m3u')

    if (isM3U8) {
      // Collecter le body (playlist = petit fichier texte) puis réécrire les URLs
      const chunks = []
      upstream.data.on('data', chunk => chunks.push(chunk))
      await new Promise((resolve, reject) => {
        upstream.data.on('end', resolve)
        upstream.data.on('error', reject)
      })
      const body = Buffer.concat(chunks).toString('utf-8')

      const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
      const baseUrl = decoded.substring(0, decoded.lastIndexOf('/') + 1)

      // Helper: make any URL absolute then proxify it
      const proxify = (rawUrl) => {
        let abs
        if (/^https?:\/\//i.test(rawUrl)) {
          abs = rawUrl
        } else if (rawUrl.startsWith('/')) {
          abs = new URL(decoded).origin + rawUrl
        } else {
          abs = baseUrl + rawUrl
        }
        return `${appUrl}/api/proxy/stream?url=${encodeURIComponent(abs)}`
      }

      const rewritten = body.split('\n').map(line => {
        const trimmed = line.trim()
        if (!trimmed) return line

        // ── HLS tag lines (start with #) ────────────────────────────────────
        // Rewrite URI="..." attributes inside tags such as:
        //   #EXT-X-MEDIA:TYPE=AUDIO,...,URI="audio.m3u8"
        //   #EXT-X-KEY:METHOD=AES-128,URI="key.bin"
        //   #EXT-X-MAP:URI="init.mp4"
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxify(uri)}"`)
        }

        // ── Segment / sub-manifest URL lines ────────────────────────────────
        return proxify(trimmed)
      }).join('\n')

      res.set({
        'Content-Type': 'application/x-mpegURL',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store',
      })
      return res.send(rewritten)
    }

    // Segment binaire (.ts, .aac, etc.) — pipe directement sans re-télécharger
    res.set({
      'Content-Type': contentType || 'video/MP2T',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    })
    upstream.data.pipe(res)
    upstream.data.on('error', () => { if (!res.headersSent) res.status(502).end() })
    res.on('close', () => upstream.data.destroy())

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
