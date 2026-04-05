const express = require('express')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const User = require('../models/User')
const { auth } = require('../middleware/auth')
const router = express.Router()

const generateTokens = (userId) => {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRE || '15m',
  })
  const refreshToken = jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d',
  })
  return { accessToken, refreshToken }
}

// ── POST /auth/register ──────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Tous les champs sont requis' })
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Mot de passe : 6 caractères minimum' })
    }

    const exists = await User.findOne({ email: email.toLowerCase() })
    if (exists) {
      return res.status(409).json({ success: false, message: 'Email déjà utilisé' })
    }

    const user = new User({ name, email, password })
    await user.save()

    const { accessToken, refreshToken } = generateTokens(user._id)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    user.refreshTokens.push({ token: refreshToken, expiresAt })
    user.lastLogin = new Date()
    user.loginCount = 1
    await user.save()

    res.status(201).json({
      success: true,
      message: 'Compte créé avec succès',
      data: { user: user.toSafeJSON(), accessToken, refreshToken },
    })
  } catch (err) {
    console.error('Register error:', err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis' })
    }

    const user = await User.findOne({ email: email.toLowerCase() })
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Identifiants incorrects' })
    }
    if (user.isBanned) {
      return res.status(403).json({ success: false, message: `Compte banni : ${user.banReason || ''}` })
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Compte désactivé' })
    }

    const { accessToken, refreshToken } = generateTokens(user._id)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    // Nettoyer les vieux refresh tokens expirés
    user.refreshTokens = user.refreshTokens.filter(t => t.expiresAt > new Date())
    user.refreshTokens.push({ token: refreshToken, expiresAt })
    user.lastLogin = new Date()
    user.loginCount = (user.loginCount || 0) + 1
    await user.save()

    res.json({
      success: true,
      data: { user: user.toSafeJSON(), accessToken, refreshToken },
    })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token manquant' })
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET)
    const user = await User.findById(decoded.userId)
    if (!user) return res.status(401).json({ success: false, message: 'Utilisateur introuvable' })

    const tokenRecord = user.refreshTokens.find(t =>
      t.token === refreshToken && t.expiresAt > new Date()
    )
    if (!tokenRecord) {
      return res.status(401).json({ success: false, message: 'Refresh token invalide ou expiré' })
    }

    // Rotation du refresh token
    user.refreshTokens = user.refreshTokens.filter(t => t.token !== refreshToken)
    const tokens = generateTokens(user._id)
    user.refreshTokens.push({
      token: tokens.refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    await user.save()

    res.json({ success: true, data: tokens })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Refresh token invalide' })
    }
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', auth, async (req, res) => {
  try {
    const { refreshToken } = req.body
    if (refreshToken) {
      req.user.refreshTokens = req.user.refreshTokens.filter(t => t.token !== refreshToken)
      await req.user.save()
    }
    res.json({ success: true, message: 'Déconnexion réussie' })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  res.json({ success: true, data: req.user.toSafeJSON() })
})

// ── PUT /auth/me ───────────────────────────────────────────────────────────────
router.put('/me', auth, async (req, res) => {
  try {
    const allowed = ['name', 'settings']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key]
    }
    Object.assign(req.user, updates)
    await req.user.save()
    res.json({ success: true, data: req.user.toSafeJSON() })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── PUT /auth/password ────────────────────────────────────────────────────────
router.put('/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    const user = await User.findById(req.user._id)

    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ success: false, message: 'Mot de passe actuel incorrect' })
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: '6 caractères minimum' })
    }

    user.password = newPassword
    user.refreshTokens = []  // Invalider toutes les sessions
    await user.save()

    res.json({ success: true, message: 'Mot de passe mis à jour — reconnectez-vous' })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /auth/forgot-password ────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body
    const user = await User.findOne({ email: email?.toLowerCase() })
    // Toujours répondre 200 pour ne pas révéler si l'email existe
    if (!user) return res.json({ success: true, message: 'Si cet email existe, un lien vous a été envoyé' })

    const token = crypto.randomBytes(32).toString('hex')
    user.passwordResetToken = crypto.createHash('sha256').update(token).digest('hex')
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000) // 1h
    await user.save()

    // TODO: envoyer l'email avec le token
    res.json({ success: true, message: 'Si cet email existe, un lien vous a été envoyé' })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

// ── POST /auth/reset-password ─────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex')

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() },
    })
    if (!user) {
      return res.status(400).json({ success: false, message: 'Token invalide ou expiré' })
    }

    user.password = newPassword
    user.passwordResetToken = undefined
    user.passwordResetExpires = undefined
    user.refreshTokens = []
    await user.save()

    res.json({ success: true, message: 'Mot de passe réinitialisé' })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' })
  }
})

module.exports = router
