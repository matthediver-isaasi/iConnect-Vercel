
import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ArrowUpRight, Download, ExternalLink, Mail, Plus, Save, Trash2, Edit, Eye, Check, X, ArrowLeft, PlayCircle, FileText } from "lucide-react";
import AGCASButton from "../components/ui/AGCASButton";
import AGCASSquareButton from "../components/ui/AGCASSquareButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const iconMap = {
  ArrowUpRight,
  Download,
  ExternalLink,
  PlayCircle,
  Eye,
  FileText,
  Mail,
  Plus,
};

export default function ButtonElementsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  // Derive admin status from feature exclusion - admins can access button styles
  const isAdmin = !isFeatureExcluded('site-builder.buttons');

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.buttons')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  // Memoize URL params to prevent re-reading on every render
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const mode = urlParams.get('mode');
  const editId = urlParams.get('id');

  const queryClient = useQueryClient();
  const [clickCount, setClickCount] = useState(0);

  const [isCreating] = useState(mode === 'create' || mode === 'edit');
  const [selectedCardType, setSelectedCardType] = useState(null);
  const [selectedResourceType, setSelectedResourceType] = useState(null);
  const [selectedButtonType, setSelectedButtonType] = useState(null);
  const [selectedIcon, setSelectedIcon] = useState('ArrowUpRight');
  const [customText, setCustomText] = useState('');
  const [styleName, setStyleName] = useState('');
  const [styleDescription, setStyleDescription] = useState('');

  const { data: editingStyle } = useQuery({
    queryKey: ['buttonStyle', editId],
    queryFn: async () => {
      const styles = await base44.entities.ButtonStyle.list();
      return styles.find(s => s.id === editId);
    },
    enabled: !!editId && mode === 'edit'
  });

  useEffect(() => {
    if (editingStyle) {
      setSelectedCardType(editingStyle.card_type);
      setSelectedResourceType(editingStyle.resource_type || null);
      setSelectedButtonType(editingStyle.button_type);
      setSelectedIcon(editingStyle.icon_name || 'ArrowUpRight');
      setCustomText(editingStyle.button_text || '');
      setStyleName(editingStyle.name || '');
      setStyleDescription(editingStyle.description || '');
    }
  }, [editingStyle]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!styleName.trim()) {
        throw new Error('Please enter a style name');
      }
      if (!selectedCardType) {
        throw new Error('Please select a card type');
      }
      if (selectedCardType === 'resource' && !selectedResourceType) {
        throw new Error('Please select a resource type');
      }
      if (!selectedButtonType) {
        throw new Error('Please select a button style');
      }

      const data = {
        name: styleName,
        card_type: selectedCardType,
        resource_type: selectedCardType === 'resource' ? selectedResourceType : undefined,
        button_type: selectedButtonType,
        button_text: customText || getDefaultText(selectedCardType, selectedResourceType, selectedButtonType),
        icon_name: selectedButtonType === 'rectangular_agcas' ? selectedIcon : 'none',
        description: styleDescription,
        is_active: true,
      };

      if (editId && mode === 'edit') {
        return await base44.entities.ButtonStyle.update(editId, data);
      } else {
        return await base44.entities.ButtonStyle.create(data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buttonStyles'] });
      toast.success(editId ? 'Button style updated successfully!' : 'Button style created successfully!');
      window.location.href = createPageUrl('ButtonStyleManagement');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save button style');
    },
  });

  const getDefaultText = (cardType, resourceType, buttonType) => {
    if (cardType === 'article') return 'Read Article';
    if (cardType === 'resource') {
      if (resourceType === 'download') return 'Download';
      if (resourceType === 'video') return 'Watch Video';
      if (resourceType === 'external_link') return 'Visit Site';
    }
    return 'Click Here';
  };

  const handleButtonClick = (type, icon = null) => {
    setSelectedButtonType(type);
    if (icon) setSelectedIcon(icon);
  };

  const handleCancel = () => {
    window.location.href = createPageUrl('ButtonStyleManagement');
  };

  const handleClick = () => {
    setClickCount(prev => prev + 1);
    toast.success('Button clicked!');
  };

  const renderButtonPreview = (type, text, icon) => {
    const displayText = text || getDefaultText(selectedCardType, selectedResourceType, type);
    const IconComponent = iconMap[icon];

    if (type === "square_agcas") {
      return <AGCASSquareButton onClick={() => {}} />;
    } else if (type === "rectangular_agcas") {
      return (
        <AGCASButton onClick={() => {}} icon={icon !== 'none' ? IconComponent : undefined}>
          {displayText}
        </AGCASButton>
      );
    } else {
      return (
        <Button className="bg-blue-600 hover:bg-blue-700">
          {IconComponent && icon !== 'none' && <IconComponent className="w-4 h-4 mr-2" />}
          {displayText}
        </Button>
      );
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  // If in creation/edit mode, show the style builder
  if (isCreating && isAdmin) {
    const canProceed = selectedCardType && (selectedCardType === 'article' || (selectedCardType === 'resource' && selectedResourceType));

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-5xl mx-auto">
          <div className="mb-8">
            <Button variant="ghost" onClick={handleCancel} className="mb-4 gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back to Button Styles
            </Button>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              {editId ? 'Edit Button Style' : 'Create Button Style'}
            </h1>
            <p className="text-slate-600">
              Select card type, then choose a button style to set as default
            </p>
          </div>

          <div className="grid lg:grid-cols-3 gap-8">
            {/* Settings Sidebar */}
            <div className="lg:col-span-1 space-y-6">
              <Card className="border-slate-200 shadow-sm sticky top-8">
                <CardHeader>
                  <CardTitle className="text-base">Style Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="style-name">Style Name *</Label>
                    <Input
                      id="style-name"
                      placeholder="e.g., Download Button Style"
                      value={styleName}
                      onChange={(e) => setStyleName(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="card-type">Card Type *</Label>
                    <Select value={selectedCardType || ''} onValueChange={setSelectedCardType}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select card type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="article">Article Cards</SelectItem>
                        <SelectItem value="resource">Resource Cards</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {selectedCardType === 'resource' && (
                    <div className="space-y-2">
                      <Label htmlFor="resource-type">Resource Type *</Label>
                      <Select value={selectedResourceType || ''} onValueChange={setSelectedResourceType}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select resource type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="download">Download Resources</SelectItem>
                          <SelectItem value="video">Video Resources</SelectItem>
                          <SelectItem value="external_link">External Link Resources</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">
                        This style will apply to all resource cards of this type
                      </p>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="custom-text">Button Text (Optional)</Label>
                    <Input
                      id="custom-text"
                      placeholder={`Default: ${getDefaultText(selectedCardType, selectedResourceType, selectedButtonType)}`}
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                    />
                    <p className="text-xs text-slate-500">
                      Leave empty to use default text
                    </p>
                  </div>

                  {selectedButtonType === 'rectangular_agcas' && (
                    <div className="space-y-2">
                      <Label htmlFor="icon">Icon</Label>
                      <Select value={selectedIcon} onValueChange={setSelectedIcon}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ArrowUpRight">Arrow Up Right</SelectItem>
                          <SelectItem value="Download">Download</SelectItem>
                          <SelectItem value="ExternalLink">External Link</SelectItem>
                          <SelectItem value="PlayCircle">Play Circle</SelectItem>
                          <SelectItem value="Eye">Eye</SelectItem>
                          <SelectItem value="FileText">File Text</SelectItem>
                          <SelectItem value="Mail">Mail</SelectItem>
                          <SelectItem value="Plus">Plus</SelectItem>
                          <SelectItem value="none">No Icon</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="description">Description (Optional)</Label>
                    <Textarea
                      id="description"
                      placeholder="Describe this button style..."
                      value={styleDescription}
                      onChange={(e) => setStyleDescription(e.target.value)}
                      rows={3}
                    />
                  </div>

                  {canProceed && selectedButtonType && (
                    <div className="pt-4 border-t border-slate-200">
                      <Label className="text-sm mb-3 block">Preview:</Label>
                      {renderButtonPreview(selectedButtonType, customText, selectedIcon)}
                    </div>
                  )}

                  <div className="pt-4 space-y-2">
                    <Button
                      onClick={() => saveMutation.mutate()}
                      disabled={saveMutation.isPending || !canProceed || !selectedButtonType || !styleName}
                      className="w-full bg-blue-600 hover:bg-blue-700"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      {editId ? 'Update Style' : 'Create Style'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleCancel}
                      className="w-full"
                    >
                      Cancel
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Button Selection Area */}
            <div className="lg:col-span-2 space-y-6">
              {!canProceed ? (
                <Card className="border-slate-200 shadow-sm">
                  <CardContent className="p-12 text-center">
                    <h3 className="text-xl font-semibold text-slate-900 mb-2">
                      {!selectedCardType ? 'Select a Card Type' : 'Select a Resource Type'}
                    </h3>
                    <p className="text-slate-600">
                      {!selectedCardType 
                        ? 'Choose card type from the sidebar to continue'
                        : 'Choose resource type from the sidebar to continue'}
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <Card className={`border-2 ${selectedButtonType === 'rectangular_agcas' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'} shadow-sm transition-all`}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle>AGCAS Rectangular Button</CardTitle>
                          <CardDescription>
                            Transparent background with 2px border and gradient hover - Click any button below to select it
                          </CardDescription>
                        </div>
                        {selectedButtonType === 'rectangular_agcas' && (
                          <Badge className="bg-blue-600">Selected</Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-4">
                        {Object.entries(iconMap).map(([name, Icon]) => (
                          <AGCASButton key={name} onClick={(e) => { e.stopPropagation(); handleButtonClick('rectangular_agcas', name); }} icon={Icon}>
                            {customText || getDefaultText(selectedCardType, selectedResourceType, 'rectangular_agcas')}
                          </AGCASButton>
                        ))}
                        <AGCASButton onClick={(e) => { e.stopPropagation(); handleButtonClick('rectangular_agcas', 'none'); }}>
                          {customText || getDefaultText(selectedCardType, selectedResourceType, 'rectangular_agcas')}
                        </AGCASButton>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className={`border-2 ${selectedButtonType === 'square_agcas' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'} shadow-sm cursor-pointer transition-all hover:border-blue-300`} onClick={() => handleButtonClick('square_agcas')}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle>AGCAS Square Button</CardTitle>
                          <CardDescription>
                            Square button with arrow up icon - Click to select
                          </CardDescription>
                        </div>
                        {selectedButtonType === 'square_agcas' && (
                          <Badge className="bg-blue-600">Selected</Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex gap-4">
                        <AGCASSquareButton onClick={(e) => { e.stopPropagation(); handleButtonClick('square_agcas'); }} />
                        <AGCASSquareButton onClick={(e) => { e.stopPropagation(); handleButtonClick('square_agcas'); }} className="w-20 h-20" />
                      </div>
                    </CardContent>
                  </Card>

                  <Card className={`border-2 ${selectedButtonType === 'standard' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'} shadow-sm transition-all`}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle>Standard Button</CardTitle>
                          <CardDescription>
                            Standard shadcn/ui button with solid background - Click any button below to select it
                          </CardDescription>
                        </div>
                        {selectedButtonType === 'standard' && (
                          <Badge className="bg-blue-600">Selected</Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-4">
                        {Object.entries(iconMap).map(([name, Icon]) => (
                          <Button key={name} onClick={(e) => { e.stopPropagation(); handleButtonClick('standard', name); }} className="bg-blue-600 hover:bg-blue-700">
                            <Icon className="w-4 h-4 mr-2" />
                            {customText || getDefaultText(selectedCardType, selectedResourceType, 'standard')}
                          </Button>
                        ))}
                        <Button onClick={(e) => { e.stopPropagation(); handleButtonClick('standard', 'none'); }} className="bg-blue-600 hover:bg-blue-700">
                          {customText || getDefaultText(selectedCardType, selectedResourceType, 'standard')}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Regular showcase mode
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            AGCAS Button Elements
          </h1>
          <p className="text-slate-600">
            Reusable button components with consistent styling across the portal
          </p>
        </div>

        <div className="grid gap-8">
          {/* Basic Button Showcase */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Basic AGCAS Button</CardTitle>
              <CardDescription>
                Rectangular button with 2px black border, transparent background, and gradient hover effect
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-slate-600 mb-3">Default Button:</p>
                  <AGCASButton onClick={handleClick}>
                    Click Me
                  </AGCASButton>
                </div>

                <div>
                  <p className="text-sm text-slate-600 mb-3">With Icon (Arrow Up Right):</p>
                  <AGCASButton onClick={handleClick} icon={ArrowUpRight}>
                    Join Us
                  </AGCASButton>
                </div>

                <div>
                  <p className="text-sm text-slate-600 mb-3">Disabled State:</p>
                  <AGCASButton disabled>
                    Disabled Button
                  </AGCASButton>
                </div>

                <div className="pt-4 border-t border-slate-200">
                  <p className="text-sm text-slate-500 italic">
                    Click count: {clickCount}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Square Button Showcase */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>AGCAS Square Button</CardTitle>
              <CardDescription>
                Square button with arrow up icon filling 80% of the space, same styling as rectangular button
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-slate-600 mb-3">Default Square Button:</p>
                  <AGCASSquareButton onClick={handleClick} />
                </div>

                <div>
                  <p className="text-sm text-slate-600 mb-3">Disabled State:</p>
                  <AGCASSquareButton disabled />
                </div>

                <div>
                  <p className="text-sm text-slate-600 mb-3">Custom Sizes:</p>
                  <div className="flex items-end gap-4">
                    <AGCASSquareButton onClick={handleClick} className="w-12 h-12" />
                    <AGCASSquareButton onClick={handleClick} />
                    <AGCASSquareButton onClick={handleClick} className="w-20 h-20" />
                    <AGCASSquareButton onClick={handleClick} className="w-24 h-24" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Button Variations with Different Icons */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Button Variations with Icons</CardTitle>
              <CardDescription>
                Different use cases with various Lucide icons
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                <AGCASButton onClick={handleClick} icon={Download}>
                  Download
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={ExternalLink}>
                  Visit Site
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={Mail}>
                  Contact
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={Plus}>
                  Add New
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={Save}>
                  Save Changes
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={Edit}>
                  Edit
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={Trash2}>
                  Delete
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={Eye}>
                  Preview
                </AGCASButton>

                <AGCASButton onClick={handleClick} icon={Check}>
                  Confirm
                </AGCASButton>
              </div>
            </CardContent>
          </Card>

          {/* Button Without Icons */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Text-Only Buttons</CardTitle>
              <CardDescription>
                Buttons without icons for simple actions
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                <AGCASButton onClick={handleClick}>
                  Submit
                </AGCASButton>

                <AGCASButton onClick={handleClick}>
                  Cancel
                </AGCASButton>

                <AGCASButton onClick={handleClick}>
                  Learn More
                </AGCASButton>

                <AGCASButton onClick={handleClick}>
                  Get Started
                </AGCASButton>
              </div>
            </CardContent>
          </Card>

          {/* Size Variations */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Size Variations</CardTitle>
              <CardDescription>
                Custom sizing using className prop
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-4">
                <AGCASButton onClick={handleClick} className="px-3 py-1.5 text-xs">
                  Small Button
                </AGCASButton>

                <AGCASButton onClick={handleClick}>
                  Default Button
                </AGCASButton>

                <AGCASButton onClick={handleClick} className="px-8 py-4 text-base">
                  Large Button
                </AGCASButton>

                <AGCASButton onClick={handleClick} className="px-12 py-5 text-lg">
                  Extra Large
                </AGCASButton>
              </div>
            </CardContent>
          </Card>

          {/* Full Width Buttons */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Full Width Buttons</CardTitle>
              <CardDescription>
                Buttons that span the full width of their container
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <AGCASButton onClick={handleClick} className="w-full" icon={ArrowUpRight}>
                Full Width Button
              </AGCASButton>

              <AGCASButton onClick={handleClick} className="w-full" icon={Download}>
                Download Resource
              </AGCASButton>

              <AGCASButton onClick={handleClick} className="w-full">
                Continue
              </AGCASButton>
            </CardContent>
          </Card>

          {/* Usage Example / Code Reference */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Usage Example</CardTitle>
              <CardDescription>
                How to import and use the AGCAS Button components
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto">
                <pre className="text-sm">
{`import AGCASButton from "@/components/ui/AGCASButton";
import AGCASSquareButton from "@/components/ui/AGCASSquareButton";
import { ArrowUpRight } from "lucide-react";

// Basic rectangular button
<AGCASButton onClick={handleClick}>
  Click Me
</AGCASButton>

// Rectangular button with icon
<AGCASButton onClick={handleClick} icon={ArrowUpRight}>
  Join Us
</AGCASButton>

// Square button with arrow up icon
<AGCASSquareButton onClick={handleClick} />

// Square button with custom size
<AGCASSquareButton 
  onClick={handleClick} 
  className="w-20 h-20"
/>

// With custom styling
<AGCASButton 
  onClick={handleClick} 
  className="w-full px-8 py-4"
  icon={Download}
>
  Download Now
</AGCASButton>

// Disabled state
<AGCASButton disabled>
  Disabled Button
</AGCASButton>`}
                </pre>
              </div>
            </CardContent>
          </Card>

          {/* Comparison with Standard Button */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Comparison</CardTitle>
              <CardDescription>
                AGCAS Button vs Standard shadcn/ui Button
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-slate-700">AGCAS Button:</p>
                  <AGCASButton onClick={handleClick} icon={ArrowUpRight}>
                    AGCAS Style
                  </AGCASButton>
                  <ul className="text-sm text-slate-600 space-y-1 ml-4">
                    <li>• 2px black border</li>
                    <li>• Transparent background</li>
                    <li>• Gradient hover effect</li>
                    <li>• No border radius</li>
                  </ul>
                </div>

                <div className="space-y-3">
                  <p className="text-sm font-semibold text-slate-700">Standard Button:</p>
                  <Button onClick={handleClick} className="bg-blue-600 hover:bg-blue-700">
                    <ArrowUpRight className="w-4 h-4 mr-2" />
                    Standard Style
                  </Button>
                  <ul className="text-sm text-slate-600 space-y-1 ml-4">
                    <li>• Solid background</li>
                    <li>• Rounded corners</li>
                    <li>• Simple hover effect</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
