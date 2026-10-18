// Optional affected policy over real converter outcomes; it never changes their identities or counts.
export function validateGoSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || !Object.keys(selection).length) {
    throw new Error('Go selection must bind nonempty named test roots to exact packages.')
  }
  const packages = new Map()
  for (const [path, roots] of Object.entries(selection)) {
    if (path !== '.' && !/^\.\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(path)) {
      throw new Error(`Go selection needs an exact package, without patterns: ${path}.`)
    }
    if (!Array.isArray(roots) || !roots.length || roots.some(name => typeof name !== 'string' || !/^Test[A-Za-z0-9_]+$/.test(name))
      || new Set(roots).size !== roots.length) {
      throw new Error(`Go selection needs unique named test roots for ${path}.`)
    }
    packages.set(path === '.' ? 'backend' : `backend/${path.slice(2)}`, [...roots])
  }
  return packages
}

/** A missing package/root or an unexecuted selected root cannot be hidden by a passing neighbor. */
export function goSelectionResult(report, packages) {
  const failures = []
  const outcomes = new Map(report.testResults.map(result => [result.name, result]))
  const expected = [...packages].flatMap(([packageName, roots]) => roots.map(name => ({ package: packageName, name })))
  for (const { package: packageName, name } of expected) {
    const outcome = outcomes.get(packageName)?.assertionResults.find(test => test.fullName === name)
    if (!outcome) failures.push(`Selected Go root has no terminal outcome: ${packageName} ${name}.`)
    else if (outcome.status === 'skipped') failures.push(`Selected Go root did not execute: ${packageName} ${name}.`)
  }
  for (const result of report.testResults) {
    const roots = packages.get(result.name)
    if (!roots) {
      failures.push(`Go command reported an unselected package: ${result.name}.`)
      continue
    }
    for (const test of result.assertionResults) {
      if (test.fullName.startsWith('Benchmark')) continue
      const root = test.fullName.split('/')[0]
      if (!roots.includes(root)) failures.push(`Go command executed an unselected root: ${result.name} ${test.fullName}.`)
    }
  }
  return { expected, status: failures.length ? 'failed' : 'passed', failures }
}
