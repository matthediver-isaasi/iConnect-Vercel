---
name: TipTap Link per-link target/new-tab
description: Why a per-mark target:null can't make a same-tab link, and how to actually change the default.
---
To support a per-link "open in new tab" choice on the TipTap Link extension (`@tiptap/extension-link`), you CANNOT just drop `HTMLAttributes` from `Link.configure(...)` and pass `setLink({ target: null })`.

**Why:**
- The extension's own `addOptions()` default is `HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' }`.
- `.configure()` **deep-merges** your options over those defaults (`mergeDeep`), so omitting `HTMLAttributes` leaves `target: '_blank'` intact.
- `renderHTML` does `mergeAttributes(this.options.HTMLAttributes, perMarkAttributes)` — the global HTMLAttributes are always merged. A per-mark `target:null` is dropped from the per-mark object (null attrs aren't rendered), so the global `'_blank'` wins → every link still opens in a new tab.

**How to apply:**
- Explicitly null the global default: `Link.configure({ openOnClick: false, HTMLAttributes: { target: null, rel: null } })`. Then new links default to same tab.
- Write the per-link choice via `setLink({ href, target: newTab ? '_blank' : null, rel: newTab ? 'noopener noreferrer' : null })`. `mergeAttributes` skips falsy globals so per-mark `'_blank'` overrides null; ProseMirror's serializer omits null attributes.
- Existing saved links keep `target`/`rel` because `parseHTML` reads them from the stored HTML; read `editor.getAttributes('link').target === '_blank'` to seed the dialog toggle.
