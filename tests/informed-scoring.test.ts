import { describe, expect, it } from "vitest";
import {
  accountAgeSubscore, absoluteAmountSubscore, calculateInformedScore,
  relativeSizeSubscore, simultaneitySubscore,
} from "../src/lib/informed-scoring";

describe("informed buy scoring", () => {
  it("uses the documented account-age tiers", () => {
    expect(accountAgeSubscore(1)).toBe(100);
    expect(accountAgeSubscore(2)).toBe(85);
    expect(accountAgeSubscore(5)).toBe(65);
    expect(accountAgeSubscore(10)).toBe(35);
    expect(accountAgeSubscore(20)).toBe(10);
    expect(accountAgeSubscore(31)).toBe(0);
  });

  it("maps $1k to zero and $10k to 100 for absolute amount", () => {
    expect(absoluteAmountSubscore(1000)).toBe(0);
    expect(Math.round(absoluteAmountSubscore(3162.277))).toBe(50);
    expect(absoluteAmountSubscore(10000)).toBe(100);
  });

  it("requires 100 comparables and a non-zero MAD", () => {
    expect(relativeSizeSubscore(5000, Array(99).fill(1000))).toBeNull();
    expect(relativeSizeSubscore(5000, Array(100).fill(1000))).toBeNull();
    expect(relativeSizeSubscore(10000, Array.from({length: 100}, (_, i) => 100 + i * 10))).not.toBeNull();
  });

  it("requires 100 historical windows and forces zero when fewer than two peers are present", () => {
    expect(simultaneitySubscore(4, Array(99).fill(0))).toBeNull();
    expect(simultaneitySubscore(1, Array(100).fill(0))).toBe(0);
    expect(simultaneitySubscore(1, null)).toBe(0);
    expect(simultaneitySubscore(4, [...Array(99).fill(0), 4])).toBe(100);
  });

  it("does not redistribute weights for unavailable factors", () => {
    const result = calculateInformedScore({
      totalUsd: 10000, price: 0.2, accountAgeDays: 2,
      concentrationRatio: null, comparableAmounts: null,
      simultaneousOtherWallets: null, historicalSimultaneityCounts: null,
    });
    expect(result.coverage).toBe(40);
    expect(result.score).toBe(36); // 25*85% + 15*100%, with missing weights left at zero.
    expect(result.missing).toContain("concentration");
    expect(result.conditions).toHaveLength(6);
    expect(result.conditions.find(c => c.code === "concentration_at_least_90")?.value).toBeNull();
  });

  it("has the required six display conditions", () => {
    const result = calculateInformedScore({
      totalUsd: 3000, price: 0.4, accountAgeDays: 3, concentrationRatio: 0.95,
      comparableAmounts: Array.from({length:100}, (_, i) => 500 + i * 20),
      simultaneousOtherWallets: 3, historicalSimultaneityCounts: [...Array(99).fill(0),3],
    });
    expect(result.conditions.map(c => c.code)).toEqual([
      "buy_price_below_60c","amount_at_least_2500","account_age_at_most_7d",
      "concentration_at_least_90","relative_size_at_least_70","score_at_least_80",
    ]);
  });
});
