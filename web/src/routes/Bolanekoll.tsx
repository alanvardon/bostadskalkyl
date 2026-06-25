import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Chart from 'chart.js/auto'
import { useTheme } from '../App'
import {
  defaultSettings, parseCsv, parseAmount, autoMapColumns,
  makeLoanPart, makePayment, flagDuplicates, assignPaymentsToPart,
  partBalance, partAmortized, totalBalance, totalAmortized,
  propertyValue, equity, loanToValue, ownerSplit, ownerPercents,
  effectiveRate, bindingStatus, weightedAvgRate, derivedRate, amorteringskravStatus,
  equityTimeline, equityBridge, projectMilestones, monthlyCost,
  paymentsToCsv, headerSignature, mappingToNames, applyPreset, reconcileBalance,
  contributionSplit, settlement, todayISO, normPaidBy,
} from '../lib/mortgage'
import type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, CsvResult, ColMapping } from '../lib/mortgage'
import * as Store from '../lib/mortgage-store'

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtCur(n: number, currency = 'SEK'): string {
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
}
function fmtPct(n: number, dec = 2): string { return n.toFixed(dec).replace('.', ',') + ' %' }
function fmtNum(n: number): string { return new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(n) }

const KIND_LABELS: Record<string, string> = { interest: 'Ränta', amortization: 'Amortering', payment: 'Betalning', loan: 'Lån', fee: 'Avgift', other: 'Övrigt' }

function monthsLabel(m: number | null): string {
  if (m == null) return '—'
  const y = Math.floor(m / 12), mo = m % 12
  if (y === 0) return mo + ' mån'
  if (mo === 0) return y + ' år'
  return y + ' år ' + mo + ' mån'
}

function isoMonthsAgo(n: number): string {
  const d = new Date(); d.setMonth(d.getMonth() - n)
  return d.toISOString().split('T')[0]
}

// ── Sub-types ──────────────────────────────────────────────────────────────

interface TriageRow { action: 'import' | 'skip' | 'dup'; loan_part_id: string | null; data: Omit<Payment, 'id' | 'created_at'> }
interface ImportCfg { file: File; parsed: CsvResult; mapping: ColMapping; triage: TriageRow[]; queue: File[]; qIdx: number }

// ── PeriodDialog ───────────────────────────────────────────────────────────

interface PeriodDlgProps {
  open: boolean; partId: string | null; id: string | null
  periods: RatePeriod[]
  onSave: (data: Omit<RatePeriod, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void
  onClose: () => void
}
function PeriodDialog({ open, partId, id, periods, onSave, onDelete, onClose }: PeriodDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { open ? ref.current?.showModal() : ref.current?.close() }, [open])
  const rec = id ? periods.find(p => p.id === id) : null
  const [form, setForm] = useState({ start_date: '', end_date: '', rate: '', rate_type: 'rörlig' as 'rörlig' | 'bunden' })
  useEffect(() => {
    if (open) setForm({ start_date: rec?.start_date || todayISO(), end_date: rec?.end_date || '', rate: rec?.rate != null ? String(rec.rate) : '', rate_type: rec?.rate_type || 'rörlig' })
  }, [open, id])
  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(p => ({ ...p, [k]: e.target.value }))
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave({ loan_part_id: partId, start_date: form.start_date, end_date: form.rate_type === 'bunden' && form.end_date ? form.end_date : null, rate: form.rate ? Number(form.rate) : null, rate_type: form.rate_type })
  }
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="bk-dialog-inner" onSubmit={submit}>
        <div className="bk-dialog-head"><h3>{id ? 'Ändra ränteperiod' : 'Lägg till ränteperiod'}</h3><button type="button" className="bk-icon-btn" onClick={onClose}>✕</button></div>
        <div className="bk-form-grid">
          <div className="bk-form-field">
            <label>Startdatum</label>
            <input type="date" value={form.start_date} onChange={f('start_date')} required />
          </div>
          <div className="bk-form-field">
            <label>Ränta (%)</label>
            <input type="number" step="0.001" min="0" max="30" placeholder="3,500" value={form.rate} onChange={f('rate')} required />
          </div>
          <div className="bk-form-field">
            <label>Typ</label>
            <select value={form.rate_type} onChange={f('rate_type')} className="bk-select">
              <option value="rörlig">Rörlig</option>
              <option value="bunden">Bunden</option>
            </select>
          </div>
          {form.rate_type === 'bunden' && (
            <div className="bk-form-field">
              <label>Bindning t.o.m.</label>
              <input type="date" value={form.end_date} onChange={f('end_date')} />
            </div>
          )}
        </div>
        <div className="bk-dialog-foot">
          {id && <button type="button" className="btn bk-btn-danger" onClick={() => { if (confirm('Ta bort ränteperiod?')) onDelete(id) }}>Ta bort</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary">Spara</button>
        </div>
      </form>
    </dialog>
  )
}

// ── PartDialog ─────────────────────────────────────────────────────────────

interface PartDlgProps {
  open: boolean; id: string | null; parts: LoanPart[]; periods: RatePeriod[]; payments: Payment[]
  onSave: (data: Omit<LoanPart, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void
  onClose: () => void
  onSavePeriod: (partId: string, data: Omit<RatePeriod, 'id' | 'created_at'>, existingId?: string) => void
  onDeletePeriod: (id: string) => void
}
function PartDialog({ open, id, parts, periods, payments, onSave, onDelete, onClose, onSavePeriod, onDeletePeriod }: PartDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { open ? ref.current?.showModal() : ref.current?.close() }, [open])
  const rec = id ? parts.find(p => p.id === id) : null
  const [form, setForm] = useState({ label: '', loan_number: '', start_balance: '', start_date: '', archived: false })
  const [periodDlg, setPeriodDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  useEffect(() => {
    if (open) setForm({ label: rec?.label || '', loan_number: rec?.loan_number || '', start_balance: rec?.start_balance ? String(rec.start_balance) : '', start_date: rec?.start_date || todayISO(), archived: rec?.archived || false })
  }, [open, id])
  const myPeriods = periods.filter(p => p.loan_part_id === id).sort((a, b) => b.start_date.localeCompare(a.start_date))
  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave(makeLoanPart({ label: form.label, loan_number: form.loan_number, start_balance: parseAmount(form.start_balance) || 0, start_date: form.start_date, archived: form.archived }))
  }
  const bal = id ? partBalance(rec!, payments) : 0
  const derived = id ? derivedRate(rec!, payments) : null
  return (
    <>
      <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
        <form className="bk-dialog-inner" onSubmit={submit}>
          <div className="bk-dialog-head"><h3>{id ? 'Redigera lånedel' : 'Lägg till lånedel'}</h3><button type="button" className="bk-icon-btn" onClick={onClose}>✕</button></div>
          <div className="bk-form-grid">
            <div className="bk-form-field bk-span2"><label>Benämning</label><input placeholder="Lånedel 1" value={form.label} onChange={f('label')} /></div>
            <div className="bk-form-field"><label>Lånenummer</label><input placeholder="123456789" value={form.loan_number} onChange={f('loan_number')} /></div>
            <div className="bk-form-field"><label>Startbalans (kr)</label><input type="number" step="1" min="0" placeholder="1 000 000" value={form.start_balance} onChange={f('start_balance')} /></div>
            <div className="bk-form-field"><label>Startdatum</label><input type="date" value={form.start_date} onChange={f('start_date')} /></div>
            {id && <div className="bk-form-field"><label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={form.archived} onChange={f('archived')} /> Arkiverad</label></div>}
          </div>
          {id && (
            <div className="bk-part-meta">
              <div className="bk-part-meta-row"><span>Nuvarande skuld</span><strong>{fmtCur(bal)}</strong></div>
              {derived != null && <div className="bk-part-meta-row"><span>Härledd ränta</span><span className="bk-derived">{fmtPct(derived)} (från transaktioner)</span></div>}
              <div className="bk-rate-history-head">
                <span>Ränteperioder</span>
                <button type="button" className="btn btn-ghost bk-btn-sm" onClick={() => setPeriodDlg({ open: true, id: null })}>+ Lägg till</button>
              </div>
              {myPeriods.length ? (
                <ul className="bk-rate-list">
                  {myPeriods.map(p => (
                    <li key={p.id} className="bk-rate-row" onClick={() => setPeriodDlg({ open: true, id: p.id })}>
                      <span className="bk-rate-type">{p.rate_type === 'bunden' ? '🔒' : '~'}</span>
                      <span>{p.rate != null ? fmtPct(p.rate) : '—'}</span>
                      <span className="bk-rate-dates">{p.start_date}{p.end_date ? ' → ' + p.end_date : ' (pågående)'}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="bk-empty-note">Inga ränteperioder — lägg till en ovan.</p>}
            </div>
          )}
          <div className="bk-dialog-foot">
            {id && <button type="button" className="btn bk-btn-danger" onClick={() => { if (confirm('Ta bort lånedel och dess betalningar?')) onDelete(id) }}>Ta bort</button>}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
            <button type="submit" className="btn btn-primary">Spara</button>
          </div>
        </form>
      </dialog>
      <PeriodDialog
        open={periodDlg.open} partId={id} id={periodDlg.id} periods={periods}
        onSave={data => { onSavePeriod(id!, data, periodDlg.id || undefined); setPeriodDlg({ open: false, id: null }) }}
        onDelete={pid => { onDeletePeriod(pid); setPeriodDlg({ open: false, id: null }) }}
        onClose={() => setPeriodDlg({ open: false, id: null })}
      />
    </>
  )
}

// ── ValuationDialog ────────────────────────────────────────────────────────

interface ValDlgProps {
  open: boolean; id: string | null; valuations: Valuation[]
  onSave: (data: Omit<Valuation, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function ValuationDialog({ open, id, valuations, onSave, onDelete, onClose }: ValDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { open ? ref.current?.showModal() : ref.current?.close() }, [open])
  const rec = id ? valuations.find(v => v.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), value: '', note: '' })
  useEffect(() => { if (open) setForm({ date: rec?.date || todayISO(), value: rec?.value ? String(rec.value) : '', note: rec?.note || '' }) }, [open, id])
  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(p => ({ ...p, [k]: e.target.value }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ date: form.date, value: parseAmount(form.value) || 0, note: form.note }) }
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="bk-dialog-inner" onSubmit={submit}>
        <div className="bk-dialog-head"><h3>{id ? 'Ändra värdering' : 'Lägg till värdering'}</h3><button type="button" className="bk-icon-btn" onClick={onClose}>✕</button></div>
        <div className="bk-form-grid">
          <div className="bk-form-field"><label>Datum</label><input type="date" value={form.date} onChange={f('date')} required /></div>
          <div className="bk-form-field"><label>Värde (kr)</label><input type="number" step="1000" min="0" placeholder="4 500 000" value={form.value} onChange={f('value')} required /></div>
          <div className="bk-form-field bk-span2"><label>Notering</label><input placeholder="Hemnet, mäklarvärdering…" value={form.note} onChange={f('note')} /></div>
        </div>
        <div className="bk-dialog-foot">
          {id && <button type="button" className="btn bk-btn-danger" onClick={() => { if (confirm('Ta bort värdering?')) onDelete(id) }}>Ta bort</button>}
          <span style={{ flex: 1 }} /><button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary">Spara</button>
        </div>
      </form>
    </dialog>
  )
}

// ── PaymentDialog ──────────────────────────────────────────────────────────

interface PayDlgProps {
  open: boolean; id: string | null; payments: Payment[]; parts: LoanPart[]; settings: MortgageSettings
  onSave: (data: Omit<Payment, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function PaymentDialog({ open, id, payments, parts, settings, onSave, onDelete, onClose }: PayDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { open ? ref.current?.showModal() : ref.current?.close() }, [open])
  const rec = id ? payments.find(p => p.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), loan_part_id: '', kind: 'amortization', description: '', amount: '', balance_after: '', paid_by: 'joint' })
  useEffect(() => {
    if (open) setForm({ date: rec?.date || todayISO(), loan_part_id: rec?.loan_part_id || (parts[0]?.id || ''), kind: rec?.kind || 'amortization', description: rec?.description || '', amount: rec?.amount ? String(rec.amount) : '', balance_after: rec?.balance_after != null ? String(rec.balance_after) : '', paid_by: rec?.paid_by || 'joint' })
  }, [open, id])
  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(p => ({ ...p, [k]: e.target.value }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave(makePayment({ date: form.date, loan_part_id: form.loan_part_id || null, kind: form.kind as Payment['kind'], description: form.description, amount: parseAmount(form.amount), balance_after: form.balance_after ? parseAmount(form.balance_after) : null, paid_by: normPaidBy(form.paid_by) })) }
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="bk-dialog-inner" onSubmit={submit}>
        <div className="bk-dialog-head"><h3>{id ? 'Ändra transaktion' : 'Lägg till transaktion'}</h3><button type="button" className="bk-icon-btn" onClick={onClose}>✕</button></div>
        <div className="bk-form-grid">
          <div className="bk-form-field"><label>Datum</label><input type="date" value={form.date} onChange={f('date')} required /></div>
          <div className="bk-form-field"><label>Lånedel</label>
            <select value={form.loan_part_id} onChange={f('loan_part_id')} className="bk-select">
              <option value="">— ingen —</option>
              {parts.map(p => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}
            </select>
          </div>
          <div className="bk-form-field"><label>Typ</label>
            <select value={form.kind} onChange={f('kind')} className="bk-select">
              {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="bk-form-field"><label>Belopp (kr)</label><input type="number" step="0.01" min="0" placeholder="5 000" value={form.amount} onChange={f('amount')} required /></div>
          <div className="bk-form-field"><label>Saldo efter (kr)</label><input type="number" step="0.01" min="0" placeholder="980 000" value={form.balance_after} onChange={f('balance_after')} /></div>
          <div className="bk-form-field"><label>Betalad av</label>
            <select value={form.paid_by} onChange={f('paid_by')} className="bk-select">
              <option value="joint">Gemensamt</option>
              <option value="a">{aName}</option>
              <option value="b">{bName}</option>
            </select>
          </div>
          <div className="bk-form-field bk-span2"><label>Beskrivning</label><input value={form.description} onChange={f('description')} /></div>
        </div>
        <div className="bk-dialog-foot">
          {id && <button type="button" className="btn bk-btn-danger" onClick={() => { if (confirm('Ta bort transaktion?')) onDelete(id) }}>Ta bort</button>}
          <span style={{ flex: 1 }} /><button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary">Spara</button>
        </div>
      </form>
    </dialog>
  )
}

// ── ContribDialog ──────────────────────────────────────────────────────────

interface ContDlgProps {
  open: boolean; id: string | null; contributions: Contribution[]; settings: MortgageSettings
  onSave: (data: Omit<Contribution, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function ContribDialog({ open, id, contributions, settings, onSave, onDelete, onClose }: ContDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { open ? ref.current?.showModal() : ref.current?.close() }, [open])
  const rec = id ? contributions.find(c => c.id === id) : null
  const [form, setForm] = useState({ owner: 'a' as 'a' | 'b', date: todayISO(), amount: '', note: '' })
  useEffect(() => { if (open) setForm({ owner: (rec?.owner as 'a' | 'b') || 'a', date: rec?.date || todayISO(), amount: rec?.amount ? String(rec.amount) : '', note: rec?.note || '' }) }, [open, id])
  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm(p => ({ ...p, [k]: e.target.value }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ owner: form.owner, date: form.date, amount: parseAmount(form.amount) || 0, note: form.note }) }
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="bk-dialog-inner" onSubmit={submit}>
        <div className="bk-dialog-head"><h3>{id ? 'Ändra insats' : 'Lägg till insats'}</h3><button type="button" className="bk-icon-btn" onClick={onClose}>✕</button></div>
        <div className="bk-form-grid">
          <div className="bk-form-field"><label>Ägare</label>
            <select value={form.owner} onChange={f('owner')} className="bk-select">
              <option value="a">{aName}</option>
              <option value="b">{bName}</option>
            </select>
          </div>
          <div className="bk-form-field"><label>Datum</label><input type="date" value={form.date} onChange={f('date')} required /></div>
          <div className="bk-form-field"><label>Belopp (kr)</label><input type="number" step="1" min="0" placeholder="100 000" value={form.amount} onChange={f('amount')} required /></div>
          <div className="bk-form-field bk-span2"><label>Notering</label><input value={form.note} onChange={f('note')} /></div>
        </div>
        <div className="bk-dialog-foot">
          {id && <button type="button" className="btn bk-btn-danger" onClick={() => { if (confirm('Ta bort insats?')) onDelete(id) }}>Ta bort</button>}
          <span style={{ flex: 1 }} /><button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary">Spara</button>
        </div>
      </form>
    </dialog>
  )
}

// ── SettingsDialog ─────────────────────────────────────────────────────────

interface SetDlgProps { open: boolean; settings: MortgageSettings; onSave: (patch: Partial<MortgageSettings>) => void; onClose: () => void }
function SettingsDialog({ open, settings, onSave, onClose }: SetDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { open ? ref.current?.showModal() : ref.current?.close() }, [open])
  const [form, setForm] = useState({ ...settings })
  useEffect(() => { if (open) setForm({ ...settings }) }, [open])
  const f = (k: keyof MortgageSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value
    setForm(p => ({ ...p, [k]: v }))
  }
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ ...form, my_ownership_pct: Number(form.my_ownership_pct), household_income_yearly: form.household_income_yearly ? Number(form.household_income_yearly) : null }) }
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="bk-dialog-inner" onSubmit={submit}>
        <div className="bk-dialog-head"><h3>Inställningar</h3><button type="button" className="bk-icon-btn" onClick={onClose}>✕</button></div>
        <div className="bk-form-grid">
          <div className="bk-form-field bk-span2"><label>Fastighetsnamn</label><input value={form.property_name} onChange={f('property_name')} placeholder="Hemma" /></div>
          <div className="bk-form-field"><label>Ägare A namn</label><input value={form.owner_a_name} onChange={f('owner_a_name')} /></div>
          <div className="bk-form-field"><label>Ägare B namn</label><input value={form.owner_b_name} onChange={f('owner_b_name')} /></div>
          <div className="bk-form-field"><label>Min ägarandel (%)</label><input type="number" min="0" max="100" step="0.1" value={form.my_ownership_pct} onChange={f('my_ownership_pct')} /></div>
          <div className="bk-form-field"><label>Jag är</label>
            <select value={form.i_am} onChange={f('i_am')} className="bk-select">
              <option value="a">{form.owner_a_name || 'Ägare A'}</option>
              <option value="b">{form.owner_b_name || 'Ägare B'}</option>
            </select>
          </div>
          <div className="bk-form-field"><label>Hushållsinkomst (kr/år)</label><input type="number" step="1000" min="0" value={form.household_income_yearly ?? ''} onChange={f('household_income_yearly')} placeholder="800 000" /></div>
          <div className="bk-form-field"><label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={form.ranteavdrag} onChange={f('ranteavdrag')} /> Visa ränteavdrag (30 %)</label></div>
          <div className="bk-form-field"><label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={form.track_contributions} onChange={f('track_contributions')} /> Spåra insatser</label></div>
        </div>
        <div className="bk-dialog-foot">
          <span style={{ flex: 1 }} /><button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary">Spara</button>
        </div>
      </form>
    </dialog>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function Bolanekoll() {
  const { theme, toggleTheme } = useTheme()
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  // Store state
  const [parts, setParts] = useState<LoanPart[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [valuations, setValuations] = useState<Valuation[]>([])
  const [periods, setPeriods] = useState<RatePeriod[]>([])
  const [contributions, setContributions] = useState<Contribution[]>([])
  const [settings, setSettings] = useState<MortgageSettings>(defaultSettings())

  // UI state
  const [toast, setToast] = useState({ msg: '', show: false })
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [insightPeriod, setInsightPeriod] = useState<'1m' | '3m' | '6m' | '1y' | 'all'>('6m')
  const [extraMonthly, setExtraMonthly] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [importCfg, setImportCfg] = useState<ImportCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Dialog state
  const [partDlg, setPartDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [valDlg, setValDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [payDlg, setPayDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [contDlg, setContDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [settingsDlg, setSettingsDlg] = useState(false)

  // Chart
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ msg, show: true })
    toastTimer.current = setTimeout(() => setToast({ msg: '', show: false }), 2500)
  }

  const refresh = useCallback(async () => {
    const [ps, pays, vals, pers, contribs, sett] = await Promise.all([
      Store.listLoanParts(), Store.listPayments(), Store.listValuations(),
      Store.listRatePeriods(), Store.listContributions(), Store.getSettings(),
    ])
    setParts(ps); setPayments(pays); setValuations(vals); setPeriods(pers); setContributions(contribs); setSettings(sett)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    document.title = (settings.property_name || 'Bolånekoll') + ' · Hemma'
  }, [settings.property_name])

  // ── Chart ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!canvasRef.current) return
    const tl = equityTimeline(parts, payments, valuations, settings)
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null }
    if (tl.length < 2) return
    const root = getComputedStyle(document.documentElement)
    const cM = root.getPropertyValue('--chart-mine').trim() || '#357a4c'
    const cP = root.getPropertyValue('--chart-partner').trim() || '#3d7e94'
    const cB = root.getPropertyValue('--chart-bank').trim() || '#c08a44'
    function rgba(hex: string, a: number): string {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
      return `rgba(${r},${g},${b},${a})`
    }
    const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: tl.map(r => r.label),
        datasets: [
          { label: `${aName} (eget kapital)`, data: tl.map(r => r.a_equity), fill: true, borderColor: cM, backgroundColor: rgba(cM, 0.15), tension: 0.3, pointRadius: 2 },
          { label: `${bName} (eget kapital)`, data: tl.map(r => r.b_equity), fill: true, borderColor: cP, backgroundColor: rgba(cP, 0.15), tension: 0.3, pointRadius: 2 },
          { label: 'Bank (skuld)', data: tl.map(r => r.bank), fill: true, borderColor: cB, backgroundColor: rgba(cB, 0.12), tension: 0.3, pointRadius: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxRotation: 0, maxTicksLimit: 8, color: 'var(--ink-soft)', font: { size: 11 } }, grid: { color: 'var(--rule)' } },
          y: { stacked: false, ticks: { color: 'var(--ink-soft)', font: { size: 11 }, callback: (v: number | string) => fmtNum(Number(v)) }, grid: { color: 'var(--rule)' } },
        },
        plugins: { legend: { labels: { color: 'var(--ink-soft)', font: { size: 12 }, boxWidth: 16 } }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtCur(ctx.parsed.y ?? 0, settings.currency)}` } } },
      },
    })
    return () => { chartRef.current?.destroy(); chartRef.current = null }
  }, [parts, payments, valuations, settings, theme])

  // ── Import helpers ───────────────────────────────────────────────────────

  function buildTriage(parsed: CsvResult, mapping: ColMapping): TriageRow[] {
    const assigns = assignPaymentsToPart(parsed.rows.map(r => mapping.loan_number != null ? r[mapping.loan_number] : null), parts, { auto: true })
    const candidates = parsed.rows.map((row, i) => makePayment({
      date: mapping.date != null ? row[mapping.date] : '',
      specification: mapping.specification != null ? row[mapping.specification] : '',
      amount: parseAmount(mapping.amount != null ? row[mapping.amount] : null),
      balance_after: mapping.balance != null ? parseAmount(row[mapping.balance]) : null,
      loan_part_id: assigns[i].loan_part_id,
    }))
    const dups = flagDuplicates(payments, candidates)
    return candidates.map((p, i) => ({ action: dups[i] ? 'dup' as const : 'import' as const, loan_part_id: assigns[i].loan_part_id, data: p }))
  }

  async function loadFile(file: File) {
    const text = await file.text()
    const parsed = parseCsv(text)
    let mapping = autoMapColumns(parsed.headers)
    const sig = headerSignature(parsed.headers)
    if (settings.import_presets[sig]) mapping = applyPreset(parsed.headers, settings.import_presets[sig])
    const triage = buildTriage(parsed, mapping)
    return { file, parsed, mapping, triage }
  }

  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.name.endsWith('.csv') || f.type.includes('csv') || f.type.includes('text'))
    if (!arr.length) return
    const first = arr[0]
    const cfg = await loadFile(first)
    setImportCfg({ ...cfg, queue: arr.slice(1), qIdx: 0 })
  }

  function updateMapping(key: keyof ColMapping, val: number | null) {
    if (!importCfg) return
    const mapping = { ...importCfg.mapping, [key]: val }
    const triage = buildTriage(importCfg.parsed, mapping)
    setImportCfg(p => p ? { ...p, mapping, triage } : p)
  }

  async function confirmImport() {
    if (!importCfg) return
    const toImport = importCfg.triage.filter(r => r.action === 'import').map(r => r.data)
    if (!toImport.length) { showToast('Inga nya rader att importera.'); return }
    const sig = headerSignature(importCfg.parsed.headers)
    const names = mappingToNames(importCfg.parsed.headers, importCfg.mapping)
    await Store.saveSettings({ import_presets: { ...settings.import_presets, [sig]: names } })
    await Store.addPayments(toImport)
    await refresh()
    showToast(`${toImport.length} transaktioner importerade.`)
    if (importCfg.queue.length) {
      const next = importCfg.queue[0]
      const cfg = await loadFile(next)
      setImportCfg({ ...cfg, queue: importCfg.queue.slice(1), qIdx: importCfg.qIdx + 1 })
    } else {
      setImportCfg(null)
    }
  }

  // ── Derived data (memoized) ──────────────────────────────────────────────

  const today = todayISO()
  const activeParts = useMemo(() => parts.filter(p => !p.archived), [parts])
  const balance = useMemo(() => totalBalance(activeParts, payments), [activeParts, payments])
  const amortized = useMemo(() => totalAmortized(activeParts, payments), [activeParts, payments])
  const value = useMemo(() => propertyValue(valuations), [valuations])
  const eq = useMemo(() => equity(value, balance), [value, balance])
  const ltv = useMemo(() => loanToValue(balance, value), [balance, value])
  const split = useMemo(() => ownerSplit(eq, settings), [eq, settings])
  const pcts = useMemo(() => ownerPercents(settings), [settings])
  const blended = useMemo(() => weightedAvgRate(activeParts, periods, payments), [activeParts, periods, payments])
  const monthlyCostData = useMemo(() => monthlyCost(payments, { ranteavdrag: settings.ranteavdrag }), [payments, settings.ranteavdrag])
  const lastMonthCost = monthlyCostData[monthlyCostData.length - 1]

  const bridgeFromDate = useMemo(() => {
    if (insightPeriod === 'all') {
      const dates = [...parts.map(p => p.start_date), ...payments.map(p => p.date)].filter(Boolean).sort()
      return dates[0] || today
    }
    const n = insightPeriod === '1m' ? 1 : insightPeriod === '3m' ? 3 : insightPeriod === '6m' ? 6 : 12
    return isoMonthsAgo(n)
  }, [insightPeriod, parts, payments])

  const bridge = useMemo(() => equityBridge(parts, payments, valuations, bridgeFromDate, today), [parts, payments, valuations, bridgeFromDate])
  const amortStatus = useMemo(() => amorteringskravStatus(activeParts, payments, valuations, settings), [activeParts, payments, valuations, settings])
  const milestones = useMemo(() => projectMilestones(activeParts, payments, valuations, settings, { extraMonthly }), [activeParts, payments, valuations, settings, extraMonthly])
  const reconcile = useMemo(() => reconcileBalance(activeParts, payments), [activeParts, payments])
  const hasDrift = reconcile.some(r => r.drift != null && Math.abs(r.drift) > 1)

  const contribSplit = useMemo(() => settings.track_contributions ? contributionSplit(payments, contributions, settings) : null, [payments, contributions, settings])
  const settl = useMemo(() => settings.track_contributions ? settlement(payments, contributions, settings) : null, [payments, contributions, settings])

  const currency = settings.currency || 'SEK'
  const cur = (n: number) => fmtCur(n, currency)
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleSavePart(data: Omit<LoanPart, 'id' | 'created_at'>) {
    if (partDlg.id) await Store.updateLoanPart(partDlg.id, data)
    else await Store.addLoanPart(data)
    await refresh(); setPartDlg({ open: false, id: null }); showToast('Lånedel sparad.')
  }
  async function handleDeletePart(id: string) {
    await Store.removeLoanPart(id); await refresh(); setPartDlg({ open: false, id: null }); showToast('Lånedel borttagen.')
  }
  async function handleSavePeriod(partId: string, data: Omit<RatePeriod, 'id' | 'created_at'>, existingId?: string) {
    if (existingId) await Store.updateRatePeriod(existingId, data)
    else await Store.addRatePeriod({ ...data, loan_part_id: partId })
    await refresh(); showToast('Ränteperiod sparad.')
  }
  async function handleDeletePeriod(id: string) { await Store.removeRatePeriod(id); await refresh(); showToast('Ränteperiod borttagen.') }

  async function handleSaveVal(data: Omit<Valuation, 'id' | 'created_at'>) {
    if (valDlg.id) await Store.updateValuation(valDlg.id, data)
    else await Store.addValuation(data)
    await refresh(); setValDlg({ open: false, id: null }); showToast('Värdering sparad.')
  }
  async function handleDeleteVal(id: string) { await Store.removeValuation(id); await refresh(); setValDlg({ open: false, id: null }); showToast('Värdering borttagen.') }

  async function handleSavePay(data: Omit<Payment, 'id' | 'created_at'>) {
    if (payDlg.id) await Store.updatePayment(payDlg.id, data)
    else await Store.addPayment(data)
    await refresh(); setPayDlg({ open: false, id: null }); showToast('Transaktion sparad.')
  }
  async function handleDeletePay(id: string) { await Store.removePayment(id); await refresh(); setPayDlg({ open: false, id: null }); showToast('Transaktion borttagen.') }

  async function handleSaveCont(data: Omit<Contribution, 'id' | 'created_at'>) {
    if (contDlg.id) await Store.updateContribution(contDlg.id, data)
    else await Store.addContribution(data)
    await refresh(); setContDlg({ open: false, id: null }); showToast('Insats sparad.')
  }
  async function handleDeleteCont(id: string) { await Store.removeContribution(id); await refresh(); setContDlg({ open: false, id: null }); showToast('Insats borttagen.') }

  async function handleSaveSettings(patch: Partial<MortgageSettings>) {
    await Store.saveSettings(patch); await refresh(); setSettingsDlg(false); showToast('Inställningar sparade.')
  }

  function handleExportCSV() {
    const csv = paymentsToCsv(payments, parts)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'bolanekoll-betalningar.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  async function handleExportJSON() {
    const json = await Store.exportJSON()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'bolanekoll-backup.json'; a.click()
    URL.revokeObjectURL(url)
  }

  async function handleImportJSON(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    try {
      const text = await file.text()
      const added = await Store.importJSON(text)
      await refresh()
      showToast(`Återställt: ${Object.values(added).reduce((a, b) => a + b, 0)} rader.`)
    } catch (err) { alert(String(err)) }
    e.target.value = ''
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="page-header">
        <Link to="/" className="hub-link">← Hemma</Link>
        <span>{settings.property_name || 'Bolånekoll'}</span>
        <div className="header-actions">
          <button className="theme-toggle-btn" onClick={() => setSettingsDlg(true)} title="Inställningar" aria-label="Inställningar">⚙</button>
          <button className="theme-toggle-btn" onClick={toggleTheme} title="Dark mode" aria-label="Toggle dark mode">{theme === 'dark' ? '☾' : '☀'}</button>
        </div>
      </div>

      <div className="bk-wrap">

        {/* ── Reconciliation banner ── */}
        {hasDrift && (
          <div className="bk-banner bk-banner-warn">
            {reconcile.filter(r => r.drift != null && Math.abs(r.drift) > 1).map(r => (
              <span key={r.loan_part_id}><strong>{r.label}</strong>: startbalans skiljer {cur(Math.abs(r.drift!))} mot första importraden.</span>
            ))}
          </div>
        )}

        {/* ── Dashboard ── */}
        <section className="bk-card">
          <div className="bk-card-head"><h2 className="bk-card-title">Översikt</h2></div>
          <div className="bk-dash">
            <div className="bk-dash-main">
              <div className="bk-dash-label">Eget kapital</div>
              <div className="bk-dash-headline">{value ? cur(eq) : '—'}</div>
              <div className="bk-dash-sub">{value ? `${fmtPct((eq / value) * 100, 1)} av fastighetsvärdet` : 'Lägg till en värdering'}</div>
            </div>
            <div className="bk-split-row">
              <div className="bk-split-card"><div className="bk-split-label">{aName}</div><div className="bk-split-val">{value ? cur(split.a) : '—'}</div><div className="bk-split-pct">{pcts.a} %</div></div>
              <div className="bk-split-card"><div className="bk-split-label">{bName}</div><div className="bk-split-val">{value ? cur(split.b) : '—'}</div><div className="bk-split-pct">{pcts.b} %</div></div>
            </div>
          </div>
          <div className="bk-metrics">
            <div className="bk-metric"><div className="bk-metric-label">Fastighetsvärde</div><div className="bk-metric-val">{value ? cur(value) : '—'}</div></div>
            <div className="bk-metric"><div className="bk-metric-label">Skuld (kvar)</div><div className="bk-metric-val">{activeParts.length ? cur(balance) : '—'}</div></div>
            <div className="bk-metric"><div className="bk-metric-label">Amorterat</div><div className="bk-metric-val">{activeParts.length ? cur(amortized) : '—'}</div></div>
            <div className="bk-metric"><div className="bk-metric-label">Belåningsgrad</div><div className="bk-metric-val">{value && balance ? fmtPct(ltv, 1) : '—'}</div></div>
            {blended > 0 && <div className="bk-metric"><div className="bk-metric-label">Snittränta</div><div className="bk-metric-val">{fmtPct(blended)}</div></div>}
            {lastMonthCost && <div className="bk-metric"><div className="bk-metric-label">Kostnad senaste mån</div><div className="bk-metric-val">{cur(settings.ranteavdrag ? lastMonthCost.net : lastMonthCost.gross)}</div></div>}
          </div>
        </section>

        {/* ── Chart ── */}
        <section className="bk-card">
          <div className="bk-card-head"><h2 className="bk-card-title">Kapitalutveckling</h2></div>
          {equityTimeline(parts, payments, valuations, settings).length >= 2
            ? <div className="bk-chart-wrap"><canvas ref={canvasRef} /></div>
            : <div className="bk-chart-empty">Importera transaktioner och lägg till en värdering för att se diagrammet.</div>}
        </section>

        {/* ── Insights ── */}
        {(bridge.total_gain !== 0 || bridge.start_equity !== 0) && (
          <section className="bk-card">
            <div className="bk-card-head">
              <h2 className="bk-card-title">Kapitalförändring</h2>
              <div className="bk-segmented">
                {(['1m', '3m', '6m', '1y', 'all'] as const).map(p => (
                  <button key={p} className={'bk-seg' + (insightPeriod === p ? ' is-active' : '')} onClick={() => setInsightPeriod(p)}>
                    {p === '1m' ? '1 mån' : p === '3m' ? '3 mån' : p === '6m' ? '6 mån' : p === '1y' ? '1 år' : 'Allt'}
                  </button>
                ))}
              </div>
            </div>
            <div className="bk-bridge">
              <div className="bk-bridge-row"><span>Fastighetsvärde</span><span>{cur(bridge.start_value)} → <strong>{cur(bridge.end_value)}</strong></span></div>
              <div className="bk-bridge-row"><span>Skuld</span><span>{cur(bridge.start_balance)} → <strong>{cur(bridge.end_balance)}</strong></span></div>
              <div className="bk-bridge-row bk-bridge-gain"><span>+ Amortering</span><span className="bk-pos">{cur(bridge.amortization_gain)}</span></div>
              <div className="bk-bridge-row bk-bridge-gain"><span>+ Värdeutveckling</span><span className={bridge.appreciation_gain >= 0 ? 'bk-pos' : 'bk-neg'}>{cur(bridge.appreciation_gain)}</span></div>
              <div className="bk-bridge-total"><span>Total kapitalförändring</span><span className={bridge.total_gain >= 0 ? 'bk-pos' : 'bk-neg'}>{cur(bridge.total_gain)}</span></div>
            </div>
            {!amortStatus.exempt && (
              <div className={'bk-amort-status' + (amortStatus.meets ? '' : ' bk-amort-warn')}>
                <span>Amorteringskrav: <strong>{amortStatus.required_pct} %</strong> ({cur(amortStatus.required_annual)} /år)</span>
                <span>{amortStatus.meets ? '✓ Uppfyllt' : '⚠ Kontrollera'}</span>
              </div>
            )}
          </section>
        )}

        {/* ── Projection ── */}
        {activeParts.length > 0 && (
          <section className="bk-card">
            <div className="bk-card-head"><h2 className="bk-card-title">Prognos</h2></div>
            <div className="bk-proj">
              <div className="bk-proj-row">
                <label className="bk-proj-label">Månatlig extra amortering (kr)</label>
                <input className="bk-proj-input" type="number" step="500" min="0" value={extraMonthly || ''} placeholder="0" onChange={e => setExtraMonthly(Number(e.target.value) || 0)} />
              </div>
              <div className="bk-proj-stats">
                <div className="bk-proj-stat"><div className="bk-proj-stat-label">Nuvarande skuld</div><div className="bk-proj-stat-val">{cur(milestones.current_ltv > 0 ? balance : balance)}</div></div>
                <div className="bk-proj-stat"><div className="bk-proj-stat-label">LTV 70 %</div><div className="bk-proj-stat-val">{monthsLabel(milestones.ltv70_months)}</div></div>
                <div className="bk-proj-stat"><div className="bk-proj-stat-label">LTV 50 %</div><div className="bk-proj-stat-val">{monthsLabel(milestones.ltv50_months)}</div></div>
                <div className="bk-proj-stat"><div className="bk-proj-stat-label">Skuldfri</div><div className="bk-proj-stat-val">{milestones.flat ? 'Ingen amortering' : monthsLabel(milestones.payoff_months)}</div></div>
              </div>
            </div>
          </section>
        )}

        {/* ── Import ── */}
        <section className="bk-card">
          <div className="bk-card-head"><h2 className="bk-card-title">Importera CSV</h2></div>
          {!importCfg ? (
            <div
              className={'bk-dropzone' + (isDragging ? ' is-drag' : '')}
              onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={e => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files) }}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="bk-dropzone-icon">📂</div>
              <p>Dra hit bankens CSV-export, eller <span className="bk-link">klicka för att välja fil</span></p>
              <p className="bk-dropzone-hint">Sparbank, SEB, Swedbank, Handelsbanken — vi mattar kolumner automatiskt.</p>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" multiple style={{ display: 'none' }} onChange={e => e.target.files && handleFiles(e.target.files)} />
            </div>
          ) : (
            <div className="bk-import-cfg">
              <div className="bk-import-bar">
                <span className="bk-file-pill">📄 {importCfg.file.name}</span>
                {importCfg.queue.length > 0 && <span className="bk-queue-pill">+{importCfg.queue.length} filer kvar</span>}
                <button className="btn btn-ghost bk-btn-sm" onClick={() => setImportCfg(null)}>✕ Avbryt</button>
              </div>
              <div className="bk-col-grid">
                {(['date', 'specification', 'amount', 'balance', 'loan_number'] as const).map(k => (
                  <div key={k} className="bk-col-field">
                    <label>{k === 'date' ? 'Datum' : k === 'specification' ? 'Specifikation' : k === 'amount' ? 'Belopp' : k === 'balance' ? 'Saldo' : 'Lånenummer'}</label>
                    <select className="bk-select" value={importCfg.mapping[k] ?? ''} onChange={e => updateMapping(k, e.target.value !== '' ? Number(e.target.value) : null)}>
                      <option value="">— ingen —</option>
                      {importCfg.parsed.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className="bk-triage-wrap">
                <table className="bk-data-table">
                  <thead><tr><th></th><th>Datum</th><th>Typ</th><th>Belopp</th><th>Saldo efter</th><th>Lånedel</th></tr></thead>
                  <tbody>
                    {importCfg.triage.map((row, i) => (
                      <tr key={i} className={row.action === 'dup' ? 'bk-row-dup' : row.action === 'skip' ? 'bk-row-skip' : ''}>
                        <td><input type="checkbox" checked={row.action === 'import'} disabled={row.action === 'dup'} onChange={e => setImportCfg(p => p ? { ...p, triage: p.triage.map((r, j) => j === i ? { ...r, action: e.target.checked ? 'import' : 'skip' } : r) } : p)} /></td>
                        <td>{row.data.date}</td>
                        <td><span className={'bk-kind-tag bk-kind-' + row.data.kind}>{KIND_LABELS[row.data.kind]}</span></td>
                        <td className="bk-num">{fmtNum(row.data.amount)}</td>
                        <td className="bk-num">{row.data.balance_after != null ? fmtNum(row.data.balance_after) : ''}</td>
                        <td>
                          <select className="bk-select bk-select-sm" value={row.loan_part_id || ''} onChange={e => setImportCfg(p => p ? { ...p, triage: p.triage.map((r, j) => j === i ? { ...r, loan_part_id: e.target.value || null, data: { ...r.data, loan_part_id: e.target.value || null } } : r) } : p)}>
                            <option value="">— ingen —</option>
                            {parts.map(pt => <option key={pt.id} value={pt.id}>{pt.label || pt.id}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="bk-import-foot">
                <span className="bk-import-count">{importCfg.triage.filter(r => r.action === 'import').length} att importera · {importCfg.triage.filter(r => r.action === 'dup').length} dubbletter</span>
                <button className="btn btn-primary" onClick={confirmImport}>Importera</button>
              </div>
            </div>
          )}
        </section>

        {/* ── Loan parts ── */}
        <section className="bk-card">
          <div className="bk-card-head">
            <h2 className="bk-card-title">Lånedelar <span className="bk-count">{activeParts.length}</span></h2>
            <button className="btn btn-primary bk-btn-sm" onClick={() => setPartDlg({ open: true, id: null })}>+ Lägg till</button>
          </div>
          {!activeParts.length ? (
            <p className="bk-empty">Inga lånedelar. Lägg till din första lånedel för att komma igång.</p>
          ) : (
            <div className="bk-table-wrap">
              <table className="bk-data-table">
                <thead><tr><th>Benämning</th><th className="bk-num">Skuld</th><th className="bk-num">Amorterat</th><th className="bk-num">Ränta</th><th>Bindning</th><th></th></tr></thead>
                <tbody>
                  {activeParts.map(p => {
                    const bal = partBalance(p, payments)
                    const amort = partAmortized(p, payments)
                    const rate = effectiveRate(p, periods)
                    const binding = bindingStatus(p, periods, today)
                    const dr = derivedRate(p, payments)
                    return (
                      <tr key={p.id}>
                        <td>{p.label || <em className="bk-muted">(ingen benämning)</em>}</td>
                        <td className="bk-num">{cur(bal)}</td>
                        <td className="bk-num">{amort > 0 ? cur(amort) : '—'}</td>
                        <td className="bk-num">
                          {rate != null ? fmtPct(rate) : '—'}
                          {dr != null && rate == null && <span className="bk-derived"> ({fmtPct(dr)} härledd)</span>}
                        </td>
                        <td>{binding.bound ? <span className={'bk-binding' + (binding.expired ? ' bk-binding-exp' : '')}>{binding.until}{binding.days_left != null ? ` (${binding.days_left}d)` : ''}</span> : <span className="bk-muted">Rörlig</span>}</td>
                        <td><button className="bk-link-btn" onClick={() => setPartDlg({ open: true, id: p.id })}>Redigera</button></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Valuations ── */}
        <section className="bk-card">
          <div className="bk-card-head">
            <h2 className="bk-card-title">Värderingar <span className="bk-count">{valuations.length}</span></h2>
            <button className="btn btn-primary bk-btn-sm" onClick={() => setValDlg({ open: true, id: null })}>+ Lägg till</button>
          </div>
          {!valuations.length ? <p className="bk-empty">Inga värderingar. Lägg till din första.</p> : (
            <div className="bk-table-wrap">
              <table className="bk-data-table">
                <thead><tr><th>Datum</th><th className="bk-num">Värde</th><th>Notering</th><th></th></tr></thead>
                <tbody>
                  {valuations.map(v => (
                    <tr key={v.id}>
                      <td>{v.date}</td>
                      <td className="bk-num">{cur(v.value)}</td>
                      <td className="bk-muted">{v.note}</td>
                      <td><button className="bk-link-btn" onClick={() => setValDlg({ open: true, id: v.id })}>Redigera</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Payments ── */}
        <section className="bk-card">
          <div className="bk-card-head">
            <h2 className="bk-card-title">Transaktioner <span className="bk-count">{payments.length}</span></h2>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-ghost bk-btn-sm" onClick={handleExportCSV}>Exportera CSV</button>
              <button className="btn btn-primary bk-btn-sm" onClick={() => setPayDlg({ open: true, id: null })}>+ Lägg till</button>
            </div>
          </div>
          {!payments.length ? <p className="bk-empty">Inga transaktioner. Importera en CSV eller lägg till manuellt.</p> : (
            <div className="bk-table-wrap">
              <table className="bk-data-table">
                <thead><tr><th>Datum</th><th>Typ</th><th className="bk-num">Belopp</th><th className="bk-num">Saldo efter</th><th>Lånedel</th><th></th></tr></thead>
                <tbody>
                  {payments.slice(0, 100).map(p => {
                    const partName = parts.find(pt => pt.id === p.loan_part_id)?.label
                    return (
                      <tr key={p.id}>
                        <td>{p.date}</td>
                        <td><span className={'bk-kind-tag bk-kind-' + p.kind}>{KIND_LABELS[p.kind]}</span></td>
                        <td className="bk-num">{fmtNum(p.amount)}</td>
                        <td className="bk-num">{p.balance_after != null ? fmtNum(p.balance_after) : ''}</td>
                        <td className="bk-muted">{partName || ''}</td>
                        <td><button className="bk-link-btn" onClick={() => setPayDlg({ open: true, id: p.id })}>Redigera</button></td>
                      </tr>
                    )
                  })}
                  {payments.length > 100 && <tr><td colSpan={6} className="bk-more">… och {payments.length - 100} till. Exportera CSV för att se alla.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Contributions ── */}
        {settings.track_contributions && (
          <section className="bk-card">
            <div className="bk-card-head">
              <h2 className="bk-card-title">Insatser <span className="bk-count">{contributions.length}</span></h2>
              <button className="btn btn-primary bk-btn-sm" onClick={() => setContDlg({ open: true, id: null })}>+ Lägg till</button>
            </div>
            {contribSplit && (
              <div className="bk-contrib-split">
                <div className="bk-contrib-owner"><span>{aName}</span><strong>{cur(contribSplit.a)}</strong><span>{fmtPct(contribSplit.a_pct, 1)}</span></div>
                <div className="bk-contrib-owner"><span>{bName}</span><strong>{cur(contribSplit.b)}</strong><span>{fmtPct(contribSplit.b_pct, 1)}</span></div>
                {settl?.owes && <div className="bk-settle"><strong>{settl.owes === 'b' ? bName : aName}</strong> bör betala <strong>{cur(settl.amount)}</strong> för att nå målet.</div>}
              </div>
            )}
            {!contributions.length ? <p className="bk-empty">Inga insatser registrerade.</p> : (
              <div className="bk-table-wrap">
                <table className="bk-data-table">
                  <thead><tr><th>Datum</th><th>Ägare</th><th className="bk-num">Belopp</th><th>Notering</th><th></th></tr></thead>
                  <tbody>
                    {contributions.map(c => (
                      <tr key={c.id}>
                        <td>{c.date}</td>
                        <td>{c.owner === 'a' ? aName : bName}</td>
                        <td className="bk-num">{cur(c.amount)}</td>
                        <td className="bk-muted">{c.note}</td>
                        <td><button className="bk-link-btn" onClick={() => setContDlg({ open: true, id: c.id })}>Redigera</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* ── Backup ── */}
        <section className="bk-card bk-card-compact">
          <div className="bk-card-head"><h2 className="bk-card-title">Backup</h2></div>
          <div className="bk-backup-row">
            <button className="btn btn-ghost bk-btn-sm" onClick={handleExportJSON}>Exportera JSON</button>
            <label className="btn btn-ghost bk-btn-sm" style={{ cursor: 'pointer' }}>
              Importera JSON
              <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportJSON} />
            </label>
          </div>
        </section>

      </div>

      {/* ── Dialogs ── */}
      <PartDialog open={partDlg.open} id={partDlg.id} parts={parts} periods={periods} payments={payments}
        onSave={handleSavePart} onDelete={handleDeletePart} onClose={() => setPartDlg({ open: false, id: null })}
        onSavePeriod={handleSavePeriod} onDeletePeriod={handleDeletePeriod}
      />
      <ValuationDialog open={valDlg.open} id={valDlg.id} valuations={valuations} onSave={handleSaveVal} onDelete={handleDeleteVal} onClose={() => setValDlg({ open: false, id: null })} />
      <PaymentDialog open={payDlg.open} id={payDlg.id} payments={payments} parts={parts} settings={settings} onSave={handleSavePay} onDelete={handleDeletePay} onClose={() => setPayDlg({ open: false, id: null })} />
      <ContribDialog open={contDlg.open} id={contDlg.id} contributions={contributions} settings={settings} onSave={handleSaveCont} onDelete={handleDeleteCont} onClose={() => setContDlg({ open: false, id: null })} />
      <SettingsDialog open={settingsDlg} settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsDlg(false)} />

      {/* ── Toast ── */}
      <div className={'bk-toast' + (toast.show ? ' is-show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </>
  )
}
