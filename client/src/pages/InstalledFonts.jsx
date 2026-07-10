import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  Type, 
  AlertCircle, 
  CheckCircle, 
  Loader2, 
  Plus, 
  Pencil, 
  Copy,
  Trash2, 
  Save, 
  X,
  Star,
  Eye,
  Search
} from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { CURATED_FONTS, POPULAR_GOOGLE_FONTS } from "@/lib/sharedFonts";
import {
  useInstalledFonts,
  injectInstalledFontsStylesheet,
  clearInstalledFontsCache,
  googleFamilyToken,
  buildFontStack,
} from "@/lib/installedFonts";

const STYLE_TYPES = [
  { value: 'h1', label: 'H1 - Main Heading' },
  { value: 'h2', label: 'H2 - Section Heading' },
  { value: 'h3', label: 'H3 - Subsection' },
  { value: 'h4', label: 'H4 - Minor Heading' },
  { value: 'paragraph', label: 'Paragraph' }
];

const FONT_WEIGHTS = [
  { value: 100, label: '100 - Thin' },
  { value: 200, label: '200 - Extra Light' },
  { value: 300, label: '300 - Light' },
  { value: 400, label: '400 - Regular' },
  { value: 500, label: '500 - Medium' },
  { value: 600, label: '600 - Semibold' },
  { value: 700, label: '700 - Bold' },
  { value: 800, label: '800 - Extra Bold' },
  { value: 900, label: '900 - Black' }
];

const TEXT_TRANSFORMS = [
  { value: 'none', label: 'None' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase', label: 'lowercase' },
  { value: 'capitalize', label: 'Capitalize' }
];

const AVAILABLE_FONTS = CURATED_FONTS;

const defaultStyle = {
  name: '',
  style_type: 'h1',
  font_family: 'Poppins, sans-serif',
  font_size: 48,
  font_size_tablet: null,
  font_size_mobile: null,
  font_weight: 600,
  line_height: 1.2,
  line_height_tablet: null,
  line_height_mobile: null,
  letter_spacing: 0,
  letter_spacing_tablet: null,
  letter_spacing_mobile: null,
  text_transform: 'none',
  color: '',
  margin_bottom: 24,
  margin_bottom_tablet: null,
  margin_bottom_mobile: null,
  is_default: false,
  is_active: true
};

function TypographyStyleEditor({ style, onSave, onCancel, isNew = false }) {
  const [formData, setFormData] = useState(style || defaultStyle);
  const [isSaving, setIsSaving] = useState(false);
  const { options: installedFontOptions } = useInstalledFonts();

  // Show the tenant's installed fonts; keep the currently-selected value visible
  // even if it is no longer installed (so editing an old style doesn't blank it).
  const fontOptions = React.useMemo(() => {
    const base = installedFontOptions && installedFontOptions.length ? installedFontOptions : AVAILABLE_FONTS;
    const current = formData.font_family;
    if (current && !base.some((f) => f.value === current)) {
      return [{ value: current, label: `${current} (not installed)` }, ...base];
    }
    return base;
  }, [installedFontOptions, formData.font_family]);

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async () => {
    setIsSaving(true);
    try {
      await onSave(formData);
    } finally {
      setIsSaving(false);
    }
  };

  const previewStyle = {
    fontFamily: formData.font_family,
    fontSize: `${formData.font_size}px`,
    fontWeight: formData.font_weight,
    lineHeight: formData.line_height,
    letterSpacing: `${formData.letter_spacing}px`,
    textTransform: formData.text_transform,
    color: formData.color || 'inherit',
    marginBottom: `${formData.margin_bottom}px`
  };

  return (
    <div className="space-y-6">
      {/* Preview Section */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-6">
        <h4 className="text-sm font-semibold text-slate-500 mb-3">Live Preview</h4>
        <div style={previewStyle}>
          The quick brown fox jumps over the lazy dog
        </div>
        {(formData.font_size_tablet || formData.line_height_tablet || formData.letter_spacing_tablet != null || formData.margin_bottom_tablet != null) && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <span className="text-xs text-slate-500 block mb-2">Tablet Preview</span>
            <div
              style={{
                ...previewStyle,
                ...(formData.font_size_tablet ? { fontSize: `${formData.font_size_tablet}px` } : {}),
                ...(formData.line_height_tablet ? { lineHeight: formData.line_height_tablet } : {}),
                ...(formData.letter_spacing_tablet != null && formData.letter_spacing_tablet !== '' ? { letterSpacing: `${formData.letter_spacing_tablet}px` } : {}),
                ...(formData.margin_bottom_tablet != null && formData.margin_bottom_tablet !== '' ? { marginBottom: `${formData.margin_bottom_tablet}px` } : {}),
              }}
            >
              The quick brown fox jumps over the lazy dog
            </div>
          </div>
        )}
        {(formData.font_size_mobile || formData.line_height_mobile || formData.letter_spacing_mobile != null || formData.margin_bottom_mobile != null) && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <span className="text-xs text-slate-500 block mb-2">Mobile Preview</span>
            <div
              style={{
                ...previewStyle,
                ...(formData.font_size_mobile ? { fontSize: `${formData.font_size_mobile}px` } : {}),
                ...(formData.line_height_mobile ? { lineHeight: formData.line_height_mobile } : {}),
                ...(formData.letter_spacing_mobile != null && formData.letter_spacing_mobile !== '' ? { letterSpacing: `${formData.letter_spacing_mobile}px` } : {}),
                ...(formData.margin_bottom_mobile != null && formData.margin_bottom_mobile !== '' ? { marginBottom: `${formData.margin_bottom_mobile}px` } : {}),
              }}
            >
              The quick brown fox jumps over the lazy dog
            </div>
          </div>
        )}
      </div>

      {/* Form Fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <Label htmlFor="name">Style Name</Label>
          <Input
            id="name"
            value={formData.name}
            onChange={(e) => handleChange('name', e.target.value)}
            placeholder="e.g., Hero H1, Section H2"
            data-testid="input-style-name"
          />
        </div>

        <div>
          <Label htmlFor="style_type">Style Type</Label>
          <Select
            value={formData.style_type}
            onValueChange={(value) => handleChange('style_type', value)}
          >
            <SelectTrigger data-testid="select-style-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STYLE_TYPES.map(type => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="font_family">Font Family</Label>
          <Select
            value={formData.font_family}
            onValueChange={(value) => handleChange('font_family', value)}
          >
            <SelectTrigger data-testid="select-font-family">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fontOptions.map(font => (
                <SelectItem key={font.value} value={font.value}>
                  <span style={{ fontFamily: font.value }}>{font.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="font_size">Font Size (px)</Label>
          <Input
            id="font_size"
            type="number"
            value={formData.font_size}
            onChange={(e) => handleChange('font_size', parseInt(e.target.value) || 16)}
            min="8"
            max="200"
            data-testid="input-font-size"
          />
        </div>

        <div>
          <Label htmlFor="font_size_tablet">Tablet Font Size (px)</Label>
          <Input
            id="font_size_tablet"
            type="number"
            value={formData.font_size_tablet || ''}
            onChange={(e) => handleChange('font_size_tablet', e.target.value ? parseInt(e.target.value) : null)}
            min="8"
            max="200"
            placeholder="Optional"
            data-testid="input-font-size-tablet"
          />
        </div>

        <div>
          <Label htmlFor="font_size_mobile">Mobile Font Size (px)</Label>
          <Input
            id="font_size_mobile"
            type="number"
            value={formData.font_size_mobile || ''}
            onChange={(e) => handleChange('font_size_mobile', e.target.value ? parseInt(e.target.value) : null)}
            min="8"
            max="200"
            placeholder="Optional"
            data-testid="input-font-size-mobile"
          />
        </div>

        <div>
          <Label htmlFor="font_weight">Font Weight</Label>
          <Select
            value={String(formData.font_weight)}
            onValueChange={(value) => handleChange('font_weight', parseInt(value))}
          >
            <SelectTrigger data-testid="select-font-weight">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_WEIGHTS.map(weight => (
                <SelectItem key={weight.value} value={String(weight.value)}>
                  {weight.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="line_height">Line Height</Label>
          <Input
            id="line_height"
            type="number"
            step="0.05"
            value={formData.line_height}
            onChange={(e) => handleChange('line_height', parseFloat(e.target.value) || 1.5)}
            min="0.5"
            max="3"
            data-testid="input-line-height"
          />
        </div>

        <div>
          <Label htmlFor="line_height_tablet">Tablet Line Height</Label>
          <Input
            id="line_height_tablet"
            type="number"
            step="0.05"
            value={formData.line_height_tablet ?? ''}
            onChange={(e) => handleChange('line_height_tablet', e.target.value ? parseFloat(e.target.value) : null)}
            min="0.5"
            max="3"
            placeholder="Optional"
            data-testid="input-line-height-tablet"
          />
        </div>

        <div>
          <Label htmlFor="line_height_mobile">Mobile Line Height</Label>
          <Input
            id="line_height_mobile"
            type="number"
            step="0.05"
            value={formData.line_height_mobile ?? ''}
            onChange={(e) => handleChange('line_height_mobile', e.target.value ? parseFloat(e.target.value) : null)}
            min="0.5"
            max="3"
            placeholder="Optional"
            data-testid="input-line-height-mobile"
          />
        </div>

        <div>
          <Label htmlFor="letter_spacing">Letter Spacing (px)</Label>
          <Input
            id="letter_spacing"
            type="number"
            step="0.5"
            value={formData.letter_spacing}
            onChange={(e) => handleChange('letter_spacing', parseFloat(e.target.value) || 0)}
            min="-5"
            max="20"
            data-testid="input-letter-spacing"
          />
        </div>

        <div>
          <Label htmlFor="letter_spacing_tablet">Tablet Letter Spacing (px)</Label>
          <Input
            id="letter_spacing_tablet"
            type="number"
            step="0.5"
            value={formData.letter_spacing_tablet ?? ''}
            onChange={(e) => handleChange('letter_spacing_tablet', e.target.value !== '' ? parseFloat(e.target.value) : null)}
            min="-5"
            max="20"
            placeholder="Optional"
            data-testid="input-letter-spacing-tablet"
          />
        </div>

        <div>
          <Label htmlFor="letter_spacing_mobile">Mobile Letter Spacing (px)</Label>
          <Input
            id="letter_spacing_mobile"
            type="number"
            step="0.5"
            value={formData.letter_spacing_mobile ?? ''}
            onChange={(e) => handleChange('letter_spacing_mobile', e.target.value !== '' ? parseFloat(e.target.value) : null)}
            min="-5"
            max="20"
            placeholder="Optional"
            data-testid="input-letter-spacing-mobile"
          />
        </div>

        <div>
          <Label htmlFor="text_transform">Text Transform</Label>
          <Select
            value={formData.text_transform}
            onValueChange={(value) => handleChange('text_transform', value)}
          >
            <SelectTrigger data-testid="select-text-transform">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEXT_TRANSFORMS.map(transform => (
                <SelectItem key={transform.value} value={transform.value}>
                  {transform.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="color">Text Color (optional)</Label>
          <div className="flex gap-2">
            <Input
              id="color"
              type="text"
              value={formData.color || ''}
              onChange={(e) => handleChange('color', e.target.value)}
              placeholder="e.g., #333333"
              className="flex-1"
              data-testid="input-color"
            />
            <input
              type="color"
              value={formData.color || '#000000'}
              onChange={(e) => handleChange('color', e.target.value)}
              className="w-12 h-10 border border-slate-300 rounded cursor-pointer"
              data-testid="input-color-picker"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="margin_bottom">Margin Bottom (px)</Label>
          <Input
            id="margin_bottom"
            type="number"
            value={formData.margin_bottom}
            onChange={(e) => handleChange('margin_bottom', parseInt(e.target.value) || 0)}
            min="0"
            max="100"
            data-testid="input-margin-bottom"
          />
        </div>

        <div>
          <Label htmlFor="margin_bottom_tablet">Tablet Margin Bottom (px)</Label>
          <Input
            id="margin_bottom_tablet"
            type="number"
            value={formData.margin_bottom_tablet ?? ''}
            onChange={(e) => handleChange('margin_bottom_tablet', e.target.value !== '' ? parseInt(e.target.value) : null)}
            min="0"
            max="100"
            placeholder="Optional"
            data-testid="input-margin-bottom-tablet"
          />
        </div>

        <div>
          <Label htmlFor="margin_bottom_mobile">Mobile Margin Bottom (px)</Label>
          <Input
            id="margin_bottom_mobile"
            type="number"
            value={formData.margin_bottom_mobile ?? ''}
            onChange={(e) => handleChange('margin_bottom_mobile', e.target.value !== '' ? parseInt(e.target.value) : null)}
            min="0"
            max="100"
            placeholder="Optional"
            data-testid="input-margin-bottom-mobile"
          />
        </div>

        <div className="flex items-center gap-4 pt-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.is_default}
              onChange={(e) => handleChange('is_default', e.target.checked)}
              className="w-4 h-4"
              data-testid="checkbox-is-default"
            />
            <span className="text-sm">Set as default for this type</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.is_active}
              onChange={(e) => handleChange('is_active', e.target.checked)}
              className="w-4 h-4"
              data-testid="checkbox-is-active"
            />
            <span className="text-sm">Active</span>
          </label>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        <Button variant="outline" onClick={onCancel} data-testid="button-cancel">
          <X className="w-4 h-4 mr-2" />
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isSaving || !formData.name} data-testid="button-save">
          {isSaving ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {isNew ? 'Create Style' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}

function TypographyStyleCard({ style, onEdit, onDuplicate, onDelete, onSetDefault }) {
  const previewStyle = {
    fontFamily: style.font_family,
    fontSize: `${Math.min(style.font_size, 32)}px`,
    fontWeight: style.font_weight,
    lineHeight: style.line_height,
    letterSpacing: `${style.letter_spacing}px`,
    textTransform: style.text_transform,
    color: style.color || 'inherit'
  };

  const typeLabel = STYLE_TYPES.find(t => t.value === style.style_type)?.label || style.style_type;

  return (
    <Card className={`border-slate-200 ${!style.is_active ? 'opacity-60' : ''}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              {style.name}
              {style.is_default && (
                <Badge variant="secondary" className="text-xs">
                  <Star className="w-3 h-3 mr-1" />
                  Default
                </Badge>
              )}
            </CardTitle>
            <div className="flex gap-2 mt-1">
              <Badge variant="outline">{typeLabel}</Badge>
              {!style.is_active && (
                <Badge variant="destructive">Inactive</Badge>
              )}
            </div>
          </div>
          <div className="flex gap-1">
            {!style.is_default && (
              <Button 
                size="icon" 
                variant="ghost" 
                onClick={() => onSetDefault(style)}
                title="Set as default"
                data-testid={`button-set-default-${style.id}`}
              >
                <Star className="w-4 h-4" />
              </Button>
            )}
            <Button 
              size="icon" 
              variant="ghost" 
              onClick={() => onEdit(style)}
              data-testid={`button-edit-${style.id}`}
            >
              <Pencil className="w-4 h-4" />
            </Button>
            <Button 
              size="icon" 
              variant="ghost" 
              onClick={() => onDuplicate(style)}
              title="Duplicate style"
              data-testid={`button-duplicate-${style.id}`}
            >
              <Copy className="w-4 h-4" />
            </Button>
            <Button 
              size="icon" 
              variant="ghost" 
              onClick={() => onDelete(style)}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              data-testid={`button-delete-${style.id}`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="bg-slate-50 rounded-lg p-4 mb-3">
          <div style={previewStyle}>
            The quick brown fox
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
          <div>Size: {style.font_size}px {style.font_size_mobile && `(${style.font_size_mobile}px mobile)`}</div>
          <div>Weight: {style.font_weight}</div>
          <div>Line Height: {style.line_height}{style.line_height_mobile != null && ` (${style.line_height_mobile} mobile)`}</div>
          <div>Letter Spacing: {style.letter_spacing}px{style.letter_spacing_mobile != null && ` (${style.letter_spacing_mobile}px mobile)`}</div>
          {style.color && <div>Color: {style.color}</div>}
          <div>Margin: {style.margin_bottom}px{style.margin_bottom_mobile != null && ` (${style.margin_bottom_mobile}px mobile)`}</div>
        </div>
      </CardContent>
    </Card>
  );
}

const PREVIEW_TEXT = 'The quick brown fox jumps over the lazy dog';

// Extract the human-readable message from a base44 "API Error (409): ..." throw.
function extractApiError(error, fallback) {
  const raw = error?.message || '';
  const stripped = raw.replace(/^API Error \(\d+\):\s*/, '').trim();
  return stripped || fallback;
}

function InstalledFontsManager() {
  const { toast } = useToast();
  const [fonts, setFonts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState('browse');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [liveResults, setLiveResults] = useState(null);
  const [liveFallback, setLiveFallback] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualCategory, setManualCategory] = useState('sans-serif');
  const [savingName, setSavingName] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const loadFonts = async () => {
    setIsLoading(true);
    try {
      const rows = await base44.entities.InstalledFont.list();
      const list = Array.isArray(rows) ? rows : [];
      list.sort((a, b) => {
        if (!!b.is_base !== !!a.is_base) return b.is_base ? 1 : -1;
        return String(a.label || '').localeCompare(String(b.label || ''));
      });
      setFonts(list);
    } catch (error) {
      console.error('Failed to load installed fonts:', error);
      toast({
        title: 'Error',
        description: 'Failed to load installed fonts',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadFonts();
  }, []);

  // Keep previews rendered: inject the combined stylesheet for installed fonts.
  useEffect(() => {
    if (fonts.length) injectInstalledFontsStylesheet(fonts);
  }, [fonts]);

  // Search the live Google Fonts catalogue (proxied server-side so the API key
  // stays private). Debounced on the search term. When the proxy signals a
  // fallback (key missing / upstream error) we drop back to the curated list.
  useEffect(() => {
    if (!addOpen || addMode !== 'browse') return;
    let alive = true;
    const q = search.trim();
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (categoryFilter !== 'all') params.set('category', categoryFilter);
        const res = await fetch(
          `/api/public/google-fonts?${params.toString()}`,
          { credentials: 'include' }
        );
        const data = res.ok ? await res.json() : null;
        if (!alive) return;
        if (data && Array.isArray(data.items) && !data.fallback) {
          setLiveResults(data.items);
          setLiveFallback(false);
        } else {
          setLiveResults(null);
          setLiveFallback(true);
        }
      } catch {
        if (alive) {
          setLiveResults(null);
          setLiveFallback(true);
        }
      } finally {
        if (alive) setIsSearching(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [addOpen, addMode, search, categoryFilter]);

  const installedNames = React.useMemo(
    () => new Set(fonts.map((f) => String(f.label || '').toLowerCase())),
    [fonts]
  );

  const addFont = async (name, category) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    if (installedNames.has(clean.toLowerCase())) {
      toast({ title: 'Already installed', description: `${clean} is already in your library.` });
      return;
    }
    setSavingName(clean);
    try {
      await base44.entities.InstalledFont.create({
        label: clean,
        font_stack: buildFontStack(clean, category),
        google_family: googleFamilyToken(clean),
        source: 'google',
        is_base: false,
        is_active: true,
      });
      clearInstalledFontsCache();
      toast({ title: 'Font added', description: `${clean} is now available.` });
      setManualName('');
      await loadFonts();
    } catch (error) {
      console.error('Failed to add font:', error);
      toast({
        title: 'Error',
        description: extractApiError(error, 'Failed to add font'),
        variant: 'destructive',
      });
    } finally {
      setSavingName(null);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setIsRemoving(true);
    try {
      await base44.entities.InstalledFont.delete(removeTarget.id);
      clearInstalledFontsCache();
      toast({ title: 'Font removed', description: `${removeTarget.label} was removed.` });
      setRemoveTarget(null);
      await loadFonts();
    } catch (error) {
      console.error('Failed to remove font:', error);
      toast({
        title: "Can't remove font",
        description: extractApiError(error, 'This font is in use and cannot be removed.'),
        variant: 'destructive',
      });
    } finally {
      setIsRemoving(false);
    }
  };

  // Fonts to show in the browse list: prefer live Google Fonts results; when the
  // proxy signals a fallback (no key / upstream error), use the curated list.
  const browseResults = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const usingLive = !liveFallback && liveResults !== null;
    // Live results are already filtered by category server-side; the curated
    // fallback list must be filtered client-side to match.
    const source = usingLive
      ? liveResults
      : POPULAR_GOOGLE_FONTS.filter(
          (f) =>
            (!q || f.name.toLowerCase().includes(q)) &&
            (categoryFilter === 'all' || f.category === categoryFilter)
        );
    return source.filter((f) => !installedNames.has(f.name.toLowerCase()));
  }, [search, categoryFilter, installedNames, liveResults, liveFallback]);

  // Load previews for the fonts currently shown so labels render in their own
  // typeface. Kept to a modest slice to keep the css2 request URL reasonable.
  useEffect(() => {
    if (!addOpen || addMode !== 'browse') return;
    const families = browseResults.slice(0, 40);
    if (families.length === 0) return;
    const id = 'installed-fonts-browse-preview';
    const href =
      'https://fonts.googleapis.com/css2?' +
      families.map((f) => `family=${googleFamilyToken(f.name)}:wght@400;600`).join('&') +
      '&display=swap';
    let link = document.getElementById(id);
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }, [addOpen, addMode, browseResults]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Installed Fonts</h2>
          <p className="text-sm text-slate-600">
            Fonts available across your typography styles, navigation, and public pages
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} data-testid="button-add-font">
          <Plus className="w-4 h-4 mr-2" />
          Add Font
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : fonts.length === 0 ? (
        <Card className="border-dashed border-2 border-slate-300">
          <CardContent className="py-12 text-center">
            <Type className="w-12 h-12 mx-auto text-slate-400 mb-4" />
            <h3 className="text-lg font-semibold text-slate-700 mb-2">No Fonts Installed</h3>
            <p className="text-slate-500 mb-4">Add a font to make it available across your site</p>
            <Button onClick={() => setAddOpen(true)} data-testid="button-add-first-font">
              <Plus className="w-4 h-4 mr-2" />
              Add Font
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {fonts.map((font) => (
            <Card key={font.id} className="border-slate-200" data-testid={`card-font-${font.id}`}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                  <span style={{ fontFamily: font.font_stack }} data-testid={`text-font-name-${font.id}`}>
                    {font.label}
                  </span>
                  <div className="flex items-center gap-2">
                    {font.is_base ? (
                      <Badge variant="secondary" data-testid={`badge-base-${font.id}`}>Base</Badge>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setRemoveTarget(font)}
                        data-testid={`button-remove-font-${font.id}`}
                        aria-label={`Remove ${font.label}`}
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    )}
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p style={{ fontFamily: font.font_stack, fontSize: '22px' }} className="text-slate-900">
                  {PREVIEW_TEXT}
                </p>
                <code className="text-xs bg-slate-100 px-2 py-1 rounded inline-block">
                  {font.font_stack}
                </code>
                {font.is_base && (
                  <p className="text-xs text-slate-500">
                    Always available and cannot be removed.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add a Font</DialogTitle>
          </DialogHeader>

          <Tabs value={addMode} onValueChange={setAddMode} className="space-y-4">
            <TabsList>
              <TabsTrigger value="browse" data-testid="tab-browse-fonts">Browse Library</TabsTrigger>
              <TabsTrigger value="manual" data-testid="tab-manual-font">Add by Name</TabsTrigger>
            </TabsList>

            <TabsContent value="browse" className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[12rem]">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search Google Fonts..."
                    className="pl-9"
                    data-testid="input-search-fonts"
                  />
                  {isSearching && (
                    <Loader2 className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 animate-spin" />
                  )}
                </div>
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="w-[11rem]" data-testid="select-category-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All styles</SelectItem>
                    <SelectItem value="sans-serif">Sans-serif</SelectItem>
                    <SelectItem value="serif">Serif</SelectItem>
                    <SelectItem value="display">Display</SelectItem>
                    <SelectItem value="handwriting">Handwriting</SelectItem>
                    <SelectItem value="monospace">Monospace</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {liveFallback && (
                <p className="text-xs text-slate-500" data-testid="text-fonts-fallback">
                  Showing a curated selection. Search the full Google Fonts library is
                  unavailable right now — use "Add by Name" for any other font.
                </p>
              )}
              <div className="max-h-80 overflow-y-auto space-y-1 pr-1">
                {browseResults.length === 0 ? (
                  <p className="text-sm text-slate-500 py-6 text-center">
                    No matching fonts. Try "Add by Name" for any Google font.
                  </p>
                ) : (
                  browseResults.map((f) => (
                    <div
                      key={f.name}
                      className="flex items-center justify-between gap-3 rounded-md p-2 hover-elevate"
                      data-testid={`row-browse-font-${f.name}`}
                    >
                      <div className="min-w-0">
                        <div style={{ fontFamily: buildFontStack(f.name, f.category), fontSize: '18px' }} className="truncate text-slate-900">
                          {f.name}
                        </div>
                        <div className="text-xs text-slate-500">{f.category}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={savingName === f.name}
                        onClick={() => addFont(f.name, f.category)}
                        data-testid={`button-add-browse-${f.name}`}
                      >
                        {savingName === f.name ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <><Plus className="w-4 h-4 mr-1" />Add</>
                        )}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </TabsContent>

            <TabsContent value="manual" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="manual-font-name">Google Font family name</Label>
                <Input
                  id="manual-font-name"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="e.g. Space Grotesk"
                  data-testid="input-manual-font-name"
                />
                <p className="text-xs text-slate-500">
                  Enter the exact family name as it appears on Google Fonts.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Fallback style</Label>
                <Select value={manualCategory} onValueChange={setManualCategory}>
                  <SelectTrigger data-testid="select-manual-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sans-serif">Sans-serif</SelectItem>
                    <SelectItem value="serif">Serif</SelectItem>
                    <SelectItem value="display">Display</SelectItem>
                    <SelectItem value="handwriting">Handwriting</SelectItem>
                    <SelectItem value="monospace">Monospace</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => addFont(manualName, manualCategory)}
                  disabled={!manualName.trim() || savingName === manualName.trim()}
                  data-testid="button-add-manual-font"
                >
                  {savingName === manualName.trim() ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Adding...</>
                  ) : (
                    <><Plus className="w-4 h-4 mr-2" />Add Font</>
                  )}
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This font will no longer be available for typography styles, navigation, or branding.
              If it is currently in use, removal will be blocked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving} data-testid="button-cancel-remove-font">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleRemove(); }}
              disabled={isRemoving}
              data-testid="button-confirm-remove-font"
            >
              {isRemoving ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Removing...</>
              ) : (
                'Remove'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function InstalledFontsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { toast } = useToast();
  const [accessChecked, setAccessChecked] = useState(false);

  // Typography styles state
  const [typographyStyles, setTypographyStyles] = useState([]);
  const [isLoadingStyles, setIsLoadingStyles] = useState(true);
  const [editingStyle, setEditingStyle] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createSeed, setCreateSeed] = useState(null);
  const [deleteConfirmStyle, setDeleteConfirmStyle] = useState(null);
  const [activeTab, setActiveTab] = useState('fonts');

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_InstalledFonts')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Load typography styles
  useEffect(() => {
    if (accessChecked) {
      loadTypographyStyles();
    }
  }, [accessChecked]);

  const loadTypographyStyles = async () => {
    setIsLoadingStyles(true);
    try {
      const styles = await base44.entities.TypographyStyle.list();
      setTypographyStyles(styles || []);
    } catch (error) {
      console.error('Failed to load typography styles:', error);
      toast({
        title: "Error",
        description: "Failed to load typography styles",
        variant: "destructive"
      });
    } finally {
      setIsLoadingStyles(false);
    }
  };

  const handleCreateStyle = async (styleData) => {
    try {
      // If setting as default, unset other defaults of same type
      if (styleData.is_default) {
        const existingDefault = typographyStyles.find(
          s => s.style_type === styleData.style_type && s.is_default
        );
        if (existingDefault) {
          await base44.entities.TypographyStyle.update(existingDefault.id, { is_default: false });
        }
      }

      await base44.entities.TypographyStyle.create(styleData);
      toast({
        title: "Success",
        description: "Typography style created successfully"
      });
      setIsCreating(false);
      setCreateSeed(null);
      loadTypographyStyles();
    } catch (error) {
      console.error('Failed to create style:', error);
      toast({
        title: "Error",
        description: "Failed to create typography style",
        variant: "destructive"
      });
    }
  };

  const handleDuplicateStyle = (style) => {
    // Build a fresh draft from the editable fields only (omit id / server-managed
    // fields) so the new style is created rather than overwriting the original.
    // Useful for making, e.g., dark and light variants of the same H1.
    const seed = {};
    Object.keys(defaultStyle).forEach((key) => {
      seed[key] = style[key] !== undefined && style[key] !== null ? style[key] : defaultStyle[key];
    });
    seed.name = `${style.name || 'Style'} (Copy)`;
    seed.is_default = false;
    setEditingStyle(null);
    setCreateSeed(seed);
    setIsCreating(true);
  };

  const handleUpdateStyle = async (styleData) => {
    try {
      // If setting as default, unset other defaults of same type
      if (styleData.is_default) {
        const existingDefault = typographyStyles.find(
          s => s.style_type === styleData.style_type && s.is_default && s.id !== styleData.id
        );
        if (existingDefault) {
          await base44.entities.TypographyStyle.update(existingDefault.id, { is_default: false });
        }
      }

      await base44.entities.TypographyStyle.update(styleData.id, styleData);
      toast({
        title: "Success",
        description: "Typography style updated successfully"
      });
      setEditingStyle(null);
      loadTypographyStyles();
    } catch (error) {
      console.error('Failed to update style:', error);
      toast({
        title: "Error",
        description: "Failed to update typography style",
        variant: "destructive"
      });
    }
  };

  const handleDeleteStyle = async () => {
    if (!deleteConfirmStyle) return;
    
    try {
      await base44.entities.TypographyStyle.delete(deleteConfirmStyle.id);
      toast({
        title: "Success",
        description: "Typography style deleted successfully"
      });
      setDeleteConfirmStyle(null);
      loadTypographyStyles();
    } catch (error) {
      console.error('Failed to delete style:', error);
      toast({
        title: "Error",
        description: "Failed to delete typography style",
        variant: "destructive"
      });
    }
  };

  const handleSetDefault = async (style) => {
    try {
      // Unset existing default of same type
      const existingDefault = typographyStyles.find(
        s => s.style_type === style.style_type && s.is_default
      );
      if (existingDefault) {
        await base44.entities.TypographyStyle.update(existingDefault.id, { is_default: false });
      }

      // Set new default
      await base44.entities.TypographyStyle.update(style.id, { is_default: true });
      toast({
        title: "Success",
        description: `${style.name} is now the default ${style.style_type.toUpperCase()} style`
      });
      loadTypographyStyles();
    } catch (error) {
      console.error('Failed to set default:', error);
      toast({
        title: "Error",
        description: "Failed to set default style",
        variant: "destructive"
      });
    }
  };

  // Group styles by type
  const stylesByType = typographyStyles.reduce((acc, style) => {
    if (!acc[style.style_type]) {
      acc[style.style_type] = [];
    }
    acc[style.style_type].push(style);
    return acc;
  }, {});

  if (!accessChecked) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Type className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">Fonts & Typography</h1>
          </div>
          <p className="text-slate-600">
            Manage installed fonts and typography styles for consistent heading and text styling
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList>
            <TabsTrigger value="fonts" data-testid="tab-fonts">Installed Fonts</TabsTrigger>
            <TabsTrigger value="typography" data-testid="tab-typography">Typography Styles</TabsTrigger>
          </TabsList>

          <TabsContent value="fonts" className="space-y-6">
            <InstalledFontsManager />
          </TabsContent>

          <TabsContent value="typography" className="space-y-6">
            {/* Create New Style Button */}
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Typography Styles</h2>
                <p className="text-sm text-slate-600">Define consistent heading and paragraph styles for use across the page builder</p>
              </div>
              <Button onClick={() => { setCreateSeed(null); setEditingStyle(null); setIsCreating(true); }} data-testid="button-create-style">
                <Plus className="w-4 h-4 mr-2" />
                New Style
              </Button>
            </div>

            {isLoadingStyles ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : typographyStyles.length === 0 ? (
              <Card className="border-dashed border-2 border-slate-300">
                <CardContent className="py-12 text-center">
                  <Type className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                  <h3 className="text-lg font-semibold text-slate-700 mb-2">No Typography Styles</h3>
                  <p className="text-slate-500 mb-4">Create your first typography style to get started</p>
                  <Button onClick={() => { setCreateSeed(null); setEditingStyle(null); setIsCreating(true); }} data-testid="button-create-first-style">
                    <Plus className="w-4 h-4 mr-2" />
                    Create Style
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-8">
                {STYLE_TYPES.map(type => {
                  const styles = stylesByType[type.value] || [];
                  if (styles.length === 0) return null;
                  
                  return (
                    <div key={type.value}>
                      <h3 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
                        {type.label}
                        <Badge variant="outline">{styles.length}</Badge>
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {styles.map(style => (
                          <TypographyStyleCard
                            key={style.id}
                            style={style}
                            onEdit={setEditingStyle}
                            onDuplicate={handleDuplicateStyle}
                            onDelete={setDeleteConfirmStyle}
                            onSetDefault={handleSetDefault}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Create/Edit Dialog */}
        <Dialog open={isCreating || !!editingStyle} onOpenChange={(open) => {
          if (!open) {
            setIsCreating(false);
            setEditingStyle(null);
            setCreateSeed(null);
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {isCreating ? 'Create Typography Style' : 'Edit Typography Style'}
              </DialogTitle>
            </DialogHeader>
            <TypographyStyleEditor
              style={editingStyle || createSeed || defaultStyle}
              onSave={isCreating ? handleCreateStyle : handleUpdateStyle}
              onCancel={() => {
                setIsCreating(false);
                setEditingStyle(null);
                setCreateSeed(null);
              }}
              isNew={isCreating}
            />
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={!!deleteConfirmStyle} onOpenChange={(open) => !open && setDeleteConfirmStyle(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Typography Style</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{deleteConfirmStyle?.name}"? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
              <AlertDialogAction 
                onClick={handleDeleteStyle}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-confirm-delete"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
