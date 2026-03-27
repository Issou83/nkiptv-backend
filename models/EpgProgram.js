const mongoose = require('mongoose')

const EpgProgramSchema = new mongoose.Schema({
  channelId: { type: String, required: true, index: true },
  epgId: { type: String, index: true },
  title: { type: String, required: true },
  description: String,
  category: String,
  language: { type: String, default: 'fr' },
  start: { type: Date, required: true, index: true },
  stop: { type: Date, required: true, index: true },
  icon: String,
  rating: String,
  episode: {
    season: Number,
    episode: Number,
    part: Number,
  },
  isLive: { type: Boolean, default: false },
}, { timestamps: false })

EpgProgramSchema.index({ channelId: 1, start: 1, stop: 1 })
EpgProgramSchema.index({ start: 1, stop: 1 })

module.exports = mongoose.model('EpgProgram', EpgProgramSchema)
