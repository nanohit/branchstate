// Точка входа ядра комплекта в Worker: WASM, хранилище, сеть. Шим передаёт сюда сообщения интерфейса.

import init, { Core } from '../../../build/wasm/branchstate_wasm.js';
import type { RuntimeManifest, ToWorker } from '../protocol.gen.ts';
import { type CoreFactory, Host } from './host.ts';

const packs = new Map<string, Promise<string>>();

const host = new Host({
  idb: indexedDB,
  locks: navigator.locks,
  fetch: (input, init) => fetch(input, init),
  post: (msg) => postMessage(msg),
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  uuid: () => crypto.randomUUID(),
  randomSeed: () => crypto.getRandomValues(new Uint32Array(1))[0],
  today: () => new Date().toISOString().slice(0, 10),
  // `instantiateStreaming`; при ошибке MIME обвязка сама переходит на `arrayBuffer` и `instantiate`.
  loadCore: async (m: RuntimeManifest) => {
    await init({ module_or_path: fetch(m.wasm.url, { integrity: m.wasm.sri }) });
    return Core as unknown as CoreFactory;
  },
  loadPack: (m, scenario) => {
    const f = m.scenarios[scenario].pack;
    if (!packs.has(f.url)) packs.set(f.url, fetch(f.url, { integrity: f.sri }).then((r) => r.text()));
    return packs.get(f.url)!;
  },
  storageEstimate: () => navigator.storage.estimate(),
});

self.onmessage = (e: MessageEvent<ToWorker>) => void host.handle(e.data);
self.addEventListener('unhandledrejection', (e) => postMessage({ t: 'Error', epoch: '', code: String(e.reason), recoverable: true }));
