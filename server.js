/**
 * Noor Riyadh — Live Archive Dashboard + AI Chat
 * Node/Express port of the original Google Apps Script backend, for Render.
 *
 * The four functions the frontend used to call via google.script.run are now
 * HTTP routes (see public/gas-shim.js which maps them 1:1):
 *   getData()                       -> POST /api/getData
 *   askAI(question, ctx, history)   -> POST /api/askAI
 *   coversFor(requestJson)          -> POST /api/coversFor
 *   listFolder(folderId)            -> POST /api/listFolder
 *
 * Each route returns a JSON *string* (exactly like Apps Script did), so the
 * frontend's existing `JSON.parse(...)` calls keep working unchanged.
 *
 * ENV VARS (set locally in .env, and in Render → Environment):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  = full service-account key JSON (or base64 of it)
 *   GOOGLE_APPLICATION_CREDENTIALS = alternatively, a path to the key file (local only)
 *   SHEET_ID                     = the spreadsheet id
 *   GEMINI_API_KEY               = key from https://aistudio.google.com/apikey
 *   GEMINI_MODEL                 = gemini-2.5-flash   (optional; this default)
 *   ANTHROPIC_API_KEY            = optional Claude fallback (Gemini takes priority)
 *   PORT                         = provided by Render automatically
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { google } = require('googleapis');

const app = express();
app.set('trust proxy', true); // Render terminates TLS upstream; trust x-forwarded-proto
app.use(express.json({ limit: '2mb' }));

// Serve the landing page with the correct absolute origin baked into the Open
// Graph tags, so WhatsApp/social link previews show the right image on ANY
// domain (localhost, *.onrender.com, or a custom domain) with no hardcoding.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  const origin = req.protocol + '://' + req.get('host');
  res.type('html').send(INDEX_HTML.replace(/__ORIGIN__/g, origin));
});

app.use(express.static(path.join(__dirname, 'public')));

const CACHE_SECONDS = 300; // 5 min server cache for the data snapshot
const SHEET_ID = process.env.SHEET_ID;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// If the primary model is overloaded (503), we retry it, then try these in order.
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash-lite,gemini-2.0-flash')
  .split(',').map(s => s.trim()).filter(Boolean);

// Map each tab to how we want to read it. Order here = how it's exposed.
const SHEETS = {
  editions:   'Editions_Table',
  curators:   'Curators',
  interviews: 'Interviews',
  artists:    'Artists_&_Artwork_Table',
  talks:      'Talks_and_Contributors',
  awards:     'Awards',
  countries:  'Countries_Distribution',
  locations:  'Locations',
  collateral: 'Collateral_and_festival_designs',
  videos:     'Videos',
  partners:   'Partnership_and_sponsorship',
  venueList:  'loaction dropdown',
  legend:     'Sheet16'
};

/* ---------- Google auth (service account) ---------- */

function loadCredentials() {
  const rawEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawEnv) {
    const trimmed = rawEnv.trim();
    const jsonStr = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed, 'base64').toString('utf8'); // allow base64-encoded key
    return JSON.parse(jsonStr);
  }
  return null; // fall back to GOOGLE_APPLICATION_CREDENTIALS file path, if set
}

const authClient = new google.auth.GoogleAuth({
  credentials: loadCredentials() || undefined,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.readonly'
  ]
});
const sheetsApi = google.sheets({ version: 'v4', auth: authClient });
const driveApi = google.drive({ version: 'v3', auth: authClient });

/* ---------- Tiny in-memory cache (replaces CacheService) ---------- */

const _cache = new Map();
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.val;
}
function cachePut(k, v, sec) { _cache.set(k, { val: v, exp: Date.now() + sec * 1000 }); }

// Fast, reliable CDN URL for a Drive IMAGE (not for pdf/video). ~2x faster than
// drive.google.com/thumbnail and CDN-cached, so repeat loads are near-instant.
function lh3_(id, w) { return 'https://lh3.googleusercontent.com/d/' + id + '=w' + (w || 800); }

// Run async fn over items with limited concurrency (keeps Drive quota happy).
async function mapLimit(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
}

/* ---------- Spreadsheet access ---------- */

// One round-trip: read every configured tab. Returns { key: values2D }.
async function readAllGrids() {
  const keys = Object.keys(SHEETS);
  const ranges = keys.map(k => `'${SHEETS[k].replace(/'/g, "''")}'`);
  const res = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges,
    valueRenderOption: 'UNFORMATTED_VALUE',     // numbers stay numbers
    dateTimeRenderOption: 'SERIAL_NUMBER'       // dates -> serials (converted in fmtDate_)
  });
  const vr = res.data.valueRanges || [];
  const grids = {};
  keys.forEach((k, i) => { grids[k] = (vr[i] && vr[i].values) || []; });
  return grids;
}

// Values grid -> array-of-objects keyed by header row.
function gridToObjects(values) {
  if (!values || values.length < 2) return [];
  const headers = (values[0] || []).map(h => String(h).trim());
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const obj = {};
    let blank = true;
    for (let c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      const v = values[r][c];
      if (v !== '' && v !== null && v !== undefined) blank = false;
      obj[headers[c]] = v;
    }
    if (!blank) rows.push(obj);
  }
  return rows;
}

// A single column (1-based) as a clean string array, optionally including row 0.
function rawColumn(values, colIndex, includeFirst) {
  const out = [];
  for (let r = (includeFirst ? 0 : 1); r < (values || []).length; r++) {
    const v = values[r] ? values[r][colIndex - 1] : '';
    if (v !== '' && v !== null && v !== undefined) out.push(String(v).trim());
  }
  return out;
}

/* ---------- Normalization helpers (ported verbatim) ---------- */

function toNumber_(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  s = s.replace(/[+,\s]/g, '');
  let mult = 1;
  const m = s.match(/([0-9.]+)\s*([kmb])?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  if (m[2]) {
    const u = m[2].toLowerCase();
    mult = u === 'k' ? 1e3 : u === 'm' ? 1e6 : 1e9;
  }
  return n * mult;
}

function editionYear_(id) {
  const m = String(id).match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Format a date cell as "18 Mar 2021". Sheets gives dates as serial numbers here.
function fmtDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  let d;
  if (typeof v === 'number') {
    // Sheets/Excel serial: day 0 = 1899-12-30 (UTC to stay locale-independent)
    d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.getUTCDate() + ' ' + MO[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.getDate() + ' ' + MO[d.getMonth()] + ' ' + d.getFullYear();
}

// Drive share link -> embeddable descriptor {kind, view, embed, thumb, ...}
function driveAsset_(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'link' || s.toLowerCase() === 'n/a') return null;

  const yt = s.match(/youtu\.?be(?:\.com)?\/(?:watch\?v=)?([\w-]{6,})/i);
  if (/youtu/i.test(s) && yt) {
    return {
      kind: 'youtube', view: s,
      embed: 'https://www.youtube.com/embed/' + yt[1],
      thumb: 'https://img.youtube.com/vi/' + yt[1] + '/hqdefault.jpg'
    };
  }
  const fileId = (s.match(/\/file\/d\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/) || [])[1];
  if (fileId) {
    return {
      kind: 'file', fileId: fileId,
      view: 'https://drive.google.com/file/d/' + fileId + '/view',
      embed: 'https://drive.google.com/file/d/' + fileId + '/preview',
      // portraits/artworks are images -> fast CDN thumbnail + ready hi-res for popups
      thumb: lh3_(fileId, 800),
      full: lh3_(fileId, 1600)
    };
  }
  const folderId = (s.match(/\/folders\/([\w-]+)/) || [])[1];
  if (folderId) {
    return {
      kind: 'folder', folderId: folderId,
      view: 'https://drive.google.com/drive/folders/' + folderId, thumb: null
    };
  }
  if (/^https?:\/\//i.test(s)) return { kind: 'raw', view: s, thumb: null };
  return null;
}

/* ---------- Drive resolution: files + folders -> image/pdf/video only ---------- */

function classifyMime_(mime) {
  if (!mime) return null;
  if (mime.indexOf('image/') === 0) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.indexOf('video/') === 0) return 'video';
  return null;
}

function fileToAsset_(file) {
  const type = classifyMime_(file.mimeType);
  if (!type) return null;
  const id = file.id;
  const isImg = type === 'image';
  return {
    id: id, name: file.name, type: type,
    embed: 'https://drive.google.com/file/d/' + id + '/preview',
    // images -> fast CDN; pdf/video keep Drive's thumbnail (first page / poster frame)
    thumb: isImg ? lh3_(id, 800) : ('https://drive.google.com/thumbnail?id=' + id + '&sz=w800'),
    full: isImg ? lh3_(id, 1600) : undefined
  };
}

async function listChildren_(folderId) {
  const res = await driveApi.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return res.data.files || [];
}

// List everything previewable inside a folder (recurses). Cached per-folder.
async function listFolder(folderId) {
  const key = 'folder_' + folderId;
  const hit = cacheGet(key);
  if (hit) return hit;

  const out = [];
  try {
    await walkFolder_(folderId, out, 0);
  } catch (e) {
    return JSON.stringify({ error: 'Folder not accessible. Share it with the service account (Viewer).', items: [] });
  }
  const result = JSON.stringify({ items: out });
  cachePut(key, result, 1800);
  return result;
}

async function walkFolder_(folderId, out, depth) {
  if (depth > 3 || out.length >= 60) return;
  const files = await listChildren_(folderId);
  for (const f of files) {
    if (out.length >= 60) break;
    if (f.mimeType === 'application/vnd.google-apps.folder') continue;
    const a = fileToAsset_(f);
    if (a) out.push(a);
  }
  for (const f of files) {
    if (out.length >= 60) break;
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      await walkFolder_(f.id, out, depth + 1);
    }
  }
}

// Fast: find ONE cover thumbnail for a folder (first image, else first video).
async function folderCover_(folderId) {
  const key = 'cover_' + folderId;
  const hit = cacheGet(key);
  if (hit !== null && hit !== undefined) return hit === '∅' ? null : hit;

  let cover = null;
  try { cover = await findCover_(folderId, 0); } catch (e) { cover = null; }
  cachePut(key, cover || '∅', 21600);
  return cover;
}

async function findCover_(folderId, depth) {
  if (depth > 2) return null;
  let files;
  try { files = await listChildren_(folderId); } catch (e) { return null; }

  let videoId = null;
  const subFolders = [];
  let scanned = 0;
  for (const f of files) {
    if (scanned >= 40) break;
    if (f.mimeType === 'application/vnd.google-apps.folder') { subFolders.push(f.id); continue; }
    scanned++;
    if (f.mimeType && f.mimeType.indexOf('image/') === 0) {
      return lh3_(f.id, 800);
    }
    if (!videoId && f.mimeType && f.mimeType.indexOf('video/') === 0) videoId = f.id;
  }
  if (videoId) return 'https://drive.google.com/thumbnail?id=' + videoId + '&sz=w800';

  let tried = 0;
  for (const sub of subFolders) {
    if (tried >= 8) break;
    const c = await findCover_(sub, depth + 1);
    tried++;
    if (c) return c;
  }
  return null;
}

// Batched: resolve covers for many folders. Input JSON [{key,folderId}] -> map.
async function coversFor(requestJson) {
  let reqs = [];
  try { reqs = JSON.parse(requestJson || '[]'); } catch (e) { reqs = []; }
  const map = {};
  // resolve up to 10 folders concurrently instead of one-by-one
  await mapLimit(reqs.slice(0, 40), 10, async (r) => {
    if (!r) return;
    if (!r.folderId) { map[r.key] = null; return; }
    map[r.key] = await folderCover_(r.folderId);
  });
  return JSON.stringify(map);
}

/* ---------- Public API: the data snapshot ---------- */

async function getDataString() {
  const hit = cacheGet('snapshot_v3');
  if (hit) return hit;

  const grids = await readAllGrids();
  const raw = {};
  Object.keys(SHEETS).forEach(k => { raw[k] = gridToObjects(grids[k]); });

  const editions = raw.editions.map(e => ({
    id: e.Edition_ID,
    year: editionYear_(e.Edition_ID) || e.year,
    startDate: fmtDate_(e.start_date),
    endDate: fmtDate_(e.end_date),
    visitors: e.total_visitors, visitorsNum: toNumber_(e.total_visitors),
    artworks: e.number_of_artworks,
    artists: e.number_of_artists,
    countries: e.number_of_Countries,
    months: e.Months_Exhibitions,
    locations: e.number_of_Locations,
    hubs: e.number_of_Hubs,
    reach: e.People_Reached,
    articles: e.number_of_Media_Articles,
    mentions: e.number_of_Mentions,
    frontOfHouse: e.number_of_Front_of_Staff_House
  })).filter(e => e.id).sort((a, b) => a.year - b.year);

  const artists = raw.artists.map(a => {
    const ed = 'Edition_' + (a.Edition || '').toString().replace(/\D/g, '');
    return {
      id: a.Artist_ID, name: (a.Artist_Name || '').toString().trim(),
      edition: ed, year: Number((a.Edition || '').toString().replace(/\D/g, '')) || null,
      nationality: (a.Nationality || '').toString().trim(),
      area: (a.Area || '').toString().trim(),
      gender: (a.Gender || '').toString().trim(),
      tier: a.Artist_Tier,
      loan: a['Loan_&_New_Commission'],
      location: (a.Artwork_Location || '').toString().trim(),
      w3w: a['W3W PIN/Link'],
      title: (a.Artwork_title || '').toString().trim(),
      desc: (a.Description_of_Artwork || '').toString().trim(),
      bio: (a['Artist Bio'] || '').toString().trim(),
      portrait: driveAsset_(a.Artist_Portrait_Image_Link),
      artwork: driveAsset_(a.Image_Link_of_Artwork)
    };
  }).filter(a => a.name);

  const curators = raw.curators.map(c => ({
    id: c.Curator_ID, edition: c.Edition_ID, name: (c.Curator_Name || '').toString().trim(),
    nationality: (c.Nationality || '').toString().trim(), gender: c.Gender,
    instagram: c.Instagram_Profile, bio: (c.Bio || '').toString().trim(),
    portrait: driveAsset_(c.Curators_portrait_image),
    interview: driveAsset_(c.Curators_Interview)
  })).filter(c => c.name);

  const awards = raw.awards.map(a => ({
    edition: a.Edition_ID, label: a.Award_Label, artist: a.Artist_Name,
    artwork: a.Artwork_Name, by: a.Awarded_by,
    cert: driveAsset_(a.Award_Certificate_Link)
  })).filter(a => a.label);

  const videos = raw.videos.map(v => ({
    edition: v.Edition_ID, type: v.Video_Type, name: v.Video_Name, link: driveAsset_(v.Video_link)
  })).filter(v => v.name);

  const talks = raw.talks.map(t => ({
    edition: t.Edition_ID, type: t.Activity_Type, topic: t.Topic, moderator: t.Moderator, speakers: t.Speakers
  })).filter(t => t.topic);

  const partners = raw.partners.map(p => ({
    edition: p.Edition_ID, name: p['Partners_&_Sponsors'], benefit: p.Benefit,
    logo: driveAsset_(p['Partners_&_Sponsors_Logo_link'])
  })).filter(p => p.name);

  const countries = raw.countries.map(row => {
    const byYear = {}; let total = 0;
    [2021, 2022, 2023, 2024, 2025].forEach(y => {
      const n = Number(row['Edition_' + y]) || 0; byYear[y] = n; total += n;
    });
    return { country: (row.Artists_Nationality || '').toString().trim(), byYear: byYear, total: total };
  }).filter(c => c.country);

  const interviews = raw.interviews.map(i => {
    const yt = (i.Youtube_link || '').toString().trim();
    return {
      edition: i.Edition_ID, name: (i.Interview_Name || '').toString().trim(),
      youtube: yt && /^https?:\/\//i.test(yt) ? yt : '',
      ytLabel: yt && !/^https?:\/\//i.test(yt) ? yt : '',
      drive: driveAsset_(i.Drive_Link)
    };
  }).filter(i => i.name);

  const designs = raw.collateral.map(d => ({
    edition: d.Edition_ID,
    type: (d.File_Type || '').toString().trim(),
    name: (d.File_Name || d.Collateral_and_festival_designs || '').toString().trim(),
    asset: driveAsset_(d.Drive_Link)
  })).filter(d => d.name && d.asset);

  const locations = raw.locations.map(l => ({
    name: (l.Location_Hub_Name || '').toString().trim(),
    type: (l.Type || '').toString().trim(),
    editions: (l['Edition _ID'] || l.Edition_ID || '').toString().trim(),
    desc: (l.Description || '').toString().trim()
  })).filter(l => l.name);

  const venues = rawColumn(grids.venueList, 1, true);
  const designCats = rawColumn(grids.legend, 1, true);
  const videoCats = rawColumn(grids.legend, 4, true);

  const snapshot = JSON.stringify({
    editions, artists, curators, awards,
    videos, talks, partners, countries,
    interviews, designs, locations,
    venues, designCats, videoCats,
    generatedAt: new Date().toISOString()
  });

  cachePut('snapshot_v3', snapshot, CACHE_SECONDS);
  return snapshot;
}

/* ---------- AI chat endpoint (server-side; key never reaches browser) ---------- */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// One Gemini call.
async function geminiCall_(model, key, payload) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
  // Disable "thinking" on 2.5 models so the whole token budget goes to the answer
  // (this app is simple data lookup; thinking just burns tokens and can truncate
  // the JSON). Older models like 2.0-flash don't support thinkingConfig, so omit it.
  let p = payload;
  if (/^gemini-2\.5/.test(model)) {
    p = { ...payload, generationConfig: { ...payload.generationConfig, thinkingConfig: { thinkingBudget: 0 } } };
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

// Call Gemini with backoff retries on transient overload (429/500/503), then
// fall back to the next model. Returns { ok, body, status, model }.
async function geminiGenerate_(key, payload) {
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACKS].filter((m, i, a) => m && a.indexOf(m) === i);
  const RETRYABLE = [429, 500, 503];
  const backoff = [0, 500, 1200]; // ms before attempts 1,2,3 on the same model
  let last = { status: 0, body: {} };
  for (const model of models) {
    for (let attempt = 0; attempt < backoff.length; attempt++) {
      if (backoff[attempt]) await sleep(backoff[attempt]);
      try {
        const r = await geminiCall_(model, key, payload);
        if (r.ok) return { ok: true, body: r.body, status: 200, model };
        last = r;
        console.warn('[gemini] ' + model + ' attempt ' + (attempt + 1) + ' -> HTTP ' + r.status + ' : ' + ((r.body && r.body.error && r.body.error.message) || 'no message'));
        if (!RETRYABLE.includes(r.status)) break; // hard error -> try next model
      } catch (e) {
        last = { status: 0, body: { error: { message: e.message } } };
        console.warn('[gemini] ' + model + ' attempt ' + (attempt + 1) + ' -> network error: ' + e.message);
      }
    }
  }
  return { ok: false, status: last.status, body: last.body };
}

async function askAI(question, contextJson, historyJson) {
  const key = process.env.GEMINI_API_KEY;
  const akey = process.env.ANTHROPIC_API_KEY;
  if (!key && !akey) {
    return JSON.stringify({ answer: 'AI is not configured yet. Add GEMINI_API_KEY as an environment variable (get a free key at aistudio.google.com).', cards: [] });
  }

  const ctx = contextJson || await compactContext_();

  let history = [];
  try { history = JSON.parse(historyJson || '[]'); } catch (e) {}
  if (!Array.isArray(history)) history = [];
  history = history.slice(-6);

  const system =
    'You are the Noor Riyadh festival archive assistant. Answer ONLY from the JSON data provided. ' +
    'Noor Riyadh is an annual light-art festival in Riyadh, Saudi Arabia (editions 2021-2025). ' +
    'The data covers editions/KPIs, artists & artworks, curators, awards, talks, partners, ' +
    'artist interviews, festival designs/collateral, locations, venues, and artist nationality counts. ' +
    'This is a multi-turn conversation: use the prior turns to resolve follow-ups and references. ' +
    'For example, if the user asked about artworks in 2025 and then says "list them" or "show them", ' +
    'they mean list/show those 2025 artworks — carry the subject and filters from earlier turns. ' +
    'Be concise and specific; cite years, names and numbers from the data. ' +
    'When an answer lists multiple items (artists, awards, designs, etc.), format it as a short ' +
    'bulleted or numbered list with each item on its own line, and use **bold** for names or key figures. ' +
    'Keep any intro to one short sentence before the list. For single-fact answers, reply in one or two sentences. ' +
    'If the answer is not in the data, say so plainly. Never invent anything.\n\n' +
    'Return STRICT JSON only, no markdown, no text before or after, with exactly this shape: ' +
    '{"answer": "<concise text answer>", "refs": [{"kind":"artist|curator|design|video|interview|award","id":"<exact id or name from data>"}]}. ' +
    'In "refs", list up to 6 specific records your answer is about, so the app can show their images/files. ' +
    'When the user asks to list or show items, ALWAYS populate refs with those items. ' +
    'Use the "id" field when present (artists, designs, curators, interviews); otherwise use the exact name. ' +
    'If no specific records apply (e.g. a pure number question), return an empty refs array.';

  if (key) {
    // ---- Google Gemini (free tier) with retry + model fallback ----
    const contents = [];
    contents.push({ role: 'user', parts: [{ text: 'DATA (JSON):\n' + ctx }] });
    contents.push({ role: 'model', parts: [{ text: '{"answer":"Understood. I will answer from this data.","refs":[]}' }] });
    history.forEach(h => {
      contents.push({ role: (h.role === 'assistant' ? 'model' : 'user'), parts: [{ text: String(h.text || '') }] });
    });
    contents.push({ role: 'user', parts: [{ text: 'QUESTION: ' + question }] });
    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' }
    };
    const r = await geminiGenerate_(key, payload);
    if (!r.ok) {
      const status = r.status || 0;
      // 503/429/500/network = transient overload -> ask the user to retry, not a scary error
      if ([0, 429, 500, 503].includes(status)) {
        return JSON.stringify({ answer: 'The AI is briefly busy (high demand). Please tap **Ask** again in a moment.', cards: [] });
      }
      const msg = (r.body && r.body.error && r.body.error.message) || 'unknown';
      return JSON.stringify({ answer: 'AI error (' + status + '): ' + msg, cards: [] });
    }
    let txt = '';
    try { txt = r.body.candidates[0].content.parts.map(p => p.text || '').join(''); } catch (e) {}
    return await normalizeAnswer_(txt);
  }

  // ---- Anthropic fallback ----
  const msgs = [];
  msgs.push({ role: 'user', content: 'DATA (JSON):\n' + ctx });
  msgs.push({ role: 'assistant', content: '{"answer":"Understood. I will answer from this data.","refs":[]}' });
  history.forEach(h => msgs.push({ role: (h.role === 'assistant' ? 'assistant' : 'user'), content: String(h.text || '') }));
  msgs.push({ role: 'user', content: 'QUESTION: ' + question });
  const ares = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': akey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system, messages: msgs })
  });
  const abody = await ares.json().catch(() => ({}));
  if (!ares.ok) return JSON.stringify({ answer: 'AI error: ' + ((abody.error && abody.error.message) || 'unknown'), cards: [] });
  const atxt = (abody.content || []).map(b => b.text || '').join('\n').trim();
  return await normalizeAnswer_(atxt);
}

// Last-resort: pull the "answer" text out of malformed/truncated JSON so the
// user still gets a readable reply instead of an error.
function salvageAnswer_(s) {
  const i = s.indexOf('"answer"');
  if (i < 0) return '';
  const q = s.indexOf('"', i + 8); // opening quote of the value
  if (q < 0) return '';
  let out = '', esc = false;
  for (let k = q + 1; k < s.length; k++) {
    const ch = s[k];
    if (esc) { out += (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch); esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') break; // clean end of the answer string
    out += ch;            // (runs to end-of-string if the JSON was truncated)
  }
  return out.trim();
}

// Validated answer + fully-resolved cards (covers already fetched).
async function normalizeAnswer_(txt) {
  let s = (txt || '').trim();
  s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim();

  let answer = '', refs = [], parsed = null;
  try { parsed = JSON.parse(s); } catch (e) {}
  if (!parsed) {
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(s.substring(start, end + 1)); } catch (e2) {}
    }
  }

  if (parsed && typeof parsed.answer === 'string') {
    answer = parsed.answer;
    refs = Array.isArray(parsed.refs) ? parsed.refs : [];
  } else {
    const salv = salvageAnswer_(s);
    if (salv) { answer = salv; refs = []; }
    else if (/^\s*[\{\[]/.test(s)) answer = 'Sorry — I had trouble formatting that answer. Please ask again.';
    else answer = s || 'No answer.';
  }
  if (/^\s*[\{\[]/.test(answer)) { answer = 'Sorry — I had trouble formatting that answer. Please ask again.'; refs = []; }

  const cards = [];
  if (refs.length) {
    const snap = JSON.parse(await getDataString());
    for (const r of refs.slice(0, 8)) {
      if (!r || !r.kind) continue;
      const hit = matchRef_(snap, r);
      if (hit) cards.push(hit);
    }
    for (const c of cards) {
      if (c.asset && c.asset.kind === 'folder' && c.asset.folderId) {
        const cover = await folderCover_(c.asset.folderId);
        if (cover) c.cover = cover;
      } else if (c.asset && c.asset.thumb) {
        c.cover = c.asset.thumb;
      } else if (c.youtube) {
        const m = c.youtube.match(/[?&]v=([\w-]+)/) || c.youtube.match(/youtu\.be\/([\w-]+)/);
        if (m) c.cover = 'https://img.youtube.com/vi/' + m[1] + '/hqdefault.jpg';
      }
    }
  }
  return JSON.stringify({ answer, cards });
}

function matchRef_(snap, r) {
  const id = (r.id || '').toString().trim();
  const lc = id.toLowerCase();
  function find(arr, keyer) {
    for (let i = 0; i < arr.length; i++) if (keyer(arr[i])) return arr[i];
    return null;
  }
  if (r.kind === 'artist') {
    const a = find(snap.artists, x => x.id === id || x.name.toLowerCase() === lc) ||
              find(snap.artists, x => x.name.toLowerCase().indexOf(lc) >= 0 && lc.length > 3);
    if (a) return { kind: 'artist', id: a.id, title: a.title || a.name, sub: a.name + ' · ' + (a.year || ''), asset: a.artwork || a.portrait };
  }
  if (r.kind === 'curator') {
    const c = find(snap.curators, x => x.id === id || x.name.toLowerCase() === lc);
    if (c) return { kind: 'curator', id: c.id, title: c.name, sub: c.nationality || '', asset: c.portrait };
  }
  if (r.kind === 'design') {
    const d = find(snap.designs, x => (x.id && x.id === id) || x.name.toLowerCase() === lc) ||
              find(snap.designs, x => x.name.toLowerCase().indexOf(lc) >= 0 && lc.length > 3);
    if (d) return { kind: 'design', title: d.name, sub: d.type || 'Design', asset: d.asset };
  }
  if (r.kind === 'video') {
    const v = find(snap.videos, x => x.name.toLowerCase() === lc) ||
              find(snap.videos, x => x.name.toLowerCase().indexOf(lc) >= 0 && lc.length > 3);
    if (v) return { kind: 'video', title: v.name, sub: v.type || 'Video', asset: v.link, isVideo: true };
  }
  if (r.kind === 'interview') {
    const iv = find(snap.interviews, x => x.name.toLowerCase() === lc) ||
               find(snap.interviews, x => x.name.toLowerCase().indexOf(lc) >= 0 && lc.length > 3);
    if (iv) return { kind: 'interview', title: iv.name, sub: 'Interview', asset: iv.drive, youtube: iv.youtube, isVideo: true };
  }
  if (r.kind === 'award') {
    const aw = find(snap.awards, x => (x.label || '').toLowerCase() === lc || (x.artist || '').toLowerCase() === lc);
    if (aw) return { kind: 'award', title: aw.label, sub: (aw.artist || '') + ' · ' + editionYear_(aw.edition), asset: aw.cert };
  }
  return null;
}

// A reduced fact set the model can reason over without huge token cost.
async function compactContext_() {
  const snap = JSON.parse(await getDataString());
  const artists = snap.artists.map(a => ({ id: a.id, name: a.name, year: a.year, nationality: a.nationality, title: a.title, location: a.location, area: a.area }));
  const curators = snap.curators.map(c => ({ id: c.id, name: c.name, edition: c.edition, nationality: c.nationality }));
  const awards = snap.awards.map(a => ({ year: editionYear_(a.edition), label: a.label, artist: a.artist, by: a.by }));
  const designs = (snap.designs || []).map(d => ({ name: d.name, year: editionYear_(d.edition), type: d.type }));
  const interviews = (snap.interviews || []).map(i => ({ name: i.name, year: editionYear_(i.edition) }));
  const videos = (snap.videos || []).map(v => ({ name: v.name, year: editionYear_(v.edition), type: v.type }));
  const locations = (snap.locations || []).map(l => ({ name: l.name, type: l.type, editions: l.editions }));
  const partners = (snap.partners || []).map(p => ({ year: editionYear_(p.edition), name: p.name, benefit: p.benefit }));
  return JSON.stringify({
    editions: snap.editions, artists, curators, awards,
    countries: snap.countries,
    talks: snap.talks.map(t => ({ year: editionYear_(t.edition), topic: t.topic, speakers: t.speakers })),
    designs, interviews, videos, locations, partners,
    venues: snap.venues, designCategories: snap.designCats, videoCategories: snap.videoCats
  });
}

/* ---------- Routes (1:1 with the old google.script.run calls) ---------- */

// Helper: send a JSON string body exactly like Apps Script returned it.
function sendStr(res, str) { res.type('application/json').send(str); }

app.post('/api/getData', async (req, res) => {
  try { sendStr(res, await getDataString()); }
  catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/askAI', async (req, res) => {
  try {
    const [question, contextJson, historyJson] = req.body.args || [];
    sendStr(res, await askAI(question, contextJson, historyJson));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/coversFor', async (req, res) => {
  try {
    const [requestJson] = req.body.args || [];
    sendStr(res, await coversFor(requestJson));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/listFolder', async (req, res) => {
  try {
    const [folderId] = req.body.args || [];
    sendStr(res, await listFolder(folderId));
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Manual cache buster (visit /api/clearCache to force a fresh sheet read + covers)
app.get('/api/clearCache', (req, res) => { _cache.clear(); res.json({ ok: true }); });

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Noor Riyadh archive running on http://localhost:' + PORT));
