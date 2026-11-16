import { useId, useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export default function EventEmailTemplatePicker({ emailId, templates, value, onSelect }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listId = useId();
  const selected = templates.find(template => template.id === value);
  const sorted = useMemo(() => [...templates].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  ), [templates]);
  const matches = sorted.filter(template => template.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  return (
    <Popover open={open} onOpenChange={nextOpen => { setOpen(nextOpen); setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`Load from Template: ${selected?.name || "Select a template to load..."}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="w-full justify-between bg-white font-normal"
          data-testid={`select-template-${emailId}`}
        >
          <span className="truncate">{selected?.name || "Select a template to load..."}</span>
          <ChevronsUpDown aria-hidden="true" className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Load from Template" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false} loop>
          <CommandInput
            placeholder="Search templates..."
            aria-label="Search templates by name"
            aria-controls={listId}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList id={listId} aria-label="Email templates">
            <CommandEmpty>No templates found.</CommandEmpty>
            <CommandGroup>
              {matches.map(template => (
                <CommandItem key={template.id} value={String(template.id)} onSelect={() => {
                  onSelect(template.id);
                  setOpen(false);
                  setSearch("");
                }}>
                  <Check aria-hidden="true" className={`h-4 w-4 shrink-0 ${template.id === value ? "opacity-100" : "opacity-0"}`} />
                  <span>{template.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
