/**
 * Script de migration : met à jour les streams HLS des chaînes dans MongoDB.
 *
 * Usage : node scripts/update-streams.js
 */
require('dotenv').config()
const mongoose = require('mongoose')
const Channel = require('../models/Channel')

const updates = [
  { name: /tf1/i,                          stream: 'https://viamotionhsi.netplus.ch/live/eds/tf1hd/browser-HLS8/tf1hd.m3u8' },
  { name: /\blci\b/i,                      stream: 'https://viamotionhsi.netplus.ch/live/eds/lci/browser-HLS8/lci.m3u8' },
  { name: /c\s?star/i,                     stream: 'https://viamotionhsi.netplus.ch/live/eds/d17/browser-HLS8/d17.m3u8' },
  { name: /animaux/i,                      stream: 'https://viamotionhsi.netplus.ch/live/eds/animaux/browser-HLS8/animaux.m3u8' },
  { name: /\bkto\b/i,                      stream: 'https://viamotionhsi.netplus.ch/live/eds/kto/browser-HLS8/kto.m3u8' },
  { name: /\bab1\b/i,                      stream: 'https://viamotionhsi.netplus.ch/live/eds/ab1/browser-HLS8/ab1.m3u8' },
  { name: /gulli/i,                        stream: 'https://lbcdn.6cloud.fr/resource/m6web/l/gulli_hls_sd_short_q2hyb21h.m3u8?groups[]=m6web-live-gulli_ext' },
  { name: /bfm\s*(tv\s*)?lyon/i,           stream: 'https://live-cdn-bfmtvlyo-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?marseille/i,      stream: 'https://live-cdn-bfmtvmar-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?(grand\s*)?lill?e/i, stream: 'https://live-cdn-bfmtvlil-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?alsace/i,         stream: 'https://live-cdn-bfmtvals-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /bfm\s*(tv\s*)?normandie/i,      stream: 'https://live-cdn-bfmtvnor-euw1.bfmtv.bct.nextradiotv.com/master.m3u8' },
  { name: /france\s*info/i,                stream: 'https://viamotionhsi.netplus.ch/live/eds/franceinfo/browser-HLS8/franceinfo.m3u8' },
]

async function run() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('✅ MongoDB connecté')

  let updated = 0
  let notFound = 0

  for (const { name: regex, stream } of updates) {
    const channel = await Channel.findOne({ name: regex })
    if (!channel) {
      console.log(`  ⚠️  Aucun channel trouvé pour: ${regex}`)
      notFound++
      continue
    }

    const existing = channel.streams || []
    if (existing.length > 0) {
      // Remplacer streams[0].url en conservant les autres champs
      const oldUrl = existing[0].url
      existing[0].url = stream
      existing[0].status = 'unknown'
      existing[0].healedAt = new Date()
      existing[0].healedFrom = oldUrl
    } else {
      existing.push({ url: stream, quality: 'unknown', status: 'unknown', source_origin: 'cdn-public' })
    }

    channel.streams = existing
    channel.bestStreamUrl = stream
    channel.hasStream = true
    await channel.save()
    console.log(`  ✅ ${channel.name} (${channel.id}) → ${stream.slice(0, 70)}...`)
    updated++
  }

  console.log(`\n📊 Résultat : ${updated} mis à jour, ${notFound} non trouvé(s)`)
  await mongoose.disconnect()
  console.log('✅ Terminé')
}

run().catch(err => {
  console.error('Erreur:', err)
  process.exit(1)
})
