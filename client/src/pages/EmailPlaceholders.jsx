import { useEffect, useMemo, useState } from "react";
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
import { Search, Copy, Check, ListFilter, X, Code2, Mail } from "lucide-react";
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

const SYNTAX_LABEL = {
  [PLACEHOLDER_SYNTAX.CURLY]: "{{ \u2026 }}",
  [PLACEHOLDER_SYNTAX.BRACKET]: "[[ \u2026 ]]",
};

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

function PlaceholderRow({ p }) {
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

export default function EmailPlaceholders() {
  const navigate = useNavigate();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState([]);
  const [contexts, setContexts] = useState([]);
  const [syntax, setSyntax] = useState("all"); // 'all' | 'curly' | 'bracket'

  useEffect(() => {
    if (!isAccessReady) return;
    if (isFeatureExcluded("page_EmailPlaceholders")) {
      navigate(createPageUrl("Events"));
      return;
    }
    setAccessChecked(true);
  }, [isAccessReady, isFeatureExcluded, navigate]);

  const filtered = useMemo(() => {
    return filterPlaceholders(EMAIL_PLACEHOLDERS, {
      search,
      categories,
      contexts,
      syntax: syntax === "all" ? null : syntax,
    });
  }, [search, categories, contexts, syntax]);

  const grouped = useMemo(() => groupPlaceholdersByCategory(filtered), [filtered]);

  const totalCount = EMAIL_PLACEHOLDERS.length;
  const filteredCount = filtered.length;
  const hasActiveFilters = search.trim() !== "" || categories.length > 0 || contexts.length > 0 || syntax !== "all";

  const clearAll = () => {
    setSearch("");
    setCategories([]);
    setContexts([]);
    setSyntax("all");
  };

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
          <p className="text-sm text-muted-foreground" data-testid="text-result-count">
            Showing {filteredCount} of {totalCount} placeholders
          </p>
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
          {grouped.map(({ category, items }) => (
            <Card key={category} data-testid={`card-category-${category}`}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-lg">{category}</CardTitle>
                  <Badge variant="outline">{items.length}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {items.map((p) => (
                  <PlaceholderRow key={`${p.category}-${p.token}`} p={p} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
