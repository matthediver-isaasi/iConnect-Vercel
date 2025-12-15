import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient"; // or your actual client path
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2,
  X,
  Upload,
  User,
  Calendar,
  FileText,
  Briefcase,
  Trophy,
  Building2,
  Users,
  CalendarDays,
  Save,
  Lock,
  Eye,
  EyeOff,
  Shield,
  Check,
  AlertCircle,
  Mail,
  ClipboardList,
  Download,
  Award,
  FolderTree,
} from "lucide-react";
import { format } from "date-fns";
import ResourceFilter from "../components/resources/ResourceFilter";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useMemberAccess } from "@/hooks/useMemberAccess";

// --- List Field Editor Component ---
function ListFieldEditor({ fieldId, values = [], onChange, placeholder, disabled = false }) {
  const [inputValue, setInputValue] = useState('');
  
  // Ensure values is always a clean array with trimmed entries
  const safeValues = Array.isArray(values) ? values.map(v => String(v).trim()).filter(Boolean) : [];

  const handleAddItem = () => {
    const trimmed = inputValue.trim();
    // Check for duplicates case-insensitively
    if (!trimmed || safeValues.some(v => v.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...safeValues, trimmed]);
    setInputValue('');
  };

  const handleRemoveItem = (itemToRemove) => {
    onChange(safeValues.filter(item => item !== itemToRemove));
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddItem();
    }
  };

  return (
    <div className="space-y-2">
      {safeValues.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {safeValues.map((item, index) => (
            <Badge 
              key={index} 
              variant="secondary" 
              className="flex items-center gap-1 px-2 py-1"
              data-testid={`list-item-${fieldId}-${index}`}
            >
              <span>{item}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemoveItem(item)}
                  className="ml-1 hover:text-red-600 transition-colors"
                  data-testid={`button-remove-list-item-${fieldId}-${index}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      
      {!disabled && (
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={placeholder || 'Add item...'}
            className="flex-1"
            data-testid={`input-list-${fieldId}`}
          />
          <Button 
            type="button" 
            variant="outline" 
            onClick={handleAddItem}
            disabled={!inputValue.trim()}
            data-testid={`button-add-list-item-${fieldId}`}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Helper: upload to Supabase Storage and return public URL ---
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

// LinkedIn preference field UUID from the database
const LINKEDIN_PREFERENCE_FIELD_ID = "6d2fd088-8995-44ef-a955-c21c8b390544";

export default function PreferencesPage() {
  // Get hasBanner from layout context (since props don't work through React Router)
  const { hasBanner } = useLayoutContext();
  
  // Resource prefs
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState({});

  // Profile state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [mobile, setMobile] = useState("");
  const [landline, setLandline] = useState("");
  const [linkedIn, setLinkedIn] = useState("");
  const [biography, setBiography] = useState("");
  const [profilePhotoUrl, setProfilePhotoUrl] = useState("");
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [hasUnsavedProfile, setHasUnsavedProfile] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [showInDirectory, setShowInDirectory] = useState(true);


  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Communication preferences state
  const [updatingCommPrefs, setUpdatingCommPrefs] = useState(new Set());

  // Additional info (custom preference fields) state
  const [additionalInfoValues, setAdditionalInfoValues] = useState({});
  const [hasUnsavedAdditionalInfo, setHasUnsavedAdditionalInfo] = useState(false);
  const [isSavingAdditionalInfo, setIsSavingAdditionalInfo] = useState(false);


  const queryClient = useQueryClient();

  // --- Get current user from sessionStorage (set by Login/TestLogin) ---
  const [sessionMember, setSessionMember] = useState(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  useEffect(() => {
    const storedMember = sessionStorage.getItem('agcas_member');
    if (storedMember) {
      try {
        const parsed = JSON.parse(storedMember);
        // Check if session is still valid
        if (parsed.sessionExpiry && new Date(parsed.sessionExpiry) > new Date()) {
          setSessionMember(parsed);
        }
      } catch {
        // Ignore parse errors
      }
    }
    setSessionLoading(false);
  }, []);

  // Use session member directly as the member record (it already contains full member data)
  const currentUser = sessionMember;
  const memberRecord = sessionMember;
  const userLoading = sessionLoading;
  const memberLoading = false;
  const authError = null;
  const memberError = null;

  // --- Organization (from memberRecord.organization_id) ---
  const {
    data: organizationInfo,
    isLoading: orgLoading,
    error: orgError,
  } = useQuery({
    queryKey: ["organization", memberRecord?.organization_id],
    enabled: !!memberRecord?.organization_id,
    queryFn: async () => {
      if (!memberRecord?.organization_id) return null;
      const { data, error } = await supabase
        .from("organization")
        .select("*")
        .eq("id", memberRecord.organization_id)
        .limit(1);
      if (error) throw error;
      return data?.[0] || null;
    },
  });

  // Use useMemberAccess hook to check both role-level and member-level feature exclusions
  const { isFeatureExcluded } = useMemberAccess();

  // crude "is team member" flag – adjust if you later add a real column
  const isTeamMember =
    memberRecord?.is_team_member ?? false; // fallback to false if not present

  // --- Engagement stats (events, articles, jobs) ---
  const {
    data: engagementStats,
    isLoading: statsLoading,
  } = useQuery({
    queryKey: ["engagementStats", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) {
        return { eventsAttended: 0, articlesWritten: 0, jobsPosted: 0 };
      }
      const memberId = memberRecord.id;

      const [
        { data: bookings = [], error: bookingsError },
        { data: articles = [], error: articlesError },
        { data: jobPostings = [], error: jobsError },
      ] = await Promise.all([
        supabase
          .from("booking")
          .select("id, member_id, status")
          .eq("member_id", memberId)
          .eq("status", "confirmed"),
        supabase
          .from("blog_post")
          .select("id, author_id, status")
          .eq("author_id", memberId)
          .eq("status", "published"),
        supabase
          .from("job_posting")
          .select("id, posted_by_member_id")
          .eq("posted_by_member_id", memberId),
      ]);

      if (bookingsError) throw bookingsError;
      if (articlesError) throw articlesError;
      if (jobsError) throw jobsError;

      return {
        eventsAttended: bookings.length,
        articlesWritten: articles.length,
        jobsPosted: jobPostings.length,
      };
    },
  });

  // --- Online awards ---
  const { data: awards = [], isLoading: awardsLoading } = useQuery({
    queryKey: ["awards"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("award")
        .select("*")
        .eq("is_active", true)
        .order("level", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  // --- Offline award assignments ---
  const {
    data: offlineAssignments = [],
    isLoading: offlineAssignmentsLoading,
  } = useQuery({
    queryKey: ["offlineAssignments", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) return [];
      const { data, error } = await supabase
        .from("offline_award_assignment")
        .select("*")
        .eq("member_id", memberRecord.id);
      if (error) throw error;
      return data || [];
    },
  });

  // --- Award sublevels ---
  const { data: awardSublevels = [] } = useQuery({
    queryKey: ["awardSublevels"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("award_sublevel")
        .select("*");
      if (error) throw error;
      return data || [];
    },
  });

  // --- Member group assignments ---
  const {
    data: groupAssignments = [],
    isLoading: groupAssignmentsLoading,
  } = useQuery({
    queryKey: ["groupAssignments", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) return [];
      const { data, error } = await supabase
        .from("member_group_assignment")
        .select("*")
        .eq("member_id", memberRecord.id);
      if (error) throw error;
      return data || [];
    },
  });

  // --- Member groups ---
  const { data: memberGroups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ["memberGroups"],
    enabled: groupAssignments.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("member_group")
        .select("*")
        .eq("is_active", true);
      if (error) throw error;
      return data || [];
    },
  });

  // --- Offline awards ---
  const { data: offlineAwards = [], isLoading: offlineAwardsLoading2 } =
    useQuery({
      queryKey: ["offlineAwards"],
      queryFn: async () => {
        const { data, error } = await supabase
          .from("offline_award")
          .select("*")
          .eq("is_active", true);
        if (error) throw error;
        return data || [];
      },
    });

  // --- Engagement awards ---
  const { data: engagementAwards = [], isLoading: engagementAwardsLoading } =
    useQuery({
      queryKey: ["engagementAwards"],
      queryFn: async () => {
        const { data, error } = await supabase
          .from("engagement_award")
          .select("*")
          .eq("is_active", true);
        if (error) throw error;
        return data || [];
      },
    });

  // --- Engagement award assignments ---
  const {
    data: engagementAssignments = [],
    isLoading: engagementAssignmentsLoading,
  } = useQuery({
    queryKey: ["engagementAssignments", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) return [];
      const { data, error } = await supabase
        .from("engagement_award_assignment")
        .select("*")
        .eq("member_id", memberRecord.id);
      if (error) throw error;
      return data || [];
    },
  });

  // --- Award classifications ---
  const { data: awardClassifications = [] } = useQuery({
    queryKey: ["awardClassifications"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("award_classification")
        .select("*");
      if (error) throw error;
      return data || [];
    },
  });

  // --- Resource categories ---
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ["resourceCategories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("resource_category")
        .select("*")
        .eq("is_active", true)
        .order("display_order", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  // --- Communication categories with role assignments ---
  const { data: communicationCategories = [], isLoading: communicationCategoriesLoading } = useQuery({
    queryKey: ["communicationCategories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("communication_category")
        .select(`
          *,
          communication_category_role(role_id)
        `)
        .eq("is_active", true)
        .order("display_order", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  // --- Member's communication preferences ---
  const { data: communicationPreferences = [] } = useQuery({
    queryKey: ["communicationPreferences", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) return [];
      const { data, error } = await supabase
        .from("member_communication_preference")
        .select("*")
        .eq("member_id", memberRecord.id);
      if (error) throw error;
      return data || [];
    },
  });

  // --- Member's resource category selections (from database via API) ---
  const { data: memberResourceCategories = [], isLoading: memberResourceCategoriesLoading } = useQuery({
    queryKey: ["memberResourceCategories", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) return [];
      try {
        // Use API endpoint instead of direct Supabase to bypass RLS
        const response = await fetch(`/api/members/${memberRecord.id}/categories`);
        if (!response.ok) {
          console.error("[Preferences] Failed to load member categories:", response.status);
          return [];
        }
        const data = await response.json();
        return data || [];
      } catch (error) {
        console.error("[Preferences] Failed to load member categories:", error);
        return [];
      }
    },
  });

  // --- Preference fields (custom additional info fields) - member scope only ---
  const { data: allPreferenceFields = [], isLoading: preferenceFieldsLoading } = useQuery({
    queryKey: ["/api/entities/PreferenceField", "member"],
    queryFn: async () => {
      try {
        // Try to filter by entity_scope (requires migration to be run)
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => !f.entity_scope || f.entity_scope === 'member');
      } catch {
        // Fallback: if entity_scope column doesn't exist, fetch all active and filter client-side
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => !f.entity_scope || f.entity_scope === 'member');
        } catch {
          return [];
        }
      }
    },
  });

  // --- Fetch hidden custom field IDs for Preferences page ---
  const { data: hiddenFieldIds = [] } = useQuery({
    queryKey: ['preferences-hidden-custom-fields'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'preferences_hidden_custom_fields')
        .limit(1);
      if (error || !data?.[0]?.setting_value) return [];
      try {
        const parsed = JSON.parse(data[0].setting_value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  });

  // Filter out hidden fields from preference fields
  const preferenceFields = useMemo(() => {
    if (!allPreferenceFields.length) return [];
    return allPreferenceFields.filter(field => !hiddenFieldIds.includes(field.id));
  }, [allPreferenceFields, hiddenFieldIds]);

  // --- Fetch hidden resource category IDs for Preferences page ---
  const { data: hiddenResourceCategoryIds = [] } = useQuery({
    queryKey: ['preferences-hidden-resource-categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'preferences_hidden_resource_categories')
        .limit(1);
      if (error || !data?.[0]?.setting_value) return [];
      try {
        const parsed = JSON.parse(data[0].setting_value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  });

  // Filter out hidden resource categories
  const visibleCategories = useMemo(() => {
    if (!categories.length) return [];
    return categories.filter(category => !hiddenResourceCategoryIds.includes(category.id));
  }, [categories, hiddenResourceCategoryIds]);

  // --- Member's preference values ---
  const { data: memberPreferenceValues = [] } = useQuery({
    queryKey: ["/api/entities/MemberPreferenceValue", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) return [];
      try {
        const values = await base44.entities.MemberPreferenceValue.list({
          filter: { member_id: memberRecord.id }
        });
        return values || [];
      } catch {
        return [];
      }
    },
  });


  // --- Get member's role IDs ---
  const memberRoleIds = useMemo(() => {
    if (!memberRecord?.role_id) return [];
    // role_id can be a single ID or an array
    if (Array.isArray(memberRecord.role_id)) {
      return memberRecord.role_id;
    }
    return [memberRecord.role_id];
  }, [memberRecord?.role_id]);

  // --- Fetch roles with badge info for the member ---
  const { data: memberRoles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ["memberRolesWithBadges", memberRoleIds],
    enabled: memberRoleIds.length > 0,
    queryFn: async () => {
      if (memberRoleIds.length === 0) return [];
      const { data, error } = await supabase
        .from("role")
        .select("id, name, description, badge_image_url")
        .in("id", memberRoleIds);
      if (error) throw error;
      return data || [];
    },
  });

  // Filter roles that have badges
  const rolesWithBadges = useMemo(() => {
    return memberRoles.filter(role => role.badge_image_url);
  }, [memberRoles]);

  // --- Filter categories available to this member based on their role(s) ---
  const availableCategories = useMemo(() => {
    if (!communicationCategories.length) return [];
    
    return communicationCategories.filter(category => {
      // If no roles assigned to category, it's available to everyone
      if (!category.communication_category_role?.length) return true;
      
      // Check if member has any of the required roles
      const categoryRoleIds = category.communication_category_role.map(r => r.role_id);
      return memberRoleIds.some(roleId => categoryRoleIds.includes(roleId));
    });
  }, [communicationCategories, memberRoleIds]);

  // --- Section order and visibility for Preferences page layout ---
  const DEFAULT_SECTION_CONFIG = [
    { id: 'profile_information', visible: true },
    { id: 'password_security', visible: true },
    { id: 'communications', visible: true },
    { id: 'additional_info', visible: true },
    { id: 'engagement', visible: true },
    { id: 'resource_interests', visible: true }
  ];
  
  const { data: sectionConfig = DEFAULT_SECTION_CONFIG } = useQuery({
    queryKey: ['preferences-section-order'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'preferences_section_order')
        .limit(1);
      if (error) return DEFAULT_SECTION_CONFIG;
      if (data?.[0]?.setting_value) {
        try {
          const parsed = JSON.parse(data[0].setting_value);
          if (Array.isArray(parsed)) {
            let storedConfig;
            // Handle both old format (array of strings) and new format (array of objects)
            if (parsed.length > 0 && typeof parsed[0] === 'object') {
              // New format: [{ id: 'section_id', visible: true }, ...]
              storedConfig = parsed;
            } else {
              // Old format: ['section_id', ...] - convert to new format with all visible
              storedConfig = parsed.map(id => ({ id, visible: true }));
            }
            
            // Merge with DEFAULT_SECTION_CONFIG to include any new sections
            // that weren't in the stored config (like 'communications')
            const storedIds = storedConfig.map(s => s.id);
            const newSections = DEFAULT_SECTION_CONFIG.filter(
              defaultSection => !storedIds.includes(defaultSection.id)
            );
            
            // Add new sections at the end of the stored config
            return [...storedConfig, ...newSections];
          }
        } catch {
          return DEFAULT_SECTION_CONFIG;
        }
      }
      return DEFAULT_SECTION_CONFIG;
    },
    staleTime: 60000
  });

  // Filter to only visible sections and extract order
  const sectionOrder = sectionConfig
    .filter(section => section.visible !== false)
    .map(section => section.id);

  // --- Derived awards from stats ---
  const earnedOnlineAwards = useMemo(() => {
    if (!engagementStats || !awards || awards.length === 0) return [];
    return awards.filter((award) => {
      const stat =
        award.award_type === "events_attended"
          ? engagementStats.eventsAttended
          : award.award_type === "articles_published"
          ? engagementStats.articlesWritten
          : award.award_type === "jobs_posted"
          ? engagementStats.jobsPosted
          : 0;
      return stat >= award.threshold;
    });
  }, [engagementStats, awards]);

  const earnedOfflineAwards = useMemo(() => {
    if (!offlineAssignments || offlineAssignments.length === 0 || !offlineAwards)
      return [];
    return offlineAssignments
      .map((assignment) => {
        const award = offlineAwards.find(
          (a) => a.id === assignment.offline_award_id
        );
        if (!award) return null;
        const sublevel = assignment.sublevel_id
          ? awardSublevels.find((s) => s.id === assignment.sublevel_id)
          : null;
        return { ...award, sublevel };
      })
      .filter(Boolean)
      .sort((a, b) => (a.level || 0) - (b.level || 0));
  }, [offlineAssignments, offlineAwards, awardSublevels]);

  const earnedEngagementAwards = useMemo(() => {
    if (!engagementAssignments || engagementAssignments.length === 0 || !engagementAwards)
      return [];
    return engagementAssignments
      .map((assignment) => {
        const award = engagementAwards.find(
          (a) => a.id === assignment.engagement_award_id
        );
        if (!award) return null;
        const sublevel = assignment.sublevel_id
          ? awardSublevels.find((s) => s.id === assignment.sublevel_id)
          : null;
        return { ...award, sublevel, assignment };
      })
      .filter(Boolean)
      .sort((a, b) => (a.level || 0) - (b.level || 0));
  }, [engagementAssignments, engagementAwards, awardSublevels]);

  // --- Load profile state from memberRecord ---
  useEffect(() => {
    if (!memberRecord) return;

    setFirstName(memberRecord.first_name || "");
    setLastName(memberRecord.last_name || "");
    setJobTitle(memberRecord.job_title || "");
    setMobile(memberRecord.mobile || "");
    setLandline(memberRecord.landline || "");
    setBiography(memberRecord.biography || "");
    setProfilePhotoUrl(memberRecord.profile_photo_url || "");
    setShowInDirectory(memberRecord.show_in_directory !== false);
  }, [memberRecord]);

  // --- Load LinkedIn from preference field value ---
  useEffect(() => {
    if (memberPreferenceValues.length > 0) {
      const linkedInPref = memberPreferenceValues.find(pv => pv.field_id === LINKEDIN_PREFERENCE_FIELD_ID);
      if (linkedInPref) {
        setLinkedIn(linkedInPref.value || "");
      }
    }
  }, [memberPreferenceValues]);


  // --- Load expandedCategories from localStorage (UI state only, always load) ---
  useEffect(() => {
    const storedPrefs = localStorage.getItem('agcas_resource_preferences');
    if (storedPrefs) {
      try {
        const prefs = JSON.parse(storedPrefs);
        if (prefs.expandedCategories) {
          setExpandedCategories(prefs.expandedCategories);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }, []);

  // --- Load category preferences from database (member_resource_category table) ---
  useEffect(() => {
    if (memberResourceCategoriesLoading) return;
    
    if (memberResourceCategories.length > 0) {
      // Convert database records to the format used by the UI:
      // Each record has resource_category_id and subcategory_name
      // The UI uses format: "categoryId" for category-only or "categoryId|subcategoryName" for subcategory
      const selections = memberResourceCategories.map(record => {
        if (record.subcategory_name) {
          return `${record.resource_category_id}|${record.subcategory_name}`;
        }
        return record.resource_category_id;
      });
      setSelectedSubcategories(selections);
    } else {
      // No database records - check localStorage for legacy selectedSubcategories (migration path)
      const storedPrefs = localStorage.getItem('agcas_resource_preferences');
      if (storedPrefs) {
        try {
          const prefs = JSON.parse(storedPrefs);
          if (prefs.selectedSubcategories) {
            setSelectedSubcategories(prefs.selectedSubcategories);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }, [memberResourceCategories, memberResourceCategoriesLoading]);

  // --- Load additional info values from memberPreferenceValues ---
  useEffect(() => {
    if (memberPreferenceValues.length > 0 && preferenceFields.length > 0) {
      const valuesMap = {};
      memberPreferenceValues.forEach(pv => {
        const field = preferenceFields.find(f => f.id === pv.field_id);
        if (field) {
          // For picklist and list, parse as array with defensive handling
          if ((field.field_type === 'picklist' || field.field_type === 'list') && pv.value) {
            try {
              const parsed = JSON.parse(pv.value);
              // Ensure it's an array, normalize values
              valuesMap[pv.field_id] = Array.isArray(parsed) 
                ? parsed.map(v => String(v).trim()).filter(Boolean)
                : [];
            } catch {
              console.warn(`Failed to parse ${field.field_type} value for field ${pv.field_id}, defaulting to empty array`);
              valuesMap[pv.field_id] = [];
            }
          } else {
            valuesMap[pv.field_id] = pv.value || '';
          }
        }
      });
      setAdditionalInfoValues(valuesMap);
    }
  }, [memberPreferenceValues, preferenceFields]);


  // --- Mutations ---
  const savePreferencesMutation = useMutation({
    mutationFn: async (preferences) => {
      if (!memberRecord?.id) throw new Error("No member record");
      
      // Convert UI format to API format
      // UI format: "categoryId" or "categoryId|subcategoryName"
      // API format: { category_id, subcategory_name }
      const selections = preferences.selectedSubcategories.map(item => {
        if (item.includes('|')) {
          const [categoryId, subcategoryName] = item.split('|');
          return { category_id: categoryId, subcategory_name: subcategoryName };
        }
        return { category_id: item, subcategory_name: null };
      });
      
      // Save to database via API endpoint (handles diff-based updates server-side)
      const response = await fetch(`/api/members/${memberRecord.id}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections }),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to save preferences');
      }
      
      // Also save expandedCategories to localStorage (UI state only)
      localStorage.setItem('agcas_resource_preferences', JSON.stringify({ expandedCategories: preferences.expandedCategories }));
      
      return preferences;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memberResourceCategories", memberRecord?.id] });
      toast.success("Preferences saved successfully");
      setHasUnsavedChanges(false);
      setIsSaving(false);
    },
    onError: (error) => {
      console.error("[Preferences] Failed to save:", error);
      toast.error("Failed to save preferences");
      setIsSaving(false);
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: async (profileData) => {
      if (!memberRecord?.id) throw new Error("No member record");
      const { data, error } = await supabase
        .from("member")
        .update(profileData)
        .eq("id", memberRecord.id)
        .select()
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    onSuccess: (updatedMember) => {
      // Update session storage with new member data so it persists on page refresh
      if (updatedMember) {
        const storedMember = sessionStorage.getItem('agcas_member');
        if (storedMember) {
          try {
            const parsed = JSON.parse(storedMember);
            const updatedSession = { ...parsed, ...updatedMember };
            sessionStorage.setItem('agcas_member', JSON.stringify(updatedSession));
            // Also update the local state
            setSessionMember(updatedSession);
          } catch {
            // Ignore parse errors
          }
        }
      }
      queryClient.invalidateQueries({ queryKey: ["memberRecord"] });
      queryClient.invalidateQueries({ queryKey: ["all-members-directory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/entities/MemberPreferenceValue", memberRecord?.id] });
      toast.success("Profile updated successfully");
      setHasUnsavedProfile(false);
      setIsSavingProfile(false);
    },
    onError: () => {
      toast.error("Failed to update profile");
      setIsSavingProfile(false);
    },
  });


  // Save additional info (custom preference fields)
  const saveAdditionalInfoMutation = useMutation({
    mutationFn: async (values) => {
      if (!memberRecord?.id) throw new Error("No member record");
      
      // For each field, upsert the value
      const updates = Object.entries(values).map(async ([fieldId, value]) => {
        const existingValue = memberPreferenceValues.find(pv => pv.field_id === fieldId);
        const field = preferenceFields.find(f => f.id === fieldId);
        
        // Convert picklist and list arrays to JSON string
        let storedValue = value;
        if ((field?.field_type === 'picklist' || field?.field_type === 'list') && Array.isArray(value)) {
          storedValue = JSON.stringify(value);
        }
        
        if (existingValue) {
          // Update existing
          return await base44.entities.MemberPreferenceValue.update(existingValue.id, {
            value: storedValue,
            updated_at: new Date().toISOString()
          });
        } else {
          // Create new
          return await base44.entities.MemberPreferenceValue.create({
            member_id: memberRecord.id,
            field_id: fieldId,
            value: storedValue
          });
        }
      });
      
      await Promise.all(updates);
      return values;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/entities/MemberPreferenceValue", memberRecord?.id] });
      toast.success("Additional information saved successfully");
      setHasUnsavedAdditionalInfo(false);
      setIsSavingAdditionalInfo(false);
    },
    onError: (error) => {
      console.error("Failed to save additional info:", error);
      toast.error("Failed to save additional information");
      setIsSavingAdditionalInfo(false);
    },
  });


  // --- Handlers ---
  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be less than 5MB");
      return;
    }

    setIsUploadingPhoto(true);
    try {
      const folder = currentUser?.id || "member";
      const publicUrl = await uploadImageToSupabase(
        file,
        "member-photos",
        folder
      );
      setProfilePhotoUrl(publicUrl);
      setHasUnsavedProfile(true);
      toast.success("Photo uploaded successfully");
    } catch (err) {
      console.error(err);
      toast.error("Failed to upload photo");
    } finally {
      setIsUploadingPhoto(false);
    }
  };


  const handleSavePreferences = () => {
    setIsSaving(true);
    const preferences = {
      selectedSubcategories,
      expandedCategories,
    };
    savePreferencesMutation.mutate(preferences);
  };

  // Handle additional info field changes
  const handleAdditionalInfoChange = (fieldId, value) => {
    setAdditionalInfoValues(prev => ({
      ...prev,
      [fieldId]: value
    }));
    setHasUnsavedAdditionalInfo(true);
  };

  // Handle picklist checkbox toggle
  const handlePicklistToggle = (fieldId, optionValue, checked) => {
    setAdditionalInfoValues(prev => {
      const currentValues = Array.isArray(prev[fieldId]) ? prev[fieldId] : [];
      const newValues = checked 
        ? [...currentValues, optionValue]
        : currentValues.filter(v => v !== optionValue);
      return { ...prev, [fieldId]: newValues };
    });
    setHasUnsavedAdditionalInfo(true);
  };

  // Save additional info
  const handleSaveAdditionalInfo = () => {
    setIsSavingAdditionalInfo(true);
    saveAdditionalInfoMutation.mutate(additionalInfoValues);
  };


  const handleSaveProfile = async () => {
    const wordCount = biography
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    if (wordCount > 500) {
      toast.error("Biography must be 500 words or less");
      return;
    }

    setIsSavingProfile(true);
    
    // Save LinkedIn to preference field (separate from member table)
    try {
      if (memberRecord?.id) {
        const existingLinkedInPref = memberPreferenceValues.find(pv => pv.field_id === LINKEDIN_PREFERENCE_FIELD_ID);
        if (existingLinkedInPref) {
          await base44.entities.MemberPreferenceValue.update(existingLinkedInPref.id, {
            value: linkedIn,
            updated_at: new Date().toISOString()
          });
        } else if (linkedIn) {
          await base44.entities.MemberPreferenceValue.create({
            member_id: memberRecord.id,
            field_id: LINKEDIN_PREFERENCE_FIELD_ID,
            value: linkedIn
          });
        }
      }
    } catch (error) {
      console.error("Failed to save LinkedIn preference:", error);
    }
    
    updateProfileMutation.mutate({
      first_name: firstName,
      last_name: lastName,
      job_title: jobTitle,
      mobile,
      landline,
      biography,
      profile_photo_url: profilePhotoUrl,
      show_in_directory: showInDirectory,
    });
  };

  const handleResetFilters = () => {
    setSelectedSubcategories([]);
    setExpandedCategories({});
    setSearchQuery("");
    setHasUnsavedChanges(true);
  };

  // Handle communication preference toggle
  const handleCommunicationToggle = async (categoryId, isSubscribed) => {
    if (!memberRecord?.id) return;
    
    setUpdatingCommPrefs(prev => new Set(prev).add(categoryId));
    
    try {
      const existingPref = communicationPreferences.find(p => p.category_id === categoryId);
      
      if (existingPref) {
        // Update existing preference
        const { error } = await supabase
          .from("member_communication_preference")
          .update({ 
            is_subscribed: isSubscribed,
            updated_at: new Date().toISOString()
          })
          .eq("id", existingPref.id);
        
        if (error) throw error;
      } else {
        // Create new preference
        const { error } = await supabase
          .from("member_communication_preference")
          .insert({
            member_id: memberRecord.id,
            category_id: categoryId,
            is_subscribed: isSubscribed
          });
        
        if (error) throw error;
      }
      
      // Invalidate query to refresh data
      queryClient.invalidateQueries({ queryKey: ["communicationPreferences", memberRecord.id] });
      toast.success(isSubscribed ? "Subscribed to updates" : "Unsubscribed from updates");
    } catch (error) {
      console.error("Failed to update communication preference:", error);
      toast.error("Failed to update preference");
    } finally {
      setUpdatingCommPrefs(prev => {
        const next = new Set(prev);
        next.delete(categoryId);
        return next;
      });
    }
  };

  // Password validation helpers
  const getPasswordStrength = (password) => {
    if (!password) return { score: 0, label: '', color: '' };
    let score = 0;
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;
    
    if (score <= 1) return { score, label: 'Weak', color: 'bg-red-500' };
    if (score <= 2) return { score, label: 'Fair', color: 'bg-orange-500' };
    if (score <= 3) return { score, label: 'Good', color: 'bg-yellow-500' };
    if (score <= 4) return { score, label: 'Strong', color: 'bg-green-500' };
    return { score, label: 'Very Strong', color: 'bg-green-600' };
  };

  const passwordRequirements = [
    { test: (p) => p.length >= 8, label: 'At least 8 characters' },
    { test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p), label: 'Upper and lowercase letters' },
    { test: (p) => /\d/.test(p), label: 'At least one number' },
    { test: (p) => /[^a-zA-Z0-9]/.test(p), label: 'At least one special character' },
  ];

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess(false);

    // Validate
    if (!currentPassword) {
      setPasswordError("Please enter your current password");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordError("New password must be different from current password");
      return;
    }

    setIsChangingPassword(true);

    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword })
      });

      const data = await response.json();

      if (data.success) {
        setPasswordSuccess(true);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        toast.success("Password changed successfully");
        
        // Clear success message after 5 seconds
        setTimeout(() => setPasswordSuccess(false), 5000);
      } else {
        setPasswordError(data.error || "Failed to change password");
      }
    } catch (err) {
      setPasswordError("An error occurred. Please try again.");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleSubcategoryToggle = (subcategory) => {
    setSelectedSubcategories((prev) => {
      const newSelection = prev.includes(subcategory)
        ? prev.filter((s) => s !== subcategory)
        : [...prev, subcategory];
      setHasUnsavedChanges(true);
      return newSelection;
    });
  };

  const handleCategoryExpand = (categoryName) => {
    setExpandedCategories((prev) => {
      const next = { ...prev, [categoryName]: !prev[categoryName] };
      setHasUnsavedChanges(true);
      return next;
    });
  };

  // Check if a subcategory is selected (format: "categoryId|subcategoryName" or just "categoryId" for flat categories)
  const isSubcategorySelected = (categoryId, subcategoryName) => {
    if (subcategoryName === null) {
      // Flat category - check for just the category ID
      return selectedSubcategories.includes(categoryId);
    }
    // Subcategory - check for "categoryId|subcategoryName"
    return selectedSubcategories.includes(`${categoryId}|${subcategoryName}`);
  };

  // Toggle a subcategory selection
  const toggleSubcategory = (categoryId, subcategoryName) => {
    const key = subcategoryName === null ? categoryId : `${categoryId}|${subcategoryName}`;
    setSelectedSubcategories(prev => {
      const exists = prev.includes(key);
      const newSelection = exists ? prev.filter(s => s !== key) : [...prev, key];
      setHasUnsavedChanges(true);
      return newSelection;
    });
  };

  // --- Track profile / org changes ---
  useEffect(() => {
    if (!memberRecord) return;
    // Get LinkedIn value from preference field
    const linkedInPref = memberPreferenceValues.find(pv => pv.field_id === LINKEDIN_PREFERENCE_FIELD_ID);
    const savedLinkedIn = linkedInPref?.value || "";
    
    const changed =
      firstName !== (memberRecord.first_name || "") ||
      lastName !== (memberRecord.last_name || "") ||
      jobTitle !== (memberRecord.job_title || "") ||
      mobile !== (memberRecord.mobile || "") ||
      landline !== (memberRecord.landline || "") ||
      linkedIn !== savedLinkedIn ||
      biography !== (memberRecord.biography || "") ||
      profilePhotoUrl !== (memberRecord.profile_photo_url || "") ||
      showInDirectory !== (memberRecord.show_in_directory !== false);
    setHasUnsavedProfile(changed);
  }, [
    firstName,
    lastName,
    jobTitle,
    mobile,
    landline,
    linkedIn,
    biography,
    profilePhotoUrl,
    showInDirectory,
    memberRecord,
    memberPreferenceValues,
  ]);


  // --- Filters / derived values ---
  const filteredCategories = categories.filter((cat) => {
    if (!searchQuery) return true;
    const searchLower = searchQuery.toLowerCase();
    return (
      cat.name.toLowerCase().includes(searchLower) ||
      (cat.subcategories &&
        cat.subcategories.some((sub) =>
          sub.toLowerCase().includes(searchLower)
        ))
    );
  });

  const getBiographyWordCount = () =>
    biography
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

  const isLoading =
    userLoading ||
    categoriesLoading ||
    memberLoading ||
    orgLoading ||
    offlineAssignmentsLoading ||
    offlineAwardsLoading2 ||
    engagementAwardsLoading ||
    engagementAssignmentsLoading ||
    groupAssignmentsLoading ||
    awardsLoading ||
    groupsLoading;

  const canEditBiography = !isFeatureExcluded(
    "edit_professional_biography"
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // --- Render section by ID for dynamic ordering ---
  const renderSection = (sectionId) => {
    switch (sectionId) {
      case 'profile_information':
        return (
          <Card key="profile_information" className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>My Information</CardTitle>
              <CardDescription>
                {sessionMember?.handle ? `@${sessionMember.handle}` : 'Update your personal details'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Profile Photo</Label>
                <div className="flex items-center gap-4">
                  <div className="w-24 h-24 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border-2 border-slate-200">
                    {profilePhotoUrl ? (
                      <img
                        src={profilePhotoUrl}
                        alt="Profile"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <User className="w-12 h-12 text-slate-400" />
                    )}
                  </div>
                  <div>
                    <input
                      type="file"
                      id="photo-upload"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isUploadingPhoto}
                      onClick={() =>
                        document.getElementById("photo-upload").click()
                      }
                    >
                      {isUploadingPhoto ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4 mr-2" />
                          Upload Photo
                        </>
                      )}
                    </Button>
                    <p className="text-xs text-slate-500 mt-1">
                      JPG, PNG or GIF. Max 5MB.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input
                    id="firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Enter your first name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input
                    id="lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Enter your last name"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="jobTitle">Job Title</Label>
                <Input
                  id="jobTitle"
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  placeholder="e.g., Careers Adviser"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="mobile">Mobile</Label>
                  <Input
                    id="mobile"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    placeholder="Enter your mobile number"
                    data-testid="input-mobile"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="landline">Landline</Label>
                  <Input
                    id="landline"
                    value={landline}
                    onChange={(e) => setLandline(e.target.value)}
                    placeholder="Enter your landline number"
                    data-testid="input-landline"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="linkedIn">LinkedIn</Label>
                <Input
                  id="linkedIn"
                  value={linkedIn}
                  onChange={(e) => setLinkedIn(e.target.value)}
                  placeholder="https://linkedin.com/in/your-profile"
                  data-testid="input-linkedin"
                />
              </div>

              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
                <div className="flex-1">
                  <Label htmlFor="show-in-directory" className="cursor-pointer">
                    Show in Member Directory
                  </Label>
                  <p className="text-xs text-slate-500 mt-1">
                    Allow other members to see your profile in the member
                    directory
                  </p>
                </div>
                <Switch
                  id="show-in-directory"
                  checked={showInDirectory}
                  onCheckedChange={setShowInDirectory}
                />
              </div>

              {memberRecord?.created_at && (
                <div className="flex items-center gap-2 p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <CalendarDays className="w-5 h-5 text-slate-500" />
                  <div>
                    <p className="text-sm text-slate-600">Member since</p>
                    <p className="text-sm font-semibold text-slate-900">
                      {format(
                        new Date(memberRecord.created_at),
                        "dd MMMM yyyy"
                      )}
                    </p>
                  </div>
                </div>
              )}

              {hasUnsavedProfile && (
                <div className="flex justify-end pt-4">
                  <Button
                    onClick={handleSaveProfile}
                    disabled={isSavingProfile}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {isSavingProfile ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        Save Profile
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );

      case 'password_security':
        return (
          <Card key="password_security" className="border-slate-200 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-blue-600" />
                <CardTitle>Password</CardTitle>
              </div>
              <CardDescription>
                Keep your account secure by using a strong password
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-6">
                {passwordSuccess && (
                  <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg">
                    <Check className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-medium text-green-800">Password updated successfully!</p>
                      <p className="text-sm text-green-700 mt-1">
                        Your password has been changed. Use your new password next time you log in.
                      </p>
                    </div>
                  </div>
                )}

                {passwordError && (
                  <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
                    <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-red-700">{passwordError}</p>
                  </div>
                )}

                <div className="grid md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    {/* Current Password */}
                    <div className="space-y-2">
                      <Label htmlFor="current-password">Current Password</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <Input
                          id="current-password"
                          type={showCurrentPassword ? "text" : "password"}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder="Enter your current password"
                          className="pl-10 pr-10"
                          data-testid="input-current-password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>

                    {/* New Password */}
                    <div className="space-y-2">
                      <Label htmlFor="new-password">New Password</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <Input
                          id="new-password"
                          type={showNewPassword ? "text" : "password"}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Enter your new password"
                          className="pl-10 pr-10"
                          data-testid="input-new-password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      
                      {/* Password Strength Indicator */}
                      {newPassword && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                              <div 
                                className={`h-full transition-all duration-300 ${getPasswordStrength(newPassword).color}`}
                                style={{ width: `${(getPasswordStrength(newPassword).score / 5) * 100}%` }}
                              />
                            </div>
                            <span className={`text-xs font-medium ${
                              getPasswordStrength(newPassword).score <= 2 ? 'text-red-600' :
                              getPasswordStrength(newPassword).score <= 3 ? 'text-yellow-600' : 'text-green-600'
                            }`}>
                              {getPasswordStrength(newPassword).label}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Confirm Password */}
                    <div className="space-y-2">
                      <Label htmlFor="confirm-password">Confirm New Password</Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <Input
                          id="confirm-password"
                          type={showNewPassword ? "text" : "password"}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Confirm your new password"
                          className="pl-10"
                          data-testid="input-confirm-password"
                        />
                      </div>
                      {confirmPassword && newPassword !== confirmPassword && (
                        <p className="text-xs text-red-600">Passwords do not match</p>
                      )}
                      {confirmPassword && newPassword === confirmPassword && (
                        <p className="text-xs text-green-600 flex items-center gap-1">
                          <Check className="h-3 w-3" /> Passwords match
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Password Requirements */}
                  <div className="space-y-4">
                    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                      <h4 className="text-sm font-medium text-slate-900 mb-3">Password Requirements</h4>
                      <ul className="space-y-2">
                        {passwordRequirements.map((req, index) => {
                          const isMet = newPassword && req.test(newPassword);
                          return (
                            <li 
                              key={index} 
                              className={`flex items-center gap-2 text-sm ${
                                isMet ? 'text-green-600' : 'text-slate-500'
                              }`}
                            >
                              {isMet ? (
                                <Check className="h-4 w-4 flex-shrink-0" />
                              ) : (
                                <div className="h-4 w-4 rounded-full border-2 border-slate-300 flex-shrink-0" />
                              )}
                              {req.label}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    
                    <p className="text-xs text-slate-500">
                      For your security, choose a password you haven't used on other websites.
                    </p>
                  </div>
                </div>

                <div className="flex justify-end pt-4 border-t border-slate-200">
                  <Button
                    type="submit"
                    disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword || newPassword !== confirmPassword}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-change-password"
                  >
                    {isChangingPassword ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Changing Password...
                      </>
                    ) : (
                      <>
                        <Lock className="w-4 h-4 mr-2" />
                        Change Password
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        );

      case 'engagement':
        if (!canEditBiography) return null;
        return (
          <Card key="engagement" className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Engagement</CardTitle>
              <CardDescription>
                Your activity and contributions to the community
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Stats */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4 border border-blue-200">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center">
                      <Calendar className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-blue-900">
                        {statsLoading
                          ? "-"
                          : engagementStats?.eventsAttended || 0}
                      </p>
                      <p className="text-xs text-blue-700">Events Attended</p>
                    </div>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-4 border border-purple-200">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-purple-600 flex items-center justify-center">
                      <FileText className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-purple-900">
                        {statsLoading
                          ? "-"
                          : engagementStats?.articlesWritten || 0}
                      </p>
                      <p className="text-xs text-purple-700">
                        Articles Published
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-green-600 flex items-center justify-center">
                      <Briefcase className="w-5 h-5 text-white" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-green-900">
                        {statsLoading
                          ? "-"
                          : engagementStats?.jobsPosted || 0}
                      </p>
                      <p className="text-xs text-green-700">Jobs Posted</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Engagement Awards */}
              {earnedEngagementAwards.length > 0 && (
                <div className="pt-4 border-t border-slate-200">
                  <div className="flex items-center gap-2 mb-4">
                    <Trophy className="w-5 h-5 text-rose-600" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      Engagement Awards
                    </h3>
                    <Badge variant="secondary">
                      {earnedEngagementAwards.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {earnedEngagementAwards.map((award, idx) => {
                      const classification = award.classification_id
                        ? awardClassifications.find(
                            (c) => c.id === award.classification_id
                          )
                        : null;
                      return (
                        <div
                          key={`engagement-${award.id}-${idx}`}
                          className="flex flex-col items-center p-3 bg-gradient-to-br from-rose-50 to-rose-100 rounded-lg border border-rose-200 hover:shadow-md transition-shadow relative"
                        >
                          {classification && (
                            <Badge
                              variant="secondary"
                              className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5"
                            >
                              {classification.name}
                            </Badge>
                          )}
                          {award.image_url ? (
                            <img
                              src={award.image_url}
                              alt={award.name}
                              className="w-12 h-12 object-contain mb-2"
                            />
                          ) : (
                            <div className="w-12 h-12 bg-gradient-to-br from-rose-400 to-rose-600 rounded-full flex items-center justify-center mb-2">
                              <Trophy className="w-6 h-6 text-white" />
                            </div>
                          )}
                          <p className="text-xs font-semibold text-center text-slate-900 line-clamp-2">
                            {award.name}
                          </p>
                          {award.sublevel && (
                            <Badge
                              variant="outline"
                              className="mt-1 text-[10px] px-1.5 py-0.5 border-rose-300 text-rose-700"
                            >
                              {award.sublevel.name}
                            </Badge>
                          )}
                          {award.description && (
                            <p className="text-[10px] text-slate-500 text-center mt-1 line-clamp-2">
                              {award.description}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Groups */}
              {groupAssignments.length > 0 && (
                <div className="pt-4 border-t border-slate-200">
                  <div className="flex items-center gap-2 mb-4">
                    <Users className="w-5 h-5 text-blue-600" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      Groups
                    </h3>
                    <Badge variant="secondary">
                      {groupAssignments.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {groupAssignments.map((assignment) => {
                      const group = memberGroups.find(
                        (g) => g.id === assignment.group_id
                      );
                      if (!group) return null;
                      return (
                        <div
                          key={assignment.id}
                          className="flex items-start gap-3 p-3 bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg border border-blue-200"
                        >
                          <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0">
                            <Users className="w-5 h-5 text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-slate-900 truncate">
                              {group.name}
                            </p>
                            <p className="text-xs text-blue-700 font-medium">
                              {assignment.group_role}
                            </p>
                            {group.description && (
                              <p className="text-xs text-slate-600 mt-1 line-clamp-2">
                                {group.description}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Role Badges */}
              {rolesWithBadges.length > 0 && (
                <div className="pt-4 border-t border-slate-200">
                  <div className="flex items-center gap-2 mb-4">
                    <Award className="w-5 h-5 text-indigo-600" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      Membership Badges
                    </h3>
                    <Badge variant="secondary">
                      {rolesWithBadges.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                    {rolesWithBadges.map((role) => (
                      <div
                        key={`badge-${role.id}`}
                        className="flex flex-col items-center p-4 bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-lg border border-indigo-200 hover:shadow-md transition-shadow"
                        data-testid={`role-badge-${role.id}`}
                      >
                        <img
                          src={role.badge_image_url}
                          alt={`${role.name} badge`}
                          className="w-24 h-24 object-contain mb-3"
                        />
                        <p className="text-sm font-semibold text-center text-slate-900 mb-1">
                          {role.name}
                        </p>
                        {role.description && (
                          <p className="text-xs text-slate-600 text-center mb-3 line-clamp-2">
                            {role.description}
                          </p>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            // Download the badge image
                            const link = document.createElement('a');
                            link.href = role.badge_image_url;
                            link.download = `${role.name.replace(/\s+/g, '-').toLowerCase()}-badge.png`;
                            link.target = '_blank';
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            toast.success("Badge download started");
                          }}
                          className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
                          data-testid={`download-badge-${role.id}`}
                        >
                          <Download className="w-4 h-4 mr-1" />
                          Download Badge
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Awards */}
              {(earnedOnlineAwards.length > 0 ||
                earnedOfflineAwards.length > 0) && (
                <div className="pt-4 border-t border-slate-200">
                  <div className="flex items-center gap-2 mb-4">
                    <Trophy className="w-5 h-5 text-amber-600" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      Awards
                    </h3>
                    <Badge variant="secondary">
                      {earnedOnlineAwards.length + earnedOfflineAwards.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {earnedOnlineAwards.map((award) => {
                      const classification = award.classification_id
                        ? awardClassifications.find(
                            (c) => c.id === award.classification_id
                          )
                        : null;
                      return (
                        <div
                          key={`online-${award.id}`}
                          className="flex flex-col items-center p-3 bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg border border-amber-200 hover:shadow-md transition-shadow relative"
                        >
                          {classification && (
                            <Badge
                              variant="secondary"
                              className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5"
                            >
                              {classification.name}
                            </Badge>
                          )}
                          {award.image_url ? (
                            <img
                              src={award.image_url}
                              alt={award.name}
                              className="w-12 h-12 object-contain mb-2"
                            />
                          ) : (
                            <div className="w-12 h-12 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full flex items-center justify-center mb-2">
                              <Trophy className="w-6 h-6 text-white" />
                            </div>
                          )}
                          <p className="text-xs font-semibold text-center text-slate-900 line-clamp-2">
                            {award.name}
                          </p>
                          {award.description && (
                            <p className="text-xs text-slate-600 text-center mt-1 line-clamp-2">
                              {award.description}
                            </p>
                          )}
                        </div>
                      );
                    })}
                    {earnedOfflineAwards.map((award, idx) => {
                      const classification = award.classification_id
                        ? awardClassifications.find(
                            (c) => c.id === award.classification_id
                          )
                        : null;
                      return (
                        <div
                          key={`offline-${award.id}-${idx}`}
                          className="flex flex-col items-center p-3 bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg border border-purple-200 hover:shadow-md transition-shadow relative"
                        >
                          {classification && (
                            <Badge
                              variant="secondary"
                              className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5"
                            >
                              {classification.name}
                            </Badge>
                          )}
                          {award.sublevel?.image_url ? (
                            <img
                              src={award.sublevel.image_url}
                              alt={award.sublevel.name}
                              className="w-12 h-12 object-contain mb-2"
                            />
                          ) : award.image_url ? (
                            <img
                              src={award.image_url}
                              alt={award.name}
                              className="w-12 h-12 object-contain mb-2"
                            />
                          ) : (
                            <div className="w-12 h-12 bg-gradient-to-br from-purple-400 to-purple-600 rounded-full flex items-center justify-center mb-2">
                              <Trophy className="w-6 h-6 text-white" />
                            </div>
                          )}
                          <p className="text-xs font-semibold text-center text-slate-900 line-clamp-2">
                            {award.name}
                          </p>
                          {award.sublevel && (
                            <Badge className="mt-1 bg-purple-600 text-white text-[10px]">
                              {award.sublevel.name}
                            </Badge>
                          )}
                          {award.period_text && (
                            <p className="text-xs text-purple-700 text-center mt-1 font-medium">
                              {award.period_text}
                            </p>
                          )}
                          {award.description && (
                            <p className="text-xs text-slate-600 text-center mt-1 line-clamp-2">
                              {award.description}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Biography */}
              <div className="space-y-2 pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between">
                  <Label htmlFor="biography">Professional Biography</Label>
                  <span
                    className={`text-xs ${
                      getBiographyWordCount() > 500
                        ? "text-red-600 font-semibold"
                        : "text-slate-500"
                    }`}
                  >
                    {getBiographyWordCount()} / 500 words
                  </span>
                </div>
                <Textarea
                  id="biography"
                  value={biography}
                  onChange={(e) => setBiography(e.target.value)}
                  placeholder="Share your professional background, expertise, and experience (max 500 words)"
                  className="min-h-[200px]"
                />
                <p className="text-xs text-slate-500">
                  This biography will be displayed on your published articles
                </p>
              </div>

              {hasUnsavedProfile && (
                <div className="flex justify-end pt-4">
                  <Button
                    onClick={handleSaveProfile}
                    disabled={
                      isSavingProfile || getBiographyWordCount() > 500
                    }
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {isSavingProfile ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        Save Biography
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );

      case 'resource_interests':
        // Separate categories with subcategories from flat categories (using filtered visibleCategories)
        const categoriesWithSubcats = visibleCategories.filter(c => 
          c.subcategories && Array.isArray(c.subcategories) && c.subcategories.length > 0
        );
        const flatCategories = visibleCategories.filter(c => 
          !c.subcategories || !Array.isArray(c.subcategories) || c.subcategories.length === 0
        );
        
        return (
          <Card key="resource_interests" className="border-slate-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FolderTree className="w-5 h-5 text-blue-600" />
                  Resource Interests
                </CardTitle>
                <CardDescription>
                  Select the categories that interest you to personalize your experience
                </CardDescription>
              </div>
              {hasUnsavedChanges && (
                <Button
                  onClick={handleSavePreferences}
                  disabled={isSaving}
                  data-testid="button-save-preferences"
                >
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : (
                    <Save className="w-4 h-4 mr-1" />
                  )}
                  Save
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {(categoriesLoading || memberResourceCategoriesLoading) ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="border border-slate-200 rounded-lg p-3 animate-pulse">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-slate-200 rounded" />
                        <div className="h-4 bg-slate-200 rounded w-32" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : visibleCategories.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No categories available</p>
              ) : (
                <div className="space-y-6">
                  <p className="text-sm text-slate-600">
                    Select the categories that interest you. These preferences help personalize content recommendations.
                  </p>
                  
                  {/* Flat categories (no subcategories) - display as selectable grid */}
                  {flatCategories.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                        <FolderTree className="w-4 h-4 text-slate-500" />
                        Categories
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {flatCategories.map(category => {
                          const isSelected = isSubcategorySelected(category.id, null);
                          return (
                            <div 
                              key={category.id} 
                              className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                                isSelected 
                                  ? 'border-blue-500 bg-blue-50' 
                                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                              }`}
                              onClick={() => toggleSubcategory(category.id, null)}
                              data-testid={`category-card-${category.id}`}
                            >
                              <div className="flex items-start gap-3">
                                <Checkbox
                                  id={`pref-cat-${category.id}`}
                                  checked={isSelected}
                                  onCheckedChange={() => toggleSubcategory(category.id, null)}
                                  data-testid={`checkbox-category-${category.id}`}
                                />
                                <div className="flex-1 min-w-0">
                                  <Label 
                                    htmlFor={`pref-cat-${category.id}`} 
                                    className="font-medium text-sm cursor-pointer text-slate-900"
                                  >
                                    {category.name}
                                  </Label>
                                  {category.description && (
                                    <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                                      {category.description}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  
                  {/* Categories with subcategories - display as headers with selectable children */}
                  {categoriesWithSubcats.map(category => {
                    const selectedCount = (category.subcategories || []).filter(subName => 
                      isSubcategorySelected(category.id, subName)
                    ).length;
                    
                    return (
                      <div key={category.id} className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                            <FolderTree className="w-4 h-4 text-slate-500" />
                            {category.name}
                          </h3>
                          {selectedCount > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              {selectedCount} selected
                            </Badge>
                          )}
                        </div>
                        {category.description && (
                          <p className="text-xs text-slate-500 -mt-1">{category.description}</p>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {(category.subcategories || []).map((subcatName, idx) => {
                            const isSelected = isSubcategorySelected(category.id, subcatName);
                            const uniqueKey = `${category.id}-${subcatName}`;
                            return (
                              <div 
                                key={uniqueKey} 
                                className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                                  isSelected 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                }`}
                                onClick={() => toggleSubcategory(category.id, subcatName)}
                                data-testid={`subcategory-card-${category.id}-${idx}`}
                              >
                                <div className="flex items-start gap-3">
                                  <Checkbox
                                    id={`pref-subcat-${uniqueKey}`}
                                    checked={isSelected}
                                    onCheckedChange={() => toggleSubcategory(category.id, subcatName)}
                                    data-testid={`checkbox-subcategory-${category.id}-${idx}`}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <Label 
                                      htmlFor={`pref-subcat-${uniqueKey}`} 
                                      className="font-medium text-sm cursor-pointer text-slate-900"
                                    >
                                      {subcatName}
                                    </Label>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  
                  {selectedSubcategories.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-slate-200">
                      <p className="text-sm text-slate-600">
                        <span className="font-medium">{selectedSubcategories.length}</span> {selectedSubcategories.length === 1 ? 'item' : 'items'} selected
                      </p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );

      case 'communications':
        return (
          <Card key="communications" className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-blue-600" />
                Communication Preferences
              </CardTitle>
              <CardDescription>
                Choose which types of communications you'd like to receive
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {communicationCategoriesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : availableCategories.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <Mail className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No communication categories available for your role.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {availableCategories.map((category) => {
                    const pref = communicationPreferences.find(p => p.category_id === category.id);
                    const isSubscribed = pref ? pref.is_subscribed : true;
                    
                    return (
                      <div 
                        key={category.id} 
                        className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200"
                        data-testid={`comm-category-${category.id}`}
                      >
                        <div className="space-y-1">
                          <h4 className="font-medium text-slate-900">{category.name}</h4>
                          {category.description && (
                            <p className="text-sm text-slate-500">{category.description}</p>
                          )}
                        </div>
                        <Switch
                          checked={isSubscribed}
                          onCheckedChange={(checked) => handleCommunicationToggle(category.id, checked)}
                          disabled={updatingCommPrefs.has(category.id)}
                          data-testid={`switch-comm-${category.id}`}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        );

      case 'additional_info':
        if (preferenceFields.length === 0 && !preferenceFieldsLoading) return null;
        return (
          <Card key="additional_info" className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-blue-600" />
                Additional Info
              </CardTitle>
              <CardDescription>
                Provide additional information about your preferences
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {preferenceFieldsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : (
                <div className="space-y-4">
                  {preferenceFields.map((field) => {
                    const fieldValue = additionalInfoValues[field.id] || '';
                    
                    return (
                      <div key={field.id} className="space-y-2" data-testid={`additional-field-${field.id}`}>
                        <Label htmlFor={`field-${field.id}`}>
                          {field.label}
                          {field.is_required && <span className="text-red-500 ml-1">*</span>}
                        </Label>
                        
                        {field.field_type === 'text' && (
                          <Input
                            id={`field-${field.id}`}
                            value={fieldValue}
                            onChange={(e) => handleAdditionalInfoChange(field.id, e.target.value)}
                            placeholder={`Enter ${field.label.toLowerCase()}`}
                            data-testid={`input-field-${field.id}`}
                          />
                        )}
                        
                        {field.field_type === 'number' && (
                          <Input
                            id={`field-${field.id}`}
                            type="number"
                            value={fieldValue}
                            onChange={(e) => handleAdditionalInfoChange(field.id, e.target.value)}
                            placeholder={`Enter ${field.label.toLowerCase()}`}
                            data-testid={`input-field-${field.id}`}
                          />
                        )}
                        
                        {field.field_type === 'decimal' && (
                          <Input
                            id={`field-${field.id}`}
                            type="number"
                            step="0.01"
                            value={fieldValue}
                            onChange={(e) => handleAdditionalInfoChange(field.id, e.target.value)}
                            placeholder={`Enter ${field.label.toLowerCase()}`}
                            data-testid={`input-field-${field.id}`}
                          />
                        )}
                        
                        {field.field_type === 'boolean' && (
                          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border">
                            <Switch
                              id={`field-${field.id}`}
                              checked={fieldValue === 'true' || fieldValue === true}
                              onCheckedChange={(checked) => handleAdditionalInfoChange(field.id, checked ? 'true' : 'false')}
                              data-testid={`switch-field-${field.id}`}
                            />
                            <Label htmlFor={`field-${field.id}`} className="cursor-pointer text-sm text-slate-700">
                              {fieldValue === 'true' || fieldValue === true ? 'Yes' : 'No'}
                            </Label>
                          </div>
                        )}
                        
                        {field.field_type === 'dropdown' && field.options && (
                          <Select 
                            value={fieldValue} 
                            onValueChange={(value) => handleAdditionalInfoChange(field.id, value)}
                          >
                            <SelectTrigger data-testid={`select-field-${field.id}`}>
                              <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
                            </SelectTrigger>
                            <SelectContent>
                              {field.options.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        
                        {field.field_type === 'picklist' && field.options && (
                          <div className="space-y-2 p-3 bg-slate-50 rounded-lg border">
                            {field.options.map((option) => {
                              const selectedValues = Array.isArray(fieldValue) ? fieldValue : [];
                              const isChecked = selectedValues.includes(option.value);
                              
                              return (
                                <div key={option.value} className="flex items-center space-x-2">
                                  <Checkbox
                                    id={`field-${field.id}-${option.value}`}
                                    checked={isChecked}
                                    onCheckedChange={(checked) => 
                                      handlePicklistToggle(field.id, option.value, checked)
                                    }
                                    data-testid={`checkbox-field-${field.id}-${option.value}`}
                                  />
                                  <label 
                                    htmlFor={`field-${field.id}-${option.value}`}
                                    className="text-sm text-slate-700 cursor-pointer"
                                  >
                                    {option.label}
                                  </label>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {field.field_type === 'list' && (
                          <ListFieldEditor
                            fieldId={field.id}
                            values={Array.isArray(fieldValue) ? fieldValue : []}
                            onChange={(newValues) => {
                              handleAdditionalInfoChange(field.id, newValues);
                            }}
                            placeholder={`Add ${field.label.toLowerCase()}...`}
                          />
                        )}
                      </div>
                    );
                  })}
                  
                  {hasUnsavedAdditionalInfo && (
                    <div className="flex justify-end pt-4 border-t border-slate-200">
                      <Button
                        onClick={handleSaveAdditionalInfo}
                        disabled={isSavingAdditionalInfo}
                        className="bg-blue-600 hover:bg-blue-700"
                        data-testid="button-save-additional-info"
                      >
                        {isSavingAdditionalInfo ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <Save className="w-4 h-4 mr-2" />
                            Save Information
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );

      default:
        return null;
    }
  };

  // --- UI with dynamic section ordering ---
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Preferences
            </h1>
            <p className="text-slate-600">
              Manage your profile and content preferences
            </p>
          </div>
        )}

        {sectionOrder.map((sectionId) => renderSection(sectionId))}
      </div>
    </div>
  );
}
