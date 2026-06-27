import { create } from 'zustand'
import { DEFAULT_INPUTS, type Inputs } from '../lib/calc'
import * as storage from '../lib/storage'
import type { Scenario, LineItem } from '../lib/storage'

const sumAmounts = (items: LineItem[]): number => items.reduce((s, i) => s + (i.amount || 0), 0)
const nowISO = () => new Date().toISOString()

// Session-unique id — Date.now() alone collides when you save then immediately
// duplicate within the same millisecond, so append a monotonic counter.
let idSeq = 0
const newId = () => `${Date.now().toString(36)}${(idSeq++).toString(36)}`

// Are two input sets identical across every known field? Used to decide whether a
// returning user's old session is worth carrying over as a draft.
const sameInputs = (a: Inputs, b: Inputs): boolean =>
  (Object.keys(DEFAULT_INPUTS) as (keyof Inputs)[]).every((k) => a[k] === b[k])

// Info captured on delete so the undo toast can restore exactly.
export interface DeletedInfo {
  deleted: Scenario
}

interface AppState {
  inputs: Inputs // the working buffer the calculator edits
  mode: 'draft' | 'bound' // editing the scratch draft, or a saved scenario (auto-saved)
  activeScenarioId: string | null
  scenarios: Scenario[]
  draftInputs: Inputs | null // the persisted scratch draft (null = none in progress)
  hydrated: boolean
  // Phase 7 — driftkostnad breakdown + savings line items (session-level, not
  // per-scenario). Drift amounts are monthly; the yearly flag is a view toggle.
  driftItems: LineItem[]
  driftYearly: boolean
  savingsItems: LineItem[]

  setField: <K extends keyof Inputs>(key: K, value: Inputs[K]) => void
  hydrate: () => Promise<void>
  openScenario: (id: string) => boolean
  openDraft: () => void
  saveDraftAsScenario: (name: string) => string
  renameScenario: (id: string, name: string) => void
  duplicateScenario: (id: string) => string | null
  deleteScenario: (id: string) => DeletedInfo | null
  restoreScenario: (info: DeletedInfo) => void
  discardDraft: () => void
  setDriftItems: (items: LineItem[]) => void
  applyDriftItems: (items: LineItem[]) => void
  setDriftYearly: (yearly: boolean) => void
  setSavingsItems: (items: LineItem[]) => void
}

export const useStore = create<AppState>((set, get) => ({
  inputs: DEFAULT_INPUTS,
  mode: 'draft',
  activeScenarioId: null,
  scenarios: [],
  draftInputs: null,
  hydrated: false,
  driftItems: [],
  driftYearly: false,
  savingsItems: [],

  // Every edit auto-saves: into the active scenario (bound) or the scratch draft.
  setField: (key, value) => {
    const s = get()
    const inputs = { ...s.inputs, [key]: value }
    if (s.mode === 'bound' && s.activeScenarioId) {
      const scenarios = s.scenarios.map((sc) =>
        sc.id === s.activeScenarioId ? { ...sc, inputs, savedAt: nowISO() } : sc,
      )
      set({ inputs, scenarios })
      storage.saveScenarios(scenarios)
    } else {
      set({ inputs, draftInputs: inputs })
      storage.saveDraft(inputs)
    }
  },

  hydrate: async () => {
    if (get().hydrated) return
    storage.runMigrations()
    const [scenarios, draft, driftItems, savingsItems, driftYearly, session] = await Promise.all([
      storage.loadScenarios(),
      storage.loadDraft(),
      storage.loadDriftItems(),
      storage.loadSavingsItems(),
      storage.loadDriftYearly(),
      storage.loadSession(),
    ])
    // One-time carry-over: a returning user's unsaved (non-default) session
    // becomes the scratch draft so their in-progress calc isn't lost. The legacy
    // session key is then retired so a discarded draft won't regenerate from it.
    let draftInputs = draft
    if (!draftInputs && session?.inputs) {
      const merged = { ...DEFAULT_INPUTS, ...session.inputs }
      if (!sameInputs(merged, DEFAULT_INPUTS)) {
        draftInputs = merged
        storage.saveDraft(merged)
      }
    }
    if (session) storage.clearSession()
    set({ scenarios, draftInputs: draftInputs ?? null, driftItems, savingsItems, driftYearly, hydrated: true })
  },

  openScenario: (id) => {
    const sc = get().scenarios.find((x) => x.id === id)
    if (!sc) return false
    set({ inputs: { ...DEFAULT_INPUTS, ...sc.inputs }, mode: 'bound', activeScenarioId: id })
    return true
  },

  openDraft: () => {
    const d = get().draftInputs
    set({
      inputs: d ? { ...DEFAULT_INPUTS, ...d } : { ...DEFAULT_INPUTS },
      mode: 'draft',
      activeScenarioId: null,
    })
  },

  saveDraftAsScenario: (name) => {
    const inputs = get().inputs
    const scenario: Scenario = {
      id: newId(),
      name: name.trim() || 'Unnamed scenario',
      savedAt: nowISO(),
      inputs,
    }
    const scenarios = [...get().scenarios, scenario]
    set({ scenarios, mode: 'bound', activeScenarioId: scenario.id, draftInputs: null })
    storage.saveScenarios(scenarios)
    storage.clearDraft()
    return scenario.id
  },

  renameScenario: (id, name) => {
    const scenarios = get().scenarios.map((s) => (s.id === id ? { ...s, name } : s))
    set({ scenarios })
    storage.saveScenarios(scenarios)
  },

  duplicateScenario: (id) => {
    const s = get().scenarios.find((x) => x.id === id)
    if (!s) return null
    const copy: Scenario = {
      id: newId(),
      name: `${s.name} (copy)`,
      savedAt: nowISO(),
      inputs: { ...s.inputs },
    }
    const scenarios = [...get().scenarios, copy]
    set({ scenarios })
    storage.saveScenarios(scenarios)
    return copy.id
  },

  deleteScenario: (id) => {
    const deleted = get().scenarios.find((s) => s.id === id)
    if (!deleted) return null
    const remaining = get().scenarios.filter((s) => s.id !== id)
    set({ scenarios: remaining })
    storage.saveScenarios(remaining)
    return { deleted }
  },

  restoreScenario: ({ deleted }) => {
    const scenarios = [...get().scenarios, deleted]
    set({ scenarios })
    storage.saveScenarios(scenarios)
  },

  discardDraft: () => {
    set({ draftInputs: null })
    storage.clearDraft()
  },

  // Persist only — label edits + adding a (zero) item must NOT touch
  // driftkostnad (matches legacy: add/label → saveDriftItems, no apply).
  setDriftItems: (items) => {
    set({ driftItems: items })
    storage.saveDriftItems(items)
  },

  // Apply — amount edits + removes write the monthly sum into driftkostnad
  // (incl. 0, so clearing items doesn't leave a stale value).
  applyDriftItems: (items) => {
    set({ driftItems: items })
    storage.saveDriftItems(items)
    get().setField('driftkostnad', sumAmounts(items))
  },

  setDriftYearly: (yearly) => {
    set({ driftYearly: yearly })
    storage.saveDriftYearly(yearly)
  },

  setSavingsItems: (items) => {
    set({ savingsItems: items })
    storage.saveSavingsItems(items)
  },
}))
