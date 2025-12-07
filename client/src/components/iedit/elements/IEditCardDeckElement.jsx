import React from "react";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Upload, Loader2, Trash2, ArrowRight, ExternalLink, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

export function IEditCardDeckElementEditor({ element, onChange }) {
  const [isUploadingBg, setIsUploadingBg] = React.useState(false);
  
  const defaultContent = {
    headerText: '',
    subheaderText: '',
    heading_font_family: 'Poppins',
    heading_font_size: 36,
    heading_font_size_mobile: 28,
    heading_letter_spacing: 0,
    heading_color: '#0f172a',
    heading_underline_enabled: false,
    heading_underline_color: '#000000',
    heading_underline_width: 100,
    heading_underline_weight: 2,
    heading_underline_spacing: 16,
    heading_underline_to_content_spacing: 24,
    heading_underline_alignment: 'center',
    subheading_font_family: 'Poppins',
    subheading_font_size: 18,
    subheading_font_size_mobile: 16,
    subheading_color: '#64748b',
    text_align: 'center',
    backgroundColor: '#ffffff',
    gradient_enabled: false,
    gradient_start_color: '#3b82f6',
    gradient_end_color: '#8b5cf6',
    gradient_angle: 135,
    backgroundImage: '',
    padding_top: 48,
    padding_bottom: 48,
    padding_left: 16,
    padding_right: 16,
    cardCount: 3,
    cardIds: ['', '', '', '', '', ''],
    cardHeight: 'auto',
    cardMinHeight: 300,
    cardBorderRadius: 12,
    cardBackgroundColor: '#ffffff',
    cardShadow: true,
    showCardImage: true,
    imageHeightPercent: 50,
    showCardDescription: true,
    descriptionLineClamp: 3,
    showCardButton: true,
    cardButtonText: 'Learn More',
    cardButtonBgColor: '#2563eb',
    cardButtonTextColor: '#ffffff',
    cardTitleFontSize: 20,
    cardTitleFontSize_mobile: 18,
    cardTitleColor: '#0f172a',
    cardDescriptionFontSize: 14,
    cardDescriptionColor: '#64748b',
    gap: 24
  };
  
  const [content, setContent] = React.useState({ ...defaultContent, ...(element.content || {}) });

  const { data: cards = [] } = useQuery({
    queryKey: ['card-deck-list'],
    queryFn: () => base44.entities.CardDeck.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const activeCards = cards.filter(c => c.status === 'active');

  const updateContent = (key, value) => {
    const newContent = { ...content, [key]: value };
    setContent(newContent);
    onChange({ ...element, content: newContent });
  };

  const updateCardId = (index, value) => {
    const newCardIds = Array.isArray(content.cardIds) ? [...content.cardIds] : ['', '', '', '', '', ''];
    newCardIds[index] = value;
    updateContent('cardIds', newCardIds);
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

  const cardCount = content.cardCount || 3;
  const cardSlots = Array(cardCount).fill(null);

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="headerText">Section Header</Label>
        <Input
          id="headerText"
          value={content.headerText || ''}
          onChange={(e) => updateContent('headerText', e.target.value)}
          placeholder="Featured Cards"
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
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Header Settings</summary>
        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="heading_font_family">Font</Label>
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
              <Label htmlFor="heading_font_size">Size (px)</Label>
              <Input
                id="heading_font_size"
                type="number"
                value={content.heading_font_size || 36}
                onChange={(e) => updateContent('heading_font_size', parseInt(e.target.value) || 36)}
                min="12"
                max="100"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="heading_color">Color</Label>
            <div className="flex gap-2">
              <input
                id="heading_color"
                type="color"
                value={content.heading_color || '#0f172a'}
                onChange={(e) => updateContent('heading_color', e.target.value)}
                className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <Input
                value={content.heading_color || '#0f172a'}
                onChange={(e) => updateContent('heading_color', e.target.value)}
                className="flex-1"
              />
            </div>
          </div>
        </div>
      </details>

      <div>
        <Label htmlFor="subheaderText">Subheader (Optional)</Label>
        <Textarea
          id="subheaderText"
          value={content.subheaderText || ''}
          onChange={(e) => updateContent('subheaderText', e.target.value)}
          placeholder="Optional description text..."
          rows={2}
        />
      </div>

      <div>
        <Label htmlFor="text_align">Text Alignment</Label>
        <Select
          value={content.text_align || 'center'}
          onValueChange={(value) => updateContent('text_align', value)}
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

      <div>
        <Label htmlFor="cardCount">Number of Cards</Label>
        <Select
          value={String(content.cardCount || 3)}
          onValueChange={(value) => updateContent('cardCount', parseInt(value))}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2 Cards</SelectItem>
            <SelectItem value="3">3 Cards</SelectItem>
            <SelectItem value="4">4 Cards</SelectItem>
            <SelectItem value="6">6 Cards</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Select Cards</Label>
        <p className="text-xs text-slate-500 mb-2">Choose cards from your Card Deck to display</p>
        <div className="space-y-2">
          {cardSlots.map((_, index) => (
            <Select
              key={index}
              value={(Array.isArray(content.cardIds) && content.cardIds[index]) || ''}
              onValueChange={(value) => updateCardId(index, value)}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={`Card ${index + 1} (optional)`} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                {activeCards.map((card) => (
                  <SelectItem key={card.id} value={card.id}>
                    {card.title}
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
                className="flex-1"
              />
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
            className="mt-2 w-full h-24 object-cover rounded"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="padding_top">Padding Top (px)</Label>
          <Input
            id="padding_top"
            type="number"
            value={content.padding_top ?? 48}
            onChange={(e) => updateContent('padding_top', parseInt(e.target.value) || 0)}
            min="0"
            max="200"
          />
        </div>
        <div>
          <Label htmlFor="padding_bottom">Padding Bottom (px)</Label>
          <Input
            id="padding_bottom"
            type="number"
            value={content.padding_bottom ?? 48}
            onChange={(e) => updateContent('padding_bottom', parseInt(e.target.value) || 0)}
            min="0"
            max="200"
          />
        </div>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Card Styling Options</summary>
        <div className="mt-2 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cardBorderRadius">Border Radius (px)</Label>
              <Input
                id="cardBorderRadius"
                type="number"
                value={content.cardBorderRadius ?? 12}
                onChange={(e) => updateContent('cardBorderRadius', parseInt(e.target.value) || 0)}
                min="0"
                max="50"
              />
            </div>
            <div>
              <Label htmlFor="gap">Card Gap (px)</Label>
              <Input
                id="gap"
                type="number"
                value={content.gap ?? 24}
                onChange={(e) => updateContent('gap', parseInt(e.target.value) || 0)}
                min="0"
                max="100"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="cardBackgroundColor">Card Background</Label>
            <div className="flex gap-2">
              <input
                id="cardBackgroundColor"
                type="color"
                value={content.cardBackgroundColor || '#ffffff'}
                onChange={(e) => updateContent('cardBackgroundColor', e.target.value)}
                className="w-16 h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <Input
                value={content.cardBackgroundColor || '#ffffff'}
                onChange={(e) => updateContent('cardBackgroundColor', e.target.value)}
                className="flex-1"
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
            <Label htmlFor="cardShadow" className="cursor-pointer">
              Show Card Shadow
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="showCardImage"
              checked={content.showCardImage ?? true}
              onChange={(e) => updateContent('showCardImage', e.target.checked)}
              className="w-4 h-4"
            />
            <Label htmlFor="showCardImage" className="cursor-pointer">
              Show Card Images
            </Label>
          </div>

          {content.showCardImage !== false && (
            <div>
              <Label htmlFor="imageHeightPercent">Image Height (%)</Label>
              <Input
                id="imageHeightPercent"
                type="number"
                value={content.imageHeightPercent ?? 50}
                onChange={(e) => updateContent('imageHeightPercent', parseInt(e.target.value) || 50)}
                min="20"
                max="80"
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
            <Label htmlFor="showCardDescription" className="cursor-pointer">
              Show Card Descriptions
            </Label>
          </div>

          {content.showCardDescription !== false && (
            <div>
              <Label htmlFor="descriptionLineClamp">Description Max Lines</Label>
              <Input
                id="descriptionLineClamp"
                type="number"
                value={content.descriptionLineClamp ?? 3}
                onChange={(e) => updateContent('descriptionLineClamp', parseInt(e.target.value) || 3)}
                min="1"
                max="10"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cardTitleFontSize">Title Font Size (px)</Label>
              <Input
                id="cardTitleFontSize"
                type="number"
                value={content.cardTitleFontSize ?? 20}
                onChange={(e) => updateContent('cardTitleFontSize', parseInt(e.target.value) || 20)}
                min="12"
                max="48"
              />
            </div>
            <div>
              <Label htmlFor="cardTitleColor">Title Color</Label>
              <input
                id="cardTitleColor"
                type="color"
                value={content.cardTitleColor || '#0f172a'}
                onChange={(e) => updateContent('cardTitleColor', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cardDescriptionFontSize">Description Font Size (px)</Label>
              <Input
                id="cardDescriptionFontSize"
                type="number"
                value={content.cardDescriptionFontSize ?? 14}
                onChange={(e) => updateContent('cardDescriptionFontSize', parseInt(e.target.value) || 14)}
                min="10"
                max="24"
              />
            </div>
            <div>
              <Label htmlFor="cardDescriptionColor">Description Color</Label>
              <input
                id="cardDescriptionColor"
                type="color"
                value={content.cardDescriptionColor || '#64748b'}
                onChange={(e) => updateContent('cardDescriptionColor', e.target.value)}
                className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
            </div>
          </div>
        </div>
      </details>

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Button Options</summary>
        <div className="mt-2 space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="showCardButton"
              checked={content.showCardButton ?? true}
              onChange={(e) => updateContent('showCardButton', e.target.checked)}
              className="w-4 h-4"
            />
            <Label htmlFor="showCardButton" className="cursor-pointer">
              Show Card Buttons
            </Label>
          </div>

          {content.showCardButton !== false && (
            <>
              <div>
                <Label htmlFor="cardButtonText">Default Button Text</Label>
                <Input
                  id="cardButtonText"
                  value={content.cardButtonText || 'Learn More'}
                  onChange={(e) => updateContent('cardButtonText', e.target.value)}
                  placeholder="Learn More"
                />
                <p className="text-xs text-slate-500 mt-1">This can be overridden per-card in Card Deck Management</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="cardButtonBgColor">Button Background</Label>
                  <input
                    id="cardButtonBgColor"
                    type="color"
                    value={content.cardButtonBgColor || '#2563eb'}
                    onChange={(e) => updateContent('cardButtonBgColor', e.target.value)}
                    className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
                <div>
                  <Label htmlFor="cardButtonTextColor">Button Text Color</Label>
                  <input
                    id="cardButtonTextColor"
                    type="color"
                    value={content.cardButtonTextColor || '#ffffff'}
                    onChange={(e) => updateContent('cardButtonTextColor', e.target.value)}
                    className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </details>
    </div>
  );
}

export function IEditCardDeckElementRenderer({ element, settings }) {
  const defaultContent = {
    headerText: '',
    subheaderText: '',
    heading_font_family: 'Poppins',
    heading_font_size: 36,
    heading_font_size_mobile: 28,
    heading_letter_spacing: 0,
    heading_color: '#0f172a',
    heading_underline_enabled: false,
    heading_underline_color: '#000000',
    heading_underline_width: 100,
    heading_underline_weight: 2,
    heading_underline_spacing: 16,
    heading_underline_to_content_spacing: 24,
    heading_underline_alignment: 'center',
    subheading_font_family: 'Poppins',
    subheading_font_size: 18,
    subheading_font_size_mobile: 16,
    subheading_color: '#64748b',
    text_align: 'center',
    backgroundColor: '#ffffff',
    gradient_enabled: false,
    gradient_start_color: '#3b82f6',
    gradient_end_color: '#8b5cf6',
    gradient_angle: 135,
    backgroundImage: '',
    padding_top: 48,
    padding_bottom: 48,
    padding_left: 16,
    padding_right: 16,
    cardCount: 3,
    cardIds: ['', '', '', '', '', ''],
    cardHeight: 'auto',
    cardMinHeight: 300,
    cardBorderRadius: 12,
    cardBackgroundColor: '#ffffff',
    cardShadow: true,
    showCardImage: true,
    imageHeightPercent: 50,
    showCardDescription: true,
    descriptionLineClamp: 3,
    showCardButton: true,
    cardButtonText: 'Learn More',
    cardButtonBgColor: '#2563eb',
    cardButtonTextColor: '#ffffff',
    cardTitleFontSize: 20,
    cardTitleFontSize_mobile: 18,
    cardTitleColor: '#0f172a',
    cardDescriptionFontSize: 14,
    cardDescriptionColor: '#64748b',
    gap: 24
  };

  const content = { ...defaultContent, ...(element?.content || {}) };

  const { data: allCards = [] } = useQuery({
    queryKey: ['card-deck-render'],
    queryFn: () => base44.entities.CardDeck.list('display_order'),
    staleTime: 0,
  });

  const cardIds = Array.isArray(content.cardIds) ? content.cardIds.filter(id => id) : [];
  const selectedCards = cardIds
    .map(id => allCards.find(c => c.id === id))
    .filter(Boolean);

  const [isMobile, setIsMobile] = React.useState(false);
  
  React.useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const backgroundStyle = React.useMemo(() => {
    const style = {};
    
    if (content.backgroundImage) {
      style.backgroundImage = `url(${content.backgroundImage})`;
      style.backgroundSize = 'cover';
      style.backgroundPosition = 'center';
    } else if (content.gradient_enabled) {
      style.background = `linear-gradient(${content.gradient_angle || 135}deg, ${content.gradient_start_color || '#3b82f6'}, ${content.gradient_end_color || '#8b5cf6'})`;
    } else {
      style.backgroundColor = content.backgroundColor || '#ffffff';
    }

    style.paddingTop = `${content.padding_top ?? 48}px`;
    style.paddingBottom = `${content.padding_bottom ?? 48}px`;
    style.paddingLeft = `${content.padding_left ?? 16}px`;
    style.paddingRight = `${content.padding_right ?? 16}px`;

    return style;
  }, [content]);

  const headingStyle = {
    fontFamily: content.heading_font_family || 'Poppins',
    fontSize: isMobile ? `${content.heading_font_size_mobile || 28}px` : `${content.heading_font_size || 36}px`,
    letterSpacing: `${content.heading_letter_spacing || 0}px`,
    color: content.heading_color || '#0f172a',
    textAlign: content.text_align || 'center',
    marginBottom: content.heading_underline_enabled 
      ? `${content.heading_underline_spacing || 16}px` 
      : (content.subheaderText ? '8px' : '24px')
  };

  const subheadingStyle = {
    fontFamily: content.subheading_font_family || 'Poppins',
    fontSize: isMobile ? `${content.subheading_font_size_mobile || 16}px` : `${content.subheading_font_size || 18}px`,
    color: content.subheading_color || '#64748b',
    textAlign: content.text_align || 'center',
    marginBottom: content.heading_underline_enabled 
      ? 0 
      : `${content.heading_underline_to_content_spacing || 24}px`
  };

  const getGridColumns = () => {
    const count = content.cardCount || 3;
    if (isMobile) return 1;
    if (count === 2) return 2;
    if (count === 3) return 3;
    if (count === 4) return 2;
    if (count === 6) return 3;
    return 3;
  };

  const handleCardClick = (card) => {
    if (card.target_url) {
      window.open(card.target_url, '_blank');
    }
  };

  if (selectedCards.length === 0) {
    return (
      <div style={backgroundStyle}>
        <div className="max-w-7xl mx-auto text-center py-12">
          <ImageIcon className="w-16 h-16 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-500">No cards selected. Edit this element to choose cards from your Card Deck.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={backgroundStyle}>
      <div className="max-w-7xl mx-auto">
        {content.headerText && (
          <>
            <h2 style={headingStyle}>{content.headerText}</h2>
            {content.heading_underline_enabled && (
              <div
                style={{
                  width: `${content.heading_underline_width || 100}px`,
                  height: `${content.heading_underline_weight || 2}px`,
                  backgroundColor: content.heading_underline_color || '#000000',
                  margin: content.heading_underline_alignment === 'center' ? '0 auto' : 
                          content.heading_underline_alignment === 'right' ? '0 0 0 auto' : '0',
                  marginBottom: `${content.heading_underline_to_content_spacing || 24}px`
                }}
              />
            )}
          </>
        )}

        {content.subheaderText && (
          <p style={subheadingStyle}>{content.subheaderText}</p>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${getGridColumns()}, 1fr)`,
            gap: `${content.gap || 24}px`
          }}
        >
          {selectedCards.map((card) => (
            <div
              key={card.id}
              onClick={() => handleCardClick(card)}
              style={{
                backgroundColor: content.cardBackgroundColor || '#ffffff',
                borderRadius: `${content.cardBorderRadius || 12}px`,
                overflow: 'hidden',
                cursor: card.target_url ? 'pointer' : 'default',
                boxShadow: content.cardShadow !== false ? '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)' : 'none',
                transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                display: 'flex',
                flexDirection: 'column'
              }}
              className="hover:shadow-lg hover:scale-[1.02]"
              data-testid={`card-deck-card-${card.id}`}
            >
              {content.showCardImage !== false && card.image_url && (
                <div
                  style={{
                    height: `${content.imageHeightPercent || 50}%`,
                    minHeight: '150px'
                  }}
                >
                  <img
                    src={card.image_url}
                    alt={card.title}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover'
                    }}
                  />
                </div>
              )}

              <div style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <h3
                  style={{
                    fontSize: isMobile ? `${content.cardTitleFontSize_mobile || 18}px` : `${content.cardTitleFontSize || 20}px`,
                    color: content.cardTitleColor || '#0f172a',
                    fontWeight: 600,
                    marginBottom: '12px',
                    lineHeight: 1.3
                  }}
                >
                  {card.title}
                </h3>

                {content.showCardDescription !== false && card.description && (
                  <p
                    style={{
                      fontSize: `${content.cardDescriptionFontSize || 14}px`,
                      color: content.cardDescriptionColor || '#64748b',
                      lineHeight: 1.6,
                      flex: 1,
                      WebkitLineClamp: content.descriptionLineClamp || 3,
                      display: '-webkit-box',
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden'
                    }}
                  >
                    {card.description}
                  </p>
                )}

                {content.showCardButton !== false && card.target_url && (
                  <div style={{ marginTop: '16px' }}>
                    <button
                      style={{
                        backgroundColor: content.cardButtonBgColor || '#2563eb',
                        color: content.cardButtonTextColor || '#ffffff',
                        padding: '10px 20px',
                        borderRadius: '8px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 500,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        transition: 'opacity 0.2s ease'
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(card.target_url, '_blank');
                      }}
                      className="hover:opacity-90"
                    >
                      {card.button_text || content.cardButtonText || 'Learn More'}
                      <ArrowRight style={{ width: '16px', height: '16px' }} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
