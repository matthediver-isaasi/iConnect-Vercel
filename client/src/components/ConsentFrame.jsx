import { useCookieConsent } from '../hooks/useCookieConsent.js';
export default function ConsentFrame(props) {
  const {categories,resetConsent}=useCookieConsent();
  if (!categories.functional) return <div role="note" className="p-4 text-center">
    <p>Allow functional cookies to load this external media.</p>
    <button type="button" className="underline" onClick={resetConsent}>Cookie preferences</button>
  </div>;
  return <iframe {...props}/>;
}
