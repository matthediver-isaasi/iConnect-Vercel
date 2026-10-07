import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { BNMS_TENANT_ID, NMC_REPORT_FEATURE } from "./nmcMembershipReport.mjs";
import { filterNmcRoleAccessMap, filterNmcRoleAccessItems } from "./nmcRoleAccessVisibility.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const module = { exports: {} };
vm.runInNewContext(transformSync(read("./roleAccessMap.ts"), { loader: "ts", format: "cjs" }).code, { module, exports: module.exports });
const canonical = module.exports.ROLE_ACCESS_MAP;
const ids = nodes => nodes.flatMap(node => [node.id, ...ids(node.pages || []), ...ids(node.features || [])]);

test("non-BNMS presentation hides only NMC report while canonical authorization remains intact", () => {
  const before = JSON.stringify(canonical);
  const allIds = ids(canonical);
  assert.ok(allIds.includes(NMC_REPORT_FEATURE));
  for (const tenant of ["other-tenant", undefined, null]) {
    const visible = filterNmcRoleAccessMap(canonical, tenant);
    assert.deepEqual(ids(visible), allIds.filter(id => id !== NMC_REPORT_FEATURE));
    assert.equal(JSON.stringify(canonical), before);
  }
  assert.equal(filterNmcRoleAccessMap(canonical, BNMS_TENANT_ID), canonical);
  assert.equal(module.exports.LEGACY_TO_NEW_MAPPING.page_admin_NMCMembershipReport, NMC_REPORT_FEATURE);
  assert.equal(module.exports.LEGACY_TO_NEW_MAPPING.page_NMCMembershipReport, NMC_REPORT_FEATURE);
});

test("custom trees filter legacy aliases at any nesting level without mutating input", () => {
  const map = [{ id: "custom", pages: [
    { id: "page_NMCMembershipReport", label: "Old report label" },
    { id: "unrelated", features: [{ id: "unrelated.feature" }, { id: "page_admin_NMCMembershipReport" }] },
  ], features: [{ id: NMC_REPORT_FEATURE }, { id: "custom.feature" }] }];
  const before = JSON.stringify(map);
  assert.deepEqual(ids(filterNmcRoleAccessMap(map, "other")), ["custom", "unrelated", "unrelated.feature", "custom.feature"]);
  assert.equal(JSON.stringify(map), before);
});

test("DB configuration hides report nodes and their descendants including reparented keys", () => {
  const items = [
    { id: "m", item_key: "custom", item_type: "module" },
    { id: "other", item_key: "unrelated", parent_id: "m", item_type: "page" },
    { id: "child", item_key: "custom.report-detail", parent_id: "report", item_type: "feature" },
    { id: "report", item_key: NMC_REPORT_FEATURE, parent_id: "m", item_type: "page" },
    { id: "alias", item_key: "page_admin_NMCMembershipReport", parent_id: "other", item_type: "feature" },
    { id: "grandchild", item_key: "custom.report-extra", parent_id: "child", item_type: "feature" },
  ];
  const before = JSON.stringify(items);
  assert.deepEqual(filterNmcRoleAccessItems(items, "other").map(item => item.id), ["m", "other"]);
  assert.equal(JSON.stringify(items), before);
  assert.equal(filterNmcRoleAccessItems(items, BNMS_TENANT_ID), items);
});

test("both role pages use filtered presentation and preserve full role toggle semantics", () => {
  const management = read("../pages/RoleManagement.jsx");
  assert.match(management, /filterNmcRoleAccessMap\(accessMap, branding\?\.id\)/);
  assert.match(management, /visibleAccessMap\.map\(\(module\)/);
  assert.match(management, /toggleResourceExclusion\(excluded, resourceId, !hasAccess, accessMap\)/);
  assert.match(management, /PAGE_NAMES\s*\.filter\(name => branding\?\.id === BNMS_TENANT_ID/);
  const config = read("../pages/RoleAccessConfigManagement.jsx");
  assert.match(config, /filterNmcRoleAccessItems\(accessItems, branding\?\.id\)/);
  assert.match(config, /filterNmcRoleAccessMap\(ROLE_ACCESS_MAP, branding\?\.id\)/);
  assert.equal((config.match(/for \(const mod of tenantDefaults\)/g) || []).length, 6);
  assert.doesNotMatch(config, /for \(const mod of ROLE_ACCESS_MAP\)/);
  assert.match(config, /const moduleOptions = useMemo\(\(\) => \{\s*return visibleAccessItems/);
  assert.match(config, /const pageOptions = useMemo\(\(\) => \{\s*return visibleAccessItems/);
});

test("Layout tenant predicate is declared before report exclusion callback", () => {
  const layout = read("../pages/Layout.jsx");
  const declared = layout.indexOf("const isBnmsTenant =");
  const guard = layout.indexOf("const isFeatureExcluded = React.useCallback");
  assert.ok(declared >= 0 && guard > declared);
});
