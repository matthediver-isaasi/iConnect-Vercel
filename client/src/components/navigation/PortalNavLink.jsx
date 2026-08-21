import React from "react";
import { Link } from "react-router-dom";

const PortalNavLink = React.forwardRef(({
  destination,
  to,
  children,
  className,
  ...props
}, ref) => {
  const url = destination?.url ?? to ?? '';
  if (destination?.isExternal) {
    return (
      <a
        ref={ref}
        href={url}
        target={destination.target}
        rel={destination.rel}
        className={className}
        {...props}
      >
        {children}
      </a>
    );
  }

  return (
    <Link ref={ref} to={url} className={className} {...props}>
      {children}
    </Link>
  );
});

PortalNavLink.displayName = 'PortalNavLink';

export default PortalNavLink;