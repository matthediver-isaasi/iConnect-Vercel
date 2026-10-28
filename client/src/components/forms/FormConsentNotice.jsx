import { safeFormPrivacyUrl } from '../../../../shared/formConsentSettings.js';

export default function FormConsentNotice({ configuration }) {
  const message = typeof configuration?.message === 'string' ? configuration.message : '';
  const url = safeFormPrivacyUrl(configuration?.privacy_settings_url);
  if (!message && !url) return null;
  return (
    <div className="text-xs text-slate-500 text-center mt-2">
      {message && <p data-testid="text-consent-message">{message}</p>}
      {url && (
        <p className={message ? 'mt-2' : undefined}>
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            data-testid="link-privacy-settings">
            Privacy Settings
          </a>
        </p>
      )}
    </div>
  );
}
