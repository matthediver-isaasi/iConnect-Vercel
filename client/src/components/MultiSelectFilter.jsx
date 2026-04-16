import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

export default function MultiSelectFilter({
  options,
  selected,
  onChange,
  placeholder,
  className,
  "data-testid": testId,
}) {
  const [open, setOpen] = useState(false);

  const toggleValue = (value) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const clearAll = (e) => {
    e.stopPropagation();
    onChange([]);
  };

  const triggerLabel = selected.length === 0
    ? placeholder
    : selected.length === 1
      ? options.find((o) => o.value === selected[0])?.label || selected[0]
      : `${selected.length} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "justify-between font-normal",
            selected.length === 0 && "text-muted-foreground",
            className
          )}
          data-testid={testId}
        >
          <span className="truncate">{triggerLabel}</span>
          <div className="flex items-center gap-1 ml-1 shrink-0">
            {selected.length > 0 && (
              <span
                role="button"
                tabIndex={0}
                className="rounded-full hover:bg-muted p-0.5"
                onClick={clearAll}
                onKeyDown={(e) => { if (e.key === "Enter") clearAll(e); }}
                data-testid={testId ? `${testId}-clear` : undefined}
              >
                <X className="h-3 w-3" />
              </span>
            )}
            <ChevronDown className="h-3 w-3 opacity-50" />
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <ScrollArea className={options.length > 8 ? "h-[260px]" : ""}>
          <div className="p-1">
            {options.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover-elevate"
                data-testid={testId ? `${testId}-option-${option.value}` : undefined}
              >
                <Checkbox
                  checked={selected.includes(option.value)}
                  onCheckedChange={() => toggleValue(option.value)}
                />
                <span className="text-sm truncate">{option.label}</span>
              </label>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
