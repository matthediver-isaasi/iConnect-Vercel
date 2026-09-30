import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

/*
 * These tests deliberately use the same signed iconnect.sid cookie format as
 * createSession().  The handlers and session helpers are loaded in a child
 * process after SUPABASE_URL has been pointed at the PostgREST-shaped fixture
 * below.  Keeping the import in a child process matters: database.js captures
 * its environment at module initialization, and this prevents the fixture
 * from changing the environment of other test files running in parallel.
 *
 * This is not a stubbed tenant context test.  The request goes through:
 *
 *   signed cookie -> session row -> getSessionTenantUser/getSessionMember
 *   -> getTenantContext -> report/cost-line guard
 *
 * The fixture is intentionally local and contains no real credentials or
 * session values.  The child suppresses application logging because the
 * session module logs diagnostic metadata, and regression output must not
 * contain session data.
 */

const SESSION_SECRET = "task-4397-regression-secret";
const TENANT_ID = "tenant-task4397";
const OTHER_TENANT_ID = "tenant-other";

const fixtureRows = {
  session: [
    {
      sid: "tenant-user-session",
      sess: {
        tenantUserId: "tenant-user-task4397",
        tenantId: TENANT_ID,
        userType: "tenant_user",
      },
      expire: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      sid: "member-admin-session",
      sess: {
        memberId: "member-admin-task4397",
        tenantId: TENANT_ID,
        identityId: "identity-member-admin-task4397",
        userType: "member",
      },
      expire: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      sid: "member-denied-session",
      sess: {
        memberId: "member-denied-task4397",
        tenantId: TENANT_ID,
        identityId: "identity-member-denied-task4397",
        userType: "member",
      },
      expire: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      sid: "expired-session",
      sess: {
        tenantUserId: "tenant-user-task4397",
        tenantId: TENANT_ID,
        userType: "tenant_user",
      },
      expire: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      sid: "tenant-user-mismatch-session",
      sess: {
        tenantUserId: "tenant-user-task4397",
        tenantId: TENANT_ID,
        userType: "tenant_user",
      },
      expire: new Date(Date.now() + 60_000).toISOString(),
    },
  ],
  tenant_user: [
    {
      id: "tenant-user-task4397",
      tenant_id: TENANT_ID,
      status: "active",
      email: "task4397-admin@example.invalid",
      role: "owner",
    },
  ],
  member: [
    {
      id: "member-admin-task4397",
      tenant_id: TENANT_ID,
      organization_id: null,
      role_id: "role-admin-task4397",
      login_enabled: true,
      membership_paused: false,
      email: "member-admin@example.invalid",
    },
    {
      id: "member-denied-task4397",
      tenant_id: TENANT_ID,
      organization_id: null,
      role_id: "role-denied-task4397",
      login_enabled: true,
      membership_paused: false,
      email: "member-denied@example.invalid",
    },
  ],
  role: [
    {
      id: "role-admin-task4397",
      excluded_features: [],
    },
    {
      id: "role-denied-task4397",
      excluded_features: ["admin.role-management"],
    },
  ],
  event: [
    {
      id: "event-task4397",
      tenant_id: TENANT_ID,
    },
  ],
  event_cost_line: [],
  tenant_identity: [],
  tenant_membership: [],
  tenant_user_member_link: [],
  role_access_item: [],
};

function filterRows(table, searchParams) {
  const rows = fixtureRows[table] || [];

  return rows.filter((row) => {
    for (const [key, value] of searchParams) {
      if (["select", "order", "offset", "limit", "range", "or", "and"].includes(key)) {
        continue;
      }

      if (value.startsWith("eq.") && String(row[key]) !== value.slice(3)) {
        return false;
      }

      if (value.startsWith("in.(") && !value.slice(4, -1).split(",").includes(String(row[key]))) {
        return false;
      }
    }
    return true;
  });
}

function startPostgrestFixture() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const table = url.pathname.split("/").filter(Boolean).pop();

    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }

    const rows = filterRows(table, url.searchParams);
    const isObjectResponse = req.headers.accept?.includes("vnd.pgrst.object");
    const body = isObjectResponse ? (rows[0] || null) : rows;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });

  return server;
}

function childSource(modulePaths) {
  return `
import { sign } from "cookie-signature";

// session.js and tenantContext.js intentionally log diagnostics.  Keep test
// output free of session values while still executing their real code.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const { default: reportHandler } = await import(${JSON.stringify(modulePaths.report)});
const { default: costLineHandler } = await import(${JSON.stringify(modulePaths.costLines)});
const { default: authMeHandler } = await import(${JSON.stringify(modulePaths.authMe)});
const { default: tenantUserMeHandler } = await import(${JSON.stringify(modulePaths.tenantUserMe)});

function request(sessionId, extraHeaders = {}) {
  const headers = { host: "localhost", ...extraHeaders };
  if (sessionId) {
    headers.cookie = "iconnect.sid=s:" + sign(
      sessionId,
      process.env.SESSION_SECRET,
    );
  }
  return { method: "GET", query: {}, headers };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end() {
      return this;
    },
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

const comparison = {
  memberAuthMe: await invoke(authMeHandler, request("member-admin-session")),
  tenantUserAuthMe: await invoke(
    tenantUserMeHandler,
    request("tenant-user-session"),
  ),
};

const scenarios = {
  tenantUser: request("tenant-user-session"),
  memberAdmin: request("member-admin-session"),
  deniedRole: request("member-denied-session"),
  missingSession: request(null),
  expiredSession: request("expired-session"),
  tenantMismatch: request("tenant-user-mismatch-session", {
    "x-tenant-id": ${JSON.stringify(OTHER_TENANT_ID)},
  }),
};

const matrix = {};
for (const [name, req] of Object.entries(scenarios)) {
  const report = await invoke(reportHandler, req);
  const costLines = await invoke(
    costLineHandler,
    { ...req, query: { event_id: "event-task4397", event_kind: "simple" } },
  );
  matrix[name] = {
    reportStatus: report.status,
    costLinesStatus: costLines.status,
  };
}

process.stdout.write(JSON.stringify({ comparison, matrix }));
`;
}

async function runHandlerChild(serverPort) {
  const modulePaths = {
    report: pathToFileURL(path.resolve("api/reports/event-budget-report.js")).href,
    costLines: pathToFileURL(path.resolve("api/reports/event-budget-report-cost-lines.js")).href,
    authMe: pathToFileURL(path.resolve("api/auth/me.js")).href,
    tenantUserMe: pathToFileURL(path.resolve("api/auth/tenant-user-me.js")).href,
  };

  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", childSource(modulePaths)],
    {
      env: {
        ...process.env,
        SESSION_SECRET,
        SUPABASE_URL: `http://127.0.0.1:${serverPort}`,
        SUPABASE_SERVICE_KEY: "task-4397-test-service-key",
        ROLE_ACCESS_OVERLAY_SKIP_PRIME: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const [exitCode] = await once(child, "close");
  if (exitCode !== 0) {
    throw new Error(`auth regression child exited ${exitCode}: ${stderr}`);
  }

  return JSON.parse(stdout);
}

test("signed real-session auth comparison and report guard status matrix", async () => {
  const server = startPostgrestFixture();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const result = await runHandlerChild(server.address().port);

    // /auth/me validates a member session, while /auth/tenant-user-me
    // validates the tenant-user session used by the admin dashboard.  These
    // are comparison endpoints, not authentication substitutes for reports.
    assert.equal(result.comparison.memberAuthMe.status, 200);
    assert.equal(result.comparison.memberAuthMe.body.id, "member-admin-task4397");
    assert.equal(result.comparison.tenantUserAuthMe.status, 200);
    assert.equal(result.comparison.tenantUserAuthMe.body.authenticated, true);

    assert.deepEqual(result.matrix, {
      tenantUser: { reportStatus: 200, costLinesStatus: 200 },
      memberAdmin: { reportStatus: 200, costLinesStatus: 200 },
      deniedRole: { reportStatus: 403, costLinesStatus: 403 },
      missingSession: { reportStatus: 401, costLinesStatus: 401 },
      expiredSession: { reportStatus: 401, costLinesStatus: 401 },
      tenantMismatch: { reportStatus: 409, costLinesStatus: 409 },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});