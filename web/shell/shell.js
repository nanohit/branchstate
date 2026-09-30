// Оболочка: стабильна и крошечна. Выбирает комплект версий и загружает его UI-бандл.
(async () => {
  performance.mark('bs:shell');
  const q = new URLSearchParams(location.search);
  const sw = navigator.serviceWorker;
  // Регистрация Service Worker сама по себе офлайн не даёт: офлайн — только для готового комплекта.
  sw?.register('/sw.js');
  const run = q.has('new') ? null : (q.get('run') ?? localStorage.getItem('bs.run'));
  // Продолжение партии — её `runtime_manifest_id` из общего `runs_index`; ядро для этого не запускается.
  const id =
    run &&
    (await new Promise((done) => {
      const r = indexedDB.open('branchstate', 1);
      r.onupgradeneeded = () => ['runs_index', 'settings'].forEach((s) => r.result.createObjectStore(s));
      r.onerror = () => done(null);
      r.onsuccess = () => {
        const g = r.result.transaction('runs_index').objectStore('runs_index').get(run);
        g.onerror = () => done(null);
        g.onsuccess = () => (r.result.close(), done(g.result?.status === 'ready' ? g.result.runtime_manifest_id : null));
      };
    }));
  try {
    const json = async (url) => (await fetch(url)).json();
    // Новая партия — комплект из `latest.json` (из кэша, если он есть). Файлы комплекта неизменяемы.
    const manifest = await json('__RUNTIME__'.replaceAll('{id}', id || (await json('__LATEST__')).id));
    window.__BS = { manifest, run: id ? run : null, proxy: q.get('proxy') ?? localStorage.getItem('bs.proxy') ?? '__PROXY__' };
    const s = document.createElement('script');
    s.type = 'module';
    s.src = manifest.ui.url;
    s.integrity = manifest.ui.sri;
    s.crossOrigin = 'anonymous';
    document.head.append(s);
    // Фоновое кэширование комплекта целиком не блокирует игру.
    sw?.ready.then((reg) => reg.active?.postMessage({ precache: manifest }));
  } catch {
    document.body.textContent = 'Нет сети, а комплект версий этой партии не сохранён для игры офлайн.';
  }
})();
