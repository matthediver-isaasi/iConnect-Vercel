import { getSessionMember } from '../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyAdminPermission(req) {
  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return { isAdmin: false, error: 'Not authenticated' };
  }

  if (!sessionMember.role_id) {
    return { isAdmin: false };
  }

  if (!supabase) {
    return { isAdmin: false, error: 'Database not configured' };
  }

  try {
    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { isAdmin: false };
    }

    const excludedFeatures = role.excluded_features || [];
    return { isAdmin: !isResourceExcluded(excludedFeatures, 'admin.role-management') };
  } catch (error) {
    console.error('[Admin Verify] Error:', error);
    return { isAdmin: false, error: 'Verification failed' };
  }
}

function generateSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { isAdmin, error } = await verifyAdminPermission(req);

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
    console.log('[Fix Blog Handles] Starting...');

    // Fetch all members with pagination to avoid Supabase's 1000 row limit
    let allMembersForHandles = [];
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
    
    const existingHandles = new Set(
      (allMembersForHandles || [])
        .map((m) => m.handle)
        .filter((h) => h !== null)
    );

    const memberMap = new Map();
    (allMembersForHandles || []).forEach((m) => memberMap.set(m.id, m));
    
    console.log(`[Fix Blog Handles] Member map has ${memberMap.size} entries`);

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
    const errors = [];

    for (const blog of blogPosts || []) {
      try {
        const member = memberMap.get(blog.author_id);
        if (!member) {
          errors.push(`Blog ${blog.id}: Author ${blog.author_id} not found`);
          continue;
        }

        let handle = member.handle;

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

          handle = baseHandle;
          let counter = 1;
          while (existingHandles.has(handle)) {
            const suffix = `-${counter}`;
            const maxBaseLength = 30 - suffix.length;
            handle = baseHandle.substring(0, maxBaseLength) + suffix;
            counter++;
          }

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

        const currentSlug = blog.slug || '';
        const expectedSuffix = `-by-${handle}`;
        
        if (!currentSlug.endsWith(expectedSuffix)) {
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
      } catch (blogErr) {
        errors.push(`Blog ${blog.id}: ${blogErr.message}`);
      }
    }

    console.log(`[Fix Blog Handles] Complete. Handles created: ${handlesCreated}, Slugs updated: ${slugsUpdated}, Errors: ${errors.length}`);
    
    return res.json({ 
      success: true, 
      handlesCreated,
      slugsUpdated,
      totalBlogs: blogPosts?.length || 0,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('[Fix Blog Handles] Error:', error);
    return res.status(500).json({ error: 'Failed to fix blog handles: ' + error.message });
  }
}
