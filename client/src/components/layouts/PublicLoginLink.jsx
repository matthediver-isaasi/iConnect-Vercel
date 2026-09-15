import { Link, useLocation } from 'react-router-dom';
import { User } from 'lucide-react';
import { usePublicChromeBranding } from '@/contexts/MicrositeContext';
import { getValidatedReturnTo } from '@/lib/memberOnlyHtml';
import { resolvePublicHeaderLink } from '@/lib/publicHeaderLogin';

/**
 * The same branded login action used by PublicHeader, available to inline
 * content prompts without mounting a second header. Branding is read through
 * usePublicChromeBranding so microsite overrides are honored.
 */
export function PublicLoginLink({
  className = '',
  style: styleProp,
  mobile = false,
  testId = 'link-member-only-login',
  describedBy,
  onClick,
  textColor,
}) {
  const location = useLocation();
  const { branding } = usePublicChromeBranding() || {};
  const headerConfig = branding?.headerConfig || {};
  const topNavTextColor = headerConfig.topNavTextColor || '#FFFFFF';
  const login = resolvePublicHeaderLink(headerConfig.loginLink, 'Login', topNavTextColor);
  const returnTo = getValidatedReturnTo(location);
  const to = `/login?returnTo=${encodeURIComponent(returnTo)}`;
  const mobileClass = 'flex items-center gap-2 py-2 text-slate-900 font-medium';
  const desktopClass = `flex items-center gap-1 hover:opacity-80 transition-opacity text-sm font-semibold${login.asButton ? ' px-3 py-1.5' : ''}`;

  return (
    <Link
      to={to}
      className={`${mobile ? mobileClass : desktopClass}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      style={{
        ...login.buttonStyle,
        // Plain links use the same configured bar text colour as PublicHeader;
        // inline prompts must not silently drift to a hard-coded fallback.
        color: login.asButton ? login.labelColor : (textColor || topNavTextColor),
        ...styleProp,
      }}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      <User className={mobile ? 'w-5 h-5 text-slate-600' : 'w-4 h-4'} aria-hidden="true" />
      <span>{login.label}</span>
    </Link>
  );
}

export default PublicLoginLink;
