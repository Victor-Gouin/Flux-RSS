/**
 * Logique cliente de l'application Flux RSS (Authentification privée, Invitations, Admin & Reader)
 */

const state = {
  user: null,
  inviteToken: null,
  categories: [],
  feeds: [],
  counts: { all: 0, unread: 0, starred: 0, today: 0 },
  settings: {
    theme: 'light',
    viewMode: 'editorial',
    readerFontFamily: 'sans',
    readerFontSize: 'medium'
  },
  filter: 'all',
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
  syncPollTimer: null,
  eventsBound: false
};

const els = {
  authScreen: document.getElementById('auth-screen'),
  appShell: document.getElementById('app'),
  formLogin: document.getElementById('form-login'),
  formAcceptInvite: document.getElementById('form-accept-invite'),
  authSubtitle: document.getElementById('auth-subtitle'),
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
  toastContainer: document.getElementById('toast-container'),
  userAvatar: document.getElementById('user-avatar'),
  userDisplayName: document.getElementById('user-display-name'),
  userRoleBadge: document.getElementById('user-role-badge'),
  btnOpenAdmin: document.getElementById('btn-open-admin')
};

/* ==========================================================================
   INITIALISATION & AUTHENTIFICATION
   ========================================================================== */

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    showLoginScreen();
    throw new Error('Session expirée, veuillez vous reconnecter.');
  }
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
  }, 3400);
}

async function initApp() {
  if (!state.eventsBound) {
    bindEvents();
    state.eventsBound = true;
  }

  // Vérifier si l'URL contient un jeton d'invitation (?invite=...)
  const urlParams = new URLSearchParams(window.location.search);
  const inviteToken = urlParams.get('invite');
  if (inviteToken) {
    await checkAndShowInvitation(inviteToken);
    return;
  }

  // Vérifier la session courante
  try {
    const session = await apiFetch('/api/auth/session');
    if (session.authenticated && session.user) {
      state.user = session.user;
      await enterAuthenticatedApp();
    } else {
      showLoginScreen();
    }
  } catch {
    showLoginScreen();
  }
}

function showLoginScreen() {
  stopSyncPolling();
  state.user = null;
  els.appShell.classList.add('hidden');
  els.authScreen.classList.remove('hidden');
  els.formAcceptInvite.classList.add('hidden');
  els.formLogin.classList.remove('hidden');
  els.authSubtitle.textContent = 'Connectez-vous pour accéder à votre espace de veille';
  document.getElementById('login-error').classList.add('hidden');
}

async function checkAndShowInvitation(token) {
  els.appShell.classList.add('hidden');
  els.authScreen.classList.remove('hidden');
  els.formLogin.classList.add('hidden');
  els.formAcceptInvite.classList.remove('hidden');

  const banner = document.getElementById('invite-banner-info');
  const errBox = document.getElementById('invite-error');
  const submitBtn = document.getElementById('btn-invite-submit');
  errBox.classList.add('hidden');

  try {
    const info = await apiFetch(`/api/auth/invite/${encodeURIComponent(token)}`);
    state.inviteToken = token;
    els.authSubtitle.textContent = 'Activation de votre invitation personnelle';
    banner.textContent = info.label
      ? `Invitation pour « ${info.label} » (${info.role === 'admin' ? 'Administrateur' : 'Utilisateur'})`
      : 'Invitation valide — choisissez votre identifiant et votre mot de passe.';

    if (info.suggestedUsername) {
      document.getElementById('invite-username').value = info.suggestedUsername;
    }
    if (info.label) {
      document.getElementById('invite-display-name').value = info.label;
    }
    submitBtn.disabled = false;
  } catch (err) {
    banner.textContent = "Lien d'invitation invalide ou expiré.";
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
    submitBtn.disabled = true;
  }
}

async function enterAuthenticatedApp() {
  els.authScreen.classList.add('hidden');
  els.appShell.classList.remove('hidden');

  // Nettoyer l'URL si elle contenait ?invite=...
  if (window.location.search.includes('invite=')) {
    window.history.replaceState({}, document.title, '/');
  }

  try {
    const data = await apiFetch('/api/bootstrap');
    if (data.user) state.user = data.user;
    renderUserProfile();
    applySidebarData(data);
    applySettings(data.settings || {});
    updateSyncStatusUI(data.syncState);
    await loadArticles({ reset: true });

    if (data.syncState?.isSyncing || data.counts?.all === 0) {
      startSyncPolling();
    }
  } catch (err) {
    showToast('Impossible de charger les données : ' + err.message);
  }
}

function renderUserProfile() {
  if (!state.user) return;
  const name = state.user.displayName || state.user.username || 'U';
  els.userAvatar.textContent = name.charAt(0).toUpperCase();
  els.userDisplayName.textContent = name;
  const isAdmin = state.user.role === 'admin';
  els.userRoleBadge.textContent = isAdmin ? 'Admin' : 'Membre';
  els.btnOpenAdmin.classList.toggle('hidden', !isAdmin);
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
            <span class="category-dot" style="background:${escapeHtml(cat.color || '#64748b')}"></span>
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
    starred: ['Favoris & À lire plus tard', 'Vos articles conservés'],
    'ai-briefing': ['Résumé IA du jour', 'Synthèse intelligente des articles les plus importants'],
    'ai-search': ['Recherche & Veille IA', 'Recherche sémantique par thème, question ou CVE']
  };
  const [t, sub] = titles[state.filter] || titles.all;
  els.currentViewTitle.textContent = t;
  els.currentViewSubtitle.textContent = sub;
}

/* ==========================================================================
   CHARGEMENT & RENDU DES ARTICLES OU DES VUES IA
   ========================================================================== */

async function loadArticles({ reset = false } = {}) {
  if (!state.categoryId && !state.feedId && state.filter === 'ai-briefing') {
    await loadAiBriefingView();
    return;
  }
  if (!state.categoryId && !state.feedId && state.filter === 'ai-search') {
    renderAiSearchView();
    return;
  }

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

    if (article.full_content_html) {
      state.showingFullContent = true;
    }

    renderReaderArticle(article);

    if (!article.is_read) {
      await toggleArticleRead(article.id, true, { silent: true });
    }

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
   ACTIONS SUR LES ARTICLES
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
  if (currentIdx !== -1) {
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
   PANNEAU D'ADMINISTRATION (COMPTES & LIENS D'INVITATION)
   ========================================================================== */

async function openAdminModal(defaultTab = 'tab-invitations') {
  const isAdmin = state.user?.role === 'admin';
  const tabsBar = document.getElementById('admin-tabs-bar');
  tabsBar.querySelectorAll('[data-admin-tab="tab-invitations"], [data-admin-tab="tab-users"]').forEach((btn) => {
    btn.classList.toggle('hidden', !isAdmin);
  });

  // Pré-remplir les réglages IA
  document.getElementById('ai-provider-select').value = state.settings.aiProvider || 'local';
  document.getElementById('ai-api-key').value = state.settings.aiApiKey || '';
  document.getElementById('ai-model-name').value = state.settings.aiModel || '';

  const targetTab = isAdmin ? defaultTab : defaultTab === 'tab-ai-config' ? 'tab-ai-config' : 'tab-password';
  switchAdminTab(targetTab);
  document.getElementById('modal-admin').classList.remove('hidden');

  if (isAdmin) {
    await refreshAdminOverview();
  }
}

/* ==========================================================================
   VUES INTELLIGENCE ARTIFICIELLE : BRIEFING DU JOUR & RECHERCHE IA / CVE
   ========================================================================== */

async function loadAiBriefingView() {
  els.loadMoreContainer.classList.add('hidden');
  els.articlesList.innerHTML = `
    <div class="empty-state">
      <h3>Analyse et synthèse des articles du jour en cours…</h3>
      <p>Classement des sujets majeurs, détection des alertes CVE et regroupement thématique.</p>
    </div>
  `;

  try {
    const { briefing } = await apiFetch('/api/ai/briefing');
    renderAiBriefing(briefing);
  } catch (err) {
    els.articlesList.innerHTML = `
      <div class="empty-state">
        <h3>Impossible de générer la synthèse IA</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

function renderAiBriefing(briefing) {
  const timeStr = new Date(briefing.generatedAt).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit'
  });

  const keywordsHtml = (briefing.trendingKeywords || [])
    .map(
      (k) =>
        `<button class="ai-keyword-chip" data-ai-topic="${escapeHtml(k.keyword)}">#${escapeHtml(k.keyword)} (${k.count})</button>`
    )
    .join('');

  const topStoriesHtml = (briefing.topStories || [])
    .map((s) =>
      renderArticleCard({
        id: s.id,
        title: s.title,
        summary: s.summary,
        image_url: s.imageUrl,
        published_at: s.publishedAt,
        url: s.url,
        feed_title: s.feedTitle,
        feed_favicon_url: s.feedFavicon,
        category_name:
          s.securityIds && s.securityIds.length > 0 ? s.securityIds.join(', ') : s.theme,
        is_read: 0,
        is_starred: 0
      })
    )
    .join('');

  const securityHtml =
    briefing.securityAlerts && briefing.securityAlerts.length > 0
      ? `
      <div class="ai-section-block">
        <div class="ai-section-title">🛡️ Alertes Cybersécurité & CVE du jour</div>
        <div class="ai-theme-card">
          <ul class="ai-theme-list">
            ${briefing.securityAlerts
              .map(
                (a) => `
                <li class="ai-theme-item" data-open-article="${a.id}">
                  <strong>${escapeHtml(a.title)}</strong>
                  <span class="meta-sep">•</span>
                  <span class="ai-meta-label">${escapeHtml(a.feedTitle)}</span>
                  ${(a.securityIds || [])
                    .map((id) => `<span class="cve-badge">${escapeHtml(id)}</span>`)
                    .join('')}
                </li>
              `
              )
              .join('')}
          </ul>
        </div>
      </div>
    `
      : '';

  const thematicHtml = (briefing.thematicSections || [])
    .map(
      (sec) => `
      <div class="ai-theme-card">
        <h4>${escapeHtml(sec.theme)}</h4>
        <ul class="ai-theme-list">
          ${sec.items
            .map(
              (item) => `
              <li class="ai-theme-item" data-open-article="${item.id}">
                <strong>${escapeHtml(item.title)}</strong>
                <span class="ai-meta-label"> — ${escapeHtml(item.feedTitle)}</span>
                ${(item.securityIds || [])
                  .map((id) => `<span class="cve-badge">${escapeHtml(id)}</span>`)
                  .join('')}
              </li>
            `
            )
            .join('')}
        </ul>
      </div>
    `
    )
    .join('');

  els.articlesList.innerHTML = `
    <div class="ai-container">
      <div class="ai-hero-card">
        <div class="ai-hero-top">
          <div class="ai-badge-row">
            <span class="ai-pill-badge">✨ Synthèse IA du Jour</span>
            <span class="ai-meta-label">${briefing.totalAnalyzed || 0} articles analysés • Généré à ${timeStr} • ${escapeHtml(briefing.providerUsed || 'IA')}</span>
          </div>
          <div class="ai-badge-row">
            <button class="btn-xs" id="btn-refresh-briefing">Régénérer</button>
            <button class="btn-xs" id="btn-open-ai-settings">Configurer l'IA</button>
          </div>
        </div>

        <p class="ai-overview-text">${escapeHtml(briefing.overview || '')}</p>

        ${
          keywordsHtml
            ? `<div class="ai-keywords-row">
                <span class="ai-meta-label">Sujets dominants :</span>
                ${keywordsHtml}
              </div>`
            : ''
        }
      </div>

      ${securityHtml}

      <div class="ai-section-block">
        <div class="ai-section-title">🔥 Les actualités les plus importantes du jour</div>
        <div>${topStoriesHtml || '<p class="form-hint">Aucun article récent.</p>'}</div>
      </div>

      ${
        thematicHtml
          ? `<div class="ai-section-block">
              <div class="ai-section-title">📂 Synthèse par thématique</div>
              <div class="ai-thematic-grid">${thematicHtml}</div>
            </div>`
          : ''
      }
    </div>
  `;

  document.getElementById('btn-refresh-briefing')?.addEventListener('click', loadAiBriefingView);
  document.getElementById('btn-open-ai-settings')?.addEventListener('click', () =>
    openAdminModal('tab-ai-config')
  );
}

function renderAiSearchView(initialQuery = '') {
  els.loadMoreContainer.classList.add('hidden');
  els.articlesList.innerHTML = `
    <div class="ai-container">
      <div class="ai-hero-card">
        <div class="ai-hero-top">
          <div class="ai-badge-row">
            <span class="ai-pill-badge">🔍 Recherche Sémantique & Veille IA</span>
            <span class="ai-meta-label">Trouvez des articles par thème ou posez une question (ex: dernières CVE)</span>
          </div>
          <button class="btn-xs" id="btn-ai-search-settings">Configurer l'IA</button>
        </div>

        <form id="form-ai-query" class="ai-search-form">
          <input
            id="input-ai-query"
            class="ai-search-input"
            type="text"
            placeholder="Ex : Quelles sont les dernières CVE sorties ? / Articles qui parlent d'IA ou de processeurs..."
            value="${escapeHtml(initialQuery)}"
            autofocus
          />
          <button type="submit" class="btn-primary">Demander à l'IA</button>
        </form>

        <div class="ai-suggestions-row">
          <button type="button" class="ai-suggestion-pill" data-ai-suggest="Quelles sont les dernières CVE et failles de sécurité sorties ?">
            🛡️ Dernières CVE & failles de sécurité
          </button>
          <button type="button" class="ai-suggestion-pill" data-ai-suggest="Quels articles parlent d'Intelligence Artificielle et de LLM ?">
            🤖 Articles sur l'IA & LLM
          </button>
          <button type="button" class="ai-suggestion-pill" data-ai-suggest="Quelles sont les dernières actualités Hardware, processeurs et cartes graphiques ?">
            💻 Actualités Hardware & GPU
          </button>
          <button type="button" class="ai-suggestion-pill" data-ai-suggest="Articles qui parlent de Linux, Docker ou logiciels libres">
            🐧 Linux & Open Source
          </button>
        </div>
      </div>

      <div id="ai-search-results-area"></div>
    </div>
  `;

  document.getElementById('btn-ai-search-settings')?.addEventListener('click', () =>
    openAdminModal('tab-ai-config')
  );

  const form = document.getElementById('form-ai-query');
  const input = document.getElementById('input-ai-query');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    executeAiQuery(input.value.trim());
  });

  document.querySelectorAll('[data-ai-suggest]').forEach((btn) => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.aiSuggest;
      executeAiQuery(btn.dataset.aiSuggest);
    });
  });

  if (initialQuery) {
    executeAiQuery(initialQuery);
  }
}

async function executeAiQuery(query) {
  if (!query) return;
  const area = document.getElementById('ai-search-results-area');
  if (!area) return;

  area.innerHTML = `
    <div class="empty-state" style="padding:36px 16px">
      <h3>Recherche sémantique et synthèse IA en cours…</h3>
      <p>Analyse de vos articles pour « ${escapeHtml(query)} »</p>
    </div>
  `;

  try {
    const res = await apiFetch('/api/ai/search', {
      method: 'POST',
      body: JSON.stringify({ query })
    });

    const cardsHtml = (res.results || [])
      .map((r) => {
        const reasonTag =
          r.securityIds && r.securityIds.length > 0
            ? r.securityIds.join(', ')
            : r.matchedReasons?.[0] || r.article.category_name;
        return renderArticleCard({
          ...r.article,
          category_name: reasonTag
        });
      })
      .join('');

    area.innerHTML = `
      <div class="ai-section-block" style="margin-bottom:20px">
        <div class="ai-section-title">✨ Réponse synthétique (${escapeHtml(res.providerUsed || 'IA')})</div>
        <div class="ai-answer-box">${renderSimpleMarkdown(res.answerMarkdown || '')}</div>
      </div>

      <div class="ai-section-block">
        <div class="ai-section-title">📰 Articles correspondants (${res.totalMatches || 0})</div>
        <div>${cardsHtml || '<p class="form-hint">Aucun article trouvé.</p>'}</div>
      </div>
    `;
  } catch (err) {
    area.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

function renderSimpleMarkdown(md) {
  const escaped = escapeHtml(md);
  const lines = escaped.split('\n');
  let html = '';
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      continue;
    }

    const formatted = line
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    if (line.startsWith('### ')) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<h3>${formatted.slice(4)}</h3>`;
    } else if (line.startsWith('- ')) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${formatted.slice(2)}</li>`;
    } else {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<p style="margin-bottom:8px">${formatted}</p>`;
    }
  }

  if (inList) html += '</ul>';
  return html;
}

function switchAdminTab(tabId) {
  document.querySelectorAll('#admin-tabs-bar .modal-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.adminTab === tabId);
  });
  document.querySelectorAll('.admin-tab-pane').forEach((pane) => {
    pane.classList.toggle('hidden', pane.id !== tabId);
  });
}

async function refreshAdminOverview() {
  try {
    const data = await apiFetch('/api/admin/overview');
    renderAdminInvitations(data.invitations || []);
    renderAdminUsers(data.users || []);
  } catch (err) {
    showToast('Erreur chargement administration : ' + err.message);
  }
}

function buildInviteUrl(token) {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

function renderAdminInvitations(invitations) {
  const container = document.getElementById('admin-invitations-list');
  if (invitations.length === 0) {
    container.innerHTML = `<p class="form-hint">Aucun lien d'invitation généré pour le moment.</p>`;
    return;
  }

  container.innerHTML = invitations
    .map((inv) => {
      const isUsed = Boolean(inv.used_at);
      const isExpired = !isUsed && new Date(inv.expires_at).getTime() < Date.now();
      const statusLabel = isUsed
        ? `Utilisée par @${escapeHtml(inv.used_by_username || 'compte')}`
        : isExpired
        ? 'Expirée'
        : `Valide jusqu'au ${new Date(inv.expires_at).toLocaleDateString('fr-FR')}`;

      const url = buildInviteUrl(inv.token);

      return `
        <div class="admin-list-item">
          <div class="admin-item-main">
            <div class="admin-item-title">
              <span>${escapeHtml(inv.label || inv.suggested_username || 'Invitation sans nom')}</span>
              <span class="user-role-badge">${inv.role === 'admin' ? 'Admin' : 'Utilisateur'}</span>
            </div>
            <div class="admin-item-sub">${statusLabel}</div>
          </div>
          <div class="admin-item-actions">
            ${
              !isUsed && !isExpired
                ? `<button class="btn-xs" data-copy-invite="${escapeHtml(url)}">Copier le lien</button>`
                : ''
            }
            <button class="btn-xs danger" data-delete-invite="${inv.id}">Supprimer</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAdminUsers(users) {
  const container = document.getElementById('admin-users-list');
  container.innerHTML = users
    .map((u) => {
      const isSelf = Number(u.id) === Number(state.user?.id);
      return `
        <div class="admin-list-item">
          <div class="admin-item-main">
            <div class="admin-item-title">
              <span>${escapeHtml(u.display_name)} (@${escapeHtml(u.username)})</span>
              <span class="user-role-badge">${u.role === 'admin' ? 'Admin' : 'Membre'}</span>
            </div>
            <div class="admin-item-sub">
              ${u.feed_count || 0} flux • ${
        u.last_login_at
          ? 'Dernière connexion : ' + new Date(u.last_login_at).toLocaleDateString('fr-FR')
          : 'Jamais connecté'
      }
            </div>
          </div>
          <div class="admin-item-actions">
            <button class="btn-xs" data-reset-user-pwd="${u.id}" data-username="${escapeHtml(u.username)}">Mot de passe</button>
            ${
              !isSelf
                ? `<button class="btn-xs danger" data-delete-user="${u.id}" data-username="${escapeHtml(u.username)}">Supprimer</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

/* ==========================================================================
   MODALES & PRÉFÉRENCES
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
  // Connexion standard
  els.formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errBox = document.getElementById('login-error');
    const btn = document.getElementById('btn-login-submit');

    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Connexion…';

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      state.user = res.user;
      document.getElementById('login-password').value = '';
      await enterAuthenticatedApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Se connecter';
    }
  });

  // Activation d'invitation
  els.formAcceptInvite.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('invite-username').value.trim();
    const displayName = document.getElementById('invite-display-name').value.trim();
    const password = document.getElementById('invite-password').value;
    const errBox = document.getElementById('invite-error');
    const btn = document.getElementById('btn-invite-submit');

    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Création du compte…';

    try {
      const res = await apiFetch('/api/auth/accept-invite', {
        method: 'POST',
        body: JSON.stringify({
          token: state.inviteToken,
          username,
          displayName,
          password,
          seedFeeds: false
        })
      });
      state.user = res.user;
      showToast('Bienvenue ! Votre compte est activé.');
      await enterAuthenticatedApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Activer mon compte';
    }
  });

  document.getElementById('btn-back-to-login').addEventListener('click', () => {
    window.history.replaceState({}, document.title, '/');
    showLoginScreen();
  });

  // Déconnexion
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    closeReader();
    showLoginScreen();
  });

  // Ouverture Modale Admin / Compte
  els.btnOpenAdmin.addEventListener('click', () => openAdminModal('tab-invitations'));
  document.getElementById('btn-open-account').addEventListener('click', () => {
    openAdminModal(state.user?.role === 'admin' ? 'tab-invitations' : 'tab-password');
  });

  document.querySelectorAll('#admin-tabs-bar .modal-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.adminTab));
  });

  // Générer un lien d'invitation
  document.getElementById('form-create-invite').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = document.getElementById('inv-label').value.trim();
    const suggestedUsername = document.getElementById('inv-username').value.trim();
    const role = document.getElementById('inv-role').value;
    const expiresInDays = Number(document.getElementById('inv-days').value || 7);

    try {
      const res = await apiFetch('/api/admin/invitations', {
        method: 'POST',
        body: JSON.stringify({ label, suggestedUsername, role, expiresInDays })
      });

      const fullUrl = buildInviteUrl(res.invitation.token);
      const genBox = document.getElementById('generated-invite-box');
      const genInput = document.getElementById('generated-invite-url');
      genInput.value = fullUrl;
      genBox.classList.remove('hidden');

      document.getElementById('inv-label').value = '';
      document.getElementById('inv-username').value = '';
      renderAdminInvitations(res.invitations || []);
      showToast("Lien d'invitation généré !");
    } catch (err) {
      showToast('Erreur : ' + err.message);
    }
  });

  document.getElementById('btn-copy-generated-invite').addEventListener('click', () => {
    const val = document.getElementById('generated-invite-url').value;
    if (!val) return;
    navigator.clipboard.writeText(val);
    showToast("Lien d'invitation copié dans le presse-papiers !");
  });

  // Actions dans la liste des invitations
  document.getElementById('admin-invitations-list').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy-invite]');
    if (copyBtn) {
      navigator.clipboard.writeText(copyBtn.dataset.copyInvite);
      showToast('Lien copié dans le presse-papiers !');
      return;
    }
    const delBtn = e.target.closest('[data-delete-invite]');
    if (delBtn) {
      const id = Number(delBtn.dataset.deleteInvite);
      const res = await apiFetch(`/api/admin/invitations/${id}`, { method: 'DELETE' });
      renderAdminInvitations(res.invitations || []);
      showToast('Invitation supprimée');
    }
  });

  // Créer directement un compte utilisateur
  document.getElementById('form-create-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('new-user-username').value.trim();
    const displayName = document.getElementById('new-user-display').value.trim();
    const password = document.getElementById('new-user-password').value;
    const role = document.getElementById('new-user-role').value;
    const errBox = document.getElementById('create-user-error');

    errBox.classList.add('hidden');
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, displayName, password, role, seedFeeds: false })
      });
      document.getElementById('new-user-username').value = '';
      document.getElementById('new-user-display').value = '';
      document.getElementById('new-user-password').value = '';
      renderAdminUsers(res.users || []);
      showToast(`Compte @${res.user.username} créé avec succès`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });

  // Actions dans la liste des utilisateurs
  document.getElementById('admin-users-list').addEventListener('click', async (e) => {
    const pwdBtn = e.target.closest('[data-reset-user-pwd]');
    if (pwdBtn) {
      const uid = Number(pwdBtn.dataset.resetUserPwd);
      const uname = pwdBtn.dataset.username;
      const newPassword = prompt(`Nouveau mot de passe pour @${uname} (min. 6 caractères) :`);
      if (!newPassword) return;
      try {
        await apiFetch(`/api/admin/users/${uid}/password`, {
          method: 'PATCH',
          body: JSON.stringify({ newPassword })
        });
        showToast(`Mot de passe de @${uname} mis à jour`);
      } catch (err) {
        showToast('Erreur : ' + err.message);
      }
      return;
    }

    const delBtn = e.target.closest('[data-delete-user]');
    if (delBtn) {
      const uid = Number(delBtn.dataset.deleteUser);
      const uname = delBtn.dataset.username;
      if (confirm(`Supprimer définitivement le compte @${uname} et ses abonnements ?`)) {
        try {
          const res = await apiFetch(`/api/admin/users/${uid}`, { method: 'DELETE' });
          renderAdminUsers(res.users || []);
          showToast(`Compte @${uname} supprimé`);
        } catch (err) {
          showToast('Erreur : ' + err.message);
        }
      }
    }
  });

  // Enregistrer la configuration du moteur IA
  document.getElementById('form-ai-config').addEventListener('submit', async (e) => {
    e.preventDefault();
    const aiProvider = document.getElementById('ai-provider-select').value;
    const aiApiKey = document.getElementById('ai-api-key').value.trim();
    const aiModel = document.getElementById('ai-model-name').value.trim();

    try {
      const res = await apiFetch('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ aiProvider, aiApiKey, aiModel })
      });
      state.settings = { ...state.settings, ...(res.settings || {}) };
      showToast('Configuration IA enregistrée');
      closeModal('modal-admin');
      if (state.filter === 'ai-briefing') loadAiBriefingView();
    } catch (err) {
      showToast('Erreur : ' + err.message);
    }
  });

  // Changer son propre mot de passe
  document.getElementById('form-change-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('pwd-current').value;
    const newPassword = document.getElementById('pwd-new').value;
    const errBox = document.getElementById('change-pwd-error');
    errBox.classList.add('hidden');

    try {
      await apiFetch('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      document.getElementById('pwd-current').value = '';
      document.getElementById('pwd-new').value = '';
      showToast('Votre mot de passe a été modifié');
      closeModal('modal-admin');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });

  // Navigation principale
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

    const openItem = e.target.closest('[data-open-article]');
    if (openItem) {
      openArticleInReader(Number(openItem.dataset.openArticle));
      return;
    }

    const topicBtn = e.target.closest('[data-ai-topic]');
    if (topicBtn) {
      const topic = topicBtn.dataset.aiTopic;
      state.filter = 'ai-search';
      state.categoryId = null;
      state.feedId = null;
      renderSidebar();
      renderAiSearchView(topic);
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

  // Sélecteur de vue
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

  // Sélection et import OPML
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

  // Raccourcis clavier globaux (actifs uniquement si connecté)
  document.addEventListener('keydown', (e) => {
    if (!state.user) return;
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
  if (state.user) {
    apiFetch('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ theme: next })
    }).catch(() => {});
  }
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
