import React from "react";
import DOMPurify from 'dompurify';
import { useIsMobile } from "@/hooks/use-mobile";
import IEditHeroElement from "@/components/iedit/elements/IEditHeroElement";

export default function PortalHeroBanner({ banner }) {
  const isMobile = useIsMobile();
  
  if (!banner) return null;

  const bannerType = banner.banner_type;
  const hasHeroContent = banner.hero_content && Object.keys(banner.hero_content).length > 0;
  const hasImageUrl = !!banner.image_url;

  console.log('[PortalHeroBanner] Rendering banner:', banner.name, 'type:', bannerType, 'hasHeroContent:', hasHeroContent, 'hasImageUrl:', hasImageUrl);

  // Render hero content for:
  // - 'hero' type banners
  // - 'simple' type banners (legacy from Base44) with hero_content
  // - 'image' type banners with hero_content but no image_url
  const shouldRenderAsHero = bannerType === 'hero' || 
                              bannerType === 'simple' ||
                              (hasHeroContent && !hasImageUrl);

  if (shouldRenderAsHero) {
    if (!hasHeroContent) {
      console.log('[PortalHeroBanner] Skipping banner - no hero content:', banner.name);
      return null;
    }
    console.log('[PortalHeroBanner] Rendering as hero element:', banner.name);
    return (
      <div className="w-full">
        <IEditHeroElement content={banner.hero_content} />
      </div>
    );
  }

  // For image banners, require image_url
  if (!hasImageUrl) {
    console.log('[PortalHeroBanner] Skipping banner - no image_url:', banner.name);
    return null;
  }

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

  const paddingTopClasses = {
    'none': 'pt-0',
    'small': 'pt-4',
    'medium': 'pt-8',
    'large': 'pt-16'
  };

  const paddingBottomClasses = {
    'none': 'pb-0',
    'small': 'pb-4',
    'medium': 'pb-8',
    'large': 'pb-16'
  };

  const containerClass = sizeClasses[banner.size] || sizeClasses['full'];
  const heightClass = heightClasses[banner.height] || heightClasses['medium'];
  const positionClass = positionClasses[banner.position] || positionClasses['center'];
  
  // Only apply horizontal alignment for non-full-width banners
  const needsAlignment = banner.size === 'half' || banner.size === 'quarter';
  const alignmentClass = needsAlignment 
    ? (horizontalAlignmentClasses[banner.horizontal_alignment] || horizontalAlignmentClasses['center'])
    : '';

  const paddingTopClass = paddingTopClasses[banner.padding_top] || paddingTopClasses['none'];
  const paddingBottomClass = paddingBottomClasses[banner.padding_bottom] || paddingBottomClasses['none'];

  return (
    <div className={`${containerClass} ${alignmentClass} ${paddingTopClass} ${paddingBottomClass} overflow-hidden`}>
      <div className={`${heightClass} w-full relative`}>
        <img
          src={banner.image_url}
          alt={banner.alt_text || banner.name}
          className={`w-full h-full object-cover ${positionClass}`}
        />
        
        {/* Header Text Overlay */}
        {hasHeader && (
          <div className={`absolute inset-0 flex flex-col justify-center ${textAlignmentClass} px-4 md:px-8 lg:px-16`}>
            <div 
              className="max-w-4xl"
              style={getHeaderStyle()}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(banner.header_title) }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
