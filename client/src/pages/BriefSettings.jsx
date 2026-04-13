import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
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
  Layers,
  Tag,
  Bell,
  Plus,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  Save,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const PRESET_COLORS = [
  "#6b7280", "#3b82f6", "#f59e0b", "#a855f7",
  "#f97316", "#22c55e", "#ef4444", "#ec4899",
  "#14b8a6", "#8b5cf6", "#06b6d4", "#84cc16",
];

export default function BriefSettings() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("content.brief-settings")) {
        window.location.href = createPageUrl("BriefManagement");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: settings, isLoading } = useQuery({
    queryKey: ["brief-settings"],
    queryFn: async () => {
      const res = await fetch("/api/article-briefs/settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
    staleTime: 0,
    refetchOnMount: "always",
  });

  const [stages, setStages] = useState([]);
  const [categories, setCategories] = useState([]);
  const [notifyReviewer, setNotifyReviewer] = useState(false);
  const [notifyWriter, setNotifyWriter] = useState(false);

  const [stageDialog, setStageDialog] = useState(null);
  const [stageForm, setStageForm] = useState({ key: "", label: "", color: "#6b7280" });
  const [deleteStageConfirm, setDeleteStageConfirm] = useState(null);

  const [categoryDialog, setCategoryDialog] = useState(null);
  const [categoryForm, setCategoryForm] = useState("");
  const [deleteCategoryConfirm, setDeleteCategoryConfirm] = useState(null);

  useEffect(() => {
    if (settings) {
      setStages(settings.stages || []);
      setCategories(settings.categories || []);
      setNotifyReviewer(settings.notify_reviewer || false);
      setNotifyWriter(settings.notify_writer || false);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (payload) => {
      const res = await fetch("/api/article-briefs/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save settings");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["brief-settings"] });
      toast.success("Settings saved successfully");
    },
    onError: (error) => {
      toast.error("Failed to save: " + error.message);
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      stages,
      categories,
      notify_reviewer: notifyReviewer,
      notify_writer: notifyWriter,
    });
  };

  const openAddStage = () => {
    setStageForm({ key: "", label: "", color: "#6b7280" });
    setStageDialog("add");
  };

  const openEditStage = (index) => {
    const s = stages[index];
    setStageForm({ key: s.key, label: s.label, color: s.color });
    setStageDialog(index);
  };

  const saveStage = () => {
    if (!stageForm.label.trim()) {
      toast.error("Stage label is required");
      return;
    }

    const key = stageDialog === "add"
      ? stageForm.label.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
      : stageForm.key;

    if (stageDialog === "add" && stages.some((s) => s.key === key)) {
      toast.error("A stage with this key already exists");
      return;
    }

    if (stageDialog === "add") {
      setStages((prev) => [...prev, { key, label: stageForm.label.trim(), color: stageForm.color }]);
    } else {
      setStages((prev) =>
        prev.map((s, i) =>
          i === stageDialog ? { ...s, label: stageForm.label.trim(), color: stageForm.color } : s
        )
      );
    }
    setStageDialog(null);
  };

  const moveStage = (index, direction) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= stages.length) return;
    setStages((prev) => {
      const arr = [...prev];
      [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];
      return arr;
    });
  };

  const deleteStage = (index) => {
    setStages((prev) => prev.filter((_, i) => i !== index));
    setDeleteStageConfirm(null);
  };

  const openAddCategory = () => {
    setCategoryForm("");
    setCategoryDialog("add");
  };

  const openEditCategory = (index) => {
    setCategoryForm(categories[index]);
    setCategoryDialog(index);
  };

  const saveCategory = () => {
    if (!categoryForm.trim()) {
      toast.error("Category name is required");
      return;
    }

    if (categoryDialog === "add") {
      if (categories.includes(categoryForm.trim())) {
        toast.error("This category already exists");
        return;
      }
      setCategories((prev) => [...prev, categoryForm.trim()]);
    } else {
      setCategories((prev) =>
        prev.map((c, i) => (i === categoryDialog ? categoryForm.trim() : c))
      );
    }
    setCategoryDialog(null);
  };

  const deleteCategory = (index) => {
    setCategories((prev) => prev.filter((_, i) => i !== index));
    setDeleteCategoryConfirm(null);
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2" data-testid="text-page-title">
              Brief Settings
            </h1>
            <p className="text-slate-600">
              Configure workflow stages, categories, and notifications for article briefs
            </p>
          </div>
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            data-testid="button-save-settings"
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Save Settings
          </Button>
        </div>

        {isLoading ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-slate-400" />
              <p className="text-slate-600">Loading settings...</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-blue-600" />
                  Workflow Stages
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="p-4 bg-blue-50 rounded-md border border-blue-200 mb-4">
                  <p className="text-sm text-blue-900">
                    Define the stages a brief goes through. The order below determines the workflow sequence. Use the arrows to reorder.
                  </p>
                </div>

                {stages.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-slate-500">No stages configured. Add your first stage below.</p>
                  </div>
                ) : (
                  <div className="space-y-2 mb-4">
                    {stages.map((stage, index) => (
                      <div
                        key={stage.key}
                        className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-md"
                        data-testid={`stage-item-${index}`}
                      >
                        <div className="flex flex-col gap-0.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => moveStage(index, -1)}
                            disabled={index === 0}
                            data-testid={`button-stage-up-${index}`}
                          >
                            <ChevronUp className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => moveStage(index, 1)}
                            disabled={index === stages.length - 1}
                            data-testid={`button-stage-down-${index}`}
                          >
                            <ChevronDown className="w-4 h-4" />
                          </Button>
                        </div>
                        <div
                          className="w-4 h-4 rounded-full flex-shrink-0"
                          style={{ backgroundColor: stage.color }}
                        />
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-slate-900" data-testid={`text-stage-label-${index}`}>
                            {stage.label}
                          </span>
                          <span className="ml-2 text-xs text-slate-400">({stage.key})</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => openEditStage(index)}
                            data-testid={`button-edit-stage-${index}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteStageConfirm(index)}
                            data-testid={`button-delete-stage-${index}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <Button variant="outline" onClick={openAddStage} data-testid="button-add-stage">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Stage
                </Button>
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <Tag className="w-5 h-5 text-green-600" />
                  Brief Categories
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="p-4 bg-green-50 rounded-md border border-green-200 mb-4">
                  <p className="text-sm text-green-900">
                    Categories help classify briefs. Writers will choose from this list when creating or editing a brief.
                  </p>
                </div>

                {categories.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-slate-500">No categories configured. Add your first category below.</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {categories.map((cat, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-1 bg-white border border-slate-200 rounded-md px-3 py-2"
                        data-testid={`category-item-${index}`}
                      >
                        <span className="text-sm text-slate-800" data-testid={`text-category-name-${index}`}>
                          {cat}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="ml-1"
                          onClick={() => openEditCategory(index)}
                          data-testid={`button-edit-category-${index}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteCategoryConfirm(index)}
                          data-testid={`button-delete-category-${index}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <Button variant="outline" onClick={openAddCategory} data-testid="button-add-category">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Category
                </Button>
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  <Bell className="w-5 h-5 text-amber-600" />
                  Email Notifications
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <div className="p-4 bg-amber-50 rounded-md border border-amber-200 mb-6">
                  <p className="text-sm text-amber-900">
                    Enable email notifications to keep writers and reviewers informed about brief events automatically.
                  </p>
                </div>

                <div className="space-y-6">
                  <div className="flex items-center justify-between gap-4 p-4 bg-white border border-slate-200 rounded-md">
                    <div>
                      <Label className="text-base font-medium text-slate-900">Writer Notifications</Label>
                      <p className="text-sm text-slate-500 mt-1">
                        Notify writers when they are assigned to a brief, when changes are requested, or when a comment is added.
                      </p>
                    </div>
                    <Switch
                      checked={notifyWriter}
                      onCheckedChange={setNotifyWriter}
                      data-testid="switch-notify-writer"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 p-4 bg-white border border-slate-200 rounded-md">
                    <div>
                      <Label className="text-base font-medium text-slate-900">Reviewer Notifications</Label>
                      <p className="text-sm text-slate-500 mt-1">
                        Notify reviewers when a new version is uploaded or when a brief is submitted for review.
                      </p>
                    </div>
                    <Switch
                      checked={notifyReviewer}
                      onCheckedChange={setNotifyReviewer}
                      data-testid="switch-notify-reviewer"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <Dialog open={stageDialog !== null} onOpenChange={(open) => !open && setStageDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{stageDialog === "add" ? "Add Stage" : "Edit Stage"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1">
              <Label htmlFor="stage-label">Label</Label>
              <Input
                id="stage-label"
                value={stageForm.label}
                onChange={(e) => setStageForm((p) => ({ ...p, label: e.target.value }))}
                placeholder="e.g. Under Review"
                data-testid="input-stage-label"
              />
            </div>
            <div className="space-y-1">
              <Label>Color</Label>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="w-8 h-8 rounded-md border-2 transition-colors"
                    style={{
                      backgroundColor: color,
                      borderColor: stageForm.color === color ? "#1e293b" : "transparent",
                    }}
                    onClick={() => setStageForm((p) => ({ ...p, color }))}
                    data-testid={`button-color-${color.replace("#", "")}`}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Label htmlFor="stage-color-custom" className="text-xs text-slate-500">
                  Custom:
                </Label>
                <Input
                  id="stage-color-custom"
                  type="color"
                  value={stageForm.color}
                  onChange={(e) => setStageForm((p) => ({ ...p, color: e.target.value }))}
                  className="w-10 h-8 p-0 border-0"
                  data-testid="input-stage-color"
                />
                <span className="text-xs text-slate-400">{stageForm.color}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStageDialog(null)} data-testid="button-cancel-stage">
              Cancel
            </Button>
            <Button onClick={saveStage} data-testid="button-save-stage">
              {stageDialog === "add" ? "Add" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={categoryDialog !== null} onOpenChange={(open) => !open && setCategoryDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{categoryDialog === "add" ? "Add Category" : "Edit Category"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1">
              <Label htmlFor="category-name">Category Name</Label>
              <Input
                id="category-name"
                value={categoryForm}
                onChange={(e) => setCategoryForm(e.target.value)}
                placeholder="e.g. Opinion"
                data-testid="input-category-name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryDialog(null)} data-testid="button-cancel-category">
              Cancel
            </Button>
            <Button onClick={saveCategory} data-testid="button-save-category">
              {categoryDialog === "add" ? "Add" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteStageConfirm !== null} onOpenChange={(open) => !open && setDeleteStageConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Stage</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove the stage "{deleteStageConfirm !== null && stages[deleteStageConfirm]?.label}"? Briefs already using this stage will retain their current status value.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-stage">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteStage(deleteStageConfirm)} data-testid="button-confirm-delete-stage">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteCategoryConfirm !== null} onOpenChange={(open) => !open && setDeleteCategoryConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Category</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove the category "{deleteCategoryConfirm !== null && categories[deleteCategoryConfirm]}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-category">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteCategory(deleteCategoryConfirm)} data-testid="button-confirm-delete-category">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
