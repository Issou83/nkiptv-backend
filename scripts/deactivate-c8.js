/**
 * One-off script: mark C8 as inactive (license revoked by ARCOM, March 2025).
 * Usage: node scripts/deactivate-c8.js
 */
require('dotenv').config()
const mongoose = require('mongoose')
const Channel = require('../models/Channel')

async function run() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('✅ MongoDB connecté')

  const result = await Channel.updateMany(
    { name: { $regex: /\bc8\b/i } },
    { $set: { isActive: false } }
  )

  console.log(`📺 C8 désactivée : ${result.modifiedCount} document(s) mis à jour`)
  await mongoose.disconnect()
  console.log('✅ Terminé')
}

run().catch(err => {
  console.error('Erreur:', err)
  process.exit(1)
})
