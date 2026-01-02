import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

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
  name: text("name").notNull(),
  description: text("description"),
  entity_type: text("entity_type").notNull(), // 'organization' or 'member'
  trigger_type: text("trigger_type").notNull(), // 'field_change', 'record_create', 'record_update'
  trigger_config: jsonb("trigger_config"), // { field_id, field_type, operator, value }
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
