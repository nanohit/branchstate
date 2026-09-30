// Сквозные тесты в настоящем браузере (Playwright, системный Chrome, программный WebGL):
// эталонный цикл взаимодействия, состояния карты, потеря контекста, офлайн-комплект, две вкладки.
//   npm run e2e   (нужен собранный dist/ и установленный Google Chrome)

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
// @ts-expect-error: скрипт сборки без типов
import { serve } from '../../scripts/serve.mjs';

const PORT = 5188;
const URL_ = `http://localhost:${PORT}`;
let server: { close(): void };
let browser: Browser;

before(async () => {
  server = await serve(path.resolve(import.meta.dirname, '../../dist'), PORT);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** Телефон: 390×780, DPR 2. Сообщения `Metric` интерфейса записываются для проверки бюджетов. */
async function phone(): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __metrics: Record<string, number[]> };
    w.__metrics = {};
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: { t?: string; name: string; value: number }, ...rest: unknown[]) {
      if (msg?.t === 'Metric') (w.__metrics[msg.name] ??= []).push(msg.value);
      return (post as (...a: unknown[]) => void).call(this, msg, ...rest);
    } as typeof post;
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

async function newRun(page: Page, scenario = 'july1914') {
  await page.goto(`${URL_}/?new`);
  await page.click(`[data-a="new:${scenario}:Scripted"]`);
  await page.waitForSelector('.mk.own');
  await page.waitForSelector('[data-a="adv:Next"]:not([disabled])');
}

const center = async (page: Page, selector: string) => {
  const b = (await page.locator(selector).first().boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
};
const metrics = (page: Page) => page.evaluate(() => (window as unknown as { __metrics: Record<string, number[]> }).__metrics);

/** Цвет пикселя снимка экрана: минимальный разбор PNG (RGB/RGBA, 8 бит). */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  let pos = 8;
  let channels = 3;
  const data: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    if (type === 'IHDR') channels = png[pos + 8 + 9] === 6 ? 4 : 3;
    if (type === 'IDAT') data.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  // Первая строка, первый пиксель: фильтры Sub/Up/Average/Paeth без соседей дают сами байты.
  assert.ok(channels >= 3);
  return [raw[1], raw[2], raw[3]];
}
const near = (a: number[], b: number[], tol = 28) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('эталонный цикл: выбрать актив → перетащить → превью → Commit → Advance → остановка → приказы снова доступны', async () => {
  const { ctx, page, errors } = await phone();
  const cdp = await ctx.newCDPSession(page);
  await newRun(page);
  // Замедление CPU ×4 — как на среднем телефоне.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const [x, y] = await center(page, '[data-key="a:aut_army_2"]');
  await page.mouse.click(x, y);
  await page.waitForSelector('.nd.tgt', { state: 'attached' });
  const target = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.nd.tgt')].find((e) => e.textContent === 'Землин')!;
    const b = el.getBoundingClientRect();
    return [b.x, b.y];
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 6, y + 14, { steps: 4 });
  assert.ok(await page.locator('.mk.drag').count(), 'фишка следует за пальцем');
  await page.mouse.move(target[0] - 2, target[1] - 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForSelector('[data-a="commit"]:not([disabled])');
  assert.match(await page.locator('#sheet h3').innerText(), /2-я армия → Землин/);
  assert.match(await page.locator('#sheet .body').innerText(), /прибытие 24 июля/);

  await page.click('[data-a="commit"]');
  await page.waitForSelector('[data-a="adv:Next"]:not([disabled])');
  assert.match(await page.locator('#sheet .body').innerText(), /в планах/);
  const before = await center(page, '[data-key="a:aut_army_2"]');
  await page.click('[data-a="adv:Next"]');
  await page.waitForFunction(() => document.querySelector('#top b')?.textContent?.startsWith('24 июля'));
  await page.waitForSelector('[data-a="adv:Next"]:not([disabled])');
  const afterMove = await center(page, '[data-key="a:aut_army_2"]');
  assert.ok(Math.hypot(afterMove[0] - before[0], afterMove[1] - before[1]) > 20, 'армия пришла в Землин');

  const m = await metrics(page);
  const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').map((e) => [e.name, Math.round(e.startTime)])));
  console.log('готовность, мс:', marks, '· T1/T2/T3 UI:', m.t1_ui, m.t2_ui, m.t3_ui, '· превью:', m.preview_ms, '· кадры:', m.frames_slow_pct, m.frame_max_ms);
  assert.ok(marks['bs:map_visible'] <= marks['bs:map_movable'] + 50 && marks['bs:map_movable'] <= marks['bs:can_order']);
  // Локально, без сети и с программным WebGL: бюджеты холодного старта 2,0 / 2,5 / 3,0 с и T1 ≤ 100 мс, T3 ≤ 6 с.
  assert.ok(marks['bs:can_order'] < 3000, `можно отдать приказ за ${marks['bs:can_order']} мс`);
  assert.ok(m.t1_ui[0] <= 100 * 4, `T1 ${m.t1_ui[0]} мс при замедлении ×4`);
  assert.ok(m.t3_ui[0] <= 6000);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('состояния регионов на фиксированной камере и потеря контекста WebGL', async () => {
  const { ctx, page, errors } = await phone();
  await newRun(page);
  await page.waitForTimeout(300);
  const at = (name: string) => page.evaluate((n) => { const b = [...document.querySelectorAll('.nd')].find((e) => e.textContent === n)!.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y)]; }, name);
  // Заливка рядом с узлом: смещение от точки и подписи.
  const sample = async (name: string) => { const [x, y] = await at(name); return pixel(page, x - 14, y + 18); };
  const [vienna, budapest, berlin, sea] = [await sample('Вена'), await sample('Будапешт'), await sample('Берлин'), await sample('Адриатика')];
  assert.ok(near(vienna, budapest), `регионы игрока одного цвета: ${vienna} / ${budapest}`);
  assert.ok(!near(vienna, berlin, 12), `чужая держава другого цвета: ${vienna} / ${berlin}`);
  assert.ok(near(sea, [184, 207, 219], 24), `море: ${sea}`);

  // Потеря контекста: все ресурсы пересозданы, показана актуальная ревизия.
  const lost = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!;
    const ext = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    const wait = (type: string) => new Promise((r) => canvas.addEventListener(type, r, { once: true }));
    const l = wait('webglcontextlost');
    ext.loseContext();
    await l;
    await new Promise((r) => setTimeout(r, 50));
    const r = wait('webglcontextrestored');
    ext.restoreContext();
    await r;
    return true;
  });
  assert.ok(lost);
  await page.waitForTimeout(300);
  assert.ok(near(await sample('Вена'), vienna, 6), 'после восстановления карта та же');
  assert.ok(near(await sample('Берлин'), berlin, 6));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('закрытая вкладка продолжает партию; готовый комплект открывает её без сети', async () => {
  const { ctx, page, errors } = await phone();
  await newRun(page, 'island');
  await page.click('[data-a="adv:Next"]');
  await page.waitForFunction(() => !document.querySelector('#top b')?.textContent?.startsWith('1 марта'));
  await page.waitForSelector('[data-a="adv:Next"]:not([disabled])');
  const date = await page.locator('#top b').innerText();
  // Комплект закэширован целиком и проверен по SRI — стоит отметка `ready/<manifest_id>`.
  await page.waitForFunction(async () => (await (await caches.open('bundles')).keys()).some((r) => r.url.includes('/ready/')), null, { timeout: 15000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-a="adv:Next"]:not([disabled])');
  assert.equal(await page.locator('#top b').innerText(), date, 'тот же день после перезагрузки без сети');
  await page.click('[data-a="adv:Next"]');
  await page.waitForFunction((d) => document.querySelector('#top b')?.textContent !== d, date);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('вторая вкладка открывает партию только для просмотра и может перехватить её', async () => {
  const { ctx, page } = await phone();
  await newRun(page, 'island');
  const second = await ctx.newPage();
  await second.goto(page.url());
  await second.waitForSelector('[data-a="steal"]');
  assert.match(await second.locator('#sheet .body').innerText(), /только просмотр/);
  await second.click('[data-a="steal"]');
  await second.waitForSelector('[data-a="adv:Next"]:not([disabled])');
  // Старый писатель узнаёт о потере владения и переходит в просмотр.
  await page.waitForSelector('[data-a="steal"]');
  await ctx.close();
});
