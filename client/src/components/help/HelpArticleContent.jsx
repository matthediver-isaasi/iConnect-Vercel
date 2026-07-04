import React from "react";
import { ImageIcon } from "lucide-react";

/**
 * Renders Help Center article bodies (Task #2199).
 *
 * Supported lightweight formatting (one construct per line):
 *   # / ## / ###   → headings
 *   - text         → bullet list item
 *   blank line     → paragraph break
 *   {{screenshot: Label | optional-image-url}}
 *                  → a labeled placeholder box until an image URL is supplied,
 *                    then the <img> itself. Swapping in a real screenshot needs
 *                    no code change — just add the URL to the token.
 *
 * The parser is intentionally simple (a pilot). It never renders raw HTML, so
 * article bodies cannot inject markup.
 */

const SCREENSHOT_RE = /\{\{\s*screenshot\s*:\s*([^}]*)\}\}/i;

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

export default function HelpArticleContent({ body }) {
  const source = typeof body === "string" ? body : "";
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  const blocks = [];
  let paragraph = [];
  let bullets = [];

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
                {block.text}
              </h2>
            );
          case "h2":
            return (
              <h3 key={i} className="text-xl font-semibold tracking-tight">
                {block.text}
              </h3>
            );
          case "h3":
            return (
              <h4 key={i} className="text-lg font-semibold tracking-tight">
                {block.text}
              </h4>
            );
          case "ul":
            return (
              <ul key={i} className="list-disc space-y-1 pl-6">
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            );
          case "screenshot":
            return <ScreenshotBlock key={i} label={block.label} url={block.url} />;
          case "p":
          default:
            return (
              <p key={i} className="leading-relaxed text-foreground">
                {block.text}
              </p>
            );
        }
      })}
    </div>
  );
}
