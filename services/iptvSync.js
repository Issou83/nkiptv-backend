/**
 * NKiptv — Synchronisation des chaînes depuis iptv-org
 * Source : https://iptv-org.github.io/api
 * Lance une sync complète + vérification des streams
 */
const axios = require('axios')
const Channel = require('../models/Channel')

const IPTV_ORG_API = 'https://iptv-org.github.io/api'
const BATCH_SIZE = 100
const STREAM_CHECK_TIMEOUT = 8000

/**
 * Synchronisation principale
 * 1. Récupère tous les channels + streams depuis iptv-org
 * 2. Upsert dans MongoDB
 * 3. Marque les streams actifs
 */
const sync = async () => {
  console.log('🔄 Démarrage sync iptv-org...')
  const start = Date.now()

  try {
    // Récupérer channels et streams en parallèle
    const [channelsRes, streamsRes] = await Promise.all([
      axios.get(`${IPTV_ORG_API}/channels.json`, { timeout: 30000 }),
      axios.get(`${IPTV_ORG_API}/streams.json`, { timeout: 60000 }),
    ])

    const channels = channelsRes.data
    const streams = streamsRes.data

    console.log(`📥 Reçu : ${channels.length} chaînes, ${streams.length} streams`)

    // Indexer les streams par channel_id
    const streamsByChannel = {}
    for (const s of streams) {
      if (!streamsByChannel[s.channel]) streamsByChannel[s.channel] = []
      streamsByChannel[s.channel].push(s)
    }

    // Traiter par batch
    let processed = 0
    let updated = 0

    for (let i = 0; i < channels.length; i += BATCH_SIZE) {
      const batch = channels.slice(i, i + BATCH_SIZE)
      const ops = batch.map(ch => {
        const chStreams = streamsByChannel[ch.id] || []
        return {
          updateOne: {
            filter: { id: ch.id },
            update: {
              $set: {
                id: ch.id,
                name: ch.name,
                altNames: ch.alt_names || [],
                network: ch.network,
                owners: ch.owners || [],
                country: ch.country,
                subdivision: ch.subdivision,
                city: ch.city,
                broadcastArea: ch.broadcast_area || [],
                languages: ch.languages || [],
                categories: ch.categories || [],
                isNsfw: ch.is_nsfw || false,
                logo: ch.logo,
                website: ch.website,
                epgIds: ch.guides || [],
                timezone: ch.timezone,
                streams: chStreams.map(s => ({
                  url: s.url,
                  quality: detectQuality(s.url, s.quality),
                  status: 'unknown',
                  httpReferrer: s.http_referrer || null,
                  userAgent: s.user_agent || null,
                })),
                hasStream: chStreams.length > 0,
                isActive: true,
                lastSyncedAt: new Date(),
              },
            },
            upsert: true,
          },
        }
      })

      await Channel.bulkWrite(ops, { ordered: false })
      processed += batch.length
      updated++
      if (updated % 10 === 0) console.log(`  ⏳ ${processed}/${channels.length} chaînes traitées`)
    }

    // Désactiver les chaînes qui ne sont plus dans le feed
    const activeIds = channels.map(c => c.id)
    await Channel.updateMany(
      { id: { $nin: activeIds }, source: 'iptv-org' },
      { $set: { isActive: false } }
    )

    const duration = ((Date.now() - start) / 1000).toFixed(1)
    const withStream = await Channel.countDocuments({ hasStream: true, isActive: true })
    console.log(`✅ Sync terminée en ${duration}s : ${processed} chaînes, ${withStream} avec stream`)

    return { processed, withStream, duration }
  } catch (err) {
    console.error('❌ Erreur sync:', err.message)
    throw err
  }
}

/**
 * Vérification de quelques streams (ne pas vérifier tous à chaque sync)
 * Lance 20 vérifications en parallèle
 */
const checkStreams = async (limit = 100) => {
  console.log(`🔍 Vérification de ${limit} streams...`)

  const channels = await Channel.find({
    hasStream: true, isActive: true,
    $or: [
      { lastStreamCheck: { $lt: new Date(Date.now() - 6 * 60 * 60 * 1000) } }, // pas vérif depuis 6h
      { lastStreamCheck: null },
    ],
  }).limit(limit)

  let checked = 0
  let online = 0

  for (const channel of channels) {
    const results = await Promise.allSettled(
      channel.streams.slice(0, 2).map(s => checkStream(s.url))
    )

    let firstOnlineUrl = null
    let firstHlsUrl = null

    for (let i = 0; i < results.length; i++) {
      channel.streams[i].status = results[i].status === 'fulfilled' && results[i].value
        ? 'online' : 'offline'
      channel.streams[i].lastCheck = new Date()
      if (channel.streams[i].status === 'online') {
        const url = channel.streams[i].url
        if (!firstOnlineUrl) { firstOnlineUrl = url; online++ }
        // Préférer HLS (.m3u8) sur DASH (.mpd) — HLS.js ne supporte pas DASH
        if (!firstHlsUrl && url.includes('.m3u8')) firstHlsUrl = url
      }
    }
    if (firstOnlineUrl) channel.bestStreamUrl = firstHlsUrl || firstOnlineUrl

    channel.lastStreamCheck = new Date()
    await channel.save()
    checked++
  }

  console.log(`✅ Check terminé : ${online}/${checked} streams online`)
  return { checked, online }
}

async function checkStream(url) {
  try {
    const res = await axios.head(url, {
      timeout: STREAM_CHECK_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.0', 'Accept': '*/*' },
      maxRedirects: 3,
    })
    return res.status < 400
  } catch {
    try {
      // Essai GET si HEAD échoue (certains serveurs HLS ne supportent pas HEAD)
      const res = await axios.get(url, {
        timeout: STREAM_CHECK_TIMEOUT,
        headers: { 'User-Agent': 'VLC/3.0.0' },
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

function detectQuality(url, hint) {
  if (hint) return hint.toUpperCase()
  const u = url.toLowerCase()
  if (u.includes('4k') || u.includes('uhd') || u.includes('2160')) return '4K'
  if (u.includes('fhd') || u.includes('1080')) return 'FHD'
  if (u.includes('hd') || u.includes('720')) return 'HD'
  if (u.includes('sd') || u.includes('480')) return 'SD'
  return 'HD' // Par défaut HD
}

module.exports = { sync, checkStreams }
