import { it, expect } from 'vitest'
import { loadedChunks, plainLog, processLabel, jobWriteUncertain } from './model'
import { ApiError } from '../../shared/api/client'
import { execution, logPage } from './fixtures'

it('keeps missing owner configuration actionable while retaining unknown network and server acknowledgments', () => {
  expect(jobWriteUncertain(new ApiError({ code: 'JOB_QUEUE_UNAVAILABLE', message: 'Owner review required' }, 503))).toBe(false)
  expect(jobWriteUncertain(new ApiError({ code: 'NETWORK_ERROR', message: 'Disconnected' }))).toBe(true)
  expect(jobWriteUncertain(new ApiError({ code: 'INTERNAL_ERROR', message: 'Unknown acknowledgment' }, 503))).toBe(true)
})

it('deduplicates reconnect chunks while retaining Unicode and stream labels', () => {
  expect(loadedChunks([logPage, logPage])).toEqual(logPage.chunks)
  expect(plainLog('\u001b[31mλ🙂<img src=x>\u001b[0m\u001b]0;unsafe\u0007\u0000')).toBe('λ🙂<img src=x>')
})
it('keeps cancellation intent separate from observed stop and transport', () => {
  const offline = { ...execution, transport: 'offline' as const, cancelRequestedAt: execution.createdAt, process: { ...execution.process, phase: 'running' as const, outcome: null, processStopped: false } }
  expect(processLabel(offline)).toBe('Cancellation requested · stop unconfirmed')
  expect(processLabel({ ...offline, process: { ...offline.process, phase: 'terminal', outcome: 'cancelled', processStopped: true } })).toBe('Cancellation confirmed')
})
it('nonzero observed exit remains build failure despite connection loss', () => {
  expect(processLabel({ ...execution, transport: 'offline' })).toBe('build failed')
})
it('preserves long unbroken Unicode text within the contract chunk bound', () => {
  const text = '🙂λ'.repeat(10000)
  expect(plainLog(text)).toBe(text)
  expect(loadedChunks([{ ...logPage, chunks: [{ ...logPage.chunks[0]!, text }] }])[0]?.text).toBe(text)
})
