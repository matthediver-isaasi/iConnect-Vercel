// Shared iEdit-Showcase-style card (Task #2807).
//
// This is the single source of truth for the "Showcase" card look: fixed-height
// white card with rounded corners, strong shadow + hover zoom, feature image
// with a coloured content-type badge, optional border strip under the image,
// title / summary / date / author lines, and a round-cornered arrow button
// pinned to the bottom-right corner. The whole card is the link.
//
// Consumers:
// - iEdit Showcase element (IEditShowcaseElement.jsx) — passes its existing
//   per-element config so output stays pixel-identical to the old markup.
// - Canvas Builder "Article / news list" block (dynamicBlocks.jsx) — passes
//   Showcase defaults so canvas pages render the same cards.
//
// Keep this component purely presentational: no data fetching, no routing
// decisions beyond rendering the wrapper the caller asks for.
import React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Calendar, User, ArrowUpRight, Lock } from 'lucide-react';

export default function ShowcaseCard({
  // Content
  title,
  imageUrl,
  imageFocalPoint, // { x, y } percentages or null
  imageAlt,
  summary,
  publishedDate, // date string or null
  authorText, // preformatted "Jane & John" string or ''
  // Link behaviour
  url,
  external = false, // render <a target=_blank> instead of router <Link>
  newTab = false, // force new tab for internal links too
  onClick,
  asEditor = false, // render a non-navigating wrapper (canvas editor)
  locked = false, // member-only content: CTA shows a lock icon instead of the arrow
  // Badge
  showBadge = true,
  badgeText = '',
  badgeBgColor = '#2563eb',
  badgeTextColor = '#ffffff',
  // Card config (iEdit Showcase content.* fields with the same defaults)
  cardHeight = 400,
  cardBorderRadius = 8,
  imageHeightPercent = 50,
  // Optional responsive image ratio. When provided, the image box follows
  // the card's available width instead of the legacy percentage of card
  // height. Keep this unset for iEdit and non-news cards.
  imageAspectRatio = null,
  showImageArea = true,
  showImageBorder = false,
  imageBorderWeight = 3,
  imageBorderColor = '#2563eb',
  titleFontSize = 16,
  dateFontSize = 12,
  descriptionLineClamp = 3, // number | 'none' | 0 (0 hides the summary)
  showPublishedDate = false,
  showCTAButton = true,
  ctaButtonSize = 48,
  ctaButtonMargin = 0,
  ctaButtonBgColor = '#2563eb',
  ctaButtonArrowColor = '#ffffff',
  // Arrow button corner radius. When null/undefined it follows the card's
  // radius (the original iEdit Showcase behaviour).
  ctaButtonBorderRadius = null,
  textAlign = 'left',
  // Optional typography overrides (canvas tenant typography styles). When
  // provided, they replace the default inline font sizing on title/summary.
  titleStyleOverride = null,
  summaryStyleOverride = null,
  titleExtraProps = {},
  summaryExtraProps = {},
  testId,
  // Optional data-testid for the clickable card wrapper (e.g. the canvas
  // block keeps its legacy `link-article-<id>` contract).
  wrapperTestId,
}) {
  const hasImageAspectRatio = imageAspectRatio != null && imageAspectRatio !== '';
  const imageHeight = hasImageAspectRatio
    ? null
    : Math.round(cardHeight * (imageHeightPercent / 100));
  const buttonSize = ctaButtonSize;
  const buttonMargin = ctaButtonMargin;
  const justify = textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start';

  const cardContent = (
    <>
      {showImageArea && (
        <div
          className="relative"
          style={hasImageAspectRatio
            ? { aspectRatio: imageAspectRatio, height: 'auto', flexShrink: 0 }
            : { height: `${imageHeight}px` }}
        >
          {imageUrl && (
            <img
              src={imageUrl}
              alt={imageAlt || title}
              className="w-full h-full object-cover"
              style={{ objectPosition: imageFocalPoint ? `${imageFocalPoint.x}% ${imageFocalPoint.y}%` : '50% 50%' }}
            />
          )}
          {showBadge && (
            <Badge
              className="absolute top-0 left-0 text-xs font-semibold rounded-none px-3 py-1"
              style={{
                backgroundColor: badgeBgColor,
                color: badgeTextColor,
              }}
            >
              {badgeText}
            </Badge>
          )}
        </div>
      )}
      {showImageBorder && (
        <div
          style={{
            height: `${imageBorderWeight}px`,
            backgroundColor: imageBorderColor,
          }}
        />
      )}
      <div
        className="p-4 flex-1 overflow-hidden relative"
        style={{
          textAlign,
          // `flex-1` has a zero flex basis. In responsive ratio mode, retain
          // the body's natural content height so a wide image cannot leave
          // the title, summary, metadata, and CTA with a zero-height area.
          ...(hasImageAspectRatio ? { flex: '1 1 auto' } : {}),
        }}
      >
        <h3
          className="font-semibold text-slate-900 mb-2 line-clamp-2"
          style={titleStyleOverride || { fontSize: `${titleFontSize}px` }}
          {...titleExtraProps}
        >
          {title}
        </h3>
        {descriptionLineClamp !== 0 && summary && (
          <p
            className="text-sm text-slate-600"
            style={{
              ...(descriptionLineClamp === 'none'
                ? {}
                : {
                    // Inline -webkit-box clamp: dynamic `line-clamp-${n}`
                    // classes above 4 aren't generated by Tailwind's JIT,
                    // so clamp via inline styles for any line count.
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: Number(descriptionLineClamp) > 0 ? Number(descriptionLineClamp) : 3,
                    overflow: 'hidden',
                  }),
              ...(summaryStyleOverride || {}),
            }}
            {...summaryExtraProps}
          >
            {summary}
          </p>
        )}
        {showPublishedDate && publishedDate && (
          <div
            className="flex items-center gap-1 mt-3 text-slate-500"
            style={{
              justifyContent: justify,
              fontSize: `${dateFontSize}px`,
            }}
          >
            <Calendar style={{ width: `${dateFontSize}px`, height: `${dateFontSize}px` }} />
            {new Date(publishedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        )}
        {authorText ? (
          <div
            className="flex items-center gap-1 mt-2 text-slate-500"
            style={{
              justifyContent: justify,
              fontSize: `${dateFontSize}px`,
            }}
            data-testid={testId ? `text-article-authors-${testId}` : undefined}
          >
            <User style={{ width: `${dateFontSize}px`, height: `${dateFontSize}px` }} />
            <span>by {authorText}</span>
          </div>
        ) : null}
        {showCTAButton && (
          <div
            className="absolute flex items-center justify-center transition-transform hover:scale-110"
            style={{
              width: `${buttonSize}px`,
              height: `${buttonSize}px`,
              backgroundColor: ctaButtonBgColor,
              borderRadius: `${ctaButtonBorderRadius != null && ctaButtonBorderRadius !== '' && Number.isFinite(Number(ctaButtonBorderRadius)) ? Math.max(0, Number(ctaButtonBorderRadius)) : cardBorderRadius}px`,
              bottom: `${buttonMargin}px`,
              right: `${buttonMargin}px`,
            }}
          >
            {locked ? (
              <Lock
                style={{
                  width: `${buttonSize * 0.5}px`,
                  height: `${buttonSize * 0.5}px`,
                  color: ctaButtonArrowColor,
                }}
              />
            ) : (
              <ArrowUpRight
                style={{
                  width: `${buttonSize * 0.5}px`,
                  height: `${buttonSize * 0.5}px`,
                  color: ctaButtonArrowColor,
                }}
              />
            )}
          </div>
        )}
      </div>
    </>
  );

  const wrapperClassName = 'bg-white shadow-xl overflow-hidden hover:shadow-2xl hover:scale-105 transition-all duration-300 block flex flex-col';
  const wrapperStyle = hasImageAspectRatio
    ? {
        // The saved card height remains the minimum design size, but the
        // responsive image and card body may grow beyond it when a wide list
        // row needs more room than the image leaves for the text.
        minHeight: `${cardHeight}px`,
        height: 'auto',
        borderRadius: `${cardBorderRadius}px`,
      }
    : {
        height: `${cardHeight}px`,
        borderRadius: `${cardBorderRadius}px`,
      };

  // In the canvas editor, clicking a card must select the block instead of
  // navigating; likewise a card with no URL at all (e.g. a resource without a
  // download/content link) must not render as a broken anchor.
  if (asEditor || !url) {
    return (
      <div className={wrapperClassName} style={wrapperStyle} onClick={onClick} data-testid={wrapperTestId || (testId ? `card-showcase-${testId}` : undefined)}>
        {cardContent}
      </div>
    );
  }

  // `external` decides the wrapper (<a> vs router <Link>); `newTab` alone
  // decides target=_blank, so an external link can still open in the same tab.
  if (external || newTab) {
    return (
      <a
        href={url}
        target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noopener noreferrer' : undefined}
        onClick={onClick}
        className={wrapperClassName}
        style={wrapperStyle}
        data-testid={wrapperTestId || (testId ? `card-showcase-${testId}` : undefined)}
      >
        {cardContent}
      </a>
    );
  }

  return (
    <Link
      to={url}
      onClick={onClick}
      className={wrapperClassName}
      style={wrapperStyle}
      data-testid={wrapperTestId || (testId ? `card-showcase-${testId}` : undefined)}
    >
      {cardContent}
    </Link>
  );
}
