import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, GripVertical, Users, Shield, Menu, Calendar, CreditCard, Ticket, Wallet, ShoppingCart, History, Sparkles, FileText, Briefcase, Settings, BookOpen, Building, HelpCircle, BarChart3, FileEdit, AtSign, FolderTree, Trophy, MousePointer2, Mail, Download, Check, ChevronsUpDown, Newspaper, PenLine, Home, Globe, Folder, Image, MessageSquare, Bell, Star, Heart, Eye, Link, ExternalLink, Tag, Award, Bookmark, Clock, Search, Phone, MapPin, Video, Music, Camera, Mic, Headphones, Tv, Radio, Rss, Share2, Gift, Zap, Target, Flag, Layers, Grid, List, Layout, Monitor, Smartphone, Tablet, Laptop, Server, Database, Cloud, Lock, Key, UserCheck, UserPlus, UserMinus, Users2, MessageCircle, Send, Inbox, Archive } from "lucide-react";
import { toast } from "sonner";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { ROLE_ACCESS_MAP } from "@/lib/roleAccessMap";

// Build grouped role access options by module for better organization (sorted alphabetically)
const groupedRoleAccessOptions = (() => {
  const groups = [];
  for (const module of ROLE_ACCESS_MAP) {
    const items = [];
    // Add module itself
    items.push({ value: module.id, label: module.label, type: 'module' });
    // Add pages
    for (const page of module.pages) {
      items.push({ value: page.id, label: page.label, type: 'page' });
      // Add features
      if (page.features) {
        for (const feature of page.features) {
          items.push({ value: feature.id, label: feature.label, type: 'feature', parentPage: page.label });
        }
      }
    }
    groups.push({ module: module.label, icon: module.icon, items });
  }
  // Sort groups alphabetically by module name
  return groups.sort((a, b) => a.module.localeCompare(b.module));
})();

const availableIcons = {
  Menu, Calendar, CreditCard, Ticket, Wallet, ShoppingCart, History, Sparkles, FileText, Briefcase, Settings, 
  BookOpen, Building, HelpCircle, Users, Shield, BarChart3, FileEdit, AtSign, FolderTree, Trophy, MousePointer2, Mail, Download,
  Newspaper, PenLine, Home, Globe, Folder, Image, MessageSquare, Bell, Star, Heart, Eye, Link, ExternalLink, Tag, 
  Award, Bookmark, Clock, Search, Phone, MapPin, Video, Music, Camera, Mic, Headphones, Tv, Radio, Rss, Share2, Gift, 
  Zap, Target, Flag, Layers, Grid, List, Layout, Monitor, Smartphone, Tablet, Laptop, Server, Database, Cloud, Lock, Key,
  UserCheck, UserPlus, UserMinus, Users2, MessageCircle, Send, Inbox, Archive
};

const builtInPages = [
  { value: "AdminSetup", label: "Admin Setup" },
  { value: "Articles", label: "Articles" },
  { value: "ArticlesSettings", label: "Articles Settings" },
  { value: "ArticleEditor", label: "Article Editor" },
  { value: "ArticleView", label: "Article View" },
  { value: "AwardManagement", label: "Award Management" },
  { value: "Balances", label: "Balances" },
  { value: "Bookings", label: "Bookings" },
  { value: "BorderRadiusSettings", label: "Border Radius Settings" },
  { value: "ButtonElements", label: "Button Elements" },
  { value: "ButtonStyleManagement", label: "Button Styles" },
  { value: "BuyProgramTickets", label: "Buy Program Tickets" },
  { value: "CardDeckManagement", label: "Card Deck Management" },
  { value: "CategoryManagement", label: "Category Management" },
  { value: "CommunicationsManagement", label: "Communications Management" },
  { value: "CustomFieldsAdmin", label: "Custom Fields Admin" },
  { value: "Dashboard", label: "Dashboard" },
  { value: "DataExport", label: "Data Export" },
  { value: "DiscountCodeManagement", label: "Discount Code Management" },
  { value: "DynamicDirectoryManagement", label: "Dynamic Directory Management" },
  { value: "DynamicPage", label: "Dynamic Page" },
  { value: "EmailTemplateManagement", label: "Email Templates" },
  { value: "EventDetails", label: "Event Details" },
  { value: "Events", label: "Events" },
  { value: "EventSettings", label: "Event Settings" },
  { value: "FileManagement", label: "File Management" },
  { value: "FloaterManagement", label: "Floater Management" },
  { value: "FormBuilder", label: "Form Builder" },
  { value: "FormManagement", label: "Form Management" },
  { value: "FormSubmissions", label: "Form Submissions" },
  { value: "FormView", label: "Form View" },
  { value: "GuestWriterManagement", label: "Guest Writer Management" },
  { value: "History", label: "History" },
  { value: "Home", label: "Home" },
  { value: "IEditPageEditor", label: "Page Editor" },
  { value: "IEditPageManagement", label: "Page Builder - Pages" },
  { value: "IEditTemplateManagement", label: "Page Builder - Templates" },
  { value: "InstalledFonts", label: "Installed Fonts" },
  { value: "JobBoard", label: "Job Board" },
  { value: "JobBoardSettings", label: "Job Board Settings" },
  { value: "JobDetails", label: "Job Details" },
  { value: "JobPostingManagement", label: "Job Posting Management" },
  { value: "JobPostSuccess", label: "Job Post Success" },
  { value: "MemberDirectory", label: "Member Directory" },
  { value: "MemberDirectorySettings", label: "Member Directory Settings" },
  { value: "MemberGroupAssignmentReport", label: "Member Group Assignment Report" },
  { value: "MemberGroupGuestManagement", label: "Member Group Guest Management" },
  { value: "MemberGroupManagement", label: "Member Group Management" },
  { value: "MemberHandleManagement", label: "Member Handle Management" },
  { value: "MemberRoleAssignment", label: "Member Role Assignment" },
  { value: "MemberRoleReport", label: "Member Role Report" },
  { value: "members", label: "Members (CRM)" },
  { value: "MyJobPostings", label: "My Job Postings" },
  { value: "MyOrganisation", label: "My Organisation" },
  { value: "MyTickets", label: "My Tickets" },
  { value: "NavigationManagement", label: "Navigation Items" },
  { value: "News", label: "News" },
  { value: "NewsEditor", label: "News Editor" },
  { value: "NewsSettings", label: "News Settings" },
  { value: "NewsView", label: "News View" },
  { value: "OrganisationDirectory", label: "Organisation Directory" },
  { value: "OrganisationDirectorySettings", label: "Organisation Directory Settings" },
  { value: "OrganisationPreferences", label: "Organisation Field Permissions" },
  { value: "organisations", label: "Organisations (CRM)" },
  { value: "PageBannerManagement", label: "Page Banners" },
  { value: "PageVisibilitySettings", label: "Page Visibility Settings" },
  { value: "PortalMenuManagement", label: "Portal Menu Management" },
  { value: "PortalNavigationManagement", label: "Portal Navigation Management" },
  { value: "PostJob", label: "Post Job" },
  { value: "Preferences", label: "User Preferences" },
  { value: "PreferenceSettings", label: "Preference Settings" },
  { value: "about-me", label: "About Me" },
  { value: "PublicAbout", label: "Public - About" },
  { value: "PublicArticles", label: "Public - Articles" },
  { value: "PublicContact", label: "Public - Contact" },
  { value: "PublicEvents", label: "Public - Events" },
  { value: "PublicNews", label: "Public - News" },
  { value: "PublicResources", label: "Public - Resources" },
  { value: "Resources", label: "Resources" },
  { value: "ResourceManagement", label: "Resource Management" },
  { value: "ResourceSettings", label: "Resource Settings" },
  { value: "RoleManagement", label: "Role Management" },
  { value: "SiteMap", label: "Site Map" },
  { value: "Support", label: "Support" },
  { value: "SupportManagement", label: "Support Management" },
  { value: "TagManagement", label: "Tag Management" },
  { value: "Team", label: "Team" },
  { value: "TeamEngagementReport", label: "Team Engagement Report" },
  { value: "TeamInviteSettings", label: "Team Invite Settings" },
  { value: "TeamMemberManagement", label: "Team Member Management" },
  { value: "TeamSettings", label: "Team Settings" },
  { value: "TicketSalesAnalytics", label: "Ticket Sales Analytics" },
  { value: "TourManagement", label: "Tour Management" },
  { value: "TrainingFundManagement", label: "Training Fund Management" },
  { value: "UnpackedInternationalEmployability", label: "Unpacked International Employability" },
  { value: "VoucherManagement", label: "Voucher Management" },
  { value: "ViewPage", label: "View Page" },
  { value: "WallOfFameManagement", label: "Wall of Fame" },
  { value: "WorkflowManagement", label: "Workflow Management" },
  { value: "ZoomWebinarProvisioning", label: "Zoom Webinar Management" },
  { value: "SpeakerManagement", label: "Speaker Management" }
];

export default function PortalMenuManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [expandedItems, setExpandedItems] = useState({});
  const [pageSelectOpen, setPageSelectOpen] = useState(false);
  const [roleAccessOpen, setRoleAccessOpen] = useState(false);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('system.portal-menu')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: menuItems = [], isLoading } = useQuery({
    queryKey: ['portal-menu'],
    queryFn: () => base44.entities.PortalMenu.list('display_order'),
    refetchOnMount: false
  });

  // Fetch published IEdit pages from CMS
  const { data: ieditPages = [] } = useQuery({
    queryKey: ['iedit-pages-published'],
    queryFn: async () => {
      const pages = await base44.entities.IEditPage.filter({ status: 'published' });
      return pages.map(page => ({ value: page.slug, label: `CMS: ${page.title}` }));
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch active dynamic directories
  const { data: dynamicDirectories = [] } = useQuery({
    queryKey: ['dynamic-directories-for-nav'],
    queryFn: async () => {
      try {
        const directories = await base44.entities.DynamicDirectory.list({
          filter: { is_active: true }
        });
        return (directories || []).map(dir => ({
          value: `directory/${dir.slug}`,
          label: `Directory: ${dir.name}`
        }));
      } catch {
        return [];
      }
    },
    staleTime: 60 * 1000,
  });

  // Combine built-in pages with dynamic CMS pages and dynamic directories
  const availablePages = useMemo(() => {
    return [
      { value: "_none", label: "No Page (Parent Menu)" },
      ...builtInPages,
      ...ieditPages,
      ...dynamicDirectories
    ].sort((a, b) => {
      // Keep "_none" at top
      if (a.value === "_none") return -1;
      if (b.value === "_none") return 1;
      return a.label.localeCompare(b.label);
    });
  }, [ieditPages, dynamicDirectories]);

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.PortalMenu.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-menu'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Menu item created');
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.PortalMenu.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-menu'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Menu item updated');
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.PortalMenu.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-menu'] });
      toast.success('Menu item deleted');
    }
  });

  // Build hierarchy for display
  const buildHierarchy = (section) => {
    const sectionItems = menuItems.filter(item => item.section === section && item.is_active);
    const topLevel = sectionItems
      .filter(item => !item.parent_id)
      .sort((a, b) => a.display_order - b.display_order);
    
    return topLevel.map(parent => ({
      ...parent,
      children: sectionItems
        .filter(child => child.parent_id === parent.id)
        .sort((a, b) => a.display_order - b.display_order)
    }));
  };

  const userMenu = useMemo(() => buildHierarchy('user'), [menuItems]);
  const adminMenu = useMemo(() => buildHierarchy('admin'), [menuItems]);

  const handleCreate = (section, parentId = null) => {
    // Find max display_order among siblings, default to -1 if no siblings
    const siblings = menuItems.filter(i => i.section === section && i.parent_id === (parentId || ""));
    const maxOrder = siblings.length > 0 
      ? Math.max(...siblings.map(s => s.display_order || 0))
      : -1;
    
    setEditingItem({
      title: "",
      url: "",
      icon: "Menu",
      feature_id: "",
      section,
      parent_id: parentId || "",
      display_order: maxOrder + 1,
      is_active: true
    });
    setShowDialog(true);
  };

  const handleEdit = (item) => {
    setEditingItem({ ...item });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingItem.title) {
      toast.error('Title is required');
      return;
    }

    // Use manually selected feature_id if set, otherwise auto-generate
    let featureId = editingItem.feature_id;
    if (!featureId) {
      const section = editingItem.section;
      if (editingItem.url) {
        featureId = `page_${section}_${editingItem.url}`;
      } else {
        // For parent menus, use title converted to PascalCase
        featureId = `page_${section}_${editingItem.title.replace(/\s+/g, '')}`;
      }
    }

    const data = {
      title: editingItem.title,
      url: editingItem.url || "",
      icon: editingItem.icon,
      feature_id: featureId,
      section: editingItem.section,
      parent_id: editingItem.parent_id || "",
      display_order: editingItem.display_order,
      is_active: editingItem.is_active
    };

    if (editingItem.id) {
      updateMutation.mutate({ id: editingItem.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleDelete = (item) => {
    const hasChildren = menuItems.some(i => i.parent_id === item.id);
    if (hasChildren) {
      toast.error('Cannot delete menu item with sub-items');
      return;
    }

    if (confirm(`Delete "${item.title}"?`)) {
      deleteMutation.mutate(item.id);
    }
  };

  const moveItem = async (itemId, direction) => {
    const item = menuItems.find(i => i.id === itemId);
    if (!item) return;

    // Normalize parent_id comparison (treat null, undefined, "" as equivalent)
    const normalizeParentId = (parentId) => parentId || "";
    const itemParentId = normalizeParentId(item.parent_id);

    // Get siblings within the same section AND parent
    const siblings = menuItems
      .filter(i => i.section === item.section && normalizeParentId(i.parent_id) === itemParentId && i.is_active)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

    const currentIndex = siblings.findIndex(i => i.id === itemId);
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

    if (newIndex < 0 || newIndex >= siblings.length) return;

    // Reorder the array by moving the item to the new position
    const reorderedSiblings = [...siblings];
    const [movedItem] = reorderedSiblings.splice(currentIndex, 1);
    reorderedSiblings.splice(newIndex, 0, movedItem);

    // Use section-scoped base offset to prevent collisions between sections
    // user section: 0-9999, admin section: 10000-19999
    // Also add parent-based offset for sub-items
    const sectionOffset = item.section === 'admin' ? 10000 : 0;
    const parentOffset = itemParentId ? 5000 : 0; // Sub-items get offset within section
    const baseOffset = sectionOffset + parentOffset;

    // Update all siblings with new sequential display_order values (scoped to section)
    await Promise.all(
      reorderedSiblings.map((sibling, index) => 
        base44.entities.PortalMenu.update(sibling.id, { 
          display_order: baseOffset + index 
        })
      )
    );

    await queryClient.invalidateQueries({ queryKey: ['portal-menu'] });
    toast.success('Menu order updated');
  };

  const toggleExpand = (itemId) => {
    setExpandedItems(prev => ({ ...prev, [itemId]: !prev[itemId] }));
  };

  const renderMenuItem = (item, section, isChild = false) => {
    const IconComponent = availableIcons[item.icon] || Menu;
    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = expandedItems[item.id];

    return (
      <div key={item.id} className={isChild ? 'ml-8' : ''}>
        <div className="flex items-center gap-2 p-3 bg-white border border-slate-200 rounded-lg hover:border-blue-400 transition-colors mb-2">
          {hasChildren && (
            <button
              onClick={() => toggleExpand(item.id)}
              className="p-1 hover:bg-slate-100 rounded"
            >
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          )}
          {!hasChildren && <div className="w-6" />}

          <IconComponent className="w-4 h-4 text-slate-600" />
          
          <div className="flex-1 min-w-0">
            <div className="font-medium text-slate-900">{item.title}</div>
            <div className="text-xs text-slate-500">{item.url || '(parent menu)'}</div>
          </div>

          {hasChildren && (
            <Badge variant="outline" className="text-xs">{item.children.length}</Badge>
          )}

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => moveItem(item.id, 'up')}
              className="h-8 w-8 p-0"
            >
              ▲
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => moveItem(item.id, 'down')}
              className="h-8 w-8 p-0"
            >
              ▼
            </Button>
            {!isChild && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCreate(section, item.id)}
                className="h-8 w-8 p-0"
              >
                <Plus className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleEdit(item)}
              className="h-8 w-8 p-0"
            >
              <Pencil className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDelete(item)}
              className="h-8 w-8 p-0 text-red-600"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {hasChildren && isExpanded && (
          <div className="ml-8 space-y-2 mb-2">
            {item.children.map(child => renderMenuItem(child, section, true))}
          </div>
        )}
      </div>
    );
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="text-center">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Portal Menu Management
          </h1>
          <p className="text-slate-600">
            Configure the portal navigation menu structure
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* User Navigation */}
          <Card>
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-blue-600" />
                  User Navigation
                </CardTitle>
                <Button
                  onClick={() => handleCreate('user')}
                  size="sm"
                  className="gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add Item
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {userMenu.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  No menu items yet
                </div>
              ) : (
                <div className="space-y-2">
                  {userMenu.map(item => renderMenuItem(item, 'user'))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Admin Navigation */}
          <Card>
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5 text-amber-600" />
                  Admin Navigation
                </CardTitle>
                <Button
                  onClick={() => handleCreate('admin')}
                  size="sm"
                  className="gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add Item
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {adminMenu.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  No menu items yet
                </div>
              ) : (
                <div className="space-y-2">
                  {adminMenu.map(item => renderMenuItem(item, 'admin'))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editingItem?.id ? 'Edit Menu Item' : 'Create Menu Item'}
              </DialogTitle>
            </DialogHeader>

            {editingItem && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Title *</Label>
                  <Input
                    value={editingItem.title}
                    onChange={(e) => setEditingItem({ ...editingItem, title: e.target.value })}
                    placeholder="e.g., Browse Events"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Page</Label>
                  <Select
                    value={editingItem.url || "_none"}
                    onValueChange={(value) => setEditingItem({ ...editingItem, url: value === "_none" ? "" : value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="No Page (Parent Menu)" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[400px]">
                      {availablePages.map((page) => (
                        <SelectItem key={page.value} value={page.value}>
                          <div className="flex flex-col">
                            <span>{page.label}</span>
                            {page.value && page.value !== "_none" && (
                              <span className="text-xs text-muted-foreground">/{page.value}</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">Leave empty if this is a parent menu with sub-items</p>
                </div>

                <div className="space-y-2">
                  <Label>Icon *</Label>
                  <Select
                    value={editingItem.icon}
                    onValueChange={(value) => setEditingItem({ ...editingItem, icon: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(availableIcons).map(iconName => {
                        const IconComp = availableIcons[iconName];
                        return (
                          <SelectItem key={iconName} value={iconName}>
                            <div className="flex items-center gap-2">
                              <IconComp className="w-4 h-4" />
                              {iconName}
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Role Access ID (for permissions)</Label>
                  <Popover open={roleAccessOpen} onOpenChange={setRoleAccessOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={roleAccessOpen}
                        className="w-full justify-between font-normal"
                        data-testid="button-role-access-select"
                      >
                        {editingItem.feature_id ? (
                          <span className="truncate">{editingItem.feature_id}</span>
                        ) : (
                          <span className="text-muted-foreground">(Auto-generate from page)</span>
                        )}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] p-0" align="start">
                      <Command shouldFilter={true}>
                        <CommandInput 
                          placeholder="Search permissions..." 
                          data-testid="input-role-access-search"
                        />
                        <ScrollArea className="h-[300px]">
                          <CommandList className="max-h-none">
                            <CommandEmpty>No permission found.</CommandEmpty>
                            <CommandGroup>
                              <CommandItem
                                value="_auto"
                                onSelect={() => {
                                  setEditingItem({ ...editingItem, feature_id: "" });
                                  setRoleAccessOpen(false);
                                }}
                                data-testid="option-role-access-auto"
                              >
                                <Check className={cn("mr-2 h-4 w-4", !editingItem.feature_id ? "opacity-100" : "opacity-0")} />
                                <span className="text-muted-foreground italic">(Auto-generate from page)</span>
                              </CommandItem>
                            </CommandGroup>
                            {groupedRoleAccessOptions.map((group) => (
                              <CommandGroup key={group.module} heading={group.module}>
                                {group.items.map((item) => (
                                  <CommandItem
                                    key={item.value}
                                    value={`${group.module} ${item.label} ${item.value}`}
                                    onSelect={() => {
                                      setEditingItem({ ...editingItem, feature_id: item.value });
                                      setRoleAccessOpen(false);
                                    }}
                                    data-testid={`option-role-access-${item.value}`}
                                  >
                                    <Check className={cn("mr-2 h-4 w-4", editingItem.feature_id === item.value ? "opacity-100" : "opacity-0")} />
                                    <div className="flex items-center gap-2">
                                      {item.type === 'module' && (
                                        <Badge variant="outline" className="text-xs px-1.5 py-0 bg-blue-50 text-blue-700 border-blue-200">Module</Badge>
                                      )}
                                      {item.type === 'page' && (
                                        <Badge variant="outline" className="text-xs px-1.5 py-0 bg-green-50 text-green-700 border-green-200">Page</Badge>
                                      )}
                                      {item.type === 'feature' && (
                                        <Badge variant="outline" className="text-xs px-1.5 py-0 bg-amber-50 text-amber-700 border-amber-200">Feature</Badge>
                                      )}
                                      <span>{item.label}</span>
                                    </div>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            ))}
                          </CommandList>
                        </ScrollArea>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-slate-500">
                    Select a Role Access ID to link this menu item to the permissions system. 
                    When blocked in Role Management, this item will be hidden.
                    {editingItem.feature_id && (
                      <span className="block mt-1 font-medium text-blue-600">
                        Current: {editingItem.feature_id}
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    checked={editingItem.is_active}
                    onCheckedChange={(checked) => setEditingItem({ ...editingItem, is_active: checked })}
                  />
                  <Label>Active</Label>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingItem?.id ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}