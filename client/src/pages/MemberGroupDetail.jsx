import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
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
import {
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
  Repeat,
  Eye,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { filterGroupEventVisibility } from "@/hooks/useEventsData";
import { useEventTypes } from "@/hooks/useEventTypes";
import { parseEventTypes } from "@/lib/utils";
import EventCard from "@/components/events/EventCard";
import { createPageUrl } from "@/utils";
import MemberProfileModal from "@/components/MemberProfileModal";
import DOMPurify from "dompurify";

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MEMBERS_PER_PAGE = 24;
const EVENTS_PER_PAGE = 9;

const COMMITMENT_UNIT_LABELS = {
  hours_per_month: "hours / month",
  hours_per_week: "hours / week",
};
const TERM_UNIT_LABELS = {
  months: "months",
  years: "years",
};

function formatCommitment(vacancy) {
  if (vacancy.commitment_value == null || vacancy.commitment_value === "") return null;
  const unit = COMMITMENT_UNIT_LABELS[vacancy.commitment_unit] || vacancy.commitment_unit || "";
  return `${vacancy.commitment_value} ${unit}`.trim();
}

function formatTerm(vacancy) {
  if (vacancy.term_value == null || vacancy.term_value === "") return null;
  const unit = TERM_UNIT_LABELS[vacancy.term_unit] || vacancy.term_unit || "";
  return `${vacancy.term_value} ${unit}`.trim();
}

function formatMaxTerms(vacancy) {
  if (vacancy.max_terms == null || vacancy.max_terms === "") return null;
  const n = Number(vacancy.max_terms);
  return `Max ${vacancy.max_terms} ${n === 1 ? "term" : "terms"}`;
}

const EMPTY_VACANCY_FORM = {
  role_title: "",
  role_description: "",
  commitment_value: "",
  commitment_unit: "hours_per_month",
  term_value: "",
  term_unit: "years",
  max_terms: "",
};

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

export default function MemberGroupDetailPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showPostVacancy, setShowPostVacancy] = useState(false);
  const [vacancyForm, setVacancyForm] = useState(EMPTY_VACANCY_FORM);
  const [interestVacancy, setInterestVacancy] = useState(null);
  const [interestMessage, setInterestMessage] = useState("");
  const [removeVacancyTarget, setRemoveVacancyTarget] = useState(null);
  const [applicantsVacancy, setApplicantsVacancy] = useState(null);
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

  const { data: myAssignments = [] } = useQuery({
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

  const isGroupAdmin = useMemo(() => {
    const nowIso = new Date().toISOString();
    return myAssignments.some((a) => {
      if (a.group_id !== groupId) return false;
      if (a.is_group_admin !== true) return false;
      if (!a.expires_at) return true;
      return new Date(a.expires_at).toISOString() > nowIso;
    });
  }, [myAssignments, groupId]);

  const hasTermsOfReference = useMemo(() => {
    const raw = group?.terms_of_reference;
    if (!raw) return false;
    const text = raw
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;|\u00A0/g, " ")
      .trim();
    return text.length > 0;
  }, [group?.terms_of_reference]);

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

  const visibleVacancies = useMemo(() => {
    const list = isGroupAdmin
      ? vacancies
      : vacancies.filter((v) => v.status !== "closed");
    return [...list].sort((a, b) => {
      const at = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bt - at;
    });
  }, [vacancies, isGroupAdmin]);

  const createVacancyMutation = useMutation({
    mutationFn: async () => {
      const title = vacancyForm.role_title.trim();
      const description = vacancyForm.role_description.trim();
      if (!title) throw new Error("Role title is required");
      if (!description) throw new Error("Role description is required");
      const toNum = (v) =>
        v === "" || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
      return base44.entities.Vacancy.create({
        member_group_id: groupId,
        posted_by_member_id: memberInfo?.id || null,
        role_title: title,
        role_description: description,
        commitment_value: toNum(vacancyForm.commitment_value),
        commitment_unit: vacancyForm.commitment_unit,
        term_value: toNum(vacancyForm.term_value),
        term_unit: vacancyForm.term_unit,
        max_terms: toNum(vacancyForm.max_terms),
        status: "open",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group-vacancies", groupId] });
      setShowPostVacancy(false);
      setVacancyForm(EMPTY_VACANCY_FORM);
      toast.success("Vacancy posted");
    },
    onError: (error) => {
      toast.error("Failed to post vacancy: " + (error?.message || "Unknown error"));
    },
  });

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

  const expressInterestMutation = useMutation({
    mutationFn: async () => {
      if (!memberInfo?.id) throw new Error("You must be signed in to express interest");
      if (!interestVacancy?.id) throw new Error("No vacancy selected");
      return base44.entities.VacancyApplication.create({
        vacancy_id: interestVacancy.id,
        message: interestMessage.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["my-vacancy-applications", memberInfo?.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["vacancy-applicants", interestVacancy?.id],
      });
      setInterestVacancy(null);
      setInterestMessage("");
      toast.success("Interest registered. The group admins will be in touch.");
    },
    onError: (error) => {
      toast.error(
        "Failed to express interest: " + (error?.message || "Unknown error")
      );
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

  const [memberSearch, setMemberSearch] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [selectedMemberId, setSelectedMemberId] = useState(null);

  const memberRoleByMemberId = useMemo(() => {
    const map = new Map();
    for (const a of groupAssignments) {
      if (a.member_id && a.group_role) map.set(a.member_id, a.group_role);
    }
    return map;
  }, [groupAssignments]);

  const sortedMembers = useMemo(() => {
    return members
      .map((m) => ({ ...m, __display: getMemberDisplay(m) }))
      .sort((a, b) => a.__display.displayName.localeCompare(b.__display.displayName));
  }, [members]);

  const leadershipRoleSet = useMemo(
    () => new Set(Array.isArray(group?.leadership_roles) ? group.leadership_roles : []),
    [group]
  );

  const leadershipMembers = useMemo(() => {
    if (leadershipRoleSet.size === 0) return [];
    return sortedMembers
      .map((m) => ({ ...m, __role: memberRoleByMemberId.get(m.id) || null }))
      .filter((m) => m.__role && leadershipRoleSet.has(m.__role));
  }, [sortedMembers, memberRoleByMemberId, leadershipRoleSet]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return sortedMembers;
    return sortedMembers.filter((m) =>
      m.__display.displayName.toLowerCase().includes(q)
    );
  }, [sortedMembers, memberSearch]);

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
  const { eventTypes } = useEventTypes();

  const { data: systemSettings = [] } = useQuery({
    queryKey: ["public-system-settings"],
    queryFn: () => publicClient.listSystemSettings(),
  });

  const { data: groupEventsRaw = [], isLoading: loadingEvents } = useQuery({
    queryKey: ["member-group-events", groupId],
    queryFn: () => base44.entities.Event.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const [eventSearch, setEventSearch] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [deliveryModeFilter, setDeliveryModeFilter] = useState("all");
  const [showPastEvents, setShowPastEvents] = useState(false);
  const [eventPage, setEventPage] = useState(1);

  // Apply group-event audience rules: public group events for everyone,
  // group-only events only for admins or members of THIS group. Dormant
  // bespoke RSVP events are hidden by the shared helper.
  const accessibleGroupEvents = useMemo(() => {
    const visible = filterGroupEventVisibility(groupEventsRaw, {
      isAdmin: isEventAdmin,
      myGroupIds: isJoined ? [groupId] : [],
    });
    return visible.filter((event) => {
      const isDraft =
        event.event_state === "draft" ||
        (!event.event_state && event.status === "draft");
      // Drafts are hidden from non-admins.
      return isDraft ? isEventAdmin : true;
    });
  }, [groupEventsRaw, isEventAdmin, isJoined, groupId]);

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
        const aTbc = a.status === "tbc" || !a.start_date;
        const bTbc = b.status === "tbc" || !b.start_date;
        if (aTbc && !bTbc) return 1;
        if (!aTbc && bTbc) return -1;
        if (aTbc && bTbc) return (a.title || "").localeCompare(b.title || "");
        return new Date(a.start_date).getTime() - new Date(b.start_date).getTime();
      });
  }, [
    accessibleGroupEvents,
    eventSearch,
    eventTypeFilter,
    deliveryModeFilter,
    showPastEvents,
  ]);

  const pastEventsCount = useMemo(
    () => accessibleGroupEvents.filter((e) => isEventInPast(e)).length,
    [accessibleGroupEvents]
  );

  useEffect(() => {
    setEventPage(1);
  }, [eventSearch, eventTypeFilter, deliveryModeFilter, showPastEvents, groupId]);

  const eventTotalPages = Math.max(
    1,
    Math.ceil(filteredGroupEvents.length / EVENTS_PER_PAGE)
  );
  const currentEventPage = Math.min(eventPage, eventTotalPages);
  const pagedEvents = useMemo(() => {
    const start = (currentEventPage - 1) * EVENTS_PER_PAGE;
    return filteredGroupEvents.slice(start, start + EVENTS_PER_PAGE);
  }, [filteredGroupEvents, currentEventPage]);

  const isLoading =
    !accessChecked || loadingGroup || loadingAssignments || loadingMembers;

  if (!groupId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              Group not specified
            </h3>
            <p className="text-slate-600 mb-4">No group id was provided.</p>
            <Link to={createPageUrl("MemberGroups")}>
              <Button variant="outline" data-testid="link-back-groups">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to Member Groups
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-600">Loading group...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const groupUnavailable =
    !group || groupError || !group.allow_self_join || group.is_active === false;

  if (groupUnavailable) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
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
                <ArrowLeft className="w-4 h-4 mr-2" /> Back to Member Groups
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-4">
          <Link to={createPageUrl("MemberGroups")}>
            <Button variant="ghost" size="sm" data-testid="link-back-groups">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Member Groups
            </Button>
          </Link>
        </div>

        <Card className="overflow-hidden mb-6" data-testid={`card-group-detail-${group.id}`}>
          <div className="relative w-full h-56 md:h-64 bg-slate-100">
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
              <p
                className="text-slate-700 whitespace-pre-wrap mb-4"
                data-testid="text-group-description"
              >
                {group.description}
              </p>
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
            {group.default_self_join_role && !isJoined && (
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
                  <Button
                    variant="outline"
                    onClick={() => setConfirmLeave(true)}
                    data-testid="button-leave-group"
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    Leave Group
                  </Button>
                </>
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
            </div>
          </CardContent>
        </Card>

        {leadershipMembers.length > 0 && (
          <Card className="mb-6" data-testid="card-leadership-section">
            <CardContent className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <Crown className="w-5 h-5 text-amber-600 fill-current" />
                <h2
                  className="text-lg font-semibold text-slate-900"
                  data-testid="text-leadership-heading"
                >
                  Leadership ({leadershipMembers.length})
                </h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {leadershipMembers.map((m) => {
                  const { displayName, showAvatarImage, anonymised } = m.__display;
                  const interactive = !anonymised;
                  const handleOpen = () => {
                    if (interactive) setSelectedMemberId(m.id);
                  };
                  return (
                    <Card
                      key={`leader-${m.id}`}
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
                      data-testid={`card-leader-${m.id}`}
                    >
                      <CardContent className="p-3 flex items-center gap-3">
                        <Avatar className="h-10 w-10 flex-shrink-0">
                          {showAvatarImage && m.profile_photo_url ? (
                            <AvatarImage src={m.profile_photo_url} alt={displayName} />
                          ) : null}
                          <AvatarFallback className="bg-amber-100 text-amber-800">
                            {getInitials(displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div
                            className="font-medium text-sm text-slate-900 truncate"
                            data-testid={`text-leader-name-${m.id}`}
                            title={displayName}
                          >
                            {displayName}
                          </div>
                          <div
                            className="text-xs text-amber-700 truncate flex items-center gap-1"
                            data-testid={`text-leader-role-${m.id}`}
                            title={m.__role}
                          >
                            <Crown className="w-3 h-3 fill-current flex-shrink-0" />
                            {m.__role}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </CardContent>
          </Card>
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
                                <AvatarFallback className="bg-blue-100 text-blue-700">
                                  {getInitials(displayName)}
                                </AvatarFallback>
                              </Avatar>
                              <div
                                className="font-medium text-sm text-slate-900 truncate"
                                data-testid={`text-member-name-${m.id}`}
                                title={displayName}
                              >
                                {displayName}
                              </div>
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
                  const commitment = formatCommitment(vacancy);
                  const term = formatTerm(vacancy);
                  const maxTerms = formatMaxTerms(vacancy);
                  const isClosed = vacancy.status === "closed";
                  const alreadyApplied = appliedVacancyIds.has(vacancy.id);
                  return (
                    <div
                      key={vacancy.id}
                      className="rounded-md border border-slate-200 p-4"
                      data-testid={`card-vacancy-${vacancy.id}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3
                            className="text-base font-semibold text-slate-900"
                            data-testid={`text-vacancy-title-${vacancy.id}`}
                          >
                            {vacancy.role_title}
                          </h3>
                          {isClosed && (
                            <Badge variant="secondary" data-testid={`badge-vacancy-closed-${vacancy.id}`}>
                              Closed
                            </Badge>
                          )}
                        </div>
                        {isGroupAdmin && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setApplicantsVacancy(vacancy)}
                              data-testid={`button-view-applicants-${vacancy.id}`}
                            >
                              <Eye className="w-4 h-4 mr-2" />
                              Applicants
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
                          </div>
                        )}
                      </div>

                      <p
                        className="text-sm text-slate-700 whitespace-pre-wrap mt-2"
                        data-testid={`text-vacancy-description-${vacancy.id}`}
                      >
                        {vacancy.role_description}
                      </p>

                      {(commitment || term || maxTerms) && (
                        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-sm text-slate-600">
                          {commitment && (
                            <span className="inline-flex items-center gap-1.5" data-testid={`text-vacancy-commitment-${vacancy.id}`}>
                              <Clock className="w-4 h-4 text-slate-400" />
                              {commitment}
                            </span>
                          )}
                          {term && (
                            <span className="inline-flex items-center gap-1.5" data-testid={`text-vacancy-term-${vacancy.id}`}>
                              <CalendarClock className="w-4 h-4 text-slate-400" />
                              {term}
                            </span>
                          )}
                          {maxTerms && (
                            <span className="inline-flex items-center gap-1.5" data-testid={`text-vacancy-maxterms-${vacancy.id}`}>
                              <Repeat className="w-4 h-4 text-slate-400" />
                              {maxTerms}
                            </span>
                          )}
                        </div>
                      )}

                      {!isClosed && (
                        <div className="mt-4">
                          {alreadyApplied ? (
                            <div
                              className="inline-flex items-center text-sm text-green-700"
                              data-testid={`text-vacancy-applied-${vacancy.id}`}
                            >
                              <Check className="w-4 h-4 mr-2" />
                              You've expressed interest
                            </div>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setInterestVacancy(vacancy);
                                setInterestMessage("");
                              }}
                              disabled={!memberInfo?.id}
                              data-testid={`button-express-interest-${vacancy.id}`}
                            >
                              <Send className="w-4 h-4 mr-2" />
                              Express interest
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6" data-testid="card-group-events-section">
          <CardContent className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="w-5 h-5 text-slate-600" />
              <h2
                className="text-lg font-semibold text-slate-900"
                data-testid="text-events-heading"
              >
                Events ({filteredGroupEvents.length})
              </h2>
            </div>

            {loadingEvents ? (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
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
                      className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6"
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
      </div>

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
              Are you sure you want to leave "{group.name}"? You can rejoin at any
              time while this group remains open for self-join.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={leaveMutation.isPending}
              data-testid="button-cancel-leave"
            >
              Stay in Group
            </AlertDialogCancel>
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
              __html: DOMPurify.sanitize(group.terms_of_reference || ""),
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

      <Dialog
        open={showPostVacancy}
        onOpenChange={(open) => {
          if (createVacancyMutation.isPending) return;
          setShowPostVacancy(open);
          if (!open) setVacancyForm(EMPTY_VACANCY_FORM);
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-post-vacancy">
          <DialogHeader>
            <DialogTitle>Post a vacancy</DialogTitle>
            <DialogDescription>
              Advertise an open position for "{group.name}". Members will be able to
              express interest.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-title">Role title</Label>
              <Input
                id="vacancy-title"
                value={vacancyForm.role_title}
                onChange={(e) =>
                  setVacancyForm((f) => ({ ...f, role_title: e.target.value }))
                }
                placeholder="e.g. Treasurer"
                data-testid="input-vacancy-title"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-description">Role description</Label>
              <Textarea
                id="vacancy-description"
                value={vacancyForm.role_description}
                onChange={(e) =>
                  setVacancyForm((f) => ({ ...f, role_description: e.target.value }))
                }
                rows={4}
                placeholder="Describe the responsibilities and what you're looking for."
                data-testid="input-vacancy-description"
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
              <div className="flex flex-wrap gap-2">
                <Input
                  type="number"
                  min="0"
                  value={vacancyForm.term_value}
                  onChange={(e) =>
                    setVacancyForm((f) => ({ ...f, term_value: e.target.value }))
                  }
                  placeholder="e.g. 3"
                  className="w-28"
                  data-testid="input-vacancy-term-value"
                />
                <Select
                  value={vacancyForm.term_unit}
                  onValueChange={(v) =>
                    setVacancyForm((f) => ({ ...f, term_unit: v }))
                  }
                >
                  <SelectTrigger
                    className="w-[180px]"
                    data-testid="select-vacancy-term-unit"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="months">months</SelectItem>
                    <SelectItem value="years">years</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vacancy-max-terms">Maximum terms</Label>
              <Input
                id="vacancy-max-terms"
                type="number"
                min="0"
                value={vacancyForm.max_terms}
                onChange={(e) =>
                  setVacancyForm((f) => ({ ...f, max_terms: e.target.value }))
                }
                placeholder="e.g. 2"
                className="w-28"
                data-testid="input-vacancy-max-terms"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowPostVacancy(false)}
              disabled={createVacancyMutation.isPending}
              data-testid="button-cancel-vacancy"
            >
              Cancel
            </Button>
            <Button
              onClick={() => createVacancyMutation.mutate()}
              disabled={
                createVacancyMutation.isPending ||
                !vacancyForm.role_title.trim() ||
                !vacancyForm.role_description.trim()
              }
              data-testid="button-submit-vacancy"
            >
              {createVacancyMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              Post vacancy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!interestVacancy}
        onOpenChange={(open) => {
          if (expressInterestMutation.isPending) return;
          if (!open) {
            setInterestVacancy(null);
            setInterestMessage("");
          }
        }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-express-interest">
          <DialogHeader>
            <DialogTitle>Express interest</DialogTitle>
            <DialogDescription>
              Let the group admins know you're interested in "{interestVacancy?.role_title}".
              You can add an optional message.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="interest-message">Message (optional)</Label>
            <Textarea
              id="interest-message"
              value={interestMessage}
              onChange={(e) => setInterestMessage(e.target.value)}
              rows={4}
              placeholder="Tell them a bit about why you're interested."
              data-testid="input-interest-message"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setInterestVacancy(null);
                setInterestMessage("");
              }}
              disabled={expressInterestMutation.isPending}
              data-testid="button-cancel-interest"
            >
              Cancel
            </Button>
            <Button
              onClick={() => expressInterestMutation.mutate()}
              disabled={expressInterestMutation.isPending}
              data-testid="button-submit-interest"
            >
              {expressInterestMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              Express interest
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                {applicants.map((app) => {
                  const member = app.__member;
                  const display = member ? getMemberDisplay(member) : null;
                  const name = display ? display.displayName : "Unknown member";
                  return (
                    <div
                      key={app.id}
                      className="rounded-md border border-slate-200 p-3"
                      data-testid={`card-applicant-${app.id}`}
                    >
                      <div className="flex items-center gap-3">
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
                })}
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
    </div>
  );
}
