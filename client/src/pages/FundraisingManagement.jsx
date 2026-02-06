import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import {
  Heart, Plus, Trash2, Save, Users, Link as LinkIcon, Copy, Check,
  ArrowLeft, Target, Calendar, Loader2, Search, ExternalLink, UserPlus,
  Eye, BarChart3, Gift, PoundSterling
} from "lucide-react";
import { toast } from "sonner";

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
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

const STATUS_CONFIG = {
  draft: { label: 'Draft', variant: 'secondary' },
  active: { label: 'Active', variant: 'default' },
  completed: { label: 'Completed', variant: 'outline' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
};

export default function FundraisingManagement() {
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);

  if (selectedCampaignId) {
    return (
      <CampaignDetail
        campaignId={selectedCampaignId}
        onBack={() => setSelectedCampaignId(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Fundraising</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage fundraising campaigns and donation pages</p>
        </div>
        <Button
          onClick={() => { setEditingCampaign(null); setShowCreateModal(true); }}
          data-testid="button-create-campaign"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Campaign
        </Button>
      </div>

      <CampaignList
        onSelect={setSelectedCampaignId}
        onEdit={(c) => { setEditingCampaign(c); setShowCreateModal(true); }}
      />

      {showCreateModal && (
        <CampaignFormModal
          campaign={editingCampaign}
          onClose={() => { setShowCreateModal(false); setEditingCampaign(null); }}
        />
      )}
    </div>
  );
}

function CampaignList({ onSelect, onEdit }) {
  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['fundraising-campaigns'],
    queryFn: async () => {
      const res = await fetch('/api/fundraising/campaigns', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch campaigns');
      return res.json();
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaigns || campaigns.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Heart className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No campaigns yet</h3>
          <p className="text-muted-foreground text-sm">Create your first fundraising campaign to get started</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {campaigns.map(campaign => {
        const statusConfig = STATUS_CONFIG[campaign.status] || STATUS_CONFIG.draft;
        const progressPercent = campaign.goal_amount > 0
          ? Math.min(100, Math.round((campaign.total_raised / parseFloat(campaign.goal_amount)) * 100))
          : 0;

        return (
          <Card
            key={campaign.id}
            className="hover-elevate cursor-pointer"
            onClick={() => onSelect(campaign.id)}
            data-testid={`card-campaign-${campaign.id}`}
          >
            {campaign.cover_image_url && (
              <div className="h-32 overflow-hidden rounded-t-md">
                <img
                  src={campaign.cover_image_url}
                  alt={campaign.name}
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base leading-tight">{campaign.name}</CardTitle>
                <Badge variant={statusConfig.variant} className="shrink-0">
                  {statusConfig.label}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">
                  {formatCurrency(campaign.total_raised, campaign.currency)}
                </span>
                <span className="text-muted-foreground">
                  of {formatCurrency(campaign.goal_amount, campaign.currency)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  {campaign.team_member_count || 0} team members
                </span>
                <span className="flex items-center gap-1">
                  <Heart className="w-3 h-3" />
                  {campaign.donation_count || 0} donations
                </span>
              </div>
              {campaign.end_date && (
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  Ends {formatDate(campaign.end_date)}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function CampaignFormModal({ campaign, onClose }) {
  const queryClient = useQueryClient();
  const isEditing = !!campaign;

  const [form, setForm] = useState({
    name: campaign?.name || '',
    description: campaign?.description || '',
    cover_image_url: campaign?.cover_image_url || '',
    goal_amount: campaign?.goal_amount?.toString() || '',
    currency: campaign?.currency || 'GBP',
    start_date: campaign?.start_date ? campaign.start_date.substring(0, 10) : '',
    end_date: campaign?.end_date ? campaign.end_date.substring(0, 10) : '',
    status: campaign?.status || 'draft',
    allow_anonymous_donations: campaign?.allow_anonymous_donations !== false
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      const url = isEditing
        ? `/api/fundraising/campaigns?id=${campaign.id}`
        : '/api/fundraising/campaigns';
      const res = await fetch(url, {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save campaign');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fundraising-campaigns'] });
      toast.success(isEditing ? 'Campaign updated' : 'Campaign created');
      onClose();
    },
    onError: (err) => {
      toast.error(err.message);
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error('Campaign name is required');
      return;
    }
    if (!form.goal_amount || parseFloat(form.goal_amount) <= 0) {
      toast.error('Goal amount must be greater than zero');
      return;
    }
    saveMutation.mutate({
      ...form,
      goal_amount: parseFloat(form.goal_amount),
      start_date: form.start_date || null,
      end_date: form.end_date || null
    });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Campaign' : 'New Campaign'}</DialogTitle>
          <DialogDescription>
            {isEditing ? 'Update your campaign details' : 'Set up a new fundraising campaign'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Campaign Name *</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Annual Charity Run 2026"
              data-testid="input-campaign-name"
            />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Tell donors what this campaign is about..."
              rows={3}
              data-testid="input-campaign-description"
            />
          </div>

          <div className="space-y-2">
            <Label>Cover Image URL</Label>
            <Input
              value={form.cover_image_url}
              onChange={(e) => setForm(f => ({ ...f, cover_image_url: e.target.value }))}
              placeholder="https://..."
              data-testid="input-campaign-image"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Goal Amount *</Label>
              <Input
                type="number"
                min="1"
                step="0.01"
                value={form.goal_amount}
                onChange={(e) => setForm(f => ({ ...f, goal_amount: e.target.value }))}
                placeholder="5000"
                data-testid="input-campaign-goal"
              />
            </div>
            <div className="space-y-2">
              <Label>Currency</Label>
              <Select
                value={form.currency}
                onValueChange={(v) => setForm(f => ({ ...f, currency: v }))}
              >
                <SelectTrigger data-testid="select-campaign-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label} ({c.symbol})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Start Date</Label>
              <Input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
                data-testid="input-campaign-start"
              />
            </div>
            <div className="space-y-2">
              <Label>End Date</Label>
              <Input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))}
                data-testid="input-campaign-end"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Status</Label>
            <Select
              value={form.status}
              onValueChange={(v) => setForm(f => ({ ...f, status: v }))}
            >
              <SelectTrigger data-testid="select-campaign-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label>Allow anonymous donations</Label>
            <Switch
              checked={form.allow_anonymous_donations}
              onCheckedChange={(v) => setForm(f => ({ ...f, allow_anonymous_donations: v }))}
              data-testid="switch-anonymous"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saveMutation.isPending} data-testid="button-save-campaign">
              {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {isEditing ? 'Update' : 'Create'} Campaign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CampaignDetail({ campaignId, onBack }) {
  const queryClient = useQueryClient();
  const [showAddMember, setShowAddMember] = useState(false);
  const [showDonations, setShowDonations] = useState(false);
  const [copiedToken, setCopiedToken] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['fundraising-campaigns', campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/fundraising/campaigns?id=${campaignId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch campaign');
      return res.json();
    }
  });

  const { data: donations } = useQuery({
    queryKey: ['fundraising-donations', campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/fundraising/donations?campaign_id=${campaignId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch donations');
      return res.json();
    },
    enabled: showDonations
  });

  const deleteCampaignMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/fundraising/campaigns?id=${campaignId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to delete campaign');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fundraising-campaigns'] });
      toast.success('Campaign deleted');
      onBack();
    },
    onError: (err) => toast.error(err.message)
  });

  const removeTeamMemberMutation = useMutation({
    mutationFn: async (memberId) => {
      const res = await fetch(`/api/fundraising/team-members?id=${memberId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to remove team member');
      return res.json();
    },
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Campaign not found</p>
        <Button variant="outline" onClick={onBack} className="mt-4">Go Back</Button>
      </div>
    );
  }

  const progressPercent = campaign.goal_amount > 0
    ? Math.min(100, Math.round((campaign.total_raised / parseFloat(campaign.goal_amount)) * 100))
    : 0;

  const statusConfig = STATUS_CONFIG[campaign.status] || STATUS_CONFIG.draft;

  return (
    <div className="space-y-6">
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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowEditModal(true)}
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

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-primary/10">
                <Target className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Goal</p>
                <p className="text-lg font-bold" data-testid="text-campaign-goal">
                  {formatCurrency(campaign.goal_amount, campaign.currency)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-green-500/10">
                <PoundSterling className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Raised</p>
                <p className="text-lg font-bold" data-testid="text-campaign-raised">
                  {formatCurrency(campaign.total_raised, campaign.currency)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-blue-500/10">
                <Heart className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Donations</p>
                <p className="text-lg font-bold" data-testid="text-donation-count">
                  {campaign.donation_count || 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-purple-500/10">
                <BarChart3 className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Progress</p>
                <p className="text-lg font-bold">{progressPercent}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-lg">Team Members</CardTitle>
          <Button onClick={() => setShowAddMember(true)} data-testid="button-add-team-member">
            <UserPlus className="w-4 h-4 mr-2" />
            Add Member
          </Button>
        </CardHeader>
        <CardContent>
          {(!campaign.team_members || campaign.team_members.length === 0) ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No team members added yet. Add team members to generate unique donation page links.
            </div>
          ) : (
            <div className="space-y-3">
              {campaign.team_members.map(member => {
                const memberDonations = campaign.total_raised; // Approximate
                return (
                  <div
                    key={member.id}
                    className="flex items-center justify-between gap-4 p-3 rounded-md border"
                    data-testid={`row-team-member-${member.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
                        {member.first_name?.[0]}{member.last_name?.[0]}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium truncate">
                          {member.first_name} {member.last_name}
                        </p>
                        {member.email && (
                          <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                        )}
                        {member.member_id && (
                          <Badge variant="secondary" className="mt-1">Tenant Member</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {member.individual_goal && (
                        <span className="text-xs text-muted-foreground">
                          Goal: {formatCurrency(member.individual_goal, campaign.currency)}
                        </span>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); copyDonationLink(member.token); }}
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
                            removeTeamMemberMutation.mutate(member.id);
                          }
                        }}
                        data-testid={`button-remove-member-${member.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-lg">Donations</CardTitle>
          <Button
            variant="outline"
            onClick={() => setShowDonations(!showDonations)}
            data-testid="button-toggle-donations"
          >
            {showDonations ? 'Hide' : 'Show'} Donations
          </Button>
        </CardHeader>
        {showDonations && (
          <CardContent>
            {!donations ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : donations.donations?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No donations received yet.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm text-muted-foreground pb-2 border-b">
                  <span>Total raised: {formatCurrency(donations.summary?.total_raised, campaign.currency)}</span>
                  <span>Gift Aid claims: {donations.summary?.gift_aid_count || 0}</span>
                </div>
                {donations.donations.map(donation => (
                  <div
                    key={donation.id}
                    className="flex items-center justify-between gap-4 p-3 rounded-md border"
                    data-testid={`row-donation-${donation.id}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm">
                        {donation.is_anonymous ? 'Anonymous' : donation.donor_name}
                        {donation.gift_aid && (
                          <Badge variant="secondary" className="ml-2">Gift Aid</Badge>
                        )}
                      </p>
                      {donation.donor_email && (
                        <p className="text-xs text-muted-foreground">{donation.donor_email}</p>
                      )}
                      {donation.donor_message && (
                        <p className="text-xs text-muted-foreground mt-1 italic">"{donation.donor_message}"</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        via {donation.fundraising_team_member?.first_name} {donation.fundraising_team_member?.last_name}
                        {' \u00b7 '}{formatDate(donation.created_at)}
                      </p>
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
            )}
          </CardContent>
        )}
      </Card>

      {showAddMember && (
        <AddTeamMemberModal
          campaignId={campaignId}
          onClose={() => setShowAddMember(false)}
        />
      )}

      {showEditModal && (
        <CampaignFormModal
          campaign={campaign}
          onClose={() => setShowEditModal(false)}
        />
      )}
    </div>
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
      const res = await fetch(`/api/members?search=${encodeURIComponent(memberSearch)}&limit=10`, {
        credentials: 'include'
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.members || data || [];
    },
    enabled: mode === 'member' && memberSearch.length >= 2
  });

  const addMutation = useMutation({
    mutationFn: async (data) => {
      const res = await fetch('/api/fundraising/team-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaign_id: campaignId, ...data })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to add team member');
      }
      return res.json();
    },
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
            Add a member to this fundraising campaign. They'll get a unique donation page link.
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
                    <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
                      {m.first_name?.[0]}{m.last_name?.[0]}
                    </div>
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
