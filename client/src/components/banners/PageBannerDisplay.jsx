import React from "react";
import DOMPurify from 'dompurify';
import { useIsMobile } from "@/hooks/use-mobile";

export default function PageBannerDisplay({ banner }) {
  const isMobile = useIsMobile();
  
  if (!banner || !banner.image_url) return null;

  const sizeClasses = {
    'full': 'w-full',
    'half': 'w-1/2',
    'quarter': 'w-1/4',
    'full-width': 'w-full',
    'contained': 'max-w-7xl mx-auto',
    'wide': 'max-w-screen-2xl mx-auto'
  };

  const heightClasses = {
    'small': 'h-32 md:h-48',
    'medium': 'h-48 md:h-64 lg:h-80',
    'large': 'h-64 md:h-96 lg:h-[32rem]',
    'auto': 'h-auto'
  };

  const positionClasses = {
    'top': 'object-top',
    'center': 'object-center',
    'bottom': 'object-bottom'
  };

  const horizontalAlignmentClasses = {
    'left': 'mr-auto',
    'center': 'mx-auto',
    'right': 'ml-auto'
  };

  // Helper to get padding value - supports both old preset strings and new numeric values
  const getPaddingValue = (value) => {
    if (typeof value === 'number') return value;
    // Fallback for old preset values
    const presetMap = { 'none': 0, 'small': 16, 'medium': 32, 'large': 64 };
    return presetMap[value] ?? 0;
  };

  const containerClass = sizeClasses[banner.size] || sizeClasses['full'];
  const heightClass = heightClasses[banner.height] || heightClasses['medium'];
  const positionClass = positionClasses[banner.position] || positionClasses['center'];
  
  // Only apply horizontal alignment for non-full-width banners
  const needsAlignment = banner.size === 'half' || banner.size === 'quarter';
  const alignmentClass = needsAlignment 
    ? (horizontalAlignmentClasses[banner.horizontal_alignment] || horizontalAlignmentClasses['center'])
    : '';

  // Get padding values as pixels
  const paddingStyle = {
    paddingTop: `${getPaddingValue(banner.padding_top)}px`,
    paddingBottom: `${getPaddingValue(banner.padding_bottom)}px`,
    paddingLeft: `${getPaddingValue(banner.padding_left)}px`,
    paddingRight: `${getPaddingValue(banner.padding_right)}px`,
  };

  // Check if header has actual content
  const hasHeaderContent = (value) => {
    if (!value) return false;
    const stripped = value.replace(/<[^>]*>/g, '').trim();
    return stripped.length > 0;
  };

  const hasHeader = hasHeaderContent(banner.header_title);

  // Header text styles
  const getHeaderStyle = () => {
    const fontSize = isMobile && banner.header_font_size_mobile 
      ? banner.header_font_size_mobile 
      : (banner.header_font_size || 32);
    
    return {
      fontFamily: banner.header_font_family || 'Poppins',
      fontSize: `${fontSize}px`,
      fontWeight: banner.header_font_weight || 700,
      color: banner.header_color || '#ffffff',
      lineHeight: banner.header_line_height || 1.2,
      letterSpacing: `${banner.header_letter_spacing || 0}px`,
      textAlign: banner.header_text_align || 'center'
    };
  };

  const textAlignmentClass = {
    'left': 'items-start text-left',
    'center': 'items-center text-center',
    'right': 'items-end text-right'
  }[banner.header_text_align || 'center'];

  return (
    <div className={`${containerClass} ${alignmentClass} overflow-hidden`} style={paddingStyle}>
      {/* Header Text Above Image */}
      {hasHeader && (
        <div className={`${textAlignmentClass} px-4 md:px-8 lg:px-16 py-4 md:py-6`}>
          <div 
            className="max-w-4xl mx-auto"
            style={getHeaderStyle()}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(banner.header_title) }}
          />
        </div>
      )}
      
      {/* Banner Image */}
      <div className={`${heightClass} w-full`}>
        <img
          src={banner.image_url}
          alt={banner.alt_text || banner.name}
          className={`w-full h-full object-cover ${positionClass}`}
        />
      </div>
    </div>
  );
}

export function getPagePosition(banner) {
  return banner?.page_position || 'top';
}