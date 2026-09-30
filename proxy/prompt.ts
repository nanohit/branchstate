// Сборка промпта из копии пакета сценария. Весь текст — инструкции, карточка персонажа, названия —
// берётся здесь; от клиента приходят только идентификаторы, числа и перечисления.

export type Pack = {
  version: string;
  title: string;
  start_date: string;
  states: { id: string; name: string; class: string }[];
  nodes: { id: string; name: string }[];
  assets: { id: string; name: string; kind: string; owner: string }[];
  personas: { id: string; state: string; name: string; office: string; traits: string[]; interests: { key: string; weight: number }[] }[];
  templates: { id: string; label: string }[];
};

// deno-lint-ignore no-explicit-any
type Any = any;

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const KIND: Record<string, string> = { Army: 'армия', Fleet: 'флот', Flotilla: 'флотилия', Convoy: 'конвой' };
const EVENT: Record<string, string> = {
  Arrived: 'прибытие', Incursion: 'нарушение границы', Demonstration: 'демонстрация силы', BlockadeSet: 'установлена блокада', Blocked: 'конвой остановлен блокадой', Battle: 'бой',
  AssetLost: 'потеря соединения', Occupied: 'занятие территории', HostilitiesOpened: 'открытие огня', WarDeclared: 'объявление войны', Proposed: 'предложение', ProposalAccepted: 'предложение принято',
  ProposalRejected: 'предложение отклонено', ProposalCountered: 'встречное предложение', ProposalExpired: 'предложение осталось без ответа', ProposalWithdrawn: 'предложение отозвано',
  AgreementMade: 'соглашение заключено', Declared: 'заявление', ThreatUnanswered: 'угроза не исполнена', MobilizationStarted: 'начата мобилизация', MobilizationChanged: 'ступень мобилизации',
  Paid: 'платёж', PaymentFailed: 'платёж не прошёл', CommitmentDue: 'гаранту пора действовать по гарантии', Fulfilled: 'обязательство исполнено', Breach: 'нарушение обязательства',
  Expired: 'обязательство прекращено', UpkeepUnpaid: 'нет денег на содержание', CabinetDemand: 'требование кабинета', GovernmentCrisis: 'правительственный кризис', CargoLoaded: 'закупка', CargoUnloaded: 'разгрузка',
};
const CHANNEL: Record<string, string> = { Direct: 'свои действия', Seen: 'наблюдение', Embassy: 'посольство', Telegraph: 'телеграф', Press: 'пресса', Leak: 'утечка', Inquiry: 'разведка' };

/** Названия из лексикона пакета; в режиме `masked` — псевдонимы держав, узлов и соединений и относительные дни. */
function lexicon(pack: Pack, masked: boolean) {
  const alias = (list: { id: string; name: string }[], prefix: string) => new Map(list.map((x, i) => [x.id, masked ? `${prefix} ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}` : x.name]));
  const [states, nodes, assets] = [alias(pack.states, 'Держава'), alias(pack.nodes, 'узел'), alias(pack.assets, 'соединение')];
  const templates = new Map(pack.templates.map((t) => [t.id, t.label]));
  const [y, m, d] = pack.start_date.split('-').map(Number);
  return {
    st: (id: Any) => states.get(id) ?? '—',
    nd: (id: Any) => nodes.get(id) ?? '—',
    as: (id: Any) => assets.get(id) ?? '—',
    // Названия шаблонов содержат реальные имена, поэтому в `masked` не показываются.
    tpl: (id: Any) => (id && !masked ? ` («${templates.get(id) ?? id}»)` : ''),
    day: (n: Any) => {
      if (masked || typeof n !== 'number') return `день ${n}`;
      const t = new Date(Date.UTC(y, m - 1, d + n));
      return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
    },
  };
}

type Lex = ReturnType<typeof lexicon>;

function term(t: Any, L: Lex): string {
  const [kind, v] = Object.entries(t)[0] as [string, Any];
  switch (kind) {
    case 'Access':
      return `${L.st(v.grantor)} пускает ${L.st(v.party)} в ${L.nd(v.node)} до ${L.day(v.until)}`;
    case 'Passage':
      return `${L.st(v.grantor)} пропускает ${L.st(v.party)} через ${v.route.map(L.nd).join(', ')} до ${L.day(v.until)}`;
    case 'Pay':
      return `${L.st(v.from)} платит ${L.st(v.to)} ${v.amount}${v.times > 1 ? ` каждые ${v.every} дн., ${v.times} раз` : ''}`;
    case 'Guarantee':
      return `${L.st(v.guarantor)} гарантирует защиту ${L.st(v.protected)} (триггер ${v.trigger}, ${v.window} дн. на ответ) до ${L.day(v.until)}`;
    default:
      return `${L.st(v.party)} воздерживается от действия ${v.kind}${v.target ? ` против ${L.st(v.target)}` : ''} до ${L.day(v.until)}`;
  }
}

function claim(c: Any, L: Lex): string {
  const [kind, v] = Object.entries(c)[0] as [string, Any];
  if (kind === 'Demand') return `требование: ${v.terms.map((t: Any) => term(t, L)).join('; ')}`;
  if (kind === 'Pledge') return `обещание: ${term(v.term, L)}`;
  if (kind === 'Support') return `поддержка ${L.st(v.of)}`;
  if (kind === 'Warning') return `предупреждение: не делать ${v.kind}${v.target ? ` против ${L.st(v.target)}` : ''}`;
  if (kind === 'NoIntent') return `заверение: нет намерения ${v.kind}${v.target ? ` против ${L.st(v.target)}` : ''}`;
  return `отрицание события ${v.kind}`;
}

function order(o: Any, L: Lex): string {
  const [kind, v] = Object.entries(o)[0] as [string, Any];
  switch (kind) {
    case 'Move':
      return `переместить ${L.as(v.asset)} в ${L.nd(v.to)}, стойка ${v.stance}`;
    case 'Engage':
      return `атаковать: ${L.as(v.asset)} против ${L.as(v.target)} — открывает боевые действия`;
    case 'Propose':
      return `предложить ${L.st(v.to)}${L.tpl(v.template)}: ${v.terms.map((t: Any) => term(t, L)).join('; ')}`;
    case 'Counter':
      return `встречное предложение на №${v.proposal}${L.tpl(v.template)}: ${v.terms.map((t: Any) => term(t, L)).join('; ')}`;
    case 'Accept':
      return `принять предложение №${v.proposal}`;
    case 'Reject':
      return `отклонить предложение №${v.proposal}`;
    case 'Declare':
      return `заявление (${v.kind}) для ${L.st(v.to)}${L.tpl(v.template)}: ${claim(v.claim, L)}${v.deadline != null ? `, срок ${L.day(v.deadline)}` : ''}`;
    case 'DeclareWar':
      return `объявить войну: ${L.st(v.target)}`;
    case 'Mobilize':
      return v.delta > 0 ? 'повысить мобилизацию на ступень' : 'понизить мобилизацию на ступень';
    case 'Pay':
      return `заплатить ${L.st(v.to)} ${v.amount}`;
    case 'Inquire':
      return `разведка: ${L.st(v.target)}`;
    default:
      return `отменить приказ №${v.order}`;
  }
}

const SYSTEM = `Ты принимаешь решения за одного государственного деятеля в пошаговой игре о дипломатическом кризисе.
Действуй в характере персонажа и только из того, что ему известно: сведений, которых нет в наблюдении, у тебя нет.
Не пересказывай историю и не следуй известному тебе историческому исходу: решай по обстановке в наблюдении.
Выбирать можно только действия из меню — по их id. Каждое действие стоит инициативы; если её не хватает, не выбирай действие.
Ответь одним объектом JSON без пояснений:
{"today": [id действий на сегодня], "plan": {"goal": ключ интереса персонажа, "steps": [{"do": id из меню, "when": условие}], "review_if": [триггеры]},
 "beliefs": [{"about": id державы, "prop": одно из Hostile|Friendly|Bluffing|Resolved|WillAttack|WillYield|Unreliable|Reliable, "confidence": 0-100, "sources": [номера новостей], "reason": до 200 знаков}],
 "reason": до 200 знаков}
Условия "when": "Always" | {"Day":{"from":N}} | {"Learned":{"kind":вид события,"actor":id державы}} | {"Pending":{"from":id державы}} | {"War":{"a":id,"b":id}} | {"Mob":{"state":id,"min":N}}.
Триггеры "review_if": "Proposal" | "CommitmentAtRisk" | "PlanExhausted" | {"Days":{"n":N}} | {"Learned":{"kind":вид события,"actor":id державы}}.
Вид события — только из этого списка, других нет: ${Object.entries(EVENT).map(([k, v]) => `${k} (${v})`).join(', ')}.
В "steps" — только будущие действия: не повторяй действия из "today" и не ставь шаг, условие которого уже выполнено. Пустой список шагов допустим.
До 3 убеждений, до 4 шагов плана; каждый "reason" — одна короткая фраза до 80 знаков. id держав и действий пиши в точности как в наблюдении.
Если меню пусто, "today" и "steps" пусты.`;

/** Виды событий, которые можно называть в условиях и триггерах. */
export const EVENT_KINDS = new Set(Object.keys(EVENT));

export function decidePrompt(pack: Pack, personaId: string, o: Any, masked: boolean): [string, string] {
  const L = lexicon(pack, masked);
  const p = pack.personas.find((x) => x.id === personaId)!;
  const who = masked ? `министр державы «${L.st(p.state)}»` : `${p.name}, ${p.office}`;
  const lines: string[] = [];
  const section = (title: string, rows: string[]) => rows.length && lines.push(`\n## ${title}`, ...rows);
  lines.push(`Ты — ${who}. Черты: ${p.traits.join(', ')}.`, `Интересы (ключ: вес): ${p.interests.map((i) => `${i.key}: ${i.weight}`).join(', ')}.`);
  lines.push(`Id держав: ${pack.states.filter((s) => pack.personas.some((x) => x.state === s.id)).map((s) => `${s.id} — ${L.st(s.id)}`).join('; ')}.`);
  lines.push(`\nСегодня ${L.day(o.day)} (день ${o.day}). Твоя держава: ${o.state} — ${L.st(o.state)}.`);
  lines.push(`Ресурсы: ${Object.entries(o.resources ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}. Инициатива: ${o.initiative}.`);
  section('Цель и текущий план', [`Цель: ${o.goal || '—'}. Шагов в плане: ${o.plan?.length ?? 0}.`, `Пересмотр вызван: ${JSON.stringify(o.triggers ?? [])}`]);
  section('Отношения (память)', (o.relations ?? []).map((r: Any) => `${L.st(r.about)}: ${r.kind}, вес ${r.weight}, ${L.day(r.day)}`));
  section('Твои убеждения', (o.beliefs ?? []).map((b: Any) => `${L.st(b.about)}: ${b.prop} (${b.confidence}%)`));
  section(
    'Новости с прошлого пересмотра',
    (o.news ?? []).map((n: Any) => `[${n.id}] ${L.day(n.day)}, ${CHANNEL[n.channel] ?? n.channel}: ${EVENT[n.kind] ?? n.kind} — ${L.st(n.actor)}${n.target ? ` → ${L.st(n.target)}` : ''}${n.node ? `, ${L.nd(n.node)}` : ''}${n.asset ? `, ${L.as(n.asset)}` : ''}${n.amount ? `, ${n.amount}` : ''}${L.tpl(n.template)}`),
  );
  section('Обязательства', (o.commitments ?? []).map((c: Any) => `№${c.id}: должник ${L.st(c.debtor)}, перед ${L.st(c.creditor)}${c.due ? ` — СРОЧНО до ${L.day(c.due.by)}, против ${L.st(c.due.against)}` : ''}`));
  section('Соглашения', (o.agreements ?? []).map((a: Any) => `№${a.id}${L.tpl(a.template)}: ${a.terms.map((t: Any) => term(t, L)).join('; ')}`));
  section('Открытые предложения', (o.proposals ?? []).map((x: Any) => `№${x.id} ${L.st(x.from)} → ${L.st(x.to)}${x.ultimatum ? ' (ультиматум)' : ''}, до ${L.day(x.expires)}: ${x.terms.map((t: Any) => term(t, L)).join('; ')}`));
  section('Твои силы', (o.assets ?? []).map((a: Any) => `${L.as(a.id)} (${KIND[a.kind]}): ${L.nd(a.at)}${a.free ? '' : ', занят'}${a.stance ? `, ${a.stance}` : ''}`));
  section('Известные чужие силы', (o.contacts ?? []).map((c: Any) => `${L.as(c.asset)} (${KIND[c.kind]}, ${L.st(c.owner)}): ${L.nd(c.node)}, сведения на ${L.day(c.day)}${c.stance ? `, ${c.stance}` : ''}`));
  section('Войны и мобилизация', [
    ...(o.wars ?? []).map((w: Any) => `война: ${L.st(w[0])} — ${L.st(w[1])}`),
    ...Object.entries(o.mobilization ?? {}).filter(([, v]) => v).map(([s, v]) => `${L.st(s)}: ступень ${v}`),
  ]);
  section('Меню допустимых действий (id — действие)', (o.menu ?? []).map((m: Any) => `${m.id} — ${order(m.intent, L)}`));
  return [SYSTEM, lines.join('\n')];
}

const NARRATE = `Ты пишешь короткое донесение в духе эпохи от лица канала, которым пришла новость: 2–3 предложения, по-русски.
Это литературное оформление уже известных фактов: не добавляй событий, сторон, мест, дат, исходов, исполнения и последствий, которых нет во входе, и не меняй данные.
Если подробностей нет, не пиши об этом — просто изложи известное.
Ответь одним объектом JSON: {"text": текст донесения, "echo": объект echo из входа без изменений}.`;

export function narratePrompt(pack: Pack, o: Any, _masked: boolean): [string, string] {
  // Донесения всегда пишутся с реальными именами.
  const L = lexicon(pack, false);
  const e = o.echo ?? {};
  // Число исхода осмысленно только у некоторых событий; остальным оно в тексте не нужно.
  const outcome =
    e.kind === 'Battle'
      ? `Исход боя: ${e.outcome > 0 ? `успех стороны «${L.st(e.actor)}»` : e.outcome < 0 ? `успех стороны «${L.st(e.target)}»` : 'без решительного исхода'}`
      : e.kind === 'MobilizationStarted' || e.kind === 'MobilizationChanged'
        ? `Ступень мобилизации: ${e.outcome} из 3`
        : '';
  const about = pack.templates.find((t) => t.id === o.template)?.label;
  const facts = [`Событие: ${EVENT[e.kind] ?? e.kind}`, about && `Суть: ${about}`, `Кто: ${L.st(e.actor)}`, e.target && `Против кого или кому: ${L.st(e.target)}`, e.node && `Где: ${L.nd(e.node)}`, `Когда: ${L.day(e.day)}`, `Канал: ${CHANNEL[o.channel] ?? o.channel}`, outcome]
    .filter(Boolean)
    .join('\n');
  return [NARRATE, `${facts}\n\necho: ${JSON.stringify(e)}`];
}
