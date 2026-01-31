import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  Mail, Plus, Pencil, Trash2, Send, Eye, BarChart3, 
  Loader2, Calendar, Clock, Users, MousePointerClick,
  CheckCircle2, XCircle, AlertTriangle, TrendingUp, TestTube2
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

  const { data: campaigns = [], isLoading: campaignsLoading } = useQuery({
    queryKey: ['email-campaigns'],
    queryFn: async () => {
      const response = await fetch('/api/email-campaigns', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch campaigns');
      return response.json();
    },
    staleTime: 30000
  });

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
      // Convert local datetime string to ISO UTC format
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

      const result = await response.json();
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

  const handleCancelSchedule = async (campaign) => {
    try {
      const response = await fetch(`/api/email-campaigns/${campaign.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'draft', scheduled_at: null })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to cancel schedule');
      }

      toast.success('Schedule cancelled - campaign returned to draft');
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
    } catch (error) {
      toast.error(error.message);
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
          onClick={() => navigate('/EmailCampaignEdit/new')}
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
            onClick={() => navigate('/EmailCampaignEdit/new')}
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
                      {campaign.scheduled_at && campaign.status === 'scheduled' && (
                        <span className="flex items-center gap-1 text-blue-600">
                          <Clock className="w-4 h-4" />
                          Scheduled: {new Date(campaign.scheduled_at).toLocaleString()}
                        </span>
                      )}
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
                          onClick={() => {
                            const testEmail = prompt('Enter test email address:');
                            if (testEmail) {
                              handleTestSend(campaign, testEmail);
                            }
                          }}
                          disabled={testSending}
                          data-testid={`button-test-send-${campaign.id}`}
                        >
                          {testSending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <>
                              <TestTube2 className="w-4 h-4 mr-1" />
                              Send Test
                            </>
                          )}
                        </Button>
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
                          onClick={() => navigate(`/EmailCampaignEdit/${campaign.id}`)}
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
                    {campaign.status === 'scheduled' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCancelSchedule(campaign)}
                        data-testid={`button-cancel-schedule-${campaign.id}`}
                      >
                        <XCircle className="w-4 h-4 mr-1 text-orange-500" />
                        Cancel Schedule
                      </Button>
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
            <DialogTitle>{scheduleMode ? 'Schedule Campaign' : 'Send Campaign'}</DialogTitle>
            <DialogDescription>
              {scheduleMode 
                ? `Schedule "${previewData?.campaign?.name}" for later delivery`
                : `Review recipients before sending "${previewData?.campaign?.name}"`
              }
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
              
              {scheduleMode && (
                <div className="space-y-3 mb-4">
                  <Label htmlFor="schedule-datetime" className="flex items-center gap-2">
                    <Calendar className="w-4 h-4" />
                    Schedule Date & Time
                  </Label>
                  <Input
                    id="schedule-datetime"
                    type="datetime-local"
                    value={scheduleDateTime}
                    onChange={(e) => setScheduleDateTime(e.target.value)}
                    min={(() => {
                      const now = new Date();
                      const offset = now.getTimezoneOffset();
                      const local = new Date(now.getTime() - offset * 60000);
                      return local.toISOString().slice(0, 16);
                    })()}
                    data-testid="input-schedule-datetime"
                  />
                  <p className="text-xs text-muted-foreground">
                    Campaign will be sent at the scheduled time. Scheduling uses your local timezone.
                  </p>
                </div>
              )}
              
              {!scheduleMode && previewData.sampleRecipients?.length > 0 && (
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

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => {
              if (scheduleMode) {
                setScheduleMode(false);
                setScheduleDateTime('');
              } else {
                setShowPreviewDialog(false);
              }
            }}>
              {scheduleMode ? 'Back' : 'Cancel'}
            </Button>
            
            {!scheduleMode && (
              <Button 
                variant="outline"
                onClick={() => setScheduleMode(true)}
                disabled={sending || previewData?.recipientCount === 0}
                data-testid="button-schedule-mode"
              >
                <Clock className="w-4 h-4 mr-2" />
                Schedule
              </Button>
            )}
            
            {scheduleMode ? (
              <Button 
                onClick={() => handleScheduleCampaign(previewData?.campaign, scheduleDateTime)}
                disabled={sending || !scheduleDateTime || previewData?.recipientCount === 0}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-confirm-schedule"
              >
                {sending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Scheduling...
                  </>
                ) : (
                  <>
                    <Calendar className="w-4 h-4 mr-2" />
                    Schedule Send
                  </>
                )}
              </Button>
            ) : (
              <Button 
                onClick={() => handleSendCampaign(previewData?.campaign)}
                disabled={sending || previewData?.recipientCount === 0}
                className="bg-green-600 hover:bg-green-700"
                data-testid="button-send-now"
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
            )}
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
