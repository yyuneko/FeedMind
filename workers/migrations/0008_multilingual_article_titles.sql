CREATE TABLE article_title_translations (
  classification_id TEXT NOT NULL REFERENCES article_classifications(id) ON DELETE CASCADE,
  target_locale TEXT NOT NULL CHECK (target_locale IN ('zh-CN', 'en-US', 'ja-JP')),
  translated_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'fallback')),
  prompt_version_id TEXT REFERENCES prompt_versions(id),
  profile_version_id TEXT NOT NULL REFERENCES ai_profile_versions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (classification_id, target_locale)
);

CREATE INDEX article_title_translations_locale_idx
  ON article_title_translations (target_locale, classification_id);

UPDATE prompt_versions
SET status = 'archived'
WHERE id = '20000000-0000-4000-8000-000000000001' AND status = 'active';

INSERT INTO prompt_versions
  (id, definition_id, version, status, content, content_hash, change_note, created_by_subject, created_by_email, created_at)
VALUES
  ('20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 2, 'active',
   '根据标题、Feed 元数据、摘要和非连续正文采样判断文章类型。technical 仅用于技术文档、软件工程、论文或技术实践；news 用于事件报道、公告和行业动态；其他使用 general。不要因片段不连续而臆测缺失内容。返回 articleType、confidence 和简短 reason；标题翻译字段由各目标语言提示词共同约束。',
   'seed-classification-v2', '支持一次调用返回中英日标题', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE prompt_definitions
SET current_version_id = '20000000-0000-4000-8000-000000000011',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '10000000-0000-4000-8000-000000000001';

INSERT INTO article_title_translations
  (classification_id, target_locale, translated_title, status, prompt_version_id, profile_version_id, created_at)
SELECT id, 'zh-CN', translated_title, title_status, title_prompt_version_id,
  COALESCE(title_profile_version_id, profile_version_id), created_at
FROM article_classifications
WHERE NULLIF(trim(translated_title), '') IS NOT NULL;

INSERT INTO prompt_definitions (id, task, article_type, target_locale, current_version_id, created_at, updated_at) VALUES
  ('10000000-0000-4000-8000-000000000009', 'title_translation', NULL, 'en-US', '20000000-0000-4000-8000-000000000009', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000010', 'title_translation', NULL, 'ja-JP', '20000000-0000-4000-8000-000000000010', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO prompt_versions
  (id, definition_id, version, status, content, content_hash, change_note, created_by_subject, created_by_email, created_at)
VALUES
  ('20000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000009', 1, 'active',
   'Translate the title into natural, accurate English. Preserve product names, code identifiers, version numbers, and proper nouns. Do not add information that is absent from the source title.',
   'seed-title-en-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000010', 1, 'active',
   'タイトルを自然で正確な日本語に翻訳してください。製品名、コード識別子、バージョン番号、固有名詞を保持し、原題にない情報を追加しないでください。',
   'seed-title-ja-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
