import React, { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Inbox as InboxIcon,
  Star,
  Archive,
  ArchiveRestore,
  Folder,
  FolderPlus,
  Mail,
  MailOpen,
  Pin,
  PinOff,
  Search,
  Trash2,
  MoreVertical,
  Pencil,
  FolderInput,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
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
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useToast } from "@/components/ui/use-toast";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useInbox, fetchInboxMessageBody } from "@/hooks/useInbox";

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export default function InboxPage() {
  const { toast } = useToast();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const {
    messages,
    folders,
    isLoading,
    act,
    createFolder,
    renameFolder,
    deleteFolder,
  } = useInbox();

  const [selectedView, setSelectedView] = useState("inbox");
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [isLgUp, setIsLgUp] = useState(
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : true
  );

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsLgUp(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDraftName, setFolderDraftName] = useState("");
  const [editingFolder, setEditingFolder] = useState(null);
  const [folderToDelete, setFolderToDelete] = useState(null);

  const queryClient = useQueryClient();
  const { data: openMessage, isLoading: isBodyLoading } = useQuery({
    queryKey: ["inbox", "message", selectedId],
    queryFn: () => fetchInboxMessageBody(selectedId),
    enabled: !!selectedId,
    staleTime: 30000,
  });

  // Opening a message auto-marks it read server-side; refresh the list + badge
  // so the unread indicator clears. Use exact keys to avoid re-triggering the
  // message-body query (which shares the ["inbox", ...] prefix).
  useEffect(() => {
    if (!openMessage?.recipient_id) return;
    queryClient.invalidateQueries({ queryKey: ["inbox"], exact: true });
    queryClient.invalidateQueries({ queryKey: ["inbox", "unread"], exact: true });
  }, [openMessage?.recipient_id, queryClient]);

  const filteredMessages = useMemo(() => {
    let list = messages;
    if (selectedView === "archived") {
      list = list.filter((m) => m.is_archived);
    } else if (selectedView === "unread") {
      list = list.filter((m) => !m.is_archived && !m.is_read);
    } else if (selectedView === "pinned") {
      list = list.filter((m) => !m.is_archived && m.is_pinned);
    } else if (selectedView.startsWith("folder:")) {
      const folderId = selectedView.slice("folder:".length);
      list = list.filter((m) => !m.is_archived && m.folder_id === folderId);
    } else {
      // "inbox" default: everything not archived
      list = list.filter((m) => !m.is_archived);
    }

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) =>
          (m.subject || "").toLowerCase().includes(q) ||
          (m.from_name || "").toLowerCase().includes(q) ||
          (m.name || "").toLowerCase().includes(q)
      );
    }

    return [...list].sort((a, b) => {
      // Pinned first (except in archived view), then newest.
      if (selectedView !== "archived") {
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      }
      const at = a.sent_at ? new Date(a.sent_at).getTime() : 0;
      const bt = b.sent_at ? new Date(b.sent_at).getTime() : 0;
      return bt - at;
    });
  }, [messages, selectedView, search]);

  const unreadInboxCount = useMemo(
    () => messages.filter((m) => !m.is_archived && !m.is_read).length,
    [messages]
  );
  const pinnedCount = useMemo(
    () => messages.filter((m) => !m.is_archived && m.is_pinned).length,
    [messages]
  );
  const archivedCount = useMemo(
    () => messages.filter((m) => m.is_archived).length,
    [messages]
  );

  const folderCounts = useMemo(() => {
    const counts = {};
    for (const m of messages) {
      if (!m.is_archived && m.folder_id) {
        counts[m.folder_id] = (counts[m.folder_id] || 0) + 1;
      }
    }
    return counts;
  }, [messages]);

  const selectedMessage =
    messages.find((m) => m.recipient_id === selectedId) || openMessage || null;

  async function handleAction(recipientId, action, folderId) {
    try {
      await act(recipientId, action, folderId);
    } catch (err) {
      toast({
        title: "Something went wrong",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    }
  }

  async function handleSaveFolder() {
    const name = folderDraftName.trim();
    if (!name) return;
    try {
      if (editingFolder) {
        await renameFolder(editingFolder.id, name);
      } else {
        await createFolder(name);
      }
      setFolderDialogOpen(false);
      setFolderDraftName("");
      setEditingFolder(null);
    } catch (err) {
      toast({
        title: "Could not save folder",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    }
  }

  async function handleDeleteFolder() {
    if (!folderToDelete) return;
    try {
      await deleteFolder(folderToDelete.id);
      if (selectedView === `folder:${folderToDelete.id}`) setSelectedView("inbox");
      setFolderToDelete(null);
    } catch (err) {
      toast({
        title: "Could not delete folder",
        description: err.message || "Please try again.",
        variant: "destructive",
      });
    }
  }

  if (!isAccessReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (isFeatureExcluded("communication.inbox")) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="max-w-md w-full p-8 text-center">
          <InboxIcon className="w-10 h-10 mx-auto mb-4 text-muted-foreground" />
          <h1 className="text-lg font-semibold mb-2">Inbox unavailable</h1>
          <p className="text-sm text-muted-foreground">
            You don't have access to the inbox. Please contact your administrator if
            you think this is a mistake.
          </p>
        </Card>
      </div>
    );
  }

  const views = [
    { id: "inbox", label: "Inbox", icon: InboxIcon, count: unreadInboxCount },
    { id: "unread", label: "Unread", icon: Mail, count: unreadInboxCount },
    { id: "pinned", label: "Pinned", icon: Pin, count: pinnedCount },
    { id: "archived", label: "Archived", icon: Archive, count: archivedCount },
  ];

  const renderViewButton = (view) => {
    const Icon = view.icon;
    const active = selectedView === view.id;
    return (
      <button
        key={view.id}
        type="button"
        onClick={() => setSelectedView(view.id)}
        data-testid={`view-${view.id}`}
        className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm hover-elevate active-elevate-2 ${
          active ? "bg-accent text-accent-foreground font-medium" : "text-foreground"
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <span className="flex-1 text-left truncate">{view.label}</span>
        {view.count > 0 && (
          <Badge variant="secondary" data-testid={`count-${view.id}`}>
            {view.count}
          </Badge>
        )}
      </button>
    );
  };

  const renderReadingActions = (msg) => (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleAction(msg.recipient_id, msg.is_read ? "unread" : "read")}
        data-testid="button-toggle-read"
      >
        {msg.is_read ? (
          <>
            <Mail className="w-4 h-4 mr-2" /> Mark unread
          </>
        ) : (
          <>
            <MailOpen className="w-4 h-4 mr-2" /> Mark read
          </>
        )}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleAction(msg.recipient_id, msg.is_pinned ? "unpin" : "pin")}
        data-testid="button-toggle-pin"
      >
        {msg.is_pinned ? (
          <>
            <PinOff className="w-4 h-4 mr-2" /> Unpin
          </>
        ) : (
          <>
            <Pin className="w-4 h-4 mr-2" /> Pin
          </>
        )}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleAction(msg.recipient_id, msg.is_archived ? "unarchive" : "archive")}
        data-testid="button-toggle-archive"
      >
        {msg.is_archived ? (
          <>
            <ArchiveRestore className="w-4 h-4 mr-2" /> Unarchive
          </>
        ) : (
          <>
            <Archive className="w-4 h-4 mr-2" /> Archive
          </>
        )}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" data-testid="button-move">
            <FolderInput className="w-4 h-4 mr-2" /> Move
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Move to folder</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {folders.length === 0 && (
            <DropdownMenuItem disabled>No folders yet</DropdownMenuItem>
          )}
          {folders.map((f) => (
            <DropdownMenuItem
              key={f.id}
              onClick={() => handleAction(msg.recipient_id, "move", f.id)}
            >
              <Folder className="w-4 h-4 mr-2" />
              {f.name}
            </DropdownMenuItem>
          ))}
          {msg.folder_id && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleAction(msg.recipient_id, "move", null)}
              >
                Remove from folder
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const renderReadingBody = () => (
    <div className="flex-1 overflow-hidden bg-white">
      {isBodyLoading || !openMessage ? (
        <div className="p-6 text-sm text-muted-foreground">Loading message…</div>
      ) : (
        <iframe
          title="message-body"
          srcDoc={openMessage.html || "<p>No content.</p>"}
          className="w-full h-full border-0"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          data-testid="iframe-body"
        />
      )}
    </div>
  );

  return (
    <div className="h-[calc(100vh-4rem)] w-full p-4">
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(320px,380px)_minmax(0,1fr)] gap-4 h-full">
        {/* Folder rail */}
        <Card className="hidden lg:flex flex-col p-3 overflow-hidden">
          <div className="flex flex-col gap-1">{views.map(renderViewButton)}</div>

          <Separator className="my-3" />

          <div className="flex items-center justify-between px-3 mb-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Folders
            </span>
            <Button
              size="icon"
              variant="ghost"
              data-testid="button-new-folder"
              onClick={() => {
                setEditingFolder(null);
                setFolderDraftName("");
                setFolderDialogOpen(true);
              }}
            >
              <FolderPlus className="w-4 h-4" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-1 pr-2">
              {folders.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  No folders yet.
                </p>
              )}
              {folders.map((folder) => {
                const active = selectedView === `folder:${folder.id}`;
                return (
                  <div
                    key={folder.id}
                    className={`group flex items-center gap-2 px-3 py-2 rounded-md text-sm hover-elevate ${
                      active ? "bg-accent text-accent-foreground font-medium" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedView(`folder:${folder.id}`)}
                      data-testid={`folder-${folder.id}`}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <Folder className="w-4 h-4 shrink-0" />
                      <span className="flex-1 truncate">{folder.name}</span>
                      {folderCounts[folder.id] > 0 && (
                        <Badge variant="secondary">{folderCounts[folder.id]}</Badge>
                      )}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="invisible group-hover:visible"
                          data-testid={`folder-menu-${folder.id}`}
                        >
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditingFolder(folder);
                            setFolderDraftName(folder.name);
                            setFolderDialogOpen(true);
                          }}
                        >
                          <Pencil className="w-4 h-4 mr-2" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setFolderToDelete(folder)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </Card>

        {/* Message list */}
        <Card className="flex flex-col overflow-hidden">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search messages"
                className="pl-9"
                data-testid="input-search"
              />
            </div>
            {/* Mobile view selector */}
            <div className="flex lg:hidden gap-2 mt-3 overflow-x-auto">
              {views.map((v) => (
                <Button
                  key={v.id}
                  size="sm"
                  variant={selectedView === v.id ? "default" : "outline"}
                  onClick={() => setSelectedView(v.id)}
                >
                  {v.label}
                  {v.count > 0 ? ` (${v.count})` : ""}
                </Button>
              ))}
            </div>
          </div>

          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading messages…</div>
            ) : filteredMessages.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">
                <InboxIcon className="w-8 h-8 mx-auto mb-3 opacity-50" />
                No messages here.
              </div>
            ) : (
              <ul>
                {filteredMessages.map((m) => {
                  const active = m.recipient_id === selectedId;
                  let bgClass = "";
                  if (!m.is_read) {
                    bgClass = "bg-[hsl(var(--inbox-unread-bg))]";
                  } else if (m.is_pinned) {
                    bgClass = "bg-[hsl(var(--inbox-pinned-bg))]";
                  }
                  return (
                    <li key={m.recipient_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(m.recipient_id)}
                        data-testid={`message-${m.recipient_id}`}
                        aria-current={active ? "true" : undefined}
                        className={`w-full text-left px-4 py-3 border-b border-border hover-elevate ${bgClass} ${
                          active ? "ring-2 ring-inset ring-primary" : ""
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {!m.is_read && (
                            <span
                              className="w-2 h-2 rounded-full bg-primary shrink-0"
                              data-testid={`unread-dot-${m.recipient_id}`}
                            />
                          )}
                          {m.is_pinned && (
                            <Pin className="w-3 h-3 text-muted-foreground shrink-0" />
                          )}
                          <span
                            className={`flex-1 truncate text-sm ${
                              m.is_read ? "text-foreground" : "font-semibold text-foreground"
                            }`}
                          >
                            {m.from_name || "Message"}
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {formatDate(m.sent_at)}
                          </span>
                        </div>
                        <div
                          className={`mt-1 text-sm break-words ${
                            m.is_read ? "text-muted-foreground" : "text-foreground font-medium"
                          }`}
                        >
                          {m.subject || "(no subject)"}
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge variant="secondary">
                            {m.source === "group" ? "Group" : "Announcement"}
                          </Badge>
                          {m.preheader && (
                            <span className="text-xs text-muted-foreground truncate">
                              {m.preheader}
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </Card>

        {/* Reading pane (desktop, third column) */}
        <Card className="hidden lg:flex flex-col overflow-hidden">
          {isLgUp && selectedMessage ? (
            <>
              <div className="p-4 border-b border-border">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold" data-testid="text-subject">
                    {selectedMessage.subject || "(no subject)"}
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    {selectedMessage.from_name}
                    {selectedMessage.from_email ? ` · ${selectedMessage.from_email}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatDate(selectedMessage.sent_at)}
                  </p>
                </div>
                {renderReadingActions(selectedMessage)}
              </div>
              {renderReadingBody()}
            </>
          ) : (
            <div
              className="flex-1 flex flex-col items-center justify-center text-center p-10"
              data-testid="reading-pane-empty"
            >
              <InboxIcon className="w-10 h-10 mb-3 text-muted-foreground opacity-50" />
              <p className="text-sm text-muted-foreground">
                Select a message to read it here.
              </p>
            </div>
          )}
        </Card>

      </div>

      {/* Reading drawer (mobile / below lg) */}
      {!isLgUp && (
        <Sheet
          open={!!selectedId}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
        >
          <SheetContent
            side="right"
            className="w-full sm:max-w-xl p-0 gap-0 flex flex-col"
          >
            {selectedMessage && (
              <>
                <div className="p-4 pr-12 border-b border-border">
                  <div className="min-w-0">
                    <SheetTitle className="text-lg font-semibold" data-testid="text-subject-mobile">
                      {selectedMessage.subject || "(no subject)"}
                    </SheetTitle>
                    <SheetDescription className="text-sm text-muted-foreground mt-1">
                      {selectedMessage.from_name}
                      {selectedMessage.from_email ? ` · ${selectedMessage.from_email}` : ""}
                    </SheetDescription>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(selectedMessage.sent_at)}
                    </p>
                  </div>
                  {renderReadingActions(selectedMessage)}
                </div>
                {renderReadingBody()}
              </>
            )}
          </SheetContent>
        </Sheet>
      )}

      {/* New / rename folder dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingFolder ? "Rename folder" : "New folder"}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={folderDraftName}
            onChange={(e) => setFolderDraftName(e.target.value)}
            placeholder="Folder name"
            data-testid="input-folder-name"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveFolder();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveFolder} data-testid="button-save-folder">
              {editingFolder ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete folder confirm */}
      <AlertDialog
        open={!!folderToDelete}
        onOpenChange={(open) => !open && setFolderToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this folder?</AlertDialogTitle>
            <AlertDialogDescription>
              Messages filed in "{folderToDelete?.name}" will stay in your inbox — only
              the folder is removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteFolder}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
