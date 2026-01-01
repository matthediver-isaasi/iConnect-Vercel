import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, MapPin, Building2, Clock, Briefcase, Plus, Star, AlertCircle, ArrowUpDown } from "lucide-react";
import { format, differenceInDays, isPast } from "date-fns";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useBelowFirstElementBanners } from "@/contexts/BannerContext";
import PortalHeroBanner from "@/components/banners/PortalHeroBanner";
import PageBannerDisplay from "@/components/banners/PageBannerDisplay";

const stripHtml = (html) => {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
};

export default function JobBoardPage() {
  const { hasBanner } = useLayoutContext();
  const belowFirstElementBanners = useBelowFirstElementBanners();
  const [searchQuery, setSearchQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [jobTypeFilter, setJobTypeFilter] = useState("all");
  const [hoursFilter, setHoursFilter] = useState("all");
  const [sortBy, setSortBy] = useState("posted-newest");

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['public-jobs'],
    queryFn: async () => {
      const allJobs = await base44.entities.JobPosting.filter({ status: 'active' });
      // Filter out expired jobs (based on closing_date)
      const now = new Date();
      return allJobs.filter(job => {
        if (!job.closing_date) return true; // Keep jobs without closing date
        return new Date(job.closing_date) > now;
      });
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch job type options from settings
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

  // Fetch hours options from settings
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

  const filteredJobs = useMemo(() => {
    let filtered = jobs.filter(job => {
      const matchesSearch = !searchQuery || 
        job.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        job.company_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        stripHtml(job.description).toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesLocation = !locationFilter ||
        job.location?.toLowerCase().includes(locationFilter.toLowerCase());
      
      const matchesType = jobTypeFilter === 'all' || job.job_type === jobTypeFilter;
      const matchesHours = hoursFilter === 'all' || job.hours === hoursFilter;

      return matchesSearch && matchesLocation && matchesType && matchesHours;
    });

    // Apply sorting
    filtered.sort((a, b) => {
      // Featured jobs always come first regardless of sort
      if (a.featured && !b.featured) return -1;
      if (!a.featured && b.featured) return 1;

      // Then apply selected sort
      switch (sortBy) {
        case 'posted-newest':
          return new Date(b.created_date) - new Date(a.created_date);
        case 'posted-oldest':
          return new Date(a.created_date) - new Date(b.created_date);
        case 'closing-soonest':
          // Jobs without closing date go to the end
          if (!a.closing_date && !b.closing_date) return 0;
          if (!a.closing_date) return 1;
          if (!b.closing_date) return -1;
          return new Date(a.closing_date) - new Date(b.closing_date);
        case 'closing-latest':
          // Jobs without closing date go to the end
          if (!a.closing_date && !b.closing_date) return 0;
          if (!a.closing_date) return 1;
          if (!b.closing_date) return -1;
          return new Date(b.closing_date) - new Date(a.closing_date);
        default:
          return new Date(b.created_date) - new Date(a.created_date);
      }
    });

    return filtered;
  }, [jobs, searchQuery, locationFilter, jobTypeFilter, hoursFilter, sortBy]);

  // Helper to check if job is closing soon (within 7 days)
  const isClosingSoon = (closingDate) => {
    if (!closingDate) return false;
    const daysUntilClosing = differenceInDays(new Date(closingDate), new Date());
    return daysUntilClosing >= 0 && daysUntilClosing <= 7;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 overflow-x-hidden">
      <div className="max-w-7xl mx-auto w-full">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Job Board</h1>
              <p className="text-slate-600">Find your next career opportunity</p>
            </div>
            <Button 
              onClick={() => window.location.href = createPageUrl('PostJob')}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <Plus className="w-4 h-4 mr-2" />
              Post a Job
            </Button>
          </div>
        )}
        
        {/* Below-first-element banners */}
        {belowFirstElementBanners.length > 0 && (
          <div className="w-full mb-8 -mx-4 md:-mx-8">
            {belowFirstElementBanners.map((banner) => (
              banner.banner_type === 'image'
                ? <PageBannerDisplay key={banner.id} banner={banner} />
                : <PortalHeroBanner key={banner.id} banner={banner} />
            ))}
          </div>
        )}
        
        {/* Filters */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardContent className="p-4 md:p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 md:gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search jobs or companies..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="City or Town..."
                  value={locationFilter}
                  onChange={(e) => setLocationFilter(e.target.value)}
                  className="pl-10"
                />
              </div>
              <select
                value={jobTypeFilter}
                onChange={(e) => setJobTypeFilter(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-slate-200 bg-white text-sm"
              >
                <option value="all">All Job Types</option>
                {jobTypeSettings.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
              <select
                value={hoursFilter}
                onChange={(e) => setHoursFilter(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-slate-200 bg-white text-sm"
              >
                <option value="all">All Hours</option>
                {hoursSettings.map(hour => (
                  <option key={hour} value={hour}>{hour}</option>
                ))}
              </select>
              <div className="relative">
                <ArrowUpDown className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="w-full h-10 pl-10 pr-3 rounded-md border border-slate-200 bg-white text-sm"
                >
                  <option value="posted-newest">Posted: Newest First</option>
                  <option value="posted-oldest">Posted: Oldest First</option>
                  <option value="closing-soonest">Closing: Soonest First</option>
                  <option value="closing-latest">Closing: Latest First</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results Count */}
        <div className="mb-6">
          <p className="text-slate-600 font-medium">
            {filteredJobs.length} {filteredJobs.length === 1 ? 'job' : 'jobs'} found
          </p>
        </div>

        {/* Job Listings - 2 Column Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
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
              <p className="text-slate-600">Try adjusting your search filters</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
            {filteredJobs.map((job) => {
              const closingSoon = job.closing_date && isClosingSoon(job.closing_date);
              const daysUntilClosing = job.closing_date ? differenceInDays(new Date(job.closing_date), new Date()) : null;

              return (
                <Link key={job.id} to={createPageUrl(`JobDetails?id=${job.id}`)} className="min-w-0">
                  <Card className={`border-slate-200 hover:shadow-xl transition-all cursor-pointer h-full group overflow-hidden ${
                    closingSoon ? 'border-l-4 border-l-amber-500 hover:border-amber-300' : 'hover:border-blue-300'
                  }`}>
                    <CardContent className="p-4 md:p-6">
                      {/* Closing Soon Banner */}
                      {closingSoon && (
                        <div className="mb-4 -mx-4 md:-mx-6 -mt-4 md:-mt-6 px-4 md:px-6 py-2 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-amber-200 flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 text-amber-600" />
                          <span className="text-sm font-medium text-amber-900">
                            Closing {daysUntilClosing === 0 ? 'today' : `in ${daysUntilClosing} ${daysUntilClosing === 1 ? 'day' : 'days'}`}
                          </span>
                        </div>
                      )}

                      {/* Header with Logo and Featured Badge */}
                      <div className="flex items-start gap-4 mb-4">
                        {job.company_logo_url ? (
                          <div className="w-16 h-16 flex-shrink-0 bg-slate-50 rounded-lg p-2 border border-slate-200 group-hover:border-blue-200 transition-colors">
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
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="text-lg font-bold text-slate-900 line-clamp-2 group-hover:text-blue-600 transition-colors">
                              {job.title}
                            </h3>
                            {job.featured && (
                              <Star className="w-5 h-5 text-amber-500 fill-amber-500 flex-shrink-0" />
                            )}
                          </div>
                          <p className="text-sm font-medium text-slate-700 mt-1">{job.company_name}</p>
                        </div>
                      </div>

                      {/* Job Details */}
                      <div className="space-y-3 mb-4">
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <MapPin className="w-4 h-4 flex-shrink-0" />
                          <span>{job.location}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <Clock className="w-4 h-4 flex-shrink-0" />
                          <span>Posted {format(new Date(job.created_date), 'd MMM, yyyy')}</span>
                        </div>
                        {job.closing_date && (
                          <div className="flex items-center gap-2 text-sm">
                            <Clock className="w-4 h-4 flex-shrink-0 text-slate-600" />
                            <span className={closingSoon ? 'font-semibold text-amber-700' : 'text-slate-600'}>
                              Closes {format(new Date(job.closing_date), 'd MMM, yyyy')}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Badges */}
                      <div className="flex flex-wrap gap-2 mb-4">
                        {job.job_type && (
                          <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-200">
                            {job.job_type}
                          </Badge>
                        )}
                        {job.hours && (
                          <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-200">
                            {job.hours}
                          </Badge>
                        )}
                        {job.salary_range && (
                          <Badge variant="outline" className="border-slate-300">
                            {job.salary_range}
                          </Badge>
                        )}
                      </div>

                      {/* Description Preview */}
                      <p className="text-sm text-slate-600 line-clamp-3 leading-relaxed">
                        {stripHtml(job.description).substring(0, 180)}...
                      </p>

                      {/* View Details Link */}
                      <div className="mt-4 pt-4 border-t border-slate-200">
                        <span className="text-sm font-medium text-blue-600 group-hover:text-blue-700 inline-flex items-center gap-1">
                          View Details
                          <svg className="w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}