import { useState, type ReactNode, type CSSProperties } from 'react'
import { formatWithSpaces, parseFormatted } from '../lib/format'

// Currency text input: shows spaced thousands when blurred, raw number while
// focused; arrow keys step ±10 000 (shift ±100 000). Ports the app.js behaviour.
interface CurrencyInputProps {
  value: number
  onChange: (n: number) => void
  id?: string
  suffix?: string
  ariaLabel?: string
}

export function CurrencyInput({ value, onChange, id, suffix = 'kr', ariaLabel }: CurrencyInputProps) {
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const display = focused ? text : formatWithSpaces(value)

  return (
    <div className="input-wrap has-suffix">
      <input
        type="text"
        inputMode="numeric"
        id={id}
        aria-label={ariaLabel}
        value={display}
        onFocus={() => {
          setFocused(true)
          setText(value ? String(value) : '')
        }}
        onChange={(e) => {
          setText(e.target.value)
          onChange(parseFormatted(e.target.value))
        }}
        onBlur={() => {
          setFocused(false)
          onChange(parseFormatted(text))
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          e.preventDefault()
          const step = e.shiftKey ? 100_000 : 10_000
          const base = parseFormatted(focused ? text : String(value))
          const next = Math.max(0, base + (e.key === 'ArrowUp' ? step : -step))
          setText(String(next))
          onChange(next)
        }}
      />
      <span className="suffix">{suffix}</span>
    </div>
  )
}

// Number input with an optional suffix. Keeps an internal text buffer while
// focused so decimals like "3." don't get clobbered by the round-trip.
interface NumberInputProps {
  value: number
  onChange: (n: number) => void
  id?: string
  suffix?: string
  min?: number
  max?: number
  step?: number
  className?: string
  ariaLabel?: string
}

export function NumberInput({
  value,
  onChange,
  id,
  suffix,
  min,
  max,
  step,
  className,
  ariaLabel,
}: NumberInputProps) {
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')
  const display = focused ? text : String(value)
  const input = (
    <input
      type="number"
      id={id}
      className={className}
      aria-label={ariaLabel}
      value={display}
      min={min}
      max={max}
      step={step}
      onFocus={() => {
        setFocused(true)
        setText(String(value))
      }}
      onChange={(e) => {
        setText(e.target.value)
        onChange(parseFloat(e.target.value) || 0)
      }}
      onBlur={() => setFocused(false)}
    />
  )
  return suffix ? (
    <div className="input-wrap has-suffix">
      {input}
      <span className="suffix">{suffix}</span>
    </div>
  ) : (
    <div className="input-wrap">{input}</div>
  )
}

export function Field({
  label,
  children,
  hint,
  hintWarn,
  spanAll,
}: {
  label: string
  children: ReactNode
  hint?: ReactNode
  hintWarn?: boolean
  spanAll?: boolean
}) {
  return (
    <div className={spanAll ? 'field span-all' : 'field'}>
      <label>{label}</label>
      {children}
      {hint != null && <span className={hintWarn ? 'hint hint-warn' : 'hint'}>{hint}</span>}
    </div>
  )
}

export function DerivedRow({
  label,
  value,
  cls,
  rowClass,
}: {
  label: ReactNode
  value: ReactNode
  cls?: 'positive' | 'negative'
  rowClass?: string
}) {
  return (
    <div className={rowClass ? `derived-row ${rowClass}` : 'derived-row'}>
      <span className="derived-label">{label}</span>
      <span className={cls ? `derived-value ${cls}` : 'derived-value'}>{value}</span>
    </div>
  )
}

export type { CSSProperties }
