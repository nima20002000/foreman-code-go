import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { resourceTelemetryFixtures } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { telemetrySelectorKey, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { ComputerUtilization } from './ComputerUtilization'
import { computersFixture, mainTarget } from './computersTestFixture'

it('displays fresh zero CPU and memory as values instead of unavailable metrics', async () => {
  const sample = structuredClone(resourceTelemetryFixtures.computerZero!)
  if (sample.kind !== 'sample') throw new Error('Expected a sample fixture')
  const selector: TelemetrySelector = { ...sample.sample.selector, host: { ...sample.sample.selector.host,
    applicationInstallationId: mainTarget.applicationInstallationId } }
  sample.sample.selector = selector
  sample.sample.identity.host = selector.host
  sample.sample.selectorKey = telemetrySelectorKey(selector)
  sample.lastKnown = null
  computersFixture(<ComputerUtilization target={mainTarget} online />, [
    http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'selector', selector })),
    http.post('*/api/management/resource-telemetry/read', () => HttpResponse.json(sample))])
  expect(await screen.findAllByText('0%')).toHaveLength(2)
  expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '0')
  expect(screen.getByRole('meter', { name: 'Memory' })).toHaveAttribute('aria-valuenow', '0')
})
it('does not request or present retained utilization for an offline computer', async () => {
  computersFixture(<ComputerUtilization target={mainTarget} online={false} />)
  expect(screen.getAllByText('—')).toHaveLength(2)
  expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuetext', 'Unavailable')
  expect(screen.getByRole('meter', { name: 'CPU' })).not.toHaveAttribute('aria-valuenow')
})
