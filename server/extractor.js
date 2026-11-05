/**
 * Extracteur Web :
 * 1. Téléchargement HTTP résilient (User-Agent réaliste, timeouts, décodage charset)
 * 2. Auto-découverte de flux RSS/Atom à partir de l'URL d'un site web
 * 3. Extraction du mode "Article Complet" (Reader View) + récupération d'image og:image
 */

const {
  decodeBuffer,
  decodeEntities,
  sanitizeArticleHtml,
  htmlToPlainText,
  resolveUrl,
  estimateReadingTime
} = require('./rssParser');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, application/xhtml+xml, */*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
};

/**
 * Récupère une URL avec timeout et renvoie { text, status, headers, finalUrl }
 */
async function fetchUrlText(url, options = {}) {
  const timeoutMs = options.timeoutMs || 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    });

    if (response.status === 304) {
      return { notModified: true, status: 304, headers: response.headers, finalUrl: response.url || url };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} (${response.statusText || 'Erreur'})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || '';
    const text = decodeBuffer(buffer, contentType);

    return {
      notModified: false,
      status: response.status,
      text,
      contentType,
      etag: response.headers.get('etag') || null,
      lastModified: response.headers.get('last-modified') || null,
      finalUrl: response.url || url
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vérifie si un texte brut ressemble à un flux RSS, Atom ou JSON Feed
 */
function looksLikeFeed(text, contentType = '') {
  if (!text) return false;
  const sample = text.slice(0, 2000).trim();
  if (/<(rss|feed|rdf:RDF)\b/i.test(sample)) return true;
  if (contentType.includes('rss') || contentType.includes('atom')) return true;
  if (sample.startsWith('{') && /"version"\s*:\s*"https:\/\/jsonfeed\.org/i.test(sample)) return true;
  return false;
}

/**
 * Découvre automatiquement l'URL du flux RSS/Atom à partir d'une URL de site ou de flux
 */
async function discoverFeedUrl(inputUrl) {
  let normalizedUrl = (inputUrl || '').trim();
  if (!normalizedUrl) throw new Error('URL manquante');
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  const res = await fetchUrlText(normalizedUrl, { timeoutMs: 12000 });
  if (looksLikeFeed(res.text, res.contentType)) {
    return {
      feedUrl: res.finalUrl || normalizedUrl,
      rawText: res.text,
      etag: res.etag,
      lastModified: res.lastModified
    };
  }

  // Chercher les balises <link rel="alternate" type="application/rss+xml" ...> dans le HTML
  const html = res.text || '';
  const baseUrl = res.finalUrl || normalizedUrl;
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const candidates = [];

  for (const tag of linkTags) {
    const relMatch = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag);
    const typeMatch = /\btype\s*=\s*["']([^"']*)["']/i.exec(tag);
    const hrefMatch = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!hrefMatch || !hrefMatch[1]) continue;

    const rel = (relMatch?.[1] || '').toLowerCase();
    const type = (typeMatch?.[1] || '').toLowerCase();
    const title = (/\btitle\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '').toLowerCase();

    if (
      rel.includes('alternate') &&
      (type.includes('rss') || type.includes('atom') || type.includes('xml') || type.includes('json'))
    ) {
      // Éviter les flux de commentaires WordPress si un flux principal existe
      const isComments = title.includes('comment') || hrefMatch[1].includes('comments');
      const fullHref = resolveUrl(hrefMatch[1], baseUrl);
      if (isComments) {
        candidates.push({ url: fullHref, priority: 2 });
      } else {
        candidates.unshift({ url: fullHref, priority: 1 });
      }
    }
  }

  // Ajouter les chemins classiques en fallback
  try {
    const origin = new URL(baseUrl).origin;
    const commonPaths = ['/feed/', '/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'];
    for (const p of commonPaths) {
      candidates.push({ url: origin + p, priority: 3 });
    }
  } catch {
    // ignore
  }

  const seen = new Set();
  for (const c of candidates) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    try {
      const sub = await fetchUrlText(c.url, { timeoutMs: 7000 });
      if (looksLikeFeed(sub.text, sub.contentType)) {
        return {
          feedUrl: sub.finalUrl || c.url,
          rawText: sub.text,
          etag: sub.etag,
          lastModified: sub.lastModified
        };
      }
    } catch {
      // Essayer le candidat suivant
    }
  }

  throw new Error('Aucun flux RSS ou Atom trouvé pour cette adresse.');
}

/**
 * Extrait l'image OpenGraph (og:image / twitter:image) depuis une page HTML
 */
function extractMetaImage(html, baseUrl) {
  if (!html) return null;
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd !== -1 ? html.slice(0, headEnd) : html.slice(0, 15000);
  const metas = head.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metas) {
    const prop = (
      /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || ''
    ).toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '';

    if (
      content &&
      (prop === 'og:image' ||
        prop === 'og:image:secure_url' ||
        prop === 'twitter:image' ||
        prop === 'twitter:image:src')
    ) {
      return resolveUrl(content, baseUrl);
    }
  }
  return null;
}

/**
 * Extrait le contenu principal d'une page web pour le mode "Article Complet" (Reader View)
 */
async function extractFullArticle(articleUrl) {
  const res = await fetchUrlText(articleUrl, { timeoutMs: 12000 });
  const html = res.text || '';
  const finalUrl = res.finalUrl || articleUrl;

  const ogImage = extractMetaImage(html, finalUrl);

  // Nettoyage préalable des éléments non éditoriaux
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header class=["'][^"']*(?:site|main|global|nav)[^"']*["'][\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '');

  // Supprimer les blocs de partage, newsletters, articles liés ("À lire aussi") fréquents sur les médias
  cleaned = cleaned.replace(
    /<div\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:share|social|newsletter|related|outbrain|taboola|comments|cookie|banner|pub-|ad-|advert|sidebar|breadcrumb|author-bio|tags-list)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    ''
  );

  // Chercher le conteneur d'article le plus pertinent
  const candidates = [];

  // 1. Balise <article>
  const articleRegex = /<article(?:\s[^>]*)?>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = articleRegex.exec(cleaned)) !== null) {
    candidates.push(match[1]);
  }

  // 2. Conteneurs éditoriaux classiques (WordPress, médias numériques, blogs)
  const containerPatterns = [
    /<div\b[^>]*itemprop\s*=\s*["']articleBody["'][^>]*>([\s\S]*?)<\/div>/gi,
    /<div\b[^>]*class\s*=\s*["'][^"']*(?:article-content|article__content|post-content|entry-content|article-body|story-body|content-body|single-content|c-article-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    /<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/gi
  ];

  for (const regex of containerPatterns) {
    let m;
    while ((m = regex.exec(cleaned)) !== null) {
      candidates.push(m[1]);
    }
  }

  // Sélectionner le candidat qui a la meilleure densité de paragraphes <p>
  let bestHtml = '';
  let bestScore = 0;

  for (const candidate of candidates) {
    const paragraphs = candidate.match(/<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi) || [];
    const textLength = htmlToPlainText(candidate, 50000).length;
    const score = paragraphs.length * 120 + textLength;
    if (score > bestScore) {
      bestScore = score;
      bestHtml = candidate;
    }
  }

  // Fallback : rassembler tous les paragraphes significatifs de la page
  if (!bestHtml || bestScore < 350) {
    const allParagraphs = cleaned.match(/<(?:p|h2|h3|blockquote|figure)(?:\s[^>]*)?>[\s\S]*?<\/(?:p|h2|h3|blockquote|figure)>/gi) || [];
    const filtered = allParagraphs.filter((block) => {
      const txt = htmlToPlainText(block, 2000);
      if (block.toLowerCase().startsWith('<figure')) return true;
      return txt.length > 45 && !/cookie|politique de confidentialité|tous droits réservés/i.test(txt);
    });
    bestHtml = filtered.join('\n');
  }

  // Supprimer le titre <h1> en doublon s'il est déjà affiché dans l'en-tête du Reader
  bestHtml = bestHtml.replace(/<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>/gi, '');

  const sanitized = sanitizeArticleHtml(bestHtml, finalUrl);
  const plainText = htmlToPlainText(sanitized, 50000);

  return {
    contentHtml: sanitized,
    imageUrl: ogImage,
    readingTimeMin: estimateReadingTime(plainText),
    wordCount: plainText ? plainText.split(/\s+/).length : 0
  };
}

/**
 * Construit une URL de favicon propre et fiable pour un site
 */
function getFaviconUrl(siteUrl) {
  try {
    const u = new URL(siteUrl);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64`;
  } catch {
    return '';
  }
}

module.exports = {
  fetchUrlText,
  discoverFeedUrl,
  extractMetaImage,
  extractFullArticle,
  getFaviconUrl
};
