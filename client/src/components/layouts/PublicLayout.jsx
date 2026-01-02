import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { Mail, MapPin, Phone, ArrowUpRight, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import PublicHeader from "./PublicHeader";
import PageBannerDisplay from "../banners/PageBannerDisplay";
import PortalHeroBanner from "../banners/PortalHeroBanner";
import FloaterDisplay from "../floaters/FloaterDisplay";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { BannerProvider } from "@/contexts/BannerContext";
import FormRenderer from "../forms/FormRenderer";

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
  const queryClient = useQueryClient();
  const [banners, setBanners] = useState([]);
  const [loadingBanners, setLoadingBanners] = useState(true);
  const [showNewsletterDialog, setShowNewsletterDialog] = useState(false);
  const [newsletterFormValues, setNewsletterFormValues] = useState({});
  const [newsletterSubmitted, setNewsletterSubmitted] = useState(false);
  const [socialIcons, setSocialIcons] = useState(null);
  const [footerConfig, setFooterConfig] = useState(null);

  // Fetch social icons and footer configuration
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
      } catch (error) {
        console.error('Failed to fetch configs:', error);
      }
    };

    fetchConfigs();
  }, []);

  const { data: newsletterForm, isLoading: newsletterFormLoading } = useQuery({
    queryKey: ['newsletter-signup-form'],
    queryFn: async () => {
      const allForms = await base44.entities.Form.list();
      return allForms.find(f => f.slug === 'newsletter-signup' && f.is_active);
    },
    enabled: showNewsletterDialog
  });

  const submitNewsletterMutation = useMutation({
    mutationFn: async (submissionData) => {
      return await base44.entities.FormSubmission.create(submissionData);
    },
    onSuccess: async () => {
      if (newsletterForm) {
        await base44.entities.Form.update(newsletterForm.id, {
          submission_count: (newsletterForm.submission_count || 0) + 1
        });
      }
      queryClient.invalidateQueries({ queryKey: ['newsletter-signup-form'] });
      setNewsletterSubmitted(true);
    },
    onError: (error) => {
      console.error('Failed to submit newsletter form:', error);
    }
  });

  const handleNewsletterSubmit = () => {
    if (!newsletterForm) return;
    
    const requiredFields = newsletterForm.fields?.filter(f => f.required) || [];
    const missingRequired = requiredFields.filter(f => !newsletterFormValues[f.id]);
    
    if (missingRequired.length > 0) {
      return;
    }
    
    submitNewsletterMutation.mutate({
      form_id: newsletterForm.id,
      form_name: newsletterForm.name,
      submission_data: newsletterFormValues,
      submitted_by_email: null,
      submitted_by_name: null,
      created_date: new Date().toISOString()
    });
  };

  const handleNewsletterDialogChange = (open) => {
    setShowNewsletterDialog(open);
    if (!open) {
      setNewsletterFormValues({});
      setNewsletterSubmitted(false);
    }
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
              background: 'linear-gradient(to right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)'
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
                  Become a member today
                </h2>
                <Link to={createPageUrl('Membership')}>
                  <Button 
                    className="text-white font-bold hover:opacity-90 transition-opacity px-6 py-5 rounded-none" 
                    style={{ 
                      fontFamily: 'Poppins, sans-serif',
                      background: 'linear-gradient(to top right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)'
                    }}
                  >
                    Join Us
                    <ArrowUpRight className="ml-0.5 w-5 h-5" strokeWidth={2.5} />
                  </Button>
                </Link>

                {/* Newsletter Signup */}
                <h2 
                  className="text-3xl text-white mb-8 mt-12"
                  style={{ fontFamily: "'Degular Medium', sans-serif" }}
                >Sign up to our newsletter</h2>
                <div>
                  <Button 
                    onClick={() => setShowNewsletterDialog(true)}
                    className="text-white font-bold hover:opacity-90 transition-opacity px-6 py-5 rounded-none" 
                    style={{ 
                      fontFamily: 'Poppins, sans-serif',
                      background: 'linear-gradient(to top right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)'
                    }}
                    data-testid="button-newsletter-signup"
                  >
                    Sign up
                    <ArrowUpRight className="ml-0.5 w-5 h-5" strokeWidth={2.5} />
                  </Button>
                </div>
              </div>

              {/* Middle Column - Address & Contact */}
              <div className="space-y-8">
                {/* Address Section */}
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
                    <p>Graduate Futures Institute</p>
                    <p>c/o Hawsons Chartered Accountants</p>
                    <p>Pegasus House</p>
                    <p>Sheffield</p>
                    <p>South Yorkshire</p>
                    <p>S10 2QD</p>
                  </div>
                </div>

                {/* Contact Section */}
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
                    <li className="flex items-center gap-3">
                      <Phone className="w-4 h-4 shrink-0" />
                      <span>+44 (0)114 251 5750</span>
                    </li>
                    <li className="flex items-center gap-3">
                      <Mail className="w-4 h-4 shrink-0" />
                      <span>hello@graduatefutures.org</span>
                    </li>
                  </ul>
                </div>
              </div>

              {/* Right Column - Logo & Social */}
              <div className="flex flex-col items-center md:items-end">
                {/* Logo */}
                <svg width="120" height="105" viewBox="0 0 180 158" fill="none" xmlns="http://www.w3.org/2000/svg" className="mb-8">
                  <path d="M59.5853 84.6185C59.5853 87.8676 57.323 89.8434 54.3578 89.8434C51.0191 89.8434 48.625 87.3846 48.625 84.3331C48.625 81.2815 51.0631 78.8008 54.182 78.8008C56.2248 78.8008 57.938 79.8107 58.8166 81.2157L56.7519 82.4012C56.3126 81.6987 55.3462 81.1498 54.1601 81.1498C52.3809 81.1498 51.0411 82.467 51.0411 84.3331C51.0411 86.1991 52.3151 87.4505 54.3797 87.4505C55.7855 87.4505 56.708 86.8358 57.1033 85.804H54.2699V83.6745H59.5853V84.5746V84.6185Z" fill="white"/>
                  <path d="M65.428 81.8965V84.4651C64.4835 84.3114 63.1437 84.6846 63.1437 86.1994V89.6241H60.8594V82.0502H63.1437V83.3893C63.4512 82.3795 64.4616 81.8965 65.428 81.8965Z" fill="white"/>
                  <path d="M74.038 82.0501V89.6241H71.7537V88.9216C71.2485 89.4924 70.5017 89.8436 69.4913 89.8436C67.5145 89.8436 65.8672 88.1093 65.8672 85.8481C65.8672 83.5869 67.5145 81.8525 69.4913 81.8525C70.5017 81.8525 71.2485 82.2038 71.7537 82.7746V82.0721H74.038V82.0501ZM71.7757 85.8261C71.7757 84.6846 71.0069 83.982 69.9746 83.982C68.9422 83.982 68.1735 84.6846 68.1735 85.8261C68.1735 86.9677 68.9422 87.6702 69.9746 87.6702C71.0069 87.6702 71.7757 86.9677 71.7757 85.8261Z" fill="white"/>
                  <path d="M83.4824 79.0205V89.6241H81.198V88.9216C80.6929 89.4924 79.9461 89.8436 78.9357 89.8436C76.9589 89.8436 75.3115 88.1093 75.3115 85.8481C75.3115 83.5868 76.9589 81.8525 78.9357 81.8525C79.9461 81.8525 80.6929 82.2038 81.198 82.7746V79.0205H83.4824ZM81.22 85.8261C81.22 84.6845 80.4512 83.982 79.4189 83.982C78.3866 83.982 77.6178 84.6845 77.6178 85.8261C77.6178 86.9677 78.3866 87.6702 79.4189 87.6702C80.4512 87.6702 81.22 86.9677 81.22 85.8261Z" fill="white"/>
                  <path d="M92.3342 82.0498V89.6238H90.0499V88.9213C89.6326 89.4921 88.8858 89.8433 87.8754 89.8433C86.3379 89.8433 85.042 88.7457 85.042 86.704V82.0498H87.3263V86.3747C87.3263 87.3187 87.9194 87.7577 88.6442 87.7577C89.4788 87.7577 90.0499 87.2748 90.0499 86.199V82.0718H92.3342V82.0498Z" fill="white"/>
                  <path d="M101.779 82.0501V89.6241H99.4949V88.9216C98.9897 89.4924 98.2429 89.8436 97.2326 89.8436C95.2557 89.8436 93.6084 88.1093 93.6084 85.8481C93.6084 83.5869 95.2557 81.8525 97.2326 81.8525C98.2429 81.8525 98.9897 82.2038 99.4949 82.7746V82.0721H101.779V82.0501ZM99.4949 85.8261C99.4949 84.6846 98.7262 83.982 97.6938 83.982C96.6615 83.982 95.8927 84.6846 95.8927 85.8261C95.8927 86.9677 96.6615 87.6702 97.6938 87.6702C98.7262 87.6702 99.4949 86.9677 99.4949 85.8261Z" fill="white"/>
                  <path d="M106.326 84.2238V86.9021C106.326 87.5607 106.897 87.6047 107.886 87.5607V89.6244C104.921 89.9317 104.042 89.0316 104.042 86.9021V84.2238H102.834V82.0504H104.042V80.6015L106.326 79.9209V82.0504H107.886V84.2238H106.326Z" fill="white"/>
                  <path d="M112.871 87.802C113.486 87.802 114.013 87.5605 114.321 87.2312L116.144 88.2849C115.397 89.3168 114.277 89.8436 112.827 89.8436C110.235 89.8436 108.632 88.1093 108.632 85.8481C108.632 83.5869 110.279 81.8525 112.673 81.8525C114.892 81.8525 116.517 83.5649 116.517 85.8481C116.517 86.1774 116.495 86.4628 116.429 86.7482H111.048C111.333 87.5385 112.036 87.802 112.871 87.802ZM114.277 85.0578C114.035 84.1796 113.354 83.8503 112.673 83.8503C111.817 83.8503 111.224 84.2674 111.02 85.0578H114.277Z" fill="white"/>
                  <path d="M52.5343 93.7738V95.8155H56.4879V98.1426H52.5343V102.028H50.1182V91.4248H56.5538V93.7519H52.5343V93.7738Z" fill="white"/>
                  <path d="M65.0979 94.4766V102.051H62.8136V101.348C62.3963 101.919 61.6495 102.27 60.6391 102.27C59.1016 102.27 57.8057 101.172 57.8057 99.1307V94.4766H60.09V98.8014C60.09 99.7454 60.683 100.185 61.4079 100.185C62.2425 100.185 62.8136 99.7015 62.8136 98.6258V94.4985H65.0979V94.4766Z" fill="white"/>
                  <path d="M69.6447 96.672V99.3504C69.6447 100.009 70.2158 100.053 71.2042 100.009V102.073C68.239 102.38 67.3604 101.48 67.3604 99.3504V96.672H66.1523V94.4986H67.3604V93.0497L69.6447 92.3691V94.4986H71.2042V96.672H69.6447Z" fill="white"/>
                  <path d="M79.8147 94.4766V102.051H77.5304V101.348C77.1131 101.919 76.3663 102.27 75.3559 102.27C73.8184 102.27 72.5225 101.172 72.5225 99.1307V94.4766H74.8068V98.8014C74.8068 99.7454 75.3998 100.185 76.1247 100.185C76.9593 100.185 77.5304 99.7015 77.5304 98.6258V94.4985H79.8147V94.4766Z" fill="white"/>
                  <path d="M86.0305 94.3223V96.8908C85.0861 96.7372 83.7462 97.1104 83.7462 98.6252V102.05H81.4619V94.4759H83.7462V95.8151C84.0537 94.8052 85.0641 94.3223 86.0305 94.3223Z" fill="white"/>
                  <path d="M90.7304 100.25C91.3454 100.25 91.8725 100.009 92.18 99.6794L94.0031 100.733C93.2563 101.765 92.1361 102.292 90.6865 102.292C88.0946 102.292 86.4912 100.558 86.4912 98.2963C86.4912 96.0351 88.1386 94.3008 90.5327 94.3008C92.7511 94.3008 94.3765 96.0132 94.3765 98.2963C94.3765 98.6037 94.3545 98.911 94.2886 99.1964H88.9073C89.1929 99.9868 89.8957 100.25 90.7304 100.25ZM92.1141 97.4841C91.8725 96.6059 91.1916 96.2766 90.5107 96.2766C89.6541 96.2766 89.0611 96.6937 88.8634 97.4841H92.1141Z" fill="white"/>
                  <path d="M101.252 99.7892C101.252 101.524 99.736 102.27 98.0887 102.27C96.5731 102.27 95.409 101.699 94.8379 100.47L96.8147 99.3501C97.0124 99.9209 97.4297 100.25 98.1106 100.25C98.6597 100.25 98.9233 100.075 98.9233 99.7892C98.9233 98.9549 95.1893 99.394 95.1893 96.7815C95.1893 95.135 96.5951 94.3008 98.1545 94.3008C99.3846 94.3008 100.483 94.8496 101.12 95.9253L99.1869 96.9791C98.9672 96.5839 98.6817 96.3205 98.1765 96.3205C97.7811 96.3205 97.5395 96.4742 97.5395 96.7376C97.5395 97.5719 101.252 97.0889 101.252 99.7892Z" fill="white"/>
                  <path d="M51.1725 104.728V115.331H50.1182V104.728H51.1725Z" fill="white"/>
                  <path d="M59.5191 110.677V115.332H58.5087V110.677C58.5087 109.338 57.7619 108.548 56.444 108.548C55.1262 108.548 53.984 109.338 53.984 111.358V115.332H52.9736V107.758H53.984V108.943C54.577 107.977 55.4556 107.582 56.5319 107.582C58.3769 107.582 59.4971 108.789 59.4971 110.699L59.5191 110.677Z" fill="white"/>
                  <path d="M66.6796 113.333C66.6796 114.629 65.5594 115.507 63.934 115.507C62.4184 115.507 61.3861 114.738 61.0127 113.772L61.8693 113.268C62.1329 114.036 62.9236 114.541 63.956 114.541C64.8565 114.541 65.6912 114.212 65.6912 113.333C65.6912 111.445 61.2543 112.521 61.2543 109.733C61.2543 108.526 62.3306 107.56 63.8461 107.56C65.0981 107.56 66.0646 108.174 66.5038 109.096L65.6692 109.579C65.3617 108.811 64.571 108.526 63.8461 108.526C63.0554 108.526 62.2427 108.899 62.2427 109.733C62.2427 111.621 66.6796 110.545 66.6796 113.333Z" fill="white"/>
                  <path d="M69.8863 108.723V113.312C69.8863 114.607 70.5891 114.519 72.0608 114.453V115.331C70.018 115.639 68.8759 115.134 68.8759 113.312V108.723H67.2725V107.757H68.8759V105.935L69.8863 105.628V107.757H72.0608V108.723H69.8863Z" fill="white"/>
                  <path d="M73.5107 105.431C73.5107 105.035 73.8402 104.706 74.2356 104.706C74.6309 104.706 74.9604 105.035 74.9604 105.431C74.9604 105.826 74.6309 106.155 74.2356 106.155C73.8402 106.155 73.5107 105.826 73.5107 105.431ZM73.7304 107.758H74.7408V115.332H73.7304V107.758Z" fill="white"/>
                  <path d="M78.6939 108.723V113.312C78.6939 114.607 79.3967 114.519 80.8684 114.453V115.331C78.8257 115.639 77.6835 115.134 77.6835 113.312V108.723H76.0801V107.757H77.6835V105.935L78.6939 105.628V107.757H80.8684V108.723H78.6939Z" fill="white"/>
                  <path d="M88.8858 107.757V115.331H87.8754V114.146C87.2824 115.112 86.4038 115.507 85.3275 115.507C83.4825 115.507 82.3623 114.299 82.3623 112.39V107.735H83.3727V112.39C83.3727 113.729 84.1195 114.519 85.4374 114.519C86.7552 114.519 87.8974 113.729 87.8974 111.709V107.735H88.9078L88.8858 107.757Z" fill="white"/>
                  <path d="M92.8394 108.723V113.312C92.8394 114.607 93.5422 114.519 95.0139 114.453V115.331C92.9712 115.639 91.829 115.134 91.829 113.312V108.723H90.2256V107.757H91.829V105.935L92.8394 105.628V107.757H95.0139V108.723H92.8394Z" fill="white"/>
                  <path d="M103.492 111.578C103.492 111.731 103.492 111.907 103.47 112.039H96.8151C97.0347 113.575 98.2208 114.541 99.8242 114.541C101.032 114.541 101.867 113.97 102.262 113.246L103.141 113.751C102.504 114.783 101.34 115.485 99.8022 115.485C97.4081 115.485 95.7607 113.795 95.7607 111.512C95.7607 109.229 97.3642 107.538 99.7144 107.538C102.065 107.538 103.47 109.47 103.47 111.534L103.492 111.578ZM96.8151 111.073H102.482C102.262 109.404 101.054 108.548 99.7583 108.548C98.1768 108.548 97.0347 109.426 96.8151 111.073Z" fill="white"/>
                  <path d="M179.951 39.9435C178.743 11.7332 146.917 -11.6913 117.484 6.31063C116.166 7.12291 114.892 7.93519 113.684 8.79138C102.965 15.6189 93.4548 24.0711 84.4493 23.7198C67.7342 23.0393 67.0313 2.40289 47.1973 11.7112C38.082 15.9922 38.675 27.3641 41.135 36.87H127.566V107.341C130.465 99.4817 135.846 94.4763 145.116 88.8561C164.203 77.2866 181.05 65.5195 179.951 39.9216V39.9435Z" fill="white"/>
                  <path d="M0.127377 90.4807C-1.16854 103.719 7.55141 115.793 20.4666 118.976C25.3867 120.184 31.1414 120.996 37.6869 121.523V45.1465C21.4111 54.5426 2.12616 69.8662 0.127377 90.4807Z" fill="white"/>
                  <path d="M59.1023 126.704H53.084C53.721 134.3 57.389 141.83 64.1981 147.802C88.6008 169.206 123.327 154.322 124.689 126.704H59.1023Z" fill="white"/>
                </svg>
                
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
                {/* 70% column - Charity text */}
                <div className="md:col-span-7">
                  <p 
                    className="text-white text-sm leading-relaxed"
                    style={{ fontFamily: 'Poppins, sans-serif' }}
                  >
                    The Association of Graduate Careers Advisory Services (Graduate Futures Institute) is a registered charity in England and Wales (1078508) and Scotland (SC038805) Company No. 03884685.
                  </p>
                </div>
                
                {/* 30% column - Links */}
                <div className="md:col-span-3 flex flex-col md:items-end gap-2">
                  {footerConfig?.termsAndConditionsUrl ? (
                    <a 
                      href={footerConfig.termsAndConditionsUrl}
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
                  {footerConfig?.privacyPolicyUrl ? (
                    <a 
                      href={footerConfig.privacyPolicyUrl}
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
      {/* Newsletter Dialog */}
      <Dialog open={showNewsletterDialog} onOpenChange={handleNewsletterDialogChange}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl">Subscribe to our newsletter</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {newsletterSubmitted ? (
              <div className="text-center py-8">
                <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">Thank you!</h3>
                <p className="text-slate-600">
                  {newsletterForm?.confirmation_message || "You've been successfully subscribed to our newsletter."}
                </p>
              </div>
            ) : newsletterFormLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : !newsletterForm ? (
              <div className="text-center py-8">
                <p className="text-slate-600">Newsletter signup form not found or inactive.</p>
              </div>
            ) : (
              <>
                {newsletterForm.description && (
                  <p className="text-slate-600">{newsletterForm.description}</p>
                )}
                
                <div className="space-y-4">
                  {newsletterForm.fields?.map(field => (
                    <FormRenderer
                      key={field.id}
                      field={field}
                      value={newsletterFormValues[field.id]}
                      onChange={(value) => setNewsletterFormValues({ ...newsletterFormValues, [field.id]: value })}
                    />
                  ))}
                </div>
                
                <Button 
                  onClick={handleNewsletterSubmit}
                  disabled={submitNewsletterMutation.isPending}
                  className="w-full"
                  style={{ 
                    background: 'linear-gradient(to top right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)'
                  }}
                >
                  {submitNewsletterMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    newsletterForm.submit_button_text || 'Subscribe'
                  )}
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}