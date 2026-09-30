import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Parse a CSS hex colour (#rgb / #rrggbb) into { r, g, b }. Returns null for
// anything we can't confidently parse (named colours, rgb(), etc) — callers
// then skip auto-contrast and rely on the admin-picked text colour.
function parseHex(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// Pick a readable text colour (near-black or near-white) for a given
// background using WCAG relative luminance. Used when an admin sets a badge
// background but no explicit text colour.
export function getReadableTextColor(backgroundHex) {
  const rgb = parseHex(backgroundHex);
  if (!rgb) return "#ffffff";
  const toLinear = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return luminance > 0.5 ? "#1e293b" : "#ffffff";
}

// Build the inline style for a role badge from its configured colours.
// Returns null when the role has no colours set, signalling the caller to
// fall back to the neutral default badge styling.
export function getRoleBadgeStyle(role) {
  const bg = role?.badge_background_colour;
  const text = role?.badge_text_colour;
  if (!bg && !text) return null;
  const backgroundColor = bg || undefined;
  const color = text || (bg ? getReadableTextColor(bg) : undefined);
  return {
    backgroundColor,
    color,
    borderColor: backgroundColor || undefined,
  };
}

/**
 * Renders a role's name as a badge using the role's configured colours.
 *
 * - `role`: the role object (uses `badge_background_colour` / `badge_text_colour`).
 * - `name`: optional override label (e.g. "Unknown role" when the role is missing).
 *
 * When the role has no colours configured, falls back to a neutral
 * `secondary` badge that adapts to light/dark mode automatically.
 */
export default function RoleBadge({ role, name, className, style, ...props }) {
  const label = name ?? role?.name ?? "Unknown role";
  const colourStyle = getRoleBadgeStyle(role);

  if (colourStyle) {
    return (
      <Badge
        className={cn("border", className)}
        style={{ ...colourStyle, ...style }}
        {...props}
      >
        {label}
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className={className} style={style} {...props}>
      {label}
    </Badge>
  );
}
