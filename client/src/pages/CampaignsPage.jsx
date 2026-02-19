import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Heart, Loader2, Users, Target, Calendar, ArrowRight, AlertCircle
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
    <div className="relative w-full rounded-full h-2.5 overflow-hidden"
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

function CampaignCard({ campaign, onRegister }) {
  const percent = campaign.goal_amount > 0
    ? Math.round((campaign.total_raised / campaign.goal_amount) * 100)
    : 0;

  const isEnded = campaign.end_date && new Date(campaign.end_date) < new Date();
  const canRegister = campaign.registration_open && !isEnded;

  return (
    <Card className="overflow-hidden" data-testid={`card-campaign-${campaign.id}`}>
      {campaign.cover_image_url && (
        <div className="relative h-44 overflow-hidden">
          <img
            src={campaign.cover_image_url}
            alt={campaign.name}
            className="w-full h-full object-cover"
            data-testid={`img-campaign-cover-${campaign.id}`}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
          <div className="absolute bottom-3 left-3 right-3">
            <h3 className="text-lg font-bold text-white drop-shadow-lg line-clamp-2" data-testid={`text-campaign-name-${campaign.id}`}>
              {campaign.name}
            </h3>
          </div>
        </div>
      )}
      <CardContent className={campaign.cover_image_url ? "pt-4 space-y-3" : "pt-6 space-y-3"}>
        {!campaign.cover_image_url && (
          <h3 className="text-lg font-bold line-clamp-2" data-testid={`text-campaign-name-${campaign.id}`}>
            {campaign.name}
          </h3>
        )}

        {campaign.description && (
          <p className="text-sm text-muted-foreground line-clamp-3" data-testid={`text-campaign-desc-${campaign.id}`}>
            {campaign.description}
          </p>
        )}

        {!campaign.hide_campaign_target && campaign.goal_amount > 0 && (
          <div className="space-y-1.5">
            <ProgressBar percent={percent} />
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold" data-testid={`text-raised-${campaign.id}`}>
                {formatCurrency(campaign.total_raised, campaign.currency)} raised
              </span>
              <span className="text-muted-foreground" data-testid={`text-goal-${campaign.id}`}>
                of {formatCurrency(campaign.goal_amount, campaign.currency)}
              </span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
          {campaign.participant_count > 0 && (
            <span className="flex items-center gap-1" data-testid={`text-fundraisers-${campaign.id}`}>
              <Users className="w-3.5 h-3.5" />
              {campaign.participant_count} fundraiser{campaign.participant_count !== 1 ? 's' : ''}
            </span>
          )}
          {!campaign.hide_campaign_target && campaign.donation_count > 0 && (
            <span className="flex items-center gap-1" data-testid={`text-donations-${campaign.id}`}>
              <Heart className="w-3.5 h-3.5" />
              {campaign.donation_count} donation{campaign.donation_count !== 1 ? 's' : ''}
            </span>
          )}
          {campaign.end_date && (
            <span className="flex items-center gap-1" data-testid={`text-end-date-${campaign.id}`}>
              <Calendar className="w-3.5 h-3.5" />
              {isEnded ? 'Ended' : `Ends ${formatDate(campaign.end_date)}`}
            </span>
          )}
        </div>

        {canRegister ? (
          <Button
            className="w-full"
            onClick={() => onRegister(campaign.slug)}
            data-testid={`button-register-${campaign.id}`}
          >
            Start Fundraising
            <ArrowRight className="w-4 h-4 ml-1" />
          </Button>
        ) : isEnded ? (
          <Badge variant="secondary" className="w-full justify-center py-1.5" data-testid={`badge-ended-${campaign.id}`}>
            Campaign Ended
          </Badge>
        ) : (
          <Badge variant="secondary" className="w-full justify-center py-1.5" data-testid={`badge-closed-${campaign.id}`}>
            Registration Closed
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}

export default function CampaignsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const tenantSlug = getTenantSlugFromLocation();
    let url = '/api/public/fundraising/campaigns';
    if (tenantSlug) url += `?tenant=${tenantSlug}`;

    fetch(url)
      .then(res => {
        if (!res.ok) return res.json().then(err => { throw new Error(err.error || 'Failed to load campaigns'); });
        return res.json();
      })
      .then(result => {
        setData(result);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const handleRegister = (slug) => {
    navigate(`/fundraise/${slug}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" data-testid="loader-campaigns" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-8 pb-8 space-y-3">
            <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
            <p className="text-muted-foreground" data-testid="text-error">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { campaigns, tenant_name, tenant_logo_url } = data;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <div className="text-center space-y-3">
          {tenant_logo_url && (
            <img
              src={tenant_logo_url}
              alt={tenant_name || 'Logo'}
              className="h-14 object-contain mx-auto"
              data-testid="img-tenant-logo"
            />
          )}
          <h1 className="text-3xl font-bold" data-testid="text-page-title">
            Fundraising Campaigns
          </h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Join one of our campaigns and help make a difference. Every fundraiser counts!
          </p>
        </div>

        {campaigns.length === 0 ? (
          <Card className="text-center">
            <CardContent className="pt-10 pb-10 space-y-3">
              <Target className="w-10 h-10 text-muted-foreground mx-auto" />
              <p className="text-muted-foreground" data-testid="text-no-campaigns">
                No active campaigns at the moment. Check back soon!
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-2" data-testid="campaign-grid">
            {campaigns.map(campaign => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                onRegister={handleRegister}
              />
            ))}
          </div>
        )}

        <div className="text-center py-4 text-xs text-muted-foreground">
          <p>
            Fundraising by {tenant_name} powered by{' '}
            <a
              href="https://www.isaasi.co.uk"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              data-testid="link-isupporter"
            >
              <span style={{ color: '#FF00FF' }}>i</span>supporter
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
