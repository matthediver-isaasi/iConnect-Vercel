import { useState, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  X
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

export default function AdminBranding() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [tenantUser, setTenantUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  
  const logoInputRef = useRef(null);
  
  const [formData, setFormData] = useState({
    primary_color: '#5C0085',
    secondary_color: '#BA0087',
    tagline: '',
    logo_url: '',
    header_config: {},
    footer_config: {
      ctaText: 'Become a member today',
      ctaButtonText: 'Join Us',
      ctaLink: 'Membership',
      newsletterText: 'Sign up to our newsletter',
      gradientColors: ['#5C0085', '#BA0087', '#EE00C3', '#FF4229', '#FFB000'],
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
    branding_config: {}
  });

  const [newAddressLine, setNewAddressLine] = useState('');
  const [newGradientColor, setNewGradientColor] = useState('#000000');

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
              header_config: t?.header_config || {},
              footer_config: {
                ctaText: t?.footer_config?.ctaText || 'Become a member today',
                ctaButtonText: t?.footer_config?.ctaButtonText || 'Join Us',
                ctaLink: t?.footer_config?.ctaLink || 'Membership',
                newsletterText: t?.footer_config?.newsletterText || 'Sign up to our newsletter',
                gradientColors: t?.footer_config?.gradientColors || ['#5C0085', '#BA0087', '#EE00C3', '#FF4229', '#FFB000'],
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
              branding_config: t?.branding_config || {}
            });
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
      const response = await fetch('/api/upload', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData
      });
      
      if (response.ok) {
        const data = await response.json();
        setFormData(prev => ({ ...prev, logo_url: data.url }));
        toast({
          title: "Logo uploaded",
          description: "Your logo has been uploaded successfully."
        });
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
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-slate-200">CTA Heading</Label>
                  <Input
                    value={formData.footer_config.ctaText}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: { ...prev.footer_config, ctaText: e.target.value }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="Become a member today"
                    data-testid="input-cta-text"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-slate-200">CTA Button Text</Label>
                  <Input
                    value={formData.footer_config.ctaButtonText}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: { ...prev.footer_config, ctaButtonText: e.target.value }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="Join Us"
                    data-testid="input-cta-button-text"
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-slate-200">CTA Link (Page Name)</Label>
                  <Input
                    value={formData.footer_config.ctaLink}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      footer_config: { ...prev.footer_config, ctaLink: e.target.value }
                    }))}
                    className="bg-slate-900/50 border-slate-600 text-white"
                    placeholder="Membership"
                    data-testid="input-cta-link"
                  />
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
