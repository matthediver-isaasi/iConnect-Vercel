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
  Trash2, 
  Save, 
  X,
  Star,
  Eye
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

const AVAILABLE_FONTS = [
  { value: 'Poppins, sans-serif', label: 'Poppins' },
  { value: "'Degular Medium', 'Poppins', sans-serif", label: 'Degular Medium' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: "'Times New Roman', serif", label: 'Times New Roman' }
];

const defaultStyle = {
  name: '',
  style_type: 'h1',
  font_family: 'Poppins, sans-serif',
  font_size: 48,
  font_size_mobile: null,
  font_weight: 600,
  line_height: 1.2,
  letter_spacing: 0,
  text_transform: 'none',
  color: '',
  margin_bottom: 24,
  is_default: false,
  is_active: true
};

function TypographyStyleEditor({ style, onSave, onCancel, isNew = false }) {
  const [formData, setFormData] = useState(style || defaultStyle);
  const [isSaving, setIsSaving] = useState(false);

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
        {formData.font_size_mobile && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <span className="text-xs text-slate-500 block mb-2">Mobile Preview ({formData.font_size_mobile}px)</span>
            <div style={{ ...previewStyle, fontSize: `${formData.font_size_mobile}px` }}>
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
              {AVAILABLE_FONTS.map(font => (
                <SelectItem key={font.value} value={font.value}>
                  {font.label}
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

function TypographyStyleCard({ style, onEdit, onDelete, onSetDefault }) {
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
          <div>Line Height: {style.line_height}</div>
          <div>Letter Spacing: {style.letter_spacing}px</div>
          {style.color && <div>Color: {style.color}</div>}
          <div>Margin: {style.margin_bottom}px</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function InstalledFontsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const { toast } = useToast();
  const [accessChecked, setAccessChecked] = useState(false);
  const [fontLoadStatus, setFontLoadStatus] = useState({});
  const [debugInfo, setDebugInfo] = useState({});
  
  // Typography styles state
  const [typographyStyles, setTypographyStyles] = useState([]);
  const [isLoadingStyles, setIsLoadingStyles] = useState(true);
  const [editingStyle, setEditingStyle] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
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

  useEffect(() => {
    if ('fonts' in document) {
      document.fonts.load('500 16px "Degular Medium"').then(() => {
        const loaded = document.fonts.check('500 16px "Degular Medium"');
        setFontLoadStatus({ degular: loaded });
      }).catch((err) => {
        setFontLoadStatus({ degular: false, error: err.message });
      });

      document.fonts.addEventListener('loadingdone', (event) => {
        const fontFaces = Array.from(document.fonts.values());
        const degularFont = fontFaces.find(f => f.family === 'Degular Medium');
        setDebugInfo({
          totalFonts: fontFaces.length,
          degularFound: !!degularFont,
          degularStatus: degularFont?.status,
          allFontFamilies: fontFaces.map(f => f.family)
        });
      });
    }

    fetch('https://teeone.pythonanywhere.com/font-assets/Degular-Medium.woff', { mode: 'cors' })
      .then(response => {
        setDebugInfo(prev => ({
          ...prev,
          fetchStatus: response.ok ? 'success' : 'failed',
          fetchStatusCode: response.status,
          corsHeaders: response.headers.get('Access-Control-Allow-Origin')
        }));
      })
      .catch(err => {
        setDebugInfo(prev => ({
          ...prev,
          fetchStatus: 'error',
          fetchError: err.message
        }));
      });
  }, []);

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
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const fonts = [
    {
      name: "Poppins",
      family: "Poppins, sans-serif",
      source: "Google Fonts",
      weights: ["400 (Regular)", "600 (Semibold)"],
      usage: "Body text, general UI elements"
    },
    {
      name: "Degular Medium",
      family: "'Degular Medium', 'Poppins', sans-serif",
      source: "https://teeone.pythonanywhere.com/font-assets",
      weights: ["500 (Medium)"],
      usage: "H1 headers"
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
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
            {/* Debug Information Card */}
            <Card className="border-amber-200 bg-amber-50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <AlertCircle className="w-5 h-5 text-amber-600" />
                  Font Loading Debug Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <h4 className="font-semibold text-sm mb-2">Font API Check</h4>
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center gap-2">
                        {fontLoadStatus.degular ? (
                          <CheckCircle className="w-4 h-4 text-green-600" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-600" />
                        )}
                        <span>Degular Medium: </span>
                        <Badge variant={fontLoadStatus.degular ? "default" : "destructive"}>
                          {fontLoadStatus.degular ? 'Loaded' : 'Not Loaded'}
                        </Badge>
                      </div>
                      {fontLoadStatus.error && (
                        <div className="text-xs text-red-600 mt-1">Error: {fontLoadStatus.error}</div>
                      )}
                    </div>
                  </div>
                  
                  <div>
                    <h4 className="font-semibold text-sm mb-2">Network Fetch Test</h4>
                    <div className="space-y-1 text-sm">
                      <div>Status: <Badge variant={debugInfo.fetchStatus === 'success' ? 'default' : 'destructive'}>{debugInfo.fetchStatus || 'Testing...'}</Badge></div>
                      {debugInfo.fetchStatusCode && <div>HTTP Code: {debugInfo.fetchStatusCode}</div>}
                      {debugInfo.corsHeaders && <div>CORS Header: {debugInfo.corsHeaders}</div>}
                      {debugInfo.fetchError && <div className="text-xs text-red-600">Error: {debugInfo.fetchError}</div>}
                    </div>
                  </div>
                </div>

                {debugInfo.allFontFamilies && (
                  <div className="pt-3 border-t border-amber-200">
                    <h4 className="font-semibold text-sm mb-2">All Loaded Font Families ({debugInfo.totalFonts}):</h4>
                    <div className="flex flex-wrap gap-1">
                      {debugInfo.allFontFamilies.map((family, i) => (
                        <Badge key={i} variant="outline" className="text-xs">
                          {family}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-3 border-t border-amber-200">
                  <h4 className="font-semibold text-sm mb-2">Browser Console Check:</h4>
                  <p className="text-xs text-slate-600">
                    Open your browser's DevTools (F12) → Network tab → Filter by "font" to see if the font file is loading and check for CORS errors.
                  </p>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              {fonts.map((font, index) => (
                <Card key={index} className="border-slate-200">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span style={{ fontFamily: font.family }}>{font.name}</span>
                      <span className="text-sm font-normal text-slate-500">{font.source}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <h4 className="text-sm font-semibold text-slate-700 mb-2">Font Details</h4>
                        <div className="space-y-1 text-sm">
                          <div>
                            <span className="text-slate-500">Family: </span>
                            <code className="text-xs bg-slate-100 px-2 py-1 rounded">{font.family}</code>
                          </div>
                          <div>
                            <span className="text-slate-500">Weights: </span>
                            <span className="text-slate-700">{font.weights.join(", ")}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">Usage: </span>
                            <span className="text-slate-700">{font.usage}</span>
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        <h4 className="text-sm font-semibold text-slate-700 mb-2">Preview</h4>
                        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
                          <p style={{ fontFamily: font.family, fontSize: '24px' }}>
                            The quick brown fox jumps over the lazy dog
                          </p>
                          <p style={{ fontFamily: font.family, fontSize: '16px' }}>
                            ABCDEFGHIJKLMNOPQRSTUVWXYZ
                          </p>
                          <p style={{ fontFamily: font.family, fontSize: '16px' }}>
                            abcdefghijklmnopqrstuvwxyz
                          </p>
                          <p style={{ fontFamily: font.family, fontSize: '16px' }}>
                            0123456789
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="pt-4 border-t border-slate-200">
                      <h4 className="text-sm font-semibold text-slate-700 mb-2">Size Examples</h4>
                      <div className="space-y-3">
                        <p style={{ fontFamily: font.family, fontSize: '32px' }}>
                          32px - Large Heading
                        </p>
                        <p style={{ fontFamily: font.family, fontSize: '24px' }}>
                          24px - Medium Heading
                        </p>
                        <p style={{ fontFamily: font.family, fontSize: '16px' }}>
                          16px - Body Text
                        </p>
                        <p style={{ fontFamily: font.family, fontSize: '14px' }}>
                          14px - Small Text
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="typography" className="space-y-6">
            {/* Create New Style Button */}
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Typography Styles</h2>
                <p className="text-sm text-slate-600">Define consistent heading and paragraph styles for use across the page builder</p>
              </div>
              <Button onClick={() => setIsCreating(true)} data-testid="button-create-style">
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
                  <Button onClick={() => setIsCreating(true)} data-testid="button-create-first-style">
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
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {isCreating ? 'Create Typography Style' : 'Edit Typography Style'}
              </DialogTitle>
            </DialogHeader>
            <TypographyStyleEditor
              style={editingStyle || defaultStyle}
              onSave={isCreating ? handleCreateStyle : handleUpdateStyle}
              onCancel={() => {
                setIsCreating(false);
                setEditingStyle(null);
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
