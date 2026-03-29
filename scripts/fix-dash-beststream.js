/**
 * Script de migration : corrige bestStreamUrl des chaînes qui pointent vers DASH (.mpd)
 * alors qu'une alternative HLS (.m3u8) existe dans leurs streams.
 *
 * Usage : node scripts/fix-dash-beststream.js
 */
require('dotenv').config()
const mongoose = require('mongoose')
const Channel = require('../models/Channel')

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('✅ MongoDB connecté')

  // Cherche toutes les chaînes avec bestStreamUrl DASH
  const channels = await Channel.find({
    bestStreamUrl: { $regex: /\.mpd$/i },
  })

  console.log(`📋 ${channels.length} chaîne(s) avec bestStreamUrl DASH trouvée(s)`)

  let fixed = 0
  let noAlt = 0

  for (const ch of channels) {
    const hlsStream = (ch.streams || []).find(s => s.url && s.url.includes('.m3u8'))
    if (hlsStream) {
      console.log(`  ✅ ${ch.name} (${ch.id}) : ${ch.bestStreamUrl.slice(0,50)}... → ${hlsStream.url.slice(0,50)}...`)
      ch.bestStreamUrl = hlsStream.url
      const base = process.env.BACKEND_URL || 'https://nkiptv-backend-production.up.railway.app'
      ch.proxyUrl = `${base}/api/proxy/stream?url=${encodeURIComponent(hlsStream.url)}`
      await ch.save()
      fixed++
    } else {
      console.log(`  ⚠️  ${ch.name} (${ch.id}) : pas d'alternative HLS — DASH uniquement`)
      noAlt++
    }
  }

  console.log(`\n📊 Résultat : ${fixed} corrigé(s), ${noAlt} sans alternative HLS`)
  await mongoose.disconnect()
  console.log('✅ Terminé')
}

fix().catch(err => {
  console.error('Erreur:', err)
  process.exit(1)
})
