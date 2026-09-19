import { ApiError } from '../../shared/api/client'

export function isAuthAccessError(error: unknown): error is ApiError {
  return ApiError.is(error) && (error.status === 401 || error.status === 403)
}
