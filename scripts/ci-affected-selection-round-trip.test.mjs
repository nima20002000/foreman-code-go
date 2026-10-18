import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { readSelectionFile, validateAffectedSuite } from './ci-affected-scope.mjs'

test('affected selection JSON round trips preserve scripts database requirements', t => {
  const root = mkdtempSync(join(tmpdir(), 'affected-selection-round-trip-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const conformance = 'conformance/src/selected.ts'
  const script = 'scripts/selected.test.mjs'
  for (const file of [conformance, script]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'export {}\n')
  }
  const read = request => {
    writeFileSync(join(root, 'selection.json'), JSON.stringify(request))
    return readSelectionFile('selection.json', root)
  }

  for (const conformanceTsRequired of [false, true]) {
    const input = { files: [conformance], conformanceScenarios: ['fixture.health'], conformanceTsRequired }
    const normalized = read(input)
    assert.equal(normalized.scriptsDatabaseRequired, false)
    let restored
    assert.doesNotThrow(() => { restored = read(normalized) })
    assert.deepEqual(restored, normalized)
    assert.deepEqual(validateAffectedSuite('integration', restored, root), normalized)
    assert.deepEqual(read(restored), normalized)
    assert.deepEqual(read({ ...input, scriptsDatabaseRequired: false }), normalized)
    assert.throws(() => read({ ...input, scriptsDatabaseRequired: true }), /scripts database requirement/)
  }

  for (const scriptsDatabaseRequired of [false, true]) {
    const normalized = read({ files: [script], scriptsDatabaseRequired })
    assert.equal(normalized.scriptsDatabaseRequired, scriptsDatabaseRequired)
    assert.deepEqual(read(normalized), normalized)
    assert.deepEqual(validateAffectedSuite('unit-other', normalized, root), normalized)
  }
  for (const scriptsDatabaseRequired of [null, 'false', 'true', 0, 1, [], {}]) {
    assert.throws(() => read({ files: [script], scriptsDatabaseRequired }), /scripts database requirement/)
  }
})
