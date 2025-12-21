import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Navigation, Plus, Pencil, Trash2, ChevronRight, ChevronDown, Menu, Sparkles, Calendar, Building, Briefcase, FileText, Users, Home, Mail, Phone, X, Newspaper, PenLine, Globe, Folder, Image, MessageSquare, Bell, Star, Heart, Eye, Link, ExternalLink, Tag, Award, Bookmark, Clock, Search, MapPin, Video, Music, Camera, Mic, Headphones, Tv, Radio, Rss, Share2, Gift, Zap, Target, Flag, Layers, Grid, List, Layout, Monitor, Smartphone, Tablet, Laptop, Server, Database, Cloud, Lock, Key, UserCheck, UserPlus, UserMinus, Users2, MessageCircle, Send, Inbox, Archive, CreditCard, Ticket, Wallet, ShoppingCart, History, Settings, BookOpen, HelpCircle, Shield, BarChart3, FileEdit, AtSign, FolderTree, Trophy, MousePointer2, Download } from "lucide-react";
import SocialIconsConfig from "../components/navigation/SocialIconsConfig";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

// Available Lucide icons for navigation
const availableIcons = [
  { name: "Calendar", component: Calendar },
  { name: "Building", component: Building },
  { name: "Briefcase", component: Briefcase },
  { name: "FileText", component: FileText },
  { name: "Users", component: Users },
  { name: "Sparkles", component: Sparkles },
  { name: "Home", component: Home },
  { name: "Mail", component: Mail },
  { name: "Phone", component: Phone },
  { name: "Menu", component: Menu },
  { name: "Navigation", component: Navigation },
  { name: "Newspaper", component: Newspaper },
  { name: "PenLine", component: PenLine },
  { name: "Globe", component: Globe },
  { name: "Folder", component: Folder },
  { name: "Image", component: Image },
  { name: "MessageSquare", component: MessageSquare },
  { name: "Bell", component: Bell },
  { name: "Star", component: Star },
  { name: "Heart", component: Heart },
  { name: "Eye", component: Eye },
  { name: "Link", component: Link },
  { name: "ExternalLink", component: ExternalLink },
  { name: "Tag", component: Tag },
  { name: "Award", component: Award },
  { name: "Bookmark", component: Bookmark },
  { name: "Clock", component: Clock },
  { name: "Search", component: Search },
  { name: "MapPin", component: MapPin },
  { name: "Video", component: Video },
  { name: "Music", component: Music },
  { name: "Camera", component: Camera },
  { name: "Mic", component: Mic },
  { name: "Headphones", component: Headphones },
  { name: "Tv", component: Tv },
  { name: "Radio", component: Radio },
  { name: "Rss", component: Rss },
  { name: "Share2", component: Share2 },
  { name: "Gift", component: Gift },
  { name: "Zap", component: Zap },
  { name: "Target", component: Target },
  { name: "Flag", component: Flag },
  { name: "Layers", component: Layers },
  { name: "Grid", component: Grid },
  { name: "List", component: List },
  { name: "Layout", component: Layout },
  { name: "Monitor", component: Monitor },
  { name: "Smartphone", component: Smartphone },
  { name: "Tablet", component: Tablet },
  { name: "Laptop", component: Laptop },
  { name: "Server", component: Server },
  { name: "Database", component: Database },
  { name: "Cloud", component: Cloud },
  { name: "Lock", component: Lock },
  { name: "Key", component: Key },
  { name: "UserCheck", component: UserCheck },
  { name: "UserPlus", component: UserPlus },
  { name: "UserMinus", component: UserMinus },
  { name: "Users2", component: Users2 },
  { name: "MessageCircle", component: MessageCircle },
  { name: "Send", component: Send },
  { name: "Inbox", component: Inbox },
  { name: "Archive", component: Archive },
  { name: "CreditCard", component: CreditCard },
  { name: "Ticket", component: Ticket },
  { name: "Wallet", component: Wallet },
  { name: "ShoppingCart", component: ShoppingCart },
  { name: "History", component: History },
  { name: "Settings", component: Settings },
  { name: "BookOpen", component: BookOpen },
  { name: "HelpCircle", component: HelpCircle },
  { name: "Shield", component: Shield },
  { name: "BarChart3", component: BarChart3 },
  { name: "FileEdit", component: FileEdit },
  { name: "AtSign", component: AtSign },
  { name: "FolderTree", component: FolderTree },
  { name: "Trophy", component: Trophy },
  { name: "MousePointer2", component: MousePointer2 },
  { name: "Download", component: Download }
];

// All available pages for navigation (matching PortalMenuManagement)
const hardcodedPublicPages = [
  { name: "AdminSetup", label: "Admin Setup" },
  { name: "Articles", label: "Articles" },
  { name: "ArticlesSettings", label: "Articles Settings" },
  { name: "ArticleEditor", label: "Article Editor" },
  { name: "ArticleView", label: "Article View" },
  { name: "AwardManagement", label: "Award Management" },
  { name: "Balances", label: "Balances" },
  { name: "Bookings", label: "Bookings" },
  { name: "BorderRadiusSettings", label: "Border Radius Settings" },
  { name: "ButtonElements", label: "Button Elements" },
  { name: "ButtonStyleManagement", label: "Button Styles" },
  { name: "BuyProgramTickets", label: "Buy Program Tickets" },
  { name: "CardDeckManagement", label: "Card Deck Management" },
  { name: "CategoryManagement", label: "Category Management" },
  { name: "Dashboard", label: "Dashboard" },
  { name: "DataExport", label: "Data Export" },
  { name: "DiscountCodeManagement", label: "Discount Code Management" },
  { name: "DynamicPage", label: "Dynamic Page" },
  { name: "EventDetails", label: "Event Details" },
  { name: "Events", label: "Events" },
  { name: "EventSettings", label: "Event Settings" },
  { name: "FileManagement", label: "File Management" },
  { name: "FloaterManagement", label: "Floater Management" },
  { name: "FormBuilder", label: "Form Builder" },
  { name: "FormManagement", label: "Form Management" },
  { name: "FormSubmissions", label: "Form Submissions" },
  { name: "FormView", label: "Form View" },
  { name: "GuestWriterManagement", label: "Guest Writer Management" },
  { name: "History", label: "History" },
  { name: "Home", label: "Home" },
  { name: "IEditPageEditor", label: "Page Editor" },
  { name: "IEditPageManagement", label: "Page Builder - Pages" },
  { name: "IEditTemplateManagement", label: "Page Builder - Templates" },
  { name: "InstalledFonts", label: "Installed Fonts" },
  { name: "JobBoard", label: "Job Board" },
  { name: "JobBoardSettings", label: "Job Board Settings" },
  { name: "JobDetails", label: "Job Details" },
  { name: "JobPostingManagement", label: "Job Posting Management" },
  { name: "JobPostSuccess", label: "Job Post Success" },
  { name: "MemberDirectory", label: "Member Directory" },
  { name: "MemberDirectorySettings", label: "Member Directory Settings" },
  { name: "MemberGroupAssignmentReport", label: "Member Group Assignment Report" },
  { name: "MemberGroupGuestManagement", label: "Member Group Guest Management" },
  { name: "MemberGroupManagement", label: "Member Group Management" },
  { name: "MemberHandleManagement", label: "Member Handle Management" },
  { name: "MemberRoleAssignment", label: "Member Role Assignment" },
  { name: "members", label: "Members (CRM)" },
  { name: "MyJobPostings", label: "My Job Postings" },
  { name: "MyTickets", label: "My Tickets" },
  { name: "NavigationManagement", label: "Navigation Items" },
  { name: "News", label: "News" },
  { name: "NewsEditor", label: "News Editor" },
  { name: "NewsSettings", label: "News Settings" },
  { name: "NewsView", label: "News View" },
  { name: "OrganisationDirectory", label: "Organisation Directory" },
  { name: "OrganisationDirectorySettings", label: "Organisation Directory Settings" },
  { name: "organisations", label: "Organisations (CRM)" },
  { name: "PageBannerManagement", label: "Page Banners" },
  { name: "PageVisibilitySettings", label: "Page Visibility Settings" },
  { name: "PortalMenuManagement", label: "Portal Menu Management" },
  { name: "PortalNavigationManagement", label: "Portal Navigation Management" },
  { name: "PostJob", label: "Post Job" },
  { name: "PreferenceSettings", label: "Preference Settings" },
  { name: "AboutMe", label: "About Me" },
  { name: "PublicAbout", label: "Public - About" },
  { name: "PublicArticles", label: "Public - Articles" },
  { name: "PublicContact", label: "Public - Contact" },
  { name: "PublicEvents", label: "Public - Events" },
  { name: "PublicNews", label: "Public - News" },
  { name: "PublicResources", label: "Public - Resources" },
  { name: "Resources", label: "Resources" },
  { name: "ResourceManagement", label: "Resource Management" },
  { name: "ResourceSettings", label: "Resource Settings" },
  { name: "RoleManagement", label: "Role Management" },
  { name: "SiteMap", label: "Site Map" },
  { name: "Support", label: "Support" },
  { name: "SupportManagement", label: "Support Management" },
  { name: "TagManagement", label: "Tag Management" },
  { name: "Team", label: "Team" },
  { name: "TeamEngagementReport", label: "Team Engagement Report" },
  { name: "TeamInviteSettings", label: "Team Invite Settings" },
  { name: "TeamMemberManagement", label: "Team Member Management" },
  { name: "TeamSettings", label: "Team Settings" },
  { name: "TicketSalesAnalytics", label: "Ticket Sales Analytics" },
  { name: "TourManagement", label: "Tour Management" },
  { name: "UnpackedInternationalEmployability", label: "Unpacked International Employability" },
  { name: "ViewPage", label: "View Page" },
  { name: "WallOfFameManagement", label: "Wall of Fame" },
  { name: "ZoomWebinarProvisioning", label: "Zoom Webinar Management" }
];

export default function NavigationManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [filterLocation, setFilterLocation] = useState("all");
  const [showIconSelector, setShowIconSelector] = useState(false);
  const [expandedItems, setExpandedItems] = useState({});

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.navigation')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: navItems = [], isLoading } = useQuery({
    queryKey: ['navigation-items'],
    queryFn: () => base44.entities.NavigationItem.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true
  });

  // Fetch published IEdit pages
  const { data: ieditPages = [] } = useQuery({
    queryKey: ['iedit-pages-published'],
    queryFn: async () => {
      const pages = await base44.entities.IEditPage.filter({ status: 'published' });
      return pages.map(page => ({ name: page.slug, label: page.title }));
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
          name: `directory/${dir.slug}`,
          label: `Directory: ${dir.name}`
        }));
      } catch {
        return [];
      }
    },
    staleTime: 60 * 1000,
  });

  // Combine hardcoded, dynamic CMS pages, and dynamic directories
  const availablePages = useMemo(() => {
    return [...hardcodedPublicPages, ...ieditPages, ...dynamicDirectories].sort((a, b) => a.label.localeCompare(b.label));
  }, [ieditPages, dynamicDirectories]);

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.NavigationItem.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['navigation-items'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Navigation item created');
    },
    onError: (error) => {
      toast.error('Failed to create item: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.NavigationItem.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['navigation-items'] });
      setShowDialog(false);
      setEditingItem(null);
      toast.success('Navigation item updated');
    },
    onError: (error) => {
      toast.error('Failed to update item: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      // Recursively delete all descendants
      const deleteWithDescendants = async (itemId) => {
        const children = navItems.filter(item => item.parent_id === itemId);
        for (const child of children) {
          await deleteWithDescendants(child.id);
        }
        await base44.entities.NavigationItem.delete(itemId);
      };
      await deleteWithDescendants(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['navigation-items'] });
      toast.success('Navigation item deleted');
    },
    onError: (error) => {
      toast.error('Failed to delete item: ' + error.message);
    }
  });

  // Build hierarchy
  const navHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return navItems
        .filter(item => item.parent_id === parentId && item.is_active)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(item => ({
          ...item,
          children: buildTree(item.id)
        }));
    };
    return buildTree(null);
  }, [navItems]);

  // Filter by location
  const filteredItems = useMemo(() => {
    if (filterLocation === "all") return navHierarchy;
    return navHierarchy.filter(item => item.location === filterLocation);
  }, [navHierarchy, filterLocation]);

  const handleCreate = (location = "main_nav", parentId = null) => {
    setEditingItem({
      title: "",
      url: "",
      link_type: "internal",
      location,
      parent_id: parentId,
      display_order: navItems.filter(i => i.location === location && i.parent_id === parentId).length,
      is_active: true,
      open_in_new_tab: false,
      icon: "",
      description: "",
      highlight_style: "none"
    });
    setShowDialog(true);
  };

  const handleEdit = (item) => {
    setEditingItem({ ...item });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingItem.title || !editingItem.url) {
      toast.error('Title and URL are required');
      return;
    }

    if (editingItem.id) {
      // Remove fields that shouldn't be sent to the API
      const { id, created_date, updated_date, created_by, children, ...dataToUpdate } = editingItem;
      updateMutation.mutate({ id, data: dataToUpdate });
    } else {
      // Also strip children from new items just in case
      const { children, ...dataToCreate } = editingItem;
      createMutation.mutate(dataToCreate);
    }
  };

  const handleDelete = (item) => {
    // Count all descendants recursively
    const countDescendants = (itemId) => {
      const children = navItems.filter(i => i.parent_id === itemId);
      return children.length + children.reduce((sum, child) => sum + countDescendants(child.id), 0);
    };
    
    const descendantsCount = countDescendants(item.id);
    const message = descendantsCount > 0
      ? `Delete "${item.title}" and its ${descendantsCount} sub-item(s)?`
      : `Delete "${item.title}"?`;
    
    if (confirm(message)) {
      deleteMutation.mutate(item.id);
    }
  };

  const handleSelectIcon = (iconName) => {
    setEditingItem({ ...editingItem, icon: iconName });
    setShowIconSelector(false);
  };

  const moveItem = async (itemId, direction) => {
    const item = navItems.find(i => i.id === itemId);
    if (!item) return;

    const siblings = navItems
      .filter(i => i.location === item.location && i.parent_id === item.parent_id)
      .sort((a, b) => {
        if (a.display_order === b.display_order) {
          return new Date(a.created_date) - new Date(b.created_date);
        }
        return a.display_order - b.display_order;
      });

    const currentIndex = siblings.findIndex(i => i.id === itemId);
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

    if (newIndex < 0 || newIndex >= siblings.length) return;

    const reorderedSiblings = [...siblings];
    const [movedItem] = reorderedSiblings.splice(currentIndex, 1);
    reorderedSiblings.splice(newIndex, 0, movedItem);

    for (let i = 0; i < reorderedSiblings.length; i++) {
      await base44.entities.NavigationItem.update(reorderedSiblings[i].id, {
        display_order: i
      });
    }

    await queryClient.invalidateQueries({ queryKey: ['navigation-items'] });
    toast.success('Navigation order updated');
  };

  const toggleExpand = (itemId) => {
    setExpandedItems(prev => ({ ...prev, [itemId]: !prev[itemId] }));
  };

  // Render item tree recursively
  const renderItemTree = (items, level = 0) => {
    return items.map((item) => {
      const IconComponent = availableIcons.find(i => i.name === item.icon)?.component;
      const hasChildren = item.children && item.children.length > 0;
      const isExpanded = expandedItems[item.id];
      const indentClass = level > 0 ? `ml-${Math.min(level * 8, 16)}` : '';
      
      return (
        <div key={item.id} className={indentClass}>
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

            {IconComponent && <IconComponent className="w-4 h-4 text-slate-600" />}
            
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-slate-900">{item.title}</span>
                <Badge className="text-xs" variant={item.location === 'top_nav' ? 'default' : 'secondary'}>
                  {item.location === 'top_nav' ? 'Top Bar' : 'Main Nav'}
                </Badge>
                {item.highlight_style === 'gradient_button' && (
                  <Badge className="text-xs bg-gradient-to-r from-purple-500 to-pink-500 text-white">
                    Featured
                  </Badge>
                )}
                {hasChildren && (
                  <Badge variant="outline" className="text-xs">
                    {item.children.length} sub-item{item.children.length > 1 ? 's' : ''}
                  </Badge>
                )}
              </div>
              <div className="text-sm text-slate-500 truncate">
                {item.link_type === 'external' ? '🔗 ' : '📄 '}{item.url}
              </div>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCreate(item.location, item.id)}
                className="h-8 px-2"
                title="Add submenu item"
              >
                <Plus className="w-4 h-4" />
              </Button>
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
              {renderItemTree(item.children, level + 1)}
            </div>
          )}
        </div>
      );
    });
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Navigation Management
            </h1>
            <p className="text-slate-600">
              Manage public header navigation items and create mega-menus
            </p>
          </div>
        </div>

        {/* Info Banner */}
        <Card className="border-blue-200 bg-blue-50 mb-6">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-blue-600 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-semibold text-blue-900 mb-1">Dynamic Navigation</h3>
                <p className="text-sm text-blue-700">
                  Create custom navigation items for the public header. Static items (Login/Logout, Member Area, Join Us button) are managed separately and will always appear in their designated positions.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Social Icons Configuration */}
        <SocialIconsConfig />

        {/* Filters and Actions */}
        <div className="flex gap-4 mb-6">
          <Select value={filterLocation} onValueChange={setFilterLocation}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Locations</SelectItem>
              <SelectItem value="top_nav">Top Navigation Bar</SelectItem>
              <SelectItem value="main_nav">Main Navigation Bar</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex gap-2 ml-auto">
            <Button onClick={() => handleCreate('top_nav')} variant="outline">
              <Plus className="w-4 h-4 mr-2" />
              Add Top Nav Item
            </Button>
            <Button onClick={() => handleCreate('main_nav')} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Add Main Nav Item
            </Button>
          </div>
        </div>

        {/* Navigation Items List */}
        {isLoading ? (
          <Card>
            <CardContent className="p-12 text-center">
              <p className="text-slate-600">Loading navigation items...</p>
            </CardContent>
          </Card>
        ) : filteredItems.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Navigation className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Navigation Items</h3>
              <p className="text-slate-600 mb-6">
                {filterLocation === "all" 
                  ? "Create your first navigation item to get started"
                  : `No items in ${filterLocation === 'top_nav' ? 'Top Navigation' : 'Main Navigation'}`}
              </p>
              <Button onClick={() => handleCreate('main_nav')} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Item
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-6">
              <div className="space-y-3">
                {renderItemTree(filteredItems)}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingItem?.id ? 'Edit Navigation Item' : 'Create Navigation Item'}
              </DialogTitle>
            </DialogHeader>

            {editingItem && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    value={editingItem.title}
                    onChange={(e) => setEditingItem({ ...editingItem, title: e.target.value })}
                    placeholder="e.g., About Us"
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="link_type">Link Type</Label>
                    <Select
                      value={editingItem.link_type}
                      onValueChange={(value) => setEditingItem({ ...editingItem, link_type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="internal">Internal Page</SelectItem>
                        <SelectItem value="external">External URL</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="location">Navigation Bar</Label>
                    <Select
                      value={editingItem.location}
                      onValueChange={(value) => setEditingItem({ ...editingItem, location: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="top_nav">Top Navigation Bar</SelectItem>
                        <SelectItem value="main_nav">Main Navigation Bar</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="url">
                    {editingItem.link_type === 'internal' ? 'Page *' : 'URL *'}
                  </Label>
                  {editingItem.link_type === 'internal' ? (
                    <Select
                      value={editingItem.url}
                      onValueChange={(value) => setEditingItem({ ...editingItem, url: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a page..." />
                      </SelectTrigger>
                      <SelectContent>
                        {availablePages.map(page => (
                          <SelectItem key={page.name} value={page.name}>
                            {page.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id="url"
                      value={editingItem.url}
                      onChange={(e) => setEditingItem({ ...editingItem, url: e.target.value })}
                      placeholder="e.g., https://example.com"
                    />
                  )}
                  <p className="text-xs text-slate-500">
                    {editingItem.link_type === 'internal' 
                      ? 'Select from available public pages'
                      : 'Enter the full URL including https://'}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="parent">Parent Item (for sub-menu)</Label>
                  <Select
                    value={editingItem.parent_id || "none"}
                    onValueChange={(value) => setEditingItem({ ...editingItem, parent_id: value === "none" ? null : value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (Top Level)</SelectItem>
                      {navItems
                        .filter(item => {
                          // Don't allow selecting self as parent
                          if (item.id === editingItem.id) return false;
                          
                          // Don't allow selecting descendants as parent (would create circular reference)
                          const isDescendant = (itemId, targetId) => {
                            if (itemId === targetId) return true;
                            const children = navItems.filter(i => i.parent_id === itemId);
                            return children.some(child => isDescendant(child.id, targetId));
                          };
                          if (editingItem.id && isDescendant(editingItem.id, item.id)) return false;
                          
                          // Only show items from same location
                          return item.location === editingItem.location;
                        })
                        .sort((a, b) => {
                          // Sort by hierarchy for better UX
                          const aLevel = navItems.filter(i => i.parent_id === a.id).length > 0 ? 0 : 1;
                          const bLevel = navItems.filter(i => i.parent_id === b.id).length > 0 ? 0 : 1;
                          if (aLevel !== bLevel) return aLevel - bLevel;
                          return a.title.localeCompare(b.title);
                        })
                        .map(item => {
                          // Show hierarchy level in the label
                          const getHierarchyPrefix = (itemId) => {
                            const parent = navItems.find(i => i.id === itemId)?.parent_id;
                            if (!parent) return '';
                            const parentItem = navItems.find(i => i.id === parent);
                            return getHierarchyPrefix(parent) + '↳ ';
                          };
                          
                          return (
                            <SelectItem key={item.id} value={item.id}>
                              {getHierarchyPrefix(item.parent_id)}{item.title}
                            </SelectItem>
                          );
                        })}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">
                    Create nested sub-menus by selecting a parent item (supports multiple levels)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Textarea
                    id="description"
                    value={editingItem.description || ''}
                    onChange={(e) => setEditingItem({ ...editingItem, description: e.target.value })}
                    placeholder="Optional description shown in mega-menu"
                    rows={2}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Icon (Optional)</Label>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => setShowIconSelector(true)}
                    >
                      {editingItem.icon ? (
                        <>
                          {React.createElement(availableIcons.find(i => i.name === editingItem.icon)?.component || Navigation, { className: "w-4 h-4 mr-2" })}
                          {editingItem.icon}
                        </>
                      ) : (
                        'Select an icon...'
                      )}
                    </Button>
                    {editingItem.icon && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingItem({ ...editingItem, icon: "" })}
                        className="w-full text-slate-600"
                      >
                        <X className="w-3 h-3 mr-1" />
                        Clear Icon
                      </Button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="highlight">Highlight Style</Label>
                    <Select
                      value={editingItem.highlight_style}
                      onValueChange={(value) => setEditingItem({ ...editingItem, highlight_style: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="gradient_button">Gradient Button</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <Switch
                      id="is_active"
                      checked={editingItem.is_active}
                      onCheckedChange={(checked) => setEditingItem({ ...editingItem, is_active: checked })}
                    />
                    <Label htmlFor="is_active" className="cursor-pointer">
                      Active (Visible on site)
                    </Label>
                  </div>

                  {editingItem.link_type === 'external' && (
                    <div className="flex items-center gap-3 flex-1">
                      <Switch
                        id="new_tab"
                        checked={editingItem.open_in_new_tab}
                        onCheckedChange={(checked) => setEditingItem({ ...editingItem, open_in_new_tab: checked })}
                      />
                      <Label htmlFor="new_tab" className="cursor-pointer">
                        Open in new tab
                      </Label>
                    </div>
                  )}
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
                {editingItem?.id ? 'Update Item' : 'Create Item'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Icon Selector Dialog */}
        <Dialog open={showIconSelector} onOpenChange={setShowIconSelector}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Select an Icon</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-4 gap-4 py-4">
              {availableIcons.map(({ name, component: IconComponent }) => (
                <button
                  key={name}
                  onClick={() => handleSelectIcon(name)}
                  className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all hover:border-blue-500 hover:bg-blue-50 ${
                    editingItem?.icon === name ? 'border-blue-600 bg-blue-50' : 'border-slate-200'
                  }`}
                >
                  <IconComponent className="w-8 h-8 text-slate-700" />
                  <span className="text-xs text-slate-600 text-center">{name}</span>
                </button>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowIconSelector(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}