
import React, { useEffect, useState, useRef, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Calendar, User, CreditCard, LogOut, Ticket, Wallet, Shield, Users, Settings, Sparkles, ShoppingCart, History, BarChart3, Briefcase, FileEdit, Image, FileText, AtSign, FolderTree, Square, Trophy, BookOpen, Mail, MousePointer2, Building, Download, Upload, HelpCircle, Menu, ChevronRight, Video, Bell, Newspaper, PenLine, Home, Globe, Folder, MessageSquare, Star, Heart, Eye, Link as LinkIcon, ExternalLink, Tag, Award, Bookmark, Clock, Search, Phone, MapPin, Music, Camera, Mic, Headphones, Tv, Radio, Rss, Share2, Gift, Zap, Target, Flag, Layers, Grid, List, Layout as LayoutIcon, Monitor, Smartphone, Tablet, Laptop, Server, Database, Cloud, Lock, Key, UserCheck, UserPlus, UserMinus, Users2, MessageCircle, Send, Inbox, Archive, Navigation } from "lucide-react";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { isResourceExcluded } from "@/lib/roleVisibility";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarHeader,
  SidebarFooter,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import PublicLayout from "@/components/layouts/PublicLayout";
import BarePublicLayout from "@/components/layouts/BarePublicLayout";
import FloaterDisplay from "@/components/floaters/FloaterDisplay";
import NewsTickerBar from "@/components/news/NewsTickerBar";
import PortalHeroBanner from "@/components/banners/PortalHeroBanner";
import PageBannerDisplay from "@/components/banners/PageBannerDisplay";
import NextEventCountdown from "@/components/navigation/NextEventCountdown";
import { BannerProvider } from "@/contexts/BannerContext";
import { usePendingPurchaseOrders } from "@/hooks/usePendingPurchaseOrders";

import { useQuery } from '@tanstack/react-query';
import { base44 } from "@/api/base44Client";




const navigationItems = [
  {
    title: "Buy Tickets",
    url: createPageUrl("BuyProgramTickets"),
    icon: ShoppingCart,
    featureId: "page_BuyProgramTickets"
  },
  {
    title: "Browse Events",
    url: createPageUrl("Events"),
    icon: Calendar,
    featureId: "page_Events"
  },
  {
    title: "Bookings",
    url: createPageUrl("Bookings"),
    icon: CreditCard,
    featureId: "page_Bookings"
  },
  {
    title: "My Tickets",
    url: createPageUrl("MyTickets"),
    icon: Ticket,
    featureId: "page_MyTickets"
  },
  {
    title: "Balances",
    url: createPageUrl("Balances"),
    icon: Wallet,
    featureId: "page_Balances"
  },
  {
    title: "History",
    url: createPageUrl("History"),
    icon: History,
    featureId: "page_History"
  },
  {
    title: "Team",
    url: createPageUrl("Team"),
    icon: Users,
    featureId: "page_Team"
  },
  {
    title: "Member Directory",
    url: createPageUrl("MemberDirectory"),
    icon: BookOpen,
    featureId: "page_MemberDirectory"
  },
  {
    title: "Organisation Directory",
    url: createPageUrl("OrganisationDirectory"),
    icon: Building,
    featureId: "page_OrganisationDirectory"
  },
  {
    title: "Resources",
    url: createPageUrl("Resources"),
    icon: Sparkles,
    featureId: "page_Resources"
  },
  {
    title: "Articles",
    url: createPageUrl("Articles"),
    icon: FileText,
    featureId: "page_Articles",
    isDynamicArticles: true
  },
  {
    title: "News",
    url: createPageUrl("News"),
    icon: FileText,
    featureId: "page_user_News"
  },
  {
    title: "My Job Postings",
    url: createPageUrl("MyJobPostings"),
    icon: Briefcase,
    featureId: "page_MyJobPostings"
  },
  {
    title: "About Me",
    url: "/about-me",
    icon: Settings,
    featureId: "user.about-me"
  },
  {
    title: "Support",
    url: createPageUrl("Support"),
    icon: HelpCircle,
    featureId: "page_Support"
  },
  ];

const adminNavigationItems = [
  {
    title: "News",
    icon: FileText,
    featureId: "page_NewsAdmin",
    subItems: [
      {
        title: "Settings",
        url: createPageUrl("NewsSettings"),
        featureId: "page_NewsSettings"
      }
    ]
  },
  {
    title: "Articles",
    icon: FileText,
    featureId: "page_ArticlesAdmin",
    isDynamicArticleSection: true,
    subItems: [
      {
        title: "Settings",
        url: createPageUrl("ArticlesSettings"),
        featureId: "page_ArticlesSettings"
      }
    ]
  },
  {
    title: "Role Management",
    icon: Shield,
    featureId: "page_RoleManagement",
    subItems: [
      {
        title: "Manage Roles",
        url: createPageUrl("RoleManagement"),
        featureId: "page_RoleManagement"
      },
      {
        title: "Access Configuration",
        url: createPageUrl("RoleAccessConfigManagement"),
        featureId: "page_RoleAccessConfigManagement"
      }
    ]
  },
  {
    title: "Organisation Preferences",
    url: createPageUrl("OrganisationPreferences"),
    icon: Building,
    featureId: "page_admin_OrganisationPreferences"
  },
  {
    title: "Assign Member Roles",
    url: createPageUrl("MemberRoleAssignment"),
    icon: Users,
    featureId: "page_MemberRoleAssignment"
  },
  {
    title: "Team Members",
    url: createPageUrl("TeamMemberManagement"),
    icon: Users,
    featureId: "page_TeamMemberManagement"
  },
  {
    title: "Member Handle Management",
    url: createPageUrl("MemberHandleManagement"),
    icon: AtSign,
    featureId: "page_MemberHandleManagement"
  },
  {
    title: "Member Directory Settings",
    url: createPageUrl("MemberDirectorySettings"),
    icon: Users,
    featureId: "page_MemberDirectorySettings"
  },
  {
    title: "Discount Codes",
    url: createPageUrl("DiscountCodeManagement"),
    icon: Ticket,
    featureId: "page_DiscountCodeManagement"
  },
  {
    title: "Event Settings",
    url: createPageUrl("EventSettings"),
    icon: Settings,
    featureId: "page_EventSettings"
  },
  {
    title: "Ticket Sales Analytics",
    url: createPageUrl("TicketSalesAnalytics"),
    icon: BarChart3,
    featureId: "page_TicketSalesAnalytics"
  },
  {
    title: "Award Management",
    url: createPageUrl("AwardManagement"),
    icon: Trophy,
    featureId: "page_AwardManagement"
  },
  {
    title: "Category Management",
    url: createPageUrl("CategoryManagement"),
    icon: FolderTree,
    featureId: "page_CategoryManagement"
  },
  {
    title: "Category Setup",
    url: createPageUrl("ResourceSettings"),
    icon: FolderTree,
    featureId: "page_ResourceSettings"
  },
  {
    title: "Resource Management",
    icon: Sparkles,
    featureId: "page_ResourcesAdmin",
    subItems: [
      {
        title: "Resources",
        url: createPageUrl("ResourceManagement"),
        featureId: "page_ResourceManagement"
      },
      {
        title: "Tags",
        url: createPageUrl("TagManagement"),
        featureId: "page_TagManagement"
      },
      {
        title: "Settings",
        url: createPageUrl("ResourceSettings"),
        featureId: "page_ResourceSettings"
      },
      {
        title: "File Repository",
        url: createPageUrl("FileManagement"),
        featureId: "page_FileManagement"
      }
    ]
  },
  {
    title: "Job Board Management",
    icon: Briefcase,
    featureId: "page_JobBoardAdmin",
    subItems: [
      {
        title: "Job Postings",
        url: createPageUrl("JobPostingManagement"),
        featureId: "page_JobPostingManagement"
      },
      {
        title: "Settings",
        url: createPageUrl("JobBoardSettings"),
        featureId: "page_JobBoardSettings"
      }
    ]
  },
  {
    title: "Page Builder",
    icon: FileEdit,
    featureId: "page_PageBuilder",
    subItems: [
      {
        title: "Pages",
        url: createPageUrl("IEditPageManagement"),
        featureId: "page_IEditPageManagement"
      },
      {
        title: "Element Templates",
        url: createPageUrl("IEditTemplateManagement"),
        featureId: "page_IEditTemplateManagement"
      },
      {
        title: "Page Banners",
        url: createPageUrl("PageBannerManagement"),
        featureId: "page_PageBannerManagement"
      },
      {
        title: "Navigation Items",
        url: createPageUrl("NavigationManagement"),
        featureId: "page_NavigationManagement"
      },
      {
        title: "Buttons",
        url: createPageUrl("ButtonElements"),
        featureId: "page_ButtonElements"
      },
      {
        title: "Button Styles",
        url: createPageUrl("ButtonStyleManagement"),
        featureId: "page_ButtonStyleManagement"
      },
      {
        title: "Wall of Fame",
        url: createPageUrl("WallOfFameManagement"),
        featureId: "page_WallOfFameManagement"
      },
      {
        title: "Installed Fonts",
        url: createPageUrl("InstalledFonts"),
        featureId: "page_InstalledFonts"
      },
      {
        title: "Page Visibility",
        url: createPageUrl("PageVisibilitySettings"),
        featureId: "page_PageVisibilitySettings"
      }
    ]
  },
  {
    title: "Forms",
    icon: FileText,
    featureId: "page_FormsAdmin",
    subItems: [
      {
        title: "Form Management",
        url: createPageUrl("FormManagement"),
        featureId: "page_FormManagement"
      },
      {
        title: "View Submissions",
        url: createPageUrl("FormSubmissions"),
        featureId: "page_FormSubmissions"
      }
    ]
  },
  {
    title: "Floater Management",
    url: createPageUrl("FloaterManagement"),
    icon: MousePointer2,
    featureId: "page_FloaterManagement"
  },
  {
    title: "Team Invite Settings",
    url: createPageUrl("TeamInviteSettings"),
    icon: Mail,
    featureId: "page_TeamInviteSettings"
  },
  {
    title: "Data Export",
    url: createPageUrl("DataExport"),
    icon: Download,
    featureId: "page_DataExport"
  },
  {
    title: "CSV Import",
    url: createPageUrl("ImportManager"),
    icon: Upload,
    featureId: "page_ImportManager"
  },
  {
    title: "Site Map",
    url: createPageUrl("SiteMap"),
    icon: FileText,
    featureId: "page_SiteMap"
  },
  {
    title: "Support Management",
    url: createPageUrl("SupportManagement"),
    icon: HelpCircle,
    featureId: "page_SupportManagement"
  },
  {
    title: "Portal Navigation",
    url: createPageUrl("PortalNavigationManagement"),
    icon: Menu,
    featureId: "page_PortalNavigationManagement"
  },
  {
    title: "Tour Management",
    url: createPageUrl("TourManagement"),
    icon: Sparkles,
    featureId: "page_TourManagement"
  },
  {
    title: "Zoom Webinars",
    url: createPageUrl("ZoomWebinarProvisioning"),
    icon: Video,
    featureId: "page_ZoomWebinarProvisioning"
  },
  ];



export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const { getArticleListUrl, getMyArticlesUrl, articleDisplayName, isCustomSlug, urlSlug, publicSlug, viewSlug, editorSlug, mySlug } = useArticleUrl();
  
  // Initialize from sessionStorage immediately to prevent flicker
  const [memberInfo, setMemberInfo] = useState(() => {
    const stored = localStorage.getItem('agcas_member');
    return stored ? JSON.parse(stored) : null;
  });
  const [organizationInfo, setOrganizationInfo] = useState(() => {
    const stored = localStorage.getItem('agcas_organization');
    return stored ? JSON.parse(stored) : null;
  });

  const mainContentRef = React.useRef(null);
  const sidebarContentRef = React.useRef(null);
  const lastActivityUpdateRef = React.useRef(null);
  
  // Mobile navigation menu state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const { hasPendingPOs, pendingPOCount, isLoading: pendingPOsLoading } = usePendingPurchaseOrders();
  
  console.log('[Layout] hasPendingPOs:', hasPendingPOs, 'count:', pendingPOCount, 'isLoading:', pendingPOsLoading);

  // Fetch global border radius setting
  const DEFAULT_BORDER_RADIUS = '8px';

const { data: borderRadiusSetting = DEFAULT_BORDER_RADIUS } = useQuery({
  queryKey: ['borderRadiusSetting'],
  queryFn: async () => {
    try {
      const data = await base44.entities.SystemSettings.list({ 
        filter: { setting_key: 'global_border_radius' } 
      });
      if (data && data.length > 0 && data[0].setting_value) {
        return String(data[0].setting_value);
      }
      return DEFAULT_BORDER_RADIUS;
    } catch (error) {
      console.error('Error loading SystemSettings:', error);
      return DEFAULT_BORDER_RADIUS;
    }
  }
});

// Fetch portal logo settings including home page slug
const { data: portalLogoSettings } = useQuery({
  queryKey: ['portal-logo-settings'],
  queryFn: async () => {
    try {
      const data = await base44.entities.SystemSettings.list();
      const logoUrl = data.find(s => s.setting_key === 'portal_logo_url')?.setting_value || '';
      const logoHeight = data.find(s => s.setting_key === 'portal_logo_height')?.setting_value || 'medium';
      const logoLink = data.find(s => s.setting_key === 'portal_logo_link')?.setting_value || '';
      const homePageSlug = data.find(s => s.setting_key === 'public_home_page_slug')?.setting_value || '';
      return { logoUrl, logoHeight, logoLink, homePageSlug };
    } catch (error) {
      console.error('Error loading portal logo settings:', error);
      return { logoUrl: '', logoHeight: 'medium', logoLink: '', homePageSlug: '' };
    }
  }
});

// Compute logo height in pixels
const logoHeightPx = useMemo(() => {
  const height = portalLogoSettings?.logoHeight || 'medium';
  switch (height) {
    case 'small': return 40;
    case 'large': return 80;
    default: return 60;
  }
}, [portalLogoSettings?.logoHeight]);

// Compute default logo link - use explicit link, then home page slug, then Events
const defaultLogoHref = useMemo(() => {
  if (portalLogoSettings?.logoLink) {
    return portalLogoSettings.logoLink;
  }
  if (portalLogoSettings?.homePageSlug) {
    return `/${portalLogoSettings.homePageSlug}`;
  }
  return createPageUrl('Events');
}, [portalLogoSettings?.logoLink, portalLogoSettings?.homePageSlug]);


  // Fetch member record for profile photo
const { data: memberRecord } = useQuery({
  queryKey: ['memberRecord', memberInfo && memberInfo.email],
  enabled: !!(memberInfo && memberInfo.email),
  refetchOnMount: false,
  queryFn: async () => {
    try {
      const data = await base44.entities.Member.list({ 
        filter: { email: memberInfo.email } 
      });
      return data && data.length > 0 ? data[0] : null;
    } catch (error) {
      console.error('Error loading memberRecord:', error);
      return null;
    }
  },
});

// Fetch member role
const { data: memberRole } = useQuery({
  queryKey: ['memberRole', memberInfo && memberInfo.role_id],
  enabled: !!(memberInfo && memberInfo.role_id),
  refetchOnMount: false,
  queryFn: async () => {
    if (!memberInfo || !memberInfo.role_id) return null;
    try {
      const data = await base44.entities.Role.get(memberInfo.role_id);
      return data || null;
    } catch (error) {
      console.error('Error loading memberRole:', error);
      return null;
    }
  },
});

// Fetch dynamic navigation items from database
const { data: dynamicNavItems = [] } = useQuery({
  queryKey: ['portal-menu'],
  refetchOnMount: false,
  queryFn: async () => {
    try {
      const data = await base44.entities.PortalMenu.list({ 
        sort: { display_order: 'asc' } 
      });
      return data || [];
    } catch (error) {
      console.error('Error loading PortalMenu:', error);
      return [];
    }
  },
});

// Fetch page visibility settings from system_settings
const { data: pageVisibilitySettings = {}, isFetched: visibilitySettingsFetched } = useQuery({
  queryKey: ['page-visibility-settings'],
  refetchOnMount: false,
  staleTime: 60000,
  queryFn: async () => {
    try {
      const data = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'page_visibility_settings' }
      });
      if (data?.[0]?.setting_value) {
        try {
          const parsed = JSON.parse(data[0].setting_value);
          // Validate it's an object with valid visibility values
          if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
          }
        } catch (parseError) {
          console.error('Error parsing page visibility settings JSON:', parseError);
        }
      }
      return {};
    } catch (error) {
      console.error('Error loading page visibility settings:', error);
      return {};
    }
  },
});

// Helper to get page visibility from dynamic settings or fallback to default
const getPageVisibility = (pageName) => {
  // First check dynamic settings
  if (pageVisibilitySettings[pageName]) {
    return pageVisibilitySettings[pageName];
  }
  // Fallback to default behavior based on hardcoded arrays
  if (publicPages.includes(pageName)) return 'public';
  if (hybridPages.includes(pageName)) return 'hybrid';
  return 'portal';
};

// Map page names to portal page identifiers for banner matching
// These identifiers must match the PORTAL_PAGES values in PageBannerManagement.jsx
const pageToPortalPageMap = {
  'Events': 'portal_events',
  'Bookings': 'portal_bookings',
  'MyTickets': 'portal_my_tickets',
  'BuyProgramTickets': 'portal_buy_tickets',
  'MemberDirectory': 'portal_member_directory',
  'OrganisationDirectory': 'portal_org_directory',
  'Resources': 'portal_resources',
  'Articles': 'portal_articles',
  'Team': 'portal_team',
  'Balances': 'portal_balances',
  'History': 'portal_history',
  'Profile': 'portal_profile',
  'MyOrganisation': 'portal_my_organisation',
  'JobBoard': 'portal_job_board',
  'News': 'portal_news',
  'NewsView': 'portal_news_view',
  'MyJobPostings': 'portal_my_job_postings',
  'Preferences': 'portal_about_me',
  'about-me': 'portal_about_me',
  'Support': 'portal_support',
  'Dashboard': 'portal_dashboard'
};

// Get the portal page identifier for the current page
// Handle dynamic article routes (e.g., /blogs when display name is "Blogs")
const getPortalPageId = () => {
  // First check if there's a direct mapping
  if (pageToPortalPageMap[currentPageName]) {
    return pageToPortalPageMap[currentPageName];
  }
  
  // If currentPageName is "_DynamicPage", check if the path matches a custom article route
  if (currentPageName === '_DynamicPage' && isCustomSlug && urlSlug) {
    const pathname = location.pathname.toLowerCase();
    
    // Check if the path matches the custom article slug patterns
    if (pathname === `/${urlSlug}`) {
      return 'portal_articles';
    }
    if (pathname === `/my${urlSlug}`) {
      return 'portal_my_articles';
    }
  }
  
  return null;
};

const currentPortalPageId = getPortalPageId();

// Debug logging for banner matching
console.log('[Layout] currentPageName:', currentPageName, 'currentPortalPageId:', currentPortalPageId);

// Fetch ALL portal banners for the current page (not just the first one)
const { data: portalBanners = [] } = useQuery({
  queryKey: ['portal-banners', currentPortalPageId],
  enabled: !!currentPortalPageId,
  refetchOnMount: false,
  queryFn: async () => {
    try {
      // Fetch all active banners sorted by display_order
      const banners = await base44.entities.PageBanner.list({
        filter: { is_active: true },
        sort: { display_order: 'asc' }
      });
      
      // Debug: log all banners for troubleshooting
      if (currentPageName === 'MyOrganisation' || currentPageName === 'JobBoard') {
        console.log('[Layout] DEBUG - looking for:', currentPortalPageId);
        console.log('[Layout] All banners:', banners?.length);
        banners?.forEach(b => {
          console.log('[Layout] Banner:', b.name, 'type:', b.banner_type, 'position:', b.page_position, 'associated_pages:', b.associated_pages);
        });
      }
      
      // Find ALL banners that include this portal page in their associated_pages array
      const matchingBanners = banners?.filter(banner => 
        banner.associated_pages && 
        Array.isArray(banner.associated_pages) && 
        banner.associated_pages.includes(currentPortalPageId)
      ) || [];
      
      console.log('[Layout] Matched banners for', currentPageName, ':', matchingBanners.length);
      return matchingBanners;
    } catch (error) {
      console.error('Error loading portal banners:', error);
      return [];
    }
  },
});

// Split banners by page_position
const topBanners = useMemo(() => 
  portalBanners.filter(b => !b.page_position || b.page_position === 'top'),
  [portalBanners]
);

const belowFirstElementBanners = useMemo(() => 
  portalBanners.filter(b => b.page_position === 'below_first_element'),
  [portalBanners]
);

// For backward compatibility - check if any banner exists for hasBanner state
const portalBanner = topBanners[0] || null;

// Get the layout context to update banner status and share member/org info
// Note: isAdmin removed - access control now uses isFeatureExcluded() exclusively
const { 
  setHasBanner, 
  setPortalBanner,
  setMemberInfo: setContextMemberInfo,
  setOrganizationInfo: setContextOrganizationInfo,
  setMemberRole: setContextMemberRole,
  setIsFeatureExcluded: setContextIsFeatureExcluded,
  setRefreshOrganizationInfo: setContextRefreshOrganizationInfo,
  setReloadMemberInfo: setContextReloadMemberInfo,
} = useLayoutContext();

// Update the context whenever the portal banner changes
useEffect(() => {
  setHasBanner(!!portalBanner);
  setPortalBanner(portalBanner || null);
}, [portalBanner, setHasBanner, setPortalBanner]);

// Update the context with member and organization info for child pages
useEffect(() => {
  setContextMemberInfo(memberInfo);
}, [memberInfo, setContextMemberInfo]);

useEffect(() => {
  setContextOrganizationInfo(organizationInfo);
}, [organizationInfo, setContextOrganizationInfo]);

useEffect(() => {
  setContextMemberRole(memberRole);
}, [memberRole, setContextMemberRole]);

  const publicPages = ["Home", "TestLogin", "Login", "ResetPassword", "UnpackedInternationalEmployability", "PublicEvents", "PublicAbout", "PublicContact", "PublicResources", "PublicArticles", "PublicNews", "sharon", "content", "Search", "search", "SearchResults"];
  
  // Hybrid pages that work both as public (for non-members) and portal (for members)
  // "_DynamicPage" is a special marker for CMS pages (e.g. /homely) that handle their own auth
  // "HomePageRedirect" handles the root path "/" and can show either a public IEdit page or Events
  const hybridPages = ["PostJob", "ArticleView", "NewsView", "icontent", "ViewPage", "OrganisationDirectory", "JobBoard", "JobDetails", "JobPostSuccess", "_DynamicPage", "HomePageRedirect", "Events", "EventDetails", "FormView"];
  
  const adminPages = ["AdminSetup", "RoleManagement", "RoleAccessConfigManagement", "MemberRoleAssignment", "TeamMemberManagement", "DiscountCodeManagement", "EventSettings", "TicketSalesAnalytics", "ResourceSettings", "ResourceManagement", "TagManagement", "ResourceAuthorSettings", "TourManagement", "FileManagement", "JobPostingManagement", "JobBoardSettings", "IEditPageManagement", "IEditTemplateManagement", "PageBannerManagement", "NavigationManagement", "MemberHandleManagement", "ButtonElements", "ButtonStyleManagement", "AwardManagement", "WallOfFameManagement", "TeamInviteSettings", "FormManagement", "FormSubmissions", "FloaterManagement", "MemberDirectorySettings", "SupportManagement", "PageVisibilitySettings"];

  // Pages that should use the bare layout (no new header/footer)
  const bareLayoutPages = ["Home", "TestLogin"];

  // Note: hasAdminNavAccess() removed - admin navigation visibility is now determined
  // purely by whether any admin items remain after feature exclusion filtering.
  // The admin section will show if filteredAdminNavigationItems.length > 0

  // Helper function to check if a feature is excluded for the current member
  // Uses the new hierarchical role visibility system
  const isFeatureExcluded = (featureId) => {
    if (!memberInfo || !featureId) return false;
    
    // Combine role-level exclusions with member-specific exclusions
    const roleExclusions = memberRole?.excluded_features || [];
    const memberExclusions = memberInfo.member_excluded_features || [];
    const allExclusions = [...new Set([...roleExclusions, ...memberExclusions])];
    
    // Use the new hierarchical checking that handles legacy IDs and module/page/feature hierarchy
    return isResourceExcluded(allExclusions, featureId);
  };

  // Mapping of page names to their correct feature IDs
  // This maps currentPageName to the feature ID used in AVAILABLE_FEATURES
  const pageToFeatureIdMap = {
    // User navigation pages use page_user_* pattern
    'BuyProgramTickets': 'page_user_BuyProgramTickets',
    'Events': 'page_user_Events',
    'Bookings': 'page_user_Bookings',
    'MyTickets': 'page_user_MyTickets',
    'Balances': 'page_user_Balances',
    'History': 'page_user_History',
    'Team': 'page_user_Team',
    'MemberDirectory': 'page_user_MemberDirectory',
    'OrganisationDirectory': 'page_user_OrganisationDirectory',
    'MyOrganisation': 'page_user_MyOrganisation',
    'Resources': 'page_user_Resources',
    'Articles': 'page_user_Articles',
    'News': 'page_user_News',
    'MyJobPostings': 'page_user_MyJobPostings',
    'Preferences': 'page_user_Preferences',
    'about-me': 'user.about-me',
    'Support': 'page_user_Support',
    // Admin navigation pages use page_admin_* pattern  
    'AdminSetup': 'page_admin_AdminSetup',
    'NewsSettings': 'page_admin_NewsSettings',
    'ArticlesSettings': 'page_admin_ArticlesSettings',
    'RoleManagement': 'page_admin_RoleManagement',
    'RoleAccessConfigManagement': 'page_admin_RoleAccessConfigManagement',
    'MemberRoleAssignment': 'page_admin_MemberRoleAssignment',
    'TeamMemberManagement': 'page_admin_TeamMemberManagement',
    'MemberHandleManagement': 'page_admin_MemberHandleManagement',
    'MemberDirectorySettings': 'page_admin_MemberDirectorySettings',
    'DiscountCodeManagement': 'page_admin_DiscountCodeManagement',
    'EventSettings': 'page_admin_EventSettings',
    'TicketSalesAnalytics': 'page_admin_TicketSalesAnalytics',
    'AwardManagement': 'page_admin_AwardManagement',
    'CategoryManagement': 'page_admin_CategoryManagement',
    'ResourceSettings': 'page_admin_ResourceSettings',
    'ResourceManagement': 'page_admin_ResourceManagement',
    'TagManagement': 'page_admin_TagManagement',
    'FileManagement': 'page_admin_FileManagement',
    'JobPostingManagement': 'page_admin_JobPostingManagement',
    'JobBoardSettings': 'page_admin_JobBoardSettings',
    'IEditPageManagement': 'page_admin_IEditPageManagement',
    'IEditTemplateManagement': 'page_admin_IEditTemplateManagement',
    'PageBannerManagement': 'page_admin_PageBannerManagement',
    'NavigationManagement': 'page_admin_NavigationManagement',
    'ButtonElements': 'page_admin_ButtonElements',
    'ButtonStyleManagement': 'page_admin_ButtonStyleManagement',
    'WallOfFameManagement': 'page_admin_WallOfFameManagement',
    'InstalledFonts': 'page_admin_InstalledFonts',
    'FormManagement': 'page_admin_FormManagement',
    'FormSubmissions': 'page_admin_FormSubmissions',
    'FloaterManagement': 'page_admin_FloaterManagement',
    'TeamInviteSettings': 'page_admin_TeamInviteSettings',
    'DataExport': 'page_admin_DataExport',
    'ImportManager': 'page_admin_ImportManager',
    'SiteMap': 'page_admin_SiteMap',
    'SupportManagement': 'page_admin_SupportManagement',
    'PortalNavigationManagement': 'page_admin_PortalNavigationManagement',
    'PortalMenuManagement': 'page_admin_PortalMenuManagement',
    'TourManagement': 'page_admin_TourManagement',
    'MemberGroupManagement': 'page_admin_MemberGroupManagement',
    'PageVisibilitySettings': 'page_admin_PageVisibilitySettings',
  };

  // Helper function to check if current page is excluded
  const isCurrentPageExcluded = () => {
    // Use the mapped feature ID if available, otherwise fall back to legacy pattern
    const pageFeatureId = pageToFeatureIdMap[currentPageName] || `page_${currentPageName}`;
    return isFeatureExcluded(pageFeatureId);
  };

  // Helper function to check if current page requires admin access
  const isCurrentPageAdminOnly = () => {
    return adminPages.includes(currentPageName);
  };

  // Function to reload member info from sessionStorage
  const reloadMemberInfo = () => {
    const storedMember = localStorage.getItem('agcas_member');
    if (storedMember) {
      const member = JSON.parse(storedMember);
      setMemberInfo(member);
      

      
      console.log('[Layout] memberInfo reloaded from sessionStorage:', member);
    }
  };

  const fetchOrganizationInfo = async (orgId, forceRefresh = false) => {
    if (!orgId) return;
    
    // Check if cached organization matches the requested orgId (skip if force refresh)
    if (!forceRefresh) {
      const cachedOrg = localStorage.getItem('agcas_organization');
      if (cachedOrg) {
        try {
          const parsed = JSON.parse(cachedOrg);
          // Validate that cached org matches the member's organization
          if (parsed.id === orgId || parsed.base44_id === orgId || parsed.zoho_account_id === orgId) {
            if (!organizationInfo || organizationInfo.id !== parsed.id) {
              setOrganizationInfo(parsed);
            }
            return;
          } else {
            // Cached org doesn't match member's org - clear it
            console.log('[Layout] Cached organization mismatch, clearing cache');
            localStorage.removeItem('agcas_organization');
          }
        } catch (e) {
          console.warn('Failed to parse cached organization, ignoring cache:', e);
          localStorage.removeItem('agcas_organization');
        }
      }
    }

    try {
      console.log('[Layout] Fetching organization from API (forceRefresh:', forceRefresh, ')');
      const orgs = await base44.entities.Organization.list({ filter: { id: orgId } });
      const org = orgs && orgs.length > 0 ? orgs[0] : null;

      if (org) {
        localStorage.setItem('agcas_organization', JSON.stringify(org));
        setOrganizationInfo(org);
        console.log('[Layout] Fetched and cached organization:', org.name, 'balances:', org.program_ticket_balances);
      } else {
        console.warn('Organization not found for id:', orgId);
      }
    } catch (error) {
      console.error('Unexpected error fetching organization:', error);
    }
  };

  // isAdmin context update removed - access control now uses isFeatureExcluded() exclusively

  // Update context with isFeatureExcluded function when memberInfo or memberRole changes
  // Uses the new hierarchical role visibility system
  useEffect(() => {
    const isFeatureExcludedFn = (featureId) => {
      if (!memberInfo || !featureId) return false;
      const roleExclusions = memberRole?.excluded_features || [];
      const memberExclusions = memberInfo.member_excluded_features || [];
      const allExclusions = [...new Set([...roleExclusions, ...memberExclusions])];
      return isResourceExcluded(allExclusions, featureId);
    };
    setContextIsFeatureExcluded(isFeatureExcludedFn);
  }, [memberInfo, memberRole, setContextIsFeatureExcluded]);

  // Update context with reloadMemberInfo function
  useEffect(() => {
    const reloadFn = () => {
      const storedMember = localStorage.getItem('agcas_member');
      if (storedMember) {
        const member = JSON.parse(storedMember);
        setMemberInfo(member);
        console.log('[Layout] memberInfo reloaded from sessionStorage via context');
      }
    };
    setContextReloadMemberInfo(reloadFn);
  }, [setContextReloadMemberInfo]);

  // Update context with refreshOrganizationInfo function
  useEffect(() => {
    const refreshFn = () => {
      if (memberInfo && !memberInfo.is_team_member) {
        // Force refresh to bypass cache and get latest data from API
        fetchOrganizationInfo(memberInfo.organization_id, true);
      }
    };
    setContextRefreshOrganizationInfo(refreshFn);
  }, [memberInfo, setContextRefreshOrganizationInfo]);

  // Get layout context for dynamic pages that need to force public layout
  const { forcePublicLayout } = useLayoutContext();

  // Check if page is truly public (not hybrid with member logged in)
  const isPublicPage = () => {
    // If a dynamic page signals it should use public layout, respect that
    if (forcePublicLayout) {
      return true;
    }
    
    // Get dynamic visibility for the current page
    const visibility = getPageVisibility(currentPageName);
    
    if (visibility === 'public') {
      return true;
    }
    
    // For hybrid pages, check if member is logged in
    if (visibility === 'hybrid') {
      const storedMember = localStorage.getItem('agcas_member');
      return !storedMember; // Public if no member logged in
    }
    
    return false;
  };

  useEffect(() => {
    // Check server session first for multi-tab persistence
    const checkServerSession = async () => {
      try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (response.ok) {
          const member = await response.json();
          // API returns member directly (not wrapped in data.member)
          if (member && member.id) {
            console.log('[Layout] Server session found:', member.email);
            // Sync server session to sessionStorage for backwards compatibility
            const sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            const memberData = { ...member, sessionExpiry };
            localStorage.setItem('agcas_member', JSON.stringify(memberData));
            setMemberInfo(memberData);
            
            // Fetch organization info for regular members
            if (member.organization_id && !member.is_team_member) {
              fetchOrganizationInfo(member.organization_id);
            }
            return { valid: true, serverResponded: true }; // Session is valid
          } else {
            // Server explicitly returned null - member no longer exists or is disabled
            // This is different from a network error - the server is telling us the session is invalid
            console.log('[Layout] Server returned null for /api/auth/me - member deleted or disabled');
            return { valid: false, serverResponded: true };
          }
        }
        return { valid: false, serverResponded: false }; // Server error
      } catch (error) {
        console.log('[Layout] Server session check failed, falling back to sessionStorage');
        return { valid: false, serverResponded: false };
      }
    };

    const handleAuth = async () => {
      // Wait for visibility settings to be fetched before making auth decisions
      if (!visibilitySettingsFetched) {
        return; // Don't do anything until settings are loaded
      }
      
      // Get dynamic visibility for the current page
      const visibility = getPageVisibility(currentPageName);
      
      // Handle truly public pages - no auth required
      if (visibility === 'public') {
        return;
      }

      // Try server session first (for password-based auth with cross-tab persistence)
      const sessionResult = await checkServerSession();
      
      // If server explicitly said the session is invalid (e.g., member deleted/disabled)
      // and we have cached data in localStorage, we need to clear it and log out
      if (sessionResult.serverResponded && !sessionResult.valid) {
        const storedMember = localStorage.getItem('agcas_member');
        if (storedMember) {
          console.log('[Layout] Server invalidated session - clearing localStorage and logging out');
          localStorage.removeItem('agcas_member');
          localStorage.removeItem('agcas_organization');
          setMemberInfo(null);
          setOrganizationInfo(null);
          
          // For non-public pages, redirect to login
          if (visibility !== 'hybrid') {
            window.location.href = createPageUrl('Home');
          }
          return;
        }
      }
      
      if (sessionResult.valid) {
        return; // Already authenticated via server session
      }

      // Handle hybrid pages - check sessionStorage
      if (visibility === 'hybrid') {
        const storedMember = localStorage.getItem('agcas_member');
        if (!storedMember) {
          // No member logged in, treat as public
          return;
        }
        // Member is logged in via sessionStorage, continue to validate
      }

      // Fall back to sessionStorage for backward compatibility (only if server didn't respond)
      if (!sessionResult.serverResponded) {
        const storedMember = localStorage.getItem('agcas_member');
        if (!storedMember) {
          window.location.href = createPageUrl('Home');
          return;
        }

        const member = JSON.parse(storedMember);

        if (member.sessionExpiry && new Date(member.sessionExpiry) < new Date()) {
          localStorage.removeItem('agcas_member');
          window.location.href = createPageUrl('Home');
          return;
        }

        // Only update memberInfo if it's actually different (prevent unnecessary re-renders)
        if (!memberInfo || JSON.stringify(memberInfo) !== JSON.stringify(member)) {
          setMemberInfo(member);
        }

        // Only fetch organization info for regular members (not team members)
        if (member.organization_id && !member.is_team_member) {
          fetchOrganizationInfo(member.organization_id);
        }
      }
    };

    handleAuth();
  }, [visibilitySettingsFetched, pageVisibilitySettings, location.pathname]); // Run on visibility settings load AND on every navigation

  // Update last_activity on navigation (throttled to once every 10 minutes)
  useEffect(() => {
    const updateLastActivity = async () => {
      if (!memberInfo?.email || isPublicPage()) return;
    
      const now = Date.now();
      const tenMinutes = 10 * 60 * 1000;
    
      // Throttle: only update once every 10 minutes
      if (lastActivityUpdateRef.current && (now - lastActivityUpdateRef.current) < tenMinutes) {
        return;
      }
    
      try {
        // Find member by email using base44 client
        const members = await base44.entities.Member.list({ filter: { email: memberInfo.email } });
        const member = members && members.length > 0 ? members[0] : null;
    
        if (!member) {
          console.warn('Member not found for email:', memberInfo.email);
          return;
        }
    
        // Update last_activity timestamp using base44 client
        await base44.entities.Member.update(member.id, {
          last_activity: new Date().toISOString()
        });
    
        // Update throttling ref
        lastActivityUpdateRef.current = now;
      } catch (error) {
        console.error('Unexpected error updating last_activity:', error);
      }
    };
    
    updateLastActivity();
  }, [location.pathname, memberInfo?.email]);

  // Check if current page is excluded and redirect if needed
  // Note: Admin page access is now controlled via feature exclusions in isCurrentPageExcluded()
  // Each admin page has a mapped featureId (e.g., page_admin_RoleManagement) that is checked
  useEffect(() => {
    if (!isPublicPage() && memberInfo && memberRole) {
      // Use role's default landing page or fallback to Preferences
      const fallbackPage = memberRole?.default_landing_page || 'Preferences';
      
      // Prevent redirect loop: don't redirect if we're already on the fallback page
      if (currentPageName === fallbackPage) {
        return;
      }
      
      // Check if page is excluded by role/member settings (covers both user and admin pages)
      if (isCurrentPageExcluded()) {
        window.location.href = createPageUrl(fallbackPage);
      }
    }
  }, [currentPageName, memberInfo, memberRole]);

  // Save sidebar scroll position to sessionStorage on scroll
  React.useEffect(() => {
    const sidebar = sidebarContentRef.current;
    if (sidebar) {
      // Save scroll position on scroll
      const handleScroll = () => {
        sessionStorage.setItem('agcas_sidebar_scroll', sidebar.scrollTop.toString());
      };
      sidebar.addEventListener('scroll', handleScroll);
      
      return () => {
        sidebar.removeEventListener('scroll', handleScroll);
      };
    }
  }, []);

  // Restore scroll position after SidebarContent mounts
  React.useEffect(() => {
    const sidebar = sidebarContentRef.current;
    if (sidebar) {
      const savedPosition = sessionStorage.getItem('agcas_sidebar_scroll');
      if (savedPosition) {
        // Use setTimeout to ensure this runs after the mount is complete
        setTimeout(() => {
          sidebar.scrollTop = parseFloat(savedPosition);
        }, 0);
      }
    }
  });

  // Scroll main content to top on navigation only
  useEffect(() => {
    if (mainContentRef.current) {
      mainContentRef.current.scrollTo(0, 0);
    }
  }, [location.pathname]);

  const handleLogout = async () => {
    try {
      // Clear server session first
      await fetch('/api/auth/logout', { 
        method: 'POST', 
        credentials: 'include' 
      });
    } catch (error) {
      console.log('[Layout] Server logout error (may not have server session):', error);
    }
    // Always clear local storage
    localStorage.removeItem('agcas_member');
    localStorage.removeItem('agcas_organization');
    window.location.href = createPageUrl('Home');
  };

  // Icon mapping object - must be defined before useMemo hooks that depend on it
  const iconMap = {
    Menu, Calendar, CreditCard, Ticket, Wallet, ShoppingCart, History, Sparkles, FileText, 
    Briefcase, Settings, BookOpen, Building, HelpCircle, Users, Shield, BarChart3, FileEdit, 
    AtSign, FolderTree, Trophy, MousePointer2, Mail, Download, Newspaper, PenLine, Home, Globe, 
    Folder, Image, MessageSquare, Bell, Star, Heart, Eye, Link: LinkIcon, ExternalLink, Tag, Award, 
    Bookmark, Clock, Search, Phone, MapPin, Video, Music, Camera, Mic, Headphones, Tv, Radio, Rss, 
    Share2, Gift, Zap, Target, Flag, Layers, Grid, List, Layout: LayoutIcon, Monitor, Smartphone, 
    Tablet, Laptop, Server, Database, Cloud, Lock, Key, UserCheck, UserPlus, UserMinus, Users2, 
    MessageCircle, Send, Inbox, Archive, Navigation
  };

  // Build navigation structure from dynamic items
  // Defined as a stable function for use in useMemo
  const buildNavigationFromDB = (section) => {
    const items = dynamicNavItems.filter(item => item.is_active && item.section === section);
    const topLevelItems = items.filter(item => !item.parent_id);
    
    // Helper to detect article-related URLs
    const isArticleUrl = (url) => {
      if (!url) return false;
      const lower = url.toLowerCase();
      return lower === 'articles' || lower === 'myarticles' || 
             lower.includes('article') || lower.includes('blog');
    };
    
    // Helper to get or generate feature_id for a menu item
    // This ensures filtering works even if feature_id wasn't set in the database
    const getFeatureId = (item, itemSection) => {
      // If feature_id is already set, use it
      if (item.feature_id) {
        return item.feature_id;
      }
      // Generate feature_id from URL or title
      if (item.url) {
        // For admin section, use page_admin_* pattern; for user, use page_* pattern
        return itemSection === 'admin' 
          ? `page_admin_${item.url}` 
          : `page_${item.url}`;
      }
      // For parent menus without URL, use title
      if (item.title) {
        const titleKey = item.title.replace(/\s+/g, '');
        return itemSection === 'admin'
          ? `page_admin_${titleKey}`
          : `page_${titleKey}`;
      }
      return null;
    };
    
    return topLevelItems.sort((a, b) => a.display_order - b.display_order).map(parent => {
      // Find children - look in ALL items, not just section-filtered ones
      const children = dynamicNavItems.filter(child => 
        child.is_active && child.parent_id === parent.id
      );
      
      const IconComponent = iconMap[parent.icon] || Menu;
      // Only mark parent as article section if the PARENT ITSELF has an article URL
      // Children having article URLs should NOT cause the parent title to be renamed
      const isArticleSection = isArticleUrl(parent.url);
      
      if (children.length > 0) {
        return {
          title: parent.title,
          icon: IconComponent,
          featureId: getFeatureId(parent, section),
          isDynamicArticleSection: isArticleSection,
          subItems: children.sort((a, b) => a.display_order - b.display_order).map(child => ({
            title: child.title,
            url: child.url ? createPageUrl(child.url) : '',
            featureId: getFeatureId(child, section),
            isDynamicMyArticles: child.url?.toLowerCase() === 'myarticles',
            isDynamicArticles: child.url?.toLowerCase() === 'articles'
          }))
        };
      } else {
        return {
          title: parent.title,
          url: parent.url ? createPageUrl(parent.url) : '',
          icon: IconComponent,
          featureId: getFeatureId(parent, section),
          isDynamicArticles: parent.url?.toLowerCase() === 'articles',
          isDynamicMyArticles: parent.url?.toLowerCase() === 'myarticles'
        };
      }
    });
  };

  // Memoized navigation items with dynamic article URLs applied
  // CRITICAL: Must deep clone AND apply URL transformations in the SAME memoization
  // This prevents any mutation of cached clones when isCustomSlug changes
  const navigationItemsSource = useMemo(() => {
    // Get base items (from DB or hardcoded)
    const baseItems = dynamicNavItems.length > 0 
      ? buildNavigationFromDB('user')
      : navigationItems;
    
    // Deep clone with icons preserved - NEVER mutate originals
    const clonedItems = baseItems.map(item => ({
      ...item,
      icon: item.icon,
      subItems: item.subItems ? item.subItems.map(sub => ({ ...sub })) : undefined
    }));
    
    // When NOT using custom slug, return cloned items with original createPageUrl() URLs
    if (!isCustomSlug) {
      return clonedItems;
    }
    
    // Apply dynamic URLs only when custom slug is confirmed
    return clonedItems.map(item => {
      const processedItem = { ...item };
      
      if (item.isDynamicArticleSection && articleDisplayName) {
        processedItem.title = articleDisplayName;
      }
      
      if (item.isDynamicArticles) {
        processedItem.url = getArticleListUrl();
        if (articleDisplayName) processedItem.title = articleDisplayName;
      }
      if (item.isDynamicMyArticles) {
        processedItem.url = getMyArticlesUrl();
        if (articleDisplayName) processedItem.title = `My ${articleDisplayName}`;
      }
      
      if (item.subItems) {
        processedItem.subItems = item.subItems.map(subItem => {
          const processedSubItem = { ...subItem };
          if (subItem.isDynamicMyArticles) {
            processedSubItem.url = getMyArticlesUrl();
            if (articleDisplayName) processedSubItem.title = `My ${articleDisplayName}`;
          }
          if (subItem.isDynamicArticles) {
            processedSubItem.url = getArticleListUrl();
            if (articleDisplayName) processedSubItem.title = articleDisplayName;
          }
          return processedSubItem;
        });
      }
      
      return processedItem;
    });
  }, [dynamicNavItems, isCustomSlug, articleDisplayName, urlSlug, getArticleListUrl, getMyArticlesUrl]);
  
  const adminNavigationItemsSource = useMemo(() => {
    // Get base items (from DB or hardcoded)
    const baseItems = dynamicNavItems.length > 0 
      ? buildNavigationFromDB('admin')
      : adminNavigationItems;
    
    // Deep clone with icons preserved - NEVER mutate originals
    const clonedItems = baseItems.map(item => ({
      ...item,
      icon: item.icon,
      subItems: item.subItems ? item.subItems.map(sub => ({ ...sub })) : undefined
    }));
    
    // When NOT using custom slug, return cloned items with original createPageUrl() URLs
    if (!isCustomSlug) {
      return clonedItems;
    }
    
    // Apply dynamic URLs only when custom slug is confirmed
    return clonedItems.map(item => {
      const processedItem = { ...item };
      
      if (item.isDynamicArticleSection && articleDisplayName) {
        processedItem.title = articleDisplayName;
      }
      
      if (item.isDynamicArticles) {
        processedItem.url = getArticleListUrl();
        if (articleDisplayName) processedItem.title = articleDisplayName;
      }
      if (item.isDynamicMyArticles) {
        processedItem.url = getMyArticlesUrl();
        if (articleDisplayName) processedItem.title = `My ${articleDisplayName}`;
      }
      
      if (item.subItems) {
        processedItem.subItems = item.subItems.map(subItem => {
          const processedSubItem = { ...subItem };
          if (subItem.isDynamicMyArticles) {
            processedSubItem.url = getMyArticlesUrl();
            if (articleDisplayName) processedSubItem.title = `My ${articleDisplayName}`;
          }
          if (subItem.isDynamicArticles) {
            processedSubItem.url = getArticleListUrl();
            if (articleDisplayName) processedSubItem.title = articleDisplayName;
          }
          return processedSubItem;
        });
      }
      
      return processedItem;
    });
  }, [dynamicNavItems, isCustomSlug, articleDisplayName, urlSlug, getArticleListUrl, getMyArticlesUrl]);

  // Filter navigation items based on member's excluded features
  const filteredNavigationItems = navigationItemsSource
    .map(item => {
      if (item.subItems) {
        // If it has sub-items, filter them individually
        const filteredSubItems = item.subItems.filter(subItem => !isFeatureExcluded(subItem.featureId));
        // Only include the parent if it's not excluded and has at least one filtered sub-item
        if (filteredSubItems.length > 0 && !isFeatureExcluded(item.featureId)) {
          return { ...item, subItems: filteredSubItems };
        }
        return null; // Exclude parent if no sub-items left or parent is excluded
      } else {
        // Regular item, filter if its own featureId is not excluded
        return !isFeatureExcluded(item.featureId) ? item : null;
      }
    })
    .filter(Boolean);

  // Filter admin navigation items based purely on feature exclusions
  // Admin section will render if any items remain after filtering (checked in JSX: filteredAdminNavigationItems.length > 0)
  const filteredAdminNavigationItems = adminNavigationItemsSource
    .map(item => {
      if (item.subItems) {
        // If it has sub-items, filter them individually
        const filteredSubItems = item.subItems.filter(subItem => !isFeatureExcluded(subItem.featureId));
        // Only include the parent if it's not excluded and has at least one filtered sub-item
        if (filteredSubItems.length > 0 && !isFeatureExcluded(item.featureId)) {
          return { ...item, subItems: filteredSubItems };
        }
        return null; // Exclude parent if no sub-items left or parent is excluded
      } else {
        // Regular item, filter if its own featureId is not excluded
        return !isFeatureExcluded(item.featureId) ? item : null;
      }
    })
    .filter(Boolean); // Remove any null entries

  const childrenWithProps = React.Children.map(children, child => {
    if (React.isValidElement(child)) {
      return React.cloneElement(child, { 
        memberInfo, 
        organizationInfo,
        memberRole,
        // isAdmin removed - access control now uses isFeatureExcluded() exclusively
        refreshOrganizationInfo: () => { // Conditionally refresh org info for non-team members
          if (memberInfo && !memberInfo.is_team_member) {
            fetchOrganizationInfo(memberInfo.organization_id);
          }
        },
        isFeatureExcluded,
        reloadMemberInfo, // Add the new function to props
        hasBanner: !!portalBanner // Pass banner status to hide page headers when banner is present
      });
    }
    return child;
  });

  // EARLY RETURNS - must come AFTER all hooks to avoid React error #310
  // Wait for visibility settings to load before rendering layout
  if (!visibilitySettingsFetched) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-pulse text-slate-400">Loading...</div>
      </div>
    );
  }

  // Resolve effective page name for dynamic article routes and public page variants
  // When _DynamicPage is rendering a public page, pass the canonical component name
  // Also handles mapping portal pages to their public equivalents for unauthenticated users
  const getEffectivePageName = () => {
    const isAuthenticated = !!memberInfo;
    
    // Map portal pages to their public equivalents for unauthenticated visitors
    // This ensures public visitors see PublicResources instead of Resources, etc.
    const portalToPublicMap = {
      'Resources': 'PublicResources',
      'Articles': 'PublicArticles', 
      'News': 'PublicNews',
      'Events': 'PublicEvents',
    };
    
    // If user is not authenticated and we're on a page with a public equivalent
    if (!isAuthenticated && portalToPublicMap[currentPageName]) {
      console.log('[Layout] getEffectivePageName: Mapping', currentPageName, 'to', portalToPublicMap[currentPageName], 'for unauthenticated user');
      return portalToPublicMap[currentPageName];
    }
    
    if (currentPageName !== '_DynamicPage') {
      return currentPageName;
    }
    
    // Check if this is a dynamic article route
    if (isCustomSlug && urlSlug) {
      const pathname = location.pathname.toLowerCase();
      const slug = pathname.replace(/^\//, ''); // Remove leading slash
      
      if (slug === publicSlug?.toLowerCase()) {
        return 'PublicArticles';
      }
      if (slug === urlSlug?.toLowerCase()) {
        return isAuthenticated ? 'Articles' : 'PublicArticles';
      }
      if (slug === viewSlug?.toLowerCase()) {
        return 'ArticleView';
      }
      if (slug === mySlug?.toLowerCase()) {
        return 'Articles'; // MyArticles is now integrated into Articles page
      }
      if (slug === editorSlug?.toLowerCase()) {
        return 'ArticleEditor';
      }
    }
    
    return currentPageName;
  };

  // Render public layout for truly public pages
  if (isPublicPage()) {
    const effectivePageName = getEffectivePageName();
    if (bareLayoutPages.includes(currentPageName)) {
      return <BarePublicLayout>{children}</BarePublicLayout>;
    }
    return <PublicLayout currentPageName={effectivePageName}>{children}</PublicLayout>;
  }

  return (
    <div style={{ fontFamily: 'Poppins, sans-serif' }}>
      {/* Google Fonts - Poppins */}
      <style>
        {`
          @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap');

          @font-face {
            font-family: 'Degular Medium';
            src: url('https://teeone.pythonanywhere.com/font-assets/Degular-Medium.woff') format('woff');
            font-weight: 500;
            font-style: normal;
            font-display: block;
          }

          :root {
            --border-radius: ${borderRadiusSetting || '8px'};
          }

          /* Degular Medium for H1 headers */
          h1 {
            font-family: 'Degular Medium', 'Poppins', sans-serif;
          }
          
          /* Apply border radius globally to common UI elements */
          .Card, [class*="Card"], 
          .card, [class*="card"],
          button:not(.unstyled),
          input:not([type="checkbox"]):not([type="radio"]),
          textarea,
          select,
          [role="dialog"],
          [role="menu"],
          [role="listbox"],
          .shadow, .shadow-sm, .shadow-md, .shadow-lg {
            border-radius: var(--border-radius) !important;
          }
        `}
      </style>

      <SidebarProvider key="main-sidebar-provider">
        <div className="flex h-screen w-full overflow-hidden">
        <Sidebar className="border-r border-slate-200 bg-white flex-shrink-0">
            <SidebarHeader className="border-b border-slate-200 p-4">
              {portalLogoSettings?.logoUrl ? (
                // Custom portal logo
                <a 
                  href={defaultLogoHref} 
                  className="block hover:opacity-80 transition-opacity"
                  style={{ height: `${logoHeightPx}px` }}
                >
                  <img 
                    src={portalLogoSettings.logoUrl} 
                    alt="Portal Logo" 
                    className="h-full w-full object-contain object-left"
                  />
                </a>
              ) : (
                // Default AGCAS Events branding
                <Link to={defaultLogoHref} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
                  <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-md border border-slate-200 overflow-hidden">
                    {memberRecord?.profile_photo_url ? (
                      <img 
                        src={memberRecord.profile_photo_url} 
                        alt="Profile" 
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <User className="w-6 h-6 text-slate-400" />
                    )}
                  </div>
                  <div>
                    <h2 className="font-bold text-slate-900">AGCAS Events</h2>
                    <p className="text-xs text-slate-500">Member Portal</p>
                  </div>
                </Link>
              )}
            </SidebarHeader>
            
            <SidebarContent ref={sidebarContentRef} className="p-3">
              {/* Only render navigation once role data is loaded */}
              {!memberRole ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
                </div>
              ) : (
                <>
              {/* Only show organization info for regular members */}
              {memberInfo && !memberInfo.is_team_member && organizationInfo && (
                <SidebarGroup>
                  <SidebarGroupLabel className="text-xs font-medium text-slate-500 uppercase tracking-wider px-3 py-2">
                    Your Account
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <div className="px-3 py-2 space-y-3">
                      {organizationInfo.name && (
                        <div className="text-sm">
                          <span className="text-slate-600 block mb-1">Organisation</span>
                          <span className="font-medium text-slate-900">{organizationInfo.name}</span>
                        </div>
                      )}
                      {organizationInfo.voucher_balance > 0 && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Vouchers</span>
                          <span className="font-semibold text-blue-600">£{organizationInfo.voucher_balance}</span>
                        </div>
                      )}
                    </div>
                  </SidebarGroupContent>
                </SidebarGroup>
              )}

              {/* Next Event Countdown - show for members with bookings */}
              {memberInfo && !memberInfo.is_team_member && (
                <NextEventCountdown memberEmail={memberInfo.email} />
              )}

              <SidebarGroup className={memberInfo && !memberInfo.is_team_member && organizationInfo ? "mt-4" : ""}>
                <SidebarGroupLabel className="text-xs font-medium text-slate-500 uppercase tracking-wider px-3 py-2">
                  Navigation
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {filteredNavigationItems.map((item) => {
                      const Icon = item.icon;
                      // Determine if the current item (or any of its sub-items) is active
                      const isActive = item.url === location.pathname || 
                                       (item.subItems && item.subItems.some(sub => sub.url === location.pathname));

                      if (item.subItems) {
                        return (
                          <Collapsible key={item.title} defaultOpen={isActive}>
                            <SidebarMenuItem>
                                <CollapsibleTrigger asChild>
                                  <SidebarMenuButton 
                                    className={`hover:bg-blue-50 hover:text-blue-700 transition-colors rounded-lg mb-1 flex items-center gap-3 px-3 py-2.5 group ${
                                      isActive ? 'bg-blue-50 text-blue-700 font-medium' : ''
                                    }`}
                                  >
                                    <Icon className="w-4 h-4" />
                                    <span className="flex-1">{item.title}</span>
                                    <ChevronRight className="w-4 h-4 transition-transform group-data-[state=open]:rotate-90" />
                                  </SidebarMenuButton>
                                </CollapsibleTrigger>
                            </SidebarMenuItem>
                            <CollapsibleContent>
                              <SidebarMenuSub>
                                {item.subItems.map(subItem => {
                                  const isSubItemActive = subItem.url === location.pathname;
                                  // Show pending PO bell only on the Bookings page link
                                  const isBookingsPage = subItem.url?.toLowerCase() === '/bookings';
                                  const showSubPendingPOWarning = hasPendingPOs && isBookingsPage;
                                  return (
                                    <SidebarMenuSubItem key={subItem.title}>
                                      <Link
                                        to={subItem.url}
                                        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                                          isSubItemActive ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-blue-50 hover:text-blue-700'
                                        }`}
                                      >
                                        <span className="flex-1">{subItem.title}</span>
                                        {showSubPendingPOWarning && (
                                          <Bell className="w-4 h-4 text-amber-500 animate-pulse" data-testid="pending-po-warning-bell-sub" />
                                        )}
                                      </Link>
                                    </SidebarMenuSubItem>
                                  );
                                })}
                              </SidebarMenuSub>
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      } else {
                        // Show pending PO bell only on the Bookings page link
                        const isBookingsPage = item.url?.toLowerCase() === '/bookings';
                        const showPendingPOWarning = hasPendingPOs && isBookingsPage;
                        return (
                          <SidebarMenuItem 
                            key={item.title}
                            id={item.title === "Buy Tickets" ? "buy-tickets-menu-item" : undefined}
                          >
                            <SidebarMenuButton 
                              asChild 
                              className={`hover:bg-blue-50 hover:text-blue-700 transition-colors rounded-lg mb-1 ${
                                isActive ? 'bg-blue-50 text-blue-700 font-medium' : ''
                              }`}
                            >
                              <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                                <Icon className="w-4 h-4" />
                                <span className="flex-1">{item.title}</span>
                                {showPendingPOWarning && (
                                  <Bell className="w-4 h-4 text-amber-500 animate-pulse" data-testid="pending-po-warning-bell" />
                                )}
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      }
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              {/* Admin Section */}
              {filteredAdminNavigationItems.length > 0 && (
                <SidebarGroup className="mt-4">
                  <SidebarGroupLabel className="text-xs font-medium text-amber-600 uppercase tracking-wider px-3 py-2">
                    Administration
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {filteredAdminNavigationItems.map((item) => {
                        const Icon = item.icon;
                        // Determine if the current item (or any of its sub-items) is active
                        const isActive = item.url === location.pathname || 
                                         (item.subItems && item.subItems.some(sub => sub.url === location.pathname));

                        if (item.subItems) {
                          return (
                            <Collapsible key={item.title} defaultOpen={isActive}>
                              <SidebarMenuItem>
                                <CollapsibleTrigger asChild>
                                  <SidebarMenuButton 
                                    className={`hover:bg-amber-50 hover:text-amber-700 transition-colors rounded-lg mb-1 flex items-center gap-3 px-3 py-2.5 group ${
                                      isActive ? 'bg-amber-50 text-amber-700 font-medium' : ''
                                    }`}
                                  >
                                    <Icon className="w-4 h-4" />
                                    <span className="flex-1">{item.title}</span>
                                    <ChevronRight className="w-4 h-4 transition-transform group-data-[state=open]:rotate-90" />
                                  </SidebarMenuButton>
                                </CollapsibleTrigger>
                              </SidebarMenuItem>
                              <CollapsibleContent>
                                <SidebarMenuSub>
                                  {item.subItems.map(subItem => {
                                    const isSubItemActive = subItem.url === location.pathname;
                                    return (
                                      <SidebarMenuSubItem key={subItem.title}>
                                        <Link
                                          to={subItem.url}
                                          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                                            isSubItemActive ? 'bg-amber-50 text-amber-700 font-medium' : 'hover:bg-amber-50 hover:text-amber-700'
                                          }`}
                                        >
                                          <span>{subItem.title}</span>
                                        </Link>
                                      </SidebarMenuSubItem>
                                    );
                                  })}
                                </SidebarMenuSub>
                              </CollapsibleContent>
                            </Collapsible>
                          );
                        } else {
                          return (
                            <SidebarMenuItem key={item.title}>
                                <SidebarMenuButton 
                                  asChild 
                                  className={`hover:bg-amber-50 hover:text-amber-700 transition-colors rounded-lg mb-1 ${
                                    isActive ? 'bg-amber-50 text-amber-700 font-medium' : ''
                                  }`}
                                >
                                  <Link to={item.url} className="flex items-center gap-3 px-3 py-2.5">
                                  <Icon className="w-4 h-4" />
                                  <span>{item.title}</span>
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        }
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              )}
              </>
              )}
            </SidebarContent>

            <SidebarFooter className="border-t border-slate-200 p-4">
              {memberInfo && (
                <div className="space-y-3">
                  <div className="px-3 py-2 bg-slate-50 rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <User className="w-4 h-4 text-slate-500" />
                      <span className="text-sm font-medium text-slate-900">
                        {memberInfo.first_name} {memberInfo.last_name}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 pl-6">{memberInfo.email}</p>
                    {memberRole && (
                      <div className="pl-6 mt-2">
                        <Badge className="bg-purple-100 text-purple-700 text-xs">
                          {memberRole.name}
                        </Badge>
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    className="w-full justify-start text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                    onClick={handleLogout}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    Sign Out
                  </Button>
                </div>
              )}
            </SidebarFooter>
          </Sidebar>

          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Mobile Header - only visible on small screens */}
            <header className="md:hidden flex-shrink-0 flex items-center justify-between p-4 border-b border-slate-200 bg-white z-50">
              {portalLogoSettings?.logoUrl ? (
                // Custom portal logo for mobile
                <a 
                  href={defaultLogoHref} 
                  className="flex items-center hover:opacity-80 transition-opacity"
                  style={{ height: `${Math.min(logoHeightPx, 40)}px` }}
                >
                  <img 
                    src={portalLogoSettings.logoUrl} 
                    alt="Portal Logo" 
                    className="h-full max-w-[180px] object-contain object-left"
                  />
                </a>
              ) : (
                // Default branding for mobile
                <Link to={defaultLogoHref} className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center shadow-sm border border-slate-200 overflow-hidden">
                    {memberRecord?.profile_photo_url ? (
                      <img 
                        src={memberRecord.profile_photo_url} 
                        alt="Profile" 
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <User className="w-4 h-4 text-slate-400" />
                    )}
                  </div>
                  <div>
                    <h2 className="font-bold text-slate-900 text-sm">AGCAS Events</h2>
                  </div>
                </Link>
              )}
              <Button 
                variant="ghost" 
                size="icon"
                onClick={() => setMobileMenuOpen(true)}
                data-testid="button-mobile-menu"
              >
                <Menu className="w-6 h-6" />
              </Button>
            </header>

            {/* Mobile Navigation Sheet */}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetContent side="left" className="w-[300px] p-0 flex flex-col">
                <SheetHeader className="border-b border-slate-200 p-4">
                  {portalLogoSettings?.logoUrl ? (
                    // Custom portal logo in mobile sheet
                    <a 
                      href={defaultLogoHref} 
                      className="block hover:opacity-80 transition-opacity"
                      style={{ height: `${logoHeightPx}px` }}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <img 
                        src={portalLogoSettings.logoUrl} 
                        alt="Portal Logo" 
                        className="h-full w-full object-contain object-left"
                      />
                    </a>
                  ) : (
                    // Default branding in mobile sheet
                    <SheetTitle className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-md border border-slate-200 overflow-hidden">
                        {memberRecord?.profile_photo_url ? (
                          <img 
                            src={memberRecord.profile_photo_url} 
                            alt="Profile" 
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <User className="w-6 h-6 text-slate-400" />
                        )}
                      </div>
                      <div className="text-left">
                        <div className="font-bold text-slate-900">AGCAS Events</div>
                        <div className="text-xs text-slate-500 font-normal">Member Portal</div>
                      </div>
                    </SheetTitle>
                  )}
                </SheetHeader>
                
                <ScrollArea className="flex-1 p-3">
                  {/* Member Info Section */}
                  {memberInfo && !memberInfo.is_team_member && organizationInfo && (
                    <div className="mb-4">
                      <div className="text-xs font-medium text-slate-500 uppercase tracking-wider px-3 py-2">
                        Your Account
                      </div>
                      <div className="px-3 py-2 space-y-3">
                        {organizationInfo.name && (
                          <div className="text-sm">
                            <span className="text-slate-600 block mb-1">Organisation</span>
                            <span className="font-medium text-slate-900">{organizationInfo.name}</span>
                          </div>
                        )}
                        {organizationInfo.voucher_balance > 0 && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-600">Vouchers</span>
                            <span className="font-semibold text-blue-600">£{organizationInfo.voucher_balance}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Navigation Section */}
                  <div className="mb-4">
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider px-3 py-2">
                      Navigation
                    </div>
                    <nav className="space-y-1">
                      {filteredNavigationItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = item.url === location.pathname || 
                                         (item.subItems && item.subItems.some(sub => sub.url === location.pathname));
                        const isBookingsPage = item.url?.toLowerCase() === '/bookings';
                        const showPendingPOWarning = hasPendingPOs && isBookingsPage;

                        if (item.subItems) {
                          return (
                            <Collapsible key={item.title} defaultOpen={isActive}>
                              <CollapsibleTrigger className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                                isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-blue-50 hover:text-blue-700'
                              }`}>
                                <Icon className="w-4 h-4" />
                                <span className="flex-1 text-left">{item.title}</span>
                                <ChevronRight className="w-4 h-4 transition-transform group-data-[state=open]:rotate-90" />
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <div className="pl-7 space-y-1 mt-1">
                                  {item.subItems.map(subItem => {
                                    const isSubItemActive = subItem.url === location.pathname;
                                    return (
                                      <Link
                                        key={subItem.title}
                                        to={subItem.url}
                                        onClick={() => setMobileMenuOpen(false)}
                                        className={`block px-3 py-2 rounded-lg text-sm ${
                                          isSubItemActive ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-blue-50 hover:text-blue-700'
                                        }`}
                                      >
                                        {subItem.title}
                                      </Link>
                                    );
                                  })}
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          );
                        } else {
                          return (
                            <Link
                              key={item.title}
                              to={item.url}
                              onClick={() => setMobileMenuOpen(false)}
                              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                                isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-blue-50 hover:text-blue-700'
                              }`}
                            >
                              <Icon className="w-4 h-4" />
                              <span className="flex-1">{item.title}</span>
                              {showPendingPOWarning && (
                                <Bell className="w-4 h-4 text-amber-500 animate-pulse" data-testid="pending-po-warning-bell-mobile" />
                              )}
                            </Link>
                          );
                        }
                      })}
                    </nav>
                  </div>

                  {/* Admin Section */}
                  {filteredAdminNavigationItems.length > 0 && (
                    <div className="mb-4">
                      <div className="text-xs font-medium text-amber-600 uppercase tracking-wider px-3 py-2">
                        Administration
                      </div>
                      <nav className="space-y-1">
                        {filteredAdminNavigationItems.map((item) => {
                          const Icon = item.icon;
                          const isActive = item.url === location.pathname || 
                                           (item.subItems && item.subItems.some(sub => sub.url === location.pathname));

                          if (item.subItems) {
                            return (
                              <Collapsible key={item.title} defaultOpen={isActive}>
                                <CollapsibleTrigger className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                                  isActive ? 'bg-amber-50 text-amber-700 font-medium' : 'hover:bg-amber-50 hover:text-amber-700'
                                }`}>
                                  <Icon className="w-4 h-4" />
                                  <span className="flex-1 text-left">{item.title}</span>
                                  <ChevronRight className="w-4 h-4 transition-transform group-data-[state=open]:rotate-90" />
                                </CollapsibleTrigger>
                                <CollapsibleContent>
                                  <div className="pl-7 space-y-1 mt-1">
                                    {item.subItems.map(subItem => {
                                      const isSubItemActive = subItem.url === location.pathname;
                                      return (
                                        <Link
                                          key={subItem.title}
                                          to={subItem.url}
                                          onClick={() => setMobileMenuOpen(false)}
                                          className={`block px-3 py-2 rounded-lg text-sm ${
                                            isSubItemActive ? 'bg-amber-50 text-amber-700 font-medium' : 'hover:bg-amber-50 hover:text-amber-700'
                                          }`}
                                        >
                                          {subItem.title}
                                        </Link>
                                      );
                                    })}
                                  </div>
                                </CollapsibleContent>
                              </Collapsible>
                            );
                          } else {
                            return (
                              <Link
                                key={item.title}
                                to={item.url}
                                onClick={() => setMobileMenuOpen(false)}
                                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                                  isActive ? 'bg-amber-50 text-amber-700 font-medium' : 'hover:bg-amber-50 hover:text-amber-700'
                                }`}
                              >
                                <Icon className="w-4 h-4" />
                                <span>{item.title}</span>
                              </Link>
                            );
                          }
                        })}
                      </nav>
                    </div>
                  )}
                </ScrollArea>

                {/* Footer with user info and logout */}
                <div className="border-t border-slate-200 p-4">
                  {memberInfo && (
                    <div className="space-y-3">
                      <div className="px-3 py-2 bg-slate-50 rounded-lg">
                        <div className="flex items-center gap-2 mb-1">
                          <User className="w-4 h-4 text-slate-500" />
                          <span className="text-sm font-medium text-slate-900">
                            {memberInfo.first_name} {memberInfo.last_name}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 pl-6">{memberInfo.email}</p>
                        {memberRole && (
                          <div className="pl-6 mt-2">
                            <Badge className="bg-purple-100 text-purple-700 text-xs">
                              {memberRole.name}
                            </Badge>
                          </div>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        className="w-full justify-start text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                        onClick={() => {
                          setMobileMenuOpen(false);
                          handleLogout();
                        }}
                      >
                        <LogOut className="w-4 h-4 mr-2" />
                        Sign Out
                      </Button>
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>

            {!isFeatureExcluded('element_NewsTickerBar') && <NewsTickerBar />}
            <main ref={mainContentRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 overscroll-contain">
              {/* Render ALL top banners with appropriate component based on banner_type */}
              {topBanners.length > 0 && (
                <div className="w-full">
                  {topBanners.map((banner) => (
                    banner.banner_type === 'image'
                      ? <PageBannerDisplay key={banner.id} banner={banner} />
                      : <PortalHeroBanner key={banner.id} banner={banner} />
                  ))}
                </div>
              )}
              {/* Wrap children in BannerProvider for below-first-element banners */}
              <BannerProvider belowFirstElementBanners={belowFirstElementBanners}>
                {childrenWithProps}
              </BannerProvider>
            </main>

            <footer className="flex-shrink-0 flex-grow-0 bg-white border-t border-slate-200 py-6">
              <div className="max-w-7xl mx-auto px-4 text-center">
                <a 
                  href="https://isaasi.co.uk" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="inline-block mb-3 hover:opacity-80 transition-opacity"
                >
                  <img 
                    src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/fe03f7c5e_linked-aa.png" 
                    alt="isaasi"
                    className="w-[50px] mx-auto"
                  />
                </a>
                <p className="text-sm text-slate-600">
                  <span style={{ color: '#eb008c' }}>i</span>Connect by{' '}
                  <a 
                    href="https://isaasi.co.uk" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="hover:opacity-80 transition-opacity font-medium"
                    style={{ color: '#eb008c' }}
                  >
                    isaasi
                  </a>
                  {' '}- © Copyright {new Date().getFullYear() === 2025 ? '2025' : `2025-${new Date().getFullYear()}`}
                </p>
                <p className="text-xs text-orange-500 font-semibold mt-2">
                  BETA AUTH
                </p>
              </div>
            </footer>
          </div>
          
          {/* Floater Display for Portal Pages */}
          {!isFeatureExcluded('element_FloatersDisplay') && (
            <FloaterDisplay location="portal" memberInfo={memberInfo} organizationInfo={organizationInfo} />
          )}
        </div>
      </SidebarProvider>
    </div>
  );
}
