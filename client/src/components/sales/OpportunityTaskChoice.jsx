import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import SalesBoardPicker from "./SalesBoardPicker";
import { useSalesProjectTasks } from "./useSalesProjectTasks";

export const DEFAULT_TASK_CHOICE = "standard";

export function useOpportunityTaskOptions(enabled) {
  return useSalesProjectTasks({ view: "create-options" }, enabled);
}

// Whether the selected task choice is complete and permitted.
export function taskChoiceReady(choice, board, options) {
  if (choice === "standard") return true;
  if (!options.data) return false;
  if (choice === "create") return Boolean(options.data.canCreateBoard);
  return Boolean(options.data.canLinkBoard && board);
}

export default function OpportunityTaskChoice({ open, choice, onChoice, board, onBoard, options }) {
  const loading = options.isLoading;
  const canCreate = Boolean(options.data?.canCreateBoard);
  const canLink = Boolean(options.data?.canLinkBoard);
  const items = [
    { value: "standard", label: "Use standard tasks", hint: "Simple follow-up tasks on the opportunity.", disabled: false },
    { value: "create", label: "Create a new project board now", hint: canCreate || loading ? "A private board named after this opportunity, owned by you. Add tasks straight away."
      : "You need permission to create project boards.", disabled: !canCreate },
    { value: "link", label: "Link to an existing project", hint: canLink || loading ? "Choose a live board you own or administer that isn't linked to another opportunity."
      : "You need access to Projects to link a board.", disabled: !canLink },
  ];
  return <fieldset className="space-y-2">
    <legend className="text-sm font-medium">Tasks *</legend>
    <p className="text-xs text-muted-foreground">This choice is fixed once the opportunity is created.</p>
    <RadioGroup value={choice} onValueChange={(value) => { onChoice(value); if (value !== "link") onBoard(null); }} className="gap-2">
      {items.map((item) => <Label key={item.value} htmlFor={`opp-task-${item.value}`}
        className={`flex items-start gap-3 rounded-lg border p-3 font-normal ${item.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${choice === item.value ? "border-primary bg-primary/5" : ""}`}>
        <RadioGroupItem id={`opp-task-${item.value}`} value={item.value} disabled={item.disabled} className="mt-0.5" />
        <span><span className="block text-sm font-medium">{item.label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{item.hint}</span></span>
      </Label>)}
    </RadioGroup>
    {options.error && <p role="alert" className="text-sm text-destructive">Could not check your Projects access: {options.error.message} <button type="button" className="underline" onClick={() => options.refetch()}>Retry</button></p>}
    {choice === "link" && canLink && <div className="rounded-lg border bg-muted/20 p-3">
      <SalesBoardPicker enabled={open} value={board} onChange={onBoard} />
      {!board && <p className="mt-2 text-xs text-muted-foreground">Select a board to continue.</p>}
    </div>}
  </fieldset>;
}
