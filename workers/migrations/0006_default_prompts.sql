INSERT INTO prompt_definitions (id, task, article_type, target_locale, current_version_id, created_at, updated_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'classification', NULL, 'zh-CN', '20000000-0000-4000-8000-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000002', 'title_translation', NULL, 'zh-CN', '20000000-0000-4000-8000-000000000002', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000003', 'body_translation', 'technical', 'zh-CN', '20000000-0000-4000-8000-000000000003', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000004', 'body_translation', 'news', 'zh-CN', '20000000-0000-4000-8000-000000000004', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000005', 'body_translation', 'general', 'zh-CN', '20000000-0000-4000-8000-000000000005', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000006', 'body_repair', 'technical', 'zh-CN', '20000000-0000-4000-8000-000000000006', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000007', 'body_repair', 'news', 'zh-CN', '20000000-0000-4000-8000-000000000007', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('10000000-0000-4000-8000-000000000008', 'body_repair', 'general', 'zh-CN', '20000000-0000-4000-8000-000000000008', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO prompt_versions
  (id, definition_id, version, status, content, content_hash, change_note, created_by_subject, created_by_email, created_at)
VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 1, 'active',
   '根据标题、Feed 元数据、摘要和非连续正文采样判断文章类型。technical 仅用于技术文档、软件工程、论文或技术实践；news 用于事件报道、公告和行业动态；其他使用 general。不要因片段不连续而臆测缺失内容。返回 articleType、confidence、translatedTitle、reason 字段。',
   'seed-classification-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 1, 'active',
   '将标题自然、准确地翻译为简体中文。保留产品名、代码标识符、版本号和必要的英文专有名词；不要添加标题中没有的信息。',
   'seed-title-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 1, 'active',
   '把技术文章翻译为准确、清晰的简体中文。保留代码、公式、命令、API 名称、URL、HTML 标签结构和所有受保护标记。术语首次出现可保留英文。输入是 blocks 数组；只返回一个 JSON 对象 {"blocks":[["原 block id","译文标记"]]}，顺序、ID 和数量必须完全一致。',
   'seed-body-technical-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 1, 'active',
   '把新闻正文翻译为准确、中立、简洁的简体中文。不得改变事实、时间、数字、引语归属或不确定性。保留 HTML 标签结构和所有受保护标记。输入是 blocks 数组；只返回一个 JSON 对象 {"blocks":[["原 block id","译文标记"]]}，顺序、ID 和数量必须完全一致。',
   'seed-body-news-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000005', 1, 'active',
   '把正文自然、忠实地翻译为简体中文，保持原文语气和段落组织。保留名称、数字、URL、HTML 标签结构和所有受保护标记。输入是 blocks 数组；只返回一个 JSON 对象 {"blocks":[["原 block id","译文标记"]]}，顺序、ID 和数量必须完全一致。',
   'seed-body-general-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000006', 1, 'active',
   '修复技术文章翻译中校验失败的 blocks。只修改失败项，严格保留受保护标记、代码、公式、HTML 标签和 block ID；仅返回约定 JSON。',
   'seed-repair-technical-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000007', 1, 'active',
   '修复新闻翻译中校验失败的 blocks。只修改失败项，不改变事实、数字、引语归属、受保护标记、HTML 标签或 block ID；仅返回约定 JSON。',
   'seed-repair-news-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000008', 1, 'active',
   '修复通用文章翻译中校验失败的 blocks。只修改失败项，严格保留受保护标记、HTML 标签、顺序、数量和 block ID；仅返回约定 JSON。',
   'seed-repair-general-v1', '系统初始版本', 'system', 'system@feedmind.local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
