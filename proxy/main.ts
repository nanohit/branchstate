// Посредник к моделям: Deno Deploy + KV. Не хранит партий, не держит соединений и не видит мира —
// только структурированные запросы операций. Хранит ключ провайдера, проверяет сессию и лимиты,
// собирает промпт из своей копии пакета сценария, вызывает модель, хранит результат по op_id,
// считает затраты и обращения.
//
//   deno run --unstable-kv --allow-net --allow-env --allow-read proxy/main.ts

import { EVENT_KINDS, decidePrompt, narratePrompt, type Pack } from './prompt.ts';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const API_BASE = env('API_BASE', 'https://foundation-models.api.cloud.ru/v1');
const API_KEY = env('CLOUDRU_API_KEY');
// Уровни моделей: малая и крупная. Локально обе — DeepSeek-V4.1-Flash.
const MODELS: Record<string, string> = { Small: env('MODEL_SMALL', 'deepseek-ai/DeepSeek-V4.1-Flash'), Large: env('MODEL_LARGE', 'deepseek-ai/DeepSeek-V4.1-Flash') };
// Как выключить рассуждения, зависит от шлюза: поля добавляются в тело запроса к модели как есть.
const MODEL_EXTRA = JSON.parse(env('MODEL_EXTRA', '{"extra_body":{"thinking":{"type":"disabled"}}}'));
const PRICE_CATALOG = env('PRICE_CATALOG', 'https://foundation-models.api.cloud.ru/v1/models');
const SECRET = env('HMAC_SECRET', 'dev-secret-change-me');
const LIMITS = { tokenOps: Number(env('LIMIT_TOKEN_OPS', '2000')), tokenRub: Number(env('LIMIT_TOKEN_RUB', '50')), runOps: Number(env('LIMIT_RUN_OPS', '600')), globalRub: Number(env('LIMIT_GLOBAL_RUB', '2000')) };
const MASKED = env('MASKED') === '1';
const POSTHOG = { key: env('POSTHOG_KEY'), host: env('POSTHOG_HOST', 'https://eu.i.posthog.com') };
const OP_TTL = 24 * 3600_000;
const CACHE_TTL = 7 * 24 * 3600_000;
const MAX_BODY = 64 * 1024;
const MAX_RESULT = 8 * 1024;
/** Цены по умолчанию, ₽ за 1 млн токенов; уточняются из каталога моделей провайдера. */
const prices = new Map<string, { input: number; output: number }>();
const priceKey = (model: string) => model.toLowerCase().split('/').pop()!;

const kv = await Deno.openKv(env('KV_PATH') || undefined);

// Своя копия пакетов сценариев — по версии пакета.
const packs = new Map<string, Pack>();
const root = new URL('../scenarios/', import.meta.url);
for await (const dir of Deno.readDir(root)) {
  if (!dir.isDirectory) continue;
  const read = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(`${dir.name}/${f}`, root)));
  const pack = { ...(await read('map.json')), ...(await read('scenario.json')) } as Pack;
  packs.set(pack.version, pack);
}

// ---- сессия: подписанный анонимный токен

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const hmacKey = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sign = async (payload: string) => b64(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(payload)));
const sha = async (text: string) => b64(await crypto.subtle.digest('SHA-256', enc.encode(text)));

async function tokenId(req: Request): Promise<string | null> {
  const [payload, mac] = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '').split('.');
  return payload && mac && mac === (await sign(payload)) ? payload : null;
}

// ---- учёт и лимиты: счётчики операций и затрат (в тысячных долях рубля)

const day = () => new Date().toISOString().slice(0, 10);
const counter = async (key: Deno.KvKey) => Number(((await kv.get<Deno.KvU64>(key)).value ?? 0n) as bigint);
const bump = (keys: Deno.KvKey[], n: number) => keys.reduce((a, k) => a.sum(k, BigInt(Math.max(0, Math.round(n)))), kv.atomic()).commit();
const runOf = (opId: string) => opId.split(':')[0];

type Op = { status: 'pending' | 'done' | 'failed'; hash: string; request: OpRequest; token: string; result?: unknown; model_used?: string; cost_rub?: number; error?: string };
type OpRequest = { op_id: string; kind: 'decide' | 'narrate'; pack_version: string; persona_id: string; tier: string; observation: Record<string, unknown> };

/** Клиент присылает только идентификаторы, числа и перечисления: свободного текста нет. */
function structured(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return true;
  if (typeof v === 'string') return /^[A-Za-z0-9_:~+.\-]{0,96}$/.test(v);
  if (depth > 14 || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.every((x) => structured(x, depth + 1));
  return Object.entries(v).every(([k, x]) => /^[A-Za-z0-9_]{1,40}$/.test(k) && structured(x, depth + 1));
}

function validRequest(r: OpRequest): string | null {
  if (typeof r?.op_id !== 'string' || !/^[A-Za-z0-9_:\-]{8,160}$/.test(r.op_id)) return 'op_id';
  if (r.kind !== 'decide' && r.kind !== 'narrate') return 'kind';
  const pack = packs.get(r.pack_version);
  if (!pack) return 'pack_version';
  if (!(r.tier in MODELS)) return 'tier';
  if (typeof r.observation !== 'object' || !structured(r.observation)) return 'observation';
  if (r.kind === 'decide') {
    const persona = pack.personas.find((p) => p.id === r.persona_id);
    if (!persona || persona.state !== r.observation.state || !Array.isArray(r.observation.menu)) return 'persona_id';
  }
  return null;
}

// ---- вызов модели

async function callModel(model: string, system: string, user: string): Promise<{ text: string; cost: number }> {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    // Рассуждения выключены, temperature 0, seed — если поддерживается.
    body: JSON.stringify({ model, temperature: 0, seed: 1, max_tokens: 900, response_format: { type: 'json_object' }, ...MODEL_EXTRA, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`модель ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const usage = body.usage ?? {};
  const price = prices.get(priceKey(model)) ?? { input: 0, output: 0 };
  const cost = ((usage.prompt_tokens ?? 0) * price.input + (usage.completion_tokens ?? 0) * price.output) / 1e6;
  return { text: body.choices?.[0]?.message?.content ?? '', cost };
}

const PROPS = new Set(['Hostile', 'Friendly', 'Bluffing', 'Resolved', 'WillAttack', 'WillYield', 'Unreliable', 'Reliable']);
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Условие шага из перечисления: форма и значения из пакета. */
function validCond(c: unknown, states: Set<string>): boolean {
  if (c === 'Always') return true;
  if (typeof c !== 'object' || c === null) return false;
  const [kind, v] = Object.entries(c)[0] ?? [];
  const st = (x: unknown) => typeof x === 'string' && states.has(x);
  const opt = (x: unknown) => x == null || st(x);
  // deno-lint-ignore no-explicit-any
  const a = v as any;
  if (!a || typeof a !== 'object') return false;
  if (kind === 'Day') return int(a.from, 0, 400);
  if (kind === 'Learned') return EVENT_KINDS.has(a.kind) && opt(a.actor) && opt(a.target);
  if (kind === 'Pending') return opt(a.from);
  if (kind === 'War') return st(a.a) && st(a.b);
  if (kind === 'Mob') return st(a.state) && int(a.min, 0, 3);
  return false;
}

function validTrigger(t: unknown, states: Set<string>): boolean {
  if (typeof t === 'string') return ['Proposal', 'CommitmentAtRisk', 'PlanExhausted', 'StepInvalid'].includes(t);
  if (typeof t !== 'object' || t === null) return false;
  // deno-lint-ignore no-explicit-any
  const [kind, a] = (Object.entries(t)[0] ?? []) as [string, any];
  if (kind === 'Days') return int(a?.n, 1, 30);
  return kind === 'Learned' && EVENT_KINDS.has(a?.kind) && (a.actor == null || states.has(a.actor));
}

/**
 * Проверка ответа на сервере — только схема и размер; игровая проверка — на клиенте.
 * Схема включает перечисления: шаги, триггеры и убеждения не из перечислений отбрасываются,
 * тексты причин обрезаются до 200 знаков.
 */
function parseResult(req: OpRequest, pack: Pack, text: string): unknown {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!json || json.length > MAX_RESULT) throw new Error('размер ответа');
  const r = JSON.parse(json);
  const clip = (s: unknown) => String(s ?? '').slice(0, 200);
  if (req.kind === 'narrate') {
    if (typeof r.text !== 'string' || typeof r.echo !== 'object') throw new Error('схема narrate');
    return { text: r.text.slice(0, 1200), echo: r.echo };
  }
  if (typeof r.plan !== 'object' || r.plan === null) throw new Error('схема decide');
  const states = new Set(pack.states.map((s) => s.id));
  const menu = new Set((req.observation.menu as { id: string }[]).map((m) => m.id));
  const news = new Set(((req.observation.news ?? []) as { id: number }[]).map((n) => n.id));
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    today: list(r.today).filter((id) => menu.has(id)).slice(0, 8),
    plan: {
      goal: String(r.plan.goal ?? ''),
      steps: list(r.plan.steps).filter((s) => menu.has(s?.do) && validCond(s.when ?? 'Always', states)).slice(0, 8).map((s) => ({ do: s.do, when: s.when ?? 'Always' })),
      review_if: list(r.plan.review_if).filter((t) => validTrigger(t, states)).slice(0, 6),
    },
    beliefs: list(r.beliefs)
      .filter((b) => states.has(b?.about) && b.about !== req.observation.state && PROPS.has(b.prop) && int(b.confidence, 0, 100))
      .slice(0, 3)
      .map((b) => ({ about: b.about, prop: b.prop, confidence: b.confidence, sources: list(b.sources).filter((id) => news.has(id)), reason: clip(b.reason) })),
    reason: clip(r.reason),
  };
}

async function execute(opId: string) {
  const key = ['op', opId];
  const entry = await kv.get<Op>(key);
  const op = entry.value;
  if (!op || op.status !== 'pending') return;
  const req = op.request;
  const pack = packs.get(req.pack_version)!;
  const model = MODELS[req.tier];
  try {
    const [system, user] = req.kind === 'decide' ? decidePrompt(pack, req.persona_id, req.observation, MASKED) : narratePrompt(pack, req.observation, MASKED);
    const { text, cost } = await callModel(model, system, user);
    const result = parseResult(req, pack, text);
    const done: Op = { ...op, status: 'done', result, model_used: model, cost_rub: cost };
    await kv.set(key, done, { expireIn: OP_TTL });
    await kv.set(['cache', op.hash], { result, model_used: model }, { expireIn: CACHE_TTL });
    await bump([['limit', op.token, day(), 'rub'], ['ledger', day(), 'rub'], ['ledger', day(), 'model', model, 'rub']], cost * 1000);
    await bump([['ledger', day(), 'model', model, 'calls']], 1);
  } catch (e) {
    await kv.set(key, { ...op, status: 'failed', model_used: model, error: String(e).slice(0, 300) } satisfies Op, { expireIn: OP_TTL });
    await bump([['ledger', day(), 'failed']], 1);
  }
}

// Живучесть операции: запрос ставится в очередь KV; обрыв связи у клиента операцию не прерывает.
kv.listenQueue((msg) => execute((msg as { op_id: string }).op_id));

// ---- HTTP

// Разрешённые источники — через запятую; `*` — любой (локальная разработка).
const ORIGINS = env('ALLOWED_ORIGIN', '*').split(',').map((s) => s.trim());
function cors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin') ?? '';
  const allow = ORIGINS.includes('*') ? '*' : ORIGINS.includes(origin) ? origin : ORIGINS[0];
  res.headers.set('access-control-allow-origin', allow);
  res.headers.set('access-control-allow-headers', 'content-type, authorization');
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set('vary', 'origin');
  return res;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (op: Op) => ({ status: op.status, result: op.result, model_used: op.model_used, cost_rub: op.cost_rub });

async function postOp(req: Request, token: string): Promise<Response> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'size' });
  let r: OpRequest;
  try {
    r = JSON.parse(raw);
  } catch {
    return json(400, { error: 'json' });
  }
  const bad = validRequest(r);
  if (bad) return json(400, { error: bad });
  // Хэш канонического запроса: без op_id — общий кэш для всех игроков.
  const hash = await sha(JSON.stringify([r.kind, r.pack_version, r.persona_id, r.tier, r.observation, MASKED]));
  const key = ['op', r.op_id];
  const existing = (await kv.get<Op>(key)).value;
  if (existing) {
    // Идемпотентно по op_id: тот же запрос возвращает состояние, другой — 409.
    if (existing.hash !== hash) return json(409, { error: 'op_id уже занят другим запросом' });
    return existing.status === 'done' ? json(200, { result: existing.result }) : existing.status === 'failed' ? json(200, { status: 'failed' }) : json(202, { retry_after: 300 });
  }
  const cached = (await kv.get<{ result: unknown; model_used: string }>(['cache', hash])).value;
  if (cached) {
    await kv.set(key, { status: 'done', hash, request: r, token, result: cached.result, model_used: cached.model_used, cost_rub: 0 } satisfies Op, { expireIn: OP_TTL });
    await bump([['ledger', day(), 'cache_hits']], 1);
    return json(200, { result: cached.result });
  }
  // Лимиты: на токен в сутки, на партию, глобальный суточный — в операциях и рублях.
  const [tokenOps, tokenRub, runOps, globalRub] = await Promise.all([counter(['limit', token, day(), 'ops']), counter(['limit', token, day(), 'rub']), counter(['limit', 'run', runOf(r.op_id), 'ops']), counter(['ledger', day(), 'rub'])]);
  if (tokenOps >= LIMITS.tokenOps || runOps >= LIMITS.runOps || globalRub >= LIMITS.globalRub * 1000) return json(429, { error: 'limit' });
  // При исчерпании бюджета токена — сначала понижение уровня модели.
  if (tokenRub >= LIMITS.tokenRub * 1000) {
    if (r.tier !== 'Large') return json(429, { error: 'limit' });
    r = { ...r, tier: 'Small' };
  }
  const created = await kv.atomic().check({ key, versionstamp: null }).set(key, { status: 'pending', hash, request: r, token } satisfies Op, { expireIn: OP_TTL }).enqueue({ op_id: r.op_id }).commit();
  if (created.ok) await bump([['limit', token, day(), 'ops'], ['limit', 'run', runOf(r.op_id), 'ops'], ['ledger', day(), 'ops']], 1);
  return json(202, { retry_after: 300 });
}

/** Ожидание результата до 10 с. */
async function getOp(opId: string): Promise<Response> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const op = (await kv.get<Op>(['op', opId])).value;
    if (!op) return json(404, { error: 'нет операции' });
    if (op.status !== 'pending' || Date.now() > deadline) return json(200, view(op));
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function events(req: Request): Promise<Response> {
  const { events } = await req.json().catch(() => ({ events: [] }));
  if (POSTHOG.key && Array.isArray(events) && events.length) {
    const batch = events.slice(0, 200).map((e: Record<string, unknown>) => ({ event: String(e.name), distinct_id: String(e.run ?? 'anon'), properties: e }));
    fetch(`${POSTHOG.host}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: POSTHOG.key, batch }) }).catch(() => {});
  }
  return json(200, {});
}

async function ledger(): Promise<Response> {
  const out: Record<string, number> = {};
  for await (const e of kv.list<Deno.KvU64>({ prefix: ['ledger', day()] })) out[e.key.slice(2).join('/')] = Number(e.value as unknown as bigint) / (e.key.at(-1) === 'rub' ? 1000 : 1);
  return json(200, { day: day(), ...out });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (url.pathname === '/v1/session' && req.method === 'POST') {
    const payload = b64(enc.encode(JSON.stringify({ id: crypto.randomUUID(), iat: Date.now() })));
    return json(200, { token: `${payload}.${await sign(payload)}`, limits: LIMITS });
  }
  if (url.pathname === '/v1/ledger' && req.method === 'GET') return ledger();
  const token = await tokenId(req);
  if (!token) return json(401, { error: 'token' });
  if (url.pathname === '/v1/ops' && req.method === 'POST') return postOp(req, token);
  const m = /^\/v1\/ops\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === 'GET') return getOp(decodeURIComponent(m[1]));
  if (url.pathname === '/v1/events' && req.method === 'POST') return events(req);
  return json(404, { error: 'not found' });
}

// Цены моделей из каталога провайдера: ₽ за 1 млн токенов. Шлюз может называть модель короче
// (`deepseek-v4.1-flash` вместо `deepseek-ai/DeepSeek-V4.1-Flash`), поэтому ключ — имя без издателя и регистра.
fetch(PRICE_CATALOG, { signal: AbortSignal.timeout(10_000) })
  .then((r) => r.json())
  .then((list) => {
    for (const m of list.data ?? []) if (m.metadata?.prompt_tokens_cost != null) prices.set(priceKey(m.id), { input: m.metadata.prompt_tokens_cost, output: m.metadata.generated_tokens_cost ?? 0 });
  })
  .catch(() => console.warn('каталог моделей недоступен: затраты считаются по нулевым ценам'));

Deno.serve({ port: Number(env('PORT', '8787')) }, async (req) => cors(req, await handle(req).catch((e) => json(500, { error: String(e) }))));
