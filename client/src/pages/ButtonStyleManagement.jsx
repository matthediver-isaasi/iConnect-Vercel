import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Edit, Trash2, Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import AGCASButton from "../components/ui/AGCASButton";
import AGCASSquareButton from "../components/ui/AGCASSquareButton";
import { ArrowUpRight, Download, ExternalLink, PlayCircle, Eye, FileText, Mail, Plus as PlusIcon } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const iconMap = {
  ArrowUpRight,
  Download,
  ExternalLink,
  PlayCircle,
  Eye,
  FileText,
  Mail,
  Plus: PlusIcon,
};

export default function ButtonStyleManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_ButtonStyleManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: buttonStyles = [], isLoading } = useQuery({
    queryKey: ['buttonStyles'],
    queryFn: () => base44.entities.ButtonStyle.list('-created_at'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.ButtonStyle.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['buttonStyles'] });
      toast.success('Button style deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete button style: ' + error.message);
    },
  });

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const handleCreateNew = () => {
    window.location.href = createPageUrl('ButtonElements') + '?mode=create';
  };

  const handleEdit = (style) => {
    window.location.href = createPageUrl('ButtonElements') + `?mode=edit&id=${style.id}`;
  };

  const handleDelete = (id) => {
    if (window.confirm('Are you sure you want to delete this button style? This action cannot be undone.')) {
      deleteMutation.mutate(id);
    }
  };

  const renderPreview = (style) => {
    const IconComponent = iconMap[style.icon_name];
    
    if (style.button_type === "square_agcas") {
      return <AGCASSquareButton onClick={() => {}} />;
    } else if (style.button_type === "rectangular_agcas") {
      return (
        <AGCASButton onClick={() => {}} icon={style.icon_name !== 'none' ? IconComponent : undefined}>
          {style.button_text || "Sample Text"}
        </AGCASButton>
      );
    } else {
      return (
        <Button className="bg-blue-600 hover:bg-blue-700">
          {IconComponent && style.icon_name !== 'none' && <IconComponent className="w-4 h-4 mr-2" />}
          {style.button_text || "Sample Text"}
        </Button>
      );
    }
  };

  const getResourceTypeLabel = (type) => {
    switch (type) {
      case 'download': return 'Download Resources';
      case 'video': return 'Video Resources';
      case 'external_link': return 'External Link Resources';
      default: return 'Resources';
    }
  };

  // Group styles
  const articleStyles = buttonStyles.filter(s => s.card_type === 'article');
  const downloadStyles = buttonStyles.filter(s => s.card_type === 'resource' && s.resource_type === 'download');
  const videoStyles = buttonStyles.filter(s => s.card_type === 'resource' && s.resource_type === 'video');
  const externalLinkStyles = buttonStyles.filter(s => s.card_type === 'resource' && s.resource_type === 'external_link');

  const renderStyleSection = (title, styles, emptyMessage) => (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
        {styles.length === 0 && (
          <Button onClick={handleCreateNew} variant="outline" size="sm" className="gap-2">
            <Plus className="w-4 h-4" />
            Add Style
          </Button>
        )}
      </div>
      
      {styles.length === 0 ? (
        <Card className="border-slate-200 shadow-sm border-dashed">
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">{emptyMessage}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {styles.map((style) => (
            <Card key={style.id} className="border-slate-200 shadow-sm">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-lg mb-1">{style.name}</CardTitle>
                    {style.description && (
                      <p className="text-sm text-slate-600">{style.description}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(style)}
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(style.id)}
                      className="text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Preview</div>
                  <div className="flex items-center gap-3">
                    {renderPreview(style)}
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-200">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">Type</div>
                    <div className="text-sm font-medium capitalize">
                      {style.button_type.replace(/_/g, ' ')}
                    </div>
                  </div>
                  {style.button_type === "rectangular_agcas" && style.icon_name !== 'none' && (
                    <div>
                      <div className="text-xs text-slate-500 mb-1">Icon</div>
                      <div className="text-sm font-medium">
                        {style.icon_name}
                      </div>
                    </div>
                  )}
                  <div className="col-span-2">
                    <div className="text-xs text-slate-500 mb-1">Status</div>
                    <div className="flex items-center gap-2">
                      {style.is_active ? (
                        <>
                          <Check className="w-4 h-4 text-green-600" />
                          <span className="text-sm text-green-600 font-medium">Active</span>
                        </>
                      ) : (
                        <>
                          <X className="w-4 h-4 text-slate-400" />
                          <span className="text-sm text-slate-400 font-medium">Inactive</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Button Style Management
            </h1>
            <p className="text-slate-600">
              Define default button styles for different card types
            </p>
          </div>
          <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700 gap-2">
            <Plus className="w-4 h-4" />
            Create Button Style
          </Button>
        </div>

        {isLoading ? (
          <div className="grid md:grid-cols-2 gap-6">
            {Array(4).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <CardHeader>
                  <div className="h-6 bg-slate-200 rounded w-1/2 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-3/4" />
                </CardHeader>
                <CardContent>
                  <div className="h-10 bg-slate-200 rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : buttonStyles.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No button styles yet
              </h3>
              <p className="text-slate-600 mb-6">
                Create button styles to define how buttons appear on Article and Resource cards
              </p>
              <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700 gap-2">
                <Plus className="w-4 h-4" />
                Create First Style
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            {/* Article Card Styles */}
            {renderStyleSection(
              'Article Cards',
              articleStyles,
              'No button style defined for Article cards yet'
            )}

            {/* Download Resource Styles */}
            {renderStyleSection(
              'Download Resources',
              downloadStyles,
              'No button style defined for Download resources yet'
            )}

            {/* Video Resource Styles */}
            {renderStyleSection(
              'Video Resources',
              videoStyles,
              'No button style defined for Video resources yet'
            )}

            {/* External Link Resource Styles */}
            {renderStyleSection(
              'External Link Resources',
              externalLinkStyles,
              'No button style defined for External Link resources yet'
            )}
          </div>
        )}
      </div>
    </div>
  );
}