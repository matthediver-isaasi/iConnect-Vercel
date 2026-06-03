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
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  ArrowLeft,
  FileText,
  Clock,
  CheckCircle,
  AlertCircle,
  Loader2,
  Pencil,
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
import ExternalWriterCombobox from "@/components/ExternalWriterCombobox";
import DOMPurify from "dompurify";

const DEFAULT_STATUS_CONFIG = {
  new: { label: "New", color: "#6b7280", icon: Clock },
  assigned: { label: "Assigned", color: "#3b82f6", icon: FileText },
  in_progress: { label: "In Progress", color: "#f59e0b", icon: Pencil },
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

function isSignatureSubmittedValue(field, value) {
  if (field?.type === 'signature') return true;
  if (typeof value === 'string' && value.startsWith('data:image/')) return true;
  if (value && typeof value === 'object') {
    if (value.type === 'signature') return true;
    if (typeof value.data === 'string' && value.data.startsWith('data:image/')) return true;
  }
  return false;
}

function extractSignatureDetails(value) {
  if (typeof value === 'string') {
    return { dataUrl: value, typedName: null, signedAt: null, mode: null };
  }
  if (value && typeof value === 'object') {
    const dataUrl = typeof value.data === 'string' ? value.data : null;
    return {
      dataUrl,
      typedName: typeof value.typedName === 'string' ? value.typedName : null,
      signedAt: typeof value.signed_at === 'string' ? value.signed_at : null,
      mode: typeof value.mode === 'string' ? value.mode : null,
    };
  }
  return { dataUrl: null, typedName: null, signedAt: null, mode: null };
}

function summarizeSubmittedObject(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.type === 'string') return value.type;
  for (const v of Object.values(value)) {
    if (typeof v === 'string' && v && !v.startsWith('data:')) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return 'Submitted';
}

function processSubmissionData(data, fields) {
  const fieldMap = {};
  (fields || []).forEach((f) => { fieldMap[f.id] = f; });
  const imageEntries = [];
  const docEntries = [];
  const fieldEntries = [];
  Object.entries(data || {}).forEach(([key, value]) => {
    const field = fieldMap[key];
    if (value === null || value === undefined || value === '') return;
    if (field && (field.type === 'instructions' || field.type === 'image')) return;
    const label = field?.label || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (isSignatureSubmittedValue(field, value)) {
      const sig = extractSignatureDetails(value);
      if (sig.dataUrl) {
        fieldEntries.push({ kind: 'signature', label, ...sig });
      }
      return;
    }
    if (field?.type === 'file_upload' || field?.type === 'image_upload') {
      const files = Array.isArray(value) ? value : [value];
      files.forEach((f) => {
        const url = typeof f === 'string' ? f : f?.file_url || f?.url;
        const name = typeof f === 'string' ? key : f?.file_name || f?.name || key;
        if (!url) return;
        const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url);
        if (isImage) imageEntries.push({ url, name });
        else docEntries.push({ url, name });
      });
      return;
    }
    if (typeof value === 'boolean') {
      fieldEntries.push({ kind: 'text', label, text: value ? 'Yes' : 'No' });
    } else if (Array.isArray(value)) {
      const text = value
        .map((v) => (v && typeof v === 'object' ? summarizeSubmittedObject(v) : String(v)))
        .join(', ');
      fieldEntries.push({ kind: 'text', label, text });
    } else if (typeof value === 'object') {
      fieldEntries.push({ kind: 'text', label, text: summarizeSubmittedObject(value) });
    } else {
      fieldEntries.push({ kind: 'text', label, text: String(value) });
    }
  });
  return { imageEntries, docEntries, fieldEntries };
}

function SubmittedFieldEntry({ entry, testId }) {
  if (entry.kind === 'signature') {
    let signedAtText = '';
    if (entry.signedAt) {
      try {
        signedAtText = `Signed ${format(new Date(entry.signedAt), 'PP')}`;
      } catch (_) {
        signedAtText = '';
      }
    }
    return (
      <div data-testid={testId}>
        <Label className="text-xs text-muted-foreground">{entry.label}</Label>
        <div className="mt-1 inline-block rounded-md border bg-white p-2">
          <img
            src={entry.dataUrl}
            alt={`${entry.label} preview`}
            className="block max-h-20 w-auto max-w-full h-auto"
          />
        </div>
        {(entry.typedName || signedAtText) && (
          <p className="text-xs text-muted-foreground mt-1">
            {entry.typedName}
            {entry.typedName && signedAtText ? ' · ' : ''}
            {signedAtText}
          </p>
        )}
      </div>
    );
  }
  return (
    <div data-testid={testId}>
      <Label className="text-xs text-muted-foreground">{entry.label}</Label>
      <p className="text-sm mt-0.5 whitespace-pre-wrap">{entry.text}</p>
    </div>
  );
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
  const [editWriterType, setEditWriterType] = useState("member");

  const [csProvider, setCsProvider] = useState({ first_name: "", last_name: "", email: "" });
  const [csSelectedFormId, setCsSelectedFormId] = useState("");
  const [csEmailContent, setCsEmailContent] = useState("");
  const [csEmailTemplateId, setCsEmailTemplateId] = useState("");
  const [csFormInitialized, setCsFormInitialized] = useState(false);

  const [copyrightSelectedFormId, setCopyrightSelectedFormId] = useState("");
  const [copyrightEmailTemplateId, setCopyrightEmailTemplateId] = useState("");
  const [copyrightFormInitialized, setCopyrightFormInitialized] = useState(false);
  const [copyrightConfirmOpen, setCopyrightConfirmOpen] = useState(false);
  const [copyrightDisableConfirmOpen, setCopyrightDisableConfirmOpen] = useState(false);
  const [versionToDelete, setVersionToDelete] = useState(null);
  const [caseStudyUploadToDelete, setCaseStudyUploadToDelete] = useState(null);

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
      return allForms.filter((f) => f.is_active && !f.is_contract && !f.require_authentication && !!f.slug);
    },
    enabled: isAccessReady,
  });

  const { data: availableEmailTemplates = [] } = useQuery({
    queryKey: ["email-templates"],
    queryFn: async () => {
      return await base44.entities.EmailTemplate.list({ filter: { is_active: true } });
    },
    enabled: isAccessReady,
  });

  const caseStudySubmissionId = brief?.case_study_submission_id;
  const caseStudyFormId = brief?.case_study_form_id;
  const copyrightSubmissionId = brief?.copyright_submission_id;
  const copyrightFormId = brief?.copyright_form_id;

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

  const { data: copyrightSubmission } = useQuery({
    queryKey: ["brief-copyright-submission", copyrightSubmissionId],
    queryFn: async () => {
      if (!copyrightSubmissionId) return null;
      return await base44.entities.FormSubmission.get(copyrightSubmissionId);
    },
    enabled: isAccessReady && !!copyrightSubmissionId,
  });

  const { data: copyrightForm } = useQuery({
    queryKey: ["brief-copyright-form", copyrightFormId],
    queryFn: async () => {
      if (!copyrightFormId) return null;
      return await base44.entities.Form.get(copyrightFormId);
    },
    enabled: isAccessReady && !!copyrightFormId,
  });

  const { data: caseStudyUploads = [], isLoading: caseStudyUploadsLoading } = useQuery({
    queryKey: ["case-study-uploads", briefId],
    queryFn: async () => {
      return await apiRequest("GET", `/api/article-briefs/${briefId}/case-study-uploads`);
    },
    enabled: isAccessReady && !!briefId,
  });

  const [csUploadProgress, setCsUploadProgress] = useState(0);
  const [csUploadingFile, setCsUploadingFile] = useState(false);
  const [csUploadSelectedFile, setCsUploadSelectedFile] = useState(null);
  const [csUploadNote, setCsUploadNote] = useState("");
  const csUploadInputRef = useRef(null);

  const csUploadMutation = useMutation({
    mutationFn: async ({ file, note }) => {
      setCsUploadingFile(true);
      setCsUploadProgress(0);
      try {
        const result = await uploadFileWithProgress(file, {
          type: UPLOAD_TYPES.ATTACHMENT,
          entityId: briefId,
          onProgress: setCsUploadProgress,
        });
        return await apiRequest("POST", `/api/article-briefs/${briefId}/case-study-uploads`, {
          file_url: result.file_url,
          storage_path: result.storage_path,
          file_name: result.file_name,
          file_size: result.file_size,
          mime_type: result.mime_type,
          note: note || null,
        });
      } finally {
        setCsUploadingFile(false);
        setCsUploadProgress(0);
      }
    },
    onSuccess: () => {
      toast.success("File uploaded");
      setCsUploadSelectedFile(null);
      setCsUploadNote("");
      queryClient.invalidateQueries({ queryKey: ["case-study-uploads", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-activity", briefId] });
    },
    onError: (err) => {
      showUploadErrorToast(err, "Upload failed");
    },
  });

  const csDeleteUploadMutation = useMutation({
    mutationFn: async (uploadId) => {
      return await apiRequest("DELETE", `/api/article-briefs/${briefId}/case-study-uploads/${uploadId}`);
    },
    onSuccess: () => {
      toast.success("Upload deleted");
      queryClient.invalidateQueries({ queryKey: ["case-study-uploads", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-activity", briefId] });
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to delete upload");
    },
  });

  const deleteVersionMutation = useMutation({
    mutationFn: async (versionId) => {
      return await apiRequest("DELETE", `/api/article-briefs/${briefId}/versions/${versionId}`);
    },
    onSuccess: () => {
      toast.success("Version deleted");
      queryClient.invalidateQueries({ queryKey: ["article-brief-versions", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-versions-all"] });
      queryClient.invalidateQueries({ queryKey: ["article-brief-activity", briefId] });
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to delete version");
    },
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

  const { data: externalWriter } = useQuery({
    queryKey: ["external-writer-detail", brief?.external_writer_id],
    queryFn: async () => {
      if (!brief?.external_writer_id) return null;
      return await base44.entities.ExternalWriter.get(brief.external_writer_id);
    },
    enabled: isAccessReady && !!brief?.external_writer_id,
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
    mutationFn: async ({ form_id, provider, email_content, email_template_id }) => {
      return await apiRequest("POST", `/api/article-briefs/${briefId}/send-case-study-form`, {
        form_id,
        provider,
        email_content,
        email_template_id: email_template_id || null,
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

  const setCopyrightRequiredMutation = useMutation({
    mutationFn: async ({ required, clearLink }) => {
      const payload = { copyright_required: !!required };
      // Only clear the form / sent_at / submission link when the editor is
      // explicitly turning the requirement off. Toggling required back on must
      // never clear an existing submission, so we never write null fields when
      // required=true. A received submission is only cleared when the editor
      // confirms via the dialog (clearLink=true).
      if (!required && clearLink) {
        payload.copyright_form_id = null;
        payload.copyright_form_sent_at = null;
        payload.copyright_submission_id = null;
      }
      return await base44.entities.ArticleBrief.update(briefId, payload);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["article-brief", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      if (!variables.required && variables.clearLink) {
        setCopyrightSelectedFormId("");
      }
      setCopyrightDisableConfirmOpen(false);
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update copyright requirement");
    },
  });

  const handleCopyrightRequiredToggle = (next) => {
    if (next) {
      // Turning ON never clears an existing submission.
      setCopyrightRequiredMutation.mutate({ required: true, clearLink: false });
      return;
    }
    // Turning OFF: if a submission has already been received, ask the editor
    // to confirm before unlinking it.
    if (brief?.copyright_submission_id) {
      setCopyrightDisableConfirmOpen(true);
      return;
    }
    setCopyrightRequiredMutation.mutate({ required: false, clearLink: true });
  };

  const setCaseStudyRequiredMutation = useMutation({
    mutationFn: async (required) => {
      return await base44.entities.ArticleBrief.update(briefId, {
        case_study_required: !!required,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-brief", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update case study requirement");
    },
  });

  const sendCopyrightFormMutation = useMutation({
    mutationFn: async ({ copyright_form_id, email_template_id }) => {
      return await apiRequest("POST", `/api/article-briefs/${briefId}/send-copyright-form`, {
        copyright_form_id,
        email_template_id: email_template_id || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["article-brief", briefId] });
      queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
      setCopyrightConfirmOpen(false);
      toast.success("Copyright Assignment form link sent to writer");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to send copyright form link");
    },
  });

  useEffect(() => {
    setCsFormInitialized(false);
    setCopyrightFormInitialized(false);
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
      setCsEmailTemplateId(brief.case_study_email_template_id || "");
      setCsFormInitialized(true);
    }
  }, [brief, csFormInitialized]);

  useEffect(() => {
    if (brief && !copyrightFormInitialized) {
      setCopyrightSelectedFormId(brief.copyright_form_id || "");
      setCopyrightEmailTemplateId(brief.copyright_email_template_id || "");
      setCopyrightFormInitialized(true);
    }
  }, [brief, copyrightFormInitialized]);

  useEffect(() => {
    if (brief && brief.case_study_required === false && activeTab === "case-study") {
      setActiveTab("overview");
    }
  }, [brief, activeTab]);

  const handleStartEdit = () => {
    const existingAttachments = Array.isArray(brief.attachments) ? brief.attachments : [];
    setEditData({
      title: brief.title || "",
      contributor_type: brief.contributor_type || "gfi",
      deadline: brief.deadline ? brief.deadline.split("T")[0] : "",
      writer_deadline: brief.writer_deadline ? brief.writer_deadline.split("T")[0] : "",
      editor_deadline: brief.editor_deadline ? brief.editor_deadline.split("T")[0] : "",
      sla: brief.sla || "2026-2028",
      contract: brief.contract || "Prospects",
      category: brief.category || "",
      notes: brief.notes || "",
      assigned_writer_id: brief.assigned_writer_id || "",
      external_writer_id: brief.external_writer_id || "",
      review_owner_id: brief.review_owner_id || "",
      attachments: existingAttachments,
    });
    setEditWriterType(brief.external_writer_id ? "external" : "member");
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
      showUploadErrorToast(err, "Failed to upload attachment");
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
    const isExternal = editWriterType === "external";
    const writerId = !isExternal && editData.assigned_writer_id && editData.assigned_writer_id !== "unassigned" ? editData.assigned_writer_id : null;
    const externalWriterId = isExternal && editData.external_writer_id && editData.external_writer_id !== "unassigned" ? editData.external_writer_id : null;
    const reviewerId = editData.review_owner_id && editData.review_owner_id !== "unassigned" ? editData.review_owner_id : null;
    const payload = {
      title: editData.title.trim(),
      contributor_type: editData.contributor_type || null,
      deadline: editData.deadline || null,
      writer_deadline: editData.writer_deadline || null,
      editor_deadline: editData.editor_deadline || null,
      sla: editData.sla || null,
      contract: editData.contract || null,
      category: editData.category.trim() || null,
      notes: editData.notes.trim() || null,
      assigned_writer_id: writerId,
      external_writer_id: externalWriterId,
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
        storage_path: uploadResult.storage_path,
        file_size: uploadResult.file_size,
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
      showUploadErrorToast(err, "Failed to upload version");
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
                Upload
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
            {brief?.case_study_required && (
              <TabsTrigger value="case-study" data-testid="tab-case-study">Case Study</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            {isEditing ? (
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="edit-title">Title</Label>
                    <Input id="edit-title" value={editData.title} onChange={(e) => setEditData((p) => ({ ...p, title: e.target.value }))} data-testid="input-edit-title" />
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
                          <div className="flex gap-1 mb-1">
                            <Button
                              type="button"
                              variant={editWriterType === "member" ? "default" : "outline"}
                              size="sm"
                              onClick={() => {
                                setEditWriterType("member");
                                setEditData((p) => ({ ...p, assigned_writer_id: "", external_writer_id: "" }));
                              }}
                              data-testid="button-edit-writer-type-member"
                            >
                              Member
                            </Button>
                            <Button
                              type="button"
                              variant={editWriterType === "external" ? "default" : "outline"}
                              size="sm"
                              onClick={() => {
                                setEditWriterType("external");
                                setEditData((p) => ({ ...p, assigned_writer_id: "", external_writer_id: "" }));
                              }}
                              data-testid="button-edit-writer-type-external"
                            >
                              External
                            </Button>
                          </div>
                          {editWriterType === "member" ? (
                            <MemberCombobox
                              value={editData.assigned_writer_id || "unassigned"}
                              onValueChange={(v) => setEditData((p) => ({ ...p, assigned_writer_id: v }))}
                              placeholder="Search writer..."
                              testId="combobox-edit-writer"
                              initialMember={brief?.assigned_writer_id ? membersById[brief.assigned_writer_id] : null}
                            />
                          ) : (
                            <ExternalWriterCombobox
                              value={editData.external_writer_id || "unassigned"}
                              onValueChange={(v) => setEditData((p) => ({ ...p, external_writer_id: v }))}
                              placeholder="Search external writer..."
                              testId="combobox-edit-external-writer"
                              initialWriter={brief?.external_writer_id && externalWriter ? externalWriter : null}
                            />
                          )}
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
              <Card>
                <CardHeader><CardTitle className="text-lg">Overview</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Contributor Type</Label>
                      <p className="text-sm mt-1" data-testid="text-brief-contributor-type">
                        {brief.contributor_type ? (brief.contributor_type === 'gfi' ? 'GFI' : brief.contributor_type.charAt(0).toUpperCase() + brief.contributor_type.slice(1)) : "--"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Category</Label>
                      <p className="text-sm mt-1" data-testid="text-brief-category">{brief.category || "--"}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">SLA</Label>
                      <p className="text-sm mt-1" data-testid="text-sla">{brief.sla || "--"}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Contract</Label>
                      <p className="text-sm mt-1" data-testid="text-contract">{brief.contract || "--"}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Writer</Label>
                      <p className="text-sm font-medium mt-1" data-testid="text-writer">
                        {brief.external_writer_id
                          ? (externalWriter
                            ? [externalWriter.first_name, externalWriter.last_name].filter(Boolean).join(" ") || externalWriter.email
                            : "Loading...")
                          : brief.assigned_writer_id
                            ? getMemberName(brief.assigned_writer_id)
                            : "--"}
                        {brief.external_writer_id && (
                          <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0 no-default-hover-elevate no-default-active-elevate">Ext</Badge>
                        )}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Editor</Label>
                      <p className="text-sm font-medium mt-1" data-testid="text-reviewer">
                        {brief.review_owner_id ? getMemberName(brief.review_owner_id) : "--"}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Submission Deadline</Label>
                      <p className="text-sm mt-1" data-testid="text-deadline">
                        {brief.deadline ? format(new Date(brief.deadline), "MMM d, yyyy") : "--"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Writer Deadline</Label>
                      <p className="text-sm mt-1" data-testid="text-writer-deadline">
                        {brief.writer_deadline ? format(new Date(brief.writer_deadline), "MMM d, yyyy") : "--"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Editor Deadline</Label>
                      <p className="text-sm mt-1" data-testid="text-editor-deadline">
                        {brief.editor_deadline ? format(new Date(brief.editor_deadline), "MMM d, yyyy") : "--"}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Created By</Label>
                      <p className="text-sm mt-1" data-testid="text-creator">{brief.created_by ? getMemberName(brief.created_by) : "--"}</p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Created</Label>
                      <p className="text-sm mt-1" data-testid="text-created-date">
                        {brief.created_at ? format(new Date(brief.created_at), "MMM d, yyyy 'at' h:mm a") : "--"}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Versions</Label>
                      <p className="text-sm mt-1" data-testid="text-version-count">{versions.length} draft{versions.length !== 1 ? "s" : ""} uploaded</p>
                    </div>
                  </div>
                  {brief.instructions && (
                    <div>
                      <Label className="text-xs text-muted-foreground">Instructions</Label>
                      <div className="text-sm mt-1 prose prose-sm max-w-none" data-testid="text-brief-instructions" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(brief.instructions) }} />
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
                </CardContent>
              </Card>
            )}

            {!isEditing && (() => {
              const isWriterAssigned = !!brief.assigned_writer_id || !!brief.external_writer_id;
              const writerName = brief.external_writer_id
                ? (externalWriter
                  ? [externalWriter.first_name, externalWriter.last_name].filter(Boolean).join(" ").trim() || externalWriter.email
                  : "External writer")
                : (brief.assigned_writer_id ? getMemberName(brief.assigned_writer_id) : "");
              const writerEmail = brief.external_writer_id
                ? externalWriter?.email || ""
                : (brief.assigned_writer_id ? membersById[brief.assigned_writer_id]?.email || "" : "");
              const required = !!brief.copyright_required;
              const sentAt = brief.copyright_form_sent_at;
              const hasCopyrightSubmitted = !!brief.copyright_submission_id && !!copyrightSubmission;

              const formatSent = (ts) => { try { return format(new Date(ts), "MMM d, yyyy"); } catch { return ts; } };

              let disabledReason = null;
              if (!isWriterAssigned) disabledReason = "Assign a writer to this brief first";
              else if (!writerEmail) disabledReason = "The assigned writer has no email on file";
              else if (!copyrightSelectedFormId) disabledReason = "Select a Copyright Assignment form";

              const renderCopyrightSubmissionData = () => {
                if (!hasCopyrightSubmitted) return null;
                const submission = copyrightSubmission;
                const formMeta = copyrightForm;
                const { imageEntries, docEntries, fieldEntries } = processSubmissionData(
                  submission?.submission_data || {},
                  formMeta?.fields || []
                );
                return (
                  <div className="space-y-3 mt-3" data-testid="section-copyright-submission">
                    {fieldEntries.length > 0 && (
                      <div className="rounded-md border p-3">
                        <Label className="text-xs text-muted-foreground">Submitted Answers</Label>
                        <div className="grid sm:grid-cols-2 gap-3 mt-2">
                          {fieldEntries.map((entry, i) => (
                            <SubmittedFieldEntry
                              key={i}
                              entry={entry}
                              testId={`text-copyright-field-${i}`}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {(imageEntries.length > 0 || docEntries.length > 0) && (
                      <div className="rounded-md border p-3 space-y-2">
                        {imageEntries.length > 0 && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                            {imageEntries.map((img, i) => (
                              <a key={i} href={img.url} target="_blank" rel="noopener noreferrer" className="block rounded-md overflow-visible border hover-elevate" data-testid={`link-copyright-image-${i}`}>
                                <img src={img.url} alt={img.name} className="w-full h-24 object-cover rounded-md" />
                                <p className="text-xs text-muted-foreground p-1 truncate">{img.name}</p>
                              </a>
                            ))}
                          </div>
                        )}
                        {docEntries.length > 0 && (
                          <div className="space-y-2">
                            {docEntries.map((doc, i) => (
                              <a key={i} href={doc.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm hover-elevate p-2 rounded-md border" data-testid={`link-copyright-doc-${i}`}>
                                <ExternalLink className="w-4 h-4 text-muted-foreground" />
                                <span>{doc.name}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              };

              const caseStudyRequired = !!brief.case_study_required;

              return (
                <>
                <Card className="mt-4" data-testid="card-brief-case-study-toggle">
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <BookOpen className="w-5 h-5" />
                        Case Study
                      </CardTitle>
                      {canManage && (
                        <div className="flex items-center gap-2">
                          <Label htmlFor="toggle-case-study-required" className="text-sm">Case study</Label>
                          <Switch
                            id="toggle-case-study-required"
                            checked={caseStudyRequired}
                            disabled={setCaseStudyRequiredMutation.isPending}
                            onCheckedChange={(v) => setCaseStudyRequiredMutation.mutate(!!v)}
                            data-testid="switch-case-study-required"
                          />
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground" data-testid="text-case-study-toggle-help">
                      {caseStudyRequired
                        ? "Case study is enabled for this brief — manage it on the Case Study tab."
                        : "Case study is not required for this brief."}
                    </p>
                  </CardContent>
                </Card>
                <Card className="mt-4" data-testid="card-brief-copyright">
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5" />
                        Copyright Assignment
                      </CardTitle>
                      {canManage && (
                        <div className="flex items-center gap-2">
                          <Label htmlFor="toggle-copyright-required" className="text-sm">Copyright form required</Label>
                          <Switch
                            id="toggle-copyright-required"
                            checked={required}
                            disabled={setCopyrightRequiredMutation.isPending}
                            onCheckedChange={(v) => handleCopyrightRequiredToggle(!!v)}
                            data-testid="switch-copyright-required"
                          />
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  {required ? (
                    <CardContent className="space-y-4">
                      <div className="grid sm:grid-cols-2 gap-4">
                        <div>
                          <Label className="text-xs text-muted-foreground">Writer</Label>
                          <p className="text-sm mt-0.5" data-testid="text-copyright-writer-name">{writerName || "—"}</p>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Writer Email</Label>
                          <p className="text-sm mt-0.5" data-testid="text-copyright-writer-email">{writerEmail || "—"}</p>
                        </div>
                      </div>
                      {canManage && (
                        <div className="grid sm:grid-cols-2 gap-4">
                          <div className="space-y-1">
                            <Label>Copyright Assignment Form</Label>
                            <Select
                              value={copyrightSelectedFormId || "none"}
                              onValueChange={(v) => setCopyrightSelectedFormId(v === "none" ? "" : v)}
                            >
                              <SelectTrigger data-testid="select-copyright-form"><SelectValue placeholder="Select a form..." /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Select a form...</SelectItem>
                                {availableForms.map((f) => (
                                  <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Email Template</Label>
                            <Select
                              value={copyrightEmailTemplateId || "none"}
                              onValueChange={(v) => setCopyrightEmailTemplateId(v === "none" ? "" : v)}
                            >
                              <SelectTrigger data-testid="select-copyright-email-template">
                                <SelectValue placeholder="Use default message" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Use default message</SelectItem>
                                {availableEmailTemplates.map((t) => (
                                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              {copyrightEmailTemplateId
                                ? "The selected template's subject and body will be used. The form link is added automatically."
                                : "Pick a template to override the default message."}
                            </p>
                          </div>
                        </div>
                      )}
                      {!canManage && copyrightForm?.name && (
                        <div>
                          <Label className="text-xs text-muted-foreground">Form</Label>
                          <p className="text-sm mt-0.5" data-testid="text-copyright-form-name">{copyrightForm.name}</p>
                        </div>
                      )}
                      <Separator />
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-[140px]">
                          <Label className="text-xs text-muted-foreground">Status</Label>
                          <div className="mt-1">
                            <Badge
                              variant={hasCopyrightSubmitted ? "default" : "secondary"}
                              data-testid="badge-copyright-status"
                            >
                              {hasCopyrightSubmitted && <CheckCircle className="w-3 h-3 mr-1" />}
                              {!hasCopyrightSubmitted && sentAt && <Clock className="w-3 h-3 mr-1" />}
                              {hasCopyrightSubmitted
                                ? `Submitted on ${formatSent(copyrightSubmission?.created_at || sentAt)}`
                                : sentAt
                                  ? `Sent on ${formatSent(sentAt)}`
                                  : "Not sent"}
                            </Badge>
                          </div>
                        </div>
                        {canManage && (
                          <div className="ml-auto flex flex-col items-end gap-1">
                            <Button
                              onClick={() => setCopyrightConfirmOpen(true)}
                              disabled={!!disabledReason || sendCopyrightFormMutation.isPending}
                              data-testid="button-send-copyright-form"
                            >
                              {sendCopyrightFormMutation.isPending ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              ) : (
                                <Send className="w-4 h-4 mr-1" />
                              )}
                              {sentAt ? "Resend to writer" : "Send to writer"}
                            </Button>
                            {disabledReason && (
                              <p className="text-xs text-muted-foreground" data-testid="text-copyright-disabled-reason">{disabledReason}</p>
                            )}
                          </div>
                        )}
                      </div>
                      {renderCopyrightSubmissionData()}
                    </CardContent>
                  ) : (
                    <CardContent>
                      <p className="text-sm text-muted-foreground" data-testid="text-copyright-not-required">
                        Copyright Assignment form is not required for this brief.
                      </p>
                    </CardContent>
                  )}
                </Card>
                </>
              );
            })()}
          </TabsContent>

          <TabsContent value="versions" className="mt-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-lg">Versions</CardTitle>
                  {canUploadDraft && (isWriter || canManage) && (
                    <Button size="sm" onClick={() => setUploadDialogOpen(true)} data-testid="button-upload-version-tab">
                      <Upload className="w-4 h-4 mr-1" />
                      Upload
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
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setVersionToDelete(version)}
                            disabled={deleteVersionMutation.isPending}
                            title="Delete version"
                            data-testid={`button-delete-version-${version.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
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

          {brief?.case_study_required && (
          <TabsContent value="case-study" className="mt-4">
            {(() => {
              const canEditCaseStudy = isWriter || canManage;
              const hasFormSubmission = !!brief.case_study_submission_id && !!caseStudySubmission;
              const hasFormSent = !!brief.case_study_form_sent_at;
              const hasLegacyContent = brief.case_study_content || (Array.isArray(brief.case_study_images) && brief.case_study_images.length > 0) || brief.case_study_permissions;
              const provider = brief.case_study_provider;

              const renderSubmissionDataFor = (submission, formMeta) => {
                if (!submission?.submission_data) return null;
                const { imageEntries, docEntries, fieldEntries } = processSubmissionData(
                  submission.submission_data,
                  formMeta?.fields || []
                );

                return (
                  <div className="space-y-4">
                    {fieldEntries.length > 0 && (
                      <Card>
                        <CardHeader><CardTitle className="text-lg flex items-center gap-2"><BookOpen className="w-5 h-5" />Submitted Answers</CardTitle></CardHeader>
                        <CardContent>
                          <div className="grid sm:grid-cols-2 gap-4">
                            {fieldEntries.map((entry, i) => (
                              <SubmittedFieldEntry
                                key={i}
                                entry={entry}
                                testId={`text-submission-field-${i}`}
                              />
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

              const formatSentOn = (ts) => {
                try { return format(new Date(ts), "MMM d, yyyy"); } catch { return ts; }
              };

              const renderFormStatusRow = ({ rowLabel, formName, sentAt, hasSubmission, testIdSuffix }) => {
                let statusText = "Not sent";
                let statusColor = "secondary";
                if (hasSubmission) {
                  statusText = "Submitted";
                  statusColor = "default";
                } else if (sentAt) {
                  statusText = `Sent on ${formatSentOn(sentAt)}`;
                  statusColor = "secondary";
                }
                return (
                  <div className="flex flex-wrap items-center gap-3 py-2" data-testid={`row-cs-form-${testIdSuffix}`}>
                    <div className="min-w-[140px]">
                      <Label className="text-xs text-muted-foreground">{rowLabel}</Label>
                      <p className="text-sm mt-0.5" data-testid={`text-cs-form-name-${testIdSuffix}`}>{formName || "—"}</p>
                    </div>
                    <Badge variant={statusColor} data-testid={`badge-cs-status-${testIdSuffix}`}>
                      {hasSubmission && <CheckCircle className="w-3 h-3 mr-1" />}
                      {!hasSubmission && sentAt && <Clock className="w-3 h-3 mr-1" />}
                      {statusText}
                    </Badge>
                  </div>
                );
              };

              const renderProviderStatus = () => {
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
                      </div>
                      <Separator className="my-3" />
                      <div className="space-y-1">
                        {renderFormStatusRow({
                          rowLabel: "Permission",
                          formName: caseStudyForm?.name,
                          sentAt: brief.case_study_form_sent_at,
                          hasSubmission: hasFormSubmission,
                          testIdSuffix: "permission",
                        })}
                      </div>
                    </CardContent>
                  </Card>
                );
              };

              const handleCaseStudyFileSelect = (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setCsUploadSelectedFile(file);
                if (e.target) e.target.value = "";
              };

              const handleCaseStudyUploadSubmit = () => {
                if (!csUploadSelectedFile) {
                  toast.error("Please choose a file first");
                  return;
                }
                csUploadMutation.mutate({ file: csUploadSelectedFile, note: csUploadNote.trim() });
              };

              const formatBytes = (bytes) => {
                if (bytes === null || bytes === undefined || bytes === "") return "";
                const n = Number(bytes);
                if (!Number.isFinite(n) || n < 0) return "";
                if (n < 1024) return `${n} B`;
                if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
                return `${(n / (1024 * 1024)).toFixed(1)} MB`;
              };

              const renderCaseStudyUploads = () => {
                const sorted = [...(caseStudyUploads || [])].sort((a, b) => (b.version_number || 0) - (a.version_number || 0));
                return (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg flex items-center gap-2">
                        <FileUp className="w-5 h-5" />
                        Case Study Uploads
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {canEditCaseStudy && (
                        <div className="space-y-2 p-3 border rounded-md">
                          <div className="flex items-center gap-2 flex-wrap">
                            <input
                              ref={csUploadInputRef}
                              type="file"
                              className="hidden"
                              onChange={handleCaseStudyFileSelect}
                              data-testid="input-case-study-upload-file"
                            />
                            <Button
                              variant="outline"
                              onClick={() => csUploadInputRef.current?.click()}
                              disabled={csUploadingFile || csUploadMutation.isPending}
                              data-testid="button-case-study-upload-choose"
                            >
                              <FileUp className="w-4 h-4" />
                              {csUploadSelectedFile ? "Change file" : "Choose file"}
                            </Button>
                            {csUploadSelectedFile && (
                              <span className="text-sm text-muted-foreground truncate" data-testid="text-case-study-upload-selected-name">
                                {csUploadSelectedFile.name} ({formatBytes(csUploadSelectedFile.size)})
                              </span>
                            )}
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="case-study-upload-note" className="text-xs text-muted-foreground">Note (optional)</Label>
                            <Input
                              id="case-study-upload-note"
                              value={csUploadNote}
                              onChange={(e) => setCsUploadNote(e.target.value)}
                              placeholder="Add a short note about this upload"
                              maxLength={500}
                              disabled={csUploadingFile || csUploadMutation.isPending}
                              data-testid="input-case-study-upload-note"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="default"
                              onClick={handleCaseStudyUploadSubmit}
                              disabled={!csUploadSelectedFile || csUploadingFile || csUploadMutation.isPending}
                              data-testid="button-case-study-upload-submit"
                            >
                              <Upload className="w-4 h-4" />
                              {csUploadingFile ? "Uploading..." : "Upload"}
                            </Button>
                          </div>
                          {csUploadingFile && (
                            <div className="space-y-1" data-testid="progress-case-study-upload">
                              <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>Uploading...</span>
                                <span>{csUploadProgress}%</span>
                              </div>
                              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                                <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${csUploadProgress}%` }} />
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {caseStudyUploadsLoading ? (
                        <p className="text-sm text-muted-foreground" data-testid="text-case-study-uploads-loading">Loading uploads...</p>
                      ) : sorted.length === 0 ? (
                        <p className="text-sm text-muted-foreground" data-testid="text-case-study-uploads-empty">No case study files uploaded yet.</p>
                      ) : (
                        <div className="space-y-2" data-testid="list-case-study-uploads">
                          {sorted.map((u) => {
                            const uploaderLabel = u.source === "provider"
                              ? `Provider — ${u.uploaded_by_provider_name || "Unknown"}`
                              : (u.uploader ? `${u.uploader.first_name || ""} ${u.uploader.last_name || ""}`.trim() || u.uploader.email : "Team");
                            return (
                              <div
                                key={u.id}
                                className="flex items-start gap-3 p-3 border rounded-md"
                                data-testid={`row-case-study-upload-${u.id}`}
                              >
                                <div className="flex-shrink-0 pt-0.5">
                                  {u.mime_type && u.mime_type.startsWith("image/") ? (
                                    <ImagePlus className="w-5 h-5 text-muted-foreground" />
                                  ) : (
                                    <FileUp className="w-5 h-5 text-muted-foreground" />
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Badge variant="outline" data-testid={`text-case-study-upload-version-${u.id}`}>v{u.version_number}</Badge>
                                    <Badge variant={u.source === "provider" ? "secondary" : "outline"} data-testid={`text-case-study-upload-source-${u.id}`}>
                                      {u.source === "provider" ? "Provider" : "Team"}
                                    </Badge>
                                    <a
                                      href={u.file_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-sm font-medium truncate hover:underline"
                                      data-testid={`link-case-study-upload-file-${u.id}`}
                                    >
                                      {u.file_name || "Untitled"}
                                    </a>
                                  </div>
                                  <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-2" data-testid={`text-case-study-upload-meta-${u.id}`}>
                                    <span data-testid={`text-case-study-upload-uploader-${u.id}`}>{uploaderLabel}</span>
                                    {u.file_size ? <span data-testid={`text-case-study-upload-size-${u.id}`}>· {formatBytes(u.file_size)}</span> : null}
                                    {u.upload_date ? <span data-testid={`text-case-study-upload-date-${u.id}`}>· {(() => { try { return format(new Date(u.upload_date), "MMM d, yyyy h:mm a"); } catch { return ""; } })()}</span> : null}
                                  </div>
                                  {u.note && (
                                    <div className="text-xs text-muted-foreground mt-1 italic whitespace-pre-wrap" data-testid={`text-case-study-upload-note-${u.id}`}>
                                      {u.note}
                                    </div>
                                  )}
                                </div>
                                {canManage && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => setCaseStudyUploadToDelete(u)}
                                    disabled={csDeleteUploadMutation.isPending}
                                    data-testid={`button-case-study-upload-delete-${u.id}`}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              };

              const renderAllSubmissions = () => {
                if (hasFormSubmission) {
                  return renderSubmissionDataFor(caseStudySubmission, caseStudyForm);
                }
                return null;
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
                    {renderCaseStudyUploads()}
                    {renderAllSubmissions()}
                  </div>
                );
              }

              if (hasFormSent && !canEditCaseStudy) {
                return (
                  <div className="space-y-4">
                    {renderProviderStatus()}
                    {renderCaseStudyUploads()}
                    {hasCopyrightSubmission && renderAllSubmissions()}
                    {hasLegacyContent && renderLegacyContent()}
                  </div>
                );
              }

              if (!canEditCaseStudy) {
                if (hasLegacyContent) {
                  return (
                    <div className="space-y-4">
                      {renderCaseStudyUploads()}
                      {renderLegacyContent()}
                    </div>
                  );
                }
                return (
                  <div className="space-y-4">
                    {renderCaseStudyUploads()}
                    <Card>
                      <CardContent className="pt-6">
                        <div className="text-center py-12" data-testid="text-no-case-study">
                          <BookOpen className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
                          <p className="text-sm text-muted-foreground">No case study has been created yet.</p>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                );
              }

              const handleSendCaseStudyForm = () => {
                if (!csProvider.first_name.trim() || !csProvider.last_name.trim() || !csProvider.email.trim()) {
                  toast.error("Please fill in the provider's first name, last name, and email");
                  return;
                }
                if (!csSelectedFormId) {
                  toast.error("Please select a Permission Form to send");
                  return;
                }
                if (!csEmailTemplateId && !csEmailContent.trim()) {
                  toast.error("Please choose an email template or write an email message");
                  return;
                }
                sendCaseStudyFormMutation.mutate({
                  form_id: csSelectedFormId,
                  provider: csProvider,
                  email_content: csEmailContent,
                  email_template_id: csEmailTemplateId,
                });
              };

              const sendButtonLabel = hasFormSent ? "Resend Form Link" : "Send Form Link";

              return (
                <div className="space-y-4">
                  {hasFormSent && renderProviderStatus()}
                  {renderCaseStudyUploads()}

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
                        <Label>Permission Form *</Label>
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
                        <Label>Email Template</Label>
                        <Select value={csEmailTemplateId || "none"} onValueChange={(v) => setCsEmailTemplateId(v === "none" ? "" : v)}>
                          <SelectTrigger data-testid="select-cs-email-template">
                            <SelectValue placeholder="Use the message below" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Use the message below</SelectItem>
                            {availableEmailTemplates.map((t) => (
                              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {csEmailTemplateId
                            ? "The selected template's subject and body will be used. The form and upload links are added automatically."
                            : "Pick a template to use its subject and body, or write a one-off message below."}
                        </p>
                      </div>
                      {!csEmailTemplateId && (
                        <div className="space-y-1">
                          <Label htmlFor="cs-email-body">Email Message *</Label>
                          <SimpleRichTextEditor
                            content={csEmailContent}
                            onChange={setCsEmailContent}
                            placeholder="Write the email message to send along with the form link..."
                            className=""
                          />
                        </div>
                      )}
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
                          {sendButtonLabel}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  {hasLegacyContent && renderLegacyContent()}
                </div>
              );
            })()}
          </TabsContent>
          )}
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
            <DialogTitle>Upload</DialogTitle>
            <DialogDescription>Upload a new version of your article.</DialogDescription>
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

      <AlertDialog open={copyrightConfirmOpen} onOpenChange={setCopyrightConfirmOpen}>
        <AlertDialogContent data-testid="dialog-confirm-copyright-send">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {brief?.copyright_form_sent_at ? "Resend Copyright Assignment form?" : "Send Copyright Assignment form?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const writerEmail = brief?.external_writer_id
                  ? externalWriter?.email || ""
                  : (brief?.assigned_writer_id ? membersById[brief.assigned_writer_id]?.email || "" : "");
                const formName = (availableForms.find((f) => f.id === copyrightSelectedFormId) || {}).name || copyrightForm?.name || "the selected form";
                return `A unique link to "${formName}" will be emailed to the writer at ${writerEmail || "their email"}.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-copyright-send">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!copyrightSelectedFormId) return;
                sendCopyrightFormMutation.mutate({
                  copyright_form_id: copyrightSelectedFormId,
                  email_template_id: copyrightEmailTemplateId,
                });
              }}
              disabled={sendCopyrightFormMutation.isPending || !copyrightSelectedFormId}
              data-testid="button-confirm-copyright-send"
            >
              {sendCopyrightFormMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {brief?.copyright_form_sent_at ? "Resend" : "Send"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={copyrightDisableConfirmOpen} onOpenChange={setCopyrightDisableConfirmOpen}>
        <AlertDialogContent data-testid="dialog-confirm-copyright-disable">
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off copyright requirement?</AlertDialogTitle>
            <AlertDialogDescription>
              A Copyright Assignment form has already been received for this brief.
              Turning the requirement off will unlink the received submission from this brief
              and clear the selected form and sent date. This does not delete the submission record itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-copyright-disable">Keep submission</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setCopyrightRequiredMutation.mutate({ required: false, clearLink: true });
              }}
              disabled={setCopyrightRequiredMutation.isPending}
              data-testid="button-confirm-copyright-disable"
            >
              {setCopyrightRequiredMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Unlink and turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      <AlertDialog open={!!versionToDelete} onOpenChange={(open) => !open && setVersionToDelete(null)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-version">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete Version {versionToDelete?.version_number}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this draft version. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-version">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!versionToDelete) return;
                deleteVersionMutation.mutate(versionToDelete.id, {
                  onSuccess: () => setVersionToDelete(null),
                });
              }}
              disabled={deleteVersionMutation.isPending}
              data-testid="button-confirm-delete-version"
            >
              {deleteVersionMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!caseStudyUploadToDelete} onOpenChange={(open) => !open && setCaseStudyUploadToDelete(null)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-case-study-upload">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this upload?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete case study upload v{caseStudyUploadToDelete?.version_number}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-case-study-upload">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!caseStudyUploadToDelete) return;
                csDeleteUploadMutation.mutate(caseStudyUploadToDelete.id, {
                  onSuccess: () => setCaseStudyUploadToDelete(null),
                });
              }}
              disabled={csDeleteUploadMutation.isPending}
              data-testid="button-confirm-delete-case-study-upload"
            >
              {csDeleteUploadMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
