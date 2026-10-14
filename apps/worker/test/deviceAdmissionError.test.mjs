import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceApplicationAdmissionError, DeviceApplicationError }
  from '../../api/src/modules/devices/deviceApplicationError.ts';

test('Worker imports admission errors with strip-only TypeScript and retains the refusal reason', () => {
  const busy = new DeviceApplicationAdmissionError('DEVICE_BUSY');
  assert.ok(busy instanceof DeviceApplicationError);
  assert.equal(busy.reason, 'DEVICE_BUSY');
  assert.equal(busy.code, 'backpressure');
  assert.equal(busy.retryable, true);
  assert.equal(new DeviceApplicationAdmissionError().reason, 'backpressure');
});
