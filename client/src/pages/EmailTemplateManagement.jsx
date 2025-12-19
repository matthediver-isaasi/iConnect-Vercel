import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Pencil, Trash2, Mail, Eye, Copy, Code, FileText, X, Info } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const TEMPLATE_CATEGORIES = [
  { value: 'workflow', label: 'Workflow Automation' },
  { value: 'form_submission', label: 'Form Submission' },
  { value: 'notification', label: 'Notifications' },
  { value: 'welcome', label: 'Welcome Messages' },
  { value: 'reminder', label: 'Reminders' },
  { value: 'events', label: 'Events' },
  { value: 'other', label: 'Other' },
];

// Core database field placeholders - use [[placeholder]] syntax for DB values
// These are auto-resolved from member/organization records, not form field mappings
const AVAILABLE_PLACEHOLDERS = [
  { value: '[[member.id]]', label: 'Member ID' },
  { value: '[[member.full_name]]', label: 'Member Full Name' },
  { value: '[[member.email]]', label: 'Member Email' },
  { value: '[[member.phone]]', label: 'Member Phone' },
  { value: '[[organization.id]]', label: 'Organisation ID' },
  { value: '[[organization.name]]', label: 'Organisation Name' },
  { value: '[[organization.invoicing_email]]', label: 'Organisation Email' },
  { value: '[[organization.phone]]', label: 'Organisation Phone' },
];

// System placeholders that are auto-resolved (not mapped from form fields)
const SYSTEM_PLACEHOLDER_PREFIXES = ['member.', 'organization.', 'form.', 'submission.'];

// Extract all {{placeholder}} patterns from text (form field mappings)
const extractFormPlaceholders = (text) => {
  if (!text) return [];
  const regex = /\{\{([^}]+)\}\}/g;
  const placeholders = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const placeholder = match[1].trim();
    if (!placeholders.includes(placeholder)) {
      placeholders.push(placeholder);
    }
  }
  return placeholders;
};

// Extract all [[placeholder]] patterns from text (core DB values)
const extractDbPlaceholders = (text) => {
  if (!text) return [];
  const regex = /\[\[([^\]]+)\]\]/g;
  const placeholders = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const placeholder = match[1].trim();
    if (!placeholders.includes(placeholder)) {
      placeholders.push(placeholder);
    }
  }
  return placeholders;
};

// Check if a placeholder is a system placeholder (auto-resolved)
const isSystemPlaceholder = (placeholder) => {
  return SYSTEM_PLACEHOLDER_PREFIXES.some(prefix => placeholder.startsWith(prefix));
};

const emptyTemplate = {
  name: '',
  description: '',
  subject: '',
  body: '',
  from_name: '',
  from_email: '',
  reply_to: '',
  category: 'workflow',
  is_active: true,
  placeholders: [],
};

const quillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
    [{ 'align': [] }],
    ['link'],
    ['clean']
  ],
};

const quillFormats = [
  'header',
  'bold', 'italic', 'underline', 'strike',
  'color', 'background',
  'list', 'bullet',
  'align',
  'link'
];

export default function EmailTemplateManagement() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [formData, setFormData] = useState(emptyTemplate);
  const [activeTab, setActiveTab] = useState('all');
  const [isCodeView, setIsCodeView] = useState(false);
  const [newPlaceholder, setNewPlaceholder] = useState('');
  const quillRef = useRef(null);

  // Get all [[placeholder]] patterns (core DB values) detected in the current template
  const detectedDbPlaceholders = [...new Set([
    ...extractDbPlaceholders(formData.subject),
    ...extractDbPlaceholders(formData.body)
  ])];
  
  // Get all {{placeholder}} patterns (form field mappings) detected in the current template
  const detectedFormPlaceholders = [...new Set([
    ...extractFormPlaceholders(formData.subject),
    ...extractFormPlaceholders(formData.body)
  ])];
  
  // Add a custom placeholder
  const handleAddCustomPlaceholder = () => {
    const cleaned = newPlaceholder.trim().replace(/[{}]/g, '');
    if (!cleaned) {
      toast.error('Please enter a placeholder name');
      return;
    }
    if (isSystemPlaceholder(cleaned)) {
      toast.error('This is a system placeholder - use the dropdown to insert it');
      return;
    }
    // Insert the placeholder at the cursor or at the end
    const placeholder = `{{${cleaned}}}`;
    setFormData(prev => ({
      ...prev,
      body: prev.body + placeholder,
    }));
    setNewPlaceholder('');
    toast.success(`Placeholder {{${cleaned}}} added`);
  };

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_EmailTemplateManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['email-templates'],
    queryFn: async () => {
      return await base44.entities.EmailTemplate.list('-created_at');
    },
    staleTime: 0,
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.EmailTemplate.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
      toast.success('Email template created successfully');
      handleCloseEditor();
    },
    onError: (error) => {
      toast.error('Failed to create template: ' + (error.message || 'Unknown error'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.EmailTemplate.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
      toast.success('Email template updated successfully');
      handleCloseEditor();
    },
    onError: (error) => {
      toast.error('Failed to update template: ' + (error.message || 'Unknown error'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.EmailTemplate.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
      toast.success('Email template deleted successfully');
      setDeleteDialogOpen(false);
      setSelectedTemplate(null);
    },
    onError: (error) => {
      toast.error('Failed to delete template: ' + (error.message || 'Unknown error'));
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: async (template) => {
      const { id, created_at, updated_at, created_by, ...data } = template;
      return await base44.entities.EmailTemplate.create({
        ...data,
        name: `Copy of ${template.name}`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
      toast.success('Email template duplicated successfully');
    },
    onError: (error) => {
      toast.error('Failed to duplicate template');
    },
  });

  const handleOpenEditor = (template = null) => {
    if (template) {
      setFormData({
        name: template.name || '',
        description: template.description || '',
        subject: template.subject || '',
        body: template.body || '',
        from_name: template.from_name || '',
        from_email: template.from_email || '',
        reply_to: template.reply_to || '',
        category: template.category || 'workflow',
        is_active: template.is_active !== false,
        placeholders: template.placeholders || [],
      });
      setSelectedTemplate(template);
    } else {
      setFormData(emptyTemplate);
      setSelectedTemplate(null);
    }
    setEditorOpen(true);
  };

  const handleCloseEditor = () => {
    setEditorOpen(false);
    setFormData(emptyTemplate);
    setSelectedTemplate(null);
    setIsCodeView(false);
  };

  const handleSave = () => {
    if (!formData.name.trim()) {
      toast.error('Template name is required');
      return;
    }
    if (!formData.subject.trim()) {
      toast.error('Subject is required');
      return;
    }
    if (!formData.body.trim()) {
      toast.error('Body is required');
      return;
    }

    if (selectedTemplate) {
      updateMutation.mutate({ id: selectedTemplate.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handlePreview = (template) => {
    setSelectedTemplate(template);
    setPreviewOpen(true);
  };

  const insertPlaceholder = (placeholder) => {
    setFormData(prev => ({
      ...prev,
      body: prev.body + placeholder,
    }));
  };

  const filteredTemplates = activeTab === 'all' 
    ? templates 
    : templates.filter(t => t.category === activeTab);

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen bg-background p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold mb-2" data-testid="text-page-title">
              Email Templates
            </h1>
            <p className="text-muted-foreground">
              Create and manage reusable email templates for workflows and form submissions
            </p>
          </div>
          <Button onClick={() => handleOpenEditor()} data-testid="button-create-template">
            <Plus className="w-4 h-4 mr-2" />
            Create Template
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mb-6">
          <TabsList>
            <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
            {TEMPLATE_CATEGORIES.map(cat => (
              <TabsTrigger key={cat.value} value={cat.value} data-testid={`tab-${cat.value}`}>
                {cat.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {filteredTemplates.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Mail className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No email templates yet</h3>
              <p className="text-muted-foreground mb-6">
                Create your first email template to use in workflows and form submissions
              </p>
              <Button onClick={() => handleOpenEditor()} data-testid="button-create-first-template">
                <Plus className="w-4 h-4 mr-2" />
                Create Template
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredTemplates.map((template) => (
              <Card key={template.id} className="hover-elevate" data-testid={`card-template-${template.id}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-lg truncate">{template.name}</CardTitle>
                      {template.description && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {template.description}
                        </p>
                      )}
                    </div>
                    <Badge variant={template.is_active ? "default" : "secondary"}>
                      {template.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs text-muted-foreground">Subject</p>
                      <p className="text-sm font-medium truncate">{template.subject}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {TEMPLATE_CATEGORIES.find(c => c.value === template.category)?.label || template.category}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-end gap-1 pt-2 border-t">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handlePreview(template)}
                        data-testid={`button-preview-${template.id}`}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => duplicateMutation.mutate(template)}
                        data-testid={`button-duplicate-${template.id}`}
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleOpenEditor(template)}
                        data-testid={`button-edit-${template.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedTemplate(template);
                          setDeleteDialogOpen(true);
                        }}
                        data-testid={`button-delete-${template.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {selectedTemplate ? 'Edit Email Template' : 'Create Email Template'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-6 py-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Template Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g., Welcome Email"
                    data-testid="input-template-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="category">Category</Label>
                  <Select
                    value={formData.category}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, category: value }))}
                  >
                    <SelectTrigger data-testid="select-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEMPLATE_CATEGORIES.map(cat => (
                        <SelectItem key={cat.value} value={cat.value}>
                          {cat.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of when this template is used"
                  data-testid="input-description"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="from_name">From Name</Label>
                  <Input
                    id="from_name"
                    value={formData.from_name}
                    onChange={(e) => setFormData(prev => ({ ...prev, from_name: e.target.value }))}
                    placeholder="ICONN"
                    data-testid="input-from-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="from_email">From Email</Label>
                  <Input
                    id="from_email"
                    value={formData.from_email}
                    onChange={(e) => setFormData(prev => ({ ...prev, from_email: e.target.value }))}
                    placeholder="noreply@mail.iconn.app"
                    data-testid="input-from-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reply_to">Reply-To</Label>
                  <Input
                    id="reply_to"
                    value={formData.reply_to}
                    onChange={(e) => setFormData(prev => ({ ...prev, reply_to: e.target.value }))}
                    placeholder="support@iconn.app"
                    data-testid="input-reply-to"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="subject">Subject Line *</Label>
                <Input
                  id="subject"
                  value={formData.subject}
                  onChange={(e) => setFormData(prev => ({ ...prev, subject: e.target.value }))}
                  placeholder="Welcome to ICONN, [[member.full_name]]!"
                  data-testid="input-subject"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <Label htmlFor="body">Email Body *</Label>
                  <div className="flex items-center gap-2">
                    <Select onValueChange={insertPlaceholder}>
                      <SelectTrigger className="w-[200px] h-8" data-testid="select-insert-placeholder">
                        <Code className="w-3 h-3 mr-2" />
                        <SelectValue placeholder="Insert placeholder" />
                      </SelectTrigger>
                      <SelectContent>
                        {AVAILABLE_PLACEHOLDERS.map(p => (
                          <SelectItem key={p.value} value={p.value}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant={isCodeView ? "default" : "outline"}
                      size="sm"
                      onClick={() => setIsCodeView(!isCodeView)}
                      data-testid="button-toggle-code-view"
                    >
                      {isCodeView ? (
                        <>
                          <FileText className="w-4 h-4 mr-1" />
                          Rich Text
                        </>
                      ) : (
                        <>
                          <Code className="w-4 h-4 mr-1" />
                          Code View
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                
                {isCodeView ? (
                  <Textarea
                    id="body"
                    value={formData.body}
                    onChange={(e) => setFormData(prev => ({ ...prev, body: e.target.value }))}
                    placeholder="<p>Hello [[member.full_name]],</p><p>Welcome to our community!</p>"
                    rows={12}
                    className="font-mono text-sm"
                    data-testid="textarea-body-code"
                  />
                ) : (
                  <div className="border rounded-md" style={{ minHeight: '300px' }}>
                    <ReactQuill
                      ref={quillRef}
                      theme="snow"
                      value={formData.body}
                      onChange={(value) => setFormData(prev => ({ ...prev, body: value }))}
                      modules={quillModules}
                      formats={quillFormats}
                      placeholder="Hello [[member.full_name]], Welcome to our community!"
                      style={{ height: '250px' }}
                      data-testid="editor-body-rich"
                    />
                  </div>
                )}
                
                {/* Helper note explaining placeholder syntax */}
                <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md">
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                    <div className="text-xs text-blue-800 dark:text-blue-200 space-y-1">
                      <p className="font-medium">Placeholder Syntax</p>
                      <p><code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">[[placeholder]]</code> - Core database values (member/organisation fields from the dropdown above)</p>
                      <p><code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">{"{{placeholder}}"}</code> - Form field values (mapped in Form Builder when using this template)</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Detected Placeholders Summary */}
              {(detectedDbPlaceholders.length > 0 || detectedFormPlaceholders.length > 0) && (
                <div className="space-y-3 p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-muted-foreground" />
                    <Label className="text-sm font-medium">Placeholders in this template</Label>
                  </div>
                  
                  {detectedDbPlaceholders.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Database placeholders (auto-resolved from member/organisation):</p>
                      <div className="flex flex-wrap gap-1">
                        {detectedDbPlaceholders.map(p => (
                          <Badge key={p} variant="secondary" className="font-mono text-xs">
                            {`[[${p}]]`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {detectedFormPlaceholders.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Form field placeholders (mapped in Form Builder):</p>
                      <div className="flex flex-wrap gap-1">
                        {detectedFormPlaceholders.map(p => (
                          <Badge key={p} variant="outline" className="font-mono text-xs bg-primary/10">
                            {`{{${p}}}`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Add Custom Placeholder */}
              <div className="space-y-2">
                <Label className="text-sm">Add Custom Placeholder</Label>
                <p className="text-xs text-muted-foreground">
                  Custom placeholders can be mapped to form fields when using this template for form submissions.
                </p>
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">{'{{'}</span>
                    <Input
                      value={newPlaceholder}
                      onChange={(e) => setNewPlaceholder(e.target.value)}
                      placeholder="field_name"
                      className="pl-7 pr-7 font-mono"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddCustomPlaceholder();
                        }
                      }}
                      data-testid="input-new-placeholder"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">{'}}'}</span>
                  </div>
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handleAddCustomPlaceholder}
                    data-testid="button-add-placeholder"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, is_active: checked }))}
                  data-testid="switch-is-active"
                />
                <Label htmlFor="is_active">Active</Label>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCloseEditor} data-testid="button-cancel">
                Cancel
              </Button>
              <Button 
                onClick={handleSave} 
                disabled={createMutation.isPending || updateMutation.isPending}
                data-testid="button-save"
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                {selectedTemplate ? 'Save Changes' : 'Create Template'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Preview: {selectedTemplate?.name}</DialogTitle>
            </DialogHeader>
            {selectedTemplate && (
              <div className="space-y-4">
                <div className="bg-muted p-4 rounded-lg space-y-2">
                  <p><span className="font-medium">Subject:</span> {selectedTemplate.subject}</p>
                  {selectedTemplate.from_name && (
                    <p><span className="font-medium">From:</span> {selectedTemplate.from_name} &lt;{selectedTemplate.from_email || 'noreply@mail.iconn.app'}&gt;</p>
                  )}
                  {selectedTemplate.reply_to && (
                    <p><span className="font-medium">Reply-To:</span> {selectedTemplate.reply_to}</p>
                  )}
                </div>
                <div className="border rounded-lg p-4">
                  <div 
                    className="prose prose-sm max-w-none dark:prose-invert"
                    dangerouslySetInnerHTML={{ __html: selectedTemplate.body }}
                  />
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Email Template</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{selectedTemplate?.name}"? This action cannot be undone.
                Any workflows or forms using this template will need to be updated.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate(selectedTemplate?.id)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-delete"
              >
                {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
