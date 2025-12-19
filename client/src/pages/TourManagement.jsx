
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from "@/components/ui/select";
import { Sparkles, Plus, Edit, Trash2, GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function TourManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [editingGroup, setEditingGroup] = useState(null);
  const [editingStep, setEditingStep] = useState(null);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showStepDialog, setShowStepDialog] = useState(false);
  const [customSelector, setCustomSelector] = useState('');
  const [selectedSelector, setSelectedSelector] = useState('');
  const [isWelcomeStep, setIsWelcomeStep] = useState(false);

  // New states for group mandatory selector
  const [groupMandatorySelector, setGroupMandatorySelector] = useState('');
  const [groupCustomMandatorySelector, setGroupCustomMandatorySelector] = useState('');

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('system.tours')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // Define available pages for the dropdown
  const availablePages = [
    { value: 'Events', label: 'Events' },
    { value: 'BuyProgramTickets', label: 'Buy Program Tickets' },
    { value: 'EventDetails', label: 'Event Details' },
    { value: 'Bookings', label: 'Bookings' },
    { value: 'MyTickets', label: 'My Tickets' },
    { value: 'History', label: 'History' }, // Renamed from MyProgramTickets
    { value: 'Dashboard', label: 'Dashboard' },
    { value: 'Articles', label: 'Articles' },
    { value: 'ArticleEditor', label: 'Article Editor' },
    { value: 'ArticleView', label: 'Article View' },
    { value: 'RoleManagement', label: 'Role Management' },
    { value: 'MemberRoleAssignment', label: 'Member Role Assignment' },
    { value: 'TeamMemberManagement', label: 'Team Member Management' },
    { value: 'DiscountCodeManagement', label: 'Discount Code Management' },
    { value: 'EventSettings', label: 'Event Settings' },
    { value: 'TourManagement', label: 'Tour Management' },
    { value: 'PublicEvents', label: 'Public Events' },
    { value: 'PublicAbout', label: 'Public About' },
    { value: 'PublicContact', label: 'Public Contact' }
  ].sort((a, b) => a.label.localeCompare(b.label));

  // Define view ID options
  const viewIdOptions = [
    { value: "none", label: "No specific view (single page tour)", description: "Use this for pages with just one view" },
    { value: "list", label: "List View", description: "Use for listing/browsing views (e.g., program cards, event list)" },
    { value: "form", label: "Form View", description: "Use for form/detail views (e.g., purchase form, registration form)" }
  ];

  // Common CSS selectors organized by page/section
  const commonSelectors = [
    // Navigation
    { group: "Navigation", label: "Buy Tickets Menu Item", selector: "#buy-tickets-menu-item", page: "all" },
    { group: "Navigation", label: "Events Menu Item", selector: "a[href*='Events']", page: "all" },
    { group: "Navigation", label: "Bookings Menu Item", selector: "a[href*='Bookings']", page: "all" },
    { group: "Navigation", label: "My Tickets Menu Item", selector: "a[href*='MyTickets']", page: "all" },
    
    // Buy Program Tickets Page
    { group: "Buy Program Tickets", label: "Total Tickets Summary Card", selector: "#total-tickets-summary-card", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "First Program Card", selector: "#first-program-card", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Quantity Input Field", selector: "#quantity-input", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Payment Options Card", selector: "#payment-options-card", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Training Vouchers Section", selector: "#training-vouchers-section", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Training Fund Section", selector: "#training-fund-section", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Remaining Balance Section", selector: "#remaining-balance-section", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Amount Due Display", selector: "#amount-due-display", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Account Payment Option", selector: "#account-payment-option", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Card Payment Option", selector: "#card-payment-option", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Purchase Order Field", selector: "#purchase-order-field", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Discount Code Section", selector: "#discount-code-section", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Complete Purchase Button", selector: "#complete-purchase-button", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "Page Tour Button", selector: "#page-tour-button", page: "BuyProgramTickets" },
    { group: "Buy Program Tickets", label: "All Program Cards", selector: ".grid button", page: "BuyProgramTickets" },
    
    // Events Page
    { group: "Events", label: "Search Input", selector: "input[placeholder*='Search']", page: "Events" },
    { group: "Events", label: "First Event Card", selector: ".grid > div:first-child", page: "Events" },
    { group: "Events", label: "Event Cards Grid", selector: ".grid", page: "Events" },
    
    // Event Details Page
    { group: "Event Details", label: "Event Title", selector: "h1", page: "EventDetails" },
    { group: "Event Details", label: "Booking Summary - Tickets Card", selector: "#booking-summary-tickets", page: "EventDetails" },
    { group: "Event Details", label: "Confirm Booking Button", selector: "#confirm-booking-button", page: "EventDetails" },
    { group: "Event Details", label: "I Am Attending Toggle", selector: "#member-attending-toggle", page: "EventDetails" },
    { group: "Event Details", label: "Add Colleague Button", selector: "#add-colleague-button", page: "EventDetails" },
    { group: "Event Details", label: "Colleague Search Input", selector: "#colleague-search-input", page: "EventDetails" },
    { group: "Event Details", label: "Attendee List", selector: "#attendee-list", page: "EventDetails" },
    
    // Bookings Page
    { group: "Bookings", label: "First Booking Card", selector: "#first-booking-card", page: "Bookings" },
    { group: "Bookings", label: "First Ticket Card", selector: "#first-ticket-card", page: "Bookings" },
    { group: "Bookings", label: "First Ticket Edit Button", selector: "#first-ticket-edit-button", page: "Bookings" },
    { group: "Bookings", label: "Bookings Table", selector: "table", page: "Bookings" },
    { group: "Bookings", label: "First Booking Row", selector: "table tbody tr:first-child", page: "Bookings" },
    
    // My Tickets Page
    { group: "My Tickets", label: "First My Ticket Card", selector: "#first-my-ticket-card", page: "MyTickets" },
    { group: "My Tickets", label: "First Ticket Status Badge", selector: "#first-ticket-status-badge", page: "MyTickets" },
    { group: "My Tickets", label: "Add to Calendar Button", selector: "#add-to-calendar-button", page: "MyTickets" },
    { group: "My Tickets", label: "Cancel Ticket Button", selector: "#cancel-ticket-button", page: "MyTickets" },
    { group: "My Tickets", label: "Go to Event Page Button", selector: "#go-to-event-page-button", page: "MyTickets" },
    
    // General Elements
    { group: "General", label: "Page Heading (H1)", selector: "h1", page: "all" },
    { group: "General", label: "Main Content Area", selector: "main", page: "all" },
    { group: "General", label: "Primary Action Button", selector: "button[type='submit']", page: "all" },
    { group: "General", label: "First Card", selector: ".grid > div:first-child", page: "all" },
    
    // Custom option at the end
    { group: "Custom", label: "Enter Custom Selector...", selector: "custom", page: "all" }
  ];

  // Filter selectors based on selected group's page
  const getFilteredSelectors = () => {
    // When editing a group, we want to filter by the page name of the group being edited.
    // If a group is selected in the left panel, but we're adding a new group, no specific page filtering should occur.
    // If a group is selected in the left panel and we're editing *that* group, it should filter by its page name.
    const effectivePageName = editingGroup?.page_name || selectedGroup?.page_name;

    if (!effectivePageName) {
      return commonSelectors;
    }
    
    return commonSelectors.filter(selector => 
      selector.page === "all" || selector.page === effectivePageName
    );
  };

  // Group filtered selectors by category
  const getGroupedSelectors = () => {
    const filtered = getFilteredSelectors();
    return filtered.reduce((acc, item) => {
      if (!acc[item.group]) {
        acc[item.group] = [];
      }
      acc[item.group].push(item);
      return acc;
    }, {});
  };

  // All hooks must be called before any conditional returns
  const { data: tourGroups = [], isLoading: loadingGroups } = useQuery({
    queryKey: ['tourGroups'],
    queryFn: () => base44.entities.TourGroup.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: tourSteps = [], isLoading: loadingSteps } = useQuery({
    queryKey: ['tourSteps', selectedGroup?.id],
    queryFn: async () => {
      if (!selectedGroup?.id) return [];
      const allSteps = await base44.entities.TourStep.list();
      return allSteps
        .filter(s => s.tour_group_id === selectedGroup.id)
        .sort((a, b) => a.step_order - b.step_order);
    },
    enabled: !!selectedGroup?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  const createGroupMutation = useMutation({
    mutationFn: (data) => base44.entities.TourGroup.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tourGroups'] });
      setShowGroupDialog(false);
      setEditingGroup(null);
      toast.success('Tour group created');
    }
  });

  const updateGroupMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.TourGroup.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tourGroups'] });
      setShowGroupDialog(false);
      setEditingGroup(null);
      toast.success('Tour group updated');
    }
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (id) => base44.entities.TourGroup.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tourGroups'] });
      setSelectedGroup(null);
      toast.success('Tour group deleted');
    }
  });

  const createStepMutation = useMutation({
    mutationFn: (data) => base44.entities.TourStep.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tourSteps'] });
      setShowStepDialog(false);
      setEditingStep(null);
      toast.success('Tour step created');
    }
  });

  const updateStepMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.TourStep.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tourSteps'] });
      setShowStepDialog(false);
      setEditingStep(null);
      toast.success('Tour step updated');
    }
  });

  const deleteStepMutation = useMutation({
    mutationFn: (id) => base44.entities.TourStep.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tourSteps'] });
      toast.success('Tour step deleted');
    }
  });

  // Now safe to do conditional rendering after all hooks are called
  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-7xl mx-auto">
          <Card>
            <CardContent className="p-12 text-center">
              <p className="text-slate-600">Loading...</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const handleSaveGroup = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const viewIdValue = formData.get('view_id');
    
    // Get the mandatory selector - either from dropdown or custom input
    let mandatorySelectorValue = null;
    if (groupMandatorySelector) {
      if (groupMandatorySelector === 'custom') {
        mandatorySelectorValue = groupCustomMandatorySelector || null;
      } else {
        mandatorySelectorValue = groupMandatorySelector;
      }
    }
    
    const data = {
      name: formData.get('name'),
      page_name: formData.get('page_name'),
      view_id: viewIdValue === 'none' ? null : viewIdValue,
      description: formData.get('description') || null,
      is_active: formData.get('is_active') === 'on',
      mandatory_selector: mandatorySelectorValue,
      mandatory_selector_missing_message: formData.get('mandatory_selector_missing_message') || null
    };

    if (editingGroup?.id) {
      updateGroupMutation.mutate({ id: editingGroup.id, data });
    } else {
      createGroupMutation.mutate(data);
    }
  };

  const handleSaveStep = (e) => {
    e.preventDefault();
    
    // Get the selector - either from dropdown, custom input, or null for welcome steps
    let targetSelector = null;
    
    if (!isWelcomeStep) {
      if (selectedSelector === 'custom') {
        targetSelector = customSelector;
      } else {
        targetSelector = selectedSelector;
      }
      
      if (!targetSelector) {
        toast.error('Please select or enter a target selector, or mark this as a welcome step.');
        return;
      }
    }

    const formData = new FormData(e.target);
    const data = {
      tour_group_id: selectedGroup.id,
      step_order: parseInt(formData.get('step_order')),
      target_selector: targetSelector,
      title: formData.get('title'),
      content: formData.get('content'),
      placement: formData.get('placement'),
      mode: formData.get('mode'),
      size: formData.get('size') || 'medium',
      gap: parseInt(formData.get('gap')) || 40 
    };

    if (editingStep?.id) {
      updateStepMutation.mutate({ id: editingStep.id, data });
    } else {
      createStepMutation.mutate(data);
    }
  };

  const handleMoveStep = async (stepId, direction) => {
    const stepIndex = tourSteps.findIndex(s => s.id === stepId);
    if (stepIndex === -1) return;
    
    if (direction === 'up' && stepIndex === 0) return;
    if (direction === 'down' && stepIndex === tourSteps.length - 1) return;

    const targetIndex = direction === 'up' ? stepIndex - 1 : stepIndex + 1;
    
    // Swap step_order values
    const currentStep = tourSteps[stepIndex];
    const targetStep = tourSteps[targetIndex];

    await base44.entities.TourStep.update(currentStep.id, { step_order: targetStep.step_order });
    await base44.entities.TourStep.update(targetStep.id, { step_order: currentStep.step_order });
    
    queryClient.invalidateQueries({ queryKey: ['tourSteps'] });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Tour Management</h1>
          <p className="text-slate-600">Create and manage guided tours for your app pages</p>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Tour Groups List */}
          <Card className="lg:col-span-1 border-slate-200">
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Tour Groups</CardTitle>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingGroup(null);
                    setShowGroupDialog(true);
                  }}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  New
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {loadingGroups ? (
                <div className="text-center py-8 text-slate-600">Loading...</div>
              ) : tourGroups.length === 0 ? (
                <div className="text-center py-8">
                  <Sparkles className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-600 text-sm">No tour groups yet</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {tourGroups.map((group) => (
                    <button
                      key={group.id}
                      onClick={() => setSelectedGroup(group)}
                      className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                        selectedGroup?.id === group.id
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-slate-900 truncate">{group.name}</h3>
                          <p className="text-xs text-slate-500 mt-1">
                            {group.page_name}{group.view_id ? ` (${group.view_id})` : ''}
                          </p>
                        </div>
                        <Badge variant={group.is_active ? "default" : "secondary"} className="shrink-0">
                          {group.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Tour Steps */}
          <Card className="lg:col-span-2 border-slate-200">
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">
                  {selectedGroup ? `Steps: ${selectedGroup.name}` : 'Select a Tour Group'}
                </CardTitle>
                {selectedGroup && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingGroup(selectedGroup);
                        setShowGroupDialog(true);
                      }}
                    >
                      <Edit className="w-4 h-4 mr-1" />
                      Edit Group
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (confirm('Delete this tour group and all its steps?')) {
                          deleteGroupMutation.mutate(selectedGroup.id);
                        }
                      }}
                      className="text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      Delete
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEditingStep(null);
                        setIsWelcomeStep(false); // New step is not welcome by default
                        setSelectedSelector(''); // Clear selected selector for new step
                        setCustomSelector(''); // Clear custom selector for new step
                        setShowStepDialog(true);
                      }}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Step
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {!selectedGroup ? (
                <div className="text-center py-12">
                  <Sparkles className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-600">Select a tour group to view and edit its steps</p>
                </div>
              ) : loadingSteps ? (
                <div className="text-center py-8 text-slate-600">Loading steps...</div>
              ) : tourSteps.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-slate-600 mb-4">No steps yet for this tour</p>
                  <Button
                    onClick={() => {
                      setEditingStep(null);
                      setIsWelcomeStep(false);
                      setSelectedSelector('');
                      setCustomSelector('');
                      setShowStepDialog(true);
                    }}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add First Step
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {tourSteps.map((step, index) => (
                    <div
                      key={step.id}
                      className="p-4 bg-slate-50 rounded-lg border border-slate-200"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex flex-col gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => handleMoveStep(step.id, 'up')}
                            disabled={index === 0}
                          >
                            <ArrowUp className="w-4 h-4" />
                          </Button>
                          <Badge variant="outline" className="w-6 h-6 flex items-center justify-center p-0">
                            {step.step_order}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => handleMoveStep(step.id, 'down')}
                            disabled={index === tourSteps.length - 1}
                          >
                            <ArrowDown className="w-4 h-4" />
                          </Button>
                        </div>
                        
                        <div className="flex-1">
                          <h4 className="font-semibold text-slate-900 mb-1">{step.title}</h4>
                          <p className="text-sm text-slate-600 mb-2">{step.content}</p>
                          <div className="flex gap-2 flex-wrap">
                            {step.target_selector ? (
                                <Badge variant="outline" className="text-xs">
                                    {step.target_selector}
                                </Badge>
                            ) : (
                                <Badge variant="default" className="text-xs bg-blue-100 text-blue-700 border-blue-200">
                                    Welcome Step
                                </Badge>
                            )}
                            <Badge variant="outline" className="text-xs">
                              {step.placement}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {step.mode}
                            </Badge>
                            {step.gap !== undefined && (
                                <Badge variant="outline" className="text-xs">
                                  Gap: {step.gap}px
                                </Badge>
                            )}
                          </div>
                        </div>

                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditingStep(step);
                              if (step.target_selector === null) {
                                setIsWelcomeStep(true);
                                setSelectedSelector('');
                                setCustomSelector('');
                              } else {
                                setIsWelcomeStep(false);
                                // Check if the selector is in our list
                                const found = commonSelectors.find(s => s.selector === step.target_selector);
                                if (found) {
                                  setSelectedSelector(found.selector);
                                  setCustomSelector('');
                                } else {
                                  setSelectedSelector('custom');
                                  setCustomSelector(step.target_selector);
                                }
                              }
                              setShowStepDialog(true);
                            }}
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (confirm('Delete this step?')) {
                                deleteStepMutation.mutate(step.id);
                              }
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
            </CardContent>
          </Card>
        </div>

        {/* Group Dialog */}
        <Dialog open={showGroupDialog} onOpenChange={(open) => {
          setShowGroupDialog(open);
          if (!open) {
            // Reset states when closing
            setGroupMandatorySelector('');
            setGroupCustomMandatorySelector('');
            setEditingGroup(null); // Ensure editingGroup is reset
          } else if (editingGroup) {
            // Set initial values when opening for edit
            if (editingGroup.mandatory_selector) {
              const found = commonSelectors.find(s => s.selector === editingGroup.mandatory_selector);
              if (found) {
                setGroupMandatorySelector(editingGroup.mandatory_selector);
                setGroupCustomMandatorySelector('');
              } else {
                setGroupMandatorySelector('custom');
                setGroupCustomMandatorySelector(editingGroup.mandatory_selector);
              }
            } else {
              setGroupMandatorySelector(''); // No mandatory selector
              setGroupCustomMandatorySelector('');
            }
          } else { // Opening for new group
              setGroupMandatorySelector('');
              setGroupCustomMandatorySelector('');
          }
        }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingGroup ? 'Edit Tour Group' : 'New Tour Group'}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSaveGroup} className="space-y-4">
              <div>
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  name="name"
                  defaultValue={editingGroup?.name}
                  placeholder="e.g., Buy Program Tickets - List View"
                  required
                />
              </div>
              
              <div>
                <Label htmlFor="page_name">Page Name *</Label>
                <Select name="page_name" defaultValue={editingGroup?.page_name} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a page" />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePages.map((page) => (
                      <SelectItem key={page.value} value={page.value}>
                        {page.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">The page this tour will appear on</p>
              </div>
              
              <div>
                <Label htmlFor="view_id">View ID</Label>
                <Select name="view_id" defaultValue={editingGroup?.view_id || "none"}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a view type" />
                  </SelectTrigger>
                  <SelectContent>
                    {viewIdOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <div className="flex flex-col">
                          <span>{option.label}</span>
                          <span className="text-xs text-slate-500">{option.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  Use this to create different tours for different views of the same page
                </p>
              </div>
              
              <div>
                <Label htmlFor="description">Description (Optional)</Label>
                <Textarea
                  id="description"
                  name="description"
                  defaultValue={editingGroup?.description}
                  placeholder="What does this tour cover?"
                  rows={3}
                />
              </div>

              <div className="border-t border-slate-200 pt-4">
                <h4 className="font-medium text-slate-900 mb-3">Tour Requirements (Optional)</h4>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="mandatory_selector">Mandatory Element CSS Selector</Label>
                    <Select 
                      value={groupMandatorySelector === null ? '' : groupMandatorySelector} // Map null to '' for Select value
                      onValueChange={(value) => {
                        setGroupMandatorySelector(value);
                        if (value !== 'custom') {
                          setGroupCustomMandatorySelector('');
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select an element (optional)" />
                      </SelectTrigger>
                      <SelectContent className="max-h-[400px]">
                        <SelectItem value={null}>None (no mandatory element)</SelectItem>
                        {Object.entries(getGroupedSelectors()).map(([groupName, items]) => (
                          <React.Fragment key={groupName}>
                            <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 bg-slate-50 sticky top-0">
                              {groupName}
                            </div>
                            {items.map((item) => (
                              <SelectItem key={item.selector} value={item.selector}>
                                {item.label}
                                {item.selector !== 'custom' && (
                                  <span className="text-xs text-slate-400 ml-2">
                                    {item.selector}
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </React.Fragment>
                        ))}
                      </SelectContent>
                    </Select>
                    
                    {groupMandatorySelector === 'custom' && (
                      <div className="mt-2">
                        <Input
                          placeholder="Enter CSS selector (e.g., #my-element, .my-class)"
                          value={groupCustomMandatorySelector}
                          onChange={(e) => setGroupCustomMandatorySelector(e.target.value)}
                        />
                      </div>
                    )}
                    
                    <p className="text-xs text-slate-500 mt-1">
                      If specified, this element must be present on the page for the tour to start
                    </p>
                  </div>
                  
                  <div>
                    <Label htmlFor="mandatory_selector_missing_message">Message if Element Missing</Label>
                    <Textarea
                      id="mandatory_selector_missing_message"
                      name="mandatory_selector_missing_message"
                      defaultValue={editingGroup?.mandatory_selector_missing_message}
                      placeholder="e.g., Please add at least one program before viewing this tour."
                      rows={2}
                    />
                    <p className="text-xs text-slate-500 mt-1">
                      Custom message shown when the mandatory element is not found
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <Switch
                  id="is_active"
                  name="is_active"
                  defaultChecked={editingGroup?.is_active !== false}
                />
                <Label htmlFor="is_active">Active</Label>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowGroupDialog(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-blue-600 hover:bg-blue-700">
                  {editingGroup ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Step Dialog */}
        <Dialog open={showStepDialog} onOpenChange={(open) => {
          setShowStepDialog(open);
          if (!open) {
            // Reset states when dialog closes
            setIsWelcomeStep(false);
            setSelectedSelector('');
            setCustomSelector('');
          }
        }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editingStep ? 'Edit Tour Step' : 'New Tour Step'}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSaveStep} className="space-y-4">
              <div>
                <Label htmlFor="step_order">Step Order *</Label>
                <Input
                  id="step_order"
                  name="step_order"
                  type="number"
                  min="1"
                  defaultValue={editingStep?.step_order || (tourSteps.length + 1)}
                  required
                />
              </div>
              
              <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <input
                  type="checkbox"
                  id="is_welcome_step"
                  checked={isWelcomeStep}
                  onChange={(e) => {
                    setIsWelcomeStep(e.target.checked);
                    if (e.target.checked) {
                      setSelectedSelector('');
                      setCustomSelector('');
                    }
                  }}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="is_welcome_step" className="cursor-pointer flex-1">
                  <div>
                    <div className="font-medium text-blue-900">Welcome/Info Step</div>
                    <div className="text-xs text-blue-700">No element to highlight - displays centered popup with 'don't show again' option</div>
                  </div>
                </Label>
              </div>
              
              {isWelcomeStep && (
                <div>
                  <Label htmlFor="size">Card Size</Label>
                  <Select name="size" defaultValue={editingStep?.size || 'medium'}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="small">Small (320px)</SelectItem>
                      <SelectItem value="medium">Medium (384px)</SelectItem>
                      <SelectItem value="large">Large (512px)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500 mt-1">Choose the width of the welcome card</p>
                </div>
              )}
              
              {!isWelcomeStep && (
                <div>
                  <Label htmlFor="target_selector">Target Element *</Label>
                  <Select 
                    value={selectedSelector || ''} 
                    onValueChange={(value) => {
                      setSelectedSelector(value);
                      if (value !== 'custom') {
                        setCustomSelector('');
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a target element" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[400px]">
                      {Object.entries(getGroupedSelectors()).map(([groupName, items]) => (
                        <React.Fragment key={groupName}>
                          <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 bg-slate-50 sticky top-0">
                            {groupName}
                          </div>
                          {items.map((item) => (
                            <SelectItem key={item.selector} value={item.selector}>
                              {item.label}
                              {item.selector !== 'custom' && (
                                <span className="text-xs text-slate-400 ml-2">
                                  {item.selector}
                                </span>
                              )}
                            </SelectItem>
                          ))}
                        </React.Fragment>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {selectedSelector === 'custom' && (
                    <div className="mt-2">
                      <Input
                        placeholder="Enter CSS selector (e.g., #my-element, .my-class)"
                        value={customSelector}
                        onChange={(e) => setCustomSelector(e.target.value)}
                      />
                    </div>
                  )}
                  
                  <p className="text-xs text-slate-500 mt-1">
                    {selectedGroup?.page_name 
                      ? `Showing elements for "${selectedGroup.page_name}" page and general elements`
                      : 'Select a common element or choose "Custom" to enter your own CSS selector'
                    }
                  </p>
                </div>
              )}
              
              <div>
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  name="title"
                  defaultValue={editingStep?.title}
                  placeholder={isWelcomeStep ? "e.g., Welcome to Buy Program Tickets" : "e.g., Select a Program"}
                  required
                />
              </div>
              
              <div>
                <Label htmlFor="content">Content *</Label>
                <Textarea
                  id="content"
                  name="content"
                  defaultValue={editingStep?.content}
                  placeholder={isWelcomeStep ? "This is your first time here! Let us guide you through the process." : "Explain what the user should do or provide welcome information..."}
                  rows={4}
                  required
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="placement">Placement</Label>
                  <Select name="placement" defaultValue={editingStep?.placement || 'bottom'}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="top">Top</SelectItem>
                      <SelectItem value="bottom">Bottom</SelectItem>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="right">Right</SelectItem>
                    </SelectContent>
                  </Select>
                  {isWelcomeStep && (
                    <p className="text-xs text-slate-500 mt-1">Not used for welcome steps (always centered)</p>
                  )}
                </div>
                
                <div>
                  <Label htmlFor="mode">Mode</Label>
                  <Select name="mode" defaultValue={editingStep?.mode || 'standard'}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard</SelectItem>
                      <SelectItem value="interactive">Interactive</SelectItem>
                    </SelectContent>
                  </Select>
                  {isWelcomeStep && (
                    <p className="text-xs text-slate-500 mt-1">Not used for welcome steps (always standard)</p>
                  )}
                </div>
              </div>

              <div>
                <Label htmlFor="gap">Spacing Gap (pixels)</Label>
                <Input
                  id="gap"
                  name="gap"
                  type="number"
                  min="0"
                  max="100"
                  defaultValue={editingStep?.gap || 40}
                  placeholder="40"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Distance between the popup and the target element (or screen edge for welcome steps). Default: 40px
                </p>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => {
                  setShowStepDialog(false);
                  setIsWelcomeStep(false);
                  setSelectedSelector('');
                  setCustomSelector('');
                }}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-green-600 hover:bg-green-700">
                  {editingStep ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
