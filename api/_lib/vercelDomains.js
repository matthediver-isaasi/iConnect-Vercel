// Vercel custom-domain helpers shared by add/remove tenant-domain endpoints.
// All functions take a `config` object so they can be unit-tested with a mocked fetch:
//   { token, projectId, teamId, fetchImpl?, log?, logError? }

function buildUrl(config, path) {
  const base = `https://api.vercel.com${path}`;
  return config.teamId ? `${base}${path.includes('?') ? '&' : '?'}teamId=${config.teamId}` : base;
}

export function isPlatformOwnedDomain(domain, platformDomain = 'iconn.app') {
  const normalizedDomain = String(domain || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');
  const normalizedPlatformDomain = String(platformDomain || 'iconn.app').trim().toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');
  return normalizedDomain === normalizedPlatformDomain
    || normalizedDomain.endsWith(`.${normalizedPlatformDomain}`);
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

async function readTargetProjectDomain(config, domain) {
  return vercelFetch(
    config,
    `/v9/projects/${config.projectId}/domains/${encodeURIComponent(domain)}`,
  );
}

async function verifyTargetProject(config) {
  const projectRes = await vercelFetch(config, `/v9/projects/${config.projectId}`);
  if (!projectRes.ok) {
    const accessFailure = projectRes.status === 401
      || projectRes.status === 403
      || projectRes.status === 404;
    return {
      ok: false,
      reason: accessFailure ? 'target_project_access_failed' : 'target_project_discovery_failed',
      response: projectRes,
    };
  }

  const project = projectRes.json;
  if (
    !project
    || project.id !== config.projectId
    || (config.teamId && project.accountId !== config.teamId)
  ) {
    return { ok: false, reason: 'target_project_mismatch', response: projectRes };
  }

  return { ok: true, project };
}

function isMatchingTargetAttachment(response, domain, targetProjectId) {
  return response.ok
    && String(response.json?.name || '').toLowerCase() === String(domain).toLowerCase()
    && (
      response.json?.projectId == null
      || response.json.projectId === targetProjectId
    );
}

// Register a domain without ever moving an existing attachment. The target
// project's domain endpoint is authoritative for both normal and redirecting
// domains, so it is always read before a write. A conflict response is only
// treated as success if a second read proves that a concurrent request attached
// the domain to this exact, verified project.
export async function registerDomainSafely(config, domain) {
  if (!config?.token || !config?.projectId) {
    return { ok: false, reason: 'invalid_config' };
  }

  try {
    const initialDomain = await readTargetProjectDomain(config, domain);
    if (!initialDomain.ok && initialDomain.status !== 404) {
      const accessFailure = initialDomain.status === 401 || initialDomain.status === 403;
      return {
        ok: false,
        reason: accessFailure ? 'target_domain_access_failed' : 'target_domain_discovery_failed',
        response: initialDomain,
      };
    }

    const target = await verifyTargetProject(config);
    if (!target.ok) return target;

    if (isMatchingTargetAttachment(initialDomain, domain, target.project.id)) {
      return {
        ok: true,
        status: 'already_attached',
        attachment: initialDomain.json,
        project: target.project,
      };
    }
    if (initialDomain.ok) {
      return { ok: false, reason: 'target_domain_mismatch', response: initialDomain };
    }

    const attachResult = await attachDomainToProject(config, domain);
    if (attachResult.ok) {
      if (String(attachResult.json?.name || '').toLowerCase() !== String(domain).toLowerCase()) {
        return { ok: false, reason: 'attach_response_mismatch', response: attachResult };
      }
      return {
        ok: true,
        status: 'attached',
        attachment: attachResult.json,
        project: target.project,
      };
    }

    const errorCode = attachResult.json?.error?.code;
    const conflict = errorCode === 'domain_already_exists'
      || errorCode === 'domain_already_in_use'
      || errorCode === 'domain_already_in_use_by_project';
    if (!conflict) {
      return { ok: false, reason: 'attach_failed', response: attachResult };
    }

    const racedDomain = await readTargetProjectDomain(config, domain);
    if (isMatchingTargetAttachment(racedDomain, domain, target.project.id)) {
      return {
        ok: true,
        status: 'already_attached',
        attachment: racedDomain.json,
        project: target.project,
      };
    }
    if (!racedDomain.ok && racedDomain.status !== 404) {
      const accessFailure = racedDomain.status === 401 || racedDomain.status === 403;
      return {
        ok: false,
        reason: accessFailure ? 'target_domain_access_failed' : 'target_domain_discovery_failed',
        response: racedDomain,
      };
    }
    if (racedDomain.ok) {
      return { ok: false, reason: 'target_domain_mismatch', response: racedDomain };
    }

    return {
      ok: false,
      reason: errorCode === 'domain_already_exists' ? 'unverified_existing_domain' : 'cross_project_conflict',
      response: attachResult,
    };
  } catch (error) {
    return { ok: false, reason: 'exception', error };
  }
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
  if (isPlatformOwnedDomain(domain, config.platformDomain)) {
    logError(`[Vercel Domains] Refusing to reclaim platform-owned domain ${domain}`);
    return { reclaimed: false, reason: 'platform_domain_protected' };
  }
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
export function friendlyVercelError(errorObj, reason) {
  switch (reason) {
    case 'invalid_config':
    case 'target_project_mismatch':
    case 'target_domain_mismatch':
    case 'attach_response_mismatch':
      return 'The hosting project configuration could not be verified. Please contact support before adding this domain.';
    case 'target_project_access_failed':
    case 'target_domain_access_failed':
      return 'Access to the configured hosting project could not be verified. Please contact support to check the project, team, and token permissions.';
    case 'target_project_discovery_failed':
    case 'target_domain_discovery_failed':
    case 'attach_failed':
    case 'exception':
      return 'The hosting provider could not verify this domain right now. Please try again later, or contact support if the problem persists.';
    case 'unverified_existing_domain':
      return 'The hosting provider reported that this domain already exists, but its attachment to this site could not be verified. No existing attachment was changed. Please contact support.';
    case 'cross_project_conflict':
      return 'This domain is attached to another site on our hosting platform. To protect the existing site, its attachment was preserved. Please contact support.';
  }

  const code = errorObj?.code;
  switch (code) {
    case 'domain_already_in_use':
    case 'domain_already_in_use_by_project':
      if (reason === 'detach_failed' || reason === 'reattach_failed') {
        return 'This domain is attached to another site on our hosting platform and could not be transferred automatically. Please contact support to have it moved.';
      }
      return 'This domain is currently attached to another site on our hosting platform. To protect that site, it was not moved automatically — please contact support to have it moved.';
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
