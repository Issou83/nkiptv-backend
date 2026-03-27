const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')

// ── Schéma Profil ─────────────────────────────────────────────────────────────
const ProfileSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 30 },
  avatar: { type: String, default: null }, // emoji ou URL
  pin: { type: String, default: null },    // PIN parental haché
  isKid: { type: Boolean, default: false },
  language: { type: String, default: 'fr' },
  favorites: [{ type: String }],          // IDs des chaînes favorites
  watchHistory: [{
    channelId: String,
    channelName: String,
    watchedAt: { type: Date, default: Date.now },
    duration: Number,                     // secondes regardées
  }],
}, { _id: true })

// ── Schéma Principal Utilisateur ─────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 50 },
  email: {
    type: String, required: true, unique: true,
    lowercase: true, trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Email invalide'],
  },
  password: { type: String, required: true, minlength: 6 },
  role: { type: String, enum: ['user', 'reseller', 'admin'], default: 'user' },

  // ── Plan d'abonnement ──────────────────────────────────────────────────────
  plan: {
    type: { type: String, enum: ['free', 'premium', 'pro'], default: 'free' },
    stripeCustomerId: String,
    stripeSubscriptionId: String,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },

  // ── Profils (multi-profils) ────────────────────────────────────────────────
  profiles: {
    type: [ProfileSchema],
    validate: [arr => arr.length <= 5, 'Maximum 5 profils par compte'],
    default: [],
  },
  activeProfileId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // ── Système Revendeur ──────────────────────────────────────────────────────
  reseller: {
    credits: { type: Number, default: 0 },
    maxAccounts: { type: Number, default: 0 },
    createdAccounts: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },   // % de commission
    parentResellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },

  // ── Paramètres utilisateur ─────────────────────────────────────────────────
  settings: {
    language: { type: String, default: 'fr' },
    theme: { type: String, enum: ['dark', 'light', 'auto'], default: 'dark' },
    autoplay: { type: Boolean, default: true },
    defaultQuality: { type: String, default: 'auto' },
    parentalControl: { type: Boolean, default: false },
    parentalPin: { type: String, default: null },
    notifications: {
      email: { type: Boolean, default: true },
      newChannels: { type: Boolean, default: false },
    },
  },

  // ── Playlists M3U importées ────────────────────────────────────────────────
  playlists: [{
    name: String,
    url: String,
    type: { type: String, enum: ['m3u', 'xspf', 'json'] },
    channelCount: { type: Number, default: 0 },
    lastSync: Date,
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  }],

  // ── Auth ───────────────────────────────────────────────────────────────────
  refreshTokens: [{ token: String, expiresAt: Date }],
  emailVerified: { type: Boolean, default: false },
  emailVerifyToken: String,
  passwordResetToken: String,
  passwordResetExpires: Date,
  lastLogin: Date,
  loginCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  isBanned: { type: Boolean, default: false },
  banReason: String,

}, { timestamps: true })

// ── Index ─────────────────────────────────────────────────────────────────────
UserSchema.index({ email: 1 })
UserSchema.index({ role: 1 })
UserSchema.index({ 'plan.type': 1 })
UserSchema.index({ createdAt: -1 })

// ── Hachage mot de passe ──────────────────────────────────────────────────────
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next()
  const salt = await bcrypt.genSalt(12)
  this.password = await bcrypt.hash(this.password, salt)
  // Créer le profil par défaut si premier save
  if (this.profiles.length === 0) {
    this.profiles.push({ name: this.name, avatar: '👤' })
    this.activeProfileId = this.profiles[0]._id
  }
  next()
})

// ── Méthodes ──────────────────────────────────────────────────────────────────
UserSchema.methods.comparePassword = async function (pwd) {
  return bcrypt.compare(pwd, this.password)
}

UserSchema.methods.getActiveProfile = function () {
  if (!this.activeProfileId) return this.profiles[0] || null
  return this.profiles.id(this.activeProfileId) || this.profiles[0] || null
}

UserSchema.methods.isPremium = function () {
  return ['premium', 'pro'].includes(this.plan.type) &&
    (!this.plan.currentPeriodEnd || this.plan.currentPeriodEnd > new Date())
}

UserSchema.methods.toSafeJSON = function () {
  const obj = this.toObject()
  delete obj.password
  delete obj.refreshTokens
  delete obj.emailVerifyToken
  delete obj.passwordResetToken
  return obj
}

module.exports = mongoose.model('User', UserSchema)
