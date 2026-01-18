import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Save, Loader2, Eye, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const DEFAULT_PRIMARY_STYLE = {
  background: {
    type: 'gradient',
    solidColor: '#5C0085',
    gradientStart: '#5C0085',
    gradientEnd: '#BA0087',
    gradientDirection: 'to right'
  },
  border: {
    width: 0,
    color: '#000000',
    style: 'solid'
  },
  radius: 6,
  hover: {
    type: 'gradient',
    solidColor: '#BA0087',
    gradientStart: '#BA0087',
    gradientEnd: '#EE00C3',
    gradientDirection: 'to right'
  },
  textColor: '#FFFFFF',
  hoverTextColor: '#FFFFFF'
};

const DEFAULT_SECONDARY_STYLE = {
  background: {
    type: 'solid',
    solidColor: 'transparent',
    gradientStart: '#FFFFFF',
    gradientEnd: '#F0F0F0',
    gradientDirection: 'to right'
  },
  border: {
    width: 2,
    color: '#000000',
    style: 'solid'
  },
  radius: 6,
  hover: {
    type: 'gradient',
    solidColor: '#5C0085',
    gradientStart: '#5C0085',
    gradientEnd: '#BA0087',
    gradientDirection: 'to right'
  },
  textColor: '#000000',
  hoverTextColor: '#FFFFFF'
};

function ButtonStyleEditor({ style, onChange, title, description }) {
  const [isHovered, setIsHovered] = useState(false);
  const testIdPrefix = title.toLowerCase().replace(/\s+/g, '-');

  const updateStyle = (path, value) => {
    const newStyle = { ...style };
    const keys = path.split('.');
    let current = newStyle;
    for (let i = 0; i < keys.length - 1; i++) {
      current[keys[i]] = { ...current[keys[i]] };
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    onChange(newStyle);
  };

  const getBackgroundStyle = (bgConfig) => {
    if (bgConfig.type === 'solid') {
      return { backgroundColor: bgConfig.solidColor };
    }
    return {
      background: `linear-gradient(${bgConfig.gradientDirection}, ${bgConfig.gradientStart}, ${bgConfig.gradientEnd})`
    };
  };

  const previewStyle = {
    ...getBackgroundStyle(isHovered ? style.hover : style.background),
    border: `${style.border.width}px ${style.border.style} ${style.border.color}`,
    borderRadius: `${style.radius}px`,
    color: isHovered ? style.hoverTextColor : style.textColor,
    padding: '12px 24px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s ease'
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Live Preview */}
        <div className="p-6 bg-slate-100 rounded-lg flex items-center justify-center gap-4">
          <div className="text-center">
            <p className="text-xs text-slate-500 mb-2">Normal State</p>
            <button
              style={{
                ...getBackgroundStyle(style.background),
                border: `${style.border.width}px ${style.border.style} ${style.border.color}`,
                borderRadius: `${style.radius}px`,
                color: style.textColor,
                padding: '12px 24px',
                fontWeight: 500
              }}
              data-testid={`preview-${title.toLowerCase().replace(' ', '-')}-normal`}
            >
              Sample Button
            </button>
          </div>
          <div className="text-center">
            <p className="text-xs text-slate-500 mb-2">Hover State</p>
            <button
              style={{
                ...getBackgroundStyle(style.hover),
                border: `${style.border.width}px ${style.border.style} ${style.border.color}`,
                borderRadius: `${style.radius}px`,
                color: style.hoverTextColor,
                padding: '12px 24px',
                fontWeight: 500
              }}
              data-testid={`preview-${title.toLowerCase().replace(' ', '-')}-hover`}
            >
              Sample Button
            </button>
          </div>
          <div className="text-center">
            <p className="text-xs text-slate-500 mb-2">Interactive Preview</p>
            <button
              style={previewStyle}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              data-testid={`preview-${title.toLowerCase().replace(' ', '-')}-interactive`}
            >
              Hover Me
            </button>
          </div>
        </div>

        <Tabs defaultValue="background" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="background" data-testid={`tab-${testIdPrefix}-background`}>Background</TabsTrigger>
            <TabsTrigger value="border" data-testid={`tab-${testIdPrefix}-border`}>Border</TabsTrigger>
            <TabsTrigger value="radius" data-testid={`tab-${testIdPrefix}-radius`}>Radius</TabsTrigger>
            <TabsTrigger value="hover" data-testid={`tab-${testIdPrefix}-hover`}>Hover Effect</TabsTrigger>
          </TabsList>

          {/* Background Tab */}
          <TabsContent value="background" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Type:</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${title}-bg-type`}
                    checked={style.background.type === 'solid'}
                    onChange={() => updateStyle('background.type', 'solid')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-bg-solid`}
                  />
                  <span className="text-sm">Solid</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${title}-bg-type`}
                    checked={style.background.type === 'gradient'}
                    onChange={() => updateStyle('background.type', 'gradient')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-bg-gradient`}
                  />
                  <span className="text-sm">Gradient</span>
                </label>
              </div>
            </div>

            {style.background.type === 'solid' ? (
              <div className="flex items-center gap-4">
                <Label className="min-w-24">Color:</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={style.background.solidColor === 'transparent' ? '#ffffff' : style.background.solidColor}
                    onChange={(e) => updateStyle('background.solidColor', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer"
                    data-testid={`colorpicker-${testIdPrefix}-bg-solid`}
                  />
                  <Input
                    value={style.background.solidColor}
                    onChange={(e) => updateStyle('background.solidColor', e.target.value)}
                    className="w-32"
                    placeholder="#000000 or transparent"
                    data-testid={`input-${testIdPrefix}-bg-solid`}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">Start Color:</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={style.background.gradientStart}
                      onChange={(e) => updateStyle('background.gradientStart', e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer"
                      data-testid={`colorpicker-${testIdPrefix}-gradient-start`}
                    />
                    <Input
                      value={style.background.gradientStart}
                      onChange={(e) => updateStyle('background.gradientStart', e.target.value)}
                      className="w-32"
                      data-testid={`input-${testIdPrefix}-gradient-start`}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">End Color:</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={style.background.gradientEnd}
                      onChange={(e) => updateStyle('background.gradientEnd', e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer"
                      data-testid={`colorpicker-${testIdPrefix}-gradient-end`}
                    />
                    <Input
                      value={style.background.gradientEnd}
                      onChange={(e) => updateStyle('background.gradientEnd', e.target.value)}
                      className="w-32"
                      data-testid={`input-${testIdPrefix}-gradient-end`}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">Direction:</Label>
                  <select
                    value={style.background.gradientDirection}
                    onChange={(e) => updateStyle('background.gradientDirection', e.target.value)}
                    className="border rounded px-3 py-2 text-sm"
                    data-testid={`select-${testIdPrefix}-gradient-direction`}
                  >
                    <option value="to right">Left to Right</option>
                    <option value="to left">Right to Left</option>
                    <option value="to bottom">Top to Bottom</option>
                    <option value="to top">Bottom to Top</option>
                    <option value="to bottom right">Diagonal ↘</option>
                    <option value="to bottom left">Diagonal ↙</option>
                  </select>
                </div>
              </>
            )}

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Text Color:</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={style.textColor}
                  onChange={(e) => updateStyle('textColor', e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                  data-testid={`colorpicker-${testIdPrefix}-text-color`}
                />
                <Input
                  value={style.textColor}
                  onChange={(e) => updateStyle('textColor', e.target.value)}
                  className="w-32"
                  data-testid={`input-${testIdPrefix}-text-color`}
                />
              </div>
            </div>
          </TabsContent>

          {/* Border Tab */}
          <TabsContent value="border" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Width:</Label>
              <div className="flex items-center gap-4 flex-1">
                <Slider
                  value={[style.border.width]}
                  onValueChange={([val]) => updateStyle('border.width', val)}
                  max={10}
                  step={1}
                  className="flex-1"
                  data-testid={`slider-${testIdPrefix}-border-width`}
                />
                <span className="text-sm text-slate-500 w-12" data-testid={`text-${testIdPrefix}-border-width-value`}>{style.border.width}px</span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Color:</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={style.border.color}
                  onChange={(e) => updateStyle('border.color', e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                  data-testid={`colorpicker-${testIdPrefix}-border-color`}
                />
                <Input
                  value={style.border.color}
                  onChange={(e) => updateStyle('border.color', e.target.value)}
                  className="w-32"
                  data-testid={`input-${testIdPrefix}-border-color`}
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Style:</Label>
              <select
                value={style.border.style}
                onChange={(e) => updateStyle('border.style', e.target.value)}
                className="border rounded px-3 py-2 text-sm"
                data-testid={`select-${testIdPrefix}-border-style`}
              >
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
            </div>
          </TabsContent>

          {/* Radius Tab */}
          <TabsContent value="radius" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Radius:</Label>
              <div className="flex items-center gap-4 flex-1">
                <Slider
                  value={[style.radius]}
                  onValueChange={([val]) => updateStyle('radius', val)}
                  max={50}
                  step={1}
                  className="flex-1"
                  data-testid={`slider-${testIdPrefix}-radius`}
                />
                <span className="text-sm text-slate-500 w-12" data-testid={`text-${testIdPrefix}-radius-value`}>{style.radius}px</span>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Set to 50px for fully rounded pill-shaped buttons
            </p>
          </TabsContent>

          {/* Hover Tab */}
          <TabsContent value="hover" className="space-y-4 pt-4">
            <div className="flex items-center gap-4">
              <Label className="min-w-24">Type:</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${title}-hover-type`}
                    checked={style.hover.type === 'solid'}
                    onChange={() => updateStyle('hover.type', 'solid')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-hover-solid`}
                  />
                  <span className="text-sm">Solid</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name={`${title}-hover-type`}
                    checked={style.hover.type === 'gradient'}
                    onChange={() => updateStyle('hover.type', 'gradient')}
                    className="w-4 h-4"
                    data-testid={`radio-${testIdPrefix}-hover-gradient`}
                  />
                  <span className="text-sm">Gradient</span>
                </label>
              </div>
            </div>

            {style.hover.type === 'solid' ? (
              <div className="flex items-center gap-4">
                <Label className="min-w-24">Color:</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={style.hover.solidColor}
                    onChange={(e) => updateStyle('hover.solidColor', e.target.value)}
                    className="w-10 h-10 rounded cursor-pointer"
                    data-testid={`colorpicker-${testIdPrefix}-hover-solid`}
                  />
                  <Input
                    value={style.hover.solidColor}
                    onChange={(e) => updateStyle('hover.solidColor', e.target.value)}
                    className="w-32"
                    data-testid={`input-${testIdPrefix}-hover-solid`}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">Start Color:</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={style.hover.gradientStart}
                      onChange={(e) => updateStyle('hover.gradientStart', e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer"
                      data-testid={`colorpicker-${testIdPrefix}-hover-gradient-start`}
                    />
                    <Input
                      value={style.hover.gradientStart}
                      onChange={(e) => updateStyle('hover.gradientStart', e.target.value)}
                      className="w-32"
                      data-testid={`input-${testIdPrefix}-hover-gradient-start`}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">End Color:</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={style.hover.gradientEnd}
                      onChange={(e) => updateStyle('hover.gradientEnd', e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer"
                      data-testid={`colorpicker-${testIdPrefix}-hover-gradient-end`}
                    />
                    <Input
                      value={style.hover.gradientEnd}
                      onChange={(e) => updateStyle('hover.gradientEnd', e.target.value)}
                      className="w-32"
                      data-testid={`input-${testIdPrefix}-hover-gradient-end`}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <Label className="min-w-24">Direction:</Label>
                  <select
                    value={style.hover.gradientDirection}
                    onChange={(e) => updateStyle('hover.gradientDirection', e.target.value)}
                    className="border rounded px-3 py-2 text-sm"
                    data-testid={`select-${testIdPrefix}-hover-gradient-direction`}
                  >
                    <option value="to right">Left to Right</option>
                    <option value="to left">Right to Left</option>
                    <option value="to bottom">Top to Bottom</option>
                    <option value="to top">Bottom to Top</option>
                    <option value="to bottom right">Diagonal ↘</option>
                    <option value="to bottom left">Diagonal ↙</option>
                  </select>
                </div>
              </>
            )}

            <div className="flex items-center gap-4">
              <Label className="min-w-24">Hover Text:</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={style.hoverTextColor}
                  onChange={(e) => updateStyle('hoverTextColor', e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                  data-testid={`colorpicker-${testIdPrefix}-hover-text-color`}
                />
                <Input
                  value={style.hoverTextColor}
                  onChange={(e) => updateStyle('hoverTextColor', e.target.value)}
                  className="w-32"
                  data-testid={`input-${testIdPrefix}-hover-text-color`}
                />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export default function ButtonElementsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  const [primaryStyle, setPrimaryStyle] = useState(DEFAULT_PRIMARY_STYLE);
  const [secondaryStyle, setSecondaryStyle] = useState(DEFAULT_SECONDARY_STYLE);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.buttons')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Fetch existing button styles from tenant branding
  useEffect(() => {
    const fetchButtonStyles = async () => {
      try {
        const response = await fetch('/api/admin/tenant-branding', {
          credentials: 'include'
        });
        
        if (response.ok) {
          const data = await response.json();
          const buttonStyles = data.branding?.branding_config?.button_styles;
          
          if (buttonStyles) {
            if (buttonStyles.primary) {
              setPrimaryStyle({ ...DEFAULT_PRIMARY_STYLE, ...buttonStyles.primary });
            }
            if (buttonStyles.secondary) {
              setSecondaryStyle({ ...DEFAULT_SECONDARY_STYLE, ...buttonStyles.secondary });
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch button styles:', error);
      } finally {
        setLoading(false);
      }
    };

    if (accessChecked) {
      fetchButtonStyles();
    }
  }, [accessChecked]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // First fetch current branding to get existing branding_config
      const getResponse = await fetch('/api/admin/tenant-branding', {
        credentials: 'include'
      });
      
      if (!getResponse.ok) {
        throw new Error('Failed to fetch current branding');
      }
      
      const currentData = await getResponse.json();
      const currentBrandingConfig = currentData.branding?.branding_config || {};
      
      // Merge button_styles into existing branding_config
      const updatedBrandingConfig = {
        ...currentBrandingConfig,
        button_styles: {
          primary: primaryStyle,
          secondary: secondaryStyle
        }
      };
      
      // Save back to tenant branding
      const response = await fetch('/api/admin/tenant-branding', {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          branding_config: updatedBrandingConfig
        })
      });
      
      if (!response.ok) {
        throw new Error('Failed to save button styles');
      }
      
      toast.success('Button styles saved successfully!');
    } catch (error) {
      console.error('Save error:', error);
      toast.error('Failed to save button styles');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setPrimaryStyle(DEFAULT_PRIMARY_STYLE);
    setSecondaryStyle(DEFAULT_SECONDARY_STYLE);
    toast.info('Button styles reset to defaults');
  };

  if (!accessChecked || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Button Style Creator
            </h1>
            <p className="text-slate-600">
              Define primary and secondary button styles for your portal. These styles can be used when configuring navigation buttons and other frontend elements.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleReset}
              data-testid="button-reset-styles"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Reset
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              data-testid="button-save-styles"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Styles
            </Button>
          </div>
        </div>

        {/* Style Editors */}
        <div className="grid lg:grid-cols-2 gap-8">
          <ButtonStyleEditor
            style={primaryStyle}
            onChange={setPrimaryStyle}
            title="Primary Button"
            description="Main call-to-action buttons with bold, attention-grabbing styling"
          />
          
          <ButtonStyleEditor
            style={secondaryStyle}
            onChange={setSecondaryStyle}
            title="Secondary Button"
            description="Alternative buttons for less prominent actions, often with outline styling"
          />
        </div>

        {/* Usage Info */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Eye className="w-5 h-5" />
              How to Use These Styles
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-slate-600">
              Once saved, these button styles will be available throughout your portal configuration:
            </p>
            <ul className="mt-3 space-y-2 text-slate-600">
              <li className="flex items-start gap-2">
                <span className="text-primary font-bold">•</span>
                <span><strong>Navigation Management:</strong> When adding navigation items as buttons, select Primary or Secondary style</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary font-bold">•</span>
                <span><strong>Page Builder:</strong> Button blocks will use these predefined styles</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary font-bold">•</span>
                <span><strong>Content Cards:</strong> Action buttons on resource and article cards</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
