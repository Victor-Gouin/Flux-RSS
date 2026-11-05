/**
 * Moteur d'Intelligence Artificielle pour Flux RSS :
 * 1. Synthèse IA des articles les plus importants du jour (Daily Briefing)
 * 2. Recherche sémantique & Question-Réponse par IA (thèmes, détection de CVE, synthèse multi-articles)
 * 3. Fonctionnement Hybride :
 *    - Moteur NLP/RAG local autonome (fonctionne immédiatement sans clé API)
 *    - Connecteur LLM optionnel (Google Gemini, OpenAI, Mistral ou Ollama local)
 */

const { htmlToPlainText } = require('./rssParser');

/**
 * Dictionnaire d'expansion sémantique pour comprendre les recherches thématiques en français et anglais
 */
const SEMANTIC_CONCEPTS = {
  cyber_cve: {
    label: 'Cybersécurité & Vulnérabilités (CVE)',
    triggers: [
      'cve',
      'faille',
      'failles',
      'vulnerabilite',
      'vulnerabilites',
      'securite',
      'cyber',
      'cybersecurite',
      'hack',
      'piratage',
      'ransomware',
      'malware',
      'exploit',
      'zero-day',
      '0-day',
      'patch',
      'correctif',
      'cert',
      'anssi',
      'phishing',
      'fuite',
      'breach',
      'backdoor'
    ],
    expansions: [
      'cve-',
      'certfr-',
      'vulnérabilité',
      'vulnérabilités',
      'faille',
      'failles',
      'sécurité',
      'cybersécurité',
      'correctif',
      'mise à jour de sécurité',
      'exécution de code',
      'déni de service',
      'ransomware',
      'malware',
      'pirate',
      'piratage',
      'exploit',
      'zero-day',
      'anssi',
      'cert-fr',
      'fuite de données',
      'attaque'
    ]
  },
  ai_llm: {
    label: 'Intelligence Artificielle & LLM',
    triggers: [
      'ia',
      'ai',
      'intelligence artificielle',
      'chatgpt',
      'openai',
      'gemini',
      'claude',
      'anthropic',
      'mistral',
      'llm',
      'modele',
      'copilot',
      'deepmind',
      'agent'
    ],
    expansions: [
      'intelligence artificielle',
      'ia',
      'chatgpt',
      'gpt-',
      'openai',
      'gemini',
      'claude',
      'mistral',
      'llm',
      'modèle',
      'génératif',
      'générative',
      'copilot',
      'neuronal',
      'deepmind',
      'ollama'
    ]
  },
  hardware: {
    label: 'Hardware, Processeurs & Composants',
    triggers: [
      'hardware',
      'processeur',
      'cpu',
      'gpu',
      'carte graphique',
      'nvidia',
      'amd',
      'intel',
      'ram',
      'ssd',
      'pc',
      'ordinateur',
      'puce',
      'rtx',
      'ryzen'
    ],
    expansions: [
      'processeur',
      'carte graphique',
      'nvidia',
      'geforce',
      'rtx',
      'amd',
      'ryzen',
      'radeon',
      'intel',
      'core',
      'puce',
      'ssd',
      'mémoire',
      'ordinateur',
      'portable',
      'composant',
      'architecture'
    ]
  },
  mobile: {
    label: 'Smartphones & Mobilité',
    triggers: [
      'smartphone',
      'telephone',
      'mobile',
      'iphone',
      'android',
      'samsung',
      'galaxy',
      'pixel',
      'xiaomi',
      'ios'
    ],
    expansions: [
      'smartphone',
      'iphone',
      'android',
      'ios',
      'samsung',
      'galaxy',
      'google pixel',
      'xiaomi',
      'batterie',
      'écran',
      'mobile',
      '5g'
    ]
  },
  linux_opensource: {
    label: 'Linux & Logiciels Libres',
    triggers: [
      'linux',
      'open source',
      'opensource',
      'libre',
      'ubuntu',
      'debian',
      'kernel',
      'noyau',
      'git',
      'docker',
      'self-hosted'
    ],
    expansions: [
      'linux',
      'open source',
      'logiciel libre',
      'ubuntu',
      'debian',
      'fedora',
      'noyau',
      'kernel',
      'github',
      'docker',
      'auto-hébergé'
    ]
  }
};

const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'et', 'ou', 'mais', 'dans', 'sur',
  'pour', 'par', 'avec', 'sans', 'sous', 'vers', 'chez', 'entre', 'ce', 'cet', 'cette', 'ces',
  'mon', 'ton', 'son', 'notre', 'votre', 'leur', 'qui', 'que', 'quoi', 'dont', 'ou', 'quel',
  'quelle', 'quels', 'quelles', 'sont', 'est', 'ete', 'etre', 'avoir', 'fait', 'faire', 'plus',
  'moins', 'tres', 'bien', 'tout', 'tous', 'toute', 'toutes', 'aux', 'au', 'en', 'y', 'a',
  'il', 'elle', 'ils', 'elles', 'on', 'nous', 'vous', 'se', 'sa', 'ses', 'leur', 'leurs',
  'articles', 'article', 'parlent', 'parle', 'sujet', 'theme', 'themes', 'trouver', 'chercher',
  'donne', 'moi', 'veux', 'savoir', 'dernieres', 'derniers', 'derniere', 'dernier', 'sortie',
  'sorties', 'sortis', 'actualite', 'actualites', 'news', 'resume', 'resumer', 'comment', 'pourquoi'
]);

/**
 * Normalise une chaîne pour la recherche (minuscules, sans accents)
 */
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extrait les identifiants CVE (ex: CVE-2026-1234) et références CERT-FR présents dans un texte
 */
function extractSecurityIds(text) {
  if (!text) return [];
  const matches = new Set();
  const cveRegex = /\bCVE-\d{4}-\d{4,7}\b/gi;
  const certRegex = /\bCERTFR-\d{4}-[A-Z]{3}-\d{3,4}\b/gi;

  let m;
  while ((m = cveRegex.exec(text)) !== null) {
    matches.add(m[0].toUpperCase());
  }
  while ((m = certRegex.exec(text)) !== null) {
    matches.add(m[0].toUpperCase());
  }
  return Array.from(matches);
}

/**
 * Détermine la catégorie thématique dominante d'un article
 */
function classifyArticleTheme(article) {
  const fullText = normalizeText(
    `${article.title || ''} ${article.summary || ''} ${article.feed_title || ''} ${article.category_name || ''}`
  );

  for (const [, concept] of Object.entries(SEMANTIC_CONCEPTS)) {
    for (const kw of concept.expansions) {
      if (fullText.includes(normalizeText(kw))) {
        return concept.label;
      }
    }
  }
  return article.category_name || 'Actualités & Tech';
}

/**
 * Calcule un score d'importance pour classer les articles les plus marquants du jour
 */
function scoreDailyImportance(article, allArticlesOfDay) {
  let score = 0;

  const title = article.title || '';
  const summary = article.summary || '';
  const combined = `${title} ${summary}`;

  // 1. Richesse informative du résumé
  if (summary.length > 100) score += 15;
  if (summary.length > 180) score += 10;
  if (article.image_url) score += 8;

  // 2. Présence d'identifiants critiques (CVE, alertes sécurité, versions majeures)
  const secIds = extractSecurityIds(combined);
  if (secIds.length > 0) score += 25;

  // 3. Mots-clés d'importance éditoriale
  if (/\b(annonce|officiel|lancement|découverte|alerte|critique|faille|exclusif|test|bilan|révolution|majeur|nouveau|nouvelle)\b/i.test(combined)) {
    score += 14;
  }

  // 4. Fraîcheur
  const ageHours = Math.max(0, (Date.now() - new Date(article.published_at).getTime()) / 3600000);
  score += Math.max(0, 24 - ageHours) * 1.2;

  // 5. Résonance thématique (si plusieurs médias parlent du même sujet aujourd'hui)
  const words = normalizeText(title)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 5 && !STOP_WORDS.has(w));

  for (const other of allArticlesOfDay) {
    if (other.id === article.id) continue;
    const otherNorm = normalizeText(other.title);
    const shared = words.filter((w) => otherNorm.includes(w));
    if (shared.length >= 2) {
      score += 12;
    }
  }

  return score;
}

/**
 * Extrait les mots-clés / tendances les plus fréquents d'un ensemble d'articles
 */
function extractTrendingKeywords(articles, maxCount = 8) {
  const counts = new Map();
  const displayMap = new Map();

  for (const a of articles) {
    const rawWords = (a.title || '').split(/[\s,.;:!?()«»"“”'’—–\-\/]+/);
    const seenInArticle = new Set();

    for (const raw of rawWords) {
      const cleaned = raw.trim();
      if (cleaned.length < 4) continue;
      const norm = normalizeText(cleaned);
      if (STOP_WORDS.has(norm) || /^\d+$/.test(norm)) continue;
      if (seenInArticle.has(norm)) continue;
      seenInArticle.add(norm);

      counts.set(norm, (counts.get(norm) || 0) + 1);
      if (!displayMap.has(norm) || /^[A-Z]/.test(cleaned)) {
        displayMap.set(norm, cleaned);
      }
    }
  }

  return Array.from(counts.entries())
    .filter(([, cnt]) => cnt >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCount)
    .map(([norm, count]) => ({
      keyword: displayMap.get(norm) || norm,
      count
    }));
}

/**
 * Appel optionnel à un LLM externe (Gemini, OpenAI, Mistral ou Ollama) si configuré
 */
async function callExternalLlmIfConfigured(settings, systemPrompt, userPrompt) {
  const provider = (settings.aiProvider || process.env.AI_PROVIDER || 'local').toLowerCase();
  const apiKey = (settings.aiApiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const model = (settings.aiModel || '').trim();

  if (provider === 'local' || (!apiKey && provider !== 'ollama')) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);

  try {
    if (provider === 'gemini') {
      const geminiModel = model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.3 }
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    }

    if (provider === 'openai' || provider === 'mistral') {
      const endpoint =
        provider === 'mistral'
          ? 'https://api.mistral.ai/v1/chat/completions'
          : 'https://api.openai.com/v1/chat/completions';
      const defaultModel = provider === 'mistral' ? 'mistral-small-latest' : 'gpt-4o-mini';

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || defaultModel,
          temperature: 0.3,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || null;
    }

    if (provider === 'ollama') {
      const host = (settings.aiOllamaUrl || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'llama3.2',
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = await res.json();
      return data.message?.content || null;
    }
  } catch (err) {
    console.warn('[AI Provider Fallback]', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }

  return null;
}

/**
 * 1. GÉNÉRATION DU BRIEFING IA DU JOUR ("Synthèse des articles les plus importants")
 */
async function generateDailyBriefing(articles, settings = {}) {
  if (!Array.isArray(articles) || articles.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      totalAnalyzed: 0,
      providerUsed: 'local',
      overview: "Aucun article récent n'est disponible pour générer la synthèse du jour. Actualisez vos flux RSS.",
      topStories: [],
      thematicSections: [],
      securityAlerts: [],
      trendingKeywords: []
    };
  }

  // Classer les articles par score d'importance
  const scored = articles.map((a) => ({
    ...a,
    theme: classifyArticleTheme(a),
    securityIds: extractSecurityIds(`${a.title} ${a.summary} ${a.content_html || ''}`),
    importanceScore: scoreDailyImportance(a, articles)
  }));

  scored.sort((a, b) => b.importanceScore - a.importanceScore);

  // Diversifier le Top 6 pour ne pas avoir 6 articles du même flux si d'autres existent
  const topStories = [];
  const perFeedCount = new Map();
  for (const item of scored) {
    if (topStories.length >= 6) break;
    const fCount = perFeedCount.get(item.feed_id) || 0;
    if (fCount >= 2 && scored.length > 8) continue;
    perFeedCount.set(item.feed_id, fCount + 1);
    topStories.push({
      id: item.id,
      title: item.title,
      summary: item.summary || htmlToPlainText(item.content_html || '', 220),
      feedTitle: item.feed_title,
      feedFavicon: item.feed_favicon_url,
      imageUrl: item.image_url,
      publishedAt: item.published_at,
      url: item.url,
      theme: item.theme,
      securityIds: item.securityIds
    });
  }

  // Regrouper par thématique
  const groupsMap = new Map();
  for (const item of scored.slice(0, 30)) {
    if (!groupsMap.has(item.theme)) {
      groupsMap.set(item.theme, []);
    }
    if (groupsMap.get(item.theme).length < 5) {
      groupsMap.get(item.theme).push({
        id: item.id,
        title: item.title,
        summary: item.summary,
        feedTitle: item.feed_title,
        publishedAt: item.published_at,
        securityIds: item.securityIds
      });
    }
  }

  const thematicSections = Array.from(groupsMap.entries()).map(([theme, items]) => ({
    theme,
    items
  }));

  // Extraire les alertes CVE / Cybersécurité du jour
  const securityAlerts = scored
    .filter(
      (a) =>
        a.securityIds.length > 0 ||
        a.theme === SEMANTIC_CONCEPTS.cyber_cve.label
    )
    .slice(0, 6)
    .map((a) => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      feedTitle: a.feed_title,
      publishedAt: a.published_at,
      securityIds: a.securityIds
    }));

  const trendingKeywords = extractTrendingKeywords(articles, 8);

  // Construire le résumé exécutif (via LLM si configuré, sinon synthèse structurée locale)
  let overview = '';
  let providerUsed = 'Moteur IA Local';

  const llmContext = topStories
    .map(
      (s, i) =>
        `${i + 1}. [${s.feedTitle}] ${s.title} — ${s.summary}`
    )
    .join('\n');

  const llmResponse = await callExternalLlmIfConfigured(
    settings,
    "Tu es un rédacteur en chef tech et cybersécurité. Rédige en français un paragraphe de synthèse exécutive (4 à 6 phrases claires, fluides et incisives) résumant les grandes tendances des actualités du jour ci-dessous.",
    `Voici les articles principaux du jour :\n${llmContext}`
  );

  if (llmResponse) {
    overview = llmResponse.trim();
    providerUsed = `IA (${settings.aiProvider || 'LLM'})`;
  } else {
    const sourcesSet = new Set(articles.map((a) => a.feed_title).filter(Boolean));
    const topThemes = thematicSections.slice(0, 3).map((t) => t.theme).join(', ');
    const leadTitles = topStories
      .slice(0, 3)
      .map((s) => `« ${s.title} » (${s.feedTitle})`)
      .join(', ');

    overview = `Sur ${articles.length} articles analysés aujourd'hui à travers ${sourcesSet.size} sources, l'actualité est principalement marquée par ${topThemes || 'la tech et le numérique'}. Parmi les sujets phares à retenir : ${leadTitles}.`;
    if (securityAlerts.length > 0) {
      overview += ` Côté cybersécurité, ${securityAlerts.length} article(s) ou alerte(s) de sécurité méritent une attention particulière.`;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalAnalyzed: articles.length,
    providerUsed,
    overview,
    topStories,
    thematicSections,
    securityAlerts,
    trendingKeywords
  };
}

/**
 * 2. RECHERCHE SÉMANTIQUE & QUESTION-RÉPONSE IA (ex: "Quelles sont les dernières CVE sorties ?")
 */
async function performAiSearch(query, allArticles, settings = {}) {
  const rawQuery = (query || '').trim();
  if (!rawQuery) {
    throw new Error('Veuillez saisir une question ou un thème de recherche.');
  }

  const normQuery = normalizeText(rawQuery);
  const queryWords = normQuery
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

  // Détecter quels concepts sémantiques sont activés par la question (ex: CVE, IA, Hardware...)
  const activeConcepts = [];
  for (const [key, concept] of Object.entries(SEMANTIC_CONCEPTS)) {
    const matchedTrigger = concept.triggers.some((t) => normQuery.includes(normalizeText(t)));
    if (matchedTrigger) {
      activeConcepts.push({ key, ...concept });
    }
  }

  const isCyberOrCveQuery = activeConcepts.some((c) => c.key === 'cyber_cve');

  // Scorer chaque article de la base par pertinence sémantique et lexicale
  const scoredMatches = [];

  for (const article of allArticles) {
    const titleNorm = normalizeText(article.title);
    const summaryNorm = normalizeText(article.summary);
    const contentPlain = htmlToPlainText(
      article.full_content_html || article.content_html || '',
      6000
    );
    const contentNorm = normalizeText(contentPlain);
    const feedNorm = normalizeText(`${article.feed_title || ''} ${article.category_name || ''}`);
    const combinedRaw = `${article.title || ''} ${article.summary || ''} ${contentPlain}`;

    let score = 0;
    const matchedReasons = new Set();

    // A. Correspondance directe des mots de la requête
    for (const w of queryWords) {
      if (titleNorm.includes(w)) {
        score += 32;
        matchedReasons.add(w);
      }
      if (summaryNorm.includes(w)) {
        score += 16;
        matchedReasons.add(w);
      }
      if (contentNorm.includes(w)) {
        score += 8;
        matchedReasons.add(w);
      }
      if (feedNorm.includes(w)) {
        score += 10;
      }
    }

    // B. Expansion sémantique (synonymes & concepts liés)
    for (const concept of activeConcepts) {
      for (const exp of concept.expansions) {
        const expNorm = normalizeText(exp);
        if (titleNorm.includes(expNorm)) {
          score += 22;
          matchedReasons.add(concept.label);
        } else if (summaryNorm.includes(expNorm) || contentNorm.includes(expNorm)) {
          score += 11;
          matchedReasons.add(concept.label);
        }
      }
    }

    // C. Détection spécifique des identifiants CVE-XXXX-XXXX et CERTFR
    const securityIds = extractSecurityIds(combinedRaw);
    if (isCyberOrCveQuery && securityIds.length > 0) {
      score += 45;
      securityIds.forEach((id) => matchedReasons.add(id));
    }

    // Si le flux est lui-même un flux de sécurité (ex: CERT-FR) lors d'une requête CVE/Sécurité
    if (isCyberOrCveQuery && /cert|anssi|securite|security|cve/i.test(article.feed_title || '')) {
      score += 28;
      matchedReasons.add('Source Cybersécurité officielle');
    }

    if (score > 0) {
      // Bonus de fraîcheur pour privilégier les dernières sorties
      const ageDays = Math.max(0, (Date.now() - new Date(article.published_at).getTime()) / 86400000);
      const recencyBoost = Math.max(0, 12 - ageDays);

      scoredMatches.push({
        article: {
          id: article.id,
          title: article.title,
          summary: article.summary || htmlToPlainText(article.content_html || '', 240),
          url: article.url,
          image_url: article.image_url,
          published_at: article.published_at,
          is_read: article.is_read,
          is_starred: article.is_starred,
          feed_title: article.feed_title,
          feed_favicon_url: article.feed_favicon_url,
          category_name: article.category_name
        },
        score: Math.round(score + recencyBoost),
        securityIds,
        matchedReasons: Array.from(matchedReasons).slice(0, 4)
      });
    }
  }

  scoredMatches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.article.published_at) - new Date(a.article.published_at);
  });

  const topMatches = scoredMatches.slice(0, 20);

  // Construire la réponse synthétique IA
  let answerMarkdown = '';
  let providerUsed = 'Moteur Sémantique IA Local';

  if (topMatches.length === 0) {
    answerMarkdown = `Je n'ai trouvé aucun article correspondant à **« ${rawQuery} »** dans vos flux actuels.\n\n**Suggestions :**\n- Cliquez sur **Actualiser les flux** pour récupérer les dernières publications.\n- Essayez des termes plus larges ou ajoutez un flux spécialisé (par exemple **CERT-FR** pour les alertes CVE).`;
  } else {
    const contextLines = topMatches
      .slice(0, 10)
      .map(
        (m, idx) =>
          `[${idx + 1}] Source: ${m.article.feed_title} | Date: ${new Date(m.article.published_at).toLocaleDateString('fr-FR')} | Titre: ${m.article.title} | Résumé: ${m.article.summary} ${
            m.securityIds.length ? '| Identifiants: ' + m.securityIds.join(', ') : ''
          }`
      )
      .join('\n');

    const llmAnswer = await callExternalLlmIfConfigured(
      settings,
      "Tu es un assistant d'analyse de veille et de cybersécurité intégré à un lecteur RSS. Réponds en français de manière structurée, précise et concise à la demande de l'utilisateur en te basant sur les articles fournis. Cite les titres ou sources entre crochets.",
      `Question de l'utilisateur : "${rawQuery}"\n\nArticles correspondants dans ses flux :\n${contextLines}`
    );

    if (llmAnswer) {
      answerMarkdown = llmAnswer.trim();
      providerUsed = `IA (${settings.aiProvider || 'LLM'})`;
    } else {
      // Génération structurée locale riche
      const allSecurityIds = Array.from(
        new Set(topMatches.flatMap((m) => m.securityIds))
      );

      const conceptHeader =
        activeConcepts.length > 0
          ? `Thématique détectée : **${activeConcepts.map((c) => c.label).join(' • ')}**\n\n`
          : '';

      let bullets = topMatches
        .slice(0, 6)
        .map((m) => {
          const dateStr = new Date(m.article.published_at).toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'short'
          });
          const secBadge =
            m.securityIds.length > 0 ? ` — **[${m.securityIds.join(', ')}]**` : '';
          const shortSum = m.article.summary
            ? ` : ${m.article.summary.slice(0, 160)}${m.article.summary.length > 160 ? '…' : ''}`
            : '';
          return `- **${m.article.title}** *(${m.article.feed_title}, ${dateStr})*${secBadge}${shortSum}`;
        })
        .join('\n');

      const cveBanner =
        allSecurityIds.length > 0
          ? `### 🛡️ Références CVE / Alertes identifiées\n\`${allSecurityIds.join('` • `')}\`\n\n`
          : '';

      answerMarkdown =
        `${conceptHeader}J'ai trouvé **${topMatches.length} article(s) pertinent(s)** dans vos flux pour **« ${rawQuery} »**.\n\n` +
        cveBanner +
        `### 📌 Synthèse des articles clés\n${bullets}`;
    }
  }

  return {
    query: rawQuery,
    providerUsed,
    totalMatches: topMatches.length,
    answerMarkdown,
    results: topMatches
  };
}

module.exports = {
  generateDailyBriefing,
  performAiSearch,
  extractSecurityIds
};
