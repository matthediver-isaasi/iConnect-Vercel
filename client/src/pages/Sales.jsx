import { Navigate, NavLink } from "react-router-dom";
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
import { useLayoutContext } from "@/contexts/LayoutContext";
import {
  getSalesDestination,
  getVisibleSalesDestinations,
  SALES_BASE_PERMISSION,
} from "@/lib/salesNavigation";

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
};

export default function Sales({ destination = "dashboard" }) {
  const { isFeatureExcluded } = useLayoutContext();
  const current = getSalesDestination(destination);
  const visibleDestinations = getVisibleSalesDestinations(isFeatureExcluded);

  if (
    !current
    || isFeatureExcluded(SALES_BASE_PERMISSION)
    || isFeatureExcluded(current.permissionId)
  ) {
    return <Navigate to="/Preferences" replace />;
  }

  const CurrentIcon = ICONS[current.key];

  return (
    <div className="min-h-full bg-slate-50/70">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">Sales</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            {current.label}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600 sm:text-base">
            {DESCRIPTIONS[current.key]}
          </p>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:px-8">
        <nav
          aria-label="Sales navigation"
          className="flex gap-2 overflow-x-auto pb-2 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0"
        >
          {visibleDestinations.map((item) => {
            const Icon = ICONS[item.key];
            return (
              <NavLink
                key={item.key}
                to={item.path}
                className={({ isActive }) => [
                  "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-blue-600 text-white shadow-sm"
                    : "bg-white text-slate-700 hover:bg-blue-50 hover:text-blue-700 lg:bg-transparent",
                ].join(" ")}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <main>
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <CurrentIcon className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-5 text-xl font-semibold text-slate-950">{current.label}</h2>
            <p className="mt-2 max-w-xl text-slate-600">
              This area is ready for your organisation&apos;s sales data and workflows.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}