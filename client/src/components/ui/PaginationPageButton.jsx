import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { resolveTenantButtonStyle, getTenantButtonStyleCss } from "@/lib/tenantButtonStyle";

// A page-number button for public list pagination. When it is the active page
// AND the tenant has a Primary button style configured (Button Style Creator),
// it paints itself with that style (and its hover state). Otherwise it falls
// back to the default shadcn Button appearance (default variant when active,
// outline otherwise), preserving existing visuals for tenants without a
// configured Primary style.
export function PaginationPageButton({ active, children, className = "", ...props }) {
  const branding = useTenantBranding()?.branding;
  const [hovered, setHovered] = useState(false);

  const styleCfg = resolveTenantButtonStyle(branding, 'primary');
  const css = active ? getTenantButtonStyleCss(styleCfg) : null;

  if (css) {
    return (
      <Button
        variant="default"
        size="sm"
        className={className}
        style={hovered ? css.hover : css.normal}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        {...props}
      >
        {children}
      </Button>
    );
  }

  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      className={className}
      {...props}
    >
      {children}
    </Button>
  );
}
