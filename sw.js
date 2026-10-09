/* Service worker: ทำให้แอปเปิดเร็วและเปิดได้แม้ออฟไลน์ (ส่งคำสั่งซื้อยังต้องออนไลน์) */
const VERSION = '1.1.9';
const SHELL = 'b1001-shell-' + VERSION;
const RUNTIME = 'b1001-runtime';
const IMAGES = 'b1001-images';
const SHELL_FILES = [
  './', './index.html', './config.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png', './favicon-32.png',
];
const MAX_IMAGES = 150;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('b1001-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // คำสั่งซื้อ (POST) ส่งตรงเสมอ
  const url = new URL(req.url);

  // หน้าแอป: เอาของใหม่ก่อน ถ้าออฟไลน์ใช้ที่เก็บไว้
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-store' }).then(res => { put(SHELL, './index.html', res.clone()); return res; })
      .catch(() => caches.match('./index.html', { ignoreSearch: true })));
    return;
  }

  // รายการสินค้าจาก Apps Script: เอาของใหม่ก่อน ถ้าออฟไลน์ใช้รายการล่าสุด
  if (url.searchParams.get('action') === 'products') {
    const key = new Request('./__api_products__');
    e.respondWith(fetch(req).then(res => { if (res.ok) put(RUNTIME, key, res.clone()); return res; })
      .catch(() => caches.match(key)));
    return;
  }
  if (url.searchParams.get('action') === 'status') return;  // สถานะต้องสดเสมอ

  // รูปสินค้าจาก Google Drive: ใช้ของในเครื่องก่อน
  if (/(^|\.)drive\.google\.com$|googleusercontent\.com$/.test(url.hostname) && req.destination === 'image') {
    e.respondWith(caches.open(IMAGES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      c.put(req, res.clone()).then(() => trim(c));
      return res;
    }).catch(() => fetch(req)));
    return;
  }

  // ไฟล์ของแอปและฟอนต์: ใช้ของในเครื่องทันที แล้วอัปเดตเบื้องหลัง
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') put(RUNTIME, req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

function put(cacheName, key, res) {
  return caches.open(cacheName).then(c => c.put(key, res)).catch(() => {});
}
async function trim(c) {
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_IMAGES; i++) await c.delete(keys[i]);
}
