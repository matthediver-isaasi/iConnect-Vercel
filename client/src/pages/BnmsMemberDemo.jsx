import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import TenantCtaButton from "@/components/common/TenantCtaButton";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  User,
  Calendar,
  CreditCard,
  Layers,
  RefreshCw,
  Building2,
  Users,
  UsersRound,
  Landmark,
  Mail,
  Newspaper,
  UserCircle2,
  BookOpen,
  Search,
  Trophy,
} from "lucide-react";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { createPageUrl } from "@/utils";

const HERO_IMAGE =
  "https://images.unsplash.com/photo-1560439514-4e9645039924?w=1600&q=80";
const JOURNAL_IMAGE =
  "https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=600&q=80";

const BENEFIT_CARDS = [
  {
    id: "journal",
    tag: "VALUED AT OVER $1,000 PER YEAR",
    title: "Nuclear Medicine Communications",
    image: JOURNAL_IMAGE,
    description:
      "Your official journal includes monthly issues, clinical research, editorials, reviews and the complete online archive.",
    cta: "Read Online Journal",
    to: createPageUrl("Resources"),
  },
  {
    id: "directory",
    icon: Building2,
    title: "Departmental Directory Search",
    description:
      "Search for Nuclear Medicine and Radiopharmacy departments across the UK and beyond.",
    cta: "Search Directory",
    to: createPageUrl("OrganisationDirectory"),
  },
  {
    id: "member-search",
    icon: Users,
    title: "Member Search",
    description:
      "Find and connect with colleagues across the BNMS community.",
    cta: "Search Members",
    to: createPageUrl("MemberDirectory"),
  },
  {
    id: "groups",
    icon: UsersRound,
    title: "Groups",
    description:
      "Join in group discussions, share knowledge and collaborate with your peers.",
    cta: "View My Groups",
    to: createPageUrl("MemberGroups"),
  },
];

const MORE_BENEFITS = [
  {
    id: "tax-relief",
    icon: Landmark,
    title: "Claim Tax Relief",
    blurb: "Find out how to claim tax relief on your BNMS membership subscription.",
    link: "Find out more",
    to: "#",
  },
  {
    id: "communication",
    icon: Mail,
    title: "Communication",
    blurb: "Manage how we communicate with you and stay up to date with the latest news.",
    link: "Read more",
    to: createPageUrl("Preferences"),
  },
  {
    id: "editorial",
    icon: Newspaper,
    title: "BNMS Latest Editorial",
    blurb: "View the latest Editorial from Nuclear Medicine Communications.",
    link: "View here",
    to: "#",
  },
  {
    id: "member-area",
    icon: UserCircle2,
    title: "Member Area",
    blurb: "Access the latest news, updates and exclusive member content.",
    link: "Sign In",
    to: createPageUrl("Dashboard"),
  },
  {
    id: "online-journal",
    icon: BookOpen,
    title: "Online Journal",
    blurb: 'Monthly issue of our official journal "Nuclear Medicine Communications" (cost $870 to non-members).',
    link: "Read more",
    to: "#",
  },
  {
    id: "dept-directory",
    icon: Building2,
    title: "Departmental Directory Search",
    blurb: "Search for NM and Radiopharmacy departments.",
    link: "Directory Search",
    to: createPageUrl("OrganisationDirectory"),
  },
  {
    id: "member-search",
    icon: Search,
    title: "Member Search",
    blurb: "Find and connect with your peers.",
    link: "Member Search",
    to: createPageUrl("MemberDirectory"),
  },
  {
    id: "achievements",
    icon: Trophy,
    title: "BNMS Achievements 2024",
    blurb: "Follow our progress and achievements throughout the year.",
    link: "Read more",
    to: "#",
  },
];

const DD_BENEFITS = [
  "Never miss a payment",
  "Continuous access to benefits",
  "Easy to manage and cancel anytime",
];

const MEMBERSHIP_FACTS = [
  { icon: User, label: "Member since", value: "2018" },
  { icon: Layers, label: "Membership type", value: "Full Member" },
  { icon: CreditCard, label: "Payment method", value: "Monthly Direct Debit" },
  { icon: Calendar, label: "Next payment", value: "1 August 2026" },
];

export default function BnmsMemberDemo() {
  const { tenantSlug, loading } = useTenantBranding();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && tenantSlug && tenantSlug.toLowerCase() !== "bnms") {
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

  if (tenantSlug && tenantSlug.toLowerCase() !== "bnms") {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="relative" data-testid="section-hero">
        <div className="relative overflow-hidden">
          <img
            src={HERO_IMAGE}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            aria-hidden="true"
          />
          <div
            className="absolute inset-0 bg-gradient-to-r from-[#1d5ba6]/95 via-[#1d5ba6]/70 to-black/30"
            aria-hidden="true"
          />
          <div className="relative max-w-6xl mx-auto px-6 pt-14 md:pt-20 pb-40 md:pb-44">
            <div className="max-w-xl">
              <h1
                className="text-3xl md:text-5xl font-bold text-white leading-tight mb-4"
                data-testid="text-hero-greeting"
              >
                Good morning, Sharon
              </h1>
              <p className="text-white text-lg md:text-xl font-medium mb-3">
                Welcome back to your BNMS Member Hub
              </p>
              <p className="text-white/80 text-base mb-8">
                All your member benefits, resources and community in one place.
              </p>
              <TenantCtaButton
                as="link"
                to={createPageUrl("MembershipFees")}
                size="lg"
                fallbackVariant="default"
                fallbackClassName="rounded-full"
                data-testid="button-hero-join"
              >
                Join BNMS
              </TenantCtaButton>
            </div>
          </div>
        </div>

        {/* ── Overlapping cards ─────────────────────────── */}
        <div className="max-w-6xl mx-auto px-6 -mt-32 md:-mt-32 relative z-10">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2" data-testid="card-membership-status">
              <CardContent className="p-6 md:p-8">
                <div className="flex items-start gap-4 flex-wrap">
                  <div className="shrink-0 w-14 h-14 rounded-full bg-[#1d5ba6] flex items-center justify-center">
                    <User className="w-7 h-7 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold tracking-wider text-[#1d5ba6] dark:text-blue-300 uppercase mb-1">
                      Full Member
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-2xl font-bold" data-testid="text-membership-active">
                        Membership Active
                      </h2>
                      <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400 shrink-0" />
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Thank you for being a valued member of BNMS.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-8">
                  {MEMBERSHIP_FACTS.map(({ icon: Icon, label, value }) => (
                    <div key={label} data-testid={`fact-${label.toLowerCase().replace(/\s+/g, "-")}`}>
                      <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="text-xs">{label}</span>
                      </div>
                      <p className="font-semibold text-sm">{value}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-payment-method">
              <CardContent className="p-6 md:p-8 flex flex-col gap-4 h-full">
                <p className="text-xs font-semibold tracking-wider text-[#1d5ba6] dark:text-blue-300 uppercase">
                  Payment Method
                </p>
                <div className="rounded-md bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900 p-4">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm text-muted-foreground">You are paying by</p>
                      <p className="font-bold text-lg leading-tight">Direct Debit</p>
                      <Link
                        to={createPageUrl("Balances")}
                        className="inline-flex items-center gap-1 text-sm font-medium text-[#1d5ba6] dark:text-blue-300 mt-2"
                        data-testid="link-payment-history"
                      >
                        View payment history
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    </div>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Direct Debit is the most convenient way to stay connected and
                  never miss out on member benefits.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* ── Direct Debit banner ─────────────────────── */}
          <Card className="mt-6 bg-blue-50/60 dark:bg-blue-950/30" data-testid="card-dd-banner">
            <CardContent className="p-6 md:p-8">
              <div className="flex flex-col lg:flex-row lg:items-center gap-6">
                <div className="flex items-start gap-4 flex-1 min-w-0">
                  <div className="shrink-0 w-12 h-12 rounded-full border-2 border-[#1d5ba6] dark:border-blue-300 flex items-center justify-center">
                    <RefreshCw className="w-5 h-5 text-[#1d5ba6] dark:text-blue-300" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">Not on Direct Debit?</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Switch to Direct Debit for hassle-free payments and
                      continuous access to all your BNMS benefits.
                    </p>
                  </div>
                </div>
                <ul className="space-y-2 shrink-0">
                  {DD_BENEFITS.map((b) => (
                    <li key={b} className="flex items-center gap-2 text-sm">
                      <Check className="w-4 h-4 text-[#1d5ba6] dark:text-blue-300 shrink-0" />
                      {b}
                    </li>
                  ))}
                </ul>
                <div className="shrink-0">
                  <TenantCtaButton
                    as="link"
                    to="#"
                    fallbackVariant="default"
                    data-testid="button-upgrade-dd"
                  >
                    Upgrade to Direct Debit
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </TenantCtaButton>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Benefit cards ───────────────────────────── */}
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 mt-10">
            {BENEFIT_CARDS.map((card) => (
              <Card key={card.id} className="flex flex-col" data-testid={`card-benefit-${card.id}`}>
                <CardContent className="p-6 flex flex-col flex-1 gap-4">
                  {card.tag && (
                    <p className="text-[10px] font-semibold tracking-wider text-[#1d5ba6] dark:text-blue-300 uppercase -mb-2">
                      {card.tag}
                    </p>
                  )}
                  {card.icon ? (
                    <div className="w-16 h-16 rounded-full bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center">
                      <card.icon className="w-8 h-8 text-[#1d5ba6] dark:text-blue-300" />
                    </div>
                  ) : null}
                  <h3 className="font-bold text-lg leading-snug">{card.title}</h3>
                  {card.image && (
                    <div className="rounded-md overflow-hidden bg-muted h-32">
                      <img
                        src={card.image}
                        alt={card.title}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground flex-1">
                    {card.description}
                  </p>
                  <div>
                    <TenantCtaButton
                      as="link"
                      to={card.to}
                      size="sm"
                      fallbackVariant="default"
                      data-testid={`button-benefit-${card.id}`}
                    >
                      {card.cta}
                      <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                    </TenantCtaButton>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* ── More member benefits ────────────────────── */}
          <section className="mt-14" data-testid="section-more-benefits">
            <h2 className="text-2xl font-bold mb-6">More member benefits</h2>
            <div className="grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
              {MORE_BENEFITS.map((item) => (
                <div key={item.id} className="flex items-start gap-3" data-testid={`benefit-${item.id}`}>
                  <div className="shrink-0 w-10 h-10 rounded-full border border-border flex items-center justify-center">
                    <item.icon className="w-5 h-5 text-[#1d5ba6] dark:text-blue-300" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-sm">{item.title}</h3>
                    <p className="text-xs text-muted-foreground mt-1">{item.blurb}</p>
                    <Link
                      to={item.to}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-orange-600 dark:text-orange-400 mt-2"
                      data-testid={`link-benefit-${item.id}`}
                    >
                      {item.link}
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>

      {/* ── Closing banner ─────────────────────────────── */}
      <section className="mt-14 bg-[#1d5ba6]" data-testid="section-closing-banner">
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex shrink-0 w-14 h-14 rounded-full border-2 border-white/40 items-center justify-center">
              <Users className="w-7 h-7 text-white" />
            </div>
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-white">
                Together, advancing nuclear medicine
              </h2>
              <p className="text-white/80 text-sm mt-1">
                BNMS membership connects you with knowledge, people and
                opportunities to advance the specialty.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="lg"
            className="shrink-0 bg-white/10 border-white/50 text-white backdrop-blur-sm"
            asChild
            data-testid="button-explore-benefits"
          >
            <Link to={createPageUrl("Dashboard")}>
              Explore all benefits
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
