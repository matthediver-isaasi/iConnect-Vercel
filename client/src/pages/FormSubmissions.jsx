import React, { useState, useMemo, useEffect } from "react";
import { Link, useSearchParams, useLocation } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, FileText, Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, Trash2, RotateCcw, Mail, TrendingUp, TrendingDown, Minus, BarChart3, CheckCircle, AlertCircle, Clock, Download, FileDown } from "lucide-react";
import moment from "moment";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { downloadSubmissionsDocx, resolveAwardType, sanitizeFileName } from "@/lib/formSubmissionWordExport";

const ALLOWED_PAGE_SIZES = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;

export default function FormSubmissionsPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  const [searchQuery, setSearchQuery] = useState(() => searchParams.get('q') || "");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FormSubmissions')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [selectedForm, setSelectedForm] = useState(() => searchParams.get('form') || "all");
  const [selectedStatus, setSelectedStatus] = useState(() => searchParams.get('status') || "all");
  const [dateFrom, setDateFrom] = useState(() => searchParams.get('dateFrom') || "");
  const [dateTo, setDateTo] = useState(() => searchParams.get('dateTo') || "");
  const [currentPage, setCurrentPage] = useState(() => {
    const p = parseInt(searchParams.get('page'), 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  });
  const [itemsPerPage, setItemsPerPage] = useState(() => {
    const s = parseInt(searchParams.get('size'), 10);
    return ALLOWED_PAGE_SIZES.includes(s) ? s : DEFAULT_PAGE_SIZE;
  });

  const filterQueryString = useMemo(() => {
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (selectedForm !== 'all') params.set('form', selectedForm);
    if (selectedStatus !== 'all') params.set('status', selectedStatus);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (currentPage !== 1) params.set('page', String(currentPage));
    if (itemsPerPage !== DEFAULT_PAGE_SIZE) params.set('size', String(itemsPerPage));
    const str = params.toString();
    return str ? `?${str}` : '';
  }, [searchQuery, selectedForm, selectedStatus, dateFrom, dateTo, currentPage, itemsPerPage]);

  useEffect(() => {
    setSearchParams(filterQueryString ? filterQueryString.slice(1) : '', { replace: true });
  }, [filterQueryString, setSearchParams]);
  const [viewingSubmission, setViewingSubmission] = useState(null);
  const [submissionToDelete, setSubmissionToDelete] = useState(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState('csv');
  const [selectedExportFields, setSelectedExportFields] = useState([]);
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState(() => new Set());
  const [isExportingWord, setIsExportingWord] = useState(false);
  const [exportProgress, setExportProgress] = useState(null);
  const tenantBranding = useTenantBranding();

  const queryClient = useQueryClient();

  const { data: submissions = [], isLoading: submissionsLoading } = useQuery({
    queryKey: ['form-submissions'],
    queryFn: async () => {
      const allSubmissions = await base44.entities.FormSubmission.listAll();
      return allSubmissions.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    }
  });

  const { data: forms = [] } = useQuery({
    queryKey: ['forms'],
    queryFn: async () => {
      return await base44.entities.Form.list();
    }
  });

  const formsById = useMemo(() => {
    const map = {};
    forms.forEach(f => { map[f.id] = f; });
    return map;
  }, [forms]);

  // Used by CSV export to resolve organisation_dropdown UUIDs to names.
  const { data: organisationsForExport = [] } = useQuery({
    queryKey: ['organizations-for-form-submissions-export'],
    queryFn: async () => await base44.entities.Organization.listAll(),
    staleTime: 5 * 60 * 1000,
  });

  const organisationNamesById = useMemo(() => {
    const map = {};
    organisationsForExport.forEach(org => {
      if (org && org.id) map[org.id] = org.name || '';
    });
    return map;
  }, [organisationsForExport]);

  // Used by CSV export to resolve communication_preferences category IDs to names.
  const { data: communicationCategoriesForExport = [] } = useQuery({
    queryKey: ['communication-categories-for-form-submissions-export'],
    queryFn: async () => {
      try {
        return await base44.entities.CommunicationCategory.list();
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const communicationCategoryNamesById = useMemo(() => {
    const map = {};
    communicationCategoriesForExport.forEach(cat => {
      if (cat && cat.id) map[cat.id] = cat.name || '';
    });
    return map;
  }, [communicationCategoriesForExport]);

  // Used by CSV export to resolve custom_field option values to their labels.
  const { data: customFieldsForExport = [] } = useQuery({
    queryKey: ['preference-fields-for-form-submissions-export'],
    queryFn: async () => {
      try {
        return await base44.entities.PreferenceField.list();
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const customFieldDefById = useMemo(() => {
    const map = {};
    customFieldsForExport.forEach(cf => {
      if (cf && cf.id) map[cf.id] = cf;
    });
    return map;
  }, [customFieldsForExport]);

  // Used by CSV export to resolve member ID dropdowns to readable names.
  const { data: membersForExport = [] } = useQuery({
    queryKey: ['members-for-form-submissions-export'],
    queryFn: async () => {
      try {
        return await base44.entities.Member.listAll();
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const memberNamesById = useMemo(() => {
    const map = {};
    membersForExport.forEach(m => {
      if (!m || !m.id) return;
      const name = (m.full_name || `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email || '').trim();
      map[m.id] = name;
    });
    return map;
  }, [membersForExport]);

  // Used by CSV export to resolve role ID dropdowns to readable names.
  const { data: rolesForExport = [] } = useQuery({
    queryKey: ['roles-for-form-submissions-export'],
    queryFn: async () => {
      try {
        return await base44.entities.Role.list();
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const roleNamesById = useMemo(() => {
    const map = {};
    rolesForExport.forEach(r => {
      if (r && r.id) map[r.id] = r.name || r.label || '';
    });
    return map;
  }, [rolesForExport]);

  // Used by CSV export to resolve ResourceCategory IDs to names (for any field
  // that stores a category ID rather than the subcategory label).
  const { data: resourceCategoriesForExport = [] } = useQuery({
    queryKey: ['resource-categories-for-form-submissions-export'],
    queryFn: async () => {
      try {
        return await base44.entities.ResourceCategory.list();
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const resourceCategoryNamesById = useMemo(() => {
    const map = {};
    resourceCategoriesForExport.forEach(c => {
      if (c && c.id) map[c.id] = c.name || '';
    });
    return map;
  }, [resourceCategoriesForExport]);

  const resolveFormName = (submission) => {
    return submission.form_name || formsById[submission.form_id]?.name || 'Unknown Form';
  };

  const { data: viewingForm } = useQuery({
    queryKey: ['form-detail', viewingSubmission?.form_id],
    queryFn: async () => {
      if (!viewingSubmission?.form_id) return null;
      return forms.find(f => f.id === viewingSubmission.form_id);
    },
    enabled: !!viewingSubmission?.form_id,
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }) => {
      return await base44.entities.FormSubmission.update(id, {
        status,
        status_updated_by: memberInfo?.email,
        status_updated_at: new Date().toISOString()
      });
    },
    onSuccess: (updatedSubmission) => {
      queryClient.invalidateQueries({ queryKey: ['form-submissions'] });
      setViewingSubmission(updatedSubmission);
      toast.success('Status updated');
    },
    onError: () => {
      toast.error('Failed to update status');
    }
  });

  const deleteSubmissionMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.FormSubmission.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['form-submissions'] });
      setSubmissionToDelete(null);
      toast.success('Submission deleted');
    },
    onError: () => {
      toast.error('Failed to delete submission');
    }
  });

  const rerunSubmissionMutation = useMutation({
    mutationFn: async (submission) => {
      const form = forms.find(f => f.id === submission.form_id);
      if (!form) {
        throw new Error('Form not found');
      }
      
      const response = await fetch('/api/forms/process-application', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_id: form.id,
          form_values: submission.submission_data,
          fields: form.fields,
          field_mappings: form.field_mappings || [],
          application_level: form.application_level || 'member',
          submission_id: submission.id,
          prefill_organization_id: submission.created_organization_id || null,
          role_id: form.default_member_role_id || null,
          entity_pipelines: form.entity_pipelines || { members: [], organisations: [] },
          member_entity_action: form.member_entity_action || 'none',
          organization_entity_action: form.organization_entity_action || 'none',
          additional_member_creations: form.additional_member_creations || [],
          tenant_id: form.tenant_id
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to re-run submission');
      }
      
      const result = await response.json();

      try {
        console.log('[FormSubmissions] Sending submission email after re-run...');
        const emailResponse = await fetch('/api/forms/send-submission-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            form_id: form.id,
            submission_id: submission.id,
            form_values: submission.submission_data,
            fields: form.fields,
            created_member_id: result.created_member_id || null,
            created_organization_id: result.created_organization_id || null,
            _debug_form_email_config: {
              hasSubmissionEmails: !!form?.submission_emails,
              submissionEmailsCount: form?.submission_emails?.length || 0,
              submissionEmailsValue: form?.submission_emails || null,
              legacyTemplateId: form?.submission_email_template_id || null,
              legacyRecipient: form?.submission_email_recipient || null
            }
          })
        });
        console.log('[FormSubmissions] Email response status:', emailResponse.status);
        if (emailResponse.ok) {
          const emailResult = await emailResponse.json();
          console.log('[FormSubmissions] Submission email result:', emailResult);
        } else {
          const errorText = await emailResponse.text();
          console.error('[FormSubmissions] Email endpoint error:', emailResponse.status, errorText.substring(0, 500));
        }
      } catch (emailError) {
        console.error('[FormSubmissions] Error sending submission email:', emailError);
      }

      return result;
    },
    onSuccess: (result) => {
      toast.success('Submission re-processed successfully');
      console.log('[FormSubmissions] Re-run result:', result);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to re-run submission');
      console.error('[FormSubmissions] Re-run error:', error);
    }
  });

  const filteredSubmissions = useMemo(() => {
    let filtered = submissions;

    if (selectedForm !== "all") {
      filtered = filtered.filter(s => s.form_id === selectedForm);
    }

    if (selectedStatus !== "all") {
      filtered = filtered.filter(s => (s.status || 'new') === selectedStatus);
    }

    if (dateFrom) {
      const fromDate = moment(dateFrom).startOf('day');
      filtered = filtered.filter(s => moment(s.created_date).isSameOrAfter(fromDate));
    }

    if (dateTo) {
      const toDate = moment(dateTo).endOf('day');
      filtered = filtered.filter(s => moment(s.created_date).isSameOrBefore(toDate));
    }

    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter(s => 
        resolveFormName(s).toLowerCase().includes(searchLower) ||
        s.submitted_by_email?.toLowerCase().includes(searchLower) ||
        s.submitted_by_name?.toLowerCase().includes(searchLower) ||
        JSON.stringify(s.submission_data).toLowerCase().includes(searchLower)
      );
    }

    return filtered;
  }, [submissions, selectedForm, selectedStatus, dateFrom, dateTo, searchQuery, formsById]);

  const totalPages = Math.ceil(filteredSubmissions.length / itemsPerPage);
  const paginatedSubmissions = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredSubmissions.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredSubmissions, currentPage, itemsPerPage]);

  const statusCounts = useMemo(() => {
    const counts = { new: 0, junk: 0, actioned: 0, total: submissions.length };
    submissions.forEach(s => {
      const status = s.status || 'new';
      if (counts.hasOwnProperty(status)) {
        counts[status]++;
      }
    });
    return counts;
  }, [submissions]);

  const formCounts = useMemo(() => {
    const counts = {};
    submissions.forEach(s => {
      const formName = resolveFormName(s);
      counts[formName] = (counts[formName] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [submissions, formsById]);

  const timeAnalytics = useMemo(() => {
    const now = moment();
    const getCountInRange = (startDate, endDate) => {
      return submissions.filter(s => {
        const date = moment(s.created_date);
        return date.isBetween(startDate, endDate, null, '[]');
      }).length;
    };

    const periods = [
      { label: 'Last 7 Days', days: 7 },
      { label: 'Last 30 Days', days: 30 },
      { label: 'Last 90 Days', days: 90 },
      { label: 'Last Year', days: 365 }
    ];

    return periods.map(period => {
      const currentStart = moment().subtract(period.days, 'days');
      const currentEnd = moment();
      const previousStart = moment().subtract(period.days * 2, 'days');
      const previousEnd = moment().subtract(period.days, 'days');

      const currentCount = getCountInRange(currentStart, currentEnd);
      const previousCount = getCountInRange(previousStart, previousEnd);

      let percentChange = 0;
      if (previousCount > 0) {
        percentChange = ((currentCount - previousCount) / previousCount) * 100;
      } else if (currentCount > 0) {
        percentChange = 100;
      }

      return {
        label: period.label,
        current: currentCount,
        previous: previousCount,
        percentChange: Math.round(percentChange),
        trend: currentCount > previousCount ? 'up' : currentCount < previousCount ? 'down' : 'same'
      };
    });
  }, [submissions]);

  const startIndex = filteredSubmissions.length > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0;
  const endIndex = Math.min(currentPage * itemsPerPage, filteredSubmissions.length);

  const getStatusBadge = (status) => {
    const statusValue = status || 'new';
    switch (statusValue) {
      case 'new':
        return <Badge className="bg-blue-100 text-blue-700">New</Badge>;
      case 'junk':
        return <Badge className="bg-slate-100 text-slate-700">Junk</Badge>;
      case 'actioned':
        return <Badge className="bg-green-100 text-green-700">Actioned</Badge>;
      default:
        return <Badge variant="secondary">{statusValue}</Badge>;
    }
  };

  const handleStatusChange = (submissionId, newStatus) => {
    updateStatusMutation.mutate({ id: submissionId, status: newStatus });
  };

  const getFieldLabel = (fieldId) => {
    if (!viewingForm?.fields) return fieldId;
    const field = viewingForm.fields.find(f => f.id === fieldId);
    return field?.label || fieldId;
  };

  const getSubmitterEmail = (submission) => {
    if (submission.submitted_by_email) {
      return submission.submitted_by_email;
    }
    if (submission.submission_data) {
      const data = submission.submission_data;
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && value.includes('@') && value.includes('.')) {
          const keyLower = key.toLowerCase();
          if (keyLower.includes('email') || keyLower.includes('e-mail')) {
            return value;
          }
        }
      }
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          return value;
        }
      }
    }
    return null;
  };

  const METADATA_FIELDS = [
    { key: '__form_name', label: 'Form Name' },
    { key: '__submitter_name', label: 'Submitter Name' },
    { key: '__submitter_email', label: 'Submitter Email' },
    { key: '__status', label: 'Status' },
    { key: '__submission_date', label: 'Submission Date' },
  ];

  const exportFieldOptions = useMemo(() => {
    if (selectedForm !== 'all') {
      const form = formsById[selectedForm];
      const fields = Array.isArray(form?.fields) ? form.fields : [];
      const dynamicFields = fields
        .filter(f => f && f.id)
        .map(f => ({ key: f.id, label: f.label || f.id }));
      return [...METADATA_FIELDS, ...dynamicFields];
    }
    const dynamicFieldKeys = new Map();
    filteredSubmissions.forEach(submission => {
      if (!submission.submission_data) return;
      const form = formsById[submission.form_id];
      Object.keys(submission.submission_data).forEach(key => {
        if (dynamicFieldKeys.has(key)) return;
        let label = key;
        if (form?.fields) {
          const field = form.fields.find(f => f.id === key);
          if (field?.label) label = field.label;
        }
        dynamicFieldKeys.set(key, label);
      });
    });
    const dynamicFields = Array.from(dynamicFieldKeys.entries()).map(([key, label]) => ({
      key,
      label,
    }));
    return [...METADATA_FIELDS, ...dynamicFields];
  }, [filteredSubmissions, formsById, selectedForm]);

  const handleOpenExportModal = (format = 'csv') => {
    setExportFormat(format);
    setSelectedExportFields(exportFieldOptions.map(f => f.key));
    setExportModalOpen(true);
  };

  const toggleSubmissionSelected = (id) => {
    setSelectedSubmissionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const buildExportResolvers = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';

    const resolveOrgName = (orgId) => {
      if (orgId == null || orgId === '') return '';
      const id = String(orgId);
      return organisationNamesById[id] || id;
    };
    const resolveMemberName = (memberId) => {
      if (memberId == null || memberId === '') return '';
      const id = String(memberId);
      return memberNamesById[id] || id;
    };
    const resolveRoleName = (roleId) => {
      if (roleId == null || roleId === '') return '';
      const id = String(roleId);
      return roleNamesById[id] || id;
    };
    const resolveResourceCategoryLabel = (raw) => {
      if (raw == null || raw === '') return '';
      const key = String(raw);
      return resourceCategoryNamesById[key] || key;
    };
    const resolveCommunicationPreferences = (val) => {
      if (val == null || typeof val !== 'object' || Array.isArray(val)) {
        return val == null ? '' : String(val);
      }
      return Object.entries(val)
        .filter(([, isSubscribed]) => isSubscribed === true)
        .map(([categoryId]) => communicationCategoryNamesById[categoryId] || categoryId)
        .join(', ');
    };
    const resolveImageButtonLabel = (val, fieldDef) => {
      if (val == null || val === '') return '';
      const options = Array.isArray(fieldDef?.image_options) ? fieldDef.image_options : [];
      const match = options.find(opt => opt && opt.value === val);
      return match?.label || String(val);
    };
    const resolveCustomFieldValue = (val, fieldDef) => {
      if (val == null || val === '') return '';
      const customFieldId = fieldDef?.custom_field_id;
      const customDef = customFieldId ? customFieldDefById[customFieldId] : null;
      const options = Array.isArray(customDef?.options) ? customDef.options : [];
      const lookupLabel = (raw) => {
        if (raw == null || raw === '') return '';
        const match = options.find(opt => {
          if (!opt) return false;
          const optValue = opt.value != null ? opt.value : opt.label;
          return optValue === raw;
        });
        return match?.label || String(raw);
      };
      if (Array.isArray(val)) return val.map(lookupLabel).filter(Boolean).join(', ');
      if (typeof val === 'boolean') return val ? 'Yes' : 'No';
      if (options.length === 0) return String(val);
      return lookupLabel(val);
    };
    const resolveFile = (raw) => {
      if (raw == null || raw === '') return null;
      let parsed = raw;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { parsed = JSON.parse(trimmed); } catch { parsed = trimmed; }
        } else {
          return { name: trimmed.split('/').pop() || 'file', url: trimmed };
        }
      }
      if (Array.isArray(parsed)) {
        // Should not reach here — caller flattens arrays
        return null;
      }
      if (parsed && typeof parsed === 'object') {
        const name = parsed.file_name || parsed.name || (parsed.storage_path ? String(parsed.storage_path).split('/').pop() : 'file');
        if (parsed.bucket && parsed.storage_path) {
          return { name, url: `${origin}/api/storage/secure-url?bucket=${encodeURIComponent(parsed.bucket)}&path=${encodeURIComponent(parsed.storage_path)}&redirect=true` };
        }
        if (parsed.file_url) return { name, url: String(parsed.file_url) };
        return { name, url: null };
      }
      return null;
    };
    return {
      resolveFormName,
      getSubmitterEmail,
      resolveOrgName,
      resolveMemberName,
      resolveRoleName,
      resolveResourceCategoryLabel,
      resolveCommunicationPreferences,
      resolveImageButtonLabel,
      resolveCustomFieldValue,
      resolveFile,
    };
  };

  const buildAvailableFieldOptionsForSubmission = (submission) => {
    const form = formsById[submission.form_id];
    const dynamicEntries = Object.keys(submission.submission_data || {}).map(key => {
      const field = form?.fields?.find(f => f.id === key);
      return { key, label: field?.label || key };
    });
    return [...METADATA_FIELDS, ...dynamicEntries];
  };

  const SERVER_EXPORT_THRESHOLD = 100;

  const runServerWordExport = async ({ subs, options, fileName, documentTitle, scope }) => {
    // Create the background job. The server returns 202 with a jobId, then a
    // worker invocation (kicked off via fire-and-forget plus a cron backstop)
    // renders the document and uploads the .docx to private storage so the
    // total elapsed time isn't bounded by the per-request platform timeout.
    const createRes = await fetch('/api/admin/form-submission-export-jobs', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submissionIds: subs.map(s => s.id),
        selectedOptions: options,
        scope: scope || 'all',
        documentTitle,
        fileName,
      }),
    });
    if (!createRes.ok) {
      let msg = 'Failed to start Word export';
      try { const j = await createRes.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const { jobId } = await createRes.json();
    if (!jobId) throw new Error('Export job did not return an id');

    setExportProgress({ processed: 0, total: subs.length, phase: 'queued' });

    // Poll job status until complete or error.
    const POLL_INTERVAL_MS = 1500;
    const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes safety ceiling
    const startedAt = Date.now();
    let lastStatus = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        throw new Error('Export timed out — please try a smaller batch or retry later');
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const statusRes = await fetch(`/api/admin/form-submission-export-jobs/${encodeURIComponent(jobId)}`, {
        credentials: 'include',
      });
      if (!statusRes.ok) {
        // Transient errors shouldn't kill the poll; abort only on 4xx.
        if (statusRes.status >= 400 && statusRes.status < 500) {
          let msg = 'Failed to check export status';
          try { const j = await statusRes.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
          throw new Error(msg);
        }
        continue;
      }
      lastStatus = await statusRes.json();
      setExportProgress({
        processed: Number(lastStatus.processed) || 0,
        total: Number(lastStatus.total) || subs.length,
        phase: lastStatus.phase || lastStatus.status || 'processing',
      });
      if (lastStatus.status === 'complete') break;
      if (lastStatus.status === 'error') {
        throw new Error(lastStatus.error || 'Export job failed');
      }
    }

    if (!lastStatus?.downloadUrl) {
      throw new Error('Export completed but the download link is unavailable');
    }

    // Trigger the browser download from the signed Supabase URL.
    const link = document.createElement('a');
    link.href = lastStatus.downloadUrl;
    link.download = lastStatus.fileName || fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const runWordExport = async ({ subs, options, fileName, documentTitle, scope }) => {
    if (!subs || subs.length === 0) {
      toast.error('No submissions to export');
      return;
    }
    setIsExportingWord(true);
    setExportProgress(null);
    try {
      if (subs.length > SERVER_EXPORT_THRESHOLD) {
        await runServerWordExport({ subs, options, fileName, documentTitle, scope });
      } else {
        await downloadSubmissionsDocx({
          submissions: subs,
          formsById,
          selectedOptions: options,
          resolvers: buildExportResolvers(),
          tenantName: tenantBranding?.branding?.name || '',
          tenantLogoUrl: tenantBranding?.branding?.logoUrl || '',
          documentTitle,
          fileName,
        });
      }
      toast.success(`Exported ${subs.length} ${subs.length === 1 ? 'submission' : 'submissions'} to Word`);
    } catch (err) {
      console.error('[WordExport] Error:', err);
      toast.error(err?.message || 'Failed to generate Word document');
    } finally {
      setIsExportingWord(false);
      setExportProgress(null);
    }
  };

  const handleExportWord = async (scope) => {
    const selectedOptions = exportFieldOptions.filter(f => selectedExportFields.includes(f.key));
    if (selectedOptions.length === 0) return;

    let subs = filteredSubmissions;
    if (selectedSubmissionIds.size > 0) {
      subs = filteredSubmissions.filter(s => selectedSubmissionIds.has(s.id));
    }

    const baseDate = moment().format('YYYY-MM-DD');
    const year = moment().format('YYYY');
    const formNameRaw = selectedForm !== 'all' ? formsById[selectedForm]?.name : null;
    const formNameSafe = sanitizeFileName(formNameRaw || 'Form_Submissions');

    if (scope === 'team' || scope === 'individual') {
      const wantTeam = scope === 'team';
      const filtered = subs.filter(s => {
        const t = resolveAwardType(s, formsById[s.form_id]);
        return wantTeam ? t === 'team' : t === 'individual';
      });
      if (filtered.length === 0) {
        toast.error(`No ${wantTeam ? 'team' : 'individual'} award submissions in the current set`);
        return;
      }
      const fileName = `${wantTeam ? 'Team' : 'Individual'}_Award_Submissions_${year}.docx`;
      const documentTitle = `${wantTeam ? 'Team' : 'Individual'} Award Submissions`;
      await runWordExport({ subs: filtered, options: selectedOptions, fileName, documentTitle, scope });
      setExportModalOpen(false);
      return;
    }

    const fileName = `${formNameSafe}_Submissions_${baseDate}.docx`;
    const documentTitle = formNameRaw ? `${formNameRaw} — Submissions` : 'Form Submissions';
    await runWordExport({ subs, options: selectedOptions, fileName, documentTitle, scope: 'all' });
    setExportModalOpen(false);
  };

  const handleDownloadSingleWord = async (submission) => {
    const options = buildAvailableFieldOptionsForSubmission(submission);
    const applicant = submission.submitted_by_name || submission.submission_data?.applicant_name || submission.id;
    const fileName = `Award_Submission_${sanitizeFileName(applicant) || `submission-${submission.id}`}.docx`;
    const documentTitle = `Award Submission — ${applicant}`;
    await runWordExport({ subs: [submission], options, fileName, documentTitle });
  };

  const awardTypeCountsInSelection = useMemo(() => {
    const subs = selectedSubmissionIds.size > 0
      ? filteredSubmissions.filter(s => selectedSubmissionIds.has(s.id))
      : filteredSubmissions;
    let team = 0, individual = 0;
    subs.forEach(s => {
      const t = resolveAwardType(s, formsById[s.form_id]);
      if (t === 'team') team++;
      else if (t === 'individual') individual++;
    });
    return { team, individual };
  }, [filteredSubmissions, selectedSubmissionIds, formsById]);

  const handleToggleExportField = (fieldKey) => {
    setSelectedExportFields(prev =>
      prev.includes(fieldKey) ? prev.filter(k => k !== fieldKey) : [...prev, fieldKey]
    );
  };

  const handleSelectAllFields = () => {
    setSelectedExportFields(exportFieldOptions.map(f => f.key));
  };

  const handleDeselectAllFields = () => {
    setSelectedExportFields([]);
  };

  const handleExportCSV = () => {
    if (filteredSubmissions.length === 0 || selectedExportFields.length === 0) return;

    const selectedOptions = exportFieldOptions.filter(f => selectedExportFields.includes(f.key));
    const headers = selectedOptions.map(f => f.label);

    const origin = typeof window !== 'undefined' ? window.location.origin : '';

    const resolveOrgName = (orgId) => {
      if (orgId == null || orgId === '') return '';
      const id = String(orgId);
      return organisationNamesById[id] || id;
    };

    const resolveMemberName = (memberId) => {
      if (memberId == null || memberId === '') return '';
      const id = String(memberId);
      return memberNamesById[id] || id;
    };

    const resolveRoleName = (roleId) => {
      if (roleId == null || roleId === '') return '';
      const id = String(roleId);
      return roleNamesById[id] || id;
    };

    const resolveResourceCategoryLabel = (raw) => {
      if (raw == null || raw === '') return '';
      const key = String(raw);
      // Field stores either a category UUID or the (already-readable) subcategory
      // label string. Look up by ID first; fall through to the raw value when no
      // match is found so existing label-based storage remains untouched.
      return resourceCategoryNamesById[key] || key;
    };

    const resolveCommunicationPreferences = (val) => {
      if (val == null || typeof val !== 'object' || Array.isArray(val)) {
        return val == null ? '' : String(val);
      }
      const subscribedNames = Object.entries(val)
        .filter(([, isSubscribed]) => isSubscribed === true)
        .map(([categoryId]) => communicationCategoryNamesById[categoryId] || categoryId);
      return subscribedNames.join(', ');
    };

    const resolveImageButtonLabel = (val, fieldDef) => {
      if (val == null || val === '') return '';
      const options = Array.isArray(fieldDef?.image_options) ? fieldDef.image_options : [];
      const match = options.find(opt => opt && opt.value === val);
      return match?.label || String(val);
    };

    const resolveCustomFieldValue = (val, fieldDef) => {
      if (val == null || val === '') return '';
      const customFieldId = fieldDef?.custom_field_id;
      const customDef = customFieldId ? customFieldDefById[customFieldId] : null;
      const options = Array.isArray(customDef?.options) ? customDef.options : [];
      const lookupLabel = (raw) => {
        if (raw == null || raw === '') return '';
        const match = options.find(opt => {
          if (!opt) return false;
          const optValue = opt.value != null ? opt.value : opt.label;
          return optValue === raw;
        });
        return match?.label || String(raw);
      };
      if (Array.isArray(val)) {
        return val.map(lookupLabel).filter(Boolean).join(', ');
      }
      if (typeof val === 'boolean') return val ? 'Yes' : 'No';
      // For non-option-based custom fields (text, date, etc.), options will be empty so we
      // fall through to returning the raw value.
      if (options.length === 0) return String(val);
      return lookupLabel(val);
    };

    const buildFileUrl = (raw) => {
      if (raw == null || raw === '') return '';
      let parsed = raw;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { parsed = JSON.parse(trimmed); } catch { parsed = trimmed; }
        } else {
          // Legacy plain-string value: just a URL.
          return trimmed;
        }
      }
      if (Array.isArray(parsed)) {
        return parsed.map(item => buildFileUrl(item)).filter(Boolean).join(', ');
      }
      if (parsed && typeof parsed === 'object') {
        const bucket = parsed.bucket;
        const storagePath = parsed.storage_path;
        if (bucket && storagePath) {
          return `${origin}/api/storage/secure-url?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(storagePath)}&redirect=true`;
        }
        if (parsed.file_url) return String(parsed.file_url);
        return '';
      }
      return '';
    };

    const rows = filteredSubmissions.map(submission => {
      const form = formsById[submission.form_id];
      const fieldDefsById = {};
      (form?.fields || []).forEach(f => { if (f && f.id) fieldDefsById[f.id] = f; });

      return selectedOptions.map(field => {
        switch (field.key) {
          case '__form_name':
            return resolveFormName(submission);
          case '__submitter_name':
            return submission.submitted_by_name || '';
          case '__submitter_email':
            return getSubmitterEmail(submission) || '';
          case '__status':
            return (submission.status || 'new').charAt(0).toUpperCase() + (submission.status || 'new').slice(1);
          case '__submission_date':
            return moment(submission.created_date).format('YYYY-MM-DD HH:mm');
          default: {
            const val = submission.submission_data?.[field.key];
            if (val == null) return '';
            const fieldDef = fieldDefsById[field.key];
            const fieldType = fieldDef?.type;

            if (fieldType === 'organisation_dropdown') {
              if (Array.isArray(val)) return val.map(resolveOrgName).join(', ');
              return resolveOrgName(val);
            }

            if (fieldType === 'member_dropdown') {
              if (Array.isArray(val)) return val.map(resolveMemberName).join(', ');
              return resolveMemberName(val);
            }

            if (fieldType === 'role_dropdown') {
              if (Array.isArray(val)) return val.map(resolveRoleName).join(', ');
              return resolveRoleName(val);
            }

            if (fieldType === 'category_dropdown' || fieldType === 'category_multiselect') {
              if (Array.isArray(val)) return val.map(resolveResourceCategoryLabel).join(', ');
              return resolveResourceCategoryLabel(val);
            }

            if (fieldType === 'communication_preferences') {
              return resolveCommunicationPreferences(val);
            }

            if (fieldType === 'image_buttons') {
              if (Array.isArray(val)) {
                return val.map(v => resolveImageButtonLabel(v, fieldDef)).join(', ');
              }
              return resolveImageButtonLabel(val, fieldDef);
            }

            if (fieldType === 'custom_field') {
              return resolveCustomFieldValue(val, fieldDef);
            }

            if (fieldType === 'file') {
              if (Array.isArray(val)) {
                return val.map(buildFileUrl).filter(Boolean).join(', ');
              }
              return buildFileUrl(val);
            }

            if (Array.isArray(val)) return val.join(', ');
            return String(val);
          }
        }
      });
    });

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;

    let fileNameParts = ['form_submissions'];
    if (selectedForm !== 'all') {
      const formName = formsById[selectedForm]?.name?.replace(/[^a-zA-Z0-9]/g, '_') || 'form';
      fileNameParts.push(formName);
    }
    if (dateFrom || dateTo) {
      fileNameParts.push(dateFrom || 'start');
      fileNameParts.push(dateTo || 'end');
    } else {
      fileNameParts.push(moment().format('YYYY-MM-DD'));
    }
    link.download = `${fileNameParts.join('_')}.csv`;

    link.click();
    URL.revokeObjectURL(url);
    setExportModalOpen(false);
    toast.success(`Exported ${filteredSubmissions.length} submissions`);
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  if (submissionsLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <FileText className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
              Form Submissions
            </h1>
          </div>
          <p className="text-slate-600">
            {filteredSubmissions.length} {filteredSubmissions.length === 1 ? 'submission' : 'submissions'}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <Card className="border-slate-200" data-testid="card-total-submissions">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <FileText className="w-4 h-4" />
                All Submissions
              </CardDescription>
              <CardTitle className="text-3xl">{statusCounts.total}</CardTitle>
            </CardHeader>
          </Card>
          <Card className="border-slate-200" data-testid="card-new-submissions">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-blue-500" />
                New
              </CardDescription>
              <CardTitle className="text-3xl text-blue-600">{statusCounts.new}</CardTitle>
            </CardHeader>
          </Card>
          <Card className="border-slate-200" data-testid="card-actioned-submissions">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                Actioned
              </CardDescription>
              <CardTitle className="text-3xl text-green-600">{statusCounts.actioned}</CardTitle>
            </CardHeader>
          </Card>
          <Card className="border-slate-200" data-testid="card-junk-submissions">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-slate-500" />
                Junk
              </CardDescription>
              <CardTitle className="text-3xl text-slate-600">{statusCounts.junk}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card className="mb-6 border-slate-200" data-testid="card-time-analytics">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-blue-600" />
              Submission Trends
            </CardTitle>
            <CardDescription>Comparing current period vs previous period</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {timeAnalytics.map((period, idx) => (
                <div key={idx} className="bg-slate-50 rounded-lg p-4 border border-slate-100" data-testid={`analytics-period-${idx}`}>
                  <p className="text-sm text-slate-600 mb-1">{period.label}</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-slate-900">{period.current}</span>
                    <span className="text-xs text-slate-500">vs {period.previous}</span>
                  </div>
                  <div className={`flex items-center gap-1 mt-1 text-sm ${
                    period.trend === 'up' ? 'text-green-600' : 
                    period.trend === 'down' ? 'text-red-600' : 'text-slate-500'
                  }`}>
                    {period.trend === 'up' && <TrendingUp className="w-4 h-4" />}
                    {period.trend === 'down' && <TrendingDown className="w-4 h-4" />}
                    {period.trend === 'same' && <Minus className="w-4 h-4" />}
                    <span>
                      {period.trend === 'same' ? 'No change' : 
                        `${period.percentChange > 0 ? '+' : ''}${period.percentChange}%`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {formCounts.length > 0 && (
          <Card className="mb-6 border-slate-200" data-testid="card-top-forms">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Top Forms</CardTitle>
              <CardDescription>Forms with the most submissions</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {formCounts.map(([formName, count], idx) => (
                  <Badge 
                    key={idx} 
                    variant="secondary" 
                    className="text-sm py-1 px-3"
                    data-testid={`badge-top-form-${idx}`}
                  >
                    {formName}: {count}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="mb-6 border-slate-200">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search submissions..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="pl-10"
                  data-testid="input-search-submissions"
                />
              </div>
              <Select value={selectedForm} onValueChange={(val) => {
                setSelectedForm(val);
                setCurrentPage(1);
              }}>
                <SelectTrigger className="w-full md:w-[200px]" data-testid="select-form-filter">
                  <SelectValue placeholder="All Forms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Forms</SelectItem>
                  {forms.map(form => (
                    <SelectItem key={form.id} value={form.id}>
                      {form.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedStatus} onValueChange={(val) => {
                setSelectedStatus(val);
                setCurrentPage(1);
              }}>
                <SelectTrigger className="w-full md:w-[150px]" data-testid="select-status-filter">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="junk">Junk</SelectItem>
                  <SelectItem value="actioned">Actioned</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Label className="text-sm text-slate-500 whitespace-nowrap">From</Label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); setCurrentPage(1); }}
                  className="w-[150px]"
                  data-testid="input-date-from"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm text-slate-500 whitespace-nowrap">To</Label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); setCurrentPage(1); }}
                  className="w-[150px]"
                  data-testid="input-date-to"
                />
              </div>
              {(dateFrom || dateTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setDateFrom(""); setDateTo(""); setCurrentPage(1); }}
                  data-testid="button-clear-dates"
                >
                  Clear dates
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => handleOpenExportModal('csv')}
                disabled={selectedForm === "all" || filteredSubmissions.length === 0}
                data-testid="button-export-csv"
              >
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => handleOpenExportModal('word')}
                disabled={filteredSubmissions.length === 0}
                data-testid="button-export-word"
              >
                <FileDown className="w-4 h-4 mr-2" />
                Export Word
              </Button>
            </div>
          </CardContent>
        </Card>

        {paginatedSubmissions.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No submissions found</h3>
              <p className="text-slate-600">
                {searchQuery || selectedForm !== "all" || selectedStatus !== "all" || dateFrom || dateTo ? 'Try adjusting your filters' : 'No form submissions yet'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="space-y-4">
              {paginatedSubmissions.map(submission => {
                const form = forms.find(f => f.id === submission.form_id);
                const isDueDiligenceForm = form?.due_diligence_required === true;
                
                return (
                <Card key={submission.id} className="border-slate-200 hover:shadow-lg transition-shadow">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="pt-1">
                        <Checkbox
                          checked={selectedSubmissionIds.has(submission.id)}
                          onCheckedChange={() => toggleSubmissionSelected(submission.id)}
                          data-testid={`checkbox-select-submission-${submission.id}`}
                          aria-label="Select submission for export"
                        />
                      </div>
                      <div className="flex-1">
                        <CardTitle className="text-base mb-2">{resolveFormName(submission)}</CardTitle>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          {getStatusBadge(submission.status)}
                          {submission.submitted_by_name && (
                            <Badge variant="secondary">
                              {submission.submitted_by_name}
                            </Badge>
                          )}
                          {getSubmitterEmail(submission) && (
                            <span className="flex items-center gap-1 text-slate-600">
                              <Mail className="w-3.5 h-3.5" />
                              {getSubmitterEmail(submission)}
                            </span>
                          )}
                          <Badge variant="outline" className="text-slate-600">
                            {moment(submission.created_date).format('MMM D, YYYY h:mm A')}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => rerunSubmissionMutation.mutate(submission)}
                          disabled={rerunSubmissionMutation.isPending}
                          data-testid={`button-rerun-submission-${submission.id}`}
                          title="Re-run submission processing"
                        >
                          {rerunSubmissionMutation.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RotateCcw className="w-4 h-4" />
                          )}
                        </Button>
                        <Link to={`/FormSubmission/${submission.id}?back=${encodeURIComponent(`${location.pathname}${filterQueryString}`)}`}>
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`button-view-submission-${submission.id}`}
                          >
                            <Eye className="w-4 h-4 mr-1" />
                            View Full
                          </Button>
                        </Link>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownloadSingleWord(submission)}
                          disabled={isExportingWord}
                          data-testid={`button-download-word-${submission.id}`}
                          title="Download as Word document"
                        >
                          {isExportingWord ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSubmissionToDelete(submission)}
                          disabled={isDueDiligenceForm}
                          className={isDueDiligenceForm 
                            ? "text-slate-400 cursor-not-allowed" 
                            : "text-red-600 hover:text-red-700 hover:bg-red-50"}
                          data-testid={`button-delete-submission-${submission.id}`}
                          title={isDueDiligenceForm 
                            ? "Due diligence submissions must be deleted from the Due Diligence Dashboard" 
                            : "Delete submission"}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              );})}
            </div>

            <div className="mt-6 flex flex-col sm:flex-row justify-between items-center gap-4">
              <div className="flex items-center gap-4">
                <span className="text-sm text-slate-600" data-testid="text-pagination-info">
                  Showing {startIndex}-{endIndex} of {filteredSubmissions.length} results
                </span>
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-slate-700">Show:</Label>
                  <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                    setItemsPerPage(parseInt(val));
                    setCurrentPage(1);
                  }}>
                    <SelectTrigger className="w-[100px]" data-testid="select-items-per-page">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="20">20</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                      <SelectItem value="100">100</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-sm text-slate-600">per page</span>
                </div>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                    data-testid="button-first-page"
                    title="First page"
                  >
                    <ChevronsLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                      let pageNum;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={currentPage === pageNum ? "default" : "outline"}
                          size="sm"
                          onClick={() => setCurrentPage(pageNum)}
                          className="w-9"
                          data-testid={`button-page-${pageNum}`}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-next-page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                    data-testid="button-last-page"
                    title="Last page"
                  >
                    <ChevronsRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog open={!!viewingSubmission} onOpenChange={(open) => !open && setViewingSubmission(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Submission Details</DialogTitle>
          </DialogHeader>

          {viewingSubmission && (
            <div className="space-y-4">
              <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <Label className="text-slate-600">Form</Label>
                    <p className="font-medium text-slate-900">{resolveFormName(viewingSubmission)}</p>
                  </div>
                  <div>
                    <Label className="text-slate-600">Submitted</Label>
                    <p className="font-medium text-slate-900">
                      {moment(viewingSubmission.created_date).format('MMM D, YYYY h:mm A')}
                    </p>
                  </div>
                  {viewingSubmission.submitted_by_name && (
                    <div>
                      <Label className="text-slate-600">Name</Label>
                      <p className="font-medium text-slate-900">{viewingSubmission.submitted_by_name}</p>
                    </div>
                  )}
                  {getSubmitterEmail(viewingSubmission) && (
                    <div>
                      <Label className="text-slate-600">Email</Label>
                      <p className="font-medium text-slate-900">{getSubmitterEmail(viewingSubmission)}</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-white rounded-lg p-4 border border-slate-200">
                <Label className="text-slate-600 mb-2 block">Status</Label>
                <div className="flex items-center gap-3">
                  <Select
                    value={viewingSubmission.status || 'new'}
                    onValueChange={(value) => handleStatusChange(viewingSubmission.id, value)}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">New</SelectItem>
                      <SelectItem value="junk">Junk</SelectItem>
                      <SelectItem value="actioned">Actioned</SelectItem>
                    </SelectContent>
                  </Select>
                  {getStatusBadge(viewingSubmission.status)}
                </div>
                {viewingSubmission.status_updated_by && (
                  <p className="text-xs text-slate-500 mt-2">
                    Updated by {viewingSubmission.status_updated_by} on{' '}
                    {moment(viewingSubmission.status_updated_at).format('MMM D, YYYY h:mm A')}
                  </p>
                )}
              </div>

              <div>
                <h3 className="font-semibold text-slate-900 mb-3">Submission Data</h3>
                <div className="space-y-3">
                  {Object.entries(viewingSubmission.submission_data || {}).map(([key, value]) => (
                    <div key={key} className="bg-white rounded-lg p-3 border border-slate-200">
                      <Label className="text-slate-600 text-xs uppercase tracking-wide mb-1 block">
                        {getFieldLabel(key)}
                      </Label>
                      <p className="text-slate-900 whitespace-pre-wrap">
                        {Array.isArray(value) ? value.join(', ') : String(value)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!submissionToDelete} onOpenChange={(open) => !open && setSubmissionToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Submission</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this submission from "{submissionToDelete ? resolveFormName(submissionToDelete) : ''}"? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteSubmissionMutation.mutate(submissionToDelete?.id)}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-delete"
            >
              {deleteSubmissionMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={exportModalOpen} onOpenChange={setExportModalOpen}>
        <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{exportFormat === 'word' ? 'Export Word' : 'Export CSV'}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600" data-testid="text-export-count">
            {(() => {
              const useSelection = exportFormat === 'word' && selectedSubmissionIds.size > 0;
              const count = useSelection
                ? filteredSubmissions.filter(s => selectedSubmissionIds.has(s.id)).length
                : filteredSubmissions.length;
              const scope = useSelection ? ' selected' : '';
              return `${count}${scope} ${count === 1 ? 'submission' : 'submissions'} will be exported`;
            })()}
          </p>
          <div className="flex items-center gap-3 mb-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSelectAllFields}
              data-testid="button-select-all-fields"
            >
              Select All
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDeselectAllFields}
              data-testid="button-deselect-all-fields"
            >
              Deselect All
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {exportFieldOptions.map(field => (
              <div
                key={field.key}
                className="flex items-center gap-3 py-1"
                data-testid={`export-field-${field.key}`}
              >
                <Checkbox
                  id={`export-field-${field.key}`}
                  checked={selectedExportFields.includes(field.key)}
                  onCheckedChange={() => handleToggleExportField(field.key)}
                  data-testid={`checkbox-export-field-${field.key}`}
                />
                <Label
                  htmlFor={`export-field-${field.key}`}
                  className="text-sm cursor-pointer flex-1"
                >
                  {field.label}
                  {field.key.startsWith('__') && (
                    <span className="text-slate-400 ml-2 text-xs">(metadata)</span>
                  )}
                </Label>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 pt-4 border-t mt-2">
            {exportFormat === 'word' ? (
              <>
                <div className="text-xs text-slate-500">
                  Detected in current set: {awardTypeCountsInSelection.team} team · {awardTypeCountsInSelection.individual} individual
                </div>
                {isExportingWord && exportProgress && exportProgress.total > 0 && (
                  <div
                    className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
                    data-testid="text-word-export-progress"
                  >
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {exportProgress.phase === 'queued'
                      ? `Queued — waiting for the export worker to pick up the job…`
                      : exportProgress.phase === 'loading'
                        ? `Loading submission data…`
                        : exportProgress.phase === 'packaging'
                          ? `Packaging document (${exportProgress.total} of ${exportProgress.total})…`
                          : exportProgress.phase === 'uploading'
                            ? `Uploading document for download…`
                            : `Rendered ${exportProgress.processed} of ${exportProgress.total} submissions…`}
                  </div>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setExportModalOpen(false)}
                    data-testid="button-cancel-export"
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleExportWord('team')}
                    disabled={isExportingWord || selectedExportFields.length === 0 || awardTypeCountsInSelection.team === 0}
                    data-testid="button-export-word-team"
                  >
                    {isExportingWord ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileDown className="w-4 h-4 mr-2" />}
                    Team Only
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleExportWord('individual')}
                    disabled={isExportingWord || selectedExportFields.length === 0 || awardTypeCountsInSelection.individual === 0}
                    data-testid="button-export-word-individual"
                  >
                    {isExportingWord ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileDown className="w-4 h-4 mr-2" />}
                    Individual Only
                  </Button>
                  <Button
                    onClick={() => handleExportWord('all')}
                    disabled={isExportingWord || selectedExportFields.length === 0}
                    data-testid="button-confirm-export-word"
                  >
                    {isExportingWord ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileDown className="w-4 h-4 mr-2" />}
                    Export All
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={() => setExportModalOpen(false)}
                  data-testid="button-cancel-export"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleExportCSV}
                  disabled={selectedExportFields.length === 0}
                  data-testid="button-confirm-export"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export {filteredSubmissions.length} {filteredSubmissions.length === 1 ? 'Row' : 'Rows'}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}