import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import { assignmentIsRemoved, surveyAvailability } from "@/lib/surveyLifecycle";

export default function SurveyAvailabilityBadge({ assignment, form: suppliedForm }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["survey-assignment-version-form", assignment.form_id],
    queryFn: () => base44.entities.Form.filter({ id: assignment.form_id }),
    enabled: !suppliedForm && !!assignment.form_id,
  });
  const form = suppliedForm || query.data?.find(row => row.id === assignment.form_id);
  const availability = surveyAvailability(form, assignment, now);
  return <div className="space-y-1.5" data-testid={`badge-status-${assignment.id}`}>
    <div className="flex flex-wrap gap-1.5"><Badge variant="outline">{assignmentIsRemoved(assignment) ? "Removed · history retained" : "Attached"}</Badge><Badge variant={availability.available ? "default" : "secondary"}>{!form && query.isLoading ? "Checking availability…" : availability.label}</Badge></div>
    <p className="max-w-sm text-xs text-slate-500">{availability.reason}</p>
    {query.isError && !suppliedForm && <button type="button" className="text-xs text-blue-600 underline" onClick={() => query.refetch()}>Retry availability check</button>}
  </div>;
}
