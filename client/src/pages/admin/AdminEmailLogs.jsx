import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { 
  Building2, 
  ArrowLeft,
  Loader2,
  Mail,
  Send,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MousePointer,
  Eye,
  RefreshCw
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

export default function AdminEmailLogs() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [tenant, setTenant] = useState(null);
  const [eventFilter, setEventFilter] = useState('all');

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          if (data.authenticated && data.tenantUser) {
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

  const { data: statsData, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['/api/tenant/email-logs'],
    enabled: !loading && !!tenant
  });

  const { data: eventsData, isLoading: eventsLoading, refetch: refetchEvents } = useQuery({
    queryKey: ['/api/tenant/email-logs', 'events', eventFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ type: 'events', limit: '50' });
      if (eventFilter && eventFilter !== 'all') {
        params.append('event', eventFilter);
      }
      const response = await fetch(`/api/tenant/email-logs?${params.toString()}`, { 
        credentials: 'include' 
      });
      if (!response.ok) throw new Error('Failed to fetch events');
      return response.json();
    },
    enabled: !loading && !!tenant
  });

  const handleRefresh = () => {
    refetchStats();
    refetchEvents();
    toast({
      title: "Refreshing",
      description: "Fetching latest email data..."
    });
  };

  const getEventBadge = (event) => {
    const variants = {
      accepted: { variant: 'default', icon: Send, label: 'Sent' },
      delivered: { variant: 'default', icon: CheckCircle2, label: 'Delivered', className: 'bg-green-500/10 text-green-400 border-green-500/20' },
      opened: { variant: 'outline', icon: Eye, label: 'Opened' },
      clicked: { variant: 'outline', icon: MousePointer, label: 'Clicked' },
      failed: { variant: 'destructive', icon: XCircle, label: 'Failed' },
      rejected: { variant: 'destructive', icon: XCircle, label: 'Rejected' },
      complained: { variant: 'destructive', icon: AlertTriangle, label: 'Complained' },
      unsubscribed: { variant: 'secondary', icon: AlertTriangle, label: 'Unsubscribed' }
    };

    const config = variants[event] || { variant: 'outline', icon: Mail, label: event };
    const Icon = config.icon;

    return (
      <Badge variant={config.variant} className={config.className}>
        <Icon className="h-3 w-3 mr-1" />
        {config.label}
      </Badge>
    );
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return '-';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const stats = statsData?.stats || {};

  return (
    <div className="min-h-screen bg-slate-900">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <Link 
                to="/admin" 
                className="text-slate-400 hover:text-white transition-colors"
                data-testid="link-back-dashboard"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Mail className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-white" data-testid="text-page-title">
                  Email Logs
                </h1>
                <p className="text-xs text-slate-400">
                  {statsData?.domain || 'Loading...'}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
              data-testid="button-refresh"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-white mb-4" data-testid="text-section-overview">
            Overview (Last 30 Days)
          </h2>
          
          {statsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : statsData?.error ? (
            <Card className="bg-slate-800/50 border-slate-700">
              <CardContent className="py-8 text-center">
                <AlertTriangle className="h-8 w-8 text-amber-400 mx-auto mb-2" />
                <p className="text-slate-400">{statsData.error}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="bg-slate-800/50 border-slate-700">
                <CardHeader className="pb-2">
                  <CardDescription className="text-slate-400">Sent</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <Send className="h-5 w-5 text-blue-400" />
                    <span className="text-2xl font-bold text-white" data-testid="stat-sent">
                      {stats.accepted || 0}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-slate-800/50 border-slate-700">
                <CardHeader className="pb-2">
                  <CardDescription className="text-slate-400">Delivered</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-400" />
                    <span className="text-2xl font-bold text-white" data-testid="stat-delivered">
                      {stats.delivered || 0}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-slate-800/50 border-slate-700">
                <CardHeader className="pb-2">
                  <CardDescription className="text-slate-400">Opened</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <Eye className="h-5 w-5 text-purple-400" />
                    <span className="text-2xl font-bold text-white" data-testid="stat-opened">
                      {stats.opened || 0}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-slate-800/50 border-slate-700">
                <CardHeader className="pb-2">
                  <CardDescription className="text-slate-400">Failed</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <XCircle className="h-5 w-5 text-red-400" />
                    <span className="text-2xl font-bold text-white" data-testid="stat-failed">
                      {stats.failed || 0}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold text-white" data-testid="text-section-events">
            Recent Events
          </h2>
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="w-40 bg-slate-800 border-slate-700 text-white" data-testid="select-event-filter">
              <SelectValue placeholder="Filter events" />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              <SelectItem value="all">All Events</SelectItem>
              <SelectItem value="accepted">Sent</SelectItem>
              <SelectItem value="delivered">Delivered</SelectItem>
              <SelectItem value="opened">Opened</SelectItem>
              <SelectItem value="clicked">Clicked</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {eventsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        ) : eventsData?.error ? (
          <Card className="bg-slate-800/50 border-slate-700">
            <CardContent className="py-8 text-center">
              <AlertTriangle className="h-8 w-8 text-amber-400 mx-auto mb-2" />
              <p className="text-slate-400">{eventsData.error}</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="bg-slate-800/50 border-slate-700">
            <Table>
              <TableHeader>
                <TableRow className="border-slate-700 hover:bg-transparent">
                  <TableHead className="text-slate-400">Status</TableHead>
                  <TableHead className="text-slate-400">Recipient</TableHead>
                  <TableHead className="text-slate-400">Subject</TableHead>
                  <TableHead className="text-slate-400">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventsData?.events?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-slate-400 py-8">
                      No email events found
                    </TableCell>
                  </TableRow>
                ) : (
                  eventsData?.events?.map((event, index) => (
                    <TableRow 
                      key={event.id || index} 
                      className="border-slate-700 hover:bg-slate-800/50"
                      data-testid={`row-event-${index}`}
                    >
                      <TableCell>{getEventBadge(event.event)}</TableCell>
                      <TableCell className="text-white font-medium">
                        {event.recipient || '-'}
                      </TableCell>
                      <TableCell className="text-slate-300 max-w-xs truncate">
                        {event.subject || '-'}
                      </TableCell>
                      <TableCell className="text-slate-400 text-sm">
                        {formatTimestamp(event.timestamp)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        )}
      </main>
    </div>
  );
}
