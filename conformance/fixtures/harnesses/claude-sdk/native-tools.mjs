import { constants } from 'node:fs'
import { open, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

function within(root, path) {
  const selected = relative(root, path)
  return selected !== '..' && !selected.startsWith('../') && !isAbsolute(selected)
}

/** A limited native Write fixture. It creates a new real file after the caller's
 * delivered tool policy permits it; it cannot overwrite files or escape this target. */
export async function writeClaudeOwnedFile(input, options, signal, selectedScope) {
  signal.throwIfAborted()
  if (options.sandbox?.enabled !== false) throw new Error('Fake Claude cannot write under an unqualified sandbox mode.')
  if (!Array.isArray(options.tools) || !options.tools.includes('Write') || typeof options.canUseTool !== 'function') {
    throw new Error('Fake Claude Write requires a declared tool and its delivered permission callback.')
  }
  const scope = selectedScope ?? JSON.parse(await readFile(new URL('fixture-scope.json', import.meta.url), 'utf8'))
  const target = input?.file_path
  const content = input?.content
  if (typeof target !== 'string' || !isAbsolute(target) || /[\0\r\n]/.test(target)
    || typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) {
    throw new Error('Fake Claude Write requires a bounded absolute file request.')
  }
  const root = await realpath(scope.directory)
  const cwd = await realpath(options.cwd)
  const parentPath = await realpath(dirname(target))
  if (root !== scope.directory || cwd !== options.cwd || parentPath !== dirname(target)
    || !within(root, cwd) || !within(root, target) || !within(root, parentPath)) {
    throw new Error('Fake Claude Write must remain inside this isolated target without symlinks.')
  }
  const parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let file
  let result
  const failures = []
  try {
    signal.throwIfAborted()
    file = await open(join('/proc/self/fd', String(parent.fd), basename(target)),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Fake Claude Write did not create a private regular file.')
    signal.throwIfAborted()
    await file.writeFile(content, 'utf8')
    result = { filePath: target, bytesWritten: Buffer.byteLength(content) }
  } catch (error) { failures.push(error) }
  try { await file?.close() } catch (error) { failures.push(error) }
  try { await parent.close() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Fake Claude Write and descriptor cleanup failed.')
  return result
}
