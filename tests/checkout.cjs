'use strict';

// ยืนยัน/ส่งคำสั่งซื้อ (v1.8.0): รันฟังก์ชัน checkout() ตัวจริงจาก index.html ใน vm พร้อม mock รอบตัว
// โฟกัส: เจ้าของเปลี่ยน (ออกจากระบบ / บัตรผ่านหมดอายุ) หรือที่อยู่ถูกแก้/ลบ ระหว่างกล่องยืนยันเปิดอยู่
// ทุกด่านมีคู่ตรวจสอบแบบ negative control: ถ้าลบการ์ดออกจากซอร์ส เทสต์คู่นั้นต้องแดง
// INDEX_HTML=<path> เพื่อรันกับไฟล์อื่น (ใช้ยิง RED ใส่ซอร์สก่อนแก้ได้)
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
const CHECKOUT_SRC = slice(/^ {2}async function checkout\(\) \{[\s\S]*?\n {2}\}$/m, 'checkout()');

const PRELUDE = 'let pending = null;';
const EXPORTS = `({ checkout, getPending: () => pending, addrStamp, addrCommit, addrResetLocal, addrList,
  deliveryPref, selectedAddr, setDelivery, store, K, signedIn, ownerParams, deviceKey });`;

function checkoutSource(patch) {
  return [K_SRC, STORE_SRC, IDENTITY_SRC, ADDRESS_SRC, PRELUDE, patch ? patch(CHECKOUT_SRC) : CHECKOUT_SRC].join('\n');
}
// ตัดการ์ดออกเพื่อพิสูจน์ว่าเทสต์จับได้จริง (ไม่ใช่ผ่านเพราะ mock)
function strip(re, label) {
  return code => {
    assert.ok(re.test(code), `${label} not found in checkout() — negative control ไม่มีความหมาย`);
    return code.replace(re, '');
  };
}

// สภาพแวดล้อมจำลอง: localStorage/cookie ในหน่วยความจำ, call/dialog/เรนเดอร์เป็นสปาย
function createEnv(opts) {
  const o = opts || {};
  const storage = new Map();
  const cookies = new Map();
  const sent = [], dialogs = [], alerts = [], validation = [];
  const renders = { grid: 0, cart: 0, totals: 0, addresses: 0 };
  const cart = Object.assign({ A1: 2 }, o.cart || {});
  const env = {
    storage, cookies, sent, dialogs, alerts, validation, renders, cart,
    persisted: 0, went: '', slip: false,
    callImpl: () => Promise.reject(new Error('call() not mocked')),
    formImpl: () => null,
    beforeSubmit: null,                                 // สิ่งที่เกิดขึ้น "ขณะกล่องยืนยันเปิดอยู่"
    onResult: () => ({ isConfirmed: false, isDenied: true }),
  };
  const LINES = [{ code: 'A1', qty: 2, unit: 'ชิ้น', total: 200, p: { name: 'สินค้า ก' } }];
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
    window: {
      crypto: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
      Swal: { isLoading: () => false, showValidationMessage: m => { validation.push(String(m)); }, DismissReason: { cancel: 'cancel' } },
    },
    get Swal() { return sandbox.window.Swal; },
    offline: false,
    hasSwal: true,
    HISTORY_MAX: 50,
    SW_CLASS: {},
    profile: { full_name: 'ก ข', department: 'บัญชี', phone: '0810000000' },
    cart,
    lines: () => LINES.map(l => Object.assign({}, l)),
    priced: () => ({ n: 1, amt: 200, net: 200, disc: 0, coupon: null }),
    profileOk: () => true,
    askProfile: async () => true,
    precheckCart: async () => true,
    openAddressForm: async () => env.formImpl(),
    newId: () => 'req-1',
    deviceInfo: () => ({ ua: 'test' }),
    call: (fn, arg) => { sent.push({ fn, arg }); return env.callImpl(fn, arg); },
    fetch: () => Promise.reject(new Error('fetch() not mocked')),
    dialog: async cfg => {
      dialogs.push(cfg);
      if (!cfg.preConfirm) return env.onResult(cfg);     // กล่องสรุปผล / กล่องเตือน
      if (env.beforeSubmit) await env.beforeSubmit(env.api);
      if (!sandbox.hasSwal) return { isConfirmed: true };   // กล่องสำรองของเบราว์เซอร์: ไม่มี preConfirm
      return { isConfirmed: true, value: await cfg.preConfirm() };
    },
    alert: m => { alerts.push(String(m)); },
    toast: () => {},
    esc: v => String(v === null || v === undefined ? '' : v),
    num: v => String(v),
    baht: v => String(v),
    fmtDeadline: v => String(v),
    cartQtyText: () => '2 ชิ้น',
    qtyText: () => '2 ชิ้น',
    uomOf: () => 'ชิ้น',
    iconColor: () => '#000',
    haptic: () => {},
    saveCart: () => {},
    renderGrid: () => { renders.grid++; },
    renderCart: () => { renders.cart++; },
    renderTotals: () => { renders.totals++; },
    renderAddresses: () => { renders.addresses++; },
    requestPersist: () => { env.persisted++; },
    go: p => { env.went = p; },
    openSlip: () => { env.slip = true; },
    console,
  };
  env.sandbox = sandbox;
  env.api = vm.runInNewContext(checkoutSource(o.patch) + '\n' + EXPORTS, sandbox, { filename: 'checkout-block.js' });
  return env;
}

const signIn = (api, email) => { api.store.set(api.K.session, 'sess-' + email); api.store.set(api.K.account, { email }); };
const signOut = api => { api.store.set(api.K.session, ''); api.store.set(api.K.account, null); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
// ค่าที่คืนจาก vm ใช้ prototype ของอีก realm: แปลงกลับเป็นค่าโฮสต์ด้วย JSON ก่อนเทียบ
const host = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const ADDR_A = { id: 'a1', label: 'บ้าน', name: 'ก', phone: '0812345678', line: '1/2', sub: 'สีลม', dist: 'บางรัก', prov: 'กรุงเทพมหานคร', zip: '10500', is_default: true };

const RESULT = {
  order_no: 'SO-1', created_at: '2026-10-13 10:00', status: 'รอดำเนินการ',
  total_qty: 2, total_amount: 200, subtotal: 200, delivery: 'จัดส่ง', ship_to: '1/2 สีลม',
};

const placeOrders = env => env.sent.filter(s => s.fn === 'placeOrder');
const seedShip = (api, addr) => { api.addrCommit({ addresses: [addr], max: 2 }); api.setDelivery({ method: 'ship', address_id: addr.id }); };
// สลับเจ้าของแบบเดียวกับตอนออกจากระบบ/บัตรผ่านหมดอายุ
const switchOwner = api => { signOut(api); api.addrResetLocal(); };

// ===== เจ้าของเปลี่ยนก่อนกดส่งจริง =====
test('สลับบัญชีขณะกล่องยืนยันเปิดอยู่ (จัดส่ง): ต้องไม่เรียก placeOrder เลย', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  env.callImpl = () => Promise.resolve(RESULT);
  env.beforeSubmit = () => switchOwner(api);

  await api.checkout();

  assert.deepStrictEqual(placeOrders(env), [], 'เจ้าของเปลี่ยนแล้วยังส่งคำสั่งซื้อ');
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 0);
  assert.deepStrictEqual(Object.keys(env.cart), ['A1'], 'ห้ามล้างตะกร้าเมื่อไม่ได้ส่ง');
  assert.strictEqual(env.dialogs.length, 1, 'ต้องไม่มีกล่อง "ส่งคำสั่งซื้อแล้ว"');
  assert.ok(env.validation.length >= 1, 'ต้องบอกผู้ใช้ว่าทำไมส่งไม่ได้');
  const saved = host(api.store.get(api.K.pendingOrder, null));
  assert.ok(saved && saved.id, 'ยังไม่ได้ส่งจริง: ต้องเก็บ request_id เดิมไว้กันสั่งซ้ำ');
});

test('สลับบัญชีขณะกล่องยืนยันเปิดอยู่ (รับที่บริษัท): ต้องไม่เรียก placeOrder เลย', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  api.setDelivery({ method: 'pickup', address_id: '' });
  env.callImpl = () => Promise.resolve(RESULT);
  env.beforeSubmit = () => switchOwner(api);

  await api.checkout();

  assert.deepStrictEqual(placeOrders(env), []);
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 0);
});

// ===== เจ้าของคนเดิม แต่ที่อยู่ไม่เหมือนเดิมแล้ว =====
test('เจ้าของคนเดิมแต่ที่อยู่ถูกแก้ระหว่างยืนยัน: ต้องไม่ส่งด้วยที่อยู่เก่า', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  env.callImpl = () => Promise.resolve(RESULT);
  env.beforeSubmit = () => api.addrCommit({ addresses: [Object.assign({}, ADDR_A, { line: '99/9', zip: '10110' })], max: 2 });

  await api.checkout();

  assert.deepStrictEqual(placeOrders(env), []);
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 0);
  assert.ok(env.validation.length >= 1);
});

test('เจ้าของคนเดิมแต่ที่อยู่ถูกลบระหว่างยืนยัน: ต้องไม่ส่ง', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  env.callImpl = () => Promise.resolve(RESULT);
  env.beforeSubmit = () => api.addrCommit({ addresses: [], max: 2 });

  await api.checkout();

  assert.deepStrictEqual(placeOrders(env), []);
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 0);
});

// ===== เส้นทางปกติต้องไม่ถูกขวาง =====
test('เจ้าของคนเดิมและที่อยู่เดิม (sync ได้ข้อมูลเดิมกลับมา): ส่งได้ตามปกติ', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  env.callImpl = () => Promise.resolve(RESULT);
  env.beforeSubmit = () => api.addrCommit({ addresses: [Object.assign({}, ADDR_A)], max: 2 });   // sync ปกติ: เนื้อหาเท่าเดิม

  await api.checkout();

  const calls = placeOrders(env);
  assert.strictEqual(calls.length, 1, 'sync ที่ได้ข้อมูลเดิมกลับมาต้องไม่ขวางการส่ง');
  assert.deepStrictEqual(host(calls[0].arg.delivery), { method: 'ship', address_id: 'a1' });
  assert.strictEqual(host(calls[0].arg.request_id), 'req-1');
  const hist = host(api.store.get(api.K.history, []));
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].order_no, 'SO-1');
  assert.deepStrictEqual(Object.keys(env.cart), [], 'ส่งสำเร็จต้องล้างตะกร้า');
  assert.strictEqual(host(api.store.get(api.K.pendingOrder, null)), null);
  assert.strictEqual(env.dialogs.length, 2, 'ต้องมีกล่อง "ส่งคำสั่งซื้อแล้ว"');
});

test('รับที่บริษัท เจ้าของคนเดิม: ส่งได้ตามปกติ', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  api.setDelivery({ method: 'pickup', address_id: '' });
  env.callImpl = () => Promise.resolve(Object.assign({}, RESULT, { delivery: 'รับที่บริษัท', ship_to: '' }));

  await api.checkout();

  const calls = placeOrders(env);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(host(calls[0].arg.delivery), { method: 'pickup', address_id: '' });
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 1);
});

// ===== กล่องสำรองของเบราว์เซอร์ (ไม่มี SweetAlert) =====
test('กล่องสำรอง: สลับบัญชีก่อนกดตกลง ต้องไม่เรียก placeOrder', async () => {
  const env = createEnv(), api = env.api;
  env.sandbox.hasSwal = false;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  env.callImpl = () => Promise.resolve(RESULT);
  env.beforeSubmit = () => switchOwner(api);

  await api.checkout();

  assert.deepStrictEqual(placeOrders(env), [], 'ทางสำรองต้องมีการ์ดเหมือนกัน');
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 0);
  assert.deepStrictEqual(Object.keys(env.cart), ['A1']);
  assert.ok(env.alerts.length >= 1, 'ต้องบอกผู้ใช้ว่าทำไมส่งไม่ได้');
});

test('กล่องสำรอง: เจ้าของคนเดิม ส่งได้ตามปกติ', async () => {
  const env = createEnv(), api = env.api;
  env.sandbox.hasSwal = false;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  env.callImpl = () => Promise.resolve(RESULT);

  await api.checkout();

  assert.strictEqual(placeOrders(env).length, 1);
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 1);
});

// ===== response ที่กลับมาช้า =====
test('ผลกลับมาช้าหลังสลับบัญชี: ห้ามเขียนประวัติ/ล้างตะกร้าให้เจ้าของคนใหม่', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  const d = deferred(), started = deferred();
  env.callImpl = () => { started.resolve(); return d.promise; };

  const p = api.checkout();
  await started.promise;
  switchOwner(api);                                     // บัตรผ่านหมดอายุระหว่างรอผล
  d.resolve(RESULT);
  await p;

  assert.strictEqual(placeOrders(env).length, 1);
  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 0, 'คำสั่งซื้อของเจ้าของเดิมไปโผล่ในประวัติของคนใหม่');
  assert.deepStrictEqual(Object.keys(env.cart), ['A1'], 'ห้ามล้างตะกร้าของเจ้าของคนใหม่');
  assert.strictEqual(env.dialogs.length, 1, 'ต้องไม่โชว์ผลคำสั่งซื้อของเจ้าของเดิม');
  assert.strictEqual(env.went, '');
  assert.strictEqual(host(api.store.get(api.K.pendingOrder, null)), null, 'ส่งสำเร็จแล้ว: request_id เดิมต้องไม่ตกทอดไปถึงเจ้าของคนใหม่');
});

test('ผลกลับมาช้าแต่เจ้าของคนเดิม (ที่อยู่ถูกแก้ระหว่างรอผล): ยังต้องเก็บประวัติ', async () => {
  const env = createEnv(), api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  const d = deferred(), started = deferred();
  env.callImpl = () => { started.resolve(); return d.promise; };

  const p = api.checkout();
  await started.promise;
  api.addrCommit({ addresses: [Object.assign({}, ADDR_A, { label: 'บ้านใหม่' })], max: 2 });
  d.resolve(RESULT);
  await p;

  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 1, 'คำสั่งซื้อส่งสำเร็จแล้ว ต้องไม่ทำประวัติหาย');
});

// ===== negative controls: ถอดการ์ดออกแล้วเทสต์ข้างบนต้องแดง =====
test('negative control: ถอดการ์ดใน preConfirm แล้ว placeOrder จะถูกเรียกทั้งที่สลับบัญชีไปแล้ว', async () => {
  const env = createEnv({ patch: strip(/\n {8}if \(!canSubmit\(\)\) \{[\s\S]*?\n {8}\}/, 'preConfirm owner guard') });
  const api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  env.callImpl = () => Promise.resolve(RESULT);
  env.beforeSubmit = () => switchOwner(api);

  await api.checkout();

  assert.strictEqual(placeOrders(env).length, 1, 'ถ้าไม่มีการ์ดก็ต้องส่ง — ไม่งั้นเทสต์ด้านบนผ่านเพราะเหตุอื่น');
});

test('negative control: ถอดการ์ดหลังได้ผลลัพธ์ แล้วประวัติของเจ้าของคนใหม่จะถูกเขียน', async () => {
  const env = createEnv({ patch: strip(/\n {4}if \(!sameOwner\(\)\) \{[^\n]*\}/, 'late-response owner guard') });
  const api = env.api;
  signIn(api, 'a@example.com');
  seedShip(api, ADDR_A);
  const d = deferred(), started = deferred();
  env.callImpl = () => { started.resolve(); return d.promise; };

  const p = api.checkout();
  await started.promise;
  switchOwner(api);
  d.resolve(RESULT);
  await p;

  assert.strictEqual(host(api.store.get(api.K.history, [])).length, 1, 'ถ้าไม่มีการ์ดก็ต้องเขียนประวัติ — ไม่งั้นเทสต์ด้านบนผ่านเพราะเหตุอื่น');
});
