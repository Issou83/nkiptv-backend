/**
 * NKiptv — StreamHealer
 * ────────────────────────────────────────────────────────────────────────────
 * Stratégies de guérison des flux selon leur source_origin.
 *
 * Basé sur le guide d'architecture :
 *  - "cdn-public"       : tester les fallbackUrls dans l'ordre
 *  - "custom-web-player": tenter un refresh du token via GitHub API search
 *  - "github-community" : chercher un remplaçant dans les listes iptv-org
 *  - "direct-ip"        : marquer inactive (IP trop dynamique à re-scanner)
 *  - "xtream-codes"     : chercher des serveurs alternatifs via SourceDiscovery
 *
 * Usage :
 *  const { healInactiveStreams } = require('./StreamHealer')
 *  await healInactiveStreams()   // à appeler depuis StreamMonitor après un cycle
 * ────────────────────────────────────────────────────────────────────────────
 */
'use strict'

const http  = require('http')
const https = require('https')
const { URL } = require('url')
const Channel = require('../models/Channel')

const HEAL_TIMEOUT_MS  = 8000   // 8s max pour tester un fallback
const USER_AGENT       = 'Mozilla/5.0 (compatible; NKiptv-Healer/1.0; +https://passiloc.fr)'
const MAX_HEAL_PER_RUN = 30     // limite de chaînes traitées par cycle

// ── Utilitaire : probe HTTP rapide ────────────────────────────────────────────
function probeUrl (rawUrl) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => { if (!settled) { settled = true; resolve(ok) } }

    try {
      const parsed = new URL(rawUrl)
      const lib = parsed.protocol === 'https:' ? https : http
      const req = lib.request(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
          method: 'HEAD', timeout: HEAL_TIMEOUT_MS,
          headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' } },
        (res) => done(res.statusCode >= 200 && res.statusCode < 400)
      )
      req.on('error', () => done(false))
      req.on('timeout', () => { req.destroy(); done(false) })
      req.end()
    } catch {
      done(false)
    }
  })
}

// ── Stratégie A : cdn-public — tester les fallbackUrls ───────────────────────
async function healCdnPublic (channel, stream) {
  const fallbacks = stream.fallbackUrls || []
  for (const url of fallbacks) {
    if (!url || url === stream.url) continue
    const ok = await probeUrl(url)
    if (ok) {
      return { healed: true, newUrl: url, strategy: 'cdn-fallback' }
    }
  }
  return { healed: false }
}

// ── Stratégie B : github-community — chercher dans iptv-org FR ───────────────
async function healGithubCommunity (channel, stream) {
  const fallbackResult = await healCdnPublic(channel, stream)
  if (fallbackResult.healed) return { ...fallbackResult, strategy: 'github-community-fallback' }

  const knownPatterns = [
    `https://edge98.vedge.infomaniak.com/lancer/ck/${channel.name.toLowerCase().replace(/\s+/g, '')}/manifest/playlist.m3u8`,
    `https://edge98.vedge.infomaniak.com/lancer/ck/${channel.id.toLowerCase().replace('.fr','').replace(/\./g,'')}/manifest/playlist.m3u8`,
  ]
  for (const url of knownPatterns) {
    const ok = await probeUrl(url)
    if (ok) return { healed: true, newUrl: url, strategy: 'github-community-pattern' }
  }

  return { healed: false }
}

// ── Stratégie C : custom-web-player — marquer pour re-extraction ─────────────
async function healCustomWebPlayer (channel, stream) {
  const fallbackResult = await healCdnPublic(channel, stream)
  if (fallbackResult.healed) return { ...fallbackResult, strategy: 'web-player-fallback' }

  console.log(`⚠️  [Healer] ${channel.name}: flux custom-web-player expiré — token à re-générer manuellement`)
  return { healed: false, note: 'token-expired' }
}

// ── Stratégie D : direct-ip — trop dynamique, archiver ───────────────────────
async function healDirectIp (channel, stream) {
  return healCdnPublic(channel, stream)
}

// ── Dispatcher des stratégies ─────────────────────────────────────────────────
async function healStream (channel, stream) {
  const origin = stream.source_origin || 'unknown'

  switch (origin) {
    case 'cdn-public':
      return healCdnPublic(channel, stream)
    case 'github-community':
      return healGithubCommunity(channel, stream)
    case 'custom-web-player':
      return healCustomWebPlayer(channel, stream)
    case 'direct-ip':
      return healDirectIp(channel, stream)
    case 'xtream-codes':
      return healCdnPublic(channel, stream)
    default:
      return healCdnPublic(channel, stream)
  }
}

// ── Cycle principal de guérison ───────────────────────────────────────────────
async function healInactiveStreams () {
  console.log('🩺 [Healer] Démarrage du cycle de guérison...')

  const channels = await Channel.find({
    'streams.status': 'inactive',
    hasStream: true,
  }).limit(MAX_HEAL_PER_RUN).lean()

  let healed   = 0
  let checked  = 0

  for (const channel of channels) {
    const streams = channel.streams || []
    const inactiveStreams = streams.filter(s => s.status === 'inactive')
    if (!inactiveStreams.length) continue

    let channelUpdated = false
    const updatedStreams = [...streams]

    for (const stream of inactiveStreams) {
      checked++
      const result = await healStream(channel, stream)

      if (result.healed && result.newUrl) {
        console.log(`✅ [Healer] ${channel.name}: guéri via ${result.strategy} → ${result.newUrl.substring(0, 60)}...`)
        const idx = updatedStreams.findIndex(s => s.url === stream.url)
        if (idx !== -1) {
          updatedStreams[idx] = {
            ...updatedStreams[idx],
            url:        result.newUrl,
            status:     'active',
            healedAt:   new Date(),
            healedFrom: stream.url,
            strategy:   result.strategy,
          }
          channelUpdated = true
          healed++
        }
      }
    }

    if (channelUpdated) {
      await Channel.updateOne(
        { _id: channel._id },
        { $set: { streams: updatedStreams, hasStream: updatedStreams.some(s => s.status === 'active') } }
      )
    }
  }

  console.log(`🩺 [Healer] Cycle terminé — ${healed}/${checked} streams guéris`)
  return { healed, checked }
}

async function healChannel (channelId) {
  const channel = await Channel.findOne({ id: channelId }).lean()
  if (!channel) return { error: 'channel not found' }

  const results = []
  const updatedStreams = [...(channel.streams || [])]

  for (const stream of updatedStreams.filter(s => s.status !== 'active')) {
    const result = await healStream(channel, stream)
    results.push({ url: stream.url, ...result })

    if (result.healed && result.newUrl) {
      const idx = updatedStreams.findIndex(s => s.url === stream.url)
      if (idx !== -1) {
        updatedStreams[idx] = {
          ...updatedStreams[idx],
          url: result.newUrl, status: 'active',
          healedAt: new Date(), strategy: result.strategy,
        }
      }
    }
  }

  await Channel.updateOne(
    { _id: channel._id },
    { $set: { streams: updatedStreams, hasStream: updatedStreams.some(s => s.status === 'active') } }
  )

  return { channelId, results }
}

module.exports = { healInactiveStreams, healChannel, healStream, probeUrl }
