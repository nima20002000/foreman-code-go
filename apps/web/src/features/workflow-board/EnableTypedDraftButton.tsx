import { useContext } from 'react'
import { Button } from '../../shared/ui/nocturne'
import { UnsavedChangesContext } from '../../shared/ui/unsavedChanges'
import { useWorkflowBoard } from './context'

export function EnableTypedDraftButton() {
  const board = useWorkflowBoard(), guard = useContext(UnsavedChangesContext)
  if (!board) return null
  return <Button variant="secondary" onClick={() => {
    void (async () => { if (!guard || await guard.request()) board.requestConversion() })()
  }}>Enable parallel execution</Button>
}
