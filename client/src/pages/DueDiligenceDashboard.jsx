import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Filter, RefreshCw, FileText, TrendingUp, AlertTriangle, CheckCircle, Clock, Loader2, Settings } from "lucide-react";
import { format } from 'date-fns';
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";

async function apiRequest(method, url, body = null) {
  const options = {
    method,
    credentials: 'include',
    headers: {}
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

const DEFAULT_WORKFLOW_STAGES = [
  { id: "new", label: "New", color: "#f97316" },
  { id: "in_review", label: "In Review", color: "#a855f7" },
  { id: "verified", label: "Verified", color: "#3b82f6" },
  { id: "approved", label: "Approved", color: "#22c55e" },
  { id: "rejected", label: "Rejected", color: "#ef4444" }
];

const DEFAULT_RISK_LEVELS = [
  { name: "low", color: "#22c55e" },
  { name: "medium", color: "#f59e0b" },
  { name: "high", color: "#f97316" },
  { name: "critical", color: "#ef4444" }
];

function StatCard({ title, value, icon: Icon, color, subtitle }) {
  return (
    <Card className="hover-elevate" data-testid={`stat-card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>
          <div className="p-3 rounded-full" style={{ backgroundColor: `${color}20` }}>
            <Icon className="w-6 h-6" style={{ color }} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SubmissionRow({ submission, workflowStages, riskLevels, onClick }) {
  const stage = workflowStages.find(s => s.id === submission.workflow_status) || { label: submission.workflow_status, color: '#6b7280' };
  const riskConfig = riskLevels.find(r => r.name.toLowerCase() === submission.risk_level?.toLowerCase()) || { color: '#6b7280' };
  
  const formValues = submission.form_submission?.submission_data || {};
  const displayName = formValues.organization_name || formValues.company_name || formValues.name || submission.application_uid;
  
  return (
    <TableRow 
      className="cursor-pointer hover:bg-muted/50" 
      onClick={() => onClick(submission.id)}
      data-testid={`submission-row-${submission.id}`}
    >
      <TableCell className="font-medium">{submission.application_uid}</TableCell>
      <TableCell>{displayName}</TableCell>
      <TableCell>
        <Badge 
          style={{ backgroundColor: stage.color, color: '#fff' }}
          className="text-xs"
        >
          {stage.label}
        </Badge>
      </TableCell>
      <TableCell>
        {submission.due_diligence_score !== null && submission.due_diligence_score !== undefined ? (
          <div className="flex items-center gap-2">
            <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
              <div 
                className="h-full rounded-full"
                style={{ 
                  width: `${submission.due_diligence_score}%`,
                  backgroundColor: riskConfig.color
                }}
              />
            </div>
            <span className="text-sm font-medium">{submission.due_diligence_score}%</span>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">--</span>
        )}
      </TableCell>
      <TableCell>
        {submission.risk_level ? (
          <Badge 
            variant="outline" 
            style={{ borderColor: riskConfig.color, color: riskConfig.color }}
          >
            {submission.risk_level.replace(/_/g, ' ')}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-sm">--</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {submission.created_at ? format(new Date(submission.created_at), 'MMM d, yyyy') : '--'}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {submission.reviewed_by || '--'}
      </TableCell>
    </TableRow>
  );
}

export default function DueDiligenceDashboardPage() {
  const navigate = useNavigate();
  const { isAccessReady, memberInfo } = useMemberAccess();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');
  const [selectedFormId, setSelectedFormId] = useState('all');
  
  const { data: ddForms = [], isLoading: formsLoading } = useQuery({
    queryKey: ['dd-enabled-forms'],
    queryFn: async () => {
      const forms = await base44.entities.Form.list();
      return forms.filter(f => f.due_diligence_required);
    },
    enabled: isAccessReady
  });

  const { data: submissionsData, isLoading: submissionsLoading, refetch } = useQuery({
    queryKey: ['dd-submissions', statusFilter, riskFilter, selectedFormId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (riskFilter !== 'all') params.set('riskLevel', riskFilter);
      if (selectedFormId !== 'all') params.set('formId', selectedFormId);
      params.set('limit', '100');
      
      const res = await apiRequest('GET', `/api/due-diligence/list-submissions?${params.toString()}`);
      return res;
    },
    enabled: isAccessReady
  });

  const submissions = submissionsData?.submissions || [];
  
  const stats = useMemo(() => {
    const total = submissions.length;
    const byStatus = {};
    const byRisk = {};
    let scoredCount = 0;
    let totalScore = 0;
    
    submissions.forEach(sub => {
      byStatus[sub.workflow_status] = (byStatus[sub.workflow_status] || 0) + 1;
      if (sub.risk_level) {
        byRisk[sub.risk_level] = (byRisk[sub.risk_level] || 0) + 1;
      }
      if (sub.due_diligence_score !== null && sub.due_diligence_score !== undefined) {
        scoredCount++;
        totalScore += sub.due_diligence_score;
      }
    });
    
    return {
      total,
      byStatus,
      byRisk,
      avgScore: scoredCount > 0 ? Math.round(totalScore / scoredCount) : null,
      pendingReview: byStatus['new'] || 0,
      approved: byStatus['approved'] || 0,
      highRisk: (byRisk['high'] || 0) + (byRisk['critical'] || 0)
    };
  }, [submissions]);

  const filteredSubmissions = useMemo(() => {
    if (!searchQuery.trim()) return submissions;
    
    const query = searchQuery.toLowerCase();
    return submissions.filter(sub => {
      const uid = sub.application_uid?.toLowerCase() || '';
      const formValues = sub.form_submission?.submission_data || {};
      const orgName = (formValues.organization_name || formValues.company_name || formValues.name || '').toLowerCase();
      
      return uid.includes(query) || orgName.includes(query);
    });
  }, [submissions, searchQuery]);

  const workflowStages = DEFAULT_WORKFLOW_STAGES;
  const riskLevels = DEFAULT_RISK_LEVELS;

  const handleRowClick = (submissionId) => {
    navigate(`/ReviewSubmission?id=${submissionId}`);
  };

  if (!isAccessReady || formsLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Due Diligence Dashboard</h1>
          <p className="text-muted-foreground">Review and manage form submissions</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => refetch()} data-testid="button-refresh">
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Submissions"
          value={stats.total}
          icon={FileText}
          color="#3b82f6"
          subtitle="All time"
        />
        <StatCard
          title="Pending Review"
          value={stats.pendingReview}
          icon={Clock}
          color="#f97316"
          subtitle="Awaiting action"
        />
        <StatCard
          title="Approved"
          value={stats.approved}
          icon={CheckCircle}
          color="#22c55e"
          subtitle="Completed"
        />
        <StatCard
          title="High Risk"
          value={stats.highRisk}
          icon={AlertTriangle}
          color="#ef4444"
          subtitle="Needs attention"
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <CardTitle>Submissions</CardTitle>
              <CardDescription>Click on a submission to review</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search..."
                  className="pl-9 w-48"
                  data-testid="input-search"
                />
              </div>
              <Select value={selectedFormId} onValueChange={setSelectedFormId} data-testid="select-form">
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="All Forms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Forms</SelectItem>
                  {ddForms.map(form => (
                    <SelectItem key={form.id} value={form.id}>{form.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter} data-testid="select-status">
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {workflowStages.map(stage => (
                    <SelectItem key={stage.id} value={stage.id}>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stage.color }} />
                        {stage.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={riskFilter} onValueChange={setRiskFilter} data-testid="select-risk">
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All Risk Levels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Risk Levels</SelectItem>
                  {riskLevels.map(level => (
                    <SelectItem key={level.name} value={level.name}>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: level.color }} />
                        {level.name.charAt(0).toUpperCase() + level.name.slice(1)}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {submissionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : filteredSubmissions.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Application ID</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Risk Level</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Reviewed By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSubmissions.map((submission) => (
                    <SubmissionRow
                      key={submission.id}
                      submission={submission}
                      workflowStages={workflowStages}
                      riskLevels={riskLevels}
                      onClick={handleRowClick}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No submissions found</p>
              <p className="text-sm mt-1">Submissions will appear here when forms with due diligence are submitted</p>
            </div>
          )}
        </CardContent>
      </Card>

      {ddForms.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Due Diligence Enabled Forms</CardTitle>
            <CardDescription>Forms configured for due diligence review</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {ddForms.map(form => {
                const formSubmissionCount = submissions.filter(s => s.form_submission?.form_id === form.id).length;
                return (
                  <Card key={form.id} className="hover-elevate" data-testid={`form-card-${form.id}`}>
                    <CardContent className="pt-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{form.name}</p>
                          <p className="text-sm text-muted-foreground">{formSubmissionCount} submissions</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => navigate(`/DueDiligenceConfig?formId=${form.id}`)}
                          data-testid={`button-config-${form.id}`}
                        >
                          <Settings className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
