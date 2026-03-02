import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from "react";
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
  ChevronLeft,
  ChevronRight,
  Upload,
  Image,
  X,
  Maximize2,
  Minimize2,
  Star,
  Circle,
  Diamond,
  Heart,
  Hexagon,
  Square,
  Triangle,
  Shield,
  Crown,
  Trophy,
  Flag,
  Zap,
  Flame,
  Award,
  Bookmark
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";

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

const MARKER_SHAPES = [
  { value: 'circle', label: 'Circle', Icon: Circle },
  { value: 'star', label: 'Star', Icon: Star },
  { value: 'diamond', label: 'Diamond', Icon: Diamond },
  { value: 'heart', label: 'Heart', Icon: Heart },
  { value: 'hexagon', label: 'Hexagon', Icon: Hexagon },
  { value: 'square', label: 'Square', Icon: Square },
  { value: 'triangle', label: 'Triangle', Icon: Triangle },
  { value: 'shield', label: 'Shield', Icon: Shield },
  { value: 'crown', label: 'Crown', Icon: Crown },
  { value: 'trophy', label: 'Trophy', Icon: Trophy },
  { value: 'flag', label: 'Flag', Icon: Flag },
  { value: 'bolt', label: 'Bolt', Icon: Zap },
  { value: 'flame', label: 'Flame', Icon: Flame },
  { value: 'award', label: 'Award', Icon: Award },
  { value: 'bookmark', label: 'Bookmark', Icon: Bookmark },
];

function getMarkerShapeIcon(shape) {
  const found = MARKER_SHAPES.find(s => s.value === shape);
  return found ? found.Icon : null;
}

function getContentWidthStyle(content, inModal = false) {
  const w = inModal ? (content.content_width_modal ?? content.content_width ?? 100) : (content.content_width ?? 100);
  if (w >= 100) return null;
  const style = { width: `${w}%` };
  const align = content.content_align || 'center';
  if (align === 'center') {
    style.marginLeft = 'auto';
    style.marginRight = 'auto';
  } else if (align === 'right') {
    style.marginLeft = 'auto';
    style.marginRight = '0';
  } else {
    style.marginLeft = '0';
    style.marginRight = 'auto';
  }
  return style;
}

function getHighlightStyle(highlight) {
  if (!highlight?.enabled) return null;
  const style = {};
  const bgType = highlight.bg_type || 'solid';
  if (bgType === 'solid') {
    style.backgroundColor = highlight.bg_color || '#1e3a5f';
  } else if (bgType === 'gradient') {
    const from = highlight.bg_gradient_from || '#1e3a5f';
    const to = highlight.bg_gradient_to || '#4a90d9';
    const angle = highlight.bg_gradient_angle ?? 135;
    style.background = `linear-gradient(${angle}deg, ${from}, ${to})`;
  } else if (bgType === 'image' && highlight.bg_image) {
    style.backgroundImage = `url(${highlight.bg_image})`;
    style.backgroundSize = 'cover';
    style.backgroundPosition = 'center';
  }
  if (highlight.text_color) {
    style.color = highlight.text_color;
  }
  if (highlight.border_enabled) {
    const bw = highlight.border_width ?? 1;
    const bc = highlight.border_color || '#e2e8f0';
    const bs = highlight.border_style || 'solid';
    style.border = `${bw}px ${bs} ${bc}`;
  }
  if (highlight.shadow && highlight.shadow !== 'none') {
    const shadows = {
      sm: '0 1px 2px 0 rgba(0,0,0,0.05)',
      md: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
      lg: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
      xl: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
      glow: `0 0 15px 2px ${(highlight.shadow_color || '#3b82f6')}40, 0 0 30px 4px ${(highlight.shadow_color || '#3b82f6')}20`,
    };
    style.boxShadow = shadows[highlight.shadow] || shadows.md;
  }
  return style;
}

function getMediaItems(item) {
  if (item.media_items && item.media_items.length > 0) {
    return item.media_items.filter(m => m && m.src);
  }
  if (item.media && item.media.src) {
    return [{ src: item.media.src, alt: item.media.alt || '' }];
  }
  return [];
}

function TimelineImageCarousel({ images, year, heading, maxHeightClass = 'max-h-80', maxWidthClass = 'max-w-2xl' }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [api, setApi] = useState(null);

  useEffect(() => {
    if (!api) return;
    const onSelect = () => setCurrentIndex(api.selectedScrollSnap());
    api.on('select', onSelect);
    onSelect();
    return () => { api.off('select', onSelect); };
  }, [api]);

  if (images.length === 0) return null;

  const getImageClasses = (img) => {
    const display = img.display || 'original';
    if (display === 'circle') return `rounded-full object-cover aspect-square`;
    if (display === 'square') return `rounded-lg object-cover aspect-square`;
    return `rounded-lg object-cover ${maxHeightClass}`;
  };

  if (images.length === 1) {
    const cls = getImageClasses(images[0]);
    const isShaped = images[0].display === 'circle' || images[0].display === 'square';
    const img = (
      <img
        src={images[0].src}
        alt={images[0].alt || heading || year}
        className={`${isShaped ? 'h-64' : 'w-full'} ${isShaped ? '' : maxWidthClass} ${cls}`}
        loading="lazy"
        data-testid={`timeline-image-${year}`}
      />
    );
    return isShaped ? <div className="flex justify-center">{img}</div> : img;
  }

  return (
    <div className={`relative ${maxWidthClass}`} data-testid={`timeline-carousel-${year}`}>
      <Carousel setApi={setApi} opts={{ loop: true }} className="w-full">
        <CarouselContent>
          {images.map((img, idx) => {
            const cls = getImageClasses(img);
            const isShaped = img.display === 'circle' || img.display === 'square';
            return (
            <CarouselItem key={idx} className={isShaped ? 'flex justify-center' : ''}>
              <img
                src={img.src}
                alt={img.alt || heading || `${year} image ${idx + 1}`}
                className={`${isShaped ? 'h-64' : 'w-full'} ${cls}`}
                loading="lazy"
                data-testid={`timeline-image-${year}-${idx}`}
              />
            </CarouselItem>
            );
          })}
        </CarouselContent>
        <button
          onClick={() => api?.scrollPrev()}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
          aria-label="Previous image"
          data-testid={`button-carousel-prev-${year}`}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => api?.scrollNext()}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
          aria-label="Next image"
          data-testid={`button-carousel-next-${year}`}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </Carousel>
      <div className="flex justify-center gap-1.5 mt-2">
        {images.map((_, idx) => (
          <button
            key={idx}
            onClick={() => api?.scrollTo(idx)}
            className={`w-2 h-2 rounded-full transition-colors ${idx === currentIndex ? 'bg-slate-800' : 'bg-slate-300'}`}
            aria-label={`Go to image ${idx + 1}`}
            data-testid={`button-carousel-dot-${year}-${idx}`}
          />
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────── RENDERER ────────────────────────── */

export function IEditTimelineElementRenderer({ content, variant, settings }) {
  const isMobile = useIsMobile();
  const [activeYear, setActiveYear] = useState(null);
  const [isExpanded, setIsExpanded] = useState(!!(content || {}).auto_expand);
  const [expandedTexts, setExpandedTexts] = useState({});
  const sectionRefs = useRef({});
  const railRef = useRef(null);
  const navRef = useRef(null);
  const contentPanelRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const isClickScrolling = useRef(false);
  const prefersReducedMotion = useRef(false);
  const [bgLeft, setBgLeft] = useState(0);
  const overlayScrollRef = useRef(null);
  const [overlayRect, setOverlayRect] = useState(null);
  const [navLinePath, setNavLinePath] = useState('');
  const subDotCorrectionRef = useRef(0);
  const [subDotCorrection, setSubDotCorrection] = useState(0);
  const {
    title,
    items = [],
    line_color = '#d1d5db',
    active_color = '#2563eb',
    marker_size = 14,
    header_offset = 80,
    anchor,
    background_image,
    background_opacity = 0.15,
    gradient_stops,
    gradient_angle = 180,
    background_type: _bg_type,
    background_color,
    background_gradient_from,
    background_gradient_to,
    background_gradient_angle = 135,
    background_mode = 'unified',
    rail_background_type: _rail_bg_type,
    rail_background_color,
    rail_background_gradient_from,
    rail_background_gradient_to,
    rail_background_gradient_angle = 135,
    rail_background_image,
    rail_gradient_stops,
    rail_gradient_angle = 180,
    nav_top_offset = 0,
    nav_bottom_offset = 0,
    label_position = 'below',
    sub_offset_x = 0,
    sub_offset_y = 0,
    line_style = 'straight',
    line_weight = 2,
    line_dash = 'solid',
    marker_color: timeline_marker_color,
    label_size = 14,
    heading_size = 20,
    heading_color = '',
    body_size = 16,
    body_color = '',
    label_color = '#9ca3af',
    content_layout = 'stacked',
    content_media_side = 'left',
  } = content || {};

  const effectiveBgType = _bg_type || (background_image ? 'image' : 'none');
  const effectiveRailBgType = _rail_bg_type || (rail_background_image ? 'image' : 'none');
  const isLeftLabel = label_position === 'left';

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

  const hasContentBg = effectiveBgType !== 'none' && (effectiveBgType !== 'image' || !!background_image);
  const hasRailBg = background_mode === 'split' && effectiveRailBgType !== 'none' && (effectiveRailBgType !== 'image' || !!rail_background_image);
  const hasBgActive = hasContentBg || hasRailBg;

  useEffect(() => {
    if (!hasBgActive || !contentPanelRef.current) return;
    const updateBgLeft = () => {
      if (contentPanelRef.current) {
        setBgLeft(contentPanelRef.current.getBoundingClientRect().left);
      }
    };
    updateBgLeft();
    window.addEventListener('resize', updateBgLeft);
    const ro = new ResizeObserver(updateBgLeft);
    ro.observe(contentPanelRef.current);
    return () => {
      window.removeEventListener('resize', updateBgLeft);
      ro.disconnect();
    };
  }, [hasBgActive, isExpanded]);

  useEffect(() => {
    if (!isExpanded || !hasBgActive || !overlayScrollRef.current) {
      setOverlayRect(null);
      return;
    }
    const update = () => {
      if (overlayScrollRef.current) {
        const r = overlayScrollRef.current.getBoundingClientRect();
        setOverlayRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      }
    };
    update();
    window.addEventListener('resize', update);
    const ro = new ResizeObserver(update);
    ro.observe(overlayScrollRef.current);
    return () => {
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
  }, [isExpanded, hasBgActive]);

  useEffect(() => {
    if (!activeYear || !railRef.current) return;
    const activeMarker = railRef.current.querySelector(`[data-testid="timeline-marker-${activeYear}"]`) ||
      railRef.current.querySelector(`[data-testid="timeline-marker-sub-${activeYear}"]`);
    if (activeMarker) {
      const rail = railRef.current;
      const railRect = rail.getBoundingClientRect();
      const markerRect = activeMarker.getBoundingClientRect();
      const markerCenter = markerRect.top + markerRect.height / 2;
      const railCenter = railRect.top + railRect.height / 2;
      const offset = markerCenter - railCenter;
      rail.scrollTo({
        top: rail.scrollTop + offset,
        behavior: prefersReducedMotion.current ? 'auto' : 'smooth'
      });
    }
  }, [activeYear]);

  useEffect(() => {
    if (items.length > 0 && !activeYear) {
      setActiveYear(items[0].year);
    }
  }, [items]);

  useEffect(() => {
    if (!isExpanded || !scrollContainerRef.current) return;
    const container = scrollContainerRef.current;
    container.scrollTop = 0;

    const observer = new MutationObserver(() => {
      if (container.scrollTop !== 0 && isClickScrolling.current === false) {
        container.scrollTop = 0;
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['height', 'style'] });

    const images = container.querySelectorAll('img');
    let loaded = 0;
    const total = images.length;
    const onLoad = () => {
      loaded++;
      if (loaded >= total) {
        observer.disconnect();
      }
    };
    images.forEach((img) => {
      if (img.complete) {
        loaded++;
      } else {
        img.addEventListener('load', onLoad, { once: true });
        img.addEventListener('error', onLoad, { once: true });
      }
    });
    if (loaded >= total) {
      observer.disconnect();
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
    }, 5000);

    return () => {
      observer.disconnect();
      clearTimeout(timeout);
      images.forEach((img) => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onLoad);
      });
    };
  }, [isExpanded]);

  useEffect(() => {
    if (!items.length) return;

    const effectiveOffset = isExpanded ? 16 : header_offset;

    const handleScroll = () => {
      if (isClickScrolling.current) return;

      const container = isExpanded ? scrollContainerRef.current : null;
      const scrollTop = container ? container.scrollTop : window.scrollY;
      const containerTop = container ? container.getBoundingClientRect().top : 0;
      const threshold = effectiveOffset + 40;

      let bestYear = null;
      let bestDistance = Infinity;

      for (const year of Object.keys(sectionRefs.current)) {
        const el = sectionRefs.current[year];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const topRelative = container
          ? rect.top - containerTop
          : rect.top;
        const distance = topRelative - threshold;

        if (distance <= 0 && Math.abs(distance) < bestDistance) {
          bestDistance = Math.abs(distance);
          bestYear = year;
        }
      }

      if (!bestYear) {
        let closestAbove = null;
        let closestDist = Infinity;
        for (const year of Object.keys(sectionRefs.current)) {
          const el = sectionRefs.current[year];
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const topRelative = container ? rect.top - containerTop : rect.top;
          if (topRelative < closestDist) {
            closestDist = topRelative;
            closestAbove = year;
          }
        }
        bestYear = closestAbove;
      }

      if (bestYear) setActiveYear(bestYear);
    };

    const target = isExpanded ? scrollContainerRef.current : window;
    if (target) {
      target.addEventListener('scroll', handleScroll, { passive: true });
      handleScroll();
    }

    return () => {
      if (target) target.removeEventListener('scroll', handleScroll);
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

  const computeNavLine = useCallback(() => {
    const nav = navRef.current;
    if (!nav || !items.length) { setNavLinePath(''); return; }
    const navRect = nav.getBoundingClientRect();
    const navH = navRect.height;
    if (!navH) return;

    const findDotCenter = (dotKey) => {
      const el = nav.querySelector(`[data-dot-key="${dotKey}"]`);
      if (!el) return null;
      const dotR = el.getBoundingClientRect();
      return {
        cx: dotR.left + dotR.width / 2 - navRect.left,
        cy: dotR.top + dotR.height / 2 - navRect.top,
      };
    };

    const markers = [];
    let mainX = null;
    items.forEach((item) => {
      const pos = findDotCenter(item.year);
      if (pos) {
        if (mainX === null) mainX = pos.cx;
        markers.push({ type: 'parent', ...pos, year: item.year });
      }
      (item.sub_items || []).forEach((sub, sIdx) => {
        const subKey = `${item.year}-sub${sIdx}-${sub.year}`;
        const subPos = findDotCenter(subKey);
        if (subPos) {
          markers.push({ type: 'sub', ...subPos, year: subKey });
        }
      });
    });

    if (!markers.length || mainX === null) { setNavLinePath(''); return; }

    markers.sort((a, b) => a.cy - b.cy);
    const pts = [{ cx: mainX, cy: 0 }, ...markers, { cx: mainX, cy: navH }];

    const seededRandom = (idx, salt) => {
      const seed = Math.sin(idx * 127.1 + salt * 311.7) * 43758.5453;
      return seed - Math.floor(seed);
    };

    let d = `M ${pts[0].cx} ${pts[0].cy}`;

    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];

      if (line_style === 'organic') {
        const dx = cur.cx - prev.cx;
        const dy = cur.cy - prev.cy;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) { d += ` L ${cur.cx} ${cur.cy}`; continue; }
        const nx = -dy / len;
        const ny = dx / len;
        const wobble1 = (seededRandom(i, 1) - 0.5) * Math.min(16, len * 0.3);
        const wobble2 = (seededRandom(i, 2) - 0.5) * Math.min(16, len * 0.3);
        const cp1x = prev.cx + dx * 0.33 + nx * wobble1;
        const cp1y = prev.cy + dy * 0.33 + ny * wobble1;
        const cp2x = prev.cx + dx * 0.66 + nx * wobble2;
        const cp2y = prev.cy + dy * 0.66 + ny * wobble2;
        d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${cur.cx} ${cur.cy}`;
      } else {
        d += ` L ${cur.cx} ${cur.cy}`;
      }
    }

    setNavLinePath(d);
  }, [items, marker_size, isLeftLabel, nav_top_offset, nav_bottom_offset, line_style]);

  const measureSubDotCorrection = useCallback(() => {
    const nav = navRef.current;
    if (!nav || !items.length) return;
    const parentWithSubs = items.find(item => (item.sub_items || []).length > 0);
    if (!parentWithSubs) return;
    const firstSubKey = `${parentWithSubs.year}-sub0-${parentWithSubs.sub_items[0].year}`;
    const parentDot = nav.querySelector(`[data-dot-key="${parentWithSubs.year}"]`);
    const subDot = nav.querySelector(`[data-dot-key="${firstSubKey}"]`);
    if (!parentDot || !subDot) return;
    const parentCx = parentDot.getBoundingClientRect().left + parentDot.getBoundingClientRect().width / 2;
    const subCx = subDot.getBoundingClientRect().left + subDot.getBoundingClientRect().width / 2;
    const subOffX = typeof parentWithSubs.sub_items[0].offset_x === 'number' ? parentWithSubs.sub_items[0].offset_x : sub_offset_x;
    const currentCorrection = subDotCorrectionRef.current;
    const naturalDelta = parentCx - (subCx - currentCorrection - subOffX);
    const newCorrection = Math.round(naturalDelta);
    if (Math.abs(newCorrection - currentCorrection) > 0.5) {
      subDotCorrectionRef.current = newCorrection;
      setSubDotCorrection(newCorrection);
    }
  }, [items, sub_offset_x, isLeftLabel]);

  useEffect(() => {
    measureSubDotCorrection();
    const t1 = setTimeout(() => { computeNavLine(); }, 50);
    const t2 = setTimeout(() => { measureSubDotCorrection(); computeNavLine(); }, 200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [computeNavLine, measureSubDotCorrection, items, activeYear, sub_offset_x, sub_offset_y, subDotCorrection]);

  useEffect(() => {
    const observer = new ResizeObserver(() => { measureSubDotCorrection(); computeNavLine(); });
    if (navRef.current) observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [computeNavLine, measureSubDotCorrection]);

  const scrollToSection = useCallback((year) => {
    const el = sectionRefs.current[year];
    if (!el) return;

    isClickScrolling.current = true;
    setActiveYear(year);

    const behavior = prefersReducedMotion.current ? 'auto' : 'smooth';
    const container = scrollContainerRef.current;
    const effectiveOffset = isExpanded ? 16 : header_offset;

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

  const renderMarkerDot = (item, isActive, size_override, dotKey) => {
    const hl = item.highlight;
    const shape = hl?.enabled ? (hl.marker_shape || 'circle') : 'circle';
    const ShapeIcon = shape !== 'circle' ? getMarkerShapeIcon(shape) : null;
    const customColor = item.marker_color || (hl?.enabled && hl.marker_color ? hl.marker_color : null);
    const markerBg = hl?.enabled && hl.marker_bg ? hl.marker_bg : null;
    const markerBorderColor = hl?.enabled && hl.marker_border_color ? hl.marker_border_color : null;
    const mSize = size_override || marker_size;
    const defaultColor = isActive ? active_color : (timeline_marker_color || line_color);
    const fillColor = customColor || defaultColor;

    const wrapperStyle = {};
    if (markerBg || markerBorderColor) {
      const pad = Math.max(4, Math.round(mSize * 0.35));
      wrapperStyle.padding = `${pad}px`;
      wrapperStyle.borderRadius = '50%';
      wrapperStyle.display = 'flex';
      wrapperStyle.alignItems = 'center';
      wrapperStyle.justifyContent = 'center';
      if (markerBg) wrapperStyle.backgroundColor = markerBg;
      if (markerBorderColor) {
        wrapperStyle.border = `2px solid ${markerBorderColor}`;
      }
    }

    const hasWrapper = markerBg || markerBorderColor;
    const size = isActive ? mSize + 4 : mSize;
    const stableSize = mSize + 4;

    const stableContainer = (child) => (
      <div
        data-dot-stable
        {...(dotKey ? { 'data-dot-key': dotKey } : {})}
        className="flex items-center justify-center"
        style={{ width: `${stableSize}px`, height: `${stableSize}px`, flexShrink: 0 }}
      >
        {child}
      </div>
    );

    if (ShapeIcon) {
      const icon = (
        <ShapeIcon
          className="transition-all duration-200"
          style={{
            width: `${size}px`,
            height: `${size}px`,
            color: fillColor,
            fill: fillColor,
            filter: isActive ? `drop-shadow(0 0 3px ${fillColor}33)` : 'none',
          }}
        />
      );
      const inner = hasWrapper ? <div style={wrapperStyle} className="transition-all duration-200">{icon}</div> : icon;
      return stableContainer(inner);
    }
    const dot = (
      <div
        className="rounded-full transition-all duration-200 ring-2 ring-white"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: fillColor,
          boxShadow: isActive ? `0 0 0 3px ${fillColor}33` : 'none'
        }}
      />
    );
    const inner = hasWrapper ? <div style={wrapperStyle} className="transition-all duration-200">{dot}</div> : dot;
    return stableContainer(inner);
  };

  const markerNav = (idx, item) => {
    const isActive = activeYear === item.year;
    return (
      <button
        key={item.year}
        onClick={() => scrollToSection(item.year)}
        role="tab"
        aria-selected={isActive}
        aria-current={isActive ? 'true' : undefined}
        className={`relative z-10 flex group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
          isLeftLabel ? 'flex-row items-center' : 'flex-col items-center'
        }`}
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
        {isLeftLabel && (
          <span
            className="mr-2 whitespace-nowrap transition-colors duration-200"
            style={{
              fontSize: `${item.label_size || label_size}px`,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? active_color : (item.label_color || label_color)
            }}
          >
            {item.year}
          </span>
        )}
        {renderMarkerDot(item, isActive, undefined, item.year)}
        {!isLeftLabel && (
          <span
            className="mt-1.5 transition-colors duration-200"
            style={{
              fontSize: `${item.label_size || label_size}px`,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? active_color : (item.label_color || label_color)
            }}
          >
            {item.year}
          </span>
        )}
      </button>
    );
  };

  const contentSection = (item, idx, inOverlay = false) => {
    const isActive = activeYear === item.year;
    const effectiveOffset = isExpanded ? 16 : header_offset;
    const widthStyle = getContentWidthStyle(content, inOverlay);
    const hlStyle = getHighlightStyle(item.highlight);
    const isHighlighted = !!hlStyle;
    const isImageBg = isHighlighted && item.highlight.bg_type === 'image' && item.highlight.bg_image;
    const textColor = isHighlighted ? item.highlight.text_color : undefined;

    const itemHeadingSize = item.heading_size || heading_size;
    const itemHeadingColor = item.heading_color || heading_color || '#1e293b';
    const itemBodySize = item.body_size || body_size;
    const itemBodyColor = item.body_color || body_color || '';

    const itemLayout = item.content_layout || content_layout;
    const isSideBySide = itemLayout === 'side-by-side';
    const isInline = itemLayout === 'inline';
    const isSideLayout = isSideBySide || isInline;
    const itemMediaSide = item.content_media_side || content_media_side;
    const mediaOnRight = itemMediaSide === 'right';

    const headingBlock = (
      <div className={`flex items-baseline gap-3 ${isSideLayout ? 'mb-2' : 'mb-3'}`}>
        <span
          className="font-bold transition-colors duration-200"
          style={{ fontSize: `${Math.round(itemHeadingSize * 1.2)}px`, color: textColor || (isActive ? active_color : (item.label_color || label_color)) }}
        >
          {item.year}
        </span>
        {item.heading && (
          <h3 className="font-semibold" style={{ fontSize: `${itemHeadingSize}px`, color: textColor || itemHeadingColor }}>{item.heading}</h3>
        )}
      </div>
    );

    const mediaBlock = item.media?.type === 'video' && item.media?.src && !item.media_items?.length ? (
      <div className={`${isSideLayout ? '' : 'mb-4'} rounded-lg overflow-hidden`}>
        <video
          src={item.media.src}
          controls
          className="w-full max-w-2xl rounded-lg"
          data-testid={`timeline-video-${item.year}`}
        />
      </div>
    ) : (() => {
      const mediaImages = getMediaItems(item);
      return mediaImages.length > 0 ? (
        <div className={`${isSideLayout ? '' : 'mb-4'} rounded-lg overflow-visible`}>
          <TimelineImageCarousel images={mediaImages} year={item.year} heading={item.heading} maxHeightClass={isSideLayout ? 'max-h-64' : 'max-h-80'} maxWidthClass={isSideLayout ? 'w-full' : 'max-w-2xl'} />
        </div>
      ) : null;
    })();

    const hlTextLines = isHighlighted && item.highlight.text_lines ? item.highlight.text_lines : 0;
    const isTextExpanded = !!expandedTexts[item.year];
    const shouldClamp = hlTextLines > 0 && !isTextExpanded;

    const bodyBlock = item.body ? (
      <div>
        <div
          className="prose max-w-none"
          style={{
            fontSize: `${itemBodySize}px`,
            ...(textColor ? { color: textColor } : itemBodyColor ? { color: itemBodyColor } : {}),
            ...(shouldClamp ? {
              display: '-webkit-box',
              WebkitLineClamp: hlTextLines,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            } : {}),
          }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(item.body) }}
        />
        {hlTextLines > 0 && (
          <button
            type="button"
            onClick={() => setExpandedTexts(prev => ({ ...prev, [item.year]: !prev[item.year] }))}
            className="mt-2 text-sm font-medium transition-colors"
            style={{ color: textColor || active_color }}
            data-testid={`button-read-more-${item.year}`}
          >
            {isTextExpanded ? 'Read less' : 'Read more'}
          </button>
        )}
      </div>
    ) : null;

    const mediaCol = <div className="w-2/5 shrink-0">{mediaBlock}</div>;
    const textCol = <div className="flex-1 min-w-0">{headingBlock}{bodyBlock}</div>;
    const bodyCol = <div className="flex-1 min-w-0">{bodyBlock}</div>;

    let innerContent;
    if (isInline && mediaBlock) {
      innerContent = (
        <div className={`flex gap-4 ${mediaOnRight ? 'flex-row-reverse' : 'flex-row'}`}>
          {mediaCol}
          {textCol}
        </div>
      );
    } else if (isSideBySide && mediaBlock) {
      innerContent = (
        <>
          {headingBlock}
          <div className={`flex gap-4 ${mediaOnRight ? 'flex-row-reverse' : 'flex-row'}`}>
            {mediaCol}
            {bodyCol}
          </div>
        </>
      );
    } else {
      innerContent = (
        <>
          {headingBlock}
          {mediaBlock}
          {bodyBlock}
        </>
      );
    }

    return (
      <div
        key={item.year}
        ref={(el) => setSectionRef(item.year, el)}
        data-year={item.year}
        style={{
          scrollMarginTop: `${effectiveOffset + 8}px`,
          marginBottom: idx < items.length - 1 ? '48px' : 0,
          ...widthStyle,
        }}
        data-testid={`timeline-section-${item.year}`}
      >
        {isHighlighted ? (
          <div
            className="relative rounded-lg p-6 overflow-hidden"
            style={hlStyle}
            data-testid={`timeline-highlight-${item.year}`}
          >
            {isImageBg && (
              <div className="absolute inset-0 bg-black/40 rounded-lg" aria-hidden="true" />
            )}
            <div className="relative z-10">
              {innerContent}
            </div>
          </div>
        ) : innerContent}
      </div>
    );
  };

  const subContentSection = (sub, subKey, inOverlay = false, parentItem = {}) => {
    const isActive = activeYear === subKey;
    const effectiveOffset = isExpanded ? 16 : header_offset;
    const widthStyle = getContentWidthStyle(content, inOverlay);

    return (
      <div
        key={subKey}
        ref={(el) => setSectionRef(subKey, el)}
        data-year={subKey}
        style={{
          scrollMarginTop: `${effectiveOffset + 8}px`,
          marginBottom: '32px',
          ...widthStyle,
        }}
        data-testid={`timeline-section-${subKey}`}
      >
        <div className="border-l-2 pl-4 ml-2" style={{ borderColor: isActive ? active_color : line_color }}>
          <div className="flex items-baseline gap-2 mb-2">
            <span
              className="font-semibold transition-colors duration-200"
              style={{ fontSize: `${Math.round((sub.heading_size || heading_size) * 0.9)}px`, color: isActive ? active_color : (sub.label_color || parentItem.label_color || label_color) }}
            >
              {sub.year}
            </span>
            {sub.heading && (
              <h4 className="font-medium" style={{ fontSize: `${Math.round((sub.heading_size || heading_size) * 0.8)}px`, color: sub.heading_color || heading_color || '#1e293b' }}>{sub.heading}</h4>
            )}
          </div>
          {sub.body && (
            <div
              className="prose prose-sm max-w-none"
              style={{ fontSize: `${Math.round((sub.body_size || body_size) * 0.9)}px`, ...(sub.body_color || body_color ? { color: sub.body_color || body_color } : {}) }}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(sub.body) }}
            />
          )}
        </div>
      </div>
    );
  };

  const mobileContentSection = (item, inOverlay = false) => {
    const widthStyle = getContentWidthStyle(content, inOverlay);
    const hlStyle = getHighlightStyle(item.highlight);
    const isHighlighted = !!hlStyle;
    const isImageBg = isHighlighted && item.highlight.bg_type === 'image' && item.highlight.bg_image;
    const textColor = isHighlighted ? item.highlight.text_color : undefined;

    const innerContent = (
      <>
        <div className="flex items-center gap-3 mb-3">
          {(() => {
            const hl = item.highlight;
            const shape = hl?.enabled ? (hl.marker_shape || 'circle') : 'circle';
            const ShapeIcon = shape !== 'circle' ? getMarkerShapeIcon(shape) : null;
            const customColor = item.marker_color || (hl?.enabled && hl.marker_color ? hl.marker_color : null);
            const markerBg = hl?.enabled && hl.marker_bg ? hl.marker_bg : null;
            const markerBorderColor = hl?.enabled && hl.marker_border_color ? hl.marker_border_color : null;
            const defaultColor = activeYear === item.year ? active_color : (timeline_marker_color || line_color);
            const fillColor = customColor || defaultColor;
            const hasWrapper = markerBg || markerBorderColor;

            const wrapperStyle = {};
            if (hasWrapper) {
              wrapperStyle.padding = '3px';
              wrapperStyle.borderRadius = '50%';
              wrapperStyle.display = 'flex';
              wrapperStyle.alignItems = 'center';
              wrapperStyle.justifyContent = 'center';
              if (markerBg) wrapperStyle.backgroundColor = markerBg;
              if (markerBorderColor) wrapperStyle.border = `2px solid ${markerBorderColor}`;
            }

            if (ShapeIcon) {
              const icon = (
                <ShapeIcon
                  className="w-3.5 h-3.5 shrink-0 transition-colors"
                  style={{ color: fillColor, fill: fillColor }}
                />
              );
              return hasWrapper ? <div style={wrapperStyle} className="shrink-0">{icon}</div> : icon;
            }
            const dot = (
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: fillColor }}
              />
            );
            return hasWrapper ? <div style={wrapperStyle} className="shrink-0">{dot}</div> : dot;
          })()}
          <span
            className="font-bold"
            style={{ fontSize: `${Math.round((item.heading_size || heading_size) * 0.9)}px`, color: textColor || (activeYear === item.year ? active_color : '#374151') }}
          >
            {item.year}
          </span>
        </div>
        {item.heading && (
          <h3 className="font-semibold mb-2" style={{ fontSize: `${item.heading_size || heading_size}px`, color: textColor || (item.heading_color || heading_color || '#1e293b') }}>{item.heading}</h3>
        )}
        {item.media?.type === 'video' && item.media?.src && !item.media_items?.length ? (
          <div className="mb-3 rounded-lg overflow-hidden">
            <video src={item.media.src} controls className="w-full rounded-lg" data-testid={`timeline-video-${item.year}`} />
          </div>
        ) : (() => {
          const mediaImages = getMediaItems(item);
          return mediaImages.length > 0 ? (
            <div className="mb-3 rounded-lg overflow-visible">
              <TimelineImageCarousel images={mediaImages} year={item.year} heading={item.heading} maxHeightClass="max-h-64" maxWidthClass="w-full" />
            </div>
          ) : null;
        })()}
        {(() => {
          const mobileHlTextLines = isHighlighted && item.highlight.text_lines ? item.highlight.text_lines : 0;
          const mobileIsTextExpanded = !!expandedTexts[item.year];
          const mobileShouldClamp = mobileHlTextLines > 0 && !mobileIsTextExpanded;
          return item.body ? (
            <div>
              <div
                className="prose prose-sm max-w-none"
                style={{
                  fontSize: `${Math.round((item.body_size || body_size) * 0.9)}px`,
                  ...(textColor ? { color: textColor } : (item.body_color || body_color) ? { color: item.body_color || body_color } : {}),
                  ...(mobileShouldClamp ? {
                    display: '-webkit-box',
                    WebkitLineClamp: mobileHlTextLines,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  } : {}),
                }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(item.body) }}
              />
              {mobileHlTextLines > 0 && (
                <button
                  type="button"
                  onClick={() => setExpandedTexts(prev => ({ ...prev, [item.year]: !prev[item.year] }))}
                  className="mt-2 text-sm font-medium transition-colors"
                  style={{ color: textColor || active_color }}
                  data-testid={`button-read-more-mobile-${item.year}`}
                >
                  {mobileIsTextExpanded ? 'Read less' : 'Read more'}
                </button>
              )}
            </div>
          ) : null;
        })()}
      </>
    );

    return (
      <div
        key={item.year}
        ref={(el) => setSectionRef(item.year, el)}
        data-year={item.year}
        className="scroll-mt-32"
        style={widthStyle || undefined}
        data-testid={`timeline-section-${item.year}`}
      >
        {isHighlighted ? (
          <div
            className="relative rounded-lg p-5 overflow-hidden"
            style={hlStyle}
            data-testid={`timeline-highlight-${item.year}`}
          >
            {isImageBg && (
              <div className="absolute inset-0 bg-black/40 rounded-lg" aria-hidden="true" />
            )}
            <div className="relative z-10">
              {innerContent}
            </div>
          </div>
        ) : innerContent}
      </div>
    );
  };

  const buildGradientCss = () => {
    const stops = gradient_stops && gradient_stops.length >= 2
      ? gradient_stops
      : [
          { color: '#ffffff', opacity: background_opacity, position: 0 },
          { color: '#ffffff', opacity: background_opacity, position: 100 }
        ];
    const angle = gradient_stops && gradient_stops.length >= 2 ? gradient_angle : 180;
    return `linear-gradient(${angle}deg, ${
      [...stops]
        .sort((a, b) => a.position - b.position)
        .map(s => {
          const r = parseInt(s.color.slice(1, 3), 16);
          const g = parseInt(s.color.slice(3, 5), 16);
          const b = parseInt(s.color.slice(5, 7), 16);
          return `rgba(${r},${g},${b},${s.opacity}) ${s.position}%`;
        })
        .join(', ')
    })`;
  };

  const buildRailGradientCss = () => {
    const stops = rail_gradient_stops && rail_gradient_stops.length >= 2
      ? rail_gradient_stops
      : [
          { color: '#000000', opacity: 0, position: 0 },
          { color: '#000000', opacity: 0.4, position: 100 }
        ];
    const angle = rail_gradient_stops && rail_gradient_stops.length >= 2 ? rail_gradient_angle : 180;
    return `linear-gradient(${angle}deg, ${
      [...stops]
        .sort((a, b) => a.position - b.position)
        .map(s => {
          const r = parseInt(s.color.slice(1, 3), 16);
          const g = parseInt(s.color.slice(3, 5), 16);
          const b = parseInt(s.color.slice(5, 7), 16);
          return `rgba(${r},${g},${b},${s.opacity}) ${s.position}%`;
        })
        .join(', ')
    })`;
  };

  const renderBgLayer = (bgType, bgProps, baseStyle, testId) => {
    if (bgType === 'solid') {
      return (
        <div
          className="pointer-events-none"
          style={{ ...baseStyle, zIndex: 0, backgroundColor: bgProps.color || '#1e3a5f' }}
          aria-hidden="true"
          data-testid={testId}
        />
      );
    }
    if (bgType === 'gradient') {
      return (
        <div
          className="pointer-events-none"
          style={{
            ...baseStyle,
            zIndex: 0,
            background: `linear-gradient(${bgProps.gradientAngle}deg, ${bgProps.gradientFrom || '#1e3a5f'}, ${bgProps.gradientTo || '#4a90d9'})`,
          }}
          aria-hidden="true"
          data-testid={testId}
        />
      );
    }
    if (bgType === 'image' && bgProps.image) {
      return (
        <>
          <div
            className="pointer-events-none"
            style={{
              ...baseStyle,
              zIndex: 0,
              backgroundImage: `url(${bgProps.image})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
            }}
            aria-hidden="true"
            data-testid={testId}
          />
          <div
            className="pointer-events-none"
            style={{ ...baseStyle, zIndex: 1, background: bgProps.gradientCss }}
            aria-hidden="true"
          />
        </>
      );
    }
    return null;
  };

  const contentBgProps = {
    color: background_color,
    gradientFrom: background_gradient_from,
    gradientTo: background_gradient_to,
    gradientAngle: background_gradient_angle,
    image: background_image,
    gradientCss: buildGradientCss(),
  };

  const railBgProps = {
    color: rail_background_color,
    gradientFrom: rail_background_gradient_from,
    gradientTo: rail_background_gradient_to,
    gradientAngle: rail_background_gradient_angle,
    image: rail_background_image,
    gradientCss: buildRailGradientCss(),
  };

  const maxSubOffX = Math.max(0, ...items.flatMap(i => (i.sub_items || []).map(s => Math.abs((typeof s.offset_x === 'number' ? s.offset_x : sub_offset_x) + subDotCorrection))));

  const desktopTimeline = (inOverlay) => {
    const stickyTop = inOverlay ? 0 : (header_offset + 16);
    const maxH = inOverlay ? 'calc(95vh - 72px)' : `calc(100vh - ${header_offset + 48}px)`;
    const isUnified = background_mode === 'unified';
    const contentBgLeft = isUnified ? 0 : bgLeft;
    const bgFixedBase = { position: 'fixed', top: 0, left: `${contentBgLeft}px`, right: 0, bottom: 0 };
    const railBgBase = { position: 'fixed', top: 0, left: 0, width: `${bgLeft}px`, bottom: 0 };
    return (
      <div className="flex gap-8 lg:gap-12 w-full">
        <div
          ref={railRef}
          data-timeline-rail
          className="shrink-0 w-28 lg:w-36 self-start"
          style={inOverlay ? {
            position: 'sticky',
            top: 0,
            maxHeight: maxH,
            overflowY: 'auto',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            zIndex: 1,
          } : {
            position: 'sticky',
            top: `${stickyTop}px`,
            maxHeight: maxH,
            overflowY: 'auto',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            zIndex: 1,
          }}
        >
          <style>{`[data-timeline-rail]::-webkit-scrollbar { display: none; }`}</style>
          <nav
            ref={navRef}
            className={`relative flex flex-col ${isLeftLabel ? 'items-end' : 'items-center'}`}
            style={{ paddingTop: `${nav_top_offset}px`, paddingBottom: `${nav_bottom_offset}px`, paddingLeft: `${maxSubOffX + 8}px`, paddingRight: `${maxSubOffX + 8}px`, minHeight: inOverlay ? 'calc(95vh - 72px)' : '100%' }}
            role="tablist"
            aria-label="Timeline years"
          >
            {navLinePath && (
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{ zIndex: 1 }}
                aria-hidden="true"
              >
                <path
                  d={navLinePath}
                  fill="none"
                  stroke={line_color}
                  strokeWidth={line_weight}
                  {...(line_dash === 'dashed' ? { strokeDasharray: '8 4' } : line_dash === 'dotted' ? { strokeDasharray: '2 4', strokeLinecap: 'round' } : {})}
                />
              </svg>
            )}
            {items.map((item, idx) => {
              const subs = item.sub_items || [];
              return (
                <div key={item.year} className="flex flex-col" style={{ marginBottom: idx < items.length - 1 ? '24px' : 0 }}>
                  {markerNav(idx, item)}
                  {subs.length > 0 && subs.map((sub, sIdx) => {
                    const subKey = `${item.year}-sub${sIdx}-${sub.year}`;
                    const isSubActive = activeYear === subKey;
                    const subLabelSide = sub.label_side || (isLeftLabel ? 'left' : 'below');
                    const subOffX = typeof sub.offset_x === 'number' ? sub.offset_x : sub_offset_x;
                    const subOffY = typeof sub.offset_y === 'number' ? sub.offset_y : sub_offset_y;
                    const subFontSize = sub.label_size || Math.round(label_size * 0.85);
                    const subLabelStyle = {
                      fontSize: `${subFontSize}px`,
                      fontWeight: isSubActive ? 700 : 500,
                      color: isSubActive ? active_color : (sub.label_color || item.label_color || label_color)
                    };
                    return (
                      <button
                        key={subKey}
                        onClick={() => scrollToSection(subKey)}
                        className="relative z-10 flex flex-col items-center group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                        style={{ marginTop: '16px', transform: `translateX(${subOffX + subDotCorrection}px) translateY(${subOffY}px)` }}
                        data-testid={`timeline-marker-sub-${subKey}`}
                        data-sub-marker
                      >
                        <div className="flex items-center w-full">
                          <div className="flex-1 min-w-0 flex justify-end">
                            {subLabelSide === 'left' && (
                              <span className="mr-2 whitespace-nowrap transition-colors duration-200" style={subLabelStyle}>{sub.year}</span>
                            )}
                          </div>
                          {renderMarkerDot(sub, isSubActive, Math.round(marker_size * 0.7), subKey)}
                          <div className="flex-1 min-w-0 flex justify-start">
                            {subLabelSide === 'right' && (
                              <span className="ml-2 whitespace-nowrap transition-colors duration-200" style={subLabelStyle}>{sub.year}</span>
                            )}
                          </div>
                        </div>
                        {subLabelSide === 'below' && (
                          <span className="mt-1 whitespace-nowrap transition-colors duration-200" style={subLabelStyle}>{sub.year}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </div>
        <div ref={contentPanelRef} className="flex-1 min-w-0 relative" style={inOverlay ? { paddingTop: '24px', paddingBottom: '24px' } : undefined}>
          {!inOverlay && hasContentBg && renderBgLayer(effectiveBgType, contentBgProps, bgFixedBase, 'timeline-background')}
          {!inOverlay && !isUnified && hasRailBg && renderBgLayer(effectiveRailBgType, railBgProps, railBgBase, 'timeline-rail-background')}
          <div style={{ position: 'relative', zIndex: 2, padding: hasBg ? '0 16px' : undefined, width: '100%' }}>
            {items.flatMap((item, idx) => {
              const sections = [contentSection(item, idx, inOverlay)];
              (item.sub_items || []).forEach((sub, sIdx) => {
                const subKey = `${item.year}-sub${sIdx}-${sub.year}`;
                sections.push(subContentSection(sub, subKey, inOverlay, item));
              });
              return sections;
            })}
          </div>
        </div>
      </div>
    );
  };

  /* ── Expanded overlay ── */
  const hasBg = hasContentBg || hasRailBg;
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
            className="relative bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden"
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
              ref={(el) => { scrollContainerRef.current = el; overlayScrollRef.current = el; }}
              className="flex-1 overflow-y-auto px-8"
            >
              {hasBg && overlayRect && (() => {
                const clipPath = `inset(0 0 0 0 round 0 0 0.75rem 0.75rem)`;
                const overlayBase = {
                  position: 'fixed',
                  top: `${overlayRect.top}px`,
                  left: `${overlayRect.left}px`,
                  width: `${overlayRect.width}px`,
                  height: `${overlayRect.height}px`,
                  clipPath,
                };
                return (
                  <>
                    {hasContentBg && renderBgLayer(effectiveBgType, contentBgProps, overlayBase, 'timeline-overlay-background')}
                  </>
                );
              })()}
              <div style={{ position: 'relative', zIndex: 2, width: '100%' }}>
                {isMobile ? (
                  <div className="py-6">
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
                      {items.flatMap((item) => {
                        const sections = [mobileContentSection(item, true)];
                        (item.sub_items || []).forEach((sub, sIdx) => {
                          const subKey = `${item.year}-sub${sIdx}-${sub.year}`;
                          sections.push(subContentSection(sub, subKey, true, item));
                        });
                        return sections;
                      })}
                    </div>
                  </div>
                ) : (
                  desktopTimeline(true)
                )}
              </div>
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
          {items.flatMap((item) => {
            const sections = [mobileContentSection(item)];
            (item.sub_items || []).forEach((sub, sIdx) => {
              const subKey = `${item.year}-sub${sIdx}-${sub.year}`;
              sections.push(subContentSection(sub, subKey, false, item));
            });
            return sections;
          })}
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
  const [isBgUploading, setIsBgUploading] = useState(false);
  const [isRailBgUploading, setIsRailBgUploading] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

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

  const getItemMediaItems = (item) => {
    if (item.media_items && item.media_items.length > 0) return item.media_items;
    if (item.media && item.media.src) return [{ src: item.media.src, alt: item.media.alt || '' }];
    return [];
  };

  const updateItemMediaItems = (index, newMediaItems) => {
    const newItems = [...items];
    newItems[index] = {
      ...newItems[index],
      media_items: newMediaItems,
      media: newMediaItems.length > 0
        ? { type: 'image', src: newMediaItems[0].src, alt: newMediaItems[0].alt || '' }
        : { type: 'image', src: '', alt: '' }
    };
    updateContent('items', newItems);
  };

  const removeMediaItem = (itemIndex, mediaIndex) => {
    const current = getItemMediaItems(items[itemIndex]);
    const updated = current.filter((_, i) => i !== mediaIndex);
    updateItemMediaItems(itemIndex, updated);
  };

  const moveMediaItem = (itemIndex, fromIdx, toIdx) => {
    const current = [...getItemMediaItems(items[itemIndex])];
    if (toIdx < 0 || toIdx >= current.length) return;
    const [moved] = current.splice(fromIdx, 1);
    current.splice(toIdx, 0, moved);
    updateItemMediaItems(itemIndex, current);
  };

  const updateItemHighlight = (index, key, value) => {
    const newItems = [...items];
    const currentHighlight = newItems[index].highlight || {};
    newItems[index] = {
      ...newItems[index],
      highlight: { ...currentHighlight, [key]: value }
    };
    updateContent('items', newItems);
  };

  const [isHighlightBgUploading, setIsHighlightBgUploading] = useState({});
  const handleHighlightBgUpload = async (index, file) => {
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
    setIsHighlightBgUploading(prev => ({ ...prev, [index]: true }));
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateItemHighlight(index, 'bg_image', response.file_url);
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsHighlightBgUploading(prev => ({ ...prev, [index]: false }));
    }
  };

  const addItem = () => {
    const nextYear = items.length > 0
      ? String(Math.max(...items.map(i => parseInt(i.year) || 2000)) + 1)
      : String(new Date().getFullYear());
    const newItems = [...items, {
      year: nextYear,
      heading: '',
      body: '',
      media: { type: 'image', src: '', alt: '' },
      media_items: []
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

  const addSubItem = (parentIndex) => {
    const parent = items[parentIndex];
    const subs = parent.sub_items || [];
    const nextLabel = `${parent.year || '????'}.${subs.length + 1}`;
    const newSubs = [...subs, { year: nextLabel, heading: '', body: '', media_items: [] }];
    updateItem(parentIndex, 'sub_items', newSubs);
  };

  const updateSubItem = (parentIndex, subIndex, key, value) => {
    const subs = [...(items[parentIndex].sub_items || [])];
    subs[subIndex] = { ...subs[subIndex], [key]: value };
    updateItem(parentIndex, 'sub_items', subs);
  };

  const removeSubItem = (parentIndex, subIndex) => {
    const subs = (items[parentIndex].sub_items || []).filter((_, i) => i !== subIndex);
    updateItem(parentIndex, 'sub_items', subs);
  };

  const moveSubItem = (parentIndex, fromIndex, toIndex) => {
    const subs = [...(items[parentIndex].sub_items || [])];
    if (toIndex < 0 || toIndex >= subs.length) return;
    const [moved] = subs.splice(fromIndex, 1);
    subs.splice(toIndex, 0, moved);
    updateItem(parentIndex, 'sub_items', subs);
  };

  const handleBgUpload = async (file) => {
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
    setIsBgUploading(true);
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      onChange({
        ...element,
        content: {
          ...(element.content || {}),
          background_type: 'image',
          background_image: response.file_url,
          gradient_stops: [
            { color: '#000000', opacity: 0, position: 0 },
            { color: '#000000', opacity: 0.4, position: 100 }
          ],
          gradient_angle: 180
        }
      });
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsBgUploading(false);
    }
  };

  const gradientStops = content.gradient_stops || [
    { color: '#000000', opacity: 0, position: 0 },
    { color: '#000000', opacity: 0.4, position: 100 }
  ];
  const gradientAngle = content.gradient_angle ?? 180;

  const updateGradientStop = (idx, key, value) => {
    const newStops = [...gradientStops];
    newStops[idx] = { ...newStops[idx], [key]: value };
    updateContent('gradient_stops', newStops);
  };

  const addGradientStop = () => {
    const lastPos = gradientStops.length > 0 ? gradientStops[gradientStops.length - 1].position : 0;
    const newPos = Math.min(100, lastPos + 10);
    updateContent('gradient_stops', [...gradientStops, { color: '#000000', opacity: 0.3, position: newPos }]);
  };

  const removeGradientStop = (idx) => {
    if (gradientStops.length <= 2) return;
    updateContent('gradient_stops', gradientStops.filter((_, i) => i !== idx));
  };

  const railGradientStops = content.rail_gradient_stops || [
    { color: '#000000', opacity: 0, position: 0 },
    { color: '#000000', opacity: 0.4, position: 100 }
  ];
  const railGradientAngle = content.rail_gradient_angle ?? 180;

  const updateRailGradientStop = (idx, key, value) => {
    const newStops = [...railGradientStops];
    newStops[idx] = { ...newStops[idx], [key]: value };
    updateContent('rail_gradient_stops', newStops);
  };

  const addRailGradientStop = () => {
    const lastPos = railGradientStops.length > 0 ? railGradientStops[railGradientStops.length - 1].position : 0;
    const newPos = Math.min(100, lastPos + 10);
    updateContent('rail_gradient_stops', [...railGradientStops, { color: '#000000', opacity: 0.3, position: newPos }]);
  };

  const removeRailGradientStop = (idx) => {
    if (railGradientStops.length <= 2) return;
    updateContent('rail_gradient_stops', railGradientStops.filter((_, i) => i !== idx));
  };

  const handleRailBgUpload = async (file) => {
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
    setIsRailBgUploading(true);
    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      onChange({
        ...element,
        content: {
          ...(element.content || {}),
          rail_background_type: 'image',
          rail_background_image: response.file_url,
          rail_gradient_stops: [
            { color: '#000000', opacity: 0, position: 0 },
            { color: '#000000', opacity: 0.4, position: 100 }
          ],
          rail_gradient_angle: 180
        }
      });
    } catch (error) {
      alert('Failed to upload image: ' + error.message);
    } finally {
      setIsRailBgUploading(false);
    }
  };

  const bgMode = content.background_mode || 'unified';
  const activeBgType = content.background_type || (content.background_image ? 'image' : 'none');
  const activeRailBgType = content.rail_background_type || (content.rail_background_image ? 'image' : 'none');

  const renderBgTypeSelector = (currentType, prefix, onTypeChange) => (
    <div className="flex gap-1">
      {['none', 'solid', 'gradient', 'image'].map(t => (
        <button
          key={t}
          type="button"
          onClick={() => onTypeChange(t)}
          className={`px-3 py-1 text-xs rounded-md border transition-colors ${
            currentType === t
              ? 'bg-slate-800 text-white border-slate-800'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
          }`}
          data-testid={`button-${prefix}-bg-type-${t}`}
        >
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );

  const renderSolidControls = (colorKey, colorValue, prefix) => (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-slate-500 shrink-0">Colour</Label>
      <input
        type="color"
        value={colorValue || '#1e3a5f'}
        onChange={(e) => updateContent(colorKey, e.target.value)}
        className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
        data-testid={`input-${prefix}-bg-color`}
      />
      <Input
        value={colorValue || '#1e3a5f'}
        onChange={(e) => updateContent(colorKey, e.target.value)}
        className="w-24 text-xs"
      />
    </div>
  );

  const renderGradientControls = (fromKey, toKey, angleKey, fromVal, toVal, angleVal, prefix) => (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-xs text-slate-500 shrink-0">From</Label>
        <input
          type="color"
          value={fromVal || '#1e3a5f'}
          onChange={(e) => updateContent(fromKey, e.target.value)}
          className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
          data-testid={`input-${prefix}-bg-gradient-from`}
        />
        <Label className="text-xs text-slate-500 shrink-0">To</Label>
        <input
          type="color"
          value={toVal || '#4a90d9'}
          onChange={(e) => updateContent(toKey, e.target.value)}
          className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
          data-testid={`input-${prefix}-bg-gradient-to`}
        />
      </div>
      <div className="flex items-center gap-2">
        <Label className="text-xs text-slate-500 shrink-0 w-10">Angle</Label>
        <input
          type="range"
          min="0"
          max="360"
          step="1"
          value={angleVal ?? 135}
          onChange={(e) => updateContent(angleKey, parseInt(e.target.value))}
          className="flex-1"
          data-testid={`input-${prefix}-bg-gradient-angle`}
        />
        <span className="text-xs text-slate-500 w-8 text-right">{angleVal ?? 135}°</span>
      </div>
      <div
        className="h-6 rounded-md border border-slate-200"
        style={{
          background: `linear-gradient(${angleVal ?? 135}deg, ${fromVal || '#1e3a5f'}, ${toVal || '#4a90d9'})`
        }}
        data-testid={`${prefix}-bg-gradient-preview`}
      />
    </div>
  );

  const renderImageOverlayControls = (stops, angle, updateStop, addStop, removeStop, prefix) => (
    <div className="space-y-3 border border-slate-100 rounded-lg p-3 bg-slate-50">
      <Label className="text-sm font-medium text-slate-700">Gradient Overlay</Label>
      <p className="text-xs text-slate-400">Add a gradient over the background to improve text readability.</p>

      <div className="flex items-center gap-3">
        <Label className="text-xs text-slate-600 shrink-0">Angle</Label>
        <input
          type="range" min="0" max="360" step="1"
          value={angle}
          onChange={(e) => updateContent(prefix === 'rail' ? 'rail_gradient_angle' : 'gradient_angle', parseInt(e.target.value))}
          className="flex-1"
          data-testid={`input-${prefix}-gradient-angle`}
        />
        <Input
          type="number" min="0" max="360"
          value={angle}
          onChange={(e) => updateContent(prefix === 'rail' ? 'rail_gradient_angle' : 'gradient_angle', parseInt(e.target.value) || 0)}
          className="w-16 text-xs"
        />
        <span className="text-xs text-slate-400">°</span>
      </div>

      <div
        className="h-8 rounded-md border border-slate-200"
        style={{
          background: `linear-gradient(${angle}deg, ${
            [...stops].sort((a, b) => a.position - b.position)
              .map(s => {
                const r = parseInt(s.color.slice(1, 3), 16);
                const g = parseInt(s.color.slice(3, 5), 16);
                const b = parseInt(s.color.slice(5, 7), 16);
                return `rgba(${r},${g},${b},${s.opacity}) ${s.position}%`;
              }).join(', ')
          })`
        }}
        data-testid={`${prefix}-gradient-preview`}
      />

      <div className="space-y-2">
        {stops.map((stop, idx) => (
          <div key={idx} className="flex items-center gap-2 bg-white rounded-md p-2 border border-slate-100">
            <input
              type="color"
              value={stop.color}
              onChange={(e) => updateStop(idx, 'color', e.target.value)}
              className="w-7 h-7 rounded border border-slate-200 cursor-pointer shrink-0"
            />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <Label className="text-[10px] text-slate-400 w-10 shrink-0">Opacity</Label>
                <input type="range" min="0" max="1" step="0.05" value={stop.opacity}
                  onChange={(e) => updateStop(idx, 'opacity', parseFloat(e.target.value))} className="flex-1" />
                <span className="text-[10px] text-slate-500 w-8 text-right">{Math.round(stop.opacity * 100)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-[10px] text-slate-400 w-10 shrink-0">Position</Label>
                <input type="range" min="0" max="100" step="1" value={stop.position}
                  onChange={(e) => updateStop(idx, 'position', parseInt(e.target.value))} className="flex-1" />
                <span className="text-[10px] text-slate-500 w-8 text-right">{stop.position}%</span>
              </div>
            </div>
            <button
              onClick={() => removeStop(idx)}
              disabled={stops.length <= 2}
              className="p-1 rounded text-slate-400 hover:text-red-500 disabled:opacity-30 shrink-0"
              title="Remove stop" type="button"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" onClick={addStop} className="w-full" data-testid={`button-${prefix}-add-gradient-stop`}>
        <Plus className="w-3 h-3 mr-1" /> Add Stop
      </Button>
    </div>
  );

  const renderImageControls = (imageVal, typeKey, imageKey, stopsKey, angleKey, uploading, onUpload, stops, angle, updateStop, addStop, removeStop, prefix) => (
    <>
      {imageVal ? (
        <div className="space-y-3">
          <div className="relative rounded-lg overflow-hidden border border-slate-200 h-32">
            <img src={imageVal} alt="Background preview" className="w-full h-full object-cover" onError={(e) => { e.target.style.display = 'none'; }} />
            <button
              onClick={() => {
                onChange({
                  ...element,
                  content: {
                    ...(element.content || {}),
                    [typeKey]: 'none',
                    [imageKey]: undefined,
                    [stopsKey]: undefined,
                    [angleKey]: undefined,
                  }
                });
              }}
              className="absolute top-2 right-2 p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
              title="Remove background" type="button"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {renderImageOverlayControls(stops, angle, updateStop, addStop, removeStop, prefix)}
        </div>
      ) : (
        <label className="cursor-pointer block" data-testid={`input-${prefix}-bg-upload`}>
          <div className={`flex flex-col items-center justify-center gap-2 py-6 border-2 border-dashed border-slate-200 rounded-lg transition-colors ${
            uploading ? 'bg-slate-100 cursor-not-allowed' : 'hover:border-blue-400 hover:bg-blue-50/50'
          }`}>
            {uploading ? (
              <span className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
            ) : (
              <>
                <Upload className="w-6 h-6 text-slate-400" />
                <span className="text-sm text-slate-500">Click to upload background image</span>
                <span className="text-xs text-slate-400">JPEG, PNG, GIF, WebP — max 10MB</span>
              </>
            )}
          </div>
          <input
            type="file" accept="image/*"
            onChange={(e) => { const file = e.target.files?.[0]; if (file) onUpload(file); e.target.value = ''; }}
            className="hidden" disabled={uploading}
          />
        </label>
      )}
    </>
  );

  const handleContentBgTypeChange = (t) => {
    if (t === activeBgType) return;
    const updates = { background_type: t };
    if (activeBgType === 'image') { updates.background_image = undefined; updates.gradient_stops = undefined; updates.gradient_angle = undefined; }
    else if (activeBgType === 'solid') { updates.background_color = undefined; }
    else if (activeBgType === 'gradient') { updates.background_gradient_from = undefined; updates.background_gradient_to = undefined; updates.background_gradient_angle = undefined; }
    onChange({ ...element, content: { ...(element.content || {}), ...updates } });
  };

  const handleRailBgTypeChange = (t) => {
    if (t === activeRailBgType) return;
    const updates = { rail_background_type: t };
    if (activeRailBgType === 'image') { updates.rail_background_image = undefined; updates.rail_gradient_stops = undefined; updates.rail_gradient_angle = undefined; }
    else if (activeRailBgType === 'solid') { updates.rail_background_color = undefined; }
    else if (activeRailBgType === 'gradient') { updates.rail_background_gradient_from = undefined; updates.rail_background_gradient_to = undefined; updates.rail_background_gradient_angle = undefined; }
    onChange({ ...element, content: { ...(element.content || {}), ...updates } });
  };

  const handleImageUpload = async (index, file) => {
    if (!file) return;

    const currentMediaItems = getItemMediaItems(items[index]);
    if (currentMediaItems.length >= 5) {
      alert('Maximum 5 images per timeline item');
      return;
    }

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
      const updated = [...currentMediaItems, { src: response.file_url, alt: '' }];
      updateItemMediaItems(index, updated);
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
          <Label className="text-sm font-medium text-slate-700">Line Style</Label>
          <div className="flex items-center gap-2 mt-1">
            <Button
              size="sm"
              variant={(!content.line_style || content.line_style === 'straight') ? 'default' : 'outline'}
              onClick={() => updateContent('line_style', 'straight')}
              data-testid="button-line-style-straight"
            >Straight</Button>
            <Button
              size="sm"
              variant={content.line_style === 'organic' ? 'default' : 'outline'}
              onClick={() => updateContent('line_style', 'organic')}
              data-testid="button-line-style-organic"
            >Organic</Button>
          </div>
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Line Weight</Label>
          <Input
            type="number"
            min={1}
            max={6}
            step={0.5}
            value={content.line_weight ?? 2}
            onChange={(e) => updateContent('line_weight', parseFloat(e.target.value) || 2)}
            className="mt-1"
            data-testid="input-line-weight"
          />
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Line Dash</Label>
          <div className="flex items-center gap-2 mt-1">
            <Button
              size="sm"
              variant={(!content.line_dash || content.line_dash === 'solid') ? 'default' : 'outline'}
              onClick={() => updateContent('line_dash', 'solid')}
              data-testid="button-line-dash-solid"
            >Solid</Button>
            <Button
              size="sm"
              variant={content.line_dash === 'dashed' ? 'default' : 'outline'}
              onClick={() => updateContent('line_dash', 'dashed')}
              data-testid="button-line-dash-dashed"
            >Dashed</Button>
            <Button
              size="sm"
              variant={content.line_dash === 'dotted' ? 'default' : 'outline'}
              onClick={() => updateContent('line_dash', 'dotted')}
              data-testid="button-line-dash-dotted"
            >Dotted</Button>
          </div>
        </div>
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
        <div>
          <Label className="text-sm font-medium text-slate-700">Marker Colour</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={content.marker_color || content.line_color || '#d1d5db'}
              onChange={(e) => updateContent('marker_color', e.target.value)}
              className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              value={content.marker_color || ''}
              onChange={(e) => updateContent('marker_color', e.target.value)}
              placeholder="Uses line colour"
              className="flex-1"
            />
            {content.marker_color && (
              <Button size="sm" variant="ghost" onClick={() => updateContent('marker_color', '')} data-testid="button-clear-marker-color">
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">Default dot colour (uses line colour if empty)</p>
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Label Size</Label>
          <Input
            type="number"
            min={8}
            max={32}
            step={1}
            value={content.label_size ?? 14}
            onChange={(e) => updateContent('label_size', parseInt(e.target.value) || 14)}
            className="mt-1"
            data-testid="input-label-size"
          />
          <p className="text-xs text-slate-400 mt-1">Nav marker labels (sub-markers use 85%)</p>
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Label Colour</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={content.label_color || '#9ca3af'}
              onChange={(e) => updateContent('label_color', e.target.value)}
              className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              value={content.label_color || ''}
              onChange={(e) => updateContent('label_color', e.target.value)}
              placeholder="#9ca3af"
              className="flex-1"
              data-testid="input-label-color"
            />
            {content.label_color && content.label_color !== '#9ca3af' && (
              <Button size="sm" variant="ghost" onClick={() => updateContent('label_color', '')} data-testid="button-clear-label-color">
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">Non-selected label colour (default grey)</p>
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Content Layout</Label>
          <div className="flex gap-1 mt-1">
            {[
              { value: 'stacked', label: 'Stacked' },
              { value: 'side-by-side', label: 'Side by Side' },
              { value: 'inline', label: 'Inline' },
            ].map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => updateContent('content_layout', opt.value)}
                className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                  (content.content_layout || 'stacked') === opt.value
                    ? 'bg-slate-700 text-white border-slate-700'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                }`}
                data-testid={`button-content-layout-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {(content.content_layout || 'stacked') === 'stacked' ? 'Header → images → text' :
             (content.content_layout) === 'side-by-side' ? 'Header above, images & text side by side' :
             'Header, images & text all side by side'}
          </p>
          {(content.content_layout || 'stacked') !== 'stacked' && (
            <div className="mt-2">
              <Label className="text-xs text-slate-500">Media Side</Label>
              <div className="flex gap-1 mt-1">
                {[
                  { value: 'left', label: 'Left' },
                  { value: 'right', label: 'Right' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => updateContent('content_media_side', opt.value)}
                    className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                      (content.content_media_side || 'left') === opt.value
                        ? 'bg-slate-700 text-white border-slate-700'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                    }`}
                    data-testid={`button-media-side-${opt.value}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Heading Size</Label>
          <Input
            type="number"
            min={10}
            max={48}
            step={1}
            value={content.heading_size ?? 20}
            onChange={(e) => updateContent('heading_size', parseInt(e.target.value) || 20)}
            className="mt-1"
            data-testid="input-heading-size"
          />
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Heading Colour</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={content.heading_color || '#1e293b'}
              onChange={(e) => updateContent('heading_color', e.target.value)}
              className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              value={content.heading_color || ''}
              onChange={(e) => updateContent('heading_color', e.target.value)}
              placeholder="#1e293b"
              className="flex-1"
            />
            {content.heading_color && (
              <Button size="sm" variant="ghost" onClick={() => updateContent('heading_color', '')} data-testid="button-clear-heading-color">
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Body Size</Label>
          <Input
            type="number"
            min={10}
            max={32}
            step={1}
            value={content.body_size ?? 16}
            onChange={(e) => updateContent('body_size', parseInt(e.target.value) || 16)}
            className="mt-1"
            data-testid="input-body-size"
          />
        </div>
        <div>
          <Label className="text-sm font-medium text-slate-700">Body Colour</Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="color"
              value={content.body_color || '#374151'}
              onChange={(e) => updateContent('body_color', e.target.value)}
              className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
            />
            <Input
              value={content.body_color || ''}
              onChange={(e) => updateContent('body_color', e.target.value)}
              placeholder="Default"
              className="flex-1"
            />
            {content.body_color && (
              <Button size="sm" variant="ghost" onClick={() => updateContent('body_color', '')} data-testid="button-clear-body-color">
                <X className="w-3 h-3" />
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">Default label size in px (sub-markers use 85%)</p>
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

      <div>
        <Label className="text-sm font-medium text-slate-700">First Marker Offset (px)</Label>
        <Input
          type="number"
          value={content.nav_top_offset ?? 0}
          onChange={(e) => updateContent('nav_top_offset', Math.max(0, Math.min(200, parseInt(e.target.value) || 0)))}
          min="0"
          max="200"
          className="mt-1"
          data-testid="input-nav-top-offset"
        />
        <p className="text-xs text-slate-400 mt-1">Pushes the first marker down from the top of the navigation rail</p>
      </div>

      <div>
        <Label className="text-sm font-medium text-slate-700">Last Marker Trail (px)</Label>
        <Input
          type="number"
          value={content.nav_bottom_offset ?? 0}
          onChange={(e) => updateContent('nav_bottom_offset', Math.max(0, Math.min(200, parseInt(e.target.value) || 0)))}
          min="0"
          max="200"
          className="mt-1"
          data-testid="input-nav-bottom-offset"
        />
        <p className="text-xs text-slate-400 mt-1">Extends the line below the last marker</p>
      </div>

      <div>
        <Label className="text-sm font-medium text-slate-700">Label Position</Label>
        <div className="flex gap-1 mt-1">
          {[
            { value: 'below', label: 'Below' },
            { value: 'left', label: 'Left' },
          ].map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => updateContent('label_position', opt.value)}
              className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                (content.label_position || 'below') === opt.value
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
              }`}
              data-testid={`button-label-position-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-400 mt-1">Where the year label appears relative to the marker</p>
      </div>

      <div>
        <Label className="text-sm font-medium text-slate-700">Default Sub-Marker Offset</Label>
        <div className="flex gap-3 mt-1">
          <div className="flex-1">
            <Label className="text-[10px] text-slate-500">X (horizontal)</Label>
            <input
              type="number"
              value={content.sub_offset_x || 0}
              onChange={(e) => updateContent('sub_offset_x', parseInt(e.target.value) || 0)}
              className="w-full px-2 py-1 text-xs border border-slate-200 rounded-md"
              data-testid="input-sub-offset-x"
            />
          </div>
          <div className="flex-1">
            <Label className="text-[10px] text-slate-500">Y (vertical)</Label>
            <input
              type="number"
              value={content.sub_offset_y || 0}
              onChange={(e) => updateContent('sub_offset_y', parseInt(e.target.value) || 0)}
              className="w-full px-2 py-1 text-xs border border-slate-200 rounded-md"
              data-testid="input-sub-offset-y"
            />
          </div>
        </div>
        <p className="text-xs text-slate-400 mt-1">px from center line (X: +right −left, Y: +down −up)</p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium text-slate-700">Open in Popup View</Label>
          <p className="text-xs text-slate-400 mt-0.5">Automatically opens the timeline in the fullscreen popup when the page loads</p>
        </div>
        <input
          type="checkbox"
          checked={!!content.auto_expand}
          onChange={(e) => updateContent('auto_expand', e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          data-testid="checkbox-auto-expand"
        />
      </div>

      {/* Content Width */}
      <div className="space-y-3 border border-slate-200 rounded-lg p-3">
        <Label className="text-sm font-medium text-slate-700">Content Width</Label>
        <p className="text-xs text-slate-400">Controls the width of each year's content area as a percentage of the available space.</p>

        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-500 shrink-0">Inline</Label>
          <input
            type="range"
            min="25"
            max="100"
            step="1"
            value={content.content_width ?? 100}
            onChange={(e) => updateContent('content_width', parseInt(e.target.value))}
            className="flex-1"
            data-testid="input-content-width"
          />
          <span className="text-xs text-slate-500 w-10 text-right">{content.content_width ?? 100}%</span>
        </div>

        <div className="flex items-center gap-2">
          <Label className="text-xs text-slate-500 shrink-0">Modal</Label>
          <input
            type="range"
            min="25"
            max="100"
            step="1"
            value={content.content_width_modal ?? content.content_width ?? 100}
            onChange={(e) => updateContent('content_width_modal', parseInt(e.target.value))}
            className="flex-1"
            data-testid="input-content-width-modal"
          />
          <span className="text-xs text-slate-500 w-10 text-right">{content.content_width_modal ?? content.content_width ?? 100}%</span>
        </div>

        {((content.content_width ?? 100) < 100 || (content.content_width_modal ?? content.content_width ?? 100) < 100) && (
          <div>
            <Label className="text-xs text-slate-500 mb-1 block">Alignment</Label>
            <div className="flex gap-1">
              {[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Centre' },
                { value: 'right', label: 'Right' },
              ].map(a => (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => updateContent('content_align', a.value)}
                  className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                    (content.content_align || 'center') === a.value
                      ? 'bg-slate-800 text-white border-slate-800'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                  }`}
                  data-testid={`button-content-align-${a.value}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Background */}
      <div className="space-y-3 border border-slate-200 rounded-lg p-3">
        <Label className="text-sm font-medium text-slate-700">Background</Label>
        <p className="text-xs text-slate-400">Fixed background behind the timeline — stays still while content scrolls over it.</p>

        <div>
          <Label className="text-xs text-slate-500 mb-1 block">Layout</Label>
          <div className="flex gap-1">
            {['unified', 'split'].map(m => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  if (m === bgMode) return;
                  const updates = { background_mode: m };
                  if (m === 'unified') {
                    updates.rail_background_type = undefined;
                    updates.rail_background_color = undefined;
                    updates.rail_background_gradient_from = undefined;
                    updates.rail_background_gradient_to = undefined;
                    updates.rail_background_gradient_angle = undefined;
                    updates.rail_background_image = undefined;
                    updates.rail_gradient_stops = undefined;
                    updates.rail_gradient_angle = undefined;
                  }
                  onChange({ ...element, content: { ...(element.content || {}), ...updates } });
                }}
                className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                  bgMode === m
                    ? 'bg-slate-800 text-white border-slate-800'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                }`}
                data-testid={`button-timeline-bg-mode-${m}`}
              >
                {m === 'unified' ? 'Unified' : 'Split'}
              </button>
            ))}
          </div>
        </div>

        {bgMode === 'unified' ? (
          <div className="space-y-3">
            {renderBgTypeSelector(activeBgType, 'timeline', handleContentBgTypeChange)}
            {activeBgType === 'solid' && renderSolidControls('background_color', content.background_color, 'timeline')}
            {activeBgType === 'gradient' && renderGradientControls(
              'background_gradient_from', 'background_gradient_to', 'background_gradient_angle',
              content.background_gradient_from, content.background_gradient_to, content.background_gradient_angle, 'timeline'
            )}
            {activeBgType === 'image' && renderImageControls(
              content.background_image, 'background_type', 'background_image', 'gradient_stops', 'gradient_angle',
              isBgUploading, handleBgUpload, gradientStops, gradientAngle, updateGradientStop, addGradientStop, removeGradientStop, 'timeline'
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-3 border border-slate-100 rounded-lg p-3 bg-slate-50">
              <Label className="text-xs font-medium text-slate-600">Navigation Panel</Label>
              {renderBgTypeSelector(activeRailBgType, 'rail', handleRailBgTypeChange)}
              {activeRailBgType === 'solid' && renderSolidControls('rail_background_color', content.rail_background_color, 'rail')}
              {activeRailBgType === 'gradient' && renderGradientControls(
                'rail_background_gradient_from', 'rail_background_gradient_to', 'rail_background_gradient_angle',
                content.rail_background_gradient_from, content.rail_background_gradient_to, content.rail_background_gradient_angle, 'rail'
              )}
              {activeRailBgType === 'image' && renderImageControls(
                content.rail_background_image, 'rail_background_type', 'rail_background_image', 'rail_gradient_stops', 'rail_gradient_angle',
                isRailBgUploading, handleRailBgUpload, railGradientStops, railGradientAngle, updateRailGradientStop, addRailGradientStop, removeRailGradientStop, 'rail'
              )}
            </div>

            <div className="space-y-3 border border-slate-100 rounded-lg p-3 bg-slate-50">
              <Label className="text-xs font-medium text-slate-600">Content Panel</Label>
              {renderBgTypeSelector(activeBgType, 'content', handleContentBgTypeChange)}
              {activeBgType === 'solid' && renderSolidControls('background_color', content.background_color, 'content')}
              {activeBgType === 'gradient' && renderGradientControls(
                'background_gradient_from', 'background_gradient_to', 'background_gradient_angle',
                content.background_gradient_from, content.background_gradient_to, content.background_gradient_angle, 'content'
              )}
              {activeBgType === 'image' && renderImageControls(
                content.background_image, 'background_type', 'background_image', 'gradient_stops', 'gradient_angle',
                isBgUploading, handleBgUpload, gradientStops, gradientAngle, updateGradientStop, addGradientStop, removeGradientStop, 'content'
              )}
            </div>
          </div>
        )}
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
                draggable
                onDragStart={(e) => {
                  setDragIndex(index);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(index));
                  e.currentTarget.style.opacity = '0.5';
                }}
                onDragEnd={(e) => {
                  e.currentTarget.style.opacity = '1';
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragIndex !== null && dragIndex !== index) {
                    setDragOverIndex(index);
                  }
                }}
                onDragLeave={() => {
                  if (dragOverIndex === index) setDragOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null && dragIndex !== index) {
                    moveItem(dragIndex, index);
                  }
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                className={`border rounded-lg overflow-hidden bg-white transition-all ${
                  dragOverIndex === index && dragIndex !== index
                    ? 'border-blue-400 ring-2 ring-blue-200'
                    : 'border-slate-200'
                }`}
              >
                {/* Item header */}
                <div
                  className="flex items-center gap-2 px-3 py-2 bg-slate-50 cursor-pointer select-none"
                  onClick={() => setExpandedItem(isExpanded ? null : index)}
                >
                  <GripVertical className="w-4 h-4 text-slate-400 shrink-0 cursor-grab active:cursor-grabbing" />
                  <span className="font-mono font-semibold text-sm text-slate-700 shrink-0">
                    {item.year || '????'}
                  </span>
                  <span className="text-sm text-slate-500 truncate flex-1">
                    {item.heading || '(no heading)'}
                  </span>
                  {item.highlight?.enabled && (
                    <Star className="w-3.5 h-3.5 text-amber-500 shrink-0" fill="currentColor" />
                  )}
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
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-slate-600">Marker Colour <span className="text-slate-400">(overrides default)</span></Label>
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="color"
                            value={item.marker_color || content.marker_color || content.line_color || '#d1d5db'}
                            onChange={(e) => updateItem(index, 'marker_color', e.target.value)}
                            className="w-6 h-6 rounded border border-slate-200 cursor-pointer"
                            data-testid={`input-marker-color-picker-${index}`}
                          />
                          <Input
                            value={item.marker_color || ''}
                            onChange={(e) => updateItem(index, 'marker_color', e.target.value)}
                            placeholder="Default"
                            className="flex-1"
                            data-testid={`input-marker-color-${index}`}
                          />
                          {item.marker_color && (
                            <Button size="sm" variant="ghost" onClick={() => updateItem(index, 'marker_color', '')} data-testid={`button-clear-marker-color-${index}`}>
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs text-slate-600">Label Size <span className="text-slate-400">(px)</span></Label>
                        <div className="flex items-center gap-2 mt-1">
                          <Input
                            type="number"
                            min={8}
                            max={32}
                            step={1}
                            value={item.label_size || ''}
                            placeholder={String(content.label_size || 14)}
                            onChange={(e) => updateItem(index, 'label_size', e.target.value === '' ? undefined : parseInt(e.target.value) || undefined)}
                            className="flex-1"
                            data-testid={`input-label-size-${index}`}
                          />
                          {item.label_size && (
                            <Button size="sm" variant="ghost" onClick={() => updateItem(index, 'label_size', undefined)} data-testid={`button-clear-label-size-${index}`}>
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs text-slate-600">Label Colour <span className="text-slate-400">(overrides default)</span></Label>
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="color"
                            value={item.label_color || content.label_color || '#9ca3af'}
                            onChange={(e) => updateItem(index, 'label_color', e.target.value)}
                            className="w-6 h-6 rounded border border-slate-200 cursor-pointer"
                          />
                          <Input
                            value={item.label_color || ''}
                            onChange={(e) => updateItem(index, 'label_color', e.target.value)}
                            placeholder="Default"
                            className="flex-1"
                            data-testid={`input-label-color-${index}`}
                          />
                          {item.label_color && (
                            <Button size="sm" variant="ghost" onClick={() => updateItem(index, 'label_color', undefined)} data-testid={`button-clear-label-color-${index}`}>
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs text-slate-600">Content Layout</Label>
                        <div className="flex items-center gap-1 mt-1">
                          {[
                            { value: '', label: 'Default' },
                            { value: 'stacked', label: 'Stacked' },
                            { value: 'side-by-side', label: 'Side' },
                            { value: 'inline', label: 'Inline' },
                          ].map(opt => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => updateItem(index, 'content_layout', opt.value || undefined)}
                              className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                                (item.content_layout || '') === opt.value
                                  ? 'bg-slate-700 text-white border-slate-700'
                                  : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                              }`}
                              data-testid={`button-item-layout-${index}-${opt.value || 'default'}`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        {(item.content_layout === 'side-by-side' || item.content_layout === 'inline' || (!item.content_layout && (content.content_layout || 'stacked') !== 'stacked')) && (
                          <div className="flex gap-1 mt-1">
                            {[
                              { value: '', label: 'Def' },
                              { value: 'left', label: 'L' },
                              { value: 'right', label: 'R' },
                            ].map(opt => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => updateItem(index, 'content_media_side', opt.value || undefined)}
                                className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                                  (item.content_media_side || '') === opt.value
                                    ? 'bg-slate-700 text-white border-slate-700'
                                    : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                                }`}
                                data-testid={`button-item-media-side-${index}-${opt.value || 'default'}`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-slate-600">Heading Size <span className="text-slate-400">(px)</span></Label>
                        <div className="flex items-center gap-2 mt-1">
                          <Input
                            type="number"
                            min={10}
                            max={48}
                            step={1}
                            value={item.heading_size || ''}
                            placeholder={String(content.heading_size || 20)}
                            onChange={(e) => updateItem(index, 'heading_size', e.target.value === '' ? undefined : parseInt(e.target.value) || undefined)}
                            className="flex-1"
                            data-testid={`input-heading-size-${index}`}
                          />
                          {item.heading_size && (
                            <Button size="sm" variant="ghost" onClick={() => updateItem(index, 'heading_size', undefined)} data-testid={`button-clear-heading-size-${index}`}>
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs text-slate-600">Heading Colour</Label>
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="color"
                            value={item.heading_color || content.heading_color || '#1e293b'}
                            onChange={(e) => updateItem(index, 'heading_color', e.target.value)}
                            className="w-6 h-6 rounded border border-slate-200 cursor-pointer"
                          />
                          <Input
                            value={item.heading_color || ''}
                            onChange={(e) => updateItem(index, 'heading_color', e.target.value)}
                            placeholder="Default"
                            className="flex-1"
                            data-testid={`input-heading-color-${index}`}
                          />
                          {item.heading_color && (
                            <Button size="sm" variant="ghost" onClick={() => updateItem(index, 'heading_color', '')} data-testid={`button-clear-heading-color-${index}`}>
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-slate-600">Body Size <span className="text-slate-400">(px)</span></Label>
                        <div className="flex items-center gap-2 mt-1">
                          <Input
                            type="number"
                            min={10}
                            max={32}
                            step={1}
                            value={item.body_size || ''}
                            placeholder={String(content.body_size || 16)}
                            onChange={(e) => updateItem(index, 'body_size', e.target.value === '' ? undefined : parseInt(e.target.value) || undefined)}
                            className="flex-1"
                            data-testid={`input-body-size-${index}`}
                          />
                          {item.body_size && (
                            <Button size="sm" variant="ghost" onClick={() => updateItem(index, 'body_size', undefined)} data-testid={`button-clear-body-size-${index}`}>
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs text-slate-600">Body Colour</Label>
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="color"
                            value={item.body_color || content.body_color || '#374151'}
                            onChange={(e) => updateItem(index, 'body_color', e.target.value)}
                            className="w-6 h-6 rounded border border-slate-200 cursor-pointer"
                          />
                          <Input
                            value={item.body_color || ''}
                            onChange={(e) => updateItem(index, 'body_color', e.target.value)}
                            placeholder="Default"
                            className="flex-1"
                            data-testid={`input-body-color-${index}`}
                          />
                          {item.body_color && (
                            <Button size="sm" variant="ghost" onClick={() => updateItem(index, 'body_color', '')} data-testid={`button-clear-body-color-${index}`}>
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
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

                    {/* Media - Multiple Images */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <Label className="text-xs text-slate-600">Images ({getItemMediaItems(item).length}/5)</Label>
                      </div>
                      <div className="mt-1 space-y-2">
                        {getItemMediaItems(item).length > 0 && (
                          <div className="grid grid-cols-3 gap-2">
                            {getItemMediaItems(item).map((mediaImg, mIdx) => {
                              const totalImages = getItemMediaItems(item).length;
                              return (
                              <div key={mIdx} className="relative rounded-lg overflow-hidden border border-slate-200 group">
                                <img
                                  src={mediaImg.src}
                                  alt={mediaImg.alt || ''}
                                  className="w-full h-20 object-cover"
                                  onError={(e) => { e.target.style.display = 'none'; }}
                                />
                                <div className="absolute top-1 left-1 flex gap-0.5" style={{ visibility: totalImages > 1 ? 'visible' : 'hidden' }}>
                                  <button
                                    onClick={() => moveMediaItem(index, mIdx, mIdx - 1)}
                                    disabled={mIdx === 0}
                                    className="p-0.5 bg-black/50 hover:bg-black/70 text-white rounded transition-colors disabled:opacity-30"
                                    title="Move left"
                                    type="button"
                                    data-testid={`button-move-media-left-${index}-${mIdx}`}
                                  >
                                    <ChevronLeft className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={() => moveMediaItem(index, mIdx, mIdx + 1)}
                                    disabled={mIdx === totalImages - 1}
                                    className="p-0.5 bg-black/50 hover:bg-black/70 text-white rounded transition-colors disabled:opacity-30"
                                    title="Move right"
                                    type="button"
                                    data-testid={`button-move-media-right-${index}-${mIdx}`}
                                  >
                                    <ChevronRight className="w-3 h-3" />
                                  </button>
                                </div>
                                <button
                                  onClick={() => removeMediaItem(index, mIdx)}
                                  className="absolute top-1 right-1 p-1 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
                                  title="Remove image"
                                  type="button"
                                  data-testid={`button-remove-media-${index}-${mIdx}`}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                                <div className="flex border-t border-slate-200 bg-white">
                                  <input
                                    value={mediaImg.alt || ''}
                                    onChange={(e) => {
                                      const current = getItemMediaItems(items[index]);
                                      const updated = [...current];
                                      updated[mIdx] = { ...updated[mIdx], alt: e.target.value };
                                      updateItemMediaItems(index, updated);
                                    }}
                                    placeholder="Alt text"
                                    className="flex-1 min-w-0 text-[10px] px-1.5 py-0.5 bg-transparent"
                                    data-testid={`input-media-alt-${index}-${mIdx}`}
                                  />
                                </div>
                                <div className="flex border-t border-slate-200 bg-white">
                                  {[
                                    { value: 'original', label: 'Orig' },
                                    { value: 'square', label: 'Sq' },
                                    { value: 'circle', label: 'Circ' },
                                  ].map(opt => (
                                    <button
                                      key={opt.value}
                                      type="button"
                                      onClick={() => {
                                        const current = getItemMediaItems(items[index]);
                                        const updated = [...current];
                                        updated[mIdx] = { ...updated[mIdx], display: opt.value };
                                        updateItemMediaItems(index, updated);
                                      }}
                                      className={`flex-1 text-[9px] py-0.5 transition-colors ${
                                        (mediaImg.display || 'original') === opt.value
                                          ? 'bg-slate-700 text-white'
                                          : 'text-slate-500 hover:bg-slate-100'
                                      }`}
                                      data-testid={`button-media-display-${index}-${mIdx}-${opt.value}`}
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              );
                            })}
                          </div>
                        )}
                        {getItemMediaItems(item).length < 5 && (
                          <div className="flex gap-2">
                            <label className="cursor-pointer flex-1">
                              <div className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border-2 border-dashed transition-colors ${
                                isUploading[index]
                                  ? 'border-slate-200 bg-slate-100 cursor-not-allowed'
                                  : 'border-slate-300 hover:border-blue-400 hover:bg-blue-50/50'
                              }`}>
                                {isUploading[index] ? (
                                  <span className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full" />
                                ) : (
                                  <>
                                    <Upload className="w-4 h-4 text-slate-400" />
                                    <span className="text-xs text-slate-500">Add Image</span>
                                  </>
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
                                data-testid={`input-upload-media-${index}`}
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Sub-Years */}
                    <div className="border-t border-slate-200 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <Label className="text-xs text-slate-600 font-medium">Sub-Years ({(item.sub_items || []).length})</Label>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); addSubItem(index); }}
                          data-testid={`button-add-sub-item-${index}`}
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add
                        </Button>
                      </div>
                      {(item.sub_items || []).length > 0 && (
                        <div className="space-y-2 pl-3 border-l-2 border-slate-200">
                          {(item.sub_items || []).map((sub, sIdx) => (
                            <div key={sIdx} className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                              <div className="flex items-center gap-1.5 px-2 py-1.5 bg-slate-50">
                                <span className="font-mono text-xs text-slate-600 shrink-0">{sub.year || '????'}</span>
                                <span className="text-xs text-slate-400 truncate flex-1">{sub.heading || '(no heading)'}</span>
                                <button
                                  onClick={() => moveSubItem(index, sIdx, sIdx - 1)}
                                  disabled={sIdx === 0}
                                  className="p-0.5 rounded text-slate-400 hover:text-slate-600 disabled:opacity-30"
                                  type="button"
                                  data-testid={`button-move-sub-up-${index}-${sIdx}`}
                                >
                                  <ChevronUp className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => moveSubItem(index, sIdx, sIdx + 1)}
                                  disabled={sIdx === (item.sub_items || []).length - 1}
                                  className="p-0.5 rounded text-slate-400 hover:text-slate-600 disabled:opacity-30"
                                  type="button"
                                  data-testid={`button-move-sub-down-${index}-${sIdx}`}
                                >
                                  <ChevronDown className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => removeSubItem(index, sIdx)}
                                  className="p-0.5 rounded text-red-400 hover:text-red-600"
                                  type="button"
                                  data-testid={`button-remove-sub-${index}-${sIdx}`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                              <div className="p-2 space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Label</Label>
                                    <Input
                                      value={sub.year || ''}
                                      onChange={(e) => updateSubItem(index, sIdx, 'year', e.target.value)}
                                      placeholder="e.g., 2020.1"
                                      className="mt-0.5 h-7 text-xs"
                                      data-testid={`input-sub-year-${index}-${sIdx}`}
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Heading</Label>
                                    <Input
                                      value={sub.heading || ''}
                                      onChange={(e) => updateSubItem(index, sIdx, 'heading', e.target.value)}
                                      placeholder="e.g., Q1 Update"
                                      className="mt-0.5 h-7 text-xs"
                                      data-testid={`input-sub-heading-${index}-${sIdx}`}
                                    />
                                  </div>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Label Side</Label>
                                    <div className="flex gap-1 mt-0.5">
                                      {[
                                        { value: 'left', label: 'L' },
                                        { value: 'right', label: 'R' },
                                        { value: 'below', label: 'B' },
                                      ].map(opt => (
                                        <button
                                          key={opt.value}
                                          type="button"
                                          onClick={() => updateSubItem(index, sIdx, 'label_side', opt.value)}
                                          className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                                            (sub.label_side || (content.label_position === 'left' ? 'left' : 'below')) === opt.value
                                              ? 'bg-slate-700 text-white border-slate-700'
                                              : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                                          }`}
                                          data-testid={`button-sub-label-side-${index}-${sIdx}-${opt.value}`}
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div>
                                    <Label className="text-[10px] text-slate-500">X Offset</Label>
                                    <input
                                      type="number"
                                      value={typeof sub.offset_x === 'number' ? sub.offset_x : ''}
                                      placeholder={String(content.sub_offset_x || 0)}
                                      onChange={(e) => updateSubItem(index, sIdx, 'offset_x', e.target.value === '' ? undefined : parseInt(e.target.value) || 0)}
                                      className="w-full px-1.5 py-0.5 text-[10px] border border-slate-200 rounded mt-0.5"
                                      data-testid={`input-sub-offset-x-${index}-${sIdx}`}
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Y Offset</Label>
                                    <input
                                      type="number"
                                      value={typeof sub.offset_y === 'number' ? sub.offset_y : ''}
                                      placeholder={String(content.sub_offset_y || 0)}
                                      onChange={(e) => updateSubItem(index, sIdx, 'offset_y', e.target.value === '' ? undefined : parseInt(e.target.value) || 0)}
                                      className="w-full px-1.5 py-0.5 text-[10px] border border-slate-200 rounded mt-0.5"
                                      data-testid={`input-sub-offset-y-${index}-${sIdx}`}
                                    />
                                  </div>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Label Size</Label>
                                    <input
                                      type="number"
                                      min={8}
                                      max={32}
                                      step={1}
                                      value={sub.label_size || ''}
                                      placeholder={String(Math.round((content.label_size || 14) * 0.85))}
                                      onChange={(e) => updateSubItem(index, sIdx, 'label_size', e.target.value === '' ? undefined : parseInt(e.target.value) || undefined)}
                                      className="w-full px-1.5 py-0.5 text-[10px] border border-slate-200 rounded mt-0.5"
                                      data-testid={`input-sub-label-size-${index}-${sIdx}`}
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Heading Size</Label>
                                    <input
                                      type="number"
                                      min={10}
                                      max={48}
                                      step={1}
                                      value={sub.heading_size || ''}
                                      placeholder={String(content.heading_size || 20)}
                                      onChange={(e) => updateSubItem(index, sIdx, 'heading_size', e.target.value === '' ? undefined : parseInt(e.target.value) || undefined)}
                                      className="w-full px-1.5 py-0.5 text-[10px] border border-slate-200 rounded mt-0.5"
                                      data-testid={`input-sub-heading-size-${index}-${sIdx}`}
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Body Size</Label>
                                    <input
                                      type="number"
                                      min={10}
                                      max={32}
                                      step={1}
                                      value={sub.body_size || ''}
                                      placeholder={String(content.body_size || 16)}
                                      onChange={(e) => updateSubItem(index, sIdx, 'body_size', e.target.value === '' ? undefined : parseInt(e.target.value) || undefined)}
                                      className="w-full px-1.5 py-0.5 text-[10px] border border-slate-200 rounded mt-0.5"
                                      data-testid={`input-sub-body-size-${index}-${sIdx}`}
                                    />
                                  </div>
                                </div>
                                <div>
                                  <Label className="text-[10px] text-slate-500">Label Colour</Label>
                                  <div className="flex items-center gap-1 mt-0.5">
                                    <input
                                      type="color"
                                      value={sub.label_color || content.label_color || '#9ca3af'}
                                      onChange={(e) => updateSubItem(index, sIdx, 'label_color', e.target.value)}
                                      className="w-5 h-5 rounded border border-slate-200 cursor-pointer"
                                    />
                                    <input
                                      value={sub.label_color || ''}
                                      onChange={(e) => updateSubItem(index, sIdx, 'label_color', e.target.value)}
                                      placeholder="Default"
                                      className="flex-1 min-w-0 px-1.5 py-0.5 text-[10px] border border-slate-200 rounded"
                                      data-testid={`input-sub-label-color-${index}-${sIdx}`}
                                    />
                                    {sub.label_color && (
                                      <button type="button" onClick={() => updateSubItem(index, sIdx, 'label_color', '')} className="p-0.5 text-slate-400 hover:text-slate-600">
                                        <X className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Heading Colour</Label>
                                    <div className="flex items-center gap-1 mt-0.5">
                                      <input
                                        type="color"
                                        value={sub.heading_color || content.heading_color || '#1e293b'}
                                        onChange={(e) => updateSubItem(index, sIdx, 'heading_color', e.target.value)}
                                        className="w-5 h-5 rounded border border-slate-200 cursor-pointer"
                                      />
                                      <input
                                        value={sub.heading_color || ''}
                                        onChange={(e) => updateSubItem(index, sIdx, 'heading_color', e.target.value)}
                                        placeholder="Default"
                                        className="flex-1 min-w-0 px-1.5 py-0.5 text-[10px] border border-slate-200 rounded"
                                        data-testid={`input-sub-heading-color-${index}-${sIdx}`}
                                      />
                                      {sub.heading_color && (
                                        <button type="button" onClick={() => updateSubItem(index, sIdx, 'heading_color', '')} className="p-0.5 text-slate-400 hover:text-slate-600">
                                          <X className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <Label className="text-[10px] text-slate-500">Body Colour</Label>
                                    <div className="flex items-center gap-1 mt-0.5">
                                      <input
                                        type="color"
                                        value={sub.body_color || content.body_color || '#374151'}
                                        onChange={(e) => updateSubItem(index, sIdx, 'body_color', e.target.value)}
                                        className="w-5 h-5 rounded border border-slate-200 cursor-pointer"
                                      />
                                      <input
                                        value={sub.body_color || ''}
                                        onChange={(e) => updateSubItem(index, sIdx, 'body_color', e.target.value)}
                                        placeholder="Default"
                                        className="flex-1 min-w-0 px-1.5 py-0.5 text-[10px] border border-slate-200 rounded"
                                        data-testid={`input-sub-body-color-${index}-${sIdx}`}
                                      />
                                      {sub.body_color && (
                                        <button type="button" onClick={() => updateSubItem(index, sIdx, 'body_color', '')} className="p-0.5 text-slate-400 hover:text-slate-600">
                                          <X className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div>
                                  <Label className="text-[10px] text-slate-500">Body</Label>
                                  <div className="mt-0.5 [&_.ql-container]:min-h-[60px] [&_.ql-editor]:min-h-[60px] [&_.ql-toolbar]:p-1 [&_.ql-editor]:text-xs">
                                    <ReactQuill
                                      theme="snow"
                                      value={sub.body || ''}
                                      onChange={(val) => updateSubItem(index, sIdx, 'body', val)}
                                      modules={timelineQuillModules}
                                      formats={timelineQuillFormats}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Highlight */}
                    <div className="border-t border-slate-200 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <Star className="w-4 h-4 text-amber-500" />
                          <Label className="text-xs text-slate-600 font-medium">Highlight</Label>
                        </div>
                        <Switch
                          checked={!!item.highlight?.enabled}
                          onCheckedChange={(v) => {
                            if (v) {
                              updateItem(index, 'highlight', {
                                enabled: true,
                                bg_type: 'solid',
                                bg_color: '#1e3a5f',
                                text_color: '#ffffff',
                                marker_shape: 'circle',
                                bg_gradient_from: '#1e3a5f',
                                bg_gradient_to: '#4a90d9',
                                bg_gradient_angle: 135,
                                border_enabled: false,
                                border_width: 1,
                                border_color: '#e2e8f0',
                                border_style: 'solid',
                                shadow: 'none',
                                shadow_color: '#3b82f6',
                              });
                            } else {
                              updateItem(index, 'highlight', { enabled: false });
                            }
                          }}
                          data-testid={`switch-highlight-${index}`}
                        />
                      </div>
                      {item.highlight?.enabled && (
                        <div className="space-y-3 pl-1">
                          <div>
                            <Label className="text-xs text-slate-500 mb-1 block">Marker Shape</Label>
                            <div className="grid grid-cols-5 gap-1">
                              {MARKER_SHAPES.map(s => {
                                const isSelected = (item.highlight.marker_shape || 'circle') === s.value;
                                return (
                                  <button
                                    key={s.value}
                                    type="button"
                                    onClick={() => updateItemHighlight(index, 'marker_shape', s.value)}
                                    className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md border transition-colors ${
                                      isSelected
                                        ? 'bg-slate-800 text-white border-slate-800'
                                        : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                                    }`}
                                    title={s.label}
                                    data-testid={`button-highlight-marker-${s.value}-${index}`}
                                  >
                                    <s.Icon className="w-4 h-4" />
                                    <span className="text-[9px] leading-none">{s.label}</span>
                                  </button>
                                );
                              })}
                            </div>

                            <div className="flex items-center gap-2 mt-2">
                              <Label className="text-xs text-slate-500 shrink-0">Colour</Label>
                              <input
                                type="color"
                                value={item.highlight.marker_color || ''}
                                onChange={(e) => updateItemHighlight(index, 'marker_color', e.target.value)}
                                className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
                                data-testid={`input-highlight-marker-color-${index}`}
                              />
                              <Input
                                value={item.highlight.marker_color || ''}
                                onChange={(e) => updateItemHighlight(index, 'marker_color', e.target.value)}
                                placeholder="Default"
                                className="w-20 text-xs"
                              />
                              {item.highlight.marker_color && (
                                <button
                                  type="button"
                                  onClick={() => updateItemHighlight(index, 'marker_color', '')}
                                  className="p-0.5 text-slate-400 hover:text-slate-600"
                                  title="Reset to default"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>

                            <div className="flex items-center gap-2 mt-2">
                              <Label className="text-xs text-slate-500 shrink-0">Background</Label>
                              <input
                                type="color"
                                value={item.highlight.marker_bg || '#ffffff'}
                                onChange={(e) => updateItemHighlight(index, 'marker_bg', e.target.value)}
                                className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
                                data-testid={`input-highlight-marker-bg-${index}`}
                              />
                              <Input
                                value={item.highlight.marker_bg || ''}
                                onChange={(e) => updateItemHighlight(index, 'marker_bg', e.target.value)}
                                placeholder="None"
                                className="w-20 text-xs"
                              />
                              {item.highlight.marker_bg && (
                                <button
                                  type="button"
                                  onClick={() => updateItemHighlight(index, 'marker_bg', '')}
                                  className="p-0.5 text-slate-400 hover:text-slate-600"
                                  title="Remove background"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>

                            <div className="flex items-center gap-2 mt-2">
                              <Label className="text-xs text-slate-500 shrink-0">Border</Label>
                              <input
                                type="color"
                                value={item.highlight.marker_border_color || '#e2e8f0'}
                                onChange={(e) => updateItemHighlight(index, 'marker_border_color', e.target.value)}
                                className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
                                data-testid={`input-highlight-marker-border-color-${index}`}
                              />
                              <Input
                                value={item.highlight.marker_border_color || ''}
                                onChange={(e) => updateItemHighlight(index, 'marker_border_color', e.target.value)}
                                placeholder="None"
                                className="w-20 text-xs"
                              />
                              {item.highlight.marker_border_color && (
                                <button
                                  type="button"
                                  onClick={() => updateItemHighlight(index, 'marker_border_color', '')}
                                  className="p-0.5 text-slate-400 hover:text-slate-600"
                                  title="Remove border"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </div>

                          <div>
                            <Label className="text-xs text-slate-500 mb-1 block">Background Type</Label>
                            <div className="flex gap-1">
                              {['solid', 'gradient', 'image'].map(t => (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => updateItemHighlight(index, 'bg_type', t)}
                                  className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                                    item.highlight.bg_type === t
                                      ? 'bg-slate-800 text-white border-slate-800'
                                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                                  }`}
                                  data-testid={`button-highlight-bg-${t}-${index}`}
                                >
                                  {t.charAt(0).toUpperCase() + t.slice(1)}
                                </button>
                              ))}
                            </div>
                          </div>

                          {item.highlight.bg_type === 'solid' && (
                            <div className="flex items-center gap-2">
                              <Label className="text-xs text-slate-500 shrink-0">Colour</Label>
                              <input
                                type="color"
                                value={item.highlight.bg_color || '#1e3a5f'}
                                onChange={(e) => updateItemHighlight(index, 'bg_color', e.target.value)}
                                className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
                                data-testid={`input-highlight-bg-color-${index}`}
                              />
                              <Input
                                value={item.highlight.bg_color || '#1e3a5f'}
                                onChange={(e) => updateItemHighlight(index, 'bg_color', e.target.value)}
                                className="w-24 text-xs"
                              />
                            </div>
                          )}

                          {item.highlight.bg_type === 'gradient' && (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Label className="text-xs text-slate-500 shrink-0">From</Label>
                                <input
                                  type="color"
                                  value={item.highlight.bg_gradient_from || '#1e3a5f'}
                                  onChange={(e) => updateItemHighlight(index, 'bg_gradient_from', e.target.value)}
                                  className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
                                  data-testid={`input-highlight-gradient-from-${index}`}
                                />
                                <Label className="text-xs text-slate-500 shrink-0">To</Label>
                                <input
                                  type="color"
                                  value={item.highlight.bg_gradient_to || '#4a90d9'}
                                  onChange={(e) => updateItemHighlight(index, 'bg_gradient_to', e.target.value)}
                                  className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
                                  data-testid={`input-highlight-gradient-to-${index}`}
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <Label className="text-xs text-slate-500 shrink-0 w-10">Angle</Label>
                                <input
                                  type="range"
                                  min="0"
                                  max="360"
                                  step="1"
                                  value={item.highlight.bg_gradient_angle ?? 135}
                                  onChange={(e) => updateItemHighlight(index, 'bg_gradient_angle', parseInt(e.target.value))}
                                  className="flex-1"
                                  data-testid={`input-highlight-gradient-angle-${index}`}
                                />
                                <span className="text-xs text-slate-500 w-8 text-right">{item.highlight.bg_gradient_angle ?? 135}°</span>
                              </div>
                              <div
                                className="h-6 rounded-md border border-slate-200"
                                style={{
                                  background: `linear-gradient(${item.highlight.bg_gradient_angle ?? 135}deg, ${item.highlight.bg_gradient_from || '#1e3a5f'}, ${item.highlight.bg_gradient_to || '#4a90d9'})`
                                }}
                              />
                            </div>
                          )}

                          {item.highlight.bg_type === 'image' && (
                            <div className="space-y-2">
                              {item.highlight.bg_image ? (
                                <div className="relative rounded-lg overflow-hidden border border-slate-200">
                                  <img
                                    src={item.highlight.bg_image}
                                    alt="Highlight background"
                                    className="w-full h-20 object-cover"
                                  />
                                  <button
                                    onClick={() => updateItemHighlight(index, 'bg_image', '')}
                                    className="absolute top-1 right-1 p-1 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
                                    title="Remove background"
                                    type="button"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ) : (
                                <label className="cursor-pointer block">
                                  <div className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm border-2 border-dashed transition-colors ${
                                    isHighlightBgUploading[index]
                                      ? 'border-slate-200 bg-slate-100 cursor-not-allowed'
                                      : 'border-slate-300 hover:border-blue-400 hover:bg-blue-50/50'
                                  }`}>
                                    {isHighlightBgUploading[index] ? (
                                      <span className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full" />
                                    ) : (
                                      <>
                                        <Upload className="w-4 h-4 text-slate-400" />
                                        <span className="text-xs text-slate-500">Upload background image</span>
                                      </>
                                    )}
                                  </div>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file) handleHighlightBgUpload(index, file);
                                      e.target.value = '';
                                    }}
                                    className="hidden"
                                    disabled={isHighlightBgUploading[index]}
                                    data-testid={`input-highlight-bg-upload-${index}`}
                                  />
                                </label>
                              )}
                            </div>
                          )}

                          <div className="flex items-center gap-2">
                            <Label className="text-xs text-slate-500 shrink-0">Text Colour</Label>
                            <input
                              type="color"
                              value={item.highlight.text_color || '#ffffff'}
                              onChange={(e) => updateItemHighlight(index, 'text_color', e.target.value)}
                              className="w-8 h-8 rounded border border-slate-200 cursor-pointer"
                              data-testid={`input-highlight-text-color-${index}`}
                            />
                            <Input
                              value={item.highlight.text_color || '#ffffff'}
                              onChange={(e) => updateItemHighlight(index, 'text_color', e.target.value)}
                              className="w-24 text-xs"
                            />
                          </div>

                          <div className="border-t border-slate-100 pt-3">
                            <div className="flex items-center justify-between mb-2">
                              <Label className="text-xs text-slate-500 font-medium">Border</Label>
                              <Switch
                                checked={!!item.highlight.border_enabled}
                                onCheckedChange={(v) => updateItemHighlight(index, 'border_enabled', v)}
                                data-testid={`switch-highlight-border-${index}`}
                              />
                            </div>
                            {item.highlight.border_enabled && (
                              <div className="space-y-2 pl-1">
                                <div className="flex items-center gap-2">
                                  <Label className="text-xs text-slate-500 shrink-0">Colour</Label>
                                  <input
                                    type="color"
                                    value={item.highlight.border_color || '#e2e8f0'}
                                    onChange={(e) => updateItemHighlight(index, 'border_color', e.target.value)}
                                    className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
                                    data-testid={`input-highlight-border-color-${index}`}
                                  />
                                  <Input
                                    value={item.highlight.border_color || '#e2e8f0'}
                                    onChange={(e) => updateItemHighlight(index, 'border_color', e.target.value)}
                                    className="w-20 text-xs"
                                  />
                                </div>
                                <div className="flex items-center gap-2">
                                  <Label className="text-xs text-slate-500 shrink-0 w-10">Width</Label>
                                  <input
                                    type="range"
                                    min="1"
                                    max="6"
                                    step="1"
                                    value={item.highlight.border_width ?? 1}
                                    onChange={(e) => updateItemHighlight(index, 'border_width', parseInt(e.target.value))}
                                    className="flex-1"
                                    data-testid={`input-highlight-border-width-${index}`}
                                  />
                                  <span className="text-xs text-slate-500 w-8 text-right">{item.highlight.border_width ?? 1}px</span>
                                </div>
                                <div>
                                  <Label className="text-xs text-slate-500 mb-1 block">Style</Label>
                                  <div className="flex gap-1">
                                    {['solid', 'dashed', 'dotted'].map(s => (
                                      <button
                                        key={s}
                                        type="button"
                                        onClick={() => updateItemHighlight(index, 'border_style', s)}
                                        className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                                          (item.highlight.border_style || 'solid') === s
                                            ? 'bg-slate-800 text-white border-slate-800'
                                            : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                                        }`}
                                        data-testid={`button-highlight-border-style-${s}-${index}`}
                                      >
                                        {s.charAt(0).toUpperCase() + s.slice(1)}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="border-t border-slate-100 pt-3">
                            <Label className="text-xs text-slate-500 mb-1 block font-medium">Shadow</Label>
                            <div className="flex flex-wrap gap-1">
                              {[
                                { value: 'none', label: 'None' },
                                { value: 'sm', label: 'Small' },
                                { value: 'md', label: 'Medium' },
                                { value: 'lg', label: 'Large' },
                                { value: 'xl', label: 'X-Large' },
                                { value: 'glow', label: 'Glow' },
                              ].map(s => (
                                <button
                                  key={s.value}
                                  type="button"
                                  onClick={() => updateItemHighlight(index, 'shadow', s.value)}
                                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                                    (item.highlight.shadow || 'none') === s.value
                                      ? 'bg-slate-800 text-white border-slate-800'
                                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                                  }`}
                                  data-testid={`button-highlight-shadow-${s.value}-${index}`}
                                >
                                  {s.label}
                                </button>
                              ))}
                            </div>
                            {item.highlight.shadow === 'glow' && (
                              <div className="flex items-center gap-2 mt-2">
                                <Label className="text-xs text-slate-500 shrink-0">Glow Colour</Label>
                                <input
                                  type="color"
                                  value={item.highlight.shadow_color || '#3b82f6'}
                                  onChange={(e) => updateItemHighlight(index, 'shadow_color', e.target.value)}
                                  className="w-7 h-7 rounded border border-slate-200 cursor-pointer"
                                  data-testid={`input-highlight-shadow-color-${index}`}
                                />
                                <Input
                                  value={item.highlight.shadow_color || '#3b82f6'}
                                  onChange={(e) => updateItemHighlight(index, 'shadow_color', e.target.value)}
                                  className="w-20 text-xs"
                                />
                              </div>
                            )}
                          </div>

                          <div className="border-t border-slate-100 pt-3">
                            <Label className="text-xs text-slate-500 mb-1 block font-medium">Text Lines</Label>
                            <div className="flex items-center gap-2">
                              <Input
                                type="number"
                                min={0}
                                max={50}
                                step={1}
                                value={item.highlight.text_lines || ''}
                                placeholder="All (no limit)"
                                onChange={(e) => updateItemHighlight(index, 'text_lines', e.target.value === '' ? 0 : parseInt(e.target.value) || 0)}
                                className="w-28 text-xs"
                                data-testid={`input-highlight-text-lines-${index}`}
                              />
                              {item.highlight.text_lines > 0 && (
                                <Button size="sm" variant="ghost" onClick={() => updateItemHighlight(index, 'text_lines', 0)} data-testid={`button-clear-text-lines-${index}`}>
                                  <X className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                            <p className="text-xs text-slate-400 mt-1">Limit visible text with "Read more" button</p>
                          </div>
                        </div>
                      )}
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
