/**
 * NKiptv — streamHealer
 * ─────────────────────────────────────────────────────────────────────────────
 * Guérison automatique des chaînes marquées status='down' par les clients.
 *
 * Toutes les 30 minutes : HEAD request sur bestStreamUrl de chaque chaîne down
 * → si 2xx/3xx : status='up', failCount=0, lastChecked=now
 * → sinon : lastChecked=now (on réessaiera au prochain cycle)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict'

const axios = require('axios')
const Channel = require('../models/Channel')

const INTERVAL_MS     = 30 * 60 * 1000  // 30 minutes
const BATCH_SIZE      = 50               // max chaînes traitées par cycle
const REQUEST_TIMEOUT = 5000             // 5 s timeout HEAD request

/**
 * Teste une URL avec une requête HEAD — retourne true si 2xx/3xx.
 */
async function probeUrl(url) {
  try {
    const resp = await axios.head(url, {
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: (s) => s < 400,
      headers: { 'User-Agent': 'NKiptv-StreamHealer/1.0' },
    })
    return resp.status >= 200 && resp.status < 400
  } catch {
    return false
  }
}

/**
 * Un cycle de guérison : trouve les chaînes down et teste leurs streams.
 */
async function healDownChannels() {
  try {
    const downChannels = await Channel.find({ status: 'down' }).limit(BATCH_SIZE)
    if (downChannels.length === 0) return

    console.log('[StreamHealer] Verification de ' + downChannels.length + ' chaine(s) hors ligne...')

    for (const channel of downChannels) {
      const url = channel.bestStreamUrl || channel.streams?.[0]?.url
      if (!url) {
        channel.lastChecked = new Date()
        await channel.save().catch(() => {})
        continue
      }

      const alive = await probeUrl(url)

      if (alive) {
        channel.status      = 'up'
        channel.failCount   = 0
        channel.lastChecked = new Date()
        await channel.save().catch(() => {})
        console.log('[StreamHealer] OK ' + channel.name + ' -> up')
      } else {
        channel.lastChecked = new Date()
        await channel.save().catch(() => {})
        console.log('[StreamHealer] KO ' + channel.name + ' toujours down')
      }
    }
  } catch (err) {
    console.error('[StreamHealer] Erreur cycle:', err.message)
  }
}

/**
 * Démarre le heal automatique (setInterval + première passe après 5 s).
 */
function startStreamHealer() {
  console.log('[StreamHealer] Demarre - cycle toutes les 30 minutes')
  setTimeout(healDownChannels, 5000)
  setInterval(healDownChannels, INTERVAL_MS)
}

module.exports = { startStreamHealer, healDownChannels, probeUrl }
