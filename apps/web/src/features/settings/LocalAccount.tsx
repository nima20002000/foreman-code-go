import { ChatRetentionSettings } from '../retention-settings'
import './settingsExperience.css'

export function LocalAccount() {
  return <section className="settings-editor-page" aria-label="Local preferences">
    <header className="settings-experience-heading"><h1>Local preferences</h1>
      <p>This installation uses one local human. No sign-in is required.</p></header>
    <div className="settings-editor-content"><ChatRetentionSettings /></div>
  </section>
}
