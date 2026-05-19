import { useState, useEffect, useCallback } from 'react';
import { Clock, Bird } from 'lucide-react';

function getTimeRemaining(deadline) {
  const now = new Date();
  const diff = deadline.getTime() - now.getTime();
  if (diff <= 0) return null;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  return { days, hours, minutes, seconds, totalMs: diff };
}

export default function EarlyBirdCountdown({ deadline, onExpired, compact = false, className = '' }) {
  const [remaining, setRemaining] = useState(() => getTimeRemaining(new Date(deadline)));

  const checkExpiry = useCallback(() => {
    const r = getTimeRemaining(new Date(deadline));
    setRemaining(r);
    if (!r && onExpired) {
      onExpired();
    }
    return r;
  }, [deadline, onExpired]);

  useEffect(() => {
    const r = checkExpiry();
    if (!r) return;

    const interval = setInterval(() => {
      const updated = checkExpiry();
      if (!updated) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  }, [checkExpiry]);

  if (!remaining) return null;

  const parts = [];
  if (remaining.days > 0) parts.push(`${remaining.days}d`);
  if (remaining.hours > 0 || remaining.days > 0) parts.push(`${remaining.hours}h`);
  parts.push(`${remaining.minutes}m`);
  if (remaining.days === 0) parts.push(`${remaining.seconds}s`);

  const isUrgent = remaining.totalMs < 24 * 60 * 60 * 1000;

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs font-medium ${
          isUrgent ? 'text-red-600' : 'text-warning'
        }`}
        data-testid="text-early-bird-countdown"
      >
        <Clock className="h-3 w-3" />
        {parts.join(' ')}
      </span>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium ${
        isUrgent
          ? 'bg-red-50 text-red-700 border border-red-200'
          : 'bg-warning/10 text-warning border border-warning/30'
      } ${className}`}
      data-testid="text-early-bird-countdown"
    >
      <Bird className="h-4 w-4" />
      <span>Early bird ends in {parts.join(' ')}</span>
    </div>
  );
}
