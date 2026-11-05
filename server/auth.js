/**
 * Module d'authentification et de sécurité
 * - Hachage de mots de passe via node:crypto (scrypt + sel aléatoire + timingSafeEqual)
 * - Gestion des cookies de session HttpOnly
 * - Génération de jetons de session et de jetons d'invitation
 */

const crypto = require('node:crypto');

const SESSION_COOKIE_NAME = 'flux_session';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours

/**
 * Hache un mot de passe avec un sel aléatoire (scrypt)
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Vérifie un mot de passe par rapport à son empreinte scrypt
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const derivedBuffer = crypto.scryptSync(String(password), salt, 64);
  if (keyBuffer.length !== derivedBuffer.length) return false;
  return crypto.timingSafeEqual(keyBuffer, derivedBuffer);
}

/**
 * Génère un jeton aléatoire cryptographiquement sûr
 */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Parse l'en-tête Cookie d'une requête HTTP
 */
function parseCookies(cookieHeader = '') {
  const cookies = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

/**
 * Crée l'en-tête Set-Cookie pour la session
 */
function buildSessionCookie(token, maxAgeSec = Math.floor(SESSION_DURATION_MS / 1000)) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function buildClearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  hashPassword,
  verifyPassword,
  generateToken,
  parseCookies,
  buildSessionCookie,
  buildClearSessionCookie
};
