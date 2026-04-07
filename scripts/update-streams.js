/**
 * Script de migration : met à jour les streams des chaînes françaises
 * DASH cassés → HLS vérifiés (viamotionhsi / nextradiotv / 6cloud)
 *
 * Usage : node scripts/update-streams.js
 *
 * Note : France 2/3/4/5 sont gérées par franceTvService (tokens dynamiques)
 *        et ne figurent PAS dans ce script.
 */
'use strict'

const path = require('path')

// Cherche le .env dans le répertoire courant, puis les parents (utile en worktree)
require('dotenv').config()
if (!process.env.MONGODB_URI) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') })
}
if (!process.env.MONGODB_URI) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') })
}

const mongoose = require('mongoose')
const Channel = require('../models/Channel')

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI manquante. Créez un fichier .env ou exportez la variable.')
  process.exit(1)
}

const updates = [
  // ── TF1 groupe (DASH → HLS via viamotionhsi) ─────────────────────────────
  { name: /^tf1$/i,       stream: 'https://viamotionhsi.netplus.ch/live/eds/tf1hd/browser-HLS8/tf1hd.m3u8' },
  { name: /\blci\b/i,     stream: 'https://viamotionhsi.netplus.ch/live/eds/lci/browser-HLS8/lci.m3u8' },
  { name: /c\s?star/i,    stream: 'https://viamotionhsi.netplus.ch/live/eds/d17/browser-HLS8/d17.m3u8' },
  { name: /animaux/i,     stream: 'https://viamotionhsi.netplus.ch/live/eds/animaux/browser-HLS8/animaux.m3u8' },
  { name: /\bkto\b/i,     stream: 'https://viamotionhsi.netplus.ch/live/eds/kto/browser-HLS8/kto.m3u8' },
  { name: /\bab1\b/i,     stream: 'https://viamotionhsi.netplus.ch/live/eds/ab1/browser-HLS8/ab1.m3u8' },

  // ── Gulli (6cloud CDN) ────────────────────────────────────────────────────
  { name: /gulli/i, stream: 'https://lbcdn.6cloud.fr/resource/m6web/l/gulli_hls_sd_short_q2hyb21h.m3u8?groups[]=m6web-live-gulli_ext' },

  // ── BFM régionales (SFR CDN cassé → nextradiotv) ─────────────────────────
  { name: /bfm\s*(tv\s*)?lyon/i,             stream: 'https://live-cdn-bfmtvlyo-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?marseille/i,        stream: 'https://live-cdn-bfmtvmar-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?(grand\s*)?lill?e/i, stream: 'https://live-cdn-bfmtvlil-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?alsace/i,           stream: 'https://live-cdn-bfmtvals-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?normandie/i,        stream: 'https://live-cdn-bfmtvnor-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },

  // ── franceinfo: TV (stream francetvinfo.fr bloqué → viamotionhsi) ─────────
  { name: /france\s*info/i, stream: 'https://viamotionhsi.netplus.ch/live/eds/franceinfo/browser-HLS8/franceinfo.m3u8' },
]

async function run() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('✅ MongoDB connecté\n')

  let found = 0, updated = 0, notFound = 0

  for (const { name: nameRegex, stream } of updates) {
    const channel = await Channel.findOne({ name: nameRegex })

    if (!channel) {
      console.log(`  ⚠️  Non trouvé : ${nameRegex}`)
      notFound++
      continue
    }

    found++
    const prevUrl = channel.streams?.[0]?.url || '(aucun stream)'

    if (!channel.streams || channel.streams.length === 0) {
      channel.streams = [{ url: stream, quality: 'HD', status: 'unknown', source_origin: 'cdn-public' }]
    } else {
      channel.streams[0].url = stream
      channel.streams[0].status = 'unknown'
      channel.streams[0].source_origin = 'cdn-public'
    }

    channel.bestStreamUrl = stream
    channel.hasStream = true
    channel.markModified('streams')

    await channel.save()
    console.log(`  ✅ ${channel.name} (${channel.id})`)
    console.log(`       avant : ${prevUrl.slice(0, 80)}`)
    console.log(`       après : ${stream.slice(0, 80)}\n`)
    updated++
  }

  console.log(`\n📊 Résultat : ${found} trouvée(s), ${updated} mise(s) à jour, ${notFound} non trouvée(s)`)
  await mongoose.disconnect()
  console.log('✅ Terminé')
}

run().catch(err => {
  console.error('❌ Erreur:', err.message)
  process.exit(1)
})
