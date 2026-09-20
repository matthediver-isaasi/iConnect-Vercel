import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export function normalizeEventDisplayMode(mode) {
  return mode === "hidden" || mode === "collapsed" || mode === "expanded"
    ? mode
    : "expanded";
}

/**
 * Keeps a visitor's choice while the current event is refreshed, but applies
 * the configured initial state again when navigation loads another event.
 */
export function useEventDisclosure(eventId, displayMode) {
  const mode = normalizeEventDisplayMode(displayMode);
  const initializedEventId = useRef(null);
  const [expanded, setExpanded] = useState(mode !== "collapsed");
  const isNewlyLoadedEvent = Boolean(eventId && initializedEventId.current !== eventId);
  const effectiveExpanded = isNewlyLoadedEvent ? mode !== "collapsed" : expanded;

  useEffect(() => {
    if (!eventId || initializedEventId.current === eventId) return;
    initializedEventId.current = eventId;
    setExpanded(normalizeEventDisplayMode(displayMode) !== "collapsed");
  }, [eventId, displayMode]);

  return {
    hidden: mode === "hidden",
    expanded: effectiveExpanded,
    setExpanded,
    toggle: () => setExpanded((current) => !(isNewlyLoadedEvent ? mode !== "collapsed" : current)),
  };
}

export function EventDisclosureHeading({
  expanded,
  onToggle,
  icon,
  children,
  level = 2,
  className = "",
  buttonClassName = "",
  contentId: providedContentId,
  testId,
  headingTestId,
}) {
  const generatedId = useId();
  const contentId = providedContentId || `event-disclosure-${generatedId.replace(/:/g, "")}`;
  const Heading = `h${level}`;

  return (
    <Heading
      className={`text-lg font-semibold leading-7 text-slate-900 ${className}`}
      data-testid={headingTestId}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={`flex min-h-7 w-full items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${buttonClassName}`}
        data-testid={testId}
      >
        {expanded ? (
          <ChevronDown className="h-5 w-5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        {icon}
        <span className="min-w-0">{children}</span>
      </button>
    </Heading>
  );
}