import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Shared tenant-scoped form selector for embedded forms and linked CTAs.
export function FormPickerField({ value, onChange, testId }) {
  const { data: forms, isLoading, isError } = useQuery({
    queryKey: ['canvas', 'public-forms'],
    queryFn: () => publicClient.listForms(),
    staleTime: 60_000,
  });
  const options = (forms || []).filter(f => f.is_active);
  return <div className="space-y-1">
    <Label className="text-xs">Form</Label>
    <Select value={value || ''} onValueChange={onChange}>
      <SelectTrigger className="h-8" data-testid={testId}><SelectValue placeholder="Select a form" /></SelectTrigger>
      <SelectContent>
        {options.length === 0 ? <SelectItem value="__none__" disabled>No active forms</SelectItem>
          : options.map(form => <SelectItem key={form.slug} value={form.slug}>{form.name}</SelectItem>)}
      </SelectContent>
    </Select>
    {isLoading && <p className="text-xs text-slate-500">Loading forms…</p>}
    {isError && <p className="text-xs text-red-700" role="alert">Forms could not be loaded. Close and reopen the picker to retry.</p>}
  </div>;
}