import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Briefcase, CheckCircle, ArrowRight, Mail, ExternalLink, Upload, X, FileText, Image as ImageIcon, FileCheck, CreditCard, AlertCircle, ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { useMemberAccess } from "@/hooks/useMemberAccess";

// Load Stripe outside component to avoid recreating on every render
let stripePromise = null;

// Stripe Payment Form Component
function StripePaymentForm({ clientSecret, onSuccess, onCancel, amount }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const { error: submitError } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}${createPageUrl('JobPostSuccess')}`
        },
        redirect: 'if_required'
      });

      if (submitError) {
        setError(submitError.message);
        setProcessing(false);
      } else {
        onSuccess();
      }
    } catch (err) {
      console.error("Stripe confirmPayment error:", err);
      setError(err.message);
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-sm text-blue-900">
          <strong>Amount to charge:</strong> £{amount.toFixed(2)}
        </p>
        <p className="text-xs text-slate-600 mt-1">
          90-day job listing on the Graduate Futures Job Board
        </p>
      </div>

      <div>
        <PaymentElement options={{ layout: "tabs" }} />
      </div>

      {error &&
      <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="w-4 h-4 mr-0.5 mt-0.5 text-red-600 shrink-0" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      }

      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={processing}
          className="flex-1">

          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!stripe || processing}
          className="flex-1 bg-blue-600 hover:bg-blue-700">

          {processing ?
          <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </> :

          `Pay £${amount.toFixed(2)}`
          }
        </Button>
      </div>
    </form>);

}

export default function PostJobPage() {
  const { memberInfo, organizationInfo } = useMemberAccess();

  const [step, setStep] = useState('email'); // 'email', 'form', 'submitting'
  const [email, setEmail] = useState('');
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [isMember, setIsMember] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showTermsDialog, setShowTermsDialog] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [jobPostingId, setJobPostingId] = useState(null);
  const [stripeClientSecret, setStripeClientSecret] = useState(null);
  const [stripePaymentIntentId, setStripePaymentIntentId] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState(50.00);

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    company_name: '',
    company_logo_url: '',
    location: '',
    salary_range: '',
    job_type: '',
    hours: '',
    closing_date: '',
    application_method: 'email',
    application_value: '',
    contact_name: '',
    attachment_urls: [],
    attachment_names: []
  });

  // Initialize Stripe
  useEffect(() => {
    const initStripe = async () => {
      try {
        const response = await base44.functions.invoke('getStripePublishableKey');
        if (response.data.publishableKey) {
          stripePromise = loadStripe(response.data.publishableKey);
        } else {
          console.warn('Stripe publishable key not found in response.');
        }
      } catch (error) {
        console.error('Failed to load Stripe publishable key:', error);
      }
    };
    initStripe();
  }, []);

  // Fetch terms and conditions from settings
  const { data: termsSettings } = useQuery({
    queryKey: ['job-terms-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find((s) => s.setting_key === 'job_posting_terms');
      if (setting) {
        try {
          return JSON.parse(setting.setting_value);
        } catch (e) {
          return null;
        }
      }
      return null;
    }
  });

  // Fetch job type options from settings
  const { data: jobTypeSettings = [] } = useQuery({
    queryKey: ['job-type-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find((s) => s.setting_key === 'job_types');
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
      const setting = allSettings.find((s) => s.setting_key === 'job_hours');
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

  // Fetch job posting price from settings
  const { data: jobPostingPrice = 50.00 } = useQuery({
    queryKey: ['job-posting-price'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find((s) => s.setting_key === 'job_posting_price');
      if (setting) {
        try {
          return parseFloat(setting.setting_value);
        } catch (e) {
          return 50.00;
        }
      }
      return 50.00;
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Update payment amount when jobPostingPrice changes
  useEffect(() => {
    if (jobPostingPrice) {
      setPaymentAmount(jobPostingPrice);
    }
  }, [jobPostingPrice]);

  // Initialize from props (portal mode) or sessionStorage (public mode)
  useEffect(() => {
    if (memberInfo) {
      // Portal mode - member is logged in via props
      setIsLoggedIn(true);
      setIsMember(true);
      setEmail(memberInfo.email);
      setStep('form');

      setFormData((prev) => ({
        ...prev,
        company_name: organizationInfo?.name || '',
        contact_name: `${memberInfo.first_name} ${memberInfo.last_name}`,
        job_type: jobTypeSettings[0] || '',
        hours: hoursSettings[0] || ''
      }));
    } else {
      // Public mode - check sessionStorage
      const member = sessionStorage.getItem('agcas_member');
      if (member) {
        const memberData = JSON.parse(member);
        setIsLoggedIn(true);
        setIsMember(true);
        setEmail(memberData.email);
        setStep('form');

        const fetchOrganization = async () => {
          if (memberData.organization_id) {
            try {
              const allOrgs = await base44.entities.Organization.list();
              const org = allOrgs.find((o) => o.id === memberData.organization_id);
              if (org) {
                setFormData((prev) => ({
                  ...prev,
                  company_name: org.name,
                  contact_name: `${memberData.first_name} ${memberData.last_name}`,
                  job_type: jobTypeSettings[0] || '',
                  hours: hoursSettings[0] || ''
                }));
              }
            } catch (error) {
              console.error('Failed to fetch organization:', error);
            }
          }
        };

        fetchOrganization();
      }
    }
  }, [memberInfo, organizationInfo, jobTypeSettings, hoursSettings]);

  const handleEmailCheck = async (e) => {
    e.preventDefault();
    setCheckingEmail(true);

    try {
      const response = await base44.functions.invoke('checkMemberStatusByEmail', { email });

      if (response.data.is_member) {
        setIsMember(true);
        toast.info('Please log in to post your job for free');
        setTimeout(() => {
          window.location.href = createPageUrl('Home') + '?returnTo=' + encodeURIComponent(window.location.pathname);
        }, 2000);
      } else {
        setIsMember(false);
        setFormData((prev) => ({
          ...prev,
          job_type: jobTypeSettings[0] || '',
          hours: hoursSettings[0] || ''
        }));
        setStep('form');
      }
    } catch (error) {
      toast.error('Failed to verify email. Please try again.');
    } finally {
      setCheckingEmail(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Only image files (JPEG, PNG, GIF, WebP) are allowed');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be smaller than 5MB');
      return;
    }

    setUploadingLogo(true);

    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      setFormData((prev) => ({
        ...prev,
        company_logo_url: response.file_url
      }));
      toast.success('Logo uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload logo. Please try again.');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleRemoveLogo = () => {
    setFormData((prev) => ({
      ...prev,
      company_logo_url: ''
    }));
  };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];


    const invalidFiles = files.filter((file) => !allowedTypes.includes(file.type));
    if (invalidFiles.length > 0) {
      toast.error('Only PDF, Word, and Excel documents are allowed');
      return;
    }

    const oversizedFiles = files.filter((file) => file.size > 10 * 1024 * 1024);
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

      setFormData((prev) => ({
        ...prev,
        attachment_urls: [...prev.attachment_urls, ...uploadedFiles.map((f) => f.url)],
        attachment_names: [...prev.attachment_names, ...uploadedFiles.map((f) => f.name)]
      }));

      toast.success(`${files.length} ${files.length === 1 ? 'file' : 'files'} uploaded successfully`);
    } catch (error) {
      toast.error('Failed to upload files. Please try again.');
    } finally {
      setUploadingFiles(false);
    }
  };

  const handleRemoveAttachment = (index) => {
    setFormData((prev) => ({
      ...prev,
      attachment_urls: prev.attachment_urls.filter((_, i) => i !== index),
      attachment_names: prev.attachment_names.filter((_, i) => i !== index)
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.closing_date) {
      toast.error('Please select a closing date');
      return;
    }

    if (!agreedToTerms) {
      toast.error('Please agree to the Terms and Conditions');
      return;
    }

    setStep('submitting');

    try {
      if (isLoggedIn) {
        // Member posting - free
        const response = await base44.functions.invoke('createJobPostingMember', {
          ...formData,
          memberEmail: email
        });

        if (response.data.success) {
          toast.success('Job posting submitted successfully!');
          setTimeout(() => {
            window.location.href = createPageUrl('MyJobPostings');
          }, 500);
        } else {
          throw new Error(response.data.error || 'Failed to create job posting');
        }
      } else {
        // Non-member posting - requires payment
        const createResponse = await base44.functions.invoke('createJobPostingNonMember', {
          ...formData,
          contact_email: email
        });

        if (createResponse.data.success) {
          setJobPostingId(createResponse.data.job_id);

          const paymentResponse = await base44.functions.invoke('createJobPostingPaymentIntent', {
            amount: paymentAmount,
            currency: 'gbp',
            metadata: {
              job_posting_id: createResponse.data.job_id,
              contact_email: email,
              company_name: formData.company_name,
              job_title: formData.title
            }
          });

          if (paymentResponse.data.success) {
            setStripeClientSecret(paymentResponse.data.clientSecret);
            setStripePaymentIntentId(paymentResponse.data.paymentIntentId);
            setShowPaymentModal(true);
            setStep('form');
          } else {
            throw new Error('Failed to initialize payment: ' + (paymentResponse.data.error || 'Unknown error'));
          }
        } else {
          throw new Error(createResponse.data.error || 'Failed to create job posting');
        }
      }
    } catch (error) {
      toast.error(error.message || 'Failed to submit job posting');
      setStep('form');
    }
  };

  const handleStripePaymentSuccess = async () => {
    setShowPaymentModal(false);
    toast.success('Payment successful! Your job posting has been submitted for approval.');

    setTimeout(() => {
      window.location.href = createPageUrl('JobPostSuccess');
    }, 1500);
  };

  // PRIORITY CHECK: If member is logged in (via props or sessionStorage), skip email check
  // Only show email check form if NOT logged in AND step is 'email'
  if (!isLoggedIn && step === 'email') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md w-full border-slate-200 shadow-xl">
          <CardHeader>
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
              <Briefcase className="w-6 h-6 text-blue-600" />
            </div>
            <CardTitle>Post a Job</CardTitle>
            <CardDescription>
              Enter your email to get started. AGCAS members can post for free!
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleEmailCheck} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="your.email@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required />

              </div>
              <Button
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-700"
                disabled={checkingEmail}>

                {checkingEmail ?
                <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Checking...
                  </> :

                <>
                    Continue
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </>
                }
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>);

  }

  // All other cases: show the job posting form
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        {/* Back to Job Board link */}
        <Link 
          to={createPageUrl('JobBoard')} 
          className="inline-flex items-center text-sm text-slate-600 hover:text-blue-600 mb-4"
          data-testid="link-back-to-jobboard"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Job Board
        </Link>

        <Card className="border-slate-200 shadow-xl">
          <CardHeader>
            <CardTitle>
              {isLoggedIn ? 'Post a Job (Free for Members)' : 'Post a Job'}
            </CardTitle>
            <CardDescription>
              {isLoggedIn ?
              'Fill in the details below to post your job listing' :
              'Complete the form below. Payment will be processed after submission.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* ... keep all existing form fields exactly as they are ... */}
              <div className="space-y-2">
                <Label htmlFor="title">Job Title *</Label>
                <Input
                  id="title"
                  placeholder="e.g., Senior Careers Adviser"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  required />

              </div>

              <div className="space-y-2">
                <Label htmlFor="company_name">Company/Organisation *</Label>
                <Input
                  id="company_name"
                  placeholder="e.g., University of Example"
                  value={formData.company_name}
                  onChange={(e) => setFormData({ ...formData, company_name: e.target.value })}
                  disabled={isLoggedIn && organizationInfo}
                  className={isLoggedIn && organizationInfo ? 'bg-slate-100 cursor-not-allowed' : ''}
                  required />

                {isLoggedIn && organizationInfo &&
                <p className="text-xs text-slate-500">
                    Your organisation details are automatically filled from your member profile
                  </p>
                }
              </div>

              {/* ... keep all remaining form fields unchanged ... */}
              <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
                <div>
                  <h3 className="font-semibold text-slate-900 mb-1">Company Logo</h3>
                  <p className="text-sm text-slate-600">Upload your company logo (max 5MB, images only)</p>
                </div>

                {formData.company_logo_url ?
                <div className="space-y-3">
                    <div className="flex items-center gap-4 p-4 bg-white rounded-lg border border-slate-200">
                      <div className="w-24 h-24 flex-shrink-0 bg-slate-50 rounded-lg p-2 border border-slate-200">
                        <img
                        src={formData.company_logo_url}
                        alt="Company logo"
                        className="w-full h-full object-contain" />

                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900">Logo uploaded successfully</p>
                      </div>
                      <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRemoveLogo}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 flex-shrink-0">

                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                    <Label htmlFor="logo-change" className="cursor-pointer">
                      <div className="flex items-center justify-center gap-2 px-4 py-2 border-2 border-dashed border-slate-300 rounded-md hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <Upload className="w-4 h-4 text-slate-600" />
                        <span className="text-sm font-medium text-slate-600">Change Logo</span>
                      </div>
                      <input
                      id="logo-change"
                      type="file"
                      accept="image/*"
                      onChange={handleLogoUpload}
                      className="hidden"
                      disabled={uploadingLogo} />

                    </Label>
                  </div> :

                <Label htmlFor="logo-upload" className="cursor-pointer">
                    <div className="flex flex-col items-center justify-center gap-3 p-8 border-2 border-dashed border-slate-300 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors">
                      {uploadingLogo ?
                    <>
                          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                          <span className="text-sm font-medium text-slate-600">Uploading...</span>
                        </> :

                    <>
                          <ImageIcon className="w-8 h-8 text-slate-400" />
                          <div className="text-center">
                            <span className="text-sm font-medium text-slate-900 block">Upload Company Logo</span>
                            <span className="text-xs text-slate-500">Click to browse or drag and drop</span>
                          </div>
                        </>
                    }
                    </div>
                    <input
                    id="logo-upload"
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                    disabled={uploadingLogo} />

                  </Label>
                }
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="location">City or Town *</Label>
                  <Input
                    id="location"
                    placeholder="e.g., London, UK or Remote"
                    value={formData.location}
                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                    required />

                </div>

                <div className="space-y-2">
                  <Label htmlFor="salary_range" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Salary Range (Optional - please state currency)</Label>
                  <Input
                    id="salary_range"
                    placeholder="e.g., £30,000 - £40,000"
                    value={formData.salary_range}
                    onChange={(e) => setFormData({ ...formData, salary_range: e.target.value })} />

                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="job_type">Job Type</Label>
                  <Select
                    value={formData.job_type}
                    onValueChange={(value) => setFormData({ ...formData, job_type: value })}>

                    <SelectTrigger>
                      <SelectValue placeholder="Select job type" />
                    </SelectTrigger>
                    <SelectContent>
                      {jobTypeSettings.map((type) =>
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="hours">Hours</Label>
                  <Select
                    value={formData.hours}
                    onValueChange={(value) => setFormData({ ...formData, hours: value })}>

                    <SelectTrigger>
                      <SelectValue placeholder="Select hours" />
                    </SelectTrigger>
                    <SelectContent>
                      {hoursSettings.map((hour) =>
                      <SelectItem key={hour} value={hour}>{hour}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="closing_date">Application Closing Date *</Label>
                <Input
                  id="closing_date"
                  type="date"
                  value={formData.closing_date ? formData.closing_date.split('T')[0] : ''}
                  onChange={(e) => setFormData({ ...formData, closing_date: e.target.value + 'T23:59:59Z' })}
                  min={new Date().toISOString().split('T')[0]}
                  required />

                <p className="text-xs text-slate-500">When should applications close for this position?</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Job Description *</Label>
                <Textarea
                  id="description"
                  placeholder="Describe the role, responsibilities, requirements, etc."
                  rows={10}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  required />

              </div>

              <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-slate-900">Additional Documents</h3>
                    <p className="text-sm text-slate-600">Upload job packs, PDFs, or Word documents (max 10MB each)</p>
                  </div>
                  <Label htmlFor="file-upload" className="cursor-pointer">
                    <div className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
                      <Upload className="w-4 h-4" />
                      <span className="text-sm font-medium">Upload</span>
                    </div>
                    <input
                      id="file-upload"
                      type="file"
                      multiple
                      accept=".pdf,.doc,.docx,.xls,.xlsx"
                      onChange={handleFileUpload}
                      className="hidden"
                      disabled={uploadingFiles} />

                  </Label>
                </div>

                {uploadingFiles &&
                <div className="flex items-center gap-2 text-sm text-slate-600">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Uploading files...</span>
                  </div>
                }

                {formData.attachment_urls.length > 0 &&
                <div className="space-y-2">
                    {formData.attachment_names.map((name, index) =>
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
                      className="text-red-600 hover:text-red-700 hover:bg-red-50">

                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                  )}
                  </div>
                }
              </div>

              <div className="space-y-4 p-4 bg-slate-50 rounded-lg">
                <h3 className="font-semibold text-slate-900">Application Method</h3>
                
                <div className="space-y-2">
                  <Label>How should candidates apply? *</Label>
                  <Select
                    value={formData.application_method}
                    onValueChange={(value) => setFormData({ ...formData, application_method: value })}>

                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="email">
                        <div className="flex items-center">
                          <Mail className="w-4 h-4 mr-2" />
                          Email Application
                        </div>
                      </SelectItem>
                      <SelectItem value="url">
                        <div className="flex items-center">
                          <ExternalLink className="w-4 h-4 mr-2" />
                          External Application URL
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="application_value">
                    {formData.application_method === 'email' ? 'Application Email *' : 'Application URL *'}
                  </Label>
                  <Input
                    id="application_value"
                    type={formData.application_method === 'email' ? 'email' : 'url'}
                    placeholder={formData.application_method === 'email' ?
                    'jobs@example.com' :
                    'https://example.com/apply'}
                    value={formData.application_value}
                    onChange={(e) => setFormData({ ...formData, application_value: e.target.value })}
                    required />

                </div>
              </div>

              {!isLoggedIn &&
              <div className="space-y-2">
                  <Label htmlFor="contact_name">Your Name *</Label>
                  <Input
                  id="contact_name"
                  placeholder="Your full name"
                  value={formData.contact_name}
                  onChange={(e) => setFormData({ ...formData, contact_name: e.target.value })}
                  required />

                </div>
              }

              <div className="space-y-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <div className="flex items-center gap-2">
                  <FileCheck className="w-5 h-5 text-blue-600" />
                  <h3 className="font-semibold text-blue-900">Terms and Conditions</h3>
                </div>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="terms"
                    checked={agreedToTerms}
                    onCheckedChange={setAgreedToTerms}
                    className="mt-1" />

                  <div className="flex-1">
                    <Label htmlFor="terms" className="text-sm text-slate-700 cursor-pointer">
                      I agree to the{' '}
                      <button
                        type="button"
                        onClick={() => setShowTermsDialog(true)}
                        className="text-blue-600 hover:text-blue-700 underline font-medium">
                        {termsSettings?.title || 'Terms and Conditions'}
                      </button>
                      {' '}*
                    </Label>
                  </div>
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => window.location.href = createPageUrl('JobBoard')}
                  className="flex-1">

                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-1 bg-blue-600 hover:bg-blue-700"
                  disabled={step === 'submitting' || uploadingFiles || uploadingLogo || !agreedToTerms}>

                  {step === 'submitting' ?
                  <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Processing...
                    </> :
                  isLoggedIn ?
                  'Submit for Approval' :

                  'Continue to Payment'
                  }
                </Button>
              </div>

              {!isLoggedIn &&
              <p className="text-xs text-slate-500 text-center">
                  You'll enter payment details in a secure modal window
                </p>
              }
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Stripe Payment Modal */}
      <Dialog open={showPaymentModal} onOpenChange={setShowPaymentModal}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-blue-600" />
              Enter Payment Details
            </DialogTitle>
            <DialogDescription>
              Complete your job posting by entering your card information below.
            </DialogDescription>
          </DialogHeader>
          
          {stripeClientSecret && stripePromise &&
          <Elements stripe={stripePromise} options={{ clientSecret: stripeClientSecret }}>
              <StripePaymentForm
              clientSecret={stripeClientSecret}
              onSuccess={handleStripePaymentSuccess}
              onCancel={() => {
                setShowPaymentModal(false);
                setStripeClientSecret(null);
                setStripePaymentIntentId(null);
                setStep('form');
                toast.info('Payment cancelled. You can complete payment later from My Job Postings.');
              }}
              amount={paymentAmount} />

            </Elements>
          }
        </DialogContent>
      </Dialog>

      {/* Terms and Conditions Dialog */}
      <Dialog open={showTermsDialog} onOpenChange={setShowTermsDialog}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl">
              {termsSettings?.title || 'Graduate Futures Job Advertising Terms and Conditions'}
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4">
            {termsSettings?.content ? (
              <div 
                className="prose prose-slate max-w-none prose-headings:text-slate-900 prose-h3:text-lg prose-h3:font-semibold prose-h3:mb-2 prose-p:text-slate-700 prose-li:text-slate-700 prose-ul:space-y-1 prose-a:text-blue-600 hover:prose-a:underline"
                dangerouslySetInnerHTML={{ __html: termsSettings.content }}
              />
            ) : (
              <div className="space-y-4 text-slate-700">
                <p>Terms and conditions have not been configured. Please contact the administrator.</p>
              </div>
            )}
          </div>

          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => {
                setAgreedToTerms(true);
                setShowTermsDialog(false);
              }}
              className="bg-blue-600 hover:bg-blue-700">
              I Agree to Terms
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowTermsDialog(false)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>);

}