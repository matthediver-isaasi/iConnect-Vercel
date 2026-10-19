import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { publicClient } from '@/api/publicClient';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { discoverDirectoryCarouselSources, resolveDirectoryCarouselSource } from './directoryCarouselSource.mjs';

export function DirectoryCarouselSourceField({ content, onChange }) {
  const [open, setOpen] = useState(false);
  const { memberInfo, memberRole } = useLayoutContext();
  const tenant = publicClient.getTenantSlug() || '';
  const { data: directories = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['canvas', 'directory-carousel-sources', tenant, memberInfo?.id || '', memberRole?.id || ''],
    queryFn: () => discoverDirectoryCarouselSources(base44.entities.DynamicDirectory),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const source = resolveDirectoryCarouselSource(content);
  const options = [
    { value: 'primary-member', label: 'Primary Member Directory', source: 'primary-member' },
    { value: 'primary-organization', label: 'Primary Organisation Directory', source: 'primary-organization' },
    ...directories.map((directory) => ({
      value: `dynamic:${directory.id}`,
      source: 'dynamic',
      directoryId: directory.id,
      directorySlug: directory.slug,
      label: directory.name || directory.slug,
      kind: directory.entity_type === 'member' ? 'Members' : 'Organisations',
    })),
  ];
  const selected = options.find((option) => option.source === source.source && (
    option.source !== 'dynamic' || (source.directoryId
      ? option.directoryId === source.directoryId
      : option.directorySlug === source.directorySlug)
  ));
  return (
    <div className="space-y-1">
      <Label className="text-xs text-slate-600">Directory source</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-auto min-h-8 w-full justify-between text-left text-xs font-normal"
            data-testid="select-directory-carousel-directory"
          >
            <span className="truncate">{selected?.label || (source.configured ? 'Saved directory (unavailable)' : 'Select a directory')}</span>
            <ChevronDown className="ml-2 h-3 w-3 shrink-0" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] max-w-[90vw] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search member or organisation directories…" />
            <CommandList>
              <CommandEmpty>{isLoading ? 'Loading directories…' : 'No matching directories.'}</CommandEmpty>
              <CommandGroup heading="Directory sources">
                {options.map((option) => (
                  <CommandItem key={option.value} value={`${option.value} ${option.label} ${option.kind || ''}`}
                    onSelect={() => {
                      onChange({ source: option.source, directoryId: option.directoryId || '', directorySlug: option.directorySlug || '' });
                      setOpen(false);
                    }}>
                    <Check className={`mr-2 h-3 w-3 shrink-0 ${selected?.value === option.value ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
                    <span className="min-w-0"><span className="block">{option.label}</span>{option.kind ? <span className="text-xs text-slate-500">{option.kind}</span> : null}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          {isError ? <div role="alert" className="border-t p-3 text-xs text-slate-600">
            Dynamic directories could not be loaded.
            <Button variant="link" size="sm" onClick={() => refetch()}>Retry</Button>
          </div> : null}
        </PopoverContent>
      </Popover>
      <p className="text-xs text-slate-500">Public carousel access is managed in directory administration, not here.</p>
    </div>
  );
}
