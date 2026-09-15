import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBadgeImageLink } from "./badgeImageLink.js";

const origin = "https://project.supabase.co";
const suffix = "/storage/v1/object/public/images/a%2fb%20%25.png?x=%2f&x=+#part%20one";
test("replaces only the configured public storage origin, retaining exact suffix", () => {
  assert.equal(resolveBadgeImageLink(origin + suffix, origin + "/"), "https://vault.iconn.app" + suffix);
  assert.equal(resolveBadgeImageLink(origin.toUpperCase() + suffix, origin), "https://vault.iconn.app" + suffix);
});
test("leaves custom, unrelated, non-public, malformed and missing URLs unchanged", () => {
  for (const value of [
    null, undefined, "", "   ", "not a URL",
    "https://vault.iconn.app" + suffix,
    "https://other.supabase.co" + suffix,
    origin + ".evil.test" + suffix,
    origin + ":444" + suffix,
    origin + "/storage/v1/object/sign/images/a.png",
    origin + "/storage/v1/object/publicity/images/a.png",
    origin + "/auth/v1/foo",
    "/storage/v1/object/public/images/a.png",
    "https://user:pass@project.supabase.co" + suffix,
  ]) assert.equal(resolveBadgeImageLink(value, origin), value);
  for (const config of [undefined, "", "invalid"]) {
    assert.equal(resolveBadgeImageLink(origin + suffix, config), origin + suffix);
  }
});