/**
 * Couche de persistance SQLite (via le module natif node:sqlite)
 * Gère les catégories, flux, articles, favoris, états de lecture et préférences utilisateur.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_CATEGORIES, DEFAULT_FEEDS } = require('./defaultFeeds');
const { getFaviconUrl } = require('./extractor');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'fluxrss.db');
const db = new DatabaseSync(DB_PATH);

// Optimisations SQLite pour performances et intégrité référentielle
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT DEFAULT '#3b82f6',
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    xml_url TEXT NOT NULL UNIQUE,
    site_url TEXT DEFAULT '',
    description TEXT DEFAULT '',
    favicon_url TEXT DEFAULT '',
    auto_full_content INTEGER DEFAULT 0,
    etag TEXT DEFAULT NULL,
    last_modified TEXT DEFAULT NULL,
    last_fetched_at TEXT DEFAULT NULL,
    last_error TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_read ON articles(is_read, published_at DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_starred ON articles(is_starred, published_at DESC);
`);

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

/**
 * Initialise les préférences et les flux par défaut lors du tout premier lancement
 */
function ensureInitialized() {
  const defaultSettings = {
    theme: 'light',
    viewMode: 'editorial', // 'editorial' (style 01net), 'compact', 'cards'
    refreshIntervalMin: '15',
    autoMarkReadOnScroll: 'false',
    readerFontFamily: 'sans', // 'sans', 'serif', 'mono'
    readerFontSize: 'medium', // 'small', 'medium', 'large', 'xlarge'
    readerAutoFullContent: 'false',
    showReadArticles: 'true',
    seededDefaults: 'false'
  };

  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, v);
  }

  const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'seededDefaults'`).get();
  const feedCount = db.prepare(`SELECT COUNT(*) AS cnt FROM feeds`).get().cnt;

  if ((!seeded || seeded.value === 'false') && feedCount === 0) {
    const insertCat = db.prepare(
      `INSERT OR IGNORE INTO categories (name, color, position) VALUES (?, ?, ?)`
    );
    for (const c of DEFAULT_CATEGORIES) {
      insertCat.run(c.name, c.color, c.position);
    }

    const getCat = db.prepare(`SELECT id FROM categories WHERE name = ? COLLATE NOCASE`);
    const insertFeed = db.prepare(`
      INSERT OR IGNORE INTO feeds (category_id, title, xml_url, site_url, description, favicon_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const f of DEFAULT_FEEDS) {
      const catRow = getCat.get(f.category);
      const catId = catRow ? catRow.id : null;
      insertFeed.run(
        catId,
        f.title,
        f.xmlUrl,
        f.siteUrl,
        f.description || '',
        getFaviconUrl(f.siteUrl || f.xmlUrl)
      );
    }

    db.prepare(`UPDATE settings SET value = 'true' WHERE key = 'seededDefaults'`).run();
  }
}

ensureInitialized();

/**
 * Récupère ou crée une catégorie par son nom
 */
function getOrCreateCategory(name) {
  const cleanName = (name || 'Général').trim() || 'Général';
  const existing = db
    .prepare(`SELECT id, name, color, position FROM categories WHERE name = ? COLLATE NOCASE`)
    .get(cleanName);
  if (existing) return existing;

  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM categories`).get().cnt;
  const color = CATEGORY_COLORS[count % CATEGORY_COLORS.length];
  const res = db
    .prepare(`INSERT INTO categories (name, color, position) VALUES (?, ?, ?)`)
    .run(cleanName, color, count + 1);
  return { id: Number(res.lastInsertRowid), name: cleanName, color, position: count + 1 };
}

/**
 * Retourne l'état complet de la barre latérale (catégories, flux, compteurs de non-lus/favoris/aujourd'hui)
 */
function getSidebarData() {
  const categories = db
    .prepare(`SELECT id, name, color, position FROM categories ORDER BY position ASC, name ASC`)
    .all();

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
      GROUP BY f.id
      ORDER BY f.title COLLATE NOCASE ASC
    `)
    .all();

  const todayIsoStart = new Date();
  todayIsoStart.setHours(0, 0, 0, 0);

  const counts = db
    .prepare(`
      SELECT
        COUNT(*) AS all_count,
        COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread_count,
        COALESCE(SUM(CASE WHEN is_starred = 1 THEN 1 ELSE 0 END), 0) AS starred_count,
        COALESCE(SUM(CASE WHEN published_at >= ? THEN 1 ELSE 0 END), 0) AS today_count,
        COALESCE(SUM(CASE WHEN published_at >= ? AND is_read = 0 THEN 1 ELSE 0 END), 0) AS today_unread_count
      FROM articles
    `)
    .get(todayIsoStart.toISOString(), todayIsoStart.toISOString());

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

/**
 * Liste les articles avec filtres riches (filter, categoryId, feedId, search, unreadOnly, limit, offset)
 */
function getArticles(params = {}) {
  const {
    filter = 'all', // 'all', 'unread', 'today', 'starred'
    categoryId = null,
    feedId = null,
    search = '',
    unreadOnly = false,
    limit = 60,
    offset = 0
  } = params;

  const conditions = [];
  const bindParams = [];

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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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

/**
 * Récupère un article complet par son ID (avec content_html et full_content_html)
 */
function getArticleById(id) {
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
      WHERE a.id = ?
    `)
    .get(Number(id));
}

/**
 * Insère ou met à jour les articles d'un flux lors d'une synchronisation
 */
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

  // Insérer du plus ancien au plus récent pour un ordre d'ID cohérent
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
      // Ignorer les doublons concurrents
    }
  }

  return insertedCount;
}

/**
 * Marque des articles comme lus en lot (global, catégorie, flux ou liste d'IDs)
 */
function markAllRead({ filter, categoryId, feedId, beforeDate } = {}) {
  const conditions = ['is_read = 0'];
  const params = [];

  if (feedId) {
    conditions.push('feed_id = ?');
    params.push(Number(feedId));
  } else if (categoryId) {
    conditions.push('feed_id IN (SELECT id FROM feeds WHERE category_id = ?)');
    params.push(Number(categoryId));
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

function getSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const obj = {};
  for (const r of rows) {
    obj[r.key] = r.value;
  }
  return obj;
}

function updateSettings(updates = {}) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [k, v] of Object.entries(updates)) {
    stmt.run(String(k), String(v));
  }
  return getSettings();
}

module.exports = {
  db,
  DB_PATH,
  getOrCreateCategory,
  getSidebarData,
  getArticles,
  getArticleById,
  upsertArticlesForFeed,
  markAllRead,
  getSettings,
  updateSettings
};
