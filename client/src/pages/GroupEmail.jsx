import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import GroupEmailManager from "@/components/group-email/GroupEmailManager";

export default function GroupEmailPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("membership.member-group-email")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const { data: qualifying = [], isLoading: loadingGroups, isError: groupsError } = useQuery({
    queryKey: ["member-campaigns", "qualifying-groups"],
    queryFn: async () => {
      const res = await fetch("/api/member-campaigns/qualifying-groups", { credentials: "include" });
      if (!res.ok) {
        if (res.status === 403) return [];
        throw new Error("Failed to load groups");
      }
      const data = await res.json();
      return data.groups || [];
    },
    enabled: accessChecked,
  });

  useEffect(() => {
    if (qualifying.length > 0 && !activeGroupId) {
      const requestedGroupId = new URLSearchParams(window.location.search).get("group_id");
      const requested =
        requestedGroupId && qualifying.find((g) => g.id === requestedGroupId);
      setActiveGroupId(requested ? requested.id : qualifying[0].id);
    }
  }, [qualifying, activeGroupId]);

  // Hard-redirect non-qualifying members away from /GroupEmail — the task
  // spec requires the page be invisible to anyone without permission, and
  // any direct URL navigation should bounce.
  useEffect(() => {
    if (accessChecked && !loadingGroups && !groupsError && qualifying.length === 0) {
      toast.error("You don't have permission to send group emails.");
      const redirectTimer = setTimeout(() => {
        window.location.href = createPageUrl("MemberGroups");
      }, 1200);
      return () => clearTimeout(redirectTimer);
    }
  }, [accessChecked, loadingGroups, groupsError, qualifying.length]);

  const activeGroup = useMemo(
    () => qualifying.find((g) => g.id === activeGroupId) || null,
    [qualifying, activeGroupId]
  );

  if (!accessChecked || loadingGroups) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (qualifying.length === 0) {
    // Redirect handled above; render a brief blocking placeholder to avoid
    // a flash of empty-state content.
    return (
      <div className="p-8 flex items-center justify-center" data-testid="redirect-no-access">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto" data-testid="page-group-email">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Mail className="w-5 h-5" /> Group Email
          </h1>
          <p className="text-sm text-muted-foreground">Email the members of your group.</p>
        </div>
        {qualifying.length > 1 && (
          <Select value={activeGroupId || ""} onValueChange={setActiveGroupId}>
            <SelectTrigger className="w-64" data-testid="select-active-group">
              <SelectValue placeholder="Choose a group..." />
            </SelectTrigger>
            <SelectContent>
              {qualifying.map((g) => (
                <SelectItem key={g.id} value={g.id} data-testid={`option-group-${g.id}`}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <Card>
        <CardContent className="p-6">
          <GroupEmailManager
            group={activeGroup}
            heading={
              <>
                {activeGroup ? activeGroup.name : "Campaigns"}{" "}
                <span className="text-xs text-muted-foreground font-normal">— your campaigns only</span>
              </>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
