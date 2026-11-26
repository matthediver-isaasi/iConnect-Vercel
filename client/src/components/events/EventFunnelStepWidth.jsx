import React, { useEffect, useState } from 'react';
import { DEFAULT_FUNNEL_STEP_WIDTH, MIN_FUNNEL_STEP_WIDTH, MAX_FUNNEL_STEP_WIDTH, isFunnelStepWidth } from '../../../../shared/eventFunnelEditorLayout.mjs';

export default function EventFunnelStepWidth({ width, locked, onChange }) {
  const [input, setInput] = useState(String(width));
  useEffect(() => { setInput(String(width)); }, [width, locked]);
  return <div className="efb-field">
    <label><span className="efb-width-label">Step width (px)</span>
      <input type="number" aria-label="Step width (px)" data-testid="funnel-step-width"
        min={MIN_FUNNEL_STEP_WIDTH} max={MAX_FUNNEL_STEP_WIDTH} step="1" value={input}
        onChange={event => {
          setInput(event.target.value);
          const value = Number(event.target.value);
          if (isFunnelStepWidth(value)) onChange(value);
        }}
        onBlur={() => setInput(String(width))} />
    </label>
    <div className="efb-row efb-width-help"><span className="efb-muted">{MIN_FUNNEL_STEP_WIDTH}–{MAX_FUNNEL_STEP_WIDTH} px · or drag the box’s right edge.</span>
      <button type="button" disabled={width === DEFAULT_FUNNEL_STEP_WIDTH} onClick={() => onChange(DEFAULT_FUNNEL_STEP_WIDTH)}>Reset width</button>
    </div>
  </div>;
}
