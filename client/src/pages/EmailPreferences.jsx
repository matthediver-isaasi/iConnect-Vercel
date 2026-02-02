import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, CheckCircle, AlertCircle } from "lucide-react";
import PublicLayout from "@/components/layouts/PublicLayout";
import { useToast } from "@/components/ui/use-toast";

export default function EmailPreferences() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t");
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [data, setData] = useState(null);

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
          optedOutAll: result.optedOutAll
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

    setUpdating(true);
    try {
      const response = await fetch(`/api/email-preferences?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle_category",
          categoryId
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
          description: `Category preference updated successfully.`
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

  if (loading) {
    return (
      <PublicLayout currentPageName="EmailPreferences">
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" data-testid="spinner-loading" />
        </div>
      </PublicLayout>
    );
  }

  if (error) {
    return (
      <PublicLayout currentPageName="EmailPreferences">
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
      </PublicLayout>
    );
  }

  return (
    <PublicLayout currentPageName="EmailPreferences">
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
            <div className="p-4 rounded-lg border bg-muted/50">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-base font-medium">Unsubscribe from all emails</Label>
                  <p className="text-sm text-muted-foreground">
                    Turn this on to stop receiving all marketing emails from us
                  </p>
                </div>
                <Switch
                  checked={data.optedOutAll}
                  onCheckedChange={handleToggleAll}
                  disabled={updating}
                  data-testid="switch-unsubscribe-all"
                />
              </div>
            </div>

            {!data.isMember && (
              <div className="p-4 rounded-lg bg-muted text-center text-sm text-muted-foreground">
                Individual category preferences are only available for registered members.
                You can use the option above to unsubscribe from all emails.
              </div>
            )}

            {data.isMember && data.categories && data.categories.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">Communication Categories</h3>
                  {data.optedOutAll && (
                    <span className="text-xs text-muted-foreground">(disabled while unsubscribed from all)</span>
                  )}
                </div>
                <div className="space-y-3">
                  {data.categories.map((category) => (
                    <div
                      key={category.id}
                      className={`p-4 rounded-lg border ${data.optedOutAll ? "opacity-50" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                          <Label className="text-base">{category.name}</Label>
                          {category.description && (
                            <p className="text-sm text-muted-foreground">{category.description}</p>
                          )}
                        </div>
                        <Switch
                          checked={category.isSubscribed && !data.optedOutAll}
                          onCheckedChange={() => handleToggleCategory(category.id)}
                          disabled={updating || data.optedOutAll}
                          data-testid={`switch-category-${category.id}`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.isMember && (!data.categories || data.categories.length === 0) && !data.optedOutAll && (
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
    </PublicLayout>
  );
}
