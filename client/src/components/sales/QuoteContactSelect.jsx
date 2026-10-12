import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function QuoteContactSelect({ label, value, contacts, loading, error, disabled, emptyLabel, onChange }) {
  if (loading || error) {
    return <Input aria-label={label} aria-busy={loading || undefined} disabled
      value={loading ? "Loading contacts…" : "Unable to load contacts"} />;
  }
  const selected = String(value || "none");
  const contact = contacts.find(contact => String(contact.id) === selected);
  const missing = value && !contact;
  return <Select disabled={disabled} value={selected} onValueChange={(next) => {
    // Late Radix native-option hydration can emit an empty value. Only the
    // explicit sentinel should clear a saved contact.
    if (next) onChange(next === "none" ? "" : next);
  }}>
    <SelectTrigger aria-label={label}><SelectValue>{contact?.name || (missing ? "Saved contact unavailable" : emptyLabel)}</SelectValue></SelectTrigger>
    <SelectContent>
      <SelectItem value="none">{emptyLabel}</SelectItem>
      {missing && <SelectItem value={selected} disabled>Saved contact unavailable</SelectItem>}
      {contacts.map(contact => <SelectItem key={contact.id} value={String(contact.id)}>{contact.name}</SelectItem>)}
    </SelectContent>
  </Select>;
}
