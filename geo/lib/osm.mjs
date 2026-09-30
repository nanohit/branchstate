// Разбор выгрузки Overpass (out geom): отношения → мультиполигоны GeoJSON; даты OHM → интервалы.

/** Собирает кольца из линий-участников отношения, стыкуя их концами. */
function assembleRings(ways) {
  const key = (p) => `${p[0]},${p[1]}`;
  const open = ways.filter((w) => w.length > 1).map((w) => w.slice());
  const rings = [];
  while (open.length) {
    let line = open.pop();
    for (let grown = true; grown && key(line[0]) !== key(line[line.length - 1]); ) {
      grown = false;
      const tail = key(line[line.length - 1]);
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        if (key(w[0]) === tail) line = line.concat(w.slice(1));
        else if (key(w[w.length - 1]) === tail) line = line.concat(w.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (line.length >= 4 && key(line[0]) === key(line[line.length - 1])) rings.push(line);
  }
  return rings;
}

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Координаты MultiPolygon отношения: внешние кольца с их дырами. */
export function relationPolygons(rel) {
  const lines = (role) =>
    rel.members.filter((m) => m.type === 'way' && m.geometry && (m.role === role || (role === 'outer' && m.role === ''))).map((m) => m.geometry.map((p) => [p.lon, p.lat]));
  const outers = assembleRings(lines('outer')).map((r) => [r]);
  for (const hole of assembleRings(lines('inner'))) {
    const host = outers.find((poly) => inRing(hole[0], poly[0]));
    if (host) host.push(hole);
  }
  return outers;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Дата OHM/EDTF → интервал [самое раннее, самое позднее] в ISO. Год — весь год, год и месяц — весь
 * месяц, пометки неточности (~ ? %) расширяют интервал на единицу точности, отсутствие — открытый край.
 */
export function dateInterval(raw) {
  if (raw == null || raw === '' || raw === '..') return null;
  const set = /^[[{](.+?)\.\.(.+?)[\]}]$/.exec(String(raw).trim());
  const range = set ? [set[1], set[2]] : String(raw).split('/');
  if (range.length === 2) {
    const [a, b] = [dateInterval(range[0]), dateInterval(range[1])];
    return { lo: a ? a.lo : '0000-01-01', hi: b ? b.hi : '9999-12-31' };
  }
  const m = /^(-?\d{4})(?:-(\d{2}))?(?:-(\d{2}))?([~?%]?)$/.exec(String(raw).trim().replace(/T[\d:+.Z-]*$/, ''));
  if (!m) return undefined; // не разобрано — на ручную проверку
  let [y, mo, d] = [Number(m[1]), m[2] && Number(m[2]), m[3] && Number(m[3])];
  const fuzzy = m[4] !== '';
  let lo, hi;
  if (d) {
    const t = Date.UTC(y, mo - 1, d);
    const shift = (days) => new Date(t + days * 864e5).toISOString().slice(0, 10);
    [lo, hi] = fuzzy ? [shift(-1), shift(1)] : [shift(0), shift(0)];
  } else if (mo) {
    const [m0, m1] = fuzzy ? [mo - 1, mo + 1] : [mo, mo];
    const from = new Date(Date.UTC(y, m0 - 1, 1));
    const to = new Date(Date.UTC(y, m1, 0));
    [lo, hi] = [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
  } else {
    const [y0, y1] = fuzzy ? [y - 1, y + 1] : [y, y];
    [lo, hi] = [`${pad(y0, 4)}-01-01`, `${pad(y1, 4)}-12-${lastDay(y1, 12)}`];
  }
  return { lo, hi };
}

/** Действует ли объект на дату: 'in' — точно да, 'out' — точно нет, 'ambiguous' — решает правка. */
export function validOn(tags, date) {
  const start = dateInterval(tags['start_date:edtf'] ?? tags.start_date);
  const end = dateInterval(tags['end_date:edtf'] ?? tags.end_date);
  if (start === undefined || end === undefined) return 'ambiguous';
  if ((start && start.lo > date) || (end && end.hi <= date)) return 'out';
  if ((start && start.hi > date) || (end && end.lo <= date)) return 'ambiguous';
  return 'in';
}
