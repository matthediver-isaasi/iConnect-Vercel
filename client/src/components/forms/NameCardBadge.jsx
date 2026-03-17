import { useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
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
  header:    { source: 'static', static_text: '', field_id: '', prefill_field: '', font_size: 'sm', font_weight: 'normal' },
  primary:   { source: 'static', static_text: '', field_id: '', prefill_field: '', font_size: '2xl', font_weight: 'bold' },
  secondary: { source: 'static', static_text: '', field_id: '', prefill_field: '', font_size: 'lg', font_weight: 'normal' },
  tertiary:  { source: 'static', static_text: '', field_id: '', prefill_field: '', font_size: 'base', font_weight: 'normal' },
  footer:    { source: 'static', static_text: '', field_id: '', prefill_field: '', font_size: 'sm', font_weight: 'normal' },
};

const STYLE_DEFAULTS = {
  background_color: '#ffffff',
  border_color: '#e2e8f0',
  accent_color: '#3b82f6',
  width: 350,
  height: 220,
};

function resolveZoneValue(zone, formValues, formFields, prefillData) {
  if (!zone) return '';
  const source = zone.source || 'static';

  if (source === 'static') {
    return zone.static_text || '';
  }

  if (source === 'field') {
    const fieldId = zone.field_id;
    if (!fieldId) return '';
    const val = formValues?.[fieldId];
    if (val !== undefined && val !== null && val !== '' && typeof val !== 'object') return String(val);
    return '';
  }

  if (source === 'prefill') {
    const prefillField = zone.prefill_field;
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

  return '';
}

function BadgeZone({ zone, formValues, formFields, prefillData, accentColor, isPreview }) {
  const text = resolveZoneValue(zone, formValues, formFields, prefillData);
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
      }}
    >
      {isEmpty && isPreview ? `[${zone?.source === 'field' ? 'Form Field' : zone?.source === 'prefill' ? 'Prefill Data' : 'Static Text'}]` : text || '\u00A0'}
    </div>
  );
}

export default function NameCardBadge({ zones, cardStyle, formValues = {}, formFields = [], prefillData = null, isPreview = false, showPrint = true }) {
  const badgeRef = useRef(null);
  const mergedZones = {};
  for (const key of Object.keys(ZONE_DEFAULTS)) {
    mergedZones[key] = { ...ZONE_DEFAULTS[key], ...(zones?.[key] || {}) };
  }
  const style = { ...STYLE_DEFAULTS, ...(cardStyle || {}) };

  const handlePrint = useCallback(() => {
    if (!badgeRef.current) return;
    const printWindow = window.open('', '_blank', 'width=600,height=400');
    if (!printWindow) return;
    const badgeHtml = badgeRef.current.outerHTML;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Name Badge</title>
          <style>
            body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #fff; }
            @media print {
              body { margin: 0; padding: 0; }
              @page { size: auto; margin: 10mm; }
            }
          </style>
        </head>
        <body>${badgeHtml}</body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 250);
  }, []);

  return (
    <div className="flex flex-col items-center gap-3" data-testid="name-card-badge-wrapper">
      <div
        ref={badgeRef}
        data-testid="name-card-badge"
        style={{
          width: `${style.width}px`,
          height: `${style.height}px`,
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
          <BadgeZone zone={mergedZones.header} formValues={formValues} formFields={formFields} prefillData={prefillData} accentColor={style.accent_color} isPreview={isPreview} />
          <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
            <BadgeZone zone={mergedZones.primary} formValues={formValues} formFields={formFields} prefillData={prefillData} accentColor={style.accent_color} isPreview={isPreview} />
          </div>
          <BadgeZone zone={mergedZones.secondary} formValues={formValues} formFields={formFields} prefillData={prefillData} accentColor={style.accent_color} isPreview={isPreview} />
          <BadgeZone zone={mergedZones.tertiary} formValues={formValues} formFields={formFields} prefillData={prefillData} accentColor={style.accent_color} isPreview={isPreview} />
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
          <BadgeZone zone={mergedZones.footer} formValues={formValues} formFields={formFields} prefillData={prefillData} accentColor={style.accent_color} isPreview={isPreview} />
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
