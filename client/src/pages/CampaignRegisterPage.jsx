import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Heart, Loader2, CheckCircle2, Users, Target, Calendar,
  Plus, Trash2, User, UserPlus, ArrowRight, ArrowLeft, Building2
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

export default function CampaignRegisterPage() {
  const { slug } = useParams();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [step, setStep] = useState('form');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);

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
        body.organisation = {
          name: orgName.trim(),
          address: orgAddress.trim() || null,
          city: orgCity.trim() || null,
          postcode: orgPostcode.trim() || null,
          country: orgCountry.trim() || null
        };
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
      setStep('success');
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

        {step === 'form' && (
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

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-4">
                  <p className="text-sm font-medium flex items-center gap-2">
                    <User className="w-4 h-4" />
                    {isTeamCampaign ? 'Team Leader' : 'Your Details'}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>First Name *</Label>
                      <Input
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        placeholder="First name"
                        required
                        data-testid="input-first-name"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Last Name *</Label>
                      <Input
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        placeholder="Last name"
                        required
                        data-testid="input-last-name"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Email *</Label>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      required
                      data-testid="input-email"
                    />
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

                {campaign.allow_org_signup && (
                  <div className="space-y-4 border-t pt-5">
                    <p className="text-sm font-medium flex items-center gap-2">
                      <Building2 className="w-4 h-4" />
                      Organisation Details
                    </p>
                    <div className="space-y-1.5">
                      <Label>Organisation Name</Label>
                      <Input
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        placeholder="Organisation name"
                        data-testid="input-org-name"
                      />
                    </div>
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
                  </div>
                )}

                {isTeamCampaign && (
                  <div className="space-y-4 border-t pt-5">
                    <div className="flex items-center justify-between gap-3">
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
                          placeholder="Email (optional)"
                          data-testid={`input-team-email-${index}`}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {submitError && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm" data-testid="text-submit-error">
                    {submitError}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={submitting}
                  data-testid="button-register"
                >
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Registering...</>
                  ) : (
                    <>{isTeamCampaign ? 'Register Team' : 'Register'} <ArrowRight className="w-4 h-4 ml-2" /></>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {step === 'success' && result && (
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
