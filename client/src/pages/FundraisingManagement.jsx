import { useState, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import {
  Tabs, TabsContent, TabsList, TabsTrigger
} from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Heart, Plus, Trash2, Users, Link as LinkIcon, Copy, Check,
  ArrowLeft, Target, Calendar, Loader2, Search, ExternalLink, UserPlus,
  Eye, BarChart3, Gift, PoundSterling, TrendingUp, Award, Clock,
  ChevronRight, ChevronDown, ChevronUp, MessageSquare, HandHeart,
  ImagePlus, X, Megaphone, Lock, Paperclip, FileText, Download,
  Reply, CornerDownRight, Filter
} from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/queryClient";

const CURRENCIES = [
  { value: 'GBP', label: 'GBP', symbol: '\u00a3' },
  { value: 'USD', label: 'USD', symbol: '$' },
  { value: 'EUR', label: 'EUR', symbol: '\u20ac' },
];

function getCurrencySymbol(code) {
  return CURRENCIES.find(c => c.value === code)?.symbol || code;
}

function formatCurrency(amount, currency) {
  const symbol = getCurrencySymbol(currency);
  return `${symbol}${parseFloat(amount || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

function ProgressBar({ percent, height = 'h-2.5' }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className={`relative w-full rounded-full ${height} overflow-hidden`}
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

const STATUS_CONFIG = {
  draft: { label: 'Draft', variant: 'secondary' },
  active: { label: 'Active', variant: 'default' },
  completed: { label: 'Completed', variant: 'outline' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
};

export default function FundraisingManagement() {
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const navigate = useNavigate();

  if (selectedCampaignId) {
    return (
      <CampaignDetail
        campaignId={selectedCampaignId}
        onBack={() => setSelectedCampaignId(null)}
      />
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Fundraising</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage campaigns, team members, and track donations</p>
        </div>
        <Button
          onClick={() => navigate('/CampaignEdit/new')}
          data-testid="button-create-campaign"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Campaign
        </Button>
      </div>

      <CampaignList
        onSelect={setSelectedCampaignId}
      />
    </div>
  );
}

function CampaignList({ onSelect }) {
  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['fundraising-campaigns'],
    queryFn: () => apiRequest('GET', '/api/fundraising/campaigns')
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaigns || campaigns.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="p-4 rounded-full bg-muted mb-4">
            <Heart className="w-10 h-10 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No campaigns yet</h3>
          <p className="text-muted-foreground text-sm max-w-sm">
            Create your first fundraising campaign to start collecting donations and tracking your progress.
          </p>
        </CardContent>
      </Card>
    );
  }

  const totalAcrossAll = campaigns.reduce((sum, c) => sum + (c.total_raised || 0), 0);
  const totalDonations = campaigns.reduce((sum, c) => sum + (c.donation_count || 0), 0);
  const activeCampaigns = campaigns.filter(c => c.status === 'active').length;
  const primaryCurrency = campaigns[0]?.currency || 'GBP';

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-green-500/10">
                <PoundSterling className="w-5 h-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Raised</p>
                <p className="text-xl font-bold" data-testid="text-total-raised">
                  {formatCurrency(totalAcrossAll, primaryCurrency)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-blue-500/10">
                <Heart className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Donations</p>
                <p className="text-xl font-bold" data-testid="text-total-donations">{totalDonations}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-purple-500/10">
                <BarChart3 className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Active Campaigns</p>
                <p className="text-xl font-bold">{activeCampaigns}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-amber-500/10">
                <TrendingUp className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg. Donation</p>
                <p className="text-xl font-bold">
                  {totalDonations > 0 ? formatCurrency(totalAcrossAll / totalDonations, primaryCurrency) : '-'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {campaigns.map(campaign => {
          const statusConfig = STATUS_CONFIG[campaign.status] || STATUS_CONFIG.draft;
          const progressPercent = campaign.goal_amount > 0
            ? Math.min(100, Math.round((campaign.total_raised / parseFloat(campaign.goal_amount)) * 100))
            : 0;

          return (
            <Card
              key={campaign.id}
              className="hover-elevate cursor-pointer group"
              onClick={() => onSelect(campaign.id)}
              data-testid={`card-campaign-${campaign.id}`}
            >
              {campaign.cover_image_url && (
                <div className="h-36 overflow-hidden rounded-t-md">
                  <img
                    src={campaign.cover_image_url}
                    alt={campaign.name}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-tight">{campaign.name}</CardTitle>
                  <Badge variant={statusConfig.variant} className="shrink-0">
                    {statusConfig.label}
                  </Badge>
                </div>
                {campaign.description && (
                  <CardDescription className="line-clamp-2 text-xs">{campaign.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">
                      {formatCurrency(campaign.total_raised, campaign.currency)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {progressPercent}% of {formatCurrency(campaign.goal_amount, campaign.currency)}
                    </span>
                  </div>
                  <ProgressBar percent={progressPercent} />
                </div>
                <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    {campaign.team_member_count || 0} fundraisers
                  </span>
                  <span className="flex items-center gap-1">
                    <Heart className="w-3.5 h-3.5" />
                    {campaign.donation_count || 0} donations
                  </span>
                  {campaign.end_date && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" />
                      {formatDate(campaign.end_date)}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity pt-1">
                  <span className="text-xs text-primary flex items-center gap-1">
                    View details <ChevronRight className="w-3 h-3" />
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function TeamMemberRow({ member, campaign, copiedToken, onCopyLink, onRemove }) {
  const memberGoal = member.individual_goal || 0;
  const memberProgress = memberGoal > 0 ? Math.min(100, Math.round(((member.total_raised || 0) / memberGoal) * 100)) : 0;

  return (
    <div
      className="p-4 rounded-md border space-y-3"
      data-testid={`row-team-member-${member.id}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar className="h-10 w-10">
            <AvatarFallback>
              {member.first_name?.[0]}{member.last_name?.[0]}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="font-medium truncate">
              {member.first_name} {member.last_name}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {member.email && (
                <span className="text-xs text-muted-foreground truncate">{member.email}</span>
              )}
              {member.member_id && (
                <Badge variant="secondary">Tenant Member</Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onCopyLink(member.token); }}
            data-testid={`button-copy-link-${member.id}`}
          >
            {copiedToken === member.token ? (
              <><Check className="w-3 h-3 mr-1" /> Copied</>
            ) : (
              <><Copy className="w-3 h-3 mr-1" /> Copy Link</>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              window.open(`/donate/${member.token}`, '_blank');
            }}
            data-testid={`button-view-page-${member.id}`}
          >
            <Eye className="w-3 h-3 mr-1" /> View
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Remove ${member.first_name} ${member.last_name} from this campaign?`)) {
                onRemove(member.id);
              }
            }}
            data-testid={`button-remove-member-${member.id}`}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 text-sm">
        <div className="flex items-center gap-4 text-muted-foreground">
          <span className="flex items-center gap-1">
            <Heart className="w-3.5 h-3.5" />
            {member.donation_count || 0} donations
          </span>
          {member.gift_aid_count > 0 && (
            <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
              <Gift className="w-3.5 h-3.5" />
              {member.gift_aid_count} Gift Aid
            </span>
          )}
        </div>
        <div className="text-right">
          <span className="font-bold">{formatCurrency(member.total_raised, campaign.currency)}</span>
          {memberGoal > 0 && (
            <span className="text-muted-foreground text-xs ml-1.5">
              / {formatCurrency(memberGoal, campaign.currency)} ({memberProgress}%)
            </span>
          )}
        </div>
      </div>
      {memberGoal > 0 && (
        <ProgressBar percent={memberProgress} height="h-1.5" />
      )}
    </div>
  );
}

function CampaignDetail({ campaignId, onBack }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [showAddMember, setShowAddMember] = useState(false);
  const [copiedToken, setCopiedToken] = useState(null);
  const [copiedRegLink, setCopiedRegLink] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [expandedTeamName, setExpandedTeamName] = useState(null);

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['fundraising-campaigns', campaignId],
    queryFn: () => apiRequest('GET', `/api/fundraising/campaigns?id=${campaignId}`)
  });

  const deleteCampaignMutation = useMutation({
    mutationFn: () => apiRequest('DELETE', `/api/fundraising/campaigns?id=${campaignId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fundraising-campaigns'] });
      toast.success('Campaign deleted');
      onBack();
    },
    onError: (err) => toast.error(err.message)
  });

  const removeTeamMemberMutation = useMutation({
    mutationFn: (memberId) => apiRequest('DELETE', `/api/fundraising/team-members?id=${memberId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fundraising-campaigns', campaignId] });
      toast.success('Team member removed');
    },
    onError: (err) => toast.error(err.message)
  });

  const copyDonationLink = (token) => {
    const baseUrl = window.location.origin;
    const link = `${baseUrl}/donate/${token}`;
    navigator.clipboard.writeText(link);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
    toast.success('Donation link copied');
  };

  const { teams, individuals } = useMemo(() => {
    const allMembers = campaign?.team_members || [];
    const teamMap = {};
    const indivs = [];

    allMembers.forEach(m => {
      if (m.team_name) {
        const key = m.team_name.trim().toLowerCase();
        if (!teamMap[key]) {
          teamMap[key] = { name: m.team_name.trim(), slug: key.replace(/[^a-z0-9]+/g, '-'), members: [], totalRaised: 0, donationCount: 0, giftAidCount: 0 };
        }
        teamMap[key].members.push(m);
        teamMap[key].totalRaised += (m.total_raised || 0);
        teamMap[key].donationCount += (m.donation_count || 0);
        teamMap[key].giftAidCount += (m.gift_aid_count || 0);
      } else {
        indivs.push(m);
      }
    });

    const teamList = Object.values(teamMap).sort((a, b) => b.totalRaised - a.totalRaised);
    teamList.forEach(t => t.members.sort((a, b) => (b.total_raised || 0) - (a.total_raised || 0)));
    indivs.sort((a, b) => (b.total_raised || 0) - (a.total_raised || 0));

    return { teams: teamList, individuals: indivs };
  }, [campaign?.team_members]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Campaign not found</p>
        <Button variant="outline" onClick={onBack} className="mt-4">Go Back</Button>
      </div>
    );
  }

  const progressPercent = campaign.goal_amount > 0
    ? Math.min(100, Math.round((campaign.total_raised / parseFloat(campaign.goal_amount)) * 100))
    : 0;

  const statusConfig = STATUS_CONFIG[campaign.status] || STATUS_CONFIG.draft;
  const sortedTeamMembers = [...(campaign.team_members || [])].sort((a, b) => (b.total_raised || 0) - (a.total_raised || 0));
  const topFundraiser = sortedTeamMembers[0];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold truncate" data-testid="text-campaign-name">
              {campaign.name}
            </h1>
            <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
          </div>
          {campaign.description && (
            <p className="text-muted-foreground text-sm mt-1 line-clamp-2">{campaign.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {campaign.registration_open && campaign.slug && (
            <Button
              variant="outline"
              onClick={() => {
                const regUrl = `${window.location.origin}/fundraise/${campaign.slug}`;
                navigator.clipboard.writeText(regUrl);
                setCopiedRegLink(true);
                setTimeout(() => setCopiedRegLink(false), 2000);
                toast.success('Registration page link copied');
              }}
              data-testid="button-copy-registration-link"
            >
              {copiedRegLink ? <Check className="w-4 h-4 mr-2" /> : <LinkIcon className="w-4 h-4 mr-2" />}
              {copiedRegLink ? 'Copied' : 'Registration Link'}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => navigate('/CampaignEdit/' + campaignId)}
            data-testid="button-edit-campaign"
          >
            Edit
          </Button>
          <Button
            variant="destructive"
            size="icon"
            onClick={() => {
              if (window.confirm('Are you sure you want to delete this campaign? This will also remove all team members and donation records.')) {
                deleteCampaignMutation.mutate();
              }
            }}
            data-testid="button-delete-campaign"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 pb-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
            <div>
              <p className="text-sm text-muted-foreground">Campaign Progress</p>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-3xl font-bold" data-testid="text-campaign-raised">
                  {formatCurrency(campaign.total_raised, campaign.currency)}
                </span>
                <span className="text-muted-foreground text-sm">
                  raised of {formatCurrency(campaign.goal_amount, campaign.currency)} goal
                </span>
              </div>
            </div>
            <div className="text-right">
              <span className="text-4xl font-bold text-primary">{progressPercent}%</span>
            </div>
          </div>
          <ProgressBar percent={progressPercent} height="h-3" />
          {campaign.end_date && (
            <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              Campaign ends {formatDate(campaign.end_date)}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardContent className="pt-5 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Donations</p>
            <p className="text-2xl font-bold" data-testid="text-donation-count">{campaign.donation_count || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Unique Donors</p>
            <p className="text-2xl font-bold">{campaign.unique_donors || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Avg. Donation</p>
            <p className="text-2xl font-bold">
              {campaign.avg_donation > 0 ? formatCurrency(campaign.avg_donation, campaign.currency) : '-'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <Gift className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
              <p className="text-xs text-muted-foreground">Gift Aid Value</p>
            </div>
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">
              {campaign.gift_aid_total > 0 ? formatCurrency(campaign.gift_aid_total, campaign.currency) : '-'}
            </p>
            {campaign.gift_aid_count > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">{campaign.gift_aid_count} claims</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <p className="text-xs text-muted-foreground">Pending</p>
            </div>
            <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{campaign.pending_count || 0}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="team" data-testid="tab-team">
            Team ({campaign.team_members?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="donations" data-testid="tab-donations">
            Donations ({campaign.donation_count || 0})
          </TabsTrigger>
          <TabsTrigger value="updates" data-testid="tab-updates">
            <Megaphone className="w-3.5 h-3.5 mr-1.5" />
            Updates
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-6">
              {teams.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-primary" />
                      <CardTitle className="text-base">Team Leaderboard</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {teams.map((team, index) => {
                        const isTop = index === 0 && team.totalRaised > 0;
                        const teamGoal = team.members.reduce((sum, m) => sum + (parseFloat(m.individual_goal) || 0), 0);
                        const teamProgress = teamGoal > 0 ? Math.min(100, Math.round((team.totalRaised / teamGoal) * 100)) : 0;

                        return (
                          <div key={team.slug} className="space-y-2" data-testid={`leaderboard-team-${team.slug}`}>
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="text-sm font-medium text-muted-foreground w-5 text-right">
                                    {index + 1}
                                  </span>
                                  <div className={`p-1.5 rounded-md ${isTop ? 'bg-amber-500/10' : 'bg-muted'}`}>
                                    <Users className={`w-4 h-4 ${isTop ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} />
                                  </div>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate flex items-center gap-1.5">
                                    {team.name}
                                    {isTop && <Award className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {team.members.length} member{team.members.length !== 1 ? 's' : ''}
                                    {' \u00b7 '}{team.donationCount} donation{team.donationCount !== 1 ? 's' : ''}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-bold">
                                  {formatCurrency(team.totalRaised, campaign.currency)}
                                </p>
                              </div>
                            </div>
                            {teamGoal > 0 && (
                              <div className="ml-12">
                                <ProgressBar percent={teamProgress} height="h-1.5" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Award className="w-4 h-4 text-amber-500" />
                    <CardTitle className="text-base">Individual Leaderboard</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  {sortedTeamMembers.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No fundraisers yet
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {sortedTeamMembers.map((member, index) => {
                        const memberGoal = member.individual_goal || parseFloat(campaign.goal_amount) / (campaign.team_members?.length || 1);
                        const memberProgress = memberGoal > 0 ? Math.min(100, Math.round(((member.total_raised || 0) / memberGoal) * 100)) : 0;
                        const isTop = index === 0 && (member.total_raised || 0) > 0;

                        return (
                          <div key={member.id} className="space-y-2" data-testid={`leaderboard-member-${member.id}`}>
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="text-sm font-medium text-muted-foreground w-5 text-right">
                                    {index + 1}
                                  </span>
                                  <Avatar className="h-8 w-8">
                                    <AvatarFallback className={isTop ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : ''}>
                                      {member.first_name?.[0]}{member.last_name?.[0]}
                                    </AvatarFallback>
                                  </Avatar>
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate flex items-center gap-1.5">
                                    {member.first_name} {member.last_name}
                                    {isTop && <Award className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {member.team_name && <span className="font-medium">{member.team_name} &middot; </span>}
                                    {member.donation_count || 0} donations
                                    {member.gift_aid_count > 0 && ` \u00b7 ${member.gift_aid_count} Gift Aid`}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm font-bold">
                                  {formatCurrency(member.total_raised, campaign.currency)}
                                </p>
                                {member.individual_goal > 0 && (
                                  <p className="text-xs text-muted-foreground">
                                    of {formatCurrency(member.individual_goal, campaign.currency)}
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="ml-12">
                              <ProgressBar percent={memberProgress} height="h-1.5" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    <CardTitle className="text-base">Top Donors</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  {(!campaign.top_donors || campaign.top_donors.length === 0) ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No donations yet
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {campaign.top_donors.slice(0, 5).map((donor, i) => (
                        <div key={i} className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback>
                                {donor.donor_name?.split(' ').map(n => n[0]).join('').substring(0, 2)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate">{donor.donor_name}</p>
                              {donor.donor_message && (
                                <p className="text-xs text-muted-foreground truncate italic">
                                  "{donor.donor_message}"
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {donor.gift_aid && (
                              <Badge variant="secondary">
                                <Gift className="w-3 h-3 mr-1" />
                                Gift Aid
                              </Badge>
                            )}
                            <span className="text-sm font-bold">
                              {formatCurrency(donor.amount, donor.currency)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <CardTitle className="text-base">Recent Activity</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  {(!campaign.recent_donations || campaign.recent_donations.length === 0) ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No recent activity
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {campaign.recent_donations.slice(0, 6).map(donation => {
                        const teamMember = campaign.team_members?.find(m => m.id === donation.team_member_id);
                        return (
                          <div key={donation.id} className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3 min-w-0">
                              <div className="mt-0.5">
                                {donation.payment_status === 'succeeded' ? (
                                  <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5" />
                                ) : (
                                  <div className="w-2 h-2 rounded-full bg-amber-500 mt-1.5" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm">
                                  <span className="font-medium">{donation.donor_name}</span>
                                  {' donated '}
                                  <span className="font-semibold">{formatCurrency(donation.amount, donation.currency)}</span>
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {teamMember ? `via ${teamMember.first_name} ${teamMember.last_name}` : ''}
                                  {teamMember ? ' \u00b7 ' : ''}{formatRelativeTime(donation.created_at)}
                                </p>
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                              {donation.gift_aid && (
                                <Gift className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                              )}
                              {donation.payment_status === 'pending' && (
                                <Badge variant="secondary" className="text-xs">Pending</Badge>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="team" className="mt-4 space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <div>
                <CardTitle className="text-lg">Fundraisers</CardTitle>
                <CardDescription>Manage teams and individual fundraisers</CardDescription>
              </div>
              <Button onClick={() => setShowAddMember(true)} data-testid="button-add-team-member">
                <UserPlus className="w-4 h-4 mr-2" />
                Add Member
              </Button>
            </CardHeader>
            <CardContent>
              {(!campaign.team_members || campaign.team_members.length === 0) ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  <div className="p-4 rounded-full bg-muted inline-block mb-4">
                    <Users className="w-8 h-8" />
                  </div>
                  <p className="font-medium mb-1">No fundraisers added yet</p>
                  <p>Add team members to generate unique donation page links.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {teams.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                        <Users className="w-4 h-4" />
                        Teams ({teams.length})
                      </p>
                      {teams.map(team => {
                        const isExpanded = expandedTeamName === team.name;
                        return (
                          <div key={team.slug} className="border rounded-md" data-testid={`team-group-${team.slug}`}>
                            <button
                              type="button"
                              className="w-full text-left p-4 flex items-center justify-between gap-4 hover-elevate rounded-md"
                              onClick={() => setExpandedTeamName(isExpanded ? null : team.name)}
                              data-testid={`button-expand-team-${team.slug}`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="p-2 rounded-md bg-primary/10 shrink-0">
                                  <Users className="w-5 h-5 text-primary" />
                                </div>
                                <div className="min-w-0">
                                  <p className="font-semibold truncate">{team.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {team.members.length} member{team.members.length !== 1 ? 's' : ''}
                                    {' \u00b7 '}
                                    {team.donationCount} donation{team.donationCount !== 1 ? 's' : ''}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                <span className="font-bold text-sm">{formatCurrency(team.totalRaised, campaign.currency)}</span>
                                {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                              </div>
                            </button>

                            {isExpanded && (
                              <div className="border-t px-4 pb-4 pt-3 space-y-3">
                                {team.members.map(member => (
                                  <TeamMemberRow
                                    key={member.id}
                                    member={member}
                                    campaign={campaign}
                                    copiedToken={copiedToken}
                                    onCopyLink={copyDonationLink}
                                    onRemove={(id) => removeTeamMemberMutation.mutate(id)}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {individuals.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                        <Heart className="w-4 h-4" />
                        Individual Fundraisers ({individuals.length})
                      </p>
                      {individuals.map(member => (
                        <TeamMemberRow
                          key={member.id}
                          member={member}
                          campaign={campaign}
                          copiedToken={copiedToken}
                          onCopyLink={copyDonationLink}
                          onRemove={(id) => removeTeamMemberMutation.mutate(id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="donations" className="mt-4">
          <DonationsList campaignId={campaignId} campaign={campaign} />
        </TabsContent>

        <TabsContent value="updates" className="mt-4">
          <CampaignUpdatesAdmin campaignId={campaignId} />
        </TabsContent>

      </Tabs>

      {showAddMember && (
        <AddTeamMemberModal
          campaignId={campaignId}
          onClose={() => setShowAddMember(false)}
        />
      )}

    </div>
  );
}


function DonationsList({ campaignId, campaign }) {
  const { data: donations, isLoading } = useQuery({
    queryKey: ['fundraising-donations', campaignId],
    queryFn: () => apiRequest('GET', `/api/fundraising/donations?campaign_id=${campaignId}`)
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!donations?.donations?.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground text-sm">
          <div className="p-4 rounded-full bg-muted inline-block mb-4">
            <HandHeart className="w-8 h-8" />
          </div>
          <p className="font-medium mb-1">No donations yet</p>
          <p>Share your team members' donation pages to start collecting!</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <CardTitle className="text-lg">All Donations</CardTitle>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">
              Total: <span className="font-semibold text-foreground">{formatCurrency(donations.summary?.total_raised, campaign.currency)}</span>
            </span>
            {donations.summary?.gift_aid_count > 0 && (
              <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                <Gift className="w-3.5 h-3.5" />
                {donations.summary.gift_aid_count} Gift Aid
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {donations.donations.map(donation => (
            <div
              key={donation.id}
              className="flex items-center justify-between gap-4 p-3 rounded-md border"
              data-testid={`row-donation-${donation.id}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarFallback>
                    {donation.is_anonymous ? '?' : donation.donor_name?.split(' ').map(n => n[0]).join('').substring(0, 2)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-medium text-sm flex items-center gap-2 flex-wrap">
                    {donation.is_anonymous ? 'Anonymous' : donation.donor_name}
                    {donation.gift_aid && (
                      <Badge variant="secondary">
                        <Gift className="w-3 h-3 mr-1" /> Gift Aid
                      </Badge>
                    )}
                  </p>
                  {donation.donor_message && (
                    <p className="text-xs text-muted-foreground mt-0.5 italic truncate">"{donation.donor_message}"</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-0.5">
                    via {donation.fundraising_team_member?.first_name} {donation.fundraising_team_member?.last_name}
                    {' \u00b7 '}{formatRelativeTime(donation.created_at)}
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="font-bold">{formatCurrency(donation.amount, donation.currency)}</p>
                <Badge
                  variant={donation.payment_status === 'succeeded' ? 'default' : 'secondary'}
                >
                  {donation.payment_status}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AddTeamMemberModal({ campaignId, onClose }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState('external');
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    individual_goal: ''
  });
  const [memberSearch, setMemberSearch] = useState('');

  const { data: searchResults } = useQuery({
    queryKey: ['member-search', memberSearch],
    queryFn: async () => {
      if (!memberSearch || memberSearch.length < 2) return [];
      try {
        const data = await apiRequest('GET', `/api/members?search=${encodeURIComponent(memberSearch)}&limit=10`);
        return data.members || data || [];
      } catch { return []; }
    },
    enabled: mode === 'member' && memberSearch.length >= 2
  });

  const addMutation = useMutation({
    mutationFn: (data) => apiRequest('POST', '/api/fundraising/team-members', { campaign_id: campaignId, ...data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fundraising-campaigns', campaignId] });
      toast.success('Team member added');
      onClose();
    },
    onError: (err) => toast.error(err.message)
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.first_name.trim() || !form.last_name.trim()) {
      toast.error('First name and last name are required');
      return;
    }
    addMutation.mutate({
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim() || null,
      individual_goal: form.individual_goal ? parseFloat(form.individual_goal) : null,
      member_id: form.member_id || null
    });
  };

  const selectMember = (member) => {
    setForm({
      first_name: member.first_name || '',
      last_name: member.last_name || '',
      email: member.email || '',
      individual_goal: form.individual_goal,
      member_id: member.id
    });
    setMemberSearch('');
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Team Member</DialogTitle>
          <DialogDescription>
            Add a fundraiser to this campaign. They'll get a unique donation page link.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 mb-4">
          <Button
            variant={mode === 'external' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('external')}
            data-testid="button-mode-external"
          >
            External Person
          </Button>
          <Button
            variant={mode === 'member' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setMode('member')}
            data-testid="button-mode-member"
          >
            Existing Member
          </Button>
        </div>

        {mode === 'member' && (
          <div className="space-y-2 mb-4">
            <Label>Search Members</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Type a name to search..."
                className="pl-9"
                data-testid="input-member-search"
              />
            </div>
            {searchResults && searchResults.length > 0 && (
              <div className="border rounded-md max-h-40 overflow-y-auto">
                {searchResults.map(m => (
                  <button
                    key={m.id}
                    className="w-full text-left px-3 py-2 text-sm hover-elevate flex items-center gap-2"
                    onClick={() => selectMember(m)}
                    data-testid={`button-select-member-${m.id}`}
                  >
                    <Avatar className="h-7 w-7">
                      <AvatarFallback className="text-xs">
                        {m.first_name?.[0]}{m.last_name?.[0]}
                      </AvatarFallback>
                    </Avatar>
                    <span>{m.first_name} {m.last_name}</span>
                    {m.email && <span className="text-muted-foreground ml-auto text-xs">{m.email}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>First Name *</Label>
              <Input
                value={form.first_name}
                onChange={(e) => setForm(f => ({ ...f, first_name: e.target.value }))}
                data-testid="input-member-first-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Last Name *</Label>
              <Input
                value={form.last_name}
                onChange={(e) => setForm(f => ({ ...f, last_name: e.target.value }))}
                data-testid="input-member-last-name"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
              data-testid="input-member-email"
            />
          </div>

          <div className="space-y-2">
            <Label>Individual Goal (optional)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.individual_goal}
              onChange={(e) => setForm(f => ({ ...f, individual_goal: e.target.value }))}
              placeholder="Leave blank for no individual goal"
              data-testid="input-member-goal"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={addMutation.isPending} data-testid="button-add-member">
              {addMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Add Member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}


function CampaignUpdatesAdmin({ campaignId }) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [visibility, setVisibility] = useState('public');
  const [postedByName, setPostedByName] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [attachmentFiles, setAttachmentFiles] = useState([]);
  const [posting, setPosting] = useState(false);
  const fileInputRef = useRef(null);
  const docInputRef = useRef(null);

  const [replyingTo, setReplyingTo] = useState(null);
  const [replyContent, setReplyContent] = useState('');
  const [replyVisibility, setReplyVisibility] = useState('public');
  const [replyPosting, setReplyPosting] = useState(false);

  const [fundraiserSearch, setFundraiserSearch] = useState('');

  const { data: updates, isLoading } = useQuery({
    queryKey: ['campaign-updates-admin', campaignId],
    queryFn: () => apiRequest('GET', `/api/fundraising/campaign-updates?campaign_id=${campaignId}`)
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiRequest('DELETE', `/api/fundraising/campaign-updates?id=${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign-updates-admin', campaignId] });
      toast.success('Update deleted');
    },
    onError: (err) => toast.error(err.message)
  });

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

  const handleDocSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setAttachmentFiles(prev => [...prev, ...files]);
    if (docInputRef.current) docInputRef.current.value = '';
  };

  const removeAttachment = (index) => {
    setAttachmentFiles(prev => prev.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handlePost = async () => {
    if (!content.trim()) return;
    setPosting(true);
    try {
      let imageUrl = null;

      if (imageFile) {
        const formData = new FormData();
        formData.append('file', imageFile);
        const uploadRes = await fetch('/api/fundraising/upload-update-image', {
          method: 'POST',
          body: formData,
          credentials: 'include'
        });
        if (!uploadRes.ok) throw new Error('Image upload failed');
        const uploadData = await uploadRes.json();
        imageUrl = uploadData.url;
      }

      let uploadedAttachments = [];
      if (attachmentFiles.length > 0) {
        for (const file of attachmentFiles) {
          const formData = new FormData();
          formData.append('file', file);
          const uploadRes = await fetch('/api/fundraising/upload-update-file', {
            method: 'POST',
            body: formData,
            credentials: 'include'
          });
          if (!uploadRes.ok) {
            const errData = await uploadRes.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to upload ${file.name}`);
          }
          const uploadData = await uploadRes.json();
          uploadedAttachments.push({
            url: uploadData.url,
            filename: uploadData.filename || file.name,
            mimetype: uploadData.mimetype || file.type,
            size: uploadData.size || file.size
          });
        }
      }

      await apiRequest('POST', '/api/fundraising/campaign-updates', {
        campaign_id: campaignId,
        content: content.trim(),
        image_url: imageUrl,
        attachment_urls: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        visibility,
        posted_by_name: postedByName.trim() || null
      });

      setContent('');
      setVisibility('public');
      setPostedByName('');
      removeImage();
      setAttachmentFiles([]);
      queryClient.invalidateQueries({ queryKey: ['campaign-updates-admin', campaignId] });
      toast.success('Update posted');
    } catch (err) {
      toast.error(err.message || 'Failed to post update');
    } finally {
      setPosting(false);
    }
  };

  const handleReply = async (parentId) => {
    if (!replyContent.trim()) return;
    setReplyPosting(true);
    try {
      await apiRequest('POST', '/api/fundraising/campaign-updates', {
        campaign_id: campaignId,
        content: replyContent.trim(),
        visibility: replyVisibility,
        parent_id: parentId
      });

      setReplyContent('');
      setReplyVisibility('public');
      setReplyingTo(null);
      queryClient.invalidateQueries({ queryKey: ['campaign-updates-admin', campaignId] });
      toast.success('Reply posted');
    } catch (err) {
      toast.error(err.message || 'Failed to post reply');
    } finally {
      setReplyPosting(false);
    }
  };

  const topLevelUpdates = useMemo(() => {
    if (!updates) return [];
    return updates.filter(u => !u.parent_id);
  }, [updates]);

  const repliesByParent = useMemo(() => {
    if (!updates) return {};
    const map = {};
    updates.filter(u => u.parent_id).forEach(u => {
      if (!map[u.parent_id]) map[u.parent_id] = [];
      map[u.parent_id].push(u);
    });
    Object.values(map).forEach(arr => arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
    return map;
  }, [updates]);

  const fundraiserNames = useMemo(() => {
    if (!updates) return [];
    const nameMap = new Map();
    updates.forEach(u => {
      if (u.posted_by !== 'tenant' && u.team_member_id && u.author_name && u.author_name !== 'Unknown') {
        nameMap.set(u.team_member_id, u.author_name);
      }
    });
    return Array.from(nameMap.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [updates]);

  const filteredTopLevel = useMemo(() => {
    if (!fundraiserSearch.trim()) return topLevelUpdates;
    const q = fundraiserSearch.toLowerCase();
    const matchingTeamMemberIds = new Set();
    fundraiserNames.forEach(f => {
      if (f.name.toLowerCase().includes(q)) matchingTeamMemberIds.add(f.id);
    });
    return topLevelUpdates.filter(u =>
      u.posted_by !== 'tenant' && u.team_member_id && matchingTeamMemberIds.has(u.team_member_id)
    );
  }, [topLevelUpdates, fundraiserSearch, fundraiserNames]);

  const renderUpdateCard = (u, isReply = false) => (
    <div
      key={u.id}
      className={`${isReply ? 'ml-8 border-l-2 border-primary/20 pl-4' : 'border rounded-md p-4'} space-y-2 ${isReply ? 'py-3' : ''}`}
      data-testid={`admin-update-${u.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          {isReply && <CornerDownRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${
            u.posted_by === 'tenant' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
          }`}>
            {u.posted_by === 'tenant' ? <Megaphone className="w-3 h-3" /> : u.author_initials}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium flex items-center gap-2 flex-wrap" data-testid={`text-admin-update-author-${u.id}`}>
              {u.author_name}
              {u.posted_by === 'tenant' && (
                <Badge variant="secondary" className="text-xs">Organiser</Badge>
              )}
              <Badge variant={u.visibility === 'public' ? 'outline' : 'secondary'} className="text-xs">
                {u.visibility === 'public' ? (
                  <><Eye className="w-3 h-3 mr-1" />Public</>
                ) : (
                  <><Lock className="w-3 h-3 mr-1" />Private</>
                )}
              </Badge>
            </p>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatRelativeTime(u.created_at)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!isReply && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (replyingTo === u.id) {
                  setReplyingTo(null);
                  setReplyContent('');
                  setReplyVisibility('public');
                } else {
                  setReplyingTo(u.id);
                  setReplyContent('');
                  setReplyVisibility('public');
                }
              }}
              data-testid={`button-reply-update-${u.id}`}
            >
              <Reply className="w-4 h-4" />
            </Button>
          )}
          {u.posted_by === 'tenant' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (window.confirm('Delete this update?')) {
                  deleteMutation.mutate(u.id);
                }
              }}
              data-testid={`button-delete-update-${u.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm" data-testid={`text-admin-update-content-${u.id}`}>{u.content}</p>
      {u.image_url && (
        <img
          src={u.image_url}
          alt=""
          className="rounded-md max-h-48 object-cover"
          data-testid={`img-admin-update-${u.id}`}
        />
      )}
      {u.attachment_urls && u.attachment_urls.length > 0 && (
        <div className="space-y-1 pt-1">
          {u.attachment_urls.map((att, idx) => (
            <a
              key={idx}
              href={att.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover-elevate rounded-md p-1.5"
              data-testid={`link-admin-attachment-${u.id}-${idx}`}
            >
              <FileText className="w-4 h-4 shrink-0" />
              <span className="truncate">{att.filename}</span>
              {att.size && <span className="text-xs shrink-0">({formatFileSize(att.size)})</span>}
              <Download className="w-3.5 h-3.5 ml-auto shrink-0" />
            </a>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Megaphone className="w-4 h-4 text-primary" />
            <CardTitle className="text-base">Post an Update</CardTitle>
          </div>
          <CardDescription>
            Share announcements with fundraisers and supporters
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Message</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write your update message..."
              className="resize-none"
              rows={4}
              data-testid="textarea-admin-update-content"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Visibility</Label>
              <Select value={visibility} onValueChange={setVisibility}>
                <SelectTrigger data-testid="select-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">
                    <span className="flex items-center gap-2">
                      <Eye className="w-3.5 h-3.5" />
                      Public - visible on donation pages
                    </span>
                  </SelectItem>
                  <SelectItem value="private">
                    <span className="flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5" />
                      Private - fundraiser dashboard only
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Posted by (optional)</Label>
              <Input
                value={postedByName}
                onChange={(e) => setPostedByName(e.target.value)}
                placeholder="e.g. Campaign Team"
                data-testid="input-posted-by-name"
              />
            </div>
          </div>

          {imagePreview && (
            <div className="relative inline-block">
              <img
                src={imagePreview}
                alt="Preview"
                className="w-24 h-24 object-cover rounded-md"
                data-testid="img-admin-update-preview"
              />
              <Button
                size="icon"
                variant="secondary"
                className="absolute -top-2 -right-2 rounded-full"
                onClick={removeImage}
                data-testid="button-admin-remove-image"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          )}

          {attachmentFiles.length > 0 && (
            <div className="space-y-1">
              {attachmentFiles.map((file, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`attachment-pending-${idx}`}>
                  <FileText className="w-4 h-4 shrink-0" />
                  <span className="truncate max-w-[200px]">{file.name}</span>
                  <span className="text-xs">({formatFileSize(file.size)})</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeAttachment(idx)}
                    data-testid={`button-remove-attachment-${idx}`}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              className="hidden"
              data-testid="input-admin-update-image"
            />
            <input
              ref={docInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt"
              onChange={handleDocSelect}
              multiple
              className="hidden"
              data-testid="input-admin-update-file"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-admin-add-image"
            >
              <ImagePlus className="w-4 h-4 mr-1" />
              Add Photo
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => docInputRef.current?.click()}
              data-testid="button-admin-attach-file"
            >
              <Paperclip className="w-4 h-4 mr-1" />
              Attach File
            </Button>
            <Button
              size="sm"
              disabled={!content.trim() || posting}
              onClick={handlePost}
              data-testid="button-admin-post-update"
            >
              {posting && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Post Update
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base">All Updates</CardTitle>
              <CardDescription>
                Updates from you and your fundraisers
              </CardDescription>
            </div>
          </div>
          {fundraiserNames.length > 0 && (
            <div className="relative mt-2">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={fundraiserSearch}
                onChange={(e) => setFundraiserSearch(e.target.value)}
                placeholder="Filter by fundraiser name..."
                className="pl-9"
                data-testid="input-filter-fundraiser"
              />
              {fundraiserSearch && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setFundraiserSearch('')}
                  data-testid="button-clear-fundraiser-filter"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : !updates || updates.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>No updates yet. Post your first update above.</p>
            </div>
          ) : filteredTopLevel.length === 0 && fundraiserSearch ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <Search className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>No updates found for "{fundraiserSearch}"</p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredTopLevel.map((u) => (
                <div key={u.id} className="space-y-0">
                  {renderUpdateCard(u, false)}

                  {repliesByParent[u.id] && repliesByParent[u.id].length > 0 && (
                    <div className="space-y-0 mt-2">
                      {repliesByParent[u.id].map(reply => renderUpdateCard(reply, true))}
                    </div>
                  )}

                  {replyingTo === u.id && (
                    <div className="ml-8 border-l-2 border-primary/20 pl-4 pt-3 space-y-3" data-testid={`reply-form-${u.id}`}>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Reply className="w-3.5 h-3.5" />
                        <span>Replying to {u.author_name}</span>
                      </div>
                      <Textarea
                        value={replyContent}
                        onChange={(e) => setReplyContent(e.target.value)}
                        placeholder="Write your reply..."
                        className="resize-none"
                        rows={2}
                        autoFocus
                        data-testid={`textarea-reply-${u.id}`}
                      />
                      <div className="flex items-center gap-2 flex-wrap">
                        <Select value={replyVisibility} onValueChange={setReplyVisibility}>
                          <SelectTrigger className="w-auto" data-testid={`select-reply-visibility-${u.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="public">
                              <span className="flex items-center gap-1.5">
                                <Eye className="w-3 h-3" />
                                Public
                              </span>
                            </SelectItem>
                            <SelectItem value="private">
                              <span className="flex items-center gap-1.5">
                                <Lock className="w-3 h-3" />
                                Private
                              </span>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          disabled={!replyContent.trim() || replyPosting}
                          onClick={() => handleReply(u.id)}
                          data-testid={`button-submit-reply-${u.id}`}
                        >
                          {replyPosting && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                          Reply
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setReplyingTo(null);
                            setReplyContent('');
                            setReplyVisibility('public');
                          }}
                          data-testid={`button-cancel-reply-${u.id}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
