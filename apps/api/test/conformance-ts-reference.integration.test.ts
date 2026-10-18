import { test } from 'node:test'
import { runConformanceReference } from '../../../scripts/ci-conformance-reference.mjs'

test('qualifies the six selected native scenarios against the frozen TS reference', runConformanceReference)
