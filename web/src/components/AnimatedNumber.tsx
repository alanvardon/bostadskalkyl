import NumberFlow from '@number-flow/react'

// Animated figure components. NumberFlow rolls the digits whenever `value`
// changes (typing an input, dragging the stress slider, loading a scenario).
// It honours prefers-reduced-motion automatically (respectMotionPreference
// defaults to true), so no manual gating is needed here.

interface MoneyProps {
  value: number
  /** Render a leading "+" for positives / "−" for negatives (P&L, cash balance). */
  signed?: boolean
  /** Static prefix glued before the figure — used for "less …" cost rows ("−"). */
  prefix?: string
  /** Trailing unit, e.g. "/mo" or "/yr". */
  suffix?: string
  className?: string
}

/**
 * SEK figure matching the legacy `fmt()` output ("30 623 kr", sv-SE grouping).
 * sv-SE currency formatting yields "kr" after the number, so this is a 1:1
 * visual replacement for the old `fmt(n)` strings.
 */
export function Money({ value, signed, prefix, suffix, className }: MoneyProps) {
  return (
    <NumberFlow
      value={value}
      locales="sv-SE"
      format={{
        style: 'currency',
        currency: 'SEK',
        maximumFractionDigits: 0,
        ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
      }}
      prefix={prefix}
      suffix={suffix}
      className={className}
    />
  )
}

/**
 * One-decimal percentage matching the legacy `pct()` output ("21.1%").
 * Uses en-US so the decimal separator stays a dot, as `toFixed(1)` did.
 */
export function Percent({ value, className }: { value: number; className?: string }) {
  return (
    <NumberFlow
      value={value}
      locales="en-US"
      format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
      suffix="%"
      className={className}
    />
  )
}
