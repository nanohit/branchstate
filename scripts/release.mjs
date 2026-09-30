// Выпуск комплекта версий на jsDelivr: node scripts/release.mjs
//
// jsDelivr раздаёт то, что лежит в репозитории, поэтому собранные файлы комплекта живут в ветке `cdn`:
//   тег `r-<manifest_id>` — неизменяемые файлы комплекта (кэшируются навсегда);
//   ветка `cdn`           — latest.json, указатель на актуальный комплект для новых партий.
// Оболочку на своём домене выпуск не трогает: она не зависит от версии комплекта.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const REPO = process.env.CDN_REPO ?? 'https://cdn.jsdelivr.net/gh/nanohit/branchstate';
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const tryGit = (args, cwd = root) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, CDN_REPO: REPO } });
const cdn = path.join(root, 'dist/cdn');
const { id } = JSON.parse(fs.readFileSync(path.join(cdn, 'latest.json')));
const tag = `r-${id}`;

// Ветка `cdn` собирается в отдельном рабочем каталоге: в ней только файлы актуального комплекта.
const tree = path.join(root, 'build/cdn-branch');
tryGit(['worktree', 'remove', '--force', tree]);
fs.rmSync(tree, { recursive: true, force: true });
tryGit(['fetch', 'origin', 'cdn', '--tags']);
if (tryGit(['rev-parse', '--verify', 'origin/cdn'])) git(['worktree', 'add', '-B', 'cdn', tree, 'origin/cdn']);
else {
  git(['worktree', 'add', '--detach', tree]);
  git(['checkout', '--orphan', 'cdn'], tree);
}
tryGit(['rm', '-rf', '--quiet', '.'], tree);
for (const f of fs.readdirSync(tree)) if (f !== '.git') fs.rmSync(path.join(tree, f), { recursive: true, force: true });
fs.cpSync(cdn, tree, { recursive: true });
git(['add', '-A'], tree);
if (tryGit(['diff', '--cached', '--quiet'], tree) === null) git(['commit', '--quiet', '-m', `Комплект ${id}`], tree);
if (!tryGit(['rev-parse', '--verify', `refs/tags/${tag}`])) git(['tag', tag], tree);
git(['push', '--quiet', 'origin', 'cdn', tag], tree);
git(['worktree', 'remove', '--force', tree]);

// latest.json в ветке кэшируется jsDelivr: после выпуска кэш сбрасывается.
const latest = `${REPO}@cdn/latest.json`;
await fetch(latest.replace('cdn.jsdelivr.net', 'purge.jsdelivr.net')).catch(() => {});

// Проверка: манифест и все его файлы доступны и отдаются с проверяемым хэшем.
const manifest = await (await fetch(`${REPO}@${tag}/runtime/${id}.json`)).json();
const files = [manifest.ui, manifest.core, manifest.wasm, ...manifest.fonts, ...Object.values(manifest.scenarios).flatMap((s) => [s.pack, s.geo_bin, s.geo_json])];
for (const f of files) {
  const res = await fetch(f.url, { integrity: f.sri });
  if (!res.ok) throw new Error(`${f.url}: ${res.status}`);
  await res.arrayBuffer();
}
const seen = await (await fetch(latest, { cache: 'no-store' })).json().catch(() => ({}));
console.log(`комплект ${id} опубликован: ${files.length} файлов под тегом ${tag}`);
console.log(seen.id === id ? `latest.json указывает на ${id}` : `latest.json на jsDelivr ещё отдаёт ${seen.id ?? '—'}: кэш ветки обновится в течение часов`);
