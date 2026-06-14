import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import MemberCombobox from "@/components/MemberCombobox";

function getMemberLabel(member) {
  return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Unknown member";
}

/**
 * Lets a form admin assign any number of members as owners of a form.
 * Reuses MemberCombobox (tenant-wide member search) to add owners one at a time,
 * and shows the current selection as removable badges. Owner display names are
 * resolved via /api/members/by-ids so reopened forms render real names.
 */
export default function FormOwnersSelector({ owners = [], onChange }) {
  const [ownerDetails, setOwnerDetails] = useState({});
  const [comboKey, setComboKey] = useState(0);

  useEffect(() => {
    const missing = owners.filter((id) => id && !ownerDetails[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    fetch("/api/members/by-ids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ids: missing }),
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setOwnerDetails((prev) => {
          const next = { ...prev };
          data.forEach((m) => {
            if (m && m.id) next[m.id] = m;
          });
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [owners, ownerDetails]);

  const addOwner = (id) => {
    if (!id || id === "unassigned") return;
    if (owners.includes(id)) return;
    onChange([...owners, id]);
    // Remount the combobox so it resets to the empty/search state for the next add.
    setComboKey((k) => k + 1);
  };

  const removeOwner = (id) => {
    onChange(owners.filter((o) => o !== id));
  };

  return (
    <div className="space-y-3">
      <MemberCombobox
        key={comboKey}
        value="unassigned"
        onValueChange={addOwner}
        placeholder="Search members by name or email..."
        unassignedLabel="Add an owner..."
        testId="combobox-form-owner"
      />

      {owners.length > 0 ? (
        <div className="flex flex-wrap gap-2" data-testid="list-form-owners">
          {owners.map((id) => {
            const member = ownerDetails[id];
            const label = member ? getMemberLabel(member) : "Loading...";
            return (
              <Badge
                key={id}
                variant="secondary"
                className="gap-1.5 pr-1"
                data-testid={`badge-owner-${id}`}
              >
                <span className="truncate max-w-[200px]">{label}</span>
                <button
                  type="button"
                  onClick={() => removeOwner(id)}
                  className="rounded-full hover-elevate p-0.5"
                  aria-label={`Remove ${member ? getMemberLabel(member) : "owner"}`}
                  data-testid={`button-remove-owner-${id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="text-no-owners">
          No owners assigned yet. Owners get a dedicated "My Forms" tab showing only this form's submissions.
        </p>
      )}
    </div>
  );
}
