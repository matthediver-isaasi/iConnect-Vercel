import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

export default function GlobalSettings({ settings, onChange, footerHtml, footerLoading }) {
  const update = (key, value) => {
    onChange({ ...settings, [key]: value });
  };

  const useDefaultFooter = settings.useDefaultFooter !== false;

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
      <div className="space-y-2">
        <Label className="text-xs">Content Padding</Label>
        <Select
          value={settings.contentPadding || '0px'}
          onValueChange={(v) => update('contentPadding', v)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0px">None</SelectItem>
            <SelectItem value="10px">Small (10px)</SelectItem>
            <SelectItem value="20px">Medium (20px)</SelectItem>
            <SelectItem value="30px">Large (30px)</SelectItem>
            <SelectItem value="40px">Extra Large (40px)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="border-t pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label className="text-xs">Use default email footer</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Appends your tenant's email footer when sent
            </p>
          </div>
          <Switch
            checked={useDefaultFooter}
            onCheckedChange={(checked) => update('useDefaultFooter', checked)}
            data-testid="toggle-default-footer"
          />
        </div>
        {useDefaultFooter && (
          <div className="mt-3 rounded border bg-muted/30 p-3">
            {footerLoading ? (
              <p className="text-xs text-muted-foreground italic">Loading footer preview...</p>
            ) : footerHtml ? (
              <div
                className="text-xs [&_a]:text-blue-600 [&_a]:underline [&_img]:max-w-full"
                dangerouslySetInnerHTML={{ __html: footerHtml }}
              />
            ) : (
              <p className="text-xs text-muted-foreground italic">No email footer configured for this tenant.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
