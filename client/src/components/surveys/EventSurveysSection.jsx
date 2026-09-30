import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Archive,
  RotateCcw,
  Trash2,
} from "lucide-react";

// Reusable section that lists survey assignments for an event (simple or complex)
// and lets admins assign, archive/reactivate and remove them.
// Writes go through /api/surveys/event-assignments (the generic entity API
// rejects writes for EventSurveyAssignment).
export default function EventSurveysSection({ eventId, eventType = "event" }) {
  const queryClient = useQueryClient();
  const isComplex = eventType === "complex_event";

  const assignmentsKey = ["event-survey-assignments", eventType, eventId];

  const { data: assignments = [], isLoading } = useQuery({
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

  const patchMutation = useMutation({
    mutationFn: async ({ id, ...changes }) => {
      const response = await fetch("/api/surveys/event-assignments", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...changes }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const e = new Error(err.message || err.error || "Failed to update survey");
        e.status = response.status;
        e.code = err.code;
        throw e;
      }
      return response.json();
    },
    onSuccess: (_data, variables) => {
      toast.success(variables.status === "archived" ? "Survey archived" : "Survey updated");
      invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update survey");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ id }) => {
      const response = await fetch("/api/surveys/event-assignments", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const e = new Error(err.message || err.error || "Failed to remove survey");
        e.status = response.status;
        e.code = err.code;
        throw e;
      }
      return response.json();
    },
    onSuccess: () => {
      toast.success("Survey removed");
      invalidate();
    },
    onError: (error) => {
      if (error.status === 409 || error.code === "HAS_RESPONSES") {
        toast.error(
          "This survey already has responses and can't be removed. Archive it instead to stop new responses."
        );
      } else {
        toast.error(error.message || "Failed to remove survey");
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

  // Status badge + derived "not open yet" / "closed" states for active rows.
  const renderStatusBadge = (row) => {
    if (row.status === "archived") {
      return (
        <Badge variant="secondary" data-testid={`badge-status-${row.id}`}>
          Archived
        </Badge>
      );
    }
    const now = Date.now();
    if (row.opens_at && new Date(row.opens_at).getTime() > now) {
      return (
        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100" data-testid={`badge-status-${row.id}`}>
          Not open yet
        </Badge>
      );
    }
    if (row.closes_at && new Date(row.closes_at).getTime() < now) {
      return (
        <Badge className="bg-slate-200 text-slate-700 hover:bg-slate-200" data-testid={`badge-status-${row.id}`}>
          Closed
        </Badge>
      );
    }
    return (
      <Badge className="bg-green-100 text-green-800 hover:bg-green-100" data-testid={`badge-status-${row.id}`}>
        Active
      </Badge>
    );
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
      <div className="flex justify-end">
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

      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading surveys...
        </div>
      ) : assignments.length === 0 ? (
        <p className="text-sm text-slate-500 py-4" data-testid="text-no-surveys">
          No surveys assigned to this event yet.
        </p>
      ) : (
        <div className="space-y-3">
          {assignments.map((row) => {
            const surveyName = formNameById[row.form_id] || "Survey";
            const openWindow =
              !row.opens_at && !row.closes_at
                ? "Open immediately, no close date"
                : `${formatDate(row.opens_at) || "Immediately"} → ${formatDate(row.closes_at) || "No close date"}`;
            return (
              <div
                key={row.id}
                className="border border-slate-200 rounded-lg p-4 space-y-3"
                data-testid={`survey-assignment-${row.id}`}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-900" data-testid={`text-survey-name-${row.id}`}>
                        {surveyName}
                      </span>
                      {renderStatusBadge(row)}
                    </div>
                    <div className="text-sm text-slate-500">{openWindow}</div>
                    <div className="text-sm text-slate-500">
                      Access: {row.access_mode === "authenticated" ? "Members only" : "Public"}
                      {" · "}
                      Responses: {row.response_count || 0}
                    </div>
                  </div>
                </div>

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
                    {row.status === "archived" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={patchMutation.isPending}
                        onClick={() => patchMutation.mutate({ id: row.id, status: "active" })}
                        data-testid={`button-reactivate-${row.id}`}
                      >
                        <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                        Reactivate
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={patchMutation.isPending}
                        onClick={() => patchMutation.mutate({ id: row.id, status: "archived" })}
                        data-testid={`button-archive-${row.id}`}
                      >
                        <Archive className="w-3.5 h-3.5 mr-1.5" />
                        Archive
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      disabled={deleteMutation.isPending}
                      onClick={() => deleteMutation.mutate({ id: row.id })}
                      data-testid={`button-remove-${row.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
