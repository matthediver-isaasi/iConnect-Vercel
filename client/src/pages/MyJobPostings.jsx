
import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Briefcase, MapPin, Building2, Clock, Star, AlertCircle, Pencil, FileText, Upload, X, Loader2, Plus } from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function MyJobPostingsPage() {
  const { memberInfo } = useMemberAccess();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingJob, setEditingJob] = useState(null);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [activeFilter, setActiveFilter] = useState('all'); // Changed from activeTab to activeFilter

  const queryClient = useQueryClient();

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['my-job-postings', memberInfo?.id, memberInfo?.email],
    queryFn: async () => {
      if (!memberInfo?.id && !memberInfo?.email) return [];
      
      // Build filter queries - use posted_by_member_id (preferred) and contact_email (fallback for historical data)
      const queries = [];
      
      if (memberInfo?.id) {
        queries.push(base44.entities.JobPosting.filter({ posted_by_member_id: memberInfo.id }));
      }
      
      if (memberInfo?.email) {
        // Use ilike for case-insensitive email matching to handle legacy data with different casing
        queries.push(base44.entities.JobPosting.list({ 
          filter: { contact_email: { ilike: memberInfo.email.toLowerCase() } } 
        }));
      }
      
      if (queries.length === 0) return [];
      
      const results = await Promise.all(queries);
      
      // Merge and deduplicate jobs using a Map
      const jobMap = new Map();
      results.forEach(jobList => {
        jobList.forEach(job => {
          if (!jobMap.has(job.id)) {
            jobMap.set(job.id, job);
          }
        });
      });
      
      const allJobs = Array.from(jobMap.values());
      return allJobs.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    },
    enabled: !!(memberInfo?.id || memberInfo?.email),
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

  const updateJobMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.JobPosting.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-job-postings'] });
      toast.success('Job posting updated successfully');
      setShowEditDialog(false);
      setEditingJob(null);
    },
    onError: (error) => {
      toast.error('Failed to update job posting: ' + error.message);
    }
  });

  const getStatusBadge = (status) => {
    const styles = {
      pending_approval: 'bg-yellow-100 text-yellow-700',
      active: 'bg-green-100 text-green-700',
      expired: 'bg-slate-100 text-slate-700',
      rejected: 'bg-red-100 text-red-700',
      pending_payment: 'bg-blue-100 text-blue-700'
    };
    const labels = {
      pending_approval: 'Pending Approval',
      active: 'Active',
      expired: 'Expired',
      rejected: 'Rejected',
      pending_payment: 'Pending Payment'
    };
    return <Badge className={styles[status]}>{labels[status]}</Badge>;
  };

  const handleEdit = (job) => {
    setEditingJob({ 
      ...job,
      attachment_urls: job.attachment_urls || [],
      attachment_names: job.attachment_names || []
    });
    setShowEditDialog(true);
  };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];

    const invalidFiles = files.filter(file => !allowedTypes.includes(file.type));
    if (invalidFiles.length > 0) {
      toast.error('Only PDF, Word, and Excel documents are allowed');
      return;
    }

    const oversizedFiles = files.filter(file => file.size > 10 * 1024 * 1024);
    if (oversizedFiles.length > 0) {
      toast.error('Files must be smaller than 10MB');
      return;
    }

    setUploadingFiles(true);

    try {
      const uploadPromises = files.map(async (file) => {
        const response = await base44.integrations.Core.UploadFile({ file });
        return {
          url: response.file_url,
          name: file.name
        };
      });

      const uploadedFiles = await Promise.all(uploadPromises);

      setEditingJob(prev => ({
        ...prev,
        attachment_urls: [...(prev.attachment_urls || []), ...uploadedFiles.map(f => f.url)],
        attachment_names: [...(prev.attachment_names || []), ...uploadedFiles.map(f => f.name)]
      }));

      toast.success(`${files.length} ${files.length === 1 ? 'file' : 'files'} uploaded successfully`);
    } catch (error) {
      toast.error('Failed to upload files. Please try again.');
    } finally {
      setUploadingFiles(false);
    }
  };

  const handleRemoveAttachment = (index) => {
    setEditingJob(prev => ({
      ...prev,
      attachment_urls: prev.attachment_urls.filter((_, i) => i !== index),
      attachment_names: prev.attachment_names.filter((_, i) => i !== index)
    }));
  };

  const handleSaveEdit = () => {
    if (!editingJob.title?.trim()) {
      toast.error('Please enter a job title');
      return;
    }
    if (!editingJob.company_name?.trim()) {
      toast.error('Please enter a company name');
      return;
    }
    // Check description - ReactQuill returns "<p><br></p>" for empty content
    const descriptionText = editingJob.description?.replace(/<[^>]*>/g, '').trim();
    if (!descriptionText) {
      toast.error('Please enter a job description');
      return;
    }
    if (!editingJob.closing_date) {
      toast.error('Please select a closing date');
      return;
    }
    updateJobMutation.mutate({ id: editingJob.id, data: editingJob });
  };

  const isClosingSoon = (closingDate) => {
    if (!closingDate) return false;
    const daysUntilClosing = differenceInDays(new Date(closingDate), new Date());
    return daysUntilClosing >= 0 && daysUntilClosing <= 7;
  };

  const groupedJobs = useMemo(() => {
    return {
      pending: jobs.filter(j => j.status === 'pending_approval'),
      active: jobs.filter(j => j.status === 'active'),
      rejected: jobs.filter(j => j.status === 'rejected'),
      expired: jobs.filter(j => j.status === 'expired')
    };
  }, [jobs]);

  // Filter jobs based on active filter
  const filteredJobs = useMemo(() => {
    if (activeFilter === 'all') return jobs;
    return groupedJobs[activeFilter] || [];
  }, [jobs, groupedJobs, activeFilter]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">My Job Postings</h1>
            <Button
              onClick={() => window.location.href = createPageUrl('PostJob')}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Plus className="w-5 h-5 mr-2" />
              Post New Job
            </Button>
          </div>
          <p className="text-slate-600">
            Manage your organisation's job postings
          </p>
        </div>

        {/* Summary Cards - Now Clickable */}
        <div className="grid md:grid-cols-5 gap-4 mb-8">
          <Card 
            className={`border-slate-200 cursor-pointer transition-all hover:shadow-lg ${
              activeFilter === 'pending' ? 'ring-2 ring-yellow-500 bg-yellow-50' : ''
            }`}
            onClick={() => setActiveFilter('pending')}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Pending</p>
                  <p className="text-2xl font-bold text-yellow-600">{groupedJobs.pending.length}</p>
                </div>
                <Clock className="w-8 h-8 text-yellow-600" />
              </div>
            </CardContent>
          </Card>
          
          <Card 
            className={`border-slate-200 cursor-pointer transition-all hover:shadow-lg ${
              activeFilter === 'active' ? 'ring-2 ring-green-500 bg-green-50' : ''
            }`}
            onClick={() => setActiveFilter('active')}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Active</p>
                  <p className="text-2xl font-bold text-green-600">{groupedJobs.active.length}</p>
                </div>
                <Briefcase className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>
          
          <Card 
            className={`border-slate-200 cursor-pointer transition-all hover:shadow-lg ${
              activeFilter === 'rejected' ? 'ring-2 ring-red-500 bg-red-50' : ''
            }`}
            onClick={() => setActiveFilter('rejected')}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Rejected</p>
                  <p className="text-2xl font-bold text-red-600">{groupedJobs.rejected.length}</p>
                </div>
                <AlertCircle className="w-8 h-8 text-red-600" />
              </div>
            </CardContent>
          </Card>

          <Card 
            className={`border-slate-200 cursor-pointer transition-all hover:shadow-lg ${
              activeFilter === 'expired' ? 'ring-2 ring-slate-500 bg-slate-50' : ''
            }`}
            onClick={() => setActiveFilter('expired')}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Expired</p>
                  <p className="text-2xl font-bold text-slate-600">{groupedJobs.expired.length}</p>
                </div>
                <Clock className="w-8 h-8 text-slate-600" />
              </div>
            </CardContent>
          </Card>
          
          <Card 
            className={`border-slate-200 cursor-pointer transition-all hover:shadow-lg ${
              activeFilter === 'all' ? 'ring-2 ring-blue-500 bg-blue-50' : ''
            }`}
            onClick={() => setActiveFilter('all')}
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">All Jobs</p>
                  <p className="text-2xl font-bold text-slate-900">{jobs.length}</p>
                </div>
                <Briefcase className="w-8 h-8 text-slate-900" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Job Listings */}
        {isLoading ? (
          <div className="grid md:grid-cols-2 gap-6">
            {Array(4).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <CardContent className="p-6">
                  <div className="h-6 bg-slate-200 rounded w-2/3 mb-4" />
                  <div className="h-4 bg-slate-200 rounded w-1/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Briefcase className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Job Postings Yet</h3>
              <p className="text-slate-600 mb-6">You haven't posted any jobs yet. Get started by posting your first job!</p>
              <Button
                onClick={() => window.location.href = createPageUrl('PostJob')}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Plus className="w-5 h-5 mr-2" />
                Post Your First Job
              </Button>
            </CardContent>
          </Card>
        ) : filteredJobs.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Briefcase className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No {activeFilter === 'pending' ? 'pending approval' : activeFilter} job postings
              </h3>
              <p className="text-slate-600">
                There are no job postings in the {activeFilter === 'pending' ? 'pending approval' : activeFilter} category.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 gap-6">
            {filteredJobs.map((job) => {
              const closingSoon = job.closing_date && isClosingSoon(job.closing_date);
              const daysUntilClosing = job.closing_date ? differenceInDays(new Date(job.closing_date), new Date()) : null;
              const hasAttachments = job.attachment_urls && job.attachment_urls.length > 0;
              
              // Allow editing if job is pending or active
              const canEdit = job.status === 'pending_approval' || job.status === 'active';

              return (
                <Card 
                  key={job.id} 
                  className={`border-slate-200 hover:shadow-xl transition-all h-full ${
                    closingSoon && job.status === 'active' ? 'border-l-4 border-l-amber-500' : ''
                  }`}
                >
                  <CardContent className="p-6">
                    {closingSoon && job.status === 'active' && (
                      <div className="mb-4 -mx-6 -mt-6 px-6 py-2 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-amber-200 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-600" />
                        <span className="text-sm font-medium text-amber-900">
                          Closing {daysUntilClosing === 0 ? 'today' : `in ${daysUntilClosing} ${daysUntilClosing === 1 ? 'day' : 'days'}`}
                        </span>
                      </div>
                    )}

                    <div className="flex items-start gap-4 mb-4">
                      {job.company_logo_url ? (
                        <div className="w-16 h-16 flex-shrink-0 bg-slate-50 rounded-lg p-2 border border-slate-200">
                          <img src={job.company_logo_url} alt={job.company_name} className="w-full h-full object-contain" />
                        </div>
                      ) : (
                        <div className="w-16 h-16 flex-shrink-0 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center">
                          <Building2 className="w-8 h-8 text-white" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-bold text-slate-900 line-clamp-2 mb-2">{job.title}</h3>
                        <p className="text-sm font-medium text-slate-700">{job.company_name}</p>
                      </div>
                      {job.featured && <Star className="w-5 h-5 text-amber-500 fill-amber-500 flex-shrink-0" />}
                    </div>

                    <div className="flex flex-wrap gap-2 mb-4">
                      {getStatusBadge(job.status)}
                      {job.job_type && <Badge className="bg-blue-100 text-blue-700">{job.job_type}</Badge>}
                      {job.hours && <Badge className="bg-purple-100 text-purple-700">{job.hours}</Badge>}
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
                          <span className={closingSoon && job.status === 'active' ? 'font-semibold text-amber-700' : 'text-slate-600'}>
                            Closes {format(new Date(job.closing_date), 'MMM d, yyyy')}
                          </span>
                        </div>
                      )}
                    </div>

                    <p className="text-sm text-slate-600 line-clamp-2 leading-relaxed mb-4">
                      {job.description?.replace(/<[^>]*>/g, '').substring(0, 150)}...
                    </p>

                    <div className="flex gap-2 pt-4 border-t border-slate-200">
                      {job.status === 'active' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(createPageUrl(`JobDetails?id=${job.id}`), '_blank')}
                          className="flex-1 text-blue-600 hover:text-blue-700"
                        >
                          View Live
                        </Button>
                      )}
                      {canEdit && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(job)}
                          className={`${job.status === 'active' ? '' : 'flex-1'} text-slate-600 hover:text-slate-700`}
                        >
                          <Pencil className="w-4 h-4 mr-2" />
                          Edit
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Edit Dialog */}
        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Job Posting</DialogTitle>
            </DialogHeader>
            {editingJob && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Job Title *</Label>
                  <Input
                    id="title"
                    value={editingJob.title}
                    onChange={(e) => setEditingJob({ ...editingJob, title: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="company_name">Company Name *</Label>
                  <Input
                    id="company_name"
                    value={editingJob.company_name}
                    onChange={(e) => setEditingJob({ ...editingJob, company_name: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="location">City or Town *</Label>
                  <Input
                    id="location"
                    value={editingJob.location}
                    onChange={(e) => setEditingJob({ ...editingJob, location: e.target.value })}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="job_type">Job Type</Label>
                    <select
                      id="job_type"
                      value={editingJob.job_type || ''}
                      onChange={(e) => setEditingJob({ ...editingJob, job_type: e.target.value })}
                      className="w-full h-10 px-3 rounded-md border border-slate-200"
                    >
                      <option value="">Select...</option>
                      {jobTypeSettings.map(type => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="hours">Hours</Label>
                    <select
                      id="hours"
                      value={editingJob.hours || ''}
                      onChange={(e) => setEditingJob({ ...editingJob, hours: e.target.value })}
                      className="w-full h-10 px-3 rounded-md border border-slate-200"
                    >
                      <option value="">Select...</option>
                      {hoursSettings.map(hour => (
                        <option key={hour} value={hour}>{hour}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="salary_range">Salary Range</Label>
                  <Input
                    id="salary_range"
                    value={editingJob.salary_range || ''}
                    onChange={(e) => setEditingJob({ ...editingJob, salary_range: e.target.value })}
                    placeholder="e.g., £30,000 - £40,000"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="closing_date">Closing Date *</Label>
                  <Input
                    id="closing_date"
                    type="date"
                    value={editingJob.closing_date ? editingJob.closing_date.split('T')[0] : ''}
                    onChange={(e) => setEditingJob({ ...editingJob, closing_date: e.target.value + 'T23:59:59Z' })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="company_logo_url">Company Logo URL</Label>
                  <Input
                    id="company_logo_url"
                    value={editingJob.company_logo_url || ''}
                    onChange={(e) => setEditingJob({ ...editingJob, company_logo_url: e.target.value })}
                    placeholder="https://..."
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Job Description *</Label>
                  <Textarea
                    id="description"
                    value={editingJob.description}
                    onChange={(e) => setEditingJob({ ...editingJob, description: e.target.value })}
                    rows={10}
                  />
                </div>

                <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-slate-900">Additional Documents</h3>
                      <p className="text-sm text-slate-600">Upload or remove job-related documents</p>
                    </div>
                    <Label htmlFor="edit-file-upload" className="cursor-pointer">
                      <div className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
                        <Upload className="w-4 h-4" />
                        <span className="text-sm font-medium">Upload</span>
                      </div>
                      <input
                        id="edit-file-upload"
                        type="file"
                        multiple
                        accept=".pdf,.doc,.docx,.xls,.xlsx"
                        onChange={handleFileUpload}
                        className="hidden"
                        disabled={uploadingFiles}
                      />
                    </Label>
                  </div>

                  {uploadingFiles && (
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Uploading files...</span>
                    </div>
                  )}

                  {editingJob.attachment_urls && editingJob.attachment_urls.length > 0 && (
                    <div className="space-y-2">
                      {editingJob.attachment_names.map((name, index) => (
                        <div key={index} className="flex items-center justify-between p-3 bg-white rounded-lg border border-slate-200">
                          <div className="flex items-center gap-2">
                            <FileText className="w-4 h-4 text-blue-600" />
                            <span className="text-sm font-medium text-slate-700">{name}</span>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveAttachment(index)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {(!editingJob.attachment_urls || editingJob.attachment_urls.length === 0) && !uploadingFiles && (
                    <p className="text-sm text-slate-500 text-center py-4">No documents attached</p>
                  )}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowEditDialog(false);
                  setEditingJob(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={updateJobMutation.isPending || uploadingFiles}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {updateJobMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
