import { createRequire } from 'node:module'

const ts = createRequire(new URL('../apps/api/package.json', import.meta.url))('typescript')

const SUITE_FUNCTIONS = new Set(['describe', 'suite'])
const TEST_FUNCTIONS = new Set(['it', 'test'])

// Resolves `it`, `it.only`, `it.each(table)` and `it.skipIf(condition)` to `it`.
function baseFunctionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return baseFunctionName(expression.expression)
  if (ts.isCallExpression(expression)) return baseFunctionName(expression.expression)
  return undefined
}

function title(call, sourceFile) {
  const [first] = call.arguments
  if (!first) return ''
  if (ts.isStringLiteralLike(first)) return first.text
  return first.getText(sourceFile)
}

function scriptKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

/** Lists each test definition in a file as "suite > nested suite > test", as written in the source. */
export function testDefinitions(path, text) {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path))
  const suites = []
  const definitions = []
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = baseFunctionName(node.expression)
      if (TEST_FUNCTIONS.has(name)) {
        definitions.push([...suites, title(node, sourceFile)].join(' > '))
        return
      }
      if (SUITE_FUNCTIONS.has(name)) {
        suites.push(title(node, sourceFile))
        ts.forEachChild(node, visit)
        suites.pop()
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return definitions
}

function countBy(items) {
  const counts = new Map()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

/**
 * Returns tests present in `before` but not in `after`, as "file: suite > test".
 * A test moved to another file keeps its title and is not reported. Each inventory maps file to definitions.
 */
export function removedTests(before, after) {
  const remaining = countBy([...after.values()].flat())
  const removed = []
  for (const [file, definitions] of before) {
    for (const definition of definitions) {
      const count = remaining.get(definition) ?? 0
      if (count > 0) remaining.set(definition, count - 1)
      else removed.push(`${file}: ${definition}`)
    }
  }
  return removed.sort()
}
