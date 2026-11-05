/**
 * Couche de persistance SQLite (via le module natif node:sqlite)
 * Gère les utilisateurs, sessions, invitations, catégories, flux, articles et préférences par utilisateur.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_CATEGORIES, DEFAULT_FEEDS } = require('./defaultFeeds');
const { getFaviconUrl } = require('./extractor');
const { hashPassword, verifyPassword, generateToken, SESSION_DURATION_MS } = require('./auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'fluxrss.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
`);

// Tables Utilisateurs, Sessions & Invitations
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT '',
    suggested_username TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at TEXT DEFAULT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
`);

/**
 * Migration douce des tables categories & feeds pour supporter le multi-utilisateurs (user_id)
 */
function ensureSchemaAndMigrations() {
  // 1. S'assurer qu'il existe au moins un administrateur (id = 1)
  const userCount = db.prepare(`SELECT COUNT(*) AS cnt FROM users`).get().cnt;
  if (userCount === 0) {
    const adminUsername = (process.env.ADMIN_USER || 'admin').trim();
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin1234';
    db.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(adminUsername, 'Administrateur', hashPassword(adminPassword));
  }

  // 2. Vérifier si la table categories existe déjà sans user_id
  const catColumns = db.prepare(`PRAGMA table_info(categories)`).all();
  const hasCategoriesTable = catColumns.length > 0;
  const catHasUserId = catColumns.some((c) => c.name === 'user_id');

  if (hasCategoriesTable && !catHasUserId) {
    db.exec(`PRAGMA foreign_keys = OFF;`);
    db.exec(`
      CREATE TABLE categories_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        color TEXT DEFAULT '#3b82f6',
        position INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, name)
      );
      INSERT INTO categories_new (id, user_id, name, color, position, created_at)
      SELECT id, 1, name, color, position, created_at FROM categories;
      DROP TABLE categories;
      ALTER TABLE categories_new RENAME TO categories;
    `);
    db.exec(`PRAGMA foreign_keys = ON;`);
  } else if (!hasCategoriesTable) {
    db.exec(`
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        color TEXT DEFAULT '#3b82f6',
        position INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, name)
      );
    `);
  }

  // 3. Vérifier si la table feeds existe déjà sans user_id
  const feedColumns = db.prepare(`PRAGMA table_info(feeds)`).all();
  const hasFeedsTable = feedColumns.length > 0;
  const feedHasUserId = feedColumns.some((c) => c.name === 'user_id');

  if (hasFeedsTable && !feedHasUserId) {
    db.exec(`PRAGMA foreign_keys = OFF;`);
    db.exec(`
      CREATE TABLE feeds_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        xml_url TEXT NOT NULL,
        site_url TEXT DEFAULT '',
        description TEXT DEFAULT '',
        favicon_url TEXT DEFAULT '',
        auto_full_content INTEGER DEFAULT 0,
        etag TEXT DEFAULT NULL,
        last_modified TEXT DEFAULT NULL,
        last_fetched_at TEXT DEFAULT NULL,
        last_error TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, xml_url)
      );
      INSERT INTO feeds_new (
        id, user_id, category_id, title, xml_url, site_url, description, favicon_url,
        auto_full_content, etag, last_modified, last_fetched_at, last_error, created_at
      )
      SELECT
        id, 1, category_id, title, xml_url, site_url, description, favicon_url,
        auto_full_content, etag, last_modified, last_fetched_at, last_error, created_at
      FROM feeds;
      DROP TABLE feeds;
      ALTER TABLE feeds_new RENAME TO feeds;
    `);
    db.exec(`PRAGMA foreign_keys = ON;`);
  } else if (!hasFeedsTable) {
    db.exec(`
      CREATE TABLE feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        xml_url TEXT NOT NULL,
        site_url TEXT DEFAULT '',
        description TEXT DEFAULT '',
        favicon_url TEXT DEFAULT '',
        auto_full_content INTEGER DEFAULT 0,
        etag TEXT DEFAULT NULL,
        last_modified TEXT DEFAULT NULL,
        last_fetched_at TEXT DEFAULT NULL,
        last_error TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, xml_url)
      );
    `);
  }

  // 4. Table articles & index
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT DEFAULT '',
      author TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      content_html TEXT DEFAULT '',
      full_content_html TEXT DEFAULT NULL,
      image_url TEXT DEFAULT NULL,
      published_at TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      reading_time_min INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(feed_id, guid)
    );

    CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
    CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_read ON articles(is_read, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_starred ON articles(is_starred, published_at DESC);
  `);

  // 5. Initialiser les flux par défaut pour l'administrateur initial si la base est vierge
  const adminUser = db.prepare(`SELECT id FROM users ORDER BY id ASC LIMIT 1`).get();
  if (adminUser) {
    ensureUserSettingsAndFeeds(adminUser.id, { seedDefaultFeeds: true });
  }
}

const CATEGORY_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#6366f1',
  '#ef4444'
];

function ensureUserSettingsAndFeeds(userId, { seedDefaultFeeds = false } = {}) {
  const defaultSettings = {
    theme: 'light',
    viewMode: 'editorial',
    refreshIntervalMin: '15',
    readerFontFamily: 'sans',
    readerFontSize: 'medium',
    seededDefaults: 'false'
  };

  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)`
  );
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(Number(userId), k, v);
  }

  const seeded = db
    .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'seededDefaults'`)
    .get(Number(userId));
  const feedCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM feeds WHERE user_id = ?`)
    .get(Number(userId)).cnt;

  if (seedDefaultFeeds && (!seeded || seeded.value === 'false') && feedCount === 0) {
    const insertCat = db.prepare(
      `INSERT OR IGNORE INTO categories (user_id, name, color, position) VALUES (?, ?, ?, ?)`
    );
    for (const c of DEFAULT_CATEGORIES) {
      insertCat.run(Number(userId), c.name, c.color, c.position);
    }

    const getCat = db.prepare(
      `SELECT id FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE`
    );
    const insertFeed = db.prepare(`
      INSERT OR IGNORE INTO feeds (user_id, category_id, title, xml_url, site_url, description, favicon_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const f of DEFAULT_FEEDS) {
      const catRow = getCat.get(Number(userId), f.category);
      const catId = catRow ? catRow.id : null;
      insertFeed.run(
        Number(userId),
        catId,
        f.title,
        f.xmlUrl,
        f.siteUrl,
        f.description || '',
        getFaviconUrl(f.siteUrl || f.xmlUrl)
      );
    }
  }

  db.prepare(
    `UPDATE user_settings SET value = 'true' WHERE user_id = ? AND key = 'seededDefaults'`
  ).run(Number(userId));
}

ensureSchemaAndMigrations();

/* ==========================================================================
   AUTHENTIFICATION, UTILISATEURS & INVITATIONS
   ========================================================================== */

function authenticateUser(username, password) {
  const cleanUser = (username || '').trim();
  if (!cleanUser || !password) return null;

  const user = db
    .prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
    .get(cleanUser);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;

  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role
  };
}

function createSession(userId) {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(
    token,
    Number(userId),
    expiresAt
  );
  return { token, expiresAt };
}

function getUserBySessionToken(token) {
  if (!token) return null;
  const row = db
    .prepare(`
      SELECT
        s.token,
        s.expires_at,
        u.id,
        u.username,
        u.display_name,
        u.role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `)
    .get(String(token));

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(String(token));
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role
  };
}

function deleteSession(token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(String(token));
}

function createUserAccount({ username, displayName, password, role = 'user', seedFeeds = true }) {
  const cleanUsername = (username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) {
    throw new Error(
      "L'identifiant doit contenir entre 3 et 32 caractères (lettres, chiffres, points, tirets)."
    );
  }
  if (!password || String(password).length < 6) {
    throw new Error('Le mot de passe doit contenir au moins 6 caractères.');
  }

  const existing = db
    .prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`)
    .get(cleanUsername);
  if (existing) {
    throw new Error('Cet identifiant est déjà utilisé.');
  }

  const finalRole = role === 'admin' ? 'admin' : 'user';
  const finalDisplay = (displayName || cleanUsername).trim();

  const res = db
    .prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES (?, ?, ?, ?)
    `)
    .run(cleanUsername, finalDisplay, hashPassword(password), finalRole);

  const userId = Number(res.lastInsertRowid);
  ensureUserSettingsAndFeeds(userId, { seedDefaultFeeds: Boolean(seedFeeds) });

  return {
    id: userId,
    username: cleanUsername,
    displayName: finalDisplay,
    role: finalRole
  };
}

function updateUserPassword(userId, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error('Le mot de passe doit contenir au moins 6 caractères.');
  }
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
    hashPassword(newPassword),
    Number(userId)
  );
}

function listUsers() {
  return db
    .prepare(`
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.role,
        u.created_at,
        u.last_login_at,
        COUNT(f.id) AS feed_count
      FROM users u
      LEFT JOIN feeds f ON f.user_id = u.id
      GROUP BY u.id
      ORDER BY u.id ASC
    `)
    .all();
}

function deleteUserAccount(targetUserId, requestingAdminId) {
  if (Number(targetUserId) === Number(requestingAdminId)) {
    throw new Error('Vous ne pouvez pas supprimer votre propre compte administrateur.');
  }
  db.prepare(`DELETE FROM users WHERE id = ?`).run(Number(targetUserId));
}

function createInvitation({ label = '', suggestedUsername = '', role = 'user', expiresInDays = 7, createdBy }) {
  const token = generateToken(20);
  const days = Math.max(1, Math.min(90, Number(expiresInDays) || 7));
  const expiresAt = new Date(Date.now() + days * 86400 * 1000).toISOString();
  const finalRole = role === 'admin' ? 'admin' : 'user';

  const res = db
    .prepare(`
      INSERT INTO invitations (token, label, suggested_username, role, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      token,
      (label || '').trim(),
      (suggestedUsername || '').trim(),
      finalRole,
      Number(createdBy),
      expiresAt
    );

  return db.prepare(`SELECT * FROM invitations WHERE id = ?`).get(Number(res.lastInsertRowid));
}

function getInvitationByToken(token) {
  if (!token) return null;
  const inv = db.prepare(`SELECT * FROM invitations WHERE token = ?`).get(String(token).trim());
  if (!inv) return null;
  const isExpired = new Date(inv.expires_at).getTime() < Date.now();
  const isUsed = Boolean(inv.used_at);
  return {
    ...inv,
    isExpired,
    isUsed,
    isValid: !isExpired && !isUsed
  };
}

function acceptInvitation({ token, username, displayName, password, seedFeeds = true }) {
  const inv = getInvitationByToken(token);
  if (!inv) {
    throw new Error("Ce lien d'invitation est introuvable.");
  }
  if (inv.isUsed) {
    throw new Error("Ce lien d'invitation a déjà été utilisé.");
  }
  if (inv.isExpired) {
    throw new Error("Ce lien d'invitation a expiré.");
  }

  const finalUsername = (username || inv.suggested_username || '').trim();
  const user = createUserAccount({
    username: finalUsername,
    displayName: displayName || inv.label || finalUsername,
    password,
    role: inv.role,
    seedFeeds
  });

  db.prepare(`
    UPDATE invitations
    SET used_by = ?, used_at = datetime('now')
    WHERE id = ?
  `).run(user.id, inv.id);

  return user;
}

function listInvitations() {
  return db
    .prepare(`
      SELECT
        i.*,
        u1.username AS created_by_username,
        u2.username AS used_by_username
      FROM invitations i
      LEFT JOIN users u1 ON u1.id = i.created_by
      LEFT JOIN users u2 ON u2.id = i.used_by
      ORDER BY i.created_at DESC
    `)
    .all();
}

function deleteInvitation(id) {
  db.prepare(`DELETE FROM invitations WHERE id = ?`).run(Number(id));
}

/* ==========================================================================
   DONNÉES RSS SCOPÉES PAR UTILISATEUR (userId)
   ========================================================================== */

function getOrCreateCategory(userId, name) {
  const cleanName = (name || 'Général').trim() || 'Général';
  const existing = db
    .prepare(
      `SELECT id, name, color, position FROM categories WHERE user_id = ? AND name = ? COLLATE NOCASE`
    )
    .get(Number(userId), cleanName);
  if (existing) return existing;

  const count = db
    .prepare(`SELECT COUNT(*) AS cnt FROM categories WHERE user_id = ?`)
    .get(Number(userId)).cnt;
  const color = CATEGORY_COLORS[count % CATEGORY_COLORS.length];
  const res = db
    .prepare(`INSERT INTO categories (user_id, name, color, position) VALUES (?, ?, ?, ?)`)
    .run(Number(userId), cleanName, color, count + 1);
  return { id: Number(res.lastInsertRowid), name: cleanName, color, position: count + 1 };
}

function getSidebarData(userId) {
  const uid = Number(userId);
  const categories = db
    .prepare(
      `SELECT id, name, color, position FROM categories WHERE user_id = ? ORDER BY position ASC, name ASC`
    )
    .all(uid);

  const feeds = db
    .prepare(`
      SELECT
        f.*,
        c.name AS category_name,
        c.color AS category_color,
        COALESCE(SUM(CASE WHEN a.is_read = 0 THEN 1 ELSE 0 END), 0) AS unread_count,
        COUNT(a.id) AS total_count
      FROM feeds f
      LEFT JOIN categories c ON c.id = f.category_id
      LEFT JOIN articles a ON a.feed_id = f.id
      WHERE f.user_id = ?
      GROUP BY f.id
      ORDER BY f.title COLLATE NOCASE ASC
    `)
    .all(uid);

  const todayIsoStart = new Date();
  todayIsoStart.setHours(0, 0, 0, 0);

  const counts = db
    .prepare(`
      SELECT
        COUNT(a.id) AS all_count,
        COALESCE(SUM(CASE WHEN a.is_read = 0 THEN 1 ELSE 0 END), 0) AS unread_count,
        COALESCE(SUM(CASE WHEN a.is_starred = 1 THEN 1 ELSE 0 END), 0) AS starred_count,
        COALESCE(SUM(CASE WHEN a.published_at >= ? THEN 1 ELSE 0 END), 0) AS today_count,
        COALESCE(SUM(CASE WHEN a.published_at >= ? AND a.is_read = 0 THEN 1 ELSE 0 END), 0) AS today_unread_count
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      WHERE f.user_id = ?
    `)
    .get(todayIsoStart.toISOString(), todayIsoStart.toISOString(), uid);

  return {
    categories,
    feeds,
    counts: {
      all: counts?.all_count || 0,
      unread: counts?.unread_count || 0,
      starred: counts?.starred_count || 0,
      today: counts?.today_count || 0,
      todayUnread: counts?.today_unread_count || 0
    }
  };
}

function getArticles(userId, params = {}) {
  const {
    filter = 'all',
    categoryId = null,
    feedId = null,
    search = '',
    unreadOnly = false,
    limit = 60,
    offset = 0
  } = params;

  const conditions = ['f.user_id = ?'];
  const bindParams = [Number(userId)];

  if (filter === 'unread' || unreadOnly) {
    conditions.push('a.is_read = 0');
  } else if (filter === 'starred') {
    conditions.push('a.is_starred = 1');
  } else if (filter === 'today') {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    conditions.push('a.published_at >= ?');
    bindParams.push(todayStart.toISOString());
  }

  if (feedId) {
    conditions.push('a.feed_id = ?');
    bindParams.push(Number(feedId));
  } else if (categoryId) {
    conditions.push('f.category_id = ?');
    bindParams.push(Number(categoryId));
  }

  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push('(a.title LIKE ? OR a.summary LIKE ? OR f.title LIKE ? OR a.author LIKE ?)');
    bindParams.push(q, q, q, q);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const totalRow = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      ${whereClause}
    `)
    .get(...bindParams);

  const rows = db
    .prepare(`
      SELECT
        a.id,
        a.feed_id,
        a.guid,
        a.title,
        a.url,
        a.author,
        a.summary,
        a.image_url,
        a.published_at,
        a.is_read,
        a.is_starred,
        a.reading_time_min,
        (a.full_content_html IS NOT NULL AND a.full_content_html != '') AS has_full_content,
        f.title AS feed_title,
        f.site_url AS feed_site_url,
        f.favicon_url AS feed_favicon_url,
        f.auto_full_content AS feed_auto_full_content,
        c.id AS category_id,
        c.name AS category_name,
        c.color AS category_color
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      LEFT JOIN categories c ON c.id = f.category_id
      ${whereClause}
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...bindParams, Number(limit), Number(offset));

  return {
    articles: rows,
    total: totalRow?.total || 0
  };
}

function getArticleById(userId, id) {
  return db
    .prepare(`
      SELECT
        a.*,
        f.title AS feed_title,
        f.site_url AS feed_site_url,
        f.xml_url AS feed_xml_url,
        f.favicon_url AS feed_favicon_url,
        f.auto_full_content AS feed_auto_full_content,
        c.id AS category_id,
        c.name AS category_name,
        c.color AS category_color
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      LEFT JOIN categories c ON c.id = f.category_id
      WHERE a.id = ? AND f.user_id = ?
    `)
    .get(Number(id), Number(userId));
}

function upsertArticlesForFeed(feedId, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;

  const checkExisting = db.prepare(
    `SELECT id, image_url FROM articles WHERE feed_id = ? AND (guid = ? OR (url != '' AND url = ?))`
  );
  const insertStmt = db.prepare(`
    INSERT INTO articles (
      feed_id, guid, title, url, author, summary, content_html, image_url, published_at, reading_time_min
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateImageStmt = db.prepare(`
    UPDATE articles SET image_url = COALESCE(image_url, ?) WHERE id = ?
  `);

  let insertedCount = 0;
  const sorted = [...items].reverse();

  for (const item of sorted) {
    const guid = (item.guid || item.url || item.title || '').trim();
    if (!guid) continue;

    const existing = checkExisting.get(Number(feedId), guid, item.url || '');
    if (existing) {
      if (!existing.image_url && item.imageUrl) {
        updateImageStmt.run(item.imageUrl, existing.id);
      }
      continue;
    }

    try {
      insertStmt.run(
        Number(feedId),
        guid,
        item.title || 'Sans titre',
        item.url || '',
        item.author || '',
        item.summary || '',
        item.contentHtml || '',
        item.imageUrl || null,
        item.publishedAt || new Date().toISOString(),
        item.readingTimeMin || 1
      );
      insertedCount++;
    } catch {
      // ignore duplicate
    }
  }

  return insertedCount;
}

function markAllRead(userId, { filter, categoryId, feedId, beforeDate } = {}) {
  const conditions = [
    'is_read = 0',
    'feed_id IN (SELECT id FROM feeds WHERE user_id = ?)'
  ];
  const params = [Number(userId)];

  if (feedId) {
    conditions.push('feed_id = ?');
    params.push(Number(feedId));
  } else if (categoryId) {
    conditions.push('feed_id IN (SELECT id FROM feeds WHERE user_id = ? AND category_id = ?)');
    params.push(Number(userId), Number(categoryId));
  }

  if (filter === 'today') {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    conditions.push('published_at >= ?');
    params.push(todayStart.toISOString());
  }

  if (beforeDate) {
    conditions.push('published_at <= ?');
    params.push(beforeDate);
  }

  const res = db
    .prepare(`UPDATE articles SET is_read = 1 WHERE ${conditions.join(' AND ')}`)
    .run(...params);
  return res.changes;
}

function getSettings(userId) {
  ensureUserSettingsAndFeeds(userId, { seedDefaultFeeds: false });
  const rows = db
    .prepare(`SELECT key, value FROM user_settings WHERE user_id = ?`)
    .all(Number(userId));
  const obj = {};
  for (const r of rows) {
    obj[r.key] = r.value;
  }
  return obj;
}

function updateSettings(userId, updates = {}) {
  ensureUserSettingsAndFeeds(userId, { seedDefaultFeeds: false });
  const stmt = db.prepare(`
    INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `);
  for (const [k, v] of Object.entries(updates)) {
    stmt.run(Number(userId), String(k), String(v));
  }
  return getSettings(userId);
}

/**
 * Récupère les articles récents (dernières 36h, ou fallback sur les 40 plus récents) pour la Synthèse IA du jour
 */
function getRecentArticlesForBriefing(userId) {
  const sinceIso = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  let rows = db
    .prepare(`
      SELECT
        a.*,
        f.title AS feed_title,
        f.favicon_url AS feed_favicon_url,
        c.name AS category_name
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      LEFT JOIN categories c ON c.id = f.category_id
      WHERE f.user_id = ? AND a.published_at >= ?
      ORDER BY a.published_at DESC
      LIMIT 80
    `)
    .all(Number(userId), sinceIso);

  if (rows.length < 5) {
    rows = db
      .prepare(`
        SELECT
          a.*,
          f.title AS feed_title,
          f.favicon_url AS feed_favicon_url,
          c.name AS category_name
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        LEFT JOIN categories c ON c.id = f.category_id
        WHERE f.user_id = ?
        ORDER BY a.published_at DESC
        LIMIT 40
      `)
      .all(Number(userId));
  }

  return rows;
}

/**
 * Récupère l'ensemble des articles de l'utilisateur pour la Recherche Sémantique IA
 */
function getAllArticlesForSearch(userId, limit = 500) {
  return db
    .prepare(`
      SELECT
        a.*,
        f.title AS feed_title,
        f.favicon_url AS feed_favicon_url,
        c.name AS category_name
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      LEFT JOIN categories c ON c.id = f.category_id
      WHERE f.user_id = ?
      ORDER BY a.published_at DESC
      LIMIT ?
    `)
    .all(Number(userId), Number(limit));
}

module.exports = {
  db,
  DB_PATH,
  authenticateUser,
  createSession,
  getUserBySessionToken,
  deleteSession,
  createUserAccount,
  updateUserPassword,
  listUsers,
  deleteUserAccount,
  createInvitation,
  getInvitationByToken,
  acceptInvitation,
  listInvitations,
  deleteInvitation,
  getOrCreateCategory,
  getSidebarData,
  getArticles,
  getArticleById,
  upsertArticlesForFeed,
  markAllRead,
  getSettings,
  updateSettings,
  getRecentArticlesForBriefing,
  getAllArticlesForSearch
};
