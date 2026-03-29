# DEPLOY.md — Procédure de push GitHub pour nkiptv-backend & nkiptv-frontend

## Méthode établie : GitHub Web Editor + CodeMirror 6 API

Le user est connecté à GitHub dans le browser — pas besoin de token.
Cette méthode a été utilisée pour tous les commits depuis la session Claude.

---

## Étapes pour modifier et pusher un fichier existant

### 1. Ouvrir l'éditeur
```
https://github.com/Issou83/nkiptv-backend/edit/main/<chemin/fichier.js>
https://github.com/Issou83/nkiptv-frontend/edit/main/<chemin/fichier.jsx>
```

### 2. Injecter le nouveau contenu via CodeMirror 6 (console JS du browser)
```js
// Encoder le fichier en base64 via bash :
// python3 -c "import base64; print(base64.b64encode(open('fichier.js','rb').read()).decode())"

// Dans la console JS du browser (page github.com/edit/...) :
const b64 = "VOTRE_BASE64_ICI";
const decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
const contentEl = document.querySelector('.cm-content');
const view = contentEl.cmTile.view;
view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: decoded } });
```

### 3. Committer
- Cliquer "Commit changes..." (bouton vert en haut à droite)
- Saisir le message de commit
- Vérifier "Commit directly to the main branch"
- Cliquer "Commit changes" dans le modal

---

## Repos

| Repo | Hébergement | Auto-deploy |
|------|-------------|-------------|
| Issou83/nkiptv-backend | Railway EU (Amsterdam) | Oui, sur push main |
| Issou83/nkiptv-frontend | Vercel | Oui, sur push main |

## Vérifier le déploiement Railway

https://railway.com/dashboard → projet **beneficial-enjoyment** → service **nkiptv-backend**
→ Attendre "Deployment successful"

## URL de production

- Backend : https://nkiptv-backend-production.up.railway.app
- Frontend : vérifier sur Vercel dashboard
