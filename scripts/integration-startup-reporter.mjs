import CiProgressReporter from './ci-progress-reporter.mjs'
import { recordIntegrationStartup } from './integration-startup.mjs'

export default class IntegrationStartupReporter extends CiProgressReporter {
  firstCase = true

  onTestModuleCollected() {
    recordIntegrationStartup('module-collected')
  }

  onTestCaseReady(test) {
    super.onTestCaseReady(test)
    if (!this.firstCase) return
    this.firstCase = false
    recordIntegrationStartup('first-case-ready')
  }
}
