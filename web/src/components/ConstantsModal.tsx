import { Dialog } from 'radix-ui'
import { DEFAULT_CONSTANTS, type Constants } from '../lib/calc'
import AnimatedDialog from './AnimatedDialog'

// Editor for the tunable statutory constants. Same component backs the global
// defaults (from the dashboard) and a single scenario's override (from the
// calculator) — the parent passes the value + an onChange that writes to the
// right place. Edits apply live; "Reset to 2026 defaults" restores them.

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: Constants
  onChange: (c: Constants) => void
  title: string
  subtitle?: string
}

function NumRow({
  label,
  hint,
  value,
  onChange,
  suffix,
  step = 0.1,
}: {
  label: string
  hint?: string
  value: number
  onChange: (n: number) => void
  suffix: string
  step?: number
}) {
  return (
    <label className="const-row">
      <span className="const-label">
        {label}
        {hint && <span className="const-hint">{hint}</span>}
      </span>
      <span className="const-input-wrap">
        <input
          type="number"
          value={value}
          step={step}
          onChange={(e) => onChange(e.target.value === '' ? 0 : parseFloat(e.target.value))}
          aria-label={label}
        />
        <span className="const-suffix">{suffix}</span>
      </span>
    </label>
  )
}

export default function ConstantsModal({ open, onOpenChange, value: c, onChange, title, subtitle }: Props) {
  return (
    <AnimatedDialog open={open} onOpenChange={onOpenChange} contentClassName="modal">
      <div className="modal-header">
        <div>
          <Dialog.Title className="modal-title">{title}</Dialog.Title>
          {subtitle && <div className="modal-subtitle">{subtitle}</div>}
        </div>
        <Dialog.Close className="modal-close" aria-label="Close">
          ×
        </Dialog.Close>
      </div>
      <div className="modal-body">
        <div className="const-group">
          <div className="const-group-title">Upfront fees & deposit</div>
          <NumRow label="Lagfart (stamp duty)" value={c.lagfartPct} suffix="%" onChange={(v) => onChange({ ...c, lagfartPct: v })} />
          <NumRow label="Pantbrev (mortgage deed)" value={c.pantbrevPct} suffix="%" onChange={(v) => onChange({ ...c, pantbrevPct: v })} />
          <NumRow label="Minimum down payment" hint="max LTV = 100 − this" value={c.minDownPaymentPct} suffix="%" onChange={(v) => onChange({ ...c, minDownPaymentPct: v })} />
        </div>

        <div className="const-group">
          <div className="const-group-title">Property fee (fastighetsavgift)</div>
          <NumRow label="Småhus cap" hint="kr/yr, income year 2026" value={c.fastighetsavgiftCap} suffix="kr" step={1} onChange={(v) => onChange({ ...c, fastighetsavgiftCap: v })} />
        </div>

        <div className="const-group">
          <div className="const-group-title">Ränteavdrag (interest deduction)</div>
          <NumRow label="Rate up to threshold" value={c.ranteavdrag.lowPct} suffix="%" onChange={(v) => onChange({ ...c, ranteavdrag: { ...c.ranteavdrag, lowPct: v } })} />
          <NumRow label="Rate above threshold" value={c.ranteavdrag.highPct} suffix="%" onChange={(v) => onChange({ ...c, ranteavdrag: { ...c.ranteavdrag, highPct: v } })} />
          <NumRow label="Threshold" value={c.ranteavdrag.thresholdKr} suffix="kr" step={1000} onChange={(v) => onChange({ ...c, ranteavdrag: { ...c.ranteavdrag, thresholdKr: v } })} />
        </div>

        <div className="const-group">
          <div className="const-group-title">Amortisation rule (amorteringskrav)</div>
          <NumRow label="Rate above high-LTV threshold" value={c.amort.highLtvRatePct} suffix="%" onChange={(v) => onChange({ ...c, amort: { ...c.amort, highLtvRatePct: v } })} />
          <NumRow label="High-LTV threshold" value={c.amort.highLtvPct} suffix="%" onChange={(v) => onChange({ ...c, amort: { ...c.amort, highLtvPct: v } })} />
          <NumRow label="Rate above mid-LTV threshold" value={c.amort.midLtvRatePct} suffix="%" onChange={(v) => onChange({ ...c, amort: { ...c.amort, midLtvRatePct: v } })} />
          <NumRow label="Mid-LTV threshold" value={c.amort.midLtvPct} suffix="%" onChange={(v) => onChange({ ...c, amort: { ...c.amort, midLtvPct: v } })} />
          <NumRow label="Income multiple for surcharge" hint="loan above this × income" value={c.amort.incomeMultiple} suffix="×" onChange={(v) => onChange({ ...c, amort: { ...c.amort, incomeMultiple: v } })} />
          <NumRow label="Income surcharge" value={c.amort.incomeSurchargePct} suffix="%" onChange={(v) => onChange({ ...c, amort: { ...c.amort, incomeSurchargePct: v } })} />
        </div>

        <button type="button" className="btn btn-ghost const-reset" onClick={() => onChange(DEFAULT_CONSTANTS)}>
          Reset to 2026 defaults
        </button>
      </div>
    </AnimatedDialog>
  )
}
