/**
 * NKiptv â StreamMonitor.js
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 * Worker de validation en arriÃ¨re-plan des flux dÃ©couverts.
 *
 * StratÃ©gie de vÃ©rification en 2 phases :
 *   Phase 1 â RequÃªte HTTP HEAD rapide (< 5s) â sert/joignable ?
 *   Phase 2 â Analyse ffprobe si la phase 1 rÃ©ussit â codec, rÃ©solution, bitrate, fps
 *
 * Planification (node-cron) :
 *   â¢ Toutes les 30 min : vÃ©rifie les flux "pending" ou non vÃ©rifiÃ©s depuis > 6h
 *   â¢ Toutes les 2h    : vÃ©rifie les flux "active" (maintien de la disponibilitÃ©)
 *   â¢ Toutes les 4h    : vÃ©rifie les flux "inactive" (tentative de rÃ©cupÃ©ration)
 *
 * Concurrence : CONCURRENCY_LIMIT vÃ©rifications en parallÃ¨le (p-limit pattern natif).
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 */
'use strict'

const axios            = require('axios')
const { execFile }     = require('child_process')
const { promisify }    = require('util')
const cron             = require('node-cron')
const DiscoveredStream = require('../models/DiscoveredStream')
const { healInactiveStreams } = require('./StreamHealer')
const { healInactiveStreams } = require('./StreamHealer')
const { healInactiveStreams } = require('./StreamHealer')

const execFileAsync = promisify(execFile)

// ââ Configuration âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const HEAD_TIMEOUT      = parseInt(process.env.MONITOR_HEAD_TIMEOUT)   || 6_000   // ms
const PROBE_TIMEOUT     = parseInt(process.env.MONITOR_PROBE_TIMEOUT)  || 12_000  // ms
const CONCURRENCY_LIMIT = parseInt(process.env.MONITOR_CONCURRENCY)    || 8       // vÃ©rifs parallÃ¨les
const BATCH_SIZE        = parseInt(process.env.MONITOR_BATCH_SIZE)     || 50      // flux par cycle

// Ãge minimal avant re-vÃ©rification
const RECHECK_ACTIVE_MS   = 2  * 60 * 60 * 1000  // 2h
const RECHECK_INACTIVE_MS = 4  * 60 * 60 * 1000  // 4h
const RECHECK_PENDING_MS  = 0                     // immÃ©diat

let isRunning = false  // verrou pour Ã©viter les cycles simultanÃ©s

// ââ Phase 1 : VÃ©rification HTTP HEAD âââââââââââââââââââââââââââââââââââââââââ
/**
 * Tente une requÃªte HEAD puis GET (certains serveurs HLS refusent HEAD).
 * @returns {{ ok: boolean, status: number|null, responseTime: number }}
 */
async function httpProbe (url) {
  const t0 = Date.now()
  const headers = {
    'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16',
    Accept: '*/*',
  }

  const tryRequest = async (method) => {
    const res = await axios.request({
      method,
      url,
      timeout: HEAD_TIMEOUT,
      headers,
      maxRedirects: 5,
      ...(method === 'get' ? { responseType: 'stream' } : {}),
      validateStatus: () => true,  // on gÃ¨re nous-mÃªmes
    })
    if (method === 'get' && res.data?.destroy) res.data.destroy()
    return { ok: res.status >= 200 && res.status < 400, status: res.status }
  }

  try {
    const result = await tryRequest('head')
    return { ...result, responseTime: Date.now() - t0 }
  } catch {
    try {
      const result = await tryRequest('get')
      return { ...result, responseTime: Date.now() - t0 }
    } catch (err) {
      return { ok: false, status: null, responseTime: Date.now() - t0, error: err.message }
    }
  }
}

// ââ Phase 2 : Analyse ffprobe âââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Extrait les caractÃ©ristiques techniques du flux via ffprobe.
 * Retourne null si ffprobe n'est pas disponible ou si le flux n'est pas valide.
 * @param {string} url
 * @returns {Object|null}
 */
async function ffprobeAnalyze (url) {
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    '-analyzeduration', '5000000',  // 5s max d'analyse
    '-probesize', '1000000',        // 1 Mo max de lecture
    url,
  ]

  try {
    const { stdout } = await execFileAsync('ffprobe', args, {
      timeout: PROBE_TIMEOUT,
      env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' },
    })

    const data    = JSON.parse(stdout)
    const streams = data.streams || []
    const fmt     = data.format  || {}

    const video = streams.find(s => s.codec_type === 'video')
    const audio = streams.find(s => s.codec_type === 'audio')

    return {
      codec:      video?.codec_name || null,
      resolution: video ? `${video.width}x${video.height}` : null,
      bitrate:    fmt.bit_rate ? parseInt(fmt.bit_rate) : null,
      fps:        video?.r_frame_rate ? evalFraction(video.r_frame_rate) : null,
      format:     fmt.format_name ? fmt.format_name.split(',')[0] : null,
      audioCodec: audio?.codec_name || null,
    }
  } catch (err) {
    // ffprobe indisponible ou flux invalide â on renvoie l'erreur sans bloquer
    return { probeError: err.message?.substring(0, 200) || 'ffprobe failed' }
  }
}

/** Ãvalue une fraction "num/den" â nombre rÃ©el (ex: "25/1" â 25) */
function evalFraction (str) {
  const [n, d] = str.split('/').map(Number)
  return d && d !== 0 ? Math.round((n / d) * 100) / 100 : null
}

// ââ VÃ©rification d'un seul flux ââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * ExÃ©cute les 2 phases et met Ã  jour le document DiscoveredStream en base.
 * @param {Object} stream  Document Mongoose
 */
async function checkOne (stream) {
  try {
    // Marquer comme "en cours de vÃ©rification"
    await DiscoveredStream.updateOne({ _id: stream._id }, { $set: { status: 'checking' } })

    const head = await httpProbe(stream.url)
    const now  = new Date()

    let newStatus = head.ok ? 'active' : 'inactive'
    let techInfo  = stream.techInfo || null

    // Phase 2 seulement si Phase 1 OK
    if (head.ok) {
      const probe = await ffprobeAnalyze(stream.url)
      if (probe && !probe.probeError) {
        techInfo = probe
      } else if (probe?.probeError) {
        // ffprobe a Ã©chouÃ© mais le serveur rÃ©pond â on garde le statut "active"
        techInfo = { ...(techInfo || {}), probeError: probe.probeError }
      }
    }

    const checkEntry = {
      checkedAt:    now,
      status:       newStatus,
      responseTime: head.responseTime,
      httpStatus:   head.status,
      errorMessage: head.error || null,
    }

    // Mise Ã  jour atomique en base
    const update = {
      $set: {
        status:       newStatus,
        lastChecked:  now,
        responseTime: head.responseTime,
        techInfo,
      },
      $inc: {
        checkCount:   1,
        successCount: head.ok ? 1 : 0,
      },
    }

    // Calcul du uptime (effectuÃ© cÃ´tÃ© applicatif pour Ã©viter un second round-trip)
    const doc = await DiscoveredStream.findById(stream._id).select('checkCount successCount').lean()
    if (doc) {
      const newCheck   = (doc.checkCount || 0) + 1
      const newSuccess = (doc.successCount || 0) + (head.ok ? 1 : 0)
      update.$set.uptime = Math.round((newSuccess / newCheck) * 100)
    }

    // Ajout Ã  l'historique (fenÃªtre glissante de 20 entrÃ©es cÃ´tÃ© Mongo)
    await DiscoveredStream.updateOne(
      { _id: stream._id },
      {
        ...update,
        $push: {
          checkHistory: {
            $each:     [checkEntry],
            $position: 0,         // en tÃªte de tableau
            $slice:    20,        // garde les 20 derniers
          },
        },
      }
    )

    return { id: stream._id, url: stream.url, status: newStatus, responseTime: head.responseTime }
  } catch (err) {
    console.error(`[StreamMonitor] Erreur sur ${stream.url}: ${err.message}`)
    await DiscoveredStream.updateOne(
      { _id: stream._id },
      { $set: { status: 'error', lastChecked: new Date() }, $inc: { checkCount: 1 } }
    ).catch(() => {})
    return { id: stream._id, url: stream.url, status: 'error' }
  }
}

// ââ ExÃ©cution parallÃ¨le contrÃ´lÃ©e (p-limit natif) âââââââââââââââââââââââââââââ
/**
 * Traite un tableau de streams en lots parallÃ¨les sans dÃ©passer CONCURRENCY_LIMIT.
 * @param {Array} streams
 * @returns {Array} RÃ©sultats
 */
async function runParallel (streams) {
  const results = []
  for (let i = 0; i < streams.length; i += CONCURRENCY_LIMIT) {
    const batch = streams.slice(i, i + CONCURRENCY_LIMIT)
    const batchResults = await Promise.allSettled(batch.map(s => checkOne(s)))
    results.push(...batchResults.map(r => r.value || r.reason))
  }
  return results
}

// ââ Cycles de vÃ©rification âââââââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Lance un cycle de monitoring selon le statut cible.
 * @param {'pending'|'active'|'inactive'} targetStatus
 * @param {number} recheckMs  N'inclut que les docs non vÃ©rifiÃ©s depuis recheckMs
 */
async function runCycle (targetStatus = 'pending', recheckMs = 0) {
  if (isRunning) {
    console.log('[StreamMonitor] Cycle en cours, skip.')
    return
  }
  isRunning = true

  const label = `[StreamMonitor:${targetStatus}]`
  console.log(`\n${label} DÃ©marrage du cycle...`)
  const start = Date.now()

  try {
    const filter = {
      status: targetStatus === 'pending'
        ? { $in: ['pending', 'checking'] }  // pending + stuck checking
        : targetStatus,
    }

    if (recheckMs > 0) {
      filter.lastChecked = {
        $lt: new Date(Date.now() - recheckMs),
      }
    } else if (targetStatus === 'pending') {
      filter.$or = [{ lastChecked: null }, { lastChecked: { $exists: false } }]
    }

    const streams = await DiscoveredStream
      .find(filter)
      .sort({ lastChecked: 1 })   // les plus anciens d'abord
      .limit(BATCH_SIZE)
      .select('_id url status techInfo checkCount successCount')
      .lean()

    if (!streams.length) {
      console.log(`${label} Aucun flux Ã  vÃ©rifier.`)
      isRunning = false
      return
    }

    console.log(`${label} ${streams.length} flux Ã  vÃ©rifier (concurrence: ${CONCURRENCY_LIMIT})`)

    const results  = await runParallel(streams)
    const active   = results.filter(r => r?.status === 'active').length
    const inactive = results.filter(r => r?.status === 'inactive').length
    const errors   = results.filter(r => r?.status === 'error').length

    const duration = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`${label} â TerminÃ© en ${duration}s â actifs: ${active} | inactifs: ${inactive} | erreurs: ${errors}\n`)

    return { checked: streams.length, active, inactive, errors, duration }
  } catch (err) {
    console.error(`${label} â Erreur fatale: ${err.message}`)
  } finally {
    isRunning = false
  }
}

// ââ DÃ©marrage du scheduler cron âââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Initialise les tÃ¢ches planifiÃ©es du StreamMonitor.
 * Ã appeler une seule fois au dÃ©marrage du serveur.
 */
function startScheduler () {
  console.log('â° [StreamMonitor] Scheduler dÃ©marrÃ©')

  // Flux "pending" : toutes les 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await runCycle('pending', RECHECK_PENDING_MS)
  })

  // Flux "active" : toutes les 2 heures (maintien disponibilitÃ©)
  cron.schedule('0 */2 * * *', async () => {
    await runCycle('active', RECHECK_ACTIVE_MS)
  })

  // Flux "inactive" : toutes les 4 heures (tentative de rÃ©cupÃ©ration)
  cron.schedule('0 */4 * * *', async () => {
    await runCycle('inactive', RECHECK_INACTIVE_MS)
    try { await healInactiveStreams() } catch (e) { console.error('[StreamMonitor] Healer error:', e.message) }
  })

  // Premier passage immÃ©diat sur les "pending"
  setTimeout(() => runCycle('pending', RECHECK_PENDING_MS), 15_000)
}

// ââ API publique ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
module.exports = { startScheduler, runCycle, checkOne, ffprobeAnalyze, httpProbe }
