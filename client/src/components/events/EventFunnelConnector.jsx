import React, { useEffect, useRef } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow } from '@xyflow/react';
import { connectorPoints, connectorPath, connectorMidpoint, moveConnectorBend, moveConnectorSegment, addConnectorBend } from './eventFunnelConnectorGeometry.mjs';
import { isFunnelLayoutPoint } from '../../../../shared/eventFunnelEditorLayout.mjs';

// All controls operate in flow coordinates, so dragging behaves consistently
// under zoom/pan. Only layout is emitted; this component cannot retarget edges.
function DragControl({ point, disabled, onMove, onSelect, className = '', children, ...props }) {
  const { screenToFlowPosition } = useReactFlow();
  const drag = useRef(null);
  useEffect(() => { if (disabled) drag.current = null; }, [disabled]);
  return <button type="button" {...props} disabled={disabled}
    className={`nodrag nopan efb-connector-control ${className}`}
    style={{ transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`, ...props.style }}
    onPointerDown={event => {
      if (disabled || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); onSelect();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { origin: screenToFlowPosition({ x: event.clientX, y: event.clientY }), point, move: onMove };
    }}
    onPointerMove={event => {
      if (disabled || !drag.current) return;
      event.preventDefault(); event.stopPropagation();
      const current = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const { origin, point: initial, move } = drag.current;
      if (Math.abs(current.x - origin.x) + Math.abs(current.y - origin.y) < .5) return;
      move({ x: initial.x + current.x - origin.x, y: initial.y + current.y - origin.y });
    }}
    onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }}
    onClick={event => { event.stopPropagation(); if (!disabled) onSelect(); }}
    onKeyDown={event => {
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (disabled || !delta) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 20 : 5;
      onMove({ x: point.x + delta[0] * step, y: point.y + delta[1] * step });
    }}>{children}</button>;
}

export default function EventFunnelConnector({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, label, data, selected }) {
  const layout = data.layout || {};
  const points = connectorPoints({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, layout.bends);
  const midpoint = connectorMidpoint(points);
  const labelPoint = { x: midpoint.x + (layout.labelOffset?.x || 0), y: midpoint.y + (layout.labelOffset?.y || 0) };
  const select = () => data.onSelect(id);
  const changePoints = next => {
    const bends = next.slice(1, -1);
    if (bends.length <= 24 && bends.every(isFunnelLayoutPoint)) data.onChange({ ...layout, bends });
  };
  const edit = selected && !data.locked;
  return <>
    <BaseEdge id={id} path={connectorPath(points)} markerEnd={markerEnd} style={style} interactionWidth={24} />
    <EdgeLabelRenderer>
      <DragControl point={labelPoint} disabled={data.locked} onSelect={select} className={`efb-connector-label ${selected ? 'is-selected' : ''}`}
        data-testid="funnel-connector-label" data-connector-key={id} aria-label={`Move label: ${label}`}
        onMove={point => data.onChange({ ...layout, labelOffset: { x: point.x - midpoint.x, y: point.y - midpoint.y } })}>
        {label}
      </DragControl>
      {edit && <>
        {points.slice(1, -1).map((point, i) => <DragControl key={`bend-${i}`} point={point} disabled={false} onSelect={select}
          className="efb-connector-bend" data-testid="funnel-connector-bend" aria-label={`Move bend ${i + 1}: ${label}`}
          onMove={next => changePoints(moveConnectorBend(points, i + 1, next))} />)}
        {points.slice(1, -2).map((point, i) => {
          const next = points[i + 2];
          if (Math.abs(point.x - next.x) + Math.abs(point.y - next.y) < 4) return null;
          return <DragControl key={`segment-${i}`} point={{ x: point.x + (next.x - point.x) / 3, y: point.y + (next.y - point.y) / 3 }}
            disabled={false} onSelect={select} className="efb-connector-segment" data-testid="funnel-connector-segment"
            aria-label={`Move segment ${i + 1}: ${label}`}
            onMove={position => changePoints(moveConnectorSegment(points, i + 1, position))} />;
        })}
        <div className="nodrag nopan efb-connector-tools" data-testid="funnel-connector-tools"
          style={{ transform: `translate(-50%, 0) translate(${labelPoint.x}px, ${labelPoint.y + 18}px)` }}>
          <button type="button" disabled={points.length > 20} onClick={() => changePoints(addConnectorBend(points))}>Add bend</button>
          <button type="button" onClick={() => { const { bends, ...rest } = layout; data.onChange(rest); }}>Reset line</button>
          <button type="button" onClick={() => { const { labelOffset, ...rest } = layout; data.onChange(rest); }}>Reset label</button>
        </div>
      </>}
    </EdgeLabelRenderer>
  </>;
}
