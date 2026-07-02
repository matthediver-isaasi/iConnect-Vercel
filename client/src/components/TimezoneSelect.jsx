import { useState, useRef, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronDown, Search, Check } from 'lucide-react';

function getAllTimezones() {
  try {
    const tzList = Intl.supportedValuesOf('timeZone');
    return tzList.filter(tz => tz.includes('/'));
  } catch {
    return [
      'Africa/Cairo', 'Africa/Casablanca', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
      'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Chicago',
      'America/Denver', 'America/Halifax', 'America/Lima', 'America/Los_Angeles', 'America/Mexico_City',
      'America/New_York', 'America/Phoenix', 'America/Santiago', 'America/Sao_Paulo', 'America/Toronto',
      'America/Vancouver',
      'Asia/Almaty', 'Asia/Baghdad', 'Asia/Bangkok', 'Asia/Calcutta', 'Asia/Colombo', 'Asia/Dhaka',
      'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Istanbul', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi',
      'Asia/Kolkata', 'Asia/Kuala_Lumpur', 'Asia/Manila', 'Asia/Riyadh', 'Asia/Seoul', 'Asia/Shanghai',
      'Asia/Singapore', 'Asia/Taipei', 'Asia/Tehran', 'Asia/Tokyo',
      'Atlantic/Reykjavik',
      'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Darwin', 'Australia/Hobart',
      'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney',
      'Europe/Amsterdam', 'Europe/Athens', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Brussels',
      'Europe/Bucharest', 'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Helsinki',
      'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London', 'Europe/Madrid', 'Europe/Moscow',
      'Europe/Oslo', 'Europe/Paris', 'Europe/Prague', 'Europe/Rome', 'Europe/Stockholm',
      'Europe/Vienna', 'Europe/Warsaw', 'Europe/Zurich',
      'Indian/Maldives', 'Indian/Mauritius',
      'Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Guam', 'Pacific/Honolulu',
    ];
  }
}

function buildTimezoneMetadata(tzList) {
  const now = new Date();
  const metadata = {};

  for (const tz of tzList) {
    try {
      const offsetFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      });
      const abbrFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'short',
      });

      const offsetParts = offsetFormatter.formatToParts(now);
      const abbrParts = abbrFormatter.formatToParts(now);

      const offset = offsetParts.find(p => p.type === 'timeZoneName')?.value || '';
      const abbr = abbrParts.find(p => p.type === 'timeZoneName')?.value || '';
      const city = tz.split('/').pop().replace(/_/g, ' ');
      const offsetStr = offset !== abbr ? `${abbr}, ${offset}` : offset;
      const label = `${city} (${offsetStr})`;
      const region = tz.split('/')[0];
      const searchText = `${tz} ${city} ${abbr} ${offset}`.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, '');

      metadata[tz] = { label, region, searchText };
    } catch {
      const city = tz.split('/').pop().replace(/_/g, ' ');
      metadata[tz] = { label: city, region: tz.split('/')[0], searchText: `${tz} ${city}`.toLowerCase() };
    }
  }

  return metadata;
}

const REGION_LABELS = {
  'Africa': 'Africa',
  'America': 'Americas',
  'Antarctica': 'Antarctica',
  'Arctic': 'Arctic',
  'Asia': 'Asia',
  'Atlantic': 'Atlantic',
  'Australia': 'Australia',
  'Europe': 'Europe',
  'Indian': 'Indian Ocean',
  'Pacific': 'Pacific',
};

const REGION_ORDER = ['America', 'Europe', 'Asia', 'Africa', 'Australia', 'Pacific', 'Atlantic', 'Indian', 'Antarctica', 'Arctic'];

function groupTimezones(timezones) {
  const groups = {};
  for (const tz of timezones) {
    const region = tz.split('/')[0];
    if (!groups[region]) {
      groups[region] = [];
    }
    groups[region].push(tz);
  }
  const sorted = {};
  for (const region of REGION_ORDER) {
    if (groups[region]) {
      sorted[region] = groups[region];
    }
  }
  for (const region of Object.keys(groups)) {
    if (!sorted[region]) {
      sorted[region] = groups[region];
    }
  }
  return sorted;
}

export default function TimezoneSelect({ value, onChange, id }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const selectedRef = useRef(null);

  const allTimezones = useMemo(() => getAllTimezones(), []);
  const metadata = useMemo(() => buildTimezoneMetadata(allTimezones), [allTimezones]);

  const filteredTimezones = useMemo(() => {
    if (!search.trim()) return allTimezones;
    const q = search.toLowerCase().replace(/\s+/g, '');
    return allTimezones.filter(tz => {
      const meta = metadata[tz];
      return meta?.searchText.includes(q) || tz.toLowerCase().includes(q);
    });
  }, [search, allTimezones, metadata]);

  const grouped = useMemo(() => groupTimezones(filteredTimezones), [filteredTimezones]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && !search && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: 'center' });
    }
  }, [isOpen, search]);

  function getLabelForValue(tz) {
    if (!tz) return 'Select timezone...';
    if (metadata[tz]) return metadata[tz].label;
    const city = tz.split('/').pop().replace(/_/g, ' ');
    return `${city} (${tz})`;
  }

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        id={id}
        variant="outline"
        role="combobox"
        aria-expanded={isOpen}
        className="w-full justify-between font-normal no-default-hover-elevate no-default-active-elevate"
        onClick={() => setIsOpen(!isOpen)}
        data-testid="select-timezone"
      >
        <span className="truncate text-left flex-1">{getLabelForValue(value)}</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-4 w-4 shrink-0 opacity-50" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search timezones..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              data-testid="input-timezone-search"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1">
            {Object.keys(grouped).length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No timezones found.
              </div>
            )}
            {Object.entries(grouped).map(([region, tzList]) => (
              <div key={region}>
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                  {REGION_LABELS[region] || region}
                </div>
                {tzList.map(tz => {
                  const isSelected = value === tz;
                  return (
                    <button
                      key={tz}
                      ref={isSelected ? selectedRef : null}
                      type="button"
                      className={`relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover-elevate ${isSelected ? 'bg-accent text-accent-foreground' : ''}`}
                      onClick={() => {
                        onChange(tz);
                        setIsOpen(false);
                        setSearch('');
                      }}
                      data-testid={`option-timezone-${tz}`}
                    >
                      <Check className={`mr-2 h-4 w-4 ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
                      <span className="truncate">{metadata[tz]?.label || tz}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
