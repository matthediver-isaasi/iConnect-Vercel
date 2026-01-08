import { useState, useEffect } from "react";
import { useNavigate, Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  Building2, 
  Settings, 
  Globe, 
  CreditCard, 
  Users, 
  LogOut, 
  Loader2,
  ChevronRight,
  Palette,
  FileText
} from "lucide-react";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [tenantUser, setTenantUser] = useState(null);
  const [tenant, setTenant] = useState(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
            setTenantUser(data.tenantUser);
            setTenant(data.tenant);
          } else {
            navigate('/admin/login');
          }
        } else {
          navigate('/admin/login');
        }
      } catch (err) {
        navigate('/admin/login');
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, [navigate]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { 
        method: 'POST', 
        credentials: 'include' 
      });
    } catch (err) {
      console.log('Logout error:', err);
    }
    localStorage.removeItem('saas_admin');
    navigate('/admin/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const menuItems = [
    {
      title: "Tenant Settings",
      description: "Name, logo, and basic configuration",
      icon: Settings,
      href: "/admin/settings",
      color: "text-blue-400"
    },
    {
      title: "Domain Management",
      description: "Custom domains and subdomains",
      icon: Globe,
      href: "/admin/domains",
      color: "text-green-400"
    },
    {
      title: "Branding",
      description: "Colors, fonts, and styling",
      icon: Palette,
      href: "/admin/branding",
      color: "text-purple-400"
    },
    {
      title: "Billing",
      description: "Subscription and payment settings",
      icon: CreditCard,
      href: "/admin/billing",
      color: "text-amber-400"
    },
    {
      title: "Team",
      description: "Manage tenant administrators",
      icon: Users,
      href: "/admin/team",
      color: "text-pink-400"
    }
  ];

  return (
    <div className="min-h-screen bg-slate-900">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-white" data-testid="text-tenant-name">
                  {tenant?.name || 'Tenant Admin'}
                </h1>
                <p className="text-xs text-slate-400" data-testid="text-tenant-domain">
                  {tenant?.domain || tenant?.slug + '.iconn.app'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right hidden sm:block">
                <p className="text-sm text-white" data-testid="text-user-name">
                  {tenantUser?.first_name} {tenantUser?.last_name}
                </p>
                <p className="text-xs text-slate-400" data-testid="text-user-email">
                  {tenantUser?.email}
                </p>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleLogout}
                className="text-slate-400 hover:text-white hover:bg-slate-800"
                data-testid="button-logout"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-white" data-testid="text-dashboard-title">
            Dashboard
          </h2>
          <p className="text-slate-400 mt-1">
            Manage your tenant settings and configuration
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {menuItems.map((item) => (
            <Link 
              key={item.href} 
              to={item.href}
              className="group"
              data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <Card className="bg-slate-800/50 border-slate-700 hover:border-slate-600 hover:bg-slate-800 transition-all cursor-pointer h-full">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className={`w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center ${item.color}`}>
                      <item.icon className="h-5 w-5" />
                    </div>
                    <ChevronRight className="h-5 w-5 text-slate-600 group-hover:text-slate-400 transition-colors" />
                  </div>
                </CardHeader>
                <CardContent>
                  <CardTitle className="text-lg text-white mb-1">
                    {item.title}
                  </CardTitle>
                  <CardDescription className="text-slate-400">
                    {item.description}
                  </CardDescription>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        <div className="mt-8 p-4 rounded-lg bg-slate-800/30 border border-slate-700">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-slate-500" />
            <div>
              <p className="text-sm text-slate-300">Portal Access</p>
              <a 
                href="/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
                data-testid="link-portal"
              >
                Open member portal
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
