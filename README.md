# Flux — Agrégateur RSS Moderne & Épuré

Alternative moderne, rapide et minimaliste à **FreshRSS**, combinant :
- Un **fil d'actualités éditorial style 01net** avec petites vignettes discrètes, hiérarchie typographique soignée et regroupement temporel (*Aujourd'hui*, *Hier*, *Cette semaine*).
- Un **panneau de lecture intégré (« Reader View »)** avec extraction du texte intégral des articles tronqués (**Mode Article Complet**) et lien direct vers le site original.
- Un **Design System Clair / Sombre** inspiré de Linear, Apple et Notion.
- Une **migration FreshRSS en 1 clic** grâce à l'import/export **OPML** complet.
- Un fonctionnement autonome avec base de données **SQLite intégrée** (aucune dépendance externe lourde), exécutable sur **Windows en 1 clic** ou sur **Serveur / NAS via Docker**.

---

## 🚀 Lancement rapide

### 1. Sur votre PC Windows
- Double-cliquez sur **`lancer.bat`** à la racine du projet (cela démarre le serveur et ouvre automatiquement `http://localhost:3000`), ou lancez dans un terminal :
  ```bash
  npm start
  ```

### 2. Sur un Serveur ou NAS (Docker)
```bash
docker compose up -d --build
```
Vos abonnements, favoris et articles sont stockés de façon persistante dans le dossier `./data/fluxrss.db`.

---

## 🔄 Migrer vos flux depuis FreshRSS (Import OPML)

1. Dans FreshRSS, ouvrez **Gestion des abonnements → Importer / Exporter** et cliquez sur **Exporter en OPML**.
2. Dans **Flux**, cliquez sur le bouton **OPML** en haut à gauche de la barre latérale.
3. Sélectionnez votre fichier `.opml` et cliquez sur **Lancer l'importation OPML** : tous vos dossiers et flux sont recréés et synchronisés automatiquement.

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
