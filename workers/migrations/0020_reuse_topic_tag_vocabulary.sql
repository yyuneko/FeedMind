PRAGMA defer_foreign_keys = ON;

UPDATE topic_tags SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'candidate';

UPDATE prompt_versions
SET status = 'archived'
WHERE definition_id = '10000000-0000-4000-8000-000000000011' AND status = 'active';

INSERT INTO prompt_versions
  (id, definition_id, version, status, content, content_hash, change_note,
   created_by_subject, created_by_email, created_at)
VALUES
  ('20000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000011', 2, 'active',
   '正文是已去除 HTML 标签的完整纯文本。基于全文同时完成分类、标题翻译、摘要、关键要点、信息量评分和主题标签。不得补充正文不存在的信息。摘要必须是一句话；每种语言输出 3 至 5 条最重要要点。信息量评分关注具体性、技术细节、实践经验、数据证据和新增信息，简单公告、营销和重复转述应低分。生成主题标签时，existingTags 是权威的已有标签词表。必须先按含义、名称和别名查找可复用标签；只要已有标签语义相同，就原样使用其 key 和三语 names。不得为同义词、翻译、缩写、单复数、拼写变体或仅粒度略有差异的概念创建新标签。只有不存在语义等价标签时才创建新的规范标签。返回严格符合调用方要求的单个 JSON 对象。',
   'seed-article-preprocessing-v2-tag-reuse', '优先复用已有主题标签，避免同义重复',
   'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE prompt_definitions
SET current_version_id = '20000000-0000-4000-8000-000000000020',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '10000000-0000-4000-8000-000000000011';

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
