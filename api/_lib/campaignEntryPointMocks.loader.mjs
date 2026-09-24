let tenantId = 'tenant-fixture';

export function initialize({ fixtureTenantId } = {}) {
  tenantId = fixtureTenantId || tenantId;
}

const sourceUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith('/api/_lib/tenantContext.js')) {
    return {
      shortCircuit: true,
      url: sourceUrl(`
        export async function getTenantContext() {
          return {
            tenantId: ${JSON.stringify(tenantId)},
            memberId: 'admin-member',
            member: {
              id: 'admin-member',
              email: 'admin@example.test',
              first_name: 'Admin',
              last_name: 'User'
            },
            isAuthenticated: true
          };
        }
      `),
    };
  }
  if (resolved.url.endsWith('/api/_lib/memberGroupEmsAccess.js')) {
    return {
      shortCircuit: true,
      url: sourceUrl(`
        const group = {
          groupId: 'group-fixture',
          groupName: 'Fixture Group',
          role: 'Chair',
          allRoles: ['Chair'],
          classificationId: null
        };
        export async function getCallerEmsAccess() {
          return {
            tenantContext: {
              tenantId: ${JSON.stringify(tenantId)},
              member: { email: 'admin@example.test' }
            },
            memberId: 'admin-member',
            groups: [group]
          };
        }
        export function requireGroupAccess(groups, groupId) {
          return groups.find((candidate) => candidate.groupId === groupId) || null;
        }
        export async function validateStoredMemberCampaign() {
          return { ok: true };
        }
        export function normalizeAudienceRoles() {
          return [];
        }
      `),
    };
  }
  return resolved;
}