import React, { useState } from "react";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Upload, Loader2, Trash2, FileText, Sparkles, Briefcase, ChevronDown, ChevronUp, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { createPageUrl } from "@/utils";
import TypographyStyleSelector, { applyTypographyStyle, useTypographyStyles } from "../TypographyStyleSelector";
import ShowcaseCard from "@/components/common/ShowcaseCard";
import ReactQuill from "react-quill";
import DOMPurify from "dompurify";
import "react-quill/dist/quill.snow.css";
import { useIsMobile } from "@/hooks/use-mobile";
import { recordEmbeddedResourceView } from "@/lib/resourceViewTracking";

const showcaseQuillModules = {
  toolbar: [
    ['bold', 'italic', 'underline'],
    [{ 'color': [] }],
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

function CardSlotEditor({ index, card, onUpdate }) {
  // Fetch article display name setting (using public endpoint for unauthenticated access)
  const { data: articleDisplayName = 'Articles' } = useQuery({
    queryKey: ['public-article-display-name'],
    queryFn: async () => {
      const result = await publicClient.listSystemSettings();
      const allSettings = Array.isArray(result) ? result : [];
      const setting = allSettings.find(s => s.setting_key === 'article_display_name');
      return setting?.setting_value || 'Articles';
    }
  });

  // Fetch items based on content type (using public endpoints for public pages)
  const { data: items = [] } = useQuery({
    queryKey: ['public-showcase-items', card.contentType],
    queryFn: async () => {
      let result;
      switch (card.contentType) {
        case 'news':
          result = await publicClient.listNews();
          return Array.isArray(result) ? result : [];
        case 'resources':
          result = await publicClient.listResources();
          return Array.isArray(result) ? result : [];
        case 'articles':
          result = await publicClient.listArticles();
          return Array.isArray(result?.articles) ? result.articles : (Array.isArray(result) ? result : []);
        case 'jobs':
          result = await publicClient.listJobPostings();
          return Array.isArray(result) ? result : [];
        default:
          return [];
      }
    }
  });

  const getDefaultLabel = (contentType) => {
    switch (contentType) {
      case 'news': return 'News';
      case 'resources': return 'Resource';
      case 'articles': return articleDisplayName?.slice(0, -1) || 'Article';
      case 'jobs': return 'Job';
      default: return '';
    }
  };

  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
      <div className="text-xs font-medium text-slate-600 mb-2">Card {index + 1}</div>
      <div className="space-y-3">
        <Select
          value={card.contentType}
          onValueChange={(value) => onUpdate(index, 'contentType', value)}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="news">News</SelectItem>
            <SelectItem value="resources">Resources</SelectItem>
            <SelectItem value="articles">{articleDisplayName}</SelectItem>
            <SelectItem value="jobs">Jobs</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`autoLatest-${index}`}
            checked={card.autoLatest ?? false}
            onChange={(e) => onUpdate(index, 'autoLatest', e.target.checked)}
            className="w-4 h-4"
            data-testid={`checkbox-auto-latest-${index}`}
          />
          <Label htmlFor={`autoLatest-${index}`} className="cursor-pointer text-xs">
            Auto select latest
          </Label>
        </div>

        {!card.autoLatest && (
          <Select
            value={card.itemId || ''}
            onValueChange={(value) => onUpdate(index, 'itemId', value)}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select item..." />
            </SelectTrigger>
            <SelectContent>
              {items.length === 0 ? (
                <div className="p-2 text-xs text-slate-500">No items available</div>
              ) : (
                items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title || item.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        )}

        <div className="pt-2 border-t border-slate-300 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`showLabel-${index}`}
              checked={card.showLabel ?? true}
              onChange={(e) => onUpdate(index, 'showLabel', e.target.checked)}
              className="w-4 h-4"
            />
            <Label htmlFor={`showLabel-${index}`} className="cursor-pointer text-xs">
              Show Label
            </Label>
          </div>

          {card.showLabel !== false && (
            <>
              <div>
                <Label htmlFor={`labelText-${index}`} className="text-xs">Label Text</Label>
                <Input
                  id={`labelText-${index}`}
                  value={card.labelText || getDefaultLabel(card.contentType)}
                  onChange={(e) => onUpdate(index, 'labelText', e.target.value)}
                  placeholder="Custom label..."
                  className="h-8 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor={`labelBg-${index}`} className="text-xs">Background</Label>
                  <input
                    id={`labelBg-${index}`}
                    type="color"
                    value={card.labelBgColor || '#2563eb'}
                    onChange={(e) => onUpdate(index, 'labelBgColor', e.target.value)}
                    className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
                <div>
                  <Label htmlFor={`labelText-${index}`} className="text-xs">Text Color</Label>
                  <input
                    id={`labelTextColor-${index}`}
                    type="color"
                    value={card.labelTextColor || '#ffffff'}
                    onChange={(e) => onUpdate(index, 'labelTextColor', e.target.value)}
                    className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function IEditShowcaseElementEditor({ element, onChange }) {
  const [isUploadingBg, setIsUploadingBg] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    sectionHeader: true,
    background: false,
    layout: false,
    cards: true,
    cardStyling: false
  });
  
  const content = element.content || {};

  // Ensure cards array matches cardCount
  const cardCount = content.cardCount || 4;
  const cards = content.cards || [];
  if (cards.length !== cardCount) {
    const newCards = [];
    const types = ['news', 'resources', 'articles', 'jobs'];
    for (let i = 0; i < cardCount; i++) {
      newCards.push(cards[i] || { contentType: types[i] || 'news', itemId: '' });
    }
    // Auto-update cards if needed
    if (cards.length !== cardCount) {
      onChange({ ...element, content: { ...content, cards: newCards } });
    }
  }

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...element.content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...element.content, ...updates } });
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const AlignmentButtons = ({ value, onChange: onAlignChange, label, testIdPrefix = 'align' }) => (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex gap-1 mt-1">
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
    </div>
  );

  const updateCard = (index, field, value) => {
    const currentCards = [...(element.content?.cards || [])];
    currentCards[index] = { ...currentCards[index], [field]: value };
    if (field === 'contentType') {
      currentCards[index].itemId = '';
    }
    updateContent('cards', currentCards);
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
      showUploadErrorToast(error, 'Upload failed');
    } finally {
      setIsUploadingBg(false);
    }
  };

  const renderTypographyControls = (prefix, label, defaultValues = {}) => {
    const defaults = {
      font_family: 'Poppins',
      font_weight: prefix.includes('heading') ? 700 : 400,
      font_size: prefix.includes('heading') ? 48 : (prefix.includes('subheading') ? 20 : 16),
      color: '#1e293b',
      letter_spacing: 0,
      line_height: prefix.includes('heading') ? 1.2 : 1.6,
      ...defaultValues
    };

    return (
      <div className="space-y-3 p-3 bg-white rounded-md border border-slate-200 mt-2">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Font Family</Label>
            <select
              value={content[`${prefix}_font_family`] || defaults.font_family}
              onChange={(e) => updateContent(`${prefix}_font_family`, e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
            >
              {fontFamilies.map(font => (
                <option key={font} value={font}>{font}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Font Weight</Label>
            <select
              value={content[`${prefix}_font_weight`] || defaults.font_weight}
              onChange={(e) => updateContent(`${prefix}_font_weight`, parseInt(e.target.value))}
              className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
            >
              {fontWeights.map(weight => (
                <option key={weight.value} value={weight.value}>{weight.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Font Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size`] || defaults.font_size}
              onChange={(e) => updateContent(`${prefix}_font_size`, parseInt(e.target.value) || defaults.font_size)}
              min="10"
              max="120"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Mobile Size (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_font_size_mobile`] || ''}
              onChange={(e) => updateContent(`${prefix}_font_size_mobile`, e.target.value ? parseInt(e.target.value) : '')}
              min="10"
              max="120"
              placeholder="Same"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Text Color</Label>
            <input
              type="color"
              value={safeHexColor(content[`${prefix}_color`], defaults.color)}
              onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
              className="w-full h-8 px-0.5 py-0.5 border border-slate-300 rounded cursor-pointer"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Letter Spacing (px)</Label>
            <Input
              type="number"
              step="0.5"
              value={content[`${prefix}_letter_spacing`] || defaults.letter_spacing}
              onChange={(e) => updateContent(`${prefix}_letter_spacing`, parseFloat(e.target.value) || 0)}
              min="-2"
              max="10"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Line Height</Label>
            <Input
              type="number"
              step="0.1"
              value={content[`${prefix}_line_height`] || defaults.line_height}
              onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value) || defaults.line_height)}
              min="0.8"
              max="3"
              className="h-8"
            />
          </div>
        </div>
      </div>
    );
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
          placeholder="e.g., showcase-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-showcase-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Section Header */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('sectionHeader')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Section Header</span>
          {expandedSections.sectionHeader ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.sectionHeader && (
          <div className="p-4 space-y-4">
            {/* Heading */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Heading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Heading Text</Label>
                  <div className="showcase-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.headerText || ''}
                      onChange={(value) => updateContent('headerText', value)}
                      modules={showcaseQuillModules}
                      placeholder="Enter heading..."
                      style={{ minHeight: '80px' }}
                    />
                  </div>
                </div>
                <TypographyStyleSelector
                  value={content.heading_typography_style_id || null}
                  onChange={(styleId, style) => {
                    const updates = { heading_typography_style_id: styleId };
                    if (style) {
                      const mapped = applyTypographyStyle(style);
                      if (mapped.font_family) updates.heading_font_family = mapped.font_family;
                      if (mapped.font_size) updates.heading_font_size = mapped.font_size;
                      if (mapped.font_size_mobile) updates.heading_font_size_mobile = mapped.font_size_mobile;
                      if (mapped.font_weight) updates.heading_font_weight = mapped.font_weight;
                      if (mapped.line_height) updates.heading_line_height = mapped.line_height;
                      if (mapped.letter_spacing !== undefined) updates.heading_letter_spacing = mapped.letter_spacing;
                      if (mapped.color) updates.heading_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  label="Heading Typography Style"
                />
                <AlignmentButtons 
                  value={content.heading_text_align || 'center'} 
                  onChange={(val) => updateContent('heading_text_align', val)}
                  label="Alignment"
                  testIdPrefix="showcase-heading-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('heading', 'Heading Typography')}
                  
                  {/* Underline options */}
                  <div className="space-y-3 p-3 bg-slate-50 rounded-lg mt-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="heading_underline_enabled"
                        checked={content.heading_underline_enabled || false}
                        onChange={(e) => updateContent('heading_underline_enabled', e.target.checked)}
                        className="w-4 h-4"
                      />
                      <Label htmlFor="heading_underline_enabled" className="cursor-pointer text-xs">
                        Show line below heading
                      </Label>
                    </div>

                    {content.heading_underline_enabled && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs">Line Color</Label>
                            <input
                              type="color"
                              value={content.heading_underline_color || '#000000'}
                              onChange={(e) => updateContent('heading_underline_color', e.target.value)}
                              className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Line Width (px)</Label>
                            <Input
                              type="number"
                              value={content.heading_underline_width || 100}
                              onChange={(e) => updateContent('heading_underline_width', parseInt(e.target.value) || 0)}
                              min="10"
                              max="1000"
                              className="h-8"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs">Line Weight (px)</Label>
                            <Input
                              type="number"
                              value={content.heading_underline_weight || 2}
                              onChange={(e) => updateContent('heading_underline_weight', parseInt(e.target.value) || 1)}
                              min="1"
                              max="20"
                              className="h-8"
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Spacing from Header (px)</Label>
                            <Input
                              type="number"
                              value={content.heading_underline_spacing || 16}
                              onChange={(e) => updateContent('heading_underline_spacing', parseInt(e.target.value) || 0)}
                              min="0"
                              max="100"
                              className="h-8"
                            />
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Line Alignment</Label>
                          <select
                            value={content.heading_underline_alignment || 'center'}
                            onChange={(e) => updateContent('heading_underline_alignment', e.target.value)}
                            className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                          >
                            <option value="left">Left</option>
                            <option value="center">Center</option>
                            <option value="right">Right</option>
                          </select>
                        </div>
                        <div>
                          <Label className="text-xs">Spacing to Content (px)</Label>
                          <Input
                            type="number"
                            value={content.heading_underline_to_content_spacing || 24}
                            onChange={(e) => updateContent('heading_underline_to_content_spacing', parseInt(e.target.value) || 0)}
                            min="0"
                            max="100"
                            className="h-8"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </details>
              </div>
            </div>

            {/* Subheading */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Subheading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Subheading Text</Label>
                  <div className="showcase-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.descriptionText || ''}
                      onChange={(value) => updateContent('descriptionText', value)}
                      modules={showcaseQuillModules}
                      placeholder="Enter subheading..."
                      style={{ minHeight: '80px' }}
                    />
                  </div>
                </div>
                <TypographyStyleSelector
                  value={content.subheading_typography_style_id || null}
                  onChange={(styleId, style) => {
                    const updates = { subheading_typography_style_id: styleId };
                    if (style) {
                      const mapped = applyTypographyStyle(style);
                      if (mapped.font_family) updates.subheading_font_family = mapped.font_family;
                      if (mapped.font_size) updates.subheading_font_size = mapped.font_size;
                      if (mapped.font_size_mobile) updates.subheading_font_size_mobile = mapped.font_size_mobile;
                      if (mapped.font_weight) updates.subheading_font_weight = mapped.font_weight;
                      if (mapped.line_height) updates.subheading_line_height = mapped.line_height;
                      if (mapped.letter_spacing !== undefined) updates.subheading_letter_spacing = mapped.letter_spacing;
                      if (mapped.color) updates.subheading_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  label="Subheading Typography Style"
                />
                <AlignmentButtons 
                  value={content.subheading_text_align || 'center'} 
                  onChange={(val) => updateContent('subheading_text_align', val)}
                  label="Alignment"
                  testIdPrefix="showcase-subheading-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('subheading', 'Subheading Typography')}
                </details>
              </div>
            </div>

            {/* Content */}
            <div>
              <h5 className="font-medium text-sm mb-3">Content</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Content Text</Label>
                  <div className="showcase-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.body_content || ''}
                      onChange={(value) => updateContent('body_content', value)}
                      modules={showcaseQuillModules}
                      placeholder="Enter content..."
                      style={{ minHeight: '120px' }}
                    />
                  </div>
                </div>
                <TypographyStyleSelector
                  value={content.content_typography_style_id || null}
                  onChange={(styleId, style) => {
                    const updates = { content_typography_style_id: styleId };
                    if (style) {
                      const mapped = applyTypographyStyle(style);
                      if (mapped.font_family) updates.content_font_family = mapped.font_family;
                      if (mapped.font_size) updates.content_font_size = mapped.font_size;
                      if (mapped.font_size_mobile) updates.content_font_size_mobile = mapped.font_size_mobile;
                      if (mapped.font_weight) updates.content_font_weight = mapped.font_weight;
                      if (mapped.line_height) updates.content_line_height = mapped.line_height;
                      if (mapped.color) updates.content_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  label="Content Typography Style"
                />
                <AlignmentButtons 
                  value={content.content_text_align || 'center'} 
                  onChange={(val) => updateContent('content_text_align', val)}
                  label="Alignment"
                  testIdPrefix="showcase-content-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('content', 'Content Typography')}
                </details>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Layout & Spacing */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('layout')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Layout & Spacing</span>
          {expandedSections.layout ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.layout && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-xs">Card Text Alignment</Label>
              <select
                value={content.card_text_align || 'left'}
                onChange={(e) => updateContent('card_text_align', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Top Padding (px)</Label>
                <Input
                  type="number"
                  value={content.padding_top ?? 64}
                  onChange={(e) => updateContent('padding_top', parseInt(e.target.value) || 0)}
                  min="0"
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Bottom Padding (px)</Label>
                <Input
                  type="number"
                  value={content.padding_bottom ?? 64}
                  onChange={(e) => updateContent('padding_bottom', parseInt(e.target.value) || 0)}
                  min="0"
                  className="h-8"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Left Padding (px)</Label>
                <Input
                  type="number"
                  value={content.padding_left || 16}
                  onChange={(e) => updateContent('padding_left', parseInt(e.target.value) || 0)}
                  min="0"
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Right Padding (px)</Label>
                <Input
                  type="number"
                  value={content.padding_right || 16}
                  onChange={(e) => updateContent('padding_right', parseInt(e.target.value) || 0)}
                  min="0"
                  className="h-8"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs">Number of Cards</Label>
              <select
                value={String(content.cardCount || 4)}
                onChange={(e) => updateContent('cardCount', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="1">1 Card</option>
                <option value="2">2 Cards</option>
                <option value="3">3 Cards</option>
                <option value="4">4 Cards</option>
              </select>
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
        >
          <span className="font-semibold text-sm">Background</span>
          {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-xs">Background Color</Label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={content.backgroundColor || '#ffffff'}
                  onChange={(e) => updateContent('backgroundColor', e.target.value)}
                  className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
                <Input
                  value={content.backgroundColor || '#ffffff'}
                  onChange={(e) => updateContent('backgroundColor', e.target.value)}
                  placeholder="#ffffff"
                  className="flex-1 h-8"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs">Background Image</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={content.backgroundImage || ''}
                  onChange={(e) => updateContent('backgroundImage', e.target.value)}
                  placeholder="Background image URL"
                  className="flex-1 h-8"
                />
                <label className="cursor-pointer">
                  <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors ${
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
                </label>
                {content.backgroundImage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => updateContent('backgroundImage', '')}
                    className="text-red-600 h-8"
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
                  className="mt-2 w-full h-24 object-cover rounded"
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Card Styling */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('cardStyling')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Card Styling</span>
          {expandedSections.cardStyling ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.cardStyling && (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Card Height (px)</Label>
                <Input
                  type="number"
                  value={content.cardHeight || 400}
                  onChange={(e) => updateContent('cardHeight', parseInt(e.target.value) || 400)}
                  min="200"
                  max="800"
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Image Height (%)</Label>
                <Input
                  type="number"
                  value={content.imageHeightPercent || 50}
                  onChange={(e) => updateContent('imageHeightPercent', parseInt(e.target.value) || 50)}
                  min="20"
                  max="80"
                  className="h-8"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Border Radius (px)</Label>
                <Input
                  type="number"
                  value={content.cardBorderRadius ?? 8}
                  onChange={(e) => {
                    const val = e.target.value === '' ? 0 : parseInt(e.target.value);
                    updateContent('cardBorderRadius', isNaN(val) ? 0 : val);
                  }}
                  min="0"
                  max="50"
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Description Lines</Label>
                <select
                  value={String(content.descriptionLineClamp ?? 3)}
                  onChange={(e) => updateContent('descriptionLineClamp', e.target.value === 'none' ? 'none' : parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
                >
                  <option value="0">Title Only</option>
                  <option value="1">1 Line</option>
                  <option value="2">2 Lines</option>
                  <option value="3">3 Lines</option>
                  <option value="4">4 Lines</option>
                  <option value="5">5 Lines</option>
                  <option value="none">No Limit</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Title Font Size (px)</Label>
                <Input
                  type="number"
                  value={content.titleFontSize || 16}
                  onChange={(e) => updateContent('titleFontSize', parseInt(e.target.value) || 16)}
                  min="12"
                  max="32"
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Date Font Size (px)</Label>
                <Input
                  type="number"
                  value={content.dateFontSize || 12}
                  onChange={(e) => updateContent('dateFontSize', parseInt(e.target.value) || 12)}
                  min="10"
                  max="18"
                  className="h-8"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="showPublishedDate"
                checked={content.showPublishedDate || false}
                onChange={(e) => updateContent('showPublishedDate', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="showPublishedDate" className="cursor-pointer text-xs">
                Show Published Date
              </Label>
            </div>

            <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="showImageBorder"
                  checked={content.showImageBorder || false}
                  onChange={(e) => updateContent('showImageBorder', e.target.checked)}
                  className="w-4 h-4"
                />
                <Label htmlFor="showImageBorder" className="cursor-pointer text-xs">
                  Show Line Below Image
                </Label>
              </div>

              {content.showImageBorder && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Line Weight (px)</Label>
                    <Input
                      type="number"
                      value={content.imageBorderWeight || 3}
                      onChange={(e) => updateContent('imageBorderWeight', parseInt(e.target.value) || 3)}
                      min="1"
                      max="20"
                      className="h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Line Color</Label>
                    <input
                      type="color"
                      value={content.imageBorderColor || '#2563eb'}
                      onChange={(e) => updateContent('imageBorderColor', e.target.value)}
                      className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                  </div>
                </div>
              )}
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
                <Label htmlFor="showCTAButton" className="cursor-pointer text-xs">
                  Show CTA Button
                </Label>
              </div>

              {content.showCTAButton !== false && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Button Size (px)</Label>
                      <Input
                        type="number"
                        value={content.ctaButtonSize || 48}
                        onChange={(e) => updateContent('ctaButtonSize', parseInt(e.target.value) || 48)}
                        min="24"
                        max="80"
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Margin (px)</Label>
                      <Input
                        type="number"
                        value={content.ctaButtonMargin ?? 16}
                        onChange={(e) => updateContent('ctaButtonMargin', parseInt(e.target.value) ?? 0)}
                        min="0"
                        max="50"
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Background</Label>
                      <input
                        type="color"
                        value={content.ctaButtonBgColor || '#2563eb'}
                        onChange={(e) => updateContent('ctaButtonBgColor', e.target.value)}
                        className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Arrow Color</Label>
                      <input
                        type="color"
                        value={content.ctaButtonArrowColor || '#ffffff'}
                        onChange={(e) => updateContent('ctaButtonArrowColor', e.target.value)}
                        className="w-full h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Card Slots */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('cards')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Card Slots</span>
          {expandedSections.cards ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.cards && (
          <div className="p-4 space-y-4">
            {(content.cards || []).map((card, index) => (
              <CardSlotEditor
                key={index}
                index={index}
                card={card}
                onUpdate={updateCard}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function IEditShowcaseElementRenderer({ element, settings }) {
  const isMobile = useIsMobile();
  const { getStyleById } = useTypographyStyles();
  const content = element.content || {};

  const fullWidth = settings?.fullWidth;

  // Fetch article display name setting using public endpoint
  const { data: articleDisplayName = 'Articles' } = useQuery({
    queryKey: ['public-article-display-name-showcase'],
    queryFn: async () => {
      const setting = await publicClient.getSystemSetting('article_display_name');
      return setting?.setting_value || 'Articles';
    }
  });

  // Fetch all items for selected cards using public endpoints
  const { data: allNews = [] } = useQuery({
    queryKey: ['public-showcase-news'],
    queryFn: async () => {
      const result = await publicClient.listNews();
      return Array.isArray(result) ? result : [];
    },
    enabled: content.cards?.some(c => c.contentType === 'news' && (c.itemId || c.autoLatest))
  });

  const { data: allResources = [] } = useQuery({
    queryKey: ['public-showcase-resources'],
    queryFn: async () => {
      const result = await publicClient.listResources();
      return Array.isArray(result) ? result : [];
    },
    enabled: content.cards?.some(c => c.contentType === 'resources' && (c.itemId || c.autoLatest))
  });

  const { data: allArticles = [] } = useQuery({
    queryKey: ['public-showcase-articles'],
    queryFn: async () => {
      const result = await publicClient.listArticles();
      return Array.isArray(result?.articles) ? result.articles : (Array.isArray(result) ? result : []);
    },
    enabled: content.cards?.some(c => c.contentType === 'articles' && (c.itemId || c.autoLatest))
  });

  const { data: allJobs = [] } = useQuery({
    queryKey: ['public-showcase-jobs'],
    queryFn: async () => {
      const result = await publicClient.listJobPostings();
      return Array.isArray(result) ? result : [];
    },
    enabled: content.cards?.some(c => c.contentType === 'jobs' && (c.itemId || c.autoLatest))
  });

  // Build items array from selected cards with metadata
  const items = React.useMemo(() => {
    if (!content.cards) return [];

    const listForType = {
      news: allNews,
      resources: allResources,
      articles: allArticles,
      jobs: allJobs,
    };

    const sortedByType = {};
    for (const type of Object.keys(listForType)) {
      const list = listForType[type];
      if (list && list.length > 0) {
        sortedByType[type] = [...list].sort((a, b) => {
          const dateA = new Date(a.published_date || a.created_at || a.created_date || 0);
          const dateB = new Date(b.published_date || b.created_at || b.created_date || 0);
          return dateB - dateA;
        });
      } else {
        sortedByType[type] = [];
      }
    }

    const claimedKeys = new Set();

    content.cards.forEach(card => {
      if (!card.autoLatest && card.itemId) {
        claimedKeys.add(`${card.contentType}:${card.itemId}`);
      }
    });

    return content.cards
      .map(card => {
        if (!card.itemId && !card.autoLatest) return null;

        let item;

        if (card.autoLatest) {
          const sorted = sortedByType[card.contentType] || [];
          item = sorted.find(entry => !claimedKeys.has(`${card.contentType}:${entry.id}`)) || null;
          if (item) {
            claimedKeys.add(`${card.contentType}:${item.id}`);
          }
        } else {
          switch (card.contentType) {
            case 'news':
              item = allNews.find(n => n.id === card.itemId);
              break;
            case 'resources':
              item = allResources.find(r => r.id === card.itemId);
              break;
            case 'articles':
              item = allArticles.find(a => a.id === card.itemId);
              break;
            case 'jobs':
              item = allJobs.find(j => j.id === card.itemId);
              break;
          }
        }
        return item ? { ...item, _contentType: card.contentType, _cardConfig: card } : null;
      })
      .filter(Boolean);
  }, [content.cards, allNews, allResources, allArticles, allJobs]);

  // Co-authors (Task #1230): article cards can have multiple authors stored in
  // the blog_post_author join table. Fetch the ordered author list (primary
  // first) for the visible article items so showcase teasers display co-authors
  // alongside the primary author. Only articles use this entity.
  const articleIdsKey = React.useMemo(
    () => items.filter((i) => i._contentType === 'articles').map((i) => i.id).filter(Boolean).join(','),
    [items]
  );
  const { data: coAuthorsData } = useQuery({
    queryKey: ['public-showcase-article-co-authors', articleIdsKey],
    queryFn: async () => {
      if (!articleIdsKey) return { authors: {} };
      const r = await fetch(`/api/articles/co-authors?ids=${encodeURIComponent(articleIdsKey)}`);
      if (!r.ok) return { authors: {} };
      return r.json();
    },
    enabled: !!articleIdsKey,
    staleTime: 60_000,
  });
  const formatAuthorNames = (cards) => {
    const names = (cards || []).map((a) => a.name).filter(Boolean);
    if (names.length === 0) return '';
    return names.reduce((acc, n, idx) => acc + (idx === 0 ? n : (idx === 1 ? ' & ' : ', ') + n), '');
  };

  const getItemUrl = (item) => {
    switch (item._contentType) {
      case 'news':
        return createPageUrl(`NewsView?id=${item.id}`);
      case 'resources':
        return item.target_url || `/resources?resourceId=${encodeURIComponent(item.id)}`;
      case 'articles':
        return createPageUrl(`ArticleView?slug=${item.slug}`);
      case 'jobs':
        return createPageUrl(`JobDetails?id=${item.id}`);
      default:
        return '#';
    }
  };

  const getContentTypeLabel = (contentType) => {
    switch (contentType) {
      case 'news': return 'News';
      case 'resources': return 'Resource';
      case 'articles': return articleDisplayName?.slice(0, -1) || 'Article';
      case 'jobs': return 'Job';
      default: return '';
    }
  };

  const sectionStyle = content.backgroundImage ? {
    backgroundImage: `url(${content.backgroundImage})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center'
  } : {
    backgroundColor: content.backgroundColor || '#ffffff'
  };

  const backgroundWrapperClass = fullWidth ? 'w-screen relative left-1/2 right-1/2 -ml-[50vw] -mr-[50vw]' : 'w-full';

  const containerStyle = {
    paddingLeft: `${content.padding_left || 16}px`,
    paddingRight: `${content.padding_right || 16}px`,
    textAlign: content.text_align || 'center'
  };

  const wrapperStyle = {
    ...sectionStyle,
    paddingTop: `${content.padding_top ?? 64}px`,
    paddingBottom: `${content.padding_bottom ?? 64}px`
  };

  // Typography styles with mobile support
  const headingTypographyStyle = getStyleById(content.heading_typography_style_id);
  const headingFontSize = isMobile 
    ? (headingTypographyStyle?.font_size_mobile || content.heading_font_size_mobile || headingTypographyStyle?.font_size || content.heading_font_size || 36)
    : (headingTypographyStyle?.font_size || content.heading_font_size || 48);
  
  const subheadingTypographyStyle = getStyleById(content.subheading_typography_style_id);
  const subheadingFontSize = isMobile 
    ? (subheadingTypographyStyle?.font_size_mobile || content.subheading_font_size_mobile || subheadingTypographyStyle?.font_size || content.subheading_font_size || 16)
    : (subheadingTypographyStyle?.font_size || content.subheading_font_size || 20);
  
  const contentTypographyStyle = getStyleById(content.content_typography_style_id);
  const contentFontSize = isMobile 
    ? (contentTypographyStyle?.font_size_mobile || content.content_font_size_mobile || contentTypographyStyle?.font_size || content.content_font_size || 14)
    : (contentTypographyStyle?.font_size || content.content_font_size || 16);

  return (
    <div id={content.anchor || undefined} className={`${backgroundWrapperClass} relative`} style={wrapperStyle}>
      <div className="max-w-7xl mx-auto px-4 relative z-10" style={containerStyle}>
        {(content.headerText || content.descriptionText || content.body_content) && (
          <div style={{ marginBottom: '48px' }}>
            {content.headerText && (
              <div>
                <div 
                  className="prose prose-headings:m-0 max-w-none"
                  style={{ 
                    fontWeight: headingTypographyStyle?.font_weight || content.heading_font_weight || 700, 
                    fontFamily: headingTypographyStyle?.font_family || content.heading_font_family || 'Poppins',
                    fontSize: `${headingFontSize}px`,
                    letterSpacing: `${headingTypographyStyle?.letter_spacing ?? content.heading_letter_spacing ?? 0}px`,
                    lineHeight: headingTypographyStyle?.line_height || content.heading_line_height || 1.2,
                    marginBottom: content.heading_underline_enabled ? `${content.heading_underline_spacing || 16}px` : '24px',
                    color: headingTypographyStyle?.color || content.heading_color || '#0f172a',
                    textAlign: content.heading_text_align || 'center'
                  }}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.headerText) }}
                />
                {content.heading_underline_enabled && (
                  <div 
                    style={{
                      width: `${content.heading_underline_width || 100}px`,
                      height: `${content.heading_underline_weight || 2}px`,
                      backgroundColor: content.heading_underline_color || '#000000',
                      marginLeft: (content.heading_underline_alignment || 'center') === 'center' ? 'auto' : (content.heading_underline_alignment || 'center') === 'right' ? 'auto' : '0',
                      marginRight: (content.heading_underline_alignment || 'center') === 'center' ? 'auto' : '0',
                      marginBottom: `${content.heading_underline_to_content_spacing || 24}px`,
                      display: 'block'
                    }}
                  />
                )}
              </div>
            )}
            {content.descriptionText && (
              <div 
                className="prose prose-p:m-0 max-w-none mx-auto"
                style={{ 
                  fontFamily: subheadingTypographyStyle?.font_family || content.subheading_font_family || 'Poppins',
                  fontWeight: subheadingTypographyStyle?.font_weight || content.subheading_font_weight || 400,
                  fontSize: `${subheadingFontSize}px`,
                  lineHeight: subheadingTypographyStyle?.line_height || content.subheading_line_height || 1.5,
                  maxWidth: '48rem',
                  color: subheadingTypographyStyle?.color || content.subheading_color || content.description_color || '#475569',
                  textAlign: content.subheading_text_align || 'center'
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.descriptionText) }}
              />
            )}
            {content.body_content && (
              <div 
                className="prose max-w-none mx-auto mt-6"
                style={{ 
                  fontFamily: contentTypographyStyle?.font_family || content.content_font_family || 'Poppins',
                  fontWeight: contentTypographyStyle?.font_weight || content.content_font_weight || 400,
                  fontSize: `${contentFontSize}px`,
                  lineHeight: contentTypographyStyle?.line_height || content.content_line_height || 1.6,
                  maxWidth: '48rem',
                  color: contentTypographyStyle?.color || content.content_color || '#64748b',
                  textAlign: content.content_text_align || 'center'
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.body_content) }}
              />
            )}
          </div>
        )}

        {items.length === 0 ? (
          <div className="text-center py-12 bg-white/90 rounded-lg">
            <FileText className="w-12 h-12 text-slate-400 mx-auto mb-3" />
            <p className="text-slate-500">No items selected</p>
          </div>
        ) : (
          <div className={`grid grid-cols-1 ${content.cardCount >= 2 ? 'md:grid-cols-2' : ''} ${content.cardCount >= 4 ? 'lg:grid-cols-4' : content.cardCount === 3 ? 'lg:grid-cols-3' : ''} gap-6`}>
            {items.map((item) => {
              const isExternalLink = item._contentType === 'resources'
                && !!item.target_url
                && item.open_in_new_tab !== false;
              const url = getItemUrl(item);
              const authorText = item._contentType === 'articles'
                ? formatAuthorNames(coAuthorsData?.authors?.[item.id])
                : '';

              return (
                <ShowcaseCard
                  key={item.id}
                  title={item.title || item.name}
                  imageUrl={item.image_url || item.feature_image_url}
                  imageFocalPoint={item.feature_image_focal_point || null}
                  imageAlt={item.title || item.name}
                  summary={item.summary || item.description}
                  publishedDate={item.published_date}
                  authorText={authorText}
                  url={url}
                  external={!!isExternalLink}
                  newTab={!!isExternalLink}
                  onClick={item._contentType === 'resources'
                    ? () => void recordEmbeddedResourceView(item.id)
                    : undefined}
                  showBadge={item._cardConfig?.showLabel !== false}
                  badgeText={item._cardConfig?.labelText || getContentTypeLabel(item._contentType)}
                  badgeBgColor={item._cardConfig?.labelBgColor || '#2563eb'}
                  badgeTextColor={item._cardConfig?.labelTextColor || '#ffffff'}
                  cardHeight={content.cardHeight || 400}
                  cardBorderRadius={content.cardBorderRadius ?? 8}
                  imageHeightPercent={content.imageHeightPercent || 50}
                  showImageBorder={!!content.showImageBorder}
                  imageBorderWeight={content.imageBorderWeight || 3}
                  imageBorderColor={content.imageBorderColor || '#2563eb'}
                  titleFontSize={content.titleFontSize || 16}
                  dateFontSize={content.dateFontSize || 12}
                  descriptionLineClamp={content.descriptionLineClamp}
                  showPublishedDate={!!content.showPublishedDate}
                  showCTAButton={content.showCTAButton !== false}
                  ctaButtonSize={content.ctaButtonSize || 48}
                  ctaButtonMargin={content.ctaButtonMargin ?? 0}
                  ctaButtonBgColor={content.ctaButtonBgColor || '#2563eb'}
                  ctaButtonArrowColor={content.ctaButtonArrowColor || '#ffffff'}
                  textAlign={content.card_text_align || 'left'}
                  testId={item.id}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}