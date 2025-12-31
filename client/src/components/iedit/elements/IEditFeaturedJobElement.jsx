import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { ArrowRight, MapPin, Building2, Clock, Briefcase, Calendar, Banknote } from "lucide-react";
import { Link } from "react-router-dom";
import { format, differenceInDays } from "date-fns";
import { createPageUrl } from "@/utils";
import TypographyStyleSelector, { applyTypographyStyle } from "../TypographyStyleSelector";

export default function IEditFeaturedJobElement({ content, variant, settings }) {
  const {
    // Left side static content
    header_label = 'JOBS',
    header_label_font_family = 'Poppins',
    header_label_font_size = 14,
    header_label_letter_spacing = 3,
    header_label_line_height = 1.2,
    header_label_color = '#000000',
    show_header_underline = true,
    header_underline_color = '#000000',
    header_underline_width = 36,
    header_underline_weight = 2,
    
    main_heading = 'Featured\nOpportunity',
    heading_font_family = 'Degular Medium',
    heading_font_size = 55,
    heading_line_height = 0.91,
    heading_letter_spacing = 0,
    heading_color = '#000000',
    
    subheading = '',
    subheading_font_family = 'Poppins',
    subheading_font_size = 18,
    subheading_letter_spacing = 0,
    subheading_line_height = 1.5,
    subheading_color = '#666666',
    
    button_text = 'View All Jobs',
    button_url = '/JobBoard',
    button_style = 'outline',
    button_font_family = 'Poppins',
    button_font_size = 14,
    button_letter_spacing = 0,
    button_color = '#000000',
    
    // Background settings
    gradient_start_color = '#FFB000',
    gradient_end_color = '#D02711',
    gradient_angle = 135,
    right_side_color = '#1a1a2e',
    card_background = '#FFFFFF',
    card_margin = 40,
    card_inner_padding = 32,
    
    // Right side static header
    right_header_text = '',
    right_header_font_family = 'Poppins',
    right_header_font_size = 14,
    right_header_letter_spacing = 3,
    right_header_line_height = 1.2,
    right_header_color = '#FFFFFF',
    right_header_underline_enabled = true,
    right_header_underline_color = 'rgba(255,255,255,0.5)',
    right_header_underline_width = 36,
    right_header_underline_weight = 2,
    right_header_underline_spacing = 8,
    right_header_underline_to_content_spacing = 24,
    
    // Right side job display
    job_title_font_family = 'Poppins',
    job_title_font_size = 32,
    job_title_letter_spacing = 0,
    job_title_line_height = 1.2,
    job_title_color = '#FFFFFF',
    job_detail_font_family = 'Poppins',
    job_detail_font_size = 16,
    job_detail_letter_spacing = 0,
    job_detail_line_height = 1.5,
    job_detail_color = '#FFFFFF',
    job_detail_opacity = 0.9,
    divider_color = 'rgba(255,255,255,0.3)',
    divider_weight = 1,
    
    // Data source
    show_latest_job = true,
    specific_job_id = null,
    
    // Layout
    layout_style = 'side-gradient',
    min_height = 550,
    vertical_padding = 48,
    
    // Mobile typography (defaults to smaller sizes)
    mobile_heading_font_size = 36,
    mobile_subheading_font_size = 14,
    mobile_header_label_font_size = 12,
    mobile_job_title_font_size = 24,
    mobile_job_detail_font_size = 14,
    mobile_button_font_size = 12,
    
    // Mobile spacing
    mobile_vertical_padding = 24,
    mobile_card_margin = 16,
    mobile_card_inner_padding = 20,
    mobile_outer_padding = 16,
    
    // Anchor
    anchor
  } = content || {};

  const fullWidth = settings?.fullWidth;

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['featured-jobs-element', specific_job_id],
    queryFn: async () => {
      if (specific_job_id) {
        const job = await base44.entities.JobPosting.get(specific_job_id);
        return job ? [job] : [];
      }
      const allJobs = await base44.entities.JobPosting.filter({ status: 'active' });
      const now = new Date();
      const activeJobs = allJobs
        .filter(job => !job.closing_date || new Date(job.closing_date) > now)
        .sort((a, b) => {
          if (a.featured && !b.featured) return -1;
          if (!a.featured && b.featured) return 1;
          return new Date(b.created_date) - new Date(a.created_date);
        });
      return activeJobs.slice(0, 1);
    },
    staleTime: 60000
  });

  const featuredJob = jobs[0];

  const gradientStyle = {
    background: `linear-gradient(${gradient_angle}deg, ${gradient_start_color} 0%, ${gradient_end_color} 100%)`
  };

  const formatClosingDate = (date) => {
    if (!date) return null;
    try {
      return format(new Date(date), 'do MMMM yyyy');
    } catch {
      return date;
    }
  };

  const isClosingSoon = (closingDate) => {
    if (!closingDate) return false;
    const days = differenceInDays(new Date(closingDate), new Date());
    return days >= 0 && days <= 7;
  };

  // Generate unique ID for CSS scoping (used by both layouts)
  const elementId = `featured-job-${anchor || 'default'}`;
  
  // Responsive CSS for typography and spacing (shared by both layouts)
  const responsiveStyles = `
    /* Mobile typography */
    #${elementId}-heading {
      font-size: ${mobile_heading_font_size}px;
    }
    #${elementId}-subheading {
      font-size: ${mobile_subheading_font_size}px;
    }
    #${elementId}-header-label {
      font-size: ${mobile_header_label_font_size}px;
    }
    #${elementId}-job-title {
      font-size: ${mobile_job_title_font_size}px;
    }
    #${elementId}-job-details .job-detail-row {
      font-size: ${mobile_job_detail_font_size}px;
    }
    #${elementId}-button {
      font-size: ${mobile_button_font_size}px;
    }
    #${elementId}-right-header {
      font-size: ${mobile_header_label_font_size}px;
    }
    
    /* Desktop typography overrides */
    @media (min-width: 1024px) {
      #${elementId}-heading {
        font-size: ${heading_font_size}px;
      }
      #${elementId}-subheading {
        font-size: ${subheading_font_size}px;
      }
      #${elementId}-header-label {
        font-size: ${header_label_font_size}px;
      }
      #${elementId}-job-title {
        font-size: ${job_title_font_size}px;
      }
      #${elementId}-job-details .job-detail-row {
        font-size: ${job_detail_font_size}px;
      }
      #${elementId}-button {
        font-size: ${button_font_size}px;
      }
      #${elementId}-right-header {
        font-size: ${right_header_font_size}px;
      }
    }
  `;

  // Full-width gradient banner layout
  if (layout_style === 'full-width') {
    return (
      <div id={anchor || undefined} className="w-full" style={gradientStyle}>
        <style>{responsiveStyles}</style>
        <style>{`
          #${elementId}-fw-wrapper {
            padding: ${mobile_vertical_padding}px ${mobile_outer_padding}px;
          }
          @media (min-width: 1024px) {
            #${elementId}-fw-wrapper {
              padding: ${vertical_padding}px 32px;
            }
          }
        `}</style>
        <div id={`${elementId}-fw-wrapper`} className="max-w-6xl mx-auto">
          <div className="flex flex-col lg:flex-row items-center gap-4 lg:gap-8">
            {/* Left - Static content */}
            <div className="flex-1">
              <StaticContent 
                content={content} 
                textColorOverride="#FFFFFF"
                underlineColorOverride="rgba(255,255,255,0.5)"
                elementId={elementId}
              />
            </div>

            {/* Right - Job details */}
            {featuredJob && (
              <div className="flex-1">
                <RightSideHeader content={content} colorOverride="#FFFFFF" elementId={elementId} />
                <JobDetails 
                  job={featuredJob}
                  content={content}
                  formatClosingDate={formatClosingDate}
                  isClosingSoon={isClosingSoon}
                  elementId={elementId}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Default: Split background layout
  // On mobile: stacked sections with natural content flow and padding
  // On desktop: side-by-side with absolute backgrounds
  return (
    <div 
      id={anchor || undefined}
      className="relative w-full overflow-hidden"
    >
      {/* Shared responsive typography CSS */}
      <style>{responsiveStyles}</style>
      
      {/* CSS for spacing (split layout specific) */}
      <style>{`
        /* Mobile spacing */
        #${elementId}-card-wrapper {
          padding: ${mobile_card_margin}px;
        }
        #${elementId}-card {
          padding: ${mobile_card_inner_padding}px;
        }
        #${elementId}-section-top {
          padding: ${mobile_vertical_padding}px ${mobile_outer_padding}px;
        }
        #${elementId}-section-bottom {
          padding: ${mobile_vertical_padding}px ${mobile_outer_padding}px;
        }
        
        /* Desktop overrides */
        @media (min-width: 1024px) {
          #${elementId}-desktop-container {
            min-height: ${min_height}px;
          }
          #${elementId}-desktop-content {
            padding: ${vertical_padding}px 32px;
          }
          #${elementId}-card-wrapper {
            padding: ${card_margin}px;
          }
          #${elementId}-card {
            padding: ${card_inner_padding}px;
          }
        }
      `}</style>
      
      {/* MOBILE LAYOUT: Stacked sections with natural content flow */}
      <div className="lg:hidden">
        {/* Top section - Gradient background with card */}
        <div 
          id={`${elementId}-section-top`}
          style={gradientStyle}
        >
          <div className="max-w-6xl mx-auto">
            <div 
              id={`${elementId}-card-wrapper`}
              className="flex items-stretch justify-center"
            >
              <div 
                id={`${elementId}-card`}
                className="shadow-xl flex flex-col justify-center w-full"
                style={{ background: card_background }}
              >
                <StaticContent content={content} elementId={elementId} />
              </div>
            </div>
          </div>
        </div>
        
        {/* Bottom section - Solid color with job details */}
        <div 
          id={`${elementId}-section-bottom`}
          style={{ background: right_side_color }}
        >
          <div className="max-w-6xl mx-auto">
            <RightSideHeader content={content} elementId={elementId} />
            
            {isLoading ? (
              <div className="animate-pulse space-y-4 w-full">
                <div className="h-8 bg-white/20 rounded w-3/4" />
                <div className="h-px bg-white/20 w-full" />
                <div className="h-5 bg-white/20 rounded w-1/2" />
                <div className="h-px bg-white/20 w-full" />
                <div className="h-5 bg-white/20 rounded w-2/3" />
              </div>
            ) : featuredJob ? (
              <JobDetails 
                job={featuredJob}
                content={content}
                formatClosingDate={formatClosingDate}
                isClosingSoon={isClosingSoon}
                elementId={elementId}
              />
            ) : (
              <div style={{ color: job_detail_color, opacity: job_detail_opacity }}>
                No featured job available
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* DESKTOP LAYOUT: Side-by-side with absolute backgrounds */}
      <div id={`${elementId}-desktop-container`} className="hidden lg:block relative w-full">
        {/* Absolute positioned split backgrounds */}
        <div className="absolute inset-0 flex flex-row">
          <div className="w-1/2" style={gradientStyle} />
          <div className="w-1/2" style={{ background: right_side_color }} />
        </div>

        {/* Centered content container */}
        <div 
          id={`${elementId}-desktop-content`}
          className="relative max-w-6xl mx-auto h-full flex items-stretch"
        >
          <div className="grid grid-cols-2 gap-8 w-full">
            {/* Left column - Static content in white card */}
            <div 
              id={`${elementId}-card-wrapper`}
              className="flex items-stretch justify-start"
            >
              <div 
                id={`${elementId}-card`}
                className="shadow-xl flex flex-col justify-center h-full"
                style={{ background: card_background }}
              >
                <StaticContent content={content} elementId={elementId} />
              </div>
            </div>

            {/* Right column - Static header + Dynamic job content */}
            <div className="flex flex-col justify-center pl-8">
              <RightSideHeader content={content} elementId={elementId} />
              
              {isLoading ? (
                <div className="animate-pulse space-y-4 w-full">
                  <div className="h-8 bg-white/20 rounded w-3/4" />
                  <div className="h-px bg-white/20 w-full" />
                  <div className="h-5 bg-white/20 rounded w-1/2" />
                  <div className="h-px bg-white/20 w-full" />
                  <div className="h-5 bg-white/20 rounded w-2/3" />
                </div>
              ) : featuredJob ? (
                <JobDetails 
                  job={featuredJob}
                  content={content}
                  formatClosingDate={formatClosingDate}
                  isClosingSoon={isClosingSoon}
                  elementId={elementId}
                />
              ) : (
                <div style={{ color: job_detail_color, opacity: job_detail_opacity }}>
                  No featured job available
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StaticContent({ content, textColorOverride, underlineColorOverride, elementId }) {
  const {
    header_label = 'JOBS',
    header_label_font_family = 'Poppins',
    header_label_font_size = 14,
    header_label_letter_spacing = 3,
    header_label_line_height = 1.2,
    header_label_color = '#000000',
    show_header_underline = true,
    header_underline_color = '#000000',
    header_underline_width = 36,
    header_underline_weight = 2,
    
    main_heading = 'Featured\nOpportunity',
    heading_font_family = 'Degular Medium',
    heading_font_size = 55,
    heading_line_height = 0.91,
    heading_letter_spacing = 0,
    heading_color = '#000000',
    
    subheading = '',
    subheading_font_family = 'Poppins',
    subheading_font_size = 18,
    subheading_letter_spacing = 0,
    subheading_line_height = 1.5,
    subheading_color = '#666666',
    
    button_text = 'View All Jobs',
    button_url = '/JobBoard',
    button_style = 'outline',
    button_font_family = 'Poppins',
    button_font_size = 14,
    button_letter_spacing = 0,
    button_color = '#000000'
  } = content || {};

  const labelColor = textColorOverride || header_label_color;
  const headingColorFinal = textColorOverride || heading_color;
  const subheadingColorFinal = textColorOverride || subheading_color;
  const buttonColorFinal = textColorOverride || button_color;
  const underlineColor = underlineColorOverride || header_underline_color;

  return (
    <div>
      {/* Header label */}
      <div className="mb-4 lg:mb-6">
        <span 
          id={elementId ? `${elementId}-header-label` : undefined}
          className="font-bold uppercase"
          style={{ 
            fontFamily: header_label_font_family,
            letterSpacing: `${header_label_letter_spacing}px`,
            lineHeight: `${header_label_line_height}`,
            color: labelColor
          }}
        >
          {header_label}
        </span>
        {show_header_underline && (
          <div 
            className="mt-2"
            style={{ 
              width: `${header_underline_width}px`,
              height: `${header_underline_weight}px`,
              background: underlineColor
            }} 
          />
        )}
      </div>

      {/* Main heading */}
      <h2 
        id={elementId ? `${elementId}-heading` : undefined}
        className="font-medium whitespace-pre-line mb-4 lg:mb-6"
        style={{ 
          fontFamily: heading_font_family,
          lineHeight: `${heading_line_height}em`,
          letterSpacing: `${heading_letter_spacing}px`,
          color: headingColorFinal
        }}
      >
        {main_heading}
      </h2>

      {/* Subheading */}
      {subheading && (
        <p
          id={elementId ? `${elementId}-subheading` : undefined}
          className="mb-6 lg:mb-8"
          style={{
            fontFamily: subheading_font_family,
            letterSpacing: `${subheading_letter_spacing}px`,
            lineHeight: `${subheading_line_height}`,
            color: subheadingColorFinal
          }}
        >
          {subheading}
        </p>
      )}

      {/* Button */}
      {button_text && (
        <div className="mt-6 lg:mt-8">
          <Link to={button_url}>
            <button 
              id={elementId ? `${elementId}-button` : undefined}
              className={`inline-flex items-center gap-2 lg:gap-3 px-4 lg:px-6 py-2 lg:py-3 font-semibold transition-all ${
                button_style === 'filled' 
                  ? 'hover:opacity-90' 
                  : 'border-2 hover:bg-black/5'
              }`}
              style={{ 
                borderColor: button_style === 'outline' ? buttonColorFinal : 'transparent',
                color: button_style === 'filled' ? '#FFFFFF' : buttonColorFinal,
                background: button_style === 'filled' ? buttonColorFinal : 'transparent',
                fontFamily: button_font_family,
                letterSpacing: `${button_letter_spacing}px`
              }}
            >
              {button_text}
              <ArrowRight className="w-4 h-4 lg:w-5 lg:h-5" />
            </button>
          </Link>
        </div>
      )}
    </div>
  );
}

function RightSideHeader({ content, colorOverride, elementId }) {
  const {
    right_header_text = '',
    right_header_font_family = 'Poppins',
    right_header_font_size = 14,
    right_header_letter_spacing = 3,
    right_header_line_height = 1.2,
    right_header_color = '#FFFFFF',
    right_header_underline_enabled = true,
    right_header_underline_color = 'rgba(255,255,255,0.5)',
    right_header_underline_width = 36,
    right_header_underline_weight = 2,
    right_header_underline_spacing = 8,
    right_header_underline_to_content_spacing = 24
  } = content || {};

  if (!right_header_text) return null;

  const headerColor = colorOverride || right_header_color;

  return (
    <div style={{ marginBottom: `${right_header_underline_to_content_spacing}px` }}>
      <span 
        id={elementId ? `${elementId}-right-header` : undefined}
        className="font-bold uppercase"
        style={{ 
          fontFamily: right_header_font_family,
          letterSpacing: `${right_header_letter_spacing}px`,
          lineHeight: `${right_header_line_height}`,
          color: headerColor
        }}
      >
        {right_header_text}
      </span>
      {right_header_underline_enabled && (
        <div 
          style={{ 
            marginTop: `${right_header_underline_spacing}px`,
            width: `${right_header_underline_width}px`,
            height: `${right_header_underline_weight}px`,
            background: right_header_underline_color
          }} 
        />
      )}
    </div>
  );
}

function JobDetails({ job, content, formatClosingDate, isClosingSoon, elementId }) {
  const {
    job_title_font_family = 'Poppins',
    job_title_font_size = 32,
    job_title_letter_spacing = 0,
    job_title_line_height = 1.2,
    job_title_color = '#FFFFFF',
    job_detail_font_family = 'Poppins',
    job_detail_font_size = 16,
    job_detail_letter_spacing = 0,
    job_detail_line_height = 1.5,
    job_detail_color = '#FFFFFF',
    job_detail_opacity = 0.9,
    divider_color = 'rgba(255,255,255,0.3)',
    divider_weight = 1
  } = content || {};

  const details = [
    { label: 'Organisation', value: job.company_name, icon: Building2 },
    { label: 'Contract Type', value: job.job_type, icon: Briefcase },
    { label: 'Salary', value: job.salary_range, icon: Banknote },
    { label: 'Closing Date', value: formatClosingDate(job.closing_date), icon: Calendar, isClosingSoon: isClosingSoon(job.closing_date) }
  ].filter(d => d.value);

  return (
    <Link 
      to={createPageUrl('JobDetails') + `?id=${job.id}`}
      className="block group w-full"
    >
      {/* Job title as header */}
      <h3 
        id={elementId ? `${elementId}-job-title` : undefined}
        className="font-semibold mb-4 lg:mb-6 group-hover:underline"
        style={{
          fontFamily: job_title_font_family,
          letterSpacing: `${job_title_letter_spacing}px`,
          lineHeight: `${job_title_line_height}`,
          color: job_title_color
        }}
      >
        {job.title}
      </h3>

      {/* Details with dividers */}
      <div id={elementId ? `${elementId}-job-details` : undefined} className="space-y-0">
        {details.map((detail, index) => (
          <div key={detail.label}>
            {/* Divider line */}
            <div 
              style={{ 
                height: `${divider_weight}px`, 
                background: divider_color 
              }} 
            />
            
            {/* Detail row */}
            <div 
              className="job-detail-row flex items-center gap-2 lg:gap-3 py-3 lg:py-4"
              style={{
                fontFamily: job_detail_font_family,
                letterSpacing: `${job_detail_letter_spacing}px`,
                lineHeight: `${job_detail_line_height}`,
                color: job_detail_color,
                opacity: job_detail_opacity
              }}
            >
              <detail.icon className="w-4 h-4 lg:w-5 lg:h-5 flex-shrink-0" />
              <span className="font-medium min-w-[80px] lg:min-w-[120px]">{detail.label}:</span>
              <span className="flex items-center gap-2 flex-wrap">
                {detail.value}
                {detail.isClosingSoon && (
                  <span className="px-2 py-0.5 text-xs font-medium rounded bg-amber-500 text-white">
                    Closing Soon
                  </span>
                )}
              </span>
            </div>
          </div>
        ))}
        {/* Final divider */}
        <div 
          style={{ 
            height: `${divider_weight}px`, 
            background: divider_color 
          }} 
        />
      </div>
    </Link>
  );
}

function FontSelect({ value, onChange, className = "w-full px-3 py-2 border border-slate-300 rounded-md" }) {
  return (
    <select value={value} onChange={onChange} className={className}>
      <option value="Poppins">Poppins</option>
      <option value="Degular Medium">Degular Medium</option>
    </select>
  );
}

export function IEditFeaturedJobElementEditor({ element, onChange }) {
  const { data: jobs = [] } = useQuery({
    queryKey: ['all-jobs-for-selector'],
    queryFn: async () => {
      const allJobs = await base44.entities.JobPosting.list();
      return allJobs.filter(j => j.status === 'active');
    }
  });

  const content = element.content || {};

  const updateContent = (key, value) => {
    onChange({
      ...element,
      content: {
        ...content,
        [key]: value
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., jobs-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-featuredjob-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      {/* Layout Settings */}
      <div className="space-y-4">
        <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-500">Layout</h4>
        
        <div className="space-y-2">
          <label className="text-sm font-medium">Layout Style</label>
          <select 
            value={content.layout_style || 'side-gradient'}
            onChange={(e) => updateContent('layout_style', e.target.value)}
            className="w-full px-3 py-2 border rounded-md"
          >
            <option value="side-gradient">Split Background (Gradient Left / Solid Right)</option>
            <option value="full-width">Full Width Gradient Banner</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Minimum Height (px)</label>
            <input 
              type="number"
              value={content.min_height || 550}
              onChange={(e) => updateContent('min_height', parseInt(e.target.value))}
              className="w-full px-3 py-2 border rounded-md"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Vertical Padding (px)</label>
            <input 
              type="number"
              value={content.vertical_padding || 48}
              onChange={(e) => updateContent('vertical_padding', parseInt(e.target.value))}
              className="w-full px-3 py-2 border rounded-md"
            />
          </div>
        </div>

        {/* Mobile Responsive Settings */}
        <div className="border rounded-lg p-3 bg-blue-50 space-y-4">
          <div>
            <label className="text-sm font-medium text-blue-800">Mobile Responsive Settings</label>
            <p className="text-xs text-blue-600 mt-1">These settings apply on screens smaller than 1024px width.</p>
          </div>
          
          {/* Mobile Typography */}
          <div className="space-y-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-blue-700">Mobile Typography (px)</label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Main Heading</label>
                <input 
                  type="number"
                  value={content.mobile_heading_font_size || 36}
                  onChange={(e) => updateContent('mobile_heading_font_size', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Subheading</label>
                <input 
                  type="number"
                  value={content.mobile_subheading_font_size || 14}
                  onChange={(e) => updateContent('mobile_subheading_font_size', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Header Labels</label>
                <input 
                  type="number"
                  value={content.mobile_header_label_font_size || 12}
                  onChange={(e) => updateContent('mobile_header_label_font_size', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Button Text</label>
                <input 
                  type="number"
                  value={content.mobile_button_font_size || 12}
                  onChange={(e) => updateContent('mobile_button_font_size', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Job Title</label>
                <input 
                  type="number"
                  value={content.mobile_job_title_font_size || 24}
                  onChange={(e) => updateContent('mobile_job_title_font_size', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Job Details</label>
                <input 
                  type="number"
                  value={content.mobile_job_detail_font_size || 14}
                  onChange={(e) => updateContent('mobile_job_detail_font_size', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
            </div>
          </div>
          
          {/* Mobile Spacing */}
          <div className="space-y-3 border-t border-blue-200 pt-3">
            <label className="text-xs font-semibold uppercase tracking-wide text-blue-700">Mobile Spacing (px)</label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Vertical Padding</label>
                <input 
                  type="number"
                  value={content.mobile_vertical_padding || 24}
                  onChange={(e) => updateContent('mobile_vertical_padding', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Outer Padding</label>
                <input 
                  type="number"
                  value={content.mobile_outer_padding || 16}
                  onChange={(e) => updateContent('mobile_outer_padding', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Card Margin</label>
                <input 
                  type="number"
                  value={content.mobile_card_margin || 16}
                  onChange={(e) => updateContent('mobile_card_margin', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Card Inner Padding</label>
                <input 
                  type="number"
                  value={content.mobile_card_inner_padding || 20}
                  onChange={(e) => updateContent('mobile_card_inner_padding', parseInt(e.target.value))}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Background Colors */}
      <div className="border-t pt-4 space-y-4">
        <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-500">Background Colors</h4>
        
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Gradient Start</label>
            <div className="flex gap-2">
              <input 
                type="color"
                value={content.gradient_start_color || '#FFB000'}
                onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                className="w-10 h-10 rounded border cursor-pointer"
              />
              <input 
                type="text"
                value={content.gradient_start_color || '#FFB000'}
                onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                className="flex-1 px-3 py-2 border rounded-md"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Gradient End</label>
            <div className="flex gap-2">
              <input 
                type="color"
                value={content.gradient_end_color || '#D02711'}
                onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                className="w-10 h-10 rounded border cursor-pointer"
              />
              <input 
                type="text"
                value={content.gradient_end_color || '#D02711'}
                onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                className="flex-1 px-3 py-2 border rounded-md"
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Gradient Angle (degrees)</label>
          <input 
            type="number"
            value={content.gradient_angle || 135}
            onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value))}
            className="w-full px-3 py-2 border rounded-md"
            min="0"
            max="360"
          />
        </div>

        {content.layout_style !== 'full-width' && (
          <>
            <div className="space-y-2">
              <label className="text-sm font-medium">Right Side Color</label>
              <div className="flex gap-2">
                <input 
                  type="color"
                  value={content.right_side_color || '#1a1a2e'}
                  onChange={(e) => updateContent('right_side_color', e.target.value)}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input 
                  type="text"
                  value={content.right_side_color || '#1a1a2e'}
                  onChange={(e) => updateContent('right_side_color', e.target.value)}
                  className="flex-1 px-3 py-2 border rounded-md"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Card Background</label>
              <div className="flex gap-2">
                <input 
                  type="color"
                  value={content.card_background || '#FFFFFF'}
                  onChange={(e) => updateContent('card_background', e.target.value)}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input 
                  type="text"
                  value={content.card_background || '#FFFFFF'}
                  onChange={(e) => updateContent('card_background', e.target.value)}
                  className="flex-1 px-3 py-2 border rounded-md"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Card Margin (px)</label>
              <p className="text-xs text-slate-500">Space between card and container edges</p>
              <input 
                type="number"
                value={content.card_margin || 40}
                onChange={(e) => updateContent('card_margin', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                min="0"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Card Inner Padding (px)</label>
              <p className="text-xs text-slate-500">Space inside the card around content</p>
              <input 
                type="number"
                value={content.card_inner_padding || 32}
                onChange={(e) => updateContent('card_inner_padding', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                min="0"
              />
            </div>
          </>
        )}
      </div>

      {/* Left Side - Static Content */}
      <div className="border-t pt-4 space-y-4">
        <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-500">Left Side - Static Content</h4>
        
        {/* Header Label */}
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="text-xs font-semibold text-slate-400 uppercase">Header Label</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Text</label>
              <input 
                type="text"
                value={content.header_label || 'JOBS'}
                onChange={(e) => updateContent('header_label', e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Font Family</label>
              <FontSelect
                value={content.header_label_font_family || 'Poppins'}
                onChange={(e) => updateContent('header_label_font_family', e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Size (px)</label>
              <input 
                type="number"
                value={content.header_label_font_size || 14}
                onChange={(e) => updateContent('header_label_font_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Color</label>
              <div className="flex gap-1">
                <input 
                  type="color"
                  value={content.header_label_color || '#000000'}
                  onChange={(e) => updateContent('header_label_color', e.target.value)}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input 
                  type="text"
                  value={content.header_label_color || '#000000'}
                  onChange={(e) => updateContent('header_label_color', e.target.value)}
                  className="flex-1 px-2 py-2 border rounded-md text-sm"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Letter Spacing (px)</label>
              <input 
                type="number"
                value={content.header_label_letter_spacing || 3}
                onChange={(e) => updateContent('header_label_letter_spacing', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Line Height</label>
              <input 
                type="number"
                value={content.header_label_line_height || 1.2}
                onChange={(e) => updateContent('header_label_line_height', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                step="0.1"
              />
            </div>
          </div>

          {/* Underline */}
          <div className="flex items-center gap-2 mt-2">
            <input 
              type="checkbox"
              checked={content.show_header_underline !== false}
              onChange={(e) => updateContent('show_header_underline', e.target.checked)}
              className="rounded"
            />
            <span className="text-sm font-medium">Show Line Below</span>
          </div>
          {content.show_header_underline !== false && (
            <div className="grid grid-cols-3 gap-3 mt-2">
              <div className="space-y-1">
                <label className="text-sm">Line Color</label>
                <input 
                  type="color"
                  value={content.header_underline_color || '#000000'}
                  onChange={(e) => updateContent('header_underline_color', e.target.value)}
                  className="w-full h-10 rounded border cursor-pointer"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm">Width (px)</label>
                <input 
                  type="number"
                  value={content.header_underline_width || 36}
                  onChange={(e) => updateContent('header_underline_width', parseInt(e.target.value))}
                  className="w-full px-2 py-2 border rounded-md"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm">Weight (px)</label>
                <input 
                  type="number"
                  value={content.header_underline_weight || 2}
                  onChange={(e) => updateContent('header_underline_weight', parseInt(e.target.value))}
                  className="w-full px-2 py-2 border rounded-md"
                />
              </div>
            </div>
          )}
        </div>

        {/* Main Heading */}
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="text-xs font-semibold text-slate-400 uppercase">Main Heading</div>
          <div className="space-y-2">
            <textarea 
              value={content.main_heading || 'Featured\nOpportunity'}
              onChange={(e) => updateContent('main_heading', e.target.value)}
              className="w-full px-3 py-2 border rounded-md"
              rows={2}
              placeholder="Use line breaks for multi-line headings"
            />
          </div>
          <TypographyStyleSelector
            value={content.heading_typography_style_id}
            onChange={(styleId) => updateContent('heading_typography_style_id', styleId)}
            onApplyStyle={(style) => {
              const applied = applyTypographyStyle(style);
              if (applied.font_family) updateContent('heading_font_family', applied.font_family);
              if (applied.font_size) updateContent('heading_font_size', applied.font_size);
              if (applied.font_size_mobile) updateContent('heading_font_size_mobile', applied.font_size_mobile);
              if (applied.line_height) updateContent('heading_line_height', applied.line_height);
              if (applied.letter_spacing !== undefined) updateContent('heading_letter_spacing', applied.letter_spacing);
              if (applied.color) updateContent('heading_color', applied.color);
            }}
            filterTypes={['h1', 'h2']}
            label="Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Font Family</label>
                  <FontSelect
                    value={content.heading_font_family || 'Degular Medium'}
                    onChange={(e) => updateContent('heading_font_family', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Size (px)</label>
                  <input 
                    type="number"
                    value={content.heading_font_size || 55}
                    onChange={(e) => updateContent('heading_font_size', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Line Height (em)</label>
                  <input 
                    type="number"
                    value={content.heading_line_height || 0.91}
                    onChange={(e) => updateContent('heading_line_height', parseFloat(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                    step="0.01"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Letter Spacing (px)</label>
                  <input 
                    type="number"
                    value={content.heading_letter_spacing || 0}
                    onChange={(e) => updateContent('heading_letter_spacing', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Color</label>
                  <div className="flex gap-1">
                    <input 
                      type="color"
                      value={content.heading_color || '#000000'}
                      onChange={(e) => updateContent('heading_color', e.target.value)}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <input 
                      type="text"
                      value={content.heading_color || '#000000'}
                      onChange={(e) => updateContent('heading_color', e.target.value)}
                      className="flex-1 px-2 py-2 border rounded-md text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>
          </details>
        </div>

        {/* Subheading */}
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="text-xs font-semibold text-slate-400 uppercase">Subheading (Optional)</div>
          <textarea 
            value={content.subheading || ''}
            onChange={(e) => updateContent('subheading', e.target.value)}
            className="w-full px-3 py-2 border rounded-md"
            rows={2}
            placeholder="Additional descriptive text"
          />
          <TypographyStyleSelector
            value={content.subheading_typography_style_id}
            onChange={(styleId) => updateContent('subheading_typography_style_id', styleId)}
            onApplyStyle={(style) => {
              const applied = applyTypographyStyle(style);
              if (applied.font_family) updateContent('subheading_font_family', applied.font_family);
              if (applied.font_size) updateContent('subheading_font_size', applied.font_size);
              if (applied.font_size_mobile) updateContent('subheading_font_size_mobile', applied.font_size_mobile);
              if (applied.line_height) updateContent('subheading_line_height', applied.line_height);
              if (applied.letter_spacing !== undefined) updateContent('subheading_letter_spacing', applied.letter_spacing);
              if (applied.color) updateContent('subheading_color', applied.color);
            }}
            filterTypes={['h3', 'h4', 'paragraph']}
            label="Typography Style"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700 font-medium">Manual Font Settings</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Font Family</label>
                  <FontSelect
                    value={content.subheading_font_family || 'Poppins'}
                    onChange={(e) => updateContent('subheading_font_family', e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Size (px)</label>
                  <input 
                    type="number"
                    value={content.subheading_font_size || 18}
                    onChange={(e) => updateContent('subheading_font_size', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Color</label>
                  <div className="flex gap-1">
                    <input 
                      type="color"
                      value={content.subheading_color || '#666666'}
                      onChange={(e) => updateContent('subheading_color', e.target.value)}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <input 
                      type="text"
                      value={content.subheading_color || '#666666'}
                      onChange={(e) => updateContent('subheading_color', e.target.value)}
                      className="flex-1 px-2 py-2 border rounded-md text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Letter Spacing (px)</label>
                  <input 
                    type="number"
                    value={content.subheading_letter_spacing || 0}
                    onChange={(e) => updateContent('subheading_letter_spacing', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Line Height</label>
                  <input 
                    type="number"
                    value={content.subheading_line_height || 1.5}
                    onChange={(e) => updateContent('subheading_line_height', parseFloat(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                    step="0.1"
                  />
                </div>
              </div>
            </div>
          </details>
        </div>

        {/* Button */}
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="text-xs font-semibold text-slate-400 uppercase">Button</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Text</label>
              <input 
                type="text"
                value={content.button_text || 'View All Jobs'}
                onChange={(e) => updateContent('button_text', e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">URL</label>
              <input 
                type="text"
                value={content.button_url || '/JobBoard'}
                onChange={(e) => updateContent('button_url', e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Style</label>
              <select 
                value={content.button_style || 'outline'}
                onChange={(e) => updateContent('button_style', e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              >
                <option value="outline">Outline</option>
                <option value="filled">Filled</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Font Family</label>
              <FontSelect
                value={content.button_font_family || 'Poppins'}
                onChange={(e) => updateContent('button_font_family', e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Size (px)</label>
              <input 
                type="number"
                value={content.button_font_size || 14}
                onChange={(e) => updateContent('button_font_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Color</label>
              <div className="flex gap-1">
                <input 
                  type="color"
                  value={content.button_color || '#000000'}
                  onChange={(e) => updateContent('button_color', e.target.value)}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input 
                  type="text"
                  value={content.button_color || '#000000'}
                  onChange={(e) => updateContent('button_color', e.target.value)}
                  className="flex-1 px-2 py-2 border rounded-md text-sm"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Letter Spacing (px)</label>
              <input 
                type="number"
                value={content.button_letter_spacing || 0}
                onChange={(e) => updateContent('button_letter_spacing', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Right Side - Static Header */}
      <div className="border-t pt-4 space-y-4">
        <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-500">Right Side - Static Header</h4>
        
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Header Text</label>
              <input 
                type="text"
                value={content.right_header_text || ''}
                onChange={(e) => updateContent('right_header_text', e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
                placeholder="e.g., FEATURED OPPORTUNITY"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Font Family</label>
              <FontSelect
                value={content.right_header_font_family || 'Poppins'}
                onChange={(e) => updateContent('right_header_font_family', e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Size (px)</label>
              <input 
                type="number"
                value={content.right_header_font_size || 14}
                onChange={(e) => updateContent('right_header_font_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Color</label>
              <div className="flex gap-1">
                <input 
                  type="color"
                  value={content.right_header_color || '#FFFFFF'}
                  onChange={(e) => updateContent('right_header_color', e.target.value)}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input 
                  type="text"
                  value={content.right_header_color || '#FFFFFF'}
                  onChange={(e) => updateContent('right_header_color', e.target.value)}
                  className="flex-1 px-2 py-2 border rounded-md text-sm"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Letter Spacing (px)</label>
              <input 
                type="number"
                value={content.right_header_letter_spacing || 3}
                onChange={(e) => updateContent('right_header_letter_spacing', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Line Height</label>
              <input 
                type="number"
                value={content.right_header_line_height || 1.2}
                onChange={(e) => updateContent('right_header_line_height', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                step="0.1"
              />
            </div>
          </div>

          {/* Line Below */}
          <div className="flex items-center gap-2 mt-2">
            <input 
              type="checkbox"
              checked={content.right_header_underline_enabled !== false}
              onChange={(e) => updateContent('right_header_underline_enabled', e.target.checked)}
              className="rounded"
            />
            <span className="text-sm font-medium">Show Line Below</span>
          </div>
          {content.right_header_underline_enabled !== false && (
            <>
              <div className="grid grid-cols-3 gap-3 mt-2">
                <div className="space-y-1">
                  <label className="text-sm">Line Color</label>
                  <input 
                    type="text"
                    value={content.right_header_underline_color || 'rgba(255,255,255,0.5)'}
                    onChange={(e) => updateContent('right_header_underline_color', e.target.value)}
                    className="w-full px-2 py-2 border rounded-md text-sm"
                    placeholder="rgba or hex"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm">Width (px)</label>
                  <input 
                    type="number"
                    value={content.right_header_underline_width || 36}
                    onChange={(e) => updateContent('right_header_underline_width', parseInt(e.target.value))}
                    className="w-full px-2 py-2 border rounded-md"
                    min="10"
                    max="500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm">Weight (px)</label>
                  <input 
                    type="number"
                    value={content.right_header_underline_weight || 2}
                    onChange={(e) => updateContent('right_header_underline_weight', parseInt(e.target.value))}
                    className="w-full px-2 py-2 border rounded-md"
                    min="1"
                    max="10"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm">Spacing from Header (px)</label>
                  <input 
                    type="number"
                    value={content.right_header_underline_spacing || 8}
                    onChange={(e) => updateContent('right_header_underline_spacing', parseInt(e.target.value))}
                    className="w-full px-2 py-2 border rounded-md"
                    min="0"
                    max="50"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm">Spacing to Content (px)</label>
                  <input 
                    type="number"
                    value={content.right_header_underline_to_content_spacing || 24}
                    onChange={(e) => updateContent('right_header_underline_to_content_spacing', parseInt(e.target.value))}
                    className="w-full px-2 py-2 border rounded-md"
                    min="0"
                    max="100"
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right Side - Job Details */}
      <div className="border-t pt-4 space-y-4">
        <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-500">Right Side - Job Details</h4>
        
        {/* Job Title */}
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="text-xs font-semibold text-slate-400 uppercase">Job Title (Dynamic)</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Font Family</label>
              <FontSelect
                value={content.job_title_font_family || 'Poppins'}
                onChange={(e) => updateContent('job_title_font_family', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Size (px)</label>
              <input 
                type="number"
                value={content.job_title_font_size || 32}
                onChange={(e) => updateContent('job_title_font_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Color</label>
              <div className="flex gap-1">
                <input 
                  type="color"
                  value={content.job_title_color || '#FFFFFF'}
                  onChange={(e) => updateContent('job_title_color', e.target.value)}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input 
                  type="text"
                  value={content.job_title_color || '#FFFFFF'}
                  onChange={(e) => updateContent('job_title_color', e.target.value)}
                  className="flex-1 px-2 py-2 border rounded-md text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Letter Spacing (px)</label>
              <input 
                type="number"
                value={content.job_title_letter_spacing || 0}
                onChange={(e) => updateContent('job_title_letter_spacing', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Line Height</label>
              <input 
                type="number"
                value={content.job_title_line_height || 1.2}
                onChange={(e) => updateContent('job_title_line_height', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                step="0.1"
              />
            </div>
          </div>
        </div>

        {/* Detail Rows */}
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="text-xs font-semibold text-slate-400 uppercase">Detail Rows</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Font Family</label>
              <FontSelect
                value={content.job_detail_font_family || 'Poppins'}
                onChange={(e) => updateContent('job_detail_font_family', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Size (px)</label>
              <input 
                type="number"
                value={content.job_detail_font_size || 16}
                onChange={(e) => updateContent('job_detail_font_size', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Color</label>
              <div className="flex gap-1">
                <input 
                  type="color"
                  value={content.job_detail_color || '#FFFFFF'}
                  onChange={(e) => updateContent('job_detail_color', e.target.value)}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input 
                  type="text"
                  value={content.job_detail_color || '#FFFFFF'}
                  onChange={(e) => updateContent('job_detail_color', e.target.value)}
                  className="flex-1 px-2 py-2 border rounded-md text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Letter Spacing (px)</label>
              <input 
                type="number"
                value={content.job_detail_letter_spacing || 0}
                onChange={(e) => updateContent('job_detail_letter_spacing', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Line Height</label>
              <input 
                type="number"
                value={content.job_detail_line_height || 1.5}
                onChange={(e) => updateContent('job_detail_line_height', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                step="0.1"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Opacity</label>
              <input 
                type="number"
                value={content.job_detail_opacity || 0.9}
                onChange={(e) => updateContent('job_detail_opacity', parseFloat(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                step="0.1"
                min="0"
                max="1"
              />
            </div>
          </div>
        </div>

        {/* Divider Lines */}
        <div className="space-y-3 p-3 bg-slate-50 rounded-md">
          <div className="text-xs font-semibold text-slate-400 uppercase">Divider Lines</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Color</label>
              <input 
                type="text"
                value={content.divider_color || 'rgba(255,255,255,0.3)'}
                onChange={(e) => updateContent('divider_color', e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
                placeholder="rgba or hex"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Weight (px)</label>
              <input 
                type="number"
                value={content.divider_weight || 1}
                onChange={(e) => updateContent('divider_weight', parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-md"
                min="1"
                max="5"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Job Data Source */}
      <div className="border-t pt-4 space-y-4">
        <h4 className="font-semibold text-sm uppercase tracking-wide text-slate-500">Job Data Source</h4>
        
        <div className="flex items-center gap-2">
          <input 
            type="checkbox"
            id="show_latest_job"
            checked={content.show_latest_job !== false}
            onChange={(e) => updateContent('show_latest_job', e.target.checked)}
            className="rounded"
          />
          <label htmlFor="show_latest_job" className="text-sm">
            Show latest featured/active job automatically
          </label>
        </div>

        {!content.show_latest_job && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Select Specific Job</label>
            <select 
              value={content.specific_job_id || ''}
              onChange={(e) => updateContent('specific_job_id', e.target.value || null)}
              className="w-full px-3 py-2 border rounded-md"
            >
              <option value="">Select a job...</option>
              {jobs.map(job => (
                <option key={job.id} value={job.id}>
                  {job.title} - {job.company_name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}
