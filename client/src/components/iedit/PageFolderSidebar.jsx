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
} from "lucide-react";

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
  depth,
  selectedFolderId,
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
        selected={selectedFolderId === node.id}
        onSelect={() => onSelect(node.id)}
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
        count={countFor(node.id)}
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
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
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

/**
 * Left-hand folder pane for the page manager.
 * selectedFolderId: 'all' | 'root' | <folderId>
 * countFor(id): returns the page count for a view key ('all' | 'root' | folderId)
 */
export default function PageFolderSidebar({
  folders,
  selectedFolderId,
  onSelect,
  countFor,
  onCreateFolder,
  onCreateSubfolder,
  onRename,
  onDelete,
}) {
  const tree = buildFolderTree(folders);
  const [expanded, setExpanded] = useState(() => new Set());

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="w-full space-y-1">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Folders
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={onCreateFolder}
          title="New folder"
          data-testid="button-new-folder"
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      <DroppableRow
        droppableId="view:all"
        droppable={false}
        selected={selectedFolderId === "all"}
        onSelect={() => onSelect("all")}
        icon={<Layers className="w-4 h-4" />}
        label="All pages"
        count={countFor("all")}
        testId="view-all-pages"
      />

      <DroppableRow
        droppableId="view:root"
        selected={selectedFolderId === "root"}
        onSelect={() => onSelect("root")}
        icon={<Folder className="w-4 h-4" />}
        label="Unfiled"
        count={countFor("root")}
        testId="view-unfiled"
      />

      {tree.length > 0 && <div className="h-px bg-slate-200 my-1 mx-2" />}

      {tree.map((node) => (
        <FolderNode
          key={node.id}
          node={node}
          depth={0}
          selectedFolderId={selectedFolderId}
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
  );
}
