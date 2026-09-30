// Service Worker: оболочка — из кэша сразу; файлы комплектов — cache-first (URL неизменяем);
// запросы к посреднику не кэшируются. Комплект готов к офлайну, только когда все его файлы
// загружены и прошли проверку SRI: тогда ставится отметка `ready/<manifest_id>`.
const CDN = new URL('__CDN__', self.location.href).href;
const SHELL = 'shell';
const FILES = 'bundles';

self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/worker.js'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/** Из кэша сразу; проверка идёт фоном и не задерживает запуск. */
async function stale(cacheName, req, key, e) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key, { ignoreSearch: true });
  const fresh = fetch(req).then((res) => (res.ok && cache.put(key, res.clone()), res));
  if (!hit) return fresh;
  e.waitUntil(fresh.catch(() => {}));
  // Ответ без собственного URL: иначе Worker получит адрес из кэша и потеряет параметр `core`.
  return new Response(hit.body, { headers: hit.headers });
}

async function immutable(req) {
  const cache = await caches.open(FILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (e.request.url.startsWith(CDN)) e.respondWith(url.pathname.endsWith('latest.json') ? stale(FILES, e.request, e.request.url, e) : immutable(e.request));
  else if (url.origin === self.location.origin && ['/', '/index.html', '/worker.js'].includes(url.pathname)) e.respondWith(stale(SHELL, e.request, url.pathname === '/worker.js' ? '/worker.js' : '/', e));
});

const filesOf = (m) => [m.ui, m.core, m.wasm, ...m.fonts, ...Object.values(m.scenarios).flatMap((s) => [s.pack, s.geo_bin, s.geo_json])];

/** Id комплектов, на которые ссылаются партии из `runs_index`. */
const referenced = () =>
  new Promise((done) => {
    const r = indexedDB.open('branchstate', 1);
    r.onupgradeneeded = () => ['runs_index', 'settings'].forEach((s) => r.result.createObjectStore(s));
    r.onerror = () => done(null);
    r.onsuccess = () => {
      const g = r.result.transaction('runs_index').objectStore('runs_index').getAll();
      g.onerror = () => done(null);
      g.onsuccess = () => (r.result.close(), done(new Set(g.result.map((x) => x.runtime_manifest_id))));
    };
  });

async function precache(m) {
  const cache = await caches.open(FILES);
  const mark = (id) => `${CDN}ready/${id}`;
  if (!(await cache.match(mark(m.id)))) {
    await Promise.all(
      filesOf(m).map(async (f) => {
        if (await cache.match(f.url)) return;
        const res = await fetch(f.url, { integrity: f.sri });
        if (!res.ok) throw new Error(f.url);
        await cache.put(f.url, res);
      }),
    );
    await cache.put(mark(m.id), new Response('1'));
  }
  // Кэш комплекта удаляется, только если на него не ссылается ни одна партия.
  const used = await referenced();
  if (!used) return;
  used.add(m.id);
  const keep = new Set();
  const drop = [];
  for (const req of await cache.keys()) {
    const id = /runtime\/([0-9a-f]+)\.json$/.exec(req.url)?.[1];
    if (!id) continue;
    const files = filesOf(await (await cache.match(req)).json()).map((f) => new URL(f.url, CDN).href);
    if (used.has(id)) files.forEach((u) => keep.add(u));
    else drop.push(req.url, mark(id), ...files);
  }
  await Promise.all(drop.filter((u) => !keep.has(u)).map((u) => cache.delete(u)));
}

self.addEventListener('message', (e) => e.data?.precache && e.waitUntil(precache(e.data.precache).catch(() => {})));
