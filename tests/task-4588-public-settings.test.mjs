import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../api/public/system-settings.js", import.meta.url),
  "utf8",
);
const whitelistSource = source.match(
  /const PUBLIC_SETTINGS_WHITELIST = \[([\s\S]*?)\n\];/,
)?.[1];

test("public settings exposes the three guest-directory keys", () => {
  assert.ok(whitelistSource, "PUBLIC_SETTINGS_WHITELIST must remain explicit");
  for (const key of [
    "org_directory_guest_heading",
    "org_directory_guest_description",
    "org_directory_guest_join_link",
  ]) {
    assert.match(whitelistSource, new RegExp(`['"]${key}['"]`));
  }
});

test("authenticated organisation-directory settings remain outside the public whitelist", () => {
  assert.ok(whitelistSource, "PUBLIC_SETTINGS_WHITELIST must remain explicit");
  for (const key of [
    "org_directory_guest_join_action_id",
    "org_directory_header",
    "org_directory_show_logo",
    "org_directory_show_domains",
    "org_directory_show_member_count",
    "org_directory_cards_per_row",
    "org_directory_visible_org_types",
    "org_directory_reverse_card_role_ids",
    "org_directory_view_members_role_ids",
    "org_directory_back_field_order",
    "org_directory_custom_fields_label",
    "org_directory_filterable_back_fields",
  ]) {
    assert.doesNotMatch(whitelistSource, new RegExp(`['"]${key}['"]`));
  }
});