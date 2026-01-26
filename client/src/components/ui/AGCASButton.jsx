import React from "react";
import { cn } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";

export default function AGCASButton({ 
  text,
  link,
  buttonStyleId,
  customBgColor,
  customTextColor,
  customBorderColor,
  transparentBg = false,
  openInNewTab = false,
  size = 'medium',
  showArrow = false,
  useGradientStyle = false,
  useGradientHover = false,
  children, 
  onClick, 
  className,
  disabled = false,
  icon: Icon,
  ...props 
}) {
  const [buttonStyle, setButtonStyle] = React.useState(null);

  React.useEffect(() => {
    if (buttonStyleId && !useGradientStyle) {
      const fetchStyle = async () => {
        try {
          const { base44 } = await import("@/api/base44Client");
          const styles = await base44.entities.ButtonStyle.list() || [];
          const style = styles.find(s => s.id === buttonStyleId);
          setButtonStyle(style);
        } catch (error) {
          console.error('Failed to fetch button style:', error);
        }
      };
      fetchStyle();
    }
  }, [buttonStyleId, useGradientStyle]);

  // Gradient style overrides everything
  if (useGradientStyle) {
    const gradientSizeClasses = {
      small: 'px-4 py-2 text-xs',
      medium: 'px-6 py-3 text-sm',
      large: 'px-8 py-4 text-base',
      xlarge: 'px-10 py-5 text-lg'
    };

    const gradientClassName = cn(
      "inline-flex items-center justify-center gap-2 whitespace-nowrap",
      gradientSizeClasses[size] || gradientSizeClasses.medium,
      "font-bold text-white rounded-none",
      "transition-opacity duration-300 hover:opacity-90",
      "disabled:opacity-50 disabled:cursor-not-allowed",
      className
    );

    const ButtonTag = link ? 'a' : 'button';

    return (
      <ButtonTag
        href={link || undefined}
        target={openInNewTab ? '_blank' : undefined}
        rel={openInNewTab ? 'noopener noreferrer' : undefined}
        onClick={onClick}
        disabled={!link && disabled}
        className={gradientClassName}
        style={{ 
          fontFamily: 'Poppins, sans-serif',
          background: 'linear-gradient(to top right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)'
        }}
        {...props}
      >
        {text || children}
        {showArrow && <ArrowUpRight className="w-5 h-5 ml-0.5" strokeWidth={2.5} />}
        {Icon && <Icon className="w-5 h-5 ml-0.5" strokeWidth={2.5} />}
      </ButtonTag>
    );
  }

  // Custom colors override button style - only if actually set (not empty strings)
  const hasCustomColors = (customBgColor && customBgColor !== '') || 
                          (customTextColor && customTextColor !== '') || 
                          (customBorderColor && customBorderColor !== '') ||
                          transparentBg;
  
  const getBackgroundColor = () => {
    if (transparentBg) return 'transparent';
    if (customBgColor && customBgColor !== '') return customBgColor;
    return undefined;
  };
  
  const buttonStyles = hasCustomColors ? {
    backgroundColor: getBackgroundColor() || 'transparent',
    color: (customTextColor && customTextColor !== '') ? customTextColor : '#ffffff',
    ...((customBorderColor && customBorderColor !== '') ? { border: `2px solid ${customBorderColor}` } : {}),
    fontFamily: 'Poppins, sans-serif'
  } : buttonStyle ? {
    backgroundColor: buttonStyle.background_color || 'transparent',
    color: buttonStyle.text_color || '#000000',
    borderColor: buttonStyle.border_color || '#000000',
    borderWidth: buttonStyle.border_width ? `${buttonStyle.border_width}px` : '2px',
    borderStyle: 'solid',
    borderRadius: buttonStyle.border_radius ? `${buttonStyle.border_radius}px` : '0px',
    fontFamily: buttonStyle.font_family || 'Poppins, sans-serif'
  } : { fontFamily: 'Poppins, sans-serif' };

  const hoverStyles = buttonStyle?.hover_background_color || buttonStyle?.hover_text_color ? {
    '--hover-bg': buttonStyle.hover_background_color || buttonStyles.backgroundColor,
    '--hover-text': buttonStyle.hover_text_color || buttonStyles.color
  } : {};

  // Detect icon-only mode (arrow shown but no text)
  const isIconOnly = showArrow && !text && !children;

  const sizeClasses = {
    small: 'px-4 py-2 text-xs',
    medium: 'px-6 py-3 text-sm',
    large: 'px-8 py-4 text-base',
    xlarge: 'px-10 py-5 text-lg'
  };

  // Square sizing for icon-only buttons
  const iconOnlySizeClasses = {
    small: 'w-8 h-8',
    medium: 'w-10 h-10',
    large: 'w-12 h-12',
    xlarge: 'w-14 h-14'
  };

  // Determine which CSS class to use for hover behavior
  const getButtonClass = () => {
    if (useGradientHover) {
      return "agcas-gradient-hover-button";
    }
    if (buttonStyle || hasCustomColors) {
      return "agcas-styled-button";
    }
    return "agcas-button";
  };

  const combinedClassName = cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    (buttonStyle || hasCustomColors) ? "" : "rounded-none bg-transparent",
    isIconOnly 
      ? iconOnlySizeClasses[size] || iconOnlySizeClasses.medium
      : sizeClasses[size] || sizeClasses.medium,
    "font-bold",
    (buttonStyle || hasCustomColors) ? "" : "text-black",
    "transition-all duration-300",
    (buttonStyle || hasCustomColors) && !useGradientHover ? "" : "hover:text-white",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    getButtonClass(),
    className
  );

  const ButtonTag = link ? 'a' : 'button';

  return (
    <ButtonTag
      href={link || undefined}
      target={openInNewTab ? '_blank' : undefined}
      rel={openInNewTab ? 'noopener noreferrer' : undefined}
      onClick={onClick}
      disabled={!link && disabled}
      className={combinedClassName}
      style={{ ...buttonStyles, ...hoverStyles }}
      {...props}
    >
      <style>{`
        .agcas-button {
          box-shadow: inset 0 0 0 2px black;
        }
        .agcas-button:hover:not(:disabled) {
          background: linear-gradient(to right top, rgb(92, 0, 133), rgb(186, 0, 135), rgb(238, 0, 195), rgb(255, 66, 41), rgb(255, 176, 0));
          box-shadow: none !important;
        }
        .agcas-button:disabled {
          background: transparent;
        }
        .agcas-styled-button:hover:not(:disabled) {
          background-color: var(--hover-bg);
          color: var(--hover-text);
        }
        .agcas-gradient-hover-button:hover:not(:disabled) {
          background: linear-gradient(to right top, rgb(92, 0, 133), rgb(186, 0, 135), rgb(238, 0, 195), rgb(255, 66, 41), rgb(255, 176, 0)) !important;
          color: white !important;
          border-color: transparent !important;
        }
      `}</style>
      {text || children}
      {showArrow && <ArrowUpRight className="w-5 h-5 ml-0.5" strokeWidth={2.5} />}
      {Icon && <Icon className="w-5 h-5 ml-0.5" strokeWidth={2.5} />}
    </ButtonTag>
  );
}