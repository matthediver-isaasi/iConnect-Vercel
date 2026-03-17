import { useRef, useCallback, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Printer } from "lucide-react";

const FONT_SIZE_MAP = {
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.25rem',
  '2xl': '1.5rem',
  '3xl': '1.875rem',
};

const ZONE_DEFAULTS = {
  header:    { source: 'static', static_text: '', font_size: 'sm', font_weight: 'normal' },
  primary:   { source: 'static', static_text: '', font_size: '2xl', font_weight: 'bold' },
  secondary: { source: 'static', static_text: '', font_size: 'lg', font_weight: 'normal' },
  tertiary:  { source: 'static', static_text: '', font_size: 'base', font_weight: 'normal' },
  footer:    { source: 'static', static_text: '', font_size: 'sm', font_weight: 'normal' },
};

const STYLE_DEFAULTS = {
  background_color: '#ffffff',
  border_color: '#e2e8f0',
  accent_color: '#3b82f6',
  width: 350,
  height: 220,
};

function resolvePrefillValue(prefillField, prefillData) {
  if (!prefillField || !prefillData) return '';
  if (prefillField.startsWith('booking:')) {
    return prefillData.booking?.[prefillField.replace('booking:', '')] || '';
  }
  if (prefillField.startsWith('member:')) {
    return prefillData.member?.[prefillField.replace('member:', '')] || '';
  }
  if (prefillField.startsWith('org:')) {
    return prefillData.organization?.[prefillField.replace('org:', '')] || '';
  }
  if (prefillField.startsWith('member_custom:')) {
    const cfId = prefillField.replace('member_custom:', '');
    const cfv = prefillData.memberCustomValues?.find(v => v.field_id === cfId);
    return cfv?.value || '';
  }
  if (prefillField.startsWith('org_custom:')) {
    const cfId = prefillField.replace('org_custom:', '');
    const cfv = prefillData.orgCustomValues?.find(v => v.field_id === cfId);
    return cfv?.value || '';
  }
  return '';
}

function BadgeZoneDisplay({ text, zone, isPreview }) {
  const fontSize = FONT_SIZE_MAP[zone?.font_size] || FONT_SIZE_MAP.base;
  const fontWeight = zone?.font_weight || 'normal';
  const isEmpty = !text;

  return (
    <div
      style={{
        fontSize,
        fontWeight,
        lineHeight: 1.3,
        textAlign: 'center',
        color: isEmpty ? '#94a3b8' : '#1e293b',
        fontStyle: isEmpty ? 'italic' : 'normal',
        minHeight: fontSize,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        padding: '0 12px',
        width: '100%',
      }}
    >
      {isEmpty && isPreview
        ? `[${zone?.source === 'input' ? (zone.input_label || 'Input') : zone?.source === 'prefill_readonly' ? 'Prefill' : 'Static'}]`
        : text || '\u00A0'}
    </div>
  );
}

function BadgeZoneInput({ zone, zoneName, value, onZoneChange, isPreview }) {
  const fontSize = FONT_SIZE_MAP[zone?.font_size] || FONT_SIZE_MAP.base;
  const fontWeight = zone?.font_weight || 'normal';
  const inputType = zone.input_type || 'text';

  if (isPreview) {
    return (
      <BadgeZoneDisplay
        text={value || ''}
        zone={zone}
        isPreview={true}
      />
    );
  }

  if (inputType === 'select') {
    const options = zone.input_options || [];
    const normalizedValue = (value && options.includes(value)) ? value : '';
    return (
      <div style={{ width: '100%', padding: '0 12px' }}>
        <Select
          value={normalizedValue}
          onValueChange={(val) => onZoneChange(zoneName, val)}
        >
          <SelectTrigger
            className="border-slate-200 bg-white/80"
            style={{ fontSize, fontWeight, textAlign: 'center', height: 'auto', minHeight: '2rem' }}
            data-testid={`select-badge-${zoneName}`}
          >
            <SelectValue placeholder={zone.input_placeholder || zone.input_label || 'Select...'} />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', padding: '0 12px' }}>
      <Input
        value={value || ''}
        onChange={(e) => onZoneChange(zoneName, e.target.value)}
        placeholder={zone.input_placeholder || zone.input_label || ''}
        className="border-slate-200 bg-white/80 text-center"
        style={{ fontSize, fontWeight, height: 'auto', minHeight: '2rem', padding: '2px 8px' }}
        data-testid={`input-badge-${zoneName}`}
      />
    </div>
  );
}

export default function NameCardBadge({ zones, cardStyle, value = {}, onChange, prefillData = null, isPreview = false, showPrint = true, disabled = false }) {
  const badgeRef = useRef(null);
  const mergedZones = {};
  for (const key of Object.keys(ZONE_DEFAULTS)) {
    const raw = { ...ZONE_DEFAULTS[key], ...(zones?.[key] || {}) };
    if (raw.source === 'prefill') {
      raw.source = 'prefill_readonly';
    }
    if (raw.source === 'field') {
      raw.source = 'static';
      raw.static_text = raw.static_text || '';
    }
    mergedZones[key] = raw;
  }
  const style = { ...STYLE_DEFAULTS, ...(cardStyle || {}) };

  const compositeValue = useMemo(() => {
    const result = { ...(value || {}) };
    for (const [zoneName, zone] of Object.entries(mergedZones)) {
      if (zone.source === 'static') {
        result[zoneName] = zone.static_text || '';
      } else if (zone.source === 'prefill_readonly') {
        result[zoneName] = resolvePrefillValue(zone.prefill_field, prefillData);
      }
    }
    return result;
  }, [value, mergedZones, prefillData]);

  const syncedRef = useRef(false);
  useEffect(() => {
    if (!onChange || isPreview) return;
    const current = value || {};
    let hasDerivedZones = false;
    let needsSync = false;
    for (const [zoneName, zone] of Object.entries(mergedZones)) {
      if (zone.source === 'static' || zone.source === 'prefill_readonly') {
        hasDerivedZones = true;
        const derived = compositeValue[zoneName] || '';
        if (current[zoneName] !== derived) {
          needsSync = true;
          break;
        }
      }
    }
    if (needsSync || (hasDerivedZones && !syncedRef.current)) {
      syncedRef.current = true;
      onChange(compositeValue);
    }
  }, [compositeValue, isPreview]);

  const handleZoneChange = useCallback((zoneName, val) => {
    const updated = { ...compositeValue, [zoneName]: val };
    onChange?.(updated);
  }, [compositeValue, onChange]);

  const handlePrint = useCallback(() => {
    if (!badgeRef.current) return;
    const clone = badgeRef.current.cloneNode(true);
    clone.querySelectorAll('input, select, button').forEach(el => {
      const span = document.createElement('span');
      span.textContent = el.value || el.textContent || '';
      span.style.cssText = el.style.cssText;
      el.parentNode.replaceChild(span, el);
    });
    const printWindow = window.open('', '_blank', 'width=600,height=400');
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Name Badge</title>
          <style>
            body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #fff; }
            @media print { body { margin: 0; padding: 0; } @page { size: auto; margin: 10mm; } }
          </style>
        </head>
        <body>${clone.outerHTML}</body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 250);
  }, []);

  const renderZone = (zoneName) => {
    const zone = mergedZones[zoneName];
    const zoneValue = compositeValue[zoneName] || '';

    if (zone.source === 'input' && !disabled) {
      return (
        <BadgeZoneInput
          zone={zone}
          zoneName={zoneName}
          value={zoneValue}
          onZoneChange={handleZoneChange}
          isPreview={isPreview}
        />
      );
    }

    return (
      <BadgeZoneDisplay
        text={zoneValue}
        zone={zone}
        isPreview={isPreview}
      />
    );
  };

  return (
    <div className="flex flex-col items-center gap-3" data-testid="name-card-badge-wrapper">
      <div
        ref={badgeRef}
        data-testid="name-card-badge"
        style={{
          width: `${style.width}px`,
          minHeight: `${style.height}px`,
          backgroundColor: style.background_color,
          border: `2px solid ${style.border_color}`,
          borderRadius: '12px',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        }}
      >
        <div
          style={{
            height: '6px',
            backgroundColor: style.accent_color,
            flexShrink: 0,
          }}
        />

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '4px',
            padding: '12px 8px',
          }}
        >
          {renderZone('header')}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', width: '100%', justifyContent: 'center' }}>
            {renderZone('primary')}
          </div>
          {renderZone('secondary')}
          {renderZone('tertiary')}
        </div>

        <div
          style={{
            borderTop: `1px solid ${style.border_color}`,
            padding: '6px 12px',
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: `${style.accent_color}10`,
          }}
        >
          {renderZone('footer')}
        </div>
      </div>

      {showPrint && !isPreview && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handlePrint}
          data-testid="button-print-badge"
        >
          <Printer className="w-4 h-4 mr-2" />
          Print Badge
        </Button>
      )}
    </div>
  );
}

export { ZONE_DEFAULTS, STYLE_DEFAULTS, FONT_SIZE_MAP };
