import { describe, expect, it } from "vitest";
import { isProviderFailoverError, isTransientProviderError } from "./failover.js";

describe("isTransientProviderError", () => {
  it.each([
    "503 UNAVAILABLE: high demand",
    "429 Too Many Requests",
    "request timed out",
    "ECONNREFUSED",
  ])("retries transient provider failure: %s", (message) => {
    expect(isTransientProviderError(new Error(message))).toBe(true);
  });

  it("does not hide ordinary application errors", () => {
    expect(isTransientProviderError(new Error("invalid tool arguments"))).toBe(false);
  });
});

describe("isProviderFailoverError", () => {
  it.each([401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529])("allows provider auth/quota/availability status %s", (status) => {
    expect(isProviderFailoverError(Object.assign(new Error("Provider request failed"), { status }))).toBe(true);
  });
  it("rejects generic 400 even when message text resembles an availability error", () => {
    expect(isProviderFailoverError(Object.assign(new Error("400 tool unavailable"), { status: 400 }))).toBe(false);
    expect(isProviderFailoverError(new Error("400 Bad Request: tool unavailable"))).toBe(false);
  });
  it("fails over for the OpenCode Go upstream endpoint-unavailable 422 only", () => {
    expect(isProviderFailoverError(Object.assign(
      new Error("422 Upstream request failed: Endpoint is unavailable."), { status: 422 },
    ))).toBe(true);
    expect(isProviderFailoverError(Object.assign(
      new Error("422 Upstream request failed: endpoint is not available"), { status: 422 },
    ))).toBe(true);
    expect(isProviderFailoverError(Object.assign(new Error("timeout is not a valid parameter"), { status: 422 }))).toBe(false);
  });
  it("fails over for an unavailable upstream model 400 but not other bad requests", () => {
    expect(isProviderFailoverError(Object.assign(
      new Error("400 Upstream request failed: Model is unavailable."), { status: 400 },
    ))).toBe(true);
    expect(isProviderFailoverError(Object.assign(
      new Error("400 Upstream request failed: Model 'deepseek-v4-pro' is unavailable."), { status: 400 },
    ))).toBe(true);
    expect(isProviderFailoverError(Object.assign(
      new Error("400 Upstream request failed: model is not available"), { status: 400 },
    ))).toBe(true);
    expect(isProviderFailoverError(Object.assign(new Error("Invalid tool arguments"), { status: 400 }))).toBe(false);
  });
  it("retains network failover but stops application errors", () => {
    expect(isProviderFailoverError(new Error("fetch failed"))).toBe(true);
    expect(isProviderFailoverError(new Error("invalid tool arguments"))).toBe(false);
    expect(isProviderFailoverError(Object.assign(new Error("timeout is not a valid parameter"), { status: 422 }))).toBe(false);
  });
});
