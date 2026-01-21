import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient";
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
  Mail,
  ArrowLeft,
  Shield,
  AlertTriangle,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useServerAdminAuth } from "@/hooks/useServerAdminAuth";
import { createPageUrl } from "@/utils";
import MemberEmails from "@/components/MemberEmails";
import WorkflowConfirmationModal from "@/components/WorkflowConfirmationModal";
import { useWorkflowConfirmation } from "@/hooks/useWorkflowConfirmation";

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

export default function AdminMemberEdit() {
  const { hasBanner } = useLayoutContext();
  const { canEditMembers, isReady: isAccessReady } = useServerAdminAuth({ 
    redirectOnDeny: true, 
    redirectPath: 'Events',
    requiredPermission: 'canEditMembers'
  });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const memberId = searchParams.get("id");
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [biography, setBiography] = useState("");
  const [profilePhotoUrl, setProfilePhotoUrl] = useState("");
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [hasUnsavedProfile, setHasUnsavedProfile] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [showInDirectory, setShowInDirectory] = useState(true);

  const [organizationLogoUrl, setOrganizationLogoUrl] = useState("");
  const [isUploadingOrgLogo, setIsUploadingOrgLogo] = useState(false);
  const [hasUnsavedOrgLogo, setHasUnsavedOrgLogo] = useState(false);

  const [updatingCommPrefs, setUpdatingCommPrefs] = useState(new Set());

  const {
    pendingWorkflows,
    showConfirmationModal,
    setShowConfirmationModal,
    checkForPendingWorkflows,
    handleConfirmWorkflow,
    handleSkipWorkflow,
    handleSkipAllWorkflows,
  } = useWorkflowConfirmation();

  const { data: memberRecord, isLoading: memberLoading, error: memberError } = useQuery({
    queryKey: ["adminMember", memberId],
    enabled: !!memberId && canEditMembers,
    queryFn: async () => {
      if (!memberId) return null;
      const response = await fetch(`/api/admin/members/${memberId}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch member');
      }
      return response.json();
    },
  });

  const {
    data: organizationInfo,
    isLoading: orgLoading,
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

  const isTeamMember = memberRecord?.is_team_member ?? false;

  const {
    data: engagementStats,
    isLoading: statsLoading,
  } = useQuery({
    queryKey: ["engagementStats", memberRecord?.id],
    enabled: !!memberRecord?.id,
    queryFn: async () => {
      if (!memberRecord?.id) return { eventsAttended: 0, articlesWritten: 0, jobsPosted: 0 };
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

  const { data: offlineAssignments = [], isLoading: offlineAssignmentsLoading } = useQuery({
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

  const { data: groupAssignments = [], isLoading: groupAssignmentsLoading } = useQuery({
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

  const { data: offlineAwards = [], isLoading: offlineAwardsLoading2 } = useQuery({
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

  const memberRoleIds = useMemo(() => {
    if (!memberRecord?.role_id) return [];
    if (Array.isArray(memberRecord.role_id)) {
      return memberRecord.role_id;
    }
    return [memberRecord.role_id];
  }, [memberRecord?.role_id]);

  const availableCategories = useMemo(() => {
    if (!communicationCategories.length) return [];
    
    return communicationCategories.filter(category => {
      if (!category.communication_category_role?.length) return true;
      const categoryRoleIds = category.communication_category_role.map(r => r.role_id);
      return memberRoleIds.some(roleId => categoryRoleIds.includes(roleId));
    });
  }, [communicationCategories, memberRoleIds]);

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
    if (!offlineAssignments || offlineAssignments.length === 0 || !offlineAwards) return [];
    return offlineAssignments
      .map((assignment) => {
        const award = offlineAwards.find((a) => a.id === assignment.offline_award_id);
        if (!award) return null;
        const sublevel = assignment.sublevel_id
          ? awardSublevels.find((s) => s.id === assignment.sublevel_id)
          : null;
        return { ...award, sublevel };
      })
      .filter(Boolean)
      .sort((a, b) => (a.level || 0) - (b.level || 0));
  }, [offlineAssignments, offlineAwards, awardSublevels]);

  useEffect(() => {
    if (!memberRecord) return;
    setFirstName(memberRecord.first_name || "");
    setLastName(memberRecord.last_name || "");
    setJobTitle(memberRecord.job_title || "");
    setBiography(memberRecord.biography || "");
    setProfilePhotoUrl(memberRecord.profile_photo_url || "");
    setShowInDirectory(memberRecord.show_in_directory !== false);
  }, [memberRecord]);

  useEffect(() => {
    if (organizationInfo) {
      setOrganizationLogoUrl(organizationInfo.logo_url || "");
    }
  }, [organizationInfo]);

  const updateProfileMutation = useMutation({
    mutationFn: async (profileData) => {
      if (!memberRecord?.id) throw new Error("No member record");
      const response = await fetch(`/api/admin/members/${memberRecord.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(profileData),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update member');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["adminMember", memberId] });
      queryClient.invalidateQueries({ queryKey: ["all-members-directory"] });
      toast.success("Member profile updated successfully");
      setHasUnsavedProfile(false);
      setIsSavingProfile(false);
      
      checkForPendingWorkflows(data);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update member profile");
      setIsSavingProfile(false);
    },
  });

  const updateOrganizationLogoMutation = useMutation({
    mutationFn: async (logoUrl) => {
      if (!organizationInfo?.id) throw new Error("No organization");
      const response = await fetch(`/api/admin/organizations/${organizationInfo.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ logo_url: logoUrl }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update organization');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization"] });
      toast.success("Organisation logo updated successfully");
      setHasUnsavedOrgLogo(false);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update organisation logo");
    },
  });

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
      const folder = memberRecord?.id || "member";
      const publicUrl = await uploadImageToSupabase(file, "member-photos", folder);
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

  const handleOrgLogoUpload = async (e) => {
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

    setIsUploadingOrgLogo(true);
    try {
      const folder = organizationInfo?.id || "organization";
      const publicUrl = await uploadImageToSupabase(file, "organization-logos", folder);
      setOrganizationLogoUrl(publicUrl);
      setHasUnsavedOrgLogo(true);
      toast.success("Logo uploaded successfully");
    } catch (err) {
      console.error(err);
      toast.error("Failed to upload logo");
    } finally {
      setIsUploadingOrgLogo(false);
    }
  };

  const handleSaveOrgLogo = () => {
    updateOrganizationLogoMutation.mutate(organizationLogoUrl);
  };

  const handleSaveProfile = () => {
    const wordCount = biography.trim().split(/\s+/).filter((w) => w.length > 0).length;
    if (wordCount > 500) {
      toast.error("Biography must be 500 words or less");
      return;
    }

    setIsSavingProfile(true);
    updateProfileMutation.mutate({
      first_name: firstName,
      last_name: lastName,
      job_title: jobTitle,
      biography,
      profile_photo_url: profilePhotoUrl,
      show_in_directory: showInDirectory,
    });
  };

  const handleCommunicationToggle = async (categoryId, isSubscribed) => {
    if (!memberRecord?.id) return;
    
    setUpdatingCommPrefs(prev => new Set(prev).add(categoryId));
    
    try {
      const response = await fetch(
        `/api/admin/members/${memberRecord.id}/communication-preferences/${categoryId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ is_subscribed: isSubscribed }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update preference');
      }
      
      queryClient.invalidateQueries({ queryKey: ["communicationPreferences", memberRecord.id] });
      toast.success(isSubscribed ? "Subscribed to updates" : "Unsubscribed from updates");
    } catch (error) {
      console.error("Failed to update communication preference:", error);
      toast.error(error.message || "Failed to update preference");
    } finally {
      setUpdatingCommPrefs(prev => {
        const next = new Set(prev);
        next.delete(categoryId);
        return next;
      });
    }
  };

  useEffect(() => {
    if (!memberRecord) return;
    const changed =
      firstName !== (memberRecord.first_name || "") ||
      lastName !== (memberRecord.last_name || "") ||
      jobTitle !== (memberRecord.job_title || "") ||
      biography !== (memberRecord.biography || "") ||
      profilePhotoUrl !== (memberRecord.profile_photo_url || "") ||
      showInDirectory !== (memberRecord.show_in_directory !== false);
    setHasUnsavedProfile(changed);
  }, [firstName, lastName, jobTitle, biography, profilePhotoUrl, showInDirectory, memberRecord]);

  useEffect(() => {
    if (!organizationInfo) return;
    const changed = organizationLogoUrl !== (organizationInfo.logo_url || "");
    setHasUnsavedOrgLogo(changed);
  }, [organizationLogoUrl, organizationInfo]);

  const getBiographyWordCount = () =>
    biography.trim().split(/\s+/).filter((w) => w.length > 0).length;

  const isLoading = !isAccessReady || !canEditMembers || memberLoading || orgLoading || 
    offlineAssignmentsLoading || offlineAwardsLoading2 || groupAssignmentsLoading || 
    awardsLoading || groupsLoading;

  if (!isAccessReady) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!canEditMembers) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!memberId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="py-12 text-center">
              <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-amber-900 mb-2">No Member Selected</h2>
              <p className="text-amber-700 mb-6">
                Please select a member to edit from the communications management page.
              </p>
              <Button onClick={() => navigate("/CommunicationsManagement")} variant="outline" data-testid="button-go-to-comms">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Go to Communications
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (memberError || !memberRecord) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="border-red-200 bg-red-50">
            <CardContent className="py-12 text-center">
              <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-red-900 mb-2">Member Not Found</h2>
              <p className="text-red-700 mb-6">
                The member you're trying to edit could not be found.
              </p>
              <Button onClick={() => navigate(-1)} variant="outline" data-testid="button-go-back-error">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Go Back
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const memberFullName = [memberRecord.first_name, memberRecord.last_name].filter(Boolean).join(' ') || 'Unknown Member';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        {!hasBanner && (
          <div>
            <Button 
              variant="ghost" 
              onClick={() => navigate(-1)} 
              className="mb-4"
              data-testid="button-back"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
            <div className="flex items-center gap-3 mb-2">
              <Shield className="w-6 h-6 text-blue-600" />
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
                Edit Member
              </h1>
            </div>
            <p className="text-slate-600">
              Editing details for <span className="font-medium">{memberFullName}</span>
              {memberRecord.email && (
                <span className="text-slate-500"> ({memberRecord.email})</span>
              )}
            </p>
          </div>
        )}

        {organizationInfo && !isTeamMember && (
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle>Organisation Logo</CardTitle>
              <CardDescription>
                {organizationInfo.name}'s logo for the directory
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Logo</Label>
                <div className="flex items-center gap-4">
                  <div className="w-24 h-24 rounded-lg bg-slate-100 flex items-center justify-center overflow-hidden border-2 border-slate-200">
                    {organizationLogoUrl ? (
                      <img
                        src={organizationLogoUrl}
                        alt="Organisation Logo"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <Building2 className="w-12 h-12 text-slate-400" />
                    )}
                  </div>
                  <div>
                    <input
                      type="file"
                      id="org-logo-upload"
                      accept="image/*"
                      onChange={handleOrgLogoUpload}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isUploadingOrgLogo}
                      onClick={() => document.getElementById("org-logo-upload").click()}
                      data-testid="button-upload-org-logo"
                    >
                      {isUploadingOrgLogo ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4 mr-2" />
                          Upload Logo
                        </>
                      )}
                    </Button>
                    <p className="text-xs text-slate-500 mt-1">JPG, PNG or GIF. Max 5MB.</p>
                  </div>
                </div>
              </div>

              {hasUnsavedOrgLogo && (
                <div className="flex justify-end pt-4">
                  <Button
                    onClick={handleSaveOrgLogo}
                    disabled={updateOrganizationLogoMutation.isPending}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-save-org-logo"
                  >
                    {updateOrganizationLogoMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        Save Logo
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Member Information</CardTitle>
            <CardDescription>
              {memberRecord.handle ? `@${memberRecord.handle}` : 'Update member personal details'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Profile Photo</Label>
              <div className="flex items-center gap-4">
                <div className="w-24 h-24 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border-2 border-slate-200">
                  {profilePhotoUrl ? (
                    <img src={profilePhotoUrl} alt="Profile" className="w-full h-full object-cover" />
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
                    onClick={() => document.getElementById("photo-upload").click()}
                    data-testid="button-upload-photo"
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
                  <p className="text-xs text-slate-500 mt-1">JPG, PNG or GIF. Max 5MB.</p>
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
                  placeholder="Enter first name"
                  data-testid="input-first-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Enter last name"
                  data-testid="input-last-name"
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
                data-testid="input-job-title"
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div className="flex-1">
                <Label htmlFor="show-in-directory" className="cursor-pointer">
                  Show in Member Directory
                </Label>
                <p className="text-xs text-slate-500 mt-1">
                  Allow other members to see this profile in the member directory
                </p>
              </div>
              <Switch
                id="show-in-directory"
                checked={showInDirectory}
                onCheckedChange={setShowInDirectory}
                data-testid="switch-show-directory"
              />
            </div>

            {memberRecord.created_at && (
              <div className="flex items-center gap-2 p-4 bg-slate-50 rounded-lg border border-slate-200">
                <CalendarDays className="w-5 h-5 text-slate-500" />
                <div>
                  <p className="text-sm text-slate-600">Member since</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {format(new Date(memberRecord.created_at), "dd MMMM yyyy")}
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
                  data-testid="button-save-profile"
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

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Engagement</CardTitle>
            <CardDescription>
              Member's activity and contributions to the community
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4 border border-blue-200">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center">
                    <Calendar className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-blue-900">
                      {statsLoading ? "-" : engagementStats?.eventsAttended || 0}
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
                      {statsLoading ? "-" : engagementStats?.articlesWritten || 0}
                    </p>
                    <p className="text-xs text-purple-700">Articles Published</p>
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
                      {statsLoading ? "-" : engagementStats?.jobsPosted || 0}
                    </p>
                    <p className="text-xs text-green-700">Jobs Posted</p>
                  </div>
                </div>
              </div>
            </div>

            {groupAssignments.length > 0 && (
              <div className="pt-4 border-t border-slate-200">
                <div className="flex items-center gap-2 mb-4">
                  <Users className="w-5 h-5 text-blue-600" />
                  <h3 className="text-sm font-semibold text-slate-900">Member Groups</h3>
                  <Badge variant="secondary">{groupAssignments.length}</Badge>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {groupAssignments.map((assignment) => {
                    const group = memberGroups.find((g) => g.id === assignment.group_id);
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
                          <p className="text-sm font-semibold text-slate-900 truncate">{group.name}</p>
                          <p className="text-xs text-blue-700 font-medium">{assignment.group_role}</p>
                          {group.description && (
                            <p className="text-xs text-slate-600 mt-1 line-clamp-2">{group.description}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {(earnedOnlineAwards.length > 0 || earnedOfflineAwards.length > 0) && (
              <div className="pt-4 border-t border-slate-200">
                <div className="flex items-center gap-2 mb-4">
                  <Trophy className="w-5 h-5 text-amber-600" />
                  <h3 className="text-sm font-semibold text-slate-900">Member Awards</h3>
                  <Badge variant="secondary">
                    {earnedOnlineAwards.length + earnedOfflineAwards.length}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {earnedOnlineAwards.map((award) => {
                    const classification = award.classification_id
                      ? awardClassifications.find((c) => c.id === award.classification_id)
                      : null;
                    return (
                      <div
                        key={`online-${award.id}`}
                        className="flex flex-col items-center p-3 bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg border border-amber-200 hover:shadow-md transition-shadow relative"
                      >
                        {classification && (
                          <Badge variant="secondary" className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5">
                            {classification.name}
                          </Badge>
                        )}
                        {award.image_url ? (
                          <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain mb-2" />
                        ) : (
                          <div className="w-12 h-12 bg-gradient-to-br from-amber-400 to-amber-600 rounded-full flex items-center justify-center mb-2">
                            <Trophy className="w-6 h-6 text-white" />
                          </div>
                        )}
                        <p className="text-xs font-semibold text-center text-slate-900 line-clamp-2">{award.name}</p>
                      </div>
                    );
                  })}
                  {earnedOfflineAwards.map((award, idx) => {
                    const classification = award.classification_id
                      ? awardClassifications.find((c) => c.id === award.classification_id)
                      : null;
                    return (
                      <div
                        key={`offline-${award.id}-${idx}`}
                        className="flex flex-col items-center p-3 bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg border border-purple-200 hover:shadow-md transition-shadow relative"
                      >
                        {classification && (
                          <Badge variant="secondary" className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5">
                            {classification.name}
                          </Badge>
                        )}
                        {award.sublevel?.image_url ? (
                          <img src={award.sublevel.image_url} alt={award.sublevel.name} className="w-12 h-12 object-contain mb-2" />
                        ) : award.image_url ? (
                          <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain mb-2" />
                        ) : (
                          <div className="w-12 h-12 bg-gradient-to-br from-purple-400 to-purple-600 rounded-full flex items-center justify-center mb-2">
                            <Trophy className="w-6 h-6 text-white" />
                          </div>
                        )}
                        <p className="text-xs font-semibold text-center text-slate-900 line-clamp-2">{award.name}</p>
                        {award.sublevel && (
                          <Badge className="mt-1 bg-purple-600 text-white text-[10px]">{award.sublevel.name}</Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2 pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <Label htmlFor="biography">Professional Biography</Label>
                <span className={`text-xs ${getBiographyWordCount() > 500 ? "text-red-600 font-semibold" : "text-slate-500"}`}>
                  {getBiographyWordCount()} / 500 words
                </span>
              </div>
              <Textarea
                id="biography"
                value={biography}
                onChange={(e) => setBiography(e.target.value)}
                placeholder="Professional background, expertise, and experience (max 500 words)"
                className="min-h-[200px]"
                data-testid="textarea-biography"
              />
              <p className="text-xs text-slate-500">This biography will be displayed on published articles</p>
            </div>

            {hasUnsavedProfile && (
              <div className="flex justify-end pt-4">
                <Button
                  onClick={handleSaveProfile}
                  disabled={isSavingProfile || getBiographyWordCount() > 500}
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="button-save-biography"
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

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-blue-600" />
              Communication Preferences
            </CardTitle>
            <CardDescription>
              Manage which communications this member receives
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
                <p>No communication categories available for this member's role.</p>
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

        <MemberEmails 
          memberId={memberRecord.id}
          memberEmail={memberRecord.email}
          memberName={memberFullName}
        />
      </div>

      <WorkflowConfirmationModal
        open={showConfirmationModal}
        onOpenChange={setShowConfirmationModal}
        pendingWorkflows={pendingWorkflows}
        onConfirm={handleConfirmWorkflow}
        onSkip={handleSkipWorkflow}
        onSkipAll={handleSkipAllWorkflows}
      />
    </div>
  );
}
