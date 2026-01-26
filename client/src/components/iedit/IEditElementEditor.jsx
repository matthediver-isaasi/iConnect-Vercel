import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Save, Upload, Loader2, Trash2, Eye, Monitor, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { IEditWallOfFameElementEditor } from "./elements/IEditWallOfFameElement";
import { IEditTextOverlayImageElementEditor } from "./elements/IEditTextOverlayImageElement";
import { IEditTableElementEditor } from "./elements/IEditTableElement";
import { IEditBannerCarouselElementEditor } from "./elements/IEditBannerCarouselElement";
import { IEditShowcaseElementEditor } from "./elements/IEditShowcaseElement";
import { IEditResourcesShowcaseElementEditor } from "./elements/IEditResourcesShowcaseElement";
import { IEditButtonBlockElementEditor } from "./elements/IEditButtonBlockElement";
import { IEditPageHeaderHeroElementEditor } from "./elements/IEditPageHeaderHeroElement";
import { IEditHeroElementEditor } from "./elements/IEditHeroElement";
import IEditHeroElement from "./elements/IEditHeroElement";
import { IEditOrganisationDirectoryElementEditor } from "./elements/IEditOrganisationDirectoryElement";
import { IEditTextBlockElementEditor } from "./elements/IEditTextBlockElement";
import { IEditFeaturedJobElementEditor } from "./elements/IEditFeaturedJobElement";
import { IEditImagePanelElementEditor } from "./elements/IEditImagePanelElement";
import { IEditAccordionElementEditor } from "./elements/IEditAccordionElement";
import { IEditTwoColumnElementEditor } from "./elements/IEditTwoColumnElement";
import { IEditQuoteElementEditor } from "./elements/IEditQuoteElement";
import { IEditFiftyFiftyElementEditor } from "./elements/IEditFiftyFiftyElement";
import { IEditFormElementEditor } from "./elements/IEditFormElement";
import { IEditCardDeckElementEditor } from "./elements/IEditCardDeckElement";
import { IEditLogoGridElementEditor } from "./elements/IEditLogoGridElement";
import { IEditEventSpotlightElementEditor } from "./elements/IEditEventSpotlightElement";
import { IEditCtaButtonElementEditor } from "./elements/IEditCtaButtonElement";
import { IEditImageElementEditor } from "./elements/IEditImageElement";
import { IEditImageHeroElementEditor } from "./elements/IEditImageHeroElement";
import { IEditVideoElementEditor } from "./elements/IEditVideoElement";

export default function IEditElementEditor({ element, onClose, onSave, isInlineMode = false, onChange }) {
  const [editedContent, setEditedContent] = useState(element.content || {});
  const [editedVariant, setEditedVariant] = useState(element.style_variant || 'default');
  const [editedSettings, setEditedSettings] = useState(element.settings || {});
  const [uploadingFiles, setUploadingFiles] = useState({});
  const [isExpanded, setIsExpanded] = useState(false);
  const [previewMode, setPreviewMode] = useState('desktop');
  
  const supportsLivePreview = element.element_type === 'hero';
  
  const notifyChange = (content, variant, settings) => {
    if (isInlineMode && onChange) {
      onChange({
        content: content,
        style_variant: variant,
        settings: settings
      });
    }
  };

  // Sync state when element prop changes (e.g., when reopening editor)
  useEffect(() => {
    setEditedContent(element.content || {});
    setEditedVariant(element.style_variant || 'default');
    setEditedSettings(element.settings || {});
  }, [element]);

  // Fetch template to get available variants and content schema
  const { data: template } = useQuery({
    queryKey: ['iedit-template', element.element_type],
    queryFn: async () => {
      const templates = await base44.entities.IEditElementTemplate.list() || [];
      return templates.find(t => t.element_type === element.element_type);
    }
  });

  const handleSave = () => {
    onSave({
      content: editedContent,
      style_variant: editedVariant,
      settings: editedSettings
    });
  };

  const updateContent = (key, value) => {
    const newContent = { ...editedContent, [key]: value };
    setEditedContent(newContent);
    notifyChange(newContent, editedVariant, editedSettings);
  };

  const updateSetting = (key, value) => {
    const newSettings = { ...editedSettings, [key]: value };
    setEditedSettings(newSettings);
    notifyChange(editedContent, editedVariant, newSettings);
  };
  
  const handleContentChangeFromEditor = (updatedElement) => {
    const newContent = updatedElement.content || {};
    setEditedContent(newContent);
    notifyChange(newContent, editedVariant, editedSettings);
  };

  // Handle file upload for image fields
  const handleFileUpload = async (key, file) => {
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file (JPEG, PNG, GIF, WebP, or SVG)');
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    setUploadingFiles({ ...uploadingFiles, [key]: true });

    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent(key, response.file_url);
      toast.success('Image uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload image: ' + error.message);
    } finally {
      setUploadingFiles({ ...uploadingFiles, [key]: false });
    }
  };

  // Clear uploaded image
  const handleClearImage = (key) => {
    updateContent(key, '');
  };

  // Check if this is an image hero element
  const isImageHero = element.element_type === 'image_hero';

  // Check if this is a Wall of Fame element (custom editor)
  const isWallOfFame = element.element_type === 'wall_of_fame';
  
  // Check if this is a Text Overlay Image element (custom editor)
  const isTextOverlayImage = element.element_type === 'text_overlay_image';
  
  // Check if this is a Table element (custom editor)
  const isTable = element.element_type === 'table';

  // Check if this is a Banner Carousel element (custom editor)
  const isBannerCarousel = element.element_type === 'banner_carousel';

  // Check if this is a Showcase element (custom editor)
  const isShowcase = element.element_type === 'showcase';

  // Check if this is a Resources Showcase element (custom editor)
  const isResourcesShowcase = element.element_type === 'resources_showcase';

  // Check if this is a Button Block element (custom editor)
  const isButtonBlock = element.element_type === 'button_block';

  // Check if this is a Page Header Hero element (custom editor)
  const isPageHeaderHero = element.element_type === 'page_header_hero';

  // Check if this is a Hero element (custom editor)
  const isHero = element.element_type === 'hero';

  // Check if this is an Organisation Directory element (custom editor)
  const isOrganisationDirectory = element.element_type === 'organisation_directory';

  // Check if this is a Text Block element (custom editor with rich text)
  const isTextBlock = element.element_type === 'text_block';

  // Check if this is a Featured Job element (custom editor)
  const isFeaturedJob = element.element_type === 'featured_job';

  // Check if this is an Image Panel element (custom editor)
  const isImagePanel = element.element_type === 'image_panel';

  // Check if this is an Accordion element (custom editor)
  const isAccordion = element.element_type === 'accordion';

  // Check if this is a Two Column element (custom editor)
  const isTwoColumn = element.element_type === 'two_column';

  // Check if this is a Quote element (custom editor)
  const isQuote = element.element_type === 'quote';

  // Check if this is a Fifty Fifty element (custom editor)
  const isFiftyFifty = element.element_type === 'fifty_fifty';

  // Check if this is a Form element (needs form selector)
  const isFormElement = element.element_type === 'form';

  // Check if this is a Card Deck element (custom editor)
  const isCardDeck = element.element_type === 'card_deck';

  // Check if this is a Logo Grid element (custom editor)
  const isLogoGrid = element.element_type === 'logo_grid';

  // Check if this is an Event Spotlight element (custom editor)
  const isEventSpotlight = element.element_type === 'event_spotlight';

  // Check if this is a CTA Button element (custom editor)
  const isCtaButton = element.element_type === 'cta_button';

  // Check if this is an Image element (custom editor)
  const isImage = element.element_type === 'image';

  // Check if this is a Video element (custom editor)
  const isVideo = element.element_type === 'video';

  // Fetch available forms for form element
  const { data: forms = [] } = useQuery({
    queryKey: ['forms-list'],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list() || [];
      return allForms.filter(f => f.is_active);
    },
    enabled: isFormElement
  });

  // Render form fields based on content schema
  const renderContentFields = () => {
    if (!template?.content_schema?.properties) {
      // Fallback to generic content editing
      return (
        <div className="space-y-4">
          {Object.keys(editedContent).map((key) => (
            <div key={key}>
              <Label htmlFor={key} className="capitalize">{key.replace(/_/g, ' ')}</Label>
              {typeof editedContent[key] === 'string' && editedContent[key].length > 100 ? (
                <Textarea
                  id={key}
                  value={editedContent[key]}
                  onChange={(e) => updateContent(key, e.target.value)}
                  rows={4}
                />
              ) : (
                <Input
                  id={key}
                  value={editedContent[key]}
                  onChange={(e) => updateContent(key, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      );
    }

    // Render based on schema
    const schema = template.content_schema.properties;
    return (
      <div className="space-y-4">
        {Object.entries(schema).map(([key, fieldSchema]) => {
          // Check if this is the form_slug field for form elements
          const isFormSlugField = isFormElement && key === 'form_slug';
          
          const isImageField = fieldSchema.format === 'uri' && (
            key.toLowerCase().includes('image') || 
            key.toLowerCase().includes('url') ||
            fieldSchema.title?.toLowerCase().includes('image')
          );
          const isUploading = uploadingFiles[key];

          return (
            <div key={key}>
              <Label htmlFor={key} className="capitalize">
                {fieldSchema.title || key.replace(/_/g, ' ')}
                {template.content_schema.required?.includes(key) && ' *'}
              </Label>
              {fieldSchema.description && (
                <p className="text-xs text-slate-500 mb-1">{fieldSchema.description}</p>
              )}
              
              {isFormSlugField ? (
                /* Form Selector Dropdown */
                <Select
                  value={editedContent[key] || ''}
                  onValueChange={(value) => updateContent(key, value)}
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
              ) : isImageField ? (
                /* Image Upload Field */
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      id={key}
                      type="text"
                      value={editedContent[key] || ''}
                      onChange={(e) => updateContent(key, e.target.value)}
                      placeholder="Enter image URL or upload..."
                      className="flex-1"
                    />
                    <Label htmlFor={`${key}-upload`} className="cursor-pointer">
                      <div className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                        isUploading 
                          ? 'bg-slate-300 cursor-not-allowed' 
                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                      }`}>
                        {isUploading ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Upload className="w-4 h-4" />
                        )}
                        <span className="text-sm font-medium">
                          {isUploading ? 'Uploading...' : 'Upload'}
                        </span>
                      </div>
                      <input
                        id={`${key}-upload`}
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleFileUpload(key, file);
                          e.target.value = ''; // Reset input
                        }}
                        className="hidden"
                        disabled={isUploading}
                      />
                    </Label>
                  </div>

                  {/* Image Preview */}
                  {editedContent[key] && (
                    <div className="relative mt-2 p-2 border border-slate-200 rounded-lg bg-slate-50">
                      <img
                        src={editedContent[key]}
                        alt="Preview"
                        className="w-full h-32 object-cover rounded"
                        onError={(e) => {
                          e.target.style.display = 'none';
                        }}
                      />
                      <button
                        onClick={() => handleClearImage(key)}
                        className="absolute bottom-3 right-3 p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
                        title="Remove image"
                        type="button"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              ) : fieldSchema.type === 'string' && fieldSchema.format === 'textarea' ? (
                <Textarea
                  id={key}
                  value={editedContent[key] || ''}
                  onChange={(e) => updateContent(key, e.target.value)}
                  rows={4}
                  placeholder={fieldSchema.placeholder}
                />
              ) : fieldSchema.type === 'string' && fieldSchema.enum ? (
                <Select
                  value={editedContent[key] || ''}
                  onValueChange={(value) => updateContent(key, value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    {fieldSchema.enum.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : fieldSchema.type === 'boolean' ? (
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={key}
                    checked={editedContent[key] || false}
                    onChange={(e) => updateContent(key, e.target.checked)}
                    className="w-4 h-4"
                  />
                  <Label htmlFor={key} className="cursor-pointer">
                    {fieldSchema.description || 'Enable'}
                  </Label>
                </div>
              ) : fieldSchema.type === 'number' ? (
                <Input
                  id={key}
                  type="number"
                  value={editedContent[key] || ''}
                  onChange={(e) => updateContent(key, parseFloat(e.target.value) || 0)}
                  placeholder={fieldSchema.placeholder}
                  min={fieldSchema.minimum}
                  max={fieldSchema.maximum}
                />
              ) : (
                <Input
                  id={key}
                  type="text"
                  value={editedContent[key] || ''}
                  onChange={(e) => updateContent(key, e.target.value)}
                  placeholder={fieldSchema.placeholder}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderLivePreview = () => {
    if (!supportsLivePreview) return null;
    
    const previewWidth = previewMode === 'mobile' ? '375px' : '100%';
    
    return (
      <div className="flex-1 bg-slate-100 overflow-auto flex flex-col">
        <div className="sticky top-0 z-10 bg-slate-200 p-3 border-b border-slate-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-slate-600" />
            <span className="text-sm font-medium text-slate-700">Live Preview</span>
          </div>
          <div className="flex items-center gap-1 bg-white rounded-md p-1">
            <button
              onClick={() => setPreviewMode('desktop')}
              className={`p-1.5 rounded ${previewMode === 'desktop' ? 'bg-blue-100 text-blue-600' : 'text-slate-500 hover:bg-slate-100'}`}
              title="Desktop view"
              data-testid="button-preview-desktop"
            >
              <Monitor className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPreviewMode('mobile')}
              className={`p-1.5 rounded ${previewMode === 'mobile' ? 'bg-blue-100 text-blue-600' : 'text-slate-500 hover:bg-slate-100'}`}
              title="Mobile view"
              data-testid="button-preview-mobile"
            >
              <Smartphone className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 p-4 overflow-auto flex justify-center">
          <div 
            className="bg-white shadow-lg rounded-lg overflow-hidden transition-all"
            style={{ 
              width: previewWidth,
              maxWidth: '100%'
            }}
          >
            {element.element_type === 'hero' && (
              <IEditHeroElement 
                content={editedContent} 
                variant={editedVariant}
                settings={editedSettings}
              />
            )}
          </div>
        </div>
      </div>
    );
  };

  const editorPanelWidth = supportsLivePreview 
    ? (isExpanded ? 'w-[500px]' : 'w-96') 
    : (isExpanded ? 'w-[calc(100%-4rem)]' : 'w-96');

  if (isInlineMode) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {template?.available_variants && template.available_variants.length > 1 && (
            <div>
              <Label htmlFor="variant">Style Variant</Label>
              <Select value={editedVariant} onValueChange={(value) => {
                setEditedVariant(value);
                notifyChange(editedContent, value, editedSettings);
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {template.available_variants.map((variant) => (
                    <SelectItem key={variant} value={variant}>
                      {variant}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <h3 className="font-semibold text-slate-900 mb-4">Content</h3>
            {isWallOfFame ? (
              <IEditWallOfFameElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isTextOverlayImage ? (
              <IEditTextOverlayImageElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isTable ? (
              <IEditTableElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isBannerCarousel ? (
              <IEditBannerCarouselElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isShowcase ? (
              <IEditShowcaseElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isResourcesShowcase ? (
              <IEditResourcesShowcaseElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isButtonBlock ? (
              <IEditButtonBlockElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isPageHeaderHero ? (
              <IEditPageHeaderHeroElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isHero ? (
              <IEditHeroElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isOrganisationDirectory ? (
              <IEditOrganisationDirectoryElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isFeaturedJob ? (
              <IEditFeaturedJobElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isImagePanel ? (
              <IEditImagePanelElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isAccordion ? (
              <IEditAccordionElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isTwoColumn ? (
              <IEditTwoColumnElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isQuote ? (
              <IEditQuoteElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isFiftyFifty ? (
              <IEditFiftyFiftyElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isFormElement ? (
              <IEditFormElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isCardDeck ? (
              <IEditCardDeckElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isLogoGrid ? (
              <IEditLogoGridElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isEventSpotlight ? (
              <IEditEventSpotlightElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isCtaButton ? (
              <IEditCtaButtonElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isImage ? (
              <IEditImageElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isImageHero ? (
              <IEditImageHeroElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isTextBlock ? (
              <IEditTextBlockElementEditor element={{ ...element, content: editedContent }} onChange={handleContentChangeFromEditor} />
            ) : isVideo ? (
              <IEditVideoElementEditor 
                element={{ ...element, content: editedContent }} 
                editedContent={editedContent}
                setEditedContent={setEditedContent}
                editedSettings={editedSettings}
                setEditedSettings={setEditedSettings}
                updateContent={updateContent}
                updateSetting={updateSetting}
              />
            ) : (
              renderContentFields()
            )}
          </div>

          <div>
            <h3 className="font-semibold text-slate-900 mb-4">Settings</h3>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="fullWidth"
                  checked={editedSettings.fullWidth || false}
                  onChange={(e) => updateSetting('fullWidth', e.target.checked)}
                  className="w-4 h-4"
                />
                <Label htmlFor="fullWidth" className="cursor-pointer">
                  Full Width
                </Label>
              </div>

              <div className="space-y-3">
                <div>
                  <Label htmlFor="paddingTop">Padding Top (px)</Label>
                  <Input
                    id="paddingTop"
                    type="number"
                    value={editedSettings.paddingTop ?? 32}
                    onChange={(e) => updateSetting('paddingTop', parseInt(e.target.value) || 0)}
                    min="0"
                    max="200"
                  />
                </div>
                <div>
                  <Label htmlFor="paddingBottom">Padding Bottom (px)</Label>
                  <Input
                    id="paddingBottom"
                    type="number"
                    value={editedSettings.paddingBottom ?? 32}
                    onChange={(e) => updateSetting('paddingBottom', parseInt(e.target.value) || 0)}
                    min="0"
                    max="200"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`fixed inset-y-0 right-0 bg-white border-l border-slate-200 shadow-xl z-50 flex transition-all ${
      supportsLivePreview ? 'w-[calc(100%-4rem)]' : (isExpanded ? 'w-[calc(100%-4rem)]' : 'w-96')
    }`}>
      {supportsLivePreview && renderLivePreview()}
      
      <div className={`flex flex-col ${supportsLivePreview ? editorPanelWidth : 'flex-1'} border-l border-slate-200 bg-white`}>
        {/* Header */}
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-bold text-slate-900">Edit Element</h2>
            <div className="flex items-center gap-2">
              {supportsLivePreview && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => setIsExpanded(!isExpanded)}
                  title={isExpanded ? "Narrow editor" : "Widen editor"}
                >
                  {isExpanded ? '←' : '→'}
                </Button>
              )}
              {!supportsLivePreview && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => setIsExpanded(!isExpanded)}
                  title={isExpanded ? "Collapse" : "Expand"}
                >
                  {isExpanded ? '←' : '→'}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-editor">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-sm text-slate-600 capitalize">
              {element.element_type.replace(/_/g, ' ')}
            </p>
            {supportsLivePreview && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">
                <Eye className="w-3 h-3" />
                Live Preview
              </span>
            )}
          </div>
        </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Style Variant */}
        {template?.available_variants && template.available_variants.length > 1 && (
          <div>
            <Label htmlFor="variant">Style Variant</Label>
            <Select value={editedVariant} onValueChange={(value) => {
              setEditedVariant(value);
              notifyChange(editedContent, value, editedSettings);
            }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {template.available_variants.map((variant) => (
                  <SelectItem key={variant} value={variant}>
                    {variant}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Content Fields */}
        <div>
          <h3 className="font-semibold text-slate-900 mb-4">Content</h3>
          {isWallOfFame ? (
            <IEditWallOfFameElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isTextOverlayImage ? (
            <IEditTextOverlayImageElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isTable ? (
            <IEditTableElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isBannerCarousel ? (
            <IEditBannerCarouselElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isShowcase ? (
            <IEditShowcaseElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isResourcesShowcase ? (
            <IEditResourcesShowcaseElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isButtonBlock ? (
            <IEditButtonBlockElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isPageHeaderHero ? (
            <IEditPageHeaderHeroElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isHero ? (
            <IEditHeroElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isOrganisationDirectory ? (
            <IEditOrganisationDirectoryElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isFeaturedJob ? (
            <IEditFeaturedJobElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isImagePanel ? (
            <IEditImagePanelElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isAccordion ? (
            <IEditAccordionElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isTwoColumn ? (
            <IEditTwoColumnElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isQuote ? (
            <IEditQuoteElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isFiftyFifty ? (
            <IEditFiftyFiftyElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isFormElement ? (
            <IEditFormElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isCardDeck ? (
            <IEditCardDeckElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isLogoGrid ? (
            <IEditLogoGridElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isEventSpotlight ? (
            <IEditEventSpotlightElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isCtaButton ? (
            <IEditCtaButtonElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isImage ? (
            <IEditImageElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isImageHero ? (
            <IEditImageHeroElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : isTextBlock ? (
            <IEditTextBlockElementEditor 
              element={{ ...element, content: editedContent }}
              onChange={handleContentChangeFromEditor}
            />
          ) : (
            renderContentFields()
          )}
        </div>

        {/* Common Settings */}
        <div>
          <h3 className="font-semibold text-slate-900 mb-4">Settings</h3>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="fullWidth"
                checked={editedSettings.fullWidth || false}
                onChange={(e) => updateSetting('fullWidth', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="fullWidth" className="cursor-pointer">
                Full Width
              </Label>
            </div>

            {isImageHero && editedSettings.fullWidth && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-blue-700">
                  <strong>Full Width Mode:</strong> Height is automatically determined by the background image's aspect ratio. The "Hero Height" setting is not used.
                </p>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <Label htmlFor="paddingTop">Padding Top (px)</Label>
                <Input
                  id="paddingTop"
                  type="number"
                  value={editedSettings.paddingTop ?? 32}
                  onChange={(e) => updateSetting('paddingTop', parseInt(e.target.value) || 0)}
                  min="0"
                  max="200"
                />
              </div>
              <div>
                <Label htmlFor="paddingBottom">Padding Bottom (px)</Label>
                <Input
                  id="paddingBottom"
                  type="number"
                  value={editedSettings.paddingBottom ?? 32}
                  onChange={(e) => updateSetting('paddingBottom', parseInt(e.target.value) || 0)}
                  min="0"
                  max="200"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer - hide in inline mode since parent handles save/cancel */}
      {!isInlineMode && (
        <div className="p-6 border-t border-slate-200">
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1" data-testid="button-cancel-edit">
              Cancel
            </Button>
            <Button 
              onClick={handleSave} 
              className="flex-1 bg-blue-600 hover:bg-blue-700"
              disabled={Object.values(uploadingFiles).some(v => v)}
              data-testid="button-save-element"
            >
              <Save className="w-4 h-4 mr-2" />
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}