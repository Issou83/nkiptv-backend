/**
 * NKiptv — Seed des chaînes françaises avec flux directs vérifiés
 * ────────────────────────────────────────────────────────────────────────────
 * v2.1 — Ajoute source_origin, fallbackUrls et nouvelles chaînes
 *
 * source_origin types :
 *  - "cdn-public"       : CDN officiel/public, très stable
 *  - "custom-web-player": URL extraite d'un lecteur web, token dynamique possible
 *  - "github-community" : Listes communautaires iptv-org, fiabilité variable
 *  - "direct-ip"        : Flux direct via IP, peut changer
 *  - "xtream-codes"     : Serveur Xtream Codes, nécessite identifiants
 * ────────────────────────────────────────────────────────────────────────────
 */
'use strict'

const Channel = require('../models/Channel')

const FRENCH_CHANNELS = [

  // BFM TV
  { id: 'BFMTV.fr', name: 'BFM TV', categories: ['news'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/2/21/BFM_TV_logo.png/800px-BFM_TV_logo.png',
    website: 'https://www.bfmtv.com',
    streams: [{ url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_TV/index.m3u8?start=LIVE&end=END',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public',
      fallbackUrls: ['https://bfm.trissell.com.cdn.anycast.me/bfmtv/index.m3u8',
                     'https://stream.bfmtv.com/bfmtv/ngrp:bfmtv_all/playlist.m3u8'] }] },

  // BFM Business
  { id: 'BFMBusiness.fr', name: 'BFM Business', categories: ['business'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/0/05/BFM_Business_logo.png/800px-BFM_Business_logo.png',
    website: 'https://bfmbusiness.bfmtv.com',
    streams: [{ url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_BUSINESS/index.m3u8?start=LIVE&end=END',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public', fallbackUrls: [] }] },

  // BFM Lyon
  { id: 'BFMLyon.fr', name: 'BFM Lyon', categories: ['news', 'regional'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/1/19/BFM_Lyon_logo.png/800px-BFM_Lyon_logo.png',
    website: 'https://www.bfmtv.com/lyon',
    streams: [{ url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_LYON/index.m3u8?start=LIVE&end=END',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public', fallbackUrls: [] }] },

  // France 24
  { id: 'France24.fr', name: 'France 24', categories: ['news'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/France_24_logo.svg/800px-France_24_logo.svg.png',
    website: 'https://www.france24.com/fr',
    streams: [{ url: 'https://d4de59d01af447a498cb0565ad005588.mediatailor.us-east-1.amazonaws.com/v1/master/a7a040eb1d37fbd6629d46ca527f8672e0484f99/Production/tv5/france24fr.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public',
      fallbackUrls: ['https://static.france24.com/live/F24_FR_LO_HLS/live_web.m3u8',
                     'https://f24hls-i.akamaihd.net/hls/live/221147/F24_FR_LO_HLS/master.m3u8'] }] },

  // TV5MONDE
  { id: 'TV5MONDE.fr', name: 'TV5MONDE', categories: ['general'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/TV5MONDE_logo.svg/800px-TV5MONDE_logo.svg.png',
    website: 'https://www.tv5monde.com',
    streams: [{ url: 'https://ott.tv5monde.com/Content/HLS/Live/channel(europe)/index.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public',
      fallbackUrls: ['https://ott2.tv5monde.com/hls/live/2022588/tv5monde/index.m3u8'] }] },

  // LCI
  { id: 'LCI.fr', name: 'LCI', categories: ['news'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/3/38/Logo_LCI_2017.png/800px-Logo_LCI_2017.png',
    website: 'https://www.lci.fr',
    streams: [{ url: 'https://lci-hls-secure.tf1.fr/lci/lci_hls_hi/index.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'custom-web-player',
      fallbackUrls: ['https://edge98.vedge.infomaniak.com/lancer/ck/lci/manifest/playlist.m3u8'] }] },

  // Arte
  { id: 'Arte.fr', name: 'Arte', categories: ['culture', 'general'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Arte_Logo_2011.png/800px-Arte_Logo_2011.png',
    website: 'https://www.arte.tv',
    streams: [{ url: 'https://artesimulcast.akamaized.net/hls/live/2031003/artelive_fr/index.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public',
      fallbackUrls: ['https://artelive-lh.akamaihd.net/i/artelive_fr@393591/master.m3u8'] }] },

  // Euronews FR
  { id: 'Euronews.fr', name: 'Euronews FR', categories: ['news'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Euronews_2022.svg/800px-Euronews_2022.svg.png',
    website: 'https://fr.euronews.com',
    streams: [{ url: 'https://rakuten-euronews-1-fr.samsung.wurl.tv/manifest/playlist.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public',
      fallbackUrls: ['https://str30.creacast.com/euronewsfr.smil/playlist.m3u8'] }] },

  // CGTN French
  { id: 'CGTN.fr', name: 'CGTN French', categories: ['news'], languages: ['fra'], country: 'CN',
    logo: 'https://news.cgtn.com/favicon.ico', website: 'https://news.cgtn.com',
    streams: [{ url: 'https://news.cgtn.com/resource/live/french/cgtn-f.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public', fallbackUrls: [] }] },

  // MCE TV
  { id: 'MCE.fr', name: 'MCE TV', categories: ['entertainment'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/7/7c/Logo_MCE_TV.png/800px-Logo_MCE_TV.png',
    website: 'https://www.mce.fr',
    streams: [{ url: 'https://diffusion.mce.fr/live/mce/index.m3u8',
      quality: 'SD', status: 'unknown', source_origin: 'cdn-public', fallbackUrls: [] }] },

  // TF1
  { id: 'TF1.fr', name: 'TF1', categories: ['general'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/7/7e/Logo_TF1_2013.png/800px-Logo_TF1_2013.png',
    website: 'https://www.tf1.fr',
    streams: [{ url: 'https://tf1.m3u8.tv/tf1.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'github-community',
      fallbackUrls: ['https://livestream.tf1.fr/tf1/live/playlist.m3u8',
                     'https://edge98.vedge.infomaniak.com/lancer/ck/tf1/manifest/playlist.m3u8'] }] },

  // France 2
  { id: 'France2.fr', name: 'France 2', categories: ['general'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/3/3b/France_2_-_logo_2018.png/800px-France_2_-_logo_2018.png',
    website: 'https://www.france.tv',
    streams: [{ url: 'https://edge98.vedge.infomaniak.com/lancer/ck/france2/manifest/playlist.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'github-community',
      fallbackUrls: ['https://stream.france.tv/hls/france2/index.m3u8'] }] },

  // M6
  { id: 'M6.fr', name: 'M6', categories: ['general'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/a/a5/M6_-_Logo_2009_%28France%29.png/800px-M6_-_Logo_2009_%28France%29.png',
    website: 'https://www.m6.fr',
    streams: [{ url: 'https://edge98.vedge.infomaniak.com/lancer/ck/m6/manifest/playlist.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'github-community', fallbackUrls: [] }] },

  // C8 — licence définitivement révoquée par l'ARCOM en mars 2025
  { id: 'C8.fr', name: 'C8', categories: ['general'], languages: ['fra'], country: 'FR',
    isActive: false,
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/f/f5/C8_Logo.png/800px-C8_Logo.png',
    website: 'https://www.c8.fr',
    streams: [] },

  // TMC
  { id: 'TMC.fr', name: 'TMC', categories: ['general'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/2/20/Logo_TMC_2012.png/800px-Logo_TMC_2012.png',
    website: 'https://www.tmc.tv',
    streams: [{ url: 'https://edge98.vedge.infomaniak.com/lancer/ck/tmc/manifest/playlist.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'github-community', fallbackUrls: [] }] },

  // CNews
  { id: 'CNews.fr', name: 'CNews', categories: ['news'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/8/8d/Logo_CNews.png/800px-Logo_CNews.png',
    website: 'https://www.cnews.fr',
    streams: [{ url: 'https://edge98.vedge.infomaniak.com/lancer/ck/cnews/manifest/playlist.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'github-community', fallbackUrls: [] }] },

  // franceinfo:
  { id: 'FranceInfoTV.fr', name: 'franceinfo:', categories: ['news'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/3/38/France_info_2016_logo.png/800px-France_info_2016_logo.png',
    website: 'https://www.francetvinfo.fr',
    streams: [{ url: 'https://stream-france-info.francetvinfo.fr/france-info/france-info.isml/france-info-audio%3D192000-video%3D2299967.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public',
      fallbackUrls: ['https://edge98.vedge.infomaniak.com/lancer/ck/francetv-info/manifest/playlist.m3u8'] }] },

  // BFM Grand Paris
  { id: 'BFMGrandParis.fr', name: 'BFM Grand Paris', categories: ['news', 'regional'], languages: ['fra'], country: 'FR',
    logo: 'https://upload.wikimedia.org/wikipedia/fr/thumb/8/81/BFM_Grand_Paris_logo.png/800px-BFM_Grand_Paris_logo.png',
    website: 'https://www.bfmtv.com/grandparis',
    streams: [{ url: 'https://ncdn-live-bfm.pfd.sfr.net/shls/LIVE$BFM_GRANDPARIS/index.m3u8?start=LIVE&end=END',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public', fallbackUrls: [] }] },

  // RT France
  { id: 'RTFrance.fr', name: 'RT France', categories: ['news'], languages: ['fra'], country: 'FR',
    logo: 'https://fr.rt.com/favicon.ico', website: 'https://fr.rt.com',
    streams: [{ url: 'https://rt-france.rttv.com/live/rtfrance/playlist.m3u8',
      quality: 'HD', status: 'unknown', source_origin: 'cdn-public',
      fallbackUrls: ['https://stream.rt.com/hls/rtfr.m3u8'] }] },
]

async function seedFrenchChannels () {
  console.log('🌱 [Seed] Insertion des chaînes françaises v2.1...')
  let inserted = 0, updated = 0

  const ops = FRENCH_CHANNELS.map(ch => ({
    updateOne: {
      filter: { id: ch.id },
      update: {
        $setOnInsert: { viewCount: 0, favoriteCount: 0, rating: 0, ratingCount: 0, source: 'manual', lastSyncedAt: new Date() },
        $set: { name: ch.name, country: ch.country, languages: ch.languages || [],
          categories: ch.categories || [], logo: ch.logo || '', website: ch.website || '',
          streams: ch.streams || [], hasStream: (ch.streams || []).length > 0,
          isActive: ch.isActive !== undefined ? ch.isActive : true },
      },
      upsert: true,
    },
  }))

  try {
    const result = await Channel.bulkWrite(ops, { ordered: false })
    inserted = result.upsertedCount || 0
    updated  = result.modifiedCount || 0
    console.log('✅ [Seed] ' + inserted + ' chaînes insérées, ' + updated + ' mises à jour')
  } catch (err) {
    console.error('❌ [Seed] Erreur:', err.message)
  }
  return { inserted, updated }
}

async function seedIfNeeded () {
  const ids = FRENCH_CHANNELS.map(c => c.id)
  const withStream = await Channel.countDocuments({ id: { $in: ids }, hasStream: true })
  if (withStream < ids.length / 2) {
    await seedFrenchChannels()
  } else {
    console.log('🌱 [Seed] ' + withStream + '/' + ids.length + ' chaînes FR déjà en base — skip')
  }
}

module.exports = { seedFrenchChannels, seedIfNeeded, FRENCH_CHANNELS }
