import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getVirtualThinkingLevelMap } from "../src/virtual-model.ts";

describe("getVirtualThinkingLevelMap", () => {
  it("advertises every standard thinking level without nonstandard remapping", () => {
    assert.deepEqual(getVirtualThinkingLevelMap(true), {
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });

  it("does not advertise thinking levels for non-reasoning routes", () => {
    assert.equal(getVirtualThinkingLevelMap(false), undefined);
  });
});
