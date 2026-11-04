import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import AssignmentVersionNotice from "./AssignmentVersionNotice";
import SurveyLifecycleDialog from "./SurveyLifecycleDialog";
import SurveyAvailabilityBadge from "./SurveyAvailabilityBadge";
import { assignmentIsRemoved, surveyAssignmentCardClass } from "@/lib/surveyLifecycle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Pencil,
  BarChart3,
  Copy,
  ExternalLink,
  RotateCcw,
  Trash2,
} from "lucide-react";

// Reusable section that lists survey assignments for an event (simple or complex)
// Event relationships are retained; lifecycle changes use the shared impact workflow.
export default function EventSurveysSection({ eventId, eventType = "event" }) {
  const [lifecycleRequest, setLifecycleRequest] = useState(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const queryClient = useQueryClient();
  const isComplex = eventType === "complex_event";

  const assignmentsKey = ["event-survey-assignments", eventType, eventId];

  const { data: assignments = [], isLoading, isError, refetch } = useQuery({
    queryKey: assignmentsKey,
    queryFn: () =>
      base44.entities.EventSurveyAssignment.filter(
        isComplex ? { complex_event_id: eventId } : { event_id: eventId },
        "-created_date"
      ),
    enabled: !!eventId,
  });

  // Forms are fetched once and reused for both name lookup and the assign dialog.
  const { data: forms = [] } = useQuery({
    queryKey: ["forms-for-surveys"],
    queryFn: () => base44.entities.Form.list(),
  });

  const formNameById = useMemo(() => {
    const map = {};
    (forms || []).forEach((f) => {
      if (f && f.id) map[f.id] = f.name;
    });
    return map;
  }, [forms]);

  const surveyForms = useMemo(
    () => (forms || []).filter((f) => f && f.form_type === "survey"),
    [forms]
  );
  const removedCount = assignments.filter(assignmentIsRemoved).length;
  const visibleAssignments = assignments.filter(row => showRemoved || !assignmentIsRemoved(row));

  // ---- Assign dialog state ----
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignFormId, setAssignFormId] = useState("");
  const [assignOpensAt, setAssignOpensAt] = useState("");
  const [assignClosesAt, setAssignClosesAt] = useState("");
  const [assignAccessMode, setAssignAccessMode] = useState("public");

  const resetAssignForm = () => {
    setAssignFormId("");
    setAssignOpensAt("");
    setAssignClosesAt("");
    setAssignAccessMode("public");
  };

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: assignmentsKey });

  const assignMutation = useMutation({
    mutationFn: async () => {
      const body = {
        form_id: assignFormId,
        event_type: eventType,
        event_id: eventId,
        access_mode: assignAccessMode,
      };
      if (assignOpensAt) body.opens_at = new Date(assignOpensAt).toISOString();
      if (assignClosesAt) body.closes_at = new Date(assignClosesAt).toISOString();
      const response = await fetch("/api/surveys/event-assignments", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const e = new Error(err.message || err.error || "Failed to assign survey");
        e.status = response.status;
        e.code = err.code;
        throw e;
      }
      return response.json();
    },
    onSuccess: () => {
      toast.success("Survey assigned");
      setAssignOpen(false);
      resetAssignForm();
      invalidate();
    },
    onError: (error) => {
      if (error.status === 409) {
        toast.error("That survey is already assigned to this event.");
      } else {
        toast.error(error.message || "Failed to assign survey");
      }
    },
  });

  const formatDate = (value) => {
    if (!value) return null;
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  const copyLink = async (row) => {
    const url = `${window.location.origin}/survey/${row.token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Assignment link copied");
    } catch {
      toast.error("Could not copy link");
    }
  };

  return (
    <div className="space-y-4" data-testid="event-surveys-section">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={event => setShowRemoved(event.target.checked)}
            className="h-4 w-4 accent-slate-900"
            data-testid="toggle-removed-surveys"
          />
          Show removed surveys{removedCount > 0 ? ` (${removedCount})` : ""}
        </label>
        <Button
          type="button"
          onClick={() => {
            resetAssignForm();
            setAssignOpen(true);
          }}
          data-testid="button-assign-survey"
        >
          <Plus className="w-4 h-4 mr-2" />
          Assign a survey
        </Button>
      </div>
      <p className="text-sm text-slate-500">Attached does not mean available. Survey lifecycle, published version, access rules and response dates determine whether a link accepts responses. Select “Show removed surveys” to view retained history or reattach a survey.</p>

      {isLoading ? (
        <div className="space-y-3 py-4 animate-pulse" role="status" aria-label="Loading surveys"><div className="h-24 rounded-lg bg-slate-100" /><div className="h-24 rounded-lg bg-slate-100" /></div>
      ) : isError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">Survey assignments could not be loaded. <button type="button" className="underline" onClick={() => refetch()}>Retry</button></div>
      ) : visibleAssignments.length === 0 ? (
        <p className="text-sm text-slate-500 py-4" data-testid="text-no-surveys">
          {removedCount > 0
            ? "No surveys currently attached. Select “Show removed surveys” to view or reattach previous surveys."
            : "No surveys assigned to this event yet."}
        </p>
      ) : (
        <div className="space-y-3">
          {visibleAssignments.map((row) => {
            const surveyName = formNameById[row.form_id] || "Survey";
            const form = forms.find(form => form.id === row.form_id);
            const openWindow =
              !row.opens_at && !row.closes_at
                ? "Open immediately, no close date"
                : `${formatDate(row.opens_at) || "Immediately"} → ${formatDate(row.closes_at) || "No close date"}`;
            return (
              <div
                key={row.id}
                className={`border rounded-lg p-4 space-y-3 ${surveyAssignmentCardClass(form, row)}`}
                data-testid={`survey-assignment-${row.id}`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-900" data-testid={`text-survey-name-${row.id}`}>
                        {surveyName}
                      </span>
                      <SurveyAvailabilityBadge assignment={row} form={form} />
                    </div>
                    <div className="text-sm text-slate-500">{openWindow}</div>
                    <div className="text-sm text-slate-500">
                      Access: {row.access_mode === "authenticated" ? "Members only" : "Public"}
                      {" · "}
                      Responses: {row.response_count || 0}
                    </div>
                  </div>
                </div>

                <AssignmentVersionNotice assignment={row} />

                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    asChild
                    data-testid={`link-edit-survey-${row.id}`}
                  >
                    <a href={`/FormBuilder?formId=${row.form_id}`}>
                      <Pencil className="w-3.5 h-3.5 mr-1.5" />
                      Edit survey
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    asChild
                    data-testid={`link-responses-${row.id}`}
                  >
                    <a href={`/FormSubmissions?form=${row.form_id}&assignment=${row.id}`}>
                      <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
                      Responses
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    asChild
                    data-testid={`link-survey-report-${row.id}`}
                  >
                    <a href={`/SurveyReports?formId=${row.form_id}&assignment=${row.id}`}>
                      <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
                      Report
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => copyLink(row)}
                    data-testid={`button-copy-link-${row.id}`}
                  >
                    <Copy className="w-3.5 h-3.5 mr-1.5" />
                    Copy link
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    asChild
                    data-testid={`link-open-survey-${row.id}`}
                  >
                    <a
                      href={`${window.location.origin}/survey/${row.token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                      Open
                    </a>
                  </Button>

                  <div className="ml-auto flex items-center gap-2">
                    {assignmentIsRemoved(row) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setLifecycleRequest({ form_id: row.form_id, assignment_id: row.id, action: "reattach_assignment" })}
                        data-testid={`button-reactivate-${row.id}`}
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                        Reattach to Event
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setLifecycleRequest({ form_id: row.form_id, assignment_id: row.id, action: "remove_assignment" })}
                        data-testid={`button-remove-${row.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                        Remove from Event
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <SurveyLifecycleDialog request={lifecycleRequest} onClose={() => setLifecycleRequest(null)} onComplete={invalidate} />
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent data-testid="dialog-assign-survey">
          <DialogHeader>
            <DialogTitle>Assign a survey</DialogTitle>
            <DialogDescription>
              Choose a survey form to attach to this event. You can optionally set when it opens and closes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="assign-survey-form">Survey</Label>
              <Select value={assignFormId} onValueChange={setAssignFormId}>
                <SelectTrigger id="assign-survey-form" data-testid="select-survey-form">
                  <SelectValue placeholder="Select a survey" />
                </SelectTrigger>
                <SelectContent>
                  {surveyForms.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-slate-500">
                      No survey forms found. Create one in the Form Builder first.
                    </div>
                  ) : (
                    surveyForms.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name || "Untitled survey"}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="assign-opens-at">Opens at (optional)</Label>
                <Input
                  id="assign-opens-at"
                  type="datetime-local"
                  value={assignOpensAt}
                  onChange={(e) => setAssignOpensAt(e.target.value)}
                  data-testid="input-opens-at"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="assign-closes-at">Closes at (optional)</Label>
                <Input
                  id="assign-closes-at"
                  type="datetime-local"
                  value={assignClosesAt}
                  onChange={(e) => setAssignClosesAt(e.target.value)}
                  data-testid="input-closes-at"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="assign-access-mode">Access</Label>
              <Select value={assignAccessMode} onValueChange={setAssignAccessMode}>
                <SelectTrigger id="assign-access-mode" data-testid="select-access-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public (anyone with the link)</SelectItem>
                  <SelectItem value="authenticated">Members only (must be logged in)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAssignOpen(false)}
              data-testid="button-cancel-assign"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => assignMutation.mutate()}
              disabled={!assignFormId || assignMutation.isPending}
              data-testid="button-confirm-assign"
            >
              {assignMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
