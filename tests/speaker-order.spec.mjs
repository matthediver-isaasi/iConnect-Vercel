import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";

test("isolated picker confirms display order and discards Escape edits", async ({ page }) => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: "jsx", contents: `
      import React, {useState} from "react";
      import {createRoot} from "react-dom/client";
      import {SpeakerSelectionModal} from "./client/src/components/SpeakerSelectionModal.jsx";
      import {speakersInOrder} from "./shared/speakerOrder.js";
      import {SessionCard} from "./client/src/components/events/ComplexEventSchedule.jsx";
      const speakers = [{id:"a",full_name:"Alice"},{id:"b",full_name:"Zara"}];
      function Fixture() {
        const [ids,setIds]=useState(["b","a"]);
        const [open,setOpen]=useState(true);
        return <><button onClick={()=>setOpen(true)}>Edit speakers</button>
          <section data-testid="public-speakers"><SessionCard session={{id:"fixture",title:"Public session",speaker_ids:ids}} speakerMap={Object.fromEntries(speakers.map(s=>[s.id,s]))}/></section>
          <SpeakerSelectionModal open={open} onOpenChange={setOpen} speakers={speakers} selectedSpeakerIds={ids} onConfirm={setIds}/></>;
      }
      createRoot(document.getElementById("root")).render(<Fixture/>);
    ` },
    bundle: true, write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{ name: "alias", setup(b) {
      b.onResolve({ filter: /^@\// }, ({ path: name }) => {
        if (name === "@/api/publicClient") return { path: name, namespace: "stub" };
        const base = path.resolve("client/src", name.slice(2));
        return { path: [base, base + ".jsx", base + ".js", base + ".tsx"].find(existsSync) };
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const publicClient = {};" }));
    } }],
  });
  await page.route("**/*", route => {
    if (route.request().url() === "http://speaker-order.fixture/") return route.fulfill({
      contentType: "text/html", body: `<html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`,
    });
    return route.abort();
  });
  await page.goto("http://speaker-order.fixture/");
  const selected = page.locator('[data-testid^="speaker-selected-"]');
  await expect(selected.first()).toContainText("Zara");
  await page.getByRole("button", { name: "Move Alice up", exact: true }).click();
  await expect(selected.first()).toContainText("Alice");
  await page.getByTestId("button-confirm-speakers").click();
  await expect(page.getByTestId("public-speakers").locator('[data-testid^="session-speaker-"] span.text-xs')).toHaveText(["Alice", "Zara"]);
  await page.getByText("Edit speakers", { exact: true }).click();
  await page.getByRole("button", { name: "Move Zara up", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByText("Edit speakers", { exact: true }).click();
  await expect(selected.first()).toContainText("Alice");
});
