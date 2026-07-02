import { describe, expect, it } from "vitest";
import { AppError } from "../errors/app-error.js";

describe("AppError", () => {
  it("carries code, friendlyMessage, suggestedFix and cause", () => {
    const cause = new Error("boom");
    const err = new AppError({
      code: "GMAIL_SCOPE_MISSING",
      friendlyMessage: "Gmail said your key doesn't have permission to send.",
      suggestedFix: "Re-run the setup wizard and tick the 'send email' scope.",
      cause,
    });
    expect(err.code).toBe("GMAIL_SCOPE_MISSING");
    expect(err.friendlyMessage).toMatch(/permission to send/);
    expect(err.suggestedFix).toMatch(/setup wizard/);
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it("wrap() passes AppError through unchanged", () => {
    const original = new AppError({ code: "X", friendlyMessage: "x" });
    expect(AppError.wrap(original)).toBe(original);
  });

  it("wrap() normalizes unknown errors with a default code", () => {
    const wrapped = AppError.wrap(new Error("socket hang up"));
    expect(wrapped.code).toBe("UNEXPECTED");
    expect(wrapped.friendlyMessage).toContain("socket hang up");
  });
});
