import { useState, useEffect, lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  Mail, ArrowLeft, Save, Send, Eye, Users, Code, 
  Loader2, TestTube2, Clock, Calendar, Search, AlertTriangle, Wand2, X, Check,
  Monitor, Smartphone, Reply, Forward, Trash2, Archive, MoreHorizontal, Star, Paperclip,
  Plus, Download, ChevronLeft, ChevronRight
} from "lucide-react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { designToHtml } from '@/components/email-builder/mjmlConverter';
import { ReadOnlyBlockPreview } from '@/components/email-builder/BlockRenderer';
import { defaultEmailDesign } from '@/components/email-builder/types';

const EmailBuilder = lazy(() => import('@/components/email-builder/EmailBuilder').then(m => ({ default: m.default })));

export default function EmailCampaignEdit() {
  const navigate = useNavigate();
  const { id } = useParams();
  const queryClient = useQueryClient();
  const isEditing = id && id !== 'new';

  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showSendConfirmDialog, setShowSendConfirmDialog] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [editorTab, setEditorTab] = useState('html');
  const [showVisualEditor, setShowVisualEditor] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewMode, setPreviewMode] = useState('desktop');
  const [recipientPreviewCount, setRecipientPreviewCount] = useState(null);
  const [recipientStats, setRecipientStats] = useState(null);
  const [loadingRecipientCount, setLoadingRecipientCount] = useState(false);
  const [showTestEmailDialog, setShowTestEmailDialog] = useState(false);
  const [testEmailAddress, setTestEmailAddress] = useState('');
  const [scheduleMode, setScheduleMode] = useState('immediate');
  const [testEmailMode, setTestEmailMode] = useState('manual');
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [memberSearchResults, setMemberSearchResults] = useState([]);
  const [searchingMembers, setSearchingMembers] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);

  const [showRecipientListDialog, setShowRecipientListDialog] = useState(false);
  const [recipientList, setRecipientList] = useState([]);
  const [loadingRecipientList, setLoadingRecipientList] = useState(false);
  const [serverRecipientCount, setServerRecipientCount] = useState(null);
  const [loadingServerCount, setLoadingServerCount] = useState(false);
  const [recipientCountMismatch, setRecipientCountMismatch] = useState(false);
  const [recipientPage, setRecipientPage] = useState(1);
  const RECIPIENTS_PER_PAGE = 50;

  const [selectedListIds, setSelectedListIds] = useState([]);

  const [formData, setFormData] = useState({
    name: '',
    subject: '',
    from_name: '',
    from_email: '',
    reply_to: '',
    email_template_id: '',
    html_content: '',
    design_json: null,
    target_audiences: [],
    communication_category_id: '',
    scheduled_at: '',
    is_test_mode: false
  });
  const [editorMode, setEditorMode] = useState('visual');

  const { data: campaign, isLoading: campaignLoading } = useQuery({
    queryKey: ['email-campaign', id],
    queryFn: async () => {
      if (!isEditing) return null;
      const response = await fetch(`/api/email-campaigns/${id}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch campaign');
      return response.json();
    },
    enabled: isEditing,
    staleTime: 30000
  });

  useEffect(() => {
    if (campaign) {
      let parsedDesign = campaign.design_json;
      if (typeof parsedDesign === 'string') {
        try {
          parsedDesign = JSON.parse(parsedDesign);
        } catch (e) {
          parsedDesign = null;
        }
      }
      const hasDesign = parsedDesign && typeof parsedDesign === 'object' && 
        (parsedDesign.type === 'custom-email-builder' || Array.isArray(parsedDesign.blocks));
      if (hasDesign) {
        parsedDesign = {
          ...parsedDesign,
          globalStyles: {
            ...defaultEmailDesign.globalStyles,
            ...(parsedDesign.globalStyles || {}),
          },
        };
      }
      setEditorMode(hasDesign ? 'visual' : (campaign.html_content ? 'html' : 'visual'));
      let audiences = campaign.target_audiences;
      if (!Array.isArray(audiences) || audiences.length === 0) {
        if (campaign.target_type) {
          audiences = [{ type: campaign.target_type, ids: campaign.target_ids || [] }];
        } else {
          audiences = [];
        }
      }
      const listAudience = audiences.find(a => a.type === 'audience_list');
      if (listAudience && listAudience.ids) {
        setSelectedListIds(listAudience.ids);
      }
      setFormData({
        name: campaign.name || '',
        subject: campaign.subject || '',
        from_name: campaign.from_name || '',
        from_email: campaign.from_email || '',
        reply_to: campaign.reply_to || '',
        email_template_id: campaign.email_template_id || '',
        html_content: campaign.html_content || '',
        design_json: parsedDesign || null,
        target_audiences: audiences,
        communication_category_id: campaign.communication_category_id || '',
        scheduled_at: campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString().slice(0, 16) : '',
        is_test_mode: campaign.is_test_mode || false
      });
      setScheduleMode(campaign.scheduled_at ? 'scheduled' : 'immediate');
    }
  }, [campaign]);

  const { data: footerData, isLoading: footerLoading, error: footerError } = useQuery({
    queryKey: ['email-footer-preview'],
    queryFn: async () => {
      const response = await fetch('/api/email-campaigns/preview-footer', { credentials: 'include' });
      if (!response.ok) {
        console.error('[Footer Preview] Response not ok:', response.status);
        return { footer: null, hasFooter: false, error: true };
      }
      return response.json();
    },
    staleTime: 60000
  });

  const { data: emailTemplates = [] } = useQuery({
    queryKey: ['email-templates'],
    queryFn: async () => {
      try {
        return await base44.entities.EmailTemplate.list({ filter: { is_active: true } });
      } catch (e) {
        return [];
      }
    },
    staleTime: 60000
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['communication-categories'],
    queryFn: async () => {
      try {
        return await base44.entities.CommunicationCategory.list();
      } catch (e) {
        return [];
      }
    },
    staleTime: 60000
  });


  const { data: audienceLists = [] } = useQuery({
    queryKey: ['audience-lists'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/audience-lists', { credentials: 'include' });
        if (!response.ok) return [];
        return response.json();
      } catch (e) {
        return [];
      }
    },
    staleTime: 60000
  });

  useEffect(() => {
    if (selectedListIds.length > 0) {
      setFormData(prev => ({
        ...prev,
        target_audiences: [{ type: 'audience_list', ids: selectedListIds }]
      }));
    }
  }, [selectedListIds]);

  useEffect(() => {
    const fetchRecipientCount = async () => {
      if (selectedListIds.length === 0) {
        setRecipientPreviewCount(null);
        setRecipientStats(null);
        return;
      }

      const audiences = [{ type: 'audience_list', ids: selectedListIds }];

      setLoadingRecipientCount(true);
      try {
        const response = await fetch('/api/email-campaigns/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ 
            campaignId: 'preview',
            preview: true,
            targetAudiences: audiences,
            communicationCategoryId: formData.communication_category_id || null
          })
        });
        if (response.ok) {
          const data = await response.json();
          setRecipientPreviewCount(data.recipientCount);
          setRecipientStats(data.stats || null);
        }
      } catch (e) {
        console.error('Failed to fetch recipient count:', e);
      } finally {
        setLoadingRecipientCount(false);
      }
    };

    const debounceTimer = setTimeout(fetchRecipientCount, 300);
    return () => clearTimeout(debounceTimer);
  }, [selectedListIds, formData.communication_category_id]);

  // Member search for test emails with debouncing
  useEffect(() => {
    if (!memberSearchQuery || memberSearchQuery.length < 2) {
      setMemberSearchResults([]);
      return;
    }

    const searchController = new AbortController();
    const debounceTimer = setTimeout(async () => {
      setSearchingMembers(true);
      try {
        // Use API endpoint for server-side search
        const response = await fetch(`/api/members/search?q=${encodeURIComponent(memberSearchQuery)}&limit=10`, {
          credentials: 'include',
          signal: searchController.signal
        });
        
        if (response.ok) {
          const results = await response.json();
          setMemberSearchResults(results);
        } else {
          // Fallback to base44 if search endpoint doesn't exist
          const members = await base44.entities.Member.list({ limit: 100 });
          const queryLower = memberSearchQuery.toLowerCase();
          const filtered = members.filter(m => 
            (m.first_name && m.first_name.toLowerCase().includes(queryLower)) ||
            (m.last_name && m.last_name.toLowerCase().includes(queryLower)) ||
            (m.email && m.email.toLowerCase().includes(queryLower))
          ).slice(0, 10);
          setMemberSearchResults(filtered);
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('Failed to search members:', e);
          setMemberSearchResults([]);
        }
      } finally {
        setSearchingMembers(false);
      }
    }, 300);

    return () => {
      clearTimeout(debounceTimer);
      searchController.abort();
    };
  }, [memberSearchQuery]);

  const handleMemberSearchInput = (query) => {
    setMemberSearchQuery(query);
    setSelectedMember(null);
  };

  const handleSelectMember = (member) => {
    setSelectedMember(member);
    setTestEmailAddress(member.email);
    setMemberSearchQuery(`${member.first_name || ''} ${member.last_name || ''} <${member.email}>`);
    setMemberSearchResults([]);
  };

  const handleTemplateSelect = async (templateId) => {
    const actualId = templateId === 'none' ? null : templateId;
    setFormData(prev => ({ ...prev, email_template_id: actualId }));
    
    if (actualId) {
      const template = emailTemplates.find(t => t.id === actualId);
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

    setSaving(true);
    try {
      if (selectedListIds.length === 0) {
        toast.error('Please select at least one audience list before saving');
        setSaving(false);
        return;
      }
      let saveData = { ...formData };
      saveData.target_audiences = [{ type: 'audience_list', ids: selectedListIds }];
      saveData.target_type = 'audience_list';
      saveData.target_ids = selectedListIds;
      if (saveData.communication_category_id === '') {
        saveData.communication_category_id = null;
      }
      if (saveData.email_template_id === '' || saveData.email_template_id === 'none') {
        saveData.email_template_id = null;
      }
      if (saveData.design_json && typeof saveData.design_json === 'object' && saveData.design_json.blocks) {
        try {
          const fHtml = footerData?.hasFooter ? footerData.footer : null;
          const freshHtml = designToHtml(saveData.design_json, { footerHtml: fHtml });
          if (freshHtml) {
            saveData.html_content = freshHtml;
          }
        } catch (e) {
          console.warn('[Save] Failed to regenerate HTML from design, using existing html_content');
        }
      }

      const url = isEditing 
        ? `/api/email-campaigns/${id}`
        : '/api/email-campaigns';
      
      const response = await fetch(url, {
        method: isEditing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(saveData)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save campaign');
      }

      const result = await response.json();
      toast.success(isEditing ? 'Campaign updated' : 'Campaign created');
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      if (isEditing) {
        queryClient.invalidateQueries({ queryKey: ['email-campaign', id] });
      }
      
      if (!isEditing && result.id) {
        navigate(`/EmailCampaignEdit/${result.id}`, { replace: true });
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTestSend = async (testEmail) => {
    if (!isEditing) {
      toast.error('Please save the campaign first before sending a test');
      return;
    }

    if (!formData.subject || !formData.html_content) {
      toast.error('Subject and content are required for test send');
      return;
    }

    setTestSending(true);
    try {
      const response = await fetch('/api/email-campaigns/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          campaignId: id,
          testEmail
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to send test email');
      }

      toast.success(`Test email sent to ${result.sentTo}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTestSending(false);
    }
  };

  const handleOpenSendConfirm = async () => {
    if (!isEditing || !id) return;
    setShowSendConfirmDialog(true);
    setLoadingServerCount(true);
    setServerRecipientCount(null);
    setRecipientCountMismatch(false);
    try {
      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: id, preview: true })
      });
      if (response.ok) {
        const data = await response.json();
        setServerRecipientCount(data.recipientCount);
        if (recipientPreviewCount !== null && data.recipientCount !== recipientPreviewCount) {
          setRecipientCountMismatch(true);
        }
      }
    } catch (e) {
      console.error('Failed to fetch server-side recipient count:', e);
    } finally {
      setLoadingServerCount(false);
    }
  };

  const handleSendCampaign = async () => {
    if (!isEditing) {
      toast.error('Please save the campaign first');
      return;
    }

    setSending(true);
    setShowSendConfirmDialog(false);
    try {
      const payload = { campaignId: id };

      if (scheduleMode === 'scheduled' && formData.scheduled_at) {
        payload.scheduledAt = new Date(formData.scheduled_at).toISOString();
      }

      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to send campaign');
      }

      if (scheduleMode === 'scheduled') {
        toast.success('Campaign scheduled successfully');
      } else if (result.status === 'sending') {
        toast.success(`Campaign sending started — ${result.sent} of ${result.totalRecipients} sent so far. The rest will be sent automatically.`);
      } else {
        toast.success(`Campaign sent to ${result.sent || result.sentCount || recipientPreviewCount || 0} recipients`);
      }

      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['email-campaign', id] });
      navigate('/CommunicationsManagement');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  };

  const hasAudienceSelected = selectedListIds.length > 0;
  const canSendCampaign = isEditing && 
    formData.subject && 
    formData.html_content && 
    hasAudienceSelected &&
    (scheduleMode === 'immediate' || formData.scheduled_at);

  if (isEditing && campaignLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button 
            variant="ghost" 
            size="icon"
            onClick={() => navigate('/CommunicationsManagement')}
            data-testid="button-back"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">
              {isEditing ? 'Edit Campaign' : 'Create Campaign'}
            </h1>
            <p className="text-muted-foreground">
              Configure your email campaign settings and content
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (!isEditing) {
                toast.error('Please save the campaign first before sending a test');
                return;
              }
              setTestEmailAddress('');
              setShowTestEmailDialog(true);
            }}
            disabled={testSending || !formData.subject || !formData.html_content}
            data-testid="button-test-send"
          >
            {testSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <TestTube2 className="w-4 h-4 mr-2" />
                Send Test
              </>
            )}
          </Button>
          <Button
            onClick={handleSaveCampaign}
            disabled={saving}
            data-testid="button-save-campaign"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                {isEditing ? 'Update' : 'Save'} Campaign
              </>
            )}
          </Button>
          {isEditing && (
            <Button
              onClick={handleOpenSendConfirm}
              disabled={!canSendCampaign || sending}
              className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
              data-testid="button-send-campaign"
            >
              {sending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  {scheduleMode === 'scheduled' ? 'Schedule' : 'Send'} Campaign
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Mail className="w-5 h-5 text-blue-600" />
              Campaign Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Send className="w-5 h-5 text-blue-600" />
              Sender Information
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
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
              <div className="space-y-2">
                <Label htmlFor="reply_to">Reply-To Email</Label>
                <Input
                  id="reply_to"
                  type="email"
                  value={formData.reply_to}
                  onChange={(e) => setFormData(prev => ({ ...prev, reply_to: e.target.value }))}
                  placeholder="e.g., support@company.com"
                  data-testid="input-reply-to"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className="w-5 h-5 text-blue-600" />
              Target Audience
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Select Lists</Label>
              <p className="text-xs text-muted-foreground">
                Choose one or more lists to send this campaign to. Lists are managed in Communications.
              </p>
              {audienceLists.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center border rounded-md">
                  No lists found. Create lists in Communications first.
                </div>
              ) : (
                <div className="border rounded-md p-3 max-h-48 overflow-y-auto space-y-2 bg-background">
                  {audienceLists.map(list => (
                    <label key={list.id} className="flex items-center gap-2 cursor-pointer" data-testid={`list-option-${list.id}`}>
                      <input
                        type="checkbox"
                        checked={selectedListIds.includes(list.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedListIds(prev => [...prev, list.id]);
                          } else {
                            setSelectedListIds(prev => prev.filter(i => i !== list.id));
                          }
                        }}
                        className="rounded"
                      />
                      <span className="text-sm font-medium">{list.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Subscription Category</Label>
              <p className="text-xs text-muted-foreground">
                The selected lists will be filtered through this category: members who have opted out of this category or all communications will be excluded.
              </p>
              <Select
                value={formData.communication_category_id || '__none__'}
                onValueChange={(value) => {
                  setFormData(prev => ({
                    ...prev,
                    communication_category_id: value === '__none__' ? '' : value
                  }));
                }}
              >
                <SelectTrigger data-testid="select-campaign-category">
                  <SelectValue placeholder="Select a subscription category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No category filter</SelectItem>
                  {categories.filter(c => c.is_active !== false).map(cat => (
                    <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {hasAudienceSelected && (
              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    {loadingRecipientCount ? (
                      <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Calculating recipients...</span>
                      </div>
                    ) : recipientPreviewCount !== null && recipientStats ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                          <Mail className="w-4 h-4 flex-shrink-0" />
                          <span className="font-medium">
                            {recipientStats.finalCount} {recipientStats.finalCount === 1 ? 'recipient' : 'recipients'} will receive this email
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground ml-6 space-y-0.5">
                          <div data-testid="text-audience-total">Audience total: {recipientStats.totalAudience}</div>
                          <div data-testid="text-global-optouts" className={recipientStats.globalOptOuts > 0 ? 'text-orange-600 dark:text-orange-400' : ''}>
                            Globally opted out: -{recipientStats.globalOptOuts}
                          </div>
                          {formData.communication_category_id && (
                            <div data-testid="text-category-optouts" className={recipientStats.categoryOptOuts > 0 ? 'text-orange-600 dark:text-orange-400' : ''}>
                              Category opted out: -{recipientStats.categoryOptOuts}
                            </div>
                          )}
                          {recipientStats.duplicatesRemoved > 0 && (
                            <div data-testid="text-duplicates-removed">
                              Duplicates removed: -{recipientStats.duplicatesRemoved}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : recipientPreviewCount !== null ? (
                      <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                        <Mail className="w-4 h-4" />
                        <span className="font-medium">
                          {recipientPreviewCount} {recipientPreviewCount === 1 ? 'recipient' : 'recipients'} will receive this email
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                        <Mail className="w-4 h-4" />
                        <span>Calculating...</span>
                      </div>
                    )}
                  </div>
                  {recipientPreviewCount !== null && recipientPreviewCount > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        setLoadingRecipientList(true);
                        setShowRecipientListDialog(true);
                        setRecipientPage(1);
                        try {
                          const response = await fetch('/api/email-campaigns/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({
                              campaignId: 'preview',
                              preview: true,
                              previewList: true,
                              targetAudiences: [{ type: 'audience_list', ids: selectedListIds }],
                              communicationCategoryId: formData.communication_category_id || null
                            })
                          });
                          if (response.ok) {
                            const data = await response.json();
                            setRecipientList(data.recipients || []);
                          }
                        } catch (e) {
                          console.error('Failed to fetch recipient list:', e);
                          toast.error('Failed to load recipient list');
                        } finally {
                          setLoadingRecipientList(false);
                        }
                      }}
                      data-testid="button-view-recipients"
                    >
                      <Users className="w-4 h-4 mr-1" />
                      View Recipients
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock className="w-5 h-5 text-blue-600" />
              Scheduling
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border hover-elevate">
                <input
                  type="radio"
                  name="scheduleMode"
                  value="immediate"
                  checked={scheduleMode === 'immediate'}
                  onChange={() => {
                    setScheduleMode('immediate');
                    setFormData(prev => ({ ...prev, scheduled_at: '' }));
                  }}
                  className="w-4 h-4"
                  data-testid="radio-send-immediate"
                />
                <div>
                  <div className="font-medium">Send immediately</div>
                  <div className="text-sm text-muted-foreground">
                    Campaign will be sent as soon as you click the Send button
                  </div>
                </div>
              </label>
              
              <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border hover-elevate">
                <input
                  type="radio"
                  name="scheduleMode"
                  value="scheduled"
                  checked={scheduleMode === 'scheduled'}
                  onChange={() => setScheduleMode('scheduled')}
                  className="w-4 h-4"
                  data-testid="radio-send-scheduled"
                />
                <div className="flex-1">
                  <div className="font-medium">Schedule for later</div>
                  <div className="text-sm text-muted-foreground">
                    Choose a specific date and time to send the campaign
                  </div>
                </div>
              </label>
            </div>

            {scheduleMode === 'scheduled' && (
              <div className="pl-7 space-y-2">
                <Label htmlFor="scheduled_at">Send Date & Time</Label>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                  <Input
                    id="scheduled_at"
                    type="datetime-local"
                    value={formData.scheduled_at}
                    onChange={(e) => setFormData(prev => ({ ...prev, scheduled_at: e.target.value }))}
                    min={new Date().toISOString().slice(0, 16)}
                    className="max-w-xs"
                    data-testid="input-scheduled-at"
                  />
                </div>
                {formData.scheduled_at && (
                  <p className="text-sm text-muted-foreground">
                    Scheduled for: {new Date(formData.scheduled_at).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <TestTube2 className="w-5 h-5 text-blue-600" />
              Test Mode
            </CardTitle>
          </CardHeader>
          <CardContent>
            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border hover-elevate">
              <input
                type="checkbox"
                checked={formData.is_test_mode}
                onChange={(e) => setFormData(prev => ({ ...prev, is_test_mode: e.target.checked }))}
                className="w-4 h-4 mt-0.5"
                data-testid="checkbox-test-mode"
              />
              <div>
                <div className="font-medium">Enable test mode</div>
                <div className="text-sm text-muted-foreground">
                  When enabled, the full sending pipeline runs (recipients queued, batches processed, statuses updated) but Mailgun will not deliver the emails. Use this to safely validate campaign setup and audience targeting.
                </div>
              </div>
            </label>
            {formData.is_test_mode && (
              <Alert className="mt-3">
                <TestTube2 className="h-4 w-4" />
                <AlertDescription>
                  Test mode is active. No emails will be delivered to recipients when this campaign is sent.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Code className="w-5 h-5 text-blue-600" />
              Email Content
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="template">Email Template (Optional)</Label>
              <Select
                value={formData.email_template_id || 'none'}
                onValueChange={handleTemplateSelect}
              >
                <SelectTrigger data-testid="select-template">
                  <SelectValue placeholder="Select a template (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No template</SelectItem>
                  {emailTemplates.map(template => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-4 pb-2 border-b">
                <Label className="text-sm font-medium">Editor Mode:</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={editorMode === 'visual' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setEditorMode('visual')}
                    className="flex items-center gap-2"
                    data-testid="button-visual-mode"
                  >
                    <Wand2 className="w-4 h-4" />
                    Visual Builder
                  </Button>
                  <Button
                    type="button"
                    variant={editorMode === 'html' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      if (editorMode === 'visual' && formData.design_json) {
                        toast.info('Switching to HTML mode. You can edit HTML directly, but switching back will lose visual editor changes.');
                      }
                      setEditorMode('html');
                    }}
                    className="flex items-center gap-2"
                    data-testid="button-html-mode"
                  >
                    <Code className="w-4 h-4" />
                    HTML Code
                  </Button>
                </div>
              </div>

              {editorMode === 'visual' && (
                <div className="space-y-4">
                  <div className="border rounded-md p-6 bg-muted/10 text-center space-y-4">
                    <div className="flex flex-col items-center gap-2">
                      <Wand2 className="w-12 h-12 text-primary/60" />
                      <h3 className="text-lg font-medium">Visual Email Builder</h3>
                      <p className="text-sm text-muted-foreground max-w-md">
                        Design your email with drag-and-drop blocks including text, images, buttons, columns, and more.
                      </p>
                    </div>
                    
                    {formData.design_json && (
                      <p className="text-sm text-green-600 flex items-center justify-center gap-1">
                        <Check className="w-4 h-4" />
                        Design saved
                      </p>
                    )}
                    
                    <Button
                      type="button"
                      onClick={() => setShowVisualEditor(true)}
                      className="gap-2"
                      data-testid="button-open-visual-editor"
                    >
                      <Wand2 className="w-4 h-4" />
                      {formData.design_json ? 'Edit Design' : 'Open Visual Builder'}
                    </Button>
                  </div>
                  
                  {(formData.design_json || formData.html_content) && (
                    <div className="space-y-2">
                      <Label className="text-sm">Preview</Label>
                      <div 
                        className="border rounded-md overflow-hidden bg-white"
                        data-testid="visual-preview"
                      >
                        {(() => {
                          try {
                            const fHtml = footerData?.hasFooter ? footerData.footer : null;
                            const html = formData.design_json 
                              ? designToHtml(formData.design_json, { footerHtml: fHtml }) 
                              : formData.html_content;
                            if (!html) return null;
                            return (
                              <iframe
                                srcDoc={html}
                                title="Email Preview"
                                className="w-full border-0"
                                style={{ minHeight: '300px' }}
                                sandbox="allow-same-origin"
                                data-testid="iframe-visual-preview"
                              />
                            );
                          } catch {
                            return (
                              <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
                                Unable to generate preview.
                              </div>
                            );
                          }
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {editorMode === 'html' && (
                <div className="space-y-2">
                  {formData.design_json && (
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        This campaign has visual editor data saved. Changes you make here to the HTML will be used when sending, 
                        but switching back to Visual Builder will restore your visual design (not the HTML edits you make here).
                      </AlertDescription>
                    </Alert>
                  )}
                  
                  <Tabs value={editorTab} onValueChange={setEditorTab} className="w-full">
                    <TabsList className="w-full grid grid-cols-2">
                      <TabsTrigger value="html" className="flex items-center gap-2">
                        <Code className="w-4 h-4" />
                        HTML
                      </TabsTrigger>
                      <TabsTrigger value="preview" className="flex items-center gap-2">
                        <Eye className="w-4 h-4" />
                        Preview
                      </TabsTrigger>
                    </TabsList>
                    
                    <TabsContent value="html" className="mt-3">
                      <textarea
                        value={formData.html_content}
                        onChange={(e) => setFormData(prev => ({ ...prev, html_content: e.target.value }))}
                        placeholder="Enter raw HTML content..."
                        className="w-full min-h-[500px] p-4 font-mono text-sm border rounded-md bg-muted/30 focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                        spellCheck={false}
                        data-testid="textarea-html-content"
                      />
                      <p className="text-xs text-muted-foreground mt-2">
                        Available placeholders: {'{{first_name}}'}, {'{{last_name}}'}, {'{{email}}'}, {'{{unsubscribe_link}}'}
                      </p>
                    </TabsContent>
                    
                    <TabsContent value="preview" className="mt-3">
                      <div 
                        className="border rounded-md p-4 min-h-[500px] bg-white prose prose-sm max-w-none"
                        data-testid="preview-html-content"
                      >
                        <div dangerouslySetInnerHTML={{ __html: formData.html_content || '<p class="text-muted-foreground italic">No content yet. Enter HTML in the HTML tab.</p>' }} />
                        {footerData?.footer && (
                          <>
                            <hr className="my-4 border-gray-200" />
                            <div 
                              className="text-xs text-gray-500"
                              dangerouslySetInnerHTML={{ __html: footerData.footer }}
                            />
                          </>
                        )}
                        {footerLoading && formData.html_content && (
                          <p className="text-xs text-muted-foreground italic mt-4 border-t pt-2">
                            Loading email footer...
                          </p>
                        )}
                        {!footerLoading && !footerData?.footer && formData.html_content && (
                          <p className="text-xs text-muted-foreground italic mt-4 border-t pt-2">
                            {footerData?.error 
                              ? 'Unable to load email footer preview.'
                              : 'Email footer will be added when the campaign is sent.'}
                          </p>
                        )}
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showSendConfirmDialog} onOpenChange={setShowSendConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {scheduleMode === 'scheduled' ? 'Schedule Campaign' : 'Send Campaign'}
            </DialogTitle>
            <DialogDescription>
              {scheduleMode === 'scheduled' 
                ? `This campaign will be scheduled to send on ${formData.scheduled_at ? new Date(formData.scheduled_at).toLocaleString() : 'the selected date'}.`
                : 'This campaign will be sent immediately and cannot be undone.'
              }
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Subject</span>
              <span className="font-medium truncate max-w-[250px]">{formData.subject}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Recipients (saved campaign)</span>
              <span className="font-medium">
                {loadingServerCount ? (
                  <Loader2 className="w-4 h-4 animate-spin inline" />
                ) : serverRecipientCount !== null ? (
                  `${serverRecipientCount} recipient${serverRecipientCount === 1 ? '' : 's'}`
                ) : (
                  'Calculating...'
                )}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">From</span>
              <span className="font-medium">{formData.from_name || 'Not set'} &lt;{formData.from_email || 'Not set'}&gt;</span>
            </div>
            {scheduleMode === 'scheduled' && formData.scheduled_at && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Scheduled for</span>
                <span className="font-medium">{new Date(formData.scheduled_at).toLocaleString()}</span>
              </div>
            )}
          </div>
          {campaign?.is_test_mode && (
            <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950">
              <TestTube2 className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-800 dark:text-blue-200">
                <strong>Test Mode</strong> — No emails will be delivered. The full pipeline will run but Mailgun will not send any messages.
              </AlertDescription>
            </Alert>
          )}
          {formData.is_test_mode !== (campaign?.is_test_mode || false) && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Test mode setting has unsaved changes. The saved campaign has test mode <strong>{campaign?.is_test_mode ? 'enabled' : 'disabled'}</strong>, but your current form has it <strong>{formData.is_test_mode ? 'enabled' : 'disabled'}</strong>. Please save your changes first.
              </AlertDescription>
            </Alert>
          )}
          {recipientCountMismatch && serverRecipientCount !== null && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Recipient count mismatch detected. The saved campaign will send to <strong>{serverRecipientCount}</strong> recipients,
                but your current form shows {recipientPreviewCount}. Please save your changes first before sending.
              </AlertDescription>
            </Alert>
          )}
          {!loadingServerCount && serverRecipientCount === 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                No recipients found for the saved campaign targeting. Please check your audience list settings.
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowSendConfirmDialog(false)}
              data-testid="button-cancel-send"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSendCampaign}
              disabled={sending || loadingServerCount || serverRecipientCount === 0 || serverRecipientCount === null || recipientCountMismatch || formData.is_test_mode !== (campaign?.is_test_mode || false)}
              className="bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
              data-testid="button-confirm-send"
            >
              {sending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {scheduleMode === 'scheduled' ? 'Scheduling...' : 'Sending...'}
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 mr-2" />
                  {scheduleMode === 'scheduled' ? 'Schedule Campaign' : 'Send Now'}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRecipientListDialog} onOpenChange={setShowRecipientListDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Recipient List ({recipientList.length})
            </DialogTitle>
            <DialogDescription>
              Combined, deduplicated list of all recipients across audience segments
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            {loadingRecipientList ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : recipientList.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">No recipients found</div>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background border-b">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">#</th>
                      <th className="text-left py-2 px-3 font-medium">Email</th>
                      <th className="text-left py-2 px-3 font-medium">Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipientList
                      .slice((recipientPage - 1) * RECIPIENTS_PER_PAGE, recipientPage * RECIPIENTS_PER_PAGE)
                      .map((r, i) => (
                        <tr key={i} className="border-b last:border-b-0" data-testid={`recipient-row-${i}`}>
                          <td className="py-2 px-3 text-muted-foreground">{(recipientPage - 1) * RECIPIENTS_PER_PAGE + i + 1}</td>
                          <td className="py-2 px-3">{r.email}</td>
                          <td className="py-2 px-3">{[r.firstName, r.lastName].filter(Boolean).join(' ') || '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {recipientList.length > RECIPIENTS_PER_PAGE && (
                  <div className="flex items-center justify-between gap-2 pt-3 px-3 border-t">
                    <span className="text-sm text-muted-foreground">
                      Page {recipientPage} of {Math.ceil(recipientList.length / RECIPIENTS_PER_PAGE)}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" disabled={recipientPage <= 1}
                        onClick={() => setRecipientPage(p => p - 1)} data-testid="button-recipients-prev">
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <Button variant="outline" size="sm" disabled={recipientPage >= Math.ceil(recipientList.length / RECIPIENTS_PER_PAGE)}
                        onClick={() => setRecipientPage(p => p + 1)} data-testid="button-recipients-next">
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter className="gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (recipientList.length === 0) return;
                const csv = ['Email,First Name,Last Name', ...recipientList.map(r =>
                  `"${(r.email || '').replace(/"/g, '""')}","${(r.firstName || '').replace(/"/g, '""')}","${(r.lastName || '').replace(/"/g, '""')}"`
                )].join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'recipients.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
              disabled={recipientList.length === 0}
              data-testid="button-export-csv"
            >
              <Download className="w-4 h-4 mr-1" />
              Export CSV
            </Button>
            <Button variant="outline" onClick={() => setShowRecipientListDialog(false)} data-testid="button-close-recipients">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showTestEmailDialog} onOpenChange={(open) => {
        setShowTestEmailDialog(open);
        if (!open) {
          setTestEmailAddress('');
          setTestEmailMode('manual');
          setMemberSearchQuery('');
          setMemberSearchResults([]);
          setSelectedMember(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Test Email</DialogTitle>
            <DialogDescription>
              Send a test email to preview how the campaign will look
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Tabs value={testEmailMode} onValueChange={(v) => {
              setTestEmailMode(v);
              setTestEmailAddress('');
              setMemberSearchQuery('');
              setMemberSearchResults([]);
              setSelectedMember(null);
            }}>
              <TabsList className="w-full">
                <TabsTrigger value="manual" className="flex-1" data-testid="tab-manual-email">
                  <Mail className="w-4 h-4 mr-2" />
                  Enter Email
                </TabsTrigger>
                <TabsTrigger value="member" className="flex-1" data-testid="tab-member-lookup">
                  <Search className="w-4 h-4 mr-2" />
                  Find Member
                </TabsTrigger>
              </TabsList>
              
              <TabsContent value="manual" className="mt-4">
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
              </TabsContent>
              
              <TabsContent value="member" className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="member-search">Search Member</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="member-search"
                      value={memberSearchQuery}
                      onChange={(e) => handleMemberSearchInput(e.target.value)}
                      placeholder="Search by name or email..."
                      className="pl-9"
                      data-testid="input-member-search"
                    />
                    {searchingMembers && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  
                  {memberSearchResults.length > 0 && (
                    <div className="border rounded-md max-h-48 overflow-y-auto">
                      {memberSearchResults.map((member) => (
                        <button
                          key={member.id}
                          type="button"
                          onClick={() => handleSelectMember(member)}
                          className="w-full text-left px-3 py-2 hover-elevate flex items-center gap-2 border-b last:border-b-0"
                          data-testid={`member-result-${member.id}`}
                        >
                          <Users className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">
                              {member.first_name} {member.last_name}
                            </div>
                            <div className="text-sm text-muted-foreground truncate">
                              {member.email}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  
                  {memberSearchQuery.length >= 2 && memberSearchResults.length === 0 && !searchingMembers && (
                    <p className="text-sm text-muted-foreground">No members found</p>
                  )}
                  
                  {selectedMember && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center gap-2">
                      <Users className="w-4 h-4 text-blue-600 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-blue-900">
                          {selectedMember.first_name} {selectedMember.last_name}
                        </div>
                        <div className="text-sm text-blue-700 truncate">
                          {selectedMember.email}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
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
                if (testEmailAddress) {
                  handleTestSend(testEmailAddress);
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

      {/* Full-screen Visual Email Editor Modal */}
      <Dialog open={showVisualEditor} onOpenChange={setShowVisualEditor}>
        <DialogContent className="max-w-[100vw] w-[100vw] h-[100vh] max-h-[100vh] p-0 gap-0 flex flex-col">
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between px-4 py-3 border-b bg-background">
              <div className="flex items-center gap-3">
                <Wand2 className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">Visual Email Builder</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPreviewMode('desktop');
                    setShowPreview(true);
                  }}
                  data-testid="button-preview-email"
                >
                  <Eye className="w-4 h-4 mr-1" />
                  Preview
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowVisualEditor(false)}
                  data-testid="button-cancel-visual-editor"
                >
                  <X className="w-4 h-4 mr-1" />
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    handleSaveCampaign();
                  }}
                  disabled={saving}
                  data-testid="button-save-no-close"
                >
                  <Save className="w-4 h-4 mr-1" />
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    handleSaveCampaign();
                    setShowVisualEditor(false);
                  }}
                  disabled={saving}
                  data-testid="button-save-visual-editor"
                >
                  <Check className="w-4 h-4 mr-1" />
                  Save & Close
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <Suspense fallback={
                <div className="flex items-center justify-center h-full bg-muted/10">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              }>
                <EmailBuilder
                  initialDesign={formData.design_json}
                  onChange={({ design, html }) => {
                    setFormData(prev => ({
                      ...prev,
                      design_json: design,
                      html_content: html || prev.html_content,
                    }));
                  }}
                />
              </Suspense>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] max-h-[85vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="flex flex-row items-center justify-between px-4 py-3 border-b bg-background flex-shrink-0 space-y-0">
            <DialogTitle className="text-sm font-semibold" data-testid="text-preview-title">Email Preview</DialogTitle>
            <DialogDescription className="sr-only">Preview how your email will look on desktop and mobile devices</DialogDescription>
            <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
              <Button
                variant={previewMode === 'desktop' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setPreviewMode('desktop')}
                data-testid="button-preview-desktop"
              >
                <Monitor className="w-4 h-4 mr-1" />
                Desktop
              </Button>
              <Button
                variant={previewMode === 'mobile' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setPreviewMode('mobile')}
                data-testid="button-preview-mobile"
              >
                <Smartphone className="w-4 h-4 mr-1" />
                Mobile
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-auto bg-muted/30 flex justify-center p-6" data-testid="preview-container">
            <div
              className="bg-white dark:bg-zinc-900 rounded-md shadow-md overflow-hidden transition-all duration-300 h-fit border border-border"
              style={{ width: previewMode === 'mobile' ? '375px' : '100%', maxWidth: '800px' }}
            >
              <div className="border-b border-border bg-muted/40 px-4 py-2 flex items-center justify-between gap-2 flex-wrap" data-testid="preview-email-toolbar">
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1} data-testid="button-preview-archive">
                    <Archive className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1} data-testid="button-preview-trash">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1} data-testid="button-preview-reply">
                    <Reply className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1} data-testid="button-preview-forward">
                    <Forward className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1} data-testid="button-preview-star">
                    <Star className="w-3.5 h-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1} data-testid="button-preview-more">
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              <div className="border-b border-border px-4 py-3 space-y-1.5 bg-background" data-testid="preview-email-headers">
                <div className="text-base font-semibold text-foreground" data-testid="text-preview-subject">
                  {formData.subject || 'No subject'}
                </div>
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
                    <Mail className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground" data-testid="text-preview-from-name">
                        {formData.from_name || 'Sender Name'}
                      </span>
                      <span className="text-xs text-muted-foreground" data-testid="text-preview-from-email">
                        &lt;{formData.from_email || 'sender@example.com'}&gt;
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5" data-testid="text-preview-to">
                      to <span className="font-medium">recipient@example.com</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground" data-testid="text-preview-date">
                      {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <Paperclip className="w-3.5 h-3.5 text-muted-foreground opacity-0" />
                  </div>
                </div>
              </div>

              <div data-testid="preview-email-body" style={{ backgroundColor: formData.design_json?.globalStyles?.backgroundColor || '#f4f4f4' }}>
                {formData.design_json ? (
                  <ReadOnlyBlockPreview
                    blocks={formData.design_json.blocks}
                    globalStyles={formData.design_json.globalStyles}
                    footerHtml={footerData?.hasFooter ? footerData.footer : null}
                  />
                ) : (
                  <div className="flex items-center justify-center h-96 text-muted-foreground text-sm" data-testid="text-no-design">
                    No design to preview. Add some content blocks first.
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
