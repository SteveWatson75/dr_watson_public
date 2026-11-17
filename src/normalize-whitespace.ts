export function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}
