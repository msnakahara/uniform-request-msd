'use strict';
/**
 * 制服等支給申請アプリ / Uniform request web app
 * Zero dependencies. Needs Node.js >= 22.13 (uses the built-in node:sqlite).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_PASSCODE = String(process.env.ADMIN_PASSCODE || '2086');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const SHEET_TAB = process.env.SHEET_TAB || '制服申請の記録';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 700 * 1024;
const SESSION_HOURS = 8;

if (!process.env.ADMIN_PASSCODE) console.warn('[warn] ADMIN_PASSCODE is not set; using the default 2086. Set it before going live.');
if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET is not set; admin logins will end whenever the server restarts.');

// ---------------------------------------------------------------- catalogue (prices are enforced here)
const ITEMS = [
  { key: 'i1', name: '作業着（ジャケット）', price: 2337 },
  { key: 'i2', name: '作業ズボン（男性ストレッチタイプ）', price: 2115, group: 'pants' },
  { key: 'i3', name: '作業ズボン（女性ストレッチタイプ）', price: 2115, group: 'pants' },
  { key: 'i4', name: '作業ズボン（男性ゆったりタイプ）', price: 2115, group: 'pants' },
  { key: 'i5', name: '作業ズボン（女性ゆったりタイプ）', price: 2115, group: 'pants' },
  { key: 'i6', name: 'ポロシャツ', price: 1595 },
  { key: 'i7', name: '作業帽子', price: 767 },
  { key: 'i8', name: '帯電防止　キャップ', price: 275 },
  { key: 'i9', name: '上履き（ニュークリア―）', price: 1350 },
  { key: 'i10', name: '帯電防止　上履き（エレパス）', price: 750 },
  { key: 'i11', name: '安全靴（SPIDERMAX ）', price: 2024 },
  { key: 'i12', name: '安全靴（シートメタル）', price: 1732 },
  { key: 'i13', name: '熱場作業用安全靴（シートメタル）', price: 4290 },
  { key: 'i14', name: '前掛け', price: 0 },
];
const ITEM_KEYS = ITEMS.map((i) => i.key);
const orderKey = (k) => (ITEMS.find((i) => i.key === k).group === 'pants' ? 'pants' : k);

const HEADERS = ['保存日時', '申請日', '所属', 'チーム', '社員番号', '氏名', '種類', '緊急',
  ...ITEMS.map((i) => i.name), '合計金額', '写真'];

const TEAMS = {
  '製造1課': ['MCチーム', '汎用チーム'],
  '製造2課': ['Fチーム', 'ろう付けチーム', '組み立てチーム'],
  '製造3課': ['CNCチーム', 'LNCチーム', '特殊工程チーム'],
};

// ---------------------------------------------------------------- database
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'uniform.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    saved_at TEXT NOT NULL,
    req_date TEXT NOT NULL,
    dept TEXT NOT NULL,
    team TEXT NOT NULL DEFAULT '',
    empno TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    items TEXT NOT NULL,
    photo TEXT,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_requests_saved ON requests(saved_at);
  CREATE TABLE IF NOT EXISTS roster (
    empno TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    empno TEXT NOT NULL,
    item_key TEXT NOT NULL,
    at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    PRIMARY KEY (empno, item_key)
  );
`);

const q = {
  rosterCount: db.prepare('SELECT COUNT(*) AS n FROM roster'),
  rosterGet: db.prepare('SELECT name FROM roster WHERE empno = ?'),
  rosterAll: db.prepare('SELECT empno, name FROM roster ORDER BY CAST(empno AS INTEGER), empno'),
  rosterSet: db.prepare('INSERT INTO roster (empno, name) VALUES (?, ?) ON CONFLICT(empno) DO UPDATE SET name = excluded.name'),
  rosterDel: db.prepare('DELETE FROM roster WHERE empno = ?'),
  orderGet: db.prepare('SELECT at, request_id FROM orders WHERE empno = ? AND item_key = ?'),
  orderSet: db.prepare('INSERT OR REPLACE INTO orders (empno, item_key, at, request_id) VALUES (?, ?, ?, ?)'),
  reqGet: db.prepare('SELECT id, synced FROM requests WHERE id = ?'),
  reqIns: db.prepare(`INSERT INTO requests (id, saved_at, req_date, dept, team, empno, name, kind, urgent, total, items, photo, synced)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
  reqUpd: db.prepare(`UPDATE requests SET req_date=?, dept=?, team=?, empno=?, name=?, kind=?, urgent=?, total=?, items=?, photo=? WHERE id=?`),
  reqAll: db.prepare('SELECT id, saved_at, req_date, dept, team, empno, name, kind, urgent, total, items, (photo IS NOT NULL AND photo <> \'\') AS has_photo, synced FROM requests ORDER BY saved_at DESC'),
  reqPhoto: db.prepare('SELECT photo FROM requests WHERE id = ?'),
  reqUnsynced: db.prepare('SELECT id, saved_at, req_date, dept, team, empno, name, kind, urgent, total, items, (photo IS NOT NULL AND photo <> \'\') AS has_photo FROM requests WHERE synced = 0 ORDER BY saved_at ASC'),
  reqMarkSynced: db.prepare('UPDATE requests SET synced = 1 WHERE id = ?'),
  reqUnsyncedCount: db.prepare('SELECT COUNT(*) AS n FROM requests WHERE synced = 0'),
};

// ---------------------------------------------------------------- helpers
const normEmp = (e) => String(e == null ? '' : e).normalize('NFKC').trim().replace(/\s+/g, '');
const validEmp = (e) => /^[A-Za-z0-9_\-.]{1,30}$/.test(e);
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}
function jst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function rowToRecord(r) {
  return {
    docId: r.id, savedAt: r.saved_at, date: r.req_date, dept: r.dept, team: r.team, empno: r.empno, name: r.name,
    kind: r.kind, urgent: !!r.urgent, total: r.total, items: JSON.parse(r.items), photo: !!r.has_photo, synced: !!r.synced,
  };
}
function sheetRow(rec) {
  return [jst(rec.savedAt), rec.date, rec.dept, rec.team, rec.empno, rec.name, rec.kind, rec.urgent ? '●' : '',
    ...ITEM_KEYS.map((k) => rec.items[k] || ''), rec.total, rec.photo ? '✔' : ''];
}
function csvCell(c) { c = String(c); return /[",\r\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }

// ---------------------------------------------------------------- Google Sheets (optional)
let serviceAccount = null;
try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) serviceAccount = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
} catch (e) { console.error('[sheets] could not read the service account:', e.message); }
const sheetsEnabled = () => !!(SHEET_ID && serviceAccount && serviceAccount.client_email && serviceAccount.private_key);

let tokenCache = { token: '', exp: 0 };
async function googleToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error('token: ' + (j.error_description || j.error || res.status));
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}
async function gfetch(url, opts = {}) {
  const token = await googleToken();
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + res.status));
  return j;
}
let sheetReady = false;
async function ensureSheet() {
  if (sheetReady) return;
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}`;
  const meta = await gfetch(`${base}?fields=sheets.properties.title`);
  const has = (meta.sheets || []).some((s) => s.properties.title === SHEET_TAB);
  if (!has) await gfetch(`${base}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] }) });
  const first = await gfetch(`${base}/values/${encodeURIComponent(SHEET_TAB + '!A1:A1')}`);
  if (!first.values || !first.values.length) {
    await gfetch(`${base}/values/${encodeURIComponent(SHEET_TAB + '!A1')}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [HEADERS] }) });
  }
  sheetReady = true;
}
let syncing = false;
async function syncSheet() {
  if (!sheetsEnabled() || syncing) return { enabled: sheetsEnabled(), added: 0 };
  syncing = true;
  let added = 0;
  try {
    await ensureSheet();
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}`;
    for (const r of q.reqUnsynced.all()) {
      await gfetch(`${base}/values/${encodeURIComponent(SHEET_TAB + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: [sheetRow(rowToRecord(r))] }) });
      q.reqMarkSynced.run(r.id);
      added++;
    }
    return { enabled: true, added };
  } catch (e) {
    console.error('[sheets] sync failed:', e.message);
    return { enabled: true, added, error: e.message };
  } finally { syncing = false; }
}

// ---------------------------------------------------------------- auth + rate limits
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now > h.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60000).unref();

const sign = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function makeToken() { const exp = Date.now() + SESSION_HOURS * 3600 * 1000; return exp + '.' + sign('admin.' + exp); }
function isAdmin(req) {
  const m = /(?:^|;\s*)uniform_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, mac] = m[1].split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign('admin.' + exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '') === 'https';

// ---------------------------------------------------------------- http plumbing
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

// ---------------------------------------------------------------- request creation
function validatePhoto(p) {
  return typeof p === 'string' && p.length <= 450000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p);
}
function createRequest(b) {
  const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });
  const empno = normEmp(b.empno);
  if (!validEmp(empno)) return fail(400, 'empno');

  // employee list: when it has anyone in it, only listed numbers can apply and the name comes from the list
  let name = clean(b.name, 60);
  if (q.rosterCount.get().n > 0) {
    const hit = q.rosterGet.get(empno);
    if (!hit) return fail(422, 'notreg');
    name = hit.name;
  }
  if (!name) return fail(400, 'name');

  const dept = clean(b.dept, 40), team = clean(b.team, 40);
  if (!dept) return fail(400, 'dept');
  if (TEAMS[dept] && !TEAMS[dept].includes(team)) return fail(400, 'team');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return fail(400, 'date');
  if (b.kind !== '定期' && b.kind !== '随時') return fail(400, 'kind');

  const items = {}; let any = false, pants = 0, total = 0;
  for (const it of ITEMS) {
    const v = clean((b.items || {})[it.key], 60);
    if (!v) { items[it.key] = ''; continue; }
    if (!/×1$/.test(v)) return fail(400, 'qty');               // quantity is 1 per item
    if (it.key !== 'i14' && v.replace(/×1$/, '').trim() === '') return fail(400, 'size');
    items[it.key] = v; any = true; total += it.price;
    if (it.group === 'pants') pants++;
  }
  if (!any) return fail(400, 'items');
  if (pants > 1) return fail(400, 'pants');

  const urgent = !!b.urgent;
  let photo = null;
  if (urgent) {
    if (!validatePhoto(b.photo)) return fail(400, 'photo');
    photo = b.photo;
  }

  const id = clean(b.docId, 40);
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return fail(400, 'id');

  // same employee number + same item within 6 months => reject (urgent with a photo may repeat)
  if (!urgent) {
    const now = new Date(), found = [], seen = new Set();
    for (const it of ITEMS) {
      if (!items[it.key]) continue;
      const k = orderKey(it.key); if (seen.has(k)) continue; seen.add(k);
      const o = q.orderGet.get(empno, k);
      if (!o || o.request_id === id) continue;
      const at = new Date(o.at), next = addMonths(at, 6);
      if (next > now) found.push({ key: k, at: at.toISOString(), next: next.toISOString() });
    }
    if (found.length) return fail(409, 'dup', { hits: found });
  }

  const savedAt = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const existing = q.reqGet.get(id);
    if (existing) q.reqUpd.run(b.date, dept, team, empno, name, b.kind, urgent ? 1 : 0, total, JSON.stringify(items), photo, id);
    else q.reqIns.run(id, savedAt, b.date, dept, team, empno, name, b.kind, urgent ? 1 : 0, total, JSON.stringify(items), photo);
    const seen = new Set();
    for (const it of ITEMS) { if (!items[it.key]) continue; const k = orderKey(it.key); if (seen.has(k)) continue; seen.add(k); q.orderSet.run(empno, k, savedAt, id); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { status: 200, body: { ok: true, id, name, total } };
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = ipOf(req);

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
  if (p === '/healthz') return send(res, 200, 'ok');
  if (!p.startsWith('/api/')) return send(res, 404, 'Not found');

  // ---- public
  if (req.method === 'GET' && p === '/api/config') {
    return send(res, 200, { rosterOn: q.rosterCount.get().n > 0 });
  }
  if (req.method === 'GET' && p === '/api/lookup') {
    if (limited('lookup:' + ip, 60, 60000)) return send(res, 429, { error: 'rate' });
    const empno = normEmp(url.searchParams.get('empno'));
    const rosterOn = q.rosterCount.get().n > 0;
    const hit = rosterOn && validEmp(empno) ? q.rosterGet.get(empno) : null;
    return send(res, 200, { rosterOn, found: !!hit, name: hit ? hit.name : '' });
  }
  if (req.method === 'POST' && p === '/api/requests') {
    if (limited('req:' + ip, 40, 600000)) return send(res, 429, { error: 'rate' });
    const out = createRequest(await readJson(req));
    if (out.status === 200) syncSheet().catch(() => {});
    return send(res, out.status, out.body);
  }

  // ---- admin session
  if (req.method === 'POST' && p === '/api/admin/login') {
    if (limited('login:' + ip, 8, 600000)) return send(res, 429, { error: 'rate' });
    const b = await readJson(req);
    if (!safeEqual(b.passcode || '', ADMIN_PASSCODE)) return send(res, 401, { error: 'passcode' });
    const cookie = `uniform_admin=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${isHttps(req) ? '; Secure' : ''}`;
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (req.method === 'POST' && p === '/api/admin/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'uniform_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }

  // ---- admin only below
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });

  if (req.method === 'GET' && p === '/api/admin/requests') {
    return send(res, 200, {
      rows: q.reqAll.all().map(rowToRecord),
      sheets: { enabled: sheetsEnabled(), unsynced: q.reqUnsyncedCount.get().n },
    });
  }
  if (req.method === 'GET' && p.startsWith('/api/admin/photo/')) {
    const r = q.reqPhoto.get(decodeURIComponent(p.slice('/api/admin/photo/'.length)));
    if (!r || !r.photo) return send(res, 404, { error: 'none' });
    return send(res, 200, { data: r.photo });
  }
  if (req.method === 'GET' && p === '/api/admin/export.csv') {
    const lines = [HEADERS, ...q.reqAll.all().map((r) => sheetRow(rowToRecord(r)))].map((r) => r.map(csvCell).join(','));
    return send(res, 200, '﻿' + lines.join('\r\n'), {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="uniform-requests.csv"',
    });
  }
  if (req.method === 'POST' && p === '/api/admin/sync') {
    return send(res, 200, await syncSheet());
  }
  if (req.method === 'GET' && p === '/api/admin/roster') {
    return send(res, 200, { rows: q.rosterAll.all() });
  }
  if (req.method === 'POST' && p === '/api/admin/roster') {
    const b = await readJson(req);
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const e = normEmp(r.empno), nm = clean(r.name, 60);
        if (!validEmp(e) || !nm) continue;
        q.rosterSet.run(e, nm); n++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (!n) return send(res, 400, { error: 'bad' });
    return send(res, 200, { ok: true, saved: n });
  }
  if (req.method === 'DELETE' && p.startsWith('/api/admin/roster/')) {
    q.rosterDel.run(normEmp(decodeURIComponent(p.slice('/api/admin/roster/'.length))));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server' });
    if (!e.status) console.error(e);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Uniform request app on http://localhost:${PORT}  (data: ${DATA_DIR})`);
    console.log(sheetsEnabled() ? '[sheets] Google Sheets sync is ON' : '[sheets] Google Sheets sync is off (set GOOGLE_SHEET_ID + service account to turn it on)');
    syncSheet().catch(() => {});
  });
}
module.exports = { server, createRequest, db };
