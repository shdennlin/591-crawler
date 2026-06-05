import { test, expect, describe } from "bun:test";
import { selectPublishTargets } from "./publish-targets";

describe("selectPublishTargets", () => {
  test("prioritises new listings", () => {
    const targets = selectPublishTargets(["n1", "n2"], [], 10);
    expect(targets).toEqual(["n1", "n2"]);
  });

  test("backfills active rows missing publish time after new ones", () => {
    const existing = [
      { id: "e1", hasPublish: false, isActive: true },
      { id: "e2", hasPublish: true, isActive: true }, // already filled → skip
      { id: "e3", hasPublish: false, isActive: false }, // inactive → skip
      { id: "e4", hasPublish: false, isActive: true },
    ];
    expect(selectPublishTargets(["n1"], existing, 10)).toEqual(["n1", "e1", "e4"]);
  });

  test("never backfills inactive rows even when publish is empty", () => {
    const existing = [{ id: "dead", hasPublish: false, isActive: false }];
    expect(selectPublishTargets([], existing, 10)).toEqual([]);
  });

  test("respects the budget, new listings first", () => {
    const existing = [
      { id: "e1", hasPublish: false, isActive: true },
      { id: "e2", hasPublish: false, isActive: true },
    ];
    expect(selectPublishTargets(["n1", "n2"], existing, 3)).toEqual([
      "n1",
      "n2",
      "e1",
    ]);
  });

  test("caps new listings when they alone exceed the budget", () => {
    expect(selectPublishTargets(["n1", "n2", "n3"], [], 2)).toEqual(["n1", "n2"]);
  });
});
