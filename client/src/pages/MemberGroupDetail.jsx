import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { buildTermSnapshot, formatTermLength, evaluateTermLimit } from "@/lib/memberGroupTermSnapshot";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { parseISO } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Award,
  Users,
  UserPlus,
  Loader2,
  ImageIcon,
  Check,
  LogOut,
  ArrowLeft,
  Search,
  ChevronLeft,
  ChevronRight,
  Crown,
  Linkedin,
  Briefcase,
  Calendar,
  Clock,
  CalendarClock,
  Plus,
  Layers,
  Repeat,
  Eye,
  EyeOff,
  Send,
  Mail,
  Trash2,
  X,
  Pencil,
  FileText,
  Download,
  ChevronDown,
  AlertTriangle,
  MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useMemberGroupSettings } from "@/hooks/useMemberGroupSettings";
import { filterGroupEventVisibility } from "@/hooks/useEventsData";
import { useEventTypes } from "@/hooks/useEventTypes";
import { parseEventTypes } from "@/lib/utils";
import EventCard from "@/components/events/EventCard";
import ResourceCard from "@/components/resources/ResourceCard";
import ForumThreadList from "@/components/forum/ForumThreadList";
import GroupEmailManager from "@/components/group-email/GroupEmailManager";
import GroupAdminSupportSection from "@/components/support/GroupAdminSupportSection";
import { uploadFileWithProgress, UPLOAD_TYPES } from "@/lib/tenantUpload";
import { createPageUrl } from "@/utils";
import { buildTenantFormResourceUrl, TENANT_FORM_RESOURCE_TYPE } from "@/lib/resourcePresentation";
import MemberProfileModal from "@/components/MemberProfileModal";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";
import EventImageUpload from "@/components/events/EventImageUpload";
import { sanitizeRichText } from "@/components/canvas/blocks/sanitize";
import DOMPurify from "dompurify";
import VacancyCard, {
  formatCommitment,
  formatTerm,
  formatMaxTerms,
  getPositionsAvailable,
  isVacancyClosed,
} from "@/components/vacancies/VacancyCard";
import {
  useVacancyInterest,
  VacancyInterestDialog,
} from "@/components/vacancies/useVacancyInterest";
import {
  collectRelationshipRecordIdsFromSubmissions,
  formatRelationshipDisplayValue,
  getSubmissionFieldValue,
  resolveSubmissionField,
} from "@/lib/relationshipDisplayLabels";

const parseFocalPoint = (fp) => {
  if (!fp) return null;
  if (typeof fp === "string") {
    try {
      return JSON.parse(fp);
    } catch {
      return null;
    }
  }
  return fp;
};

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MEMBERS_PER_PAGE = 24;

const EMPTY_RESOURCE_FORM = {
  title: "",
  description: "",
  resource_type: "download",
  target_url: "",
  open_in_new_tab: true,
  is_public: false,
};

const EMPTY_VACANCY_FORM = {
  role_title: "",
  role_description: "",
  commitment_value: "",
  commitment_unit: "hours_per_month",
  term_value: "",
  term_unit: "years",
  max_terms: "",
  application_form_id: "none",
  positions_available: "1",
  closing_date: "",
};

function isHtmlEmpty(html) {
  if (!html) return true;
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
  return text.length === 0;
}

function countNewSubmissions(subs, viewedAt) {
  if (!viewedAt) return subs.length;
  const v = new Date(viewedAt).getTime();
  return subs.filter((s) => {
    const t = s.created_date ? new Date(s.created_date).getTime() : 0;
    return t > v;
  }).length;
}

function renderAnswerValue(val) {
  if (val == null || val === "") return "—";
  if (Array.isArray(val)) {
    return (
      val
        .map((v) =>
          v && typeof v === "object" ? v.label || v.value || JSON.stringify(v) : v
        )
        .filter((v) => v !== "" && v != null)
        .join(", ") || "—"
    );
  }
  if (typeof val === "object") return val.label || val.value || JSON.stringify(val);
  return String(val);
}

// Render a grouped_question answer (an object keyed by sub-question id) as a
// readable list of each answered sub-question's label + text. Sub-questions
// left blank are omitted, consistent with how the modal filters empty answers.
// Returns null when there is nothing to render (caller can fall back).
function renderGroupedQuestionAnswer(field, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const subQuestions = Array.isArray(field?.sub_questions)
    ? field.sub_questions
    : [];
  const labelBySubId = new Map();
  for (const sq of subQuestions) {
    if (sq && sq.id) labelBySubId.set(sq.id, sq.label || "Untitled question");
  }
  // Preserve the form's sub-question order when known; append any extra keys
  // (e.g. removed sub-questions still present in older submissions) afterwards.
  const orderedIds = [
    ...subQuestions.map((sq) => sq && sq.id).filter(Boolean),
    ...Object.keys(value).filter((id) => !labelBySubId.has(id)),
  ];
  const answered = orderedIds
    .map((id) => [id, value[id]])
    .filter(([, v]) => v != null && String(v).trim() !== "");
  if (answered.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {answered.map(([subId, v]) => (
        <div key={subId} className="flex flex-col">
          <span className="text-xs font-medium text-slate-500">
            {labelBySubId.get(subId) || subId}
          </span>
          <span className="text-sm text-slate-800 whitespace-pre-wrap">
            {renderAnswerValue(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

function isEventInPast(event) {
  const dateStr = event.end_date || event.start_date;
  if (!dateStr) return false;
  try {
    const eventDate =
      typeof dateStr === "string" ? parseISO(dateStr) : new Date(dateStr);
    return eventDate < new Date();
  } catch {
    return false;
  }
}

function getMemberDisplay(member) {
  const first = (member.first_name || "").trim();
  const last = (member.last_name || "").trim();
  const anonymise = member.show_in_directory === false;
  if (anonymise) {
    const lastInitial = last ? `${last[0].toUpperCase()}.` : "";
    const displayName = [first, lastInitial].filter(Boolean).join(" ") || "Anonymous member";
    return { displayName, showAvatarImage: false, anonymised: true };
  }
  const displayName = [first, last].filter(Boolean).join(" ") || "Unknown member";
  return { displayName, showAvatarImage: true, anonymised: false };
}

function formatTermDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Admin-only term details for a member's group assignment (Task #1626).
// Renders nothing when the assignment carries no snapshotted term, unless the
// caller passes onEdit (group admin) — then an editor affordance is always
// shown so a missing/incorrect term can be set or corrected (Task #1629).
function TermDetails({ assignment, testIdSuffix, onEdit }) {
  if (!assignment) return null;
  const length = formatTermLength(assignment);
  const termNumber = Number(assignment.term_number);
  const maxTerms = Number(assignment.max_terms);
  const hasTermNumber = Number.isFinite(termNumber) && termNumber > 0;
  const hasMaxTerms = Number.isFinite(maxTerms) && maxTerms > 0;
  const start = formatTermDate(assignment.term_start_date);
  const end = formatTermDate(assignment.term_end_date);
  const hasAnyTerm = Boolean(length || hasTermNumber || start || end);
  if (!hasAnyTerm && !onEdit) return null;

  let termLabel = null;
  if (hasTermNumber && hasMaxTerms) termLabel = `Term ${termNumber} of ${maxTerms}`;
  else if (hasTermNumber) termLabel = `Term ${termNumber}`;

  const handleEdit = (e) => {
    e.stopPropagation();
    e.preventDefault();
    onEdit?.();
  };

  return (
    <div
      className="mt-1 text-xs text-slate-500 space-y-0.5"
      data-testid={`text-member-term-${testIdSuffix}`}
    >
      {termLabel && <div>{termLabel}{length ? ` · ${length}` : ""}</div>}
      {!termLabel && length && <div>{length}</div>}
      {(start || end) && (
        <div>
          {start || "—"}
          {" – "}
          {end || "—"}
        </div>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={handleEdit}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 -ml-1.5 text-slate-500 hover-elevate active-elevate-2"
          data-testid={`button-edit-term-${testIdSuffix}`}
        >
          <Pencil className="w-3 h-3" />
          {hasAnyTerm ? "Edit term" : "Set term"}
        </button>
      )}
    </div>
  );
}

// Admin-only dialog to correct a member's snapshotted term (Task #1629).
// Writes term_start_date / term_end_date / term_number straight to the
// member_group_assignment; never touches the role definition.
function EditTermDialog({ target, open, onOpenChange, onSave, isSaving }) {
  const assignment = target?.__assignment || null;
  const displayName = target?.__display?.displayName || "this member";
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [termNumber, setTermNumber] = useState("");

  useEffect(() => {
    if (!open || !assignment) return;
    setStartDate(
      assignment.term_start_date ? String(assignment.term_start_date).slice(0, 10) : ""
    );
    setEndDate(
      assignment.term_end_date ? String(assignment.term_end_date).slice(0, 10) : ""
    );
    setTermNumber(
      assignment.term_number != null && assignment.term_number !== ""
        ? String(Math.floor(Number(assignment.term_number)))
        : ""
    );
  }, [open, assignment]);

  const handleSave = () => {
    if (startDate && endDate && endDate < startDate) {
      toast.error("The end date can't be before the start date.");
      return;
    }
    let nextTermNumber = null;
    if (termNumber !== "") {
      const n = Math.floor(Number(termNumber));
      if (!Number.isFinite(n) || n < 1) {
        toast.error("Term number must be a whole number of 1 or more.");
        return;
      }
      nextTermNumber = n;
    }
    onSave({
      term_start_date: startDate || null,
      term_end_date: endDate || null,
      term_number: nextTermNumber,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-edit-term">
        <DialogHeader>
          <DialogTitle>Edit term</DialogTitle>
          <DialogDescription>
            Adjust the recorded term for {displayName}. This updates only this
            member's record and won't change the role's settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-term-start">Term start date</Label>
            <Input
              id="edit-term-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              data-testid="input-term-start-date"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-term-end">Term end date</Label>
            <Input
              id="edit-term-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              data-testid="input-term-end-date"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-term-number">Term number</Label>
            <Input
              id="edit-term-number"
              type="number"
              min="1"
              step="1"
              value={termNumber}
              onChange={(e) => setTermNumber(e.target.value)}
              placeholder="e.g. 1"
              className="w-28"
              data-testid="input-term-number"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
            data-testid="button-cancel-edit-term"
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving} data-testid="button-save-edit-term">
            {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function MemberGroupDetailPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const {
    eventsPerPage: EVENTS_PER_PAGE_CFG,
    resourcesPerPage: RESOURCES_PER_PAGE_CFG,
    featureName,
    allowGroupTermsOverride,
    defaultTermsOfReference,
  } = useMemberGroupSettings();
  const [accessChecked, setAccessChecked] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showTermsView, setShowTermsView] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showPostVacancy, setShowPostVacancy] = useState(false);
  const [hideClosedVacancies, setHideClosedVacancies] = useState(true);
  const [vacancyForm, setVacancyForm] = useState(EMPTY_VACANCY_FORM);
  const [removeVacancyTarget, setRemoveVacancyTarget] = useState(null);
  const [applicantsVacancy, setApplicantsVacancy] = useState(null);
  const [editingVacancyId, setEditingVacancyId] = useState(null);
  const [submissionsVacancy, setSubmissionsVacancy] = useState(null);
  const [expandedSubmissionId, setExpandedSubmissionId] = useState(null);
  // Advisory max-terms warning before awarding a vacancy (Task #1630).
  const [termWarning, setTermWarning] = useState(null);
  // Approve/decline decision modal (Task #1700). Holds the in-flight decision
  // context + the editable email body/CC.
  const [decisionModal, setDecisionModal] = useState(null);
  const [decisionBody, setDecisionBody] = useState("");
  const [decisionCc, setDecisionCc] = useState("");
  const [viewEmailRecord, setViewEmailRecord] = useState(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const groupId = searchParams.get("id");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("membership.member-group-access")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  const {
    data: group,
    isLoading: loadingGroup,
    isError: groupError,
  } = useQuery({
    queryKey: ["member-group", groupId],
    queryFn: () => base44.entities.MemberGroup.get(groupId),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: groupAssignments = [], isLoading: loadingAssignments } = useQuery({
    queryKey: ["member-group-assignments-group", groupId],
    queryFn: () => base44.entities.MemberGroupAssignment.filter({ group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: myAssignments = [], isLoading: loadingSelfAssignments } = useQuery({
    queryKey: ["member-group-assignments-self", memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.MemberGroupAssignment.filter({ member_id: memberInfo.id });
    },
    enabled: accessChecked && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const memberIds = useMemo(
    () => groupAssignments.filter((a) => a.member_id).map((a) => a.member_id),
    [groupAssignments]
  );

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ["member-group-members", groupId, memberIds.join(",")],
    queryFn: async () => {
      if (memberIds.length === 0) return [];
      const results = await Promise.all(
        memberIds.map((id) =>
          base44.entities.Member.get(id).catch(() => null)
        )
      );
      return results.filter(Boolean);
    },
    enabled: accessChecked && memberIds.length > 0,
    staleTime: 0,
  });

  const joinMutation = useMutation({
    mutationFn: async () => {
      if (!memberInfo?.id) throw new Error("You must be signed in to join a group");
      if (!group?.default_self_join_role) {
        throw new Error("This group has no default role configured");
      }
      const payload = {
        group_id: group.id,
        member_id: memberInfo.id,
        group_role: group.default_self_join_role,
      };
      if (hasTermsOfReference) {
        payload.terms_agreed = true;
      }
      return base44.entities.MemberGroupAssignment.create(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-self", memberInfo?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["member-group-assignments"] });
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-group", groupId],
      });
      setShowTerms(false);
      setAgreedToTerms(false);
      toast.success(`You've joined "${group?.name}"`);
    },
    onError: (error) => {
      toast.error("Failed to join group: " + (error?.message || "Unknown error"));
    },
  });

  const leaveMutation = useMutation({
    mutationFn: async () => {
      const assignment = myAssignments.find((a) => a.group_id === group?.id);
      if (!assignment) throw new Error("You are not a member of this group");
      if (isSoleActiveAdmin) {
        throw new Error(soleAdminLeaveMessage);
      }
      // Advisory guard: membership managed automatically (Task #3690).
      if (group?.allow_members_to_leave === false) {
        throw new Error("Membership in this group is managed automatically and cannot be left manually.");
      }
      return base44.entities.MemberGroupAssignment.delete(assignment.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-self", memberInfo?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["member-group-assignments"] });
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-group", groupId],
      });
      toast.success(`You've left "${group?.name}"`);
      setConfirmLeave(false);
    },
    onError: (error) => {
      toast.error("Failed to leave group: " + (error?.message || "Unknown error"));
    },
  });

  const isJoined = useMemo(
    () => myAssignments.some((a) => a.group_id === groupId),
    [myAssignments, groupId]
  );
  const hasCurrentAssignment = useMemo(() => {
    const now = Date.now();
    return myAssignments.some((assignment) => (
      assignment.group_id === groupId
      && (!assignment.expires_at || new Date(assignment.expires_at).getTime() > now)
    ));
  }, [myAssignments, groupId]);

  const isGroupAdmin = useMemo(() => {
    const nowIso = new Date().toISOString();
    return myAssignments.some((a) => {
      if (a.group_id !== groupId) return false;
      if (a.is_group_admin !== true) return false;
      if (!a.expires_at) return true;
      return new Date(a.expires_at).toISOString() > nowIso;
    });
  }, [myAssignments, groupId]);

  // Task #1592: a group admin who is the only active (non-expired) admin of the
  // group must promote another member before they can leave — otherwise the
  // group would be left with no admin. Mirrors the server-side guard.
  const isSoleActiveAdmin = useMemo(() => {
    if (!isGroupAdmin) return false;
    const nowIso = new Date().toISOString();
    const activeAdmins = groupAssignments.filter((a) => {
      if (a.group_id !== groupId) return false;
      if (a.is_group_admin !== true) return false;
      if (!a.expires_at) return true;
      return new Date(a.expires_at).toISOString() > nowIso;
    });
    return activeAdmins.length <= 1;
  }, [isGroupAdmin, groupAssignments, groupId]);

  const soleAdminLeaveMessage =
    "You can't leave this group while you're its only admin. Promote another member to admin first.";

  // Task #1594: a group can be silently orphaned if its only active admin's
  // assignment expires. When there is exactly one active admin and that
  // assignment has an upcoming expiry, surface a warning so a replacement can
  // be promoted before then. Mirrors the "active admin" definition above.
  const soleAdminExpiry = useMemo(() => {
    const nowIso = new Date().toISOString();
    const activeAdmins = groupAssignments.filter((a) => {
      if (a.group_id !== groupId) return false;
      if (a.is_group_admin !== true) return false;
      if (!a.expires_at) return true;
      return new Date(a.expires_at).toISOString() > nowIso;
    });
    if (activeAdmins.length !== 1) return null;
    const sole = activeAdmins[0];
    // No expiry means no passive-orphan risk.
    if (!sole.expires_at) return null;
    return sole.expires_at;
  }, [groupAssignments, groupId]);

  // Group-admin cosmetic content editing: when the tenant admin has enabled
  // the per-group toggle, active group admins may edit the header image and
  // the three description texts (never the name). Mirrors the server-side
  // whitelist on the generic entity PATCH.
  const [showContentEdit, setShowContentEdit] = useState(false);
  const [contentForm, setContentForm] = useState({
    header_image_url: "",
    description: "",
    who_is_it_for: "",
    about_the_group: "",
  });

  const saveContentMutation = useMutation({
    mutationFn: (payload) => base44.entities.MemberGroup.update(groupId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["member-group", groupId] });
      setShowContentEdit(false);
      toast.success("Group page updated");
    },
    onError: (error) => {
      toast.error("Failed to update group page: " + (error?.message || "unknown error"));
    },
  });

  const openContentEdit = () => {
    setContentForm({
      header_image_url: group?.header_image_url || "",
      description: group?.description || "",
      who_is_it_for: group?.who_is_it_for || "",
      about_the_group: group?.about_the_group || "",
    });
    setShowContentEdit(true);
  };

  const handleSaveContent = () => {
    saveContentMutation.mutate({
      header_image_url: contentForm.header_image_url || null,
      description: sanitizeRichText(contentForm.description || ""),
      who_is_it_for: sanitizeRichText(contentForm.who_is_it_for || ""),
      about_the_group: sanitizeRichText(contentForm.about_the_group || ""),
    });
  };

  const soleAdminExpiryLabel = useMemo(() => {
    if (!soleAdminExpiry) return null;
    try {
      const d =
        typeof soleAdminExpiry === "string"
          ? parseISO(soleAdminExpiry)
          : new Date(soleAdminExpiry);
      return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return null;
    }
  }, [soleAdminExpiry]);

  const effectiveTermsOfReference = useMemo(() => {
    const groupTor = group?.terms_of_reference;
    const groupTorHasText = groupTor && groupTor
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;|\u00A0/g, " ")
      .trim().length > 0;
    if (allowGroupTermsOverride && groupTorHasText) {
      return groupTor;
    }
    return defaultTermsOfReference || "";
  }, [group?.terms_of_reference, allowGroupTermsOverride, defaultTermsOfReference]);

  const hasTermsOfReference = useMemo(() => {
    if (!effectiveTermsOfReference) return false;
    const text = effectiveTermsOfReference
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;|\u00A0/g, " ")
      .trim();
    return text.length > 0;
  }, [effectiveTermsOfReference]);

  const { data: vacancies = [], isLoading: loadingVacancies } = useQuery({
    queryKey: ["group-vacancies", groupId],
    queryFn: () => base44.entities.Vacancy.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: myApplications = [] } = useQuery({
    queryKey: ["my-vacancy-applications", memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.VacancyApplication.filter({ member_id: memberInfo.id });
    },
    enabled: accessChecked && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const appliedVacancyIds = useMemo(
    () => new Set(myApplications.map((a) => a.vacancy_id)),
    [myApplications]
  );

  // Awards for this group's vacancies drive the remaining-positions count and
  // the "already awarded" markers in the review modals.
  const { data: groupAwards = [] } = useQuery({
    queryKey: ["group-vacancy-awards", groupId],
    queryFn: () =>
      base44.entities.VacancyAward.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId && isGroupAdmin,
    staleTime: 0,
    refetchOnMount: true,
  });

  const awardsByVacancy = useMemo(() => {
    const map = new Map();
    for (const a of groupAwards) {
      if (!a.vacancy_id) continue;
      if (!map.has(a.vacancy_id)) map.set(a.vacancy_id, []);
      map.get(a.vacancy_id).push(a);
    }
    return map;
  }, [groupAwards]);

  // Declined decisions (Task #1700) drive the "Declined" markers in the review
  // modals, mirroring the awards query.
  const { data: groupDeclines = [] } = useQuery({
    queryKey: ["group-vacancy-declines", groupId],
    queryFn: () =>
      base44.entities.VacancyDecline.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId && isGroupAdmin,
    staleTime: 0,
    refetchOnMount: true,
  });

  const declinesByVacancy = useMemo(() => {
    const map = new Map();
    for (const d of groupDeclines) {
      if (!d.vacancy_id) continue;
      if (!map.has(d.vacancy_id)) map.set(d.vacancy_id, []);
      map.get(d.vacancy_id).push(d);
    }
    return map;
  }, [groupDeclines]);

  const getDeclinesForVacancy = (vacancyId) => declinesByVacancy.get(vacancyId) || [];

  // Sent decision emails (Task #1700) back the "View sent email" action.
  const { data: groupDecisionEmails = [] } = useQuery({
    queryKey: ["group-vacancy-decision-emails", groupId],
    queryFn: () =>
      base44.entities.VacancyDecisionEmail.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId && isGroupAdmin,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Latest decision email per source (application/submission id) so the
  // "View sent email" action shows the most recent message that was sent.
  const decisionEmailBySource = useMemo(() => {
    const map = new Map();
    for (const e of groupDecisionEmails) {
      if (!e.source_id) continue;
      const existing = map.get(e.source_id);
      const et = e.created_at ? new Date(e.created_at).getTime() : 0;
      const xt = existing?.created_at ? new Date(existing.created_at).getTime() : 0;
      if (!existing || et >= xt) map.set(e.source_id, e);
    }
    return map;
  }, [groupDecisionEmails]);

  // Email templates back the approval/decline body pre-fill in the decision
  // modal. Resolved by id from the group's configured template choices.
  const { data: decisionEmailTemplates = [] } = useQuery({
    queryKey: ["email-templates-for-group-decisions", groupId],
    queryFn: () => base44.entities.EmailTemplate.list(),
    enabled: accessChecked && !!groupId && isGroupAdmin,
    staleTime: 5 * 60 * 1000,
  });

  const decisionTemplateById = useMemo(() => {
    const map = new Map();
    for (const t of decisionEmailTemplates) if (t?.id) map.set(t.id, t);
    return map;
  }, [decisionEmailTemplates]);

  const getAwardsForVacancy = (vacancyId) => awardsByVacancy.get(vacancyId) || [];
  const getRemainingPositions = (vacancy) =>
    Math.max(0, getPositionsAvailable(vacancy) - getAwardsForVacancy(vacancy.id).length);

  // Job-posting forms (admin only) populate the vacancy form picker and provide
  // field labels for the submissions review modal.
  const { data: jobPostingForms = [], isLoading: loadingJobPostingForms } = useQuery({
    queryKey: ["job-posting-forms"],
    queryFn: async () => {
      const all = await base44.entities.Form.list();
      return (all || []).filter((f) => f.is_job_posting === true);
    },
    enabled: accessChecked && isGroupAdmin,
    staleTime: 0,
  });

  const { data: resourceForms = [] } = useQuery({
    queryKey: ["tenant-forms-for-group-resources"],
    queryFn: async () => {
      const all = await base44.entities.Form.list();
      return (all || [])
        .filter((form) => form.is_active === true && form.slug)
        .sort((a, b) => String(a.name || a.title || a.slug).localeCompare(String(b.name || b.title || b.slug)));
    },
    enabled: accessChecked && isGroupAdmin,
    staleTime: 60_000,
  });

  // Public form list lets any member resolve a linked form's slug from its id
  // for the "Express interest" navigation.
  const { data: publicForms = [] } = useQuery({
    queryKey: ["public-forms-for-vacancies"],
    queryFn: () => publicClient.listForms(),
    enabled: accessChecked,
    staleTime: 5 * 60 * 1000,
  });

  const formSlugById = useMemo(() => {
    const map = new Map();
    for (const f of publicForms) if (f?.id) map.set(f.id, f.slug);
    for (const f of jobPostingForms) if (f?.id) map.set(f.id, f.slug);
    return map;
  }, [publicForms, jobPostingForms]);

  const formLinkedVacancyIds = useMemo(
    () => vacancies.filter((v) => v.application_form_id).map((v) => v.id),
    [vacancies]
  );

  const { data: submissionsByVacancy = {}, isLoading: loadingVacancySubmissions } = useQuery({
    queryKey: ["vacancy-submissions", groupId, formLinkedVacancyIds.join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        formLinkedVacancyIds.map(async (vid) => {
          const subs = await base44.entities.FormSubmission.filter({
            vacancy_id: vid,
          }).catch(() => []);
          const list = Array.isArray(subs) ? subs : [];
          list.sort((a, b) => {
            const at = a.created_date ? new Date(a.created_date).getTime() : 0;
            const bt = b.created_date ? new Date(b.created_date).getTime() : 0;
            return bt - at;
          });
          return [vid, list];
        })
      );
      return Object.fromEntries(entries);
    },
    enabled: accessChecked && isGroupAdmin && formLinkedVacancyIds.length > 0,
    staleTime: 0,
  });

  const submissionsForm = useMemo(
    () =>
      jobPostingForms.find(
        (f) => f.id === submissionsVacancy?.application_form_id
      ) || null,
    [jobPostingForms, submissionsVacancy]
  );

  const vacancyFormsById = useMemo(
    () => Object.fromEntries(jobPostingForms.filter((form) => form?.id).map((form) => [form.id, form])),
    [jobPostingForms]
  );

  // Only use submissions returned by the authorized vacancy query and forms
  // returned by the saved-form query. This prevents unrelated values from
  // broadening the submission-bound relationship-label lookup.
  const relationshipSubmissionBatch = useMemo(
    () => Object.values(submissionsByVacancy)
      .flatMap((submissions) => Array.isArray(submissions) ? submissions : [])
      .filter((submission) => (
        submission?.id
        && submission.form_id
        && vacancyFormsById[submission.form_id]
      )),
    [submissionsByVacancy, vacancyFormsById]
  );
  const relationshipSubmissionIds = useMemo(
    () => relationshipSubmissionBatch.map((submission) => submission.id),
    [relationshipSubmissionBatch]
  );
  const relationshipRecordIds = useMemo(
    () => collectRelationshipRecordIdsFromSubmissions(
      vacancyFormsById,
      relationshipSubmissionBatch
    ),
    [vacancyFormsById, relationshipSubmissionBatch]
  );
  const {
    data: relationshipLabelsByRecordId = {},
    isFetching: relationshipLabelsLoading,
  } = useQuery({
    queryKey: [
      "vacancy-submission-relationship-labels",
      relationshipSubmissionIds.join(","),
      relationshipRecordIds.join(","),
    ],
    enabled: relationshipSubmissionIds.length > 0 && relationshipRecordIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const labels = {};
      for (let submissionOffset = 0; submissionOffset < relationshipSubmissionBatch.length; submissionOffset += 2000) {
        const submissionBatch = relationshipSubmissionBatch.slice(
          submissionOffset,
          submissionOffset + 2000
        );
        const recordIds = collectRelationshipRecordIdsFromSubmissions(
          vacancyFormsById,
          submissionBatch
        );
        for (let recordOffset = 0; recordOffset < recordIds.length; recordOffset += 2000) {
          const response = await fetch("/api/admin/relationship-display-labels", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recordIds: recordIds.slice(recordOffset, recordOffset + 2000),
              submissionIds: submissionBatch.map((submission) => submission.id),
              context: "form-submissions",
            }),
          });
          if (!response.ok) throw new Error("Failed to resolve relationship labels");
          Object.assign(labels, (await response.json()).labels || {});
        }
      }
      return labels;
    },
  });

  const sortedVacancies = useMemo(() => {
    return [...vacancies].sort((a, b) => {
      const at = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bt - at;
    });
  }, [vacancies]);

  const closedVacancyCount = useMemo(
    () => sortedVacancies.filter((v) => isVacancyClosed(v)).length,
    [sortedVacancies]
  );

  const visibleVacancies = useMemo(() => {
    if (isGroupAdmin) return sortedVacancies;
    if (!hideClosedVacancies) return sortedVacancies;
    return sortedVacancies.filter((v) => !isVacancyClosed(v));
  }, [sortedVacancies, isGroupAdmin, hideClosedVacancies]);

  const saveVacancyMutation = useMutation({
    mutationFn: async () => {
      const title = vacancyForm.role_title.trim();
      const description = (vacancyForm.role_description || "").trim();
      if (!title) throw new Error("Role title is required");
      if (isHtmlEmpty(description)) throw new Error("Role description is required");
      const toNum = (v) =>
        v === "" || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
      const positions = toNum(vacancyForm.positions_available);
      const payload = {
        role_title: title,
        role_description: description,
        commitment_value: toNum(vacancyForm.commitment_value),
        commitment_unit: vacancyForm.commitment_unit,
        term_value: toNum(vacancyForm.term_value),
        term_unit: vacancyForm.term_unit,
        max_terms: toNum(vacancyForm.max_terms),
        positions_available: positions && positions > 0 ? Math.floor(positions) : 1,
        closing_date: vacancyForm.closing_date ? vacancyForm.closing_date : null,
        application_form_id:
          vacancyForm.application_form_id &&
          vacancyForm.application_form_id !== "none"
            ? vacancyForm.application_form_id
            : null,
      };
      if (editingVacancyId) {
        return base44.entities.Vacancy.update(editingVacancyId, payload);
      }
      return base44.entities.Vacancy.create({
        ...payload,
        member_group_id: groupId,
        posted_by_member_id: memberInfo?.id || null,
        status: "open",
      });
    },
    onSuccess: () => {
      const wasEdit = !!editingVacancyId;
      queryClient.invalidateQueries({ queryKey: ["group-vacancies", groupId] });
      setShowPostVacancy(false);
      setVacancyForm(EMPTY_VACANCY_FORM);
      setEditingVacancyId(null);
      toast.success(wasEdit ? "Vacancy updated" : "Vacancy posted");
    },
    onError: (error) => {
      toast.error("Failed to save vacancy: " + (error?.message || "Unknown error"));
    },
  });

  const markSubmissionsViewedMutation = useMutation({
    mutationFn: async (vacancy) =>
      base44.entities.Vacancy.update(vacancy.id, {
        applicants_viewed_at: new Date().toISOString(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group-vacancies", groupId] });
    },
  });

  const openEditVacancy = (vacancy) => {
    setEditingVacancyId(vacancy.id);
    setVacancyForm({
      role_title: vacancy.role_title || "",
      role_description: vacancy.role_description || "",
      commitment_value: vacancy.commitment_value ?? "",
      commitment_unit: vacancy.commitment_unit || "hours_per_month",
      term_value: vacancy.term_value ?? "",
      term_unit: vacancy.term_unit || "years",
      max_terms: vacancy.max_terms ?? "",
      application_form_id: vacancy.application_form_id || "none",
      positions_available: String(getPositionsAvailable(vacancy)),
      closing_date: vacancy.closing_date
        ? String(vacancy.closing_date).slice(0, 10)
        : "",
    });
    setShowPostVacancy(true);
  };

  const openSubmissions = (vacancy) => {
    setSubmissionsVacancy(vacancy);
    setExpandedSubmissionId(null);
    const subs = submissionsByVacancy[vacancy.id] || [];
    const newCount = countNewSubmissions(subs, vacancy.applicants_viewed_at);
    if (newCount > 0) markSubmissionsViewedMutation.mutate(vacancy);
  };

  const interest = useVacancyInterest({ memberInfo, formSlugById });
  const handleExpressInterest = interest.handleExpressInterest;

  const toggleVacancyStatusMutation = useMutation({
    mutationFn: async (vacancy) => {
      const nextStatus = vacancy.status === "closed" ? "open" : "closed";
      return base44.entities.Vacancy.update(vacancy.id, { status: nextStatus });
    },
    onSuccess: (_data, vacancy) => {
      queryClient.invalidateQueries({ queryKey: ["group-vacancies", groupId] });
      toast.success(
        vacancy.status === "closed" ? "Vacancy reopened" : "Vacancy closed"
      );
    },
    onError: (error) => {
      toast.error("Failed to update vacancy: " + (error?.message || "Unknown error"));
    },
  });

  const removeVacancyMutation = useMutation({
    mutationFn: async (vacancy) => base44.entities.Vacancy.delete(vacancy.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group-vacancies", groupId] });
      setRemoveVacancyTarget(null);
      toast.success("Vacancy removed");
    },
    onError: (error) => {
      toast.error("Failed to remove vacancy: " + (error?.message || "Unknown error"));
    },
  });

  // Approve/decline decision (Task #1700). Sends the admin's edited email via
  // the server endpoint, which ALSO performs the award (approval) or records the
  // decline. The award logic (vacancy_award + assignment term snapshot) lives
  // server-side so the email and the award happen atomically from one action.
  const decisionMutation = useMutation({
    mutationFn: async ({ decisionType, vacancy, memberId, email, sourceType, sourceId, bodyHtml, cc }) => {
      if (!vacancy?.id) throw new Error("No vacancy selected");
      const res = await fetch("/api/member-groups/vacancy-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          group_id: groupId,
          vacancy_id: vacancy.id,
          decision_type: decisionType,
          source_type: sourceType || null,
          source_id: sourceId || null,
          member_id: memberId || null,
          email: email || null,
          body_html: bodyHtml,
          cc: cc || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to send decision email");
      return { ...json, decisionType };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["group-vacancy-awards", groupId] });
      queryClient.invalidateQueries({ queryKey: ["group-vacancy-declines", groupId] });
      queryClient.invalidateQueries({ queryKey: ["group-vacancy-decision-emails", groupId] });
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-group", groupId],
      });
      queryClient.invalidateQueries({ queryKey: ["member-group-members", groupId] });
      toast.success(
        data?.decisionType === "approval"
          ? "Position awarded and email sent"
          : "Applicant declined and email sent"
      );
      setDecisionModal(null);
      setDecisionBody("");
      setDecisionCc("");
    },
    onError: (error) => {
      toast.error(error?.message || "Failed to send decision email");
    },
  });

  // Task #1629: let group admins correct a member's snapshotted term directly.
  // Writes only the snapshot fields on the assignment; the role definition is
  // never touched.
  const editTermMutation = useMutation({
    mutationFn: async ({ assignmentId, values }) => {
      if (!assignmentId) throw new Error("No assignment selected");
      return base44.entities.MemberGroupAssignment.update(assignmentId, values);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-group", groupId],
      });
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-self", memberInfo?.id],
      });
      queryClient.invalidateQueries({ queryKey: ["member-group-assignments"] });
      setEditTermTarget(null);
      toast.success("Term updated");
    },
    onError: (error) => {
      toast.error("Failed to update term: " + (error?.message || "Unknown error"));
    },
  });

  const { data: applicants = [], isLoading: loadingApplicants } = useQuery({
    queryKey: ["vacancy-applicants", applicantsVacancy?.id],
    queryFn: async () => {
      if (!applicantsVacancy?.id) return [];
      const apps = await base44.entities.VacancyApplication.filter({
        vacancy_id: applicantsVacancy.id,
      });
      const withMembers = await Promise.all(
        apps.map(async (app) => {
          const member = app.member_id
            ? await base44.entities.Member.get(app.member_id).catch(() => null)
            : null;
          return { ...app, __member: member };
        })
      );
      return withMembers.sort((a, b) => {
        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bt - at;
      });
    },
    enabled: accessChecked && isGroupAdmin && !!applicantsVacancy?.id,
    staleTime: 0,
  });

  // Task #3312: group-admin PDF download of an application/submission via a
  // short-lived signed URL from the server (authorised server-side too).
  const [downloadingPdfId, setDownloadingPdfId] = useState(null);
  const handleDownloadApplicationPdf = async (sourceType, sourceId) => {
    setDownloadingPdfId(sourceId);
    try {
      const response = await fetch(
        `/api/member-groups/vacancy-application-pdf?source_type=${encodeURIComponent(
          sourceType
        )}&source_id=${encodeURIComponent(sourceId)}`,
        { credentials: "include" }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.downloadUrl) {
        throw new Error(data.error || "Failed to generate PDF");
      }
      const link = document.createElement("a");
      link.href = data.downloadUrl;
      link.download = data.fileName || "application.pdf";
      link.target = "_blank";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      toast.error(error.message || "Failed to download the application PDF.");
    } finally {
      setDownloadingPdfId(null);
    }
  };

  const [memberSearch, setMemberSearch] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [selectedMemberId, setSelectedMemberId] = useState(null);
  const [editTermTarget, setEditTermTarget] = useState(null);

  const memberRoleByMemberId = useMemo(() => {
    const map = new Map();
    for (const a of groupAssignments) {
      if (a.member_id && a.group_role) map.set(a.member_id, a.group_role);
    }
    return map;
  }, [groupAssignments]);

  const assignmentByMemberId = useMemo(() => {
    const map = new Map();
    for (const a of groupAssignments) {
      if (a.member_id) map.set(a.member_id, a);
    }
    return map;
  }, [groupAssignments]);

  // Per-role term definitions live on the group (Task #1626). They drive the
  // read-only term shown on vacancy postings and the snapshot taken at award.
  const roleTermDefByRole = useMemo(() => {
    const defs = group?.role_term_definitions;
    return defs && typeof defs === "object" ? defs : {};
  }, [group]);

  // Advisory guardrail: does awarding this person their next term in `role`
  // exceed the role's max_terms? Resolves the member by id (applications) or by
  // email against the group's members (form submissions). Renewals into the
  // SAME role are the case that can exceed; a brand-new assignee resets to term
  // 1 and never warns. Returns { nextTermNumber, maxTerms, memberName, role } or
  // null. (Task #1630)
  const evaluateAwardTermLimit = ({ memberId, email, role }) => {
    if (!role) return null;
    let resolvedId = memberId || null;
    if (!resolvedId && email) {
      const wanted = email.trim().toLowerCase();
      resolvedId = members.find((m) => (m.email || "").toLowerCase() === wanted)?.id || null;
    }
    if (!resolvedId) return null;
    const existing = groupAssignments.find(
      (a) => a.member_id === resolvedId && a.group_id === groupId
    );
    const warning = evaluateTermLimit(roleTermDefByRole[role], {
      existingAssignment: existing || null,
      role,
    });
    if (!warning) return null;
    const member = members.find((m) => m.id === resolvedId);
    const memberName =
      member && `${member.first_name || ""} ${member.last_name || ""}`.trim()
        ? `${member.first_name || ""} ${member.last_name || ""}`.trim()
        : "This member";
    return { ...warning, memberName, role };
  };

  // Open the approve/decline email modal: resolve the group's configured
  // template, pre-fill the body with an auto-injected greeting + the template
  // body, and let the admin edit before sending (Task #1700).
  const openDecisionModal = (args) => {
    const { decisionType } = args;
    const templateId =
      decisionType === "approval"
        ? group?.approval_email_template_id
        : group?.decline_email_template_id;
    const template = templateId ? decisionTemplateById.get(templateId) : null;
    if (!templateId || !template) {
      toast.error(
        decisionType === "approval"
          ? "No approval email template is configured for this group. Set one in the group settings."
          : "No decline email template is configured for this group. Set one in the group settings."
      );
      return;
    }
    const firstName = (args.firstName || "").trim();
    const greeting = `<p>Dear ${firstName || "applicant"},</p>`;
    const templateBody = template.body || "<p></p>";
    setDecisionBody(`${greeting}${templateBody}`);
    setDecisionCc("");
    setDecisionModal(args);
  };

  // Gate an approval behind the max-terms confirmation dialog; declines open the
  // decision modal straight away.
  const requestDecision = (args) => {
    if (args.decisionType === "approval") {
      const role = (args?.vacancy?.role_title || "").trim();
      const warning = evaluateAwardTermLimit({
        memberId: args.memberId,
        email: args.email,
        role,
      });
      if (warning) {
        setTermWarning({ ...warning, decisionArgs: args });
        return;
      }
    }
    openDecisionModal(args);
  };

  const sortedMembers = useMemo(() => {
    return members
      .map((m) => ({
        ...m,
        __display: getMemberDisplay(m),
        __assignment: assignmentByMemberId.get(m.id) || null,
      }))
      .sort((a, b) => a.__display.displayName.localeCompare(b.__display.displayName));
  }, [members, assignmentByMemberId]);

  const groupRoles = useMemo(
    () => (Array.isArray(group?.roles) ? group.roles.filter(Boolean) : []),
    [group]
  );

  // When editing a legacy vacancy whose free-text role is no longer in the
  // group's configured roles, still surface it so the Select stays valid.
  const vacancyRoleOptions = useMemo(() => {
    const opts = [...groupRoles];
    const current = vacancyForm.role_title;
    if (current && !opts.includes(current)) opts.unshift(current);
    return opts;
  }, [groupRoles, vacancyForm.role_title]);

  const leadershipRoleSet = useMemo(
    () => new Set(Array.isArray(group?.leadership_roles) ? group.leadership_roles : []),
    [group]
  );

  const orderedMembers = useMemo(() => {
    const withRole = sortedMembers.map((m) => {
      const role = memberRoleByMemberId.get(m.id) || null;
      return {
        ...m,
        __role: role,
        __isLeader: Boolean(role && leadershipRoleSet.has(role)),
      };
    });
    const leaders = withRole.filter((m) => m.__isLeader);
    const others = withRole.filter((m) => !m.__isLeader);
    return [...leaders, ...others];
  }, [sortedMembers, memberRoleByMemberId, leadershipRoleSet]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return orderedMembers;
    return orderedMembers.filter((m) =>
      m.__display.displayName.toLowerCase().includes(q)
    );
  }, [orderedMembers, memberSearch]);

  useEffect(() => {
    setMemberPage(1);
  }, [memberSearch, groupId]);

  const totalPages = Math.max(1, Math.ceil(filteredMembers.length / MEMBERS_PER_PAGE));
  const currentPage = Math.min(memberPage, totalPages);
  const pagedMembers = useMemo(() => {
    const start = (currentPage - 1) * MEMBERS_PER_PAGE;
    return filteredMembers.slice(start, start + MEMBERS_PER_PAGE);
  }, [filteredMembers, currentPage]);

  // --- Group events section ---
  const isEventAdmin = !isFeatureExcluded("events.browse-events.create");

  // Non-members see all content (resources, events, vacancies) but with locked
  // CTAs. Tenant-level admins (isEventAdmin) are also treated as having access.
  const canAccessGroupContent = isJoined || isGroupAdmin || isEventAdmin;
  const { eventTypes } = useEventTypes();

  const { data: systemSettings = [] } = useQuery({
    queryKey: ["public-system-settings"],
    queryFn: () => publicClient.listSystemSettings(),
  });

  const { data: simpleGroupEvents = [], isLoading: loadingSimpleEvents } = useQuery({
    queryKey: ["member-group-events", groupId],
    queryFn: () => base44.entities.Event.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Multi-session (complex) group events — shown alongside simple events so
  // group admins can manage them from the group page (Task e1476154). Key is
  // prefixed by "member-group-events" so existing invalidations refresh both.
  const { data: complexGroupEvents = [], isLoading: loadingComplexEvents } = useQuery({
    queryKey: ["member-group-events", groupId, "complex"],
    queryFn: async () => {
      const rows = await base44.entities.ComplexEvent.filter({ member_group_id: groupId });
      return (rows || []).map((e) => ({ ...e, is_complex: true }));
    },
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const loadingEvents = loadingSimpleEvents || loadingComplexEvents;
  const groupEventsRaw = useMemo(
    () => [...simpleGroupEvents, ...complexGroupEvents],
    [simpleGroupEvents, complexGroupEvents]
  );

  const [eventSearch, setEventSearch] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [deliveryModeFilter, setDeliveryModeFilter] = useState("all");
  const [showPastEvents, setShowPastEvents] = useState(false);
  const [eventPage, setEventPage] = useState(1);
  const [eventSort, setEventSort] = useState("date-asc");

  // Apply group-event audience rules: public group events for everyone,
  // group-only events only for admins or members of THIS group. On this
  // group's own detail page non-members also see group-only events (they get
  // locked CTAs instead). Dormant bespoke RSVP events are hidden by the
  // shared helper.
  const accessibleGroupEvents = useMemo(() => {
    const visible = filterGroupEventVisibility(groupEventsRaw, {
      isAdmin: isEventAdmin,
      // Always pass groupId so non-members see this group's private events too;
      // the lock is applied at the CTA level via canAccessGroupContent.
      myGroupIds: [groupId],
    });
    return visible.filter((event) => {
      const isDraft =
        event.event_state === "draft" ||
        (!event.event_state && event.status === "draft");
      // Drafts are hidden from non-admins. Group admins of this group also
      // see drafts so they can manage duplicated/draft group events.
      return isDraft ? (isEventAdmin || isGroupAdmin) : true;
    });
  }, [groupEventsRaw, isEventAdmin, isGroupAdmin, isJoined, groupId]);

  const eventTypeNames = useMemo(
    () => eventTypes.map((t) => (typeof t === "object" ? t.name : t)).filter(Boolean),
    [eventTypes]
  );

  const filteredGroupEvents = useMemo(() => {
    const q = eventSearch.trim().toLowerCase();
    return accessibleGroupEvents
      .filter((event) => {
        const matchesSearch =
          !q ||
          event.title?.toLowerCase().includes(q) ||
          event.description?.toLowerCase().includes(q) ||
          event.location?.toLowerCase().includes(q);

        let matchesType = true;
        if (eventTypeFilter !== "all") {
          matchesType = parseEventTypes(event.event_type).includes(eventTypeFilter);
        }

        let matchesDelivery = true;
        if (deliveryModeFilter !== "all") {
          const online = event.is_online === true;
          matchesDelivery = deliveryModeFilter === "online" ? online : !online;
        }

        const matchesTime = showPastEvents || !isEventInPast(event);

        return matchesSearch && matchesType && matchesDelivery && matchesTime;
      })
      .sort((a, b) => {
        if (eventSort === "name-asc") {
          return (a.title || "").localeCompare(b.title || "");
        }
        if (eventSort === "name-desc") {
          return (b.title || "").localeCompare(a.title || "");
        }
        const aTbc = a.status === "tbc" || !a.start_date;
        const bTbc = b.status === "tbc" || !b.start_date;
        if (aTbc && !bTbc) return 1;
        if (!aTbc && bTbc) return -1;
        if (aTbc && bTbc) return (a.title || "").localeCompare(b.title || "");
        const diff =
          new Date(a.start_date).getTime() - new Date(b.start_date).getTime();
        return eventSort === "date-desc" ? -diff : diff;
      });
  }, [
    accessibleGroupEvents,
    eventSearch,
    eventTypeFilter,
    deliveryModeFilter,
    showPastEvents,
    eventSort,
  ]);

  const pastEventsCount = useMemo(
    () => accessibleGroupEvents.filter((e) => isEventInPast(e)).length,
    [accessibleGroupEvents]
  );

  useEffect(() => {
    setEventPage(1);
  }, [eventSearch, eventTypeFilter, deliveryModeFilter, showPastEvents, eventSort, groupId]);

  const eventTotalPages = Math.max(
    1,
    Math.ceil(filteredGroupEvents.length / EVENTS_PER_PAGE_CFG)
  );
  const currentEventPage = Math.min(eventPage, eventTotalPages);
  const pagedEvents = useMemo(() => {
    const start = (currentEventPage - 1) * EVENTS_PER_PAGE_CFG;
    return filteredGroupEvents.slice(start, start + EVENTS_PER_PAGE_CFG);
  }, [filteredGroupEvents, currentEventPage, EVENTS_PER_PAGE_CFG]);

  // --- Group resources section ---
  const { data: groupResources = [], isLoading: loadingResources } = useQuery({
    queryKey: ["member-group-resources", groupId],
    queryFn: () => base44.entities.Resource.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Subcategories an admin has linked to this group (Task #1701). Tenant
  // resources tagged with any of these surface in the group's Resources card.
  const linkedSubcategories = useMemo(
    () =>
      Array.isArray(group?.resource_subcategories)
        ? group.resource_subcategories.filter(
            (s) => typeof s === "string" && s.trim()
          )
        : [],
    [group]
  );

  // Tenant-wide resources (not owned by any group) tagged with one of this
  // group's linked subcategories. These are surfaced alongside the group's own
  // resources so members find the curated tenant resources for this group.
  const { data: linkedTenantResources = [] } = useQuery({
    queryKey: ["member-group-linked-resources", groupId, linkedSubcategories],
    queryFn: async () => {
      const all = await base44.entities.Resource.list("-release_date");
      return all.filter((r) => {
        if (r.member_group_id) return false; // tenant-wide resources only
        if (r.status === "draft") return false;
        const subs = Array.isArray(r.subcategories) ? r.subcategories : [];
        return subs.some((s) => linkedSubcategories.includes(s));
      });
    },
    enabled: accessChecked && !!groupId && linkedSubcategories.length > 0,
    staleTime: 0,
    refetchOnMount: true,
  });

  const isAuthenticated = !!memberInfo?.email;

  // --- Group forum summary section ---
  // The server filters group-linked forum categories to members who may access
  // them, so a returned active category implies the viewer has access. If none
  // is returned (no forum, inactive, or no access), nothing is rendered.
  const { data: groupForumCategories = [] } = useQuery({
    queryKey: ["member-group-forum-category", groupId],
    queryFn: () => base44.entities.ForumCategory.filter({ group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const groupForumCategory = useMemo(
    () => groupForumCategories.find((c) => c.is_active) || null,
    [groupForumCategories]
  );

  // Group Email section gating: reuse the standalone /GroupEmail discovery
  // endpoint, which returns only the groups this caller may send emails for
  // (200 with an empty list when they qualify nowhere). The section is shown
  // only when THIS group is in that set, so visibility matches the standalone
  // page's qualifying-groups rule exactly. No backend changes.
  const { data: emailQualifyingGroups = [] } = useQuery({
    queryKey: ["member-campaigns", "qualifying-groups"],
    queryFn: async () => {
      const res = await fetch("/api/member-campaigns/qualifying-groups", {
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 403) return [];
        throw new Error("Failed to load group email access");
      }
      const data = await res.json();
      return data.groups || [];
    },
    enabled: accessChecked && !!groupId && !isFeatureExcluded("membership.member-group-email"),
  });

  const emailGroup = useMemo(
    () => emailQualifyingGroups.find((g) => g.id === groupId) || null,
    [emailQualifyingGroups, groupId]
  );

  const [resourceSearch, setResourceSearch] = useState("");
  const [resourcePage, setResourcePage] = useState(1);
  const [resourceSort, setResourceSort] = useState("date-desc");
  const [showResourceDialog, setShowResourceDialog] = useState(false);
  const [resourceForm, setResourceForm] = useState(EMPTY_RESOURCE_FORM);
  const [resourceFile, setResourceFile] = useState(null);
  const [resourceImageFile, setResourceImageFile] = useState(null);
  const [resourceUploadProgress, setResourceUploadProgress] = useState(0);
  const [editingResource, setEditingResource] = useState(null);
  const [resourceToDelete, setResourceToDelete] = useState(null);

  // Non-admins never see member-only resources of another group; the public
  // ResourceCard handles the login gate, but here everyone viewing is already
  // a member, so we show all of the group's resources to members and admins.
  const visibleResources = useMemo(() => {
    // Merge the group's own resources with tenant-wide resources linked via a
    // subcategory (Task #1701), de-duplicating by id (a group resource
    // auto-tagged with a linked subcategory only appears in the group list).
    const byId = new Map();
    for (const r of groupResources) byId.set(r.id, r);
    for (const r of linkedTenantResources) if (!byId.has(r.id)) byId.set(r.id, r);
    const merged = Array.from(byId.values());
    // All merged resources are shown to everyone on this group detail page;
    // non-members see them but get a locked CTA via canAccessGroupContent.
    return merged;
  }, [groupResources, linkedTenantResources]);

  const filteredResources = useMemo(() => {
    const q = resourceSearch.trim().toLowerCase();
    return visibleResources
      .filter((r) => {
        if (!q) return true;
        return (
          r.title?.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (resourceSort === "name-asc") {
          return (a.title || "").localeCompare(b.title || "");
        }
        if (resourceSort === "name-desc") {
          return (b.title || "").localeCompare(a.title || "");
        }
        const aDate = new Date(a.published_date || a.created_date || 0).getTime();
        const bDate = new Date(b.published_date || b.created_date || 0).getTime();
        return resourceSort === "date-asc" ? aDate - bDate : bDate - aDate;
      });
  }, [visibleResources, resourceSearch, resourceSort]);

  useEffect(() => {
    setResourcePage(1);
  }, [resourceSearch, resourceSort, groupId]);

  const resourceTotalPages = Math.max(
    1,
    Math.ceil(filteredResources.length / RESOURCES_PER_PAGE_CFG)
  );
  const currentResourcePage = Math.min(resourcePage, resourceTotalPages);
  const pagedResources = useMemo(() => {
    const start = (currentResourcePage - 1) * RESOURCES_PER_PAGE_CFG;
    return filteredResources.slice(start, start + RESOURCES_PER_PAGE_CFG);
  }, [filteredResources, currentResourcePage, RESOURCES_PER_PAGE_CFG]);

  const createResourceMutation = useMutation({
    mutationFn: async (form) => {
      const isDownload = form.resource_type === "download";
      const isTenantForm = form.resource_type === TENANT_FORM_RESOURCE_TYPE;

      let targetUrl = (form.target_url || "").trim();

      // Direct file upload for downloadable resources (no repository picker).
      if (isDownload) {
        if (!resourceFile) {
          throw new Error("Please choose a file to upload.");
        }
        setResourceUploadProgress(1);
        const uploaded = await uploadFileWithProgress(resourceFile, {
          type: UPLOAD_TYPES.UPLOAD,
          entityId: groupId,
          onProgress: (p) => setResourceUploadProgress(p),
        });
        targetUrl = uploaded.file_url;

        // Mirror the upload into the group's File Repository folder so tenant
        // admins find it in /FileManagement. Best-effort: a failure here must
        // not block resource creation.
        try {
          let folderId = null;
          const folders = await base44.entities.FileRepositoryFolder.filter({
            member_group_id: groupId,
          });
          if (Array.isArray(folders) && folders.length > 0) {
            folderId = folders[0].id;
          }
          let fileType = "other";
          if (resourceFile.type.startsWith("image/")) fileType = "image";
          else if (resourceFile.type.startsWith("video/")) fileType = "video";
          else if (
            resourceFile.type.includes("pdf") ||
            resourceFile.type.includes("document")
          )
            fileType = "document";

          await base44.entities.FileRepository.create({
            file_name: uploaded.file_name,
            file_url: uploaded.file_url,
            file_type: fileType,
            mime_type: uploaded.mime_type,
            file_size: uploaded.file_size,
            uploaded_by: memberInfo?.email || "unknown",
            folder_id: folderId,
            storage_path: uploaded.storage_path,
            bucket: uploaded.bucket,
          });
        } catch (err) {
          console.error("[MemberGroupDetail] file repository sync failed:", err);
        }
      } else if (!targetUrl) {
        throw new Error("Please enter a URL for this resource.");
      }
      if (isTenantForm && !resourceForms.some(
        (tenantForm) => buildTenantFormResourceUrl(tenantForm.slug) === targetUrl
      )) {
        throw new Error("Please choose an active tenant form.");
      }

      let imageUrl = undefined;
      if (resourceImageFile) {
        const uploadedImage = await uploadFileWithProgress(resourceImageFile, {
          type: UPLOAD_TYPES.UPLOAD,
          entityId: groupId,
        });
        imageUrl = uploadedImage.file_url;
      }

      return base44.entities.Resource.create({
        title: form.title.trim(),
        description: (form.description || "").trim(),
        resource_type: form.resource_type,
        target_url: targetUrl,
        open_in_new_tab: form.open_in_new_tab !== false,
        is_public: form.is_public === true,
        status: "active",
        member_group_id: groupId,
        // Auto-tag with the group's linked subcategories (Task #1701) so the
        // resource surfaces tenant-wide under the matching filter. The server
        // applies the same default as a safety net.
        ...(linkedSubcategories.length > 0
          ? { subcategories: linkedSubcategories }
          : {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-resources", groupId],
      });
      setShowResourceDialog(false);
      setResourceForm(EMPTY_RESOURCE_FORM);
      setResourceFile(null);
      setResourceImageFile(null);
      setResourceUploadProgress(0);
      toast.success("Resource created successfully");
    },
    onError: (error) => {
      setResourceUploadProgress(0);
      toast.error(
        "Failed to create resource: " + (error?.message || "Unknown error")
      );
    },
  });

  const updateResourceMutation = useMutation({
    mutationFn: async ({ id, form }) => {
      const isDownload = form.resource_type === "download";
      const isTenantForm = form.resource_type === TENANT_FORM_RESOURCE_TYPE;

      let targetUrl = (form.target_url || "").trim();

      // A new file is only required when switching to / editing a download whose
      // existing target_url is being replaced. If no new file is chosen, keep the
      // existing target_url.
      if (isDownload) {
        if (resourceFile) {
          setResourceUploadProgress(1);
          const uploaded = await uploadFileWithProgress(resourceFile, {
            type: UPLOAD_TYPES.UPLOAD,
            entityId: groupId,
            onProgress: (p) => setResourceUploadProgress(p),
          });
          targetUrl = uploaded.file_url;
        } else if (!targetUrl) {
          throw new Error("Please choose a file to upload.");
        }
      } else if (!targetUrl) {
        throw new Error("Please enter a URL for this resource.");
      }
      if (isTenantForm && !resourceForms.some(
        (tenantForm) => buildTenantFormResourceUrl(tenantForm.slug) === targetUrl
      )) {
        throw new Error("Please choose an active tenant form.");
      }

      let imageUrl = undefined;
      if (resourceImageFile) {
        const uploadedImage = await uploadFileWithProgress(resourceImageFile, {
          type: UPLOAD_TYPES.UPLOAD,
          entityId: groupId,
        });
        imageUrl = uploadedImage.file_url;
      }

      return base44.entities.Resource.update(id, {
        title: form.title.trim(),
        description: (form.description || "").trim(),
        resource_type: form.resource_type,
        target_url: targetUrl,
        open_in_new_tab: form.open_in_new_tab !== false,
        is_public: form.is_public === true,
        ...(imageUrl ? { image_url: imageUrl } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-resources", groupId],
      });
      setShowResourceDialog(false);
      setEditingResource(null);
      setResourceForm(EMPTY_RESOURCE_FORM);
      setResourceFile(null);
      setResourceImageFile(null);
      setResourceUploadProgress(0);
      toast.success("Resource updated successfully");
    },
    onError: (error) => {
      setResourceUploadProgress(0);
      toast.error(
        "Failed to update resource: " + (error?.message || "Unknown error")
      );
    },
  });

  const deleteResourceMutation = useMutation({
    mutationFn: async (id) => base44.entities.Resource.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["member-group-resources", groupId],
      });
      setResourceToDelete(null);
      toast.success("Resource deleted successfully");
    },
    onError: (error) => {
      toast.error(
        "Failed to delete resource: " + (error?.message || "Unknown error")
      );
    },
  });

  const openEditResourceDialog = (resource) => {
    setEditingResource(resource);
    setResourceForm({
      title: resource.title || "",
      description: resource.description || "",
      resource_type: resource.resource_type || "external_link",
      target_url: resource.target_url || "",
      open_in_new_tab: resource.open_in_new_tab !== false,
      is_public: resource.is_public === true,
    });
    setResourceFile(null);
    setResourceImageFile(null);
    setResourceUploadProgress(0);
    setShowResourceDialog(true);
  };

  const isLoading =
    !accessChecked ||
    loadingGroup ||
    loadingAssignments ||
    loadingMembers ||
    loadingSelfAssignments;

  if (!groupId) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              Group not specified
            </h3>
            <p className="text-slate-600 mb-4">No group id was provided.</p>
            <Link to={createPageUrl("MemberGroups")}>
              <Button variant="outline" data-testid="link-back-groups">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to {featureName}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-600">Loading group...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Group admins can always open groups they manage, even when self-join is
  // disabled or the group is inactive (mirrors the "Only groups I manage"
  // filter on the list page). Non-admins still get the unavailable message.
  const groupUnavailable =
    !group ||
    groupError ||
    (!isGroupAdmin && (
      group.is_active === false
      || (!group.allow_self_join && !hasCurrentAssignment)
    ));

  const selfJoinClosed = !!group?.self_join_closed;
  const selfJoinClosedLabel = group?.self_join_closed_label?.trim() || 'Registrations closed';

  if (groupUnavailable) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              Group not available
            </h3>
            <p className="text-slate-600 mb-4">
              This group cannot be viewed. It may have been removed or is not open
              for self-join.
            </p>
            <Link to={createPageUrl("MemberGroups")}>
              <Button variant="outline" data-testid="link-back-groups">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to {featureName}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-4">
          <Link to={createPageUrl("MemberGroups")}>
            <Button variant="ghost" size="sm" data-testid="link-back-groups">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to {featureName}
            </Button>
          </Link>
        </div>

        <Card className="overflow-hidden mb-6" data-testid={`card-group-detail-${group.id}`}>
          <div className="relative w-full aspect-[5/2] bg-slate-100">
            {isGroupAdmin && group.group_admins_can_edit_content === true && (
              <Button
                variant="secondary"
                size="sm"
                className="absolute top-3 right-3 z-10 shadow"
                onClick={openContentEdit}
                data-testid="button-edit-group-content"
              >
                <Pencil className="w-4 h-4 mr-2" />
                Edit header & descriptions
              </Button>
            )}
            {group.header_image_url ? (
              <img
                src={group.header_image_url}
                alt={group.name}
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.target.onerror = null;
                  e.target.style.display = "none";
                }}
                data-testid={`img-group-header-${group.id}`}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-300">
                <ImageIcon className="w-16 h-16" />
              </div>
            )}
          </div>
          <CardContent className="p-6">
            <h1
              className="text-2xl md:text-3xl font-bold text-slate-900 mb-2"
              data-testid="text-group-name"
            >
              {group.name}
            </h1>
            {group.description && (
              <>
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-1">Purpose</h2>
                <div
                  className="text-slate-700 mb-4 prose prose-sm max-w-none"
                  data-testid="text-group-description"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(group.description || ""),
                  }}
                />
              </>
            )}
            {group.who_is_it_for && (
              <>
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-1">Who the group is for</h2>
                <div
                  className="text-slate-700 mb-4 prose prose-sm max-w-none"
                  data-testid="text-group-who-is-it-for"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(group.who_is_it_for || ""),
                  }}
                />
              </>
            )}
            {group.about_the_group && (
              <>
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-1">About the group</h2>
                <div
                  className="text-slate-700 mb-4 prose prose-sm max-w-none"
                  data-testid="text-group-about"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(group.about_the_group || ""),
                  }}
                />
              </>
            )}
            {group.linkedin_url && (
              <a
                href={group.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mb-4 font-medium"
                data-testid="link-group-linkedin"
              >
                <Linkedin className="w-4 h-4" />
                LinkedIn
              </a>
            )}
            {group.default_self_join_role && !isJoined && !selfJoinClosed && (
              <div className="mb-4">
                <span className="text-sm text-slate-500">You'll join as: </span>
                <Badge className="bg-blue-100 text-blue-700">
                  {group.default_self_join_role}
                </Badge>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {isJoined ? (
                <>
                  <div
                    className="inline-flex items-center text-sm text-slate-600 px-3"
                    data-testid="text-joined-status"
                  >
                    <Check className="w-4 h-4 mr-2 text-green-600" />
                    Already a member
                  </div>
                  {group.allow_members_to_leave !== false ? (
                    <Button
                      variant="outline"
                      onClick={() => setConfirmLeave(true)}
                      data-testid="button-leave-group"
                    >
                      <LogOut className="w-4 h-4 mr-2" />
                      Leave Group
                    </Button>
                  ) : (
                    <span
                      className="inline-flex items-center text-xs text-slate-500 px-2 py-1 rounded border border-slate-200 bg-slate-50"
                      data-testid="text-managed-membership-notice"
                    >
                      Membership is managed automatically — you cannot leave this group.
                    </span>
                  )}
                </>
              ) : selfJoinClosed ? (
                <Button
                  variant="outline"
                  disabled
                  data-testid="button-join-closed"
                >
                  {selfJoinClosedLabel}
                </Button>
              ) : (
                <Button
                  className="bg-blue-600 hover:bg-blue-700"
                  onClick={() => {
                    if (hasTermsOfReference) {
                      setAgreedToTerms(false);
                      setShowTerms(true);
                    } else {
                      joinMutation.mutate();
                    }
                  }}
                  disabled={
                    joinMutation.isPending ||
                    !memberInfo?.id ||
                    !group.default_self_join_role
                  }
                  data-testid="button-join-group"
                >
                  {joinMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <UserPlus className="w-4 h-4 mr-2" />
                  )}
                  Join Group
                </Button>
              )}
              {hasTermsOfReference && (
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setShowTermsView(true)}
                        data-testid="button-view-terms"
                      >
                        <FileText className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      View terms of reference
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </CardContent>
        </Card>

        {isGroupAdmin && soleAdminExpiry && (
          <Alert
            variant="warning"
            className="mb-6"
            data-testid="alert-sole-admin-expiring"
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              This group will have no admin once the only active admin's
              assignment expires
              {soleAdminExpiryLabel ? ` on ${soleAdminExpiryLabel}` : ""}.
              Promote another member to admin before then so the group isn't
              left without anyone able to manage it.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-5 h-5 text-slate-600" />
              <h2
                className="text-lg font-semibold text-slate-900"
                data-testid="text-members-heading"
              >
                Members ({sortedMembers.length})
              </h2>
            </div>
            {sortedMembers.length === 0 ? (
              <div className="text-center py-8 text-slate-500" data-testid="text-no-members">
                No members have joined this group yet.
              </div>
            ) : (
              <>
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  <Input
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder="Search members..."
                    className="pl-9"
                    data-testid="input-search-members"
                  />
                </div>

                {filteredMembers.length === 0 ? (
                  <div
                    className="text-center py-8 text-slate-500"
                    data-testid="text-no-members-matching"
                  >
                    No members match your search.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {pagedMembers.map((m) => {
                        const { displayName, showAvatarImage, anonymised } = m.__display;
                        const interactive = !anonymised;
                        const isLeader = m.__isLeader;
                        const handleOpen = () => {
                          if (interactive) setSelectedMemberId(m.id);
                        };
                        return (
                          <Card
                            key={m.id}
                            className={`overflow-hidden ${interactive ? "cursor-pointer hover-elevate active-elevate-2" : ""}`}
                            onClick={interactive ? handleOpen : undefined}
                            onKeyDown={
                              interactive
                                ? (e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      handleOpen();
                                    }
                                  }
                                : undefined
                            }
                            role={interactive ? "button" : undefined}
                            tabIndex={interactive ? 0 : undefined}
                            data-testid={`card-member-${m.id}`}
                          >
                            <CardContent className="p-3 flex items-center gap-3">
                              <Avatar className="h-10 w-10 flex-shrink-0">
                                {showAvatarImage && m.profile_photo_url ? (
                                  <AvatarImage src={m.profile_photo_url} alt={displayName} />
                                ) : null}
                                <AvatarFallback
                                  className={
                                    isLeader
                                      ? "bg-amber-100 text-amber-800"
                                      : "bg-blue-100 text-blue-700"
                                  }
                                >
                                  {getInitials(displayName)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0 flex-1">
                                <div
                                  className="font-medium text-sm text-slate-900 truncate"
                                  data-testid={`text-member-name-${m.id}`}
                                  title={displayName}
                                >
                                  {displayName}
                                </div>
                                {isLeader && (
                                  <div
                                    className="text-xs text-amber-700 truncate flex items-center gap-1"
                                    data-testid={`text-leader-role-${m.id}`}
                                    title={m.__role}
                                  >
                                    <Crown className="w-3 h-3 fill-current flex-shrink-0" />
                                    {m.__role}
                                  </div>
                                )}
                                {isGroupAdmin && (
                                  <TermDetails
                                    assignment={m.__assignment}
                                    testIdSuffix={m.id}
                                    onEdit={() => setEditTermTarget(m)}
                                  />
                                )}
                              </div>
                              {anonymised && (
                                <TooltipProvider delayDuration={100}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <EyeOff
                                        className="h-4 w-4 text-slate-400 flex-shrink-0"
                                        aria-label="Hidden from member directory"
                                        data-testid={`icon-hidden-${m.id}`}
                                      />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>Hidden from member directory</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>

                    {totalPages > 1 && (
                      <div
                        className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-200"
                        data-testid="pagination-members"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMemberPage((p) => Math.max(1, p - 1))}
                          disabled={currentPage <= 1}
                          data-testid="button-members-prev"
                        >
                          <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                        </Button>
                        <div
                          className="text-sm text-slate-600"
                          data-testid="text-members-page-indicator"
                        >
                          Page {currentPage} of {totalPages}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMemberPage((p) => Math.min(totalPages, p + 1))}
                          disabled={currentPage >= totalPages}
                          data-testid="button-members-next"
                        >
                          Next <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6" data-testid="card-vacancies-section">
          <CardContent className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <Briefcase className="w-5 h-5 text-slate-600" />
                <h2
                  className="text-lg font-semibold text-slate-900"
                  data-testid="text-vacancies-heading"
                >
                  Vacancies ({visibleVacancies.length})
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {!isGroupAdmin && closedVacancyCount > 0 && (
                  <div className="flex items-center gap-2">
                    <Switch
                      id="toggle-hide-closed-vacancies"
                      checked={hideClosedVacancies}
                      onCheckedChange={setHideClosedVacancies}
                      data-testid="switch-hide-closed-vacancies"
                    />
                    <Label
                      htmlFor="toggle-hide-closed-vacancies"
                      className="text-sm text-slate-600"
                    >
                      Hide closed
                    </Label>
                  </div>
                )}
                {isGroupAdmin && (
                  <Button
                    onClick={() => {
                      setVacancyForm(EMPTY_VACANCY_FORM);
                      setShowPostVacancy(true);
                    }}
                    data-testid="button-post-vacancy"
                  >
                    <UserPlus className="w-4 h-4 mr-2" />
                    Post vacancy
                  </Button>
                )}
              </div>
            </div>

            {loadingVacancies ? (
              <div className="flex items-center justify-center py-8 text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading vacancies...
              </div>
            ) : visibleVacancies.length === 0 ? (
              <div
                className="text-center py-8 text-slate-500"
                data-testid="text-no-vacancies"
              >
                No vacancies have been posted yet.
              </div>
            ) : (
              <div className="flex flex-col gap-4" data-testid="list-vacancies">
                {visibleVacancies.map((vacancy) => {
                  const isClosed = isVacancyClosed(vacancy);
                  const alreadyApplied = appliedVacancyIds.has(vacancy.id);
                  const positionsTotal = getPositionsAvailable(vacancy);
                  const positionsRemaining = getRemainingPositions(vacancy);
                  const adminActions = isGroupAdmin ? (
                    <>
                      {vacancy.application_form_id ? (
                        (() => {
                          const subs = submissionsByVacancy[vacancy.id] || [];
                          const newCount = countNewSubmissions(
                            subs,
                            vacancy.applicants_viewed_at
                          );
                          return (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openSubmissions(vacancy)}
                              data-testid={`button-view-submissions-${vacancy.id}`}
                            >
                              <FileText className="w-4 h-4 mr-2" />
                              Submissions
                              <Badge
                                variant="secondary"
                                className="ml-2"
                                data-testid={`badge-submissions-count-${vacancy.id}`}
                              >
                                {subs.length}
                              </Badge>
                              {newCount > 0 && (
                                <Badge
                                  variant="default"
                                  className="ml-1"
                                  data-testid={`badge-submissions-new-${vacancy.id}`}
                                >
                                  {newCount} new
                                </Badge>
                              )}
                            </Button>
                          );
                        })()
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setApplicantsVacancy(vacancy)}
                          data-testid={`button-view-applicants-${vacancy.id}`}
                        >
                          <Eye className="w-4 h-4 mr-2" />
                          Applicants
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openEditVacancy(vacancy)}
                        data-testid={`button-edit-vacancy-${vacancy.id}`}
                      >
                        <Pencil className="w-4 h-4 mr-2" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleVacancyStatusMutation.mutate(vacancy)}
                        disabled={toggleVacancyStatusMutation.isPending}
                        data-testid={`button-toggle-vacancy-${vacancy.id}`}
                      >
                        {isClosed ? "Reopen" : "Close"}
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setRemoveVacancyTarget(vacancy)}
                        data-testid={`button-remove-vacancy-${vacancy.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </>
                  ) : null;
                  return (
                    <VacancyCard
                      key={vacancy.id}
                      vacancy={vacancy}
                      alreadyApplied={alreadyApplied}
                      positionsTotal={positionsTotal}
                      positionsRemaining={positionsRemaining}
                      onExpressInterest={handleExpressInterest}
                      expressDisabled={!memberInfo?.id}
                      joinLocked={!canAccessGroupContent}
                      adminActions={adminActions}
                      collapsible
                    />
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6" data-testid="card-group-events-section">
          <CardContent className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-slate-600" />
                <h2
                  className="text-lg font-semibold text-slate-900"
                  data-testid="text-events-heading"
                >
                  Events ({filteredGroupEvents.length})
                </h2>
              </div>
              {isGroupAdmin &&
                (group?.events_enabled ||
                  group?.complex_events_enabled) && (
                <div className="flex flex-wrap items-center gap-2">
                  {group?.events_enabled && (
                    <Button
                      onClick={() =>
                        navigate(`/CreateEvent?group_event=1&group_id=${groupId}&from=MemberGroupDetail`)
                      }
                      data-testid="button-new-group-event"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      New event
                    </Button>
                  )}
                  {group?.complex_events_enabled && (
                    <Button
                      onClick={() =>
                        navigate(`/CreateComplexEvent?group_event=1&group_id=${groupId}`)
                      }
                      data-testid="button-new-group-complex-event"
                    >
                      <Layers className="w-4 h-4 mr-2" />
                      New multi-session event
                    </Button>
                  )}
                </div>
              )}
            </div>

            {loadingEvents ? (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
                {Array(3)
                  .fill(0)
                  .map((_, i) => (
                    <Card key={i} className="animate-pulse" data-testid="skeleton-event">
                      <div className="h-48 bg-slate-200" />
                      <CardContent className="p-6">
                        <div className="h-4 bg-slate-200 rounded mb-2" />
                        <div className="h-4 bg-slate-200 rounded w-2/3" />
                      </CardContent>
                    </Card>
                  ))}
              </div>
            ) : accessibleGroupEvents.length === 0 ? (
              <div className="text-center py-8 text-slate-500" data-testid="text-no-events">
                No events for this group yet.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-3 mb-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                      <Input
                        value={eventSearch}
                        onChange={(e) => setEventSearch(e.target.value)}
                        placeholder="Search events..."
                        className="pl-9"
                        data-testid="input-search-events"
                      />
                    </div>
                    {eventTypeNames.length > 0 && (
                      <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
                        <SelectTrigger
                          className="w-[180px]"
                          data-testid="select-event-type"
                        >
                          <SelectValue placeholder="All types" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All types</SelectItem>
                          {eventTypeNames.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Select
                      value={deliveryModeFilter}
                      onValueChange={setDeliveryModeFilter}
                    >
                      <SelectTrigger
                        className="w-[170px]"
                        data-testid="select-delivery-mode"
                      >
                        <SelectValue placeholder="All formats" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All formats</SelectItem>
                        <SelectItem value="online">Online</SelectItem>
                        <SelectItem value="offline">In-person</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={eventSort}
                      onValueChange={setEventSort}
                    >
                      <SelectTrigger
                        className="w-[180px]"
                        data-testid="select-event-sort"
                      >
                        <SelectValue placeholder="Sort by" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="date-asc">Date (oldest first)</SelectItem>
                        <SelectItem value="date-desc">Date (newest first)</SelectItem>
                        <SelectItem value="name-asc">Name (A–Z)</SelectItem>
                        <SelectItem value="name-desc">Name (Z–A)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {pastEventsCount > 0 && (
                    <div className="flex items-center gap-2">
                      <Switch
                        id="toggle-past-events"
                        checked={showPastEvents}
                        onCheckedChange={setShowPastEvents}
                        data-testid="switch-past-events"
                      />
                      <Label
                        htmlFor="toggle-past-events"
                        className="text-sm text-slate-600 cursor-pointer"
                      >
                        Show past events ({pastEventsCount})
                      </Label>
                    </div>
                  )}
                </div>

                {filteredGroupEvents.length === 0 ? (
                  <div
                    className="text-center py-8 text-slate-500"
                    data-testid="text-no-events-matching"
                  >
                    No events match your search or filters.
                  </div>
                ) : (
                  <>
                    <div
                      className="grid md:grid-cols-2 xl:grid-cols-3 gap-6"
                      data-testid="grid-group-events"
                    >
                      {pagedEvents.map((event) => (
                        <EventCard
                          key={event.id}
                          event={event}
                          isFeatureExcluded={isFeatureExcluded}
                          isAdmin={isEventAdmin}
                          systemSettings={systemSettings}
                          memberInfo={memberInfo}
                          joinLocked={!canAccessGroupContent}
                          groupAdminMode={
                            isGroupAdmin && event.member_group_id === groupId
                          }
                        />
                      ))}
                    </div>

                    {eventTotalPages > 1 && (
                      <div
                        className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-200"
                        data-testid="pagination-events"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEventPage((p) => Math.max(1, p - 1))}
                          disabled={currentEventPage <= 1}
                          data-testid="button-events-prev"
                        >
                          <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                        </Button>
                        <div
                          className="text-sm text-slate-600"
                          data-testid="text-events-page-indicator"
                        >
                          Page {currentEventPage} of {eventTotalPages}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setEventPage((p) => Math.min(eventTotalPages, p + 1))
                          }
                          disabled={currentEventPage >= eventTotalPages}
                          data-testid="button-events-next"
                        >
                          Next <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6" data-testid="card-group-resources-section">
          <CardContent className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-slate-600" />
                <h2
                  className="text-lg font-semibold text-slate-900"
                  data-testid="text-resources-heading"
                >
                  Resources ({filteredResources.length})
                </h2>
              </div>
              {isGroupAdmin && (
                <Button
                  onClick={() => {
                    setResourceForm(EMPTY_RESOURCE_FORM);
                    setResourceFile(null);
                    setResourceImageFile(null);
                    setResourceUploadProgress(0);
                    setShowResourceDialog(true);
                  }}
                  data-testid="button-new-group-resource"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create resource
                </Button>
              )}
            </div>

            {loadingResources ? (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
                {Array(3)
                  .fill(0)
                  .map((_, i) => (
                    <Card
                      key={i}
                      className="animate-pulse"
                      data-testid="skeleton-resource"
                    >
                      <div className="h-48 bg-slate-200" />
                      <CardContent className="p-6">
                        <div className="h-4 bg-slate-200 rounded mb-2" />
                        <div className="h-4 bg-slate-200 rounded w-2/3" />
                      </CardContent>
                    </Card>
                  ))}
              </div>
            ) : visibleResources.length === 0 ? (
              <div
                className="text-center py-8 text-slate-500"
                data-testid="text-no-resources"
              >
                No resources for this group yet.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 mb-4">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    <Input
                      value={resourceSearch}
                      onChange={(e) => setResourceSearch(e.target.value)}
                      placeholder="Search resources..."
                      className="pl-9"
                      data-testid="input-search-resources"
                    />
                  </div>
                  <Select
                    value={resourceSort}
                    onValueChange={setResourceSort}
                  >
                    <SelectTrigger
                      className="w-[180px]"
                      data-testid="select-resource-sort"
                    >
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="date-desc">Date (newest first)</SelectItem>
                      <SelectItem value="date-asc">Date (oldest first)</SelectItem>
                      <SelectItem value="name-asc">Name (A–Z)</SelectItem>
                      <SelectItem value="name-desc">Name (Z–A)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {filteredResources.length === 0 ? (
                  <div
                    className="text-center py-8 text-slate-500"
                    data-testid="text-no-resources-matching"
                  >
                    No resources match your search.
                  </div>
                ) : (
                  <>
                    <div
                      className="grid md:grid-cols-2 xl:grid-cols-3 gap-6"
                      data-testid="grid-group-resources"
                    >
                      {pagedResources.map((resource) => {
                        // Group admins may only edit/delete resources owned by
                        // THIS group; surfaced tenant-wide resources (linked via
                        // subcategory) are read-only here (Task #1701).
                        const isOwnGroupResource =
                          resource.member_group_id === groupId;
                        const canManage = isGroupAdmin && isOwnGroupResource;
                        return (
                          <ResourceCard
                            key={resource.id}
                            resource={resource}
                            isAuthenticated={isAuthenticated}
                            joinLocked={!canAccessGroupContent}
                            onEdit={canManage ? openEditResourceDialog : undefined}
                            onDelete={
                              canManage
                                ? (r) => setResourceToDelete(r)
                                : undefined
                            }
                          />
                        );
                      })}
                    </div>

                    {resourceTotalPages > 1 && (
                      <div
                        className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-200"
                        data-testid="pagination-resources"
                      >
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setResourcePage((p) => Math.max(1, p - 1))
                          }
                          disabled={currentResourcePage <= 1}
                          data-testid="button-resources-prev"
                        >
                          <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                        </Button>
                        <div
                          className="text-sm text-slate-600"
                          data-testid="text-resources-page-indicator"
                        >
                          Page {currentResourcePage} of {resourceTotalPages}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setResourcePage((p) =>
                              Math.min(resourceTotalPages, p + 1)
                            )
                          }
                          disabled={currentResourcePage >= resourceTotalPages}
                          data-testid="button-resources-next"
                        >
                          Next <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {groupForumCategory && (
          <Card className="mt-6" data-testid="card-group-forum-summary">
            <CardContent className="p-6">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-slate-600" />
                  <h2
                    className="text-lg font-semibold text-slate-900"
                    data-testid="text-forum-heading"
                  >
                    Group forum
                  </h2>
                </div>
                <Button
                  onClick={() =>
                    navigate(`/Forum?categoryId=${groupForumCategory.id}`)
                  }
                  data-testid="button-open-group-forum"
                >
                  Open forum
                  <ChevronRight className="w-4 h-4 ml-2" />
                </Button>
              </div>

              {groupForumCategory.header_image_url ? (
                <div
                  className="relative w-full h-56 rounded-md overflow-hidden"
                  data-testid="img-group-forum-banner"
                >
                  <img
                    src={groupForumCategory.header_image_url}
                    alt={groupForumCategory.name}
                    className="w-full h-full object-cover"
                    style={{
                      objectPosition: (() => {
                        const fp = parseFocalPoint(
                          groupForumCategory.header_image_focal_point
                        );
                        return fp ? `${fp.x}% ${fp.y}%` : "50% 50%";
                      })(),
                    }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  <div className="absolute bottom-3 left-4">
                    <h3
                      className="text-2xl font-semibold text-white drop-shadow-sm"
                      data-testid="text-group-forum-name"
                    >
                      {groupForumCategory.icon && (
                        <span className="mr-2">{groupForumCategory.icon}</span>
                      )}
                      {groupForumCategory.name}
                    </h3>
                    {groupForumCategory.description && (
                      <p
                        className="text-white/80 text-sm mt-0.5"
                        data-testid="text-group-forum-description"
                      >
                        {groupForumCategory.description}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <h3
                    className="text-2xl font-semibold text-slate-900"
                    data-testid="text-group-forum-name"
                  >
                    {groupForumCategory.icon && (
                      <span className="mr-2">{groupForumCategory.icon}</span>
                    )}
                    {groupForumCategory.name}
                  </h3>
                  {groupForumCategory.description && (
                    <p
                      className="text-slate-600"
                      data-testid="text-group-forum-description"
                    >
                      {groupForumCategory.description}
                    </p>
                  )}
                </div>
              )}

              <div className="mt-6">
                <ForumThreadList category={groupForumCategory} />
              </div>
            </CardContent>
          </Card>
        )}

        {emailGroup && (
          <Card className="mt-6" data-testid="card-group-email">
            <CardContent className="p-6">
              <GroupEmailManager group={emailGroup} heading="Email campaigns" />
            </CardContent>
          </Card>
        )}

        {/* Support tickets for group admins (Task #2416). Group admins are
            identified by their assignment (is_group_admin), not RBAC roles, so
            this stays available even when the Support nav item is RBAC-hidden.
            Mounted only for active group admins — ticket data is lazy-loaded. */}
        {isGroupAdmin && memberInfo && (
          <GroupAdminSupportSection memberInfo={memberInfo} />
        )}
      </div>

      <Dialog
        open={showResourceDialog}
        onOpenChange={(open) => {
          if (createResourceMutation.isPending || updateResourceMutation.isPending) return;
          setShowResourceDialog(open);
          if (!open) setEditingResource(null);
        }}
      >
        <DialogContent
          className="max-w-lg"
          data-testid="dialog-create-resource"
        >
          <DialogHeader>
            <DialogTitle>
              {editingResource ? "Edit resource" : "Create resource"}
            </DialogTitle>
            <DialogDescription>
              {editingResource
                ? "Update this resource. Members of this group will see your changes on this page."
                : "Add a resource for this group. Members of this group will see it on this page."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="resource-title">Title</Label>
              <Input
                id="resource-title"
                value={resourceForm.title}
                onChange={(e) =>
                  setResourceForm((f) => ({ ...f, title: e.target.value }))
                }
                placeholder="Resource title"
                data-testid="input-resource-title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="resource-description">Description</Label>
              <Textarea
                id="resource-description"
                value={resourceForm.description}
                onChange={(e) =>
                  setResourceForm((f) => ({
                    ...f,
                    description: e.target.value,
                  }))
                }
                placeholder="Short description (optional)"
                data-testid="input-resource-description"
              />
            </div>

            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={resourceForm.resource_type}
                onValueChange={(value) =>
                  setResourceForm((form) => ({
                    ...form,
                    resource_type: value,
                    target_url: value === TENANT_FORM_RESOURCE_TYPE ? "" : form.target_url,
                  }))
                }
              >
                <SelectTrigger data-testid="select-resource-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="download">File download</SelectItem>
                  <SelectItem value="external_link">External link</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                  <SelectItem value={TENANT_FORM_RESOURCE_TYPE}>Tenant form</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {resourceForm.resource_type === "download" ? (
              <div className="space-y-2">
                <Label htmlFor="resource-file">
                  File
                  {editingResource && resourceForm.target_url
                    ? " (leave empty to keep current file)"
                    : ""}
                </Label>
                <Input
                  id="resource-file"
                  type="file"
                  onChange={(e) =>
                    setResourceFile(e.target.files?.[0] || null)
                  }
                  data-testid="input-resource-file"
                />
                {resourceFile && (
                  <p className="text-xs text-slate-500" data-testid="text-resource-file-name">
                    {resourceFile.name}
                  </p>
                )}
              </div>
            ) : resourceForm.resource_type === TENANT_FORM_RESOURCE_TYPE ? (
              <div className="space-y-2">
                <Label htmlFor="group-resource-form">Tenant form</Label>
                <Select
                  value={resourceForms.find(
                    (form) => buildTenantFormResourceUrl(form.slug) === resourceForm.target_url
                  )?.id || undefined}
                  onValueChange={(formId) => {
                    const selectedForm = resourceForms.find((form) => form.id === formId);
                    if (selectedForm) {
                      setResourceForm((form) => ({
                        ...form,
                        target_url: buildTenantFormResourceUrl(selectedForm.slug),
                      }));
                    }
                  }}
                >
                  <SelectTrigger id="group-resource-form" data-testid="select-resource-tenant-form">
                    <SelectValue placeholder={resourceForms.length ? "Choose a form" : "No active forms available"} />
                  </SelectTrigger>
                  <SelectContent>
                    {resourceForms.map((form) => (
                      <SelectItem key={form.id} value={form.id}>
                        {form.name || form.title || form.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500">
                  Opens the form's normal standalone page with its existing login and prefill behavior.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="resource-url">URL</Label>
                <Input
                  id="resource-url"
                  value={resourceForm.target_url}
                  onChange={(e) =>
                    setResourceForm((f) => ({
                      ...f,
                      target_url: e.target.value,
                    }))
                  }
                  placeholder="https://..."
                  data-testid="input-resource-url"
                />
              </div>
            )}

            {(resourceForm.resource_type === "external_link"
              || resourceForm.resource_type === TENANT_FORM_RESOURCE_TYPE) && (
              <div className="flex items-center gap-2">
                <Switch
                  id="resource-open-new-tab"
                  checked={resourceForm.open_in_new_tab !== false}
                  onCheckedChange={(checked) =>
                    setResourceForm((form) => ({ ...form, open_in_new_tab: checked }))
                  }
                  data-testid="switch-resource-open-new-tab"
                />
                <Label htmlFor="resource-open-new-tab" className="text-sm text-slate-600 cursor-pointer">
                  Open in new tab
                </Label>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="resource-image">Cover image (optional)</Label>
              <Input
                id="resource-image"
                type="file"
                accept="image/*"
                onChange={(e) =>
                  setResourceImageFile(e.target.files?.[0] || null)
                }
                data-testid="input-resource-image"
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="resource-public"
                checked={resourceForm.is_public}
                onCheckedChange={(checked) =>
                  setResourceForm((f) => ({ ...f, is_public: checked }))
                }
                data-testid="switch-resource-public"
              />
              <Label
                htmlFor="resource-public"
                className="text-sm text-slate-600 cursor-pointer"
              >
                Visible to non-members (public)
              </Label>
            </div>

            {(createResourceMutation.isPending || updateResourceMutation.isPending) &&
              resourceForm.resource_type === "download" &&
              resourceUploadProgress > 0 && (
                <p
                  className="text-xs text-slate-500"
                  data-testid="text-resource-upload-progress"
                >
                  Uploading… {resourceUploadProgress}%
                </p>
              )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowResourceDialog(false);
                setEditingResource(null);
              }}
              disabled={
                createResourceMutation.isPending ||
                updateResourceMutation.isPending
              }
              data-testid="button-cancel-resource"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (editingResource) {
                  updateResourceMutation.mutate({
                    id: editingResource.id,
                    form: resourceForm,
                  });
                } else {
                  createResourceMutation.mutate(resourceForm);
                }
              }}
              disabled={
                createResourceMutation.isPending ||
                updateResourceMutation.isPending ||
                !resourceForm.title.trim()
              }
              data-testid="button-save-resource"
            >
              {createResourceMutation.isPending ||
              updateResourceMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : editingResource ? (
                "Save changes"
              ) : (
                "Create resource"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!termWarning}
        onOpenChange={(open) => {
          if (!open) setTermWarning(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-term-limit-warning">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-warning" />
              Maximum terms exceeded
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="text-term-limit-warning">
              Awarding this position would be {termWarning?.memberName}'s term{" "}
              {termWarning?.nextTermNumber} as {termWarning?.role}, which exceeds
              the maximum of {termWarning?.maxTerms}{" "}
              {termWarning?.maxTerms === 1 ? "term" : "terms"} set for this role.
              You can still proceed, but please confirm this is intended.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="button-cancel-term-limit"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const args = termWarning?.decisionArgs;
                setTermWarning(null);
                if (args) openDecisionModal(args);
              }}
              data-testid="button-confirm-term-limit"
            >
              Award anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!decisionModal}
        onOpenChange={(open) => {
          if (!open && !decisionMutation.isPending) {
            setDecisionModal(null);
            setDecisionBody("");
            setDecisionCc("");
          }
        }}
      >
        <DialogContent
          className="max-w-2xl"
          data-testid="dialog-decision-email"
        >
          <DialogHeader>
            <DialogTitle>
              {decisionModal?.decisionType === "approval"
                ? "Award position & send email"
                : "Decline & send email"}
            </DialogTitle>
            <DialogDescription>
              {decisionModal?.recipientName
                ? `Review the email to ${decisionModal.recipientName} before sending.`
                : "Review the email before sending."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="decision-email-body">Email message</Label>
              <SimpleRichTextEditor
                content={decisionBody}
                onChange={setDecisionBody}
                placeholder="Write the email message..."
                data-testid="input-decision-body"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="decision-email-cc">CC (optional)</Label>
              <Input
                id="decision-email-cc"
                type="text"
                value={decisionCc}
                onChange={(e) => setDecisionCc(e.target.value)}
                placeholder="email@example.com, another@example.com"
                data-testid="input-decision-cc"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDecisionModal(null);
                setDecisionBody("");
                setDecisionCc("");
              }}
              disabled={decisionMutation.isPending}
              data-testid="button-cancel-decision"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!decisionModal) return;
                decisionMutation.mutate({
                  ...decisionModal,
                  bodyHtml: decisionBody,
                  cc: decisionCc.trim() || null,
                });
              }}
              disabled={decisionMutation.isPending}
              data-testid="button-send-decision"
            >
              {decisionMutation.isPending
                ? "Sending..."
                : decisionModal?.decisionType === "approval"
                ? "Award & send"
                : "Decline & send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!viewEmailRecord}
        onOpenChange={(open) => {
          if (!open) setViewEmailRecord(null);
        }}
      >
        <DialogContent
          className="max-w-2xl"
          data-testid="dialog-view-sent-email"
        >
          <DialogHeader>
            <DialogTitle>Sent email</DialogTitle>
            <DialogDescription>
              {viewEmailRecord?.created_at
                ? `Sent ${new Date(viewEmailRecord.created_at).toLocaleString()}`
                : "Decision email details"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <div>
              <span className="text-slate-500">To: </span>
              <span data-testid="text-sent-email-to">
                {viewEmailRecord?.to_email || "—"}
              </span>
            </div>
            {viewEmailRecord?.cc_email && (
              <div>
                <span className="text-slate-500">CC: </span>
                <span data-testid="text-sent-email-cc">
                  {viewEmailRecord.cc_email}
                </span>
              </div>
            )}
            <div>
              <span className="text-slate-500">Subject: </span>
              <span data-testid="text-sent-email-subject">
                {viewEmailRecord?.subject || "—"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Status: </span>
              <Badge
                variant={
                  viewEmailRecord?.delivery_status === "sent"
                    ? "secondary"
                    : "outline"
                }
                data-testid="badge-sent-email-status"
              >
                {viewEmailRecord?.delivery_status || "unknown"}
              </Badge>
            </div>
            <div className="border-t border-slate-200 pt-3">
              <div
                className="prose prose-sm max-w-none"
                data-testid="content-sent-email-body"
                dangerouslySetInnerHTML={{
                  __html: viewEmailRecord?.body_html || "<p>(no content)</p>",
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setViewEmailRecord(null)}
              data-testid="button-close-sent-email"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!resourceToDelete}
        onOpenChange={(open) => {
          if (!open && !deleteResourceMutation.isPending) setResourceToDelete(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-delete-resource">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete resource</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{resourceToDelete?.title}"? This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={deleteResourceMutation.isPending}
              data-testid="button-cancel-delete-resource"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (resourceToDelete) {
                  deleteResourceMutation.mutate(resourceToDelete.id);
                }
              }}
              disabled={deleteResourceMutation.isPending}
              data-testid="button-confirm-delete-resource"
            >
              {deleteResourceMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmLeave}
        onOpenChange={(open) => {
          if (!open && !leaveMutation.isPending) setConfirmLeave(false);
        }}
      >
        <AlertDialogContent data-testid="dialog-leave-group">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave Group</AlertDialogTitle>
            <AlertDialogDescription>
              {isSoleActiveAdmin
                ? soleAdminLeaveMessage
                : group?.allow_members_to_leave === false
                  ? "Membership in this group is managed automatically. You cannot leave this group manually."
                  : `Are you sure you want to leave "${group.name}"? You can rejoin at any time while this group remains open for self-join.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {isSoleActiveAdmin && (
            <Alert variant="warning" data-testid="alert-sole-admin-leave">
              <AlertDescription>{soleAdminLeaveMessage}</AlertDescription>
            </Alert>
          )}
          {!isSoleActiveAdmin && group?.allow_members_to_leave === false && (
            <Alert variant="default" data-testid="alert-managed-membership-leave">
              <AlertDescription>
                Membership in this group is managed automatically and cannot be left manually.
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={leaveMutation.isPending}
              data-testid="button-cancel-leave"
            >
              {isSoleActiveAdmin || group?.allow_members_to_leave === false ? "Close" : "Stay in Group"}
            </AlertDialogCancel>
            {!isSoleActiveAdmin && group?.allow_members_to_leave !== false && (
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  leaveMutation.mutate();
                }}
                disabled={leaveMutation.isPending}
                data-testid="button-confirm-leave"
              >
                {leaveMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <LogOut className="w-4 h-4 mr-2" />
                )}
                Leave Group
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showTerms}
        onOpenChange={(open) => {
          if (joinMutation.isPending) return;
          setShowTerms(open);
          if (!open) setAgreedToTerms(false);
        }}
      >
        <AlertDialogContent
          className="max-w-2xl"
          data-testid="dialog-terms-of-reference"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Terms of reference</AlertDialogTitle>
            <AlertDialogDescription>
              Please read and agree to the terms of reference before joining "{group.name}".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div
            className="max-h-[55vh] overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 prose prose-sm max-w-none"
            data-testid="text-terms-of-reference"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(effectiveTermsOfReference || ""),
            }}
          />
          <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
            <Checkbox
              checked={agreedToTerms}
              onCheckedChange={(v) => setAgreedToTerms(v === true)}
              disabled={joinMutation.isPending}
              className="mt-0.5"
              data-testid="checkbox-agree-terms"
            />
            <span>I have read and agree to the terms of reference.</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={joinMutation.isPending}
              data-testid="button-cancel-terms"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                joinMutation.mutate();
              }}
              disabled={!agreedToTerms || joinMutation.isPending}
              data-testid="button-confirm-join-terms"
            >
              {joinMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              Agree and join
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showTermsView} onOpenChange={setShowTermsView}>
        <DialogContent
          className="max-w-2xl"
          data-testid="dialog-view-terms-of-reference"
        >
          <DialogHeader>
            <DialogTitle>Terms of reference</DialogTitle>
            <DialogDescription>
              Terms of reference for "{group.name}".
            </DialogDescription>
          </DialogHeader>
          <div
            className="max-h-[55vh] overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 prose prose-sm max-w-none"
            data-testid="text-view-terms-of-reference"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(effectiveTermsOfReference || ""),
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowTermsView(false)}
              data-testid="button-close-view-terms"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showPostVacancy}
        onOpenChange={(open) => {
          if (saveVacancyMutation.isPending) return;
          setShowPostVacancy(open);
          if (!open) {
            setVacancyForm(EMPTY_VACANCY_FORM);
            setEditingVacancyId(null);
          }
        }}
      >
        <DialogContent
          className="max-w-2xl max-h-[90vh] overflow-y-auto"
          data-testid="dialog-post-vacancy"
        >
          <DialogHeader>
            <DialogTitle>{editingVacancyId ? "Edit vacancy" : "Post a vacancy"}</DialogTitle>
            <DialogDescription>
              {editingVacancyId
                ? `Update this open position for "${group.name}".`
                : `Advertise an open position for "${group.name}". Members will be able to express interest.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-title">Role</Label>
              {groupRoles.length === 0 ? (
                <div
                  className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600"
                  data-testid="text-no-group-roles"
                >
                  This group has no roles configured yet. Add roles in the group's
                  settings before posting a vacancy.
                </div>
              ) : (
                <Select
                  value={vacancyForm.role_title || undefined}
                  onValueChange={(v) => {
                    const def = roleTermDefByRole[v] || null;
                    setVacancyForm((f) => ({
                      ...f,
                      role_title: v,
                      term_value: def?.term_value ?? "",
                      term_unit: def?.term_unit || "years",
                      max_terms: def?.max_terms ?? "",
                    }));
                  }}
                >
                  <SelectTrigger
                    id="vacancy-title"
                    data-testid="select-vacancy-title"
                  >
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {vacancyRoleOptions.map((role) => (
                      <SelectItem key={role} value={role}>
                        {role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-description">Role description</Label>
              <SimpleRichTextEditor
                content={vacancyForm.role_description}
                onChange={(html) =>
                  setVacancyForm((f) => ({ ...f, role_description: html }))
                }
                placeholder="Describe the responsibilities and what you're looking for."
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Time commitment</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  type="number"
                  min="0"
                  value={vacancyForm.commitment_value}
                  onChange={(e) =>
                    setVacancyForm((f) => ({ ...f, commitment_value: e.target.value }))
                  }
                  placeholder="e.g. 4"
                  className="w-28"
                  data-testid="input-vacancy-commitment-value"
                />
                <Select
                  value={vacancyForm.commitment_unit}
                  onValueChange={(v) =>
                    setVacancyForm((f) => ({ ...f, commitment_unit: v }))
                  }
                >
                  <SelectTrigger
                    className="w-[180px]"
                    data-testid="select-vacancy-commitment-unit"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hours_per_month">hours / month</SelectItem>
                    <SelectItem value="hours_per_week">hours / week</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Term of office</Label>
              <div
                className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600"
                data-testid="text-vacancy-term"
              >
                {formatTermLength({
                  term_value: vacancyForm.term_value,
                  term_unit: vacancyForm.term_unit,
                }) || "No term of office set for this role"}
                {Number(vacancyForm.max_terms) > 0 && (
                  <span data-testid="text-vacancy-max-terms">
                    {" "}
                    · max {Math.floor(Number(vacancyForm.max_terms))}{" "}
                    {Math.floor(Number(vacancyForm.max_terms)) === 1 ? "term" : "terms"}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Set from the role's configuration in group settings.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-positions">Number of positions</Label>
              <Input
                id="vacancy-positions"
                type="number"
                min="1"
                step="1"
                value={vacancyForm.positions_available}
                onChange={(e) =>
                  setVacancyForm((f) => ({ ...f, positions_available: e.target.value }))
                }
                placeholder="1"
                className="w-28"
                data-testid="input-vacancy-positions"
              />
              <p className="text-xs text-muted-foreground">
                How many people you need for this role. Defaults to 1.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-closing-date">Closing date</Label>
              <Input
                id="vacancy-closing-date"
                type="date"
                value={vacancyForm.closing_date}
                onChange={(e) =>
                  setVacancyForm((f) => ({ ...f, closing_date: e.target.value }))
                }
                className="w-48"
                data-testid="input-vacancy-closing-date"
              />
              <p className="text-xs text-muted-foreground">
                Optional. After this date the vacancy is marked closed and
                stops accepting interest.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-form">Application form</Label>
              <Select
                value={vacancyForm.application_form_id}
                onValueChange={(v) =>
                  setVacancyForm((f) => ({ ...f, application_form_id: v }))
                }
              >
                <SelectTrigger
                  id="vacancy-form"
                  data-testid="select-vacancy-form"
                >
                  <SelectValue placeholder="None (collect a short message)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    None (collect a short message)
                  </SelectItem>
                  {jobPostingForms.map((form) => (
                    <SelectItem key={form.id} value={form.id}>
                      {form.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {jobPostingForms.length === 0
                  ? "No job-posting forms yet. Enable \u201CJob posting application form\u201D on a form's settings to use it here."
                  : "When set, \u201CExpress interest\u201D opens this form. Set the form's Prefill Source to \u201Cmember\u201D so applicant details fill in automatically."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowPostVacancy(false)}
              disabled={saveVacancyMutation.isPending}
              data-testid="button-cancel-vacancy"
            >
              Cancel
            </Button>
            <Button
              onClick={() => saveVacancyMutation.mutate()}
              disabled={
                saveVacancyMutation.isPending ||
                !vacancyForm.role_title.trim() ||
                isHtmlEmpty(vacancyForm.role_description)
              }
              data-testid="button-submit-vacancy"
            >
              {saveVacancyMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              {editingVacancyId ? "Save changes" : "Post vacancy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VacancyInterestDialog interest={interest} />

      <Dialog
        open={!!applicantsVacancy}
        onOpenChange={(open) => {
          if (!open) setApplicantsVacancy(null);
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-applicants">
          <DialogHeader>
            <DialogTitle>Applicants</DialogTitle>
            <DialogDescription>
              Members who expressed interest in "{applicantsVacancy?.role_title}".
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-y-auto">
            {loadingApplicants ? (
              <div className="flex items-center justify-center py-8 text-slate-500">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading applicants...
              </div>
            ) : applicants.length === 0 ? (
              <div
                className="text-center py-8 text-slate-500"
                data-testid="text-no-applicants"
              >
                No one has expressed interest yet.
              </div>
            ) : (
              <div className="flex flex-col gap-3" data-testid="list-applicants">
                {(() => {
                  const vacancyAwards = getAwardsForVacancy(applicantsVacancy?.id);
                  const awardedMemberIds = new Set(
                    vacancyAwards.map((a) => a.awarded_member_id).filter(Boolean)
                  );
                  const vacancyDeclines = getDeclinesForVacancy(applicantsVacancy?.id);
                  const declinedSourceIds = new Set(
                    vacancyDeclines.map((d) => d.source_id).filter(Boolean)
                  );
                  const remaining = getRemainingPositions(applicantsVacancy);
                  return applicants.map((app) => {
                    const member = app.__member;
                    const display = member ? getMemberDisplay(member) : null;
                    const name = display ? display.displayName : "Unknown member";
                    const isAwarded =
                      app.member_id && awardedMemberIds.has(app.member_id);
                    const isDeclined = declinedSourceIds.has(app.id);
                    const sentEmail = decisionEmailBySource.get(app.id) || null;
                    return (
                      <div
                        key={app.id}
                        className="rounded-md border border-slate-200 p-3"
                        data-testid={`card-applicant-${app.id}`}
                      >
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar className="h-9 w-9">
                              {display?.showAvatarImage && member?.profile_image_url ? (
                                <AvatarImage src={member.profile_image_url} alt={name} />
                              ) : null}
                              <AvatarFallback>{getInitials(name)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div
                                className="text-sm font-medium text-slate-900 truncate"
                                data-testid={`text-applicant-name-${app.id}`}
                              >
                                {name}
                              </div>
                              {member?.email && !display?.anonymised && (
                                <div className="text-xs text-slate-500 truncate">
                                  {member.email}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            {isAwarded ? (
                              <Badge
                                variant="secondary"
                                data-testid={`badge-applicant-awarded-${app.id}`}
                              >
                                <Check className="w-3.5 h-3.5 mr-1" />
                                Awarded
                              </Badge>
                            ) : isDeclined ? (
                              <Badge
                                variant="outline"
                                data-testid={`badge-applicant-declined-${app.id}`}
                              >
                                <X className="w-3.5 h-3.5 mr-1" />
                                Declined
                              </Badge>
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    !app.member_id ||
                                    remaining <= 0 ||
                                    decisionMutation.isPending
                                  }
                                  onClick={() =>
                                    requestDecision({
                                      decisionType: "approval",
                                      vacancy: applicantsVacancy,
                                      memberId: app.member_id,
                                      sourceType: "application",
                                      sourceId: app.id,
                                      firstName: member?.first_name || "",
                                      recipientName: name,
                                    })
                                  }
                                  data-testid={`button-award-applicant-${app.id}`}
                                >
                                  <Award className="w-4 h-4 mr-2" />
                                  Award position
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={decisionMutation.isPending}
                                  onClick={() =>
                                    requestDecision({
                                      decisionType: "decline",
                                      vacancy: applicantsVacancy,
                                      memberId: app.member_id,
                                      sourceType: "application",
                                      sourceId: app.id,
                                      firstName: member?.first_name || "",
                                      recipientName: name,
                                    })
                                  }
                                  data-testid={`button-decline-applicant-${app.id}`}
                                >
                                  <X className="w-4 h-4 mr-2" />
                                  Decline
                                </Button>
                              </>
                            )}
                            {sentEmail && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewEmailRecord(sentEmail)}
                                data-testid={`button-view-email-applicant-${app.id}`}
                              >
                                <Mail className="w-4 h-4 mr-2" />
                                View sent email
                              </Button>
                            )}
                            {isGroupAdmin && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={downloadingPdfId === app.id}
                                onClick={() =>
                                  handleDownloadApplicationPdf("application", app.id)
                                }
                                data-testid={`button-download-pdf-applicant-${app.id}`}
                              >
                                {downloadingPdfId === app.id ? (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4 mr-2" />
                                )}
                                Download PDF
                              </Button>
                            )}
                          </div>
                        </div>
                        {app.message && (
                          <p
                            className="text-sm text-slate-700 whitespace-pre-wrap mt-2"
                            data-testid={`text-applicant-message-${app.id}`}
                          >
                            {app.message}
                          </p>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setApplicantsVacancy(null)}
              data-testid="button-close-applicants"
            >
              <X className="w-4 h-4 mr-2" />
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!submissionsVacancy}
        onOpenChange={(open) => {
          if (!open) {
            setSubmissionsVacancy(null);
            setExpandedSubmissionId(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl" data-testid="dialog-submissions">
          <DialogHeader>
            <DialogTitle>Applications</DialogTitle>
            <DialogDescription>
              Form submissions for "{submissionsVacancy?.role_title}".
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {(() => {
              const subs = submissionsVacancy
                ? submissionsByVacancy[submissionsVacancy.id] || []
                : [];
              if (loadingJobPostingForms || loadingVacancySubmissions) {
                return (
                  <div className="flex items-center justify-center py-8 text-slate-500">
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Loading applications…
                  </div>
                );
              }
              if (subs.length === 0) {
                return (
                  <div
                    className="text-center py-8 text-slate-500"
                    data-testid="text-no-submissions"
                  >
                    No applications have been submitted yet.
                  </div>
                );
              }
              const vacancyAwards = getAwardsForVacancy(submissionsVacancy?.id);
              const awardedSourceIds = new Set(
                vacancyAwards.map((a) => a.source_id).filter(Boolean)
              );
              const vacancyDeclines = getDeclinesForVacancy(submissionsVacancy?.id);
              const declinedSourceIds = new Set(
                vacancyDeclines.map((d) => d.source_id).filter(Boolean)
              );
              const submissionsRemaining = getRemainingPositions(submissionsVacancy);
              return (
                <div className="flex flex-col gap-3" data-testid="list-submissions">
                  {subs.map((sub) => {
                    const expanded = expandedSubmissionId === sub.id;
                    const who =
                      sub.submitted_by_name ||
                      sub.submitted_by_email ||
                      "Anonymous submission";
                    const when = sub.created_date
                      ? new Date(sub.created_date).toLocaleString()
                      : "";
                    const data = sub.submission_data || {};
                    const entries = Object.entries(data).filter(([key, value]) => {
                      if (value === "" || value == null) return false;
                      const field = resolveSubmissionField(submissionsForm?.fields, key);
                      // A current ID-keyed answer takes precedence over a
                      // duplicated legacy field-name value.
                      return !(
                        field?.id
                        && key === field.name
                        && Object.prototype.hasOwnProperty.call(data, field.id)
                      );
                    });
                    const isAwarded = awardedSourceIds.has(sub.id);
                    const isDeclined = declinedSourceIds.has(sub.id);
                    const sentEmail = decisionEmailBySource.get(sub.id) || null;
                    const subFirstName = (sub.submitted_by_name || "").trim().split(/\s+/)[0] || "";
                    return (
                      <div
                        key={sub.id}
                        className="rounded-md border border-slate-200"
                        data-testid={`card-submission-${sub.id}`}
                      >
                        <div className="flex items-center gap-2 p-3">
                          <button
                            type="button"
                            className="flex-1 flex items-center justify-between gap-3 text-left min-w-0"
                            onClick={() =>
                              setExpandedSubmissionId(expanded ? null : sub.id)
                            }
                            data-testid={`button-toggle-submission-${sub.id}`}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-slate-900 truncate">
                                {who}
                              </div>
                              {when && (
                                <div className="text-xs text-slate-500 truncate">
                                  {when}
                                </div>
                              )}
                            </div>
                            <ChevronDown
                              className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${
                                expanded ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                          <div className="flex items-center gap-2 flex-wrap shrink-0">
                            {isAwarded ? (
                              <Badge
                                variant="secondary"
                                data-testid={`badge-submission-awarded-${sub.id}`}
                              >
                                <Check className="w-3.5 h-3.5 mr-1" />
                                Awarded
                              </Badge>
                            ) : isDeclined ? (
                              <Badge
                                variant="outline"
                                data-testid={`badge-submission-declined-${sub.id}`}
                              >
                                <X className="w-3.5 h-3.5 mr-1" />
                                Declined
                              </Badge>
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={
                                    !sub.submitted_by_email ||
                                    submissionsRemaining <= 0 ||
                                    decisionMutation.isPending
                                  }
                                  onClick={() =>
                                    requestDecision({
                                      decisionType: "approval",
                                      vacancy: submissionsVacancy,
                                      email: sub.submitted_by_email,
                                      sourceType: "submission",
                                      sourceId: sub.id,
                                      firstName: subFirstName,
                                      recipientName: who,
                                    })
                                  }
                                  data-testid={`button-award-submission-${sub.id}`}
                                >
                                  <Award className="w-4 h-4 mr-2" />
                                  Award position
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={
                                    !sub.submitted_by_email ||
                                    decisionMutation.isPending
                                  }
                                  onClick={() =>
                                    requestDecision({
                                      decisionType: "decline",
                                      vacancy: submissionsVacancy,
                                      email: sub.submitted_by_email,
                                      sourceType: "submission",
                                      sourceId: sub.id,
                                      firstName: subFirstName,
                                      recipientName: who,
                                    })
                                  }
                                  data-testid={`button-decline-submission-${sub.id}`}
                                >
                                  <X className="w-4 h-4 mr-2" />
                                  Decline
                                </Button>
                              </>
                            )}
                            {sentEmail && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewEmailRecord(sentEmail)}
                                data-testid={`button-view-email-submission-${sub.id}`}
                              >
                                <Mail className="w-4 h-4 mr-2" />
                                View sent email
                              </Button>
                            )}
                            {isGroupAdmin && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={downloadingPdfId === sub.id}
                                onClick={() =>
                                  handleDownloadApplicationPdf("submission", sub.id)
                                }
                                data-testid={`button-download-pdf-submission-${sub.id}`}
                              >
                                {downloadingPdfId === sub.id ? (
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                ) : (
                                  <Download className="w-4 h-4 mr-2" />
                                )}
                                Download PDF
                              </Button>
                            )}
                          </div>
                        </div>
                        {expanded && (
                          <div
                            className="border-t border-slate-200 p-3 flex flex-col gap-2"
                            data-testid={`detail-submission-${sub.id}`}
                          >
                            {entries.length === 0 ? (
                              <p className="text-sm text-slate-500">
                                No answers recorded.
                              </p>
                            ) : (
                              entries.map(([fieldId, value]) => {
                                const field = resolveSubmissionField(
                                  submissionsForm?.fields,
                                  fieldId
                                );
                                const savedValue = field
                                  ? getSubmissionFieldValue(data, field)
                                  : value;
                                const groupedContent =
                                  field?.type === "grouped_question"
                                    ? renderGroupedQuestionAnswer(field, savedValue)
                                    : null;
                                const displayValue =
                                  field?.type === "relationship_dropdown"
                                    ? formatRelationshipDisplayValue(
                                        savedValue,
                                        relationshipLabelsByRecordId
                                      )
                                    : renderAnswerValue(savedValue);
                                return (
                                  <div key={fieldId} className="flex flex-col">
                                    <span className="text-xs font-medium text-slate-500">
                                      {field?.label || fieldId}
                                    </span>
                                    {groupedContent ? (
                                      <div className="mt-1 pl-3 border-l-2 border-slate-200">
                                        {groupedContent}
                                      </div>
                                    ) : (
                                      <span className="text-sm text-slate-800 whitespace-pre-wrap">
                                        {field?.type === "relationship_dropdown"
                                          && relationshipLabelsLoading
                                          ? "Loading related record…"
                                          : displayValue}
                                      </span>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSubmissionsVacancy(null);
                setExpandedSubmissionId(null);
              }}
              data-testid="button-close-submissions"
            >
              <X className="w-4 h-4 mr-2" />
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!removeVacancyTarget}
        onOpenChange={(open) => {
          if (!open && !removeVacancyMutation.isPending) setRemoveVacancyTarget(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-remove-vacancy">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove vacancy</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove "{removeVacancyTarget?.role_title}"? This
              will also remove any expressions of interest and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={removeVacancyMutation.isPending}
              data-testid="button-cancel-remove-vacancy"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (removeVacancyTarget) removeVacancyMutation.mutate(removeVacancyTarget);
              }}
              disabled={removeVacancyMutation.isPending}
              data-testid="button-confirm-remove-vacancy"
            >
              {removeVacancyMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MemberProfileModal
        memberId={selectedMemberId}
        open={!!selectedMemberId}
        onOpenChange={(open) => {
          if (!open) setSelectedMemberId(null);
        }}
      />

      <EditTermDialog
        target={editTermTarget}
        open={!!editTermTarget}
        onOpenChange={(open) => {
          if (!open && !editTermMutation.isPending) setEditTermTarget(null);
        }}
        isSaving={editTermMutation.isPending}
        onSave={(values) => {
          const assignmentId = editTermTarget?.__assignment?.id;
          if (!assignmentId) {
            toast.error("This member has no group assignment to edit.");
            return;
          }
          editTermMutation.mutate({ assignmentId, values });
        }}
      />

      {/* Group-admin cosmetic content editing (header image + description texts). */}
      <Dialog
        open={showContentEdit}
        onOpenChange={(open) => {
          if (!saveContentMutation.isPending) setShowContentEdit(open);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-edit-group-content">
          <DialogHeader>
            <DialogTitle>Edit header & descriptions</DialogTitle>
            <DialogDescription>
              Update this group's header image and description texts. The group
              name can only be changed by an administrator.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <EventImageUpload
              value={contentForm.header_image_url}
              onChange={(url) => setContentForm((prev) => ({ ...prev, header_image_url: url }))}
              label="Header Image"
              helpText="Shown at the top of the group page"
            />
            <div>
              <Label>Purpose</Label>
              <SimpleRichTextEditor
                content={contentForm.description}
                onChange={(html) => setContentForm((prev) => ({ ...prev, description: html }))}
                placeholder="What is the purpose of this group?"
                data-testid="input-edit-group-description"
              />
            </div>
            <div>
              <Label>Who the group is for</Label>
              <SimpleRichTextEditor
                content={contentForm.who_is_it_for}
                onChange={(html) => setContentForm((prev) => ({ ...prev, who_is_it_for: html }))}
                placeholder="Who is this group aimed at? (optional)"
                data-testid="input-edit-group-who-is-it-for"
              />
            </div>
            <div>
              <Label>About the group</Label>
              <SimpleRichTextEditor
                content={contentForm.about_the_group}
                onChange={(html) => setContentForm((prev) => ({ ...prev, about_the_group: html }))}
                placeholder="Tell members more about this group... (optional)"
                data-testid="input-edit-group-about"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowContentEdit(false)}
              disabled={saveContentMutation.isPending}
              data-testid="button-cancel-edit-group-content"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveContent}
              disabled={saveContentMutation.isPending}
              data-testid="button-save-edit-group-content"
            >
              {saveContentMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
