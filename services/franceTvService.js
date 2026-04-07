/**
 * NKiptv — Service France TV live
 * ─────────────────────────────────────────────────────────────────────────────
 * Fournit des URLs HLS fraîches pour France 2/3/4/5 en récupérant les
 * playlists master signées depuis le repo schumijo/iptv (GitHub).
 *
 * Les tokens HMAC intégrés dans ces masters ont une expiry ~1 an ;
 * on rafraîchit quand même toutes les 4 jours pour détecter d'éventuelles
 * rotations anticipées.
 *
 * API France TV (player.france.tv/api/live/{channel}) utilisée comme
 * première tentative ; GitHub comme fallback.
 *
 * Exports :
 *   getStreamUrl(nameOrId)   → Promise<string|null>   URL HLS fraîche (cachée)
 *   getChannelKey(nameOrId)  → string|null            Clé interne (ex: 'france-2')
 *   startRefreshSchedule()   → void                   Lance le cron 4 jours
 */
'use strict'

const axios = require('axios')

// ── Constantes ────────────────────────────────────────────────────────────────

const TTL_MS = 4 * 24 * 60 * 60 * 1000  // 4 jours

const GITHUB_BASE = 'https://raw.githubusercontent.com/schumijo/iptv/main/playlists/francetv/'

// Clés internes → fichier GitHub
const CHANNEL_FILES = {
  'france-2':    'france2.m3u8',
  'france-3':    'france3.m3u8',
  'france-4':    'france4.m3u8',
  'france-5':    'france5.m3u8',
  'france-info': 'franceinfo.m3u8',
}

// Détection par nom de chaîne ou id MongoDB
const MATCHERS = [
  { key: 'france-2',    pattern: /^france\s*2$/i,    ids: ['France2.fr'] },
  { key: 'france-3',    pattern: /^france\s*3$/i,    ids: ['France3.fr'] },
  { key: 'france-4',    pattern: /^france\s*4$/i,    ids: ['France4.fr'] },
  { key: 'france-5',    pattern: /^france\s*5$/i,    ids: ['France5.fr'] },
  { key: 'france-info', pattern: /france.*info/i,    ids: ['FranceInfoTV.fr'] },
]

// ── Cache mémoire ─────────────────────────────────────────────────────────────
// { 'france-2': { url: 'https://...', cachedAt: timestamp } }
const cache = new Map()

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Retourne la clé interne ('france-2', etc.) depuis un nom ou id de chaîne.
 * @param {string} nameOrId
 * @returns {string|null}
 */
function getChannelKey(nameOrId) {
  if (!nameOrId) return null
  for (const { key, pattern, ids } of MATCHERS) {
    if (ids.includes(nameOrId) || pattern.test(nameOrId)) return key
  }
  return null
}

/**
 * Extrait la première URL de rendu vidéo depuis un master M3U8.
 * Retourne null si aucune n'est trouvée.
 */
function extractFirstRenditionUrl(m3u8Text) {
  const lines = m3u8Text.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const url = lines[i + 1]?.trim()
      if (url && /^https?:\/\//i.test(url)) return url
    }
  }
  return null
}

/**
 * Tente de récupérer une URL HLS via l'API France TV officielle.
 * Retourne null si l'API est inaccessible ou si la réponse est invalide.
 */
async function fetchFromFranceTvApi(channelKey) {
  const apiUrl = `https://player.france.tv/api/live/${channelKey}`
  try {
    const { data } = await axios.get(apiUrl, { timeout: 8000 })

    // La structure peut varier — on cherche un champ url contenant .m3u8
    const tryPaths = [
      data?.url,
      data?.streams?.[0]?.url,
      data?.stream?.url,
      data?.hls,
    ]
    const url = tryPaths.find(u => u && typeof u === 'string' && u.includes('.m3u8'))
    if (url) {
      console.log(`[FranceTV] ✅ API officielle — ${channelKey}: ${url.slice(0, 80)}`)
      return url
    }
  } catch (_) {
    // API inaccessible ou inexistante — silencieux, on passe au fallback
  }
  return null
}

/**
 * Récupère l'URL HLS depuis le repo schumijo (GitHub) en extrayant
 * la première rendu du master M3U8.
 */
async function fetchFromGithub(channelKey) {
  const file = CHANNEL_FILES[channelKey]
  if (!file) return null

  const masterUrl = GITHUB_BASE + file
  try {
    const { data } = await axios.get(masterUrl, { timeout: 10000, responseType: 'text' })
    const rendition = extractFirstRenditionUrl(data)
    if (rendition) {
      console.log(`[FranceTV] ✅ GitHub fallback — ${channelKey}: ${rendition.slice(0, 80)}`)
      return rendition
    }
    // Master sans rendu lisible → retourner le master lui-même (le proxy le gère)
    console.log(`[FranceTV] ⚠️  ${channelKey}: master sans rendu — retourne master URL`)
    return masterUrl
  } catch (err) {
    console.error(`[FranceTV] ❌ GitHub fetch échoué pour ${channelKey}:`, err.message)
    return null
  }
}

/**
 * Récupère et met en cache l'URL pour une clé France TV.
 * Ordre : API officielle → GitHub fallback.
 */
async function fetchAndCache(channelKey) {
  const url =
    (await fetchFromFranceTvApi(channelKey)) ||
    (await fetchFromGithub(channelKey))

  if (url) {
    cache.set(channelKey, { url, cachedAt: Date.now() })
  } else {
    console.error(`[FranceTV] ❌ Impossible de récupérer un stream pour ${channelKey}`)
  }
  return url || null
}

// ── API publique ──────────────────────────────────────────────────────────────

/**
 * Retourne l'URL HLS fraîche pour une chaîne France TV.
 * @param {string} nameOrId  Nom de chaîne ('France 2', 'france-2') ou id MongoDB ('France2.fr')
 * @returns {Promise<string|null>}
 */
async function getStreamUrl(nameOrId) {
  const key = getChannelKey(nameOrId)
  if (!key) return null

  const cached = cache.get(key)
  if (cached && Date.now() - cached.cachedAt < TTL_MS) {
    return cached.url
  }

  return fetchAndCache(key)
}

/**
 * Rafraîchit toutes les URLs France TV et met à jour le cache.
 */
async function refreshAll() {
  console.log('[FranceTV] 🔄 Refresh de toutes les chaînes France TV...')
  await Promise.all(Object.keys(CHANNEL_FILES).map(key => fetchAndCache(key)))
  console.log('[FranceTV] ✅ Refresh terminé')
}

/**
 * Lance le refresh au démarrage et toutes les 4 jours.
 * À appeler une seule fois depuis server.js.
 */
function startRefreshSchedule() {
  // Premier refresh en différé (3 s) pour ne pas bloquer le démarrage
  setTimeout(refreshAll, 3000)
  setInterval(refreshAll, TTL_MS)
}

module.exports = { getStreamUrl, getChannelKey, refreshAll, startRefreshSchedule, MATCHERS }
