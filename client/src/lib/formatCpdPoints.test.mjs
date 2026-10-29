import test from "node:test";
import assert from "node:assert/strict";
import { formatCpdPoints } from "./formatCpdPoints.js";

test("CPD presentation strips only redundant fractional zeros, without rounding", () => {
  for (const [value, expected] of [
    ["8.000000", "8"],
    ["1.500000", "1.5"],
    ["0.000001", "0.000001"],
    ["0.000000", "0"],
    ["-2.750000", "-2.75"],
    ["12345678901234567890.123456789012345678900", "12345678901234567890.1234567890123456789"],
    ["0.0000000000000000010", "0.000000000000000001"],
    [8, "8"],
    [1.5, "1.5"],
    [0, "0"],
    [null, "—"],
    [undefined, "—"],
    ["", "—"],
  ]) {
    assert.equal(formatCpdPoints(value), expected, String(value));
  }
});
