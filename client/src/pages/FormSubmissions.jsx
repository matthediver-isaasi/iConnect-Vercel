import React, { useState, useMemo, useEffect } from "react";
import { Link } from "react-router-dom";
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
import { Loader2, FileText, Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, Trash2, RotateCcw, Mail, TrendingUp, TrendingDown, Minus, BarChart3, CheckCircle, AlertCircle, Clock } from "lucide-react";
import moment from "moment";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function FormSubmissionsPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FormSubmissions')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [selectedForm, setSelectedForm] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [viewingSubmission, setViewingSubmission] = useState(null);
  const [submissionToDelete, setSubmissionToDelete] = useState(null);

  const queryClient = useQueryClient();

  const { data: submissions = [], isLoading: submissionsLoading } = useQuery({
    queryKey: ['form-submissions'],
    queryFn: async () => {
      const allSubmissions = await base44.entities.FormSubmission.list();
      return allSubmissions.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    }
  });

  const { data: forms = [] } = useQuery({
    queryKey: ['forms'],
    queryFn: async () => {
      return await base44.entities.Form.list();
    }
  });

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
      // Get the form to access its configuration
      const form = forms.find(f => f.id === submission.form_id);
      if (!form) {
        throw new Error('Form not found');
      }
      
      // Call the process-application endpoint with the stored submission data
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
          additional_member_creations: form.additional_member_creations || []
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to re-run submission');
      }
      
      return await response.json();
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

    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter(s => 
        s.form_name?.toLowerCase().includes(searchLower) ||
        s.submitted_by_email?.toLowerCase().includes(searchLower) ||
        s.submitted_by_name?.toLowerCase().includes(searchLower) ||
        JSON.stringify(s.submission_data).toLowerCase().includes(searchLower)
      );
    }

    return filtered;
  }, [submissions, selectedForm, selectedStatus, searchQuery]);

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
      const formName = s.form_name || 'Unknown Form';
      counts[formName] = (counts[formName] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [submissions]);

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
            </div>
          </CardContent>
        </Card>

        {paginatedSubmissions.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No submissions found</h3>
              <p className="text-slate-600">
                {searchQuery || selectedForm !== "all" || selectedStatus !== "all" ? 'Try adjusting your filters' : 'No form submissions yet'}
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
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-base mb-2">{submission.form_name}</CardTitle>
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
                        <Link to={`/FormSubmission/${submission.id}`}>
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
                    <p className="font-medium text-slate-900">{viewingSubmission.form_name}</p>
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
              Are you sure you want to delete this submission from "{submissionToDelete?.form_name}"? 
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
    </div>
  );
}