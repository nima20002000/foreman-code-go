export function outputQueue() {
  const items = []
  let pending
  let closed = false
  let failure
  return {
    push(value) {
      if (closed) throw new Error('Fake Claude emitted after query closure.')
      if (pending) { pending.resolve({ value, done: false }); pending = undefined }
      else items.push(value)
    },
    close(error) {
      if (closed) return
      closed = true
      failure = error
      if (pending) {
        if (failure) pending.reject(failure)
        else pending.resolve({ value: undefined, done: true })
        pending = undefined
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false })
          if (failure) return Promise.reject(failure)
          if (closed) return Promise.resolve({ value: undefined, done: true })
          if (pending) return Promise.reject(new Error('Fake Claude has one output reader.'))
          return new Promise((resolve, reject) => { pending = { resolve, reject } })
        },
      }
    },
  }
}
