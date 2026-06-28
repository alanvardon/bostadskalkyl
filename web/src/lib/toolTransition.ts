import { useViewTransitionState } from 'react-router-dom'
import { activeVtTool } from './viewTransition'

// Hooks for naming a hub card or tool-page root during a whoosh transition so
// they both carry `view-transition-name: tool-card` at the right time.
//
// Forward trip: only the clicked card is named (useViewTransitionState(path)
// returns true only for that card's path). Back trip: ALL cards see
// useViewTransitionState('/') === true, so we gate on `activeVtTool()` to name
// only the card we are returning from.
//
// Rules-of-hooks: both useViewTransitionState calls run unconditionally.

export function useToolCardActive(path: string): boolean {
  const arriving = useViewTransitionState(path)
  const returning = useViewTransitionState('/')
  return arriving || (returning && activeVtTool() === path)
}

export function useToolPageActive(path: string): boolean {
  const arriving = useViewTransitionState(path)
  const returning = useViewTransitionState('/')
  return arriving || returning
}
