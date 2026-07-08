# Noor Riyadh — Live Archive Dashboard + AI Chat

Node/Express port of the original Google Apps Script web app, deployable on Render.
Reads a private Google Sheet + Drive assets live, with a Gemini-powered chat.

## Architecture

- `server.js` — Express server. Replaces `Code.gs`. Reads the Sheet + Drive via a
  Google **service account**, calls Gemini for the chat, and exposes 4 routes:
  `/api/getData`, `/api/askAI`, `/api/coversFor`, `/api/listFolder`.
- `public/index.html` — the frontend (unchanged from the Apps Script version).
- `public/gas-shim.js` — recreates `google.script.run.*` so the frontend needs no
  logic changes; it just POSTs to the routes above.

---

## 1. Google Cloud setup (one time)

1. Go to <https://console.cloud.google.com> → create a project (e.g. "noor-riyadh").
2. **APIs & Services → Library** → enable both:
   - **Google Sheets API**
   - **Google Drive API**
3. **APIs & Services → Credentials → Create credentials → Service account**.
   - Name it, click through, create. No roles needed.
4. Open the service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads. **This is your `GOOGLE_SERVICE_ACCOUNT_JSON`.** Keep it secret.
5. Copy the service account's **email** (looks like
   `something@your-project.iam.gserviceaccount.com`).
6. **Share your Google Sheet** with that email → **Viewer**.
7. **Share every Drive folder** that the sheet links to with that same email → **Viewer**
   (simplest: share the top-level parent folder). Also keep individual files set to
   "Anyone with the link" so their thumbnails render in the browser.

## 2. Gemini key

Get a free key at <https://aistudio.google.com/apikey> → that's `GEMINI_API_KEY`.

## 3. Run locally (optional but recommended)

```bash
npm install
cp .env.example .env      # then edit .env with your real values
npm start
```

Open <http://localhost:3000>. Paste the whole service-account JSON on one line into
`GOOGLE_SERVICE_ACCOUNT_JSON` in `.env`.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "Noor Riyadh archive: Apps Script -> Node/Express for Render"
git branch -M main
git remote add origin https://github.com/<you>/noor-riyadh-archive.git
git push -u origin main
```

`.env` and the key file are gitignored, so **no secrets are pushed**.

## 5. Deploy on Render

1. <https://dashboard.render.com> → **New → Web Service** → connect your GitHub repo.
2. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
3. **Environment** tab → add:
   - `SHEET_ID`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` = `gemini-2.5-flash`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = paste the entire JSON key (Render accepts multi-line
     values; the server also accepts a base64 of it).
4. Create the service. When it goes live you get a public URL — turn that into your QR code.

Editing the sheet updates the site within ~5 minutes (server cache). To refresh
immediately, visit `/api/clearCache` once.
