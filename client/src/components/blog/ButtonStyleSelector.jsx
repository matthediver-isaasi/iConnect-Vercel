import React from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Check } from "lucide-react";
import AGCASButton from "../ui/AGCASButton";
import AGCASSquareButton from "../ui/AGCASSquareButton";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, Download, ExternalLink, PlayCircle, Eye, FileText, Mail, Plus } from "lucide-react";

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

export default function ButtonStyleSelector({ 
  selectedStyleId, 
  onStyleChange, 
  customButtonText, 
  onCustomTextChange,
  label = "Button Style"
}) {
  const { data: buttonStyles = [], isLoading } = useQuery({
    queryKey: ['activeButtonStyles'],
    queryFn: async () => {
      const styles = await base44.entities.ButtonStyle.list('-created_at');
      return styles.filter(s => s.is_active);
    }
  });

  const renderButtonPreview = (style) => {
    const displayText = customButtonText || style.button_text || "Sample Text";
    const IconComponent = iconMap[style.icon_name];

    if (style.button_type === "square_agcas") {
      return <AGCASSquareButton onClick={() => {}} />;
    } else if (style.button_type === "rectangular_agcas") {
      return (
        <AGCASButton onClick={() => {}} icon={style.icon_name !== 'none' ? IconComponent : undefined}>
          {displayText}
        </AGCASButton>
      );
    } else {
      return (
        <Button className="bg-blue-600 hover:bg-blue-700">
          {IconComponent && style.icon_name !== 'none' && <IconComponent className="w-4 h-4 mr-2" />}
          {displayText}
        </Button>
      );
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label>{label}</Label>
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 mt-2">
            {Array(4).fill(0).map((_, i) => (
              <div key={i} className="h-24 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : buttonStyles.length === 0 ? (
          <Card className="mt-2">
            <CardContent className="p-6 text-center text-sm text-slate-600">
              No button styles available. Please create one first.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mt-2">
            {buttonStyles.map((style) => (
              <Card
                key={style.id}
                className={`cursor-pointer transition-all border-2 ${
                  selectedStyleId === style.id
                    ? 'border-blue-500 bg-blue-50 shadow-md'
                    : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
                }`}
                onClick={() => onStyleChange(style.id)}
              >
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">
                        {style.name}
                      </p>
                      {style.description && (
                        <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">
                          {style.description}
                        </p>
                      )}
                    </div>
                    {selectedStyleId === style.id && (
                      <div className="ml-2 flex-shrink-0">
                        <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                          <Check className="w-3 h-3 text-white" />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-center py-2">
                    {renderButtonPreview(style)}
                  </div>
                </CardContent>
              </Card>
            ))}
            
            {/* Clear selection option */}
            <Card
              className={`cursor-pointer transition-all border-2 ${
                !selectedStyleId
                  ? 'border-blue-500 bg-blue-50 shadow-md'
                  : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
              }`}
              onClick={() => onStyleChange(null)}
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-slate-900">
                      Default
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Use standard button
                    </p>
                  </div>
                  {!selectedStyleId && (
                    <div className="ml-2 flex-shrink-0">
                      <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                        <Check className="w-3 h-3 text-white" />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-center py-2">
                  <Button className="bg-blue-600 hover:bg-blue-700 text-sm">
                    {customButtonText || "Default Button"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Custom button text input */}
      <div>
        <Label htmlFor="custom-button-text">Custom Button Text (Optional)</Label>
        <Input
          id="custom-button-text"
          value={customButtonText || ''}
          onChange={(e) => onCustomTextChange(e.target.value)}
          placeholder="Override default button text..."
          className="mt-1"
        />
        <p className="text-xs text-slate-500 mt-1">
          Leave empty to use the button style's default text
        </p>
      </div>
    </div>
  );
}