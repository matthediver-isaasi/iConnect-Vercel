import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  Mail, Plus, Pencil, Trash2, Send, Eye, BarChart3, 
  Loader2, Calendar, Clock, Users, MousePointerClick,
  CheckCircle2, TrendingUp, TestTube2, Target, MailOpen, Link2
} from "lucide-react";
import { toast } from "sonner";

export default function EmailCampaigns() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [campaignToDelete, setCampaignToDelete] = useState(null);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [showStatsDialog, setShowStatsDialog] = useState(false);
  const [statsData, setStatsData] = useState(null);
  const [sending, setSending] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');
  const [showTestEmailDialog, setShowTestEmailDialog] = useState(false);
  const [testEmailAddress, setTestEmailAddress] = useState('');
  const [testEmailCampaign, setTestEmailCampaign] = useState(null);

  const { data: campaigns = [], isLoading: campaignsLoading } = useQuery({
    queryKey: ['email-campaigns'],
    queryFn: async () => {
      const response = await fetch('/api/email-campaigns', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch campaigns');
      return response.json();
    },
    staleTime: 30000
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['communication-categories'],
    queryFn: async () => {
      const response = await fetch('/api/communication-categories', { credentials: 'include' });
      if (!response.ok) return [];
      return response.json();
    }
  });

  const { data: memberGroups = [] } = useQuery({
    queryKey: ['member-groups'],
    queryFn: async () => {
      const response = await fetch('/api/member-groups', { credentials: 'include' });
      if (!response.ok) return [];
      return response.json();
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      const response = await fetch('/api/roles', { credentials: 'include' });
      if (!response.ok) return [];
      return response.json();
    }
  });

  const stats = useMemo(() => {
    const sentCampaigns = campaigns.filter(c => c.status === 'sent');
    const totalSent = sentCampaigns.reduce((sum, c) => sum + (c.sent_count || 0), 0);
    const totalOpened = sentCampaigns.reduce((sum, c) => sum + (c.opened_count || 0), 0);
    const totalClicked = sentCampaigns.reduce((sum, c) => sum + (c.clicked_count || 0), 0);
    const avgOpenRate = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : 0;
    const avgClickRate = totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : 0;
    const draftCount = campaigns.filter(c => c.status === 'draft').length;
    const scheduledCount = campaigns.filter(c => c.status === 'scheduled').length;

    return {
      totalCampaigns: campaigns.length,
      sentCampaigns: sentCampaigns.length,
      totalSent,
      totalOpened,
      totalClicked,
      avgOpenRate,
      avgClickRate,
      draftCount,
      scheduledCount
    };
  }, [campaigns]);

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

  const handleTestSend = async (campaign, testEmail) => {
    if (testSending) return;
    setTestSending(true);

    try {
      const response = await fetch('/api/email-campaigns/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id, testEmail })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send test email');
      }

      toast.success(data.message || `Test email sent to ${testEmail}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTestSending(false);
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

  const handleScheduleCampaign = async (campaign, scheduledAtLocal) => {
    if (sending) return;
    setSending(true);

    try {
      const scheduledAtUTC = new Date(scheduledAtLocal).toISOString();
      
      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id, scheduledAt: scheduledAtUTC })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to schedule campaign');
      }

      toast.success(`Campaign scheduled for ${new Date(scheduledAtLocal).toLocaleString()}`);
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      setShowPreviewDialog(false);
      setScheduleMode(false);
      setScheduleDateTime('');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  };

  const handleViewStats = async (campaign) => {
    try {
      const statsResponse = await fetch(`/api/email-campaigns/${campaign.id}?stats=true`, {
        credentials: 'include'
      });

      if (!statsResponse.ok) throw new Error('Failed to fetch campaign stats');

      const statsData = await statsResponse.json();
      
      let heatmapData = [];
      if (statsData.clicked_count > 0) {
        const heatmapResponse = await fetch(`/api/email-campaigns/${campaign.id}?heatmap=true`, {
          credentials: 'include'
        });
        if (heatmapResponse.ok) {
          const heatmapResult = await heatmapResponse.json();
          heatmapData = heatmapResult.heatmapData || [];
        }
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
      return names.length > 0 ? names.join(', ') : 'Categories';
    }
    if (campaign.target_type === 'member_group') {
      const names = (campaign.target_ids || [])
        .map(id => memberGroups.find(g => g.id === id)?.name)
        .filter(Boolean);
      return names.length > 0 ? names.join(', ') : 'Groups';
    }
    if (campaign.target_type === 'role') {
      const names = (campaign.target_ids || [])
        .map(id => roles.find(r => r.id === id)?.name)
        .filter(Boolean);
      return names.length > 0 ? names.join(', ') : 'Roles';
    }
    if (campaign.target_type === 'all_members') {
      return 'All Members';
    }
    return 'Unknown';
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const recentCampaigns = campaigns.slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Email Campaigns</h1>
          <p className="text-muted-foreground">
            Create, send, and track email campaigns to engage your members
          </p>
        </div>
        <Button 
          onClick={() => navigate('/EmailCampaignEdit/new')}
          size="lg"
          data-testid="button-create-campaign"
        >
          <Plus className="w-5 h-5 mr-2" />
          Create Campaign
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card data-testid="stat-campaigns-sent">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Campaigns Sent</CardTitle>
            <Send className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.sentCampaigns}</div>
            <p className="text-xs text-muted-foreground">
              {stats.draftCount} drafts, {stats.scheduledCount} scheduled
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-emails-delivered">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Emails Delivered</CardTitle>
            <Mail className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSent.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              Total emails sent to recipients
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-open-rate">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Open Rate</CardTitle>
            <MailOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avgOpenRate}%</div>
            <p className="text-xs text-muted-foreground">
              {stats.totalOpened.toLocaleString()} total opens
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-click-rate">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Click Rate</CardTitle>
            <Link2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avgClickRate}%</div>
            <p className="text-xs text-muted-foreground">
              {stats.totalClicked.toLocaleString()} total clicks
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Recent Campaigns</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Your most recent email campaigns and their performance
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {campaignsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          ) : campaigns.length === 0 ? (
            <div className="text-center py-12 border-2 border-dashed rounded-lg">
              <Mail className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No Campaigns Yet</h3>
              <p className="text-muted-foreground mb-4 max-w-sm mx-auto">
                Create your first email campaign to start engaging with your members
              </p>
              <Button 
                onClick={() => navigate('/EmailCampaignEdit/new')}
                data-testid="button-create-first-campaign"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create First Campaign
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Audience</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Opens</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentCampaigns.map((campaign) => {
                    const openRate = campaign.sent_count > 0 
                      ? ((campaign.opened_count || 0) / campaign.sent_count * 100).toFixed(1)
                      : 0;
                    const clickRate = campaign.sent_count > 0 
                      ? ((campaign.clicked_count || 0) / campaign.sent_count * 100).toFixed(1)
                      : 0;

                    return (
                      <TableRow key={campaign.id} data-testid={`row-campaign-${campaign.id}`}>
                        <TableCell>
                          <div>
                            <div className="font-medium">{campaign.name}</div>
                            <div className="text-sm text-muted-foreground truncate max-w-[200px]">
                              {campaign.subject}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {getStatusBadge(campaign.status)}
                            {campaign.status === 'scheduled' && campaign.scheduled_at && (
                              <span className="text-xs text-muted-foreground">
                                {formatDate(campaign.scheduled_at)}
                              </span>
                            )}
                            {campaign.status === 'sent' && campaign.sent_at && (
                              <span className="text-xs text-muted-foreground">
                                {formatDate(campaign.sent_at)}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Target className="w-3 h-3 text-muted-foreground" />
                            <span className="text-sm truncate max-w-[120px]">
                              {getTargetLabel(campaign)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {campaign.sent_count || '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.status === 'sent' ? (
                            <div>
                              <span className="font-medium">{campaign.opened_count || 0}</span>
                              <span className="text-muted-foreground text-xs ml-1">
                                ({openRate}%)
                              </span>
                            </div>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.status === 'sent' ? (
                            <div>
                              <span className="font-medium">{campaign.clicked_count || 0}</span>
                              <span className="text-muted-foreground text-xs ml-1">
                                ({clickRate}%)
                              </span>
                            </div>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {campaign.status === 'draft' && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => navigate(`/EmailCampaignEdit/${campaign.id}`)}
                                  title="Edit"
                                  data-testid={`button-edit-${campaign.id}`}
                                >
                                  <Pencil className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => {
                                    setTestEmailCampaign(campaign);
                                    setTestEmailAddress('');
                                    setShowTestEmailDialog(true);
                                  }}
                                  disabled={testSending}
                                  title="Send Test"
                                  data-testid={`button-test-${campaign.id}`}
                                >
                                  <TestTube2 className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handlePreviewRecipients(campaign)}
                                  title="Preview & Send"
                                  data-testid={`button-preview-${campaign.id}`}
                                >
                                  <Send className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {campaign.status === 'sent' && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleViewStats(campaign)}
                                title="View Statistics"
                                data-testid={`button-stats-${campaign.id}`}
                              >
                                <BarChart3 className="w-4 h-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setCampaignToDelete(campaign);
                                setShowDeleteConfirm(true);
                              }}
                              title="Delete"
                              className="text-destructive hover:text-destructive"
                              data-testid={`button-delete-${campaign.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

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

      <Dialog open={showPreviewDialog} onOpenChange={(open) => {
        setShowPreviewDialog(open);
        if (!open) {
          setScheduleMode(false);
          setScheduleDateTime('');
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send Campaign</DialogTitle>
            <DialogDescription>
              Review recipients before sending "{previewData?.campaign?.name}"
            </DialogDescription>
          </DialogHeader>
          
          {previewData && (
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-5 h-5 text-blue-600" />
                  <span className="font-semibold text-lg">
                    {previewData.recipientCount} Recipients
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  This campaign will be sent to all eligible members who haven't unsubscribed
                </p>
              </div>

              {previewData.recipients && previewData.recipients.length > 0 && (
                <div className="max-h-48 overflow-y-auto border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewData.recipients.slice(0, 20).map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{r.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{r.email}</TableCell>
                        </TableRow>
                      ))}
                      {previewData.recipients.length > 20 && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                            ... and {previewData.recipients.length - 20} more
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}

              {scheduleMode ? (
                <div className="space-y-3 pt-2 border-t">
                  <Label htmlFor="schedule-datetime">Schedule Date & Time</Label>
                  <Input
                    id="schedule-datetime"
                    type="datetime-local"
                    value={scheduleDateTime}
                    onChange={(e) => setScheduleDateTime(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    data-testid="input-schedule-datetime"
                  />
                </div>
              ) : null}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowPreviewDialog(false)}>
              Cancel
            </Button>
            {!scheduleMode ? (
              <>
                <Button 
                  variant="outline"
                  onClick={() => setScheduleMode(true)}
                  data-testid="button-schedule-mode"
                >
                  <Clock className="w-4 h-4 mr-2" />
                  Schedule
                </Button>
                <Button 
                  onClick={() => handleSendCampaign(previewData?.campaign)}
                  disabled={sending || !previewData?.recipientCount}
                  data-testid="button-confirm-send"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Send Now
                </Button>
              </>
            ) : (
              <>
                <Button 
                  variant="outline"
                  onClick={() => {
                    setScheduleMode(false);
                    setScheduleDateTime('');
                  }}
                >
                  Back
                </Button>
                <Button 
                  onClick={() => handleScheduleCampaign(previewData?.campaign, scheduleDateTime)}
                  disabled={sending || !scheduleDateTime}
                  data-testid="button-confirm-schedule"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Calendar className="w-4 h-4 mr-2" />
                  )}
                  Schedule Campaign
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showStatsDialog} onOpenChange={setShowStatsDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Campaign Statistics</DialogTitle>
            <DialogDescription>
              Performance metrics for "{statsData?.name}"
            </DialogDescription>
          </DialogHeader>
          
          {statsData && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
                  <Send className="w-5 h-5 mx-auto mb-1 text-blue-600" />
                  <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                    {statsData.sent_count || 0}
                  </div>
                  <div className="text-xs text-blue-600">Sent</div>
                </div>
                <div className="text-center p-4 bg-green-50 dark:bg-green-950 rounded-lg">
                  <CheckCircle2 className="w-5 h-5 mx-auto mb-1 text-green-600" />
                  <div className="text-2xl font-bold text-green-700 dark:text-green-300">
                    {statsData.delivered_count || 0}
                  </div>
                  <div className="text-xs text-green-600">Delivered</div>
                </div>
                <div className="text-center p-4 bg-purple-50 dark:bg-purple-950 rounded-lg">
                  <Eye className="w-5 h-5 mx-auto mb-1 text-purple-600" />
                  <div className="text-2xl font-bold text-purple-700 dark:text-purple-300">
                    {statsData.opened_count || 0}
                  </div>
                  <div className="text-xs text-purple-600">Opened</div>
                </div>
                <div className="text-center p-4 bg-amber-50 dark:bg-amber-950 rounded-lg">
                  <MousePointerClick className="w-5 h-5 mx-auto mb-1 text-amber-600" />
                  <div className="text-2xl font-bold text-amber-700 dark:text-amber-300">
                    {statsData.clicked_count || 0}
                  </div>
                  <div className="text-xs text-amber-600">Clicked</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="text-center p-3 border rounded-lg">
                  <div className="text-lg font-semibold text-red-600">
                    {statsData.bounced_count || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Bounced</div>
                </div>
                <div className="text-center p-3 border rounded-lg">
                  <div className="text-lg font-semibold text-orange-600">
                    {statsData.unsubscribed_count || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Unsubscribed</div>
                </div>
                <div className="text-center p-3 border rounded-lg">
                  <div className="text-lg font-semibold text-rose-600">
                    {statsData.complained_count || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Complaints</div>
                </div>
              </div>

              {statsData.heatmapData && statsData.heatmapData.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-3 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    Link Click Heatmap
                  </h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {statsData.heatmapData.map((link, i) => {
                      const maxClicks = Math.max(...statsData.heatmapData.map(l => l.clicks));
                      const intensity = maxClicks > 0 ? (link.clicks / maxClicks) * 100 : 0;
                      
                      return (
                        <div key={i} className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div 
                              className="h-8 rounded flex items-center px-3 text-sm truncate"
                              style={{
                                background: `linear-gradient(90deg, rgba(59, 130, 246, ${0.1 + intensity * 0.005}) ${intensity}%, transparent ${intensity}%)`,
                                border: '1px solid rgba(59, 130, 246, 0.2)'
                              }}
                            >
                              <a 
                                href={link.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline truncate"
                              >
                                {link.url}
                              </a>
                            </div>
                          </div>
                          <div className="text-sm font-medium w-16 text-right">
                            {link.clicks} clicks
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

      <Dialog open={showTestEmailDialog} onOpenChange={(open) => {
        setShowTestEmailDialog(open);
        if (!open) {
          setTestEmailAddress('');
          setTestEmailCampaign(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Test Email</DialogTitle>
            <DialogDescription>
              Send a test email for "{testEmailCampaign?.name}" to preview how it will look
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="test-email">Email Address</Label>
              <Input
                id="test-email"
                type="email"
                value={testEmailAddress}
                onChange={(e) => setTestEmailAddress(e.target.value)}
                placeholder="your@email.com"
                data-testid="input-test-email"
              />
              <p className="text-xs text-muted-foreground">
                The test email will be sent to this address
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setShowTestEmailDialog(false)}
              data-testid="button-cancel-test-send"
            >
              Cancel
            </Button>
            <Button 
              onClick={() => {
                if (testEmailAddress && testEmailCampaign) {
                  handleTestSend(testEmailCampaign, testEmailAddress);
                  setShowTestEmailDialog(false);
                }
              }}
              disabled={!testEmailAddress || testSending}
              data-testid="button-confirm-test-send"
            >
              {testSending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <TestTube2 className="w-4 h-4 mr-2" />
              )}
              Send Test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
