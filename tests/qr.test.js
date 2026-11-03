import test from "node:test";
import assert from "node:assert/strict";
import { rsDivisor, rsRemainder, formatBits, encodeQR } from "../web/shared/js/qr.js";

test("Reed-Solomon matches the HELLO WORLD 1-M reference", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});
test("format strings match the published table", () => {
  const s = (v) => v.toString(2).padStart(15, "0");
  assert.equal(s(formatBits("M", 0)), "101010000010010");
  assert.equal(s(formatBits("L", 0)), "111011111000100");
  assert.equal(s(formatBits("L", 7)), "110100101110110");
  assert.equal(s(formatBits("M", 5)), "100000011001110");
});
test("encodes a maps link", () => {
  const q = encodeQR("https://www.google.com/maps/search/?api=1&query=40.851234,-119.123456");
  assert.equal(q.version, 5);
  assert.equal(q.size, 37);
  // finder corners dark, separator light
  assert.equal(q.modules[0][0], true); assert.equal(q.modules[7][7], false); assert.equal(q.modules[q.size - 1][0], true);
  // dark module
  assert.equal(q.modules[q.size - 8][8], true);
});
