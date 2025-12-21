import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  Plus,
  Pencil,
  Trash2,
  ExternalLink,
  Link,
  AlertTriangle,
  Search,
} from "lucide-react";
import { toast } from "sonner";

const MATCH_TYPE_OPTIONS = [
  { value: "exact", label: "Exact Match", description: "Matches the exact path" },
  { value: "prefix", label: "Prefix Match", description: "Matches paths starting with the pattern" },
  { value: "regex", label: "Regex Match", description: "Matches using regular expression" },
];

const STATUS_CODE_OPTIONS = [
  { value: 301, label: "301 - Permanent Redirect" },
  { value: 302, label: "302 - Temporary Redirect" },
  { value: 307, label: "307 - Temporary Redirect (Preserve Method)" },
  { value: 308, label: "308 - Permanent Redirect (Preserve Method)" },
];

export default function RedirectManagement() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [editingRedirect, setEditingRedirect] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [redirectToDelete, setRedirectToDelete] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [regexError, setRegexError] = useState("");

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('admin.redirect-management')) {
        window.location.href = createPageUrl('Preferences');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: redirects = [], isLoading } = useQuery({
    queryKey: ['redirect-mappings'],
    queryFn: () => base44.entities.RedirectMapping.list('priority'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.RedirectMapping.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['redirect-mappings'] });
      setShowDialog(false);
      setEditingRedirect(null);
      toast.success('Redirect created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create redirect: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.RedirectMapping.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['redirect-mappings'] });
      setShowDialog(false);
      setEditingRedirect(null);
      toast.success('Redirect updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update redirect: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.RedirectMapping.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['redirect-mappings'] });
      setShowDeleteConfirm(false);
      setRedirectToDelete(null);
      toast.success('Redirect deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete redirect: ' + error.message);
    }
  });

  const filteredRedirects = redirects.filter(redirect => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      redirect.source_pattern?.toLowerCase().includes(query) ||
      redirect.target_url?.toLowerCase().includes(query) ||
      redirect.description?.toLowerCase().includes(query)
    );
  });

  const handleCreateNew = () => {
    setEditingRedirect({
      source_pattern: "",
      target_url: "",
      match_type: "exact",
      status_code: 301,
      priority: redirects.length + 1,
      is_active: true,
      description: "",
    });
    setRegexError("");
    setShowDialog(true);
  };

  const handleEdit = (redirect) => {
    setEditingRedirect({ ...redirect });
    setRegexError("");
    setShowDialog(true);
  };

  const handleDelete = (redirect) => {
    setRedirectToDelete(redirect);
    setShowDeleteConfirm(true);
  };

  const validateRegex = (pattern) => {
    if (!pattern) return true;
    try {
      new RegExp(pattern);
      return true;
    } catch (e) {
      return false;
    }
  };

  const handleSave = () => {
    if (!editingRedirect.source_pattern?.trim()) {
      toast.error('Source pattern is required');
      return;
    }
    if (!editingRedirect.target_url?.trim()) {
      toast.error('Target URL is required');
      return;
    }

    if (editingRedirect.match_type === 'regex') {
      if (!validateRegex(editingRedirect.source_pattern)) {
        toast.error('Invalid regex pattern');
        return;
      }
    }

    const data = {
      source_pattern: editingRedirect.source_pattern.trim(),
      target_url: editingRedirect.target_url.trim(),
      match_type: editingRedirect.match_type,
      status_code: editingRedirect.status_code,
      priority: editingRedirect.priority,
      is_active: editingRedirect.is_active,
      description: editingRedirect.description?.trim() || null,
    };

    if (editingRedirect.id) {
      updateMutation.mutate({ id: editingRedirect.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handlePatternChange = (value) => {
    setEditingRedirect({ ...editingRedirect, source_pattern: value });
    if (editingRedirect.match_type === 'regex') {
      if (!validateRegex(value)) {
        setRegexError('Invalid regex pattern');
      } else {
        setRegexError('');
      }
    }
  };

  const handleMatchTypeChange = (value) => {
    setEditingRedirect({ ...editingRedirect, match_type: value });
    if (value === 'regex') {
      if (!validateRegex(editingRedirect.source_pattern)) {
        setRegexError('Invalid regex pattern');
      } else {
        setRegexError('');
      }
    } else {
      setRegexError('');
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="loading-redirect-management">
        <div className="text-muted-foreground">Checking access...</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="loading-redirects">
        <div className="text-muted-foreground">Loading redirects...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8" data-testid="redirect-management-page">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground" data-testid="text-page-title">
            Redirect Management
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage URL redirects for legacy links and domain migrations
          </p>
        </div>
        <Button onClick={handleCreateNew} data-testid="button-create-redirect">
          <Plus className="w-4 h-4 mr-2" />
          Add Redirect
        </Button>
      </div>

      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search redirects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-redirects"
            />
          </div>
        </CardContent>
      </Card>

      {filteredRedirects.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Link className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-foreground mb-2" data-testid="text-no-redirects">
              No Redirects Found
            </h3>
            <p className="text-muted-foreground mb-6">
              {searchQuery
                ? "Try adjusting your search"
                : "Create your first redirect to handle legacy URLs"}
            </p>
            {!searchQuery && (
              <Button onClick={handleCreateNew} data-testid="button-create-first-redirect">
                <Plus className="w-4 h-4 mr-2" />
                Add First Redirect
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">Priority</TableHead>
                  <TableHead>Source Pattern</TableHead>
                  <TableHead>Target URL</TableHead>
                  <TableHead className="w-28">Match Type</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                  <TableHead className="w-20">Active</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRedirects.map((redirect) => (
                  <TableRow key={redirect.id} data-testid={`row-redirect-${redirect.id}`}>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {redirect.priority}
                    </TableCell>
                    <TableCell>
                      <code className="text-sm bg-muted px-2 py-1 rounded" data-testid={`text-source-${redirect.id}`}>
                        {redirect.source_pattern}
                      </code>
                      {redirect.description && (
                        <p className="text-xs text-muted-foreground mt-1">{redirect.description}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {redirect.target_url?.startsWith('http') ? (
                          <ExternalLink className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <Link className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        )}
                        <span className="text-sm truncate max-w-[200px]" title={redirect.target_url} data-testid={`text-target-${redirect.id}`}>
                          {redirect.target_url}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs" data-testid={`badge-match-type-${redirect.id}`}>
                        {redirect.match_type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs" data-testid={`badge-status-code-${redirect.id}`}>
                        {redirect.status_code}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {redirect.is_active ? (
                        <Badge className="bg-green-100 text-green-800" data-testid={`badge-active-${redirect.id}`}>Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground" data-testid={`badge-inactive-${redirect.id}`}>Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEdit(redirect)}
                          data-testid={`button-edit-redirect-${redirect.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(redirect)}
                          data-testid={`button-delete-redirect-${redirect.id}`}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={showDialog} onOpenChange={(open) => {
        setShowDialog(open);
        if (!open) {
          setEditingRedirect(null);
          setRegexError("");
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle data-testid="dialog-title-redirect">
              {editingRedirect?.id ? 'Edit Redirect' : 'Create Redirect'}
            </DialogTitle>
          </DialogHeader>

          {editingRedirect && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="source-pattern">Source Pattern *</Label>
                <Input
                  id="source-pattern"
                  value={editingRedirect.source_pattern}
                  onChange={(e) => handlePatternChange(e.target.value)}
                  placeholder="/old-page or /legacy/*"
                  data-testid="input-source-pattern"
                />
                {regexError && (
                  <p className="text-sm text-destructive flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {regexError}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  The old URL path to match (without domain)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="target-url">Target URL *</Label>
                <Input
                  id="target-url"
                  value={editingRedirect.target_url}
                  onChange={(e) => setEditingRedirect({ ...editingRedirect, target_url: e.target.value })}
                  placeholder="/new-page or https://example.com/page"
                  data-testid="input-target-url"
                />
                <p className="text-xs text-muted-foreground">
                  The new URL to redirect to (can be internal path or full URL)
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="match-type">Match Type</Label>
                  <Select
                    value={editingRedirect.match_type}
                    onValueChange={handleMatchTypeChange}
                  >
                    <SelectTrigger data-testid="select-match-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MATCH_TYPE_OPTIONS.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="status-code">Status Code</Label>
                  <Select
                    value={String(editingRedirect.status_code)}
                    onValueChange={(v) => setEditingRedirect({ ...editingRedirect, status_code: parseInt(v) })}
                  >
                    <SelectTrigger data-testid="select-status-code">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_CODE_OPTIONS.map(option => (
                        <SelectItem key={option.value} value={String(option.value)}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Input
                  id="priority"
                  type="number"
                  min="1"
                  value={editingRedirect.priority}
                  onChange={(e) => setEditingRedirect({ ...editingRedirect, priority: parseInt(e.target.value) || 1 })}
                  data-testid="input-priority"
                />
                <p className="text-xs text-muted-foreground">
                  Lower numbers are checked first
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (Optional)</Label>
                <Textarea
                  id="description"
                  value={editingRedirect.description || ""}
                  onChange={(e) => setEditingRedirect({ ...editingRedirect, description: e.target.value })}
                  placeholder="e.g., Legacy URL from old website"
                  rows={2}
                  data-testid="input-description"
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="is-active">Active</Label>
                <Switch
                  id="is-active"
                  checked={editingRedirect.is_active}
                  onCheckedChange={(checked) => setEditingRedirect({ ...editingRedirect, is_active: checked })}
                  data-testid="switch-is-active"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} data-testid="button-cancel-dialog">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending || !!regexError}
              data-testid="button-save-redirect"
            >
              {editingRedirect?.id ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="dialog-title-delete">Delete Redirect?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the redirect for{' '}
              <code className="bg-muted px-1 rounded">{redirectToDelete?.source_pattern}</code>?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(redirectToDelete?.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
