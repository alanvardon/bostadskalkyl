import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_INPUTS, derive, type Inputs } from './lib/calc'
import { fmt } from './lib/format'
import InputsColumn from './components/InputsColumn'
import SummaryColumn from './components/SummaryColumn'

type Theme = 'light' | 'dark'

// Shares the localStorage key with the vanilla app so a returning user's
// theme choice carries over (and the future suite stays in sync).
const THEME_KEY = 'bostadskalkyl_theme'

function getInitialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

const sign = (n: number) => (n >= 0 ? '+' : '')

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [inputs, setInputs] = useState<Inputs>(DEFAULT_INPUTS)

  const figures = useMemo(() => derive(inputs), [inputs])

  function setField<K extends keyof Inputs>(key: K, value: Inputs[K]) {
    setInputs((prev) => ({ ...prev, [key]: value }))
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* private mode / storage disabled — ignore */
    }
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
      meta.setAttribute('content', paper)
    }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <>
      <header className="page-header">
        <div className="header-brand">
          <a className="hub-link" href="../index.html">‹ Hemma</a>
          <div>
            <h1>Bostadskalkyl</h1>
            <p className="tagline">
              Swedish house purchase calculator — upfront costs &amp; monthly payments
            </p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-ghost theme-toggle-btn"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
          <button className="btn btn-ghost" disabled title="Scenarios (Phase 3)">
            Scenarios
          </button>
          <button className="btn btn-primary" disabled title="Save (Phase 3)">
            Save
          </button>
        </div>
      </header>

      <div className="layout">
        <InputsColumn inputs={inputs} setField={setField} figures={figures} />
        <SummaryColumn inputs={inputs} setField={setField} figures={figures} />
      </div>

      {/* Mobile key-figures bar */}
      <div className="mobile-bar">
        <div className="mobile-bar-inner">
          <div className="mobile-stat">
            <span className="mobile-stat-label">Monthly</span>
            <span className="mobile-stat-val">{fmt(figures.totalMonthly)}</span>
          </div>
          <div className="mobile-stat">
            <span className="mobile-stat-label">Surplus / shortfall</span>
            <span className={`mobile-stat-val ${figures.cashBalance >= 0 ? 'positive' : 'negative'}`}>
              {sign(figures.cashBalance)}
              {fmt(figures.cashBalance)}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
