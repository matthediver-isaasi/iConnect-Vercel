import React, { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Layers,
  FolderPlus,
  Globe,
} from "lucide-react";

// Sentinel key for the primary (default) tenant site in count/selection maps.
export const PRIMARY_SITE = "__primary__";

// Build a nested tree from a flat folder list using parent_id.
function buildFolderTree(folders, parentId = null) {
  return folders
    .filter((f) => (f.parent_id || null) === parentId)
    .sort(
      (a, b) =>
        (a.display_order ?? 0) - (b.display_order ?? 0) ||
        (a.name || "").localeCompare(b.name || "")
    )
    .map((f) => ({ ...f, children: buildFolderTree(folders, f.id) }));
}

// A single selectable view row that is also a drop target for page cards.
function DroppableRow({
  droppableId,
  selected,
  onSelect,
  depth = 0,
  icon,
  label,
  count,
  actions = null,
  expandControl = null,
  droppable = true,
  testId,
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    disabled: !droppable,
  });

  return (
    <div
      ref={droppable ? setNodeRef : undefined}
      className={`group flex items-center gap-1 rounded-md pr-1 ${
        selected ? "bg-sidebar-accent" : "hover-elevate"
      } ${isOver ? "ring-2 ring-blue-400 bg-blue-50" : ""}`}
      style={{ paddingLeft: `${depth * 14}px` }}
      data-testid={testId}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-1 items-center gap-2 min-w-0 py-1.5 px-2 text-left text-sm"
      >
        <span className="w-4 flex-shrink-0 flex items-center justify-center">
          {expandControl}
        </span>
        <span className="flex-shrink-0 text-slate-500">{icon}</span>
        <span className="truncate text-slate-700">{label}</span>
        {typeof count === "number" && (
          <span className="ml-auto flex-shrink-0 text-xs text-slate-400 tabular-nums">
            {count}
          </span>
        )}
      </button>
      {actions}
    </div>
  );
}

function FolderNode({
  node,
  siteId,
  depth,
  selectedFolderId,
  selectedSiteId,
  onSelect,
  countFor,
  expanded,
  toggleExpanded,
  onCreateSubfolder,
  onRename,
  onDelete,
}) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expanded.has(node.id);

  return (
    <div>
      <DroppableRow
        droppableId={`folder:${node.id}`}
        selected={selectedSiteId === siteId && selectedFolderId === node.id}
        onSelect={() => onSelect(siteId, node.id)}
        depth={depth}
        testId={`folder-node-${node.id}`}
        expandControl={
          hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(node.id);
              }}
              className="text-slate-400 hover:text-slate-600"
              data-testid={`button-toggle-folder-${node.id}`}
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
          ) : null
        }
        icon={
          isExpanded && hasChildren ? (
            <FolderOpen className="w-4 h-4" />
          ) : (
            <Folder className="w-4 h-4" />
          )
        }
        label={node.name}
        count={countFor(node.id, siteId)}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 opacity-0 group-hover:opacity-100"
                data-testid={`button-folder-menu-${node.id}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => onCreateSubfolder(node)}
                data-testid={`menu-new-subfolder-${node.id}`}
              >
                <FolderPlus className="w-4 h-4 mr-2" />
                New subfolder
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onRename(node)}
                data-testid={`menu-rename-folder-${node.id}`}
              >
                <Pencil className="w-4 h-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(node)}
                className="text-red-600 focus:text-red-700"
                data-testid={`menu-delete-folder-${node.id}`}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderNode
              key={child.id}
              node={child}
              siteId={siteId}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              selectedSiteId={selectedSiteId}
              onSelect={onSelect}
              countFor={countFor}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              onCreateSubfolder={onCreateSubfolder}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Renders the folder tree for one site (primary or a microsite): its folder
// nodes at the given base depth. Shared by both sections.
function FolderTree({
  folders,
  siteId,
  baseDepth,
  selectedFolderId,
  selectedSiteId,
  onSelect,
  countFor,
  expanded,
  toggleExpanded,
  onCreateSubfolder,
  onRename,
  onDelete,
}) {
  const tree = buildFolderTree(folders);
  return tree.map((node) => (
    <FolderNode
      key={node.id}
      node={node}
      siteId={siteId}
      depth={baseDepth}
      selectedFolderId={selectedFolderId}
      selectedSiteId={selectedSiteId}
      onSelect={onSelect}
      countFor={countFor}
      expanded={expanded}
      toggleExpanded={toggleExpanded}
      onCreateSubfolder={onCreateSubfolder}
      onRename={onRename}
      onDelete={onDelete}
    />
  ));
}

/**
 * Left-hand folder pane for the page manager.
 *
 * Two areas:
 *   1. Primary-site folders (All pages / Unfiled / folder tree) — folders with
 *      no microsite_id, pages with no microsite_id.
 *   2. A "Microsites" section — each microsite is an expandable container with
 *      its own folder tree + Unfiled view; folders/pages scoped to that
 *      microsite_id.
 *
 * Selection is a (siteId, folderId) pair:
 *   - siteId: null (primary) | <micrositeId>
 *   - folderId: 'all' | 'root' | <folderId>
 * countFor(viewKey, siteId) returns the page count for that view in that site.
 */
export default function PageFolderSidebar({
  primaryFolders,
  microsites = [],
  micrositeFoldersById = {},
  selectedSiteId,
  selectedFolderId,
  onSelect,
  countFor,
  onCreateFolder,
  onCreateSubfolder,
  onRename,
  onDelete,
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  // Which microsite containers are open. Default: all collapsed.
  const [openMicrosites, setOpenMicrosites] = useState(() => new Set());

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMicrosite = (id) => {
    setOpenMicrosites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const primaryTree = buildFolderTree(primaryFolders);

  return (
    <div className="w-full space-y-1">
      {/* ---- Primary site ---- */}
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Folders
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => onCreateFolder(null)}
          title="New folder"
          data-testid="button-new-folder"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      <DroppableRow
        droppableId="siteview:__primary__:all"
        droppable={false}
        selected={selectedSiteId === null && selectedFolderId === "all"}
        onSelect={() => onSelect(null, "all")}
        icon={<Layers className="w-4 h-4" />}
        label="All pages"
        count={countFor("all", null)}
        testId="view-all-pages"
      />

      <DroppableRow
        droppableId="siteview:__primary__:root"
        selected={selectedSiteId === null && selectedFolderId === "root"}
        onSelect={() => onSelect(null, "root")}
        icon={<Folder className="w-4 h-4" />}
        label="Unfiled"
        count={countFor("root", null)}
        testId="view-unfiled"
      />

      {primaryTree.length > 0 && <div className="h-px bg-slate-200 my-1 mx-2" />}

      <FolderTree
        folders={primaryFolders}
        siteId={null}
        baseDepth={0}
        selectedFolderId={selectedFolderId}
        selectedSiteId={selectedSiteId}
        onSelect={onSelect}
        countFor={countFor}
        expanded={expanded}
        toggleExpanded={toggleExpanded}
        onCreateSubfolder={onCreateSubfolder}
        onRename={onRename}
        onDelete={onDelete}
      />

      {/* ---- Microsites ---- */}
      {microsites.length > 0 && (
        <div className="pt-3">
          <div className="px-2 pb-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Microsites
            </span>
          </div>

          {microsites.map((m) => {
            const isOpen = openMicrosites.has(m.id);
            const mFolders = micrositeFoldersById[m.id] || [];
            return (
              <div key={m.id} data-testid={`microsite-section-${m.id}`}>
                <DroppableRow
                  droppableId={`siteview:${m.id}:all`}
                  droppable={false}
                  selected={selectedSiteId === m.id && selectedFolderId === "all"}
                  onSelect={() => onSelect(m.id, "all")}
                  testId={`microsite-row-${m.id}`}
                  expandControl={
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMicrosite(m.id);
                      }}
                      className="text-slate-400 hover:text-slate-600"
                      data-testid={`button-toggle-microsite-${m.id}`}
                    >
                      {isOpen ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                  }
                  icon={<Globe className="w-4 h-4" />}
                  label={m.name}
                  count={countFor("all", m.id)}
                  actions={
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateFolder(m.id);
                      }}
                      title="New folder in this microsite"
                      data-testid={`button-new-folder-microsite-${m.id}`}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  }
                />

                {isOpen && (
                  <div>
                    <DroppableRow
                      droppableId={`siteview:${m.id}:root`}
                      selected={
                        selectedSiteId === m.id && selectedFolderId === "root"
                      }
                      onSelect={() => onSelect(m.id, "root")}
                      depth={1}
                      icon={<Folder className="w-4 h-4" />}
                      label="Unfiled"
                      count={countFor("root", m.id)}
                      testId={`microsite-unfiled-${m.id}`}
                    />
                    <FolderTree
                      folders={mFolders}
                      siteId={m.id}
                      baseDepth={1}
                      selectedFolderId={selectedFolderId}
                      selectedSiteId={selectedSiteId}
                      onSelect={onSelect}
                      countFor={countFor}
                      expanded={expanded}
                      toggleExpanded={toggleExpanded}
                      onCreateSubfolder={onCreateSubfolder}
                      onRename={onRename}
                      onDelete={onDelete}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
