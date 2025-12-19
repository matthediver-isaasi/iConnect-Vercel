import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function BorderRadiusSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();
  const [borderRadius, setBorderRadius] = useState("");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_BorderRadiusSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['borderRadiusSettings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'global_border_radius');
      return setting;
    },
    onSuccess: (data) => {
      if (data) {
        setBorderRadius(data.setting_value);
      } else {
        setBorderRadius('8px');
      }
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (settings) {
        return await base44.entities.SystemSettings.update(settings.id, {
          setting_value: borderRadius
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'global_border_radius',
          setting_value: borderRadius,
          description: 'Global border radius for cards, buttons, and inputs'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['borderRadiusSettings'] });
      toast.success('Border radius settings saved. Refresh the page to see changes.');
    },
    onError: (error) => {
      toast.error('Failed to save settings: ' + error.message);
    },
  });

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Border Radius Settings
          </h1>
          <p className="text-slate-600">
            Configure the global border radius for cards, buttons, inputs, and other UI elements
          </p>
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Global Border Radius</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="border-radius">Border Radius Value</Label>
              <Input
                id="border-radius"
                value={borderRadius}
                onChange={(e) => setBorderRadius(e.target.value)}
                placeholder="e.g., 0px, 4px, 8px, 12px, 0.5rem"
              />
              <p className="text-sm text-slate-500">
                Enter a CSS border-radius value. Use "0px" or "0" for square corners, or values like "8px", "12px", "1rem" for rounded corners.
              </p>
            </div>

            <div className="space-y-4">
              <Label>Preview</Label>
              
              <div className="space-y-4">
                <div className="p-6 bg-white border border-slate-200 shadow-sm" style={{ borderRadius }}>
                  <p className="text-sm font-medium text-slate-900 mb-2">Sample Card</p>
                  <p className="text-sm text-slate-600">This is how cards will look with the selected border radius.</p>
                </div>

                <Button 
                  variant="outline" 
                  style={{ borderRadius }}
                  onClick={() => {}}
                >
                  Sample Button
                </Button>

                <Input 
                  placeholder="Sample Input"
                  style={{ borderRadius }}
                />
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || isLoading}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Save className="w-4 h-4 mr-2" />
                {saveMutation.isPending ? 'Saving...' : 'Save Settings'}
              </Button>

              <Button
                variant="outline"
                onClick={() => setBorderRadius('0px')}
              >
                Square (0px)
              </Button>

              <Button
                variant="outline"
                onClick={() => setBorderRadius('8px')}
              >
                Default (8px)
              </Button>
            </div>

            <div className="bg-amber-50 border border-amber-200 p-4 mt-6">
              <p className="text-sm text-amber-800">
                <strong>Note:</strong> After saving, you'll need to refresh the page for changes to take effect throughout the application.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}