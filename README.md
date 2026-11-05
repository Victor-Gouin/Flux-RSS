# Flux — Plateforme de Veille & Agrégateur RSS Intelligent

**Flux** est un agrégateur de flux RSS/Atom et un outil de veille conçu pour offrir une expérience de lecture épurée, rapide et assistée par l'intelligence artificielle :

- **Interface Éditoriale Minimaliste** : Trois dispositions au choix (*Vue Éditoriale*, *Vue Compacte*, *Grille Magazine*), thème **Clair & Sombre** sobre et typographie soignée.
- **Panneau de Lecture Intégré (« Reader View »)** : Extraction à la demande du texte intégral des articles (**Mode Article Complet**), personnalisation typographique et accès direct à la source.
- **Synthèse IA du Jour & Recherche Sémantique** :
  - **Résumé IA du jour** : Briefing exécutif quotidien, détection des sujets majeurs, regroupement thématique et suivi des alertes de cybersécurité (`CVE` / `CERT`).
  - **Recherche & Veille IA** : Recherche thématique et questions en langage naturel dans l'ensemble de vos flux.
  - **Moteur IA Hybride** : Moteur sémantique local autonome intégré (sans clé API requise) + compatibilité native avec Google Gemini, OpenAI, Mistral et Ollama.
- **Accès Privé & Multi-Utilisateurs** : Authentification obligatoire, inscriptions publiques désactivées, création de comptes et génération de **liens d'invitation à usage unique** par l'administrateur.
- **Standard OPML 2.0** : Importation et exportation complètes de vos dossiers et abonnements en un clic.
- **Autonome & Léger** : Propulsé par Node.js et SQLite intégré (aucune dépendance externe lourde), prêt pour Windows ou un déploiement serveur / NAS via Docker.

---

## 🚀 Démarrage rapide

### 1. En local sous Windows
Double-cliquez sur **`lancer.bat`** à la racine du projet (démarre le serveur et ouvre automatiquement `http://localhost:3000`), ou exécutez dans un terminal :
```bash
npm start
```

### 2. Sur un Serveur ou NAS (Docker)
```bash
docker compose up -d --build
```
Les données (utilisateurs, abonnements, articles) sont conservées de manière persistante dans le volume `./data`.

---

## 🔐 Première connexion & Administration

Par défaut, l'accès à l'application est privé :
- **Identifiant initial** : `admin` *(modifiable via la variable d'environnement `ADMIN_USER`)*
- **Mot de passe initial** : `admin1234` *(modifiable via `ADMIN_PASSWORD` ou directement depuis l'interface dans **Gestion des comptes → Mon mot de passe**)*

Depuis le panneau **Gestion des comptes & Invitations** (en bas de la barre latérale), l'administrateur peut :
1. **Générer des liens d'invitation à usage unique** à partager aux nouveaux utilisateurs.
2. **Créer et gérer les comptes utilisateurs** (chaque utilisateur dispose de ses propres dossiers, flux et favoris isolés).
3. **Configurer le fournisseur IA** (Moteur local intégré, Gemini, OpenAI, Mistral ou Ollama).

---

## ⌨️ Raccourcis clavier

| Touche | Action |
| :--- | :--- |
| `j` / `k` | Article suivant / précédent |
| `m` | Marquer comme lu / non-lu |
| `s` | Ajouter / retirer des favoris (★) |
| `f` | Charger l'article complet depuis la page web source |
| `v` | Ouvrir l'article sur le site original dans un nouvel onglet |
| `z` | Mode lecture plein écran centré |
| `r` | Actualiser les flux |
| `/` | Rechercher un article ou un média |
| `t` | Basculer entre le thème Clair et Sombre |
| `Échap` | Fermer le panneau de lecture ou une fenêtre |
