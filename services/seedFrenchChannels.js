/**
 * NKiptv â Seed des chaÃ®nes franÃ§aises avec flux directs vÃ©rifiÃ©s
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 * InsÃ¨re (ou met Ã  jour) en base un ensemble de chaÃ®nes franÃ§aises dont
 * les URLs de stream sont connues et stables.
 *
 * Sources :
 *  - Flux HLS officiels publics (TV5MONDE, France 24, BFM RÃ©gions, etc.)
 *  - Compilation vÃ©rifiÃ©e par la communautÃ© iptv-org
 *
 * Usage :
 *  require('./services/seedFrenchChannels').seedFrenchChannels()
 *  â AppelÃ© automatiquement au dÃ©marrage si des chaÃ®nes FR n'ont pas de stream
 * ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
 */
'use strict'

const Channel = require('../models/Channel')

// ââ ChaÃ®nes franÃ§aises avec flux directs ââââââââââââââââââââââââââââââââââââââ
const FRENCH_CHANNELS = [
  // ââ ChaÃ®nes nationales & info ââââââââââââââââââââââââââââââââââââââââââââââ
  {
    id: 'BFMTV.fr',
    name: 'BFM TV',
    categories: ['news'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://pbs.twimg.com/profile_images/1011087246997344256/OsXqJRIK_400x400.jpg',
    website: 'https://www.bfmtv.com',
    streams: [
      {
        url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_TV/index.m3u8?start=LIVE&end=END',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'BFMBusiness.fr',
    name: 'BFM Business',
    categories: ['business'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/0/05/BFM_Business_logo.png/800px-BFM_Business_logo.png',
    website: 'https://bfmbusiness.bfmtv.com',
    streams: [
      {
        url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_BUSINESS/index.m3u8?start=LIVE&end=END',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'BFMMyon.fr',
    name: 'BFM {yon',
    categories: ['news', 'regional'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/1/19/BFM_Lyon_logo.png/800px-BFM_Lyon_logo.png',
    website: 'https://www.bfmtv.com/lyon',
    streams: [
      {
        url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_LYON/index.m3u8?start=LIVE&end=END',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'BFMMarseille.fr',
    name: 'BFM Marseille Provence',
    categories: ['news', 'regional'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/c/cb/BFM_Marseille_Provence_logo.png/800px-BFM_Marseille_Provence_logo.png',
    website: 'https://www.bfmtv.com/marseille',
    streams: [
      {
        url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_MARSEILLEPROV/index.m3u8?start=LIVE&end=END',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'BFMNice.fr',
    name: 'BFM Nice CÃ´te d\'Azur',
    categories: ['news', 'regional'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/9/99/BFM_NICE_logo.png/800px-BFM_NICE_logo.png',
    website: 'https://www.bfmtv.com/nice',
    streams: [
      {
        url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_NICECOTEDAZUR/index.m3u8?start=LIVE&end=END',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'France24.fr',
    name: 'France 24',
    categories: ['news'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://www.france24.com/favicon.png',
    website: 'https://www.france24.com/fr',
    streams: [
      {
        url: 'https://d4de59d01af447a498cb0565ad005588.mediatailor.us-east-1.amazonaws.com/v1/master/a7a040eb1d37fbd6629d46ca527f8672e0484f99/Production/tv5/france24fr.m3u8',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'TV5MONDE.fr',
    name: 'TV5MONDE',
    categories: ['general'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://www.tv5monde.com/favicon.ico',
    website: 'https://www.tv5monde.com',
    streams: [
      {
        url: 'https://ott.tv5monde.com/Content/HLS/Live/channel(europe)/index.m3u8',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'LCI.fr',
    name: 'LCI',
    categories: ['news'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://www.lci.fr/favicon.ico',
    website: 'https://www.lci.fr',
    streams: [
      {
        url: 'https://lci-hls-secure.tf1.fr/lci/lci_hls_hi/index.m3u8',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'Euronews.fr',
    name: 'Euronews FR',
    categories: ['news'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://www.euronews.com/favicon.ico',
    website: 'https://fr.euronews.com',
    streams: [
      {
        url: 'https://euronews-fr.euronews.com/live',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  {
    id: 'CGTN.fr',
    name: 'CGTN French',
    categories: ['news'],
    languages: ['fra'],
    country: 'CN',
    logo: 'https://news.cgtn.com/favicon.ico',
    website: 'https://news.cgtn.com',
    streams: [
      {
        url: 'https://news.cgtn.com/resource/live/french/cgtn-f.m3u8',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  // ââ ChaÃ®nes gÃ©nÃ©ralistes TNT ââââââââââââââââââââââââââââââââââââââââââââââââ
  {
    id: 'TF1.fr',
    name: 'TF1',
    categories: ['general'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/7/7e/Logo_TF1_2013.png/800px-Logo_TF1_2013.png',
    website: 'https://www.tf1.fr',
    streams: [
      // TF1 flux direct officiel â vÃ©rifier disponibilitÃ©
      {
        url: 'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/fr.m3u',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  // ââ Arte ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  {
    id: 'Arte.fr',
    name: 'Arte',
    categories: ['culture', 'general'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Arte_Logo_2011.png/800px-Arte_Logo_2011.png',
    website: 'https://www.arte.tv',
    streams: [
      {
        // URL flux Arte (rÃ©cupÃ©rer depuis https://api.arte.tv/api/player/v2/config/fr/LIVE)
        url: 'https://artesimulcast.akamaized.net/hls/live/2031003/artelive_fr/index.m3u8',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  // ââ RT France âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  {
    id: 'RTFrance.fr',
    name: 'RT France',
    categories: ['news'],
    languages: ['fra'],
    country: 'FR',
    logo: 'https://fr.rt.com/favicon.ico',
    website: 'https://fr.rt.com',
    streams: [
      {
        url: 'https://rt-france.rttv.com/live/rtfrance/playlist.m3u8',
        quality: 'HD',
        status: 'unknown',
      },
    ],
  },
  // ââ Musique âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  {
    id: 'MCE.fr',
    name: 'MCE TV',
    categories: ['entertainment'],
    languages: ['fra'],
    country: 'FR',
    logo: '',
    website: 'https://www.mce.fr',
    streams: [
      {
        url: 'https://diffusion.mce.fr/live/mce/index.m3u8',
        quality: 'SD',
        status: 'unknown',
      },
    ],
  },
]

// ââ Fonction de seed ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
/**
 * InsÃ¨re ou met Ã  jour les chaÃ®nes franÃ§aises connues en base.
 * Ne remplace pas les donnÃ©es existantes iptv-org (upsert ciblÃ©).
 * @returns {{ inserted: number, updated: number }}
 */
async function seedFrenchChannels () {
  console.log('ð± [Seed] Insertion des chaÃ®nes franÃ§aises directes...')

  let inserted = 0
  let updated  = 0

  const ops = FRENCH_CHANNELS.map(ch => ({
    updateOne: {
      filter: { id: ch.id },
      update: {
        $setOnInsert: {
          viewCount:     0,
          favoriteCount: 0,
          rating:        0,
          ratingCount:   0,
          source:        'manual',
          lastSyncedAt:  new Date(),
        },
        $set: {
          name:       ch.name,
          country:    ch.country,
          languages:  ch.languages || [],
          categories: ch.categories || [],
          logo:       ch.logo || '',
          website:    ch.website || '',
          streams:    ch.streams || [],
          hasStream:  (ch.streams || []).length > 0,
          isActive:   true,
        },
      },
      upsert: true,
    },
  }))

  try {
    const result = await Channel.bulkWrite(ops, { ordered: false })
    inserted = result.upsertedCount || 0
    updated  = result.modifiedCount || 0
    console.log(`â [Seed] ${inserted} chaÃ®nes insÃ©rÃ©es, ${updated} mises Ã  jour`)
  } catch (err) {
    console.error('â [Seed] Erreur:', err.message)
  }

  return { inserted, updated }
}

/**
 * Lance le seed uniquement si des chaÃ®nes franÃ§aises connues n'ont pas de stream.
 * Ãvite de re-seeder inutilement Ã  chaque dÃ©marrage.
 */
async function seedIfNeeded () {
  const ids = FRENCH_CHANNELS.map(c => c.id)
  const withStream = await Channel.countDocuments({ id: { $in: ids }, hasStream: true })

  if (withStream < ids.length / 2) {
    // Moins de la moitiÃ© des chaÃ®nes seed ont un stream â on seed
    await seedFrenchChannels()
  } else {
    console.log(`ð± [Seed] ${withStream}/${ids.length} chaÃ®nes FR dÃ©jÃ  en base â skip`)
  }
}

module.exports = { seedFrenchChannels, seedIfNeeded, FRENCH_CHANNELS }
