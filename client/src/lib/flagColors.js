// Shared colour palette for check-in flags (Task #1256 follow-up).
// Admins pick a colour per flagged boolean field so scanners can tell
// different requirements apart at a glance. The "default" colour keeps the
// original semantic warning styling so existing flags are unchanged.
//
// Class strings must be written out in full (no string concatenation) so
// Tailwind keeps them during purge.

export const FLAG_COLOR_OPTIONS = [
  { value: "default", label: "Default (amber)" },
  { value: "red", label: "Red" },
  { value: "orange", label: "Orange" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "purple", label: "Purple" },
  { value: "pink", label: "Pink" },
  { value: "slate", label: "Slate" },
];

const FLAG_COLOR_MAP = {
  default: { surface: "bg-warning text-warning-foreground", border: "border-warning-foreground/40", swatch: "bg-warning" },
  red: { surface: "bg-red-600 text-white", border: "border-white/40", swatch: "bg-red-600" },
  orange: { surface: "bg-orange-500 text-white", border: "border-white/40", swatch: "bg-orange-500" },
  green: { surface: "bg-green-600 text-white", border: "border-white/40", swatch: "bg-green-600" },
  blue: { surface: "bg-blue-600 text-white", border: "border-white/40", swatch: "bg-blue-600" },
  purple: { surface: "bg-purple-600 text-white", border: "border-white/40", swatch: "bg-purple-600" },
  pink: { surface: "bg-pink-600 text-white", border: "border-white/40", swatch: "bg-pink-600" },
  slate: { surface: "bg-slate-700 text-white", border: "border-white/40", swatch: "bg-slate-700" },
};

export function getFlagColorClasses(color) {
  return FLAG_COLOR_MAP[color] || FLAG_COLOR_MAP.default;
}
