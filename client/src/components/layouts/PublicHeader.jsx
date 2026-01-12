import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { useNavigationRealtime } from "@/hooks/useNavigationRealtime";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { Search, User, ArrowUpRight, LogOut, ChevronDown, ChevronRight, Calendar, Building, Briefcase, FileText, Users, Sparkles, Home, Mail, Phone, Menu, X, Loader2, Newspaper, BookOpen, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Icon mapping for commonly used Lucide icons
const iconMap = {
  Calendar,
  Building,
  Briefcase,
  FileText,
  Users,
  Sparkles,
  Home,
  Mail,
  Phone,
  Search,
  User,
  ChevronDown
};

// Type icon mapping for search results
const typeIconMap = {
  event: Calendar,
  article: BookOpen,
  news: Newspaper,
  resource: FolderOpen
};

const DEFAULT_HEADER_LOGO = "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/26710cf5a_GFIheaderlogo.png";

const DEFAULT_GRADIENT_STOPS = [
  { color: '#FFFFFF', position: 0 },
  { color: '#FFFFFF', position: 30 },
  { color: '#5C0085', position: 50 },
  { color: '#BA0087', position: 65 },
  { color: '#EE00C3', position: 80 },
  { color: '#FF4229', position: 90 },
  { color: '#FFB000', position: 100 }
];
const BUTTON_ACCENT_GRADIENT = 'linear-gradient(to top right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)';
const BUTTON_ACCENT_GRADIENT_HORIZONTAL = 'linear-gradient(to right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)';

const convertLegacyGradientColors = (colors) => {
  if (!colors || colors.length === 0) return DEFAULT_GRADIENT_STOPS;
  if (colors.length === 1) {
    return [
      { color: '#FFFFFF', position: 0 },
      { color: '#FFFFFF', position: 30 },
      { color: colors[0], position: 100 }
    ];
  }
  const colorStops = colors.map((color, index) => ({
    color,
    position: Math.round((index / (colors.length - 1)) * 70) + 30
  }));
  return [
    { color: '#FFFFFF', position: 0 },
    { color: '#FFFFFF', position: 30 },
    ...colorStops
  ];
};

const getGradientStops = (headerConfig) => {
  if (headerConfig?.gradientStops && headerConfig.gradientStops.length > 0) {
    return headerConfig.gradientStops;
  }
  if (headerConfig?.gradientColors && headerConfig.gradientColors.length > 0) {
    return convertLegacyGradientColors(headerConfig.gradientColors);
  }
  return DEFAULT_GRADIENT_STOPS;
};

const buildGradientFromStops = (stops) => {
  const sortedStops = [...stops].sort((a, b) => a.position - b.position);
  return `linear-gradient(to right, ${sortedStops.map(s => `${s.color} ${s.position}%`).join(', ')})`;
};

const getColorStopsOnly = (stops) => {
  return stops.filter(s => s.color.toUpperCase() !== '#FFFFFF');
};

export default function PublicHeader() {
  const { branding } = useTenantBranding() || {};
  const headerLogoUrl = branding?.headerLogoUrl || branding?.logoUrl || DEFAULT_HEADER_LOGO;
  const tenantName = branding?.name || "Graduate Futures Institute";
  const headerLogoHeight = branding?.headerConfig?.logoHeight;
  const headerLogoWidth = branding?.headerConfig?.logoWidth;
  const gradientStops = getGradientStops(branding?.headerConfig);
  const topBarGradient = buildGradientFromStops(gradientStops);
  const colorStops = getColorStopsOnly(gradientStops);
  const navIndicatorGradient = colorStops.length > 0 
    ? `linear-gradient(to right, ${colorStops.map(s => s.color).join(', ')})`
    : BUTTON_ACCENT_GRADIENT_HORIZONTAL;
  
  const [searchOpen, setSearchOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [memberLandingPage, setMemberLandingPage] = useState('Events');

  // Fetch article display name setting
  const { data: articleDisplayName } = useQuery({
    queryKey: ['article-display-name-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'article_display_name');
      return setting?.setting_value || 'Article';
    },
    staleTime: 5 * 60 * 1000
  });

  // Dynamic type label that uses custom article display name
  const getTypeLabel = useCallback((type) => {
    if (type === 'article') {
      const name = articleDisplayName || 'Article';
      return name.endsWith('s') ? name.slice(0, -1) : name;
    }
    const labels = { event: 'Event', news: 'News', resource: 'Resource' };
    return labels[type] || type;
  }, [articleDisplayName]);
  const [navItems, setNavItems] = useState({ topNav: [], mainNav: [] });
  const [hoveredMenu, setHoveredMenu] = useState(null);
  const [hoveredSubmenu, setHoveredSubmenu] = useState(null);
  const [socialIcons, setSocialIcons] = useState(null);
  const [closeTimeout, setCloseTimeout] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileExpandedMenus, setMobileExpandedMenus] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [mobileSearchQuery, setMobileSearchQuery] = useState('');
  const [mobileSearchResults, setMobileSearchResults] = useState([]);
  const [isMobileSearching, setIsMobileSearching] = useState(false);
  const searchTimeoutRef = useRef(null);
  const mobileSearchTimeoutRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setMobileExpandedMenus({});
  }, [location.pathname]);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    // Check if user is logged in and fetch their role's landing page
    const checkLoginStatus = async () => {
      const storedMember = localStorage.getItem('agcas_member');
      setIsLoggedIn(!!storedMember);
      
      if (storedMember) {
        try {
          const member = JSON.parse(storedMember);
          if (member.role_id) {
            const role = await base44.entities.Role.get(member.role_id);
            if (role?.default_landing_page) {
              setMemberLandingPage(role.default_landing_page);
            }
          }
        } catch (error) {
          console.error('Failed to fetch member role:', error);
        }
      }
    };

    checkLoginStatus();
    
    // Listen for storage changes
    window.addEventListener('storage', checkLoginStatus);
    
    return () => {
      window.removeEventListener('storage', checkLoginStatus);
    };
  }, []);

  // Function to fetch navigation items
  const fetchNavItems = useCallback(async () => {
    try {
      // Fetch all items and filter client-side to bypass any SDK caching
      const allItems = await base44.entities.NavigationItem.list('display_order');
      const items = allItems.filter(item => item.is_active);
      
      // Build hierarchy
      const buildTree = (parentId, location) => {
        return items
          .filter(item => item.parent_id === parentId && item.location === location)
          .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
          .map(item => ({
            ...item,
            children: buildTree(item.id, location)
          }));
      };

      const topNav = buildTree(null, 'top_nav');
      const mainNav = buildTree(null, 'main_nav');

      setNavItems({ topNav, mainNav });
    } catch (error) {
      console.error('Failed to fetch navigation items:', error);
      setNavItems({ topNav: [], mainNav: [] });
    }
  }, []);

  // Subscribe to realtime navigation changes
  useNavigationRealtime(fetchNavItems);

  // Fetch navigation items on mount and route changes
  useEffect(() => {
    fetchNavItems();
    
    // Refetch on window focus
    const handleFocus = () => fetchNavItems();
    window.addEventListener('focus', handleFocus);
    
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [location.pathname, fetchNavItems]);

  // Fetch social icons configuration
  useEffect(() => {
    const fetchSocialConfig = async () => {
      try {
        const allSettings = await base44.entities.SystemSettings.list();
        const setting = allSettings.find(s => s.setting_key === 'social_icons_config');
        
        if (setting?.setting_value) {
          try {
            setSocialIcons(JSON.parse(setting.setting_value));
          } catch (e) {
            console.error('Failed to parse social icons config:', e);
          }
        }
      } catch (error) {
        console.error('Failed to fetch social icons config:', error);
      }
    };

    fetchSocialConfig();
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { 
        method: 'POST', 
        credentials: 'include' 
      });
    } catch (error) {
      console.log('[PublicHeader] Server logout error:', error);
    }
    localStorage.removeItem('agcas_member');
    localStorage.removeItem('agcas_organization');
    setMobileMenuOpen(false);
    window.location.href = createPageUrl('Home');
  };

  // Debounced search handler for desktop
  const handleSearch = useCallback((query) => {
    setSearchQuery(query);
    
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    
    if (!query || query.trim().length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    
    setIsSearching(true);
    
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/public/search?q=${encodeURIComponent(query.trim())}&limit=8`);
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data.results || []);
        }
      } catch (error) {
        console.error('Search error:', error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, []);

  // Debounced search handler for mobile
  const handleMobileSearch = useCallback((query) => {
    setMobileSearchQuery(query);
    
    if (mobileSearchTimeoutRef.current) {
      clearTimeout(mobileSearchTimeoutRef.current);
    }
    
    if (!query || query.trim().length < 2) {
      setMobileSearchResults([]);
      setIsMobileSearching(false);
      return;
    }
    
    setIsMobileSearching(true);
    
    mobileSearchTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/public/search?q=${encodeURIComponent(query.trim())}&limit=8`);
        if (response.ok) {
          const data = await response.json();
          setMobileSearchResults(data.results || []);
        }
      } catch (error) {
        console.error('Mobile search error:', error);
        setMobileSearchResults([]);
      } finally {
        setIsMobileSearching(false);
      }
    }, 300);
  }, []);

  // Handle clicking a search result
  const handleResultClick = (url) => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    navigate(url);
  };

  // Handle clicking a mobile search result
  const handleMobileResultClick = (url) => {
    setMobileMenuOpen(false);
    setMobileSearchQuery('');
    setMobileSearchResults([]);
    navigate(url);
  };

  // Navigate to search results page
  const handleViewAllResults = () => {
    if (searchQuery.trim()) {
      setSearchOpen(false);
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (mobileSearchTimeoutRef.current) {
        clearTimeout(mobileSearchTimeoutRef.current);
      }
    };
  }, []);

  // Check if a navigation item is active
  const isActive = (item) => {
    if (item.link_type === 'external') return false;
    
    const itemPath = createPageUrl(item.url);
    const currentPath = location.pathname;
    
    return currentPath === itemPath;
  };

  // Toggle mobile submenu expansion
  const toggleMobileSubmenu = (itemId) => {
    setMobileExpandedMenus(prev => ({
      ...prev,
      [itemId]: !prev[itemId]
    }));
  };

  // Render mobile navigation item
  const renderMobileNavItem = (item, level = 0) => {
    const hasChildren = item.children && item.children.length > 0;
    const Icon = item.icon && iconMap[item.icon] ? iconMap[item.icon] : null;
    const active = isActive(item);
    const isExpanded = mobileExpandedMenus[item.id];

    // Determine link props
    const linkProps = item.link_type === 'external' 
      ? {
          href: item.url,
          target: item.open_in_new_tab ? '_blank' : '_self',
          rel: item.open_in_new_tab ? 'noopener noreferrer' : undefined
        }
      : {
          to: createPageUrl(item.url)
        };

    const LinkComponent = item.link_type === 'external' ? 'a' : Link;

    const paddingLeft = 16 + (level * 16);

    // Gradient button style
    if (item.highlight_style === 'gradient_button') {
      return (
        <LinkComponent 
          key={item.id} 
          {...linkProps}
          onClick={() => setMobileMenuOpen(false)}
        >
          <div 
            className="mx-4 my-2 py-3 px-4 text-white font-bold flex items-center justify-center gap-2"
            style={{ 
              background: BUTTON_ACCENT_GRADIENT
            }}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {item.title}
            <ArrowUpRight className="w-4 h-4" strokeWidth={2.5} />
          </div>
        </LinkComponent>
      );
    }

    if (hasChildren) {
      return (
        <div key={item.id}>
          <button
            onClick={() => toggleMobileSubmenu(item.id)}
            className="w-full flex items-center justify-between py-3 text-slate-900 hover:bg-slate-50 transition-colors"
            style={{ paddingLeft: `${paddingLeft}px`, paddingRight: '16px' }}
          >
            <div className="flex items-center gap-3">
              {Icon && <Icon className="w-5 h-5 text-slate-600" />}
              <span className={active ? 'font-bold' : 'font-medium'}>{item.title}</span>
            </div>
            <ChevronDown 
              className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} 
            />
          </button>
          
          {isExpanded && (
            <div className="bg-slate-50">
              {item.children.map(child => renderMobileNavItem(child, level + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <LinkComponent 
        key={item.id} 
        {...linkProps}
        className="flex items-center gap-3 py-3 text-slate-900 hover:bg-slate-50 transition-colors"
        style={{ paddingLeft: `${paddingLeft}px`, paddingRight: '16px' }}
        onClick={() => setMobileMenuOpen(false)}
      >
        {Icon && <Icon className="w-5 h-5 text-slate-600" />}
        <span className={active ? 'font-bold' : 'font-medium'}>{item.title}</span>
      </LinkComponent>
    );
  };

  // Render navigation item with icon support and active state (Desktop)
  const renderNavItem = (item, isTopNav = false) => {
    const hasChildren = item.children && item.children.length > 0;
    const Icon = item.icon && iconMap[item.icon] ? iconMap[item.icon] : null;
    const active = isActive(item);

    // Determine link props
    const linkProps = item.link_type === 'external' 
      ? {
          href: item.url,
          target: item.open_in_new_tab ? '_blank' : '_self',
          rel: item.open_in_new_tab ? 'noopener noreferrer' : undefined
        }
      : {
          to: createPageUrl(item.url)
        };

    const LinkComponent = item.link_type === 'external' ? 'a' : Link;

    // Build className with proper font weight handling
    const getFontClass = () => {
      if (active) return 'font-bold';
      if (isTopNav) return 'font-semibold text-sm';
      return 'font-medium';
    };

    const baseClassName = `nav-link text-${isTopNav ? 'white' : 'slate-900'} transition-colors ${getFontClass()} flex items-center gap-1`;

    // Gradient button style
    if (item.highlight_style === 'gradient_button') {
      return (
        <LinkComponent key={item.id} {...linkProps}>
          <Button 
            className="text-white font-bold hover:opacity-90 transition-opacity px-6 py-5 rounded-none" 
            style={{ 
              fontFamily: 'Poppins, sans-serif',
              background: BUTTON_ACCENT_GRADIENT
            }}
          >
            {Icon && <Icon className="w-4 h-4 mr-2" />}
            {item.title}
            <ArrowUpRight className="ml-0.5 w-5 h-5" strokeWidth={2.5} />
          </Button>
        </LinkComponent>
      );
    }

    // Regular nav item with sub-menu
    if (hasChildren) {
      const handleMouseEnter = () => {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
          setCloseTimeout(null);
        }
        setHoveredMenu(item.id);
      };

      const handleMouseLeave = () => {
        const timeout = setTimeout(() => {
          setHoveredMenu(null);
        }, 150);
        setCloseTimeout(timeout);
      };

      return (
        <div
          key={item.id}
          className="relative h-full flex items-center"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <button className={baseClassName}>
            {Icon && <Icon className="w-4 h-4" />}
            {item.title}
            <ChevronDown className="w-4 h-4" />
          </button>

          {/* Active indicator - positioned at bottom of nav container */}
          {!isTopNav && active && (
            <div 
              className="absolute left-0 right-0 h-[5px]"
              style={{
                bottom: '-33px',
                background: navIndicatorGradient
              }}
            />
          )}

          {/* Mega Menu Dropdown */}
          {hoveredMenu === item.id && (
            <div 
              className="absolute top-full left-0 mt-2 bg-white rounded-lg shadow-xl border border-slate-200 py-4 z-50 min-w-[240px]"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              {item.children.map((child) => {
                const ChildIcon = child.icon && iconMap[child.icon] ? iconMap[child.icon] : null;
                const childActive = isActive(child);
                const hasGrandchildren = child.children && child.children.length > 0;
                const childLinkProps = child.link_type === 'external'
                  ? {
                      href: child.url,
                      target: child.open_in_new_tab ? '_blank' : '_self',
                      rel: child.open_in_new_tab ? 'noopener noreferrer' : undefined
                    }
                  : {
                      to: createPageUrl(child.url)
                    };
                
                const ChildLinkComponent = child.link_type === 'external' ? 'a' : Link;

                return (
                  <div 
                    key={child.id} 
                    className="relative"
                    onMouseEnter={() => hasGrandchildren && setHoveredSubmenu(child.id)}
                    onMouseLeave={() => hasGrandchildren && setHoveredSubmenu(null)}
                  >
                    <ChildLinkComponent
                      {...childLinkProps}
                      className="block px-4 py-2 hover:bg-slate-50 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        {ChildIcon && <ChildIcon className="w-5 h-5 text-slate-600 mt-0.5" />}
                        <div className="flex-1">
                          <div className={`text-slate-900 ${childActive ? 'font-bold' : 'font-medium'} flex items-center gap-2`}>
                            {child.title}
                            {hasGrandchildren && <ChevronRight className="w-3 h-3" />}
                          </div>
                          {child.description && (
                            <div className="text-xs text-slate-500 mt-0.5">{child.description}</div>
                          )}
                        </div>
                      </div>
                    </ChildLinkComponent>
                    
                    {/* Render grandchildren on hover */}
                    {hasGrandchildren && hoveredSubmenu === child.id && (
                      <div className="absolute left-full top-0 -ml-[11px] bg-white rounded-lg shadow-xl border border-slate-200 py-4 min-w-[220px]">
                        {child.children.map((grandchild) => {
                          const GrandchildIcon = grandchild.icon && iconMap[grandchild.icon] ? iconMap[grandchild.icon] : null;
                          const grandchildActive = isActive(grandchild);
                          const grandchildLinkProps = grandchild.link_type === 'external'
                            ? {
                                href: grandchild.url,
                                target: grandchild.open_in_new_tab ? '_blank' : '_self',
                                rel: grandchild.open_in_new_tab ? 'noopener noreferrer' : undefined
                              }
                            : {
                                to: createPageUrl(grandchild.url)
                              };
                          
                          const GrandchildLinkComponent = grandchild.link_type === 'external' ? 'a' : Link;

                          return (
                            <GrandchildLinkComponent
                              key={grandchild.id}
                              {...grandchildLinkProps}
                              className="block px-4 py-2 hover:bg-slate-50 transition-colors"
                            >
                              <div className="flex items-start gap-2">
                                {GrandchildIcon && <GrandchildIcon className="w-4 h-4 text-slate-500 mt-0.5" />}
                                <div className="flex-1">
                                  <div className={`text-slate-700 text-sm ${grandchildActive ? 'font-semibold' : 'font-normal'}`}>
                                    {grandchild.title}
                                  </div>
                                  {grandchild.description && (
                                    <div className="text-xs text-slate-400 mt-0.5">{grandchild.description}</div>
                                  )}
                                </div>
                              </div>
                            </GrandchildLinkComponent>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    // Simple nav item
    return (
      <div key={item.id} className="relative h-full flex items-center">
        <LinkComponent 
          {...linkProps}
          className={baseClassName}
          style={isTopNav ? {} : { fontFamily: 'Poppins, sans-serif' }}
        >
          {Icon && <Icon className="w-4 h-4" />}
          {item.title}
        </LinkComponent>

        {/* Active indicator - positioned at bottom of nav container */}
        {!isTopNav && active && (
          <div 
            className="absolute left-0 right-0 h-[5px]"
            style={{
              bottom: '-33px',
              background: navIndicatorGradient
            }}
          />
        )}
      </div>
    );
  };

  // Render social icons for mobile menu
  const renderSocialIcons = () => {
    if (!socialIcons) return null;

    const icons = [];
    
    if (socialIcons.linkedin?.enabled && socialIcons.linkedin?.url) {
      icons.push(
        <a
          key="linkedin"
          href={socialIcons.linkedin.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center hover:bg-slate-200 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#5C0085">
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
          </svg>
        </a>
      );
    }
    
    if (socialIcons.twitter?.enabled && socialIcons.twitter?.url) {
      icons.push(
        <a
          key="twitter"
          href={socialIcons.twitter.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center hover:bg-slate-200 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#5C0085">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
      );
    }
    
    if (socialIcons.facebook?.enabled && socialIcons.facebook?.url) {
      icons.push(
        <a
          key="facebook"
          href={socialIcons.facebook.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center hover:bg-slate-200 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#5C0085">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
          </svg>
        </a>
      );
    }
    
    if (socialIcons.instagram?.enabled && socialIcons.instagram?.url) {
      icons.push(
        <a
          key="instagram"
          href={socialIcons.instagram.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center hover:bg-slate-200 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#5C0085">
            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
          </svg>
        </a>
      );
    }
    
    if (socialIcons.youtube?.enabled && socialIcons.youtube?.url) {
      icons.push(
        <a
          key="youtube"
          href={socialIcons.youtube.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center hover:bg-slate-200 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#5C0085">
            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
          </svg>
        </a>
      );
    }

    if (icons.length === 0) return null;

    return (
      <div className="flex items-center justify-center gap-3 py-4 border-t border-slate-200">
        {icons}
      </div>
    );
  };

  return (
    <>
      <header className="bg-white shadow-sm sticky top-0 z-40 relative">
        {/* Desktop: Overlapping Logo */}
        <Link 
          to="/"
          className="mt-4 absolute z-50 hidden lg:block"
          style={{
            top: '0',
            left: 'max(1rem, calc((100vw - 80rem) / 2))',
            transform: 'translateY(-10px)'
          }}
          data-testid="link-header-logo"
        >
          <img
            src={headerLogoUrl}
            alt={tenantName}
            style={{
              width: headerLogoWidth ? `${headerLogoWidth}px` : 'auto',
              height: headerLogoHeight ? `${headerLogoHeight}px` : '158px',
              maxWidth: headerLogoWidth ? `${headerLogoWidth}px` : 'none',
              maxHeight: headerLogoHeight ? `${headerLogoHeight}px` : '158px',
              objectFit: 'contain'
            }}
          />
        </Link>

        {/* Mobile: Floating Logo in white box with shadow */}
        <Link 
          to="/"
          className="absolute z-50 lg:hidden bg-white rounded shadow-md p-2"
          style={{
            top: '8px',
            left: '12px'
          }}
          data-testid="link-header-logo-mobile-floating"
        >
          <img
            src={headerLogoUrl}
            alt={tenantName}
            style={{
              height: headerLogoHeight ? `${Math.min(parseInt(headerLogoHeight), 96)}px` : '96px',
              width: 'auto',
              maxWidth: headerLogoWidth ? `${headerLogoWidth}px` : 'none',
              objectFit: 'contain'
            }}
          />
        </Link>

        {/* Top Row - Gradient Header (Desktop only) */}
        <div
          className="py-2 relative hidden lg:block"
          style={{
            background: topBarGradient
          }}
        >
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex justify-end items-center">
              <div className="flex items-center gap-6">
                {/* Dynamic Top Nav Items */}
                {navItems.topNav?.map(item => renderNavItem(item, true))}

                {/* Static Items - Login / Member Area */}
                <Link
                  to={isLoggedIn ? createPageUrl(memberLandingPage) : createPageUrl('Home')}
                  className="flex items-center gap-1 text-white hover:opacity-80 transition-opacity text-sm font-semibold"
                >
                  <User className="w-4 h-4" />
                  <span>{isLoggedIn ? 'Member Area' : 'Login'}</span>
                </Link>

                {/* Search */}
                <div className="relative">
                  <button
                    onClick={() => setSearchOpen(!searchOpen)}
                    className="flex items-center gap-2 text-white hover:opacity-80 transition-opacity text-sm font-semibold"
                    data-testid="button-search-toggle"
                  >
                    <Search className="w-4 h-4" />
                    <span>Search</span>
                  </button>

                  {searchOpen && (
                    <div className="absolute top-full right-0 mt-2 w-96 bg-white rounded-lg shadow-xl border border-slate-200 z-50">
                      <div className="p-3 border-b border-slate-100">
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            {isSearching ? (
                              <Loader2 className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
                            ) : (
                              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                            )}
                            <Input
                              type="text"
                              placeholder="Search events, articles, news, resources..."
                              className="pl-10 pr-10"
                              autoFocus
                              value={searchQuery}
                              onChange={(e) => handleSearch(e.target.value)}
                              data-testid="input-search"
                            />
                            {searchQuery && (
                              <button
                                onClick={() => handleSearch('')}
                                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              setSearchOpen(false);
                              setSearchQuery('');
                              setSearchResults([]);
                            }}
                            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
                            data-testid="button-close-search"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                      
                      {searchQuery.length >= 2 && (
                        <div className="max-h-80 overflow-y-auto">
                          {searchResults.length > 0 ? (
                            <>
                              {searchResults.map((result) => {
                                const TypeIcon = typeIconMap[result.type] || FileText;
                                return (
                                  <button
                                    key={`${result.type}-${result.id}`}
                                    onClick={() => handleResultClick(result.url)}
                                    className="w-full px-4 py-3 flex items-start gap-3 hover:bg-slate-50 transition-colors text-left border-b border-slate-50 last:border-0"
                                    data-testid={`search-result-${result.type}-${result.id}`}
                                  >
                                    <div className="flex-shrink-0 w-8 h-8 bg-slate-100 rounded flex items-center justify-center">
                                      <TypeIcon className="w-4 h-4 text-slate-600" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs font-medium text-purple-600 uppercase">{getTypeLabel(result.type)}</span>
                                      </div>
                                      <p className="font-medium text-slate-900 truncate">{result.title}</p>
                                      {result.description && (
                                        <p className="text-sm text-slate-500 line-clamp-1">{result.description}</p>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}
                              <button
                                onClick={handleViewAllResults}
                                className="w-full px-4 py-3 text-center text-sm font-medium text-purple-600 hover:bg-slate-50 transition-colors"
                                data-testid="button-view-all-results"
                              >
                                View all results
                              </button>
                            </>
                          ) : !isSearching && (
                            <div className="px-4 py-8 text-center text-slate-500">
                              <Search className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                              <p className="text-sm">No results found for "{searchQuery}"</p>
                            </div>
                          )}
                        </div>
                      )}
                      
                      {searchQuery.length < 2 && (
                        <div className="px-4 py-6 text-center text-slate-400 text-sm">
                          Type at least 2 characters to search
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Logout Icon */}
                {isLoggedIn && (
                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-2 text-white hover:opacity-80 transition-opacity text-sm font-semibold"
                    title="Logout"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                )}

                {/* Social Media Icons */}
                {socialIcons && (
                  <div className="flex items-center gap-2">
                    {socialIcons.linkedin?.enabled && socialIcons.linkedin?.url && (
                      <a
                        href={socialIcons.linkedin.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-7 h-7 bg-white rounded flex items-center justify-center hover:opacity-80 transition-opacity"
                      >
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="#5C0085">
                          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                        </svg>
                      </a>
                    )}
                    {socialIcons.twitter?.enabled && socialIcons.twitter?.url && (
                      <a
                        href={socialIcons.twitter.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-7 h-7 bg-white rounded flex items-center justify-center hover:opacity-80 transition-opacity"
                      >
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="#5C0085">
                          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                        </svg>
                      </a>
                    )}
                    {socialIcons.facebook?.enabled && socialIcons.facebook?.url && (
                      <a
                        href={socialIcons.facebook.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-7 h-7 bg-white rounded flex items-center justify-center hover:opacity-80 transition-opacity"
                      >
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="#5C0085">
                          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                        </svg>
                      </a>
                    )}
                    {socialIcons.instagram?.enabled && socialIcons.instagram?.url && (
                      <a
                        href={socialIcons.instagram.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-7 h-7 bg-white rounded flex items-center justify-center hover:opacity-80 transition-opacity"
                      >
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="#5C0085">
                          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                        </svg>
                      </a>
                    )}
                    {socialIcons.youtube?.enabled && socialIcons.youtube?.url && (
                      <a
                        href={socialIcons.youtube.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-7 h-7 bg-white rounded flex items-center justify-center hover:opacity-80 transition-opacity"
                      >
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="#5C0085">
                          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                        </svg>
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Row - Main Navigation */}
        <div className="bg-white border-b border-slate-200">
          <div className="max-w-7xl mx-auto px-4 py-3 lg:py-6">
            <div className="flex justify-between items-center h-full">
              {/* Mobile spacer for floating logo */}
              <div className="lg:hidden" style={{ width: '120px' }}></div>
              
              {/* Desktop spacer for logo */}
              <div className="hidden lg:block" style={{ width: '210px' }}></div>
              
              {/* Desktop Navigation */}
              <nav className="hidden lg:flex items-center gap-8 h-full">
                {/* Dynamic Main Nav Items */}
                {navItems.mainNav?.map(item => renderNavItem(item, false))}

                {/* Static Events Button */}
                <Link to="/events">
                  <Button 
                    className="text-white font-bold hover:opacity-90 transition-opacity px-6 py-5 rounded-none" 
                    style={{ 
                      fontFamily: 'Poppins, sans-serif',
                      background: BUTTON_ACCENT_GRADIENT
                    }}
                  >
                    Events
                    <ArrowUpRight className="ml-0.5 w-5 h-5" strokeWidth={2.5} />
                  </Button>
                </Link>
              </nav>

              {/* Mobile Menu Button */}
              <button 
                className="lg:hidden p-2 -mr-2"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open menu"
              >
                <Menu className="w-6 h-6 text-slate-900" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Menu - rendered via portal to escape transformed ancestors */}
      {typeof document !== 'undefined' && createPortal(
        <div 
          className={`fixed inset-0 z-50 overflow-hidden lg:hidden ${
            mobileMenuOpen ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
        >
          {/* Backdrop */}
          <div 
            className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${
              mobileMenuOpen ? 'opacity-100' : 'opacity-0'
            }`}
            onClick={() => setMobileMenuOpen(false)}
          />

          {/* Drawer Panel - slides in from right */}
          <div 
            className={`absolute top-0 right-0 h-full w-[90vw] bg-white transform transition-transform duration-300 ease-in-out ${
              mobileMenuOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
        {/* Mobile Menu Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <Link 
            to="/" 
            onClick={() => setMobileMenuOpen(false)}
            data-testid="link-mobile-drawer-logo"
          >
            <img
              src={headerLogoUrl}
              alt={tenantName}
              style={{
                height: '40px',
                width: 'auto',
                maxWidth: headerLogoWidth ? `${Math.min(parseInt(headerLogoWidth), 150)}px` : '150px',
                objectFit: 'contain'
              }}
            />
          </Link>
          <button 
            onClick={() => setMobileMenuOpen(false)}
            className="p-2 -mr-2 hover:bg-slate-100 rounded-lg transition-colors"
            aria-label="Close menu"
          >
            <X className="w-6 h-6 text-slate-900" />
          </button>
        </div>

        {/* Mobile Menu Content */}
        <div className="flex flex-col h-[calc(100%-73px)] overflow-y-auto">
          {/* Login/Logout - at the top */}
          <div className="px-4 py-3 border-b border-slate-200">
            {isLoggedIn ? (
              <div className="flex items-center justify-between gap-3">
                <Link
                  to={createPageUrl(memberLandingPage)}
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-2 py-2 text-slate-900 font-medium"
                >
                  <User className="w-5 h-5 text-slate-600" />
                  Member Area
                </Link>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 py-2 text-red-600 font-medium"
                >
                  <LogOut className="w-5 h-5" />
                  Logout
                </button>
              </div>
            ) : (
              <Link
                to={createPageUrl('Home')}
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-2 py-2 text-slate-900 font-medium"
              >
                <User className="w-5 h-5 text-slate-600" />
                Login
              </Link>
            )}
          </div>

          {/* Search Bar */}
          <div className="p-4 border-b border-slate-200">
            <div className="relative">
              {isMobileSearching ? (
                <Loader2 className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
              ) : (
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
              )}
              <Input
                type="text"
                placeholder="Search events, articles, news..."
                className="pl-10 pr-10 w-full"
                value={mobileSearchQuery}
                onChange={(e) => handleMobileSearch(e.target.value)}
                data-testid="input-mobile-search"
              />
              {mobileSearchQuery && (
                <button
                  onClick={() => handleMobileSearch('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            
            {/* Mobile Search Results */}
            {mobileSearchQuery.length >= 2 && (
              <div className="mt-3 max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                {mobileSearchResults.length > 0 ? (
                  <>
                    {mobileSearchResults.map((result) => {
                      const TypeIcon = typeIconMap[result.type] || FileText;
                      return (
                        <button
                          key={`mobile-${result.type}-${result.id}`}
                          onClick={() => handleMobileResultClick(result.url)}
                          className="w-full px-3 py-2.5 flex items-start gap-2 hover:bg-slate-50 transition-colors text-left border-b border-slate-100 last:border-0"
                          data-testid={`mobile-search-result-${result.type}-${result.id}`}
                        >
                          <div className="flex-shrink-0 w-6 h-6 bg-slate-100 rounded flex items-center justify-center">
                            <TypeIcon className="w-3 h-3 text-slate-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium text-purple-600 uppercase">{getTypeLabel(result.type)}</span>
                            <p className="font-medium text-slate-900 text-sm truncate">{result.title}</p>
                          </div>
                        </button>
                      );
                    })}
                    <button
                      onClick={() => {
                        setMobileMenuOpen(false);
                        navigate(`/search?q=${encodeURIComponent(mobileSearchQuery.trim())}`);
                      }}
                      className="w-full px-3 py-2 text-center text-sm font-medium text-purple-600 hover:bg-slate-50 transition-colors"
                      data-testid="button-mobile-view-all-results"
                    >
                      View all results
                    </button>
                  </>
                ) : !isMobileSearching && (
                  <div className="px-3 py-4 text-center text-slate-500 text-sm">
                    No results found
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Navigation Items */}
          <div className="flex-1 py-2">
            {/* Top Nav Items */}
            {navItems.topNav?.map(item => renderMobileNavItem(item))}
            
            {/* Main Nav Items */}
            {navItems.mainNav?.map(item => renderMobileNavItem(item))}
            
            {/* Events Button */}
            <Link 
              to="/events"
              onClick={() => setMobileMenuOpen(false)}
            >
              <div 
                className="mx-4 my-2 py-3 px-4 text-white font-bold flex items-center justify-center gap-2"
                style={{ 
                  background: BUTTON_ACCENT_GRADIENT
                }}
              >
                Events
                <ArrowUpRight className="w-4 h-4" strokeWidth={2.5} />
              </div>
            </Link>
          </div>

        </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
