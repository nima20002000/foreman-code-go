const DETECTED = new Set(['Killed', 'Timeout'])

/** Percentage of covered mutants the tests detected, to one decimal; undefined when none were covered. */
function scorePercent(detected, survived) {
  const covered = detected + survived
  return covered === 0 ? undefined : Math.round((detected / covered) * 1000) / 10
}

/** Summarizes a Stryker JSON report: counts, the score on covered code, and surviving mutants. */
export function summarizeMutationReport(report, pkg) {
  const counts = { detected: 0, survived: 0, noCoverage: 0, other: 0 }
  const survivors = []
  for (const [file, { mutants }] of Object.entries(report.files)) {
    for (const mutant of mutants) {
      if (DETECTED.has(mutant.status)) counts.detected += 1
      else if (mutant.status === 'Survived') counts.survived += 1
      else if (mutant.status === 'NoCoverage') counts.noCoverage += 1
      else counts.other += 1
      if (mutant.status === 'Survived') {
        const replacement = (mutant.replacement ?? '').replace(/\s+/g, ' ').slice(0, 80)
        survivors.push(`${pkg}/${file}:${mutant.location.start.line} ${mutant.mutatorName} -> ${replacement}`)
      }
    }
  }
  return { pkg, counts, coveredScore: scorePercent(counts.detected, counts.survived), survivors }
}

/** Fails when the share of covered mutants the tests detect is below the policy minimum. */
export function mutationVerdict(summaries, minimumCoveredScore) {
  const detected = summaries.reduce((sum, summary) => sum + summary.counts.detected, 0)
  const survived = summaries.reduce((sum, summary) => sum + summary.counts.survived, 0)
  const coveredScore = scorePercent(detected, survived)
  return { coveredScore, pass: coveredScore === undefined || coveredScore >= minimumCoveredScore }
}
