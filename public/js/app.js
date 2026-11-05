/**
 * Logique cliente de l'application Flux RSS
 */

const state = {
  categories: [],
  feeds: [],
  counts: { all: 0, unread: 0, starred: 0, today: 0 },
  settings: {
    theme: 'light',
    viewMode: 'editorial',
    readerFontFamily: 'sans',
    readerFontSize: 'medium'
  },
  filter: 'all', // 'all', 'unread', 'today', 'starred'
  categoryId: null,
  feedId: null,
  unreadOnly: false,
  search: '',
  articles: [],
  totalArticles: 0,
  offset: 0,
  limit: 60,
  selectedArticleId: null,
  selectedArticle: null,
  showingFullContent: false,
  collapsedCategories: new Set(),
  opmlFileContent: null,
  syncPollTimer: null
};

const els = {
  sidebar: document.getElementById('sidebar'),
  categoriesTree: document.getElementById('categories-tree'),
  badgeAll: document.getElementById('badge-all'),
  badgeUnread: document.getElementById('badge-unread'),
  badgeToday: document.getElementById('badge-today'),
  badgeStarred: document.getElementById('badge-starred'),
  syncDot: document.getElementById('sync-dot'),
  syncText: document.getElementById('sync-text'),
  syncIcon: document.getElementById('sync-icon'),
  syncProgressBar: document.getElementById('sync-progress-bar'),
  syncProgressFill: document.getElementById('sync-progress-fill'),
  currentViewTitle: document.getElementById('current-view-title'),
  currentViewSubtitle: document.getElementById('current-view-subtitle'),
  searchInput: document.getElementById('search-input'),
  btnToggleUnreadOnly: document.getElementById('btn-toggle-unread-only'),
  articlesScroll: document.getElementById('articles-scroll-container'),
  articlesList: document.getElementById('articles-list'),
  loadMoreContainer: document.getElementById('load-more-container'),
  btnLoadMore: document.getElementById('btn-load-more'),
  readerPane: document.getElementById('reader-pane'),
  readerScroll: document.getElementById('reader-scroll'),
  readerArticle: document.getElementById('reader-article'),
  btnExtractFull: document.getElementById('btn-extract-full'),
  btnReaderToggleRead: document.getElementById('btn-reader-toggle-read'),
  btnReaderStar: document.getElementById('btn-reader-star'),
  btnReaderExternal: document.getElementById('btn-reader-external'),
  typographyPopover: document.getElementById('typography-popover'),
  toastContainer: document.getElementById('toast-container')
};

/* ==========================================================================
   INITIALISATION & API
   ========================================================================== */

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Erreur HTTP ${res.status}`);
  }
  return data;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

async function initApp() {
  bindEvents();
  try {
    const data = await apiFetch('/api/bootstrap');
    applySidebarData(data);
    applySettings(data.settings || {});
    updateSyncStatusUI(data.syncState);
    await loadArticles({ reset: true });

    if (data.syncState?.isSyncing || data.counts?.all === 0) {
      startSyncPolling();
    }
  } catch (err) {
    showToast('Impossible de charger les données initiales : ' + err.message);
  }
}

function applySettings(settings) {
  state.settings = { ...state.settings, ...settings };
  const theme = state.settings.theme || 'light';
  document.documentElement.setAttribute('data-theme', theme);

  const viewMode = state.settings.viewMode || 'editorial';
  setViewModeUI(viewMode);

  const font = state.settings.readerFontFamily || 'sans';
  const size = state.settings.readerFontSize || 'medium';
  updateTypographyClasses(font, size);
}

function applySidebarData(data) {
  if (!data) return;
  if (data.categories) state.categories = data.categories;
  if (data.feeds) state.feeds = data.feeds;
  if (data.counts) state.counts = data.counts;
  renderSidebar();
}

/* ==========================================================================
   BARRE LATÉRALE : NAVIGATION & ARBORESCENCE
   ========================================================================== */

function renderSidebar() {
  els.badgeAll.textContent = state.counts.all || 0;
  els.badgeUnread.textContent = state.counts.unread || 0;
  els.badgeToday.textContent = state.counts.today || 0;
  els.badgeStarred.textContent = state.counts.starred || 0;

  document.querySelectorAll('.sidebar-nav .nav-item[data-filter]').forEach((btn) => {
    const isActive =
      !state.categoryId && !state.feedId && btn.dataset.filter === state.filter;
    btn.classList.toggle('active', isActive);
  });

  const feedsByCat = new Map();
  for (const cat of state.categories) {
    feedsByCat.set(cat.id, []);
  }
  const uncategorized = [];

  for (const feed of state.feeds) {
    if (feed.category_id && feedsByCat.has(feed.category_id)) {
      feedsByCat.get(feed.category_id).push(feed);
    } else {
      uncategorized.push(feed);
    }
  }

  let html = '';

  for (const cat of state.categories) {
    const catFeeds = feedsByCat.get(cat.id) || [];
    const catUnread = catFeeds.reduce((sum, f) => sum + (Number(f.unread_count) || 0), 0);
    const isCollapsed = state.collapsedCategories.has(cat.id);
    const isCatActive = Number(state.categoryId) === Number(cat.id) && !state.feedId;

    html += `
      <div class="category-group ${isCollapsed ? 'collapsed' : ''}" data-cat-group="${cat.id}">
        <div class="category-row ${isCatActive ? 'active' : ''}" data-category-id="${cat.id}">
          <div class="category-row-left">
            <svg class="category-chevron" data-toggle-cat="${cat.id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
            <span class="category-dot" style="background:${escapeHtml(cat.color || '#3b82f6')}"></span>
            <span class="feed-title-text">${escapeHtml(cat.name)}</span>
          </div>
          <span class="nav-badge">${catUnread > 0 ? catUnread : ''}</span>
        </div>
        <div class="category-feeds">
          ${catFeeds.map((f) => renderFeedNavRow(f)).join('')}
        </div>
      </div>
    `;
  }

  if (uncategorized.length > 0) {
    html += `
      <div class="category-group">
        <div class="category-feeds" style="padding-left:0">
          ${uncategorized.map((f) => renderFeedNavRow(f)).join('')}
        </div>
      </div>
    `;
  }

  els.categoriesTree.innerHTML = html;
  updateViewHeaderTitle();
}

function renderFeedNavRow(feed) {
  const isActive = Number(state.feedId) === Number(feed.id);
  const unread = Number(feed.unread_count) || 0;
  const favicon = feed.favicon_url || '';

  return `
    <div class="feed-nav-row ${isActive ? 'active' : ''}" data-feed-id="${feed.id}" title="${escapeHtml(feed.title)}${feed.last_error ? ' — Erreur : ' + escapeHtml(feed.last_error) : ''}">
      <div class="feed-nav-left">
        ${
          favicon
            ? `<img class="feed-favicon" src="${escapeHtml(favicon)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
            : `<span class="category-dot" style="background:var(--text-faint)"></span>`
        }
        <span class="feed-title-text">${escapeHtml(feed.title)}</span>
      </div>
      <div class="feed-nav-right">
        ${unread > 0 ? `<span class="nav-badge">${unread}</span>` : ''}
        <button class="feed-delete-btn" data-delete-feed="${feed.id}" title="Supprimer ce flux">✕</button>
      </div>
    </div>
  `;
}

function updateViewHeaderTitle() {
  if (state.feedId) {
    const feed = state.feeds.find((f) => Number(f.id) === Number(state.feedId));
    els.currentViewTitle.textContent = feed ? feed.title : 'Flux RSS';
    els.currentViewSubtitle.textContent = feed?.description || feed?.site_url || '';
    return;
  }

  if (state.categoryId) {
    const cat = state.categories.find((c) => Number(c.id) === Number(state.categoryId));
    els.currentViewTitle.textContent = cat ? cat.name : 'Dossier';
    els.currentViewSubtitle.textContent = 'Tous les flux de cette catégorie';
    return;
  }

  const titles = {
    all: ["Toute l'actualité", 'Fil éditorial en temps réel'],
    unread: ['Articles non lus', 'À découvrir'],
    today: ["Aujourd'hui", 'Publiés ces dernières 24 heures'],
    starred: ['Favoris & À lire plus tard', 'Vos articles conservés']
  };
  const [t, sub] = titles[state.filter] || titles.all;
  els.currentViewTitle.textContent = t;
  els.currentViewSubtitle.textContent = sub;
}

/* ==========================================================================
   CHARGEMENT & RENDU DES ARTICLES (STYLE 01NET ÉPURÉ)
   ========================================================================== */

async function loadArticles({ reset = false } = {}) {
  if (reset) {
    state.offset = 0;
  }

  const params = new URLSearchParams({
    filter: state.filter,
    limit: String(state.limit),
    offset: String(state.offset)
  });

  if (state.categoryId) params.set('categoryId', String(state.categoryId));
  if (state.feedId) params.set('feedId', String(state.feedId));
  if (state.unreadOnly) params.set('unreadOnly', 'true');
  if (state.search.trim()) params.set('search', state.search.trim());

  const data = await apiFetch(`/api/articles?${params.toString()}`);
  state.totalArticles = data.total || 0;

  if (reset) {
    state.articles = data.articles || [];
    els.articlesScroll.scrollTop = 0;
  } else {
    state.articles = [...state.articles, ...(data.articles || [])];
  }

  renderArticlesList();
}

function getDateSectionLabel(isoDate) {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return 'Récemment';

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86400000);

  if (d >= todayStart) return "Aujourd'hui";
  if (d >= yesterdayStart) return 'Hier';
  if (d >= weekStart) return 'Cette semaine';

  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatRelativeTime(isoDate) {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '';

  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return "À l'instant";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Il y a ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `Il y a ${diffHours} h`;

  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderArticlesList() {
  if (state.articles.length === 0) {
    els.articlesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M4 11a9 9 0 0 1 9 9" />
            <path d="M4 4a16 16 0 0 1 16 16" />
            <circle cx="5" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </div>
        <h3>Aucun article à afficher</h3>
        <p>${
          state.syncPollTimer
            ? 'Synchronisation de vos flux RSS en cours, les articles arrivent dans quelques secondes…'
            : 'Tous vos articles ont été lus ou aucun article ne correspond à ce filtre.'
        }</p>
        <button class="btn-primary" onclick="triggerSync()">Actualiser les flux</button>
      </div>
    `;
    els.loadMoreContainer.classList.add('hidden');
    return;
  }

  let html = '';
  let lastGroupLabel = '';

  for (const article of state.articles) {
    const groupLabel = getDateSectionLabel(article.published_at);
    if (groupLabel !== lastGroupLabel) {
      lastGroupLabel = groupLabel;
      html += `<div class="date-section-header">${escapeHtml(groupLabel)}</div>`;
    }
    html += renderArticleCard(article);
  }

  els.articlesList.innerHTML = html;

  if (state.articles.length < state.totalArticles) {
    els.loadMoreContainer.classList.remove('hidden');
  } else {
    els.loadMoreContainer.classList.add('hidden');
  }
}

function renderArticleCard(article) {
  const isRead = Boolean(article.is_read);
  const isStarred = Boolean(article.is_starred);
  const isSelected = Number(state.selectedArticleId) === Number(article.id);
  const relTime = formatRelativeTime(article.published_at);
  const hasThumb = Boolean(article.image_url);
  const favicon = article.feed_favicon_url || '';

  return `
    <article
      class="article-item ${isRead ? 'is-read' : ''} ${isStarred ? 'is-starred' : ''} ${isSelected ? 'selected' : ''}"
      data-article-id="${article.id}"
    >
      <div class="article-thumb-wrap">
        ${
          hasThumb
            ? `<img
                class="article-thumb"
                src="${escapeHtml(article.image_url)}"
                alt=""
                loading="lazy"
                referrerpolicy="no-referrer"
                onerror="this.parentElement.innerHTML='<div class=\\'article-thumb-fallback\\'><span>📰</span></div>'"
              />`
            : `<div class="article-thumb-fallback">
                ${
                  favicon
                    ? `<img src="${escapeHtml(favicon)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
                    : `<span>📰</span>`
                }
              </div>`
        }
      </div>

      <div class="article-body">
        <div class="article-meta">
          <span class="unread-indicator" title="Non lu"></span>
          <span class="meta-source">
            ${favicon ? `<img src="${escapeHtml(favicon)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
            <span>${escapeHtml(article.feed_title || 'Flux')}</span>
          </span>
          ${
            article.category_name
              ? `<span class="meta-category-pill">${escapeHtml(article.category_name)}</span>`
              : ''
          }
          <span class="meta-sep">•</span>
          <time class="meta-time" datetime="${escapeHtml(article.published_at)}">${escapeHtml(relTime)}</time>
        </div>

        <h2 class="article-title">${escapeHtml(article.title)}</h2>

        ${
          article.summary
            ? `<p class="article-excerpt">${escapeHtml(article.summary)}</p>`
            : ''
        }
      </div>

      <div class="article-quick-actions">
        <button
          class="quick-btn ${isStarred ? 'starred' : ''}"
          data-action="star"
          data-id="${article.id}"
          title="${isStarred ? 'Retirer des favoris' : 'Ajouter aux favoris'} (s)"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="${isStarred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>

        <button
          class="quick-btn"
          data-action="toggle-read"
          data-id="${article.id}"
          title="${isRead ? 'Marquer comme non-lu' : 'Marquer comme lu'} (m)"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="${isRead ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="7"/>
          </svg>
        </button>

        ${
          article.url
            ? `<a
                class="quick-btn"
                href="${escapeHtml(article.url)}"
                target="_blank"
                rel="noopener noreferrer"
                data-action="external"
                title="Ouvrir sur le site original (v)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M7 17L17 7M7 7h10v10"/>
                </svg>
              </a>`
            : ''
        }
      </div>
    </article>
  `;
}

/* ==========================================================================
   PANNEAU DE LECTURE INTÉGRÉ (READER VIEW)
   ========================================================================== */

async function openArticleInReader(articleId) {
  state.selectedArticleId = Number(articleId);
  state.showingFullContent = false;

  document.querySelectorAll('.article-item').forEach((el) => {
    el.classList.toggle('selected', Number(el.dataset.articleId) === state.selectedArticleId);
  });

  try {
    const { article } = await apiFetch(`/api/articles/${articleId}`);
    state.selectedArticle = article;
    els.readerPane.classList.remove('hidden');
    els.readerScroll.scrollTop = 0;

    // Si l'article a déjà du contenu complet extrait ou si l'option auto est activée
    if (article.full_content_html) {
      state.showingFullContent = true;
    }

    renderReaderArticle(article);

    // Marquer automatiquement comme lu à l'ouverture
    if (!article.is_read) {
      await toggleArticleRead(article.id, true, { silent: true });
    }

    // Si le flux est configuré pour toujours extraire l'article complet ou si le contenu RSS est très court (< 340 caractères)
    const plainLength = (article.summary || '').length;
    if (!article.full_content_html && (article.feed_auto_full_content || plainLength < 220)) {
      extractFullContentForCurrentArticle({ silent: true });
    }
  } catch (err) {
    showToast('Erreur à l’ouverture de l’article : ' + err.message);
  }
}

function renderReaderArticle(article) {
  if (!article) return;

  els.btnReaderExternal.href = article.url || '#';
  els.btnExtractFull.classList.toggle('active', state.showingFullContent);
  els.btnReaderStar.style.color = article.is_starred ? 'var(--star-color)' : '';
  els.btnReaderToggleRead.style.color = article.is_read ? '' : 'var(--accent)';

  const fullDate = new Date(article.published_at).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const bodyHtml =
    state.showingFullContent && article.full_content_html
      ? article.full_content_html
      : article.content_html || `<p>${escapeHtml(article.summary || '')}</p>`;

  // Éviter de dupliquer l'image principale si elle figure déjà dans le corps HTML
  const hasHeroInBody =
    article.image_url && bodyHtml.includes(article.image_url.split('?')[0]);

  let domainLabel = article.feed_title || 'le site original';
  try {
    if (article.url) {
      domainLabel = new URL(article.url).hostname.replace(/^www\./, '');
    }
  } catch {
    // ignore
  }

  els.readerArticle.innerHTML = `
    <div class="reader-header-meta">
      <span class="reader-source-badge">
        ${
          article.feed_favicon_url
            ? `<img src="${escapeHtml(article.feed_favicon_url)}" alt="" onerror="this.style.display='none'" />`
            : ''
        }
        <span>${escapeHtml(article.feed_title || 'Source')}</span>
      </span>
      ${
        article.category_name
          ? `<span class="meta-category-pill">${escapeHtml(article.category_name)}</span>`
          : ''
      }
      <span>•</span>
      <span>${article.reading_time_min || 1} min de lecture</span>
    </div>

    <h1 class="reader-title">${escapeHtml(article.title)}</h1>

    <div class="reader-byline">
      <span>${article.author ? `Par <strong>${escapeHtml(article.author)}</strong> • ` : ''}${escapeHtml(fullDate)}</span>
    </div>

    ${
      article.image_url && !hasHeroInBody
        ? `<img class="reader-hero-image" src="${escapeHtml(article.image_url)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
        : ''
    }

    <div class="reader-content">
      ${bodyHtml}
    </div>

    <div class="reader-footer-card">
      <span class="form-hint">Source : ${escapeHtml(article.feed_title || domainLabel)}</span>
      ${
        article.url
          ? `<a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" class="btn-external-site">
              <span>Lire l'article sur ${escapeHtml(domainLabel)}</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M7 17L17 7M7 7h10v10"/>
              </svg>
            </a>`
          : ''
      }
    </div>
  `;
}

async function extractFullContentForCurrentArticle({ silent = false, force = false } = {}) {
  const current = state.selectedArticle;
  if (!current) return;

  if (current.full_content_html && !force) {
    state.showingFullContent = !state.showingFullContent;
    renderReaderArticle(current);
    return;
  }

  const originalLabel = els.btnExtractFull.querySelector('span').textContent;
  els.btnExtractFull.querySelector('span').textContent = 'Extraction…';
  els.btnExtractFull.disabled = true;

  try {
    const { article } = await apiFetch(`/api/articles/${current.id}/extract`, {
      method: 'POST',
      body: JSON.stringify({ force })
    });

    if (state.selectedArticleId === article.id) {
      state.selectedArticle = article;
      if (article.full_content_html) {
        state.showingFullContent = true;
        renderReaderArticle(article);
      } else if (!silent) {
        showToast('Contenu complet non disponible sur cette page.');
      }
    }
  } catch (err) {
    if (!silent) {
      showToast('Impossible de récupérer la page complète : ' + err.message);
    }
  } finally {
    els.btnExtractFull.querySelector('span').textContent = originalLabel;
    els.btnExtractFull.disabled = false;
  }
}

function closeReader() {
  state.selectedArticleId = null;
  state.selectedArticle = null;
  els.readerPane.classList.add('hidden');
  els.readerPane.classList.remove('zen-mode');
  document.querySelectorAll('.article-item.selected').forEach((el) => el.classList.remove('selected'));
}

/* ==========================================================================
   ACTIONS SUR LES ARTICLES (LU / NON-LU, FAVORIS, NAVIGATION)
   ========================================================================== */

async function toggleArticleRead(articleId, targetState = null, { silent = false } = {}) {
  const idx = state.articles.findIndex((a) => Number(a.id) === Number(articleId));
  const currentVal = idx !== -1 ? Boolean(state.articles[idx].is_read) : Boolean(state.selectedArticle?.is_read);
  const nextVal = targetState !== null ? Boolean(targetState) : !currentVal;

  const data = await apiFetch(`/api/articles/${articleId}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_read: nextVal })
  });

  if (idx !== -1) {
    state.articles[idx].is_read = nextVal ? 1 : 0;
  }
  if (state.selectedArticle && Number(state.selectedArticle.id) === Number(articleId)) {
    state.selectedArticle.is_read = nextVal ? 1 : 0;
    els.btnReaderToggleRead.style.color = nextVal ? '' : 'var(--accent)';
  }

  const cardEl = document.querySelector(`.article-item[data-article-id="${articleId}"]`);
  if (cardEl) {
    cardEl.classList.toggle('is-read', nextVal);
  }

  applySidebarData(data.sidebar);
  if (!silent) {
    showToast(nextVal ? 'Marqué comme lu' : 'Marqué comme non-lu');
  }
}

async function toggleArticleStar(articleId) {
  const idx = state.articles.findIndex((a) => Number(a.id) === Number(articleId));
  const currentVal = idx !== -1 ? Boolean(state.articles[idx].is_starred) : Boolean(state.selectedArticle?.is_starred);
  const nextVal = !currentVal;

  const data = await apiFetch(`/api/articles/${articleId}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_starred: nextVal })
  });

  if (idx !== -1) {
    state.articles[idx].is_starred = nextVal ? 1 : 0;
  }
  if (state.selectedArticle && Number(state.selectedArticle.id) === Number(articleId)) {
    state.selectedArticle.is_starred = nextVal ? 1 : 0;
    els.btnReaderStar.style.color = nextVal ? 'var(--star-color)' : '';
  }

  renderArticlesList();
  applySidebarData(data.sidebar);
  showToast(nextVal ? 'Ajouté aux favoris ★' : 'Retiré des favoris');
}

function navigateRelativeArticle(direction) {
  if (state.articles.length === 0) return;
  const currentIdx = state.articles.findIndex((a) => Number(a.id) === Number(state.selectedArticleId));
  let nextIdx = 0;
  if (currentIdx === -1) {
    nextIdx = 0;
  } else {
    nextIdx = Math.min(state.articles.length - 1, Math.max(0, currentIdx + direction));
  }
  const target = state.articles[nextIdx];
  if (target && Number(target.id) !== Number(state.selectedArticleId)) {
    openArticleInReader(target.id);
    const card = document.querySelector(`.article-item[data-article-id="${target.id}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ==========================================================================
   SYNCHRONISATION & POLLING TEMPS RÉEL
   ========================================================================== */

async function triggerSync(feedId = null) {
  updateSyncStatusUI({ isSyncing: true, completed: 0, total: state.feeds.length || 1 });
  startSyncPolling();
  try {
    const data = await apiFetch('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ feedId })
    });
    updateSyncStatusUI(data.syncState);
    applySidebarData(data.sidebar);
    await loadArticles({ reset: true });
    if (data.syncState?.newArticles > 0) {
      showToast(`${data.syncState.newArticles} nouveaux articles récupérés`);
    } else {
      showToast('Tous vos flux sont à jour');
    }
  } catch (err) {
    showToast('Erreur de synchronisation : ' + err.message);
  } finally {
    stopSyncPolling();
  }
}

function startSyncPolling() {
  if (state.syncPollTimer) return;
  state.syncPollTimer = setInterval(async () => {
    try {
      const data = await apiFetch('/api/sync/status');
      updateSyncStatusUI(data.syncState);
      applySidebarData(data.sidebar);
      await loadArticles({ reset: true });
      if (!data.syncState?.isSyncing) {
        stopSyncPolling();
      }
    } catch {
      stopSyncPolling();
    }
  }, 2200);
}

function stopSyncPolling() {
  if (state.syncPollTimer) {
    clearInterval(state.syncPollTimer);
    state.syncPollTimer = null;
  }
}

function updateSyncStatusUI(syncState) {
  if (!syncState) return;
  if (syncState.isSyncing) {
    els.syncDot.classList.add('syncing');
    els.syncIcon.classList.add('spinning');
    els.syncProgressBar.classList.remove('hidden');
    const pct = syncState.total > 0 ? Math.max(12, Math.round((syncState.completed / syncState.total) * 100)) : 35;
    els.syncProgressFill.style.width = `${pct}%`;
    els.syncText.textContent = syncState.currentFeed
      ? `Synchro : ${syncState.currentFeed} (${syncState.completed}/${syncState.total})`
      : `Synchronisation (${syncState.completed}/${syncState.total})…`;
  } else {
    els.syncDot.classList.remove('syncing');
    els.syncIcon.classList.remove('spinning');
    els.syncProgressBar.classList.add('hidden');
    els.syncText.textContent = syncState.lastSyncAt
      ? `À jour • ${new Date(syncState.lastSyncAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
      : 'Flux prêts';
  }
}

/* ==========================================================================
   MODALES, AJOUT DE FLUX, IMPORT OPML & PRÉFÉRENCES
   ========================================================================== */

function openModal(id) {
  if (id === 'modal-add-feed') {
    const select = document.getElementById('select-feed-category');
    select.innerHTML = state.categories
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
      .join('');
    document.getElementById('add-feed-error').classList.add('hidden');
  }
  document.getElementById(id)?.classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

function setViewModeUI(mode) {
  state.settings.viewMode = mode;
  els.articlesList.className = `articles-list view-${mode}`;
  document.querySelectorAll('.view-switch-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.viewMode === mode);
  });
}

function updateTypographyClasses(font, size) {
  state.settings.readerFontFamily = font;
  state.settings.readerFontSize = size;
  els.readerArticle.className = `reader-article font-${font} size-${size}`;

  document.querySelectorAll('.font-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.font === font);
  });
  document.querySelectorAll('.size-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.size === size);
  });
}

/* ==========================================================================
   ÉVÉNEMENTS & RACCOURCIS CLAVIER
   ========================================================================== */

function bindEvents() {
  // Navigation principale (Toute l'actualité, Non lus, Aujourd'hui, Favoris)
  document.querySelectorAll('.sidebar-nav .nav-item[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      state.categoryId = null;
      state.feedId = null;
      els.sidebar.classList.remove('open');
      renderSidebar();
      loadArticles({ reset: true });
    });
  });

  // Clics dans l'arborescence des catégories et flux
  els.categoriesTree.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('[data-delete-feed]');
    if (deleteBtn) {
      e.stopPropagation();
      const feedId = Number(deleteBtn.dataset.deleteFeed);
      const feed = state.feeds.find((f) => Number(f.id) === feedId);
      if (confirm(`Supprimer le flux « ${feed?.title || ''} » ?`)) {
        const res = await apiFetch(`/api/feeds/${feedId}`, { method: 'DELETE' });
        if (Number(state.feedId) === feedId) {
          state.feedId = null;
        }
        applySidebarData(res.sidebar);
        await loadArticles({ reset: true });
        showToast('Flux supprimé');
      }
      return;
    }

    const toggleCat = e.target.closest('[data-toggle-cat]');
    if (toggleCat) {
      e.stopPropagation();
      const catId = Number(toggleCat.dataset.toggleCat);
      if (state.collapsedCategories.has(catId)) {
        state.collapsedCategories.delete(catId);
      } else {
        state.collapsedCategories.add(catId);
      }
      renderSidebar();
      return;
    }

    const catRow = e.target.closest('[data-category-id]');
    if (catRow) {
      state.categoryId = Number(catRow.dataset.categoryId);
      state.feedId = null;
      els.sidebar.classList.remove('open');
      renderSidebar();
      loadArticles({ reset: true });
      return;
    }

    const feedRow = e.target.closest('[data-feed-id]');
    if (feedRow) {
      state.feedId = Number(feedRow.dataset.feedId);
      state.categoryId = null;
      els.sidebar.classList.remove('open');
      renderSidebar();
      loadArticles({ reset: true });
    }
  });

  // Clics sur les cartes d'articles
  els.articlesList.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === 'external') {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const id = Number(actionBtn.dataset.id);
      if (action === 'star') toggleArticleStar(id);
      if (action === 'toggle-read') toggleArticleRead(id);
      return;
    }

    const card = e.target.closest('.article-item[data-article-id]');
    if (card) {
      openArticleInReader(Number(card.dataset.articleId));
    }
  });

  // Recherche avec debounce
  let searchTimer = null;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = els.searchInput.value;
      loadArticles({ reset: true });
    }, 220);
  });

  // Filtre Non lus uniquement
  els.btnToggleUnreadOnly.addEventListener('click', () => {
    state.unreadOnly = !state.unreadOnly;
    els.btnToggleUnreadOnly.classList.toggle('active', state.unreadOnly);
    loadArticles({ reset: true });
  });

  // Sélecteur de vue (Éditorial 01net / Compact / Grille)
  document.querySelectorAll('.view-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.viewMode;
      setViewModeUI(mode);
      apiFetch('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ viewMode: mode })
      }).catch(() => {});
    });
  });

  // Tout marquer comme lu
  document.getElementById('btn-mark-all-read').addEventListener('click', async () => {
    const res = await apiFetch('/api/articles/mark-all-read', {
      method: 'POST',
      body: JSON.stringify({
        filter: state.filter,
        categoryId: state.categoryId,
        feedId: state.feedId
      })
    });
    applySidebarData(res.sidebar);
    await loadArticles({ reset: true });
    showToast(`${res.updated || 0} articles marqués comme lus`);
  });

  // Actualiser
  document.getElementById('btn-sync').addEventListener('click', () => {
    triggerSync(state.feedId || null);
  });

  // Charger plus d'articles
  els.btnLoadMore.addEventListener('click', () => {
    state.offset += state.limit;
    loadArticles({ reset: false });
  });

  // Bascule Thème Clair / Sombre
  document.getElementById('btn-theme-toggle').addEventListener('click', () => {
    toggleTheme();
  });

  // Boutons du Panneau de lecture
  document.getElementById('btn-close-reader').addEventListener('click', closeReader);
  document.getElementById('btn-prev-article').addEventListener('click', () => navigateRelativeArticle(-1));
  document.getElementById('btn-next-article').addEventListener('click', () => navigateRelativeArticle(1));
  els.btnExtractFull.addEventListener('click', () => extractFullContentForCurrentArticle());
  els.btnReaderToggleRead.addEventListener('click', () => {
    if (state.selectedArticleId) toggleArticleRead(state.selectedArticleId);
  });
  els.btnReaderStar.addEventListener('click', () => {
    if (state.selectedArticleId) toggleArticleStar(state.selectedArticleId);
  });
  document.getElementById('btn-reader-zen').addEventListener('click', () => {
    els.readerPane.classList.toggle('zen-mode');
  });

  // Popover typographie
  document.getElementById('btn-typography').addEventListener('click', (e) => {
    e.stopPropagation();
    els.typographyPopover.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.typography-dropdown-wrapper')) {
      els.typographyPopover.classList.add('hidden');
    }
  });
  document.querySelectorAll('.font-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateTypographyClasses(btn.dataset.font, state.settings.readerFontSize);
      apiFetch('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ readerFontFamily: btn.dataset.font })
      }).catch(() => {});
    });
  });
  document.querySelectorAll('.size-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateTypographyClasses(state.settings.readerFontFamily, btn.dataset.size);
      apiFetch('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ readerFontSize: btn.dataset.size })
      }).catch(() => {});
    });
  });

  // Modales
  document.getElementById('btn-open-add-feed').addEventListener('click', () => openModal('modal-add-feed'));
  document.getElementById('btn-open-opml').addEventListener('click', () => openModal('modal-opml'));
  document.getElementById('btn-shortcuts').addEventListener('click', () => openModal('modal-shortcuts'));
  document.getElementById('btn-mobile-sidebar').addEventListener('click', () => {
    els.sidebar.classList.toggle('open');
  });

  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.classList.add('hidden');
    });
  });

  // Nouveau dossier rapide
  document.getElementById('btn-add-category').addEventListener('click', async () => {
    const name = prompt('Nom du nouveau dossier / catégorie :');
    if (!name || !name.trim()) return;
    const res = await apiFetch('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() })
    });
    applySidebarData(res.sidebar);
    showToast(`Dossier « ${name.trim()} » créé`);
  });

  // Soumission Ajouter un flux
  document.getElementById('form-add-feed').addEventListener('submit', async (e) => {
    e.preventDefault();
    const urlInput = document.getElementById('input-feed-url');
    const catSelect = document.getElementById('select-feed-category');
    const newCatInput = document.getElementById('input-new-category');
    const titleInput = document.getElementById('input-feed-title');
    const autoFullInput = document.getElementById('input-feed-autofull');
    const errBox = document.getElementById('add-feed-error');
    const submitBtn = document.getElementById('btn-submit-add-feed');

    errBox.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Détection & ajout…';

    try {
      const payload = {
        url: urlInput.value.trim(),
        categoryId: newCatInput.value.trim() ? null : catSelect.value,
        categoryName: newCatInput.value.trim() || null,
        title: titleInput.value.trim(),
        autoFullContent: autoFullInput.checked
      };

      const res = await apiFetch('/api/feeds', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      applySidebarData(res.sidebar);
      state.feedId = res.feedId;
      state.categoryId = null;
      renderSidebar();
      await loadArticles({ reset: true });

      urlInput.value = '';
      newCatInput.value = '';
      titleInput.value = '';
      autoFullInput.checked = false;
      closeModal('modal-add-feed');
      showToast(`Flux ajouté (${res.inserted} articles récupérés)`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Ajouter le flux';
    }
  });

  // Sélection et import de fichier OPML
  const opmlInput = document.getElementById('input-opml-file');
  const opmlLabel = document.getElementById('opml-file-label');
  const btnImportOpml = document.getElementById('btn-import-opml');
  const opmlStatus = document.getElementById('opml-status');

  opmlInput.addEventListener('change', async () => {
    const file = opmlInput.files?.[0];
    if (!file) return;
    state.opmlFileContent = await file.text();
    opmlLabel.innerHTML = `Fichier sélectionné : <strong>${escapeHtml(file.name)}</strong>`;
    btnImportOpml.disabled = false;
    opmlStatus.textContent = '';
  });

  btnImportOpml.addEventListener('click', async () => {
    if (!state.opmlFileContent) return;
    const replaceExisting = document.getElementById('input-opml-replace').checked;
    btnImportOpml.disabled = true;
    btnImportOpml.textContent = 'Importation en cours…';

    try {
      const res = await apiFetch('/api/opml/import', {
        method: 'POST',
        body: JSON.stringify({
          opml: state.opmlFileContent,
          replaceExisting
        })
      });

      applySidebarData(res.sidebar);
      closeModal('modal-opml');
      showToast(`${res.totalFound} flux détectés (${res.importedCount} nouveaux). Synchronisation lancée !`);
      startSyncPolling();
      await loadArticles({ reset: true });
    } catch (err) {
      opmlStatus.textContent = 'Erreur : ' + err.message;
    } finally {
      btnImportOpml.disabled = false;
      btnImportOpml.textContent = "Lancer l'importation OPML";
    }
  });

  // Raccourcis clavier globaux
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    if (e.key === 'Escape') {
      const openModalEl = document.querySelector('.modal-backdrop:not(.hidden)');
      if (openModalEl) {
        openModalEl.classList.add('hidden');
        return;
      }
      if (!els.readerPane.classList.contains('hidden')) {
        closeReader();
      }
      return;
    }

    if (e.key === 'j') {
      e.preventDefault();
      navigateRelativeArticle(1);
    } else if (e.key === 'k') {
      e.preventDefault();
      navigateRelativeArticle(-1);
    } else if (e.key === 'm' && state.selectedArticleId) {
      e.preventDefault();
      toggleArticleRead(state.selectedArticleId);
    } else if (e.key === 's' && state.selectedArticleId) {
      e.preventDefault();
      toggleArticleStar(state.selectedArticleId);
    } else if (e.key === 'f' && state.selectedArticleId) {
      e.preventDefault();
      extractFullContentForCurrentArticle();
    } else if (e.key === 'v' && state.selectedArticle?.url) {
      e.preventDefault();
      window.open(state.selectedArticle.url, '_blank', 'noopener,noreferrer');
    } else if (e.key === 'z' && state.selectedArticleId) {
      e.preventDefault();
      els.readerPane.classList.toggle('zen-mode');
    } else if (e.key === 'r') {
      e.preventDefault();
      triggerSync(state.feedId || null);
    } else if (e.key === '/') {
      e.preventDefault();
      els.searchInput.focus();
    } else if (e.key === 't') {
      e.preventDefault();
      toggleTheme();
    } else if (e.key === '?') {
      e.preventDefault();
      openModal('modal-shortcuts');
    }
  });
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  state.settings.theme = next;
  apiFetch('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ theme: next })
  }).catch(() => {});
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.triggerSync = triggerSync;
document.addEventListener('DOMContentLoaded', initApp);
