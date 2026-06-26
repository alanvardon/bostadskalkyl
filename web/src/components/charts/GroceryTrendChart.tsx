import { ParentSize } from '@visx/responsive'
import LineAreaChart, { type SeriesDef } from './LineAreaChart'
import { useChartTheme } from './useChartTheme'

// Grocery spend per month as an editorial area chart — the same visx workhorse
// the Bostadskalkyl charts use (real axes + crosshair tooltip), reading the
// shared design tokens. Months are passed as 0..n-1 indices; the axis/tooltip
// formatters map an index back to its month label.

export interface MonthPoint { month: string; label: string; total: number }

export default function GroceryTrendChart({
  data,
  formatMoney,
}: {
  data: MonthPoint[]
  formatMoney: (n: number) => string
}) {
  const theme = useChartTheme()
  const series: SeriesDef[] = [
    { key: 'groceries', label: 'Groceries', color: theme.accent, values: data.map((d) => d.total), area: true, strokeWidth: 2.5 },
  ]
  const labelAt = (x: number) => data[Math.round(x)]?.label ?? ''
  return (
    <div className="ma-chart">
      <ParentSize>
        {({ width, height }) => (
          <LineAreaChart
            width={width}
            height={height}
            theme={theme}
            idPrefix="groc"
            xValues={data.map((_, i) => i)}
            series={series}
            formatXAxis={labelAt}
            formatYAxis={(y) => (Math.round(y / 100) / 10) + 'k'}
            formatXTooltip={labelAt}
            formatYTooltip={formatMoney}
            ariaLabel="Groceries spending by month"
          />
        )}
      </ParentSize>
    </div>
  )
}
