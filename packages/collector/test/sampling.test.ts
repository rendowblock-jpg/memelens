import { describe, expect, it } from "vitest";
import { fraction, isFollowed, pickKey, PICK_SALT, SAMPLING_SALT } from "../src/sampling";

// The expected numbers were computed with Python's hashlib (a different implementation), not with the code under test.
describe("the sampling rule", () => {
  it("uses the salts the design document fixes", () => {
    expect(SAMPLING_SALT).toBe("memelens-calibration-v1:");
    expect(PICK_SALT).toBe("memelens-calibration-v1:pick:");
  });

  it("reads the first four bytes of sha256(salt + address) as a fraction of 2^32", () => {
    expect(fraction(SAMPLING_SALT, "abc")).toBe(0.33044769102707505);
    expect(fraction(SAMPLING_SALT, "So11111111111111111111111111111111111111112")).toBe(0.18063349882140756);
    expect(fraction(SAMPLING_SALT, "2xqTL8FKS7GR1s6VLbSXNbkyRQjAhsz114afbMGvpump")).toBe(0.27685211249627173);
  });

  it("follows a launch when its fraction is below the rate, and not when it is equal or above", () => {
    expect(isFollowed("abc", 0.2)).toBe(false); // 0.330 >= 0.2
    expect(isFollowed("abc", 0.34)).toBe(true);
    expect(isFollowed("abc", 0.33044769102707505)).toBe(false); // the boundary is exclusive
    expect(isFollowed("So11111111111111111111111111111111111111112", 0.2)).toBe(true); // 0.1806 < 0.2
  });

  it("defaults to a rate of 0.1", () => {
    expect(isFollowed("m46")).toBe(true); // 0.054
    expect(isFollowed("m2")).toBe(true); // 0.0996, just under
    expect(isFollowed("m0")).toBe(false); // 0.85
    expect(isFollowed("So11111111111111111111111111111111111111112")).toBe(false); // 0.18 would have been followed at 0.2
  });

  it("follows none at rate 0 and all at rate 1", () => {
    for (let i = 0; i < 200; i++) {
      expect(isFollowed(`m${i}`, 0)).toBe(false);
      expect(isFollowed(`m${i}`, 1)).toBe(true);
    }
  });

  it("refuses a rate outside 0..1 or not a number", () => {
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => isFollowed("abc", bad)).toThrow(RangeError);
  });

  it("follows about a fifth of 20,000 addresses (3,853 of them, computed independently)", () => {
    let n = 0;
    for (let i = 0; i < 20000; i++) if (isFollowed(`m${i}`, 0.2)) n++;
    expect(n).toBe(3853);
  });

  it("follows about a tenth of 20,000 addresses at the default rate (1,908 of them, computed independently)", () => {
    let n = 0;
    for (let i = 0; i < 20000; i++) if (isFollowed(`m${i}`)) n++;
    expect(n).toBe(1908);
  });

  it("orders the final pick by sha256(pick salt + address), as lowercase hex", () => {
    expect(pickKey("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(pickKey("abc").startsWith("d1be06c76edacedc")).toBe(true);
    expect(pickKey("So11111111111111111111111111111111111111112").startsWith("5e790b67d7aec57f")).toBe(true);
  });
});
