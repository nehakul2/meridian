/** The spec 7 error envelope and codes, shared by the API and the Tx Builder. */
export type ErrorCode =
  | "NOT_FOUND" | "VALIDATION" | "MARKET_HALTED" | "MARKET_NOT_OPEN" | "PAUSED" | "POSITION_CONFLICT"
  | "INSUFFICIENT_BALANCE" | "NO_LIQUIDITY" | "RATE_LIMITED" | "UNAUTHORIZED" | "ORDER_TOO_LARGE"
  // Phase 6 additions (docs/phase6-coverage.md)
  | "NOT_SETTLED" | "OVERRIDE_TOO_EARLY" | "ALREADY_RECORDED" | "DISPUTE_WINDOW_CLOSED"
  | "NOT_RERUNNABLE" | "UNAVAILABLE" | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404, VALIDATION: 400, MARKET_HALTED: 409, MARKET_NOT_OPEN: 409, PAUSED: 409, POSITION_CONFLICT: 409,
  INSUFFICIENT_BALANCE: 409, NO_LIQUIDITY: 409, RATE_LIMITED: 429, UNAUTHORIZED: 401, ORDER_TOO_LARGE: 422,
  NOT_SETTLED: 409, OVERRIDE_TOO_EARLY: 409, ALREADY_RECORDED: 409, DISPUTE_WINDOW_CLOSED: 409,
  NOT_RERUNNABLE: 409, UNAVAILABLE: 503, INTERNAL: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, readonly details: Record<string, unknown> = {}, status?: number) {
    super(message);
    this.status = status ?? STATUS[code];
  }
  body() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
