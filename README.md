# BranchState

Одиночная игра об управлении кризисом: детерминированное Rust-ядро в WebAssembly внутри Worker,
карта на WebGL2, журнал в IndexedDB, тонкий посредник к моделям на Deno. Сценарии — «Июль 1914»
и вымышленный «Остров». Законы ядра — в [LAWS.md](LAWS.md).

## Запуск

```sh
npm install
npm run dev                # сборка комплекта и http://localhost:5173 — режим scripted, сервер не нужен
npm run proxy              # посредник на :8787, настройки — в .env
                           # режим llm: открыть http://localhost:5173/?proxy=http://localhost:8787
```

`.env` посредника: `CLOUDRU_API_KEY`, `API_BASE` (OpenAI-совместимый адрес), `MODEL_SMALL` и `MODEL_LARGE`
(локально обе — `deepseek-v4.1-flash`). Рассуждения выключает `MODEL_EXTRA` — JSON, который добавляется в тело
запроса к модели; по умолчанию `{"extra_body":{"thinking":{"type":"disabled"}}}`. `MASKED=1` включает режим псевдонимов.

Нужны Rust с целью `wasm32-unknown-unknown`, `wasm-bindgen-cli` 0.2.129, Node 25+, Deno 2 (для посредника).

## Проверки

```sh
npm test                   # ядро (законы, дифф-тест утечек, 1000 автопрогонов), Worker, UI, посредник
npm run e2e                # браузер: эталонный цикл, карта, потеря контекста, офлайн, две вкладки (нужен Chrome)
cargo run --release -p sim -- play july1914 3        # партия в терминале
cargo run --release -p sim -- autorun island 1000    # распределение исходов scripted
node scripts/llm-autorun.ts july1914 50 http://127.0.0.1:8787 5000   # партии llm через посредника: fallback, T1–T3, затраты
                                                                     # последний аргумент — раздумья игрока на остановке, мс
npm run geo                # пересборка геометрии из закреплённых входов со сверкой geo/build.lock
npm run golden             # перезаписать золотые журналы после намеренной смены правил или чисел
```

## Устройство

| Каталог | Что там |
| --- | --- |
| `crates/core` | ядро: мир, знание, наблюдение, приказы, разрешение дня, агенты, донесения, проекция `PlayerView` |
| `crates/wasm` | граница ядра для Worker: синхронные вызовы с JSON |
| `crates/sim` | CLI: партия, автопрогоны, экспорт и воспроизведение журнала |
| `crates/geo-build` | буферы карты: упрощение дуг с допуском в пикселях, триангуляция, ленты, `geo.bin` |
| `geo/` | геопайплайн: закреплённые входы OHM и Natural Earth, правки, `build.lock` |
| `scenarios/` | пакеты сценариев: граф (`map.json`) и данные с числами-гипотезами (`scenario.json`) |
| `web/shell` | оболочка: `index.html`, шим Worker, Service Worker |
| `web/src/worker` | адаптер Worker: `RunStore`, `TurnOp`, команды, промотка, восстановление, клиент операций |
| `web/src/ui` | интерфейс: хранилище ревизий, часы анимации, жесты, рендерер WebGL2, DOM-слой, шторка |
| `proxy/` | посредник: сессия, лимиты, промпт из своей копии пакета, очередь KV, учёт затрат |

`web/src/protocol.gen.ts` генерируется из Rust при сборке — руками не править.
