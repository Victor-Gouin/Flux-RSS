/**
 * Flux de démonstration proposés lors du premier lancement (notamment 01net et grands médias tech/actu)
 * L'utilisateur peut aussi importer directement son fichier OPML FreshRSS ou supprimer ces flux.
 */
const DEFAULT_CATEGORIES = [
  { name: 'Tech & Numérique', color: '#3b82f6', position: 1 },
  { name: 'Culture Geek & Web', color: '#8b5cf6', position: 2 },
  { name: 'Actualités', color: '#10b981', position: 3 }
];

const DEFAULT_FEEDS = [
  {
    title: '01net',
    xmlUrl: 'https://www.01net.com/feed/',
    siteUrl: 'https://www.01net.com',
    category: 'Tech & Numérique',
    description: 'Toute l’actualité high-tech, tests produits et astuces numériques'
  },
  {
    title: 'Frandroid',
    xmlUrl: 'https://www.frandroid.com/feed',
    siteUrl: 'https://www.frandroid.com',
    category: 'Tech & Numérique',
    description: 'Actualités smartphones, tech, automobile électrique et guides d’achat'
  },
  {
    title: 'Numerama',
    xmlUrl: 'https://www.numerama.com/feed/',
    siteUrl: 'https://www.numerama.com',
    category: 'Tech & Numérique',
    description: 'Média de référence sur la société numérique, la tech et les sciences'
  },
  {
    title: 'Korben',
    xmlUrl: 'https://korben.info/feed',
    siteUrl: 'https://korben.info',
    category: 'Culture Geek & Web',
    description: 'Bidouilles informatiques, logiciels libres, sécurité et découvertes tech'
  },
  {
    title: 'Le Monde — Pixels & À la une',
    xmlUrl: 'https://www.lemonde.fr/rss/une.xml',
    siteUrl: 'https://www.lemonde.fr',
    category: 'Actualités',
    description: 'Les actualités à la une du Monde'
  }
];

module.exports = {
  DEFAULT_CATEGORIES,
  DEFAULT_FEEDS
};
