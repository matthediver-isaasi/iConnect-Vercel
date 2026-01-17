
import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, CreditCard, Ticket, Wallet, ArrowRight, CheckCircle2 } from "lucide-react";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";

export default function DashboardPage() {
  const { memberInfo, organizationInfo } = useMemberAccess();
  const { branding } = useTenantBranding();
  const tenantName = branding?.name;

  if (!memberInfo || !organizationInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const totalProgramTickets = organizationInfo.program_ticket_balances 
    ? Object.values(organizationInfo.program_ticket_balances).reduce((sum, val) => sum + val, 0)
    : 0;

  const features = [
    {
      icon: Calendar,
      title: "Browse Events",
      description: tenantName 
        ? `Explore our comprehensive calendar of professional development events, training sessions, and networking opportunities tailored for ${tenantName} members.`
        : 'Explore our comprehensive calendar of professional development events, training sessions, and networking opportunities.',
      link: createPageUrl('Events'),
      linkText: "View Events",
      color: "blue"
    },
    {
      icon: CreditCard,
      title: "My Bookings",
      description: "View and manage all your event registrations in one place. Track your upcoming events and download booking confirmations.",
      link: createPageUrl('MyBookings'),
      linkText: "View Bookings",
      color: "green"
    },
    {
      icon: Ticket,
      title: "Program Tickets",
      description: "Purchase and manage program-specific tickets that give you flexible access to events within designated training programs.",
      link: createPageUrl('BuyProgramTickets'),
      linkText: "Buy Tickets",
      color: "purple"
    },
    {
      icon: Wallet,
      title: "Account Balances",
      description: "Monitor your organisation's training fund balance and available vouchers. Keep track of your professional development budget.",
      link: createPageUrl('Balances'),
      linkText: "View Balances",
      color: "indigo"
    }
  ];

  const steps = [
    "Browse available events and filter by program",
    "Check your organisation's available tickets and vouchers",
    "Register yourself or colleagues for events",
    "Manage your bookings and track attendance"
  ];

  const colorClasses = {
    blue: { bg: "from-blue-600 to-indigo-600", icon: "bg-blue-100 text-blue-600", border: "border-blue-200" },
    green: { bg: "from-green-600 to-emerald-600", icon: "bg-green-100 text-green-600", border: "border-green-200" },
    purple: { bg: "from-purple-600 to-pink-600", icon: "bg-purple-100 text-purple-600", border: "border-purple-200" },
    indigo: { bg: "from-indigo-600 to-blue-600", icon: "bg-indigo-100 text-indigo-600", border: "border-indigo-200" }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* Hero Section */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-16 px-4 md:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="max-w-3xl">
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              Welcome back, {memberInfo.first_name}!
            </h1>
            <p className="text-xl text-blue-100 mb-8">
              Your professional development journey starts here. Book training events, manage your tickets, and stay connected with {tenantName ? `the ${tenantName} community` : 'our community'}.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link to={createPageUrl('Events')}>
                <Button size="lg" className="bg-white text-blue-600 hover:bg-blue-50">
                  Browse Events
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              </Link>
              <Link to={createPageUrl('MyBookings')}>
                <Button size="lg" className="bg-white text-blue-600 hover:bg-blue-50">
                  My Bookings
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="max-w-7xl mx-auto px-4 md:px-8 -mt-8 mb-12">
        <div className="grid md:grid-cols-3 gap-6">
          <Card className="border-slate-200 shadow-lg">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Organisation</p>
                  <p className="text-xl font-bold text-slate-900">{organizationInfo.name}</p>
                </div>
                <div className="p-3 bg-blue-100 rounded-lg">
                  <Calendar className="w-6 h-6 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-lg">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Training Fund</p>
                  <p className="text-xl font-bold text-green-600">£{(organizationInfo.training_fund_balance || 0).toFixed(2)}</p>
                </div>
                <div className="p-3 bg-green-100 rounded-lg">
                  <Wallet className="w-6 h-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-lg">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-600 mb-1">Program Tickets</p>
                  <p className="text-xl font-bold text-purple-600">{totalProgramTickets}</p>
                </div>
                <div className="p-3 bg-purple-100 rounded-lg">
                  <Ticket className="w-6 h-6 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* How It Works */}
      <div className="max-w-7xl mx-auto px-4 md:px-8 mb-12">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="border-b border-slate-200">
            <CardTitle className="text-2xl">How to Use This Portal</CardTitle>
            <CardDescription className="text-base mt-2">
              Follow these simple steps to make the most of your {tenantName ? `${tenantName} membership` : 'membership'}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
              {steps.map((step, index) => (
                <div key={index} className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center font-bold">
                    {index + 1}
                  </div>
                  <p className="text-slate-700 pt-1">{step}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Features Grid */}
      <div className="max-w-7xl mx-auto px-4 md:px-8 pb-12">
        <h2 className="text-3xl font-bold text-slate-900 mb-8">Portal Features</h2>
        <div className="grid md:grid-cols-2 gap-6">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            const colors = colorClasses[feature.color];
            
            return (
              <Card key={index} className={`border-2 ${colors.border} hover:shadow-xl transition-all`}>
                <CardHeader>
                  <div className="flex items-start justify-between mb-4">
                    <div className={`p-3 ${colors.icon} rounded-lg`}>
                      <Icon className="w-6 h-6" />
                    </div>
                  </div>
                  <CardTitle className="text-xl mb-2">{feature.title}</CardTitle>
                  <CardDescription className="text-base text-slate-600">
                    {feature.description}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Link to={feature.link}>
                    <Button className={`w-full bg-gradient-to-r ${colors.bg} hover:opacity-90`}>
                      {feature.linkText}
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Support Section */}
      <div className="max-w-7xl mx-auto px-4 md:px-8 pb-16">
        <Card className="border-slate-200 shadow-sm bg-gradient-to-r from-slate-50 to-blue-50">
          <CardContent className="p-8 text-center">
            <h3 className="text-2xl font-bold text-slate-900 mb-3">Need Help?</h3>
            <p className="text-slate-600 mb-6 max-w-2xl mx-auto">
              If you have any questions about using the portal, booking events, or managing your account, 
              please don't hesitate to contact your {tenantName ? `${tenantName} membership` : 'membership'} administrator.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <span className="text-sm text-slate-600">Easy event booking</span>
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <span className="text-sm text-slate-600">Flexible ticket management</span>
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <span className="text-sm text-slate-600">Real-time balance tracking</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
