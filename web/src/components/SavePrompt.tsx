import { useEffect, useState } from 'react'
import { Dialog } from 'radix-ui'
import AnimatedDialog from './AnimatedDialog'

interface Props {
  open: boolean
  mode: 'new' | 'update'
  activeName: string
  onOpenChange: (open: boolean) => void
  onSaveNew: (name: string) => void
  onUpdate: () => void
}

export default function SavePrompt({ open, mode, activeName, onOpenChange, onSaveNew, onUpdate }: Props) {
  const [name, setName] = useState('')

  // Clear the field each time the prompt opens.
  useEffect(() => {
    if (open) setName('')
  }, [open])

  const confirm = () => {
    if (mode === 'update' && !name.trim()) onUpdate()
    else onSaveNew(name)
    onOpenChange(false)
  }

  return (
    <AnimatedDialog open={open} onOpenChange={onOpenChange} contentClassName="save-prompt-box">
      <Dialog.Title className="save-prompt-title">
        {mode === 'update' ? (
          <>
            Update <em>{activeName}</em> or save as new?
          </>
        ) : (
          'Save scenario'
        )}
      </Dialog.Title>
      <input
        type="text"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm()
        }}
        placeholder={
          mode === 'update'
            ? 'Leave blank to update, or enter a new name…'
            : 'e.g. Lidingö house, Scenario A…'
        }
        aria-label="Scenario name"
      />
      <div className="save-prompt-actions">
        <Dialog.Close className="btn btn-ghost">Cancel</Dialog.Close>
        <button className="btn btn-primary" onClick={confirm}>
          Save
        </button>
      </div>
    </AnimatedDialog>
  )
}
