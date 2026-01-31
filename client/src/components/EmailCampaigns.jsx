import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  Mail, Plus, Pencil, Trash2, Send, Eye, BarChart3, 
  Loader2, Calendar, Clock, Users, MousePointerClick,
  CheckCircle2, XCircle, AlertTriangle, TrendingUp
} from "lucide-react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";

export default function EmailCampaigns() {
  const queryClient = useQueryClient();
  const [showCampaignDialog, setShowCampaignDialog] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [campaignToDelete, setCampaignToDelete] = useState(null);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [showStatsDialog, setShowStatsDialog] = useState(false);
  const [statsData, setStatsData] = useState(null);
  const [sending, setSending] = useState(false);

  const { data: campaigns = [], isLoading: campaignsLoading } = useQuery({
    queryKey: ['email-campaigns'],
    queryFn: async () => {
      const response = await fetch('/api/email-campaigns', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch campaigns');
      return response.json();
    },
    staleTime: 30000
  });

  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => base44.entities.EmailTemplate.list({ filter: { is_active: true } }),
    staleTime: 60000
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['communication-categories'],
    queryFn: () => base44.entities.CommunicationCategory.list(),
    staleTime: 60000
  });

  const { data: memberGroups = [] } = useQuery({
    queryKey: ['member-groups'],
    queryFn: () => base44.entities.MemberGroup.list(),
    staleTime: 60000
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 60000
  });

  const [formData, setFormData] = useState({
    name: '',
    subject: '',
    from_name: '',
    from_email: '',
    reply_to: '',
    email_template_id: '',
    html_content: '',
    target_type: 'communication_category',
    target_ids: []
  });

  const openNewCampaignDialog = () => {
    setEditingCampaign(null);
    setFormData({
      name: '',
      subject: '',
      from_name: '',
      from_email: '',
      reply_to: '',
      email_template_id: '',
      html_content: '',
      target_type: 'communication_category',
      target_ids: []
    });
    setShowCampaignDialog(true);
  };

  const openEditCampaignDialog = (campaign) => {
    setEditingCampaign(campaign);
    setFormData({
      name: campaign.name || '',
      subject: campaign.subject || '',
      from_name: campaign.from_name || '',
      from_email: campaign.from_email || '',
      reply_to: campaign.reply_to || '',
      email_template_id: campaign.email_template_id || '',
      html_content: campaign.html_content || '',
      target_type: campaign.target_type || 'communication_category',
      target_ids: campaign.target_ids || []
    });
    setShowCampaignDialog(true);
  };

  const handleTemplateSelect = async (templateId) => {
    setFormData(prev => ({ ...prev, email_template_id: templateId }));
    
    if (templateId) {
      const template = emailTemplates.find(t => t.id === templateId);
      if (template) {
        setFormData(prev => ({
          ...prev,
          subject: prev.subject || template.subject || '',
          html_content: template.body || '',
          from_name: prev.from_name || template.from_name || '',
          from_email: prev.from_email || template.from_email || ''
        }));
      }
    }
  };

  const handleSaveCampaign = async () => {
    if (!formData.name || !formData.subject) {
      toast.error('Name and subject are required');
      return;
    }

    try {
      const url = editingCampaign 
        ? `/api/email-campaigns/${editingCampaign.id}`
        : '/api/email-campaigns';
      
      const response = await fetch(url, {
        method: editingCampaign ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save campaign');
      }

      toast.success(editingCampaign ? 'Campaign updated' : 'Campaign created');
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      setShowCampaignDialog(false);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleDeleteCampaign = async () => {
    if (!campaignToDelete) return;

    try {
      const response = await fetch(`/api/email-campaigns/${campaignToDelete.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to delete campaign');

      toast.success('Campaign deleted');
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      setShowDeleteConfirm(false);
      setCampaignToDelete(null);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handlePreviewRecipients = async (campaign) => {
    try {
      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id, preview: true })
      });

      if (!response.ok) throw new Error('Failed to preview recipients');

      const data = await response.json();
      setPreviewData({ campaign, ...data });
      setShowPreviewDialog(true);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleSendCampaign = async (campaign) => {
    if (sending) return;
    setSending(true);

    try {
      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send campaign');
      }

      const result = await response.json();
      toast.success(`Campaign sent to ${result.sent} recipients`);
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      setShowPreviewDialog(false);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  };

  const handleViewStats = async (campaign) => {
    try {
      const [statsResponse, heatmapResponse] = await Promise.all([
        fetch(`/api/email-campaigns/${campaign.id}?stats=true`, { credentials: 'include' }),
        fetch(`/api/email-campaigns/${campaign.id}?heatmap=true`, { credentials: 'include' })
      ]);

      if (!statsResponse.ok) throw new Error('Failed to fetch stats');

      const statsData = await statsResponse.json();
      let heatmapData = [];
      
      if (heatmapResponse.ok) {
        const heatmapResult = await heatmapResponse.json();
        heatmapData = heatmapResult.heatmapData || [];
      }

      setStatsData({ ...statsData, heatmapData });
      setShowStatsDialog(true);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const getStatusBadge = (status) => {
    const statusConfig = {
      draft: { label: 'Draft', variant: 'secondary' },
      scheduled: { label: 'Scheduled', variant: 'outline', className: 'border-blue-500 text-blue-600' },
      sending: { label: 'Sending', variant: 'outline', className: 'border-amber-500 text-amber-600' },
      sent: { label: 'Sent', variant: 'outline', className: 'border-green-500 text-green-600' },
      failed: { label: 'Failed', variant: 'destructive' },
      cancelled: { label: 'Cancelled', variant: 'secondary' }
    };

    const config = statusConfig[status] || statusConfig.draft;
    return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
  };

  const getTargetLabel = (campaign) => {
    if (campaign.target_type === 'communication_category') {
      const names = (campaign.target_ids || [])
        .map(id => categories.find(c => c.id === id)?.name)
        .filter(Boolean);
      return names.length > 0 ? names.join(', ') : 'No categories selected';
    }
    if (campaign.target_type === 'member_group') {
      const names = (campaign.target_ids || [])
        .map(id => memberGroups.find(g => g.id === id)?.name)
        .filter(Boolean);
      return names.length > 0 ? names.join(', ') : 'No groups selected';
    }
    if (campaign.target_type === 'role') {
      const names = (campaign.target_ids || [])
        .map(id => roles.find(r => r.id === id)?.name)
        .filter(Boolean);
      return names.length > 0 ? names.join(', ') : 'No roles selected';
    }
    if (campaign.target_type === 'all_members') {
      return 'All Members';
    }
    return 'Unknown';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">Email Campaigns</h3>
          <p className="text-sm text-muted-foreground">
            Create and send email campaigns to your members
          </p>
        </div>
        <Button 
          onClick={openNewCampaignDialog}
          className="bg-blue-600 hover:bg-blue-700"
          data-testid="button-create-campaign"
        >
          <Plus className="w-4 h-4 mr-2" />
          Create Campaign
        </Button>
      </div>

      {campaignsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed rounded-lg">
          <Mail className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">No Campaigns Yet</h3>
          <p className="text-muted-foreground mb-4">
            Create your first email campaign to reach your members
          </p>
          <Button 
            onClick={openNewCampaignDialog}
            data-testid="button-create-first-campaign"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create First Campaign
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <Card key={campaign.id} className="border" data-testid={`card-campaign-${campaign.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <h4 className="font-semibold">{campaign.name}</h4>
                      {getStatusBadge(campaign.status)}
                    </div>
                    <p className="text-sm text-muted-foreground mb-2">
                      Subject: {campaign.subject}
                    </p>
                    <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Users className="w-4 h-4" />
                        {getTargetLabel(campaign)}
                      </span>
                      {campaign.sent_at && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-4 h-4" />
                          Sent {new Date(campaign.sent_at).toLocaleDateString()}
                        </span>
                      )}
                      {campaign.status === 'sent' && (
                        <>
                          <span className="flex items-center gap-1">
                            <Send className="w-4 h-4" />
                            {campaign.sent_count || 0} sent
                          </span>
                          <span className="flex items-center gap-1">
                            <Eye className="w-4 h-4" />
                            {campaign.opened_count || 0} opened
                          </span>
                          <span className="flex items-center gap-1">
                            <MousePointerClick className="w-4 h-4" />
                            {campaign.clicked_count || 0} clicked
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {campaign.status === 'draft' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handlePreviewRecipients(campaign)}
                          data-testid={`button-preview-${campaign.id}`}
                        >
                          <Eye className="w-4 h-4 mr-1" />
                          Preview
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEditCampaignDialog(campaign)}
                          data-testid={`button-edit-${campaign.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setCampaignToDelete(campaign);
                            setShowDeleteConfirm(true);
                          }}
                          data-testid={`button-delete-${campaign.id}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </>
                    )}
                    {campaign.status === 'sent' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleViewStats(campaign)}
                        data-testid={`button-stats-${campaign.id}`}
                      >
                        <BarChart3 className="w-4 h-4 mr-1" />
                        Stats
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCampaignDialog} onOpenChange={setShowCampaignDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingCampaign ? 'Edit Campaign' : 'Create New Campaign'}
            </DialogTitle>
            <DialogDescription>
              Configure your email campaign settings and content
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Campaign Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., January Newsletter"
                  data-testid="input-campaign-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subject">Email Subject *</Label>
                <Input
                  id="subject"
                  value={formData.subject}
                  onChange={(e) => setFormData(prev => ({ ...prev, subject: e.target.value }))}
                  placeholder="e.g., Your Monthly Update"
                  data-testid="input-campaign-subject"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="from_name">From Name</Label>
                <Input
                  id="from_name"
                  value={formData.from_name}
                  onChange={(e) => setFormData(prev => ({ ...prev, from_name: e.target.value }))}
                  placeholder="e.g., ACME Company"
                  data-testid="input-from-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="from_email">From Email</Label>
                <Input
                  id="from_email"
                  type="email"
                  value={formData.from_email}
                  onChange={(e) => setFormData(prev => ({ ...prev, from_email: e.target.value }))}
                  placeholder="e.g., news@company.com"
                  data-testid="input-from-email"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="template">Email Template</Label>
              <Select
                value={formData.email_template_id || ''}
                onValueChange={handleTemplateSelect}
              >
                <SelectTrigger data-testid="select-template">
                  <SelectValue placeholder="Select a template (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No template</SelectItem>
                  {emailTemplates.map(template => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Target Audience</Label>
              <Select
                value={formData.target_type}
                onValueChange={(value) => setFormData(prev => ({ 
                  ...prev, 
                  target_type: value,
                  target_ids: []
                }))}
              >
                <SelectTrigger data-testid="select-target-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="communication_category">Communication Categories</SelectItem>
                  <SelectItem value="member_group">Member Groups</SelectItem>
                  <SelectItem value="role">Roles</SelectItem>
                  <SelectItem value="all_members">All Members</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.target_type !== 'all_members' && (
              <div className="space-y-2">
                <Label>
                  Select {formData.target_type === 'communication_category' ? 'Categories' : 
                          formData.target_type === 'member_group' ? 'Groups' : 'Roles'}
                </Label>
                <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                  {formData.target_type === 'communication_category' && categories.map(cat => (
                    <label key={cat.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.target_ids.includes(cat.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setFormData(prev => ({ ...prev, target_ids: [...prev.target_ids, cat.id] }));
                          } else {
                            setFormData(prev => ({ ...prev, target_ids: prev.target_ids.filter(id => id !== cat.id) }));
                          }
                        }}
                        className="rounded"
                      />
                      <span>{cat.name}</span>
                    </label>
                  ))}
                  {formData.target_type === 'member_group' && memberGroups.map(group => (
                    <label key={group.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.target_ids.includes(group.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setFormData(prev => ({ ...prev, target_ids: [...prev.target_ids, group.id] }));
                          } else {
                            setFormData(prev => ({ ...prev, target_ids: prev.target_ids.filter(id => id !== group.id) }));
                          }
                        }}
                        className="rounded"
                      />
                      <span>{group.name}</span>
                    </label>
                  ))}
                  {formData.target_type === 'role' && roles.map(role => (
                    <label key={role.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.target_ids.includes(role.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setFormData(prev => ({ ...prev, target_ids: [...prev.target_ids, role.id] }));
                          } else {
                            setFormData(prev => ({ ...prev, target_ids: prev.target_ids.filter(id => id !== role.id) }));
                          }
                        }}
                        className="rounded"
                      />
                      <span>{role.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="html_content">Email Content (HTML)</Label>
              <Textarea
                id="html_content"
                value={formData.html_content}
                onChange={(e) => setFormData(prev => ({ ...prev, html_content: e.target.value }))}
                placeholder="Enter your email HTML content..."
                className="min-h-[200px] font-mono text-sm"
                data-testid="textarea-html-content"
              />
              <p className="text-xs text-muted-foreground">
                Available placeholders: {'{{first_name}}'}, {'{{last_name}}'}, {'{{email}}'}, {'{{unsubscribe_url}}'}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCampaignDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveCampaign} data-testid="button-save-campaign">
              {editingCampaign ? 'Update Campaign' : 'Create Campaign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Campaign</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{campaignToDelete?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteCampaign}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPreviewDialog} onOpenChange={setShowPreviewDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send Campaign</DialogTitle>
            <DialogDescription>
              Review recipients before sending "{previewData?.campaign?.name}"
            </DialogDescription>
          </DialogHeader>
          
          {previewData && (
            <div className="py-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <div className="flex items-center gap-2 text-blue-700 font-medium">
                  <Users className="w-5 h-5" />
                  {previewData.recipientCount} recipients will receive this email
                </div>
              </div>
              
              {previewData.sampleRecipients?.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">Sample recipients:</h4>
                  <div className="text-sm text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
                    {previewData.sampleRecipients.map((r, i) => (
                      <div key={i}>
                        {r.firstName} {r.lastName} ({r.email})
                      </div>
                    ))}
                    {previewData.recipientCount > 10 && (
                      <div className="text-muted-foreground italic">
                        ...and {previewData.recipientCount - 10} more
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPreviewDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={() => handleSendCampaign(previewData?.campaign)}
              disabled={sending || previewData?.recipientCount === 0}
              className="bg-green-600 hover:bg-green-700"
            >
              {sending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  Send Now
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showStatsDialog} onOpenChange={setShowStatsDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Campaign Statistics</DialogTitle>
            <DialogDescription>
              Performance metrics for "{statsData?.campaign?.name}"
            </DialogDescription>
          </DialogHeader>
          
          {statsData && (
            <div className="py-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <Card>
                  <CardContent className="p-4 text-center">
                    <Send className="w-6 h-6 mx-auto mb-2 text-blue-500" />
                    <div className="text-2xl font-bold">{statsData.stats.sent}</div>
                    <div className="text-sm text-muted-foreground">Sent</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <CheckCircle2 className="w-6 h-6 mx-auto mb-2 text-green-500" />
                    <div className="text-2xl font-bold">{statsData.stats.delivered}</div>
                    <div className="text-sm text-muted-foreground">Delivered</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <Eye className="w-6 h-6 mx-auto mb-2 text-purple-500" />
                    <div className="text-2xl font-bold">{statsData.stats.opened}</div>
                    <div className="text-sm text-muted-foreground">Opened ({statsData.stats.openRate}%)</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4 text-center">
                    <MousePointerClick className="w-6 h-6 mx-auto mb-2 text-amber-500" />
                    <div className="text-2xl font-bold">{statsData.stats.clicked}</div>
                    <div className="text-sm text-muted-foreground">Clicked ({statsData.stats.clickRate}%)</div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-3 gap-4 mb-6">
                <Card className="border-red-200">
                  <CardContent className="p-3 text-center">
                    <XCircle className="w-5 h-5 mx-auto mb-1 text-red-500" />
                    <div className="text-lg font-bold">{statsData.stats.bounced}</div>
                    <div className="text-xs text-muted-foreground">Bounced ({statsData.stats.bounceRate}%)</div>
                  </CardContent>
                </Card>
                <Card className="border-amber-200">
                  <CardContent className="p-3 text-center">
                    <AlertTriangle className="w-5 h-5 mx-auto mb-1 text-amber-500" />
                    <div className="text-lg font-bold">{statsData.stats.unsubscribed}</div>
                    <div className="text-xs text-muted-foreground">Unsubscribed</div>
                  </CardContent>
                </Card>
                <Card className="border-red-200">
                  <CardContent className="p-3 text-center">
                    <AlertTriangle className="w-5 h-5 mx-auto mb-1 text-red-500" />
                    <div className="text-lg font-bold">{statsData.stats.complained}</div>
                    <div className="text-xs text-muted-foreground">Complaints</div>
                  </CardContent>
                </Card>
              </div>

              {statsData.heatmapData && statsData.heatmapData.length > 0 && (
                <div className="border-t pt-4">
                  <h4 className="font-medium mb-3 flex items-center gap-2">
                    <MousePointerClick className="w-4 h-4" />
                    Click Heatmap - Top Links
                  </h4>
                  <div className="space-y-2">
                    {statsData.heatmapData.slice(0, 10).map((link, idx) => {
                      const maxClicks = statsData.heatmapData[0]?.clicks || 1;
                      const intensity = Math.round((link.clicks / maxClicks) * 100);
                      return (
                        <div key={idx} className="flex items-center gap-3">
                          <div className="w-16 text-right text-sm font-medium">{link.clicks} clicks</div>
                          <div className="flex-1 relative h-6 bg-slate-100 rounded overflow-hidden">
                            <div 
                              className="absolute inset-y-0 left-0 bg-gradient-to-r from-amber-400 to-red-500 rounded"
                              style={{ width: `${intensity}%` }}
                            />
                            <span className="absolute inset-0 flex items-center px-2 text-xs truncate">
                              {link.text || link.url?.substring(0, 50) || `Link ${link.index + 1}`}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStatsDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
