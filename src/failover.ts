export function isTransientProviderError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String(error.cause ?? "")}`
    : String(error);

  return /\b(429|500|502|503|504)\b|rate.?limit|too many requests|unavailable|high demand|timeout|timed out|connection refused|econnrefused|fetch failed/i.test(text);
}

export function isProviderFailoverError(error: unknown): boolean {
  // SDK HTTP status takes precedence over message text: an invalid request can
  // mention an "unavailable" tool without being a provider availability failure.
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String(error.cause ?? "")}`
    : String(error);
  const status = error && typeof error === "object" && "status" in error
    ? error.status : undefined;
  if (typeof status === "number") {
    // A stale or temporarily unavailable Go model should fall through to the
    // next configured model. Other HTTP 400 responses remain terminal.
    // Keep the match tolerant of upstream wording changes (e.g. "Model X is
    // unavailable", "model is not available") while still requiring the
    // upstream-request prefix and the model/unavailable keywords.
    if (status === 400) return /upstream request failed:.*\bmodel\b.*(?:\bunavailable\b|not available)/i.test(text);
    // OpenCode Go can return HTTP 422 for a temporarily unavailable upstream
    // endpoint. This specific response should try the next configured route;
    // other 422s still indicate a request/configuration problem.
    if (status === 422) return /upstream request failed:.*\bendpoint\b.*(?:\bunavailable\b|not available)/i.test(text);
    return [401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529].includes(status);
  }
  if (/\b400\b/.test(text)) return false;
  return isTransientProviderError(error) || /\b(401|402|403|404)\b/.test(text);
}
