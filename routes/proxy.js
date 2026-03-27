const express = require('express')
const axios   = require('axios')
const Channel = require('../models/Channel')
const { optionalAuth } = require('../middleware/auth')
const router = express.Router()

const TIMEOUT       = 30000
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1']

function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname
    return BLOCKED_HOSTS.includes(host) ||
           host.startsWith('192.168.') ||
           host.startsWith('10.') ||
           host.startsWith('172.16.')
  } catch { return true }
}

/**
 * Construit les headers HTTP pour une requête upstream
 * Utilise referrer et userAgent stockés si disponibles
 */
function buildHeaders(referrer, userAgent) {
  const headers = {
    'User-Agent':      userAgent || 'VLC/3.0.0 LibVLC/3.0.0 (compatible)',
    'Accept':          '*/*',
    'Accept-Encoding': 'identity',
    'Connection':      'keep-alive',
  }
  if (referrer) headers['Referer'] = referrer
  return headers
}

/**
 * Réécrit un contenu M3U8 en proxifiant toutes les URLs de segments
 * Préserve referrer et user-agent dans les URLs réécrites
 */
function rewriteM3U8(m3uContent, sourceUrl, appUrl, referrer, ua) {
  const baseUrl = sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1)
  const origin  = (() => { try { return new URL(sourceUrl).origin } catch { return '' } })()

  function toProxy(url) {
    let absoluteUrl
    if (/^https?:\/\//i.test(url)) {
      absoluteUrl = url
    } else if (url.startsWith('/')) {
      absoluteUrl = origin + url
    } else {
      absoluteUrl = baseUrl + url
    }
    const p = new URL(`${appUrl}/api/proxy/stream`)
    p.searchParams.set('url', absoluteUrl)
    if (referrer) p.searchParams.set('referrer', referrer)
    if (ua)       p.searchParams.set('ua', ua)
    return p.toString()
  }

  return m3uContent.split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed) return line

    // Réécrire URI= dans les tags HLS (#EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF…)
    if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => 'URI="' + toProxy(uri) + '"')
    }

    // Ignorer les autres commentaires
    if (trimmed.startsWith('#')) return line

    // Réécrire les segments/sous-playlists
    return toProxy(trimmed)
  }).join('\n')
}

// ── GET /api/proxy/best/:channelId ────────────────────────────────────────────
// Redirige vers le meilleur stream disponible en passant referrer + ua
router.get('/best/:channelId', optionalAuth, async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.channelId, isActive: true, hasStream: true })
    if (!channel || !channel.streams?.length) {
      return res.status(404).json({ success: false, message: 'Aucun stream disponible' })
    }

    // Trier par statut : online > unknown > checking > offline
    const sorted = [...channel.streams].sort((a, b) => {
      const order = { online: 0, unknown: 1, checking: 2, offline: 3 }
      return (order[a.status] ?? 3) - (order[b.status] ?? 3)
    })

    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`

    for (const stream of sorted) {
      if (isBlockedHost(stream.url)) continue
      const proxyUrl = new URL(`${appUrl}/api/proxy/stream`)
      proxyUrl.searchParams.set('url', stream.url)
      if (stream.httpReferrer) proxyUrl.searchParams.set('referrer', stream.httpReferrer)
      if (stream.userAgent)    proxyUrl.searchParams.set('ua',       stream.userAgent)
      return res.redirect(302, proxyUrl.toString())
    }

    res.status(503).json({ success: false, message: 'Tous les streams sont hors ligne' })
  } catch (err) {
    console.error('Proxy best error:', err.message)
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Erreur proxy' })
  }
})

// ── GET /api/proxy/stream ─────────────────────────────────────────────────────
// Proxy principal : détecte M3U8 par URL puis par Content-Type, sinon pipe binaire
// Paramètres query : url (requis), referrer (optionnel), ua (optionnel)
router.get('/stream', optionalAuth, async (req, res) => {
  const { url, referrer, ua } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })

  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }
  if (isBlockedHost(decoded)) {
    return res.status(403).json({ success: false, message: 'Hôte non autorisé' })
  }

  const decodedReferrer = referrer ? decodeURIComponent(referrer) : null
  const decodedUa       = ua       ? decodeURIComponent(ua)       : null
  const headers         = buildHeaders(decodedReferrer, decodedUa)
  const appUrl          = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`

  // Détection M3U8 : d'abord par URL (rapide), sinon par Content-Type
  const isM3UByUrl = /\.m3u8?(\?.*)?$/i.test(decoded) ||
                     decoded.includes('.m3u') ||
                     decoded.includes('playlist') && !decoded.includes('.ts')

  try {
    if (isM3UByUrl) {
      // ── Cas M3U8 : récupérer en texte et réécrire les URLs ──────────────
      const upstream = await axios.get(decoded, {
        timeout:      TIMEOUT,
        responseType: 'text',
        headers,
        maxRedirects: 5,
      })
      const rewritten = rewriteM3U8(upstream.data, decoded, appUrl, decodedReferrer, decodedUa)
      res.set({
        'Content-Type':                'application/x-mpegURL',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-cache, no-store',
      })
      return res.send(rewritten)
    }

    // ── Cas binaire/inconnu : stream en pipe ────────────────────────────
    const upstream = await axios({
      method:       'GET',
      url:          decoded,
      headers,
      responseType: 'stream',
      timeout:      TIMEOUT,
      maxRedirects: 5,
    })

    const contentType = upstream.headers['content-type'] || ''

    // Si le serveur retourne finalement un M3U8 (URL trompeuse)
    if (contentType.includes('mpegurl') || contentType.includes('m3u')) {
      let data = ''
      upstream.data.on('data', chunk => { data += chunk })
      upstream.data.on('end',  () => {
        const rewritten = rewriteM3U8(data, decoded, appUrl, decodedReferrer, decodedUa)
        res.set({
          'Content-Type':                'application/x-mpegURL',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'no-cache, no-store',
        })
        res.send(rewritten)
      })
      upstream.data.on('error', () => { if (!res.headersSent) res.status(502).end() })
      return
    }

    // Pipe binaire normal (segments .ts, etc.)
    res.set({
      'Content-Type':                upstream.headers['content-type'] || 'video/MP2T',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache, no-store',
      'X-Accel-Buffering':           'no',
    })
    upstream.data.pipe(res)
    upstream.data.on('error', () => { if (!res.headersSent) res.status(502).end() })
    res.on('close', () => upstream.data.destroy())
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ success: false, message: 'Stream inaccessible' })
  }
})

// ── GET /api/proxy/m3u ────────────────────────────────────────────────────────
router.get('/m3u', optionalAuth, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })
  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }
  try {
    const response = await axios.get(decoded, {
      timeout:      TIMEOUT,
      responseType: 'text',
      headers:      { 'User-Agent': 'VLC/3.0.0' },
    })
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
    const rewritten = rewriteM3U8(response.data, decoded, appUrl, null, null)
    res.set('Content-Type', 'application/x-mpegURL')
    res.send(rewritten)
  } catch (err) {
    res.status(502).json({ success: false, message: 'Impossible de récupérer la playlist' })
  }
})

// ── GET /api/proxy/check ──────────────────────────────────────────────────────
router.get('/check', optionalAuth, async (req, res) => {
  const { url, referrer, ua } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })
  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }
  const headers = buildHeaders(
    referrer ? decodeURIComponent(referrer) : null,
    ua       ? decodeURIComponent(ua)       : null
  )
  try {
    const start = Date.now()
    await axios.head(decoded, { timeout: 8000, headers })
    res.json({ success: true, online: true,  responseTime: Date.now() - start })
  } catch {
    res.json({ success: true, online: false, responseTime: null })
  }
})

// ── GET /api/proxy/resolve/:channelId ─────────────────────────────────────────
// Retourne les streams disponibles avec leurs URLs proxy
router.get('/resolve/:channelId', async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.channelId, hasStream: true })
    if (!channel) return res.status(404).json({ success: false, message: 'Chaîne introuvable' })

    const appUrl  = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
    const streams = channel.streams
      .filter(s => s.status !== 'offline')
      .map(s => {
        const proxyUrl = new URL(`${appUrl}/api/proxy/stream`)
        proxyUrl.searchParams.set('url', s.url)
        if (s.httpReferrer) proxyUrl.searchParams.set('referrer', s.httpReferrer)
        if (s.userAgent)    proxyUrl.searchParams.set('ua',       s.userAgent)
        return {
          url:      s.url,
          proxyUrl: proxyUrl.toString(),
          quality:  s.quality,
          status:   s.status,
        }
      })

    res.json({ success: true, data: { channelId: channel.id, name: channel.name, streams } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

module.exports = router
