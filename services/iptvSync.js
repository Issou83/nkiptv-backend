/**
 * NKiptv — Synchronisation des chaînes depuis iptv-org
 * Sources :
 *   - https://iptv-org.github.io/api/channels.json  (métadonnées)
 *   - https://iptv-org.github.io/api/streams.json   (streams + referrer/user-agent)
 *   - https://iptv-org.github.io/api/logos.json     (logos)
 *   - https://iptv-org.github.io/iptv/index.m3u     (source M3U complémentaire)
 */
const axios   = require('axios')
const Channel = require('../models/Channel')

const IPTV_ORG_API         = 'https://iptv-org.github.io/api'
const IPTV_ORG_M3U         = 'https://iptv-org.github.io/iptv/index.m3u'
const BATCH_SIZE           = 100
const STREAM_CHECK_TIMEOUT = 8000

/**
 * Parse un fichier M3U et retourne un tableau de { channelId, name, logo, group, url }
 * Format tvg-id : "CNN.us" ou "CNN.us@HD" → on strip le suffixe @quality
 */
function parseM3U(text) {
  const lines   = text.split('\n')
  const entries = []
  let current   = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('#EXTINF')) {
      const tvgId   = (line.match(/tvg-id="([^"]*)"/)      || [])[1] || ''
      const tvgLogo = (line.match(/tvg-logo="([^"]*)"/)    || [])[1] || ''
      const group   = (line.match(/group-title="([^"]*)"/) || [])[1] || ''
      const nameM   = line.match(/,(.+)$/)
      const name    = nameM ? nameM[1].trim() : ''
      // Strip qualité: "CNN.us@HD" → "CNN.us"
      const channelId = tvgId.replace(/@[^@]*$/, '').trim()
      current = { channelId, name, logo: tvgLogo, group, url: '' }
    } else if (line && !line.startsWith('#') && current) {
      current.url = line
      if (current.channelId && current.url) entries.push(current)
      current = null
    }
  }
  return entries
}

/**
 * Synchronisation principale
 * 1. Récupère channels + streams + logos depuis l'API iptv-org
 * 2. Parse le M3U index.m3u comme source complémentaire
 * 3. Upsert dans MongoDB avec bestStreamUrl défini dès la sync
 */
const sync = async () => {
  console.log('🔄 Démarrage sync iptv-org...')
  const start = Date.now()

  try {
    // ── Étape 1 : Récupérer toutes les sources en parallèle ──────────────
    const [channelsRes, streamsRes, logosRes, m3uRes] = await Promise.allSettled([
      axios.get(`${IPTV_ORG_API}/channels.json`, { timeout: 30000 }),
      axios.get(`${IPTV_ORG_API}/streams.json`,  { timeout: 60000 }),
      axios.get(`${IPTV_ORG_API}/logos.json`,    { timeout: 30000 }),
      axios.get(IPTV_ORG_M3U, {
        timeout: 60000, responseType: 'text',
        headers: { 'User-Agent': 'NKiptv/2.0 (+https://passiloc.fr)' },
      }),
    ])

    const channels = channelsRes.status === 'fulfilled' ? channelsRes.value.data : []
    const streams  = streamsRes.status  === 'fulfilled' ? streamsRes.value.data  : []
    const logos    = logosRes.status    === 'fulfilled' ? logosRes.value.data    : []
    const m3uText  = m3uRes.status      === 'fulfilled' ? m3uRes.value.data      : ''

    console.log(`📥 channels=${channels.length}, streams=${streams.length}, logos=${logos.length}, m3u=${m3uText.split('\\n').length} lignes`)

    // ── Étape 2 : Construire les index ────────────────────────────────────
    // Index logos par channel_id
    const logosByChannel = {}
    for (const l of logos) {
      if (l.channel && !logosByChannel[l.channel]) logosByChannel[l.channel] = l.url
    }

    // Index streams par channel_id
    // ⚠️  CORRECTION CRITIQUE : l'API retourne `referrer` et non `http_referrer`
    const streamsByChannel = {}
    for (const s of streams) {
      if (!s.channel) continue   // streams sans channel_id gérés via M3U
      if (!streamsByChannel[s.channel]) streamsByChannel[s.channel] = []
      streamsByChannel[s.channel].push({
        url:          s.url,
        quality:      detectQuality(s.url, s.quality),
        status:       'unknown',
        httpReferrer: s.referrer   || null,   // ← CORRIGÉ (était s.http_referrer)
        userAgent:    s.user_agent || null,
      })
    }

    // ── Étape 3 : Enrichir depuis le M3U ─────────────────────────────────
    // Le M3U contient des streams testés par le bot iptv-org toutes les 24h
    const m3uEntries = m3uText ? parseM3U(m3uText) : []
    console.log(`📋 M3U parsé : ${m3uEntries.length} entrées`)

    for (const entry of m3uEntries) {
      // Compléter les logos manquants
      if (!logosByChannel[entry.channelId] && entry.logo) {
        logosByChannel[entry.channelId] = entry.logo
      }
      // Ajouter le stream M3U si pas déjà présent via l'API
      if (!streamsByChannel[entry.channelId]) streamsByChannel[entry.channelId] = []
      const alreadyHas = streamsByChannel[entry.channelId].some(s => s.url === entry.url)
      if (!alreadyHas) {
        streamsByChannel[entry.channelId].push({
          url:          entry.url,
          quality:      detectQuality(entry.url, ''),
          status:       'unknown',
          httpReferrer: null,
          userAgent:    null,
        })
      }
    }

    // ── Étape 4 : Upsert channels dans MongoDB par batch ─────────────────
    let processed = 0

    for (let i = 0; i < channels.length; i += BATCH_SIZE) {
      const batch = channels.slice(i, i + BATCH_SIZE)
      const ops = batch.map(ch => {
        const chStreams = streamsByChannel[ch.id] || []
        // bestStreamUrl défini dès la sync (sera affiné par checkStreams)
        const bestUrl = chStreams.length > 0 ? chStreams[0].url : null

        return {
          updateOne: {
            filter: { id: ch.id },
            update: {
              $set: {
                id:            ch.id,
                name:          ch.name,
                altNames:      ch.alt_names  || [],
                network:       ch.network    || null,
                owners:        ch.owners     || [],
                country:       ch.country    || null,
                categories:    ch.categories || [],
                isNsfw:        ch.is_nsfw    || false,
                logo:          logosByChannel[ch.id] || null,
                website:       ch.website    || null,
                streams:       chStreams,
                hasStream:     chStreams.length > 0,
                bestStreamUrl: bestUrl,           // ← défini immédiatement
                isActive:      !ch.closed,
                source:        'iptv-org',
                lastSyncedAt:  new Date(),
              },
            },
            upsert: true,
          },
        }
      })

      await Channel.bulkWrite(ops, { ordered: false })
      processed += batch.length
      if (processed % 2000 === 0) console.log(`  ⏳ ${processed}/${channels.length} chaînes traitées`)
    }

    // ── Étape 5 : Désactiver les chaînes obsolètes ────────────────────────
    const activeIds   = channels.filter(c => !c.closed).map(c => c.id)
    const deactivated = await Channel.updateMany(
      { id: { $nin: activeIds }, source: 'iptv-org' },
      { $set: { isActive: false } }
    )

    const duration   = ((Date.now() - start) / 1000).toFixed(1)
    const withStream = await Channel.countDocuments({ hasStream: true, isActive: true })
    console.log(`✅ Sync terminée en ${duration}s : ${processed} chaînes, ${withStream} avec stream, ${deactivated.modifiedCount} désactivées`)

    return { processed, withStream, duration }
  } catch (err) {
    console.error('❌ Erreur sync:', err.message)
    throw err
  }
}

/**
 * Vérification des streams — teste jusqu'à 2 streams par chaîne
 * Met à jour bestStreamUrl avec le premier stream réellement online
 */
const checkStreams = async (limit = 100) => {
  console.log(`🔍 Vérification de ${limit} streams...`)

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000)
  const channels = await Channel.find({
    hasStream: true,
    isActive:  true,
    $or: [
      { lastStreamCheck: { $lt: sixHoursAgo } },
      { lastStreamCheck: null },
    ],
  }).limit(limit)

  let checked = 0, online = 0

  for (const channel of channels) {
    const results = await Promise.allSettled(
      channel.streams.slice(0, 2).map(s =>
        checkStream(s.url, s.httpReferrer, s.userAgent)
      )
    )

    let foundBest = false
    for (let i = 0; i < results.length; i++) {
      const isOnline = results[i].status === 'fulfilled' && results[i].value
      channel.streams[i].status    = isOnline ? 'online' : 'offline'
      channel.streams[i].lastCheck = new Date()
      if (isOnline && !foundBest) {
        channel.bestStreamUrl = channel.streams[i].url
        foundBest = true
        online++
      }
    }

    channel.lastStreamCheck = new Date()
    await channel.save()
    checked++
  }

  console.log(`✅ Check terminé : ${online}/${checked} streams online`)
  return { checked, online }
}

/**
 * Vérifie un stream individuel avec les headers appropriés (Referer, User-Agent)
 */
async function checkStream(url, referrer, userAgent) {
  const headers = {
    'User-Agent': userAgent || 'VLC/3.0.0 LibVLC/3.0.0 (compatible)',
    'Accept':     '*/*',
  }
  if (referrer) headers['Referer'] = referrer

  try {
    const res = await axios.head(url, { timeout: STREAM_CHECK_TIMEOUT, headers, maxRedirects: 3 })
    return res.status < 400
  } catch {
    try {
      const res = await axios.get(url, {
        timeout:      STREAM_CHECK_TIMEOUT,
        headers,
        responseType: 'stream',
        maxRedirects: 3,
      })
      res.data.destroy()
      return res.status < 400
    } catch {
      return false
    }
  }
}

/**
 * Détecte la qualité depuis l'URL ou le hint
 */
function detectQuality(url, hint) {
  if (hint && hint !== 'null' && hint.trim()) return hint.toUpperCase().replace(/P$/i, 'p')
  const u = (url || '').toLowerCase()
  if (u.includes('4k') || u.includes('uhd') || u.includes('2160')) return '4K'
  if (u.includes('fhd') || u.includes('1080'))                      return 'FHD'
  if (u.includes('hd')  || u.includes('720'))                       return 'HD'
  if (u.includes('sd')  || u.includes('480') || u.includes('360'))  return 'SD'
  return 'HD'
}

module.exports = { sync, checkStreams }
