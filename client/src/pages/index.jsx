import Layout from "./Layout.jsx";
import { BUILTIN_ARTICLE_ALIASES } from "@shared/articleAliases.js";
import { BUILTIN_MEMBER_ALIASES } from "@shared/memberAliases.js";

import CatchAllNotFound from "./CatchAllNotFound";

import Events from "./Events";

import HomePageRedirect from "./HomePageRedirect";

import Home from "./Home";

import AdminSetup from "./AdminSetup";

import EventDetails from "./EventDetails";

import BuyProgramTickets from "./BuyProgramTickets";

// VerifyMagicLink removed - using password authentication instead
// TestLogin removed - no longer needed

import Login from "./Login";

import ResetPassword from "./ResetPassword";

import Balances from "./Balances";

import Dashboard from "./Dashboard";

import UnpackedInternationalEmployability from "./UnpackedInternationalEmployability";

import Articles from "./Articles";

import ArticleEditor from "./ArticleEditor";

import ArticleView from "./ArticleView";

import GalleryView from "./GalleryView";

import PublicAbout from "./PublicAbout";

import PublicContact from "./PublicContact";

import PublicEvents from "./PublicEvents";

import RoleManagement from "./RoleManagement";

import RoleAccessConfigManagement from "./RoleAccessConfigManagement";

import MemberRoleAssignment from "./MemberRoleAssignment";

import TeamMemberManagement from "./TeamMemberManagement";

import DiscountCodeManagement from "./DiscountCodeManagement";

import VoucherManagement from "./VoucherManagement";

import MonthlyFinanceReport from "./MonthlyFinanceReport";

import DirectDebitAdmin from "./DirectDebitAdmin";

import TrainingFundManagement from "./TrainingFundManagement";

import WorkflowManagement from "./WorkflowManagement";

import EmailTemplateManagement from "./EmailTemplateManagement";

import EmailPlaceholders from "./EmailPlaceholders";

import MyTickets from "./MyTickets";

import EventSettings from "./EventSettings";

import Bookings from "./Bookings";

import CancellationRequests from "./CancellationRequests";

import BookingAgentsManagement from "./BookingAgentsManagement";

import TourManagement from "./TourManagement";

import History from "./History";

import TicketSalesAnalytics from "./TicketSalesAnalytics";

import PendingPurchaseOrdersReport from "./PendingPurchaseOrdersReport";

import Resources from "./Resources";

import PublicResources from "./PublicResources";

import ResourceSettings from "./ResourceSettings";

import ResourceManagement from "./ResourceManagement";

import FileManagement from "./FileManagement";

import TagManagement from "./TagManagement";

import JobBoard from "./JobBoard";

import JobDetails from "./JobDetails";

import PostJob from "./PostJob";

import JobPostSuccess from "./JobPostSuccess";

import DirectDebitReturn from "./DirectDebitReturn";

import JobBoardSettings from "./JobBoardSettings";

import JobPostingManagement from "./JobPostingManagement";

import MyJobPostings from "./MyJobPostings";

import PageBannerManagement from "./PageBannerManagement";

import IEditPageManagement from "./IEditPageManagement";

import IEditTemplateManagement from "./IEditTemplateManagement";

import IEditPageEditor from "./IEditPageEditor";

import CanvasPageEditor from "./CanvasPageEditor";

import testpage from "./testpage";

import NavigationManagement from "./NavigationManagement";

import Preferences from "./Preferences";

import EmailPreferences from "./EmailPreferences";

import PublicArticles from "./PublicArticles";

import MemberHandleManagement from "./MemberHandleManagement";

import ButtonElements from "./ButtonElements";

import ButtonStyleManagement from "./ButtonStyleManagement";

import BorderRadiusSettings from "./BorderRadiusSettings";

import AwardManagement from "./AwardManagement";

import BadgeManagement from "./BadgeManagement";

import Team from "./Team";

import MemberDirectory from "./MemberDirectory";

import WallOfFameManagement from "./WallOfFameManagement";

import DynamicPage from "./DynamicPage";

import sharon from "./sharon";

import content from "./content";

import icontent from "./icontent";

import ViewPage from "./ViewPage";

import ParamTest from "./ParamTest";

import TeamInviteSettings from "./TeamInviteSettings";

import OrganisationDirectory from "./OrganisationDirectory";

import OrganisationsList from "./OrganisationsList";

import OrganisationGroups from "./OrganisationGroups";

import MembersList from "./MembersList";
import MemberDetail from "./MemberDetail";

import FloaterManagement from "./FloaterManagement";

import FormManagement from "./FormManagement";

import FormBuilder from "./FormBuilder";

import FormView from "./FormView";

import EmbedForm from "./EmbedForm";
import CaseStudyUpload from "./CaseStudyUpload";

import EmbedResource from "./EmbedResource";

import EmbedEvent from "./EmbedEvent";

import EmbedAlternativeSigner from "./EmbedAlternativeSigner";

import PublicBooking from "./PublicBooking";

import MyBookings from "./MyBookings";

import MemberDirectorySettings from "./MemberDirectorySettings";

import FormSubmissions from "./FormSubmissions";

import FormSubmissionView from "./FormSubmissionView";

import FormSettings from "./FormSettings";

import NewsEditor from "./NewsEditor";

import NewsView from "./NewsView";

import News from "./News";

import PublicNews from "./PublicNews";

import NewsSettings from "./NewsSettings";

import NewsPreview from "./NewsPreview";

import ArticlePreview from "./ArticlePreview";

import DataExport from "./DataExport";

import ImportManager from "./ImportManager";

import SiteMap from "./SiteMap";

import Support from "./Support";
import Help from "./Help";
import HelpArticleView from "./HelpArticleView";

import SupportManagement from "./SupportManagement";

import PortalNavigationManagement from "./PortalNavigationManagement";

import CategoryManagement from "./CategoryManagement";

import MemberGroupManagement from "./MemberGroupManagement";
import MemberGroupSettings from "./MemberGroupSettings";

import MemberGroups from "./MemberGroups";

import MemberGroupDetail from "./MemberGroupDetail";

import VolunteerBoard from "./VolunteerBoard";

import GroupEmail from "./GroupEmail";

import GroupProjects from "./GroupProjects";

import GroupEvents from "./GroupEvents";

import ArticlesSettings from "./ArticlesSettings";

import GuestWriterManagement from "./GuestWriterManagement";
import SpeakerManagement from "./SpeakerManagement";
import SponsorManagement from "./SponsorManagement";

import CardDeckManagement from "./CardDeckManagement";

import OrganisationDirectorySettings from "./OrganisationDirectorySettings";

import InstalledFonts from "./InstalledFonts";

import PortalMenuManagement from "./PortalMenuManagement";

import MemberGroupAssignmentReport from "./MemberGroupAssignmentReport";

import MemberGroupInviteReport from "./MemberGroupInviteReport";

import MemberGroupClassificationReport from "./MemberGroupClassificationReport";

import TeamEngagementReport from "./TeamEngagementReport";

import MemberGroupGuestManagement from "./MemberGroupGuestManagement";

import TeamSettings from "./TeamSettings";

import PreferenceSettings from "./PreferenceSettings";

import CustomFieldsAdmin from "./CustomFieldsAdmin";

import ZoomWebinarProvisioning from "./ZoomWebinarProvisioning";

import CreateEvent from "./CreateEvent";

import EditEvent from "./EditEvent";

import PageVisibilitySettings from "./PageVisibilitySettings";

import CommunicationsManagement from "./CommunicationsManagement";

import EmailCampaignEdit from "./EmailCampaignEdit";

import AdminMemberEdit from "./AdminMemberEdit";

import MyOrganisation from "./MyOrganisation";

import OrganisationPreferences from "./OrganisationPreferences";

import MemberPreferences from "./MemberPreferences";

import MemberRoleReport from "./MemberRoleReport";

import DynamicDirectoryManagement from "./DynamicDirectoryManagement";

import DynamicDirectoryView from "./DynamicDirectoryView";

import RedirectManagement from "./RedirectManagement";

import ProjectBoards from "./ProjectBoards";

import ProjectBoard from "./ProjectBoard";

import ReportsDashboard from "./ReportsDashboard";

import AIReports from "./AIReports";
import AccessibilityAudits from "./AccessibilityAudits";
import CanvasLinksManager from "./CanvasLinksManager";
import EventCheckIn from "./EventCheckIn";
import EventCheckInDashboard from "./EventCheckInDashboard";

import EventRegistrationReport from "./EventRegistrationReport";

import EventBudgetReport from "./EventBudgetReport";

import FormConversionReport from "./FormConversionReport";
import SurveyReports from "./SurveyReports";

import OrganisationEngagementReport from "./OrganisationEngagementReport";

import MembershipTierManagement from "./MembershipTierManagement";

import MembershipSettings from "./MembershipSettings";

import SearchResults from "./SearchResults";

import Forum from "./Forum";

import Inbox from "./Inbox";

import ForumThread from "./ForumThread";

import ForumManagement from "./ForumManagement";

import FundraisingManagement from "./FundraisingManagement";

import CampaignEdit from "./CampaignEdit";

import DonatePage from "./DonatePage";

import CampaignRegisterPage from "./CampaignRegisterPage";

import FundraiserLoginPage from "./FundraiserLoginPage";

import FundraiserDashboardPage from "./FundraiserDashboardPage";

import CampaignsPage from "./CampaignsPage";

import MembershipFeePage from "./MembershipFeePage";
import SubmitPOPage from "./SubmitPOPage";
import GroupBookingPage from "./GroupBookingPage";
import GuestApprovalPage from "./GuestApprovalPage";
import MemberGroupRoleInvitePage from "./MemberGroupRoleInvitePage";
import TeamInvitePage from "./TeamInvitePage";
import DirectDebitInvitationPage from "./DirectDebitInvitationPage";
import DirectDebitMigrationPage from "./DirectDebitMigrationPage";

import MembershipFees from "./MembershipFees";

import CreateComplexEvent from "./CreateComplexEvent";
import PublicComplexEvents from "./PublicComplexEvents";
import ComplexEventDetail from "./ComplexEventDetail";

import TenantSignup from "./TenantSignup";
import SignupVerify from "./SignupVerify";

import DomainSettings from "./DomainSettings";

import AdminLogin from "./admin/AdminLogin";
import AdminDashboard from "./admin/AdminDashboard";
import AdminSettings from "./admin/AdminSettings";
import OnboardingWizard from "./admin/OnboardingWizard";
import PlanUsage from "./admin/PlanUsage";
import AiDesignStudio from "./admin/AiDesignStudio";
import AdminBranding from "./admin/AdminBranding";
import MicrositeManagement from "./MicrositeManagement";
import AdminLmicCountries from "./admin/AdminLmicCountries";
import AdminDomains from "./admin/AdminDomains";
import AdminTeam from "./admin/AdminTeam";
import AdminEmailLogs from "./admin/AdminEmailLogs";
import AdminScheduledTasks from "./admin/AdminScheduledTasks";
import AdminIntegrations from "./admin/AdminIntegrations";
import AdminZohoCrmSync from "./admin/AdminZohoCrmSync";
import SaasLanding from "./admin/SaasLanding";

import PlatformLogin from "./platform/PlatformLogin";
import PlatformAdmin from "./platform/PlatformAdmin";
import PlatformSetup from "./platform/PlatformSetup";

import DueDiligenceDashboard from "./DueDiligenceDashboard";
import DueDiligenceConfig from "./DueDiligenceConfig";
import ReviewSubmission from "./ReviewSubmission";
import DueDiligenceReports from "./DueDiligenceReports";

import BriefManagement from "./BriefManagement";
import BriefDetail from "./BriefDetail";
import BriefSettings from "./BriefSettings";
import ExternalWriters from "./ExternalWriters";

import MemberDemo from "./MemberDemo";

import BnmsMemberDemo from "./BnmsMemberDemo";

import PhotoGalleries from "./PhotoGalleries";

import { useEffect, useRef, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { LayoutProvider } from '@/contexts/LayoutContext';
import { MicrositeProvider } from '@/contexts/MicrositeContext';
import PlanQuotaDialog from '@/components/PlanQuotaDialog';
import { ArticleUrlProvider } from '@/contexts/ArticleUrlContext';
import { MemberTerminologyProvider } from '@/contexts/MemberTerminologyContext';
import { DynamicMemberRedirector } from '@/components/routing/DynamicMemberRedirector';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
const CanvasPageRenderer = lazy(() => import('@/components/canvas/CanvasPageRenderer'));

function SmartLoginRoute() {
    const { data, isLoading } = useQuery({
        queryKey: ['public-canvas-login-page'],
        queryFn: () => publicClient.getPage('login'),
        staleTime: 60_000,
        retry: false,
    });
    if (isLoading) return null;
    const page = data?.page;
    const blocks = (page?.canvas_design?.root?.sections || []).flatMap(s => s.children || []);
    const hasLoginBlock = blocks.some(b => b.type === 'login-form');
    if (page?.builder_type === 'canvas' && page?.status === 'published' && hasLoginBlock) {
        return (
            <Suspense fallback={null}>
                <CanvasPageRenderer page={page} symbols={data?.symbols} />
            </Suspense>
        );
    }
    return <Login />;
}

// ScrollToTop component - scrolls to top on pathname changes, preserves anchor navigation
function ScrollToTop() {
    const { pathname, hash } = useLocation();
    const prevPathname = useRef(pathname);
    
    useEffect(() => {
        // Only scroll to top when pathname changes (not hash changes)
        // And only if there's no hash (anchor) in the URL
        if (prevPathname.current !== pathname) {
            if (!hash) {
                window.scrollTo({ top: 0, behavior: 'instant' });
            }
            prevPathname.current = pathname;
        }
    }, [pathname, hash]);
    
    return null;
}

const PAGES = {
    
    Events: Events,
    
    Home: Home,
    
    AdminSetup: AdminSetup,
    
    EventDetails: EventDetails,
    
    BuyProgramTickets: BuyProgramTickets,
    
    // VerifyMagicLink removed - using password authentication
    // TestLogin removed - no longer needed
    
    Login: Login,
    
    Signup: TenantSignup,
    
    DomainSettings: DomainSettings,
    
    ResetPassword: ResetPassword,
    
    Balances: Balances,
    
    Dashboard: Dashboard,
    
    UnpackedInternationalEmployability: UnpackedInternationalEmployability,
    
    Articles: Articles,
    
    ArticleEditor: ArticleEditor,
    
    ArticleView: ArticleView,
    
    GalleryView: GalleryView,
    
    PublicAbout: PublicAbout,
    
    PublicContact: PublicContact,
    
    PublicEvents: PublicEvents,
    
    RoleManagement: RoleManagement,
    
    RoleAccessConfigManagement: RoleAccessConfigManagement,
    
    MemberRoleAssignment: MemberRoleAssignment,
    
    TeamMemberManagement: TeamMemberManagement,
    
    DiscountCodeManagement: DiscountCodeManagement,
    
    VoucherManagement: VoucherManagement,
    
    MonthlyFinanceReport: MonthlyFinanceReport,
    
    DirectDebitAdmin: DirectDebitAdmin,
    
    TrainingFundManagement: TrainingFundManagement,
    
    WorkflowManagement: WorkflowManagement,
    
    EmailTemplateManagement: EmailTemplateManagement,
    
    EmailPlaceholders: EmailPlaceholders,
    
    MyTickets: MyTickets,
    
    EventSettings: EventSettings,
    
    Bookings: Bookings,
    
    CancellationRequests: CancellationRequests,
    
    BookingAgentsManagement: BookingAgentsManagement,
    
    TourManagement: TourManagement,
    
    History: History,
    
    TicketSalesAnalytics: TicketSalesAnalytics,
    PendingPurchaseOrdersReport: PendingPurchaseOrdersReport,
    EventRegistrationReport: EventRegistrationReport,
    EventBudgetReport: EventBudgetReport,
    FormConversionReport: FormConversionReport,
    SurveyReports: SurveyReports,
    OrganisationEngagementReport: OrganisationEngagementReport,
    MembershipTierManagement: MembershipTierManagement,
    MembershipSettings: MembershipSettings,
    MembershipFees: MembershipFees,
    FundraisingManagement: FundraisingManagement,
    CampaignEdit: CampaignEdit,
    
    Resources: Resources,
    
    PublicResources: PublicResources,
    
    ResourceSettings: ResourceSettings,
    
    ResourceManagement: ResourceManagement,
    
    FileManagement: FileManagement,
    
    TagManagement: TagManagement,
    
    JobBoard: JobBoard,
    
    JobDetails: JobDetails,
    
    PostJob: PostJob,
    
    JobPostSuccess: JobPostSuccess,
    
    DirectDebitReturn: DirectDebitReturn,
    
    JobBoardSettings: JobBoardSettings,
    
    JobPostingManagement: JobPostingManagement,
    
    MyJobPostings: MyJobPostings,
    
    PageBannerManagement: PageBannerManagement,
    
    IEditPageManagement: IEditPageManagement,
    
    IEditTemplateManagement: IEditTemplateManagement,
    
    IEditPageEditor: IEditPageEditor,
    
    CanvasPageEditor: CanvasPageEditor,
    
    testpage: testpage,
    
    NavigationManagement: NavigationManagement,
    
    MicrositeManagement: MicrositeManagement,
    
    Preferences: Preferences,
    
    AboutMe: Preferences,
    
    'about-me': Preferences,
    
    PublicArticles: PublicArticles,
    
    MemberHandleManagement: MemberHandleManagement,
    
    ButtonElements: ButtonElements,
    
    ButtonStyleManagement: ButtonStyleManagement,
    
    BorderRadiusSettings: BorderRadiusSettings,
    
    AwardManagement: AwardManagement,
    
    BadgeManagement: BadgeManagement,
    
    Team: Team,
    
    MemberDirectory: MemberDirectory,
    
    WallOfFameManagement: WallOfFameManagement,
    
    DynamicPage: DynamicPage,
    
    sharon: sharon,
    
    content: content,
    
    icontent: icontent,
    
    ViewPage: ViewPage,
    
    ParamTest: ParamTest,
    
    TeamInviteSettings: TeamInviteSettings,
    
    OrganisationDirectory: OrganisationDirectory,
    
    OrganisationsList: OrganisationsList,
    OrganisationGroups: OrganisationGroups,
    MembersList: MembersList,
    MemberDetail: MemberDetail,
    
    FloaterManagement: FloaterManagement,
    
    FormManagement: FormManagement,
    
    FormBuilder: FormBuilder,
    
    FormView: FormView,
    
    MemberDirectorySettings: MemberDirectorySettings,
    
    FormSubmissions: FormSubmissions,
    
    FormSubmissionView: FormSubmissionView,
    
    FormSettings: FormSettings,
    
    NewsEditor: NewsEditor,
    
    NewsView: NewsView,
    
    News: News,
    
    PublicNews: PublicNews,
    
    NewsSettings: NewsSettings,

    NewsPreview: NewsPreview,
    
    ArticlePreview: ArticlePreview,
    
    DataExport: DataExport,
    ImportManager: ImportManager,
    
    SiteMap: SiteMap,
    
    Support: Support,
    Help: Help,
    HelpArticleView: HelpArticleView,
    
    SupportManagement: SupportManagement,
    
    PortalNavigationManagement: PortalNavigationManagement,
    
    CategoryManagement: CategoryManagement,
    
    MemberGroupManagement: MemberGroupManagement,
    
    MemberGroupSettings: MemberGroupSettings,
    
    MemberGroups: MemberGroups,
    
    MemberGroupDetail: MemberGroupDetail,
    
    VolunteerBoard: VolunteerBoard,
    
    GroupEmail: GroupEmail,
    
    GroupProjects: GroupProjects,
    
    GroupEvents: GroupEvents,
    
    ArticlesSettings: ArticlesSettings,
    
    GuestWriterManagement: GuestWriterManagement,
    
    SpeakerManagement: SpeakerManagement,
    SponsorManagement: SponsorManagement,
    
    CardDeckManagement: CardDeckManagement,
    
    OrganisationDirectorySettings: OrganisationDirectorySettings,
    
    InstalledFonts: InstalledFonts,
    
    PortalMenuManagement: PortalMenuManagement,
    
    MemberGroupAssignmentReport: MemberGroupAssignmentReport,
    
    MemberGroupInviteReport: MemberGroupInviteReport,
    
    MemberGroupClassificationReport: MemberGroupClassificationReport,
    
    TeamEngagementReport: TeamEngagementReport,
    
    MemberGroupGuestManagement: MemberGroupGuestManagement,
    
    TeamSettings: TeamSettings,
    
    PreferenceSettings: PreferenceSettings,
    
    CustomFieldsAdmin: CustomFieldsAdmin,
    
    ZoomWebinarProvisioning: ZoomWebinarProvisioning,
    
    CreateEvent: CreateEvent,
    
    EditEvent: EditEvent,
    
    PageVisibilitySettings: PageVisibilitySettings,
    
    CommunicationsManagement: CommunicationsManagement,
    
    EmailCampaignEdit: EmailCampaignEdit,
    
    AdminMemberEdit: AdminMemberEdit,
    
    MyOrganisation: MyOrganisation,
    
    MemberRoleReport: MemberRoleReport,
    
    DynamicDirectoryManagement: DynamicDirectoryManagement,
    
    DynamicDirectoryView: DynamicDirectoryView,
    
    SearchResults: SearchResults,
    Search: SearchResults,
    search: SearchResults,
    
    DueDiligenceDashboard: DueDiligenceDashboard,
    DueDiligenceConfig: DueDiligenceConfig,
    ReviewSubmission: ReviewSubmission,
    
    BriefManagement: BriefManagement,
    BriefDetail: BriefDetail,
    BriefSettings: BriefSettings,
    ExternalWriters: ExternalWriters,

    MemberDemo: MemberDemo,

    BnmsMemberDemo: BnmsMemberDemo,

    PhotoGalleries: PhotoGalleries,
    
    Forum: Forum,
    Inbox: Inbox,
    ForumThread: ForumThread,
    ForumManagement: ForumManagement,
    
    AIReports: AIReports,
    AccessibilityAudits: AccessibilityAudits,
    CanvasLinksManager: CanvasLinksManager,
    EventCheckIn: EventCheckIn,
    EventCheckInDashboard: EventCheckInDashboard,
    
    CreateComplexEvent: CreateComplexEvent,
    PublicComplexEvents: PublicComplexEvents,
    ComplexEventDetail: ComplexEventDetail,
}

function _getCurrentPage(url) {
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }
    
    // Handle parameterized routes like /members/:id (and member-list aliases)
    const urlParts = url.split('/').filter(Boolean);
    if (urlParts.length >= 2 && BUILTIN_MEMBER_ALIASES.includes(urlParts[0].toLowerCase())) {
        return 'MemberDetail';
    }
    if (urlParts.length === 1 && urlParts[0].toLowerCase() !== 'members' && BUILTIN_MEMBER_ALIASES.includes(urlParts[0].toLowerCase())) {
        return 'MembersList';
    }
    
    if (urlParts.length >= 2 && urlParts[0].toLowerCase() === 'events') {
        return 'EventDetails';
    }
    
    if (urlParts.length >= 2 && urlParts[0].toLowerCase() === 'session-events') {
        return 'ComplexEventDetail';
    }
    
    // Task #3331: survey opened via an event-assignment link. Rendered by
    // FormView (already a hybrid page), so classify it as such.
    if (urlParts.length >= 2 && urlParts[0].toLowerCase() === 'survey') {
        return 'FormView';
    }

    if (urlParts.length >= 2 && urlParts[0].toLowerCase() === 'gallery') {
        return 'GalleryView';
    }
    
    if (urlParts.length >= 2 && urlParts[0].toLowerCase() === 'help') {
        return 'HelpArticleView';
    }
    
    if (urlParts.length >= 2 && urlParts[0].toLowerCase() === 'membership' && urlParts[1].toLowerCase() === 'direct-debit') {
        return 'DirectDebitReturn';
    }
    
    let urlLastPart = url.split('/').pop();
    if (urlLastPart.includes('?')) {
        urlLastPart = urlLastPart.split('?')[0];
    }
    
    // Handle root path - use HomePageRedirect (which is a hybrid page)
    if (!urlLastPart || urlLastPart === '') {
        return 'HomePageRedirect';
    }

    const pageName = Object.keys(PAGES).find(page => page.toLowerCase() === urlLastPart.toLowerCase());
    // Return "_DynamicPage" for unrecognized routes (CMS pages like /homely)
    // This allows Layout to treat them as hybrid pages that handle their own auth
    return pageName || "_DynamicPage";
}

// Task #3331: /survey/:token — a survey opened via its event-assignment
// link. FormView resolves everything server-side from the token.
function SurveyAssignmentRoute() {
    const { token } = useParams();
    return <FormView assignmentToken={token} />;
}

// Create a wrapper component that uses useLocation inside the Router context
function PagesContent() {
    const location = useLocation();
    const currentPage = _getCurrentPage(location.pathname);
    
    return (
        <>
            <ScrollToTop />
            <Layout currentPageName={currentPage}>
                <Routes>            
                
                    <Route path="/" element={<HomePageRedirect />} />
                
                
                <Route path="/Events" element={<Events />} />
                
                <Route path="/Home" element={<HomePageRedirect />} />
                <Route path="/home" element={<HomePageRedirect />} />
                
                <Route path="/AdminSetup" element={<AdminSetup />} />
                
                <Route path="/EventDetails" element={<EventDetails />} />
                <Route path="/events/:eventSlug" element={<EventDetails />} />
                
                <Route path="/BuyProgramTickets" element={<BuyProgramTickets />} />
                
                {/* VerifyMagicLink route removed - using password auth */}
                {/* TestLogin routes removed - no longer needed */}
                
                <Route path="/Login" element={<SmartLoginRoute />} />
                <Route path="/login" element={<SmartLoginRoute />} />
                <Route path="/auth/login" element={<SmartLoginRoute />} />
                
{/* Signup routes moved outside Layout - see StandaloneRoutes */}
                
                <Route path="/ResetPassword" element={<ResetPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/auth/reset-password" element={<ResetPassword />} />
                
                <Route path="/Balances" element={<Balances />} />
                
                <Route path="/Dashboard" element={<Dashboard />} />
                
                <Route path="/MemberDemo" element={<MemberDemo />} />
                
                <Route path="/BnmsMemberDemo" element={<BnmsMemberDemo />} />
                
                <Route path="/UnpackedInternationalEmployability" element={<UnpackedInternationalEmployability />} />
                
                <Route path="/Articles" element={<Articles />} />
                {/* Author listing routes for every article alias - see @shared/articleAliases.js */}
                {BUILTIN_ARTICLE_ALIASES.map((alias) => (
                  <Route key={`${alias}-author`} path={`/${alias}/author/:authorHandle`} element={<Articles />} />
                ))}
                
                <Route path="/ArticleEditor" element={<ArticleEditor />} />
                <Route path="/articleeditor" element={<ArticleEditor />} />
                
                <Route path="/ArticleView" element={<ArticleView />} />
                <Route path="/gallery/:slug" element={<GalleryView />} />
                
                <Route path="/PublicAbout" element={<PublicAbout />} />
                
                <Route path="/PublicContact" element={<PublicContact />} />
                
                <Route path="/PublicEvents" element={<PublicEvents />} />
                
                <Route path="/RoleManagement" element={<RoleManagement />} />
                
                <Route path="/RoleAccessConfigManagement" element={<RoleAccessConfigManagement />} />
                
                <Route path="/MemberRoleAssignment" element={<MemberRoleAssignment />} />
                
                <Route path="/TeamMemberManagement" element={<TeamMemberManagement />} />
                
                <Route path="/DiscountCodeManagement" element={<DiscountCodeManagement />} />
                
                <Route path="/VoucherManagement" element={<VoucherManagement />} />
                
                <Route path="/MonthlyFinanceReport" element={<MonthlyFinanceReport />} />
                
                <Route path="/DirectDebitAdmin" element={<DirectDebitAdmin />} />
                
                <Route path="/TrainingFundManagement" element={<TrainingFundManagement />} />
                
                <Route path="/WorkflowManagement" element={<WorkflowManagement />} />
                
                <Route path="/EmailTemplateManagement" element={<EmailTemplateManagement />} />
                
                <Route path="/EmailPlaceholders" element={<EmailPlaceholders />} />
                <Route path="/emailplaceholders" element={<EmailPlaceholders />} />
                
                <Route path="/MyTickets" element={<MyTickets />} />
                
                <Route path="/MyBookings" element={<MyBookings />} />
                
                <Route path="/EventSettings" element={<EventSettings />} />
                
                <Route path="/Bookings" element={<Bookings />} />
                
                <Route path="/CancellationRequests" element={<CancellationRequests />} />
                
                <Route path="/booking-agents" element={<BookingAgentsManagement />} />
                
                <Route path="/TourManagement" element={<TourManagement />} />
                
                <Route path="/History" element={<History />} />
                
                <Route path="/TicketSalesAnalytics" element={<TicketSalesAnalytics />} />
                <Route path="/PendingPurchaseOrdersReport" element={<PendingPurchaseOrdersReport />} />
                <Route path="/EventRegistrationReport" element={<EventRegistrationReport />} />
                <Route path="/EventBudgetReport" element={<EventBudgetReport />} />
                <Route path="/FormConversionReport" element={<FormConversionReport />} />
                <Route path="/SurveyReports" element={<SurveyReports />} />
                <Route path="/OrganisationEngagementReport" element={<OrganisationEngagementReport />} />
                <Route path="/MembershipTierManagement" element={<MembershipTierManagement />} />
                <Route path="/MembershipSettings" element={<MembershipSettings />} />
                <Route path="/MembershipFees" element={<MembershipFees />} />
                <Route path="/FundraisingManagement" element={<FundraisingManagement />} />
                <Route path="/CampaignEdit/:id" element={<CampaignEdit />} />
                
                <Route path="/Resources" element={<Resources />} />
                
                <Route path="/PublicResources" element={<PublicResources />} />
                
                <Route path="/ResourceSettings" element={<ResourceSettings />} />
                
                <Route path="/ResourceManagement" element={<ResourceManagement />} />
                
                <Route path="/FileManagement" element={<FileManagement />} />
                
                <Route path="/TagManagement" element={<TagManagement />} />
                
                <Route path="/JobBoard" element={<JobBoard />} />
                
                <Route path="/JobDetails" element={<JobDetails />} />
                
                <Route path="/PostJob" element={<PostJob />} />
                
                <Route path="/JobPostSuccess" element={<JobPostSuccess />} />
                
                <Route path="/membership/direct-debit/complete" element={<DirectDebitReturn outcome="complete" />} />
                <Route path="/membership/direct-debit/cancelled" element={<DirectDebitReturn outcome="cancelled" />} />
                
                <Route path="/JobBoardSettings" element={<JobBoardSettings />} />
                
                <Route path="/JobPostingManagement" element={<JobPostingManagement />} />
                
                <Route path="/MyJobPostings" element={<MyJobPostings />} />
                
                <Route path="/PageBannerManagement" element={<PageBannerManagement />} />
                <Route path="/pagebannermanagement" element={<PageBannerManagement />} />
                
                <Route path="/IEditPageManagement" element={<IEditPageManagement />} />
                
                <Route path="/IEditTemplateManagement" element={<IEditTemplateManagement />} />
                
                <Route path="/IEditPageEditor" element={<IEditPageEditor />} />
                
                <Route path="/CanvasPageEditor" element={<CanvasPageEditor />} />
                
                <Route path="/testpage" element={<testpage />} />
                
                <Route path="/NavigationManagement" element={<NavigationManagement />} />
                
                <Route path="/MicrositeManagement" element={<MicrositeManagement />} />
                
                <Route path="/about-me" element={<Preferences />} />
                <Route path="/AboutMe" element={<Preferences />} />
                <Route path="/Preferences" element={<Preferences />} />
                <Route path="/preferences" element={<Preferences />} />
                
                <Route path="/PublicArticles" element={<PublicArticles />} />
                
                <Route path="/MemberHandleManagement" element={<MemberHandleManagement />} />
                
                <Route path="/ButtonElements" element={<ButtonElements />} />
                
                <Route path="/ButtonStyleManagement" element={<ButtonStyleManagement />} />
                
                <Route path="/BorderRadiusSettings" element={<BorderRadiusSettings />} />
                
                <Route path="/AwardManagement" element={<AwardManagement />} />
                <Route path="/BadgeManagement" element={<BadgeManagement />} />
                
                <Route path="/Team" element={<Team />} />
                
                <Route path="/MemberDirectory" element={<MemberDirectory />} />
                
                <Route path="/WallOfFameManagement" element={<WallOfFameManagement />} />
                
                <Route path="/DynamicPage" element={<DynamicPage />} />
                
                <Route path="/sharon" element={<sharon />} />
                
                <Route path="/content" element={<content />} />
                
                <Route path="/icontent" element={<icontent />} />
                
                <Route path="/ViewPage" element={<ViewPage />} />
                
                <Route path="/ParamTest" element={<ParamTest />} />
                
                <Route path="/TeamInviteSettings" element={<TeamInviteSettings />} />
                
                <Route path="/OrganisationDirectory" element={<OrganisationDirectory />} />
                
                <Route path="/organisations/:id" element={<OrganisationsList />} />
                <Route path="/organisations" element={<OrganisationsList />} />
                <Route path="/OrganisationGroups" element={<OrganisationGroups />} />
                <Route path="/OrganisationGroups/:id" element={<OrganisationGroups />} />
                
                {/* Members list + detail, reachable at every built-in alias
                    (see @shared/memberAliases.js). /members always works. */}
                {BUILTIN_MEMBER_ALIASES.map((alias) => (
                  <Route key={`${alias}-detail`} path={`/${alias}/:id`} element={<MemberDetail />} />
                ))}
                {BUILTIN_MEMBER_ALIASES.map((alias) => (
                  <Route key={`${alias}-list`} path={`/${alias}`} element={<MembersList />} />
                ))}
                
                <Route path="/FloaterManagement" element={<FloaterManagement />} />
                
                <Route path="/FormManagement" element={<FormManagement />} />
                
                <Route path="/FormBuilder" element={<FormBuilder />} />
                
                <Route path="/FormView" element={<FormView />} />
                <Route path="/survey/:token" element={<SurveyAssignmentRoute />} />
                
                <Route path="/MemberDirectorySettings" element={<MemberDirectorySettings />} />
                
                <Route path="/FormSubmissions" element={<FormSubmissions />} />
                
                <Route path="/FormSubmission/:submissionId" element={<FormSubmissionView />} />
                
                <Route path="/FormSettings" element={<FormSettings />} />
                
                <Route path="/DueDiligenceDashboard" element={<DueDiligenceDashboard />} />
                <Route path="/DueDiligenceConfig" element={<DueDiligenceConfig />} />
                <Route path="/ReviewSubmission" element={<ReviewSubmission />} />
                <Route path="/DueDiligenceReports" element={<DueDiligenceReports />} />
                
                <Route path="/BriefManagement" element={<BriefManagement />} />
                <Route path="/BriefDetail" element={<BriefDetail />} />
                <Route path="/BriefSettings" element={<BriefSettings />} />
                <Route path="/ExternalWriters" element={<ExternalWriters />} />
                <Route path="/external-writers" element={<ExternalWriters />} />

                <Route path="/PhotoGalleries" element={<PhotoGalleries />} />
                
                <Route path="/Forum" element={<Forum />} />
                <Route path="/Inbox" element={<Inbox />} />
                <Route path="/inbox" element={<Inbox />} />
                <Route path="/ForumThread" element={<ForumThread />} />
                <Route path="/ForumManagement" element={<ForumManagement />} />
                
                <Route path="/NewsEditor" element={<NewsEditor />} />
                
                <Route path="/NewsView" element={<NewsView />} />
                
                <Route path="/News" element={<News />} />
                
                <Route path="/PublicNews" element={<PublicNews />} />
                
                <Route path="/NewsSettings" element={<NewsSettings />} />
                
                <Route path="/news-preview/:id" element={<NewsPreview />} />
                
                <Route path="/article-preview/:id" element={<ArticlePreview />} />
                
                <Route path="/DataExport" element={<DataExport />} />
                <Route path="/ImportManager" element={<ImportManager />} />
                
                <Route path="/SiteMap" element={<SiteMap />} />
                
                <Route path="/Support" element={<Support />} />
                
                <Route path="/Help" element={<Help />} />
                <Route path="/help/:slug" element={<HelpArticleView />} />
                
                <Route path="/SupportManagement" element={<SupportManagement />} />
                
                <Route path="/PortalNavigationManagement" element={<PortalNavigationManagement />} />
                
                <Route path="/CategoryManagement" element={<CategoryManagement />} />
                
                <Route path="/MemberGroupManagement" element={<MemberGroupManagement />} />
                <Route path="/MemberGroupSettings" element={<MemberGroupSettings />} />
                
                <Route path="/MemberGroups" element={<MemberGroups />} />
                
                <Route path="/MemberGroupDetail" element={<MemberGroupDetail />} />
                
                <Route path="/VolunteerBoard" element={<VolunteerBoard />} />
                
                <Route path="/GroupEmail" element={<GroupEmail />} />
                
                <Route path="/GroupProjects" element={<GroupProjects />} />
                
                <Route path="/GroupEvents" element={<GroupEvents />} />
                
                <Route path="/ArticlesSettings" element={<ArticlesSettings />} />
                
                <Route path="/GuestWriterManagement" element={<GuestWriterManagement />} />
                
                <Route path="/SpeakerManagement" element={<SpeakerManagement />} />
                <Route path="/SponsorManagement" element={<SponsorManagement />} />
                
                <Route path="/CardDeckManagement" element={<CardDeckManagement />} />
                
                <Route path="/OrganisationDirectorySettings" element={<OrganisationDirectorySettings />} />
                
                <Route path="/InstalledFonts" element={<InstalledFonts />} />
                
                <Route path="/PortalMenuManagement" element={<PortalMenuManagement />} />
                
                <Route path="/MemberGroupAssignmentReport" element={<MemberGroupAssignmentReport />} />
                
                <Route path="/MemberGroupInviteReport" element={<MemberGroupInviteReport />} />
                
                <Route path="/MemberGroupClassificationReport" element={<MemberGroupClassificationReport />} />
                
                <Route path="/TeamEngagementReport" element={<TeamEngagementReport />} />
                
                <Route path="/MemberGroupGuestManagement" element={<MemberGroupGuestManagement />} />
                
                <Route path="/TeamSettings" element={<TeamSettings />} />
                
                <Route path="/PreferenceSettings" element={<PreferenceSettings />} />
                
                <Route path="/CustomFieldsAdmin" element={<CustomFieldsAdmin />} />
                
                <Route path="/ZoomWebinarProvisioning" element={<ZoomWebinarProvisioning />} />
                
                <Route path="/CreateEvent" element={<CreateEvent />} />
                
                <Route path="/EditEvent" element={<EditEvent />} />
                
                <Route path="/PageVisibilitySettings" element={<PageVisibilitySettings />} />
                
                <Route path="/CommunicationsManagement" element={<CommunicationsManagement />} />
                
                <Route path="/EmailCampaignEdit/:id" element={<EmailCampaignEdit />} />
                
                <Route path="/AdminMemberEdit" element={<AdminMemberEdit />} />
                
                <Route path="/MyOrganisation" element={<MyOrganisation />} />
                
                <Route path="/OrganisationPreferences" element={<OrganisationPreferences />} />
                
                <Route path="/MemberPreferences" element={<MemberPreferences />} />
                
                <Route path="/MemberRoleReport" element={<MemberRoleReport />} />
                
                <Route path="/DynamicDirectoryManagement" element={<DynamicDirectoryManagement />} />
                
                <Route path="/directory/:slug" element={<DynamicDirectoryView />} />
                
                <Route path="/RedirectManagement" element={<RedirectManagement />} />
                
                <Route path="/ProjectBoards" element={<ProjectBoards />} />
                <Route path="/ProjectBoard/:id" element={<ProjectBoard />} />
                
                <Route path="/ReportsDashboard" element={<ReportsDashboard />} />
                <Route path="/AIReports" element={<AIReports />} />
                <Route path="/AccessibilityAudits" element={<AccessibilityAudits />} />
                <Route path="/CanvasLinksManager" element={<CanvasLinksManager />} />
                <Route path="/EventCheckIn" element={<EventCheckIn />} />
                <Route path="/EventCheckInDashboard" element={<EventCheckInDashboard />} />
                
                <Route path="/CreateComplexEvent" element={<CreateComplexEvent />} />
                <Route path="/PublicComplexEvents" element={<PublicComplexEvents />} />
                <Route path="/ComplexEventDetail" element={<ComplexEventDetail />} />
                <Route path="/session-events/:eventSlug" element={<ComplexEventDetail />} />
                
                <Route path="/DomainSettings" element={<DomainSettings />} />
                <Route path="/domain-settings" element={<DomainSettings />} />
                
                <Route path="/search" element={<SearchResults />} />
                <Route path="/Search" element={<SearchResults />} />
                
                {/* Folder-based article URLs: /{basePath}/{authorHandle}/{slug} */}
                {/* Aliases come from the shared list in @shared/articleAliases.js */}
                {BUILTIN_ARTICLE_ALIASES.map((alias) => (
                  <Route key={alias} path={`/${alias}/:authorHandle/:articleSlug`} element={<ArticleView />} />
                ))}
                
                {/* /auth/verify route removed - using password auth */}
                
                {/* Dynamic CMS pages - catch-all route for IEdit pages by slug */}
                <Route path="/:slug" element={<DynamicPage />} />

                {/* Task #2629: microsite-scoped full results page. Registered
                    before the generic /{prefix}/{slug} microsite page route so
                    "search" is treated as the results page, not a page slug.
                    Rendering under the microsite prefix lets MicrositeContext
                    (which keys off the first path segment) paint the microsite
                    theme/chrome, and SearchResults reads the scope from the
                    route params. */}
                <Route path="/:micrositePrefix/search" element={<SearchResults />} />
                <Route path="/:micrositePrefix/Search" element={<SearchResults />} />

                {/* Task #2426: microsite pages at /{prefix}/{slug}. DynamicPage
                    validates the prefix against the tenant's active microsites
                    and renders not-found for unknown two-segment URLs. */}
                <Route path="/:micrositePrefix/:slug" element={<DynamicPage />} />

                {/* Catch-all for multi-segment URLs that don't match any route above */}
                <Route path="/*" element={<CatchAllNotFound />} />
            </Routes>
            </Layout>
        </>
    );
}

function StandaloneRoutes() {
    return (
        <Routes>
            <Route path="/signup" element={<TenantSignup />} />
            <Route path="/Signup" element={<TenantSignup />} />
            <Route path="/register" element={<TenantSignup />} />
            <Route path="/signup-verify" element={<SignupVerify />} />
            <Route path="/embed/form/:slug" element={<EmbedForm />} />
            <Route path="/embed/resource/:identifier" element={<EmbedResource />} />
            <Route path="/embed/event/:identifier" element={<EmbedEvent />} />
            <Route path="/embed/alternative-signer" element={<EmbedAlternativeSigner />} />
            <Route path="/donate/:token" element={<DonatePage />} />
            <Route path="/fundraise/:slug" element={<CampaignRegisterPage />} />
            <Route path="/fundraiser/login" element={<FundraiserLoginPage />} />
            <Route path="/fundraiser/dashboard" element={<FundraiserDashboardPage />} />
            <Route path="/campaigns" element={<CampaignsPage />} />
            <Route path="/membership-fees/:token" element={<MembershipFeePage />} />
            <Route path="/submit-po/:token" element={<SubmitPOPage />} />
            <Route path="/group-booking/:token" element={<GroupBookingPage />} />
            <Route path="/guest-approval/:token" element={<GuestApprovalPage />} />
            <Route path="/group-role-invite/:token" element={<MemberGroupRoleInvitePage />} />
            <Route path="/team-invite/:token" element={<TeamInvitePage />} />
            <Route path="/dd-setup/:token" element={<DirectDebitInvitationPage />} />
            <Route path="/dd-migrate/:token" element={<DirectDebitMigrationPage />} />
            <Route path="/EventDetails" element={<EventDetails />} />
            <Route path="/events/:eventSlug" element={<EventDetails />} />
            <Route path="/ComplexEventDetail" element={<ComplexEventDetail />} />
            <Route path="/session-events/:eventSlug" element={<ComplexEventDetail />} />
            <Route path="/book/:slug" element={<PublicBooking />} />
            <Route path="/email-preferences" element={<EmailPreferences />} />
            <Route path="/CaseStudyUpload" element={<CaseStudyUpload />} />
            <Route path="/casestudyupload" element={<CaseStudyUpload />} />
        </Routes>
    );
}

function AdminRoutes() {
    return (
        <Routes>
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route path="/admin/setup-password" element={<AdminLogin />} />
            <Route path="/admin/dashboard" element={<AdminDashboard />} />
            <Route path="/admin/settings" element={<AdminSettings />} />
            <Route path="/admin/branding" element={<AdminBranding />} />
            <Route path="/admin/lmic-countries" element={<AdminLmicCountries />} />
            <Route path="/admin/domains" element={<AdminDomains />} />
            <Route path="/admin/team" element={<AdminTeam />} />
            <Route path="/admin/email-logs" element={<AdminEmailLogs />} />
            <Route path="/admin/scheduled-tasks" element={<AdminScheduledTasks />} />
            <Route path="/admin/integrations" element={<AdminIntegrations />} />
            <Route path="/admin/zoho-crm-sync" element={<AdminZohoCrmSync />} />
            <Route path="/admin/onboarding" element={<OnboardingWizard />} />
            <Route path="/admin/plan-usage" element={<PlanUsage />} />
            <Route path="/admin/ai-design-studio" element={<AiDesignStudio />} />
            <Route path="/admin" element={<AdminDashboard />} />
        </Routes>
    );
}

function PlatformRoutes() {
    return (
        <Routes>
            <Route path="/platform/setup" element={<PlatformSetup />} />
            <Route path="/platform/login" element={<PlatformLogin />} />
            <Route path="/platform/admin" element={<PlatformAdmin />} />
            <Route path="/platform" element={<PlatformAdmin />} />
        </Routes>
    );
}

function isRootDomain() {
    const hostname = window.location.hostname;
    return hostname === 'iconn.app' || 
           hostname === 'www.iconn.app' ||
           hostname === 'localhost' && window.location.pathname.startsWith('/saas');
}

function SaasRoutes() {
    return (
        <Routes>
            <Route path="/" element={<SaasLanding />} />
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route path="/admin/setup-password" element={<AdminLogin />} />
            <Route path="/admin/dashboard" element={<AdminDashboard />} />
            <Route path="/admin/settings" element={<AdminSettings />} />
            <Route path="/admin/branding" element={<AdminBranding />} />
            <Route path="/admin/lmic-countries" element={<AdminLmicCountries />} />
            <Route path="/admin/domains" element={<AdminDomains />} />
            <Route path="/admin/team" element={<AdminTeam />} />
            <Route path="/admin/email-logs" element={<AdminEmailLogs />} />
            <Route path="/admin/scheduled-tasks" element={<AdminScheduledTasks />} />
            <Route path="/admin/integrations" element={<AdminIntegrations />} />
            <Route path="/admin/zoho-crm-sync" element={<AdminZohoCrmSync />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/platform/setup" element={<PlatformSetup />} />
            <Route path="/platform/login" element={<PlatformLogin />} />
            <Route path="/platform/admin" element={<PlatformAdmin />} />
            <Route path="/platform" element={<PlatformAdmin />} />
            <Route path="/signup" element={<TenantSignup />} />
            <Route path="/register" element={<TenantSignup />} />
            <Route path="/signup-verify" element={<SignupVerify />} />
            <Route path="/admin/onboarding" element={<OnboardingWizard />} />
            <Route path="/admin/plan-usage" element={<PlanUsage />} />
            <Route path="/admin/ai-design-studio" element={<AiDesignStudio />} />
            <Route path="*" element={<SaasLanding />} />
        </Routes>
    );
}

function AppRoutes() {
    const location = useLocation();
    
    if (isRootDomain()) {
        return <SaasRoutes />;
    }
    
    const standalonePages = ['/signup', '/register', '/signup-verify', '/email-preferences', '/casestudyupload'];
    const isStandalonePage = standalonePages.some(path => 
        location.pathname.toLowerCase() === path.toLowerCase()
    );
    
    const isEmbedPage = location.pathname.toLowerCase().startsWith('/embed/');
    const isBookingPage = location.pathname.toLowerCase().startsWith('/book/');
    const isDonatePage = location.pathname.toLowerCase().startsWith('/donate/');
    const isFundraisePage = location.pathname.toLowerCase().startsWith('/fundraise/');
    const isFundraiserPage = location.pathname.toLowerCase().startsWith('/fundraiser/');
    const isMembershipFeePage = location.pathname.toLowerCase().startsWith('/membership-fees/');
    const isSubmitPoPage = location.pathname.toLowerCase().startsWith('/submit-po/');
    const isGroupBookingPage = location.pathname.toLowerCase().startsWith('/group-booking/');
    const isGuestApprovalPage = location.pathname.toLowerCase().startsWith('/guest-approval/');
    const isGroupRoleInvitePage = location.pathname.toLowerCase().startsWith('/group-role-invite/');
    const isTeamInvitePage = location.pathname.toLowerCase().startsWith('/team-invite/');
    const isDdSetupPage = location.pathname.toLowerCase().startsWith('/dd-setup/')
        || location.pathname.toLowerCase().startsWith('/dd-migrate/');
    const isCampaignsPage = location.pathname.toLowerCase() === '/campaigns';
    
    // Use window.location.search to reliably detect embed param (works even before routing)
    const hasEmbedParam = new URLSearchParams(window.location.search).get('embed') === 'true';
    
    const isAdminPage = location.pathname.toLowerCase().startsWith('/admin');
    const isPlatformPage = location.pathname.toLowerCase().startsWith('/platform');
    
    if (isStandalonePage || isEmbedPage || isBookingPage || isDonatePage || isFundraisePage || isFundraiserPage || isMembershipFeePage || isSubmitPoPage || isGroupBookingPage || isGuestApprovalPage || isGroupRoleInvitePage || isTeamInvitePage || isDdSetupPage || isCampaignsPage || hasEmbedParam) {
        return <StandaloneRoutes />;
    }
    
    if (isPlatformPage) {
        return <PlatformRoutes />;
    }
    
    if (isAdminPage) {
        return <AdminRoutes />;
    }
    
    return (
        <ArticleUrlProvider>
            <MemberTerminologyProvider>
                <MicrositeProvider>
                    <DynamicMemberRedirector>
                        <PagesContent />
                    </DynamicMemberRedirector>
                </MicrositeProvider>
            </MemberTerminologyProvider>
        </ArticleUrlProvider>
    );
}

export default function Pages() {
    return (
        <Router>
            <LayoutProvider>
                <AppRoutes />
                <PlanQuotaDialog />
            </LayoutProvider>
        </Router>
    );
}