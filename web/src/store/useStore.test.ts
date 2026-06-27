import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from './useStore'
import { DEFAULT_INPUTS } from '../lib/calc'

beforeEach(() => {
  useStore.setState({
    inputs: { ...DEFAULT_INPUTS },
    mode: 'draft',
    activeScenarioId: null,
    scenarios: [],
    draftInputs: null,
    driftItems: [],
    driftYearly: false,
    savingsItems: [],
  })
})

describe('drift breakdown → driftkostnad', () => {
  it('applyDriftItems writes the monthly sum into driftkostnad', () => {
    useStore.getState().applyDriftItems([
      { id: 'a', label: 'Electricity', amount: 1200 },
      { id: 'b', label: 'Water', amount: 800 },
    ])
    expect(useStore.getState().inputs.driftkostnad).toBe(2000)
    expect(useStore.getState().driftItems).toHaveLength(2)
  })

  it('setDriftItems persists WITHOUT touching driftkostnad (anti-clobber on add/label)', () => {
    const before = useStore.getState().inputs.driftkostnad // 3000 default
    useStore.getState().setDriftItems([{ id: 'a', label: 'Electricity', amount: 0 }])
    expect(useStore.getState().inputs.driftkostnad).toBe(before)
    expect(useStore.getState().driftItems).toHaveLength(1)
  })

  it('clearing all items via apply zeroes driftkostnad (no stale value)', () => {
    useStore.getState().applyDriftItems([])
    expect(useStore.getState().inputs.driftkostnad).toBe(0)
  })
})

describe('scenarios — hybrid save model', () => {
  it('saveDraftAsScenario turns the draft into a bound, auto-saving scenario', () => {
    useStore.setState({ inputs: { ...DEFAULT_INPUTS, newPrice: 7_000_000 }, mode: 'draft', draftInputs: { ...DEFAULT_INPUTS, newPrice: 7_000_000 } })
    const id = useStore.getState().saveDraftAsScenario('Lidingö')
    const s = useStore.getState()
    expect(s.scenarios).toHaveLength(1)
    expect(s.scenarios[0].name).toBe('Lidingö')
    expect(s.scenarios[0].inputs.newPrice).toBe(7_000_000)
    expect(s.mode).toBe('bound')
    expect(s.activeScenarioId).toBe(id)
    expect(s.draftInputs).toBeNull()
  })

  it('setField auto-saves into the active scenario when bound', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    useStore.getState().setField('newPrice', 8_000_000)
    const s = useStore.getState()
    expect(s.inputs.newPrice).toBe(8_000_000)
    expect(s.scenarios.find((x) => x.id === id)!.inputs.newPrice).toBe(8_000_000)
  })

  it('setField writes to the draft (not any scenario) when in draft mode', () => {
    useStore.getState().setField('deposit', 999_000)
    const s = useStore.getState()
    expect(s.draftInputs?.deposit).toBe(999_000)
    expect(s.scenarios).toHaveLength(0)
  })

  it('openScenario binds and loads inputs; an unknown id returns false', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    useStore.setState({ inputs: { ...DEFAULT_INPUTS }, mode: 'draft', activeScenarioId: null })
    expect(useStore.getState().openScenario(id)).toBe(true)
    expect(useStore.getState().mode).toBe('bound')
    expect(useStore.getState().activeScenarioId).toBe(id)
    expect(useStore.getState().openScenario('does-not-exist')).toBe(false)
  })

  it('duplicateScenario returns a fresh id and adds a copy', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    const copyId = useStore.getState().duplicateScenario(id)
    expect(copyId).not.toBeNull()
    expect(copyId).not.toBe(id)
    expect(useStore.getState().scenarios).toHaveLength(2)
  })

  it('delete + restore round-trips a scenario', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    const info = useStore.getState().deleteScenario(id)
    expect(info).not.toBeNull()
    expect(useStore.getState().scenarios).toHaveLength(0)
    useStore.getState().restoreScenario(info!)
    expect(useStore.getState().scenarios).toHaveLength(1)
  })

  it('discardDraft clears the scratch draft', () => {
    useStore.setState({ draftInputs: { ...DEFAULT_INPUTS } })
    useStore.getState().discardDraft()
    expect(useStore.getState().draftInputs).toBeNull()
  })
})

describe('savings entries', () => {
  it('setSavingsItems stores the entries (their total augments the P&L)', () => {
    useStore.getState().setSavingsItems([
      { id: 's1', label: 'Buffer', amount: 50_000 },
      { id: 's2', label: 'ISK', amount: 25_000 },
    ])
    const total = useStore.getState().savingsItems.reduce((s, i) => s + i.amount, 0)
    expect(total).toBe(75_000)
  })
})
