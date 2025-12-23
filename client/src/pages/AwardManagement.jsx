import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Pencil, Trash2, Trophy, Upload, Calendar, FileText, Briefcase, UserPlus, Users, UserMinus, Building2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function AwardManagementPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [activeTab, setActiveTab] = useState("online");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_AwardManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [classificationDialogOpen, setClassificationDialogOpen] = useState(false);
  const [sublevelDialogOpen, setSublevelDialogOpen] = useState(false);
  const [sublevelFormDialogOpen, setSublevelFormDialogOpen] = useState(false);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [viewAssignmentsDialogOpen, setViewAssignmentsDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteClassificationDialogOpen, setDeleteClassificationDialogOpen] = useState(false);
  const [deleteSublevelDialogOpen, setDeleteSublevelDialogOpen] = useState(false);
  const [removeAssignmentDialogOpen, setRemoveAssignmentDialogOpen] = useState(false);
  const [editingAward, setEditingAward] = useState(null);
  const [editingClassification, setEditingClassification] = useState(null);
  const [editingSublevel, setEditingSublevel] = useState(null);
  const [managingSublevelsForAward, setManagingSublevelsForAward] = useState(null);
  const [assigningAward, setAssigningAward] = useState(null);
  const [viewingAward, setViewingAward] = useState(null);
  const [deletingAward, setDeletingAward] = useState(null);
  const [deletingClassification, setDeletingClassification] = useState(null);
  const [deletingSublevel, setDeletingSublevel] = useState(null);
  const [removingAssignment, setRemovingAssignment] = useState(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [selectedSublevelId, setSelectedSublevelId] = useState("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [assignmentNotes, setAssignmentNotes] = useState("");
  const [memberSearchQuery, setMemberSearchQuery] = useState("");
  const [assignedMembersSearchQuery, setAssignedMembersSearchQuery] = useState("");

  // Online award form state
  const [onlineFormData, setOnlineFormData] = useState({
    name: "",
    description: "",
    classification_id: "",
    award_type: "events_attended",
    threshold: "",
    level: "",
    image_url: "",
    is_active: true
  });

  // Offline award form state
  const [offlineFormData, setOfflineFormData] = useState({
    name: "",
    description: "",
    classification_id: "",
    period_text: "",
    level: "",
    image_url: "",
    is_active: true
  });

  // Engagement award form state (same structure as offline)
  const [engagementFormData, setEngagementFormData] = useState({
    name: "",
    description: "",
    classification_id: "",
    period_text: "",
    level: "",
    image_url: "",
    is_active: true
  });

  // Organisation award form state (same structure as offline)
  const [organisationFormData, setOrganisationFormData] = useState({
    name: "",
    description: "",
    classification_id: "",
    period_text: "",
    level: "",
    image_url: "",
    is_active: true
  });

  // Classification form state
  const [classificationFormData, setClassificationFormData] = useState({
    name: "",
    description: "",
    award_category: "online",
    display_order: "",
    is_active: true
  });

  // Sublevel form state
  const [sublevelFormData, setSublevelFormData] = useState({
    name: "",
    threshold: "",
    display_order: "",
    image_url: "",
    is_active: true
  });

  const queryClient = useQueryClient();

  // Fetch online awards
  const { data: onlineAwards = [], isLoading: onlineLoading } = useQuery({
    queryKey: ['awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.sort((a, b) => {
        if (a.award_type !== b.award_type) {
          return a.award_type.localeCompare(b.award_type);
        }
        return (a.level || 0) - (b.level || 0);
      });
    },
    staleTime: 0, // Admin views need instant freshness after edits
  });

  // Fetch offline awards
  const { data: offlineAwards = [], isLoading: offlineLoading } = useQuery({
    queryKey: ['offlineAwards'],
    queryFn: async () => {
      const allAwards = await base44.entities.OfflineAward.list();
      return allAwards.sort((a, b) => (a.level || 0) - (b.level || 0));
    }
  });

  // Fetch engagement awards
  const { data: engagementAwards = [], isLoading: engagementLoading } = useQuery({
    queryKey: ['engagementAwards'],
    queryFn: async () => {
      const allAwards = await base44.entities.EngagementAward.list();
      return allAwards.sort((a, b) => (a.level || 0) - (b.level || 0));
    }
  });

  // Fetch organisation awards
  const { data: organisationAwards = [], isLoading: organisationLoading } = useQuery({
    queryKey: ['organisationAwards'],
    queryFn: async () => {
      const allAwards = await base44.entities.OrganisationAward.list();
      return allAwards.sort((a, b) => (a.level || 0) - (b.level || 0));
    }
  });

  // Fetch organizations for the assign dialog
  const { data: organizations = [], isLoading: organizationsLoading } = useQuery({
    queryKey: ['organizations'],
    queryFn: async () => {
      const orgs = await base44.entities.Organization.list({ limit: 5000 });
      return orgs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },
    enabled: assignDialogOpen
  });

  // Fetch members for assignment - filter by selected organization
  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ['members-for-assignment', selectedOrganizationId],
    queryFn: async () => {
      if (selectedOrganizationId === '__no_org__') {
        // Fetch members without an organization
        const allMembers = await base44.entities.Member.list({ limit: 5000 });
        return allMembers.filter(m => !m.organization_id);
      } else if (selectedOrganizationId) {
        // Fetch members for the selected organization
        return await base44.entities.Member.list({ 
          filter: { organization_id: selectedOrganizationId },
          limit: 1000
        });
      }
      return [];
    },
    enabled: assignDialogOpen && !!selectedOrganizationId
  });
  
  // Fetch offline award assignments
  const { data: assignments = [] } = useQuery({
    queryKey: ['offlineAwardAssignments'],
    queryFn: async () => {
      return await base44.entities.OfflineAwardAssignment.list();
    }
  });

  // Fetch engagement award assignments
  const { data: engagementAssignments = [] } = useQuery({
    queryKey: ['engagementAwardAssignments'],
    queryFn: async () => {
      return await base44.entities.EngagementAwardAssignment.list();
    }
  });

  // Fetch organisation award assignments
  const { data: organisationAssignments = [] } = useQuery({
    queryKey: ['organisationAwardAssignments'],
    queryFn: async () => {
      return await base44.entities.OrganisationAwardAssignment.list();
    }
  });

  // Get the assignments for the viewing award (handles all award types)
  const viewingAwardAssignments = viewingAward 
    ? (viewingAward.type === 'engagement' 
        ? engagementAssignments.filter(a => a.engagement_award_id === viewingAward.id)
        : viewingAward.type === 'organisation'
        ? organisationAssignments.filter(a => a.organisation_award_id === viewingAward.id)
        : assignments.filter(a => a.offline_award_id === viewingAward.id))
    : [];
  
  // For member-based awards (offline, engagement), get member IDs
  const assignedMemberIds = viewingAward?.type !== 'organisation' 
    ? [...new Set(viewingAwardAssignments.map(a => a.member_id))]
    : [];
  
  // For organisation awards, get organization IDs
  const assignedOrganizationIds = viewingAward?.type === 'organisation'
    ? [...new Set(viewingAwardAssignments.map(a => a.organization_id))]
    : [];

  // Fetch only the specific members that are assigned to this award
  const { data: assignedMembersData = [], isLoading: allMembersLoading } = useQuery({
    queryKey: ['assigned-members', viewingAward?.id, viewingAward?.type, assignedMemberIds.join(',')],
    queryFn: async () => {
      if (assignedMemberIds.length === 0) return [];
      // Fetch each member by ID individually (more efficient than fetching all)
      const memberPromises = assignedMemberIds.map(id => 
        base44.entities.Member.get(id).catch(() => null)
      );
      const members = await Promise.all(memberPromises);
      return members.filter(m => m !== null);
    },
    enabled: viewAssignmentsDialogOpen && assignedMemberIds.length > 0 && viewingAward?.type !== 'organisation'
  });

  // Fetch only the specific organizations that are assigned to this award
  const { data: assignedOrganizationsData = [], isLoading: allOrganizationsLoading } = useQuery({
    queryKey: ['assigned-organizations', viewingAward?.id, assignedOrganizationIds.join(',')],
    queryFn: async () => {
      if (assignedOrganizationIds.length === 0) return [];
      const orgPromises = assignedOrganizationIds.map(id => 
        base44.entities.Organization.get(id).catch(() => null)
      );
      const orgs = await Promise.all(orgPromises);
      return orgs.filter(o => o !== null);
    },
    enabled: viewAssignmentsDialogOpen && assignedOrganizationIds.length > 0 && viewingAward?.type === 'organisation'
  });

  // Fetch classifications
  const { data: classifications = [], isLoading: classificationsLoading } = useQuery({
    queryKey: ['awardClassifications'],
    queryFn: async () => {
      const allClassifications = await base44.entities.AwardClassification.list();
      return allClassifications.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    }
  });

  // Fetch sublevels
  const { data: sublevels = [], isLoading: sublevelsLoading } = useQuery({
    queryKey: ['awardSublevels'],
    queryFn: async () => {
      const allSublevels = await base44.entities.AwardSublevel.list();
      return allSublevels.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    }
  });

  // Create online award
  const createOnlineAwardMutation = useMutation({
    mutationFn: async (awardData) => {
      return await base44.entities.Award.create(awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awards'] });
      toast.success('Online award created successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to create online award');
    }
  });

  // Create offline award
  const createOfflineAwardMutation = useMutation({
    mutationFn: async (awardData) => {
      return await base44.entities.OfflineAward.create(awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offlineAwards'] });
      toast.success('Offline award created successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to create offline award');
    }
  });

  // Update online award
  const updateOnlineAwardMutation = useMutation({
    mutationFn: async ({ id, awardData }) => {
      return await base44.entities.Award.update(id, awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awards'] });
      toast.success('Online award updated successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to update online award');
    }
  });

  // Update offline award
  const updateOfflineAwardMutation = useMutation({
    mutationFn: async ({ id, awardData }) => {
      return await base44.entities.OfflineAward.update(id, awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offlineAwards'] });
      toast.success('Offline award updated successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to update offline award');
    }
  });

  // Delete online award
  const deleteOnlineAwardMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.Award.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awards'] });
      toast.success('Online award deleted successfully');
      setDeleteDialogOpen(false);
      setDeletingAward(null);
    },
    onError: (error) => {
      toast.error('Failed to delete online award');
    }
  });

  // Delete offline award
  const deleteOfflineAwardMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.OfflineAward.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offlineAwards'] });
      toast.success('Offline award deleted successfully');
      setDeleteDialogOpen(false);
      setDeletingAward(null);
    },
    onError: (error) => {
      toast.error('Failed to delete offline award');
    }
  });

  // Assign offline award
  const assignOfflineAwardMutation = useMutation({
    mutationFn: async (assignmentData) => {
      // Check for duplicate assignment (same award + sublevel to same member)
      const existingAssignment = assignments.find(a => 
        a.member_id === assignmentData.member_id && 
        a.offline_award_id === assignmentData.offline_award_id &&
        (a.sublevel_id || null) === (assignmentData.sublevel_id || null)
      );
      
      if (existingAssignment) {
        const sublevel = sublevels.find(s => s.id === assignmentData.sublevel_id);
        const levelName = sublevel ? ` (${sublevel.name})` : '';
        throw new Error(`This member already has this award${levelName} assigned`);
      }
      
      return await base44.entities.OfflineAwardAssignment.create(assignmentData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offlineAwardAssignments'] });
      toast.success('Award assigned successfully');
      handleCloseAssignDialog();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to assign award');
    }
  });

  // Remove offline award assignment
  const removeOfflineAwardMutation = useMutation({
    mutationFn: async (assignmentId) => {
      return await base44.entities.OfflineAwardAssignment.delete(assignmentId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offlineAwardAssignments'] });
      toast.success('Award removed from member');
      setRemoveAssignmentDialogOpen(false);
      setRemovingAssignment(null);
    },
    onError: (error) => {
      toast.error('Failed to remove award');
    }
  });

  // Create engagement award
  const createEngagementAwardMutation = useMutation({
    mutationFn: async (awardData) => {
      return await base44.entities.EngagementAward.create(awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engagementAwards'] });
      toast.success('Engagement award created successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to create engagement award');
    }
  });

  // Update engagement award
  const updateEngagementAwardMutation = useMutation({
    mutationFn: async ({ id, awardData }) => {
      return await base44.entities.EngagementAward.update(id, awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engagementAwards'] });
      toast.success('Engagement award updated successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to update engagement award');
    }
  });

  // Delete engagement award
  const deleteEngagementAwardMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.EngagementAward.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engagementAwards'] });
      toast.success('Engagement award deleted successfully');
      setDeleteDialogOpen(false);
      setDeletingAward(null);
    },
    onError: (error) => {
      toast.error('Failed to delete engagement award');
    }
  });

  // Assign engagement award
  const assignEngagementAwardMutation = useMutation({
    mutationFn: async (assignmentData) => {
      const existingAssignment = engagementAssignments.find(a => 
        a.member_id === assignmentData.member_id && 
        a.engagement_award_id === assignmentData.engagement_award_id &&
        (a.sublevel_id || null) === (assignmentData.sublevel_id || null)
      );
      
      if (existingAssignment) {
        const sublevel = sublevels.find(s => s.id === assignmentData.sublevel_id);
        const levelName = sublevel ? ` (${sublevel.name})` : '';
        throw new Error(`This member already has this award${levelName} assigned`);
      }
      
      return await base44.entities.EngagementAwardAssignment.create(assignmentData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engagementAwardAssignments'] });
      toast.success('Award assigned successfully');
      handleCloseAssignDialog();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to assign award');
    }
  });

  // Remove engagement award assignment
  const removeEngagementAwardMutation = useMutation({
    mutationFn: async (assignmentId) => {
      return await base44.entities.EngagementAwardAssignment.delete(assignmentId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engagementAwardAssignments'] });
      toast.success('Award removed from member');
      setRemoveAssignmentDialogOpen(false);
      setRemovingAssignment(null);
    },
    onError: (error) => {
      toast.error('Failed to remove award');
    }
  });

  // Create organisation award
  const createOrganisationAwardMutation = useMutation({
    mutationFn: async (awardData) => {
      return await base44.entities.OrganisationAward.create(awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organisationAwards'] });
      toast.success('Organisation award created successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to create organisation award');
    }
  });

  // Update organisation award
  const updateOrganisationAwardMutation = useMutation({
    mutationFn: async ({ id, awardData }) => {
      return await base44.entities.OrganisationAward.update(id, awardData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organisationAwards'] });
      toast.success('Organisation award updated successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to update organisation award');
    }
  });

  // Delete organisation award
  const deleteOrganisationAwardMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.OrganisationAward.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organisationAwards'] });
      toast.success('Organisation award deleted successfully');
      setDeleteDialogOpen(false);
      setDeletingAward(null);
    },
    onError: (error) => {
      toast.error('Failed to delete organisation award');
    }
  });

  // Assign organisation award
  const assignOrganisationAwardMutation = useMutation({
    mutationFn: async (assignmentData) => {
      const existingAssignment = organisationAssignments.find(a => 
        a.organization_id === assignmentData.organization_id && 
        a.organisation_award_id === assignmentData.organisation_award_id &&
        (a.sublevel_id || null) === (assignmentData.sublevel_id || null)
      );
      
      if (existingAssignment) {
        const sublevel = sublevels.find(s => s.id === assignmentData.sublevel_id);
        const levelName = sublevel ? ` (${sublevel.name})` : '';
        throw new Error(`This organisation already has this award${levelName} assigned`);
      }
      
      return await base44.entities.OrganisationAwardAssignment.create(assignmentData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organisationAwardAssignments'] });
      toast.success('Award assigned successfully');
      handleCloseAssignDialog();
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to assign award');
    }
  });

  // Remove organisation award assignment
  const removeOrganisationAwardMutation = useMutation({
    mutationFn: async (assignmentId) => {
      return await base44.entities.OrganisationAwardAssignment.delete(assignmentId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organisationAwardAssignments'] });
      toast.success('Award removed from organisation');
      setRemoveAssignmentDialogOpen(false);
      setRemovingAssignment(null);
    },
    onError: (error) => {
      toast.error('Failed to remove award');
    }
  });

  // Classification mutations
  const createClassificationMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.AwardClassification.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awardClassifications'] });
      toast.success('Classification created successfully');
      setClassificationDialogOpen(false);
      setEditingClassification(null);
    },
    onError: (error) => {
      toast.error('Failed to create classification');
    }
  });

  const updateClassificationMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.AwardClassification.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awardClassifications'] });
      toast.success('Classification updated successfully');
      setClassificationDialogOpen(false);
      setEditingClassification(null);
    },
    onError: (error) => {
      toast.error('Failed to update classification');
    }
  });

  const deleteClassificationMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.AwardClassification.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awardClassifications'] });
      toast.success('Classification deleted successfully');
      setDeleteClassificationDialogOpen(false);
      setDeletingClassification(null);
    },
    onError: (error) => {
      toast.error('Failed to delete classification');
    }
  });

  // Sublevel mutations
  const createSublevelMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.AwardSublevel.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awardSublevels'] });
      toast.success('Sublevel created successfully');
      setSublevelFormDialogOpen(false);
      setEditingSublevel(null);
    },
    onError: (error) => {
      toast.error('Failed to create sublevel');
    }
  });

  const updateSublevelMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      return await base44.entities.AwardSublevel.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awardSublevels'] });
      toast.success('Sublevel updated successfully');
      setSublevelFormDialogOpen(false);
      setEditingSublevel(null);
    },
    onError: (error) => {
      toast.error('Failed to update sublevel');
    }
  });

  const deleteSublevelMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.AwardSublevel.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['awardSublevels'] });
      toast.success('Sublevel deleted successfully');
      setDeleteSublevelDialogOpen(false);
      setDeletingSublevel(null);
    },
    onError: (error) => {
      toast.error('Failed to delete sublevel');
    }
  });

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const handleOpenDialog = (award = null, type = 'online') => {
    if (award) {
      setEditingAward({ ...award, type });
      if (type === 'online') {
        setOnlineFormData({
          name: award.name || "",
          description: award.description || "",
          classification_id: award.classification_id || "",
          award_type: award.award_type || "events_attended",
          threshold: award.threshold || "",
          level: award.level || "",
          image_url: award.image_url || "",
          is_active: award.is_active ?? true
        });
      } else if (type === 'offline') {
        setOfflineFormData({
          name: award.name || "",
          description: award.description || "",
          classification_id: award.classification_id || "",
          period_text: award.period_text || "",
          level: award.level || "",
          image_url: award.image_url || "",
          is_active: award.is_active ?? true
        });
      } else if (type === 'engagement') {
        setEngagementFormData({
          name: award.name || "",
          description: award.description || "",
          classification_id: award.classification_id || "",
          period_text: award.period_text || "",
          level: award.level || "",
          image_url: award.image_url || "",
          is_active: award.is_active ?? true
        });
      } else if (type === 'organisation') {
        setOrganisationFormData({
          name: award.name || "",
          description: award.description || "",
          classification_id: award.classification_id || "",
          period_text: award.period_text || "",
          level: award.level || "",
          image_url: award.image_url || "",
          is_active: award.is_active ?? true
        });
      }
    } else {
      setEditingAward(null);
      if (type === 'online') {
        setOnlineFormData({
          name: "",
          description: "",
          classification_id: "",
          award_type: "events_attended",
          threshold: "",
          level: "",
          image_url: "",
          is_active: true
        });
      } else if (type === 'offline') {
        setOfflineFormData({
          name: "",
          description: "",
          classification_id: "",
          period_text: "",
          level: "",
          image_url: "",
          is_active: true
        });
      } else if (type === 'engagement') {
        setEngagementFormData({
          name: "",
          description: "",
          classification_id: "",
          period_text: "",
          level: "",
          image_url: "",
          is_active: true
        });
      } else if (type === 'organisation') {
        setOrganisationFormData({
          name: "",
          description: "",
          classification_id: "",
          period_text: "",
          level: "",
          image_url: "",
          is_active: true
        });
      }
    }
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingAward(null);
    setOnlineFormData({
      name: "",
      description: "",
      classification_id: "",
      award_type: "events_attended",
      threshold: "",
      level: "",
      image_url: "",
      is_active: true
    });
    setOfflineFormData({
      name: "",
      description: "",
      classification_id: "",
      period_text: "",
      level: "",
      image_url: "",
      is_active: true
    });
    setEngagementFormData({
      name: "",
      description: "",
      classification_id: "",
      period_text: "",
      level: "",
      image_url: "",
      is_active: true
    });
    setOrganisationFormData({
      name: "",
      description: "",
      classification_id: "",
      period_text: "",
      level: "",
      image_url: "",
      is_active: true
    });
  };

  const handleOpenClassificationDialog = (classification = null) => {
    if (classification) {
      setEditingClassification(classification);
      setClassificationFormData({
        name: classification.name || "",
        description: classification.description || "",
        award_category: classification.award_category || "online",
        display_order: classification.display_order || "",
        is_active: classification.is_active ?? true
      });
    } else {
      setEditingClassification(null);
      setClassificationFormData({
        name: "",
        description: "",
        award_category: activeTab,
        display_order: "",
        is_active: true
      });
    }
    setClassificationDialogOpen(true);
  };

  const handleOpenSublevelDialog = (award) => {
    setManagingSublevelsForAward(award);
    setSublevelDialogOpen(true);
  };

  const handleOpenSublevelFormDialog = (sublevel = null) => {
    if (sublevel) {
      setEditingSublevel(sublevel);
      setSublevelFormData({
        name: sublevel.name || "",
        threshold: sublevel.threshold || "",
        display_order: sublevel.display_order || "",
        image_url: sublevel.image_url || "",
        is_active: sublevel.is_active ?? true
      });
    } else {
      setEditingSublevel(null);
      setSublevelFormData({
        name: "",
        threshold: "",
        display_order: "",
        image_url: "",
        is_active: true
      });
    }
    setSublevelFormDialogOpen(true);
  };

  const handleOpenAssignDialog = (award) => {
    setAssigningAward(award);
    setSelectedMemberId("");
    setSelectedSublevelId("");
    setSelectedOrganizationId("");
    setAssignmentNotes("");
    setMemberSearchQuery("");
    setAssignDialogOpen(true);
  };

  const handleCloseAssignDialog = () => {
    setAssignDialogOpen(false);
    setAssigningAward(null);
    setSelectedMemberId("");
    setSelectedSublevelId("");
    setSelectedOrganizationId("");
    setAssignmentNotes("");
    setMemberSearchQuery("");
  };

  const handleOpenViewAssignmentsDialog = (award) => {
    setViewingAward(award);
    setAssignedMembersSearchQuery("");
    setViewAssignmentsDialogOpen(true);
  };

  const handleCloseViewAssignmentsDialog = () => {
    setViewAssignmentsDialogOpen(false);
    setViewingAward(null);
    setAssignedMembersSearchQuery("");
  };

  const handleAssignAward = () => {
    if (assigningAward.type === 'organisation') {
      // For organisation awards, assign to organization instead of member
      if (!selectedOrganizationId || selectedOrganizationId === "__no_org__") {
        toast.error('Please select an organisation');
        return;
      }

      const assignmentData = {
        organisation_award_id: assigningAward.id,
        organization_id: selectedOrganizationId,
        sublevel_id: selectedSublevelId || null,
        assigned_by: memberInfo?.email || "",
        notes: assignmentNotes,
        assigned_date: new Date().toISOString()
      };
      assignOrganisationAwardMutation.mutate(assignmentData);
    } else {
      if (!selectedMemberId) {
        toast.error('Please select a member');
        return;
      }

      if (assigningAward.type === 'engagement') {
        const assignmentData = {
          engagement_award_id: assigningAward.id,
          member_id: selectedMemberId,
          sublevel_id: selectedSublevelId || null,
          assigned_by: memberInfo?.email || "",
          notes: assignmentNotes,
          assigned_date: new Date().toISOString()
        };
        assignEngagementAwardMutation.mutate(assignmentData);
      } else {
        const assignmentData = {
          offline_award_id: assigningAward.id,
          member_id: selectedMemberId,
          sublevel_id: selectedSublevelId || null,
          assigned_by: memberInfo?.email || "",
          notes: assignmentNotes,
          assigned_date: new Date().toISOString()
        };
        assignOfflineAwardMutation.mutate(assignmentData);
      }
    }
  };

  const handleRemoveAssignment = () => {
    if (!removingAssignment) return;
    if (removingAssignment.type === 'engagement') {
      removeEngagementAwardMutation.mutate(removingAssignment.id);
    } else if (removingAssignment.type === 'organisation') {
      removeOrganisationAwardMutation.mutate(removingAssignment.id);
    } else {
      removeOfflineAwardMutation.mutate(removingAssignment.id);
    }
  };

  const handleImageUpload = async (e, type) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    setIsUploadingImage(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      if (type === 'online') {
        setOnlineFormData(prev => ({ ...prev, image_url: result.file_url }));
      } else if (type === 'offline') {
        setOfflineFormData(prev => ({ ...prev, image_url: result.file_url }));
      } else if (type === 'engagement') {
        setEngagementFormData(prev => ({ ...prev, image_url: result.file_url }));
      } else if (type === 'organisation') {
        setOrganisationFormData(prev => ({ ...prev, image_url: result.file_url }));
      }
      toast.success('Image uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload image');
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleSubmit = (type) => {
    if (type === 'online') {
      if (!onlineFormData.name || !onlineFormData.level) {
        toast.error('Please fill in all required fields');
        return;
      }

      const awardData = {
        name: onlineFormData.name,
        description: onlineFormData.description,
        classification_id: onlineFormData.classification_id || null,
        award_type: onlineFormData.award_type,
        threshold: onlineFormData.threshold ? Number(onlineFormData.threshold) : null,
        level: Number(onlineFormData.level),
        image_url: onlineFormData.image_url,
        is_active: onlineFormData.is_active
      };

      if (editingAward && editingAward.type === 'online') {
        updateOnlineAwardMutation.mutate({ id: editingAward.id, awardData });
      } else {
        createOnlineAwardMutation.mutate(awardData);
      }
    } else if (type === 'offline') {
      if (!offlineFormData.name || !offlineFormData.level) {
        toast.error('Please fill in all required fields');
        return;
      }

      const awardData = {
        name: offlineFormData.name,
        description: offlineFormData.description,
        classification_id: offlineFormData.classification_id || null,
        period_text: offlineFormData.period_text,
        level: Number(offlineFormData.level),
        image_url: offlineFormData.image_url,
        is_active: offlineFormData.is_active
      };

      if (editingAward && editingAward.type === 'offline') {
        updateOfflineAwardMutation.mutate({ id: editingAward.id, awardData });
      } else {
        createOfflineAwardMutation.mutate(awardData);
      }
    } else if (type === 'engagement') {
      if (!engagementFormData.name || !engagementFormData.level) {
        toast.error('Please fill in all required fields');
        return;
      }

      const awardData = {
        name: engagementFormData.name,
        description: engagementFormData.description,
        classification_id: engagementFormData.classification_id || null,
        period_text: engagementFormData.period_text,
        level: Number(engagementFormData.level),
        image_url: engagementFormData.image_url,
        is_active: engagementFormData.is_active
      };

      if (editingAward && editingAward.type === 'engagement') {
        updateEngagementAwardMutation.mutate({ id: editingAward.id, awardData });
      } else {
        createEngagementAwardMutation.mutate(awardData);
      }
    } else if (type === 'organisation') {
      if (!organisationFormData.name || !organisationFormData.level) {
        toast.error('Please fill in all required fields');
        return;
      }

      const awardData = {
        name: organisationFormData.name,
        description: organisationFormData.description,
        classification_id: organisationFormData.classification_id || null,
        period_text: organisationFormData.period_text,
        level: Number(organisationFormData.level),
        image_url: organisationFormData.image_url,
        is_active: organisationFormData.is_active
      };

      if (editingAward && editingAward.type === 'organisation') {
        updateOrganisationAwardMutation.mutate({ id: editingAward.id, awardData });
      } else {
        createOrganisationAwardMutation.mutate(awardData);
      }
    }
  };

  const handleSubmitClassification = () => {
    if (!classificationFormData.name) {
      toast.error('Please fill in all required fields');
      return;
    }

    const data = {
      name: classificationFormData.name,
      description: classificationFormData.description,
      award_category: classificationFormData.award_category,
      display_order: classificationFormData.display_order ? Number(classificationFormData.display_order) : 0,
      is_active: classificationFormData.is_active
    };

    if (editingClassification) {
      updateClassificationMutation.mutate({ id: editingClassification.id, data });
    } else {
      createClassificationMutation.mutate(data);
    }
  };

  const handleSubmitSublevel = () => {
    if (!sublevelFormData.name) {
      toast.error('Please fill in all required fields');
      return;
    }

    const data = {
      name: sublevelFormData.name,
      threshold: sublevelFormData.threshold ? Number(sublevelFormData.threshold) : null,
      display_order: sublevelFormData.display_order ? Number(sublevelFormData.display_order) : 0,
      image_url: sublevelFormData.image_url,
      is_active: sublevelFormData.is_active
    };

    // Set the appropriate award ID and category based on award type
    data.award_category = managingSublevelsForAward.type;
    if (managingSublevelsForAward.type === 'online') {
      data.award_id = managingSublevelsForAward.id;
    } else if (managingSublevelsForAward.type === 'offline') {
      data.offline_award_id = managingSublevelsForAward.id;
    } else if (managingSublevelsForAward.type === 'engagement') {
      data.engagement_award_id = managingSublevelsForAward.id;
    } else if (managingSublevelsForAward.type === 'organisation') {
      data.organisation_award_id = managingSublevelsForAward.id;
    }

    if (editingSublevel) {
      updateSublevelMutation.mutate({ id: editingSublevel.id, data });
    } else {
      createSublevelMutation.mutate(data);
    }
  };

  const handleDelete = () => {
    if (!deletingAward) return;

    if (deletingAward.type === 'online') {
      deleteOnlineAwardMutation.mutate(deletingAward.id);
    } else if (deletingAward.type === 'offline') {
      deleteOfflineAwardMutation.mutate(deletingAward.id);
    } else if (deletingAward.type === 'engagement') {
      deleteEngagementAwardMutation.mutate(deletingAward.id);
    } else if (deletingAward.type === 'organisation') {
      deleteOrganisationAwardMutation.mutate(deletingAward.id);
    }
  };

  const getAwardTypeLabel = (type) => {
    switch (type) {
      case 'events_attended': return 'Events Attended';
      case 'articles_published': return 'Articles Published';
      case 'jobs_posted': return 'Jobs Posted';
      default: return type;
    }
  };

  const getAwardTypeIcon = (type) => {
    switch (type) {
      case 'events_attended': return <Calendar className="w-4 h-4" />;
      case 'articles_published': return <FileText className="w-4 h-4" />;
      case 'jobs_posted': return <Briefcase className="w-4 h-4" />;
      default: return <Trophy className="w-4 h-4" />;
    }
  };

  const getAssignmentCount = (awardId) => {
    return assignments.filter(a => a.offline_award_id === awardId).length;
  };

  const getAssignedMembers = (awardId, awardType = 'offline') => {
    let awardAssignments;
    if (awardType === 'engagement') {
      awardAssignments = engagementAssignments.filter(a => a.engagement_award_id === awardId);
    } else if (awardType === 'organisation') {
      // For organisation awards, return organizations instead of members
      awardAssignments = organisationAssignments.filter(a => a.organisation_award_id === awardId);
      return awardAssignments.map(assignment => {
        // Use assignedOrganizationsData for viewing, or organizations for assigning
        const org = assignedOrganizationsData.find(o => o.id === assignment.organization_id) 
          || organizations.find(o => o.id === assignment.organization_id);
        return { ...assignment, organization: org, type: awardType };
      }).filter(item => item.organization);
    } else {
      awardAssignments = assignments.filter(a => a.offline_award_id === awardId);
    }
    return awardAssignments.map(assignment => {
      // Use assignedMembersData which fetches only the specific members we need
      const member = assignedMembersData.find(m => m.id === assignment.member_id);
      return { ...assignment, member, type: awardType };
    }).filter(item => item.member);
  };

  const filteredMembers = members.filter(member => {
    if (!memberSearchQuery) return true;
    const searchLower = memberSearchQuery.toLowerCase();
    return (
      member.first_name?.toLowerCase().includes(searchLower) ||
      member.last_name?.toLowerCase().includes(searchLower) ||
      member.email?.toLowerCase().includes(searchLower)
    );
  });

  const filteredAssignedMembers = getAssignedMembers(viewingAward?.id, viewingAward?.type || 'offline').filter(item => {
    if (!assignedMembersSearchQuery) return true;
    const searchLower = assignedMembersSearchQuery.toLowerCase();
    
    // For organisation awards, filter by organization name
    if (viewingAward?.type === 'organisation') {
      return item.organization?.name?.toLowerCase().includes(searchLower);
    }
    
    // For member awards, filter by member name/email
    return (
      item.member?.first_name?.toLowerCase().includes(searchLower) ||
      item.member?.last_name?.toLowerCase().includes(searchLower) ||
      item.member?.email?.toLowerCase().includes(searchLower)
    );
  });

  const getAwardSublevels = (awardId, awardType = 'online') => {
    if (awardType === 'offline' || awardType === true) {
      return sublevels.filter(s => s.offline_award_id === awardId);
    }
    if (awardType === 'engagement') {
      return sublevels.filter(s => s.engagement_award_id === awardId);
    }
    if (awardType === 'organisation') {
      return sublevels.filter(s => s.organisation_award_id === awardId);
    }
    return sublevels.filter(s => s.award_id === awardId);
  };

  const getClassificationName = (classificationId) => {
    const classification = classifications.find(c => c.id === classificationId);
    return classification?.name || 'Unclassified';
  };

  const renderOnlineAwards = () => {
    // Group by classification first
    const onlineClassifications = classifications.filter(c => c.award_category === 'online' && c.is_active);
    const unclassifiedAwards = onlineAwards.filter(a => !a.classification_id);

    return (
      <div className="space-y-8">
        {onlineClassifications.map(classification => {
          const classificationAwards = onlineAwards.filter(a => a.classification_id === classification.id);

          return (
            <div key={classification.id} className="border-2 border-slate-200 rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">{classification.name}</h2>
                  {classification.description && (
                    <p className="text-sm text-slate-600 mt-1">{classification.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleOpenClassificationDialog(classification)}
                  >
                    <Pencil className="w-3 h-3 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDeletingClassification(classification);
                      setDeleteClassificationDialogOpen(true);
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              {classificationAwards.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <p>No awards in this classification yet.</p>
                  <p className="text-sm mt-1">Create an award and assign it to this classification.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {classificationAwards.map(award => {
                    const awardSublevels = getAwardSublevels(award.id, false);
                    return (
                      <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                        <CardHeader className="pb-3">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <CardTitle className="text-base">{award.name}</CardTitle>
                              {award.description && (
                                <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                              )}
                            </div>
                            {award.image_url && (
                              <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                            )}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-600">Type:</span>
                            <Badge variant="secondary">{getAwardTypeLabel(award.award_type)}</Badge>
                          </div>
                          {award.threshold && (
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-slate-600">Base Threshold:</span>
                              <Badge variant="secondary">{award.threshold}</Badge>
                            </div>
                          )}
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-600">Sublevels:</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleOpenSublevelDialog({ ...award, type: 'online' })}
                              className="h-6 px-2"
                            >
                              <Badge variant="secondary">{awardSublevels.length}</Badge>
                            </Button>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-600">Status:</span>
                            <Badge variant={award.is_active ? "default" : "secondary"}>
                              {award.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                          </div>
                          <div className="flex gap-2 pt-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="flex-1"
                              onClick={() => handleOpenDialog(award, 'online')}
                            >
                              <Pencil className="w-3 h-3 mr-1" />
                              Edit
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setDeletingAward({ ...award, type: 'online' });
                                setDeleteDialogOpen(true);
                              }}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {unclassifiedAwards.length > 0 && (
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-slate-700 mb-4">Unclassified Awards</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {unclassifiedAwards.map(award => {
                const awardSublevels = getAwardSublevels(award.id, false);
                return (
                  <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-base">{award.name}</CardTitle>
                          {award.description && (
                            <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                          )}
                        </div>
                        {award.image_url && (
                          <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Type:</span>
                        <Badge variant="secondary">{getAwardTypeLabel(award.award_type)}</Badge>
                      </div>
                      {award.threshold && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Base Threshold:</span>
                          <Badge variant="secondary">{award.threshold}</Badge>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Sublevels:</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenSublevelDialog({ ...award, type: 'online' })}
                          className="h-6 px-2"
                        >
                          <Badge variant="secondary">{awardSublevels.length}</Badge>
                        </Button>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Status:</span>
                        <Badge variant={award.is_active ? "default" : "secondary"}>
                          {award.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => handleOpenDialog(award, 'online')}
                        >
                          <Pencil className="w-3 h-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDeletingAward({ ...award, type: 'online' });
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderOfflineAwards = () => {
    // Group by classification first
    const offlineClassifications = classifications.filter(c => c.award_category === 'offline' && c.is_active);
    const unclassifiedAwards = offlineAwards.filter(a => !a.classification_id);

    return (
      <div className="space-y-8">
        {offlineClassifications.map(classification => {
          const classificationAwards = offlineAwards.filter(a => a.classification_id === classification.id);

          return (
            <div key={classification.id} className="border-2 border-slate-200 rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">{classification.name}</h2>
                  {classification.description && (
                    <p className="text-sm text-slate-600 mt-1">{classification.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleOpenClassificationDialog(classification)}
                  >
                    <Pencil className="w-3 h-3 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDeletingClassification(classification);
                      setDeleteClassificationDialogOpen(true);
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              {classificationAwards.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <p>No awards in this classification yet.</p>
                  <p className="text-sm mt-1">Create an award and assign it to this classification.</p>
                </div>
              ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {classificationAwards.map(award => {
                  const awardSublevels = getAwardSublevels(award.id, true);
                  return (
                    <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <CardTitle className="text-base">{award.name}</CardTitle>
                            {award.description && (
                              <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                            )}
                          </div>
                          {award.image_url && (
                            <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {award.period_text && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-600">Period:</span>
                            <Badge variant="secondary">{award.period_text}</Badge>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Sublevels:</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenSublevelDialog({ ...award, type: 'offline' })}
                            className="h-6 px-2"
                          >
                            <Badge variant="secondary">{awardSublevels.length}</Badge>
                          </Button>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Assigned:</span>
                          <button
                            onClick={() => handleOpenViewAssignmentsDialog({ ...award, type: 'offline' })}
                            className="hover:opacity-80 transition-opacity"
                          >
                            <Badge variant="secondary" className="cursor-pointer">
                              <Users className="w-3 h-3 mr-1" />
                              {getAssignmentCount(award.id)}
                            </Badge>
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Status:</span>
                          <Badge variant={award.is_active ? "default" : "secondary"}>
                            {award.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        <div className="flex gap-2 pt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() => handleOpenAssignDialog({ ...award, type: 'offline' })}
                          >
                            <UserPlus className="w-3 h-3 mr-1" />
                            Assign
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleOpenDialog(award, 'offline')}
                          >
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDeletingAward({ ...award, type: 'offline' });
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              )}
            </div>
          );
        })}

        {unclassifiedAwards.length > 0 && (
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-slate-700 mb-4">Unclassified Awards</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {unclassifiedAwards.map(award => {
                const awardSublevels = getAwardSublevels(award.id, true);
                return (
                  <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-base">{award.name}</CardTitle>
                          {award.description && (
                            <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                          )}
                        </div>
                        {award.image_url && (
                          <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {award.period_text && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Period:</span>
                          <Badge variant="secondary">{award.period_text}</Badge>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Sublevels:</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenSublevelDialog({ ...award, type: 'offline' })}
                          className="h-6 px-2"
                        >
                          <Badge variant="secondary">{awardSublevels.length}</Badge>
                        </Button>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Assigned:</span>
                        <button
                          onClick={() => handleOpenViewAssignmentsDialog({ ...award, type: 'offline' })}
                          className="hover:opacity-80 transition-opacity"
                        >
                          <Badge variant="secondary" className="cursor-pointer">
                            <Users className="w-3 h-3 mr-1" />
                            {getAssignmentCount(award.id)}
                          </Badge>
                        </button>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Status:</span>
                        <Badge variant={award.is_active ? "default" : "secondary"}>
                          {award.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => handleOpenAssignDialog({ ...award, type: 'offline' })}
                        >
                          <UserPlus className="w-3 h-3 mr-1" />
                          Assign
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenDialog(award, 'offline')}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDeletingAward({ ...award, type: 'offline' });
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderEngagementAwards = () => {
    const engagementClassifications = classifications.filter(c => c.award_category === 'engagement' && c.is_active);
    const unclassifiedAwards = engagementAwards.filter(a => !a.classification_id);

    const getEngagementAssignmentCount = (awardId) => {
      return engagementAssignments.filter(a => a.engagement_award_id === awardId).length;
    };

    return (
      <div className="space-y-8">
        {engagementClassifications.map(classification => {
          const classificationAwards = engagementAwards.filter(a => a.classification_id === classification.id);

          return (
            <div key={classification.id} className="border-2 border-slate-200 rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">{classification.name}</h2>
                  {classification.description && (
                    <p className="text-sm text-slate-600 mt-1">{classification.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleOpenClassificationDialog(classification)}
                  >
                    <Pencil className="w-3 h-3 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDeletingClassification(classification);
                      setDeleteClassificationDialogOpen(true);
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              {classificationAwards.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <p>No awards in this classification yet.</p>
                  <p className="text-sm mt-1">Create an award and assign it to this classification.</p>
                </div>
              ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {classificationAwards.map(award => {
                  const awardSublevels = getAwardSublevels(award.id, 'engagement');
                  return (
                    <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <CardTitle className="text-base">{award.name}</CardTitle>
                            {award.description && (
                              <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                            )}
                          </div>
                          {award.image_url && (
                            <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {award.period_text && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-600">Period:</span>
                            <Badge variant="secondary">{award.period_text}</Badge>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Sublevels:</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenSublevelDialog({ ...award, type: 'engagement' })}
                            className="h-6 px-2"
                          >
                            <Badge variant="secondary">{awardSublevels.length}</Badge>
                          </Button>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Assigned:</span>
                          <button
                            onClick={() => handleOpenViewAssignmentsDialog({ ...award, type: 'engagement' })}
                            className="hover:opacity-80 transition-opacity"
                          >
                            <Badge variant="secondary" className="cursor-pointer">
                              <Users className="w-3 h-3 mr-1" />
                              {getEngagementAssignmentCount(award.id)}
                            </Badge>
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Status:</span>
                          <Badge variant={award.is_active ? "default" : "secondary"}>
                            {award.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        <div className="flex gap-2 pt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() => handleOpenAssignDialog({ ...award, type: 'engagement' })}
                          >
                            <UserPlus className="w-3 h-3 mr-1" />
                            Assign
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleOpenDialog(award, 'engagement')}
                          >
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDeletingAward({ ...award, type: 'engagement' });
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              )}
            </div>
          );
        })}

        {unclassifiedAwards.length > 0 && (
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-slate-700 mb-4">Unclassified Awards</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {unclassifiedAwards.map(award => {
                const awardSublevels = getAwardSublevels(award.id, 'engagement');
                return (
                  <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-base">{award.name}</CardTitle>
                          {award.description && (
                            <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                          )}
                        </div>
                        {award.image_url && (
                          <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {award.period_text && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Period:</span>
                          <Badge variant="secondary">{award.period_text}</Badge>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Sublevels:</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenSublevelDialog({ ...award, type: 'engagement' })}
                          className="h-6 px-2"
                        >
                          <Badge variant="secondary">{awardSublevels.length}</Badge>
                        </Button>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Assigned:</span>
                        <button
                          onClick={() => handleOpenViewAssignmentsDialog({ ...award, type: 'engagement' })}
                          className="hover:opacity-80 transition-opacity"
                        >
                          <Badge variant="secondary" className="cursor-pointer">
                            <Users className="w-3 h-3 mr-1" />
                            {getEngagementAssignmentCount(award.id)}
                          </Badge>
                        </button>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Status:</span>
                        <Badge variant={award.is_active ? "default" : "secondary"}>
                          {award.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => handleOpenAssignDialog({ ...award, type: 'engagement' })}
                        >
                          <UserPlus className="w-3 h-3 mr-1" />
                          Assign
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenDialog(award, 'engagement')}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDeletingAward({ ...award, type: 'engagement' });
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderOrganisationAwards = () => {
    const organisationClassifications = classifications.filter(c => c.award_category === 'organisation' && c.is_active);
    const unclassifiedAwards = organisationAwards.filter(a => !a.classification_id);

    const getOrganisationAssignmentCount = (awardId) => {
      return organisationAssignments.filter(a => a.organisation_award_id === awardId).length;
    };

    return (
      <div className="space-y-8">
        {organisationClassifications.map(classification => {
          const classificationAwards = organisationAwards.filter(a => a.classification_id === classification.id);

          return (
            <div key={classification.id} className="border-2 border-slate-200 rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">{classification.name}</h2>
                  {classification.description && (
                    <p className="text-sm text-slate-600 mt-1">{classification.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleOpenClassificationDialog(classification)}
                  >
                    <Pencil className="w-3 h-3 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDeletingClassification(classification);
                      setDeleteClassificationDialogOpen(true);
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              {classificationAwards.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <p>No awards in this classification yet.</p>
                  <p className="text-sm mt-1">Create an award and assign it to this classification.</p>
                </div>
              ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {classificationAwards.map(award => {
                  const awardSublevels = getAwardSublevels(award.id, 'organisation');
                  return (
                    <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <CardTitle className="text-base">{award.name}</CardTitle>
                            {award.description && (
                              <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                            )}
                          </div>
                          {award.image_url && (
                            <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {award.period_text && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-600">Period:</span>
                            <Badge variant="secondary">{award.period_text}</Badge>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Sublevels:</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenSublevelDialog({ ...award, type: 'organisation' })}
                            className="h-6 px-2"
                          >
                            <Badge variant="secondary">{awardSublevels.length}</Badge>
                          </Button>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Assigned:</span>
                          <button
                            onClick={() => handleOpenViewAssignmentsDialog({ ...award, type: 'organisation' })}
                            className="hover:opacity-80 transition-opacity"
                          >
                            <Badge variant="secondary" className="cursor-pointer">
                              <Building2 className="w-3 h-3 mr-1" />
                              {getOrganisationAssignmentCount(award.id)}
                            </Badge>
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Status:</span>
                          <Badge variant={award.is_active ? "default" : "secondary"}>
                            {award.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        <div className="flex gap-2 pt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() => handleOpenAssignDialog({ ...award, type: 'organisation' })}
                          >
                            <Building2 className="w-3 h-3 mr-1" />
                            Assign
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleOpenDialog(award, 'organisation')}
                          >
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDeletingAward({ ...award, type: 'organisation' });
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              )}
            </div>
          );
        })}

        {unclassifiedAwards.length > 0 && (
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-slate-700 mb-4">Unclassified Awards</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {unclassifiedAwards.map(award => {
                const awardSublevels = getAwardSublevels(award.id, 'organisation');
                const getOrganisationAssignmentCount = (awardId) => {
                  return organisationAssignments.filter(a => a.organisation_award_id === awardId).length;
                };
                return (
                  <Card key={award.id} className="border-slate-200 hover:shadow-md transition-shadow">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-base">{award.name}</CardTitle>
                          {award.description && (
                            <p className="text-xs text-slate-600 mt-1">{award.description}</p>
                          )}
                        </div>
                        {award.image_url && (
                          <img src={award.image_url} alt={award.name} className="w-12 h-12 object-contain ml-2" />
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {award.period_text && (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">Period:</span>
                          <Badge variant="secondary">{award.period_text}</Badge>
                        </div>
                      )}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Sublevels:</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenSublevelDialog({ ...award, type: 'organisation' })}
                          className="h-6 px-2"
                        >
                          <Badge variant="secondary">{awardSublevels.length}</Badge>
                        </Button>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Assigned:</span>
                        <button
                          onClick={() => handleOpenViewAssignmentsDialog({ ...award, type: 'organisation' })}
                          className="hover:opacity-80 transition-opacity"
                        >
                          <Badge variant="secondary" className="cursor-pointer">
                            <Building2 className="w-3 h-3 mr-1" />
                            {getOrganisationAssignmentCount(award.id)}
                          </Badge>
                        </button>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">Status:</span>
                        <Badge variant={award.is_active ? "default" : "secondary"}>
                          {award.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <div className="flex gap-2 pt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={() => handleOpenAssignDialog({ ...award, type: 'organisation' })}
                        >
                          <Building2 className="w-3 h-3 mr-1" />
                          Assign
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenDialog(award, 'organisation')}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setDeletingAward({ ...award, type: 'organisation' });
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const isLoading = onlineLoading || offlineLoading || engagementLoading || organisationLoading;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Award Management
            </h1>
            <p className="text-slate-600">Create and manage online and offline awards</p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex items-center justify-between mb-6">
            <TabsList>
              <TabsTrigger value="online">Online Awards</TabsTrigger>
              <TabsTrigger value="offline">Offline Awards</TabsTrigger>
              <TabsTrigger value="engagement">Engagement</TabsTrigger>
              <TabsTrigger value="organisation">Organisation Awards</TabsTrigger>
            </TabsList>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => handleOpenClassificationDialog()}
                className="bg-white"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Classification
              </Button>
              <Button
                onClick={() => handleOpenDialog(null, activeTab)}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add {activeTab === 'online' ? 'Online' : activeTab === 'offline' ? 'Offline' : activeTab === 'engagement' ? 'Engagement' : 'Organisation'} Award
              </Button>
            </div>
          </div>

          <TabsContent value="online">
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : onlineAwards.length === 0 && classifications.filter(c => c.award_category === 'online' && c.is_active).length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <Trophy className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No online awards yet</h3>
                  <p className="text-slate-600 mb-6">Create your first online award to get started</p>
                  <Button onClick={() => handleOpenDialog(null, 'online')} className="bg-blue-600 hover:bg-blue-700">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Online Award
                  </Button>
                </CardContent>
              </Card>
            ) : (
              renderOnlineAwards()
            )}
          </TabsContent>

          <TabsContent value="offline">
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : offlineAwards.length === 0 && classifications.filter(c => c.award_category === 'offline' && c.is_active).length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <Trophy className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No offline awards yet</h3>
                  <p className="text-slate-600 mb-6">Create your first offline award to get started</p>
                  <Button onClick={() => handleOpenDialog(null, 'offline')} className="bg-blue-600 hover:bg-blue-700">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Offline Award
                  </Button>
                </CardContent>
              </Card>
            ) : (
              renderOfflineAwards()
            )}
          </TabsContent>

          <TabsContent value="engagement">
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : engagementAwards.length === 0 && classifications.filter(c => c.award_category === 'engagement' && c.is_active).length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <Trophy className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No engagement awards yet</h3>
                  <p className="text-slate-600 mb-6">Create your first engagement award to get started</p>
                  <Button onClick={() => handleOpenDialog(null, 'engagement')} className="bg-blue-600 hover:bg-blue-700">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Engagement Award
                  </Button>
                </CardContent>
              </Card>
            ) : (
              renderEngagementAwards()
            )}
          </TabsContent>

          <TabsContent value="organisation">
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : organisationAwards.length === 0 && classifications.filter(c => c.award_category === 'organisation' && c.is_active).length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <Trophy className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No organisation awards yet</h3>
                  <p className="text-slate-600 mb-6">Create your first organisation award to get started</p>
                  <Button onClick={() => handleOpenDialog(null, 'organisation')} className="bg-blue-600 hover:bg-blue-700">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Organisation Award
                  </Button>
                </CardContent>
              </Card>
            ) : (
              renderOrganisationAwards()
            )}
          </TabsContent>
        </Tabs>

        {/* Award Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editingAward ? 'Edit' : 'Create'} {
                  editingAward?.type === 'offline' || (!editingAward && activeTab === 'offline') ? 'Offline' : 
                  editingAward?.type === 'engagement' || (!editingAward && activeTab === 'engagement') ? 'Engagement' :
                  editingAward?.type === 'organisation' || (!editingAward && activeTab === 'organisation') ? 'Organisation' : 'Online'
                } Award
              </DialogTitle>
              <DialogDescription>
                {editingAward?.type === 'offline' || (!editingAward && activeTab === 'offline')
                  ? 'Create manually assigned awards for specific periods or achievements'
                  : editingAward?.type === 'engagement' || (!editingAward && activeTab === 'engagement')
                  ? 'Create engagement awards for recognizing member participation and involvement'
                  : editingAward?.type === 'organisation' || (!editingAward && activeTab === 'organisation')
                  ? 'Create organisation awards for recognizing organisation achievements'
                  : 'Awards are automatically earned when members reach the specified threshold'}
              </DialogDescription>
            </DialogHeader>

            {editingAward?.type === 'engagement' || (!editingAward && activeTab === 'engagement') ? (
              // Engagement Award Form (same structure as offline)
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Award Name *</Label>
                  <Input
                    id="name"
                    value={engagementFormData.name}
                    onChange={(e) => setEngagementFormData({ ...engagementFormData, name: e.target.value })}
                    placeholder="e.g., Community Champion Award"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={engagementFormData.description}
                    onChange={(e) => setEngagementFormData({ ...engagementFormData, description: e.target.value })}
                    placeholder="What does this award represent?"
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="classification">Classification</Label>
                  <Select
                    value={engagementFormData.classification_id}
                    onValueChange={(value) => setEngagementFormData({ ...engagementFormData, classification_id: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select classification (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>No Classification</SelectItem>
                      {classifications.filter(c => c.award_category === 'engagement').map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="period_text">Period / Achievement</Label>
                  <Input
                    id="period_text"
                    value={engagementFormData.period_text}
                    onChange={(e) => setEngagementFormData({ ...engagementFormData, period_text: e.target.value })}
                    placeholder="e.g., Q1 2024, Annual, etc."
                  />
                  <p className="text-xs text-slate-500">Free text for the period or achievement</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="level">Level *</Label>
                  <Input
                    id="level"
                    type="number"
                    value={engagementFormData.level}
                    onChange={(e) => setEngagementFormData({ ...engagementFormData, level: e.target.value })}
                    placeholder="e.g., 1"
                  />
                  <p className="text-xs text-slate-500">Used for ordering awards (1 = first, 2 = second, etc.)</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="image">Award Image</Label>
                  <div className="flex items-center gap-4">
                    {engagementFormData.image_url && (
                      <img src={engagementFormData.image_url} alt="Award" className="w-16 h-16 object-contain border border-slate-200 rounded" />
                    )}
                    <div>
                      <input
                        type="file"
                        id="engagement-image-upload"
                        accept="image/*"
                        onChange={(e) => handleImageUpload(e, 'engagement')}
                        className="hidden"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => document.getElementById('engagement-image-upload')?.click()}
                        disabled={isUploadingImage}
                      >
                        {isUploadingImage ? (
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        ) : (
                          <Upload className="w-4 h-4 mr-2" />
                        )}
                        Upload Image
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    id="is_active"
                    checked={engagementFormData.is_active}
                    onCheckedChange={(checked) => setEngagementFormData({ ...engagementFormData, is_active: checked })}
                  />
                  <Label htmlFor="is_active">Active</Label>
                </div>
              </div>
            ) : editingAward?.type === 'organisation' || (!editingAward && activeTab === 'organisation') ? (
              // Organisation Award Form (same structure as offline)
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Award Name *</Label>
                  <Input
                    id="name"
                    value={organisationFormData.name}
                    onChange={(e) => setOrganisationFormData({ ...organisationFormData, name: e.target.value })}
                    placeholder="e.g., Organisation Excellence Award"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={organisationFormData.description}
                    onChange={(e) => setOrganisationFormData({ ...organisationFormData, description: e.target.value })}
                    placeholder="What does this award represent?"
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="classification">Classification</Label>
                  <Select
                    value={organisationFormData.classification_id}
                    onValueChange={(value) => setOrganisationFormData({ ...organisationFormData, classification_id: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select classification (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>No Classification</SelectItem>
                      {classifications.filter(c => c.award_category === 'organisation').map(c => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="period_text">Period / Achievement</Label>
                  <Input
                    id="period_text"
                    value={organisationFormData.period_text}
                    onChange={(e) => setOrganisationFormData({ ...organisationFormData, period_text: e.target.value })}
                    placeholder="e.g., 2024, Annual, etc."
                  />
                  <p className="text-xs text-slate-500">Free text for the period or achievement</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="level">Level *</Label>
                  <Input
                    id="level"
                    type="number"
                    value={organisationFormData.level}
                    onChange={(e) => setOrganisationFormData({ ...organisationFormData, level: e.target.value })}
                    placeholder="e.g., 1"
                  />
                  <p className="text-xs text-slate-500">Used for ordering awards (1 = first, 2 = second, etc.)</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="image">Award Image</Label>
                  <div className="flex items-center gap-4">
                    {organisationFormData.image_url && (
                      <img src={organisationFormData.image_url} alt="Award" className="w-16 h-16 object-contain border border-slate-200 rounded" />
                    )}
                    <div>
                      <input
                        type="file"
                        id="organisation-image-upload"
                        accept="image/*"
                        onChange={(e) => handleImageUpload(e, 'organisation')}
                        className="hidden"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => document.getElementById('organisation-image-upload')?.click()}
                        disabled={isUploadingImage}
                      >
                        {isUploadingImage ? (
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        ) : (
                          <Upload className="w-4 h-4 mr-2" />
                        )}
                        Upload Image
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    id="is_active"
                    checked={organisationFormData.is_active}
                    onCheckedChange={(checked) => setOrganisationFormData({ ...organisationFormData, is_active: checked })}
                  />
                  <Label htmlFor="is_active">Active</Label>
                </div>
              </div>
            ) : editingAward?.type === 'offline' || (!editingAward && activeTab === 'offline') ? (
              // Offline Award Form
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Award Name *</Label>
                  <Input
                    id="name"
                    value={offlineFormData.name}
                    onChange={(e) => setOfflineFormData({ ...offlineFormData, name: e.target.value })}
                    placeholder="e.g., Outstanding Contribution Award"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={offlineFormData.description}
                    onChange={(e) => setOfflineFormData({ ...offlineFormData, description: e.target.value })}
                    placeholder="What does this award represent?"
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="classification">Classification</Label>
                  <Select
                    value={offlineFormData.classification_id}
                    onValueChange={(value) => setOfflineFormData({ ...offlineFormData, classification_id: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select classification (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                     <SelectItem value={null}>No Classification</SelectItem>
                     {classifications.filter(c => c.award_category === 'offline').map(c => (
                       <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                     ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="period_text">Period / Achievement *</Label>
                  <Input
                    id="period_text"
                    value={offlineFormData.period_text}
                    onChange={(e) => setOfflineFormData({ ...offlineFormData, period_text: e.target.value })}
                    placeholder="e.g., 1st quarter, 2026, Summer 25"
                  />
                  <p className="text-xs text-slate-500">Free text for the period or achievement</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="level">Level *</Label>
                  <Input
                    id="level"
                    type="number"
                    value={offlineFormData.level}
                    onChange={(e) => setOfflineFormData({ ...offlineFormData, level: e.target.value })}
                    placeholder="e.g., 1"
                  />
                  <p className="text-xs text-slate-500">Used for ordering awards (1 = first, 2 = second, etc.)</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="image">Award Image</Label>
                  <div className="flex items-center gap-4">
                    {offlineFormData.image_url && (
                      <img src={offlineFormData.image_url} alt="Award" className="w-16 h-16 object-contain border border-slate-200 rounded" />
                    )}
                    <div className="flex-1">
                      <input
                        type="file"
                        id="image-upload-offline"
                        accept="image/*"
                        onChange={(e) => handleImageUpload(e, 'offline')}
                        className="hidden"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isUploadingImage}
                        onClick={() => document.getElementById('image-upload-offline').click()}
                      >
                        {isUploadingImage ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4 mr-2" />
                            Upload Image
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="is_active">Active</Label>
                  <Switch
                    id="is_active"
                    checked={offlineFormData.is_active}
                    onCheckedChange={(checked) => setOfflineFormData({ ...offlineFormData, is_active: checked })}
                  />
                </div>
              </div>
            ) : (
              // Online Award Form
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Award Name *</Label>
                  <Input
                    id="name"
                    value={onlineFormData.name}
                    onChange={(e) => setOnlineFormData({ ...onlineFormData, name: e.target.value })}
                    placeholder="e.g., Event Champion I"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={onlineFormData.description}
                    onChange={(e) => setOnlineFormData({ ...onlineFormData, description: e.target.value })}
                    placeholder="What does this award represent?"
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="classification">Classification</Label>
                  <Select
                    value={onlineFormData.classification_id}
                    onValueChange={(value) => setOnlineFormData({ ...onlineFormData, classification_id: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select classification (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                     <SelectItem value={null}>No Classification</SelectItem>
                     {classifications.filter(c => c.award_category === 'online').map(c => (
                       <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                     ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="award_type">Award Type *</Label>
                    <Select
                      value={onlineFormData.award_type}
                      onValueChange={(value) => setOnlineFormData({ ...onlineFormData, award_type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="events_attended">Events Attended</SelectItem>
                        <SelectItem value="articles_published">Articles Published</SelectItem>
                        <SelectItem value="jobs_posted">Jobs Posted</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="threshold">Base Threshold</Label>
                    <Input
                      id="threshold"
                      type="number"
                      value={onlineFormData.threshold}
                      onChange={(e) => setOnlineFormData({ ...onlineFormData, threshold: e.target.value })}
                      placeholder="e.g., 5 (optional)"
                    />
                    <p className="text-xs text-slate-500">Leave empty to use sublevel thresholds only</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="level">Level *</Label>
                  <Input
                    id="level"
                    type="number"
                    value={onlineFormData.level}
                    onChange={(e) => setOnlineFormData({ ...onlineFormData, level: e.target.value })}
                    placeholder="e.g., 1"
                  />
                  <p className="text-xs text-slate-500">Used for ordering awards (1 = first, 2 = second, etc.)</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="image">Award Image</Label>
                  <div className="flex items-center gap-4">
                    {onlineFormData.image_url && (
                      <img src={onlineFormData.image_url} alt="Award" className="w-16 h-16 object-contain border border-slate-200 rounded" />
                    )}
                    <div className="flex-1">
                      <input
                        type="file"
                        id="image-upload-online"
                        accept="image/*"
                        onChange={(e) => handleImageUpload(e, 'online')}
                        className="hidden"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isUploadingImage}
                        onClick={() => document.getElementById('image-upload-online').click()}
                      >
                        {isUploadingImage ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4 mr-2" />
                            Upload Image
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="is_active">Active</Label>
                  <Switch
                    id="is_active"
                    checked={onlineFormData.is_active}
                    onCheckedChange={(checked) => setOnlineFormData({ ...onlineFormData, is_active: checked })}
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleCloseDialog}>
                Cancel
              </Button>
              <Button
                onClick={() => handleSubmit(editingAward?.type || activeTab)}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingAward ? 'Update' : 'Create'} Award
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Assign Award Dialog */}
        <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Assign Award: {assigningAward?.name}</DialogTitle>
              <DialogDescription>
                {assigningAward?.type === 'organisation' 
                  ? 'Select an organisation to receive this award'
                  : 'Select a member to receive this award'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4 flex-1 overflow-hidden flex flex-col">
              {assigningAward?.type === 'organisation' ? (
                <>
                  {/* Organisation Award: Select Organization Only */}
                  <div className="space-y-2">
                    <Label htmlFor="organization-select">Select Organisation *</Label>
                    <Select 
                      value={selectedOrganizationId} 
                      onValueChange={(val) => {
                        setSelectedOrganizationId(val);
                      }}
                    >
                      <SelectTrigger data-testid="select-organization">
                        <SelectValue placeholder={organizationsLoading ? "Loading organisations..." : "Select an organisation..."} />
                      </SelectTrigger>
                      <SelectContent className="max-h-[300px]">
                        {organizations.map(org => (
                          <SelectItem key={org.id} value={org.id}>
                            {org.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : (
                <>
                  {/* Member Award: Select Organization then Member */}
                  <div className="space-y-2">
                    <Label htmlFor="organization-select">Step 1: Select Organisation *</Label>
                    <Select 
                      value={selectedOrganizationId} 
                      onValueChange={(val) => {
                        setSelectedOrganizationId(val);
                        setSelectedMemberId("");
                        setMemberSearchQuery("");
                      }}
                    >
                      <SelectTrigger data-testid="select-organization">
                        <SelectValue placeholder={organizationsLoading ? "Loading organisations..." : "Select an organisation..."} />
                      </SelectTrigger>
                      <SelectContent className="max-h-[300px]">
                        <SelectItem value="__no_org__">Members without organisation</SelectItem>
                        {organizations.map(org => (
                          <SelectItem key={org.id} value={org.id}>
                            {org.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Step 2: Select Member (only shown after organization is selected) */}
                  {selectedOrganizationId && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="member-search">Step 2: Search Members</Label>
                        <Input
                          id="member-search"
                          value={memberSearchQuery}
                          onChange={(e) => setMemberSearchQuery(e.target.value)}
                          placeholder="Search by name or email..."
                          data-testid="input-member-search"
                        />
                      </div>

                      <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
                        <Label>Select Member * {membersLoading && <span className="text-slate-500">(Loading...)</span>}</Label>
                        <div className="border border-slate-200 rounded-lg overflow-y-auto flex-1">
                          {membersLoading ? (
                            <div className="p-8 text-center text-slate-500">
                              Loading members...
                            </div>
                          ) : filteredMembers.length === 0 ? (
                            <div className="p-8 text-center text-slate-500">
                              {memberSearchQuery ? 'No members match your search' : 'No members found in this organisation'}
                            </div>
                          ) : (
                            <div className="divide-y divide-slate-200">
                              {filteredMembers.map(member => (
                                <button
                                  key={member.id}
                                  onClick={() => setSelectedMemberId(member.id)}
                                  className={`w-full p-3 text-left hover:bg-slate-50 transition-colors ${
                                    selectedMemberId === member.id ? 'bg-blue-50 hover:bg-blue-100' : ''
                                  }`}
                                  data-testid={`button-select-member-${member.id}`}
                                >
                                  <div className="flex items-center justify-between">
                                    <div>
                                      <div className="font-medium text-slate-900">
                                        {member.first_name} {member.last_name}
                                      </div>
                                      <div className="text-sm text-slate-600">{member.email}</div>
                                    </div>
                                    {selectedMemberId === member.id && (
                                      <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0">
                                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                        </svg>
                                      </div>
                                    )}
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="sublevel">Award Level</Label>
                <Select value={selectedSublevelId} onValueChange={setSelectedSublevelId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select level (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                   <SelectItem value={null}>No specific level</SelectItem>
                   {getAwardSublevels(assigningAward?.id, assigningAward?.type).map(sublevel => (
                     <SelectItem key={sublevel.id} value={sublevel.id}>
                       {sublevel.name}
                     </SelectItem>
                   ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Notes (Optional)</Label>
                <Textarea
                  id="notes"
                  value={assignmentNotes}
                  onChange={(e) => setAssignmentNotes(e.target.value)}
                  placeholder="Add notes about this assignment..."
                  rows={3}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCloseAssignDialog}>
                Cancel
              </Button>
              <Button
                onClick={handleAssignAward}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={assigningAward?.type === 'organisation' 
                  ? (!selectedOrganizationId || selectedOrganizationId === "__no_org__")
                  : !selectedMemberId}
              >
                Assign Award
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* View Assignments Dialog */}
        <Dialog open={viewAssignmentsDialogOpen} onOpenChange={setViewAssignmentsDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>
                {viewingAward?.type === 'organisation' 
                  ? `Assigned Organisations: ${viewingAward?.name}`
                  : `Assigned Members: ${viewingAward?.name}`}
              </DialogTitle>
              <DialogDescription>
                {viewingAward?.type === 'organisation'
                  ? 'View and manage organisations that have received this award'
                  : 'View and manage members who have received this award'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4 flex-1 overflow-hidden flex flex-col">
              <div className="space-y-2">
                <Label htmlFor="assigned-search">
                  {viewingAward?.type === 'organisation' ? 'Search Assigned Organisations' : 'Search Assigned Members'}
                </Label>
                <Input
                  id="assigned-search"
                  value={assignedMembersSearchQuery}
                  onChange={(e) => setAssignedMembersSearchQuery(e.target.value)}
                  placeholder={viewingAward?.type === 'organisation' ? "Search by organisation name..." : "Search by name or email..."}
                />
              </div>

              <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
                <Label>
                  {viewingAward?.type === 'organisation' 
                    ? `Assigned Organisations ${allOrganizationsLoading ? '(Loading...)' : `(${filteredAssignedMembers.length})`}`
                    : `Assigned Members ${allMembersLoading ? '(Loading...)' : `(${filteredAssignedMembers.length})`}`}
                </Label>
                <div className="border border-slate-200 rounded-lg overflow-y-auto flex-1">
                  {(viewingAward?.type === 'organisation' ? allOrganizationsLoading : allMembersLoading) ? (
                    <div className="p-8 text-center text-slate-500">
                      {viewingAward?.type === 'organisation' ? 'Loading assigned organisations...' : 'Loading assigned members...'}
                    </div>
                  ) : filteredAssignedMembers.length === 0 ? (
                    <div className="p-8 text-center text-slate-500">
                      {assignedMembersSearchQuery 
                        ? (viewingAward?.type === 'organisation' ? 'No matching organisations found' : 'No matching members found')
                        : (viewingAward?.type === 'organisation' ? 'No organisations assigned to this award yet' : 'No members assigned to this award yet')}
                    </div>
                  ) : viewingAward?.type === 'organisation' ? (
                    <div className="divide-y divide-slate-200">
                      {filteredAssignedMembers.map(({ id, organization, notes, assigned_date, assigned_by, sublevel_id }) => {
                        const sublevel = sublevel_id ? sublevels.find(s => s.id === sublevel_id) : null;
                        
                        return (
                          <div key={id} className="p-3 hover:bg-slate-50">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <Building2 className="w-4 h-4 text-slate-400" />
                                  <div className="font-medium text-slate-900">
                                    {organization?.name}
                                  </div>
                                  {sublevel && (
                                    <Badge variant="secondary" className="flex items-center gap-1">
                                      {sublevel.image_url && (
                                        <img src={sublevel.image_url} alt={sublevel.name} className="w-3 h-3" />
                                      )}
                                      {sublevel.name}
                                    </Badge>
                                  )}
                                </div>
                                {notes && (
                                  <div className="text-xs text-slate-500 mt-1 italic">
                                    Note: {notes}
                                  </div>
                                )}
                                <div className="text-xs text-slate-400 mt-1">
                                  {assigned_date ? `Assigned ${new Date(assigned_date).toLocaleDateString()}` : 'Assigned'}
                                  {assigned_by && ` by ${assigned_by}`}
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setRemovingAssignment({ id, organization, type: 'organisation' });
                                  setRemoveAssignmentDialogOpen(true);
                                }}
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              >
                                <UserMinus className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-200">
                      {filteredAssignedMembers.map(({ id, member, notes, assigned_date, assigned_by, sublevel_id }) => {
                        const sublevel = sublevel_id ? sublevels.find(s => s.id === sublevel_id) : null;
                        
                        return (
                          <div key={id} className="p-3 hover:bg-slate-50">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <div className="font-medium text-slate-900">
                                    {member.first_name} {member.last_name}
                                  </div>
                                  {sublevel && (
                                    <Badge variant="secondary" className="flex items-center gap-1">
                                      {sublevel.image_url && (
                                        <img src={sublevel.image_url} alt={sublevel.name} className="w-3 h-3" />
                                      )}
                                      {sublevel.name}
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-sm text-slate-600">{member.email}</div>
                                {notes && (
                                  <div className="text-xs text-slate-500 mt-1 italic">
                                    Note: {notes}
                                  </div>
                                )}
                                <div className="text-xs text-slate-400 mt-1">
                                  {assigned_date ? `Assigned ${new Date(assigned_date).toLocaleDateString()}` : 'Assigned'}
                                  {assigned_by && ` by ${assigned_by}`}
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setRemovingAssignment({ id, member });
                                  setRemoveAssignmentDialogOpen(true);
                                }}
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              >
                                <UserMinus className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleCloseViewAssignmentsDialog}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Remove Assignment Confirmation Dialog */}
        <AlertDialog open={removeAssignmentDialogOpen} onOpenChange={setRemoveAssignmentDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Award Assignment?</AlertDialogTitle>
              <AlertDialogDescription>
                {removingAssignment?.type === 'organisation' ? (
                  <>
                    Are you sure you want to remove this award from{' '}
                    <strong>{removingAssignment?.organization?.name}</strong>?
                    This action cannot be undone.
                  </>
                ) : (
                  <>
                    Are you sure you want to remove this award from{' '}
                    <strong>{removingAssignment?.member?.first_name} {removingAssignment?.member?.last_name}</strong>?
                    This action cannot be undone.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleRemoveAssignment}
                className="bg-red-600 hover:bg-red-700"
              >
                Remove Award
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the award "{deletingAward?.name}". This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Classification Dialog */}
        <Dialog open={classificationDialogOpen} onOpenChange={setClassificationDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingClassification ? 'Edit' : 'Create'} Classification</DialogTitle>
              <DialogDescription>
                Organize awards into categories like Writing Awards, Attendance Awards, etc.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="class-name">Name *</Label>
                <Input
                  id="class-name"
                  value={classificationFormData.name}
                  onChange={(e) => setClassificationFormData({ ...classificationFormData, name: e.target.value })}
                  placeholder="e.g., Writing Awards"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="class-description">Description</Label>
                <Textarea
                  id="class-description"
                  value={classificationFormData.description}
                  onChange={(e) => setClassificationFormData({ ...classificationFormData, description: e.target.value })}
                  placeholder="Describe this classification"
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="class-category">Category *</Label>
                <Select
                  value={classificationFormData.award_category}
                  onValueChange={(value) => setClassificationFormData({ ...classificationFormData, award_category: value })}
                  disabled={!!editingClassification}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="online">Online Awards</SelectItem>
                    <SelectItem value="offline">Offline Awards</SelectItem>
                    <SelectItem value="engagement">Engagement Awards</SelectItem>
                    <SelectItem value="organisation">Organisation Awards</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="class-order">Display Order</Label>
                <Input
                  id="class-order"
                  type="number"
                  value={classificationFormData.display_order}
                  onChange={(e) => setClassificationFormData({ ...classificationFormData, display_order: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="class-active">Active</Label>
                <Switch
                  id="class-active"
                  checked={classificationFormData.is_active}
                  onCheckedChange={(checked) => setClassificationFormData({ ...classificationFormData, is_active: checked })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setClassificationDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSubmitClassification} className="bg-blue-600 hover:bg-blue-700">
                {editingClassification ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Classification Dialog */}
        <AlertDialog open={deleteClassificationDialogOpen} onOpenChange={setDeleteClassificationDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Classification?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete "{deletingClassification?.name}". Awards in this classification will become unclassified.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteClassificationMutation.mutate(deletingClassification.id)}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Sublevel Management Dialog */}
        <Dialog open={sublevelDialogOpen} onOpenChange={setSublevelDialogOpen}>
          <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Manage Sublevels: {managingSublevelsForAward?.name}</DialogTitle>
              <DialogDescription>
                Add Bronze, Silver, Gold or custom sublevels for this award
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="mb-4">
                <Button onClick={() => handleOpenSublevelFormDialog(null)} size="sm">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Sublevel
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto border border-slate-200 rounded-lg">
                {getAwardSublevels(managingSublevelsForAward?.id, managingSublevelsForAward?.type).length === 0 ? (
                  <div className="p-8 text-center text-slate-500">
                    No sublevels yet. Add Bronze, Silver, Gold levels.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200">
                    {getAwardSublevels(managingSublevelsForAward?.id, managingSublevelsForAward?.type).map(sublevel => (
                      <div key={sublevel.id} className="p-4 hover:bg-slate-50">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3">
                              {sublevel.image_url && (
                                <img src={sublevel.image_url} alt={sublevel.name} className="w-10 h-10 object-contain" />
                              )}
                              <div>
                                <div className="font-medium text-slate-900">{sublevel.name}</div>
                                <div className="flex gap-2 mt-1">
                                  {sublevel.threshold && (
                                    <Badge variant="secondary">Threshold: {sublevel.threshold}</Badge>
                                  )}
                                  <Badge variant="secondary">Order: {sublevel.display_order}</Badge>
                                  <Badge variant={sublevel.is_active ? "default" : "secondary"}>
                                    {sublevel.is_active ? 'Active' : 'Inactive'}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleOpenSublevelFormDialog(sublevel)}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setDeletingSublevel(sublevel);
                                setDeleteSublevelDialogOpen(true);
                              }}
                              className="text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setSublevelDialogOpen(false);
                setManagingSublevelsForAward(null);
              }}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Add/Edit Sublevel Dialog */}
        <Dialog open={sublevelFormDialogOpen} onOpenChange={setSublevelFormDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingSublevel ? 'Edit' : 'Add'} Sublevel</DialogTitle>
              <DialogDescription>
                Define a sublevel like Bronze, Silver, or Gold
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="sublevel-name">Name *</Label>
                <Input
                  id="sublevel-name"
                  value={sublevelFormData.name}
                  onChange={(e) => setSublevelFormData({ ...sublevelFormData, name: e.target.value })}
                  placeholder="e.g., Bronze, Silver, Gold"
                />
              </div>
              {managingSublevelsForAward?.type === 'online' && (
                <div className="space-y-2">
                  <Label htmlFor="sublevel-threshold">Threshold</Label>
                  <Input
                    id="sublevel-threshold"
                    type="number"
                    value={sublevelFormData.threshold}
                    onChange={(e) => setSublevelFormData({ ...sublevelFormData, threshold: e.target.value })}
                    placeholder="e.g., 5"
                  />
                  <p className="text-xs text-slate-500">Override the award's base threshold for this sublevel</p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="sublevel-order">Display Order *</Label>
                <Input
                  id="sublevel-order"
                  type="number"
                  value={sublevelFormData.display_order}
                  onChange={(e) => setSublevelFormData({ ...sublevelFormData, display_order: e.target.value })}
                  placeholder="0"
                />
                <p className="text-xs text-slate-500">0 = Bronze, 1 = Silver, 2 = Gold, etc.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sublevel-image">Image</Label>
                <div className="flex items-center gap-4">
                  {sublevelFormData.image_url && (
                    <img src={sublevelFormData.image_url} alt="Sublevel" className="w-16 h-16 object-contain border border-slate-200 rounded" />
                  )}
                  <div className="flex-1">
                    <input
                      type="file"
                      id="sublevel-image-upload"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setIsUploadingImage(true);
                        base44.integrations.Core.UploadFile({ file }).then(result => {
                          setSublevelFormData(prev => ({ ...prev, image_url: result.file_url }));
                          toast.success('Image uploaded');
                        }).catch(() => {
                          toast.error('Failed to upload image');
                        }).finally(() => {
                          setIsUploadingImage(false);
                        });
                      }}
                      className="hidden"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isUploadingImage}
                      onClick={() => document.getElementById('sublevel-image-upload').click()}
                    >
                      {isUploadingImage ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4 mr-2" />
                          Upload Image
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="sublevel-active">Active</Label>
                <Switch
                  id="sublevel-active"
                  checked={sublevelFormData.is_active}
                  onCheckedChange={(checked) => setSublevelFormData({ ...sublevelFormData, is_active: checked })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setSublevelFormDialogOpen(false);
                setEditingSublevel(null);
              }}>Cancel</Button>
              <Button onClick={handleSubmitSublevel} className="bg-blue-600 hover:bg-blue-700">
                {editingSublevel ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Sublevel Dialog */}
        <AlertDialog open={deleteSublevelDialogOpen} onOpenChange={setDeleteSublevelDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Sublevel?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the "{deletingSublevel?.name}" sublevel.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteSublevelMutation.mutate(deletingSublevel.id)}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}