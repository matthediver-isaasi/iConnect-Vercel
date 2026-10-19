// Private staging only. These RPCs never write searchable member_content_chunk.
export const CHECKPOINT_VECTOR_DIMENSIONS = 1536;

export function validatedCheckpointVector(value) {
  let vector = value;
  if (typeof vector === 'string') {
    try { vector = JSON.parse(vector); } catch { vector = null; }
  }
  if (!Array.isArray(vector) || vector.length !== CHECKPOINT_VECTOR_DIMENSIONS ||
      !vector.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    throw new Error(`embedding checkpoint requires ${CHECKPOINT_VECTOR_DIMENSIONS} finite numeric dimensions`);
  }
  return `[${vector.join(',')}]`;
}

export async function readEmbeddingCheckpoints(supabase, identity) {
  const { data, error } = await supabase.rpc('read_member_content_embedding_checkpoints', identity);
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Invalid embedding checkpoint response');
  return data;
}

export async function saveEmbeddingCheckpoints(supabase, identity, rows) {
  const { data, error } = await supabase.rpc('save_member_content_embedding_checkpoints', {
    ...identity,
    p_rows: rows.map((row) => ({
      chunk_index: row.chunk_index,
      content_hash: row.content_hash,
      embedding_model: row.embedding_model,
      embedding: validatedCheckpointVector(row.embedding),
    })),
  });
  if (error) throw error;
  if (data !== true) throw new Error('Embedding checkpoint write rejected');
}
