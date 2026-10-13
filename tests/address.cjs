'use strict';

// ที่อยู่จัดส่ง (v1.8.0): รันโค้ดจริงจาก index.html ใน vm พร้อม mock ของ store/call/fetch
// ทุกเคสที่เป็น "ด่าน" มีคู่ตรวจสอบแบบ negative control: ถ้าลบการ์ดออกจากซอร์ส เทสต์ต้องแดง
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = process.env.INDEX_HTML || path.join(__dirname, '../index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

function slice(re, label) {
  const m = html.match(re);
  assert.ok(m, `${label} not found in ${HTML_PATH}`);
  return m[0];
}

const K_SRC = slice(/^ {2}const K = \{.*\};$/m, 'const K declaration');
const STORE_SRC = slice(/const MIRROR = \{[\s\S]*?\n {2}const store = \{[\s\S]*?\n {2}\};/, 'cookie/store helpers');
const IDENTITY_SRC = slice(/const B32 = '[\s\S]*?const ownerParams = [^\n]*\n/, 'device key / ownerParams helpers');
const ADDRESS_SRC = slice(/ {2}const ADDR_DATA_URL = [\s\S]*?(?=\n {2}function addrCard\()/, 'address block (ADDR_DATA_URL … addrCard)');
const SESSION_SRC = slice(/function onSessionError\(err\) \{[\s\S]*?\n {2}\}/, 'onSessionError');

const EXPORTS = `({ addrOwnerTag, addrStamp, addrMutStamp, addrSameOwner, addrSyncFresh, addrMutFresh,
  addrResetLocal, addrCommit, addrList, addrMax, addrText, deliveryPref, selectedAddr, setDelivery,
  deliveryLabel, loadThaiAddr, zipOptions, syncAddresses, store, K, signedIn, ownerParams, deviceKey });`;

function addressSource(patch) {
  const code = [K_SRC, STORE_SRC, IDENTITY_SRC, ADDRESS_SRC].join('\n');
  return patch ? patch(code) : code;
}

// สภาพแวดล้อมจำลอง: localStorage/cookie ในหน่วยความจำ, call/fetch/เรนเดอร์เป็นสปาย
function createEnv(code) {
  const storage = new Map();
  const cookies = new Map();
  const renders = { addresses: 0, cart: 0 };
  const sent = [];
  const env = {
    storage, cookies, renders, sent,
    callImpl: () => Promise.reject(new Error('call() not mocked')),
    fetchImpl: () => Promise.reject(new Error('fetch() not mocked')),
  };
  const sandbox = {
    CFG: {},
    location: { hostname: 'order.example.com', protocol: 'https:' },
    document: {
      get cookie() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); },
      set cookie(str) {
        const pair = String(str).split(';')[0], i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
      },
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: k => { storage.delete(k); },
    },
    window: { crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } } },
    offline: false,
    call: (fn, arg) => { sent.push({ fn, arg }); return env.callImpl(fn, arg); },
    fetch: (...a) => env.fetchImpl(...a),
    renderAddresses: () => { renders.addresses++; },
    renderCart: () => { renders.cart++; },
    console,
  };
  env.sandbox = sandbox;
  env.api = vm.runInNewContext(code + '\n' + EXPORTS, sandbox, { filename: 'address-block.js' });
  return env;
}

const signIn = (api, email) => { api.store.set(api.K.session, 'sess-' + email); api.store.set(api.K.account, { email }); };
const signOut = api => { api.store.set(api.K.session, ''); api.store.set(api.K.account, null); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
// ค่าที่คืนจาก vm ใช้ prototype ของอีก realm: deepStrictEqual จึงไม่ผ่านแม้โครงสร้างตรงกัน
// แปลงกลับเป็นค่าโฮสต์ด้วย JSON ก่อนเทียบ (เทียบโครงสร้างเท่าเดิม ไม่ลดความเข้มของการตรวจ)
const host = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const ADDR_A = { id: 'a1', label: 'บ้าน', name: 'ก', phone: '0812345678', line: '1/2', sub: 'สีลม', dist: 'บางรัก', prov: 'กรุงเทพมหานคร', zip: '10500', is_default: true };
const ADDR_B = { id: 'a2', label: 'ที่ทำงาน', name: 'ข', phone: '0898765432', line: '9', sub: 'บางพูด', dist: 'ปากเกร็ด', prov: 'นนทบุรี', zip: '11120' };

const THAI_ADDR = {
  p: ['กรุงเทพมหานคร', 'นนทบุรี'],
  d: [['บางรัก', 0], ['ปากเกร็ด', 1]],
  z: { 10500: [['สีลม', 0], ['สุริยวงศ์', 0]], 11120: [['บางพูด', 1]] },
};

// ===== response ที่กลับมาช้า =====

test('delayed getAddresses cannot publish after the owner switches', async () => {
  const env = createEnv(addressSource());
  const { api } = env;
  api.addrCommit({ addresses: [ADDR_A], max: 2 });
  assert.deepStrictEqual(host(api.addrList().map(a => a.id)), ['a1']);

  const d = deferred();
  env.callImpl = () => d.promise;
  const sync = api.syncAddresses();
  assert.deepStrictEqual(env.sent.map(s => s.fn), ['getAddresses']);

  signIn(api, 'new@example.com');                         // สลับบัญชีระหว่างรอ response
  api.addrResetLocal();
  d.resolve({ addresses: [{ id: 'old9', label: 'ของเจ้าของเดิม' }], max: 9 });
  await sync;

  assert.deepStrictEqual(host(api.addrList()), [], 'stale response published into the new owner view');
  assert.deepStrictEqual(host(api.store.get(api.K.addresses, null)), [], 'stale response written to the cached copy');
  assert.strictEqual(api.addrMax(), 2, 'stale max applied');
  assert.strictEqual(env.renders.addresses, 0, 'stale response triggered a re-render');
  assert.strictEqual(env.renders.cart, 0, 'stale response triggered a cart re-render');
});

test('removing the addrSyncFresh guard lets the stale response through (checkpoint is load-bearing)', async () => {
  const GUARD = '    if (!addrSyncFresh(s)) return;';
  const env = createEnv(addressSource(code => {
    assert.ok(code.includes(GUARD), 'addrSyncFresh guard not found in syncAddresses');
    return code.replace(GUARD + '\n', '');
  }));
  const { api } = env;
  api.addrCommit({ addresses: [ADDR_A], max: 2 });
  const d = deferred();
  env.callImpl = () => d.promise;
  const sync = api.syncAddresses();
  signIn(api, 'new@example.com');
  api.addrResetLocal();
  d.resolve({ addresses: [{ id: 'old9', label: 'ของเจ้าของเดิม' }], max: 9 });
  await sync;
  assert.deepStrictEqual(host(api.addrList().map(a => a.id)), ['old9'],
    'unguarded syncAddresses was expected to leak the previous owner data; the guarded test above would not catch a regression');
});

test('a mutation issued while a sync is in flight invalidates the older GET', async () => {
  const env = createEnv(addressSource());
  const { api } = env;
  api.addrCommit({ addresses: [ADDR_A], max: 2 });

  const d = deferred();
  env.callImpl = () => d.promise;
  const sync = api.syncAddresses();
  const mut = api.addrMutStamp();                         // ผู้ใช้กดบันทึก/ลบระหว่างรอ GET
  d.resolve({ addresses: [], max: 2 });
  await sync;

  assert.deepStrictEqual(host(api.addrList().map(a => a.id)), ['a1'], 'GET overwrote state while a mutation was pending');
  assert.strictEqual(env.renders.addresses, 0);
  assert.strictEqual(api.addrMutFresh(mut), true, 'pending mutation should still be the newest one');

  api.addrCommit({ addresses: [ADDR_A, ADDR_B], max: 2 });   // ผลของ mutation ที่กลับมาทีหลังชนะ
  assert.deepStrictEqual(host(api.addrList().map(a => a.id)), ['a1', 'a2']);
});

test('syncAddresses sends nothing while offline and swallows call failures', async () => {
  const env = createEnv(addressSource());
  const { api } = env;
  env.sandbox.offline = true;
  await api.syncAddresses();
  assert.deepStrictEqual(env.sent, [], 'offline sync still called the backend');

  env.sandbox.offline = false;
  env.callImpl = () => Promise.reject(new Error('เครือข่ายล่ม'));
  api.addrCommit({ addresses: [ADDR_A], max: 2 });
  await assert.doesNotReject(() => api.syncAddresses());
  assert.deepStrictEqual(host(api.addrList().map(a => a.id)), ['a1'], 'failed sync cleared the cached copy');
});

// ===== ตราประทับของคำขอแก้ไข =====

test('a mutation stamp taken before a reset is rejected afterwards', () => {
  const { api } = createEnv(addressSource());
  const mut = api.addrMutStamp();
  assert.strictEqual(api.addrMutFresh(mut), true);
  api.addrResetLocal();
  assert.strictEqual(api.addrMutFresh(mut), false, 'mutation issued before the reset must not commit');
  assert.strictEqual(api.addrSameOwner(mut), true, 'same device owner: only the sequence should invalidate it');
});

test('a newer mutation stamp invalidates the older one, and an owner switch invalidates both', () => {
  const { api } = createEnv(addressSource());
  const first = api.addrMutStamp(), second = api.addrMutStamp();
  assert.strictEqual(api.addrMutFresh(first), false, 'older mutation must lose to the newer one');
  assert.strictEqual(api.addrMutFresh(second), true);

  signIn(api, 'owner@example.com');                       // เข้าสู่ระบบระหว่างรอผล
  assert.strictEqual(api.addrMutFresh(second), false, 'mutation of the previous owner must not commit');
  assert.strictEqual(api.addrSameOwner(second), false);
  assert.strictEqual(api.addrOwnerTag(), 'acct:owner@example.com');

  signOut(api);
  assert.ok(api.addrOwnerTag().startsWith('dev:'), 'signed-out owner tag should fall back to the device key');
});

test('addrResetLocal clears the copy synchronously and re-tags the owner', () => {
  const { api } = createEnv(addressSource());
  api.addrCommit({ addresses: [ADDR_A, ADDR_B], max: 5 });
  api.store.set(api.K.delivery, { method: 'ship', address_id: 'a1' });
  const deviceTag = api.addrOwnerTag();

  signIn(api, 'owner@example.com');
  api.addrResetLocal();

  assert.deepStrictEqual(host(api.store.get(api.K.addresses, null)), []);
  // store.get() จริงไม่แยก "เก็บค่า null" ออกจาก "ไม่มีคีย์" จึงอ่านด้วย default null: ทั้งสองทางแปลว่าถูกล้างแล้ว
  assert.strictEqual(api.store.get(api.K.delivery, null), null, 'the delivery selection must be dropped on reset');
  assert.strictEqual(api.addrMax(), 2, 'max should fall back to the default after a reset');
  assert.strictEqual(api.store.get(api.K.addrOwner, ''), 'acct:owner@example.com');
  assert.notStrictEqual(api.store.get(api.K.addrOwner, ''), deviceTag);
  assert.deepStrictEqual(host(api.addrList()), []);
});

test('addrList hides a cached copy that belongs to another owner', () => {
  const { api } = createEnv(addressSource());
  api.addrCommit({ addresses: [ADDR_A], max: 2 });
  api.store.set(api.K.addrOwner, 'acct:someone-else@example.com');
  assert.deepStrictEqual(host(api.addrList()), [], 'copy of another owner must not be readable');
  assert.strictEqual(api.selectedAddr(), null);
});

// ===== การเลือกที่อยู่ =====

test('selectedAddr falls back from explicit id to default to first, then to null', () => {
  const { api } = createEnv(addressSource());
  const plain = Object.assign({}, ADDR_A, { is_default: false });
  api.addrCommit({ addresses: [plain, ADDR_B], max: 2 });
  assert.strictEqual(api.selectedAddr().id, 'a1', 'no default and no selection: use the first address');

  api.addrCommit({ addresses: [plain, Object.assign({}, ADDR_B, { is_default: true })], max: 2 });
  assert.strictEqual(api.selectedAddr().id, 'a2', 'default address should win over the first one');

  api.store.set(api.K.delivery, { method: 'ship', address_id: 'a1' });
  assert.strictEqual(api.selectedAddr().id, 'a1', 'explicit selection should win over the default');

  api.addrCommit({ addresses: [], max: 2 });
  assert.strictEqual(api.selectedAddr(), null);
});

test('addrCommit drops a selection whose address was deleted on the backend', () => {
  const { api } = createEnv(addressSource());
  api.addrCommit({ addresses: [ADDR_A, ADDR_B], max: 2 });
  api.store.set(api.K.delivery, { method: 'ship', address_id: 'a2' });

  api.addrCommit({ addresses: [ADDR_A], max: 2 });        // a2 ถูกลบจากที่อื่น
  assert.strictEqual(api.deliveryPref().address_id, '', 'deleted address must not stay selected');
  assert.strictEqual(api.deliveryPref().method, 'ship', 'delivery method should be kept');
  assert.strictEqual(api.selectedAddr().id, 'a1', 'selection should fall back to the default address');
  assert.strictEqual(api.deliveryLabel(), 'จัดส่ง (บ้าน)');

  api.addrCommit({ addresses: [], max: 2 });
  assert.strictEqual(api.deliveryLabel(), 'จัดส่ง (ยังไม่เลือกที่อยู่)');
  api.store.set(api.K.delivery, { method: 'pickup', address_id: '' });
  assert.strictEqual(api.deliveryLabel(), 'รับที่บริษัท');
});

// ===== ข้อมูลรหัสไปรษณีย์ =====

async function withThaiAddr(data) {
  const env = createEnv(addressSource());
  env.fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  const loaded = await env.api.loadThaiAddr();
  assert.ok(loaded, 'thai address dataset failed to load');
  return env.api;
}

test('zipOptions resolves sub/dist/prov through the p/d/z indexes', async () => {
  const api = await withThaiAddr(THAI_ADDR);
  assert.deepStrictEqual(host(api.zipOptions('10500')), [
    { sub: 'สีลม', dist: 'บางรัก', prov: 'กรุงเทพมหานคร' },
    { sub: 'สุริยวงศ์', dist: 'บางรัก', prov: 'กรุงเทพมหานคร' },
  ]);
  assert.deepStrictEqual(host(api.zipOptions('11120')), [{ sub: 'บางพูด', dist: 'ปากเกร็ด', prov: 'นนทบุรี' }]);
  assert.deepStrictEqual(host(api.zipOptions('99999')), [], 'unknown zip should return no options');
  assert.deepStrictEqual(host(api.zipOptions('')), []);
});

test('zipOptions returns [] for prototype-key zip input', async () => {
  const api = await withThaiAddr(THAI_ADDR);
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    let out;
    assert.doesNotThrow(() => { out = api.zipOptions(key); }, `zipOptions threw for ${key}`);
    assert.deepStrictEqual(host(out), [], `zipOptions returned data for prototype key ${key}`);
  }
  assert.strictEqual(typeof Object.prototype.toString, 'function');
});

test('zipOptions drops rows whose district/province indexes are invalid', async () => {
  const api = await withThaiAddr({
    p: ['กรุงเทพมหานคร'],
    d: [['บางรัก', 0], ['เขตพัง', 7], ['ไม่ใช่แถว']],
    z: {
      10500: [
        ['สีลม', 0],                                      // แถวที่ถูกต้อง
        ['เกินดัชนี', 99], ['ติดลบ', -1], ['ไม่ใช่เลข', '0'], ['ทศนิยม', 1.5], ['ว่าง', null],
        ['จังหวัดเพี้ยน', 1],                              // d[1] ชี้จังหวัดนอกตาราง
        ['แถวสั้น', 2],                                    // d[2] ไม่ใช่แถวที่มีจังหวัด
        ['', 0],                                          // ไม่มีชื่อแขวง
        'ไม่ใช่อาเรย์', null, [],
      ],
    },
  });
  assert.deepStrictEqual(host(api.zipOptions('10500')), [{ sub: 'สีลม', dist: 'บางรัก', prov: 'กรุงเทพมหานคร' }]);
});

test('zipOptions survives a dataset with missing or malformed tables', async () => {
  const env = createEnv(addressSource());
  assert.deepStrictEqual(host(env.api.zipOptions('10500')), [], 'zipOptions before the dataset loads should return []');

  for (const bad of [{ z: { 10500: [['สีลม', 0]] } }, { z: { 10500: [['สีลม', 0]] }, d: 'x', p: [] }, { z: { 10500: 'x' }, d: [], p: [] }]) {
    const api = await withThaiAddr(Object.assign({ z: {} }, bad));
    let out;
    assert.doesNotThrow(() => { out = api.zipOptions('10500'); });
    assert.deepStrictEqual(host(out), []);
  }
});

test('the legacy zipOptions throws on the same malformed dataset (checkpoint is load-bearing)', async () => {
  const LEGACY = `  function zipOptions(zip) {
    const z = thaiAddr && Object.prototype.hasOwnProperty.call(thaiAddr.z, zip) ? thaiAddr.z[zip] : null;
    return Array.isArray(z) ? z.map(([t, di]) => ({ sub: t, dist: thaiAddr.d[di][0], prov: thaiAddr.p[thaiAddr.d[di][1]] })) : [];
  }`;
  const env = createEnv(addressSource(code => {
    const m = code.match(/ {2}function zipOptions\(zip\) \{[\s\S]*?\n {2}\}/);
    assert.ok(m, 'zipOptions not found in source');
    return code.replace(m[0], LEGACY);
  }));
  env.fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ p: ['กรุงเทพมหานคร'], d: [['บางรัก', 0]], z: { 10500: [['เกินดัชนี', 99]] } }) });
  await env.api.loadThaiAddr();
  assert.throws(() => env.api.zipOptions('10500'),
    'the unvalidated zipOptions was expected to throw; the validation test above would not catch a regression');
});

// ===== บัตรผ่านหมดอายุ =====

function createSessionEnv(code) {
  const storage = new Map(), cookies = new Map(), kv = new Map();
  const env = { storage, kv, resets: [], toasts: [], timers: [], renders: { me: 0, addresses: 0, cart: 0 } };
  // store จำลอง: ใช้ Map.has ตัดสินว่ามีคีย์หรือไม่ จึงแยก "เก็บค่า null" ออกจาก "ไม่เคยตั้งค่า" ได้
  // (store จริงเก็บผ่าน JSON แล้วยุบ null เข้ากับค่า default ซึ่งทำให้เทสต์มองไม่เห็นว่าบัญชีถูกล้างหรือไม่)
  const store = {
    get: (k, d) => (kv.has(k) ? kv.get(k) : d),
    set: (k, v) => { kv.set(k, v); },
    del: k => { kv.delete(k); },
    remove: k => { kv.delete(k); },
  };
  const sandbox = {
    store,
    location: { protocol: 'https:' },
    document: {
      get cookie() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); },
      set cookie(str) {
        const pair = String(str).split(';')[0], i = pair.indexOf('=');
        if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
      },
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: k => { storage.delete(k); },
    },
    view: 'me',
    renderMe: () => { env.renders.me++; },
    renderAddresses: () => { env.renders.addresses++; },
    renderCart: () => { env.renders.cart++; },
    toast: m => { env.toasts.push(m); },
    setTimeout: fn => { env.timers.push(fn); return env.timers.length; },
    console,
  };
  env.sandbox = sandbox;
  const api = vm.runInNewContext([K_SRC, code, '({ onSessionError, store, K });'].join('\n'), sandbox, { filename: 'session.js' });
  // addrResetLocal อยู่คนละบล็อก: จำลองเป็นสปายที่บันทึกสถานะ ณ เวลาที่ถูกเรียก
  sandbox.addrResetLocal = () => {
    env.resets.push({ session: api.store.get(api.K.session, ''), account: api.store.get(api.K.account, null) });
  };
  env.api = api;
  return env;
}

test('an expired session clears the address copy through addrResetLocal', () => {
  const env = createSessionEnv(SESSION_SRC);
  const { api } = env;
  api.store.set(api.K.session, 'sess-1');
  api.store.set(api.K.account, { email: 'owner@example.com' });
  api.store.set(api.K.history, [{ order_no: 'A1' }]);

  assert.throws(() => api.onSessionError(new Error('SESSION_INVALID: บัตรผ่านหมดอายุ')), /บัตรผ่านหมดอายุ/);

  assert.strictEqual(env.resets.length, 1, 'addrResetLocal was not called on session expiry');
  assert.strictEqual(env.resets[0].session, '', 'addrResetLocal ran before the session was cleared: it would re-tag the old owner');
  assert.strictEqual(env.resets[0].account, null, 'addrResetLocal ran before the account was cleared');
  assert.strictEqual(api.store.get(api.K.session, 'unset'), '');
  assert.strictEqual(api.store.get(api.K.account, 'unset'), null);
  assert.deepStrictEqual(host(api.store.get(api.K.history, 'unset')), []);

  assert.strictEqual(env.timers.length, 1, 'expected one deferred re-render');
  env.timers[0]();
  assert.strictEqual(env.renders.me, 1);
  assert.strictEqual(env.renders.addresses, 1, 'the address tab must be redrawn after the copy is cleared');
  assert.strictEqual(env.renders.cart, 1, 'the cart delivery line must be redrawn after the copy is cleared');
  assert.strictEqual(env.toasts.length, 1);
});

test('onSessionError leaves non-session errors and signed-out state untouched', () => {
  const env = createSessionEnv(SESSION_SRC);
  const { api } = env;
  api.store.set(api.K.session, 'sess-1');
  const boom = new Error('อย่างอื่นพัง');
  assert.throws(() => api.onSessionError(boom), e => e === boom);
  assert.strictEqual(env.resets.length, 0, 'unrelated errors must not clear the address copy');
  assert.strictEqual(api.store.get(api.K.session, ''), 'sess-1');

  const env2 = createSessionEnv(SESSION_SRC);
  assert.throws(() => env2.api.onSessionError(new Error('SESSION_INVALID: หมดอายุ')), /หมดอายุ/);
  assert.strictEqual(env2.resets.length, 0, 'nothing to clear when no session was stored');
  assert.strictEqual(env2.timers.length, 0);
});

test('an expiry path without addrResetLocal keeps the stale copy (checkpoint is load-bearing)', () => {
  const RESET = /\n\s*addrResetLocal\(\);[^\n]*/;
  assert.ok(RESET.test(SESSION_SRC), 'addrResetLocal() call not found in onSessionError');
  const env = createSessionEnv(SESSION_SRC.replace(RESET, ''));
  env.api.store.set(env.api.K.session, 'sess-1');
  assert.throws(() => env.api.onSessionError(new Error('SESSION_INVALID: หมดอายุ')), /หมดอายุ/);
  assert.strictEqual(env.resets.length, 0,
    'the patched expiry path was expected to skip the reset; the test above would not catch a regression');
});

// ===== การ์ดก่อนส่งคำขอ (อยู่ใน callback ของกล่องโต้ตอบ: ตรวจจากซอร์ส) =====

function fnSrc(name) {
  const m = html.match(new RegExp('\\n {2}(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}'));
  assert.ok(m, `function ${name} not found in source`);
  return m[0];
}

const OWNER_GUARDS = [
  { fn: 'openAddressForm', send: "call('saveAddress'" },
  { fn: 'removeAddress', send: "call('deleteAddress'" },
  { fn: 'chooseDelivery', send: 'opts.onPick(' },
  { fn: 'changeOrderDelivery', send: "call('changeDelivery'" },
];

for (const { fn, send } of OWNER_GUARDS) {
  test(`${fn} captures the owner when the dialog opens and rejects before sending`, () => {
    const src = fnSrc(fn);
    assert.ok(/const open = addrStamp\(\);/.test(src), `${fn} does not capture the owner stamp when the dialog opens`);
    const guard = src.indexOf('addrSameOwner(open)');
    const sendAt = src.indexOf(send);
    assert.ok(guard > -1, `${fn} has no addrSameOwner(open) check`);
    assert.ok(sendAt > -1, `${fn} does not contain ${send}`);
    assert.ok(guard < sendAt, `${fn} checks the owner only after sending ${send}`);
  });
}

test('the owner stamp is captured before the dialog await, not after it', () => {
  for (const { fn } of OWNER_GUARDS) {
    const src = fnSrc(fn);
    const capture = src.indexOf('const open = addrStamp();');
    const guard = src.indexOf('addrSameOwner(open)');
    assert.ok(capture > -1 && guard > -1, `${fn}: missing owner capture or owner check`);
    // กล่องโต้ตอบที่การ์ดคุ้มครองคือ await ตัวสุดท้ายก่อนการ์ด; กล่องแจ้งเตือนต้นฟังก์ชัน (เช่น fallback เมื่อไม่มี Swal) ไม่นับ
    let awaitAt = -1;
    for (const m of src.matchAll(/await (?:dialog|chooseDelivery)\(/g)) if (m.index < guard) awaitAt = m.index;
    assert.ok(awaitAt > -1, `${fn}: no dialog await before the owner check`);
    assert.ok(capture < awaitAt, `${fn} captures the owner after the dialog already awaited input`);
  }
});

test('error messages shown in the address toasts are escaped', () => {
  const start = html.indexOf('const ADDR_DATA_URL =');
  const end = html.indexOf('// ================= History =================');
  assert.ok(start > -1 && end > start, 'address section bounds not found');
  const section = html.slice(start, end);
  const lines = section.split('\n').filter(l => /toast\(/.test(l) && /\.message/.test(l));
  assert.ok(lines.length >= 3, `expected error toasts in the address section, found ${lines.length}`);
  for (const line of lines) {
    const call = line.slice(line.indexOf('toast('));
    assert.ok(/toast\(\s*esc\(/.test(call), `unescaped error message passed to toast (toast renders HTML): ${line.trim()}`);
  }
});

test('esc() neutralises an HTML payload coming back from the backend', () => {
  const m = html.match(/const esc = s => [^\n]*;/);
  assert.ok(m, 'esc helper not found');
  const esc = vm.runInNewContext(m[0] + '\nesc;', {});
  assert.strictEqual(esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.strictEqual(esc(undefined), '');
});
