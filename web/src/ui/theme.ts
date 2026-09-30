// Тема клиента: смысл приходит от ядра, вид — отсюда. Цвета, толщины и длительности.

export const T_DAY_MS = 700;
export const T_JUMP_MS = 200;
export const MAX_WAITING = 2;
export const FLASH_MS = 1400;
export const FLASH_REPEATS = 2;

export const SEA = [0.72, 0.81, 0.86] as const;
const LAND: RGB = [221, 214, 198];
const UNKNOWN: RGB = [200, 198, 192];
export const OWNER_LAND = 254;
export const OWNER_UNKNOWN = 255;

type RGB = [number, number, number];

function hsl(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Цвет державы по её индексу: оттенки расходятся по золотому углу; держава игрока — насыщеннее. */
export function ownerColor(index: number, player: boolean): RGB {
  return player ? hsl(38, 0.62, 0.66) : hsl((200 + index * 137.5) % 360, 0.3, 0.74);
}

/** Палитра владельцев: один тексель на индекс державы. */
export function palette(states: number, player: number): Uint8Array {
  const px = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = i === OWNER_LAND ? LAND : i < states ? ownerColor(i, i === player) : UNKNOWN;
    px.set([c[0], c[1], c[2], 255], i * 4);
  }
  return px;
}

export const css = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
