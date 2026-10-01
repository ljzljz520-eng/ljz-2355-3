// 颜色解析、混合、相对亮度与 WCAG 对比度。
// 支持: #rgb / #rrggbb / rgb()/rgba() / 具名基础色。返回 null 表示非法颜色。

const NAMED = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 1, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 }
};

export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s in NAMED) return { ...NAMED[s] };
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
      a: 1
    };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if ([r, g, b].some((v) => v < 0 || v > 255) || a < 0 || a > 1) return null;
    return { r, g, b, a };
  }
  return null;
}

export function isValidColor(v) {
  return parseColor(v) !== null;
}

// 在 backdrop 上合成半透明前景；两者 alpha=1 时直接返回前景。
export function flatten(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg) ?? { r: 255, g: 255, b: 255, a: 1 };
  if (!f) return null;
  if (f.a === 1) return { ...f };
  const a = f.a + b.a * (1 - f.a);
  if (a === 0) return { r: 255, g: 255, b: 255, a: 0 };
  const mix = (x, y) => Math.round((f.a * x + (1 - f.a) * b.a * y) / a);
  return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a };
}

function channel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(c) {
  const col = parseColor(c) ?? c;
  if (!col || typeof col === 'string') return 0;
  return 0.2126 * channel(col.r) + 0.7152 * channel(col.g) + 0.0722 * channel(col.b);
}

// WCAG 2.x 对比度。fg/bg 均可含 alpha（fg 会先在 bg 上合成）。
export function contrastRatio(fg, bg) {
  const front = flatten(fg, bg);
  const back = parseColor(bg);
  if (!front || !back) return null;
  const l1 = relativeLuminance(front);
  const l2 = relativeLuminance(back);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export function isLargeText(token) {
  const fontSizePx = token?.type === 'fontSize' ? Number(token.value) : NaN;
  const weight = Number(token?.meta?.fontWeight ?? 400);
  if (!Number.isFinite(fontSizePx)) return false;
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && weight >= 700);
}

// WCAG AA：普通文本 4.5，大号文本 3.0；UI 图形/图标按 3.0。
export function meetsAA(ratio, { large = false, ui = false } = {}) {
  if (typeof ratio !== 'number') return false;
  return ratio >= (large ? 3 : 4.5) || (ui && ratio >= 3);
}

export function toHex(c) {
  const col = parseColor(c) ?? c;
  if (!col || typeof col === 'string') return null;
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(col.r)}${h(col.g)}${h(col.b)}`;
}
