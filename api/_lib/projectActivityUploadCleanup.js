// Bounded and retryable: never delete a confirmed attachment, even when a
// confirmation response or ledger cleanup was lost. No covers enter this table.
export async function cleanupProjectActivityUploads(db, now = new Date()) {
  const { data: uploads, error } = await db.from('project_activity_upload')
    .select('id,storage_path').lt('cleanup_after', now.toISOString())
    .order('cleanup_after').limit(100);
  if (error) throw error;
  let removed = 0, processed = 0;
  const deadline = Date.now() + 40_000;
  for (const upload of uploads || []) {
    if (Date.now() >= deadline) break;
    const { data: attachment, error: readError } = await db.from('project_card_attachment')
      .select('id').eq('id', upload.id).maybeSingle();
    if (readError) throw readError;
    if (!attachment) {
      const { error: storageError } = await db.storage.from('file-repository').remove([upload.storage_path]);
      if (storageError) throw storageError; // Keep ledger for the next attempt.
      removed++;
    }
    const { error: deleteError } = await db.from('project_activity_upload').delete().eq('id', upload.id);
    if (deleteError) throw deleteError;
    processed++;
  }
  return { processed, removed };
}
