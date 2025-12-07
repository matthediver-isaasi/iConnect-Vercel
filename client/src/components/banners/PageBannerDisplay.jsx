import React from "react";

export default function PageBannerDisplay({ banner }) {
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

  const containerClass = sizeClasses[banner.size] || sizeClasses['full'];
  const heightClass = heightClasses[banner.height] || heightClasses['medium'];
  const positionClass = positionClasses[banner.position] || positionClasses['center'];
  
  // Only apply horizontal alignment for non-full-width banners
  const needsAlignment = banner.size === 'half' || banner.size === 'quarter';
  const alignmentClass = needsAlignment 
    ? (horizontalAlignmentClasses[banner.horizontal_alignment] || horizontalAlignmentClasses['center'])
    : '';

  return (
    <div className={`${containerClass} ${alignmentClass} overflow-hidden`}>
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