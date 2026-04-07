/**
 * France TV live stream service
 *
 * Tente d'obtenir les URLs signées depuis l'API player.france.tv.
 * Si l'API est inaccessible ou retourne une erreur, utilise les URLs
 * GitHub community (schumijo/iptv) en fallback.
 *
 * Cache mémoire TTL 4 jours pour éviter de spam l'API.
 */
const axios = require('axios')

const TTL_MS = 4 * 24 * 60 * 60 * 1000 // 4 jours

// Mapping slug france.tv → URL fallback GitHub
const CHANNELS = {
  'france-2':    'https://raw.githubusercontent.com/schumijo/iptv/main/playlists/francetv/france2.m3u8',
  'france-3':    'https://raw.githubusercontent.com/schumijo/iptv/main/playlists/francetv/france3.m3u8',
  'france-4':    'https://raw.githubusercontent.com/schumijo/iptv/main/playlists/francetv/france4.m3u8',
  'france-5':    'https://raw.githubusercontent.com/schumijo/iptv/main/playlists/francetv/france5.m3u8',
  'france-info': 'https://raw.githubusercontent.com/schumijo/iptv/main/playlists/francetv/franceinfo.m3u8',
}

const cache = new Map() // slug → { url, ts }

/**
 * Tente de récupérer l'URL HLS live depuis l'API player.france.tv.
 * @param {string} slug  ex: 'france-2'
 * @returns {Promise<string|null>} URL HLS ou null si indisponible
 */
async function fetchFromApi(slug) {
  try {
    const res = await axios.get(`https://player.france.tv/api/live/${slug}`, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.france.tv/',
        'Origin': 'https://www.france.tv',
      },
    })
    const data = res.data
    // L'API retourne typiquement { url, token, ... } ou { hls, ... }
    const url = data?.url || data?.hls || data?.stream_url || data?.manifest_url
    if (url && typeof url === 'string' && url.includes('.m3u8')) {
      console.log(`[franceTv] API OK pour ${slug}: ${url.slice(0, 80)}`)
      return url
    }
    console.warn(`[franceTv] API ${slug}: réponse sans URL HLS valide`, JSON.stringify(data).slice(0, 200))
    return null
  } catch (err) {
    console.warn(`[franceTv] API ${slug} inaccessible: ${err.message}`)
    return null
  }
}

/**
 * Retourne l'URL HLS live pour un slug France TV.
 * Utilise le cache mémoire (TTL 4 jours) puis l'API, sinon le fallback GitHub.
 * @param {string} slug  ex: 'france-2'
 * @returns {Promise<string>} URL HLS
 */
async function getLiveUrl(slug) {
  // Cache valide ?
  const cached = cache.get(slug)
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return cached.url
  }

  // Essai API
  const apiUrl = await fetchFromApi(slug)
  if (apiUrl) {
    cache.set(slug, { url: apiUrl, ts: Date.now() })
    return apiUrl
  }

  // Fallback GitHub
  const fallback = CHANNELS[slug]
  if (fallback) {
    console.log(`[franceTv] Fallback GitHub pour ${slug}: ${fallback}`)
    cache.set(slug, { url: fallback, ts: Date.now() })
    return fallback
  }

  throw new Error(`[franceTv] Aucune URL disponible pour le slug: ${slug}`)
}

/**
 * Détecte si une URL de stream appartient à France TV.
 * @param {string} url
 * @returns {string|null} slug France TV ou null
 */
function detectFranceTvSlug(url) {
  if (!url) return null
  const lower = url.toLowerCase()
  if (!lower.includes('simulcast') && !lower.includes('ftven.fr') && !lower.includes('francetv')) return null

  if (lower.includes('france-2') || lower.includes('france2'))     return 'france-2'
  if (lower.includes('france-3') || lower.includes('france3'))     return 'france-3'
  if (lower.includes('france-4') || lower.includes('france4'))     return 'france-4'
  if (lower.includes('france-5') || lower.includes('france5'))     return 'france-5'
  if (lower.includes('france-info') || lower.includes('franceinfo')) return 'france-info'

  return null
}

/**
 * Invalide le cache pour un slug (utile si le stream est offline).
 * @param {string} slug
 */
function invalidateCache(slug) {
  cache.delete(slug)
}

module.exports = { getLiveUrl, detectFranceTvSlug, invalidateCache, CHANNELS }
