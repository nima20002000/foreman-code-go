import { useEffect, useState, type SetStateAction } from 'react'

interface Snapshot<T> { value: T; revision: number }
interface Form<T> { value: T; base: Snapshot<T> }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }

export function refreshRevisionedForm<T>(current: Form<T> | undefined, incoming: Snapshot<T>): Form<T> {
  if (current && incoming.revision < current.base.revision) return current
  if (!current || same(current.value, current.base.value)) return { value: incoming.value, base: incoming }
  return current
}

/** Values and their optimistic-concurrency revision always travel together. */
export function useRevisionedForm<T>(incoming: Snapshot<T> | undefined) {
  const [form, setForm] = useState<Form<T>>()
  const incomingKey = JSON.stringify(incoming)
  const dirty = Boolean(form && !same(form.value, form.base.value))
  useEffect(() => {
    if (!incoming) return
    setForm((current) => {
      const next = refreshRevisionedForm(current, incoming)
      return same(next, current) ? current : next
    })
    // The serialized key tracks snapshot content rather than wrapper identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey, dirty])
  return {
    draft: form?.value,
    baseRevision: form?.base.revision,
    isDirty: Boolean(form && !same(form.value, form.base.value)),
    conflicted: Boolean(form && incoming && form.base.revision !== incoming.revision && !same(form.value, form.base.value)),
    setDraft: (next: SetStateAction<T | undefined>) => setForm((current) => {
      if (!current) return current
      const value = typeof next === 'function' ? (next as (value: T) => T | undefined)(current.value) : next
      return value === undefined ? current : { ...current, value }
    }),
    acknowledge: (submitted: T, value: T, revision: number) => setForm((current) => ({
      value: !current || same(current.value, submitted) ? value : current.value,
      base: { value, revision },
    })),
    reset: () => { if (incoming) setForm({ value: incoming.value, base: incoming }) },
  }
}
