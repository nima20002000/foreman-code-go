import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readNativeUserFile } from './nativeConfigFiles.js'
import { parseConfigObject } from './opencodeProtocol.js'
import { fingerprint, record, type JsonObject } from './nativeMcpCommon.js'

/** Conservative source ownership for the qualified OpenCode native config loader.
 * A duplicate definition is not safe to remove, even if its resolved value is equal.
 * Contents stay private; callers persist only the aggregate fingerprint.
 */
export async function inspectOpenCodeMcpSources(directory: string, configDirectory: string,
  selectedFile: string, user: JsonObject, signal: AbortSignal) {
  const candidates = new Set<string>()
  const configFiles = (dir: string) => {
    candidates.add(join(dir, 'opencode.json')); candidates.add(join(dir, 'opencode.jsonc'))
  }
  configFiles(configDirectory); candidates.add(join(configDirectory, 'config.json'))
  configFiles(join(homedir(), '.opencode'))
  // Scan to the filesystem root rather than guessing the provider's worktree.
  // This may conservatively mark a lower/out-of-worktree entry as inherited.
  let current = resolve(directory)
  for (let depth = 0; ; depth++) {
    if (depth >= 128) throw new Error('OpenCode configuration ancestry exceeds the inspection limit.')
    configFiles(current); configFiles(join(current, '.opencode'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (process.env.OPENCODE_CONFIG) candidates.add(resolve(directory, process.env.OPENCODE_CONFIG))
  if (process.env.OPENCODE_CONFIG_DIR) configFiles(resolve(directory, process.env.OPENCODE_CONFIG_DIR))
  const managedDirectory = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR ?? (process.platform === 'darwin'
    ? '/Library/Application Support/opencode' : process.platform === 'win32'
      ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'opencode') : '/etc/opencode')
  configFiles(managedDirectory)
  const ownership = Object.fromEntries(Object.keys(user).map((name) => [name, true]))
  const evidence: Array<[string, string]> = []
  const inspect = (name: string, contents: string) => {
    evidence.push([name, fingerprint(contents)])
    if (!contents.trim()) return
    const config = parseConfigObject(contents)
    for (const member of Object.keys(record(config.mcp))) {
      if (Object.hasOwn(user, member)) ownership[member] = false
    }
  }
  for (const file of [...candidates].sort()) {
    signal.throwIfAborted()
    if (resolve(file) === resolve(selectedFile)) continue
    inspect(file, await readNativeUserFile(file, { whenMissing: '{}\n' }))
  }
  if (process.env.OPENCODE_CONFIG_CONTENT) inspect('OPENCODE_CONFIG_CONTENT', process.env.OPENCODE_CONFIG_CONTENT)
  return { ownership, revision: fingerprint(evidence) }
}
