---
title: "iConnect Platform — Technology & Capability Overview"
subtitle: "A Comprehensive White Paper for Prospective Clients"
date: "February 2026"
version: "1.0"
classification: "Commercial in Confidence"
---

# iConnect Platform

## Technology & Capability Overview

**A Comprehensive White Paper for Prospective Clients**

*February 2026 — Version 1.0*

*Classification: Commercial in Confidence*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Platform Overview](#2-platform-overview)
3. [Core Architecture](#3-core-architecture)
4. [Member & Organisation Management](#4-member--organisation-management)
5. [Membership & Financial Management](#5-membership--financial-management)
6. [Events, Bookings & Ticketing](#6-events-bookings--ticketing)
7. [Content Management & Publishing](#7-content-management--publishing)
8. [Communication & Engagement](#8-communication--engagement)
9. [Workflow Automation](#9-workflow-automation)
10. [Due Diligence & Compliance](#10-due-diligence--compliance)
11. [Fundraising & Donations](#11-fundraising--donations)
12. [Community Forums](#12-community-forums)
13. [Job Board](#13-job-board)
14. [Identity & Access Management](#14-identity--access-management)
15. [Customisation & Branding](#15-customisation--branding)
16. [Security & Data Protection](#16-security--data-protection)
17. [Integration Ecosystem](#17-integration-ecosystem)
18. [Deployment, Reliability & Scalability](#18-deployment-reliability--scalability)
19. [Summary & Next Steps](#19-summary--next-steps)

---

## 1. Executive Summary

iConnect is a modern, cloud-hosted membership management platform designed to help organisations streamline operations, engage their members, and manage financial processes — all from a single, unified system.

Built as a multi-tenant Software-as-a-Service (SaaS) solution, iConnect serves membership bodies, trade associations, professional institutes, and similar organisations that need to manage complex member relationships, tiered pricing structures, event programmes, and regulatory compliance — without the overhead of managing separate tools for each function.

**Key benefits at a glance:**

- **Unified Platform** — Members, organisations, events, content, finances, and communications in one place
- **Multi-Tenant by Design** — Each client operates in a fully isolated environment with their own branding, data, and configuration
- **Flexible Membership Pricing** — Tiered, flat-rate, or custom pricing with pro-rata calculations, discounts, and rollover support
- **Automated Workflows** — Reduce manual effort by automating renewals, onboarding, emails, and compliance processes
- **Enterprise-Grade Security** — Role-based access control, encrypted credentials, tenant data isolation, and secure payment processing
- **Seamless Integrations** — Native connections to Stripe, Xero, Microsoft Outlook, Mailgun, and more

---

## 2. Platform Overview

### What iConnect Does

iConnect is a purpose-built platform for organisations that manage memberships. It replaces the patchwork of spreadsheets, email tools, payment systems, and disconnected databases that many membership bodies rely on today.

The platform provides a comprehensive suite of tools covering:

- Member and organisation record management
- Membership tier pricing and renewals
- Event management and ticketing
- Content publishing (articles, news, resources, blogs)
- Email marketing and communication preferences
- Custom forms and data collection
- Workflow automation
- Fundraising and donation campaigns
- Community discussion forums
- Job board for member vacancies
- Due diligence and compliance processes
- Financial integration with accounting software
- Data import and migration tools

### Who It's For

iConnect is designed for any organisation that manages a membership base, including:

- Trade associations and industry bodies
- Professional institutes and regulatory bodies
- Chambers of commerce
- Charitable organisations with membership programmes
- Networks and consortia
- Any body managing organisational or individual memberships

### How It's Delivered

iConnect is delivered as a fully managed cloud service. There is no software to install, no servers to maintain, and no upgrades to schedule. Each client receives their own branded portal accessible via a custom subdomain, with all infrastructure, security patches, and performance optimisations handled by the iConnect team.

---

## 3. Core Architecture

### Multi-Tenant Design

iConnect is built from the ground up as a multi-tenant platform. This means multiple client organisations share the same underlying infrastructure, but each operates in a completely isolated environment. No client can ever see, access, or affect another client's data.

**Three-Tier Hierarchy:**

The platform organises data across three distinct levels:

| Level | Description | Example |
|-------|-------------|---------|
| **Tenant** | The subscribing client — the top-level boundary | "UK Manufacturing Association" |
| **Organisation** | Member companies or entities within the tenant | "Acme Engineering Ltd" |
| **Member** | Individual people associated with organisations | "Jane Smith, Director" |

This hierarchy ensures that every piece of data — from member records to invoices to event registrations — is correctly scoped and isolated.

### Modern Technology Stack

The platform is built using industry-standard, proven technologies:

- **Responsive Interface:** A modern web application that works seamlessly across desktop, tablet, and mobile browsers
- **Secure Backend:** A robust backend handling business logic, data validation, and secure communications
- **Enterprise-Grade Database:** Reliable, transactional data storage ensuring data integrity at all times
- **Live Collaboration:** Changes made by one administrator are immediately visible to others — no manual refreshing required
- **Cloud Infrastructure:** Hosted on globally distributed cloud infrastructure with automatic scaling

### Data Import & Migration

iConnect includes robust tools for onboarding and data management:

- **Data Import:** Bulk import member, organisation, and related data from spreadsheets or existing systems
- **Migration Framework:** A structured migration system for safely updating data models as your requirements evolve
- **Server-Side Pagination:** Large datasets are handled efficiently, ensuring fast load times even with tens of thousands of records

---

## 4. Member & Organisation Management

### Organisation Records

Each member organisation has a comprehensive profile that can be tailored to capture the specific data points your organisation needs. Standard fields include company name, registration details, contact information, and sector classification, but the system supports fully customisable fields to match your data model.

**Key capabilities:**

- **Custom Fields:** Define any number of additional data fields specific to your sector or requirements
- **Organisation Directory:** A searchable, filterable directory of member organisations, configurable for both public and member-only access
- **Team Management:** Track the individuals associated with each organisation, including their roles and contact details
- **Notes & Activity History:** Maintain internal notes and a full audit trail of interactions with each organisation

### Member Records

Individual member profiles capture personal details, contact information, communication preferences, and membership history. Each member's record is linked to their parent organisation(s), providing a clear view of the people within your membership base.

**Key capabilities:**

- **Member Directory:** Searchable directory with configurable visibility based on member roles
- **Communication Preferences:** Members control how and when they receive communications
- **Self-Service Portal:** Members can update their own details, view events, access resources, and manage their preferences through a branded portal
- **Bookmarking:** Members can bookmark content, resources, and events for quick access, with drag-and-drop organisation

### Resource Management

Upload and manage documents, files, and resources for your membership:

- **View Tracking:** The system tracks unique views per resource, providing insights into which materials are most accessed
- **Analytics Dashboard:** Resource cards display view counts at a glance, with detailed analytics reports available showing who accessed what and when
- **Usage Reporting:** Administrators can generate reports on resource engagement across their membership base, helping inform content strategy

---

## 5. Membership & Financial Management

### Flexible Pricing Structures

iConnect supports sophisticated membership pricing models to accommodate virtually any fee structure:

- **Tiered Pricing:** Fees based on organisation attributes such as size, turnover, or employee count, with configurable bands and rates
- **Flat-Rate Pricing:** A single fixed cost for all members, regardless of attributes
- **Multiple Active Structures:** Run several pricing configurations simultaneously, optionally scoped to specific organisation segments
- **Historical Versioning:** Maintain a complete history of pricing changes for audit and reference purposes
- **Custom Discounts:** Configure discount rules based on organisation attributes, with multiple rules that stack and apply automatically

### Pro-Rata & Rollover Calculations

The platform handles the complex arithmetic of mid-year joins and renewals:

- **Pro-Rata Pricing:** Automatically calculates partial-year fees for organisations joining mid-cycle
- **Free Periods:** Configurable free periods at the start of membership
- **Rollover Discounts:** Automatic discounts applied when a membership crosses from one year into the next
- **Go-Live Date Logic:** The system intelligently determines how discounts apply based on when an organisation's membership becomes active

### Invoicing Modes

Administrators have full control over how and when invoices are generated:

| Mode | Description |
|------|-------------|
| **Automatic** | Invoices are generated and sent automatically based on the go-live date |
| **Scheduled** | Invoices are queued for batch processing at a designated time |
| **Manual** | Administrators trigger invoicing on a per-organisation basis |

Each invoicing mode operates independently per membership year, giving administrators granular control over the renewal cycle.

### Fee Approval Workflow

For organisations requiring additional oversight, iConnect includes a configurable fee approval system:

- **Approval Toggle:** Administrators can require that all membership fees are reviewed and approved before being sent to members
- **Admin-Level Control:** The approval requirement is enforced across all processing paths — automated renewals, manual renewals, and workflow-triggered renewals
- **Approval Queue:** Pending fees are presented in a clear queue for administrators to review, approve, or reject

### Fee Notification & Email

Administrators can send branded fee notification emails directly to organisation finance contacts:

- **One-Click Sending:** The "Email Fees" function generates a secure, personalised email to the relevant finance contact
- **Branded Content:** Fee emails are styled with the tenant's branding and include a full cost breakdown
- **Secure Payment Link:** Each email contains a unique, time-limited link directing the recipient to the payment portal

### Member Payment Portal

A branded, public-facing payment page allows organisation finance contacts to:

- View a detailed breakdown of their membership fees (tier, discounts, pro-rata adjustments)
- Submit purchase order numbers for their records
- Pay securely online via Stripe
- Receive automatic confirmation upon payment

The payment portal uses secure, time-limited links (30-day expiry) and tracks the full lifecycle of each fee notification — from initial email through to payment completion. Statuses include pending, purchase order submitted, paid, expired, and cancelled.

### Accounting Integration

Membership fees integrate directly with Xero accounting software:

- Invoices are created automatically in Xero when fees are processed
- Purchase order numbers flow through to Xero invoice references
- Membership history records are created alongside invoices for a complete audit trail
- Support for VAT calculations based on membership tier and band

### Cost Preview & Simulation

Administrators can preview membership costs before committing:

- **Rolling Two-Year View:** See current year and next year costs side by side
- **Full Breakdown:** Tier, discounts, pro-rata, and rollover amounts displayed clearly
- **Simulation Mode:** Run "what-if" scenarios to see how changes affect pricing
- **Override Capability:** Manually override calculated costs where exceptions are needed, with full audit trail

---

## 6. Events, Bookings & Ticketing

### Event Management

Create and manage events with comprehensive detail:

- Event descriptions, dates, times, and locations
- Multiple ticket types with individual pricing
- Speaker and agenda management
- Timezone-aware scheduling with automatic display adjustments
- Zoom integration for virtual events

### Booking System

An integrated booking system allows members to schedule appointments and meetings:

- **Agent-Based Booking:** Define booking agents with their own availability profiles
- **Meeting Templates:** Tenant-specific meeting types with configurable durations and descriptions
- **Availability Management:** Agents set their own availability windows
- **Automated Confirmations:** Booking confirmations and reminders sent automatically

### Ticketing & Commerce

- Discount code management for promotional pricing
- Ticket sales analytics and reporting
- Member balance tracking and transaction history
- Invoice generation for ticket purchases

---

## 7. Content Management & Publishing

### Dynamic Page Builder

iConnect includes a visual page builder that allows administrators to create custom pages without any technical knowledge. Pages can include text, images, forms, and interactive elements, all arranged through a drag-and-drop interface.

### Articles & News

A full content management system for publishing articles, news updates, and thought leadership content:

- Rich text editing with media embedding
- Category and tag management
- Article follow functionality — members can follow topics of interest
- Publishing workflows with draft and published states
- Configurable visibility based on member roles

### Blog Posts

A dedicated blog module for regular content publishing, supporting the same rich editing and categorisation features as the articles system.

### Resources & File Management

Upload, organise, and distribute documents, guides, and other files to your membership:

- Categorised file library
- View tracking with per-resource analytics
- Role-based access control — restrict certain resources to specific member groups
- Award and recognition management for content contributors

---

## 8. Communication & Engagement

### Email Integration

iConnect provides multiple channels for member communication:

- **Outlook Integration:** Send emails directly through your organisation's existing Outlook account, maintaining your established email identity and reputation
- **Dedicated Email Domains:** High-deliverability transactional and marketing email through dedicated, tenant-specific sending domains
- **Automated Setup:** Each tenant receives their own verified email sending domain, fully configured and ready to use without manual technical steps

### Email Marketing

A built-in email marketing system:

- Campaign creation with rich content editing
- Scheduled sending
- Preview and test send capabilities
- Unsubscribe management
- Footer customisation per campaign

### Email Templates & Placeholders

A sophisticated template system allows administrators to create reusable email templates with dynamic placeholders. Placeholders are automatically replaced with member-specific data (name, organisation, membership details, etc.) when emails are sent, ensuring personalised communication at scale.

### Communication Preferences

Members have full control over their communication preferences:

- Opt-in and opt-out management
- Preference syncing with external email marketing platforms where applicable
- Compliance with data protection regulations regarding consent

---

## 9. Workflow Automation

### Overview

iConnect's workflow engine allows administrators to automate repetitive processes, reducing manual effort and ensuring consistency. Workflows are tenant-scoped, meaning each client configures their own automation rules independently.

### Available Workflow Actions

Workflows can be configured to perform a wide range of actions automatically:

| Action | Description |
|--------|-------------|
| **Send Email** | Trigger personalised emails using templates and placeholders |
| **Update Fields** | Automatically update member or organisation data fields |
| **Create Contracts** | Generate contracts or agreements based on templates |
| **Create Memberships** | Initiate membership records with full cost calculation |
| **Set Go-Live Dates** | Activate organisation memberships on specified dates |
| **Password Setup** | Generate and send secure password setup links for new members |

### Intelligent Processing

The workflow engine includes safeguards to prevent errors:

- Checks invoicing mode before creating membership records — only proceeds when appropriate
- Validates organisation status (e.g., go-live date) before processing
- Prevents duplicate record creation at both application and database levels
- Full audit logging of all automated actions

---

## 10. Due Diligence & Compliance

### Overview

For organisations that require compliance checks on prospective or existing members, iConnect provides a comprehensive due diligence module.

### Key Capabilities

- **Submission Management:** Track due diligence submissions through configurable stages
- **Document Collection:** Collect and store required documents securely
- **Scoring System:** Automated scoring based on configurable criteria
- **Review Workflows:** Multi-reviewer support with structured review forms
- **Stage Actions:** Define actions that trigger when submissions move between stages
- **Schedule Management:** Track submission deadlines and timelines
- **Reminder System:** Automated reminders for pending reviews and approaching deadlines
- **Timeout Handling:** Configurable timeout actions for overdue submissions

### Compliance Features

- Full audit trail of all due diligence activities
- Secure document storage with access controls
- Configurable stage gates to enforce process compliance
- Status tracking from initiation through to final decision

---

## 11. Fundraising & Donations

### Campaign Management

iConnect includes a purpose-built fundraising module:

- **Campaign Creation:** Set up fundraising campaigns with targets, descriptions, and timelines
- **Team Fundraising:** Assign team members to campaigns, each with their own unique donation page
- **Donation Pages:** Branded, public-facing donation pages with secure payment processing
- **UK Gift Aid Support:** Capture Gift Aid declarations to maximise charitable donations

### Payment Processing

All donations are processed securely through Stripe:

- PCI-compliant payment handling
- Support for one-off donations
- Automatic receipt generation
- Full donation tracking and reporting

---

## 12. Community Forums

### Discussion Platform

A built-in forum system for member engagement and knowledge sharing:

- **Tenant-Scoped Forums:** Each client has their own private forum space
- **Threaded Discussions:** Full support for nested reply threads
- **Reactions:** Members can react to posts and comments
- **Role-Based Access:** Forum access is controlled through the platform's role management system

### Moderation & Safety

- **Content Reporting:** Members can flag inappropriate content for review
- **Moderation Suite:** Administrators have full moderation controls including post removal and user management
- **Audit Logging:** All moderation actions are logged for accountability
- **Soft Deletion:** Removed content preserves the reply thread structure, maintaining conversation context

---

## 13. Job Board

### Overview

iConnect includes a built-in job board that allows member organisations to advertise vacancies to the wider membership community.

### Key Capabilities

- **Job Posting Management:** Organisations can create and manage job listings with full descriptions, requirements, and application details
- **Member Listings:** Individual members can post and manage their own job listings
- **Category & Filtering:** Jobs can be categorised and filtered to help candidates find relevant opportunities
- **Role-Based Access:** Administrators control which roles can post and view job listings
- **Tenant-Scoped:** Each client's job board is private to their membership, ensuring relevance and quality

---

## 14. Identity & Access Management

### Unified Identity System

iConnect operates a unified identity system that provides:

- **Single Identity, Multiple Tenants:** A person who belongs to multiple organisations across different tenants uses one identity with separate, isolated access to each
- **Per-Tenant Password Isolation:** Passwords are stored and validated independently for each tenant, so a password change in one tenant does not affect access to another
- **Social Sign-In:** Members can sign in using their existing Google account for convenience and faster access
- **Secure Password Management:** Industry-standard encryption protects all credentials, with automatic account lockout after failed attempts and secure, time-limited password reset flows

### Role-Based Access Control

A sophisticated role management system provides granular control over what each user can see and do:

- **Feature-Based Permissions:** Access is controlled at the feature level — administrators define which features each role can access
- **Protected System Roles:** Core system roles cannot be accidentally modified or deleted
- **Field-Level Access Control:** Control visibility and editability of individual data fields based on the user's role
- **Admin vs. Member Portals:** Separate permission sets for the administrative dashboard and the member-facing portal

### Dual Session Support

The platform supports two distinct session types:

| Session Type | Purpose | Access Level |
|-------------|---------|--------------|
| **Tenant User** | Administrative staff managing the platform | Full dashboard access based on role |
| **Member** | Individual members using the portal | Self-service access to their own data and permitted features |

### Masquerade (Impersonation)

For support purposes, authorised administrators can temporarily view the platform as a specific member would see it, without requiring the member's credentials. This feature includes full audit logging.

---

## 15. Customisation & Branding

### Per-Tenant Branding

Every tenant can customise the appearance of their member-facing portal:

- Logo and colour scheme
- Custom styling for public-facing pages
- Branded email templates
- Personalised login and registration pages

### Custom Forms

A powerful form builder with:

- Drag-and-drop form creation
- Conditional logic — show or hide fields based on previous answers
- Field mapping — automatically populate member or organisation records from form submissions
- Unique value validation — ensure submitted data doesn't conflict with existing records
- Submission notifications and acknowledgement emails
- Embeddable forms — deploy forms on external websites while maintaining data flow back to iConnect

### Dynamic Page Builder

Create custom pages within the platform using a visual editor:

- Component-based design with reusable elements
- Typography and button styling controls
- Template library for common page layouts
- No technical knowledge required

---

## 16. Security & Data Protection

### Data Isolation

Security is fundamental to iConnect's architecture:

- **Tenant Isolation:** Every database query is scoped to the authenticated tenant. There is no mechanism by which one tenant's data can be accessed by another
- **Organisation Scoping:** Within a tenant, data can be further isolated to specific organisations where appropriate
- **Enforced Boundaries:** All data access passes through a centralised security layer that enforces tenant boundaries before any information is returned

### Authentication Security

- **Encrypted Passwords:** All passwords are protected using industry-standard, one-way encryption — they cannot be read or reversed, even by system administrators
- **Tamper-Proof Sessions:** User sessions are cryptographically secured to prevent unauthorised access or manipulation
- **Account Lockout:** Automatic lockout after repeated failed login attempts, protecting against brute-force attacks
- **Secure Token Systems:** Time-limited, single-use tokens for password resets, email verification, and payment links — each expires automatically after a defined period
- **Seamless Portal Navigation:** Secure session management enables seamless movement between the administrative dashboard and member portal without re-authentication

### Payment Security

- **PCI Compliance:** All payment processing is handled through Stripe, a PCI DSS Level 1 certified provider. No card details are ever stored on iConnect's servers
- **Secure Payment Links:** Fee payment URLs use cryptographically generated tokens with automatic expiry
- **Token Lifecycle Tracking:** Every payment token is tracked through its full lifecycle (pending, submitted, paid, expired, cancelled)

### Infrastructure Security

- **HTTPS Everywhere:** All communications between users and the platform are encrypted in transit
- **Secure Credential Storage:** All sensitive credentials, API keys, and service tokens are stored in encrypted vaults — never in plain text or application code
- **Credential Isolation:** Each tenant's third-party service credentials (e.g., payment provider, accounting software) are stored and used independently

### Access Control

- **Role-Based Permissions:** Fine-grained control over which users can access which features and data
- **Field-Level Security:** Sensitive data fields can be restricted to specific roles
- **Audit Trails:** Key actions (moderation, overrides, financial operations) are logged with timestamps and user attribution
- **Protected System Roles:** Critical system roles are locked against modification to prevent accidental security degradation

---

## 17. Integration Ecosystem

iConnect connects seamlessly with industry-leading third-party services:

### Financial & Accounting

| Integration | Purpose |
|-------------|---------|
| **Stripe** | Secure online payment processing for membership fees, event tickets, and donations |
| **Xero** | Automated invoice generation, with purchase order references and VAT handling |

### Communication

| Integration | Purpose |
|-------------|---------|
| **Microsoft Outlook** | Send emails through your organisation's existing Outlook account, preserving your email identity |
| **Mailgun** | High-deliverability transactional email with automated tenant-specific domain provisioning |
| **Zoho Campaigns** | Synchronise member communication preferences with your email marketing platform |

### Collaboration & Video

| Integration | Purpose |
|-------------|---------|
| **Zoom** | Virtual event hosting with automatic timezone handling |

### Infrastructure

The platform leverages enterprise-grade cloud services for:

- **Database Hosting:** Managed, enterprise-grade relational database with automated backups and real-time capabilities
- **File Storage:** Secure, scalable cloud storage for documents, images, and uploaded files
- **Global Deployment:** Edge-network hosting for fast, reliable access from anywhere in the world

### Integration Philosophy

All integrations are designed with the following principles:

- **Credential Isolation:** Each tenant's integration credentials are stored and used independently
- **Graceful Degradation:** If an external service is temporarily unavailable, the platform continues to operate and queues actions for retry
- **Minimal Data Exposure:** Only the data necessary for each integration is shared with third-party services
- **Audit Logging:** All integration actions are logged for transparency and troubleshooting

---

## 18. Deployment, Reliability & Scalability

### Cloud-Native Deployment

iConnect is hosted on globally distributed cloud infrastructure:

- **Global Availability:** The platform is served from multiple locations worldwide, ensuring fast load times regardless of the user's location
- **Automatic Scaling:** Infrastructure scales automatically to handle peak loads without manual intervention
- **Zero-Downtime Updates:** Platform updates are deployed without service interruption

### Domain Architecture

Each tenant operates under their own branded subdomain:

- **Admin Portal:** Accessible via the primary platform domain for tenant management
- **Member Portal:** Each tenant receives a dedicated subdomain for their member-facing portal (e.g., `yourorganisation.example.com`)
- **Custom Domains:** Support for custom domain mapping where required
- **Automatic Routing:** The platform automatically identifies which tenant a user belongs to based on the domain they access, ensuring seamless, branded experiences

### Reliability

- **Managed Database:** Enterprise-grade database with automated backups and point-in-time recovery
- **Health Monitoring:** Automated health checks ensure the platform is continuously available
- **Independent Scaling:** Each functional area of the platform scales independently, preventing load in one area from affecting others
- **Scheduled Task Processing:** Automated tasks (such as membership renewals and reminders) run on reliable, managed infrastructure

### Data Backup & Recovery

- Automated daily database backups
- Point-in-time recovery capability
- Geographically distributed storage for resilience

---

## 19. Summary & Next Steps

### Platform Summary

iConnect is a comprehensive, secure, and scalable platform designed to meet the complex needs of modern membership organisations. By consolidating member management, financial operations, communications, events, content publishing, and compliance into a single platform, iConnect eliminates the inefficiencies of managing multiple disconnected systems.

**Core Strengths:**

- **Purpose-Built for Membership Bodies** — Every feature is designed with the specific challenges of membership management in mind
- **Enterprise-Grade Security** — Multi-layered security with tenant isolation, encrypted credentials, role-based access, and PCI-compliant payment processing
- **Intelligent Automation** — Reduce administrative burden through configurable workflows that handle renewals, onboarding, communications, and compliance
- **Financial Sophistication** — Flexible pricing models, automated invoicing, and direct accounting integration streamline revenue management
- **Scalable Architecture** — Cloud-native design ensures the platform grows with your organisation
- **Integration-Ready** — Native connections to Stripe, Xero, Outlook, Mailgun, Zoom, and more

### Next Steps

We would welcome the opportunity to discuss how iConnect can support your organisation's specific requirements. Suggested next steps include:

1. **Discovery Call** — A conversation to understand your current processes, pain points, and objectives
2. **Platform Demonstration** — A guided walkthrough of the platform tailored to your use cases
3. **Pilot Programme** — A structured trial period to evaluate the platform with real data and workflows
4. **Implementation Plan** — A detailed onboarding and migration plan designed around your timeline

---

*For further information, please contact the iConnect team.*

*This document is provided for evaluation purposes and is classified as Commercial in Confidence. It should not be distributed without prior consent.*

---

**iConnect Platform — Technology & Capability Overview**
*Version 1.0 — February 2026*
