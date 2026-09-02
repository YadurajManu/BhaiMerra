/**
 * Errors carry a stable machine-readable code alongside the human message.
 * Scripts and the CLI branch on `code`; only humans read `message`, so the
 * message can be improved without breaking anyone's automation.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown
  ) {
    super(message)
  }

  static badRequest(code: string, message: string, detail?: unknown) {
    return new ApiError(400, code, message, detail)
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message)
  }
  static forbidden(message = 'Insufficient permissions') {
    return new ApiError(403, 'forbidden', message)
  }
  static notFound(what: string) {
    return new ApiError(404, 'not_found', `${what} not found`)
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message)
  }
  static tooManyRequests(code: string, message: string) {
    return new ApiError(429, code, message)
  }

  static unprocessable(code: string, message: string, detail?: unknown) {
    return new ApiError(422, code, message, detail)
  }
}
