import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GROUP_CARD_RECHECK_MS,
  projectGroupMemberCards,
  watchGroupCardExpiry,
} from "./memberGroupCardEligibility.js";

const now = Date.parse("2026-10-19T00:00:00Z");

test("cards use assignment expiry, not global member status or term dates", () => {
  const assignments = [
    { member_id: "expired", expires_at: "2026-10-18" },
    { member_id: "boundary", expires_at: "2026-10-19" },
    { member_id: "future", expires_at: "2026-10-19T00:00:00.001Z", term_end_date: "2020-01-01" },
    { member_id: "null", expires_at: null },
    { member_id: "missing" },
    { member_id: "legacy", expires_at: "invalid" },
  ];
  const members = assignments.map(({ member_id }) => ({ id: member_id, status: "active" }));
  const result = projectGroupMemberCards(assignments, members, now);
  assert.deepEqual(result.cardMembers.map(m => m.id), ["future", "null", "missing", "legacy"]);
  assert.deepEqual([...result.assignmentByMemberId.keys()], ["future", "null", "missing", "legacy"]);
});

test("expired duplicates cannot replace current role/term metadata in either order", () => {
  const expired = { id: "old", member_id: "tina", group_role: "Chair", term_number: 1, expires_at: "2026-10-19" };
  const current = { id: "current", member_id: "tina", group_role: "Secretary", term_number: 2, expires_at: "2027-10-19" };
  const member = { id: "tina", status: "active" };
  for (const assignments of [[expired, current], [current, expired]]) {
    const result = projectGroupMemberCards(assignments, [member, member], now);
    assert.deepEqual(result.cardMembers, [member]);
    assert.equal(result.assignmentByMemberId.get("tina"), current);
    assert.equal(result.memberRoleByMemberId.get("tina"), "Secretary");
  }
  const noRole = { ...current, id: "later", group_role: null };
  const result = projectGroupMemberCards([current, noRole, expired], [member], now);
  assert.equal(result.assignmentByMemberId.get("tina"), noRole);
  assert.equal(result.memberRoleByMemberId.has("tina"), false);
});

test("count, search and clamped pagination derive from eligible unique members", () => {
  const members = Array.from({ length: 26 }, (_, index) => ({
    id: `member-${index}`,
    name: `Person ${String(index).padStart(2, "0")}`,
  }));
  const assignments = members.map((m, i) => ({
    member_id: m.id,
    expires_at: i < 2 ? "2026-10-19" : "2027-10-19",
  }));
  assignments.push({ ...assignments[2] });
  const before = projectGroupMemberCards(assignments, [...members, members[2]], now - 1);
  assert.equal(before.cardMembers.length, 26);
  const { cardMembers } = projectGroupMemberCards(assignments, [...members, members[2]], now);
  assert.equal(cardMembers.length, 24);
  const sorted = cardMembers.toSorted((a, b) => a.name.localeCompare(b.name));
  assert.equal(sorted.filter(m => m.name.includes("Person 00")).length, 0);
  const totalPages = Math.max(1, Math.ceil(sorted.length / 24));
  const currentPage = Math.min(2, totalPages);
  assert.equal(totalPages, 1);
  assert.equal(currentPage, 1);
  assert.equal(sorted.slice((currentPage - 1) * 24, currentPage * 24).length, 24);
});

test("projection leaves history and membership records untouched, including when all expire", () => {
  const assignment = Object.freeze({ id: "assignment", member_id: "tina", expires_at: "2026-10-19", term_number: 3 });
  const member = Object.freeze({ id: "tina", status: "active" });
  const assignments = Object.freeze([assignment]);
  const members = Object.freeze([member]);
  assert.equal(projectGroupMemberCards(assignments, members, now - 1).cardMembers.length, 1);
  assert.equal(projectGroupMemberCards(assignments, members, now).cardMembers.length, 0);
  assert.deepEqual(assignments, [assignment]);
  assert.deepEqual(members, [member]);
  assert.equal(member.status, "active");
  assert.equal(assignment.term_number, 3);
});

test("bounded local clock reevaluates expiry on tick/focus/visible and cleans up", () => {
  const focus = new Map();
  const visibility = new Map();
  let tick;
  let cleared;
  const targetWindow = {
    setInterval(callback, delay) {
      assert.equal(delay, GROUP_CARD_RECHECK_MS);
      assert.ok(delay > 0 && delay <= 60_000);
      tick = callback;
      return 17;
    },
    clearInterval(id) { cleared = id; },
    addEventListener(name, fn) { focus.set(name, fn); },
    removeEventListener(name, fn) {
      assert.equal(focus.get(name), fn);
      focus.delete(name);
    },
  };
  const targetDocument = {
    visibilityState: "hidden",
    addEventListener(name, fn) { visibility.set(name, fn); },
    removeEventListener(name, fn) {
      assert.equal(visibility.get(name), fn);
      visibility.delete(name);
    },
  };
  const observed = [];
  const stop = watchGroupCardExpiry(value => observed.push(value), targetWindow, targetDocument);
  assert.equal(observed.length, 1);
  tick();
  focus.get("focus")();
  visibility.get("visibilitychange")();
  assert.equal(observed.length, 3);
  targetDocument.visibilityState = "visible";
  visibility.get("visibilitychange")();
  assert.equal(observed.length, 4);
  assert.ok(observed.every(Number.isFinite));
  stop();
  assert.equal(cleared, 17);
  assert.equal(focus.size, 0);
  assert.equal(visibility.size, 0);
});

test("page wires only cards to the projection and keeps decision checks on raw history", () => {
  const source = readFileSync(new URL("../pages/MemberGroupDetail.jsx", import.meta.url), "utf8");
  assert.match(source, /projectGroupMemberCards\(groupAssignments, members, cardEligibilityNow\)/);
  assert.match(source, /return cardMembers\s*\.map/);
  assert.match(source, /Members \(\{sortedMembers\.length\}\)/);
  assert.match(source, /const withRole = sortedMembers\.map/);
  assert.match(source, /return orderedMembers\.filter/);
  assert.match(source, /Math\.ceil\(filteredMembers\.length \/ MEMBERS_PER_PAGE\)/);
  assert.match(source, /Math\.min\(memberPage, totalPages\)/);
  assert.match(source, /return filteredMembers\.slice/);
  assert.match(source, /const existing = groupAssignments\.find/);
  assert.match(source, /resolvedId = members\.find/);
  assert.match(source, /queryKey: \["member-group-members", groupId, rawMemberIds\.join/);
  const helper = readFileSync(new URL("./memberGroupCardEligibility.js", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /base44|invalidateQueries|fetch\(|\.delete\(|\.update\(/);
});
