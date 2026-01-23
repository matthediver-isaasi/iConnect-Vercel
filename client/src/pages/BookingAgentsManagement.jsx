import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  UserX
} from 'lucide-react';
import { toast } from 'sonner';

const MEETING_TYPES = [
  { value: 'phone', label: 'Phone Call', icon: Phone },
  { value: 'google_meet', label: 'Google Meet', icon: Video },
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

export default function BookingAgentsManagement() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('agents');
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedTemplateForAssign, setSelectedTemplateForAssign] = useState(null);
  const [copied, setCopied] = useState(null);

  const [templateForm, setTemplateForm] = useState({
    name: '',
    description: '',
    duration_minutes: 30,
    meeting_type: 'phone',
    is_active: true
  });

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
      toast.success('Agent status updated');
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update agent');
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
      is_active: true
    });
  };

  const handleEditTemplate = (template) => {
    setEditingTemplate(template);
    setTemplateForm({
      name: template.name,
      description: template.description || '',
      duration_minutes: template.duration_minutes,
      meeting_type: template.meeting_type,
      is_active: template.is_active
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
    <div className="container mx-auto py-6 space-y-6" data-testid="page-booking-agents">
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
                  {agents.map((agent) => (
                    <Card key={agent.id} className="relative">
                      <CardContent className="pt-4">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-medium">{agent.first_name} {agent.last_name}</p>
                            <p className="text-sm text-muted-foreground">{agent.email}</p>
                          </div>
                          <Badge variant="secondary">
                            {getAssignedTemplatesForAgent(agent.id).length} meeting types
                          </Badge>
                        </div>
                        {agent.booking_slug && (
                          <div className="mt-3 flex items-center gap-2 text-sm">
                            <LinkIcon className="h-3 w-3 text-muted-foreground" />
                            <code className="text-xs bg-muted px-1 py-0.5 rounded">
                              /book/{agent.booking_slug}
                            </code>
                            <a
                              href={`/book/${agent.booking_slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
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
    </div>
  );
}
