import React from "react";

const PLATFORM_LOGO_URL = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/fe03f7c5e_linked-aa.png";

export function shouldShowPlatformBranding(platformBranding) {
  return platformBranding?.showPlatformBranding !== false;
}

export default function PlatformBrandingStrip({
  platformBranding,
  platformDefaults,
  contained = false,
}) {
  if (!shouldShowPlatformBranding(platformBranding)) return null;

  return (
    <div
      className={[
        "text-center py-4 px-4 sm:px-8 md:px-16",
        contained ? "mt-8 -mx-4 sm:-mx-8 md:-mx-16 -mb-8 sm:-mb-12 md:-mb-16" : "",
      ].filter(Boolean).join(" ")}
      style={{ backgroundColor: platformBranding?.backgroundColor || "#000000" }}
      data-testid="platform-branding-strip"
    >
      <a
        href={platformDefaults.platformBrandingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block hover:opacity-80 transition-opacity"
      >
        <img
          src={PLATFORM_LOGO_URL}
          alt="Platform logo"
          className="w-[40px] mx-auto mb-2"
        />
      </a>
      <p
        className="text-xs"
        style={{ color: platformBranding?.textColor || "#64748b" }}
      >
        {platformDefaults.platformBrandingText}
      </p>
    </div>
  );
}