import { ChatRetentionSettings } from '../retention-settings'
import './settingsExperience.css'

export function GeneralSettings() {
  return <section className="settings-editor-page" aria-label="General settings">
    <header className="settings-experience-heading"><h1>General</h1>
      <p>Manage application preferences.</p></header>
    <div className="settings-editor-content"><ChatRetentionSettings /></div>
  </section>
}
