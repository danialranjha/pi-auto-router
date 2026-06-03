import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const exampleConfig = JSON.parse(fs.readFileSync(new URL("../auto-router.routes.example.json", import.meta.url), "utf8"));

describe("auto-router.routes.example.json", () => {
  it("does not reference deprecated Google OAuth providers", () => {
    const text = JSON.stringify(exampleConfig);
    assert.equal(text.includes("google-antigravity"), false);
    assert.equal(text.includes("google-gemini-cli"), false);
  });

  it("uses per-token Gemini API-key targets", () => {
    const routes = Object.values(exampleConfig.routes ?? {}) as Array<{ targets?: Array<any> }>;
    const googleTargets = routes.flatMap((route) => route.targets ?? []).filter((target) => target.provider === "google");
    assert.ok(googleTargets.length >= 4);
    for (const target of googleTargets) {
      assert.equal(target.billing, "per-token");
      assert.equal(target.authProvider, undefined);
      assert.match(String(target.modelId), /^(gemini-3\.1-pro-preview|gemini-3\.5-flash)$/);
    }
  });

  it("keeps the gemini alias aligned with API-key models", () => {
    assert.deepEqual(exampleConfig.aliases?.gemini, [
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.5-flash",
    ]);
  });
});
