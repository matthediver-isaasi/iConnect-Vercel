import { Button } from '@/components/ui/button';

export default function CrmAlphabetBar({ navigation }) {
  const { visible, groups, loading, error, retry, busy, jump, selectedKey, announcement } = navigation;
  if (!visible) return null;
  return (
    <div className="mb-4" data-testid="crm-alphabet">
      {loading ? (
        <div role="status" aria-label="Loading alphabet navigation" className="flex gap-2 py-2">
          {[0, 1, 2, 3, 4].map(key => (
            <span key={key} className="h-8 w-12 rounded-md bg-slate-100" aria-hidden="true" />
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-3 text-sm text-slate-500" role="status">
          <span>Alphabet navigation unavailable. You can still browse the list.</span>
          <Button variant="outline" size="sm" onClick={retry}>Retry alphabet</Button>
        </div>
      ) : groups.length > 0 ? (
        <nav aria-label="Alphabet navigation" className="flex items-center gap-1 overflow-x-auto py-1"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
            const index = buttons.indexOf(document.activeElement);
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}>
          <span className="mr-2 shrink-0 text-xs text-slate-500" aria-hidden="true">Jump to</span>
          {groups.map(group => (
            <Button key={group.key} type="button" size="sm"
              className="shrink-0 focus-visible:ring-2"
              variant={selectedKey === group.key ? 'default' : 'outline'}
              aria-current={selectedKey === group.key ? 'location' : undefined}
              aria-label={`Jump to ${group.label}, ${group.count} records`}
              disabled={busy} onClick={() => jump(group)}>
              {group.label}
            </Button>
          ))}
        </nav>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
