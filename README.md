# Rex Store — Premium Android App Store

Production-ready, mobile-first Android APK store. No login, no database, no Supabase. GitHub Releases are the source of truth for APKs, and a simple JSON catalog (`data/apps.json`) drives the public store.

**Live flow:** `Publish dashboard → GitHub Release → APK Release Asset → update apps.json → instantly visible on store → Download button streams from GitHub`

---

## ✨ Features

- **Public Store**
  - Mobile-first, premium dark UI (Inter, gradients, glass header)
  - Homepage: featured apps + latest apps grid
  - Client-side search + category pills + sort (latest / name / category)
  - App cards: icon, name, version, category, size, download + details
  - Dedicated `app.html?id=slug` detail page: icon, full description, screenshots carousel, What's New, version metadata, Download APK
  - Fully responsive, smooth on mobile

- **Private Publish Dashboard** (`/publish/`)
  - Form: app name, version, category, short/full description, What's New, APK, icon, screenshots (up to 6)
  - Drag & drop + preview
  - On **Publish**: calls `/.netlify/functions/publish` (server-only) which:
    1. Creates a GitHub Release `slug-vX.Y.Z`
    2. Uploads APK as Release asset (`browser_download_url` is the download link)
    3. Commits icon/screenshots to `images/apps/<id>/` via Contents API
    4. Updates `data/apps.json` via Contents API
  - Store auto-shows the new app on next load

- **Tech**
  - Static HTML/CSS/vanilla JS — no build step, deployable to Netlify in 1 click
  - `data/apps.json` as single source of truth
  - Netlify Functions (Node 18, `fetch` native, `esbuild`)
  - GitHub token stays **server-side** in Netlify env vars — never shipped to browser

---

## 📁 Project Structure

```
rex-store/
├── index.html              # Homepage — featured + grid
├── app.html                # Detail page (query ?id=app-slug)
├── publish/
│   └── index.html          # Private publish dashboard
├── css/
│   └── style.css           # Premium mobile-first design system
├── js/
│   ├── store.js            # Homepage: fetch apps.json, search/filter/render
│   ├── app-detail.js       # Detail page: fetch & render single app
│   └── publish.js          # Dashboard: file→base64, POST to function
├── data/
│   └── apps.json           # Catalog — edit manually or via dashboard
├── images/
│   └── apps/<id>/          # Committed via API on publish (icons/screenshots)
├── netlify/
│   └── functions/
│       └── publish.js      # GitHub Release + asset + catalog update
├── netlify.toml            # Build + functions + headers config
├── package.json
└── README.md
```

To add/edit apps manually, just edit `data/apps.json` and commit — no function needed.

**apps.json entry shape:**

```json
{
  "id": "my-app",
  "name": "My App",
  "version": "1.0.0",
  "category": "Tools",
  "shortDesc": "One-line pitch for cards",
  "description": "Full description for detail page",
  "whatsNew": "• Feature\n• Fix",
  "icon": "https://raw.githubusercontent.com/OWNER/REPO/main/images/apps/my-app/icon.png",
  "screenshots": ["https://.../1.jpg", "https://.../2.jpg"],
  "apkUrl": "https://github.com/OWNER/REPO/releases/download/my-app-v1.0.0/app.apk",
  "size": "12.4 MB",
  "featured": false,
  "updatedAt": "2026-09-13"
}
```

---

## 🚀 Deploy to Netlify (Production)

### 1. Create GitHub repo

```bash
# in this folder
git init
git add .
git commit -m "feat: initial Rex Store"
gh repo create rex-store --public --source=. --push
# or create manually on github.com and:
git remote add origin https://github.com/<OWNER>/rex-store.git
git branch -M main
git push -u origin main
```

> Repo must be **public** or your APK release assets won't be publicly downloadable unless users are authenticated. If you need a private catalog repo, keep it public and use a private repo for APKs via separate config — not included by default.

### 2. Create GitHub Token (server-side only)

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**  
   Or **Fine-grained tokens** (recommended: Repository access → Only select repos → your rex-store repo).
2. Click **Generate new token (classic)** → scopes:
   - **`repo`** (Full control of private repositories) — required for Releases + Contents API
   - If repo is public, `public_repo` is enough, but `repo` is safest.
3. Expiration: choose per your policy (e.g., 90 days / no expiration for automation).
4. Copy the token — you will not see it again.

> Fine-grained alternative: Permissions → **Contents: Read & write**, **Metadata: Read**, and **Administration: Read & write** for Releases. Classic `repo` scope is simplest.

### 3. Configure Netlify environment variables

1. Import site: **Netlify → Add new site → Import from GitHub → select your repo**.
2. Build settings:
   - **Build command:** *(leave empty or `echo 'no build'`)*
   - **Publish directory:** `.`  (or `/` — we already set `publish = "."` in `netlify.toml`)
   - **Functions directory:** `netlify/functions` (also in `netlify.toml`)
3. Before deploying, go to **Site settings → Environment variables** and add:

| Variable | Required | Example | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | ✅ | `ghp_xxx...` | Your PAT — **never commit, never expose** |
| `GITHUB_OWNER` | ✅ | `your-username` | Repo owner / org |
| `GITHUB_REPO` | ✅ | `rex-store` | Repo name |
| `GITHUB_BRANCH` | ❌ | `main` | Default branch (default `main`) |
| `APPS_JSON_PATH` | ❌ | `data/apps.json` | Where catalog lives |
| `IMAGES_DIR` | ❌ | `images/apps` | Where icons/screenshots are committed |
| `PUBLISH_KEY` | ❌ | `some-random-secret` | Optional: if set, dashboard must send this in `x-publish-key` header |

4. **Deploy site**.

### 4. Test the publish flow

1. Open your deployed site at `https://your-site.netlify.app/publish/` (or locally via `netlify dev`).
2. Fill form: name `Test App`, version `1.0.0`, category `Tools`, descriptions, etc.
3. Upload a small `.apk` (<6MB for Netlify Free — see limits below), optional icon + screenshots.
4. If you set `PUBLISH_KEY`, enter it in the “Publish key” field.
5. Click **Publish**.
6. Check:
   - Netlify Function log → `200 success`
   - GitHub → Releases → new tag `test-app-v1.0.0` with APK asset
   - GitHub → `data/apps.json` updated
   - Public store `/` shows new app; `/app.html?id=test-app` detail works; Download button hits `browser_download_url`.

---

## 🛠️ Local Development

```bash
npm install -g netlify-cli   # if not already
# create .env for local dev (optional — or set via netlify dashboard locally)
# You can also use: netlify dev --context dev  and set vars via `netlify env:set`

# Option A: env file for netlify dev (create .env and link via netlify.toml? Simpler: export vars)
# On Windows (PowerShell):
$env:GITHUB_TOKEN="ghp_xxx"; $env:GITHUB_OWNER="you"; $env:GITHUB_REPO="rex-store"; netlify dev

# On macOS/Linux:
GITHUB_TOKEN=ghp_xxx GITHUB_OWNER=you GITHUB_REPO=rex-store netlify dev
```

Then open:
- Store: http://localhost:8888/
- Publish: http://localhost:8888/publish/
- Function: http://localhost:8888/.netlify/functions/publish (POST only)

If you prefer to test UI without GitHub, just edit `data/apps.json` and reload — no function needed.

---

## 🔐 Security Notes

- `GITHUB_TOKEN` is **only** referenced in `netlify/functions/publish.js` (`process.env.GITHUB_TOKEN`) — it is never imported or embedded in any `js/*.js` or HTML. Netlify Functions run server-side.
- `/publish/` has **no auth UI by design** (per requirements). For mild protection, set `PUBLISH_KEY` env var — then the function rejects requests without header `x-publish-key: <value>`. For stronger protection, add Netlify Password Protection or Basic Auth via `_headers` / Edge Functions (not included to keep stack simple).
- CORS is wide open for the function (`Access-Control-Allow-Origin: *`) so the store can fetch it. If you set `PUBLISH_KEY`, unauthorized POSTs are rejected.

---

## ⚠️ APK Size & Netlify Payload Limit

**Important:** Netlify Functions (AWS Lambda under the hood) have a ~6MB request payload limit on the Free/Starter tier (body + headers). Because we send APK as base64 (≈33% overhead), practical APK limit is ~4–5MB on Free.

**Options for larger APKs:**

1. **Upgrade to Netlify Pro** — higher payload limit (~10–20MB depending on plan).
2. **Compress APK** (bundle splitting, remove debug assets) to fit limit for demo.
3. **Manual flow for large APKs:** Create GitHub Release manually, upload APK as asset via GitHub web UI, then manually edit `data/apps.json` with the `browser_download_url` and commit.
4. **Self-host the function** (e.g., Vercel, Fly.io, Render) with higher limit and point dashboard to that endpoint (change `fetch` URL in `js/publish.js`).

The function logs payload size and warns; dashboard also shows a heads-up when APK >6MB.

---

## 🔄 Manual App Management (without dashboard)

You can always skip the function:

```bash
# 1. Create Release manually on GitHub → Releases → Draft new release → tag my-app-v1.1.0 → upload my-app.apk
# 2. Copy browser_download_url
# 3. Edit data/apps.json, add/update entry
# 4. Commit:
git add data/apps.json
git commit -m "feat: publish my-app v1.1.0"
git push
# Store updates on next fetch (cached 5min via headers, hard refresh if needed)
```

---

## 🧪 Verify Checklist (before shipping)

- [ ] `GITHUB_TOKEN` set in Netlify env, not in repo
- [ ] `/data/apps.json` loads on homepage, cards render
- [ ] Search + category pills filter correctly
- [ ] `/app.html?id=<id>` shows detail, screenshots, Download works
- [ ] `/publish/` form validates, shows previews, POSTs to `/.netlify/functions/publish`
- [ ] Function creates Release + asset + updates `apps.json` (check GitHub)
- [ ] New app appears on store without code deploy
- [ ] Download APK from store hits GitHub Release asset URL
- [ ] Mobile responsive (test Chrome DevTools → iPhone SE / Pixel 5)

---

## 📜 License

MIT — do as you wish. Built for Rex Store.
