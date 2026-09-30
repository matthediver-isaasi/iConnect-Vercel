import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  Search,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  UserPlus,
  FileText,
  X,
} from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { base44 } from "@/api/base44Client";
import { uploadFileWithProgress, UPLOAD_TYPES, resolveFileUrl } from "@/lib/tenantUpload";

const emptyWriter = {
  first_name: "",
  last_name: "",
  organisation: "",
  job_title: "",
  email: "",
};

export default function ExternalWritersPage() {
  const queryClient = useQueryClient();
  const { isAccessReady, isFeatureExcluded } = useMemberAccess();
  const canManage = !isFeatureExcluded("content.briefs.manage");

  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWriter, setEditingWriter] = useState(null);
  const [formData, setFormData] = useState(emptyWriter);
  const [emailError, setEmailError] = useState("");
  const [emailChecking, setEmailChecking] = useState(false);
  const [writerToDelete, setWriterToDelete] = useState(null);
  const [docUploading, setDocUploading] = useState(false);
  const docInputRef = useRef(null);

  const { data: writers = [], isLoading } = useQuery({
    queryKey: ["external-writers"],
    queryFn: async () => {
      return await base44.entities.ExternalWriter.list();
    },
    enabled: isAccessReady,
  });

  const { data: documents = [] } = useQuery({
    queryKey: ["external-writer-documents"],
    queryFn: async () => {
      return await base44.entities.ExternalWriterDocument.list();
    },
    enabled: isAccessReady,
  });

  const docsByWriter = {};
  documents.forEach((d) => {
    if (!docsByWriter[d.external_writer_id]) docsByWriter[d.external_writer_id] = [];
    docsByWriter[d.external_writer_id].push(d);
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.ExternalWriter.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["external-writers"] });
      closeDialog();
      toast.success("External writer created");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to create external writer");
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.ExternalWriter.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["external-writers"] });
      closeDialog();
      toast.success("External writer updated");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update external writer");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.ExternalWriter.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["external-writers"] });
      queryClient.invalidateQueries({ queryKey: ["external-writer-documents"] });
      setWriterToDelete(null);
      toast.success("External writer deleted");
    },
    onError: () => {
      toast.error("Failed to delete external writer");
    },
  });

  const deleteDocMutation = useMutation({
    mutationFn: async (docId) => {
      const resp = await fetch(`/api/external-writers/documents/${docId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!resp.ok) throw new Error("Failed to delete document");
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["external-writer-documents"] });
      toast.success("Document deleted");
    },
    onError: () => {
      toast.error("Failed to delete document");
    },
  });

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingWriter(null);
    setFormData(emptyWriter);
    setEmailError("");
  };

  const openCreate = () => {
    setFormData(emptyWriter);
    setEditingWriter(null);
    setEmailError("");
    setDialogOpen(true);
  };

  const openEdit = (writer) => {
    setFormData({
      first_name: writer.first_name || "",
      last_name: writer.last_name || "",
      organisation: writer.organisation || "",
      job_title: writer.job_title || "",
      email: writer.email || "",
    });
    setEditingWriter(writer);
    setEmailError("");
    setDialogOpen(true);
  };

  const checkEmail = async (email) => {
    if (!email || !email.includes("@")) {
      setEmailError("Valid email is required");
      return false;
    }
    try {
      const resp = await fetch("/api/external-writers/validate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email,
          excludeId: editingWriter?.id || null,
        }),
      });
      const result = await resp.json();
      if (!result.valid) {
        setEmailError(result.reason);
        return false;
      }
      setEmailError("");
      return true;
    } catch {
      setEmailError("Could not validate email");
      return false;
    }
  };

  const handleEmailBlur = () => {
    if (formData.email.trim()) {
      checkEmail(formData.email.trim());
    }
  };

  const handleSave = async () => {
    if (!formData.first_name.trim() || !formData.last_name.trim()) {
      toast.error("First name and last name are required");
      return;
    }
    if (!formData.email.trim() || !formData.email.includes("@")) {
      toast.error("Valid email is required");
      return;
    }
    setEmailChecking(true);
    try {
      const emailValid = await checkEmail(formData.email.trim());
      if (!emailValid) return;

      const payload = {
        first_name: formData.first_name.trim(),
        last_name: formData.last_name.trim(),
        organisation: formData.organisation.trim() || null,
        job_title: formData.job_title.trim() || null,
        email: formData.email.trim().toLowerCase(),
      };

      if (editingWriter) {
        updateMutation.mutate({ id: editingWriter.id, data: payload });
      } else {
        createMutation.mutate(payload);
      }
    } finally {
      setEmailChecking(false);
    }
  };

  const handleDocUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !editingWriter) return;
    setDocUploading(true);
    try {
      const result = await uploadFileWithProgress(file, {
        type: UPLOAD_TYPES.DOCUMENT,
        entityId: editingWriter.id,
        isPrivate: true,
      });
      await base44.entities.ExternalWriterDocument.create({
        external_writer_id: editingWriter.id,
        file_name: file.name,
        file_url: result.file_url,
        storage_path: result.storage_path,
        bucket: result.bucket,
      });
      queryClient.invalidateQueries({ queryKey: ["external-writer-documents"] });
      toast.success("Document uploaded");
    } catch (err) {
      toast.error(err.message || "Failed to upload document");
    } finally {
      setDocUploading(false);
      if (docInputRef.current) docInputRef.current.value = "";
    }
  };

  const handleDocDownload = async (doc) => {
    try {
      const url = await resolveFileUrl(doc.file_url);
      if (url) window.open(url, "_blank");
    } catch {
      toast.error("Failed to access document");
    }
  };

  const filtered = searchQuery.trim()
    ? writers.filter((w) => {
        const q = searchQuery.toLowerCase();
        return (
          w.first_name?.toLowerCase().includes(q) ||
          w.last_name?.toLowerCase().includes(q) ||
          w.email?.toLowerCase().includes(q) ||
          w.organisation?.toLowerCase().includes(q)
        );
      })
    : writers;

  if (isLoading) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center" data-testid="loading-spinner">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
            <div className="flex items-center gap-3">
              <UserPlus className="w-8 h-8 text-muted-foreground" />
              <h1 className="text-3xl md:text-4xl font-bold" data-testid="text-page-title">
                External Writers
              </h1>
            </div>
            {canManage && (
              <Button onClick={openCreate} data-testid="button-create-writer">
                <Plus className="w-4 h-4 mr-2" />
                Add Writer
              </Button>
            )}
          </div>
          <p className="text-muted-foreground" data-testid="text-writer-count">
            {filtered.length} {filtered.length === 1 ? "writer" : "writers"}
          </p>
        </div>

        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search writers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search-writers"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Name</TableHead>
                  <TableHead className="min-w-[150px]">Organisation</TableHead>
                  <TableHead className="min-w-[130px]">Job Title</TableHead>
                  <TableHead className="min-w-[180px]">Email</TableHead>
                  <TableHead className="min-w-[80px]">NDAs</TableHead>
                  {canManage && <TableHead className="min-w-[100px]">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canManage ? 6 : 5} className="text-center py-12 text-muted-foreground" data-testid="text-empty-state">
                      {writers.length === 0
                        ? "No external writers yet. Add your first external writer to get started."
                        : "No writers match your search."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((writer) => {
                    const writerDocs = docsByWriter[writer.id] || [];
                    return (
                      <TableRow key={writer.id} data-testid={`writer-row-${writer.id}`}>
                        <TableCell className="font-medium" data-testid={`text-writer-name-${writer.id}`}>
                          {[writer.first_name, writer.last_name].filter(Boolean).join(" ")}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {writer.organisation || "--"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {writer.job_title || "--"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {writer.email}
                        </TableCell>
                        <TableCell>
                          {writerDocs.length > 0 ? (
                            <Badge variant="secondary" className="text-xs" data-testid={`badge-nda-count-${writer.id}`}>
                              {writerDocs.length}
                            </Badge>
                          ) : (
                            <span className="text-sm text-muted-foreground">--</span>
                          )}
                        </TableCell>
                        {canManage && (
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEdit(writer)}
                                data-testid={`button-edit-writer-${writer.id}`}
                              >
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setWriterToDelete(writer)}
                                data-testid={`button-delete-writer-${writer.id}`}
                              >
                                <Trash2 className="w-4 h-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-lg max-h-[85vh] flex flex-col overflow-hidden" data-testid="dialog-writer-form">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>{editingWriter ? "Edit External Writer" : "Add External Writer"}</DialogTitle>
            <DialogDescription>
              {editingWriter ? "Update the writer's details and manage NDA documents." : "Add a new external writer for brief assignments."}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-4 py-2 pr-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="ew-first-name">First Name *</Label>
                  <Input
                    id="ew-first-name"
                    value={formData.first_name}
                    onChange={(e) => setFormData((p) => ({ ...p, first_name: e.target.value }))}
                    placeholder="First name"
                    data-testid="input-writer-first-name"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ew-last-name">Last Name *</Label>
                  <Input
                    id="ew-last-name"
                    value={formData.last_name}
                    onChange={(e) => setFormData((p) => ({ ...p, last_name: e.target.value }))}
                    placeholder="Last name"
                    data-testid="input-writer-last-name"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ew-organisation">Organisation</Label>
                <Input
                  id="ew-organisation"
                  value={formData.organisation}
                  onChange={(e) => setFormData((p) => ({ ...p, organisation: e.target.value }))}
                  placeholder="Organisation name"
                  data-testid="input-writer-organisation"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ew-job-title">Job Title</Label>
                <Input
                  id="ew-job-title"
                  value={formData.job_title}
                  onChange={(e) => setFormData((p) => ({ ...p, job_title: e.target.value }))}
                  placeholder="Job title"
                  data-testid="input-writer-job-title"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ew-email">Email *</Label>
                <Input
                  id="ew-email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => {
                    setFormData((p) => ({ ...p, email: e.target.value }));
                    if (emailError) setEmailError("");
                  }}
                  onBlur={handleEmailBlur}
                  placeholder="email@example.com"
                  data-testid="input-writer-email"
                />
                {emailChecking && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Checking email...
                  </p>
                )}
                {emailError && (
                  <p className="text-xs text-destructive" data-testid="text-email-error">{emailError}</p>
                )}
              </div>

              {editingWriter && (
                <div className="space-y-2">
                  <Label>NDA Documents</Label>
                  <input
                    ref={docInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleDocUpload}
                    data-testid="input-doc-file"
                  />
                  <div className="space-y-1">
                    {(docsByWriter[editingWriter.id] || []).map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center justify-between gap-2 p-2 rounded-md border"
                        data-testid={`doc-row-${doc.id}`}
                      >
                        <button
                          type="button"
                          className="flex items-center gap-2 min-w-0 text-left"
                          onClick={() => handleDocDownload(doc)}
                          data-testid={`button-download-doc-${doc.id}`}
                        >
                          <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                          <span className="text-sm truncate">{doc.file_name}</span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteDocMutation.mutate(doc.id)}
                          disabled={deleteDocMutation.isPending}
                          data-testid={`button-delete-doc-${doc.id}`}
                        >
                          <X className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => docInputRef.current?.click()}
                    disabled={docUploading}
                    data-testid="button-upload-doc"
                  >
                    {docUploading ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <FileText className="w-4 h-4 mr-1" />
                    )}
                    {docUploading ? "Uploading..." : "Upload NDA"}
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
          <DialogFooter className="flex-shrink-0">
            <Button variant="outline" onClick={closeDialog} data-testid="button-cancel-writer">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending || emailChecking}
              data-testid="button-save-writer"
            >
              {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editingWriter ? "Save Changes" : "Add Writer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!writerToDelete} onOpenChange={(open) => !open && setWriterToDelete(null)}>
        <AlertDialogContent data-testid="dialog-delete-writer">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete External Writer</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{writerToDelete && [writerToDelete.first_name, writerToDelete.last_name].filter(Boolean).join(" ")}"?
              This will also remove all associated NDA documents. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-writer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(writerToDelete.id)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-writer"
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
