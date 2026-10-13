import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'

export default class CiProgressReporter {
  onInit(context) {
    this.root = process.env.CI_REPOSITORY_ROOT ?? context.config.root
  }

  record(type, entity) {
    if (!process.env.CI_PROGRESS_FILE) return
    const file = relative(this.root, (entity.type === 'module' ? entity : entity.module).moduleId).replaceAll('\\', '/')
    appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({
      type, id: `${process.pid}:${entity.id}`, file, name: entity.type === 'module' ? '' : entity.fullName, kind: entity.type,
    }) + '\n')
  }

  onTestModuleQueued(module) {
    this.record('start', module)
  }

  onTestModuleStart(module) {
    this.record('start', module)
  }

  onTestModuleEnd(module) {
    this.record('finish', module)
  }

  onTestCaseReady(test) {
    this.record('start', test)
  }

  onTestCaseResult(test) {
    this.record('finish', test)
  }
}
