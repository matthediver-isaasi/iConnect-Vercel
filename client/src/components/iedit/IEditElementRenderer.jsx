import React from "react";
import IEditHeroElement from "./elements/IEditHeroElement";
import IEditTextBlockElement from "./elements/IEditTextBlockElement";
import IEditImageElement from "./elements/IEditImageElement";
import IEditTwoColumnElement from "./elements/IEditTwoColumnElement";
import IEditCtaButtonElement from "./elements/IEditCtaButtonElement";
import IEditImageHeroElement from "./elements/IEditImageHeroElement";
import { IEditWallOfFameElementRenderer } from "./elements/IEditWallOfFameElement";
import IEditFormElement from "./elements/IEditFormElement";
import { IEditTextOverlayImageElementRenderer } from "./elements/IEditTextOverlayImageElement";
import { IEditTableElementRenderer } from "./elements/IEditTableElement";
import { IEditBannerCarouselElementRenderer } from "./elements/IEditBannerCarouselElement";
import { IEditShowcaseElementRenderer } from "./elements/IEditShowcaseElement";
import { IEditResourcesShowcaseElementRenderer } from "./elements/IEditResourcesShowcaseElement";
import IEditButtonBlockElement from "./elements/IEditButtonBlockElement";
import IEditPageHeaderHeroElement from "./elements/IEditPageHeaderHeroElement";
import { IEditOrganisationDirectoryElementRenderer } from "./elements/IEditOrganisationDirectoryElement";
import IEditFeaturedJobElement from "./elements/IEditFeaturedJobElement";
import IEditImagePanelElement from "./elements/IEditImagePanelElement";
import { IEditAccordionElementRenderer } from "./elements/IEditAccordionElement";
import IEditQuoteElement from "./elements/IEditQuoteElement";
import IEditFiftyFiftyElement from "./elements/IEditFiftyFiftyElement";
import { IEditCardDeckElementRenderer } from "./elements/IEditCardDeckElement";
import { IEditLogoGridElementRenderer } from "./elements/IEditLogoGridElement";
import IEditEventSpotlightElement from "./elements/IEditEventSpotlightElement";

export default function IEditElementRenderer({ element, memberInfo, organizationInfo, isFirst, previewViewport }) {
  // Map element types to their corresponding components
  const elementComponents = {
    'hero': IEditHeroElement,
    'text_block': IEditTextBlockElement,
    'image': IEditImageElement,
    'two_column': IEditTwoColumnElement,
    'cta_button': IEditCtaButtonElement,
    'image_hero': IEditImageHeroElement,
    'wall_of_fame': IEditWallOfFameElementRenderer,
    'form': (props) => <IEditFormElement {...props} memberInfo={memberInfo} organizationInfo={organizationInfo} />,
    'text_overlay_image': IEditTextOverlayImageElementRenderer,
    'table': IEditTableElementRenderer,
    'banner_carousel': IEditBannerCarouselElementRenderer,
    'showcase': IEditShowcaseElementRenderer,
    'resources_showcase': IEditResourcesShowcaseElementRenderer,
    'button_block': IEditButtonBlockElement,
    'page_header_hero': IEditPageHeaderHeroElement,
    'organisation_directory': IEditOrganisationDirectoryElementRenderer,
    'featured_job': IEditFeaturedJobElement,
    'image_panel': IEditImagePanelElement,
    'accordion': IEditAccordionElementRenderer,
    'quote': IEditQuoteElement,
    'fifty_fifty': IEditFiftyFiftyElement,
    'card_deck': IEditCardDeckElementRenderer,
    'logo_grid': IEditLogoGridElementRenderer,
    'event_spotlight': IEditEventSpotlightElement,
  };

  const Component = elementComponents[element.element_type];

  if (!Component) {
    // Fallback for unknown element types
    return (
      <div className="bg-amber-50 border border-amber-200 p-4 my-4">
        <p className="text-sm text-amber-900">
          Unknown element type: <code>{element.element_type}</code>
        </p>
      </div>
    );
  }

  // Apply padding settings
  const paddingTop = element.settings?.paddingTop ?? 32;
  const paddingBottom = element.settings?.paddingBottom ?? 32;
  
  // Remove top padding for first element
  const actualPaddingTop = isFirst ? 0 : paddingTop;
  
  const paddingStyle = {
    paddingTop: `${actualPaddingTop}px`,
    paddingBottom: `${paddingBottom}px`
  };
  
  const fullWidth = element.settings?.fullWidth;

  // For full-width elements, apply padding but no max-width container
  // The element itself handles the full-width breakout
  if (fullWidth) {
    return (
      <div style={paddingStyle} className="w-full overflow-hidden">
        <Component 
          element={element}
          content={element.content} 
          variant={element.style_variant}
          settings={element.settings}
          isFirst={isFirst}
          previewViewport={previewViewport}
        />
      </div>
    );
  }

  // For contained elements, apply padding and max-width container
  return (
    <div style={paddingStyle}>
      <div className="max-w-7xl mx-auto px-4">
        <Component 
          element={element}
          content={element.content} 
          variant={element.style_variant}
          settings={element.settings}
          isFirst={isFirst}
          previewViewport={previewViewport}
        />
      </div>
    </div>
  );
}