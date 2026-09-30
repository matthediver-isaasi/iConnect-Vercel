import { useState, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Link, Unlink } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function parsePaddingShorthand(padding) {
  if (!padding) return { top: '0', right: '0', bottom: '0', left: '0' };

  if (typeof padding === 'object' && padding.top !== undefined) {
    return {
      top: String(parseInt(padding.top) || 0),
      right: String(parseInt(padding.right) || 0),
      bottom: String(parseInt(padding.bottom) || 0),
      left: String(parseInt(padding.left) || 0),
    };
  }

  const parts = String(padding).trim().split(/\s+/).map(p => String(parseInt(p) || 0));

  switch (parts.length) {
    case 1:
      return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
    case 2:
      return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
    case 3:
      return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
    case 4:
      return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] };
    default:
      return { top: '0', right: '0', bottom: '0', left: '0' };
  }
}

export function getIndividualValues(styles, prefix) {
  const top = styles[`${prefix}Top`];
  const right = styles[`${prefix}Right`];
  const bottom = styles[`${prefix}Bottom`];
  const left = styles[`${prefix}Left`];

  if (top !== undefined || right !== undefined || bottom !== undefined || left !== undefined) {
    return {
      top: String(parseInt(top) || 0),
      right: String(parseInt(right) || 0),
      bottom: String(parseInt(bottom) || 0),
      left: String(parseInt(left) || 0),
    };
  }

  const shorthand = styles[prefix];
  if (shorthand) {
    return parsePaddingShorthand(shorthand);
  }

  return { top: '0', right: '0', bottom: '0', left: '0' };
}

export function spacingToStyle(values) {
  return {
    top: `${values.top}px`,
    right: `${values.right}px`,
    bottom: `${values.bottom}px`,
    left: `${values.left}px`,
  };
}

export function spacingToMjml(values) {
  return `${values.top || 0}px ${values.right || 0}px ${values.bottom || 0}px ${values.left || 0}px`;
}

export default function SpacingControl({ label, prefix, styles, onChange, hint }) {
  const values = getIndividualValues(styles, prefix);
  const allSame = values.top === values.right && values.right === values.bottom && values.bottom === values.left;
  const [linked, setLinked] = useState(allSame);

  const handleChange = useCallback((side, rawValue) => {
    const val = String(Math.max(0, parseInt(rawValue) || 0));

    if (linked) {
      onChange({
        [`${prefix}Top`]: val,
        [`${prefix}Right`]: val,
        [`${prefix}Bottom`]: val,
        [`${prefix}Left`]: val,
      });
    } else {
      onChange({
        [`${prefix}Top`]: values.top,
        [`${prefix}Right`]: values.right,
        [`${prefix}Bottom`]: values.bottom,
        [`${prefix}Left`]: values.left,
        [`${prefix}${side}`]: val,
      });
    }
  }, [linked, values, prefix, onChange]);

  const toggleLinked = useCallback(() => {
    if (!linked) {
      onChange({
        [`${prefix}Top`]: values.top,
        [`${prefix}Right`]: values.top,
        [`${prefix}Bottom`]: values.top,
        [`${prefix}Left`]: values.top,
      });
    }
    setLinked(!linked);
  }, [linked, values, prefix, onChange]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-1">
        <Label className="text-xs font-medium">{label}</Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleLinked}
              data-testid={`button-link-${prefix}`}
            >
              {linked ? <Link className="h-3 w-3" /> : <Unlink className="h-3 w-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {linked ? 'Unlink sides for independent values' : 'Link all sides to same value'}
          </TooltipContent>
        </Tooltip>
      </div>

      {hint && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}

      {linked ? (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground w-12">All</Label>
          <Input
            type="number"
            min="0"
            value={values.top}
            onChange={(e) => handleChange('Top', e.target.value)}
            className="h-8 text-xs"
            data-testid={`input-${prefix}-all`}
          />
          <span className="text-xs text-muted-foreground">px</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {[
            { key: 'Top', label: 'Top' },
            { key: 'Bottom', label: 'Bottom' },
            { key: 'Left', label: 'Left' },
            { key: 'Right', label: 'Right' },
          ].map(({ key, label: sideLabel }) => (
            <div key={key} className="flex items-center gap-1">
              <Label className="text-xs text-muted-foreground w-8 shrink-0">{sideLabel}</Label>
              <Input
                type="number"
                min="0"
                value={values[key.toLowerCase()]}
                onChange={(e) => handleChange(key, e.target.value)}
                className="h-8 text-xs"
                data-testid={`input-${prefix}-${key.toLowerCase()}`}
              />
              <span className="text-xs text-muted-foreground">px</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
