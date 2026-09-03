import { analyzeContentBlocks, CONTENT_BLOCK_INDEX_VERSION } from "../../shared/src/content-blocks";
import type { D1Database } from "../../shared/src/cloudflare";

type ContentBlockEnv = { DB: D1Database };

export async function persistArticleContentBlocks(
  env: ContentBlockEnv,
  input: { articleId: string; feedId: string; sourceHash: string; html: string },
): Promise<void> {
  const blocks = await analyzeContentBlocks(input.html);
  await env.DB.prepare("DELETE FROM article_content_blocks WHERE article_id = ?1 AND source_hash = ?2")
    .bind(input.articleId, input.sourceHash).run();
  const createdAt = new Date().toISOString();
  for (let offset = 0; offset < blocks.length; offset += 40) {
    const statements = blocks.slice(offset, offset + 40).map((block) => env.DB.prepare(`INSERT INTO article_content_blocks
      (id, article_id, feed_id, source_hash, stable_id, block_index, block_kind, relative_position,
       normalized_length, exact_fingerprint, similarity_sketch_json, is_protected, is_eligible, policy_version, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', 0, 0, ?11, ?12)`)
      .bind(crypto.randomUUID(), input.articleId, input.feedId, input.sourceHash, block.stableId,
        block.blockIndex, block.kind, block.position, block.normalizedLength, block.exactFingerprint,
        CONTENT_BLOCK_INDEX_VERSION, createdAt));
    if (statements.length) await env.DB.batch(statements);
  }
  console.log({ service: "feedmind-pipeline", event: "article_content_blocks_indexed", articleId: input.articleId,
    feedId: input.feedId, indexVersion: CONTENT_BLOCK_INDEX_VERSION, blockCount: blocks.length });
}
