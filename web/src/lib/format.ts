// sv-SE money / number formatters — ported verbatim from calc.js.
// Kept separate from calc.ts so the math layer returns numbers only.

/** Rounded SEK with a trailing " kr", sv-SE grouping. */
export function fmt(n: number): string {
  return Math.round(n).toLocaleString('sv-SE') + ' kr'
}

/** One-decimal percent, e.g. 10 → "10.0%". */
export function pct(n: number): string {
  return n.toFixed(1) + '%'
}

/** Rounded integer with space thousands separators, e.g. 5850000 → "5 850 000". */
export function formatWithSpaces(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Parse a user-entered value: strip spaces, treat comma as decimal, NaN → 0. */
export function parseFormatted(str: string | number): number {
  return parseFloat(String(str).replace(/\s/g, '').replace(/,/g, '.')) || 0
}
