import { useState, useEffect, useMemo } from "react";

const STYLE_TYPE_LABELS = {
  'h1': 'H1 - Main Heading',
  'h2': 'H2 - Section Heading',
  'h3': 'H3 - Subsection Heading',
  'h4': 'H4 - Small Heading',
  'paragraph': 'Paragraph'
};

let cachedStyles = null;
let cachePromise = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30000; // 30 seconds cache TTL to pick up changes from InstalledFonts

export async function fetchTypographyStyles(forceRefresh = false) {
  const now = Date.now();
  
  // If cache is valid and not forcing refresh, return cached styles
  if (cachedStyles && !forceRefresh && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedStyles;
  }
  
  // If a fetch is already in progress, wait for it
  if (cachePromise) return cachePromise;
  
  cachePromise = (async () => {
    try {
      const { base44 } = await import("@/api/base44Client");
      const allStyles = await base44.entities.TypographyStyle.list() || [];
      cachedStyles = allStyles.filter(s => s.is_active);
      cacheTimestamp = Date.now();
      return cachedStyles;
    } catch (error) {
      console.error('Failed to fetch typography styles:', error);
      return cachedStyles || []; // Return stale cache if available
    } finally {
      cachePromise = null;
    }
  })();
  
  return cachePromise;
}

// Force cache invalidation (call this when typography styles are updated in InstalledFonts)
export function invalidateTypographyCache() {
  cachedStyles = null;
  cacheTimestamp = 0;
}

// Hook to use typography styles in components
export function useTypographyStyles() {
  const [styles, setStyles] = useState(cachedStyles || []);
  const [isLoading, setIsLoading] = useState(!cachedStyles);
  
  useEffect(() => {
    fetchTypographyStyles().then(loadedStyles => {
      setStyles(loadedStyles);
      setIsLoading(false);
    });
  }, []);
  
  const getStyleById = (styleId) => {
    if (!styleId) return null;
    return styles.find(s => s.id === styleId) || null;
  };
  
  return { styles, isLoading, getStyleById };
}

export default function TypographyStyleSelector({ 
  value, 
  onChange, 
  filterTypes = null,
  label = "Typography Style",
  placeholder = "Select a style to apply..."
}) {
  const [allStyles, setAllStyles] = useState(cachedStyles || []);
  const [isLoading, setIsLoading] = useState(!cachedStyles);

  useEffect(() => {
    if (cachedStyles) {
      setAllStyles(cachedStyles);
      setIsLoading(false);
      return;
    }
    
    fetchTypographyStyles().then(styles => {
      setAllStyles(styles);
      setIsLoading(false);
    });
  }, []);

  const styles = useMemo(() => {
    let filtered = filterTypes && filterTypes.length > 0
      ? allStyles.filter(s => filterTypes.includes(s.style_type))
      : [...allStyles];
    
    return filtered.sort((a, b) => {
      const typeOrder = ['h1', 'h2', 'h3', 'h4', 'paragraph'];
      const aOrder = typeOrder.indexOf(a.style_type);
      const bOrder = typeOrder.indexOf(b.style_type);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });
  }, [allStyles, filterTypes]);

  const handleChange = (styleId) => {
    const selectedStyle = styleId ? styles.find(s => s.id === styleId) : null;
    onChange(styleId || null, selectedStyle || null);
  };

  const selectedStyle = value ? styles.find(s => s.id === value) : null;

  const groupedStyles = styles.reduce((acc, style) => {
    const type = style.style_type;
    if (!acc[type]) acc[type] = [];
    acc[type].push(style);
    return acc;
  }, {});

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium mb-1">{label}</label>
      <select
        value={value || ''}
        onChange={(e) => handleChange(e.target.value || null)}
        className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm"
        disabled={isLoading}
        data-testid="select-typography-style"
      >
        <option value="">{isLoading ? 'Loading styles...' : placeholder}</option>
        {Object.entries(groupedStyles).map(([type, typeStyles]) => (
          <optgroup key={type} label={STYLE_TYPE_LABELS[type] || type}>
            {typeStyles.map(style => (
              <option key={style.id} value={style.id}>
                {style.name} {style.is_default ? '(Default)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      
      {selectedStyle && (
        <div className="flex items-center justify-between text-xs text-slate-500 bg-slate-50 px-2 py-1 rounded">
          <span>
            {selectedStyle.font_family.split(',')[0].replace(/'/g, '')} • {selectedStyle.font_size}px • {selectedStyle.font_weight}
          </span>
          <button
            type="button"
            onClick={() => onChange(null, null)}
            className="text-red-500 hover:text-red-700 text-xs"
            data-testid="button-clear-typography-style"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

export function applyTypographyStyle(style) {
  if (!style) return {};
  
  return {
    font_family: style.font_family,
    font_size: style.font_size,
    font_size_mobile: style.font_size_mobile,
    font_weight: style.font_weight,
    line_height: style.line_height,
    letter_spacing: style.letter_spacing,
    text_transform: style.text_transform,
    ...(style.color ? { color: style.color } : {})
  };
}

export function getTypographyStyleCSS(style, isMobile = false) {
  if (!style) return {};
  
  const fontSize = isMobile && style.font_size_mobile 
    ? style.font_size_mobile 
    : style.font_size;
  
  return {
    fontFamily: style.font_family,
    fontSize: `${fontSize}px`,
    fontWeight: style.font_weight,
    lineHeight: style.line_height,
    letterSpacing: `${style.letter_spacing}px`,
    textTransform: style.text_transform,
    ...(style.color ? { color: style.color } : {})
  };
}
