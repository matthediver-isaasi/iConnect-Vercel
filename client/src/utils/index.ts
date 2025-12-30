


export function createPageUrl(pageName: string) {
    return '/' + pageName.replace(/ /g, '-');
}

export function isDeletedMember(member: { email?: string | null }): boolean {
    if (!member?.email) return false;
    return /^deleted_.*@deleted\.local$/.test(member.email);
}

export function filterActiveMembersOnly<T extends { email?: string | null }>(members: T[]): T[] {
    return members.filter(m => !isDeletedMember(m));
}