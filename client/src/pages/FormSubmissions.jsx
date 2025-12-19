import React, { useState, useMemo, useEffect } from "react";
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
import { Loader2, FileText, Search, ChevronLeft, ChevronRight, Eye } from "lucide-react";
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
                />
              </div>
              <Select value={selectedForm} onValueChange={(val) => {
                setSelectedForm(val);
                setCurrentPage(1);
              }}>
                <SelectTrigger className="w-full md:w-[200px]">
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
                <SelectTrigger className="w-full md:w-[150px]">
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
              {paginatedSubmissions.map(submission => (
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
                          {submission.submitted_by_email && (
                            <Badge variant="outline">
                              {submission.submitted_by_email}
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-slate-600">
                            {moment(submission.created_date).format('MMM D, YYYY h:mm A')}
                          </Badge>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setViewingSubmission(submission)}
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        View
                      </Button>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-6 flex flex-col sm:flex-row justify-between items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-slate-700">Show:</Label>
                  <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                    setItemsPerPage(parseInt(val));
                    setCurrentPage(1);
                  }}>
                    <SelectTrigger className="w-[100px]">
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

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
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
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
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
                  {viewingSubmission.submitted_by_email && (
                    <div>
                      <Label className="text-slate-600">Email</Label>
                      <p className="font-medium text-slate-900">{viewingSubmission.submitted_by_email}</p>
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
    </div>
  );
}