import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";

// This checkout stores a reference snapshot, not a serving pin:
// api/public/survey-assignment/[token].js resolves survey_settings.current_version.
export default function AssignmentVersionNotice({ assignment }) {
  const formId = assignment.form_id;
  const formQuery = useQuery({
    queryKey: ["survey-assignment-version-form", formId],
    queryFn: () => base44.entities.Form.filter({ id: formId }),
    enabled: !!formId,
  });
  const versionsQuery = useQuery({
    queryKey: ["survey-assignment-versions", formId],
    queryFn: () => base44.entities.SurveyVersion.filter({ form_id: formId }),
    enabled: !!formId,
  });
  const form = formQuery.data?.find(row => row.id === formId);
  const versions = versionsQuery.data || [];
  const recorded = versions.find(row => row.id === assignment.survey_version_id && row.form_id === formId);
  const currentNumber = Number(form?.survey_settings?.current_version);
  const current = versions.find(row => row.form_id === formId && Number(row.version_number) === currentNumber);
  const validNumber = row => Number.isInteger(Number(row?.version_number)) && Number(row.version_number) > 0;
  const loading = formQuery.isLoading || versionsQuery.isLoading;
  const failed = formQuery.isError || versionsQuery.isError;
  const older = validNumber(recorded) && validNumber(current)
    && Number(recorded.version_number) < Number(current.version_number);

  return (
    <div className="space-y-1.5 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm" data-testid={`assignment-version-${assignment.id}`} aria-live="polite">
      {loading ? (
        <div className="animate-pulse text-slate-500">Loading version details…</div>
      ) : (
        <>
          <Badge variant="outline" className="border-slate-300 bg-slate-100 font-semibold text-slate-900">
            {validNumber(recorded) ? `Assigned snapshot: Version ${recorded.version_number}`
              : !assignment.survey_version_id ? "Assigned snapshot: Not recorded"
                : "Assigned snapshot: Unavailable"}
          </Badge>
          <p className="text-xs text-slate-600">
            {validNumber(current) && form?.survey_settings?.status === "published"
              ? `Link serves current published Version ${current.version_number}.`
              : "Current published version unavailable."}
          </p>
          {older && (
            <p className="text-xs font-medium text-amber-800">
              Assigned snapshot is older than current Version {current.version_number}.
            </p>
          )}
          <p className="text-xs text-slate-500">
            The assigned snapshot is a reference, not a version pin. This link uses the current published survey.
          </p>
          {failed && (
            <button type="button" className="text-xs font-medium text-blue-600 hover:underline" onClick={() => {
              formQuery.refetch();
              versionsQuery.refetch();
            }}>
              Version details could not be loaded. Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}
