import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { setActiveTenantId } from "@/api/base44Client";
import { adminFetch } from "@/lib/adminFetch";
import { ArrowLeft, Loader2, Save, RotateCcw, Globe, ExternalLink, AlertTriangle, RefreshCw, CheckCircle2 } from "lucide-react";
import { COUNTRIES } from "@/data/countries";
import { WORLD_BANK_LMIC_SOURCE } from "@shared/lmicCountries.js";

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
  const [dq, setDq] = useState(null);
  const [dqLoading, setDqLoading] = useState(true);
  const [dqError, setDqError] = useState(null);

  const loadDataQuality = async () => {
    setDqLoading(true);
    setDqError(null);
    try {
      const res = await adminFetch("/api/admin/settings/country-data-quality");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Check failed (${res.status})`);
      }
      setDq(await res.json());
    } catch (err) {
      setDqError(err.message);
    } finally {
      setDqLoading(false);
    }
  };

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
        setActiveTenantId(authData.tenant?.id);
        const res = await adminFetch("/api/admin/settings/lmic-countries");
        if (!res.ok) throw new Error(`Failed to load LMIC settings (${res.status})`);
        const data = await res.json();
        if (cancelled) return;
        setSelected(new Set((data.codes || []).map(c => c.toUpperCase())));
        loadDataQuality();
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
      const res = await adminFetch("/api/admin/settings/lmic-countries", {
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
      const res = await adminFetch("/api/admin/settings/lmic-countries?action=reset", {
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
          <div
            className="mt-3 rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground"
            data-testid="text-lmic-source"
          >
            <span className="font-medium text-foreground">Default data source:</span>{" "}
            {WORLD_BANK_LMIC_SOURCE.label} — {WORLD_BANK_LMIC_SOURCE.classification}{" "}
            (effective {WORLD_BANK_LMIC_SOURCE.effectiveDate}, based on{" "}
            {WORLD_BANK_LMIC_SOURCE.basedOn}).{" "}
            <a
              href={WORLD_BANK_LMIC_SOURCE.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
              data-testid="link-lmic-source"
            >
              View on World Bank
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
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

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" /> Unrecognised country values
              </CardTitle>
              <CardDescription>
                Stored country values the dashboard cannot match to a real
                country. Records with these values are invisible to BOTH the
                LMIC and non-LMIC widgets — fix the value on the record, or
                contact support to add it as a recognised spelling.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadDataQuality}
              disabled={dqLoading}
              data-testid="button-refresh-country-check"
            >
              {dqLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Re-run check
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {dqLoading && (
            <p className="text-sm text-muted-foreground" data-testid="text-country-check-loading">
              Checking stored country values…
            </p>
          )}
          {!dqLoading && dqError && (
            <p className="text-sm text-destructive" data-testid="text-country-check-error">
              Could not run the check: {dqError}
            </p>
          )}
          {!dqLoading && !dqError && dq && dq.issues.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-country-check-clean">
              <CheckCircle2 className="h-4 w-4" />
              All stored country values were recognised
              ({dq.scannedOrganizations} organisations and {dq.scannedMembers} members checked).
            </p>
          )}
          {!dqLoading && !dqError && dq && dq.issues.length > 0 && (
            <div className="space-y-3" data-testid="list-country-issues">
              <p className="text-sm text-muted-foreground">
                {dq.issues.length} unrecognised value{dq.issues.length === 1 ? "" : "s"} found
                across {dq.scannedOrganizations} organisations and {dq.scannedMembers} members.
              </p>
              <div className="space-y-2 max-h-[420px] overflow-auto pr-1">
                {dq.issues.map((issue, idx) => (
                  <div
                    key={`${issue.source}-${issue.fieldKey}-${issue.value}`}
                    className="rounded-md border p-3 space-y-1.5"
                    data-testid={`row-country-issue-${idx}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium" data-testid={`text-issue-value-${idx}`}>
                        "{issue.value}"
                      </span>
                      <Badge variant="secondary">{issue.fieldLabel}</Badge>
                      <Badge variant="outline" data-testid={`badge-issue-count-${idx}`}>
                        {issue.recordCount} record{issue.recordCount === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {issue.records.map(r => r.label).join(", ")}
                      {issue.recordCount > issue.records.length
                        ? ` … and ${issue.recordCount - issue.records.length} more`
                        : ""}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
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
