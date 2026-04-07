import { useState } from "react";
import { Check, ChevronsUpDown, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function getMemberLabel(member) {
  return [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Unknown";
}

export default function MemberCombobox({ members = [], value, onValueChange, placeholder = "Select member...", unassignedLabel = "Unassigned", testId = "combobox-member" }) {
  const [open, setOpen] = useState(false);

  const selectedMember = value && value !== "unassigned" ? members.find((m) => m.id === value) : null;
  const displayLabel = selectedMember ? getMemberLabel(selectedMember) : (value === "unassigned" || !value ? unassignedLabel : "Unknown");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={testId}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search members..." data-testid={`${testId}-search`} />
          <CommandList>
            <CommandEmpty>No members found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="unassigned"
                onSelect={() => {
                  onValueChange("unassigned");
                  setOpen(false);
                }}
                data-testid={`${testId}-option-unassigned`}
              >
                <Check className={cn("mr-2 h-4 w-4", (!value || value === "unassigned") ? "opacity-100" : "opacity-0")} />
                {unassignedLabel}
              </CommandItem>
              {members.map((m) => {
                const label = getMemberLabel(m);
                return (
                  <CommandItem
                    key={m.id}
                    value={`${label} ${m.email || ""}`}
                    onSelect={() => {
                      onValueChange(m.id);
                      setOpen(false);
                    }}
                    data-testid={`${testId}-option-${m.id}`}
                  >
                    <Check className={cn("mr-2 h-4 w-4", value === m.id ? "opacity-100" : "opacity-0")} />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm truncate">{label}</span>
                      {m.email && <span className="text-xs text-muted-foreground truncate">{m.email}</span>}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
