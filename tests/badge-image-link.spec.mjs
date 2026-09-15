import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const urls = [
  "https://storage.example.test/storage/v1/object/public/images/library-badges/first%20badge%2F%25.png?x=1&y=%2f+2#part%20one",
  `https://storage.example.test/storage/v1/object/public/images/library-badges/${"long-name-".repeat(30)}.png`,
];
const resolvedUrls = urls.map(url => url.replace("https://storage.example.test", "https://vault.iconn.app"));
const unchangedUrls = [
  "https://vault.iconn.app/storage/v1/object/public/images/badge%20one.png?x=%2f#badge",
  "https://other.supabase.co/storage/v1/object/public/images/badge.png",
  "https://external.example/badge.png",
  "https://storage.example.test/storage/v1/object/sign/images/badge.png?token=test",
  "https://storage.example.test.evil.test/storage/v1/object/public/images/badge.png",
];
let script, css;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from "react";
        import {createRoot} from "react-dom/client";
        import BadgeImageLink from "./client/src/components/badges/BadgeImageLink.jsx";
        const badges = [
          {id:"one", name:"First badge", image_url:${JSON.stringify(urls[0])}},
          {id:"two", name:"Inactive badge", is_active:false, image_url:${JSON.stringify(urls[1])}},
          {id:"empty", name:"Missing image", image_url:null},
          {id:"blank", name:"Blank image", image_url:"   "},
          {id:"unset", name:"Unset image"},
          ...${JSON.stringify(unchangedUrls)}.map((image_url, i) => ({id:"unchanged-"+i, name:"External or custom badge", image_url})),
        ];
        createRoot(document.getElementById("root")).render(<div>{badges.map(badge =>
          <BadgeImageLink key={badge.id} badge={badge}/>)}</div>);`,
      resolveDir: process.cwd(), loader: "jsx",
    },
    bundle: true, write: false, jsx: "automatic",
    alias: { "@": path.resolve("client/src") },
    define: { "process.env.NODE_ENV": '"test"', "import.meta.env.VITE_SUPABASE_URL": '"https://storage.example.test"' },
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: ["client/src/components/badges/BadgeImageLink.jsx", "client/src/components/ui/{dialog,button,textarea}.jsx"],
    corePlugins: { preflight: true },
  })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
});

test.beforeEach(async ({ page }) => {
  await page.setContent('<html><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
});

test("exact URLs, inactive badges, missing images, and clipboard success", async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async text => { window.copied = text; } },
  }));
  await expect(page.getByTestId("button-image-link-badge-empty")).toBeDisabled();
  await expect(page.getByTestId("button-image-link-badge-blank")).toBeDisabled();
  await expect(page.getByTestId("button-image-link-badge-unset")).toBeDisabled();
  for (const [index, id] of ["one", "two"].entries()) {
    await page.getByTestId(`button-image-link-badge-${id}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(index ? "Inactive badge" : "First badge");
    await expect(dialog.getByLabel("Public image URL")).toHaveValue(resolvedUrls[index]);
    await expect(dialog.getByLabel("Public image URL")).toHaveAttribute("readonly", "");
    await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Image link copied.");
    expect(await page.evaluate(() => window.copied)).toBe(resolvedUrls[index]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`button-image-link-badge-${id}`)).toBeFocused();
  }
});

test("custom and unrelated links are displayed and copied unchanged", async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async text => { window.copied = text; } },
  }));
  for (const [index, url] of unchangedUrls.entries()) {
    await page.getByTestId(`button-image-link-badge-unchanged-${index}`).click();
    await expect(page.getByLabel("Public image URL")).toHaveValue(url);
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Image link copied.");
    expect(await page.evaluate(() => window.copied)).toBe(url);
    await page.keyboard.press("Escape");
  }
});

for (const mode of ["denied", "unavailable"]) {
  test(`clipboard ${mode} leaves manual fallback, keyboard focus and narrow layout`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(mode => Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: mode === "unavailable" ? undefined : { writeText: async () => { throw Error("Denied"); } },
    }), mode);
    await page.getByTestId("button-image-link-badge-two").focus();
    await page.keyboard.press("Enter");
    const field = page.getByLabel("Public image URL");
    await expect(field).toBeFocused();
    expect(await field.evaluate(el => el.selectionEnd - el.selectionStart)).toBe(resolvedUrls[1].length);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Copy link", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("copy it manually");
    await expect(field).toHaveValue(resolvedUrls[1]);
    const box = await page.getByRole("dialog").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await page.getByRole("dialog").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(field).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("button-image-link-badge-two")).toBeFocused();
  });
}