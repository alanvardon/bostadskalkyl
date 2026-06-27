import { describe, it, expect } from 'vitest'
import { DEFAULT_INPUTS, DEFAULT_CONSTANTS, type Inputs } from './calc'
import type { Scenario } from './storage'
import { sortScenarios, filterScenarios } from './scenarioList'

const make = (id: string, name: string, savedAt: string, over: Partial<Inputs> = {}): Scenario => ({
  id,
  name,
  savedAt,
  inputs: { ...DEFAULT_INPUTS, ...over },
})

// Cheaper (lower newPrice/loan → lower monthly) vs pricier, plus distinct names
// and save times so each sort key has an unambiguous order.
const cheap = make('a', 'Villa', '2026-06-01T00:00:00Z', { newPrice: 3_000_000, deposit: 600_000 })
const mid = make('b', 'Apartment', '2026-06-10T00:00:00Z', { newPrice: 5_000_000, deposit: 750_000 })
const dear = make('c', 'Townhouse', '2026-06-05T00:00:00Z', { newPrice: 8_000_000, deposit: 1_000_000 })
const all = [cheap, mid, dear]

const ids = (xs: Scenario[]) => xs.map((s) => s.id)

describe('sortScenarios', () => {
  it('recent → newest savedAt first', () => {
    expect(ids(sortScenarios(all, 'recent', DEFAULT_CONSTANTS))).toEqual(['b', 'c', 'a'])
  })
  it('name → A→Z (sv collation)', () => {
    expect(ids(sortScenarios(all, 'name', DEFAULT_CONSTANTS))).toEqual(['b', 'c', 'a'])
  })
  it('price → high→low', () => {
    expect(ids(sortScenarios(all, 'price', DEFAULT_CONSTANTS))).toEqual(['c', 'b', 'a'])
  })
  it('monthly → high→low', () => {
    expect(ids(sortScenarios(all, 'monthly', DEFAULT_CONSTANTS))).toEqual(['c', 'b', 'a'])
  })
  it('does not mutate the input array', () => {
    const input = [...all]
    sortScenarios(input, 'price', DEFAULT_CONSTANTS)
    expect(ids(input)).toEqual(['a', 'b', 'c'])
  })
})

describe('filterScenarios', () => {
  it('blank query → all (fresh array)', () => {
    const out = filterScenarios(all, '   ')
    expect(ids(out)).toEqual(['a', 'b', 'c'])
    expect(out).not.toBe(all)
  })
  it('matches case-insensitively by name', () => {
    expect(ids(filterScenarios(all, 'TOWN'))).toEqual(['c'])
  })
  it('no match → empty', () => {
    expect(filterScenarios(all, 'zzz')).toEqual([])
  })
})
