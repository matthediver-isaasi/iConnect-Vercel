import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInviteTemplateResolutionPending,
  shouldInitializeInviteTemplate,
} from "./inviteMemberTemplate.js";

test("waits for role and configured template resolution", () => {
  assert.equal(isInviteTemplateResolutionPending({
    hasRoleId: true,
    rolesPending: true,
    rolesFetching: true,
    inviteTemplateId: null,
    templatePending: false,
    templateFetching: false,
  }), true);

  assert.equal(isInviteTemplateResolutionPending({
    hasRoleId: true,
    rolesPending: false,
    rolesFetching: false,
    inviteTemplateId: "configured-template",
    templatePending: true,
    templateFetching: true,
  }), true);
});

test("settled no-template and failed-load states allow fallback initialization", () => {
  assert.equal(isInviteTemplateResolutionPending({
    hasRoleId: true,
    rolesPending: false,
    rolesFetching: false,
    inviteTemplateId: null,
    templatePending: false,
    templateFetching: false,
  }), false);

  assert.equal(isInviteTemplateResolutionPending({
    hasRoleId: true,
    rolesPending: false,
    rolesFetching: false,
    inviteTemplateId: "missing-template",
    templatePending: false,
    templateFetching: false,
  }), false);
});

test("initializes once per opening so later query updates preserve edits", () => {
  assert.equal(shouldInitializeInviteTemplate({
    open: true,
    initialized: false,
    resolutionPending: false,
  }), true);
  assert.equal(shouldInitializeInviteTemplate({
    open: true,
    initialized: true,
    resolutionPending: false,
  }), false);
  assert.equal(shouldInitializeInviteTemplate({
    open: true,
    initialized: false,
    resolutionPending: true,
  }), false);
});

test("dialog uses a viewport-bounded column with a dedicated scroll region and fixed actions", () => {
  const source = readFileSync(
    new URL("../components/InviteMemberDialog.jsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /max-h-\[calc\(100dvh-1rem\)\]/);
  assert.match(source, /data-testid="invite-member-scroll-region"/);
  assert.match(source, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(source, /DialogFooter className="shrink-0/);
  assert.match(source, /data-testid="invite-template-loading"/);
});