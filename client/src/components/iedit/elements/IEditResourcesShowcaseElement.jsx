import React from "react";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Upload, Loader2, Trash2, FileText, ArrowRight, Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import AGCASButton from "@/components/ui/AGCASButton";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

export function IEditResourcesShowcaseElementEditor({ element, onChange }) {
  const [isUploadingBg, setIsUploadingBg] = React.useState(false);
  
  const defaultContent = {
    headerText: '',
    subheaderText: '',
    descriptionText: '',
    heading_font_family: 'Poppins',
    heading_font_size: 48,
    heading_letter_spacing: 0,
    heading_color: '#0f172a',
    heading_underline_enabled: false,
    heading_underline_color: '#000000',
    heading_underline_width: 100,
    heading_underline_weight: 2,
    heading_underline_spacing: 16,
    heading_underline_to_content_spacing: 24,
    heading_underline_alignment: 'left',
    subheading_font_family: 'Poppins',
    subheading_font_size: 24,
    subheading_color: '#475569',
    description_font_family: 'Poppins',
    description_font_size: 16,
    description_color: '#64748b',
    description_line_height: 1.6,
    button_text: 'Learn More',
    button_link: '',
    button_style_id: '',
    button_custom_bg_color: '',
    button_custom_text_color: '',
    button_custom_border_color: '',
    button_size: 'default',
    button_show_arrow: true,
    backgroundImage: '',
    backgroundColor: '#ffffff',
    cardBorderRadius: 8,
    first_column_right_padding: 0,
    showResourceDescription: true,
    resourceTitleFontSize: 20,
    showCTAButton: true,
    ctaButtonSize: 48,
    ctaButtonBgColor: '#2563eb',
    ctaButtonIconColor: '#ffffff',
    ctaButtonMargin: 16,
    resourceIds: ['', '', '', '']
  };
  
  const [content, setContent] = React.useState({ ...defaultContent, ...(element.content || {}) });

  // Fetch available resources
  const { data: resources = [] } = useQuery({
    queryKey: ['resources-list'],
    queryFn: () => base44.entities.Resource.list('-release_date')
  });

  // Fetch button styles
  const { data: buttonStyles = [] } = useQuery({
    queryKey: ['button-styles'],
    queryFn: () => base44.entities.ButtonStyle.list()
  });

  const updateContent = (key, value) => {
    const newContent = { ...content, [key]: value };
    setContent(newContent);
    onChange({ ...element, content: newContent });
  };

  const updateResourceId = (index, value) => {
    const newResourceIds = Array.isArray(content.resourceIds) ? [...content.resourceIds] : ['', '', '', ''];
    newResourceIds[index] = value;
    updateContent('resourceIds', newResourceIds);
  };

  const handleBgImageUpload = async (file) => {
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    setIsUploadingBg(true);

    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent('backgroundImage', response.file_url);
      toast.success('Image uploaded');
    } catch (error) {
      toast.error('Upload failed: ' + error.message);
    } finally {
      setIsUploadingBg(false);
    }
  };

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
          placeholder="e.g., resources-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-resourcesshowcase-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      <div>
        <Label htmlFor="headerText">Header Text</Label>
        <Input
          id="headerText"
          value={content.headerText || ''}
          onChange={(e) => updateContent('headerText', e.target.value)}
          placeholder="Main heading"
        />
      </div>

      <TypographyStyleSelector
        value={content.heading_typography_style_id}
        onChange={(styleId) => updateContent('heading_typography_style_id', styleId)}
        onApplyStyle={(style) => {
          const mapped = applyTypographyStyle(style);
          if (mapped.font_family) updateContent('heading_font_family', mapped.font_family);
          if (mapped.font_size) updateContent('heading_font_size', mapped.font_size);
          if (mapped.font_size_mobile) updateContent('heading_font_size_mobile', mapped.font_size_mobile);
          if (mapped.letter_spacing !== undefined) updateContent('heading_letter_spacing', mapped.letter_spacing);
          if (mapped.color) updateContent('heading_color', mapped.color);
        }}
        filterTypes={['h1', 'h2']}
        label="Heading Typography Style"
      />

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="heading_font_family">Heading Font</Label>
              <Select
                value={content.heading_font_family || 'Poppins'}
                onValueChange={(value) => updateContent('heading_font_family', value)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Poppins">Poppins</SelectItem>
                  <SelectItem value="Degular Medium">Degular Medium</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="heading_font_size">Heading Size (px)</Label>
              <Input
                id="heading_font_size"
                type="number"
                value={content.heading_font_size || 48}
                onChange={(e) => updateContent('heading_font_size', parseInt(e.target.value) || 48)}
                min="12"
                max="200"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="heading_letter_spacing">Letter Spacing (px)</Label>
              <Input
                id="heading_letter_spacing"
                type="number"
                step="0.5"
                value={content.heading_letter_spacing || 0}
                onChange={(e) => updateContent('heading_letter_spacing', parseFloat(e.target.value) || 0)}
                min="-5"
                max="20"
              />
            </div>
            <div>
              <Label htmlFor="heading_color">Heading Color</Label>
              <input
                id="heading_color"
                type="color"
                value={content.heading_color || '#0f172a'}
                onChange={(e) => updateContent('heading_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
          </div>
        </div>
      </details>

      <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="heading_underline_enabled"
            checked={content.heading_underline_enabled || false}
            onChange={(e) => updateContent('heading_underline_enabled', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="heading_underline_enabled" className="cursor-pointer">
            Show line below heading
          </Label>
        </div>

        {content.heading_underline_enabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="heading_underline_color">Line Color</Label>
                <input
                  id="heading_underline_color"
                  type="color"
                  value={content.heading_underline_color || '#000000'}
                  onChange={(e) => updateContent('heading_underline_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
              <div>
                <Label htmlFor="heading_underline_width">Line Width (px)</Label>
                <Input
                  id="heading_underline_width"
                  type="number"
                  value={content.heading_underline_width || 100}
                  onChange={(e) => updateContent('heading_underline_width', parseInt(e.target.value) || 0)}
                  min="10"
                  max="1000"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="heading_underline_weight">Weight (px)</Label>
                <Input
                  id="heading_underline_weight"
                  type="number"
                  value={content.heading_underline_weight || 2}
                  onChange={(e) => updateContent('heading_underline_weight', parseInt(e.target.value) || 1)}
                  min="1"
                  max="20"
                />
              </div>
              <div>
                <Label htmlFor="heading_underline_spacing">Spacing (px)</Label>
                <Input
                  id="heading_underline_spacing"
                  type="number"
                  value={content.heading_underline_spacing || 16}
                  onChange={(e) => updateContent('heading_underline_spacing', parseInt(e.target.value) || 0)}
                  min="0"
                  max="100"
                />
              </div>
              <div>
                <Label htmlFor="heading_underline_to_content_spacing">To Content (px)</Label>
                <Input
                  id="heading_underline_to_content_spacing"
                  type="number"
                  value={content.heading_underline_to_content_spacing || 24}
                  onChange={(e) => updateContent('heading_underline_to_content_spacing', parseInt(e.target.value) || 0)}
                  min="0"
                  max="100"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="heading_underline_alignment">Line Alignment</Label>
              <Select
                value={content.heading_underline_alignment || 'left'}
                onValueChange={(value) => updateContent('heading_underline_alignment', value)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">Left</SelectItem>
                  <SelectItem value="center">Center</SelectItem>
                  <SelectItem value="right">Right</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      <div>
        <Label htmlFor="subheaderText">Subheader Text</Label>
        <Input
          id="subheaderText"
          value={content.subheaderText || ''}
          onChange={(e) => updateContent('subheaderText', e.target.value)}
          placeholder="Subheading"
        />
      </div>

      <TypographyStyleSelector
        value={content.subheading_typography_style_id}
        onChange={(styleId) => updateContent('subheading_typography_style_id', styleId)}
        onApplyStyle={(style) => {
          const mapped = applyTypographyStyle(style);
          if (mapped.font_family) updateContent('subheading_font_family', mapped.font_family);
          if (mapped.font_size) updateContent('subheading_font_size', mapped.font_size);
          if (mapped.font_size_mobile) updateContent('subheading_font_size_mobile', mapped.font_size_mobile);
          if (mapped.color) updateContent('subheading_color', mapped.color);
        }}
        filterTypes={['h3', 'h4']}
        label="Subheading Typography Style"
      />

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="subheading_font_family">Subheader Font</Label>
              <Select
                value={content.subheading_font_family || 'Poppins'}
                onValueChange={(value) => updateContent('subheading_font_family', value)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Poppins">Poppins</SelectItem>
                  <SelectItem value="Degular Medium">Degular Medium</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="subheading_font_size">Size (px)</Label>
              <Input
                id="subheading_font_size"
                type="number"
                value={content.subheading_font_size || 24}
                onChange={(e) => updateContent('subheading_font_size', parseInt(e.target.value) || 24)}
                min="12"
                max="100"
              />
            </div>
            <div>
              <Label htmlFor="subheading_color">Color</Label>
              <input
                id="subheading_color"
                type="color"
                value={content.subheading_color || '#475569'}
                onChange={(e) => updateContent('subheading_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
          </div>
        </div>
      </details>

      <div>
        <Label htmlFor="descriptionText">Description Text</Label>
        <Textarea
          id="descriptionText"
          value={content.descriptionText || ''}
          onChange={(e) => updateContent('descriptionText', e.target.value)}
          placeholder="Description text"
          rows={3}
        />
      </div>

      <TypographyStyleSelector
        value={content.description_typography_style_id}
        onChange={(styleId) => updateContent('description_typography_style_id', styleId)}
        onApplyStyle={(style) => {
          const mapped = applyTypographyStyle(style);
          if (mapped.font_family) updateContent('description_font_family', mapped.font_family);
          if (mapped.font_size) updateContent('description_font_size', mapped.font_size);
          if (mapped.font_size_mobile) updateContent('description_font_size_mobile', mapped.font_size_mobile);
          if (mapped.color) updateContent('description_color', mapped.color);
          if (mapped.line_height) updateContent('description_line_height', mapped.line_height);
        }}
        filterTypes={['paragraph']}
        label="Description Typography Style"
      />

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <Label htmlFor="description_font_family">Description Font</Label>
              <Select
                value={content.description_font_family || 'Poppins'}
                onValueChange={(value) => updateContent('description_font_family', value)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Poppins">Poppins</SelectItem>
                  <SelectItem value="Degular Medium">Degular Medium</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="description_font_size">Size (px)</Label>
              <Input
                id="description_font_size"
                type="number"
                value={content.description_font_size || 16}
                onChange={(e) => updateContent('description_font_size', parseInt(e.target.value) || 16)}
                min="12"
                max="100"
              />
            </div>
            <div>
              <Label htmlFor="description_line_height">Line Height</Label>
              <Input
                id="description_line_height"
                type="number"
                step="0.1"
                value={content.description_line_height || 1.6}
                onChange={(e) => updateContent('description_line_height', parseFloat(e.target.value) || 1.6)}
                min="1"
                max="3"
              />
            </div>
            <div>
              <Label htmlFor="description_color">Color</Label>
              <input
                id="description_color"
                type="color"
                value={content.description_color || '#64748b'}
                onChange={(e) => updateContent('description_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
          </div>
        </div>
      </details>

      <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
        <h4 className="font-medium text-sm">CTA Button</h4>
        
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="button_text">Button Text</Label>
            <Input
              id="button_text"
              value={content.button_text || ''}
              onChange={(e) => updateContent('button_text', e.target.value)}
              placeholder="Button text"
            />
          </div>
          <div>
            <Label htmlFor="button_link">Button Link</Label>
            <Input
              id="button_link"
              value={content.button_link || ''}
              onChange={(e) => updateContent('button_link', e.target.value)}
              placeholder="URL or page name"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="button_style_id">Button Style</Label>
          <Select
            value={content.button_style_id || ''}
            onValueChange={(value) => updateContent('button_style_id', value)}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select a style..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={null}>No Style (Use Custom Colors)</SelectItem>
              {buttonStyles.map((style) => (
                <SelectItem key={style.id} value={style.id}>
                  {style.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="button_transparent_bg"
              checked={content.button_custom_bg_color === 'transparent'}
              onChange={(e) => updateContent('button_custom_bg_color', e.target.checked ? 'transparent' : '#2563eb')}
              className="w-4 h-4"
            />
            <Label htmlFor="button_transparent_bg" className="cursor-pointer">
              Transparent Background
            </Label>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="button_custom_bg_color">Custom Background</Label>
              <input
                id="button_custom_bg_color"
                type="color"
                value={content.button_custom_bg_color === 'transparent' ? '#2563eb' : (content.button_custom_bg_color || '#2563eb')}
                onChange={(e) => updateContent('button_custom_bg_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                disabled={content.button_custom_bg_color === 'transparent'}
              />
            </div>
            <div>
              <Label htmlFor="button_custom_text_color">Custom Text</Label>
              <input
                id="button_custom_text_color"
                type="color"
                value={content.button_custom_text_color || '#ffffff'}
                onChange={(e) => updateContent('button_custom_text_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
            <div>
              <Label htmlFor="button_custom_border_color">Custom Border</Label>
              <input
                id="button_custom_border_color"
                type="color"
                value={content.button_custom_border_color || '#2563eb'}
                onChange={(e) => updateContent('button_custom_border_color', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="button_size">Button Size</Label>
            <Select
              value={content.button_size || 'default'}
              onValueChange={(value) => updateContent('button_size', value)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sm">Small</SelectItem>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="lg">Large</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="button_show_arrow"
                checked={content.button_show_arrow ?? true}
                onChange={(e) => updateContent('button_show_arrow', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="button_show_arrow" className="cursor-pointer">
                Show Arrow
              </Label>
            </div>
          </div>
        </div>
      </div>

      <div>
        <Label>Select Resources (up to 4)</Label>
        <div className="space-y-2 mt-2">
          {[0, 1, 2, 3].map((index) => (
            <Select
              key={index}
              value={(Array.isArray(content.resourceIds) && content.resourceIds[index]) || ''}
              onValueChange={(value) => updateResourceId(index, value)}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={`Resource ${index + 1} (optional)`} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={null}>None</SelectItem>
                {resources.map((resource) => (
                  <SelectItem key={resource.id} value={resource.id}>
                    {resource.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
        </div>
      </div>

      <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="gradient_enabled"
            checked={content.gradient_enabled || false}
            onChange={(e) => updateContent('gradient_enabled', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="gradient_enabled" className="cursor-pointer">
            Use Gradient Background
          </Label>
        </div>

        {content.gradient_enabled ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="gradient_start_color">Start Color</Label>
                <input
                  id="gradient_start_color"
                  type="color"
                  value={content.gradient_start_color || '#3b82f6'}
                  onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
              <div>
                <Label htmlFor="gradient_end_color">End Color</Label>
                <input
                  id="gradient_end_color"
                  type="color"
                  value={content.gradient_end_color || '#8b5cf6'}
                  onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="gradient_angle">Angle (degrees)</Label>
              <Input
                id="gradient_angle"
                type="number"
                value={content.gradient_angle || 135}
                onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value) || 0)}
                min="0"
                max="360"
              />
            </div>
          </>
        ) : (
          <div>
            <Label htmlFor="backgroundColor">Background Color</Label>
            <div className="flex gap-2">
              <input
                id="backgroundColor"
                type="color"
                value={content.backgroundColor || '#ffffff'}
                onChange={(e) => updateContent('backgroundColor', e.target.value)}
                className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <Input
                value={content.backgroundColor || '#ffffff'}
                onChange={(e) => updateContent('backgroundColor', e.target.value)}
                placeholder="#ffffff"
                className="flex-1"
              />
            </div>
          </div>
        )}
      </div>

      <div>
        <Label htmlFor="cardBorderRadius">Card Border Radius (px)</Label>
        <Input
          id="cardBorderRadius"
          type="number"
          value={content.cardBorderRadius ?? 8}
          onChange={(e) => {
            const val = e.target.value === '' ? 0 : parseInt(e.target.value);
            updateContent('cardBorderRadius', isNaN(val) ? 0 : val);
          }}
          min="0"
          max="50"
        />
      </div>

      <div>
        <Label htmlFor="first_column_right_padding">First Column Right Padding (px)</Label>
        <Input
          id="first_column_right_padding"
          type="number"
          value={content.first_column_right_padding ?? 0}
          onChange={(e) => updateContent('first_column_right_padding', parseInt(e.target.value) || 0)}
          min="0"
          max="200"
        />
      </div>

      <div>
        <Label htmlFor="resourceTitleFontSize">Resource Title Font Size (px)</Label>
        <Input
          id="resourceTitleFontSize"
          type="number"
          value={content.resourceTitleFontSize ?? 20}
          onChange={(e) => updateContent('resourceTitleFontSize', parseInt(e.target.value) || 20)}
          min="12"
          max="60"
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="showResourceDescription"
          checked={content.showResourceDescription ?? true}
          onChange={(e) => updateContent('showResourceDescription', e.target.checked)}
          className="w-4 h-4"
        />
        <Label htmlFor="showResourceDescription" className="cursor-pointer">
          Show Resource Description
        </Label>
      </div>

      <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showCTAButton"
            checked={content.showCTAButton ?? true}
            onChange={(e) => updateContent('showCTAButton', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showCTAButton" className="cursor-pointer">
            Show CTA Button on Cards
          </Label>
        </div>

        {content.showCTAButton !== false && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ctaButtonSize">Button Size (px)</Label>
                <Input
                  id="ctaButtonSize"
                  type="number"
                  value={content.ctaButtonSize || 48}
                  onChange={(e) => updateContent('ctaButtonSize', parseInt(e.target.value) || 48)}
                  min="24"
                  max="80"
                />
              </div>
              <div>
                <Label htmlFor="ctaButtonMargin">Margin (px)</Label>
                <Input
                  id="ctaButtonMargin"
                  type="number"
                  value={content.ctaButtonMargin ?? 16}
                  onChange={(e) => updateContent('ctaButtonMargin', parseInt(e.target.value) ?? 0)}
                  min="0"
                  max="50"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ctaButtonBgColor">Background</Label>
                <input
                  id="ctaButtonBgColor"
                  type="color"
                  value={content.ctaButtonBgColor || '#2563eb'}
                  onChange={(e) => updateContent('ctaButtonBgColor', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
              <div>
                <Label htmlFor="ctaButtonIconColor">Icon Color</Label>
                <input
                  id="ctaButtonIconColor"
                  type="color"
                  value={content.ctaButtonIconColor || '#ffffff'}
                  onChange={(e) => updateContent('ctaButtonIconColor', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div>
        <Label htmlFor="backgroundImage">Background Image</Label>
        <div className="flex gap-2">
          <Input
            id="backgroundImage"
            value={content.backgroundImage || ''}
            onChange={(e) => updateContent('backgroundImage', e.target.value)}
            placeholder="Background image URL"
            className="flex-1"
          />
          <Label htmlFor="bg-upload" className="cursor-pointer">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
              isUploadingBg
                ? 'bg-slate-300 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}>
              {isUploadingBg ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
            </div>
            <input
              id="bg-upload"
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleBgImageUpload(file);
                e.target.value = '';
              }}
              className="hidden"
              disabled={isUploadingBg}
            />
          </Label>
          {content.backgroundImage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateContent('backgroundImage', '')}
              className="text-red-600"
              type="button"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
        {content.backgroundImage && (
          <img
            src={content.backgroundImage}
            alt="Background preview"
            className="mt-2 w-full h-32 object-cover rounded"
          />
        )}
      </div>
    </div>
  );
}

export function IEditResourcesShowcaseElementRenderer({ element, settings }) {
  const defaultContent = {
    headerText: '',
    subheaderText: '',
    descriptionText: '',
    heading_font_family: 'Poppins',
    heading_font_size: 48,
    heading_letter_spacing: 0,
    heading_color: '#0f172a',
    heading_underline_enabled: false,
    heading_underline_color: '#000000',
    heading_underline_width: 100,
    heading_underline_weight: 2,
    heading_underline_spacing: 16,
    heading_underline_to_content_spacing: 24,
    heading_underline_alignment: 'left',
    subheading_font_family: 'Poppins',
    subheading_font_size: 24,
    subheading_color: '#475569',
    description_font_family: 'Poppins',
    description_font_size: 16,
    description_color: '#64748b',
    description_line_height: 1.6,
    button_text: 'Learn More',
    button_link: '',
    button_style_id: '',
    button_custom_bg_color: '',
    button_custom_text_color: '',
    button_custom_border_color: '',
    button_size: 'default',
    button_show_arrow: true,
    backgroundImage: '',
    backgroundColor: '#ffffff',
    gradient_enabled: false,
    gradient_start_color: '#3b82f6',
    gradient_end_color: '#8b5cf6',
    gradient_angle: 135,
    cardBorderRadius: 8,
    first_column_right_padding: 0,
    showResourceDescription: true,
    resourceTitleFontSize: 20,
    showCTAButton: true,
    ctaButtonSize: 48,
    ctaButtonBgColor: '#2563eb',
    ctaButtonIconColor: '#ffffff',
    ctaButtonMargin: 16,
    resourceIds: ['', '', '', '']
  };
  
  const content = { ...defaultContent, ...(element.content || {}) };

  const fullWidth = settings?.fullWidth;

  // Fetch selected resources
  const { data: allResources = [] } = useQuery({
    queryKey: ['resources-showcase'],
    queryFn: () => base44.entities.Resource.list('-release_date'),
    enabled: Array.isArray(content.resourceIds) && content.resourceIds.some(id => id)
  });

  const selectedResources = React.useMemo(() => {
    if (!Array.isArray(content.resourceIds)) return [];
    return content.resourceIds
      .map(id => id ? allResources.find(r => r.id === id) : null)
      .filter(Boolean);
  }, [content.resourceIds, allResources]);

  const sectionStyle = content.gradient_enabled ? {
    background: `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`,
    ...(content.backgroundImage && {
      backgroundImage: `url(${content.backgroundImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    })
  } : {
    backgroundColor: content.backgroundColor || '#ffffff',
    ...(content.backgroundImage && {
      backgroundImage: `url(${content.backgroundImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    })
  };

  const backgroundWrapperClass = fullWidth ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]' : 'w-full';

  const { anchor } = content;

  return (
    <div id={anchor || undefined} className={`${backgroundWrapperClass} py-16 relative`} style={sectionStyle}>
      <div className="max-w-7xl mx-auto px-4 relative z-10">
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Left Column - Content */}
          <div 
            className="lg:col-span-1"
            style={{ paddingRight: `${content.first_column_right_padding || 0}px` }}
          >
            {content.headerText && (
              <div>
                <h2 
                  style={{ 
                    fontWeight: 'bold', 
                    fontFamily: content.heading_font_family || 'Poppins',
                    fontSize: `${content.heading_font_size || 48}px`,
                    letterSpacing: `${content.heading_letter_spacing || 0}px`,
                    marginBottom: content.heading_underline_enabled ? `${content.heading_underline_spacing || 16}px` : '24px',
                    color: content.heading_color || '#0f172a'
                  }}
                >
                  {content.headerText}
                </h2>
                {content.heading_underline_enabled && (
                  <div 
                    style={{
                      width: `${content.heading_underline_width || 100}px`,
                      height: `${content.heading_underline_weight || 2}px`,
                      backgroundColor: content.heading_underline_color || '#000000',
                      marginLeft: (content.heading_underline_alignment || 'left') === 'center' ? 'auto' : (content.heading_underline_alignment || 'left') === 'right' ? 'auto' : '0',
                      marginRight: (content.heading_underline_alignment || 'left') === 'center' ? 'auto' : '0',
                      marginBottom: `${content.heading_underline_to_content_spacing || 24}px`,
                      display: 'block'
                    }}
                  />
                )}
              </div>
            )}

            {content.subheaderText && (
              <h3 
                style={{ 
                  fontFamily: content.subheading_font_family || 'Poppins',
                  fontSize: `${content.subheading_font_size || 24}px`,
                  fontWeight: '600',
                  color: content.subheading_color || '#475569',
                  marginBottom: '16px'
                }}
              >
                {content.subheaderText}
              </h3>
            )}

            {content.descriptionText && (
              <p 
                style={{ 
                  fontFamily: content.description_font_family || 'Poppins',
                  fontSize: `${content.description_font_size || 16}px`,
                  lineHeight: content.description_line_height || 1.6,
                  color: content.description_color || '#64748b',
                  marginBottom: '24px'
                }}
              >
                {content.descriptionText}
              </p>
            )}

            {content.button_text && (
              <AGCASButton
                text={content.button_text}
                link={content.button_link}
                buttonStyleId={content.button_style_id}
                customBgColor={content.button_custom_bg_color}
                customTextColor={content.button_custom_text_color}
                customBorderColor={content.button_custom_border_color}
                size={content.button_size}
                showArrow={content.button_show_arrow}
              />
            )}
          </div>

          {/* Right Columns - Resources */}
          <div className="lg:col-span-2">
            {selectedResources.length === 0 ? (
              <div className="text-center py-12 bg-white/90 rounded-lg">
                <FileText className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                <p className="text-slate-500">No resources selected</p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-6">
                {selectedResources.map((resource) => (
                  <a
                    key={resource.id}
                    href={resource.target_url}
                    target={resource.open_in_new_tab ? '_blank' : '_self'}
                    rel={resource.open_in_new_tab ? 'noopener noreferrer' : undefined}
                    className="bg-white p-6 shadow-lg hover:shadow-xl transition-shadow group aspect-square flex flex-col justify-between relative"
                    style={{ borderRadius: `${content.cardBorderRadius ?? 8}px` }}
                  >
                    <div>
                      <h4 
                        className="font-semibold text-slate-900 mb-3 group-hover:text-blue-600 transition-colors"
                        style={{ fontSize: `${content.resourceTitleFontSize || 20}px` }}
                      >
                        {resource.title}
                      </h4>
                      {(content.showResourceDescription ?? true) && resource.description && (
                        <p className="text-sm text-slate-600 line-clamp-4">
                          {resource.description}
                        </p>
                      )}
                    </div>
                    {content.showCTAButton !== false && (
                      <div 
                        className="absolute flex items-center justify-center transition-transform hover:scale-110"
                        style={{
                          width: `${content.ctaButtonSize || 48}px`,
                          height: `${content.ctaButtonSize || 48}px`,
                          backgroundColor: content.ctaButtonBgColor || '#2563eb',
                          borderRadius: `${content.cardBorderRadius ?? 8}px`,
                          bottom: `${content.ctaButtonMargin ?? 16}px`,
                          right: `${content.ctaButtonMargin ?? 16}px`
                        }}
                      >
                        {resource.is_public ? (
                          <LockOpen 
                            style={{ 
                              width: `${(content.ctaButtonSize || 48) * 0.5}px`, 
                              height: `${(content.ctaButtonSize || 48) * 0.5}px`,
                              color: content.ctaButtonIconColor || '#ffffff'
                            }} 
                          />
                        ) : (
                          <Lock 
                            style={{ 
                              width: `${(content.ctaButtonSize || 48) * 0.5}px`, 
                              height: `${(content.ctaButtonSize || 48) * 0.5}px`,
                              color: content.ctaButtonIconColor || '#ffffff'
                            }} 
                          />
                        )}
                      </div>
                    )}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}