import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import IEditFormElement from "@/components/iedit/elements/IEditFormElement";
import {
  getPublicHeaderActionDestination,
  getPublicHeaderButtonStyles,
} from "@/lib/publicHeaderNavigationActions";

const BUTTON_ACCENT_GRADIENT = 'linear-gradient(to top right, #5C0085, #BA0087, #EE00C3, #FF4229, #FFB000)';

function ActionSurface({ styleConfig, mobile, children }) {
  const [isHovered, setIsHovered] = useState(false);
  const styles = getPublicHeaderButtonStyles(styleConfig);
  const currentStyle = styles
    ? (isHovered ? styles.hover : styles.normal)
    : { background: BUTTON_ACCENT_GRADIENT, color: '#FFFFFF' };
  const className = mobile
    ? 'font-bold transition-all mx-4 my-2 py-3 px-4 flex items-center justify-center gap-2'
    : 'inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-bold shadow transition-all px-6 py-5';

  return (
    <span
      className={className}
      style={{ ...(mobile ? {} : { fontFamily: 'Poppins, sans-serif' }), ...currentStyle }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
    </span>
  );
}

/**
 * Renders a public navigation button using the same branding and destination
 * semantics as PublicHeader. It owns form-modal state so it can also be used on
 * guest pages without coupling to the header.
 */
export function PublicHeaderNavigationAction({
  item,
  buttonStyles = {},
  icon: Icon,
  mobile = false,
  onAction,
  className = '',
  testId,
}) {
  const [formModalOpen, setFormModalOpen] = useState(false);
  const destination = getPublicHeaderActionDestination(item);
  if (!destination) return null;

  // PublicHeader gives explicit button/form presentation precedence over the
  // legacy highlight flag; preserve that ordering for shared consumers.
  const usesLegacyGradient = item.link_type !== 'form_modal' &&
    item.display_type !== 'button' &&
    item.highlight_style === 'gradient_button';
  const styleConfig = usesLegacyGradient
    ? null
    : buttonStyles[item.button_style || 'primary'];
  const content = (
    <ActionSurface styleConfig={styleConfig} mobile={mobile}>
      {Icon && <Icon className={mobile ? 'w-4 h-4' : 'w-4 h-4 mr-2'} />}
      {item.title ?? item.label}
      <ArrowUpRight className={mobile ? 'w-4 h-4' : 'ml-0.5 w-5 h-5'} strokeWidth={2.5} />
    </ActionSurface>
  );
  const commonProps = {
    className: `${mobile ? 'block w-full' : 'inline-block'} ${className}`.trim(),
    onClick: onAction,
    ...(testId ? { 'data-testid': testId } : {}),
  };

  if (destination.type === 'form') {
    return (
      <>
        <button
          type="button"
          {...commonProps}
          onClick={(event) => {
            onAction?.(event);
            if (!event.defaultPrevented) setFormModalOpen(true);
          }}
        >
          {content}
        </button>
        <Dialog open={formModalOpen} onOpenChange={setFormModalOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
            <IEditFormElement
              element={{
                content: {
                  form_slug: destination.formSlug,
                  background_type: 'color',
                  background_color: 'transparent',
                },
              }}
              memberInfo={null}
              organizationInfo={null}
            />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  if (destination.type === 'external') {
    return (
      <a
        href={destination.href}
        target={destination.target}
        rel={destination.rel}
        {...commonProps}
      >
        {content}
      </a>
    );
  }

  return (
    <Link to={createPageUrl(destination.page)} {...commonProps}>
      {content}
    </Link>
  );
}

export default PublicHeaderNavigationAction;
