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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { 
  Building2, 
  ArrowLeft,
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Calendar,
  Timer,
  Minus,
  Bell,
  Hourglass,
  Mail,
  User,
  FileText
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

export default function AdminScheduledTasks() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [tenant, setTenant] = useState(null);
  const [taskFilter, setTaskFilter] = useState('all');
  const [activeTab, setActiveTab] = useState('pending');

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

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ['/api/admin/scheduled-task-logs', taskFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '100' });
      if (taskFilter && taskFilter !== 'all') {
        params.append('task_name', taskFilter);
      }
      const response = await fetch(`/api/admin/scheduled-task-logs?${params.toString()}`, { 
        credentials: 'include' 
      });
      if (!response.ok) throw new Error('Failed to fetch logs');
      return response.json();
    },
    enabled: !loading && !!tenant
  });

  const { data: pendingData, isLoading: pendingLoading, refetch: refetchPending } = useQuery({
    queryKey: ['/api/admin/pending-scheduled-jobs'],
    queryFn: async () => {
      const response = await fetch('/api/admin/pending-scheduled-jobs', { 
        credentials: 'include' 
      });
      if (!response.ok) throw new Error('Failed to fetch pending jobs');
      return response.json();
    },
    enabled: !loading && !!tenant
  });

  const handleRefresh = () => {
    refetchLogs();
    refetchPending();
    toast({
      title: "Refreshing",
      description: "Fetching latest scheduled task data..."
    });
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'success':
        return <Badge variant="outline" className="text-green-600 border-green-300"><CheckCircle2 className="w-3 h-3 mr-1" />Success</Badge>;
      case 'failed':
        return <Badge variant="outline" className="text-red-600 border-red-300"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
      case 'partial':
        return <Badge variant="outline" className="text-amber-600 border-amber-300"><AlertTriangle className="w-3 h-3 mr-1" />Partial</Badge>;
      case 'no_action':
        return <Badge variant="outline" className="text-slate-500"><Minus className="w-3 h-3 mr-1" />No Action</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getTypeBadge = (type) => {
    if (type === 'timeout') {
      return <Badge variant="outline" className="text-red-600 border-red-300"><Hourglass className="w-3 h-3 mr-1" />Timeout</Badge>;
    }
    return <Badge variant="outline" className="text-blue-600 border-blue-300"><Bell className="w-3 h-3 mr-1" />Reminder</Badge>;
  };

  const formatDuration = (ms) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <div className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-4">
              <Link to="/admin">
                <Button variant="ghost" size="icon" data-testid="button-back-admin">
                  <ArrowLeft className="w-5 h-5" />
                </Button>
              </Link>
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-slate-500" />
                <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Scheduled Tasks</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {tenant && (
                <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                  <Building2 className="w-4 h-4" />
                  <span>{tenant.name}</span>
                </div>
              )}
              <Button variant="outline" size="sm" onClick={handleRefresh} data-testid="button-refresh-logs">
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid gap-6 md:grid-cols-2 mb-8">
          {logsData?.schedule?.map((task) => (
            <Card key={task.task_name} data-testid={`card-schedule-${task.task_name}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base font-medium">{task.display_name}</CardTitle>
                  <Badge variant="outline" className="font-mono text-xs">
                    <Calendar className="w-3 h-3 mr-1" />
                    {task.schedule}
                  </Badge>
                </div>
                <CardDescription className="text-sm">
                  {task.description}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList data-testid="tabs-scheduled-tasks">
            <TabsTrigger value="pending" data-testid="tab-pending">
              Pending Jobs
              {pendingData?.summary?.will_send_next_run > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {pendingData.summary.will_send_next_run}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              Execution History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="pending">
            <Card data-testid="card-pending-jobs">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <CardTitle>Pending Jobs</CardTitle>
                    <CardDescription>Contracts queued for timeout notifications or reminders</CardDescription>
                  </div>
                  {pendingData?.summary && (
                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-1">
                        <Hourglass className="w-4 h-4 text-red-500" />
                        <span className="text-slate-600 dark:text-slate-400">{pendingData.summary.timeouts} timeouts</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Bell className="w-4 h-4 text-blue-500" />
                        <span className="text-slate-600 dark:text-slate-400">{pendingData.summary.reminders} reminders</span>
                      </div>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {pendingLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                  </div>
                ) : !pendingData?.pending_jobs?.length ? (
                  <div className="text-center py-12 text-slate-500">
                    <CheckCircle2 className="w-12 h-12 mx-auto mb-4 text-green-300" />
                    <p className="text-lg font-medium">No pending jobs</p>
                    <p className="text-sm mt-1">All contracts are up to date</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Type</TableHead>
                          <TableHead>Contract</TableHead>
                          <TableHead>Organization</TableHead>
                          <TableHead>Signers</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Details</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingData.pending_jobs.map((job, index) => (
                          <TableRow key={`${job.contract_id}-${job.type}-${index}`} data-testid={`row-pending-${job.contract_id}-${job.type}`}>
                            <TableCell>
                              {getTypeBadge(job.type)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 text-slate-400" />
                                <span className="font-medium">{job.contract_name}</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-slate-600 dark:text-slate-400">
                              {job.organization_name || '-'}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                {job.signers?.slice(0, 2).map((signer, i) => (
                                  <div key={i} className="flex items-center gap-1 text-sm">
                                    <User className="w-3 h-3 text-slate-400" />
                                    <span className={signer.signed ? 'text-green-600' : 'text-slate-600 dark:text-slate-400'}>
                                      {signer.name || signer.email}
                                    </span>
                                    {signer.signed && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                                  </div>
                                ))}
                                {job.signers?.length > 2 && (
                                  <span className="text-xs text-slate-500">+{job.signers.length - 2} more</span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              {job.will_send_on_next_run ? (
                                <Badge className="bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900 dark:text-amber-200">
                                  <Mail className="w-3 h-3 mr-1" />
                                  Will send
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-slate-500">
                                  <Clock className="w-3 h-3 mr-1" />
                                  Scheduled
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-sm text-slate-600 dark:text-slate-400 max-w-xs">
                              <div className="truncate" title={job.reason}>
                                {job.reason}
                              </div>
                              {job.type === 'timeout' && job.days_overdue > 0 && (
                                <div className="text-xs text-red-500 mt-1">
                                  {job.days_overdue} day(s) overdue
                                </div>
                              )}
                              {job.type === 'reminder' && job.days_until_expiry > 0 && (
                                <div className="text-xs text-slate-500 mt-1">
                                  {job.days_until_expiry} days until expiry
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="history">
            <Card data-testid="card-execution-history">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <CardTitle>Execution History</CardTitle>
                    <CardDescription>Recent scheduled task executions</CardDescription>
                  </div>
                  <Select value={taskFilter} onValueChange={setTaskFilter}>
                    <SelectTrigger className="w-48" data-testid="select-task-filter">
                      <SelectValue placeholder="Filter by task" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Tasks</SelectItem>
                      <SelectItem value="contract_reminders">Contract Reminders</SelectItem>
                      <SelectItem value="contract_timeout_notifications">Timeout Notifications</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent>
                {logsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                  </div>
                ) : !logsData?.logs?.length ? (
                  <div className="text-center py-12 text-slate-500">
                    <Clock className="w-12 h-12 mx-auto mb-4 text-slate-300" />
                    <p className="text-lg font-medium">No execution history yet</p>
                    <p className="text-sm mt-1">Scheduled tasks will appear here once they run</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Task</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Summary</TableHead>
                          <TableHead>Items</TableHead>
                          <TableHead>Duration</TableHead>
                          <TableHead>Executed</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {logsData.logs.map((log) => (
                          <TableRow key={log.id} data-testid={`row-log-${log.id}`}>
                            <TableCell className="font-medium">
                              {log.task_display_name}
                            </TableCell>
                            <TableCell>
                              {getStatusBadge(log.status)}
                            </TableCell>
                            <TableCell className="max-w-xs truncate text-slate-600 dark:text-slate-400">
                              {log.summary || '-'}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2 text-sm">
                                <span className="text-green-600">{log.items_succeeded || 0}</span>
                                <span className="text-slate-400">/</span>
                                <span className="text-slate-600 dark:text-slate-400">{log.items_processed || 0}</span>
                                {log.items_failed > 0 && (
                                  <>
                                    <span className="text-slate-400">/</span>
                                    <span className="text-red-600">{log.items_failed}</span>
                                  </>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1 text-sm text-slate-500">
                                <Timer className="w-3 h-3" />
                                {formatDuration(log.duration_ms)}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-slate-500">
                              {formatDate(log.executed_at)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
