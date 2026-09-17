/** Lossless JSONC member editing. No eval, regex comment stripping, or whole-file rewrite. */
interface Member { key: string; start: number; value: Node; comma?: number }
interface Node { start: number; end: number; members?: Member[] }
function parse(source: string): Node {
  if (source.length > 1_048_576) throw new Error('Native configuration exceeds the 1 MiB editing limit.')
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const skip = () => {
    for (;;) {
      while (/\s/.test(source[i] ?? '') && i < source.length) i++
      if (source.slice(i, i + 2) === '//') { while (i < source.length && !/[\r\n]/.test(source[i]!)) i++; continue }
      if (source.slice(i, i + 2) === '/*') {
        const end = source.indexOf('*/', i + 2)
        if (end < 0) throw new Error('Unterminated native configuration comment.')
        i = end + 2; continue
      }
      break
    }
  }
  const string = () => {
    const start = i++
    for (; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue }
      if (source[i] === '"') { i++; return JSON.parse(source.slice(start, i)) as string }
    }
    throw new Error('Unterminated native configuration string.')
  }
  const value = (depth = 0): Node => {
    if (depth > 64) throw new Error('Native configuration nesting limit exceeded.')
    skip(); const start = i
    if (source[i] === '{') {
      i++; skip(); const members: Member[] = []; const keys = new Set<string>()
      while (source[i] !== '}') {
        if (source[i] !== '"') throw new Error('Native configuration must contain quoted object keys.')
        const memberStart = i; const key = string(); skip()
        if (keys.has(key)) throw new Error('Duplicate native configuration keys cannot be edited safely.')
        keys.add(key)
        if (source[i++] !== ':') throw new Error('Invalid native configuration member.')
        const child = value(depth + 1); skip()
        const member: Member = { key, start: memberStart, value: child }
        if (source[i] === ',') { member.comma = i++; skip() }
        else if (source[i] !== '}') throw new Error('Invalid native configuration separator.')
        members.push(member)
      }
      i++; return { start, end: i, members }
    }
    if (source[i] === '[') {
      i++; skip()
      while (source[i] !== ']') {
        value(depth + 1); skip()
        if (source[i] === ',') { i++; skip() }
        else if (source[i] !== ']') throw new Error('Invalid native configuration array.')
      }
      i++; return { start, end: i }
    }
    if (source[i] === '"') { string(); return { start, end: i } }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i))
    if (!match) throw new Error('Invalid native configuration value.')
    i += match[0].length
    return { start, end: i }
  }
  const root = value(); skip()
  if (i !== source.length || !root.members) throw new Error('Native configuration must be one JSONC object.')
  return root
}
function edit(source: string, node: Node, key: string, replacement: unknown | undefined): string {
  if (!node.members) throw new Error('The native MCP configuration is not an object.')
  const index = node.members.findIndex((member) => member.key === key)
  const member = node.members[index]
  if (member) {
    if (replacement !== undefined) return source.slice(0, member.value.start) + JSON.stringify(replacement, null, 2) + source.slice(member.value.end)
    if (member.comma !== undefined) return source.slice(0, member.start) + source.slice(member.comma + 1)
    const previous = node.members[index - 1]
    if (previous?.comma !== undefined) return source.slice(0, previous.comma) + source.slice(previous.comma + 1, member.start) + source.slice(member.value.end)
    return source.slice(0, member.start) + source.slice(member.value.end)
  }
  if (replacement === undefined) return source
  const last = node.members.at(-1)
  const comma = last && last.comma === undefined ? ',' : ''
  // Put a separator immediately after the value, before any trailing line comment.
  const insertion = last && last.comma === undefined ? last.value.end : node.end - 1
  const withSeparator = source.slice(0, insertion) + comma + source.slice(insertion)
  const closing = node.end - 1 + comma.length
  return withSeparator.slice(0, closing) + `\n  ${JSON.stringify(key)}: ${JSON.stringify(replacement, null, 2)}\n` + withSeparator.slice(closing)
}
export function editJsoncMcp(source: string, name: string, replacement: unknown | undefined): string {
  const root = parse(source)
  const mcp = root.members!.find((member) => member.key === 'mcp')
  const result = mcp ? edit(source, mcp.value, name, replacement)
    : replacement === undefined ? source : edit(source, root, 'mcp', { [name]: replacement })
  parse(result)
  return result
}
