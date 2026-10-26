// Explicit real-browser check, fully in-memory: no app server, tenant or API.
// Run: node --test client/src/components/canvas/blocks/directoryVisitorFilters.browser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const directory = path.dirname(new URL(import.meta.url).pathname);
const source = await readFile(path.join(directory, 'dynamicBlocks.jsx'), 'utf8');
const extract = name => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
};
const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import React, { useState, useEffect, useMemo } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Search, ChevronLeft, ChevronRight, Users } from 'lucide-react';
    import { Input } from '@/components/ui/input';
    import { Button } from '@/components/ui/button';
    import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
    import { TooltipProvider } from '@/components/ui/tooltip';
    import DirectoryVisitorFilterDropdown from '@/components/canvas/blocks/DirectoryVisitorFilterDropdown';
    import { normalizeVisitorFilterFields, pruneVisitorFilters, visitorFiltersKey } from '@/components/canvas/blocks/directoryVisitorFilters.mjs';
    const BLOCK_TYPES = { DYNAMIC_DIRECTORY_EMBED: 'dynamic_directory_embed' };
    const buildResponsiveListGridCss = () => '';
    const Heading = ({children}) => <h2>{children}</h2>;
    const EmptyState = ({text}) => <p>{text}</p>;
    const useDirectoryRecords = () => ({ data: {
      records: [], total: 0, config: { directory: {slug: 'fixture'}, visitorFilterFields: window.fields }
    } });
    ${extract('columnsForBreakpoint')}
    ${extract('isEditorPreviewBreakpoint')}
    ${extract('DirectoryCardsRender')}
    window.mount = asEditor => createRoot(document.getElementById('root')).render(
      <div onClick={() => window.selectionClicks++} onPointerDown={() => window.selectionPointers++}
        style={{height: 180, overflow: 'hidden', transform: 'translateZ(0)', border: '1px solid #aab'}}>
        <DirectoryCardsRender block={{id:'fixture',type:BLOCK_TYPES.DYNAMIC_DIRECTORY_EMBED,
          content:{directorySlug:'fixture'}}} asEditor={asEditor} breakpoint={asEditor ? 'mobile' : undefined}
          icon={Users} fallbackTitle="Directory" />
      </div>);
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  alias: { '@': path.join(process.cwd(), 'client/src') },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await postcss([tailwindcss({
  content: [
    path.join(directory, 'dynamicBlocks.jsx'),
    path.join(directory, 'DirectoryVisitorFilterDropdown.jsx'),
    path.join(process.cwd(), 'client/src/components/ui/{button,input,popover,select}.jsx'),
  ],
})]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined });

test('desktop/mobile public/editor: actual portalled popup stays in viewport, wraps full labels and scrolls', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true, args: ['--no-sandbox'],
  });
  try {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
      for (const editor of [false, true]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => route.abort());
        await page.setContent('<!doctype html><html><body style="margin:12px"><div id="root"></div></body></html>');
        await page.addStyleTag({ content: css.css });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate(asEditor => {
          window.selectionClicks = 0;
          window.selectionPointers = 0;
          window.fields = [{
            id: 'specialism', field_type: 'multi_select',
            label: 'Specialisms across regional partnerships and international community organisations',
            options: Array.from({ length: 24 }, (_, i) => ({
              value: String(i),
              label: i === 0 ? 'International collaboration, community archives and research partnerships with exceptionally long descriptive labels'
                : i === 1 ? 'UnbrokenOptionLabel'.repeat(14) : `Regional partnership ${i}: long descriptions that should remain fully visible without truncation`,
            })),
          }];
          window.mount(asEditor);
        }, editor);
        const trigger = page.getByTestId('button-directory-filters');
        await trigger.click();
        const popup = page.getByTestId('directory-filter-popover');
        await popup.waitFor();
        await popup.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
        const bounds = await popup.evaluate(el => {
          const r = el.getBoundingClientRect();
          const spans = [...el.querySelectorAll('label span')].slice(0, 2);
          return {
            left: r.left, right: r.right, top: r.top, bottom: r.bottom,
            scrollable: el.scrollHeight > el.clientHeight,
            fits: el.scrollWidth <= el.clientWidth,
            portal: !document.getElementById('root').contains(el),
            wraps: spans.map(span => ({
              height: span.getBoundingClientRect().height,
              line: parseFloat(getComputedStyle(span).lineHeight),
              whitespace: getComputedStyle(span).whiteSpace,
              overflow: span.scrollWidth <= span.clientWidth,
            })),
          };
        });
        assert.ok(bounds.left >= 11 && bounds.right <= viewport.width - 11, JSON.stringify(bounds));
        assert.ok(bounds.top >= 11 && bounds.bottom <= viewport.height - 11, JSON.stringify(bounds));
        assert.ok(bounds.portal && bounds.fits && bounds.scrollable, JSON.stringify(bounds));
        for (const wrap of bounds.wraps) assert.ok(wrap.height > wrap.line && wrap.whitespace === 'normal' && wrap.overflow, JSON.stringify(wrap));
        await popup.getByRole('checkbox').first().check();
        await trigger.waitFor();
        assert.match(await trigger.textContent(), /1/);
        if (editor) {
          assert.equal(await page.evaluate(() => window.selectionClicks), 0);
          assert.equal(await page.evaluate(() => window.selectionPointers), 0);
        }
        await popup.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await popup.getByRole('checkbox').last().check();
        assert.match(await trigger.textContent(), /2/);
        await page.keyboard.press('Escape');
        await popup.waitFor({ state: 'hidden' });
        await trigger.click();
        await page.getByTestId('button-directory-filters-clear').click();
        assert.equal(await page.getByTestId('directory-filter-summary').count(), 0);
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
