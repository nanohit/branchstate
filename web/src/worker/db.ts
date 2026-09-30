// IndexedDB: базы оболочки и партии. Все записи игровых данных делает только Worker.

export const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Завершение транзакции: именно событие `complete`, а не успех отдельного `put`. */
export const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new DOMException('транзакция прервана', 'AbortError'));
  });

function open(idb: IDBFactory, name: string, stores: string[]): Promise<IDBDatabase> {
  const r = idb.open(name, 1);
  r.onupgradeneeded = () => {
    for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
  };
  return req(r);
}

/** Оболочка хранилища: стабильна, меняется только добавлением полей. */
export const openShell = (idb: IDBFactory) => open(idb, 'branchstate', ['runs_index', 'settings']);

export const RUN_STORES = ['meta', 'turn_op', 'commands', 'ops', 'day_inputs', 'days', 'snapshots'] as const;
export type RunStoreName = (typeof RUN_STORES)[number];

export const openRun = (idb: IDBFactory, runId: string) => open(idb, `run-${runId}`, [...RUN_STORES]);

export class Fenced extends Error {
  constructor() {
    super('писатель потерял владение партией');
  }
}

/** Ошибки, которые интерфейс показывает как ошибку хранения. */
export const isStorageError = (e: unknown) => !(e instanceof Fenced);

export type Faults = {
  /** Вызывается перед завершением каждой записи; исключение имитирует убийство Worker или сбой хранилища. */
  beforeCommit?: (stores: readonly string[]) => void;
};

/** База одной партии. Каждая запись ограждена номером писателя из той же базы и той же транзакции. */
export class RunStore {
  db: IDBDatabase;
  epoch = 0;
  faults: Faults;

  constructor(db: IDBDatabase, faults: Faults = {}) {
    this.db = db;
    this.faults = faults;
  }

  get<T>(store: RunStoreName, key: IDBValidKey): Promise<T | undefined> {
    return req(this.db.transaction(store).objectStore(store).get(key));
  }

  all<T>(store: RunStoreName): Promise<T[]> {
    return req(this.db.transaction(store).objectStore(store).getAll());
  }

  keys(store: RunStoreName): Promise<IDBValidKey[]> {
    return req(this.db.transaction(store).objectStore(store).getAllKeys());
  }

  /** Получив блокировку, писатель атомарно увеличивает ограждающий номер. */
  async bumpEpoch(): Promise<number> {
    const tx = this.db.transaction('meta', 'readwrite');
    const meta = tx.objectStore('meta');
    this.epoch = ((await req(meta.get('writer_epoch'))) ?? 0) + 1;
    meta.put(this.epoch, 'writer_epoch');
    await done(tx);
    return this.epoch;
  }

  /**
   * Запись одной транзакцией: читает `writer_epoch`, сравнивает со своим и прерывается при несовпадении.
   * Возвращается только после `complete`.
   */
  async write(stores: RunStoreName[], body: (s: Record<RunStoreName, IDBObjectStore>) => void | Promise<void>): Promise<void> {
    const names = [...new Set<RunStoreName>(['meta', ...stores])];
    const tx = this.db.transaction(names, 'readwrite');
    const finished = done(tx);
    finished.catch(() => {});
    try {
      const s = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])) as Record<RunStoreName, IDBObjectStore>;
      if ((await req(s.meta.get('writer_epoch'))) !== this.epoch) throw new Fenced();
      await body(s);
      this.faults.beforeCommit?.(names);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* транзакция уже завершена */
      }
      await finished.catch(() => {});
      throw e;
    }
    await finished;
  }
}
