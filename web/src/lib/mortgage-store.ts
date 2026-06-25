// mortgage-store.ts — localStorage persistence for Bolånekoll.
// TypeScript port of mortgagetracker-store.js. Reads/writes the same key so
// data from the vanilla app migrates automatically.

import { defaultSettings, makeRatePeriod } from './mortgage'
import type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping } from './mortgage'

export const STORAGE_KEY = 'bostadskalkyl_mortgage_v1'
const VERSION = 4

interface StoreEnvelope {
  version: number
  loan_parts: LoanPart[]
  payments: Payment[]
  valuations: Valuation[]
  rate_periods: RatePeriod[]
  contributions: Contribution[]
  settings: MortgageSettings
}

function genId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof (crypto as Crypto).randomUUID === 'function')
    return (crypto as Crypto).randomUUID()
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function dayBefore(iso: string): string | null {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() - 1)
  const p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function stamp<T extends object>(record: T, prefix: string): T & { id: string; created_at: string } {
  const r = record as Record<string, unknown>
  return { ...record, id: (r.id as string) || genId(prefix), created_at: (r.created_at as string) || new Date().toISOString() } as T & { id: string; created_at: string }
}

function byDateDesc<T extends { date?: string; created_at?: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''))
    return d !== 0 ? d : String(b.created_at || '').localeCompare(String(a.created_at || ''))
  })
}

function migrateToPeriods(out: StoreEnvelope, raw: Record<string, unknown>): void {
  if (out.rate_periods.length) return
  const oldChanges = Array.isArray(raw.rate_changes) ? (raw.rate_changes as Array<Record<string, unknown>>) : []
  const periods: RatePeriod[] = []
  for (const p of out.loan_parts) {
    if (!p) continue
    const pr = p as LoanPart & Record<string, unknown>
    const seeds: Array<{ start_date: string; rate: number; rate_type: 'rörlig' | 'bunden'; end_date: string | null }> = []
    if (pr.interest_rate != null && pr.interest_rate !== '') {
      seeds.push({
        start_date: String(p.start_date || ''), rate: Number(pr.interest_rate),
        rate_type: pr.rate_type === 'bunden' ? 'bunden' : 'rörlig',
        end_date: (pr.rate_type === 'bunden' && pr.rate_binding_until) ? String(pr.rate_binding_until) : null,
      })
    }
    for (const r of oldChanges.filter(r => r && r.loan_part_id === p.id))
      seeds.push({ start_date: String(r.date || ''), rate: Number(r.rate), rate_type: 'rörlig', end_date: null })
    seeds.sort((a, b) => a.start_date.localeCompare(b.start_date))
    seeds.forEach((s, i) => {
      const next = seeds[i + 1]
      if (s.end_date == null && next?.start_date) s.end_date = dayBefore(next.start_date)
      periods.push(stamp({ ...makeRatePeriod(s), loan_part_id: p.id }, 'rate') as RatePeriod)
    })
    delete (pr as Record<string, unknown>).interest_rate
    delete (pr as Record<string, unknown>).rate_type
    delete (pr as Record<string, unknown>).rate_binding_until
  }
  out.rate_periods = periods
}

function read(): StoreEnvelope {
  const empty: StoreEnvelope = { version: VERSION, loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [], settings: defaultSettings() }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const data = JSON.parse(raw) as Record<string, unknown>
    if (!data || typeof data !== 'object') return empty
    const out: StoreEnvelope = {
      version: VERSION,
      loan_parts: Array.isArray(data.loan_parts) ? (data.loan_parts as LoanPart[]) : [],
      payments: Array.isArray(data.payments) ? (data.payments as Payment[]) : [],
      valuations: Array.isArray(data.valuations) ? (data.valuations as Valuation[]) : [],
      rate_periods: Array.isArray(data.rate_periods) ? (data.rate_periods as RatePeriod[]) : [],
      contributions: Array.isArray(data.contributions) ? (data.contributions as Contribution[]) : [],
      settings: { ...defaultSettings(), ...(data.settings as Partial<MortgageSettings> || {}) },
    }
    if ((Number(data.version) || 1) < 4) { migrateToPeriods(out, data); write(out) }
    return out
  } catch { return empty }
}

function write(data: StoreEnvelope): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)) } catch { /* ignore quota errors */ }
}

// ── Loan parts ─────────────────────────────────────────────────────────────

export function listLoanParts(): Promise<LoanPart[]> { return Promise.resolve(read().loan_parts.slice()) }

export function addLoanPart(record: Omit<LoanPart, 'id' | 'created_at'>): Promise<LoanPart> {
  const saved = stamp(record, 'part') as LoanPart
  const data = read(); data.loan_parts.push(saved); write(data)
  return Promise.resolve(saved)
}

export function updateLoanPart(id: string, patch: Partial<LoanPart>): Promise<LoanPart | null> {
  const data = read(); let found: LoanPart | null = null
  data.loan_parts = data.loan_parts.map(p => { if (p?.id === id) { found = { ...p, ...patch }; return found } return p })
  write(data); return Promise.resolve(found)
}

export function removeLoanPart(id: string): Promise<number> {
  const data = read()
  data.loan_parts = data.loan_parts.filter(p => p?.id !== id)
  data.payments = data.payments.filter(p => !(p?.loan_part_id === id))
  data.rate_periods = data.rate_periods.filter(r => !(r?.loan_part_id === id))
  write(data); return Promise.resolve(data.loan_parts.length)
}

// ── Payments ───────────────────────────────────────────────────────────────

export function listPayments(): Promise<Payment[]> { return Promise.resolve(byDateDesc(read().payments)) }

export function addPayment(record: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const saved = stamp(record, 'pay') as Payment
  const data = read(); data.payments.push(saved); write(data)
  return Promise.resolve(saved)
}

export function addPayments(records: Array<Omit<Payment, 'id' | 'created_at'>>): Promise<Payment[]> {
  const data = read()
  const saved = records.map(r => stamp(r, 'pay') as Payment)
  data.payments = data.payments.concat(saved); write(data)
  return Promise.resolve(saved)
}

export function updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null> {
  const data = read(); let found: Payment | null = null
  data.payments = data.payments.map(p => { if (p?.id === id) { found = { ...p, ...patch }; return found } return p })
  write(data); return Promise.resolve(found)
}

export function removePayment(id: string): Promise<number> {
  const data = read()
  data.payments = data.payments.filter(p => p?.id !== id)
  write(data); return Promise.resolve(data.payments.length)
}

export function removePayments(ids: string[]): Promise<number> {
  const drop = new Set(ids)
  const data = read(); const before = data.payments.length
  data.payments = data.payments.filter(p => !(p && drop.has(p.id)))
  write(data); return Promise.resolve(before - data.payments.length)
}

// ── Valuations ─────────────────────────────────────────────────────────────

export function listValuations(): Promise<Valuation[]> { return Promise.resolve(byDateDesc(read().valuations)) }

export function addValuation(record: Omit<Valuation, 'id' | 'created_at'>): Promise<Valuation> {
  const saved = stamp(record, 'val') as Valuation
  const data = read(); data.valuations.push(saved); write(data)
  return Promise.resolve(saved)
}

export function updateValuation(id: string, patch: Partial<Valuation>): Promise<Valuation | null> {
  const data = read(); let found: Valuation | null = null
  data.valuations = data.valuations.map(v => { if (v?.id === id) { found = { ...v, ...patch }; return found } return v })
  write(data); return Promise.resolve(found)
}

export function removeValuation(id: string): Promise<number> {
  const data = read()
  data.valuations = data.valuations.filter(v => v?.id !== id)
  write(data); return Promise.resolve(data.valuations.length)
}

// ── Rate periods ───────────────────────────────────────────────────────────

export function listRatePeriods(): Promise<RatePeriod[]> {
  return Promise.resolve(read().rate_periods.slice().sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))))
}

export function addRatePeriod(record: Omit<RatePeriod, 'id' | 'created_at'>): Promise<RatePeriod> {
  const saved = stamp(record, 'rate') as RatePeriod
  const data = read(); data.rate_periods.push(saved); write(data)
  return Promise.resolve(saved)
}

export function updateRatePeriod(id: string, patch: Partial<RatePeriod>): Promise<RatePeriod | null> {
  const data = read(); let found: RatePeriod | null = null
  data.rate_periods = data.rate_periods.map(r => { if (r?.id === id) { found = { ...r, ...patch }; return found } return r })
  write(data); return Promise.resolve(found)
}

export function removeRatePeriod(id: string): Promise<number> {
  const data = read()
  data.rate_periods = data.rate_periods.filter(r => r?.id !== id)
  write(data); return Promise.resolve(data.rate_periods.length)
}

// ── Contributions ──────────────────────────────────────────────────────────

export function listContributions(): Promise<Contribution[]> { return Promise.resolve(byDateDesc(read().contributions)) }

export function addContribution(record: Omit<Contribution, 'id' | 'created_at'>): Promise<Contribution> {
  const saved = stamp(record, 'contrib') as Contribution
  const data = read(); data.contributions.push(saved); write(data)
  return Promise.resolve(saved)
}

export function updateContribution(id: string, patch: Partial<Contribution>): Promise<Contribution | null> {
  const data = read(); let found: Contribution | null = null
  data.contributions = data.contributions.map(c => { if (c?.id === id) { found = { ...c, ...patch }; return found } return c })
  write(data); return Promise.resolve(found)
}

export function removeContribution(id: string): Promise<number> {
  const data = read()
  data.contributions = data.contributions.filter(c => c?.id !== id)
  write(data); return Promise.resolve(data.contributions.length)
}

// ── Settings ───────────────────────────────────────────────────────────────

export function getSettings(): Promise<MortgageSettings> { return Promise.resolve(read().settings) }

export function saveSettings(patch: Partial<MortgageSettings>): Promise<MortgageSettings> {
  const data = read()
  data.settings = { ...defaultSettings(), ...data.settings, ...patch }
  write(data); return Promise.resolve(data.settings)
}

// ── Backup / restore ───────────────────────────────────────────────────────

export function exportJSON(): Promise<string> {
  const data = read()
  return Promise.resolve(JSON.stringify({ version: VERSION, loan_parts: data.loan_parts, payments: byDateDesc(data.payments), valuations: byDateDesc(data.valuations), rate_periods: data.rate_periods, contributions: byDateDesc(data.contributions), settings: data.settings }, null, 2))
}

export function importJSON(text: string): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(text) } catch { reject(new Error("That file isn't valid JSON.")); return }
    if (!parsed || typeof parsed !== 'object') { reject(new Error('No Bolånekoll data found.')); return }
    if (!parsed.loan_parts && !parsed.payments && !parsed.valuations && !parsed.rate_periods && !parsed.contributions) { reject(new Error('No Bolånekoll data found.')); return }
    const data = read()
    const added: Record<string, number> = { loan_parts: 0, payments: 0, valuations: 0, rate_periods: 0, contributions: 0 }
    function merge<T extends { id?: string; created_at?: string }>(coll: T[], incoming: unknown, prefix: string): number {
      const seen = new Set(coll.map(r => r?.id).filter(Boolean))
      let n = 0
      for (const raw of Array.isArray(incoming) ? incoming : []) {
        if (!raw || typeof raw !== 'object') continue
        const row = { ...raw as T }
        if (!row.id) row.id = genId(prefix) as T['id']
        if (seen.has(row.id)) continue
        if (!row.created_at) row.created_at = new Date().toISOString() as T['created_at']
        seen.add(row.id); coll.push(row); n++
      }
      return n
    }
    added.loan_parts = merge(data.loan_parts, parsed.loan_parts, 'part')
    added.payments = merge(data.payments, parsed.payments, 'pay')
    added.valuations = merge(data.valuations, parsed.valuations, 'val')
    added.rate_periods = merge(data.rate_periods, parsed.rate_periods, 'rate')
    added.contributions = merge(data.contributions, parsed.contributions, 'contrib')
    if (parsed.settings && typeof parsed.settings === 'object')
      data.settings = { ...defaultSettings(), ...data.settings, ...(parsed.settings as Partial<MortgageSettings>) }
    write(data); resolve(added)
  })
}

// ── Re-export types for callers that only import from the store ────────────
export type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping }
