import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, CheckCircle, AlertCircle } from "lucide-react";
import PublicLayout from "@/components/layouts/PublicLayout";
import { useToast } from "@/components/ui/use-toast";
import { publicClient } from "@/api/publicClient";
import {
  getEmailPreferenceControlState,
  getGlobalEmailPreferenceControlState,
} from "@/lib/emailPreferenceControlState";

export default function EmailPreferences() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t");
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [data, setData] = useState(null);
  const [blankPage, setBlankPage] = useState(false);
  const [layoutResolved, setLayoutResolved] = useState(false);

  useEffect(() => {
    const fetchBlankPageSetting = async () => {
      try {
        const setting = await publicClient.getSystemSetting('email_preferences_blank_page');
        if (setting?.setting_value === 'true') {
          setBlankPage(true);
        }
      } catch (e) {
        // ignore - default to showing with layout
      } finally {
        setLayoutResolved(true);
      }
    };
    fetchBlankPageSetting();
  }, []);

  useEffect(() => {
    if (!token) {
      setError("Invalid link - no token provided");
      setLoading(false);
      return;
    }

    fetchPreferences();
  }, [token]);

  const fetchPreferences = async () => {
    try {
      const response = await fetch(`/api/email-preferences?t=${encodeURIComponent(token)}`);
      const result = await response.json();

      if (!result.success) {
        setError(result.error || "Failed to load preferences");
        return;
      }

      setData(result);
    } catch (err) {
      console.error("Error fetching preferences:", err);
      setError("Failed to load preferences");
    } finally {
      setLoading(false);
    }
  };

  const handleToggleAll = async () => {
    if (!data) return;
    
    setUpdating(true);
    try {
      const response = await fetch(`/api/email-preferences?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle_all",
          optOutAll: !data.optedOutAll
        })
      });

      const result = await response.json();

      if (result.success) {
        setData(prev => ({
          ...prev,
          optedOutAll: result.optedOutAll,
          categories: result.categories || prev.categories
        }));
        toast({
          title: result.optedOutAll ? "Unsubscribed from all emails" : "Re-subscribed to emails",
          description: result.optedOutAll 
            ? "You will no longer receive marketing emails from us."
            : "You can now manage your category preferences below."
        });
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: result.error || "Failed to update preferences"
        });
      }
    } catch (err) {
      console.error("Error updating preferences:", err);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update preferences"
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleToggleCategory = async (categoryId) => {
    if (!data || data.optedOutAll) return;
    const category = data.categories?.find((item) => item.id === categoryId);
    if (!category) return;

    setUpdating(true);
    try {
      const response = await fetch(`/api/email-preferences?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_category_subscription",
          categoryId,
          isSubscribed: !category.isSubscribed
        })
      });

      const result = await response.json();

      if (result.success) {
        setData(prev => ({
          ...prev,
          categories: prev.categories.map(cat =>
            cat.id === categoryId ? { ...cat, isSubscribed: result.isSubscribed } : cat
          )
        }));
        toast({
          title: result.isSubscribed ? "Subscribed" : "Unsubscribed",
          description: result.isSubscribed
            ? "Category preference updated successfully."
            : "You will no longer receive emails in this category."
        });
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: result.error || "Failed to update category preference"
        });
      }
    } catch (err) {
      console.error("Error updating category:", err);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update category preference"
      });
    } finally {
      setUpdating(false);
    }
  };

  if (!layoutResolved) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" data-testid="spinner-loading" />
      </div>
    );
  }

  const Wrapper = ({ children }) => {
    if (blankPage) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-background">
          {children}
        </div>
      );
    }
    return (
      <PublicLayout currentPageName="EmailPreferences">
        {children}
      </PublicLayout>
    );
  };

  if (loading) {
    return (
      <Wrapper>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" data-testid="spinner-loading" />
        </div>
      </Wrapper>
    );
  }

  if (error) {
    return (
      <Wrapper>
        <div className="container max-w-lg mx-auto py-12 px-4">
          <Card>
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
                <h2 className="text-xl font-semibold">Unable to Load Preferences</h2>
                <p className="text-muted-foreground">{error}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </Wrapper>
    );
  }

  const globalState = getGlobalEmailPreferenceControlState({
    optedOutAll: data.optedOutAll,
    updating,
  });

  return (
    <Wrapper>
      <div className="container max-w-2xl mx-auto py-12 px-4">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="h-6 w-6 text-primary" />
            </div>
            <CardTitle data-testid="text-page-title">Email Preferences</CardTitle>
            <CardDescription>
              {data.firstName && <span>Hi {data.firstName}, </span>}
              Manage your email communication preferences for <strong>{data.email}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className={`p-4 rounded-lg border ${globalState.cardClassName}`}>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="unsubscribe-all" className="text-base font-medium">Stop all marketing emails</Label>
                  <p className="text-sm font-semibold" role="status">{globalState.status}</p>
                  <p className="text-sm opacity-80">{globalState.guidance}</p>
                </div>
                <Switch
                  id="unsubscribe-all"
                  checked={globalState.checked}
                  onCheckedChange={handleToggleAll}
                  disabled={globalState.disabled}
                  aria-label="Stop all marketing emails"
                  data-testid="switch-unsubscribe-all"
                />
              </div>
            </div>

            {data.categories && data.categories.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">Communication Categories</h3>
                  {data.optedOutAll && (
                    <span className="text-xs text-red-800">(category controls are locked while all emails are stopped)</span>
                  )}
                </div>
                <div className="space-y-3">
                  {data.categories.map((category) => {
                    const categoryState = getEmailPreferenceControlState({
                      optedOutAll: data.optedOutAll,
                      categoryIsSubscribed: category.isSubscribed,
                      updating,
                    });
                    return (
                    <div
                      key={category.id}
                      className={`p-4 rounded-lg border ${categoryState.cardClassName}`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                          <Label htmlFor={`category-${category.id}`} className="text-base">{category.name}</Label>
                          <p className="text-sm font-semibold" role="status">{categoryState.status}</p>
                          {category.description && (
                            <p className="text-sm text-muted-foreground">{category.description}</p>
                          )}
                          <p className="text-sm opacity-80">{categoryState.guidance}</p>
                        </div>
                        <Switch
                          id={`category-${category.id}`}
                          checked={categoryState.checked}
                          onCheckedChange={() => handleToggleCategory(category.id)}
                          disabled={categoryState.disabled}
                          aria-label={`${category.name} emails`}
                          data-testid={`switch-category-${category.id}`}
                        />
                      </div>
                    </div>
                  )})}
                </div>
              </div>
            )}

            {(!data.categories || data.categories.length === 0) && !data.optedOutAll && (
              <div className="text-center py-8 text-muted-foreground">
                <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-500" />
                <p>No specific categories to configure.</p>
                <p className="text-sm">You can use the option above to unsubscribe from all emails.</p>
              </div>
            )}

            {updating && (
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Updating preferences...</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Wrapper>
  );
}
