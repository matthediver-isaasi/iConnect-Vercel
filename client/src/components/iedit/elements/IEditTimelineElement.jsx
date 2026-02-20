import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import ReactQuill from "react-quill";
import DOMPurify from "dompurify";
import "react-quill/dist/quill.snow.css";
import {
  Plus,
  Trash2,
  GripVertical,
  ChevronDown,
  ChevronUp,
  Upload,
  Image,
  X,
  Maximize2,
  Minimize2
} from "lucide-react";

const timelineQuillModules = {
  toolbar: {
    container: [
      [{ 'header': [2, 3, false] }],
      ['bold', 'italic', 'underline'],
      [{ 'list': 'ordered' }, { 'list': 'bullet' }],
      ['link'],
      ['clean']
    ]
  }
};

const timelineQuillFormats = [
  'header', 'bold', 'italic', 'underline',
  'list', 'bullet', 'link'
];

/* ────────────────────────── RENDERER ────────────────────────── */

export function IEditTimelineElementRenderer({ content, variant, settings }) {
  const isMobile = useIsMobile();
  const [activeYear, setActiveYear] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const sectionRefs = useRef({});
  const railRef = useRef(null);
  const observerRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const isClickScrolling = useRef(false);
  const prefersReducedMotion = useRef(false);

  const {
    title,
    items = [],
    line_color = '#d1d5db',
    active_color = '#2563eb',
    marker_size = 14,
    header_offset = 80,
    anchor
  } = content || {};

  useEffect(() => {
    if (isExpanded) {
      document.body.style.overflow = 'hidden';
      const handleEsc = (e) => {
        if (e.key === 'Escape') setIsExpanded(false);
      };
      document.addEventListener('keydown', handleEsc);
      return () => {
        document.body.style.overflow = '';
        document.removeEventListener('keydown', handleEsc);
      };
    } else {
      document.body.style.overflow = '';
    }
  }, [isExpanded]);

  useEffect(() => {
    prefersReducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (items.length > 0 && !activeYear) {
      setActiveYear(items[0].year);
    }
  }, [items]);

  useEffect(() => {
    if (!items.length) return;

    const handleIntersect = (entries) => {
      if (isClickScrolling.current) return;

      let bestEntry = null;
      let bestRatio = 0;

      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
          bestRatio = entry.intersectionRatio;
          bestEntry = entry;
        }
      });

      if (bestEntry) {
        const year = bestEntry.target.dataset.year;
        if (year) setActiveYear(year);
      }
    };

    const effectiveOffset = isExpanded ? 80 : header_offset;
    observerRef.current = new IntersectionObserver(handleIntersect, {
      root: isExpanded ? scrollContainerRef.current : null,
      rootMargin: `-${effectiveOffset}px 0px -40% 0px`,
      threshold: [0, 0.25, 0.5, 0.75, 1]
    });

    Object.values(sectionRefs.current).forEach((el) => {
      if (el) observerRef.current.observe(el);
    });

    return () => {
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, [items, header_offset, isExpanded]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (hash) {
      const yearMatch = hash.match(/^#year-(.+)$/);
      if (yearMatch) {
        const targetYear = yearMatch[1];
        const el = sectionRefs.current[targetYear];
        if (el) {
          setTimeout(() => {
            scrollToSection(targetYear);
          }, 300);
        }
      }
    }
  }, [items]);

  const scrollToSection = useCallback((year) => {
    const el = sectionRefs.current[year];
    if (!el) return;

    isClickScrolling.current = true;
    setActiveYear(year);

    const behavior = prefersReducedMotion.current ? 'auto' : 'smooth';
    const container = scrollContainerRef.current;
    const effectiveOffset = isExpanded ? 80 : header_offset;

    if (container && isExpanded) {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const top = container.scrollTop + (elRect.top - containerRect.top) - effectiveOffset;
      container.scrollTo({ top, behavior });
    } else {
      const top = el.getBoundingClientRect().top + window.scrollY - effectiveOffset;
      window.scrollTo({ top, behavior });
    }

    if (!isExpanded && typeof window !== 'undefined' && window.history) {
      window.history.replaceState(null, '', `#year-${year}`);
    }

    setTimeout(() => {
      isClickScrolling.current = false;
    }, 800);
  }, [header_offset, isExpanded]);

  const setSectionRef = useCallback((year, el) => {
    sectionRefs.current[year] = el;
  }, []);

  if (!items.length) {
    return (
      <div className="py-12 text-center text-slate-400" data-testid="timeline-empty">
        No timeline items to display.
      </div>
    );
  }

  const expandButton = (
    <button
      onClick={() => setIsExpanded(!isExpanded)}
      className="absolute top-0 right-0 z-30 p-2 rounded-md bg-white/80 hover:bg-white border border-slate-200 shadow-sm transition-colors"
      title={isExpanded ? 'Exit fullscreen' : 'View fullscreen'}
      aria-label={isExpanded ? 'Exit fullscreen' : 'View fullscreen'}
      data-testid="button-timeline-expand"
    >
      {isExpanded ? <Minimize2 className="w-4 h-4 text-slate-600" /> : <Maximize2 className="w-4 h-4 text-slate-600" />}
    </button>
  );

  const markerNav = (idx, item) => {
    const isActive = activeYear === item.year;
    return (
      <button
        key={item.year}
        onClick={() => scrollToSection(item.year)}
        role="tab"
        aria-selected={isActive}
        aria-current={isActive ? 'true' : undefined}
        className="relative z-10 flex flex-col items-center group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        style={{ marginBottom: idx < items.length - 1 ? '24px' : 0 }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            const next = items[idx + 1];
            if (next) {
              scrollToSection(next.year);
              e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[idx + 1]?.focus();
            }
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const prev = items[idx - 1];
            if (prev) {
              scrollToSection(prev.year);
              e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[idx - 1]?.focus();
            }
          } else if (e.key === 'Home') {
            e.preventDefault();
            scrollToSection(items[0].year);
            e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[0]?.focus();
          } else if (e.key === 'End') {
            e.preventDefault();
            const last = items[items.length - 1];
            scrollToSection(last.year);
            e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[items.length - 1]?.focus();
          }
        }}
        data-testid={`timeline-marker-${item.year}`}
      >
        <div
          className="rounded-full transition-all duration-200 ring-2 ring-white"
          style={{
            width: `${isActive ? marker_size + 4 : marker_size}px`,
            height: `${isActive ? marker_size + 4 : marker_size}px`,
            backgroundColor: isActive ? active_color : line_color,
            boxShadow: isActive ? `0 0 0 3px ${active_color}33` : 'none'
          }}
        />
        <span
          className="mt-1.5 text-sm transition-colors duration-200"
          style={{
            fontWeight: isActive ? 700 : 500,
            color: isActive ? active_color : '#9ca3af'
          }}
        >
          {item.year}
        </span>
      </button>
    );
  };

  const contentSection = (item, idx) => {
    const isActive = activeYear === item.year;
    const effectiveOffset = isExpanded ? 80 : header_offset;
    return (
      <div
        key={item.year}
        ref={(el) => setSectionRef(item.year, el)}
        data-year={item.year}
        style={{
          scrollMarginTop: `${effectiveOffset + 8}px`,
          marginBottom: idx < items.length - 1 ? '48px' : 0
        }}
        data-testid={`timeline-section-${item.year}`}
      >
        <div className="flex items-baseline gap-3 mb-3">
          <span
            className="text-2xl font-bold transition-colors duration-200"
            style={{ color: isActive ? active_color : '#9ca3af' }}
          >
            {item.year}
          </span>
          {item.heading && (
            <h3 className="text-xl font-semibold text-slate-800">{item.heading}</h3>
          )}
        </div>

        {item.media?.src && (
          <div className="mb-4 rounded-lg overflow-hidden">
            {item.media.type === 'video' ? (
              <video
                src={item.media.src}
                controls
                className="w-full max-w-2xl rounded-lg"
                data-testid={`timeline-video-${item.year}`}
              />
            ) : (
              <img
                src={item.media.src}
                alt={item.media.alt || item.heading || item.year}
                className="w-full max-w-2xl rounded-lg object-cover max-h-80"
                loading="lazy"
                data-testid={`timeline-image-${item.year}`}
              />
            )}
          </div>
        )}

        {item.body && (
          <div
            className="prose prose-slate max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(item.body) }}
          />
        )}
      </div>
    );
  };

  const mobileContentSection = (item) => (
    <div
      key={item.year}
      ref={(el) => setSectionRef(item.year, el)}
      data-year={item.year}
      className="scroll-mt-32"
      data-testid={`timeline-section-${item.year}`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: activeYear === item.year ? active_color : line_color }}
        />
        <span
          className="text-lg font-bold"
          style={{ color: activeYear === item.year ? active_color : '#374151' }}
        >
          {item.year}
        </span>
      </div>
      {item.heading && (
        <h3 className="text-xl font-semibold text-slate-800 mb-2">{item.heading}</h3>
      )}
      {item.media?.src && (
        <div className="mb-3 rounded-lg overflow-hidden">
          {item.media.type === 'video' ? (
            <video src={item.media.src} controls className="w-full rounded-lg" data-testid={`timeline-video-${item.year}`} />
          ) : (
            <img src={item.media.src} alt={item.media.alt || item.heading || item.year} className="w-full rounded-lg object-cover max-h-64" loading="lazy" data-testid={`timeline-image-${item.year}`} />
          )}
        </div>
      )}
      {item.body && (
        <div className="prose prose-sm prose-slate max-w-none" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(item.body) }} />
      )}
    </div>
  );

  const desktopTimeline = (inOverlay) => (
    <div className="flex gap-8 lg:gap-12">
      <div
        ref={railRef}
        className="shrink-0 w-28 lg:w-36 self-start"
        style={{ position: 'sticky', top: inOverlay ? '80px' : `${header_offset + 16}px` }}
      >
        <nav className="relative flex flex-col items-center" role="tablist" aria-label="Timeline years">
          <div
            className="absolute left-1/2 -translate-x-1/2 w-0.5 rounded-full"
            style={{ backgroundColor: line_color, top: `${marker_size / 2}px`, bottom: `${marker_size / 2}px` }}
            aria-hidden="true"
          />
          {items.map((item, idx) => markerNav(idx, item))}
        </nav>
      </div>
      <div className="flex-1 min-w-0">
        {items.map((item, idx) => contentSection(item, idx))}
      </div>
    </div>
  );

  /* ── Expanded overlay ── */
  if (isExpanded) {
    return (
      <>
        <div id={anchor || undefined} className="relative" data-testid="timeline-desktop">
          {expandButton}
        </div>
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setIsExpanded(false); }}
          data-testid="timeline-overlay"
        >
          <div
            className="relative bg-white rounded-xl shadow-2xl flex flex-col"
            style={{ width: '95vw', height: '95vh' }}
          >
            <div className="flex items-center justify-between px-8 py-5 border-b border-slate-200 shrink-0">
              <h2 className="text-2xl font-bold text-slate-900" data-testid="timeline-overlay-title">
                {title || 'Timeline'}
              </h2>
              <button
                onClick={() => setIsExpanded(false)}
                className="p-2 rounded-md hover:bg-slate-100 transition-colors"
                aria-label="Close fullscreen"
                data-testid="button-timeline-close-overlay"
              >
                <X className="w-5 h-5 text-slate-600" />
              </button>
            </div>
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-y-auto px-8 py-6"
            >
              {isMobile ? (
                <>
                  <div
                    className="flex overflow-x-auto gap-2 pb-3 mb-6 sticky z-20 bg-white/95 backdrop-blur-sm pt-2"
                    style={{ top: 0 }}
                    role="tablist"
                    aria-label="Timeline years"
                  >
                    {items.map((item) => (
                      <button
                        key={item.year}
                        onClick={() => scrollToSection(item.year)}
                        role="tab"
                        aria-selected={activeYear === item.year}
                        className="shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap"
                        style={{
                          backgroundColor: activeYear === item.year ? active_color : 'transparent',
                          color: activeYear === item.year ? '#ffffff' : '#6b7280',
                          border: `1px solid ${activeYear === item.year ? active_color : '#d1d5db'}`
                        }}
                        data-testid={`timeline-overlay-marker-${item.year}`}
                      >
                        {item.year}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-8">
                    {items.map((item) => mobileContentSection(item))}
                  </div>
                </>
              ) : (
                desktopTimeline(true)
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  /* ── Mobile layout (inline) ── */
  if (isMobile) {
    return (
      <div id={anchor || undefined} className="relative" data-testid="timeline-mobile">
        {expandButton}
        {title && (
          <h2 className="text-2xl font-bold text-slate-900 mb-6" data-testid="timeline-title">{title}</h2>
        )}

        <div className="flex overflow-x-auto gap-2 pb-3 mb-6 sticky z-20 bg-white/95 backdrop-blur-sm pt-2"
          style={{ top: `${header_offset}px` }}
          role="tablist"
          aria-label="Timeline years"
        >
          {items.map((item) => (
            <button
              key={item.year}
              onClick={() => scrollToSection(item.year)}
              role="tab"
              aria-selected={activeYear === item.year}
              aria-current={activeYear === item.year ? 'true' : undefined}
              className="shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap"
              style={{
                backgroundColor: activeYear === item.year ? active_color : 'transparent',
                color: activeYear === item.year ? '#ffffff' : '#6b7280',
                border: `1px solid ${activeYear === item.year ? active_color : '#d1d5db'}`
              }}
              data-testid={`timeline-marker-${item.year}`}
            >
              {item.year}
            </button>
          ))}
        </div>

        <div className="space-y-8">
          {items.map((item) => mobileContentSection(item))}
        </div>
      </div>
    );
  }

  /* ── Desktop layout (inline) ── */
  return (
    <div id={anchor || undefined} className="relative" data-testid="timeline-desktop">
      {expandButton}
      {title && (
        <h2 className="text-3xl font-bold text-slate-900 mb-10" data-testid="timeline-title">{title}</h2>
      )}
      {desktopTimeline(false)}
    </div>
  );
}

/* ────────────────────────── EDITOR ────────────────────────── */

export function IEditTimelineElementEditor({ element, onChange }) {
  const [expandedItem, setExpandedItem] = useState(null);
  const [isUploading, setIsUploading] = useState({});
  const [dragIndex, setDragIndex] = useState(null);

  const content = element.content || {};
  const items = content.items || [];

  const updateContent = (key, value) => {
    onChange({
      ...element,
      content: {
        ...(element.content || {}),
        [key]: value
      }
    });
  };

  const updateItem = (index, key, value) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [key]: value };
    updateContent('items', newItems);
  };

  const updateItemMedia = (index, key, value) => {
    const newItems = [...items];
    const currentMedia = newItems[index].media || { type: 'image', src: '', alt: '' };
    newItems[index] = {
      ...newItems[index],
      media: { ...currentMedia, [key]: value }
    };
    updateContent('items', newItems);
  };

  const addItem = () => {
    const nextYear = items.length > 0
      ? String(Math.max(...items.map(i => parseInt(i.year) || 2000)) + 1)
      : String(new Date().getFullYear());
    const newItems = [...items, {
      year: nextYear,
      heading: '',
      body: '',
      media: { type: 'image', src: '', alt: '' }
    }];
    updateContent('items', newItems);
    setExpandedItem(newItems.length - 1);
  };

  const removeItem = (index) => {
    const newItems = items.filter((_, i) => i !== index);
    updateContent('items', newItems);
    if (expandedItem === index) setExpandedItem(null);
  };

  const moveItem = (fromIndex, toIndex) => {
    if (toIndex < 0 || toIndex >= items.length) return;
    const newItems = [...items];
    const [moved] = newItems.splice(fromIndex, 1);
    newItems.splice(toIndex, 0, moved);
    updateContent('items', newItems);
    setExpandedItem(toIndex);
  };

  const handleImageUpload = async (index, file) => {
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      alert('Please upload a valid image file (JPEG, PNG, GIF, WebP)');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert('Image must be smaller than 10MB');
      return;
    }

    setIsUploading(prev => ({ ...prev, [index]: true }));
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      const newItems = [...items];
      const currentMedia = newItems[index].media || { type: 'image', src: '', alt: '' };
      newItems[index] = {
        ...newItems[index],
        media: { ...currentMedia, src: response.file_url, type: 'image' }
      };
      updateContent('items', newItems);
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsUploading(prev => ({ ...prev, [index]: false }));
    }
  };

  return (
    <div className="space-y-5">
      {/* Title */}
      <div>
        <Label className="text-sm font-medium text-slate-700">Timeline Title</Label>
        <Input
          value={content.title || ''}
          onChange={(e) => updateContent('title', e.target.value)}
          placeholder="e.g., Our History"
          className="mt-1"
          data-testid="input-timeline-title"
        />
      </div>

      {/* Anchor ID */}
      <div>
        <Label className="text-sm font-medium text-slate-700">Anchor ID (optional)</Label>
        <Input
          value={content.anchor || ''}
          onChange={(e) => updateContent('anchor', e.target.value)}
          placeholder="e.g., our-history"
          className="mt-1"
          data-testid="input-timeline-anchor"
        />
        <p className="text-xs text-slate-400 mt-1">For in-page linking</p>
      </div>

      {/* Styling */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-sm font-medium text-slate-700">Line Colour</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={content.line_color || '#d1d5db'}
              onChange={(e) => updateContent('line_color', e.target.value)}
              className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              value={content.line_color || '#d1d5db'}
              onChange={(e) => updateContent('line_color', e.target.value)}
              className="flex-1"
            />
          </div>
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Active Colour</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={content.active_color || '#2563eb'}
              onChange={(e) => updateContent('active_color', e.target.value)}
              className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              value={content.active_color || '#2563eb'}
              onChange={(e) => updateContent('active_color', e.target.value)}
              className="flex-1"
            />
          </div>
        </div>
      </div>

      <div>
        <Label className="text-sm font-medium text-slate-700">Header Offset (px)</Label>
        <Input
          type="number"
          value={content.header_offset ?? 80}
          onChange={(e) => updateContent('header_offset', parseInt(e.target.value) || 0)}
          min="0"
          max="300"
          className="mt-1"
        />
        <p className="text-xs text-slate-400 mt-1">Accounts for a fixed header when scrolling</p>
      </div>

      {/* Items */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label className="text-sm font-medium text-slate-700">
            Timeline Items ({items.length})
          </Label>
          <Button
            variant="outline"
            size="sm"
            onClick={addItem}
            data-testid="button-add-timeline-item"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Item
          </Button>
        </div>

        <div className="space-y-2">
          {items.map((item, index) => {
            const isExpanded = expandedItem === index;
            return (
              <div
                key={index}
                className="border border-slate-200 rounded-lg overflow-hidden bg-white"
              >
                {/* Item header */}
                <div
                  className="flex items-center gap-2 px-3 py-2 bg-slate-50 cursor-pointer select-none"
                  onClick={() => setExpandedItem(isExpanded ? null : index)}
                >
                  <GripVertical className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="font-mono font-semibold text-sm text-slate-700 shrink-0">
                    {item.year || '????'}
                  </span>
                  <span className="text-sm text-slate-500 truncate flex-1">
                    {item.heading || '(no heading)'}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); moveItem(index, index - 1); }}
                      disabled={index === 0}
                      className="p-1 rounded text-slate-400 hover:text-slate-600 disabled:opacity-30"
                      title="Move up"
                      data-testid={`button-move-up-${index}`}
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); moveItem(index, index + 1); }}
                      disabled={index === items.length - 1}
                      className="p-1 rounded text-slate-400 hover:text-slate-600 disabled:opacity-30"
                      title="Move down"
                      data-testid={`button-move-down-${index}`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeItem(index); }}
                      className="p-1 rounded text-red-400 hover:text-red-600"
                      title="Remove item"
                      data-testid={`button-remove-item-${index}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </div>
                </div>

                {/* Item body */}
                {isExpanded && (
                  <div className="p-3 space-y-3 border-t border-slate-200">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-slate-600">Year</Label>
                        <Input
                          value={item.year || ''}
                          onChange={(e) => updateItem(index, 'year', e.target.value)}
                          placeholder="e.g., 1998"
                          className="mt-1"
                          data-testid={`input-year-${index}`}
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-slate-600">Heading</Label>
                        <Input
                          value={item.heading || ''}
                          onChange={(e) => updateItem(index, 'heading', e.target.value)}
                          placeholder="e.g., Founded"
                          className="mt-1"
                          data-testid={`input-heading-${index}`}
                        />
                      </div>
                    </div>

                    <div>
                      <Label className="text-xs text-slate-600">Body Content</Label>
                      <div className="mt-1 [&_.ql-container]:min-h-[80px] [&_.ql-editor]:min-h-[80px]">
                        <ReactQuill
                          theme="snow"
                          value={item.body || ''}
                          onChange={(val) => updateItem(index, 'body', val)}
                          modules={timelineQuillModules}
                          formats={timelineQuillFormats}
                        />
                      </div>
                    </div>

                    {/* Media */}
                    <div>
                      <Label className="text-xs text-slate-600">Image (optional)</Label>
                      <div className="mt-1 space-y-2">
                        {item.media?.src ? (
                          <div className="relative rounded-lg overflow-hidden border border-slate-200">
                            <img
                              src={item.media.src}
                              alt={item.media.alt || ''}
                              className="w-full h-32 object-cover"
                              onError={(e) => { e.target.style.display = 'none'; }}
                            />
                            <button
                              onClick={() => {
                                const newItems = [...items];
                                newItems[index] = {
                                  ...newItems[index],
                                  media: { type: 'image', src: '', alt: '' }
                                };
                                updateContent('items', newItems);
                              }}
                              className="absolute top-2 right-2 p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
                              title="Remove image"
                              type="button"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <Input
                              value={item.media?.src || ''}
                              onChange={(e) => updateItemMedia(index, 'src', e.target.value)}
                              placeholder="Enter image URL or upload..."
                              className="flex-1"
                            />
                            <label className="cursor-pointer">
                              <div className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                                isUploading[index]
                                  ? 'bg-slate-300 cursor-not-allowed'
                                  : 'bg-blue-600 hover:bg-blue-700 text-white'
                              }`}>
                                {isUploading[index] ? (
                                  <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                                ) : (
                                  <Upload className="w-4 h-4" />
                                )}
                              </div>
                              <input
                                type="file"
                                accept="image/*"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleImageUpload(index, file);
                                  e.target.value = '';
                                }}
                                className="hidden"
                                disabled={isUploading[index]}
                              />
                            </label>
                          </div>
                        )}
                        {item.media?.src && (
                          <Input
                            value={item.media?.alt || ''}
                            onChange={(e) => updateItemMedia(index, 'alt', e.target.value)}
                            placeholder="Alt text for accessibility"
                            className="text-xs"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {items.length === 0 && (
          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-lg">
            <p className="text-sm text-slate-400 mb-2">No timeline items yet</p>
            <Button variant="outline" size="sm" onClick={addItem}>
              <Plus className="w-4 h-4 mr-1" />
              Add First Item
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
