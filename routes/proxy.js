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

// ── GET /api/proxy/best/:channelId ──────────────────────────────────────────────
router.get('/best/:channelId', optionalAuth, async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.channelId, isActive: true, hasStream: true })
    if (!channel || !channel.streams?.length) {
      return res.status(404).json({ success: false, message: 'Aucun stream disponible' })
    }
    const sorted = channel.streams.sort((a, b) => {
      const order = { online: 0, unknown: 1, checking: 2, offline: 3 }
      return (order[a.status] ?? 3) - (order[b.status] ?? 3)
    })
    for (const stream of sorted) {
      if (isBlockedHost(stream.url)) continue
      try {
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
router.get('/stream', optionalAuth, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })
  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }
  if (isBlockedHost(decoded)) {
    return res.status(403).json({ success: false, message: 'Hôte non autorisé' })
  }
  try {
    const upstream = await axios.get(decoded, {
      timeout: TIMEOUT,
      responseType: 'text',
      headers: { 'User-Agent': 'VLC/3.0.0 LibVLC/3.0.0', 'Accept': '*/*', 'Referer': decoded },
      maxRedirects: 5,
    })
    const contentType = upstream.headers['content-type'] || ''
    const isM3U8 = contentType.includes('mpegurl') || contentType.includes('m3u') ||
                   decoded.includes('.m3u8') || decoded.includes('.m3u')
    if (isM3U8) {
      const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
      const baseUrl = decoded.substring(0, decoded.lastIndexOf('/') + 1)
      const rewritten = upstream.data.split('\n').map(line => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return line
        let absoluteUrl
        if (/^https?:\/\//i.test(trimmed)) {
          absoluteUrl = trimmed
        } else if (trimmed.startsWith('/')) {
          const origin = new URL(decoded).origin
          absoluteUrl = origin + trimmed
        } else {
          absoluteUrl = baseUrl + trimmed
        }
        return `${appUrl}/api/proxy/stream?url=${encodeURIComponent(absoluteUrl)}`
      }).join('\n')
      res.set({ 'Content-Type': 'application/x-mpegURL', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store' })
      return res.send(rewritten)
    }
    const binaryUpstream = await axios({
      method: 'GET', url: decoded,
      headers: { 'User-Agent': 'VLC/3.0.0 LibVLC/3.0.0', 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Referer': decoded },
      responseType: 'stream', timeout: TIMEOUT, maxRedirects: 5,
    })
    res.set({ 'Content-Type': binaryUpstream.headers['content-type'] || 'video/MP2T', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' })
    binaryUpstream.data.pipe(res)
    binaryUpstream.data.on('error', () => { if (!res.headersSent) res.status(502).end() })
    res.on('close', () => binaryUpstream.data.destroy())
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ success: false, message: 'Stream inaccessible' })
  }
})

// ── GET /api/proxy/m3u ──────────────────────────────────────────────────────────
router.get('/m3u', optionalAuth, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })
  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }
  try {
    const response = await axios.get(decoded, { timeout: TIMEOUT, responseType: 'text', headers: { 'User-Agent': 'VLC/3.0.0' } })
    const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
    let m3u = response.data
    m3u = m3u.replace(/(https?:\/\/[^\s"]+\.m3u8[^\s"]*)/g, (match) => {
      return `${baseUrl}/api/proxy/stream?url=${encodeURIComponent(match)}`
    })
    res.set('Content-Type', 'application/x-mpegURL')
    res.send(m3u)
  } catch (err) {
    res.status(502).json({ success: false, message: 'Impossible de récupérer la playlist' })
  }
})

// ── GET /api/proxy/check ──────────────────────────────────────────────────────────
router.get('/check', optionalAuth, async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ success: false, message: 'URL requise' })
  let decoded
  try { decoded = decodeURIComponent(url) } catch {
    return res.status(400).json({ success: false, message: 'URL invalide' })
  }
  try {
    const start = Date.now()
    await axios.head(decoded, { timeout: 8000, headers: { 'User-Agent': 'VLC/3.0.0', 'Accept': '*/*' } })
    res.json({ success: true, online: true, responseTime: Date.now() - start })
  } catch {
    res.json({ success: true, online: false })
  }
})

// ── GET /api/proxy/resolve/:channelId ─────────────────────────────────────────────────
router.get('/resolve/:channelId', async (req, res) => {
  try {
    const channel = await Channel.findOne({ id: req.params.channelId, hasStream: true })
    if (!channel) return res.status(404).json({ success: false, message: 'Chaîne introuvable' })
    const streams = channel.streams.filter(s => s.status !== 'offline')
    res.json({ success: true, data: { channelId: channel.id, name: channel.name, streams: streams.map(s => ({ url: s.url, quality: s.quality, status: s.status })) } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

async function pipeStream(url, streamInfo, res) {
  const headers = { 'User-Agent': streamInfo.userAgent || 'VLC/3.0.0 LibVLC/3.0.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' }
  if (streamInfo.httpReferrer) headers['Referer'] = streamInfo.httpReferrer
  const upstream = await axios({ method: 'GET', url, headers, responseType: 'stream', timeout: TIMEOUT, maxRedirects: 5 })
  const contentType = upstream.headers['content-type'] || 'application/x-mpegURL'
  res.set({ 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' })
  upstream.data.pipe(res)
  upstream.data.on('error', (err) => { console.error('Stream pipe error:', err.message); if (!res.headersSent) res.status(502).end() })
  res.on('close', () => upstream.data.destroy())
}

module.exports = router
