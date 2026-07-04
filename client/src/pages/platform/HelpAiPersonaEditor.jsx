import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Save, Upload, Bot } from 'lucide-react';

const PREF_KEY = 'ai_help_persona';
const MAX_AVATAR_PX = 256;

function personaInitial(name) {
  const trimmed = (name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : 'A';
}

async function fileToResizedDataUrl(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });

  const scale = Math.min(1, MAX_AVATAR_PX / Math.max(img.width, img.height));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL('image/png');
}

export default function HelpAiPersonaEditor() {
  const { toast } = useToast();
  const fileInputRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [persona, setPersona] = useState({ name: 'Dougal', avatarUrl: '', description: '' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/platform/preferences?key=${PREF_KEY}`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && data?.value) {
            setPersona((prev) => ({ ...prev, ...data.value }));
          }
        }
      } catch (err) {
        console.error('Failed to load AI persona:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Please choose an image file', variant: 'destructive' });
      return;
    }
    setProcessing(true);
    try {
      const avatarUrl = await fileToResizedDataUrl(file);
      setPersona((prev) => ({ ...prev, avatarUrl }));
    } catch (err) {
      toast({ title: 'Could not read image', description: err.message, variant: 'destructive' });
    } finally {
      setProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSave = async () => {
    const name = persona.name.trim();
    if (!name) {
      toast({ title: 'Name required', description: 'Give the assistant a name.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/platform/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          key: PREF_KEY,
          value: { name, avatarUrl: persona.avatarUrl || '', description: (persona.description || '').trim() },
          description: 'Name and avatar for the Help Center AI assistant',
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save');
      toast({ title: 'Saved', description: 'AI assistant details updated.' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          AI Assistant
        </CardTitle>
        <CardDescription>
          Set the name and avatar shown for the Help Center AI assistant. These appear on the
          member-facing Help page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar className="h-16 w-16">
            {persona.avatarUrl ? <AvatarImage src={persona.avatarUrl} alt={persona.name} /> : null}
            <AvatarFallback>{personaInitial(persona.name)}</AvatarFallback>
          </Avatar>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFile}
              data-testid="input-ai-avatar-file"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={processing}
              data-testid="button-ai-avatar-upload"
            >
              {processing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Upload image
            </Button>
            {persona.avatarUrl ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPersona((prev) => ({ ...prev, avatarUrl: '' }))}
                data-testid="button-ai-avatar-remove"
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>

        <div className="max-w-sm space-y-2">
          <Label htmlFor="ai-persona-name">Assistant name</Label>
          <Input
            id="ai-persona-name"
            value={persona.name}
            onChange={(e) => setPersona((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="e.g. Dougal"
            data-testid="input-ai-persona-name"
          />
        </div>

        <div className="max-w-sm space-y-2">
          <Label htmlFor="ai-persona-description">Description</Label>
          <Textarea
            id="ai-persona-description"
            value={persona.description || ''}
            onChange={(e) => setPersona((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="e.g. Your friendly guide to getting the most out of the platform."
            rows={3}
            data-testid="input-ai-persona-description"
          />
        </div>

        <div>
          <Button onClick={handleSave} disabled={saving} data-testid="button-save-ai-persona">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
