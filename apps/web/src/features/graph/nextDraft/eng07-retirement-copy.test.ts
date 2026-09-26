import { describe, expect, it } from 'vitest'
import editorSource from './NextDraftEditor.tsx?raw'

// Copy/wording guard, not a substitute for mounted Board Stop/settlement tests.
describe('ENG07 R07 Board Save wording', () => {
  it('does not promise a meaningful Save while affected Runs continue', () => {
    expect(editorSource).not.toContain('Saved changes apply to the next run. A run that already started keeps its settings.')
    expect(editorSource).not.toContain('Saved. Runs that already started are unchanged.')
    expect(editorSource).toContain('Executable changes require every affected Run to stop and finish cleanup before Save.')
    expect(editorSource).toContain('Stop-and-save stops every affected Run and waits for full cleanup before saving.')
    expect(editorSource).toContain('Stopped runs are not restarted.')
  })
  it('keeps independent layout and safe Discard distinct from executable publication', () => {
    expect(editorSource).toContain('Moving Agents on the Board does not require Stop.')
    expect(editorSource).toContain('Your unsaved edits are removed. Agent positions on the board are kept. Running work isn’t affected.')
    expect(editorSource).toContain('Edits retained. Save waits for every affected Run to stop and finish cleanup.')
  })
})
