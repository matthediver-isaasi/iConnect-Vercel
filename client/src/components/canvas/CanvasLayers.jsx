import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Square,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Trash2,
  Copy,
  GripVertical,
  Layers,
  CircleAlert,
  AlertTriangle,
  Info,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Ungroup as UngroupIcon,
} from 'lucide-react';
import { resolveBlockAtBreakpoint } from '@/lib/canvasDesign';
import { SEVERITY, worstSeverity } from '@/lib/canvasA11y';

const SEV_ICON = {
  [SEVERITY.ERROR]: CircleAlert,
  [SEVERITY.WARNING]: AlertTriangle,
  [SEVERITY.INFO]: Info,
};
const SEV_CLASS = {
  [SEVERITY.ERROR]: 'text-destructive',
  [SEVERITY.WARNING]: 'text-warning',
  [SEVERITY.INFO]: 'text-slate-400',
};

function LayerRow({
  block,
  isSelected,
  breakpoint,
  issues,
  indented = false,
  onSelect,
  onToggleHidden,
  onToggleLocked,
  onDelete,
  onDuplicate,
  onRename,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.name);
  const geom = resolveBlockAtBreakpoint(block, breakpoint);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 px-2 py-1.5 rounded text-sm select-none ${
        indented ? 'ml-5' : ''
      } ${
        isSelected ? 'bg-primary/15 ring-1 ring-primary/30' : 'bg-slate-50 hover-elevate'
      } ${geom.hidden ? 'opacity-60' : ''}`}
      data-testid={`layer-${block.id}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.id, e.shiftKey);
      }}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => e.stopPropagation()}
        data-testid={`layer-drag-${block.id}`}
      >
        <GripVertical className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <Square className="w-3.5 h-3.5 text-slate-500 shrink-0" />
      {(() => {
        const sev = worstSeverity(issues);
        if (!sev) return null;
        const Icon = SEV_ICON[sev];
        const tip = issues.map((i) => i.message).join('\n');
        return (
          <span
            className={`shrink-0 ${SEV_CLASS[sev]}`}
            title={tip}
            data-testid={`layer-a11y-${block.id}`}
            data-severity={sev}
          >
            <Icon className="w-3.5 h-3.5" />
          </span>
        );
      })()}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            onRename(block.id, draft.trim() || 'Box');
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(block.name);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 text-xs px-1 py-0.5 rounded border border-slate-300 bg-white"
          data-testid={`layer-rename-input-${block.id}`}
        />
      ) : (
        <span
          className="flex-1 min-w-0 truncate text-xs"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(block.name);
            setEditing(true);
          }}
          data-testid={`layer-name-${block.id}`}
        >
          {block.name}
        </span>
      )}
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onToggleLocked(block.id); }}
        title={block.locked ? 'Unlock' : 'Lock'}
        data-testid={`layer-lock-${block.id}`}
      >
        {block.locked ? <Lock className="w-3.5 h-3.5 text-slate-500" /> : <Unlock className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onToggleHidden(block.id); }}
        title={geom.hidden ? 'Show' : 'Hide'}
        data-testid={`layer-visibility-${block.id}`}
      >
        {geom.hidden ? <EyeOff className="w-3.5 h-3.5 text-slate-500" /> : <Eye className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onDuplicate(block.id); }}
        title="Duplicate"
        data-testid={`layer-duplicate-${block.id}`}
      >
        <Copy className="w-3.5 h-3.5 text-slate-400" />
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200 hover:text-destructive"
        onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
        title="Delete"
        data-testid={`layer-delete-${block.id}`}
      >
        <Trash2 className="w-3.5 h-3.5 text-slate-400" />
      </button>
    </div>
  );
}

function GroupRow({
  group,
  members,
  breakpoint,
  isSelected,
  onSelectGroup,
  onRenameGroup,
  onToggleCollapsed,
  onToggleHidden,
  onToggleLocked,
  onUngroup,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `grp:${group.id}`,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  // Group state is derived from its members: hidden/locked only when ALL
  // members are hidden/locked at the current breakpoint.
  const allHidden = members.length > 0 && members.every((b) => resolveBlockAtBreakpoint(b, breakpoint).hidden);
  const allLocked = members.length > 0 && members.every((b) => b.locked);
  const collapsed = !!group.collapsed;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 px-2 py-1.5 rounded text-sm select-none ${
        isSelected ? 'bg-primary/15 ring-1 ring-primary/30' : 'bg-slate-100 hover-elevate'
      } ${allHidden ? 'opacity-60' : ''}`}
      data-testid={`group-row-${group.id}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelectGroup(group.id, e.shiftKey);
      }}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => e.stopPropagation()}
        data-testid={`group-drag-${group.id}`}
      >
        <GripVertical className="w-3.5 h-3.5 text-slate-400" />
      </div>
      <button
        className="p-0.5 rounded hover:bg-slate-200 shrink-0"
        onClick={(e) => { e.stopPropagation(); onToggleCollapsed(group.id); }}
        title={collapsed ? 'Expand' : 'Collapse'}
        data-testid={`group-collapse-${group.id}`}
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
      </button>
      {collapsed
        ? <Folder className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        : <FolderOpen className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            onRenameGroup(group.id, draft.trim() || group.name);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraft(group.name);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 text-xs px-1 py-0.5 rounded border border-slate-300 bg-white"
          data-testid={`group-rename-input-${group.id}`}
        />
      ) : (
        <span
          className="flex-1 min-w-0 truncate text-xs font-medium"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(group.name);
            setEditing(true);
          }}
          data-testid={`group-name-${group.id}`}
        >
          {group.name}
          <span className="ml-1 text-slate-400 font-normal">({members.length})</span>
        </span>
      )}
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onToggleLocked(group.id); }}
        title={allLocked ? 'Unlock group' : 'Lock group'}
        data-testid={`group-lock-${group.id}`}
      >
        {allLocked ? <Lock className="w-3.5 h-3.5 text-slate-500" /> : <Unlock className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onToggleHidden(group.id); }}
        title={allHidden ? 'Show group' : 'Hide group'}
        data-testid={`group-visibility-${group.id}`}
      >
        {allHidden ? <EyeOff className="w-3.5 h-3.5 text-slate-500" /> : <Eye className="w-3.5 h-3.5 text-slate-400" />}
      </button>
      <button
        className="p-0.5 rounded hover:bg-slate-200"
        onClick={(e) => { e.stopPropagation(); onUngroup(group.id); }}
        title="Ungroup"
        data-testid={`group-ungroup-${group.id}`}
      >
        <UngroupIcon className="w-3.5 h-3.5 text-slate-400" />
      </button>
    </div>
  );
}

export default function CanvasLayers({
  blocks,
  groups = [],
  selectedIds,
  breakpoint,
  issuesByBlock,
  onSelect,
  onReorder,
  onToggleHidden,
  onToggleLocked,
  onDelete,
  onDuplicate,
  onRename,
  onSelectGroup,
  onRenameGroup,
  onToggleGroupCollapsed,
  onToggleGroupHidden,
  onToggleGroupLocked,
  onUngroup,
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Layers list: top-most z-order first (reverse of array, since later in
  // array = visually on top in stage). We display top->bottom.
  const ordered = [...blocks].reverse();
  const blocksById = Object.fromEntries(blocks.map((b) => [b.id, b]));
  const groupsById = Object.fromEntries(groups.map((g) => [g.id, g]));

  // Members of each group, in display (top->bottom) order.
  const membersByGroup = {};
  for (const g of groups) membersByGroup[g.id] = [];
  for (const b of ordered) {
    if (b.groupId && membersByGroup[b.groupId]) membersByGroup[b.groupId].push(b);
  }

  // Build the top-level display list. A group is emitted at the position of
  // its top-most member; ungrouped blocks render inline.
  const topLevel = [];
  const emittedGroups = new Set();
  for (const b of ordered) {
    if (b.groupId && groupsById[b.groupId]) {
      if (!emittedGroups.has(b.groupId)) {
        emittedGroups.add(b.groupId);
        topLevel.push({ kind: 'group', gid: b.groupId });
      }
    } else {
      topLevel.push({ kind: 'block', id: b.id });
    }
  }

  const topLevelSortableId = (item) => (item.kind === 'block' ? item.id : `grp:${item.gid}`);

  // Flatten a top-level order + per-group member order back into storage
  // order (bottom->top), returning block objects for onReorder.
  const flattenToStorage = (topOrder, memberOrder) => {
    const displayIds = [];
    for (const item of topOrder) {
      if (item.kind === 'block') displayIds.push(item.id);
      else displayIds.push(...memberOrder[item.gid].map((b) => b.id));
    }
    return displayIds.reverse().map((id) => blocksById[id]);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    // --- Member drag: reorder within the SAME group only ---
    const activeBlock = blocksById[activeId];
    if (activeBlock && activeBlock.groupId) {
      const gid = activeBlock.groupId;
      const members = membersByGroup[gid] || [];
      const memberIds = members.map((b) => b.id);
      if (!memberIds.includes(overId)) return; // don't allow dragging out of a group
      const oldIdx = memberIds.indexOf(activeId);
      const newIdx = memberIds.indexOf(overId);
      const newMembers = arrayMove(members, oldIdx, newIdx);
      const nextMemberOrder = { ...membersByGroup, [gid]: newMembers };
      onReorder(flattenToStorage(topLevel, nextMemberOrder));
      return;
    }

    // --- Top-level drag (ungrouped block or whole group) ---
    const overContainerId = (() => {
      if (overId.startsWith('grp:')) return overId;
      const ob = blocksById[overId];
      if (ob && ob.groupId) return `grp:${ob.groupId}`;
      return overId;
    })();
    const ids = topLevel.map(topLevelSortableId);
    const oldIdx = ids.indexOf(activeId);
    const newIdx = ids.indexOf(overContainerId);
    if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
    const newTop = arrayMove(topLevel, oldIdx, newIdx);
    onReorder(flattenToStorage(newTop, membersByGroup));
  };

  // Whether every member of a group is currently selected.
  const groupSelected = (gid) => {
    const members = membersByGroup[gid] || [];
    return members.length > 0 && members.every((b) => selectedIds.includes(b.id));
  };

  return (
    <div className="space-y-2" data-testid="canvas-layers">
      <div className="flex items-center gap-2">
        <Layers className="w-4 h-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-900">Layers</h2>
      </div>
      {blocks.length === 0 ? (
        <p className="text-xs text-slate-500" data-testid="layers-empty">No elements yet.</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={topLevel.map(topLevelSortableId)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {topLevel.map((item) => {
                if (item.kind === 'block') {
                  const b = blocksById[item.id];
                  if (!b) return null;
                  return (
                    <LayerRow
                      key={b.id}
                      block={b}
                      isSelected={selectedIds.includes(b.id)}
                      breakpoint={breakpoint}
                      issues={issuesByBlock?.get?.(b.id) || []}
                      onSelect={onSelect}
                      onToggleHidden={onToggleHidden}
                      onToggleLocked={onToggleLocked}
                      onDelete={onDelete}
                      onDuplicate={onDuplicate}
                      onRename={onRename}
                    />
                  );
                }
                const group = groupsById[item.gid];
                if (!group) return null;
                const members = membersByGroup[item.gid] || [];
                return (
                  <div key={`grp:${item.gid}`} className="space-y-1">
                    <GroupRow
                      group={group}
                      members={members}
                      breakpoint={breakpoint}
                      isSelected={groupSelected(item.gid)}
                      onSelectGroup={onSelectGroup}
                      onRenameGroup={onRenameGroup}
                      onToggleCollapsed={onToggleGroupCollapsed}
                      onToggleHidden={onToggleGroupHidden}
                      onToggleLocked={onToggleGroupLocked}
                      onUngroup={onUngroup}
                    />
                    {!group.collapsed && (
                      <SortableContext items={members.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                        <div className="space-y-1">
                          {members.map((b) => (
                            <LayerRow
                              key={b.id}
                              block={b}
                              indented
                              isSelected={selectedIds.includes(b.id)}
                              breakpoint={breakpoint}
                              issues={issuesByBlock?.get?.(b.id) || []}
                              onSelect={onSelect}
                              onToggleHidden={onToggleHidden}
                              onToggleLocked={onToggleLocked}
                              onDelete={onDelete}
                              onDuplicate={onDuplicate}
                              onRename={onRename}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    )}
                  </div>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
