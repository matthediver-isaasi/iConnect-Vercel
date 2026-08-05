// Vercel custom-domain helpers shared by add/remove tenant-domain endpoints.
// All functions take a `config` object so they can be unit-tested with a mocked fetch:
//   { token, projectId, teamId, fetchImpl?, log?, logError? }

function buildUrl(config, path) {
  const base = `https://api.vercel.com${path}`;
  return config.teamId ? `${base}${path.includes('?') ? '&' : '?'}teamId=${config.teamId}` : base;
}

async function vercelFetch(config, path, options = {}) {
  const doFetch = config.fetchImpl || fetch;
  const response = await doFetch(buildUrl(config, path), {
    ...options,
    headers: {
      'Authorization': `Bearer ${config.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // some DELETE responses have no body
  }
  return { ok: response.ok, status: response.status, json };
}

export async function attachDomainToProject(config, domain, projectId = config.projectId) {
  return vercelFetch(config, `/v10/projects/${projectId}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
  });
}

export async function detachDomainFromProject(config, domain, projectId = config.projectId) {
  return vercelFetch(config, `/v9/projects/${projectId}/domains/${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
}

// Find which team project (other than the current one) currently holds the domain.
// Traverses the full paginated project list before declaring no owner.
export async function findProjectHoldingDomain(config, domain) {
  const log = config.log || console.log;
  const logError = config.logError || console.error;
  let until = null;
  let pages = 0;

  while (pages < 50) {
    pages += 1;
    const path = until
      ? `/v9/projects?limit=100&until=${until}`
      : `/v9/projects?limit=100`;
    const projectsRes = await vercelFetch(config, path);
    if (!projectsRes.ok || !Array.isArray(projectsRes.json?.projects)) {
      logError('[Vercel Domains] Failed to list team projects', projectsRes.status, projectsRes.json);
      return { error: 'project_list_failed' };
    }

    for (const project of projectsRes.json.projects) {
      if (project.id === config.projectId) continue;
      const domRes = await vercelFetch(config, `/v9/projects/${project.id}/domains/${encodeURIComponent(domain)}`);
      if (domRes.ok) {
        log(`[Vercel Domains] Domain ${domain} held by project ${project.id} (${project.name})`);
        return { project };
      }
    }

    const next = projectsRes.json?.pagination?.next;
    if (!next) break;
    until = next;
  }

  return { project: null };
}

// Attempt to reclaim a domain attached to ANOTHER project on the same Vercel team:
// find the owning project, detach the domain from it, then re-attach here.
// If the re-attach fails after a successful detach, the domain is rolled back
// (re-attached to the original owning project) so we never leave it orphaned.
// Returns { reclaimed: boolean, attachResult?, reason? }.
export async function reclaimDomainFromOtherProject(config, domain) {
  const log = config.log || console.log;
  const logError = config.logError || console.error;
  try {
    const { project: owningProject, error: findError } = await findProjectHoldingDomain(config, domain);
    if (findError) {
      return { reclaimed: false, reason: findError };
    }
    if (!owningProject) {
      logError(`[Vercel Domains] Reclaim: no team project found holding domain ${domain}`);
      return { reclaimed: false, reason: 'owner_not_found' };
    }

    log(`[Vercel Domains] Reclaim: detaching ${domain} from ${owningProject.id}`);
    const detachRes = await detachDomainFromProject(config, domain, owningProject.id);
    if (!detachRes.ok) {
      logError('[Vercel Domains] Reclaim: detach failed', detachRes.status, detachRes.json);
      return { reclaimed: false, reason: 'detach_failed' };
    }

    log(`[Vercel Domains] Reclaim: detached ${domain}; attaching to ${config.projectId}`);
    const attachResult = await attachDomainToProject(config, domain);
    if (!attachResult.ok && attachResult.json?.error?.code !== 'domain_already_exists') {
      logError('[Vercel Domains] Reclaim: re-attach failed', attachResult.status, attachResult.json);
      // Compensate: restore the domain to its original project so it is never orphaned.
      try {
        const rollbackRes = await attachDomainToProject(config, domain, owningProject.id);
        if (rollbackRes.ok || rollbackRes.json?.error?.code === 'domain_already_exists') {
          log(`[Vercel Domains] Reclaim: rolled back ${domain} to original project ${owningProject.id}`);
        } else {
          logError(
            `[Vercel Domains] Reclaim: ROLLBACK FAILED — domain ${domain} detached from ${owningProject.id} but attached to no project. Manual re-attach required.`,
            rollbackRes.status,
            rollbackRes.json,
          );
        }
      } catch (rollbackErr) {
        logError(
          `[Vercel Domains] Reclaim: ROLLBACK FAILED with exception — domain ${domain} may be attached to no project. Manual re-attach required.`,
          rollbackErr,
        );
      }
      return { reclaimed: false, reason: 'reattach_failed', attachResult };
    }

    log(`[Vercel Domains] Reclaim: successfully attached ${domain} to current project`);
    return { reclaimed: true, attachResult };
  } catch (err) {
    logError('[Vercel Domains] Reclaim: unexpected error', err);
    return { reclaimed: false, reason: 'exception' };
  }
}

// Map Vercel error codes to clear, actionable messages for the settings UI.
export function friendlyVercelError(errorObj, reclaimReason) {
  const code = errorObj?.code;
  switch (code) {
    case 'domain_already_in_use':
    case 'domain_already_in_use_by_project':
      if (reclaimReason === 'detach_failed' || reclaimReason === 'reattach_failed') {
        return 'This domain is attached to another site on our hosting platform and could not be transferred automatically. Please contact support to have it moved.';
      }
      return 'This domain is currently attached to another site on our hosting platform. We could not transfer it automatically — please contact support to have it moved.';
    case 'domain_taken':
    case 'not_authorized':
    case 'forbidden':
      return 'This domain is registered to a different account and cannot be added automatically. If you own this domain, please contact support.';
    case 'domain_verification_required':
    case 'verification_required':
      return 'This domain requires ownership verification before it can be added. Please contact support to complete verification.';
    case 'invalid_domain':
      return 'That does not appear to be a valid domain name. Please check the spelling and try again.';
    default:
      return 'We could not add this domain automatically. Please double-check the domain and try again, or contact support if the problem persists.';
  }
}
