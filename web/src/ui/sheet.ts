// Шторка и верхняя строка: карточки показанной ревизии. Только отображение и намерения.

import type { Action, AgreementView, CommitmentView, MeView, MoveOptions, OrderKind, OrderView, PanelItem, PowerView, Preview, ProposalView, Report, Stance, StopReason, Summary } from '../protocol.gen.ts';
import type { ViewState } from './store.ts';

export type Sel = { t: 'marker'; key: string } | { t: 'node'; id: string } | { t: 'state'; id: string } | null;
export type Draft = { candidate: OrderKind; preview: Preview | null; stances: Stance[] } | null;
export type TabId = 'turn' | 'reports' | 'diplo' | 'run';
export type RunInfo = { run_id: string; title: string; updated_at: number; status: string; day?: number; ended?: boolean; mode: string };

export type SheetCtx = {
  state: ViewState;
  actionable: boolean;
  writer: boolean;
  tab: TabId;
  sel: Sel;
  draft: Draft;
  saving: boolean;
  options: MoveOptions | null;
  waiting: number;
  texts: Map<string, string>;
  /** Донесения, раскрытые тапом, и текст, который был готов при открытии. */
  opened: Map<string, string | null>;
  names: { state: (id: string) => string; node: (id: string) => string; asset: (id: string) => string };
  /** Дата дня партии: «28 июля». */
  date: (day: number) => string;
  runs: RunInfo[];
  scenarios: [string, string][];
  llm: boolean;
  runId: string | null;
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const dateRu = (iso: string, addDays = 0, year = true) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + addDays));
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}${year ? ` ${t.getUTCFullYear()}` : ''}`;
};
const RES: Record<string, string> = { Treasury: 'Казна', Mobilization: 'Мобилизация', Pressure: 'Давление', Food: 'Запас' };
const STANCE: Record<Stance, string> = { Hold: 'Стоянка', Demonstrate: 'Демонстрация', Escort: 'Эскорт', Blockade: 'Блокада' };
const KIND: Record<string, string> = { Army: 'армия', Fleet: 'флот', Flotilla: 'флотилия', Convoy: 'конвой' };
const END: Record<string, string> = { EndEvent: 'Война великих держав', GoalAchieved: 'Цель достигнута', GoalFailed: 'Цель провалена', Horizon: 'Наступила дата предела', Crisis: 'Правительственный кризис' };
const PST: Record<string, string> = { Pending: 'ждёт ответа', Accepted: 'принято', Rejected: 'отклонено', Countered: 'встречное', Expired: 'без ответа', Withdrawn: 'отозвано' };
const REJECT: Record<string, string> = {
  NotYours: 'не ваш актив', Busy: 'актив занят', NoInitiative: 'не хватает инициативы', NoFunds: 'не хватает казны', NoPath: 'нет пути', UnknownTarget: 'цель неизвестна', BadParams: 'неверные параметры',
  OpenProposal: 'уже есть открытое предложение этой державе', Paused: 'пауза после отказа', TooSoon: 'срок слишком близко', NotPending: 'предложение уже не ждёт ответа', AlreadyAtWar: 'уже война',
  InTransition: 'переход мобилизации уже идёт', Unavailable: 'недоступно', Duplicate: 'повтор',
};

const stopText = (r: StopReason) =>
  r === 'Ended' ? 'Партия окончена' : r === 'Proposal' ? 'Вам адресовано предложение' : r === 'CommitmentDue' ? 'Срок вашего обязательства близок' : r === 'OrderDone' ? 'Ваш приказ завершён' : r === 'Days' ? 'Прошла неделя' : 'Событие требует решения — см. донесения';

const items = <T extends PanelItem['t']>(s: ViewState, t: T) => [...s.panel.values()].filter((p) => p.t === t).map((p) => p.v) as Extract<PanelItem, { t: T }>['v'][];
const actions = (s: ViewState, object: string): Action[] => {
  const p = s.panel.get(`actions:${object}`);
  return p?.t === 'Actions' ? p.v : [];
};
export const findAction = (s: ViewState, id: string): Action | undefined => items(s, 'Actions').flat().find((a) => a.id === id);
const me = (s: ViewState) => s.panel.get('me')!.v as MeView;

const btn = (a: string, label: string, cls = '', disabled = false) => `<button class="btn ${cls}" data-a="${esc(a)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
// Стоимость действия в инициативе — точками после названия.
const actionBtns = (list: Action[], ok: boolean) => list.filter((a) => a.intent).map((a) => btn(`act:${a.id}`, a.label + (a.cost ? `  ${'●'.repeat(a.cost)}` : ''), 'sm', !ok)).join('');

export function topBar(s: ViewState): string {
  const m = me(s);
  const res = Object.entries(m.resources)
    .map(([k, v]) => `<span class="chip${k === 'Pressure' && v! >= 70 ? ' warn' : ''}">${RES[k]} ${k === 'Treasury' && m.treasury_left !== v ? `${m.treasury_left}/` : ''}${v}${k === 'Mobilization' && m.mob_target ? `→${m.mob_target[0]}` : ''}</span>`)
    .join('');
  const dots = Array.from({ length: m.capacity }, (_, i) => `<i class="${i < m.initiative_left ? 'on' : i < m.initiative ? 'res' : ''}"></i>`).join('');
  return `<b>${esc(dateRu(s.date))}</b><span class="mut">${esc(m.name)}</span>${res}<span class="chip dots" title="Инициатива">${dots}</span>`;
}

function previewCard(c: SheetCtx): string {
  const d = c.draft!;
  const p = d.preview;
  const o = p?.orders[0];
  const move = 'Move' in d.candidate ? d.candidate.Move : null;
  let h = `<h3>${esc(o?.name ?? 'Проверка приказа…')}</h3>`;
  if (move && d.stances.length > 1) h += `<div class="row">${d.stances.map((s) => btn(`stance:${s}`, STANCE[s], `sm${move.stance === s ? ' on' : ''}`)).join('')}</div>`;
  if (p?.reject) h += `<p class="warn">Нельзя: ${esc(REJECT[p.reject.reason] ?? p.reject.reason)}</p>`;
  else if (o) {
    if (o.path.length) h += `<p>${o.path.map((n) => esc(c.names.node(n))).join(' → ')}</p>`;
    // Гарантировано: резерв, инициатива, видимость, нарушения.
    h += `<p>Инициатива: ${o.cost}, останется ${p!.initiative_left}. ${o.open ? 'Действие открытое.' : 'Действие тихое.'}</p>`;
    if (o.breaches.length) h += `<p class="warn">Нарушит ваши обязательства: ${o.breaches.length}</p>`;
    if (o.creates.length) h += `<p>Возникнут обязательства: ${o.creates.length}</p>`;
    // Оценка по вашим данным.
    if (o.arrive != null) h += `<p class="mut">Оценка по вашим данным на ${esc(c.date(p!.as_of))}: прибытие ${esc(c.date(o.arrive))}${o.blocked_by.length ? '' : ', путь свободен'}.</p>`;
    if (o.blocked_by.length) h += `<p class="warn">На пути известная блокада: ${o.blocked_by.map((a) => esc(c.names.asset(a))).join(', ')}</p>`;
    if (o.incursion) h += `<p class="warn">Вход без доступа — нарушение границы: ${esc(c.names.state(o.incursion))}</p>`;
    if (o.notice.length) h += `<p class="mut">Заметят сразу: ${o.notice.map((x) => esc(c.names.state(x))).join(', ')}</p>`;
  }
  const ready = !!p && !p.reject && c.actionable && c.writer;
  return `${h}<div class="row">${btn('commit', c.saving ? 'Сохраняется…' : 'Отдать приказ', 'pri', !ready || c.saving)}${btn('discard', 'Отмена')}</div>`;
}

function selCard(c: SheetCtx): string {
  const s = c.state;
  const sel = c.sel!;
  if (sel.t === 'marker') {
    const m = s.markers.get(sel.key);
    if (!m || m.t === 'Flash') return '';
    if (m.t === 'Unknown') return `<h3>Неопознанное наблюдение</h3><p>${esc(c.names.node(m.node))}: ${KIND[m.kind]}? Сведения на ${esc(c.date(m.info_day))}.</p>`;
    if (m.t === 'Foreign') {
      return `<h3>${esc(m.name)}</h3><p>${esc(c.names.state(m.owner))}, ${KIND[m.kind]}. ${esc(c.names.node(m.node))} — по сведениям на ${esc(c.date(m.info_day))}${m.stance ? `, ${STANCE[m.stance].toLowerCase()}` : ''}.</p><div class="row">${btn(`sel:state:${m.owner}`, c.names.state(m.owner), 'sm')}</div>`;
    }
    const where = m.pos.t === 'Node' ? c.names.node(m.pos.node) : `в пути: ${c.names.node(m.pos.from)} → ${c.names.node(m.pos.to)}`;
    const acts = actions(s, `asset:${m.asset}`);
    const canMove = acts.some((a) => a.kind === 'Move');
    let h = `<h3>${esc(m.name)}</h3><p>${KIND[m.kind]}, ${esc(where)}${m.stance ? `, ${STANCE[m.stance].toLowerCase()}` : ''}${m.cargo ? `, груз ${m.cargo}` : ''}${m.busy_until != null ? `. Занят до ${esc(c.date(m.busy_until))}` : ''}.</p>`;
    if (canMove) h += `<p class="mut">${c.options ? 'Перетащите фишку на цель или коснитесь подсвеченного узла.' : 'Считаем цели…'}</p>`;
    return h + `<div class="row">${actionBtns(acts, c.actionable && c.writer)}</div>`;
  }
  if (sel.t === 'node') {
    const here = [...s.markers.values()].filter((m) => (m.t === 'Own' ? m.pos.t === 'Node' && m.pos.node === sel.id : m.t !== 'Flash' && m.node === sel.id));
    return `<h3>${esc(c.names.node(sel.id))}</h3>${here.length ? here.map((m) => `<p>${m.t === 'Unknown' ? 'Неопознанное наблюдение' : esc((m as { name: string }).name)}</p>`).join('') : '<p class="mut">Известных сил нет.</p>'}`;
  }
  const p = s.panel.get(`power:${sel.id}`)?.v as PowerView | undefined;
  let h = `<h3>${esc(c.names.state(sel.id))}</h3>`;
  if (sel.id === me(s).state) return h + '<p class="mut">Ваша держава.</p>';
  if (!p) return h + '<p class="mut">В кризисе не участвует.</p>';
  h += `<p>${esc(p.persona ?? '')}</p><p>${p.mob ? `Мобилизация: ступень ${p.mob[0]} (сведения на ${esc(c.date(p.mob[1]))}). ` : ''}${p.at_war_with_me ? '<span class="warn">Война с вами.</span> ' : ''}${p.wars.length ? `Воюет: ${p.wars.map((w) => esc(c.names.state(w))).join(', ')}.` : ''}</p>`;
  return h + `<div class="row">${actionBtns(actions(s, `state:${sel.id}`), c.actionable && c.writer)}</div>`;
}

function summaryCard(sum: Summary): string {
  const mark = { Matches: '<span class="ok">совпало</span>', Contradicts: '<span class="warn">расходится</span>', Undetermined: '<span class="mut">не наступило</span>' };
  return `<h3>${esc(END[sum.reason] ?? sum.reason)}</h3><p>${esc(sum.goal_label)} — ${sum.goal === 'Open' ? 'не решено' : 'Achieved' in sum.goal ? '<span class="ok">достигнута</span>' : '<span class="warn">провалена</span>'}</p>${
    sum.checkpoints.length ? `<h4>Сравнение с каноном</h4>${sum.checkpoints.map((c) => `<p>${esc(dateRu(c.date))} · ${esc(c.label)} — ${mark[c.state]}</p>`).join('')}` : ''
  }<h4>Цепочка причин</h4>${sum.chain.map((l) => `<p class="mut">← ${esc(l)}</p>`).join('')}`;
}

function turnTab(c: SheetCtx): string {
  const s = c.state;
  const m = me(s);
  const sum = s.panel.get('summary')?.v as Summary | undefined;
  if (sum) return summaryCard(sum) + '<div class="row"><a class="btn pri" href="?new">Новая партия</a></div>';
  const orders = items(s, 'Order') as OrderView[];
  const stop = (s.panel.get('stop')?.v as StopReason[] | undefined) ?? [];
  let h = '';
  if (s.phase === 'Advancing') h += `<h3>Идёт ${esc(dateRu(s.date))}…</h3>${c.waiting ? `<p class="mut">Ждём решений держав: ${c.waiting}</p>` : ''}${c.writer ? '' : `<div class="row">${btn('adv:Next', 'Продолжить промотку', 'pri')}</div>`}`;
  else {
    const ok = c.actionable && c.writer && !c.saving;
    h += `<div class="row">${btn('adv:Next', 'Дальше', 'pri', !ok)}${btn('adv:3', 'Ждать 3 дня', '', !ok)}${btn('adv:7', '7 дней', '', !ok)}</div>`;
    if (stop.length) h += `<p>${[...new Set(stop.map(stopText))].map(esc).join(' · ')}</p>`;
  }
  h += `<p class="mut">Цель: ${esc(m.goal.label)}</p>`;
  if (orders.length) {
    h += '<h4>Приказы</h4>';
    for (const o of orders.sort((a, b) => Number(b.staged) - Number(a.staged))) {
      const cancel = o.staged || actions(s, `order:${o.id}`).length > 0;
      h += `<div class="item row"><span style="flex:1">${esc(o.name)}${o.staged ? '<span class="tag">в планах</span>' : ''}${o.arrive ? ` <span class="mut">до ${esc(o.arrive)}</span>` : ''}</span>${cancel ? btn(`cancel:${o.id}`, '×', 'sm', !(c.actionable && c.writer)) : ''}</div>`;
    }
  }
  const self = actions(s, 'self');
  if (self.length) h += `<h4>Держава</h4><div class="row">${actionBtns(self, c.actionable && c.writer)}</div>`;
  return h;
}

function reportsTab(c: SheetCtx): string {
  const list = [...c.state.reports].reverse();
  if (!list.length) return '<p class="mut">Донесений пока нет.</p>';
  return list
    .map((r: Report) => {
      const open = c.opened.has(r.report_id);
      const shown = c.opened.get(r.report_id);
      const ready = c.texts.has(r.report_id);
      // Литературный текст не меняет открытую карточку под пальцем: вставляется при следующем открытии.
      const tag = ready && !(open && shown) ? '<span class="tag">полный текст готов</span>' : '';
      return `<div class="item rep" data-a="report:${esc(r.report_id)}"><b>${esc(r.title)}${tag}</b><div class="f">${esc(r.facts)}</div>${open && shown ? `<div class="lit">${esc(shown)}<div class="mut" style="font:11px sans-serif;margin-top:4px">литературное оформление</div></div>` : ''}</div>`;
    })
    .join('');
}

function diploTab(c: SheetCtx): string {
  const s = c.state;
  const ok = c.actionable && c.writer;
  const mine = me(s).state;
  let h = '';
  const props = (items(s, 'Proposal') as ProposalView[]).sort((a, b) => b.id - a.id);
  for (const p of props) {
    h += `<div class="item"><b>${esc(p.label)}</b> <span class="mut">${esc(c.names.state(p.from))} → ${esc(c.names.state(p.to))} · ${PST[p.status]}${p.status === 'Pending' ? `, до ${esc(p.expires)}` : ''}</span>${p.terms.map((t) => `<p class="mut">${esc(t)}</p>`).join('')}<div class="row">${actionBtns(actions(s, `proposal:${p.id}`), ok)}</div></div>`;
  }
  const ags = items(s, 'Agreement') as AgreementView[];
  if (ags.length) h += `<h4>Соглашения</h4>${ags.map((a) => `<div class="item"><b>${esc(a.label)}</b> <span class="mut">${a.parties.map((x) => esc(c.names.state(x))).join(' — ')}${a.status === 'Violated' ? ' · <span class="warn">нарушено</span>' : ''}</span></div>`).join('')}`;
  const cms = (items(s, 'Commitment') as CommitmentView[]).filter((x) => x.due);
  if (cms.length) h += `<h4>Срочные обязательства</h4>${cms.map((x) => `<div class="item warn">${esc(x.text)} — до ${esc(x.due!)}${x.against ? `, против: ${esc(c.names.state(x.against))}` : ''}</div>`).join('')}`;
  const powers = items(s, 'Power') as PowerView[];
  h += `<h4>Державы</h4><div class="row">${powers.map((p) => btn(`sel:state:${p.state}`, p.name + (p.at_war_with_me ? ' ⚔' : ''), `sm${p.state === mine ? ' on' : ''}`)).join('')}</div>`;
  return h;
}

export function runTab(c: Pick<SheetCtx, 'runs' | 'scenarios' | 'llm' | 'runId'> & { state?: ViewState; writer?: boolean }): string {
  let h = '';
  if (c.state) {
    const back = [1, 3, 7].filter((n) => c.state!.day - n >= 0);
    h += `<h4>Эта партия</h4><div class="row">${btn('export', 'Экспорт в файл', 'sm')}${back.map((n) => btn(`fork:${c.state!.day - n}`, `Развилка: ${n} дн. назад`, 'sm', !c.writer)).join('')}</div>`;
  }
  // Новая партия создаётся актуальным комплектом: в открытой партии — переход на стартовый экран.
  if (c.state) return h + `<div class="row"><a class="btn sm" href="?new">Новая партия или другая партия…</a></div>`;
  h += '<h4>Новая партия</h4>';
  for (const [id, title] of c.scenarios) {
    h += `<div class="row"><b style="flex:1">${esc(title)}</b>${btn(`new:${id}:Scripted`, 'Без сервера', 'sm')}${c.llm ? btn(`new:${id}:Llm`, 'С моделями', 'sm') : ''}${btn(`new:${id}:Scripted:daily`, 'Партия дня', 'sm')}</div>`;
  }
  h += `<div class="row"><label class="btn sm">Импорт файла<input type="file" accept=".jsonl,.txt" data-a="import" hidden></label></div>`;
  const runs = c.runs.filter((r) => r.status === 'ready').sort((a, b) => b.updated_at - a.updated_at);
  if (runs.length) {
    h += '<h4>Партии</h4>';
    for (const r of runs) h += `<div class="item row"><span style="flex:1">${esc(r.title)} <span class="mut">день ${r.day ?? 0}${r.ended ? ', окончена' : ''}${r.mode === 'Llm' ? ', с моделями' : ''}</span></span>${r.run_id === c.runId ? '<span class="tag">открыта</span>' : btn(`open:${r.run_id}`, 'Открыть', 'sm')}</div>`;
  }
  return h;
}

export function sheetBody(c: SheetCtx): string {
  if (!c.writer && c.tab !== 'run') {
    const banner = `<div class="row"><span class="warn" style="flex:1">Партия открыта в другой вкладке — здесь только просмотр.</span>${btn('steal', 'Продолжить здесь', 'sm')}</div>`;
    return banner + (c.tab === 'turn' ? turnTab(c) : c.tab === 'reports' ? reportsTab(c) : diploTab(c));
  }
  if (c.draft) return previewCard(c);
  if (c.sel) {
    const card = selCard(c);
    if (card) return card + `<div class="row">${btn('desel', 'Закрыть', 'sm')}</div>`;
  }
  return c.tab === 'turn' ? turnTab(c) : c.tab === 'reports' ? reportsTab(c) : c.tab === 'diplo' ? diploTab(c) : runTab(c);
}

export function tabs(c: SheetCtx): string {
  const pending = (items(c.state, 'Proposal') as ProposalView[]).filter((p) => p.status === 'Pending' && p.to === me(c.state).state).length;
  const t: [TabId, string][] = [['turn', 'Ход'], ['reports', `Донесения${c.state.reports.length ? ` ${c.state.reports.length}` : ''}`], ['diplo', `Дипломатия${pending ? ` ●` : ''}`], ['run', 'Партия']];
  return t.map(([id, label]) => `<button class="${c.tab === id && !c.draft && !c.sel ? 'on' : ''}" data-a="tab:${id}">${esc(label)}</button>`).join('');
}
