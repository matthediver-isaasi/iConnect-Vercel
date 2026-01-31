import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Mail, ArrowLeft, Save, Send, Eye, Pencil, Users, Code, 
  Loader2, TestTube2
} from "lucide-react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";

const quillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, 4, 5, 6, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    [{ 'align': [] }],
    ['link', 'image'],
    ['blockquote', 'code-block'],
    ['clean']
  ],
};

const quillFormats = [
  'header',
  'bold', 'italic', 'underline', 'strike',
  'color', 'background',
  'list', 'bullet',
  'align',
  'link', 'image',
  'blockquote', 'code-block'
];

export default function EmailCampaignEdit() {
  const navigate = useNavigate();
  const { id } = useParams();
  const queryClient = useQueryClient();
  const isEditing = id && id !== 'new';

  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [editorTab, setEditorTab] = useState('editor');
  const [recipientPreviewCount, setRecipientPreviewCount] = useState(null);
  const [loadingRecipientCount, setLoadingRecipientCount] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    subject: '',
    from_name: '',
    from_email: '',
    reply_to: '',
    email_template_id: '',
    html_content: '',
    target_type: 'communication_category',
    target_ids: [],
    scheduled_at: ''
  });

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
      setFormData({
        name: campaign.name || '',
        subject: campaign.subject || '',
        from_name: campaign.from_name || '',
        from_email: campaign.from_email || '',
        reply_to: campaign.reply_to || '',
        email_template_id: campaign.email_template_id || '',
        html_content: campaign.html_content || '',
        target_type: campaign.target_type || 'communication_category',
        target_ids: campaign.target_ids || [],
        scheduled_at: campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString().slice(0, 16) : ''
      });
    }
  }, [campaign]);

  const { data: footerData } = useQuery({
    queryKey: ['email-footer-preview'],
    queryFn: async () => {
      const response = await fetch('/api/email-campaigns/preview-footer', { credentials: 'include' });
      if (!response.ok) return { footer: null };
      return response.json();
    },
    staleTime: 60000
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

  const handleTestSend = async () => {
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
          subject: formData.subject,
          html_content: formData.html_content,
          from_name: formData.from_name,
          from_email: formData.from_email,
          reply_to: formData.reply_to
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send test email');
      }

      const result = await response.json();
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
            onClick={handleTestSend}
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

            <div className="space-y-2">
              <Tabs value={editorTab} onValueChange={setEditorTab} className="w-full">
                <TabsList className="w-full grid grid-cols-2">
                  <TabsTrigger value="editor" className="flex items-center gap-2">
                    <Pencil className="w-4 h-4" />
                    Editor
                  </TabsTrigger>
                  <TabsTrigger value="preview" className="flex items-center gap-2">
                    <Eye className="w-4 h-4" />
                    Preview
                  </TabsTrigger>
                </TabsList>
                
                <TabsContent value="editor" className="mt-3">
                  <div className="border rounded-md">
                    <ReactQuill
                      theme="snow"
                      value={formData.html_content}
                      onChange={(content) => setFormData(prev => ({ ...prev, html_content: content }))}
                      modules={quillModules}
                      formats={quillFormats}
                      placeholder="Enter your email content..."
                      className="min-h-[400px]"
                      data-testid="editor-html-content"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Available placeholders: {'{{first_name}}'}, {'{{last_name}}'}, {'{{email}}'}, {'{{unsubscribe_url}}'}
                  </p>
                </TabsContent>
                
                <TabsContent value="preview" className="mt-3">
                  <div 
                    className="border rounded-md p-4 min-h-[400px] bg-white prose prose-sm max-w-none"
                    data-testid="preview-html-content"
                  >
                    <div dangerouslySetInnerHTML={{ __html: formData.html_content || '<p class="text-muted-foreground italic">No content yet. Switch to Editor tab to add content.</p>' }} />
                    {footerData?.footer && (
                      <>
                        <hr className="my-4 border-gray-200" />
                        <div 
                          className="text-xs text-gray-500"
                          dangerouslySetInnerHTML={{ __html: footerData.footer }}
                        />
                      </>
                    )}
                    {!footerData?.footer && formData.html_content && (
                      <p className="text-xs text-muted-foreground italic mt-4 border-t pt-2">
                        No tenant email footer configured. Configure one in Admin &gt; System Settings.
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
