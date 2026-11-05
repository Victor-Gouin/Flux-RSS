const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeedContent, decodeEntities } = require('../server/rssParser');
const { parseOpml, generateOpml } = require('../server/opml');
const { hashPassword, verifyPassword, parseCookies } = require('../server/auth');
const { generateDailyBriefing, performAiSearch } = require('../server/ai');

test('parseFeedContent analyse un flux RSS 2.0 avec vignette media:content et CDATA', () => {
  const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel>
        <title>01net Actualités</title>
        <link>https://www.01net.com</link>
        <description>Toute la tech</description>
        <item>
          <title><![CDATA[Test du nouveau processeur &amp; carte graphique]]></title>
          <link>https://www.01net.com/actualites/test-processeur.html</link>
          <guid>https://www.01net.com/actualites/test-processeur.html</guid>
          <pubDate>Thu, 05 Nov 2026 18:00:00 +0100</pubDate>
          <media:content url="https://www.01net.com/images/cpu-thumb.jpg" medium="image" />
          <description><![CDATA[<p>Voici un résumé très propre de l&rsquo;article avec des détails techniques.</p>]]></description>
        </item>
      </channel>
    </rss>`;

  const parsed = parseFeedContent(sampleRss, 'https://www.01net.com/feed/');
  assert.equal(parsed.title, '01net Actualités');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'Test du nouveau processeur & carte graphique');
  assert.equal(parsed.items[0].imageUrl, 'https://www.01net.com/images/cpu-thumb.jpg');
  assert.match(parsed.items[0].summary, /Voici un résumé très propre de l’article/);
});

test('parseOpml et generateOpml importent et exportent la hiérarchie FreshRSS', () => {
  const opmlXml = `<?xml version="1.0" encoding="UTF-8"?>
    <opml version="2.0">
      <body>
        <outline text="Tech &amp; Médias">
          <outline type="rss" text="01net" xmlUrl="https://www.01net.com/feed/" htmlUrl="https://www.01net.com" />
          <outline type="rss" text="Numerama" xmlUrl="https://www.numerama.com/feed/" htmlUrl="https://www.numerama.com" />
        </outline>
      </body>
    </opml>`;

  const feeds = parseOpml(opmlXml);
  assert.equal(feeds.length, 2);
  assert.equal(feeds[0].category, 'Tech & Médias');
  assert.equal(feeds[0].title, '01net');
  assert.equal(feeds[0].xmlUrl, 'https://www.01net.com/feed/');

  const exported = generateOpml(
    [{ id: 1, name: 'Tech & Médias' }],
    [{ category_id: 1, title: '01net', xml_url: 'https://www.01net.com/feed/', site_url: 'https://www.01net.com' }]
  );
  assert.match(exported, /xmlUrl="https:\/\/www\.01net\.com\/feed\/"/);
});

test('decodeEntities décode correctement les entités françaises et numériques', () => {
  assert.equal(decodeEntities('L&rsquo;&eacute;t&eacute; &laquo;2026&raquo; &#8212; 100&euro;'), 'L’été «2026» — 100€');
});

test('hashPassword et verifyPassword vérifient les mots de passe de manière sécurisée', () => {
  const hash = hashPassword('MonMotDePasseSecret!');
  assert.equal(verifyPassword('MonMotDePasseSecret!', hash), true);
  assert.equal(verifyPassword('MauvaisMotDePasse', hash), false);

  const cookies = parseCookies('flux_session=abc123token; theme=dark');
  assert.equal(cookies.flux_session, 'abc123token');
  assert.equal(cookies.theme, 'dark');
});

test('generateDailyBriefing et performAiSearch détectent les thèmes et les CVE', async () => {
  const sampleArticles = [
    {
      id: 1,
      feed_id: 1,
      title: 'Alerte critique : vulnérabilité CVE-2026-4821 dans OpenSSH corrigée en urgence',
      summary: 'Une faille zero-day permettant une exécution de code à distance a été identifiée par le CERT-FR (CERTFR-2026-ALE-012).',
      feed_title: 'CERT-FR',
      published_at: new Date().toISOString()
    },
    {
      id: 2,
      feed_id: 2,
      title: 'Nouveau modèle IA open source : performances en hausse pour les LLM locaux',
      summary: 'Les derniers benchmarks montrent une avancée majeure en intelligence artificielle.',
      feed_title: '01net',
      published_at: new Date().toISOString()
    }
  ];

  const briefing = await generateDailyBriefing(sampleArticles);
  assert.equal(briefing.totalAnalyzed, 2);
  assert.equal(briefing.securityAlerts.length, 1);
  assert.deepEqual(briefing.securityAlerts[0].securityIds, ['CVE-2026-4821', 'CERTFR-2026-ALE-012']);

  const cveSearch = await performAiSearch('Quelles sont les dernières CVE sorties ?', sampleArticles);
  assert.equal(cveSearch.totalMatches, 1);
  assert.equal(cveSearch.results[0].article.id, 1);
  assert.match(cveSearch.answerMarkdown, /CVE-2026-4821/);
});
