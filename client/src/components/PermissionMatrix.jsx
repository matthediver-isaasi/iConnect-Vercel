import { useState, useRef, useCallback } from "react";
import { Pencil, Eye, EyeOff, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PERMISSIONS = [
  { value: 'read_write', label: 'Read & Write', shortLabel: 'R/W', icon: Pencil, bg: 'bg-green-100 dark:bg-green-900/40', text: 'text-green-700 dark:text-green-300', border: 'border-green-200 dark:border-green-800' },
  { value: 'read', label: 'Read Only', shortLabel: 'Read', icon: Eye, bg: 'bg-blue-100 dark:bg-blue-900/40', text: 'text-blue-700 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-800' },
  { value: 'hidden', label: 'Hidden', shortLabel: 'Hide', icon: EyeOff, bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-500 dark:text-gray-400', border: 'border-gray-200 dark:border-gray-700' },
];

function getPermConfig(value) {
  return PERMISSIONS.find(p => p.value === value) || PERMISSIONS[0];
}

function cyclePermission(current) {
  const idx = PERMISSIONS.findIndex(p => p.value === current);
  return PERMISSIONS[(idx + 1) % PERMISSIONS.length].value;
}

function PermissionCell({ permission, onChange }) {
  const config = getPermConfig(permission);
  const Icon = config.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onChange}
          className={`w-full h-8 flex items-center justify-center rounded-md border ${config.bg} ${config.text} ${config.border} transition-colors cursor-pointer`}
          data-testid={`perm-cell`}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {config.label}
      </TooltipContent>
    </Tooltip>
  );
}

function BulkDropdown({ label, onSelect, testId }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs gap-0.5" data-testid={testId}>
          <ChevronDown className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[140px]">
        <div className="px-2 py-1 text-xs text-muted-foreground font-medium">Set all to:</div>
        {PERMISSIONS.map(p => {
          const Icon = p.icon;
          return (
            <DropdownMenuItem key={p.value} onClick={() => onSelect(p.value)} data-testid={`bulk-set-${p.value}`}>
              <Icon className="w-3.5 h-3.5 mr-2" />
              {p.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function PermissionMatrix({
  fieldGroups,
  roles,
  permissionsByRole,
  onPermissionChange,
  onBulkFieldChange,
  onBulkRoleChange,
  isLoading,
}) {
  const scrollRef = useRef(null);

  const getPermission = useCallback((roleId, fieldKey) => {
    return permissionsByRole?.[roleId]?.[fieldKey] || 'read_write';
  }, [permissionsByRole]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!roles.length) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No roles found.
      </div>
    );
  }

  const allFields = fieldGroups.flatMap(g => g.fields);

  return (
    <div className="border rounded-lg overflow-hidden">
      <div ref={scrollRef} className="overflow-x-auto">
        <table className="w-full border-collapse" style={{ minWidth: `${160 + roles.length * 72}px` }}>
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="sticky left-0 z-20 bg-muted/90 backdrop-blur-sm text-left p-2 min-w-[160px] border-r">
                <span className="text-sm font-medium text-muted-foreground">Field</span>
              </th>
              {roles.map(role => (
                <th key={role.id} className="p-1 min-w-[68px] text-center border-r last:border-r-0 align-bottom">
                  <div className="flex flex-col items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs font-medium text-foreground leading-tight text-center break-words line-clamp-3 cursor-default" data-testid={`role-header-${role.id}`}>
                          {role.name}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">{role.name}</TooltipContent>
                    </Tooltip>
                    <BulkDropdown
                      label={role.name}
                      onSelect={(perm) => onBulkRoleChange(role.id, perm)}
                      testId={`bulk-role-${role.id}`}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fieldGroups.map((group, gi) => (
              <GroupRows
                key={gi}
                group={group}
                roles={roles}
                getPermission={getPermission}
                onPermissionChange={onPermissionChange}
                onBulkFieldChange={onBulkFieldChange}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t px-3 py-2 bg-muted/30">
        <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          <span className="font-medium">Legend:</span>
          {PERMISSIONS.map(p => {
            const Icon = p.icon;
            return (
              <span key={p.value} className="flex items-center gap-1">
                <span className={`inline-flex items-center justify-center w-5 h-5 rounded ${p.bg} ${p.text}`}>
                  <Icon className="w-3 h-3" />
                </span>
                {p.label}
              </span>
            );
          })}
          <span className="ml-auto italic">Click a cell to cycle permissions</span>
        </div>
      </div>
    </div>
  );
}

function GroupRows({ group, roles, getPermission, onPermissionChange, onBulkFieldChange }) {
  return (
    <>
      <tr className="bg-muted/30">
        <td
          colSpan={roles.length + 1}
          className="sticky left-0 z-10 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b"
        >
          {group.label}
        </td>
      </tr>
      {group.fields.map(field => {
        const fieldKey = field.key || field.id;
        return (
          <tr key={fieldKey} className="border-b last:border-b-0 hover:bg-muted/20 transition-colors">
            <td className="sticky left-0 z-10 bg-background border-r p-2 min-w-[160px]">
              <div className="flex items-center gap-1">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{field.label}</div>
                  {field.description && (
                    <div className="text-xs text-muted-foreground truncate">{field.description}</div>
                  )}
                </div>
                <BulkDropdown
                  label={field.label}
                  onSelect={(perm) => onBulkFieldChange(fieldKey, perm)}
                  testId={`bulk-field-${fieldKey}`}
                />
              </div>
            </td>
            {roles.map(role => (
              <td key={role.id} className="p-1 text-center border-r last:border-r-0">
                <PermissionCell
                  permission={getPermission(role.id, fieldKey)}
                  onChange={() => {
                    const current = getPermission(role.id, fieldKey);
                    onPermissionChange(role.id, fieldKey, cyclePermission(current));
                  }}
                />
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}
