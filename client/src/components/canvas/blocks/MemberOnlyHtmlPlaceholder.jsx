import { normalizeMemberOnlyGuestMessage } from '@/lib/memberOnlyHtml';
import PublicLoginLink from '@/components/layouts/PublicLoginLink';

/**
 * A redacted block never paints server content. The blurred shapes below are
 * decorative only (aria-hidden) and contain no copy from the protected HTML.
 */
export default function MemberOnlyHtmlPlaceholder({ guestMessage, blockId }) {
  const message = normalizeMemberOnlyGuestMessage(guestMessage);
  const safeBlockId = String(blockId || 'block').replace(/[^a-zA-Z0-9_-]/g, '-');
  const messageId = `member-only-guest-message-${safeBlockId}`;
  return (
    <div
      className="relative flex h-full min-h-[140px] w-full items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50 p-5"
      data-testid="member-only-guest-placeholder"
      role="region"
      aria-labelledby={messageId}
    >
      <div
        className="pointer-events-none absolute inset-3 select-none space-y-3 opacity-70 blur-[5px]"
        aria-hidden="true"
      >
        <div className="h-4 w-2/5 rounded bg-slate-300" />
        <div className="h-3 w-full rounded bg-slate-200" />
        <div className="h-3 w-5/6 rounded bg-slate-200" />
        <div className="h-16 w-full rounded bg-slate-300/80" />
      </div>
      <div className="relative z-10 flex max-w-md flex-col items-center gap-3 rounded-lg bg-white/95 px-5 py-4 text-center shadow-sm">
        <p id={messageId} className="text-sm font-medium text-slate-700">
          {message}
        </p>
        <PublicLoginLink
          describedBy={messageId}
          // This prompt sits on a white card, not the configurable header
          // bar; a plain link therefore needs an explicit light-surface color.
          textColor="#0F172A"
        />
      </div>
    </div>
  );
}
