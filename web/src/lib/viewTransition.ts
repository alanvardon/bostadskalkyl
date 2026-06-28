// Tags <html> with the navigation direction so transitions.css can scope the
// shared-element "whoosh" — forward the dashboard grows OUT of the card's slot,
// back it shrinks INTO it, and the two directions want different opacity timing
// on the same pseudo-elements. React Router drives document.startViewTransition()
// internally and doesn't hand us its `.finished` promise, so we clear the tag on
// a timer sized just past the transition window.

let clearTimer: ReturnType<typeof setTimeout> | undefined

/** Call synchronously in the click handler, before navigation begins. */
export function markVtDirection(dir: 'forward' | 'back'): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.dataset.vtDir = dir
  // Clear comfortably AFTER the View Transition finishes. React Router owns the
  // transition and doesn't hand us its `.finished` promise, so we time it off the
  // CSS `--vt-dur` (+ a generous buffer for VT setup / first-render latency).
  // Clearing too early unscopes the per-direction keyframes mid-zoom → the old
  // content reverts to the UA cross-fade and "pops"/flashes. Erring long is
  // harmless: the next navigation overwrites the value anyway. The hardcoded 820
  // ms used to tie with the (now slower) --vt-dur, which caused exactly that race.
  const durMs = parseFloat(getComputedStyle(el).getPropertyValue('--vt-dur')) || 540
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    delete el.dataset.vtDir
  }, durMs + 700)
}
