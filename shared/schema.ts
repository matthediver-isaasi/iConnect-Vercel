import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, timestamp, jsonb, integer, uuid, index, uniqueIndex, numeric, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Tenant table - top level of multi-tenancy (SaaS subscribing companies)
export const tenant = pgTable("tenant", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: varchar("slug", { length: 100 }).unique(),
  domain: varchar("domain", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default('active'),
  logo_url: text("logo_url"),
  favicon_url: text("favicon_url"),
  primary_color: varchar("primary_color", { length: 20 }),
  secondary_color: varchar("secondary_color", { length: 20 }),
  tagline: text("tagline"),
  header_config: jsonb("header_config").default({}),
  footer_config: jsonb("footer_config").default({}),
  branding_config: jsonb("branding_config").default({}),
  platform_branding: jsonb("platform_branding").default({}),
  subscription_plan: varchar("subscription_plan", { length: 50 }).default('free'),
  subscription_status: varchar("subscription_status", { length: 50 }).default('active'),
  stripe_customer_id: varchar("stripe_customer_id", { length: 255 }),
  stripe_subscription_id: varchar("stripe_subscription_id", { length: 255 }),
  billing_email: varchar("billing_email", { length: 255 }),
  settings: jsonb("settings").default({}),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertTenantSchema = createInsertSchema(tenant).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenant.$inferSelect;

export const cpdCertificateTemplate = pgTable("cpd_certificate_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  review_requested_at: timestamp("review_requested_at", { withTimezone: true }),
  reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  reviewed_by: text("reviewed_by"),
  review_note: text("review_note"),
  source_bucket: text("source_bucket"),
  source_path: text("source_path"),
  source_filename: text("source_filename"),
  source_mime_type: text("source_mime_type"),
  source_size_bytes: bigint("source_size_bytes", { mode: "number" }),
  source_sha256: text("source_sha256"),
  source_page_count: integer("source_page_count"),
  source_geometry: jsonb("source_geometry").notNull().default([]),
  created_by: text("created_by"),
  updated_by: text("updated_by"),
  archived_at: timestamp("archived_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantStatusIdx: index("idx_cpd_certificate_template_tenant_status")
    .on(table.tenant_id, table.status, table.updated_at),
}));

export const cpdCertificatePlaceholder = pgTable("cpd_certificate_placeholder", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  template_id: uuid("template_id").notNull(),
  placeholder_key: text("placeholder_key").notNull(),
  label: text("label"),
  field_type: text("field_type").notNull().default("text"),
  sample_value: text("sample_value"),
  default_value: text("default_value"),
  display_order: integer("display_order").notNull().default(0),
  multiline: boolean("multiline").notNull().default(false),
  shrink_to_fit: boolean("shrink_to_fit").notNull().default(true),
  page_number: integer("page_number").notNull(),
  x: numeric("x").notNull(),
  y: numeric("y").notNull(),
  width: numeric("width").notNull(),
  height: numeric("height").notNull(),
  font_family: text("font_family").notNull().default("Helvetica"),
  font_size: numeric("font_size").notNull().default("12"),
  font_style: text("font_style").notNull().default("normal"),
  alignment: text("alignment").notNull().default("left"),
  color: text("color").notNull().default("#000000"),
  line_height: numeric("line_height").notNull().default("1.2"),
  minimum_font_size: numeric("minimum_font_size").notNull().default("4"),
  vertical_align: text("vertical_align").notNull().default("middle"),
  overflow_policy: text("overflow_policy").notNull().default("shrink"),
  missing_policy: text("missing_policy").notNull().default("blank"),
  format: text("format"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  templateKeyIdx: index("idx_cpd_certificate_placeholder_template_key")
    .on(table.template_id, table.placeholder_key),
  templatePageIdx: index("idx_cpd_certificate_placeholder_template_page")
    .on(table.tenant_id, table.template_id, table.page_number, table.display_order),
}));

export type CpdCertificateTemplate = typeof cpdCertificateTemplate.$inferSelect;
export type CpdCertificatePlaceholder = typeof cpdCertificatePlaceholder.$inferSelect;

// Custom Object foundation. These shared generic tables back every
// tenant-defined object; preference_field remains the field-definition source
// of truth and is linked by custom_object_id in the SQL migration.
export const customObjectDefinition = pgTable("custom_object_definition", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  object_key: varchar("object_key", { length: 100 }).notNull(),
  singular_label: varchar("singular_label", { length: 255 }).notNull(),
  plural_label: varchar("plural_label", { length: 255 }).notNull(),
  description: text("description"),
  icon: varchar("icon", { length: 100 }),
  primary_display_field_id: uuid("primary_display_field_id"),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  configuration: jsonb("configuration").notNull().default({}),
  created_by: text("created_by"),
  updated_by: text("updated_by"),
  archived_at: timestamp("archived_at", { withTimezone: true }),
  archived_by: text("archived_by"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantKeyUnique: uniqueIndex("custom_object_definition_tenant_key_unique")
    .on(table.tenant_id, table.object_key),
  tenantStatusIdx: index("idx_custom_object_definition_tenant_status")
    .on(table.tenant_id, table.status, table.object_key),
}));

export const customObjectRecord = pgTable("custom_object_record", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  custom_object_id: uuid("custom_object_id").notNull(),
  data: jsonb("data").notNull().default({}),
  created_by: text("created_by"),
  updated_by: text("updated_by"),
  archived_at: timestamp("archived_at", { withTimezone: true }),
  archived_by: text("archived_by"),
  archive_reason: text("archive_reason"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantObjectIdx: index("idx_custom_object_record_tenant_object")
    .on(table.tenant_id, table.custom_object_id, table.id),
}));

export const customObjectRelationshipDefinition = pgTable("custom_object_relationship_definition", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  relationship_key: varchar("relationship_key", { length: 100 }).notNull(),
  source_kind: varchar("source_kind", { length: 30 }).notNull(),
  source_custom_object_id: uuid("source_custom_object_id"),
  target_kind: varchar("target_kind", { length: 30 }).notNull(),
  target_custom_object_id: uuid("target_custom_object_id"),
  cardinality: varchar("cardinality", { length: 30 }).notNull(),
  source_label: varchar("source_label", { length: 255 }).notNull(),
  target_label: varchar("target_label", { length: 255 }).notNull(),
  is_required: boolean("is_required").notNull().default(false),
  show_on_source: boolean("show_on_source").notNull().default(true),
  show_on_target: boolean("show_on_target").notNull().default(true),
  edit_from_source: boolean("edit_from_source").notNull().default(true),
  edit_from_target: boolean("edit_from_target").notNull().default(false),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  configuration: jsonb("configuration").notNull().default({}),
  created_by: text("created_by"),
  updated_by: text("updated_by"),
  archived_at: timestamp("archived_at", { withTimezone: true }),
  archived_by: text("archived_by"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantKeyUnique: uniqueIndex("custom_object_relationship_definition_tenant_key_unique")
    .on(table.tenant_id, table.relationship_key),
  tenantStatusIdx: index("idx_custom_object_relationship_definition_tenant_status")
    .on(table.tenant_id, table.status),
}));

export const customObjectRelationship = pgTable("custom_object_relationship", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  relationship_definition_id: uuid("relationship_definition_id").notNull(),
  source_record_id: uuid("source_record_id").notNull(),
  target_record_id: uuid("target_record_id").notNull(),
  created_by: text("created_by"),
  archived_at: timestamp("archived_at", { withTimezone: true }),
  archived_by: text("archived_by"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantDefinitionIdx: index("idx_custom_object_relationship_tenant_definition_all")
    .on(table.tenant_id, table.relationship_definition_id, table.id),
  tenantSourceIdx: index("idx_custom_object_relationship_tenant_source_all")
    .on(table.tenant_id, table.source_record_id, table.relationship_definition_id),
  tenantTargetIdx: index("idx_custom_object_relationship_tenant_target_all")
    .on(table.tenant_id, table.target_record_id, table.relationship_definition_id),
}));

export const customObjectRolePermission = pgTable("custom_object_role_permission", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  custom_object_id: uuid("custom_object_id").notNull(),
  role_id: uuid("role_id").notNull(),
  can_view_records: boolean("can_view_records").notNull().default(false),
  can_create_records: boolean("can_create_records").notNull().default(false),
  can_edit_records: boolean("can_edit_records").notNull().default(false),
  can_archive_records: boolean("can_archive_records").notNull().default(false),
  can_export_records: boolean("can_export_records").notNull().default(false),
  created_by: text("created_by"),
  updated_by: text("updated_by"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  objectRoleUnique: uniqueIndex("custom_object_role_permission_unique")
    .on(table.tenant_id, table.custom_object_id, table.role_id),
  tenantRoleIdx: index("idx_custom_object_role_permission_tenant_role")
    .on(table.tenant_id, table.role_id, table.custom_object_id),
}));

export const customObjectAuditEvent = pgTable("custom_object_audit_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  custom_object_id: uuid("custom_object_id"),
  record_id: uuid("record_id"),
  relationship_definition_id: uuid("relationship_definition_id"),
  relationship_id: uuid("relationship_id"),
  actor_id: text("actor_id"),
  actor_type: varchar("actor_type", { length: 30 }).notNull().default("system"),
  action: varchar("action", { length: 100 }).notNull(),
  entity_type: varchar("entity_type", { length: 100 }).notNull(),
  entity_id: uuid("entity_id").notNull(),
  before_data: jsonb("before_data"),
  after_data: jsonb("after_data"),
  metadata: jsonb("metadata").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantCreatedIdx: index("idx_custom_object_audit_event_tenant_created")
    .on(table.tenant_id, table.created_at),
  tenantObjectIdx: index("idx_custom_object_audit_event_tenant_object")
    .on(table.tenant_id, table.custom_object_id, table.created_at),
}));

export const insertCustomObjectDefinitionSchema = createInsertSchema(customObjectDefinition).omit({
  id: true,
  created_at: true,
  updated_at: true,
});
export const insertCustomObjectRecordSchema = createInsertSchema(customObjectRecord).omit({
  id: true,
  created_at: true,
  updated_at: true,
});
export const insertCustomObjectRelationshipDefinitionSchema = createInsertSchema(
  customObjectRelationshipDefinition,
).omit({
  id: true,
  created_at: true,
  updated_at: true,
});
export const insertCustomObjectRelationshipSchema = createInsertSchema(customObjectRelationship).omit({
  id: true,
  created_at: true,
});
export const insertCustomObjectRolePermissionSchema = createInsertSchema(customObjectRolePermission).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type CustomObjectDefinition = typeof customObjectDefinition.$inferSelect;
export type CustomObjectRecord = typeof customObjectRecord.$inferSelect;
export type CustomObjectRelationshipDefinition = typeof customObjectRelationshipDefinition.$inferSelect;
export type CustomObjectRelationship = typeof customObjectRelationship.$inferSelect;
export type CustomObjectRolePermission = typeof customObjectRolePermission.$inferSelect;
export type CustomObjectAuditEvent = typeof customObjectAuditEvent.$inferSelect;

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Workflow automation tables
export const workflow = pgTable("workflow", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(), // Tenant isolation
  name: text("name").notNull(),
  description: text("description"),
  entity_type: text("entity_type").notNull(), // 'organization', 'member', or another registered workflow entity
  trigger_type: text("trigger_type").notNull(), // field/record/scheduled or 'event_attendance_result'
  trigger_config: jsonb("trigger_config"), // field_change: { field_id, field_type, operator, value, requires_confirmation }; scheduled: { frequency: 'daily'|'hourly', run_time: 'HH:MM' (UTC) }
  conditions: jsonb("conditions"), // [{ field_id, field_type, operator, value, logic }]
  actions: jsonb("actions"), // [{ type, config }]
  is_active: boolean("is_active").default(true),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
  created_by: text("created_by"),
});

export const insertWorkflowSchema = createInsertSchema(workflow).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type Workflow = typeof workflow.$inferSelect;

// Workflow execution logs
export const workflowLog = pgTable("workflow_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(), // Tenant isolation
  workflow_id: varchar("workflow_id").notNull(),
  entity_type: text("entity_type").notNull(),
  entity_id: text("entity_id").notNull(),
  trigger_data: jsonb("trigger_data"), // { before, after, changed_fields }
  actions_executed: jsonb("actions_executed"), // [{ action_type, status, result, error }]
  status: text("status").notNull(), // 'success', 'partial', 'failed'
  error_message: text("error_message"),
  executed_at: timestamp("executed_at").defaultNow(),
});

export const insertWorkflowLogSchema = createInsertSchema(workflowLog).omit({
  id: true,
  executed_at: true,
});

export type InsertWorkflowLog = z.infer<typeof insertWorkflowLogSchema>;
export type WorkflowLog = typeof workflowLog.$inferSelect;

// Immutable finalized attendance changes and their recoverable publication
// queue. Rows are created atomically by replace_attendance_report_snapshot.
export const attendanceOutcomeTransition = pgTable("attendance_outcome_transition", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  outcome_revision_id: uuid("outcome_revision_id").notNull(),
  attendance_target_id: uuid("attendance_target_id").notNull(),
  event_id: uuid("event_id"),
  target_type: text("target_type").notNull(),
  target_id: uuid("target_id").notNull(),
  booking_type: text("booking_type").notNull(),
  booking_id: uuid("booking_id").notNull(),
  member_id: uuid("member_id"),
  ticket_id: text("ticket_id"),
  provider: text("provider").notNull(),
  previous_status: text("previous_status"),
  status: text("status").notNull(),
  duration_seconds: integer("duration_seconds").notNull(),
  threshold_minutes: integer("threshold_minutes").notNull(),
  revision_number: integer("revision_number").notNull(),
  payload: jsonb("payload").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantBookingIdx: index("idx_attendance_transition_booking")
    .on(table.tenant_id, table.booking_type, table.booking_id, table.created_at),
  revisionUnique: uniqueIndex("attendance_outcome_transition_outcome_revision_key")
    .on(table.outcome_revision_id),
}));

export const attendanceTransitionOutbox = pgTable("attendance_transition_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenant_id: uuid("tenant_id").notNull(),
  transition_id: uuid("transition_id").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  available_at: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  locked_at: timestamp("locked_at", { withTimezone: true }),
  lock_token: uuid("lock_token"),
  published_at: timestamp("published_at", { withTimezone: true }),
  last_error: text("last_error"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  transitionUnique: uniqueIndex("attendance_transition_outbox_transition_id_key")
    .on(table.transition_id),
}));

export type AttendanceOutcomeTransition = typeof attendanceOutcomeTransition.$inferSelect;
export type AttendanceTransitionOutbox = typeof attendanceTransitionOutbox.$inferSelect;

// Role-based organization field permissions
export const roleOrganizationFieldPermission = pgTable("role_organization_field_permission", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  role_id: varchar("role_id").notNull(), // References role.id
  field_key: text("field_key").notNull(), // Core field name or custom field UUID
  permission: text("permission").notNull(), // 'hidden', 'read', 'read_write'
});

export const insertRoleOrganizationFieldPermissionSchema = createInsertSchema(roleOrganizationFieldPermission).omit({
  id: true,
});

export type InsertRoleOrganizationFieldPermission = z.infer<typeof insertRoleOrganizationFieldPermissionSchema>;
export type RoleOrganizationFieldPermission = typeof roleOrganizationFieldPermission.$inferSelect;

// Role-based member field permissions
export const roleMemberFieldPermission = pgTable("role_member_field_permission", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  role_id: varchar("role_id").notNull(), // References role.id
  field_key: text("field_key").notNull(), // Core field name or custom field UUID
  permission: text("permission").notNull(), // 'hidden', 'read', 'read_write'
});

export const insertRoleMemberFieldPermissionSchema = createInsertSchema(roleMemberFieldPermission).omit({
  id: true,
});

export type InsertRoleMemberFieldPermission = z.infer<typeof insertRoleMemberFieldPermissionSchema>;
export type RoleMemberFieldPermission = typeof roleMemberFieldPermission.$inferSelect;

// URL Redirect mappings for legacy URL handling
export const redirectMapping = pgTable("redirect_mapping", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  source_pattern: text("source_pattern").notNull(), // The incoming URL path to match
  target_url: text("target_url").notNull(), // The destination URL to redirect to
  match_type: text("match_type").notNull().default('exact'), // 'exact', 'prefix', 'regex'
  status_code: integer("status_code").notNull().default(301), // HTTP status code (301 permanent, 302 temporary)
  priority: integer("priority").notNull().default(100), // Lower numbers = higher priority
  is_active: boolean("is_active").default(true),
  notes: text("notes"), // Optional notes about the redirect
  created_at: timestamp("created_at").defaultNow(),
});

export const insertRedirectMappingSchema = createInsertSchema(redirectMapping).omit({
  id: true,
  created_at: true,
});

export type InsertRedirectMapping = z.infer<typeof insertRedirectMappingSchema>;
export type RedirectMapping = typeof redirectMapping.$inferSelect;

// Organization notes - for tracking notes on organizations by members
export const organizationNote = pgTable("organization_note", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organization_id: varchar("organization_id").notNull(), // References organization.id
  member_id: varchar("member_id").notNull(), // References member.id - who added the note
  content: text("content").notNull(), // The note text
  attachments: jsonb("attachments"), // Array of {file_url, file_name, file_size, mime_type}
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertOrganizationNoteSchema = createInsertSchema(organizationNote).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertOrganizationNote = z.infer<typeof insertOrganizationNoteSchema>;
export type OrganizationNote = typeof organizationNote.$inferSelect;

// Member notes - for tracking notes on members by other members (admins)
export const memberNote = pgTable("member_note", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  target_member_id: varchar("target_member_id").notNull(), // References member.id - the member the note is about
  author_member_id: varchar("author_member_id").notNull(), // References member.id - who added the note
  content: text("content").notNull(), // The note text
  attachments: jsonb("attachments"), // Array of {file_url, file_name, file_size, mime_type}
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertMemberNoteSchema = createInsertSchema(memberNote).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertMemberNote = z.infer<typeof insertMemberNoteSchema>;
export type MemberNote = typeof memberNote.$inferSelect;

// CSV Import Profile - stores saved import configurations
export const csvImportProfile = pgTable("csv_import_profile", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(), // User-friendly profile name
  entity_type: text("entity_type").notNull(), // 'member' or 'organization'
  identifier_field: text("identifier_field").notNull().default('email'), // Field used to match existing records
  field_mappings: jsonb("field_mappings").notNull(), // Array of {source_column, target_field, target_scope, clear_on_empty}
  created_by: varchar("created_by"), // Member ID who created
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertCsvImportProfileSchema = createInsertSchema(csvImportProfile).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertCsvImportProfile = z.infer<typeof insertCsvImportProfileSchema>;
export type CsvImportProfile = typeof csvImportProfile.$inferSelect;

// CSV Import Job - tracks import execution history
export const csvImportJob = pgTable("csv_import_job", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  profile_id: varchar("profile_id"), // Optional reference to saved profile
  entity_type: text("entity_type").notNull(), // 'member' or 'organization'
  status: text("status").notNull().default('pending'), // 'pending', 'running', 'completed', 'failed'
  file_name: text("file_name"),
  total_rows: integer("total_rows").default(0),
  processed_rows: integer("processed_rows").default(0),
  created_rows: integer("created_rows").default(0),
  updated_rows: integer("updated_rows").default(0),
  skipped_rows: integer("skipped_rows").default(0),
  error_rows: integer("error_rows").default(0),
  error_log: jsonb("error_log"), // Array of {row, message}
  created_by: varchar("created_by"),
  created_at: timestamp("created_at").defaultNow(),
  completed_at: timestamp("completed_at"),
});

export const insertCsvImportJobSchema = createInsertSchema(csvImportJob).omit({
  id: true,
  created_at: true,
  completed_at: true,
});

export type InsertCsvImportJob = z.infer<typeof insertCsvImportJobSchema>;
export type CsvImportJob = typeof csvImportJob.$inferSelect;

// Platform Owner accounts - SaaS owners separate from tenant_user
export const platformOwner = pgTable("platform_owner", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password_hash: text("password_hash").notNull(),
  name: text("name"),
  is_active: boolean("is_active").default(true),
  last_login_at: timestamp("last_login_at"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertPlatformOwnerSchema = createInsertSchema(platformOwner).omit({
  id: true,
  created_at: true,
  updated_at: true,
  last_login_at: true,
});

export type InsertPlatformOwner = z.infer<typeof insertPlatformOwnerSchema>;
export type PlatformOwner = typeof platformOwner.$inferSelect;

// Platform Preferences - GLOBAL scope (not tenant-scoped)
export const platformPreferences = pgTable("platform_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: varchar("key", { length: 255 }).notNull().unique(),
  value: jsonb("value").notNull().default({}),
  description: text("description"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertPlatformPreferencesSchema = createInsertSchema(platformPreferences).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertPlatformPreferences = z.infer<typeof insertPlatformPreferencesSchema>;
export type PlatformPreferences = typeof platformPreferences.$inferSelect;

// Platform Owner Sessions - server-side session store
export const platformOwnerSession = pgTable("platform_owner_session", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  owner_id: varchar("owner_id").notNull(),
  session_token: varchar("session_token", { length: 255 }).notNull().unique(),
  expires_at: timestamp("expires_at").notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

export const insertPlatformOwnerSessionSchema = createInsertSchema(platformOwnerSession).omit({
  id: true,
  created_at: true,
});

export type InsertPlatformOwnerSession = z.infer<typeof insertPlatformOwnerSessionSchema>;
export type PlatformOwnerSession = typeof platformOwnerSession.$inferSelect;

// Form Due Diligence Configuration - extends Form with due diligence settings
export const formDueDiligenceConfig = pgTable("form_due_diligence_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  form_id: varchar("form_id").notNull().unique(), // References form.id
  tenant_id: varchar("tenant_id").notNull(), // Tenant isolation
  
  // Scoring configuration
  scoring_approach: varchar("scoring_approach", { length: 50 }).default('dynamic'), // 'dynamic' or 'static_traffic_light'
  scoring_rules: jsonb("scoring_rules").default({}), // { rules: [], risk_thresholds: {} }
  static_questions: jsonb("static_questions").default([]), // Traffic light questions array
  custom_risk_levels: jsonb("custom_risk_levels").default([]), // [{ name, threshold, color }]
  
  // Review configuration
  default_review_state: varchar("default_review_state", { length: 50 }).default('amended'), // 'amended' or 'approved'
  
  // Workflow configuration
  workflow_stages: jsonb("workflow_stages").default([]), // [{ id, label, color, is_initial, order, selection_conditions }]
  status_change_webhooks: jsonb("status_change_webhooks").default([]), // Webhook configurations
  enforce_stage_sequence: boolean("enforce_stage_sequence").default(false), // Lock earlier stages in dropdown
  
  // CRM integration config
  crm_attachment_config: jsonb("crm_attachment_config").default({}), // { enabled, module_name, crm_lookup_field, etc. }
  crm_logo_upload_config: jsonb("crm_logo_upload_config").default({}), // Logo upload settings
  
  // Field mappings for applicant info extraction
  applicant_name_field: text("applicant_name_field"),
  applicant_email_field: text("applicant_email_field"),
  applicant_organization_name_field: text("applicant_organization_name_field"),
  
  // Dashboard display configuration
  card_reference_field: text("card_reference_field"),
  
  // Review display settings
  show_description_fields: boolean("show_description_fields").default(false),
  
  // Auto-transition on first edit
  on_first_edit_stage: varchar("on_first_edit_stage", { length: 100 }),
  
  is_active: boolean("is_active").default(true),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertFormDueDiligenceConfigSchema = createInsertSchema(formDueDiligenceConfig).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertFormDueDiligenceConfig = z.infer<typeof insertFormDueDiligenceConfigSchema>;
export type FormDueDiligenceConfig = typeof formDueDiligenceConfig.$inferSelect;

// Form Submission Due Diligence - extends FormSubmission with review data
export const formSubmissionDueDiligence = pgTable("form_submission_due_diligence", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  form_submission_id: varchar("form_submission_id").notNull().unique(), // References form_submission.id
  tenant_id: varchar("tenant_id").notNull(), // Tenant isolation
  
  // Application tracking
  application_uid: varchar("application_uid", { length: 255 }), // Unique application identifier
  
  // Review data
  original_form_values: jsonb("original_form_values").default({}), // Unmodified original values
  reviewed_form_values: jsonb("reviewed_form_values").default({}), // Amended values during review
  field_review_status: jsonb("field_review_status").default({}), // { field_name: 'approved'|'amended'|'pending' }
  field_notes: jsonb("field_notes").default({}), // Per-field review notes
  
  // Static question responses (traffic light scoring)
  static_question_responses: jsonb("static_question_responses").default({}), // { question_id: 'green'|'amber'|'red' }
  static_question_notes: jsonb("static_question_notes").default({}), // { question_id: note }
  
  // Workflow status
  workflow_status: varchar("workflow_status", { length: 100 }).default('new'), // Current stage id
  
  // Scoring
  due_diligence_score: integer("due_diligence_score"), // 0-100 calculated score
  risk_level: varchar("risk_level", { length: 50 }), // 'low', 'medium', 'high', 'critical' or custom
  
  // DD call tracking
  dd_call_date: timestamp("dd_call_date"),
  
  // Internal notes
  notes: text("notes"), // Rich text notes from DD calls
  
  // Signature tracking
  agreements_status: jsonb("agreements_status").default([]), // [{ signature_field_name, is_signed, signed_date, etc. }]
  
  // CRM attachment tracking
  crm_attachments_status: jsonb("crm_attachments_status").default([]), // [{ attachment_id, file_name, is_approved, etc. }]
  
  // Webhook reminder tracking
  status_webhook_reminders_status: jsonb("status_webhook_reminders_status").default([]),
  sent_webhook_messages: jsonb("sent_webhook_messages").default([]),
  
  // Audit history
  history_log: jsonb("history_log").default([]), // [{ timestamp, event_type, user_email, details }]
  
  // Review metadata
  reviewed_by: varchar("reviewed_by", { length: 255 }), // Email of reviewer
  reviewed_date: timestamp("reviewed_date"),
  
  // Swap/Archive tracking
  archived_at: timestamp("archived_at"), // When this submission was archived (e.g., due to form swap)
  archived_reason: text("archived_reason"), // Reason for archiving (e.g., "Swapped to form: XYZ")
  swapped_from_submission_id: varchar("swapped_from_submission_id"), // If this submission was created from a swap, reference to original
  swapped_to_submission_id: varchar("swapped_to_submission_id"), // If this submission was swapped out, reference to new submission
  
  // First edit transition guard
  first_edit_triggered: boolean("first_edit_triggered").default(false), // Prevents duplicate auto-transitions on first edit
  
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertFormSubmissionDueDiligenceSchema = createInsertSchema(formSubmissionDueDiligence).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertFormSubmissionDueDiligence = z.infer<typeof insertFormSubmissionDueDiligenceSchema>;
export type FormSubmissionDueDiligence = typeof formSubmissionDueDiligence.$inferSelect;

// Outlook Connection - stores OAuth tokens for Microsoft Graph API per user
export const outlookConnection = pgTable("outlook_connection", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(),
  identity_id: varchar("identity_id").notNull(),
  
  // Microsoft account info
  microsoft_user_id: varchar("microsoft_user_id").notNull(),
  microsoft_email: varchar("microsoft_email").notNull(),
  display_name: varchar("display_name"),
  
  // OAuth tokens
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token").notNull(),
  token_expires_at: timestamp("token_expires_at").notNull(),
  scopes: text("scopes"),
  
  // Connection status
  status: varchar("status", { length: 50 }).default('active'),
  last_sync_at: timestamp("last_sync_at"),
  sync_error: text("sync_error"),
  
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertOutlookConnectionSchema = createInsertSchema(outlookConnection).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertOutlookConnection = z.infer<typeof insertOutlookConnectionSchema>;
export type OutlookConnection = typeof outlookConnection.$inferSelect;

// Member Email - stores synced emails linked to members
export const memberEmail = pgTable("member_email", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(),
  member_id: varchar("member_id").notNull(),
  
  // Microsoft message metadata
  microsoft_message_id: varchar("microsoft_message_id").notNull(),
  conversation_id: varchar("conversation_id"),
  internet_message_id: varchar("internet_message_id"),
  
  // Email content
  subject: text("subject"),
  body_preview: text("body_preview"),
  body_content: text("body_content"),
  body_content_type: varchar("body_content_type", { length: 20 }).default('html'),
  
  // Sender/recipient info
  from_address: varchar("from_address").notNull(),
  from_name: varchar("from_name"),
  to_addresses: jsonb("to_addresses").default([]),
  cc_addresses: jsonb("cc_addresses").default([]),
  
  // Email direction and type
  direction: varchar("direction", { length: 20 }).notNull(), // 'inbound' or 'outbound'
  is_read: boolean("is_read").default(false),
  is_draft: boolean("is_draft").default(false),
  has_attachments: boolean("has_attachments").default(false),
  importance: varchar("importance", { length: 20 }).default('normal'),
  
  // Attachments metadata
  attachments: jsonb("attachments").default([]),
  
  // Timestamps
  sent_at: timestamp("sent_at"),
  received_at: timestamp("received_at"),
  
  // Tracking
  synced_by_identity_id: varchar("synced_by_identity_id"),
  synced_at: timestamp("synced_at").defaultNow(),
  
  created_at: timestamp("created_at").defaultNow(),
});

export const insertMemberEmailSchema = createInsertSchema(memberEmail).omit({
  id: true,
  created_at: true,
  synced_at: true,
});

export type InsertMemberEmail = z.infer<typeof insertMemberEmailSchema>;
export type MemberEmail = typeof memberEmail.$inferSelect;

// Form Draft Submissions - stores partial form submissions for "Save as you go" functionality
export const formDraftSubmission = pgTable("form_draft_submission", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(),
  form_id: varchar("form_id").notNull(),
  
  // Security: store hash of resume token, not the raw token
  resume_token_hash: text("resume_token_hash").notNull().unique(),
  
  // Draft data
  draft_data: jsonb("draft_data").notNull().default({}),
  
  // Metadata for schema drift detection
  form_updated_at: timestamp("form_updated_at"), // form.updated_at at time of save
  current_page_index: integer("current_page_index").default(0),
  
  // Optional contact info for email reminders
  contact_email: varchar("contact_email", { length: 255 }),
  
  // Lifecycle
  expires_at: timestamp("expires_at").notNull(),
  last_saved_at: timestamp("last_saved_at").defaultNow(),
  created_at: timestamp("created_at").defaultNow(),
});

export const insertFormDraftSubmissionSchema = createInsertSchema(formDraftSubmission).omit({
  id: true,
  created_at: true,
  last_saved_at: true,
});

export type InsertFormDraftSubmission = z.infer<typeof insertFormDraftSubmissionSchema>;
export type FormDraftSubmission = typeof formDraftSubmission.$inferSelect;

// Contract Instance - tracks individual contract runs created from templates
export const contractInstance = pgTable("contract_instance", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(),
  form_id: varchar("form_id").notNull(), // References the contract template form
  organization_id: varchar("organization_id"), // Optional org scope
  form_submission_id: varchar("form_submission_id"), // Source form submission that triggered contract
  source_contact_field_id: varchar("source_contact_field_id"), // ID of the contact field that created this contract
  
  // Signer details (resolved at creation time)
  signers: jsonb("signers").notNull().default([]), // [{first_name, last_name, email, signed_at, signature_data}]
  
  // Status tracking
  status: varchar("status", { length: 50 }).notNull().default('pending'), // pending, out_for_signing, received, expired
  timeout_days: integer("timeout_days").notNull().default(30),
  
  // Email templates for sending
  initial_email_template_id: varchar("initial_email_template_id"),
  
  // Timeout notification tracking (for "alternative signer" feature)
  timeout_notification_round: integer("timeout_notification_round").notNull().default(0), // Which round of signers we're on
  timeout_notification_sent_at: timestamp("timeout_notification_sent_at"), // When timeout email was last sent to applicant
  
  // Workflow tracking
  created_from_workflow_id: varchar("created_from_workflow_id"),
  created_from_entity_type: varchar("created_from_entity_type"),
  created_from_entity_id: varchar("created_from_entity_id"),
  
  // Timestamps
  sent_at: timestamp("sent_at"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertContractInstanceSchema = createInsertSchema(contractInstance).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertContractInstance = z.infer<typeof insertContractInstanceSchema>;
export type ContractInstance = typeof contractInstance.$inferSelect;

// Contract Reminder Log - tracks sent reminders to prevent duplicates
export const contractReminderLog = pgTable("contract_reminder_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reminder_key: text("reminder_key").notNull().unique(), // Unique key to prevent duplicate sends
  contract_instance_id: varchar("contract_instance_id").notNull(),
  signer_email: text("signer_email").notNull(),
  sent_at: timestamp("sent_at").notNull().defaultNow(),
  tenant_id: varchar("tenant_id").notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

export const insertContractReminderLogSchema = createInsertSchema(contractReminderLog).omit({
  id: true,
  created_at: true,
});

export type InsertContractReminderLog = z.infer<typeof insertContractReminderLogSchema>;
export type ContractReminderLog = typeof contractReminderLog.$inferSelect;

// Scheduled Task Log - tracks execution of automated scheduled tasks
export const scheduledTaskLog = pgTable("scheduled_task_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id"), // Null for cross-tenant tasks
  task_name: text("task_name").notNull(), // e.g., 'contract_timeout_notifications', 'contract_reminders'
  task_display_name: text("task_display_name").notNull(), // User-friendly name
  status: text("status").notNull(), // 'success', 'partial', 'failed', 'no_action'
  summary: text("summary"), // Brief summary e.g., "Sent 3 timeout notifications"
  details: jsonb("details"), // Detailed execution info
  items_processed: integer("items_processed").default(0),
  items_succeeded: integer("items_succeeded").default(0),
  items_failed: integer("items_failed").default(0),
  error_message: text("error_message"),
  executed_at: timestamp("executed_at").defaultNow(),
  duration_ms: integer("duration_ms"), // How long the task took
});

export const insertScheduledTaskLogSchema = createInsertSchema(scheduledTaskLog).omit({
  id: true,
  executed_at: true,
});

export type InsertScheduledTaskLog = z.infer<typeof insertScheduledTaskLogSchema>;
export type ScheduledTaskLog = typeof scheduledTaskLog.$inferSelect;

// Stage Field Mapping Action - maps DD form fields to organization fields on stage trigger
export const stageFieldMappingAction = pgTable("stage_field_mapping_action", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(), // References tenant.id
  due_diligence_stage_id: varchar("due_diligence_stage_id").notNull(), // Stage ID from workflow_stages
  
  // Field mappings: [{ source_field_id, target_type, target_field }]
  field_mappings: jsonb("field_mappings").notNull().default([]),
  
  sort_order: integer("sort_order").default(0),
  is_active: boolean("is_active").default(true),
  
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const insertStageFieldMappingActionSchema = createInsertSchema(stageFieldMappingAction).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertStageFieldMappingAction = z.infer<typeof insertStageFieldMappingActionSchema>;
export type StageFieldMappingAction = typeof stageFieldMappingAction.$inferSelect;

// Article Brief Inbox Item - tenant-scoped pseudo-inbox surfacing case study
// permission/copyright submissions and document/image uploads against existing
// briefs so editors can triage them from /BriefManagement without opening every
// brief individually. Read/archive state is shared across the tenant in v1.
// The inbox archive flag is independent of the brief lifecycle "archived" status.
export const articleBriefInboxItem = pgTable("article_brief_inbox_item", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(), // References tenant.id
  article_brief_id: varchar("article_brief_id").notNull(), // References article_brief.id
  event_type: text("event_type").notNull(), // 'permission_submitted' | 'copyright_submitted' | 'files_uploaded'
  metadata: jsonb("metadata").notNull().default({}),
  read_at: timestamp("read_at"),
  archived_at: timestamp("archived_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertArticleBriefInboxItemSchema = createInsertSchema(articleBriefInboxItem).omit({
  id: true,
  created_at: true,
});

export type InsertArticleBriefInboxItem = z.infer<typeof insertArticleBriefInboxItemSchema>;
export type ArticleBriefInboxItem = typeof articleBriefInboxItem.$inferSelect;

// Dashboard widget builder (task #606)
// Personal widgets are scoped to a single owning member; shared widgets are
// visible to every member of the tenant. The DB enforces the owner/scope
// invariant via a check constraint.
export const dashboardWidget = pgTable("dashboard_widget", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Nullable to support personal widgets created outside a tenant context.
  tenant_id: varchar("tenant_id"),
  scope: varchar("scope", { length: 20 }).notNull(),
  owner_member_id: varchar("owner_member_id"),
  title: text("title").notNull(),
  widget_type: varchar("widget_type", { length: 20 }).notNull(),
  width: varchar("width", { length: 10 }).notNull().default('third'),
  height: varchar("height", { length: 10 }).notNull().default('medium'),
  config: jsonb("config").notNull().default({}),
  display_order: integer("display_order").notNull().default(0),
  created_by: varchar("created_by"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDashboardWidgetSchema = createInsertSchema(dashboardWidget).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertDashboardWidget = z.infer<typeof insertDashboardWidgetSchema>;
export type DashboardWidget = typeof dashboardWidget.$inferSelect;

// Photo Gallery (task #681)
// Tenant-scoped photo gallery folders. Each gallery is either public (visible
// to anonymous visitors via /api/public/galleries) or members-only (requires
// authenticated tenant member). Photos are stored in Supabase Storage; the
// bucket is decided at upload time based on the gallery's current is_public
// state. Toggling privacy after upload does not move existing files.
export const gallery = pgTable("gallery", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: varchar("tenant_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  is_public: boolean("is_public").notNull().default(false),
  cover_photo_id: varchar("cover_photo_id"),
  display_order: integer("display_order").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGallerySchema = createInsertSchema(gallery).omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type InsertGallery = z.infer<typeof insertGallerySchema>;
export type Gallery = typeof gallery.$inferSelect;

export const galleryPhoto = pgTable("gallery_photo", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // tenant_id is denormalized from the parent gallery so the generic
  // tenant-scoped entity API can filter without a join. The API at
  // api/entities/[entity]/index.js auto-injects tenant_id from the caller's
  // session on create, and api/entities/[entity]/[id].js filters by it on
  // list/get/update/delete.
  tenant_id: varchar("tenant_id").notNull(),
  gallery_id: varchar("gallery_id").notNull(),
  storage_path: text("storage_path").notNull(),
  bucket: varchar("bucket", { length: 64 }).notNull(),
  file_url: text("file_url").notNull(),
  caption: text("caption"),
  alt_text: text("alt_text"),
  display_order: integer("display_order").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertGalleryPhotoSchema = createInsertSchema(galleryPhoto).omit({
  id: true,
  created_at: true,
});

export type InsertGalleryPhoto = z.infer<typeof insertGalleryPhotoSchema>;
export type GalleryPhoto = typeof galleryPhoto.$inferSelect;
