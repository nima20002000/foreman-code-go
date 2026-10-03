import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reviewWithApproval } from './label-approval.mjs'

describe('label approval', () => {
  const base = { findings: ['apps/web/eslint.config.mjs'], findingsSincePreviousPush: [], isNewPush: false }

  it('passes when there is nothing to approve', () => {
    const result = reviewWithApproval({ ...base, findings: [], approved: false })
    assert.deepEqual(result, { pass: true, revokeApproval: false })
  })

  it('fails findings until the approval label is present', () => {
    assert.equal(reviewWithApproval({ ...base, approved: false }).pass, false)
    assert.equal(reviewWithApproval({ ...base, approved: true }).pass, true)
  })

  it('keeps approval when a later push adds no findings', () => {
    const result = reviewWithApproval({ ...base, isNewPush: true, findingsSincePreviousPush: [], approved: true })
    assert.deepEqual(result, { pass: true, revokeApproval: false })
  })

  it('revokes approval when a later push adds findings', () => {
    const result = reviewWithApproval({
      ...base, isNewPush: true, findingsSincePreviousPush: ['apps/web/eslint.config.mjs'], approved: true,
    })
    assert.deepEqual(result, { pass: false, revokeApproval: true })
  })

  it('revokes approval when the previous head cannot be compared', () => {
    const result = reviewWithApproval({
      ...base, isNewPush: true, findingsSincePreviousPush: undefined, approved: true,
    })
    assert.deepEqual(result, { pass: false, revokeApproval: true })
  })
})
