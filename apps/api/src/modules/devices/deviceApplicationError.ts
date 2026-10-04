export class DeviceApplicationError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
