/**
 * Serveur principal Flux RSS (HTTP + Authentification + API REST + Synchronisation en arrière-plan)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const {
  db,
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
} = require('./db');
const { generateDailyBriefing, performAiSearch } = require('./ai');
const {
  SESSION_COOKIE_NAME,
  parseCookies,
  buildSessionCookie,
  buildClearSessionCookie
} = require('./auth');
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
 * Enrichit en arrière-plan les vignettes (og:image) des articles récents sans image
 */
async function enrichMissingThumbnails(feedId, limit = 5) {
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
      // ignore
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
 * Synchronise les flux d'un utilisateur (ou tous les flux du serveur pour le cron)
 */
async function syncFeeds({ userId = null, feedId = null } = {}) {
  if (syncState.isSyncing && !feedId && !userId) {
    return syncState;
  }

  let feeds;
  if (feedId && userId) {
    feeds = db
      .prepare(`SELECT * FROM feeds WHERE id = ? AND user_id = ?`)
      .all(Number(feedId), Number(userId));
  } else if (userId) {
    feeds = db
      .prepare(`SELECT * FROM feeds WHERE user_id = ? ORDER BY id ASC`)
      .all(Number(userId));
  } else {
    feeds = db.prepare(`SELECT * FROM feeds ORDER BY id ASC`).all();
  }

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
 * Utilitaires HTTP JSON & Session
 */
function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
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
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function getAuthenticatedUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE_NAME];
  return getUserBySessionToken(token);
}

/**
 * Routeur API REST
 */
async function handleApi(req, res, urlObj) {
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  try {
    /* ======================================================================
       ROUTES PUBLIQUES D'AUTHENTIFICATION & INVITATIONS
       ====================================================================== */

    // GET /api/auth/session
    if (method === 'GET' && pathname === '/api/auth/session') {
      const user = getAuthenticatedUser(req);
      return sendJson(res, 200, {
        authenticated: Boolean(user),
        user: user || null
      });
    }

    // POST /api/auth/login
    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const user = authenticateUser(body.username, body.password);
      if (!user) {
        return sendJson(res, 401, { error: 'Identifiant ou mot de passe incorrect.' });
      }
      const session = createSession(user.id);
      return sendJson(
        res,
        200,
        { authenticated: true, user },
        { 'Set-Cookie': buildSessionCookie(session.token) }
      );
    }

    // POST /api/auth/logout
    if (method === 'POST' && pathname === '/api/auth/logout') {
      const cookies = parseCookies(req.headers.cookie || '');
      if (cookies[SESSION_COOKIE_NAME]) {
        deleteSession(cookies[SESSION_COOKIE_NAME]);
      }
      return sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': buildClearSessionCookie() }
      );
    }

    // GET /api/auth/invite/:token
    const inviteCheckMatch = /^\/api\/auth\/invite\/([a-f0-9]+)$/i.exec(pathname);
    if (method === 'GET' && inviteCheckMatch) {
      const inv = getInvitationByToken(inviteCheckMatch[1]);
      if (!inv || !inv.isValid) {
        return sendJson(res, 404, {
          valid: false,
          error: inv?.isUsed
            ? "Ce lien d'invitation a déjà été utilisé."
            : "Ce lien d'invitation est invalide ou a expiré."
        });
      }
      return sendJson(res, 200, {
        valid: true,
        label: inv.label,
        suggestedUsername: inv.suggested_username,
        role: inv.role,
        expiresAt: inv.expires_at
      });
    }

    // POST /api/auth/accept-invite
    if (method === 'POST' && pathname === '/api/auth/accept-invite') {
      const body = await readJsonBody(req);
      const user = acceptInvitation({
        token: body.token,
        username: body.username,
        displayName: body.displayName,
        password: body.password,
        seedFeeds: body.seedFeeds !== false
      });

      const session = createSession(user.id);
      syncFeeds({ userId: user.id }).catch(() => {});

      return sendJson(
        res,
        201,
        { authenticated: true, user },
        { 'Set-Cookie': buildSessionCookie(session.token) }
      );
    }

    /* ======================================================================
       TOUTES LES AUTRES ROUTES NÉCESSITENT D'ÊTRE CONNECTÉ
       ====================================================================== */
    const reqUser = getAuthenticatedUser(req);
    if (!reqUser) {
      return sendJson(res, 401, { error: 'Connexion requise' });
    }

    // POST /api/auth/password (Modifier son propre mot de passe)
    if (method === 'POST' && pathname === '/api/auth/password') {
      const body = await readJsonBody(req);
      const verified = authenticateUser(reqUser.username, body.currentPassword);
      if (!verified) {
        return sendJson(res, 400, { error: 'Votre mot de passe actuel est incorrect.' });
      }
      updateUserPassword(reqUser.id, body.newPassword);
      return sendJson(res, 200, { ok: true });
    }

    /* ======================================================================
       ROUTES D'ADMINISTRATION (RÉSERVÉES AUX COMPTES ADMIN)
       ====================================================================== */
    if (pathname.startsWith('/api/admin/')) {
      if (reqUser.role !== 'admin') {
        return sendJson(res, 403, { error: 'Accès réservé aux administrateurs.' });
      }

      // GET /api/admin/overview
      if (method === 'GET' && pathname === '/api/admin/overview') {
        return sendJson(res, 200, {
          users: listUsers(),
          invitations: listInvitations()
        });
      }

      // POST /api/admin/users (Créer directement un compte utilisateur)
      if (method === 'POST' && pathname === '/api/admin/users') {
        const body = await readJsonBody(req);
        const created = createUserAccount({
          username: body.username,
          displayName: body.displayName,
          password: body.password,
          role: body.role || 'user',
          seedFeeds: body.seedFeeds !== false
        });
        if (body.seedFeeds !== false) {
          syncFeeds({ userId: created.id }).catch(() => {});
        }
        return sendJson(res, 201, {
          user: created,
          users: listUsers()
        });
      }

      // PATCH /api/admin/users/:id/password (Réinitialiser le mot de passe d'un utilisateur)
      const adminUserPwdMatch = /^\/api\/admin\/users\/(\d+)\/password$/.exec(pathname);
      if (method === 'PATCH' && adminUserPwdMatch) {
        const targetId = Number(adminUserPwdMatch[1]);
        const body = await readJsonBody(req);
        updateUserPassword(targetId, body.newPassword);
        return sendJson(res, 200, { ok: true });
      }

      // DELETE /api/admin/users/:id
      const adminUserDelMatch = /^\/api\/admin\/users\/(\d+)$/.exec(pathname);
      if (method === 'DELETE' && adminUserDelMatch) {
        const targetId = Number(adminUserDelMatch[1]);
        deleteUserAccount(targetId, reqUser.id);
        return sendJson(res, 200, { users: listUsers() });
      }

      // POST /api/admin/invitations (Générer un lien d'invitation à usage unique)
      if (method === 'POST' && pathname === '/api/admin/invitations') {
        const body = await readJsonBody(req);
        const invitation = createInvitation({
          label: body.label || '',
          suggestedUsername: body.suggestedUsername || '',
          role: body.role || 'user',
          expiresInDays: body.expiresInDays || 7,
          createdBy: reqUser.id
        });
        return sendJson(res, 201, {
          invitation,
          invitations: listInvitations()
        });
      }

      // DELETE /api/admin/invitations/:id
      const adminInvDelMatch = /^\/api\/admin\/invitations\/(\d+)$/.exec(pathname);
      if (method === 'DELETE' && adminInvDelMatch) {
        deleteInvitation(Number(adminInvDelMatch[1]));
        return sendJson(res, 200, { invitations: listInvitations() });
      }
    }

    /* ======================================================================
       ROUTES FLUX RSS & ARTICLES (SCOPÉES À reqUser.id)
       ====================================================================== */

    // GET /api/bootstrap
    if (method === 'GET' && pathname === '/api/bootstrap') {
      const sidebar = getSidebarData(reqUser.id);
      const settings = getSettings(reqUser.id);
      return sendJson(res, 200, {
        user: reqUser,
        ...sidebar,
        settings,
        syncState
      });
    }

    // GET /api/sync/status
    if (method === 'GET' && pathname === '/api/sync/status') {
      return sendJson(res, 200, {
        syncState,
        sidebar: getSidebarData(reqUser.id)
      });
    }

    // POST /api/sync
    if (method === 'POST' && pathname === '/api/sync') {
      const body = await readJsonBody(req);
      const feedId = body.feedId ? Number(body.feedId) : null;
      const result = await syncFeeds({ userId: reqUser.id, feedId });
      return sendJson(res, 200, {
        syncState: result,
        sidebar: getSidebarData(reqUser.id)
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

      const data = getArticles(reqUser.id, {
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
      const updated = markAllRead(reqUser.id, {
        filter: body.filter,
        categoryId: body.categoryId,
        feedId: body.feedId,
        beforeDate: body.beforeDate
      });
      return sendJson(res, 200, {
        updated,
        sidebar: getSidebarData(reqUser.id)
      });
    }

    // GET /api/articles/:id
    const articleMatch = /^\/api\/articles\/(\d+)$/.exec(pathname);
    if (method === 'GET' && articleMatch) {
      const id = Number(articleMatch[1]);
      const article = getArticleById(reqUser.id, id);
      if (!article) return sendJson(res, 404, { error: 'Article introuvable' });
      return sendJson(res, 200, { article });
    }

    // PATCH /api/articles/:id
    if (method === 'PATCH' && articleMatch) {
      const id = Number(articleMatch[1]);
      const body = await readJsonBody(req);
      const existing = getArticleById(reqUser.id, id);
      if (!existing) return sendJson(res, 404, { error: 'Article introuvable' });

      const isRead = body.is_read !== undefined ? (body.is_read ? 1 : 0) : existing.is_read;
      const isStarred = body.is_starred !== undefined ? (body.is_starred ? 1 : 0) : existing.is_starred;

      db.prepare(`UPDATE articles SET is_read = ?, is_starred = ? WHERE id = ?`).run(
        isRead,
        isStarred,
        id
      );

      return sendJson(res, 200, {
        article: getArticleById(reqUser.id, id),
        sidebar: getSidebarData(reqUser.id)
      });
    }

    // POST /api/articles/:id/extract
    const extractMatch = /^\/api\/articles\/(\d+)\/extract$/.exec(pathname);
    if (method === 'POST' && extractMatch) {
      const id = Number(extractMatch[1]);
      const body = await readJsonBody(req).catch(() => ({}));
      const article = getArticleById(reqUser.id, id);
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
        article: getArticleById(reqUser.id, id),
        cached: false
      });
    }

    // POST /api/feeds
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
        const cat = getOrCreateCategory(reqUser.id, body.categoryName);
        categoryId = cat.id;
      } else if (!categoryId) {
        const defaultCat = getOrCreateCategory(reqUser.id, 'Général');
        categoryId = defaultCat.id;
      }

      const title = (body.title || '').trim() || parsed.title || 'Nouveau flux';
      const siteUrl = parsed.siteUrl || discovered.feedUrl;
      const faviconUrl = getFaviconUrl(siteUrl);
      const autoFull = body.autoFullContent ? 1 : 0;

      const existing = db
        .prepare(`SELECT * FROM feeds WHERE user_id = ? AND xml_url = ?`)
        .get(reqUser.id, discovered.feedUrl);

      let feedId;
      if (existing) {
        feedId = existing.id;
        db.prepare(`
          UPDATE feeds
          SET category_id = ?, title = ?, auto_full_content = ?
          WHERE id = ? AND user_id = ?
        `).run(categoryId, title, autoFull, feedId, reqUser.id);
      } else {
        const insertRes = db
          .prepare(`
            INSERT INTO feeds (
              user_id, category_id, title, xml_url, site_url, description, favicon_url, auto_full_content, etag, last_modified, last_fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `)
          .run(
            reqUser.id,
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
        sidebar: getSidebarData(reqUser.id)
      });
    }

    // PATCH & DELETE /api/feeds/:id
    const feedMatch = /^\/api\/feeds\/(\d+)$/.exec(pathname);
    if (feedMatch && method === 'PATCH') {
      const id = Number(feedMatch[1]);
      const body = await readJsonBody(req);
      const existing = db
        .prepare(`SELECT * FROM feeds WHERE id = ? AND user_id = ?`)
        .get(id, reqUser.id);
      if (!existing) return sendJson(res, 404, { error: 'Flux introuvable' });

      let categoryId = existing.category_id;
      if (body.categoryName) {
        categoryId = getOrCreateCategory(reqUser.id, body.categoryName).id;
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
        WHERE id = ? AND user_id = ?
      `).run(title || existing.title, categoryId, autoFull, id, reqUser.id);

      return sendJson(res, 200, { sidebar: getSidebarData(reqUser.id) });
    }

    if (feedMatch && method === 'DELETE') {
      const id = Number(feedMatch[1]);
      db.prepare(`DELETE FROM feeds WHERE id = ? AND user_id = ?`).run(id, reqUser.id);
      return sendJson(res, 200, { sidebar: getSidebarData(reqUser.id) });
    }

    // POST /api/categories
    if (method === 'POST' && pathname === '/api/categories') {
      const body = await readJsonBody(req);
      if (!body.name || !String(body.name).trim()) {
        return sendJson(res, 400, { error: 'Nom de catégorie requis' });
      }
      const cat = getOrCreateCategory(reqUser.id, body.name);
      if (body.color) {
        db.prepare(`UPDATE categories SET color = ? WHERE id = ? AND user_id = ?`).run(
          body.color,
          cat.id,
          reqUser.id
        );
      }
      return sendJson(res, 201, {
        category: cat,
        sidebar: getSidebarData(reqUser.id)
      });
    }

    // DELETE /api/categories/:id
    const catMatch = /^\/api\/categories\/(\d+)$/.exec(pathname);
    if (catMatch && method === 'DELETE') {
      const id = Number(catMatch[1]);
      db.prepare(`DELETE FROM categories WHERE id = ? AND user_id = ?`).run(id, reqUser.id);
      return sendJson(res, 200, { sidebar: getSidebarData(reqUser.id) });
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
        db.prepare(`DELETE FROM feeds WHERE user_id = ?`).run(reqUser.id);
        db.prepare(`DELETE FROM categories WHERE user_id = ?`).run(reqUser.id);
      }

      const insertFeed = db.prepare(`
        INSERT OR IGNORE INTO feeds (user_id, category_id, title, xml_url, site_url, description, favicon_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      let importedCount = 0;
      for (const item of parsedFeeds) {
        const cat = getOrCreateCategory(reqUser.id, item.category || 'Général');
        const siteUrl = item.siteUrl || item.xmlUrl;
        const resInsert = insertFeed.run(
          reqUser.id,
          cat.id,
          item.title || item.xmlUrl,
          item.xmlUrl,
          siteUrl,
          item.description || '',
          getFaviconUrl(siteUrl)
        );
        if (resInsert.changes > 0) importedCount++;
      }

      syncFeeds({ userId: reqUser.id }).catch((err) => console.error('Erreur synchro post-OPML:', err));

      return sendJson(res, 200, {
        totalFound: parsedFeeds.length,
        importedCount,
        sidebar: getSidebarData(reqUser.id),
        syncState
      });
    }

    // GET /api/opml/export
    if (method === 'GET' && pathname === '/api/opml/export') {
      const categories = db
        .prepare(`SELECT * FROM categories WHERE user_id = ? ORDER BY position ASC, name ASC`)
        .all(reqUser.id);
      const feeds = db
        .prepare(`SELECT * FROM feeds WHERE user_id = ? ORDER BY title ASC`)
        .all(reqUser.id);
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
      const settings = updateSettings(reqUser.id, body);
      return sendJson(res, 200, { settings });
    }

    // GET ou POST /api/ai/briefing (Synthèse IA des articles les plus importants du jour)
    if ((method === 'GET' || method === 'POST') && pathname === '/api/ai/briefing') {
      const recentArticles = getRecentArticlesForBriefing(reqUser.id);
      const settings = getSettings(reqUser.id);
      const briefing = await generateDailyBriefing(recentArticles, settings);
      return sendJson(res, 200, { briefing });
    }

    // POST /api/ai/search (Recherche sémantique & Question-Réponse IA, ex: CVE, thèmes...)
    if (method === 'POST' && pathname === '/api/ai/search') {
      const body = await readJsonBody(req);
      const allArticles = getAllArticlesForSearch(reqUser.id, 500);
      const settings = getSettings(reqUser.id);
      const searchResult = await performAiSearch(body.query, allArticles, settings);
      return sendJson(res, 200, searchResult);
    }

    return sendJson(res, 404, { error: 'Route API introuvable' });
  } catch (err) {
    console.error(`[API Error] ${method} ${pathname}:`, err);
    return sendJson(res, 500, { error: err.message || 'Erreur interne du serveur' });
  }
}

/**
 * Serveur HTTP
 */
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (urlObj.pathname.startsWith('/api/')) {
    handleApi(req, res, urlObj);
    return;
  }

  let safePath = path.normalize(decodeURIComponent(urlObj.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (safePath === '/' || safePath === '\\' || safePath === '/login') {
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
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM articles`).get().cnt;
  const unfetched = db.prepare(`SELECT COUNT(*) AS cnt FROM feeds WHERE last_fetched_at IS NULL`).get().cnt;
  if (count === 0 || unfetched > 0) {
    console.log('🔄 Synchronisation des flux en cours...');
    syncFeeds().catch((err) => console.error('Erreur synchro initiale:', err));
  }
});

// Planificateur de synchronisation périodique (toutes les 15 minutes par défaut)
setInterval(() => {
  if (syncState.isSyncing) return;
  if (!syncState.lastSyncAt) {
    syncFeeds().catch(() => {});
    return;
  }
  const elapsedMs = Date.now() - new Date(syncState.lastSyncAt).getTime();
  if (elapsedMs >= 15 * 60 * 1000) {
    syncFeeds().catch(() => {});
  }
}, 60 * 1000);

module.exports = { server, syncFeeds };
