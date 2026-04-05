const jwt = require('jsonwebtoken')
const User = require('../models/User')

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret_change_in_prod'

// ── Vérifier le JWT ───────────────────────────────────────────────────────────
const auth = async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Token manquant' })
    }

    const token = header.split(' ')[1]
    const decoded = jwt.verify(token, JWT_SECRET)

    const user = await User.findById(decoded.userId).select('-password -refreshTokens')
    if (!user) return res.status(401).json({ success: false, message: 'Utilisateur introuvable' })
    if (!user.isActive) return res.status(401).json({ success: false, message: 'Compte désactivé' })
    if (user.isBanned) return res.status(403).json({ success: false, message: 'Compte banni' })

    req.user = user
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expiré', expired: true })
    }
    return res.status(401).json({ success: false, message: 'Token invalide' })
  }
}

// ── Optionnel (ne bloque pas si pas de token) ─────────────────────────────────
const optionalAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return next()
    const token = header.split(' ')[1]
    const decoded = jwt.verify(token, JWT_SECRET)
    const user = await User.findById(decoded.userId).select('-password -refreshTokens')
    if (user?.isActive) req.user = user
  } catch { /* ignore */ }
  next()
}

// ── Rôle admin requis ─────────────────────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accès admin requis' })
  }
  next()
}

// ── Plan premium requis ───────────────────────────────────────────────────────
const premiumOnly = (req, res, next) => {
  if (req.user?.role === 'admin') return next()
  if (!req.user?.isPremium()) {
    return res.status(403).json({
      success: false,
      message: 'Abonnement Premium requis',
      upgradeUrl: '/pricing',
    })
  }
  next()
}

// ── Revendeur ou admin ────────────────────────────────────────────────────────
const resellerOrAdmin = (req, res, next) => {
  if (['reseller', 'admin'].includes(req.user?.role)) return next()
  return res.status(403).json({ success: false, message: 'Accès revendeur requis' })
}

module.exports = { auth, optionalAuth, adminOnly, premiumOnly, resellerOrAdmin }
