import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Heart, Loader2, Users, Target, Copy, Check,
  ExternalLink, AlertCircle
} from "lucide-react";
import { getTenantSlugFromLocation } from "@/api/publicClient";

function formatCurrency(amount, currency) {
  const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac' };
  const symbol = symbols[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
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

function CopyLinkButton({ url }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      data-testid="button-copy-link"
    >
      {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
      {copied ? 'Copied' : 'Copy Link'}
    </Button>
  );
}

function StatusBadge({ status }) {
  const variants = {
    active: 'default',
    draft: 'secondary',
    completed: 'outline',
    paused: 'secondary'
  };
  return (
    <Badge variant={variants[status] || 'secondary'} data-testid="badge-campaign-status">
      {status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown'}
    </Badge>
  );
}

export default function FundraiserDashboardPage() {
  const [searchParams] = useSearchParams();
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tenantBranding, setTenantBranding] = useState(null);

  useEffect(() => {
    const tenantSlug = getTenantSlugFromLocation();
    if (tenantSlug) {
      fetch(`/api/public/tenant-branding?tenant=${tenantSlug}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => { if (data) setTenantBranding(data); })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setError('No login token provided. Please request a new login link.');
      setLoading(false);
      return;
    }

    const tenantSlug = getTenantSlugFromLocation();
    let url = `/api/public/fundraising/verify-login?token=${encodeURIComponent(token)}`;
    if (tenantSlug) {
      url += `&tenant=${tenantSlug}`;
    }

    fetch(url)
      .then(res => {
        if (!res.ok) return res.json().then(err => { throw new Error(err.error || 'Invalid login link'); });
        return res.json();
      })
      .then(data => {
        setDashboardData(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [searchParams]);

  const getDonatePageUrl = (participantToken) => {
    const origin = window.location.origin;
    return `${origin}/donate/${participantToken}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground" data-testid="text-loading">Verifying your login...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
        <div className="max-w-md w-full space-y-6">
          {tenantBranding?.logo_url && (
            <div className="flex justify-center">
              <img
                src={tenantBranding.logo_url}
                alt={tenantBranding.name || 'Logo'}
                className="h-12 object-contain"
                data-testid="img-tenant-logo"
              />
            </div>
          )}
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <AlertCircle className="w-7 h-7 text-destructive" />
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-error-heading">Login Link Invalid</h2>
              <p className="text-muted-foreground text-sm" data-testid="text-error-message">{error}</p>
              <Link to="/fundraiser/login">
                <Button data-testid="button-go-to-login">Request New Login Link</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!dashboardData) return null;

  const { first_name, last_name, campaigns } = dashboardData;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        {tenantBranding?.logo_url && (
          <div className="flex justify-center">
            <img
              src={tenantBranding.logo_url}
              alt={tenantBranding.name || 'Logo'}
              className="h-12 object-contain"
              data-testid="img-tenant-logo"
            />
          </div>
        )}

        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto text-lg font-bold text-primary">
            {first_name?.[0]}{last_name?.[0]}
          </div>
          <h1 className="text-2xl font-bold" data-testid="text-welcome">
            Welcome back, {first_name}
          </h1>
          <p className="text-muted-foreground text-sm">
            Here are your fundraising campaigns
          </p>
        </div>

        {campaigns.length === 0 ? (
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-3">
              <Heart className="w-10 h-10 text-muted-foreground mx-auto" />
              <h3 className="font-medium" data-testid="text-no-campaigns">No Active Campaigns</h3>
              <p className="text-sm text-muted-foreground">
                You don't have any active fundraising campaigns at the moment.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {campaigns.map((campaign) => {
              const individualPercent = campaign.individual_goal > 0
                ? Math.round((campaign.individual_raised / campaign.individual_goal) * 100)
                : 0;
              const donateUrl = getDonatePageUrl(campaign.participant_token);

              return (
                <Card key={campaign.campaign_id} data-testid={`card-campaign-${campaign.campaign_id}`}>
                  <CardContent className="pt-6 space-y-4">
                    {campaign.campaign_cover_image_url && (
                      <div className="relative h-32 -mt-6 -mx-6 mb-4 overflow-hidden rounded-t-lg">
                        <img
                          src={campaign.campaign_cover_image_url}
                          alt={campaign.campaign_name}
                          className="w-full h-full object-cover"
                          data-testid="img-campaign-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="space-y-1">
                        <h3 className="text-lg font-semibold" data-testid="text-campaign-name">
                          {campaign.campaign_name}
                        </h3>
                        {campaign.organization_name && (
                          <p className="text-sm text-muted-foreground" data-testid="text-org-name">
                            Raising funds on behalf of: {campaign.organization_name}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusBadge status={campaign.campaign_status} />
                        <Badge variant="outline" data-testid="badge-role">
                          {campaign.role === 'lead' ? 'Lead' : 'Member'}
                        </Badge>
                      </div>
                    </div>

                    {campaign.individual_goal > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground flex items-center gap-1">
                            <Target className="w-3 h-3" />
                            Your progress
                          </span>
                          <span className="font-medium">
                            {individualPercent}%
                          </span>
                        </div>
                        <ProgressBar percent={individualPercent} />
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-semibold text-primary" data-testid="text-individual-raised">
                            {formatCurrency(campaign.individual_raised, campaign.currency)}
                          </span>
                          <span className="text-muted-foreground" data-testid="text-individual-goal">
                            of {formatCurrency(campaign.individual_goal, campaign.currency)} goal
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-1.5">
                        <Heart className="w-4 h-4 text-muted-foreground" />
                        <span data-testid="text-donation-count">
                          {campaign.donation_count} donation{campaign.donation_count !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Users className="w-4 h-4 text-muted-foreground" />
                        <span data-testid="text-amount-raised">
                          {formatCurrency(campaign.individual_raised, campaign.currency)} raised
                        </span>
                      </div>
                    </div>

                    <div className="border-t pt-4 space-y-3">
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground">Your Donation Page</p>
                        <div className="flex items-center gap-2">
                          <Input
                            readOnly
                            value={donateUrl}
                            className="text-xs bg-muted/50"
                            data-testid="input-donate-url"
                          />
                          <CopyLinkButton url={donateUrl} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <a href={donateUrl} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm" data-testid="button-view-donate-page">
                            <ExternalLink className="w-4 h-4 mr-1" />
                            View Page
                          </Button>
                        </a>
                        {campaign.campaign_slug && (
                          <Link to={`/fundraise/${campaign.campaign_slug}`}>
                            <Button variant="outline" size="sm" data-testid="button-view-campaign">
                              Campaign Page
                            </Button>
                          </Link>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <div className="text-center pt-4">
          <Link to="/fundraiser/login">
            <Button variant="ghost" size="sm" data-testid="button-logout">
              Sign in with a different email
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
