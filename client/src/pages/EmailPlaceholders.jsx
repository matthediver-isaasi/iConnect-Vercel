import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Search,
  Copy,
  Check,
  ListFilter,
  X,
  Code2,
  Mail,
  Eye,
  ChevronRight,
  ChevronsUpDown,
  ChevronsDownUp,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import {
  EMAIL_PLACEHOLDERS,
  PLACEHOLDER_CATEGORIES,
  PLACEHOLDER_CONTEXTS,
  PLACEHOLDER_SYNTAX,
  filterPlaceholders,
  groupPlaceholdersByCategory,
} from "@/lib/emailPlaceholders";
import {
  FIXTURE_SAMPLE_DATA,
  describeSampleSources,
  mergeSampleData,
  resolvePlaceholderPreview,
  buildCategorySample,
  labelForRecord,
  RECORD_PICKER_CATEGORIES,
  CATEGORY_LIST_KEY,
} from "@/lib/emailPlaceholderPreview";

const SYNTAX_LABEL = {
  [PLACEHOLDER_SYNTAX.CURLY]: "{{ \u2026 }}",
  [PLACEHOLDER_SYNTAX.BRACKET]: "[[ \u2026 ]]",
};

const FIXTURE_OPTION_VALUE = "__fixture__";
const STORAGE_PREFIX = "iconnect.emailPlaceholders";

function readStored(tenantId) {
  if (!tenantId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}.${tenantId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return null;
}

function writeStored(tenantId, value) {
  if (!tenantId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}.${tenantId}`, JSON.stringify(value));
  } catch {
    // ignore quota / disabled storage
  }
}

function CopyTokenButton({ token }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toast.success(`Copied ${token}`);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error("Could not copy to clipboard");
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      data-testid={`button-copy-${token}`}
      aria-label={`Copy ${token}`}
    >
      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
    </Button>
  );
}

function PlaceholderPreview({ token, sampleData }) {
  const preview = useMemo(
    () => resolvePlaceholderPreview(token, sampleData),
    [token, sampleData],
  );
  if (!preview) {
    return (
      <div
        className="flex items-start gap-2 text-xs text-muted-foreground p-2 border border-dashed rounded-md"
        data-testid={`preview-${token}`}
      >
        <Eye className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>No live preview available for this token.</span>
      </div>
    );
  }
  return (
    <div
      className="flex items-start gap-2 text-xs p-2 bg-muted/40 border rounded-md"
      data-testid={`preview-${token}`}
    >
      <Eye className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-muted-foreground mb-1">
          Resolves to {preview.kind === "html" ? "(HTML)" : preview.kind === "placeholder" ? "(example)" : ""}:
        </div>
        {preview.kind === "html" ? (
          <div
            className="text-sm break-words [&_a]:text-primary [&_a]:underline"
            data-testid={`preview-html-${token}`}
            dangerouslySetInnerHTML={{ __html: preview.value }}
          />
        ) : (
          <div
            className="text-sm break-words font-mono"
            data-testid={`preview-value-${token}`}
          >
            {preview.value}
          </div>
        )}
      </div>
    </div>
  );
}

function PlaceholderRow({ p, sampleData }) {
  const syntaxVariant = p.syntax === PLACEHOLDER_SYNTAX.CURLY ? "default" : "secondary";
  return (
    <div
      className="flex flex-col gap-2 p-3 border rounded-md hover-elevate"
      data-testid={`row-placeholder-${p.token}`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <code
            className="px-2 py-1 rounded bg-muted text-sm font-mono break-all"
            data-testid={`text-token-${p.token}`}
          >
            {p.token}
          </code>
          <Badge variant={syntaxVariant} data-testid={`badge-syntax-${p.token}`}>
            {SYNTAX_LABEL[p.syntax]}
          </Badge>
        </div>
        <CopyTokenButton token={p.token} />
      </div>
      <p className="text-sm text-foreground" data-testid={`text-description-${p.token}`}>
        {p.description}
      </p>
      <PlaceholderPreview token={p.token} sampleData={sampleData} />
      {p.prerequisites && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Requires:</span> {p.prerequisites}
        </p>
      )}
      {p.notes && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Note:</span> {p.notes}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 items-center">
        {p.contexts.map((ctx) => (
          <Badge
            key={ctx}
            variant="outline"
            className="text-xs"
            data-testid={`badge-context-${p.token}-${ctx}`}
          >
            {ctx}
          </Badge>
        ))}
      </div>
      <p className="text-xs text-muted-foreground font-mono break-all">
        <span className="font-sans font-medium">Source:</span> {p.source}
      </p>
    </div>
  );
}

function MultiSelectFilter({ label, options, selected, onChange, testIdPrefix }) {
  const isActive = selected.length > 0;
  const toggle = (value) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" data-testid={`button-filter-${testIdPrefix}`}>
          <ListFilter className="w-4 h-4 mr-2" />
          {label}
          {isActive && (
            <Badge variant="secondary" className="ml-2">
              {selected.length}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt}
            checked={selected.includes(opt)}
            onCheckedChange={() => toggle(opt)}
            onSelect={(e) => e.preventDefault()}
            data-testid={`checkbox-${testIdPrefix}-${opt}`}
          >
            {opt}
          </DropdownMenuCheckboxItem>
        ))}
        {isActive && (
          <>
            <DropdownMenuSeparator />
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => onChange([])}
              data-testid={`button-clear-${testIdPrefix}`}
            >
              <X className="w-4 h-4 mr-2" /> Clear
            </Button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DueDiligencePicker({
  selectedId,
  selectedRecord,
  onPickResult,
  onClear,
  loading,
  lookupError,
  onLookup,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [lookupValue, setLookupValue] = useState("");

  // Debounced server-side search
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("search", query.trim());
        const res = await fetch(
          `/api/admin/email-placeholder-dd-submission?${params.toString()}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          if (!cancelled) setResults([]);
          return;
        }
        const json = await res.json();
        if (!cancelled) setResults(Array.isArray(json.results) ? json.results : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  const handleLookupSubmit = async (e) => {
    e?.preventDefault?.();
    const v = lookupValue.trim();
    if (!v) return;
    await onLookup(v);
  };

  const headerLabel = selectedRecord
    ? labelForRecord("Due Diligence", selectedRecord)
    : "Built-in sample";

  return (
    <div
      className="flex flex-col gap-2 w-full md:w-[420px]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={open}
              className="flex-1 min-w-[220px] justify-between font-normal"
              data-testid="combobox-dd-submission"
            >
              <span className="truncate text-left">{headerLabel}</span>
              <ChevronsUpDown className="ml-2 w-4 h-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[420px] p-0" align="end">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search by application UID, organisation, member…"
                value={query}
                onValueChange={setQuery}
                data-testid="input-dd-search"
              />
              <CommandList>
                {/* "Built-in sample" is always available — even when search
                    returns zero rows — so admins can always reset the picker
                    to the fixture data. */}
                <CommandGroup>
                  <CommandItem
                    value="__fixture__"
                    onSelect={() => {
                      onClear();
                      setOpen(false);
                    }}
                    data-testid="option-dd-submission-fixture"
                  >
                    <span className="text-muted-foreground">Built-in sample</span>
                  </CommandItem>
                </CommandGroup>
                {searching ? (
                  <div className="py-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
                  </div>
                ) : results.length === 0 ? (
                  <CommandEmpty>No submissions match.</CommandEmpty>
                ) : (
                  <CommandGroup heading="Recent">
                    {results.map((r) => (
                      <CommandItem
                        key={r.id}
                        value={r.id}
                        onSelect={async () => {
                          await onPickResult(r);
                          setOpen(false);
                        }}
                        data-testid={`option-dd-submission-${r.id}`}
                      >
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="text-sm font-medium truncate">
                            {r.application_uid || r.id}
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {[r.form_name, r.organization_name || r.member_name, r.status]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {selectedId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            data-testid="button-dd-submission-clear"
          >
            <X className="w-4 h-4 mr-1" /> Clear
          </Button>
        )}
      </div>
      <form onSubmit={handleLookupSubmit} className="flex items-center gap-2">
        <Input
          value={lookupValue}
          onChange={(e) => setLookupValue(e.target.value)}
          placeholder="Look up by application UID or submission id"
          className="h-9 flex-1"
          data-testid="input-dd-submission-lookup"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={loading || !lookupValue.trim()}
          data-testid="button-dd-submission-lookup"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load"}
        </Button>
      </form>
      {selectedRecord && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="text-dd-current-submission"
        >
          Currently using:{" "}
          <span className="text-foreground font-medium">
            {selectedRecord.submission?.application_uid || selectedRecord.id}
          </span>
          {selectedRecord.form_name ? ` — ${selectedRecord.form_name}` : ""}
          {selectedRecord._bundle?.organization?.name
            ? ` · ${selectedRecord._bundle.organization.name}`
            : ""}
          {selectedRecord._bundle?.member?.full_name
            ? ` · ${selectedRecord._bundle.member.full_name}`
            : ""}
        </div>
      )}
      {lookupError && (
        <div
          className="flex items-start gap-1.5 text-xs text-destructive"
          data-testid="text-dd-lookup-error"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{lookupError}</span>
        </div>
      )}
    </div>
  );
}

function CategoryRecordPicker({ category, list, selectedId, onChange }) {
  if (!list || list.length === 0) {
    return (
      <span
        className="text-xs text-muted-foreground"
        data-testid={`label-fixture-${category}`}
      >
        Using built-in sample
      </span>
    );
  }
  const value = selectedId || FIXTURE_OPTION_VALUE;
  return (
    <div
      className="flex items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-xs text-muted-foreground hidden sm:inline">Sample:</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className="h-8 w-[240px] max-w-[60vw]"
          data-testid={`select-sample-${category}`}
        >
          <SelectValue placeholder="Built-in sample" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value={FIXTURE_OPTION_VALUE}
            data-testid={`option-sample-${category}-fixture`}
          >
            Built-in sample
          </SelectItem>
          {list.map((record) => {
            const id = String(record.id ?? "");
            if (!id) return null;
            return (
              <SelectItem
                key={id}
                value={id}
                data-testid={`option-sample-${category}-${id}`}
              >
                {labelForRecord(category, record)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function EmailPlaceholders() {
  const navigate = useNavigate();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState([]);
  const [contexts, setContexts] = useState([]);
  const [syntax, setSyntax] = useState("all");
  const [sampleData, setSampleData] = useState(FIXTURE_SAMPLE_DATA);
  const [tenantId, setTenantId] = useState(null);
  const [recordSelections, setRecordSelections] = useState({});
  const [openSections, setOpenSections] = useState({});
  // Map of dd submission id -> full bundle returned by
  // /api/admin/email-placeholder-dd-submission. Looked-up submissions live
  // here (since they're not in the 25-row "recent" list) so findRecord can
  // resolve them just like a list-picked record.
  const [ddBundles, setDdBundles] = useState({});
  const [ddLoading, setDdLoading] = useState(false);
  const [ddLookupError, setDdLookupError] = useState(null);
  // Track which tenant the in-memory selections were hydrated from. When the
  // tenant id changes (e.g. cross-tenant navigation in a single SPA session)
  // we must drop the previous tenant's prefs and reload from its own key.
  const [hydratedTenantId, setHydratedTenantId] = useState(null);

  useEffect(() => {
    if (!isAccessReady) return;
    if (isFeatureExcluded("page_EmailPlaceholders")) {
      navigate(createPageUrl("Events"));
      return;
    }
    setAccessChecked(true);
  }, [isAccessReady, isFeatureExcluded, navigate]);

  useEffect(() => {
    if (!accessChecked) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/email-placeholder-samples", {
          credentials: "include",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setSampleData(mergeSampleData(json));
        if (json?.tenantId) setTenantId(json.tenantId);
      } catch (err) {
        console.warn("[EmailPlaceholders] Could not load sample data:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessChecked]);

  // Hydrate per-tenant preferences when we first learn the tenant id and any
  // time it changes (e.g. switching tenants in a single SPA session). When it
  // changes we drop the previous tenant's selections before loading the new
  // ones so nothing leaks across tenants.
  useEffect(() => {
    if (!tenantId || tenantId === hydratedTenantId) return;
    const stored = readStored(tenantId);
    const selections =
      stored && typeof stored.recordSelections === "object" ? stored.recordSelections : {};
    setRecordSelections(selections);
    setOpenSections(
      stored && typeof stored.openSections === "object" ? stored.openSections : {},
    );
    setDdBundles({});
    setDdLookupError(null);
    setHydratedTenantId(tenantId);

    // Re-fetch the previously selected DD submission bundle (if any) so that
    // a page reload preserves not just the id but the full org/member/values
    // payload it depends on.
    const ddId = selections["Due Diligence"];
    if (ddId) {
      (async () => {
        try {
          const res = await fetch(
            `/api/admin/email-placeholder-dd-submission?lookup=${encodeURIComponent(ddId)}`,
            { credentials: "include" },
          );
          if (!res.ok) return;
          const json = await res.json();
          if (json?.submission) {
            setDdBundles((prev) => ({ ...prev, [json.submission.id]: json.submission }));
          }
        } catch {
          // ignore — selection will fall back to fixture
        }
      })();
    }
  }, [tenantId, hydratedTenantId]);

  // Persist preferences for the currently-hydrated tenant only. Skipping when
  // the tenant id has not yet been hydrated avoids writing the previous
  // tenant's state under the new tenant's storage key.
  useEffect(() => {
    if (!tenantId || tenantId !== hydratedTenantId) return;
    writeStored(tenantId, { recordSelections, openSections });
  }, [tenantId, hydratedTenantId, recordSelections, openSections]);

  const filtered = useMemo(() => {
    return filterPlaceholders(EMAIL_PLACEHOLDERS, {
      search,
      categories,
      contexts,
      syntax: syntax === "all" ? null : syntax,
    });
  }, [search, categories, contexts, syntax]);

  const grouped = useMemo(() => groupPlaceholdersByCategory(filtered), [filtered]);

  // The "active" Due Diligence bundle (if any) — exposed as `_dd_active_bundle`
  // on the sample so any section's resolver (not just Due Diligence) can pull
  // {{<field_id>}}, {{<field_label>}}, {{record.<field>}} from it. Form
  // Submissions in particular needs this so its pattern tokens reflect the
  // picked DD submission.
  const globalSample = useMemo(() => {
    const ddId = recordSelections["Due Diligence"];
    const bundle = ddId ? ddBundles[ddId] : null;
    if (!bundle?._bundle) return sampleData;
    return {
      ...sampleData,
      _dd_active_bundle: {
        formValues: bundle._bundle.formValues,
        formFields: bundle._bundle.formFields,
        ddRecord: bundle,
        submission: bundle.submission,
        formName: bundle.form_name,
      },
    };
  }, [sampleData, recordSelections, ddBundles]);

  const totalCount = EMAIL_PLACEHOLDERS.length;
  const filteredCount = filtered.length;
  const hasActiveFilters =
    search.trim() !== "" || categories.length > 0 || contexts.length > 0 || syntax !== "all";

  const clearAll = () => {
    setSearch("");
    setCategories([]);
    setContexts([]);
    setSyntax("all");
  };

  const handleRecordChange = useCallback((category, value) => {
    setRecordSelections((prev) => {
      const next = { ...prev };
      if (!value || value === FIXTURE_OPTION_VALUE) {
        delete next[category];
      } else {
        next[category] = value;
      }
      return next;
    });
  }, []);

  const handleDdLookup = useCallback(async (lookupValue) => {
    setDdLoading(true);
    setDdLookupError(null);
    try {
      const res = await fetch(
        `/api/admin/email-placeholder-dd-submission?lookup=${encodeURIComponent(lookupValue)}`,
        { credentials: "include" },
      );
      if (res.status === 404) {
        setDdLookupError(
          `No Due Diligence submission found for "${lookupValue}". Check the application UID or submission id.`,
        );
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDdLookupError(body?.error || `Lookup failed (${res.status}).`);
        return;
      }
      const json = await res.json();
      if (!json?.submission) {
        setDdLookupError("Lookup returned no submission.");
        return;
      }
      const bundle = json.submission;
      setDdBundles((prev) => ({ ...prev, [bundle.id]: bundle }));
      setRecordSelections((prev) => ({ ...prev, "Due Diligence": bundle.id }));
    } catch (err) {
      setDdLookupError(err?.message || "Lookup failed.");
    } finally {
      setDdLoading(false);
    }
  }, []);

  const handleDdPickResult = useCallback(async (result) => {
    if (!result?.id) return;
    setDdLookupError(null);
    if (ddBundles[result.id]) {
      setRecordSelections((prev) => ({ ...prev, "Due Diligence": result.id }));
      return;
    }
    await handleDdLookup(result.id);
  }, [ddBundles, handleDdLookup]);

  const handleDdClear = useCallback(() => {
    setDdLookupError(null);
    setRecordSelections((prev) => {
      const next = { ...prev };
      delete next["Due Diligence"];
      return next;
    });
  }, []);

  const setSectionOpen = useCallback((category, open) => {
    setOpenSections((prev) => ({ ...prev, [category]: open }));
  }, []);

  const expandAll = () => {
    const next = {};
    for (const c of PLACEHOLDER_CATEGORIES) next[c] = true;
    setOpenSections(next);
  };

  const collapseAll = () => {
    const next = {};
    for (const c of PLACEHOLDER_CATEGORIES) next[c] = false;
    setOpenSections(next);
  };

  const findRecord = useCallback(
    (category, id) => {
      // For Due Diligence we prefer the looked-up full bundle (which carries
      // the linked org/member/meeting/values) over the stripped-down 25-row
      // recent list returned by the samples endpoint.
      if (category === "Due Diligence" && ddBundles[id]) {
        return ddBundles[id];
      }
      const listKey = CATEGORY_LIST_KEY[category];
      if (!listKey) return null;
      const list = sampleData?.[listKey];
      if (!Array.isArray(list)) return null;
      return list.find((r) => String(r.id) === String(id)) || null;
    },
    [sampleData, ddBundles],
  );

  // For the live-preview header summary: the picker categories that currently
  // have an explicit (non-fixture) record selected AND are still visible
  // after the active filters (so we don't advertise selections for sections
  // the user has filtered out of view).
  const selectedSummaries = useMemo(() => {
    const visibleCategories = new Set(Object.keys(grouped));
    const out = [];
    for (const category of RECORD_PICKER_CATEGORIES) {
      if (!visibleCategories.has(category)) continue;
      const id = recordSelections[category];
      if (!id) continue;
      const record = findRecord(category, id);
      if (!record) continue;
      out.push({ category, label: labelForRecord(category, record) });
    }
    return out;
  }, [recordSelections, findRecord, grouped]);

  if (!accessChecked) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center shrink-0">
            <Mail className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold" data-testid="text-page-title">
              Email Placeholders
            </h1>
            <p className="text-sm text-muted-foreground">
              Reference of every placeholder token recognised by iConnect email channels.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => navigate(createPageUrl("EmailTemplateManagement"))}
          data-testid="button-open-templates"
        >
          <Mail className="w-4 h-4 mr-2" /> Email Templates
        </Button>
      </div>

      <Card data-testid="card-sample-data">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="w-4 h-4" /> Live preview
          </CardTitle>
          <CardDescription data-testid="text-sample-source">
            Each placeholder shows what it would resolve to. {describeSampleSources(sampleData)}{" "}
            Use the dropdown in any section header to switch which record drives that section's
            previews.
          </CardDescription>
        </CardHeader>
        {selectedSummaries.length > 0 && (
          <CardContent className="pt-0">
            <div
              className="flex flex-wrap items-center gap-2 text-xs"
              data-testid="container-selected-records"
            >
              <span className="text-muted-foreground">Currently using:</span>
              {selectedSummaries.map(({ category, label }) => (
                <Badge
                  key={category}
                  variant="secondary"
                  data-testid={`badge-selected-${category}`}
                  className="max-w-[280px] truncate inline-block"
                  title={`${category}: ${label}`}
                >
                  <span className="font-medium">{category}:</span>
                  <span className="ml-1">{label}</span>
                </Badge>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      <Card data-testid="card-syntax-legend">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Code2 className="w-4 h-4" /> Syntax legend
          </CardTitle>
          <CardDescription>iConnect email templates support two placeholder syntaxes.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="p-3 border rounded-md">
            <div className="flex items-center gap-2 mb-1">
              <Badge>{"{{ \u2026 }}"}</Badge>
              <span className="text-sm font-medium">Workflow / form-field tokens</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Resolved at email-send time from the workflow trigger entity, form submission values
              or specially handled values like <code className="font-mono">{`{{set_password_url}}`}</code>.
            </p>
          </div>
          <div className="p-3 border rounded-md">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="secondary">{"[[ \u2026 ]]"}</Badge>
              <span className="text-sm font-medium">Core database lookups</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Resolved against well-known entities (<code className="font-mono">member.*</code>,
              <code className="font-mono"> organization.*</code>, <code className="font-mono">event.*</code>,
              <code className="font-mono"> booking.*</code>, etc.).
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center flex-wrap">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by token, description, source\u2026"
                className="pl-9"
                data-testid="input-search"
              />
            </div>
            <MultiSelectFilter
              label="Category"
              options={PLACEHOLDER_CATEGORIES}
              selected={categories}
              onChange={setCategories}
              testIdPrefix="category"
            />
            <MultiSelectFilter
              label="Context"
              options={PLACEHOLDER_CONTEXTS}
              selected={contexts}
              onChange={setContexts}
              testIdPrefix="context"
            />
            <Tabs value={syntax} onValueChange={setSyntax}>
              <TabsList>
                <TabsTrigger value="all" data-testid="tab-syntax-all">All</TabsTrigger>
                <TabsTrigger value={PLACEHOLDER_SYNTAX.CURLY} data-testid="tab-syntax-curly">
                  {"{{ }}"}
                </TabsTrigger>
                <TabsTrigger value={PLACEHOLDER_SYNTAX.BRACKET} data-testid="tab-syntax-bracket">
                  {"[[ ]]"}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {hasActiveFilters && (
              <Button variant="ghost" onClick={clearAll} data-testid="button-clear-filters">
                <X className="w-4 h-4 mr-2" /> Clear filters
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" data-testid="text-result-count">
              Showing {filteredCount} of {totalCount} placeholders
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={expandAll}
                data-testid="button-expand-all"
              >
                <ChevronsUpDown className="w-4 h-4 mr-2" /> Expand all
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={collapseAll}
                data-testid="button-collapse-all"
              >
                <ChevronsDownUp className="w-4 h-4 mr-2" /> Collapse all
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground" data-testid="text-empty">
            No placeholders match your filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {grouped.map(({ category, items }) => {
            const isOpen = openSections[category] ?? false;
            const showsPicker = RECORD_PICKER_CATEGORIES.includes(category);
            const listKey = CATEGORY_LIST_KEY[category];
            const list = listKey ? sampleData?.[listKey] || [] : [];
            const selectedId = recordSelections[category] || null;
            const sectionRecord = selectedId ? findRecord(category, selectedId) : null;
            const sectionSample = sectionRecord
              ? buildCategorySample(globalSample, category, sectionRecord)
              : buildCategorySample(globalSample, category, null);

            return (
              <Card key={category} data-testid={`card-category-${category}`}>
                <Collapsible
                  open={isOpen}
                  onOpenChange={(open) => setSectionOpen(category, open)}
                >
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-md p-1 -m-1 hover-elevate"
                          data-testid={`trigger-collapse-${category}`}
                          aria-expanded={isOpen}
                        >
                          <ChevronRight
                            className={`w-4 h-4 shrink-0 transition-transform ${
                              isOpen ? "rotate-90" : ""
                            }`}
                          />
                          <CardTitle className="text-lg">{category}</CardTitle>
                          <Badge variant="outline" className="ml-1">
                            {items.length}
                          </Badge>
                        </button>
                      </CollapsibleTrigger>
                      {showsPicker && category === "Due Diligence" && (
                        <DueDiligencePicker
                          selectedId={selectedId}
                          selectedRecord={sectionRecord}
                          loading={ddLoading}
                          lookupError={ddLookupError}
                          onPickResult={handleDdPickResult}
                          onClear={handleDdClear}
                          onLookup={handleDdLookup}
                        />
                      )}
                      {showsPicker && category !== "Due Diligence" && (
                        <CategoryRecordPicker
                          category={category}
                          list={list}
                          selectedId={selectedId}
                          onChange={(value) => handleRecordChange(category, value)}
                        />
                      )}
                    </div>
                  </CardHeader>
                  <CollapsibleContent>
                    <CardContent className="space-y-2">
                      {items.map((p) => (
                        <PlaceholderRow
                          key={`${p.category}-${p.token}`}
                          p={p}
                          sampleData={sectionSample}
                        />
                      ))}
                    </CardContent>
                  </CollapsibleContent>
                </Collapsible>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
