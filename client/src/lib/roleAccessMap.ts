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
          { id: "events.browse-events.view-attendees", label: "View Attendees" },
          { id: "events.browse-events.toggle-drafts", label: "Toggle Draft Events Visibility" }
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
        id: "events.pending-purchase-orders",
        label: "Pending Purchase Orders Report"
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
        id: "events.sponsors",
        label: "Sponsor Management"
      },
      {
        id: "events.zoom-webinars",
        label: "Zoom Webinar Provisioning"
      },
      {
        id: "events.event-report",
        label: "Event Registration Report"
      },
      {
        id: "events.event-checkin",
        label: "Event Check-In"
      },
      {
        id: "events.event-budget-report",
        label: "Event Budget Report"
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
        id: "commerce.event-cancellations",
        label: "Cancellation Requests"
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
          { id: "commerce.balances.vouchers-list", label: "Vouchers List" },
          { id: "commerce.balances.buy-funds", label: "Buy Training Funds" },
          { id: "commerce.balances.availability", label: "Manage Fund & Voucher Role Restrictions" }
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
        id: "commerce.monthly-finance-report",
        label: "Monthly Finance Report"
      },
      {
        id: "commerce.gocardless-dd",
        label: "Direct Debit Console"
      },
      {
        id: "commerce.training-fund-management",
        label: "Training Fund Management"
      },
      {
        id: "commerce.membership",
        label: "Membership Fees",
        features: [
          { id: "commerce.membership.submit-po", label: "Submit Purchase Order" },
          { id: "commerce.membership.pay-online", label: "Pay Online (Stripe)" }
        ]
      },
      {
        id: "commerce.membership-setup",
        label: "Membership Tier Management"
      },
      {
        id: "commerce.membership-settings",
        label: "Membership Settings"
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
        id: "membership.member-group-settings",
        label: "Member Group Settings"
      },
      {
        id: "membership.member-group-access",
        label: "Member Groups (Self-Join)"
      },
      {
        id: "membership.member-group-email",
        label: "Group Email"
      },
      {
        id: "membership.member-group-projects",
        label: "Group Projects"
      },
      {
        id: "membership.member-group-events",
        label: "Group Events"
      },
      {
        id: "membership.member-group-assignment-report",
        label: "Member Group Assignment Report"
      },
      {
        id: "membership.member-groups-invite-report",
        label: "Member Group Invite Report"
      },
      {
        id: "membership.member-group-classification-report",
        label: "Group Classification Activity Report"
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
          { id: "content.articles.comments", label: "Comments Section" },
          { id: "content.articles.show-count", label: "Show View Count" }
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
          { id: "content.resource-settings", label: "Resource Settings" },
          { id: "content.resources.show-count", label: "Show View Count" }
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
      },
      {
        id: "content.briefs",
        label: "Article Briefs",
        features: [
          { id: "content.briefs.manage", label: "Create & Edit Briefs" },
          { id: "content.briefs.assign", label: "Assign Writer & Reviewer" },
          { id: "content.briefs.change-status", label: "Change Brief Status" },
          { id: "content.briefs.upload-draft", label: "Upload Draft Versions" },
          { id: "content.briefs.review-comments", label: "Add Review Comments" },
          { id: "content.briefs.delete", label: "Delete Briefs" }
        ]
      },
      {
        id: "content.brief-settings",
        label: "Brief Settings"
      },
      {
        id: "content.gallery",
        label: "Photo Galleries",
        features: [
          { id: "content.gallery.manage", label: "Create & Edit Galleries" },
          { id: "content.gallery.upload", label: "Upload Photos" },
          { id: "content.gallery.delete", label: "Delete Galleries & Photos" }
        ]
      }
    ]
  },
  {
    id: "publications",
    label: "Publications",
    icon: "BookOpen",
    pages: [
      {
        id: "publications.briefmanagement",
        label: "Brief Management"
      }
    ]
  },
  {
    id: "forum",
    label: "Forum",
    icon: "MessageSquare",
    pages: [
      {
        id: "forum.browse",
        label: "Browse Forums",
        features: [
          { id: "forum.browse.search", label: "Search Threads" }
        ]
      },
      {
        id: "forum.threads",
        label: "Threads & Posts",
        features: [
          { id: "forum.threads.create", label: "Create Threads" },
          { id: "forum.threads.reply", label: "Reply to Threads" },
          { id: "forum.threads.edit-own", label: "Edit Own Posts" },
          { id: "forum.threads.delete-own", label: "Delete Own Posts" },
          { id: "forum.threads.edit-any", label: "Edit Any Post" },
          { id: "forum.threads.delete-any", label: "Delete Any Post" },
          { id: "forum.threads.react", label: "React to Posts" },
          { id: "forum.threads.report", label: "Report Content" },
          { id: "forum.threads.upload-media", label: "Upload Media" }
        ]
      },
      {
        id: "forum.moderation",
        label: "Moderation",
        features: [
          { id: "forum.moderation.pin-threads", label: "Pin / Unpin Threads" },
          { id: "forum.moderation.lock-threads", label: "Lock / Unlock Threads" },
          { id: "forum.moderation.move-threads", label: "Move Threads" },
          { id: "forum.moderation.hide-posts", label: "Hide / Remove Posts" },
          { id: "forum.moderation.manage-reports", label: "Manage Reports" }
        ]
      },
      {
        id: "forum.management",
        label: "Forum Management",
        features: [
          { id: "forum.management.categories", label: "Manage Categories" },
          { id: "forum.management.moderation-log", label: "View Moderation Log" }
        ]
      }
    ]
  },
  {
    id: "fundraising",
    label: "Fundraising",
    icon: "CreditCard",
    pages: [
      {
        id: "fundraising.fundraising-management",
        label: "Fundraising Management"
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
      },
      {
        id: "jobs.volunteer-board",
        label: "Volunteer Board"
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
        id: "site-builder.ai-generate",
        label: "AI Design Studio — Generate"
      },
      {
        id: "site-builder.ai-approve",
        label: "AI Design Studio — Approve Changes"
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
        id: "site-builder.micro-sites",
        label: "Microsites"
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
      },
      {
        id: "admin.canvas-links-manager",
        label: "Canvas Links Manager"
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
      },
      {
        id: "forms.conversion-report",
        label: "Form Conversion Report"
      },
      {
        id: "forms.survey-reports",
        label: "Survey Reports",
        features: [
          { id: "forms.survey-reports.response-detail", label: "Response-Level Detail & Export" }
        ]
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
        id: "support.docs",
        label: "Help Center"
      },
      {
        id: "support.member-ai",
        label: "Member AI Assistant"
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
        id: "communication.inbox",
        label: "Inbox"
      },
      {
        id: "communication.email-templates",
        label: "Email Templates"
      },
      {
        id: "communication.email-placeholders",
        label: "Email Placeholders Reference"
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
        id: "admin.data-studio",
        label: "Data Studio",
        features: [
          {
            id: "data.custom-objects.manage-data-model",
            label: "Manage Data Model"
          }
        ]
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
      },
      {
        id: "admin.ai-reports",
        label: "AI Report Generator"
      },
      {
        id: "admin.accessibility-audits",
        label: "Accessibility Audits"
      },
      {
        id: "admin.ai-design-studio",
        label: "AI Design Studio"
      },
      {
        id: "admin.badges",
        label: "Badge Management"
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
        label: "Organisations",
        features: [
          { id: "crm.organisations.fund", label: "Training Fund" }
        ]
      },
      {
        id: "crm.organisation-groups",
        label: "Organisation Groups"
      },
      {
        id: "crm.members",
        label: "Members",
        features: [
          { id: "crm.members.password_reset", label: "Generate Password Reset Link" },
          { id: "crm.members.masquerade", label: "Masquerade as Member" }
        ]
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
        id: "system.lmic-countries",
        label: "LMIC Country List"
      },
      {
        id: "dashboard.view",
        label: "Dashboard Builder",
        features: [
          { id: "dashboard.shared-widgets.manage", label: "Manage Shared Widgets" },
          { id: "dashboard.personal-widgets.manage", label: "Manage Personal Widgets" }
        ]
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

// ---------------------------------------------------------------------------
// Map-driven parent resolution.
//
// Several resource ids are nested under a parent whose id does NOT match their
// dot-prefix (e.g. page "admin.canvas-links-manager" lives under module
// "site-builder", page "dashboard.view" and the dashboard.* widget features
// live under module "system"). Deriving parents by splitting on dots
// therefore disagrees with
// how exclusions are WRITTEN (which walks the real nested map). All parent
// lookups must come from the actual ROLE_ACCESS_MAP nesting; dot-prefix
// splitting is only a fallback for ids that are not present in the map.
// ---------------------------------------------------------------------------

export interface RoleAccessHierarchy {
  moduleIds: Set<string>;
  pageIds: Set<string>;
  featureIds: Set<string>;
  /** featureId -> containing page id */
  featureToPage: Map<string, string>;
  /** pageId or featureId -> containing module id */
  resourceToModule: Map<string, string>;
}

export function buildRoleAccessHierarchy(map: Module[]): RoleAccessHierarchy {
  const moduleIds = new Set<string>();
  const pageIds = new Set<string>();
  const featureIds = new Set<string>();
  const featureToPage = new Map<string, string>();
  const resourceToModule = new Map<string, string>();

  for (const module of map) {
    moduleIds.add(module.id);
    for (const page of module.pages) {
      pageIds.add(page.id);
      resourceToModule.set(page.id, module.id);
      if (page.features) {
        for (const feature of page.features) {
          featureIds.add(feature.id);
          featureToPage.set(feature.id, page.id);
          resourceToModule.set(feature.id, module.id);
        }
      }
    }
  }

  return { moduleIds, pageIds, featureIds, featureToPage, resourceToModule };
}

// Hierarchies are cached per map instance so callers can pass a DB-derived
// accessMap (e.g. the one Role Management renders) without rebuilding lookup
// tables on every call. Defaults to the hardcoded ROLE_ACCESS_MAP.
const hierarchyCache = new WeakMap<Module[], RoleAccessHierarchy>();
export function getRoleAccessHierarchy(map: Module[] = ROLE_ACCESS_MAP): RoleAccessHierarchy {
  let cached = hierarchyCache.get(map);
  if (!cached) {
    cached = buildRoleAccessHierarchy(map);
    hierarchyCache.set(map, cached);
  }
  return cached;
}

export function getModuleForResource(resourceId: string, accessMap?: Module[]): string | null {
  const h = getRoleAccessHierarchy(accessMap);
  if (h.moduleIds.has(resourceId)) return resourceId;
  const fromMap = h.resourceToModule.get(resourceId);
  if (fromMap) return fromMap;
  // Fallback for ids not present in the map (e.g. dynamic/legacy keys)
  const parts = resourceId.split('.');
  if (parts.length > 0) {
    return parts[0];
  }
  return null;
}

export function getPageForResource(resourceId: string, accessMap?: Module[]): string | null {
  const h = getRoleAccessHierarchy(accessMap);
  if (h.pageIds.has(resourceId)) return resourceId;
  const fromMap = h.featureToPage.get(resourceId);
  if (fromMap) return fromMap;
  if (h.moduleIds.has(resourceId)) return null;
  // Fallback for ids not present in the map (e.g. dynamic/legacy keys)
  const parts = resourceId.split('.');
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return null;
}

export function isModuleId(resourceId: string, accessMap?: Module[]): boolean {
  const h = getRoleAccessHierarchy(accessMap);
  if (h.moduleIds.has(resourceId)) return true;
  if (h.pageIds.has(resourceId) || h.featureIds.has(resourceId)) return false;
  return !resourceId.includes('.');
}

export function isPageId(resourceId: string, accessMap?: Module[]): boolean {
  const h = getRoleAccessHierarchy(accessMap);
  if (h.pageIds.has(resourceId)) return true;
  if (h.moduleIds.has(resourceId) || h.featureIds.has(resourceId)) return false;
  const parts = resourceId.split('.');
  return parts.length === 2;
}

export function isFeatureId(resourceId: string, accessMap?: Module[]): boolean {
  const h = getRoleAccessHierarchy(accessMap);
  if (h.featureIds.has(resourceId)) return true;
  if (h.moduleIds.has(resourceId) || h.pageIds.has(resourceId)) return false;
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
  "data": "admin.data-studio",
  "data.custom-objects": "admin.data-studio",
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
  "page_admin_PendingPurchaseOrdersReport": "events.pending-purchase-orders",
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
  "page_admin_MicrositeManagement": "site-builder.micro-sites",
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
  "page_MemberGroupManagement": "membership.member-groups",
  "page_admin_MemberGroupAssignmentReport": "membership.member-group-assignment-report",
  "page_MemberGroupAssignmentReport": "membership.member-group-assignment-report",
  "page_admin_MemberGroupInviteReport": "membership.member-groups-invite-report",
  "page_MemberGroupInviteReport": "membership.member-groups-invite-report",
  "page_MemberGroups": "membership.member-group-access",
  "page_GroupEmail": "membership.member-group-email",
  "page_admin_ZoomWebinarProvisioning": "events.zoom-webinars",
  "page_admin_SpeakerManagement": "events.speakers",
  "page_admin_SponsorManagement": "events.sponsors",
  "page_EventRegistrationReport": "events.event-report",
  "page_admin_EventRegistrationReport": "events.event-report",
  "page_EventBudgetReport": "events.event-budget-report",
  "page_admin_EventBudgetReport": "events.event-budget-report",
  "page_SurveyReports": "forms.survey-reports",
  "page_user_SurveyReports": "forms.survey-reports",
  "page_admin_SurveyReports": "forms.survey-reports",
  "page_admin_OrganisationPreferences": "organisation.field-permissions",
  "page_admin_MemberPreferences": "membership.member-field-permissions",
  "page_Dashboard": "system.dashboard",
  "page_user_Dashboard": "system.dashboard",
  "page_admin_Dashboard": "system.dashboard",
  "page_ReportsDashboard": "dashboard.view",
  "page_admin_ReportsDashboard": "dashboard.view",
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
  "page_CancellationRequests": "commerce.event-cancellations",
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
  "page_PendingPurchaseOrdersReport": "events.pending-purchase-orders",
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
  "page_SponsorManagement": "events.sponsors",
  "page_ArticlesSettings": "content.articles-settings",
  "page_VoucherManagement": "commerce.voucher-management",
  "page_MemberGroupClassificationReport": "membership.member-group-classification-report",
  "page_admin_MemberGroupClassificationReport": "membership.member-group-classification-report",
  "page_MonthlyFinanceReport": "commerce.monthly-finance-report",
  "page_admin_MonthlyFinanceReport": "commerce.monthly-finance-report",
  "page_DirectDebitAdmin": "commerce.gocardless-dd",
  "page_admin_DirectDebitAdmin": "commerce.gocardless-dd",
  "page_MembershipFees": "commerce.membership",
  "page_MembershipTierManagement": "commerce.membership-setup",
  "page_MembershipSettings": "commerce.membership-settings",
  "page_TrainingFundManagement": "commerce.training-fund-management",
  "page_MembersList": "crm.members",
  "page_OrganisationsList": "crm.organisations",
  "page_BorderRadiusSettings": "site-builder.border-radius",
  "page_TeamSettings": "system.team-settings",
  "page_PreferenceSettings": "communication.preference-settings",
  "page_FormBuilder": "forms.form-builder",
  "page_CustomFieldsAdmin": "admin.custom-fields",
  "page_CustomObjectsAdmin": "admin.data-studio",
  "page_admin_CustomObjectsAdmin": "admin.data-studio",
  "page_EmailTemplateManagement": "communication.email-templates",
  "page_EmailPlaceholders": "communication.email-placeholders",
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
  "page_MicrositeManagement": "site-builder.micro-sites",
  "page_ButtonElements": "site-builder.buttons",
  "page_DataExport": "admin.data-export",
  "page_SiteMap": "system.site-map",
  "page_PortalNavigationManagement": "system.portal-navigation",
  "action_article_edit": "content.articles.edit",
  "action_article_delete": "content.articles.delete",
  "page_SupportManagement": "support.management",
  "page_Help": "support.docs",
  "page_BookingAgentsManagement": "calendar.agents",
  "page_AboutMe": "user.about-me",
  "page_Preferences_new": "user.about-me",
  "membership.my-organisation": "organisation.my-organisation",
  "membership.organisation-preferences": "organisation.field-permissions",
  "page_CRMOrganisations": "crm.organisations",
  "page_CRMMembers": "crm.members",
  "page_organisations": "crm.organisations",
  "page_members": "crm.members",
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
  "page_admin_ProjectBoard": "projects.board-view",
  "page_AIReports": "admin.ai-reports",
  "page_admin_AIReports": "admin.ai-reports",
  "page_AccessibilityAudits": "admin.accessibility-audits",
  "page_admin_AccessibilityAudits": "admin.accessibility-audits",
  "page_AiDesignStudio": "admin.ai-design-studio",
  "page_admin_AiDesignStudio": "admin.ai-design-studio",
  "page_EventCheckIn": "events.event-checkin",
  "page_EventCheckInDashboard": "events.event-checkin",
  "page_admin_EventCheckInDashboard": "events.event-checkin",
  "page_BriefManagement": "publications.briefmanagement",
  "page_BriefDetail": "content.briefs",
  "page_BriefSettings": "content.brief-settings",
  "page_admin_BriefManagement": "publications.briefmanagement",
  "page_user_BriefManagement": "publications.briefmanagement",
  "page_admin_BriefDetail": "content.briefs",
  "page_admin_BriefSettings": "content.brief-settings",
  "page_PhotoGalleries": "content.gallery",
  "page_admin_PhotoGalleries": "content.gallery",
  "page_admin_CanvasLinksManager": "admin.canvas-links-manager",
  "membership.volunteer-board": "jobs.volunteer-board"
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
