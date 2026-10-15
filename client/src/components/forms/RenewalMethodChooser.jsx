import { Check } from "lucide-react";

export default function RenewalMethodChooser({
  options = [],
  selectedMethod,
  busyMethod,
  disabled = false,
  onSelect,
}) {
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-base font-semibold text-foreground">
        Choose how to pay
      </legend>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {options.map(({ id, label, price }) => {
          const selected = selectedMethod === id;
          const busy = busyMethod === id;

          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              aria-busy={busy}
              disabled={disabled}
              onClick={() => onSelect(id)}
              className={`flex min-h-28 w-full items-start gap-3 rounded-lg border-2 p-5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-card text-card-foreground hover:border-primary/60 hover:bg-accent/40"
              }`}
            >
              <span className="min-w-0 flex-1 space-y-2">
                <span className="block break-words text-base font-semibold">
                  {label}
                </span>
                {price != null && (
                  <span className="block text-sm text-muted-foreground">
                    {price}
                  </span>
                )}
                <span role="status" className="block text-sm text-muted-foreground">
                  {busy ? `Checking ${label}…` : ""}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border"
                }`}
              >
                {selected && <Check className="h-4 w-4" strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
