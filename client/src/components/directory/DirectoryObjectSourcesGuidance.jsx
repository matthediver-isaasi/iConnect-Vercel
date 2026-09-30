import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function DirectoryObjectSourcesGuidance({ query }) {
  return (
    <div className="space-y-2 text-sm text-slate-600">
      <p>
        Individual Data Studio fields can be enabled in each object's Presentation settings.
        They are read-only here. Data Studio object and field permissions still govern access;
        directory ordering does not grant access or publish these fields to guests.
        {" "}<Link className="text-blue-700 underline" to="/CustomObjectsAdmin">Manage Data Studio objects and permissions</Link>.
      </p>
      <p>
        Saved reverse-card positions take priority: a directory override, then the tenant order.
        Fields without a saved position follow the object's Default list columns sequence.
        Other enabled fields follow by field label, then ID; object and relationship groups
        follow by label, then ID. List columns never enable directory access.
        Dragging a field saves an explicit position and can interleave it with other card details.
      </p>
      {query.isPending && query.fetchStatus !== "idle" && <p role="status">Loading Data Studio fields…</p>}
      {query.isError && (
        <div role="alert" className="flex items-center gap-2">
          <span>Data Studio fields could not be loaded. Retry before reordering to preserve saved positions.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button>
        </div>
      )}
    </div>
  );
}