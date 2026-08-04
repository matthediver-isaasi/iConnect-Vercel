import React, { useState } from "react";
import { Link } from "react-router-dom";
import DOMPurify from "dompurify";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Clock,
  CalendarClock,
  CalendarX,
  Repeat,
  Users,
  Send,
  Check,
  Users2,
  Lock,
  ChevronDown,
} from "lucide-react";

const COMMITMENT_UNIT_LABELS = {
  hours_per_month: "hours / month",
  hours_per_week: "hours / week",
};
const TERM_UNIT_LABELS = {
  months: "months",
  years: "years",
};

export function formatCommitment(vacancy) {
  if (vacancy.commitment_value == null || vacancy.commitment_value === "") return null;
  const unit = COMMITMENT_UNIT_LABELS[vacancy.commitment_unit] || vacancy.commitment_unit || "";
  return `${vacancy.commitment_value} ${unit}`.trim();
}

export function formatTerm(vacancy) {
  if (vacancy.term_value == null || vacancy.term_value === "") return null;
  const unit = TERM_UNIT_LABELS[vacancy.term_unit] || vacancy.term_unit || "";
  return `${vacancy.term_value} ${unit}`.trim();
}

export function formatMaxTerms(vacancy) {
  if (vacancy.max_terms == null || vacancy.max_terms === "") return null;
  const n = Number(vacancy.max_terms);
  return `Max ${vacancy.max_terms} ${n === 1 ? "term" : "terms"}`;
}

export function getPositionsAvailable(vacancy) {
  const n = Number(vacancy?.positions_available);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Parse a vacancy.closing_date (YYYY-MM-DD or ISO) to a Date, or null. */
export function getClosingDate(vacancy) {
  const raw = vacancy?.closing_date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when the closing date has passed (compared on a whole-day basis). */
export function isClosingDatePast(vacancy) {
  const d = getClosingDate(vacancy);
  if (!d) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const closing = new Date(d);
  closing.setHours(0, 0, 0, 0);
  return closing < today;
}

/**
 * Single source of truth for whether a vacancy is closed: explicit
 * status='closed' OR its closing date is in the past.
 */
export function isVacancyClosed(vacancy) {
  return vacancy?.status === "closed" || isClosingDatePast(vacancy);
}

/** True when the closing date is today or within the next 7 days. */
export function isClosingSoon(vacancy) {
  const d = getClosingDate(vacancy);
  if (!d) return false;
  if (isClosingDatePast(vacancy)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const closing = new Date(d);
  closing.setHours(0, 0, 0, 0);
  const days = Math.round((closing - today) / 86400000);
  return days >= 0 && days <= 7;
}

export function formatClosingDate(vacancy) {
  const d = getClosingDate(vacancy);
  if (!d) return null;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Plain-text excerpt of a rich-text description: first non-empty line. */
export function getDescriptionExcerpt(html) {
  const text = (html || "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
  const firstLine = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  return firstLine || "";
}

/**
 * Shared presentation for a single vacancy: title, status badges, description,
 * the metadata-icon row (commitment / term / max-terms / positions) and the
 * express-interest control. Group-admin-only controls are passed in via
 * `adminActions` so they stay out of this shared unit.
 *
 * `collapsible` (opt-in) renders a compact summary card (title, group,
 * description excerpt, commitment + positions remaining, status badges)
 * that expands in place to the full card when clicked.
 */
export default function VacancyCard({
  vacancy,
  alreadyApplied = false,
  positionsTotal,
  positionsRemaining,
  onExpressInterest,
  expressDisabled = false,
  joinLocked = false,
  adminActions = null,
  groupName = null,
  groupUrl = null,
  collapsible = false,
  defaultExpanded = false,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const commitment = formatCommitment(vacancy);
  const term = formatTerm(vacancy);
  const maxTerms = formatMaxTerms(vacancy);
  const isClosed = isVacancyClosed(vacancy);
  const closingDateLabel = formatClosingDate(vacancy);
  const closingSoon = isClosingSoon(vacancy);
  const total =
    positionsTotal != null ? positionsTotal : getPositionsAvailable(vacancy);
  const remaining =
    positionsRemaining != null ? positionsRemaining : total;
  const isFilled = remaining <= 0;

  const stopToggle = (e) => e.stopPropagation();

  const statusBadges = (
    <>
      {isClosed && (
        <Badge variant="secondary" data-testid={`badge-vacancy-closed-${vacancy.id}`}>
          Closed
        </Badge>
      )}
      {!isClosed && isFilled && (
        <Badge variant="secondary" data-testid={`badge-vacancy-filled-${vacancy.id}`}>
          Filled
        </Badge>
      )}
      {!isClosed && closingSoon && (
        <Badge variant="warning" data-testid={`badge-vacancy-closing-soon-${vacancy.id}`}>
          Closing soon
        </Badge>
      )}
    </>
  );

  if (collapsible && !expanded) {
    const excerpt = getDescriptionExcerpt(vacancy.role_description);
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(true);
          }
        }}
        className="rounded-md border border-slate-200 p-4 cursor-pointer hover-elevate"
        aria-expanded={false}
        data-testid={`card-vacancy-${vacancy.id}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className="text-base font-semibold text-slate-900"
                data-testid={`text-vacancy-title-${vacancy.id}`}
              >
                {vacancy.role_title}
              </h3>
              {statusBadges}
            </div>
            {groupName && (
              groupUrl ? (
                <Link
                  to={groupUrl}
                  onClick={stopToggle}
                  className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline w-fit"
                  data-testid={`link-vacancy-group-${vacancy.id}`}
                >
                  <Users2 className="w-4 h-4" />
                  {groupName}
                </Link>
              ) : (
                <span
                  className="inline-flex items-center gap-1.5 text-sm text-slate-600"
                  data-testid={`text-vacancy-group-${vacancy.id}`}
                >
                  <Users2 className="w-4 h-4 text-slate-400" />
                  {groupName}
                </span>
              )
            )}
            {excerpt && (
              <p
                className="text-sm text-slate-600 truncate"
                data-testid={`text-vacancy-excerpt-${vacancy.id}`}
              >
                {excerpt}
              </p>
            )}
          </div>
          <ChevronDown
            className="w-5 h-5 text-slate-400 shrink-0 mt-0.5"
            data-testid={`icon-vacancy-expand-${vacancy.id}`}
          />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-sm text-slate-600">
          {commitment && (
            <span
              className="inline-flex items-center gap-1.5"
              data-testid={`text-vacancy-commitment-${vacancy.id}`}
            >
              <Clock className="w-4 h-4 text-slate-400" />
              {commitment}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1.5"
            data-testid={`text-vacancy-positions-${vacancy.id}`}
          >
            <Users className="w-4 h-4 text-slate-400" />
            {isFilled
              ? `All ${total} position${total === 1 ? "" : "s"} filled`
              : `${remaining} of ${total} position${total === 1 ? "" : "s"} remaining`}
          </span>
          {closingDateLabel && (
            <span
              className="inline-flex items-center gap-1.5"
              data-testid={`text-vacancy-closing-date-${vacancy.id}`}
            >
              <CalendarX className="w-4 h-4 text-slate-400" />
              {isClosed ? `Closed ${closingDateLabel}` : `Closes ${closingDateLabel}`}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-md border border-slate-200 p-4 ${collapsible ? "cursor-pointer" : ""}`}
      onClick={collapsible ? () => setExpanded(false) : undefined}
      onKeyDown={
        collapsible
          ? (e) => {
              if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                e.preventDefault();
                setExpanded(false);
              }
            }
          : undefined
      }
      role={collapsible ? "button" : undefined}
      tabIndex={collapsible ? 0 : undefined}
      aria-expanded={collapsible ? true : undefined}
      data-testid={`card-vacancy-${vacancy.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3
              className="text-base font-semibold text-slate-900"
              data-testid={`text-vacancy-title-${vacancy.id}`}
            >
              {vacancy.role_title}
            </h3>
            {statusBadges}
          </div>
          {groupName && (
            groupUrl ? (
              <Link
                to={groupUrl}
                onClick={collapsible ? stopToggle : undefined}
                className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline w-fit"
                data-testid={`link-vacancy-group-${vacancy.id}`}
              >
                <Users2 className="w-4 h-4" />
                {groupName}
              </Link>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 text-sm text-slate-600"
                data-testid={`text-vacancy-group-${vacancy.id}`}
              >
                <Users2 className="w-4 h-4 text-slate-400" />
                {groupName}
              </span>
            )
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {adminActions && (
            <div
              className="flex flex-wrap items-center gap-2"
              onClick={collapsible ? stopToggle : undefined}
            >
              {adminActions}
            </div>
          )}
          {collapsible && (
            <ChevronDown
              className="w-5 h-5 text-slate-400 shrink-0 rotate-180"
              data-testid={`icon-vacancy-collapse-${vacancy.id}`}
            />
          )}
        </div>
      </div>

      <div
        className="prose prose-sm max-w-none text-sm text-slate-700 mt-2"
        data-testid={`text-vacancy-description-${vacancy.id}`}
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(vacancy.role_description || ""),
        }}
      />

      <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-sm text-slate-600">
        {commitment && (
          <span className="inline-flex items-center gap-1.5" data-testid={`text-vacancy-commitment-${vacancy.id}`}>
            <Clock className="w-4 h-4 text-slate-400" />
            {commitment}
          </span>
        )}
        {term && (
          <span className="inline-flex items-center gap-1.5" data-testid={`text-vacancy-term-${vacancy.id}`}>
            <CalendarClock className="w-4 h-4 text-slate-400" />
            {term}
          </span>
        )}
        {maxTerms && (
          <span className="inline-flex items-center gap-1.5" data-testid={`text-vacancy-maxterms-${vacancy.id}`}>
            <Repeat className="w-4 h-4 text-slate-400" />
            {maxTerms}
          </span>
        )}
        <span
          className="inline-flex items-center gap-1.5"
          data-testid={`text-vacancy-positions-${vacancy.id}`}
        >
          <Users className="w-4 h-4 text-slate-400" />
          {isFilled
            ? `All ${total} position${total === 1 ? "" : "s"} filled`
            : `${remaining} of ${total} position${total === 1 ? "" : "s"} remaining`}
        </span>
        {closingDateLabel && (
          <span
            className="inline-flex items-center gap-1.5"
            data-testid={`text-vacancy-closing-date-${vacancy.id}`}
          >
            <CalendarX className="w-4 h-4 text-slate-400" />
            {isClosed ? `Closed ${closingDateLabel}` : `Closes ${closingDateLabel}`}
          </span>
        )}
      </div>

      {!isClosed && (
        <div className="mt-4" onClick={collapsible ? stopToggle : undefined}>
          {joinLocked ? (
            <Button
              variant="outline"
              size="sm"
              disabled
              data-testid={`button-join-locked-${vacancy.id}`}
            >
              <Lock className="w-4 h-4 mr-2" />
              Join group to access
            </Button>
          ) : alreadyApplied && !vacancy.application_form_id ? (
            <div
              className="inline-flex items-center text-sm text-green-700"
              data-testid={`text-vacancy-applied-${vacancy.id}`}
            >
              <Check className="w-4 h-4 mr-2" />
              You've expressed interest
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onExpressInterest?.(vacancy)}
              disabled={expressDisabled}
              data-testid={`button-express-interest-${vacancy.id}`}
            >
              <Send className="w-4 h-4 mr-2" />
              Express interest
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
