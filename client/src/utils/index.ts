


export function createPageUrl(pageName: string) {
    const normalized = pageName.replace(/ /g, '-');
    return normalized.startsWith('/') ? normalized : '/' + normalized;
}

export function getEventUrl(event: { id: string; slug?: string | null }) {
    if (event.slug) {
        return `/events/${encodeURIComponent(event.slug)}`;
    }
    return createPageUrl('EventDetails') + '?id=' + event.id;
}

export function isDeletedMember(member: { email?: string | null }): boolean {
    if (!member?.email) return false;
    return /^deleted_.*@deleted\.local$/.test(member.email);
}

export function filterActiveMembersOnly<T extends { email?: string | null }>(members: T[]): T[] {
    return members.filter(m => !isDeletedMember(m));
}