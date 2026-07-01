// Segmented radio-group control shared by the tool pages. With `responsive`
// set, a sibling <select class="seg-select"> renders as the narrow-viewport
// fallback (CSS decides which of the two is visible).
export default function Segmented<T extends string>({ value, options, onChange, small, responsive, ariaLabel }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; small?: boolean; responsive?: boolean; ariaLabel?: string
}) {
  return (
    <>
      <div className={'segmented' + (small ? ' segmented-sm' : '') + (responsive ? ' segmented-responsive' : '')} role="radiogroup" aria-label={ariaLabel}>
        {options.map(o => (
          <button key={o.v} type="button" role="radio" aria-checked={value === o.v}
            className={'seg' + (value === o.v ? ' is-active' : '')} onClick={() => onChange(o.v)}>{o.label}</button>
        ))}
      </div>
      {responsive && (
        <select className="seg-select" value={value} aria-label={ariaLabel}
          onChange={e => onChange(e.target.value as T)}>
          {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      )}
    </>
  )
}
