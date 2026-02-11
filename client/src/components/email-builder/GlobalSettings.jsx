import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function GlobalSettings({ settings, onChange }) {
  const update = (key, value) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">Background Color</Label>
        <Input
          type="color"
          value={settings.backgroundColor || '#f4f4f4'}
          onChange={(e) => update('backgroundColor', e.target.value)}
          className="h-8 p-1"
          data-testid="global-bg-color"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">Content Background</Label>
        <Input
          type="color"
          value={settings.contentBackgroundColor || '#ffffff'}
          onChange={(e) => update('contentBackgroundColor', e.target.value)}
          className="h-8 p-1"
          data-testid="global-content-bg-color"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">Content Width</Label>
        <Select 
          value={settings.contentWidth || '600px'} 
          onValueChange={(v) => update('contentWidth', v)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="500px">Narrow (500px)</SelectItem>
            <SelectItem value="600px">Standard (600px)</SelectItem>
            <SelectItem value="700px">Wide (700px)</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
