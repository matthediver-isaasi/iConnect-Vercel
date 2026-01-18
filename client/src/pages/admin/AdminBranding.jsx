import { useState, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ArrowLeft, 
  Loader2,
  Save,
  Upload,
  Image,
  Trash2,
  Palette,
  Type,
  LayoutTemplate,
  Plus,
  X,
  Shield
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";

export default function AdminBranding() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingHeaderLogo, setUploadingHeaderLogo] = useState(false);
  const [tenantUser, setTenantUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  
  const logoInputRef = useRef(null);
  const headerLogoInputRef = useRef(null);
  
  const DEFAULT_GRADIENT_STOPS = [
    { color: '#FFFFFF', position: 0 },
    { color: '#FFFFFF', position: 30 },
    { color: '#5C0085', position: 50 },
    { color: '#BA0087', position: 65 },
    { color: '#EE00C3', position: 80 },
    { color: '#FF4229', position: 90 },
    { color: '#FFB000', position: 100 }
  ];

  const [formData, setFormData] = useState({
    primary_color: '#5C0085',
    secondary_color: '#BA0087',
    tagline: '',
    logo_url: '',
    header_logo_url: '',
    header_config: {
      logoHeight: '',
      logoWidth: '',
      logoBackground: '',
      logoBorderRadiusTopLeft: '',
      logoBorderRadiusTopRight: '',
      logoBorderRadiusBottomLeft: '',
      logoBorderRadiusBottomRight: '',
      logoBorderWidth: '',
      logoBorderColor: '',
      logoShadow: 'none',
      logoPadding: '',
      logoMarginTop: '',
      logoMarginLeft: '',
      gradientStops: DEFAULT_GRADIENT_STOPS
    },
    footer_config: {
      columns: 4,
      ctaText: 'Become a member today',
      ctaButtonText: 'Join Us',
      ctaLink: 'Membership',
      newsletterText: 'Sign up to our newsletter',
      gradientColors: ['#5C0085', '#BA0087', '#EE00C3', '#FF4229', '#FFB000'],
      backgroundColor: '#000000',
      address: {
        name: '',
        lines: []
      },
      contact: {
        phone: '',
        email: ''
      },
      legalText: '',
      termsAndConditionsUrl: '',
      privacyPolicyUrl: ''
    },
    branding_config: {
      footerLogoHeight: '',
      footerLogoWidth: '',
      headerSocialIconColor: '#5C0085',
      footerSocialIconColor: '#FFFFFF'
    },
    platform_branding: {
      showPlatformBranding: true,
      backgroundColor: '#000000',
      textColor: '#64748b'
    }
  });

  const [newAddressLine, setNewAddressLine] = useState('');
  const [newGradientColor, setNewGradientColor] = useState('#000000');
  const [newHeaderGradientColor, setNewHeaderGradientColor] = useState('#000000');
  const [newHeaderGradientPosition, setNewHeaderGradientPosition] = useState(100);
  const [platformDefaults, setPlatformDefaults] = useState({
    platformBrandingText: 'Powered by isaasi',
    platformBrandingUrl: 'https://isaasi.co.uk'
  });

  const convertLegacyGradientColors = (colors) => {
    if (!colors || colors.length === 0) return DEFAULT_GRADIENT_STOPS;
    if (colors.length === 1) {
      return [
        { color: '#FFFFFF', position: 0 },
        { color: '#FFFFFF', position: 30 },
        { color: colors[0], position: 100 }
      ];
    }
    const colorStops = colors.map((color, index) => ({
      color,
      position: Math.round((index / (colors.length - 1)) * 70) + 30
    }));
    return [
      { color: '#FFFFFF', position: 0 },
      { color: '#FFFFFF', position: 30 },
      ...colorStops
    ];
  };

  const getGradientStops = (headerConfig) => {
    if (headerConfig?.gradientStops && headerConfig.gradientStops.length > 0) {
      return headerConfig.gradientStops;
    }
    if (headerConfig?.gradientColors && headerConfig.gradientColors.length > 0) {
      return convertLegacyGradientColors(headerConfig.gradientColors);
    }
    return DEFAULT_GRADIENT_STOPS;
  };

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            setTenantUser(data.tenantUser);
            setTenant(data.tenant);
            
            const t = data.tenant;
            setFormData({
              primary_color: t?.primary_color || '#5C0085',
              secondary_color: t?.secondary_color || '#BA0087',
              tagline: t?.tagline || '',
              logo_url: t?.logo_url || '',
              header_logo_url: t?.header_logo_url || '',
              header_config: {
                logoHeight: t?.header_config?.logoHeight || '',
                logoWidth: t?.header_config?.logoWidth || '',
                logoBackground: t?.header_config?.logoBackground || '',
                logoBorderRadiusTopLeft: t?.header_config?.logoBorderRadiusTopLeft || t?.header_config?.logoBorderRadius || '',
                logoBorderRadiusTopRight: t?.header_config?.logoBorderRadiusTopRight || t?.header_config?.logoBorderRadius || '',
                logoBorderRadiusBottomLeft: t?.header_config?.logoBorderRadiusBottomLeft || t?.header_config?.logoBorderRadius || '',
                logoBorderRadiusBottomRight: t?.header_config?.logoBorderRadiusBottomRight || t?.header_config?.logoBorderRadius || '',
                logoBorderWidth: t?.header_config?.logoBorderWidth || '',
                logoBorderColor: t?.header_config?.logoBorderColor || '',
                logoShadow: t?.header_config?.logoShadow || 'none',
                logoPadding: t?.header_config?.logoPadding || '',
                logoMarginTop: t?.header_config?.logoMarginTop || '',
                logoMarginLeft: t?.header_config?.logoMarginLeft || '',
                gradientStops: getGradientStops(t?.header_config)
              },
              footer_config: {
                columns: t?.footer_config?.columns || 4,
                ctaText: t?.footer_config?.ctaText || 'Become a member today',
                ctaButtonText: t?.footer_config?.ctaButtonText || 'Join Us',
                ctaLink: t?.footer_config?.ctaLink || 'Membership',
                newsletterText: t?.footer_config?.newsletterText || 'Sign up to our newsletter',
                gradientColors: t?.footer_config?.gradientColors || ['#5C0085', '#BA0087', '#EE00C3', '#FF4229', '#FFB000'],
                backgroundColor: t?.footer_config?.backgroundColor || '#000000',
                address: {
                  name: t?.footer_config?.address?.name || '',
                  lines: t?.footer_config?.address?.lines || []
                },
                contact: {
                  phone: t?.footer_config?.contact?.phone || '',
                  email: t?.footer_config?.contact?.email || ''
                },
                legalText: t?.footer_config?.legalText || '',
                termsAndConditionsUrl: t?.footer_config?.termsAndConditionsUrl || '',
                privacyPolicyUrl: t?.footer_config?.privacyPolicyUrl || ''
              },
              branding_config: {
                footerLogoHeight: t?.branding_config?.footerLogoHeight || '',
                footerLogoWidth: t?.branding_config?.footerLogoWidth || '',
                headerSocialIconColor: t?.branding_config?.headerSocialIconColor || '#5C0085',
                footerSocialIconColor: t?.branding_config?.footerSocialIconColor || '#FFFFFF'
              },
              platform_branding: {
                showPlatformBranding: t?.platform_branding?.showPlatformBranding !== false,
                backgroundColor: t?.platform_branding?.backgroundColor || '#000000',
                textColor: t?.platform_branding?.textColor || '#64748b'
              }
            });
            
            // Also fetch platform defaults
            try {
              const defaultsRes = await fetch('/api/public/platform-defaults');
              if (defaultsRes.ok) {
                const defaultsData = await defaultsRes.json();
                setPlatformDefaults(prev => ({
                  ...prev,
                  ...defaultsData
                }));
              }
            } catch (err) {
              console.error('Failed to fetch platform defaults:', err);
            }
          } else {
            navigate('/admin/login');
          }
        } else {
          navigate('/admin/login');
        }
      } catch (err) {
        navigate('/admin/login');
      } finally {
        setLoading(false);
      }
    };
    
    checkAuth();
  }, [navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);

    try {
      const response = await fetch('/api/admin/tenant-branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        toast({
          title: "Branding saved",
          description: "Your branding settings have been updated."
        });
      } else {
        throw new Error('Failed to save');
      }
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to save branding settings.",
        variant: "destructive"
      });
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setUploadingLogo(true);
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');
    
    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });
      
      if (response.ok) {
        const data = await response.json();
        const newLogoUrl = data.file_url;
        setFormData(prev => ({ ...prev, logo_url: newLogoUrl }));
        
        // Auto-save the logo to database
        const saveResponse = await fetch('/api/admin/tenant-branding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ logo_url: newLogoUrl })
        });
        
        if (saveResponse.ok) {
          toast({
            title: "Logo saved",
            description: "Your logo has been uploaded and saved."
          });
        } else {
          toast({
            title: "Logo uploaded",
            description: "Logo uploaded but not saved. Click Save to persist changes.",
            variant: "warning"
          });
        }
      } else {
        throw new Error('Upload failed');
      }
    } catch (err) {
      toast({
        title: "Upload failed",
        description: "Could not upload logo. Please try again.",
        variant: "destructive"
      });
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleHeaderLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setUploadingHeaderLogo(true);
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'branding');
    
    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });
      
      if (response.ok) {
        const data = await response.json();
        const newLogoUrl = data.file_url;
        setFormData(prev => ({ ...prev, header_logo_url: newLogoUrl }));
        
        // Auto-save the header logo to database
        const saveResponse = await fetch('/api/admin/tenant-branding', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ header_logo_url: newLogoUrl })
        });
        
        if (saveResponse.ok) {
          toast({
            title: "Header logo saved",
            description: "Your header logo has been uploaded and saved."
          });
        } else {
          toast({
            title: "Logo uploaded",
            description: "Logo uploaded but not saved. Click Save to persist changes.",
            variant: "warning"
          });
        }
      } else {
        throw new Error('Upload failed');
      }
    } catch (err) {
      toast({
        title: "Upload failed",
        description: "Could not upload header logo. Please try again.",
        variant: "destructive"
      });
    } finally {
      setUploadingHeaderLogo(false);
    }
  };

  const addAddressLine = () => {
    if (newAddressLine.trim()) {
      setFormData(prev => ({
        ...prev,
        footer_config: {
          ...prev.footer_config,
          address: {
            ...prev.footer_config.address,
            lines: [...(prev.footer_config.address.lines || []), newAddressLine.trim()]
          }
        }
      }));
      setNewAddressLine('');
    }
  };

  const removeAddressLine = (index) => {
    setFormData(prev => ({
      ...prev,
      footer_config: {
        ...prev.footer_config,
        address: {
          ...prev.footer_config.address,
          lines: prev.footer_config.address.lines.filter((_, i) => i !== index)
        }
      }
    }));
  };

  const addGradientColor = () => {
    if (newGradientColor) {
      setFormData(prev => ({
        ...prev,
        footer_config: {
          ...prev.footer_config,
          gradientColors: [...(prev.footer_config.gradientColors || []), newGradientColor]
        }
      }));
      setNewGradientColor('#000000');
    }
  };

  const removeGradientColor = (index) => {
    setFormData(prev => ({
      ...prev,
      footer_config: {
        ...prev.footer_config,
        gradientColors: prev.footer_config.gradientColors.filter((_, i) => i !== index)
      }
    }));
  };

  const updateGradientColor = (index, color) => {
    setFormData(prev => ({
      ...prev,
      footer_config: {
        ...prev.footer_config,
        gradientColors: prev.footer_config.gradientColors.map((c, i) => i === index ? color : c)
      }
    }));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link to="/admin/dashboard">
              <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                <Palette className="w-6 h-6 text-purple-400" />
                Branding Settings
              </h1>
              <p className="text-slate-400 text-sm mt-1">
                Customize colors, logo, and public page styling
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Palette className="w-5 h-5" />
                Colors
              </CardTitle>
              <CardDescription className="text-slate-400">
                Set your brand colors for the public website
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="primary_color" className="text-slate-200">Primary Color</Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      id="primary_color"
                      value={formData.primary_color}
                      onChange={(e) => setFormData({ ...formData, primary_color: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                      data-testid="input-primary-color"
                    />
                    <Input
                      value={formData.primary_color}
                      onChange={(e) => setFormData({ ...formData, primary_color: e.target.value })}
                      className="bg-slate-900/50 border-slate-600 text-white flex-1"
                      placeholder="#5C0085"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secondary_color" className="text-slate-200">Secondary Color</Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      id="secondary_color"
                      value={formData.secondary_color}
                      onChange={(e) => setFormData({ ...formData, secondary_color: e.target.value })}
                      className="w-12 h-10 rounded cursor-pointer"
                      data-testid="input-secondary-color"
                    />
                    <Input
                      value={formData.secondary_color}
                      onChange={(e) => setFormData({ ...formData, secondary_color: e.target.value })}
                      className="bg-slate-900/50 border-slate-600 text-white flex-1"
                      placeholder="#BA0087"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Image className="w-5 h-5" />
                Logo
              </CardTitle>
              <CardDescription className="text-slate-400">
                Upload your organization's logo for the public website footer
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 bg-slate-900/50">
                {formData.logo_url ? (
                  <div className="flex items-center gap-4">
                    <div className="bg-slate-700 rounded-lg p-4">
                      <img 
                        src={formData.logo_url} 
                        alt="Logo" 
                        className="h-16 w-auto object-contain"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => logoInputRef.current?.click()}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-change-logo"
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        Change
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setFormData({ ...formData, logo_url: '' })}
                        data-testid="button-remove-logo"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <Image className="w-12 h-12 mx-auto text-slate-500 mb-3" />
                    <p className="text-slate-400 mb-3">No logo uploaded</p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => logoInputRef.current?.click()}
                      disabled={uploadingLogo}
                      className="border-slate-600 text-slate-300"
                      data-testid="button-upload-logo"
                    >
                      {uploadingLogo ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4 mr-2" />
                      )}
                      Upload Logo
                    </Button>
                  </div>
                )}
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleLogoUpload}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="footer_logo_height" className="text-slate-200">Max Height (px)</Label>
                  <Input
                    id="footer_logo_height"
                    type="number"
                    value={formData.branding_config?.footerLogoHeight || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      branding_config: { 
                        ...formData.branding_config, 
                        footerLogoHeight: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="96"
                    data-testid="input-footer-logo-height"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="footer_logo_width" className="text-slate-200">Max Width (px)</Label>
                  <Input
                    id="footer_logo_width"
                    type="number"
                    value={formData.branding_config?.footerLogoWidth || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      branding_config: { 
                        ...formData.branding_config, 
                        footerLogoWidth: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="auto"
                    data-testid="input-footer-logo-width"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-2">Leave empty for default sizing. The logo will scale proportionally within these constraints.</p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Image className="w-5 h-5" />
                Header Logo
              </CardTitle>
              <CardDescription className="text-slate-400">
                Upload a separate logo for the navigation header (typically lighter for dark backgrounds)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 bg-slate-900/50">
                {formData.header_logo_url ? (
                  <div className="flex items-center gap-4">
                    <div className="bg-slate-700 rounded-lg p-4">
                      <img 
                        src={formData.header_logo_url} 
                        alt="Header Logo" 
                        className="h-16 w-auto object-contain"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => headerLogoInputRef.current?.click()}
                        className="border-slate-600 text-slate-300"
                        data-testid="button-change-header-logo"
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        Change
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setFormData({ ...formData, header_logo_url: '' })}
                        data-testid="button-remove-header-logo"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <Image className="w-12 h-12 mx-auto text-slate-500 mb-3" />
                    <p className="text-slate-400 mb-3">No header logo uploaded</p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => headerLogoInputRef.current?.click()}
                      disabled={uploadingHeaderLogo}
                      className="border-slate-600 text-slate-300"
                      data-testid="button-upload-header-logo"
                    >
                      {uploadingHeaderLogo ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4 mr-2" />
                      )}
                      Upload Header Logo
                    </Button>
                  </div>
                )}
                <input
                  ref={headerLogoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleHeaderLogoUpload}
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="header_logo_height" className="text-slate-200">Max Height (px)</Label>
                  <Input
                    id="header_logo_height"
                    type="number"
                    value={formData.header_config?.logoHeight || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      header_config: { 
                        ...formData.header_config, 
                        logoHeight: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="158"
                    data-testid="input-header-logo-height"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="header_logo_width" className="text-slate-200">Max Width (px)</Label>
                  <Input
                    id="header_logo_width"
                    type="number"
                    value={formData.header_config?.logoWidth || ''}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      header_config: { 
                        ...formData.header_config, 
                        logoWidth: e.target.value 
                      } 
                    })}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="auto"
                    data-testid="input-header-logo-width"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-2">Leave empty for default sizing. The logo will scale proportionally within these constraints.</p>

              <div className="border-t border-slate-700 pt-4 mt-4">
                <h4 className="text-white font-medium mb-4">Logo Container Styling</h4>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_background" className="text-slate-200">Background Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="header_logo_background_picker"
                        value={formData.header_config?.logoBackground || '#ffffff'}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBackground: e.target.value 
                          } 
                        })}
                        className="w-12 h-10 rounded cursor-pointer"
                        data-testid="input-header-logo-background-picker"
                      />
                      <Input
                        id="header_logo_background"
                        value={formData.header_config?.logoBackground || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBackground: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        placeholder="transparent"
                        data-testid="input-header-logo-background"
                      />
                    </div>
                    <p className="text-xs text-slate-500">Leave empty for transparent background</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_padding" className="text-slate-200">Padding (px)</Label>
                    <Input
                      id="header_logo_padding"
                      type="number"
                      value={formData.header_config?.logoPadding || ''}
                      onChange={(e) => setFormData({ 
                        ...formData, 
                        header_config: { 
                          ...formData.header_config, 
                          logoPadding: e.target.value 
                        } 
                      })}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="0"
                      data-testid="input-header-logo-padding"
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <Label className="text-slate-200 mb-2 block">Border Radius (px per corner)</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_tl" className="text-slate-400 text-xs">Top Left</Label>
                      <Input
                        id="header_logo_border_radius_tl"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusTopLeft || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusTopLeft: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-tl"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_tr" className="text-slate-400 text-xs">Top Right</Label>
                      <Input
                        id="header_logo_border_radius_tr"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusTopRight || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusTopRight: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-tr"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_bl" className="text-slate-400 text-xs">Bottom Left</Label>
                      <Input
                        id="header_logo_border_radius_bl"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusBottomLeft || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusBottomLeft: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-bl"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="header_logo_border_radius_br" className="text-slate-400 text-xs">Bottom Right</Label>
                      <Input
                        id="header_logo_border_radius_br"
                        type="number"
                        value={formData.header_config?.logoBorderRadiusBottomRight || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderRadiusBottomRight: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-border-radius-br"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_shadow" className="text-slate-200">Shadow Effect</Label>
                    <Select
                      value={formData.header_config?.logoShadow || 'none'}
                      onValueChange={(value) => setFormData({ 
                        ...formData, 
                        header_config: { 
                          ...formData.header_config, 
                          logoShadow: value 
                        } 
                      })}
                    >
                      <SelectTrigger className="bg-slate-900/50 border-slate-600 text-white" data-testid="select-header-logo-shadow">
                        <SelectValue placeholder="Select shadow" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="sm">Small</SelectItem>
                        <SelectItem value="md">Medium</SelectItem>
                        <SelectItem value="lg">Large</SelectItem>
                        <SelectItem value="xl">Extra Large</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="border-t border-slate-700 pt-4 mt-4">
                  <h4 className="text-white font-medium mb-4">Logo Position</h4>
                  <p className="text-xs text-slate-500 mb-4">Adjust the logo position from the top-left corner. By default the logo sits flush with the top of the page.</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="header_logo_margin_top" className="text-slate-200">Margin Top (px)</Label>
                      <Input
                        id="header_logo_margin_top"
                        type="number"
                        value={formData.header_config?.logoMarginTop || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoMarginTop: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-margin-top"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="header_logo_margin_left" className="text-slate-200">Margin Left (px)</Label>
                      <Input
                        id="header_logo_margin_left"
                        type="number"
                        value={formData.header_config?.logoMarginLeft || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoMarginLeft: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white"
                        placeholder="0"
                        data-testid="input-header-logo-margin-left"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_border_width" className="text-slate-200">Border Width (px)</Label>
                    <Input
                      id="header_logo_border_width"
                      type="number"
                      value={formData.header_config?.logoBorderWidth || ''}
                      onChange={(e) => setFormData({ 
                        ...formData, 
                        header_config: { 
                          ...formData.header_config, 
                          logoBorderWidth: e.target.value 
                        } 
                      })}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="0"
                      data-testid="input-header-logo-border-width"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="header_logo_border_color" className="text-slate-200">Border Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        id="header_logo_border_color_picker"
                        value={formData.header_config?.logoBorderColor || '#000000'}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderColor: e.target.value 
                          } 
                        })}
                        className="w-12 h-10 rounded cursor-pointer"
                        data-testid="input-header-logo-border-color-picker"
                      />
                      <Input
                        id="header_logo_border_color"
                        value={formData.header_config?.logoBorderColor || ''}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          header_config: { 
                            ...formData.header_config, 
                            logoBorderColor: e.target.value 
                          } 
                        })}
                        className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        placeholder="#000000"
                        data-testid="input-header-logo-border-color"
                      />
                    </div>
                  </div>
                </div>

                {(formData.header_config?.logoBackground || formData.header_config?.logoBorderRadiusTopLeft || formData.header_config?.logoBorderRadiusTopRight || formData.header_config?.logoBorderRadiusBottomLeft || formData.header_config?.logoBorderRadiusBottomRight || formData.header_config?.logoBorderWidth || formData.header_config?.logoShadow !== 'none' || formData.header_config?.logoPadding || formData.header_config?.logoMarginTop || formData.header_config?.logoMarginLeft) && formData.header_logo_url && (
                  <div className="mt-4 p-4 bg-slate-900/50 rounded-lg">
                    <Label className="text-slate-200 mb-2 block">Preview</Label>
                    <div className="flex justify-center">
                      <div
                        style={{
                          backgroundColor: formData.header_config?.logoBackground || 'transparent',
                          borderTopLeftRadius: formData.header_config?.logoBorderRadiusTopLeft ? `${formData.header_config.logoBorderRadiusTopLeft}px` : '0',
                          borderTopRightRadius: formData.header_config?.logoBorderRadiusTopRight ? `${formData.header_config.logoBorderRadiusTopRight}px` : '0',
                          borderBottomLeftRadius: formData.header_config?.logoBorderRadiusBottomLeft ? `${formData.header_config.logoBorderRadiusBottomLeft}px` : '0',
                          borderBottomRightRadius: formData.header_config?.logoBorderRadiusBottomRight ? `${formData.header_config.logoBorderRadiusBottomRight}px` : '0',
                          borderWidth: formData.header_config?.logoBorderWidth ? `${formData.header_config.logoBorderWidth}px` : '0',
                          borderStyle: formData.header_config?.logoBorderWidth ? 'solid' : 'none',
                          borderColor: formData.header_config?.logoBorderColor || '#000000',
                          padding: formData.header_config?.logoPadding ? `${formData.header_config.logoPadding}px` : '0',
                          marginTop: formData.header_config?.logoMarginTop ? `${formData.header_config.logoMarginTop}px` : '0',
                          marginLeft: formData.header_config?.logoMarginLeft ? `${formData.header_config.logoMarginLeft}px` : '0',
                          boxShadow: formData.header_config?.logoShadow === 'sm' ? '0 1px 2px 0 rgb(0 0 0 / 0.05)' :
                                     formData.header_config?.logoShadow === 'md' ? '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' :
                                     formData.header_config?.logoShadow === 'lg' ? '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)' :
                                     formData.header_config?.logoShadow === 'xl' ? '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)' : 'none'
                        }}
                      >
                        <img 
                          src={formData.header_logo_url} 
                          alt="Logo Preview" 
                          style={{
                            height: formData.header_config?.logoHeight ? `${Math.min(parseInt(formData.header_config.logoHeight), 80)}px` : '80px',
                            width: 'auto',
                            objectFit: 'contain'
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Palette className="w-5 h-5" />
                Header Gradient Colors
              </CardTitle>
              <CardDescription className="text-slate-400">
                Customize the gradient colors and their positions in the navigation header bar
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div 
                className="h-10 rounded-lg border border-slate-600"
                style={{
                  background: `linear-gradient(to right, ${(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS)
                    .slice()
                    .sort((a, b) => a.position - b.position)
                    .map(stop => `${stop.color} ${stop.position}%`)
                    .join(', ')})`
                }}
              />
              <div className="space-y-3">
                {(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS).map((stop, index) => (
                  <div key={index} className="flex items-center gap-3 bg-slate-900/50 rounded-lg p-3">
                    <input
                      type="color"
                      value={stop.color}
                      onChange={(e) => {
                        const newStops = [...(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS)];
                        newStops[index] = { ...newStops[index], color: e.target.value };
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, gradientStops: newStops }
                        }));
                      }}
                      className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                    />
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-300 text-sm font-mono">{stop.color}</span>
                        <span className="text-slate-400 text-sm">{stop.position}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={stop.position}
                        onChange={(e) => {
                          const newStops = [...(formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS)];
                          newStops[index] = { ...newStops[index], position: parseInt(e.target.value) };
                          setFormData(prev => ({
                            ...prev,
                            header_config: { ...prev.header_config, gradientStops: newStops }
                          }));
                        }}
                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                        data-testid={`slider-gradient-position-${index}`}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-slate-400 hover:text-red-400 flex-shrink-0"
                      onClick={() => {
                        const newStops = (formData.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS).filter((_, i) => i !== index);
                        setFormData(prev => ({
                          ...prev,
                          header_config: { ...prev.header_config, gradientStops: newStops }
                        }));
                      }}
                      data-testid={`button-remove-header-gradient-${index}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
                <input
                  type="color"
                  value={newHeaderGradientColor}
                  onChange={(e) => setNewHeaderGradientColor(e.target.value)}
                  className="w-10 h-10 rounded cursor-pointer"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400 text-sm">New color position</span>
                    <span className="text-slate-400 text-sm">{newHeaderGradientPosition}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={newHeaderGradientPosition}
                    onChange={(e) => setNewHeaderGradientPosition(parseInt(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                    data-testid="slider-new-gradient-position"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const newStop = { color: newHeaderGradientColor, position: newHeaderGradientPosition };
                    setFormData(prev => ({
                      ...prev,
                      header_config: {
                        ...prev.header_config,
                        gradientStops: [...(prev.header_config?.gradientStops || DEFAULT_GRADIENT_STOPS), newStop]
                          .sort((a, b) => a.position - b.position)
                      }
                    }));
                    setNewHeaderGradientColor('#000000');
                  }}
                  className="border-slate-600 text-slate-300"
                  data-testid="button-add-header-gradient-color"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add
                </Button>
              </div>
              <p className="text-xs text-slate-500">Adjust sliders to control where each color appears in the gradient (0% = left, 100% = right). Use white at 0% and 30% for the fade-from-white effect.</p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Type className="w-5 h-5" />
                Tagline
              </CardTitle>
              <CardDescription className="text-slate-400">
                A short tagline or slogan for your organization
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Input
                value={formData.tagline}
                onChange={(e) => setFormData({ ...formData, tagline: e.target.value })}
                className="bg-slate-900/50 border-slate-600 text-white"
                placeholder="Empowering professionals worldwide"
                data-testid="input-tagline"
              />
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <LayoutTemplate className="w-5 h-5" />
                Footer Configuration
              </CardTitle>
              <CardDescription className="text-slate-400">
                Customize the public website footer content
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label className="text-slate-200">Number of Footer Columns</Label>
                <p className="text-slate-400 text-sm">How many navigation columns to display in the footer (configured in Portal Navigation Management)</p>
                <Select
                  value={String(formData.footer_config.columns || 4)}
                  onValueChange={(value) => setFormData(prev => ({
                    ...prev,
                    footer_config: { ...prev.footer_config, columns: parseInt(value, 10) }
                  }))}
                >
                  <SelectTrigger className="bg-slate-900/50 border-slate-600 text-white w-32" data-testid="select-footer-columns">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 Column</SelectItem>
                    <SelectItem value="2">2 Columns</SelectItem>
                    <SelectItem value="3">3 Columns</SelectItem>
                    <SelectItem value="4">4 Columns</SelectItem>
                    <SelectItem value="5">5 Columns</SelectItem>
                    <SelectItem value="6">6 Columns</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-slate-200">Newsletter Heading</Label>
                <Input
                  value={formData.footer_config.newsletterText}
                  onChange={(e) => setFormData(prev => ({
                    ...prev,
                    footer_config: { ...prev.footer_config, newsletterText: e.target.value }
                  }))}
                  className="bg-slate-900/50 border-slate-600 text-white"
                  placeholder="Sign up to our newsletter"
                  data-testid="input-newsletter-text"
                />
              </div>

              <div className="space-y-3">
                <Label className="text-slate-200">Gradient Colors</Label>
                <p className="text-slate-400 text-sm">Colors used in the footer gradient bar and buttons</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {formData.footer_config.gradientColors?.map((color, index) => (
                    <div key={index} className="flex items-center gap-1 bg-slate-700 rounded px-2 py-1">
                      <input
                        type="color"
                        value={color}
                        onChange={(e) => updateGradientColor(index, e.target.value)}
                        className="w-6 h-6 rounded cursor-pointer"
                      />
                      <span className="text-white text-sm">{color}</span>
                      <button
                        type="button"
                        onClick={() => removeGradientColor(index)}
                        className="text-slate-400 hover:text-red-400 ml-1"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={newGradientColor}
                    onChange={(e) => setNewGradientColor(e.target.value)}
                    className="w-10 h-8 rounded cursor-pointer"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addGradientColor}
                    className="border-slate-600 text-slate-300"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add Color
                  </Button>
                </div>
                {formData.footer_config.gradientColors?.length > 0 && (
                  <div 
                    className="h-4 rounded mt-2"
                    style={{
                      background: `linear-gradient(to right, ${formData.footer_config.gradientColors.join(', ')})`
                    }}
                  />
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-slate-200">Background Color</Label>
                <p className="text-slate-400 text-sm">The background color for the entire footer section</p>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={formData.footer_config.backgroundColor || '#000000'}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: { ...prev.footer_config, backgroundColor: e.target.value }
                    }))}
                    className="w-12 h-10 rounded cursor-pointer"
                    data-testid="input-footer-background-color"
                  />
                  <Input
                    value={formData.footer_config.backgroundColor || '#000000'}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: { ...prev.footer_config, backgroundColor: e.target.value }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white flex-1"
                    placeholder="#000000"
                    data-testid="input-footer-background-color-text"
                  />
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4 space-y-4">
                <h4 className="text-white font-medium">Address</h4>
                <div className="space-y-2">
                  <Label className="text-slate-200">Organization Name</Label>
                  <Input
                    value={formData.footer_config.address.name}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: {
                        ...prev.footer_config,
                        address: { ...prev.footer_config.address, name: e.target.value }
                      }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="Your Organization Name"
                    data-testid="input-address-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-200">Address Lines</Label>
                  <div className="space-y-2">
                    {formData.footer_config.address.lines?.map((line, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          value={line}
                          disabled
                          className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          onClick={() => removeAddressLine(index)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center gap-2">
                      <Input
                        value={newAddressLine}
                        onChange={(e) => setNewAddressLine(e.target.value)}
                        className="bg-slate-900/50 border-slate-600 text-white flex-1"
                        placeholder="Add address line..."
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAddressLine())}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={addAddressLine}
                        className="border-slate-600 text-slate-300"
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4 space-y-4">
                <h4 className="text-white font-medium">Contact Information</h4>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-200">Phone Number</Label>
                    <Input
                      value={formData.footer_config.contact.phone}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: {
                          ...prev.footer_config,
                          contact: { ...prev.footer_config.contact, phone: e.target.value }
                        }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="+44 (0)114 251 5750"
                      data-testid="input-phone"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-200">Email Address</Label>
                    <Input
                      value={formData.footer_config.contact.email}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: {
                          ...prev.footer_config,
                          contact: { ...prev.footer_config.contact, email: e.target.value }
                        }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="hello@example.org"
                      data-testid="input-email"
                    />
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-700 pt-4 space-y-4">
                <h4 className="text-white font-medium">Legal</h4>
                <div className="space-y-2">
                  <Label className="text-slate-200">Legal / Charity Text</Label>
                  <Textarea
                    value={formData.footer_config.legalText}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: { ...prev.footer_config, legalText: e.target.value }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white min-h-[80px]"
                    placeholder="Registered charity number, company registration info, etc."
                    data-testid="input-legal-text"
                  />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-200">Terms & Conditions URL</Label>
                    <Input
                      value={formData.footer_config.termsAndConditionsUrl}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, termsAndConditionsUrl: e.target.value }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="https://..."
                      data-testid="input-terms-url"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-200">Privacy Policy URL</Label>
                    <Input
                      value={formData.footer_config.privacyPolicyUrl}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        footer_config: { ...prev.footer_config, privacyPolicyUrl: e.target.value }
                      }))}
                      className="bg-slate-900/50 border-slate-600 text-white"
                      placeholder="https://..."
                      data-testid="input-privacy-url"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Social Icon Colors Card */}
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white">
                <Palette className="w-5 h-5 text-blue-400" />
                Social Icon Colors
              </CardTitle>
              <CardDescription className="text-slate-400">
                Set the colors for social media icons in the header and footer
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label className="text-slate-200">Header Social Icons</Label>
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={formData.branding_config?.headerSocialIconColor || '#5C0085'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, headerSocialIconColor: e.target.value }
                      }))}
                      className="w-16 h-10 p-1 cursor-pointer"
                      data-testid="input-header-social-color"
                    />
                    <Input
                      type="text"
                      value={formData.branding_config?.headerSocialIconColor || '#5C0085'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, headerSocialIconColor: e.target.value }
                      }))}
                      className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                      placeholder="#FFFFFF"
                      data-testid="input-header-social-color-text"
                    />
                  </div>
                  <p className="text-xs text-slate-500">Color for social icons in the top navigation bar</p>
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-200">Footer Social Icons</Label>
                  <div className="flex gap-2">
                    <Input
                      type="color"
                      value={formData.branding_config?.footerSocialIconColor || '#FFFFFF'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, footerSocialIconColor: e.target.value }
                      }))}
                      className="w-16 h-10 p-1 cursor-pointer"
                      data-testid="input-footer-social-color"
                    />
                    <Input
                      type="text"
                      value={formData.branding_config?.footerSocialIconColor || '#FFFFFF'}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        branding_config: { ...prev.branding_config, footerSocialIconColor: e.target.value }
                      }))}
                      className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                      placeholder="#FFFFFF"
                      data-testid="input-footer-social-color-text"
                    />
                  </div>
                  <p className="text-xs text-slate-500">Color for social icons in the footer</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Platform Branding Card */}
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white">
                <Shield className="w-5 h-5 text-purple-400" />
                Platform Branding
              </CardTitle>
              <CardDescription className="text-slate-400">
                Configure the "Powered by" section that appears at the bottom of the footer
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between p-4 bg-slate-900/50 rounded-lg border border-slate-600">
                <Label className="text-white font-medium">Show Platform Branding</Label>
                <Switch
                  checked={formData.platform_branding.showPlatformBranding}
                  onCheckedChange={(checked) => setFormData(prev => ({
                    ...prev,
                    platform_branding: { ...prev.platform_branding, showPlatformBranding: checked }
                  }))}
                  data-testid="switch-platform-branding"
                />
              </div>

              {formData.platform_branding.showPlatformBranding && (
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-slate-200">Background Color</Label>
                    <div className="flex gap-2">
                      <Input
                        type="color"
                        value={formData.platform_branding.backgroundColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, backgroundColor: e.target.value }
                        }))}
                        className="w-16 h-10 p-1 cursor-pointer"
                        data-testid="input-platform-bg-color"
                      />
                      <Input
                        type="text"
                        value={formData.platform_branding.backgroundColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, backgroundColor: e.target.value }
                        }))}
                        className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                        placeholder="#000000"
                        data-testid="input-platform-bg-color-text"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-slate-200">Text Color</Label>
                    <div className="flex gap-2">
                      <Input
                        type="color"
                        value={formData.platform_branding.textColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, textColor: e.target.value }
                        }))}
                        className="w-16 h-10 p-1 cursor-pointer"
                        data-testid="input-platform-text-color"
                      />
                      <Input
                        type="text"
                        value={formData.platform_branding.textColor}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          platform_branding: { ...prev.platform_branding, textColor: e.target.value }
                        }))}
                        className="flex-1 bg-slate-900/50 border-slate-600 text-white font-mono"
                        placeholder="#64748b"
                        data-testid="input-platform-text-color-text"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Preview */}
              {formData.platform_branding.showPlatformBranding && (
                <div className="border-t border-slate-700 pt-4">
                  <Label className="text-slate-200 mb-3 block">Preview</Label>
                  <div 
                    className="text-center p-4 rounded-lg"
                    style={{ backgroundColor: formData.platform_branding.backgroundColor }}
                  >
                    <p 
                      className="text-xs"
                      style={{ color: formData.platform_branding.textColor }}
                    >
                      {platformDefaults.platformBrandingText}
                    </p>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">
                    Text and link URL are configured in Platform Admin &rarr; Defaults
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3">
            <Link to="/admin/dashboard">
              <Button type="button" variant="outline" className="border-slate-600 text-slate-300">
                Cancel
              </Button>
            </Link>
            <Button type="submit" disabled={saving} className="bg-purple-600 hover:bg-purple-700" data-testid="button-save">
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Branding
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
