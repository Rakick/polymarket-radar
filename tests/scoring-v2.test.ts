import { describe, expect, it } from "vitest";
import { computeV2Scores, type V2Alert } from "../src/lib/scoring-v2";

const base: V2Alert = {
  id: "a1", wallet: "0xabc", market_id: "market-1", total_usd: 2500,
  first_trade_at: "2026-10-01T12:00:00.000Z", last_trade_at: "2026-10-01T12:05:00.000Z",
  market: { volume: 100000, end_date: "2026-10-10T00:00:00.000Z" },
};

describe("computeV2Scores", () => {
  it("returns a bounded experimental score and reports unavailable dimensions", () => {
    const result = computeV2Scores([base]).get("a1");
    expect(result).toBeDefined();
    expect(result!.score).toBeGreaterThanOrEqual(0);
    expect(result!.score).toBeLessThanOrEqual(100);
    expect(result!.unavailable).toContain("profil historique fiable du wallet (ROI, win rate, ancienneté)");
    expect(result!.unavailable).toContain("impact réel du trade après exécution (snapshots de prix absents)");
  });

  it("does not claim coordination without dated peer alerts", () => {
    const result = computeV2Scores([base]).get("a1")!;
    expect(result.factors.some(f => f.code === "coordination")).toBe(false);
  });

  it("uses peer alerts to calculate robust relative size and coordination", () => {
    const peers = Array.from({ length: 7 }, (_, i) => ({
      ...base, id: `a${i + 2}`, wallet: `0xpeer${i}`, total_usd: 500 + i * 100,
      first_trade_at: "2026-10-01T12:04:00.000Z",
    }));
    const results = computeV2Scores([base, ...peers]);
    expect(results.get("a1")!.factors.some(f => f.code === "relative_size")).toBe(true);
    expect(results.get("a1")!.factors.some(f => f.code === "coordination")).toBe(true);
  });
});
