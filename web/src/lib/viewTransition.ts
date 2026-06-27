// Tags <html> with the navigation direction so transitions.css can scope the
// dolly keyframes — the forward dive vs the back collapse want different motion
// on the same pseudo-elements (`new(root)` is the dashboard on the way in but
// the hub on the way back). React Router drives document.startViewTransition()
// internally and doesn't hand us its `.finished` promise, so we clear the tag on
// a timer sized just past the transition window rather than on a real end event.

let clearTimer: ReturnType<typeof setTimeout> | undefined

/** Call synchronously in the click handler, before the navigation begins. */
export function markVtDirection(dir: 'forward' | 'back'): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.vtDir = dir
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    delete document.documentElement.dataset.vtDir
  }, 760)
}
