const express = require('express')
const axios = require('axios')
const https = require('https')
const http = require('http')
const Channel = require('../models/Channel')
const { optionalAuth } = require('../middleware/auth')
const router = express.Router()

const TIMEOUT = 30000
const CDN_TIMEOUT_MS = 12000   // AbortController : abandon CDN après 12 s
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1']

// ── Agents HTTP avec keep-alive pour réutiliser les connexions TCP/TLS ─────────
// Sans ça, chaque segment crée une nouvelle connexion → +100-200ms de latence/segment
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 20 })
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 50, maxFreeSockets: 20 })

// ── Live playlist trimmer ──────────────────────────────────────────────────────
// CDN comme viamotionhsi servent 970+ segments (170 KB). On garde les 10 derniers.
const MAX_LIVE_SEGMENTS = 10

function trimLivePlaylist(body) {
  const lines = body.split("\n")
  const header = []
  const segBlocks = []
  let cur = []
  let inHeader = true
  let origSeq = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith("#EXT-X-MEDIA-SEQUENCE:")) { origSeq = parseInt(t.split(":")[1]); continue }
    if (inHeader) {
      if (t.startsWith("#EXTINF")) { inHeader = false; cur.push(line) }
      else { header.push(line) }
    } else {
      cur.push(line)
      if (!t.startsWith("#")) { segBlocks.push(cur); cur = [] }
    }
  }
  if (segBlocks.length <= MAX_LIVE_SEGMENTS) return body
  const dropped = segBlocks.length - MAX_LIVE_SEGMENTS
  const kept = segBlocks.slice(dropped)
  const newSeq = origSeq + dropped
  return [...header, "#EXT-X-MEDIA-SEQUENCE:" + newSeq, ...kept.flat()].join("\n")
}

const isBlockedHost = (url) => {
  try {
    const host = new URL(url).hostname
    return BLOCKED_HOSTS.includes(host) || host.startsWith('192.168.') || host.startsWith('10.')
  } catch { return true }
}

// ── Détection M3U8 fiable ─────────────────────────────────────────────────────
// BUG CORRIGÉ : decoded.includes('.m3u8') capturait les segments dont l'URL
// contient .m3u8 dans le chemin (ex: cdn.com/stream.m3u8/seg001.ts → faux positif).
// On vérifie maintenant l'extension de pathname uniquement.
const detectM3U8 = (decoded, contentType) => {
  // Content-Type est la source la plus fiable
  if (contentType && (contentType.includes('mpegurl') || contentType.includes('m3u'))) return true
  // Vérifier uniquement l'extension finale du chemin URL
  try {
    const pathname = new URL(decoded).pathname.toLowerCase()
    return pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')
  } catch {
    return false
  }
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
// Pour les segments binaires (.ts) : bufférise et envoie avec Content-Length (fiable avec CDN)
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

  let fetchUrl = decoded
  try {
    const u = new URL(decoded)
    if (u.searchParams.has('_HLS_msn') || u.searchParams.has('_HLS_part') || u.searchParams.has('_HLS_skip')) {
      u.searchParams.delete('_HLS_msn')
      u.searchParams.delete('_HLS_part')
      u.searchParams.delete('_HLS_skip')
      fetchUrl = u.toString()
      console.log(`[proxy] stripped HLS blocking params → ${fetchUrl.slice(0, 80)}`)
    }
  } catch (_) { }

  try {
    const controller = new AbortController()
    const cdnTimer = setTimeout(() => controller.abort(), CDN_TIMEOUT_MS)
    const t0 = Date.now()

    let upstream
    try {
      upstream = await axios.get(fetchUrl, {
        timeout: TIMEOUT,
        responseType: 'stream',
        signal: controller.signal,
        httpAgent,
        httpsAgent,
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
        console.warn(`[proxy] CDN timeout (>${CDN_TIMEOUT_MS}ms) for ${fetchUrl.slice(0, 80)}`)
        return res.status(504).json({ success: false, message: `CDN timeout après ${CDN_TIMEOUT_MS / 1000}s` })
      }
      throw fetchErr
    }
    clearTimeout(cdnTimer)
    console.log(`[proxy] CDN responded in ${Date.now() - t0}ms — ${fetchUrl.slice(0, 80)}`)

    const contentType = upstream.headers['content-type'] || ''

    // ── CORRECTION : détection M3U8 basée sur pathname uniquement ─────────────
    // L'ancien code utilisait decoded.includes('.m3u8') qui capturait à tort les
    // segments dont l'URL contient .m3u8 dans le chemin (pattern fréquent en IPTV :
    // https://cdn.server.com/live/channel.m3u8/seg-000001.ts)
    const isM3U8 = detectM3U8(decoded, contentType)

    if (isM3U8) {
      const chunks = []
      upstream.data.on('data', chunk => chunks.push(chunk))
      await new Promise((resolve, reject) => {
        upstream.data.on('end', resolve)
        upstream.data.on('error', reject)
      })
      const body = Buffer.concat(chunks).toString('utf-8')

      const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`
      const baseUrl = decoded.substring(0, decoded.lastIndexOf('/') + 1)

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

      const isM3U8live = !body.includes('#EXT-X-ENDLIST')
      const bodyToRewrite = isM3U8live ? trimLivePlaylist(body) : body
      const rewritten = bodyToRewrite.split('\n').map(line => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => `UPB="${proxify(uri)}"`)
        }
        return proxify(trimmed)
      }).join('\n')

      res.set({
        'Content-Type': 'application/x-mpegURL',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store',
      })
      return res.send(rewritten)
    }

    // ── CORRECTION : segments binaires — buffering au lieu de pipe ─────────────
    // Le pipe() vers Railway/Fastly CDN peut rompre silencieusement (0 bytes reçus
    // côté client) à cause du chunked transfer encoding sans Content-Length.
    // On bufférise le segment entier, puis on envoie avec Content-Length explicite.
    // Les segments HLS sont typiquement 200 KB–3 MB : acceptable en mémoire.
    const segChunks = []
    upstream.data.on('data', chunk => segChunks.push(chunk))
    upstream.data.on('error', (err) => {
      console.error(`[proxy] segment upstream error: ${err.message} — ${fetchUrl.slice(0, 80)}`)
      if (!res.headersSent) {
        res.status(502).json({ success: false, message: 'Erreur CDN segment' })
      } else {
        res.destroy()
      }
    })
    upstream.data.on('end', () => {
      const buf = Buffer.concat(segChunks)
      console.log(`[proxy] segment OK ${buf.length} bytes — ${fetchUrl.slice(0, 60)}`)
      if (res.headersSent) return
      res.set({
        'Content-Type': contentType || 'video/MP2T',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store',
        'Content-Length': buf.length,
      })
      res.end(buf)
    })

  } catch (err) {
    console.error(`[proxy] stream error: ${err.message}`)
    if (!res.headersSent) res.status(502).json({ success: false, message: 'Stream inaccessible' })
  }
})

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
    m3u = m3u.replace(/(https?:\/\/[^\s"]+\.m3u8[^\s"]*)/g, (match) => `${baseUrl}/api/proxy/stream?url=${encodeURIComponent(match)}`)
    res.set('Content-Type', 'application/x-mpegURL')
    res.send(m3u)
  } catch (err) {
    res.status(502).json({ success: false, message: 'Impossible de récupérer la playlist' })
  }
})

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
  const upstream = await axios({ method: 'GET', url, headers, responseType: 'stream', httpAgent, httpsAgent, timeout: TIMEOUT, maxRedirects: 5 })
  const contentType = upstream.headers['content-type'] || 'application/x-mpegURL'
  res.set({ 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no', 'Content-Encoding': 'identity' })
  if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length'])
  if (res.socket) res.socket.setNoDelay(true)
  res.flushHeaders()
  upstream.data.pipe(res)
  upstream.data.on('error', (err) => { console.error('Stream pipe error:', err.message); if (!res.headersSent) res.status(502).end() })
  res.on('close', () => upstream.data.destroy())
}

module.exports = router
