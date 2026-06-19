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
  Send,
  Mail,
  Trash2,
  X,
  Pencil,
  FileText,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { filterGroupEventVisibility } from "@/hooks/useEventsData";
import { useEventTypes } from "@/hooks/useEventTypes";
import { parseEventTypes } from "@/lib/utils";
import EventCard from "@/components/events/EventCard";
import ResourceCard from "@/components/resources/ResourceCard";
import { uploadFileWithProgress, UPLOAD_TYPES } from "@/lib/tenantUpload";
import { createPageUrl } from "@/utils";
import MemberProfileModal from "@/components/MemberProfileModal";
import DOMPurify from "dompurify";
import VacancyCard, {
  formatCommitment,
  formatTerm,
  formatMaxTerms,
  getPositionsAvailable,
} from "@/components/vacancies/VacancyCard";
import {
  useVacancyInterest,
  VacancyInterestDialog,
} from "@/components/vacancies/useVacancyInterest";

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MEMBERS_PER_PAGE = 24;
const EVENTS_PER_PAGE = 9;
const RESOURCES_PER_PAGE = 9;

const EMPTY_RESOURCE_FORM = {
  title: "",
  description: "",
  resource_type: "download",
  target_url: "",
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
};

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
  const [showTermsView, setShowTermsView] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showPostVacancy, setShowPostVacancy] = useState(false);
  const [vacancyForm, setVacancyForm] = useState(EMPTY_VACANCY_FORM);
  const [removeVacancyTarget, setRemoveVacancyTarget] = useState(null);
  const [applicantsVacancy, setApplicantsVacancy] = useState(null);
  const [editingVacancyId, setEditingVacancyId] = useState(null);
  const [submissionsVacancy, setSubmissionsVacancy] = useState(null);
  const [expandedSubmissionId, setExpandedSubmissionId] = useState(null);
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

  const getAwardsForVacancy = (vacancyId) => awardsByVacancy.get(vacancyId) || [];
  const getRemainingPositions = (vacancy) =>
    Math.max(0, getPositionsAvailable(vacancy) - getAwardsForVacancy(vacancy.id).length);

  // Job-posting forms (admin only) populate the vacancy form picker and provide
  // field labels for the submissions review modal.
  const { data: jobPostingForms = [] } = useQuery({
    queryKey: ["job-posting-forms"],
    queryFn: async () => {
      const all = await base44.entities.Form.list();
      return (all || []).filter((f) => f.is_job_posting === true);
    },
    enabled: accessChecked && isGroupAdmin,
    staleTime: 0,
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

  const { data: submissionsByVacancy = {} } = useQuery({
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

  const fieldLabelById = useMemo(() => {
    const map = new Map();
    const fields = submissionsForm?.fields || [];
    for (const f of fields) {
      if (f && f.id) map.set(f.id, f.label || f.id);
    }
    return map;
  }, [submissionsForm]);

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

  const saveVacancyMutation = useMutation({
    mutationFn: async () => {
      const title = vacancyForm.role_title.trim();
      const description = vacancyForm.role_description.trim();
      if (!title) throw new Error("Role title is required");
      if (!description) throw new Error("Role description is required");
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

  // Award a vacancy position to a member: records the award, then upserts the
  // member's group assignment so their group_role becomes the vacancy's role.
  const awardPositionMutation = useMutation({
    mutationFn: async ({ vacancy, memberId, email, sourceType, sourceId }) => {
      if (!vacancy?.id) throw new Error("No vacancy selected");
      if (getRemainingPositions(vacancy) <= 0) {
        throw new Error("All positions for this vacancy are already filled.");
      }
      // Form submissions don't carry a member id — resolve one from the
      // submitter's email so we can award and assign the role.
      let resolvedMemberId = memberId || null;
      if (!resolvedMemberId && email) {
        const matches = await base44.entities.Member.filter({
          email: email.trim().toLowerCase(),
        }).catch(() => []);
        resolvedMemberId = matches?.[0]?.id || null;
      }
      if (!resolvedMemberId) {
        throw new Error(
          "This applicant isn't linked to a member record, so the position can't be awarded."
        );
      }
      const role = (vacancy.role_title || "").trim();
      await base44.entities.VacancyAward.create({
        member_group_id: groupId,
        vacancy_id: vacancy.id,
        awarded_member_id: resolvedMemberId,
        source_type: sourceType || null,
        source_id: sourceId || null,
      });
      const existing = groupAssignments.find(
        (a) => a.member_id === resolvedMemberId && a.group_id === groupId
      );
      if (existing) {
        if (role && existing.group_role !== role) {
          await base44.entities.MemberGroupAssignment.update(existing.id, {
            group_role: role,
          });
        }
      } else {
        await base44.entities.MemberGroupAssignment.create({
          group_id: groupId,
          member_id: memberId,
          group_role: role || "Member",
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group-vacancy-awards", groupId] });
      queryClient.invalidateQueries({
        queryKey: ["member-group-assignments-group", groupId],
      });
      queryClient.invalidateQueries({ queryKey: ["member-group-members", groupId] });
      toast.success("Position awarded");
    },
    onError: (error) => {
      toast.error("Failed to award position: " + (error?.message || "Unknown error"));
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

  // --- Group resources section ---
  const { data: groupResources = [], isLoading: loadingResources } = useQuery({
    queryKey: ["member-group-resources", groupId],
    queryFn: () => base44.entities.Resource.filter({ member_group_id: groupId }),
    enabled: accessChecked && !!groupId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const isAuthenticated = !!memberInfo?.email;

  const [resourceSearch, setResourceSearch] = useState("");
  const [resourcePage, setResourcePage] = useState(1);
  const [showResourceDialog, setShowResourceDialog] = useState(false);
  const [resourceForm, setResourceForm] = useState(EMPTY_RESOURCE_FORM);
  const [resourceFile, setResourceFile] = useState(null);
  const [resourceImageFile, setResourceImageFile] = useState(null);
  const [resourceUploadProgress, setResourceUploadProgress] = useState(0);

  // Non-admins never see member-only resources of another group; the public
  // ResourceCard handles the login gate, but here everyone viewing is already
  // a member, so we show all of the group's resources to members and admins.
  const visibleResources = useMemo(() => {
    if (isGroupAdmin || isJoined) return groupResources;
    // Non-member, non-admin viewers only see public group resources.
    return groupResources.filter((r) => r.is_public === true);
  }, [groupResources, isGroupAdmin, isJoined]);

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
        const aDate = new Date(a.published_date || a.created_date || 0).getTime();
        const bDate = new Date(b.published_date || b.created_date || 0).getTime();
        return bDate - aDate;
      });
  }, [visibleResources, resourceSearch]);

  useEffect(() => {
    setResourcePage(1);
  }, [resourceSearch, groupId]);

  const resourceTotalPages = Math.max(
    1,
    Math.ceil(filteredResources.length / RESOURCES_PER_PAGE)
  );
  const currentResourcePage = Math.min(resourcePage, resourceTotalPages);
  const pagedResources = useMemo(() => {
    const start = (currentResourcePage - 1) * RESOURCES_PER_PAGE;
    return filteredResources.slice(start, start + RESOURCES_PER_PAGE);
  }, [filteredResources, currentResourcePage]);

  const createResourceMutation = useMutation({
    mutationFn: async (form) => {
      const isDownload = form.resource_type === "download";

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
        is_public: form.is_public === true,
        status: "active",
        member_group_id: groupId,
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
      <div className="max-w-7xl mx-auto">
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
              {isGroupAdmin &&
                !isFeatureExcluded("membership.member-group-email") && (
                <Button
                  variant="outline"
                  className="ml-auto"
                  onClick={() => navigate(`/GroupEmail?group_id=${groupId}`)}
                  data-testid="button-send-group-email"
                >
                  <Mail className="w-4 h-4 mr-2" />
                  Send group email
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
                  const isClosed = vacancy.status === "closed";
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
                      adminActions={adminActions}
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
                      {pagedResources.map((resource) => (
                        <ResourceCard
                          key={resource.id}
                          resource={resource}
                          isAuthenticated={isAuthenticated}
                        />
                      ))}
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
      </div>

      <Dialog
        open={showResourceDialog}
        onOpenChange={(open) => {
          if (!createResourceMutation.isPending) setShowResourceDialog(open);
        }}
      >
        <DialogContent
          className="max-w-lg"
          data-testid="dialog-create-resource"
        >
          <DialogHeader>
            <DialogTitle>Create resource</DialogTitle>
            <DialogDescription>
              Add a resource for this group. Members of this group will see it on
              this page.
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
                  setResourceForm((f) => ({ ...f, resource_type: value }))
                }
              >
                <SelectTrigger data-testid="select-resource-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="download">File download</SelectItem>
                  <SelectItem value="external_link">External link</SelectItem>
                  <SelectItem value="video">Video</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {resourceForm.resource_type === "download" ? (
              <div className="space-y-2">
                <Label htmlFor="resource-file">File</Label>
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

            {createResourceMutation.isPending &&
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
              onClick={() => setShowResourceDialog(false)}
              disabled={createResourceMutation.isPending}
              data-testid="button-cancel-resource"
            >
              Cancel
            </Button>
            <Button
              onClick={() => createResourceMutation.mutate(resourceForm)}
              disabled={
                createResourceMutation.isPending ||
                !resourceForm.title.trim()
              }
              data-testid="button-save-resource"
            >
              {createResourceMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                "Create resource"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              __html: DOMPurify.sanitize(group.terms_of_reference || ""),
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
        <DialogContent className="max-w-lg" data-testid="dialog-post-vacancy">
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
                  onValueChange={(v) =>
                    setVacancyForm((f) => ({ ...f, role_title: v }))
                  }
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
                !vacancyForm.role_description.trim()
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
                  const remaining = getRemainingPositions(applicantsVacancy);
                  return applicants.map((app) => {
                    const member = app.__member;
                    const display = member ? getMemberDisplay(member) : null;
                    const name = display ? display.displayName : "Unknown member";
                    const isAwarded =
                      app.member_id && awardedMemberIds.has(app.member_id);
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
                          {isAwarded ? (
                            <Badge
                              variant="secondary"
                              data-testid={`badge-applicant-awarded-${app.id}`}
                            >
                              <Check className="w-3.5 h-3.5 mr-1" />
                              Awarded
                            </Badge>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                !app.member_id ||
                                remaining <= 0 ||
                                awardPositionMutation.isPending
                              }
                              onClick={() =>
                                awardPositionMutation.mutate({
                                  vacancy: applicantsVacancy,
                                  memberId: app.member_id,
                                  sourceType: "application",
                                  sourceId: app.id,
                                })
                              }
                              data-testid={`button-award-applicant-${app.id}`}
                            >
                              <Award className="w-4 h-4 mr-2" />
                              Award position
                            </Button>
                          )}
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
                    const entries = Object.entries(data).filter(
                      ([, v]) => v !== "" && v != null
                    );
                    const isAwarded = awardedSourceIds.has(sub.id);
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
                          {isAwarded ? (
                            <Badge
                              variant="secondary"
                              data-testid={`badge-submission-awarded-${sub.id}`}
                            >
                              <Check className="w-3.5 h-3.5 mr-1" />
                              Awarded
                            </Badge>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                !sub.submitted_by_email ||
                                submissionsRemaining <= 0 ||
                                awardPositionMutation.isPending
                              }
                              onClick={() =>
                                awardPositionMutation.mutate({
                                  vacancy: submissionsVacancy,
                                  email: sub.submitted_by_email,
                                  sourceType: "submission",
                                  sourceId: sub.id,
                                })
                              }
                              data-testid={`button-award-submission-${sub.id}`}
                            >
                              <Award className="w-4 h-4 mr-2" />
                              Award position
                            </Button>
                          )}
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
                              entries.map(([fieldId, value]) => (
                                <div key={fieldId} className="flex flex-col">
                                  <span className="text-xs font-medium text-slate-500">
                                    {fieldLabelById.get(fieldId) || fieldId}
                                  </span>
                                  <span className="text-sm text-slate-800 whitespace-pre-wrap">
                                    {renderAnswerValue(value)}
                                  </span>
                                </div>
                              ))
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
    </div>
  );
}
