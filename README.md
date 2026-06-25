# Nuvio → Stremio Bridge (Cloud / iOS)

Deploys in ~2 minutes to Render (free). Works from **any device including iPhone** — no local server needed.

---

## Deploy to Render (free, no credit card)

### Step 1 — Put this on GitHub

1. Go to **github.com → New repository** (call it `nuvio-stremio-bridge`, set to Public)
2. Upload these 3 files: `index.js`, `package.json`, `render.yaml`

### Step 2 — Deploy on Render

1. Go to **render.com** → sign up free (use your GitHub account)
2. Click **New → Web Service**
3. Connect your GitHub repo (`nuvio-stremio-bridge`)
4. Render auto-detects everything from `render.yaml` — just click **Deploy**
5. Wait ~2 minutes for the build

### Step 3 — Add to Stremio

Once deployed, Render gives you a URL like:
```
https://nuvio-stremio-bridge.onrender.com
```

Add this to Stremio (works on iPhone, Android, Apple TV, desktop — anything):
```
https://nuvio-stremio-bridge.onrender.com/manifest.json
```

In Stremio: **Add-ons → search/URL bar → paste URL → Install**

---

## Alternative: Railway

1. Go to **railway.app** → New Project → Deploy from GitHub
2. Connect this repo
3. Railway auto-runs `npm start`
4. Your URL will be `https://your-app.up.railway.app/manifest.json`

---

## How it works

```
Stremio (iOS/any device)
        ↓  GET /stream/movie/tt0468569.json
Cloud Bridge (Render)
        ↓  calls getStreams() on each provider in parallel
Nuvio provider JS files (fetched from GitHub on startup)
        ↓  scrape streaming sites
Returns stream URLs back up to Stremio
```

- Zero dependencies — uses only Node.js built-ins
- Provider files are fetched fresh from GitHub on startup, then cached 6 hours
- All 26 providers run in parallel — Stremio gets results from whichever find streams
- Render free tier spins down after inactivity; first request after that takes ~30s to wake up

---

## Render free tier notes

- **Spins down** after 15 min of inactivity → first visit after that is slow (~30s)
- To avoid this: upgrade to Render Starter ($7/mo) or use Railway (has a free allowance with no spin-down)
- The spin-down only affects the bridge waking up — streams themselves come from the providers directly

---

## Local testing (optional)

```bash
node index.js
# Then add: http://127.0.0.1:3000/manifest.json to Stremio on the same machine
```
