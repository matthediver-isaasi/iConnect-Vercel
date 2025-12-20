import React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

export default function StatusSelector({ value, onChange }) {
  const statusConfig = {
    draft: { label: "Draft", color: "bg-amber-100 text-amber-700" },
    published: { label: "Published", color: "bg-green-100 text-green-700" },
    archived: { label: "Archived", color: "bg-slate-100 text-slate-700" }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Status</Label>
        <Badge className={statusConfig[value]?.color}>
          {statusConfig[value]?.label}
        </Badge>
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="draft">Draft</SelectItem>
          <SelectItem value="published">Published</SelectItem>
          <SelectItem value="archived">Archived</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-slate-500">
        {value === 'draft' && 'Only visible to you'}
        {value === 'published' && 'Visible to all members'}
        {value === 'archived' && 'Hidden from listings'}
      </p>
    </div>
  );
}