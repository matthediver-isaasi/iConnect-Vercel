const LEGACY_TO_NEW_MAPPING = {
  "page_user_BuyProgramTickets": "commerce.buy-tickets",
  "page_user_Events": "events.browse-events",
  "page_user_Bookings": "commerce.bookings",
  "page_user_MyTickets": "events.my-tickets",
  "page_user_Balances": "commerce.balances",
  "page_user_History": "commerce.history",
  "page_user_Team": "membership.team",
  "page_user_MemberDirectory": "membership.member-directory",
  "page_user_OrganisationDirectory": "membership.organisation-directory",
  "page_user_MyOrganisation": "membership.my-organisation",
  "page_user_Resources": "content.resources",
  "page_user_ArticlesSection": "content",
  "page_user_MyArticles": "content.my-articles",
  "page_user_Articles": "content.articles",
  "page_user_News": "content.news",
  "page_user_MyJobPostings": "jobs.my-postings",
  "page_user_Preferences": "communication.preferences",
  "page_user_Support": "support.help",
  "page_admin_NewsSection": "content",
  "page_admin_MyNews": "content.news-management",
  "page_admin_NewsSettings": "content.news-settings",
  "page_admin_ArticlesSection": "content",
  "page_admin_ArticleManagement": "content.article-management",
  "page_admin_ArticlesSettings": "content.articles-settings",
  "page_admin_RoleManagement": "admin.role-management",
  "page_admin_MemberRoleAssignment": "admin.member-role-assignment",
  "page_admin_TeamMemberManagement": "admin.team-member-management",
  "page_admin_MemberHandleManagement": "admin.member-handle-management",
  "page_admin_MemberDirectorySettings": "membership.member-directory-settings",
  "page_admin_DiscountCodeManagement": "events.discount-codes",
  "page_admin_EventSettings": "events.event-settings",
  "page_admin_TicketSalesAnalytics": "events.ticket-analytics",
  "page_admin_AwardManagement": "content.awards",
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
  "page_admin_OrganisationPreferences": "membership.organisation-preferences",
  "page_Dashboard": "system.dashboard",
  "page_EventDetails": "events.event-details",
  "page_ArticleEditor": "content.article-editor",
  "page_ArticleView": "content.articles",
  "page_NewsEditor": "content.news-editor",
  "page_NewsView": "content.news",
  "page_IEditPageEditor": "site-builder.page-editor",
  "page_GuestWriterManagement": "content.guest-writers",
  "page_OrganisationDirectorySettings": "membership.organisation-directory-settings",
  "element_EventDescription": "events.event-details.description",
  "element_EventsPageDescription": "events.browse-events.page-description",
  "element_EventsSearch": "events.browse-events.search-filters",
  "element_SelfRegistration": "events.event-details.self-registration",
  "element_AddColleaguesToEvents": "events.event-details.add-colleagues",
  "element_PurchaseButton": "events.event-details.purchase-button",
  "element_AvailableSeatsDisplay": "events.event-details.available-seats",
  "element_FloatersDisplay": "site-builder.floaters.display",
  "element_NewsTickerBar": "system.news-ticker.display",
  "element_ShowDisabledAccounts": "membership.member-directory.show-disabled",
  "edit_professional_biography": "communication.preferences.edit-biography",
  "view_member_biography": "membership.member-directory.view-biography",
  "payment_training_vouchers": "commerce.buy-tickets.use-vouchers",
  "payment_training_fund": "commerce.buy-tickets.use-training-fund",
  "action_news_edit": "content.news.edit",
  "action_news_delete": "content.news.delete",
  "action_org_logo_edit": "membership.organisation-directory.edit-logo",
  "admin_can_edit_members": "admin.member-role-assignment.edit-members",
  "admin_can_manage_communications": "communication",
  "feature_PostJobOnBehalfOfOrg": "jobs.my-postings.post-for-others",
  "page_Events": "events.browse-events",
  "page_Bookings": "commerce.bookings",
  "page_MyTickets": "events.my-tickets",
  "page_BuyProgramTickets": "commerce.buy-tickets",
  "page_Balances": "commerce.balances",
  "page_History": "commerce.history",
  "page_Team": "membership.team",
  "page_MemberDirectory": "membership.member-directory",
  "page_OrganisationDirectory": "membership.organisation-directory",
  "page_MyOrganisation": "membership.my-organisation",
  "page_Resources": "content.resources",
  "page_MyArticles": "content.my-articles",
  "page_Articles": "content.articles",
  "page_ArticlesSection": "content",
  "page_MyJobPostings": "jobs.my-postings",
  "page_Preferences": "communication.preferences",
  "page_Support": "support.help",
  "page_RoleManagement": "admin.role-management",
  "page_MemberRoleAssignment": "admin.member-role-assignment",
  "page_TeamMemberManagement": "admin.team-member-management",
  "page_MemberHandleManagement": "admin.member-handle-management",
  "page_MemberDirectorySettings": "membership.member-directory-settings",
  "page_DiscountCodeManagement": "events.discount-codes",
  "page_EventSettings": "events.event-settings",
  "page_TicketSalesAnalytics": "events.ticket-analytics",
  "page_AwardManagement": "content.awards",
  "page_JobPostingManagement": "jobs.job-management",
  "page_JobBoardSettings": "jobs.job-settings",
  "page_PageBannerManagement": "site-builder.banners",
  "page_ButtonStyleManagement": "site-builder.button-styles",
  "page_WallOfFameManagement": "site-builder.wall-of-fame",
  "page_InstalledFonts": "site-builder.fonts",
  "page_FormManagement": "forms.form-management",
  "page_FormSubmissions": "forms.submissions",
  "page_FloaterManagement": "site-builder.floaters",
  "page_TeamInviteSettings": "system.team-invite",
  "page_TourManagement": "system.tours",
  "page_ZoomWebinarProvisioning": "events.zoom-webinars",
  "page_SpeakerManagement": "events.speakers",
  "page_ArticleManagement": "content.article-management",
  "page_ArticlesSettings": "content.articles-settings",
  "page_VoucherManagement": "commerce.voucher-management",
  "page_TrainingFundManagement": "commerce.training-fund-management",
  "page_MembersList": "membership.members-list",
  "page_OrganisationsList": "membership.organisations-list",
  "page_BorderRadiusSettings": "site-builder.border-radius",
  "page_TeamSettings": "system.team-settings",
  "page_PreferenceSettings": "communication.preference-settings",
  "page_FormBuilder": "forms.form-builder",
  "page_CustomFieldsAdmin": "admin.custom-fields",
  "page_EmailTemplateManagement": "communication.email-templates",
  "page_DynamicDirectoryManagement": "admin.dynamic-directories",
  "page_MemberGroupGuestManagement": "membership.member-groups-guests",
  "page_PageVisibilitySettings": "system.page-visibility",
  "page_NewsAdmin": "content",
  "page_MyNews": "content.news-management",
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
  "page_PostJob": "jobs.my-postings"
};

function migrateLegacyFeatureId(legacyId) {
  return LEGACY_TO_NEW_MAPPING[legacyId] || legacyId;
}

function getModuleForResource(resourceId) {
  const parts = resourceId.split('.');
  if (parts.length > 0) {
    return parts[0];
  }
  return null;
}

function getPageForResource(resourceId) {
  const parts = resourceId.split('.');
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return null;
}

export function isResourceExcluded(excludedResources, resourceId) {
  if (!excludedResources || !Array.isArray(excludedResources) || excludedResources.length === 0) {
    return false;
  }

  const normalizedId = migrateLegacyFeatureId(resourceId);
  
  if (excludedResources.includes(normalizedId)) {
    return true;
  }

  const pageId = getPageForResource(normalizedId);
  if (pageId && excludedResources.includes(pageId)) {
    return true;
  }

  const moduleId = getModuleForResource(normalizedId);
  if (moduleId && excludedResources.includes(moduleId)) {
    return true;
  }

  return false;
}

export function isResourceVisible(excludedResources, resourceId) {
  return !isResourceExcluded(excludedResources, resourceId);
}
