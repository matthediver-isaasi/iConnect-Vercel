export interface Feature {
  id: string;
  label: string;
}

export interface Page {
  id: string;
  label: string;
  features?: Feature[];
}

export interface Module {
  id: string;
  label: string;
  icon?: string;
  features?: Feature[];
  pages: Page[];
}

export const ROLE_ACCESS_MAP: Module[] = [
  {
    id: "user",
    label: "User",
    icon: "Users",
    pages: [
      {
        id: "user.about-me",
        label: "About Me",
        features: [
          { id: "user.about-me.edit-profile", label: "Edit Profile" },
          { id: "user.about-me.change-password", label: "Change Password" },
          { id: "user.about-me.show-in-directory", label: "Show in Member Directory Toggle" },
          { id: "user.about-me.communication-preferences", label: "Communication Preferences" },
          { id: "user.about-me.additional-info", label: "Additional Info" },
          { id: "user.about-me.engagement-stats", label: "Engagement Stats" },
          { id: "user.about-me.engagement-awards", label: "Engagement Awards" },
          { id: "user.about-me.groups", label: "Groups" },
          { id: "user.about-me.membership-badges", label: "Membership Badges" },
          { id: "user.about-me.awards", label: "Awards" },
          { id: "user.about-me.professional-biography", label: "Professional Biography" },
          { id: "user.about-me.outlook", label: "Outlook Email Integration" },
          { id: "user.about-me.booking", label: "Personal Booking Links" },
          { id: "user.about-me.booking-availability", label: "Booking Availability" }
        ]
      },
      {
        id: "user.my-bookings",
        label: "My Bookings"
      }
    ]
  },
  {
    id: "events",
    label: "Events",
    icon: "Calendar",
    pages: [
      {
        id: "events.browse-events",
        label: "Browse Events",
        features: [
          { id: "events.browse-events.search-filters", label: "Search & Filters" },
          { id: "events.browse-events.create", label: "Create, Edit & Delete Events" },
          { id: "events.browse-events.view-attendees", label: "View Attendees" }
        ]
      },
      {
        id: "events.event-details",
        label: "Event Details",
        features: [
          { id: "events.event-details.self-registration", label: "Self Registration" },
          { id: "events.event-details.add-colleagues", label: "Add Team Members to Events" },
          { id: "events.event-details.register-external", label: "Register External Attendees" },
          { id: "events.event-details.use-vouchers", label: "Use Training Vouchers" },
          { id: "events.event-details.use-training-fund", label: "Use Training Fund" },
          { id: "events.event-details.available-seats", label: "Available Seats Display" }
        ]
      },
      {
        id: "events.my-tickets",
        label: "My Tickets"
      },
      {
        id: "events.event-settings",
        label: "Event Settings"
      },
      {
        id: "events.ticket-analytics",
        label: "Ticket Sales Analytics"
      },
      {
        id: "events.discount-codes",
        label: "Discount Codes"
      },
      {
        id: "events.speakers",
        label: "Speaker Management"
      },
      {
        id: "events.zoom-webinars",
        label: "Zoom Webinar Provisioning"
      }
    ]
  },
  {
    id: "commerce",
    label: "Commerce & Finance",
    icon: "CreditCard",
    pages: [
      {
        id: "commerce.bookings",
        label: "Bookings",
        features: [
          { id: "commerce.bookings.access-invoices", label: "View & Download Invoices" }
        ]
      },
      {
        id: "commerce.buy-tickets",
        label: "Buy Tickets",
        features: [
          { id: "commerce.buy-tickets.use-vouchers", label: "Use Training Vouchers" },
          { id: "commerce.buy-tickets.use-training-fund", label: "Use Training Fund" }
        ]
      },
      {
        id: "commerce.balances",
        label: "Balances",
        features: [
          { id: "commerce.balances.training-fund-card", label: "Training Fund Card" },
          { id: "commerce.balances.training-vouchers-card", label: "Training Vouchers Card" },
          { id: "commerce.balances.program-tickets-card", label: "Program Tickets Card" },
          { id: "commerce.balances.vouchers-list", label: "Vouchers List" }
        ]
      },
      {
        id: "commerce.history",
        label: "Transaction History",
        features: [
          { id: "commerce.history.access-invoices", label: "View & Download Invoices" }
        ]
      },
      {
        id: "commerce.voucher-management",
        label: "Voucher Management"
      },
      {
        id: "commerce.training-fund-management",
        label: "Training Fund Management"
      }
    ]
  },
  {
    id: "membership",
    label: "Membership & Directory",
    icon: "Users",
    pages: [
      {
        id: "membership.member-directory",
        label: "Member Directory",
        features: [
          { id: "membership.member-directory.show-disabled", label: "Show Disabled Accounts Toggle" },
          { id: "membership.member-directory.view-biography", label: "View Member Biographies" }
        ]
      },
      {
        id: "membership.organisation-directory",
        label: "Organisation Directory",
        features: [
          { id: "membership.organisation-directory.edit-logo", label: "Edit Organisation Logos" }
        ]
      },
      {
        id: "membership.team",
        label: "Team",
        features: [
          { id: "membership.team.invite-member", label: "Invite Member Button" },
          { id: "membership.team.login-access-toggle", label: "Login Access Toggle" },
          { id: "membership.team.edit-member", label: "Edit Member Icon" },
          { id: "membership.team.view-inactive-accounts", label: "Show Inactive Accounts Toggle" }
        ]
      },
      {
        id: "membership.member-groups",
        label: "Member Groups"
      },
      {
        id: "membership.member-group-assignment-report",
        label: "Member Group Assignment Report"
      },
      {
        id: "membership.member-directory-settings",
        label: "Member Directory Settings"
      },
      {
        id: "membership.organisation-directory-settings",
        label: "Organisation Directory Settings"
      },
      {
        id: "membership.member-groups-guests",
        label: "Member Group Guest Management"
      },
      {
        id: "membership.awards",
        label: "Award Management"
      },
      {
        id: "membership.member-field-permissions",
        label: "Member Field Permissions"
      }
    ]
  },
  {
    id: "organisation",
    label: "Organisation",
    icon: "Building",
    pages: [
      {
        id: "organisation.my-organisation",
        label: "My Organisation"
      },
      {
        id: "organisation.field-permissions",
        label: "Organisation Field Permissions"
      }
    ]
  },
  {
    id: "content",
    label: "Content Publishing",
    icon: "FileText",
    pages: [
      {
        id: "content.articles",
        label: "Articles",
        features: [
          { id: "content.my-articles", label: "My Articles" },
          { id: "content.article-editor", label: "Article Editor" },
          { id: "content.articles-settings", label: "Articles Settings" },
          { id: "content.guest-writers", label: "Guest Writer Management" },
          { id: "content.articles.edit", label: "Edit Articles" },
          { id: "content.articles.delete", label: "Delete Articles" },
          { id: "content.articles.follow-author", label: "Follow Author" },
          { id: "content.articles.author-takeover", label: "Show Author As Controls" },
          { id: "content.articles.comments", label: "Comments Section" }
        ]
      },
      {
        id: "content.news",
        label: "News",
        features: [
          { id: "content.news-settings", label: "News Settings" },
          { id: "content.news-editor", label: "News Editor" },
          { id: "content.news-editor.seo-settings", label: "SEO Settings" },
          { id: "content.news.edit", label: "Edit News" },
          { id: "content.news.delete", label: "Delete News" },
          { id: "content.news.my-news", label: "My News" }
        ]
      },
      {
        id: "content.resources",
        label: "Resources",
        features: [
          { id: "content.resource-management", label: "Resource Management" },
          { id: "content.resource-settings", label: "Resource Settings" }
        ]
      },
      {
        id: "content.tags",
        label: "Tag Management"
      },
      {
        id: "content.categories",
        label: "Category Management"
      },
      {
        id: "content.files",
        label: "File Repository"
      }
    ]
  },
  {
    id: "jobs",
    label: "Job Board",
    icon: "Briefcase",
    pages: [
      {
        id: "jobs.job-board",
        label: "Job Board"
      },
      {
        id: "jobs.post-job",
        label: "Post Job",
        features: [
          { id: "jobs.post-job.post-on-behalf", label: "Post on Behalf of Organisation" }
        ]
      },
      {
        id: "jobs.my-postings",
        label: "My Job Postings",
        features: [
          { id: "jobs.my-postings.post-for-others", label: "Post Jobs for Other Organisations" }
        ]
      },
      {
        id: "jobs.job-management",
        label: "Job Posting Management"
      },
      {
        id: "jobs.job-settings",
        label: "Job Board Settings"
      }
    ]
  },
  {
    id: "site-builder",
    label: "Site Builder",
    icon: "Layout",
    pages: [
      {
        id: "site-builder.pages",
        label: "Page Management"
      },
      {
        id: "site-builder.page-editor",
        label: "Page Editor"
      },
      {
        id: "site-builder.templates",
        label: "Element Templates"
      },
      {
        id: "site-builder.banners",
        label: "Page Banners"
      },
      {
        id: "site-builder.navigation",
        label: "Navigation Items"
      },
      {
        id: "site-builder.buttons",
        label: "Buttons"
      },
      {
        id: "site-builder.button-styles",
        label: "Button Styles"
      },
      {
        id: "site-builder.wall-of-fame",
        label: "Wall of Fame"
      },
      {
        id: "site-builder.fonts",
        label: "Installed Fonts"
      },
      {
        id: "site-builder.floaters",
        label: "Floater Management",
        features: [
          { id: "site-builder.floaters.display", label: "Floater Display" }
        ]
      },
      {
        id: "site-builder.card-decks",
        label: "Card Deck Management"
      },
      {
        id: "site-builder.border-radius",
        label: "Border Radius Settings"
      }
    ]
  },
  {
    id: "forms",
    label: "Forms",
    icon: "ClipboardList",
    pages: [
      {
        id: "forms.form-management",
        label: "Form Management"
      },
      {
        id: "forms.form-builder",
        label: "Form Builder"
      },
      {
        id: "forms.submissions",
        label: "View Submissions"
      },
      {
        id: "forms.settings",
        label: "Form Settings"
      },
      {
        id: "forms.due-diligence-dashboard",
        label: "Due Diligence Dashboard",
        features: [
          { id: "forms.due-diligence-dashboard.view-submissions", label: "View Submissions" },
          { id: "forms.due-diligence-dashboard.review-submissions", label: "Review Submissions" }
        ]
      },
      {
        id: "forms.due-diligence-config",
        label: "Due Diligence Configuration",
        features: [
          { id: "forms.due-diligence-config.edit-scoring", label: "Edit Scoring Rules" },
          { id: "forms.due-diligence-config.edit-workflow", label: "Edit Workflow Stages" }
        ]
      },
      {
        id: "forms.review-submission",
        label: "Review Submission"
      }
    ]
  },
  {
    id: "calendar",
    label: "Calendar & Scheduling",
    icon: "Calendar",
    pages: [
      {
        id: "calendar.agents",
        label: "Booking Agents"
      }
    ]
  },
  {
    id: "support",
    label: "Support",
    icon: "HelpCircle",
    pages: [
      {
        id: "support.help",
        label: "Support Page"
      },
      {
        id: "support.management",
        label: "Support Management"
      }
    ]
  },
  {
    id: "communication",
    label: "Communication",
    icon: "Mail",
    pages: [
      {
        id: "communication.email-templates",
        label: "Email Templates"
      },
      {
        id: "communication.workflows",
        label: "Workflow Management"
      },
      {
        id: "communication.preferences",
        label: "User Preferences",
        features: [
          { id: "communication.preferences.edit-biography", label: "Edit Professional Biography" }
        ]
      },
      {
        id: "communication.preference-settings",
        label: "Preference Settings"
      },
      {
        id: "communication.management",
        label: "Communications Management"
      },
      {
        id: "communication.emailcampaigneditor",
        label: "Email Campaign Editor"
      }
    ]
  },
  {
    id: "admin",
    label: "Admin Toolkit",
    icon: "Shield",
    pages: [
      {
        id: "admin.role-management",
        label: "Role Management"
      },
      {
        id: "admin.member-role-assignment",
        label: "Assign Member Roles",
        features: [
          { id: "admin.member-role-assignment.edit-members", label: "Edit Other Members Details" }
        ]
      },
      {
        id: "admin.team-member-management",
        label: "Team Member Management"
      },
      {
        id: "admin.member-handle-management",
        label: "Member Handle Management"
      },
      {
        id: "admin.custom-fields",
        label: "Custom Fields"
      },
      {
        id: "admin.data-export",
        label: "Data Export"
      },
      {
        id: "admin.dynamic-directories",
        label: "Dynamic Directory Management"
      },
      {
        id: "admin.preference-settings",
        label: "Preference Settings"
      },
      {
        id: "admin.redirect-management",
        label: "Redirect Management"
      },
      {
        id: "admin.roleaccessconfigmanagement",
        label: "Role Access Config Management"
      }
    ]
  },
  {
    id: "projects",
    label: "Project Management",
    icon: "Kanban",
    pages: [
      {
        id: "projects.boards",
        label: "Project Boards",
        features: [
          { id: "projects.boards.create", label: "Create Boards" },
          { id: "projects.boards.manage-members", label: "Manage Board Members" }
        ]
      },
      {
        id: "projects.board-view",
        label: "Board View",
        features: [
          { id: "projects.board-view.create-lists", label: "Create Lists" },
          { id: "projects.board-view.create-cards", label: "Create Cards" },
          { id: "projects.board-view.assign-cards", label: "Assign Cards" },
          { id: "projects.board-view.manage-labels", label: "Manage Labels" }
        ]
      }
    ]
  },
  {
    id: "crm",
    label: "CRM",
    icon: "Database",
    pages: [
      {
        id: "crm.organisations",
        label: "Organisations"
      },
      {
        id: "crm.members",
        label: "Members"
      }
    ]
  },
  {
    id: "system",
    label: "System Settings",
    icon: "Settings",
    pages: [
      {
        id: "system.admin-setup",
        label: "Admin Setup"
      },
      {
        id: "system.role-access-config",
        label: "Role Access Configuration"
      },
      {
        id: "system.portal-navigation",
        label: "Portal Navigation"
      },
      {
        id: "system.portal-menu",
        label: "Portal Menu Management"
      },
      {
        id: "system.tours",
        label: "Tour Management"
      },
      {
        id: "system.page-visibility",
        label: "Page Visibility Settings"
      },
      {
        id: "system.team-invite",
        label: "Team Invite Settings"
      },
      {
        id: "system.team-settings",
        label: "Team Settings"
      },
      {
        id: "system.site-map",
        label: "Site Map"
      },
      {
        id: "system.dashboard",
        label: "Dashboard"
      },
      {
        id: "system.news-ticker",
        label: "News Ticker Bar",
        features: [
          { id: "system.news-ticker.display", label: "Show News Ticker" }
        ]
      }
    ]
  }
];

export function getAllResourceIds(): string[] {
  const ids: string[] = [];
  for (const module of ROLE_ACCESS_MAP) {
    ids.push(module.id);
    for (const page of module.pages) {
      ids.push(page.id);
      if (page.features) {
        for (const feature of page.features) {
          ids.push(feature.id);
        }
      }
    }
  }
  return ids;
}

export function getModuleForResource(resourceId: string): string | null {
  const parts = resourceId.split('.');
  if (parts.length > 0) {
    return parts[0];
  }
  return null;
}

export function getPageForResource(resourceId: string): string | null {
  const parts = resourceId.split('.');
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return null;
}

export function isModuleId(resourceId: string): boolean {
  return !resourceId.includes('.');
}

export function isPageId(resourceId: string): boolean {
  const parts = resourceId.split('.');
  return parts.length === 2;
}

export function isFeatureId(resourceId: string): boolean {
  const parts = resourceId.split('.');
  return parts.length === 3;
}

export function getResourceLabel(resourceId: string): string | null {
  for (const module of ROLE_ACCESS_MAP) {
    if (module.id === resourceId) {
      return module.label;
    }
    for (const page of module.pages) {
      if (page.id === resourceId) {
        return page.label;
      }
      if (page.features) {
        for (const feature of page.features) {
          if (feature.id === resourceId) {
            return feature.label;
          }
        }
      }
    }
  }
  return null;
}

export const LEGACY_TO_NEW_MAPPING: Record<string, string> = {
  "page_user_BuyProgramTickets": "commerce.buy-tickets",
  "page_user_Events": "events.browse-events",
  "page_user_Bookings": "commerce.bookings",
  "page_user_MyTickets": "events.my-tickets",
  "page_user_Balances": "commerce.balances",
  "page_user_History": "commerce.history",
  "page_user_Team": "membership.team",
  "page_user_MemberDirectory": "membership.member-directory",
  "page_user_OrganisationDirectory": "membership.organisation-directory",
  "page_user_MyOrganisation": "organisation.my-organisation",
  "page_user_Resources": "content.resources",
  "page_user_ArticlesSection": "content",
  "page_user_Articles": "content.articles",
  "page_user_News": "content.news",
  "page_user_MyJobPostings": "jobs.my-postings",
  "page_user_Preferences": "user.about-me",
  "page_user_Support": "support.help",
  "page_admin_NewsSection": "content",
  "page_admin_NewsSettings": "content.news-settings",
  "page_admin_ArticlesSection": "content",
  "page_admin_ArticlesSettings": "content.articles-settings",
  "page_admin_RoleManagement": "admin.role-management",
  "page_admin_MemberRoleAssignment": "admin.member-role-assignment",
  "page_admin_TeamMemberManagement": "admin.team-member-management",
  "page_admin_MemberHandleManagement": "admin.member-handle-management",
  "page_admin_MemberDirectorySettings": "membership.member-directory-settings",
  "page_admin_DiscountCodeManagement": "events.discount-codes",
  "page_admin_EventSettings": "events.event-settings",
  "page_admin_TicketSalesAnalytics": "events.ticket-analytics",
  "page_admin_AwardManagement": "membership.awards",
  "page_admin_CategoryManagement": "content.categories",
  "page_admin_ResourceSettings": "content.resource-settings",
  "page_admin_ResourcesSection": "content",
  "page_admin_ResourceManagement": "content.resource-management",
  "page_admin_TagManagement": "content.tags",
  "page_admin_FileManagement": "content.files",
  "page_admin_JobBoardSection": "jobs",
  "page_admin_JobPostingManagement": "jobs.job-management",
  "page_admin_JobBoardSettings": "jobs.job-settings",
  "page_admin_PageBuilder": "site-builder",
  "page_admin_IEditPageManagement": "site-builder.pages",
  "page_admin_IEditTemplateManagement": "site-builder.templates",
  "page_admin_PageBannerManagement": "site-builder.banners",
  "page_admin_NavigationManagement": "site-builder.navigation",
  "page_admin_ButtonElements": "site-builder.buttons",
  "page_admin_ButtonStyleManagement": "site-builder.button-styles",
  "page_admin_WallOfFameManagement": "site-builder.wall-of-fame",
  "page_admin_InstalledFonts": "site-builder.fonts",
  "page_admin_FormsSection": "forms",
  "page_admin_FormManagement": "forms.form-management",
  "page_admin_FormSubmissions": "forms.submissions",
  "page_admin_FloaterManagement": "site-builder.floaters",
  "page_admin_TeamInviteSettings": "system.team-invite",
  "page_admin_DataExport": "admin.data-export",
  "page_admin_SiteMap": "system.site-map",
  "page_admin_SupportManagement": "support.management",
  "page_admin_PortalNavigationManagement": "system.portal-navigation",
  "page_admin_PortalMenuManagement": "system.portal-menu",
  "page_admin_TourManagement": "system.tours",
  "page_admin_MemberGroupManagement": "membership.member-groups",
  "page_admin_ZoomWebinarProvisioning": "events.zoom-webinars",
  "page_admin_SpeakerManagement": "events.speakers",
  "page_admin_OrganisationPreferences": "organisation.field-permissions",
  "page_admin_MemberPreferences": "membership.member-field-permissions",
  "page_Dashboard": "system.dashboard",
  "page_EventDetails": "events.event-details",
  "page_ArticleEditor": "content.article-editor",
  "page_ArticleView": "content.articles",
  "page_NewsEditor": "content.news-editor",
  "page_NewsView": "content.news",
  "page_IEditPageEditor": "site-builder.page-editor",
  "page_GuestWriterManagement": "content.guest-writers",
  "page_OrganisationDirectorySettings": "membership.organisation-directory-settings",
  "element_EventsSearch": "events.browse-events.search-filters",
  "element_SelfRegistration": "events.event-details.self-registration",
  "element_AddColleaguesToEvents": "events.event-details.add-colleagues",
  "element_RegisterExternalAttendees": "events.event-details.register-external",
  "element_EventUseVouchers": "events.event-details.use-vouchers",
  "element_EventUseTrainingFund": "events.event-details.use-training-fund",
  "element_AvailableSeatsDisplay": "events.event-details.available-seats",
  "element_FloatersDisplay": "site-builder.floaters.display",
  "element_NewsTickerBar": "system.news-ticker.display",
  "element_ShowDisabledAccounts": "membership.member-directory.show-disabled",
  "element_TeamInviteMember": "membership.team.invite-member",
  "element_TeamLoginAccessToggle": "membership.team.login-access-toggle",
  "element_TeamEditMember": "membership.team.edit-member",
  "edit_professional_biography": "communication.preferences.edit-biography",
  "view_member_biography": "membership.member-directory.view-biography",
  "payment_training_vouchers": "commerce.buy-tickets.use-vouchers",
  "payment_training_fund": "commerce.buy-tickets.use-training-fund",
  "action_org_logo_edit": "membership.organisation-directory.edit-logo",
  "admin_can_edit_members": "admin.member-role-assignment.edit-members",
  "admin_can_manage_communications": "communication",
  "feature_PostJobOnBehalfOfOrg": "jobs.post-job.post-on-behalf",
  "page_PostJob": "jobs.post-job",
  "feature_PostJobsForOtherOrgs": "jobs.my-postings.post-for-others",
  "page_Events": "events.browse-events",
  "page_Bookings": "commerce.bookings",
  "page_MyTickets": "events.my-tickets",
  "page_BuyProgramTickets": "commerce.buy-tickets",
  "page_Balances": "commerce.balances",
  "page_History": "commerce.history",
  "page_Team": "membership.team",
  "page_MemberDirectory": "membership.member-directory",
  "page_OrganisationDirectory": "membership.organisation-directory",
  "page_MyOrganisation": "organisation.my-organisation",
  "page_Resources": "content.resources",
  "page_Articles": "content.articles",
  "page_ArticlesSection": "content",
  "page_JobBoard": "jobs.job-board",
  "page_MyJobPostings": "jobs.my-postings",
  "page_Preferences": "user.about-me",
  "page_Support": "support.help",
  "page_RoleManagement": "admin.role-management",
  "page_MemberRoleAssignment": "admin.member-role-assignment",
  "page_TeamMemberManagement": "admin.team-member-management",
  "page_MemberHandleManagement": "admin.member-handle-management",
  "page_MemberDirectorySettings": "membership.member-directory-settings",
  "page_DiscountCodeManagement": "events.discount-codes",
  "page_EventSettings": "events.event-settings",
  "page_TicketSalesAnalytics": "events.ticket-analytics",
  "page_AwardManagement": "membership.awards",
  "page_JobPostingManagement": "jobs.job-management",
  "page_JobBoardSettings": "jobs.job-settings",
  "page_PageBannerManagement": "site-builder.banners",
  "page_ButtonStyleManagement": "site-builder.button-styles",
  "page_WallOfFameManagement": "site-builder.wall-of-fame",
  "page_InstalledFonts": "site-builder.fonts",
  "page_FormManagement": "forms.form-management",
  "page_FormSubmissions": "forms.submissions",
  "page_FormSettings": "forms.settings",
  "page_FloaterManagement": "site-builder.floaters",
  "page_TeamInviteSettings": "system.team-invite",
  "page_TourManagement": "system.tours",
  "page_ZoomWebinarProvisioning": "events.zoom-webinars",
  "page_SpeakerManagement": "events.speakers",
  "page_ArticlesSettings": "content.articles-settings",
  "page_VoucherManagement": "commerce.voucher-management",
  "page_TrainingFundManagement": "commerce.training-fund-management",
  "page_MembersList": "crm.members",
  "page_OrganisationsList": "crm.organisations",
  "page_BorderRadiusSettings": "site-builder.border-radius",
  "page_TeamSettings": "system.team-settings",
  "page_PreferenceSettings": "communication.preference-settings",
  "page_FormBuilder": "forms.form-builder",
  "page_CustomFieldsAdmin": "admin.custom-fields",
  "page_EmailTemplateManagement": "communication.email-templates",
  "page_CommunicationsManagement": "communication.management",
  "page_DynamicDirectoryManagement": "admin.dynamic-directories",
  "page_MemberGroupGuestManagement": "membership.member-groups-guests",
  "page_PageVisibilitySettings": "system.page-visibility",
  "page_NewsAdmin": "content",
  "page_NewsSettings": "content.news-settings",
  "page_ArticlesAdmin": "content",
  "page_CategoryManagement": "content.categories",
  "page_FormsAdmin": "forms",
  "page_ResourcesAdmin": "content",
  "page_ResourceSettings": "content.resource-settings",
  "page_ResourceManagement": "content.resource-management",
  "page_TagManagement": "content.tags",
  "page_FileManagement": "content.files",
  "page_JobBoardAdmin": "jobs",
  "page_PageBuilder": "site-builder",
  "page_IEditPageManagement": "site-builder.pages",
  "page_IEditTemplateManagement": "site-builder.templates",
  "page_NavigationManagement": "site-builder.navigation",
  "page_ButtonElements": "site-builder.buttons",
  "page_DataExport": "admin.data-export",
  "page_SiteMap": "system.site-map",
  "page_PortalNavigationManagement": "system.portal-navigation",
  "action_article_edit": "content.articles.edit",
  "action_article_delete": "content.articles.delete",
  "page_SupportManagement": "support.management",
  "page_BookingAgentsManagement": "calendar.agents",
  "page_AboutMe": "user.about-me",
  "page_Preferences_new": "user.about-me",
  "communication.preferences": "user.about-me",
  "membership.my-organisation": "organisation.my-organisation",
  "membership.organisation-preferences": "organisation.field-permissions",
  "page_CRMOrganisations": "crm.organisations",
  "page_CRMMembers": "crm.members",
  "page_AdminSetup": "system.admin-setup",
  "page_admin_AdminSetup": "system.admin-setup",
  "page_RoleAccessConfigManagement": "system.role-access-config",
  "page_admin_RoleAccessConfigManagement": "system.role-access-config",
  "page_DueDiligenceDashboard": "forms.due-diligence-dashboard",
  "page_DueDiligenceConfig": "forms.due-diligence-config",
  "page_ReviewSubmission": "forms.review-submission",
  "page_admin_DueDiligenceDashboard": "forms.due-diligence-dashboard",
  "page_admin_DueDiligenceConfig": "forms.due-diligence-config",
  "page_admin_ReviewSubmission": "forms.review-submission",
  "page_ProjectBoards": "projects.boards",
  "page_ProjectBoard": "projects.board-view",
  "page_admin_ProjectBoards": "projects.boards",
  "page_admin_ProjectBoard": "projects.board-view"
};

export function migrateLegacyFeatureId(legacyId: string): string {
  return LEGACY_TO_NEW_MAPPING[legacyId] || legacyId;
}

export function migrateLegacyExcludedFeatures(legacyFeatures: string[]): string[] {
  if (!legacyFeatures || !Array.isArray(legacyFeatures)) return [];
  
  const newFeatures = new Set<string>();
  for (const legacy of legacyFeatures) {
    const mapped = LEGACY_TO_NEW_MAPPING[legacy];
    if (mapped) {
      newFeatures.add(mapped);
    }
  }
  return Array.from(newFeatures);
}
