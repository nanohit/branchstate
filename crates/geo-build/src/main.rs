//! Сборка буферов карты: `geo-build <intermediate.json> <каталог сценария> <каталог вывода>`.
//!
//! Вход — топология регионов от mapshaper (общие дуги), узлы и рёбра графа в проекции сценария.
//! Здесь общие дуги упрощаются с допуском в экранных пикселях (у защищённых объектов — вдвое
//! строже), проверяется ошибка упрощения и собираются `geo.bin` и `geo.json`.
//! Проверка покрытия — тем же загрузчиком сценария, что и в ядре.

use branchstate_core::ids::Space;
use branchstate_core::model::Class;
use branchstate_core::pack::Pack;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

type P = [f64; 2];

#[derive(Deserialize)]
struct Shape {
    id: String,
    /// Полигоны → кольца → индексы дуг (отрицательный `~i` — дуга в обратном направлении).
    rings: Vec<Vec<Vec<i32>>>,
}

#[derive(Deserialize)]
struct NodeIn {
    id: String,
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct EdgeIn {
    id: String,
    points: Vec<P>,
}

#[derive(Deserialize)]
struct Input {
    scenario: String,
    bounds: [f64; 4],
    projection: Option<String>,
    /// Наибольший масштаб камеры на каждом уровне детализации, px/км; последний — предел камеры.
    lod_scales: Vec<f64>,
    /// Радиус защищённых окрестностей узлов графа и точек `protect`, км.
    protect_km: f64,
    protect: Vec<P>,
    arcs: Vec<Vec<P>>,
    regions: Vec<Shape>,
    nodes: Vec<NodeIn>,
    edges: Vec<EdgeIn>,
}

const LAND: &str = "_land";
/// Допуск упрощения в экранных пикселях: обычный и для защищённых объектов.
const TOLERANCE_PX: f64 = 1.0;
const PROTECTED_PX: f64 = 0.5;
const MITER_LIMIT: f64 = 2.0;
/// Смещение соединения хранится в i8 с этим масштабом: предел miter 2,0 помещается с запасом.
const OFFSET_SCALE: f64 = 48.0;
const NONE: u8 = 127;

#[derive(Default)]
struct Bin {
    sections: Vec<(String, Vec<u8>)>,
}

impl Bin {
    fn add(&mut self, name: impl Into<String>, data: Vec<u8>) {
        self.sections.push((name.into(), data));
    }

    fn layout(&self) -> Vec<(&str, usize, usize)> {
        let mut offset = 12 + self.sections.len() * 24;
        self.sections
            .iter()
            .map(|(name, data)| {
                offset = offset.next_multiple_of(4);
                let at = offset;
                offset += data.len();
                (name.as_str(), at, data.len())
            })
            .collect()
    }

    /// Заголовок: магическое число, версия, число секций, таблица (имя[16], смещение, длина); массивы выровнены на 4.
    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(b"BSG1");
        out.extend(2u32.to_le_bytes());
        out.extend((self.sections.len() as u32).to_le_bytes());
        for (name, at, len) in self.layout() {
            assert!(name.len() <= 16, "имя секции длиннее 16 байт: {name}");
            let mut n = [0u8; 16];
            n[..name.len()].copy_from_slice(name.as_bytes());
            out.extend(n);
            out.extend((at as u32).to_le_bytes());
            out.extend((len as u32).to_le_bytes());
        }
        for (_, data) in &self.sections {
            out.resize(out.len().next_multiple_of(4), 0);
            out.extend(data);
        }
        out
    }
}

/// Координаты — i16 по рамке карты, разностями от предыдущей вершины: так массив хорошо сжимается,
/// а клиент восстанавливает его суммой на месте, без копий.
struct Quant {
    bounds: [f64; 4],
    prev: [i16; 2],
}

impl Quant {
    fn new(bounds: [f64; 4]) -> Quant {
        Quant { bounds, prev: [0, 0] }
    }
    fn q(&self, p: P) -> [i16; 2] {
        let [x0, y0, x1, y1] = self.bounds;
        let f = |v: f64, lo: f64, hi: f64| (((v - lo) / (hi - lo)).clamp(0.0, 1.0) * 65535.0).round() as i32 - 32768;
        [f(p[0], x0, x1) as i16, f(p[1], y0, y1) as i16]
    }
    fn push(&mut self, out: &mut Vec<u8>, p: P) {
        let q = self.q(p);
        out.extend(q[0].wrapping_sub(self.prev[0]).to_le_bytes());
        out.extend(q[1].wrapping_sub(self.prev[1]).to_le_bytes());
        self.prev = q;
    }
}

/// Индексы разностями; u16, если вершин не больше 65536.
fn indices(idx: &[u32], verts: usize) -> (Vec<u8>, u8) {
    let mut prev = 0u32;
    let deltas = idx.iter().map(|&i| {
        let d = i.wrapping_sub(prev);
        prev = i;
        d
    });
    if verts <= 65536 {
        (deltas.flat_map(|d| (d as u16).to_le_bytes()).collect(), 2)
    } else {
        (deltas.flat_map(|d| d.to_le_bytes()).collect(), 4)
    }
}

fn f32s(v: &mut Vec<u8>, xs: &[f64]) {
    for x in xs {
        v.extend((*x as f32).to_le_bytes());
    }
}

fn ring_points(arcs: &[Vec<P>], ring: &[i32]) -> Vec<P> {
    let mut pts: Vec<P> = Vec::new();
    for &i in ring {
        let arc = &arcs[if i < 0 { !i } else { i } as usize];
        let seg: Vec<P> = if i < 0 { arc.iter().rev().copied().collect() } else { arc.clone() };
        pts.extend(seg.into_iter().skip(usize::from(!pts.is_empty())));
    }
    pts.dedup();
    if pts.len() > 1 && pts.first() == pts.last() {
        pts.pop();
    }
    pts
}

fn area(ring: &[P]) -> f64 {
    let n = ring.len();
    (0..n).map(|i| ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]).sum::<f64>() / 2.0
}

fn inside(pt: P, ring: &[P]) -> bool {
    let mut c = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > pt[1]) != (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
        j = i;
    }
    c
}

fn dist(a: P, b: P) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 { 0.0 } else { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0) };
    dist(p, [a[0] + t * dx, a[1] + t * dy])
}

/// Упрощение общей дуги (Дуглас — Пекер) с допуском, зависящим от вершины. Концы дуги неподвижны,
/// поэтому соседние регионы по-прежнему делят одну границу. Замкнутая дуга сохраняет форму кольца.
fn simplify(arc: &[P], tol: impl Fn(&P) -> f64) -> Vec<P> {
    let mut arc: Vec<P> = arc.to_vec();
    arc.dedup();
    let n = arc.len();
    if n < 3 {
        return arc;
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    if arc[0] == arc[n - 1] {
        // Кольцо: опорные точки — самая дальняя от начала и самые дальние от получившихся хорд.
        let far = (1..n - 1).max_by(|&a, &b| dist(arc[a], arc[0]).total_cmp(&dist(arc[b], arc[0]))).unwrap();
        keep[far] = true;
        for (a, b) in [(0, far), (far, n - 1)] {
            if let Some(m) = (a + 1..b).max_by(|&i, &j| seg_dist(arc[i], arc[a], arc[b]).total_cmp(&seg_dist(arc[j], arc[a], arc[b]))) {
                keep[m] = true;
            }
        }
    }
    let anchors: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    let mut stack: Vec<(usize, usize)> = anchors.windows(2).map(|w| (w[0], w[1])).collect();
    while let Some((a, b)) = stack.pop() {
        // Худшая вершина — с наибольшим отклонением относительно своего допуска.
        let worst = (a + 1..b).map(|i| (seg_dist(arc[i], arc[a], arc[b]) / tol(&arc[i]), i)).max_by(|x, y| x.0.total_cmp(&y.0));
        if let Some((ratio, i)) = worst {
            if ratio > 1.0 {
                keep[i] = true;
                stack.push((a, i));
                stack.push((i, b));
            }
        }
    }
    arc.into_iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| p).collect()
}

/// Точка подписи: внутренняя точка кольца, дальше всего от его границы (по сетке).
fn label_point(ring: &[P]) -> P {
    let (lo, hi) = ring.iter().fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), p| ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])]));
    let mut best = ([(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0], -1.0);
    const N: usize = 24;
    for i in 0..N {
        for j in 0..N {
            let p = [lo[0] + (hi[0] - lo[0]) * (i as f64 + 0.5) / N as f64, lo[1] + (hi[1] - lo[1]) * (j as f64 + 0.5) / N as f64];
            if !inside(p, ring) {
                continue;
            }
            let d = (0..ring.len()).map(|k| seg_dist(p, ring[k], ring[(k + 1) % ring.len()])).fold(f64::MAX, f64::min);
            if d > best.1 {
                best = (p, d);
            }
        }
    }
    best.0
}

fn norm(v: P) -> P {
    let l = (v[0] * v[0] + v[1] * v[1]).sqrt();
    if l == 0.0 { [0.0, 0.0] } else { [v[0] / l, v[1] / l] }
}

#[derive(Default)]
struct Ribbon {
    /// x, y, ox, oy, сторона (−1/+1), длина вдоль линии.
    verts: Vec<[f64; 6]>,
    idx: Vec<u32>,
}

/// Лента постоянной экранной толщины: смещение вершины = вектор соединения × полутолщина ÷ масштаб.
/// Соединения — miter с пределом, острее — bevel с дополнительным треугольником; `cap` — насколько
/// концы выступают за ось (1 — квадратные на полутолщину, 0 — плоские).
fn ribbon(pts: &[P], cap: f64, out: &mut Ribbon) {
    let mut pts: Vec<P> = pts.to_vec();
    pts.dedup();
    let closed = pts.len() > 3 && pts.first() == pts.last();
    if closed {
        pts.pop();
    }
    let n = pts.len();
    if n < 2 {
        return;
    }
    let dir = |a: usize, b: usize| norm([pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]]);
    let mut along = 0.0;
    // Пара вершин (левая, правая) на входе в точку и на выходе из неё; при bevel они различаются.
    let mut pairs: Vec<([u32; 2], [u32; 2])> = Vec::with_capacity(n);
    for i in 0..n {
        if i > 0 {
            along += dist(pts[i], pts[i - 1]);
        }
        let prev = if i > 0 { Some(dir(i - 1, i)) } else if closed { Some(dir(n - 1, 0)) } else { None };
        let next = if i + 1 < n { Some(dir(i, i + 1)) } else if closed { Some(dir(i, 0)) } else { None };
        let base = out.verts.len() as u32;
        let mut push = |o: P, side: f64| out.verts.push([pts[i][0], pts[i][1], o[0], o[1], side, along]);
        match (prev, next) {
            (Some(a), Some(b)) => {
                let (na, nb) = ([-a[1], a[0]], [-b[1], b[0]]);
                let m = norm([na[0] + nb[0], na[1] + nb[1]]);
                let cos = m[0] * na[0] + m[1] * na[1];
                let len = if cos > 1e-6 { 1.0 / cos } else { f64::MAX };
                if len <= MITER_LIMIT {
                    push([m[0] * len, m[1] * len], 1.0);
                    push([-m[0] * len, -m[1] * len], -1.0);
                    pairs.push(([base, base + 1], [base, base + 1]));
                } else {
                    let left_outer = a[0] * b[1] - a[1] * b[0] < 0.0;
                    let inner = if m == [0.0, 0.0] { na } else { [m[0] * MITER_LIMIT, m[1] * MITER_LIMIT] };
                    if left_outer {
                        push(na, 1.0);
                        push(nb, 1.0);
                        push([-inner[0], -inner[1]], -1.0);
                        out.idx.extend([base, base + 1, base + 2]);
                        pairs.push(([base, base + 2], [base + 1, base + 2]));
                    } else {
                        push(inner, 1.0);
                        push([-na[0], -na[1]], -1.0);
                        push([-nb[0], -nb[1]], -1.0);
                        out.idx.extend([base + 1, base + 2, base]);
                        pairs.push(([base, base + 1], [base, base + 2]));
                    }
                }
            }
            (a, b) => {
                let t = a.or(b).unwrap();
                let nrm = [-t[1], t[0]];
                let ext = if a.is_none() { -cap } else { cap };
                push([nrm[0] + t[0] * ext, nrm[1] + t[1] * ext], 1.0);
                push([-nrm[0] + t[0] * ext, -nrm[1] + t[1] * ext], -1.0);
                pairs.push(([base, base + 1], [base, base + 1]));
            }
        }
    }
    for i in 0..if closed { n } else { n - 1 } {
        let ([l0, r0], [l1, r1]) = (pairs[i].1, pairs[(i + 1) % n].0);
        out.idx.extend([l0, r0, l1, r0, r1, l1]);
    }
}

fn offset_byte(v: f64) -> u8 {
    (v * OFFSET_SCALE).round().clamp(-127.0, 127.0) as i8 as u8
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, scenario_dir, out_dir] = &args[..] else { panic!("geo-build <intermediate.json> <каталог сценария> <каталог вывода>") };
    let read = |p: String| std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"));
    let inp: Input = serde_json::from_str(&read(input.clone())).expect("intermediate.json");
    let pack = Pack::load(&[&read(format!("{scenario_dir}/map.json")), &read(format!("{scenario_dir}/scenario.json"))]).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(pack.scenario, inp.scenario);
    let rid = |i: usize| pack.lex.name(Space::Region, i as u16).to_string();
    let region_idx: BTreeMap<String, usize> = (0..pack.regions.len()).map(|i| (rid(i), i)).chain([(LAND.to_string(), pack.regions.len())]).collect();
    assert!(region_idx.len() < NONE as usize, "регионов больше, чем помещается в байт стороны дуги");

    // Проверка покрытия: у каждого узла, ребра и региона графа есть геометрия, у каждой фигуры — id графа.
    for s in &inp.regions {
        assert!(region_idx.contains_key(&s.id), "фигура {:?} без региона в графе", s.id);
    }
    for i in 0..pack.regions.len() {
        assert!(inp.regions.iter().any(|s| s.id == rid(i)), "у региона {} нет геометрии", rid(i));
    }
    let node_xy: Vec<P> = (0..pack.nodes.len())
        .map(|i| {
            let id = pack.lex.name(Space::Node, i as u16);
            let n = inp.nodes.iter().find(|n| n.id == id).unwrap_or_else(|| panic!("у узла {id} нет якоря"));
            [n.x, n.y]
        })
        .collect();
    assert_eq!(inp.nodes.len(), pack.nodes.len(), "якорь без узла графа");
    assert_eq!(inp.edges.len(), pack.edges.len(), "ломаная без ребра графа");
    let [bx0, by0, bx1, by1] = inp.bounds;
    let on_frame = |p: &P| (p[0] - bx0).abs() < 1e-6 || (p[0] - bx1).abs() < 1e-6 || (p[1] - by0).abs() < 1e-6 || (p[1] - by1).abs() < 1e-6;
    let protected = |p: &P| node_xy.iter().chain(&inp.protect).any(|n| dist(*n, *p) <= inp.protect_km);

    // Стороны дуг: по обе стороны регионы — граница; по одну — берег.
    let mut sides: Vec<[u8; 2]> = vec![[NONE, NONE]; inp.arcs.len()];
    for s in &inp.regions {
        for &i in s.rings.iter().flatten().flatten() {
            let (arc, side) = if i < 0 { (!i as usize, 1) } else { (i as usize, 0) };
            sides[arc][side] = region_idx[&s.id] as u8;
        }
    }

    let mut bin = Bin::default();
    let mut lod_meta = Vec::new();
    let mut index_bytes: BTreeMap<String, u8> = BTreeMap::new();
    let mut regions_meta = Vec::new();
    let last = inp.lod_scales.len() - 1;
    for (li, &scale) in inp.lod_scales.iter().enumerate() {
        // 5. Упрощение общих дуг: ≤ 1 px на наибольшем масштабе уровня, у защищённых объектов ≤ 0,5 px.
        let arcs: Vec<Vec<P>> = inp.arcs.iter().map(|arc| simplify(arc, |p| if protected(p) { PROTECTED_PX / scale } else { TOLERANCE_PX / scale })).collect();

        // 6. Проверка ошибки: наибольшее отклонение исходных вершин от упрощённых дуг в пикселях.
        const CELL: f64 = 8.0;
        let cell = |v: f64| (v / CELL).floor() as i64;
        let mut grid: BTreeMap<(i64, i64), Vec<(P, P)>> = BTreeMap::new();
        for w in arcs.iter().flat_map(|a| a.windows(2)) {
            for cx in cell(w[0][0].min(w[1][0]))..=cell(w[0][0].max(w[1][0])) {
                for cy in cell(w[0][1].min(w[1][1]))..=cell(w[0][1].max(w[1][1])) {
                    grid.entry((cx, cy)).or_default().push((w[0], w[1]));
                }
            }
        }
        let (mut dev, mut dev_prot) = (0.0f64, 0.0f64);
        for p in inp.arcs.iter().flatten() {
            let (cx, cy) = (cell(p[0]), cell(p[1]));
            let mut best = f64::MAX;
            for r in 0..8i64 {
                for (dx, dy) in (-r..=r).flat_map(|dx| (-r..=r).map(move |dy| (dx, dy))).filter(|(dx, dy)| dx.abs().max(dy.abs()) == r) {
                    for (a, b) in grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                        best = best.min(seg_dist(*p, *a, *b));
                    }
                }
                if best <= r as f64 * CELL {
                    break;
                }
            }
            let slot = if protected(p) { &mut dev_prot } else { &mut dev };
            *slot = slot.max(best);
        }
        println!("  lod{li}: до {scale} px/км — отклонение {:.2} px, у защищённых объектов {:.2} px", dev * scale, dev_prot * scale);
        assert!(dev * scale <= TOLERANCE_PX + 1e-6 && dev_prot * scale <= PROTECTED_PX + 1e-6, "ошибка упрощения вне допуска");

        // Заливка: триангуляция регионов. Вершины идут кольцами — они же контуры для попадания касания.
        let mut fv: Vec<u8> = Vec::new();
        let mut fi: Vec<u32> = Vec::new();
        let mut quant = Quant::new(inp.bounds);
        let mut count = 0usize;
        let mut contours: BTreeMap<usize, Vec<(usize, Vec<P>)>> = BTreeMap::new();
        for s in &inp.regions {
            let region = region_idx[&s.id];
            for poly in &s.rings {
                let rings: Vec<Vec<P>> = poly.iter().map(|r| ring_points(&arcs, r)).filter(|r| r.len() >= 3).collect();
                if rings.is_empty() || area(&rings[0]).abs() < 1e-9 {
                    continue;
                }
                let mut flat: Vec<f64> = Vec::new();
                let mut holes = Vec::new();
                for (i, r) in rings.iter().enumerate() {
                    if i > 0 {
                        holes.push(flat.len() / 2);
                    }
                    flat.extend(r.iter().flatten().copied());
                }
                let tris = earcutr::earcut(&flat, &holes, 2).expect("триангуляция");
                fi.extend(tris.iter().map(|&t| (count + t) as u32));
                for r in rings {
                    for p in &r {
                        quant.push(&mut fv, *p);
                        fv.extend([region as u8, 0]);
                    }
                    let first = count;
                    count += r.len();
                    contours.entry(region).or_default().push((first, r));
                }
            }
        }
        let (fi_bytes, fi_size) = indices(&fi, count);
        bin.add(format!("fill.v.lod{li}"), fv);
        bin.add(format!("fill.i.lod{li}"), fi_bytes);
        index_bytes.insert(format!("fill.i.lod{li}"), fi_size);

        // Ленты границ и берегов. Дуги по рамке карты не рисуются.
        let mut ribbons = [Ribbon::default(), Ribbon::default()];
        let mut tags: [Vec<[u8; 2]>; 2] = [Vec::new(), Vec::new()];
        for (arc, pair) in arcs.iter().zip(&sides) {
            if arc.iter().all(on_frame) {
                continue;
            }
            let k = usize::from(pair.contains(&NONE));
            let before = ribbons[k].verts.len();
            ribbon(arc, 1.0, &mut ribbons[k]);
            tags[k].extend(std::iter::repeat_n(*pair, ribbons[k].verts.len() - before));
        }
        for (k, name) in ["arcs", "coast"].into_iter().enumerate() {
            let mut v = Vec::with_capacity(ribbons[k].verts.len() * 8);
            let mut quant = Quant::new(inp.bounds);
            for (p, t) in ribbons[k].verts.iter().zip(&tags[k]) {
                quant.push(&mut v, [p[0], p[1]]);
                // Сторона ленты — старший бит второго региона.
                v.extend([offset_byte(p[2]), offset_byte(p[3]), t[0], t[1] | if p[4] > 0.0 { 128 } else { 0 }]);
            }
            let (ib, size) = indices(&ribbons[k].idx, ribbons[k].verts.len());
            bin.add(format!("{name}.v.lod{li}"), v);
            bin.add(format!("{name}.i.lod{li}"), ib);
            index_bytes.insert(format!("{name}.i.lod{li}"), size);
        }
        lod_meta.push(json!({ "max_scale": scale, "vertices": count, "triangles": fi.len() / 3 }));

        // Контуры и прямоугольники регионов самого точного уровня — попадание касания на CPU.
        if li == last {
            let mut bbox_bin = Vec::new();
            for i in 0..pack.regions.len() {
                let rings = contours.get(&i).unwrap_or_else(|| panic!("регион {} исчез при упрощении", rid(i)));
                let (lo, hi) = rings.iter().flat_map(|r| &r.1).fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), p| ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])]));
                f32s(&mut bbox_bin, &[lo[0], lo[1], hi[0], hi[1]]);
                let biggest = rings.iter().max_by(|a, b| area(&a.1).abs().total_cmp(&area(&b.1).abs())).unwrap();
                let label = label_point(&biggest.1);
                regions_meta.push(json!({
                    "id": rid(i), "idx": i, "name": pack.regions[i].name,
                    "rings": rings.iter().map(|(first, r)| [*first, r.len()]).collect::<Vec<_>>(),
                    "label": [(label[0] * 10.0).round() / 10.0, (label[1] * 10.0).round() / 10.0], "area": area(&biggest.1).abs().round(),
                }));
            }
            bin.add("bbox", bbox_bin);
        }
    }

    // Рёбра графа: ленты с плоскими концами и длиной вдоль ребра; ломаные — для движения маркеров на CPU.
    let mut routes = Ribbon::default();
    let mut lines: Vec<u8> = Vec::new();
    let mut edges_meta = Vec::new();
    let mut line_count = 0usize;
    for (i, def) in pack.edges.iter().enumerate() {
        let id = pack.lex.name(Space::Edge, i as u16);
        let e = inp.edges.iter().find(|e| e.id == id).unwrap_or_else(|| panic!("у ребра {id} нет ломаной"));
        let (a, b) = (node_xy[def.a.ix()], node_xy[def.b.ix()]);
        assert!(e.points.len() >= 2 && dist(e.points[0], a) < 0.01 && dist(*e.points.last().unwrap(), b) < 0.01, "ломаная ребра {id} не соединяет его узлы");
        let first = routes.idx.len();
        ribbon(&e.points, 0.0, &mut routes);
        let mut len = 0.0;
        for (k, p) in e.points.iter().enumerate() {
            if k > 0 {
                len += dist(*p, e.points[k - 1]);
            }
            f32s(&mut lines, &[p[0], p[1], len]);
        }
        edges_meta.push(json!({
            "id": id, "a": pack.lex.name(Space::Node, def.a.0), "b": pack.lex.name(Space::Node, def.b.0), "mode": def.mode, "days": def.days,
            "range": [first, routes.idx.len() - first], "line": [line_count, e.points.len()], "length": (len * 1000.0).round() / 1000.0,
        }));
        line_count += e.points.len();
    }
    let mut ev = Vec::with_capacity(routes.verts.len() * 12);
    let mut quant = Quant::new(inp.bounds);
    for p in &routes.verts {
        quant.push(&mut ev, [p[0], p[1]]);
        ev.extend([offset_byte(p[2]), offset_byte(p[3]), if p[4] > 0.0 { 1 } else { 255 }, 0]);
        f32s(&mut ev, &[p[5]]);
    }
    let (ei, esize) = indices(&routes.idx, routes.verts.len());
    bin.add("edges.v", ev);
    bin.add("edges.i", ei);
    index_bytes.insert("edges.i".into(), esize);
    bin.add("edge_lines", lines);

    // Якоря узлов и приоритеты подписей: столицы великих держав, столицы, прочие узлы, море.
    let nodes_meta: Vec<_> = pack
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let priority = match pack.states.iter().find(|s| s.capital == Some(n.id)) {
                Some(s) if s.class == Class::GreatPower => 3,
                Some(_) => 2,
                None if n.sea => 0,
                None => 1,
            };
            json!({
                "id": pack.lex.name(Space::Node, i as u16), "name": n.name, "x": node_xy[i][0], "y": node_xy[i][1], "sea": n.sea, "port": n.port,
                "region": n.region.map(|r| rid(r.ix())), "priority": priority,
            })
        })
        .collect();

    let bytes = bin.bytes();
    let sections: BTreeMap<&str, [usize; 2]> = bin.layout().into_iter().map(|(name, at, len)| (name, [at, len])).collect();
    let meta = json!({
        "scenario": inp.scenario,
        "pack_version": pack.version,
        "bounds": inp.bounds,
        "projection": inp.projection,
        "offset_scale": OFFSET_SCALE,
        "lods": lod_meta,
        "land_idx": pack.regions.len(),
        "regions": regions_meta,
        "nodes": nodes_meta,
        "edges": edges_meta,
        "sections": sections,
        "index_bytes": index_bytes,
        "bin_hash": blake3::hash(&bytes).to_hex().to_string(),
    });
    std::fs::create_dir_all(out_dir).expect("каталог вывода");
    std::fs::write(format!("{out_dir}/geo.bin"), &bytes).expect("geo.bin");
    std::fs::write(format!("{out_dir}/geo.json"), serde_json::to_string(&meta).unwrap()).expect("geo.json");
    println!("  уровней: {}, секций: {}, geo.bin {} КБ", inp.lod_scales.len(), bin.sections.len(), bytes.len() / 1024);
}
