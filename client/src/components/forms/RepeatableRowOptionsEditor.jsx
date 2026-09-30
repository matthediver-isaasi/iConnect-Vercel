import React, { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { parseRepeatableRowOptionsText } from "../../../../shared/formRepeatableRows.js";

export default function RepeatableRowOptionsEditor({ id, options, onChange }) {
  const [draft, setDraft] = useState(null);

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">Options (one per line)</Label>
      <Textarea
        id={id}
        data-testid={id}
        rows={3}
        value={draft ?? (options || []).join('\n')}
        onChange={event => {
          const text = event.target.value;
          // Keep incomplete lines local; the form always holds save-ready choices,
          // including when the dialog closes or Save runs without a blur.
          setDraft(text);
          onChange(parseRepeatableRowOptionsText(text));
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}