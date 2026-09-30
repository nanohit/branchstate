// Геопайплайн: офлайн-сборка геометрии сценария из закреплённых входов.
//   node geo/build.mjs <сценарий> [--update-lock]
// Один пакет всегда даёт одну геометрию: входы, версии и параметры записаны в geo/build.lock,
// хэш результата сравнивается с записанным.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import mapshaper from 'mapshaper';
import { relationPolygons, validOn } from './lib/osm.mjs';

const root = path.resolve(import.meta.dirname, '..');
const scenario = process.argv[2];
const updateLock = process.argv.includes('--update-lock');
if (!scenario) throw new Error('node geo/build.mjs <сценарий> [--update-lock]');
const dir = path.join(root, 'geo', scenario);
const outDir = path.join(root, 'build', 'geo', scenario);
const read = (f) => fs.readFileSync(path.join(dir, f));
const json = (f) => JSON.parse(read(f));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gunzip = (f) => (f.endsWith('.gz') ? zlib.gunzipSync(read(f)) : read(f));
const fail = (msg) => {
  console.error(`geo/${scenario}: ${msg}`);
  process.exit(1);
};

const cfg = json('config.json');
const map = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', scenario, 'map.json')));
const mapshaperVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/mapshaper/package.json'))).version;

// 1. Закреплённые входы: хэши входов, правок, параметров и версий.
const pinned = { mapshaper: mapshaperVersion, config: sha(read('config.json')), files: {} };
const walk = (rel) =>
  fs.existsSync(path.join(dir, rel))
    ? fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]))
    : [];
for (const f of [...walk('input'), ...walk('patches'), ...(cfg.query ? [cfg.query] : [])].sort()) pinned.files[f] = sha(read(f));
const lockPath = path.join(root, 'geo', 'build.lock');
const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath)) : {};
if (!updateLock && lock[scenario] && JSON.stringify(lock[scenario].pinned) !== JSON.stringify(pinned)) {
  fail('входы или параметры изменились относительно geo/build.lock; проверьте и запустите с --update-lock');
}

const ms = (commands, files) =>
  mapshaper.applyCommands(commands, files).catch((e) => {
    throw new Error(`mapshaper: ${e.message}\n  ${commands.slice(0, 200)}`);
  });
const frame = cfg.frame_km.join(',');

// 2–4. Исходные регионы: выгрузка OHM с нормализацией дат, лицензиями и правками — либо рисованные контуры.
async function sourceLayers() {
  if (!cfg.ohm) {
    // Вымышленный сценарий: контуры из правок, сглаженные срезанием углов.
    const chaikin = (ring) => ring.flatMap((p, i) => {
      const q = ring[(i + 1) % ring.length];
      return [[0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]];
    });
    const features = Object.entries(json('patches/regions.json')).map(([region, ring]) => {
      let r = ring;
      for (let i = 0; i < cfg.smooth; i++) r = chaikin(r);
      // Координаты сценария — экранные, y вниз; пайплайн работает с y вверх и переворачивает в конце.
      r = r.map(([x, y]) => [x, -y]);
      return { type: 'Feature', properties: { region }, geometry: { type: 'Polygon', coordinates: [[...r, r[0]]] } };
    });
    const out = await ms(`-i regions.json -clip bbox=${frame} -o regions.json format=geojson`, { 'regions.json': JSON.stringify({ type: 'FeatureCollection', features }) });
    return { regions: out['regions.json'], land: null };
  }

  const ohm = JSON.parse(gunzip(cfg.ohm));
  const spec = json('patches/regions.json');
  const dates = json('patches/dates.json');
  const byId = new Map(ohm.elements.map((e) => [e.id, e]));
  const name = (rel) => rel.tags['name:en'] || rel.tags.name || String(rel.id);

  const review = [];
  const usable = new Set();
  for (const rel of ohm.elements) {
    const license = rel.tags.license;
    if (license && !/^CC0/i.test(license) && !spec.licenses_checked?.includes(rel.id)) {
      review.push(`${rel.id}\tлицензия ${license}\t${name(rel)}\tотброшен`);
      continue;
    }
    const verdict = validOn(rel.tags, cfg.date);
    const decision = dates[rel.id];
    if (verdict === 'ambiguous') {
      const range = `${rel.tags['start_date:edtf'] ?? rel.tags.start_date ?? '..'} / ${rel.tags['end_date:edtf'] ?? rel.tags.end_date ?? '..'}`;
      review.push(`${rel.id}\tдата ${range}\t${name(rel)}\t${decision ? `решено: ${decision.verdict} — ${decision.why}` : 'НЕ РЕШЕНО'}`);
    }
    if (verdict === 'in' || (verdict === 'ambiguous' && decision?.verdict === 'include')) usable.add(rel.id);
  }
  fs.writeFileSync(path.join(dir, 'review.txt'), `# Неоднозначные объекты на ${cfg.date}. Решения — в patches/dates.json. Нерешённые останавливают сборку.\n${review.join('\n')}\n`);
  if (review.some((l) => l.endsWith('НЕ РЕШЕНО'))) fail('есть нерешённые записи в review.txt');

  const features = [];
  const assigned = new Set();
  for (const [region, ids] of Object.entries(spec.regions)) {
    const coordinates = [];
    for (const id of ids) {
      if (!byId.has(id)) fail(`regions.json: отношения ${id} нет в выгрузке`);
      if (!usable.has(id)) fail(`regions.json: отношение ${id} (${name(byId.get(id))}) не действует на ${cfg.date}`);
      assigned.add(id);
      coordinates.push(...relationPolygons(byId.get(id)));
    }
    features.push({ type: 'Feature', properties: { region }, geometry: { type: 'MultiPolygon', coordinates } });
  }
  for (const id of usable) if (!assigned.has(id) && !spec.unassigned.includes(id)) fail(`отношение ${id} (${name(byId.get(id))}) не отнесено ни к региону, ни к неигровой суше`);

  const clip = cfg.clip_lonlat.join(',');
  const out = await ms(
    `-i regions.json land.json combine-files -clip target=* bbox=${clip} -proj target=* ${JSON.stringify(cfg.proj)} -clip target=* bbox=${frame}` +
      // Части с общей территорией (коронные земли внутри империи): перекрытие достаётся меньшему.
      ' -clean target=regions overlap-rule=min-area -dissolve region target=regions -dissolve target=land -each "land=1" target=land' +
      ' -o regions.json format=geojson target=regions -o land.json format=geojson target=land',
    { 'regions.json': JSON.stringify({ type: 'FeatureCollection', features }), 'land.json': gunzip(cfg.land).toString() },
  );
  return { regions: out['regions.json'], land: out['land.json'] };
}

/** Длина дуги TopoJSON без квантования. */
const arcLength = (arc) => arc.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - arc[i][0], p[1] - arc[i][1]), 0);
const ringsOf = (g) => (g.type === 'Polygon' ? g.arcs : g.type === 'MultiPolygon' ? g.arcs.flat() : []);

// Берега — из суши Natural Earth: регион = его территория на суше. Остатки суши вне регионов:
// мелкие уходят соседнему региону с самой длинной общей границей, крупные — неигровая суша `_land`.
async function partition({ regions, land }) {
  if (!land) return regions;
  const out = await ms('-i regions.json land.json combine-files -union target=regions,land name=mosaic -o mosaic.json format=topojson no-quantization target=mosaic', {
    'regions.json': regions,
    'land.json': land,
  });
  const topo = JSON.parse(out['mosaic.json']);
  const pieces = topo.objects.mosaic.geometries;
  const lengths = topo.arcs.map(arcLength);
  const area = (g) => {
    let a = 0;
    for (const ring of ringsOf(g)) {
      const pts = ring.flatMap((i) => (i < 0 ? topo.arcs[~i].slice().reverse() : topo.arcs[i]));
      for (let i = 0; i + 1 < pts.length; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    }
    return Math.abs(a) / 2;
  };
  const users = new Map(); // дуга → куски по обе стороны
  pieces.forEach((g, gi) => {
    for (const i of ringsOf(g).flat()) {
      const a = i < 0 ? ~i : i;
      users.set(a, [...(users.get(a) ?? []), gi]);
    }
  });
  let moved = 0;
  // Остатки разбираются от мелких к крупным, чтобы цепочки осколков сходились к настоящему региону.
  const leftovers = pieces.map((g, gi) => ({ g, gi, area: area(g) })).filter(({ g }) => g.properties.land && !g.properties.region);
  leftovers.sort((a, b) => a.area - b.area || a.gi - b.gi);
  for (let pass = 0; pass < 3; pass++) {
    for (const { g, gi, area: a } of leftovers) {
      if (g.properties.region || a > cfg.sliver_km2) continue;
      const shared = {};
      for (const i of ringsOf(g).flat()) {
        const arc = i < 0 ? ~i : i;
        for (const other of users.get(arc)) {
          const r = pieces[other].properties.region;
          if (other !== gi && r && pieces[other].properties.land) shared[r] = (shared[r] ?? 0) + lengths[arc];
        }
      }
      const best = Object.entries(shared).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
      if (best) {
        g.properties.region = best[0];
        moved++;
      }
    }
  }
  const keep = [];
  let islets = 0;
  for (const { g, area: a } of pieces.map((g) => ({ g, area: area(g) }))) {
    if (!g.properties.land) continue; // территория региона в море Natural Earth — не суша
    if (a < cfg.min_land_km2) {
      // Островки мельче порога не рисуются: на максимальном масштабе это несколько пикселей.
      islets++;
      continue;
    }
    g.properties.region ??= '_land';
    keep.push(g);
  }
  console.log(`  островков мельче ${cfg.min_land_km2} км² отброшено: ${islets}`);
  topo.objects.mosaic.geometries = keep;
  console.log(`  остатков суши передано регионам: ${moved}`);
  const flat = await ms('-i mosaic.json -dissolve region -o regions.json format=topojson no-quantization', { 'mosaic.json': JSON.stringify(topo) });
  return flat['regions.json'];
}

// 5. Топология: общие дуги mapshaper. Упрощает их `geo-build` — с допуском в пикселях и отдельным
// допуском для защищённых объектов; соседние регионы на любом уровне делят одну границу.
async function topology(regions) {
  const res = await ms('-i regions.json -o out.json format=topojson no-quantization precision=0.001', { 'regions.json': regions });
  const topo = JSON.parse(res['out.json']);
  const byRegion = new Map();
  for (const g of Object.values(topo.objects)[0].geometries) {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    byRegion.set(g.properties.region, [...(byRegion.get(g.properties.region) ?? []), ...polys]);
  }
  return { arcs: topo.arcs.map((arc) => arc.map(([x, y]) => [x, -y])), regions: [...byRegion].map(([id, rings]) => ({ id, rings })) };
}

// 7. Узлы и рёбра графа в проекции сценария; координаты — километры, y вниз.
async function graph() {
  const project = async (points) => {
    if (!cfg.proj || !points.length) return points;
    const fc = { type: 'FeatureCollection', features: points.map((p, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: p } })) };
    const out = await ms(`-i pts.json -proj ${JSON.stringify(cfg.proj)} -o pts.json format=geojson precision=0.001`, { 'pts.json': JSON.stringify(fc) });
    return JSON.parse(out['pts.json']).features.map((f) => [f.geometry.coordinates[0], -f.geometry.coordinates[1]]);
  };
  const raw = map.nodes.map((n) => (cfg.proj ? [n.lon, n.lat] : [n.x, n.y]));
  const xy = await project(raw);
  const nodes = map.nodes.map((n, i) => ({ id: n.id, x: xy[i][0], y: xy[i][1] }));
  const at = Object.fromEntries(nodes.map((n) => [n.id, [n.x, n.y]]));
  const via = fs.existsSync(path.join(dir, 'patches/edges.json')) ? json('patches/edges.json') : {};
  const edges = [];
  for (const e of map.edges) {
    const id = `${e.a}~${e.b}`;
    const mid = await project(via[id] ?? []);
    edges.push({ id, points: smooth([at[e.a], ...mid, at[e.b]]) });
  }
  return { nodes, edges, protect: await project(cfg.protect ?? []) };
}

/** Ломаная маршрута: сплайн Катмулла — Рома через опорные точки. */
function smooth(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  const p = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    for (let s = 1; s <= 8; s++) {
      const t = s / 8;
      const c = (k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t);
      out.push([Math.round(c(0) * 1000) / 1000, Math.round(c(1) * 1000) / 1000]);
    }
  }
  return out;
}

console.log(`geo/${scenario}: сборка`);
const topo = await topology(await partition(await sourceLayers()));
const { nodes, edges, protect } = await graph();
const [x0, y0, x1, y1] = cfg.frame_km;
const intermediate = { scenario, bounds: [x0, -y1, x1, -y0], projection: cfg.proj ?? null, lod_scales: cfg.lod_scales, protect_km: cfg.protect_km, protect, ...topo, nodes, edges };
fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, 'intermediate.json');
fs.writeFileSync(tmp, JSON.stringify(intermediate));

// 8–9. Сборка буферов и проверка — Rust CLI `geo-build` с тем же загрузчиком сценария, что и в ядре.
execFileSync('cargo', ['run', '-q', '--release', '-p', 'geo-build', '--', tmp, path.join(root, 'scenarios', scenario), outDir], { stdio: 'inherit', cwd: root });
fs.rmSync(tmp);

const result = { 'geo.bin': sha(fs.readFileSync(path.join(outDir, 'geo.bin'))), 'geo.json': sha(fs.readFileSync(path.join(outDir, 'geo.json'))) };
if (updateLock || !lock[scenario]) {
  lock[scenario] = { pinned, result };
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log('  geo/build.lock обновлён');
} else if (JSON.stringify(lock[scenario].result) !== JSON.stringify(result)) {
  fail('хэш результата не совпал с geo/build.lock: сборка невоспроизводима или изменился geo-build');
}
const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(outDir, f)), { level: 9 }).length;
const total = gz('geo.bin') + gz('geo.json');
console.log(`  геометрия ${(total / 1024).toFixed(1)} КБ gzip (бюджет 300)`);
if (total > 300 * 1024) fail('геометрия сценария больше бюджета 300 КБ gzip');
