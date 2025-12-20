import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, Search, Eye, Lock, Globe, Users } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Define all configurable built-in pages with their display names and categories
const CONFIGURABLE_PAGES = [
  // User Navigation - Core
  { id: "Events", name: "Events", category: "Core", description: "Event listings and details" },
  { id: "Resources", name: "Resources", category: "Core", description: "Resource library" },
  { id: "Articles", name: "Articles/Blogs", category: "Core", description: "Blog articles listing" },
  { id: "ArticleView", name: "Article View", category: "Core", description: "Individual article pages" },
  { id: "News", name: "News", category: "Core", description: "News listings" },
  { id: "NewsView", name: "News View", category: "Core", description: "Individual news pages" },
  
  // User Navigation - Jobs
  { id: "JobBoard", name: "Job Board", category: "Jobs", description: "Job listings" },
  { id: "JobDetails", name: "Job Details", category: "Jobs", description: "Individual job pages" },
  { id: "PostJob", name: "Post Job", category: "Jobs", description: "Job posting form" },
  { id: "MyJobPostings", name: "My Job Postings", category: "Jobs", description: "Member's own job postings" },
  
  // User Navigation - Directory
  { id: "OrganisationDirectory", name: "Organisation Directory", category: "Directory", description: "Organisation listings" },
  { id: "MemberDirectory", name: "Member Directory", category: "Directory", description: "Member listings" },
  
  // User Navigation - Tickets & Events
  { id: "BuyProgramTickets", name: "Buy Program Tickets", category: "Tickets", description: "Ticket purchase" },
  { id: "Bookings", name: "Bookings", category: "Tickets", description: "Member bookings" },
  { id: "MyTickets", name: "My Tickets", category: "Tickets", description: "Member's tickets" },
  { id: "Balances", name: "Balances", category: "Tickets", description: "Account balances" },
  { id: "History", name: "History", category: "Tickets", description: "Transaction history" },
  
  // User Navigation - Account
  { id: "Team", name: "Team", category: "Account", description: "Team management" },
  { id: "Preferences", name: "Preferences", category: "Account", description: "User preferences" },
  { id: "Support", name: "Support", category: "Account", description: "Support requests" },
  
  // Forms
  { id: "FormView", name: "Form View", category: "Forms", description: "Public/member form pages" },
  
  // Dynamic CMS pages are handled separately via IEditPageSettings
];

// Visibility options
const VISIBILITY_OPTIONS = [
  { value: "portal", label: "Portal Only", icon: Lock, description: "Members only, with sidebar" },
  { value: "public", label: "Public Only", icon: Globe, description: "Anyone can view, public layout" },
  { value: "hybrid", label: "Both (Hybrid)", icon: Users, description: "Anyone can view, members see portal layout" },
];

// Default visibility for pages (matches current hardcoded behavior)
const DEFAULT_VISIBILITY = {
  // Currently hybrid pages
  "PostJob": "hybrid",
  "ArticleView": "hybrid",
  "NewsView": "hybrid",
  "OrganisationDirectory": "hybrid",
  "JobBoard": "hybrid",
  "JobDetails": "hybrid",
  "FormView": "hybrid",
  // All others default to portal
};

export default function PageVisibilitySettings() {
  const { hasBanner } = useLayoutContext();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [settings, setSettings] = useState({});
  const [hasChanges, setHasChanges] = useState(false);

  // Load current settings
  const { data: savedSettings, isLoading, refetch } = useQuery({
    queryKey: ["page-visibility-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_settings")
        .select("setting_value")
        .eq("setting_key", "page_visibility_settings")
        .limit(1);
      
      if (error) throw error;
      
      if (data?.[0]?.setting_value) {
        try {
          return JSON.parse(data[0].setting_value);
        } catch {
          return {};
        }
      }
      return {};
    },
  });

  // Initialize settings from saved data
  useEffect(() => {
    if (savedSettings) {
      setSettings(savedSettings);
    }
  }, [savedSettings]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (newSettings) => {
      // Check if setting exists
      const { data: existing } = await supabase
        .from("system_settings")
        .select("id")
        .eq("setting_key", "page_visibility_settings")
        .limit(1);

      if (existing && existing.length > 0) {
        // Update existing
        const { error } = await supabase
          .from("system_settings")
          .update({ setting_value: JSON.stringify(newSettings) })
          .eq("setting_key", "page_visibility_settings");
        if (error) throw error;
      } else {
        // Insert new
        const { error } = await supabase
          .from("system_settings")
          .insert({
            setting_key: "page_visibility_settings",
            setting_value: JSON.stringify(newSettings),
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast({
        title: "Settings Saved",
        description: "Page visibility settings have been updated. Changes will take effect on page reload.",
      });
      setHasChanges(false);
      refetch();
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to save settings: " + error.message,
        variant: "destructive",
      });
    },
  });

  const getVisibility = (pageId) => {
    return settings[pageId] || DEFAULT_VISIBILITY[pageId] || "portal";
  };

  const setVisibility = (pageId, visibility) => {
    setSettings((prev) => ({
      ...prev,
      [pageId]: visibility,
    }));
    setHasChanges(true);
  };

  const handleSave = () => {
    saveMutation.mutate(settings);
  };

  // Filter pages by search
  const filteredPages = CONFIGURABLE_PAGES.filter(
    (page) =>
      page.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      page.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
      page.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group by category
  const groupedPages = filteredPages.reduce((acc, page) => {
    if (!acc[page.category]) {
      acc[page.category] = [];
    }
    acc[page.category].push(page);
    return acc;
  }, {});

  const getVisibilityIcon = (visibility) => {
    const option = VISIBILITY_OPTIONS.find((o) => o.value === visibility);
    const Icon = option?.icon || Eye;
    return <Icon className="w-4 h-4" />;
  };

  const getVisibilityBadge = (visibility) => {
    switch (visibility) {
      case "public":
        return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Public</Badge>;
      case "hybrid":
        return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Hybrid</Badge>;
      default:
        return <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-200">Portal</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center min-h-[400px] ${hasBanner ? "" : "pt-6"}`}>
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className={`container max-w-5xl mx-auto py-6 px-4 ${hasBanner ? "" : "pt-6"}`}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Page Visibility Settings</h1>
          <p className="text-slate-500 mt-1">
            Control which pages are accessible to the public, portal members, or both
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saveMutation.isPending}
          className="bg-blue-600 hover:bg-blue-700"
          data-testid="button-save-visibility"
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          Save Changes
        </Button>
      </div>

      {/* Legend */}
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-6">
            {VISIBILITY_OPTIONS.map((option) => (
              <div key={option.value} className="flex items-center gap-2">
                <option.icon className="w-4 h-4 text-slate-500" />
                <span className="font-medium text-sm">{option.label}:</span>
                <span className="text-sm text-slate-500">{option.description}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          placeholder="Search pages..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
          data-testid="input-search-pages"
        />
      </div>

      {/* Pages by Category */}
      <div className="space-y-6">
        {Object.entries(groupedPages).map(([category, pages]) => (
          <Card key={category}>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">{category}</CardTitle>
              <CardDescription>
                {pages.length} page{pages.length !== 1 ? "s" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {pages.map((page) => {
                  const visibility = getVisibility(page.id);
                  return (
                    <div
                      key={page.id}
                      className="flex items-center justify-between py-3 px-4 bg-slate-50 rounded-lg"
                      data-testid={`row-page-${page.id}`}
                    >
                      <div className="flex items-center gap-3">
                        {getVisibilityIcon(visibility)}
                        <div>
                          <div className="font-medium text-slate-900">{page.name}</div>
                          <div className="text-sm text-slate-500">{page.description}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {getVisibilityBadge(visibility)}
                        <Select
                          value={visibility}
                          onValueChange={(value) => setVisibility(page.id, value)}
                        >
                          <SelectTrigger className="w-[160px]" data-testid={`select-visibility-${page.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {VISIBILITY_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                <div className="flex items-center gap-2">
                                  <option.icon className="w-4 h-4" />
                                  {option.label}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredPages.length === 0 && (
        <div className="text-center py-12 text-slate-500">
          No pages found matching "{searchQuery}"
        </div>
      )}

      {/* Info note */}
      <Card className="mt-6 bg-blue-50 border-blue-200">
        <CardContent className="py-4">
          <p className="text-sm text-blue-800">
            <strong>Note:</strong> CMS pages created via the Page Builder have their own visibility settings 
            in the Page Settings dialog. This page only controls built-in portal pages.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
