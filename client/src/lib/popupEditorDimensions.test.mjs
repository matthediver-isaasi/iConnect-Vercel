import assert from "node:assert/strict";
import { test } from "node:test";
import { popupEditorDimensions } from "./popupEditorDimensions.js";
import { POPUP_DEFAULT_CONFIG } from "../../../shared/cmsPopupContract.js";

test("popup editing uses content width, not the selected host device's breakpoint", () => {
  const config = { modal: { width: 1010, padding: 30, border_width: 2 } };
  assert.deepEqual(popupEditorDimensions(config, "desktop"), { viewportWidth: 1200, modalWidth: 1010, contentWidth: 946, breakpoint: "tablet" });
  assert.deepEqual(popupEditorDimensions(config, "tablet"), { viewportWidth: 768, modalWidth: 744, contentWidth: 680, breakpoint: "tablet" });
  assert.deepEqual(popupEditorDimensions(config, "mobile"), { viewportWidth: 375, modalWidth: 351, contentWidth: 287, breakpoint: "mobile" });
});
test("wide popup editing respects the simulated viewport gutter", () => {
  assert.deepEqual(popupEditorDimensions({ modal: { width: 1600, padding: 0, border_width: 0 } }), { viewportWidth: 1200, modalWidth: 1176, contentWidth: 1176, breakpoint: "desktop" });
});
test("valid minimum modal width and maximum padding/border retain a positive mobile stage", () => {
  const result = popupEditorDimensions({ modal: { width: 240, padding: 96, border_width: 12 } }, "mobile");
  assert.equal(result.contentWidth, 24);
  assert.equal(result.breakpoint, "mobile");
});
test("dimension resolution does not mutate shared defaults or caller configuration", () => {
  const before = JSON.stringify(POPUP_DEFAULT_CONFIG);
  const config = Object.freeze({ modal: Object.freeze({ width: 400, padding: 18 }) });
  assert.equal(popupEditorDimensions(config).breakpoint, "mobile");
  assert.equal(JSON.stringify(POPUP_DEFAULT_CONFIG), before);
  assert.deepEqual(config.modal, { width: 400, padding: 18 });
});
