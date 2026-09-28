import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { test } from 'vitest'
import { byteRange, completedBytes } from '../src/modules/files/tools/transfers.js'

test('completed stream preserves exact bytes and empty files', async () => {
  assert.equal((await completedBytes(Readable.from([Buffer.from('a'), Buffer.from('bc')]), 3)).toString(), 'abc')
  assert.equal((await completedBytes(Readable.from([]), 3)).length, 0)
})
test('completed snapshots detach producer-owned buffers', async () => {
  const value = Buffer.from('aa')
  const stream = Readable.from((async function* () { yield value; value.fill('b'); yield value })())
  assert.equal((await completedBytes(stream, 4)).toString(), 'aabb')
})
test('interrupted stream never returns partial bytes', async () => {
  const stream = Readable.from((async function* () { yield Buffer.from('half'); throw new Error('interrupted') })())
  await assert.rejects(completedBytes(stream, 20), /interrupted/)
})
test('oversized stream is rejected and destroyed', async () => {
  const stream = Readable.from([Buffer.alloc(5)])
  await assert.rejects(completedBytes(stream, 4), { code: 'FILE_TOO_LARGE' })
  assert.equal(stream.destroyed, true)
})
test('already aborted write does not consume data', async () => {
  const signal = AbortSignal.abort()
  await assert.rejects(completedBytes(Readable.from([Buffer.from('no')]), 4, signal), { code: 'FILE_WRITE_INTERRUPTED' })
})
test('abort interrupts a writer that never reaches EOF', async () => {
  const controller = new AbortController(), stream = new PassThrough()
  const pending = completedBytes(stream, 20, controller.signal)
  stream.write('partial')
  controller.abort()
  await assert.rejects(pending, { code: 'FILE_WRITE_INTERRUPTED' })
})
test('string/object mode data cannot be silently reinterpreted as bytes', async () => {
  await assert.rejects(completedBytes(Readable.from(['not bytes']), 100), { code: 'FILE_WRITE_INVALID' })
})
test('bounded ranges span chunks and close their stream', async () => {
  const stream = Readable.from([Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')])
  assert.equal((await byteRange(stream, 2, 4)).toString(), 'cdef')
  assert.equal(stream.destroyed, true)
  assert.equal((await byteRange(Readable.from([Buffer.from('abc')]), 3, 4)).length, 0)
})
test('invalid sizes/ranges fail before reading', async () => {
  await assert.rejects(completedBytes(Readable.from([]), 0), RangeError)
  await assert.rejects(byteRange(Readable.from([]), -1, 5), RangeError)
  await assert.rejects(byteRange(Readable.from([]), 0, 0), RangeError)
})
