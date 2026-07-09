import { useRef, useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Named, tenant-shared saved export reports (e.g. the Training Fund
// Management CSV export dialog).
//
// Storage model: ONE SystemSettings row per tenant per export surface, keyed
// by a fixed `settingKey` (SystemSettings is TENANT-scoped by the entity API,
// so a fixed key is automatically one row per tenant). The value is JSON
// `{ reports: [{ id, name, version, config }] }` where `config` is an opaque
// snapshot of the export dialog's settings owned by the calling page.
//
// Because reports are shared between admins, the list is refetched every time
// it is mounted/opened (no Infinity staleTime like the personal saved views).

const genReportId = () =>
  `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// Sanitize a raw parsed reports array: drop malformed entries, guarantee ids
// and a version number on each report.
export const sanitizeReports = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r) =>
        r &&
        typeof r === 'object' &&
        typeof r.name === 'string' &&
        r.name.trim() !== '' &&
        r.config &&
        typeof r.config === 'object'
    )
    .map((r) => ({
      id: typeof r.id === 'string' && r.id ? r.id : genReportId(),
      name: r.name,
      version: Number.isInteger(r.version) && r.version > 0 ? r.version : 1,
      config: r.config,
    }));
};

export function useSavedExportReports({ settingKey, description, enabled = true }) {
  if (!settingKey) throw new Error('useSavedExportReports: settingKey is required');
  const queryClient = useQueryClient();
  const rowIdRef = useRef(null);
  const [activeReportId, setActiveReportId] = useState(null);

  const queryKey = ['saved-export-reports', settingKey];

  const { data, isFetching, refetch } = useQuery({
    queryKey,
    enabled,
    staleTime: 15000,
    queryFn: async () => {
      try {
        const settings = await base44.entities.SystemSettings.list();
        const row = settings?.find((s) => s.setting_key === settingKey);
        if (row) {
          rowIdRef.current = row.id;
          let reports = [];
          try {
            reports = sanitizeReports(JSON.parse(row.setting_value)?.reports);
          } catch {}
          return { id: row.id, reports };
        }
        return { id: null, reports: [] };
      } catch {
        return { id: null, reports: [] };
      }
    },
  });

  useEffect(() => {
    if (data?.id) rowIdRef.current = data.id;
  }, [data]);

  const reports = data?.reports || [];
  const reportsLoaded = data !== undefined && data !== null;
  const activeReport = reports.find((r) => r.id === activeReportId) || null;

  const persistMutation = useMutation({
    mutationFn: async (nextReports) => {
      const valueStr = JSON.stringify({ reports: nextReports });
      if (rowIdRef.current) {
        await base44.entities.SystemSettings.update(rowIdRef.current, {
          setting_value: valueStr,
        });
      } else {
        const created = await base44.entities.SystemSettings.create({
          setting_key: settingKey,
          setting_value: valueStr,
          description,
        });
        if (created?.id) rowIdRef.current = created.id;
      }
      return nextReports;
    },
    onSuccess: (nextReports) => {
      queryClient.setQueryData(queryKey, {
        id: rowIdRef.current,
        reports: nextReports,
      });
    },
  });

  const mutateReports = useCallback(
    (updater) => {
      const current = queryClient.getQueryData(queryKey)?.reports || [];
      return persistMutation.mutateAsync(updater(current));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingKey, queryClient]
  );

  const createReport = useCallback(
    (name, config) => {
      const report = { id: genReportId(), name, version: 1, config };
      return mutateReports((curr) => [...curr, report]).then(() => report);
    },
    [mutateReports]
  );

  const updateReport = useCallback(
    (reportId, config) =>
      mutateReports((curr) =>
        curr.map((r) => (r.id === reportId ? { ...r, config } : r))
      ),
    [mutateReports]
  );

  const renameReport = useCallback(
    (reportId, name) =>
      mutateReports((curr) =>
        curr.map((r) => (r.id === reportId ? { ...r, name } : r))
      ),
    [mutateReports]
  );

  const deleteReport = useCallback(
    (reportId) => {
      const result = mutateReports((curr) => curr.filter((r) => r.id !== reportId));
      setActiveReportId((prev) => (prev === reportId ? null : prev));
      return result;
    },
    [mutateReports]
  );

  return {
    reports,
    reportsLoaded,
    isFetching,
    refetch,
    activeReportId,
    setActiveReportId,
    activeReport,
    createReport,
    updateReport,
    renameReport,
    deleteReport,
    isSaving: persistMutation.isPending,
  };
}
