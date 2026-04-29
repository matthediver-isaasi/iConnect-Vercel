import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { ArrowLeft, Loader2, Save, RotateCcw, Globe } from "lucide-react";
import { COUNTRIES } from "@/data/countries";

/**
 * Admin LMIC country list (task #607).
 *
 * Lets a tenant admin curate the list of country ISO-2 codes considered
 * "LMIC" for dashboard widget filtering. The page seeds the World Bank
 * default on first load (handled server-side) so admins always start with
 * a sensible baseline they can trim or extend.
 */
export default function AdminLmicCountries() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const authRes = await fetch("/api/auth/tenant-user-me", { credentials: "include" });
        if (!authRes.ok) {
          navigate("/admin/login");
          return;
        }
        const authData = await authRes.json();
        if (!authData.authenticated) {
          navigate("/admin/login");
          return;
        }
        const res = await fetch("/api/admin/settings/lmic-countries", { credentials: "include" });
        if (!res.ok) throw new Error(`Failed to load LMIC settings (${res.status})`);
        const data = await res.json();
        if (cancelled) return;
        setSelected(new Set((data.codes || []).map(c => c.toUpperCase())));
      } catch (err) {
        if (!cancelled) {
          toast({
            title: "Could not load LMIC settings",
            description: err.message,
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [navigate, toast]);

  const filteredCountries = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return COUNTRIES;
    return COUNTRIES.filter(
      c =>
        c.name.toLowerCase().includes(needle) ||
        c.code.toLowerCase().includes(needle),
    );
  }, [search]);

  const toggle = code => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev);
      filteredCountries.forEach(c => next.add(c.code));
      return next;
    });
  };

  const clearAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev);
      filteredCountries.forEach(c => next.delete(c.code));
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/lmic-countries", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: Array.from(selected) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      const data = await res.json();
      setSelected(new Set((data.codes || []).map(c => c.toUpperCase())));
      toast({ title: "LMIC list saved", description: `${(data.codes || []).length} countries selected.` });
    } catch (err) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm("Replace your LMIC list with the World Bank default?")) return;
    setResetting(true);
    try {
      const res = await fetch("/api/admin/settings/lmic-countries?action=reset", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Reset failed (${res.status})`);
      }
      const data = await res.json();
      setSelected(new Set((data.codes || []).map(c => c.toUpperCase())));
      toast({ title: "Reset to World Bank default", description: `${(data.codes || []).length} countries selected.` });
    } catch (err) {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild data-testid="button-back-admin">
            <Link to="/admin/dashboard"><ArrowLeft /></Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Globe className="h-5 w-5" /> LMIC Country List
            </h1>
            <p className="text-sm text-muted-foreground">
              Countries flagged as Low- and Middle-Income for dashboard filtering.
            </p>
          </div>
        </div>
        <Badge variant="secondary" data-testid="badge-selected-count">
          {selected.size} selected
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Manage LMIC countries</CardTitle>
          <CardDescription>
            Tick or untick countries to update the list used by the
            dashboard widget builder's "LMIC only" filter. The default is
            the World Bank low/lower-middle/upper-middle income classification.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search countries…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="max-w-sm"
              data-testid="input-search-countries"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={selectAllVisible}
              data-testid="button-select-visible"
            >
              Select shown
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearAllVisible}
              data-testid="button-clear-visible"
            >
              Clear shown
            </Button>
          </div>

          <div
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-[480px] overflow-auto rounded-md border p-3"
            data-testid="list-countries"
          >
            {filteredCountries.map(country => {
              const checked = selected.has(country.code);
              return (
                <label
                  key={country.code}
                  className="flex items-center gap-2 p-2 rounded-md hover-elevate cursor-pointer"
                  data-testid={`row-country-${country.code}`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(country.code)}
                    data-testid={`checkbox-country-${country.code}`}
                  />
                  <span className="text-sm flex-1">{country.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {country.code}
                  </span>
                </label>
              );
            })}
            {filteredCountries.length === 0 && (
              <p className="text-sm text-muted-foreground col-span-full p-4 text-center">
                No countries match "{search}".
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleReset}
          disabled={resetting || saving}
          data-testid="button-reset-lmic"
        >
          {resetting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
          Reset to World Bank default
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving || resetting}
          data-testid="button-save-lmic"
        >
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
