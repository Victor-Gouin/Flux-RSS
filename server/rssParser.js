/**
 * Parseur RSS 2.0 / Atom 1.0 / RDF (RSS 1.0) / JSON Feed
 * - Gestion native des encodages (UTF-8, ISO-8859-1, Windows-1252)
 * - Extraction intelligente des miniatures (media:content, media:thumbnail, enclosure, contenu HTML)
 * - Nettoyage HTML & décodage complet des entités HTML
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  oelig: 'œ',
  OElig: 'Œ',
  aelig: 'æ',
  AElig: 'Æ',
  ccedil: 'ç',
  Ccedil: 'Ç',
  eacute: 'é',
  Eacute: 'É',
  egrave: 'è',
  Egrave: 'È',
  ecirc: 'ê',
  Ecirc: 'Ê',
  euml: 'ë',
  Euml: 'Ë',
  agrave: 'à',
  Agrave: 'À',
  acirc: 'â',
  Acirc: 'Â',
  auml: 'ä',
  Auml: 'Ä',
  icirc: 'î',
  Icirc: 'Î',
  iuml: 'ï',
  Iuml: 'Ï',
  ocirc: 'ô',
  Ocirc: 'Ô',
  ouml: 'ö',
  Ouml: 'Ö',
  ugrave: 'ù',
  Ugrave: 'Ù',
  ucirc: 'û',
  Ucirc: 'Û',
  uuml: 'ü',
  Uuml: 'Ü',
  yuml: 'ÿ',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  times: '×',
  divide: '÷',
  bull: '•',
  middot: '·',
  prime: '′',
  Prime: '″'
};

/**
 * Décode toutes les entités HTML/XML (nommées, décimales et hexadécimales)
 */
function decodeEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-zA-Z0-9]+);/g, (full, name) => {
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) {
        return NAMED_ENTITIES[name];
      }
      const lower = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) {
        return NAMED_ENTITIES[lower];
      }
      return full;
    });
}

/**
 * Détecte l'encodage depuis le header HTTP Content-Type ou le prologue XML <?xml encoding="..."?>
 * et décode le Buffer correspondant en chaîne UTF-8 propre.
 */
function decodeBuffer(buffer, contentTypeHeader = '') {
  let encoding = 'utf-8';

  const headerMatch = /charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(contentTypeHeader || '');
  if (headerMatch && headerMatch[1]) {
    encoding = headerMatch[1].toLowerCase();
  } else {
    const asciiHead = buffer.subarray(0, Math.min(buffer.length, 512)).toString('latin1');
    const xmlMatch = /<\?xml[^>]+encoding\s*=\s*["']([a-zA-Z0-9_-]+)["']/i.exec(asciiHead);
    if (xmlMatch && xmlMatch[1]) {
      encoding = xmlMatch[1].toLowerCase();
    }
  }

  if (encoding === 'iso-8859-1' || encoding === 'latin1') {
    encoding = 'windows-1252';
  }

  try {
    const decoder = new TextDecoder(encoding);
    return decoder.decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Convertit du HTML en texte brut propre pour le chapô (extrait)
 */
function htmlToPlainText(html, maxLength = 320) {
  if (!html || typeof html !== 'string') return '';
  let text = decodeEntities(html);
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr|blockquote)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/\s+/g, ' ')
    .replace(/\s*(Lire la suite|En savoir plus|Continue reading|Read more)\s*(\.{2,}|…|→|»)?\s*$/i, '')
    .trim();

  if (text.length > maxLength) {
    const cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > maxLength * 0.7 ? cut.slice(0, lastSpace) : cut).trim() + '…';
  }
  return text;
}

/**
 * Nettoie le HTML d'un article RSS pour un affichage sûr et élégant dans le panneau de lecture
 */
function sanitizeArticleHtml(rawHtml, baseUrl = '') {
  if (!rawHtml || typeof rawHtml !== 'string') return '';
  let html = rawHtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');

  // Si le contenu a été encodé en entités HTML (&lt;p&gt;...), on le décode
  if (!/<(p|div|img|a|br|figure|h[1-6]|ul|ol|blockquote)\b/i.test(html) && /&lt;(p|div|img|a|br)/i.test(html)) {
    html = decodeEntities(html);
  }

  // Supprimer les scripts, styles, iframes publicitaires, pixels de tracking
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?>([\s\S]*?)<\/noscript>/gi, '$1')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');

  // Convertir les images lazy-load (data-src, data-lazy-src, data-original) en src standard
  html = html.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
    const widthMatch = /\bwidth\s*=\s*["']?(\d+)/i.exec(attrs);
    const heightMatch = /\bheight\s*=\s*["']?(\d+)/i.exec(attrs);
    if ((widthMatch && parseInt(widthMatch[1], 10) <= 2) || (heightMatch && parseInt(heightMatch[1], 10) <= 2)) {
      return '';
    }

    let finalAttrs = attrs;
    const lazyMatch = /\bdata-(?:lazy-)?(?:src|original)\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);

    if (lazyMatch && lazyMatch[1] && (!srcMatch || srcMatch[1].startsWith('data:') || srcMatch[1].includes('placeholder'))) {
      if (srcMatch) {
        finalAttrs = finalAttrs.replace(/\bsrc\s*=\s*["'][^"']*["']/i, `src="${lazyMatch[1]}"`);
      } else {
        finalAttrs += ` src="${lazyMatch[1]}"`;
      }
    }

    if (baseUrl) {
      finalAttrs = finalAttrs.replace(/\bsrc\s*=\s*["']([^"']+)["']/i, (m, src) => {
        return `src="${resolveUrl(src, baseUrl)}"`;
      });
    }

    if (!/\bloading\s*=/i.test(finalAttrs)) {
      finalAttrs += ' loading="lazy"';
    }
    return `<img${finalAttrs}>`;
  });

  // Résoudre les liens relatifs et ouvrir les liens externes dans un nouvel onglet
  if (baseUrl) {
    html = html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
      let updated = attrs.replace(/\bhref\s*=\s*["']([^"']+)["']/i, (m, href) => {
        return `href="${resolveUrl(href, baseUrl)}"`;
      });
      if (!/\btarget\s*=/i.test(updated)) {
        updated += ' target="_blank" rel="noopener noreferrer"';
      }
      return `<a${updated}>`;
    });
  }

  return html.trim();
}

function resolveUrl(url, baseUrl) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = decodeEntities(url).trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('mailto:') || trimmed.startsWith('#')) {
    return trimmed;
  }
  try {
    if (trimmed.startsWith('//')) {
      return 'https:' + trimmed;
    }
    return new URL(trimmed, baseUrl || undefined).href;
  } catch {
    return trimmed;
  }
}

/**
 * Extrait un attribut d'une balise XML/HTML
 */
function getAttr(tagString, attrName) {
  if (!tagString) return '';
  const regex = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, 'i');
  const match = regex.exec(tagString);
  if (!match) return '';
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/**
 * Extrait le contenu de la première balise correspondante dans un bloc XML
 */
function getTagContent(xml, tagNames) {
  const names = Array.isArray(tagNames) ? tagNames : [tagNames];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const match = regex.exec(xml);
    if (match && match[1] !== undefined) {
      const val = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
      if (val) return val;
    }
  }
  return '';
}

/**
 * Vérifie si une URL d'image est valide et n'est pas un pixel de tracking / icône minuscule
 */
function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const clean = url.trim().toLowerCase();
  if (!clean.startsWith('http://') && !clean.startsWith('https://') && !clean.startsWith('//')) {
    return false;
  }
  const blacklist = [
    'feedburner.com/~ff/',
    'feedburner.com/~r/',
    'doubleclick.net',
    '1x1',
    'pixel.',
    'spacer.gif',
    'blank.gif',
    'gravatar.com/avatar',
    's.w.org/images/core/emoji',
    'wp-includes/images/smilies'
  ];
  return !blacklist.some((b) => clean.includes(b));
}

/**
 * Extrait la meilleure vignette (thumbnail) d'un item XML RSS/Atom ou de son HTML
 */
function extractThumbnail(itemXml, htmlContent, baseUrl = '') {
  // 1. <media:content> ou <media:thumbnail>
  const mediaTags = itemXml.match(/<(?:media:content|media:thumbnail)\b[^>]*>/gi) || [];
  for (const tag of mediaTags) {
    const url = resolveUrl(getAttr(tag, 'url'), baseUrl);
    const medium = getAttr(tag, 'medium').toLowerCase();
    const type = getAttr(tag, 'type').toLowerCase();
    const width = parseInt(getAttr(tag, 'width') || '0', 10);
    if (width > 0 && width < 40) continue;
    if (url && isValidImageUrl(url)) {
      if (!medium && !type) return url;
      if (medium === 'image' || type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(url)) {
        return url;
      }
    }
  }

  // 2. <enclosure url="..." type="image/...">
  const enclosures = itemXml.match(/<enclosure\b[^>]*>/gi) || [];
  for (const tag of enclosures) {
    const url = resolveUrl(getAttr(tag, 'url'), baseUrl);
    const type = getAttr(tag, 'type').toLowerCase();
    if (url && isValidImageUrl(url)) {
      if (type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(url)) {
        return url;
      }
    }
  }

  // 3. <itunes:image href="..."> ou <image><url>...</url></image> ou <thumbnail>
  const itunesMatch = /<itunes:image\b[^>]*>/i.exec(itemXml);
  if (itunesMatch) {
    const url = resolveUrl(getAttr(itunesMatch[0], 'href'), baseUrl);
    if (isValidImageUrl(url)) return url;
  }

  const directThumb = getTagContent(itemXml, ['thumbnail', 'media:thumbnail', 'image']);
  if (directThumb) {
    const subUrl = getTagContent(directThumb, ['url']) || directThumb;
    const resolved = resolveUrl(decodeEntities(subUrl).replace(/<[^>]+>/g, '').trim(), baseUrl);
    if (isValidImageUrl(resolved)) return resolved;
  }

  // 4. Première balise <img> dans le contenu HTML / description
  const combinedHtml = `${htmlContent || ''} ${itemXml}`;
  const imgRegex = /<img\b[^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(combinedHtml)) !== null) {
    const tag = imgMatch[0];
    const width = parseInt(getAttr(tag, 'width') || '0', 10);
    const height = parseInt(getAttr(tag, 'height') || '0', 10);
    if ((width > 0 && width < 36) || (height > 0 && height < 36)) continue;

    let src =
      getAttr(tag, 'data-lazy-src') ||
      getAttr(tag, 'data-src') ||
      getAttr(tag, 'data-original') ||
      getAttr(tag, 'src');

    if (!src) {
      const srcset = getAttr(tag, 'srcset');
      if (srcset) {
        src = srcset.split(',')[0].trim().split(/\s+/)[0];
      }
    }

    const resolved = resolveUrl(src, baseUrl);
    if (isValidImageUrl(resolved)) {
      return resolved;
    }
  }

  return null;
}

/**
 * Normalise une date RSS (RFC 2822) ou Atom (ISO 8601) en ISO string
 */
function parseFeedDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return new Date().toISOString();
  const cleaned = decodeEntities(dateStr).trim();
  const parsed = Date.parse(cleaned);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    // Éviter les dates dans le futur lointain dues à une erreur d'horloge de flux
    const maxFuture = Date.now() + 1000 * 60 * 60 * 24;
    if (d.getTime() > maxFuture) return new Date().toISOString();
    return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Calcule le temps de lecture estimé en minutes
 */
function estimateReadingTime(plainText) {
  if (!plainText) return 1;
  const words = plainText.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 210));
}

/**
 * Parse un flux RSS 2.0 / Atom 1.0 / RDF / JSON Feed et renvoie { title, siteUrl, description, items }
 */
function parseFeedContent(rawText, feedUrl = '') {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Contenu du flux vide');
  }

  const trimmed = rawText.trim();

  // Support JSON Feed (https://jsonfeed.org/version/1.1)
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      if (json && Array.isArray(json.items)) {
        const siteUrl = json.home_page_url || feedUrl;
        const items = json.items.map((item) => {
          const contentHtml = item.content_html || item.summary || '';
          const summary = htmlToPlainText(item.summary || contentHtml || item.content_text || '');
          const imageUrl = item.image || item.banner_image || extractThumbnail('', contentHtml, siteUrl);
          return {
            guid: String(item.id || item.url || Math.random()),
            title: decodeEntities(item.title || 'Sans titre').trim(),
            url: resolveUrl(item.url || item.external_url || siteUrl, siteUrl),
            author: item.authors?.[0]?.name || item.author?.name || '',
            summary,
            contentHtml: sanitizeArticleHtml(contentHtml || `<p>${summary}</p>`, siteUrl),
            imageUrl,
            publishedAt: parseFeedDate(item.date_published || item.date_modified),
            readingTimeMin: estimateReadingTime(summary)
          };
        });
        return {
          title: json.title || 'Flux JSON',
          siteUrl,
          description: json.description || '',
          items
        };
      }
    } catch {
      // Continuer vers le parseur XML
    }
  }

  // Détection Atom (<feed>) vs RSS/RDF (<rss> ou <rdf:RDF>)
  const isAtom = /<feed[\s>]/i.test(trimmed) && !/<rss[\s>]/i.test(trimmed);

  if (isAtom) {
    return parseAtomXml(trimmed, feedUrl);
  }
  return parseRssXml(trimmed, feedUrl);
}

function parseRssXml(xml, feedUrl) {
  // Extraire l'en-tête du channel (avant le premier <item>)
  const firstItemIdx = xml.search(/<item[\s>]/i);
  const channelHeader = firstItemIdx !== -1 ? xml.slice(0, firstItemIdx) : xml;

  const feedTitle = decodeEntities(getTagContent(channelHeader, ['title'])).replace(/<[^>]+>/g, '').trim();
  let siteUrl = decodeEntities(getTagContent(channelHeader, ['link'])).replace(/<[^>]+>/g, '').trim();
  if (!siteUrl) {
    const atomLinkMatch = /<atom:link\b[^>]*rel\s*=\s*["']alternate["'][^>]*>/i.exec(channelHeader);
    if (atomLinkMatch) siteUrl = getAttr(atomLinkMatch[0], 'href');
  }
  siteUrl = resolveUrl(siteUrl || feedUrl, feedUrl);
  const feedDescription = htmlToPlainText(getTagContent(channelHeader, ['description', 'itunes:summary']), 240);

  const items = [];
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const rawTitle = getTagContent(itemXml, ['title']);
    const title = decodeEntities(rawTitle).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || 'Article sans titre';

    let link = getTagContent(itemXml, ['link', 'feedburner:origLink']);
    if (!link) {
      const guidTag = /<guid\b([^>]*)>([\s\S]*?)<\/guid>/i.exec(itemXml);
      if (guidTag && getAttr(guidTag[1], 'isPermaLink').toLowerCase() !== 'false') {
        const candidate = decodeEntities(guidTag[2]).trim();
        if (candidate.startsWith('http')) link = candidate;
      }
    }
    const url = resolveUrl(link, siteUrl || feedUrl);

    const rawGuid = getTagContent(itemXml, ['guid', 'id']) || url || title;
    const guid = decodeEntities(rawGuid).trim();

    const author = decodeEntities(
      getTagContent(itemXml, ['dc:creator', 'creator', 'author', 'itunes:author'])
    )
      .replace(/<[^>]+>/g, '')
      .trim();

    const contentEncoded = getTagContent(itemXml, ['content:encoded', 'content']);
    const description = getTagContent(itemXml, ['description', 'summary', 'itunes:summary']);
    const fullRawHtml = contentEncoded || description || '';

    const summary = htmlToPlainText(description || contentEncoded, 280);
    const contentHtml = sanitizeArticleHtml(fullRawHtml, url || siteUrl);
    const imageUrl = extractThumbnail(itemXml, fullRawHtml, url || siteUrl);

    const rawDate = getTagContent(itemXml, ['pubDate', 'dc:date', 'published', 'updated', 'date']);
    const publishedAt = parseFeedDate(rawDate);
    const plainForTime = htmlToPlainText(fullRawHtml, 20000);

    items.push({
      guid,
      title,
      url,
      author,
      summary,
      contentHtml: contentHtml || (summary ? `<p>${summary}</p>` : ''),
      imageUrl,
      publishedAt,
      readingTimeMin: estimateReadingTime(plainForTime || summary)
    });
  }

  return {
    title: feedTitle || extractHostnameTitle(siteUrl || feedUrl),
    siteUrl: siteUrl || feedUrl,
    description: feedDescription,
    items
  };
}

function parseAtomXml(xml, feedUrl) {
  const firstEntryIdx = xml.search(/<entry[\s>]/i);
  const feedHeader = firstEntryIdx !== -1 ? xml.slice(0, firstEntryIdx) : xml;

  const feedTitle = decodeEntities(getTagContent(feedHeader, ['title'])).replace(/<[^>]+>/g, '').trim();
  const feedDescription = htmlToPlainText(getTagContent(feedHeader, ['subtitle', 'tagline']), 240);

  let siteUrl = '';
  const linkTags = feedHeader.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    const rel = (getAttr(tag, 'rel') || 'alternate').toLowerCase();
    const href = getAttr(tag, 'href');
    if (href && (rel === 'alternate' || !siteUrl)) {
      siteUrl = href;
      if (rel === 'alternate') break;
    }
  }
  siteUrl = resolveUrl(siteUrl || feedUrl, feedUrl);

  const items = [];
  const entryRegex = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const rawTitle = getTagContent(entryXml, ['title']);
    const title = decodeEntities(rawTitle).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || 'Article sans titre';

    let entryLink = '';
    const entryLinks = entryXml.match(/<link\b[^>]*>/gi) || [];
    for (const tag of entryLinks) {
      const rel = (getAttr(tag, 'rel') || 'alternate').toLowerCase();
      const href = getAttr(tag, 'href');
      if (href && (rel === 'alternate' || !entryLink)) {
        entryLink = href;
        if (rel === 'alternate') break;
      }
    }
    const url = resolveUrl(entryLink, siteUrl || feedUrl);
    const guid = decodeEntities(getTagContent(entryXml, ['id']) || url || title).trim();

    const authorBlock = getTagContent(entryXml, ['author']);
    const author = decodeEntities(
      getTagContent(authorBlock, ['name']) || getTagContent(entryXml, ['dc:creator']) || authorBlock
    )
      .replace(/<[^>]+>/g, '')
      .trim();

    const content = getTagContent(entryXml, ['content', 'content:encoded']);
    const summaryRaw = getTagContent(entryXml, ['summary']);
    const fullRawHtml = content || summaryRaw || '';

    const summary = htmlToPlainText(summaryRaw || content, 280);
    const contentHtml = sanitizeArticleHtml(fullRawHtml, url || siteUrl);
    const imageUrl = extractThumbnail(entryXml, fullRawHtml, url || siteUrl);

    const rawDate = getTagContent(entryXml, ['published', 'updated', 'dc:date']);
    const publishedAt = parseFeedDate(rawDate);
    const plainForTime = htmlToPlainText(fullRawHtml, 20000);

    items.push({
      guid,
      title,
      url,
      author,
      summary,
      contentHtml: contentHtml || (summary ? `<p>${summary}</p>` : ''),
      imageUrl,
      publishedAt,
      readingTimeMin: estimateReadingTime(plainForTime || summary)
    });
  }

  return {
    title: feedTitle || extractHostnameTitle(siteUrl || feedUrl),
    siteUrl: siteUrl || feedUrl,
    description: feedDescription,
    items
  };
}

function extractHostnameTitle(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return 'Flux RSS';
  }
}

module.exports = {
  decodeEntities,
  decodeBuffer,
  htmlToPlainText,
  sanitizeArticleHtml,
  resolveUrl,
  extractThumbnail,
  estimateReadingTime,
  parseFeedContent
};
