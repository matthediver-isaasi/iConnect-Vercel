import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Loader2, 
  Users, 
  Calendar,
  Plus,
  Pencil,
  Trash2,
  Phone,
  Video,
  MapPin,
  Clock,
  Link as LinkIcon,
  Copy,
  Check,
  ExternalLink,
  UserCheck,
  UserX,
  Settings
} from 'lucide-react';
import { toast } from 'sonner';

const MEETING_TYPES = [
  { value: 'phone', label: 'Phone Call', icon: Phone },
  { value: 'google_meet', label: 'Google Meet', icon: Video },
  { value: 'zoom', label: 'Zoom Meeting', icon: Video },
  { value: 'in_person', label: 'In Person', icon: MapPin }
];

const DURATION_OPTIONS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 45, label: '45 minutes' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '1.5 hours' },
  { value: 120, label: '2 hours' }
];

const TIMEZONE_OPTIONS = [
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET/CEST)' },
  { value: 'America/New_York', label: 'New York (EST/EDT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' }
];

const DAYS_OF_WEEK = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' }
];

export default function BookingAgentsManagement() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('agents');
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedTemplateForAssign, setSelectedTemplateForAssign] = useState(null);
  const [copied, setCopied] = useState(null);
  const [availabilityDialogOpen, setAvailabilityDialogOpen] = useState(false);
  const [selectedAgentForAvailability, setSelectedAgentForAvailability] = useState(null);
  const [availabilityForm, setAvailabilityForm] = useState({
    is_active: true,
    timezone: 'Europe/London',
    default_slot_minutes: 30,
    buffer_minutes: 15,
    booking_title: 'Book a Meeting',
    booking_description: '',
    working_hours: {
      monday: { enabled: true, start: '09:00', end: '17:00' },
      tuesday: { enabled: true, start: '09:00', end: '17:00' },
      wednesday: { enabled: true, start: '09:00', end: '17:00' },
      thursday: { enabled: true, start: '09:00', end: '17:00' },
      friday: { enabled: true, start: '09:00', end: '17:00' },
      saturday: { enabled: false, start: '09:00', end: '17:00' },
      sunday: { enabled: false, start: '09:00', end: '17:00' }
    }
  });

  const [templateForm, setTemplateForm] = useState({
    name: '',
    description: '',
    duration_minutes: 30,
    meeting_type: 'phone',
    is_active: true,
    email_template_id: ''
  });

  const { data: emailTemplatesData } = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => base44.entities.EmailTemplate.list()
  });
  const emailTemplates = emailTemplatesData || [];

  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['booking-agents'],
    queryFn: async () => {
      const response = await fetch('/api/booking-agents', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch agents');
      return response.json();
    }
  });

  const { data: templatesData, isLoading: templatesLoading } = useQuery({
    queryKey: ['meeting-templates'],
    queryFn: async () => {
      const response = await fetch('/api/meeting-templates', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch templates');
      return response.json();
    }
  });

  const { data: assignmentsData } = useQuery({
    queryKey: ['agent-meeting-templates'],
    queryFn: async () => {
      const response = await fetch('/api/agent-meeting-templates', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch assignments');
      return response.json();
    }
  });

  const { data: availabilityProfilesData, isLoading: isLoadingProfiles } = useQuery({
    queryKey: ['availability-profiles'],
    queryFn: async () => {
      const response = await fetch('/api/availability-profiles', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch availability profiles');
      return response.json();
    }
  });
  const availabilityProfiles = availabilityProfilesData?.profiles || [];

  const toggleAgentMutation = useMutation({
    mutationFn: async ({ identity_id, is_booking_agent }) => {
      const response = await fetch('/api/booking-agents', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity_id, is_booking_agent })
      });
      if (!response.ok) throw new Error('Failed to update agent');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['booking-agents'] });
      queryClient.invalidateQueries({ queryKey: ['availability-profiles'] });
      toast.success('Agent status updated');
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update agent');
    }
  });

  const saveAvailabilityMutation = useMutation({
    mutationFn: async ({ identity_id, ...data }) => {
      const response = await fetch('/api/availability-profiles', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity_id, ...data })
      });
      if (!response.ok) throw new Error('Failed to save availability');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['availability-profiles'] });
      toast.success('Availability settings saved');
      setAvailabilityDialogOpen(false);
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to save availability');
    }
  });

  const createTemplateMutation = useMutation({
    mutationFn: async (data) => {
      const response = await fetch('/api/meeting-templates', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error('Failed to create template');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting-templates'] });
      toast.success('Meeting template created');
      setTemplateDialogOpen(false);
      resetTemplateForm();
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to create template');
    }
  });

  const updateTemplateMutation = useMutation({
    mutationFn: async ({ id, ...data }) => {
      const response = await fetch(`/api/meeting-templates/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error('Failed to update template');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting-templates'] });
      toast.success('Meeting template updated');
      setTemplateDialogOpen(false);
      setEditingTemplate(null);
      resetTemplateForm();
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update template');
    }
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: async (id) => {
      const response = await fetch(`/api/meeting-templates/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to delete template');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meeting-templates'] });
      queryClient.invalidateQueries({ queryKey: ['agent-meeting-templates'] });
      toast.success('Meeting template deleted');
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to delete template');
    }
  });

  const assignAgentMutation = useMutation({
    mutationFn: async ({ identity_id, meeting_template_id, action }) => {
      const response = await fetch('/api/agent-meeting-templates', {
        method: action === 'assign' ? 'POST' : 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity_id, meeting_template_id })
      });
      if (!response.ok) throw new Error(`Failed to ${action} agent`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-meeting-templates'] });
      toast.success('Agent assignment updated');
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update assignment');
    }
  });

  const resetTemplateForm = () => {
    setTemplateForm({
      name: '',
      description: '',
      duration_minutes: 30,
      meeting_type: 'phone',
      is_active: true,
      email_template_id: ''
    });
  };

  const handleEditTemplate = (template) => {
    setEditingTemplate(template);
    setTemplateForm({
      name: template.name,
      description: template.description || '',
      duration_minutes: template.duration_minutes,
      meeting_type: template.meeting_type,
      is_active: template.is_active,
      email_template_id: template.email_template_id || ''
    });
    setTemplateDialogOpen(true);
  };

  const handleSaveTemplate = () => {
    if (!templateForm.name.trim()) {
      toast.error('Name is required');
      return;
    }

    if (editingTemplate) {
      updateTemplateMutation.mutate({ id: editingTemplate.id, ...templateForm });
    } else {
      createTemplateMutation.mutate(templateForm);
    }
  };

  const handleOpenAssignDialog = (template) => {
    setSelectedTemplateForAssign(template);
    setAssignDialogOpen(true);
  };

  const getAssignedAgentsForTemplate = (templateId) => {
    return (assignmentsData?.assignments || [])
      .filter(a => a.meeting_template_id === templateId)
      .map(a => a.identity_id);
  };

  const getAssignedTemplatesForAgent = (agentId) => {
    return (assignmentsData?.assignments || [])
      .filter(a => a.identity_id === agentId)
      .map(a => a.meeting_template_id);
  };

  const getAvailabilityProfile = (identityId) => {
    return availabilityProfiles.find(p => p.identity_id === identityId);
  };

  const openAvailabilityDialog = (agent) => {
    const profile = getAvailabilityProfile(agent.id);
    setSelectedAgentForAvailability(agent);
    if (profile) {
      setAvailabilityForm({
        is_active: profile.is_active ?? true,
        timezone: profile.timezone || 'Europe/London',
        default_slot_minutes: profile.default_slot_minutes || 30,
        buffer_minutes: profile.buffer_minutes || 15,
        booking_title: profile.booking_title || 'Book a Meeting',
        booking_description: profile.booking_description || '',
        working_hours: profile.working_hours || {
          monday: { enabled: true, start: '09:00', end: '17:00' },
          tuesday: { enabled: true, start: '09:00', end: '17:00' },
          wednesday: { enabled: true, start: '09:00', end: '17:00' },
          thursday: { enabled: true, start: '09:00', end: '17:00' },
          friday: { enabled: true, start: '09:00', end: '17:00' },
          saturday: { enabled: false, start: '09:00', end: '17:00' },
          sunday: { enabled: false, start: '09:00', end: '17:00' }
        }
      });
    } else {
      setAvailabilityForm({
        is_active: true,
        timezone: 'Europe/London',
        default_slot_minutes: 30,
        buffer_minutes: 15,
        booking_title: 'Book a Meeting',
        booking_description: '',
        working_hours: {
          monday: { enabled: true, start: '09:00', end: '17:00' },
          tuesday: { enabled: true, start: '09:00', end: '17:00' },
          wednesday: { enabled: true, start: '09:00', end: '17:00' },
          thursday: { enabled: true, start: '09:00', end: '17:00' },
          friday: { enabled: true, start: '09:00', end: '17:00' },
          saturday: { enabled: false, start: '09:00', end: '17:00' },
          sunday: { enabled: false, start: '09:00', end: '17:00' }
        }
      });
    }
    setAvailabilityDialogOpen(true);
  };

  const handleSaveAvailability = () => {
    if (!selectedAgentForAvailability) return;
    saveAvailabilityMutation.mutate({
      identity_id: selectedAgentForAvailability.id,
      ...availabilityForm
    });
  };

  const isAgentAssigned = (agentId, templateId) => {
    return (assignmentsData?.assignments || []).some(
      a => a.identity_id === agentId && a.meeting_template_id === templateId
    );
  };

  const handleToggleAgentAssignment = (agentId, templateId) => {
    const assigned = isAgentAssigned(agentId, templateId);
    assignAgentMutation.mutate({
      identity_id: agentId,
      meeting_template_id: templateId,
      action: assigned ? 'unassign' : 'assign'
    });
  };

  const copyBookingLink = (agent) => {
    const link = `${window.location.origin}/book/${agent.booking_slug}`;
    navigator.clipboard.writeText(link);
    setCopied(agent.id);
    setTimeout(() => setCopied(null), 2000);
    toast.success('Booking link copied');
  };

  const agents = agentsData?.agents || [];
  const allMembers = agentsData?.allMembers || [];
  const templates = templatesData?.templates || [];

  const getMeetingTypeIcon = (type) => {
    const mt = MEETING_TYPES.find(t => t.value === type);
    if (!mt) return null;
    const Icon = mt.icon;
    return <Icon className="h-4 w-4" />;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8" data-testid="page-booking-agents">
      <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Booking Management</h1>
          <p className="text-muted-foreground">Manage booking agents and meeting types</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="agents" data-testid="tab-agents">
            <Users className="h-4 w-4 mr-2" />
            Agents
          </TabsTrigger>
          <TabsTrigger value="templates" data-testid="tab-templates">
            <Calendar className="h-4 w-4 mr-2" />
            Meeting Types
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Booking Agents</CardTitle>
              <CardDescription>
                Select team members who can accept bookings through their personal booking pages
              </CardDescription>
            </CardHeader>
            <CardContent>
              {agentsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-3">
                  {allMembers.map((member) => (
                    <div 
                      key={member.id} 
                      className="flex items-center justify-between p-3 border rounded-lg"
                      data-testid={`agent-row-${member.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${member.is_booking_agent ? 'bg-primary/10' : 'bg-muted'}`}>
                          {member.is_booking_agent ? (
                            <UserCheck className="h-4 w-4 text-primary" />
                          ) : (
                            <UserX className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium">
                            {member.first_name} {member.last_name}
                          </p>
                          <p className="text-sm text-muted-foreground">{member.email}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {member.is_booking_agent && member.booking_slug && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyBookingLink(member)}
                            data-testid={`copy-link-${member.id}`}
                          >
                            {copied === member.id ? (
                              <Check className="h-4 w-4 text-green-500" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        <Switch
                          checked={member.is_booking_agent === true}
                          onCheckedChange={(checked) => {
                            toggleAgentMutation.mutate({
                              identity_id: member.id,
                              is_booking_agent: checked
                            });
                          }}
                          data-testid={`toggle-agent-${member.id}`}
                        />
                      </div>
                    </div>
                  ))}
                  {allMembers.length === 0 && (
                    <p className="text-center text-muted-foreground py-8">
                      No team members found
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {agents.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Active Agents</CardTitle>
                <CardDescription>
                  Agents who can receive bookings
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {agents.map((agent) => {
                    const hasProfile = !!getAvailabilityProfile(agent.id);
                    return (
                      <Card key={agent.id} className="relative">
                        <CardContent className="pt-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">{agent.first_name} {agent.last_name}</p>
                              <p className="text-sm text-muted-foreground truncate">{agent.email}</p>
                            </div>
                            <Badge variant="secondary">
                              {getAssignedTemplatesForAgent(agent.id).length} meeting types
                            </Badge>
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-sm min-w-0">
                              {agent.booking_slug ? (
                                <>
                                  <LinkIcon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                                  <code className="text-xs bg-muted px-1 py-0.5 rounded truncate">
                                    /book/{agent.booking_slug}
                                  </code>
                                  <a
                                    href={`/book/${agent.booking_slug}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline flex-shrink-0"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </>
                              ) : (
                                <span className="text-muted-foreground text-xs">No booking link</span>
                              )}
                            </div>
                            <Button 
                              variant="outline" 
                              size="sm"
                              onClick={() => openAvailabilityDialog(agent)}
                              data-testid={`button-configure-availability-${agent.id}`}
                            >
                              <Settings className="h-3 w-3 mr-1" />
                              {hasProfile ? 'Edit' : 'Setup'}
                            </Button>
                          </div>
                          {!isLoadingProfiles && !hasProfile && (
                            <p className="text-xs text-amber-600 mt-2">
                              Availability not configured - booking page won't work
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Meeting Types</CardTitle>
                <CardDescription>
                  Define different types of meetings that agents can offer
                </CardDescription>
              </div>
              <Dialog open={templateDialogOpen} onOpenChange={(open) => {
                setTemplateDialogOpen(open);
                if (!open) {
                  setEditingTemplate(null);
                  resetTemplateForm();
                }
              }}>
                <DialogTrigger asChild>
                  <Button data-testid="button-add-template">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Meeting Type
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {editingTemplate ? 'Edit Meeting Type' : 'New Meeting Type'}
                    </DialogTitle>
                    <DialogDescription>
                      Configure the meeting type details
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Name</Label>
                      <Input
                        id="name"
                        value={templateForm.name}
                        onChange={(e) => setTemplateForm(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="e.g., Discovery Call"
                        data-testid="input-template-name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="description">Description</Label>
                      <Textarea
                        id="description"
                        value={templateForm.description}
                        onChange={(e) => setTemplateForm(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="Brief description of this meeting type"
                        data-testid="input-template-description"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Duration</Label>
                        <Select
                          value={String(templateForm.duration_minutes)}
                          onValueChange={(v) => setTemplateForm(prev => ({ ...prev, duration_minutes: parseInt(v) }))}
                        >
                          <SelectTrigger data-testid="select-duration">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DURATION_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={String(opt.value)}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Meeting Type</Label>
                        <Select
                          value={templateForm.meeting_type}
                          onValueChange={(v) => setTemplateForm(prev => ({ ...prev, meeting_type: v }))}
                        >
                          <SelectTrigger data-testid="select-meeting-type">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MEETING_TYPES.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>
                                <div className="flex items-center gap-2">
                                  <opt.icon className="h-4 w-4" />
                                  {opt.label}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Invitation Email Template</Label>
                      <Select
                        value={templateForm.email_template_id || 'none'}
                        onValueChange={(v) => setTemplateForm(prev => ({ ...prev, email_template_id: v === 'none' ? '' : v }))}
                      >
                        <SelectTrigger data-testid="select-email-template">
                          <SelectValue placeholder="Select email template (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No email template</SelectItem>
                          {emailTemplates.map(template => (
                            <SelectItem key={template.id} value={template.id}>
                              {template.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Used when inviting to meetings from workflows
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="is_active"
                        checked={templateForm.is_active}
                        onCheckedChange={(checked) => setTemplateForm(prev => ({ ...prev, is_active: checked }))}
                        data-testid="switch-template-active"
                      />
                      <Label htmlFor="is_active">Active</Label>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setTemplateDialogOpen(false);
                        setEditingTemplate(null);
                        resetTemplateForm();
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleSaveTemplate}
                      disabled={createTemplateMutation.isPending || updateTemplateMutation.isPending}
                      data-testid="button-save-template"
                    >
                      {(createTemplateMutation.isPending || updateTemplateMutation.isPending) && (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      )}
                      {editingTemplate ? 'Update' : 'Create'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent>
              {templatesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : templates.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No meeting types defined yet. Create one to get started.
                </div>
              ) : (
                <div className="space-y-3">
                  {templates.map((template) => {
                    const assignedAgents = getAssignedAgentsForTemplate(template.id);
                    return (
                      <div 
                        key={template.id} 
                        className="flex items-center justify-between p-4 border rounded-lg"
                        data-testid={`template-row-${template.id}`}
                      >
                        <div className="flex items-center gap-4">
                          <div className="p-2 bg-muted rounded-lg">
                            {getMeetingTypeIcon(template.meeting_type)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{template.name}</p>
                              {!template.is_active && (
                                <Badge variant="secondary">Inactive</Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-sm text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {template.duration_minutes} min
                              </span>
                              <span className="flex items-center gap-1">
                                <Users className="h-3 w-3" />
                                {assignedAgents.length} agents
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1 font-mono">
                              ?meeting={template.slug}
                            </div>
                            {template.description && (
                              <p className="text-sm text-muted-foreground mt-1">
                                {template.description}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleOpenAssignDialog(template)}
                            data-testid={`assign-agents-${template.id}`}
                          >
                            <Users className="h-4 w-4 mr-1" />
                            Assign Agents
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditTemplate(template)}
                            data-testid={`edit-template-${template.id}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (confirm('Are you sure you want to delete this meeting type?')) {
                                deleteTemplateMutation.mutate(template.id);
                              }
                            }}
                            data-testid={`delete-template-${template.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Agents to {selectedTemplateForAssign?.name}</DialogTitle>
            <DialogDescription>
              Select which agents can offer this meeting type
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-2 py-4">
              {agents.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No agents available. Enable agents in the Agents tab first.
                </p>
              ) : (
                agents.map((agent) => {
                  const assigned = selectedTemplateForAssign && isAgentAssigned(agent.id, selectedTemplateForAssign.id);
                  return (
                    <div 
                      key={agent.id} 
                      className="flex items-center gap-3 p-2 rounded hover:bg-muted"
                    >
                      <Checkbox
                        id={`assign-${agent.id}`}
                        checked={assigned}
                        onCheckedChange={() => {
                          if (selectedTemplateForAssign) {
                            handleToggleAgentAssignment(agent.id, selectedTemplateForAssign.id);
                          }
                        }}
                        data-testid={`checkbox-assign-${agent.id}`}
                      />
                      <Label htmlFor={`assign-${agent.id}`} className="flex-1 cursor-pointer">
                        <span className="font-medium">{agent.first_name} {agent.last_name}</span>
                        <span className="text-sm text-muted-foreground ml-2">{agent.email}</span>
                      </Label>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={availabilityDialogOpen} onOpenChange={setAvailabilityDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Availability Settings
              {selectedAgentForAvailability && (
                <span className="text-muted-foreground font-normal ml-2">
                  - {selectedAgentForAvailability.first_name} {selectedAgentForAvailability.last_name}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Configure when this agent is available for bookings
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Booking Page Title</Label>
                <Input
                  value={availabilityForm.booking_title}
                  onChange={(e) => setAvailabilityForm(f => ({ ...f, booking_title: e.target.value }))}
                  placeholder="Book a Meeting"
                  data-testid="input-booking-title"
                />
              </div>
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Select
                  value={availabilityForm.timezone}
                  onValueChange={(v) => setAvailabilityForm(f => ({ ...f, timezone: v }))}
                >
                  <SelectTrigger data-testid="select-timezone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONE_OPTIONS.map(tz => (
                      <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Booking Page Description (optional)</Label>
              <Textarea
                value={availabilityForm.booking_description}
                onChange={(e) => setAvailabilityForm(f => ({ ...f, booking_description: e.target.value }))}
                placeholder="Describe what visitors can expect when booking a meeting..."
                rows={2}
                data-testid="input-booking-description"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Default Slot Duration</Label>
                <Select
                  value={String(availabilityForm.default_slot_minutes)}
                  onValueChange={(v) => setAvailabilityForm(f => ({ ...f, default_slot_minutes: parseInt(v) }))}
                >
                  <SelectTrigger data-testid="select-slot-duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Buffer Between Meetings</Label>
                <Select
                  value={String(availabilityForm.buffer_minutes)}
                  onValueChange={(v) => setAvailabilityForm(f => ({ ...f, buffer_minutes: parseInt(v) }))}
                >
                  <SelectTrigger data-testid="select-buffer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">No buffer</SelectItem>
                    <SelectItem value="5">5 minutes</SelectItem>
                    <SelectItem value="10">10 minutes</SelectItem>
                    <SelectItem value="15">15 minutes</SelectItem>
                    <SelectItem value="30">30 minutes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Working Hours</Label>
              <div className="space-y-2">
                {DAYS_OF_WEEK.map(day => {
                  const dayData = availabilityForm.working_hours[day.key] || { enabled: false, start: '09:00', end: '17:00' };
                  return (
                    <div key={day.key} className="flex items-center gap-3">
                      <div className="w-28">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={dayData.enabled}
                            onCheckedChange={(checked) => {
                              setAvailabilityForm(f => ({
                                ...f,
                                working_hours: {
                                  ...f.working_hours,
                                  [day.key]: { ...dayData, enabled: !!checked }
                                }
                              }));
                            }}
                            data-testid={`checkbox-day-${day.key}`}
                          />
                          <span className="text-sm">{day.label}</span>
                        </label>
                      </div>
                      {dayData.enabled && (
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={dayData.start}
                            onChange={(e) => {
                              setAvailabilityForm(f => ({
                                ...f,
                                working_hours: {
                                  ...f.working_hours,
                                  [day.key]: { ...dayData, start: e.target.value }
                                }
                              }));
                            }}
                            className="w-28"
                            data-testid={`input-start-${day.key}`}
                          />
                          <span className="text-muted-foreground">to</span>
                          <Input
                            type="time"
                            value={dayData.end}
                            onChange={(e) => {
                              setAvailabilityForm(f => ({
                                ...f,
                                working_hours: {
                                  ...f.working_hours,
                                  [day.key]: { ...dayData, end: e.target.value }
                                }
                              }));
                            }}
                            className="w-28"
                            data-testid={`input-end-${day.key}`}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={availabilityForm.is_active}
                onCheckedChange={(checked) => setAvailabilityForm(f => ({ ...f, is_active: checked }))}
                data-testid="switch-availability-active"
              />
              <Label>Accept new bookings</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAvailabilityDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSaveAvailability}
              disabled={saveAvailabilityMutation.isPending}
              data-testid="button-save-availability"
            >
              {saveAvailabilityMutation.isPending ? 'Saving...' : 'Save Settings'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
