import { writeFileSync } from 'node:fs'
console.log('ci fixture success')
writeFileSync('ci-fixture-result.json', JSON.stringify({ status: 'succeeded' }))
