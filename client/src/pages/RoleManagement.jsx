import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { supabase } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import RoleBadge from "@/components/RoleBadge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Shield, Plus, Pencil, Trash2, AlertCircle, Mail, Upload, X, Loader2, Award, Settings, Building2, ChevronRight, ChevronDown, Calendar, CreditCard, Users, FileText, Briefcase, Layout, ClipboardList, HelpCircle, MailIcon, Cog } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { PAGE_NAMES } from "./pageRegistry.js";
import { useNavigate } from "react-router-dom";
import { ROLE_ACCESS_MAP, migrateLegacyExcludedFeatures } from "@/lib/roleAccessMap";
import { isResourceExcluded, getModuleExclusionState, getPageExclusionState, toggleResourceExclusion } from "@/lib/roleVisibility";

// Helper: upload to Supabase Storage and return public URL
async function uploadImageToSupabase(file, bucket, folderPrefix = "") {
  const fileExt = file.name.split(".").pop();
  const fileName = `${folderPrefix ? `${folderPrefix}/` : ""}${Date.now()}-${Math
    .random()
    .toString(36)
    .slice(2)}.${fileExt}`;

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(fileName, file);

  if (error) throw error;

  const { data: publicData } = supabase.storage
    .from(bucket)
    .getPublicUrl(fileName);

  return publicData.publicUrl;
}

const MODULE_ICONS = {
  "user": Users,
  "events": Calendar,
  "commerce": CreditCard,
  "membership": Users,
  "organisation": Building2,
  "content": FileText,
  "forum": Users,
  "jobs": Briefcase,
  "site-builder": Layout,
  "forms": ClipboardList,
  "support": HelpCircle,
  "communication": MailIcon,
  "admin": Shield,
  "system": Cog,
  "projects": ClipboardList,
  "crm": Users
};

export default function RoleManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [editingRole, setEditingRole] = useState(null);
  // Task #3306: per-role resource category access edits, keyed by category id
  // (true = role can see the category). Applied to the categories' own
  // excluded_role_ids on Save; untouched categories are never written.
  const [categoryAccessOverrides, setCategoryAccessOverrides] = useState({});
  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [roleToDelete, setRoleToDelete] = useState(null);
  const [accessChecked, setAccessChecked] = useState(false);
  const [isUploadingBadge, setIsUploadingBadge] = useState(false);
  const [showSegmentationSettings, setShowSegmentationSettings] = useState(false);

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Redirect non-super-admins (check both isAdmin and feature exclusion)
  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_RoleManagement')) {
        window.location.href = createPageUrl('about-me');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch role member counts for capacity display
  const { data: roleMemberCounts = {} } = useQuery({
    queryKey: ['role-member-counts'],
    queryFn: async () => {
      const response = await fetch('/api/admin/roles/member-counts', {
        credentials: 'include'
      });
      if (!response.ok) return {};
      const data = await response.json();
      return data.counts || {};
    },
    staleTime: 30000
  });

  // Fetch role segmentation field setting
  const { data: segmentationFieldSetting } = useQuery({
    queryKey: ['role-segmentation-field-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'role_segmentation_field_id');
    }
  });

  const segmentationFieldId = segmentationFieldSetting?.setting_value || null;

  // Fetch dynamic role access configuration from database
  const { data: roleAccessItems = [] } = useQuery({
    queryKey: ['role-access-items'],
    queryFn: () => base44.entities.RoleAccessItem.list(),
    staleTime: 60000
  });

  // Build access map from database items or fall back to hardcoded ROLE_ACCESS_MAP
  const accessMap = React.useMemo(() => {
    if (roleAccessItems.length === 0) {
      return ROLE_ACCESS_MAP;
    }

    // Build hierarchical structure from flat database items
    const modules = roleAccessItems.filter(item => item.item_type === 'module' && item.is_active !== false);
    const pages = roleAccessItems.filter(item => item.item_type === 'page' && item.is_active !== false);
    const features = roleAccessItems.filter(item => item.item_type === 'feature' && item.is_active !== false);

    return modules
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      .map(mod => ({
        id: mod.item_key,
        label: mod.label,
        icon: mod.icon,
        pages: pages
          .filter(p => p.parent_id === mod.id)
          .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
          .map(page => ({
            id: page.item_key,
            label: page.label,
            features: features
              .filter(f => f.parent_id === page.id)
              .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
              .map(feature => ({
                id: feature.item_key,
                label: feature.label
              }))
          }))
      }));
  }, [roleAccessItems]);

  // Fetch organization-scoped preference fields for segmentation options
  const { data: orgPreferenceFields = [] } = useQuery({
    queryKey: ['org-preference-fields-for-segmentation'],
    queryFn: async () => {
      const fields = await base44.entities.PreferenceField.list({
        filter: { entity_scope: 'organization', is_active: true }
      });
      return (fields || []).filter(f => f.field_type === 'picklist' || f.field_type === 'dropdown');
    }
  });

  // Get the currently selected segmentation field details
  const segmentationField = orgPreferenceFields.find(f => f.id === segmentationFieldId);
  
  // Get the available segment values from the segmentation field
  const segmentOptions = React.useMemo(() => {
    if (!segmentationField?.options) return [];
    try {
      const opts = typeof segmentationField.options === 'string' 
        ? JSON.parse(segmentationField.options) 
        : segmentationField.options;
      return Array.isArray(opts) ? opts : [];
    } catch {
      return [];
    }
  }, [segmentationField]);

  // Mutation to update segmentation field setting
  const updateSegmentationFieldMutation = useMutation({
    mutationFn: async (fieldId) => {
      if (segmentationFieldSetting) {
        return await base44.entities.SystemSettings.update(segmentationFieldSetting.id, {
          setting_value: fieldId || ''
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'role_segmentation_field_id',
          setting_value: fieldId || ''
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role-segmentation-field-setting'] });
      toast.success('Segmentation field updated');
      setShowSegmentationSettings(false);
    },
    onError: (error) => {
      toast.error('Failed to update segmentation field: ' + error.message);
    }
  });

  // Task #3306: resource categories for the per-role category access panel.
  // Admins are privileged, so the entity API returns all categories here.
  const { data: resourceCategories = [] } = useQuery({
    queryKey: ['resource-categories-for-roles'],
    queryFn: () => base44.entities.ResourceCategory.list(),
    staleTime: 30000
  });

  const activeResourceCategories = React.useMemo(
    () => resourceCategories
      .filter(c => c.is_active !== false)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0)),
    [resourceCategories]
  );

  // Fetch IEdit pages (custom pages) for dynamic landing page options
  const { data: ieditPages = [] } = useQuery({
    queryKey: ['iedit-pages-for-roles'],
    queryFn: () => base44.entities.IEditPage.list(),
  });

  // Define page label overrides for better display names
  const PAGE_LABELS = {
    Events: "Browse Events",
    BuyProgramTickets: "Buy Program Tickets",
    MyTickets: "My Tickets",
    MemberDirectory: "Member Directory",
    OrganisationDirectory: "Organisation Directory",
    MyOrganisation: "My Organisation",
    MyJobPostings: "My Job Postings",
    JobBoard: "Job Board",
    PublicEvents: "Public Events",
    PublicResources: "Public Resources",
    PublicArticles: "Public Articles",
    PublicNews: "Public News",
    PublicAbout: "Public About",
    PublicContact: "Public Contact",
    RoleManagement: "Role Management",
    MemberRoleAssignment: "Member Role Assignment",
    TeamMemberManagement: "Team Member Management",
    MemberHandleManagement: "Member Handle Management",
    MemberDirectorySettings: "Member Directory Settings",
    MemberGroupManagement: "Member Groups",
    MemberGroupAssignmentReport: "Member Group Report",
    MemberGroupInviteReport: "Member Group Invite Report",
    MemberGroupGuestManagement: "Member Group Guests",
    TeamEngagementReport: "Team Engagement Report",
    TeamInviteSettings: "Team Invite Settings",
    OrganisationDirectorySettings: "Organisation Directory Settings",
    EventSettings: "Event Settings",
    TicketSalesAnalytics: "Ticket Sales Analytics",
    DiscountCodeManagement: "Discount Codes",
    ArticlesSettings: "Articles Settings",
    GuestWriterManagement: "Guest Writer Management",
    NewsSettings: "News Settings",
    ResourceManagement: "Resource Management",
    ResourceSettings: "Resource Settings",
    CategoryManagement: "Category Management",
    TagManagement: "Tag Management",
    FileManagement: "File Management",
    AwardManagement: "Award Management",
    FundraisingManagement: "Fundraising Management",
    JobPostingManagement: "Job Posting Management",
    JobBoardSettings: "Job Board Settings",
    IEditPageManagement: "Page Builder",
    IEditTemplateManagement: "Element Templates",
    IEditPageEditor: "Page Editor",
    PageBannerManagement: "Page Banners",
    NavigationManagement: "Navigation Items",
    ButtonElements: "Buttons",
    ButtonStyleManagement: "Button Styles",
    BorderRadiusSettings: "Border Radius Settings",
    WallOfFameManagement: "Wall of Fame",
    InstalledFonts: "Installed Fonts",
    FloaterManagement: "Floater Management",
    FormManagement: "Form Management",
    FormSubmissions: "Form Submissions",
    FormBuilder: "Form Builder",
    FormView: "Form View",
    PortalMenuManagement: "Portal Menu Management",
    PortalNavigationManagement: "Portal Navigation (Legacy)",
    TourManagement: "Tour Management",
    DataExport: "Data Export",
    SiteMap: "Site Map",
    SupportManagement: "Support Management",
    AdminSetup: "Admin Setup",
    PostJob: "Post Job",
    JobDetails: "Job Details",
    JobPostSuccess: "Job Post Success",
    EventDetails: "Event Details",
    ArticleEditor: "Article Editor",
    ArticleView: "Article View",
    NewsEditor: "News Editor",
    NewsView: "News View",
    Login: "Login",
    DynamicPage: "Dynamic Page",
    ViewPage: "View Page",
    ParamTest: "Parameter Test",
    UnpackedInternationalEmployability: "Unpacked Int'l Employability",
    AboutMe: "About Me",
  };

  // Define page categories based on page name patterns
  const getPageCategory = (pageName) => {
    // Skip internal/test pages
    if (['testpage', 'sharon', 'content', 'icontent', 'ParamTest'].includes(pageName)) {
      return null; // Will be filtered out
    }
    
    // Public pages
    if (pageName.startsWith('Public')) return 'Public Pages';
    
    // Member-facing pages (user-facing)
    const memberPages = ['Events', 'Dashboard', 'Bookings', 'MyTickets', 'Balances', 'History', 
      'BuyProgramTickets', 'Resources', 'Articles', 'News', 'MyJobPostings', 
      'JobBoard', 'Team', 'MemberDirectory', 'OrganisationDirectory', 'MyOrganisation', 'AboutMe', 'Support', 
      'Home', 'EventDetails', 'ArticleEditor', 'ArticleView', 'NewsEditor', 'NewsView', 
      'PostJob', 'JobDetails', 'JobPostSuccess', 'FormView', 'DynamicPage', 'ViewPage', 
      'UnpackedInternationalEmployability'];
    if (memberPages.includes(pageName)) return 'Member Pages';
    
    // System pages (auth, setup)
    const systemPages = ['Login', 'AdminSetup'];
    if (systemPages.includes(pageName)) return 'System Pages';
    
    // Everything else is admin
    return 'Admin Pages';
  };

  // Generate BUILT_IN_PAGES dynamically from PAGE_NAMES registry
  const BUILT_IN_PAGES = PAGE_NAMES
    .map(pageName => {
      const category = getPageCategory(pageName);
      if (!category) return null; // Skip internal pages
      
      return {
        value: pageName,
        label: PAGE_LABELS[pageName] || pageName.replace(/([A-Z])/g, ' $1').trim(),
        category
      };
    })
    .filter(Boolean) // Remove null entries
    .sort((a, b) => {
      // Sort by category first, then by label
      if (a.category !== b.category) {
        const categoryOrder = ['Member Pages', 'Public Pages', 'Admin Pages', 'System Pages'];
        return categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
      }
      return a.label.localeCompare(b.label);
    });

  // Create combined page list with IEdit pages
  const allAvailablePages = [
    ...BUILT_IN_PAGES,
    // Add IEdit pages (custom pages) as a separate category
    ...ieditPages
      .filter(page => page.status === 'published')
      .map(page => ({
        value: page.slug,
        label: page.title,
        category: "Custom Pages"
      }))
  ];

  // Group pages by category for organized dropdown
  const pagesByCategory = allAvailablePages.reduce((acc, page) => {
    if (!acc[page.category]) {
      acc[page.category] = [];
    }
    acc[page.category].push(page);
    return acc;
  }, {});

  const createRoleMutation = useMutation({
    mutationFn: (roleData) => base44.entities.Role.create(roleData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roles'] });
      setShowDialog(false);
      setEditingRole(null);
      toast.success('Role created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create role: ' + error.message);
    }
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, roleData }) => base44.entities.Role.update(id, roleData),
    onSuccess: (updatedRole) => {
      queryClient.invalidateQueries({ queryKey: ['roles'] });
      queryClient.invalidateQueries({ queryKey: ['role-member-counts'] });
      // Keep dialog open for continued editing - update editingRole with fresh data
      if (updatedRole) {
        setEditingRole({ ...updatedRole, segment_values: updatedRole.segment_values || [] });
      }
      toast.success('Role saved successfully');
    },
    onError: (error) => {
      toast.error('Failed to update role: ' + error.message);
    }
  });

  const deleteRoleMutation = useMutation({
    mutationFn: (id) => base44.entities.Role.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['roles'] });
      setShowDeleteConfirm(false);
      setRoleToDelete(null);
      toast.success('Role deleted successfully');
    },
    onError: (error) => {
      setShowDeleteConfirm(false);
      setRoleToDelete(null);
      toast.error(error.message || 'Failed to delete role');
    }
  });

  const handleCreateNew = () => {
    // Note: is_admin is now derived from excluded_features when saving (based on admin.role-management exclusion)
    setEditingRole({
      name: "",
      description: "",
      excluded_features: ['events.pending-purchase-orders'],
      is_default: false,
      show_tours: true,
      show_bookmarks: true,
      default_landing_page: "about-me",
      layout_theme: "default",
      segment_values: [],  // Initialize empty for new roles
      max_members: null    // null = unlimited
    });
    setCategoryAccessOverrides({});
    setShowDialog(true);
  };

  const handleEdit = (role) => {
    setEditingRole({ 
      ...role,
      segment_values: role.segment_values || []  // Ensure array for editing
    });
    setCategoryAccessOverrides({});
    setShowDialog(true);
  };

  // Task #3306: whether a role can currently see a category (pending edits first).
  const roleHasCategoryAccess = (category) => {
    if (categoryAccessOverrides[category.id] !== undefined) {
      return categoryAccessOverrides[category.id];
    }
    const excluded = Array.isArray(category.excluded_role_ids) ? category.excluded_role_ids : [];
    return !editingRole?.id || !excluded.includes(editingRole.id);
  };

  const toggleCategoryAccess = (category) => {
    const next = !roleHasCategoryAccess(category);
    setCategoryAccessOverrides(prev => ({ ...prev, [category.id]: next }));
  };

  const toggleSegmentValue = (value) => {
    const current = editingRole.segment_values || [];
    const newValues = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    setEditingRole({ ...editingRole, segment_values: newValues });
  };

  const handleDelete = (role) => {
    if (role.is_system) {
      toast.error('System roles cannot be deleted');
      return;
    }
    setRoleToDelete(role);
    setShowDeleteConfirm(true);
  };

  const handleSave = async () => {
    if (!editingRole.name.trim()) {
      toast.error('Role name is required');
      return;
    }

    // If segmentation is enabled and role is marked as default, require segment values
    if (segmentationFieldId && editingRole.is_default && (!editingRole.segment_values || editingRole.segment_values.length === 0)) {
      toast.error('Default roles must have at least one organisation type selected when segmentation is enabled');
      return;
    }

    // is_admin is deprecated - access is now controlled entirely via excluded_features
    const roleData = {
      name: editingRole.name,
      description: editingRole.description,
      excluded_features: editingRole.excluded_features,
      is_default: editingRole.is_default,
      show_tours: editingRole.show_tours,
      show_bookmarks: editingRole.show_bookmarks,
      default_landing_page: editingRole.default_landing_page || "about-me",
      layout_theme: editingRole.layout_theme || "default",
      requires_effective_from_date: editingRole.requires_effective_from_date || false,
      is_tenant_admin: editingRole.is_tenant_admin || false,
      badge_image_url: editingRole.badge_image_url || null,
      badge_background_colour: editingRole.badge_background_colour || null,
      badge_text_colour: editingRole.badge_text_colour || null,
      segment_values: segmentationFieldId ? (editingRole.segment_values || []) : null,
      max_members: editingRole.max_members === '' || editingRole.max_members === null ? null : parseInt(editingRole.max_members, 10) || null
    };

    if (editingRole.id) {
      // Task #3306: persist any resource category access changes for this role
      // BEFORE saving the role, awaited, via the atomic server endpoint (an SQL
      // function adds/removes only THIS role id, so concurrent edits to other
      // roles' exclusions are never clobbered). Only toggled categories are
      // written; a category's excluded_role_ids stays empty (= visible to all)
      // unless someone deliberately restricts it.
      if (Object.keys(categoryAccessOverrides).length > 0) {
        try {
          // Server applies each change atomically (SQL add/remove of just this
          // role id), so concurrent edits to other roles' exclusions are never
          // clobbered, and retries are idempotent.
          const resp = await fetch('/api/resources/category-role-access', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              roleId: editingRole.id,
              changes: Object.entries(categoryAccessOverrides).map(([categoryId, hasAccess]) => ({ categoryId, hasAccess })),
            }),
          });
          const result = await resp.json().catch(() => ({}));
          if (!resp.ok || (result.failed && result.failed.length > 0)) {
            throw new Error(result.error
              || `${result.failed?.length || 'some'} category change(s) failed`);
          }
          setCategoryAccessOverrides({});
          queryClient.invalidateQueries({ queryKey: ['resource-categories-for-roles'] });
          queryClient.invalidateQueries({ queryKey: ['authenticated-resource-categories'] });
        } catch (err) {
          // Keep the dialog and pending toggles so the admin can retry
          // (already-applied changes are safe to resend — idempotent).
          queryClient.invalidateQueries({ queryKey: ['resource-categories-for-roles'] });
          toast.error('Some resource category access changes could not be saved: ' + (err.message || 'unknown error') + '. The role was not saved — please try again.');
          return;
        }
      }
      updateRoleMutation.mutate({ id: editingRole.id, roleData });
    } else {
      createRoleMutation.mutate(roleData);
    }
  };

  const toggleResourceAccess = (resourceId, hasAccess) => {
    const excluded = editingRole.excluded_features || [];
    // When hasAccess=true, we remove from exclusions (exclude=false)
    // When hasAccess=false, we add to exclusions (exclude=true)
    const newExcluded = toggleResourceExclusion(excluded, resourceId, !hasAccess, accessMap);
    setEditingRole({ ...editingRole, excluded_features: newExcluded });
  };

  const [expandedModules, setExpandedModules] = useState({});
  const [expandedPages, setExpandedPages] = useState({});

  const toggleModuleExpanded = (moduleId) => {
    setExpandedModules(prev => ({ ...prev, [moduleId]: !prev[moduleId] }));
  };

  const togglePageExpanded = (pageId) => {
    setExpandedPages(prev => ({ ...prev, [pageId]: !prev[pageId] }));
  };

  // Show loading state while determining access
  if (!accessChecked) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Role Management
            </h1>
            <p className="text-slate-600">
              Define roles and control what features members can access
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button 
              variant="outline" 
              onClick={() => setShowSegmentationSettings(true)}
              data-testid="button-segmentation-settings"
            >
              <Settings className="w-4 h-4 mr-2" />
              Segmentation
            </Button>
            <Button 
              variant="outline" 
              onClick={() => navigate(createPageUrl('CommunicationsManagement'))}
              data-testid="button-manage-communications"
            >
              <Mail className="w-4 h-4 mr-2" />
              Communications
            </Button>
            <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Create Role
            </Button>
          </div>
        </div>

        {/* Segmentation Info Banner */}
        {segmentationField && (
          <Card className="mb-6 border-blue-200 bg-blue-50">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Building2 className="w-5 h-5 text-blue-600" />
                <div>
                  <p className="text-sm font-medium text-blue-900">
                    Role Segmentation Enabled
                  </p>
                  <p className="text-xs text-blue-700">
                    Roles are segmented by organisation field: <span className="font-medium">{segmentationField.label}</span>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="text-center py-12">Loading roles...</div>
        ) : roles.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Shield className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Roles Yet
              </h3>
              <p className="text-slate-600 mb-6">
                Create your first role to start managing member access
              </p>
              <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Role
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {roles.map((role) => (
              <Card key={role.id} className="border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                <CardHeader className="border-b border-slate-200">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Shield className="w-5 h-5 text-blue-600" />
                        <CardTitle className="text-lg">{role.name}</CardTitle>
                      </div>
                      <div className="flex gap-2 mt-2 flex-wrap">
                        {role.is_default && (
                          <Badge className="bg-green-100 text-green-700">Default Role</Badge>
                        )}
                        {role.show_bookmarks !== false && (
                          <Badge className="bg-warning/10 text-warning">Bookmarks Enabled</Badge>
                        )}
                        {role.show_tours && (
                          <Badge className="bg-purple-100 text-purple-700">Tours Enabled</Badge>
                        )}
                        {role.requires_effective_from_date && (
                          <Badge className="bg-blue-100 text-blue-700">Effective From Required</Badge>
                        )}
                        {role.max_members !== null && role.max_members !== undefined && (
                          <Badge 
                            className={
                              roleMemberCounts[role.id] >= role.max_members 
                                ? "bg-red-100 text-red-700" 
                                : "bg-warning/10 text-warning"
                            }
                          >
                            {roleMemberCounts[role.id] || 0} / {role.max_members} members
                          </Badge>
                        )}
                      </div>
                      {/* Show segment values if segmentation is enabled */}
                      {segmentationField && role.segment_values && role.segment_values.length > 0 && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {role.segment_values.map(value => (
                            <Badge key={value} variant="outline" className="text-xs bg-slate-50">
                              {value}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-4">
                  {role.description && (
                    <p className="text-sm text-slate-600 mb-4">{role.description}</p>
                  )}

                  <div className="space-y-2 mb-4">
                    <div className="text-xs font-medium text-slate-500 uppercase">Access Level</div>
                    {(() => {
                      const excluded = role.excluded_features || [];
                      let fullAccess = 0;
                      let partial = 0;
                      let blocked = 0;
                      
                      accessMap.forEach(module => {
                        const state = getModuleExclusionState(excluded, module.id, accessMap);
                        if (state === 'none') fullAccess++;
                        else if (state === 'some') partial++;
                        else blocked++;
                      });
                      
                      if (blocked === 0 && partial === 0) {
                        return <div className="text-sm text-green-600 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-green-500"></span>
                          Full access to all modules
                        </div>;
                      } else if (blocked === accessMap.length) {
                        return <div className="text-sm text-red-600 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-red-500"></span>
                          No module access
                        </div>;
                      } else {
                        return <div className="flex gap-3 text-xs">
                          {fullAccess > 0 && (
                            <span className="flex items-center gap-1 text-green-600">
                              <span className="w-2 h-2 rounded-full bg-green-500"></span>
                              {fullAccess} full
                            </span>
                          )}
                          {partial > 0 && (
                            <span className="flex items-center gap-1 text-warning">
                              <span className="w-2 h-2 rounded-full bg-warning"></span>
                              {partial} partial
                            </span>
                          )}
                          {blocked > 0 && (
                            <span className="flex items-center gap-1 text-red-600">
                              <span className="w-2 h-2 rounded-full bg-red-500"></span>
                              {blocked} blocked
                            </span>
                          )}
                        </div>;
                      }
                    })()}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(role)}
                      className="flex-1"
                    >
                      <Pencil className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(role)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      disabled={role.is_system}
                      title={role.is_system ? 'System roles cannot be deleted' : 'Delete role'}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingRole?.id ? 'Edit Role' : 'Create New Role'}
              </DialogTitle>
            </DialogHeader>

            {editingRole && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="role-name">Role Name *</Label>
                  <Input
                    id="role-name"
                    value={editingRole.name}
                    onChange={(e) => setEditingRole({ ...editingRole, name: e.target.value })}
                    placeholder="e.g., Standard Member"
                    disabled={editingRole.is_system}
                    title={editingRole.is_system ? 'System role names cannot be changed' : ''}
                  />
                  {editingRole.is_system && (
                    <p className="text-xs text-warning">This is a system role and cannot be renamed.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="role-description">Description</Label>
                  <Textarea
                    id="role-description"
                    value={editingRole.description || ''}
                    onChange={(e) => setEditingRole({ ...editingRole, description: e.target.value })}
                    placeholder="Describe what this role includes..."
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="landing-page">Default Landing Page</Label>
                  <Select
                    value={editingRole.default_landing_page || "about-me"}
                    onValueChange={(value) => setEditingRole({ ...editingRole, default_landing_page: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select landing page" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      {Object.entries(pagesByCategory).map(([category, pages]) => (
                        <SelectGroup key={category}>
                          <SelectLabel className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{category}</SelectLabel>
                          {pages.map(page => (
                            <SelectItem key={page.value} value={page.value}>
                              {page.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">
                    The page users with this role will see after logging in
                  </p>
                </div>

                {/* New Layout Theme Selection */}
                <div className="space-y-2">
                  <Label htmlFor="layout-theme">Layout Theme</Label>
                  <Select
                    value={editingRole.layout_theme || "default"}
                    onValueChange={(value) => setEditingRole({ ...editingRole, layout_theme: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select theme" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default Theme</SelectItem>
                      <SelectItem value="new_header">New Header Theme</SelectItem>
                      <SelectItem value="bare_home">Bare Home Page Layout</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500">
                    Visual theme/layout to apply for users with this role
                  </p>
                </div>

                {/* Role Badge Upload */}
                <div className="space-y-2">
                  <Label>Role Badge</Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Upload a badge image that members with this role can display and download
                  </p>
                  
                  {editingRole.badge_image_url ? (
                    <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border">
                      <div className="relative">
                        <img 
                          src={editingRole.badge_image_url} 
                          alt="Role badge" 
                          className="w-20 h-20 object-contain rounded-lg border bg-white"
                        />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-700">Badge uploaded</p>
                        <p className="text-xs text-slate-500 mt-1 truncate max-w-[200px]">
                          {editingRole.badge_image_url.split('/').pop()}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingRole({ ...editingRole, badge_image_url: '' })}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <X className="w-4 h-4 mr-1" />
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="relative">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          
                          // Validate file size (max 5MB)
                          if (file.size > 5 * 1024 * 1024) {
                            toast.error("Badge image must be less than 5MB");
                            return;
                          }
                          
                          setIsUploadingBadge(true);
                          try {
                            const url = await uploadImageToSupabase(file, "images", "role-badges");
                            setEditingRole({ ...editingRole, badge_image_url: url });
                            toast.success("Badge uploaded successfully");
                          } catch (error) {
                            console.error("Badge upload error:", error);
                            toast.error("Failed to upload badge");
                          } finally {
                            setIsUploadingBadge(false);
                          }
                        }}
                        className="hidden"
                        id="badge-upload"
                        disabled={isUploadingBadge}
                      />
                      <label
                        htmlFor="badge-upload"
                        className={`flex items-center justify-center gap-2 p-6 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                          isUploadingBadge 
                            ? 'bg-slate-100 border-slate-300 cursor-not-allowed' 
                            : 'hover:bg-slate-50 border-slate-300 hover:border-blue-400'
                        }`}
                      >
                        {isUploadingBadge ? (
                          <>
                            <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
                            <span className="text-sm text-slate-500">Uploading...</span>
                          </>
                        ) : (
                          <>
                            <Award className="w-5 h-5 text-slate-400" />
                            <span className="text-sm text-slate-500">Click to upload badge image</span>
                          </>
                        )}
                      </label>
                    </div>
                  )}
                </div>

                {/* Role Badge Colours */}
                <div className="space-y-2">
                  <Label>Role Badge Colours</Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Choose the colours used for this role's name badge wherever it appears (members list, team cards, member details, reports). Leave unset for a neutral default.
                  </p>
                  <div className="flex flex-wrap items-end gap-6 p-4 bg-slate-50 rounded-lg border">
                    <div className="space-y-1">
                      <Label htmlFor="badge-bg-colour" className="text-xs text-slate-600">Background</Label>
                      <div className="flex items-center gap-2">
                        <input
                          id="badge-bg-colour"
                          type="color"
                          value={editingRole.badge_background_colour || "#e2e8f0"}
                          onChange={(e) => setEditingRole({ ...editingRole, badge_background_colour: e.target.value })}
                          className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                          data-testid="input-badge-background-colour"
                        />
                        <Input
                          type="text"
                          placeholder="#e2e8f0"
                          value={editingRole.badge_background_colour || ""}
                          onChange={(e) => setEditingRole({ ...editingRole, badge_background_colour: e.target.value })}
                          className="w-28 font-mono text-sm"
                          data-testid="input-badge-background-colour-text"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="badge-text-colour" className="text-xs text-slate-600">Text</Label>
                      <div className="flex items-center gap-2">
                        <input
                          id="badge-text-colour"
                          type="color"
                          value={editingRole.badge_text_colour || "#1e293b"}
                          onChange={(e) => setEditingRole({ ...editingRole, badge_text_colour: e.target.value })}
                          className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
                          data-testid="input-badge-text-colour"
                        />
                        <Input
                          type="text"
                          placeholder="#1e293b"
                          value={editingRole.badge_text_colour || ""}
                          onChange={(e) => setEditingRole({ ...editingRole, badge_text_colour: e.target.value })}
                          className="w-28 font-mono text-sm"
                          data-testid="input-badge-text-colour-text"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-slate-600">Preview</Label>
                      <div className="flex items-center h-10 gap-2">
                        <RoleBadge
                          role={editingRole}
                          name={editingRole.name?.trim() || "Role name"}
                          data-testid="preview-role-badge"
                        />
                        {(editingRole.badge_background_colour || editingRole.badge_text_colour) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingRole({ ...editingRole, badge_background_colour: "", badge_text_colour: "" })}
                            data-testid="button-clear-badge-colours"
                          >
                            <X className="w-4 h-4 mr-1" />
                            Reset
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                    <Switch
                      id="is-default"
                      checked={editingRole.is_default || false}
                      onCheckedChange={(checked) => setEditingRole({ ...editingRole, is_default: checked })}
                    />
                    <div className="flex-1">
                      <Label htmlFor="is-default" className="cursor-pointer">Default Role</Label>
                      <p className="text-xs text-slate-500 mt-1">
                        Automatically assign this role to new members
                      </p>
                    </div>
                  </div>

                  {/* Organisation Type Segmentation - shown when segmentation is enabled */}
                  {segmentationField && segmentOptions.length > 0 && (
                    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                      <div className="flex items-center gap-2 mb-3">
                        <Building2 className="w-4 h-4 text-blue-600" />
                        <Label className="font-medium">Organisation Types</Label>
                      </div>
                      <p className="text-xs text-slate-500 mb-3">
                        Select which organisation types this role applies to. 
                        {editingRole.is_default && " Default roles must have at least one type selected."}
                      </p>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {segmentOptions.map((opt) => {
                          const optValue = opt.value || opt;
                          const optLabel = opt.label || opt;
                          return (
                            <div key={optValue} className="flex items-center gap-2">
                              <Checkbox
                                id={`segment-${optValue}`}
                                checked={(editingRole.segment_values || []).includes(optValue)}
                                onCheckedChange={() => toggleSegmentValue(optValue)}
                                data-testid={`checkbox-segment-${optValue}`}
                              />
                              <label
                                htmlFor={`segment-${optValue}`}
                                className="text-sm text-slate-700 cursor-pointer"
                              >
                                {optLabel}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                      {(editingRole.segment_values || []).length > 0 && (
                        <p className="text-xs text-blue-600 mt-2">
                          {editingRole.segment_values.length} type{editingRole.segment_values.length !== 1 ? 's' : ''} selected
                        </p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-3 p-4 bg-warning/10 rounded-lg border border-warning/30">
                    <Switch
                      id="show-bookmarks"
                      checked={editingRole.show_bookmarks !== false}
                      onCheckedChange={(checked) => setEditingRole({ ...editingRole, show_bookmarks: checked })}
                    />
                    <div className="flex-1">
                      <Label htmlFor="show-bookmarks" className="cursor-pointer font-medium text-warning">Enable Bookmarks</Label>
                      <p className="text-xs text-warning mt-1">
                        Allow users with this role to bookmark content and access the bookmarks drawer
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 p-4 bg-purple-50 rounded-lg border border-purple-200">
                    <Switch
                      id="show-tours"
                      checked={editingRole.show_tours !== false}
                      onCheckedChange={(checked) => setEditingRole({ ...editingRole, show_tours: checked })}
                    />
                    <div className="flex-1">
                      <Label htmlFor="show-tours" className="cursor-pointer font-medium text-purple-900">Enable Page Tours</Label>
                      <p className="text-xs text-purple-700 mt-1">
                        Show guided tours to users with this role
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <Switch
                      id="requires-effective-from"
                      checked={editingRole.requires_effective_from_date || false}
                      onCheckedChange={(checked) => setEditingRole({ ...editingRole, requires_effective_from_date: checked })}
                    />
                    <div className="flex-1">
                      <Label htmlFor="requires-effective-from" className="cursor-pointer font-medium text-blue-900">Requires Effective From Date</Label>
                      <p className="text-xs text-blue-700 mt-1">
                        Require an "Effective From" date when assigning this role (e.g., for Alumni)
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <Switch
                      id="is-tenant-admin"
                      checked={editingRole.is_tenant_admin || false}
                      onCheckedChange={(checked) => setEditingRole({ ...editingRole, is_tenant_admin: checked })}
                      data-testid="switch-tenant-admin"
                    />
                    <div className="flex-1">
                      <Label htmlFor="is-tenant-admin" className="cursor-pointer font-medium text-blue-900">Tenant level admin</Label>
                      <p className="text-xs text-blue-700 mt-1">
                        Marks this as a tenant-level admin role. It will be hidden from the Role selector in the Edit Member modal on the Team page.
                      </p>
                    </div>
                  </div>

                  <div className="p-4 bg-warning/10 rounded-lg border border-warning/30">
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="w-4 h-4 text-warning" />
                      <Label className="font-medium text-warning">Member Limit</Label>
                    </div>
                    <p className="text-xs text-warning mb-3">
                      Set a maximum number of members that can be assigned this role. Leave empty for unlimited.
                    </p>
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min="0"
                        placeholder="No limit"
                        value={editingRole.max_members === null || editingRole.max_members === undefined ? '' : editingRole.max_members}
                        onChange={(e) => setEditingRole({ 
                          ...editingRole, 
                          max_members: e.target.value === '' ? null : e.target.value 
                        })}
                        className="w-32"
                        data-testid="input-max-members"
                      />
                      {editingRole.id && roleMemberCounts[editingRole.id] !== undefined && (
                        <span className="text-sm text-warning">
                          Currently: <strong>{roleMemberCounts[editingRole.id]}</strong> active members
                        </span>
                      )}
                    </div>
                    {editingRole.max_members && editingRole.id && roleMemberCounts[editingRole.id] >= parseInt(editingRole.max_members) && (
                      <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        This role has reached its maximum capacity
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label className="text-base">Access Control</Label>
                    <p className="text-sm text-slate-500 mt-1 mb-2">
                      Control which modules, pages, and features this role can access.
                    </p>
                    <div className="flex items-center gap-4 text-xs text-slate-600 mb-4">
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-green-500"></span>
                        Full Access
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-warning"></span>
                        Partial Access
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-red-500"></span>
                        Blocked
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2 border rounded-lg p-3 bg-slate-50/50">
                    {accessMap.map((module) => {
                      const ModuleIcon = MODULE_ICONS[module.id] || Shield;
                      const moduleExclusionState = getModuleExclusionState(editingRole.excluded_features || [], module.id, accessMap);
                      const isModuleExpanded = expandedModules[module.id];
                      
                      return (
                        <div key={module.id} className="border rounded-lg bg-white overflow-hidden">
                          <div className="flex items-center gap-2 p-3 bg-slate-100/50">
                            <button
                              type="button"
                              onClick={() => toggleModuleExpanded(module.id)}
                              className="p-1 hover:bg-slate-200 rounded transition-colors"
                              data-testid={`button-expand-module-${module.id}`}
                            >
                              {isModuleExpanded ? (
                                <ChevronDown className="w-4 h-4 text-slate-500" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-slate-500" />
                              )}
                            </button>
                            <ModuleIcon className="w-4 h-4 text-blue-600" />
                            <span className="font-medium text-slate-800 flex-1">{module.label}</span>
                            <div className="flex items-center gap-2">
                              {moduleExclusionState === 'none' && (
                                <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                                  Full Access
                                </Badge>
                              )}
                              {moduleExclusionState === 'some' && (
                                <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/30">
                                  Partial
                                </Badge>
                              )}
                              {moduleExclusionState === 'all' && (
                                <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                                  Blocked
                                </Badge>
                              )}
                              <Switch
                                checked={moduleExclusionState !== 'all'}
                                onCheckedChange={(checked) => toggleResourceAccess(module.id, checked)}
                                className={
                                  moduleExclusionState === 'none' 
                                    ? '[&[data-state=checked]]:bg-green-500' 
                                    : moduleExclusionState === 'some'
                                    ? '[&[data-state=checked]]:bg-warning'
                                    : ''
                                }
                                data-testid={`switch-module-${module.id}`}
                              />
                            </div>
                          </div>

                          {isModuleExpanded && (
                            <div className="p-2 pl-8 space-y-1 border-t bg-slate-50/30">
                              {module.pages.map((page) => {
                                const pageExclusionState = getPageExclusionState(editingRole.excluded_features || [], page.id, accessMap);
                                const isPageDisabled = (editingRole.excluded_features || []).includes(module.id);
                                const hasFeatures = page.features && page.features.length > 0;
                                const isPageExpanded = expandedPages[page.id];
                                
                                return (
                                  <div key={page.id} className={`rounded-md ${isPageDisabled ? 'opacity-50' : ''}`}>
                                    <div className="flex items-center gap-2 p-2 hover:bg-slate-100 rounded-md transition-colors">
                                      {hasFeatures ? (
                                        <button
                                          type="button"
                                          onClick={() => togglePageExpanded(page.id)}
                                          className="p-0.5 hover:bg-slate-200 rounded transition-colors"
                                          disabled={isPageDisabled}
                                          data-testid={`button-expand-page-${page.id}`}
                                        >
                                          {isPageExpanded ? (
                                            <ChevronDown className="w-3 h-3 text-slate-400" />
                                          ) : (
                                            <ChevronRight className="w-3 h-3 text-slate-400" />
                                          )}
                                        </button>
                                      ) : (
                                        <div className="w-4" />
                                      )}
                                      <span className="text-sm text-slate-700 flex-1">{page.label}</span>
                                      <div className="flex items-center gap-2">
                                        {pageExclusionState === 'none' && !isPageDisabled && (
                                          <Badge variant="outline" className="text-xs bg-green-50 text-green-600 border-green-200">
                                            Full
                                          </Badge>
                                        )}
                                        {pageExclusionState === 'some' && !isPageDisabled && (
                                          <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/30">
                                            Partial
                                          </Badge>
                                        )}
                                        {pageExclusionState === 'all' && !isPageDisabled && (
                                          <Badge variant="outline" className="text-xs bg-red-50 text-red-600 border-red-200">
                                            Blocked
                                          </Badge>
                                        )}
                                        <Switch
                                          checked={pageExclusionState !== 'all'}
                                          onCheckedChange={(checked) => toggleResourceAccess(page.id, checked)}
                                          disabled={isPageDisabled}
                                          className={`scale-90 ${
                                            pageExclusionState === 'none' 
                                              ? '[&[data-state=checked]]:bg-green-500' 
                                              : pageExclusionState === 'some'
                                              ? '[&[data-state=checked]]:bg-warning'
                                              : ''
                                          }`}
                                          data-testid={`switch-page-${page.id}`}
                                        />
                                      </div>
                                    </div>

                                    {hasFeatures && isPageExpanded && !isPageDisabled && (
                                      <div className="pl-6 py-1 space-y-1">
                                        {page.features.map((feature) => {
                                          const isFeatureDisabled = isResourceExcluded(editingRole.excluded_features, page.id, accessMap);
                                          
                                          return (
                                            <div
                                              key={feature.id}
                                              className={`flex items-center gap-2 p-2 pl-4 hover:bg-slate-100 rounded-md transition-colors ${isFeatureDisabled ? 'opacity-50' : ''}`}
                                            >
                                              <span className="text-xs text-slate-600 flex-1">{feature.label}</span>
                                              <Switch
                                                checked={!isResourceExcluded(editingRole.excluded_features, feature.id, accessMap)}
                                                onCheckedChange={(checked) => toggleResourceAccess(feature.id, checked)}
                                                disabled={isFeatureDisabled}
                                                className={`scale-75 ${
                                                  !isResourceExcluded(editingRole.excluded_features, feature.id, accessMap)
                                                    ? '[&[data-state=checked]]:bg-green-500'
                                                    : ''
                                                }`}
                                                data-testid={`switch-feature-${feature.id}`}
                                              />
                                            </div>
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
                    })}
                  </div>

                  {/* Task #3306: per-role resource category access */}
                  <div className="pt-2">
                    <Label className="text-base">Resource Category Access</Label>
                    <p className="text-sm text-slate-500 mt-1 mb-3">
                      Control which resource categories this role can see on the Resources page.
                      Categories left available to every role are visible to all members (and guests),
                      exactly as before — restrictions only apply where you untick a role.
                    </p>
                    {!editingRole.id ? (
                      <p className="text-sm text-slate-500 italic border rounded-lg p-3 bg-slate-50/50" data-testid="text-category-access-save-first">
                        Save the role first, then reopen it to configure resource category access.
                      </p>
                    ) : activeResourceCategories.length === 0 ? (
                      <p className="text-sm text-slate-500 italic border rounded-lg p-3 bg-slate-50/50" data-testid="text-no-resource-categories">
                        No resource categories have been created yet.
                      </p>
                    ) : (
                      <div className="space-y-1 border rounded-lg p-3 bg-slate-50/50">
                        {activeResourceCategories.map((category) => {
                          const hasAccess = roleHasCategoryAccess(category);
                          const otherExclusions = (Array.isArray(category.excluded_role_ids) ? category.excluded_role_ids : [])
                            .filter(r => r !== editingRole.id).length;
                          return (
                            <div key={category.id} className="flex items-center justify-between gap-3 p-2 rounded-md bg-white border">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-800 truncate">{category.name}</p>
                                <p className="text-xs text-slate-500 truncate">
                                  {(category.subcategories || []).length} subcategories
                                  {otherExclusions > 0 && ` · restricted for ${otherExclusions} other role${otherExclusions === 1 ? '' : 's'}`}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className={`text-xs ${hasAccess ? 'text-green-600' : 'text-red-600'}`}>
                                  {hasAccess ? 'Visible' : 'Hidden'}
                                </span>
                                <Switch
                                  checked={hasAccess}
                                  onCheckedChange={() => toggleCategoryAccess(category)}
                                  data-testid={`switch-category-access-${category.id}`}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingRole(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createRoleMutation.isPending || updateRoleMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingRole?.id ? 'Update Role' : 'Create Role'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Segmentation Settings Dialog */}
        <Dialog open={showSegmentationSettings} onOpenChange={setShowSegmentationSettings}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Role Segmentation Settings</DialogTitle>
              <DialogDescription>
                Configure how roles are segmented by organisation type
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Organisation Segmentation Field</Label>
                <p className="text-xs text-slate-500 mb-2">
                  Select an organisation custom field to segment roles by. When enabled, 
                  roles can be configured to apply only to specific organisation types.
                </p>
                <Select 
                  value={segmentationFieldId || '_none'} 
                  onValueChange={(value) => updateSegmentationFieldMutation.mutate(value === '_none' ? '' : value)}
                >
                  <SelectTrigger data-testid="select-segmentation-field">
                    <SelectValue placeholder="Select a field (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">
                      <span className="text-slate-500">No segmentation (all roles apply globally)</span>
                    </SelectItem>
                    {orgPreferenceFields.map(field => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {segmentationField && (
                <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                  <p className="text-sm text-blue-900 font-medium">
                    Available segment values:
                  </p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {segmentOptions.map(opt => (
                      <Badge key={opt.value || opt} variant="secondary" className="text-xs">
                        {opt.label || opt}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {segmentationFieldId && (
                <div className="p-3 bg-warning/10 rounded-lg border border-warning/30">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-warning mt-0.5" />
                    <div>
                      <p className="text-sm text-warning font-medium">Important</p>
                      <p className="text-xs text-warning mt-1">
                        When segmentation is enabled, default roles must have at least one 
                        organisation type selected. Existing roles will need to be updated 
                        with their applicable organisation types.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowSegmentationSettings(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Role</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-warning/10 rounded-lg">
                <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-warning font-medium">
                    Are you sure you want to delete "{roleToDelete?.name}"?
                  </p>
                  <p className="text-xs text-warning mt-1">
                    Any members currently assigned to this role will be automatically reassigned to the default role.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setRoleToDelete(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => roleToDelete && deleteRoleMutation.mutate(roleToDelete.id)}
                disabled={deleteRoleMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Role
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}