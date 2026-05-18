# Test plan — Dark mode toggle with localStorage persistence

## Theme toggle — core behaviour
- [ ] Page loads in light mode by default (no previous localStorage value)
- [ ] Clicking the ☀ button in the header switches to dark mode and button label changes to ☾
- [ ] Clicking ☾ toggles back to light mode and button label reverts to ☀
- [ ] After toggling to dark, hard-reload the page — dark mode is restored from localStorage
- [ ] After toggling back to light, hard-reload — light mode is restored from localStorage
- [ ] `localStorage.getItem('bostadskalkyl_theme')` returns `"dark"` or `"light"` after toggle

## Visual — dark mode palette
- [ ] Background (body) changes to dark `#1c1c1a`
- [ ] Input borders and rule lines change to dark `#333330`
- [ ] Text and headings switch to light `#e8e6df`
- [ ] Accent colour becomes `#4a8a5e` (visible in LTV bar and positive values)
- [ ] Warn colour becomes `#c4723a` (visible in negative values)
- [ ] Modal backdrop is visibly darker in dark mode than light mode
- [ ] Input focus background switches to dark `#2a2a28` instead of `#fff`

## CSS variable correctness
- [ ] No hardcoded hex colours remain in `.modal-backdrop`, `.save-prompt`, `.chart-fullscreen-backdrop` — they should use `var(--modal-backdrop)`
- [ ] `input[type="text"]:focus` uses `var(--input-focus-bg)` not `#fff`

## LTV bar
- [ ] With equity < 15 %, bar colour is `var(--warn)` (amber in light, orange-brown in dark)
- [ ] With equity 15–30 %, bar colour is `var(--warn-light)`
- [ ] With equity >= 30 %, bar colour is `var(--accent)` green

## Amortisation chart — theme-aware colours
- [ ] Open the amort modal (click "View payoff chart") in light mode — legend, axis ticks, grid lines, and tooltips use light palette colours
- [ ] Toggle to dark mode while the chart is open — chart re-renders with dark palette (grid `#333330`, ticks `#7a7a72`, tooltip bg `#212120`)
- [ ] Open the fullscreen chart (click on chart area) in dark mode — fullscreen chart also uses dark palette, not frozen light-mode values
- [ ] Open the fullscreen chart in light mode — fullscreen chart uses light palette

## Regression checks
- [ ] `calc()` still runs and updates all derived values after every input change
- [ ] Saving a scenario and reloading it still restores all inputs correctly
- [ ] Ränteavdrag toggle still works; affordability card updates accordingly
- [ ] Driftkostnad modal itemisation still updates Section 3 total
- [ ] Savings modal still adds to the P&L card
- [ ] Scenarios modal opens, loads, and deletes correctly
- [ ] Stress test slider updates monthly interest values
- [ ] Listing URL open button still works
