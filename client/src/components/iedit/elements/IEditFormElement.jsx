import { useState, useMemo } from "react";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import FormRenderer from "../../forms/FormRenderer";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, AlertCircle, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Upload, X, Image as ImageIcon, FolderOpen, Folder, Home, Search, FileText, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import { AlignLeft, AlignCenter, AlignRight } from "lucide-react";

const formQuillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    ['link'],
    ['clean']
  ]
};

const fontFamilies = [
  'Poppins',
  'Degular Medium', 
  'Degular Bold',
  'Degular Semibold',
  'Inter',
  'Arial',
  'Georgia',
  'Times New Roman'
];

const fontWeights = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' }
];

const safeHexColor = (color, fallback = '#000000') => {
  if (!color || typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  return fallback;
};

export default function IEditFormElement({ element, memberInfo, organizationInfo }) {
  const isMobile = useIsMobile();
  const content = element.content || {};
  const formSlug = content.form_slug;
  const [formValues, setFormValues] = useState({});
  const [currentStep, setCurrentStep] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  const {
    anchor,
    heading,
    subheading,
    text_content,
    show_form_title = true,
    show_form_description = true,
    vertical_padding = 48,
    content_max_width = 800,
    background_type = 'color',
    background_color = 'transparent',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    image_url,
    image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    text_color = '#1e293b',
    text_align = 'center'
  } = content;

  const getTextStyle = (prefix) => {
    const fontSize = content[`${prefix}_font_size`] || 16;
    const mobileFontSize = content[`${prefix}_font_size_mobile`];
    
    return {
      fontFamily: content[`${prefix}_font_family`] || 'Poppins',
      fontWeight: content[`${prefix}_font_weight`] || 400,
      fontSize: `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      color: content[`${prefix}_color`] || text_color,
      letterSpacing: `${content[`${prefix}_letter_spacing`] || 0}px`,
      lineHeight: content[`${prefix}_line_height`] || 1.5,
      textAlign: content[`${prefix}_align`] || text_align
    };
  };

  const getFormLabelStyle = () => {
    const fontSize = content.form_label_font_size || 14;
    const mobileFontSize = content.form_label_font_size_mobile;
    
    return {
      '--form-label-font-family': content.form_label_font_family || 'Poppins',
      '--form-label-font-weight': content.form_label_font_weight || 500,
      '--form-label-font-size': `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      '--form-label-color': content.form_label_color || '#334155',
      '--form-label-letter-spacing': `${content.form_label_letter_spacing || 0}px`,
      '--form-label-line-height': content.form_label_line_height || 1.4
    };
  };

  const getFormInputStyle = () => {
    const fontSize = content.form_input_font_size || 14;
    const mobileFontSize = content.form_input_font_size_mobile;
    
    return {
      '--form-input-font-family': content.form_input_font_family || 'Poppins',
      '--form-input-font-weight': content.form_input_font_weight || 400,
      '--form-input-font-size': `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      '--form-input-color': content.form_input_color || '#1e293b',
      '--form-input-letter-spacing': `${content.form_input_letter_spacing || 0}px`,
      '--form-input-line-height': content.form_input_line_height || 1.5
    };
  };

  const formFieldStyles = {
    ...getFormLabelStyle(),
    ...getFormInputStyle()
  };

  const getCardStyle = () => {
    const borderRadius = content.card_border_radius ?? 8;
    const borderEnabled = content.card_border_enabled ?? true;
    const borderWidth = content.card_border_width || 1;
    const borderColor = content.card_border_color || '#e2e8f0';
    const shadowEnabled = content.card_shadow_enabled || false;
    const shadowStyle = content.card_shadow_style || 'medium';
    const shadowColor = content.card_shadow_color || '#000000';
    const shadowOpacity = (content.card_shadow_opacity ?? 10) / 100;
    const backgroundColor = content.card_background_color || '#ffffff';

    const hexToRgba = (hex, alpha) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const shadowPresets = {
      subtle: `0 1px 2px 0 ${hexToRgba(shadowColor, shadowOpacity)}`,
      medium: `0 4px 6px -1px ${hexToRgba(shadowColor, shadowOpacity)}, 0 2px 4px -2px ${hexToRgba(shadowColor, shadowOpacity * 0.5)}`,
      strong: `0 10px 15px -3px ${hexToRgba(shadowColor, shadowOpacity)}, 0 4px 6px -4px ${hexToRgba(shadowColor, shadowOpacity * 0.5)}`,
      xl: `0 20px 25px -5px ${hexToRgba(shadowColor, shadowOpacity)}, 0 8px 10px -6px ${hexToRgba(shadowColor, shadowOpacity * 0.5)}`
    };

    return {
      borderRadius: `${borderRadius}px`,
      border: borderEnabled ? `${borderWidth}px solid ${borderColor}` : 'none',
      boxShadow: shadowEnabled ? shadowPresets[shadowStyle] : 'none',
      backgroundColor: backgroundColor,
      overflow: 'hidden'
    };
  };

  const getBackgroundStyle = () => {
    if (background_type === 'gradient') {
      return {
        background: `linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color})`
      };
    }
    if (background_type === 'image' && image_url) {
      return {
        backgroundImage: `url(${image_url})`,
        backgroundSize: image_fit,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
      };
    }
    return {
      backgroundColor: background_color || 'transparent'
    };
  };

  const { data: form, isLoading } = useQuery({
    queryKey: ['form-embed', formSlug],
    queryFn: async () => {
      if (!formSlug) return null;
      const allForms = await base44.entities.Form.list();
      return allForms.find(f => f.slug === formSlug && f.is_active);
    },
    enabled: !!formSlug
  });

  const submitFormMutation = useMutation({
    mutationFn: async (data) => {
      return base44.entities.FormSubmission.create(data);
    },
    onSuccess: () => {
      setSubmitted(true);
      if (form?.redirect_url) {
        setTimeout(() => {
          window.location.href = form.redirect_url;
        }, 2000);
      }
    },
    onError: (error) => {
      toast.error("Failed to submit form. Please try again.");
      console.error("Form submission error:", error);
    }
  });

  const handleSubmit = async () => {
    if (!form) return;
    
    // Validate required fields
    const missingFields = form.fields.filter(field => 
      field.required && (!formValues[field.id] || formValues[field.id].length === 0)
    );

    if (missingFields.length > 0) {
      toast.error(`Please fill in all required fields: ${missingFields.map(f => f.label).join(', ')}`);
      return;
    }

    // Application form uniqueness validation
    if (form.is_application_form && form.uniqueness_checks && form.uniqueness_checks.length > 0) {
      setIsValidating(true);
      try {
        const response = await fetch('/api/forms/validate-uniqueness', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            application_level: form.application_level || 'member',
            uniqueness_checks: form.uniqueness_checks,
            form_values: formValues,
            fields: form.fields,
            form_id: form.id
          })
        });

        const result = await response.json();
        
        if (!result.valid && result.conflicts && result.conflicts.length > 0) {
          const conflictMessages = result.conflicts.map(c => `${c.field_label}: ${c.message}`);
          toast.error(`Validation failed:\n${conflictMessages.join('\n')}`);
          setIsValidating(false);
          return;
        }
      } catch (error) {
        console.error('[IEditFormElement] Uniqueness validation error:', error);
        toast.error('Unable to validate form. Please try again.');
        setIsValidating(false);
        return;
      }
      setIsValidating(false);
    }

    const submissionData = {
      form_id: form.id,
      form_name: form.name,
      submitted_by_email: memberInfo?.email || null,
      submitted_by_name: memberInfo ? `${memberInfo.first_name} ${memberInfo.last_name}` : null,
      submission_data: formValues,
      created_date: new Date().toISOString()
    };

    submitFormMutation.mutate(submissionData);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" style={getBackgroundStyle()}>
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!form) {
    return (
      <div className="flex items-center justify-center py-12" style={getBackgroundStyle()}>
        <div className="text-center">
          <AlertCircle className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600">Form not found or inactive</p>
        </div>
      </div>
    );
  }

  const isSubmitting = submitFormMutation.isPending || isValidating;

  const renderHeaderSection = () => {
    const hasHeaderContent = heading || subheading || text_content;
    if (!hasHeaderContent) return null;

    return (
      <div className="space-y-4 mb-8" style={{ textAlign: text_align }}>
        {heading && (
          <div 
            style={getTextStyle('heading')} 
            className="prose max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(heading) }}
          />
        )}
        {subheading && (
          <div 
            style={getTextStyle('subheading')} 
            className="prose max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading) }}
          />
        )}
        {text_content && (
          <div 
            className="prose max-w-none mx-auto" 
            style={getTextStyle('text_content')}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text_content) }}
          />
        )}
      </div>
    );
  };

  const containerStyle = {
    ...getBackgroundStyle(),
    paddingTop: `${vertical_padding}px`,
    paddingBottom: `${vertical_padding}px`,
    position: 'relative'
  };

  if (submitted) {
    return (
      <div id={anchor || undefined} style={containerStyle}>
        <div className="relative mx-auto px-4" style={{ maxWidth: `${content_max_width}px` }}>
          <Card style={getCardStyle()}>
            <CardContent className="p-12 text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Success!</h3>
              <p className="text-slate-600">{form.success_message || 'Your form has been submitted successfully.'}</p>
              {form.redirect_url && (
                <p className="text-sm text-slate-500 mt-4">Redirecting...</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (form.layout_type === 'card_swipe') {
    const currentField = form.fields[currentStep];
    const isLastStep = currentStep === form.fields.length - 1;
    const canProceed = !currentField?.required || formValues[currentField?.id];

    return (
      <div id={anchor || undefined} style={containerStyle}>
        {background_type === 'image' && overlay_enabled && (
          <div 
            className="absolute inset-0" 
            style={{ 
              backgroundColor: overlay_color, 
              opacity: overlay_opacity / 100 
            }} 
          />
        )}
        <div 
          className="relative mx-auto px-4"
          style={{ maxWidth: `${content_max_width}px` }}
        >
          {renderHeaderSection()}
          <Card className="iedit-form-styled !rounded-none" style={{ ...formFieldStyles, ...getCardStyle() }}>
            {(show_form_title || show_form_description) && (
              <CardHeader>
                {show_form_title && <CardTitle>{form.name}</CardTitle>}
                {show_form_description && form.description && (
                  <CardDescription className="whitespace-pre-line">{form.description}</CardDescription>
                )}
                <div className="flex gap-1 mt-4">
                  {form.fields.map((_, index) => (
                    <div
                      key={index}
                      className={`h-1 flex-1 rounded ${
                        index <= currentStep ? 'bg-blue-600' : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
              </CardHeader>
            )}
            {!show_form_title && !show_form_description && (
              <div className="px-6 pt-6">
                <div className="flex gap-1">
                  {form.fields.map((_, index) => (
                    <div
                      key={index}
                      className={`h-1 flex-1 rounded ${
                        index <= currentStep ? 'bg-blue-600' : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}
            <CardContent className="min-h-[300px] pt-8">
              {currentField && (
                <FormRenderer
                  field={currentField}
                  value={formValues[currentField.id]}
                  onChange={(value) => setFormValues({ ...formValues, [currentField.id]: value })}
                  memberInfo={memberInfo}
                  organizationInfo={organizationInfo}
                />
              )}
            </CardContent>
            <div className="p-6 pt-0 flex justify-between">
              <Button
                variant="outline"
                onClick={() => setCurrentStep(currentStep - 1)}
                disabled={currentStep === 0}
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                Previous
              </Button>
              {isLastStep ? (
                <Button 
                  onClick={handleSubmit}
                  disabled={!canProceed || isSubmitting}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    form.submit_button_text || 'Submit'
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => setCurrentStep(currentStep + 1)}
                  disabled={!canProceed}
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div id={anchor || undefined} style={containerStyle}>
      {background_type === 'image' && overlay_enabled && (
        <div 
          className="absolute inset-0" 
          style={{ 
            backgroundColor: overlay_color, 
            opacity: overlay_opacity / 100 
          }} 
        />
      )}
      <div 
        className="relative mx-auto px-4"
        style={{ maxWidth: `${content_max_width}px` }}
      >
        {renderHeaderSection()}
        <Card className="iedit-form-styled !rounded-none" style={{ ...formFieldStyles, ...getCardStyle() }}>
          {(show_form_title || show_form_description) && (
            <CardHeader>
              {show_form_title && <CardTitle>{form.name}</CardTitle>}
              {show_form_description && form.description && (
                <CardDescription className="whitespace-pre-line">{form.description}</CardDescription>
              )}
            </CardHeader>
          )}
          <CardContent className="space-y-6">
            {(() => {
              const pages = form.pages || [];
              const hasPages = pages.length > 0 && form.layout_type === 'standard';
              
              if (!hasPages) {
                return form.fields && form.fields.map(field => (
                  <FormRenderer
                    key={field.id}
                    field={field}
                    value={formValues[field.id]}
                    onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                    memberInfo={memberInfo}
                    organizationInfo={organizationInfo}
                  />
                ));
              }
              
              const unassignedFields = form.fields.filter(f => !f.page_id);
              
              return (
                <>
                  {unassignedFields.length > 0 && (
                    <div className="space-y-4 mb-4">
                      {unassignedFields.map(field => (
                        <FormRenderer
                          key={field.id}
                          field={field}
                          value={formValues[field.id]}
                          onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                          memberInfo={memberInfo}
                          organizationInfo={organizationInfo}
                        />
                      ))}
                    </div>
                  )}
                  {pages.map((page, pageIndex) => {
                    const pageFields = form.fields.filter(f => f.page_id === page.id);
                    const columnCount = page.column_count || 1;
                    
                    return (
                      <div key={page.id} className="space-y-4">
                        {pages.length > 1 && (
                          <h4 className="font-medium text-slate-700 border-b pb-2">
                            {page.title || `Section ${pageIndex + 1}`}
                          </h4>
                        )}
                        {columnCount === 1 ? (
                          <div className="space-y-4">
                            {pageFields.map(field => (
                              <FormRenderer
                                key={field.id}
                                field={field}
                                value={formValues[field.id]}
                                onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                                memberInfo={memberInfo}
                                organizationInfo={organizationInfo}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className={`grid gap-4 ${
                            columnCount === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
                          }`}>
                            {Array.from({ length: columnCount }).map((_, colIndex) => {
                              const columnFields = pageFields.filter(f => (f.column_index || 0) === colIndex);
                              return (
                                <div key={colIndex} className="space-y-4">
                                  {columnFields.map(field => (
                                    <FormRenderer
                                      key={field.id}
                                      field={field}
                                      value={formValues[field.id]}
                                      onChange={(value) => setFormValues({ ...formValues, [field.id]: value })}
                                      memberInfo={memberInfo}
                                      organizationInfo={organizationInfo}
                                    />
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              );
            })()}
            <div className="flex justify-end pt-4">
              <Button 
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  form.submit_button_text || 'Submit'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function IEditFormElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [expandedSections, setExpandedSections] = useState({
    formSelection: true,
    background: false,
    headerContent: false,
    formFieldsTypography: false,
    appearance: false
  });
  const [isUploading, setIsUploading] = useState(false);
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [fileSelectorFolder, setFileSelectorFolder] = useState(null);
  const [fileSelectorExpandedFolders, setFileSelectorExpandedFolders] = useState({});
  const [fileSelectorPage, setFileSelectorPage] = useState(1);
  const [fileSelectorItemsPerPage] = useState(12);
  const [fileSelectorSearch, setFileSelectorSearch] = useState("");

  const backgroundType = content.background_type || 'color';
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;

  const { data: forms = [] } = useQuery({
    queryKey: ['forms-list-editor'],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list();
      return allForms.filter(f => f.is_active);
    }
  });

  const { data: repositoryFiles = [] } = useQuery({
    queryKey: ['file-repository'],
    queryFn: () => base44.entities.FileRepository.list(),
    staleTime: 0,
  });

  const { data: fileRepositoryFolders = [] } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('display_order'),
    staleTime: 0,
  });

  const fileSelectorFolderHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return fileRepositoryFolders
        .filter(f => f.parent_folder_id === parentId)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(folder => ({
          ...folder,
          children: buildTree(folder.id)
        }));
    };
    return buildTree(null);
  }, [fileRepositoryFolders]);

  const getFileSelectorBreadcrumb = (folderId) => {
    if (!folderId) return [];
    const trail = [];
    let currentId = folderId;
    while (currentId) {
      const folder = fileRepositoryFolders.find(f => f.id === currentId);
      if (folder) {
        trail.unshift(folder);
        currentId = folder.parent_folder_id;
      } else {
        break;
      }
    }
    return trail;
  };

  const fileSelectorBreadcrumb = useMemo(() => getFileSelectorBreadcrumb(fileSelectorFolder), [fileSelectorFolder, fileRepositoryFolders]);

  const filteredRepositoryFiles = useMemo(() => {
    return repositoryFiles.filter(file => {
      const matchesFolder = fileSelectorFolder === null
        ? !file.folder_id
        : file.folder_id === fileSelectorFolder;
      const matchesSearch = !fileSelectorSearch || 
        file.file_name?.toLowerCase().includes(fileSelectorSearch.toLowerCase()) ||
        file.description?.toLowerCase().includes(fileSelectorSearch.toLowerCase());
      return matchesFolder && matchesSearch && file.file_type === 'image';
    });
  }, [repositoryFiles, fileSelectorFolder, fileSelectorSearch]);

  const fileSelectorTotalPages = Math.ceil(filteredRepositoryFiles.length / fileSelectorItemsPerPage);
  const fileSelectorStartIndex = (fileSelectorPage - 1) * fileSelectorItemsPerPage;
  const paginatedRepositoryFiles = filteredRepositoryFiles.slice(fileSelectorStartIndex, fileSelectorStartIndex + fileSelectorItemsPerPage);

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
  };

  const handleImageUpload = async (file) => {
    if (!file) return;
    setIsUploading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      updateContent('image_url', file_url);
    } catch (error) {
      console.error('Failed to upload image:', error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSelectFile = (fileUrl) => {
    updateContent('image_url', fileUrl);
    setShowFileSelector(false);
    setFileSelectorFolder(null);
    setFileSelectorSearch("");
    setFileSelectorPage(1);
  };

  const toggleFileSelectorFolder = (folderId) => {
    setFileSelectorExpandedFolders(prev => ({ ...prev, [folderId]: !prev[folderId] }));
  };

  const renderFileSelectorFolderTree = (folders, level = 0) => {
    return folders.map(folder => {
      const isExpanded = fileSelectorExpandedFolders[folder.id];
      const hasChildren = folder.children && folder.children.length > 0;
      const fileCount = repositoryFiles.filter(f => f.folder_id === folder.id && f.file_type === 'image').length;

      return (
        <div key={folder.id} style={{ marginLeft: `${level * 12}px` }}>
          <div
            className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
              fileSelectorFolder === folder.id ? 'bg-blue-100' : 'hover:bg-slate-100'
            }`}
            onClick={() => setFileSelectorFolder(folder.id)}
          >
            {hasChildren ? (
              <button
                onClick={(e) => { e.stopPropagation(); toggleFileSelectorFolder(folder.id); }}
                className="p-0.5 hover:bg-slate-200 rounded"
              >
                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
            ) : (
              <span className="w-4" />
            )}
            {isExpanded ? <FolderOpen className="w-4 h-4 text-slate-600" /> : <Folder className="w-4 h-4 text-slate-600" />}
            <span className="flex-1 text-sm">{folder.name}</span>
            <span className="text-xs text-slate-500">({fileCount})</span>
          </div>
          {hasChildren && isExpanded && renderFileSelectorFolderTree(folder.children, level + 1)}
        </div>
      );
    });
  };

  const AlignmentButtons = ({ value, onAlignChange, testIdPrefix = 'align' }) => (
    <div className="flex gap-1">
      {[
        { val: 'left', Icon: AlignLeft },
        { val: 'center', Icon: AlignCenter },
        { val: 'right', Icon: AlignRight }
      ].map(({ val, Icon }) => (
        <button
          key={val}
          type="button"
          onClick={() => onAlignChange(val)}
          data-testid={`button-${testIdPrefix}-${val}`}
          className={`p-2 rounded border ${
            value === val 
              ? 'bg-blue-600 text-white border-blue-600' 
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
          }`}
        >
          <Icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );

  const renderTypographyControls = (prefix, label) => (
    <div className="space-y-3 border-t pt-3 mt-3">
      <Label className="text-sm font-medium">{label} Typography</Label>
      
      <TypographyStyleSelector
        value={content[`${prefix}_typography_style_id`] || null}
        onChange={(styleId, style) => {
          const updates = { [`${prefix}_typography_style_id`]: styleId };
          if (style) {
            const mapped = applyTypographyStyle(style);
            if (mapped.font_family) updates[`${prefix}_font_family`] = mapped.font_family;
            if (mapped.font_size) updates[`${prefix}_font_size`] = mapped.font_size;
            if (mapped.font_size_mobile) updates[`${prefix}_font_size_mobile`] = mapped.font_size_mobile;
            if (mapped.font_weight) updates[`${prefix}_font_weight`] = mapped.font_weight;
            if (mapped.line_height) updates[`${prefix}_line_height`] = mapped.line_height;
            if (mapped.letter_spacing) updates[`${prefix}_letter_spacing`] = mapped.letter_spacing;
            if (mapped.color) updates[`${prefix}_color`] = mapped.color;
          }
          updateMultipleContent(updates);
        }}
      />

      <div className="flex items-center justify-between">
        <Label className="text-xs">Alignment</Label>
        <AlignmentButtons
          value={content[`${prefix}_align`] || 'center'}
          onAlignChange={(val) => updateContent(`${prefix}_align`, val)}
          testIdPrefix={`${prefix}-align`}
        />
      </div>

      <div>
        <Label className="text-xs mb-1 block">Text Color</Label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={safeHexColor(content[`${prefix}_color`], '#1e293b')}
            onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
            className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
          />
          <Input
            type="text"
            value={content[`${prefix}_color`] || '#1e293b'}
            onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
            className="flex-1 font-mono text-xs h-8"
            placeholder="#1e293b"
          />
        </div>
      </div>
      
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Manual Font Settings</summary>
        <div className="mt-2 space-y-2 pl-2 border-l-2 border-slate-200">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Font Family</Label>
              <select
                value={content[`${prefix}_font_family`] || 'Poppins'}
                onChange={(e) => updateContent(`${prefix}_font_family`, e.target.value)}
                className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
              >
                {fontFamilies.map(font => (
                  <option key={font} value={font}>{font}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">Weight</Label>
              <select
                value={content[`${prefix}_font_weight`] || 400}
                onChange={(e) => updateContent(`${prefix}_font_weight`, parseInt(e.target.value))}
                className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
              >
                {fontWeights.map(w => (
                  <option key={w.value} value={w.value}>{w.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Size (px)</Label>
              <Input
                type="number"
                value={content[`${prefix}_font_size`] || 16}
                onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value))}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Mobile Size (px)</Label>
              <Input
                type="number"
                value={content[`${prefix}_font_size_mobile`] || ''}
                onChange={(e) => updateContent(`${prefix}_font_size_mobile`, e.target.value ? parseInt(e.target.value) : null)}
                placeholder="Same"
                className="h-8"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Line Height</Label>
              <Input
                type="number"
                step="0.1"
                value={content[`${prefix}_line_height`] || 1.5}
                onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value))}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Letter Spacing</Label>
              <Input
                type="number"
                step="0.5"
                value={content[`${prefix}_letter_spacing`] || 0}
                onChange={(e) => updateContent(`${prefix}_letter_spacing`, parseFloat(e.target.value))}
                className="h-8"
              />
            </div>
          </div>
        </div>
      </details>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., contact-form"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-form-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Form Selection Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('formSelection')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-selection"
        >
          <span className="font-semibold text-sm">Form Selection</span>
          {expandedSections.formSelection ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.formSelection && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Select Form</Label>
              <Select
                value={content.form_slug || ''}
                onValueChange={(value) => updateContent('form_slug', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a form..." />
                </SelectTrigger>
                <SelectContent>
                  {forms.length === 0 ? (
                    <div className="p-2 text-sm text-slate-500">No active forms available</div>
                  ) : (
                    forms.map((form) => (
                      <SelectItem key={form.id} value={form.slug}>
                        {form.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-form-title"
                checked={content.show_form_title !== false}
                onChange={(e) => updateContent('show_form_title', e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="show-form-title" className="text-sm cursor-pointer">Show form title</Label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-form-description"
                checked={content.show_form_description !== false}
                onChange={(e) => updateContent('show_form_description', e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="show-form-description" className="text-sm cursor-pointer">Show form description</Label>
            </div>
          </div>
        )}
      </div>

      {/* Background Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-background"
        >
          <span className="font-semibold text-sm">Background</span>
          {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm mb-1 block">Background Type</Label>
              <select
                value={backgroundType}
                onChange={(e) => updateContent('background_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="color">Solid Color</option>
                <option value="gradient">Gradient</option>
                <option value="image">Image</option>
              </select>
            </div>

            {backgroundType === 'color' && (
              <div>
                <Label className="text-sm mb-1 block">Background Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={safeHexColor(content.background_color, '#ffffff')}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    value={content.background_color || ''}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    placeholder="transparent"
                    className="flex-1 font-mono text-sm"
                  />
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => updateContent('background_color', 'transparent')}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            )}

            {backgroundType === 'gradient' && (
              <div className="space-y-3 p-3 bg-slate-50 rounded-md">
                <div 
                  className="w-full h-16 rounded-md border border-slate-300"
                  style={{ background: gradientPreview }}
                />
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs mb-1 block">Start Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <Input
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="flex-1 font-mono text-xs h-8"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs mb-1 block">End Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <Input
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="flex-1 font-mono text-xs h-8"
                      />
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-xs mb-1 block">Angle: {content.gradient_angle || 135}°</Label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={content.gradient_angle || 135}
                    onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-slate-500 mt-1">
                    <span>0° (Right)</span>
                    <span>90° (Down)</span>
                    <span>180° (Left)</span>
                    <span>270° (Up)</span>
                  </div>
                </div>
              </div>
            )}

            {backgroundType === 'image' && (
              <div className="space-y-4">
                <div>
                  <Label className="text-sm mb-2 block">Background Image</Label>
                  {content.image_url ? (
                    <div className="relative">
                      <img 
                        src={content.image_url} 
                        alt="Background" 
                        className="w-full h-32 object-cover rounded-lg"
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        className="absolute top-2 right-2"
                        onClick={() => updateContent('image_url', '')}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center">
                      <ImageIcon className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      <div className="flex gap-2 justify-center">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setShowFileSelector(true)}
                        >
                          <ImageIcon className="w-4 h-4 mr-2" />
                          Select from Repository
                        </Button>
                        <label className="cursor-pointer">
                          <div className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
                            isUploading 
                              ? 'bg-slate-300 cursor-not-allowed' 
                              : 'bg-blue-600 hover:bg-blue-700 text-white'
                          }`}>
                            {isUploading ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Upload className="w-4 h-4" />
                            )}
                            <span>Upload</span>
                          </div>
                          <input
                            type="file"
                            className="hidden"
                            accept="image/*"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleImageUpload(file);
                              e.target.value = '';
                            }}
                            disabled={isUploading}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                {content.image_url && (
                  <>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowFileSelector(true)}
                      >
                        <ImageIcon className="w-4 h-4 mr-2" />
                        Change Image
                      </Button>
                    </div>

                    <div>
                      <Label className="text-sm mb-1 block">Image Scaling</Label>
                      <select
                        value={content.image_fit || 'cover'}
                        onChange={(e) => updateContent('image_fit', e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-md"
                      >
                        <option value="cover">Fill container (may crop)</option>
                        <option value="contain">Fit entire image (may show gaps)</option>
                      </select>
                    </div>

                    <div className="p-3 bg-slate-50 rounded-md">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={content.overlay_enabled || false}
                          onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                          className="rounded border-slate-300"
                        />
                        <span className="text-sm font-medium">Enable Overlay</span>
                      </label>
                      
                      {content.overlay_enabled && (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs mb-1 block">Overlay Color</Label>
                            <input
                              type="color"
                              value={content.overlay_color || '#000000'}
                              onChange={(e) => updateContent('overlay_color', e.target.value)}
                              className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                            />
                          </div>
                          <div>
                            <Label className="text-xs mb-1 block">Opacity (%)</Label>
                            <Input
                              type="number"
                              value={content.overlay_opacity || 50}
                              onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value))}
                              min="0"
                              max="100"
                              className="h-10"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Header Content Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('headerContent')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-header"
        >
          <span className="font-semibold text-sm">Header Content</span>
          {expandedSections.headerContent ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.headerContent && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm mb-1 block">Heading</Label>
              <div className="form-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.heading || ''}
                  onChange={(value) => updateContent('heading', value)}
                  modules={formQuillModules}
                  placeholder="Enter heading..."
                  style={{ minHeight: '80px' }}
                />
              </div>
              {renderTypographyControls('heading', 'Heading')}
            </div>

            <div>
              <Label className="text-sm mb-1 block">Subheading</Label>
              <div className="form-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.subheading || ''}
                  onChange={(value) => updateContent('subheading', value)}
                  modules={formQuillModules}
                  placeholder="Enter subheading..."
                  style={{ minHeight: '80px' }}
                />
              </div>
              {renderTypographyControls('subheading', 'Subheading')}
            </div>

            <div>
              <Label className="text-sm mb-1 block">Content Text</Label>
              <div className="form-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                <ReactQuill
                  theme="snow"
                  value={content.text_content || ''}
                  onChange={(value) => updateContent('text_content', value)}
                  modules={formQuillModules}
                  placeholder="Enter content text..."
                  style={{ minHeight: '120px' }}
                />
              </div>
              {renderTypographyControls('text_content', 'Content')}
            </div>
          </div>
        )}
      </div>

      {/* Form Fields Typography Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('formFieldsTypography')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-fields-typography"
        >
          <span className="font-semibold text-sm">Form Fields Typography</span>
          {expandedSections.formFieldsTypography ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.formFieldsTypography && (
          <div className="p-4 space-y-6">
            {/* Form Labels Typography */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-slate-700 border-b pb-2">Question Labels</h4>
              
              <TypographyStyleSelector
                value={content.form_label_typography_style_id || null}
                onChange={(styleId, style) => {
                  const updates = { form_label_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.form_label_font_family = mapped.font_family;
                    if (mapped.font_size) updates.form_label_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.form_label_font_size_mobile = mapped.font_size_mobile;
                    if (mapped.font_weight) updates.form_label_font_weight = mapped.font_weight;
                    if (mapped.line_height) updates.form_label_line_height = mapped.line_height;
                    if (mapped.letter_spacing) updates.form_label_letter_spacing = mapped.letter_spacing;
                    if (mapped.color) updates.form_label_color = mapped.color;
                  }
                  updateMultipleContent(updates);
                }}
              />

              <div>
                <Label className="text-xs mb-1 block">Label Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={safeHexColor(content.form_label_color, '#334155')}
                    onChange={(e) => updateContent('form_label_color', e.target.value)}
                    className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    type="text"
                    value={content.form_label_color || '#334155'}
                    onChange={(e) => updateContent('form_label_color', e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                    placeholder="#334155"
                  />
                </div>
              </div>
              
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Manual Font Settings</summary>
                <div className="mt-2 space-y-2 pl-2 border-l-2 border-slate-200">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Font Family</Label>
                      <select
                        value={content.form_label_font_family || 'Poppins'}
                        onChange={(e) => updateContent('form_label_font_family', e.target.value)}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontFamilies.map(font => (
                          <option key={font} value={font}>{font}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Weight</Label>
                      <select
                        value={content.form_label_font_weight || 500}
                        onChange={(e) => updateContent('form_label_font_weight', parseInt(e.target.value))}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontWeights.map(w => (
                          <option key={w.value} value={w.value}>{w.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_label_font_size || 14}
                        onChange={(e) => updateContent('form_label_font_size', parseInt(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Mobile Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_label_font_size_mobile || ''}
                        onChange={(e) => updateContent('form_label_font_size_mobile', e.target.value ? parseInt(e.target.value) : null)}
                        placeholder="Same"
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Line Height</Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={content.form_label_line_height || 1.4}
                        onChange={(e) => updateContent('form_label_line_height', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Letter Spacing</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={content.form_label_letter_spacing || 0}
                        onChange={(e) => updateContent('form_label_letter_spacing', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                  </div>
                </div>
              </details>
            </div>

            {/* Form Inputs Typography */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-slate-700 border-b pb-2">Input Fields</h4>
              
              <TypographyStyleSelector
                value={content.form_input_typography_style_id || null}
                onChange={(styleId, style) => {
                  const updates = { form_input_typography_style_id: styleId };
                  if (style) {
                    const mapped = applyTypographyStyle(style);
                    if (mapped.font_family) updates.form_input_font_family = mapped.font_family;
                    if (mapped.font_size) updates.form_input_font_size = mapped.font_size;
                    if (mapped.font_size_mobile) updates.form_input_font_size_mobile = mapped.font_size_mobile;
                    if (mapped.font_weight) updates.form_input_font_weight = mapped.font_weight;
                    if (mapped.line_height) updates.form_input_line_height = mapped.line_height;
                    if (mapped.letter_spacing) updates.form_input_letter_spacing = mapped.letter_spacing;
                    if (mapped.color) updates.form_input_color = mapped.color;
                  }
                  updateMultipleContent(updates);
                }}
              />

              <div>
                <Label className="text-xs mb-1 block">Input Text Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={safeHexColor(content.form_input_color, '#1e293b')}
                    onChange={(e) => updateContent('form_input_color', e.target.value)}
                    className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    type="text"
                    value={content.form_input_color || '#1e293b'}
                    onChange={(e) => updateContent('form_input_color', e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                    placeholder="#1e293b"
                  />
                </div>
              </div>
              
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Manual Font Settings</summary>
                <div className="mt-2 space-y-2 pl-2 border-l-2 border-slate-200">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Font Family</Label>
                      <select
                        value={content.form_input_font_family || 'Poppins'}
                        onChange={(e) => updateContent('form_input_font_family', e.target.value)}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontFamilies.map(font => (
                          <option key={font} value={font}>{font}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Weight</Label>
                      <select
                        value={content.form_input_font_weight || 400}
                        onChange={(e) => updateContent('form_input_font_weight', parseInt(e.target.value))}
                        className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                      >
                        {fontWeights.map(w => (
                          <option key={w.value} value={w.value}>{w.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_input_font_size || 14}
                        onChange={(e) => updateContent('form_input_font_size', parseInt(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Mobile Size (px)</Label>
                      <Input
                        type="number"
                        value={content.form_input_font_size_mobile || ''}
                        onChange={(e) => updateContent('form_input_font_size_mobile', e.target.value ? parseInt(e.target.value) : null)}
                        placeholder="Same"
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Line Height</Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={content.form_input_line_height || 1.5}
                        onChange={(e) => updateContent('form_input_line_height', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Letter Spacing</Label>
                      <Input
                        type="number"
                        step="0.5"
                        value={content.form_input_letter_spacing || 0}
                        onChange={(e) => updateContent('form_input_letter_spacing', parseFloat(e.target.value))}
                        className="h-8"
                      />
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}
      </div>

      {/* Appearance Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('appearance')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
          data-testid="accordion-form-appearance"
        >
          <span className="font-semibold text-sm">Layout & Spacing</span>
          {expandedSections.appearance ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.appearance && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Vertical Padding: {content.vertical_padding || 48}px</Label>
              <input
                type="range"
                min="0"
                max="120"
                value={content.vertical_padding || 48}
                onChange={(e) => updateContent('vertical_padding', parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <Label className="text-sm">Content Max Width: {content.content_max_width || 800}px</Label>
              <input
                type="range"
                min="400"
                max="1200"
                step="50"
                value={content.content_max_width || 800}
                onChange={(e) => updateContent('content_max_width', parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-sm">Default Text Alignment</Label>
              <AlignmentButtons
                value={content.text_align || 'center'}
                onAlignChange={(val) => updateContent('text_align', val)}
                testIdPrefix="form-default-align"
              />
            </div>

            {/* Card Styling */}
            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-3">Form Card Styling</h4>
              
              <div className="space-y-4">
                {/* Border Radius */}
                <div>
                  <Label className="text-sm">Border Radius: {content.card_border_radius ?? 8}px</Label>
                  <input
                    type="range"
                    min="0"
                    max="32"
                    value={content.card_border_radius ?? 8}
                    onChange={(e) => updateContent('card_border_radius', parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>

                {/* Border */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="card-border-enabled"
                      checked={content.card_border_enabled ?? true}
                      onChange={(e) => updateContent('card_border_enabled', e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="card-border-enabled" className="text-sm cursor-pointer">Enable Border</Label>
                  </div>
                  
                  {(content.card_border_enabled ?? true) && (
                    <div className="grid grid-cols-2 gap-3 pl-6">
                      <div>
                        <Label className="text-xs mb-1 block">Border Width</Label>
                        <select
                          value={content.card_border_width || 1}
                          onChange={(e) => updateContent('card_border_width', parseInt(e.target.value))}
                          className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                        >
                          <option value="1">1px</option>
                          <option value="2">2px</option>
                          <option value="3">3px</option>
                          <option value="4">4px</option>
                        </select>
                      </div>
                      <div>
                        <Label className="text-xs mb-1 block">Border Color</Label>
                        <div className="flex gap-1 items-center">
                          <input
                            type="color"
                            value={safeHexColor(content.card_border_color, '#e2e8f0')}
                            onChange={(e) => updateContent('card_border_color', e.target.value)}
                            className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                          />
                          <Input
                            value={content.card_border_color || '#e2e8f0'}
                            onChange={(e) => updateContent('card_border_color', e.target.value)}
                            className="flex-1 font-mono text-xs h-8"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Drop Shadow */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="card-shadow-enabled"
                      checked={content.card_shadow_enabled || false}
                      onChange={(e) => updateContent('card_shadow_enabled', e.target.checked)}
                      className="rounded"
                    />
                    <Label htmlFor="card-shadow-enabled" className="text-sm cursor-pointer">Enable Drop Shadow</Label>
                  </div>
                  
                  {content.card_shadow_enabled && (
                    <div className="pl-6 space-y-3">
                      <div>
                        <Label className="text-xs mb-1 block">Shadow Style</Label>
                        <select
                          value={content.card_shadow_style || 'medium'}
                          onChange={(e) => updateContent('card_shadow_style', e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-slate-300 rounded"
                        >
                          <option value="subtle">Subtle</option>
                          <option value="medium">Medium</option>
                          <option value="strong">Strong</option>
                          <option value="xl">Extra Large</option>
                        </select>
                      </div>
                      <div>
                        <Label className="text-xs mb-1 block">Shadow Color</Label>
                        <div className="flex gap-1 items-center">
                          <input
                            type="color"
                            value={safeHexColor(content.card_shadow_color, '#000000')}
                            onChange={(e) => updateContent('card_shadow_color', e.target.value)}
                            className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                          />
                          <Input
                            value={content.card_shadow_color || '#000000'}
                            onChange={(e) => updateContent('card_shadow_color', e.target.value)}
                            className="flex-1 font-mono text-xs h-8"
                          />
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs mb-1 block">Shadow Opacity: {content.card_shadow_opacity ?? 10}%</Label>
                        <input
                          type="range"
                          min="5"
                          max="50"
                          value={content.card_shadow_opacity ?? 10}
                          onChange={(e) => updateContent('card_shadow_opacity', parseInt(e.target.value))}
                          className="w-full"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Card Background Color */}
                <div>
                  <Label className="text-xs mb-1 block">Card Background Color</Label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      value={safeHexColor(content.card_background_color, '#ffffff')}
                      onChange={(e) => updateContent('card_background_color', e.target.value)}
                      className="w-10 h-8 px-1 py-1 border border-slate-300 rounded cursor-pointer"
                    />
                    <Input
                      value={content.card_background_color || '#ffffff'}
                      onChange={(e) => updateContent('card_background_color', e.target.value)}
                      className="flex-1 font-mono text-xs h-8"
                      placeholder="#ffffff"
                    />
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => updateContent('card_background_color', '')}
                      className="h-8 text-xs"
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* File Selector Dialog */}
      <Dialog open={showFileSelector} onOpenChange={() => {
        setShowFileSelector(false);
        setFileSelectorFolder(null);
        setFileSelectorExpandedFolders({});
        setFileSelectorSearch("");
        setFileSelectorPage(1);
      }}>
        <DialogContent className="max-w-6xl max-h-[90vh] grid grid-rows-[auto_1fr_auto] gap-4">
          <DialogHeader>
            <DialogTitle>Select Image from Repository</DialogTitle>
            <div className="pt-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search images..."
                  value={fileSelectorSearch}
                  onChange={(e) => setFileSelectorSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </DialogHeader>

          <div className="grid md:grid-cols-4 gap-4 py-4 overflow-hidden min-h-0">
            <div className="md:col-span-1 border-r border-slate-200 pr-4 overflow-y-auto">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Folders</h3>
              <div className="mb-3 p-2 bg-slate-50 rounded-lg">
                <button
                  onClick={() => setFileSelectorFolder(null)}
                  className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
                >
                  <Home className="w-3 h-3" />
                  Root
                </button>
                {fileSelectorBreadcrumb.map((folder, idx) => (
                  <span key={folder.id}>
                    <ChevronRight className="w-3 h-3 text-slate-400 inline-block mx-1" />
                    <button
                      onClick={() => setFileSelectorFolder(folder.id)}
                      className={`text-xs ${idx === fileSelectorBreadcrumb.length - 1 ? 'text-blue-600 font-medium' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </div>
              <div className="border border-slate-200 rounded-lg p-2 max-h-96 overflow-y-auto">
                <div
                  className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${fileSelectorFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'}`}
                  onClick={() => setFileSelectorFolder(null)}
                >
                  <FolderOpen className="w-4 h-4 text-slate-600" />
                  <span className="flex-1 text-sm font-medium">Root</span>
                  <span className="text-xs text-slate-500">({repositoryFiles.filter(f => !f.folder_id && f.file_type === 'image').length})</span>
                </div>
                {renderFileSelectorFolderTree(fileSelectorFolderHierarchy)}
              </div>
            </div>

            <div className="md:col-span-3 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3 text-sm text-slate-600">
                <span>{filteredRepositoryFiles.length} image{filteredRepositoryFiles.length !== 1 ? 's' : ''}</span>
                {fileSelectorTotalPages > 1 && <span>Page {fileSelectorPage} of {fileSelectorTotalPages}</span>}
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {filteredRepositoryFiles.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-600">No images found</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {paginatedRepositoryFiles.map((file) => (
                      <button
                        key={file.id}
                        onClick={() => handleSelectFile(file.file_url)}
                        className="text-left border-2 border-slate-200 rounded-lg hover:border-blue-500 transition-colors p-2"
                      >
                        <img src={file.file_url} alt={file.file_name} className="w-full h-32 object-cover rounded mb-2" />
                        <p className="text-sm font-medium text-slate-900 truncate">{file.file_name}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {fileSelectorTotalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-slate-200">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFileSelectorPage(p => Math.max(1, p - 1))}
                    disabled={fileSelectorPage === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm">{fileSelectorPage} / {fileSelectorTotalPages}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFileSelectorPage(p => Math.min(fileSelectorTotalPages, p + 1))}
                    disabled={fileSelectorPage === fileSelectorTotalPages}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFileSelector(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
