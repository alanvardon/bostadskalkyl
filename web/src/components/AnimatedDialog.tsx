import { Dialog } from 'radix-ui'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

// Radix Dialog wrapped so it animates on BOTH enter and exit. Radix unmounts
// content instantly on close, so it only ever played the CSS enter keyframe;
// here `forceMount` hands mount/unmount control to AnimatePresence, which keeps
// the node alive long enough to run the `exit` animation. Pattern per
// motion.dev/docs/radix. Respects prefers-reduced-motion (fade only, no travel).

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Class for the content surface — 'modal' (large) or 'save-prompt-box' (small). */
  contentClassName: string
  children: ReactNode
}

const EASE = [0.22, 1, 0.36, 1] as const

export default function AnimatedDialog({ open, onOpenChange, contentClassName, children }: Props) {
  const reduce = useReducedMotion()

  const content = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
    : {
        initial: { opacity: 0, y: 12, scale: 0.97 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 8, scale: 0.98 },
        transition: { duration: 0.28, ease: EASE },
      }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="modal-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0.15 : 0.22 }}
              >
                <Dialog.Content asChild forceMount aria-describedby={undefined}>
                  <motion.div className={contentClassName} {...content}>
                    {children}
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
