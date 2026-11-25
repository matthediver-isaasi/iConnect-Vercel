import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function CommunicationSubscriptionFields({ config, categories, loading, error, onChange }) {
  const selection = config?.communication_subscription || {};
  const ids = Array.isArray(selection.category_ids) ? selection.category_ids : [];
  const choices = categories.filter(category => category.is_active !== false && !category.system_key);
  const unavailable = ids.filter(id => !choices.some(category => category.id === id));
  const change = updates => onChange({ ...config, communication_subscription: { ...selection, ...updates } });
  return <div className="space-y-3">
    <Label>Communication Categories</Label>
    <p className="text-xs text-muted-foreground">
      Updates only the triggering member. Global opt-outs remain effective; subscribing requires current category audience and role eligibility. System-managed categories are not supported.
    </p>
    {loading && <p role="status">Loading categories…</p>}
    {error && <p role="alert" className="text-sm text-red-500">Categories could not be loaded. Try reopening the editor.</p>}
    <div className="max-h-48 overflow-y-auto space-y-2">
      {[...choices, ...unavailable.map(id => ({ id, name: `Unavailable category (${id})`, unavailable: true }))].map(category =>
        <label key={category.id} className="flex items-center gap-2 text-sm">
          <Checkbox aria-label={category.name} checked={ids.includes(category.id)}
            onCheckedChange={checked => change({ category_ids: checked
              ? [...new Set([...ids, category.id])] : ids.filter(id => id !== category.id) })} />
          <span className={category.unavailable ? 'text-red-500' : ''}>{category.name}</span>
        </label>)}
    </div>
    {!loading && !error && !choices.length && <p className="text-sm">No available communication categories.</p>}
    {unavailable.length > 0 && <p role="alert" className="text-sm text-red-500">Remove unavailable selections before saving.</p>}
    <Label>New Value</Label>
    <Select value={typeof selection.is_subscribed === 'boolean' ? String(selection.is_subscribed) : ''}
      onValueChange={value => change({ is_subscribed: value === 'true' })}>
      <SelectTrigger aria-label="Subscription state"><SelectValue placeholder="Select Subscribe or Unsubscribe" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="true">Subscribe</SelectItem>
        <SelectItem value="false">Unsubscribe</SelectItem>
      </SelectContent>
    </Select>
  </div>;
}
