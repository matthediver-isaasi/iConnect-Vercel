import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Upload, ArrowRight, ChevronDown, ChevronUp, X } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";
import { useIsMobile } from "@/hooks/use-mobile";

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

export default function IEditCardDeckElement({ content, variant, settings }) {
  const isMobile = useIsMobile();
  
  const {
    background_type = 'none',
    background_color = '#ffffff',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    background_image_url,
    background_image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    heading,
    subheading,
    body_content,
    text_alignment = 'center',
    vertical_padding = 48,
    horizontal_padding = 16,
    cardCount = 3,
    cardIds = [],
    cardBorderRadius = 12,
    cardBackgroundColor = '#ffffff',
    cardShadow = true,
    showCardImage = true,
    imageHeightPercent = 50,
    showCardDescription = true,
    descriptionLineClamp = 3,
    showCardButton = true,
    cardButtonText = 'Learn More',
    cardButtonBgColor = '#2563eb',
    cardButtonTextColor = '#ffffff',
    cardTitleFontSize = 20,
    cardTitleColor = '#0f172a',
    cardDescriptionFontSize = 14,
    cardDescriptionColor = '#64748b',
    gap = 24
  } = content || {};

  const { data: allCards = [] } = useQuery({
    queryKey: ['card-deck-renderer'],
    queryFn: () => base44.entities.CardDeck.list('display_order'),
    staleTime: 60000,
  });

  const selectedCards = (cardIds || [])
    .filter(id => id)
    .map(id => allCards.find(c => c.id === id))
    .filter(Boolean)
    .slice(0, cardCount);

  const getBackgroundStyle = () => {
    if (background_type === 'color') {
      return { backgroundColor: background_color };
    }
    if (background_type === 'gradient') {
      return { 
        background: `linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color})` 
      };
    }
    return {};
  };

  const hasBackground = background_type && background_type !== 'none';

  const getTextStyle = (prefix) => {
    const fontSize = content?.[`${prefix}_font_size`] || 16;
    const mobileFontSize = content?.[`${prefix}_font_size_mobile`];
    
    return {
      fontFamily: content?.[`${prefix}_font_family`] || 'Poppins',
      fontWeight: content?.[`${prefix}_font_weight`] || 400,
      fontSize: `${(isMobile && mobileFontSize) ? mobileFontSize : fontSize}px`,
      color: content?.[`${prefix}_color`] || '#1e293b',
      letterSpacing: `${content?.[`${prefix}_letter_spacing`] || 0}px`,
      lineHeight: content?.[`${prefix}_line_height`] || 1.5
    };
  };

  const alignmentClass = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right'
  }[text_alignment] || 'text-center';

  const getGridCols = () => {
    if (cardCount === 2) return 'grid-cols-1 md:grid-cols-2';
    if (cardCount === 3) return 'grid-cols-1 md:grid-cols-3';
    if (cardCount === 4) return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4';
    if (cardCount === 6) return 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3';
    return 'grid-cols-1 md:grid-cols-3';
  };

  return (
    <div 
      className="relative w-full"
      style={hasBackground && background_type !== 'image' ? getBackgroundStyle() : {}}
    >
      {background_type === 'image' && background_image_url && (
        <>
          <img 
            src={background_image_url} 
            alt="Background" 
            className="absolute inset-0 w-full h-full"
            style={{ objectFit: background_image_fit }}
          />
          {overlay_enabled && (
            <div 
              className="absolute inset-0" 
              style={{ 
                backgroundColor: overlay_color, 
                opacity: parseInt(overlay_opacity) / 100 
              }} 
            />
          )}
        </>
      )}

      <div 
        className="relative max-w-7xl mx-auto"
        style={{ 
          paddingTop: `${vertical_padding}px`, 
          paddingBottom: `${vertical_padding}px`,
          paddingLeft: `${horizontal_padding}px`,
          paddingRight: `${horizontal_padding}px`
        }}
      >
        {(heading || subheading || body_content) && (
          <div className={`mb-8 ${alignmentClass}`}>
            {heading && (
              <h2 style={getTextStyle('heading')} className="m-0 mb-4">
                {heading}
              </h2>
            )}
            {subheading && (
              <h3 style={getTextStyle('subheading')} className="m-0 mb-4">
                {subheading}
              </h3>
            )}
            {body_content && (
              <div className="prose max-w-none mx-auto" style={getTextStyle('content')}>
                <ReactMarkdown>{body_content}</ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {selectedCards.length > 0 ? (
          <div className={`grid ${getGridCols()}`} style={{ gap: `${gap}px` }}>
            {selectedCards.map((card) => (
              <div
                key={card.id}
                className={`flex flex-col overflow-hidden ${cardShadow ? 'shadow-lg' : ''}`}
                style={{
                  backgroundColor: cardBackgroundColor,
                  borderRadius: `${cardBorderRadius}px`
                }}
              >
                {showCardImage && card.image_url && (
                  <div 
                    className="w-full"
                    style={{ height: `${imageHeightPercent * 2}px` }}
                  >
                    <img
                      src={card.image_url}
                      alt={card.title || ''}
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <div className="flex flex-col flex-1 p-4">
                  {card.title && (
                    <h4 
                      className="font-semibold m-0 mb-2"
                      style={{ 
                        fontSize: `${cardTitleFontSize}px`,
                        color: cardTitleColor
                      }}
                    >
                      {card.title}
                    </h4>
                  )}
                  {showCardDescription && card.description && (
                    <p 
                      className="m-0 mb-4 flex-1"
                      style={{
                        fontSize: `${cardDescriptionFontSize}px`,
                        color: cardDescriptionColor,
                        display: '-webkit-box',
                        WebkitLineClamp: descriptionLineClamp,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                      }}
                    >
                      {card.description}
                    </p>
                  )}
                  {showCardButton && card.target_url && (
                    <a
                      href={card.target_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md font-medium transition-colors mt-auto"
                      style={{
                        backgroundColor: cardButtonBgColor,
                        color: cardButtonTextColor
                      }}
                    >
                      {card.button_text || cardButtonText}
                      <ArrowRight className="w-4 h-4" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-slate-500">
            No cards selected. Please select cards in the editor.
          </div>
        )}
      </div>
    </div>
  );
}

export function IEditCardDeckElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [isUploading, setIsUploading] = useState({});
  const [expandedSections, setExpandedSections] = useState({
    text: true,
    background: false,
    cards: true,
    cardStyling: false,
    buttonOptions: false
  });

  const { data: cards = [] } = useQuery({
    queryKey: ['card-deck-list'],
    queryFn: () => base44.entities.CardDeck.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const activeCards = cards.filter(c => c.status === 'active');

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
  };

  const updateCardId = (index, value) => {
    const newCardIds = Array.isArray(content.cardIds) ? [...content.cardIds] : ['', '', '', '', '', ''];
    newCardIds[index] = value;
    updateContent('cardIds', newCardIds);
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleImageUpload = async (file, field) => {
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    setIsUploading(prev => ({ ...prev, [field]: true }));
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateContent(field, response.file_url);
      toast.success('Image uploaded');
    } catch (error) {
      toast.error('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(prev => ({ ...prev, [field]: false }));
    }
  };

  const backgroundType = content.background_type || 'none';
  const gradientPreview = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;
  const cardCount = content.cardCount || 3;
  const cardSlots = Array(cardCount).fill(null);

  const renderTypographyControls = (prefix, label, defaultValues = {}) => {
    const defaults = {
      font_family: 'Poppins',
      font_weight: prefix.includes('heading') ? 700 : 400,
      font_size: prefix.includes('heading') ? 32 : (prefix.includes('subheading') ? 20 : 16),
      color: '#1e293b',
      letter_spacing: 0,
      line_height: prefix.includes('heading') ? 1.2 : 1.6,
      ...defaultValues
    };

    return (
      <div className="space-y-3 p-3 bg-white rounded-md border border-slate-200">
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
      {/* Text Content Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('text')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Header, Subheader & Content</span>
          {expandedSections.text ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.text && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-xs">Text Alignment</Label>
              <select
                value={content.text_alignment || 'center'}
                onChange={(e) => updateContent('text_alignment', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>

            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Heading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Heading Text</Label>
                  <Input
                    value={content.heading || ''}
                    onChange={(e) => updateContent('heading', e.target.value)}
                    placeholder="Enter heading..."
                  />
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
                  filterTypes={['h1', 'h2']}
                  label="Heading Typography Style"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('heading', 'Heading Typography')}
                </details>
              </div>
            </div>

            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Subheading</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Subheading Text</Label>
                  <Input
                    value={content.subheading || ''}
                    onChange={(e) => updateContent('subheading', e.target.value)}
                    placeholder="Enter subheading..."
                  />
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
                  filterTypes={['h3', 'h4']}
                  label="Subheading Typography Style"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('subheading', 'Subheading Typography')}
                </details>
              </div>
            </div>

            <div>
              <h5 className="font-medium text-sm mb-3">Content</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Content (Markdown supported)</Label>
                  <Textarea
                    value={content.body_content || ''}
                    onChange={(e) => updateContent('body_content', e.target.value)}
                    placeholder="Enter content..."
                    rows={4}
                  />
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
                  filterTypes={['paragraph']}
                  label="Content Typography Style"
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

      {/* Background Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Section Background</span>
          {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4">
            <div>
              <Label>Background Type</Label>
              <select
                value={backgroundType}
                onChange={(e) => updateContent('background_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="none">None</option>
                <option value="color">Solid Color</option>
                <option value="gradient">Gradient</option>
                <option value="image">Image</option>
              </select>
            </div>

            {backgroundType === 'color' && (
              <div>
                <Label>Background Color</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={safeHexColor(content.background_color, '#ffffff')}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                  <Input
                    value={content.background_color || '#ffffff'}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="flex-1 font-mono text-sm"
                  />
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
                    <Label className="text-xs">Start Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={safeHexColor(content.gradient_start_color, '#3b82f6')}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <Input
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="flex-1 font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">End Color</Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="color"
                        value={safeHexColor(content.gradient_end_color, '#8b5cf6')}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="w-12 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                      <Input
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="flex-1 font-mono text-xs"
                      />
                    </div>
                  </div>
                </div>
                
                <div>
                  <Label className="text-xs">Angle: {content.gradient_angle || 135}°</Label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={content.gradient_angle || 135}
                    onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            {backgroundType === 'image' && (
              <div className="space-y-3">
                <div>
                  <Label>Background Image</Label>
                  <label className="inline-block mt-2">
                    <div className={`px-4 py-2 rounded-md text-sm font-medium cursor-pointer inline-flex items-center gap-2 ${
                      isUploading.background_image_url 
                        ? 'bg-slate-300 cursor-not-allowed' 
                        : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}>
                      <Upload className="w-4 h-4" />
                      {isUploading.background_image_url ? 'Uploading...' : 'Upload Image'}
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleImageUpload(file, 'background_image_url');
                        e.target.value = '';
                      }}
                      className="hidden"
                      disabled={isUploading.background_image_url}
                    />
                  </label>
                </div>

                {content.background_image_url && (
                  <div className="relative">
                    <img
                      src={content.background_image_url}
                      alt="Background preview"
                      className="w-full h-32 object-cover rounded"
                    />
                    <button
                      onClick={() => updateContent('background_image_url', '')}
                      className="absolute top-2 right-2 p-1 bg-red-600 hover:bg-red-700 text-white rounded"
                      type="button"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                <div>
                  <Label className="text-xs">Image Fit</Label>
                  <select
                    value={content.background_image_fit || 'cover'}
                    onChange={(e) => updateContent('background_image_fit', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    <option value="cover">Cover</option>
                    <option value="contain">Contain</option>
                    <option value="fill">Fill</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="overlay-enabled"
                    checked={content.overlay_enabled || false}
                    onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="overlay-enabled" className="cursor-pointer">Enable Overlay</Label>
                </div>

                {content.overlay_enabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Overlay Color</Label>
                      <input
                        type="color"
                        value={safeHexColor(content.overlay_color, '#000000')}
                        onChange={(e) => updateContent('overlay_color', e.target.value)}
                        className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Overlay Opacity: {content.overlay_opacity || 50}%</Label>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={content.overlay_opacity || 50}
                        onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Vertical Padding: {content.vertical_padding || 48}px</Label>
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
                <Label className="text-xs">Horizontal Padding: {content.horizontal_padding || 16}px</Label>
                <input
                  type="range"
                  min="0"
                  max="80"
                  value={content.horizontal_padding || 16}
                  onChange={(e) => updateContent('horizontal_padding', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Card Selection Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('cards')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Card Selection</span>
          {expandedSections.cards ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.cards && (
          <div className="p-4 space-y-4">
            <div>
              <Label>Number of Cards</Label>
              <select
                value={String(content.cardCount || 3)}
                onChange={(e) => updateContent('cardCount', parseInt(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="2">2 Cards</option>
                <option value="3">3 Cards</option>
                <option value="4">4 Cards</option>
                <option value="6">6 Cards</option>
              </select>
            </div>

            <div>
              <Label>Select Cards</Label>
              <p className="text-xs text-slate-500 mb-2">Choose cards from your Card Deck to display</p>
              <div className="space-y-2">
                {cardSlots.map((_, index) => (
                  <select
                    key={index}
                    value={(Array.isArray(content.cardIds) && content.cardIds[index]) || ''}
                    onChange={(e) => updateCardId(index, e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    <option value="">Card {index + 1} (optional)</option>
                    {activeCards.map((card) => (
                      <option key={card.id} value={card.id}>
                        {card.title}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            </div>

            <div>
              <Label className="text-xs">Card Gap: {content.gap || 24}px</Label>
              <input
                type="range"
                min="8"
                max="64"
                value={content.gap || 24}
                onChange={(e) => updateContent('gap', parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>

      {/* Card Styling Section */}
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
                <Label className="text-xs">Border Radius (px)</Label>
                <Input
                  type="number"
                  value={content.cardBorderRadius ?? 12}
                  onChange={(e) => updateContent('cardBorderRadius', parseInt(e.target.value) || 0)}
                  min="0"
                  max="50"
                />
              </div>
              <div>
                <Label className="text-xs">Card Background</Label>
                <input
                  type="color"
                  value={safeHexColor(content.cardBackgroundColor, '#ffffff')}
                  onChange={(e) => updateContent('cardBackgroundColor', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="cardShadow"
                checked={content.cardShadow ?? true}
                onChange={(e) => updateContent('cardShadow', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="cardShadow" className="cursor-pointer">Show Card Shadow</Label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="showCardImage"
                checked={content.showCardImage ?? true}
                onChange={(e) => updateContent('showCardImage', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="showCardImage" className="cursor-pointer">Show Card Images</Label>
            </div>

            {content.showCardImage !== false && (
              <div>
                <Label className="text-xs">Image Height: {content.imageHeightPercent || 50}%</Label>
                <input
                  type="range"
                  min="20"
                  max="80"
                  value={content.imageHeightPercent || 50}
                  onChange={(e) => updateContent('imageHeightPercent', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="showCardDescription"
                checked={content.showCardDescription ?? true}
                onChange={(e) => updateContent('showCardDescription', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="showCardDescription" className="cursor-pointer">Show Card Descriptions</Label>
            </div>

            {content.showCardDescription !== false && (
              <div>
                <Label className="text-xs">Description Max Lines: {content.descriptionLineClamp || 3}</Label>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={content.descriptionLineClamp || 3}
                  onChange={(e) => updateContent('descriptionLineClamp', parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Title Font Size (px)</Label>
                <Input
                  type="number"
                  value={content.cardTitleFontSize ?? 20}
                  onChange={(e) => updateContent('cardTitleFontSize', parseInt(e.target.value) || 20)}
                  min="12"
                  max="48"
                />
              </div>
              <div>
                <Label className="text-xs">Title Color</Label>
                <input
                  type="color"
                  value={safeHexColor(content.cardTitleColor, '#0f172a')}
                  onChange={(e) => updateContent('cardTitleColor', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Description Font Size (px)</Label>
                <Input
                  type="number"
                  value={content.cardDescriptionFontSize ?? 14}
                  onChange={(e) => updateContent('cardDescriptionFontSize', parseInt(e.target.value) || 14)}
                  min="10"
                  max="24"
                />
              </div>
              <div>
                <Label className="text-xs">Description Color</Label>
                <input
                  type="color"
                  value={safeHexColor(content.cardDescriptionColor, '#64748b')}
                  onChange={(e) => updateContent('cardDescriptionColor', e.target.value)}
                  className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Button Options Section */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('buttonOptions')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Button Options</span>
          {expandedSections.buttonOptions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.buttonOptions && (
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="showCardButton"
                checked={content.showCardButton ?? true}
                onChange={(e) => updateContent('showCardButton', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="showCardButton" className="cursor-pointer">Show Card Buttons</Label>
            </div>

            {content.showCardButton !== false && (
              <>
                <div>
                  <Label className="text-xs">Default Button Text</Label>
                  <Input
                    value={content.cardButtonText || 'Learn More'}
                    onChange={(e) => updateContent('cardButtonText', e.target.value)}
                    placeholder="Learn More"
                  />
                  <p className="text-xs text-slate-500 mt-1">This can be overridden per-card in Card Deck Management</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Button Background</Label>
                    <input
                      type="color"
                      value={safeHexColor(content.cardButtonBgColor, '#2563eb')}
                      onChange={(e) => updateContent('cardButtonBgColor', e.target.value)}
                      className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Button Text Color</Label>
                    <input
                      type="color"
                      value={safeHexColor(content.cardButtonTextColor, '#ffffff')}
                      onChange={(e) => updateContent('cardButtonTextColor', e.target.value)}
                      className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
