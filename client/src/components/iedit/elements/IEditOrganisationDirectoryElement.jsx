import React, { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Search, Globe, Users, Loader2, ChevronLeft, ChevronRight, ArrowDownAZ, ArrowUpZA, AlignLeft, AlignCenter, AlignRight, ChevronDown, ChevronUp } from "lucide-react";
import TypographyStyleSelector, { applyTypographyStyle, useTypographyStyles } from "../TypographyStyleSelector";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import DOMPurify from 'dompurify';
import { isDeletedMember } from "@/utils";

const directoryQuillModules = {
  toolbar: [
    ['bold', 'italic', 'underline'],
    ['link'],
    ['clean']
  ]
};

const fontFamilies = [
  'Poppins', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 
  'Playfair Display', 'Merriweather', 'Source Sans Pro', 'Raleway',
  'Nunito', 'Work Sans', 'DM Sans', 'Outfit'
];

const fontWeights = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semi Bold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' }
];

export function IEditOrganisationDirectoryElementEditor({ element, onChange }) {
  const defaultContent = {
    backgroundColor: '#f8fafc',
    showSearch: true,
    showSortFilter: true,
    showPagination: true,
    showLogo: true,
    showTitle: true,
    showDomains: false,
    showMemberCount: false,
    showNameTooltip: false,
    columns: '3',
    rowsPerPage: '4',
    cardBorderRadius: 8,
    // Section header fields
    header_title: '',
    header_subtitle: '',
    header_content: '',
    header_font_family: 'Poppins',
    header_font_size: 32,
    header_font_size_mobile: 24,
    header_font_weight: 700,
    header_color: '#1e293b',
    header_line_height: 1.2,
    header_letter_spacing: 0,
    subtitle_font_family: 'Poppins',
    subtitle_font_size: 18,
    subtitle_font_size_mobile: 16,
    subtitle_font_weight: 400,
    subtitle_color: '#64748b',
    subtitle_line_height: 1.5,
    subtitle_letter_spacing: 0,
    content_font_family: 'Poppins',
    content_font_size: 16,
    content_font_size_mobile: 14,
    content_font_weight: 400,
    content_color: '#475569',
    content_line_height: 1.6,
    content_letter_spacing: 0,
  };
  
  const [content, setContent] = React.useState({ ...defaultContent, ...(element.content || {}) });
  const [expandedSections, setExpandedSections] = useState({
    sectionHeader: false
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    const newContent = { ...content, [key]: value };
    setContent(newContent);
    onChange({ ...element, content: newContent });
  };

  const updateMultipleContent = (updates) => {
    const newContent = { ...content, ...updates };
    setContent(newContent);
    onChange({ ...element, content: newContent });
  };

  const AlignmentButtons = ({ value, onChange: onAlignChange, label, testIdPrefix }) => (
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
            className={`p-2 rounded border ${
              value === val 
                ? 'bg-blue-600 text-white border-blue-600' 
                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
            }`}
            data-testid={`${testIdPrefix}-${val}`}
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
      </div>
    </div>
  );

  const renderTypographyControls = (prefix, label, defaultValues = {}) => {
    const defaults = {
      font_family: 'Poppins',
      font_weight: prefix.includes('header') ? 700 : 400,
      font_size: prefix.includes('header') ? 32 : (prefix.includes('subtitle') ? 18 : 16),
      color: '#1e293b',
      letter_spacing: 0,
      line_height: prefix.includes('header') ? 1.2 : 1.6,
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
            <Label className="text-xs">Color</Label>
            <div className="flex gap-1">
              <input
                type="color"
                value={content[`${prefix}_color`] || defaults.color}
                onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
                className="w-10 h-8 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
              />
              <Input
                value={content[`${prefix}_color`] || defaults.color}
                onChange={(e) => updateContent(`${prefix}_color`, e.target.value)}
                className="flex-1 h-8 font-mono text-xs"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Letter Spacing (px)</Label>
            <Input
              type="number"
              value={content[`${prefix}_letter_spacing`] ?? defaults.letter_spacing}
              onChange={(e) => updateContent(`${prefix}_letter_spacing`, parseFloat(e.target.value) || 0)}
              min="-5"
              max="20"
              step="0.5"
              className="h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Line Height</Label>
            <Input
              type="number"
              value={content[`${prefix}_line_height`] || defaults.line_height}
              onChange={(e) => updateContent(`${prefix}_line_height`, parseFloat(e.target.value) || defaults.line_height)}
              min="0.8"
              max="3"
              step="0.1"
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
          placeholder="e.g., directory-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-orgdirectory-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Section Header Accordion */}
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('sectionHeader')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Section Header (Optional)</span>
          {expandedSections.sectionHeader ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.sectionHeader && (
          <div className="p-4 space-y-6 bg-slate-50">
            {/* Header Title */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Header Title</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Title Text</Label>
                  <div className="directory-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.header_title || ''}
                      onChange={(value) => updateContent('header_title', value)}
                      modules={directoryQuillModules}
                      placeholder="Enter header title..."
                      style={{ minHeight: '80px' }}
                    />
                  </div>
                </div>
                <TypographyStyleSelector
                  value={content.header_typography_style_id || null}
                  onChange={(styleId, style) => {
                    const updates = { header_typography_style_id: styleId };
                    if (style) {
                      const mapped = applyTypographyStyle(style);
                      if (mapped.font_family) updates.header_font_family = mapped.font_family;
                      if (mapped.font_size) updates.header_font_size = mapped.font_size;
                      if (mapped.font_size_mobile) updates.header_font_size_mobile = mapped.font_size_mobile;
                      if (mapped.font_weight) updates.header_font_weight = mapped.font_weight;
                      if (mapped.line_height) updates.header_line_height = mapped.line_height;
                      if (mapped.letter_spacing !== undefined) updates.header_letter_spacing = mapped.letter_spacing;
                      if (mapped.color) updates.header_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  label="Header Title Typography Style"
                />
                <AlignmentButtons 
                  value={content.header_title_text_align || 'center'} 
                  onChange={(val) => updateContent('header_title_text_align', val)}
                  label="Alignment"
                  testIdPrefix="orgdir-header-title-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('header', 'Header Title Typography')}
                </details>
              </div>
            </div>

            {/* Header Subtitle */}
            <div className="border-b pb-4">
              <h5 className="font-medium text-sm mb-3">Header Subtitle</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Subtitle Text</Label>
                  <div className="directory-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.header_subtitle || ''}
                      onChange={(value) => updateContent('header_subtitle', value)}
                      modules={directoryQuillModules}
                      placeholder="Enter header subtitle..."
                      style={{ minHeight: '80px' }}
                    />
                  </div>
                </div>
                <TypographyStyleSelector
                  value={content.subtitle_typography_style_id || null}
                  onChange={(styleId, style) => {
                    const updates = { subtitle_typography_style_id: styleId };
                    if (style) {
                      const mapped = applyTypographyStyle(style);
                      if (mapped.font_family) updates.subtitle_font_family = mapped.font_family;
                      if (mapped.font_size) updates.subtitle_font_size = mapped.font_size;
                      if (mapped.font_size_mobile) updates.subtitle_font_size_mobile = mapped.font_size_mobile;
                      if (mapped.font_weight) updates.subtitle_font_weight = mapped.font_weight;
                      if (mapped.line_height) updates.subtitle_line_height = mapped.line_height;
                      if (mapped.letter_spacing !== undefined) updates.subtitle_letter_spacing = mapped.letter_spacing;
                      if (mapped.color) updates.subtitle_color = mapped.color;
                    }
                    updateMultipleContent(updates);
                  }}
                  label="Header Subtitle Typography Style"
                />
                <AlignmentButtons 
                  value={content.header_subtitle_text_align || 'center'} 
                  onChange={(val) => updateContent('header_subtitle_text_align', val)}
                  label="Alignment"
                  testIdPrefix="orgdir-header-subtitle-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('subtitle', 'Header Subtitle Typography')}
                </details>
              </div>
            </div>

            {/* Header Content */}
            <div>
              <h5 className="font-medium text-sm mb-3">Header Content</h5>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Content Text</Label>
                  <div className="directory-quill-editor border border-slate-300 rounded-md overflow-hidden bg-white">
                    <ReactQuill
                      theme="snow"
                      value={content.header_content || ''}
                      onChange={(value) => updateContent('header_content', value)}
                      modules={directoryQuillModules}
                      placeholder="Enter header content..."
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
                  label="Header Content Typography Style"
                />
                <AlignmentButtons 
                  value={content.header_content_text_align || 'center'} 
                  onChange={(val) => updateContent('header_content_text_align', val)}
                  label="Alignment"
                  testIdPrefix="orgdir-header-content-align"
                />
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
                  {renderTypographyControls('content', 'Header Content Typography')}
                </details>
              </div>
            </div>
          </div>
        )}
      </div>

      <div>
        <Label htmlFor="backgroundColor">Background Color</Label>
        <input
          id="backgroundColor"
          type="color"
          value={content.backgroundColor || '#f8fafc'}
          onChange={(e) => updateContent('backgroundColor', e.target.value)}
          className="w-full h-10 px-1 py-1 border border-slate-300 rounded-md cursor-pointer"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="columns">Cards Per Row (Desktop)</Label>
          <Select
            value={content.columns || '3'}
            onValueChange={(value) => updateContent('columns', value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
              <SelectItem value="4">4</SelectItem>
              <SelectItem value="5">5</SelectItem>
              <SelectItem value="6">6</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="mobileColumns">Cards Per Row (Mobile)</Label>
          <Select
            value={content.mobile_columns_per_row || '1'}
            onValueChange={(value) => updateContent('mobile_columns_per_row', value)}
          >
            <SelectTrigger data-testid="select-mobile-columns">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1</SelectItem>
              <SelectItem value="2">2</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="rowsPerPage">Rows Per Page</Label>
        <Select
          value={content.rowsPerPage || '4'}
          onValueChange={(value) => updateContent('rowsPerPage', value)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2 Rows</SelectItem>
            <SelectItem value="3">3 Rows</SelectItem>
            <SelectItem value="4">4 Rows</SelectItem>
            <SelectItem value="5">5 Rows</SelectItem>
            <SelectItem value="6">6 Rows</SelectItem>
            <SelectItem value="8">8 Rows</SelectItem>
            <SelectItem value="10">10 Rows</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="cardBorderRadius">Card Border Radius (px)</Label>
        <Input
          id="cardBorderRadius"
          type="number"
          value={content.cardBorderRadius || 8}
          onChange={(e) => updateContent('cardBorderRadius', parseInt(e.target.value) || 8)}
          min="0"
          max="32"
        />
      </div>

      <div className="space-y-3 p-3 bg-slate-50 rounded-lg">
        <p className="text-sm font-medium text-slate-700">Display Options</p>
        
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showSearch"
            checked={content.showSearch !== false}
            onChange={(e) => updateContent('showSearch', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showSearch" className="cursor-pointer">
            Show Search Bar
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showSortFilter"
            checked={content.showSortFilter !== false}
            onChange={(e) => updateContent('showSortFilter', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showSortFilter" className="cursor-pointer">
            Show A-Z / Z-A Sort Filter
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showPagination"
            checked={content.showPagination !== false}
            onChange={(e) => updateContent('showPagination', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showPagination" className="cursor-pointer">
            Show Pagination Controls
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showLogo"
            checked={content.showLogo !== false}
            onChange={(e) => updateContent('showLogo', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showLogo" className="cursor-pointer">
            Show Organisation Logo
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showTitle"
            checked={content.showTitle !== false}
            onChange={(e) => updateContent('showTitle', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showTitle" className="cursor-pointer">
            Show Organisation Name
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showDomains"
            checked={content.showDomains || false}
            onChange={(e) => updateContent('showDomains', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showDomains" className="cursor-pointer">
            Show Domains
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showMemberCount"
            checked={content.showMemberCount || false}
            onChange={(e) => updateContent('showMemberCount', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showMemberCount" className="cursor-pointer">
            Show Member Count
          </Label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showNameTooltip"
            checked={content.showNameTooltip || false}
            onChange={(e) => updateContent('showNameTooltip', e.target.checked)}
            className="w-4 h-4"
          />
          <Label htmlFor="showNameTooltip" className="cursor-pointer">
            Show Name Tooltip on Hover
          </Label>
        </div>
      </div>
    </div>
  );
}

export function IEditOrganisationDirectoryElementRenderer({ content, settings }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);
  const isMobile = useIsMobile();
  const { getStyleById } = useTypographyStyles();
  const { memberInfo } = useMemberAccess();

  // Handler for clicking organization card - checks auth and redirects appropriately
  const handleOrgCardClick = (orgId) => {
    if (!memberInfo) {
      // User not logged in - redirect to login with return URL
      window.location.href = `/login?redirect=${encodeURIComponent(`/memberdirectory?org=${orgId}`)}`;
    } else {
      // User is logged in - navigate to member directory
      window.location.href = `/memberdirectory?org=${orgId}`;
    }
  };

  const {
    anchor,
    backgroundColor = '#f8fafc',
    showSearch = true,
    showSortFilter = true,
    showPagination = true,
    showLogo = true,
    showTitle = true,
    showDomains = false,
    showMemberCount = false,
    showNameTooltip = false,
    columns = '3',
    mobile_columns_per_row = '1',
    rowsPerPage = '4',
    cardBorderRadius = 8,
    // Section header fields
    header_title = '',
    header_subtitle = '',
    header_content = '',
    header_title_text_align = 'center',
    header_subtitle_text_align = 'center',
    header_content_text_align = 'center',
    header_font_family = 'Poppins',
    header_font_size = 32,
    header_font_size_mobile = 24,
    header_font_weight = 700,
    header_color = '#1e293b',
    header_line_height = 1.2,
    header_letter_spacing = 0,
    subtitle_font_family = 'Poppins',
    subtitle_font_size = 18,
    subtitle_font_size_mobile = 16,
    subtitle_font_weight = 400,
    subtitle_color = '#64748b',
    subtitle_line_height = 1.5,
    subtitle_letter_spacing = 0,
    content_font_family = 'Poppins',
    content_font_size = 16,
    content_font_size_mobile = 14,
    content_font_weight = 400,
    content_color = '#475569',
    content_line_height = 1.6,
    content_letter_spacing = 0,
  } = content || {};

  // Helper to check if a text value has actual content
  const hasContent = (value) => {
    if (!value) return false;
    const stripped = value.replace(/<[^>]*>/g, '').trim();
    return stripped.length > 0;
  };

  const hasHeaderTitle = hasContent(header_title);
  const hasHeaderSubtitle = hasContent(header_subtitle);
  const hasHeaderContentText = hasContent(header_content);
  const hasHeaderSection = hasHeaderTitle || hasHeaderSubtitle || hasHeaderContentText;

  const headerTypographyStyle = getStyleById(content?.header_typography_style_id);
  const subtitleTypographyStyle = getStyleById(content?.subtitle_typography_style_id);
  const contentTypographyStyle = getStyleById(content?.content_typography_style_id);

  const getHeaderTitleStyle = () => {
    const effectiveFontSizeMobile = headerTypographyStyle?.font_size_mobile || header_font_size_mobile;
    return {
      fontFamily: headerTypographyStyle?.font_family || header_font_family,
      fontSize: `${isMobile && effectiveFontSizeMobile ? effectiveFontSizeMobile : (headerTypographyStyle?.font_size || header_font_size)}px`,
      fontWeight: headerTypographyStyle?.font_weight || header_font_weight,
      color: headerTypographyStyle?.color || header_color,
      lineHeight: headerTypographyStyle?.line_height || header_line_height,
      letterSpacing: `${headerTypographyStyle?.letter_spacing ?? header_letter_spacing}px`,
      textAlign: header_title_text_align
    };
  };

  const getSubtitleStyle = () => {
    const effectiveFontSizeMobile = subtitleTypographyStyle?.font_size_mobile || subtitle_font_size_mobile;
    return {
      fontFamily: subtitleTypographyStyle?.font_family || subtitle_font_family,
      fontSize: `${isMobile && effectiveFontSizeMobile ? effectiveFontSizeMobile : (subtitleTypographyStyle?.font_size || subtitle_font_size)}px`,
      fontWeight: subtitleTypographyStyle?.font_weight || subtitle_font_weight,
      color: subtitleTypographyStyle?.color || subtitle_color,
      lineHeight: subtitleTypographyStyle?.line_height || subtitle_line_height,
      letterSpacing: `${subtitleTypographyStyle?.letter_spacing ?? subtitle_letter_spacing}px`,
      textAlign: header_subtitle_text_align
    };
  };

  const getContentStyle = () => {
    const effectiveFontSizeMobile = contentTypographyStyle?.font_size_mobile || content_font_size_mobile;
    return {
      fontFamily: contentTypographyStyle?.font_family || content_font_family,
      fontSize: `${isMobile && effectiveFontSizeMobile ? effectiveFontSizeMobile : (contentTypographyStyle?.font_size || content_font_size)}px`,
      fontWeight: contentTypographyStyle?.font_weight || content_font_weight,
      color: contentTypographyStyle?.color || content_color,
      lineHeight: contentTypographyStyle?.line_height || content_line_height,
      letterSpacing: `${contentTypographyStyle?.letter_spacing ?? content_letter_spacing}px`,
      textAlign: header_content_text_align
    };
  };

  const { data: organizations = [], isLoading } = useQuery({
    queryKey: ['organizations-element'],
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    },
    staleTime: 2 * 60 * 1000, // Cache for 2 minutes to prevent refetch flickering
    refetchOnMount: true
  });

  const { data: displaySettings } = useQuery({
    queryKey: ['org-directory-settings-element'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const excludedOrgsSetting = allSettings.find(s => s.setting_key === 'org_directory_excluded_orgs');
      const nameTooltipSetting = allSettings.find(s => s.setting_key === 'org_directory_show_name_tooltip');
      const titleSetting = allSettings.find(s => s.setting_key === 'org_directory_show_title');
      const allowedStatusesSetting = allSettings.find(s => s.setting_key === 'org_directory_allowed_application_statuses');
      
      let excludedOrgIds = [];
      if (excludedOrgsSetting) {
        try {
          excludedOrgIds = JSON.parse(excludedOrgsSetting.setting_value);
        } catch {
          excludedOrgIds = [];
        }
      }

      let allowedApplicationStatuses = [];
      if (allowedStatusesSetting) {
        try {
          allowedApplicationStatuses = JSON.parse(allowedStatusesSetting.setting_value);
        } catch {
          allowedApplicationStatuses = [];
        }
      }
      
      return { 
        excludedOrgIds,
        globalShowNameTooltip: nameTooltipSetting?.setting_value === 'true',
        globalShowTitle: titleSetting?.setting_value !== 'false',
        allowedApplicationStatuses
      };
    },
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes to prevent refetch flickering
  });

  // Fetch organization custom fields to find application_status
  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['org-custom-fields-for-directory-element'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' }
        });
        return fields || [];
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true }
          });
          return (allFields || []).filter(f => f.entity_scope === 'organization');
        } catch {
          return [];
        }
      }
    },
    staleTime: 5 * 60 * 1000
  });

  // Find the application_status field
  const applicationStatusField = useMemo(() => {
    return orgCustomFields.find(f => f.name === 'application_status');
  }, [orgCustomFields]);

  // Fetch organization preference values for filtering
  const { data: allOrgPreferenceValues = [] } = useQuery({
    queryKey: ['all-org-preference-values-for-directory-element'],
    enabled: !!applicationStatusField && (displaySettings?.allowedApplicationStatuses?.length > 0),
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list();
        return values || [];
      } catch {
        return [];
      }
    },
    staleTime: 60 * 1000
  });

  // Build a lookup map: organization_id -> { field_id -> value }
  const orgPreferenceMap = useMemo(() => {
    const map = {};
    
    const extractPrimitiveValue = (val) => {
      if (val === null || val === undefined) return val;
      if (typeof val === 'object' && !Array.isArray(val) && val.value !== undefined) {
        return val.value;
      }
      if (Array.isArray(val)) {
        return val.map(item => {
          if (typeof item === 'object' && item !== null && item.value !== undefined) {
            return item.value;
          }
          return item;
        });
      }
      return val;
    };
    
    allOrgPreferenceValues.forEach(pv => {
      if (!map[pv.organization_id]) {
        map[pv.organization_id] = {};
      }
      let normalizedValue = pv.value;
      if (typeof pv.value === 'string') {
        try {
          const parsed = JSON.parse(pv.value);
          normalizedValue = extractPrimitiveValue(parsed);
        } catch {
          normalizedValue = extractPrimitiveValue(pv.value);
        }
      } else {
        normalizedValue = extractPrimitiveValue(pv.value);
      }
      map[pv.organization_id][pv.field_id] = normalizedValue;
    });
    return map;
  }, [allOrgPreferenceValues]);

  // Use global settings as fallback for showNameTooltip and showTitle
  const effectiveShowNameTooltip = showNameTooltip || displaySettings?.globalShowNameTooltip;
  const effectiveShowTitle = showTitle && (displaySettings?.globalShowTitle !== false);

  const { data: members = [] } = useQuery({
    queryKey: ['members-for-org-directory-element'],
    queryFn: async () => {
      return await base44.entities.Member.listAll();
    },
    enabled: showMemberCount,
    staleTime: 2 * 60 * 1000 // Cache for 2 minutes to prevent refetch flickering
  });

  const organizationMemberCounts = useMemo(() => {
    if (!showMemberCount) return {};
    const counts = {};
    members.forEach((member) => {
      if (member.organization_id && !isDeletedMember(member)) {
        counts[member.organization_id] = (counts[member.organization_id] || 0) + 1;
      }
    });
    return counts;
  }, [members, showMemberCount]);

  const filteredOrganizations = useMemo(() => {
    const excludedIds = displaySettings?.excludedOrgIds || [];
    const allowedStatuses = displaySettings?.allowedApplicationStatuses || [];
    
    let filtered = organizations.filter(org => 
      !excludedIds.includes(org.id)
    );

    // Filter by application_status if allowedStatuses is configured
    if (allowedStatuses.length > 0 && applicationStatusField?.id) {
      filtered = filtered.filter(org => {
        const orgValues = orgPreferenceMap[org.id] || {};
        const statusValue = orgValues[applicationStatusField.id];
        
        if (!statusValue) return false;
        
        // Handle array values (picklist)
        if (Array.isArray(statusValue)) {
          return statusValue.some(v => allowedStatuses.includes(v));
        }
        
        // Handle single value (dropdown)
        return allowedStatuses.includes(statusValue);
      });
    }
    
    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      filtered = filtered.filter((org) =>
        org.name?.toLowerCase().includes(searchLower) ||
        org.domain?.toLowerCase().includes(searchLower)
      );
    }
    
    filtered.sort((a, b) => {
      const nameA = (a.name || '').toLowerCase();
      const nameB = (b.name || '').toLowerCase();
      if (sortOrder === 'asc') {
        return nameA.localeCompare(nameB);
      } else {
        return nameB.localeCompare(nameA);
      }
    });
    
    return filtered;
  }, [organizations, searchQuery, displaySettings?.excludedOrgIds, displaySettings?.allowedApplicationStatuses, sortOrder, applicationStatusField, orgPreferenceMap]);

  const columnsNum = parseInt(columns) || 3;
  const rowsPerPageNum = parseInt(rowsPerPage) || 4;
  const itemsPerPage = columnsNum * rowsPerPageNum;
  
  const totalPages = Math.ceil(filteredOrganizations.length / itemsPerPage);
  
  const displayedOrganizations = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredOrganizations.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredOrganizations, currentPage, itemsPerPage]);

  const getGridClass = () => {
    const mobileColClass = mobile_columns_per_row === '2' ? 'grid-cols-2' : 'grid-cols-1';
    switch (columns) {
      case '2':
        return `grid ${mobileColClass} md:grid-cols-2 gap-6`;
      case '3':
        return `grid ${mobileColClass} md:grid-cols-2 lg:grid-cols-3 gap-6`;
      case '4':
        return `grid ${mobileColClass} md:grid-cols-2 lg:grid-cols-4 gap-6`;
      case '5':
        return `grid ${mobileColClass} md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6`;
      case '6':
        return `grid ${mobileColClass} md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6`;
      default:
        return `grid ${mobileColClass} md:grid-cols-2 lg:grid-cols-3 gap-6`;
    }
  };

  if (isLoading) {
    return (
      <div 
        className="p-8 flex items-center justify-center"
        style={{ backgroundColor }}
      >
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div id={anchor || undefined} style={{ backgroundColor }} className="p-4 md:p-8">
      <div className={settings?.fullWidth ? 'px-4' : 'max-w-7xl mx-auto'}>
        {/* Section Header - only render if there's actual content */}
        {hasHeaderSection && (
          <div className="mb-8 space-y-2">
            {hasHeaderTitle && (
              <div 
                style={getHeaderTitleStyle()} 
                className="section-header-title"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_title) }}
              />
            )}
            {hasHeaderSubtitle && (
              <div 
                style={getSubtitleStyle()} 
                className="section-header-subtitle"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_subtitle) }}
              />
            )}
            {hasHeaderContentText && (
              <div 
                style={getContentStyle()} 
                className="max-w-3xl mx-auto section-header-content"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(header_content) }}
              />
            )}
          </div>
        )}

        {(showSearch || showSortFilter) && (
          <Card className="mb-6 border-slate-200">
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row gap-3">
                {showSearch && (
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      placeholder="Search organisations..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="pl-10"
                      data-testid="input-search-org-element"
                    />
                  </div>
                )}
                {showSortFilter && (
                  <Select value={sortOrder} onValueChange={setSortOrder}>
                    <SelectTrigger className="w-full sm:w-36" data-testid="select-sort-org-element">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="asc">
                        <span className="flex items-center gap-2">
                          <ArrowDownAZ className="w-4 h-4" />
                          A-Z
                        </span>
                      </SelectItem>
                      <SelectItem value="desc">
                        <span className="flex items-center gap-2">
                          <ArrowUpZA className="w-4 h-4" />
                          Z-A
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {displayedOrganizations.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <Building2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No organisations found</h3>
              <p className="text-slate-600">
                {searchQuery ? 'Try adjusting your search criteria' : 'No organisations available'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className={getGridClass()}>
              {displayedOrganizations.map((org) => {
                const memberCount = organizationMemberCounts[org.id] || 0;
                const allDomains = [org.domain, ...(org.additional_verified_domains || [])].filter(Boolean);

                return (
                  <Card 
                    key={org.id} 
                    className="border-slate-200 hover:shadow-lg transition-shadow cursor-pointer"
                    style={{ borderRadius: `${cardBorderRadius}px` }}
                    onClick={() => handleOrgCardClick(org.id)}
                    data-testid={`card-org-element-${org.id}`}
                  >
                    <CardHeader className="flex flex-col items-center text-center pb-2">
                      {showLogo && (
                        <div 
                          className="relative w-[90%] aspect-square rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center mb-3 group"
                          style={{ borderRadius: `${cardBorderRadius}px` }}
                        >
                          {org.logo_url ? (
                            <img
                              src={org.logo_url}
                              alt={org.name}
                              className={`w-full h-full object-contain transition-all duration-300 ${effectiveShowNameTooltip ? 'group-hover:opacity-20' : ''}`}
                            />
                          ) : (
                            <Building2 className={`w-16 h-16 text-slate-400 transition-all duration-300 ${effectiveShowNameTooltip ? 'group-hover:opacity-20' : ''}`} />
                          )}
                          {effectiveShowNameTooltip && (
                            <div className="absolute inset-0 flex items-center justify-center p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                              <span className="text-lg font-bold text-slate-800 text-center leading-tight line-clamp-4">
                                {org.name}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                      {effectiveShowTitle && !effectiveShowNameTooltip && (
                        <CardTitle className="text-base line-clamp-2 w-full">{org.name}</CardTitle>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {showDomains && allDomains.length > 0 && (
                        <div className="space-y-1 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <Globe className="w-4 h-4 text-slate-400" />
                            <span className="text-sm font-medium text-slate-700">
                              {allDomains.length > 1 ? 'Domains' : 'Domain'}
                            </span>
                          </div>
                          <div className="flex flex-wrap justify-center gap-1">
                            {allDomains.map((domain, idx) => (
                              <span key={idx} className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded">
                                @{domain}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {showMemberCount && (
                        <div className="flex items-center justify-center gap-2 pt-2 border-t border-slate-200">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span className="text-sm text-slate-600">Members:</span>
                          <span className="text-sm font-semibold text-slate-900">{memberCount}</span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {showPagination && totalPages > 1 && (
              <div className="mt-6 flex justify-center items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  data-testid="button-prev-page-org-element"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm text-slate-600">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  data-testid="button-next-page-org-element"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
