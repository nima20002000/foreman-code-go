import { lstat, stat } from 'node:fs/promises'
const pid = 2032
const observations = []
for (const [name, path, observe] of [
  ['process-directory', `/proc/${pid}`, stat],
  ['cwd-link', `/proc/${pid}/cwd`, lstat],
  ['environ-entry', `/proc/${pid}/environ`, lstat],
]) {
  try {
    const info = await observe(path)
    observations.push({ name, uid: info.uid, gid: info.gid, mode: info.mode & 0o777,
      symbolicLink: info.isSymbolicLink(), directory: info.isDirectory() })
  } catch (error) { observations.push({ name, errorCode: error.code }) }
}
console.log('[process-observation] ' + JSON.stringify({ observedAt: new Date().toISOString(),
  currentUid: process.getuid(), pid, observations, historicalIdentityEstablished: false,
  fileContentsRead: false, changesMade: false, testsExecuted: 0 }))
