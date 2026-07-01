// Shared date helpers — kept apart from the tool-specific math libs.

/** Today's local date as YYYY-MM-DD. */
export function todayISO(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
