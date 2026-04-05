/**
 * NKiptv — streamHealerScheduler
 * ────────────────────────────────────────────────────────────────────────────
 * Cron de vérification automatique des chaînes marquées 'down'.
 * Toutes les 30 minutes, teste le bestStreamUrl de chaque chaîne down
 * via un HEAD request (timeout 5s) et met à jour le statut.
 * ────────────────────────────────────────────────────────────────────────────
 */
'use strict'

const cron    = require('node-cron')
const http    = require('http')
const https   = require('https')
const { URL } = require('url')
const Channel = require('../models/Channel')

const CHECK_TIMEOUT_MS   = 5000   // 5s max par requête
const MAX_CHANNELS_PER_RUN = 50
const USER_AGENT         = 'Mozilla/5.0 (compatible; NKiptv-StreamChecker/1.0)'

// ── HEAD request avec timeout 5s ──────────────────────────────────────────────
function headCheck (rawUrl) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => { if (!settled) { settled = true; resolve(ok) } }

    try {
      const parsed = new URL(rawUrl)
      const lib = parsed.protocol === 'https:' ? https : http
      const req = lib.request(
        {
          hostname: parsed.hostname,
          port:     parsed.port || undefined,
          path:     parsed.pathname + parsed.search,
          method:   'HEAD',
          timeout:  CHECK_TIMEOUT_MS,
          headers:  { 'User-Agent': USER_AGENT, Accept: '*/*' },
        },
        (res) => done(res.statusCode >= 200 && res.statusCode < 400)
      )
      req.on('error',   () => done(false))
      req.on('timeout', () => { req.destroy(); done(false) })
      req.end()
    } catch {
      done(false)
    }
  })
}

// ── Cycle de vérification ─────────────────────────────────────────────────────
async function runHealCycle () {
  console.log('🩺 [StreamHealerScheduler] Démarrage du cycle...')

  const channels = await Channel.find({ status: 'down' }).limit(MAX_CHANNELS_PER_RUN)

  let healed  = 0
  let checked = 0

  for (const channel of channels) {
    channel.lastChecked = new Date()
    checked++

    const url = channel.bestStreamUrl
    if (!url) {
      await channel.save()
      continue
    }

    try {
      const ok = await headCheck(url)
      if (ok) {
        channel.status    = 'up'
        channel.failCount = 0
        healed++
        console.log(`✅ [StreamHealerScheduler] ${channel.name} → up`)
      } else {
        console.log(`❌ [StreamHealerScheduler] ${channel.name} → still down`)
      }
    } catch (err) {
      console.error(`⚠️  [StreamHealerScheduler] ${channel.name}: ${err.message}`)
    }

    await channel.save()
  }

  console.log(`🩺 [StreamHealerScheduler] Cycle terminé — ${healed}/${checked} chaînes rétablies`)
  return { healed, checked }
}

// ── Démarrage du cron (toutes les 30 min) ────────────────────────────────────
function startScheduler () {
  cron.schedule('*/30 * * * *', async () => {
    try {
      await runHealCycle()
    } catch (err) {
      console.error('[StreamHealerScheduler] Erreur cycle:', err.message)
    }
  })
  console.log('🩺 StreamHealerScheduler démarré (vérification toutes les 30 min)')
}

module.exports = { startScheduler, runHealCycle }
