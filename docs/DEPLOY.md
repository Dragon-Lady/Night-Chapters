# Deploy Night Chapters

Static site · publish folder **`public/`** · no build toolchain required.

## Local

```bash
cd night-chapters   # or ~/Projects/night-chapters
npm start
# http://localhost:4343
```

Any static server works:

```bash
npx serve public -l 4343
python3 -m http.server 4343 --directory public
```

## Netlify (recommended)

### Option A — Git connected

1. Push this repo to GitHub (`Dragon-Lady/Night-Chapters`).  
2. [Netlify](https://app.netlify.com) → **Add new site** → **Import from Git**.  
3. Select the repo.  
4. Build settings (also in `netlify.toml`):  
   - **Build command:** leave empty or `echo ok`  
   - **Publish directory:** `public`  
5. Deploy. Site will be `https://<name>.netlify.app`.

### Option B — CLI

```bash
# once: npm i -g netlify-cli && netlify login
cd night-chapters
netlify init    # or netlify link
netlify deploy --prod --dir=public
```

### Notes

- Aladin loads from CDS CDN (`aladin.cds.unistra.fr`) — needs network.  
- Web Audio unlocks on **Begin night** (browser gesture).  
- Progress/pins stay in the visitor’s **localStorage** (per browser/device).  
- Export JSON for backups (Export button or `E`).

## GitHub Pages (optional)

Settings → Pages → Deploy from branch → `/docs` is **not** used.  
Either:

- set Pages to **GitHub Actions** with a static upload of `public/`, or  
- use a branch that has site root = contents of `public/` only.

Netlify is simpler for this layout.

## Custom domain

Netlify → Domain settings → add domain → DNS as guided.  
HTTPS automatic.

## Smoke after deploy

1. Open site · sky glass loads.  
2. Pick a night · **Begin** · hear ambient (if unmuted).  
3. Glide · pin · rest · closeout reflection.  
4. Export pins JSON.  
5. Refresh — progress/pins still there.
