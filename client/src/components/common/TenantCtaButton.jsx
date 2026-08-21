import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTenantBranding } from '@/contexts/TenantBrandingContext';
import {
  resolveTenantButtonStyle,
  buildTenantButtonInlineStyle,
} from '@/lib/tenantButtonStyle';

// Reusable content-card CTA button that applies the tenant's configured
// Primary button style (from the Button Style Creator at /admin/branding) as
// inline styles with hover handling, mirroring the Canvas Hero CTA button.
//
// When the tenant has NO Primary button style configured, it renders the
// caller's existing hardcoded look unchanged (no visual change for existing
// tenants):
//   - `as="button"` / `as="a"` / `as="link"` controls the element.
//   - `fallbackClassName` carries the original visual classes.
//   - `fallbackVariant` is the shadcn Button variant used in fallback.
//   - `className` carries layout constraints applied in BOTH modes (e.g.
//     `w-full`, `flex-1`, fixed square sizing).
//   - `applySize={false}` keeps the caller's own padding/sizing (square icon
//     buttons) while still applying the tenant colour/border/radius.
//   - `size` is forwarded to the fallback <Button> only; it is NOT passed to
//     native elements in the tenant-styled path to avoid invalid DOM props.
export default function TenantCtaButton({
  as = 'button',
  to,
  href,
  onClick,
  className = '',
  fallbackClassName = '',
  fallbackVariant,
  applySize = true,
  radiusOverride,
  disabled = false,
  size,
  children,
  style: suppliedStyle,
  ...rest
}) {
  const branding = useTenantBranding()?.branding || null;
  const style = resolveTenantButtonStyle('tenant-primary', branding);
  const [hovered, setHovered] = useState(false);
  const hasRadiusOverride = radiusOverride !== null
    && radiusOverride !== undefined
    && radiusOverride !== '';
  const radiusValue = Number(radiusOverride);
  const radiusStyle = hasRadiusOverride && Number.isFinite(radiusValue) && radiusValue >= 0
    ? { borderRadius: `${radiusValue}px` }
    : null;

  // No tenant Primary style configured → preserve the existing hardcoded look.
  if (!style || disabled) {
    if (as === 'link') {
      return (
        <Button
          variant={fallbackVariant}
          size={size}
          disabled={disabled}
          className={cn(className, fallbackClassName)}
          style={{ ...suppliedStyle, ...radiusStyle }}
          asChild
          {...rest}
        >
          <Link to={to} onClick={onClick}>
            {children}
          </Link>
        </Button>
      );
    }
    if (as === 'a') {
      return (
        <Button
          variant={fallbackVariant}
          size={size}
          disabled={disabled}
          className={cn(className, fallbackClassName)}
          style={{ ...suppliedStyle, ...radiusStyle }}
          asChild
          {...rest}
        >
          <a href={href} onClick={onClick}>
            {children}
          </a>
        </Button>
      );
    }
    return (
      <Button
        variant={fallbackVariant}
        size={size}
        onClick={onClick}
        disabled={disabled}
        className={cn(className, fallbackClassName)}
        style={{ ...suppliedStyle, ...radiusStyle }}
        {...rest}
      >
        {children}
      </Button>
    );
  }

  const inlineStyle = {
    ...buildTenantButtonInlineStyle(style, { hovered, applySize }),
    ...suppliedStyle,
    ...radiusStyle,
  };
  // Growth: for full-width CTAs (callers that pass a `w-full` layout class),
  // fill at least the container but expand to fit long labels instead of
  // clipping — mirroring the Canvas Button render path (minWidth:100% +
  // width:max-content). Content-sized buttons (no `w-full`) and the shared
  // flex rows keep their natural sizing, and fixed square icon buttons
  // (`applySize={false}`) are untouched.
  if (applySize && /\bw-full\b/.test(className)) {
    inlineStyle.minWidth = '100%';
    inlineStyle.width = 'max-content';
  }
  const hoverProps = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };
  const baseLayout = cn(
    'inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap leading-none cursor-pointer',
    className,
  );

  if (as === 'link') {
    return (
      <Link
        to={to}
        onClick={onClick}
        className={baseLayout}
        style={inlineStyle}
        {...hoverProps}
        {...rest}
      >
        {children}
      </Link>
    );
  }
  if (as === 'a') {
    return (
      <a
        href={href}
        onClick={onClick}
        className={baseLayout}
        style={inlineStyle}
        {...hoverProps}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={baseLayout}
      style={inlineStyle}
      {...hoverProps}
      {...rest}
    >
      {children}
    </button>
  );
}
