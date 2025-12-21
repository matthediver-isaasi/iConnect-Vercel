import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, FileText, Search, X, Image as ImageIcon, Shield, Folder, FolderOpen, FolderPlus, MoveHorizontal, ChevronRight, Home, GripVertical, ChevronLeft, Calendar, Clock } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { format } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function ResourceManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingResource, setEditingResource] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [newTag, setNewTag] = useState("");
  const [showFileSelector, setShowFileSelector] = useState(null);
  const [subcategorySearch, setSubcategorySearch] = useState("");
  const [imageFromRepository, setImageFromRepository] = useState(false);
  const [targetFromRepository, setTargetFromRepository] = useState(false);
  const [targetFileName, setTargetFileName] = useState("");
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);

  // Folder management states for resources
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [showFolderDialog, setShowFolderDialog] = useState(false);
  const [editingFolder, setEditingFolder] = useState(null);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showMoveFolderDialog, setShowMoveFolderDialog] = useState(false);
  const [folderToMove, setFolderToMove] = useState(null);
  const [selectedResources, setSelectedResources] = useState([]);
  const [bulkMoveMode, setBulkMoveMode] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState({});

  // File selector folder navigation states
  const [fileSelectorFolder, setFileSelectorFolder] = useState(null);
  const [fileSelectorExpandedFolders, setFileSelectorExpandedFolders] = useState({});
  
  // File selector pagination and search states
  const [fileSelectorPage, setFileSelectorPage] = useState(1);
  const [fileSelectorItemsPerPage] = useState(12);
  const [fileSelectorSearch, setFileSelectorSearch] = useState("");

  // Drag and drop states
  const [draggedResources, setDraggedResources] = useState([]);
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [autoExpandTimeout, setAutoExpandTimeout] = useState(null);

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(9);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('content.resource-management')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: resources = [], isLoading } = useQuery({
    queryKey: ['admin-resources'],
    queryFn: () => base44.entities.Resource.list('-release_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['resourceCategories'],
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      return cats.filter(c => c.is_active).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: repositoryFiles = [] } = useQuery({
    queryKey: ['file-repository'],
    queryFn: () => base44.entities.FileRepository.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: fileRepositoryFolders = [] } = useQuery({
    queryKey: ['file-repository-folders'],
    queryFn: () => base44.entities.FileRepositoryFolder.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: authorSettings } = useQuery({
    queryKey: ['resource-author-settings'],
    queryFn: async () => {
      const settings = await base44.entities.ResourceAuthorSettings.list();
      return settings.length > 0 ? settings[0] : null;
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: members = [] } = useQuery({
    queryKey: ['members'],
    queryFn: () => base44.entities.Member.listAll(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: teamMembers = [] } = useQuery({
    queryKey: ['team-members'],
    queryFn: () => base44.entities.TeamMember.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: folders = [], isLoading: foldersLoading } = useQuery({
    queryKey: ['resource-folders'],
    queryFn: () => base44.entities.ResourceFolder.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Get available authors based on selected roles in settings
  const availableAuthors = useMemo(() => {
    if (!authorSettings || !authorSettings.author_role_ids || authorSettings.author_role_ids.length === 0) {
      return [];
    }

    const allowedRoleIds = authorSettings.author_role_ids;

    const filteredMembers = members
      .filter(m => m.role_id && allowedRoleIds.includes(m.role_id))
      .map(m => ({
        id: m.id,
        name: `${m.first_name} ${m.last_name}`,
        email: m.email,
        type: 'member'
      }));

    const filteredTeamMembers = teamMembers
      .filter(tm => tm.role_id && allowedRoleIds.includes(tm.role_id))
      .map(tm => ({
        id: tm.id,
        name: `${tm.first_name} ${tm.last_name}`,
        email: tm.email,
        type: 'team_member'
      }));

    return [...filteredMembers, ...filteredTeamMembers].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [authorSettings, members, teamMembers]);

  // Get all unique tags from existing resources
  const allExistingTags = useMemo(() => {
    const tagSet = new Set();
    resources.forEach(resource => {
      if (resource.tags && Array.isArray(resource.tags)) {
        resource.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort();
  }, [resources]);

  // Filter tags based on current input
  const filteredTagSuggestions = useMemo(() => {
    if (!newTag.trim()) return [];
    const searchLower = newTag.toLowerCase();
    return allExistingTags.filter(tag =>
      tag.toLowerCase().includes(searchLower) &&
      !(editingResource?.tags || []).includes(tag)
    );
  }, [newTag, allExistingTags, editingResource?.tags]);

  // Build folder hierarchy for resources
  const folderHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return folders
        .filter(f => f.parent_folder_id === parentId)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(folder => ({
          ...folder,
          children: buildTree(folder.id)
        }));
    };
    return buildTree(null);
  }, [folders]);

  // Build folder hierarchy for file selector
  const fileSelectorFolderHierarchy = useMemo(() => {
    const buildTree = (parentId) => {
      return fileRepositoryFolders
        .filter(f => f.parent_folder_id === parentId)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(folder => ({
          ...folder,
          children: buildTree(folder.id)
        }));
    };
    return buildTree(null);
  }, [fileRepositoryFolders]);

  // Get breadcrumb trail
  const getBreadcrumb = (folderId) => {
    if (!folderId) return [];
    const trail = [];
    let currentId = folderId;

    while (currentId) {
      const folder = folders.find(f => f.id === currentId);
      if (folder) {
        trail.unshift(folder);
        currentId = folder.parent_folder_id;
      } else {
        break;
      }
    }
    return trail;
  };

  // Get breadcrumb trail for file selector
  const getFileSelectorBreadcrumb = (folderId) => {
    if (!folderId) return [];
    const trail = [];
    let currentId = folderId;

    while (currentId) {
      const folder = fileRepositoryFolders.find(f => f.id === currentId);
      if (folder) {
        trail.unshift(folder);
        currentId = folder.parent_folder_id;
      } else {
        break;
      }
    }
    return trail;
  };

  const breadcrumb = useMemo(() => getBreadcrumb(selectedFolder), [selectedFolder, folders]);
  const fileSelectorBreadcrumb = useMemo(() => getFileSelectorBreadcrumb(fileSelectorFolder), [fileSelectorFolder, fileRepositoryFolders]);

  // Get all subfolders recursively
  const getAllSubfolderIds = (folderId) => {
    const result = [folderId];
    const children = folders.filter(f => f.parent_folder_id === folderId);
    children.forEach(child => {
      result.push(...getAllSubfolderIds(child.id));
    });
    return result;
  };

  const filteredCategoriesForSelection = useMemo(() => {
    if (!subcategorySearch.trim()) return categories;

    const searchLower = subcategorySearch.toLowerCase();
    return categories.map(cat => {
      if (!cat.subcategories || cat.subcategories.length === 0) return null;

      const matchingSubcategories = cat.subcategories.filter(sub =>
        sub.toLowerCase().includes(searchLower)
      );

      const categoryNameMatches = cat.name.toLowerCase().includes(searchLower);

      if (matchingSubcategories.length === 0 && !categoryNameMatches) {
        return null;
      }

      return {
        ...cat,
        subcategories: matchingSubcategories.length > 0 ? matchingSubcategories : cat.subcategories
      };
    }).filter(Boolean);
  }, [categories, subcategorySearch]);

  const filteredResources = useMemo(() => {
    return resources.filter(resource => {
      const matchesFolder = selectedFolder === null
        ? !resource.folder_id
        : resource.folder_id === selectedFolder;

      const matchesCategory = filterCategory === "all" ||
        (resource.subcategories && resource.subcategories.some(sub => {
          const parentCat = categories.find(cat =>
            cat.subcategories && cat.subcategories.includes(sub)
          );
          return parentCat?.name === filterCategory;
        }));
      const matchesSearch = !searchQuery ||
        resource.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        resource.description?.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesFolder && matchesCategory && matchesSearch;
    });
  }, [resources, selectedFolder, filterCategory, searchQuery, categories]);

  // Filter files in file selector by selected folder and search
  const filteredRepositoryFiles = useMemo(() => {
    return repositoryFiles.filter(file => {
      const matchesFolder = fileSelectorFolder === null
        ? !file.folder_id
        : file.folder_id === fileSelectorFolder;
      
      // Filter by search query
      const matchesSearch = !fileSelectorSearch || 
        file.file_name?.toLowerCase().includes(fileSelectorSearch.toLowerCase()) ||
        file.description?.toLowerCase().includes(fileSelectorSearch.toLowerCase());
      
      // Filter by type if needed
      if (showFileSelector === 'image') {
        return matchesFolder && matchesSearch && file.file_type === 'image';
      }
      return matchesFolder && matchesSearch;
    });
  }, [repositoryFiles, fileSelectorFolder, showFileSelector, fileSelectorSearch]);

  // Reset file selector page when folder or search changes
  useEffect(() => {
    setFileSelectorPage(1);
  }, [fileSelectorFolder, fileSelectorSearch, showFileSelector]);

  // File selector pagination calculations
  const fileSelectorTotalPages = Math.ceil(filteredRepositoryFiles.length / fileSelectorItemsPerPage);
  const fileSelectorStartIndex = (fileSelectorPage - 1) * fileSelectorItemsPerPage;
  const fileSelectorEndIndex = fileSelectorStartIndex + fileSelectorItemsPerPage;
  const paginatedRepositoryFiles = filteredRepositoryFiles.slice(fileSelectorStartIndex, fileSelectorEndIndex);

  // Generate page numbers for file selector pagination
  const getFileSelectorPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (fileSelectorTotalPages <= maxVisible) {
      for (let i = 1; i <= fileSelectorTotalPages; i++) {
        pages.push(i);
      }
    } else {
      if (fileSelectorPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        if (fileSelectorTotalPages > 5) pages.push('...');
        pages.push(fileSelectorTotalPages);
      } else if (fileSelectorPage >= fileSelectorTotalPages - 2) {
        pages.push(1);
        if (fileSelectorTotalPages > 5) pages.push('...');
        for (let i = fileSelectorTotalPages - 3; i <= fileSelectorTotalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = fileSelectorPage - 1; i <= fileSelectorPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(fileSelectorTotalPages);
      }
    }
    
    return pages;
  };

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterCategory, selectedFolder, itemsPerPage]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredResources.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedResources = filteredResources.slice(startIndex, endIndex);

  // Generate page numbers for pagination
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        if (totalPages > 5) pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        if (totalPages > 5) pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push(totalPages);
      }
    }
    
    return pages;
  };

  // Get resource count for each folder
  const getFolderResourceCount = (folderId) => {
    return resources.filter(r => r.folder_id === folderId).length;
  };

  // Get file count for file selector folders
  const getFileSelectorFolderFileCount = (folderId) => {
    // Only count files of the correct type if a filter is active
    const relevantFiles = repositoryFiles.filter(f => 
      showFileSelector === 'image' ? f.file_type === 'image' : true
    );
    return relevantFiles.filter(f => f.folder_id === folderId).length;
  };

  // Folder mutations
  const createFolderMutation = useMutation({
    mutationFn: (data) => base44.entities.ResourceFolder.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-folders'] });
      setShowFolderDialog(false);
      setEditingFolder(null);
      toast.success('Folder created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create folder: ' + error.message);
    }
  });

  const updateFolderMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.ResourceFolder.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-folders'] });
      setShowFolderDialog(false);
      setEditingFolder(null);
      toast.success('Folder updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update folder: ' + error.message);
    }
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId) => {
      // Get all subfolder IDs including the current one
      const allFolderIds = getAllSubfolderIds(folderId);

      // Move resources out of all these folders
      const resourcesInFolders = resources.filter(r => allFolderIds.includes(r.folder_id));
      for (const resource of resourcesInFolders) {
        await base44.entities.Resource.update(resource.id, { folder_id: null });
      }

      // Delete all subfolders first (bottom-up), then the main folder
      // Sort in reverse order of depth to ensure child folders are deleted before parents
      const foldersToDelete = folders.filter(f => allFolderIds.includes(f.id))
                                     .sort((a, b) => getBreadcrumb(b.id).length - getBreadcrumb(a.id).length);

      for (const folder of foldersToDelete) {
        await base44.entities.ResourceFolder.delete(folder.id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-folders'] });
      queryClient.invalidateQueries({ queryKey: ['admin-resources'] }); // Invalidate resources too, as their folder_id might change
      setSelectedFolder(null); // Reset to root view
      toast.success('Folder and its subfolders deleted, resources moved to root');
    },
    onError: (error) => {
      toast.error('Failed to delete folder: ' + error.message);
    }
  });

  const moveFolderMutation = useMutation({
    mutationFn: async ({ folderId, newParentId }) => {
      // Check for circular reference: cannot move a folder into itself or its subfolders
      if (newParentId) {
        const wouldCreateCircle = getAllSubfolderIds(folderId).includes(newParentId);
        if (wouldCreateCircle) {
          throw new Error('Cannot move a folder into its own subfolder');
        }
      }
      await base44.entities.ResourceFolder.update(folderId, { parent_folder_id: newParentId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-folders'] });
      setShowMoveFolderDialog(false);
      setFolderToMove(null);
      toast.success('Folder moved successfully');
    },
    onError: (error) => {
      toast.error('Failed to move folder: ' + error.message);
    }
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Resource.create(data),
    onSuccess: async () => {
      // Remove all cached queries first to force fresh fetch
      queryClient.removeQueries({ queryKey: ['admin-resources'] });
      queryClient.removeQueries({ queryKey: ['public-resources'] });
      queryClient.removeQueries({ queryKey: ['resources'] });
      // Force immediate refetch
      await queryClient.refetchQueries({ queryKey: ['admin-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['public-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['resources'], type: 'active' });
      console.log('[ResourceManagement] Cache cleared and refetched after create');
      setShowDialog(false);
      setEditingResource(null);
      toast.success('Resource created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create resource: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Resource.update(id, data),
    onSuccess: async () => {
      // Remove all cached queries first to force fresh fetch
      queryClient.removeQueries({ queryKey: ['admin-resources'] });
      queryClient.removeQueries({ queryKey: ['public-resources'] });
      queryClient.removeQueries({ queryKey: ['resources'] });
      // Force immediate refetch
      await queryClient.refetchQueries({ queryKey: ['admin-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['public-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['resources'], type: 'active' });
      console.log('[ResourceManagement] Cache cleared and refetched after update');
      setShowDialog(false);
      setEditingResource(null);
      toast.success('Resource updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update resource: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Resource.delete(id),
    onSuccess: async () => {
      // Remove all cached queries first to force fresh fetch
      queryClient.removeQueries({ queryKey: ['admin-resources'] });
      queryClient.removeQueries({ queryKey: ['public-resources'] });
      queryClient.removeQueries({ queryKey: ['resources'] });
      // Force immediate refetch
      await queryClient.refetchQueries({ queryKey: ['admin-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['public-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['resources'], type: 'active' });
      console.log('[ResourceManagement] Cache cleared and refetched after delete');
      toast.success('Resource deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete resource: ' + error.message);
    }
  });

  // Move resources mutation
  const moveResourcesMutation = useMutation({
    mutationFn: async ({ resourceIds, folderId }) => {
      for (const resourceId of resourceIds) {
        await base44.entities.Resource.update(resourceId, { folder_id: folderId });
      }
    },
    onSuccess: async () => {
      // Remove all cached queries first to force fresh fetch
      queryClient.removeQueries({ queryKey: ['admin-resources'] });
      queryClient.removeQueries({ queryKey: ['public-resources'] });
      queryClient.removeQueries({ queryKey: ['resources'] });
      // Force immediate refetch
      await queryClient.refetchQueries({ queryKey: ['admin-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['public-resources'], type: 'active' });
      await queryClient.refetchQueries({ queryKey: ['resources'], type: 'active' });
      console.log('[ResourceManagement] Cache cleared and refetched after move');
      setShowMoveDialog(false);
      setSelectedResources([]); // Clear selection after move
      setBulkMoveMode(false); // Exit bulk move mode
      toast.success('Resources moved successfully');
    },
    onError: (error) => {
      toast.error('Failed to move resources: ' + error.message);
    }
  });

  // Drag and Drop Handlers
  const handleDragStart = (e, resource) => {
    // If in bulk mode and resource is selected, drag all selected
    if (bulkMoveMode && selectedResources.includes(resource.id)) {
      setDraggedResources(selectedResources);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify(selectedResources));

      // Create custom drag image showing count
      const dragImage = document.createElement('div');
      dragImage.className = 'bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg font-medium';
      dragImage.textContent = `Moving ${selectedResources.length} resource${selectedResources.length > 1 ? 's' : ''}`;
      dragImage.style.position = 'absolute';
      dragImage.style.top = '-1000px';
      document.body.appendChild(dragImage);
      setTimeout(() => document.body.removeChild(dragImage), 0);
    } else {
      // Drag single resource
      setDraggedResources([resource.id]);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify([resource.id]));
    }
  };

  const handleDragEnd = () => {
    setDraggedResources([]);
    setDragOverFolder(null);
    if (autoExpandTimeout) {
      clearTimeout(autoExpandTimeout);
      setAutoExpandTimeout(null);
    }
  };

  const handleDragOver = (e, folderId) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (dragOverFolder !== folderId) {
      setDragOverFolder(folderId);

      // Auto-expand folder after hovering for 800ms
      if (autoExpandTimeout) {
        clearTimeout(autoExpandTimeout);
      }

      if (folderId && !expandedFolders[folderId]) {
        const timeout = setTimeout(() => {
          setExpandedFolders(prev => ({ ...prev, [folderId]: true }));
        }, 800);
        setAutoExpandTimeout(timeout);
      }
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    // Only clear if we're leaving the folder tree area entirely
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;

    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setDragOverFolder(null);
      if (autoExpandTimeout) {
        clearTimeout(autoExpandTimeout);
        setAutoExpandTimeout(null);
      }
    }
  };

  const handleDrop = async (e, folderId) => {
    e.preventDefault();
    e.stopPropagation();

    if (autoExpandTimeout) {
      clearTimeout(autoExpandTimeout);
      setAutoExpandTimeout(null);
    }

    setDragOverFolder(null);

    try {
      const resourceIds = JSON.parse(e.dataTransfer.getData('text/plain'));

      if (resourceIds && resourceIds.length > 0) {
        await moveResourcesMutation.mutateAsync({
          resourceIds,
          folderId: folderId === 'root' ? null : folderId
        });
      }
    } catch (error) {
      console.error('Drop error:', error);
    }

    setDraggedResources([]);
  };

  // Add select all handler
  const handleSelectAll = () => {
    if (selectedResources.length === filteredResources.length) {
      setSelectedResources([]);
    } else {
      setSelectedResources(filteredResources.map(r => r.id));
    }
  };

  // Folder handlers
  const handleCreateFolder = () => {
    setEditingFolder({
      name: "",
      description: "",
      parent_folder_id: selectedFolder, // New folders are created within the current selected folder
      display_order: folders.filter(f => f.parent_folder_id === selectedFolder).length // default to end
    });
    setShowFolderDialog(true);
  };

  const handleEditFolder = (folder) => {
    setEditingFolder(folder);
    setShowFolderDialog(true);
  };

  const handleSaveFolder = () => {
    if (!editingFolder.name.trim()) {
      toast.error('Folder name is required');
      return;
    }

    const payload = {
      name: editingFolder.name,
      description: editingFolder.description || "",
      parent_folder_id: editingFolder.parent_folder_id || null, // Ensure null for root-level folders
      display_order: editingFolder.display_order || 0
    };

    if (editingFolder.id) {
      updateFolderMutation.mutate({ id: editingFolder.id, data: payload });
    } else {
      createFolderMutation.mutate(payload);
    }
  };

  const handleDeleteFolder = (folderId) => {
    const folder = folders.find(f => f.id === folderId);
    const subfolders = folders.filter(f => f.parent_folder_id === folderId);
    const hasSubfolders = subfolders.length > 0;

    const message = hasSubfolders
      ? 'This folder contains subfolders. All subfolders and their resources will be moved to root. Continue?'
      : 'Are you sure you want to delete this folder? Resources will be moved to root.';

    if (confirm(message)) {
      deleteFolderMutation.mutate(folderId);
    }
  };

  const handleMoveFolder = (folder) => {
    setFolderToMove(folder);
    setShowMoveFolderDialog(true);
  };

  const handleMoveFolderToDestination = (newParentId) => {
    if (folderToMove) {
      moveFolderMutation.mutate({
        folderId: folderToMove.id,
        newParentId: newParentId === 'root' ? null : newParentId
      });
    }
  };

  const handleToggleFolder = (folderId) => {
    setExpandedFolders(prev => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  const handleToggleResourceSelection = (resourceId) => {
    setSelectedResources(prev =>
      prev.includes(resourceId)
        ? prev.filter(id => id !== resourceId)
        : [...prev, resourceId]
    );
  };

  const handleBulkMove = () => {
    if (selectedResources.length === 0) {
      toast.error('Please select resources to move');
      return;
    }
    setShowMoveDialog(true);
  };

  const handleMoveResources = (folderId) => {
    moveResourcesMutation.mutate({
      resourceIds: selectedResources,
      folderId: folderId === 'root' ? null : folderId // 'root' maps to null folder_id
    });
  };

  const handleMoveResourceToFolder = (resourceId, folderId) => {
    moveResourcesMutation.mutate({
      resourceIds: [resourceId],
      folderId: folderId === 'root' ? null : folderId
    });
  };

  const handleCreateNew = () => {
    setEditingResource({
      title: "",
      description: "",
      subcategories: [],
      resource_type: "external_link",
      target_url: "",
      open_in_new_tab: true,
      image_url: "",
      release_date: new Date().toISOString(), // Changed from published_date
      is_public: true,
      allowed_role_ids: [],
      tags: [],
      author_id: "",
      author_name: "",
      folder_id: selectedFolder, // Pre-fill folder_id based on current view
      status: "active" // Default to active
    });
    setImageFromRepository(false);
    setTargetFromRepository(false);
    setTargetFileName(""); // Reset target file name
    setShowDialog(true);
  };

  const handleEdit = (resource) => {
    setEditingResource({
      ...resource,
      subcategories: resource.subcategories || [],
      allowed_role_ids: resource.allowed_role_ids || [],
      open_in_new_tab: resource.open_in_new_tab !== false,
      author_id: resource.author_id || "",
      author_name: resource.author_name || "",
      status: resource.status || "active", // Default to active if not set
      release_date: resource.release_date || resource.published_date || new Date().toISOString() // Ensure release_date is present, falling back to published_date
    });
    // Check if the image URL is from repository
    const isImageFromRepo = resource.image_url ? repositoryFiles.some(f => f.file_url === resource.image_url) : false;
    setImageFromRepository(isImageFromRepo);

    // Check if the target URL is from repository (only for downloads)
    if (resource.resource_type === 'download' && resource.target_url) {
      const repoFile = repositoryFiles.find(f => f.file_url === resource.target_url);
      if (repoFile) {
        setTargetFromRepository(true);
        setTargetFileName(repoFile.file_name); // Set target file name
      } else {
        setTargetFromRepository(false);
        setTargetFileName("");
      }
    } else {
      setTargetFromRepository(false);
      setTargetFileName("");
    }

    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingResource.title.trim()) {
      toast.error('Title is required');
      return;
    }
    if (!editingResource.target_url.trim()) {
      toast.error(editingResource.resource_type === 'video' ? 'Embed code is required' : 'Target URL is required');
      return;
    }
    if (!editingResource.subcategories || editingResource.subcategories.length === 0) {
      toast.error('Please select at least one subcategory');
      return;
    }
    
    // Check description length against limit
    const descLimit = authorSettings?.description_character_limit || 500;
    if (editingResource.description && editingResource.description.length > descLimit) {
      toast.error(`Description must be ${descLimit} characters or less (currently ${editingResource.description.length})`);
      return;
    }

    const payload = {
      title: editingResource.title,
      description: editingResource.description,
      subcategories: editingResource.subcategories || [],
      resource_type: editingResource.resource_type,
      target_url: editingResource.target_url,
      open_in_new_tab: editingResource.open_in_new_tab,
      image_url: editingResource.image_url,
      release_date: editingResource.release_date, // Changed from published_date
      is_public: editingResource.is_public,
      allowed_role_ids: editingResource.allowed_role_ids || [],
      tags: editingResource.tags || [],
      author_id: editingResource.author_id || "",
      author_name: editingResource.author_name || "",
      folder_id: editingResource.folder_id || null, // Include folder_id in save payload
      status: editingResource.status || "active" // Include status in payload
    };

    if (editingResource.id) {
      updateMutation.mutate({ id: editingResource.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleSelectFile = (fileUrl, type, fileName = '') => { // Added fileName parameter
    if (type === 'image') {
      setEditingResource({ ...editingResource, image_url: fileUrl });
      setImageFromRepository(true);
    } else if (type === 'target') {
      setEditingResource({ ...editingResource, target_url: fileUrl });
      setTargetFromRepository(true);
      setTargetFileName(fileName); // Set targetFileName
    }
    setShowFileSelector(null);
    setFileSelectorFolder(null); // Reset file selector folder
    setFileSelectorExpandedFolders({}); // Reset file selector expanded folders
  };

  const handleClearImage = () => {
    setEditingResource({ ...editingResource, image_url: "" });
    setImageFromRepository(false);
  };

  const handleClearTarget = () => {
    setEditingResource({ ...editingResource, target_url: "" });
    setTargetFromRepository(false);
    setTargetFileName(""); // Clear target file name
  };

  const handleImageUrlChange = (e) => {
    setEditingResource({ ...editingResource, image_url: e.target.value });
    setImageFromRepository(false);
  };

  const handleTargetUrlChange = (e) => {
    setEditingResource({ ...editingResource, target_url: e.target.value });
    setTargetFromRepository(false);
    setTargetFileName(""); // Clear target file name
  };

  const handleAddTag = () => {
    if (!newTag.trim()) return;
    if (editingResource.tags.includes(newTag.trim())) {
      toast.error('Tag already exists');
      return;
    }
    setEditingResource({
      ...editingResource,
      tags: [...editingResource.tags, newTag.trim()]
    });
    setNewTag("");
    setShowTagSuggestions(false);
  };

  const handleSelectTag = (tag) => {
    if (editingResource.tags.includes(tag)) {
      toast.error('Tag already exists');
      return;
    }
    setEditingResource({
      ...editingResource,
      tags: [...editingResource.tags, tag]
    });
    setNewTag("");
    setShowTagSuggestions(false);
  };

  const handleRemoveTag = (tag) => {
    setEditingResource({
      ...editingResource,
      tags: editingResource.tags.filter(t => t !== tag)
    });
  };

  const handleToggleRole = (roleId) => {
    const currentRoles = editingResource.allowed_role_ids || [];
    const newRoles = currentRoles.includes(roleId)
      ? currentRoles.filter(id => id !== roleId)
      : [...currentRoles, roleId];

    setEditingResource({
      ...editingResource,
      allowed_role_ids: newRoles
    });
  };

  const handleToggleSubcategory = (subcategory) => {
    const current = editingResource.subcategories || [];
    const updated = current.includes(subcategory)
      ? current.filter(s => s !== subcategory)
      : [...current, subcategory];

    setEditingResource({
      ...editingResource,
      subcategories: updated
    });
  };

  const handleSelectAuthor = (authorId) => {
    const author = availableAuthors.find(a => a.id === authorId);
    if (author) {
      setEditingResource({
        ...editingResource,
        author_id: author.id,
        author_name: author.name
      });
    } else {
      // Clear author
      setEditingResource({
        ...editingResource,
        author_id: "",
        author_name: ""
      });
    }
  };

  // Recursive folder tree renderer
  const renderFolderTree = (folderList, depth = 0) => {
    return folderList.map(folder => {
      const isExpanded = expandedFolders[folder.id];
      const hasChildren = folder.children && folder.children.length > 0;
      const isSelected = selectedFolder === folder.id;
      const isDragOver = dragOverFolder === folder.id;

      return (
        <div key={folder.id}>
          <div
            className="relative group"
            onDragOver={(e) => handleDragOver(e, folder.id)}
            onDrop={(e) => handleDrop(e, folder.id)}
          >
            <div
              className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                isSelected ? 'bg-blue-100' : 'hover:bg-slate-100'
              } ${
                isDragOver ? 'bg-blue-200 ring-2 ring-blue-400' : ''
              }`}
              style={{ paddingLeft: `${depth * 20 + 12}px` }}
            >
              {hasChildren ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFolder(folder.id);
                  }}
                  className="p-0.5 hover:bg-slate-200 rounded"
                >
                  <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                </button>
              ) : (
                <div className="w-5 h-5 flex-shrink-0" /> // Placeholder for alignment
              )}

              <Folder className="w-4 h-4 text-slate-600 shrink-0" />

              <span
                onClick={() => setSelectedFolder(folder.id)}
                className="flex-1 text-sm"
              >
                {folder.name}
              </span>

              <span className="text-xs text-slate-500">
                ({getFolderResourceCount(folder.id)})
              </span>

              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditFolder(folder);
                  }}
                  className="p-1 hover:bg-slate-200 rounded"
                  title="Edit folder"
                >
                  <Pencil className="w-3 h-3 text-slate-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleMoveFolder(folder);
                  }}
                  className="p-1 hover:bg-blue-100 rounded"
                  title="Move folder"
                >
                  <MoveHorizontal className="w-3 h-3 text-blue-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteFolder(folder.id);
                  }}
                  className="p-1 hover:bg-red-100 rounded"
                  title="Delete folder"
                >
                  <Trash2 className="w-3 h-3 text-red-600" />
                </button>
              </div>
            </div>
          </div>

          {hasChildren && isExpanded && (
            <div>
              {renderFolderTree(folder.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  // Recursive folder selector for move dialogs
  const renderFolderSelector = (folderList, excludeId = null, depth = 0) => {
    return folderList.map(folder => {
      // Exclude the folder being moved and its subfolders from being a destination
      const allExcludedIds = excludeId ? getAllSubfolderIds(excludeId) : [];
      if (allExcludedIds.includes(folder.id)) return null;

      return (
        <div key={folder.id}>
          <Button
            variant="outline"
            className="w-full justify-start mb-1"
            onClick={() => {
              if (showMoveFolderDialog) {
                handleMoveFolderToDestination(folder.id);
              } else {
                handleMoveResources(folder.id);
              }
            }}
            style={{ paddingLeft: `${depth * 20 + 16}px` }}
          >
            <Folder className="w-4 h-4 mr-2" />
            {folder.name}
          </Button>
          {folder.children && folder.children.length > 0 && (
            <div className="ml-4"> {/* Indent subfolders */}
              {renderFolderSelector(folder.children, excludeId, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  const handleToggleFileSelectorFolder = (folderId) => {
    setFileSelectorExpandedFolders(prev => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  // Render file selector folder tree
  const renderFileSelectorFolderTree = (folderList, depth = 0) => {
    return folderList.map(folder => {
      const isExpanded = fileSelectorExpandedFolders[folder.id];
      const hasChildren = folder.children && folder.children.length > 0;
      const isSelected = fileSelectorFolder === folder.id;

      return (
        <div key={folder.id}>
          <div
            className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
              isSelected ? 'bg-blue-100' : 'hover:bg-slate-100'
            }`}
            style={{ paddingLeft: `${depth * 20 + 12}px` }}
          >
            {hasChildren ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleFileSelectorFolder(folder.id);
                }}
                className="p-0.5 hover:bg-slate-200 rounded"
              >
                <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              </button>
            ) : (
              <div className="w-5 h-5 flex-shrink-0" />
            )}

            <Folder className="w-4 h-4 text-slate-600 shrink-0" />

            <span
              onClick={() => setFileSelectorFolder(folder.id)}
              className="flex-1 text-sm"
            >
              {folder.name}
            </span>

            <span className="text-xs text-slate-500">
              ({getFileSelectorFolderFileCount(folder.id)})
            </span>
          </div>

          {hasChildren && isExpanded && (
            <div>
              {renderFileSelectorFolderTree(folder.children, depth + 1)}
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
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Manage Resources
            </h1>
            <p className="text-slate-600">
              Create and manage resource library content • Drag resources to folders
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleCreateFolder} variant="outline" className="border-blue-600 text-blue-600 hover:bg-blue-50">
              <FolderPlus className="w-4 h-4 mr-2" />
              {selectedFolder ? 'New Subfolder' : 'New Folder'}
            </Button>
            <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Add Resource
            </Button>
          </div>
        </div>

        {/* Bulk Move Mode Banner */}
        {authorSettings?.show_folders !== false && bulkMoveMode && (
          <Card className="border-blue-500 bg-blue-50 shadow-md mb-6">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-blue-600 text-white rounded-full p-2">
                    <MoveHorizontal className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-blue-900">Bulk Move Mode Active</h3>
                    <p className="text-sm text-blue-700">
                      {selectedResources.length === 0
                        ? "Select resources below or drag them to folders"
                        : `${selectedResources.length} resource${selectedResources.length > 1 ? 's' : ''} selected • Drag to move`}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {filteredResources.length > 0 && (
                    <Button
                      onClick={handleSelectAll}
                      size="sm"
                      variant="outline"
                      className="bg-white"
                    >
                      {selectedResources.length === filteredResources.length ? 'Deselect All' : 'Select All'}
                    </Button>
                  )}
                  {selectedResources.length > 0 && (
                    <Button
                      onClick={handleBulkMove}
                      size="sm"
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      <MoveHorizontal className="w-4 h-4 mr-2" />
                      Move {selectedResources.length} Selected
                    </Button>
                  )}
                  <Button
                    onClick={() => {
                      setBulkMoveMode(false);
                      setSelectedResources([]);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Folder Navigation */}
        {authorSettings?.show_folders !== false && (
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Folder className="w-5 h-5 text-slate-600" />
                <h3 className="font-semibold text-slate-900">Folders</h3>
                <Badge variant="outline" className="ml-2 text-xs">
                  Drag & Drop Enabled
                </Badge>
              </div>
              {!bulkMoveMode && (
                <Button
                  onClick={() => setBulkMoveMode(true)}
                  size="sm"
                  variant="outline"
                >
                  <MoveHorizontal className="w-4 h-4 mr-2" />
                  Bulk Move Mode
                </Button>
              )}
            </div>

            {/* Breadcrumb */}
            {(breadcrumb.length > 0 || selectedFolder === null) && ( // Show breadcrumb even if only root is selected
              <div className="flex items-center gap-2 mb-4 p-2 bg-slate-50 rounded-lg">
                <button
                  onClick={() => setSelectedFolder(null)}
                  className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
                >
                  <Home className="w-4 h-4" />
                  Root
                </button>
                {breadcrumb.map((folder, idx) => (
                  <React.Fragment key={folder.id}>
                    <ChevronRight className="w-4 h-4 text-slate-400" />
                    <button
                      onClick={() => setSelectedFolder(folder.id)}
                      className={`text-sm ${
                        idx === breadcrumb.length - 1
                          ? 'text-blue-600 font-medium'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {folder.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}

            {/* Folder Tree */}
            <div
              className="border border-slate-200 rounded-lg p-2 max-h-96 overflow-y-auto"
              onDragLeave={handleDragLeave}
            >
              <div
                className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                  selectedFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'
                } ${
                  dragOverFolder === 'root' ? 'bg-blue-200 ring-2 ring-blue-400' : ''
                }`}
                onClick={() => setSelectedFolder(null)}
                onDragOver={(e) => handleDragOver(e, 'root')}
                onDrop={(e) => handleDrop(e, 'root')}
              >
                <FolderOpen className="w-4 h-4 text-slate-600" />
                <span className="flex-1 text-sm font-medium">Root</span>
                <span className="text-xs text-slate-500">
                  ({resources.filter(r => !r.folder_id).length})
                </span>
              </div>
              {renderFolderTree(folderHierarchy)}
            </div>
          </CardContent>
        </Card>
        )}

        {/* Filters */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search resources..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={filterCategory} onValueChange={setFilterCategory}>
                <SelectTrigger className="w-full md:w-48">
                  <SelectValue placeholder="Filter by category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem key="all" value="all">All Categories</SelectItem>
                  {categories.map(cat => (
                    <SelectItem key={cat.id} value={cat.name}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Resources List */}
        {isLoading ? (
          <div className="text-center py-12">Loading resources...</div>
        ) : filteredResources.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Resources Found
              </h3>
              <p className="text-slate-600 mb-6">
                {searchQuery || filterCategory !== "all" || selectedFolder
                  ? "Try adjusting your filters"
                  : "Create your first resource to get started"}
              </p>
              {!searchQuery && filterCategory === "all" && (
                <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-2" />
                  Add First Resource
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
              {paginatedResources.map((resource) => {
                const roleCount = resource.allowed_role_ids?.length || 0;
                const accessText = resource.is_public
                  ? "Public"
                  : roleCount === 0
                    ? "All Members"
                    : `${roleCount} Role${roleCount > 1 ? 's' : ''}`;
                const isSelected = selectedResources.includes(resource.id);
                const isDragging = draggedResources.includes(resource.id);
                const releaseDate = resource.release_date || resource.published_date;
                const isFutureRelease = releaseDate && new Date(releaseDate) > new Date();

                return (
                  <Card
                    key={resource.id}
                    draggable={true}
                    onDragStart={(e) => handleDragStart(e, resource)}
                    onDragEnd={handleDragEnd}
                    className={`border-slate-200 shadow-sm hover:shadow-md transition-all relative ${
                      bulkMoveMode ? 'cursor-pointer' : 'cursor-grab'
                    } ${
                      isSelected ? 'ring-4 ring-blue-500 bg-blue-50' : ''
                    } ${
                      isDragging ? 'opacity-50' : ''
                    }`}
                    onClick={() => {
                      if (bulkMoveMode) {
                        handleToggleResourceSelection(resource.id);
                      }
                    }}
                  >
                    {/* Drag Handle */}
                    <div className="absolute top-2 right-2 z-10 p-1 bg-slate-100 rounded hover:bg-slate-200 cursor-grab">
                      <GripVertical className="w-4 h-4 text-slate-400" />
                    </div>

                    {bulkMoveMode && (
                      <div className="absolute top-3 left-3 z-10">
                        <div className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-all ${
                          isSelected
                            ? 'bg-blue-600 border-blue-600'
                            : 'bg-white border-slate-300'
                        }`}>
                          {isSelected && (
                            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      </div>
                    )}
                    {resource.image_url && (
                      <div className="h-40 overflow-hidden bg-slate-100">
                        <img
                          src={resource.image_url}
                          alt={resource.title}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        {resource.subcategories && resource.subcategories.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {resource.subcategories.slice(0, 2).map((sub, idx) => (
                              <Badge key={idx} className="bg-blue-100 text-blue-700 text-xs">
                                {sub}
                              </Badge>
                            ))}
                            {resource.subcategories.length > 2 && (
                              <Badge variant="outline" className="text-xs">
                                +{resource.subcategories.length - 2}
                              </Badge>
                            )}
                          </div>
                        )}
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge variant="outline">
                            <Shield className="w-3 h-3 mr-1" />
                            {accessText}
                          </Badge>
                          {resource.status === 'draft' && (
                            <Badge className="bg-amber-100 text-amber-700">
                              Draft
                            </Badge>
                          )}
                          {isFutureRelease && (
                            <Badge className="bg-purple-100 text-purple-700">
                              <Clock className="w-3 h-3 mr-1" />
                              Scheduled
                            </Badge>
                          )}
                        </div>
                      </div>
                      <CardTitle className="text-lg line-clamp-2">{resource.title}</CardTitle>
                      {resource.description && (
                        <p className="text-sm text-slate-600 mt-2">
                          {resource.description}
                        </p>
                      )}
                      {isFutureRelease && (
                        <p className="text-xs text-purple-600 mt-2 flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          Releases: {format(new Date(releaseDate), 'MMM d, yyyy h:mm a')}
                        </p>
                      )}
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEdit(resource);
                          }}
                          className="flex-1"
                        >
                          <Pencil className="w-3 h-3 mr-1" />
                          Edit
                        </Button>
                        {!bulkMoveMode && (
                          <Select
                            value={resource.folder_id || 'root'}
                            onValueChange={(value) => {
                              handleMoveResourceToFolder(resource.id, value);
                            }}
                          >
                            <SelectTrigger className="w-28" onClick={(e) => e.stopPropagation()}>
                              <MoveHorizontal className="w-3 h-3 mr-1" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="root">Root</SelectItem>
                              {folders.map(folder => (
                                <SelectItem key={folder.id} value={folder.id}>
                                  {folder.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteMutation.mutate(resource.id);
                          }}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <Card className="border-slate-200 shadow-sm">
                <CardContent className="p-6">
                  <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                    {/* Items per page selector */}
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-slate-600">Items per page:</span>
                      <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                        setItemsPerPage(Number(val));
                        setCurrentPage(1);
                      }}>
                        <SelectTrigger className="w-20">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="9">9</SelectItem>
                          <SelectItem value="18">18</SelectItem>
                          <SelectItem value="36">36</SelectItem>
                          <SelectItem value="72">72</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Page info */}
                    <div className="text-sm text-slate-600">
                      Showing {startIndex + 1}-{Math.min(endIndex, filteredResources.length)} of {filteredResources.length} resources
                    </div>

                    {/* Page navigation */}
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                        disabled={currentPage === 1}
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>

                      {getPageNumbers().map((page, idx) => (
                        <React.Fragment key={idx}>
                          {page === '...' ? (
                            <span className="px-2 text-slate-400">...</span>
                          ) : (
                            <Button
                              variant={currentPage === page ? "default" : "outline"}
                              size="sm"
                              onClick={() => setCurrentPage(page)}
                              className={currentPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                            >
                              {page}
                            </Button>
                          )}
                        </React.Fragment>
                      ))}

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                        disabled={currentPage === totalPages}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Folder Dialog */}
        <Dialog open={showFolderDialog} onOpenChange={(open) => {
          setShowFolderDialog(open);
          if (!open) setEditingFolder(null);
        }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editingFolder?.id ? 'Edit Folder' : (selectedFolder ? 'Create New Subfolder' : 'Create New Folder')}
              </DialogTitle>
            </DialogHeader>

            {editingFolder && (
              <div className="space-y-4">
                {editingFolder.parent_folder_id && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-900">
                      <span className="font-medium">Parent Folder: </span>
                      {folders.find(f => f.id === editingFolder.parent_folder_id)?.name || 'Root'}
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="folder-name">Folder Name *</Label>
                  <Input
                    id="folder-name"
                    value={editingFolder.name}
                    onChange={(e) => setEditingFolder({ ...editingFolder, name: e.target.value })}
                    placeholder="e.g., Training Materials"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="folder-description">Description (Optional)</Label>
                  <Textarea
                    id="folder-description"
                    value={editingFolder.description || ''}
                    onChange={(e) => setEditingFolder({ ...editingFolder, description: e.target.value })}
                    placeholder="Brief description of this folder..."
                    rows={3}
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowFolderDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveFolder}
                disabled={createFolderMutation.isPending || updateFolderMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingFolder?.id ? 'Update Folder' : 'Create Folder'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Move Resources Dialog */}
        <Dialog open={showMoveDialog} onOpenChange={(open) => {
          setShowMoveDialog(open);
          if (!open) {
            // Optionally reset selected resources if dialog is closed without moving
            // But we already clear on successful move, so this is just for explicit close
            // setSelectedResources([]);
            // setBulkMoveMode(false);
          }
        }}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Move Resources to Folder</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <p className="text-sm text-slate-600">
                Select a folder to move {selectedResources.length} selected resource{selectedResources.length > 1 ? 's' : ''} to:
              </p>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handleMoveResources('root')}
                >
                  <FolderOpen className="w-4 h-4 mr-2" />
                  Root (No Folder)
                </Button>

                {renderFolderSelector(folderHierarchy)}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowMoveDialog(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Move Folder Dialog */}
        <Dialog open={showMoveFolderDialog} onOpenChange={(open) => {
          setShowMoveFolderDialog(open);
          if (!open) {
            setFolderToMove(null);
          }
        }}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Move Folder</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <p className="text-sm text-slate-600">
                Select a destination for <strong>{folderToMove?.name}</strong>:
              </p>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handleMoveFolderToDestination('root')}
                >
                  <FolderOpen className="w-4 h-4 mr-2" />
                  Root (Top Level)
                </Button>

                {renderFolderSelector(folderHierarchy, folderToMove?.id)}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setShowMoveFolderDialog(false);
                setFolderToMove(null);
              }}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={(open) => {
          setShowDialog(open);
          if (!open) {
            setSubcategorySearch("");
            setImageFromRepository(false);
            setTargetFromRepository(false);
            setTargetFileName("");
            setShowTagSuggestions(false);
          }
        }}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingResource?.id ? 'Edit Resource' : 'Create New Resource'}
              </DialogTitle>
            </DialogHeader>

            {editingResource && (
              <div className="space-y-6">
                {/* Show current folder */}
                {editingResource.folder_id && (
                  <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
                    <Folder className="w-4 h-4 text-blue-600" />
                    <span className="text-sm text-blue-900">
                      Folder: {folders.find(f => f.id === editingResource.folder_id)?.name || 'Unknown Folder'}
                    </span>
                  </div>
                )}
                {!editingResource.folder_id && selectedFolder && ( // If in a folder view, but new resource is explicitly moved to root, or in root view
                    <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
                      <FolderOpen className="w-4 h-4 text-blue-600" />
                      <span className="text-sm text-blue-900">
                        Folder: Root
                      </span>
                    </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    value={editingResource.title}
                    onChange={(e) => setEditingResource({ ...editingResource, title: e.target.value })}
                    placeholder="Resource title"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={editingResource.description || ''}
                    onChange={(e) => setEditingResource({ ...editingResource, description: e.target.value })}
                    placeholder="Brief description..."
                    rows={3}
                    maxLength={authorSettings?.description_character_limit || 500}
                  />
                  <p className="text-xs text-slate-500">
                    {editingResource.description?.length || 0} / {authorSettings?.description_character_limit || 500} characters
                  </p>
                </div>

                {/* Add Status Toggle */}
                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Switch
                    id="status-toggle"
                    checked={editingResource.status === 'active'}
                    onCheckedChange={(checked) => setEditingResource({ ...editingResource, status: checked ? 'active' : 'draft' })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="status-toggle" className="cursor-pointer font-medium">
                      {editingResource.status === 'active' ? 'Active' : 'Draft'}
                    </Label>
                    <p className="text-xs text-slate-500 mt-1">
                      {editingResource.status === 'active' 
                        ? 'This resource is visible to users' 
                        : 'This resource is hidden from users (draft mode)'}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="resource-type">Resource Type *</Label>
                  <Select
                    value={editingResource.resource_type}
                    onValueChange={(value) => {
                      setEditingResource({ ...editingResource, resource_type: value });
                      // Reset target repository flag and file name when changing type
                      if (value !== 'download') {
                        setTargetFromRepository(false);
                        setTargetFileName("");
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="download">Download</SelectItem>
                      <SelectItem value="video">Video</SelectItem>
                      <SelectItem value="external_link">External Link</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Subcategories multi-selection */}
                {categories.some(cat => cat.subcategories && cat.subcategories.length > 0) && (
                  <div className="space-y-2">
                    <Label>Categories & Subcategories *</Label>
                    <p className="text-xs text-slate-500 mb-3">
                      Select any categories and subcategories that apply to this resource
                    </p>

                    {/* Search field */}
                    <div className="relative mb-3">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        placeholder="Search categories and subcategories..."
                        value={subcategorySearch}
                        onChange={(e) => setSubcategorySearch(e.target.value)}
                        className="pl-10 pr-10"
                      />
                      {subcategorySearch && (
                        <button
                          onClick={() => setSubcategorySearch("")}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-lg p-3 space-y-3">
                      {filteredCategoriesForSelection.length === 0 ? (
                        <div className="text-center py-8 text-slate-500">
                          <p className="text-sm">No matching categories or subcategories found</p>
                        </div>
                      ) : (
                        filteredCategoriesForSelection.map(cat => {
                          if (!cat.subcategories || cat.subcategories.length === 0) return null;

                          return (
                            <div key={cat.id} className="space-y-2">
                              <p className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                                {cat.name}
                              </p>
                              <div className="space-y-1 pl-2">
                                {cat.subcategories.map((sub) => (
                                  <div
                                    key={sub}
                                    className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded cursor-pointer"
                                    onClick={() => handleToggleSubcategory(sub)}
                                  >
                                    <Checkbox
                                      id={`sub-${cat.name}-${sub}`}
                                      checked={(editingResource.subcategories || []).includes(sub)}
                                      onCheckedChange={() => handleToggleSubcategory(sub)}
                                      className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                                    />
                                    <Label
                                      htmlFor={`sub-${cat.name}-${sub}`}
                                      className="flex-1 cursor-pointer text-sm"
                                    >
                                      {sub}
                                    </Label>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    {editingResource.subcategories && editingResource.subcategories.length > 0 && (
                      <div className="flex flex-wrap gap-2 p-3 bg-blue-50 rounded-lg">
                        <p className="text-xs font-medium text-blue-900 w-full mb-1">
                          Selected: {editingResource.subcategories.length}
                        </p>
                        {editingResource.subcategories.map((sub, idx) => (
                          <Badge key={idx} className="bg-blue-100 text-blue-700 pr-1">
                            {sub}
                            <button
                              onClick={() => handleToggleSubcategory(sub)}
                              className="ml-2 hover:bg-blue-200 rounded-full p-0.5"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Target URL / Embed Code - Dynamic based on resource type */}
                {editingResource.resource_type === 'video' ? (
                  <div className="space-y-2">
                    <Label htmlFor="embed-code">Video Embed Code *</Label>
                    <Textarea
                      id="embed-code"
                      value={editingResource.target_url}
                      onChange={handleTargetUrlChange}
                      placeholder="Paste your video embed code here (e.g., YouTube or Vimeo embed code)"
                      rows={4}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-slate-500">
                      Paste the complete embed code from your video platform
                    </p>
                  </div>
                ) : editingResource.resource_type === 'download' ? (
                  <div className="space-y-2">
                    <Label htmlFor="download-url">Download File *</Label>
                    <div className="flex gap-2">
                      <Input
                        id="download-url"
                        value={targetFromRepository ? '' : (editingResource.target_url || '')}
                        onChange={handleTargetUrlChange}
                        placeholder={targetFromRepository ? "File selected from repository" : "https://... or select from repository"}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowFileSelector('target')}
                      >
                        <FileText className="w-4 h-4 mr-2" />
                        Select from Repository
                      </Button>
                    </div>
                    {editingResource.target_url && (
                      <div className="mt-2 p-3 border border-slate-200 rounded-lg bg-slate-50 relative">
                        <div className="flex items-center gap-2 pr-10">
                          <FileText className="w-4 h-4 text-slate-600 shrink-0" />
                          <p className="text-sm text-slate-700 flex-1 truncate">
                            {targetFromRepository ? targetFileName : 'External file URL'}
                          </p>
                        </div>
                        <button
                          onClick={handleClearTarget}
                          className="absolute bottom-2 right-2 p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
                          title="Remove file"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="external-url">External Link URL *</Label>
                    <Input
                      id="external-url"
                      value={editingResource.target_url}
                      onChange={handleTargetUrlChange}
                      placeholder="https://example.com"
                      className="flex-1"
                    />
                    <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg mt-2">
                      <Switch
                        id="open-new-tab"
                        checked={editingResource.open_in_new_tab}
                        onCheckedChange={(checked) => setEditingResource({ ...editingResource, open_in_new_tab: checked })}
                      />
                      <div className="flex-1">
                        <Label htmlFor="open-new-tab" className="cursor-pointer text-sm">Open in new tab</Label>
                        <p className="text-xs text-slate-500 mt-0.5">
                          When enabled, the link will open in a new browser tab
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="image-url">Image URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id="image-url"
                      value={imageFromRepository ? '' : (editingResource.image_url || '')}
                      onChange={handleImageUrlChange}
                      placeholder={imageFromRepository ? "Image selected from repository" : "https://... or select from repository"}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowFileSelector('image')}
                    >
                      <ImageIcon className="w-4 h-4 mr-2" />
                      Select from Repository
                    </Button>
                  </div>
                  {editingResource.image_url && (
                    <div className="mt-2 p-2 border border-slate-200 rounded-lg relative">
                      <img
                        src={editingResource.image_url}
                        alt="Preview"
                        className="w-full h-32 object-cover rounded"
                      />
                      <button
                        onClick={handleClearImage}
                        className="absolute bottom-3 right-3 p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
                        title="Remove image"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Tags</Label>
                  <div className="relative">
                    <div className="flex gap-2">
                      <Input
                        placeholder="Add tag"
                        value={newTag}
                        onChange={(e) => {
                          setNewTag(e.target.value);
                          setShowTagSuggestions(true);
                        }}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddTag();
                          }
                        }}
                        onFocus={() => setShowTagSuggestions(true)}
                        onBlur={() => {
                          // Delay to allow clicking suggestions
                          setTimeout(() => setShowTagSuggestions(false), 200);
                        }}
                      />
                      <Button onClick={handleAddTag} size="sm">
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>

                    {/* Tag Suggestions Dropdown */}
                    {showTagSuggestions && filteredTagSuggestions.length > 0 && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {filteredTagSuggestions.map((tag, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => handleSelectTag(tag)}
                            className="w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors text-sm"
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {editingResource.tags && editingResource.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 p-3 bg-slate-50 rounded-lg">
                      {editingResource.tags.map((tag, idx) => (
                        <Badge key={idx} className="bg-slate-200 text-slate-700 pr-1">
                          {tag}
                          <button
                            onClick={() => handleRemoveTag(tag)}
                            className="ml-2 hover:bg-slate-300 rounded-full p-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {/* Author Selector */}
                {availableAuthors.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="author">Author (Optional)</Label>
                    <Select
                      value={editingResource.author_id || "none"}
                      onValueChange={(value) => handleSelectAuthor(value === "none" ? "" : value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select an author..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No author</SelectItem>
                        {availableAuthors.map((author) => (
                          <SelectItem key={author.id} value={author.id}>
                            {author.name} ({author.email})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Select from members and team members with designated author roles
                    </p>
                  </div>
                )}

                {/* Release Date Picker */}
                <div className="space-y-2">
                  <Label htmlFor="release-date">Release Date & Time</Label>
                  <Input
                    id="release-date"
                    type="datetime-local"
                    value={editingResource.release_date ? new Date(editingResource.release_date).toISOString().slice(0, 16) : ''}
                    onChange={(e) => {
                      const dateValue = e.target.value ? new Date(e.target.value).toISOString() : new Date().toISOString();
                      setEditingResource({ ...editingResource, release_date: dateValue });
                    }}
                    className="flex-1"
                  />
                  <p className="text-xs text-slate-500">
                    Set a future date to schedule the resource release. Past dates show when the resource was originally published.
                  </p>
                  {editingResource.release_date && new Date(editingResource.release_date) > new Date() && (
                    <div className="flex items-center gap-2 p-3 bg-purple-50 rounded-lg border border-purple-200">
                      <Clock className="w-4 h-4 text-purple-600" />
                      <p className="text-sm text-purple-900">
                        This resource is scheduled for release on {format(new Date(editingResource.release_date), 'MMMM d, yyyy')} at {format(new Date(editingResource.release_date), 'h:mm a')}
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Switch
                    id="is-public"
                    checked={editingResource.is_public}
                    onCheckedChange={(checked) => setEditingResource({ ...editingResource, is_public: checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="is-public" className="cursor-pointer font-medium">Public Resource</Label>
                    <p className="text-xs text-slate-500 mt-1">
                      Make this resource visible to non-members
                    </p>
                  </div>
                </div>

                {!editingResource.is_public && (
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-3">
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4 text-blue-600" />
                      <Label className="font-medium text-blue-900">Role Access Control</Label>
                    </div>
                    <p className="text-xs text-blue-700">
                      Select which roles can access this resource. Leave all unchecked to allow all member roles.
                    </p>
                    <div className="space-y-2">
                      {roles.map((role) => (
                        <div
                          key={role.id}
                          className="flex items-center gap-3 p-2 bg-white rounded hover:bg-blue-50 transition-colors cursor-pointer"
                          onClick={() => handleToggleRole(role.id)}
                        >
                          <Checkbox
                            id={`role-${role.id}`}
                            checked={(editingResource.allowed_role_ids || []).includes(role.id)}
                            onCheckedChange={() => handleToggleRole(role.id)}
                            className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                          />
                          <Label
                            htmlFor={`role-${role.id}`}
                            className="flex-1 cursor-pointer text-sm"
                          >
                            {role.name}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingResource(null);
                  setNewTag("");
                  setSubcategorySearch("");
                  setImageFromRepository(false);
                  setTargetFromRepository(false);
                  setTargetFileName("");
                  setShowTagSuggestions(false);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingResource?.id ? 'Update Resource' : 'Create Resource'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* File Selector Dialog */}
        <Dialog open={!!showFileSelector} onOpenChange={() => {
          setShowFileSelector(null);
          setFileSelectorFolder(null);
          setFileSelectorExpandedFolders({});
          setFileSelectorSearch("");
          setFileSelectorPage(1);
        }}>
          <DialogContent className="max-w-6xl max-h-[90vh] grid grid-rows-[auto_1fr_auto] gap-4">
            <DialogHeader>
              <DialogTitle>
                Select {showFileSelector === 'image' ? 'Image' : 'File'} from Repository
              </DialogTitle>
              <div className="pt-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    placeholder="Search files by name or description..."
                    value={fileSelectorSearch}
                    onChange={(e) => setFileSelectorSearch(e.target.value)}
                    className="pl-10"
                    data-testid="input-file-selector-search"
                  />
                  {fileSelectorSearch && (
                    <button
                      onClick={() => setFileSelectorSearch("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </DialogHeader>

            <div className="grid md:grid-cols-4 gap-4 py-4 overflow-hidden min-h-0">
              {/* Folder Navigation Sidebar */}
              <div className="md:col-span-1 border-r border-slate-200 pr-4 overflow-y-auto">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Folders</h3>
                
                {/* Breadcrumb */}
                <div className="mb-3 p-2 bg-slate-50 rounded-lg">
                  <button
                    onClick={() => setFileSelectorFolder(null)}
                    className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
                  >
                    <Home className="w-3 h-3" />
                    Root
                  </button>
                  {fileSelectorBreadcrumb.map((folder, idx) => (
                    <React.Fragment key={folder.id}>
                      <ChevronRight className="w-3 h-3 text-slate-400 inline-block mx-1" />
                      <button
                        onClick={() => setFileSelectorFolder(folder.id)}
                        className={`text-xs ${
                          idx === fileSelectorBreadcrumb.length - 1
                            ? 'text-blue-600 font-medium'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {folder.name}
                      </button>
                    </React.Fragment>
                  ))}
                </div>

                {/* Folder Tree */}
                <div className="border border-slate-200 rounded-lg p-2 max-h-96 overflow-y-auto">
                  <div
                    className={`flex items-center gap-2 py-2 px-3 rounded cursor-pointer transition-all ${
                      fileSelectorFolder === null ? 'bg-blue-100' : 'hover:bg-slate-100'
                    }`}
                    onClick={() => setFileSelectorFolder(null)}
                  >
                    <FolderOpen className="w-4 h-4 text-slate-600" />
                    <span className="flex-1 text-sm font-medium">Root</span>
                    <span className="text-xs text-slate-500">
                      ({repositoryFiles.filter(f => !f.folder_id && (showFileSelector === 'image' ? f.file_type === 'image' : true)).length})
                    </span>
                  </div>
                  {renderFileSelectorFolderTree(fileSelectorFolderHierarchy)}
                </div>
              </div>

              {/* Files Grid */}
              <div className="md:col-span-3 flex flex-col min-h-0">
                {/* File count and info */}
                <div className="flex items-center justify-between mb-3 text-sm text-slate-600">
                  <span>
                    {filteredRepositoryFiles.length} file{filteredRepositoryFiles.length !== 1 ? 's' : ''} 
                    {fileSelectorSearch && ` matching "${fileSelectorSearch}"`}
                  </span>
                  {fileSelectorTotalPages > 1 && (
                    <span>
                      Page {fileSelectorPage} of {fileSelectorTotalPages}
                    </span>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                  {filteredRepositoryFiles.length === 0 ? (
                    <div className="text-center py-12">
                      <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                      <p className="text-slate-600">
                        {fileSelectorSearch 
                          ? "No files match your search"
                          : "No files in this folder"}
                      </p>
                      <p className="text-sm text-slate-500 mt-2">
                        {fileSelectorSearch 
                          ? "Try a different search term or browse folders"
                          : fileSelectorFolder 
                            ? "Try selecting a different folder"
                            : "Upload files in the File Repository page"}
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {paginatedRepositoryFiles.map((file) => (
                        <button
                          key={file.id}
                          onClick={() => handleSelectFile(file.file_url, showFileSelector, file.file_name)}
                          className="text-left border-2 border-slate-200 rounded-lg hover:border-blue-500 transition-colors p-2"
                          data-testid={`file-select-${file.id}`}
                        >
                          {file.file_type === 'image' ? (
                            <img
                              src={file.file_url}
                              alt={file.file_name}
                              className="w-full h-32 object-cover rounded mb-2"
                            />
                          ) : (
                            <div className="w-full h-32 bg-slate-100 rounded flex items-center justify-center mb-2">
                              <FileText className="w-12 h-12 text-slate-400" />
                            </div>
                          )}
                          <p className="text-sm font-medium text-slate-900 truncate">
                            {file.file_name}
                          </p>
                          {file.description && (
                            <p className="text-xs text-slate-500 truncate mt-1">
                              {file.description}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Pagination Controls */}
                {fileSelectorTotalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-slate-200">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFileSelectorPage(p => Math.max(1, p - 1))}
                      disabled={fileSelectorPage === 1}
                      data-testid="button-file-selector-prev"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    
                    {getFileSelectorPageNumbers().map((page, idx) => (
                      page === '...' ? (
                        <span key={`ellipsis-${idx}`} className="px-2 text-slate-400">...</span>
                      ) : (
                        <Button
                          key={page}
                          variant={fileSelectorPage === page ? "default" : "outline"}
                          size="sm"
                          onClick={() => setFileSelectorPage(page)}
                          className={fileSelectorPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                          data-testid={`button-file-selector-page-${page}`}
                        >
                          {page}
                        </Button>
                      )
                    ))}
                    
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFileSelectorPage(p => Math.min(fileSelectorTotalPages, p + 1))}
                      disabled={fileSelectorPage === fileSelectorTotalPages}
                      data-testid="button-file-selector-next"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setShowFileSelector(null);
                setFileSelectorFolder(null);
                setFileSelectorExpandedFolders({});
                setFileSelectorSearch("");
                setFileSelectorPage(1);
              }}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}