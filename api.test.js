'use strict';
// Starts the server on a temp database and exercises the API. Run: npm test
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 4100 + Math.floor(Math.random() * 500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uniform-'));
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_PASSCODE: '2086', SESSION_SECRET: 'test-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}
const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
const form = (o = {}) => ({
  docId: 'req' + Math.random().toString(36).slice(2, 10), date: '2026-10-08', dept: '製造3課', team: 'LNCチーム',
  empno: '595', name: 'テスト', kind: '随時', urgent: false, items: { i2: 'M×1' }, ...o,
});

(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await call('GET', '/healthz')).status === 200) break; } catch {} await wait(100); }
  try {
    assert.equal((await call('GET', '/')).status, 200);
    assert.equal((await call('GET', '/api/config')).json.rosterOn, false);

    // 1. create a request; price is computed on the server
    let r = await call('POST', '/api/requests', form({ docId: 'first-req-1', items: { i2: 'M×1', i1: 'L×1' } }));
    assert.equal(r.status, 200); assert.equal(r.json.total, 2115 + 2337);

    // 2. same employee + same item (another pants type) within 6 months is rejected
    r = await call('POST', '/api/requests', form({ items: { i4: 'M×1' } }));
    assert.equal(r.status, 409); assert.equal(r.json.hits[0].key, 'pants');
    // different item is fine, other employee is fine
    assert.equal((await call('POST', '/api/requests', form({ items: { i6: 'M×1' } }))).status, 200);
    assert.equal((await call('POST', '/api/requests', form({ empno: '596', items: { i2: 'M×1' } }))).status, 200);
    // editing the same request is not rejected
    assert.equal((await call('POST', '/api/requests', form({ docId: 'first-req-1', items: { i2: 'L×1' } }))).status, 200);

    // 3. urgent needs a photo, and may repeat an item
    r = await call('POST', '/api/requests', form({ urgent: true, items: { i2: 'M×1' } }));
    assert.equal(r.status, 400); assert.equal(r.json.error, 'photo');
    assert.equal((await call('POST', '/api/requests', form({ urgent: true, photo, items: { i2: 'M×1' } }))).status, 200);

    // 4. validation
    assert.equal((await call('POST', '/api/requests', form({ items: { i2: 'M×2' } }))).json.error, 'qty');
    assert.equal((await call('POST', '/api/requests', form({ empno: '700', items: { i2: 'M×1', i3: 'M×1' } }))).json.error, 'pants');
    assert.equal((await call('POST', '/api/requests', form({ empno: '700', team: '', dept: '製造2課' }))).json.error, 'team');

    // 5. admin area is closed without the passcode
    assert.equal((await call('GET', '/api/admin/requests')).status, 401);
    assert.equal((await call('POST', '/api/admin/login', { passcode: 'nope' })).status, 401);
    const login = await call('POST', '/api/admin/login', { passcode: '2086' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    r = await call('GET', '/api/admin/requests', null, cookie);
    assert.equal(r.json.rows.length, 4);
    assert.equal(r.json.rows.some((x) => x.photo), true);
    const withPhoto = r.json.rows.find((x) => x.photo);
    assert.match((await call('GET', '/api/admin/photo/' + withPhoto.docId, null, cookie)).json.data, /^data:image\/jpeg/);
    const csv = await call('GET', '/api/admin/export.csv', null, cookie);
    assert.equal(csv.status, 200); assert.match(csv.text, /保存日時/); assert.match(csv.text.split('\n')[1], /595/);

    // 6. employee list: numbers must be registered, name comes from the list
    assert.equal((await call('POST', '/api/admin/roster', { rows: [{ empno: '１００２', name: '鈴木 花子' }, { empno: '595', name: '中原' }] }, cookie)).json.saved, 2);
    assert.deepEqual((await call('GET', '/api/lookup?empno=1002')).json, { rosterOn: true, found: true, name: '鈴木 花子' });
    assert.equal((await call('GET', '/api/lookup?empno=9999')).json.found, false);
    r = await call('POST', '/api/requests', form({ empno: '9999', items: { i6: 'M×1' } }));
    assert.equal(r.status, 422); assert.equal(r.json.error, 'notreg');
    r = await call('POST', '/api/requests', form({ empno: '1002', name: 'someone else', items: { i1: 'M×1' } }));
    assert.equal(r.status, 200); assert.equal(r.json.name, '鈴木 花子');
    assert.equal((await call('DELETE', '/api/admin/roster/1002', null, cookie)).status, 200);

    // 7. sync endpoint reports "not set up" without Google settings
    assert.equal((await call('POST', '/api/admin/sync', null, cookie)).json.enabled, false);

    console.log('All API tests passed');
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
})();
