import { test, expect, describe } from "bun:test";
import {
  refreshToAbsolute,
  parseTaipei,
  shouldUpdateRefresh,
} from "./time-utils";

describe("refreshToAbsolute", () => {
  // 2026-06-05T01:00:00Z == 2026-06-05 09:00:00 in Asia/Taipei
  const crawlAt = new Date("2026-06-05T01:00:00Z");

  test("parses '5分鐘內更新' as crawl time minus 5 minutes", () => {
    expect(refreshToAbsolute("5分鐘內更新", crawlAt)).toBe("2026-06-05 08:55:00");
  });

  test("parses '3小時內更新' as crawl time minus 3 hours", () => {
    expect(refreshToAbsolute("3小時內更新", crawlAt)).toBe("2026-06-05 06:00:00");
  });

  test("parses '2天前更新' as crawl time minus 2 days", () => {
    expect(refreshToAbsolute("2天前更新", crawlAt)).toBe("2026-06-03 09:00:00");
  });

  test("returns null for unparseable strings", () => {
    expect(refreshToAbsolute("剛剛更新", crawlAt)).toBeNull();
    expect(refreshToAbsolute("", crawlAt)).toBeNull();
  });
});

describe("parseTaipei", () => {
  test("parses 'YYYY-MM-DD HH:MM:SS' UTC+8 back to epoch ms", () => {
    // 2026-06-04 22:40:53 UTC+8 == 1780584053 unix seconds
    expect(parseTaipei("2026-06-04 22:40:53")).toBe(1780584053 * 1000);
  });

  test("returns NaN for empty/invalid", () => {
    expect(Number.isNaN(parseTaipei(""))).toBe(true);
  });
});

describe("shouldUpdateRefresh", () => {
  const TWELVE_H = 12 * 3600 * 1000;

  test("true when there is no stored value yet", () => {
    expect(shouldUpdateRefresh("", "2026-06-05 09:00:00", TWELVE_H)).toBe(true);
  });

  test("false when candidate is only slightly newer (bucket drift)", () => {
    // 6h newer, below the 12h threshold → treat as same refresh, don't rewrite
    expect(
      shouldUpdateRefresh("2026-06-03 09:00:00", "2026-06-03 15:00:00", TWELVE_H)
    ).toBe(false);
  });

  test("true when candidate is much newer (a real refresh)", () => {
    expect(
      shouldUpdateRefresh("2026-06-03 09:00:00", "2026-06-05 09:00:00", TWELVE_H)
    ).toBe(true);
  });

  test("false when candidate is not newer than stored", () => {
    expect(
      shouldUpdateRefresh("2026-06-05 09:00:00", "2026-06-05 09:00:00", TWELVE_H)
    ).toBe(false);
  });

  test("true when candidate is valid but stored is unparseable", () => {
    expect(shouldUpdateRefresh("garbage", "2026-06-05 09:00:00", TWELVE_H)).toBe(true);
  });
});
