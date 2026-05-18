# Plan — Dark mode toggle with localStorage persistence

## Title
Dark mode toggle with localStorage persistence

## Type
feature

---

## Affected areas

**CSS block (`<style>` in `<head>`)**
- Add a `[data-theme="dark"]` attribute selector on `:root` that overrides all 11 colour variables with dark-mode equivalents.
- Add a `.theme-toggle-btn` style (icon button, sits in `.header-actions`). It needs a specific `width`/`height` so it does not visually overpower the existing `btn` siblings.
- The `input[type="text"]:focus` rule hard-codes `background: #fff` — this must become `background: var(--input-focus-bg)` and that variable must be defined in both light and dark root blocks.
- The Chart.js tooltip hard-codes literal hex values (`#faf9f4`, `#d8d6ce`, `#1a1a18`, `#4a4a46`). These cannot be changed at the CSS level; they require a JS fix described below.

**HTML `<body>` structure**
- One new `<button>` element added inside `.header-actions`, before the existing "Scenarios" button. Use id `themeToggleBtn`.

**JavaScript `<script>` block**
- New `initTheme()` function: reads `bostadskalkyl_theme` from localStorage on boot, applies `data-theme` to `document.documentElement`, sets button label/icon.
- New `toggleTheme()` function: flips `data-theme`, persists to localStorage, updates button label/icon, and re-renders any open charts so their hardcoded colors update.
- Modify `renderAmortChart()` and `openFullscreenChart()` to read current theme and pass theme-aware colours into Chart.js `options` (legend, tooltip, axis tick/grid colours) instead of literal hex strings.
- Call `initTheme()` in the boot section alongside `loadDriftItems()` / `loadSession()`.

---

## Functions impacted

**Modified**
- `renderAmortChart()` — replace every hardcoded hex colour in `options.plugins.legend.labels.color`, `options.plugins.tooltip.*Color`, `options.scales.x.grid.color`, `options.scales.x.ticks.color`, `options.scales.y.grid.color`, `options.scales.y.ticks.color` with a helper call that reads CSS variable values at render time.
- `openFullscreenChart()` — same chart-colour concerns apply since it clones options via `JSON.parse(JSON.stringify(...))`, which would freeze the light-mode values. It must also call the theme-colour helper when building its own Chart instance.
- `calc()` — the LTV bar sets `ltvBar.style.background` with literal hex strings (`'#8b4a1a'`, `'#b87a2a'`, `'#2d5a3d'`). Replace with `var(--warn)`, `var(--warn-light)` (new variable), and `var(--accent)` so the bar respects dark-mode palette.

**New**
- `initTheme()` — reads localStorage, sets `document.documentElement.dataset.theme`, syncs button state.
- `toggleTheme()` — flips theme, persists, syncs button, calls `renderAmortChart()` if `amortChartInstance` is not null.
- `getChartColors()` — helper that reads `getComputedStyle(document.documentElement)` to return a plain object of colours needed by Chart.js (grid colour, tick colour, tooltip bg, tooltip border, tooltip title colour, tooltip body colour, legend label colour). Centralising this avoids duplicating CSS-variable reads in both chart functions.

---

## localStorage
- **New key**: `bostadskalkyl_theme` — stores `"dark"` or `"light"` (or absent, meaning light).
- No existing keys affected.

---

## New DOM elements

**New IDs**
- `themeToggleBtn` — the toggle `<button>` in the header.

**New CSS classes**
- `.theme-toggle-btn` — styles the icon button (ghost style, square, slightly smaller padding than `.btn`, holds a sun/moon icon via text character or SVG).

---

## Dark-mode colour palette

These overrides go inside `[data-theme="dark"] { ... }` on `:root`:

| Variable | Light value | Dark value |
|---|---|---|
| `--ink` | `#1a1a18` | `#e8e6df` |
| `--ink-mid` | `#4a4a46` | `#b0aea6` |
| `--ink-soft` | `#8a8a84` | `#7a7a72` |
| `--ink-faint` | `#c8c8c0` | `#4e4e48` |
| `--paper` | `#f7f5ef` | `#1c1c1a` |
| `--paper-warm` | `#efeee6` | `#242420` |
| `--paper-card` | `#faf9f4` | `#212120` |
| `--accent` | `#2d5a3d` | `#4a8a5e` |
| `--accent-light` | `#4a8a5e` | `#6aaa7e` |
| `--accent-faint` | `#e8f0eb` | `#1e2e22` |
| `--warn` | `#8b4a1a` | `#c4723a` |
| `--warn-faint` | `#f5ece3` | `#2e2018` |
| `--rule` | `#d8d6ce` | `#333330` |
| `--input-focus-bg` | `#ffffff` | `#2a2a28` |

`--input-focus-bg` is a new variable; both `:root` blocks define it so the focus background rule can use it.

A new `--warn-light` variable (`#b87a2a` in light mode, `#d4923a` in dark mode) should also be introduced to replace the intermediate amber hex in the LTV bar logic.

A new `--modal-backdrop` variable should also be added (`rgba(26,26,24,0.45)` in light, `rgba(0,0,0,0.65)` in dark) and referenced in `.modal-backdrop`, `.save-prompt`, and `.chart-fullscreen-backdrop`.

---

## Implementation order

1. In the CSS `:root` block, add the new variables: `--input-focus-bg: #ffffff`, `--warn-light: #b87a2a`, `--modal-backdrop: rgba(26,26,24,0.45)`.
2. Change the `input[type="text"]:focus, input[type="number"]:focus` background rule from `#fff` to `var(--input-focus-bg)`.
3. Add the full `[data-theme="dark"] { ... }` block after the `:root` block, with all variables from the table above plus `--input-focus-bg`, `--warn-light`, and `--modal-backdrop`.
4. Replace hardcoded rgba in `.modal-backdrop`, `.save-prompt`, and `.chart-fullscreen-backdrop` with `var(--modal-backdrop)`.
5. Add `.theme-toggle-btn` CSS rule (ghost style, square, `width: 36px; height: 36px; padding: 0; font-size: 18px;`).
6. Add the `<button id="themeToggleBtn" class="btn theme-toggle-btn" onclick="toggleTheme()" title="Toggle dark mode">☀</button>` element inside `.header-actions` before the Scenarios button.
7. Add the `getChartColors()` JS helper function that reads CSS variable computed values and returns the named colour object (with `.trim()` on returned values).
8. Refactor `renderAmortChart()` to call `getChartColors()` at the top of the function and replace all inline hex literals in Chart.js options with references to the returned object.
9. Refactor `openFullscreenChart()` in the same way — it must call `getChartColors()` and rebuild options rather than naively cloning the existing instance's frozen options.
10. In `calc()`, replace the three literal hex strings in `ltvBar.style.background = ...` with `var(--warn)`, `var(--warn-light)`, and `var(--accent)`.
11. Add `initTheme()` function (reads localStorage, sets `document.documentElement.dataset.theme`, updates button icon: `☀` for light, `☾` for dark).
12. Add `toggleTheme()` function (flips theme on `document.documentElement.dataset.theme`, persists to localStorage, updates button icon, calls `renderAmortChart()` if chart exists).
13. In the boot section at the bottom of the script, add a call to `initTheme()` as the first line before `loadDriftItems()`.

---

## Risks

- **Chart re-render on toggle**: `openFullscreenChart()` currently deep-clones `amortChartInstance.config.options`. Step 9 must ensure the fullscreen chart calls `getChartColors()` fresh, not clone from the existing instance.
- **CSS variable resolution in getChartColors()**: `getComputedStyle(document.documentElement).getPropertyValue('--rule')` returns a string with potential leading whitespace. The helper must call `.trim()` on all returned values.
- **System preference vs explicit toggle**: This plan uses only an explicit button. localStorage key takes precedence.
- **LTV bar inline styles**: Inline style assignments do honour `var(--name)` syntax — step 10 uses that.
- **Modal backdrop colours**: Folded into step 3 and step 4.

---

```
PLAN COMPLETE: title=dark-mode-toggle-with-localstorage-persistence, type=feature
```
