import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { LayoutDashboard, Plus, Sparkles, Users } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";
import WidgetGrid from "@/components/dashboard/WidgetGrid";
import WidgetBuilderModal from "@/components/dashboard/WidgetBuilderModal";

export default function DashboardWidgetBuilder() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState(null);
  const [defaultScope, setDefaultScope] = useState("personal");
  const [pendingDelete, setPendingDelete] = useState(null);

  const widgetsQuery = useQuery({
    queryKey: ["/api/dashboard/widgets"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets", { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(body.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return body;
    },
  });

  const permissions = widgetsQuery.data?.permissions || {
    view: true,
    manageShared: false,
    managePersonal: false,
  };
  const sharedWidgets = widgetsQuery.data?.shared || [];
  const personalWidgets = widgetsQuery.data?.personal || [];

  const saveMutation = useMutation({
    mutationFn: async payload => {
      if (payload && payload.__resizeId) {
        const { __resizeId, ...patch } = payload;
        return apiRequest("PATCH", `/api/dashboard/widgets/${__resizeId}`, patch);
      }
      if (editingWidget) {
        return apiRequest("PATCH", `/api/dashboard/widgets/${editingWidget.id}`, payload);
      }
      return apiRequest("POST", "/api/dashboard/widgets", payload);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["/api/dashboard/widgets"] });
      if (!variables?.__resizeId) {
        setBuilderOpen(false);
        setEditingWidget(null);
        toast({ title: editingWidget ? "Widget updated" : "Widget created" });
      }
    },
    onError: (err, variables) => {
      if (variables?.__resizeId) {
        qc.invalidateQueries({ queryKey: ["/api/dashboard/widgets"] });
      }
      toast({
        title: "Save failed",
        description: err?.message || "Unable to save widget",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async widgetId => apiRequest("DELETE", `/api/dashboard/widgets/${widgetId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/dashboard/widgets"] });
      setPendingDelete(null);
      toast({ title: "Widget deleted" });
    },
    onError: err => {
      toast({
        title: "Delete failed",
        description: err?.message || "Unable to delete widget",
        variant: "destructive",
      });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async ({ scope, ids }) =>
      apiRequest("POST", "/api/dashboard/widgets/reorder", { scope, ids }),
    onError: err => {
      qc.invalidateQueries({ queryKey: ["/api/dashboard/widgets"] });
      toast({
        title: "Reorder failed",
        description: err?.message || "Unable to reorder widgets",
        variant: "destructive",
      });
    },
  });

  const handleResize = widget => nextWidth => {
    qc.setQueryData(["/api/dashboard/widgets"], prev => {
      if (!prev) return prev;
      const key = widget.scope === "shared" ? "shared" : "personal";
      return {
        ...prev,
        [key]: prev[key].map(w => (w.id === widget.id ? { ...w, width: nextWidth } : w)),
      };
    });
    saveMutation.mutate({ width: nextWidth, __resizeId: widget.id });
  };

  const handleReorder = (scope, nextOrder) => {
    qc.setQueryData(["/api/dashboard/widgets"], prev =>
      prev
        ? {
            ...prev,
            [scope]: nextOrder,
          }
        : prev,
    );
    reorderMutation.mutate({ scope, ids: nextOrder.map(w => w.id) });
  };

  const openBuilder = (scope, widget = null) => {
    setEditingWidget(widget);
    setDefaultScope(scope);
    setBuilderOpen(true);
  };

  // Render nothing until the widget query has settled. This guarantees that
  // viewers without manage permissions and no widgets never see the header
  // flash before we've decided to bail out.
  if (widgetsQuery.isLoading || !widgetsQuery.data) {
    return null;
  }

  // On error (including 403), keep the page clean — don't render an error
  // banner above the welcome hero.
  if (widgetsQuery.isError) {
    return null;
  }

  // Render nothing when the user has neither management permission and there
  // are no widgets to show, so the welcome page looks identical to today.
  const hasAnyWidgets = sharedWidgets.length > 0 || personalWidgets.length > 0;
  const canManageAnything = permissions.manageShared || permissions.managePersonal;
  if (!canManageAnything && !hasAnyWidgets) {
    return null;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 md:px-8 md:py-8">
      <DashboardHeader
        canManagePersonal={permissions.managePersonal}
        canManageShared={permissions.manageShared}
        onAddPersonal={() => openBuilder("personal")}
        onAddShared={() => openBuilder("shared")}
      />

      {(permissions.manageShared || sharedWidgets.length > 0) && (
        <Section
          icon={<Users className="h-4 w-4" />}
          title="Shared widgets"
          subtitle="Visible to everyone in your organisation."
          action={
            permissions.manageShared && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openBuilder("shared")}
                data-testid="button-add-shared-widget"
              >
                <Plus className="mr-1 h-4 w-4" /> Add shared widget
              </Button>
            )
          }
        >
          <WidgetZone
            isLoading={widgetsQuery.isLoading}
            widgets={sharedWidgets}
            canEdit={permissions.manageShared}
            emptyTitle="No shared widgets yet"
            emptyDescription={
              permissions.manageShared
                ? "Add a widget to share key metrics with everyone."
                : "Your administrator hasn’t added any shared widgets yet."
            }
            onReorder={next => handleReorder("shared", next)}
            onEdit={w => openBuilder("shared", w)}
            onDelete={w => setPendingDelete(w)}
            onResize={(w, nextWidth) => handleResize(w)(nextWidth)}
            testId="zone-shared"
          />
        </Section>
      )}

      {(permissions.managePersonal || personalWidgets.length > 0) && (
        <Section
          icon={<Sparkles className="h-4 w-4" />}
          title="My widgets"
          subtitle="Only you can see these."
          action={
            permissions.managePersonal && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openBuilder("personal")}
                data-testid="button-add-personal-widget"
              >
                <Plus className="mr-1 h-4 w-4" /> Add personal widget
              </Button>
            )
          }
        >
          <WidgetZone
            isLoading={widgetsQuery.isLoading}
            widgets={personalWidgets}
            canEdit={permissions.managePersonal}
            emptyTitle="No personal widgets yet"
            emptyDescription={
              permissions.managePersonal
                ? "Build a widget that lives only on your dashboard."
                : "You don’t have permission to create personal widgets."
            }
            onReorder={next => handleReorder("personal", next)}
            onEdit={w => openBuilder("personal", w)}
            onDelete={w => setPendingDelete(w)}
            onResize={(w, nextWidth) => handleResize(w)(nextWidth)}
            testId="zone-personal"
          />
        </Section>
      )}

      <WidgetBuilderModal
        open={builderOpen}
        onClose={() => {
          setBuilderOpen(false);
          setEditingWidget(null);
        }}
        onSave={payload => saveMutation.mutate(payload)}
        initialWidget={editingWidget}
        defaultScope={defaultScope}
        canSaveShared={permissions.manageShared}
        canSavePersonal={permissions.managePersonal}
        isSaving={saveMutation.isPending}
      />

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={open => !open && setPendingDelete(null)}
      >
        <AlertDialogContent data-testid="dialog-delete-widget">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this widget?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.title
                ? `“${pendingDelete.title}” will be removed permanently.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-widget">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete-widget"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
            >
              Delete widget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DashboardHeader({
  canManagePersonal,
  canManageShared,
  onAddPersonal,
  onAddShared,
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <LayoutDashboard className="h-5 w-5" />
        </div>
        <div>
          <h2
            className="text-2xl font-semibold tracking-tight"
            data-testid="text-dashboard-widgets-heading"
          >
            Dashboard widgets
          </h2>
          <p className="text-sm text-muted-foreground">
            Build the views that matter — for the team and for yourself.
          </p>
        </div>
      </div>
      <TooltipProvider delayDuration={200}>
        <div className="flex flex-wrap gap-2">
          {canManageShared && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={onAddShared}
                  data-testid="button-header-add-shared"
                >
                  <Plus className="mr-1 h-4 w-4" /> New shared widget
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Build a chart or stat that everyone in this organisation can see.
              </TooltipContent>
            </Tooltip>
          )}
          {canManagePersonal && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={onAddPersonal} data-testid="button-header-add-personal">
                  <Plus className="mr-1 h-4 w-4" /> New personal widget
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Build a chart or stat that lives only on your dashboard.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}

function Section({ icon, title, subtitle, action, children }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
            {icon}
            <span>{title}</span>
          </div>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function WidgetZone({
  isLoading,
  widgets,
  canEdit,
  emptyTitle,
  emptyDescription,
  onReorder,
  onEdit,
  onDelete,
  onResize,
  testId,
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-12 gap-4" data-testid={`${testId}-loading`}>
        {[0, 1, 2].map(i => (
          <Card key={i} className="col-span-12 md:col-span-4">
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  if (!widgets || widgets.length === 0) {
    return (
      <Card data-testid={`${testId}-empty`}>
        <CardContent className="flex flex-col items-center gap-1 py-10 text-center">
          <p className="text-sm font-medium">{emptyTitle}</p>
          <p className="text-sm text-muted-foreground">{emptyDescription}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <WidgetGrid
      widgets={widgets}
      canEdit={canEdit}
      onReorder={onReorder}
      onEdit={onEdit}
      onDelete={onDelete}
      onResize={onResize}
    />
  );
}
