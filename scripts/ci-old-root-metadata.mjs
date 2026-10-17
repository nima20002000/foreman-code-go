import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
const parent = join(await realpath(homedir()), '.cache/foreman-main-go-diagnostic')
const root = join(parent, 'g-fDwDez')
const facts = { sourceTicket: 'e88097a3-9797-4568-9831-e83825b68916',
  failedCleanupTicket: '2b807e6b-ee72-4d85-83b0-f42398643797', rootName: 'g-fDwDez',
  currentUid: process.getuid(), observedAt: new Date().toISOString(), observations: [],
  fileContentsRead: false, changesMade: false, testsExecuted: 0 }
async function observe(name, path) {
  try {
    const info = await lstat(path)
    facts.observations.push({ name, uid: info.uid, mode: info.mode & 0o777,
      directory: info.isDirectory(), symbolicLink: info.isSymbolicLink() })
    return info
  } catch (error) { facts.observations.push({ name, errorCode: error.code }) }
}
await observe('parent', parent)
const info = await observe('old-root', root)
if (info?.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid()) {
  facts.immediateRemainingEntries = (await readdir(root, { withFileTypes: true }))
    .map(entry => ({ name: entry.name, directory: entry.isDirectory(), symbolicLink: entry.isSymbolicLink() }))
  for (const name of ['modules', 'modules/github.com/nlnwa/whatwg-url@v0.6.2/.github',
    'compiler-cache', 'compiler-cache/toolchains/go1.27.2/bin/go', 'caller-sentinel', 'selected.vitest.json']) {
    await observe(name, join(root, name))
  }
}
console.log('[old-root-observation] ' + JSON.stringify(facts))
