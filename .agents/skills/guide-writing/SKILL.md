---
name: guide-writing
description: Write technical feature guides for the guides/ directory. Use when the user asks to document a feature, module, or system, or when creating a new guide for developer reference.
---

# Guide Writing

Write comprehensive technical guides for this project's `guides/` directory. Every guide should serve as a definitive developer reference for a feature or module — written so a new developer (or a future version of yourself) can fully understand how the system works without reading the source code first.

## When to Use

- User asks to document a feature, module, or system
- A new major feature has been built and needs a reference guide
- An existing guide needs updating after significant changes

## File Location and Naming

- All guides live in the `guides/` directory at the project root
- Use lowercase kebab-case filenames: `guides/feature-name.md`
- One guide per major feature or module

## Required Structure

Every guide must follow this exact section structure. Sections can be omitted only if genuinely not applicable to the feature.

### 1. Title Block

```markdown
# Feature Name

**Author:** [name]
**Last Updated:** [Month Year]
**Module:** [Module or area name]

---
```

### 2. Table of Contents

A numbered list linking to every major section. Use markdown anchor links.

### 3. Overview

A 2–3 paragraph summary that answers:
- What does this feature do?
- What is the core design principle? (e.g. single source of truth, event-driven, etc.)
- What are the key user-facing behaviours?

### 4. Architecture

#### Key Files Table

A table listing every file involved in this feature:

```markdown
| File | Purpose |
|------|---------|
| `path/to/file.js` | One-line description |
```

#### Design Principles

A numbered list of the core design decisions. Each should be one sentence explaining the "what" and a brief clause explaining the "why".

### 5. Core Logic Sections

The bulk of the guide. Break the feature's logic into logical sections. For each section:

- **Explain the concept** in plain language first
- **Show the algorithm** using pseudocode blocks when calculations are involved
- **Document edge cases** and boundary conditions
- **Note any approximations** or non-obvious conversions (e.g. "months are converted to days using 30.44")

Use fenced code blocks for pseudocode, SQL queries, function signatures, and data structures. Label them with the language or `text` for pseudocode.

### 6. Configuration / Settings

If the feature has configurable modes, options, or settings:

- List each option with a heading (e.g. `### Automatic`, `### Manual`)
- For each, describe:
  - **What happens** — the user-facing summary
  - **How each code path behaves** — what does the workflow do? The cron? The UI?
- Document **default behaviour** when no setting exists
- Document **legacy fallback** behaviour if applicable

### 7. Code Paths / Entry Points

If the feature has multiple entry points (API endpoints, cron jobs, workflow actions, UI triggers):

- Give each its own subsection with a clear heading
- For each path, document:
  - **File** and function name
  - **Trigger** — what causes this path to execute
  - **Flow** — numbered step-by-step list of what happens
  - **Key details** — important nuances, caveats, or notes as a callout after the flow

### 8. Safeguards and Error Handling

Document every layer of protection the system has:

- List each safeguard with its own subheading
- Include code snippets showing the actual check (SQL query, if-statement, constraint)
- Explain what happens when each safeguard catches something

### 9. Frontend UI

If the feature has a frontend component:

- **File** reference
- **Layout** description — what does the user see?
- **Component breakdown** — what each component displays and controls
- **Key behaviours** — important UX details (e.g. "button only appears on current year")
- **Mutations table** — table of all mutations with endpoint, method, and purpose
- **Cache invalidation** — which query keys are invalidated after mutations

### 10. Database Tables

For each table involved:

- Table name as a heading
- Brief description of the table's purpose
- Column table with: Column, Type, Description

### 11. Data Flow Diagrams

ASCII flow diagrams showing how data moves through the system for each major scenario. Use the arrow notation:

```
Trigger event
  → Step 1
    → Step 2
      → Decision point? ✓
      → Outcome
```

Add explanatory notes after diagrams when the flow has non-obvious implications.

### 12. External Integrations

If the feature integrates with external services (Xero, Stripe, etc.):

- Name the service
- Describe what data is sent/received
- Note any mapping or transformation logic
- Document error handling for the integration

### 13. Configuration Reference

A quick-reference table of all configurable values:

```markdown
| Setting | Location | Values | Default | Description |
|---------|----------|--------|---------|-------------|
```

### 14. Troubleshooting

Common issues and how to diagnose them:

```markdown
### Problem: [Short description]
**Symptom:** What the user or admin sees
**Cause:** Why it happens
**Fix:** How to resolve it
```

## Writing Style

- **Tone**: Written from the developer's perspective (first person plural "we" is fine). Assume the reader is a developer who is new to this feature but familiar with the overall project.
- **Precision over brevity**: When describing logic, be exact. Show the formula. Name the variables. If there's an approximation, say so.
- **Show the code path**: When describing what happens, trace through the actual code flow with file and function names.
- **Call out nuances**: Use bold callouts like `**Important:**` or `**Note:**` for non-obvious behaviours, edge cases, or potential gotchas.
- **No ambiguity in modes/states**: When a feature has multiple modes (e.g. Automatic vs Scheduled vs Manual), document every mode's behaviour for every code path. Don't leave the reader guessing what happens in a specific combination.
- **Consistent terminology**: Pick one term for each concept and use it everywhere. Define terms on first use if they're project-specific.

## Formatting Rules

- Use `---` horizontal rules between major sections
- Use tables for structured data (file lists, columns, settings, mutations)
- Use fenced code blocks with language labels for all code, pseudocode, and SQL
- Use bullet lists for behaviours and numbered lists for sequential flows
- Keep pseudocode blocks focused — show one calculation or algorithm per block
- Use bold for field names, file paths, and important terms on first mention within a section

## Quality Checklist

Before considering a guide complete, verify:

- [ ] Every code path is documented (what triggers it, what it does, what it returns)
- [ ] Every mode/setting combination is covered (no "what happens if X and Y?" gaps)
- [ ] Default and fallback behaviours are explicitly stated
- [ ] All database tables involved are listed with their columns
- [ ] Error handling and safeguards are documented
- [ ] The guide is consistent with the actual code (re-read relevant source files to verify)
- [ ] Data flow diagrams cover the main scenarios
- [ ] Troubleshooting section covers the most common failure modes

## Example Reference

See `guides/membership-renewal.md` as the reference implementation of this structure. New guides should match its level of detail and organisation.
