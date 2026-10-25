import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

export default function MultiSelectFilter({
  options,
  selected,
  onChange,
  placeholder,
  className,
  "data-testid": testId,
  ...buttonProps
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
          {...buttonProps}
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
      <PopoverContent
        className="p-0 w-max min-w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))] max-w-[min(32rem,calc(100vw-2rem))]"
        align="start"
        collisionPadding={16}
      >
        <div className="max-h-[min(260px,var(--radix-popover-content-available-height))] overflow-y-auto">
          <div className="p-1">
            {options.map((option) => (
              <label
                key={option.value}
                className="flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer hover-elevate"
                data-testid={testId ? `${testId}-option-${option.value}` : undefined}
              >
                <Checkbox
                  className="mt-0.5 shrink-0"
                  checked={selected.includes(option.value)}
                  onCheckedChange={() => toggleValue(option.value)}
                />
                <span className="min-w-0 text-sm whitespace-normal [overflow-wrap:anywhere]">{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
