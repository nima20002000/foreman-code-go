/** Runs inside the namespace before any native code. execve keeps the verified
 * filesystem and capability restrictions for OpenCode and all its descendants.
 */
export const openCodeIsolationHost = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const input = JSON.parse(process.argv[1])
const check = (condition) => {
  if (!condition) throw new Error('OpenCode file namespace verification failed.')
}
const status = fs.readFileSync('/proc/self/status', 'utf8')
check(/^CapEff:\s+0+$/m.test(status) && /^CapPrm:\s+0+$/m.test(status)
  && /^CapBnd:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status))
for (const name of ['mnt', 'pid', 'user']) {
  check(fs.readlinkSync('/proc/self/ns/' + name) !== input.namespaces[name])
}
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map((line) => {
  const [mount, filesystem] = line.split(' - ')
  const fields = mount.split(' ')
  return {
    path: fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))),
    options: fields[5].split(','),
    type: filesystem.split(' ')[0],
  }
})
const vault = mounts.findLast((mount) => mount.path === input.root)
check(vault && vault.type === 'tmpfs' && vault.options.includes('ro'))
check(input.ancestors.every((parent) => mounts.some((mount) => mount.path === parent)))
check(mounts.some((mount) => mount.path === '/proc' && mount.type === 'proc'))
const hidden = fs.lstatSync(input.root)
check(hidden.isDirectory() && (hidden.dev !== input.source.dev || hidden.ino !== input.source.ino))
check(fs.readdirSync(input.root).length === 0)
if (input.materializations) {
  const managed = mounts.findLast((mount) => mount.path === input.materializations.root)
  check(managed && managed.type === 'tmpfs' && managed.options.includes('ro'))
  check(fs.readdirSync(input.materializations.root).join('') === path.basename(input.materializations.owned))
  const owner = fs.lstatSync(input.materializations.owned)
  check(owner.isDirectory() && owner.dev === input.materialized.dev && owner.ino === input.materialized.ino)
  check(mounts.some((mount) => mount.path === input.materializations.owned && mount.options.includes('rw')))
}
if (input.storage) {
  const managed = mounts.findLast((mount) => mount.path === input.storage.root)
  check(managed && managed.type === 'tmpfs' && managed.options.includes('ro'))
  check(fs.readdirSync(input.storage.root).join('') === path.basename(input.storage.owned))
  const owner = fs.lstatSync(input.storage.owned)
  check(owner.isDirectory() && owner.dev === input.stored.dev && owner.ino === input.stored.ino)
  check(mounts.some((mount) => mount.path === input.storage.owned && mount.options.includes('rw')))
  for (const hidden of input.storage.hidden) {
    const mount = mounts.findLast((mount) => mount.path === hidden)
    check(mount && mount.options.includes('ro'))
    if (fs.lstatSync(hidden).isDirectory()) check(fs.readdirSync(hidden).length === 0)
    else check(fs.readFileSync(hidden).length === 0)
  }
}
for (const directory of input.directories) {
  const stat = fs.lstatSync(directory.path)
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === directory.dev && stat.ino === directory.ino)
}
let binary = input.binary
if (binary.includes('/')) {
  binary = path.resolve(input.workingDirectory, binary)
} else {
  binary = process.env.PATH.split(path.delimiter).map((parent) => path.join(parent, binary)).find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return true
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return false
      throw error
    }
  })
}
check(binary && typeof process.execve === 'function')
fs.writeSync(1, 'opencode vault ready ' + input.nonce + '\n')
process.execve(binary, [binary, ...input.args], process.env)
`
