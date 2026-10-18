import { useEffect, useRef } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useSalesSettings } from "@/hooks/useSalesSettings";
import { resolveQuoteNaming, canonicalQuoteLink } from "@shared/salesNaming.js";
import {
  BarChart3,
  Boxes,
  CheckSquare,
  FileText,
  Gauge,
  Package,
  Settings,
  Target,
  TrendingUp,
} from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import NavigationRoleState from "@/components/navigation/NavigationRoleState";
import {
  getSalesDestination,
  getSalesCatalogueSection,
  SALES_BASE_PERMISSION,
} from "@/lib/salesNavigation";
import Catalogue from "./sales/Catalogue";
import OpportunitiesWorkspace from "@/components/sales/OpportunitiesWorkspace";
import QuotesWorkspace from "@/components/sales/QuotesWorkspace";
import SalesTasksWorkspace from "@/components/sales/SalesTasksWorkspace";
import { SalesDashboard, SalesReports } from "@/components/sales/SalesReportingWorkspace";

const ICONS = {
  dashboard: Gauge,
  pipeline: TrendingUp,
  opportunities: Target,
  quotes: FileText,
  products: Package,
  bundles: Boxes,
  tasks: CheckSquare,
  reports: BarChart3,
  settings: Settings,
  catalogue: Package,
};

const DESCRIPTIONS = {
  dashboard: "A shared view of your commercial activity.",
  pipeline: "Track work as it moves through your sales process.",
  opportunities: "Manage prospective commercial opportunities.",
  quotes: "Create and manage customer quotations.",
  products: "Maintain the products available to your sales team.",
  bundles: "Group products into reusable commercial bundles.",
  tasks: "Keep sales follow-ups and actions in one place.",
  reports: "Review performance across your sales operation.",
  settings: "Configure the Sales module for your organisation.",
  catalogue: "Maintain categories, prices and bundled offers.",
};

export default function Sales({ destination }) {
  // Observe the session-scoped role directly: Layout publishes its permission
  // callback in an effect, and hidden portal children still execute redirects.
  const { isFeatureExcluded, roleStatus, roleError, retryRole } = useMemberAccess();
  const settings = useSalesSettings();
  const naming = resolveQuoteNaming(settings.data);
  const location = useLocation();
  const navigate = useNavigate();
  const previous = useRef(null);
  let current = getSalesDestination(destination || location.pathname, naming);
  // A rename may arrive while an editor is dirty. Keep that same mounted
  // workspace until replacing its URL; never retain the old alias generally.
  const prior = previous.current;
  if (!current && settings.ready && prior?.scope === settings.scopeKey
      && prior.path === location.pathname && prior.current.key === 'quotes') current = prior.current;
  useEffect(() => {
    if (!settings.ready || roleStatus !== 'ready' || !current
      || isFeatureExcluded(SALES_BASE_PERMISSION) || isFeatureExcluded(current.permissionId)) return;
    if (current.key === 'quotes') {
      const full = `${location.pathname}${location.search}${location.hash}`;
      const next = canonicalQuoteLink(full, naming, prior?.naming);
      if (next !== full) navigate(next, { replace: true });
    }
    previous.current = { scope: settings.scopeKey, path: location.pathname, current, naming };
  }, [settings.ready, settings.scopeKey, naming.slug, location.pathname, location.search, location.hash, roleStatus, current?.key, navigate, isFeatureExcluded]);
  if (roleStatus !== "ready") {
    return <NavigationRoleState status={roleStatus} error={roleError} onRetry={retryRole} />;
  }

  if (
    isFeatureExcluded(SALES_BASE_PERMISSION)
    || (current && isFeatureExcluded(current.permissionId))
  ) {
    return <Navigate to="/Preferences" replace />;
  }
  // Fixed non-quote routes remain independent of naming discovery.
  if (!destination || current?.key === 'quotes') {
    if (settings.error) return <div role="alert" className="p-6">Sales settings could not be loaded. <button onClick={() => settings.refetch()}>Retry</button></div>;
    if (!settings.ready) return <p role="status" className="p-6">Loading Sales settings…</p>;
  }
  if (!current) return <div role="alert" className="p-6">Sales page not found.</div>;

  const CurrentIcon = ICONS[current.key];

  return (
    <div className="min-h-full bg-slate-50/70">
      <header className="border-b border-slate-200 bg-white">
        <div className="px-4 py-6 sm:px-6 lg:px-8">
          <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">Sales</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            {current.label}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600 sm:text-base">
            {current.key === "quotes" ? `Create and manage customer ${naming.plural}.` : DESCRIPTIONS[current.key]}
          </p>
        </div>
      </header>

      <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">
        <main className="min-w-0">
          {getSalesCatalogueSection(current.key) ? (
            <Catalogue section={getSalesCatalogueSection(current.key)} />
          ) : current.key === "tasks" ? <SalesTasksWorkspace /> : current.key === "dashboard" ? <SalesDashboard /> : current.key === "reports" ? <SalesReports /> : current.key === "quotes" ? <QuotesWorkspace /> : ["pipeline", "opportunities", "settings"].includes(current.key) ? (
            <OpportunitiesWorkspace destination={current.key} />
          ) : <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <CurrentIcon className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-5 text-xl font-semibold text-slate-950">{current.label}</h2>
            <p className="mt-2 max-w-xl text-slate-600">
              This area is ready for your organisation&apos;s sales data and workflows.
            </p>
          </section>}
        </main>
      </div>
    </div>
  );
}