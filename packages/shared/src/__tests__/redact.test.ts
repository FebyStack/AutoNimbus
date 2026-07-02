import { describe, expect, it } from "vitest";
import { redactSecrets } from "../redact/redact.js";

describe("redactSecrets", () => {
  it("scrubs bearer tokens inside nested objects", () => {
    const out = redactSecrets({
      request: { headers: { authorization: "Bearer sk_live_a1b2c3d4e5f6g7h8i9" } },
    });
    expect(JSON.stringify(out)).not.toContain("sk_live_a1b2c3d4e5f6g7h8i9");
    expect(JSON.stringify(out)).toContain("•••redacted•••");
  });

  it("scrubs known credential values wherever they appear", () => {
    const out = redactSecrets(
      { note: "called api with topsecret123 embedded" },
      ["topsecret123"],
    );
    expect(JSON.stringify(out)).not.toContain("topsecret123");
  });

  it("scrubs values of secret-named keys", () => {
    const out = redactSecrets({ api_key: "shortval", name: "keep me" }) as {
      api_key: string;
      name: string;
    };
    expect(out.api_key).toBe("•••redacted•••");
    expect(out.name).toBe("keep me");
  });

  it("leaves non-secret data untouched", () => {
    const data = { price: 450, airline: "Cebu Pacific" };
    expect(redactSecrets(data)).toEqual(data);
  });
});
