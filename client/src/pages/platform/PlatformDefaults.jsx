import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Save, Shield } from 'lucide-react';

export default function PlatformDefaults() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaults, setDefaults] = useState({
    platformBrandingText: 'Powered by isaasi',
    platformBrandingUrl: 'https://isaasi.co.uk'
  });

  useEffect(() => {
    fetchDefaults();
  }, []);

  const fetchDefaults = async () => {
    try {
      const response = await fetch('/api/platform/preferences?key=platform_defaults', {
        credentials: 'include'
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.value) {
          setDefaults(prev => ({
            ...prev,
            ...data.value
          }));
        }
      }
    } catch (error) {
      console.error('Failed to fetch platform defaults:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/platform/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          key: 'platform_defaults',
          value: defaults,
          description: 'Platform-wide default settings for branding and appearance'
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save defaults');
      }

      toast({
        title: 'Success',
        description: 'Platform defaults saved successfully'
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive'
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5" />
            Platform Branding
          </CardTitle>
          <CardDescription>
            Configure the default platform branding that appears in tenant footers.
            Tenants can customize the colors but the text and link come from here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="platformBrandingText">Branding Text</Label>
            <Input
              id="platformBrandingText"
              value={defaults.platformBrandingText}
              onChange={(e) => setDefaults(prev => ({ ...prev, platformBrandingText: e.target.value }))}
              placeholder="e.g., Powered by isaasi"
              data-testid="input-platform-branding-text"
            />
            <p className="text-sm text-muted-foreground">
              This text appears at the bottom of tenant footers
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="platformBrandingUrl">Branding Link URL</Label>
            <Input
              id="platformBrandingUrl"
              value={defaults.platformBrandingUrl}
              onChange={(e) => setDefaults(prev => ({ ...prev, platformBrandingUrl: e.target.value }))}
              placeholder="e.g., https://isaasi.co.uk"
              data-testid="input-platform-branding-url"
            />
            <p className="text-sm text-muted-foreground">
              The URL users are taken to when clicking the branding text
            </p>
          </div>

          <div className="pt-4 border-t">
            <div className="bg-muted/50 rounded-md p-4">
              <p className="text-sm text-muted-foreground mb-2">Preview:</p>
              <p className="text-sm">
                <a 
                  href={defaults.platformBrandingUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {defaults.platformBrandingText}
                </a>
              </p>
            </div>
          </div>

          <div className="flex justify-end pt-4">
            <Button 
              onClick={handleSave} 
              disabled={saving}
              data-testid="button-save-defaults"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Defaults
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
