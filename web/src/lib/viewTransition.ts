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
  document.documentElement.dataset.vtDir = dir
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    delete document.documentElement.dataset.vtDir
  }, 820)
}
