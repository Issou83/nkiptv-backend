/**
 * NKiptv â SourceDiscovery.js
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 * DÃ©couverte automatique de sources M3U publiques sur GitHub.
 * 1. Recherche de dÃ©pÃ´ts via l'API GitHub Search (mots-clÃ©s IPTV)
 * 2. ÃnumÃ©ration des fichiers .m3u/.m3u8 dans chaque dÃ©pÃ´t
 * 3. TÃ©lÃ©chargement et parsing du contenu M3U
 * 4. Persistance dans MongoDB (upsert par URL unique)
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 */
'use strict'

const axios          = require('axios')
const DiscoveredStream = require('../models/DiscoveredStream')

// ââ Configuration âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const GITHUB_API   = 'https://api.github.com'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null   // optionnel mais recommandÃ© (60 â 5000 req/h)
const MAX_REPOS    = parseInt(process.env.DISCOVERY_MAX_REPOS)  || 15   // repos Ã  scanner
const MAX_FILES    = parseInt(process.env.DISCOVERY_MAX_FILES)  || 5    // fichiers M3U par repo
const REQ_TIMEOUT  = 20_000  // ms

const SEARCH_KEYWORDS = [
  'iptv m3u playlist',
  'free iptv m3u8 list',
  'live tv m3u streaming',
  'iptv channels m3u',
  'media playlist m3u',
  // Mots-clÃ©s franÃ§ais pour dÃ©couvrir des sources FR premium/canal
  'iptv france m3u playlist',
  'liste iptv franÃ§aise m3u8',
]

// Headers pour l'API GitHub
function githubHeaders () {
  const h = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'NKiptv-Observatory/2.0' }
  if (GITHUB_TOKEN) h['Authorization'] = `token ${GITHUB_TOKEN}`
  return h
}

// ââ Recherche de dÃ©pÃ´ts GitHub ââââââââââââââââââââââââââââââââââââââââââââââââ
async function searchGitHubRepos (keyword) {
  try {
    const res = await axios.get(`${GITHUB_API}/search/repositories`, {
      params: { q: `${keyword} in:name,description,readme`, sort: 'updated', per_page: 10 },
      headers: githubHeaders(),
      timeout: REQ_TIMEOUT,
    })
    return res.data.items || []
  } catch (err) {
    // Gestion du rate-limit GitHub (429 / 403)
    if (err.response?.status === 403 || err.response?.status === 429) {
      const retryAfter = parseInt(err.response.headers['retry-after'] || '60')
      console.warn(`â ï¸  GitHub rate-limit â pause ${retryAfter}s`)
      await sleep(retryAfter * 1000)
    } else {
      console.warn(`GitHub search error for "${keyword}": ${err.message}`)
    }
    return []
  }
}

// ââ Recherche de fichiers M3U dans un dÃ©pÃ´t ââââââââââââââââââââââââââââââââââââ
async function findM3UFilesInRepo (repo) {
  try {
    // GitHub Code Search : fichiers .m3u ou .m3u8 dans le repo
    const res = await axios.get(`${GITHUB_API}/search/code`, {
      params: { q: `extension:m3u OR extension:m3u8 repo:${repo.full_name}`, per_page: MAX_FILES },
      headers: githubHeaders(),
      timeout: REQ_TIMEOUT,
    })
    return (res.data.items || []).map(item => ({
      name:      item.name,
      path:      item.path,
      rawUrl:    `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${item.path}`,
      htmlUrl:   item.html_url,
      repoName:  repo.full_name,
      repoStars: repo.stargazers_count,
    }))
  } catch (err) {
    if (err.response?.status === 403) await sleep(5000)
    console.warn(`Cannot list files in ${repo.full_name}: ${err.message}`)
    return []
  }
}

// ââ TÃ©lÃ©chargement du contenu brut d'un fichier ââââââââââââââââââââââââââââââââ
async function fetchRawContent (rawUrl) {
  const res = await axios.get(rawUrl, {
    timeout: REQ_TIMEOUT,
    responseType: 'text',
    headers: { 'User-Agent': 'NKiptv-Observatory/2.0' },
    maxContentLength: 10 * 1024 * 1024,  // 10 Mo max
  })
  return res.data
}

// ââ Parser M3U ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Extrait les entrÃ©es d'une playlist M3U (format Ã©tendu #EXTM3U).
 * GÃ¨re les attributs : tvg-id, tvg-name, tvg-logo, group-title, tvg-country, tvg-language.
 * @param {string} content  Contenu brut du fichier M3U
 * @param {string} source   Label de la source ("GitHub - user/repo")
 * @param {string} sourceUrl URL du repo GitHub
 * @param {string} playlistFile Nom du fichier M3U
 * @returns {Array<Object>} EntrÃ©es parsÃ©es
 */
function parseM3U (content, source, sourceUrl, playlistFile) {
  const lines   = content.split(/\r?\n/)
  const entries = []
  let currentMeta = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    if (line.startsWith('#EXTINF')) {
      // Extraction des attributs inline
      currentMeta = {
        tvgId:      extractAttr(line, 'tvg-id'),
        tvgName:    extractAttr(line, 'tvg-name'),
        tvgLogo:    extractAttr(line, 'tvg-logo'),
        groupTitle: extractAttr(line, 'group-title'),
        country:    extractAttr(line, 'tvg-country'),
        language:   extractAttr(line, 'tvg-language'),
        logo:       extractAttr(line, 'tvg-logo'),
        // Nom brut : tout ce qui suit la virgule finale
        name:       line.includes(',') ? line.split(',').slice(1).join(',').trim() : 'Unknown',
      }
      // tvg-name prioritaire sur le nom brut
      if (currentMeta.tvgName) currentMeta.name = currentMeta.tvgName

    } else if (line && !line.startsWith('#') && currentMeta) {
      // Ligne d'URL â validation basique
      if (isValidStreamUrl(line)) {
        entries.push({
          name:         currentMeta.name || 'Unknown',
          url:          line,
          logo:         currentMeta.logo || currentMeta.tvgLogo || null,
          tvgId:        currentMeta.tvgId   || null,
          tvgName:      currentMeta.tvgName || null,
          groupTitle:   currentMeta.groupTitle || null,
          country:      currentMeta.country   || null,
          language:     currentMeta.language  || null,
          source,
          sourceUrl,
          playlistFile,
        })
      }
      currentMeta = null
    }
  }

  return entries
}

/** Extrait la valeur d'un attribut M3U : attr="valeur" */
function extractAttr (line, attr) {
  const re = new RegExp(`${attr}="([^"]*)"`, 'i')
  const m  = line.match(re)
  return m ? m[1].trim() : null
}

/** VÃ©rifie qu'une URL ressemble Ã  un flux multimÃ©dia */
function isValidStreamUrl (url) {
  if (!url || url.length < 10) return false
  try {
    const u = new URL(url)
    if (!['http:', 'https:', 'rtmp:', 'rtsp:'].includes(u.protocol)) return false
    return true
  } catch {
    return false
  }
}

// ââ Persistance en base (upsert) ââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * InsÃ¨re ou met Ã  jour un lot d'entrÃ©es parsÃ©es dans MongoDB.
 * L'URL est la clÃ© unique : on ne duplique pas si elle existe dÃ©jÃ .
 * @param {Array} entries  EntrÃ©es issues du parser M3U
 * @returns {{ inserted: number, updated: number }}
 */
async function saveEntries (entries) {
  if (!entries.length) return { inserted: 0, updated: 0 }

  const ops = entries.map(e => ({
    updateOne: {
      filter: { url: e.url },
      update: {
        $setOnInsert: {
          url:          e.url,
          status:       'pending',
          checkCount:   0,
          successCount: 0,
          uptime:       0,
          urlHistory:   [],
          checkHistory: [],
          createdAt:    new Date(),
        },
        $set: {
          name:         e.name,
          logo:         e.logo,
          source:       e.source,
          sourceUrl:    e.sourceUrl,
          playlistFile: e.playlistFile,
          tvgId:        e.tvgId,
          tvgName:      e.tvgName,
          groupTitle:   e.groupTitle,
          country:      e.country,
          language:     e.language,
          updatedAt:    new Date(),
        },
      },
      upsert: true,
    },
  }))

  const result = await DiscoveredStream.bulkWrite(ops, { ordered: false })
  return {
    inserted: result.upsertedCount || 0,
    updated:  result.modifiedCount || 0,
  }
}

// ââ Point d'entrÃ©e principal ââââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * Lance un cycle complet de dÃ©couverte.
 * @returns {Object} Statistiques { reposScanned, filesFound, streamsInserted, streamsUpdated }
 */
async function discover () {
  console.log('\nð­ [SourceDiscovery] DÃ©marrage du cycle de dÃ©couverte...')
  const start = Date.now()

  let reposScanned    = 0
  let filesFound      = 0
  let streamsInserted = 0
  let streamsUpdated  = 0

  // DÃ©-duplication des dÃ©pÃ´ts trouvÃ©s sur plusieurs mots-clÃ©s
  const seenRepos = new Set()
  const repos     = []

  for (const keyword of SEARCH_KEYWORDS) {
    const found = await searchGitHubRepos(keyword)
    for (const repo of found) {
      if (!seenRepos.has(repo.full_name)) {
        seenRepos.add(repo.full_name)
        repos.push(repo)
      }
    }
    if (repos.length >= MAX_REPOS) break
    await sleep(1000)   // Respect du rate-limit GitHub
  }

  console.log(`  ð¦ ${repos.length} dÃ©pÃ´ts uniques trouvÃ©s`)

  // Traitement sÃ©quentiel des dÃ©pÃ´ts (Ã©vite le rate-limit)
  for (const repo of repos.slice(0, MAX_REPOS)) {
    console.log(`  ð Scan : ${repo.full_name} (â­ ${repo.stargazers_count})`)
    reposScanned++

    const files = await findM3UFilesInRepo(repo)
    await sleep(800)

    for (const file of files.slice(0, MAX_FILES)) {
      try {
        console.log(`    ð Parsing : ${file.path}`)
        const content = await fetchRawContent(file.rawUrl)
        const entries = parseM3U(
          content,
          `GitHub - ${repo.full_name}`,
          `https://github.com/${repo.full_name}`,
          file.name
        )

        if (entries.length > 0) {
          filesFound++
          const { inserted, updated } = await saveEntries(entries)
          streamsInserted += inserted
          streamsUpdated  += updated
          console.log(`      â ${entries.length} flux extraits (+${inserted} nouveaux, ~${updated} mis Ã  jour)`)
        } else {
          console.log(`      â ï¸  Aucun flux valide dans ce fichier`)
        }
        await sleep(500)
      } catch (err) {
        console.warn(`      â Erreur sur ${file.path}: ${err.message}`)
      }
    }
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\nâ [SourceDiscovery] TerminÃ© en ${duration}s`)
  console.log(`   Repos : ${reposScanned} | Fichiers : ${filesFound} | Nouveaux flux : ${streamsInserted} | MÃ J : ${streamsUpdated}\n`)

  return { reposScanned, filesFound, streamsInserted, streamsUpdated, duration }
}

// ââ Utilitaire ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

module.exports = { discover, parseM3U, saveEntries }
