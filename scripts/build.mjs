// Сборка комплекта версий: node scripts/build.mjs [--serve] [--skip-geo]
//   dist/            — оболочка (index.html, worker.js, sw.js): то, что лежит на своём домене
//   dist/cdn/        — неизменяемые файлы комплектов, runtime/<manifest_id>.json, latest.json

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as esbuild from 'esbuild';
import { serve } from './serve.mjs';
import { buildShell, cdnLayout } from './shell.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const cdn = path.join(dist, 'cdn');
const build = path.join(root, 'build');
const args = new Set(process.argv.slice(2));
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], ...opts });
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const scenarios = fs.readdirSync(path.join(root, 'scenarios'));

// 1. Типы протокола из Rust: расхождение ломает сборку (проверка типов ниже), а не игру.
fs.writeFileSync(path.join(root, 'web/src/protocol.gen.ts'), execFileSync('cargo', ['run', '-q', '-p', 'branchstate-core', '--features', 'ts', '--bin', 'gen-ts'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }));

// 2. Ядро: Rust → WASM, обвязка wasm-bindgen, wasm-opt -Oz.
run('cargo', ['build', '-q', '--profile', 'wasm', '--target', 'wasm32-unknown-unknown', '-p', 'branchstate-wasm']);
run('wasm-bindgen', ['--target', 'web', '--out-dir', 'build/wasm', 'target/wasm32-unknown-unknown/wasm/branchstate_wasm.wasm']);
run(path.join(root, 'node_modules/.bin/wasm-opt'), ['-Oz', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '-o', 'build/wasm/core.wasm', 'build/wasm/branchstate_wasm_bg.wasm']);

// 3. Геометрия: из закреплённых входов, с проверкой хэша результата.
if (!args.has('--skip-geo')) for (const s of scenarios) run('node', ['geo/build.mjs', s]);

run(path.join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'web']);

fs.rmSync(dist, { recursive: true, force: true, maxRetries: 3 });
fs.mkdirSync(path.join(cdn, 'runtime'), { recursive: true });

/** Кладёт файл комплекта под именем с хэшем содержимого; URL неизменяем. Адрес дописывается, когда известен id. */
function publish(name, buf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const ext = path.extname(name);
  const file = `${path.basename(name, ext)}.${hash}${ext}`;
  fs.writeFileSync(path.join(cdn, file), buf);
  return { url: file, sri: `sha384-${crypto.createHash('sha384').update(buf).digest('base64')}` };
}

const bundle = async (entry, extra = {}) => {
  const res = await esbuild.build({ entryPoints: [path.join(root, entry)], bundle: true, format: 'esm', minify: true, target: ['es2022', 'safari17'], write: false, legalComments: 'none', ...extra });
  return Buffer.from(res.outputFiles[0].contents);
};

const ui = await bundle('web/src/main.ts', { loader: { '.glsl': 'text', '.css': 'text' } });
const core = await bundle('web/src/worker/main.ts');
const wasm = fs.readFileSync(path.join(build, 'wasm/core.wasm'));

const engine = /ENGINE_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(root, 'web/src/protocol.gen.ts'), 'utf8'))[1];
const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(fs.readFileSync(path.join(root, 'web/src/protocol.gen.ts'), 'utf8'))[1]);
const manifest = { protocol, engine_version: engine, ui: publish('ui.js', ui), core: publish('core.js', core), wasm: publish('core.wasm', wasm), fonts: [], scenarios: {} };
let geoBytes = 0;
for (const s of scenarios) {
  const dir = path.join(root, 'scenarios', s);
  // Пакет сценария: граф карты и данные, слитые в один объект.
  const pack = { ...JSON.parse(fs.readFileSync(path.join(dir, 'map.json'))), ...JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'))) };
  const geo = (f) => fs.readFileSync(path.join(dist, '..', 'build/geo', s, f));
  geoBytes = Math.max(geoBytes, gz(geo('geo.bin')) + gz(geo('geo.json')));
  manifest.scenarios[s] = { title: pack.title, pack_version: pack.version, pack: publish(`${s}.pack.json`, Buffer.from(JSON.stringify(pack))), geo_bin: publish(`${s}.geo.bin`, geo('geo.bin')), geo_json: publish(`${s}.geo.json`, geo('geo.json')) };
}
// `runtime_manifest_id` — хэш содержимого манифеста: версий и хэшей всех файлов. От места публикации
// он не зависит, поэтому им же назван тег выпуска, под которым файлы лежат на CDN.
const id = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
const layout = cdnLayout();
const absolute = (node) => {
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') v.sri ? (v.url = layout.base(id) + v.url) : absolute(v);
  }
};
absolute(manifest);
fs.writeFileSync(path.join(cdn, 'runtime', `${id}.json`), JSON.stringify({ id, ...manifest }));
fs.writeFileSync(path.join(cdn, 'latest.json'), JSON.stringify({ id }));

// Оболочка: стабильна и крошечна. Шим Worker и Service Worker не зависят от версии комплекта.
await buildShell(dist, { layout });

// Бюджеты размера.
const kb = (n) => `${(n / 1024).toFixed(1)} КБ`;
const shell = ['index.html', 'worker.js', 'sw.js'].reduce((s, f) => s + gz(fs.readFileSync(path.join(dist, f))), 0);
const budgets = [
  ['оболочка: HTML, шим Worker, Service Worker', shell, 5],
  ['UI-бандл', gz(ui), 40],
  ['WASM-ядро с JS-обвязкой', gz(wasm) + gz(core), 1024],
  ['геометрия сценария', geoBytes, 300],
];
let over = false;
for (const [name, size, limit] of budgets) {
  console.log(`${size > limit * 1024 ? '✗' : '✓'} ${name}: ${kb(size)} gzip (бюджет ${limit} КБ)`);
  over ||= size > limit * 1024;
}
console.log(`комплект ${id}`);
if (over) process.exit(1);

if (args.has('--serve')) {
  const port = Number(process.env.PORT ?? 5173);
  await serve(dist, port);
  console.log(`http://localhost:${port}`);
}
