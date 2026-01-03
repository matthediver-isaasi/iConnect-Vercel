import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { createClient } from "@supabase/supabase-js";
import session from "express-session";
import pgSession from "connect-pg-simple";
import multer from "multer";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import { evaluateWorkflows } from "./workflowEngine";
import { sendEmail } from "./emailService";

// Helper to strip HTML tags from text
function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// Helper to check if a role has capacity for more members
// Supports per-organization capacity when organizationId is provided
// Returns { hasCapacity: boolean, currentCount: number, maxMembers: number | null, roleName?: string, error?: string }
async function checkRoleCapacity(supabaseClient: any, roleId: string, organizationId?: string | null): Promise<{
  hasCapacity: boolean;
  currentCount: number;
  maxMembers: number | null;
  roleName?: string;
  error?: string;
  mode?: 'global' | 'per_organization';
}> {
  try {
    // Get the role's max_members limit
    const { data: role, error: roleError } = await supabaseClient
      .from('role')
      .select('id, name, max_members')
      .eq('id', roleId)
      .single();

    if (roleError) {
      return { hasCapacity: false, currentCount: 0, maxMembers: null, error: `Role not found: ${roleError.message}` };
    }

    // If max_members is null, unlimited capacity
    if (role.max_members === null || role.max_members === undefined) {
      return { hasCapacity: true, currentCount: 0, maxMembers: null, roleName: role.name };
    }

    // Build the query - filter by organization if provided (per-org capacity)
    let query = supabaseClient
      .from('member')
      .select('id', { count: 'exact', head: true })
      .eq('role_id', roleId)
      .eq('login_enabled', true);

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
      console.log(`[checkRoleCapacity] Per-org check for role ${roleId} in org ${organizationId}`);
    } else {
      console.log(`[checkRoleCapacity] Global check for role ${roleId}`);
    }

    const { count, error: countError } = await query;

    if (countError) {
      return { hasCapacity: false, currentCount: 0, maxMembers: role.max_members, roleName: role.name, error: `Count error: ${countError.message}` };
    }

    const currentCount = count || 0;
    const hasCapacity = currentCount < role.max_members;

    return { 
      hasCapacity, 
      currentCount, 
      maxMembers: role.max_members, 
      roleName: role.name,
      mode: organizationId ? 'per_organization' : 'global'
    };
  } catch (err: any) {
    return { hasCapacity: false, currentCount: 0, maxMembers: null, error: err.message };
  }
}

// Supabase client for server-side operations
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Entity name to Supabase table mapping (matches Base44 singular table names)
const entityToTable: Record<string, string> = {
  'Member': 'member',
  'Organization': 'organization',
  'Event': 'event',
  'ZohoToken': 'zoho_token',
  'Booking': 'booking',
  'ProgramTicketTransaction': 'program_ticket_transaction',
  'MagicLink': 'magic_link',
  'OrganizationContact': 'organization_contact',
  'Program': 'program',
  'Voucher': 'voucher',
  'XeroToken': 'xero_token',
  'BlogPost': 'blog_post',
  'Role': 'role',
  'TeamMember': 'team_member',
  'DiscountCode': 'discount_code',
  'DiscountCodeUsage': 'discount_code_usage',
  'SystemSettings': 'system_settings',
  'TourGroup': 'tour_group',
  'TourStep': 'tour_step',
  'Resource': 'resource',
  'ResourceCategory': 'resource_category',
  'FileRepository': 'file_repository',
  'ResourceAuthorSettings': 'resource_author_settings',
  'JobPosting': 'job_posting',
  'PageBanner': 'page_banner',
  'IEditPage': 'i_edit_page',
  'IEditPageElement': 'i_edit_page_element',
  'IEditElementTemplate': 'i_edit_element_template',
  'ResourceFolder': 'resource_folder',
  'FileRepositoryFolder': 'file_repository_folder',
  'NavigationItem': 'navigation_item',
  'ArticleCategory': 'article_category',
  'ArticleComment': 'article_comment',
  'CommentReaction': 'comment_reaction',
  'ArticleReaction': 'article_reaction',
  'ArticleView': 'article_view',
  'ButtonStyle': 'button_style',
  'Award': 'award',
  'OfflineAward': 'offline_award',
  'OfflineAwardAssignment': 'offline_award_assignment',
  'EngagementAward': 'engagement_award',
  'EngagementAwardAssignment': 'engagement_award_assignment',
  'OrganisationAward': 'organisation_award',
  'OrganisationAwardAssignment': 'organisation_award_assignment',
  'WallOfFameSection': 'wall_of_fame_section',
  'WallOfFameCategory': 'wall_of_fame_category',
  'WallOfFamePerson': 'wall_of_fame_person',
  'Floater': 'floater',
  'Form': 'form',
  'FormSubmission': 'form_submission',
  'NewsPost': 'news_post',
  'SupportTicket': 'support_ticket',
  'SupportTicketResponse': 'support_ticket_response',
  'PortalNavigationItem': 'portal_navigation_item',
  'MemberGroup': 'member_group',
  'MemberGroupAssignment': 'member_group_assignment',
  'GuestWriter': 'guest_writer',
  'PortalMenu': 'portal_menu',
  'AwardClassification': 'award_classification',
  'AwardSublevel': 'award_sublevel',
  'MemberGroupGuest': 'member_group_guest',
  'MemberCredentials': 'member_credentials',
  'CommunicationCategory': 'communication_category',
  'CommunicationCategoryRole': 'communication_category_role',
  'MemberCommunicationPreference': 'member_communication_preference',
  'PreferenceField': 'preference_field',
  'MemberPreferenceValue': 'member_preference_value',
  'OrganizationPreferenceValue': 'organization_preference_value',
  'Speaker': 'speaker',
  'TypographyStyle': 'typography_style',
  'CardDeck': 'card_deck',
  'DynamicDirectory': 'dynamic_directory',
  'TrainingFundTransaction': 'training_fund_transaction',
  'Workflow': 'workflow',
  'WorkflowLog': 'workflow_log',
  'MemberResourceCategory': 'member_resource_category',
  'RoleOrganizationFieldPermission': 'role_organization_field_permission',
  'RoleAccessItem': 'role_access_item',
  'ArticleFollow': 'article_follow',
  'RedirectMapping': 'redirect_mapping',
  'CsvImportProfile': 'csv_import_profile',
  'CsvImportJob': 'csv_import_job',
};

// Extend session type
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    memberEmail?: string;
    memberId?: string;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Trust proxy for Vercel/production deployments - required for secure cookies behind reverse proxy
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // Session middleware with PostgreSQL store for persistence across serverless instances
  const PgStore = pgSession(session);
  
  // Build connection string from Supabase credentials
  const databaseUrl = process.env.DATABASE_URL;
  
  app.use(session({
    secret: process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax', // Allows cookies to work across tabs
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days for better persistence
    },
    store: new PgStore({
      conString: databaseUrl,
      tableName: 'session', // Use existing session table
      createTableIfMissing: false, // We created it manually
      pruneSessionInterval: 60 * 15 // Prune expired sessions every 15 minutes
    }),
    name: 'iconnect.sid' // Custom session cookie name
  }));

  // Helper to get table name from entity (uses singular form for Base44 compatibility)
  const getTableName = (entity: string): string => {
    // Direct check for WorkflowLog since the mapping seems to not be working
    if (entity === 'WorkflowLog') {
      return 'workflow_log';
    }
    if (entity === 'Workflow') {
      return 'workflow';
    }
    
    const mapped = entityToTable[entity];
    if (mapped) {
      return mapped;
    }
    // Fallback: convert PascalCase to snake_case properly
    const snakeCase = entity.replace(/([A-Z])/g, (match, p1, offset) => 
      offset > 0 ? '_' + p1.toLowerCase() : p1.toLowerCase()
    );
    console.log(`[getTableName] Entity '${entity}' not in mapping, using fallback: '${snakeCase}'`);
    return snakeCase;
  };

  // ============ Entity Routes ============
  
  // List entities
  app.get('/api/entities/:entity', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { entity } = req.params;
      const tableName = getTableName(entity);
      const { filter, sort, limit, offset, expand } = req.query;

      let query = supabase.from(tableName).select(expand as string || '*');

      // Apply filters
      if (filter) {
        const filterObj = JSON.parse(filter as string);
        Object.entries(filterObj).forEach(([key, value]) => {
          if (Array.isArray(value)) {
            query = query.in(key, value);
          } else if (typeof value === 'object' && value !== null) {
            const filterOp = value as Record<string, unknown>;
            if ('eq' in filterOp) query = query.eq(key, filterOp.eq);
            if ('neq' in filterOp) query = query.neq(key, filterOp.neq);
            if ('gt' in filterOp) query = query.gt(key, filterOp.gt);
            if ('gte' in filterOp) query = query.gte(key, filterOp.gte);
            if ('lt' in filterOp) query = query.lt(key, filterOp.lt);
            if ('lte' in filterOp) query = query.lte(key, filterOp.lte);
            if ('like' in filterOp) query = query.like(key, filterOp.like as string);
            if ('ilike' in filterOp) query = query.ilike(key, filterOp.ilike as string);
            if ('is' in filterOp) query = query.is(key, filterOp.is as null);
            if ('in' in filterOp) query = query.in(key, filterOp.in as unknown[]);
          } else {
            query = query.eq(key, value);
          }
        });
      }

      // Apply sorting
      if (sort) {
        const sortObj = JSON.parse(sort as string);
        Object.entries(sortObj).forEach(([key, direction]) => {
          query = query.order(key, { ascending: direction === 'asc' });
        });
      }

      // Apply pagination
      if (limit) query = query.limit(parseInt(limit as string));
      if (offset) query = query.range(
        parseInt(offset as string), 
        parseInt(offset as string) + parseInt(limit as string || '100') - 1
      );

      const { data, error } = await query;
      
      // Debug logging for Member entity
      if (entity === 'Member' && data) {
        console.log(`[Entity GET] Member: returned ${data.length} records, limit=${limit || 'none'}`);
      }
      
      // Debug logging for ResourceAuthorSettings
      if (entity === 'ResourceAuthorSettings' && data) {
        console.log(`[Entity GET] ResourceAuthorSettings: returned ${data.length} records:`, JSON.stringify(data));
      }

      if (error) {
        console.error(`Error listing ${entity}:`, error);
        return res.status(500).json({ error: error.message });
      }

      res.json(data || []);
    } catch (error) {
      console.error('Entity list error:', error);
      res.status(500).json({ error: 'Failed to list entities' });
    }
  });

  // Get single entity
  app.get('/api/entities/:entity/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { entity, id } = req.params;
      const tableName = getTableName(entity);
      const { expand } = req.query;

      const { data, error } = await supabase
        .from(tableName)
        .select(expand as string || '*')
        .eq('id', id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Not found' });
        }
        return res.status(500).json({ error: error.message });
      }

      res.json(data);
    } catch (error) {
      console.error('Entity get error:', error);
      res.status(500).json({ error: 'Failed to get entity' });
    }
  });

  // Create entity
  app.post('/api/entities/:entity', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { entity } = req.params;
      const tableName = getTableName(entity);

      console.log(`[Entity POST] Creating ${entity} in table ${tableName}`);
      console.log(`[Entity POST] Payload:`, JSON.stringify(req.body, null, 2));

      // Normalize email to lowercase for member, team_member, and magic_link entities
      const payload = { ...req.body };
      if ((entity === 'Member' || entity === 'TeamMember' || entity === 'MagicLink') && payload.email) {
        payload.email = payload.email.toLowerCase();
      }

      // Check role capacity before creating Member with a role_id
      // Uses per-organization capacity if organization_id is provided
      if (entity === 'Member' && payload.role_id) {
        console.log(`[Entity POST] Checking role capacity for role_id: ${payload.role_id}, org_id: ${payload.organization_id || 'none'}`);
        const capacityCheck = await checkRoleCapacity(supabase, payload.role_id, payload.organization_id);
        console.log(`[Entity POST] Role capacity check result:`, JSON.stringify(capacityCheck));
        
        if (!capacityCheck.hasCapacity) {
          console.error(`[Entity POST] Role at max capacity: ${capacityCheck.currentCount}/${capacityCheck.maxMembers}`);
          return res.status(400).json({ 
            error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members${capacityCheck.mode === 'per_organization' ? ' for this organization' : ''}.`,
            code: 'ROLE_CAPACITY_EXCEEDED'
          });
        }
      }

      const { data, error } = await supabase
        .from(tableName)
        .insert(payload)
        .select()
        .single();

      if (error) {
        console.error(`[Entity POST] ${entity} error:`, error);
        console.error(`[Entity POST] Full error details:`, JSON.stringify(error, null, 2));
        return res.status(500).json({ error: error.message });
      }

      console.log(`[Entity POST] ${entity} created successfully:`, data?.id);

      // Trigger workflow evaluation for new Organization and Member records
      const isWorkflowEntity = entity === 'Organization' || entity === 'Member';
      if (isWorkflowEntity && data) {
        const entityType = entity.toLowerCase() as 'organization' | 'member';
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        // Run asynchronously to not block the response
        evaluateWorkflows(entityType, data.id, null, data, 'record_create', baseUrl).catch(err => {
          console.error('[Entity POST] Workflow evaluation error:', err);
        });
      }

      res.status(201).json(data);
    } catch (error) {
      console.error('Entity create error:', error);
      res.status(500).json({ error: 'Failed to create entity' });
    }
  });

  // Update entity
  app.patch('/api/entities/:entity/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { entity, id } = req.params;
      const tableName = getTableName(entity);

      console.log(`[Entity PATCH] ${entity}/${id} with payload:`, JSON.stringify(req.body));

      // Fetch before state for workflow evaluation (Organization and Member only)
      let beforeData: any = null;
      const isWorkflowEntity = entity === 'Organization' || entity === 'Member';
      
      if (isWorkflowEntity) {
        const { data: existingData } = await supabase
          .from(tableName)
          .select('*')
          .eq('id', id)
          .single();
        beforeData = existingData;
      }

      // Normalize email to lowercase for member, team_member, and magic_link entities
      if ((entity === 'Member' || entity === 'TeamMember' || entity === 'MagicLink') && req.body.email) {
        req.body.email = req.body.email.toLowerCase();
      }

      // Check role capacity when changing Member's role_id
      // Uses per-organization capacity based on the member's organization
      if (entity === 'Member' && req.body.role_id !== undefined) {
        const newRoleId = req.body.role_id;
        const currentRoleId = beforeData?.role_id;
        const memberOrgId = req.body.organization_id ?? beforeData?.organization_id;
        
        // Only check capacity if changing to a different role (not clearing or same role)
        if (newRoleId !== null && newRoleId !== currentRoleId) {
          console.log(`[Entity PATCH] Checking role capacity for role_id: ${newRoleId}, org_id: ${memberOrgId || 'none'}`);
          const capacityCheck = await checkRoleCapacity(supabase, newRoleId, memberOrgId);
          console.log(`[Entity PATCH] Role capacity check result:`, JSON.stringify(capacityCheck));
          
          if (!capacityCheck.hasCapacity) {
            console.error(`[Entity PATCH] Role at max capacity: ${capacityCheck.currentCount}/${capacityCheck.maxMembers}`);
            return res.status(400).json({ 
              error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members${capacityCheck.mode === 'per_organization' ? ' for this organization' : ''}.`,
              code: 'ROLE_CAPACITY_EXCEEDED'
            });
          }
        }
      }

      // Special validation for Event seat capacity changes
      if (entity === 'Event' && req.body.available_seats !== undefined) {
        const newSeatCapacity = req.body.available_seats;
        
        // If setting to null (unlimited), that's always allowed
        if (newSeatCapacity !== null) {
          // Count active bookings for this event
          const { count: activeBookingCount, error: countError } = await supabase
            .from('booking')
            .select('*', { count: 'exact', head: true })
            .eq('event_id', id)
            .neq('status', 'cancelled');
          
          if (countError) {
            console.error('[Entity PATCH] Error counting bookings:', countError);
          } else {
            const bookingCount = activeBookingCount || 0;
            
            // Prevent reducing seats below registered attendees
            if (newSeatCapacity < bookingCount) {
              console.log(`[Entity PATCH] Seat validation failed: ${newSeatCapacity} < ${bookingCount} bookings`);
              return res.status(400).json({ 
                error: `Cannot reduce seat capacity to ${newSeatCapacity}. There are ${bookingCount} registered attendees. You can reduce to ${bookingCount} (will show as sold out) or higher.`
              });
            }
            
            console.log(`[Entity PATCH] Seat validation passed: ${newSeatCapacity} >= ${bookingCount} bookings`);
          }
        }
      }

      const { data, error } = await supabase
        .from(tableName)
        .update(req.body)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error(`[Entity PATCH] ${entity}/${id} error:`, error);
        // Handle "no rows found" as 404
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: `${entity} with id ${id} not found` });
        }
        return res.status(500).json({ error: error.message });
      }

      console.log(`[Entity PATCH] ${entity}/${id} success:`, data ? 'updated' : 'no data returned');

      // Trigger workflow evaluation for Organization and Member updates
      if (isWorkflowEntity && beforeData && data) {
        const entityType = entity.toLowerCase() as 'organization' | 'member';
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        // Run asynchronously to not block the response
        evaluateWorkflows(entityType, id, beforeData, data, 'field_change', baseUrl).catch(err => {
          console.error('[Entity PATCH] Workflow evaluation error:', err);
        });
      }

      res.json(data);
    } catch (error) {
      console.error('Entity update error:', error);
      res.status(500).json({ error: 'Failed to update entity' });
    }
  });

  // Delete entity
  app.delete('/api/entities/:entity/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { entity, id } = req.params;
      const tableName = getTableName(entity);

      // Handle cascade deletion for entities with foreign key relationships
      
      // Check if Role has members assigned - if so, reassign them to default role before deletion
      if (entity === 'Role') {
        const { count: memberCount, error: countError } = await supabase
          .from('member')
          .select('*', { count: 'exact', head: true })
          .eq('role_id', id);

        if (countError) {
          console.error('[Role Delete] Error counting members:', countError);
        } else if (memberCount && memberCount > 0) {
          console.log(`[Role Delete] Role ${id} has ${memberCount} members assigned, will reassign to default role`);
          
          // Find the default role
          const { data: allRoles, error: rolesError } = await supabase
            .from('role')
            .select('id, name, is_default');
          
          if (rolesError) {
            console.error('[Role Delete] Error fetching roles:', rolesError);
            return res.status(500).json({ error: 'Failed to fetch roles for reassignment' });
          }
          
          const defaultRole = allRoles?.find((r: any) => r.is_default === true && r.id !== id);
          
          if (!defaultRole) {
            console.error('[Role Delete] No default role found for reassignment');
            return res.status(400).json({ 
              error: 'Cannot delete this role: no default role available for member reassignment. Please mark another role as default first.'
            });
          }
          
          // Reassign all members from this role to the default role
          const { error: reassignError } = await supabase
            .from('member')
            .update({ role_id: defaultRole.id })
            .eq('role_id', id);
          
          if (reassignError) {
            console.error('[Role Delete] Error reassigning members:', reassignError);
            return res.status(500).json({ error: 'Failed to reassign members to default role' });
          }
          
          console.log(`[Role Delete] Reassigned ${memberCount} members from role ${id} to default role ${defaultRole.name} (${defaultRole.id})`);
        }
      }

      if (entity === 'Event') {
        // First delete any bookings associated with this event
        const { error: bookingDeleteError } = await supabase
          .from('booking')
          .delete()
          .eq('event_id', id);

        if (bookingDeleteError) {
          console.error('Error deleting event bookings:', bookingDeleteError);
          // Continue anyway - there might not be any bookings
        }

        // Also delete any program_ticket_transactions that reference bookings for this event
        // (These should cascade from booking deletion, but let's be safe)
        console.log(`[Event Delete] Deleted associated bookings for event ${id}`);
      }

      // Special handling for Member: anonymize personal data and delete from related tables
      // but keep the member record for financial audit trail (bookings, tickets, etc.)
      if (entity === 'Member') {
        console.log(`[Member Delete] Starting anonymization and cleanup for member ${id}`);
        
        // Delete from member-related tables (personal data, preferences, activity)
        const deleteTables = [
          { table: 'member_resource_category', column: 'member_id' },
          { table: 'member_group_assignment', column: 'member_id' },
          { table: 'member_group_guest', column: 'member_id' },
          { table: 'member_preference_value', column: 'member_id' },
          { table: 'member_communication_preference', column: 'member_id' },
          { table: 'magic_link', column: 'member_id' },
          { table: 'member_credentials', column: 'member_id' },
          { table: 'article_follow', column: 'follower_member_id' },
          { table: 'article_follow', column: 'followed_member_id' },
          { table: 'article_comment', column: 'member_id' },
          { table: 'article_view', column: 'member_id' },
          { table: 'article_reaction', column: 'member_id' },
          { table: 'comment_reaction', column: 'member_id' },
          { table: 'form_submission', column: 'member_id' },
          { table: 'support_ticket_response', column: 'member_id' },
          { table: 'support_ticket', column: 'member_id' },
          { table: 'workflow_log', column: 'member_id' },
          { table: 'organization_note', column: 'author_member_id' },
        ];
        
        for (const { table, column } of deleteTables) {
          const { error: deleteError } = await supabase
            .from(table)
            .delete()
            .eq(column, id);
          
          if (deleteError) {
            console.log(`[Member Delete] Note: Could not delete from ${table}.${column}: ${deleteError.message}`);
          } else {
            console.log(`[Member Delete] Deleted records from ${table} where ${column} = ${id}`);
          }
        }
        
        // Anonymize the member record - clear ALL personal data but keep id
        // Based on actual schema/Member.json columns
        const { error: anonymizeError } = await supabase
          .from('member')
          .update({
            email: `deleted_${id}@deleted.local`,
            first_name: 'Deleted',
            last_name: 'Member',
            handle: null,
            job_title: null,
            biography: null,
            profile_photo_url: null,
            zoho_contact_id: null,
            login_enabled: false,
            show_in_directory: false,
          })
          .eq('id', id);
        
        if (anonymizeError) {
          console.error(`[Member Delete] Error anonymizing member ${id}:`, anonymizeError);
          return res.status(500).json({ error: 'Failed to anonymize member data' });
        }
        
        console.log(`[Member Delete] Successfully anonymized member ${id} and deleted related data`);
        return res.json({ success: true, message: 'Member data anonymized and related records deleted' });
      }

      // Special handling for Organization: delete all members and their related data first
      if (entity === 'Organization') {
        console.log(`[Organization Delete] Starting cascade delete for organization ${id}`);
        
        // First, get all members belonging to this organization
        const { data: members, error: membersError } = await supabase
          .from('member')
          .select('id')
          .eq('organization_id', id);
        
        if (membersError) {
          console.error('[Organization Delete] Error fetching members:', membersError);
          return res.status(500).json({ error: 'Failed to fetch organization members' });
        }
        
        const memberIds = (members || []).map(m => m.id);
        console.log(`[Organization Delete] Found ${memberIds.length} members to delete`);
        
        // Anonymize member-related data for all members in this organization
        // (mirrors standalone member delete - keeps member records for audit trail)
        if (memberIds.length > 0) {
          const memberDeleteTables = [
            { table: 'member_resource_category', column: 'member_id' },
            { table: 'member_group_assignment', column: 'member_id' },
            { table: 'member_group_guest', column: 'member_id' },
            { table: 'member_preference_value', column: 'member_id' },
            { table: 'member_communication_preference', column: 'member_id' },
            { table: 'magic_link', column: 'member_id' },
            { table: 'member_credentials', column: 'member_id' },
            { table: 'article_follow', column: 'follower_member_id' },
            { table: 'article_follow', column: 'followed_member_id' },
            { table: 'article_comment', column: 'member_id' },
            { table: 'article_view', column: 'member_id' },
            { table: 'article_reaction', column: 'member_id' },
            { table: 'comment_reaction', column: 'member_id' },
            { table: 'form_submission', column: 'member_id' },
            { table: 'support_ticket_response', column: 'member_id' },
            { table: 'support_ticket', column: 'member_id' },
            { table: 'workflow_log', column: 'member_id' },
          ];
          
          for (const { table, column } of memberDeleteTables) {
            const { error: deleteError } = await supabase
              .from(table)
              .delete()
              .in(column, memberIds);
            
            if (deleteError) {
              console.log(`[Organization Delete] Note: Could not delete from ${table}.${column}: ${deleteError.message}`);
            } else {
              console.log(`[Organization Delete] Deleted records from ${table} for ${memberIds.length} members`);
            }
          }
          
          // Anonymize members instead of deleting (preserves FKs in bookings, transactions, etc.)
          for (const memberId of memberIds) {
            const { error: anonymizeError } = await supabase
              .from('member')
              .update({
                email: `deleted_${memberId}@deleted.local`,
                first_name: 'Deleted',
                last_name: 'Member',
                handle: null,
                job_title: null,
                biography: null,
                profile_photo_url: null,
                zoho_contact_id: null,
                login_enabled: false,
                show_in_directory: false,
                organization_id: null, // Unlink from organization
              })
              .eq('id', memberId);
            
            if (anonymizeError) {
              console.log(`[Organization Delete] Note: Could not anonymize member ${memberId}: ${anonymizeError.message}`);
            }
          }
          
          console.log(`[Organization Delete] Anonymized ${memberIds.length} members`);
        }
        
        // Delete organization-related data
        const orgDeleteTables = [
          { table: 'organization_preference_value', column: 'organization_id' },
          { table: 'organization_note', column: 'organization_id' },
        ];
        
        for (const { table, column } of orgDeleteTables) {
          const { error: deleteError } = await supabase
            .from(table)
            .delete()
            .eq(column, id);
          
          if (deleteError) {
            console.log(`[Organization Delete] Note: Could not delete from ${table}.${column}: ${deleteError.message}`);
          } else {
            console.log(`[Organization Delete] Deleted records from ${table} where ${column} = ${id}`);
          }
        }
        
        // Nullify organization references in other tables (don't delete, just unlink)
        const nullifyTables = [
          { table: 'booking', column: 'organization_id' },
          { table: 'job_posting', column: 'posted_by_organization_id' },
          { table: 'discount_code', column: 'organization_id' },
          { table: 'voucher', column: 'organization_id' },
        ];
        
        for (const { table, column } of nullifyTables) {
          const { error: nullifyError } = await supabase
            .from(table)
            .update({ [column]: null })
            .eq(column, id);
          
          if (nullifyError) {
            console.log(`[Organization Delete] Note: Could not nullify ${table}.${column}: ${nullifyError.message}`);
          } else {
            console.log(`[Organization Delete] Nullified ${table}.${column} references`);
          }
        }
        
        // Finally delete the organization
        const { error: deleteOrgError } = await supabase
          .from('organization')
          .delete()
          .eq('id', id);
        
        if (deleteOrgError) {
          console.error('[Organization Delete] Error deleting organization:', deleteOrgError);
          return res.status(500).json({ error: `Failed to delete organization: ${deleteOrgError.message}` });
        }
        
        console.log(`[Organization Delete] Successfully deleted organization ${id} and all related data`);
        return res.json({ 
          success: true, 
          message: `Organization deleted. ${memberIds.length} members were anonymized and unlinked.` 
        });
      }

      const { error } = await supabase
        .from(tableName)
        .delete()
        .eq('id', id);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Entity delete error:', error);
      res.status(500).json({ error: 'Failed to delete entity' });
    }
  });

  // ============ Member Category Selections (subcategory-based storage) ============
  // Stores member selections as (category_id, subcategory_name) pairs
  // Subcategories are string values from the parent category's subcategories array
  
  // Update member's category selections (diff-based: only add/remove what changed)
  app.post('/api/members/:memberId/categories', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { memberId } = req.params;
      const { selections } = req.body;

      if (!memberId) {
        return res.status(400).json({ error: 'Member ID is required' });
      }

      if (!selections || !Array.isArray(selections)) {
        return res.status(400).json({ error: 'selections must be an array of {category_id, subcategory_name}' });
      }

      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id')
        .eq('id', memberId)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validSelections: Array<{ category_id: string; subcategory_name: string | null }> = [];
      const seenKeys = new Set<string>();

      for (const sel of selections) {
        if (sel && typeof sel.category_id === 'string' && uuidRegex.test(sel.category_id)) {
          const subcatName = typeof sel.subcategory_name === 'string' && sel.subcategory_name.trim().length > 0
            ? sel.subcategory_name.trim()
            : null;
          const key = `${sel.category_id}|${subcatName || ''}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            validSelections.push({
              category_id: sel.category_id,
              subcategory_name: subcatName
            });
          }
        }
      }

      const categoryIds = [...new Set(validSelections.map(s => s.category_id))];
      
      let finalSelections: Array<{ category_id: string; subcategory_name: string | null }> = [];
      if (categoryIds.length > 0) {
        const { data: existingCategories, error: catError } = await supabase
          .from('resource_category')
          .select('id, subcategories')
          .in('id', categoryIds);

        if (catError) {
          console.error('[Member Categories] Category validation error:', catError);
          return res.status(500).json({ error: 'Failed to validate categories' });
        }

        const categoryMap = new Map((existingCategories || []).map(c => [c.id, c.subcategories || []]));
        finalSelections = validSelections.filter(sel => {
          const subcats = categoryMap.get(sel.category_id);
          if (subcats === undefined) return false;
          
          if (subcats.length === 0) {
            return sel.subcategory_name === null;
          }
          
          return sel.subcategory_name !== null && subcats.includes(sel.subcategory_name);
        });
      }

      const { data: currentSelections, error: fetchError } = await supabase
        .from('member_resource_category')
        .select('id, resource_category_id, subcategory_name')
        .eq('member_id', memberId);

      if (fetchError) {
        console.error('[Member Categories] Fetch current error:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch current selections' });
      }

      const currentKeys = new Set(
        (currentSelections || []).map(s => `${s.resource_category_id}|${s.subcategory_name || ''}`)
      );
      const newKeys = new Set(
        finalSelections.map(s => `${s.category_id}|${s.subcategory_name || ''}`)
      );

      const toAdd = finalSelections.filter(s => 
        !currentKeys.has(`${s.category_id}|${s.subcategory_name || ''}`)
      );
      
      const toRemove = (currentSelections || []).filter(s => 
        !newKeys.has(`${s.resource_category_id}|${s.subcategory_name || ''}`)
      );

      if (toRemove.length > 0) {
        const removeIds = toRemove.map(s => s.id);
        const { error: deleteError } = await supabase
          .from('member_resource_category')
          .delete()
          .in('id', removeIds);

        if (deleteError) {
          console.error('[Member Categories] Delete error:', deleteError);
          return res.status(500).json({ error: 'Failed to remove unselected categories' });
        }
        console.log(`[Member Categories] Removed ${toRemove.length} selections`);
      }

      if (toAdd.length > 0) {
        const insertData = toAdd.map(sel => ({
          member_id: memberId,
          resource_category_id: sel.category_id,
          subcategory_name: sel.subcategory_name
        }));

        const { error: insertError } = await supabase
          .from('member_resource_category')
          .insert(insertData);

        if (insertError) {
          console.error('[Member Categories] Insert error:', insertError);
          return res.status(500).json({ error: 'Failed to add new category selections' });
        }
        console.log(`[Member Categories] Added ${toAdd.length} selections`);
      }

      console.log(`[Member Categories] Updated member ${memberId}: +${toAdd.length} -${toRemove.length}, total: ${finalSelections.length}`);
      res.json({ success: true, count: finalSelections.length, added: toAdd.length, removed: toRemove.length });
    } catch (error) {
      console.error('[Member Categories] Error:', error);
      res.status(500).json({ error: 'Failed to update member categories' });
    }
  });

  // Get member's category selections (includes subcategory_name)
  app.get('/api/members/:memberId/categories', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { memberId } = req.params;

      if (!memberId) {
        return res.status(400).json({ error: 'Member ID is required' });
      }

      const { data, error } = await supabase
        .from('member_resource_category')
        .select('id, resource_category_id, subcategory_name, created_at')
        .eq('member_id', memberId);

      if (error) {
        console.error('[Member Categories] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch categories' });
      }

      res.json(data || []);
    } catch (error) {
      console.error('[Member Categories] Error:', error);
      res.status(500).json({ error: 'Failed to fetch member categories' });
    }
  });

  // ============ Article Follow Routes ============

  // Get current user's followed authors with unread counts
  app.get('/api/article-follows', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const memberId = req.session?.memberId;
      if (!memberId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Fetch all follows for this member
      const { data: follows, error: followsError } = await supabase
        .from('article_follow')
        .select('*')
        .eq('follower_member_id', memberId);

      if (followsError) {
        console.error('[Article Follows] Fetch error:', followsError);
        return res.status(500).json({ error: 'Failed to fetch follows' });
      }

      if (!follows || follows.length === 0) {
        return res.json([]);
      }

      // For each follow, get author details and unread count
      const results = await Promise.all(follows.map(async (follow: any) => {
        let authorName = 'Unknown Author';
        let authorHandle = null;
        let authorProfilePhoto = null;

        // Get author details
        let authorOrganization = null;
        if (follow.followed_member_id) {
          const { data: member, error: memberError } = await supabase
            .from('member')
            .select('id, first_name, last_name, handle, profile_photo_url, organization_id')
            .eq('id', follow.followed_member_id)
            .single();
          
          console.log('[Article Follows] Member lookup for', follow.followed_member_id, ':', member, 'error:', memberError);
          
          if (member && !memberError) {
            authorName = `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Author';
            authorHandle = member.handle;
            authorProfilePhoto = member.profile_photo_url;
            
            // Fetch organization if member has one - try by id first, then by zoho_account_id
            if (member.organization_id) {
              // Try lookup by primary id first
              let { data: org } = await supabase
                .from('organization')
                .select('name')
                .eq('id', member.organization_id)
                .single();
              
              // If not found, try by zoho_account_id
              if (!org) {
                const { data: orgByZoho } = await supabase
                  .from('organization')
                  .select('name')
                  .eq('zoho_account_id', member.organization_id)
                  .single();
                org = orgByZoho;
              }
              
              if (org) {
                authorOrganization = org.name;
              }
            }
          }
        } else if (follow.followed_guest_writer_id) {
          const { data: guestWriter, error: gwError } = await supabase
            .from('guest_writer')
            .select('id, full_name, handle, organization, profile_photo_url')
            .eq('id', follow.followed_guest_writer_id)
            .single();
          
          console.log('[Article Follows] Guest writer lookup for', follow.followed_guest_writer_id, ':', guestWriter, 'error:', gwError);
          
          if (guestWriter && !gwError) {
            authorName = guestWriter.full_name || 'Unknown Author';
            authorHandle = guestWriter.handle;
            authorOrganization = guestWriter.organization;
            authorProfilePhoto = guestWriter.profile_photo_url;
          }
        }

        // Count unread articles (published after last_read_at, or after follow created_at if never read)
        // Also filter out scheduled articles that haven't gone live yet (published_date <= now)
        let unreadCount = 0;
        // Use last_read_at if available, otherwise use created_at as the baseline
        const compareDate = follow.last_read_at || follow.created_at;
        const nowIso = new Date().toISOString();
        
        if (follow.followed_member_id) {
          let query = supabase
            .from('blog_post')
            .select('id', { count: 'exact', head: true })
            .eq('author_id', follow.followed_member_id)
            .eq('status', 'published')
            .lte('published_date', nowIso); // Only count articles that have gone live
          
          if (compareDate) {
            query = query.gt('published_date', compareDate);
          }
          
          const { count } = await query;
          unreadCount = count || 0;
        } else if (follow.followed_guest_writer_id) {
          let query = supabase
            .from('blog_post')
            .select('id', { count: 'exact', head: true })
            .eq('guest_writer_id', follow.followed_guest_writer_id)
            .eq('status', 'published')
            .lte('published_date', nowIso); // Only count articles that have gone live
          
          if (compareDate) {
            query = query.gt('published_date', compareDate);
          }
          
          const { count } = await query;
          unreadCount = count || 0;
        }

        return {
          id: follow.id,
          followed_member_id: follow.followed_member_id,
          followed_guest_writer_id: follow.followed_guest_writer_id,
          author_name: authorName,
          author_handle: authorHandle,
          author_organization: authorOrganization,
          author_profile_photo: authorProfilePhoto,
          unread_count: unreadCount,
          created_at: follow.created_at,
          last_read_at: follow.last_read_at
        };
      }));

      res.json(results);
    } catch (error) {
      console.error('[Article Follows] Error:', error);
      res.status(500).json({ error: 'Failed to fetch follows' });
    }
  });

  // Follow an author
  app.post('/api/article-follows', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const memberId = req.session?.memberId;
      if (!memberId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { followed_member_id, followed_guest_writer_id } = req.body;

      if (!followed_member_id && !followed_guest_writer_id) {
        return res.status(400).json({ error: 'Author ID required' });
      }

      // Ensure exactly one target type is provided
      if (followed_member_id && followed_guest_writer_id) {
        return res.status(400).json({ error: 'Cannot specify both member and guest writer' });
      }

      // Prevent following yourself
      if (followed_member_id && followed_member_id === memberId) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
      }

      // Verify target author exists
      if (followed_member_id) {
        const { data: member, error: memberError } = await supabase
          .from('member')
          .select('id')
          .eq('id', followed_member_id)
          .single();
        
        if (memberError || !member) {
          return res.status(404).json({ error: 'Author not found' });
        }
      } else if (followed_guest_writer_id) {
        const { data: guestWriter, error: gwError } = await supabase
          .from('guest_writer')
          .select('id')
          .eq('id', followed_guest_writer_id)
          .single();
        
        if (gwError || !guestWriter) {
          return res.status(404).json({ error: 'Guest writer not found' });
        }
      }

      // Check if already following
      let checkQuery = supabase
        .from('article_follow')
        .select('id')
        .eq('follower_member_id', memberId);
      
      if (followed_member_id) {
        checkQuery = checkQuery.eq('followed_member_id', followed_member_id);
      } else {
        checkQuery = checkQuery.eq('followed_guest_writer_id', followed_guest_writer_id);
      }

      const { data: existing } = await checkQuery.single();

      if (existing) {
        return res.status(409).json({ error: 'Already following this author' });
      }

      // Create follow record
      const { data, error } = await supabase
        .from('article_follow')
        .insert({
          follower_member_id: memberId,
          followed_member_id: followed_member_id || null,
          followed_guest_writer_id: followed_guest_writer_id || null
        })
        .select()
        .single();

      if (error) {
        console.error('[Article Follows] Insert error:', error);
        return res.status(500).json({ error: 'Failed to follow author' });
      }

      res.status(201).json(data);
    } catch (error) {
      console.error('[Article Follows] Error:', error);
      res.status(500).json({ error: 'Failed to follow author' });
    }
  });

  // Unfollow an author
  app.delete('/api/article-follows/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const memberId = req.session?.memberId;
      if (!memberId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { id } = req.params;

      // Delete the follow record (only if owned by current user)
      const { error } = await supabase
        .from('article_follow')
        .delete()
        .eq('id', id)
        .eq('follower_member_id', memberId);

      if (error) {
        console.error('[Article Follows] Delete error:', error);
        return res.status(500).json({ error: 'Failed to unfollow author' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[Article Follows] Error:', error);
      res.status(500).json({ error: 'Failed to unfollow author' });
    }
  });

  // Check if following a specific author
  app.get('/api/article-follows/check', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const memberId = req.session?.memberId;
      if (!memberId) {
        return res.json({ following: false, followId: null });
      }

      const { author_id, guest_writer_id } = req.query;

      if (!author_id && !guest_writer_id) {
        return res.status(400).json({ error: 'Author ID required' });
      }

      let query = supabase
        .from('article_follow')
        .select('id')
        .eq('follower_member_id', memberId);
      
      if (author_id) {
        query = query.eq('followed_member_id', author_id);
      } else {
        query = query.eq('followed_guest_writer_id', guest_writer_id);
      }

      const { data } = await query.single();

      res.json({ 
        following: !!data, 
        followId: data?.id || null 
      });
    } catch (error) {
      console.error('[Article Follows] Check error:', error);
      res.json({ following: false, followId: null });
    }
  });

  // Mark author's articles as read (update last_read_at)
  app.patch('/api/article-follows/:id/mark-read', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const memberId = req.session?.memberId;
      if (!memberId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { id } = req.params;

      const { error } = await supabase
        .from('article_follow')
        .update({ last_read_at: new Date().toISOString() })
        .eq('id', id)
        .eq('follower_member_id', memberId);

      if (error) {
        console.error('[Article Follows] Mark read error:', error);
        return res.status(500).json({ error: 'Failed to mark as read' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[Article Follows] Error:', error);
      res.status(500).json({ error: 'Failed to mark as read' });
    }
  });

  // ============ Author Lookup Route ============

  // Lookup author by handle (for /articles/author/:handle route)
  app.get('/api/articles/lookup-author', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { handle } = req.query;
      
      if (!handle || typeof handle !== 'string') {
        return res.status(400).json({ error: 'Handle is required' });
      }

      console.log('[Author Lookup] Searching for handle:', handle);

      // Try to find member by handle first
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id, first_name, last_name, handle, organization_id')
        .eq('handle', handle)
        .single();

      if (member && !memberError) {
        console.log('[Author Lookup] Found member:', member.id);
        
        // Fetch organization if member has one
        let organizationName = null;
        if (member.organization_id) {
          const { data: org } = await supabase
            .from('organization')
            .select('name')
            .eq('zoho_account_id', member.organization_id)
            .single();
          
          if (org) {
            organizationName = org.name;
          }
        }

        return res.json({
          type: 'member',
          id: member.id,
          name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Author',
          organization: organizationName
        });
      }

      // Try guest writer by handle
      const { data: guestWriter, error: gwError } = await supabase
        .from('guest_writer')
        .select('id, full_name, handle, organization')
        .eq('handle', handle)
        .single();

      if (guestWriter && !gwError) {
        console.log('[Author Lookup] Found guest writer:', guestWriter.id);
        return res.json({
          type: 'guest_writer',
          id: guestWriter.id,
          name: guestWriter.full_name || 'Unknown Author',
          organization: guestWriter.organization
        });
      }

      // Author not found
      console.log('[Author Lookup] Author not found for handle:', handle);
      return res.status(404).json({ error: 'Author not found' });
    } catch (error) {
      console.error('[Author Lookup] Error:', error);
      res.status(500).json({ error: 'Failed to lookup author' });
    }
  });

  // ============ Public Data Routes (no auth required) ============
  
  // Public endpoint for organisation list (used by forms)
  app.get('/api/public/organisations', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { data, error } = await supabase
        .from('organization')
        .select('id, name')
        .order('name', { ascending: true });

      if (error) {
        console.error('Error fetching organisations:', error);
        return res.status(500).json({ error: error.message });
      }

      res.json(data || []);
    } catch (error) {
      console.error('Public organisations fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch organisations' });
    }
  });

  // Public endpoint for organisation domain info (used for email domain validation in forms)
  app.get('/api/public/organisation/:id/domains', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Organisation ID is required' });
    }

    try {
      // Fetch organisation basic info
      const { data: org, error: orgError } = await supabase
        .from('organization')
        .select('id, name')
        .eq('id', id)
        .single();

      if (orgError) {
        console.error('Error fetching organisation:', orgError);
        return res.status(500).json({ error: orgError.message });
      }

      if (!org) {
        return res.status(404).json({ error: 'Organisation not found' });
      }

      // Find the verified_domains custom field definition
      const { data: fieldDef, error: fieldError } = await supabase
        .from('preference_field')
        .select('id')
        .eq('name', 'verified_domains')
        .eq('entity_scope', 'organization')
        .eq('is_active', true)
        .single();

      let verifiedDomains: string[] = [];

      if (fieldDef && !fieldError) {
        // Fetch the organization's custom field value
        const { data: fieldValue, error: valueError } = await supabase
          .from('organization_preference_value')
          .select('value')
          .eq('organization_id', id)
          .eq('field_id', fieldDef.id)
          .single();

        if (fieldValue && !valueError && fieldValue.value) {
          const val = fieldValue.value;
          // Handle different storage formats: native array (jsonb), JSON string, or comma-separated string
          if (Array.isArray(val)) {
            verifiedDomains = val.filter(Boolean);
          } else if (typeof val === 'string') {
            try {
              const parsed = JSON.parse(val);
              verifiedDomains = Array.isArray(parsed) ? parsed.filter(Boolean) : [parsed].filter(Boolean);
            } catch {
              // If not JSON, treat as comma-separated or single value
              verifiedDomains = val.split(',').map((d: string) => d.trim()).filter(Boolean);
            }
          }
        }
      }

      res.json({
        id: org.id,
        name: org.name,
        verified_domains: verifiedDomains
      });
    } catch (error) {
      console.error('Public organisation domains fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch organisation domains' });
    }
  });

  // Public endpoint for communication categories (used by forms for category multi-select)
  app.get('/api/public/categories', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { data, error } = await supabase
        .from('communication_category')
        .select('id, name, description')
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (error) {
        console.error('Error fetching categories:', error);
        return res.status(500).json({ error: error.message });
      }

      res.json(data || []);
    } catch (error) {
      console.error('Public categories fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  // Public endpoint for communication categories (used by forms for communication preferences field)
  app.get('/api/public/communication-categories', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { data, error } = await supabase
        .from('communication_category')
        .select('id, name, description')
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (error) {
        console.error('Error fetching communication categories:', error);
        return res.status(500).json({ error: error.message });
      }

      res.json(data || []);
    } catch (error) {
      console.error('Public communication categories fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch communication categories' });
    }
  });

  // Public endpoint for resource categories (used by forms for search/content category multi-select)
  app.get('/api/public/resource-categories', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { data, error } = await supabase
        .from('resource_category')
        .select('id, name, description, subcategories, applies_to_content_types')
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (error) {
        console.error('Error fetching resource categories:', error);
        return res.status(500).json({ error: error.message });
      }

      res.json(data || []);
    } catch (error) {
      console.error('Public resource categories fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch resource categories' });
    }
  });

  // Public endpoint for custom field definition (used by forms for custom_field type)
  app.get('/api/public/custom-field/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('preference_field')
        .select('id, label, field_type, options, entity_scope, min_selections, max_selections')
        .eq('id', id)
        .eq('is_active', true)
        .single();

      if (error) {
        console.error('Error fetching custom field:', error);
        return res.status(404).json({ error: 'Custom field not found' });
      }

      res.json(data);
    } catch (error) {
      console.error('Public custom field fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch custom field' });
    }
  });

  // Public endpoint for form consent message
  app.get('/api/public/form-consent-message', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { data, error } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'form_default_consent_message')
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching form consent message:', error);
        return res.status(500).json({ error: error.message });
      }

      res.json({ message: data?.setting_value || '' });
    } catch (error) {
      console.error('Form consent message fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch consent message' });
    }
  });

  // Public endpoint for page banners (used by PublicLayout for logged-out users)
  app.get('/api/public/banners', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { data, error } = await supabase
        .from('page_banner')
        .select('*')
        .eq('is_active', true)
        .order('display_order', { ascending: true });

      if (error) {
        console.error('Error fetching public banners:', error);
        return res.status(500).json({ error: error.message });
      }

      res.json(data || []);
    } catch (error) {
      console.error('Public banners fetch error:', error);
      res.status(500).json({ error: 'Failed to fetch banners' });
    }
  });

  // Public endpoint to check role capacity (used by forms before submission)
  // Supports per-organization capacity checks via orgKey and orgValue query params
  app.get('/api/public/role/:id/capacity', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { id: roleId } = req.params;
      const { orgKey, orgValue } = req.query;
      
      if (!roleId) {
        return res.status(400).json({ error: 'Role ID required' });
      }

      console.log(`[Role Capacity Check] Checking capacity for role: ${roleId}`);
      console.log(`[Role Capacity Check] Organization lookup - key: ${orgKey}, value: ${orgValue}`);

      // Get the role's max_members limit
      const { data: role, error: roleError } = await supabase
        .from('role')
        .select('id, name, max_members')
        .eq('id', roleId)
        .single();

      if (roleError) {
        console.error('Error fetching role:', roleError);
        return res.status(404).json({ error: 'Role not found' });
      }

      // If max_members is null, unlimited capacity
      if (role.max_members === null || role.max_members === undefined) {
        console.log(`[Role Capacity Check] Role ${roleId} has no capacity limit`);
        return res.json({
          hasCapacity: true,
          currentCount: 0,
          maxMembers: null,
          roleName: role.name
        });
      }

      // Per-organization capacity check
      if (orgKey && orgValue) {
        console.log(`[Role Capacity Check] Performing per-organization check for ${orgKey}=${orgValue}`);
        
        // Find the organization by the uniqueness key
        let orgQuery = supabase.from('organization').select('id, name');
        
        if (orgKey === 'name') {
          orgQuery = orgQuery.eq('name', orgValue);
        } else {
          // For custom fields, search in custom_fields JSONB
          orgQuery = orgQuery.eq(`custom_fields->>${orgKey}`, orgValue);
        }
        
        const { data: orgs, error: orgError } = await orgQuery.limit(1);
        
        if (orgError) {
          console.error('Error finding organization:', orgError);
          return res.status(500).json({ error: 'Failed to find organization' });
        }

        // If organization doesn't exist yet, capacity is available
        if (!orgs || orgs.length === 0) {
          console.log(`[Role Capacity Check] Organization not found - new org, capacity available`);
          return res.json({
            hasCapacity: true,
            currentCount: 0,
            maxMembers: role.max_members,
            roleName: role.name,
            debug: {
              mode: 'per_organization',
              orgKey,
              orgValue,
              organizationFound: false,
              message: 'Organization does not exist yet - capacity available for new org'
            }
          });
        }

        const org = orgs[0];
        console.log(`[Role Capacity Check] Found organization: ${org.id} (${org.name})`);

        // Count active members with this role in THIS organization only
        const { count, error: countError } = await supabase
          .from('member')
          .select('*', { count: 'exact', head: true })
          .eq('role_id', roleId)
          .eq('organization_id', org.id)
          .eq('login_enabled', true);

        if (countError) {
          console.error('Error counting org members:', countError);
          return res.status(500).json({ error: 'Failed to count members' });
        }

        const currentCount = count || 0;
        const hasCapacity = currentCount < role.max_members;

        console.log(`[Role Capacity Check] Org ${org.name}: ${currentCount}/${role.max_members} active ${role.name} members, hasCapacity: ${hasCapacity}`);

        return res.json({
          hasCapacity,
          currentCount,
          maxMembers: role.max_members,
          roleName: role.name,
          debug: {
            mode: 'per_organization',
            orgKey,
            orgValue,
            organizationId: org.id,
            organizationName: org.name,
            organizationFound: true,
            activeMembersWithRoleInOrg: currentCount
          }
        });
      }

      // Global capacity check (fallback - original behavior)
      console.log(`[Role Capacity Check] No org params - performing global check`);
      const capacityResult = await checkRoleCapacity(supabase, roleId);
      console.log(`[Role Capacity Check] Result:`, JSON.stringify(capacityResult));

      // Return capacity info (but don't expose internal error details)
      res.json({
        hasCapacity: capacityResult.hasCapacity,
        currentCount: capacityResult.currentCount,
        maxMembers: capacityResult.maxMembers,
        roleName: capacityResult.roleName || null,
        debug: {
          mode: 'global',
          totalActiveMembersWithRole: capacityResult.currentCount
        }
      });
    } catch (error) {
      console.error('Role capacity check error:', error);
      res.status(500).json({ error: 'Failed to check role capacity' });
    }
  });

  // Public search endpoint for unified content search across multiple content types
  app.get('/api/public/search', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { q, limit = '5' } = req.query;
      
      if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.json({ results: [] });
      }

      const searchTerm = q.trim().toLowerCase();
      const resultLimit = Math.min(parseInt(limit as string) || 5, 20);

      // Prepare search pattern for ilike queries
      const searchPattern = `%${searchTerm}%`;

      // Execute parallel searches across multiple content types
      const [eventsResult, articlesResult, newsResult, resourcesResult, pagesResult] = await Promise.all([
        // Search Events (public, upcoming or published)
        supabase
          .from('event')
          .select('id, title, description, start_date, image_url, is_featured')
          .or(`title.ilike.${searchPattern},description.ilike.${searchPattern}`)
          .gte('start_date', new Date().toISOString())
          .order('start_date', { ascending: true })
          .limit(resultLimit),

        // Search Articles/Blog Posts (published only)
        supabase
          .from('blog_post')
          .select('id, title, summary, feature_image_url, published_date, slug')
          .eq('status', 'published')
          .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern}`)
          .order('published_date', { ascending: false })
          .limit(resultLimit),

        // Search News Posts (published only)
        supabase
          .from('news_post')
          .select('id, title, summary, feature_image_url, published_date, slug')
          .eq('status', 'published')
          .or(`title.ilike.${searchPattern},summary.ilike.${searchPattern}`)
          .order('published_date', { ascending: false })
          .limit(resultLimit),

        // Search Resources (active only, show all resources regardless of member-only status)
        supabase
          .from('resource')
          .select('id, title, description, image_url, resource_type')
          .eq('status', 'active')
          .or(`title.ilike.${searchPattern},description.ilike.${searchPattern}`)
          .order('release_date', { ascending: false })
          .limit(resultLimit),

        // Search CMS Pages (published only)
        supabase
          .from('i_edit_page')
          .select('id, title, slug, description, published_at')
          .eq('status', 'published')
          .or(`title.ilike.${searchPattern},description.ilike.${searchPattern},slug.ilike.${searchPattern}`)
          .order('published_at', { ascending: false })
          .limit(resultLimit)
      ]);

      // Format results with content type tags
      const results: Array<{
        type: string;
        id: string;
        title: string;
        description: string;
        image?: string;
        url: string;
        date?: string;
      }> = [];

      // Add events
      if (eventsResult.data) {
        eventsResult.data.forEach(event => {
          results.push({
            type: 'event',
            id: event.id,
            title: event.title,
            description: stripHtml(event.description)?.substring(0, 150) || '',
            image: event.image_url,
            url: `/EventDetails?id=${event.id}`,
            date: event.start_date
          });
        });
      }

      // Add articles
      if (articlesResult.data) {
        articlesResult.data.forEach(article => {
          results.push({
            type: 'article',
            id: article.id,
            title: article.title,
            description: article.summary?.substring(0, 150) || '',
            image: article.feature_image_url,
            url: `/ArticleView?slug=${article.slug || article.id}`,
            date: article.published_date
          });
        });
      }

      // Add news
      if (newsResult.data) {
        newsResult.data.forEach(news => {
          results.push({
            type: 'news',
            id: news.id,
            title: news.title,
            description: news.summary?.substring(0, 150) || '',
            image: news.feature_image_url,
            url: `/NewsView?slug=${news.slug || news.id}`,
            date: news.published_date
          });
        });
      }

      // Add resources
      if (resourcesResult.data) {
        resourcesResult.data.forEach(resource => {
          results.push({
            type: 'resource',
            id: resource.id,
            title: resource.title,
            description: resource.description?.substring(0, 150) || '',
            image: resource.image_url,
            url: `/ResourceDetails?id=${resource.id}`
          });
        });
      }

      // Add CMS pages
      if (pagesResult.data) {
        pagesResult.data.forEach(page => {
          results.push({
            type: 'page',
            id: page.id,
            title: page.title,
            description: page.description?.substring(0, 150) || '',
            url: `/${page.slug}`,
            date: page.published_at
          });
        });
      }

      res.json({
        results,
        query: searchTerm,
        total: results.length
      });

    } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ error: 'Failed to perform search' });
    }
  });

  // Public endpoint to resolve redirect mappings for legacy URLs
  app.get('/api/redirects/resolve', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { path } = req.query;
      
      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'Path parameter is required' });
      }

      // Original path for preserving case in redirects, normalized for trailing slashes
      const originalPath = (path as string).replace(/\/+$/, '') || '/';
      // Lowercase version for case-insensitive comparisons
      const normalizedPath = originalPath.toLowerCase();

      // Fetch all active redirect mappings ordered by priority
      const { data: mappings, error } = await supabase
        .from('redirect_mapping')
        .select('*')
        .eq('is_active', true)
        .order('priority', { ascending: true });

      if (error) {
        console.error('Error fetching redirect mappings:', error);
        return res.status(500).json({ error: error.message });
      }

      if (!mappings || mappings.length === 0) {
        return res.json({ found: false });
      }

      // Find matching redirect with priority order
      for (const mapping of mappings) {
        // Normalize source pattern: ensure leading slash, remove trailing slashes
        let sourcePattern = (mapping.source_pattern || '').replace(/\/+$/, '') || '/';
        if (sourcePattern !== '/' && !sourcePattern.startsWith('/')) {
          sourcePattern = '/' + sourcePattern;
        }
        const sourcePatternLower = sourcePattern.toLowerCase();
        
        if (mapping.match_type === 'exact') {
          // Exact match (case-insensitive)
          if (normalizedPath === sourcePatternLower) {
            return res.json({
              found: true,
              target_url: mapping.target_url,
              status_code: mapping.status_code || 301
            });
          }
        } else if (mapping.match_type === 'prefix') {
          // Prefix/wildcard match (case-insensitive comparison)
          if (normalizedPath.startsWith(sourcePatternLower)) {
            // Preserve original case in remaining path
            const remainingPath = originalPath.slice(sourcePattern.length);
            let targetUrl = mapping.target_url;
            
            // If target URL ends with *, append the remaining path (preserving case)
            if (targetUrl.endsWith('*')) {
              targetUrl = targetUrl.slice(0, -1) + remainingPath;
            }
            
            return res.json({
              found: true,
              target_url: targetUrl,
              status_code: mapping.status_code || 301
            });
          }
        } else if (mapping.match_type === 'regex') {
          // Regex match (case-insensitive by default)
          try {
            const regex = new RegExp(mapping.source_pattern, 'i');
            if (regex.test(originalPath)) {
              // Use original path for replacement to preserve case
              const targetUrl = originalPath.replace(regex, mapping.target_url);
              return res.json({
                found: true,
                target_url: targetUrl,
                status_code: mapping.status_code || 301
              });
            }
          } catch (regexError) {
            console.warn(`Invalid regex pattern: ${mapping.source_pattern}`, regexError);
            // Skip invalid regex patterns
          }
        }
      }

      // No matching redirect found
      return res.json({ found: false });

    } catch (error) {
      console.error('Redirect resolve error:', error);
      res.status(500).json({ error: 'Failed to resolve redirect' });
    }
  });

  // ============ Auth Routes ============
  
  app.get('/api/auth/me', async (req: Request, res: Response) => {
    if (!req.session.memberId) {
      // Return null for unauthenticated - matches Vercel API format
      return res.status(200).json(null);
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { data, error } = await supabase
        .from('member')
        .select('*')
        .eq('id', req.session.memberId)
        .single();

      if (error || !data) {
        // Return null for user not found - matches Vercel API format
        return res.status(200).json(null);
      }

      // Fetch role to determine permissions via feature exclusions
      let canEditMembers = false;
      let canManageCommunications = false;
      let excludedFeatures: string[] = [];
      
      if (data.role_id) {
        const { data: role } = await supabase
          .from('role')
          .select('excluded_features')
          .eq('id', data.role_id)
          .single();
        
        excludedFeatures = role?.excluded_features || [];
        
        // Check if permissions are NOT in excluded_features (meaning they have access)
        canEditMembers = !excludedFeatures.includes('admin_can_edit_members');
        canManageCommunications = !excludedFeatures.includes('admin_can_manage_communications');
      }

      // Return member with permission flags and excluded_features for client-side access control
      res.json({ ...data, excludedFeatures, canEditMembers, canManageCommunications });
    } catch (error) {
      console.error('Auth me error:', error);
      res.status(500).json({ error: 'Failed to get user' });
    }
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('[Auth Logout] Session destroy error:', err);
        return res.status(500).json({ error: 'Failed to logout' });
      }
      // Clear the session cookie with the correct name matching our session config
      res.clearCookie('iconnect.sid');
      res.json({ success: true });
    });
  });

  // ============ Form Uniqueness Validation ============
  
  // Helper to extract domain from email or URL
  // Returns lowercase domain or null if extraction fails
  const extractDomain = (value: string): string | null => {
    if (!value || typeof value !== 'string') return null;
    
    const trimmed = value.trim().toLowerCase();
    
    // Check if it's an email address (contains @)
    if (trimmed.includes('@')) {
      const parts = trimmed.split('@');
      if (parts.length === 2 && parts[1]) {
        return parts[1];
      }
      return null;
    }
    
    // Try to extract domain from URL
    try {
      let urlStr = trimmed;
      // Add protocol if missing for URL parsing
      if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        urlStr = 'https://' + urlStr;
      }
      const url = new URL(urlStr);
      let hostname = url.hostname;
      // Remove www. prefix
      if (hostname.startsWith('www.')) {
        hostname = hostname.substring(4);
      }
      return hostname || null;
    } catch (e) {
      // If URL parsing fails, try simple extraction
      let cleaned = trimmed
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        .split('?')[0];
      return cleaned || null;
    }
  };
  
  // Valid target fields whitelist for uniqueness checks
  const VALID_UNIQUENESS_TARGETS: Record<string, string[]> = {
    member: ['email', 'full_name', 'phone'],
    organization: ['name', 'invoicing_email', 'phone', 'website_url']
  };
  
  // Validates form fields for uniqueness against Member/Organization tables and existing form submissions
  // Supports new target_field and comparison_mode structure
  app.post('/api/forms/validate-uniqueness', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const { uniqueness_checks, form_values, fields, form_id } = req.body;

      if (!Array.isArray(uniqueness_checks) || uniqueness_checks.length === 0) {
        return res.json({ valid: true, conflicts: [] });
      }
      
      console.log('[Form Uniqueness] Received uniqueness_checks:', JSON.stringify(uniqueness_checks, null, 2));
      
      if (!form_values || typeof form_values !== 'object') {
        return res.status(400).json({ error: 'Invalid form_values' });
      }
      
      if (!Array.isArray(fields)) {
        return res.status(400).json({ error: 'Invalid fields array' });
      }

      const conflicts: Array<{ field_id: string; field_label: string; message: string }> = [];
      
      const validFieldIds = new Set(fields.filter((f: any) => f && f.id).map((f: any) => f.id));
      const sanitizedChecks = uniqueness_checks.filter(
        (c: any) => c && typeof c === 'object' && c.field_id && validFieldIds.has(c.field_id)
      );

      for (const check of sanitizedChecks) {
        const { field_id, target_field, comparison_mode } = check;
        
        const field = fields.find((f: any) => f && f.id === field_id);
        if (!field) continue;

        const value = form_values[field_id];
        if (!value) continue;

        // Parse target_field (e.g., "member.email" or "organization.name")
        if (!target_field || !target_field.includes('.')) {
          console.log(`[Form Uniqueness] Skipping check for ${field_id}: invalid target_field`, target_field);
          continue;
        }

        const [targetEntity, targetColumn] = target_field.split('.');
        const tableName = targetEntity === 'organization' ? 'organization' : 'member';
        
        // Validate target column against whitelist
        const validColumns = VALID_UNIQUENESS_TARGETS[tableName];
        if (!validColumns || !validColumns.includes(targetColumn)) {
          console.log(`[Form Uniqueness] Skipping check for ${field_id}: invalid column ${targetColumn} for ${tableName}`);
          continue;
        }
        
        // Validate domain_equals is only used with email columns
        const emailColumns = ['email', 'invoicing_email'];
        if (comparison_mode === 'domain_equals' && !emailColumns.includes(targetColumn)) {
          console.log(`[Form Uniqueness] Skipping domain_equals for non-email column ${targetColumn}`);
          continue;
        }
        
        let searchValue = String(value).trim();
        const mode = comparison_mode || 'equals_lowercase';

        // Apply comparison logic
        let query;
        switch (mode) {
          case 'equals':
            query = supabase.from(tableName).select('id').eq(targetColumn, searchValue).limit(1);
            break;
          case 'equals_lowercase':
            query = supabase.from(tableName).select('id').ilike(targetColumn, searchValue).limit(1);
            break;
          case 'contains':
            query = supabase.from(tableName).select('id').ilike(targetColumn, `%${searchValue}%`).limit(1);
            break;
          case 'starts_with':
            query = supabase.from(tableName).select('id').ilike(targetColumn, `${searchValue}%`).limit(1);
            break;
          case 'ends_with':
            query = supabase.from(tableName).select('id').ilike(targetColumn, `%${searchValue}`).limit(1);
            break;
          case 'domain_equals':
            const extractedDomain = extractDomain(searchValue);
            if (extractedDomain) {
              console.log(`[Form Uniqueness] domain_equals: checking ${tableName}.${targetColumn} for domain ${extractedDomain} (from: ${searchValue})`);
              // Query emails that end with @domain
              query = supabase.from(tableName).select('id').ilike(targetColumn, `%@${extractedDomain}`).limit(1);
            } else {
              console.log(`[Form Uniqueness] domain_equals: skipping - could not extract domain from: ${searchValue}`);
              continue;
            }
            break;
          default:
            query = supabase.from(tableName).select('id').ilike(targetColumn, searchValue).limit(1);
        }

        const { data, error } = await query;
        
        console.log(`[Form Uniqueness] Query result for ${field_id} on ${tableName}.${targetColumn} (mode: ${mode}):`, { data, error, hasConflict: data && data.length > 0 });

        if (error) {
          console.error(`[Form Uniqueness] Error checking ${field_id} in ${tableName}.${targetColumn}:`, error);
        } else if (data && data.length > 0) {
          const entityLabel = tableName === 'organization' ? 'an organisation' : 'a member';
          const modeLabel = mode === 'domain_equals' ? 'email domain' : 'value';
          conflicts.push({
            field_id,
            field_label: field.label || field_id,
            message: `We already have ${entityLabel} registered with this ${modeLabel}. Please contact us if you believe this is an error.`
          });
          continue;
        }

        // Check against existing form submissions
        if (form_id) {
          const originalValue = String(form_values[field_id]).trim();
          
          const { data: submissions, error: subError } = await supabase
            .from('form_submission')
            .select('id, submission_data')
            .eq('form_id', form_id)
            .not('submission_data', 'is', null)
            .limit(100);

          if (subError) {
            console.error(`[Form Uniqueness] Error checking form_submission:`, subError);
          } else if (submissions && submissions.length > 0) {
            let foundConflict = false;
            
            for (const sub of submissions) {
              if (foundConflict) break;
              
              const subData = sub.submission_data || {};
              const subValue = subData[field_id];
              if (!subValue) continue;
              
              let subValueStr = String(subValue).trim();
              let compareValue = originalValue;
              
              let matches = false;
              switch (mode) {
                case 'equals':
                  matches = subValueStr === compareValue;
                  break;
                case 'equals_lowercase':
                  matches = subValueStr.toLowerCase() === compareValue.toLowerCase();
                  break;
                case 'contains':
                  matches = subValueStr.toLowerCase().includes(compareValue.toLowerCase());
                  break;
                case 'starts_with':
                  matches = subValueStr.toLowerCase().startsWith(compareValue.toLowerCase());
                  break;
                case 'ends_with':
                  matches = subValueStr.toLowerCase().endsWith(compareValue.toLowerCase());
                  break;
                case 'domain_equals':
                  const subDomain = extractDomain(subValueStr);
                  const compareDomain = extractDomain(compareValue);
                  matches = !!(subDomain && compareDomain && subDomain === compareDomain);
                  break;
                default:
                  matches = subValueStr.toLowerCase() === compareValue.toLowerCase();
              }
              
              if (matches) {
                conflicts.push({
                  field_id,
                  field_label: field.label || field_id,
                  message: 'This value has already been submitted in a previous application'
                });
                foundConflict = true;
              }
            }
          }
        }
      }

      return res.json({
        valid: conflicts.length === 0,
        conflicts
      });
    } catch (error) {
      console.error('[Form Uniqueness] Validation error:', error);
      res.status(500).json({ error: 'Failed to validate uniqueness' });
    }
  });

  // ============ Form Field Mapping to Custom Fields (CRM) ============
  
  // Process form field mappings after form submission
  // This updates MemberPreferenceValue or OrgPreferenceValue based on field mappings
  // Security: Uses session-based member/org IDs, not request body
  app.post('/api/forms/process-field-mappings', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    // Require authentication - get member/org IDs from session
    const memberId = (req.session as any)?.memberId;
    if (!memberId) {
      return res.status(401).json({ error: 'Authentication required for field mappings' });
    }

    try {
      // Fetch member to get organization_id
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id, organization_id')
        .eq('id', memberId)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const { 
        form_values,     // The submitted form values { field_id: value }
        fields           // The form field definitions with custom_field_id mappings
      } = req.body;

      if (!form_values || typeof form_values !== 'object') {
        return res.status(400).json({ error: 'Invalid request: form_values is required' });
      }
      
      if (!fields || !Array.isArray(fields)) {
        return res.status(400).json({ error: 'Invalid request: fields array is required' });
      }

      const results = {
        member_updates: [] as string[],
        organization_updates: [] as string[],
        errors: [] as string[]
      };

      // Get all preference field definitions
      const { data: preferenceFields, error: prefError } = await supabase
        .from('preference_field')
        .select('*')
        .eq('is_active', true);

      if (prefError) {
        console.error('[Field Mapping] Error fetching preference fields:', prefError);
        return res.status(500).json({ error: 'Failed to fetch preference field definitions' });
      }

      const prefFieldMap = new Map((preferenceFields || []).map(pf => [pf.id, pf]));

      // Process each field that has a custom_field_id mapping
      for (const field of fields) {
        if (!field.custom_field_id) continue;

        const customField = prefFieldMap.get(field.custom_field_id);
        if (!customField) {
          console.warn(`[Field Mapping] Custom field ${field.custom_field_id} not found`);
          continue;
        }

        const formValue = form_values[field.id];
        if (formValue === undefined || formValue === null || formValue === '') continue;

        // Convert value to appropriate format for storage
        let storedValue = formValue;
        if (customField.field_type === 'picklist' && Array.isArray(formValue)) {
          storedValue = JSON.stringify(formValue);
        } else if (typeof formValue === 'object') {
          storedValue = JSON.stringify(formValue);
        } else {
          storedValue = String(formValue);
        }

        const entityScope = customField.entity_scope || 'member';

        if (entityScope === 'member') {
          // Handle member preference value
          const { data: existing } = await supabase
            .from('member_preference_value')
            .select('id')
            .eq('member_id', member.id)
            .eq('field_id', customField.id)
            .maybeSingle();

          if (existing) {
            // Update existing
            const { error: updateError } = await supabase
              .from('member_preference_value')
              .update({ value: storedValue, updated_at: new Date().toISOString() })
              .eq('id', existing.id);
            
            if (updateError) {
              results.errors.push(`Failed to update ${customField.label}: ${updateError.message}`);
            } else {
              results.member_updates.push(customField.label);
            }
          } else {
            // Create new
            const { error: createError } = await supabase
              .from('member_preference_value')
              .insert({
                member_id: member.id,
                field_id: customField.id,
                value: storedValue
              });
            
            if (createError) {
              results.errors.push(`Failed to create ${customField.label}: ${createError.message}`);
            } else {
              results.member_updates.push(customField.label);
            }
          }
        } else if (entityScope === 'organization' && member.organization_id) {
          // Handle organization preference value
          const { data: existing } = await supabase
            .from('organization_preference_value')
            .select('id')
            .eq('organization_id', member.organization_id)
            .eq('field_id', customField.id)
            .maybeSingle();

          if (existing) {
            // Update existing
            const { error: updateError } = await supabase
              .from('organization_preference_value')
              .update({ value: storedValue, updated_at: new Date().toISOString() })
              .eq('id', existing.id);
            
            if (updateError) {
              results.errors.push(`Failed to update ${customField.label}: ${updateError.message}`);
            } else {
              results.organization_updates.push(customField.label);
            }
          } else {
            // Create new
            const { error: createError } = await supabase
              .from('organization_preference_value')
              .insert({
                organization_id: member.organization_id,
                field_id: customField.id,
                value: storedValue
              });
            
            if (createError) {
              results.errors.push(`Failed to create ${customField.label}: ${createError.message}`);
            } else {
              results.organization_updates.push(customField.label);
            }
          }
        } else if (entityScope === 'organization' && !member.organization_id) {
          // Skip if member has no organization
          console.log(`[Field Mapping] Skipping ${customField.label} - member has no organization_id`);
        }
      }

      console.log('[Field Mapping] Results:', results);
      return res.json({
        success: true,
        results
      });
    } catch (error) {
      console.error('[Field Mapping] Error processing mappings:', error);
      res.status(500).json({ error: 'Failed to process field mappings' });
    }
  });

  // ============ Application Processor - Entity Creation from Form Submissions ============
  
  // Helper function to apply value transformations
  const applyTransformation = (value: any, transformation: string): any => {
    if (value === null || value === undefined) return value;
    const strValue = String(value);
    
    switch (transformation) {
      case 'trim':
        return strValue.trim();
      case 'uppercase':
        return strValue.toUpperCase();
      case 'lowercase':
        return strValue.toLowerCase();
      case 'titlecase':
        return strValue.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
      case 'extract_domain':
        // Extract domain from email (after @)
        if (strValue.includes('@')) {
          return strValue.split('@')[1] || strValue;
        }
        return strValue;
      case 'extract_username':
        // Extract username from email (before @)
        if (strValue.includes('@')) {
          return strValue.split('@')[0] || strValue;
        }
        return strValue;
      case 'first_word':
        return strValue.trim().split(/\s+/)[0] || strValue;
      case 'last_word':
        const words = strValue.trim().split(/\s+/);
        return words[words.length - 1] || strValue;
      case 'remove_spaces':
        return strValue.replace(/\s+/g, '');
      case 'numbers_only':
        return strValue.replace(/[^0-9]/g, '');
      case 'none':
      default:
        return strValue;
    }
  };

  // Process application form submission and create member/organization entities
  // This is called when auto_create_entity is true or when admin approves an application
  app.post('/api/forms/process-application', async (req: Request, res: Response) => {
    console.log('[AppProcessor] ============ PROCESS-APPLICATION CALLED ============');
    
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { 
        form_id,
        form_values,     // The submitted form values { field_id: value }
        fields,          // The form field definitions with core_field_mapping and custom_field_id
        field_mappings,  // New: array of {source_field_id, target_type, target_entity, target_field, transformation}
        application_level, // 'member' or 'organization' (legacy, for backward compatibility)
        member_entity_action = 'none',     // 'none', 'create', 'update', 'upsert'
        organization_entity_action = 'none', // 'none', 'create', 'update', 'upsert'
        submission_id,   // Optional: link back to FormSubmission record
        prefill_organization_id,  // Optional: organization ID from prefill source (for linking new members)
        role_id,         // Optional: role ID from form conditional logic (set_role action)
        entity_pipelines // Unified entity pipelines configuration with login_enabled settings
      } = req.body;
      
      // Extract login_enabled from primary member entity pipeline (defaults to true if not specified)
      const primaryMemberConfig = entity_pipelines?.members?.find((m: any) => m.isPrimary) || entity_pipelines?.members?.[0];
      const memberLoginEnabled = primaryMemberConfig?.login_enabled !== false;

      if (!form_values || typeof form_values !== 'object') {
        return res.status(400).json({ error: 'form_values is required' });
      }
      
      if (!fields || !Array.isArray(fields)) {
        return res.status(400).json({ error: 'fields array is required' });
      }

      // Validate entity action values
      const validActions = ['none', 'create', 'update', 'upsert'];
      const memberAction = validActions.includes(member_entity_action) ? member_entity_action : 'none';
      const orgAction = validActions.includes(organization_entity_action) ? organization_entity_action : 'none';
      
      console.log('[AppProcessor] Entity actions - member:', memberAction, 'organization:', orgAction);
      console.log('[AppProcessor] Received role_id:', role_id, 'type:', typeof role_id);
      console.log('[AppProcessor] Member login_enabled:', memberLoginEnabled, '(from entity_pipelines:', !!entity_pipelines, ')');

      // Idempotency check: if submission_id provided, check if already processed
      if (submission_id) {
        const { data: existingSubmission } = await supabase
          .from('form_submission')
          .select('created_member_id, created_organization_id, processed_at')
          .eq('id', submission_id)
          .single();

        if (existingSubmission?.processed_at) {
          console.log('[AppProcessor] Submission already processed:', submission_id);
          return res.json({
            success: true,
            already_processed: true,
            created_member_id: existingSubmission.created_member_id,
            created_organization_id: existingSubmission.created_organization_id
          });
        }
      }

      // Extract mapped values from form submission
      const memberData: Record<string, any> = {};
      const orgData: Record<string, any> = {};
      const memberCustomFields: Array<{field_id: string, value: string}> = [];
      const orgCustomFields: Array<{field_id: string, value: string}> = [];

      // Get all preference field definitions for custom field processing
      const { data: preferenceFields } = await supabase
        .from('preference_field')
        .select('*')
        .eq('is_active', true);

      const prefFieldMap = new Map((preferenceFields || []).map((pf: any) => [pf.id, pf]));

      // Process new field_mappings array first (preferred method)
      if (field_mappings && Array.isArray(field_mappings) && field_mappings.length > 0) {
        console.log('[AppProcessor] Using field_mappings:', field_mappings.length, 'mappings');
        
        for (const mapping of field_mappings) {
          const { source_field_id, target_type, target_entity, target_field, transformation } = mapping;
          if (!source_field_id || !target_field) continue;
          
          let value = form_values[source_field_id];
          if (value === undefined || value === null || value === '') continue;
          
          // Apply transformation
          if (transformation && transformation !== 'none') {
            value = applyTransformation(value, transformation);
          }
          
          if (target_type === 'core') {
            // Core field mapping
            if (target_entity === 'member') {
              memberData[target_field] = value;
            } else if (target_entity === 'organization') {
              orgData[target_field] = value;
            }
          } else if (target_type === 'custom') {
            // Custom field mapping
            let storedValue = value;
            if (Array.isArray(value)) {
              storedValue = JSON.stringify(value);
            } else if (typeof value === 'object') {
              storedValue = JSON.stringify(value);
            } else {
              storedValue = String(value);
            }
            
            if (target_entity === 'organization') {
              orgCustomFields.push({ field_id: target_field, value: storedValue });
            } else {
              memberCustomFields.push({ field_id: target_field, value: storedValue });
            }
          }
        }
      } else {
        // Fallback: Use legacy core_field_mapping and custom_field_id on fields
        for (const field of fields) {
          const value = form_values[field.id];
          if (value === undefined || value === null || value === '') continue;

          // Process core field mappings
          if (field.core_field_mapping) {
            const [entity, fieldName] = field.core_field_mapping.split('.');
            if (entity === 'member') {
              memberData[fieldName] = value;
            } else if (entity === 'organization') {
              orgData[fieldName] = value;
            }
          }

          // Process custom field mappings
          if (field.custom_field_id) {
            const customField = prefFieldMap.get(field.custom_field_id);
            if (customField) {
              let storedValue = value;
              if (Array.isArray(value)) {
                storedValue = JSON.stringify(value);
              } else if (typeof value === 'object') {
                storedValue = JSON.stringify(value);
              } else {
                storedValue = String(value);
              }

              if (customField.entity_scope === 'organization') {
                orgCustomFields.push({ field_id: customField.id, value: storedValue });
              } else {
                memberCustomFields.push({ field_id: customField.id, value: storedValue });
              }
            }
          }
          
          // Category multiselect fields are handled separately via member_resource_category join table
          // Skip preference_field_id processing for category fields - they're saved after member creation
          if (field.type !== 'category_multiselect' && field.type !== 'resource_categories') {
            // Process preference_field_id for non-category fields only
            const targetPrefFieldId = field.preference_field_id;
            
            if (targetPrefFieldId) {
              const preferenceField = prefFieldMap.get(targetPrefFieldId);
              if (preferenceField) {
                let storedValue = value;
                if (Array.isArray(value)) {
                  storedValue = JSON.stringify(value);
                } else if (typeof value === 'object') {
                  storedValue = JSON.stringify(value);
                } else {
                  storedValue = String(value);
                }

                if (preferenceField.entity_scope === 'organization') {
                  orgCustomFields.push({ field_id: preferenceField.id, value: storedValue });
                } else {
                  memberCustomFields.push({ field_id: preferenceField.id, value: storedValue });
                }
              }
            }
          }
        }
      }

      console.log('[AppProcessor] Extracted data:', { memberData, orgData, memberCustomFields: memberCustomFields.length, orgCustomFields: orgCustomFields.length });

      let createdOrganizationId: string | null = null;
      let createdMemberId: string | null = null;

      // Process organization based on organization_entity_action
      if (orgAction !== 'none' && (Object.keys(orgData).length > 0 || orgAction === 'create')) {
        // Check for existing organization by name or invoicing email domain
        let existingOrg: any = null;
        if (orgData.name) {
          const { data: foundOrg } = await supabase
            .from('organization')
            .select('*')
            .ilike('name', orgData.name)
            .limit(1)
            .single();
          existingOrg = foundOrg;
        }
        
        if (existingOrg) {
          // Organization exists
          if (orgAction === 'create') {
            // Create mode but org exists - skip or fail
            console.log('[AppProcessor] Organization exists, skipping create (create mode):', existingOrg.id);
            createdOrganizationId = existingOrg.id;
          } else if (orgAction === 'update' || orgAction === 'upsert') {
            // Update existing organization
            const updateData: Record<string, any> = {};
            if (orgData.invoicing_email) updateData.invoicing_email = orgData.invoicing_email;
            if (orgData.phone) updateData.phone = orgData.phone;
            if (orgData.website_url) updateData.website_url = orgData.website_url;
            
            if (Object.keys(updateData).length > 0) {
              const { error: updateError } = await supabase
                .from('organization')
                .update(updateData)
                .eq('id', existingOrg.id);
              
              if (updateError) {
                console.error('[AppProcessor] Failed to update organization:', updateError);
              } else {
                console.log('[AppProcessor] Updated organization:', existingOrg.id);
              }
            }
            createdOrganizationId = existingOrg.id;
          }
        } else {
          // Organization does not exist
          if (orgAction === 'update') {
            // Update mode but org doesn't exist - skip
            console.log('[AppProcessor] Organization not found, skipping update (update mode)');
          } else if (orgAction === 'create' || orgAction === 'upsert') {
            // Create new organization
            const orgInsertData = {
              name: orgData.name || 'New Organisation',
              invoicing_email: orgData.invoicing_email || null,
              phone: orgData.phone || null,
              website_url: orgData.website_url || null,
              status: 'active',
              created_at: new Date().toISOString()
            };

            const { data: newOrg, error: orgError } = await supabase
              .from('organization')
              .insert(orgInsertData)
              .select()
              .single();

            if (orgError) {
              console.error('[AppProcessor] Failed to create organization:', orgError);
              return res.status(500).json({ error: `Failed to create organisation: ${orgError.message}` });
            }

            createdOrganizationId = newOrg.id;
            console.log('[AppProcessor] Created organization:', createdOrganizationId);
          }
        }

        // Handle org custom field values (upsert pattern)
        if (createdOrganizationId) {
          for (const cf of orgCustomFields) {
            // Check if value exists
            const { data: existingValue } = await supabase
              .from('organization_preference_value')
              .select('id')
              .eq('organization_id', createdOrganizationId)
              .eq('field_id', cf.field_id)
              .single();
            
            if (existingValue) {
              await supabase
                .from('organization_preference_value')
                .update({ value: cf.value })
                .eq('id', existingValue.id);
            } else {
              await supabase.from('organization_preference_value').insert({
                organization_id: createdOrganizationId,
                field_id: cf.field_id,
                value: cf.value
              });
            }
          }
        }
      }

      // Process member based on member_entity_action
      if (memberAction !== 'none' && (memberData.email || memberAction === 'create')) {
        // Check for existing member by email
        let existingMember: any = null;
        if (memberData.email) {
          const { data: foundMember } = await supabase
            .from('member')
            .select('*')
            .ilike('email', memberData.email)
            .limit(1)
            .single();
          existingMember = foundMember;
        }

        if (existingMember) {
          // Member exists
          if (memberAction === 'create') {
            // Create mode but member exists - skip
            console.log('[AppProcessor] Member exists, skipping create (create mode):', existingMember.id);
            createdMemberId = existingMember.id;
          } else if (memberAction === 'update' || memberAction === 'upsert') {
            // Update existing member
            const updateData: Record<string, any> = {};
            if (memberData.first_name) updateData.first_name = memberData.first_name;
            if (memberData.last_name) updateData.last_name = memberData.last_name;
            // Parse full_name into first/last name if provided (member table doesn't have full_name column)
            if (memberData.full_name && !memberData.first_name && !memberData.last_name) {
              const nameParts = memberData.full_name.trim().split(/\s+/);
              updateData.first_name = nameParts[0] || '';
              updateData.last_name = nameParts.slice(1).join(' ') || '';
            }
            if (memberData.job_title) updateData.job_title = memberData.job_title;
            if (memberData.mobile) updateData.mobile = memberData.mobile;
            if (memberData.landline) updateData.landline = memberData.landline;
            // Add role_id if triggered from form conditional logic (null clears the role)
            if (role_id !== undefined) {
              // Check role capacity before updating to a new role (only if changing to a different role)
              // Uses per-organization capacity based on the member's organization
              if (role_id !== null && role_id !== existingMember.role_id) {
                const memberOrgId = createdOrganizationId || prefill_organization_id || existingMember.organization_id;
                const capacityCheck = await checkRoleCapacity(supabase, role_id, memberOrgId);
                console.log('[AppProcessor] Role capacity check result (update):', JSON.stringify(capacityCheck));
                if (capacityCheck.error) {
                  console.error('[AppProcessor] Role capacity check error:', capacityCheck.error);
                }
                if (!capacityCheck.hasCapacity) {
                  console.error('[AppProcessor] Role at max capacity:', capacityCheck.currentCount, '/', capacityCheck.maxMembers);
                  return res.status(400).json({ 
                    error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members${capacityCheck.mode === 'per_organization' ? ' for this organization' : ''}. Please contact an administrator.`,
                    code: 'ROLE_CAPACITY_EXCEEDED'
                  });
                }
              }
              updateData.role_id = role_id;
            }
            // Use createdOrganizationId if org was created/updated, otherwise use prefill_organization_id
            const orgIdToLink = createdOrganizationId || prefill_organization_id;
            if (orgIdToLink) updateData.organization_id = orgIdToLink;
            
            if (Object.keys(updateData).length > 0) {
              const { error: updateError } = await supabase
                .from('member')
                .update(updateData)
                .eq('id', existingMember.id);
              
              if (updateError) {
                console.error('[AppProcessor] Failed to update member:', updateError);
              } else {
                console.log('[AppProcessor] Updated member:', existingMember.id);
              }
            }
            createdMemberId = existingMember.id;
          }
        } else {
          // Member does not exist
          if (memberAction === 'update') {
            // Update mode but member doesn't exist - skip
            console.log('[AppProcessor] Member not found, skipping update (update mode)');
          } else if (memberAction === 'create' || memberAction === 'upsert') {
            // Handle full_name split if no first/last name provided
            if (memberData.full_name && !memberData.first_name && !memberData.last_name) {
              const nameParts = memberData.full_name.trim().split(/\s+/);
              memberData.first_name = nameParts[0] || '';
              memberData.last_name = nameParts.slice(1).join(' ') || '';
            }

            // Use createdOrganizationId if org was created/updated, otherwise use prefill_organization_id
            const orgIdForNewMember = createdOrganizationId || prefill_organization_id || null;
            
            const memberInsertData: any = {
              email: (memberData.email || `pending-${Date.now()}@example.com`).toLowerCase(),
              first_name: memberData.first_name || '',
              last_name: memberData.last_name || '',
              organization_id: orgIdForNewMember,
              login_enabled: memberLoginEnabled,
              created_on: new Date().toISOString()
            };
            // Add optional fields if provided
            if (memberData.job_title) memberInsertData.job_title = memberData.job_title;
            if (memberData.mobile) memberInsertData.mobile = memberData.mobile;
            if (memberData.landline) memberInsertData.landline = memberData.landline;
            // Add role_id if triggered from form conditional logic (null clears the role)
            if (role_id !== undefined) {
              memberInsertData.role_id = role_id;
              console.log('[AppProcessor] Adding role_id to member insert:', role_id);
              
              // Check role capacity before inserting member
              // Uses per-organization capacity based on the member's organization
              if (role_id !== null) {
                const capacityCheck = await checkRoleCapacity(supabase, role_id, orgIdForNewMember);
                console.log('[AppProcessor] Role capacity check result:', JSON.stringify(capacityCheck));
                if (capacityCheck.error) {
                  console.error('[AppProcessor] Role capacity check error:', capacityCheck.error);
                  // Still enforce capacity if we got count info despite error
                } 
                if (!capacityCheck.hasCapacity) {
                  console.error('[AppProcessor] Role at max capacity:', capacityCheck.currentCount, '/', capacityCheck.maxMembers);
                  return res.status(400).json({ 
                    error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members${capacityCheck.mode === 'per_organization' ? ' for this organization' : ''}. Please contact an administrator.`,
                    code: 'ROLE_CAPACITY_EXCEEDED'
                  });
                }
              }
            } else {
              console.log('[AppProcessor] role_id is undefined, not adding to member insert');
            }

            console.log('[AppProcessor] Final memberInsertData:', JSON.stringify(memberInsertData));

            const { data: newMember, error: memberError } = await supabase
              .from('member')
              .insert(memberInsertData)
              .select()
              .single();

            if (memberError) {
              console.error('[AppProcessor] Failed to create member:', memberError);
              return res.status(500).json({ error: `Failed to create member: ${memberError.message}` });
            }

            createdMemberId = newMember.id;
            console.log('[AppProcessor] Created member:', createdMemberId);
          }
        }

        // Handle member custom field values (upsert pattern)
        if (createdMemberId) {
          for (const cf of memberCustomFields) {
            // Check if value exists
            const { data: existingValue } = await supabase
              .from('member_preference_value')
              .select('id')
              .eq('member_id', createdMemberId)
              .eq('field_id', cf.field_id)
              .single();
            
            if (existingValue) {
              await supabase
                .from('member_preference_value')
                .update({ value: cf.value })
                .eq('id', existingValue.id);
            } else {
              await supabase.from('member_preference_value').insert({
                member_id: createdMemberId,
                field_id: cf.field_id,
                value: cf.value
              });
            }
          }

          // Handle category_multiselect field values - save to member_resource_category table
          const categoryFields = fields.filter((f: any) => f.type === 'category_multiselect' || f.type === 'resource_categories');
          if (categoryFields.length > 0) {
            // Get all resource categories to map subcategory names to category IDs
            const { data: resourceCategories } = await supabase
              .from('resource_category')
              .select('id, name, subcategories')
              .eq('is_active', true);
            
            // Parse subcategories that might be stored as JSON strings and normalize
            const categoryMap = new Map((resourceCategories || []).map((c: any) => {
              let subcats = c.subcategories || [];
              // Handle case where subcategories is stored as JSON string
              if (typeof subcats === 'string') {
                try {
                  subcats = JSON.parse(subcats);
                } catch {
                  subcats = [];
                }
              }
              // Ensure it's an array and trim all values
              if (!Array.isArray(subcats)) subcats = [];
              subcats = subcats.map((s: any) => String(s).trim()).filter(Boolean);
              return [c.id, subcats];
            }));
            
            // Build set of category IDs affected by the form fields
            const formCategoryIds = new Set<string>();
            for (const field of categoryFields) {
              const allowedCatIds = field.allowed_category_ids?.length > 0 
                ? field.allowed_category_ids 
                : Array.from(categoryMap.keys());
              allowedCatIds.forEach((id: string) => formCategoryIds.add(id));
            }
            
            // Build list of category selections from all category_multiselect fields
            const categorySelections: Array<{category_id: string, subcategory_name: string | null}> = [];
            
            for (const field of categoryFields) {
              const selectedValues = form_values[field.id];
              if (!Array.isArray(selectedValues) || selectedValues.length === 0) continue;
              
              // Get allowed categories for this field (or all if not specified)
              const allowedCategoryIds = field.allowed_category_ids?.length > 0 
                ? field.allowed_category_ids 
                : Array.from(categoryMap.keys());
              
              // Map selected subcategory names to their parent category IDs
              for (const subcatName of selectedValues) {
                const normalizedSubcat = String(subcatName).trim();
                // Find which category this subcategory belongs to
                for (const catId of allowedCategoryIds) {
                  const subcats = categoryMap.get(catId);
                  if (subcats && subcats.includes(normalizedSubcat)) {
                    categorySelections.push({
                      category_id: catId,
                      subcategory_name: normalizedSubcat
                    });
                    break;
                  }
                }
              }
            }
            
            // Get current selections for diff-based update (always do this, even for empty submissions)
            const { data: currentSelections } = await supabase
              .from('member_resource_category')
              .select('id, resource_category_id, subcategory_name')
              .eq('member_id', createdMemberId);
            
            const existing = currentSelections || [];
            const currentKeys = new Set(
              existing.map((s: any) => `${s.resource_category_id}|${s.subcategory_name || ''}`)
            );
            const newKeys = new Set(
              categorySelections.map(s => `${s.category_id}|${s.subcategory_name || ''}`)
            );
            
            // Find selections to add
            const toAdd = categorySelections.filter(s => 
              !currentKeys.has(`${s.category_id}|${s.subcategory_name || ''}`)
            );
            
            // Find selections to remove (only remove if in the same categories as the form fields)
            const toRemove = existing.filter((s: any) => 
              formCategoryIds.has(s.resource_category_id) && 
              !newKeys.has(`${s.resource_category_id}|${s.subcategory_name || ''}`)
            );
            
            // Remove old selections (including when form submits empty to clear selections)
            if (toRemove.length > 0) {
              const removeIds = toRemove.map((s: any) => s.id);
              await supabase
                .from('member_resource_category')
                .delete()
                .in('id', removeIds);
              console.log(`[AppProcessor] Removed ${toRemove.length} category selections`);
            }
            
            // Add new selections
            if (toAdd.length > 0) {
              const insertData = toAdd.map(sel => ({
                member_id: createdMemberId,
                resource_category_id: sel.category_id,
                subcategory_name: sel.subcategory_name
              }));
              
              await supabase
                .from('member_resource_category')
                .insert(insertData);
              console.log(`[AppProcessor] Added ${toAdd.length} category selections`);
            }
          }

          // Handle communication_preferences field values - save to member_communication_preference table
          const commPrefFields = fields.filter((f: any) => f.type === 'communication_preferences');
          if (commPrefFields.length > 0) {
            console.log(`[AppProcessor] Processing ${commPrefFields.length} communication preference fields`);
            
            // Fetch all active communication categories to ensure all are saved
            const { data: allCommCategories } = await supabase
              .from('communication_category')
              .select('id')
              .eq('is_active', true);
            
            const allCategoryIds = new Set((allCommCategories || []).map((c: any) => c.id));
            
            // Collect all communication preference selections from form values
            const commPrefSelections: Array<{category_id: string, is_subscribed: boolean}> = [];
            const processedCategoryIds = new Set<string>();
            
            for (const field of commPrefFields) {
              const prefValues = form_values[field.id];
              if (prefValues && typeof prefValues === 'object') {
                // prefValues is an object: { categoryId: boolean }
                for (const [categoryId, isSubscribed] of Object.entries(prefValues)) {
                  if (!processedCategoryIds.has(categoryId)) {
                    commPrefSelections.push({
                      category_id: categoryId,
                      is_subscribed: isSubscribed !== false
                    });
                    processedCategoryIds.add(categoryId);
                  }
                }
              }
            }
            
            // Add any missing categories with default subscribed=true
            for (const categoryId of allCategoryIds) {
              if (!processedCategoryIds.has(categoryId)) {
                commPrefSelections.push({
                  category_id: categoryId,
                  is_subscribed: true
                });
              }
            }
            
            if (commPrefSelections.length > 0) {
              console.log(`[AppProcessor] Saving ${commPrefSelections.length} communication preferences for member:`, createdMemberId);
              
              // Upsert each communication preference
              for (const pref of commPrefSelections) {
                // Check if preference already exists
                const { data: existingPref } = await supabase
                  .from('member_communication_preference')
                  .select('id')
                  .eq('member_id', createdMemberId)
                  .eq('category_id', pref.category_id)
                  .single();
                
                if (existingPref) {
                  // Update existing preference
                  await supabase
                    .from('member_communication_preference')
                    .update({ is_subscribed: pref.is_subscribed })
                    .eq('id', existingPref.id);
                } else {
                  // Insert new preference
                  await supabase
                    .from('member_communication_preference')
                    .insert({
                      member_id: createdMemberId,
                      category_id: pref.category_id,
                      is_subscribed: pref.is_subscribed
                    });
                }
              }
              console.log(`[AppProcessor] Saved communication preferences for member:`, createdMemberId);
            }
          }
        }
      }

      // Update submission record with created entity IDs if submission_id provided
      if (submission_id && (createdMemberId || createdOrganizationId)) {
        await supabase
          .from('form_submission')
          .update({
            created_member_id: createdMemberId,
            created_organization_id: createdOrganizationId,
            processed_at: new Date().toISOString()
          })
          .eq('id', submission_id);
      }

      return res.json({
        success: true,
        created_member_id: createdMemberId,
        created_organization_id: createdOrganizationId
      });
    } catch (error) {
      console.error('[AppProcessor] Error:', error);
      res.status(500).json({ error: 'Failed to process application' });
    }
  });

  // ============ Form Submission Email ============
  // Send email after form submission based on form's email settings
  app.post('/api/forms/send-submission-email', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { 
        form_id,
        submission_id,
        form_values,
        fields
      } = req.body;

      console.log('[FormSubmissionEmail] Request received for form:', form_id, 'submission:', submission_id);

      if (!form_id) {
        console.log('[FormSubmissionEmail] Missing form_id');
        return res.status(400).json({ error: 'form_id is required' });
      }

      // Get the form with email settings
      const { data: form, error: formError } = await supabase
        .from('form')
        .select('*')
        .eq('id', form_id)
        .single();

      if (formError || !form) {
        console.log('[FormSubmissionEmail] Form not found:', form_id, formError);
        return res.status(404).json({ error: 'Form not found' });
      }

      console.log('[FormSubmissionEmail] Form loaded:', form.name);
      console.log('[FormSubmissionEmail] Email settings - template_id:', form.submission_email_template_id);
      console.log('[FormSubmissionEmail] Email settings - recipient:', form.submission_email_recipient);
      console.log('[FormSubmissionEmail] Email settings - cc:', form.submission_email_cc);
      console.log('[FormSubmissionEmail] Email settings - bcc:', form.submission_email_bcc);

      // Check if email on submission is enabled
      if (!form.submission_email_template_id || !form.submission_email_recipient) {
        console.log('[FormSubmissionEmail] Email on submission not configured - skipping');
        return res.json({ success: true, skipped: true, reason: 'Email on submission not configured' });
      }

      // Get the email template
      const { data: template, error: templateError } = await supabase
        .from('email_template')
        .select('*')
        .eq('id', form.submission_email_template_id)
        .single();

      if (templateError || !template) {
        console.log('[FormSubmissionEmail] Email template not found:', form.submission_email_template_id, templateError);
        return res.status(404).json({ error: 'Email template not found' });
      }

      console.log('[FormSubmissionEmail] Template loaded:', template.name);

      // Helper function to resolve email address from field reference or static value
      const resolveEmailAddress = (value: string): string => {
        if (!value) return '';
        
        // Check if it's a field reference like {{field_id}}
        if (value.startsWith('{{') && value.endsWith('}}')) {
          const fieldId = value.slice(2, -2);
          const fieldValue = form_values?.[fieldId];
          console.log('[FormSubmissionEmail] Resolved field reference', fieldId, 'to:', fieldValue);
          return fieldValue || '';
        }
        
        // It's a static email address
        return value;
      };

      // Resolve the recipient email address
      const toEmail = resolveEmailAddress(form.submission_email_recipient);
      const ccEmail = form.submission_email_cc ? resolveEmailAddress(form.submission_email_cc) : '';
      const bccEmail = form.submission_email_bcc ? resolveEmailAddress(form.submission_email_bcc) : '';

      console.log('[FormSubmissionEmail] Resolved emails - to:', toEmail, 'cc:', ccEmail, 'bcc:', bccEmail);

      if (!toEmail) {
        console.log('[FormSubmissionEmail] No valid recipient email resolved');
        return res.json({ success: false, error: 'No valid recipient email' });
      }

      // Replace placeholders in template with form values
      let emailSubject = template.subject || 'Form Submission';
      let emailBody = template.body || '';

      // Get the field mapping from the form
      const fieldMapping = form.submission_email_field_mapping || {};
      console.log('[FormSubmissionEmail] Field mapping:', JSON.stringify(fieldMapping));

      // Helper to escape regex special chars
      const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Replace custom placeholders using the field mapping
      for (const [placeholder, fieldId] of Object.entries(fieldMapping)) {
        if (fieldId && form_values) {
          const fieldValue = form_values[fieldId as string];
          const displayValue = Array.isArray(fieldValue) ? fieldValue.join(', ') : (fieldValue || '');
          const placeholderPattern = `{{${placeholder}}}`;
          console.log('[FormSubmissionEmail] Replacing', placeholderPattern, 'with value from field', fieldId, ':', displayValue);
          
          emailSubject = emailSubject.replace(new RegExp(escapeRegex(placeholderPattern), 'g'), displayValue);
          emailBody = emailBody.replace(new RegExp(escapeRegex(placeholderPattern), 'g'), displayValue);
        }
      }

      // Replace form field placeholders (by field ID and label)
      if (form_values && fields) {
        for (const field of fields) {
          const fieldValue = form_values[field.id];
          const placeholder = `{{${field.id}}}`;
          const labelPlaceholder = field.label ? `{{${field.label}}}` : null;
          const displayValue = Array.isArray(fieldValue) ? fieldValue.join(', ') : (fieldValue || '');
          
          emailSubject = emailSubject.replace(new RegExp(escapeRegex(placeholder), 'g'), displayValue);
          emailBody = emailBody.replace(new RegExp(escapeRegex(placeholder), 'g'), displayValue);
          if (labelPlaceholder) {
            emailSubject = emailSubject.replace(new RegExp(escapeRegex(labelPlaceholder), 'g'), displayValue);
            emailBody = emailBody.replace(new RegExp(escapeRegex(labelPlaceholder), 'g'), displayValue);
          }
        }
      }

      // Replace system placeholders
      const systemPlaceholders: Record<string, string> = {
        'form.name': form.name || '',
        'submission.date': new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
      };
      for (const [key, value] of Object.entries(systemPlaceholders)) {
        const placeholder = `{{${key}}}`;
        emailSubject = emailSubject.replace(new RegExp(escapeRegex(placeholder), 'g'), value);
        emailBody = emailBody.replace(new RegExp(escapeRegex(placeholder), 'g'), value);
      }

      console.log('[FormSubmissionEmail] Sending email...');
      console.log('[FormSubmissionEmail] Subject:', emailSubject);

      // Send the email
      const emailResult = await sendEmail({
        to: toEmail,
        subject: emailSubject,
        html: emailBody,
        cc: ccEmail || undefined,
        bcc: bccEmail || undefined
      });

      console.log('[FormSubmissionEmail] Email result:', emailResult);

      if (emailResult.success) {
        return res.json({ 
          success: true, 
          messageId: emailResult.messageId,
          to: toEmail 
        });
      } else {
        return res.json({ 
          success: false, 
          error: emailResult.error 
        });
      }
    } catch (error: any) {
      console.error('[FormSubmissionEmail] Error:', error);
      res.status(500).json({ error: 'Failed to send submission email', details: error.message });
    }
  });

  // ============ Test Auth Route (Development Only) ============
  
  // Establish session for test login (bypasses password check)
  // This is used by TestLogin.jsx for development testing
  app.post('/api/auth/test-session', async (req: Request, res: Response) => {
    // Only allow in development mode
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Test login not available in production' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { memberId } = req.body;

      if (!memberId) {
        return res.status(400).json({ success: false, error: 'Member ID is required' });
      }

      // Verify member exists
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('*')
        .eq('id', memberId)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }

      // Establish server session
      req.session.memberId = member.id;
      
      // Save session explicitly
      req.session.save((err) => {
        if (err) {
          console.error('[Auth TestSession] Session save error:', err);
          return res.status(500).json({ success: false, error: 'Failed to create session' });
        }
        
        console.log('[Auth TestSession] Session established for:', member.email);
        res.json({ success: true, member });
      });
    } catch (error) {
      console.error('[Auth TestSession] Error:', error);
      res.status(500).json({ success: false, error: 'Failed to establish test session' });
    }
  });

  // ============ Password Auth Routes ============

  // Login with email and password
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
      }

      // Find member credentials
      const { data: credentials, error: credError } = await supabase
        .from('member_credentials')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

      if (credError || !credentials) {
        console.log('[Auth Login] No credentials found for:', email);
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      // Check if account is locked
      if (credentials.locked_until && new Date(credentials.locked_until) > new Date()) {
        return res.status(401).json({ success: false, error: 'Account temporarily locked. Please try again later.' });
      }

      // Check if password is set
      if (!credentials.password_hash) {
        return res.status(401).json({ 
          success: false, 
          error: 'Password not set', 
          needsPasswordSetup: true,
          memberId: credentials.member_id 
        });
      }

      // Verify password
      const isValid = await bcrypt.compare(password, credentials.password_hash);
      
      if (!isValid) {
        // Increment failed attempts
        const newFailedAttempts = (credentials.failed_attempts || 0) + 1;
        const updates: any = { failed_attempts: newFailedAttempts };
        
        // Lock account after 5 failed attempts for 15 minutes
        if (newFailedAttempts >= 5) {
          updates.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        }
        
        await supabase
          .from('member_credentials')
          .update(updates)
          .eq('id', credentials.id);
        
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
      }

      // Reset failed attempts and update last login
      await supabase
        .from('member_credentials')
        .update({ 
          failed_attempts: 0, 
          locked_until: null,
          last_login: new Date().toISOString() 
        })
        .eq('id', credentials.id);

      // Get full member data
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('*')
        .eq('id', credentials.member_id)
        .single();

      if (memberError || !member) {
        return res.status(401).json({ success: false, error: 'Member not found' });
      }

      // Check if login is enabled for this member
      if (member.login_enabled === false) {
        console.log('[Auth Login] Login disabled for member:', email);
        return res.status(403).json({ success: false, error: 'Login is disabled for this account. Please contact an administrator.' });
      }

      // Assign default role if needed
      if (!member.role_id) {
        const { data: allRoles } = await supabase.from('role').select('*');
        const memberRole = allRoles?.find((r: any) => r.name === 'Member');
        const defaultRole = memberRole || allRoles?.find((r: any) => r.is_default === true);
        
        if (defaultRole) {
          await supabase
            .from('member')
            .update({ role_id: defaultRole.id })
            .eq('id', member.id);
          member.role_id = defaultRole.id;
        }
      }

      // Auto-generate handle if member doesn't have one
      if (!member.handle && (member.first_name || member.last_name || member.email)) {
        console.log('[Auth Login] Member has no handle, generating one...');
        
        try {
          // Helper function to generate slug
          const generateSlug = (text: string): string => {
            return text
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');
          };

          // Get all existing handles to ensure uniqueness
          const { data: allMembersForHandles } = await supabase
            .from('member')
            .select('handle');
          
          const existingHandles = new Set<string>(
            (allMembersForHandles || [])
              .map((m: any) => m.handle)
              .filter((h: string | null) => h !== null)
          );

          // Generate base handle from name, or fall back to email prefix
          let baseHandle = '';
          if (member.first_name && member.last_name) {
            baseHandle = `${generateSlug(member.first_name)}-${generateSlug(member.last_name)}`;
          } else if (member.first_name) {
            baseHandle = generateSlug(member.first_name);
          } else if (member.last_name) {
            baseHandle = generateSlug(member.last_name);
          } else if (member.email) {
            // Use email prefix (before @) as fallback
            baseHandle = generateSlug(member.email.split('@')[0]);
          }
          
          if (baseHandle.length < 3) {
            baseHandle = 'member';
          }
          if (baseHandle.length > 30) {
            baseHandle = baseHandle.substring(0, 30);
          }

          // Make handle unique
          let handle = baseHandle;
          let counter = 1;

          while (existingHandles.has(handle)) {
            const suffix = `-${counter}`;
            const maxBaseLength = 30 - suffix.length;
            handle = baseHandle.substring(0, maxBaseLength) + suffix;
            counter++;
          }

          // Save the handle to the member record
          const { error: updateError } = await supabase
            .from('member')
            .update({ handle })
            .eq('id', member.id);

          if (updateError) {
            console.error('[Auth Login] Failed to save handle:', updateError);
          } else {
            member.handle = handle;
            console.log('[Auth Login] Generated and saved handle:', handle);
          }
        } catch (handleError: any) {
          console.error('[Auth Login] Error generating handle:', handleError.message);
          // Don't fail the login if handle generation fails
        }
      }

      // Set session
      req.session.memberId = member.id;
      req.session.memberEmail = member.email;

      // Explicitly save session for serverless environments
      req.session.save((err) => {
        if (err) {
          console.error('[Auth Login] Session save error:', err);
          return res.status(500).json({ success: false, error: 'Failed to create session' });
        }
        
        console.log('[Auth Login] Success for:', email, 'Session ID:', req.sessionID);
        
        res.json({ 
          success: true, 
          member,
          isTemporaryPassword: credentials.is_temp_password 
        });
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ success: false, error: 'Login failed' });
    }
  });

  // Check if member has password set
  app.post('/api/auth/check-password-status', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      // Check if member exists
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id, email')
        .eq('email', email.toLowerCase())
        .single();

      if (memberError || !member) {
        return res.json({ exists: false, hasPassword: false });
      }

      // Check if credentials exist
      const { data: credentials } = await supabase
        .from('member_credentials')
        .select('id, password_hash')
        .eq('member_id', member.id)
        .single();

      res.json({ 
        exists: true, 
        hasPassword: !!(credentials?.password_hash),
        memberId: member.id
      });
    } catch (error) {
      console.error('Check password status error:', error);
      res.status(500).json({ error: 'Failed to check status' });
    }
  });

  // Set password for first time (for existing members migrating from magic link)
  app.post('/api/auth/set-password', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email, password, token } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
      }

      if (password.length < 8) {
        return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
      }

      // Find member
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id, email')
        .eq('email', email.toLowerCase())
        .single();

      if (memberError || !member) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }

      // If token provided, verify it (for password reset flow)
      if (token) {
        const { data: credentials, error: credError } = await supabase
          .from('member_credentials')
          .select('*')
          .eq('member_id', member.id)
          .eq('reset_token', token)
          .single();

        if (credError || !credentials) {
          return res.status(401).json({ success: false, error: 'Invalid or expired reset token' });
        }

        if (credentials.reset_token_expires && new Date(credentials.reset_token_expires) < new Date()) {
          return res.status(401).json({ success: false, error: 'Reset token has expired' });
        }
      }

      // Hash the password
      const passwordHash = await bcrypt.hash(password, 12);

      // Check if credentials record exists
      const { data: existingCreds } = await supabase
        .from('member_credentials')
        .select('id')
        .eq('member_id', member.id)
        .single();

      if (existingCreds) {
        // Update existing credentials
        const { error: updateError } = await supabase
          .from('member_credentials')
          .update({ 
            password_hash: passwordHash,
            is_temp_password: false,
            password_set_at: new Date().toISOString(),
            reset_token: null,
            reset_token_expires: null,
            failed_login_attempts: 0,
            locked_until: null
          })
          .eq('id', existingCreds.id);
        
        if (updateError) {
          console.error('[Auth] Failed to update password:', updateError);
          return res.status(500).json({ success: false, error: 'Failed to save password' });
        }
        console.log('[Auth] Updated existing credentials for:', email);
      } else {
        // Create new credentials record
        const { error: insertError } = await supabase
          .from('member_credentials')
          .insert({
            member_id: member.id,
            email: email.toLowerCase(),
            password_hash: passwordHash,
            is_temp_password: false,
            password_set_at: new Date().toISOString()
          });
        
        if (insertError) {
          console.error('[Auth] Failed to insert credentials:', insertError);
          return res.status(500).json({ success: false, error: 'Failed to save password' });
        }
        console.log('[Auth] Created new credentials for:', email);
      }

      // Set session (auto-login after setting password)
      req.session.memberId = member.id;
      req.session.memberEmail = member.email;

      // Get full member data for response
      const { data: fullMember } = await supabase
        .from('member')
        .select('*')
        .eq('id', member.id)
        .single();

      // Auto-generate handle if member doesn't have one
      if (fullMember && !fullMember.handle && (fullMember.first_name || fullMember.last_name || fullMember.email)) {
        console.log('[Auth SetPassword] Member has no handle, generating one...');
        
        try {
          const generateSlug = (text: string): string => {
            return text
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');
          };

          const { data: allMembersForHandles } = await supabase
            .from('member')
            .select('handle');
          
          const existingHandles = new Set<string>(
            (allMembersForHandles || [])
              .map((m: any) => m.handle)
              .filter((h: string | null) => h !== null)
          );

          let baseHandle = '';
          if (fullMember.first_name && fullMember.last_name) {
            baseHandle = `${generateSlug(fullMember.first_name)}-${generateSlug(fullMember.last_name)}`;
          } else if (fullMember.first_name) {
            baseHandle = generateSlug(fullMember.first_name);
          } else if (fullMember.last_name) {
            baseHandle = generateSlug(fullMember.last_name);
          } else if (fullMember.email) {
            baseHandle = generateSlug(fullMember.email.split('@')[0]);
          }
          
          if (baseHandle.length < 3) baseHandle = 'member';
          if (baseHandle.length > 30) baseHandle = baseHandle.substring(0, 30);

          let handle = baseHandle;
          let counter = 1;
          while (existingHandles.has(handle)) {
            const suffix = `-${counter}`;
            handle = baseHandle.substring(0, 30 - suffix.length) + suffix;
            counter++;
          }

          const { error: updateError } = await supabase
            .from('member')
            .update({ handle })
            .eq('id', fullMember.id);

          if (!updateError) {
            fullMember.handle = handle;
            console.log('[Auth SetPassword] Generated and saved handle:', handle);
          }
        } catch (handleError: any) {
          console.error('[Auth SetPassword] Error generating handle:', handleError.message);
        }
      }

      // Explicitly save session for serverless environments
      req.session.save((err) => {
        if (err) {
          console.error('[Auth] Session save error:', err);
          return res.status(500).json({ success: false, error: 'Failed to create session' });
        }
        
        console.log('[Auth] Password set for:', email);
        res.json({ success: true, member: fullMember });
      });
    } catch (error) {
      console.error('Set password error:', error);
      res.status(500).json({ success: false, error: 'Failed to set password' });
    }
  });

  // Request password reset
  app.post('/api/auth/request-password-reset', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ success: false, error: 'Email is required' });
      }

      // Find member
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id, email, first_name')
        .eq('email', email.toLowerCase())
        .single();

      // Always return success to prevent email enumeration
      if (memberError || !member) {
        console.log('[Password Reset] No member found for:', email);
        return res.json({ success: true, message: 'If an account exists, a reset link will be sent.' });
      }

      // Generate reset token
      const resetToken = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Ensure credentials record exists and update with reset token
      const { data: existingCreds } = await supabase
        .from('member_credentials')
        .select('id')
        .eq('member_id', member.id)
        .single();

      if (existingCreds) {
        await supabase
          .from('member_credentials')
          .update({ 
            reset_token: resetToken,
            reset_token_expires: expiresAt.toISOString()
          })
          .eq('id', existingCreds.id);
      } else {
        await supabase
          .from('member_credentials')
          .insert({
            member_id: member.id,
            email: email.toLowerCase(),
            reset_token: resetToken,
            reset_token_expires: expiresAt.toISOString()
          });
      }

      // Generate reset link
      const resetUrl = `${req.protocol}://${req.get('host')}/auth/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
      console.log(`[Password Reset] Link for ${email}: ${resetUrl}`);

      // Send email via Mailgun
      const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
      const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;
      const MAILGUN_FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL;

      if (MAILGUN_API_KEY && MAILGUN_DOMAIN && MAILGUN_FROM_EMAIL) {
        try {
          const formData = new FormData();
          formData.append('from', `AGCAS Portal <${MAILGUN_FROM_EMAIL}>`);
          formData.append('to', email);
          formData.append('subject', 'Reset Your Password');
          formData.append('html', `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #333;">Password Reset Request</h2>
              <p>Hi ${member.first_name || 'there'},</p>
              <p>We received a request to reset your password. Click the button below to create a new password:</p>
              <p style="margin: 30px 0;">
                <a href="${resetUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                  Reset Password
                </a>
              </p>
              <p>This link will expire in 1 hour.</p>
              <p>If you didn't request this reset, you can safely ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
              <p style="color: #666; font-size: 12px;">AGCAS Member Portal</p>
            </div>
          `);

          const apiBase = 'https://api.eu.mailgun.net/v3';
          const mailgunUrl = `${apiBase}/${MAILGUN_DOMAIN}/messages`;

          const mailResponse = await fetch(mailgunUrl, {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64'),
            },
            body: formData
          });

          if (mailResponse.ok) {
            console.log(`[Password Reset] Email sent to ${email}`);
          } else {
            const errorText = await mailResponse.text();
            console.error(`[Password Reset] Mailgun error: ${mailResponse.status} - ${errorText}`);
          }
        } catch (mailError) {
          console.error('[Password Reset] Failed to send email:', mailError);
        }
      } else {
        console.warn('[Password Reset] Mailgun not configured, email not sent');
      }

      const isDev = process.env.NODE_ENV !== 'production';
      
      res.json({ 
        success: true, 
        message: 'If an account exists, a reset link will be sent.',
        ...(isDev && { resetUrl, resetToken }) // Only include in dev for testing
      });
    } catch (error) {
      console.error('Password reset request error:', error);
      res.status(500).json({ success: false, error: 'Failed to process request' });
    }
  });

  // Change password (when logged in)
  app.post('/api/auth/change-password', async (req: Request, res: Response) => {
    if (!req.session.memberId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, error: 'Current and new password are required' });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
      }

      // Get credentials
      const { data: credentials, error: credError } = await supabase
        .from('member_credentials')
        .select('*')
        .eq('member_id', req.session.memberId)
        .single();

      if (credError || !credentials) {
        return res.status(404).json({ success: false, error: 'Credentials not found' });
      }

      // Verify current password
      if (credentials.password_hash) {
        const isValid = await bcrypt.compare(currentPassword, credentials.password_hash);
        if (!isValid) {
          return res.status(401).json({ success: false, error: 'Current password is incorrect' });
        }
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(newPassword, 12);

      // Update password
      await supabase
        .from('member_credentials')
        .update({ 
          password_hash: passwordHash,
          is_temp_password: false,
          password_set_at: new Date().toISOString()
        })
        .eq('id', credentials.id);

      console.log('[Auth] Password changed for member:', req.session.memberId);
      res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ success: false, error: 'Failed to change password' });
    }
  });

  // ============ Admin Member Routes ============
  // These routes verify permissions server-side to prevent privilege escalation
  // Permissions are controlled via Role Management (excluded_features array)

  // Helper function to verify a specific permission from session
  // Returns true if the permission is NOT in the role's excluded_features array
  const verifyPermission = async (
    req: Request, 
    permissionId: string
  ): Promise<{ hasPermission: boolean; memberId: string | null; error?: string }> => {
    if (!req.session.memberId) {
      return { hasPermission: false, memberId: null, error: 'Not authenticated' };
    }

    if (!supabase) {
      return { hasPermission: false, memberId: null, error: 'Database not configured' };
    }

    try {
      // Get the authenticated member's role from server
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id, role_id')
        .eq('id', req.session.memberId)
        .single();

      if (memberError || !member) {
        return { hasPermission: false, memberId: null, error: 'Member not found' };
      }

      if (!member.role_id) {
        // No role assigned - no permissions
        return { hasPermission: false, memberId: member.id };
      }

      // Get the role's excluded_features
      const { data: role, error: roleError } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', member.role_id)
        .single();

      if (roleError || !role) {
        return { hasPermission: false, memberId: member.id };
      }

      // Check if the permission is in the excluded_features array
      // If NOT excluded, the role has this permission
      const excludedFeatures = role.excluded_features || [];
      
      const hasPermission = !excludedFeatures.includes(permissionId);

      return { hasPermission, memberId: member.id };
    } catch (error) {
      console.error('[Permission Verify] Error:', error);
      return { hasPermission: false, memberId: null, error: 'Verification failed' };
    }
  };

  // Legacy helper - checks if user is admin (for backwards compatibility)
  const verifyAdminSession = async (req: Request): Promise<{ isAdmin: boolean; memberId: string | null; error?: string }> => {
    const result = await verifyPermission(req, 'admin_can_edit_members');
    return { isAdmin: result.hasPermission, memberId: result.memberId, error: result.error };
  };

  // Get role member counts for all roles (admin only)
  // Used by RoleManagement to display current usage vs max_members
  app.get('/api/admin/roles/member-counts', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      // Get all roles
      const { data: roles, error: rolesError } = await supabase
        .from('role')
        .select('id, name, max_members');

      if (rolesError) {
        return res.status(500).json({ error: 'Failed to fetch roles' });
      }

      // Get counts for each role (only active members with login_enabled = true)
      const counts: Record<string, number> = {};
      
      for (const role of roles || []) {
        const { count, error: countError } = await supabase
          .from('member')
          .select('id', { count: 'exact', head: true })
          .eq('role_id', role.id)
          .eq('login_enabled', true);

        if (countError) {
          console.error(`[RoleMemberCounts] Error counting members for role ${role.name}:`, countError);
        }
        counts[role.id] = count || 0;
        
        // Log roles with limits for debugging
        if (role.max_members !== null) {
          console.log(`[RoleMemberCounts] Role "${role.name}" (${role.id}): ${count || 0}/${role.max_members} members`);
        }
      }

      res.json({ counts });
    } catch (error) {
      console.error('[Admin Role Member Counts] Error:', error);
      res.status(500).json({ error: 'Failed to get role member counts' });
    }
  });

  // Get member by ID (admin only)
  app.get('/api/admin/members/:id', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const memberId = req.params.id;
      
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('*')
        .eq('id', memberId)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Member not found' });
      }

      res.json(member);
    } catch (error) {
      console.error('[Admin Get Member] Error:', error);
      res.status(500).json({ error: 'Failed to get member' });
    }
  });

  // Update member by ID (admin only)
  app.patch('/api/admin/members/:id', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const memberId = req.params.id;
      const rawUpdates = req.body;

      // Explicit allowlist of fields that can be updated by admin
      // This prevents privilege escalation via role_id changes or other sensitive fields
      const allowedFields = [
        'first_name', 'last_name', 'job_title', 'biography',
        'profile_photo_url', 'show_in_directory',
        'twitter_url', 'phone_number', 'pronouns', 'location_summary'
      ];

      const updates: Record<string, any> = {};
      for (const field of allowedFields) {
        if (rawUpdates[field] !== undefined) {
          updates[field] = rawUpdates[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const { data: updatedMember, error: updateError } = await supabase
        .from('member')
        .update(updates)
        .eq('id', memberId)
        .select()
        .single();

      if (updateError) {
        console.error('[Admin Update Member] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      res.json(updatedMember);
    } catch (error) {
      console.error('[Admin Update Member] Error:', error);
      res.status(500).json({ error: 'Failed to update member' });
    }
  });

  // Update organization by ID (admin only)
  app.patch('/api/admin/organizations/:id', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const orgId = req.params.id;
      const rawUpdates = req.body;

      // Explicit allowlist of fields that can be updated by admin
      const allowedFields = [
        'logo_url', 'name', 'description', 'website_url',
        'phone', 'invoicing_email', 'invoicing_address'
      ];

      const updates: Record<string, any> = {};
      for (const field of allowedFields) {
        if (rawUpdates[field] !== undefined) {
          updates[field] = rawUpdates[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const { data: updatedOrg, error: updateError } = await supabase
        .from('organization')
        .update(updates)
        .eq('id', orgId)
        .select()
        .single();

      if (updateError) {
        console.error('[Admin Update Org] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      res.json(updatedOrg);
    } catch (error) {
      console.error('[Admin Update Org] Error:', error);
      res.status(500).json({ error: 'Failed to update organization' });
    }
  });

  // Backfill created_at for organizations that don't have it
  app.post('/api/admin/backfill-organization-dates', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      // Accept custom date from request body, default to today
      const { date } = req.body || {};
      const backfillDate = date ? new Date(date).toISOString() : new Date().toISOString();
      
      // Update all organizations where created_at is null
      const { data, error: updateError } = await supabase
        .from('organization')
        .update({ created_at: backfillDate })
        .is('created_at', null)
        .select('id');

      if (updateError) {
        console.error('[Backfill Org Dates] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      const count = data?.length || 0;
      console.log(`[Backfill Org Dates] Updated ${count} organizations with created_at: ${backfillDate}`);
      
      res.json({ 
        success: true, 
        updated: count,
        backfillDate 
      });
    } catch (error) {
      console.error('[Backfill Org Dates] Error:', error);
      res.status(500).json({ error: 'Failed to backfill organization dates' });
    }
  });

  // Backfill created_date for job postings that don't have it
  app.post('/api/admin/backfill-job-posting-dates', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      // Find all job postings where created_date is null
      const { data: jobsToFix, error: fetchError } = await supabase
        .from('job_posting')
        .select('id, created_at, created_date')
        .is('created_date', null);
      
      if (fetchError) {
        console.error('[Backfill Job Dates] Fetch error:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }
      
      if (!jobsToFix || jobsToFix.length === 0) {
        return res.json({ success: true, message: 'No job postings need updating', updated: 0 });
      }
      
      let updatedCount = 0;
      const errors: { id: string; error: string }[] = [];
      
      for (const job of jobsToFix) {
        const dateToUse = job.created_at || new Date().toISOString();
        
        const { error: updateError } = await supabase
          .from('job_posting')
          .update({ created_date: dateToUse })
          .eq('id', job.id);
        
        if (updateError) {
          errors.push({ id: job.id, error: updateError.message });
        } else {
          updatedCount++;
        }
      }
      
      console.log(`[Backfill Job Dates] Updated ${updatedCount} of ${jobsToFix.length} job postings`);
      
      res.json({
        success: errors.length === 0,
        message: `Updated ${updatedCount} of ${jobsToFix.length} job postings`,
        updated: updatedCount,
        total: jobsToFix.length,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      console.error('[Backfill Job Dates] Error:', error);
      res.status(500).json({ error: 'Failed to backfill job posting dates' });
    }
  });

  // ============ Organization Notes CRUD ============
  
  // Get notes for an organization
  app.get('/api/admin/organizations/:id/notes', async (req: Request, res: Response) => {
    const { isAdmin, error, memberId } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const orgId = req.params.id;
      
      // Fetch notes with member info
      const { data: notes, error: fetchError } = await supabase
        .from('organization_note')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });

      if (fetchError) {
        console.error('[Get Org Notes] Error:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }

      // Get member names for the notes
      const memberIds = [...new Set((notes || []).map((n: any) => n.member_id))];
      let membersMap: Record<string, any> = {};
      
      if (memberIds.length > 0) {
        const { data: members } = await supabase
          .from('member')
          .select('id, first_name, last_name, email')
          .in('id', memberIds);
        
        if (members) {
          membersMap = members.reduce((acc: Record<string, any>, m: any) => {
            acc[m.id] = m;
            return acc;
          }, {});
        }
      }

      // Enrich notes with member info
      const enrichedNotes = (notes || []).map((note: any) => ({
        ...note,
        member_name: membersMap[note.member_id] 
          ? `${membersMap[note.member_id].first_name || ''} ${membersMap[note.member_id].last_name || ''}`.trim() || membersMap[note.member_id].email
          : 'Unknown',
        member_email: membersMap[note.member_id]?.email || null
      }));

      res.json(enrichedNotes);
    } catch (error) {
      console.error('[Get Org Notes] Error:', error);
      res.status(500).json({ error: 'Failed to fetch organization notes' });
    }
  });

  // Create a note for an organization
  app.post('/api/admin/organizations/:id/notes', async (req: Request, res: Response) => {
    const { isAdmin, error, memberId } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const orgId = req.params.id;
      const { content, attachments } = req.body;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'Note content is required' });
      }

      const { data: note, error: insertError } = await supabase
        .from('organization_note')
        .insert({
          organization_id: orgId,
          member_id: memberId,
          content: content.trim(),
          attachments: attachments || [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Create Org Note] Error:', insertError);
        return res.status(500).json({ error: insertError.message });
      }

      // Get member info for the response
      const { data: member } = await supabase
        .from('member')
        .select('id, first_name, last_name, email')
        .eq('id', memberId)
        .single();

      res.json({
        ...note,
        member_name: member 
          ? `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email
          : 'Unknown',
        member_email: member?.email || null
      });
    } catch (error) {
      console.error('[Create Org Note] Error:', error);
      res.status(500).json({ error: 'Failed to create organization note' });
    }
  });

  // Update a note
  app.patch('/api/admin/organization-notes/:noteId', async (req: Request, res: Response) => {
    const { isAdmin, error, memberId } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const noteId = req.params.noteId;
      const { content } = req.body;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ error: 'Note content is required' });
      }

      // Check if note exists and user is the author (or allow any admin to edit)
      const { data: existingNote, error: fetchError } = await supabase
        .from('organization_note')
        .select('*')
        .eq('id', noteId)
        .single();

      if (fetchError || !existingNote) {
        return res.status(404).json({ error: 'Note not found' });
      }

      const { data: updatedNote, error: updateError } = await supabase
        .from('organization_note')
        .update({
          content: content.trim(),
          updated_at: new Date().toISOString()
        })
        .eq('id', noteId)
        .select()
        .single();

      if (updateError) {
        console.error('[Update Org Note] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      res.json(updatedNote);
    } catch (error) {
      console.error('[Update Org Note] Error:', error);
      res.status(500).json({ error: 'Failed to update organization note' });
    }
  });

  // Delete a note
  app.delete('/api/admin/organization-notes/:noteId', async (req: Request, res: Response) => {
    const { isAdmin, error, memberId } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const noteId = req.params.noteId;

      // Check if note exists
      const { data: existingNote, error: fetchError } = await supabase
        .from('organization_note')
        .select('id')
        .eq('id', noteId)
        .single();

      if (fetchError || !existingNote) {
        return res.status(404).json({ error: 'Note not found' });
      }

      const { error: deleteError } = await supabase
        .from('organization_note')
        .delete()
        .eq('id', noteId);

      if (deleteError) {
        console.error('[Delete Org Note] Error:', deleteError);
        return res.status(500).json({ error: deleteError.message });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[Delete Org Note] Error:', error);
      res.status(500).json({ error: 'Failed to delete organization note' });
    }
  });

  // Fix blog post handles - generate handles for authors and update slugs
  app.post('/api/admin/fix-blog-handles', async (req: Request, res: Response) => {
    // Verify admin status via session
    const sessionMemberId = (req.session as any)?.memberId;
    if (!sessionMemberId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      console.log('[Fix Blog Handles] Starting...');
      
      // Helper function to generate slug
      const generateSlug = (text: string): string => {
        return text
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
      };

      // Fetch all members with pagination to avoid Supabase's 1000 row limit
      let allMembersForHandles: any[] = [];
      let offset = 0;
      const pageSize = 1000;
      let hasMore = true;
      
      while (hasMore) {
        const { data: memberBatch, error: memberError } = await supabase
          .from('member')
          .select('id, handle, first_name, last_name, email')
          .range(offset, offset + pageSize - 1);
        
        if (memberError) {
          console.error('[Fix Blog Handles] Error fetching members:', memberError);
          return res.status(500).json({ error: 'Failed to fetch members: ' + memberError.message });
        }
        
        if (memberBatch && memberBatch.length > 0) {
          allMembersForHandles = allMembersForHandles.concat(memberBatch);
          offset += pageSize;
          hasMore = memberBatch.length === pageSize;
        } else {
          hasMore = false;
        }
      }

      console.log(`[Fix Blog Handles] Fetched ${allMembersForHandles.length} members total`);
      
      const existingHandles = new Set<string>(
        (allMembersForHandles || [])
          .map((m: any) => m.handle)
          .filter((h: string | null) => h !== null)
      );

      const memberMap = new Map<string, any>();
      (allMembersForHandles || []).forEach((m: any) => memberMap.set(m.id, m));
      
      console.log(`[Fix Blog Handles] Member map has ${memberMap.size} entries`);

      // Get all blog posts with author_id
      const { data: blogPosts, error: blogError } = await supabase
        .from('blog_post')
        .select('id, slug, author_id, author_name')
        .not('author_id', 'is', null);

      if (blogError) {
        console.error('[Fix Blog Handles] Error fetching blogs:', blogError);
        return res.status(500).json({ error: blogError.message });
      }

      let handlesCreated = 0;
      let slugsUpdated = 0;
      const errors: string[] = [];

      for (const blog of blogPosts || []) {
        try {
          const member = memberMap.get(blog.author_id);
          if (!member) {
            errors.push(`Blog ${blog.id}: Author ${blog.author_id} not found`);
            continue;
          }

          let handle = member.handle;

          // Generate handle if member doesn't have one
          if (!handle && (member.first_name || member.last_name || member.email)) {
            let baseHandle = '';
            if (member.first_name && member.last_name) {
              baseHandle = `${generateSlug(member.first_name)}-${generateSlug(member.last_name)}`;
            } else if (member.first_name) {
              baseHandle = generateSlug(member.first_name);
            } else if (member.last_name) {
              baseHandle = generateSlug(member.last_name);
            } else if (member.email) {
              baseHandle = generateSlug(member.email.split('@')[0]);
            }
            
            if (baseHandle.length < 3) {
              baseHandle = 'member';
            }
            if (baseHandle.length > 30) {
              baseHandle = baseHandle.substring(0, 30);
            }

            // Make handle unique
            handle = baseHandle;
            let counter = 1;
            while (existingHandles.has(handle)) {
              const suffix = `-${counter}`;
              const maxBaseLength = 30 - suffix.length;
              handle = baseHandle.substring(0, maxBaseLength) + suffix;
              counter++;
            }

            // Save the handle to the member record
            const { error: updateMemberError } = await supabase
              .from('member')
              .update({ handle })
              .eq('id', member.id);

            if (updateMemberError) {
              errors.push(`Member ${member.id}: Failed to save handle - ${updateMemberError.message}`);
              continue;
            }

            existingHandles.add(handle);
            member.handle = handle;
            handlesCreated++;
            console.log(`[Fix Blog Handles] Created handle "${handle}" for member ${member.id}`);
          }

          if (!handle) {
            errors.push(`Blog ${blog.id}: Could not generate handle for author ${blog.author_id}`);
            continue;
          }

          // Check if slug needs updating (doesn't end with -by-{handle})
          const currentSlug = blog.slug || '';
          const expectedSuffix = `-by-${handle}`;
          
          if (!currentSlug.endsWith(expectedSuffix)) {
            // Remove any existing -by-* suffix first
            let baseSlug = currentSlug;
            const byMatch = currentSlug.match(/-by-[a-z0-9-]+$/i);
            if (byMatch) {
              baseSlug = currentSlug.slice(0, -byMatch[0].length);
            }
            
            const newSlug = `${baseSlug}${expectedSuffix}`;
            
            const { error: updateBlogError } = await supabase
              .from('blog_post')
              .update({ slug: newSlug })
              .eq('id', blog.id);

            if (updateBlogError) {
              errors.push(`Blog ${blog.id}: Failed to update slug - ${updateBlogError.message}`);
              continue;
            }

            slugsUpdated++;
            console.log(`[Fix Blog Handles] Updated blog ${blog.id} slug: "${currentSlug}" -> "${newSlug}"`);
          }
        } catch (blogErr: any) {
          errors.push(`Blog ${blog.id}: ${blogErr.message}`);
        }
      }

      console.log(`[Fix Blog Handles] Complete. Handles created: ${handlesCreated}, Slugs updated: ${slugsUpdated}, Errors: ${errors.length}`);
      
      res.json({ 
        success: true, 
        handlesCreated,
        slugsUpdated,
        totalBlogs: blogPosts?.length || 0,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error: any) {
      console.error('[Fix Blog Handles] Error:', error);
      res.status(500).json({ error: 'Failed to fix blog handles: ' + error.message });
    }
  });

  // Update own organization (for members to edit their organization details)
  app.patch('/api/my-organization', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Verify the user is logged in
    const sessionMemberId = (req.session as any)?.memberId;
    if (!sessionMemberId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      // Get the member's organization_id
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('organization_id')
        .eq('id', sessionMemberId)
        .single();

      if (memberError || !member?.organization_id) {
        console.error('[Update My Org] Member lookup error:', memberError);
        return res.status(404).json({ error: 'Member or organization not found' });
      }

      const orgId = member.organization_id;
      const rawUpdates = req.body;

      // Fields that members can update on their own organization (name excluded)
      const allowedFields = [
        'description', 'website_url', 'logo_url',
        'phone', 'invoicing_email', 'invoicing_address'
      ];

      const updates: Record<string, any> = {};
      for (const field of allowedFields) {
        if (rawUpdates[field] !== undefined) {
          updates[field] = rawUpdates[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const { data: updatedOrg, error: updateError } = await supabase
        .from('organization')
        .update(updates)
        .eq('id', orgId)
        .select()
        .single();

      if (updateError) {
        console.error('[Update My Org] Error:', updateError);
        return res.status(500).json({ error: updateError.message });
      }

      res.json(updatedOrg);
    } catch (error) {
      console.error('[Update My Org] Error:', error);
      res.status(500).json({ error: 'Failed to update organization' });
    }
  });

  // Update communication preference for a member (admin only)
  app.patch('/api/admin/members/:memberId/communication-preferences/:categoryId', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const { memberId, categoryId } = req.params;
      const { is_subscribed } = req.body;

      if (typeof is_subscribed !== 'boolean') {
        return res.status(400).json({ error: 'is_subscribed must be a boolean' });
      }

      // Check if preference exists
      const { data: existingPref } = await supabase
        .from('member_communication_preference')
        .select('id')
        .eq('member_id', memberId)
        .eq('category_id', categoryId)
        .single();

      if (existingPref) {
        // Update existing preference
        const { data, error: updateError } = await supabase
          .from('member_communication_preference')
          .update({ 
            is_subscribed,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingPref.id)
          .select()
          .single();

        if (updateError) {
          console.error('[Admin Update Comm Pref] Error:', updateError);
          return res.status(500).json({ error: updateError.message });
        }

        return res.json(data);
      } else {
        // Create new preference
        const { data, error: insertError } = await supabase
          .from('member_communication_preference')
          .insert({
            member_id: memberId,
            category_id: categoryId,
            is_subscribed
          })
          .select()
          .single();

        if (insertError) {
          console.error('[Admin Create Comm Pref] Error:', insertError);
          return res.status(500).json({ error: insertError.message });
        }

        return res.json(data);
      }
    } catch (error) {
      console.error('[Admin Comm Pref] Error:', error);
      res.status(500).json({ error: 'Failed to update communication preference' });
    }
  });

  // ============ Role Organization Field Permissions ============
  
  // Get all field permissions for a role
  app.get('/api/roles/:roleId/organization-field-permissions', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const { roleId } = req.params;

      const { data: permissions, error: fetchError } = await supabase
        .from('role_organization_field_permission')
        .select('*')
        .eq('role_id', roleId);

      if (fetchError) {
        console.error('[Get Role Field Permissions] Error:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }

      // Convert to a map for easier frontend usage
      const permissionMap: Record<string, string> = {};
      (permissions || []).forEach((p: any) => {
        permissionMap[p.field_key] = p.permission;
      });

      res.json(permissionMap);
    } catch (error) {
      console.error('[Get Role Field Permissions] Error:', error);
      res.status(500).json({ error: 'Failed to get field permissions' });
    }
  });

  // Update field permissions for a role (batch update)
  app.put('/api/roles/:roleId/organization-field-permissions', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const { roleId } = req.params;
      const permissions = req.body; // { field_key: permission, ... }

      if (typeof permissions !== 'object' || permissions === null) {
        return res.status(400).json({ error: 'Request body must be an object mapping field_key to permission' });
      }

      // Validate permission values
      const validPermissions = ['hidden', 'read', 'read_write'];
      for (const [fieldKey, permission] of Object.entries(permissions)) {
        if (!validPermissions.includes(permission as string)) {
          return res.status(400).json({ 
            error: `Invalid permission '${permission}' for field '${fieldKey}'. Must be one of: ${validPermissions.join(', ')}` 
          });
        }
      }

      // Delete all existing permissions for this role
      const { error: deleteError } = await supabase
        .from('role_organization_field_permission')
        .delete()
        .eq('role_id', roleId);

      if (deleteError) {
        console.error('[Delete Role Field Permissions] Error:', deleteError);
        return res.status(500).json({ error: deleteError.message });
      }

      // Insert new permissions (only those that aren't 'read_write' as that's the default)
      const permissionsToInsert = Object.entries(permissions)
        .filter(([_, permission]) => permission !== 'read_write')
        .map(([fieldKey, permission]) => ({
          role_id: roleId,
          field_key: fieldKey,
          permission: permission
        }));

      if (permissionsToInsert.length > 0) {
        const { error: insertError } = await supabase
          .from('role_organization_field_permission')
          .insert(permissionsToInsert);

        if (insertError) {
          console.error('[Insert Role Field Permissions] Error:', insertError);
          return res.status(500).json({ error: insertError.message });
        }
      }

      res.json({ success: true, count: permissionsToInsert.length });
    } catch (error) {
      console.error('[Update Role Field Permissions] Error:', error);
      res.status(500).json({ error: 'Failed to update field permissions' });
    }
  });

  // Get field permissions for the current member's role (for MyOrganisation page)
  app.get('/api/my-organization-field-permissions', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const memberEmail = req.session?.memberEmail;
      if (!memberEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get member's role
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('role_id')
        .ilike('email', memberEmail)
        .single();

      if (memberError || !member) {
        console.error('[Get My Field Permissions] Member error:', memberError);
        return res.status(404).json({ error: 'Member not found' });
      }

      if (!member.role_id) {
        // No role assigned, return empty (default to read_write for all)
        return res.json({});
      }

      const { data: permissions, error: fetchError } = await supabase
        .from('role_organization_field_permission')
        .select('*')
        .eq('role_id', member.role_id);

      if (fetchError) {
        console.error('[Get My Field Permissions] Error:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }

      // Convert to a map for easier frontend usage
      const permissionMap: Record<string, string> = {};
      (permissions || []).forEach((p: any) => {
        permissionMap[p.field_key] = p.permission;
      });

      res.json(permissionMap);
    } catch (error) {
      console.error('[Get My Field Permissions] Error:', error);
      res.status(500).json({ error: 'Failed to get field permissions' });
    }
  });

  // ============ Member Field Permissions ============
  
  // Get all member field permissions for a role (admin only)
  app.get('/api/roles/:roleId/member-field-permissions', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const { roleId } = req.params;

      const { data: permissions, error: fetchError } = await supabase
        .from('role_member_field_permission')
        .select('*')
        .eq('role_id', roleId);

      console.log('[Get Role Member Field Permissions] roleId:', roleId, 'permissions:', permissions);

      if (fetchError) {
        console.error('[Get Role Member Field Permissions] Error:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }

      // Convert to a map for easier frontend usage
      const permissionMap: Record<string, string> = {};
      (permissions || []).forEach((p: any) => {
        permissionMap[p.field_key] = p.permission;
      });

      console.log('[Get Role Member Field Permissions] Returning permissionMap:', permissionMap);
      res.json(permissionMap);
    } catch (error) {
      console.error('[Get Role Member Field Permissions] Error:', error);
      res.status(500).json({ error: 'Failed to get member field permissions' });
    }
  });

  // Update member field permissions for a role (batch update)
  app.put('/api/roles/:roleId/member-field-permissions', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const { roleId } = req.params;
      const permissions = req.body; // Array of { field_key, permission }

      if (!Array.isArray(permissions)) {
        return res.status(400).json({ error: 'Request body must be an array of { field_key, permission }' });
      }

      // Validate permission values
      const validPermissions = ['hidden', 'read', 'read_write'];
      for (const { field_key, permission } of permissions) {
        if (!validPermissions.includes(permission)) {
          return res.status(400).json({ 
            error: `Invalid permission '${permission}' for field '${field_key}'. Must be one of: ${validPermissions.join(', ')}` 
          });
        }
      }

      // Delete all existing permissions for this role
      const { error: deleteError } = await supabase
        .from('role_member_field_permission')
        .delete()
        .eq('role_id', roleId);

      if (deleteError) {
        console.error('[Delete Role Member Field Permissions] Error:', deleteError);
        return res.status(500).json({ error: deleteError.message });
      }

      // Insert new permissions (only those that aren't 'read_write' as that's the default)
      const permissionsToInsert = permissions
        .filter(({ permission }) => permission !== 'read_write')
        .map(({ field_key, permission }) => ({
          id: crypto.randomUUID(),
          role_id: roleId,
          field_key,
          permission
        }));

      console.log('[Update Role Member Field Permissions] Inserting:', permissionsToInsert);

      if (permissionsToInsert.length > 0) {
        const { data: insertedData, error: insertError } = await supabase
          .from('role_member_field_permission')
          .insert(permissionsToInsert)
          .select();

        if (insertError) {
          console.error('[Insert Role Member Field Permissions] Error:', insertError);
          return res.status(500).json({ error: insertError.message });
        }
        console.log('[Update Role Member Field Permissions] Inserted:', insertedData);
      }

      res.json({ success: true, count: permissionsToInsert.length });
    } catch (error) {
      console.error('[Update Role Member Field Permissions] Error:', error);
      res.status(500).json({ error: 'Failed to update member field permissions' });
    }
  });

  // Get member field permissions for the current member's role (for About-me/Preferences page)
  app.get('/api/my-member-field-permissions', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      const memberEmail = req.session?.memberEmail;
      if (!memberEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get member's role
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('role_id')
        .ilike('email', memberEmail)
        .single();

      if (memberError || !member) {
        console.error('[Get My Member Field Permissions] Member error:', memberError);
        return res.status(404).json({ error: 'Member not found' });
      }

      if (!member.role_id) {
        // No role assigned, return empty (default to read_write for all)
        return res.json({});
      }

      const { data: permissions, error: fetchError } = await supabase
        .from('role_member_field_permission')
        .select('*')
        .eq('role_id', member.role_id);

      if (fetchError) {
        console.error('[Get My Member Field Permissions] Error:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }

      // Convert to a map for easier frontend usage
      const permissionMap: Record<string, string> = {};
      (permissions || []).forEach((p: any) => {
        permissionMap[p.field_key] = p.permission;
      });

      res.json(permissionMap);
    } catch (error) {
      console.error('[Get My Member Field Permissions] Error:', error);
      res.status(500).json({ error: 'Failed to get member field permissions' });
    }
  });

  // ============ Migration Routes ============
  
  // Fix PortalMenu parent_id values (one-time migration)
  // Converts legacy Base44 parent_id references to new Supabase UUIDs
  app.post('/api/migrate/portal-menu-parents', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      // Get all PortalMenu items
      const { data: allItems, error: fetchError } = await supabase
        .from('portal_menu')
        .select('*');

      if (fetchError) {
        return res.status(500).json({ error: fetchError.message });
      }

      if (!allItems || allItems.length === 0) {
        return res.json({ message: 'No PortalMenu items found', updated: 0 });
      }

      // Find items with parent_id that might need fixing
      // (parent_id is not null and doesn't match any current id)
      const currentIds = new Set(allItems.map((item: any) => item.id));
      const itemsWithOrphanedParent = allItems.filter((item: any) => 
        item.parent_id && !currentIds.has(item.parent_id)
      );

      console.log('[Migration] Items with orphaned parent_id:', itemsWithOrphanedParent.length);

      // Define parent title patterns for matching children
      const parentTitlePatterns: Record<string, string[]> = {
        'News': ['All News', 'Write a News Post', 'Create News'],
        'Blogs': ['All Blogs', 'My Blogs', 'Write a Blog', 'Create Blog'],
        'Team': ['My Team', 'Team Members', 'Our Team'],
        'Articles': ['All Articles', 'My Articles', 'Write Article'],
        'Resources': ['All Resources', 'My Resources', 'Resource List'],
        'Role Management': ['Manage Roles', 'Role Assignment', 'Assign Roles', 'Member Role'],
        'Directory Admin': ['Member Directory', 'Organisation Directory', 'University Directory'],
        'Event Admin': ['Event Settings', 'Manage Events', 'Event List'],
        'Job Board Admin': ['Job Postings', 'My Job Postings', 'Job Settings'],
        'Award Admin': ['Award Management', 'Wall of Fame', 'Manage Awards'],
        'Forms Admin': ['Form Management', 'Form Submissions', 'Manage Forms'],
        'Support Admin': ['Support Tickets', 'Manage Support', 'Support Management'],
        'iConnect System': ['Navigation', 'Page Builder', 'Banners', 'Tours', 'Templates', 'Button Styles', 'System Settings'],
        'News Admin': ['News Management', 'News Settings', 'Manage News'],
        'Blog Admin': ['Blog Management', 'Blog Settings', 'Manage Blog', 'Article Management', 'Articles Settings'],
        'Resource Admin': ['Resource Management', 'Resource Settings', 'Category Management', 'Tag Management'],
        'Category Admin': ['Categories', 'Tag Management', 'Manage Categories'],
        'File Repository': ['File Management', 'Manage Files'],
        'Floater Admin': ['Floater Management', 'Manage Floaters'],
        'Page Builder': ['Page Management', 'Template Management', 'iEdit Pages', 'iEdit Templates'],
        'Member Groups': ['Group Management', 'Manage Groups'],
      };

      // Build a mapping of parent titles to their new UUIDs (for items without parent_id)
      const parentItems = allItems.filter((item: any) => !item.parent_id);
      const parentTitleToId: Record<string, { id: string; section: string }> = {};
      parentItems.forEach((parent: any) => {
        parentTitleToId[parent.title] = { id: parent.id, section: parent.section };
      });

      console.log('[Migration] Parent items found:', Object.keys(parentTitleToId));

      // Track updates
      const updates: { id: string; title: string; oldParentId: string; newParentId: string }[] = [];

      // For each orphaned child, try to find its parent
      for (const child of itemsWithOrphanedParent) {
        let newParentId: string | null = null;
        let matchedParentTitle: string | null = null;

        // First, try exact pattern matching
        for (const [parentTitle, childTitles] of Object.entries(parentTitlePatterns)) {
          if (childTitles.some(ct => child.title.includes(ct) || ct.includes(child.title))) {
            // Check if parent exists in same section or admin section
            const parent = parentTitleToId[parentTitle];
            if (parent && (parent.section === child.section || parent.section === 'admin')) {
              newParentId = parent.id;
              matchedParentTitle = parentTitle;
              break;
            }
          }
        }

        // If no pattern match, try fuzzy matching by checking if child title contains parent title
        if (!newParentId) {
          for (const [parentTitle, parent] of Object.entries(parentTitleToId)) {
            if (parent.section === child.section) {
              // Check if child title suggests it belongs to this parent
              const parentWords = parentTitle.toLowerCase().split(' ');
              const childWords = child.title.toLowerCase().split(' ');
              if (parentWords.some((pw: string) => childWords.includes(pw) && pw.length > 3)) {
                newParentId = parent.id;
                matchedParentTitle = parentTitle;
                break;
              }
            }
          }
        }

        if (newParentId) {
          // Update the parent_id in Supabase
          const { error: updateError } = await supabase
            .from('portal_menu')
            .update({ parent_id: newParentId })
            .eq('id', child.id);

          if (updateError) {
            console.error('[Migration] Error updating', child.title, ':', updateError.message);
          } else {
            updates.push({
              id: child.id,
              title: child.title,
              oldParentId: child.parent_id,
              newParentId: newParentId
            });
            console.log(`[Migration] Updated "${child.title}" -> parent "${matchedParentTitle}" (${newParentId})`);
          }
        } else {
          console.log(`[Migration] Could not find parent for "${child.title}" (orphaned parent_id: ${child.parent_id})`);
        }
      }

      // Return summary
      const orphanedRemaining = itemsWithOrphanedParent.length - updates.length;
      res.json({
        message: 'Migration completed',
        totalItems: allItems.length,
        orphanedBefore: itemsWithOrphanedParent.length,
        updated: updates.length,
        orphanedRemaining: orphanedRemaining,
        updates: updates
      });

    } catch (error) {
      console.error('Migration error:', error);
      res.status(500).json({ error: 'Failed to migrate PortalMenu parents' });
    }
  });

  // ============ Function Routes ============
  
  // Send Magic Link
  app.post('/api/functions/sendMagicLink', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ success: false, error: 'Email is required' });
      }

      // Check if member exists
      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id, email, first_name')
        .eq('email', email.toLowerCase())
        .single();

      if (memberError || !member) {
        return res.json({ success: false, error: 'No member found with this email address' });
      }

      // Generate magic link token
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      // Store magic link
      const { error: linkError } = await supabase
        .from('magic_links')
        .insert({
          member_id: member.id,
          token,
          email: email.toLowerCase(),
          expires_at: expiresAt.toISOString(),
          used: false
        });

      if (linkError) {
        console.error('Failed to create magic link:', linkError);
        return res.status(500).json({ success: false, error: 'Failed to create login link' });
      }

      // In production, send email with magic link
      // For now, log it and return success
      const magicLinkUrl = `${req.protocol}://${req.get('host')}/auth/verify?token=${token}`;
      console.log(`Magic link for ${email}: ${magicLinkUrl}`);

      // TODO: Send email via SendGrid, Resend, or another email service
      // await sendEmail({ to: email, subject: 'Your login link', body: ... });

      res.json({ success: true });
    } catch (error) {
      console.error('Send magic link error:', error);
      res.status(500).json({ success: false, error: 'Failed to send login link' });
    }
  });

  // Verify Magic Link
  app.post('/api/functions/verifyMagicLink', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ success: false, error: 'Token is required' });
      }

      // Find magic link
      const { data: magicLink, error: linkError } = await supabase
        .from('magic_links')
        .select('*, members(*)')
        .eq('token', token)
        .eq('used', false)
        .single();

      if (linkError || !magicLink) {
        return res.json({ success: false, error: 'Invalid or expired link' });
      }

      // Check if expired
      if (new Date(magicLink.expires_at) < new Date()) {
        return res.json({ success: false, error: 'Link has expired' });
      }

      // Mark as used
      await supabase
        .from('magic_links')
        .update({ used: true })
        .eq('id', magicLink.id);

      // Get full member data
      const { data: memberData } = await supabase
        .from('member')
        .select('*')
        .eq('id', magicLink.member_id)
        .single();

      let member = memberData;

      // Check if login is enabled for this member
      if (member && member.login_enabled === false) {
        console.log('[verifyMagicLink] Login disabled for member:', magicLink.email);
        return res.status(403).json({ success: false, error: 'Login is disabled for this account. Please contact an administrator.' });
      }

      // Assign default "Member" role if user has no role_id
      if (member && !member.role_id) {
        console.log('[verifyMagicLink] Member has no role, assigning default "Member" role');
        try {
          const { data: allRoles } = await supabase
            .from('role')
            .select('*');
          
          // Find role named "Member" or fallback to default role
          const memberRole = allRoles?.find((r: any) => r.name === 'Member');
          const defaultRole = memberRole || allRoles?.find((r: any) => r.is_default === true);
          
          if (defaultRole) {
            await supabase
              .from('member')
              .update({ role_id: defaultRole.id })
              .eq('id', member.id);
            
            member = { ...member, role_id: defaultRole.id };
            console.log('[verifyMagicLink] Assigned role:', defaultRole.name, 'to member:', member.email);
          }
        } catch (roleError: any) {
          console.error('[verifyMagicLink] Error assigning default role:', roleError.message);
        }
      }

      // Establish server session for cross-tab persistence
      req.session.memberId = magicLink.member_id;
      req.session.memberEmail = magicLink.email;

      // Save session explicitly and return success
      req.session.save((err) => {
        if (err) {
          console.error('[verifyMagicLink] Session save error:', err);
          return res.status(500).json({ success: false, error: 'Failed to create session' });
        }
        console.log('[verifyMagicLink] Session established for:', magicLink.email);
        res.json({ success: true, user: member });
      });
    } catch (error) {
      console.error('Verify magic link error:', error);
      res.status(500).json({ success: false, error: 'Failed to verify link' });
    }
  });

  // Validate Member
  app.post('/api/functions/validateMember', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email } = req.body;

      console.log('[validateMember] Validating member:', email);

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      // Check Member entity - all authentication flows through member table
      // Admin access is controlled via Role Management (member.role_id -> role.is_admin)
      const { data: localMembers } = await supabase
        .from('member')
        .select('*')
        .ilike('email', email)
        .limit(1);

      let member = localMembers && localMembers.length > 0 ? localMembers[0] : null;
      
      // Step 3: ALWAYS validate and sync from Zoho CRM (one-way CRM -> app sync)
      const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';
      const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
      const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
      const zohoConfigured = ZOHO_CRM_API_DOMAIN && ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET;

      if (zohoConfigured) {
        console.log('[validateMember] Zoho configured, validating member against CRM...');
        
        try {
          // Get valid Zoho access token
          const accessToken = await getValidZohoAccessToken();
          
          // Search Zoho CRM for contact by email
          const criteria = `(Email:equals:${email})`;
          const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}`;
          
          const searchResponse = await fetch(searchUrl, {
            headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
          });

          if (!searchResponse.ok) {
            console.log('[validateMember] CRM search failed, status:', searchResponse.status);
            // If member exists locally, allow login with local data
            if (!member) {
              return res.status(404).json({
                success: false,
                error: 'Email not found. Please check your email address or contact support.'
              });
            }
          } else {
            const searchData = await searchResponse.json() as any;
            
            if (!searchData.data || searchData.data.length === 0) {
              console.log('[validateMember] Email not found in Zoho CRM');
              // If member exists locally but not in CRM, they may be deactivated - deny login
              if (!member) {
                return res.status(404).json({
                  success: false,
                  error: 'Email not found. Please check your email address or contact support.'
                });
              }
              // Member exists locally but not in CRM - could be legacy or deactivated
              // Allow login but log warning
              console.log('[validateMember] WARNING: Member exists locally but not in CRM:', email);
            } else {
              // Found contact in CRM - sync data
              const contact = searchData.data[0];
              console.log('[validateMember] Found contact in Zoho CRM:', contact.Email, 'zoho_contact_id:', contact.id);

              // Get organization details if contact is linked to an account
              let crmOrganizationId = null;
              if (contact.Account_Name?.id) {
                console.log('[validateMember] Contact linked to Zoho Account:', contact.Account_Name.name, 'id:', contact.Account_Name.id);
                
                const accountUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${contact.Account_Name.id}`;
                const accountResponse = await fetch(accountUrl, {
                  headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
                });

                if (accountResponse.ok) {
                  const accountData = await accountResponse.json() as any;
                  const account = accountData.data[0];
                  console.log('[validateMember] Fetched Account details:', account.Account_Name);

                  // Check if organization exists in Supabase, create if not
                  const { data: existingOrgs } = await supabase
                    .from('organization')
                    .select('*')
                    .eq('zoho_account_id', account.id);

                  if (existingOrgs && existingOrgs.length > 0) {
                    crmOrganizationId = existingOrgs[0].id;
                    // Update organization data from CRM
                    await supabase
                      .from('organization')
                      .update({
                        name: account.Account_Name,
                        training_fund_balance: account.Training_Fund_Balance || 0,
                        purchase_order_enabled: account.Purchase_Order_Enabled || false,
                        last_synced: new Date().toISOString()
                      })
                      .eq('id', existingOrgs[0].id);
                    console.log('[validateMember] Updated organization from CRM:', account.Account_Name);
                  } else {
                    // Create new organization from CRM data
                    const { data: newOrg } = await supabase
                      .from('organization')
                      .insert({
                        name: account.Account_Name,
                        zoho_account_id: account.id,
                        training_fund_balance: account.Training_Fund_Balance || 0,
                        purchase_order_enabled: account.Purchase_Order_Enabled || false,
                        last_synced: new Date().toISOString()
                      })
                      .select()
                      .single();
                    crmOrganizationId = newOrg?.id;
                    console.log('[validateMember] Created new organization from CRM:', account.Account_Name);
                  }
                }
              } else {
                console.log('[validateMember] Contact has no linked Account in CRM');
              }

              // Check if member exists by zoho_contact_id (handles email changes in CRM)
              const { data: existingMemberByZohoId } = await supabase
                .from('member')
                .select('*')
                .eq('zoho_contact_id', contact.id)
                .limit(1);

              if (existingMemberByZohoId && existingMemberByZohoId.length > 0) {
                // Update existing member with latest CRM data
                console.log('[validateMember] Updating existing member with CRM data');
                const existingMember = existingMemberByZohoId[0];
                await supabase
                  .from('member')
                  .update({ 
                    email: email.toLowerCase(),
                    first_name: contact.First_Name,
                    last_name: contact.Last_Name,
                    organization_id: crmOrganizationId,
                    last_synced: new Date().toISOString()
                  })
                  .eq('id', existingMember.id);
                
                member = { 
                  ...existingMember, 
                  email, 
                  first_name: contact.First_Name, 
                  last_name: contact.Last_Name,
                  organization_id: crmOrganizationId
                };
              } else if (member) {
                // Member exists by email but not by zoho_contact_id - link them
                console.log('[validateMember] Linking existing member to CRM contact');
                await supabase
                  .from('member')
                  .update({ 
                    zoho_contact_id: contact.id,
                    first_name: contact.First_Name,
                    last_name: contact.Last_Name,
                    organization_id: crmOrganizationId,
                    last_synced: new Date().toISOString()
                  })
                  .eq('id', member.id);
                
                member = { 
                  ...member, 
                  zoho_contact_id: contact.id,
                  first_name: contact.First_Name, 
                  last_name: contact.Last_Name,
                  organization_id: crmOrganizationId
                };
              } else {
                // Create new member from CRM data
                console.log('[validateMember] Creating new member from CRM');
                const { data: allRoles } = await supabase
                  .from('role')
                  .select('*');
                const defaultRole = allRoles?.find((r: any) => r.is_default === true);

                const memberData: any = {
                  email: email.toLowerCase(),
                  first_name: contact.First_Name,
                  last_name: contact.Last_Name,
                  zoho_contact_id: contact.id,
                  organization_id: crmOrganizationId,
                  last_synced: new Date().toISOString(),
                  login_enabled: true
                };

                if (defaultRole) {
                  memberData.role_id = defaultRole.id;
                }

                const { data: newMember, error: insertError } = await supabase
                  .from('member')
                  .insert(memberData)
                  .select()
                  .single();

                if (insertError) {
                  console.error('[validateMember] Failed to create member:', insertError);
                  return res.status(500).json({
                    success: false,
                    error: 'Failed to create member record'
                  });
                }

                member = newMember;
                console.log('[validateMember] Created new member from CRM:', member.email);
              }
            }
          }
        } catch (crmError: any) {
          console.error('[validateMember] CRM sync error:', crmError.message);
          // If member exists locally, allow login with local data even if CRM fails
          if (!member) {
            return res.status(404).json({
              success: false,
              error: 'Email not found. Please check your email address or contact support.'
            });
          }
          console.log('[validateMember] CRM sync failed, using local member data');
        }
      } else {
        console.log('[validateMember] Zoho not configured, using local data only');
        if (!member) {
          return res.status(404).json({
            success: false,
            error: 'Email not found. Please check your email address or contact support.'
          });
        }
      }
      
      // Final check - member must exist at this point
      if (!member) {
        return res.status(404).json({
          success: false,
          error: 'Email not found. Please check your email address or contact support.'
        });
      }

      console.log('[validateMember] Found Member record');

      // Auto-generate handle if member doesn't have one
      if (!member.handle && member.first_name && member.last_name) {
        console.log('[validateMember] Member has no handle, generating one...');
        
        try {
          // Helper function to generate slug
          const generateSlug = (text: string): string => {
            return text
              .toLowerCase()
              .trim()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');
          };

          // Get all existing handles to ensure uniqueness
          const { data: allMembersForHandles } = await supabase
            .from('member')
            .select('handle');
          
          const existingHandles = new Set<string>(
            (allMembersForHandles || [])
              .map((m: any) => m.handle)
              .filter((h: string | null) => h !== null)
          );

          // Generate base handle from name
          let baseHandle = `${generateSlug(member.first_name)}-${generateSlug(member.last_name)}`;
          
          if (baseHandle.length < 3) {
            baseHandle = generateSlug(member.first_name);
          }
          if (baseHandle.length < 3) {
            baseHandle = generateSlug(member.last_name);
          }
          if (baseHandle.length < 3) {
            baseHandle = 'member';
          }
          if (baseHandle.length > 30) {
            baseHandle = baseHandle.substring(0, 30);
          }

          // Make handle unique
          let handle = baseHandle;
          let counter = 1;

          while (existingHandles.has(handle)) {
            const suffix = `-${counter}`;
            const maxBaseLength = 30 - suffix.length;
            handle = baseHandle.substring(0, maxBaseLength) + suffix;
            counter++;
          }

          // Save the handle to the member record
          const { error: updateError } = await supabase
            .from('member')
            .update({ handle })
            .eq('id', member.id);

          if (updateError) {
            console.error('[validateMember] Failed to save handle:', updateError);
          } else {
            member.handle = handle;
            console.log('[validateMember] Generated and saved handle:', handle);
          }
        } catch (handleError: any) {
          console.error('[validateMember] Error generating handle:', handleError.message);
          // Don't fail the login if handle generation fails
        }
      }

      // Assign default "Member" role if user has no role_id
      if (!member.role_id) {
        console.log('[validateMember] Member has no role, assigning default "Member" role');
        try {
          const { data: allRoles } = await supabase
            .from('role')
            .select('*');
          
          // Find role named "Member" or fallback to default role
          const memberRole = allRoles?.find((r: any) => r.name === 'Member');
          const defaultRole = memberRole || allRoles?.find((r: any) => r.is_default === true);
          
          if (defaultRole) {
            await supabase
              .from('member')
              .update({ role_id: defaultRole.id })
              .eq('id', member.id);
            
            member.role_id = defaultRole.id;
            console.log('[validateMember] Assigned role:', defaultRole.name, 'to member:', member.email);
          } else {
            console.log('[validateMember] No "Member" or default role found');
          }
        } catch (roleError: any) {
          console.error('[validateMember] Error assigning default role:', roleError.message);
          // Don't fail the login if role assignment fails
        }
      }

      let organizationId = member.organization_id;
      let organizationName = null;
      let trainingFundBalance = 0;
      let purchaseOrderEnabled = false;
      let programTicketBalances = {};

      if (organizationId) {
        const { data: allOrgs } = await supabase
          .from('organization')
          .select('*');

        let org = allOrgs?.find((o: any) => o.id === organizationId);

        if (!org) {
          org = allOrgs?.find((o: any) => o.zoho_account_id === organizationId);
        }

        if (org) {
          organizationName = org.name;
          organizationId = org.id;
          trainingFundBalance = org.training_fund_balance || 0;
          purchaseOrderEnabled = org.purchase_order_enabled || false;
          programTicketBalances = org.program_ticket_balances || {};
        }
      }

      res.json({
        success: true,
        member: {
          id: member.id,
          email: member.email,
          first_name: member.first_name,
          last_name: member.last_name,
          handle: member.handle || null,
          organization_id: organizationId,
          organization_name: organizationName,
          training_fund_balance: trainingFundBalance,
          purchase_order_enabled: purchaseOrderEnabled,
          program_ticket_balances: programTicketBalances,
          role_id: member.role_id || null,
          member_excluded_features: member.member_excluded_features || [],
          has_seen_onboarding_tour: member.has_seen_onboarding_tour || false,
          is_team_member: false
        }
      });

    } catch (error: any) {
      console.error('[validateMember] ERROR:', error);
      res.status(500).json({
        success: false,
        error: 'Unable to validate member. Please try again later.',
        details: error.message
      });
    }
  });

  // Get Stripe Publishable Key
  app.post('/api/functions/getStripePublishableKey', async (req: Request, res: Response) => {
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    
    if (!publishableKey) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    res.json({ publishableKey });
  });

  // Create Stripe Payment Intent
  app.post('/api/functions/createStripePaymentIntent', async (req: Request, res: Response) => {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    
    if (!stripeSecretKey) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    try {
      // Dynamic import for Stripe
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(stripeSecretKey);

      const { amount, currency = 'gbp', metadata } = req.body;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to pence
        currency,
        metadata
      });

      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
      console.error('Stripe error:', error);
      res.status(500).json({ error: 'Failed to create payment intent' });
    }
  });

  // Sync Member from CRM (Zoho)
  app.post('/api/functions/syncMemberFromCRM', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      const { email, accessToken } = req.body;

      if (!email || !accessToken) {
        return res.status(400).json({
          error: 'Missing required parameters',
          required: ['email', 'accessToken']
        });
      }

      // Search for contact in Zoho CRM by email
      const searchResponse = await fetch(
        `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?email=${encodeURIComponent(email)}`,
        {
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
          },
        }
      );

      const searchData = await searchResponse.json();

      if (!searchResponse.ok || !searchData.data || searchData.data.length === 0) {
        return res.status(404).json({
          error: 'Member not found in CRM',
          email: email
        });
      }

      const contact = searchData.data[0];

      // Get associated Account (Organization) details
      let organizationName = null;
      let organizationId = null;
      let trainingFundBalance = 0;
      let purchaseOrderEnabled = false;
      let domain = null;
      let additionalVerifiedDomains: string[] = [];

      if (contact.Account_Name?.id) {
        const accountResponse = await fetch(
          `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${contact.Account_Name.id}`,
          {
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`,
            },
          }
        );

        if (accountResponse.ok) {
          const accountData = await accountResponse.json();
          const account = accountData.data[0];

          organizationName = account.Account_Name;
          organizationId = account.id;
          trainingFundBalance = account.Training_Fund_Balance || 0;
          purchaseOrderEnabled = account.Purchase_Order_Enabled || false;
          domain = account.Domain || null;
          additionalVerifiedDomains = account.Additional_verified_domains || [];

          // Create or update Organization in Supabase
          const { data: existingOrgs } = await supabase
            .from('organization')
            .select('id')
            .eq('zoho_account_id', organizationId);

          if (existingOrgs && existingOrgs.length > 0) {
            await supabase
              .from('organization')
              .update({
                name: organizationName,
                domain: domain,
                additional_verified_domains: additionalVerifiedDomains,
                training_fund_balance: trainingFundBalance,
                purchase_order_enabled: purchaseOrderEnabled,
                last_synced: new Date().toISOString()
              })
              .eq('id', existingOrgs[0].id);
          } else {
            await supabase
              .from('organization')
              .insert({
                name: organizationName,
                zoho_account_id: organizationId,
                domain: domain,
                additional_verified_domains: additionalVerifiedDomains,
                training_fund_balance: trainingFundBalance,
                purchase_order_enabled: purchaseOrderEnabled,
                last_synced: new Date().toISOString()
              });
          }
        }
      }

      // Create or update Member in Supabase
      const { data: existingMembers } = await supabase
        .from('member')
        .select('*')
        .ilike('email', email);

      const memberData = {
        email: email.toLowerCase(),
        first_name: contact.First_Name,
        last_name: contact.Last_Name,
        zoho_contact_id: contact.id,
        organization_id: organizationId,
        last_synced: new Date().toISOString()
      };

      let member;
      if (existingMembers && existingMembers.length > 0) {
        const { data: updatedMember } = await supabase
          .from('member')
          .update(memberData)
          .eq('id', existingMembers[0].id)
          .select()
          .single();
        member = updatedMember || { ...existingMembers[0], ...memberData };
      } else {
        const { data: newMember } = await supabase
          .from('member')
          .insert(memberData)
          .select()
          .single();
        member = newMember;
      }

      res.json({
        success: true,
        member: {
          ...member,
          organization_name: organizationName,
          training_fund_balance: trainingFundBalance,
          purchase_order_enabled: purchaseOrderEnabled
        }
      });

    } catch (error: any) {
      console.error('Sync member from CRM error:', error);
      res.status(500).json({
        error: 'Failed to sync member data',
        message: error.message
      });
    }
  });

  // Helper function to get valid Zoho access token (refreshes if expired)
  async function getValidZohoAccessToken(): Promise<string> {
    if (!supabase) throw new Error('Supabase not configured');
    
    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';
    const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
    const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;

    const { data: tokens } = await supabase
      .from('zoho_token')
      .select('*')
      .limit(1);

    if (!tokens || tokens.length === 0) {
      throw new Error('No Zoho tokens found. Admin needs to authenticate first.');
    }

    const token = tokens[0];
    const now = new Date();
    const expiresAt = new Date(token.expires_at);

    // If token is still valid, return it
    if (expiresAt > now) {
      return token.access_token;
    }

    // Token expired, need to refresh
    const accountsDomain = ZOHO_CRM_API_DOMAIN.includes('.eu') 
      ? 'https://accounts.zoho.eu' 
      : ZOHO_CRM_API_DOMAIN.includes('.com.au')
        ? 'https://accounts.zoho.com.au'
        : 'https://accounts.zoho.com';

    const refreshResponse = await fetch(`${accountsDomain}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: ZOHO_CLIENT_ID!,
        client_secret: ZOHO_CLIENT_SECRET!,
        refresh_token: token.refresh_token,
      }),
    });

    const refreshData = await refreshResponse.json();

    if (refreshData.error) {
      throw new Error(`Failed to refresh token: ${refreshData.error}`);
    }

    const newExpiresAt = new Date(Date.now() + (refreshData.expires_in * 1000)).toISOString();

    await supabase
      .from('zoho_token')
      .update({
        access_token: refreshData.access_token,
        expires_at: newExpiresAt,
      })
      .eq('id', token.id);

    return refreshData.access_token;
  }

  // Refresh Member Balance from Zoho CRM
  app.post('/api/functions/refreshMemberBalance', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email required' });
      }

      const accessToken = await getValidZohoAccessToken();

      // Get member by email directly (case-insensitive)
      const { data: members, error: memberError } = await supabase
        .from('member')
        .select('*')
        .ilike('email', email);
      
      const member = members?.[0];

      if (memberError || !member) {
        return res.status(404).json({
          error: 'Member not found',
          searchedEmail: email
        });
      }

      // Fetch fresh contact data from Zoho
      const contactResponse = await fetch(
        `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/${member.zoho_contact_id}`,
        { headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` } }
      );

      if (!contactResponse.ok) {
        return res.status(500).json({ error: 'Failed to fetch contact' });
      }

      const contactData = await contactResponse.json();
      const contact = contactData.data[0];

      // Update member last synced
      await supabase
        .from('member')
        .update({ last_synced: new Date().toISOString() })
        .eq('id', member.id);

      let trainingFundBalance = 0;
      let purchaseOrderEnabled = false;

      if (member.organization_id && contact.Account_Name?.id) {
        const accountResponse = await fetch(
          `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${contact.Account_Name.id}`,
          { headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` } }
        );

        if (accountResponse.ok) {
          const accountData = await accountResponse.json();
          const account = accountData.data[0];

          trainingFundBalance = account.Training_fund_balance || 0;
          purchaseOrderEnabled = account.Purchase_Order_Enabled || false;

          // Find and update organization
          const { data: allOrgs } = await supabase
            .from('organization')
            .select('*');

          const org = allOrgs?.find((o: any) => o.zoho_account_id === contact.Account_Name.id);

          if (org) {
            await supabase
              .from('organization')
              .update({
                training_fund_balance: trainingFundBalance,
                purchase_order_enabled: purchaseOrderEnabled,
                last_synced: new Date().toISOString()
              })
              .eq('id', org.id);
          }
        }
      }

      res.json({
        success: true,
        training_fund_balance: trainingFundBalance,
        purchase_order_enabled: purchaseOrderEnabled
      });

    } catch (error: any) {
      console.error('Refresh member balance error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Sync All Organizations from Zoho CRM
  app.post('/api/functions/syncAllOrganizationsFromZoho', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      const accessToken = await getValidZohoAccessToken();
      
      let allAccounts: any[] = [];
      let page = 1;
      let hasMoreRecords = true;

      // Fetch all accounts with pagination (Zoho returns max 200 per page)
      // Zoho v3 API requires explicit fields parameter
      const accountFields = 'Account_Name,Domain,Additional_verified_domains,Training_Fund_Balance,Purchase_Order_Enabled';
      
      while (hasMoreRecords) {
        const accountsResponse = await fetch(
          `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts?fields=${accountFields}&page=${page}&per_page=200`,
          {
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`,
            },
          }
        );

        if (!accountsResponse.ok) {
          const errorText = await accountsResponse.text();
          throw new Error(`Zoho API error: ${accountsResponse.status} - ${errorText}`);
        }

        const accountsData = await accountsResponse.json();
        
        if (accountsData.data && accountsData.data.length > 0) {
          allAccounts = allAccounts.concat(accountsData.data);
          hasMoreRecords = accountsData.info?.more_records || false;
          page++;
        } else {
          hasMoreRecords = false;
        }
      }

      console.log(`[syncAllOrganizationsFromZoho] Fetched ${allAccounts.length} accounts from Zoho`);

      let created = 0;
      let updated = 0;
      let processed = 0;
      const totalOrgs = allAccounts.length;
      let errors: Array<{ accountId: string; name: string; error: string }> = [];

      for (const account of allAccounts) {
        try {
          const orgData = {
            name: account.Account_Name,
            zoho_account_id: account.id,
            domain: account.Domain || null,
            additional_verified_domains: account.Additional_verified_domains || [],
            training_fund_balance: account.Training_Fund_Balance || 0,
            purchase_order_enabled: account.Purchase_Order_Enabled || false,
            last_synced: new Date().toISOString(),
          };

          // Check if organization exists by zoho_account_id
          const { data: existingOrgs } = await supabase
            .from('organization')
            .select('id')
            .eq('zoho_account_id', account.id);

          if (existingOrgs && existingOrgs.length > 0) {
            // Update existing organization
            await supabase
              .from('organization')
              .update(orgData)
              .eq('id', existingOrgs[0].id);
            updated++;
          } else {
            // Check if organization exists by name (migrated data without zoho_account_id)
            const { data: orgsByName } = await supabase
              .from('organization')
              .select('id')
              .eq('name', account.Account_Name);

            if (orgsByName && orgsByName.length > 0) {
              // Update existing organization and set zoho_account_id
              await supabase
                .from('organization')
                .update(orgData)
                .eq('id', orgsByName[0].id);
              updated++;
            } else {
              // Create new organization
              await supabase
                .from('organization')
                .insert(orgData);
              created++;
            }
          }
        } catch (err: any) {
          errors.push({
            accountId: account.id,
            name: account.Account_Name,
            error: err.message
          });
        }
        
        processed++;
        if (processed % 25 === 0 || processed === totalOrgs) {
          console.log(`[syncAllOrganizationsFromZoho] Progress: ${processed}/${totalOrgs} organizations processed (${created} created, ${updated} updated)`);
        }
      }

      console.log(`[syncAllOrganizationsFromZoho] Completed: ${created} created, ${updated} updated, ${errors.length} errors`);

      res.json({
        success: true,
        total_fetched: allAccounts.length,
        created,
        updated,
        errors: errors.length,
        error_details: errors.length > 0 ? errors : undefined
      });

    } catch (error: any) {
      console.error('Sync all organizations error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Sync Single Organization from Zoho CRM
  app.post('/api/functions/syncSingleOrganizationFromZoho', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const { zoho_account_id, organization_id } = req.body;
    
    if (!zoho_account_id && !organization_id) {
      return res.status(400).json({ error: 'Either zoho_account_id or organization_id is required' });
    }

    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      const accessToken = await getValidZohoAccessToken();
      
      let zohoAccountId = zoho_account_id;
      let existingOrg: any = null;

      // If organization_id provided, look up the zoho_account_id
      if (organization_id && !zoho_account_id) {
        const { data: orgs } = await supabase
          .from('organization')
          .select('id, name, zoho_account_id')
          .eq('id', organization_id);

        if (!orgs || orgs.length === 0) {
          return res.status(404).json({ error: 'Organization not found' });
        }
        
        existingOrg = orgs[0];
        zohoAccountId = existingOrg.zoho_account_id;
        
        if (!zohoAccountId) {
          return res.status(400).json({ 
            error: 'This organization is not linked to Zoho CRM (no zoho_account_id)',
            organization: { id: existingOrg.id, name: existingOrg.name }
          });
        }
      }

      console.log(`[syncSingleOrganizationFromZoho] Fetching account ${zohoAccountId} from Zoho`);

      // Fetch the specific account from Zoho
      const accountFields = 'Account_Name,Domain,Additional_verified_domains,Training_Fund_Balance,Purchase_Order_Enabled';
      const accountResponse = await fetch(
        `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${zohoAccountId}?fields=${accountFields}`,
        {
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
          },
        }
      );

      if (!accountResponse.ok) {
        const errorText = await accountResponse.text();
        if (accountResponse.status === 404) {
          return res.status(404).json({ error: 'Account not found in Zoho CRM', zoho_account_id: zohoAccountId });
        }
        throw new Error(`Zoho API error: ${accountResponse.status} - ${errorText}`);
      }

      const accountData = await accountResponse.json();
      const account = accountData.data?.[0];

      if (!account) {
        return res.status(404).json({ error: 'Account data not found in Zoho response' });
      }

      console.log(`[syncSingleOrganizationFromZoho] Found account: ${account.Account_Name}`);

      const orgData = {
        name: account.Account_Name,
        zoho_account_id: account.id,
        domain: account.Domain || null,
        additional_verified_domains: account.Additional_verified_domains || [],
        training_fund_balance: account.Training_Fund_Balance || 0,
        purchase_order_enabled: account.Purchase_Order_Enabled || false,
        last_synced: new Date().toISOString(),
      };

      let action: 'created' | 'updated' = 'updated';
      let orgId: string;

      // Check if organization exists by zoho_account_id
      const { data: existingOrgs } = await supabase
        .from('organization')
        .select('id, name')
        .eq('zoho_account_id', account.id);

      if (existingOrgs && existingOrgs.length > 0) {
        // Update existing organization
        await supabase
          .from('organization')
          .update(orgData)
          .eq('id', existingOrgs[0].id);
        orgId = existingOrgs[0].id;
        action = 'updated';
      } else {
        // Check if organization exists by name (migrated data without zoho_account_id)
        const { data: orgsByName } = await supabase
          .from('organization')
          .select('id')
          .eq('name', account.Account_Name);

        if (orgsByName && orgsByName.length > 0) {
          // Update existing organization and set zoho_account_id
          await supabase
            .from('organization')
            .update(orgData)
            .eq('id', orgsByName[0].id);
          orgId = orgsByName[0].id;
          action = 'updated';
        } else {
          // Create new organization with created_at
          const { data: newOrg } = await supabase
            .from('organization')
            .insert({ ...orgData, created_at: new Date().toISOString() })
            .select('id')
            .single();
          orgId = newOrg?.id;
          action = 'created';
        }
      }

      console.log(`[syncSingleOrganizationFromZoho] ${action}: ${account.Account_Name} (${orgId})`);

      // Now sync members belonging to this organization
      let memberStats = {
        attempted: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [] as Array<{ email: string; error: string }>
      };

      try {
        // Fetch contacts belonging to this Zoho Account using search API
        const contactFields = 'First_Name,Last_Name,Email,Account_Name';
        const searchCriteria = `(Account_Name.id:equals:${account.id})`;
        
        let allContacts: any[] = [];
        let page = 1;
        let hasMoreRecords = true;

        while (hasMoreRecords && page <= 10) {
          const contactsUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(searchCriteria)}&fields=${contactFields}&page=${page}&per_page=200`;
          
          const contactsResponse = await fetch(contactsUrl, {
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`,
            },
          });

          if (contactsResponse.status === 204) {
            // No contacts found for this account
            console.log(`[syncSingleOrganizationFromZoho] No contacts found for account ${account.id}`);
            hasMoreRecords = false;
            break;
          }

          if (!contactsResponse.ok) {
            const errorText = await contactsResponse.text();
            console.error(`[syncSingleOrganizationFromZoho] Error fetching contacts: ${errorText}`);
            break;
          }

          const contactsData = await contactsResponse.json();
          
          if (contactsData.data && contactsData.data.length > 0) {
            allContacts = allContacts.concat(contactsData.data);
            hasMoreRecords = contactsData.info?.more_records || false;
            page++;
          } else {
            hasMoreRecords = false;
          }
        }

        console.log(`[syncSingleOrganizationFromZoho] Found ${allContacts.length} contacts for organization`);
        memberStats.attempted = allContacts.length;

        // Process each contact
        for (const contact of allContacts) {
          try {
            // Skip contacts without email
            if (!contact.Email) {
              memberStats.skipped++;
              continue;
            }

            const memberData = {
              email: contact.Email.toLowerCase(),
              first_name: contact.First_Name || null,
              last_name: contact.Last_Name || null,
              zoho_contact_id: contact.id,
              organization_id: orgId,
              last_synced: new Date().toISOString(),
            };

            // Check if member exists by zoho_contact_id
            const { data: existingByZoho } = await supabase
              .from('member')
              .select('id, organization_id')
              .eq('zoho_contact_id', contact.id);

            if (existingByZoho && existingByZoho.length > 0) {
              // Update existing member
              const { error: updateError } = await supabase
                .from('member')
                .update(memberData)
                .eq('id', existingByZoho[0].id);
              
              if (updateError) {
                console.error(`[syncSingleOrganizationFromZoho] Failed to update member ${contact.Email}:`, updateError);
                memberStats.errors.push({ email: contact.Email, error: updateError.message });
              } else {
                console.log(`[syncSingleOrganizationFromZoho] Updated member ${contact.Email} with org_id ${orgId} (was: ${existingByZoho[0].organization_id})`);
                memberStats.updated++;
              }
            } else {
              // Check if member exists by email
              const { data: existingByEmail } = await supabase
                .from('member')
                .select('id, organization_id')
                .ilike('email', contact.Email);

              if (existingByEmail && existingByEmail.length > 0) {
                // Update existing member and set zoho_contact_id
                const { error: updateError } = await supabase
                  .from('member')
                  .update(memberData)
                  .eq('id', existingByEmail[0].id);
                
                if (updateError) {
                  console.error(`[syncSingleOrganizationFromZoho] Failed to update member by email ${contact.Email}:`, updateError);
                  memberStats.errors.push({ email: contact.Email, error: updateError.message });
                } else {
                  console.log(`[syncSingleOrganizationFromZoho] Updated member by email ${contact.Email} with org_id ${orgId}`);
                  memberStats.updated++;
                }
              } else {
                // Create new member
                const { error: insertError } = await supabase
                  .from('member')
                  .insert(memberData);
                
                if (insertError) {
                  console.error(`[syncSingleOrganizationFromZoho] Failed to create member ${contact.Email}:`, insertError);
                  memberStats.errors.push({ email: contact.Email, error: insertError.message });
                } else {
                  console.log(`[syncSingleOrganizationFromZoho] Created member ${contact.Email} with org_id ${orgId}`);
                  memberStats.created++;
                }
              }
            }
          } catch (err: any) {
            memberStats.errors.push({
              email: contact.Email || 'no-email',
              error: err.message
            });
          }
        }

        console.log(`[syncSingleOrganizationFromZoho] Members synced: ${memberStats.created} created, ${memberStats.updated} updated, ${memberStats.skipped} skipped, ${memberStats.errors.length} errors`);

      } catch (memberSyncError: any) {
        console.error('[syncSingleOrganizationFromZoho] Member sync error:', memberSyncError.message);
        memberStats.errors.push({
          email: 'general',
          error: `Member sync failed: ${memberSyncError.message}`
        });
      }

      res.json({
        success: true,
        action,
        organization: {
          id: orgId,
          name: account.Account_Name,
          zoho_account_id: account.id,
          domain: account.Domain,
          training_fund_balance: account.Training_Fund_Balance || 0,
          purchase_order_enabled: account.Purchase_Order_Enabled || false,
          last_synced: orgData.last_synced
        },
        members: {
          attempted: memberStats.attempted,
          created: memberStats.created,
          updated: memberStats.updated,
          skipped: memberStats.skipped,
          errors: memberStats.errors.length,
          error_details: memberStats.errors.length > 0 ? memberStats.errors.slice(0, 5) : undefined
        }
      });

    } catch (error: any) {
      console.error('Sync single organization error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Sync All Members from Zoho CRM
  app.post('/api/functions/syncAllMembersFromZoho', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      const accessToken = await getValidZohoAccessToken();
      
      // First, get all organizations for lookup
      const { data: allOrgs } = await supabase
        .from('organization')
        .select('id, zoho_account_id, name');

      const orgLookup = new Map<string, string>();
      if (allOrgs) {
        allOrgs.forEach((org: any) => {
          if (org.zoho_account_id) {
            orgLookup.set(org.zoho_account_id, org.id);
          }
        });
      }

      console.log(`[syncAllMembersFromZoho] Loaded ${orgLookup.size} organizations for lookup`);

      let allContacts: any[] = [];
      const contactFields = 'First_Name,Last_Name,Email,Account_Name';
      
      // Phase 1: Fetch first 2000 records using 'page' param (max 10 pages)
      let hasMoreRecords = true;
      let pageToken: string | null = null;
      
      for (let page = 1; page <= 10 && hasMoreRecords; page++) {
        const contactsResponse = await fetch(
          `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts?fields=${contactFields}&page=${page}&per_page=200`,
          {
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`,
            },
          }
        );

        if (!contactsResponse.ok) {
          const errorText = await contactsResponse.text();
          throw new Error(`Zoho API error: ${contactsResponse.status} - ${errorText}`);
        }

        const contactsData = await contactsResponse.json();
        
        if (contactsData.data && contactsData.data.length > 0) {
          allContacts = allContacts.concat(contactsData.data);
        }
        
        hasMoreRecords = contactsData.info?.more_records || false;
        
        // Get page_token for records beyond 2000
        if (page === 10 && hasMoreRecords) {
          pageToken = contactsData.info?.next_page_token || null;
        }
      }
      
      // Phase 2: Use page_token for records beyond 2000
      while (pageToken) {
        const contactsResponse = await fetch(
          `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts?fields=${contactFields}&page_token=${pageToken}&per_page=200`,
          {
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`,
            },
          }
        );

        if (!contactsResponse.ok) {
          const errorText = await contactsResponse.text();
          throw new Error(`Zoho API error: ${contactsResponse.status} - ${errorText}`);
        }

        const contactsData = await contactsResponse.json();
        
        if (contactsData.data && contactsData.data.length > 0) {
          allContacts = allContacts.concat(contactsData.data);
        }
        
        pageToken = contactsData.info?.next_page_token || null;
        
        if (!contactsData.info?.more_records) {
          break;
        }
      }

      console.log(`[syncAllMembersFromZoho] Fetched ${allContacts.length} contacts from Zoho`);

      let created = 0;
      let updated = 0;
      let linkedToOrg = 0;
      let processed = 0;
      let skipped = 0;
      const totalContacts = allContacts.length;
      let errors: Array<{ contactId: string; email: string; error: string }> = [];

      for (const contact of allContacts) {
        try {
          // Skip contacts without email
          if (!contact.Email) {
            skipped++;
            processed++;
            if (processed % 100 === 0) {
              console.log(`[syncAllMembersFromZoho] Progress: ${processed}/${totalContacts} contacts processed (${created} created, ${updated} updated, ${skipped} skipped)`);
            }
            continue;
          }

          // Look up organization_id from zoho account
          let organizationId = null;
          if (contact.Account_Name?.id) {
            organizationId = orgLookup.get(contact.Account_Name.id);
            if (organizationId) {
              linkedToOrg++;
            }
          }

          const memberData = {
            email: contact.Email.toLowerCase(),
            first_name: contact.First_Name || null,
            last_name: contact.Last_Name || null,
            zoho_contact_id: contact.id,
            organization_id: organizationId,
            last_synced: new Date().toISOString(),
          };

          // Check if member exists by zoho_contact_id
          const { data: existingByZoho } = await supabase
            .from('member')
            .select('id')
            .eq('zoho_contact_id', contact.id);

          if (existingByZoho && existingByZoho.length > 0) {
            // Update existing member
            await supabase
              .from('member')
              .update(memberData)
              .eq('id', existingByZoho[0].id);
            updated++;
          } else {
            // Check if member exists by email (migrated data without zoho_contact_id)
            const { data: existingByEmail } = await supabase
              .from('member')
              .select('id')
              .ilike('email', contact.Email);

            if (existingByEmail && existingByEmail.length > 0) {
              // Update existing member and set zoho_contact_id
              await supabase
                .from('member')
                .update(memberData)
                .eq('id', existingByEmail[0].id);
              updated++;
            } else {
              // Create new member
              await supabase
                .from('member')
                .insert(memberData);
              created++;
            }
          }
        } catch (err: any) {
          errors.push({
            contactId: contact.id,
            email: contact.Email || 'no-email',
            error: err.message
          });
        }
        
        processed++;
        if (processed % 100 === 0 || processed === totalContacts) {
          console.log(`[syncAllMembersFromZoho] Progress: ${processed}/${totalContacts} contacts processed (${created} created, ${updated} updated, ${linkedToOrg} linked to orgs)`);
        }
      }

      console.log(`[syncAllMembersFromZoho] Completed: ${created} created, ${updated} updated, ${linkedToOrg} linked to orgs, ${skipped} skipped (no email), ${errors.length} errors`);

      res.json({
        success: true,
        total_fetched: allContacts.length,
        created,
        updated,
        linked_to_org: linkedToOrg,
        errors: errors.length,
        error_details: errors.length > 0 ? errors : undefined
      });

    } catch (error: any) {
      console.error('Sync all members error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Sync Events from Zoho Backstage (simple version)
  app.post('/api/functions/syncEventsFromBackstage', async (req: Request, res: Response) => {
    // Redirect to the more complete syncBackstageEvents
    return res.redirect(307, '/api/functions/syncBackstageEvents');
  });

  // Sync Backstage Events (full version with ticket classes)
  app.post('/api/functions/syncBackstageEvents', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const ZOHO_BACKSTAGE_PORTAL_ID = process.env.ZOHO_BACKSTAGE_PORTAL_ID || '20108049755';
    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      // Use server-side token refresh instead of client-provided token
      const accessToken = await getValidZohoAccessToken();

      // Use the correct API domain based on environment config
      const baseUrl = ZOHO_CRM_API_DOMAIN.replace('/crm/', '/').replace(/\/$/, '') + '/backstage/v3';
      const url = `${baseUrl}/portals/${ZOHO_BACKSTAGE_PORTAL_ID}/events?status=live`;

      console.log('Fetching events from:', url);

      const eventsResponse = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`
        }
      });

      if (!eventsResponse.ok) {
        const errorText = await eventsResponse.text();
        console.error('API error:', errorText);
        return res.status(eventsResponse.status).json({
          error: 'Failed to fetch events from Backstage',
          details: errorText,
          url: url,
          status: eventsResponse.status
        });
      }

      const eventsData = await eventsResponse.json();
      const events = eventsData.events || [];
      console.log('Found events:', events.length);

      if (events.length === 0) {
        return res.json({
          success: true,
          synced: 0,
          errors: 0,
          total: 0,
          message: 'No events found in response'
        });
      }

      let syncedCount = 0;
      let errorCount = 0;
      const errors: Array<{ eventId: string; error: string }> = [];

      // Get all existing events
      const { data: allExistingEvents } = await supabase
        .from('event')
        .select('*');

      console.log('Existing events in DB:', allExistingEvents?.length || 0);

      for (const event of events) {
        try {
          console.log('Processing event:', event.name, 'ID:', event.id);

          const programTag = event.tags && event.tags.length > 0 ? event.tags[0] : null;

          // Fetch ticket classes for this event
          const ticketClassesUrl = `${baseUrl}/portals/${ZOHO_BACKSTAGE_PORTAL_ID}/events/${event.id}/ticket_classes`;
          console.log('Fetching ticket classes from:', ticketClassesUrl);

          const ticketClassesResponse = await fetch(ticketClassesUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`
            }
          });

          let ticketTypeId = null;
          let ticketPrice = 0;
          let availableSeats = 0;

          if (ticketClassesResponse.ok) {
            const ticketClassesData = await ticketClassesResponse.json();
            const ticketClasses = ticketClassesData.ticket_classes || [];

            console.log(`Found ${ticketClasses.length} ticket classes for event ${event.name}`);

            // Find the "Member" ticket class (free, might be hidden)
            let memberTicket = ticketClasses.find((tc: any) =>
              tc.translation?.name?.toLowerCase() === 'member' ||
              tc.ticket_class_type_string === 'free'
            );

            // If no member ticket found, use the first ticket class
            if (!memberTicket && ticketClasses.length > 0) {
              memberTicket = ticketClasses[0];
              console.log('No "Member" ticket found, using first ticket class');
            }

            if (memberTicket) {
              ticketTypeId = memberTicket.id.toString();
              ticketPrice = parseFloat(memberTicket.amount || 0);
              availableSeats = parseInt((memberTicket.quantity || 0) - (memberTicket.sold || 0));

              console.log('Selected ticket class:', {
                id: ticketTypeId,
                name: memberTicket.translation?.name,
                price: ticketPrice,
                available: availableSeats,
                type: memberTicket.ticket_class_type_string
              });
            }
          } else {
            const error = await ticketClassesResponse.text();
            console.error('Failed to fetch ticket classes:', error);
          }

          const eventData = {
            title: event.name,
            description: event.description || '',
            program_tag: programTag,
            start_date: event.start_time,
            end_date: event.end_time,
            location: event.venue?.name || 'Online',
            ticket_price: ticketPrice,
            available_seats: availableSeats,
            backstage_event_id: event.id.toString(),
            backstage_ticket_type_id: ticketTypeId,
            image_url: event.banner_url || event.thumbnail_url || null,
            last_synced: new Date().toISOString()
          };

          console.log('Event data to save:', JSON.stringify(eventData, null, 2));

          const existingEvent = allExistingEvents?.find(
            (e: any) => e.backstage_event_id === eventData.backstage_event_id
          );

          if (existingEvent) {
            await supabase
              .from('event')
              .update(eventData)
              .eq('id', existingEvent.id);
            console.log('Updated event:', eventData.title);
          } else {
            await supabase
              .from('event')
              .insert(eventData);
            console.log('Created event:', eventData.title);
          }

          syncedCount++;
        } catch (error: any) {
          console.error(`Error syncing event ${event.id}:`, error);
          errors.push({ eventId: event.id, error: error.message });
          errorCount++;
        }
      }

      res.json({
        success: true,
        synced: syncedCount,
        errors: errorCount,
        total: events.length,
        errorDetails: errors.length > 0 ? errors : undefined
      });

    } catch (error: any) {
      console.error('Fatal sync error:', error);
      res.status(500).json({
        error: 'Failed to sync events',
        message: error.message
      });
    }
  });

  // Helper function to generate booking reference
  function generateBookingReference(): string {
    return 'BK-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  // Helper function to check existing Backstage registrations
  async function checkExistingBackstageRegistrations(
    accessToken: string,
    backstageEventId: string,
    attendeeEmails: string[]
  ): Promise<{ hasDuplicates: boolean; duplicateEmails: string[] }> {
    const portalId = process.env.ZOHO_BACKSTAGE_PORTAL_ID || '20108049755';
    const baseUrl = 'https://www.zohoapis.eu/backstage/v3';

    console.log(`[checkExistingBackstageRegistrations] Checking ${attendeeEmails.length} emails for event ${backstageEventId}`);

    try {
      const ordersUrl = `${baseUrl}/portals/${portalId}/events/${backstageEventId}/orders`;
      const ordersResponse = await fetch(ordersUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`
        }
      });

      if (!ordersResponse.ok) {
        console.error('[checkExistingBackstageRegistrations] Failed to fetch orders:', ordersResponse.status);
        return { hasDuplicates: false, duplicateEmails: [] };
      }

      const ordersData = await ordersResponse.json();
      const orders = ordersData.orders || [];

      console.log(`[checkExistingBackstageRegistrations] Found ${orders.length} existing orders`);

      const registeredEmails = new Set<string>();

      for (const order of orders) {
        const tickets = order.tickets || [];

        if (Array.isArray(tickets)) {
          for (const ticket of tickets) {
            const ticketStatus = ticket.status_string || '';

            if (ticketStatus === 'cancelled' || ticketStatus === 'refunded') {
              continue;
            }

            if (ticket.contact?.email) {
              registeredEmails.add(ticket.contact.email.toLowerCase());
            }
          }
        }
      }

      const duplicateEmails: string[] = [];
      for (const email of attendeeEmails) {
        if (registeredEmails.has(email.toLowerCase())) {
          duplicateEmails.push(email);
        }
      }

      if (duplicateEmails.length > 0) {
        return { hasDuplicates: true, duplicateEmails };
      }

      return { hasDuplicates: false, duplicateEmails: [] };

    } catch (error) {
      console.error('[checkExistingBackstageRegistrations] Error:', error);
      return { hasDuplicates: false, duplicateEmails: [] };
    }
  }

  // Create Booking
  app.post('/api/functions/createBooking', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const portalId = process.env.ZOHO_BACKSTAGE_PORTAL_ID || '20108049755';
    const baseUrl = 'https://www.zohoapis.eu/backstage/v3';

    try {
      const {
        eventId,
        memberEmail,
        attendees,
        registrationMode,
        numberOfLinks = 0,
        ticketsRequired,
        programTag
      } = req.body;

      if (!eventId || !memberEmail) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters: eventId and memberEmail'
        });
      }

      if (registrationMode === 'colleagues' && (!attendees || attendees.length === 0)) {
        return res.status(400).json({
          success: false,
          error: 'No attendees provided for colleagues registration'
        });
      }

      if (registrationMode === 'links' && numberOfLinks < 1) {
        return res.status(400).json({
          success: false,
          error: 'Number of links must be at least 1'
        });
      }

      if (registrationMode === 'self' && (!attendees || attendees.length === 0)) {
        return res.status(400).json({
          success: false,
          error: 'No attendee information provided for self registration'
        });
      }

      // Get member details - query directly by email instead of fetching all
      console.log('[createBooking] Looking up member with email:', memberEmail);
      const { data: memberData, error: memberError } = await supabase
        .from('member')
        .select('*')
        .ilike('email', memberEmail)
        .single();
      
      if (memberError) {
        console.error('[createBooking] Member query error:', memberError);
        return res.status(404).json({
          success: false,
          error: 'Member not found'
        });
      }
      
      const member = memberData;
      console.log('[createBooking] Member found:', member?.id, member?.email);

      // Get event details - query directly by ID
      const { data: eventData, error: eventError } = await supabase
        .from('event')
        .select('*')
        .eq('id', eventId)
        .single();

      if (eventError || !eventData) {
        console.error('[createBooking] Event query error:', eventError);
        return res.status(404).json({
          success: false,
          error: 'Event not found'
        });
      }
      const event = eventData;

      // Check seat availability (null = unlimited seats)
      if (event.available_seats !== null && event.available_seats !== undefined) {
        if (event.available_seats < ticketsRequired) {
          return res.status(400).json({
            success: false,
            error: event.available_seats === 0 
              ? 'This event is sold out' 
              : `Only ${event.available_seats} seat(s) remaining for this event`
          });
        }
      }

      // Check if event requires program tickets
      if (!programTag || !event.program_tag) {
        return res.status(400).json({
          success: false,
          error: 'This event does not have a program association and cannot be booked'
        });
      }

      // Get organization and verify program ticket balance
      if (!member.organization_id) {
        return res.status(400).json({
          success: false,
          error: 'Member does not have an associated organization'
        });
      }

      // Try to find organization by ID first
      let { data: org, error: orgError } = await supabase
        .from('organization')
        .select('*')
        .eq('id', member.organization_id)
        .single();

      // If not found by ID, try by zoho_account_id
      if (orgError || !org) {
        const { data: orgByZoho } = await supabase
          .from('organization')
          .select('*')
          .eq('zoho_account_id', member.organization_id)
          .single();
        org = orgByZoho;
      }

      if (!org) {
        console.error('[createBooking] Organization not found for member.organization_id:', member.organization_id);
        return res.status(404).json({
          success: false,
          error: 'Organization not found'
        });
      }

      // Check program ticket balance
      const currentBalances = org.program_ticket_balances || {};
      const currentBalance = currentBalances[programTag] || 0;

      if (currentBalance < ticketsRequired) {
        return res.status(400).json({
          success: false,
          error: `Insufficient program tickets. Required: ${ticketsRequired}, Available: ${currentBalance}`
        });
      }

      // Check for duplicate registrations in Backstage
      if ((registrationMode === 'self' || registrationMode === 'colleagues') && event.backstage_event_id && attendees) {
        console.log('[createBooking] Checking for duplicate registrations in Backstage...');

        const accessToken = await getValidZohoAccessToken();
        const attendeeEmails = attendees.map((a: any) => a.email).filter(Boolean);

        const duplicateCheck = await checkExistingBackstageRegistrations(
          accessToken,
          event.backstage_event_id,
          attendeeEmails
        );

        if (duplicateCheck.hasDuplicates) {
          const emailList = duplicateCheck.duplicateEmails.join(', ');
          return res.status(409).json({
            success: false,
            error: `The following email address(es) are already registered for this event: ${emailList}. Please remove them and try again.`,
            duplicateEmails: duplicateCheck.duplicateEmails
          });
        }
      }

      // Create bookings
      const bookingReference = generateBookingReference();
      const createdBookings: any[] = [];
      let anyBackstageSyncFailed = false;
      const backstageSyncErrors: string[] = [];
      const individualBackstageOrderDetails: Array<{
        attendeeEmail: string;
        backstageOrderId?: string;
        success: boolean;
        error?: string;
      }> = [];

      // For self/colleagues mode, provision tickets in Backstage
      if ((registrationMode === 'self' || registrationMode === 'colleagues') && event.backstage_event_id) {
        try {
          console.log('[createBooking] Attempting to provision tickets in Backstage...');
          const accessToken = await getValidZohoAccessToken();

          // Fetch ticket classes
          const ticketClassesUrl = `${baseUrl}/portals/${portalId}/events/${event.backstage_event_id}/ticket_classes`;
          const ticketClassesResponse = await fetch(ticketClassesUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`
            }
          });

          if (!ticketClassesResponse.ok) {
            const errorText = await ticketClassesResponse.text();
            console.error('[createBooking] Failed to fetch ticket classes:', errorText);
            anyBackstageSyncFailed = true;
            backstageSyncErrors.push(`Failed to fetch ticket classes: ${errorText}`);
            throw new Error(`Failed to fetch ticket classes: ${errorText}`);
          }

          const ticketClassesData = await ticketClassesResponse.json();
          const ticketClasses = ticketClassesData.ticket_classes || [];

          // Find member ticket class
          let memberTicket = ticketClasses.find((tc: any) =>
            tc.ticket_class_type_string === 'free' &&
            tc.translation?.name?.toLowerCase() === 'member'
          );

          if (!memberTicket) {
            memberTicket = ticketClasses.find((tc: any) => tc.ticket_class_type_string === 'free');
          }

          if (!memberTicket && ticketClasses.length > 0) {
            memberTicket = ticketClasses[0];
          }

          if (!memberTicket) {
            anyBackstageSyncFailed = true;
            backstageSyncErrors.push('No ticket classes available for this event');
            throw new Error('No ticket classes available for this event');
          }

          const ticketClassId = memberTicket.id.toString();

          // Create order for each attendee
          const backstageApiUrl = `${baseUrl}/portals/${portalId}/events/${event.backstage_event_id}/orders`;

          for (const attendee of attendees) {
            const buyerDetails: any = {};
            if (member.first_name) buyerDetails.purchaser_first_name = member.first_name;
            if (member.last_name) buyerDetails.purchaser_last_name = member.last_name;
            if (member.email) buyerDetails.purchaser_email = member.email;
            if (org.name) buyerDetails.purchaser_company = org.name;

            const singleOrderPayload = {
              buyer_details: buyerDetails,
              tickets: [{
                ticketclass_id: ticketClassId,
                data: {
                  first_name: attendee.first_name,
                  last_name: attendee.last_name,
                  email: attendee.email
                }
              }]
            };

            try {
              const individualBackstageResponse = await fetch(backstageApiUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Zoho-oauthtoken ${accessToken}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(singleOrderPayload)
              });

              if (individualBackstageResponse.ok) {
                const backstageData = await individualBackstageResponse.json();
                const individualBackstageOrderId = backstageData.order?.id || backstageData.id;
                individualBackstageOrderDetails.push({
                  attendeeEmail: attendee.email,
                  backstageOrderId: individualBackstageOrderId,
                  success: true
                });
                console.log(`[createBooking] ✓ Backstage order created for ${attendee.email}: ${individualBackstageOrderId}`);
              } else {
                const errorText = await individualBackstageResponse.text();
                console.error(`[createBooking] ✗ Backstage API error for ${attendee.email}: ${errorText}`);
                anyBackstageSyncFailed = true;
                backstageSyncErrors.push(`Backstage API Error for ${attendee.email}: ${errorText}`);
                individualBackstageOrderDetails.push({
                  attendeeEmail: attendee.email,
                  success: false,
                  error: `API Error: ${errorText}`
                });
              }
            } catch (individualError: any) {
              console.error(`[createBooking] ✗ Backstage failed for ${attendee.email}:`, individualError);
              anyBackstageSyncFailed = true;
              backstageSyncErrors.push(`Backstage Failed for ${attendee.email}: ${individualError.message}`);
              individualBackstageOrderDetails.push({
                attendeeEmail: attendee.email,
                success: false,
                error: individualError.message
              });
            }
          }

        } catch (backstageError: any) {
          console.error('[createBooking] ✗ Backstage provisioning failed:', backstageError);
          anyBackstageSyncFailed = true;
          backstageSyncErrors.push(`Backstage Provisioning Error: ${backstageError.message}`);
        }
      }

      // Track Zoom registration results
      let anyZoomSyncFailed = false;
      const zoomSyncErrors: string[] = [];
      const individualZoomRegistrationDetails: Array<{
        attendeeEmail: string;
        zoomRegistrantId?: string;
        success: boolean;
        error?: string;
      }> = [];

      // For self/colleagues mode, check if this is a Zoom event (not a Backstage event)
      if ((registrationMode === 'self' || registrationMode === 'colleagues') && !event.backstage_event_id && isZoomEvent(event)) {
        console.log('[createBooking] Detected Zoom event, checking for webinar registration...');
        
        try {
          // Find the matching webinar by URL in event location
          const matchingWebinar = await findWebinarByEventLocation(event.location);
          
          if (matchingWebinar) {
            console.log(`[createBooking] Found matching webinar: ${matchingWebinar.id} (${matchingWebinar.topic})`);
            
            if (matchingWebinar.registration_required) {
              console.log('[createBooking] Webinar requires registration, registering attendees...');
              
              // Register each attendee with Zoom
              for (const attendee of attendees) {
                const registrationResult = await registerAttendeeWithZoom(matchingWebinar, {
                  email: attendee.email,
                  first_name: attendee.first_name,
                  last_name: attendee.last_name
                });
                
                if (registrationResult.success) {
                  individualZoomRegistrationDetails.push({
                    attendeeEmail: attendee.email,
                    zoomRegistrantId: registrationResult.registrant_id,
                    success: true
                  });
                  console.log(`[createBooking] ✓ Zoom registration successful for ${attendee.email}`);
                } else {
                  anyZoomSyncFailed = true;
                  zoomSyncErrors.push(`Zoom registration failed for ${attendee.email}: ${registrationResult.error}`);
                  individualZoomRegistrationDetails.push({
                    attendeeEmail: attendee.email,
                    success: false,
                    error: registrationResult.error
                  });
                  console.error(`[createBooking] ✗ Zoom registration failed for ${attendee.email}: ${registrationResult.error}`);
                }
              }
            } else {
              console.log('[createBooking] Webinar does not require registration, skipping Zoom registration');
              // Mark all as successful (no registration needed)
              for (const attendee of attendees) {
                individualZoomRegistrationDetails.push({
                  attendeeEmail: attendee.email,
                  success: true
                });
              }
            }
          } else {
            console.warn('[createBooking] Zoom event but no matching webinar found in database');
            // This is a Zoom event but we couldn't find a matching webinar - still allow booking
            for (const attendee of attendees) {
              individualZoomRegistrationDetails.push({
                attendeeEmail: attendee.email,
                success: true // Allow booking even without webinar match
              });
            }
          }
        } catch (zoomError: any) {
          console.error('[createBooking] ✗ Zoom registration processing failed:', zoomError);
          anyZoomSyncFailed = true;
          zoomSyncErrors.push(`Zoom Registration Error: ${zoomError.message}`);
        }
      } else if ((registrationMode === 'self' || registrationMode === 'colleagues') && !event.backstage_event_id && !isZoomEvent(event)) {
        // Not a Backstage event and not a Zoom event - just a regular event
        console.log('[createBooking] Regular event (not Backstage or Zoom), no external registration needed');
      }

      // Create booking records
      if (registrationMode === 'self' || registrationMode === 'colleagues') {
        for (const attendee of attendees) {
          const correspondingOrder = individualBackstageOrderDetails.find(d => d.attendeeEmail === attendee.email);
          const correspondingZoomReg = individualZoomRegistrationDetails.find(d => d.attendeeEmail === attendee.email);
          
          // Determine booking status based on event type and registration results
          let bookingStatus = 'confirmed';
          if (event.backstage_event_id) {
            // Backstage event
            bookingStatus = correspondingOrder?.success ? 'confirmed' : 'pending_backstage_sync';
          } else if (isZoomEvent(event)) {
            // Zoom event
            bookingStatus = correspondingZoomReg?.success ? 'confirmed' : 'pending_zoom_sync';
          }
          // Regular events default to 'confirmed'

          const bookingData: any = {
            event_id: eventId,
            member_id: member.id,
            attendee_email: attendee.email,
            attendee_first_name: attendee.first_name,
            attendee_last_name: attendee.last_name,
            ticket_price: event.ticket_price || 0,
            booking_reference: bookingReference,
            status: bookingStatus,
            payment_method: 'program_ticket',
            zoom_registrant_id: correspondingZoomReg?.zoomRegistrantId || null
          };
          
          // Only add backstage_order_id if we have one
          if (correspondingOrder?.backstageOrderId) {
            bookingData.backstage_order_id = correspondingOrder.backstageOrderId;
          }
          
          console.log('[createBooking] Inserting booking:', JSON.stringify(bookingData));
          
          const { data: booking, error: bookingError } = await supabase
            .from('booking')
            .insert(bookingData)
            .select()
            .single();

          if (bookingError) {
            console.error('[createBooking] ✗ Booking insert failed:', bookingError);
          } else if (booking) {
            console.log('[createBooking] ✓ Booking created:', booking.id);
            createdBookings.push(booking);
          }
        }
      } else if (registrationMode === 'links') {
        for (let i = 0; i < numberOfLinks; i++) {
          const confirmationToken = crypto.randomUUID();

          const { data: booking } = await supabase
            .from('booking')
            .insert({
              event_id: eventId,
              member_id: member.id,
              attendee_email: '',
              attendee_first_name: '',
              attendee_last_name: '',
              ticket_price: event.ticket_price || 0,
              booking_reference: bookingReference,
              status: 'pending',
              payment_method: 'program_ticket',
              confirmation_token: confirmationToken
            })
            .select()
            .single();

          if (booking) createdBookings.push(booking);
        }
      }

      // Deduct program tickets from organization balance
      const newBalance = currentBalance - ticketsRequired;
      const updatedBalances = {
        ...currentBalances,
        [programTag]: newBalance
      };

      await supabase
        .from('organization')
        .update({
          program_ticket_balances: updatedBalances,
          last_synced: new Date().toISOString()
        })
        .eq('id', org.id);

      // Decrement available seats atomically using RPC (only if not unlimited)
      if (event.available_seats !== null && event.available_seats !== undefined && createdBookings.length > 0) {
        const seatsToDecrement = createdBookings.length;
        
        try {
          const { data: newSeatCount, error: rpcError } = await supabase
            .rpc('adjust_event_seats', { p_event_id: eventId, p_delta: -seatsToDecrement });
          
          if (rpcError) {
            console.error(`[createBooking] RPC seat decrement failed:`, rpcError.message);
          } else {
            console.log(`[createBooking] Atomically decremented seats, new count: ${newSeatCount}`);
          }
        } catch (rpcErr: any) {
          // Fallback to non-atomic update if RPC doesn't exist yet
          console.warn(`[createBooking] RPC not available, using fallback:`, rpcErr.message);
          const { data: currentEvent } = await supabase
            .from('event')
            .select('available_seats')
            .eq('id', eventId)
            .single();
          
          if (currentEvent && currentEvent.available_seats !== null) {
            const newSeatCount = Math.max(0, currentEvent.available_seats - seatsToDecrement);
            await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', eventId);
            console.log(`[createBooking] Fallback: Decremented seats to ${newSeatCount}`);
          }
        }
      }

      // Build sync status notes for transaction record
      let syncNotes = '';
      if (anyBackstageSyncFailed) {
        syncNotes = ' - Backstage sync failed for some tickets';
      } else if (anyZoomSyncFailed) {
        syncNotes = ' - Zoom registration failed for some tickets';
      }

      // Create program ticket transaction record
      await supabase
        .from('program_ticket_transaction')
        .insert({
          organization_id: org.id,
          program_name: programTag,
          transaction_type: 'usage',
          quantity: ticketsRequired,
          booking_reference: bookingReference,
          event_name: event.title || 'Unknown Event',
          member_email: memberEmail,
          notes: `Used ${ticketsRequired} ${programTag} ticket${ticketsRequired > 1 ? 's' : ''} for ${event.title || 'event'}${registrationMode === 'links' ? ' (link generation)' : registrationMode === 'self' ? ' (self registration)' : ''}${syncNotes}`
        });

      const response: any = {
        success: true,
        booking_reference: bookingReference,
        bookings: createdBookings,
        tickets_used: ticketsRequired,
        remaining_balance: newBalance
      };

      if (anyBackstageSyncFailed) {
        response.warning = 'Some bookings created successfully, but Backstage provisioning failed for one or more tickets. An admin may need to manually sync these.';
        response.backstage_sync_errors = backstageSyncErrors;
      }

      if (anyZoomSyncFailed) {
        response.warning = (response.warning ? response.warning + ' ' : '') + 
          'Some bookings created successfully, but Zoom registration failed for one or more attendees. The attendees may need to register manually.';
        response.zoom_sync_errors = zoomSyncErrors;
      }

      res.json(response);

    } catch (error: any) {
      console.error('Booking error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Create One-Off Event Booking (with payment processing)
  app.post('/api/functions/createOneOffEventBooking', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const {
        eventId,
        memberEmail,
        attendees,
        registrationMode,
        ticketsRequired,
        totalCost,
        pricingDetails,
        selectedVoucherIds = [],
        trainingFundAmount = 0,
        accountAmount = 0,
        purchaseOrderNumber = null,
        poToFollow = false,
        paymentMethod = 'account',
        stripePaymentIntentId = null,
        ticketClassId = null,
        ticketClassName = null,
        ticketClassPrice = null,
        isGuestBooking = false,
        guestInfo = null
      } = req.body;

      console.log('[createOneOffEventBooking] Starting booking:', {
        eventId,
        memberEmail,
        ticketsRequired,
        totalCost,
        paymentMethod,
        isGuestBooking,
        guestInfo: guestInfo ? { email: guestInfo.email, first_name: guestInfo.first_name, last_name: guestInfo.last_name } : null,
        attendeesCount: attendees?.length || 0
      });
      
      console.log('[createOneOffEventBooking] Full request body keys:', Object.keys(req.body));

      // Validate required fields - for guest bookings, require guestInfo instead of memberEmail
      if (!eventId || !ticketsRequired) {
        console.log('[createOneOffEventBooking] VALIDATION FAILED - Missing eventId or ticketsRequired:', { eventId, ticketsRequired });
        return res.status(400).json({
          success: false,
          error: `Missing required parameters: eventId=${eventId}, ticketsRequired=${ticketsRequired}`
        });
      }
      
      if (!isGuestBooking && !memberEmail) {
        console.log('[createOneOffEventBooking] VALIDATION FAILED - Member booking without memberEmail');
        return res.status(400).json({
          success: false,
          error: 'Missing required parameter: memberEmail (for member bookings)'
        });
      }
      
      if (isGuestBooking && (!guestInfo || !guestInfo.email || !guestInfo.first_name || !guestInfo.last_name)) {
        console.log('[createOneOffEventBooking] VALIDATION FAILED - Guest booking missing guestInfo:', {
          hasGuestInfo: !!guestInfo,
          email: guestInfo?.email,
          first_name: guestInfo?.first_name,
          last_name: guestInfo?.last_name
        });
        return res.status(400).json({
          success: false,
          error: `Missing required guest information: email=${guestInfo?.email}, first_name=${guestInfo?.first_name}, last_name=${guestInfo?.last_name}`
        });
      }

      // Get member details (skip for guest bookings)
      let member = null;
      let org = null;
      
      if (!isGuestBooking) {
        const { data: memberData, error: memberError } = await supabase
          .from('member')
          .select('*')
          .ilike('email', memberEmail)
          .single();
        
        if (memberError) {
          console.error('[createOneOffEventBooking] Member query error:', memberError);
          return res.status(404).json({
            success: false,
            error: 'Member not found'
          });
        }
        
        member = memberData;
        console.log('[createOneOffEventBooking] Member found:', member?.id, member?.email);
      } else {
        console.log('[createOneOffEventBooking] Guest booking - no member lookup needed');
      }

      // Get event details
      const { data: eventData, error: eventError } = await supabase
        .from('event')
        .select('*')
        .eq('id', eventId)
        .single();

      if (eventError || !eventData) {
        console.error('[createOneOffEventBooking] Event query error:', eventError);
        return res.status(404).json({
          success: false,
          error: 'Event not found'
        });
      }
      const event = eventData;

      // Check seat availability (null = unlimited seats)
      if (event.available_seats !== null && event.available_seats !== undefined) {
        if (event.available_seats < ticketsRequired) {
          return res.status(400).json({
            success: false,
            error: event.available_seats === 0 
              ? 'This event is sold out' 
              : `Only ${event.available_seats} seat(s) remaining for this event`
          });
        }
      }

      // Get organization (only for member bookings)
      if (!isGuestBooking && member) {
        const { data: orgData, error: orgError } = await supabase
          .from('organization')
          .select('*')
          .eq('id', member.organization_id)
          .single();

        if (orgError || !orgData) {
          console.error('[createOneOffEventBooking] Organization not found');
          return res.status(404).json({
            success: false,
            error: 'Organization not found'
          });
        }
        org = orgData;
      }

      // Verify Stripe payment if card payment was used
      if (paymentMethod === 'card' && stripePaymentIntentId) {
        console.log('[createOneOffEventBooking] Verifying Stripe payment:', stripePaymentIntentId);
        
        if (!stripe) {
          return res.status(400).json({
            success: false,
            error: 'Stripe is not configured'
          });
        }

        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
          
          // Verify payment was successful
          if (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'requires_capture') {
            console.error('[createOneOffEventBooking] Payment not successful:', paymentIntent.status);
            return res.status(400).json({
              success: false,
              error: 'Payment has not been completed. Please try again.'
            });
          }

          // Verify payment amount matches expected amount
          const expectedCardAmount = Math.round((totalCost - (trainingFundAmount || 0)) * 100); // Convert to pence
          if (Math.abs(paymentIntent.amount - expectedCardAmount) > 100) { // Allow £1 variance for rounding
            console.error('[createOneOffEventBooking] Payment amount mismatch:', {
              expected: expectedCardAmount,
              received: paymentIntent.amount
            });
            return res.status(400).json({
              success: false,
              error: 'Payment amount does not match the expected total'
            });
          }

          console.log('[createOneOffEventBooking] Stripe payment verified:', paymentIntent.status);
        } catch (stripeError: any) {
          console.error('[createOneOffEventBooking] Stripe verification error:', stripeError);
          return res.status(400).json({
            success: false,
            error: 'Failed to verify payment: ' + (stripeError.message || 'Unknown error')
          });
        }
      }

      // Generate booking reference
      const bookingReference = isGuestBooking 
        ? `GUEST-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`
        : `OOE-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      
      // Server-side validation: Clamp training fund amount to available balance (members only)
      const validatedTrainingFundAmount = isGuestBooking ? 0 : Math.min(
        Math.max(0, trainingFundAmount || 0),
        org?.training_fund_balance || 0,
        totalCost
      );
      
      // Process voucher deductions if any - with ownership validation (members only)
      let voucherAmountApplied = 0;
      const voucherDeductions: { voucherId: string; amount: number }[] = [];
      
      if (!isGuestBooking && org && selectedVoucherIds && selectedVoucherIds.length > 0) {
        for (const voucherId of selectedVoucherIds) {
          // Fetch voucher and validate it belongs to the member's organization
          const { data: voucher } = await supabase
            .from('program_ticket_transaction')
            .select('*')
            .eq('id', voucherId)
            .eq('organization_id', org.id) // Validate ownership
            .eq('transaction_type', 'voucher')
            .eq('status', 'active')
            .single();
          
          if (voucher && voucher.value > 0) {
            // Clamp amount to remaining cost
            const amountToUse = Math.min(voucher.value, totalCost - voucherAmountApplied - validatedTrainingFundAmount);
            if (amountToUse > 0) {
              voucherAmountApplied += amountToUse;
              voucherDeductions.push({ voucherId, amount: amountToUse });
              
              // Update voucher balance
              const newValue = voucher.value - amountToUse;
              await supabase
                .from('program_ticket_transaction')
                .update({
                  value: newValue,
                  status: newValue <= 0 ? 'used' : 'active',
                  notes: `${voucher.notes || ''} | Used £${amountToUse.toFixed(2)} for ${event.title || 'event'} (${bookingReference})`
                })
                .eq('id', voucherId);
            }
          } else {
            console.warn('[createOneOffEventBooking] Voucher not found or not owned by org:', voucherId);
          }
        }
      }

      // Process training fund deduction if any (use validated amount) - members only
      if (!isGuestBooking && org && validatedTrainingFundAmount > 0) {
        await supabase
          .from('organization')
          .update({
            training_fund_balance: org.training_fund_balance - validatedTrainingFundAmount
          })
          .eq('id', org.id);
        
        // Create training fund transaction record
        await supabase
          .from('program_ticket_transaction')
          .insert({
            organization_id: org.id,
            transaction_type: 'training_fund_usage',
            value: -validatedTrainingFundAmount,
            booking_reference: bookingReference,
            event_name: event.title || 'One-off Event',
            member_email: memberEmail,
            notes: `Training fund used: £${validatedTrainingFundAmount.toFixed(2)} for ${event.title || 'event'}`
          });
      }

      // Calculate validated remaining balance after vouchers and training fund
      const validatedRemainingBalance = Math.max(0, totalCost - voucherAmountApplied - validatedTrainingFundAmount);
      
      // Create booking records for each attendee
      const createdBookings: any[] = [];
      
      // For guest bookings, use guestInfo as the single attendee if no attendees provided
      const bookingAttendees = isGuestBooking && (!attendees || attendees.length === 0)
        ? [{
            email: guestInfo.email,
            first_name: guestInfo.first_name,
            last_name: guestInfo.last_name,
            organization: guestInfo.organization,
            phone: guestInfo.phone,
            job_title: guestInfo.job_title,
            isGuest: true
          }]
        : attendees;
      
      for (const attendee of bookingAttendees) {
        const bookingData: any = {
          event_id: event.id,
          member_id: isGuestBooking ? null : member?.id,
          organization_id: isGuestBooking ? null : org?.id,
          booking_reference: bookingReference,
          attendee_email: attendee.email,
          attendee_first_name: attendee.first_name || attendee.firstName,
          attendee_last_name: attendee.last_name || attendee.lastName,
          status: 'confirmed',
          payment_method: paymentMethod,
          total_cost: totalCost / ticketsRequired,
          voucher_amount: voucherAmountApplied / ticketsRequired,
          training_fund_amount: validatedTrainingFundAmount / ticketsRequired,
          account_amount: (paymentMethod === 'account' ? validatedRemainingBalance : 0) / ticketsRequired,
          purchase_order_number: isGuestBooking ? null : purchaseOrderNumber,
          po_to_follow: (!isGuestBooking && paymentMethod === 'account') ? poToFollow : false,
          stripe_payment_intent_id: stripePaymentIntentId,
          is_one_off_event: true,
          ticket_class_id: ticketClassId,
          ticket_class_name: ticketClassName,
          ticket_price: ticketClassPrice || (totalCost / ticketsRequired),
          is_guest_booking: isGuestBooking
        };
        
        // Add guest-specific fields
        if (isGuestBooking && attendee.isGuest) {
          bookingData.guest_organization = attendee.organization || null;
          bookingData.guest_phone = attendee.phone || null;
          bookingData.guest_job_title = attendee.job_title || null;
        }

        console.log('[createOneOffEventBooking] Inserting booking:', JSON.stringify(bookingData));
        
        const { data: booking, error: bookingError } = await supabase
          .from('booking')
          .insert(bookingData)
          .select()
          .single();

        if (bookingError) {
          console.error('[createOneOffEventBooking] Booking insert failed:', bookingError);
        } else if (booking) {
          console.log('[createOneOffEventBooking] Booking created:', booking.id);
          createdBookings.push(booking);
        }
      }

      // If paying to account, create an account charge record and optionally a Xero invoice (members only)
      let xeroInvoiceResult = null;
      if (!isGuestBooking && org && validatedRemainingBalance > 0 && paymentMethod === 'account') {
        await supabase
          .from('program_ticket_transaction')
          .insert({
            organization_id: org.id,
            transaction_type: 'account_charge',
            value: validatedRemainingBalance,
            booking_reference: bookingReference,
            event_name: event.title || 'One-off Event',
            member_email: memberEmail,
            purchase_order_number: purchaseOrderNumber,
            po_to_follow: poToFollow,
            notes: `Account charge: £${validatedRemainingBalance.toFixed(2)} for ${event.title || 'event'} (PO: ${poToFollow ? 'To follow' : (purchaseOrderNumber || 'N/A')})`
          });

        // Check if Xero invoice generation is enabled
        const { data: xeroSettings } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', 'xero_invoice_enabled')
          .single();

        const xeroInvoiceEnabled = xeroSettings?.setting_value === 'true';

        if (xeroInvoiceEnabled) {
          try {
            console.log('[createOneOffEventBooking] Creating Xero invoice for account charge:', validatedRemainingBalance);

            const { accessToken, tenantId } = await getValidXeroAccessToken(supabase);

            if (accessToken && tenantId) {
              // Find or create Xero contact
              const contactId = await findOrCreateXeroContact(accessToken, tenantId, org.name);

              // Build line description with internal reference if present
              let lineDescription = `${event.title || 'One-off Event'} - ${ticketsRequired} attendee${ticketsRequired > 1 ? 's' : ''}`;
              if (event.internal_reference) {
                lineDescription += `\nRef: ${event.internal_reference}`;
              }

              // Create invoice
              const invoicePayload = {
                Type: 'ACCREC',
                Contact: { ContactID: contactId },
                LineItems: [{
                  Description: lineDescription,
                  Quantity: 1,
                  UnitAmount: validatedRemainingBalance,
                  AccountCode: '200'
                }],
                Reference: purchaseOrderNumber || bookingReference,
                Status: 'AUTHORISED'
              };

              const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'xero-tenant-id': tenantId,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ Invoices: [invoicePayload] })
              });

              const invoiceData = await invoiceResponse.json() as any;

              if (invoiceData.Invoices && invoiceData.Invoices.length > 0) {
                xeroInvoiceResult = {
                  invoice_id: invoiceData.Invoices[0].InvoiceID,
                  invoice_number: invoiceData.Invoices[0].InvoiceNumber,
                  total: invoiceData.Invoices[0].Total,
                  status: invoiceData.Invoices[0].Status
                };
                console.log('[createOneOffEventBooking] Xero invoice created:', xeroInvoiceResult);
              }
            } else {
              console.log('[createOneOffEventBooking] Xero not configured, skipping invoice creation');
            }
          } catch (xeroError: any) {
            console.error('[createOneOffEventBooking] Xero invoice creation failed:', xeroError.message);
            // Don't fail the booking, just log the error
          }
        }
      }

      // Decrement available seats atomically using RPC (only if not unlimited)
      if (event.available_seats !== null && event.available_seats !== undefined && createdBookings.length > 0) {
        const seatsToDecrement = createdBookings.length;
        
        try {
          const { data: newSeatCount, error: rpcError } = await supabase
            .rpc('adjust_event_seats', { p_event_id: eventId, p_delta: -seatsToDecrement });
          
          if (rpcError) {
            console.error(`[createOneOffEventBooking] RPC seat decrement failed:`, rpcError.message);
          } else {
            console.log(`[createOneOffEventBooking] Atomically decremented seats, new count: ${newSeatCount}`);
          }
        } catch (rpcErr: any) {
          // Fallback to non-atomic update if RPC doesn't exist yet
          console.warn(`[createOneOffEventBooking] RPC not available, using fallback:`, rpcErr.message);
          const { data: currentEvent } = await supabase
            .from('event')
            .select('available_seats')
            .eq('id', eventId)
            .single();
          
          if (currentEvent && currentEvent.available_seats !== null) {
            const newSeatCount = Math.max(0, currentEvent.available_seats - seatsToDecrement);
            await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', eventId);
            console.log(`[createOneOffEventBooking] Fallback: Decremented seats to ${newSeatCount}`);
          }
        }
      }

      // Decrement ticket class availability if ticket class has limited tickets
      if (ticketClassId && event.pricing_config?.ticket_classes && createdBookings.length > 0) {
        try {
          const ticketClasses = event.pricing_config.ticket_classes;
          const ticketClassIndex = ticketClasses.findIndex((tc: any) => tc.id === ticketClassId);
          
          if (ticketClassIndex !== -1) {
            const ticketClass = ticketClasses[ticketClassIndex];
            // Only decrement if ticket class has limited availability (not unlimited)
            if (ticketClass.available_count !== null && ticketClass.available_count !== undefined && !ticketClass.is_unlimited_tickets) {
              const ticketsToDecrement = createdBookings.length;
              const newAvailableCount = Math.max(0, Number(ticketClass.available_count) - ticketsToDecrement);
              
              // Update the ticket class in pricing_config
              const updatedTicketClasses = [...ticketClasses];
              updatedTicketClasses[ticketClassIndex] = {
                ...ticketClass,
                available_count: newAvailableCount
              };
              
              const updatedPricingConfig = {
                ...event.pricing_config,
                ticket_classes: updatedTicketClasses
              };
              
              await supabase
                .from('event')
                .update({ pricing_config: updatedPricingConfig })
                .eq('id', eventId);
              
              console.log(`[createOneOffEventBooking] Decremented ticket class '${ticketClass.name}' availability: ${ticketClass.available_count} -> ${newAvailableCount}`);
            }
          }
        } catch (ticketClassErr: any) {
          console.error(`[createOneOffEventBooking] Ticket class availability decrement failed:`, ticketClassErr.message);
          // Don't fail the booking, just log the error
        }
      }

      res.json({
        success: true,
        booking_reference: bookingReference,
        bookings: createdBookings,
        is_guest_booking: isGuestBooking,
        payment_details: {
          total_cost: totalCost,
          voucher_amount: voucherAmountApplied,
          training_fund_amount: validatedTrainingFundAmount,
          account_amount: paymentMethod === 'account' ? validatedRemainingBalance : 0,
          card_amount: paymentMethod === 'card' ? validatedRemainingBalance : 0
        },
        xero_invoice: xeroInvoiceResult
      });

    } catch (error: any) {
      console.error('[createOneOffEventBooking] Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Get Booking Invoice PDF (for download/preview) - fetches directly from Xero
  app.get('/api/booking-invoice/:bookingGroupRef', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    // Check authentication
    const session = req.session as any;
    if (!session?.memberId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { bookingGroupRef } = req.params;
    const inline = req.query.inline === 'true';

    if (!bookingGroupRef) {
      return res.status(400).json({ error: 'Booking group reference required' });
    }

    try {
      // Fetch booking with Xero invoice ID and verify ownership
      const { data: booking, error } = await supabase
        .from('booking')
        .select('xero_invoice_id, xero_invoice_number, member_id, organization_id')
        .eq('booking_group_reference', bookingGroupRef)
        .not('xero_invoice_id', 'is', null)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error('Error fetching booking:', error);
        return res.status(500).json({ error: 'Failed to fetch booking' });
      }

      if (!booking || !booking.xero_invoice_id) {
        return res.status(404).json({ error: 'Invoice not found for this booking' });
      }

      // Get logged-in member's organization to check authorization
      const { data: member } = await supabase
        .from('member')
        .select('organization_id')
        .eq('id', session.memberId)
        .single();

      // Verify authorization - member must be the one who made the booking OR from the same organization
      const isSameMember = booking.member_id === session.memberId;
      const isSameOrg = member?.organization_id && booking.organization_id && member.organization_id === booking.organization_id;
      
      if (!isSameMember && !isSameOrg) {
        return res.status(403).json({ error: 'Not authorized to view this invoice' });
      }

      // Fetch PDF directly from Xero (single source of truth)
      const { accessToken, tenantId } = await getValidXeroAccessToken(supabase);
      
      const pdfResponse = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${booking.xero_invoice_id}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          'Accept': 'application/pdf'
        }
      });

      if (!pdfResponse.ok) {
        console.error('Failed to fetch PDF from Xero:', pdfResponse.status);
        return res.status(500).json({ error: 'Failed to fetch invoice from Xero' });
      }

      const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
      
      // Set headers for PDF download or inline viewing
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdfBuffer.length);
      
      if (inline) {
        res.setHeader('Content-Disposition', `inline; filename="invoice-${booking.xero_invoice_number || bookingGroupRef}.pdf"`);
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="invoice-${booking.xero_invoice_number || bookingGroupRef}.pdf"`);
      }
      
      return res.send(pdfBuffer);
    } catch (error: any) {
      console.error('Error serving invoice PDF:', error);
      return res.status(500).json({ error: 'Failed to fetch invoice from Xero' });
    }
  });

  // Validate Colleague (check if email belongs to same organization)
  app.post('/api/functions/validateColleague', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      const { email, memberEmail, organizationId } = req.body;

      if (!email || !organizationId) {
        return res.status(400).json({
          valid: false,
          error: 'Missing required parameters'
        });
      }

      const accessToken = await getValidZohoAccessToken();

      // Search for the colleague's contact in CRM
      const criteria = `(Email:equals:${email})`;
      const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}`;

      const searchResponse = await fetch(searchUrl, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
        },
      });

      // Check if response has content before parsing
      let searchData: { data?: any[] } = { data: [] };
      const responseText = await searchResponse.text();

      if (responseText && responseText.trim() !== '') {
        try {
          searchData = JSON.parse(responseText);
        } catch (e) {
          console.error('Failed to parse search response:', responseText);
          searchData = { data: [] };
        }
      }

      // If contact found, validate organization
      if (searchResponse.ok && searchData.data && searchData.data.length > 0) {
        const contact = searchData.data[0];

        // Check if the contact belongs to the same organization
        if (!contact.Account_Name?.id || contact.Account_Name.id !== organizationId) {
          return res.json({
            valid: false,
            status: 'wrong_organization',
            error: 'A ticket will be sent shortly. This email address cannot be verified, AGCAS will be in touch.'
          });
        }

        // Valid colleague - return their details
        return res.json({
          valid: true,
          status: 'registered',
          first_name: contact.First_Name,
          last_name: contact.Last_Name,
          zoho_contact_id: contact.id
        });
      }

      // Contact not found - check domain matching
      const emailDomain = email.split('@')[1]?.toLowerCase();
      if (!emailDomain) {
        return res.json({
          valid: false,
          status: 'invalid_email',
          error: 'Invalid email format'
        });
      }

      // Fetch organization details from CRM
      const orgResponse = await fetch(
        `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${organizationId}`,
        {
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
          },
        }
      );

      if (!orgResponse.ok) {
        return res.json({
          valid: true,
          status: 'external',
          message: 'External email address. AGCAS may reach out to validate eligibility.'
        });
      }

      const orgData = await orgResponse.json();
      const org = orgData.data[0];

      // Check primary domain
      const primaryDomain = org.Domain?.toLowerCase();
      if (primaryDomain && emailDomain === primaryDomain) {
        return res.json({
          valid: true,
          status: 'unregistered_domain_match',
          message: 'A ticket and member welcome will be sent shortly.'
        });
      }

      // Check additional verified domains - safely handle non-array values
      let additionalDomains = org.Additional_verified_domains;

      // Ensure additionalDomains is always an array
      if (!Array.isArray(additionalDomains)) {
        if (additionalDomains === null || additionalDomains === undefined) {
          additionalDomains = [];
        } else if (typeof additionalDomains === 'string') {
          // If it's a string, try to split by comma or newline
          additionalDomains = additionalDomains
            .split(/[,\n]/)
            .map((d: string) => d.trim())
            .filter((d: string) => d.length > 0);
        } else {
          console.warn('Unexpected type for Additional_verified_domains:', typeof additionalDomains);
          additionalDomains = [];
        }
      }

      const domainMatches = additionalDomains.some(
        (domain: string) => domain.toLowerCase() === emailDomain
      );

      if (domainMatches) {
        return res.json({
          valid: true,
          status: 'unregistered_domain_match',
          message: 'A ticket and member welcome will be sent shortly.'
        });
      }

      // Domain doesn't match - external email
      res.json({
        valid: true,
        status: 'external',
        message: 'A ticket will be sent shortly. This email address cannot be verified, AGCAS will be in touch.'
      });

    } catch (error: any) {
      console.error('Validation error:', error);
      res.status(500).json({
        valid: false,
        status: 'error',
        error: error.message
      });
    }
  });

  // Process Program Ticket Purchase
  app.post('/api/functions/processProgramTicketPurchase', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    let stripe: any = null;
    if (stripeSecretKey) {
      const Stripe = (await import('stripe')).default;
      stripe = new Stripe(stripeSecretKey);
    }

    try {
      const {
        memberEmail,
        programName,
        quantity,
        purchaseOrderNumber,
        selectedVoucherIds = [],
        trainingFundAmount = 0,
        accountAmount = 0,
        paymentMethod = 'account',
        stripePaymentIntentId = null,
        appliedDiscountId = null
      } = req.body;

      // Try to get member from session first, fall back to email from request
      const sessionMemberId = (req.session as any)?.memberId;
      let member: any = null;

      if (sessionMemberId) {
        // Prefer session-based authentication
        const { data: sessionMember } = await supabase
          .from('member')
          .select('*')
          .eq('id', sessionMemberId)
          .single();
        member = sessionMember;
      }
      
      // Fall back to email lookup if session not available
      if (!member && memberEmail) {
        const { data: emailMember } = await supabase
          .from('member')
          .select('*')
          .ilike('email', memberEmail)
          .maybeSingle();
        member = emailMember;
      }

      if (!member) {
        return res.status(401).json({
          error: 'Not authenticated - please log in again'
        });
      }

      if (!programName || !quantity) {
        return res.status(400).json({
          error: 'Missing required parameters',
          required: ['programName', 'quantity']
        });
      }

      if (quantity < 1 || quantity > 1000) {
        return res.status(400).json({
          error: 'Quantity must be between 1 and 1000'
        });
      }

      // Verify Stripe payment if card payment method
      if (paymentMethod === 'card' && stripePaymentIntentId && stripe) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);

          if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({
              error: 'Payment not completed',
              details: `Payment status: ${paymentIntent.status}`
            });
          }

          console.log('[processProgramTicketPurchase] Stripe payment verified:', paymentIntent.id);
        } catch (stripeError: any) {
          console.error('[processProgramTicketPurchase] Stripe verification failed:', stripeError);
          return res.status(400).json({
            error: 'Failed to verify payment',
            details: stripeError.message
          });
        }
      }

      // Verify that the program exists and is active
      const { data: allPrograms } = await supabase.from('program').select('*');
      const program = allPrograms?.find((p: any) => p.program_tag === programName && p.is_active);

      if (!program) {
        return res.status(404).json({
          error: 'Program not found or not active',
          programName: programName
        });
      }

      if (!member.organization_id) {
        return res.status(404).json({
          error: 'Member has no organization assigned'
        });
      }

      // Get organization using member's organization_id
      let { data: org } = await supabase
        .from('organization')
        .select('*')
        .eq('id', member.organization_id)
        .maybeSingle();

      // Fallback: check if organization_id is actually a zoho_account_id
      if (!org) {
        const { data: orgByZoho } = await supabase
          .from('organization')
          .select('*')
          .eq('zoho_account_id', member.organization_id)
          .maybeSingle();
        org = orgByZoho;
      }

      if (!org) {
        return res.status(404).json({
          error: 'Organization not found'
        });
      }

      // Calculate cost and tickets based on offer type
      let totalCost: number;
      let totalTicketsReceived: number;
      let discountApplied = false;
      let discountDetails = '';
      let costBeforeDiscountCodeApplication: number;
      let discountAmount = 0;
      let discountCode: any = null;

      // Determine effective offer type
      const offerType = program.offer_type || 'none';
      let effectiveOfferType = offerType;
      if (offerType === 'none') {
        if (program.bogo_buy_quantity && program.bogo_get_free_quantity) {
          effectiveOfferType = 'bogo';
        } else if (program.bulk_discount_threshold && program.bulk_discount_percentage) {
          effectiveOfferType = 'bulk_discount';
        }
      }

      // Calculate cost and total tickets based on offer type
      if (effectiveOfferType === 'bogo') {
        const bogoLogicType = program.bogo_logic_type || 'buy_x_get_y_free';

        if (bogoLogicType === 'buy_x_get_y_free') {
          if (program.bogo_buy_quantity && program.bogo_get_free_quantity &&
              quantity >= program.bogo_buy_quantity) {
            const bogoBlocks = Math.floor(quantity / program.bogo_buy_quantity);
            const freeTickets = bogoBlocks * program.bogo_get_free_quantity;

            totalTicketsReceived = quantity + freeTickets;
            totalCost = program.program_ticket_price * quantity;

            discountApplied = true;
            discountDetails = `Buy ${program.bogo_buy_quantity}, Get ${program.bogo_get_free_quantity} Free - ${freeTickets} free ticket${freeTickets > 1 ? 's' : ''} received`;
          } else {
            totalTicketsReceived = quantity;
            totalCost = program.program_ticket_price * quantity;
          }
        } else {
          totalTicketsReceived = quantity;

          if (program.bogo_buy_quantity && program.bogo_get_free_quantity &&
              quantity >= (program.bogo_buy_quantity + program.bogo_get_free_quantity)) {
            const bogoSetSize = program.bogo_buy_quantity + program.bogo_get_free_quantity;
            const completeBlocks = Math.floor(quantity / bogoSetSize);
            const remainingTickets = quantity % bogoSetSize;
            const freeTickets = completeBlocks * program.bogo_get_free_quantity;

            const ticketsToPay = (completeBlocks * program.bogo_buy_quantity) + remainingTickets;
            totalCost = program.program_ticket_price * ticketsToPay;

            discountApplied = true;
            discountDetails = `BOGO offer applied - ${freeTickets} free ticket${freeTickets > 1 ? 's' : ''} included`;
          } else {
            totalCost = program.program_ticket_price * quantity;
          }
        }
      } else if (effectiveOfferType === 'bulk_discount') {
        totalTicketsReceived = quantity;
        totalCost = program.program_ticket_price * quantity;

        if (program.bulk_discount_threshold && program.bulk_discount_percentage &&
            quantity >= program.bulk_discount_threshold) {
          const bulkDiscountValue = totalCost * (program.bulk_discount_percentage / 100);
          totalCost = totalCost - bulkDiscountValue;
          discountApplied = true;
          discountDetails = `${program.bulk_discount_percentage}% bulk discount`;
        }
      } else {
        totalTicketsReceived = quantity;
        totalCost = program.program_ticket_price * quantity;
      }

      costBeforeDiscountCodeApplication = totalCost;

      // Apply discount code if provided
      if (appliedDiscountId) {
        const { data: allDiscountCodes } = await supabase.from('discount_code').select('*');
        discountCode = allDiscountCodes?.find((dc: any) => dc.id === appliedDiscountId);

        if (discountCode && discountCode.is_active) {
          if (discountCode.expires_at && new Date(discountCode.expires_at) < new Date()) {
            return res.status(400).json({ error: 'Discount code has expired' });
          }

          if (discountCode.program_tag && discountCode.program_tag !== programName) {
            return res.status(400).json({ error: 'Discount code is not valid for this program' });
          }

          // Validate usage count
          if (discountCode.max_usage_count) {
            let currentUsage = 0;

            if (discountCode.organization_id) {
              const { data: usageRecords } = await supabase
                .from('discount_code_usage')
                .select('*')
                .eq('discount_code_id', discountCode.id)
                .eq('organization_id', org.id);

              if (usageRecords && usageRecords.length > 0) {
                currentUsage = usageRecords[0].usage_count || 0;
              }
            } else {
              currentUsage = discountCode.current_usage_count || 0;
            }

            if (currentUsage >= discountCode.max_usage_count) {
              return res.status(400).json({ error: 'Discount code has reached its maximum usage' });
            }
          }

          // Calculate discount
          if (discountCode.type === 'percentage') {
            discountAmount = totalCost * (discountCode.value / 100);
          } else if (discountCode.type === 'fixed') {
            discountAmount = discountCode.value;
          }

          discountAmount = Math.min(discountAmount, totalCost);
          totalCost = totalCost - discountAmount;

          // Increment usage count
          if (discountCode.organization_id) {
            const { data: usageRecords } = await supabase
              .from('discount_code_usage')
              .select('*')
              .eq('discount_code_id', discountCode.id)
              .eq('organization_id', org.id);

            if (usageRecords && usageRecords.length > 0) {
              await supabase
                .from('discount_code_usage')
                .update({ usage_count: (usageRecords[0].usage_count || 0) + 1 })
                .eq('id', usageRecords[0].id);
            } else {
              await supabase.from('discount_code_usage').insert({
                discount_code_id: discountCode.id,
                organization_id: org.id,
                usage_count: 1
              });
            }
          } else {
            await supabase
              .from('discount_code')
              .update({ current_usage_count: (discountCode.current_usage_count || 0) + 1 })
              .eq('id', discountCode.id);
          }

          console.log(`[processProgramTicketPurchase] Applied discount code ${discountCode.code}: £${discountAmount.toFixed(2)} off`);
        } else {
          return res.status(400).json({ error: 'Invalid or inactive discount code provided.' });
        }
      }

      // Process vouchers
      let voucherAmountUsed = 0;
      const voucherUsageDetails: any[] = [];
      let remainingCost = totalCost;

      if (selectedVoucherIds.length > 0) {
        const { data: allVouchers } = await supabase.from('voucher').select('*');
        const selectedVouchersData = selectedVoucherIds
          .map((voucherId: string) => allVouchers?.find((v: any) => v.id === voucherId))
          .filter((v: any) => v !== undefined)
          .sort((a: any, b: any) => {
            const expiryA = new Date(a.expires_at).getTime();
            const expiryB = new Date(b.expires_at).getTime();
            if (expiryA !== expiryB) return expiryA - expiryB;
            return a.value - b.value;
          });

        for (const voucher of selectedVouchersData) {
          if (voucher.organization_id !== org.id) {
            return res.status(403).json({ error: `Voucher ${voucher.code} does not belong to your organization` });
          }

          if (voucher.status !== 'active') {
            return res.status(400).json({ error: `Voucher ${voucher.code} is not active` });
          }

          if (new Date(voucher.expires_at) < new Date()) {
            return res.status(400).json({ error: `Voucher ${voucher.code} has expired` });
          }

          if (remainingCost <= 0) break;

          const amountToUse = Math.min(voucher.value, remainingCost);
          voucherAmountUsed += amountToUse;
          remainingCost -= amountToUse;

          if (amountToUse >= voucher.value) {
            await supabase.from('voucher').update({ status: 'used', used_at: new Date().toISOString() }).eq('id', voucher.id);
            voucherUsageDetails.push({ code: voucher.code, voucherId: voucher.id, amountUsed: amountToUse, fullyUsed: true });
          } else {
            const newValue = voucher.value - amountToUse;
            await supabase.from('voucher').update({ value: newValue }).eq('id', voucher.id);
            voucherUsageDetails.push({ code: voucher.code, voucherId: voucher.id, amountUsed: amountToUse, fullyUsed: false, remainingValue: newValue });
          }
        }
      }

      // Verify payment allocation
      const remainingAfterInternalFunds = totalCost - voucherAmountUsed - trainingFundAmount;
      const cardAmount = paymentMethod === 'card' ? remainingAfterInternalFunds : 0;
      const totalAllocated = voucherAmountUsed + trainingFundAmount + accountAmount + cardAmount;

      if (Math.abs(totalAllocated - totalCost) > 0.01) {
        return res.status(400).json({
          error: 'Payment allocation does not match total cost',
          totalCost: parseFloat(totalCost.toFixed(2)),
          totalAllocated: parseFloat(totalAllocated.toFixed(2))
        });
      }

      // Verify sufficient balances
      if (trainingFundAmount > (org.training_fund_balance || 0)) {
        return res.status(400).json({
          error: 'Insufficient training fund balance',
          available: org.training_fund_balance || 0,
          requested: trainingFundAmount
        });
      }

      if (accountAmount > 0 && paymentMethod === 'account' && !purchaseOrderNumber) {
        return res.status(400).json({ error: 'Purchase order number required for account charges' });
      }

      // Update organization balances
      const currentProgramBalances = org.program_ticket_balances || {};
      const currentProgramBalance = currentProgramBalances[programName] || 0;
      const newProgramBalance = currentProgramBalance + totalTicketsReceived;

      const updatedProgramBalances = { ...currentProgramBalances, [programName]: newProgramBalance };

      const updateData: any = {
        program_ticket_balances: updatedProgramBalances,
        last_synced: new Date().toISOString()
      };

      if (trainingFundAmount > 0) {
        updateData.training_fund_balance = (org.training_fund_balance || 0) - trainingFundAmount;
      }

      await supabase.from('organization').update(updateData).eq('id', org.id);

      // Build transaction notes
      const paymentMethods = [];
      if (voucherAmountUsed > 0) {
        const voucherSummary = voucherUsageDetails.map((v: any) =>
          `${v.code} (£${v.amountUsed.toFixed(2)}${v.fullyUsed ? ' - fully used' : ` - £${v.remainingValue?.toFixed(2)} remaining`})`
        ).join(', ');
        paymentMethods.push(`Vouchers: ${voucherSummary}`);
      }
      if (trainingFundAmount > 0) paymentMethods.push(`Training Fund: £${trainingFundAmount.toFixed(2)}`);
      if (accountAmount > 0) paymentMethods.push(`Account: £${accountAmount.toFixed(2)}`);
      if (cardAmount > 0) paymentMethods.push(`Card: £${cardAmount.toFixed(2)}${stripePaymentIntentId ? ` (Stripe: ${stripePaymentIntentId})` : ''}`);

      let transactionNotes = `Purchased ${quantity} ticket${quantity > 1 ? 's' : ''} for ${program.name}`;
      if (discountApplied) transactionNotes += ` (${discountDetails})`;
      transactionNotes += `. Total tickets received: ${totalTicketsReceived}.`;
      if (discountCode) transactionNotes += ` Discount code ${discountCode.code} applied: £${discountAmount.toFixed(2)} off.`;
      transactionNotes += ` Payment: ${paymentMethods.join(', ')}`;

      const transactionData: any = {
        organization_id: org.id,
        program_name: programName,
        transaction_type: 'purchase',
        quantity: totalTicketsReceived,
        original_quantity: totalTicketsReceived,
        cancelled_quantity: 0,
        status: 'active',
        purchase_order_number: purchaseOrderNumber || null,
        member_email: memberEmail,
        notes: transactionNotes,
        discount_code_id: discountCode?.id || null,
        discount_amount_applied: discountAmount > 0 ? discountAmount : null,
        total_cost_before_discount: costBeforeDiscountCodeApplication
      };

      // Create transaction record
      const { data: transaction } = await supabase.from('program_ticket_transaction').insert(transactionData).select().single();

      // Update transaction reference in fully used vouchers
      for (const usage of voucherUsageDetails) {
        if (usage.fullyUsed) {
          await supabase.from('voucher').update({ used_for_transaction_id: transaction?.id }).eq('id', usage.voucherId);
        }
      }

      // Check if Xero invoice generation is enabled
      let xeroInvoiceResult = null;
      const { data: xeroSettings } = await supabase
        .from('system_settings')
        .select('*')
        .eq('setting_key', 'xero_invoice_enabled')
        .maybeSingle();
      
      // Default to disabled if setting doesn't exist
      const xeroInvoiceEnabled = xeroSettings?.setting_value === 'true';
      
      // Only create Xero invoice if enabled and there's an account charge
      if (xeroInvoiceEnabled && accountAmount > 0) {
        try {
          console.log('[processProgramTicketPurchase] Creating Xero invoice for account charge:', accountAmount);
          
          // Get valid Xero token
          const { data: xeroToken } = await supabase
            .from('xero_token')
            .select('*')
            .single();
          
          if (xeroToken && xeroToken.access_token && xeroToken.tenant_id) {
            // Check if token needs refresh (5 min before expiry)
            let accessToken = xeroToken.access_token;
            const tenantId = xeroToken.tenant_id;
            
            if (new Date(xeroToken.expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
              // Refresh token
              const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
              const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
              
              if (XERO_CLIENT_ID && XERO_CLIENT_SECRET) {
                const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')
                  },
                  body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: xeroToken.refresh_token
                  }).toString()
                });
                
                if (tokenResponse.ok) {
                  const tokenData = await tokenResponse.json() as any;
                  accessToken = tokenData.access_token;
                  
                  await supabase
                    .from('xero_token')
                    .update({
                      access_token: tokenData.access_token,
                      refresh_token: tokenData.refresh_token,
                      expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
                    })
                    .eq('id', xeroToken.id);
                }
              }
            }
            
            // Find or create Xero contact
            // Use properly escaped contact name for Xero API
            const escapedOrgName = org.name.replace(/"/g, '\\"');
            const contactSearchResponse = await fetch(
              `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${escapedOrgName}"`)}`,
              {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'xero-tenant-id': tenantId,
                  'Accept': 'application/json'
                }
              }
            );
            
            let contactId: string;
            const contactData = await contactSearchResponse.json() as any;
            
            if (contactData.Contacts && contactData.Contacts.length > 0) {
              contactId = contactData.Contacts[0].ContactID;
            } else {
              // Create new contact
              const createContactResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'xero-tenant-id': tenantId,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ Contacts: [{ Name: org.name }] })
              });
              
              const newContactData = await createContactResponse.json() as any;
              if (newContactData.Contacts && newContactData.Contacts.length > 0) {
                contactId = newContactData.Contacts[0].ContactID;
              } else {
                throw new Error('Failed to create Xero contact');
              }
            }
            
            // Create invoice
            const invoicePayload = {
              Type: 'ACCREC',
              Contact: { ContactID: contactId },
              LineItems: [{
                Description: `${program.name} - ${quantity} ticket${quantity > 1 ? 's' : ''}${totalTicketsReceived > quantity ? ` (includes ${totalTicketsReceived - quantity} bonus ticket${totalTicketsReceived - quantity > 1 ? 's' : ''})` : ''}`,
                Quantity: 1,
                UnitAmount: accountAmount,
                AccountCode: '200' // Sales account - adjust as needed
              }],
              Reference: purchaseOrderNumber || `PTT-${transaction?.id || Date.now()}`,
              Status: 'AUTHORISED'
            };
            
            const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'xero-tenant-id': tenantId,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ Invoices: [invoicePayload] })
            });
            
            const invoiceData = await invoiceResponse.json() as any;
            
            if (invoiceData.Invoices && invoiceData.Invoices.length > 0) {
              xeroInvoiceResult = {
                invoice_id: invoiceData.Invoices[0].InvoiceID,
                invoice_number: invoiceData.Invoices[0].InvoiceNumber,
                total: invoiceData.Invoices[0].Total,
                status: invoiceData.Invoices[0].Status
              };
              console.log('[processProgramTicketPurchase] Xero invoice created:', xeroInvoiceResult);
            }
          } else {
            console.log('[processProgramTicketPurchase] Xero not configured, skipping invoice creation');
          }
        } catch (xeroError: any) {
          console.error('[processProgramTicketPurchase] Xero invoice creation failed:', xeroError.message);
          // Don't fail the purchase, just log the error
        }
      } else if (!xeroInvoiceEnabled) {
        console.log('[processProgramTicketPurchase] Xero invoice generation is disabled');
      }

      res.json({
        success: true,
        message: `Successfully added ${totalTicketsReceived} ${program.name} ticket${totalTicketsReceived > 1 ? 's' : ''} to ${org.name}`,
        balances: updatedProgramBalances,
        purchase_order_number: purchaseOrderNumber,
        quantity_purchased: quantity,
        total_tickets_received: totalTicketsReceived,
        free_tickets: totalTicketsReceived - quantity,
        total_cost: totalCost,
        discount_applied: discountAmount > 0,
        discount_amount: discountAmount,
        discount_code: discountCode?.code || null,
        discount_details: discountDetails,
        payment_breakdown: {
          vouchers: voucherAmountUsed,
          voucher_usage_details: voucherUsageDetails,
          training_fund: trainingFundAmount,
          account: accountAmount,
          card: cardAmount,
          payment_method: paymentMethod,
          stripe_payment_intent_id: stripePaymentIntentId
        },
        xero_invoice: xeroInvoiceResult,
        xero_invoice_enabled: xeroInvoiceEnabled,
        is_simulated_payment: false
      });

    } catch (error: any) {
      console.error('Purchase Error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process purchase',
        message: error.message
      });
    }
  });

  // Helper function to generate magic link token
  function generateMagicLinkToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Helper function to send email via Mailgun
  async function sendEmailViaMailgun(to: string, subject: string, body: string): Promise<any> {
    const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
    const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN;
    const MAILGUN_FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL;

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN || !MAILGUN_FROM_EMAIL) {
      throw new Error('Mailgun not configured');
    }

    const apiBase = 'https://api.eu.mailgun.net/v3';
    const formData = new URLSearchParams();
    formData.append('from', `AGCAS Events <${MAILGUN_FROM_EMAIL}>`);
    formData.append('to', to);
    formData.append('subject', subject);
    formData.append('text', body);

    const url = `${apiBase}/${MAILGUN_DOMAIN}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Mailgun API error (${response.status}): ${responseText}`);
    }

    return JSON.parse(responseText);
  }

  // Send Magic Link
  app.post('/api/functions/sendMagicLink', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      console.log('[sendMagicLink] Processing magic link request for:', email);

      // Validate user - check both TeamMember and Member tables
      const { data: teamMembers } = await supabase
        .from('team_member')
        .select('*')
        .ilike('email', email);

      const { data: members } = await supabase
        .from('member')
        .select('*')
        .ilike('email', email);

      const teamMember = teamMembers?.[0];
      const member = members?.[0];

      // Check if user exists and has login enabled
      let isValid = false;
      let userType = '';

      if (teamMember) {
        isValid = true;
        userType = 'team_member';
      } else if (member && member.login_enabled !== false) {
        isValid = true;
        userType = 'member';
      }

      if (!isValid) {
        return res.status(404).json({
          success: false,
          error: 'User not found or login not enabled'
        });
      }

      console.log('[sendMagicLink] User validated successfully:', userType);

      // Generate magic link token
      const token = generateMagicLinkToken();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      // Clean up old/expired magic links for this email
      await supabase
        .from('magic_link')
        .delete()
        .ilike('email', email);

      // Create new magic link
      await supabase.from('magic_link').insert({
        email: email.toLowerCase(),
        token,
        expires_at: expiresAt,
        used: false
      });

      console.log('[sendMagicLink] Magic link created in database');

      // Generate the magic link URL
      const baseUrl = process.env.MAGIC_LINK_BASE_URL || 'https://agcas.isaasi.co.uk';
      const magicLinkUrl = `${baseUrl}/VerifyMagicLink?token=${token}`;

      // Send email with magic link via Mailgun
      await sendEmailViaMailgun(
        email,
        'Your AGCAS Events Login Link',
        `
Hello,

Click the link below to access the AGCAS Events portal:

${magicLinkUrl}

This link will expire in 30 minutes.

If you didn't request this login link, please ignore this email.

Best regards,
AGCAS Events Team
        `.trim()
      );

      console.log('[sendMagicLink] Email sent successfully via Mailgun');

      res.json({
        success: true,
        message: 'Magic link sent to your email'
      });

    } catch (error: any) {
      console.error('[sendMagicLink] error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send magic link',
        details: error.message
      });
    }
  });

  // Verify Magic Link
  app.post('/api/functions/verifyMagicLink', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { token } = req.body;

      console.log('[verifyMagicLink] Token received:', token ? 'yes' : 'no');

      if (!token) {
        return res.status(400).json({ error: 'Token is required' });
      }

      // Find the magic link
      const { data: allLinks } = await supabase.from('magic_link').select('*');
      const magicLink = allLinks?.find((link: any) => link.token === token);

      if (!magicLink) {
        console.log('[verifyMagicLink] Token not found in database');
        return res.status(404).json({
          success: false,
          error: 'Invalid or expired link'
        });
      }

      // Check if already used
      if (magicLink.used) {
        console.log('[verifyMagicLink] Token already used');
        return res.status(400).json({
          success: false,
          error: 'This link has already been used'
        });
      }

      // Check if expired
      if (new Date(magicLink.expires_at) < new Date()) {
        console.log('[verifyMagicLink] Token expired');
        return res.status(400).json({
          success: false,
          error: 'This link has expired'
        });
      }

      // Mark as used
      await supabase
        .from('magic_link')
        .update({ used: true })
        .eq('id', magicLink.id);

      console.log('[verifyMagicLink] Validating user for:', magicLink.email);

      // Validate user and get their data
      const { data: teamMembers } = await supabase
        .from('team_member')
        .select('*')
        .eq('email', magicLink.email);

      const { data: members } = await supabase
        .from('member')
        .select('*')
        .eq('email', magicLink.email);

      const teamMember = teamMembers?.[0];
      const member = members?.[0];

      let user: any = null;

      if (teamMember) {
        user = {
          email: teamMember.email,
          first_name: teamMember.first_name,
          last_name: teamMember.last_name,
          is_team_member: true,
          role: teamMember.role
        };
      } else if (member && member.login_enabled !== false) {
        // Get organization details
        const { data: orgs } = await supabase
          .from('organization')
          .select('*')
          .eq('id', member.organization_id);

        const org = orgs?.[0];

        user = {
          email: member.email,
          first_name: member.first_name,
          last_name: member.last_name,
          is_team_member: false,
          organization_id: member.organization_id,
          organization_name: org?.name || null,
          zoho_contact_id: member.zoho_contact_id,
          member_id: member.id
        };

        // Update last_login
        try {
          await supabase
            .from('member')
            .update({ last_login: new Date().toISOString() })
            .eq('id', member.id);
        } catch (updateError: any) {
          console.warn('[verifyMagicLink] Failed to update last_login:', updateError.message);
        }
      }

      if (!user) {
        return res.status(403).json({
          success: false,
          error: 'User not found or login not enabled'
        });
      }

      console.log('[verifyMagicLink] User validated successfully');

      res.json({
        success: true,
        user
      });

    } catch (error: any) {
      console.error('[verifyMagicLink] error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to verify link',
        details: error.message
      });
    }
  });

  // Sync Organization Contacts from Zoho CRM
  app.post('/api/functions/syncOrganizationContacts', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    try {
      const { organizationId } = req.body;

      console.log('=== Sync Organization Contacts Started ===');
      console.log('Organization ID:', organizationId);

      if (!organizationId) {
        return res.status(400).json({
          success: false,
          error: 'Organization ID is required'
        });
      }

      // Get the organization - try by ID first, then by Zoho Account ID
      const { data: allOrgs } = await supabase.from('organization').select('*');
      let org = allOrgs?.find((o: any) => o.id === organizationId);

      if (!org) {
        console.log('Not found by ID, trying Zoho Account ID...');
        org = allOrgs?.find((o: any) => o.zoho_account_id === organizationId);
      }

      console.log('Organization found:', org ? org.name : 'NOT FOUND');

      if (!org || !org.zoho_account_id) {
        return res.status(404).json({
          success: false,
          error: 'Organization not found or not linked to Zoho',
          details: {
            organizationFound: !!org,
            zohoAccountId: org?.zoho_account_id
          }
        });
      }

      const accessToken = await getValidZohoAccessToken();
      console.log('Access token obtained');

      // Fetch all contacts for this organization from Zoho CRM
      let allContacts: any[] = [];
      let page = 1;
      const perPage = 200;
      let hasMore = true;

      console.log('Searching for contacts with Account Name:', org.name);

      while (hasMore) {
        const criteria = `(Account_Name:equals:${org.name})`;
        const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}&page=${page}&per_page=${perPage}`;

        console.log(`Fetching page ${page}...`);

        const response = await fetch(searchUrl, {
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
          },
        });

        const responseText = await response.text();
        console.log('Response status:', response.status);

        if (!response.ok) {
          console.error('Failed to fetch contacts from Zoho:', responseText);
          break;
        }

        let data;
        try {
          data = JSON.parse(responseText);
        } catch (e) {
          console.error('Failed to parse JSON response');
          break;
        }

        console.log('Contacts in this page:', data.data?.length || 0);

        if (data.data && data.data.length > 0) {
          allContacts = allContacts.concat(data.data);

          if (data.info && data.info.more_records) {
            page++;
          } else {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }

      console.log('Total contacts fetched from Zoho:', allContacts.length);

      if (allContacts.length === 0) {
        console.log('No contacts found for this organization');
        await supabase
          .from('organization')
          .update({ contacts_synced_at: new Date().toISOString() })
          .eq('id', org.id);

        return res.json({
          success: true,
          synced_count: 0,
          created: 0,
          updated: 0,
          deactivated: 0,
          message: 'No contacts found for this organization'
        });
      }

      // Get existing contacts for this organization
      const { data: existingContacts } = await supabase
        .from('organization_contact')
        .select('*')
        .eq('organization_id', org.id);

      console.log('Existing contacts in database:', existingContacts?.length || 0);

      const existingByZohoId: Record<string, any> = {};
      (existingContacts || []).forEach((contact: any) => {
        existingByZohoId[contact.zoho_contact_id] = contact;
      });

      // Prepare contacts to create or update
      const contactsToCreate: any[] = [];
      const contactsToUpdate: any[] = [];
      const zohoIdsFound = new Set<string>();

      for (const zohoContact of allContacts) {
        zohoIdsFound.add(zohoContact.id);

        if (!zohoContact.Email) {
          console.log(`Skipping Zoho contact ID ${zohoContact.id} because it has no email.`);
          continue;
        }

        const contactData = {
          organization_id: org.id,
          zoho_contact_id: zohoContact.id,
          email: zohoContact.Email,
          first_name: zohoContact.First_Name || '',
          last_name: zohoContact.Last_Name || '',
          is_active: true,
          last_synced: new Date().toISOString()
        };

        if (existingByZohoId[zohoContact.id]) {
          contactsToUpdate.push({
            id: existingByZohoId[zohoContact.id].id,
            ...contactData
          });
        } else {
          contactsToCreate.push(contactData);
        }
      }

      console.log('Contacts to create:', contactsToCreate.length);
      console.log('Contacts to update:', contactsToUpdate.length);

      // Mark contacts no longer in Zoho as inactive
      const contactsToDeactivate = (existingContacts || []).filter(
        (c: any) => !zohoIdsFound.has(c.zoho_contact_id) && c.is_active
      );

      console.log('Contacts to deactivate:', contactsToDeactivate.length);

      // Perform operations
      if (contactsToCreate.length > 0) {
        console.log(`Creating ${contactsToCreate.length} contacts...`);
        await supabase.from('organization_contact').insert(contactsToCreate);
        console.log(`${contactsToCreate.length} contacts created successfully.`);
      }

      if (contactsToUpdate.length > 0) {
        console.log(`Updating ${contactsToUpdate.length} contacts...`);
        for (const contact of contactsToUpdate) {
          const { id, ...updateData } = contact;
          await supabase.from('organization_contact').update(updateData).eq('id', id);
        }
        console.log(`${contactsToUpdate.length} contacts updated successfully.`);
      }

      if (contactsToDeactivate.length > 0) {
        console.log(`Deactivating ${contactsToDeactivate.length} contacts...`);
        for (const contact of contactsToDeactivate) {
          await supabase
            .from('organization_contact')
            .update({ is_active: false, last_synced: new Date().toISOString() })
            .eq('id', contact.id);
        }
        console.log(`${contactsToDeactivate.length} contacts deactivated successfully.`);
      }

      // Update organization sync timestamp
      await supabase
        .from('organization')
        .update({ contacts_synced_at: new Date().toISOString() })
        .eq('id', org.id);

      console.log('=== Sync Complete ===');

      res.json({
        success: true,
        synced_count: allContacts.length,
        created: contactsToCreate.length,
        updated: contactsToUpdate.length,
        deactivated: contactsToDeactivate.length
      });

    } catch (error: any) {
      console.error('=== Sync Error ===');
      console.error('Error message:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Zoho Contact Webhook - receives contact updates from Zoho CRM
  app.post('/api/functions/zohoContactWebhook', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const webhookData = req.body;

      console.log('Webhook received:', JSON.stringify(webhookData, null, 2));

      // Extract contact information from webhook
      const contactData = webhookData.data || webhookData;

      if (!contactData.id || !contactData.Email) {
        return res.status(400).json({
          success: false,
          error: 'Missing required contact data'
        });
      }

      // Find which organization this contact belongs to
      let organizationId = null;
      if (contactData.Account_Name && contactData.Account_Name.id) {
        const { data: allOrgs } = await supabase.from('organization').select('*');
        const org = allOrgs?.find((o: any) => o.zoho_account_id === contactData.Account_Name.id);
        if (org) {
          organizationId = org.id;
        }
      }

      if (!organizationId) {
        return res.json({
          success: true,
          message: 'Contact not associated with a synced organization'
        });
      }

      // Check if contact already exists
      const { data: existingContacts } = await supabase
        .from('organization_contact')
        .select('*')
        .eq('zoho_contact_id', contactData.id);

      const contactRecord = {
        organization_id: organizationId,
        zoho_contact_id: contactData.id,
        email: contactData.Email,
        first_name: contactData.First_Name || '',
        last_name: contactData.Last_Name || '',
        is_active: true,
        last_synced: new Date().toISOString()
      };

      if (existingContacts && existingContacts.length > 0) {
        // Update existing contact
        await supabase
          .from('organization_contact')
          .update(contactRecord)
          .eq('id', existingContacts[0].id);

        res.json({
          success: true,
          action: 'updated',
          contact_id: existingContacts[0].id
        });
      } else {
        // Create new contact
        const { data: newContact } = await supabase
          .from('organization_contact')
          .insert(contactRecord)
          .select()
          .single();

        res.json({
          success: true,
          action: 'created',
          contact_id: newContact?.id
        });
      }

    } catch (error: any) {
      console.error('Webhook error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Update Expired Vouchers - administrative task
  app.post('/api/functions/updateExpiredVouchers', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      console.log('[updateExpiredVouchers] Starting voucher expiry check...');

      // Fetch all active vouchers
      const { data: allVouchers } = await supabase
        .from('voucher')
        .select('*')
        .eq('status', 'active');

      console.log('[updateExpiredVouchers] Found active vouchers:', allVouchers?.length || 0);

      // Check which ones have expired
      const now = new Date();
      console.log('[updateExpiredVouchers] Current time:', now.toISOString());

      const expiredVouchers = (allVouchers || []).filter((v: any) => {
        const expiryDate = new Date(v.expires_at);
        const isExpired = expiryDate.getTime() < now.getTime();
        if (isExpired) {
          console.log(`[updateExpiredVouchers] Voucher ${v.code} (${v.id}) expired at ${v.expires_at}`);
        }
        return isExpired;
      });

      console.log('[updateExpiredVouchers] Expired vouchers to update:', expiredVouchers.length);

      if (expiredVouchers.length === 0) {
        console.log('[updateExpiredVouchers] No expired vouchers to update');
        return res.json({
          success: true,
          updated_count: 0,
          message: 'No expired vouchers found'
        });
      }

      // Update each expired voucher
      const updatePromises = expiredVouchers.map((voucher: any) => {
        console.log(`[updateExpiredVouchers] Updating voucher ${voucher.code} (${voucher.id}) to expired status`);
        return supabase
          .from('voucher')
          .update({ status: 'expired' })
          .eq('id', voucher.id);
      });

      await Promise.all(updatePromises);

      console.log('[updateExpiredVouchers] Successfully updated all expired vouchers');

      res.json({
        success: true,
        updated_count: expiredVouchers.length,
        expired_voucher_ids: expiredVouchers.map((v: any) => v.id)
      });

    } catch (error: any) {
      console.error('[updateExpiredVouchers] Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Create Stripe Payment Intent
  app.post('/api/functions/createStripePaymentIntent', async (req: Request, res: Response) => {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

    if (!stripeSecretKey) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    try {
      const Stripe = require('stripe');
      const stripe = new Stripe(stripeSecretKey);

      const { amount, currency = 'gbp', metadata = {}, memberEmail } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({
          error: 'Invalid amount',
          details: 'Amount must be greater than 0'
        });
      }

      if (!memberEmail) {
        return res.status(400).json({
          error: 'Member email is required'
        });
      }

      // Create a Payment Intent with Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Stripe expects amount in pence/cents
        currency: currency,
        metadata: {
          member_email: memberEmail,
          ...metadata
        },
        automatic_payment_methods: {
          enabled: true,
        },
      });

      res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });

    } catch (error: any) {
      console.error('Stripe Payment Intent Error:', error);
      res.status(500).json({
        error: 'Failed to create payment intent',
        details: error.message
      });
    }
  });

  // Get Stripe Publishable Key (safe to expose to frontend)
  app.get('/api/functions/getStripePublishableKey', async (req: Request, res: Response) => {
    try {
      const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

      if (!publishableKey) {
        return res.status(500).json({
          error: 'Stripe publishable key not configured'
        });
      }

      res.json({
        success: true,
        publishableKey
      });

    } catch (error: any) {
      console.error('Error fetching publishable key:', error);
      res.status(500).json({
        error: 'Failed to fetch publishable key',
        details: error.message
      });
    }
  });

  // ============ Xero Integration Routes ============

  // Xero OAuth Callback
  app.get('/api/functions/xeroOAuthCallback', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).send('<html><body><h1>Database not configured</h1></body></html>');
    }

    try {
      const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
      const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
      const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;

      const code = req.query.code as string;
      const error = req.query.error as string;

      if (error) {
        return res.status(400).send(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1 style="color: #dc2626;">Authentication Error</h1>
              <p>Failed to authenticate with Xero: ${error}</p>
              <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
                Close Window
              </button>
            </body>
          </html>
        `);
      }

      if (!code) {
        return res.status(400).json({ error: 'No authorization code provided' });
      }

      // Exchange code for tokens
      const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: XERO_REDIRECT_URI || '',
        }).toString(),
      });

      const tokenData = await tokenResponse.json() as any;

      if (!tokenResponse.ok || tokenData.error) {
        return res.status(400).send(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1 style="color: #dc2626;">Token Exchange Failed</h1>
              <p>Error: ${JSON.stringify(tokenData)}</p>
              <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
                Close Window
              </button>
            </body>
          </html>
        `);
      }

      // Get tenant connections
      const connectionsResponse = await fetch('https://api.xero.com/connections', {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        }
      });

      const connections = await connectionsResponse.json() as any[];

      if (!connections || connections.length === 0) {
        return res.status(400).send(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1 style="color: #dc2626;">No Xero Organizations Found</h1>
              <p>Please ensure your Xero account has at least one organization.</p>
              <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
                Close Window
              </button>
            </body>
          </html>
        `);
      }

      // If multiple tenants, show selection page
      if (connections.length > 1) {
        // Store tokens temporarily with all connection info
        const tempTokenData = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          token_type: tokenData.token_type || 'Bearer',
          connections: connections.map((c: any) => ({
            tenantId: c.tenantId,
            tenantName: c.tenantName,
            tenantType: c.tenantType
          }))
        };
        
        // Store in database temporarily with a special marker
        const { data: existingTokens } = await supabase
          .from('xero_token')
          .select('*');
        
        const tempRecord = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString(),
          tenant_id: 'PENDING_SELECTION',
          token_type: tokenData.token_type || 'Bearer',
        };
        
        if (existingTokens && existingTokens.length > 0) {
          await supabase
            .from('xero_token')
            .update(tempRecord)
            .eq('id', existingTokens[0].id);
        } else {
          await supabase
            .from('xero_token')
            .insert(tempRecord);
        }
        
        // Show tenant selection page
        const tenantOptions = connections.map((c: any) => `
          <button onclick="selectTenant('${c.tenantId}', '${c.tenantName.replace(/'/g, "\\'")}')" 
                  style="display: block; width: 100%; margin: 10px 0; padding: 15px 20px; 
                         background: white; border: 2px solid #e2e8f0; border-radius: 8px; 
                         cursor: pointer; text-align: left; font-size: 16px;
                         transition: all 0.2s;">
            <strong>${c.tenantName}</strong>
            <span style="color: #64748b; font-size: 14px; display: block; margin-top: 4px;">
              ${c.tenantType === 'ORGANISATION' ? 'Organization' : c.tenantType}
            </span>
          </button>
        `).join('');
        
        return res.send(`
          <html>
            <head>
              <style>
                body {
                  font-family: system-ui;
                  padding: 40px;
                  max-width: 500px;
                  margin: 0 auto;
                  background: linear-gradient(to br, #f8fafc, #eff6ff);
                }
                h1 { color: #1e40af; margin-bottom: 10px; }
                p { color: #64748b; margin-bottom: 30px; }
                button:hover { border-color: #2563eb !important; background: #f8fafc !important; }
              </style>
            </head>
            <body>
              <h1>Select Xero Organization</h1>
              <p>You have multiple Xero organizations. Please select which one to use for invoicing:</p>
              ${tenantOptions}
              <script>
                async function selectTenant(tenantId, tenantName) {
                  try {
                    const response = await fetch('/api/xero/select-tenant', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ tenantId, tenantName })
                    });
                    
                    if (response.ok) {
                      document.body.innerHTML = \`
                        <h1 style="color: #16a34a;">Xero Connected Successfully</h1>
                        <p>Connected to: <strong>\${tenantName}</strong></p>
                        <p style="font-size: 14px; color: #64748b;">You can now close this window.</p>
                        <button onclick="window.close()" style="margin-top: 20px; padding: 12px 24px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">Close Window</button>
                      \`;
                      setTimeout(() => window.close(), 3000);
                    } else {
                      alert('Failed to select tenant. Please try again.');
                    }
                  } catch (error) {
                    alert('Error: ' + error.message);
                  }
                }
              </script>
            </body>
          </html>
        `);
      }

      // Single tenant - use it directly
      const tenantId = connections[0].tenantId;

      // Calculate expiration
      const expiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

      // Store tokens in database
      const { data: existingTokens } = await supabase
        .from('xero_token')
        .select('*');

      const tokenRecord = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        tenant_id: tenantId,
        token_type: tokenData.token_type || 'Bearer',
      };

      if (existingTokens && existingTokens.length > 0) {
        await supabase
          .from('xero_token')
          .update(tokenRecord)
          .eq('id', existingTokens[0].id);
      } else {
        await supabase
          .from('xero_token')
          .insert(tokenRecord);
      }

      res.send(`
        <html>
          <head>
            <style>
              body {
                font-family: system-ui;
                padding: 40px;
                text-align: center;
                background: linear-gradient(to br, #f8fafc, #eff6ff);
              }
              .success { color: #16a34a; margin-bottom: 10px; }
              button {
                margin-top: 20px;
                padding: 12px 24px;
                background: #2563eb;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 16px;
              }
              button:hover { background: #1d4ed8; }
            </style>
          </head>
          <body>
            <h1 class="success">Xero Connected Successfully</h1>
            <p>Your Xero account (${connections[0].tenantName}) has been connected.</p>
            <p style="font-size: 14px; color: #64748b;">You can now close this window.</p>
            <button onclick="window.close()">Close Window</button>
            <script>
              setTimeout(() => window.close(), 3000);
            </script>
          </body>
        </html>
      `);

    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Xero tenant selection endpoint
  app.post('/api/xero/select-tenant', async (req, res) => {
    try {
      const { tenantId, tenantName } = req.body;
      
      if (!tenantId) {
        return res.status(400).json({ error: 'Tenant ID is required' });
      }
      
      // Update the existing token record with the selected tenant
      const { data: existingTokens } = await supabase
        .from('xero_token')
        .select('*');
      
      if (!existingTokens || existingTokens.length === 0) {
        return res.status(400).json({ error: 'No pending token found' });
      }
      
      await supabase
        .from('xero_token')
        .update({ tenant_id: tenantId })
        .eq('id', existingTokens[0].id);
      
      res.json({ success: true, tenantName });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Sync VAT rates from Xero
  app.post('/api/xero/sync-vat-rates', async (req, res) => {
    try {
      // Get valid Xero access token
      const { accessToken, tenantId } = await getValidXeroAccessToken(supabase);
      
      if (!accessToken || !tenantId) {
        return res.status(400).json({ error: 'Xero not authenticated. Please authenticate with Xero first.' });
      }
      
      // Fetch tax rates from Xero
      const taxRatesResponse = await fetch('https://api.xero.com/api.xro/2.0/TaxRates', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          'Accept': 'application/json'
        }
      });
      
      if (!taxRatesResponse.ok) {
        const errorData = await taxRatesResponse.json();
        console.error('[Xero VAT Sync] Failed to fetch tax rates:', errorData);
        return res.status(500).json({ error: 'Failed to fetch VAT rates from Xero' });
      }
      
      const taxRatesData = await taxRatesResponse.json() as any;
      const taxRates = taxRatesData.TaxRates || [];
      
      // Transform the data into a simpler format for storage
      const vatRates = taxRates.map((rate: any) => ({
        name: rate.Name,
        taxType: rate.TaxType,
        displayRate: rate.DisplayTaxRate,
        effectiveRate: rate.EffectiveRate,
        status: rate.Status,
        canApplyToAssets: rate.CanApplyToAssets,
        canApplyToEquity: rate.CanApplyToEquity,
        canApplyToExpenses: rate.CanApplyToExpenses,
        canApplyToLiabilities: rate.CanApplyToLiabilities,
        canApplyToRevenue: rate.CanApplyToRevenue
      }));
      
      // Store in system_settings
      const settingKey = 'xero_vat_rates';
      const settingValue = JSON.stringify({
        rates: vatRates,
        syncedAt: new Date().toISOString(),
        count: vatRates.length
      });
      
      // Upsert the setting
      const { data: existingSetting } = await supabase
        .from('system_settings')
        .select('id')
        .eq('setting_key', settingKey)
        .single();
      
      if (existingSetting) {
        await supabase
          .from('system_settings')
          .update({ setting_value: settingValue })
          .eq('setting_key', settingKey);
      } else {
        await supabase
          .from('system_settings')
          .insert({ setting_key: settingKey, setting_value: settingValue });
      }
      
      console.log(`[Xero VAT Sync] Successfully synced ${vatRates.length} VAT rates`);
      
      res.json({ 
        success: true, 
        count: vatRates.length,
        rates: vatRates,
        syncedAt: new Date().toISOString()
      });
    } catch (error: any) {
      console.error('[Xero VAT Sync] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Helper function to get valid Xero access token
  async function getValidXeroAccessToken(supabaseClient: any) {
    const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
    const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;

    const { data: tokens } = await supabaseClient
      .from('xero_token')
      .select('*');

    if (!tokens || tokens.length === 0) {
      throw new Error('No Xero token found. Please authenticate first.');
    }

    const token = tokens[0];
    const expiresAt = new Date(token.expires_at);
    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

    // Token is still valid
    if (expiresAt > fiveMinutesFromNow) {
      return { accessToken: token.access_token, tenantId: token.tenant_id };
    }

    // Refresh token
    const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }).toString(),
    });

    const tokenData = await tokenResponse.json() as any;

    if (!tokenResponse.ok || tokenData.error) {
      throw new Error(`Failed to refresh Xero token: ${JSON.stringify(tokenData)}`);
    }

    const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

    await supabaseClient
      .from('xero_token')
      .update({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: newExpiresAt,
      })
      .eq('id', token.id);

    return { accessToken: tokenData.access_token, tenantId: token.tenant_id };
  }

  // Helper function to find or create Xero contact
  async function findOrCreateXeroContact(accessToken: string, tenantId: string, organizationName: string) {
    // Search for existing contact
    const searchResponse = await fetch(
      `https://api.xero.com/api.xro/2.0/Contacts?where=Name=="${encodeURIComponent(organizationName)}"`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          'Accept': 'application/json'
        }
      }
    );

    const searchData = await searchResponse.json() as any;

    if (searchData.Contacts && searchData.Contacts.length > 0) {
      return searchData.Contacts[0].ContactID;
    }

    // Create new contact
    const createResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        Contacts: [{
          Name: organizationName
        }]
      })
    });

    const createData = await createResponse.json() as any;

    if (!createResponse.ok || !createData.Contacts || createData.Contacts.length === 0) {
      throw new Error(`Failed to create Xero contact: ${JSON.stringify(createData)}`);
    }

    return createData.Contacts[0].ContactID;
  }

  // Generate Sitemap - creates XML sitemap for SEO
  app.get('/api/functions/generateSitemap', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      // Get the base URL from request or environment
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'] || req.headers['x-forwarded-host'];
      const appBaseUrl = process.env.APP_BASE_URL || `${protocol}://${host}`;

      // Fetch all published articles
      const { data: allArticles } = await supabase.from('blog_post').select('*');
      const publishedArticles = (allArticles || []).filter(
        (a: any) => a.status === 'published' && a.published_date && new Date(a.published_date) <= new Date()
      );

      // Fetch all published news
      const { data: allNews } = await supabase.from('news_post').select('*');
      const publishedNews = (allNews || []).filter(
        (n: any) => n.status === 'published' && n.published_date && new Date(n.published_date) <= new Date()
      );

      // Fetch all active job postings
      const { data: allJobs } = await supabase.from('job_posting').select('*');
      const activeJobs = (allJobs || []).filter((j: any) => j.status === 'active');

      // Fetch all public custom pages
      const { data: allPages } = await supabase.from('iedit_page').select('*');
      const publicPages = (allPages || []).filter((p: any) => p.is_public);

      // Static public pages
      const staticPages = [
        { loc: '/', priority: '1.0' },
        { loc: '/PublicEvents', priority: '0.8' },
        { loc: '/PublicArticles', priority: '0.8' },
        { loc: '/PublicNews', priority: '0.8' },
        { loc: '/PublicResources', priority: '0.8' },
        { loc: '/JobBoard', priority: '0.8' },
        { loc: '/PostJob', priority: '0.7' },
        { loc: '/OrganisationDirectory', priority: '0.7' },
      ];

      // Build XML sitemap
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      xml += `<!-- Sitemap generated at ${new Date().toISOString()} -->\n`;
      xml += `<!-- Articles: ${publishedArticles.length}, News: ${publishedNews.length}, Jobs: ${activeJobs.length}, Pages: ${publicPages.length} -->\n`;
      xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

      // Add static pages
      staticPages.forEach(page => {
        xml += '  <url>\n';
        xml += `    <loc>${appBaseUrl}${page.loc}</loc>\n`;
        xml += `    <priority>${page.priority}</priority>\n`;
        xml += '    <changefreq>weekly</changefreq>\n';
        xml += '  </url>\n';
      });

      // Add articles
      publishedArticles.forEach((article: any) => {
        xml += '  <url>\n';
        xml += `    <loc>${appBaseUrl}/ArticleView?slug=${encodeURIComponent(article.slug)}</loc>\n`;
        xml += `    <lastmod>${new Date(article.updated_date || article.published_date).toISOString()}</lastmod>\n`;
        xml += '    <priority>0.7</priority>\n';
        xml += '    <changefreq>monthly</changefreq>\n';
        xml += '  </url>\n';
      });

      // Add news posts
      publishedNews.forEach((post: any) => {
        xml += '  <url>\n';
        xml += `    <loc>${appBaseUrl}/NewsView?slug=${encodeURIComponent(post.slug)}</loc>\n`;
        xml += `    <lastmod>${new Date(post.updated_date || post.published_date).toISOString()}</lastmod>\n`;
        xml += '    <priority>0.6</priority>\n';
        xml += '    <changefreq>weekly</changefreq>\n';
        xml += '  </url>\n';
      });

      // Add job postings
      activeJobs.forEach((job: any) => {
        xml += '  <url>\n';
        xml += `    <loc>${appBaseUrl}/JobDetails?id=${job.id}</loc>\n`;
        xml += `    <lastmod>${new Date(job.updated_date || job.created_date).toISOString()}</lastmod>\n`;
        xml += '    <priority>0.6</priority>\n';
        xml += '    <changefreq>daily</changefreq>\n';
        xml += '  </url>\n';
      });

      // Add custom public pages
      publicPages.forEach((page: any) => {
        xml += '  <url>\n';
        xml += `    <loc>${appBaseUrl}/ViewPage?slug=${encodeURIComponent(page.slug)}</loc>\n`;
        xml += `    <lastmod>${new Date(page.updated_date).toISOString()}</lastmod>\n`;
        xml += '    <priority>0.7</priority>\n';
        xml += '    <changefreq>monthly</changefreq>\n';
        xml += '  </url>\n';
      });

      xml += '</urlset>';

      res.set('Content-Type', 'application/xml');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(xml);

    } catch (error: any) {
      console.error('[generateSitemap] Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Also expose sitemap at standard /sitemap.xml path
  app.get('/sitemap.xml', async (req: Request, res: Response) => {
    // Redirect to the function endpoint
    res.redirect('/api/functions/generateSitemap');
  });

  // Export All Data - admin export of all entities to ZIP
  app.post('/api/functions/exportAllData', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    // Helper function to convert array of objects to CSV
    function arrayToCSV(data: any[]): string {
      if (!data || data.length === 0) return '';

      const allKeys = new Set<string>();
      data.forEach(obj => {
        Object.keys(obj).forEach(key => allKeys.add(key));
      });

      const headers = Array.from(allKeys);
      const csvRows = [headers.join(',')];

      data.forEach(obj => {
        const values = headers.map(header => {
          const value = obj[header];

          if (value === null || value === undefined) {
            return '';
          }

          if (typeof value === 'object') {
            return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
          }

          if (typeof value === 'string') {
            if (value.includes(',') || value.includes('\n') || value.includes('"')) {
              return `"${value.replace(/"/g, '""')}"`;
            }
          }

          return value;
        });

        csvRows.push(values.join(','));
      });

      return csvRows.join('\n');
    }

    try {
      const { memberEmail } = req.body;

      if (!memberEmail) {
        return res.status(400).json({ error: 'Member email required' });
      }

      console.log('Validating member:', memberEmail);

      // Check both Member and TeamMember entities
      const [rolesResult, membersResult, teamMembersResult] = await Promise.all([
        supabase.from('role').select('*'),
        supabase.from('member').select('*'),
        supabase.from('team_member').select('*')
      ]);

      const roles = rolesResult.data || [];
      const members = membersResult.data || [];
      const teamMembers = teamMembersResult.data || [];

      const member = members.find((m: any) => m.email === memberEmail);
      const teamMember = teamMembers.find((tm: any) => tm.email === memberEmail);

      let userRole = null;

      if (member?.role_id) {
        userRole = roles.find((r: any) => r.id === member.role_id);
      } else if (teamMember?.role_id) {
        userRole = roles.find((r: any) => r.id === teamMember.role_id);
      }

      // Check if user has access to data export feature
      const userExcludedFeatures = userRole?.excluded_features || [];
      const hasDataExportAccess = userRole && !userExcludedFeatures.includes('admin.data-export');
      
      if (!hasDataExportAccess) {
        console.log('Access denied - no data export access');
        return res.status(403).json({ error: 'Data export access required' });
      }

      console.log('Data export access confirmed, starting export...');

      // List of all table names to export (snake_case for Supabase)
      const tableNames = [
        'member', 'organization', 'event', 'booking', 'program_ticket_transaction',
        'magic_link', 'organization_contact', 'program', 'voucher', 'blog_post',
        'role', 'team_member', 'discount_code', 'discount_code_usage', 'system_settings',
        'resource', 'resource_category', 'resource_folder', 'file_repository', 'file_repository_folder',
        'job_posting', 'page_banner', 'iedit_page', 'iedit_page_element', 'iedit_element_template',
        'navigation_item', 'article_category', 'article_comment', 'comment_reaction',
        'article_reaction', 'article_view', 'button_style', 'award', 'offline_award',
        'offline_award_assignment', 'wall_of_fame_section', 'wall_of_fame_category', 'wall_of_fame_person',
        'floater', 'form', 'form_submission', 'tour_group', 'tour_step', 'news_post',
        'resource_author_settings', 'zoho_token', 'xero_token'
      ];

      // Create a new ZIP file
      const JSZip = require('jszip');
      const zip = new JSZip();

      // Export each entity
      for (const tableName of tableNames) {
        try {
          const { data: records, error } = await supabase.from(tableName).select('*');

          if (!error && records && records.length > 0) {
            const csv = arrayToCSV(records);
            zip.file(`${tableName}.csv`, csv);
            console.log(`Exported ${records.length} records from ${tableName}`);
          }
        } catch (error: any) {
          console.warn(`Failed to export ${tableName}:`, error.message);
        }
      }

      // Generate ZIP file
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      // Create a file name with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      const fileName = `data-export-${timestamp}.zip`;

      // Upload to Supabase storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('exports')
        .upload(fileName, zipBuffer, {
          contentType: 'application/zip',
          upsert: true
        });

      if (uploadError) {
        // If exports bucket doesn't exist, try creating it or use a different approach
        console.error('Upload error:', uploadError);
        
        // Return the file as base64 as a fallback
        const base64Data = zipBuffer.toString('base64');
        return res.json({
          success: true,
          file_name: fileName,
          data: base64Data,
          encoding: 'base64',
          message: 'Download the file using the base64 data'
        });
      }

      // Create signed URL (expires in 1 hour)
      const { data: signedUrlData } = await supabase.storage
        .from('exports')
        .createSignedUrl(fileName, 3600);

      res.json({
        success: true,
        download_url: signedUrlData?.signedUrl,
        file_name: fileName,
        expires_in: 3600
      });

    } catch (error: any) {
      console.error('Export error:', error);
      res.status(500).json({
        error: 'Failed to export data',
        details: error.message
      });
    }
  });

  // Send Team Member Invite - sends invitation via Mailgun with custom email template
  app.post('/api/functions/sendTeamMemberInvite', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email, inviterName, inviterEmail, emailSubject, emailBody } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      if (!inviterEmail) {
        return res.status(401).json({ error: 'Unauthorized - inviter email required' });
      }

      // Get base URL for signup link
      let baseUrl = process.env.SITE_URL;
      if (!baseUrl && process.env.VERCEL_URL) {
        baseUrl = `https://${process.env.VERCEL_URL}`;
      }
      if (!baseUrl) {
        baseUrl = `${req.protocol}://${req.get('host')}`;
      }
      if (!baseUrl || baseUrl === 'undefined://undefined') {
        console.error('[sendTeamMemberInvite] Base URL could not be determined');
        return res.status(500).json({ error: 'Server configuration error: site URL not set' });
      }

      // Check if the invitee already has a member record
      const { data: existingMember } = await supabase
        .from('member')
        .select('id, organization_id')
        .eq('email', email.toLowerCase())
        .maybeSingle();

      // Get the inviter's details including organization
      const { data: inviter } = await supabase
        .from('member')
        .select('id, first_name, last_name, organization_id')
        .eq('email', inviterEmail.toLowerCase())
        .maybeSingle();

      const organizationId = inviter?.organization_id;
      const inviterFullName = inviter ? `${inviter.first_name || ''} ${inviter.last_name || ''}`.trim() : inviterName || '';

      // Fetch organization details
      let organizationName = '';
      if (organizationId) {
        const { data: org } = await supabase
          .from('organization')
          .select('id, name')
          .eq('id', organizationId)
          .maybeSingle();
        organizationName = org?.name || '';
      }

      // If member doesn't exist, create a pending member record
      if (!existingMember && organizationId) {
        const { error: createError } = await supabase
          .from('member')
          .insert({
            email: email.toLowerCase(),
            organization_id: organizationId,
            login_enabled: false, // Will be enabled when they set password
            first_name: '',
            last_name: ''
          })
          .select()
          .single();

        if (createError) {
          console.error('[sendTeamMemberInvite] Failed to create member:', createError);
          // Continue anyway - the invite can still be sent
        }
      }

      // Build the signup/login link with organization_id parameter
      const signupLink = `${baseUrl}/login?email=${encodeURIComponent(email)}${organizationId ? `&organization_id=${organizationId}` : ''}`;

      // Build the email content
      let finalSubject = emailSubject || `You're invited to join our team`;
      let finalBody = emailBody || `
        <p>Hi,</p>
        <p>${inviterFullName} has invited you to join the team.</p>
        <p>Click the link below to sign up and set up your account:</p>
        <p><a href="{{invite_link}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Accept Invitation</a></p>
      `;

      // Replace {{placeholder}} syntax
      finalBody = finalBody.replace(/\{\{invite_link\}\}/gi, signupLink);
      finalBody = finalBody.replace(/\{\{inviter_name\}\}/gi, inviterFullName);
      finalBody = finalBody.replace(/\{\{invitee_email\}\}/gi, email);
      finalBody = finalBody.replace(/\{\{organization_name\}\}/gi, organizationName);
      finalBody = finalBody.replace(/\{\{organization_id\}\}/gi, organizationId || '');

      // Replace [[placeholder]] syntax (core database values) - support both dot and underscore separators
      finalBody = finalBody.replace(/\[\[member\.full_name\]\]/gi, inviterFullName);
      finalBody = finalBody.replace(/\[\[member_full_name\]\]/gi, inviterFullName);
      finalBody = finalBody.replace(/\[\[member\.first_name\]\]/gi, inviter?.first_name || '');
      finalBody = finalBody.replace(/\[\[member_first_name\]\]/gi, inviter?.first_name || '');
      finalBody = finalBody.replace(/\[\[member\.last_name\]\]/gi, inviter?.last_name || '');
      finalBody = finalBody.replace(/\[\[member_last_name\]\]/gi, inviter?.last_name || '');
      finalBody = finalBody.replace(/\[\[member\.email\]\]/gi, inviterEmail);
      finalBody = finalBody.replace(/\[\[member_email\]\]/gi, inviterEmail);
      finalBody = finalBody.replace(/\[\[organization\.id\]\]/gi, organizationId || '');
      finalBody = finalBody.replace(/\[\[organization_id\]\]/gi, organizationId || '');
      finalBody = finalBody.replace(/\[\[organization\.name\]\]/gi, organizationName);
      finalBody = finalBody.replace(/\[\[organization_name\]\]/gi, organizationName);

      // Also replace in subject
      finalSubject = finalSubject.replace(/\{\{inviter_name\}\}/gi, inviterFullName);
      finalSubject = finalSubject.replace(/\{\{organization_name\}\}/gi, organizationName);
      finalSubject = finalSubject.replace(/\[\[member\.full_name\]\]/gi, inviterFullName);
      finalSubject = finalSubject.replace(/\[\[organization\.name\]\]/gi, organizationName);

      // Send email via Mailgun
      const emailResult = await sendEmail({
        to: email,
        subject: finalSubject,
        html: finalBody
      });

      if (!emailResult.success) {
        console.error('[sendTeamMemberInvite] Email send failed:', emailResult.error);
        return res.status(500).json({
          error: 'Failed to send invitation email: ' + emailResult.error
        });
      }

      console.log(`[sendTeamMemberInvite] Invitation sent to ${email} by ${inviterFullName} (org: ${organizationId})`);

      res.json({
        success: true,
        message: 'Invitation sent successfully'
      });

    } catch (error: any) {
      console.error('[sendTeamMemberInvite] Error:', error);
      res.status(500).json({
        error: error.message
      });
    }
  });

  // Generate Member Handles - generates unique handles for members
  app.post('/api/functions/generateMemberHandles', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    // Helper function to generate slug
    function generateSlug(text: string): string {
      return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }

    // Helper function to generate unique handle
    function generateUniqueHandle(firstName: string, lastName: string, existingHandles: Set<string>): string {
      let baseHandle = `${generateSlug(firstName)}-${generateSlug(lastName)}`;

      if (baseHandle.length < 3) {
        baseHandle = generateSlug(firstName);
      }
      if (baseHandle.length < 3) {
        baseHandle = generateSlug(lastName);
      }
      if (baseHandle.length < 3) {
        baseHandle = 'member';
      }
      if (baseHandle.length > 30) {
        baseHandle = baseHandle.substring(0, 30);
      }

      let handle = baseHandle;
      let counter = 1;

      while (existingHandles.has(handle)) {
        const suffix = `-${counter}`;
        const maxBaseLength = 30 - suffix.length;
        handle = baseHandle.substring(0, maxBaseLength) + suffix;
        counter++;
      }

      return handle;
    }

    try {
      const { member_email, member_id, generate_all = false } = req.body;

      console.log('[generateMemberHandles] Request received:', { member_email, member_id, generate_all });

      if (!member_email) {
        return res.status(401).json({
          error: 'Unauthorized - member_email required',
          details: 'Please provide your email address in the request'
        });
      }

      // Check if requesting member is admin (case-insensitive email comparison)
      const { data: members } = await supabase.from('member').select('*');
      const normalizedEmail = member_email.toLowerCase().trim();
      const currentMember = members?.find((m: any) => m.email?.toLowerCase().trim() === normalizedEmail);
      
      console.log('[generateMemberHandles] Looking for member with email:', normalizedEmail, 'Found:', !!currentMember);

      if (!currentMember) {
        return res.status(403).json({
          error: 'Forbidden - Member record not found',
          details: 'Your user account is not linked to a member record'
        });
      }

      if (!currentMember.role_id) {
        return res.status(403).json({
          error: 'Forbidden - No role assigned',
          details: 'Your account does not have a role assigned'
        });
      }

      const { data: roles } = await supabase.from('role').select('*');
      const currentRole = roles?.find((r: any) => r.id === currentMember.role_id);

      if (!currentRole) {
        return res.status(403).json({
          error: 'Forbidden - Role not found',
          details: 'Your assigned role could not be found'
        });
      }

      // Check if user has access to member handles feature
      const currentExcludedFeatures = currentRole.excluded_features || [];
      const hasMemberHandlesAccess = !currentExcludedFeatures.includes('admin.member-handles');
      
      if (!hasMemberHandlesAccess) {
        return res.status(403).json({
          error: 'Forbidden - Access denied',
          details: 'This operation requires member handles management access'
        });
      }

      console.log('[generateMemberHandles] Access check passed, proceeding with handle generation');

      // Get all members
      const allMembers = members || [];
      console.log('[generateMemberHandles] Total members:', allMembers.length);

      // Get existing handles
      const existingHandles = new Set<string>(
        allMembers
          .filter((m: any) => m.handle)
          .map((m: any) => m.handle)
      );

      console.log('[generateMemberHandles] Existing handles:', existingHandles.size);

      const results: any = {
        success: [],
        failed: [],
        skipped: []
      };

      // Determine which members to process
      let membersToProcess: any[] = [];

      if (member_id) {
        const member = allMembers.find((m: any) => m.id === member_id);
        if (!member) {
          return res.status(404).json({ error: 'Member not found' });
        }
        membersToProcess = [member];
      } else if (generate_all) {
        membersToProcess = allMembers.filter((m: any) => !m.handle);
        console.log('[generateMemberHandles] Members to process:', membersToProcess.length);
      } else {
        return res.status(400).json({
          error: 'Please specify either member_id or set generate_all to true'
        });
      }

      // Process each member
      for (const member of membersToProcess) {
        try {
          if (member.handle) {
            results.skipped.push({
              member_id: member.id,
              email: member.email,
              existing_handle: member.handle,
              reason: 'Already has handle'
            });
            continue;
          }

          if (!member.first_name || !member.last_name) {
            results.failed.push({
              member_id: member.id,
              email: member.email,
              error: 'Missing first_name or last_name'
            });
            continue;
          }

          const handle = generateUniqueHandle(
            member.first_name,
            member.last_name,
            existingHandles
          );

          console.log('[generateMemberHandles] Generated handle for', member.email, ':', handle);

          await supabase
            .from('member')
            .update({ handle })
            .eq('id', member.id);

          existingHandles.add(handle);

          results.success.push({
            member_id: member.id,
            email: member.email,
            name: `${member.first_name} ${member.last_name}`,
            handle: handle
          });

        } catch (error: any) {
          console.error('[generateMemberHandles] Error processing member:', member.email, error);
          results.failed.push({
            member_id: member.id,
            email: member.email,
            error: error.message
          });
        }
      }

      console.log('[generateMemberHandles] Results:', results.success.length, 'success,', results.failed.length, 'failed,', results.skipped.length, 'skipped');

      res.json({
        message: 'Handle generation completed',
        summary: {
          total_processed: membersToProcess.length,
          successful: results.success.length,
          failed: results.failed.length,
          skipped: results.skipped.length
        },
        results
      });

    } catch (error: any) {
      console.error('[generateMemberHandles] Fatal error:', error);
      res.status(500).json({
        error: 'Failed to generate handles',
        details: error.message
      });
    }
  });

  // Rename Resource Subcategory - renames subcategory and updates all resources
  app.post('/api/functions/renameResourceSubcategory', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { categoryId, oldSubcategoryName, newSubcategoryName } = req.body;

      // Validate input
      if (!categoryId || !oldSubcategoryName || !newSubcategoryName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters: categoryId, oldSubcategoryName, newSubcategoryName'
        });
      }

      if (oldSubcategoryName === newSubcategoryName) {
        return res.status(400).json({
          success: false,
          error: 'New subcategory name must be different from the old name'
        });
      }

      // Trim the names
      const oldName = oldSubcategoryName.trim();
      const newName = newSubcategoryName.trim();

      if (!newName) {
        return res.status(400).json({
          success: false,
          error: 'New subcategory name cannot be empty'
        });
      }

      // 1. Get the category
      const { data: categories } = await supabase.from('resource_category').select('*');
      const category = categories?.find((c: any) => c.id === categoryId);

      if (!category) {
        return res.status(404).json({
          success: false,
          error: 'Category not found'
        });
      }

      // 2. Check if old subcategory exists in the category
      if (!category.subcategories || !category.subcategories.includes(oldName)) {
        return res.status(404).json({
          success: false,
          error: 'Old subcategory name not found in category'
        });
      }

      // 3. Check if new subcategory name already exists (case-insensitive)
      const subcategoriesLowerCase = category.subcategories.map((s: string) => s.toLowerCase());
      if (subcategoriesLowerCase.includes(newName.toLowerCase()) && oldName.toLowerCase() !== newName.toLowerCase()) {
        return res.status(400).json({
          success: false,
          error: 'A subcategory with this name already exists in the category'
        });
      }

      // 4. Update the ResourceCategory entity
      const updatedSubcategories = category.subcategories.map((sub: string) =>
        sub === oldName ? newName : sub
      );

      // Sort alphabetically
      updatedSubcategories.sort((a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      await supabase
        .from('resource_category')
        .update({ subcategories: updatedSubcategories })
        .eq('id', categoryId);

      // 5. Find and update all Resource entities with the old subcategory name
      const { data: allResources } = await supabase.from('resource').select('*');
      const resourcesToUpdate = allResources?.filter((resource: any) =>
        resource.subcategories && resource.subcategories.includes(oldName)
      ) || [];

      console.log(`Found ${resourcesToUpdate.length} resources to update`);

      // Update each resource
      const updatePromises = resourcesToUpdate.map((resource: any) => {
        const updatedResourceSubcategories = resource.subcategories.map((sub: string) =>
          sub === oldName ? newName : sub
        );

        return supabase
          .from('resource')
          .update({ subcategories: updatedResourceSubcategories })
          .eq('id', resource.id);
      });

      await Promise.all(updatePromises);

      console.log(`Successfully renamed subcategory from "${oldName}" to "${newName}" in category "${category.name}"`);
      console.log(`Updated ${resourcesToUpdate.length} resource(s)`);

      res.json({
        success: true,
        message: `Successfully renamed subcategory and updated ${resourcesToUpdate.length} resource(s)`,
        resourcesUpdated: resourcesToUpdate.length
      });

    } catch (error: any) {
      console.error('Error renaming subcategory:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Create Job Posting Payment Intent - creates Stripe payment intent for job postings
  app.post('/api/functions/createJobPostingPaymentIntent', async (req: Request, res: Response) => {
    try {
      const { amount, currency = 'gbp', metadata = {} } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({
          error: 'Invalid amount',
          details: 'Amount must be greater than 0'
        });
      }

      // Validate that we have job posting metadata
      if (!metadata.job_posting_id) {
        return res.status(400).json({
          error: 'Job posting ID is required'
        });
      }

      // Get Stripe key from environment
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeSecretKey) {
        throw new Error('Stripe secret key not configured');
      }

      const stripe = new Stripe(stripeSecretKey, {
        apiVersion: '2023-10-16' as any,
      });

      // Create a Payment Intent with Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Stripe expects amount in pence/cents
        currency: currency,
        metadata: {
          ...metadata,
          type: 'job_posting'
        },
        automatic_payment_methods: {
          enabled: true,
        },
      });

      res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });

    } catch (error: any) {
      console.error('Stripe Payment Intent Error:', error);
      res.status(500).json({
        error: 'Failed to create payment intent',
        details: error.message
      });
    }
  });

  // Handle Job Posting Payment Webhook - Stripe webhook for job posting payments
  app.post('/api/functions/handleJobPostingPaymentWebhook', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
      const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!stripeSecretKey) {
        throw new Error('Stripe secret key not configured');
      }

      const stripe = new Stripe(stripeSecretKey, {
        apiVersion: '2023-10-16' as any,
      });

      const sig = req.headers['stripe-signature'] as string;
      const body = req.body;

      let event;
      try {
        // Verify webhook signature if secret is configured
        if (stripeWebhookSecret) {
          event = stripe.webhooks.constructEvent(body, sig, stripeWebhookSecret);
        } else {
          // If no webhook secret, parse the body directly (less secure, for development)
          event = typeof body === 'string' ? JSON.parse(body) : body;
        }
      } catch (err: any) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: 'Webhook signature verification failed' });
      }

      // Handle payment_intent.succeeded event (for PaymentElement/Payment Intents API)
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const jobPostingId = paymentIntent.metadata?.job_posting_id;

        // Only process if this is a job posting payment
        if (jobPostingId && paymentIntent.metadata?.type === 'job_posting') {
          // Update job posting status
          await supabase
            .from('job_posting')
            .update({
              status: 'pending_approval',
              payment_status: 'paid',
              stripe_payment_intent_id: paymentIntent.id
            })
            .eq('id', jobPostingId);

          // Get job posting details
          const { data: jobPostings } = await supabase.from('job_posting').select('*');
          const jobPosting = jobPostings?.find((j: any) => j.id === jobPostingId);

          if (jobPosting) {
            // Send confirmation email to poster via Mailgun
            const mailgunApiKey = process.env.MAILGUN_API_KEY;
            const mailgunDomain = process.env.MAILGUN_DOMAIN;
            const mailgunFromEmail = process.env.MAILGUN_FROM_EMAIL;

            if (mailgunApiKey && mailgunDomain) {
              const FormData = require('form-data');
              const Mailgun = require('mailgun.js');
              const mailgun = new Mailgun(FormData);
              const mg = mailgun.client({
                username: 'api',
                key: mailgunApiKey
              });

              // Send to poster
              await mg.messages.create(mailgunDomain, {
                from: mailgunFromEmail,
                to: jobPosting.contact_email,
                subject: 'Job Posting Payment Confirmed - Pending Approval',
                html: `
                  <h2>Payment Confirmed!</h2>
                  <p>Dear ${jobPosting.contact_name},</p>
                  <p>Your payment of £${jobPosting.amount_paid} for the job posting <strong>${jobPosting.title}</strong> at <strong>${jobPosting.company_name}</strong> has been received successfully.</p>
                  <p>Your job posting is now pending approval from our team. You'll receive another email once it's approved and live on the job board.</p>
                  <p><strong>Job Details:</strong></p>
                  <ul>
                    <li>Title: ${jobPosting.title}</li>
                    <li>Company: ${jobPosting.company_name}</li>
                    <li>Location: ${jobPosting.location}</li>
                    <li>Type: ${jobPosting.job_type}</li>
                  </ul>
                  <p>Best regards,<br>AGCAS Team</p>
                `
              });

              // Notify users with job posting management access
              const { data: allRoles } = await supabase
                .from('role')
                .select('*');

              // Filter to roles that have job posting management access
              const jobManagementRoles = allRoles?.filter((r: any) => {
                const excludedFeatures = r.excluded_features || [];
                return !excludedFeatures.includes('admin.job-postings');
              }) || [];

              if (jobManagementRoles.length > 0) {
                const roleIds = jobManagementRoles.map((r: any) => r.id);
                const { data: allMembers } = await supabase.from('member').select('*');
                const notifyMembers = allMembers?.filter((m: any) => roleIds.includes(m.role_id)) || [];

                for (const member of notifyMembers) {
                  await mg.messages.create(mailgunDomain, {
                    from: mailgunFromEmail,
                    to: member.email,
                    subject: 'New Paid Job Posting Awaiting Approval',
                    html: `
                      <h2>New Paid Job Posting Submitted</h2>
                      <p>A non-member has paid and submitted a new job posting that requires approval:</p>
                      <p><strong>Job Details:</strong></p>
                      <ul>
                        <li>Title: ${jobPosting.title}</li>
                        <li>Company: ${jobPosting.company_name}</li>
                        <li>Location: ${jobPosting.location}</li>
                        <li>Posted by: ${jobPosting.contact_name} (${jobPosting.contact_email})</li>
                        <li>Amount Paid: £${jobPosting.amount_paid}</li>
                      </ul>
                      <p>Please log in to the admin portal to review and approve this posting.</p>
                    `
                  });
                }
              }
            } else {
              console.warn('[handleJobPostingPaymentWebhook] Mailgun not configured, skipping emails');
            }
          }
        }
      }

      res.json({ received: true });

    } catch (error: any) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Set Public Home Page - upserts the public home page setting
  app.post('/api/functions/setPublicHomePage', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { slug } = req.body;
      const settingKey = 'public_home_page_slug';
      
      console.log(`[setPublicHomePage] Setting home page to: ${slug || '(none)'}`);

      // First try to find existing setting
      const { data: existingSettings, error: fetchError } = await supabase
        .from('system_settings')
        .select('*')
        .eq('setting_key', settingKey);

      if (fetchError) {
        console.error('[setPublicHomePage] Error fetching settings:', fetchError);
        return res.status(500).json({ error: fetchError.message });
      }

      const existingSetting = existingSettings?.[0];

      if (existingSetting) {
        // Update existing setting
        const { data, error } = await supabase
          .from('system_settings')
          .update({ setting_value: slug || '' })
          .eq('id', existingSetting.id)
          .select()
          .single();

        if (error) {
          console.error('[setPublicHomePage] Error updating setting:', error);
          return res.status(500).json({ error: error.message });
        }

        console.log('[setPublicHomePage] Updated existing setting:', data);
        return res.json({ success: true, data });
      } else {
        // Create new setting
        const { data, error } = await supabase
          .from('system_settings')
          .insert({
            setting_key: settingKey,
            setting_value: slug || ''
          })
          .select()
          .single();

        if (error) {
          console.error('[setPublicHomePage] Error creating setting:', error);
          return res.status(500).json({ error: error.message });
        }

        console.log('[setPublicHomePage] Created new setting:', data);
        return res.json({ success: true, data });
      }
    } catch (error: any) {
      console.error('[setPublicHomePage] Unexpected error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create Job Posting Non-Member - creates paid job posting with Stripe checkout
  app.post('/api/functions/createJobPostingNonMember', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const jobData = req.body;

      // Get pricing from system settings
      const { data: settings } = await supabase
        .from('system_settings')
        .select('*')
        .eq('setting_key', 'job_posting_price');

      let price = 50; // Default price in GBP
      if (settings && settings.length > 0) {
        price = parseFloat(settings[0].setting_value);
      }

      // Calculate expiry date (90 days from now)
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 90);

      // Create job posting with pending_payment status
      const { data: jobPosting, error: createError } = await supabase
        .from('job_posting')
        .insert({
          title: jobData.title,
          description: jobData.description,
          company_name: jobData.company_name,
          company_logo_url: jobData.company_logo_url || '',
          location: jobData.location,
          salary_range: jobData.salary_range || '',
          job_type: jobData.job_type,
          hours: jobData.hours || null,
          closing_date: jobData.closing_date,
          application_method: jobData.application_method,
          application_value: jobData.application_value,
          contact_email: jobData.contact_email,
          contact_name: jobData.contact_name,
          is_member_post: false,
          status: 'pending_payment',
          payment_status: 'pending',
          expiry_date: expiryDate.toISOString(),
          amount_paid: price,
          attachment_urls: jobData.attachment_urls || [],
          attachment_names: jobData.attachment_names || []
        })
        .select()
        .single();

      if (createError) {
        throw createError;
      }

      // Initialize Stripe with secret key from environment
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeSecretKey) {
        throw new Error('Stripe secret key not configured');
      }

      const stripe = new Stripe(stripeSecretKey, {
        apiVersion: '2023-10-16' as any,
      });

      // Get origin from request headers
      const origin = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || '';

      // Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'gbp',
              product_data: {
                name: 'Job Posting',
                description: `${jobData.title} at ${jobData.company_name}`,
              },
              unit_amount: Math.round(price * 100), // Convert to pence
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${origin}/JobPostSuccess?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/PostJob?cancelled=true`,
        customer_email: jobData.contact_email,
        metadata: {
          job_posting_id: jobPosting.id,
          contact_email: jobData.contact_email,
          contact_name: jobData.contact_name
        }
      });

      // Update job posting with session ID
      await supabase
        .from('job_posting')
        .update({ stripe_checkout_session_id: session.id })
        .eq('id', jobPosting.id);

      res.json({
        success: true,
        checkout_url: session.url,
        job_id: jobPosting.id
      });

    } catch (error: any) {
      console.error('Error creating non-member job posting:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create Job Posting Member - creates job posting for authenticated members
  app.post('/api/functions/createJobPostingMember', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { memberEmail, ...postingData } = req.body;

      console.log('[createJobPostingMember] Creating job posting');
      console.log('[createJobPostingMember] Session memberId:', req.session.memberId);
      console.log('[createJobPostingMember] Provided email:', memberEmail);

      let member = null;

      // FIRST: Try to get member from session (portal users - most reliable)
      if (req.session.memberId) {
        console.log('[createJobPostingMember] Looking up member by session ID:', req.session.memberId);
        const { data: sessionMember, error: sessionError } = await supabase
          .from('member')
          .select('*')
          .eq('id', req.session.memberId)
          .single();
        
        if (sessionMember && !sessionError) {
          member = sessionMember;
          console.log('[createJobPostingMember] Found member via session:', member.id, member.email);
        } else {
          console.warn('[createJobPostingMember] Session member lookup failed:', sessionError?.message);
        }
      }

      // FALLBACK: Try email lookup if no session (public mode or session issue)
      if (!member && memberEmail) {
        const normalizedEmail = memberEmail.toLowerCase().trim();
        console.log('[createJobPostingMember] Falling back to email lookup:', normalizedEmail);
        
        const { data: emailMembers, error: emailError } = await supabase
          .from('member')
          .select('*')
          .eq('email', normalizedEmail);
        
        if (emailMembers && emailMembers.length > 0) {
          member = emailMembers[0];
          console.log('[createJobPostingMember] Found member via email:', member.id, member.email);
        } else {
          console.warn('[createJobPostingMember] Email lookup failed for:', normalizedEmail, emailError?.message);
        }
      }

      // If still no member found, return error
      if (!member) {
        console.error('[createJobPostingMember] Member not found via session or email');
        console.error('[createJobPostingMember] Session ID:', req.session.memberId);
        console.error('[createJobPostingMember] Email:', memberEmail);
        return res.status(404).json({
          success: false,
          error: 'Member not found. Please log in again.',
          debug: {
            hasSession: !!req.session.memberId,
            emailProvided: !!memberEmail
          }
        });
      }

      console.log('[createJobPostingMember] Found member:', member.id, 'organization_id:', member.organization_id);

      // Get organization information - query directly by ID
      let organizationName = null;
      if (member.organization_id) {
        const { data: org, error: orgError } = await supabase
          .from('organization')
          .select('name')
          .eq('id', member.organization_id)
          .single();
        
        if (org && !orgError) {
          organizationName = org.name;
          console.log('[createJobPostingMember] Found organization:', organizationName);
        } else {
          console.warn('[createJobPostingMember] Organization not found for ID:', member.organization_id);
        }
      } else {
        console.log('[createJobPostingMember] Member has no organization_id');
      }

      // Create the job posting
      const { data: jobPosting, error: createError } = await supabase
        .from('job_posting')
        .insert({
          title: postingData.title,
          description: postingData.description,
          company_name: postingData.company_name,
          company_logo_url: postingData.company_logo_url || null,
          location: postingData.location,
          salary_range: postingData.salary_range || null,
          job_type: postingData.job_type || null,
          hours: postingData.hours || null,
          closing_date: postingData.closing_date,
          application_method: postingData.application_method,
          application_value: postingData.application_value,
          contact_email: memberEmail,
          contact_name: postingData.contact_name,
          posted_by_member_id: member.id,
          posted_by_organization_id: member.organization_id || null,
          posted_by_organization_name: organizationName,
          is_member_post: true,
          status: 'pending_approval',
          payment_status: 'N/A',
          attachment_urls: postingData.attachment_urls || [],
          attachment_names: postingData.attachment_names || []
        })
        .select()
        .single();

      if (createError) {
        throw createError;
      }

      console.log('[createJobPostingMember] Job posting created successfully:', jobPosting.id);

      res.json({
        success: true,
        job_id: jobPosting.id
      });

    } catch (error: any) {
      console.error('[createJobPostingMember] Error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to create job posting'
      });
    }
  });

  // Check Member Status By Email - checks if an email belongs to a member and if they have job posting access
  app.post('/api/functions/checkMemberStatusByEmail', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { email } = req.body;

      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Email is required' });
      }

      console.log('[checkMemberStatusByEmail] Checking email:', email);

      // Check if email belongs to a member
      const { data: members, error: memberError } = await supabase
        .from('member')
        .select('*')
        .ilike('email', email.toLowerCase().trim());

      if (memberError) {
        console.error('[checkMemberStatusByEmail] Database error:', memberError);
        return res.status(500).json({ error: memberError.message });
      }

      console.log('[checkMemberStatusByEmail] Found members:', members?.length || 0);

      if (members && members.length > 0) {
        const member = members[0];
        
        // Check if member has job posting access based on their role
        let has_job_posting_access = true; // Default to true if no role restrictions
        
        if (member.role_id) {
          const { data: allRoles } = await supabase.from('role').select('*');
          const memberRole = allRoles?.find((r: any) => r.id === member.role_id);
          
          if (memberRole && memberRole.excluded_features) {
            // Check if page_PostJob is in excluded features
            const excludedFeatures = Array.isArray(memberRole.excluded_features) 
              ? memberRole.excluded_features 
              : [];
            has_job_posting_access = !excludedFeatures.includes('page_PostJob');
          }
        }
        
        console.log('[checkMemberStatusByEmail] Member found:', member.email, 'has_job_posting_access:', has_job_posting_access);
        
        return res.json({
          is_member: true,
          has_job_posting_access,
          member_id: member.id,
          organization_id: member.organization_id,
          first_name: member.first_name,
          last_name: member.last_name,
          full_name: `${member.first_name || ''} ${member.last_name || ''}`.trim()
        });
      }

      console.log('[checkMemberStatusByEmail] No member found for email:', email);
      
      res.json({
        is_member: false,
        has_job_posting_access: false
      });

    } catch (error: any) {
      console.error('Error checking member status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reinstate Program Ticket Transaction - admin reinstatement of cancelled tickets
  app.post('/api/functions/reinstateProgramTicketTransaction', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { transactionId, adminEmail } = req.body;

      console.log('[reinstateProgramTicketTransaction] ========================================');
      console.log('[reinstateProgramTicketTransaction] Reinstatement request received');
      console.log('[reinstateProgramTicketTransaction] Transaction ID:', transactionId);
      console.log('[reinstateProgramTicketTransaction] Admin Email:', adminEmail);

      // Validate inputs
      if (!transactionId || !adminEmail) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters',
          required: ['transactionId', 'adminEmail']
        });
      }

      // Verify admin privileges
      const { data: allMembers } = await supabase.from('member').select('*');
      const adminMember = allMembers?.find((m: any) => m.email === adminEmail);

      if (!adminMember || !adminMember.role_id) {
        return res.status(403).json({
          success: false,
          error: 'Admin user not found or has no role assigned'
        });
      }

      const { data: allRoles } = await supabase.from('role').select('*');
      const adminRole = allRoles?.find((r: any) => r.id === adminMember.role_id);

      // Check if user has access to program ticket management
      const roleExcludedFeatures = adminRole?.excluded_features || [];
      const hasProgramTicketAccess = adminRole && !roleExcludedFeatures.includes('admin.program-tickets');
      
      if (!hasProgramTicketAccess) {
        return res.status(403).json({
          success: false,
          error: 'User does not have program ticket management access'
        });
      }

      console.log('[reinstateProgramTicketTransaction] Access authorization verified');

      // Fetch the transaction
      const { data: allTransactions } = await supabase.from('program_ticket_transaction').select('*');
      const transaction = allTransactions?.find((t: any) => t.id === transactionId);

      if (!transaction) {
        return res.status(404).json({
          success: false,
          error: 'Transaction not found'
        });
      }

      console.log('[reinstateProgramTicketTransaction] Transaction found:', {
        type: transaction.transaction_type,
        program: transaction.program_name,
        original_quantity: transaction.original_quantity || transaction.quantity,
        cancelled_quantity: transaction.cancelled_quantity || 0,
        status: transaction.status
      });

      // Validate transaction type
      if (transaction.transaction_type !== 'purchase') {
        return res.status(400).json({
          success: false,
          error: 'Only purchase transactions can be reinstated',
          transaction_type: transaction.transaction_type
        });
      }

      // Get the quantity to reinstate
      const quantityToReinstate = transaction.cancelled_quantity || 0;

      if (quantityToReinstate <= 0) {
        return res.status(400).json({
          success: false,
          error: 'No cancelled tickets to reinstate',
          cancelled_quantity: quantityToReinstate
        });
      }

      console.log('[reinstateProgramTicketTransaction] Quantity to reinstate:', quantityToReinstate);

      // Fetch the organization
      const { data: allOrganizations } = await supabase.from('organization').select('*');
      const organization = allOrganizations?.find((o: any) => o.id === transaction.organization_id);

      if (!organization) {
        return res.status(404).json({
          success: false,
          error: 'Organization not found'
        });
      }

      // All validations passed - proceed with reinstatement
      console.log('[reinstateProgramTicketTransaction] All validations passed. Proceeding with reinstatement...');

      // Update the transaction record back to active
      await supabase
        .from('program_ticket_transaction')
        .update({
          cancelled_quantity: 0,
          status: 'active',
          cancelled_by_member_email: null,
          cancelled_at: null
        })
        .eq('id', transactionId);

      console.log('[reinstateProgramTicketTransaction] Transaction record updated back to active');

      // Update organization's balance - add the tickets back
      const currentOrgBalance = (organization.program_ticket_balances || {})[transaction.program_name] || 0;
      const updatedProgramBalances = {
        ...organization.program_ticket_balances,
        [transaction.program_name]: currentOrgBalance + quantityToReinstate
      };

      await supabase
        .from('organization')
        .update({
          program_ticket_balances: updatedProgramBalances,
          last_synced: new Date().toISOString()
        })
        .eq('id', organization.id);

      console.log('[reinstateProgramTicketTransaction] Organization balance updated - tickets reinstated');

      // Create audit trail transaction with type 'reinstatement'
      await supabase
        .from('program_ticket_transaction')
        .insert({
          organization_id: transaction.organization_id,
          program_name: transaction.program_name,
          transaction_type: 'reinstatement',
          quantity: quantityToReinstate,
          member_email: adminEmail,
          original_transaction_id: transactionId,
          notes: `Admin reinstatement: ${quantityToReinstate} ticket(s) reinstated after cancellation reversal. Original PO: ${transaction.purchase_order_number || 'N/A'}. Reinstated by: ${adminEmail}.`
        });

      console.log('[reinstateProgramTicketTransaction] Audit trail created');
      console.log('[reinstateProgramTicketTransaction] REINSTATEMENT SUCCESSFUL');

      res.json({
        success: true,
        message: `Successfully reinstated ${quantityToReinstate} ticket(s)`,
        transaction_id: transactionId,
        quantity_reinstated: quantityToReinstate,
        new_organization_balance: updatedProgramBalances[transaction.program_name]
      });

    } catch (error: any) {
      console.error('[reinstateProgramTicketTransaction] Fatal error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reinstate transaction',
        details: error.message
      });
    }
  });

  // Cancel Program Ticket Transaction - admin cancellation of specific quantities
  app.post('/api/functions/cancelProgramTicketTransaction', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { transactionId, quantityToCancel, adminEmail } = req.body;

      console.log('[cancelProgramTicketTransaction] ========================================');
      console.log('[cancelProgramTicketTransaction] Cancellation request received');
      console.log('[cancelProgramTicketTransaction] Transaction ID:', transactionId);
      console.log('[cancelProgramTicketTransaction] Quantity to Cancel:', quantityToCancel);
      console.log('[cancelProgramTicketTransaction] Admin Email:', adminEmail);

      // Validate inputs
      if (!transactionId || !quantityToCancel || !adminEmail) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters',
          required: ['transactionId', 'quantityToCancel', 'adminEmail']
        });
      }

      if (quantityToCancel <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Quantity to cancel must be greater than 0'
        });
      }

      // Verify admin privileges
      const { data: allMembers } = await supabase.from('member').select('*');
      const adminMember = allMembers?.find((m: any) => m.email === adminEmail);

      if (!adminMember || !adminMember.role_id) {
        return res.status(403).json({
          success: false,
          error: 'Admin user not found or has no role assigned'
        });
      }

      const { data: allRoles } = await supabase.from('role').select('*');
      const adminRole = allRoles?.find((r: any) => r.id === adminMember.role_id);

      // Check if user has access to program ticket management
      const cancelRoleExcludedFeatures = adminRole?.excluded_features || [];
      const hasCancelProgramTicketAccess = adminRole && !cancelRoleExcludedFeatures.includes('admin.program-tickets');
      
      if (!hasCancelProgramTicketAccess) {
        return res.status(403).json({
          success: false,
          error: 'User does not have program ticket management access'
        });
      }

      console.log('[cancelProgramTicketTransaction] Access authorization verified');

      // Fetch the original transaction
      const { data: allTransactions } = await supabase.from('program_ticket_transaction').select('*');
      const transaction = allTransactions?.find((t: any) => t.id === transactionId);

      if (!transaction) {
        return res.status(404).json({
          success: false,
          error: 'Transaction not found'
        });
      }

      console.log('[cancelProgramTicketTransaction] Transaction found:', {
        type: transaction.transaction_type,
        program: transaction.program_name,
        original_quantity: transaction.original_quantity || transaction.quantity,
        cancelled_quantity: transaction.cancelled_quantity || 0,
        status: transaction.status
      });

      // Validate transaction type
      if (transaction.transaction_type !== 'purchase') {
        return res.status(400).json({
          success: false,
          error: 'Only purchase transactions can be cancelled',
          transaction_type: transaction.transaction_type
        });
      }

      // Validate transaction status
      if (transaction.status === 'cancelled') {
        return res.status(400).json({
          success: false,
          error: 'This transaction has already been fully cancelled'
        });
      }

      // Calculate available quantity to cancel
      const originalQuantity = transaction.original_quantity || transaction.quantity;
      const alreadyCancelled = transaction.cancelled_quantity || 0;
      const availableToCancelFromThisPurchase = originalQuantity - alreadyCancelled;

      console.log('[cancelProgramTicketTransaction] Cancellation capacity:', {
        originalQuantity,
        alreadyCancelled,
        availableToCancelFromThisPurchase,
        requestedToCancel: quantityToCancel
      });

      if (quantityToCancel > availableToCancelFromThisPurchase) {
        return res.status(400).json({
          success: false,
          error: `Cannot cancel ${quantityToCancel} tickets. Only ${availableToCancelFromThisPurchase} ticket(s) available to cancel from this purchase.`,
          available_to_cancel: availableToCancelFromThisPurchase
        });
      }

      // Fetch the organization
      const { data: allOrganizations } = await supabase.from('organization').select('*');
      const organization = allOrganizations?.find((o: any) => o.id === transaction.organization_id);

      if (!organization) {
        return res.status(404).json({
          success: false,
          error: 'Organization not found'
        });
      }

      // CRITICAL RULE: Check if tickets have been allocated (used)
      const currentOrgBalance = (organization.program_ticket_balances || {})[transaction.program_name] || 0;

      console.log('[cancelProgramTicketTransaction] Allocation check:', {
        currentOrgBalance,
        quantityToCancel,
        canCancel: currentOrgBalance >= quantityToCancel
      });

      if (currentOrgBalance < quantityToCancel) {
        return res.status(400).json({
          success: false,
          error: `Cannot cancel ${quantityToCancel} ticket(s). Only ${currentOrgBalance} unallocated ticket(s) remain in the organization's balance. The remaining ${quantityToCancel - currentOrgBalance} ticket(s) have been allocated/used and cannot be cancelled through this system.`,
          current_balance: currentOrgBalance,
          requested_to_cancel: quantityToCancel,
          unallocated_tickets: currentOrgBalance
        });
      }

      // All validations passed - proceed with cancellation
      console.log('[cancelProgramTicketTransaction] All validations passed. Proceeding with cancellation...');

      // Update the original transaction record
      const newCancelledQuantity = alreadyCancelled + quantityToCancel;
      const isFullyCancelled = newCancelledQuantity >= originalQuantity;

      const transactionUpdates: any = {
        cancelled_quantity: newCancelledQuantity,
        status: isFullyCancelled ? 'cancelled' : 'active',
        cancelled_by_member_email: adminEmail,
        cancelled_at: new Date().toISOString()
      };

      // If this is the first cancellation, also set original_quantity
      if (!transaction.original_quantity) {
        transactionUpdates.original_quantity = transaction.quantity;
      }

      await supabase
        .from('program_ticket_transaction')
        .update(transactionUpdates)
        .eq('id', transactionId);

      console.log('[cancelProgramTicketTransaction] Transaction record updated');

      // Update organization's balance
      const updatedProgramBalances = {
        ...organization.program_ticket_balances,
        [transaction.program_name]: currentOrgBalance - quantityToCancel
      };

      await supabase
        .from('organization')
        .update({
          program_ticket_balances: updatedProgramBalances,
          last_synced: new Date().toISOString()
        })
        .eq('id', organization.id);

      console.log('[cancelProgramTicketTransaction] Organization balance updated');

      // Create audit trail transaction
      await supabase
        .from('program_ticket_transaction')
        .insert({
          organization_id: transaction.organization_id,
          program_name: transaction.program_name,
          transaction_type: 'cancellation_void',
          quantity: quantityToCancel,
          member_email: adminEmail,
          original_transaction_id: transactionId,
          notes: `Admin cancellation: ${quantityToCancel} ticket(s) voided from purchase transaction. Original PO: ${transaction.purchase_order_number || 'N/A'}. Reason: Administrative correction.`
        });

      console.log('[cancelProgramTicketTransaction] Audit trail created');
      console.log('[cancelProgramTicketTransaction] CANCELLATION SUCCESSFUL');

      res.json({
        success: true,
        message: `Successfully cancelled ${quantityToCancel} ticket(s)`,
        transaction_id: transactionId,
        quantity_cancelled: quantityToCancel,
        total_cancelled_from_transaction: newCancelledQuantity,
        transaction_status: isFullyCancelled ? 'fully_cancelled' : 'partially_cancelled',
        remaining_in_transaction: originalQuantity - newCancelledQuantity,
        new_organization_balance: updatedProgramBalances[transaction.program_name]
      });

    } catch (error: any) {
      console.error('[cancelProgramTicketTransaction] Fatal error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to cancel transaction',
        details: error.message
      });
    }
  });

  // Clear Program Ticket Transactions - deletes ALL transaction records (admin/test utility)
  app.post('/api/functions/clearProgramTicketTransactions', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      console.log('[clearProgramTicketTransactions] ========================================');
      console.log('[clearProgramTicketTransactions] CLEAR PROGRAM TICKET TRANSACTIONS CALLED');
      console.log('[clearProgramTicketTransactions] ========================================');
      console.log('[clearProgramTicketTransactions] WARNING: This will delete ALL transaction records');

      // Fetch all transactions
      console.log('[clearProgramTicketTransactions] Fetching all transactions...');
      const { data: allTransactions, error: fetchError } = await supabase
        .from('program_ticket_transaction')
        .select('*');

      if (fetchError) {
        throw fetchError;
      }

      console.log(`[clearProgramTicketTransactions] Found ${allTransactions?.length || 0} transaction(s) to delete`);

      if (!allTransactions || allTransactions.length === 0) {
        console.log('[clearProgramTicketTransactions] No transactions to delete');
        return res.json({
          success: true,
          deleted_count: 0,
          message: 'No program ticket transactions found to delete'
        });
      }

      // Delete each transaction
      let deletedCount = 0;
      let errorCount = 0;
      const errors: any[] = [];

      for (const transaction of allTransactions) {
        try {
          const { error: deleteError } = await supabase
            .from('program_ticket_transaction')
            .delete()
            .eq('id', transaction.id);

          if (deleteError) throw deleteError;

          deletedCount++;
          console.log(`[clearProgramTicketTransactions] Deleted transaction ${transaction.id} (${transaction.transaction_type} - ${transaction.program_name})`);

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error: any) {
          errorCount++;
          console.error(`[clearProgramTicketTransactions] Failed to delete transaction ${transaction.id}:`, error.message);
          errors.push({
            transaction_id: transaction.id,
            program_name: transaction.program_name,
            transaction_type: transaction.transaction_type,
            error: error.message
          });
        }
      }

      console.log('[clearProgramTicketTransactions] ========================================');
      console.log(`[clearProgramTicketTransactions] DELETION COMPLETE`);
      console.log(`[clearProgramTicketTransactions] Successfully deleted: ${deletedCount}`);
      console.log(`[clearProgramTicketTransactions] Failed: ${errorCount}`);
      console.log('[clearProgramTicketTransactions] ========================================');

      res.json({
        success: true,
        deleted_count: deletedCount,
        error_count: errorCount,
        total_processed: allTransactions.length,
        errors: errors.length > 0 ? errors : undefined,
        message: `Successfully deleted ${deletedCount} transaction(s)${errorCount > 0 ? `. ${errorCount} deletion(s) failed.` : ''}`
      });

    } catch (error: any) {
      console.error('[clearProgramTicketTransactions] Fatal error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to clear program ticket transactions',
        details: error.message
      });
    }
  });

  // Clear Bookings - deletes ALL booking records (admin/test utility)
  app.post('/api/functions/clearBookings', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      console.log('[clearBookings] ========================================');
      console.log('[clearBookings] CLEAR BOOKINGS FUNCTION CALLED');
      console.log('[clearBookings] ========================================');
      console.log('[clearBookings] WARNING: This will delete ALL booking records');

      // Fetch all bookings
      console.log('[clearBookings] Fetching all bookings...');
      const { data: allBookings, error: fetchError } = await supabase
        .from('booking')
        .select('*');

      if (fetchError) {
        throw fetchError;
      }

      console.log(`[clearBookings] Found ${allBookings?.length || 0} booking(s) to delete`);

      if (!allBookings || allBookings.length === 0) {
        console.log('[clearBookings] No bookings to delete');
        return res.json({
          success: true,
          deleted_count: 0,
          message: 'No bookings found to delete'
        });
      }

      // Delete each booking
      let deletedCount = 0;
      let errorCount = 0;
      const errors: any[] = [];

      for (const booking of allBookings) {
        try {
          const { error: deleteError } = await supabase
            .from('booking')
            .delete()
            .eq('id', booking.id);

          if (deleteError) throw deleteError;

          deletedCount++;
          console.log(`[clearBookings] Deleted booking ${booking.id} (${booking.booking_reference || 'no ref'})`);

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error: any) {
          errorCount++;
          console.error(`[clearBookings] Failed to delete booking ${booking.id}:`, error.message);
          errors.push({
            booking_id: booking.id,
            booking_reference: booking.booking_reference,
            error: error.message
          });
        }
      }

      console.log('[clearBookings] ========================================');
      console.log(`[clearBookings] DELETION COMPLETE`);
      console.log(`[clearBookings] Successfully deleted: ${deletedCount}`);
      console.log(`[clearBookings] Failed: ${errorCount}`);
      console.log('[clearBookings] ========================================');

      res.json({
        success: true,
        deleted_count: deletedCount,
        error_count: errorCount,
        total_processed: allBookings.length,
        errors: errors.length > 0 ? errors : undefined,
        message: `Successfully deleted ${deletedCount} booking(s)${errorCount > 0 ? `. ${errorCount} deletion(s) failed.` : ''}`
      });

    } catch (error: any) {
      console.error('[clearBookings] Fatal error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to clear bookings',
        details: error.message
      });
    }
  });

  // Update Program Details - admin only, handles image, description, and offer configurations
  app.post('/api/functions/updateProgramDetails', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const {
        programId,
        imageBase64,
        fileName,
        userEmail,
        description,
        offerType,
        bogoBuyQuantity,
        bogoGetFreeQuantity,
        bogoLogicType,
        bulkDiscountThreshold,
        bulkDiscountPercentage
      } = req.body;

      if (!programId) {
        return res.status(400).json({ error: 'Program ID is required' });
      }

      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }

      console.log('[updateProgramDetails] Processing request for user:', userEmail);

      const { data: allMembers } = await supabase
        .from('member')
        .select('*');

      const member = allMembers?.find((m: any) => m.email === userEmail);

      let hasAccess = false;
      
      if (member && member.role_id) {
        const { data: allRoles } = await supabase
          .from('role')
          .select('*');

        const role = allRoles?.find((r: any) => r.id === member.role_id);
        // Check if user has access to program management feature
        const excludedFeatures = role?.excluded_features || [];
        hasAccess = role && !excludedFeatures.includes('admin.programs');
      }

      if (!hasAccess) {
        const { data: allTeamMembers } = await supabase
          .from('team_member')
          .select('*');

        const teamMember = allTeamMembers?.find((tm: any) => tm.email === userEmail);

        if (teamMember && teamMember.role_id) {
          const { data: allRoles } = await supabase
            .from('role')
            .select('*');

          const role = allRoles?.find((r: any) => r.id === teamMember.role_id);
          // Check if user has access to program management feature
          const excludedFeatures = role?.excluded_features || [];
          hasAccess = role && !excludedFeatures.includes('admin.programs');
        }
      }

      if (!hasAccess) {
        console.log('[updateProgramDetails] User does not have access:', userEmail);
        return res.status(403).json({ error: 'Program management access required' });
      }

      console.log('[updateProgramDetails] User access verified, proceeding with update');

      const updatePayload: any = {};

      // Handle image upload if provided
      if (imageBase64) {
        const base64Data = imageBase64.split(',')[1];
        const mimeType = imageBase64.split(';')[0].split(':')[1];
        const buffer = Buffer.from(base64Data, 'base64');

        const uploadFileName = `programs/${programId}/${fileName || 'program-image.jpg'}`;

        const { error: uploadError } = await supabase.storage
          .from('images')
          .upload(uploadFileName, buffer, {
            contentType: mimeType,
            upsert: true
          });

        if (uploadError) {
          console.error('[updateProgramDetails] Upload error:', uploadError);
          return res.status(500).json({ error: 'Failed to upload image' });
        }

        const { data: urlData } = supabase.storage
          .from('images')
          .getPublicUrl(uploadFileName);

        updatePayload.image_url = urlData?.publicUrl;
        console.log('[updateProgramDetails] Image uploaded successfully');
      }

      // Handle description update
      if (description !== undefined && description !== null) {
        updatePayload.description = description;
        console.log('[updateProgramDetails] Updating description');
      }

      // Handle offer type and related fields
      if (offerType !== undefined && offerType !== null) {
        updatePayload.offer_type = offerType;
        console.log('[updateProgramDetails] Updating offer type to:', offerType);

        if (offerType === 'bogo') {
          if (bogoBuyQuantity !== undefined) updatePayload.bogo_buy_quantity = bogoBuyQuantity;
          if (bogoGetFreeQuantity !== undefined) updatePayload.bogo_get_free_quantity = bogoGetFreeQuantity;
          if (bogoLogicType !== undefined) updatePayload.bogo_logic_type = bogoLogicType;

          updatePayload.bulk_discount_threshold = null;
          updatePayload.bulk_discount_percentage = null;

          console.log('[updateProgramDetails] BOGO offer configured');
        } else if (offerType === 'bulk_discount') {
          if (bulkDiscountThreshold !== undefined) updatePayload.bulk_discount_threshold = bulkDiscountThreshold;
          if (bulkDiscountPercentage !== undefined) updatePayload.bulk_discount_percentage = bulkDiscountPercentage;

          updatePayload.bogo_buy_quantity = null;
          updatePayload.bogo_get_free_quantity = null;
          updatePayload.bogo_logic_type = null;

          console.log('[updateProgramDetails] Bulk discount configured');
        } else {
          updatePayload.bogo_buy_quantity = null;
          updatePayload.bogo_get_free_quantity = null;
          updatePayload.bogo_logic_type = null;
          updatePayload.bulk_discount_threshold = null;
          updatePayload.bulk_discount_percentage = null;

          console.log('[updateProgramDetails] All offers cleared');
        }
      }

      // Update the program
      if (Object.keys(updatePayload).length > 0) {
        await supabase
          .from('program')
          .update(updatePayload)
          .eq('id', programId);

        console.log('[updateProgramDetails] Program updated successfully');
      }

      res.json({
        success: true,
        ...updatePayload
      });

    } catch (error: any) {
      console.error('[updateProgramDetails] error:', error);
      res.status(500).json({
        error: 'Failed to update program',
        message: error.message
      });
    }
  });

  // Update Event Image - admin only, handles image upload, description, and URL updates
  app.post('/api/functions/updateEventImage', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { eventId, imageBase64, fileName, userEmail, description, backstagePublicUrl } = req.body;

      if (!eventId) {
        return res.status(400).json({ error: 'Event ID is required' });
      }

      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }

      console.log('[updateEventImage] Processing request for user:', userEmail);

      // Check if user has event management access
      let hasAccess = false;

      // Check Member entity
      const { data: allMembers } = await supabase
        .from('member')
        .select('*');

      const member = allMembers?.find((m: any) => m.email === userEmail);

      if (member && member.role_id) {
        const { data: allRoles } = await supabase
          .from('role')
          .select('*');

        const role = allRoles?.find((r: any) => r.id === member.role_id);
        // Check if user has access to event management feature
        const excludedFeatures = role?.excluded_features || [];
        hasAccess = role && !excludedFeatures.includes('admin.events');
      }

      // If not found in Member, check TeamMember entity
      if (!hasAccess) {
        const { data: allTeamMembers } = await supabase
          .from('team_member')
          .select('*');

        const teamMember = allTeamMembers?.find((tm: any) => tm.email === userEmail);

        if (teamMember && teamMember.role_id) {
          const { data: allRoles } = await supabase
            .from('role')
            .select('*');

          const role = allRoles?.find((r: any) => r.id === teamMember.role_id);
          // Check if user has access to event management feature
          const excludedFeatures = role?.excluded_features || [];
          hasAccess = role && !excludedFeatures.includes('admin.events');
        }
      }

      if (!hasAccess) {
        console.log('[updateEventImage] User does not have access:', userEmail);
        return res.status(403).json({ error: 'Event management access required' });
      }

      console.log('[updateEventImage] User access verified, proceeding with update');

      // Prepare update payload
      const updatePayload: any = {};

      // Handle image upload if provided
      if (imageBase64) {
        // Convert base64 to buffer for upload
        const base64Data = imageBase64.split(',')[1]; // Remove data:image/...;base64, prefix
        const mimeType = imageBase64.split(';')[0].split(':')[1];
        const buffer = Buffer.from(base64Data, 'base64');

        const uploadFileName = `events/${eventId}/${fileName || 'event-image.jpg'}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('images')
          .upload(uploadFileName, buffer, {
            contentType: mimeType,
            upsert: true
          });

        if (uploadError) {
          console.error('[updateEventImage] Upload error:', uploadError);
          return res.status(500).json({ error: 'Failed to upload image' });
        }

        const { data: urlData } = supabase.storage
          .from('images')
          .getPublicUrl(uploadFileName);

        updatePayload.image_url = urlData?.publicUrl;
        console.log('[updateEventImage] Image uploaded successfully:', updatePayload.image_url);
      }

      // Handle description update if provided
      if (description !== undefined && description !== null) {
        updatePayload.description = description;
        console.log('[updateEventImage] Updating description');
      }

      // Handle backstage public URL update if provided
      if (backstagePublicUrl !== undefined && backstagePublicUrl !== null) {
        updatePayload.backstage_public_url = backstagePublicUrl;
        console.log('[updateEventImage] Updating backstage public URL');
      }

      // Update the event
      if (Object.keys(updatePayload).length > 0) {
        await supabase
          .from('event')
          .update(updatePayload)
          .eq('id', eventId);

        console.log('[updateEventImage] Event updated successfully');
      }

      res.json({
        success: true,
        ...updatePayload
      });

    } catch (error: any) {
      console.error('[updateEventImage] error:', error);
      res.status(500).json({
        error: 'Failed to update event',
        message: error.message
      });
    }
  });

  // Cancel Ticket Via Zoho Flow - cancels ticket and returns to organization balance
  app.post('/api/functions/cancelTicketViaFlow', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { orderId, cancelReason = "Cancelled by member via iConnect", memberId } = req.body;

      if (!orderId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameter: orderId'
        });
      }

      if (!memberId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameter: memberId'
        });
      }

      console.log('Cancelling order:', orderId, 'for member:', memberId);

      // STEP 1: Find the booking and verify authorization
      const { data: allBookings } = await supabase
        .from('booking')
        .select('*');

      const booking = allBookings?.find((b: any) => b.backstage_order_id === orderId);

      if (!booking) {
        return res.status(404).json({
          success: false,
          error: 'Booking not found with this order ID'
        });
      }

      // Authorization check: Verify the requesting member owns this booking
      if (booking.member_id !== memberId) {
        console.error('Authorization failed: Member', memberId, 'attempted to cancel booking belonging to', booking.member_id);
        return res.status(403).json({
          success: false,
          error: 'Unauthorized: You can only cancel your own bookings'
        });
      }

      // Check if already cancelled
      if (booking.status === 'cancelled') {
        return res.json({
          success: true,
          message: 'Ticket already cancelled'
        });
      }

      // Get the event to find the program tag
      const { data: allEvents } = await supabase
        .from('event')
        .select('*');

      const event = allEvents?.find((e: any) => e.id === booking.event_id);

      if (!event || !event.program_tag) {
        console.warn('Event not found or missing program tag, proceeding with cancellation anyway');
      }

      // Get the member to find organization
      const { data: allMembers } = await supabase
        .from('member')
        .select('*');

      const member = allMembers?.find((m: any) => m.id === booking.member_id);

      let organizationId = null;
      if (member && member.organization_id) {
        organizationId = member.organization_id;
      }

      // STEP 2: Return the program ticket to the organization's balance
      if (organizationId && event && event.program_tag) {
        const { data: allOrgs } = await supabase
          .from('organization')
          .select('*');

        let org = allOrgs?.find((o: any) => o.id === organizationId);

        if (!org) {
          org = allOrgs?.find((o: any) => o.zoho_account_id === organizationId);
        }

        if (org) {
          const currentBalances = org.program_ticket_balances || {};
          const currentBalance = currentBalances[event.program_tag] || 0;
          const newBalance = currentBalance + 1; // Return 1 ticket

          const updatedBalances = {
            ...currentBalances,
            [event.program_tag]: newBalance
          };

          await supabase
            .from('organization')
            .update({
              program_ticket_balances: updatedBalances,
              last_synced: new Date().toISOString()
            })
            .eq('id', org.id);

          console.log(`Returned 1 ticket to ${event.program_tag}. New balance: ${newBalance}`);

          // STEP 3: Create a refund transaction record
          await supabase
            .from('program_ticket_transaction')
            .insert({
              organization_id: org.id,
              program_name: event.program_tag,
              transaction_type: 'refund',
              quantity: 1,
              booking_reference: booking.booking_reference || orderId,
              event_name: event.title || 'Unknown Event',
              member_email: member?.email || booking.attendee_email || 'unknown',
              notes: `Ticket refunded due to cancellation: ${cancelReason}`
            });

          console.log('Created refund transaction record');
        }
      }

      // STEP 4: Update booking status to cancelled in our database
      await supabase
        .from('booking')
        .update({ status: 'cancelled' })
        .eq('id', booking.id);

      console.log('Updated booking status to cancelled in database');

      // STEP 4.5: Restore seat to event atomically using RPC (only if event has limited seats)
      if (event && event.available_seats !== null && event.available_seats !== undefined) {
        try {
          const { data: newSeatCount, error: rpcError } = await supabase
            .rpc('adjust_event_seats', { p_event_id: event.id, p_delta: 1 });
          
          if (rpcError) {
            console.error(`[cancelTicketViaFlow] RPC seat restore failed:`, rpcError.message);
          } else {
            console.log(`[cancelTicketViaFlow] Atomically restored seat, new count: ${newSeatCount}`);
          }
        } catch (rpcErr: any) {
          // Fallback to non-atomic update if RPC doesn't exist yet
          console.warn(`[cancelTicketViaFlow] RPC not available, using fallback:`, rpcErr.message);
          const newSeatCount = event.available_seats + 1;
          await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', event.id);
          console.log(`[cancelTicketViaFlow] Fallback: Restored seat to ${newSeatCount}`);
        }
      }

      // STEP 5: Call Zoho Flow webhook to cancel in Backstage
      const ZOHO_FLOW_WEBHOOK_URL = process.env.ZOHO_FLOW_CANCEL_WEBHOOK_URL ||
        'https://flow.zoho.eu/20108063378/flow/webhook/incoming?zapikey=1001.ee25c218c557d7dddb0eed4f3e0e981a.70bb4e51162d59156ab4899ad8bcc38c&isdebug=false';

      const response = await fetch(ZOHO_FLOW_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          order_id: orderId,
          cancel_reason: cancelReason
        })
      });

      if (response.ok) {
        console.log('Zoho Flow webhook called successfully');
        return res.json({
          success: true,
          message: 'Ticket cancelled successfully'
        });
      } else {
        const errorText = await response.text();
        console.error('Zoho Flow webhook error:', errorText);

        // Even if Flow webhook fails, we've already marked it as cancelled locally
        return res.json({
          success: true,
          message: 'Ticket marked as cancelled. Backstage sync may take a moment.',
          warning: 'Backstage API call failed but local status updated'
        });
      }

    } catch (error: any) {
      console.error('Cancellation error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Cancel Backstage Order - tries multiple API approaches
  app.post('/api/functions/cancelBackstageOrder', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { orderId, cancelReason = "Cancelled by member" } = req.body;

      console.log('=== CANCEL BACKSTAGE ORDER ===');
      console.log('Order ID:', orderId);
      console.log('Cancel Reason:', cancelReason);

      if (!orderId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameter: orderId'
        });
      }

      // Step 1: Find the booking with this backstage_order_id
      const { data: allBookings } = await supabase
        .from('booking')
        .select('*');

      const booking = allBookings?.find((b: any) => b.backstage_order_id === orderId);

      if (!booking) {
        console.error('No booking found with backstage_order_id:', orderId);
        return res.status(404).json({
          success: false,
          error: 'No booking found with this Backstage order ID'
        });
      }

      console.log('Found booking:', booking.id);

      // Step 2: Get the event to find the backstage_event_id
      const { data: allEvents } = await supabase
        .from('event')
        .select('*');

      const event = allEvents?.find((e: any) => e.id === booking.event_id);

      if (!event || !event.backstage_event_id) {
        console.error('Event not found or missing backstage_event_id');
        return res.status(404).json({
          success: false,
          error: 'Event not found or missing Backstage event ID'
        });
      }

      console.log('Backstage Event ID:', event.backstage_event_id);

      // Step 3: Get access token
      const accessToken = await getValidZohoAccessToken(supabase);
      console.log('Access token obtained');

      const portalId = process.env.ZOHO_BACKSTAGE_PORTAL_ID || "20108049755";
      const baseUrl = "https://www.zohoapis.eu/backstage/v3";
      const orderUrl = `${baseUrl}/portals/${portalId}/events/${event.backstage_event_id}/orders/${orderId}`;

      console.log('Order URL:', orderUrl);

      const attempts: any[] = [];

      // ATTEMPT 1: PUT request with status update
      console.log('\n--- ATTEMPT 1: PUT request with status ---');
      try {
        const putBody = {
          status: 'cancelled',
          cancel_reason: cancelReason
        };

        const response1 = await fetch(orderUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(putBody)
        });

        const responseText1 = await response1.text();
        console.log('Response Status:', response1.status);

        attempts.push({
          method: 'PUT',
          url: orderUrl,
          body: putBody,
          status: response1.status,
          response: responseText1,
          success: response1.ok
        });

        if (response1.ok) {
          console.log('SUCCESS with PUT');

          await supabase
            .from('booking')
            .update({ status: 'cancelled' })
            .eq('id', booking.id);

          // Restore seat to event atomically using RPC (only if event has limited seats)
          if (event.available_seats !== null && event.available_seats !== undefined) {
            try {
              const { data: newSeatCount, error: rpcError } = await supabase
                .rpc('adjust_event_seats', { p_event_id: event.id, p_delta: 1 });
              if (!rpcError) console.log(`[cancelBackstageOrder] Atomically restored seat, new count: ${newSeatCount}`);
            } catch (rpcErr: any) {
              const newSeatCount = event.available_seats + 1;
              await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', event.id);
              console.log(`[cancelBackstageOrder] Fallback: Restored seat to ${newSeatCount}`);
            }
          }

          return res.json({
            success: true,
            method: 'PUT',
            message: 'Order cancelled successfully',
            attempts
          });
        }
      } catch (error: any) {
        console.error('ATTEMPT 1 Error:', error.message);
        attempts.push({ method: 'PUT', url: orderUrl, error: error.message });
      }

      // ATTEMPT 2: POST with action parameter
      console.log('\n--- ATTEMPT 2: POST with action=cancel ---');
      try {
        const postBody = {
          action: 'cancel',
          cancel_reason: cancelReason
        };

        const response2 = await fetch(orderUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(postBody)
        });

        const responseText2 = await response2.text();
        console.log('Response Status:', response2.status);

        attempts.push({
          method: 'POST',
          url: orderUrl,
          body: postBody,
          status: response2.status,
          response: responseText2,
          success: response2.ok
        });

        if (response2.ok) {
          console.log('SUCCESS with POST action=cancel');

          await supabase
            .from('booking')
            .update({ status: 'cancelled' })
            .eq('id', booking.id);

          // Restore seat to event atomically using RPC (only if event has limited seats)
          if (event.available_seats !== null && event.available_seats !== undefined) {
            try {
              const { data: newSeatCount, error: rpcError } = await supabase
                .rpc('adjust_event_seats', { p_event_id: event.id, p_delta: 1 });
              if (!rpcError) console.log(`[cancelBackstageOrder] Atomically restored seat, new count: ${newSeatCount}`);
            } catch (rpcErr: any) {
              const newSeatCount = event.available_seats + 1;
              await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', event.id);
              console.log(`[cancelBackstageOrder] Fallback: Restored seat to ${newSeatCount}`);
            }
          }

          return res.json({
            success: true,
            method: 'POST (action parameter)',
            message: 'Order cancelled successfully',
            attempts
          });
        }
      } catch (error: any) {
        console.error('ATTEMPT 2 Error:', error.message);
        attempts.push({ method: 'POST', url: orderUrl, error: error.message });
      }

      // ATTEMPT 3: Try refund endpoint
      console.log('\n--- ATTEMPT 3: POST to refund endpoint ---');
      try {
        const refundUrl = `${orderUrl}/refund`;
        const postBody = {
          cancel_reason: cancelReason,
          refund_amount: 0
        };

        const response3 = await fetch(refundUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(postBody)
        });

        const responseText3 = await response3.text();
        console.log('Response Status:', response3.status);

        attempts.push({
          method: 'POST',
          url: refundUrl,
          body: postBody,
          status: response3.status,
          response: responseText3,
          success: response3.ok
        });

        if (response3.ok) {
          console.log('SUCCESS with refund endpoint');

          await supabase
            .from('booking')
            .update({ status: 'cancelled' })
            .eq('id', booking.id);

          // Restore seat to event atomically using RPC (only if event has limited seats)
          if (event.available_seats !== null && event.available_seats !== undefined) {
            try {
              const { data: newSeatCount, error: rpcError } = await supabase
                .rpc('adjust_event_seats', { p_event_id: event.id, p_delta: 1 });
              if (!rpcError) console.log(`[cancelBackstageOrder] Atomically restored seat, new count: ${newSeatCount}`);
            } catch (rpcErr: any) {
              const newSeatCount = event.available_seats + 1;
              await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', event.id);
              console.log(`[cancelBackstageOrder] Fallback: Restored seat to ${newSeatCount}`);
            }
          }

          return res.json({
            success: true,
            method: 'POST (refund endpoint)',
            message: 'Order cancelled successfully',
            attempts
          });
        }
      } catch (error: any) {
        console.error('ATTEMPT 3 Error:', error.message);
        attempts.push({ method: 'POST', url: `${orderUrl}/refund`, error: error.message });
      }

      console.log('\n=== ALL ATTEMPTS COMPLETED ===');
      console.log('Summary: All cancellation attempts failed.');

      res.json({
        success: false,
        message: 'All cancellation attempts failed. Zoho Flow webhook approach recommended.',
        attempts,
        orderUrl,
        portalId,
        backstageEventId: event.backstage_event_id,
        recommendation: 'Consider using Zoho Flow webhook to handle cancellations'
      });

    } catch (error: any) {
      console.error('Fatal error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Process Backstage Cancellation Webhook
  app.post('/api/functions/processBackstageCancellation', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const webhookData = req.body;

      console.log("=== BACKSTAGE CANCELLATION WEBHOOK RECEIVED ===");
      console.log("Full Payload:", JSON.stringify(webhookData, null, 2));
      console.log("==============================================");

      // Extract key fields from the webhook
      const action = webhookData.action;
      const resourceType = webhookData.resource;
      const backstageOrderId = webhookData.resource_id;

      console.log("Extracted Fields:");
      console.log("  - Action:", action);
      console.log("  - Resource:", resourceType);
      console.log("  - Backstage Order ID:", backstageOrderId);

      // Handle EVENTORDER cancellations where each order represents a single ticket
      if (action === 'cancel' && resourceType === 'eventorder') {
        console.log("*** SINGLE TICKET ORDER CANCELLATION DETECTED ***");

        if (!backstageOrderId) {
          console.error("Missing backstage order ID in cancellation webhook payload");
          return res.status(400).json({
            success: false,
            error: "Missing order ID in payload"
          });
        }

        // Find the booking with this specific backstage_order_id
        const { data: allBookings } = await supabase
          .from('booking')
          .select('*');

        const bookingToCancel = allBookings?.find((b: any) =>
          b.backstage_order_id === backstageOrderId &&
          b.status !== 'cancelled'
        );

        if (bookingToCancel) {
          await supabase
            .from('booking')
            .update({ status: 'cancelled' })
            .eq('id', bookingToCancel.id);

          console.log(`Booking ${bookingToCancel.id} (${bookingToCancel.attendee_email}) updated to cancelled.`);

          // Restore seat to event atomically using RPC (only if event has limited seats)
          const { data: event } = await supabase
            .from('event')
            .select('available_seats')
            .eq('id', bookingToCancel.event_id)
            .single();
          
          if (event && event.available_seats !== null && event.available_seats !== undefined) {
            try {
              const { data: newSeatCount, error: rpcError } = await supabase
                .rpc('adjust_event_seats', { p_event_id: bookingToCancel.event_id, p_delta: 1 });
              if (!rpcError) console.log(`[processBackstageCancellation] Atomically restored seat, new count: ${newSeatCount}`);
            } catch (rpcErr: any) {
              const newSeatCount = event.available_seats + 1;
              await supabase.from('event').update({ available_seats: newSeatCount }).eq('id', bookingToCancel.event_id);
              console.log(`[processBackstageCancellation] Fallback: Restored seat to ${newSeatCount}`);
            }
          }

          return res.json({
            success: true,
            message: `Successfully cancelled booking for Backstage Order ID: ${backstageOrderId}`,
            booking_id: bookingToCancel.id
          });
        } else {
          console.warn(`No active booking found for Backstage Order ID: ${backstageOrderId}`);
          return res.json({
            success: true,
            message: `No active booking found for Backstage Order ID: ${backstageOrderId}`
          });
        }

      } else {
        console.log(`Webhook received but not an 'eventorder' cancellation. Action: ${action}, Resource: ${resourceType}`);
        return res.json({
          success: true,
          message: "Webhook received but not an expected order cancellation event"
        });
      }

    } catch (error: any) {
      console.error("Error processing Backstage cancellation webhook:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Apply Discount Code
  app.post('/api/functions/applyDiscountCode', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const { code, totalCost, programTag, memberEmail } = req.body;

      console.log('[applyDiscountCode] Request received:', { code, totalCost, programTag, memberEmail });

      if (!code || !totalCost || typeof totalCost !== 'number' || totalCost < 0) {
        console.error('[applyDiscountCode] Invalid input validation failed');
        return res.json({
          success: false,
          error: 'Invalid input: code and a valid totalCost are required.'
        });
      }

      if (!memberEmail) {
        console.error('[applyDiscountCode] Member email missing');
        return res.json({
          success: false,
          error: 'Member email is required.'
        });
      }

      // Get member's organization
      const { data: allMembers } = await supabase
        .from('member')
        .select('*');

      const member = allMembers?.find((m: any) => m.email === memberEmail);

      if (!member || !member.organization_id) {
        console.error('[applyDiscountCode] Member or organization not found');
        return res.json({
          success: false,
          error: 'Member organization not found.'
        });
      }

      const memberOrgId = member.organization_id;

      // Find discount codes that match
      const { data: allDiscountCodes } = await supabase
        .from('discount_code')
        .select('*');

      const matchingCodes = allDiscountCodes?.filter((dc: any) =>
        dc.code.toUpperCase() === code.toUpperCase() &&
        (!dc.organization_id || dc.organization_id === memberOrgId)
      );

      if (!matchingCodes || matchingCodes.length === 0) {
        console.error('[applyDiscountCode] Discount code not found:', code);
        return res.json({ success: false, error: 'Invalid discount code.' });
      }

      const discountCode = matchingCodes[0];
      console.log('[applyDiscountCode] Found discount code:', discountCode.code);

      // Validate discount code status and expiry
      if (!discountCode.is_active) {
        console.error('[applyDiscountCode] Discount code is inactive');
        return res.json({ success: false, error: 'Invalid discount code.' });
      }

      if (discountCode.expires_at && new Date(discountCode.expires_at) < new Date()) {
        console.error('[applyDiscountCode] Discount code has expired');
        return res.json({ success: false, error: 'Invalid discount code.' });
      }

      // Validate minimum purchase amount
      if (discountCode.min_purchase_amount > 0 && totalCost < discountCode.min_purchase_amount) {
        console.error('[applyDiscountCode] Minimum purchase amount not met');
        return res.json({
          success: false,
          error: 'Invalid discount code.'
        });
      }

      // Validate usage count
      if (discountCode.max_usage_count) {
        let currentUsage = 0;

        if (discountCode.organization_id) {
          // Organization-specific code: check DiscountCodeUsage
          const { data: usageRecords } = await supabase
            .from('discount_code_usage')
            .select('*')
            .eq('discount_code_id', discountCode.id)
            .eq('organization_id', memberOrgId);

          if (usageRecords && usageRecords.length > 0) {
            currentUsage = usageRecords[0].usage_count || 0;
          }
        } else {
          // Global code: check current_usage_count on DiscountCode
          currentUsage = discountCode.current_usage_count || 0;
        }

        if (currentUsage >= discountCode.max_usage_count) {
          console.error('[applyDiscountCode] Max usage count reached');
          return res.json({ success: false, error: 'Invalid discount code.' });
        }
      }

      // Validate program tag if specified
      if (discountCode.program_tag && discountCode.program_tag !== programTag) {
        console.error('[applyDiscountCode] Program tag mismatch');
        return res.json({
          success: false,
          error: 'Invalid discount code.'
        });
      }

      // Calculate discount amount
      let discountAmount = 0;
      if (discountCode.type === 'percentage') {
        discountAmount = totalCost * (discountCode.value / 100);
      } else if (discountCode.type === 'fixed') {
        discountAmount = discountCode.value;
      }

      // Ensure discount doesn't make total cost negative
      discountAmount = Math.min(discountAmount, totalCost);
      const totalCostAfterDiscount = Math.max(0, totalCost - discountAmount);

      console.log('[applyDiscountCode] Discount calculated successfully:', {
        discountAmount,
        totalCostAfterDiscount
      });

      res.json({
        success: true,
        discountId: discountCode.id,
        code: discountCode.code,
        type: discountCode.type,
        value: discountCode.value,
        discountAmount: parseFloat(discountAmount.toFixed(2)),
        totalCostAfterDiscount: parseFloat(totalCostAfterDiscount.toFixed(2)),
        isOrganizationSpecific: !!discountCode.organization_id,
        message: 'Discount applied successfully!'
      });

    } catch (error: any) {
      console.error('[applyDiscountCode] Unexpected error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to apply discount code.'
      });
    }
  });

  // Validate User - checks TeamMember first, then Zoho CRM
  app.post('/api/functions/validateUser', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    console.log('\n\n========================================');
    console.log('validateUser FUNCTION CALLED');
    console.log('========================================\n');

    try {
      const { email } = req.body;

      console.log('[validateUser] Email to validate:', email);

      if (!email) {
        console.warn('[validateUser] No email provided in request');
        return res.status(400).json({ error: 'Email is required' });
      }

      // Step 1: Check if this is a TeamMember first
      console.log('\n[validateUser] STEP 1: Checking TeamMember table...');
      const { data: allTeamMembers } = await supabase
        .from('team_member')
        .select('*');

      const teamMember = allTeamMembers?.find((tm: any) => tm.email === email && tm.is_active === true);

      if (teamMember) {
        console.log('[validateUser] MATCH FOUND: Active TeamMember with email:', teamMember.email);

        return res.json({
          success: true,
          user: {
            email: teamMember.email,
            first_name: teamMember.first_name,
            last_name: teamMember.last_name,
            role_id: teamMember.role_id,
            is_team_member: true,
            member_excluded_features: [],
            has_seen_onboarding_tour: teamMember.has_seen_onboarding_tour || false
          }
        });
      }

      console.log('[validateUser] No matching TeamMember found');

      // Step 2: Check Zoho CRM for regular Member
      console.log('\n[validateUser] STEP 2: Checking Zoho CRM...');

      const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN;
      const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
      const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;

      if (!ZOHO_CRM_API_DOMAIN || !ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET) {
        return res.status(500).json({
          success: false,
          error: 'Zoho integration not configured'
        });
      }

      // Get valid Zoho access token
      let accessToken: string;
      try {
        accessToken = await getValidZohoAccessToken(supabase);
        console.log('[validateUser] Successfully obtained access token');
      } catch (authError: any) {
        console.error('[validateUser] Failed to get Zoho Access Token:', authError.message);
        return res.status(500).json({
          success: false,
          error: 'Zoho integration error. Please contact support.',
          details: authError.message
        });
      }

      // Search Zoho CRM for contact
      const criteria = `(Email:equals:${email})`;
      const searchUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Contacts/search?criteria=${encodeURIComponent(criteria)}`;

      console.log('[validateUser] Searching Zoho CRM...');

      const searchResponse = await fetch(searchUrl, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
        },
      });

      console.log('[validateUser] Zoho CRM Response status:', searchResponse.status);

      let searchData: any;
      try {
        searchData = await searchResponse.json();
      } catch (parseError) {
        console.error('[validateUser] Failed to parse Zoho response');
        return res.status(500).json({
          success: false,
          error: 'Invalid response from CRM'
        });
      }

      if (!searchResponse.ok) {
        console.error('[validateUser] CRM search failed:', searchData);
        return res.status(searchResponse.status).json({
          success: false,
          error: 'Error searching CRM. Please try again.',
          details: searchData
        });
      }

      if (!searchData.data || searchData.data.length === 0) {
        console.warn('[validateUser] Email not found in Zoho CRM:', email);
        return res.status(404).json({
          success: false,
          error: 'Email not found. Please check your email address or contact support.'
        });
      }

      const contact = searchData.data[0];
      console.log('[validateUser] CONTACT FOUND in Zoho CRM:', contact.Email);

      let organizationId = null;
      let organizationName = null;
      let trainingFundBalance = 0;
      let purchaseOrderEnabled = false;
      let programTicketBalances: any = {};

      // Step 3: Fetch Account/Organization details
      if (contact.Account_Name?.id) {
        console.log('\n[validateUser] STEP 3: Fetching Account (Organization) details...');
        const accountUrl = `${ZOHO_CRM_API_DOMAIN}/crm/v3/Accounts/${contact.Account_Name.id}`;

        const accountResponse = await fetch(accountUrl, {
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
          },
        });

        if (accountResponse.ok) {
          const accountData = await accountResponse.json() as any;
          const account = accountData.data[0];

          console.log('[validateUser] Account details retrieved:', account.Account_Name);

          organizationName = account.Account_Name;
          organizationId = account.id;
          trainingFundBalance = account.Training_Fund_Balance || 0;
          purchaseOrderEnabled = account.Purchase_Order_Enabled || false;

          // Sync Organization to database
          console.log('\n[validateUser] Syncing Organization to database...');
          const { data: existingOrgs } = await supabase
            .from('organization')
            .select('*')
            .eq('zoho_account_id', organizationId);

          if (existingOrgs && existingOrgs.length > 0) {
            await supabase
              .from('organization')
              .update({
                name: organizationName,
                training_fund_balance: trainingFundBalance,
                purchase_order_enabled: purchaseOrderEnabled,
                last_synced: new Date().toISOString()
              })
              .eq('id', existingOrgs[0].id);
            programTicketBalances = existingOrgs[0].program_ticket_balances || {};
            console.log('[validateUser] Organization updated');
          } else {
            const { data: newOrg } = await supabase
              .from('organization')
              .insert({
                name: organizationName,
                zoho_account_id: organizationId,
                training_fund_balance: trainingFundBalance,
                purchase_order_enabled: purchaseOrderEnabled,
                last_synced: new Date().toISOString()
              })
              .select()
              .single();
            programTicketBalances = newOrg?.program_ticket_balances || {};
            console.log('[validateUser] Organization created');
          }
        }
      }

      // Step 4: Sync Member to database
      console.log('\n[validateUser] STEP 4: Syncing Member to database...');
      const { data: allMembers } = await supabase
        .from('member')
        .select('*');

      const existingMember = allMembers?.find((m: any) => m.email === email);

      // Check login_enabled status
      if (existingMember && existingMember.login_enabled === false) {
        console.warn('[validateUser] Login disabled for member:', email);
        return res.status(403).json({
          success: false,
          error: 'Your account access has been disabled. Please contact your organization administrator.'
        });
      }

      const zohoMemberData: any = {
        email: email,
        first_name: contact.First_Name,
        last_name: contact.Last_Name,
        zoho_contact_id: contact.id,
        organization_id: organizationId,
        last_synced: new Date().toISOString()
      };

      let member: any;
      if (existingMember) {
        console.log('[validateUser] Updating existing Member:', existingMember.id);
        await supabase
          .from('member')
          .update(zohoMemberData)
          .eq('id', existingMember.id);

        member = { ...existingMember, ...zohoMemberData };
        console.log('[validateUser] Member updated with preserved app fields');
      } else {
        console.log('[validateUser] Creating new Member record');

        // Check for default role
        const { data: allRoles } = await supabase
          .from('role')
          .select('*');

        const defaultRole = allRoles?.find((r: any) => r.is_default === true);
        if (defaultRole) {
          zohoMemberData.role_id = defaultRole.id;
        }

        const { data: newMember } = await supabase
          .from('member')
          .insert(zohoMemberData)
          .select()
          .single();

        member = newMember;
        console.log('[validateUser] Member created');
      }

      console.log('\n[validateUser] SUCCESS: Member validation complete');

      res.json({
        success: true,
        user: {
          email: member.email,
          first_name: member.first_name,
          last_name: member.last_name,
          organization_id: organizationId,
          organization_name: organizationName,
          training_fund_balance: trainingFundBalance,
          purchase_order_enabled: purchaseOrderEnabled,
          program_ticket_balances: programTicketBalances,
          role_id: member.role_id || null,
          member_excluded_features: member.member_excluded_features || [],
          has_seen_onboarding_tour: member.has_seen_onboarding_tour || false,
          page_tours_seen: member.page_tours_seen || {},
          is_team_member: false
        }
      });

    } catch (error: any) {
      console.error('\n[validateUser] FATAL ERROR:', error.message);
      res.status(500).json({
        success: false,
        error: 'Unable to validate user. Please try again later.',
        details: error.message
      });
    }
  });

  // Create Xero Invoice
  app.post('/api/functions/createXeroInvoice', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const {
        organizationName,
        purchaseOrderNumber,
        programName,
        baseTicketPrice,
        totalCost,
        totalTickets,
        offerDetails,
        discountCode,
        discountType,
        discountValue,
        stripePaymentIntentId,
        internalReference
      } = req.body;

      if (!organizationName || !programName || totalCost === undefined || !totalTickets) {
        return res.status(400).json({
          error: 'Missing required parameters',
          required: ['organizationName', 'programName', 'totalCost', 'totalTickets']
        });
      }

      // Get valid Xero token
      const { accessToken, tenantId } = await getValidXeroAccessToken(supabase);

      // Find or create contact
      const contactId = await findOrCreateXeroContact(accessToken, tenantId, organizationName);

      // Calculate unit price (cost per ticket including free ones)
      const unitPrice = (totalCost / totalTickets).toFixed(2);

      // Build line description
      let description = `${programName} tickets.\nPrice: £${baseTicketPrice}`;
      if (offerDetails) {
        description += `\nOffer: ${offerDetails}`;
      }

      // Add internal reference if present (for event tracking)
      if (internalReference) {
        description += `\nRef: ${internalReference}`;
      }

      // Add discount code information if present
      if (discountCode) {
        const discountDisplay = discountType === 'percentage'
          ? `${discountValue}%`
          : `£${(discountValue || 0).toFixed(2)}`;
        description += `\nDiscount Code: ${discountCode} (${discountDisplay} off)`;
      }

      // Add Stripe payment intent ID if present
      if (stripePaymentIntentId) {
        description += `\nStripe Payment ID: ${stripePaymentIntentId}`;
      }

      // Create invoice
      const invoicePayload = {
        Invoices: [{
          Type: 'ACCREC',
          Contact: {
            ContactID: contactId
          },
          Reference: purchaseOrderNumber || '',
          Status: 'DRAFT',
          DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          LineItems: [{
            Description: description,
            Quantity: totalTickets,
            UnitAmount: parseFloat(unitPrice),
            AccountCode: '2112',
            TaxType: 'EXEMPTOUTPUT'
          }]
        }]
      };

      const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'xero-tenant-id': tenantId,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(invoicePayload)
      });

      const invoiceData = await invoiceResponse.json() as any;

      if (!invoiceResponse.ok || !invoiceData.Invoices || invoiceData.Invoices.length === 0) {
        return res.status(400).json({
          error: 'Failed to create Xero invoice',
          details: invoiceData
        });
      }

      const invoice = invoiceData.Invoices[0];

      // Fetch PDF from Xero
      const pdfResponse = await fetch(
        `https://api.xero.com/api.xro/2.0/Invoices/${invoice.InvoiceID}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'xero-tenant-id': tenantId,
            'Accept': 'application/pdf'
          }
        }
      );

      if (!pdfResponse.ok) {
        console.error('Failed to fetch invoice PDF from Xero');
        return res.json({
          success: true,
          invoice_id: invoice.InvoiceID,
          invoice_number: invoice.InvoiceNumber,
          total: invoice.Total,
          status: invoice.Status
        });
      }

      // Get PDF as buffer and upload to Supabase storage
      const pdfBuffer = await pdfResponse.arrayBuffer();
      const fileName = `invoices/invoice-${invoice.InvoiceNumber}.pdf`;

      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('documents')
        .upload(fileName, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        });

      let pdfUri = null;
      if (!uploadError && uploadData) {
        const { data: urlData } = supabase.storage
          .from('documents')
          .getPublicUrl(fileName);
        pdfUri = urlData?.publicUrl;
      }

      res.json({
        success: true,
        invoice_id: invoice.InvoiceID,
        invoice_number: invoice.InvoiceNumber,
        total: invoice.Total,
        status: invoice.Status,
        pdf_uri: pdfUri
      });

    } catch (error: any) {
      console.error('Xero invoice creation error:', error);
      res.status(500).json({
        error: 'Failed to create invoice',
        message: error.message
      });
    }
  });

  // Refresh Xero Token
  app.post('/api/functions/refreshXeroToken', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }

    try {
      const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
      const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;

      if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET) {
        return res.status(500).json({ error: 'Xero credentials not configured' });
      }

      // Get current token
      const { data: tokens } = await supabase
        .from('xero_token')
        .select('*');

      if (!tokens || tokens.length === 0) {
        return res.status(404).json({
          error: 'No Xero token found. Please authenticate first.'
        });
      }

      const currentToken = tokens[0];

      // Check if token needs refresh (refresh if expires in next 5 minutes)
      const expiresAt = new Date(currentToken.expires_at);
      const now = new Date();
      const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

      if (expiresAt > fiveMinutesFromNow) {
        return res.json({
          message: 'Token is still valid',
          expires_at: currentToken.expires_at
        });
      }

      // Refresh the token
      const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: currentToken.refresh_token,
        }).toString(),
      });

      const tokenData = await tokenResponse.json() as any;

      if (!tokenResponse.ok || tokenData.error) {
        return res.status(400).json({
          error: 'Failed to refresh token',
          details: tokenData
        });
      }

      // Calculate new expiry
      const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

      // Update stored token
      await supabase
        .from('xero_token')
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: newExpiresAt,
        })
        .eq('id', currentToken.id);

      res.json({
        success: true,
        message: 'Token refreshed successfully',
        expires_at: newExpiresAt
      });

    } catch (error: any) {
      res.status(500).json({
        error: 'Failed to refresh Xero token',
        message: error.message
      });
    }
  });

  // Get Xero Auth URL
  app.get('/api/functions/getXeroAuthUrl', async (req: Request, res: Response) => {
    try {
      const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
      const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;

      if (!XERO_CLIENT_ID || !XERO_REDIRECT_URI) {
        return res.status(500).json({
          error: 'Xero not configured',
          message: 'Missing XERO_CLIENT_ID or XERO_REDIRECT_URI'
        });
      }

      // Xero OAuth authorization URL
      const authUrl = `https://login.xero.com/identity/connect/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: XERO_CLIENT_ID,
        redirect_uri: XERO_REDIRECT_URI,
        scope: 'offline_access accounting.transactions accounting.contacts accounting.settings openid profile email',
        state: 'xero_auth'
      }).toString();

      res.json({ authUrl });

    } catch (error: any) {
      res.status(500).json({
        error: 'Failed to generate auth URL',
        message: error.message
      });
    }
  });

  // ============ Zoho OAuth Routes ============
  
  // Helper to get Zoho accounts domain from API domain
  const getZohoAccountsDomain = (apiDomain: string): string => {
    if (apiDomain?.includes('.zohoapis.eu')) {
      return 'https://accounts.zoho.eu';
    } else if (apiDomain?.includes('.zohoapis.com.au')) {
      return 'https://accounts.zoho.com.au';
    } else {
      return 'https://accounts.zoho.com';
    }
  };

  // Get Zoho Auth URL
  app.post('/api/functions/getZohoAuthUrl', async (req: Request, res: Response) => {
    const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';
    
    if (!ZOHO_CLIENT_ID) {
      return res.status(503).json({ error: 'Zoho OAuth not configured - missing ZOHO_CLIENT_ID' });
    }

    try {
      const accountsDomain = getZohoAccountsDomain(ZOHO_CRM_API_DOMAIN);
      const redirectUri = `${req.protocol}://${req.get('host')}/api/functions/zohoOAuthCallback`;
      
      // Build Zoho OAuth authorization URL with CRM and Backstage scopes
      const authUrl = `${accountsDomain}/oauth/v2/auth?` + new URLSearchParams({
        scope: 'ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.accounts.ALL,zohobackstage.portal.READ,zohobackstage.event.READ,zohobackstage.eventticket.READ,zohobackstage.order.READ,zohobackstage.order.CREATE,zohobackstage.attendee.READ',
        client_id: ZOHO_CLIENT_ID,
        response_type: 'code',
        access_type: 'offline',
        redirect_uri: redirectUri,
        prompt: 'consent'
      }).toString();

      res.json({ authUrl });
    } catch (error: any) {
      res.status(500).json({
        error: 'Failed to generate auth URL',
        message: error.message
      });
    }
  });

  // Zoho OAuth Callback (GET - browser redirect)
  app.get('/api/functions/zohoOAuthCallback', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1 style="color: #dc2626;">Configuration Error</h1>
            <p>Supabase is not configured</p>
            <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Close Window
            </button>
          </body>
        </html>
      `);
    }

    const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
    const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
    const ZOHO_CRM_API_DOMAIN = process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu';

    const code = req.query.code as string;
    const error = req.query.error as string;

    if (error) {
      return res.status(400).send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1 style="color: #dc2626;">Authentication Error</h1>
            <p>Failed to authenticate with Zoho: ${error}</p>
            <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Close Window
            </button>
          </body>
        </html>
      `);
    }

    if (!code) {
      return res.status(400).send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1 style="color: #dc2626;">Missing Authorization Code</h1>
            <p>No authorization code was provided by Zoho.</p>
            <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Close Window
            </button>
          </body>
        </html>
      `);
    }

    try {
      const accountsDomain = getZohoAccountsDomain(ZOHO_CRM_API_DOMAIN);
      const redirectUri = `${req.protocol}://${req.get('host')}/api/functions/zohoOAuthCallback`;

      // Exchange authorization code for access token
      const tokenResponse = await fetch(`${accountsDomain}/oauth/v2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: ZOHO_CLIENT_ID!,
          client_secret: ZOHO_CLIENT_SECRET!,
          redirect_uri: redirectUri,
          code: code,
        }).toString(),
      });

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || tokenData.error) {
        return res.status(400).send(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1 style="color: #dc2626;">Token Exchange Failed</h1>
              <p>Error: ${JSON.stringify(tokenData)}</p>
              <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
                Close Window
              </button>
            </body>
          </html>
        `);
      }

      // Calculate expiration time
      const expiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

      // Store tokens in Supabase
      const { data: existingTokens } = await supabase
        .from('zoho_token')
        .select('id')
        .limit(1);

      if (existingTokens && existingTokens.length > 0) {
        await supabase
          .from('zoho_token')
          .update({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: expiresAt,
            token_type: tokenData.token_type || 'Bearer',
          })
          .eq('id', existingTokens[0].id);
      } else {
        await supabase
          .from('zoho_token')
          .insert({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: expiresAt,
            token_type: tokenData.token_type || 'Bearer',
          });
      }

      res.send(`
        <html>
          <head>
            <style>
              body {
                font-family: system-ui;
                padding: 40px;
                text-align: center;
                background: linear-gradient(to br, #f8fafc, #eff6ff);
              }
              .success { color: #16a34a; margin-bottom: 10px; }
              button {
                margin-top: 20px;
                padding: 12px 24px;
                background: #2563eb;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 16px;
              }
              button:hover { background: #1d4ed8; }
            </style>
          </head>
          <body>
            <h1 class="success">Authentication Successful</h1>
            <p>Your Zoho account has been connected successfully.</p>
            <p style="font-size: 14px; color: #64748b;">You can now close this window.</p>
            <button onclick="window.close()">Close Window</button>
            <script>
              setTimeout(() => window.close(), 3000);
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Zoho OAuth callback error:', err);
      res.status(500).send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1 style="color: #dc2626;">Server Error</h1>
            <p>An error occurred during authentication.</p>
            <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Close Window
            </button>
          </body>
        </html>
      `);
    }
  });

  // Generic function handler for unimplemented functions
  app.post('/api/functions/:functionName', async (req: Request, res: Response) => {
    const { functionName } = req.params;
    console.log(`Function called: ${functionName}`, req.body);
    
    res.json({ 
      success: false, 
      error: `Function '${functionName}' is not yet implemented on the Replit backend`
    });
  });

  // ============ File Migration to Supabase Storage ============
  const BUCKET_NAME = 'file-repository';
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const PROGRESS_FILE = path.join(__dirname, 'file-migration-progress.json');
  
  interface MigrationProgress {
    migratedIds: string[];
    failedIds: { id: string; error: string }[];
    lastRunAt: string;
    isRunning?: boolean;
  }
  
  function loadMigrationProgress(): MigrationProgress {
    try {
      if (fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      }
    } catch (e) {
      console.log('Could not load progress file');
    }
    return { migratedIds: [], failedIds: [], lastRunAt: '' };
  }
  
  function saveMigrationProgress(progress: MigrationProgress) {
    progress.lastRunAt = new Date().toISOString();
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }
  
  // Check migration status
  app.get('/api/file-migration/status', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const progress = loadMigrationProgress();
      
      // Get total file count
      const { count: totalFiles } = await supabase
        .from('file_repository')
        .select('id', { count: 'exact', head: true });
      
      // Get count of files already on Supabase storage
      const { data: supabaseFiles } = await supabase
        .from('file_repository')
        .select('id')
        .like('file_url', `%${supabaseUrl}%`);
      
      res.json({
        totalFiles: totalFiles || 0,
        migratedCount: progress.migratedIds.length,
        alreadyOnSupabase: supabaseFiles?.length || 0,
        failedCount: progress.failedIds.length,
        lastRunAt: progress.lastRunAt,
        isRunning: progress.isRunning || false,
        recentFailures: progress.failedIds.slice(-10)
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Start migration
  app.post('/api/file-migration/start', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    const progress = loadMigrationProgress();
    if (progress.isRunning) {
      return res.status(409).json({ error: 'Migration is already running' });
    }
    
    const { limit = 100, dryRun = false } = req.body;
    
    // Mark as running
    progress.isRunning = true;
    saveMigrationProgress(progress);
    
    res.json({ message: 'Migration started', limit, dryRun });
    
    // Run migration in background
    (async () => {
      try {
        // Ensure bucket exists
        if (!dryRun) {
          const { data: buckets } = await supabase.storage.listBuckets();
          const bucketExists = buckets?.some(b => b.name === BUCKET_NAME);
          
          if (!bucketExists) {
            await supabase.storage.createBucket(BUCKET_NAME, {
              public: true,
              fileSizeLimit: 52428800
            });
            console.log(`Created bucket: ${BUCKET_NAME}`);
          }
        }
        
        // Get files to migrate
        console.log('[Migration] Fetching files from database...');
        const { data: files, error: fetchError } = await supabase
          .from('file_repository')
          .select('id, file_name, file_url, file_type, mime_type, file_size, folder_id');
        
        if (fetchError) {
          console.error('[Migration] Error fetching files:', fetchError);
          progress.isRunning = false;
          saveMigrationProgress(progress);
          return;
        }
        
        console.log(`[Migration] Found ${files?.length || 0} total files`);
        
        if (!files || files.length === 0) {
          console.log('[Migration] No files found to migrate');
          progress.isRunning = false;
          saveMigrationProgress(progress);
          return;
        }
        
        const filesToMigrate = files.filter((f: any) => {
          if (progress.migratedIds.includes(f.id)) {
            return false;
          }
          if (!f.file_url) {
            return false;
          }
          // Only skip if URL contains supabase storage URL pattern
          if (f.file_url.includes('supabase.co/storage')) {
            return false;
          }
          return true;
        }).slice(0, limit);
        
        console.log(`[Migration] ${filesToMigrate.length} files to migrate (limit: ${limit})`);
        
        for (const file of filesToMigrate) {
          try {
            if (dryRun) {
              console.log(`[DRY RUN] Would migrate: ${file.file_name}`);
              continue;
            }
            
            // Download file
            const response = await fetch(file.file_url);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const contentType = response.headers.get('content-type') || 'application/octet-stream';
            
            // Upload to Supabase
            const folderPath = file.folder_id || 'root';
            const sanitizedName = file.file_name
              .replace(/[^a-zA-Z0-9._-]/g, '_')
              .substring(0, 200);
            const storagePath = `${folderPath}/${file.id}-${sanitizedName}`;
            
            const { error: uploadError } = await supabase.storage
              .from(BUCKET_NAME)
              .upload(storagePath, Buffer.from(arrayBuffer), {
                contentType,
                cacheControl: '3600',
                upsert: true
              });
            
            if (uploadError) {
              throw uploadError;
            }
            
            // Get public URL
            const { data: publicUrlData } = supabase.storage
              .from(BUCKET_NAME)
              .getPublicUrl(storagePath);
            
            // Update database record
            await supabase
              .from('file_repository')
              .update({ file_url: publicUrlData.publicUrl })
              .eq('id', file.id);
            
            progress.migratedIds.push(file.id);
            console.log(`✓ Migrated: ${file.file_name}`);
            
          } catch (error: any) {
            progress.failedIds.push({ id: file.id, error: error.message });
            console.error(`✗ Failed: ${file.file_name} - ${error.message}`);
          }
          
          saveMigrationProgress(progress);
        }
        
      } catch (error) {
        console.error('Migration error:', error);
      } finally {
        progress.isRunning = false;
        saveMigrationProgress(progress);
      }
    })();
  });
  
  // Reset migration progress (for retrying failed files)
  app.post('/api/file-migration/reset', async (req: Request, res: Response) => {
    const { resetFailed = true, resetAll = false } = req.body;
    
    const progress = loadMigrationProgress();
    
    if (resetAll) {
      progress.migratedIds = [];
      progress.failedIds = [];
    } else if (resetFailed) {
      progress.failedIds = [];
    }
    
    progress.isRunning = false;
    saveMigrationProgress(progress);
    
    res.json({ 
      message: resetAll ? 'All progress reset' : 'Failed files reset',
      progress 
    });
  });

  // ============ Integration Routes ============
  
  // File upload endpoint
  const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
  });
  
  const STORAGE_BUCKET = 'file-repository';
  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB in bytes
  
  // Sanitize filename for safe storage
  function sanitizeFileName(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 200);
  }
  
  app.post('/api/integrations/upload-file', upload.single('file'), async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: 'No file provided' });
      }
      
      const isPrivate = req.body?.private === 'true';
      const sanitizedName = sanitizeFileName(file.originalname);
      const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const storagePath = `uploads/${uniqueId}-${sanitizedName}`;
      
      // Upload to Supabase Storage
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600',
          upsert: false
        });
      
      if (error) {
        console.error('Supabase upload error:', error);
        return res.status(500).json({ error: 'Failed to upload file: ' + error.message });
      }
      
      // Get public URL
      const { data: publicUrlData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);
      
      res.json({ 
        file_url: publicUrlData.publicUrl,
        file_name: file.originalname,
        file_size: file.size,
        mime_type: file.mimetype
      });
    } catch (error: any) {
      console.error('File upload error:', error);
      res.status(500).json({ error: 'Upload failed: ' + (error.message || 'Unknown error') });
    }
  });
  
  // Create signed upload URL for direct browser uploads with progress tracking
  app.post('/api/integrations/signed-upload-url', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { fileName, fileSize, mimeType } = req.body;
      
      if (!fileName) {
        return res.status(400).json({ error: 'fileName is required' });
      }
      
      if (!fileSize || typeof fileSize !== 'number') {
        return res.status(400).json({ error: 'fileSize is required and must be a number' });
      }
      
      if (fileSize > MAX_FILE_SIZE) {
        return res.status(400).json({ 
          error: `File size exceeds maximum allowed size of 25MB`,
          maxSize: MAX_FILE_SIZE,
          providedSize: fileSize
        });
      }
      
      const sanitizedName = sanitizeFileName(fileName);
      const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const storagePath = `uploads/${uniqueId}-${sanitizedName}`;
      
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(storagePath);
      
      if (error) {
        console.error('Supabase signed URL error:', error);
        return res.status(500).json({ error: 'Failed to generate upload URL: ' + error.message });
      }
      
      const { data: publicUrlData } = supabase.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(storagePath);
      
      res.json({
        signedUrl: data.signedUrl,
        token: data.token,
        path: storagePath,
        publicUrl: publicUrlData.publicUrl,
        expiresIn: 3600
      });
    } catch (error: any) {
      console.error('Signed URL generation error:', error);
      res.status(500).json({ error: 'Failed to generate upload URL: ' + (error.message || 'Unknown error') });
    }
  });
  
  // Create signed URL for private files
  app.post('/api/integrations/create-signed-url', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { file_url } = req.body;
      if (!file_url) {
        return res.status(400).json({ error: 'file_url is required' });
      }
      
      // Extract storage path from URL
      const urlObj = new URL(file_url);
      const pathParts = urlObj.pathname.split('/storage/v1/object/public/');
      if (pathParts.length < 2) {
        return res.status(400).json({ error: 'Invalid file URL format' });
      }
      
      const [bucket, ...pathSegments] = pathParts[1].split('/');
      const storagePath = pathSegments.join('/');
      
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(storagePath, 3600); // 1 hour expiry
      
      if (error) {
        console.error('Signed URL error:', error);
        return res.status(500).json({ error: 'Failed to create signed URL: ' + error.message });
      }
      
      res.json({ signed_url: data.signedUrl });
    } catch (error: any) {
      console.error('Signed URL error:', error);
      res.status(500).json({ error: 'Failed to create signed URL: ' + (error.message || 'Unknown error') });
    }
  });

  // ============ LLM Integration API ============
  
  // Initialize OpenAI client lazily
  let openaiClient: OpenAI | null = null;
  
  function getOpenAIClient(): OpenAI | null {
    if (openaiClient) return openaiClient;
    
    // Check for Replit AI Integrations first (development), then fall back to direct API key (production)
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    
    if (!apiKey) {
      console.warn('[LLM] No OpenAI API key configured');
      return null;
    }
    
    openaiClient = new OpenAI({
      apiKey,
      ...(baseURL && { baseURL })
    });
    
    return openaiClient;
  }
  
  // LLM invocation endpoint for content moderation and other AI features
  // Note: This endpoint is used for comment moderation which allows public users to comment
  // We use rate limiting by IP instead of requiring authentication
  const llmRateLimits = new Map<string, { count: number; resetTime: number }>();
  const LLM_RATE_LIMIT = 10; // Max requests per window
  const LLM_RATE_WINDOW = 60000; // 1 minute window
  
  app.post('/api/integrations/invoke-llm', async (req: Request, res: Response) => {
    try {
      // Rate limiting by IP address
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      const now = Date.now();
      const rateData = llmRateLimits.get(clientIp);
      
      if (rateData) {
        if (now < rateData.resetTime) {
          if (rateData.count >= LLM_RATE_LIMIT) {
            return res.status(429).json({ 
              error: 'Too many requests. Please try again later.',
              is_safe: true // Allow comment to proceed without moderation if rate limited
            });
          }
          rateData.count++;
        } else {
          llmRateLimits.set(clientIp, { count: 1, resetTime: now + LLM_RATE_WINDOW });
        }
      } else {
        llmRateLimits.set(clientIp, { count: 1, resetTime: now + LLM_RATE_WINDOW });
      }
      
      // Clean up old rate limit entries periodically
      if (llmRateLimits.size > 1000) {
        for (const [ip, data] of llmRateLimits.entries()) {
          if (now > data.resetTime) {
            llmRateLimits.delete(ip);
          }
        }
      }
      
      const client = getOpenAIClient();
      
      if (!client) {
        // If LLM not configured, allow comments through without moderation
        console.warn('[LLM] No API key configured, skipping moderation');
        return res.json({ 
          is_safe: true,
          reason: '',
          warning: 'Content moderation unavailable'
        });
      }
      
      const { prompt, response_json_schema } = req.body;
      
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt is required and must be a string' });
      }
      
      // Limit prompt length for safety
      if (prompt.length > 10000) {
        return res.status(400).json({ error: 'prompt exceeds maximum length of 10000 characters' });
      }
      
      // Build messages for chat completion
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'user', content: prompt }
      ];
      
      // Call OpenAI with optional JSON schema response
      const completionParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: 'gpt-4o-mini',
        messages,
        max_completion_tokens: 1024,
      };
      
      // Add response format if JSON schema is provided
      if (response_json_schema) {
        completionParams.response_format = { type: 'json_object' };
      }
      
      const completion = await client.chat.completions.create(completionParams);
      
      const responseContent = completion.choices[0]?.message?.content || '';
      
      // If JSON response was requested, parse it
      if (response_json_schema) {
        try {
          const jsonResponse = JSON.parse(responseContent);
          return res.json(jsonResponse);
        } catch (parseError) {
          console.error('[LLM] Failed to parse JSON response:', responseContent);
          return res.json({ response: responseContent });
        }
      }
      
      res.json({ response: responseContent });
    } catch (error: any) {
      console.error('[LLM] Error invoking LLM:', error);
      
      // Handle rate limiting
      if (error.status === 429) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      }
      
      res.status(500).json({ 
        error: 'Failed to invoke LLM: ' + (error.message || 'Unknown error') 
      });
    }
  });

  // ============ Zoom Webinar API ============
  
  // Zoom Server-to-Server OAuth token cache
  let zoomTokenCache: { token: string; expiresAt: number } | null = null;
  
  // Get Zoom access token using Server-to-Server OAuth
  async function getZoomAccessToken(): Promise<string> {
    // Check cache
    if (zoomTokenCache && Date.now() < zoomTokenCache.expiresAt - 60000) {
      return zoomTokenCache.token;
    }
    
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    
    if (!accountId || !clientId || !clientSecret) {
      throw new Error('Zoom credentials not configured');
    }
    
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    
    const response = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=account_credentials&account_id=${accountId}`
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Zoom] Token error:', errorText);
      throw new Error(`Failed to get Zoom access token: ${response.status}`);
    }
    
    const data = await response.json() as { access_token: string; expires_in: number };
    
    // Cache the token
    zoomTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };
    
    console.log('[Zoom] Access token obtained successfully');
    return data.access_token;
  }

  // Helper function to check if an event is a Zoom event (has Zoom URL in location)
  function isZoomEvent(event: any): boolean {
    if (!event.location) return false;
    const location = event.location.toLowerCase();
    // Check for Zoom URLs in the location field
    return location.includes('zoom.us') || 
           (location.startsWith('online') && (location.includes('zoom.us') || location.includes('zoom')));
  }

  // Helper function to extract Zoom URL from event location
  function extractZoomUrlFromLocation(location: string): string | null {
    if (!location) return null;
    const urlMatch = location.match(/https?:\/\/[^\s]+zoom[^\s]*/i);
    return urlMatch ? urlMatch[0] : null;
  }

  // Helper function to find a webinar by matching its join_url with the event location
  async function findWebinarByEventLocation(eventLocation: string): Promise<any | null> {
    if (!supabase || !eventLocation) return null;
    
    const zoomUrl = extractZoomUrlFromLocation(eventLocation);
    if (!zoomUrl) return null;
    
    console.log('[Zoom] Looking for webinar with join_url matching:', zoomUrl);
    
    // Fetch all webinars and find one with matching join_url
    const { data: webinars, error } = await supabase
      .from('zoom_webinar')
      .select('*')
      .eq('status', 'scheduled');
    
    if (error || !webinars) {
      console.error('[Zoom] Error fetching webinars:', error);
      return null;
    }
    
    // Match by join_url (the URL in location might be slightly different, so we normalize)
    const normalizeUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    const normalizedZoomUrl = normalizeUrl(zoomUrl);
    
    const matchingWebinar = webinars.find((w: any) => {
      if (!w.join_url) return false;
      const normalizedJoinUrl = normalizeUrl(w.join_url);
      return normalizedZoomUrl.includes(normalizedJoinUrl) || normalizedJoinUrl.includes(normalizedZoomUrl);
    });
    
    if (matchingWebinar) {
      console.log('[Zoom] Found matching webinar:', matchingWebinar.id, matchingWebinar.topic);
    } else {
      console.log('[Zoom] No matching webinar found for URL:', zoomUrl);
    }
    
    return matchingWebinar || null;
  }

  // Helper function to register an attendee with a Zoom webinar
  async function registerAttendeeWithZoom(
    webinar: any,
    attendee: { email: string; first_name: string; last_name: string }
  ): Promise<{ success: boolean; registrant_id?: string; error?: string }> {
    try {
      if (!webinar.zoom_webinar_id) {
        return { success: false, error: 'Webinar not synced with Zoom' };
      }
      
      if (!webinar.registration_required) {
        // No registration needed, treat as success but without registrant_id
        console.log(`[Zoom] Registration not required for webinar ${webinar.zoom_webinar_id}, skipping registration`);
        return { success: true };
      }
      
      // Validate webinar is upcoming
      if (new Date(webinar.start_time) <= new Date()) {
        return { success: false, error: 'Webinar has already started or ended' };
      }
      
      const token = await getZoomAccessToken();
      
      console.log(`[Zoom] Registering ${attendee.email} for webinar ${webinar.zoom_webinar_id}`);
      
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            first_name: attendee.first_name,
            last_name: attendee.last_name,
            email: attendee.email,
            auto_approve: true
          })
        }
      );
      
      if (!zoomResponse.ok) {
        const errorData = await zoomResponse.json().catch(() => ({}));
        console.error(`[Zoom] Registration error for ${attendee.email}:`, errorData);
        
        // Handle duplicate registration gracefully
        if (errorData.code === 3027) {
          console.log(`[Zoom] ${attendee.email} is already registered, treating as success`);
          return { success: true, error: 'Already registered' };
        }
        
        return { success: false, error: errorData.message || 'Failed to register with Zoom' };
      }
      
      const zoomData = await zoomResponse.json();
      console.log(`[Zoom] ✓ Successfully registered ${attendee.email}, registrant_id: ${zoomData.registrant_id}`);
      
      return { success: true, registrant_id: zoomData.registrant_id };
    } catch (error: any) {
      console.error(`[Zoom] Registration failed for ${attendee.email}:`, error);
      return { success: false, error: error.message || 'Zoom registration failed' };
    }
  }
  
  // Get Zoom users (hosts)
  app.get('/api/zoom/users', async (req: Request, res: Response) => {
    try {
      const token = await getZoomAccessToken();
      
      const response = await fetch('https://api.zoom.us/v2/users?status=active', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Zoom] Users API error:', errorText);
        return res.status(response.status).json({ error: 'Failed to fetch Zoom users' });
      }
      
      const data = await response.json() as { users: any[] };
      res.json(data.users || []);
    } catch (error: any) {
      console.error('[Zoom] Users error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch Zoom users' });
    }
  });
  
  // Check for scheduling conflicts
  app.post('/api/zoom/check-conflicts', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { start_time, duration_minutes, host_id, exclude_webinar_id } = req.body;
      
      if (!start_time || !duration_minutes) {
        return res.status(400).json({ error: 'start_time and duration_minutes are required' });
      }
      
      const startDate = new Date(start_time);
      const endDate = new Date(startDate.getTime() + duration_minutes * 60 * 1000);
      
      // Check existing webinars in our database
      let query = supabase
        .from('zoom_webinar')
        .select('*')
        .neq('status', 'cancelled');
      
      if (exclude_webinar_id) {
        query = query.neq('id', exclude_webinar_id);
      }
      
      if (host_id) {
        query = query.eq('zoom_host_id', host_id);
      }
      
      const { data: webinars, error } = await query;
      
      if (error) {
        console.error('[Zoom] Conflict check DB error:', error);
        return res.status(500).json({ error: 'Failed to check conflicts' });
      }
      
      // Find overlapping webinars
      const conflicts = (webinars || []).filter((w: any) => {
        const wStart = new Date(w.start_time);
        const wEnd = new Date(wStart.getTime() + w.duration_minutes * 60 * 1000);
        
        // Check for overlap: starts before other ends AND ends after other starts
        return startDate < wEnd && endDate > wStart;
      });
      
      res.json({
        hasConflicts: conflicts.length > 0,
        conflicts: conflicts.map((c: any) => ({
          id: c.id,
          topic: c.topic,
          start_time: c.start_time,
          duration_minutes: c.duration_minutes,
          zoom_webinar_id: c.zoom_webinar_id
        }))
      });
    } catch (error: any) {
      console.error('[Zoom] Conflict check error:', error);
      res.status(500).json({ error: error.message || 'Failed to check conflicts' });
    }
  });
  
  // Create a new webinar
  app.post('/api/zoom/webinars', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { 
        topic, 
        agenda, 
        start_time, 
        duration_minutes = 60, 
        timezone = 'Europe/London',
        registration_required = false,
        host_id,
        panelists = [],
        created_by_member_id
      } = req.body;
      
      if (!topic || !start_time) {
        return res.status(400).json({ error: 'topic and start_time are required' });
      }
      
      const token = await getZoomAccessToken();
      
      // Determine which user to create webinar for
      let userId = host_id || 'me';
      
      // Create webinar on Zoom
      // Note: We pass start_time as local time (without Z suffix) so Zoom applies the timezone correctly
      // The frontend sends time as "YYYY-MM-DDTHH:MM:SS" and we pass it directly to let Zoom use the timezone field
      const webinarPayload = {
        topic,
        type: 5, // Scheduled webinar
        start_time: start_time,
        duration: duration_minutes,
        timezone,
        agenda: agenda || '',
        settings: {
          host_video: true,
          panelists_video: true,
          practice_session: true,
          hd_video: true,
          approval_type: registration_required ? 0 : 2, // 0 = auto approve, 2 = no registration
          registration_type: registration_required ? 1 : undefined,
          audio: 'both',
          auto_recording: 'cloud',
          enforce_login: false,
          close_registration: false,
          show_share_button: true,
          allow_multiple_devices: true,
          on_demand: true // Allow on-demand viewing after
        }
      };
      
      console.log('[Zoom] Creating webinar:', JSON.stringify(webinarPayload, null, 2));
      
      const zoomResponse = await fetch(`https://api.zoom.us/v2/users/${userId}/webinars`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(webinarPayload)
      });
      
      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Zoom] Create webinar error:', errorText);
        return res.status(zoomResponse.status).json({ 
          error: 'Failed to create Zoom webinar', 
          details: errorText 
        });
      }
      
      const zoomData = await zoomResponse.json() as {
        id: number;
        host_id: string;
        join_url: string;
        registration_url?: string;
        password: string;
      };
      
      console.log('[Zoom] Webinar created:', zoomData.id);
      
      // Save to our database
      const { data: webinar, error: dbError } = await supabase
        .from('zoom_webinar')
        .insert({
          topic,
          agenda,
          start_time,
          duration_minutes,
          timezone,
          registration_required,
          zoom_webinar_id: String(zoomData.id),
          zoom_host_id: zoomData.host_id,
          join_url: zoomData.join_url,
          registration_url: zoomData.registration_url,
          password: zoomData.password,
          status: 'scheduled',
          created_by_member_id
        })
        .select()
        .single();
      
      if (dbError) {
        console.error('[Zoom] DB save error:', dbError);
        return res.status(500).json({ error: 'Webinar created on Zoom but failed to save locally' });
      }
      
      // Add panelists if provided
      if (panelists.length > 0) {
        const panelistResults = [];
        
        for (const panelist of panelists) {
          try {
            // Add panelist to Zoom
            const panelistResponse = await fetch(
              `https://api.zoom.us/v2/webinars/${zoomData.id}/panelists`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  panelists: [{
                    name: panelist.name,
                    email: panelist.email
                  }]
                })
              }
            );
            
            if (panelistResponse.ok) {
              const panelistData = await panelistResponse.json() as { id?: string };
              
              // Save panelist to our database
              const { data: savedPanelist } = await supabase
                .from('zoom_webinar_panelist')
                .insert({
                  webinar_id: webinar.id,
                  name: panelist.name,
                  email: panelist.email,
                  role: panelist.role || 'panelist',
                  zoom_panelist_id: panelistData.id,
                  status: 'invited'
                })
                .select()
                .single();
              
              panelistResults.push({ success: true, panelist: savedPanelist });
            } else {
              const errorText = await panelistResponse.text();
              console.error('[Zoom] Panelist add error:', errorText);
              panelistResults.push({ success: false, email: panelist.email, error: errorText });
            }
          } catch (pError: any) {
            console.error('[Zoom] Panelist error:', pError);
            panelistResults.push({ success: false, email: panelist.email, error: pError.message });
          }
        }
        
        res.json({ 
          success: true, 
          webinar, 
          panelistResults 
        });
      } else {
        res.json({ success: true, webinar });
      }
    } catch (error: any) {
      console.error('[Zoom] Create webinar error:', error);
      res.status(500).json({ error: error.message || 'Failed to create webinar' });
    }
  });
  
  // List webinars from our database
  app.get('/api/zoom/webinars', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { status, upcoming } = req.query;
      
      let query = supabase
        .from('zoom_webinar')
        .select('*')
        .order('start_time', { ascending: true });
      
      if (status) {
        query = query.eq('status', status);
      }
      
      if (upcoming === 'true') {
        query = query.gte('start_time', new Date().toISOString());
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error('[Zoom] List webinars error:', error);
        return res.status(500).json({ error: 'Failed to list webinars' });
      }
      
      res.json(data || []);
    } catch (error: any) {
      console.error('[Zoom] List webinars error:', error);
      res.status(500).json({ error: error.message || 'Failed to list webinars' });
    }
  });
  
  // Get single webinar with panelists
  app.get('/api/zoom/webinars/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      
      // Get webinar
      const { data: webinar, error: webinarError } = await supabase
        .from('zoom_webinar')
        .select('*')
        .eq('id', id)
        .single();
      
      if (webinarError) {
        if (webinarError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Webinar not found' });
        }
        return res.status(500).json({ error: webinarError.message });
      }
      
      // Get panelists
      const { data: panelists } = await supabase
        .from('zoom_webinar_panelist')
        .select('*')
        .eq('webinar_id', id)
        .order('created_at', { ascending: true });
      
      res.json({ ...webinar, panelists: panelists || [] });
    } catch (error: any) {
      console.error('[Zoom] Get webinar error:', error);
      res.status(500).json({ error: error.message || 'Failed to get webinar' });
    }
  });
  
  // Update webinar
  app.patch('/api/zoom/webinars/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      const updates = req.body;
      
      // Get current webinar to get Zoom ID
      const { data: existing, error: fetchError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      // If updating Zoom-related fields, update on Zoom first
      if (updates.topic || updates.start_time || updates.duration_minutes || updates.agenda || updates.timezone) {
        const token = await getZoomAccessToken();
        
        const zoomUpdates: any = {};
        if (updates.topic) zoomUpdates.topic = updates.topic;
        if (updates.start_time) zoomUpdates.start_time = updates.start_time;
        if (updates.duration_minutes) zoomUpdates.duration = updates.duration_minutes;
        if (updates.agenda) zoomUpdates.agenda = updates.agenda;
        if (updates.timezone) zoomUpdates.timezone = updates.timezone;
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/webinars/${existing.zoom_webinar_id}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(zoomUpdates)
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Update webinar error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to update Zoom webinar' });
        }
      }
      
      // Update in our database
      const { data: webinar, error: updateError } = await supabase
        .from('zoom_webinar')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to update webinar' });
      }
      
      res.json(webinar);
    } catch (error: any) {
      console.error('[Zoom] Update webinar error:', error);
      res.status(500).json({ error: error.message || 'Failed to update webinar' });
    }
  });
  
  // Cancel/delete webinar
  app.delete('/api/zoom/webinars/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      const { deleteFromZoom = true } = req.query;
      
      // Get webinar
      const { data: webinar, error: fetchError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      // Delete from Zoom if requested
      if (deleteFromZoom === 'true' && webinar.zoom_webinar_id) {
        const token = await getZoomAccessToken();
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204 && zoomResponse.status !== 404) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Delete webinar error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to delete from Zoom' });
        }
      }
      
      // Update status in our database (soft delete)
      const { error: updateError } = await supabase
        .from('zoom_webinar')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id);
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to cancel webinar' });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Zoom] Delete webinar error:', error);
      res.status(500).json({ error: error.message || 'Failed to delete webinar' });
    }
  });
  
  // Add panelist to existing webinar
  app.post('/api/zoom/webinars/:id/panelists', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      const { name, email, role = 'panelist' } = req.body;
      
      if (!name || !email) {
        return res.status(400).json({ error: 'name and email are required' });
      }
      
      // Get webinar
      const { data: webinar, error: fetchError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id, status, start_time')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      // Validate webinar is scheduled and upcoming
      if (webinar.status !== 'scheduled') {
        return res.status(400).json({ error: 'Can only add panelists to scheduled webinars' });
      }
      
      if (new Date(webinar.start_time) <= new Date()) {
        return res.status(400).json({ error: 'Can only add panelists to upcoming webinars' });
      }
      
      const token = await getZoomAccessToken();
      
      // Add to Zoom
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/panelists`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            panelists: [{ name, email }]
          })
        }
      );
      
      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Zoom] Add panelist error:', errorText);
        return res.status(zoomResponse.status).json({ error: 'Failed to add panelist to Zoom' });
      }
      
      const zoomData = await zoomResponse.json() as { id?: string };
      
      // Save to database
      const { data: panelist, error: dbError } = await supabase
        .from('zoom_webinar_panelist')
        .insert({
          webinar_id: id,
          name,
          email,
          role,
          zoom_panelist_id: zoomData.id,
          status: 'invited'
        })
        .select()
        .single();
      
      if (dbError) {
        console.error('[Zoom] DB save panelist error:', dbError);
        return res.status(500).json({ error: 'Panelist added to Zoom but failed to save locally' });
      }
      
      res.json(panelist);
    } catch (error: any) {
      console.error('[Zoom] Add panelist error:', error);
      res.status(500).json({ error: error.message || 'Failed to add panelist' });
    }
  });
  
  // Remove panelist from webinar
  app.delete('/api/zoom/webinars/:webinarId/panelists/:panelistId', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { webinarId, panelistId } = req.params;
      
      // Get panelist and webinar info
      const { data: panelist, error: fetchError } = await supabase
        .from('zoom_webinar_panelist')
        .select('*, zoom_webinar!inner(zoom_webinar_id, status, start_time)')
        .eq('id', panelistId)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Panelist not found' });
      }
      
      // Validate webinar is scheduled and upcoming
      if (panelist.zoom_webinar.status !== 'scheduled') {
        return res.status(400).json({ error: 'Can only remove panelists from scheduled webinars' });
      }
      
      if (new Date(panelist.zoom_webinar.start_time) <= new Date()) {
        return res.status(400).json({ error: 'Can only remove panelists from upcoming webinars' });
      }
      
      // Remove from Zoom if we have the Zoom panelist ID
      if (panelist.zoom_panelist_id) {
        const token = await getZoomAccessToken();
        
        await fetch(
          `https://api.zoom.us/v2/webinars/${panelist.zoom_webinar.zoom_webinar_id}/panelists/${panelist.zoom_panelist_id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        // Ignore errors - panelist might already be removed from Zoom
      }
      
      // Remove from database
      const { error: deleteError } = await supabase
        .from('zoom_webinar_panelist')
        .delete()
        .eq('id', panelistId);
      
      if (deleteError) {
        console.error('[Zoom] DB delete panelist error:', deleteError);
        return res.status(500).json({ error: 'Failed to remove panelist' });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Zoom] Remove panelist error:', error);
      res.status(500).json({ error: error.message || 'Failed to remove panelist' });
    }
  });

  // Get webinar registrants from Zoom
  app.get('/api/zoom/webinars/:id/registrants', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      
      // Get webinar to get Zoom ID
      const { data: webinar, error: fetchError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id, registration_required')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      // If registration is not required, return empty list
      if (!webinar.registration_required) {
        return res.json({ registrants: [], total_records: 0 });
      }
      
      const token = await getZoomAccessToken();
      
      // Fetch registrants from Zoom
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants?page_size=100`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );
      
      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Zoom] Fetch registrants error:', errorText);
        return res.status(zoomResponse.status).json({ error: 'Failed to fetch registrants from Zoom' });
      }
      
      const data = await zoomResponse.json() as {
        registrants: Array<{
          id: string;
          email: string;
          first_name: string;
          last_name: string;
          status: string;
          create_time: string;
        }>;
        total_records: number;
      };
      
      res.json({
        registrants: data.registrants || [],
        total_records: data.total_records || 0
      });
    } catch (error: any) {
      console.error('[Zoom] Fetch registrants error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch registrants' });
    }
  });

  // Add registrant to webinar
  app.post('/api/zoom/webinars/:id/registrants', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      const { first_name, last_name, email } = req.body;
      
      if (!first_name || !last_name || !email) {
        return res.status(400).json({ error: 'First name, last name, and email are required' });
      }
      
      // Get webinar to get Zoom ID
      const { data: webinar, error: fetchError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id, registration_required, status, start_time')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Webinar not found' });
      }
      
      // Validate webinar is scheduled and upcoming
      if (webinar.status !== 'scheduled') {
        return res.status(400).json({ error: 'Can only add registrants to scheduled webinars' });
      }
      
      if (new Date(webinar.start_time) <= new Date()) {
        return res.status(400).json({ error: 'Can only add registrants to upcoming webinars' });
      }
      
      if (!webinar.registration_required) {
        return res.status(400).json({ error: 'Registration is not enabled for this webinar' });
      }
      
      if (!webinar.zoom_webinar_id) {
        return res.status(400).json({ error: 'Webinar not synced with Zoom' });
      }
      
      const token = await getZoomAccessToken();
      
      // Add registrant to Zoom
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            first_name,
            last_name,
            email,
            auto_approve: true
          })
        }
      );
      
      if (!zoomResponse.ok) {
        const errorData = await zoomResponse.json().catch(() => ({}));
        console.error('[Zoom] Add registrant error:', errorData);
        
        // Handle specific Zoom errors
        if (errorData.code === 3027) {
          return res.status(400).json({ error: 'This email is already registered for this webinar' });
        }
        
        return res.status(zoomResponse.status).json({ 
          error: errorData.message || 'Failed to add registrant to Zoom' 
        });
      }
      
      const zoomData = await zoomResponse.json();
      
      res.json({
        id: zoomData.id,
        registrant_id: zoomData.registrant_id,
        start_time: zoomData.start_time,
        topic: zoomData.topic,
        first_name,
        last_name,
        email,
        status: 'approved'
      });
    } catch (error: any) {
      console.error('[Zoom] Add registrant error:', error);
      res.status(500).json({ error: error.message || 'Failed to add registrant' });
    }
  });

  // Get personalized join link for a registered attendee
  app.get('/api/zoom/webinars/:id/my-join-link', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      const email = req.query.email as string;
      
      if (!email) {
        return res.status(400).json({ error: 'Email parameter is required' });
      }
      
      // Get webinar details
      const { data: webinar, error: webinarError } = await supabase
        .from('zoom_webinar')
        .select('zoom_webinar_id, registration_required')
        .eq('id', id)
        .single();
      
      if (webinarError) {
        if (webinarError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Webinar not found' });
        }
        return res.status(500).json({ error: webinarError.message });
      }
      
      if (!webinar.registration_required || !webinar.zoom_webinar_id) {
        return res.json({ join_url: null, message: 'Registration not required for this webinar' });
      }
      
      const accessToken = await getZoomAccessToken();
      
      // Fetch registrants from Zoom
      const zoomResponse = await fetch(
        `https://api.zoom.us/v2/webinars/${webinar.zoom_webinar_id}/registrants?page_size=300&status=approved`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Zoom] Fetch registrants error:', errorText);
        return res.status(zoomResponse.status).json({ error: 'Failed to fetch registrants from Zoom' });
      }
      
      const data = await zoomResponse.json() as {
        registrants: Array<{
          id: string;
          email: string;
          join_url: string;
          status: string;
        }>;
      };
      
      const registrants = data.registrants || [];
      
      // Find the registrant with matching email (case-insensitive)
      const matchingRegistrant = registrants.find(
        r => r.email.toLowerCase() === email.toLowerCase()
      );
      
      if (!matchingRegistrant) {
        return res.json({ join_url: null, message: 'User not registered for this webinar' });
      }
      
      res.json({
        join_url: matchingRegistrant.join_url,
        registrant_id: matchingRegistrant.id,
        status: matchingRegistrant.status
      });
    } catch (error: any) {
      console.error('[Zoom] Fetch join link error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch join link' });
    }
  });

  // ============ Zoom Meetings API ============
  
  // Create a new meeting
  app.post('/api/zoom/meetings', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { 
        topic, 
        agenda, 
        start_time, 
        duration_minutes = 60, 
        timezone = 'Europe/London',
        host_id,
        waiting_room = true,
        join_before_host = false,
        mute_upon_entry = true,
        created_by_member_id
      } = req.body;
      
      if (!topic || !start_time) {
        return res.status(400).json({ error: 'topic and start_time are required' });
      }
      
      const token = await getZoomAccessToken();
      
      // Determine which user to create meeting for
      let userId = host_id || 'me';
      
      // Create meeting on Zoom
      const meetingPayload = {
        topic,
        type: 2, // Scheduled meeting
        start_time: start_time,
        duration: duration_minutes,
        timezone,
        agenda: agenda || '',
        settings: {
          host_video: true,
          participant_video: true,
          join_before_host: join_before_host,
          mute_upon_entry: mute_upon_entry,
          waiting_room: waiting_room,
          audio: 'both',
          auto_recording: 'cloud'
        }
      };
      
      console.log('[Zoom] Creating meeting:', JSON.stringify(meetingPayload, null, 2));
      
      const zoomResponse = await fetch(`https://api.zoom.us/v2/users/${userId}/meetings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(meetingPayload)
      });
      
      if (!zoomResponse.ok) {
        const errorText = await zoomResponse.text();
        console.error('[Zoom] Create meeting error:', errorText);
        return res.status(zoomResponse.status).json({ 
          error: 'Failed to create Zoom meeting', 
          details: errorText 
        });
      }
      
      const zoomData = await zoomResponse.json() as {
        id: number;
        host_id: string;
        join_url: string;
        password: string;
        start_url: string;
      };
      
      console.log('[Zoom] Meeting created:', zoomData.id);
      
      // Save to our database
      const { data: meeting, error: dbError } = await supabase
        .from('zoom_meeting')
        .insert({
          topic,
          agenda,
          start_time,
          duration_minutes,
          timezone,
          waiting_room,
          join_before_host,
          mute_upon_entry,
          zoom_meeting_id: String(zoomData.id),
          zoom_host_id: zoomData.host_id,
          join_url: zoomData.join_url,
          start_url: zoomData.start_url,
          password: zoomData.password,
          status: 'scheduled',
          created_by_member_id
        })
        .select()
        .single();
      
      if (dbError) {
        console.error('[Zoom] DB save error:', dbError);
        return res.status(500).json({ error: 'Meeting created on Zoom but failed to save locally' });
      }
      
      res.json({ success: true, meeting });
    } catch (error: any) {
      console.error('[Zoom] Create meeting error:', error);
      res.status(500).json({ error: error.message || 'Failed to create meeting' });
    }
  });
  
  // List meetings from our database
  app.get('/api/zoom/meetings', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { status, upcoming } = req.query;
      
      let query = supabase
        .from('zoom_meeting')
        .select('*')
        .order('start_time', { ascending: true });
      
      if (status) {
        query = query.eq('status', status);
      }
      
      if (upcoming === 'true') {
        query = query.gte('start_time', new Date().toISOString());
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error('[Zoom] List meetings error:', error);
        return res.status(500).json({ error: 'Failed to list meetings' });
      }
      
      res.json(data || []);
    } catch (error: any) {
      console.error('[Zoom] List meetings error:', error);
      res.status(500).json({ error: error.message || 'Failed to list meetings' });
    }
  });
  
  // Get single meeting
  app.get('/api/zoom/meetings/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      
      const { data: meeting, error: meetingError } = await supabase
        .from('zoom_meeting')
        .select('*')
        .eq('id', id)
        .single();
      
      if (meetingError) {
        if (meetingError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Meeting not found' });
        }
        return res.status(500).json({ error: meetingError.message });
      }
      
      res.json(meeting);
    } catch (error: any) {
      console.error('[Zoom] Get meeting error:', error);
      res.status(500).json({ error: error.message || 'Failed to get meeting' });
    }
  });
  
  // Update meeting
  app.patch('/api/zoom/meetings/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      const updates = req.body;
      
      // Get current meeting to get Zoom ID
      const { data: existing, error: fetchError } = await supabase
        .from('zoom_meeting')
        .select('zoom_meeting_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Meeting not found' });
      }
      
      // If updating Zoom-related fields, update on Zoom first
      if (updates.topic || updates.start_time || updates.duration_minutes || updates.agenda || updates.timezone) {
        const token = await getZoomAccessToken();
        
        const zoomUpdates: any = {};
        if (updates.topic) zoomUpdates.topic = updates.topic;
        if (updates.start_time) zoomUpdates.start_time = updates.start_time;
        if (updates.duration_minutes) zoomUpdates.duration = updates.duration_minutes;
        if (updates.agenda) zoomUpdates.agenda = updates.agenda;
        if (updates.timezone) zoomUpdates.timezone = updates.timezone;
        
        // Settings updates
        if (updates.waiting_room !== undefined || updates.join_before_host !== undefined || updates.mute_upon_entry !== undefined) {
          zoomUpdates.settings = {};
          if (updates.waiting_room !== undefined) zoomUpdates.settings.waiting_room = updates.waiting_room;
          if (updates.join_before_host !== undefined) zoomUpdates.settings.join_before_host = updates.join_before_host;
          if (updates.mute_upon_entry !== undefined) zoomUpdates.settings.mute_upon_entry = updates.mute_upon_entry;
        }
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${existing.zoom_meeting_id}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(zoomUpdates)
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Update meeting error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to update Zoom meeting' });
        }
      }
      
      // Update in our database
      const { data: meeting, error: updateError } = await supabase
        .from('zoom_meeting')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to update meeting' });
      }
      
      res.json(meeting);
    } catch (error: any) {
      console.error('[Zoom] Update meeting error:', error);
      res.status(500).json({ error: error.message || 'Failed to update meeting' });
    }
  });
  
  // Cancel/delete meeting
  app.delete('/api/zoom/meetings/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    
    try {
      const { id } = req.params;
      const { deleteFromZoom = true } = req.query;
      
      // Get meeting
      const { data: meeting, error: fetchError } = await supabase
        .from('zoom_meeting')
        .select('zoom_meeting_id')
        .eq('id', id)
        .single();
      
      if (fetchError) {
        return res.status(404).json({ error: 'Meeting not found' });
      }
      
      // Delete from Zoom if requested
      if (deleteFromZoom === 'true' && meeting.zoom_meeting_id) {
        const token = await getZoomAccessToken();
        
        const zoomResponse = await fetch(
          `https://api.zoom.us/v2/meetings/${meeting.zoom_meeting_id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        if (!zoomResponse.ok && zoomResponse.status !== 204 && zoomResponse.status !== 404) {
          const errorText = await zoomResponse.text();
          console.error('[Zoom] Delete meeting error:', errorText);
          return res.status(zoomResponse.status).json({ error: 'Failed to delete from Zoom' });
        }
      }
      
      // Update status in our database (soft delete)
      const { error: updateError } = await supabase
        .from('zoom_meeting')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id);
      
      if (updateError) {
        console.error('[Zoom] DB update error:', updateError);
        return res.status(500).json({ error: 'Failed to cancel meeting' });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Zoom] Delete meeting error:', error);
      res.status(500).json({ error: error.message || 'Failed to delete meeting' });
    }
  });

  // ============ CSV Import Manager ============
  
  // Core field definitions for Member and Organization
  const MEMBER_CORE_FIELDS = [
    { key: 'first_name', label: 'First Name', type: 'text' },
    { key: 'last_name', label: 'Last Name', type: 'text' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'mobile', label: 'Mobile', type: 'text' },
    { key: 'landline', label: 'Landline', type: 'text' },
    { key: 'job_title', label: 'Job Title', type: 'text' },
    { key: 'biography', label: 'Biography', type: 'text' },
    { key: 'organization_id', label: 'Organization ID', type: 'text' },
    { key: 'linkedin_url', label: 'LinkedIn URL', type: 'url' },
    { key: 'website_url', label: 'Website URL', type: 'url' },
    { key: 'show_in_directory', label: 'Show in Directory', type: 'boolean' },
    { key: 'login_enabled', label: 'Login Enabled', type: 'boolean' },
    { key: 'login_disabled_reason', label: 'Login Disabled Reason', type: 'text' },
    { key: 'external_id', label: 'External ID', type: 'text' },
    { key: 'profile_image_url', label: 'Profile Image URL', type: 'url' },
    { key: 'role_id', label: 'Role ID', type: 'text' },
    { key: 'role_effective_from', label: 'Effective From', type: 'date' },
  ];
  
  const ORGANIZATION_CORE_FIELDS = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'slug', label: 'Slug', type: 'text' },
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'website_url', label: 'Website', type: 'url' },
    { key: 'logo_url', label: 'Logo URL', type: 'url' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'text' },
    { key: 'address', label: 'Address', type: 'text' },
    { key: 'city', label: 'City', type: 'text' },
    { key: 'country', label: 'Country', type: 'text' },
    { key: 'postcode', label: 'Postcode', type: 'text' },
    { key: 'external_id', label: 'External ID', type: 'text' },
    { key: 'is_active', label: 'Is Active', type: 'boolean' },
    { key: 'created_at', label: 'Created At', type: 'date' },
    { key: 'twitter_url', label: 'Twitter URL', type: 'url' },
    { key: 'linkedin_url', label: 'LinkedIn URL', type: 'url' },
    { key: 'facebook_url', label: 'Facebook URL', type: 'url' },
    { key: 'instagram_url', label: 'Instagram URL', type: 'url' },
  ];
  
  // Get available fields for import mapping
  app.get('/api/imports/fields', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    
    try {
      const entityType = req.query.entity as string || 'member';
      console.log('[Import] /api/imports/fields called with entity:', entityType);
      
      // Get core fields
      const coreFields = entityType === 'organization' 
        ? ORGANIZATION_CORE_FIELDS 
        : MEMBER_CORE_FIELDS;
      
      // Get custom fields from PreferenceField
      const { data: customFields, error } = await supabase
        .from('preference_field')
        .select('id, name, label, field_type, entity_scope')
        .eq('entity_scope', entityType)
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      
      if (error) {
        console.error('[Import] Error fetching custom fields:', error);
      }
      
      // Fetch communication categories for member imports
      let communicationFields: any[] = [];
      if (entityType === 'member') {
        const { data: commCategories, error: commError } = await supabase
          .from('communication_category')
          .select('id, name, description')
          .eq('is_active', true)
          .order('display_order', { ascending: true });
        
        if (commError) {
          console.error('[Import] Error fetching communication categories:', commError);
        }
        
        communicationFields = (commCategories || []).map((c: any) => ({
          key: `comm:${c.id}`,
          label: c.name,
          description: c.description,
          type: 'boolean',
          scope: 'communication',
          categoryId: c.id
        }));
      }
      
      res.json({
        core: coreFields.map(f => ({ ...f, scope: 'core' })),
        custom: (customFields || []).map((f: any) => ({
          key: `custom:${f.id}`,
          label: f.label || f.name,
          type: f.field_type,
          scope: 'custom',
          preferenceFieldId: f.id
        })),
        communication: communicationFields
      });
    } catch (error: any) {
      console.error('[Import] Error getting fields:', error);
      res.status(500).json({ error: error.message || 'Failed to get fields' });
    }
  });
  
  // Parse CSV and return columns
  const csvUpload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
  });
  
  app.post('/api/imports/parse', csvUpload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      
      const { parse } = await import('csv-parse/sync');
      let csvContent = req.file.buffer.toString('utf-8');
      
      // Remove BOM if present
      if (csvContent.charCodeAt(0) === 0xFEFF) {
        csvContent = csvContent.slice(1);
      }
      
      // Auto-detect delimiter (semicolon or comma)
      const firstLine = csvContent.split('\n')[0] || '';
      const semicolonCount = (firstLine.match(/;/g) || []).length;
      const commaCount = (firstLine.match(/,/g) || []).length;
      const delimiter = semicolonCount > commaCount ? ';' : ',';
      
      // Parse CSV
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter,
        relax_quotes: true,
        relax_column_count: true
      }) as Record<string, string>[];
      
      if (records.length === 0) {
        return res.status(400).json({ error: 'CSV file is empty' });
      }
      
      // Get column headers
      const columns = Object.keys(records[0]);
      
      // Return columns and preview rows
      res.json({
        columns,
        rowCount: records.length,
        preview: records.slice(0, 5) // First 5 rows for preview
      });
    } catch (error: any) {
      console.error('[Import] CSV parse error:', error);
      res.status(400).json({ error: error.message || 'Failed to parse CSV' });
    }
  });
  
  // Preview import changes
  app.post('/api/imports/preview', csvUpload.single('file'), async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      
      const { entityType, identifierField, mappings } = req.body;
      const parsedMappings = typeof mappings === 'string' ? JSON.parse(mappings) : mappings;
      
      if (!entityType || !identifierField || !parsedMappings) {
        return res.status(400).json({ error: 'Missing required fields: entityType, identifierField, mappings' });
      }
      
      const { parse } = await import('csv-parse/sync');
      let csvContent = req.file.buffer.toString('utf-8');
      
      // Remove BOM if present
      if (csvContent.charCodeAt(0) === 0xFEFF) {
        csvContent = csvContent.slice(1);
      }
      
      // Auto-detect delimiter
      const firstLine = csvContent.split('\n')[0] || '';
      const semicolonCount = (firstLine.match(/;/g) || []).length;
      const commaCount = (firstLine.match(/,/g) || []).length;
      const delimiter = semicolonCount > commaCount ? ';' : ',';
      
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter,
        relax_quotes: true,
        relax_column_count: true
      }) as Record<string, string>[];
      
      // Find the identifier mapping
      const identifierMapping = parsedMappings.find((m: any) => m.targetField === identifierField);
      if (!identifierMapping) {
        return res.status(400).json({ error: `No mapping found for identifier field: ${identifierField}` });
      }
      
      const tableName = entityType === 'organization' ? 'organization' : 'member';
      let createCount = 0;
      let updateCount = 0;
      let skipCount = 0;
      const errors: any[] = [];
      
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const identifierValue = row[identifierMapping.sourceColumn]?.trim();
        
        if (!identifierValue) {
          skipCount++;
          continue;
        }
        
        // Check if record exists
        const { data: existing, error } = await supabase
          .from(tableName)
          .select('id')
          .eq(identifierField, identifierValue)
          .maybeSingle();
        
        if (error) {
          errors.push({ row: i + 2, message: error.message });
          continue;
        }
        
        if (existing) {
          updateCount++;
        } else {
          createCount++;
        }
      }
      
      res.json({
        totalRows: records.length,
        toCreate: createCount,
        toUpdate: updateCount,
        toSkip: skipCount,
        errors: errors.slice(0, 10) // First 10 errors
      });
    } catch (error: any) {
      console.error('[Import] Preview error:', error);
      res.status(500).json({ error: error.message || 'Failed to preview import' });
    }
  });
  
  // Execute import
  app.post('/api/imports/execute', csvUpload.single('file'), async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    
    const session = req.session as any;
    if (!session?.memberId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      
      const { entityType, identifierField, mappings } = req.body;
      const parsedMappings = typeof mappings === 'string' ? JSON.parse(mappings) : mappings;
      
      if (!entityType || !identifierField || !parsedMappings) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      const { parse } = await import('csv-parse/sync');
      let csvContent = req.file.buffer.toString('utf-8');
      
      // Remove BOM if present
      if (csvContent.charCodeAt(0) === 0xFEFF) {
        csvContent = csvContent.slice(1);
      }
      
      // Auto-detect delimiter
      const firstLine = csvContent.split('\n')[0] || '';
      const semicolonCount = (firstLine.match(/;/g) || []).length;
      const commaCount = (firstLine.match(/,/g) || []).length;
      const delimiter = semicolonCount > commaCount ? ';' : ',';
      
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter,
        relax_quotes: true,
        relax_column_count: true
      }) as Record<string, string>[];
      
      const tableName = entityType === 'organization' ? 'organization' : 'member';
      const customValueTable = entityType === 'organization' 
        ? 'organization_preference_value' 
        : 'member_preference_value';
      const entityIdField = entityType === 'organization' ? 'organization_id' : 'member_id';
      
      // Find identifier mapping
      const identifierMapping = parsedMappings.find((m: any) => m.targetField === identifierField);
      if (!identifierMapping) {
        return res.status(400).json({ error: `No mapping for identifier field: ${identifierField}` });
      }
      
      // Create import job record
      const { data: job, error: jobError } = await supabase
        .from('csv_import_job')
        .insert({
          entity_type: entityType,
          status: 'running',
          file_name: req.file.originalname,
          total_rows: records.length,
          created_by: session.memberId
        })
        .select()
        .single();
      
      if (jobError) {
        console.error('[Import] Failed to create job:', jobError);
        return res.status(500).json({ error: 'Failed to create import job' });
      }
      
      let processedRows = 0;
      let createdRows = 0;
      let updatedRows = 0;
      let skippedRows = 0;
      let errorRows = 0;
      const errorLog: any[] = [];
      
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const identifierValue = row[identifierMapping.sourceColumn]?.trim();
        
        if (!identifierValue) {
          skippedRows++;
          processedRows++;
          continue;
        }
        
        try {
          // Check if record exists
          const { data: existing, error: lookupError } = await supabase
            .from(tableName)
            .select('id')
            .eq(identifierField, identifierValue)
            .maybeSingle();
          
          if (lookupError) {
            throw new Error(`Lookup failed: ${lookupError.message}`);
          }
          
          // Build core field updates
          const coreUpdates: Record<string, any> = {};
          const customUpdates: { fieldId: string; value: any }[] = [];
          
          for (const mapping of parsedMappings) {
            const sourceValue = row[mapping.sourceColumn];
            const shouldClear = mapping.clearOnEmpty && (!sourceValue || sourceValue.trim() === '');
            const finalValue = shouldClear ? null : (sourceValue?.trim() || null);
            
            if (mapping.targetScope === 'core') {
              coreUpdates[mapping.targetField] = finalValue;
            } else if (mapping.targetScope === 'custom' && mapping.targetField) {
              customUpdates.push({ fieldId: mapping.targetField, value: finalValue });
            }
          }
          
          if (existing) {
            // Update existing record
            const { error: updateError } = await supabase
              .from(tableName)
              .update(coreUpdates)
              .eq('id', existing.id);
            
            if (updateError) {
              throw new Error(`Update failed: ${updateError.message}`);
            }
            
            // Handle custom field updates
            for (const cu of customUpdates) {
              const { data: existingValue } = await supabase
                .from(customValueTable)
                .select('id')
                .eq(entityIdField, existing.id)
                .eq('preference_field_id', cu.fieldId)
                .maybeSingle();
              
              if (existingValue) {
                await supabase
                  .from(customValueTable)
                  .update({ value: cu.value })
                  .eq('id', existingValue.id);
              } else if (cu.value !== null) {
                await supabase
                  .from(customValueTable)
                  .insert({
                    [entityIdField]: existing.id,
                    preference_field_id: cu.fieldId,
                    value: cu.value
                  });
              }
            }
            
            updatedRows++;
          } else {
            // Create new record
            const { data: newRecord, error: createError } = await supabase
              .from(tableName)
              .insert(coreUpdates)
              .select('id')
              .single();
            
            if (createError) {
              throw new Error(`Create failed: ${createError.message}`);
            }
            
            // Handle custom field inserts
            for (const cu of customUpdates) {
              if (cu.value !== null) {
                await supabase
                  .from(customValueTable)
                  .insert({
                    [entityIdField]: newRecord.id,
                    preference_field_id: cu.fieldId,
                    value: cu.value
                  });
              }
            }
            
            createdRows++;
          }
        } catch (rowError: any) {
          errorRows++;
          errorLog.push({ row: i + 2, message: rowError.message });
        }
        
        processedRows++;
        
        // Update job progress every 50 rows
        if (processedRows % 50 === 0) {
          await supabase
            .from('csv_import_job')
            .update({ processed_rows: processedRows })
            .eq('id', job.id);
        }
      }
      
      // Update job with final stats
      await supabase
        .from('csv_import_job')
        .update({
          status: errorRows > 0 ? 'completed_with_errors' : 'completed',
          processed_rows: processedRows,
          created_rows: createdRows,
          updated_rows: updatedRows,
          skipped_rows: skippedRows,
          error_rows: errorRows,
          error_log: errorLog.length > 0 ? errorLog : null,
          completed_at: new Date().toISOString()
        })
        .eq('id', job.id);
      
      res.json({
        jobId: job.id,
        totalRows: records.length,
        created: createdRows,
        updated: updatedRows,
        skipped: skippedRows,
        errors: errorRows,
        errorLog: errorLog.slice(0, 20)
      });
    } catch (error: any) {
      console.error('[Import] Execute error:', error);
      res.status(500).json({ error: error.message || 'Import failed' });
    }
  });
  
  // Get import job status
  app.get('/api/imports/jobs/:id', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    
    try {
      const { id } = req.params;
      
      const { data: job, error } = await supabase
        .from('csv_import_job')
        .select('*')
        .eq('id', id)
        .single();
      
      if (error || !job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      
      res.json(job);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to get job' });
    }
  });
  
  // Get recent import jobs
  app.get('/api/imports/jobs', async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    
    try {
      const entityType = req.query.entity as string;
      
      let query = supabase
        .from('csv_import_job')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      
      if (entityType) {
        query = query.eq('entity_type', entityType);
      }
      
      const { data: jobs, error } = await query;
      
      if (error) {
        // If table doesn't exist, return empty array (tables need to be created)
        if (error.message?.includes('Could not find the table') || 
            error.code === '42P01' || 
            error.message?.includes('relation') && error.message?.includes('does not exist')) {
          console.log('[Import] csv_import_job table does not exist yet - returning empty array');
          return res.json([]);
        }
        throw error;
      }
      
      res.json(jobs || []);
    } catch (error: any) {
      // Also handle table not found in catch block
      if (error.message?.includes('Could not find the table') || 
          error.message?.includes('relation') && error.message?.includes('does not exist')) {
        console.log('[Import] csv_import_job table does not exist yet - returning empty array');
        return res.json([]);
      }
      res.status(500).json({ error: error.message || 'Failed to get jobs' });
    }
  });

  // ============ Seed Video Template ============
  app.post('/api/admin/seed-video-template', async (req: Request, res: Response) => {
    const { isAdmin, error } = await verifyAdminSession(req);
    
    if (error) {
      return res.status(401).json({ error });
    }
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      // Check if video template already exists
      const { data: existing } = await supabase
        .from('i_edit_element_template')
        .select('id')
        .eq('element_type', 'video')
        .single();

      if (existing) {
        return res.json({ 
          message: 'Video template already exists', 
          id: existing.id 
        });
      }

      const videoTemplate = {
        element_type: 'video',
        name: 'Video Embed',
        description: 'Embed external videos from YouTube, Vimeo, and other platforms',
        icon: 'Video',
        category: 'media',
        is_active: true,
        display_order: 100,
        available_variants: ['default'],
        default_variant: 'default',
        default_content: {
          embed_code: '',
          aspect_ratio: '16:9',
          max_width: 100,
          alignment: 'center',
          title: '',
          caption: '',
          border_radius: 8,
          show_border: false,
          border_color: '#e2e8f0'
        },
        default_settings: {
          fullWidth: false,
          paddingTop: 32,
          paddingBottom: 32
        },
        content_schema: {
          type: 'object',
          properties: {
            embed_code: { type: 'string', title: 'Embed Code' },
            aspect_ratio: { type: 'string', title: 'Aspect Ratio' },
            max_width: { type: 'number', title: 'Max Width' },
            alignment: { type: 'string', title: 'Alignment' },
            title: { type: 'string', title: 'Title' },
            caption: { type: 'string', title: 'Caption' },
            border_radius: { type: 'number', title: 'Border Radius' },
            show_border: { type: 'boolean', title: 'Show Border' },
            border_color: { type: 'string', title: 'Border Color' }
          }
        },
        created_date: new Date().toISOString()
      };

      const { data, error: insertError } = await supabase
        .from('i_edit_element_template')
        .insert(videoTemplate)
        .select()
        .single();

      if (insertError) {
        console.error('[Seed Video Template] Error:', insertError);
        return res.status(500).json({ error: insertError.message });
      }

      res.status(201).json({ 
        message: 'Video template created successfully', 
        template: data 
      });
    } catch (error: any) {
      console.error('[Seed Video Template] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to seed video template' });
    }
  });

  // ============ Health Check ============
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({ 
      status: 'ok',
      supabase: !!supabase,
      timestamp: new Date().toISOString()
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}
