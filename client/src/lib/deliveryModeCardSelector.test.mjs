import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("delivery mode selector exposes both choices as native radios with selected styling", () => {
  const source = read("client/src/components/events/DeliveryModeCardSelector.jsx");

  assert.match(source, /title: "In-Person Event"/);
  assert.match(source, /title: "Online Event"/);
  assert.match(source, /type="radio"/);
  assert.match(source, /checked=\{selected\}/);
  assert.match(source, /onChange=\{\(\) => onChange\(value === "online"\)\}/);
  assert.match(source, /focus-within:ring-2/);
  assert.match(source, /data-selected=\{selected \? "true" : "false"\}/);
  assert.match(source, /grid-cols-1[^"]*sm:grid-cols-2/);
});

test("simple-event creation preserves its delivery handler and conditional mode content", () => {
  const source = read("client/src/pages/CreateEvent.jsx");

  assert.match(source, /<DeliveryModeCardSelector[\s\S]*?onChange=\{handleDeliveryModeChange\}/);
  assert.match(source, /<DeliveryModeCardSelector\s+label="Event Type"/);
  assert.match(source, /\{!isOnline && !isGroupLimited && \(/);
  assert.match(source, /\{isOnline && isGroupLimited && \(/);
  assert.match(source, /\{isOnline && !isTraining && \(/);
  assert.match(source, /onlineProvider === 'teams'/);
  assert.doesNotMatch(source, /data-testid="switch-delivery-mode"/);
});

test("complex-session editor updates is_online and retains provider-specific content", () => {
  const source = read("client/src/pages/CreateComplexEvent.jsx");

  assert.match(source, /<DeliveryModeCardSelector[\s\S]*?isOnline=\{sessionForm\.is_online\}/);
  assert.match(source, /setSessionForm\(\(prev\) => \(\{ \.\.\.prev, is_online: checked \}\)\)/);
  assert.match(source, /\{sessionForm\.is_online && !isGroupLimited && \(/);
  assert.doesNotMatch(source, /data-testid="switch-session-is-online"/);
});

test("group-limited simple-event editing uses the labelled card selector", () => {
  const source = read("client/src/pages/EditEvent.jsx");

  assert.match(source, /isGroupLimited && \(\s*<DeliveryModeCardSelector/);
  assert.match(source, /<DeliveryModeCardSelector\s+label="Event Type"/);
  assert.match(source, /isOnline=\{isOnlineEvent\}/);
  assert.match(source, /onChange=\{setIsOnlineEvent\}/);
  assert.doesNotMatch(source, /data-testid="switch-delivery-mode"/);
});