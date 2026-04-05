const mongoose = require('mongoose')

const StreamSchema = new mongoose.Schema({
  url: { type: String, required: true },
  quality: { type: String, default: 'unknown' }, // SD, HD, FHD, 4K
  status: {
    type: String,
    enum: ['online', 'offline', 'checking', 'unknown', 'active', 'inactive', 'error'],
    default: 'unknown',
  },
  // Type de source — détermine la stratégie de guérison (StreamHealer)
  source_origin: {
    type: String,
    enum: ['cdn-public', 'custom-web-player', 'github-community', 'direct-ip', 'xtream-codes', 'rtmp', 'unknown'],
    default: 'unknown',
  },
  fallbackUrls: [String],   // URLs alternatives si la principale tombe
  httpReferrer: String,
  userAgent: String,
  lastCheck: Date,
  responseTime: Number,  // ms
  // Métadonnées de guérison (remplis par StreamHealer)
  healedAt:   Date,
  healedFrom: String,    // ancienne URL avant guérison
  strategy:   String,    // stratégie utilisée
}, { _id: false })

const ChannelSchema = new mongoose.Schema({
  // ── Identifiants ──────────────────────────────────────────────────────────
  id: { type: String, required: true, unique: true },  // ex: CNN.us
  name: { type: String, required: true },
  altNames: [String],
  network: String,
  owners: [String],

  // ── Métadonnées ────────────────────────────────────────────────────────────
  country: { type: String, index: true },
  subdivision: String,
  city: String,
  broadcastArea: [String],
  languages: [String],
  categories: [{ type: String, index: true }],
  isNsfw: { type: Boolean, default: false },

  // ── Médias ─────────────────────────────────────────────────────────────────
  logo: String,
  website: String,

  // ── Streams ───────────────────────────────────────────────────────────────
  streams: [StreamSchema],
  hasStream: { type: Boolean, default: false, index: true },
  bestStreamUrl: String,     // URL du meilleur stream testé
  lastStreamCheck: Date,

  // ── EPG ───────────────────────────────────────────────────────────────────
  epgIds: [String],
  timezone: String,

  // ── Stats ─────────────────────────────────────────────────────────────────
  viewCount: { type: Number, default: 0 },
  favoriteCount: { type: Number, default: 0 },
  rating: { type: Number, default: 0 },
  ratingCount: { type: Number, default: 0 },

  // ── Source ────────────────────────────────────────────────────────────────
  source: { type: String, default: 'iptv-org' },  // iptv-org, manual, m3u-import
  isActive: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },

  // ── PREMIUM ───────────────────────────────────────────────────────────────
  isPremium: { type: Boolean, default: false, index: true },  // Chaînes premium uniquement
  update_pattern: { type: String, default: '' },              // Fréquence/règle de mise à jour
  backend_code:   { type: String, default: '' },              // Code interne (admin only)

  // ── Health (stream healer) ────────────────────────────────────────────────
  status:      { type: String, enum: ['up', 'down'], default: 'up' },
  failCount:   { type: Number, default: 0 },
  lastChecked: { type: Date },

  // ── Sync ──────────────────────────────────────────────────────────────────
  lastSyncedAt: { type: Date, default: Date.now },

}, { timestamps: true })

// ── Index composés ────────────────────────────────────────────────────────────
ChannelSchema.index({ country: 1, hasStream: 1 })
ChannelSchema.index({ categories: 1, hasStream: 1 })
ChannelSchema.index({ name: 'text', altNames: 'text', network: 'text' })
ChannelSchema.index({ viewCount: -1 })
ChannelSchema.index({ isFeatured: 1, hasStream: 1 })
ChannelSchema.index({ name: 1, isPremium: 1 })

module.exports = mongoose.model('Channel', ChannelSchema)
