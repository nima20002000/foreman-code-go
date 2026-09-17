import { useState, useCallback, useMemo, useRef, useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ToastContext, type ToastInput } from './toastContext'
import { Icon } from './Icon'
import { IconButton, Button } from './Button'

/** Notifications persist until dismissed. Actionable/error messages never disappear on a timer. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<(ToastInput & { id: string })[]>([])
  const prefix = useId()
  const sequence = useRef(0)
  const notify = useCallback((toast: ToastInput) => {
    const id = `${prefix}-${++sequence.current}`
    setToasts((previous) => [...previous, { ...toast, id }])
    return id
  }, [prefix])
  const dismiss = useCallback((id: string) => setToasts((previous) => previous.filter((toast) => toast.id !== id)), [])
  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss])
  return <ToastContext.Provider value={value}>{children}{typeof document !== 'undefined' && createPortal(
    <ol className="n-theme n-toasts" aria-label="Notifications" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => <li key={toast.id} className="n-toast" data-tone={toast.tone ?? 'neutral'}>
        <span className="n-toast-icon"><Icon name={toast.tone === 'success' ? 'check' : toast.tone === 'danger' ? 'warning' : 'info'} /></span>
        <div><strong>{toast.title}</strong>{toast.description && <p>{toast.description}</p>}{toast.action && <Button size="sm" variant="ghost" onClick={toast.action.onClick}>{toast.action.label}</Button>}</div>
        <IconButton size="sm" variant="ghost" label={`Dismiss ${toast.title}`} onClick={() => dismiss(toast.id)}><Icon name="close" size={16} /></IconButton>
      </li>)}
    </ol>, document.body)}</ToastContext.Provider>
}
