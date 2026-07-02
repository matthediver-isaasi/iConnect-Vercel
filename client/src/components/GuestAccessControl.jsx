import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UserCheck, AlertTriangle, Clock, Infinity as InfinityIcon } from "lucide-react";
import { differenceInCalendarDays, format } from "date-fns";
import { toast } from "sonner";

export function getGuestStatus(member) {
  if (!member?.is_guest) return null;
  const expiresAtRaw = member.guest_expires_at;
  if (!expiresAtRaw) {
    return { kind: 'permanent', label: 'Permanent' };
  }
  const expiresAt = new Date(expiresAtRaw);
  if (Number.isNaN(expiresAt.getTime())) {
    return { kind: 'permanent', label: 'Permanent' };
  }
  const now = new Date();
  if (expiresAt.getTime() <= now.getTime()) {
    return { kind: 'expired', label: 'Expired', expiresAt };
  }
  const daysLeft = Math.max(0, differenceInCalendarDays(expiresAt, now));
  return {
    kind: 'active',
    label: daysLeft === 0 ? 'Less than a day left' : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`,
    daysLeft,
    expiresAt,
  };
}

function GuestAdjustPopover({ member, status, onUpdated, disabled, testIdSuffix }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [daysInput, setDaysInput] = useState('');

  const mutation = useMutation({
    mutationFn: async ({ guest_expires_at }) => {
      return await base44.entities.Member.update(member.id, {
        guest_expires_at,
        login_enabled: true,
      });
    },
    onSuccess: () => {
      toast.success('Guest access updated');
      setOpen(false);
      setDaysInput('');
      if (onUpdated) onUpdated();
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      queryClient.invalidateQueries({ queryKey: ['member-detail', member.id] });
      queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
    },
    onError: () => {
      toast.error('Failed to update guest access');
    },
  });

  const handleSetDays = () => {
    const days = parseInt(daysInput, 10);
    if (!Number.isFinite(days) || days < 1) {
      toast.error('Enter a number of days greater than 0');
      return;
    }
    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + days);
    mutation.mutate({ guest_expires_at: newExpiry.toISOString() });
  };

  const handleSetPermanent = () => {
    mutation.mutate({ guest_expires_at: null });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDaysInput(
            status?.kind === 'active' && status?.daysLeft
              ? String(status.daysLeft)
              : '30'
          );
        } else {
          setDaysInput('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          data-testid={`button-adjust-guest-${testIdSuffix || member.id}`}
        >
          Adjust
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="end">
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-900">Adjust guest access</p>
          <p className="text-xs text-slate-500">
            Set a new number of days from today, or grant permanent access.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            step={1}
            value={daysInput}
            onChange={(e) => setDaysInput(e.target.value)}
            className="w-24"
            data-testid={`input-guest-days-${testIdSuffix || member.id}`}
          />
          <span className="text-sm text-slate-600">days</span>
          <Button
            size="sm"
            onClick={handleSetDays}
            disabled={mutation.isPending}
            data-testid={`button-set-guest-days-${testIdSuffix || member.id}`}
          >
            Set
          </Button>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={handleSetPermanent}
          disabled={mutation.isPending}
          data-testid={`button-set-guest-permanent-${testIdSuffix || member.id}`}
        >
          <InfinityIcon className="w-4 h-4 mr-2" />
          Make Permanent
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export default function GuestAccessControl({
  member,
  canManage = false,
  onUpdated,
  layout = 'badge',
  testIdSuffix,
}) {
  const status = getGuestStatus(member);
  if (!status) return null;

  if (layout === 'inline-row') {
    return (
      <div className="flex items-center justify-between gap-2 flex-wrap pb-2 border-b border-slate-100">
        <span className="text-xs inline-flex items-center gap-1">
          {status.kind === 'expired' ? (
            <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          ) : status.kind === 'permanent' ? (
            <InfinityIcon className="w-3.5 h-3.5 text-slate-500" />
          ) : (
            <Clock className="w-3.5 h-3.5 text-warning" />
          )}
          <span
            className={
              status.kind === 'expired'
                ? 'text-red-600 font-medium'
                : 'text-slate-700'
            }
            data-testid={`text-guest-status-${testIdSuffix || member.id}`}
          >
            Guest access: {status.label}
          </span>
        </span>
        {canManage && (
          <GuestAdjustPopover
            member={member}
            status={status}
            onUpdated={onUpdated}
            testIdSuffix={testIdSuffix}
          />
        )}
      </div>
    );
  }

  const badgeText =
    status.kind === 'permanent'
      ? 'Guest: Permanent'
      : status.kind === 'expired'
        ? `Guest: Expired ${status.expiresAt ? format(status.expiresAt, 'd MMM yyyy') : ''}`.trim()
        : `Guest: Expires ${format(status.expiresAt, 'd MMM yyyy')}`;

  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap" data-testid={`guest-access-control-${testIdSuffix || member.id}`}>
      <Badge
        variant={status.kind === 'expired' ? 'destructive' : 'secondary'}
        className={status.kind === 'expired' ? '' : 'bg-warning/10 text-warning inline-flex items-center gap-1'}
        data-testid={`badge-guest-${testIdSuffix || member.id}`}
      >
        {status.kind === 'expired' ? (
          <AlertTriangle className="w-3 h-3 mr-1" />
        ) : status.kind === 'permanent' ? (
          <InfinityIcon className="w-3 h-3" />
        ) : (
          <UserCheck className="w-3 h-3" />
        )}
        {badgeText}
      </Badge>
      {canManage && (
        <GuestAdjustPopover
          member={member}
          status={status}
          onUpdated={onUpdated}
          testIdSuffix={testIdSuffix}
        />
      )}
    </div>
  );
}
