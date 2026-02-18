import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Heart, Loader2, Users, Target, Copy, Check,
  ExternalLink, AlertCircle, ImagePlus, MessageSquare,
  ChevronDown, ChevronUp, X, Clock
} from "lucide-react";
import { getTenantSlugFromLocation } from "@/api/publicClient";

function getSessionKey() {
  const slug = getTenantSlugFromLocation();
  return slug ? `fundraiser_session_${slug}` : 'fundraiser_session_token';
}

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

function formatTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function CampaignUpdates({ campaignId, teamMemberId }) {
  const [expanded, setExpanded] = useState(false);
  const [updates, setUpdates] = useState([]);
  const [loadingUpdates, setLoadingUpdates] = useState(false);
  const [content, setContent] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [posting, setPosting] = useState(false);
  const fileInputRef = useRef(null);

  const tenantSlug = getTenantSlugFromLocation();
  const sessionToken = localStorage.getItem(getSessionKey());

  const fetchUpdates = useCallback(async () => {
    setLoadingUpdates(true);
    try {
      let url = `/api/public/fundraising/updates?campaign_id=${campaignId}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setUpdates(data);
      }
    } catch {} finally {
      setLoadingUpdates(false);
    }
  }, [campaignId, tenantSlug]);

  useEffect(() => {
    fetchUpdates();
  }, [fetchUpdates]);

  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePost = async () => {
    if (!content.trim() || !sessionToken) return;
    setPosting(true);
    try {
      let imageUrl = null;

      if (imageFile) {
        const formData = new FormData();
        formData.append('file', imageFile);
        let uploadUrl = `/api/public/fundraising/upload-update-image?session_token=${encodeURIComponent(sessionToken)}`;
        if (tenantSlug) uploadUrl += `&tenant=${tenantSlug}`;
        const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error('Image upload failed');
        const uploadData = await uploadRes.json();
        imageUrl = uploadData.url;
      }

      let postUrl = `/api/public/fundraising/updates?session_token=${encodeURIComponent(sessionToken)}`;
      if (tenantSlug) postUrl += `&tenant=${tenantSlug}`;
      const postRes = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: teamMemberId,
          campaign_id: campaignId,
          content: content.trim(),
          image_url: imageUrl
        })
      });

      if (!postRes.ok) throw new Error('Failed to post update');

      setContent('');
      removeImage();
      fetchUpdates();
    } catch {} finally {
      setPosting(false);
    }
  };

  return (
    <div className="border-t pt-4 space-y-3">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setExpanded(!expanded)}
        data-testid="button-toggle-updates"
      >
        <span className="text-sm font-medium flex items-center gap-2">
          <MessageSquare className="w-4 h-4" />
          Post an Update
          {updates.length > 0 && (
            <Badge variant="secondary" className="text-xs">{updates.length}</Badge>
          )}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {expanded && (
        <div className="space-y-4">
          <div className="space-y-3">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Share an update with your supporters..."
              className="resize-none"
              rows={3}
              data-testid="textarea-update-content"
            />

            {imagePreview && (
              <div className="relative inline-block">
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="w-20 h-20 object-cover rounded-md"
                  data-testid="img-update-preview"
                />
                <Button
                  size="icon"
                  variant="secondary"
                  className="absolute -top-2 -right-2 rounded-full"
                  onClick={removeImage}
                  data-testid="button-remove-image"
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
                data-testid="input-update-image"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-add-image"
              >
                <ImagePlus className="w-4 h-4 mr-1" />
                Add Photo
              </Button>
              <Button
                size="sm"
                disabled={!content.trim() || posting}
                onClick={handlePost}
                data-testid="button-post-update"
              >
                {posting && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                Post Update
              </Button>
            </div>
          </div>

          {loadingUpdates ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : updates.length > 0 ? (
            <div className="space-y-3">
              {updates.map((u) => (
                <div key={u.id} className="border rounded-md p-3 space-y-2" data-testid={`update-${u.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium" data-testid={`text-update-author-${u.id}`}>
                      {u.author_name}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatTimeAgo(u.created_at)}
                    </span>
                  </div>
                  <p className="text-sm" data-testid={`text-update-content-${u.id}`}>{u.content}</p>
                  {u.image_url && (
                    <img
                      src={u.image_url}
                      alt=""
                      className="rounded-md max-h-48 object-cover"
                      data-testid={`img-update-${u.id}`}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2" data-testid="text-no-updates">
              No updates yet. Share your first update with supporters.
            </p>
          )}
        </div>
      )}
    </div>
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
  const [searchParams, setSearchParams] = useSearchParams();
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

  const handleLogout = useCallback(() => {
    localStorage.removeItem(getSessionKey());
    setDashboardData(null);
    setError(null);
  }, []);

  useEffect(() => {
    const urlToken = searchParams.get('token');
    const sessionKey = getSessionKey();
    const storedSession = localStorage.getItem(sessionKey);
    const tenantSlug = getTenantSlugFromLocation();

    if (urlToken) {
      let url = `/api/public/fundraising/verify-login?token=${encodeURIComponent(urlToken)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;

      fetch(url)
        .then(res => {
          if (!res.ok) return res.json().then(err => { throw new Error(err.error || 'Invalid login link'); });
          return res.json();
        })
        .then(data => {
          if (data.session_token) {
            localStorage.setItem(sessionKey, data.session_token);
          }
          setDashboardData(data);
          setLoading(false);
          setSearchParams({}, { replace: true });
        })
        .catch(err => {
          setError(err.message);
          setLoading(false);
        });
    } else if (storedSession) {
      let url = `/api/public/fundraising/verify-session?session_token=${encodeURIComponent(storedSession)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;

      fetch(url)
        .then(res => {
          if (!res.ok) {
            localStorage.removeItem(sessionKey);
            return res.json().then(err => { throw new Error(err.error || 'Session expired'); });
          }
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
    } else {
      setError('No login token provided. Please request a login link.');
      setLoading(false);
    }
  }, [searchParams, setSearchParams]);

  const getDonatePageUrl = (participantToken) => {
    const origin = window.location.origin;
    return `${origin}/donate/${participantToken}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground" data-testid="text-loading">Loading your dashboard...</p>
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

                    <CampaignUpdates
                      campaignId={campaign.campaign_id}
                      teamMemberId={campaign.team_member_id}
                    />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <div className="text-center pt-4">
          <Link to="/fundraiser/login" onClick={handleLogout}>
            <Button variant="ghost" size="sm" data-testid="button-logout">
              Sign in with a different email
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
