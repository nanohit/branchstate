// Оболочка для своего домена: index.html, шим Worker, Service Worker. Стабильна и не зависит от
// версии комплекта, поэтому собирается отдельно от ядра — без Rust, одним esbuild.
//   node scripts/shell.mjs            → build/site (это же запускает Vercel)
//
// Где лежат комплекты, задаёт CDN_REPO — адрес репозитория на jsDelivr:
//   latest.json          — в ветке `cdn` (изменяемый указатель на актуальный комплект);
//   файлы комплекта      — под тегом `r-<manifest_id>` (неизменяемы).
// Без CDN_REPO всё берётся из локального /cdn/.

import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');

/** Адреса комплектов: локальные или на jsDelivr. */
export function cdnLayout(repo = process.env.CDN_REPO) {
  if (!repo) return { prefix: '/cdn/', latest: '/cdn/latest.json', runtime: '/cdn/runtime/{id}.json', base: () => '/cdn/' };
  return { prefix: `${repo}@`, latest: `${repo}@cdn/latest.json`, runtime: `${repo}@r-{id}/runtime/{id}.json`, base: (id) => `${repo}@r-${id}/` };
}

export async function buildShell(outDir, { layout = cdnLayout(), proxy = process.env.PROXY_URL ?? '' } = {}) {
  const min = async (file) => (await esbuild.transform(fs.readFileSync(path.join(root, 'web/shell', file), 'utf8'), { minify: true, target: 'es2022' })).code;
  const fill = (code) => code.replaceAll('__LATEST__', layout.latest).replaceAll('__RUNTIME__', layout.runtime).replaceAll('__CDN__', layout.prefix).replaceAll('__PROXY__', proxy);
  const shellJs = fill(await min('shell.js'));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), fs.readFileSync(path.join(root, 'web/shell/index.html'), 'utf8').replace('/*shell.js*/', () => shellJs).replace(/\n\s*/g, '\n'));
  fs.writeFileSync(path.join(outDir, 'worker.js'), await min('worker.js'));
  fs.writeFileSync(path.join(outDir, 'sw.js'), fill(await min('sw.js')));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(root, 'build/site');
  await buildShell(out);
  console.log(`оболочка: ${out} → комплекты ${cdnLayout().latest}`);
}
