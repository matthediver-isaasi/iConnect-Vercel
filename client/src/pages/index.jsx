import Layout from "./Layout.jsx";

import Events from "./Events";

import HomePageRedirect from "./HomePageRedirect";

import Home from "./Home";

import AdminSetup from "./AdminSetup";

import EventDetails from "./EventDetails";

import BuyProgramTickets from "./BuyProgramTickets";

// VerifyMagicLink removed - using password authentication instead

import TestLogin from "./TestLogin";

import Login from "./Login";

import ResetPassword from "./ResetPassword";

import Balances from "./Balances";

import Dashboard from "./Dashboard";

import UnpackedInternationalEmployability from "./UnpackedInternationalEmployability";

import Articles from "./Articles";

import ArticleEditor from "./ArticleEditor";

import ArticleView from "./ArticleView";

import PublicAbout from "./PublicAbout";

import PublicContact from "./PublicContact";

import PublicEvents from "./PublicEvents";

import RoleManagement from "./RoleManagement";

import RoleAccessConfigManagement from "./RoleAccessConfigManagement";

import MemberRoleAssignment from "./MemberRoleAssignment";

import TeamMemberManagement from "./TeamMemberManagement";

import DiscountCodeManagement from "./DiscountCodeManagement";

import VoucherManagement from "./VoucherManagement";

import TrainingFundManagement from "./TrainingFundManagement";

import WorkflowManagement from "./WorkflowManagement";

import EmailTemplateManagement from "./EmailTemplateManagement";

import MyTickets from "./MyTickets";

import EventSettings from "./EventSettings";

import Bookings from "./Bookings";

import TourManagement from "./TourManagement";

import History from "./History";

import TicketSalesAnalytics from "./TicketSalesAnalytics";

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

import JobBoardSettings from "./JobBoardSettings";

import JobPostingManagement from "./JobPostingManagement";

import MyJobPostings from "./MyJobPostings";

import PageBannerManagement from "./PageBannerManagement";

import IEditPageManagement from "./IEditPageManagement";

import IEditTemplateManagement from "./IEditTemplateManagement";

import IEditPageEditor from "./IEditPageEditor";

import testpage from "./testpage";

import NavigationManagement from "./NavigationManagement";

import Preferences from "./Preferences";

import MyArticles from "./MyArticles";

import PublicArticles from "./PublicArticles";

import MemberHandleManagement from "./MemberHandleManagement";

import ButtonElements from "./ButtonElements";

import ButtonStyleManagement from "./ButtonStyleManagement";

import BorderRadiusSettings from "./BorderRadiusSettings";

import AwardManagement from "./AwardManagement";

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

import MembersList from "./MembersList";

import FloaterManagement from "./FloaterManagement";

import FormManagement from "./FormManagement";

import FormBuilder from "./FormBuilder";

import FormView from "./FormView";

import MemberDirectorySettings from "./MemberDirectorySettings";

import FormSubmissions from "./FormSubmissions";

import NewsEditor from "./NewsEditor";

import NewsView from "./NewsView";

import News from "./News";

import PublicNews from "./PublicNews";

import NewsSettings from "./NewsSettings";

import NewsPreview from "./NewsPreview";

import DataExport from "./DataExport";

import SiteMap from "./SiteMap";

import Support from "./Support";

import SupportManagement from "./SupportManagement";

import PortalNavigationManagement from "./PortalNavigationManagement";

import CategoryManagement from "./CategoryManagement";

import MemberGroupManagement from "./MemberGroupManagement";

import ArticlesSettings from "./ArticlesSettings";

import GuestWriterManagement from "./GuestWriterManagement";
import SpeakerManagement from "./SpeakerManagement";

import CardDeckManagement from "./CardDeckManagement";

import OrganisationDirectorySettings from "./OrganisationDirectorySettings";

import InstalledFonts from "./InstalledFonts";

import PortalMenuManagement from "./PortalMenuManagement";

import MemberGroupAssignmentReport from "./MemberGroupAssignmentReport";

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

import AdminMemberEdit from "./AdminMemberEdit";

import MyOrganisation from "./MyOrganisation";

import OrganisationPreferences from "./OrganisationPreferences";

import MemberRoleReport from "./MemberRoleReport";

import DynamicDirectoryManagement from "./DynamicDirectoryManagement";

import DynamicDirectoryView from "./DynamicDirectoryView";

import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutProvider } from '@/contexts/LayoutContext';
import { ArticleUrlProvider } from '@/contexts/ArticleUrlContext';

const PAGES = {
    
    Events: Events,
    
    Home: Home,
    
    AdminSetup: AdminSetup,
    
    EventDetails: EventDetails,
    
    BuyProgramTickets: BuyProgramTickets,
    
    // VerifyMagicLink removed - using password authentication
    
    TestLogin: TestLogin,
    
    Login: Login,
    
    ResetPassword: ResetPassword,
    
    Balances: Balances,
    
    Dashboard: Dashboard,
    
    UnpackedInternationalEmployability: UnpackedInternationalEmployability,
    
    Articles: Articles,
    
    ArticleEditor: ArticleEditor,
    
    ArticleView: ArticleView,
    
    PublicAbout: PublicAbout,
    
    PublicContact: PublicContact,
    
    PublicEvents: PublicEvents,
    
    RoleManagement: RoleManagement,
    
    RoleAccessConfigManagement: RoleAccessConfigManagement,
    
    MemberRoleAssignment: MemberRoleAssignment,
    
    TeamMemberManagement: TeamMemberManagement,
    
    DiscountCodeManagement: DiscountCodeManagement,
    
    VoucherManagement: VoucherManagement,
    
    TrainingFundManagement: TrainingFundManagement,
    
    WorkflowManagement: WorkflowManagement,
    
    EmailTemplateManagement: EmailTemplateManagement,
    
    MyTickets: MyTickets,
    
    EventSettings: EventSettings,
    
    Bookings: Bookings,
    
    TourManagement: TourManagement,
    
    History: History,
    
    TicketSalesAnalytics: TicketSalesAnalytics,
    
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
    
    JobBoardSettings: JobBoardSettings,
    
    JobPostingManagement: JobPostingManagement,
    
    MyJobPostings: MyJobPostings,
    
    PageBannerManagement: PageBannerManagement,
    
    IEditPageManagement: IEditPageManagement,
    
    IEditTemplateManagement: IEditTemplateManagement,
    
    IEditPageEditor: IEditPageEditor,
    
    testpage: testpage,
    
    NavigationManagement: NavigationManagement,
    
    Preferences: Preferences,
    
    AboutMe: Preferences,
    
    MyArticles: MyArticles,
    
    PublicArticles: PublicArticles,
    
    MemberHandleManagement: MemberHandleManagement,
    
    ButtonElements: ButtonElements,
    
    ButtonStyleManagement: ButtonStyleManagement,
    
    BorderRadiusSettings: BorderRadiusSettings,
    
    AwardManagement: AwardManagement,
    
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
    MembersList: MembersList,
    
    FloaterManagement: FloaterManagement,
    
    FormManagement: FormManagement,
    
    FormBuilder: FormBuilder,
    
    FormView: FormView,
    
    MemberDirectorySettings: MemberDirectorySettings,
    
    FormSubmissions: FormSubmissions,
    
    NewsEditor: NewsEditor,
    
    NewsView: NewsView,
    
    News: News,
    
    PublicNews: PublicNews,
    
    NewsSettings: NewsSettings,

    NewsPreview: NewsPreview,
    
    DataExport: DataExport,
    
    SiteMap: SiteMap,
    
    Support: Support,
    
    SupportManagement: SupportManagement,
    
    PortalNavigationManagement: PortalNavigationManagement,
    
    CategoryManagement: CategoryManagement,
    
    MemberGroupManagement: MemberGroupManagement,
    
    ArticlesSettings: ArticlesSettings,
    
    GuestWriterManagement: GuestWriterManagement,
    
    SpeakerManagement: SpeakerManagement,
    
    CardDeckManagement: CardDeckManagement,
    
    OrganisationDirectorySettings: OrganisationDirectorySettings,
    
    InstalledFonts: InstalledFonts,
    
    PortalMenuManagement: PortalMenuManagement,
    
    MemberGroupAssignmentReport: MemberGroupAssignmentReport,
    
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
    
    AdminMemberEdit: AdminMemberEdit,
    
    MyOrganisation: MyOrganisation,
    
    MemberRoleReport: MemberRoleReport,
    
    DynamicDirectoryManagement: DynamicDirectoryManagement,
    
    DynamicDirectoryView: DynamicDirectoryView,
    
}

function _getCurrentPage(url) {
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
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

// Create a wrapper component that uses useLocation inside the Router context
function PagesContent() {
    const location = useLocation();
    const currentPage = _getCurrentPage(location.pathname);
    
    return (
        <Layout currentPageName={currentPage}>
            <Routes>            
                
                    <Route path="/" element={<HomePageRedirect />} />
                
                
                <Route path="/Events" element={<Events />} />
                
                <Route path="/Home" element={<Home />} />
                
                <Route path="/AdminSetup" element={<AdminSetup />} />
                
                <Route path="/EventDetails" element={<EventDetails />} />
                
                <Route path="/BuyProgramTickets" element={<BuyProgramTickets />} />
                
                {/* VerifyMagicLink route removed - using password auth */}
                
                <Route path="/TestLogin" element={<TestLogin />} />
                <Route path="/test-login" element={<TestLogin />} />
                
                <Route path="/Login" element={<Login />} />
                <Route path="/login" element={<Login />} />
                <Route path="/auth/login" element={<Login />} />
                
                <Route path="/ResetPassword" element={<ResetPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/auth/reset-password" element={<ResetPassword />} />
                
                <Route path="/Balances" element={<Balances />} />
                
                <Route path="/Dashboard" element={<Dashboard />} />
                
                <Route path="/UnpackedInternationalEmployability" element={<UnpackedInternationalEmployability />} />
                
                <Route path="/Articles" element={<Articles />} />
                
                <Route path="/ArticleEditor" element={<ArticleEditor />} />
                <Route path="/articleeditor" element={<ArticleEditor />} />
                
                <Route path="/ArticleView" element={<ArticleView />} />
                
                <Route path="/PublicAbout" element={<PublicAbout />} />
                
                <Route path="/PublicContact" element={<PublicContact />} />
                
                <Route path="/PublicEvents" element={<PublicEvents />} />
                
                <Route path="/RoleManagement" element={<RoleManagement />} />
                
                <Route path="/RoleAccessConfigManagement" element={<RoleAccessConfigManagement />} />
                
                <Route path="/MemberRoleAssignment" element={<MemberRoleAssignment />} />
                
                <Route path="/TeamMemberManagement" element={<TeamMemberManagement />} />
                
                <Route path="/DiscountCodeManagement" element={<DiscountCodeManagement />} />
                
                <Route path="/VoucherManagement" element={<VoucherManagement />} />
                
                <Route path="/TrainingFundManagement" element={<TrainingFundManagement />} />
                
                <Route path="/WorkflowManagement" element={<WorkflowManagement />} />
                
                <Route path="/EmailTemplateManagement" element={<EmailTemplateManagement />} />
                
                <Route path="/MyTickets" element={<MyTickets />} />
                
                <Route path="/EventSettings" element={<EventSettings />} />
                
                <Route path="/Bookings" element={<Bookings />} />
                
                <Route path="/TourManagement" element={<TourManagement />} />
                
                <Route path="/History" element={<History />} />
                
                <Route path="/TicketSalesAnalytics" element={<TicketSalesAnalytics />} />
                
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
                
                <Route path="/JobBoardSettings" element={<JobBoardSettings />} />
                
                <Route path="/JobPostingManagement" element={<JobPostingManagement />} />
                
                <Route path="/MyJobPostings" element={<MyJobPostings />} />
                
                <Route path="/PageBannerManagement" element={<PageBannerManagement />} />
                <Route path="/pagebannermanagement" element={<PageBannerManagement />} />
                
                <Route path="/IEditPageManagement" element={<IEditPageManagement />} />
                
                <Route path="/IEditTemplateManagement" element={<IEditTemplateManagement />} />
                
                <Route path="/IEditPageEditor" element={<IEditPageEditor />} />
                
                <Route path="/testpage" element={<testpage />} />
                
                <Route path="/NavigationManagement" element={<NavigationManagement />} />
                
                <Route path="/about-me" element={<Preferences />} />
                <Route path="/AboutMe" element={<Preferences />} />
                <Route path="/Preferences" element={<Preferences />} />
                <Route path="/preferences" element={<Preferences />} />
                
                <Route path="/MyArticles" element={<MyArticles />} />
                
                <Route path="/PublicArticles" element={<PublicArticles />} />
                
                <Route path="/MemberHandleManagement" element={<MemberHandleManagement />} />
                
                <Route path="/ButtonElements" element={<ButtonElements />} />
                
                <Route path="/ButtonStyleManagement" element={<ButtonStyleManagement />} />
                
                <Route path="/BorderRadiusSettings" element={<BorderRadiusSettings />} />
                
                <Route path="/AwardManagement" element={<AwardManagement />} />
                
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
                
                <Route path="/organisations" element={<OrganisationsList />} />
                
                <Route path="/members" element={<MembersList />} />
                
                <Route path="/FloaterManagement" element={<FloaterManagement />} />
                
                <Route path="/FormManagement" element={<FormManagement />} />
                
                <Route path="/FormBuilder" element={<FormBuilder />} />
                
                <Route path="/FormView" element={<FormView />} />
                
                <Route path="/MemberDirectorySettings" element={<MemberDirectorySettings />} />
                
                <Route path="/FormSubmissions" element={<FormSubmissions />} />
                
                <Route path="/NewsEditor" element={<NewsEditor />} />
                
                <Route path="/NewsView" element={<NewsView />} />
                
                <Route path="/News" element={<News />} />
                
                <Route path="/PublicNews" element={<PublicNews />} />
                
                <Route path="/NewsSettings" element={<NewsSettings />} />
                
                <Route path="/news-preview/:id" element={<NewsPreview />} />
                
                <Route path="/DataExport" element={<DataExport />} />
                
                <Route path="/SiteMap" element={<SiteMap />} />
                
                <Route path="/Support" element={<Support />} />
                
                <Route path="/SupportManagement" element={<SupportManagement />} />
                
                <Route path="/PortalNavigationManagement" element={<PortalNavigationManagement />} />
                
                <Route path="/CategoryManagement" element={<CategoryManagement />} />
                
                <Route path="/MemberGroupManagement" element={<MemberGroupManagement />} />
                
                <Route path="/ArticlesSettings" element={<ArticlesSettings />} />
                
                <Route path="/GuestWriterManagement" element={<GuestWriterManagement />} />
                
                <Route path="/SpeakerManagement" element={<SpeakerManagement />} />
                
                <Route path="/CardDeckManagement" element={<CardDeckManagement />} />
                
                <Route path="/OrganisationDirectorySettings" element={<OrganisationDirectorySettings />} />
                
                <Route path="/InstalledFonts" element={<InstalledFonts />} />
                
                <Route path="/PortalMenuManagement" element={<PortalMenuManagement />} />
                
                <Route path="/MemberGroupAssignmentReport" element={<MemberGroupAssignmentReport />} />
                
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
                
                <Route path="/AdminMemberEdit" element={<AdminMemberEdit />} />
                
                <Route path="/MyOrganisation" element={<MyOrganisation />} />
                
                <Route path="/OrganisationPreferences" element={<OrganisationPreferences />} />
                
                <Route path="/MemberRoleReport" element={<MemberRoleReport />} />
                
                <Route path="/DynamicDirectoryManagement" element={<DynamicDirectoryManagement />} />
                
                <Route path="/directory/:slug" element={<DynamicDirectoryView />} />
                
                {/* Folder-based article URLs: /{basePath}/{authorHandle}/{slug} */}
                {/* Supports common display names: Articles, Blogs, Insights, Posts, Stories, News */}
                <Route path="/articles/:authorHandle/:articleSlug" element={<ArticleView />} />
                <Route path="/blogs/:authorHandle/:articleSlug" element={<ArticleView />} />
                <Route path="/insights/:authorHandle/:articleSlug" element={<ArticleView />} />
                <Route path="/posts/:authorHandle/:articleSlug" element={<ArticleView />} />
                <Route path="/stories/:authorHandle/:articleSlug" element={<ArticleView />} />
                
                {/* /auth/verify route removed - using password auth */}
                
                {/* Dynamic CMS pages - catch-all route for IEdit pages by slug */}
                <Route path="/:slug" element={<DynamicPage />} />
            </Routes>
        </Layout>
    );
}

export default function Pages() {
    return (
        <Router>
            <ArticleUrlProvider>
                <LayoutProvider>
                    <PagesContent />
                </LayoutProvider>
            </ArticleUrlProvider>
        </Router>
    );
}