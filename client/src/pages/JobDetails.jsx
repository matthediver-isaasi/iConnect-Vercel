
import React, { useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MapPin, Building2, Clock, Mail, ExternalLink, Briefcase, PoundSterling, ArrowLeft, AlertCircle, FileText, Download, Linkedin, Share2 } from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { createPageUrl } from "@/utils";
import DOMPurify from 'dompurify';

export default function JobDetailsPage() {
  const urlParams = new URLSearchParams(window.location.search);
  const jobId = urlParams.get('id');

  // Scroll to top when component mounts
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', jobId],
    queryFn: async () => {
      const jobs = await base44.entities.JobPosting.list();
      return jobs.find(j => j.id === jobId);
    },
    enabled: !!jobId
  });

  if (!jobId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="border-slate-200">
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">Job not found</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="animate-pulse border-slate-200">
            <CardContent className="p-8">
              <div className="h-8 bg-slate-200 rounded w-2/3 mb-4" />
              <div className="h-4 bg-slate-200 rounded w-1/3" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!job || job.status !== 'active') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="border-slate-200">
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">This job posting is no longer available</p>
            <Button 
              onClick={() => window.location.href = createPageUrl('JobBoard')}
              className="mt-4"
            >
              Back to Job Board
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleApply = () => {
    if (job.application_method === 'email') {
      window.location.href = `mailto:${job.application_value}?subject=Application for ${job.title}`;
    } else {
      window.open(job.application_value, '_blank', 'noopener,noreferrer');
    }
  };

  // Check if closing soon (within 7 days)
  const isClosingSoon = job.closing_date && differenceInDays(new Date(job.closing_date), new Date()) <= 7;
  const daysUntilClosing = job.closing_date ? differenceInDays(new Date(job.closing_date), new Date()) : null;

  // Share handlers
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
  const shareText = `${job.title} at ${job.company_name} - ${job.location}`;
  
  const handleLinkedInShare = () => {
    const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(currentUrl)}`;
    window.open(linkedInUrl, '_blank', 'noopener,noreferrer,width=600,height=600');
  };

  const handleEmailShare = () => {
    const subject = encodeURIComponent(`Job Opportunity: ${job.title}`);
    const body = encodeURIComponent(
      `I found this job opportunity that might interest you:\n\n` +
      `${job.title}\n` +
      `${job.company_name}\n` +
      `Location: ${job.location}\n\n` +
      `View details: ${currentUrl}`
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  return (
    <div className="bg-white min-h-screen">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-12">
        <div className="max-w-4xl mx-auto px-4">
          <Button
            variant="ghost"
            onClick={() => window.location.href = createPageUrl('JobBoard')}
            className="text-white hover:bg-white/10 mb-6"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Job Board
          </Button>
          
          <div className="flex items-start gap-6">
            {job.company_logo_url && (
              <img 
                src={job.company_logo_url} 
                alt={job.company_name}
                className="w-24 h-24 object-contain bg-white rounded-lg p-2"
              />
            )}
            <div className="flex-1">
              <h1 className="text-3xl md:text-4xl font-bold mb-4">{job.title}</h1>
              <div className="flex flex-wrap gap-4 text-blue-100">
                <div className="flex items-center gap-2">
                  <Building2 className="w-5 h-5" />
                  <span>{job.company_name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="w-5 h-5" />
                  <span>{job.location}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-5 h-5" />
                  <span>Posted {format(new Date(job.created_date), 'd MMM, yyyy')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 py-12">
        {/* Closing Soon Alert */}
        {isClosingSoon && job.closing_date && (
          <div className="mb-6 p-4 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-900">
                Applications closing {daysUntilClosing === 0 ? 'today' : `in ${daysUntilClosing} ${daysUntilClosing === 1 ? 'day' : 'days'}`}
              </p>
              <p className="text-sm text-amber-700 mt-1">
                Submit your application before {format(new Date(job.closing_date), 'd MMM, yyyy')}
              </p>
            </div>
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Left Column - Job Details */}
          <div className="lg:col-span-2 space-y-6">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>Job Description</CardTitle>
              </CardHeader>
              <CardContent className="prose prose-slate max-w-none">
                <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(job.description || '') }} />
              </CardContent>
            </Card>

            {/* Additional Documents */}
            {job.attachment_urls && job.attachment_urls.length > 0 && (
              <Card className="border-slate-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="w-5 h-5" />
                    Additional Documents
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {job.attachment_urls.map((url, index) => (
                      <a
                        key={index}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                            <FileText className="w-5 h-5 text-blue-600" />
                          </div>
                          <div>
                            <p className="font-medium text-slate-900 group-hover:text-blue-600 transition-colors">
                              {job.attachment_names && job.attachment_names[index] ? job.attachment_names[index] : `Document ${index + 1}`}
                            </p>
                            <p className="text-xs text-slate-500">Click to download</p>
                          </div>
                        </div>
                        <Download className="w-5 h-5 text-slate-400 group-hover:text-blue-600 transition-colors" />
                      </a>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Column - Apply & Details */}
          <div className="space-y-6">
            <Card className="border-slate-200 sticky top-8">
              <CardContent className="p-6 space-y-4">
                <Button 
                  onClick={handleApply}
                  className="w-full bg-blue-600 hover:bg-blue-700"
                  size="lg"
                >
                  {job.application_method === 'email' ? (
                    <>
                      <Mail className="w-5 h-5 mr-2" />
                      Apply via Email
                    </>
                  ) : (
                    <>
                      <ExternalLink className="w-5 h-5 mr-2" />
                      Apply Now
                    </>
                  )}
                </Button>

                <div className="space-y-3 pt-4 border-t border-slate-200">
                  <h3 className="font-semibold text-slate-900">Job Details</h3>
                  
                  {job.job_type && (
                    <div className="flex items-start gap-3">
                      <Briefcase className="w-5 h-5 text-slate-500 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="text-xs text-slate-500">Job Type</div>
                        <div className="text-sm font-medium text-slate-900">{job.job_type}</div>
                      </div>
                    </div>
                  )}

                  {job.hours && (
                    <div className="flex items-start gap-3">
                      <Clock className="w-5 h-5 text-slate-500 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="text-xs text-slate-500">Hours</div>
                        <div className="text-sm font-medium text-slate-900">{job.hours}</div>
                      </div>
                    </div>
                  )}

                  {job.salary_range && (
                    <div className="flex items-start gap-3">
                      <PoundSterling className="w-5 h-5 text-slate-500 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="text-xs text-slate-500">Salary</div>
                        <div className="text-sm font-medium text-slate-900">{job.salary_range}</div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-start gap-3">
                    <MapPin className="w-5 h-5 text-slate-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="text-xs text-slate-500">City or Town</div>
                      <div className="text-sm font-medium text-slate-900">{job.location}</div>
                    </div>
                  </div>

                  {job.closing_date && (
                    <div className={`flex items-start gap-3 -mx-1 -my-0.5 px-1 py-0.5 rounded-lg transition-colors ${
                      isClosingSoon ? 'bg-amber-50 border-2 border-amber-200' : ''
                    }`}>
                      <Clock className={`w-5 h-5 mt-0.5 flex-shrink-0 ${isClosingSoon ? 'text-amber-600' : 'text-slate-500'}`} />
                      <div className="flex-1">
                        <div className={`text-xs ${isClosingSoon ? 'text-amber-700 font-medium' : 'text-slate-500'}`}>
                          Application Deadline
                        </div>
                        <div className={`text-sm font-medium ${isClosingSoon ? 'text-amber-900' : 'text-slate-900'}`}>
                          {format(new Date(job.closing_date), 'd MMM, yyyy')}
                        </div>
                        {isClosingSoon && daysUntilClosing !== null && (
                          <div className="text-xs text-amber-700 mt-1">
                            {daysUntilClosing === 0 ? 'Closes today!' : `${daysUntilClosing} ${daysUntilClosing === 1 ? 'day' : 'days'} remaining`}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {job.attachment_urls && job.attachment_urls.length > 0 && (
                    <div className="pt-2 border-t border-slate-200">
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <FileText className="w-4 h-4" />
                        <span>{job.attachment_urls.length} {job.attachment_urls.length === 1 ? 'document' : 'documents'} attached</span>
                      </div>
                    </div>
                  )}
                </div>

                {job.featured && (
                  <Badge className="w-full justify-center bg-amber-100 text-amber-700">
                    Featured Position
                  </Badge>
                )}

                {/* Social Share Section */}
                <div className="pt-4 border-t border-slate-200">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                      <Share2 className="w-4 h-4" />
                      Share this job
                    </h3>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleLinkedInShare}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0A66C2] hover:bg-[#004182] text-white rounded-lg transition-colors"
                      title="Share on LinkedIn"
                    >
                      <Linkedin className="w-4 h-4" />
                      <span className="text-sm font-medium">LinkedIn</span>
                    </button>
                    <button
                      onClick={handleEmailShare}
                      className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-600 hover:bg-slate-700 text-white rounded-lg transition-colors"
                      title="Share via Email"
                    >
                      <Mail className="w-4 h-4" />
                      <span className="text-sm font-medium">Email</span>
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
