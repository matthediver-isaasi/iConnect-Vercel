import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

// Isolated browser fixture: mounts the actual client components but intercepts
// every request. No tenant authentication, database, storage or email calls.
const ORIGIN = "http://speaker-awards.fixture";
const SPEAKER_ID = "11111111-1111-4111-8111-111111111111";
const AWARD_ID = "22222222-2222-4222-8222-222222222222";
const record = {
  id: AWARD_ID, event_id: "33333333-3333-4333-8333-333333333333",
  event_type: "event", event_title: "Fixture Speaker Workshop", awarded_at: "2026-10-01T10:00:00Z",
  status: "granted",
  badge: { name: "Speaker", image_url: "/api/fixture/badge.png", status: "awarded", evidence: "Event speaker recognition" },
  certificate: { status: "issued", available: true, error: null },
};
function source(base) {
  for (const candidate of [base, `${base}.jsx`, `${base}.js`, `${base}.mjs`, `${base}.tsx`, path.join(base, "index.jsx"), path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base;
}
let script;
let pdf;
test.beforeAll(async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Fixture Speaker Workshop certificate", { x: 32, y: 700, font, size: 18 });
  pdf = Buffer.from(await document.save());
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
        import SpeakerManagementPage from "./client/src/pages/SpeakerManagement.jsx";
        import { CpdPointsPage } from "./client/src/pages/CpdPoints.jsx";
        import SpeakerAwardsSection from "./client/src/components/events/SpeakerAwardsSection.jsx";
        import { emptySpeakerAwardConfig } from "./client/src/lib/speakerAwardsConfig.js";
        function Settings() {
          const [value, setValue] = useState({ ...emptySpeakerAwardConfig(), enabled: true });
          return <><SpeakerAwardsSection eventType="event" speakers={[{id:"${SPEAKER_ID}",full_name:"External Speaker"}]} value={value} onChange={setValue} />
            <pre data-testid="config-json">{JSON.stringify(value)}</pre></>;
        }
        const useAccess = () => ({ authResolved:true,sessionValidated:true,isAccessReady:true,
          isFeatureExcluded:()=>false,memberInfo:{id:"fixture-member"} });
        const History = () => <p data-testid="attendee-ledger">Original attendee ledger untouched</p>;
        const surface = new URL(location.href).searchParams.get("surface");
        const client = new QueryClient({ defaultOptions: { queries: {retry:false} } });
        createRoot(document.getElementById("root")).render(
          <QueryClientProvider client={client}>
            {surface === "admin" ? <SpeakerManagementPage /> : surface === "member"
              ? <CpdPointsPage useAccess={useAccess} HistoryComponent={History} />
              : <Settings />}
          </QueryClientProvider>);
      `,
      loader: "jsx", resolveDir: process.cwd(),
    },
    bundle: true, write: false, outfile: "speaker-awards-fixture.js", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
    plugins: [{
      name: "speaker-fixture-alias",
      setup(plugin) {
        plugin.onResolve({ filter: /^@\// }, args => {
          if (args.path === "@/hooks/useMemberAccess" || args.path === "@/api/base44Client"
            || args.path === "@/components/MemberCombobox") return { path: args.path, namespace: "fixture" };
          return { path: source(path.resolve("client/src", args.path.slice(2))) };
        });
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, args => {
          const contents = args.path === "@/hooks/useMemberAccess"
            ? "export const useMemberAccess = () => ({ isAccessReady:true,isFeatureExcluded:()=>false });"
            : args.path === "@/components/MemberCombobox"
              ? "export default function MemberCombobox() { return null; }"
              : `export const base44 = {entities:{SystemSettings:{list:async()=>[]},Badge:{list:async()=>[]},Speaker:{}},integrations:{Core:{}}};`;
          return { contents, loader: "jsx", resolveDir: process.cwd() };
        });
        plugin.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
      },
    }],
  });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
});
const json = (route, value) => route.fulfill({
  contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(value),
});
async function fixture(page, { empty = false } = {}) {
  const requests = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (route.request().resourceType() === "document" && url.origin === ORIGIN) {
      return route.fulfill({ contentType: "text/html", body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    }
    if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
    if (url.pathname === "/api/admin/speakers/paginated") return json(route, { speakers: [{
      id: SPEAKER_ID, full_name: "External Speaker", is_active: true,
    }], pagination: { page: 1, total: 1, totalPages: 1 } });
    if (url.pathname === "/api/admin/speakers/certificate-templates") return json(route, {
      templates: [{ id: "template-1", name: "Speaker Certificate" }],
    });
    if (url.pathname === "/api/admin/speaker-award-eligibility") return json(route, { eligibility: {} });
    if (url.pathname === "/api/admin/speakers/awards" || url.pathname === "/api/members/me/speaker-awards") {
      requests.push(`${url.pathname}${url.search}`);
      return json(route, { awards: empty ? [] : [record], pagination: {
        page: Number(url.searchParams.get("page")), page_size: 20, total: empty ? 0 : 1, total_pages: 1,
      } });
    }
    if (url.pathname === "/api/speaker-awards/certificate") {
      requests.push(`${url.pathname}${url.search}`);
      if (url.searchParams.get("id") !== AWARD_ID) return route.abort("blockedbyclient");
      return route.fulfill({ contentType: "application/pdf", headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename=speaker-certificate.pdf`,
      }, body: pdf });
    }
    if (url.pathname === "/api/fixture/badge.png") {
      requests.push(url.pathname);
      return route.fulfill({ contentType: "image/png", body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/EAAAAABJRU5ErkJggg==", "base64",
      ) });
    }
    if (url.pathname.startsWith("/api/")) return route.abort("blockedbyclient");
    return route.abort("blockedbyclient");
  });
  return requests;
}
test("staff speaker awards history previews and downloads actual PDF bytes", async ({ page }) => {
  const requests = await fixture(page);
  await page.goto(`${ORIGIN}/?surface=admin`);
  await page.getByTestId(`button-speaker-awards-${SPEAKER_ID}`).click();
  const panel = page.getByTestId("speaker-awards-history");
  await expect(panel).toContainText("Fixture Speaker Workshop");
  await expect(panel).toContainText("Artwork is not a verifiable credential");
  await panel.screenshot({ path: "/tmp/task-4838-speaker-awards-admin.png" });
  await panel.getByRole("button", { name: "View artwork" }).click();
  await expect.poll(() => requests.includes("/api/fixture/badge.png")).toBeTruthy();
  await panel.getByRole("button", { name: "Preview" }).click();
  await expect.poll(() => requests.some(r => r === `/api/speaker-awards/certificate?id=${AWARD_ID}`)).toBeTruthy();
  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe("%PDF-");
  expect(requests).toContain(`/api/speaker-awards/certificate?id=${AWARD_ID}&download=1`);
  expect(requests).toContain(`/api/admin/speakers/awards?speaker_id=${SPEAKER_ID}&page=1&page_size=20`);
});
test("member awards card is independent of attendee history, and absent when empty", async ({ page }) => {
  const requests = await fixture(page);
  await page.goto(`${ORIGIN}/?surface=member`);
  await expect(page.getByTestId("attendee-ledger")).toBeVisible();
  const panel = page.getByTestId("member-speaker-awards");
  await expect(panel).toContainText("Fixture Speaker Workshop");
  await panel.screenshot({ path: "/tmp/task-4838-speaker-awards-member.png" });
  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/speaker-certificate.*\.pdf/);
  expect(requests).toContain("/api/members/me/speaker-awards?page=1&page_size=20");
});
test("member without awards has no extra card", async ({ page }) => {
  await fixture(page, { empty: true });
  await page.goto(`${ORIGIN}/?surface=member`);
  await expect(page.getByTestId("member-speaker-awards")).toHaveCount(0);
  await expect(page.getByTestId("attendee-ledger")).toBeVisible();
});
test("settings support default and explicit no-certificate override", async ({ page }) => {
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  await fixture(page);
  await page.goto(`${ORIGIN}/?surface=settings`);
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
  await page.getByTestId("select-award-certificate").click();
  await page.getByRole("option", { name: "Speaker Certificate" }).click();
  await page.getByTestId(`button-award-override-${SPEAKER_ID}`).click();
  await page.getByTestId(`select-override-certificate-${SPEAKER_ID}`).click();
  await page.getByRole("option", { name: "No certificate for this speaker" }).click();
  const config = JSON.parse(await page.getByTestId("config-json").innerText());
  expect(config.default.certificate_template_id).toBe("template-1");
  expect(config.overrides[SPEAKER_ID].certificate_template_id).toBeNull();
});