import { useEffect, useRef, type ReactNode } from 'react'
import type { HarnessSettingsSection } from '@graphql/contracts/management'
import { Button, Icon } from '../../shared/ui/nocturne'
import { harnessSections } from './settingsPresentation'
import './settingsExperience.css'

export function SettingsOverview({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="settings-overview" aria-label={title}>
    <header className="settings-experience-heading"><h1>{title}</h1><p>{description}</p></header>
    <div className="settings-choice-grid">{children}</div>
  </section>
}
export function SettingsChoice({ title, description, summary, onSelect, draftStatus, icon = 'bot' }: {
  title: string; description: string; summary: readonly { label: string; value: string }[];
  onSelect(): void; draftStatus?: string; icon?: 'bot' | 'settings';
}) {
  return <button type="button" className="settings-choice" onClick={onSelect} aria-label={`Edit ${title} defaults`}>
    <span className="settings-choice-heading"><span className="settings-choice-icon"><Icon name={icon} size={21} /></span>
      <span><strong>{title}</strong><small>{description}</small></span><Icon name="chevron" size={17} /></span>
    <span className="settings-choice-summary">{summary.map((item) => <span className="settings-summary-row" key={item.label}><span>{item.label}</span><strong title={item.value}>{item.value}</strong></span>)}</span>
    <span className="settings-choice-action">{draftStatus ? <span className="settings-draft-badge">{draftStatus}</span> : 'Edit defaults'} <span aria-hidden="true">→</span></span>
  </button>
}

/** One page heading, one section navigation, one content surface. No card-inside-card editor. */
export function SettingsEditorLayout({ title, description, backLabel, onBack, section, onSectionChange,
  connections = false, children, feedback, footer,
}: {
  title: string; description: string; backLabel: string; onBack(): void;
  section: HarnessSettingsSection; onSectionChange(section: HarnessSettingsSection): void;
  connections?: boolean; children: ReactNode; feedback?: ReactNode; footer: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const sectionRef = useRef<HTMLHeadingElement>(null)
  const first = useRef(true)
  const sections = harnessSections.filter((entry) => connections || !['connections', 'workspace'].includes(entry.id))
  const active = sections.find((entry) => entry.id === section) ?? sections[0]!
  useEffect(() => { titleRef.current?.focus() }, [title])
  useEffect(() => {
    if (first.current) { first.current = false; return }
    sectionRef.current?.focus()
  }, [section])
  return <section className="settings-editor-page" aria-label={title}>
    <header className="settings-experience-heading">
      <Button variant="ghost" size="sm" onClick={onBack} leading={<span aria-hidden="true">←</span>}>{backLabel}</Button>
      <h1 ref={titleRef} tabIndex={-1}>{title}</h1><p>{description}</p>
    </header>
    {feedback}
    <div className="settings-editor-layout">
      <nav className="settings-editor-nav" aria-label={`${title} sections`}>
        {sections.map((item) => <button type="button" key={item.id} aria-current={item.id === active.id ? 'page' : undefined}
          onClick={() => onSectionChange(item.id)}>{item.label}<span aria-hidden="true">›</span></button>)}
      </nav>
      <section className="settings-editor-content" aria-labelledby={`settings-section-${active.id}`}>
        <header className="settings-section-heading"><h2 ref={sectionRef} tabIndex={-1} id={`settings-section-${active.id}`}>{active.label}</h2><p>{active.description}</p></header>
        {children}
      </section>
    </div>
    {footer}
  </section>
}
