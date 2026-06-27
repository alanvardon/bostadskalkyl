// Pure list operations for the scenarios dashboard — kept out of the component
// so the sort/filter logic is unit-testable under the node test env (the React
// layer has no jsdom/RTL). Both return a NEW array and never mutate the input.

import { derive, type Constants } from './calc'
import type { Scenario } from './storage'

export type SortKey = 'recent' | 'name' | 'price' | 'monthly'

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'recent', label: 'Recently saved' },
  { key: 'name', label: 'Name' },
  { key: 'price', label: 'Price' },
  { key: 'monthly', label: 'Monthly cost' },
]

/** Case-insensitive filter by name. Blank query → every scenario (a fresh copy). */
export function filterScenarios(scenarios: Scenario[], query: string): Scenario[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...scenarios]
  return scenarios.filter((s) => (s.name || 'Untitled').toLowerCase().includes(q))
}

/**
 * Non-mutating sort. `recent` = newest `savedAt` first (the previous default),
 * `name` A→Z (sv collation), `price`/`monthly` high→low. The money keys derive
 * each scenario with its own constants, falling back to the global defaults for
 * scenarios saved before per-scenario constants existed.
 */
export function sortScenarios(scenarios: Scenario[], key: SortKey, fallback: Constants): Scenario[] {
  const out = [...scenarios]
  switch (key) {
    case 'name':
      return out.sort((a, b) => (a.name || 'Untitled').localeCompare(b.name || 'Untitled', 'sv'))
    case 'price':
      return out.sort((a, b) => (b.inputs.newPrice || 0) - (a.inputs.newPrice || 0))
    case 'monthly':
      return out.sort(
        (a, b) =>
          derive(b.inputs, b.constants ?? fallback).totalMonthly -
          derive(a.inputs, a.constants ?? fallback).totalMonthly,
      )
    case 'recent':
    default:
      return out.sort((a, b) => +new Date(b.savedAt) - +new Date(a.savedAt))
  }
}
