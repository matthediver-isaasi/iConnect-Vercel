import React, { useState, useEffect, useMemo, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Search, CheckCircle, XCircle, Briefcase, MapPin, Building2, Clock, Globe, AlertCircle, Pencil, Trash2, FileText, X, ChevronLeft, ChevronRight } from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { parseJobClosingDate, startOfLocalToday } from "@/lib/jobDate";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import DOMPurify from 'dompurify';

export default function JobPostingManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedJob, setSelectedJob] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [activeTab, setActiveTab] = useState("pending");
  const [organizationFilter, setOrganizationFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(6);
  const [confirmAction, setConfirmAction] = useState(null);
  
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_JobPostingManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['admin-job-postings'],
    queryFn: () => base44.entities.JobPosting.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: jobTypeSettings = [] } = useQuery({
    queryKey: ['job-type-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'job_types');
      if (setting) {
        try {
          return JSON.parse(setting.setting_value);
        } catch (e) {
          return ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship'];
        }
      }
      return ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship'];
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: hoursSettings = [] } = useQuery({
    queryKey: ['hours-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'job_hours');
      if (setting) {
        try {
          return JSON.parse(setting.setting_value);
        } catch (e) {
          return ['Full-time', 'Part-time', 'Flexible'];
        }
      }
      return ['Full-time', 'Part-time', 'Flexible'];
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const approveMutation = useMutation({
    mutationFn: (jobId) => base44.entities.JobPosting.update(jobId, { status: 'active' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-job-postings'] });
      toast.success('Job posting approved and is now live');
      setShowDialog(false);
    },
    onError: (error) => {
      toast.error('Failed to approve job posting: ' + error.message);
    }
  });

  const rejectMutation = useMutation({
    mutationFn: (jobId) => base44.entities.JobPosting.update(jobId, { status: 'rejected' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-job-postings'] });
      toast.success('Job posting rejected');
      setShowDialog(false);
    },
    onError: (error) => {
      toast.error('Failed to reject job posting: ' + error.message);
    }
  });

  const updateJobMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.JobPosting.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-job-postings'] });
      toast.success('Job posting updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update job posting: ' + error.message);
    }
  });

  const deleteJobMutation = useMutation({
    mutationFn: (jobId) => base44.entities.JobPosting.delete(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-job-postings'] });
      toast.success('Job posting deleted');
      setShowDialog(false);
    },
    onError: (error) => {
      toast.error('Failed to delete job posting: ' + error.message);
    }
  });

  const toggleFeaturedMutation = useMutation({
    mutationFn: async (jobId) => {
      // First, unfeatured any currently featured job
      const currentFeatured = jobs.find(j => j.featured && j.id !== jobId);
      if (currentFeatured) {
        await base44.entities.JobPosting.update(currentFeatured.id, { featured: false });
      }
      // Then toggle the selected job
      const job = jobs.find(j => j.id === jobId);
      const newFeaturedState = !job?.featured;
      return base44.entities.JobPosting.update(jobId, { featured: newFeaturedState });
    },
    onSuccess: (_, jobId) => {
      queryClient.invalidateQueries({ queryKey: ['admin-job-postings'] });
      const job = jobs.find(j => j.id === jobId);
      if (job?.featured) {
        toast.success('Job removed from web feature');
      } else {
        toast.success('Job is now featured on web');
      }
    },
    onError: (error) => {
      toast.error('Failed to update web feature status: ' + error.message);
    }
  });

  const isJobExpired = useCallback((job) => {
    if (!job.closing_date) return false;
    const closing = parseJobClosingDate(job.closing_date);
    if (!closing) return false;
    return closing < startOfLocalToday();
  }, []);

  const getStatusBadge = (status, job) => {
    const styles = {
      pending_approval: 'bg-yellow-100 text-yellow-700',
      active: 'bg-green-100 text-green-700',
      expired: 'bg-slate-100 text-slate-700',
      rejected: 'bg-red-100 text-red-700',
      pending_payment: 'bg-blue-100 text-blue-700',
      paused: 'bg-orange-100 text-orange-700',
      archived: 'bg-slate-200 text-slate-600'
    };
    const displayStatus = (status === 'active' && job && isJobExpired(job)) ? 'expired' : status;
    return <Badge className={styles[displayStatus] || 'bg-slate-100 text-slate-700'}>{displayStatus?.replace(/_/g, ' ') || 'unknown'}</Badge>;
  };

  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      const matchesSearch = !searchQuery || 
        job.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        job.company_name?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const expired = isJobExpired(job);
      const isEffectivelyArchived = job.status === 'archived' || (job.status === 'active' && expired);
      const isEffectivelyActive = job.status === 'active' && !expired;

      const matchesTab = 
        (activeTab === 'pending' && job.status === 'pending_approval') ||
        (activeTab === 'active' && isEffectivelyActive) ||
        (activeTab === 'paused' && job.status === 'paused') ||
        (activeTab === 'archived' && isEffectivelyArchived) ||
        (activeTab === 'rejected' && job.status === 'rejected') ||
        (activeTab === 'all');

      const matchesOrganization = 
        organizationFilter === 'all' || 
        organizationFilter === 'non-member' && !job.is_member_post ||
        job.posted_by_organization_id === organizationFilter;

      return matchesSearch && matchesTab && matchesOrganization;
    });
  }, [jobs, searchQuery, activeTab, organizationFilter, isJobExpired]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredJobs.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedJobs = filteredJobs.slice(startIndex, endIndex);

  // Generate page numbers for pagination
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        if (totalPages > 5) pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        if (totalPages > 5) pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, activeTab, organizationFilter, itemsPerPage]);

  const handlePageChange = (page) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEdit = (job) => {
    window.location.href = `${createPageUrl('PostJob')}?editJobId=${job.id}&from=JobPostingManagement`;
  };

  const isClosingSoon = (closingDate) => {
    if (!closingDate) return false;
    const parsed = parseJobClosingDate(closingDate);
    if (!parsed) return false;
    const daysUntilClosing = differenceInDays(parsed, startOfLocalToday());
    return daysUntilClosing >= 0 && daysUntilClosing <= 7;
  };

  // Get unique organizations that have posted jobs
  const organizationsWithJobs = useMemo(() => {
    const orgIds = [...new Set(jobs.filter(j => j.posted_by_organization_id).map(j => j.posted_by_organization_id))];
    return organizations.filter(org => orgIds.includes(org.id));
  }, [jobs, organizations]);

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Job Posting Management
          </h1>
          <p className="text-slate-600">
            Review and manage job postings on the board
          </p>
        </div>

        {/* Search and Filters */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by job title or company..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={organizationFilter} onValueChange={setOrganizationFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Filter by organisation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Organisations</SelectItem>
                  <SelectItem value="non-member">Non-Member Posts</SelectItem>
                  {organizationsWithJobs.map(org => (
                    <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 flex-wrap">
            <TabsTrigger value="pending">
              Pending ({jobs.filter(j => j.status === 'pending_approval').length})
            </TabsTrigger>
            <TabsTrigger value="active">
              Active ({jobs.filter(j => j.status === 'active' && !isJobExpired(j)).length})
            </TabsTrigger>
            <TabsTrigger value="paused">
              Paused ({jobs.filter(j => j.status === 'paused').length})
            </TabsTrigger>
            <TabsTrigger value="archived">
              Archived ({jobs.filter(j => j.status === 'archived' || (j.status === 'active' && isJobExpired(j))).length})
            </TabsTrigger>
            <TabsTrigger value="rejected">
              Rejected ({jobs.filter(j => j.status === 'rejected').length})
            </TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>

          <TabsContent value={activeTab}>
            {isLoading ? (
              <div className="grid md:grid-cols-2 gap-6">
                {Array(6).fill(0).map((_, i) => (
                  <Card key={i} className="animate-pulse border-slate-200">
                    <CardContent className="p-6">
                      <div className="h-6 bg-slate-200 rounded w-2/3 mb-4" />
                      <div className="h-4 bg-slate-200 rounded w-1/3" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : filteredJobs.length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <Briefcase className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No Jobs Found</h3>
                  <p className="text-slate-600">No job postings match your current filters</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Results Summary */}
                <div className="mb-4 text-sm text-slate-600">
                  Showing {startIndex + 1}-{Math.min(endIndex, filteredJobs.length)} of {filteredJobs.length} job postings
                </div>

                <div className="grid md:grid-cols-2 gap-6 mb-8">
                  {paginatedJobs.map((job) => {
                    const closingSoon = job.closing_date && isClosingSoon(job.closing_date);
                    const closingDateParsed = parseJobClosingDate(job.closing_date);
                    const daysUntilClosing = closingDateParsed ? differenceInDays(closingDateParsed, startOfLocalToday()) : null;
                    const hasAttachments = job.attachment_urls && job.attachment_urls.length > 0;

                    return (
                      <Card 
                        key={job.id} 
                        className={`border-slate-200 hover:shadow-xl transition-all h-full ${
                          closingSoon ? 'border-l-4 border-l-amber-500' : ''
                        }`}
                      >
                        <CardContent className="p-6">
                          {closingSoon && (
                            <div className="mb-4 -mx-6 -mt-6 px-6 py-2 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-amber-200 flex items-center gap-2">
                              <AlertCircle className="w-4 h-4 text-amber-700" />
                              <span className="text-sm font-medium text-amber-900">
                                Closing {daysUntilClosing === 0 ? 'today' : `in ${daysUntilClosing} ${daysUntilClosing === 1 ? 'day' : 'days'}`}
                              </span>
                            </div>
                          )}

                          <div className="flex items-start gap-4 mb-4">
                            {job.company_logo_url ? (
                              <div className="w-16 h-16 flex-shrink-0 bg-slate-50 rounded-lg p-2 border border-slate-200">
                                <img 
                                  src={job.company_logo_url} 
                                  alt={job.company_name}
                                  className="w-full h-full object-contain"
                                />
                              </div>
                            ) : (
                              <div className="w-16 h-16 flex-shrink-0 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center">
                                <Building2 className="w-8 h-8 text-white" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <h3 className="text-lg font-bold text-slate-900 line-clamp-2 mb-2">
                                {job.title}
                              </h3>
                              <p className="text-sm font-medium text-slate-700">{job.company_name}</p>
                            </div>
                            {job.status === 'active' && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFeaturedMutation.mutate(job.id);
                                }}
                                disabled={toggleFeaturedMutation.isPending}
                                className={`p-2 rounded-full transition-all ${
                                  job.featured 
                                    ? 'bg-blue-100 text-blue-600 hover:bg-blue-200' 
                                    : 'bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600'
                                }`}
                                title={job.featured ? 'Featured on web - click to remove' : 'Click to feature on web'}
                                data-testid={`button-web-featured-job-${job.id}`}
                              >
                                <Globe className={`w-5 h-5 ${job.featured ? 'fill-blue-100' : ''}`} />
                              </button>
                            )}
                          </div>

                          <div className="flex flex-wrap gap-2 mb-4">
                            {getStatusBadge(job.status, job)}
                            {job.is_member_post ? (
                              <Badge className="bg-purple-100 text-purple-700">
                                Member: {job.contact_email}
                              </Badge>
                            ) : (
                              <Badge className="bg-slate-100 text-slate-700">Non-Member</Badge>
                            )}
                            {job.payment_status === 'paid' && (
                              <Badge className="bg-green-100 text-green-700">Paid</Badge>
                            )}
                            {job.job_type && (
                              <Badge className="bg-blue-100 text-blue-700">{job.job_type}</Badge>
                            )}
                            {job.hours && (
                              <Badge className="bg-purple-100 text-purple-700">{job.hours}</Badge>
                            )}
                            {hasAttachments && (
                              <Badge className="bg-slate-100 text-slate-700 flex items-center gap-1">
                                <FileText className="w-3 h-3" />
                                {job.attachment_urls.length}
                              </Badge>
                            )}
                          </div>

                          <div className="space-y-2 mb-4">
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <MapPin className="w-4 h-4 flex-shrink-0" />
                              <span>{job.location}</span>
                            </div>
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <Clock className="w-4 h-4 flex-shrink-0" />
                              <span>Posted {format(new Date(job.created_date), 'MMM d, yyyy')}</span>
                            </div>
                            {job.closing_date && (
                              <div className="flex items-center gap-2 text-sm">
                                <Clock className="w-4 h-4 flex-shrink-0 text-slate-600" />
                                <span className={closingSoon ? 'font-semibold text-amber-700' : 'text-slate-600'}>
                                  Closes {format(closingDateParsed, 'MMM d, yyyy')}
                                </span>
                              </div>
                            )}
                            {job.salary_range && (
                              <div className="text-sm text-slate-600">
                                💰 {job.salary_range}
                              </div>
                            )}
                          </div>

                          <div className="text-xs text-slate-500 mb-4 p-3 bg-slate-50 rounded">
                            Posted by {job.contact_name || 'Unknown'} ({job.contact_email})
                          </div>

                          <p className="text-sm text-slate-600 line-clamp-2 leading-relaxed mb-4">
                            {job.description?.replace(/<[^>]*>/g, '').substring(0, 150)}...
                          </p>

                          <div className="flex gap-2 pt-4 border-t border-slate-200">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setSelectedJob(job);
                                setShowDialog(true);
                              }}
                              className="flex-1"
                            >
                              View Details
                            </Button>
                            {['active', 'paused', 'archived'].includes(job.status) && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEdit(job)}
                                className="text-blue-600 hover:text-blue-700"
                                data-testid={`button-edit-job-${job.id}`}
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                {/* Pagination Controls */}
                {filteredJobs.length > 0 && (
                  <Card className="border-slate-200 shadow-sm">
                    <CardContent className="p-6">
                      <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                        {/* Items per page selector */}
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-slate-600">Items per page:</span>
                          <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                            setItemsPerPage(Number(val));
                            setCurrentPage(1);
                          }}>
                            <SelectTrigger className="w-20">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="6">6</SelectItem>
                              <SelectItem value="12">12</SelectItem>
                              <SelectItem value="24">24</SelectItem>
                              <SelectItem value="48">48</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Page info */}
                        <div className="text-sm text-slate-600">
                          Page {currentPage} of {totalPages}
                        </div>

                        {/* Page navigation */}
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(currentPage - 1)}
                            disabled={currentPage === 1}
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </Button>

                          {getPageNumbers().map((page, idx) => (
                            <React.Fragment key={idx}>
                              {page === '...' ? (
                                <span className="px-2 text-slate-400">...</span>
                              ) : (
                                <Button
                                  variant={currentPage === page ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => handlePageChange(page)}
                                  className={currentPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                                >
                                  {page}
                                </Button>
                              )}
                            </React.Fragment>
                          ))}

                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(currentPage + 1)}
                            disabled={currentPage === totalPages}
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>

        {/* Review Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Review Job Posting</DialogTitle>
            </DialogHeader>
            {selectedJob && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-2xl font-bold text-slate-900 mb-2">{selectedJob.title}</h3>
                  <p className="text-slate-600 mb-4">{selectedJob.company_name}</p>
                  <div className="flex gap-2 mb-4 flex-wrap">
                    {getStatusBadge(selectedJob.status, selectedJob)}
                    {selectedJob.is_member_post ? (
                      <Badge className="bg-purple-100 text-purple-700">
                        Member: {selectedJob.contact_email}
                      </Badge>
                    ) : (
                      <Badge className="bg-slate-100 text-slate-700">Non-Member Post</Badge>
                    )}
                    {selectedJob.payment_status === 'paid' && (
                      <Badge className="bg-green-100 text-green-700">Paid</Badge>
                    )}
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4 p-4 bg-slate-50 rounded-lg">
                  <div>
                    <p className="text-sm text-slate-500">City or Town</p>
                    <p className="font-medium">{selectedJob.location}</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-500">Job Type</p>
                    <p className="font-medium">{selectedJob.job_type || 'Not specified'}</p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-500">Hours</p>
                    <p className="font-medium">{selectedJob.hours || 'Not specified'}</p>
                  </div>
                  {selectedJob.salary_range && (
                    <div>
                      <p className="text-sm text-slate-500">Salary</p>
                      <p className="font-medium">{selectedJob.salary_range}</p>
                    </div>
                  )}
                  {selectedJob.closing_date && (
                    <div>
                      <p className="text-sm text-slate-500">Closing Date</p>
                      <p className="font-medium">{format(parseJobClosingDate(selectedJob.closing_date), 'MMM d, yyyy')}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-slate-500">Application Method</p>
                    <p className="font-medium">{selectedJob.application_method}</p>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-sm text-slate-500">Application Contact</p>
                    <p className="font-medium break-all">{selectedJob.application_value}</p>
                  </div>
                  <div className="md:col-span-2">
                    <p className="text-sm text-slate-500">Posted By</p>
                    <p className="font-medium">{selectedJob.contact_name} ({selectedJob.contact_email})</p>
                  </div>
                  {selectedJob.posted_by_organization_name && (
                    <div className="md:col-span-2">
                      <p className="text-sm text-slate-500">Member Organisation</p>
                      <p className="font-medium">{selectedJob.posted_by_organization_name}</p>
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="font-semibold text-slate-900 mb-2">Job Description</h4>
                  <div 
                    className="prose prose-slate max-w-none bg-slate-50 p-4 rounded-lg"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selectedJob.description || '') }}
                  />
                </div>

                {selectedJob.attachment_urls && selectedJob.attachment_urls.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-slate-900 mb-2 flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      Attached Documents ({selectedJob.attachment_urls.length})
                    </h4>
                    <div className="space-y-2">
                      {selectedJob.attachment_names.map((name, index) => (
                        <a
                          key={index}
                          href={selectedJob.attachment_urls[index]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                        >
                          <FileText className="w-5 h-5 text-blue-600" />
                          <span className="text-sm font-medium text-slate-900">{name}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              {selectedJob?.status === 'pending_approval' && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => rejectMutation.mutate(selectedJob.id)}
                    disabled={rejectMutation.isPending}
                    className="text-red-600 hover:text-red-700"
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    Reject
                  </Button>
                  <Button
                    onClick={() => approveMutation.mutate(selectedJob.id)}
                    disabled={approveMutation.isPending}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Approve & Publish
                  </Button>
                </>
              )}
              {selectedJob?.status === 'active' && (
                <Button
                  variant={selectedJob?.featured ? "default" : "outline"}
                  onClick={() => toggleFeaturedMutation.mutate(selectedJob.id)}
                  disabled={toggleFeaturedMutation.isPending}
                  className={selectedJob?.featured ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'text-blue-600 hover:text-blue-700'}
                  data-testid="button-toggle-featured-dialog"
                >
                  <Globe className={`w-4 h-4 mr-2 ${selectedJob?.featured ? 'fill-blue-200' : ''}`} />
                  {selectedJob?.featured ? 'Featured on Web' : 'Feature on Web'}
                </Button>
              )}
              {['active', 'paused', 'archived'].includes(selectedJob?.status) && (
                <Button
                  variant="outline"
                  onClick={() => handleEdit(selectedJob)}
                  className="text-blue-600 hover:text-blue-700"
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  Edit
                </Button>
              )}
              {selectedJob && (
                <Button
                  variant="outline"
                  onClick={() => setConfirmAction({ type: 'delete', jobId: selectedJob.id, fromViewDialog: true })}
                  disabled={deleteJobMutation.isPending}
                  className="text-red-600 hover:text-red-700"
                  data-testid="button-delete-job-view"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </Button>
              )}
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Confirmation Dialog */}
        <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmAction?.type === 'pause' && 'Pause Job Posting'}
                {confirmAction?.type === 'reactivate' && 'Reactivate Job Posting'}
                {confirmAction?.type === 'archive' && 'Archive Job Posting'}
                {confirmAction?.type === 'delete' && 'Delete Job Posting'}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmAction?.type === 'pause' && 'Are you sure you want to pause this job posting? It will no longer be visible to job seekers until reactivated.'}
                {confirmAction?.type === 'reactivate' && 'Are you sure you want to reactivate this job posting? It will become visible to job seekers again.'}
                {confirmAction?.type === 'archive' && 'Are you sure you want to archive this job posting? It will be moved to the archived section and no longer visible to job seekers.'}
                {confirmAction?.type === 'delete' && 'Are you sure you want to permanently delete this job posting? This action cannot be undone.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-confirm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmAction?.type === 'pause') {
                    updateJobMutation.mutate({ id: confirmAction.jobId, data: { status: 'paused' } });
                  } else if (confirmAction?.type === 'reactivate') {
                    updateJobMutation.mutate({ id: confirmAction.jobId, data: { status: 'active' } });
                  } else if (confirmAction?.type === 'archive') {
                    updateJobMutation.mutate({ id: confirmAction.jobId, data: { status: 'archived' } });
                  } else if (confirmAction?.type === 'delete') {
                    deleteJobMutation.mutate(confirmAction.jobId);
                    if (confirmAction.fromViewDialog) {
                      setShowDialog(false);
                      setSelectedJob(null);
                    }
                  }
                  setConfirmAction(null);
                }}
                className={
                  confirmAction?.type === 'delete' 
                    ? 'bg-red-600 hover:bg-red-700 text-white' 
                    : confirmAction?.type === 'pause'
                    ? 'bg-orange-600 hover:bg-orange-700 text-white'
                    : confirmAction?.type === 'reactivate'
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-slate-600 hover:bg-slate-700 text-white'
                }
                data-testid="button-confirm-action"
              >
                {confirmAction?.type === 'pause' && 'Pause'}
                {confirmAction?.type === 'reactivate' && 'Reactivate'}
                {confirmAction?.type === 'archive' && 'Archive'}
                {confirmAction?.type === 'delete' && 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}