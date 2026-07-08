import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Compact inline operator picker rendered next to a filter's label in the CRM
// filter sidebars. The first operator in `operators` is the default; the
// trigger is visually muted at the default and highlighted otherwise.
export default function FilterOperatorMenu({ operators, value, onChange, testId }) {
  const defaultOp = operators[0]?.value;
  const current = value || defaultOp;
  const currentDef = operators.find((o) => o.value === current) || operators[0];
  const isDefault = current === defaultOp;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "shrink-0 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-none hover:bg-slate-100",
            isDefault ? "text-slate-400" : "bg-blue-50 font-medium text-blue-600"
          )}
          aria-label="Change filter condition"
          data-testid={testId}
        >
          <span className="max-w-[110px] truncate">{currentDef?.label}</span>
          <ChevronDown className="h-2.5 w-2.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        <DropdownMenuRadioGroup value={current} onValueChange={onChange}>
          {operators.map((op) => (
            <DropdownMenuRadioItem
              key={op.value}
              value={op.value}
              className="text-xs"
              data-testid={testId ? `${testId}-${op.value}` : undefined}
            >
              {op.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
