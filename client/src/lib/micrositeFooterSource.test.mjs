import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildMicrositeFooterSourcePayload } from "./micrositeFooterSource.js";

test("inherit and configured modes do not assign a Canvas footer", () => {
  assert.deepEqual(buildMicrositeFooterSourcePayload("inherit", "canvas-1"), {
    footer_source: "inherit",
    canvas_footer_id: null,
  });
  assert.deepEqual(buildMicrositeFooterSourcePayload("configured", "canvas-1"), {
    footer_source: "configured",
    canvas_footer_id: null,
  });
});

test("Canvas mode persists the selected footer ID", () => {
  assert.deepEqual(buildMicrositeFooterSourcePayload("canvas", "canvas-1"), {
    footer_source: "canvas",
    canvas_footer_id: "canvas-1",
  });
  assert.deepEqual(buildMicrositeFooterSourcePayload("canvas", ""), {
    footer_source: "canvas",
    canvas_footer_id: null,
  });
});

test("microsite footer editor exposes source-specific controls", () => {
  const source = fs.readFileSync(
    new URL("../components/microsites/MicrositeChromeEditor.jsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /data-testid="card-microsite-footer-source"/);
  assert.match(source, /value="inherit">Inherit main-site footer/);
  assert.match(source, /value="configured">Configured microsite footer/);
  assert.match(source, /value="canvas">Reusable Canvas footer/);
  assert.match(source, /footerSource === "inherit"/);
  assert.match(source, /footerSource === "configured"/);
  assert.match(source, /footerSource === "canvas"/);
  assert.match(source, /data-testid="select-microsite-canvas-footer"/);
  assert.match(source, /data-testid="button-edit-microsite-canvas-footer"/);
  assert.match(source, /data-testid="button-manage-microsite-canvas-footers"/);
  assert.match(source, /buildMicrositeFooterSourcePayload\(footerSource, canvasFooterId\)/);
});