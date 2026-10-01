import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Test the existing permission helper and the endpoint's actual flag gate,
// without a server, credentials, or a database connection.
const fixtureSlot = "__organizationDirectoryBypassFixture";
const bundle = await build({
  stdin: {
    contents: `
      export { checkCrossOrgPermissions } from './api/_lib/tenantContext.js';
      export { __setRoleAccessOverlayForTests } from './api/_lib/roleVisibility.js';
    `,
    resolveDir: resolve("."),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  packages: "external",
  define: { "process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME": '"true"' },
  plugins: [{
    name: "directory-bypass-fixture",
    setup(builder) {
      builder.onResolve({ filter: /\/database\.js$/ }, args => ({
        path: args.path, namespace: "fixture",
      }));
      builder.onResolve({ filter: /\/session\.js$/ }, args => ({
        path: args.path, namespace: "fixture",
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({
        loader: "js",
        contents: args.path.endsWith("/database.js")
          ? `export const supabase = { from: table => globalThis.${fixtureSlot}.from(table) };`
          : `
            export const getSessionMember = async () => null;
            export const getSessionTenantUser = async () => null;
            export const getSession = async () => null;
          `,
      }));
    },
  }],
});
const outputPath = resolve("tmp", `organization-directory-bypass-${process.pid}.mjs`);
await mkdir(resolve("tmp"), { recursive: true });
await writeFile(outputPath, bundle.outputFiles[0].text);
let permissions;
try {
  permissions = await import(pathToFileURL(outputPath).href);
} finally {
  await unlink(outputPath);
}
permissions.__setRoleAccessOverlayForTests([]);

const endpoint = await readFile(new URL("./[entity]/index.js", import.meta.url), "utf8");
const gate = endpoint.slice(
  endpoint.indexOf("let skipDirectoryFilters = isTenantAdmin;"),
  endpoint.indexOf("if (!skipDirectoryFilters && !isFetchingOwnOrg)"),
);
assert.ok(gate.includes("checkCrossOrgPermissions"));
const evaluateGate = new Function("req", "tenantCtx", "isTenantAdmin", "checkCrossOrgPermissions", `
  return (async () => { ${gate} return skipDirectoryFilters; })();
`);

function roleFixture(excludedFeatures, fail = false) {
  const queries = [];
  globalThis[fixtureSlot] = {
    from(table) {
      assert.equal(table, "role");
      const query = {
        select(columns) { assert.equal(columns, "excluded_features"); return query; },
        eq(column, value) { queries.push([column, value]); return query; },
        async single() {
          return fail
            ? { data: null, error: { message: "Fixture role unavailable" } }
            : { data: { excluded_features: excludedFeatures, admin_can_edit_members: true }, error: null };
        },
      };
      return query;
    },
  };
  return queries;
}

async function bypass(options = {}) {
  const { excluded = [], roleId = "fixture-role", admin = false, fail = false } = options;
  const flag = Object.hasOwn(options, "flag") ? options.flag : "true";
  roleFixture(excluded, fail);
  return evaluateGate(
    { query: { skipDirectoryFilters: flag } }, { roleId }, admin,
    permissions.checkCrossOrgPermissions,
  );
}

test("existing gate permits tenant admins and member roles with cross-org organisation management", async () => {
  assert.equal(await bypass({ admin: true, roleId: null }), true);
  assert.equal(await bypass(), true);
  assert.equal(await bypass({ excluded: ["admin.role-management"] }), true);
});

test("ordinary members cannot use the flag; member-edit access alone does not grant cross-org access", async () => {
  assert.equal(await bypass({ excluded: ["admin.role-management", "admin.organizations"] }), false);
  assert.equal(await bypass({ excluded: ["admin"] }), false);
});

test("missing role or failed role lookup fails closed", async () => {
  assert.equal(await bypass({ roleId: null }), false);
  assert.equal(await bypass({ fail: true }), false);
});

test("directory requests without the exact opt-in flag stay filtered even for CRM member roles", async () => {
  for (const flag of [undefined, "false", "TRUE", true]) {
    assert.equal(await bypass({ flag }), false);
  }
});

test("directory bypass remains inside the hard tenant scope, not a tenant-filter bypass", () => {
  const organizationScope = endpoint.slice(
    endpoint.indexOf("} else if (entity === 'Organization') {"),
    endpoint.indexOf("} else if (tenantScope === TENANT_SCOPE.TENANT) {", endpoint.indexOf(gate)),
  );
  assert.match(organizationScope, /query = query\.eq\('tenant_id', orgTenantId\);/);
  assert.ok(organizationScope.indexOf("query = query.eq('tenant_id', orgTenantId);") < organizationScope.indexOf(gate));
  assert.match(organizationScope, /return res\.status\(403\)\.json\(\{ error: 'Invalid tenant context/);
});