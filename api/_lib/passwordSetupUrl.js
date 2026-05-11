import crypto from 'crypto';
import { supabase } from './database.js';

export async function generatePasswordSetupUrl(memberId, memberEmail, baseUrl) {
  if (!supabase || !memberId || !memberEmail || !baseUrl) return null;

  try {
    const email = memberEmail.toLowerCase();
    const resetToken = crypto.randomUUID();
    const resetTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { data: existingByMember } = await supabase
      .from('member_credentials')
      .select('id, email')
      .eq('member_id', memberId)
      .single();

    const { data: existingByEmail } = await supabase
      .from('member_credentials')
      .select('id, member_id')
      .eq('email', email)
      .single();

    if (existingByMember) {
      const { error } = await supabase
        .from('member_credentials')
        .update({
          email,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString(),
        })
        .eq('member_id', memberId);
      if (error) {
        console.error('[passwordSetupUrl] update by member error:', error);
        return null;
      }
    } else if (existingByEmail) {
      const { error } = await supabase
        .from('member_credentials')
        .update({
          member_id: memberId,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString(),
        })
        .eq('email', email);
      if (error) {
        console.error('[passwordSetupUrl] update by email error:', error);
        return null;
      }
    } else {
      const { error } = await supabase
        .from('member_credentials')
        .insert({
          member_id: memberId,
          email,
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires.toISOString(),
        });
      if (error) {
        console.error('[passwordSetupUrl] insert error:', error);
        return null;
      }
    }

    return `${baseUrl}/auth/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
  } catch (err) {
    console.error('[passwordSetupUrl] unexpected error:', err);
    return null;
  }
}

export async function applySetPasswordUrl(html, memberData, baseUrl) {
  if (!html || typeof html !== 'string') return html;
  const re = /\{\{\s*set_password_url\s*\}\}|\[\[\s*set_password_url\s*\]\]/i;
  if (!re.test(html)) return html;
  if (!memberData?.id || !memberData?.email || !baseUrl) {
    console.warn('[passwordSetupUrl] token present but missing member data or baseUrl');
    return html;
  }
  const url = await generatePasswordSetupUrl(memberData.id, memberData.email, baseUrl);
  if (!url) return html;
  const link = `<a href="${url}" style="color: #0066cc; text-decoration: underline;">Set your password</a>`;
  return html
    .replace(/\{\{\s*set_password_url\s*\}\}/gi, link)
    .replace(/\[\[\s*set_password_url\s*\]\]/gi, link);
}
