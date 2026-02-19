import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Loader2, Save, UserPlus, Building2, FileText, Shield, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/queryClient";
import ImageSelector from "@/components/ImageSelector";

const CURRENCIES = [
  { value: 'GBP', label: 'GBP', symbol: '\u00a3' },
  { value: 'USD', label: 'USD', symbol: '$' },
  { value: 'EUR', label: 'EUR', symbol: '\u20ac' },
];

export default function CampaignEdit() {
  const navigate = useNavigate();
  const { id } = useParams();
  const queryClient = useQueryClient();
  const isEditing = id !== 'new';

  const [form, setForm] = useState({
    name: '',
    description: '',
    cover_image_url: '',
    goal_amount: '',
    currency: 'GBP',
    start_date: '',
    end_date: '',
    status: 'draft',
    allow_anonymous_donations: true,
    campaign_type: 'individual',
    max_team_size: '5',
    registration_open: false,
    registration_message: '',
    public_description: '',
    auto_create_members: false,
    member_role_id: '',
    allow_org_signup: false,
    auto_create_organisations: false,
    unlimited_team_size: false,
    hide_campaign_target: false,
    terms_and_conditions: '',
    privacy_statement: ''
  });

  const [formLoaded, setFormLoaded] = useState(false);
  const [aiGenerating, setAiGenerating] = useState({});

  const handleAiGenerate = async (field) => {
    if (!form.name?.trim()) {
      toast.error('Please enter a campaign name first so the AI has context to work with.');
      return;
    }

    setAiGenerating(prev => ({ ...prev, [field]: true }));

    const prompts = {
      public_description: `Write a compelling, warm public description for a fundraising campaign called "${form.name}".${form.description ? ` Additional context: ${form.description}` : ''}${form.goal_amount ? ` The fundraising goal is ${form.goal_amount} ${form.currency || 'GBP'}.` : ''} The description should be 2-3 short paragraphs that inspire potential participants to sign up and fundraise. Use an encouraging, professional tone. Do not use emojis. Return only the description text, no headings or labels.`,
      registration_message: `Write a brief, friendly thank-you message for someone who just registered as a fundraiser for a campaign called "${form.name}".${form.description ? ` Campaign context: ${form.description}` : ''} The message should be 2-3 sentences, welcoming them and letting them know what to expect next. Use a warm, professional tone. Do not use emojis. Return only the message text, no headings or labels.`
    };

    try {
      const res = await apiRequest('POST', '/api/integrations/invoke-llm', {
        prompt: prompts[field]
      });
      if (res.response) {
        setForm(f => ({ ...f, [field]: res.response.trim() }));
        toast.success('AI suggestion generated. Feel free to edit it.');
      } else {
        toast.error('Could not generate a suggestion. Please try again.');
      }
    } catch (err) {
      console.error('AI generate error:', err);
      toast.error('Failed to generate suggestion. Please try again.');
    } finally {
      setAiGenerating(prev => ({ ...prev, [field]: false }));
    }
  };

  const { data: campaignData, isLoading: campaignLoading } = useQuery({
    queryKey: ['fundraising-campaigns', id],
    queryFn: () => apiRequest('GET', `/api/fundraising/campaigns?id=${id}`),
    enabled: isEditing
  });

  useEffect(() => {
    if (campaignData && !formLoaded) {
      setForm({
        name: campaignData.name || '',
        description: campaignData.description || '',
        cover_image_url: campaignData.cover_image_url || '',
        goal_amount: campaignData.goal_amount?.toString() || '',
        currency: campaignData.currency || 'GBP',
        start_date: campaignData.start_date ? campaignData.start_date.substring(0, 10) : '',
        end_date: campaignData.end_date ? campaignData.end_date.substring(0, 10) : '',
        status: campaignData.status || 'draft',
        allow_anonymous_donations: campaignData.allow_anonymous_donations !== false,
        campaign_type: campaignData.campaign_type || 'individual',
        max_team_size: campaignData.max_team_size?.toString() || '5',
        registration_open: campaignData.registration_open || false,
        registration_message: campaignData.registration_message || '',
        public_description: campaignData.public_description || '',
        auto_create_members: campaignData.auto_create_members || false,
        member_role_id: campaignData.member_role_id || '',
        allow_org_signup: campaignData.allow_org_signup || false,
        auto_create_organisations: campaignData.auto_create_organisations || false,
        unlimited_team_size: campaignData.unlimited_team_size || false,
        hide_campaign_target: campaignData.hide_campaign_target || false,
        terms_and_conditions: campaignData.terms_and_conditions || '',
        privacy_statement: campaignData.privacy_statement || ''
      });
      setFormLoaded(true);
    }
  }, [campaignData, formLoaded]);

  const { data: rolesData } = useQuery({
    queryKey: ['roles'],
    queryFn: () => apiRequest('GET', '/api/admin/roles')
  });
  const roles = rolesData?.data || [];

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      const url = isEditing
        ? `/api/fundraising/campaigns?id=${id}`
        : '/api/fundraising/campaigns';
      return apiRequest(isEditing ? 'PUT' : 'POST', url, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fundraising-campaigns'] });
      toast.success(isEditing ? 'Campaign updated' : 'Campaign created');
      navigate('/FundraisingManagement');
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
      end_date: form.end_date || null,
      max_team_size: (form.campaign_type === 'team' || form.campaign_type === 'both') && !form.unlimited_team_size ? parseInt(form.max_team_size) || 5 : null,
      unlimited_team_size: form.unlimited_team_size || false,
      hide_campaign_target: form.hide_campaign_target || false,
      terms_and_conditions: form.terms_and_conditions || null,
      privacy_statement: form.privacy_statement || null,
      registration_message: form.registration_message || null,
      public_description: form.public_description || null,
      auto_create_members: form.auto_create_members || false,
      member_role_id: form.auto_create_members ? (form.member_role_id || null) : null
    });
  };

  if (isEditing && campaignLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/FundraisingManagement')}
          data-testid="button-back"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            {isEditing ? 'Edit Campaign' : 'New Campaign'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {isEditing ? 'Update your campaign details' : 'Set up a new fundraising campaign'}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Campaign Details</CardTitle>
            <CardDescription>Basic information about your fundraising campaign</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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

            <ImageSelector
              value={form.cover_image_url}
              onChange={(url) => setForm(f => ({ ...f, cover_image_url: url }))}
              label="Cover Image"
              helpText="Displayed on the campaign page and registration page"
            />

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
                <Label>End Date <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  type="date"
                  value={form.end_date}
                  onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))}
                  data-testid="input-campaign-end"
                />
                <p className="text-xs text-muted-foreground">Leave blank for open-ended campaigns</p>
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Allow anonymous donations</Label>
              <Switch
                checked={form.allow_anonymous_donations}
                onCheckedChange={(v) => setForm(f => ({ ...f, allow_anonymous_donations: v }))}
                data-testid="switch-anonymous"
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Hide campaign target & donations</Label>
                <p className="text-xs text-muted-foreground">Hides the overall campaign goal and total raised from public pages. Individual fundraiser goals remain visible.</p>
              </div>
              <Switch
                checked={form.hide_campaign_target}
                onCheckedChange={(v) => setForm(f => ({ ...f, hide_campaign_target: v }))}
                data-testid="switch-hide-campaign-target"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Public Registration</CardTitle>
            <CardDescription>Configure how participants can register for this campaign</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Campaign Type</Label>
              <Select
                value={form.campaign_type}
                onValueChange={(v) => setForm(f => ({ ...f, campaign_type: v }))}
              >
                <SelectTrigger data-testid="select-campaign-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="individual">Individual</SelectItem>
                  <SelectItem value="team">Team</SelectItem>
                  <SelectItem value="both">Both (Individual or Team)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.campaign_type === 'team'
                  ? 'Participants register as a team with multiple members'
                  : form.campaign_type === 'both'
                    ? 'Participants choose to register as an individual or as a team'
                    : 'Participants register individually'}
              </p>
            </div>

            {(form.campaign_type === 'team' || form.campaign_type === 'both') && (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Unlimited Team Size</Label>
                    <p className="text-xs text-muted-foreground">Allow teams to have any number of members</p>
                  </div>
                  <Switch
                    checked={form.unlimited_team_size}
                    onCheckedChange={(v) => setForm(f => ({ ...f, unlimited_team_size: v }))}
                    data-testid="switch-unlimited-team-size"
                  />
                </div>
                {!form.unlimited_team_size && (
                  <div className="space-y-2">
                    <Label>Max Team Size</Label>
                    <Input
                      type="number"
                      min="2"
                      max="50"
                      value={form.max_team_size}
                      onChange={(e) => setForm(f => ({ ...f, max_team_size: e.target.value }))}
                      data-testid="input-max-team-size"
                    />
                  </div>
                )}
              </>
            )}

            <div className="flex items-center justify-between">
              <div>
                <Label>Registration Open</Label>
                <p className="text-xs text-muted-foreground">Allow the public to register for this campaign</p>
              </div>
              <Switch
                checked={form.registration_open}
                onCheckedChange={(v) => setForm(f => ({ ...f, registration_open: v }))}
                data-testid="switch-registration-open"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Label>Public Description</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleAiGenerate('public_description')}
                  disabled={aiGenerating.public_description}
                  data-testid="button-ai-public-description"
                >
                  {aiGenerating.public_description ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  {aiGenerating.public_description ? 'Generating...' : 'AI Suggest'}
                </Button>
              </div>
              <Textarea
                value={form.public_description}
                onChange={(e) => setForm(f => ({ ...f, public_description: e.target.value }))}
                placeholder="Describe the campaign for potential participants on the public registration page..."
                rows={3}
                data-testid="input-public-description"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Label>Registration Message</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleAiGenerate('registration_message')}
                  disabled={aiGenerating.registration_message}
                  data-testid="button-ai-registration-message"
                >
                  {aiGenerating.registration_message ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  {aiGenerating.registration_message ? 'Generating...' : 'AI Suggest'}
                </Button>
              </div>
              <Textarea
                value={form.registration_message}
                onChange={(e) => setForm(f => ({ ...f, registration_message: e.target.value }))}
                placeholder="Shown after someone registers successfully (e.g. 'Thank you for signing up! We'll be in touch soon.')"
                rows={2}
                data-testid="input-registration-message"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Allow organisational sign-up</Label>
                <p className="text-xs text-muted-foreground">
                  Ask registrants to provide their organisation details during sign-up
                </p>
              </div>
              <Switch
                checked={form.allow_org_signup}
                onCheckedChange={(v) => setForm(f => ({ ...f, allow_org_signup: v }))}
                data-testid="switch-allow-org-signup"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Legal & Privacy
            </CardTitle>
            <CardDescription>Terms and privacy information shown to donors</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                Terms and Conditions
              </Label>
              <p className="text-xs text-muted-foreground">
                Donors will be required to agree to these terms before making a payment.
              </p>
              <Textarea
                value={form.terms_and_conditions}
                onChange={(e) => setForm(f => ({ ...f, terms_and_conditions: e.target.value }))}
                placeholder="Enter your fundraising terms and conditions..."
                rows={6}
                className="text-sm"
                data-testid="textarea-terms-conditions"
              />
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5" />
                Privacy Statement
              </Label>
              <p className="text-xs text-muted-foreground">
                A link to this privacy statement will be shown at the bottom of the donation page.
              </p>
              <Textarea
                value={form.privacy_statement}
                onChange={(e) => setForm(f => ({ ...f, privacy_statement: e.target.value }))}
                placeholder="Enter your privacy statement..."
                rows={6}
                className="text-sm"
                data-testid="textarea-privacy-statement"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              Record Creation
            </CardTitle>
            <CardDescription>Automatically create organisation and member records from registrations</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-create organisations</Label>
                <p className="text-xs text-muted-foreground">
                  Automatically create organisation records from the organisational data provided during registration
                </p>
              </div>
              <Switch
                checked={form.auto_create_organisations}
                onCheckedChange={(v) => setForm(f => ({ ...f, auto_create_organisations: v }))}
                data-testid="switch-auto-create-organisations"
              />
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-create member records</Label>
                <p className="text-xs text-muted-foreground">
                  {form.auto_create_organisations
                    ? 'Create member records and link them to the auto-created organisation'
                    : 'Create member records from registrant details (without organisation linkage)'}
                </p>
              </div>
              <Switch
                checked={form.auto_create_members}
                onCheckedChange={(v) => setForm(f => ({ ...f, auto_create_members: v }))}
                data-testid="switch-auto-create-members"
              />
            </div>

            {form.auto_create_members && (
              <div className="space-y-2">
                <Label>Member Role</Label>
                <Select
                  value={form.member_role_id}
                  onValueChange={(v) => setForm(f => ({ ...f, member_role_id: v }))}
                >
                  <SelectTrigger data-testid="select-member-role">
                    <SelectValue placeholder="Select a role..." />
                  </SelectTrigger>
                  <SelectContent>
                    {(roles || []).map(role => (
                      <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The role to assign to automatically created member records
                </p>
              </div>
            )}

            {(form.auto_create_organisations || form.auto_create_members) && (
              <div className="p-3 rounded-md bg-muted/50 text-xs text-muted-foreground space-y-1">
                {form.auto_create_organisations && form.auto_create_members && (
                  <p>Organisations and members will be created automatically. Members will be linked to their organisation.</p>
                )}
                {form.auto_create_organisations && !form.auto_create_members && (
                  <p>Organisations will be created automatically. No member records will be created.</p>
                )}
                {!form.auto_create_organisations && form.auto_create_members && (
                  <p>Member records will be created without organisation linkage.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate('/FundraisingManagement')}
            data-testid="button-cancel"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saveMutation.isPending} data-testid="button-save-campaign">
            {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            <Save className="w-4 h-4 mr-2" />
            {isEditing ? 'Update' : 'Create'} Campaign
          </Button>
        </div>
      </form>
    </div>
  );
}
