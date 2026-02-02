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
  Mail, ArrowLeft, Save, Send, Eye, Pencil, Users, Code, 
  Loader2, TestTube2, Clock, Calendar, Search, AlertTriangle, Wand2, X, Check
} from "lucide-react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";

const EmailBuilder = lazy(() => import('@/components/email-builder/EmailBuilder').then(m => ({ default: m.default })));

export default function EmailCampaignEdit() {
  const navigate = useNavigate();
  const { id } = useParams();
  const queryClient = useQueryClient();
  const isEditing = id && id !== 'new';

  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [editorTab, setEditorTab] = useState('html');
  const [showVisualEditor, setShowVisualEditor] = useState(false);
  const [recipientPreviewCount, setRecipientPreviewCount] = useState(null);
  const [loadingRecipientCount, setLoadingRecipientCount] = useState(false);
  const [showTestEmailDialog, setShowTestEmailDialog] = useState(false);
  const [testEmailAddress, setTestEmailAddress] = useState('');
  const [scheduleMode, setScheduleMode] = useState('immediate');
  const [testEmailMode, setTestEmailMode] = useState('manual');
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [memberSearchResults, setMemberSearchResults] = useState([]);
  const [searchingMembers, setSearchingMembers] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);

  const [formData, setFormData] = useState({
    name: '',
    subject: '',
    from_name: '',
    from_email: '',
    reply_to: '',
    email_template_id: '',
    html_content: '',
    design_json: null,
    target_type: 'communication_category',
    target_ids: [],
    scheduled_at: ''
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
      setEditorMode(hasDesign ? 'visual' : (campaign.html_content ? 'html' : 'visual'));
      setFormData({
        name: campaign.name || '',
        subject: campaign.subject || '',
        from_name: campaign.from_name || '',
        from_email: campaign.from_email || '',
        reply_to: campaign.reply_to || '',
        email_template_id: campaign.email_template_id || '',
        html_content: campaign.html_content || '',
        design_json: parsedDesign || null,
        target_type: campaign.target_type || 'communication_category',
        target_ids: campaign.target_ids || [],
        scheduled_at: campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString().slice(0, 16) : ''
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

  // Fetch forms that have a communication category linked (for newsletter targeting)
  const { data: formsWithCategory = [] } = useQuery({
    queryKey: ['forms-with-category'],
    queryFn: async () => {
      try {
        const allForms = await base44.entities.Form.list();
        // Only show forms that have a communication category assigned
        return (allForms || []).filter(f => f.communication_category_id && f.is_active !== false);
      } catch (e) {
        console.error('Failed to fetch forms:', e);
        return [];
      }
    },
    staleTime: 60000
  });

  useEffect(() => {
    const fetchRecipientCount = async () => {
      if (formData.target_type === 'all_members') {
        setLoadingRecipientCount(true);
        try {
          const response = await fetch('/api/email-campaigns/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ 
              campaignId: 'preview',
              preview: true,
              targetType: formData.target_type,
              targetIds: []
            })
          });
          if (response.ok) {
            const data = await response.json();
            setRecipientPreviewCount(data.recipientCount);
          }
        } catch (e) {
          console.error('Failed to fetch recipient count:', e);
        } finally {
          setLoadingRecipientCount(false);
        }
        return;
      }

      if (formData.target_ids.length === 0) {
        setRecipientPreviewCount(null);
        return;
      }

      setLoadingRecipientCount(true);
      try {
        const response = await fetch('/api/email-campaigns/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ 
            campaignId: 'preview',
            preview: true,
            targetType: formData.target_type,
            targetIds: formData.target_ids
          })
        });
        if (response.ok) {
          const data = await response.json();
          setRecipientPreviewCount(data.recipientCount);
        }
      } catch (e) {
        console.error('Failed to fetch recipient count:', e);
      } finally {
        setLoadingRecipientCount(false);
      }
    };

    const debounceTimer = setTimeout(fetchRecipientCount, 300);
    return () => clearTimeout(debounceTimer);
  }, [formData.target_type, formData.target_ids]);

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
      const url = isEditing 
        ? `/api/email-campaigns/${id}`
        : '/api/email-campaigns';
      
      const response = await fetch(url, {
        method: isEditing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save campaign');
      }

      const result = await response.json();
      toast.success(isEditing ? 'Campaign updated' : 'Campaign created');
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      
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
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Audience Type</Label>
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
                    <SelectItem value="form">Form Subscribers</SelectItem>
                    <SelectItem value="all_members">All Members</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {formData.target_type !== 'all_members' && (
                <div className="space-y-2">
                  <Label>
                    Select {formData.target_type === 'communication_category' ? 'Categories' : 
                            formData.target_type === 'member_group' ? 'Groups' : 
                            formData.target_type === 'form' ? 'Forms' : 'Roles'}
                  </Label>
                  <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                    {formData.target_type === 'form' && (
                      formsWithCategory.length === 0 ? (
                        <div className="text-sm text-muted-foreground py-2">
                          No forms with communication categories configured. 
                          <br />
                          <span className="text-xs">Link a form to a communication category in the Form Builder's Submission tab.</span>
                        </div>
                      ) : formsWithCategory.map(form => {
                        const linkedCategory = categories.find(c => c.id === form.communication_category_id);
                        return (
                          <label key={form.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={formData.target_ids.includes(form.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setFormData(prev => ({ ...prev, target_ids: [...prev.target_ids, form.id] }));
                                } else {
                                  setFormData(prev => ({ ...prev, target_ids: prev.target_ids.filter(id => id !== form.id) }));
                                }
                              }}
                              className="rounded"
                            />
                            <span className="text-sm">{form.name}</span>
                            {linkedCategory && (
                              <span className="text-xs text-muted-foreground ml-1">({linkedCategory.name})</span>
                            )}
                          </label>
                        );
                      })
                    )}
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
                        <span className="text-sm">{cat.name}</span>
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
                        <span className="text-sm">{group.name}</span>
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
                        <span className="text-sm">{role.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {(formData.target_type === 'all_members' || formData.target_ids.length > 0) && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <div className="flex items-center gap-2 text-blue-700">
                  <Mail className="w-4 h-4" />
                  {loadingRecipientCount ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Calculating recipients...
                    </span>
                  ) : recipientPreviewCount !== null ? (
                    <span className="font-medium">
                      {recipientPreviewCount} {recipientPreviewCount === 1 ? 'recipient' : 'recipients'} will receive this email
                    </span>
                  ) : (
                    <span>Calculating...</span>
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
                  
                  {formData.html_content && (
                    <div className="space-y-2">
                      <Label className="text-sm">Preview</Label>
                      <div 
                        className="border rounded-md p-4 max-h-[300px] overflow-auto bg-white prose prose-sm max-w-none"
                        data-testid="visual-preview"
                      >
                        <div dangerouslySetInnerHTML={{ __html: formData.html_content }} />
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
        <DialogContent className="max-w-[100vw] w-[100vw] h-[100vh] max-h-[100vh] p-0 gap-0">
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-4 py-3 border-b bg-background">
              <div className="flex items-center gap-3">
                <Wand2 className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">Visual Email Builder</h2>
              </div>
              <div className="flex items-center gap-2">
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
                  size="sm"
                  onClick={() => {
                    toast.success('Design saved');
                    setShowVisualEditor(false);
                  }}
                  data-testid="button-save-visual-editor"
                >
                  <Check className="w-4 h-4 mr-1" />
                  Save & Close
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
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
                  height="100%"
                />
              </Suspense>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
