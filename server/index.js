/**
 * Serveur principal Flux RSS (HTTP + API REST + Synchronisation en arrière-plan)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const {
  db,
  getOrCreateCategory,
  getSidebarData,
  getArticles,
  getArticleById,
  upsertArticlesForFeed,
  markAllRead,
  getSettings,
  updateSettings
} = require('./db');
const { parseFeedContent } = require('./rssParser');
const {
  fetchUrlText,
  discoverFeedUrl,
  extractMetaImage,
  extractFullArticle,
  getFaviconUrl
} = require('./extractor');
const { parseOpml, generateOpml } = require('./opml');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const syncState = {
  isSyncing: false,
  total: 0,
  completed: 0,
  newArticles: 0,
  lastSyncAt: null,
  currentFeed: ''
};

/**
 * Enrichit en arrière-plan les vignettes (og:image) des articles récents qui n'avaient pas d'image dans le flux XML
 */
async function enrichMissingThumbnails(feedId, limit = 6) {
  const missing = db
    .prepare(`
      SELECT id, url
      FROM articles
      WHERE feed_id = ? AND (image_url IS NULL OR image_url = '') AND url LIKE 'http%'
      ORDER BY published_at DESC
      LIMIT ?
    `)
    .all(Number(feedId), Number(limit));

  if (missing.length === 0) return;

  const updateStmt = db.prepare(`UPDATE articles SET image_url = ? WHERE id = ?`);
  for (const row of missing) {
    try {
      const res = await fetchUrlText(row.url, { timeoutMs: 6000 });
      const ogImage = extractMetaImage(res.text, res.finalUrl || row.url);
      if (ogImage) {
        updateStmt.run(ogImage, row.id);
      }
    } catch {
      // Ignorer silencieusement si la page bloque ou expire
    }
  }
}

/**
 * Synchronise un flux individuel
 */
async function syncSingleFeed(feed) {
  const headers = {};
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  try {
    const res = await fetchUrlText(feed.xml_url, { timeoutMs: 12000, headers });

    if (res.notModified) {
      db.prepare(`UPDATE feeds SET last_fetched_at = datetime('now'), last_error = NULL WHERE id = ?`).run(
        feed.id
      );
      return { feedId: feed.id, inserted: 0, notModified: true };
    }

    const parsed = parseFeedContent(res.text, feed.xml_url);
    const inserted = upsertArticlesForFeed(feed.id, parsed.items);

    const newSiteUrl = parsed.siteUrl || feed.site_url || feed.xml_url;
    const favicon = feed.favicon_url || getFaviconUrl(newSiteUrl);

    db.prepare(`
      UPDATE feeds
      SET
        site_url = COALESCE(NULLIF(?, ''), site_url),
        description = COALESCE(NULLIF(?, ''), description),
        favicon_url = COALESCE(NULLIF(?, ''), favicon_url),
        etag = ?,
        last_modified = ?,
        last_fetched_at = datetime('now'),
        last_error = NULL
      WHERE id = ?
    `).run(
      newSiteUrl,
      parsed.description || '',
      favicon,
      res.etag || null,
      res.lastModified || null,
      feed.id
    );

    // Enrichir en tâche de fond les vignettes manquantes sur les articles récents
    enrichMissingThumbnails(feed.id, 5).catch(() => {});

    return { feedId: feed.id, inserted, error: null };
  } catch (err) {
    const errorMsg = err.message || 'Erreur de synchronisation';
    db.prepare(`
      UPDATE feeds
      SET last_fetched_at = datetime('now'), last_error = ?
      WHERE id = ?
    `).run(errorMsg, feed.id);
    return { feedId: feed.id, inserted: 0, error: errorMsg };
  }
}

/**
 * Synchronise tous les flux (ou un flux spécifique) avec parallélisme contrôlé
 */
async function syncFeeds(targetFeedId = null) {
  if (syncState.isSyncing && !targetFeedId) {
    return syncState;
  }

  const feeds = targetFeedId
    ? db.prepare(`SELECT * FROM feeds WHERE id = ?`).all(Number(targetFeedId))
    : db.prepare(`SELECT * FROM feeds ORDER BY id ASC`).all();

  if (feeds.length === 0) {
    return { isSyncing: false, total: 0, completed: 0, newArticles: 0 };
  }

  syncState.isSyncing = true;
  syncState.total = feeds.length;
  syncState.completed = 0;
  syncState.newArticles = 0;

  const concurrency = 4;
  let index = 0;

  async function worker() {
    while (index < feeds.length) {
      const current = feeds[index++];
      syncState.currentFeed = current.title;
      const result = await syncSingleFeed(current);
      syncState.completed++;
      syncState.newArticles += result.inserted || 0;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, feeds.length) }, () => worker());
  try {
    await Promise.all(workers);
  } finally {
    syncState.isSyncing = false;
    syncState.currentFeed = '';
    syncState.lastSyncAt = new Date().toISOString();
  }

  return { ...syncState };
}

/**
 * Utilitaires HTTP JSON
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Routeur API REST
 */
async function handleApi(req, res, urlObj) {
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  try {
    // GET /api/bootstrap
    if (method === 'GET' && pathname === '/api/bootstrap') {
      const sidebar = getSidebarData();
      const settings = getSettings();
      return sendJson(res, 200, {
        ...sidebar,
        settings,
        syncState
      });
    }

    // GET /api/sync/status
    if (method === 'GET' && pathname === '/api/sync/status') {
      return sendJson(res, 200, {
        syncState,
        sidebar: getSidebarData()
      });
    }

    // POST /api/sync
    if (method === 'POST' && pathname === '/api/sync') {
      const body = await readJsonBody(req);
      const feedId = body.feedId ? Number(body.feedId) : null;
      const result = await syncFeeds(feedId);
      return sendJson(res, 200, {
        syncState: result,
        sidebar: getSidebarData()
      });
    }

    // GET /api/articles
    if (method === 'GET' && pathname === '/api/articles') {
      const filter = urlObj.searchParams.get('filter') || 'all';
      const categoryId = urlObj.searchParams.get('categoryId') || null;
      const feedId = urlObj.searchParams.get('feedId') || null;
      const search = urlObj.searchParams.get('search') || '';
      const unreadOnly = urlObj.searchParams.get('unreadOnly') === 'true';
      const limit = Math.min(200, Math.max(1, Number(urlObj.searchParams.get('limit') || 60)));
      const offset = Math.max(0, Number(urlObj.searchParams.get('offset') || 0));

      const data = getArticles({
        filter,
        categoryId,
        feedId,
        search,
        unreadOnly,
        limit,
        offset
      });
      return sendJson(res, 200, data);
    }

    // POST /api/articles/mark-all-read
    if (method === 'POST' && pathname === '/api/articles/mark-all-read') {
      const body = await readJsonBody(req);
      const updated = markAllRead({
        filter: body.filter,
        categoryId: body.categoryId,
        feedId: body.feedId,
        beforeDate: body.beforeDate
      });
      return sendJson(res, 200, {
        updated,
        sidebar: getSidebarData()
      });
    }

    // GET /api/articles/:id
    const articleMatch = /^\/api\/articles\/(\d+)$/.exec(pathname);
    if (method === 'GET' && articleMatch) {
      const id = Number(articleMatch[1]);
      const article = getArticleById(id);
      if (!article) return sendJson(res, 404, { error: 'Article introuvable' });
      return sendJson(res, 200, { article });
    }

    // PATCH /api/articles/:id (lu / non-lu, favori)
    if (method === 'PATCH' && articleMatch) {
      const id = Number(articleMatch[1]);
      const body = await readJsonBody(req);
      const existing = getArticleById(id);
      if (!existing) return sendJson(res, 404, { error: 'Article introuvable' });

      const isRead = body.is_read !== undefined ? (body.is_read ? 1 : 0) : existing.is_read;
      const isStarred = body.is_starred !== undefined ? (body.is_starred ? 1 : 0) : existing.is_starred;

      db.prepare(`UPDATE articles SET is_read = ?, is_starred = ? WHERE id = ?`).run(
        isRead,
        isStarred,
        id
      );

      return sendJson(res, 200, {
        article: getArticleById(id),
        sidebar: getSidebarData()
      });
    }

    // POST /api/articles/:id/extract (Mode "Article Complet" / Reader View)
    const extractMatch = /^\/api\/articles\/(\d+)\/extract$/.exec(pathname);
    if (method === 'POST' && extractMatch) {
      const id = Number(extractMatch[1]);
      const body = await readJsonBody(req).catch(() => ({}));
      const article = getArticleById(id);
      if (!article) return sendJson(res, 404, { error: 'Article introuvable' });

      if (article.full_content_html && !body.force) {
        return sendJson(res, 200, { article, cached: true });
      }

      if (!article.url) {
        return sendJson(res, 400, { error: "Cet article ne possède pas d'URL web source." });
      }

      const extracted = await extractFullArticle(article.url);
      if (extracted.contentHtml && extracted.contentHtml.length > 80) {
        db.prepare(`
          UPDATE articles
          SET
            full_content_html = ?,
            image_url = COALESCE(image_url, ?),
            reading_time_min = CASE WHEN ? > reading_time_min THEN ? ELSE reading_time_min END
          WHERE id = ?
        `).run(
          extracted.contentHtml,
          extracted.imageUrl || null,
          extracted.readingTimeMin || 1,
          extracted.readingTimeMin || 1,
          id
        );
      }

      return sendJson(res, 200, {
        article: getArticleById(id),
        cached: false
      });
    }

    // POST /api/feeds (Ajout d'un flux avec auto-découverte RSS)
    if (method === 'POST' && pathname === '/api/feeds') {
      const body = await readJsonBody(req);
      const rawUrl = (body.url || '').trim();
      if (!rawUrl) {
        return sendJson(res, 400, { error: 'Veuillez saisir une adresse URL de flux ou de site web.' });
      }

      const discovered = await discoverFeedUrl(rawUrl);
      const parsed = parseFeedContent(discovered.rawText, discovered.feedUrl);

      let categoryId = body.categoryId ? Number(body.categoryId) : null;
      if (!categoryId && body.categoryName) {
        const cat = getOrCreateCategory(body.categoryName);
        categoryId = cat.id;
      } else if (!categoryId) {
        const defaultCat = getOrCreateCategory('Général');
        categoryId = defaultCat.id;
      }

      const title = (body.title || '').trim() || parsed.title || 'Nouveau flux';
      const siteUrl = parsed.siteUrl || discovered.feedUrl;
      const faviconUrl = getFaviconUrl(siteUrl);
      const autoFull = body.autoFullContent ? 1 : 0;

      // Vérifier si le flux existe déjà
      const existing = db
        .prepare(`SELECT * FROM feeds WHERE xml_url = ?`)
        .get(discovered.feedUrl);

      let feedId;
      if (existing) {
        feedId = existing.id;
        db.prepare(`
          UPDATE feeds
          SET category_id = ?, title = ?, auto_full_content = ?
          WHERE id = ?
        `).run(categoryId, title, autoFull, feedId);
      } else {
        const insertRes = db
          .prepare(`
            INSERT INTO feeds (
              category_id, title, xml_url, site_url, description, favicon_url, auto_full_content, etag, last_modified, last_fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `)
          .run(
            categoryId,
            title,
            discovered.feedUrl,
            siteUrl,
            parsed.description || '',
            faviconUrl,
            autoFull,
            discovered.etag || null,
            discovered.lastModified || null
          );
        feedId = Number(insertRes.lastInsertRowid);
      }

      const inserted = upsertArticlesForFeed(feedId, parsed.items);
      enrichMissingThumbnails(feedId, 5).catch(() => {});

      return sendJson(res, 201, {
        feedId,
        inserted,
        sidebar: getSidebarData()
      });
    }

    // PATCH & DELETE /api/feeds/:id
    const feedMatch = /^\/api\/feeds\/(\d+)$/.exec(pathname);
    if (feedMatch && method === 'PATCH') {
      const id = Number(feedMatch[1]);
      const body = await readJsonBody(req);
      const existing = db.prepare(`SELECT * FROM feeds WHERE id = ?`).get(id);
      if (!existing) return sendJson(res, 404, { error: 'Flux introuvable' });

      let categoryId = existing.category_id;
      if (body.categoryName) {
        categoryId = getOrCreateCategory(body.categoryName).id;
      } else if (body.categoryId !== undefined) {
        categoryId = body.categoryId ? Number(body.categoryId) : null;
      }

      const title = body.title !== undefined ? String(body.title).trim() : existing.title;
      const autoFull =
        body.auto_full_content !== undefined
          ? body.auto_full_content
            ? 1
            : 0
          : existing.auto_full_content;

      db.prepare(`
        UPDATE feeds
        SET title = ?, category_id = ?, auto_full_content = ?
        WHERE id = ?
      `).run(title || existing.title, categoryId, autoFull, id);

      return sendJson(res, 200, { sidebar: getSidebarData() });
    }

    if (feedMatch && method === 'DELETE') {
      const id = Number(feedMatch[1]);
      db.prepare(`DELETE FROM feeds WHERE id = ?`).run(id);
      return sendJson(res, 200, { sidebar: getSidebarData() });
    }

    // POST /api/categories
    if (method === 'POST' && pathname === '/api/categories') {
      const body = await readJsonBody(req);
      if (!body.name || !String(body.name).trim()) {
        return sendJson(res, 400, { error: 'Nom de catégorie requis' });
      }
      const cat = getOrCreateCategory(body.name);
      if (body.color) {
        db.prepare(`UPDATE categories SET color = ? WHERE id = ?`).run(body.color, cat.id);
      }
      return sendJson(res, 201, {
        category: cat,
        sidebar: getSidebarData()
      });
    }

    // DELETE /api/categories/:id
    const catMatch = /^\/api\/categories\/(\d+)$/.exec(pathname);
    if (catMatch && method === 'DELETE') {
      const id = Number(catMatch[1]);
      db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
      return sendJson(res, 200, { sidebar: getSidebarData() });
    }

    // POST /api/opml/import
    if (method === 'POST' && pathname === '/api/opml/import') {
      const body = await readJsonBody(req);
      const opmlText = body.opml || '';
      const parsedFeeds = parseOpml(opmlText);

      if (parsedFeeds.length === 0) {
        return sendJson(res, 400, { error: 'Aucun flux RSS détecté dans ce fichier OPML.' });
      }

      if (body.replaceExisting) {
        db.exec(`DELETE FROM feeds; DELETE FROM categories;`);
      }

      const insertFeed = db.prepare(`
        INSERT OR IGNORE INTO feeds (category_id, title, xml_url, site_url, description, favicon_url)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      let importedCount = 0;
      for (const item of parsedFeeds) {
        const cat = getOrCreateCategory(item.category || 'Général');
        const siteUrl = item.siteUrl || item.xmlUrl;
        const resInsert = insertFeed.run(
          cat.id,
          item.title || item.xmlUrl,
          item.xmlUrl,
          siteUrl,
          item.description || '',
          getFaviconUrl(siteUrl)
        );
        if (resInsert.changes > 0) importedCount++;
      }

      // Lancer la synchronisation en arrière-plan pour récupérer tous les articles immédiatement
      syncFeeds().catch((err) => console.error('Erreur synchro post-OPML:', err));

      return sendJson(res, 200, {
        totalFound: parsedFeeds.length,
        importedCount,
        sidebar: getSidebarData(),
        syncState
      });
    }

    // GET /api/opml/export
    if (method === 'GET' && pathname === '/api/opml/export') {
      const categories = db.prepare(`SELECT * FROM categories ORDER BY position ASC, name ASC`).all();
      const feeds = db.prepare(`SELECT * FROM feeds ORDER BY title ASC`).all();
      const xml = generateOpml(categories, feeds);
      res.writeHead(200, {
        'Content-Type': 'text/x-opml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="abonnements-flux-rss.opml"'
      });
      return res.end(xml);
    }

    // PATCH /api/settings
    if (method === 'PATCH' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const settings = updateSettings(body);
      return sendJson(res, 200, { settings });
    }

    return sendJson(res, 404, { error: 'Route API introuvable' });
  } catch (err) {
    console.error(`[API Error] ${method} ${pathname}:`, err);
    return sendJson(res, 500, { error: err.message || 'Erreur interne du serveur' });
  }
}

/**
 * Serveur de fichiers statiques + routeur API
 */
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj);
    return;
  }

  let safePath = path.normalize(decodeURIComponent(urlObj.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fallback SPA vers index.html
      const indexFile = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexFile, (indexErr, content) => {
        if (indexErr) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n✨ Flux RSS démarré sur http://localhost:${PORT}`);
  // Si la base ne contient encore aucun article, lancer une première synchronisation en tâche de fond
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM articles`).get().cnt;
  if (count === 0) {
    console.log('🔄 Première synchronisation des flux en cours...');
    syncFeeds().catch((err) => console.error('Erreur synchro initiale:', err));
  }
});

// Planificateur de synchronisation périodique (vérifie toutes les minutes si l'intervalle est atteint)
setInterval(() => {
  if (syncState.isSyncing) return;
  const settings = getSettings();
  const intervalMin = Math.max(5, parseInt(settings.refreshIntervalMin || '15', 10));
  if (!syncState.lastSyncAt) {
    syncFeeds().catch(() => {});
    return;
  }
  const elapsedMs = Date.now() - new Date(syncState.lastSyncAt).getTime();
  if (elapsedMs >= intervalMin * 60 * 1000) {
    syncFeeds().catch(() => {});
  }
}, 60 * 1000);

module.exports = { server, syncFeeds };
