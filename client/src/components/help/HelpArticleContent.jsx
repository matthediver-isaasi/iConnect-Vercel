import React from "react";
import { ImageIcon } from "lucide-react";

/**
 * Renders Help Center article bodies (Task #2199).
 *
 * Supported lightweight formatting (one construct per line):
 *   # / ## / ###   → headings
 *   - text         → bullet list item
 *   blank line     → paragraph break
 *   [label](/help/article-slug)
 *                  → a safe internal Help Center link
 *   **text**       → strong emphasis
 *   {{screenshot: Label | optional-image-url}}
 *                  → a labeled placeholder box until an image URL is supplied,
 *                    then the <img> itself. Swapping in a real screenshot needs
 *                    no code change — just add the URL to the token.
 *   {{feature: feature.key}} ... {{/feature}}
 *                  → RBAC section gate (Task #2208). Everything between the open
 *                    and close markers is shown only when the reader can access
 *                    that feature key. Gated blocks (heading and all) are dropped
 *                    cleanly when access is missing. Markers may be nested.
 *
 * The parser is intentionally simple (a pilot). It never renders raw HTML, so
 * article bodies cannot inject markup.
 *
 * Access is evaluated via the `canAccessFeature` prop: (featureKey) => boolean.
 * It defaults to always-allow so the platform editor preview shows every
 * section; the portal passes a real member-access check.
 */

const SCREENSHOT_RE = /\{\{\s*screenshot\s*:\s*([^}]*)\}\}/i;
const FEATURE_OPEN_RE = /^\{\{\s*feature\s*:\s*([^}]*)\}\}$/i;
const FEATURE_CLOSE_RE = /^\{\{\s*\/\s*feature\s*\}\}$/i;
const INLINE_FORMAT_RE = /\[([^\]]+)\]\((\/help\/[a-z0-9-]+)\)|\*\*([^*]+)\*\*/gi;

function renderInlineText(text) {
  const parts = [];
  let cursor = 0;
  let match;
  INLINE_FORMAT_RE.lastIndex = 0;

  while ((match = INLINE_FORMAT_RE.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push(text.slice(cursor, match.index));
    }
    if (match[2]) {
      parts.push(
        <a
          key={`${match.index}-${match[2]}`}
          href={match[2]}
          className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
        >
          {match[1]}
        </a>,
      );
    } else {
      parts.push(<strong key={`${match.index}-strong`}>{match[3]}</strong>);
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts.length ? parts : text;
}

function parseScreenshotToken(line) {
  const match = line.match(SCREENSHOT_RE);
  if (!match) return null;
  const inner = match[1].trim();
  const [labelPart, urlPart] = inner.split("|");
  const label = (labelPart || "").trim() || "Screenshot";
  const url = (urlPart || "").trim();
  return { label, url };
}

function ScreenshotBlock({ label, url }) {
  if (url) {
    return (
      <figure className="my-4" data-testid="help-screenshot-image">
        <img
          src={url}
          alt={label}
          className="w-full rounded-md border"
          loading="lazy"
        />
        <figcaption className="mt-2 text-sm text-muted-foreground">{label}</figcaption>
      </figure>
    );
  }
  return (
    <div
      className="my-4 flex flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/40 px-6 py-10 text-center"
      data-testid="help-screenshot-placeholder"
    >
      <ImageIcon className="h-8 w-8 text-muted-foreground" />
      <span className="text-sm font-medium text-muted-foreground">Screenshot: {label}</span>
      <span className="text-xs text-muted-foreground">Image coming soon</span>
    </div>
  );
}

export default function HelpArticleContent({ body, canAccessFeature }) {
  const source = typeof body === "string" ? body : "";
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  const allows =
    typeof canAccessFeature === "function" ? canAccessFeature : () => true;

  const blocks = [];
  let paragraph = [];
  let bullets = [];

  // Feature-gate state. `gateDepth` tracks nesting of {{feature}} markers.
  // `skipDepth` is 0 when rendering; when we enter a block the reader can't
  // access it becomes the depth at which skipping started, and we drop every
  // line (including nested markers) until we climb back above it.
  let gateDepth = 0;
  let skipDepth = 0;
  const isSkipping = () => skipDepth > 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      blocks.push({ type: "ul", items: bullets });
      bullets = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Feature-gate markers are handled before anything else so gated content
    // (and the markers themselves) never leak into the rendered output.
    const openMatch = line.match(FEATURE_OPEN_RE);
    if (openMatch) {
      flushParagraph();
      flushBullets();
      gateDepth += 1;
      if (!isSkipping()) {
        const key = openMatch[1].trim();
        if (key && !allows(key)) {
          skipDepth = gateDepth;
        }
      }
      continue;
    }
    if (FEATURE_CLOSE_RE.test(line)) {
      if (!isSkipping()) {
        flushParagraph();
        flushBullets();
      }
      if (skipDepth && gateDepth === skipDepth) {
        skipDepth = 0;
      }
      if (gateDepth > 0) gateDepth -= 1;
      continue;
    }
    if (isSkipping()) {
      continue;
    }

    if (!line) {
      flushParagraph();
      flushBullets();
      continue;
    }

    const screenshot = parseScreenshotToken(line);
    if (screenshot) {
      flushParagraph();
      flushBullets();
      blocks.push({ type: "screenshot", ...screenshot });
      continue;
    }

    if (line.startsWith("### ")) {
      flushParagraph();
      flushBullets();
      blocks.push({ type: "h3", text: line.slice(4).trim() });
      continue;
    }
    if (line.startsWith("## ")) {
      flushParagraph();
      flushBullets();
      blocks.push({ type: "h2", text: line.slice(3).trim() });
      continue;
    }
    if (line.startsWith("# ")) {
      flushParagraph();
      flushBullets();
      blocks.push({ type: "h1", text: line.slice(2).trim() });
      continue;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      bullets.push(line.slice(2).trim());
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  flushBullets();

  if (!blocks.length) {
    return (
      <p className="text-muted-foreground" data-testid="help-article-empty">
        This article has no content yet.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="help-article-content">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h1":
            return (
              <h2 key={i} className="text-2xl font-semibold tracking-tight">
                {renderInlineText(block.text)}
              </h2>
            );
          case "h2":
            return (
              <h3 key={i} className="text-xl font-semibold tracking-tight">
                {renderInlineText(block.text)}
              </h3>
            );
          case "h3":
            return (
              <h4 key={i} className="text-lg font-semibold tracking-tight">
                {renderInlineText(block.text)}
              </h4>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-1 pl-6">
                {block.items.map((item, j) => (
                  <li key={j}>{renderInlineText(item)}</li>
                ))}
              </ul>
            );
          case "screenshot":
            return <ScreenshotBlock key={i} label={block.label} url={block.url} />;
          case "p":
          default:
            return (
              <p key={i} className="leading-relaxed text-foreground">
                {renderInlineText(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
