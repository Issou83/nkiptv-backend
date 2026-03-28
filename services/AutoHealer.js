/**
 * NKiptv â AutoHealer.js
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 * Maintenance automatique des flux inactifs.
 *
 * Algorithme :
 *  1. RÃ©cupÃ¨re les flux marquÃ©s "inactive" (ou "error" depuis > 1h)
 *  2. Pour chaque flux inactif, cherche dans la base des flux "active"
 *     ayant un nom similaire â via distance de Levenshtein normalisÃ©e.
 *  3. Si un candidat de similaritÃ© â¥ SIMILARITY_THRESHOLD est trouvÃ©,
 *     le flux inactif est "remplacÃ©" : son URL pointe vers le candidat,
 *     l'ancienne URL est archivÃ©e dans urlHistory.
 *  4. Si aucun candidat n'existe, le flux reste marquÃ© "inactive".
 *
 * Planification : toutes les heures (peut Ãªtre ajustÃ©).
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 */
'use strict'

const cron             = require('node-cron')
const DiscoveredStream = require('../models/DiscoveredStream')

// ââ Configuration âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const SIMILARITY_THRESHOLD = parseFloat(process.env.HEALER_SIMILARITY) || 0.75  // 0-1
const BATCH_SIZE           = parseInt(process.env.HEALER_BATCH_SIZE)   || 30
const MAX_INACTIVE_AGE_MS  = 60 * 60 * 1000   // 1h minimum d'inactivitÃ© avant tentative

// ââ Distance de Levenshtein ââââââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Calcule la distance d'Ã©dition (Levenshtein) entre deux chaÃ®nes.
 * ImplÃ©mentation itÃ©rative O(mÃn) avec deux lignes seulement.
 * @param {string} a
 * @param {string} b
 * @returns {number} distance (0 = identiques)
 */
function levenshtein (a, b) {
  a = a.toLowerCase().trim()
  b = b.toLowerCase().trim()
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,         // insertion
        prev[j] + 1,             // suppression
        prev[j - 1] + cost,      // substitution
      )
    }
    prev = curr
  }
  return prev[b.length]
}

/**
 * SimilaritÃ© normalisÃ©e [0, 1] basÃ©e sur Levenshtein.
 * 1.0 = identiques, 0.0 = totalement diffÃ©rents.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity (a, b) {
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

// ââ Normalisation du nom pour le matching ââââââââââââââââââââââââââââââââââââ
/**
 * Supprime les termes parasites (HD, FHD, SD, 4K, etc.) pour amÃ©liorer le matching.
 * Ex : "CNN HD" â "CNN", "TF1 FHD FR" â "TF1 FR"
 */
function normalizeName (name) {
  return name
    .replace(/\b(HD|FHD|SD|4K|UHD|HEVC|H\.?265?|H\.?264?|AVC|HLS|MPEG[-\s]?TS)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ââ Recherche de candidats actifs similaires ââââââââââââââââââââââââââââââââââ
/**
 * Cherche dans la base les N meilleurs candidats actifs pour remplacer un flux inactif.
 *
 * Optimisation : on prÃ©-filtre via MongoDB text search sur le nom,
 * puis on affine avec Levenshtein en mÃ©moire sur le rÃ©sultat rÃ©duit.
 *
 * @param {Object} inactiveStream  Document du flux inactif
 * @param {number} limit           Nombre max de candidats Ã  retourner
 * @returns {Array<{stream, score}>} Candidats triÃ©s par score dÃ©croissant
 */
async function findCandidates (inactiveStream, limit = 5) {
  const normalizedTarget = normalizeName(inactiveStream.name || '')
  if (!normalizedTarget) return []

  // Mots significatifs du nom (> 2 caractÃ¨res) pour la recherche textuelle
  const words = normalizedTarget
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 3)   // max 3 mots pour rester pertinent

  if (!words.length) return []

  // PrÃ©-filtre MongoDB : flux actifs avec texte proche
  const candidates = await DiscoveredStream
    .find({
      status: 'active',
      _id:    { $ne: inactiveStream._id },
      $text:  { $search: words.join(' ') },
    })
    .select('_id name url logo source groupTitle')
    .limit(100)   // fenÃªtre de recherche
    .lean()

  if (!candidates.length) {
    // Fallback : recherche par groupTitle si disponible
    if (inactiveStream.groupTitle) {
      const fallback = await DiscoveredStream
        .find({ status: 'active', groupTitle: inactiveStream.groupTitle, _id: { $ne: inactiveStream._id } })
        .select('_id name url logo source groupTitle')
        .limit(50)
        .lean()
      candidates.push(...fallback)
    }
  }

  // Scoring Levenshtein sur les candidats prÃ©-filtrÃ©s
  const scored = candidates
    .map(c => ({
      stream: c,
      score:  similarity(normalizedTarget, normalizeName(c.name || '')),
    }))
    .filter(({ score }) => score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return scored
}

// ââ RÃ©paration d'un flux inactif ââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Tente de rÃ©parer un flux inactif en lui associant un remplaÃ§ant actif.
 * @param {Object} stream  Document lean du flux inactif
 * @returns {Object|null}  RÃ©sultat de l'opÃ©ration ou null si aucun candidat
 */
async function healOne (stream) {
  const candidates = await findCandidates(stream)

  if (!candidates.length) {
    return { id: stream._id, action: 'no_candidate', stream: stream.name }
  }

  const best = candidates[0]

  // Archiver l'ancienne URL et pointer vers le remplaÃ§ant
  const historyEntry = {
    url:        stream.url,
    replacedAt: new Date(),
    reason:     'inactive',
  }

  await DiscoveredStream.updateOne(
    { _id: stream._id },
    {
      $set: {
        status:      'replaced',
        replacedBy:  best.stream.url,
        lastChecked: new Date(),
      },
      $push: {
        urlHistory: {
          $each:  [historyEntry],
          $position: 0,
          $slice: 10,   // garde les 10 derniers remplacements
        },
      },
    }
  )

  console.log(
    `  ð§ "${stream.name}" [inactive] â remplacÃ© par "${best.stream.name}" ` +
    `(similaritÃ©: ${(best.score * 100).toFixed(1)}%)`
  )

  return {
    id:          stream._id,
    action:      'replaced',
    stream:      stream.name,
    replacedBy:  best.stream.name,
    newUrl:      best.stream.url,
    similarity:  best.score,
  }
}

// ââ Cycle de maintenance âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Lance un cycle complet d'AutoHealer sur les flux inactifs/en erreur.
 * @returns {Object} Statistiques du cycle
 */
async function runHealCycle () {
  console.log('\nð©º [AutoHealer] DÃ©marrage du cycle de maintenance...')
  const start = Date.now()

  const cutoff = new Date(Date.now() - MAX_INACTIVE_AGE_MS)

  // Flux inactifs depuis suffisamment longtemps (pas encore remplacÃ©s)
  const streams = await DiscoveredStream
    .find({
      status:      { $in: ['inactive', 'error'] },
      lastChecked: { $lt: cutoff },
    })
    .sort({ lastChecked: 1 })
    .limit(BATCH_SIZE)
    .select('_id name url groupTitle tvgName')
    .lean()

  if (!streams.length) {
    console.log('[AutoHealer] Aucun flux Ã  rÃ©parer.')
    return { healed: 0, noCandidates: 0, duration: '0.0' }
  }

  console.log(`  ð ${streams.length} flux inactifs Ã  analyser...`)

  let healed      = 0
  let noCandidates = 0
  const details   = []

  // Traitement sÃ©quentiel pour Ã©viter la surcharge Mongo sur les text search
  for (const stream of streams) {
    const result = await healOne(stream).catch(err => {
      console.warn(`  â ï¸  Erreur sur "${stream.name}": ${err.message}`)
      return null
    })
    if (!result) continue

    if (result.action === 'replaced') healed++
    else noCandidates++

    details.push(result)
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`â [AutoHealer] TerminÃ© en ${duration}s â rÃ©parÃ©s: ${healed} | sans candidat: ${noCandidates}\n`)

  return { healed, noCandidates, duration, details }
}

// ââ DÃ©marrage du scheduler âââââââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Initialise la tÃ¢che planifiÃ©e AutoHealer.
 * Ã appeler une seule fois au dÃ©marrage du serveur.
 */
function startScheduler () {
  console.log('ð©º [AutoHealer] Scheduler dÃ©marrÃ©')

  // Toutes les heures
  cron.schedule('0 * * * *', async () => {
    await runHealCycle().catch(err =>
      console.error('[AutoHealer] Erreur cycle:', err.message)
    )
  })

  // Premier passage 2 minutes aprÃ¨s le dÃ©marrage
  setTimeout(() => {
    runHealCycle().catch(err => console.error('[AutoHealer] Init error:', err.message))
  }, 2 * 60 * 1000)
}

// ââ API publique ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
module.exports = { startScheduler, runHealCycle, healOne, findCandidates, similarity, levenshtein }
