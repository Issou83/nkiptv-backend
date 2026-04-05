const mongoose = require('mongoose')

let isConnected = false

const connectDB = async () => {
  if (isConnected) return

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    })
    isConnected = true
    console.log(`✅ MongoDB connecté : ${conn.connection.host}`)
  } catch (err) {
    console.error('❌ MongoDB connexion échouée :', err.message)
    process.exit(1)
  }
}

mongoose.connection.on('disconnected', () => {
  isConnected = false
  console.warn('⚠️  MongoDB déconnecté')
})

mongoose.connection.on('reconnected', () => {
  isConnected = true
  console.log('✅ MongoDB reconnecté')
})

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB erreur :', err.message)
})

module.exports = connectDB
