import { recordIntegrationStartup } from './integration-startup.mjs'

export default class IntegrationStartupReporter {
  firstCase = true

  onTestModuleCollected() {
    recordIntegrationStartup('module-collected')
  }

  onTestCaseReady() {
    if (!this.firstCase) return
    this.firstCase = false
    recordIntegrationStartup('first-case-ready')
  }
}
