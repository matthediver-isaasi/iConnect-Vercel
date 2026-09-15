import { Building, Check, Video } from "lucide-react";

const OPTIONS = [
  {
    value: "in-person",
    title: "In-Person Event",
    icon: Building,
  },
  {
    value: "online",
    title: "Online Event",
    icon: Video,
  },
];

export default function DeliveryModeCardSelector({
  isOnline,
  onChange,
  label,
  inPersonDescription = "Held at a physical location",
  onlineDescription = "Hosted online",
  testIdPrefix = "delivery-mode",
}) {
  const selectedValue = isOnline ? "online" : "in-person";

  return (
    <fieldset className="space-y-2">
      {label && <legend className="text-sm font-medium text-slate-900">{label}</legend>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {OPTIONS.map(({ value, title, icon: Icon }) => {
          const selected = selectedValue === value;
          const description = value === "online" ? onlineDescription : inPersonDescription;

          return (
            <label
              key={value}
              className={[
                "relative flex min-h-24 cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors",
                "hover:border-blue-400 hover:bg-blue-50/50",
                "focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2",
                selected
                  ? "border-blue-600 bg-blue-50 shadow-sm"
                  : "border-slate-200 bg-white",
              ].join(" ")}
              data-selected={selected ? "true" : "false"}
            >
              <input
                type="radio"
                name={`${testIdPrefix}-choice`}
                value={value}
                checked={selected}
                onChange={() => onChange(value === "online")}
                className="sr-only"
                data-testid={`${testIdPrefix}-${value}`}
              />
              <span
                className={[
                  "mt-0.5 rounded-md p-2",
                  selected ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600",
                ].join(" ")}
                aria-hidden="true"
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span className="font-medium text-slate-900">{title}</span>
                  {selected && <Check className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />}
                </span>
                <span className="mt-1 block text-sm text-slate-600">{description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}