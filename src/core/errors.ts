export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details: Record<string, unknown> = {},
    public retryable = false,
  ) {
    super(message);
  }
}
export function ensure(value: unknown, code: string, message: string, status = 400): asserts value {
  if (!value) {
    throw new AppError(code, message, status);
  }
}
export function errorBody(error: unknown) {
  const e =
    error instanceof AppError
      ? error
      : new AppError('INTERNAL_ERROR', '服务操作失败，请检查本地诊断日志。', 500);
  return {
    ok: false as const,
    error: { code: e.code, message: e.message, retryable: e.retryable, details: e.details },
  };
}
