import React from "react";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import { getDirectoryFilterOptions } from "@/utils/directorySettings";
import { countExpressionNodes, replaceExpressionNode, expressionSummary } from "@/utils/directoryExpressionEditor";

const selectClass = "h-9 w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600";

export default function DirectoryExpressionEditor({ expression, fields, onChange, loading, loadError, onRetry, savedError, onReplace, error }) {
  const count = expression ? countExpressionNodes(expression.root) : 0;
  const update = (path, node) => onChange({ ...expression, root: replaceExpressionNode(expression.root, path, node) });
  const remove = path => {
    const parentPath = path.slice(0, -1);
    let parent = expression.root;
    for (const index of parentPath) parent = parent.children[index];
    update(parentPath, { ...parent, children: parent.children.filter((_, index) => index !== path[path.length - 1]) });
  };
  const renderNode = (node, path = [], depth = 1) => {
    const address = path.length ? path.map(index => index + 1).join(".") : "root";
    if (node.children) {
      return (
        <fieldset key={address} className="min-w-0 space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
          <legend className="px-1 text-xs font-medium text-slate-600">Group {address}</legend>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label={`Match conditions in group ${address}`} className={`${selectClass} !w-auto`} value={node.op}
              onChange={event => update(path, { ...node, op: event.target.value })}>
              <option value="and">All conditions</option>
              <option value="or">Any condition</option>
            </select>
            <span className="text-xs text-slate-500">must match</span>
            {path.length > 0 && <Button type="button" size="sm" variant="ghost" aria-label={`Remove group ${address}`} onClick={() => remove(path)}><Trash2 className="h-4 w-4" /></Button>}
          </div>
          {node.children.map((child, index) => renderNode(child, [...path, index], depth + 1))}
          {node.children.length === 0 && <p role="alert" className="text-xs text-red-700">Add a condition. Empty groups cannot be saved.</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={loading || !!loadError || count >= 100 || depth >= 5}
              aria-label={`Add condition to group ${address}`}
              onClick={() => update(path, { ...node, children: [...node.children, { field_id: "", value: "" }] })}>
              <Plus className="mr-1 h-3 w-3" />Condition
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={loading || !!loadError || count > 98 || depth >= 4}
              aria-label={`Add group to group ${address}`}
              onClick={() => update(path, { ...node, children: [...node.children, { op: "and", children: [{ field_id: "", value: "" }] }] })}>
              <Plus className="mr-1 h-3 w-3" />Group
            </Button>
          </div>
        </fieldset>
      );
    }
    const field = fields.find(f => f.id === node.field_id);
    const options = getDirectoryFilterOptions(field);
    const hasValue = node.value !== null && node.value !== undefined && node.value !== "";
    const knownValue = options.some(option => String(option.value) === String(node.value));
    return (
      <div key={address} className="space-y-1">
        <div className="grid min-w-0 grid-cols-[1fr_auto] items-end gap-2">
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <label className="min-w-0 space-y-1 text-xs text-slate-600">
              <span>Field</span>
              <select aria-label={`Condition ${address} field`} className={selectClass} value={node.field_id} disabled={loading || !!loadError}
                onChange={event => update(path, { field_id: event.target.value, value: "" })}>
                <option value="">Choose field</option>
                {node.field_id && !field && <option value={node.field_id}>Unavailable: {node.field_id}</option>}
                {fields.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="min-w-0 space-y-1 text-xs text-slate-600">
              <span>Equals</span>
              <select aria-label={`Condition ${address} value`} className={selectClass} value={hasValue ? String(node.value) : ""} disabled={!field || loading || !!loadError}
                onChange={event => update(path, { ...node, value: field.field_type === "boolean" && event.target.value !== "" ? event.target.value === "true" : event.target.value })}>
                <option value="">Choose value</option>
                {hasValue && !knownValue && <option value={String(node.value)}>Unavailable: {String(node.value)}</option>}
                {options.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <Button type="button" size="icon" variant="ghost" aria-label={`Remove condition ${address}`} onClick={() => remove(path)}><Trash2 className="h-4 w-4" /></Button>
        </div>
        {!loading && !loadError && node.field_id && !field && <p role="alert" className="text-xs text-red-700">Saved field is inactive, unsupported or unavailable. Replace or remove this condition.</p>}
        {!loading && !loadError && field && hasValue && !knownValue && <p role="status" className="text-xs text-amber-800">Saved value is no longer listed. Its original meaning is retained unless you choose another value.</p>}
      </div>
    );
  };
  return (
    <section aria-label="Directory inclusion rules" className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Inclusion rules *</h3>
        <p className="text-xs text-slate-500">Include entries matching these conditions. Combine All / Any groups, up to 5 levels and 100 nodes.</p>
      </div>
      {loading && <div role="status" className="h-10 animate-pulse rounded-md bg-slate-100"><span className="sr-only">Loading available fields</span></div>}
      {loadError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">Could not load available fields. Saved selections have been kept.<Button type="button" variant="outline" size="sm" className="mt-2 block" onClick={onRetry}>Retry fields</Button></div>}
      {savedError ? <div role="alert" className="rounded-md border border-red-200 p-3 text-sm text-red-800">
        Saved inclusion rules are invalid: {savedError}. Saving is blocked until they are replaced.
        <Button type="button" variant="outline" size="sm" className="mt-2 block" onClick={onReplace}>Replace invalid rules</Button>
      </div> : expression && renderNode(expression.root)}
      {!loading && !loadError && !fields.length && <p className="text-xs text-slate-600">No active picklist, dropdown or boolean fields are available for this entity. Create a field in Preference Fields settings first.</p>}
      {expression && <div className="rounded-md border border-blue-100 bg-blue-50 p-3">
        <p className="mb-1 text-xs font-medium text-blue-900">Inclusion summary · {count}/100 nodes</p>
        <p aria-live="polite" className="break-words text-xs text-blue-800">{expressionSummary(expression, fields)}</p>
      </div>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </section>
  );
}
