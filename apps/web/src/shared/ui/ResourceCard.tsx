import { cloneElement, useId, type ComponentProps, type HTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { Card, Checkbox, Icon, IconButton, cx, type ButtonProps, type IconName } from './nocturne'
import './resourceCard.css'

interface ResourceCardProps extends HTMLAttributes<HTMLDivElement> {
  name: string
  icon: IconName
  open?: ReactElement<{ className?: string; children?: ReactNode; title?: string }>
  actions?: ReactNode
  selection?: Omit<ComponentProps<typeof Checkbox>, 'label' | 'className'> & { mode?: 'replace' | 'hover' | 'visible' }
  protection?: { label: string; reason?: string }
}

/** Directory presentation only: callers own routing, selection and commands. */
export function ResourceCard({ name, icon, open, actions, selection, protection, className, children, ...props }: ResourceCardProps) {
  const { mode = 'replace', ...checkboxProps } = selection ?? {}
  const replacesIdentity = selection && mode === 'replace'
  const compactSelection = selection && mode !== 'replace'
  const identity = <><Icon name={icon} size={16} /><span className="resource-card-name">{name}</span></>
  return <Card {...props} className={cx('resource-card', selection?.checked && 'is-selected', selection && mode !== 'hover' && 'is-selecting', compactSelection && 'has-compact-selection', className)}>
    {compactSelection ? <div className={cx('resource-card-selection-slot', mode === 'hover' && 'is-hover-selection')}
      onClick={(event) => event.stopPropagation()}><Checkbox {...checkboxProps} label={name} title={name} className="resource-card-compact-select" /></div> : null}
    {replacesIdentity ? <Checkbox {...checkboxProps} label={name} title={name} className="resource-card-select" />
      : open ? cloneElement(open, { className: cx('resource-card-open', open.props.className), title: name, children: identity })
        : <div className="resource-card-open" title={name}>{identity}</div>}
    {!replacesIdentity && actions ? <div className="resource-card-actions">{actions}</div> : null}
    {protection ? <span className="resource-card-protection" role="img" aria-label={protection.label}
      title={protection.reason ?? protection.label}><Icon name="lock" size={14} /></span> : null}
    {children}
  </Card>
}

export function TrashIconButton({ target, action = 'Delete', disabledReason, className, ...props }:
  Omit<ButtonProps, 'children' | 'leading' | 'trailing' | 'variant' | 'size' | 'title' | 'aria-label'> & {
    target: string
    action?: string
    disabledReason?: string
  }) {
  const reasonId = useId()
  const label = `${action} ${target}`
  return <span className="resource-trash-control" title={disabledReason ?? label}>
    <IconButton {...props} disabled={props.disabled || Boolean(disabledReason)} label={label} title={disabledReason ?? label} variant="ghost" size="sm"
      aria-describedby={[props['aria-describedby'], disabledReason ? reasonId : undefined].filter(Boolean).join(' ') || undefined}
      className={cx('resource-trash-button', className)}><Icon name="trash" size={14} /></IconButton>
    {disabledReason ? <span id={reasonId} className="visually-hidden">{disabledReason}</span> : null}
  </span>
}
