import { useId } from 'react';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Native checkboxes deliberately retain browser keyboard and label behaviour.
// Content is portalled by the shared Radix wrapper, outside canvas clipping.
export default function DirectoryVisitorFilterDropdown({ fields, value, onChange, asEditor }) {
  const id = useId();
  if (!fields.length) return null;
  const count = Object.values(value).reduce((sum, values) => sum + values.length, 0);
  const summary = fields.flatMap(field => field.options
    .filter(option => value[field.id]?.includes(option.value))
    .map(option => option.label)).join(', ');
  const guard = asEditor ? event => event.stopPropagation() : undefined;
  return (
    <div className="min-w-0 max-w-full" onClick={guard} onPointerDown={guard}>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" data-testid="button-directory-filters" aria-label={count ? `Filters, ${count} selected` : 'Filters'}>
            <SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
            Filters{count ? ` (${count})` : ''}
            <ChevronDown className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end" collisionPadding={12}
          data-testid="directory-filter-popover"
          aria-label="Filter directory"
          onClick={guard} onPointerDown={guard}
          style={{
            width: 'min(24rem, calc(100vw - 24px))',
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'min(32rem, var(--radix-popover-content-available-height, calc(100dvh - 24px)))',
            overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain',
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-4">
            <span className="font-semibold text-sm">Filter directory</span>
            <Button variant="ghost" size="sm" disabled={!count} onClick={() => onChange({})} data-testid="button-directory-filters-clear">Clear all</Button>
          </div>
          <div className="space-y-5">
            {fields.map((field, fieldIndex) => (
              <fieldset key={field.id} className="min-w-0">
                <legend className="mb-2 text-sm font-semibold" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{field.label}</legend>
                <div className="space-y-1">
                  {field.options.map((option, optionIndex) => {
                    const inputId = `${id}-${fieldIndex}-${optionIndex}`;
                    const checked = !!value[field.id]?.includes(option.value);
                    return (
                      <label key={option.value} htmlFor={inputId} className="flex items-start gap-2 rounded px-1 py-2 cursor-pointer text-sm hover:bg-muted" style={{ minWidth: 0 }}>
                        <input id={inputId} type="checkbox" className="mt-0.5 shrink-0" checked={checked}
                          onChange={() => {
                            const values = checked ? value[field.id].filter(item => item !== option.value) : [...(value[field.id] || []), option.value];
                            const next = { ...value };
                            if (values.length) next[field.id] = values;
                            else delete next[field.id];
                            onChange(next);
                          }} />
                        <span style={{ minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {count > 0 && <p className="m-0 mt-1 text-xs text-muted-foreground" data-testid="directory-filter-summary" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal', maxWidth: '24rem' }}>{summary}</p>}
    </div>
  );
}
