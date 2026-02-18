import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Heart, Loader2, CheckCircle2, Users, Calendar,
  Plus, Trash2, User, ArrowRight, ArrowLeft, Building2
} from "lucide-react";
import { getTenantSlugFromLocation } from "@/api/publicClient";

function formatCurrency(amount, currency) {
  const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac' };
  const symbol = symbols[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

function ProgressBar({ percent }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="relative w-full rounded-full h-3 overflow-hidden"
         style={{ background: 'linear-gradient(90deg, #ef4444 0%, #f59e0b 40%, #22c55e 100%)' }}>
      <div
        className="absolute top-0 right-0 h-full bg-muted/80 rounded-r-full transition-all duration-700"
        style={{ width: `${100 - clamped}%` }}
      />
      {clamped > 0 && clamped < 100 && (
        <div
          className="absolute top-1/2 -translate-y-1/2 w-1 rounded-full bg-foreground shadow-sm transition-all duration-700"
          style={{ left: `calc(${clamped}% - 2px)`, height: 'calc(100% + 4px)' }}
        />
      )}
    </div>
  );
}

function StepIndicator({ steps, currentStep }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-6">
      {steps.map((step, index) => {
        const isCompleted = index < currentStep;
        const isActive = index === currentStep;
        const isUpcoming = index > currentStep;

        return (
          <div key={step.id} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                data-testid={`step-indicator-${index}`}
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors duration-300 ${
                  isCompleted
                    ? 'bg-primary text-primary-foreground'
                    : isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  index + 1
                )}
              </div>
              <span className={`text-xs mt-1.5 whitespace-nowrap ${
                isCompleted || isActive ? 'text-primary font-medium' : 'text-muted-foreground'
              }`}>
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={`h-0.5 w-10 sm:w-16 mx-1 sm:mx-2 mt-[-1.25rem] transition-colors duration-300 ${
                  index < currentStep ? 'bg-primary' : 'bg-muted'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function CampaignRegisterPage() {
  const { slug } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [formState, setFormState] = useState('form');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);

  const [currentStep, setCurrentStep] = useState(0);
  const [stepDirection, setStepDirection] = useState(1);
  const [isAnimating, setIsAnimating] = useState(false);
  const [validationErrors, setValidationErrors] = useState({});

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [individualGoal, setIndividualGoal] = useState('');
  const [teamMembers, setTeamMembers] = useState([{ first_name: '', last_name: '', email: '' }]);

  const [orgName, setOrgName] = useState('');
  const [orgAddress, setOrgAddress] = useState('');
  const [orgCity, setOrgCity] = useState('');
  const [orgPostcode, setOrgPostcode] = useState('');
  const [orgCountry, setOrgCountry] = useState('');
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [orgSuggestions, setOrgSuggestions] = useState([]);
  const [showOrgSuggestions, setShowOrgSuggestions] = useState(false);
  const [orgSearchLoading, setOrgSearchLoading] = useState(false);
  const orgDebounceRef = useRef(null);

  useEffect(() => {
    return () => { if (orgDebounceRef.current) clearTimeout(orgDebounceRef.current); };
  }, []);

  const searchOrganisations = (searchTerm) => {
    if (orgDebounceRef.current) clearTimeout(orgDebounceRef.current);

    if (!searchTerm || searchTerm.trim().length < 2) {
      setOrgSuggestions([]);
      setShowOrgSuggestions(false);
      return;
    }

    setOrgSearchLoading(true);
    orgDebounceRef.current = setTimeout(async () => {
      try {
        const tenantSlug = getTenantSlugFromLocation();
        const params = new URLSearchParams({ q: searchTerm.trim() });
        if (tenantSlug) params.set('tenant', tenantSlug);
        const res = await fetch(`/api/public/fundraising/search-organisations?${params}`);
        if (res.ok) {
          const data = await res.json();
          setOrgSuggestions(data);
          setShowOrgSuggestions(data.length > 0);
        }
      } catch (err) {
        console.error('Org search error:', err);
      } finally {
        setOrgSearchLoading(false);
      }
    }, 300);
  };

  const handleOrgNameChange = (value) => {
    setOrgName(value);
    setSelectedOrgId(null);
    searchOrganisations(value);
  };

  const selectOrganisation = (org) => {
    setOrgName(org.name);
    setSelectedOrgId(org.id);
    setOrgCity(org.city || '');
    setOrgSuggestions([]);
    setShowOrgSuggestions(false);
  };

  useEffect(() => {
    if (!slug) return;
    const tenantSlug = getTenantSlugFromLocation();
    const url = tenantSlug
      ? `/api/public/fundraising/campaign?slug=${encodeURIComponent(slug)}&tenant=${encodeURIComponent(tenantSlug)}`
      : `/api/public/fundraising/campaign?slug=${encodeURIComponent(slug)}`;

    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error('Campaign not found');
        return res.json();
      })
      .then(data => {
        setCampaign(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [slug]);

  const isTeamCampaign = campaign?.campaign_type === 'team';
  const maxTeamSize = campaign?.max_team_size || 5;
  const maxAdditionalMembers = maxTeamSize - 1;

  const wizardSteps = useMemo(() => {
    if (!campaign) return [];
    const steps = [];
    if (campaign.allow_org_signup) {
      steps.push({ id: 'organisation', label: 'Organisation' });
    }
    steps.push({
      id: 'details',
      label: campaign.campaign_type === 'team' ? 'Team Leader Details' : 'Your Details'
    });
    if (campaign.campaign_type === 'team') {
      steps.push({ id: 'team', label: 'Team Members' });
    }
    return steps;
  }, [campaign]);

  useEffect(() => {
    if (wizardSteps.length > 0 && currentStep >= wizardSteps.length) {
      setCurrentStep(0);
    }
  }, [wizardSteps.length, currentStep]);

  const isLastStep = currentStep === wizardSteps.length - 1;
  const isFirstStep = currentStep === 0;
  const currentStepId = wizardSteps[currentStep]?.id;

  const validateCurrentStep = () => {
    const errors = {};

    if (currentStepId === 'details') {
      if (!firstName.trim()) errors.firstName = 'First name is required';
      if (!lastName.trim()) errors.lastName = 'Last name is required';
      if (!email.trim()) errors.email = 'Email is required';
      else if (!/\S+@\S+\.\S+/.test(email.trim())) errors.email = 'Please enter a valid email';
    }

    if (currentStepId === 'team') {
      const validMembers = teamMembers.filter(m => m.first_name.trim() && m.last_name.trim());
      if (validMembers.length === 0) {
        errors.teamMembers = 'Please add at least one team member with first and last name';
      } else {
        const missingEmails = validMembers.some(m => !m.email.trim() || !/\S+@\S+\.\S+/.test(m.email.trim()));
        if (missingEmails) {
          errors.teamMemberEmails = 'Each team member needs a valid email address';
        }
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const goToNextStep = () => {
    if (!validateCurrentStep()) return;
    setValidationErrors({});
    setSubmitError(null);
    setStepDirection(1);
    setIsAnimating(true);
    setTimeout(() => {
      setCurrentStep(prev => Math.min(prev + 1, wizardSteps.length - 1));
      setIsAnimating(false);
    }, 200);
  };

  const goToPrevStep = () => {
    setValidationErrors({});
    setSubmitError(null);
    setStepDirection(-1);
    setIsAnimating(true);
    setTimeout(() => {
      setCurrentStep(prev => Math.max(prev - 1, 0));
      setIsAnimating(false);
    }, 200);
  };

  const addTeamMember = () => {
    if (teamMembers.length < maxAdditionalMembers) {
      setTeamMembers(prev => [...prev, { first_name: '', last_name: '', email: '' }]);
    }
  };

  const removeTeamMember = (index) => {
    setTeamMembers(prev => prev.filter((_, i) => i !== index));
  };

  const updateTeamMember = (index, field, value) => {
    setTeamMembers(prev => prev.map((m, i) => i === index ? { ...m, [field]: value } : m));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isLastStep) return;
    if (!validateCurrentStep()) return;
    setSubmitError(null);

    if (!firstName.trim() || !lastName.trim()) {
      setSubmitError('Please enter your first and last name');
      return;
    }
    if (!email.trim()) {
      setSubmitError('Please enter your email address');
      return;
    }

    if (isTeamCampaign) {
      const validTeamMembers = teamMembers.filter(m => m.first_name.trim() && m.last_name.trim());
      if (validTeamMembers.length === 0) {
        setSubmitError('Please add at least one team member');
        return;
      }
    }

    setSubmitting(true);

    try {
      const tenantSlug = getTenantSlugFromLocation();
      const url = tenantSlug
        ? `/api/public/fundraising/register?tenant=${encodeURIComponent(tenantSlug)}`
        : `/api/public/fundraising/register`;

      const body = {
        campaign_slug: slug,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        individual_goal: individualGoal ? parseFloat(individualGoal) : null,
      };

      if (campaign.allow_org_signup && orgName.trim()) {
        if (selectedOrgId) {
          body.existing_organisation_id = selectedOrgId;
        } else {
          body.organisation = {
            name: orgName.trim(),
            address: orgAddress.trim() || null,
            city: orgCity.trim() || null,
            postcode: orgPostcode.trim() || null,
            country: orgCountry.trim() || null
          };
        }
      }

      if (isTeamCampaign) {
        body.team_members = teamMembers
          .filter(m => m.first_name.trim() && m.last_name.trim())
          .map(m => ({
            first_name: m.first_name.trim(),
            last_name: m.last_name.trim(),
            email: m.email.trim() || null
          }));
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      setResult(data);
      setFormState('success');
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="p-4 rounded-full bg-muted inline-block mb-4">
              <Heart className="w-8 h-8 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold mb-2">Campaign Not Found</h2>
            <p className="text-muted-foreground text-sm">
              This campaign may have ended or the link may be incorrect.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!campaign.registration_open) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="p-4 rounded-full bg-muted inline-block mb-4">
              <Users className="w-8 h-8 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold mb-2">{campaign.name}</h2>
            <p className="text-muted-foreground text-sm">
              Registration is currently closed for this campaign.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const progressPercent = campaign.goal_amount > 0
    ? Math.min(100, Math.round((campaign.total_raised / parseFloat(campaign.goal_amount)) * 100))
    : 0;

  const animationStyle = {
    transition: 'opacity 200ms ease, transform 200ms ease',
    opacity: isAnimating ? 0 : 1,
    transform: isAnimating
      ? `translateX(${stepDirection * 30}px)`
      : 'translateX(0)',
  };

  const renderOrganisationStep = () => (
    <div className="space-y-4">
      <p className="text-sm font-medium flex items-center gap-2">
        <Building2 className="w-4 h-4" />
        Organisation Details
      </p>
      <p className="text-sm text-muted-foreground">
        Link your registration to an organisation. This step is optional - you can skip it.
      </p>
      <div className="space-y-1.5 relative">
        <Label>Organisation Name</Label>
        <div className="relative">
          <Input
            value={orgName}
            onChange={(e) => handleOrgNameChange(e.target.value)}
            onFocus={() => { if (orgSuggestions.length > 0 && !selectedOrgId) setShowOrgSuggestions(true); }}
            onBlur={() => setTimeout(() => setShowOrgSuggestions(false), 200)}
            placeholder="Start typing to search..."
            autoComplete="off"
            data-testid="input-org-name"
          />
          {orgSearchLoading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
          )}
        </div>
        {selectedOrgId && (
          <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            Matched to existing organisation
          </p>
        )}
        {showOrgSuggestions && orgSuggestions.length > 0 && (
          <div className="absolute left-0 right-0 z-50 mt-1 border rounded-md bg-popover shadow-md max-h-48 overflow-y-auto" data-testid="org-suggestions-dropdown">
            {orgSuggestions.map((org) => (
              <button
                key={org.id}
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover-elevate cursor-pointer flex items-center justify-between gap-2"
                onMouseDown={(e) => { e.preventDefault(); selectOrganisation(org); }}
                data-testid={`org-suggestion-${org.id}`}
              >
                <span className="font-medium truncate">{org.name}</span>
                {org.city && <span className="text-xs text-muted-foreground flex-shrink-0">{org.city}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {!selectedOrgId && (
        <>
          <div className="space-y-1.5">
            <Label>Address</Label>
            <Input
              value={orgAddress}
              onChange={(e) => setOrgAddress(e.target.value)}
              placeholder="Street address"
              data-testid="input-org-address"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input
                value={orgCity}
                onChange={(e) => setOrgCity(e.target.value)}
                placeholder="City"
                data-testid="input-org-city"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Postcode</Label>
              <Input
                value={orgPostcode}
                onChange={(e) => setOrgPostcode(e.target.value)}
                placeholder="Postcode"
                data-testid="input-org-postcode"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Country</Label>
            <Input
              value={orgCountry}
              onChange={(e) => setOrgCountry(e.target.value)}
              placeholder="Country"
              data-testid="input-org-country"
            />
          </div>
        </>
      )}
    </div>
  );

  const renderDetailsStep = () => (
    <div className="space-y-4">
      <p className="text-sm font-medium flex items-center gap-2">
        <User className="w-4 h-4" />
        {isTeamCampaign ? 'Team Leader Details' : 'Your Details'}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>First Name *</Label>
          <Input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name"
            data-testid="input-first-name"
          />
          {validationErrors.firstName && (
            <p className="text-xs text-destructive">{validationErrors.firstName}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Last Name *</Label>
          <Input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            data-testid="input-last-name"
          />
          {validationErrors.lastName && (
            <p className="text-xs text-destructive">{validationErrors.lastName}</p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Email *</Label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          data-testid="input-email"
        />
        {validationErrors.email && (
          <p className="text-xs text-destructive">{validationErrors.email}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label>Personal Fundraising Goal (optional)</Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
            {campaign.currency === 'GBP' ? '\u00a3' : campaign.currency === 'EUR' ? '\u20ac' : '$'}
          </span>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={individualGoal}
            onChange={(e) => setIndividualGoal(e.target.value)}
            placeholder="0.00"
            className="pl-7"
            data-testid="input-individual-goal"
          />
        </div>
      </div>
    </div>
  );

  const renderTeamStep = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm font-medium flex items-center gap-2">
          <Users className="w-4 h-4" />
          Team Members ({teamMembers.length}/{maxAdditionalMembers})
        </p>
        {teamMembers.length < maxAdditionalMembers && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTeamMember}
            data-testid="button-add-team-member"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add Member
          </Button>
        )}
      </div>

      {validationErrors.teamMembers && (
        <p className="text-xs text-destructive">{validationErrors.teamMembers}</p>
      )}
      {validationErrors.teamMemberEmails && (
        <p className="text-xs text-destructive">{validationErrors.teamMemberEmails}</p>
      )}

      {teamMembers.map((member, index) => (
        <div key={index} className="p-3 border rounded-md space-y-3" data-testid={`team-member-row-${index}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Member {index + 1}</span>
            {teamMembers.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeTeamMember(index)}
                data-testid={`button-remove-member-${index}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              value={member.first_name}
              onChange={(e) => updateTeamMember(index, 'first_name', e.target.value)}
              placeholder="First name *"
              data-testid={`input-team-first-name-${index}`}
            />
            <Input
              value={member.last_name}
              onChange={(e) => updateTeamMember(index, 'last_name', e.target.value)}
              placeholder="Last name *"
              data-testid={`input-team-last-name-${index}`}
            />
          </div>
          <Input
            type="email"
            value={member.email}
            onChange={(e) => updateTeamMember(index, 'email', e.target.value)}
            placeholder="Email *"
            required
            data-testid={`input-team-email-${index}`}
          />
        </div>
      ))}
    </div>
  );

  const renderCurrentStep = () => {
    switch (currentStepId) {
      case 'organisation':
        return renderOrganisationStep();
      case 'details':
        return renderDetailsStep();
      case 'team':
        return renderTeamStep();
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {campaign.tenant_logo_url && (
        <div className="border-b bg-card">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
            <img
              src={campaign.tenant_logo_url}
              alt={campaign.tenant_name}
              className="h-8 object-contain"
            />
            {campaign.tenant_name && (
              <span className="text-sm font-medium text-muted-foreground">{campaign.tenant_name}</span>
            )}
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {campaign.cover_image_url && (
          <div className="rounded-md overflow-hidden h-48 sm:h-64">
            <img
              src={campaign.cover_image_url}
              alt={campaign.name}
              className="w-full h-full object-cover"
            />
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold" data-testid="text-campaign-name">
              {campaign.name}
            </h1>
            <Badge variant="outline" data-testid="badge-campaign-type">
              {isTeamCampaign ? (
                <><Users className="w-3 h-3 mr-1" /> Team Event</>
              ) : (
                <><User className="w-3 h-3 mr-1" /> Individual</>
              )}
            </Badge>
          </div>

          {campaign.public_description && (
            <p className="text-muted-foreground whitespace-pre-line" data-testid="text-public-description">
              {campaign.public_description}
            </p>
          )}
          {!campaign.public_description && campaign.description && (
            <p className="text-muted-foreground whitespace-pre-line">
              {campaign.description}
            </p>
          )}
        </div>

        <Card>
          <CardContent className="pt-5 pb-4 space-y-3">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="font-semibold text-lg">
                {formatCurrency(campaign.total_raised, campaign.currency)}
                <span className="text-muted-foreground font-normal text-sm ml-1.5">
                  raised of {formatCurrency(campaign.goal_amount, campaign.currency)}
                </span>
              </span>
              <span className="font-bold text-lg">{progressPercent}%</span>
            </div>
            <ProgressBar percent={progressPercent} />
            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <Users className="w-3.5 h-3.5" />
                {campaign.participant_count} {campaign.participant_count === 1 ? 'participant' : 'participants'}
              </span>
              <span className="flex items-center gap-1">
                <Heart className="w-3.5 h-3.5" />
                {campaign.donation_count} {campaign.donation_count === 1 ? 'donation' : 'donations'}
              </span>
              {campaign.end_date && (
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5" />
                  Ends {formatDate(campaign.end_date)}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {formState === 'form' && (
          <Card>
            <CardContent className="pt-6 pb-6">
              <h2 className="text-lg font-semibold mb-1" data-testid="text-register-heading">
                {isTeamCampaign ? 'Register Your Team' : 'Register to Participate'}
              </h2>
              <p className="text-sm text-muted-foreground mb-5">
                {isTeamCampaign
                  ? `Sign up as a team (up to ${maxTeamSize} members). Each member gets their own donation page.`
                  : 'Sign up to get your own fundraising page where people can donate to support your effort.'}
              </p>

              <StepIndicator steps={wizardSteps} currentStep={currentStep} />

              <form onSubmit={handleSubmit}>
                <div style={animationStyle}>
                  {renderCurrentStep()}
                </div>

                {submitError && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm mt-4" data-testid="text-submit-error">
                    {submitError}
                  </div>
                )}

                <div className={`flex items-center mt-6 gap-3 flex-wrap ${isFirstStep ? 'justify-end' : 'justify-between'}`}>
                  {!isFirstStep && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={goToPrevStep}
                      disabled={isAnimating}
                      data-testid="button-prev-step"
                    >
                      <ArrowLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                  )}

                  {isLastStep ? (
                    <Button
                      type="submit"
                      disabled={submitting || isAnimating}
                      data-testid="button-register"
                    >
                      {submitting ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Registering...</>
                      ) : (
                        <>{isTeamCampaign ? 'Register Team' : 'Register'} <ArrowRight className="w-4 h-4 ml-2" /></>
                      )}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      onClick={goToNextStep}
                      disabled={isAnimating}
                      data-testid="button-next-step"
                    >
                      Next
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {formState === 'success' && result && (
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <div className="flex justify-center">
                <div className="p-3 rounded-full bg-green-500/10">
                  <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-400" />
                </div>
              </div>
              <div>
                <h2 className="text-xl font-semibold mb-1" data-testid="text-success-heading">
                  Registration Complete
                </h2>
                <p className="text-muted-foreground text-sm">
                  {result.registration_message || `You're all set for ${result.campaign_name}! Each participant now has their own donation page.`}
                </p>
              </div>

              <div className="text-left space-y-3 max-w-sm mx-auto">
                <p className="text-sm font-medium text-center">Your Donation Page Links</p>
                {result.members?.map((member, i) => (
                  <div key={member.id} className="p-3 rounded-md border space-y-1.5" data-testid={`result-member-${i}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{member.first_name} {member.last_name}</span>
                      {member.role === 'lead' && (
                        <Badge variant="secondary" className="text-xs">
                          {result.campaign_type === 'team' ? 'Team Leader' : 'You'}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={`${window.location.origin}/donate/${member.token}`}
                        className="text-xs"
                        data-testid={`input-donation-link-${i}`}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/donate/${member.token}`);
                        }}
                        data-testid={`button-copy-link-${i}`}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
