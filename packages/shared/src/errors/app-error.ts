export interface AppErrorOptions {
  code: string;
  friendlyMessage: string;
  suggestedFix?: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly friendlyMessage: string;
  readonly suggestedFix?: string;

  constructor(opts: AppErrorOptions) {
    super(opts.friendlyMessage, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.friendlyMessage = opts.friendlyMessage;
    this.suggestedFix = opts.suggestedFix;
  }

  static wrap(err: unknown, code = "UNEXPECTED"): AppError {
    if (err instanceof AppError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AppError({
      code,
      friendlyMessage: `Something went wrong: ${message}`,
      cause: err,
    });
  }
}
