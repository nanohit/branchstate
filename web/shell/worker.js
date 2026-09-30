// Шим Worker: не зависит от версии. Worker принимает только скрипт своего источника, поэтому шим
// получает URL ядра комплекта параметром и импортирует его как модуль.
const early = [];
self.onmessage = (e) => early.push(e);
const core = new URL(self.location.href).searchParams.get('core');
import(core)
  // Кросс-доменный импорт модуля в Worker работает не везде: запасной путь — fetch и Blob URL.
  .catch(async () => import(URL.createObjectURL(await (await fetch(core)).blob())))
  .then(() => early.forEach((e) => self.onmessage(e)));
