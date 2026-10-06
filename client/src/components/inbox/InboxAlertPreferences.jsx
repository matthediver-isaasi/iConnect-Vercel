import React from 'react';
import { useInboxAlertPreferences } from '@/hooks/useInboxAlertPreferences';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

export default function InboxAlertPreferences() {
  const prefs = useInboxAlertPreferences();
  return (
    <section aria-labelledby="inbox-alert-title" className="mb-4 rounded-lg border p-4">
      <h2 id="inbox-alert-title" className="font-semibold">Alert preferences</h2>
      <p className="text-sm text-muted-foreground mb-3">Only the unread-message popup is affected. Messages, badges and emails stay unchanged. Always hide takes precedence when both options are on.</p>
      {[
        ['hide_until_login', 'Hide alert until next login', 'Hide the popup for this login, including new messages. Resets when you log in again.'],
        ['always_hide', 'Always hide alert', 'Hide the popup on every browser and future login until you switch this off.'],
      ].map(([field, label, explanation]) => (
        <div key={field} className="flex items-center justify-between gap-4 py-2">
          <div><label htmlFor={`alert-${field}`} className="font-medium">{label}</label>
            <p id={`alert-${field}-help`} className="text-sm text-muted-foreground">{explanation}</p></div>
          <Switch id={`alert-${field}`} aria-describedby={`alert-${field}-help`}
            checked={prefs.data?.[field] === true} disabled={!prefs.ready || prefs.saving}
            onCheckedChange={value => prefs.save({ [field]: value }).catch(() => {})} />
        </div>
      ))}
      <p role="status" className="text-sm">{prefs.saving ? 'Saving…' : !prefs.ready && !prefs.error ? 'Loading alert preferences…' : ''}</p>
      {prefs.error && <div role="alert" className="text-sm text-destructive">{prefs.error.message}
        <Button variant="ghost" onClick={() => prefs.retry()}>Reload preferences</Button></div>}
    </section>
  );
}
