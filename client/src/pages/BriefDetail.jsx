import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  ArrowLeft,
  FileText,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader2,
  Pencil,
  Eye,
  XCircle,
  Upload,
  MessageSquare,
  Send,
  History,
  Save,
  FileUp,
  ExternalLink,
  Paperclip,
  X,
  BookOpen,
  ImagePlus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { uploadFileWithProgress, UPLOAD_TYPES } from "@/lib/tenantUpload";
import SimpleRichTextEditor from "@/components/SimpleRichTextEditor";
import MemberCombobox from "@/components/MemberCombobox";
import DOMPurify from "dompurify";

const DEFAULT_STATUS_CONFIG = {
  new: { label: "New", color: "#6b7280", icon: Clock },
  assigned: { label: "Assigned", color: "#3b82f6", icon: FileText },
  in_progress: { label: "In Progress", color: "#f59e0b", icon: Pencil },
  under_review: { label: "Under Review", color: "#a855f7", icon: Eye },
  changes_requested: { label: "Changes Requested", color: "#f97316", icon: AlertCircle },
  rejected: { label: "Rejected", color: "#ef4444", icon: XCircle },
};

function buildStatusConfig(stages) {
  if (!stages || stages.length === 0) return DEFAULT_STATUS_CONFIG;
  const config = {};
  for (const stage of stages) {
    config[stage.key] = { label: stage.label, color: stage.color, icon: Clock };
  }
  return new Proxy(config, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string') return { label: prop.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), color: '#6b7280', icon: Clock };
      return undefined;
    }
  });
}

const COMMENT_CATEGORIES = [
  { value: "structure", label: "Structure" },
  { value: "tone", label: "Tone" },
  { value: "factual", label: "Factual" },
  { value: "grammar", label: "Grammar" },
  { value: "missing_info", label: "Missing Info" },
  { value: "other", label: "Other" },
];

const CATEGORY_COLORS = {
  structure: "#3b82f6",
  tone: "#a855f7",
  factual: "#ef4444",
  grammar: "#f59e0b",
  missing_info: "#f97316",
  other: "#6b7280",
};

async function apiRequest(method, url, body = null) {
  const options = { method, credentials: "include", headers: {} };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }
  return response.json();
}

export default function BriefDetailPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const briefId = searchParams.get("id");
  const queryClient = useQueryClient();
  const { isAccessReady, memberInfo, isFeatureExcluded } = useMemberAccess();

  const canManage = !isFeatureExcluded("content.briefs.manage");
  const canAssign = !isFeatureExcluded("content.briefs.assign");
  const canChangeStatus = !isFeatureExcluded("content.briefs.change-status");
  const canUploadDraft = !isFeatureExcluded("content.briefs.upload-draft");
  const canReviewComment = !isFeatureExcluded("content.briefs.review-comments");

  const [activeTab, setActiveTab] = useState("overview");
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [submissionNote, setSubmissionNote] = useState("");
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [statusConfirm, setStatusConfirm] = useState(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const editAttachmentRef = useRef(null);

  const [commentText, setCommentText] = useState("");
  const [commentCategory, setCommentCategory] = useState("other");
  const [commentVersionId, setCommentVersionId] = useState("");

  const [previewImage, setPreviewImage] = useState(null);

  const [csProvider, setCsProvider] = useState({ first_name: "", last_name: "", email: "" });
  const [csSelectedFormId, setCsSelectedFormId] = useState("");
  const [csEmailContent, setCsEmailContent] = useState("");
  const [csFormInitialized, setCsFormInitialized] = useState(false);

  const { data: briefSettings } = useQuery({
    queryKey: ["brief-settings"],
    queryFn: async () => {
      const res = await fetch("/api/article-briefs/settings", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: isAccessReady,
    staleTime: 60000,
  });

  const STATUS_CONFIG = useMemo(() => buildStatusConfig(briefSettings?.stages), [briefSettings?.stages]);

  const { data: brief, isLoading: briefLoading } = useQuery({
    queryKey: ["article-brief", briefId],
    queryFn: async () => {
      const briefs = await base44.entities.ArticleBrief.list();
      return briefs.find((b) => b.id === briefId) || null;
    },
    enabled: isAccessReady && !!briefId,
  });

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ["article-brief-versions", briefId],
    queryFn: async () => {
      const allVersions = await base44.entities.ArticleBriefVersion.list();
      return allVersions
        .filter((v) => v.article_brief_id === briefId)
        .sort((a, b) => b.version_number - a.version_number);
    },
    enabled: isAccessReady && !!briefId,
  });

  const { data: comments = [], isLoading: commentsLoading } = useQuery({
    queryKey: ["article-brief-comments", briefId],
    queryFn: async () => {
      const allComments = await base44.entities.ArticleBriefComment.list();
      return allComments
        .filter((c) => c.article_brief_id === briefId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },
    enabled: isAccessReady && !!briefId,
  });

  const { data: activities = [], isLoading: activitiesLoading } = useQuery({
    queryKey: ["article-brief-activity", briefId],
    queryFn: async () => {
      return await apiRequest("GET", `/api/article-briefs/${briefId}/activity`);
    },
    enabled: isAccessReady && !!briefId,
  });

  const { data: availableForms = [] } = useQuery({
    queryKey: ["forms-for-case-study"],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list();
      return allForms.filter((f) => f.is_active && !f.is_contract && !f.require_authentication);
    },
    enabled: isAccessReady,
  });

  const caseStudySubmissionId = brief?.case_study_submission_id;
  const caseStudyFormId = brief?.case_study_form_id;

  const { data: caseStudySubmission } = useQuery({
    queryKey: ["case-study-submission", caseStudySubmissionId],
    queryFn: async () => {
      if (!caseStudySubmissionId) return null;
      return await base44.entities.FormSubmission.get(caseStudySubmissionId);
    },
    enabled: isAccessReady && !!caseStudySubmissionId,
  });

  const { data: caseStudyForm } = useQuery({
    queryKey: ["case-study-form", caseStudyFormId],
    queryFn: async () => {
      if (!caseStudyFormId) return null;
      return await base44.entities.Form.get(caseStudyFormId);
    },
    enabled: isAccessReady && !!caseStudyFormId,
  });

  const referencedMemberIds = useMemo(() => {
    const ids = new Set();
    if (brief) {
      if (brief.assigned_writer_id) ids.add(brief.assigned_writer_id);
      if (brief.review_owner_id) ids.add(brief.review_owner_id);
      if (brief.created_by) ids.add(brief.created_by);
    }
    comments.forEach((c) => { if (c.created_by) ids.add(c.created_by); });
    versions.forEach((v) => { if (v.uploaded_by) ids.add(v.uploaded_by); });
    activities.forEach((a) => { if (a.performed_by) ids.add(a.performed_by); });
    return Array.from(ids);
  }, [brief, comments, versions, activities]);

  const { data: referencedMembers = [] } = useQuery({
    queryKey: ["members-by-ids", referencedMemberIds],
    queryFn: async () => {
      if (referencedMemberIds.length === 0) return [];
      const resp = await fetch(`/api/members/by-ids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids: referencedMemberIds }),
      });
      if (!resp.ok) return [];
      return await resp.json();
    },
    enabled: isAccessReady && referencedMemberIds.length > 0,
  });

  const membersById = useMemo(() => {
    const map = {};
    referencedMembers.forEach((m) => { map[m.id] = m; });
    return map;
  }, [referencedMembers]);

  const getMemberName = (memberId) => {
    if (!memberId) return "Unknown";
    const member = membersById[memberId];
    if (!member) return "Unknown";
    return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Unknown";
  };

  const commentsByVersion = useMemo(() => {
    const grouped = {};
    const unlinked = [];
    comments.forEach((c) => {
      if (c.version_id) {
        if (!grouped[c.version_id]) grouped[c.version_id] = [];
        grouped[c.version_id].push(c);
      } else {
        unlinked.push(c);
      }
    });
    return { grouped, unlinked };
  }, [comments]);

  const isWriter = brief?.assigned_writer_id === memberInfo?.id;
  const isReviewer = brief?.review_owner_id === memberInfo?.id;
  const isCreator = brief?.created_by === memberInfo?.id;

  const updateMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.ArticleBrief.update(briefId, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-brief", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-activity", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      setIsEditing(false);
      toast.success("Brief updated");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update brief");
    },
  });

  const statusMutation = useMutation({
    mutationFn: async (newStatus) => {
      return await base44.entities.ArticleBrief.update(briefId, { status: newStatus });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-brief", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-activity", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      setStatusConfirm(null);
      toast.success("Status updated");
    },
    onError: () => {
      toast.error("Failed to update status");
      setStatusConfirm(null);
    },
  });

  const addCommentMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.ArticleBriefComment.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-brief-comments", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-activity", briefId] });
      setCommentText("");
      setCommentCategory("other");
      setCommentVersionId("");
      toast.success("Comment added");
    },
    onError: () => {
      toast.error("Failed to add comment");
    },
  });

  const updateCommentMutation = useMutation({
    mutationFn: async ({ commentId, status }) => {
      return await base44.entities.ArticleBriefComment.update(commentId, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-brief-comments", briefId] });
      toast.success("Comment status updated");
    },
    onError: () => {
      toast.error("Failed to update comment");
    },
  });

  const sendCaseStudyFormMutation = useMutation({
    mutationFn: async ({ form_id, provider, email_content }) => {
      return await apiRequest("POST", `/api/article-briefs/${briefId}/send-case-study-form`, {
        form_id,
        provider,
        email_content,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-brief", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      toast.success("Case study form link sent successfully");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to send case study form link");
    },
  });

  useEffect(() => {
    setCsFormInitialized(false);
  }, [briefId]);

  useEffect(() => {
    if (brief && !csFormInitialized) {
      const prov = brief.case_study_provider || {};
      setCsProvider({
        first_name: prov.first_name || "",
        last_name: prov.last_name || "",
        email: prov.email || "",
      });
      setCsSelectedFormId(brief.case_study_form_id || "");
      setCsEmailContent(brief.case_study_email_content || "");
      setCsFormInitialized(true);
    }
  }, [brief, csFormInitialized]);

  const handleStartEdit = () => {
    const existingAttachments = Array.isArray(brief.attachments) ? brief.attachments : [];
    setEditData({
      title: brief.title || "",
      instructions: brief.instructions || "",
      contributor_type: brief.contributor_type || "gfi",
      deadline: brief.deadline ? brief.deadline.split("T")[0] : "",
      writer_deadline: brief.writer_deadline ? brief.writer_deadline.split("T")[0] : "",
      editor_deadline: brief.editor_deadline ? brief.editor_deadline.split("T")[0] : "",
      sla: brief.sla || "2026-2028",
      contract: brief.contract || "Prospects",
      category: brief.category || "",
      notes: brief.notes || "",
      assigned_writer_id: brief.assigned_writer_id || "",
      review_owner_id: brief.review_owner_id || "",
      attachments: existingAttachments,
    });
    setIsEditing(true);
  };

  const handleEditAttachmentUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachmentUploading(true);
    try {
      const result = await uploadFileWithProgress(file, {
        type: UPLOAD_TYPES.ATTACHMENT,
        entityId: briefId,
        isPrivate: true,
      });
      setEditData((p) => ({
        ...p,
        attachments: [...(p.attachments || []), { file_url: result.file_url, file_name: file.name, size: file.size }],
      }));
      toast.success("File attached");
    } catch (err) {
      toast.error(err.message || "Failed to upload attachment");
    } finally {
      setAttachmentUploading(false);
      if (editAttachmentRef.current) editAttachmentRef.current.value = "";
    }
  };

  const removeEditAttachment = (index) => {
    setEditData((p) => ({
      ...p,
      attachments: p.attachments.filter((_, i) => i !== index),
    }));
  };

  const handleSaveEdit = () => {
    const writerId = editData.assigned_writer_id && editData.assigned_writer_id !== "unassigned" ? editData.assigned_writer_id : null;
    const reviewerId = editData.review_owner_id && editData.review_owner_id !== "unassigned" ? editData.review_owner_id : null;
    const payload = {
      title: editData.title.trim(),
      instructions: editData.instructions.trim() || null,
      contributor_type: editData.contributor_type || null,
      deadline: editData.deadline || null,
      writer_deadline: editData.writer_deadline || null,
      editor_deadline: editData.editor_deadline || null,
      sla: editData.sla || null,
      contract: editData.contract || null,
      category: editData.category.trim() || null,
      notes: editData.notes.trim() || null,
      assigned_writer_id: writerId,
      review_owner_id: reviewerId,
      attachments: editData.attachments || [],
    };
    updateMutation.mutate(payload);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) setSelectedFile(file);
  };

  const handleUploadVersion = async () => {
    if (!selectedFile) {
      toast.error("Please select a file");
      return;
    }
    setIsUploading(true);
    setUploadProgress(0);
    try {
      const uploadResult = await uploadFileWithProgress(selectedFile, {
        type: UPLOAD_TYPES.DOCUMENT,
        entityId: briefId,
        isPrivate: true,
        onProgress: (p) => setUploadProgress(p),
      });
      await apiRequest("POST", "/api/article-briefs/upload-version", {
        article_brief_id: briefId,
        file_url: uploadResult.file_url,
        file_name: uploadResult.file_name,
        submission_note: submissionNote.trim() || null,
      });
      queryClient.invalidateQueries({ queryKey: ["article-brief-versions", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-activity", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-versions-all"] });
      setUploadDialogOpen(false);
      setSelectedFile(null);
      setSubmissionNote("");
      setUploadProgress(0);
      toast.success("Version uploaded successfully");
    } catch (err) {
      toast.error(err.message || "Failed to upload version");
    } finally {
      setIsUploading(false);
    }
  };

  const handleAddComment = () => {
    if (!commentText.trim()) {
      toast.error("Comment text is required");
      return;
    }
    const versionId = commentVersionId && commentVersionId !== "none" ? commentVersionId : null;
    addCommentMutation.mutate({
      article_brief_id: briefId,
      version_id: versionId,
      comment_text: commentText.trim(),
      category: commentCategory,
      status: "open",
      created_by: memberInfo?.id || null,
    });
  };

  const getCommentStatusOptions = () => {
    if (isReviewer) return ["open", "closed"];
    if (isWriter) return ["acknowledged", "actioned"];
    return ["open", "acknowledged", "actioned", "closed"];
  };

  if (!briefId) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center" data-testid="text-no-brief-id">
        <p className="text-muted-foreground">No brief ID provided.</p>
      </div>
    );
  }

  if (briefLoading) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!brief) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex flex-col items-center justify-center gap-4" data-testid="text-brief-not-found">
        <p className="text-muted-foreground">Brief not found.</p>
        <Button variant="outline" onClick={() => navigate(createPageUrl("BriefManagement"))} data-testid="button-back-not-found">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Briefs
        </Button>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[brief.status] || STATUS_CONFIG.new;
  const StatusIcon = statusCfg.icon;
  const openComments = comments.filter((c) => c.status === "open" || c.status === "acknowledged");
  const briefAttachments = Array.isArray(brief.attachments) ? brief.attachments : [];

  function renderCommentCard(comment) {
    const catColor = CATEGORY_COLORS[comment.category] || CATEGORY_COLORS.other;
    const catLabel = COMMENT_CATEGORIES.find((c) => c.value === comment.category)?.label || comment.category;
    const baseStatusOptions = getCommentStatusOptions();
    const statusOptions = comment.status && !baseStatusOptions.includes(comment.status)
      ? [comment.status, ...baseStatusOptions]
      : baseStatusOptions;
    const canUpdateStatus = canReviewComment || isWriter || isReviewer;

    return (
      <div key={comment.id} className="p-3 rounded-lg border space-y-2" data-testid={`comment-row-${comment.id}`}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Badge variant="outline" className="text-xs" style={{ borderColor: catColor, color: catColor }}>
            {catLabel}
          </Badge>
          {canUpdateStatus ? (
            <Select
              value={comment.status}
              onValueChange={(v) => updateCommentMutation.mutate({ commentId: comment.id, status: v })}
            >
              <SelectTrigger className="w-[130px]" data-testid={`select-comment-status-${comment.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((s) => (
                  <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="secondary" className="text-xs" data-testid={`badge-comment-status-${comment.id}`}>
              {comment.status?.charAt(0).toUpperCase() + comment.status?.slice(1)}
            </Badge>
          )}
        </div>
        <p className="text-sm whitespace-pre-wrap" data-testid={`text-comment-${comment.id}`}>{comment.comment_text}</p>
        <p className="text-xs text-muted-foreground">
          {getMemberName(comment.created_by)}
          {comment.created_at && ` \u00B7 ${formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })}`}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(createPageUrl("BriefManagement"))}
            data-testid="button-back-to-briefs"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Briefs
          </Button>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold truncate" data-testid="text-brief-title">
              {brief.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <Badge
                className="text-xs no-default-hover-elevate no-default-active-elevate"
                style={{ backgroundColor: statusCfg.color, color: "#fff" }}
                data-testid="badge-brief-status"
              >
                <StatusIcon className="w-3 h-3 mr-1" />
                {statusCfg.label}
              </Badge>
              {brief.category && (
                <Badge variant="secondary" className="text-xs" data-testid="badge-brief-category">
                  {brief.category}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {canManage && !isEditing && (
              <Button variant="outline" size="sm" onClick={handleStartEdit} data-testid="button-edit-brief">
                <Pencil className="w-4 h-4 mr-1" />
                Edit
              </Button>
            )}
            {canUploadDraft && (isWriter || canManage) && (
              <Button size="sm" onClick={() => setUploadDialogOpen(true)} data-testid="button-upload-version">
                <Upload className="w-4 h-4 mr-1" />
                Upload Draft
              </Button>
            )}
          </div>
        </div>

        {canChangeStatus && (
          <div className="mb-6">
            <Label className="text-sm text-muted-foreground mb-2 block">Update Status</Label>
            <div className="flex flex-wrap gap-2">
              {Object.entries(STATUS_CONFIG).filter(([key]) => key !== "approved").map(([key, cfg]) => (
                <Button
                  key={key}
                  variant={brief.status === key ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusConfirm(key)}
                  disabled={statusMutation.isPending || brief.status === key}
                  className="toggle-elevate"
                  style={
                    brief.status === key
                      ? { backgroundColor: cfg.color, borderColor: cfg.color, color: "#fff" }
                      : {}
                  }
                  data-testid={`button-status-${key}`}
                >
                  {cfg.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList data-testid="tabs-brief-detail">
            <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="versions" data-testid="tab-versions">
              Versions ({versions.length})
            </TabsTrigger>
            <TabsTrigger value="comments" data-testid="tab-comments">
              Review ({openComments.length})
            </TabsTrigger>
            <TabsTrigger value="activity" data-testid="tab-activity">Activity</TabsTrigger>
            <TabsTrigger value="case-study" data-testid="tab-case-study">Case Study</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            {isEditing ? (
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="edit-title">Title</Label>
                    <Input id="edit-title" value={editData.title} onChange={(e) => setEditData((p) => ({ ...p, title: e.target.value }))} data-testid="input-edit-title" />
                  </div>
                  <div className="space-y-1">
                    <Label>Full Instructions</Label>
                    <SimpleRichTextEditor
                      content={editData.instructions}
                      onChange={(html) => setEditData((p) => ({ ...p, instructions: html }))}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Contributor Type</Label>
                      <Select value={editData.contributor_type} onValueChange={(v) => setEditData((p) => ({ ...p, contributor_type: v }))}>
                        <SelectTrigger data-testid="select-edit-contributor-type"><SelectValue placeholder="Select type" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gfi">GFI</SelectItem>
                          <SelectItem value="volunteer">Volunteer</SelectItem>
                          <SelectItem value="paid">Paid</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="edit-category">Category</Label>
                      {briefSettings?.categories && briefSettings.categories.length > 0 ? (
                        <Select value={editData.category || ""} onValueChange={(v) => setEditData((p) => ({ ...p, category: v }))}>
                          <SelectTrigger data-testid="select-edit-category"><SelectValue placeholder="Select category" /></SelectTrigger>
                          <SelectContent>
                            {briefSettings.categories.map((cat) => (
                              <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input id="edit-category" value={editData.category} onChange={(e) => setEditData((p) => ({ ...p, category: e.target.value }))} data-testid="input-edit-category" />
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>SLA</Label>
                      <Select value={editData.sla} onValueChange={(v) => setEditData((p) => ({ ...p, sla: v }))}>
                        <SelectTrigger data-testid="select-edit-sla"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="2026-2028">2026-2028</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>Contract</Label>
                      <Select value={editData.contract} onValueChange={(v) => setEditData((p) => ({ ...p, contract: v }))}>
                        <SelectTrigger data-testid="select-edit-contract"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Prospects">Prospects</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="edit-deadline">Submission Deadline</Label>
                      <Input id="edit-deadline" type="date" value={editData.deadline} onChange={(e) => setEditData((p) => ({ ...p, deadline: e.target.value }))} data-testid="input-edit-deadline" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="edit-writer-deadline">Writer Deadline</Label>
                      <Input id="edit-writer-deadline" type="date" value={editData.writer_deadline} onChange={(e) => setEditData((p) => ({ ...p, writer_deadline: e.target.value }))} data-testid="input-edit-writer-deadline" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="edit-editor-deadline">Editor Deadline</Label>
                      <Input id="edit-editor-deadline" type="date" value={editData.editor_deadline} onChange={(e) => setEditData((p) => ({ ...p, editor_deadline: e.target.value }))} data-testid="input-edit-editor-deadline" />
                    </div>
                  </div>
                  {canAssign && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label>Writer</Label>
                          <MemberCombobox
                            value={editData.assigned_writer_id || "unassigned"}
                            onValueChange={(v) => setEditData((p) => ({ ...p, assigned_writer_id: v }))}
                            placeholder="Search writer..."
                            testId="combobox-edit-writer"
                            initialMember={brief?.assigned_writer_id ? membersById[brief.assigned_writer_id] : null}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>Editor</Label>
                          <MemberCombobox
                            value={editData.review_owner_id || "unassigned"}
                            onValueChange={(v) => setEditData((p) => ({ ...p, review_owner_id: v }))}
                            placeholder="Search editor..."
                            testId="combobox-edit-reviewer"
                            initialMember={brief?.review_owner_id ? membersById[brief.review_owner_id] : null}
                          />
                        </div>
                      </div>
                    </>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="edit-notes">Notes</Label>
                    <Textarea id="edit-notes" value={editData.notes} onChange={(e) => setEditData((p) => ({ ...p, notes: e.target.value }))} className="resize-none" rows={2} data-testid="input-edit-notes" />
                  </div>
                  <div className="space-y-2">
                    <Label>Attachments</Label>
                    <input
                      ref={editAttachmentRef}
                      type="file"
                      className="hidden"
                      onChange={handleEditAttachmentUpload}
                      data-testid="input-edit-attachment-file"
                    />
                    <div className="flex flex-wrap gap-2">
                      {(editData.attachments || []).map((att, i) => (
                        <Badge key={i} variant="secondary" className="flex items-center gap-1" data-testid={`badge-edit-attachment-${i}`}>
                          <Paperclip className="w-3 h-3" />
                          <span className="text-xs max-w-[150px] truncate">{att.file_name}</span>
                          <button type="button" onClick={() => removeEditAttachment(i)} className="ml-1" data-testid={`button-remove-edit-attachment-${i}`}>
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => editAttachmentRef.current?.click()}
                      disabled={attachmentUploading}
                      data-testid="button-add-edit-attachment"
                    >
                      {attachmentUploading ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <Paperclip className="w-4 h-4 mr-1" />
                      )}
                      {attachmentUploading ? "Uploading..." : "Add Attachment"}
                    </Button>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setIsEditing(false)} data-testid="button-cancel-edit">Cancel</Button>
                    <Button onClick={handleSaveEdit} disabled={updateMutation.isPending || attachmentUploading} data-testid="button-save-edit">
                      {updateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      <Save className="w-4 h-4 mr-1" />
                      Save
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-3 gap-4">
                <Card className="md:col-span-2">
                  <CardHeader><CardTitle className="text-lg">Brief Details</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    {brief.instructions && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Instructions</Label>
                        <div className="text-sm mt-1 prose prose-sm max-w-none" data-testid="text-brief-instructions" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(brief.instructions) }} />
                      </div>
                    )}
                    {brief.contributor_type && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Contributor Type</Label>
                        <p className="text-sm mt-1" data-testid="text-brief-contributor-type">{brief.contributor_type === 'gfi' ? 'GFI' : brief.contributor_type?.charAt(0).toUpperCase() + brief.contributor_type?.slice(1)}</p>
                      </div>
                    )}
                    {brief.notes && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Notes</Label>
                        <p className="text-sm mt-1 whitespace-pre-wrap" data-testid="text-brief-notes">{brief.notes}</p>
                      </div>
                    )}
                    {briefAttachments.length > 0 && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Attachments</Label>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {briefAttachments.map((att, i) => (
                            <a key={i} href={att.file_url} target="_blank" rel="noopener noreferrer" data-testid={`link-attachment-${i}`}>
                              <Badge variant="secondary" className="flex items-center gap-1 cursor-pointer">
                                <Paperclip className="w-3 h-3" />
                                <span className="text-xs max-w-[200px] truncate">{att.file_name}</span>
                                <ExternalLink className="w-3 h-3 ml-0.5" />
                              </Badge>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    {!brief.instructions && !brief.notes && briefAttachments.length === 0 && (
                      <p className="text-sm text-muted-foreground" data-testid="text-no-details">No description or instructions provided.</p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle className="text-lg">Info</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Writer</Label>
                      <p className="text-sm font-medium" data-testid="text-writer">
                        {brief.assigned_writer_id ? getMemberName(brief.assigned_writer_id) : "--"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Editor</Label>
                      <p className="text-sm font-medium" data-testid="text-reviewer">
                        {brief.review_owner_id ? getMemberName(brief.review_owner_id) : "--"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Created By</Label>
                      <p className="text-sm" data-testid="text-creator">{brief.created_by ? getMemberName(brief.created_by) : "--"}</p>
                    </div>
                    {brief.deadline && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Submission Deadline</Label>
                        <p className="text-sm" data-testid="text-deadline">{format(new Date(brief.deadline), "MMM d, yyyy")}</p>
                      </div>
                    )}
                    {brief.writer_deadline && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Writer Deadline</Label>
                        <p className="text-sm" data-testid="text-writer-deadline">{format(new Date(brief.writer_deadline), "MMM d, yyyy")}</p>
                      </div>
                    )}
                    {brief.editor_deadline && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Editor Deadline</Label>
                        <p className="text-sm" data-testid="text-editor-deadline">{format(new Date(brief.editor_deadline), "MMM d, yyyy")}</p>
                      </div>
                    )}
                    {brief.sla && (
                      <div>
                        <Label className="text-xs text-muted-foreground">SLA</Label>
                        <p className="text-sm" data-testid="text-sla">{brief.sla}</p>
                      </div>
                    )}
                    {brief.contract && (
                      <div>
                        <Label className="text-xs text-muted-foreground">Contract</Label>
                        <p className="text-sm" data-testid="text-contract">{brief.contract}</p>
                      </div>
                    )}
                    <div>
                      <Label className="text-xs text-muted-foreground">Created</Label>
                      <p className="text-sm" data-testid="text-created-date">
                        {brief.created_at ? format(new Date(brief.created_at), "MMM d, yyyy 'at' h:mm a") : "--"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Versions</Label>
                      <p className="text-sm" data-testid="text-version-count">{versions.length} draft{versions.length !== 1 ? "s" : ""} uploaded</p>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          <TabsContent value="versions" className="mt-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-lg">Draft Versions</CardTitle>
                  {canUploadDraft && (isWriter || canManage) && (
                    <Button size="sm" onClick={() => setUploadDialogOpen(true)} data-testid="button-upload-version-tab">
                      <Upload className="w-4 h-4 mr-1" />
                      Upload Draft
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {versionsLoading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                ) : versions.length === 0 ? (
                  <div className="text-center py-12" data-testid="text-no-versions">
                    <FileUp className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                    <p className="text-sm text-muted-foreground">No drafts uploaded yet.</p>
                    <p className="text-xs text-muted-foreground mt-1">Upload a draft to start the review process.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {versions.map((version) => (
                      <div key={version.id} className="flex items-start gap-3 p-3 rounded-lg border" data-testid={`version-row-${version.id}`}>
                        <div className="p-2 bg-muted rounded-md flex-shrink-0 mt-0.5">
                          <FileText className="w-4 h-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">Version {version.version_number}</span>
                            <Badge variant="secondary" className="text-xs">{version.status_at_upload || "N/A"}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">{version.file_name || "Untitled file"}</p>
                          {version.submission_note && (
                            <p className="text-xs text-muted-foreground mt-1 italic">"{version.submission_note}"</p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            Uploaded by {getMemberName(version.uploaded_by)}
                            {version.created_at && ` \u00B7 ${formatDistanceToNow(new Date(version.created_at), { addSuffix: true })}`}
                          </p>
                        </div>
                        {version.file_url && (
                          <Button variant="ghost" size="icon" onClick={() => window.open(version.file_url, "_blank")} title="Open file" data-testid={`button-open-version-${version.id}`}>
                            <ExternalLink className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="comments" className="mt-4">
            <div className="grid md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <Card>
                  <CardHeader><CardTitle className="text-lg">Review Comments</CardTitle></CardHeader>
                  <CardContent>
                    {commentsLoading ? (
                      <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                    ) : comments.length === 0 ? (
                      <div className="text-center py-12" data-testid="text-no-comments">
                        <MessageSquare className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                        <p className="text-sm text-muted-foreground">No review comments yet.</p>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {versions.map((version) => {
                          const versionComments = commentsByVersion.grouped[version.id];
                          if (!versionComments || versionComments.length === 0) return null;
                          return (
                            <div key={version.id} data-testid={`comment-group-version-${version.id}`}>
                              <div className="flex items-center gap-2 mb-2">
                                <FileText className="w-4 h-4 text-muted-foreground" />
                                <span className="text-sm font-medium">Version {version.version_number}</span>
                                <Badge variant="secondary" className="text-xs">{versionComments.length} comment{versionComments.length !== 1 ? "s" : ""}</Badge>
                              </div>
                              <div className="space-y-2 pl-6 border-l-2 border-border">
                                {versionComments.map(renderCommentCard)}
                              </div>
                            </div>
                          );
                        })}
                        {commentsByVersion.unlinked.length > 0 && (
                          <div data-testid="comment-group-general">
                            <div className="flex items-center gap-2 mb-2">
                              <MessageSquare className="w-4 h-4 text-muted-foreground" />
                              <span className="text-sm font-medium">General Comments</span>
                              <Badge variant="secondary" className="text-xs">{commentsByVersion.unlinked.length}</Badge>
                            </div>
                            <div className="space-y-2 pl-6 border-l-2 border-border">
                              {commentsByVersion.unlinked.map(renderCommentCard)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {canReviewComment && (
                <Card>
                  <CardHeader><CardTitle className="text-lg">Add Comment</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-1">
                      <Label>Category</Label>
                      <Select value={commentCategory} onValueChange={setCommentCategory}>
                        <SelectTrigger data-testid="select-comment-category"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {COMMENT_CATEGORIES.map((cat) => (
                            <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {versions.length > 0 && (
                      <div className="space-y-1">
                        <Label>Version (optional)</Label>
                        <Select value={commentVersionId} onValueChange={setCommentVersionId}>
                          <SelectTrigger data-testid="select-comment-version"><SelectValue placeholder="Select version" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No specific version</SelectItem>
                            {versions.map((v) => (
                              <SelectItem key={v.id} value={v.id}>Version {v.version_number}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label htmlFor="comment-text">Comment *</Label>
                      <Textarea
                        id="comment-text"
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        placeholder="Your feedback..."
                        className="resize-none"
                        rows={4}
                        data-testid="input-comment-text"
                      />
                    </div>
                    <Button
                      className="w-full"
                      onClick={handleAddComment}
                      disabled={addCommentMutation.isPending || !commentText.trim()}
                      data-testid="button-submit-comment"
                    >
                      {addCommentMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4 mr-2" />
                      )}
                      Add Comment
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="activity" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <History className="w-5 h-5" />
                  Activity Log
                </CardTitle>
              </CardHeader>
              <CardContent>
                {activitiesLoading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                ) : activities.length === 0 ? (
                  <div className="text-center py-12" data-testid="text-no-activity">
                    <History className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                    <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
                  </div>
                ) : (
                  <div className="space-y-0">
                    {activities.map((activity, index) => (
                      <div key={activity.id} className="flex gap-3 pb-4" data-testid={`activity-row-${activity.id}`}>
                        <div className="flex flex-col items-center">
                          <div className="w-2 h-2 rounded-full bg-muted-foreground mt-2 flex-shrink-0" />
                          {index < activities.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm" data-testid={`text-activity-${activity.id}`}>
                            <span className="font-medium">{getMemberName(activity.performed_by)}</span>{" "}
                            {activity.description || activity.action}
                          </p>
                          {activity.metadata && typeof activity.metadata === "object" && activity.metadata.changes && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {Object.entries(activity.metadata.changes)
                                .map(([key, val]) => `${key}: ${val.from || "none"} \u2192 ${val.to || "none"}`)
                                .join(", ")}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {activity.created_at ? formatDistanceToNow(new Date(activity.created_at), { addSuffix: true }) : "--"}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="case-study" className="mt-4">
            {(() => {
              const canEditCaseStudy = isWriter || canManage;
              const hasFormSubmission = !!brief.case_study_submission_id && !!caseStudySubmission;
              const hasFormSent = !!brief.case_study_form_sent_at;
              const hasLegacyContent = brief.case_study_content || (Array.isArray(brief.case_study_images) && brief.case_study_images.length > 0) || brief.case_study_permissions;
              const provider = brief.case_study_provider;

              const renderSubmissionData = () => {
                if (!caseStudySubmission?.submission_data) return null;
                const fields = caseStudyForm?.fields || [];
                const data = caseStudySubmission.submission_data;
                const fieldMap = {};
                fields.forEach((f) => { fieldMap[f.id] = f; });

                const entries = Object.entries(data);
                const imageEntries = [];
                const docEntries = [];
                const fieldEntries = [];

                entries.forEach(([key, value]) => {
                  const field = fieldMap[key];
                  if (!value || (field && (field.type === 'instructions' || field.type === 'image'))) return;

                  if (field?.type === 'file_upload' || field?.type === 'image_upload') {
                    const files = Array.isArray(value) ? value : [value];
                    files.forEach((f) => {
                      const url = typeof f === 'string' ? f : f?.file_url || f?.url;
                      const name = typeof f === 'string' ? key : f?.file_name || f?.name || key;
                      if (!url) return;
                      const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url);
                      if (isImage) {
                        imageEntries.push({ url, name });
                      } else {
                        docEntries.push({ url, name });
                      }
                    });
                  } else {
                    const label = field?.label || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
                    let displayValue = value;
                    if (typeof value === 'boolean') displayValue = value ? 'Yes' : 'No';
                    else if (Array.isArray(value)) displayValue = value.join(', ');
                    else if (typeof value === 'object') displayValue = JSON.stringify(value);
                    fieldEntries.push({ label, value: String(displayValue) });
                  }
                });

                return (
                  <div className="space-y-4">
                    {fieldEntries.length > 0 && (
                      <Card>
                        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><BookOpen className="w-5 h-5" />Submitted Answers</CardTitle></CardHeader>
                        <CardContent>
                          <div className="grid sm:grid-cols-2 gap-4">
                            {fieldEntries.map((entry, i) => (
                              <div key={i} data-testid={`text-submission-field-${i}`}>
                                <Label className="text-xs text-muted-foreground">{entry.label}</Label>
                                <p className="text-sm mt-0.5 whitespace-pre-wrap">{entry.value}</p>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}
                    {imageEntries.length > 0 && (
                      <Card>
                        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><ImagePlus className="w-5 h-5" />Uploaded Images</CardTitle></CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                            {imageEntries.map((img, i) => (
                              <a key={i} href={img.url} target="_blank" rel="noopener noreferrer" className="block rounded-md overflow-visible border hover-elevate" data-testid={`link-submission-image-${i}`}>
                                <img src={img.url} alt={img.name} className="w-full h-24 object-cover rounded-md" />
                                <p className="text-xs text-muted-foreground p-1 truncate">{img.name}</p>
                              </a>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}
                    {docEntries.length > 0 && (
                      <Card>
                        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><Paperclip className="w-5 h-5" />Uploaded Documents</CardTitle></CardHeader>
                        <CardContent>
                          <div className="space-y-2">
                            {docEntries.map((doc, i) => (
                              <a key={i} href={doc.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm hover-elevate p-2 rounded-md border" data-testid={`link-submission-doc-${i}`}>
                                <ExternalLink className="w-4 h-4 text-muted-foreground" />
                                <span>{doc.name}</span>
                              </a>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                );
              };

              const renderProviderStatus = () => {
                let statusText = "Not sent";
                let statusColor = "secondary";
                if (hasFormSubmission) {
                  statusText = "Submitted";
                  statusColor = "default";
                } else if (hasFormSent) {
                  statusText = `Sent on ${(() => { try { return format(new Date(brief.case_study_form_sent_at), "MMM d, yyyy"); } catch { return brief.case_study_form_sent_at; } })()}`;
                  statusColor = "secondary";
                }

                return (
                  <Card>
                    <CardHeader><CardTitle className="text-lg flex items-center gap-2"><Send className="w-5 h-5" />Case Study Provider</CardTitle></CardHeader>
                    <CardContent>
                      <div className="grid sm:grid-cols-2 gap-4">
                        {provider && (
                          <>
                            <div>
                              <Label className="text-xs text-muted-foreground">Name</Label>
                              <p className="text-sm mt-0.5" data-testid="text-cs-provider-name">{provider.first_name} {provider.last_name}</p>
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Email</Label>
                              <p className="text-sm mt-0.5" data-testid="text-cs-provider-email">{provider.email}</p>
                            </div>
                          </>
                        )}
                        <div>
                          <Label className="text-xs text-muted-foreground">Status</Label>
                          <div className="mt-1">
                            <Badge variant={statusColor} data-testid="badge-cs-status">
                              {hasFormSubmission && <CheckCircle className="w-3 h-3 mr-1" />}
                              {!hasFormSubmission && hasFormSent && <Clock className="w-3 h-3 mr-1" />}
                              {statusText}
                            </Badge>
                          </div>
                        </div>
                        {caseStudyForm && (
                          <div>
                            <Label className="text-xs text-muted-foreground">Form</Label>
                            <p className="text-sm mt-0.5" data-testid="text-cs-form-name">{caseStudyForm.name}</p>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              };

              const renderLegacyContent = () => {
                if (!hasLegacyContent) return null;
                const perms = brief.case_study_permissions || {};
                const permMethodLabels = { email: "Email", verbal: "Verbal", signed_form: "Signed Form", other: "Other" };
                return (
                  <div className="space-y-4">
                    {brief.case_study_content && (
                      <Card>
                        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><BookOpen className="w-5 h-5" />Case Study Content</CardTitle></CardHeader>
                        <CardContent>
                          <div className="prose prose-sm max-w-none" data-testid="text-case-study-content-readonly" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(brief.case_study_content) }} />
                        </CardContent>
                      </Card>
                    )}
                    {Array.isArray(brief.case_study_images) && brief.case_study_images.length > 0 && (
                      <Card>
                        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><ImagePlus className="w-5 h-5" />Images</CardTitle></CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                            {brief.case_study_images.map((img, i) => (
                              <a key={i} href={img.file_url} target="_blank" rel="noopener noreferrer" className="block rounded-md overflow-visible border hover-elevate" data-testid={`link-case-study-image-${i}`}>
                                <img src={img.file_url} alt={img.file_name || `Image ${i + 1}`} className="w-full h-24 object-cover rounded-md" />
                                <p className="text-xs text-muted-foreground p-1 truncate">{img.file_name}</p>
                              </a>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}
                    {brief.case_study_permissions && Object.values(perms).some(Boolean) && (
                      <Card>
                        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><ShieldCheck className="w-5 h-5" />Permissions</CardTitle></CardHeader>
                        <CardContent>
                          <div className="grid sm:grid-cols-2 gap-4">
                            {perms.contact_name && (<div><Label className="text-xs text-muted-foreground">Contact Name</Label><p className="text-sm mt-0.5" data-testid="text-perm-contact-name">{perms.contact_name}</p></div>)}
                            {perms.role && (<div><Label className="text-xs text-muted-foreground">Role / Job Title</Label><p className="text-sm mt-0.5" data-testid="text-perm-role">{perms.role}</p></div>)}
                            {perms.organisation && (<div><Label className="text-xs text-muted-foreground">Organisation</Label><p className="text-sm mt-0.5" data-testid="text-perm-organisation">{perms.organisation}</p></div>)}
                            {perms.date_granted && (<div><Label className="text-xs text-muted-foreground">Date Permission Granted</Label><p className="text-sm mt-0.5" data-testid="text-perm-date">{(() => { try { return format(new Date(perms.date_granted), "MMM d, yyyy"); } catch { return perms.date_granted; } })()}</p></div>)}
                            {perms.method && (<div><Label className="text-xs text-muted-foreground">Method</Label><p className="text-sm mt-0.5" data-testid="text-perm-method">{permMethodLabels[perms.method] || perms.method}</p></div>)}
                            {perms.notes && (<div className="sm:col-span-2"><Label className="text-xs text-muted-foreground">Additional Notes</Label><p className="text-sm mt-0.5 whitespace-pre-wrap" data-testid="text-perm-notes">{perms.notes}</p></div>)}
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                );
              };

              if (hasFormSubmission) {
                return (
                  <div className="space-y-4">
                    {renderProviderStatus()}
                    {renderSubmissionData()}
                  </div>
                );
              }

              if (hasFormSent && !canEditCaseStudy) {
                return (
                  <div className="space-y-4">
                    {renderProviderStatus()}
                    {hasLegacyContent && renderLegacyContent()}
                  </div>
                );
              }

              if (!canEditCaseStudy) {
                if (hasLegacyContent) {
                  return renderLegacyContent();
                }
                return (
                  <Card>
                    <CardContent className="pt-6">
                      <div className="text-center py-12" data-testid="text-no-case-study">
                        <BookOpen className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                        <p className="text-sm text-muted-foreground">No case study has been created yet.</p>
                      </div>
                    </CardContent>
                  </Card>
                );
              }

              const handleSendCaseStudyForm = () => {
                if (!csProvider.first_name.trim() || !csProvider.last_name.trim() || !csProvider.email.trim()) {
                  toast.error("Please fill in the provider's first name, last name, and email");
                  return;
                }
                if (!csSelectedFormId) {
                  toast.error("Please select a form to send");
                  return;
                }
                if (!csEmailContent.trim()) {
                  toast.error("Please write an email message to accompany the form link");
                  return;
                }
                sendCaseStudyFormMutation.mutate({
                  form_id: csSelectedFormId,
                  provider: csProvider,
                  email_content: csEmailContent,
                });
              };

              return (
                <div className="space-y-4">
                  {hasFormSent && renderProviderStatus()}

                  <Card>
                    <CardHeader><CardTitle className="text-lg flex items-center gap-2"><Send className="w-5 h-5" />{hasFormSent ? "Resend Form Link" : "Send Case Study Form"}</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid sm:grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="cs-first-name">First Name *</Label>
                          <Input
                            id="cs-first-name"
                            value={csProvider.first_name}
                            onChange={(e) => setCsProvider((p) => ({ ...p, first_name: e.target.value }))}
                            placeholder="First name"
                            data-testid="input-cs-first-name"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="cs-last-name">Last Name *</Label>
                          <Input
                            id="cs-last-name"
                            value={csProvider.last_name}
                            onChange={(e) => setCsProvider((p) => ({ ...p, last_name: e.target.value }))}
                            placeholder="Last name"
                            data-testid="input-cs-last-name"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="cs-email">Email *</Label>
                          <Input
                            id="cs-email"
                            type="email"
                            value={csProvider.email}
                            onChange={(e) => setCsProvider((p) => ({ ...p, email: e.target.value }))}
                            placeholder="provider@example.com"
                            data-testid="input-cs-email"
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label>Form *</Label>
                        <Select value={csSelectedFormId || "none"} onValueChange={(v) => setCsSelectedFormId(v === "none" ? "" : v)}>
                          <SelectTrigger data-testid="select-cs-form"><SelectValue placeholder="Select a form..." /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Select a form...</SelectItem>
                            {availableForms.map((f) => (
                              <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="cs-email-body">Email Message *</Label>
                        <SimpleRichTextEditor
                          content={csEmailContent}
                          onChange={setCsEmailContent}
                          placeholder="Write the email message to send along with the form link..."
                          className=""
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button
                          onClick={handleSendCaseStudyForm}
                          disabled={sendCaseStudyFormMutation.isPending}
                          data-testid="button-send-case-study-form"
                        >
                          {sendCaseStudyFormMutation.isPending ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Send className="w-4 h-4 mr-1" />
                          )}
                          {hasFormSent ? "Resend Form Link" : "Send Form Link"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  {hasLegacyContent && renderLegacyContent()}
                </div>
              );
            })()}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-3xl" data-testid="dialog-image-preview">
          <DialogHeader>
            <DialogTitle>Image Preview</DialogTitle>
            <DialogDescription>Full size image preview</DialogDescription>
          </DialogHeader>
          {previewImage && (
            <img src={previewImage} alt="Preview" className="w-full rounded-md" data-testid="img-preview-full" />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-upload-version">
          <DialogHeader>
            <DialogTitle>Upload Draft</DialogTitle>
            <DialogDescription>Upload a new version of your article draft.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>File *</Label>
              <div
                className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors hover-elevate"
                onClick={() => fileInputRef.current?.click()}
                data-testid="dropzone-file-upload"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileSelect}
                  accept=".doc,.docx,.pdf,.txt,.rtf,.odt,.md"
                  data-testid="input-file-upload"
                />
                {selectedFile ? (
                  <div>
                    <FileText className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm font-medium" data-testid="text-selected-file">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                ) : (
                  <div>
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Click to select a file</p>
                    <p className="text-xs text-muted-foreground mt-1">DOC, DOCX, PDF, TXT, RTF, ODT, MD (max 25MB)</p>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="submission-note">Submission Note (optional)</Label>
              <Textarea
                id="submission-note"
                value={submissionNote}
                onChange={(e) => setSubmissionNote(e.target.value)}
                placeholder="Any notes about this submission..."
                className="resize-none"
                rows={2}
                data-testid="input-submission-note"
              />
            </div>
            {isUploading && (
              <div className="space-y-1" data-testid="upload-progress">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Uploading...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setUploadDialogOpen(false); setSelectedFile(null); setSubmissionNote(""); }} disabled={isUploading} data-testid="button-cancel-upload">
              Cancel
            </Button>
            <Button onClick={handleUploadVersion} disabled={isUploading || !selectedFile} data-testid="button-confirm-upload">
              {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!statusConfirm} onOpenChange={(open) => !open && setStatusConfirm(null)}>
        <AlertDialogContent data-testid="dialog-confirm-status">
          <AlertDialogHeader>
            <AlertDialogTitle>Change Status</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to change the status to "{statusConfirm ? STATUS_CONFIG[statusConfirm]?.label : ""}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-status">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => statusMutation.mutate(statusConfirm)}
              data-testid="button-confirm-status"
            >
              {statusMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
