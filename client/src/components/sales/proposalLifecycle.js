// These are lifecycle states, not an activity timeline. In particular, the
// server permits issued -> accepted without sending through this application.
const stages = [
  { id: "draft", label: "Prepare draft", description: "Build and review the proposal." },
  { id: "issued", label: "Ready to send", description: "Issued version locked for delivery." },
  { id: "sent", label: "Awaiting customer", description: "Sent; awaiting a customer decision." },
  { id: "accepted", label: "Accepted", description: "Customer acceptance recorded." },
  { id: "converted", label: "Converted", description: "Proposal marked converted." },
];

const terminalMessages = {
  declined: "Declined. This version is no longer progressing.",
  rejected: "Rejected. This version is no longer progressing.",
  expired: "Expired. This version is no longer progressing.",
  revoked: "Revoked. This version is no longer progressing.",
  superseded: "Superseded. Refer to the current proposal version.",
};

export function proposalProgress(status = "draft") {
  const current = stages.findIndex(stage => stage.id === status);
  const terminal = terminalMessages[status];
  return {
    message: terminal || (current < 0 ? "Progress is unavailable for this status." : stages[current].description),
    steps: stages.map((stage, index) => ({
      ...stage,
      state: terminal || current < 0 ? "unconfirmed"
        : current === index ? "current"
        : stage.id === "sent" && current > index ? "unconfirmed"
        : current > index ? "complete" : "upcoming",
    })),
  };
}

// Fail closed: quote status and delivery audit entries are not proof that a
// bearer link is currently activated, unrevoked and unexpired.
export function revokeLinkAvailability({ status, hasActiveDeliveryLink, loading, error, permitted, pending }) {
  if (!permitted) return { enabled: false, reason: "You do not have permission to revoke customer links." };
  if (!["issued", "sent"].includes(status)) return { enabled: false, reason: "Customer links cannot be revoked in this proposal state." };
  if (pending) return { enabled: false, reason: "Updating customer link…" };
  if (loading) return { enabled: false, reason: "Checking for an active customer link…" };
  if (error || typeof hasActiveDeliveryLink !== "boolean") return { enabled: false, reason: "Active link status could not be verified. Refresh the proposal to retry." };
  if (!hasActiveDeliveryLink) return { enabled: false, reason: "No active customer link for this version. It may not have been sent, or its link was revoked or expired." };
  return { enabled: true, reason: "Disable the active customer link for this version." };
}
