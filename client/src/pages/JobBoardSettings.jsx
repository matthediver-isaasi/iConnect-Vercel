import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Save, Plus, X, Settings, FileText } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { adminFetch } from "@/lib/adminFetch";
import ReactQuill from 'react-quill';

const defaultTermsContent = `<h3>1. Introduction</h3>
<p>These Terms apply to all job advertisements placed on the Graduate Futures website ("Job Board").</p>
<p>By submitting a vacancy, you agree to these Terms and the Privacy Policy.</p>

<h3>2. Eligibility and Content</h3>
<ul>
<li>Graduate Futures will only publish job vacancies directly relevant to the higher education careers and employability sector.</li>
<li>Graduate Futures reserves the right to edit or decline any advert that does not meet these criteria.</li>
<li>The Client is responsible for ensuring that all job descriptions and information are true, accurate, and non-discriminatory.</li>
<li>The Client agrees that all job advertisements submitted to the Graduate Futures Job Board comply with applicable UK employment legislation, including but not limited to the Equality Act 2010.</li>
<li>All data submitted by the client must comply with the UK GDPR and Graduate Futures Privacy Policy.</li>
</ul>

<h3>3. Submission and Publication</h3>
<ul>
<li>Job adverts can be submitted online via the Graduate Futures Job Board.</li>
<li>Publication is subject to Graduate Futures approval and full payment (where applicable).</li>
<li>Graduate Futures aims to publish approved adverts within 24 hours.</li>
</ul>

<h3>4. Fees and Payment</h3>
<ul>
<li>Non-member adverts are subject to the published rate.</li>
<li>Members may post vacancies in accordance with their membership benefits.</li>
<li>Payment must be made by credit/debit card.</li>
<li>All fees are payable in pounds sterling and exclusive of VAT.</li>
</ul>

<h3>5. Duration and Removal</h3>
<ul>
<li>Adverts will remain live on the website until the specified closing date, unless otherwise agreed.</li>
<li>Graduate Futures reserves the right to remove adverts early if they breach these Terms or upon the Client's written request.</li>
<li>Fees are non-refundable once an advert has gone live.</li>
</ul>

<h3>6. Refunds</h3>
<p>Refunds may only be issued where an advert cannot be published due to Graduate Futures error or technical failure.</p>
<p>Requests should be made in writing to info@graduatefutures.org.uk.</p>

<h3>7. Liability</h3>
<p>Graduate Futures accepts no responsibility for:</p>
<ul>
<li>Errors in content supplied by the Client;</li>
<li>Failure of an advert to attract candidates; or</li>
<li>Any indirect or consequential loss.</li>
</ul>

<h3>8. Contact</h3>
<p>info@graduatefutures.org.uk</p>

<h3>9. Right to amend</h3>
<p>Graduate Futures reserves the right to amend these Terms at any time.</p>`;

export default function JobBoardSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [price, setPrice] = useState('50');
  const [jobTypes, setJobTypes] = useState(['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship']);
  const [hours, setHours] = useState(['Full-time', 'Part-time', 'Flexible']);
  const [newJobType, setNewJobType] = useState('');
  const [newHour, setNewHour] = useState('');
  const [termsTitle, setTermsTitle] = useState('Graduate Futures Job Advertising Terms and Conditions');
  const [termsContent, setTermsContent] = useState(defaultTermsContent);
  const [feedConfig, setFeedConfig] = useState({
    keywords: '', exclusions: '', category: '', location: '',
    max_days_old: 30, result_limit: 25
  });
  const [feedStatus, setFeedStatus] = useState(null);
  const [feedPreview, setFeedPreview] = useState([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedAction, setFeedAction] = useState('');
  
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_JobBoardSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const loadFeedSettings = async () => {
    setFeedLoading(true);
    try {
      const response = await adminFetch('/api/admin/job-feed/adzuna', { credentials: 'include' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load Adzuna settings');
      setFeedStatus(data);
      setFeedConfig(prev => ({ ...prev, ...(data.config || {}) }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setFeedLoading(false);
    }
  };

  useEffect(() => {
    if (accessChecked) loadFeedSettings();
  }, [accessChecked]);

  const runFeedAction = async (action) => {
    setFeedAction(action);
    try {
      const response = await adminFetch('/api/admin/job-feed/adzuna', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...feedConfig })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Unable to ${action} Adzuna feed`);
      if (action === 'preview') {
        setFeedPreview(data.jobs || []);
        toast.success(`Found ${(data.jobs || []).length} matching jobs`);
      } else if (action === 'sync') {
        toast.success(`Adzuna sync completed: ${data.imported || 0} jobs imported or updated`);
        setFeedPreview([]);
        await loadFeedSettings();
      } else {
        toast.success('Adzuna feed settings saved');
        await loadFeedSettings();
      }
    } catch (error) {
      toast.error(error.message);
      await loadFeedSettings();
    } finally {
      setFeedAction('');
    }
  };

  const { data: priceSettings } = useQuery({
    queryKey: ['job-board-price-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'job_posting_price');
    }
  });

  const { data: jobTypeSettings } = useQuery({
    queryKey: ['job-type-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'job_types');
    }
  });

  const { data: hoursSettings } = useQuery({
    queryKey: ['hours-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'job_hours');
    }
  });

  const { data: termsSettings } = useQuery({
    queryKey: ['job-terms-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'job_posting_terms');
    }
  });

  useEffect(() => {
    if (priceSettings?.setting_value) {
      setPrice(priceSettings.setting_value);
    }
    if (jobTypeSettings?.setting_value) {
      try {
        const parsed = JSON.parse(jobTypeSettings.setting_value);
        setJobTypes(parsed);
      } catch (e) {
        console.error('Failed to parse job types:', e);
      }
    }
    if (hoursSettings?.setting_value) {
      try {
        const parsed = JSON.parse(hoursSettings.setting_value);
        setHours(parsed);
      } catch (e) {
        console.error('Failed to parse hours:', e);
      }
    }
    if (termsSettings?.setting_value) {
      try {
        const parsed = JSON.parse(termsSettings.setting_value);
        if (parsed.title) setTermsTitle(parsed.title);
        if (parsed.content) setTermsContent(parsed.content);
      } catch (e) {
        console.error('Failed to parse terms:', e);
      }
    }
  }, [priceSettings, jobTypeSettings, hoursSettings, termsSettings]);

  const savePriceMutation = useMutation({
    mutationFn: async (newPrice) => {
      if (priceSettings) {
        return await base44.entities.SystemSettings.update(priceSettings.id, {
          setting_value: newPrice
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'job_posting_price',
          setting_value: newPrice,
          description: 'Price in GBP for non-member job postings'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-board-price-settings'] });
      toast.success('Job posting price updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update price: ' + error.message);
    }
  });

  const saveJobTypesMutation = useMutation({
    mutationFn: async (types) => {
      const value = JSON.stringify(types);
      if (jobTypeSettings) {
        return await base44.entities.SystemSettings.update(jobTypeSettings.id, {
          setting_value: value
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'job_types',
          setting_value: value,
          description: 'Available job type options for job postings'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-type-settings'] });
      toast.success('Job types updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update job types: ' + error.message);
    }
  });

  const saveHoursMutation = useMutation({
    mutationFn: async (hourOptions) => {
      const value = JSON.stringify(hourOptions);
      if (hoursSettings) {
        return await base44.entities.SystemSettings.update(hoursSettings.id, {
          setting_value: value
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'job_hours',
          setting_value: value,
          description: 'Available hours options for job postings'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hours-settings'] });
      toast.success('Hours options updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update hours options: ' + error.message);
    }
  });

  const saveTermsMutation = useMutation({
    mutationFn: async ({ title, content }) => {
      const value = JSON.stringify({ title, content });
      if (termsSettings) {
        return await base44.entities.SystemSettings.update(termsSettings.id, {
          setting_value: value
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'job_posting_terms',
          setting_value: value,
          description: 'Terms and conditions for job postings'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-terms-settings'] });
      toast.success('Terms and conditions updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update terms: ' + error.message);
    }
  });

  const handleSavePrice = () => {
    const numPrice = parseFloat(price);
    if (!Number.isFinite(numPrice) || numPrice <= 0) {
      toast.error('Please enter a price greater than £0');
      return;
    }
    savePriceMutation.mutate(price);
  };

  const handleAddJobType = () => {
    if (!newJobType.trim()) return;
    if (jobTypes.includes(newJobType.trim())) {
      toast.error('This job type already exists');
      return;
    }
    const updated = [...jobTypes, newJobType.trim()];
    setJobTypes(updated);
    setNewJobType('');
    saveJobTypesMutation.mutate(updated);
  };

  const handleRemoveJobType = (type) => {
    const updated = jobTypes.filter(t => t !== type);
    setJobTypes(updated);
    saveJobTypesMutation.mutate(updated);
  };

  const handleAddHour = () => {
    if (!newHour.trim()) return;
    if (hours.includes(newHour.trim())) {
      toast.error('This hours option already exists');
      return;
    }
    const updated = [...hours, newHour.trim()];
    setHours(updated);
    setNewHour('');
    saveHoursMutation.mutate(updated);
  };

  const handleRemoveHour = (hour) => {
    const updated = hours.filter(h => h !== hour);
    setHours(updated);
    saveHoursMutation.mutate(updated);
  };

  const handleSaveTerms = () => {
    if (!termsTitle.trim()) {
      toast.error('Please enter a title for the terms');
      return;
    }
    if (!termsContent.trim()) {
      toast.error('Please enter the terms content');
      return;
    }
    saveTermsMutation.mutate({ title: termsTitle, content: termsContent });
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Job Board Settings
          </h1>
          <p className="text-slate-600">
            Configure pricing and dropdown options for the job board
          </p>
        </div>

        <div className="space-y-6">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Adzuna Job Feed</CardTitle>
              <CardDescription>
                Choose the UK vacancies to import. Preview uses the same search as manual and hourly syncs.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {feedLoading ? (
                <p className="text-sm text-slate-500">Loading feed settings...</p>
              ) : !feedStatus?.configured ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="font-medium text-amber-900">Adzuna is not connected and enabled.</p>
                  <p className="mt-1 text-sm text-amber-800">
                    Add credentials and enable the connection in{" "}
                    <a href="/admin/integrations" className="font-medium underline">Admin → Integrations</a>.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                  Adzuna is connected and enabled. Country is fixed to United Kingdom.
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="adzuna-keywords">Keywords or phrases</Label>
                  <Textarea id="adzuna-keywords" value={feedConfig.keywords || ''} onChange={e => setFeedConfig(p => ({ ...p, keywords: e.target.value }))} placeholder={'e.g. "career development" employability graduate'} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="adzuna-exclusions">Excluded words or phrases</Label>
                  <Textarea id="adzuna-exclusions" value={feedConfig.exclusions || ''} onChange={e => setFeedConfig(p => ({ ...p, exclusions: e.target.value }))} placeholder="e.g. sales retail" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adzuna-category">Adzuna category</Label>
                  <Input id="adzuna-category" value={feedConfig.category || ''} onChange={e => setFeedConfig(p => ({ ...p, category: e.target.value }))} placeholder="Optional category tag" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adzuna-location">Location</Label>
                  <Input id="adzuna-location" value={feedConfig.location || ''} onChange={e => setFeedConfig(p => ({ ...p, location: e.target.value }))} placeholder="e.g. London or United Kingdom" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adzuna-age">Maximum vacancy age (days)</Label>
                  <Input id="adzuna-age" type="number" min="1" max="90" value={feedConfig.max_days_old} onChange={e => setFeedConfig(p => ({ ...p, max_days_old: Number(e.target.value) }))} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adzuna-limit">Result limit</Label>
                  <Input id="adzuna-limit" type="number" min="1" max="50" value={feedConfig.result_limit} onChange={e => setFeedConfig(p => ({ ...p, result_limit: Number(e.target.value) }))} />
                </div>
              </div>

              {feedStatus?.config?.last_sync_at && (
                <div className={`rounded-lg border p-3 text-sm ${feedStatus.config.last_error ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                  <p>Last run: {new Date(feedStatus.config.last_sync_at).toLocaleString()}</p>
                  {feedStatus.config.last_success_at && <p>Last successful: {new Date(feedStatus.config.last_success_at).toLocaleString()}</p>}
                  {feedStatus.config.last_error
                    ? <p className="mt-1 font-medium">{feedStatus.config.last_error}</p>
                    : <p>{feedStatus.config.last_imported_count || 0} jobs imported or updated</p>}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button variant="outline" disabled={!!feedAction} onClick={() => runFeedAction('save')}>
                  <Save className="mr-2 h-4 w-4" /> {feedAction === 'save' ? 'Saving...' : 'Save Search'}
                </Button>
                <Button variant="outline" disabled={!!feedAction || !feedStatus?.configured} onClick={() => runFeedAction('preview')}>
                  {feedAction === 'preview' ? 'Loading Preview...' : 'Preview Matches'}
                </Button>
                <Button className="bg-blue-600 hover:bg-blue-700" disabled={!!feedAction || !feedStatus?.configured} onClick={() => runFeedAction('sync')}>
                  {feedAction === 'sync' ? 'Syncing...' : 'Run Manual Sync'}
                </Button>
              </div>

              {feedPreview.length > 0 && (
                <div className="space-y-2 border-t pt-4">
                  <h4 className="font-semibold text-slate-900">Preview ({feedPreview.length})</h4>
                  {feedPreview.map(job => (
                    <div key={job.external_id} className="rounded-lg border border-slate-200 p-3">
                      <p className="font-medium text-slate-900">{job.title}</p>
                      <p className="text-sm text-slate-600">{job.company_name} · {job.location}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Price Settings */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Non-Member Job Posting Price
              </CardTitle>
              <CardDescription>
                Set the price in GBP that non-members must pay to post a job listing
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="price">Price (GBP)</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-lg font-semibold text-slate-400">£</span>
                  <Input
                    id="price"
                    type="number"
                    step="0.01"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="pl-10"
                    placeholder="50.00"
                  />
                </div>
                <p className="text-sm text-slate-500">
                  Members can always post jobs for free
                </p>
              </div>

              <Button 
                onClick={handleSavePrice}
                disabled={savePriceMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-4 h-4 mr-2" />
                {savePriceMutation.isPending ? 'Saving...' : 'Save Price'}
              </Button>
            </CardContent>
          </Card>

          {/* Job Type Options */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                Job Type Options
              </CardTitle>
              <CardDescription>
                Configure the available options for the "Job Type" dropdown
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Add new job type..."
                  value={newJobType}
                  onChange={(e) => setNewJobType(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleAddJobType()}
                />
                <Button onClick={handleAddJobType} className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-2">
                {jobTypes.map((type) => (
                  <div key={type} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <span className="font-medium text-slate-700">{type}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveJobType(type)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Hours Options */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                Hours Options
              </CardTitle>
              <CardDescription>
                Configure the available options for the "Hours" dropdown
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Add new hours option..."
                  value={newHour}
                  onChange={(e) => setNewHour(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleAddHour()}
                />
                <Button onClick={handleAddHour} className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-2">
                {hours.map((hour) => (
                  <div key={hour} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <span className="font-medium text-slate-700">{hour}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveHour(hour)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Terms and Conditions */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5" />
                Terms and Conditions
              </CardTitle>
              <CardDescription>
                Edit the terms and conditions shown to users when posting a job
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="termsTitle">Title</Label>
                <Input
                  id="termsTitle"
                  value={termsTitle}
                  onChange={(e) => setTermsTitle(e.target.value)}
                  placeholder="Terms and Conditions Title"
                />
              </div>

              <div className="space-y-2">
                <Label>Content</Label>
                <div className="border rounded-lg overflow-hidden">
                  <ReactQuill
                    value={termsContent}
                    onChange={setTermsContent}
                    theme="snow"
                    modules={{
                      toolbar: [
                        [{ 'header': [1, 2, 3, false] }],
                        ['bold', 'italic', 'underline'],
                        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                        ['link'],
                        ['clean']
                      ]
                    }}
                    style={{ minHeight: '300px' }}
                  />
                </div>
                <p className="text-sm text-slate-500">
                  Use headings (H1, H2, H3) to structure your terms into sections
                </p>
              </div>

              <Button 
                onClick={handleSaveTerms}
                disabled={saveTermsMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-4 h-4 mr-2" />
                {saveTermsMutation.isPending ? 'Saving...' : 'Save Terms and Conditions'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}