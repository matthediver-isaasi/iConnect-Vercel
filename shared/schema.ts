import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
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
