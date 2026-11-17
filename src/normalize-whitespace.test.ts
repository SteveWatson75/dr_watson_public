import { describe, expect, it } from "vitest";
import { normalizeWhitespace } from "./normalize-whitespace.js";

describe("normalizeWhitespace", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  hello world  ")).toBe("hello world");
  });

  it("collapses consecutive whitespace into a single space", () => {
    expect(normalizeWhitespace("hello   world")).toBe("hello world");
    expect(normalizeWhitespace("hello\t\nworld")).toBe("hello world");
    expect(normalizeWhitespace("a \t\n  b")).toBe("a b");
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(normalizeWhitespace("")).toBe("");
    expect(normalizeWhitespace(" \t\n ")).toBe("");
  });

  it("leaves already-normalized text unchanged", () => {
    expect(normalizeWhitespace("hello world")).toBe("hello world");
  });

  it("collapses whitespace between every word", () => {
    expect(normalizeWhitespace("  one   two\tthree \n four ")).toBe("one two three four");
  });
});
