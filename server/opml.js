/**
 * Gestionnaire d'import et d'export OPML (1.0 & 2.0)
 */

const { decodeEntities } = require('./rssParser');

function getAttr(tag, name) {
  const regex = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, 'i');
  const m = regex.exec(tag);
  if (!m) return '';
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse un contenu XML OPML et retourne un tableau de flux :
 * [{ title, xmlUrl, siteUrl, category, description }]
 */
function parseOpml(opmlText) {
  if (!opmlText || typeof opmlText !== 'string') {
    throw new Error('Fichier OPML vide ou invalide');
  }

  const feeds = [];
  const categoryStack = [];

  // Parcourir toutes les balises <outline ...>, <outline .../> et </outline> dans l'ordre
  const tokenRegex = /<\/?outline\b[^>]*>/gi;
  let match;

  while ((match = tokenRegex.exec(opmlText)) !== null) {
    const token = match[0];

    if (/^<\/outline/i.test(token)) {
      if (categoryStack.length > 0) {
        categoryStack.pop();
      }
      continue;
    }

    const isSelfClosing = /\/>\s*$/.test(token);
    const xmlUrl = getAttr(token, 'xmlUrl') || getAttr(token, 'url');
    const htmlUrl = getAttr(token, 'htmlUrl') || getAttr(token, 'siteUrl');
    const title = getAttr(token, 'title') || getAttr(token, 'text');
    const description = getAttr(token, 'description') || '';
    const explicitCategory = getAttr(token, 'category');

    if (xmlUrl) {
      const currentCategory =
        categoryStack.length > 0
          ? categoryStack[categoryStack.length - 1]
          : explicitCategory.split(',')[0].trim() || 'Général';

      feeds.push({
        title: title || xmlUrl,
        xmlUrl,
        siteUrl: htmlUrl || xmlUrl,
        category: currentCategory || 'Général',
        description
      });

      // Si une balise <outline xmlUrl="..."> n'était pas auto-fermante, pousser un marqueur neutre pour équilibrer </outline>
      if (!isSelfClosing) {
        categoryStack.push(categoryStack[categoryStack.length - 1] || 'Général');
      }
    } else {
      // C'est un dossier / catégorie parent
      const folderName = title || 'Général';
      if (!isSelfClosing) {
        categoryStack.push(folderName);
      }
    }
  }

  return feeds;
}

/**
 * Génère un fichier XML OPML 2.0 à partir des catégories et des flux
 */
function generateOpml(categories, feeds) {
  const now = new Date().toUTCString();
  const byCategory = new Map();

  for (const cat of categories) {
    byCategory.set(cat.id, { name: cat.name, feeds: [] });
  }

  const uncategorized = [];
  for (const feed of feeds) {
    if (feed.category_id && byCategory.has(feed.category_id)) {
      byCategory.get(feed.category_id).feeds.push(feed);
    } else {
      uncategorized.push(feed);
    }
  }

  let body = '';

  for (const [, group] of byCategory) {
    if (group.feeds.length === 0) continue;
    body += `    <outline text="${escapeXml(group.name)}" title="${escapeXml(group.name)}">\n`;
    for (const f of group.feeds) {
      body += `      <outline type="rss" text="${escapeXml(f.title)}" title="${escapeXml(f.title)}" xmlUrl="${escapeXml(f.xml_url)}" htmlUrl="${escapeXml(f.site_url || f.xml_url)}" />\n`;
    }
    body += `    </outline>\n`;
  }

  for (const f of uncategorized) {
    body += `    <outline type="rss" text="${escapeXml(f.title)}" title="${escapeXml(f.title)}" xmlUrl="${escapeXml(f.xml_url)}" htmlUrl="${escapeXml(f.site_url || f.xml_url)}" />\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Abonnements Flux RSS</title>
    <dateCreated>${now}</dateCreated>
  </head>
  <body>
${body}  </body>
</opml>
`;
}

module.exports = {
  parseOpml,
  generateOpml
};
