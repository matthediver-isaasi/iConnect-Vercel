import { Link, useLocation } from 'react-router-dom';
import { User } from 'lucide-react';
import { usePublicChromeBranding } from '@/contexts/MicrositeContext';
import { getValidatedReturnTo } from '@/lib/memberOnlyHtml';
import { resolvePublicHeaderLink } from '@/lib/publicHeaderLogin';

/**
 * Contextual login for inline content prompts. Ordinary header login uses
 * PublicSignInStyledLink with /login instead of returning to the public page.
 * Branding is read through
 * usePublicChromeBranding so microsite overrides are honored.
 */
export function PublicLoginLink({
  ...props
}) {
  const location = useLocation();
  const returnTo = getValidatedReturnTo(location);
  return <PublicSignInStyledLink {...props} to={`/login?returnTo=${encodeURIComponent(returnTo)}`} />;
}

// Share appearance without changing the header's destination or login label.
export function PublicSignInStyledLink({
  to,
  label,
  external = false,
  className = '',
  style: styleProp,
  mobile = false,
  testId = 'link-member-only-login',
  describedBy,
  onClick,
  textColor,
}) {
  const { branding } = usePublicChromeBranding() || {};
  const headerConfig = branding?.headerConfig || {};
  const topNavTextColor = headerConfig.topNavTextColor || '#FFFFFF';
  const login = resolvePublicHeaderLink(headerConfig.loginLink, 'Login', topNavTextColor);
  const mobileClass = 'flex items-center gap-2 py-2 text-slate-900 font-medium';
  const desktopClass = `flex items-center gap-1 hover:opacity-80 transition-opacity text-sm font-semibold${login.asButton ? ' px-3 py-1.5' : ''}`;
  const Component = external ? 'a' : Link;

  return (
    <Component
      {...(external ? { href: to } : { to })}
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
      <span>{label ?? login.label}</span>
    </Component>
  );
}

export default PublicLoginLink;
