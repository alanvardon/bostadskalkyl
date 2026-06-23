import type { Inputs, Figures } from '../lib/calc'
import { fmt, pct } from '../lib/format'

interface Props {
  inputs: Inputs
  setField: <K extends keyof Inputs>(key: K, value: Inputs[K]) => void
  figures: Figures
}

const sign = (n: number) => (n >= 0 ? '+' : '')

export default function SummaryColumn({ inputs: i, setField, figures: f }: Props) {
  // Phase 2: no savings store yet → savings total is 0, so total = cashBalance.
  // (The P&L card gains the savings augmentation in Phase 3.)
  const totalBalance = f.cashBalance
  const pnlClass =
    totalBalance > 0 ? 'sum-card pnl-positive' : totalBalance < 0 ? 'sum-card pnl-negative' : 'sum-card'
  const equity = Math.min(Math.max(f.equityShare, 0), 100)
  const ltvColor =
    f.equityShare < 15 ? 'var(--warn)' : f.equityShare < 30 ? 'var(--warn-light)' : 'var(--accent)'

  return (
    <div className="summary-col">
      <p className="summary-title">Summary</p>

      {/* Cash surplus / shortfall (P&L) */}
      <div className={pnlClass}>
        <div className="sum-card-title">Cash surplus / shortfall</div>
        <div className={`sum-big ${totalBalance >= 0 ? 'positive' : 'negative'}`}>
          {sign(totalBalance)}
          {fmt(totalBalance)}
        </div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Net from sale</span>
            <span className="sum-row-val">{fmt(f.netProceeds)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Less upfront costs</span>
            <span className="sum-row-val">{'−' + fmt(f.totalUpfront)}</span>
          </div>
        </div>
      </div>

      {/* Net from sale */}
      <div className="sum-card">
        <div className="sum-card-title">Net from sale</div>
        <div className="sum-big positive">{fmt(f.netProceeds)}</div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Total takeaway</span>
            <span className="sum-row-val">{fmt(f.totalTakeaway)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Less agent &amp; moving</span>
            <span className="sum-row-val">{'−' + fmt(i.agentCost + i.movingCost)}</span>
          </div>
        </div>
      </div>

      {/* Total upfront needed */}
      <div className="sum-card">
        <div className="sum-card-title">Total upfront needed</div>
        <div className="sum-big">{fmt(f.totalUpfront)}</div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Deposit</span>
            <span className="sum-row-val">{fmt(i.deposit)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Lagfart</span>
            <span className="sum-row-val">{fmt(f.lagfart)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Pantbrev cost</span>
            <span className="sum-row-val">{fmt(f.pantbrevCost)}</span>
          </div>
        </div>
      </div>

      {/* New mortgage + equity bar */}
      <div className="sum-card">
        <div className="sum-card-title">New mortgage</div>
        <div className="sum-big">{fmt(f.loanAmount)}</div>
        <div className="ltv-bar-wrap">
          <div className="ltv-bar-bg">
            <div className="ltv-bar-fill" style={{ width: `${equity}%`, background: ltvColor }} />
          </div>
          <div className="ltv-labels">
            <span>
              Equity: <strong>{pct(f.equityShare)}</strong>
            </span>
            <span>15% min</span>
          </div>
        </div>
      </div>

      <hr className="sum-divider" />

      {/* Total monthly cost */}
      <div className="sum-card">
        <div className="sum-card-title">Total monthly cost</div>
        <div className="sum-big">{fmt(f.totalMonthly)}</div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Interest</span>
            <span className="sum-row-val">{fmt(f.bankA.interest)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Amortisation</span>
            <span className="sum-row-val">{fmt(f.monthlyAmort)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Property tax</span>
            <span className="sum-row-val">{fmt(f.taxMonthly)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Driftkostnad</span>
            <span className="sum-row-val">{fmt(i.driftkostnad)}</span>
          </div>
        </div>
      </div>

      {/* Ränteavdrag */}
      <div className="sum-card">
        <div className="sum-card-title">Ränteavdrag (tax relief)</div>
        <div className="sum-big positive">{fmt(f.relief / 12)}/mo</div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Annual interest</span>
            <span className="sum-row-val">{fmt(f.bankA.annualInterest)}/yr</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Back from Skatteverket</span>
            <span className="sum-row-val positive">{fmt(f.relief)}/yr</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Effective monthly</span>
            <span className="sum-row-val">{fmt(f.effectiveMonthly)}</span>
          </div>
        </div>
      </div>

      <hr className="sum-divider" />

      {/* Affordability */}
      <div className="sum-card">
        <div className="sum-card-title">Affordability</div>
        <div className="sum-big">{fmt(f.reqSalaryMonthly)}/mo</div>
        <div className="sum-card-subtitle">gross monthly salary needed</div>
        <div className="sum-rows" style={{ marginTop: '0.5rem' }}>
          <div className="sum-row afford-row" style={{ borderTop: 'none', paddingTop: 6 }}>
            <span className="sum-row-label">Threshold</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <input
                type="number"
                className="afford-input"
                value={i.affordThreshold}
                min={1}
                max={100}
                step={1}
                onChange={(e) => setField('affordThreshold', parseInt(e.target.value, 10) || 0)}
                aria-label="Affordability threshold"
              />
              <span className="afford-unit">% of gross salary</span>
            </span>
          </div>
          <div className="sum-row afford-row" style={{ paddingTop: 6 }}>
            <span className="sum-row-label">Include ränteavdrag</span>
            <label className="toggle" style={{ marginLeft: 'auto' }}>
              <input
                type="checkbox"
                checked={i.ranteavdrag}
                onChange={(e) => setField('ranteavdrag', e.target.checked)}
                aria-label="Include ränteavdrag in affordability"
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

      {/* Equity projection */}
      <div className="sum-card">
        <div className="sum-card-title">Equity after 10 years</div>
        <div className="sum-big positive">{fmt(f.equity.y10)}</div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Equity at year 5</span>
            <span className="sum-row-val">{fmt(f.equity.y5)}</span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Equity at year 20</span>
            <span className="sum-row-val">{fmt(f.equity.y20)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
