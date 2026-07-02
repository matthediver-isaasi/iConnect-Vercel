import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import TenantCtaButton from "@/components/common/TenantCtaButton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Calendar,
  MapPin,
  ArrowRight,
  Download,
  PlayCircle,
  ExternalLink,
  MessageCircle,
  Eye,
  Pin,
  Users,
  BookOpen,
  Layers,
  MessageSquare,
  ChevronRight,
} from "lucide-react";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { createPageUrl } from "@/utils";

const SAMPLE_EVENTS = [
  {
    id: "e1",
    title: "Global Schools Forum Annual Summit 2026",
    date: "14 Jul 2026",
    location: "Nairobi, Kenya",
    type: "Conference",
    typeBg: "#dbeafe",
    typeColor: "#1d4ed8",
    spotsLeft: 38,
    image: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=600&q=80",
  },
  {
    id: "e2",
    title: "School Network Governance in LMICs: Practical Approaches",
    date: "24 Jul 2026",
    location: "Online",
    type: "Workshop",
    typeBg: "#d1fae5",
    typeColor: "#065f46",
    spotsLeft: 75,
    image: "https://images.unsplash.com/photo-1591115765373-5207764f72e7?w=600&q=80",
  },
  {
    id: "e3",
    title: "EdTech for Underserved Communities: Peer Exchange",
    date: "6 Aug 2026",
    location: "Accra, Ghana",
    type: "Networking",
    typeBg: "#ede9fe",
    typeColor: "#5b21b6",
    spotsLeft: 20,
    image: "https://images.unsplash.com/photo-1515187029135-18ee286d815b?w=600&q=80",
  },
];

const SAMPLE_RESOURCES = [
  {
    id: "r1",
    title: "School Network Quality Framework: LMIC Edition",
    description:
      "A practical framework for non-state school networks in low- and middle-income countries to assess, benchmark, and improve educational quality.",
    type: "download",
    category: "Frameworks",
    date: "Jun 2026",
  },
  {
    id: "r2",
    title: "Scaling Non-State Education: A Governance Toolkit",
    description:
      "Tools and templates to help school network leaders build governance structures that support sustainable growth and deepen community impact.",
    type: "external_link",
    category: "Toolkits",
    date: "May 2026",
  },
  {
    id: "r3",
    title: "EdTech Adoption in Low-Income Schools: Lessons from the Field",
    description:
      "A video series exploring how school networks across Sub-Saharan Africa and South Asia are implementing technology to improve learning outcomes.",
    type: "video",
    category: "Guides",
    date: "Apr 2026",
  },
];

const SAMPLE_ARTICLES = [
  {
    id: "a1",
    title: "From Fragile to Resilient: How School Networks Weather Crisis in LMICs",
    summary:
      "GSF members from Uganda, Bangladesh, and Colombia share how network structures helped their schools stay open and maintain learning continuity during recent disruptions.",
    author: "Dr. Amara Diallo",
    date: "20 Jun 2026",
    category: "Resilience",
    image: "https://images.unsplash.com/photo-1523240795612-9a054b0db644?w=600&q=80",
  },
  {
    id: "a2",
    title: "Girls' Education at Scale: Lessons from East Africa's Leading Networks",
    summary:
      "A closer look at evidence-based strategies that non-state school networks are deploying to close gender gaps in enrolment, retention, and learning outcomes.",
    author: "Priya Nambiar",
    date: "10 Jun 2026",
    category: "Inclusion",
    image: "https://images.unsplash.com/photo-1531482615713-2afd69097998?w=600&q=80",
  },
  {
    id: "a3",
    title: "Blended Funding Models: Sustaining Non-State Schools Without Aid Dependency",
    summary:
      "How are GSF member networks combining government partnerships, social enterprise, and philanthropic capital to build long-term financial sustainability?",
    author: "Samuel Osei",
    date: "1 Jun 2026",
    category: "Funding",
    image: "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=600&q=80",
  },
];

const SAMPLE_THREADS = [
  {
    id: "t1",
    title: "Cross-country learning visits: how is your network organising them in 2026?",
    author: "F. Mensah",
    replies: 22,
    views: 178,
    lastActivity: "2h ago",
    pinned: true,
  },
  {
    id: "t2",
    title: "Government relations strategies — what works when advocating for non-state schools?",
    author: "R. Krishnamurthy",
    replies: 14,
    views: 110,
    lastActivity: "5h ago",
    pinned: false,
  },
  {
    id: "t3",
    title: "Low-cost private schools and fee affordability — sharing your pricing models",
    author: "C. Abubakar",
    replies: 9,
    views: 73,
    lastActivity: "1d ago",
    pinned: false,
  },
  {
    id: "t4",
    title: "Impact measurement frameworks for school networks — what are members using?",
    author: "T. Nakamura",
    replies: 31,
    views: 264,
    lastActivity: "2d ago",
    pinned: false,
  },
];

const AVATAR_COLOURS = [
  { bg: "bg-blue-100 dark:bg-blue-900/60", text: "text-blue-700 dark:text-blue-300" },
  { bg: "bg-emerald-100 dark:bg-emerald-900/60", text: "text-emerald-700 dark:text-emerald-300" },
  { bg: "bg-violet-100 dark:bg-violet-900/60", text: "text-violet-700 dark:text-violet-300" },
  { bg: "bg-rose-100 dark:bg-rose-900/60", text: "text-rose-700 dark:text-rose-300" },
  { bg: "bg-indigo-100 dark:bg-indigo-900/60", text: "text-indigo-700 dark:text-indigo-300" },
];

function avatarColour(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLOURS[Math.abs(hash) % AVATAR_COLOURS.length];
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0][0] || "?").toUpperCase();
}

function ResourceIcon({ type }) {
  if (type === "download") return <Download className="w-4 h-4" />;
  if (type === "video") return <PlayCircle className="w-4 h-4" />;
  return <ExternalLink className="w-4 h-4" />;
}

function ResourceLabel({ type }) {
  if (type === "download") return "Download";
  if (type === "video") return "Watch";
  return "Visit";
}

function SectionHeader({ icon: Icon, title, linkLabel, linkTo, testPrefix }) {
  return (
    <div className="flex items-center justify-between gap-4 mb-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-md bg-primary/10">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      {linkTo && (
        <Button
          variant="ghost"
          size="sm"
          asChild
          data-testid={`button-${testPrefix}-see-all`}
        >
          <Link to={linkTo}>
            {linkLabel}
            <ChevronRight className="w-4 h-4 ml-1" />
          </Link>
        </Button>
      )}
    </div>
  );
}

export default function MemberDemo() {
  const { tenantSlug, branding, loading } = useTenantBranding();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && tenantSlug && tenantSlug.toLowerCase() !== "gsf") {
      navigate(createPageUrl("Dashboard"), { replace: true });
    }
  }, [loading, tenantSlug, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (tenantSlug && tenantSlug.toLowerCase() !== "gsf") {
    return null;
  }

  const tenantName = branding?.name || "GSF";

  return (
    <div className="min-h-screen bg-background">
      {/* ── Hero ─────────────────────────────────────────── */}
      <section
        className="relative overflow-hidden"
        data-testid="section-hero"
      >
        {/* Video background */}
        <video
          className="absolute inset-0 w-full h-full object-cover"
          src="https://www.globalschoolsforum.org/wp-content/themes/global-schools-forum/images/gsf-video.mp4"
          autoPlay
          loop
          muted
          playsInline
          aria-hidden="true"
        />
        {/* Dark wash overlay for text legibility */}
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-black/70"
          aria-hidden="true"
        />
        <div className="relative max-w-6xl mx-auto px-6 py-16 md:py-24">
          <div className="max-w-2xl">
            <Badge
              variant="secondary"
              className="mb-4 bg-white/20 text-white border-white/30 no-default-hover-elevate no-default-active-elevate"
              data-testid="badge-member-portal"
            >
              Member Portal
            </Badge>
            <h1 className="text-3xl md:text-5xl font-bold text-white leading-tight mb-4">
              Welcome to {tenantName}
            </h1>
            <p className="text-white/80 text-lg md:text-xl leading-relaxed mb-8">
              Connect with non-state school networks across the globe, access
              practical resources, join peer-learning events, and share
              knowledge to innovate, deepen impact, and achieve scale in
              low- and middle-income countries.
            </p>
            <div className="flex flex-wrap gap-3">
              <TenantCtaButton
                as="link"
                to={createPageUrl("Events")}
                size="lg"
                fallbackVariant="secondary"
                data-testid="button-hero-events"
              >
                <Calendar className="w-4 h-4 mr-2" />
                Browse Events
              </TenantCtaButton>
              <Button
                variant="outline"
                size="lg"
                className="bg-white/10 border-white/40 text-white"
                asChild
                data-testid="button-hero-resources"
              >
                <Link to={createPageUrl("Resources")}>
                  <BookOpen className="w-4 h-4 mr-2" />
                  Explore Resources
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats strip ───────────────────────────────────── */}
      <section className="border-b bg-muted/40" data-testid="section-stats">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { label: "Member Organisations", value: "90+" },
              { label: "Countries Represented", value: "50+" },
              { label: "Resources Available", value: "420+" },
              { label: "Community Posts", value: "1,800+" },
            ].map(({ label, value }) => (
              <div key={label} data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>
                <p className="text-2xl font-bold text-foreground">{value}</p>
                <p className="text-sm text-muted-foreground mt-1">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6 py-12 space-y-16">
        {/* ── Upcoming Events ────────────────────────────── */}
        <section data-testid="section-events">
          <SectionHeader
            icon={Calendar}
            title="Upcoming Events"
            linkLabel="All Events"
            linkTo={createPageUrl("Events")}
            testPrefix="events"
          />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SAMPLE_EVENTS.map((event) => (
              <Card
                key={event.id}
                className="overflow-hidden flex flex-col hover-elevate"
                data-testid={`card-event-${event.id}`}
              >
                <div className="h-44 overflow-hidden bg-muted relative">
                  <img
                    src={event.image}
                    alt={event.title}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                  <Badge
                    className="absolute top-3 left-3 no-default-hover-elevate no-default-active-elevate"
                    style={{ backgroundColor: event.typeBg, color: event.typeColor, border: "none" }}
                    data-testid={`badge-event-type-${event.id}`}
                  >
                    {event.type}
                  </Badge>
                </div>
                <CardContent className="flex flex-col flex-1 pt-4 pb-5 gap-3">
                  <h3 className="font-semibold text-base leading-snug line-clamp-2">
                    {event.title}
                  </h3>
                  <div className="space-y-1.5 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-3.5 h-3.5 shrink-0" />
                      <span>{event.date}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 shrink-0" />
                      <span>{event.location}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Users className="w-3.5 h-3.5 shrink-0" />
                      <span>{event.spotsLeft} places remaining</span>
                    </div>
                  </div>
                  <div className="mt-auto pt-2">
                    <TenantCtaButton
                      as="link"
                      to={createPageUrl("Events")}
                      className="w-full"
                      fallbackVariant="default"
                      data-testid={`button-event-register-${event.id}`}
                    >
                      Register
                    </TenantCtaButton>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* ── Resources ─────────────────────────────────── */}
        <section data-testid="section-resources">
          <SectionHeader
            icon={Layers}
            title="Member Resources"
            linkLabel="All Resources"
            linkTo={createPageUrl("Resources")}
            testPrefix="resources"
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SAMPLE_RESOURCES.map((res) => (
              <Card
                key={res.id}
                className="flex flex-col hover-elevate"
                data-testid={`card-resource-${res.id}`}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <Badge
                        variant="secondary"
                        className="text-xs mb-2 no-default-hover-elevate no-default-active-elevate"
                        data-testid={`badge-resource-category-${res.id}`}
                      >
                        {res.category}
                      </Badge>
                      <CardTitle className="text-base leading-snug line-clamp-2">
                        {res.title}
                      </CardTitle>
                    </div>
                    <div className="shrink-0 mt-1 text-muted-foreground">
                      <ResourceIcon type={res.type} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col flex-1 pt-0 gap-4">
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {res.description}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{res.date}</span>
                    <TenantCtaButton
                      as="link"
                      to={createPageUrl("Resources")}
                      size="sm"
                      fallbackVariant="outline"
                      data-testid={`button-resource-access-${res.id}`}
                    >
                      <ResourceLabel type={res.type} />
                      <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                    </TenantCtaButton>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* ── Articles ──────────────────────────────────── */}
        <section data-testid="section-articles">
          <SectionHeader
            icon={BookOpen}
            title="Latest Articles"
            linkLabel="All Articles"
            linkTo={createPageUrl("Articles")}
            testPrefix="articles"
          />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SAMPLE_ARTICLES.map((article) => (
              <Card
                key={article.id}
                className="overflow-hidden flex flex-col hover-elevate"
                data-testid={`card-article-${article.id}`}
              >
                {article.image && (
                  <div className="h-40 overflow-hidden bg-muted">
                    <img
                      src={article.image}
                      alt={article.title}
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <CardContent className="flex flex-col flex-1 pt-4 pb-5 gap-3">
                  <Badge
                    variant="secondary"
                    className="self-start text-xs no-default-hover-elevate no-default-active-elevate"
                    data-testid={`badge-article-category-${article.id}`}
                  >
                    {article.category}
                  </Badge>
                  <h3 className="font-semibold text-base leading-snug line-clamp-2">
                    {article.title}
                  </h3>
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {article.summary}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                    <span className="text-xs text-muted-foreground">
                      {article.author} · {article.date}
                    </span>
                    <TenantCtaButton
                      as="link"
                      to={createPageUrl("Articles")}
                      size="sm"
                      fallbackVariant="ghost"
                      data-testid={`button-article-read-${article.id}`}
                    >
                      Read
                      <ArrowRight className="w-3.5 h-3.5 ml-1" />
                    </TenantCtaButton>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* ── Forum ─────────────────────────────────────── */}
        <section data-testid="section-forum">
          <SectionHeader
            icon={MessageSquare}
            title="Community Forum"
            linkLabel="Go to Forum"
            linkTo={createPageUrl("Forum")}
            testPrefix="forum"
          />
          <Card>
            <div className="divide-y">
              {SAMPLE_THREADS.map((thread) => {
                const colour = avatarColour(thread.author);
                return (
                  <div
                    key={thread.id}
                    className="flex items-start gap-4 px-5 py-4 cursor-pointer hover-elevate"
                    onClick={() => navigate(createPageUrl("Forum"))}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && navigate(createPageUrl("Forum"))}
                    data-testid={`row-thread-${thread.id}`}
                  >
                    <Avatar className={`h-9 w-9 shrink-0 mt-0.5 ${colour.bg}`}>
                      <AvatarFallback className={`text-xs font-medium ${colour.bg} ${colour.text}`}>
                        {initials(thread.author)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {thread.pinned && (
                          <Badge
                            variant="outline"
                            className="text-xs bg-warning/10 text-warning border-warning/30 no-default-hover-elevate no-default-active-elevate"
                            data-testid={`badge-thread-pinned-${thread.id}`}
                          >
                            <Pin className="w-3 h-3 mr-0.5" />
                            Pinned
                          </Badge>
                        )}
                        <span
                          className="font-medium text-sm leading-snug"
                          data-testid={`text-thread-title-${thread.id}`}
                        >
                          {thread.title}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        by {thread.author} · {thread.lastActivity}
                      </p>
                    </div>
                    <div className="hidden sm:flex items-center gap-4 shrink-0 text-muted-foreground text-sm">
                      <div className="flex items-center gap-1" data-testid={`text-thread-replies-${thread.id}`}>
                        <MessageCircle className="w-3.5 h-3.5 text-indigo-400 dark:text-indigo-500" />
                        {thread.replies}
                      </div>
                      <div className="flex items-center gap-1" data-testid={`text-thread-views-${thread.id}`}>
                        <Eye className="w-3.5 h-3.5 text-blue-400 dark:text-blue-500" />
                        {thread.views}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-3 border-t bg-muted/30 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                asChild
                data-testid="button-forum-view-all"
              >
                <Link to={createPageUrl("Forum")}>
                  View all discussions
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </div>
          </Card>
        </section>
      </div>

      {/* ── Footer CTA ────────────────────────────────── */}
      <section
        className="border-t bg-muted/30 mt-8"
        data-testid="section-footer-cta"
      >
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div>
            <h3 className="font-semibold text-lg">Ready to dive in?</h3>
            <p className="text-muted-foreground text-sm mt-1">
              Update your profile and set your preferences to personalise your
              experience.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 shrink-0">
            <Button
              variant="outline"
              asChild
              data-testid="button-footer-preferences"
            >
              <Link to={createPageUrl("Preferences")}>My Profile</Link>
            </Button>
            <TenantCtaButton
              as="link"
              to={createPageUrl("Events")}
              fallbackVariant="default"
              data-testid="button-footer-events"
            >
              Browse Events
              <ArrowRight className="w-4 h-4 ml-2" />
            </TenantCtaButton>
          </div>
        </div>
      </section>
    </div>
  );
}
