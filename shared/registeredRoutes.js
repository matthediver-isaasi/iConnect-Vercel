import { PAGE_NAMES } from '../client/src/pages/pageRegistry.js';
import { BUILTIN_ARTICLE_ALIASES } from './articleAliases.js';
import { BUILTIN_MEMBER_ALIASES } from './memberAliases.js';

// Keep literal and generated routes in parity with pages/index.jsx (tested).
// Never include the DynamicPage or catch-all patterns here: they require data.
const extra = `
/ /ResetPassword /reset-password /auth/login /auth/reset-password
/MemberDemo /BnmsMemberDemo /galleries /GalleryDirectory /RoleAccessConfigManagement
/VoucherManagement /MonthlyFinanceReport /MembershipPaymentReport /DirectDebitAdmin
/TrainingFundManagement /MyBookings /CancellationRequests /booking-agents /SurveyReports
/CanvasPageEditor /MicrositeManagement /about-me /Preferences /BadgeManagement
/organisations /OrganisationGroups /DueDiligenceDashboard /DueDiligenceConfig
/ReviewSubmission /BriefManagement /BriefDetail /BriefSettings /ExternalWriters
/external-writers /PhotoGalleries /MemberGroupSettings /VolunteerBoard /GroupEmail
/GroupProjects /GroupEvents /CPDCertificateTemplates /MemberGroupClassificationReport
/EditEvent /MemberRoleReport /AIReports /AccessibilityAudits /CanvasLinksManager /ImportManager /Help
/AdminMemberEdit /PublicComplexEvents /ComplexEventDetail
/EventCheckIn /EventCheckInDashboard /DomainSettings /domain-settings /search
/signup /register /signup-verify /embed/alternative-signer /fundraiser/login
/fundraiser/dashboard /campaigns /email-preferences /CaseStudyUpload
/admin/login /admin/setup-password /admin/dashboard /admin/settings /admin/branding
/admin/lmic-countries /admin/domains /admin/team /admin/email-logs /admin/scheduled-tasks
/admin/integrations /admin/zoho-crm-sync /admin/onboarding /admin/plan-usage
/admin/ai-design-studio /admin /platform/setup /platform/login /platform/admin /platform
/sales /sales/dashboard /sales/pipeline /sales/opportunities /sales/opportunities/:id
/sales/quotes /sales/quotes/:id /sales/catalogue /sales/products /sales/bundles
/sales/tasks /sales/reports /sales/settings /sales/allocations/:allocationId
/events/:eventSlug /gallery/:slug /CampaignEdit/:id
/OrganisationDirectory/members/:organizationId /organisations/:id /OrganisationGroups/:id
/survey/:token /FormSubmission/:submissionId /news-preview/:id /article-preview/:id
/help/:slug /CPDCertificateTemplates/:templateId /CustomObjectsAdmin/:objectId
/CustomObjectsAdmin/:objectId/records /CustomObjectsAdmin/:objectId/records/new
/CustomObjectsAdmin/:objectId/records/:recordId /CustomObjectsAdmin/:objectId/records/:recordId/edit
/EmailCampaignEdit/:id /directory/:slug /directory/:slug/members/:organizationId
/ProjectBoard/:id /session-events/:eventSlug /embed/form/:slug /embed/resource/:identifier
/embed/event/:identifier /donate/:token /fundraise/:slug /membership-fees/:token
/submit-po/:token /quote/:token /group-booking/:token /guest-approval/:token
/group-role-invite/:token /team-invite/:token /dd-setup/:token /dd-migrate/:token /book/:slug
/membership/direct-debit/complete /membership/direct-debit/cancelled
/membership/monthly-card/complete /membership/monthly-card/cancelled
`.trim().split(/\s+/);

export const REGISTERED_ROUTES = [
  ...PAGE_NAMES.map(name => `/${name}`), ...extra,
  ...BUILTIN_MEMBER_ALIASES.flatMap(alias => [`/${alias}`, `/${alias}/:id`]),
  ...BUILTIN_ARTICLE_ALIASES.flatMap(alias => [
    `/${alias}/author/:authorHandle`, `/${alias}/:authorHandle/:articleSlug`,
  ]),
];

export function matchesRegisteredRoute(path) {
  const segments = path.toLowerCase().replace(/\/+$/, '').split('/');
  return REGISTERED_ROUTES.some(route => {
    const pattern = route.toLowerCase().replace(/\/+$/, '').split('/');
    return pattern.length === segments.length && pattern.every((part, i) =>
      part.startsWith(':') ? !!segments[i] : part === segments[i]);
  });
}