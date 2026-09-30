import { useQuery } from "@tanstack/react-query";

const WARN_THRESHOLD_PCT = 80;

async function fetchPlanUsage() {
  const r = await fetch("/api/admin/plan-usage", { credentials: "include" });
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error("Failed to load plan usage");
  return r.json();
}

export function useStorageUsageWarning({ enabled = true } = {}) {
  const query = useQuery({
    queryKey: ["/api/admin/plan-usage", "storage-banner"],
    queryFn: fetchPlanUsage,
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const data = query.data;
  const used = Number(data?.usage?.storage_mb);
  const limit = data?.plan?.quotas?.storage_mb;

  if (!data || !Number.isFinite(used) || limit == null) {
    return { shouldWarn: false, pct: null, used: null, limit: null, isOver: false };
  }

  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return {
    shouldWarn: pct >= WARN_THRESHOLD_PCT,
    isOver: pct >= 100,
    pct,
    used,
    limit,
  };
}
