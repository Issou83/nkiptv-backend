/**
 * NKiptv — Modèle DiscoveredStream
 * Représente un flux découvert automatiquement depuis des sources externes (GitHub M3U, etc.)
 * Distinct du modèle Channel (iptv-org) : ici on suit l'histoire complète de chaque URL.
 */
const mongoose = require('mongoose')

const UrlHistorySchema = new mongoose.Schema({
  url:       { type: String, required: true },
  replacedAt: { type: Date, default: Date.now },
  reason:    { type: String, enum: ['inactive', 'error', 'manual'], default: 'inactive' },
}, { _id: false })

const CheckHistorySchema = new mongoose.Schema({
  checkedAt:    { type: Date, default: Date.now },
  status:       { type: String, enum: ['active', 'inactive', 'error', 'checking'], required: true },
  responseTime: { type: Number },
  httpStatus:   { type: Number },
  errorMessage: { type: String },
}, { _id: false })

const TechInfoSchema = new mongoose.Schema({
  codec:      { type: String },
  resolution: { type: String },
  bitrate:    { type: Number },
  fps:        { type: Number },
  format:     { type: String },
  audioCodec: { type: String },
  probeError: { type: String },
}, { _id: false })

const DiscoveredStreamSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  url:          { type: String, required: true },
  logo:         { type: String, default: null },
  source:       { type: String, required: true },
  sourceUrl:    { type: String },
  playlistFile: { type: String },
  groupTitle:   { type: String },
  tvgId:        { type: String },
  tvgName:      { type: String },
  tvgLogo:      { type: String },
  country:      { type: String },
  language:     { type: String },
  status: {
    type: String,
    enum: ['pending', 'active', 'inactive', 'error', 'checking', 'replaced'],
    default: 'pending',
    index: true,
  },
  techInfo:     { type: TechInfoSchema, default: null },
  lastChecked:  { type: Date, default: null, index: true },
  responseTime: { type: Number, default: null },
  uptime:       { type: Number, default: 0 },
  checkCount:   { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  checkHistory: { type: [CheckHistorySchema], default: [], validate: v => v.length <= 20 },
  replacedBy:   { type: String, default: null },
  urlHistory:   { type: [UrlHistorySchema], default: [] },
}, { timestamps: true })

DiscoveredStreamSchema.index({ url: 1 }, { unique: true })
DiscoveredStreamSchema.index({ name: 'text', tvgName: 'text', groupTitle: 'text' })
DiscoveredStreamSchema.index({ status: 1, lastChecked: 1 })
DiscoveredStreamSchema.index({ source: 1 })
DiscoveredStreamSchema.index({ groupTitle: 1, status: 1 })

DiscoveredStreamSchema.methods.updateUptime = function () {
  if (this.checkCount === 0) { this.uptime = 0; return }
  this.uptime = Math.round((this.successCount / this.checkCount) * 100)
}

DiscoveredStreamSchema.methods.addCheckEntry = function (entry) {
  this.checkHistory.unshift(entry)
  if (this.checkHistory.length > 20) this.checkHistory.pop()
}

module.exports = mongoose.model('DiscoveredStream', DiscoveredStreamSchema)
