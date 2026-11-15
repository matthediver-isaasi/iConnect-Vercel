import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Palette } from 'lucide-react';

const presets = [
  ['Blue', '#dbeafe'], ['Green', '#dcfce7'], ['Amber', '#fef3c7'],
  ['Pink', '#fce7f3'], ['Purple', '#ede9fe'], ['Slate', '#334155'],
];
export default function ProjectListColour({ list, disabled, onChange }) {
  const [custom, setCustom] = useState(list.color || '#dbeafe');
  return <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
        disabled={disabled} aria-label={`Background colour for ${list.name}`}>
        <Palette className="h-4 w-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-64 text-foreground" align="start">
      <p className="mb-3 text-sm font-semibold">List background colour</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Preset colours">
        {presets.map(([name, color]) => <button key={color} type="button"
          className="h-8 w-8 rounded border border-gray-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ backgroundColor: color }} aria-label={name} aria-pressed={list.color === color}
          disabled={disabled} onClick={() => onChange(color)} />)}
      </div>
      <label className="mt-3 flex items-center justify-between text-sm">
        Custom colour
        <input type="color" aria-label="Custom list colour" value={custom}
          disabled={disabled} onChange={event => setCustom(event.target.value)} />
      </label>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={disabled} onClick={() => onChange(custom)}>Apply custom</Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onChange(null)}>Default</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
