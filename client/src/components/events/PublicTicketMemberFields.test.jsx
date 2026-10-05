import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "Event", "CustomEvent", "MutationObserver", "DocumentFragment"]) {
  globalThis[key] = key === "window" ? dom.window : dom.window[key];
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import("react")).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { default: PublicTicketMemberFields } = await import("./PublicTicketMemberFields.jsx");
const { default: PurchaserIdentityFields } = await import("../booking/PurchaserIdentityFields.jsx");

test("member creation controls only render for public-only tickets; toggle exposes a separate role and clears it when disabled", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let changed;
  const render = ticket => root.render(<PublicTicketMemberFields ticket={ticket} roles={[{ id: "contact", name: "Association contact" }]} onChange={patch => { changed = patch; }} />);
  await act(async () => render({ id: "ticket", visibility_mode: "members_and_public" }));
  assert.equal(host.textContent, "");
  const ticket = { id: "ticket", visibility_mode: "public_only", create_member_records: false };
  await act(async () => render(ticket));
  assert.equal(host.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
  assert.equal(host.querySelector('[role="combobox"]'), null);
  await act(async () => host.querySelector('[role="switch"]').click());
  assert.deepEqual(changed, { create_member_records: true, new_member_role_id: null });
  await act(async () => render({ ...ticket, ...changed, new_member_role_id: "contact" }));
  assert.ok(host.querySelector('[aria-label="Role for new members"]'));
  await act(async () => host.querySelector('[role="switch"]').click());
  assert.deepEqual(changed, { create_member_records: false, new_member_role_id: null });
  await act(async () => root.unmount());
  host.remove();
});

test("explicit purchaser form presents four required, labelled fields and does not copy attendee details", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PurchaserIdentityFields value={{}} onChange={() => {}} />));
  const inputs = [...host.querySelectorAll("input")];
  assert.equal(inputs.length, 4);
  assert.ok(inputs.every(input => input.required && input.value === "" && host.querySelector(`label[for="${input.id}"]`)));
  assert.match(host.textContent, /Each attendee must supply their own organisation/);
  await act(async () => root.unmount());
  host.remove();
});
