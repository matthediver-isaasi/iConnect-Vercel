import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { Mail, MapPin, Phone, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import PublicHeader from "./PublicHeader";
import PageBannerDisplay from "../banners/PageBannerDisplay";
import PortalHeroBanner from "../banners/PortalHeroBanner";
import FloaterDisplay from "../floaters/FloaterDisplay";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { BannerProvider } from "@/contexts/BannerContext";
import IEditFormElement from "../iedit/elements/IEditFormElement";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";

// Map page names to portal page identifiers for banner matching
// These identifiers must match the PORTAL_PAGES values in PageBannerManagement.jsx
// Note: Public versions of pages (e.g., PublicArticles, PublicResources) should map to the same identifier
const pageToPortalPageMap = {
  'Events': 'portal_events',
  'PublicEvents': 'portal_events',
  'Bookings': 'portal_bookings',
  'MyTickets': 'portal_my_tickets',
  'BuyProgramTickets': 'portal_buy_tickets',
  'MemberDirectory': 'portal_member_directory',
  'OrganisationDirectory': 'portal_org_directory',
  'Resources': 'portal_resources',
  'PublicResources': 'portal_resources',
  'Articles': 'portal_articles',
  'PublicArticles': 'portal_articles',
  'Team': 'portal_team',
  'Balances': 'portal_balances',
  'History': 'portal_history',
  'Profile': 'portal_profile',
  'MyOrganisation': 'portal_my_organisation',
  'JobBoard': 'portal_job_board',
  'PublicJobBoard': 'portal_job_board',
  'News': 'portal_news',
  'PublicNews': 'portal_news',
  'NewsView': 'portal_news_view',
  'MyJobPostings': 'portal_my_job_postings',
  'Preferences': 'portal_about_me',
  'about-me': 'portal_about_me',
  'Support': 'portal_support',
  'Dashboard': 'portal_dashboard'
};

export default function PublicLayout({ children, currentPageName }) {
  const { getPublicArticlesUrl, articleDisplayName, urlSlug, publicSlug, isCustomSlug, isLoading: articleUrlLoading } = useArticleUrl();
  const { branding, hasBranding } = useTenantBranding();
  const [banners, setBanners] = useState([]);
  const [loadingBanners, setLoadingBanners] = useState(true);
  const [showNewsletterDialog, setShowNewsletterDialog] = useState(false);
  const [socialIcons, setSocialIcons] = useState(null);
  const [footerConfig, setFooterConfig] = useState(null);
  const [newsletterFormSlug, setNewsletterFormSlug] = useState(null);

  const tenantFooterConfig = branding?.footerConfig || {};
  const tenantPrimaryColor = branding?.primaryColor || '#5C0085';
  
  const getGradientStyle = () => {
    if (tenantFooterConfig.gradientColors?.length > 0) {
      return `linear-gradient(to right, ${tenantFooterConfig.gradientColors.join(', ')})`;
    }
    return `linear-gradient(to right, ${tenantPrimaryColor}, #BA0087, #EE00C3, #FF4229, #FFB000)`;
  };
  
  const getButtonGradientStyle = () => {
    if (tenantFooterConfig.gradientColors?.length > 0) {
      return `linear-gradient(to top right, ${tenantFooterConfig.gradientColors.join(', ')})`;
    }
    return `linear-gradient(to top right, ${tenantPrimaryColor}, #BA0087, #EE00C3, #FF4229, #FFB000)`;
  };

  // Fetch social icons, footer configuration, and newsletter form slug
  useEffect(() => {
    const fetchConfigs = async () => {
      try {
        const allSettings = await base44.entities.SystemSettings.list();
        
        const socialSetting = allSettings.find(s => s.setting_key === 'social_icons_config');
        if (socialSetting?.setting_value) {
          try {
            setSocialIcons(JSON.parse(socialSetting.setting_value));
          } catch (e) {
            console.error('Failed to parse social icons config:', e);
          }
        }
        
        const footerSetting = allSettings.find(s => s.setting_key === 'footer_config');
        if (footerSetting?.setting_value) {
          try {
            setFooterConfig(JSON.parse(footerSetting.setting_value));
          } catch (e) {
            console.error('Failed to parse footer config:', e);
          }
        }

        const newsletterSetting = allSettings.find(s => s.setting_key === 'newsletter_signup_form_id');
        if (newsletterSetting?.setting_value && newsletterSetting.setting_value !== 'none') {
          // Fetch the form to get its slug
          try {
            const form = await base44.entities.Form.get(newsletterSetting.setting_value);
            if (form?.is_active && form?.slug) {
              setNewsletterFormSlug(form.slug);
            } else {
              setNewsletterFormSlug(null);
            }
          } catch (e) {
            console.error('Failed to fetch newsletter form:', e);
            setNewsletterFormSlug(null);
          }
        } else {
          setNewsletterFormSlug(null);
        }
      } catch (error) {
        console.error('Failed to fetch configs:', error);
      }
    };

    fetchConfigs();
  }, []);

  const handleNewsletterDialogChange = (open) => {
    setShowNewsletterDialog(open);
  };

  // Resolve page name to portal page ID, accounting for dynamic article URL remapping
  const resolvePortalPageId = (pageName) => {
    // First check static map
    if (pageToPortalPageMap[pageName]) {
      return pageToPortalPageMap[pageName];
    }
    
    // Handle dynamic article slugs - if articles are renamed (e.g., to "Blog"),
    // the URLs change but banners are still associated with portal_articles
    // Check both when isCustomSlug is true AND by matching common article-related patterns
    const lowerPageName = pageName?.toLowerCase() || '';
    const lowerUrlSlug = urlSlug?.toLowerCase() || '';
    const lowerPublicSlug = publicSlug?.toLowerCase() || '';
    
    // Check if this page matches the custom article slugs or common article patterns
    if (lowerPageName === lowerUrlSlug || 
        lowerPageName === lowerPublicSlug ||
        lowerPageName === 'articles' ||
        lowerPageName === 'publicarticles' ||
        // Also check for blog-related patterns as common renames
        lowerPageName === 'blog' ||
        lowerPageName === 'publicblog' ||
        lowerPageName === 'blogs' ||
        lowerPageName === 'publicblogs') {
      return 'portal_articles';
    }
    
    return null;
  };

  // Fetch banners for current page - wait for article URL context to load first
  // Uses public API endpoint to ensure banners load for logged-out users
  useEffect(() => {
    const fetchBanners = async () => {
      // Wait for article URL context to finish loading before resolving page IDs
      if (articleUrlLoading) {
        return;
      }
      
      if (!currentPageName) {
        setLoadingBanners(false);
        return;
      }

      try {
        // Use public API endpoint that doesn't require authentication
        const response = await fetch('/api/public/banners');
        if (!response.ok) {
          throw new Error('Failed to fetch banners');
        }
        const allBanners = await response.json();
        
        // Get the portal page identifier for this page (handles dynamic article slugs)
        const portalPageId = resolvePortalPageId(currentPageName);
        
        console.log('[PublicLayout] Fetching banners for page:', currentPageName, 'portalPageId:', portalPageId, 'isCustomSlug:', isCustomSlug, 'urlSlug:', urlSlug);
        console.log('[PublicLayout] All banners found:', allBanners?.length);
        console.log('[PublicLayout] pageToPortalPageMap keys:', Object.keys(pageToPortalPageMap));
        
        // Debug: log all banners with their associated_pages for MyOrganisation troubleshooting
        if (currentPageName === 'MyOrganisation') {
          console.log('[PublicLayout] MyOrganisation DEBUG - looking for portal_my_organisation');
          allBanners.forEach(b => {
            console.log('[PublicLayout] Banner:', b.name, 'associated_pages:', b.associated_pages);
          });
        }
        
        // Filter banners that include this page (check both portal ID and page name for compatibility)
        const pageBanners = allBanners
          .filter(banner => {
            if (!banner.associated_pages) return false;
            const matches = banner.associated_pages.includes(portalPageId) || 
                   banner.associated_pages.includes(currentPageName);
            if (matches) {
              console.log('[PublicLayout] Matched banner:', banner.name, banner.associated_pages);
            }
            return matches;
          })
          .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
        
        console.log('[PublicLayout] Matched banners:', pageBanners.length);
        setBanners(pageBanners);
      } catch (error) {
        console.error('Failed to fetch banners:', error);
      } finally {
        setLoadingBanners(false);
      }
    };

    fetchBanners();
  }, [currentPageName, isCustomSlug, urlSlug, publicSlug, articleUrlLoading]);

  // Split banners by page_position
  const topBanners = useMemo(() => 
    banners.filter(b => !b.page_position || b.page_position === 'top'),
    [banners]
  );
  
  const belowFirstElementBanners = useMemo(() => 
    banners.filter(b => b.page_position === 'below_first_element'),
    [banners]
  );

  return (
    <>
      <div className="flex flex-col min-h-screen" style={{ fontFamily: 'Poppins, sans-serif' }}>
        {/* Google Fonts - Poppins */}
        <style>
          {`
            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap');

            @font-face {
              font-family: 'Degular Medium';
              src: url('https://teeone.pythonanywhere.com/font-assets/Degular-Medium.woff') format('woff');
              font-weight: 500;
              font-style: normal;
              font-display: swap;
            }
            
            h1 {
              font-family: 'Degular Medium', 'Poppins', sans-serif;
            }
            
            .nav-link:hover {
              color: #5C0085 !important;
            }
          `}
        </style>

        {/* Public Header - Now using dedicated component */}
        <PublicHeader />

        {/* Top Page Banners - Displayed between header and main content */}
        {!loadingBanners && topBanners.length > 0 && (
          <div className="w-full">
            {topBanners.map((banner) => (
              banner.banner_type === 'image'
                ? <PageBannerDisplay key={banner.id} banner={banner} />
                : <PortalHeroBanner key={banner.id} banner={banner} />
            ))}
          </div>
        )}

        {/* Main Content Area - wrapped in BannerProvider for below-first-element banners */}
        <main className="flex-1">
          <BannerProvider belowFirstElementBanners={belowFirstElementBanners}>
            {children}
          </BannerProvider>
        </main>

        {/* Public Footer */}
        <footer className="bg-black text-white">
          {/* Gradient Bar */}
          <div 
            className="w-full"
            style={{ 
              height: '5px',
              background: getGradientStyle()
            }}
          />
          <div className="max-w-7xl mx-auto px-4 py-16">
            <div className="grid md:grid-cols-3 gap-12">
              
              {/* Left Column - Become a Member & Newsletter */}
              <div className="flex flex-col justify-start">
                <h2 
                  className="text-3xl text-white mb-8"
                  style={{ fontFamily: "'Degular Medium', sans-serif" }}
                >
                  {tenantFooterConfig.ctaText || 'Become a member today'}
                </h2>
                <Link to={createPageUrl(tenantFooterConfig.ctaLink || 'Membership')}>
                  <Button 
                    className="text-white font-bold hover:opacity-90 transition-opacity px-6 py-5 rounded-none" 
                    style={{ 
                      fontFamily: 'Poppins, sans-serif',
                      background: getButtonGradientStyle()
                    }}
                  >
                    {tenantFooterConfig.ctaButtonText || 'Join Us'}
                    <ArrowUpRight className="ml-0.5 w-5 h-5" strokeWidth={2.5} />
                  </Button>
                </Link>

                {/* Newsletter Signup - only show if a form is configured */}
                {newsletterFormSlug && (
                  <>
                    <h2 
                      className="text-3xl text-white mb-8 mt-12"
                      style={{ fontFamily: "'Degular Medium', sans-serif" }}
                    >{tenantFooterConfig.newsletterText || 'Sign up to our newsletter'}</h2>
                    <div>
                      <Button 
                        onClick={() => setShowNewsletterDialog(true)}
                        className="text-white font-bold hover:opacity-90 transition-opacity px-6 py-5 rounded-none" 
                        style={{ 
                          fontFamily: 'Poppins, sans-serif',
                          background: getButtonGradientStyle()
                        }}
                        data-testid="button-newsletter-signup"
                      >
                        Sign up
                        <ArrowUpRight className="ml-0.5 w-5 h-5" strokeWidth={2.5} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              {/* Middle Column - Address & Contact */}
              <div className="space-y-8">
                {/* Address Section */}
                {(tenantFooterConfig.address?.lines?.length > 0 || tenantFooterConfig.address?.name || !hasBranding) && (
                  <div>
                    <h4 
                      className="text-white text-sm mb-3"
                      style={{ 
                        fontFamily: 'Poppins, sans-serif',
                        textTransform: 'uppercase',
                        letterSpacing: '5px'
                      }}
                    >
                      ADDRESS
                    </h4>
                    <div 
                      className="mb-4"
                      style={{ 
                        width: '36px', 
                        height: '2px', 
                        backgroundColor: 'rgba(255,255,255,0.5)' 
                      }}
                    />
                    <div className="text-slate-300 text-sm leading-relaxed" style={{ fontFamily: 'Poppins, sans-serif' }}>
                      {hasBranding && tenantFooterConfig.address ? (
                        <>
                          {tenantFooterConfig.address.name && <p>{tenantFooterConfig.address.name}</p>}
                          {tenantFooterConfig.address.lines?.map((line, i) => <p key={i}>{line}</p>)}
                        </>
                      ) : (
                        <>
                          <p>{branding?.name || 'Organization Name'}</p>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Contact Section */}
                {(tenantFooterConfig.contact?.phone || tenantFooterConfig.contact?.email || !hasBranding) && (
                  <div>
                    <h4 
                      className="text-white text-sm mb-3"
                      style={{ 
                        fontFamily: 'Poppins, sans-serif',
                        textTransform: 'uppercase',
                        letterSpacing: '5px'
                      }}
                    >
                      CONTACT US
                    </h4>
                    <div 
                      className="mb-4"
                      style={{ 
                        width: '36px', 
                        height: '2px', 
                        backgroundColor: 'rgba(255,255,255,0.5)' 
                      }}
                    />
                    <ul className="space-y-3 text-sm text-slate-300" style={{ fontFamily: 'Poppins, sans-serif' }}>
                      {(tenantFooterConfig.contact?.phone) && (
                        <li className="flex items-center gap-3">
                          <Phone className="w-4 h-4 shrink-0" />
                          <span>{tenantFooterConfig.contact.phone}</span>
                        </li>
                      )}
                      {(tenantFooterConfig.contact?.email) && (
                        <li className="flex items-center gap-3">
                          <Mail className="w-4 h-4 shrink-0" />
                          <span>{tenantFooterConfig.contact.email}</span>
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </div>

              {/* Right Column - Logo & Social */}
              <div className="flex flex-col items-center md:items-end">
                {/* Logo - Use tenant logo if available */}
                {branding?.logoUrl ? (
                  <img 
                    src={branding.logoUrl} 
                    alt={branding?.name || 'Logo'} 
                    className="object-contain mb-8 brightness-0 invert"
                    style={{
                      height: branding?.brandingConfig?.footerLogoHeight ? `${branding.brandingConfig.footerLogoHeight}px` : '96px',
                      width: branding?.brandingConfig?.footerLogoWidth ? `${branding.brandingConfig.footerLogoWidth}px` : 'auto',
                      maxHeight: branding?.brandingConfig?.footerLogoHeight ? `${branding.brandingConfig.footerLogoHeight}px` : '96px',
                      maxWidth: branding?.brandingConfig?.footerLogoWidth ? `${branding.brandingConfig.footerLogoWidth}px` : 'none'
                    }}
                  />
                ) : (
                  <div className="h-24 w-32 flex items-center justify-center mb-8">
                    <span className="text-white text-2xl font-bold">{branding?.name || ''}</span>
                  </div>
                )}
                
                {/* Follow Us Section */}
                <div className="text-center md:text-right">
                  <h4 
                    className="text-white text-sm mb-3"
                    style={{ 
                      fontFamily: 'Poppins, sans-serif',
                      textTransform: 'uppercase',
                      letterSpacing: '5px'
                    }}
                  >
                    FOLLOW US
                  </h4>
                  <div 
                    className="mb-4 ml-auto"
                    style={{ 
                      width: '36px', 
                      height: '2px', 
                      backgroundColor: 'rgba(255,255,255,0.5)' 
                    }}
                  />
                  
                  {/* Social Icons */}
                  {socialIcons && (
                    <div className="flex gap-4 justify-center md:justify-end">
                      {/* LinkedIn */}
                      {socialIcons.linkedin?.enabled && socialIcons.linkedin?.url && (
                        <a
                          href={socialIcons.linkedin.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-10 h-10 rounded-full border border-white/30 flex items-center justify-center hover:bg-white/10 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
                            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                          </svg>
                        </a>
                      )}
                      
                      {/* Twitter/X */}
                      {socialIcons.twitter?.enabled && socialIcons.twitter?.url && (
                        <a
                          href={socialIcons.twitter.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-10 h-10 rounded-full border border-white/30 flex items-center justify-center hover:bg-white/10 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
                            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                          </svg>
                        </a>
                      )}
                      
                      {/* Facebook */}
                      {socialIcons.facebook?.enabled && socialIcons.facebook?.url && (
                        <a
                          href={socialIcons.facebook.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-10 h-10 rounded-full border border-white/30 flex items-center justify-center hover:bg-white/10 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
                            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                          </svg>
                        </a>
                      )}
                      
                      {/* Instagram */}
                      {socialIcons.instagram?.enabled && socialIcons.instagram?.url && (
                        <a
                          href={socialIcons.instagram.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-10 h-10 rounded-full border border-white/30 flex items-center justify-center hover:bg-white/10 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
                            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                          </svg>
                        </a>
                      )}
                      
                      {/* YouTube */}
                      {socialIcons.youtube?.enabled && socialIcons.youtube?.url && (
                        <a
                          href={socialIcons.youtube.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-10 h-10 rounded-full border border-white/30 flex items-center justify-center hover:bg-white/10 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
                            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                          </svg>
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Bar */}
            <div className="mt-12">
              {/* White horizontal line */}
              <div 
                className="w-full mb-6"
                style={{ 
                  height: '1px', 
                  backgroundColor: 'rgba(255,255,255,0.3)' 
                }}
              />
              
              {/* Two column layout - 70/30 */}
              <div className="grid md:grid-cols-10 gap-8">
                {/* 70% column - Legal/Charity text */}
                <div className="md:col-span-7">
                  {(tenantFooterConfig.legalText || !hasBranding) && (
                    <p 
                      className="text-white text-sm leading-relaxed"
                      style={{ fontFamily: 'Poppins, sans-serif' }}
                    >
                      {tenantFooterConfig.legalText || `© ${new Date().getFullYear()} ${branding?.name || 'All rights reserved'}`}
                    </p>
                  )}
                </div>
                
                {/* 30% column - Links */}
                <div className="md:col-span-3 flex flex-col md:items-end gap-2">
                  {(tenantFooterConfig?.termsAndConditionsUrl || footerConfig?.termsAndConditionsUrl) ? (
                    <a 
                      href={tenantFooterConfig?.termsAndConditionsUrl || footerConfig?.termsAndConditionsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-white text-sm hover:opacity-80 transition-opacity"
                      style={{ fontFamily: 'Poppins, sans-serif' }}
                      data-testid="link-terms-conditions"
                    >
                      Terms and conditions
                    </a>
                  ) : (
                    <span 
                      className="text-white text-sm opacity-60"
                      style={{ fontFamily: 'Poppins, sans-serif' }}
                    >
                      Terms and conditions
                    </span>
                  )}
                  {(tenantFooterConfig?.privacyPolicyUrl || footerConfig?.privacyPolicyUrl) ? (
                    <a 
                      href={tenantFooterConfig?.privacyPolicyUrl || footerConfig?.privacyPolicyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-white text-sm hover:opacity-80 transition-opacity"
                      style={{ fontFamily: 'Poppins, sans-serif' }}
                      data-testid="link-privacy-policy"
                    >
                      Privacy policy
                    </a>
                  ) : (
                    <span 
                      className="text-white text-sm opacity-60"
                      style={{ fontFamily: 'Poppins, sans-serif' }}
                    >
                      Privacy policy
                    </span>
                  )}
                </div>
              </div>
              
              {/* Powered by isaasi */}
              <div className="text-center mt-8">
                <a
                  href="https://isaasi.co.uk"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block hover:opacity-80 transition-opacity"
                >
                  <img
                    src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/68efc20f3e0a30fafad6dde7/fe03f7c5e_linked-aa.png"
                    alt="isaasi"
                    className="w-[40px] mx-auto mb-2"
                  />
                </a>
                <p className="text-xs text-slate-500">
                  Designed and delivered by{' '}
                  <a
                    href="https://isaasi.co.uk"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:opacity-80 transition-opacity"
                    style={{ color: '#eb008c' }}
                  >
                    isaasi
                  </a>. Copyright 2026
                </p>
                
              </div>
            </div>
          </div>
        </footer>

        {/* Floater Display for Public Pages */}
        <FloaterDisplay location="public" />
      </div>
      {/* Newsletter Dialog - uses IEditFormElement for full form rendering */}
      <Dialog open={showNewsletterDialog} onOpenChange={handleNewsletterDialogChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
          {newsletterFormSlug ? (
            <IEditFormElement 
              element={{
                content: {
                  form_slug: newsletterFormSlug,
                  background_type: 'color',
                  background_color: 'transparent'
                }
              }}
              memberInfo={null}
              organizationInfo={null}
            />
          ) : (
            <div className="text-center py-8 px-6">
              <p className="text-slate-600">Newsletter signup form not found or inactive.</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}