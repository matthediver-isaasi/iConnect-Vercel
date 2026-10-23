import React, { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export const templateDisplayName = template => template.name?.trim() || "Unnamed template";

// Sort a copy: the active-template query cache is shared with other consumers.
export function alphabeticalTemplates(templates) {
  return [...templates].sort((a, b) =>
    templateDisplayName(a).toLowerCase().localeCompare(templateDisplayName(b).toLowerCase()));
}

export default function FormBuilderEmailTemplatePicker({
  templates, value, onChange, emptyLabel, testId, label = "Email Template",
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const sorted = useMemo(() => alphabeticalTemplates(templates), [templates]);
  const selected = templates.find(template => template.id === value);
  const query = search.trim().toLowerCase();
  const visible = sorted.filter(template => templateDisplayName(template).toLowerCase().includes(query));
  const showEmptyOption = emptyLabel.toLowerCase().includes(query);
  const changeOpen = next => {
    setOpen(next);
    setSearch("");
  };
  const choose = next => {
    if (next !== (value || null)) onChange(next);
    changeOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-label={label}
          aria-expanded={open} className="w-full justify-between font-normal" data-testid={testId}>
          <span className="truncate">
            {selected ? templateDisplayName(selected) : value ? "Unavailable template" : emptyLabel}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput aria-label={`Search ${label}`} placeholder="Search templates..."
            value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No templates found.</CommandEmpty>
            {showEmptyOption && (
              <CommandItem value="no-template" onSelect={() => choose(null)}>
                <Check className={cn("h-4 w-4", !value ? "opacity-100" : "opacity-0")} />
                {emptyLabel}
              </CommandItem>
            )}
            {visible.map(template => (
              <CommandItem key={template.id} value={`template-${template.id}`} onSelect={() => choose(template.id)}
                data-testid={`${testId}-option-${template.id}`}>
                <Check className={cn("h-4 w-4", template.id === value ? "opacity-100" : "opacity-0")} />
                <span className="truncate">{templateDisplayName(template)}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
