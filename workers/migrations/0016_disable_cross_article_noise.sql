UPDATE articles
SET noise_manifest_json = '[]', noise_manifest_hash = NULL, noise_analyzed_at = NULL
WHERE noise_manifest_json <> '[]' OR noise_manifest_hash IS NOT NULL OR noise_analyzed_at IS NOT NULL;

UPDATE translations
SET noise_manifest_json = '[]', noise_manifest_hash = NULL
WHERE noise_manifest_json <> '[]' OR noise_manifest_hash IS NOT NULL;

UPDATE system_config_versions
SET status = 'archived'
WHERE config_key = 'content_deduplication' AND status = 'active';
