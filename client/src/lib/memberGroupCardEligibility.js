import { visibleGroupAssignments } from "./memberGroupAssignmentVisibility.js";

// Presentation only: never replace the raw assignments/members used for history,
// term-limit decisions, or membership actions with this projection.
export function projectGroupMemberCards(assignments, members, now = Date.now()) {
  const assignmentByMemberId = new Map();
  for (const assignment of visibleGroupAssignments(assignments, false, now)) {
    if (assignment.member_id) {
      assignmentByMemberId.set(assignment.member_id, assignment);
    }
  }
  // Preserve the existing last-row precedence among current assignments, with
  // role and term metadata always coming from the same selected assignment.
  const memberRoleByMemberId = new Map();
  for (const [id, assignment] of assignmentByMemberId) {
    if (assignment.group_role) memberRoleByMemberId.set(id, assignment.group_role);
  }
  const seen = new Set();
  const cardMembers = members.filter((member) => {
    if (!assignmentByMemberId.has(member.id) || seen.has(member.id)) return false;
    seen.add(member.id);
    return true;
  });
  return { cardMembers, assignmentByMemberId, memberRoleByMemberId };
}

export const GROUP_CARD_RECHECK_MS = 30_000;

// Local clock only: no query invalidation or network requests on each tick.
// Focus/visibility catch up immediately after a suspended/background tab.
export function watchGroupCardExpiry(onRecheck, targetWindow, targetDocument) {
  const recheck = () => onRecheck(Date.now());
  const onVisibility = () => {
    if (targetDocument.visibilityState === "visible") recheck();
  };
  const timer = targetWindow.setInterval(recheck, GROUP_CARD_RECHECK_MS);
  targetWindow.addEventListener("focus", recheck);
  targetDocument.addEventListener("visibilitychange", onVisibility);
  recheck();
  return () => {
    targetWindow.clearInterval(timer);
    targetWindow.removeEventListener("focus", recheck);
    targetDocument.removeEventListener("visibilitychange", onVisibility);
  };
}
