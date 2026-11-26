import { describe, expect, it } from "vitest";
import { isTestNumber, parseTestNumbers } from "./test-reset";

describe("parseTestNumbers", () => {
  it("parses a comma-separated list and strips formatting", () => {
    const set = parseTestNumbers(" +91 82815 66545, 91-98765-43210 ,");
    expect([...set]).toEqual(["918281566545", "919876543210"]);
  });

  it("is empty when the env var is missing", () => {
    expect(parseTestNumbers(undefined).size).toBe(0);
    expect(parseTestNumbers("").size).toBe(0);
  });
});

describe("isTestNumber", () => {
  const numbers = parseTestNumbers("918281566545");

  it("matches the same number in any format", () => {
    expect(isTestNumber("918281566545", numbers)).toBe(true);
    expect(isTestNumber("+91 82815 66545", numbers)).toBe(true);
  });

  it("rejects other numbers and empty values", () => {
    expect(isTestNumber("919999999999", numbers)).toBe(false);
    expect(isTestNumber("8281566545", numbers)).toBe(false);
    expect(isTestNumber(null, numbers)).toBe(false);
    expect(isTestNumber("", numbers)).toBe(false);
  });

  it("matches nothing when no test numbers are configured", () => {
    expect(isTestNumber("918281566545", parseTestNumbers(""))).toBe(false);
  });
});
