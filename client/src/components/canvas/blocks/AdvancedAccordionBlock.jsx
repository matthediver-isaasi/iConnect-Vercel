import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Minus,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { getCachedLucideIcon, loadLucideIcon } from '@/lib/lucideCatalog';
import {
  BREAKPOINT_MAX_PX,
  BLOCK_TYPES,
  addAdvancedAccordionItem,
  cloneCanvasBlockWithFreshIds,
  createBlock,
  removeAdvancedAccordionItem,
  reorderAdvancedAccordionItems,
  resolveBleedBorderRadius,
  resolveBlockAtBreakpoint,
  resolveBoxShadowCss,
  resolveWrapperBackground,
  sanitizeAnchorId,
  updateAdvancedAccordionItem,
} from '@/lib/canvasDesign';
import {
  findAdvancedAccordionHashItemId,
  reconcileAdvancedAccordionOpen,
  resolveAdvancedAccordionInitialOpen,
  toggleAdvancedAccordionOpen,
} from '@/lib/advancedAccordion';
import { useCanvasAnchors } from '../CanvasAnchorContext';
import { useReportReflowHeight } from '../AccordionReflowContext';

export const ADVANCED_ACCORDION_SELECT_EVENT = 'canvas:advanced-accordion-select';

function resolveRuntimeBreakpoint() {
  if (typeof window === 'undefined') return 'desktop';
  if (window.innerWidth <= BREAKPOINT_MAX_PX.mobile) return 'mobile';
  if (window.innerWidth <= BREAKPOINT_MAX_PX.tablet) return 'tablet';
  return 'desktop';
}

function useNestedBreakpoint(explicitBreakpoint) {
  const [runtimeBreakpoint, setRuntimeBreakpoint] = useState(() => (
    explicitBreakpoint || resolveRuntimeBreakpoint()
  ));
  useEffect(() => {
    if (explicitBreakpoint) {
      setRuntimeBreakpoint(explicitBreakpoint);
      return undefined;
    }
    const update = () => setRuntimeBreakpoint(resolveRuntimeBreakpoint());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [explicitBreakpoint]);
  return explicitBreakpoint || runtimeBreakpoint;
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-slate-600">{label}</Label>
      {children}
    </div>
  );
}

function TextControl({ label, value, onChange, testId }) {
  return (
    <Field label={label}>
      <Input data-testid={testId} value={value || ''} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function NumberControl({ label, value, onChange, min = 0, max = 100, step = 1 }) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(Number(value)) ? Number(value) : ''}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

function ColorControl({ label, value, onChange }) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <Input
          className="h-9 w-12 p-1"
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff'}
          onChange={(event) => onChange(event.target.value)}
        />
        <Input value={value || ''} onChange={(event) => onChange(event.target.value)} />
      </div>
    </Field>
  );
}

function SelectControl({ label, value, onChange, options, testId }) {
  return (
    <Field label={label}>
      <Select value={String(value ?? '')} onValueChange={onChange}>
        <SelectTrigger data-testid={testId}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function ToggleControl({ label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-xs text-slate-600">{label}</Label>
      <Switch checked={!!checked} onCheckedChange={onChange} />
    </div>
  );
}

function InspectorSection({ title, children }) {
  return (
    <div className="space-y-3 border-t border-slate-200 pt-4 first:border-t-0 first:pt-0">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {children}
    </div>
  );
}

function LeadingIcon({ name, size, color }) {
  const [Icon, setIcon] = useState(() => getCachedLucideIcon(name));
  useEffect(() => {
    let live = true;
    setIcon(getCachedLucideIcon(name));
    if (name && !getCachedLucideIcon(name)) {
      loadLucideIcon(name).then((loaded) => live && setIcon(() => loaded || null));
    }
    return () => { live = false; };
  }, [name]);
  return Icon ? <Icon size={size} color={color} aria-hidden="true" /> : null;
}

function Indicator({ type, open, size, color }) {
  const props = {
    size,
    color,
    'aria-hidden': true,
    className: 'shrink-0 transition-transform duration-200 motion-reduce:transition-none',
  };
  if (type === 'chevron-down') {
    return <ChevronDown {...props} style={{ transform: open ? 'rotate(180deg)' : 'none' }} />;
  }
  if (type === 'chevron-right') {
    return <ChevronRight {...props} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />;
  }
  if (type === 'arrow') {
    return <ArrowRight {...props} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />;
  }
  return open ? <Minus {...props} /> : <Plus {...props} />;
}

function flattenNestedBlocks(children, depth = 0, out = []) {
  const list = Array.isArray(children) ? children : [];
  for (let index = 0; index < list.length; index += 1) {
    const child = list[index];
    if (!child || typeof child !== 'object') continue;
    out.push({ child, depth, index, siblingCount: list.length });
    if (depth < 20) flattenNestedBlocks(child.children, depth + 1, out);
  }
  return out;
}

function findNestedBlock(children, id, depth = 0) {
  if (depth > 20) return null;
  for (const child of Array.isArray(children) ? children : []) {
    if (child?.id === id) return child;
    const nested = findNestedBlock(child?.children, id, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function updateNestedBlock(children, id, updater, depth = 0) {
  if (depth > 20) return children;
  return (Array.isArray(children) ? children : []).map((child) => {
    if (child?.id === id) return updater(child);
    if (!Array.isArray(child?.children)) return child;
    return { ...child, children: updateNestedBlock(child.children, id, updater, depth + 1) };
  });
}

function removeNestedBlock(children, id, depth = 0) {
  if (depth > 20) return children;
  return (Array.isArray(children) ? children : [])
    .filter((child) => child?.id !== id)
    .map((child) => (
      Array.isArray(child?.children)
        ? { ...child, children: removeNestedBlock(child.children, id, depth + 1) }
        : child
    ));
}

function mutateNestedSiblings(children, id, mutate, depth = 0) {
  if (depth > 20) return children;
  const list = Array.isArray(children) ? children : [];
  const index = list.findIndex((child) => child?.id === id);
  if (index >= 0) return mutate([...list], index);
  return list.map((child) => (
    Array.isArray(child?.children)
      ? { ...child, children: mutateNestedSiblings(child.children, id, mutate, depth + 1) }
      : child
  ));
}

function isNestedContainer(block) {
  return block?.type === BLOCK_TYPES.ROW
    || block?.type === BLOCK_TYPES.GROUP
    || Array.isArray(block?.children);
}

function NestedCanvasChild({
  parentId,
  itemId,
  child,
  breakpoint,
  asEditor,
  selectedChildId,
  getBlockDefinition,
  placement = 'stack',
  depth = 0,
}) {
  if (!child || depth > 20) return null;
  const definition = getBlockDefinition(child.type);
  const isLayoutContainer = child.type === BLOCK_TYPES.ROW
    || child.type === BLOCK_TYPES.GROUP
    || Array.isArray(child.children);
  const Component = definition
    ? (asEditor ? (definition.Editor || definition.Renderer) : definition.Renderer)
    : null;
  const resolved = resolveBlockAtBreakpoint(child, breakpoint || 'desktop');
  const geom = resolved || child.bp?.desktop || child.geom || {};
  const style = child.style || {};
  const nestedChildren = Array.isArray(child.children) ? child.children : [];
  const isFlowContainer = nestedChildren.length > 0 && child.layoutMode === 'flow';
  const isRow = child.type === BLOCK_TYPES.ROW;
  const stackResponsiveRow = isRow && (
    (breakpoint === 'mobile' && child.content?.stackMobile !== false)
    || (breakpoint === 'tablet' && child.content?.stackTablet === true)
  );
  if (geom.hidden || (!Component && !isLayoutContainer)) return null;

  const fixedHeight = Math.max(24, Number(geom.h) || 40);
  const isAutoHeight = definition?.autoHeight || isFlowContainer;
  const placementStyle = placement === 'absolute'
    ? {
        position: 'absolute',
        left: Number(geom.x) || 0,
        top: Number(geom.y) || 0,
        width: Math.max(24, Number(geom.w) || 120),
      }
    : placement === 'row'
      ? {
          position: 'relative',
          flex: `${Math.max(0, Number(child.flow?.grow) || 1)} 1 ${Number(child.flow?.basis) > 0 ? `${Number(child.flow.basis)}px` : '0'}`,
          width: 0,
        }
      : { position: 'relative', width: '100%' };

  return (
    <div
      id={sanitizeAnchorId(child.anchorId || '') || undefined}
      data-advanced-accordion-child={child.id}
      className={selectedChildId === child.id ? 'ring-2 ring-blue-500 ring-offset-2' : ''}
      onPointerDown={(event) => {
        if (!asEditor) return;
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent(ADVANCED_ACCORDION_SELECT_EVENT, {
          detail: { parentId, itemId, childId: child.id },
        }));
      }}
      style={{
        ...placementStyle,
        boxSizing: 'border-box',
        minWidth: 0,
        minHeight: isAutoHeight ? 0 : fixedHeight,
        height: isAutoHeight ? 'auto' : fixedHeight,
        paddingTop: Number(style.paddingTop) || 0,
        paddingRight: Number(style.paddingRight) || 0,
        paddingBottom: Number(style.paddingBottom) || 0,
        paddingLeft: Number(style.paddingLeft) || 0,
        background: resolveWrapperBackground(child),
        borderStyle: (Number(style.borderWidth) || 0) > 0 ? 'solid' : 'none',
        borderWidth: Number(style.borderWidth) || 0,
        borderColor: style.borderColor || 'transparent',
        borderRadius: resolveBleedBorderRadius(child),
        boxShadow: resolveBoxShadowCss(style),
        overflow: definition?.allowOverflow || nestedChildren.length > 0 ? 'visible' : 'hidden',
        pointerEvents: asEditor ? 'auto' : undefined,
      }}
    >
      {Component ? <Component block={child} breakpoint={breakpoint} asEditor={asEditor} /> : null}
      {nestedChildren.length > 0 ? (
        <div
          style={isFlowContainer ? {
            position: 'relative',
            display: 'flex',
            flexDirection: isRow && !stackResponsiveRow ? 'row' : 'column',
            alignItems: child.flow?.align || 'stretch',
            gap: Math.max(0, Number(child.flow?.gap) || 0),
            minWidth: 0,
            width: '100%',
          } : {
            position: 'relative',
            width: '100%',
            height: fixedHeight,
            minHeight: fixedHeight,
          }}
        >
          {nestedChildren.map((nestedChild) => (
            <NestedCanvasChild
              key={nestedChild.id}
              parentId={parentId}
              itemId={itemId}
              child={nestedChild}
              breakpoint={breakpoint}
              asEditor={asEditor}
              selectedChildId={selectedChildId}
              getBlockDefinition={getBlockDefinition}
              placement={isFlowContainer ? (isRow ? 'row' : 'stack') : 'absolute'}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AdvancedAccordionRender({
  block,
  breakpoint,
  asEditor = false,
  getBlockDefinition,
  onSelectParent,
}) {
  const content = block.content || {};
  const items = Array.isArray(content.items) ? content.items : [];
  const styles = content.styles || {};
  const activeBreakpoint = useNestedBreakpoint(breakpoint);
  const itemIdsKey = items.map((item) => item.id).join('|');
  const containerRef = useReportReflowHeight(
    block.id,
    (Number(block.style?.paddingTop) || 0) + (Number(block.style?.paddingBottom) || 0),
  );
  const [openIds, setOpenIds] = useState(() => resolveAdvancedAccordionInitialOpen(
    content,
    typeof window !== 'undefined' ? window.location.hash : '',
  ));
  const [selectedChildId, setSelectedChildId] = useState('');

  useEffect(() => {
    setOpenIds((current) => reconcileAdvancedAccordionOpen(current, content));
  }, [content.mode, itemIdsKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const select = (event) => {
      if (event.detail?.parentId !== block.id) return;
      setSelectedChildId(event.detail.childId || '');
      if (asEditor && event.detail.itemId) {
        setOpenIds((current) => (
          content.mode === 'multiple'
            ? Array.from(new Set([...current, event.detail.itemId]))
            : [event.detail.itemId]
        ));
      }
    };
    window.addEventListener(ADVANCED_ACCORDION_SELECT_EVENT, select);
    return () => window.removeEventListener(ADVANCED_ACCORDION_SELECT_EVENT, select);
  }, [asEditor, block.id, content.mode]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const openHashTarget = ({ smooth = true } = {}) => {
      const hash = sanitizeAnchorId(window.location.hash.replace(/^#/, ''));
      const matchId = findAdvancedAccordionHashItemId(content, hash);
      if (!matchId) return;
      setOpenIds([matchId]);
      requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView?.({
          block: 'start',
          behavior: smooth ? 'smooth' : 'auto',
        });
      });
    };
    openHashTarget({ smooth: false });
    const onHashChange = () => openHashTarget({ smooth: true });
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [itemIdsKey]);

  const Heading = `h${[2, 3, 4, 5, 6].includes(Number(content.headingLevel)) ? Number(content.headingLevel) : 3}`;

  return (
    <div
      ref={containerRef}
      data-advanced-accordion={block.id}
      onPointerDownCapture={(event) => {
        if (!asEditor || event.button !== 0) return;
        onSelectParent?.(event);
      }}
      onPointerDown={(event) => {
        if (asEditor) event.stopPropagation();
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: Math.max(0, Number(content.itemGap) || 0),
        width: '100%',
      }}
    >
      {items.map((item, index) => {
        const open = openIds.includes(item.id);
        const safeId = sanitizeAnchorId(`${block.id}-${item.id}`) || `advanced-accordion-${index + 1}`;
        const headerId = `${safeId}-trigger`;
        const panelId = `${safeId}-panel`;
        const anchor = sanitizeAnchorId(item.anchor || '');
        const headerColor = open ? styles.headerOpenColor : styles.headerClosedColor;
        const headerBackground = open ? styles.headerOpenBackground : styles.headerClosedBackground;
        const children = Array.isArray(item.children) ? item.children : [];

        return (
          <div
            key={item.id}
            id={anchor || undefined}
            data-accordion-item={item.id}
            style={{
              minWidth: 0,
              background: styles.itemBackground || 'transparent',
              border: `${Math.max(0, Number(styles.itemBorderWidth) || 0)}px solid ${styles.itemBorderColor || 'transparent'}`,
              borderRadius: Math.max(0, Number(styles.itemBorderRadius) || 0),
              boxShadow: styles.itemShadow || 'none',
              overflow: 'hidden',
            }}
          >
            <Heading style={{ margin: 0, font: 'inherit' }}>
              <button
                type="button"
                id={headerId}
                aria-expanded={open}
                aria-controls={panelId}
                onPointerDown={(event) => asEditor && event.stopPropagation()}
                onClick={() => {
                  const wasOpen = openIds.includes(item.id);
                  setOpenIds((current) => toggleAdvancedAccordionOpen(
                    current,
                    item.id,
                    content.mode,
                    items.map((entry) => entry.id),
                  ));
                  if (!wasOpen && content.syncHashOnOpen && anchor && !asEditor && typeof window !== 'undefined') {
                    try {
                      window.history.replaceState(
                        window.history.state,
                        '',
                        `${window.location.pathname}${window.location.search}#${anchor}`,
                      );
                    } catch { /* URL replacement is best-effort. */ }
                  }
                }}
                className="group w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-inset"
                style={{
                  display: 'flex',
                  alignItems: styles.headerAlign || 'center',
                  width: '100%',
                  minHeight: Math.max(36, Number(styles.headerMinHeight) || 52),
                  gap: 12,
                  padding: `${Math.max(0, Number(styles.headerPaddingY) || 0)}px ${Math.max(0, Number(styles.headerPaddingX) || 0)}px`,
                  border: 0,
                  borderBottom: open && Number(styles.dividerWidth) > 0
                    ? `${Number(styles.dividerWidth)}px solid ${styles.dividerColor || 'transparent'}`
                    : '0 solid transparent',
                  color: headerColor || 'inherit',
                  background: headerBackground || 'transparent',
                  cursor: 'pointer',
                }}
                onMouseEnter={(event) => {
                  if (!open && styles.headerHoverBackground) {
                    event.currentTarget.style.background = styles.headerHoverBackground;
                  }
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = headerBackground || 'transparent';
                }}
              >
                {item.leadingIcon ? (
                  <span aria-hidden="true" className="inline-flex shrink-0">
                    <LeadingIcon
                      name={item.leadingIcon}
                      size={Math.max(12, Number(styles.iconSize) || 20)}
                      color={styles.iconColor || headerColor}
                    />
                  </span>
                ) : null}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <span style={{
                      fontSize: Math.max(10, Number(styles.titleFontSize) || 16),
                      fontWeight: Math.max(100, Number(styles.titleFontWeight) || 600),
                      lineHeight: 1.3,
                      overflowWrap: 'anywhere',
                    }}>
                      {item.title || `Panel ${index + 1}`}
                    </span>
                    {item.badge ? (
                      <span style={{
                        borderRadius: 999,
                        padding: '2px 8px',
                        fontSize: 11,
                        lineHeight: 1.35,
                        whiteSpace: 'nowrap',
                        background: styles.badgeBackground || '#e2e8f0',
                        color: styles.badgeColor || '#334155',
                      }}>
                        {item.badge}
                      </span>
                    ) : null}
                  </span>
                  {item.subtitle ? (
                    <span style={{
                      display: 'block',
                      marginTop: 3,
                      color: styles.subtitleColor || 'currentColor',
                      fontSize: Math.max(9, Number(styles.subtitleFontSize) || 13),
                      fontWeight: 400,
                      lineHeight: 1.4,
                      overflowWrap: 'anywhere',
                    }}>
                      {item.subtitle}
                    </span>
                  ) : null}
                </span>
                <Indicator
                  type={content.indicator}
                  open={open}
                  size={Math.max(12, Number(styles.iconSize) || 20)}
                  color={styles.iconColor || headerColor || 'currentColor'}
                />
              </button>
            </Heading>
            <div
              className="motion-reduce:transition-none"
              style={{
                display: 'grid',
                gridTemplateRows: open ? '1fr' : '0fr',
                transition: 'grid-template-rows 240ms ease',
              }}
            >
              <div
                id={panelId}
                role="region"
                aria-labelledby={headerId}
                aria-hidden={!open}
                inert={open ? undefined : ''}
                style={{ minHeight: 0, overflow: 'hidden' }}
              >
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: Math.max(0, Number(styles.childGap) || 0),
                  padding: `${Math.max(0, Number(styles.panelPaddingY) || 0)}px ${Math.max(0, Number(styles.panelPaddingX) || 0)}px`,
                  color: styles.panelColor || 'inherit',
                  background: styles.panelBackground || 'transparent',
                  border: `${Math.max(0, Number(styles.panelBorderWidth) || 0)}px solid ${styles.panelBorderColor || 'transparent'}`,
                }}>
                  {children.length ? children.map((child) => (
                    <NestedCanvasChild
                      key={child.id}
                      parentId={block.id}
                      itemId={item.id}
                      child={child}
                      breakpoint={activeBreakpoint}
                      asEditor={asEditor}
                      selectedChildId={selectedChildId}
                      getBlockDefinition={getBlockDefinition}
                    />
                  )) : (
                    <div style={{ color: '#64748b', fontSize: 13 }}>
                      {asEditor ? 'Add Canvas blocks to this panel from the inspector.' : null}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AdvancedAccordionInspector({
  block,
  onUpdate,
  update,
  getBlockDefinition,
  listPaletteBlocks,
}) {
  const content = block.content || {};
  const styles = content.styles || {};
  const [activeItemId, setActiveItemId] = useState(content.items?.[0]?.id || '');
  const [selectedChildId, setSelectedChildId] = useState('');
  const [newChildType, setNewChildType] = useState(BLOCK_TYPES.TEXT);
  const { anchors: pageAnchors = [] } = useCanvasAnchors();
  const activeItem = (content.items || []).find((item) => item.id === activeItemId) || content.items?.[0];
  const selectedChild = findNestedBlock(activeItem?.children, selectedChildId);

  const commitUpdate = onUpdate || update;
  const updateContent = (patch) => commitUpdate?.((currentBlock) => ({
    ...currentBlock,
    content: {
      ...(currentBlock?.content || {}),
      ...patch,
    },
  }));
  const updateStyles = (patch) => updateContent({ styles: { ...styles, ...patch } });
  const updateItem = (itemId, patch) => updateContent(updateAdvancedAccordionItem(
    content,
    itemId,
    patch,
    {
      reservedAnchors: pageAnchors
        .filter((entry) => entry.blockId !== itemId)
        .map((entry) => entry.anchorId),
    },
  ));

  useEffect(() => {
    const select = (event) => {
      if (event.detail?.parentId !== block.id) return;
      setActiveItemId(event.detail.itemId || '');
      setSelectedChildId(event.detail.childId || '');
    };
    window.addEventListener(ADVANCED_ACCORDION_SELECT_EVENT, select);
    return () => window.removeEventListener(ADVANCED_ACCORDION_SELECT_EVENT, select);
  }, [block.id]);

  const selectItem = (itemId, childId = '') => {
    setActiveItemId(itemId);
    setSelectedChildId(childId);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(ADVANCED_ACCORDION_SELECT_EVENT, {
        detail: { parentId: block.id, itemId, childId },
      }));
    }
  };

  const nestedOptions = useMemo(() => {
    const options = listPaletteBlocks()
      .filter((entry) => entry.type !== BLOCK_TYPES.ADVANCED_ACCORDION && entry.type !== BLOCK_TYPES.SYMBOL)
      .map((entry) => ({ value: entry.type, label: entry.label }));
    return [
      { value: BLOCK_TYPES.ROW, label: 'Row layout' },
      { value: BLOCK_TYPES.GROUP, label: 'Free-position group' },
      ...options.filter((option) => option.value !== BLOCK_TYPES.ROW && option.value !== BLOCK_TYPES.GROUP),
    ];
  }, [listPaletteBlocks]);

  const addChild = () => {
    if (!activeItem) return;
    let child = createBlock(newChildType, { desktop: { x: 0, y: 0, w: 520, h: 120 } });
    if (newChildType === BLOCK_TYPES.ROW || newChildType === BLOCK_TYPES.GROUP) {
      child = {
        ...child,
        children: [],
        layoutMode: newChildType === BLOCK_TYPES.ROW ? 'flow' : 'free',
        flow: { gap: 12, align: 'stretch' },
      };
    }
    const nextChildren = selectedChild && isNestedContainer(selectedChild)
      ? updateNestedBlock(activeItem.children, selectedChild.id, (container) => ({
          ...container,
          children: [...(container.children || []), child],
        }))
      : [...(activeItem.children || []), child];
    updateItem(activeItem.id, { children: nextChildren });
    setSelectedChildId(child.id);
  };

  const patchSelectedChild = (patch) => {
    if (!activeItem || !selectedChild) return;
    updateItem(activeItem.id, {
      children: updateNestedBlock(activeItem.children, selectedChild.id, (child) => ({ ...child, ...patch })),
    });
  };

  return (
    <div className="space-y-5">
      <InspectorSection title="Behaviour">
        <SelectControl
          label="Open mode"
          value={content.mode || 'single'}
          onChange={(mode) => updateContent({ mode })}
          options={[
            { value: 'multiple', label: 'Multiple items open' },
            { value: 'single', label: 'Single item open' },
            { value: 'single-required', label: 'Single, always one open' },
          ]}
          testId="advanced-accordion-mode"
        />
        <SelectControl
          label="Initial state"
          value={content.initialState || 'all-closed'}
          onChange={(initialState) => updateContent({ initialState })}
          options={[
            { value: 'all-closed', label: 'All closed' },
            { value: 'first', label: 'First item open' },
            { value: 'specific', label: 'Specific item open' },
            { value: 'multiple', label: 'Selected items open' },
          ]}
          testId="advanced-accordion-initial-state"
        />
        {(content.initialState === 'specific' || content.initialState === 'multiple') ? (
          <Field label="Initially open items">
            <div className="space-y-2">
              {(content.items || []).map((item) => {
                const checked = (content.initialOpenIds || []).includes(item.id);
                return (
                  <label key={item.id} className="flex items-center gap-2 text-xs">
                    <input
                      type={content.initialState === 'specific' ? 'radio' : 'checkbox'}
                      checked={checked}
                      onChange={(event) => updateContent({
                        initialOpenIds: content.initialState === 'specific'
                          ? (event.target.checked ? [item.id] : [])
                          : (event.target.checked
                            ? Array.from(new Set([...(content.initialOpenIds || []), item.id]))
                            : (content.initialOpenIds || []).filter((id) => id !== item.id)),
                      })}
                    />
                    {item.title || 'Untitled item'}
                  </label>
                );
              })}
            </div>
          </Field>
        ) : null}
        <SelectControl
          label="Toggle icon"
          value={content.indicator || 'plus-minus'}
          onChange={(indicator) => updateContent({ indicator })}
          options={[
            { value: 'plus-minus', label: 'Plus / minus' },
            { value: 'chevron-down', label: 'Down chevron' },
            { value: 'chevron-right', label: 'Right chevron' },
            { value: 'arrow', label: 'Arrow' },
          ]}
        />
        <SelectControl
          label="Header heading level"
          value={String(content.headingLevel || 3)}
          onChange={(headingLevel) => updateContent({ headingLevel: Number(headingLevel) })}
          options={[2, 3, 4, 5, 6].map((level) => ({ value: level, label: `Heading ${level}` }))}
        />
        <ToggleControl
          label="Update URL hash when opened"
          checked={content.syncHashOnOpen}
          onChange={(syncHashOnOpen) => updateContent({ syncHashOnOpen })}
        />
      </InspectorSection>

      <InspectorSection title="Items">
        <div className="space-y-2">
          {(content.items || []).map((item, index) => (
            <div
              key={item.id}
              className={`rounded-md border p-2 ${activeItem?.id === item.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}
            >
              <button type="button" className="w-full text-left text-sm font-medium" onClick={() => selectItem(item.id)}>
                {index + 1}. {item.title || 'Untitled item'}
              </button>
              <div className="mt-2 flex gap-1">
                <Button size="sm" variant="outline" disabled={index === 0} onClick={() => {
                  const ids = content.items.map((entry) => entry.id);
                  [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                  updateContent(reorderAdvancedAccordionItems(content, ids));
                }}><ArrowUp className="h-3 w-3" /></Button>
                <Button size="sm" variant="outline" disabled={index === content.items.length - 1} onClick={() => {
                  const ids = content.items.map((entry) => entry.id);
                  [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]];
                  updateContent(reorderAdvancedAccordionItems(content, ids));
                }}><ArrowDown className="h-3 w-3" /></Button>
                <Button size="sm" variant="outline" onClick={() => {
                  const children = (item.children || []).map((child) =>
                    cloneCanvasBlockWithFreshIds(JSON.parse(JSON.stringify(child))));
                  const next = addAdvancedAccordionItem(content, {
                    ...item,
                    id: undefined,
                    title: `${item.title} copy`,
                    children,
                  });
                  updateContent(next);
                  setActiveItemId(next.items.at(-1)?.id || '');
                }}><Copy className="h-3 w-3" /></Button>
                <Button size="sm" variant="outline" disabled={content.items.length <= 1} onClick={() => {
                  const next = removeAdvancedAccordionItem(content, item.id);
                  updateContent(next);
                  setActiveItemId(next.items[0]?.id || '');
                }}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
          <Button className="w-full" variant="outline" onClick={() => {
            const next = addAdvancedAccordionItem(content);
            updateContent(next);
            setActiveItemId(next.items.at(-1)?.id || '');
          }}><Plus className="mr-1 h-4 w-4" /> Add item</Button>
        </div>
      </InspectorSection>

      {activeItem ? (
        <InspectorSection title="Selected item">
          <TextControl label="Title" value={activeItem.title} onChange={(title) => updateItem(activeItem.id, { title })} testId="advanced-accordion-item-title" />
          <TextControl label="Subtitle (optional)" value={activeItem.subtitle} onChange={(subtitle) => updateItem(activeItem.id, { subtitle })} />
          <TextControl label="Badge (optional)" value={activeItem.badge} onChange={(badge) => updateItem(activeItem.id, { badge })} />
          <TextControl label="Leading Lucide icon (optional)" value={activeItem.leadingIcon} onChange={(leadingIcon) => updateItem(activeItem.id, { leadingIcon })} />
          <TextControl label="Page anchor" value={activeItem.anchor} onChange={(anchor) => updateItem(activeItem.id, { anchor })} testId="advanced-accordion-item-anchor" />
          <Field label="Panel content">
            <div className="space-y-2">
              {flattenNestedBlocks(activeItem.children).map(({ child, depth, index, siblingCount }) => (
                <div
                  key={child.id}
                  className={`flex items-center gap-1 rounded border p-1 ${selectedChildId === child.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}
                  style={{ marginLeft: depth * 12 }}
                >
                  <button type="button" className="min-w-0 flex-1 truncate px-1 text-left text-xs" onClick={() => selectItem(activeItem.id, child.id)}>
                    {depth > 0 ? '↳ ' : ''}{child.name || getBlockDefinition(child.type)?.label || child.type}
                  </button>
                  <Button size="icon" variant="ghost" disabled={index === 0} onClick={() => {
                    updateItem(activeItem.id, {
                      children: mutateNestedSiblings(activeItem.children, child.id, (siblings, childIndex) => {
                        [siblings[childIndex - 1], siblings[childIndex]] = [siblings[childIndex], siblings[childIndex - 1]];
                        return siblings;
                      }),
                    });
                  }}><ArrowUp className="h-3 w-3" /></Button>
                  <Button size="icon" variant="ghost" disabled={index === siblingCount - 1} onClick={() => {
                    updateItem(activeItem.id, {
                      children: mutateNestedSiblings(activeItem.children, child.id, (siblings, childIndex) => {
                        [siblings[childIndex + 1], siblings[childIndex]] = [siblings[childIndex], siblings[childIndex + 1]];
                        return siblings;
                      }),
                    });
                  }}><ArrowDown className="h-3 w-3" /></Button>
                  <Button size="icon" variant="ghost" onClick={() => {
                    const clone = cloneCanvasBlockWithFreshIds(JSON.parse(JSON.stringify(child)));
                    updateItem(activeItem.id, {
                      children: mutateNestedSiblings(activeItem.children, child.id, (siblings, childIndex) => {
                        siblings.splice(childIndex + 1, 0, clone);
                        return siblings;
                      }),
                    });
                    setSelectedChildId(clone.id);
                  }}><Copy className="h-3 w-3" /></Button>
                  <Button size="icon" variant="ghost" onClick={() => {
                    updateItem(activeItem.id, {
                      children: removeNestedBlock(activeItem.children, child.id),
                    });
                    if (selectedChildId === child.id) setSelectedChildId('');
                  }}><Trash2 className="h-3 w-3" /></Button>
                </div>
              ))}
              <SelectControl label="Add Canvas block" value={newChildType} onChange={setNewChildType} options={nestedOptions} />
              <Button className="w-full" variant="outline" onClick={addChild}>
                <Plus className="mr-1 h-4 w-4" />
                {selectedChild && isNestedContainer(selectedChild) ? 'Add inside selected layout' : 'Add to panel'}
              </Button>
            </div>
          </Field>
        </InspectorSection>
      ) : null}

      {selectedChild ? (
        <InspectorSection title={`Edit ${selectedChild.name || getBlockDefinition(selectedChild.type)?.label || 'block'}`}>
          {(() => {
            const ChildInspector = getBlockDefinition(selectedChild.type)?.Inspector;
            return ChildInspector
              ? (
                  <ChildInspector
                    block={selectedChild}
                    update={patchSelectedChild}
                    onUpdate={patchSelectedChild}
                    breakpoint="desktop"
                  />
                )
              : <div className="text-xs text-slate-500">This block has no content-specific settings.</div>;
          })()}
        </InspectorSection>
      ) : null}

      <InspectorSection title="Item and header style">
        <NumberControl label="Item spacing" value={content.itemGap} max={80} onChange={(itemGap) => updateContent({ itemGap })} />
        <ColorControl label="Item background" value={styles.itemBackground} onChange={(itemBackground) => updateStyles({ itemBackground })} />
        <ColorControl label="Item border" value={styles.itemBorderColor} onChange={(itemBorderColor) => updateStyles({ itemBorderColor })} />
        <NumberControl label="Item border width" value={styles.itemBorderWidth} max={12} onChange={(itemBorderWidth) => updateStyles({ itemBorderWidth })} />
        <NumberControl label="Item radius" value={styles.itemBorderRadius} max={80} onChange={(itemBorderRadius) => updateStyles({ itemBorderRadius })} />
        <SelectControl label="Item shadow" value={styles.itemShadow || 'none'} onChange={(itemShadow) => updateStyles({ itemShadow })} options={[
          { value: 'none', label: 'None' },
          { value: '0 1px 3px rgba(15,23,42,.12)', label: 'Subtle' },
          { value: '0 8px 24px rgba(15,23,42,.16)', label: 'Raised' },
        ]} />
        <ColorControl label="Closed header background" value={styles.headerClosedBackground} onChange={(headerClosedBackground) => updateStyles({ headerClosedBackground })} />
        <ColorControl label="Closed header text" value={styles.headerClosedColor} onChange={(headerClosedColor) => updateStyles({ headerClosedColor })} />
        <ColorControl label="Open header background" value={styles.headerOpenBackground} onChange={(headerOpenBackground) => updateStyles({ headerOpenBackground })} />
        <ColorControl label="Open header text" value={styles.headerOpenColor} onChange={(headerOpenColor) => updateStyles({ headerOpenColor })} />
        <ColorControl label="Hover background" value={styles.headerHoverBackground} onChange={(headerHoverBackground) => updateStyles({ headerHoverBackground })} />
        <NumberControl label="Header horizontal padding" value={styles.headerPaddingX} max={80} onChange={(headerPaddingX) => updateStyles({ headerPaddingX })} />
        <NumberControl label="Header vertical padding" value={styles.headerPaddingY} max={80} onChange={(headerPaddingY) => updateStyles({ headerPaddingY })} />
        <NumberControl label="Header minimum height" value={styles.headerMinHeight} min={36} max={160} onChange={(headerMinHeight) => updateStyles({ headerMinHeight })} />
        <SelectControl label="Header vertical alignment" value={styles.headerAlign || 'center'} onChange={(headerAlign) => updateStyles({ headerAlign })} options={[
          { value: 'flex-start', label: 'Top' },
          { value: 'center', label: 'Centre' },
          { value: 'flex-end', label: 'Bottom' },
        ]} />
        <NumberControl label="Title size" value={styles.titleFontSize} min={10} max={72} onChange={(titleFontSize) => updateStyles({ titleFontSize })} />
        <NumberControl label="Title weight" value={styles.titleFontWeight} min={100} max={900} step={100} onChange={(titleFontWeight) => updateStyles({ titleFontWeight })} />
        <ColorControl label="Subtitle text" value={styles.subtitleColor} onChange={(subtitleColor) => updateStyles({ subtitleColor })} />
        <NumberControl label="Subtitle size" value={styles.subtitleFontSize} min={9} max={48} onChange={(subtitleFontSize) => updateStyles({ subtitleFontSize })} />
      </InspectorSection>

      <InspectorSection title="Panel and detail style">
        <ColorControl label="Panel background" value={styles.panelBackground} onChange={(panelBackground) => updateStyles({ panelBackground })} />
        <ColorControl label="Panel text" value={styles.panelColor} onChange={(panelColor) => updateStyles({ panelColor })} />
        <ColorControl label="Panel border" value={styles.panelBorderColor} onChange={(panelBorderColor) => updateStyles({ panelBorderColor })} />
        <NumberControl label="Panel border width" value={styles.panelBorderWidth} max={12} onChange={(panelBorderWidth) => updateStyles({ panelBorderWidth })} />
        <NumberControl label="Panel horizontal padding" value={styles.panelPaddingX} onChange={(panelPaddingX) => updateStyles({ panelPaddingX })} />
        <NumberControl label="Panel vertical padding" value={styles.panelPaddingY} onChange={(panelPaddingY) => updateStyles({ panelPaddingY })} />
        <NumberControl label="Nested block spacing" value={styles.childGap} max={80} onChange={(childGap) => updateStyles({ childGap })} />
        <ColorControl label="Divider color" value={styles.dividerColor} onChange={(dividerColor) => updateStyles({ dividerColor })} />
        <NumberControl label="Divider width" value={styles.dividerWidth} max={12} onChange={(dividerWidth) => updateStyles({ dividerWidth })} />
        <ColorControl label="Badge background" value={styles.badgeBackground} onChange={(badgeBackground) => updateStyles({ badgeBackground })} />
        <ColorControl label="Badge text" value={styles.badgeColor} onChange={(badgeColor) => updateStyles({ badgeColor })} />
        <ColorControl label="Icon colour" value={styles.iconColor} onChange={(iconColor) => updateStyles({ iconColor })} />
        <NumberControl label="Icon size" value={styles.iconSize} min={12} max={64} onChange={(iconSize) => updateStyles({ iconSize })} />
      </InspectorSection>
    </div>
  );
}