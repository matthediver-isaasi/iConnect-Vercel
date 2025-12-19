import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Settings, Save, LayoutGrid, Image } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function NewsSettingsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('content.news-settings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const [tickerCount, setTickerCount] = useState(3);
  const [cycleSeconds, setCycleSeconds] = useState(5);
  const [tickerEnabled, setTickerEnabled] = useState(true);
  const [tickerBottomMargin, setTickerBottomMargin] = useState(0);
  const [showAuthor, setShowAuthor] = useState(true);
  const [cardsPerRow, setCardsPerRow] = useState("3");
  const [showImage, setShowImage] = useState(true);

  const queryClient = useQueryClient();

  const { data: settings = [], isLoading } = useQuery({
    queryKey: ['news-ticker-settings'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.filter(s => 
        s.setting_key === 'news_ticker_count' || 
        s.setting_key === 'news_ticker_cycle_seconds' ||
        s.setting_key === 'news_ticker_enabled' ||
        s.setting_key === 'news_ticker_bottom_margin' ||
        s.setting_key === 'news_show_author' ||
        s.setting_key === 'news_cards_per_row' ||
        s.setting_key === 'news_show_image'
      );
    },
    enabled: accessChecked
  });

  useEffect(() => {
    if (settings.length > 0) {
      const countSetting = settings.find(s => s.setting_key === 'news_ticker_count');
      const cycleSetting = settings.find(s => s.setting_key === 'news_ticker_cycle_seconds');
      const enabledSetting = settings.find(s => s.setting_key === 'news_ticker_enabled');
      const bottomMarginSetting = settings.find(s => s.setting_key === 'news_ticker_bottom_margin');
      const authorSetting = settings.find(s => s.setting_key === 'news_show_author');
      const cardsPerRowSetting = settings.find(s => s.setting_key === 'news_cards_per_row');
      const showImageSetting = settings.find(s => s.setting_key === 'news_show_image');
      
      if (countSetting) setTickerCount(parseInt(countSetting.setting_value) || 3);
      if (cycleSetting) setCycleSeconds(parseInt(cycleSetting.setting_value) || 5);
      if (enabledSetting) setTickerEnabled(enabledSetting.setting_value === 'true');
      if (bottomMarginSetting) setTickerBottomMargin(parseInt(bottomMarginSetting.setting_value) || 0);
      if (authorSetting) setShowAuthor(authorSetting.setting_value === 'true');
      if (cardsPerRowSetting) setCardsPerRow(cardsPerRowSetting.setting_value || "3");
      if (showImageSetting) setShowImage(showImageSetting.setting_value === 'true');
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const countSetting = settings.find(s => s.setting_key === 'news_ticker_count');
      const cycleSetting = settings.find(s => s.setting_key === 'news_ticker_cycle_seconds');
      const enabledSetting = settings.find(s => s.setting_key === 'news_ticker_enabled');
      const bottomMarginSetting = settings.find(s => s.setting_key === 'news_ticker_bottom_margin');
      const authorSetting = settings.find(s => s.setting_key === 'news_show_author');
      const cardsPerRowSetting = settings.find(s => s.setting_key === 'news_cards_per_row');
      const showImageSetting = settings.find(s => s.setting_key === 'news_show_image');

      const promises = [];

      if (countSetting) {
        promises.push(
          base44.entities.SystemSettings.update(countSetting.id, {
            setting_value: tickerCount.toString()
          })
        );
      } else {
        promises.push(
          base44.entities.SystemSettings.create({
            setting_key: 'news_ticker_count',
            setting_value: tickerCount.toString(),
            description: 'Number of news articles to display in ticker'
          })
        );
      }

      if (cycleSetting) {
        promises.push(
          base44.entities.SystemSettings.update(cycleSetting.id, {
            setting_value: cycleSeconds.toString()
          })
        );
      } else {
        promises.push(
          base44.entities.SystemSettings.create({
            setting_key: 'news_ticker_cycle_seconds',
            setting_value: cycleSeconds.toString(),
            description: 'Seconds between news ticker transitions'
          })
        );
      }

      if (enabledSetting) {
        promises.push(
          base44.entities.SystemSettings.update(enabledSetting.id, {
            setting_value: tickerEnabled.toString()
          })
        );
      } else {
        promises.push(
          base44.entities.SystemSettings.create({
            setting_key: 'news_ticker_enabled',
            setting_value: tickerEnabled.toString(),
            description: 'Whether the news ticker is enabled'
          })
        );
      }

      if (bottomMarginSetting) {
        promises.push(
          base44.entities.SystemSettings.update(bottomMarginSetting.id, {
            setting_value: tickerBottomMargin.toString()
          })
        );
      } else {
        promises.push(
          base44.entities.SystemSettings.create({
            setting_key: 'news_ticker_bottom_margin',
            setting_value: tickerBottomMargin.toString(),
            description: 'Bottom margin for the news ticker in pixels'
          })
        );
      }

      if (authorSetting) {
        promises.push(
          base44.entities.SystemSettings.update(authorSetting.id, {
            setting_value: showAuthor.toString()
          })
        );
      } else {
        promises.push(
          base44.entities.SystemSettings.create({
            setting_key: 'news_show_author',
            setting_value: showAuthor.toString(),
            description: 'Whether to show author on news cards and articles'
          })
        );
      }

      if (cardsPerRowSetting) {
        promises.push(
          base44.entities.SystemSettings.update(cardsPerRowSetting.id, {
            setting_value: cardsPerRow
          })
        );
      } else {
        promises.push(
          base44.entities.SystemSettings.create({
            setting_key: 'news_cards_per_row',
            setting_value: cardsPerRow,
            description: 'Number of news cards per row on desktop (2, 3, or 4)'
          })
        );
      }

      if (showImageSetting) {
        promises.push(
          base44.entities.SystemSettings.update(showImageSetting.id, {
            setting_value: showImage.toString()
          })
        );
      } else {
        promises.push(
          base44.entities.SystemSettings.create({
            setting_key: 'news_show_image',
            setting_value: showImage.toString(),
            description: 'Whether to show feature images on news cards'
          })
        );
      }

      await Promise.all(promises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-ticker-settings'] });
      queryClient.invalidateQueries({ queryKey: ['news-display-settings'] });
      toast.success('News settings saved successfully');
    },
    onError: () => {
      toast.error('Failed to save settings');
    }
  });

  const handleSave = () => {
    if (tickerCount < 1) {
      toast.error('Number of articles must be at least 1');
      return;
    }
    if (cycleSeconds < 2) {
      toast.error('Cycle time must be at least 2 seconds');
      return;
    }
    saveMutation.mutate();
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            News Settings
          </h1>
          <p className="text-slate-600">Configure news display and ticker settings</p>
        </div>

        <div className="space-y-6">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <CardTitle className="flex items-center gap-2">
                <LayoutGrid className="w-5 h-5" />
                Display Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              {isLoading ? (
                <div className="text-center py-8 text-slate-600">Loading settings...</div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="cards-per-row">Cards Per Row (Desktop)</Label>
                    <Select value={cardsPerRow} onValueChange={setCardsPerRow}>
                      <SelectTrigger id="cards-per-row" className="w-full" data-testid="select-cards-per-row">
                        <SelectValue placeholder="Select cards per row" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="2">2 cards per row</SelectItem>
                        <SelectItem value="3">3 cards per row</SelectItem>
                        <SelectItem value="4">4 cards per row</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Number of news cards to display per row on desktop screens
                    </p>
                  </div>

                  <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                    <Switch
                      id="show-image"
                      checked={showImage}
                      onCheckedChange={setShowImage}
                      data-testid="switch-show-image"
                    />
                    <div className="flex-1">
                      <Label htmlFor="show-image" className="cursor-pointer font-medium">
                        Show Feature Images
                      </Label>
                      <p className="text-xs text-slate-500 mt-1">
                        Display feature images on news cards
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                    <Switch
                      id="show-author"
                      checked={showAuthor}
                      onCheckedChange={setShowAuthor}
                      data-testid="switch-show-author"
                    />
                    <div className="flex-1">
                      <Label htmlFor="show-author" className="cursor-pointer font-medium">
                        Show Author
                      </Label>
                      <p className="text-xs text-slate-500 mt-1">
                        Display author information on news cards and articles
                      </p>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                Ticker Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              {isLoading ? (
                <div className="text-center py-8 text-slate-600">Loading settings...</div>
              ) : (
                <>
                  <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg mb-6">
                    <Switch
                      id="ticker-enabled"
                      checked={tickerEnabled}
                      onCheckedChange={setTickerEnabled}
                      data-testid="switch-ticker-enabled"
                    />
                    <div className="flex-1">
                      <Label htmlFor="ticker-enabled" className="cursor-pointer font-medium">
                        Enable News Ticker
                      </Label>
                      <p className="text-xs text-slate-500 mt-1">
                        Show or hide the news ticker bar at the top of the member portal
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ticker-count">Number of Articles to Display</Label>
                    <Input
                      id="ticker-count"
                      type="number"
                      min="1"
                      max="10"
                      value={tickerCount}
                      onChange={(e) => setTickerCount(parseInt(e.target.value) || 1)}
                      data-testid="input-ticker-count"
                    />
                    <p className="text-xs text-slate-500">
                      The latest published news articles to cycle through in the ticker
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="cycle-seconds">Cycle Time (seconds)</Label>
                    <Input
                      id="cycle-seconds"
                      type="number"
                      min="2"
                      max="60"
                      value={cycleSeconds}
                      onChange={(e) => setCycleSeconds(parseInt(e.target.value) || 2)}
                      data-testid="input-cycle-seconds"
                    />
                    <p className="text-xs text-slate-500">
                      Time in seconds before switching to the next article (minimum 2 seconds)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="bottom-margin">Bottom Margin (pixels)</Label>
                    <Input
                      id="bottom-margin"
                      type="number"
                      min="0"
                      max="100"
                      value={tickerBottomMargin}
                      onChange={(e) => setTickerBottomMargin(parseInt(e.target.value) || 0)}
                      data-testid="input-ticker-bottom-margin"
                    />
                    <p className="text-xs text-slate-500">
                      Space below the news ticker bar (0-100 pixels)
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button 
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 gap-2"
              data-testid="button-save-settings"
            >
              <Save className="w-4 h-4" />
              Save Settings
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
