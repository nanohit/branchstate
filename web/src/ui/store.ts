// Хранилище представления: принятая ревизия (последний применённый ViewUpdate) и показанная.
// Карта, маркеры, карточки и действия читают только показанную — одна ревизия на весь экран.

import { signal } from '@preact/signals-core';
import type { Marker, Op, PanelItem, RegionView, Report, ViewSnapshot, ViewUpdate } from '../protocol.gen.ts';

export type ViewState = {
  rev: number;
  day: number;
  date: string;
  phase: ViewSnapshot['phase'];
  regions: Map<string, RegionView>;
  markers: Map<string, Marker>;
  panel: Map<string, PanelItem>;
  reports: Report[];
};

const entries = <V>(o: { [k in string]?: V }) => new Map(Object.entries(o) as [string, V][]);

export function fromSnapshot(s: ViewSnapshot): ViewState {
  return { rev: s.rev, day: s.day, date: s.date, phase: s.phase, regions: entries(s.map.regions), markers: entries(s.map.markers), panel: entries(s.panel), reports: s.reports };
}

function patch<V>(map: Map<string, V>, ops: Op<string, V>[]): Map<string, V> {
  if (!ops.length) return map;
  const out = new Map(map);
  for (const op of ops) 'Upsert' in op ? out.set(op.Upsert[0], op.Upsert[1]) : out.delete(op.Remove);
  return out;
}

/** Донесения дописываются с заменой по `report_id`. */
function mergeReports(old: Report[], add: Report[]): Report[] {
  if (!add.length) return old;
  const ids = new Set(add.map((r) => r.report_id));
  return [...old.filter((r) => !ids.has(r.report_id)), ...add];
}

/** Обновление применяется атомарно. */
export function applyUpdate(s: ViewState, u: ViewUpdate): ViewState {
  return {
    rev: u.rev,
    day: u.day,
    date: u.date,
    phase: u.phase,
    regions: patch(s.regions, u.map_patch.regions),
    markers: patch(s.markers, u.map_patch.markers),
    panel: patch(s.panel, u.panel_patch),
    reports: mergeReports(s.reports, u.reports),
  };
}

/** Композиция последовательных патчей: последняя операция по ключу побеждает, включая удаление. */
function composeOps<V>(a: Op<string, V>[], b: Op<string, V>[]): Op<string, V>[] {
  const last = new Map<string, Op<string, V>>();
  for (const op of [...a, ...b]) {
    const key = 'Upsert' in op ? op.Upsert[0] : op.Remove;
    last.delete(key);
    last.set(key, op);
  }
  return [...last.values()];
}

export function compose(a: ViewUpdate, b: ViewUpdate): ViewUpdate {
  return {
    ...b,
    base_rev: a.base_rev,
    map_patch: { regions: composeOps(a.map_patch.regions, b.map_patch.regions), markers: composeOps(a.map_patch.markers, b.map_patch.markers) },
    panel_patch: composeOps(a.panel_patch, b.panel_patch),
    reports: mergeReports(a.reports, b.reports),
  };
}

export const hasMapChanges = (u: ViewUpdate) => u.map_patch.regions.length + u.map_patch.markers.length > 0;

export class ViewStore {
  accepted: ViewState | null = null;
  shown: ViewState | null = null;
  /** Растёт при каждой смене показанной ревизии; на него подписаны карта и панели. */
  readonly shownRev = signal(0);
  /** Литературные тексты донесений: не меняют решений и не создают ревизию. */
  readonly texts = new Map<string, string>();
  readonly textsRev = signal(0);
  /** Обновления, принятые, но ещё не показанные. */
  pending: ViewUpdate[] = [];

  snapshot(s: ViewSnapshot) {
    this.accepted = fromSnapshot(s);
    this.pending = [];
    this.show(this.accepted);
  }

  /** `false` — обновление с чужим `base_rev` отброшено: нужен `Resync`. */
  update(u: ViewUpdate): boolean {
    if (!this.accepted || u.base_rev !== this.accepted.rev) return false;
    this.accepted = applyUpdate(this.accepted, u);
    this.pending.push(u);
    return true;
  }

  show(state: ViewState) {
    this.shown = state;
    this.shownRev.value++;
  }

  /** Действия доступны только на остановке и когда показанная ревизия равна принятой. */
  get actionable(): boolean {
    return !!this.shown && this.shown.phase === 'AtStop' && this.shown.rev === this.accepted?.rev;
  }

  text(reportId: string, text: string) {
    this.texts.set(reportId, text);
    this.textsRev.value++;
  }
}
