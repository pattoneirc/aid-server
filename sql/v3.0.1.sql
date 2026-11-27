-- AID Studio v3.0.1
-- Idempotent upgrade for the validated historical upgrade chain.
-- 分镜脚本和生图提示词的显式参考图。旧记录保持 NULL，沿用原有解析。
SET @aid_storyboard_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aid_storyboard' AND COLUMN_NAME = 'script_image_references'),
  'SELECT 1',
  'ALTER TABLE aid_storyboard ADD COLUMN script_image_references JSON NULL COMMENT ''脚本显式参考图''');
PREPARE aid_storyboard_ddl FROM @aid_storyboard_sql;
EXECUTE aid_storyboard_ddl;
DEALLOCATE PREPARE aid_storyboard_ddl;

SET @aid_storyboard_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aid_storyboard' AND COLUMN_NAME = 'image_prompt_references'),
  'SELECT 1',
  'ALTER TABLE aid_storyboard ADD COLUMN image_prompt_references JSON NULL COMMENT ''分镜图提示词显式参考图''');
PREPARE aid_storyboard_ddl FROM @aid_storyboard_sql;
EXECUTE aid_storyboard_ddl;
DEALLOCATE PREPARE aid_storyboard_ddl;
SET @aid_storyboard_sql = NULL;

-- Version snapshot retention now defaults to one. Preserve other explicit counts.
UPDATE aid_config SET config_value = '1'
WHERE category = 'system_upgrade' AND config_name = 'keep_backups' AND config_value = '3' AND del_flag = '0';

-- 个人录音资产及角色引用。历史角色的平台音色保留。
SET @personal_voice_ddl = IF(EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aid_audio_asset' AND COLUMN_NAME = 'avatar_url'
), 'SELECT 1', 'ALTER TABLE aid_audio_asset ADD COLUMN avatar_url VARCHAR(512) NULL COMMENT ''个人录音头像''');
PREPARE personal_voice_stmt FROM @personal_voice_ddl;
EXECUTE personal_voice_stmt;
DEALLOCATE PREPARE personal_voice_stmt;

SET @personal_voice_ddl = IF(EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aid_audio_asset' AND COLUMN_NAME = 'duration_ms'
), 'SELECT 1', 'ALTER TABLE aid_audio_asset ADD COLUMN duration_ms INT NULL COMMENT ''个人录音时长（毫秒）''');
PREPARE personal_voice_stmt FROM @personal_voice_ddl;
EXECUTE personal_voice_stmt;
DEALLOCATE PREPARE personal_voice_stmt;

SET @personal_voice_ddl = IF(EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aid_role_voice_binding' AND COLUMN_NAME = 'personal_audio_asset_id'
), 'SELECT 1', 'ALTER TABLE aid_role_voice_binding ADD COLUMN personal_audio_asset_id BIGINT NULL COMMENT ''个人原录音资产 ID''');
PREPARE personal_voice_stmt FROM @personal_voice_ddl;
EXECUTE personal_voice_stmt;
DEALLOCATE PREPARE personal_voice_stmt;

SET @personal_voice_ddl = IF(EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aid_role_voice_binding' AND COLUMN_NAME = 'voice_library_id' AND IS_NULLABLE = 'YES'
), 'SELECT 1', 'ALTER TABLE aid_role_voice_binding MODIFY COLUMN voice_library_id BIGINT NULL COMMENT ''平台音色 ID''');
PREPARE personal_voice_stmt FROM @personal_voice_ddl;
EXECUTE personal_voice_stmt;
DEALLOCATE PREPARE personal_voice_stmt;

SET @personal_voice_ddl = IF(EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aid_role_voice_binding' AND COLUMN_NAME = 'voice_code' AND IS_NULLABLE = 'YES'
), 'SELECT 1', 'ALTER TABLE aid_role_voice_binding MODIFY COLUMN voice_code VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL COMMENT ''平台音色厂商编码''');
PREPARE personal_voice_stmt FROM @personal_voice_ddl;
EXECUTE personal_voice_stmt;
DEALLOCATE PREPARE personal_voice_stmt;
SET @personal_voice_ddl = NULL;

-- 仅在升级至具有模型契约表的版本后执行。维护窗口中先停接新的 MiniMax 配音任务。
-- 移除配音配置和绑定，保留历史任务、账单、已生成的音视频及其他模型。
DROP PROCEDURE IF EXISTS aid_remove_minimax_tts_config;
DELIMITER $$
CREATE PROCEDURE aid_remove_minimax_tts_config()
BEGIN
    DECLARE done INT DEFAULT 0;
    DECLARE func_id BIGINT;
    DECLARE models JSON;
    DECLARE pos INT;
    DECLARE removed_models INT DEFAULT 0;
    DECLARE removed_voices INT DEFAULT 0;
    DECLARE removed_roles INT DEFAULT 0;
    DECLARE removed_bindings INT DEFAULT 0;
    DECLARE removed_providers INT DEFAULT 0;
    DECLARE funcs CURSOR FOR SELECT id, model_ids FROM aid_ai_model_func_config WHERE JSON_TYPE(model_ids) = 'ARRAY';
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        DROP TEMPORARY TABLE IF EXISTS aid_retired_tts_models, aid_retired_tts_voices, aid_retired_tts_providers;
        RESIGNAL;
    END;
    START TRANSACTION;

    CREATE TEMPORARY TABLE aid_retired_tts_models (
        id BIGINT PRIMARY KEY,
        provider_id BIGINT,
        model_code VARCHAR(128) NOT NULL
    );
    INSERT INTO aid_retired_tts_models (id, provider_id, model_code)
    SELECT m.id, m.provider_id, m.model_code
    FROM aid_ai_model m
    LEFT JOIN aid_ai_provider p ON p.id = m.provider_id
    WHERE LOWER(m.model_type) = 'audio'
      AND (
          m.protocol IN ('minimax-tts','tokendance:minimax:t2a_v2','tokendance:minimax:t2a_v2_ws','tokendance:minimax:voice_clone')
          OR EXISTS (
              SELECT 1 FROM aid_ai_model_protocol_binding b
              WHERE b.model_id = m.id
                AND b.protocol IN ('minimax-tts','tokendance:minimax:t2a_v2','tokendance:minimax:t2a_v2_ws','tokendance:minimax:voice_clone')
          )
          OR (
              (LOWER(p.provider_code) = 'minimax' AND LOWER(COALESCE(NULLIF(TRIM(m.real_model_code), ''), m.model_code)) REGEXP '^(minimax[-_:])?(speech|tts)([-_.:]|$)')
              OR LOWER(m.real_model_code) REGEXP '^minimax[-_:](speech|tts|voice[-_]clone)([-_.:]|$)'
          )
      );

    IF EXISTS (
        SELECT 1 FROM aid_media_task t
        WHERE t.media_type = 'AUDIO'
          AND t.status NOT IN ('SUCCEEDED','FAILED','CANCELLED')
          AND (
              t.protocol IN ('minimax-tts','tokendance:minimax:t2a_v2','tokendance:minimax:t2a_v2_ws','tokendance:minimax:voice_clone')
              OR EXISTS (SELECT 1 FROM aid_retired_tts_models m WHERE BINARY LOWER(m.model_code) = BINARY LOWER(t.model_name))
          )
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MiniMax speech tasks must finish before retirement';
    END IF;

    CREATE TEMPORARY TABLE aid_retired_tts_voices (id BIGINT PRIMARY KEY);
    INSERT INTO aid_retired_tts_voices (id)
    SELECT v.id FROM aid_ai_voice_library v
    JOIN aid_retired_tts_models m ON m.id = v.model_id;

    IF EXISTS (SELECT 1 FROM aid_retired_tts_models) THEN
        OPEN funcs;
        read_funcs: LOOP
            FETCH funcs INTO func_id, models;
            IF done = 1 THEN LEAVE read_funcs; END IF;
            SET pos = JSON_LENGTH(models) - 1;
            WHILE pos >= 0 DO
                IF EXISTS (
                    SELECT 1 FROM aid_retired_tts_models m
                    WHERE CAST(m.id AS CHAR) = JSON_UNQUOTE(JSON_EXTRACT(models, CONCAT('$[', pos, ']')))
                ) THEN
                    SET models = JSON_REMOVE(models, CONCAT('$[', pos, ']'));
                END IF;
                SET pos = pos - 1;
            END WHILE;
            UPDATE aid_ai_model_func_config SET model_ids = models
            WHERE id = func_id AND model_ids <> models;
        END LOOP;
        CLOSE funcs;
    END IF;

    DELETE b FROM aid_ai_business_model_binding b JOIN aid_retired_tts_models m ON m.id = b.model_id;
    SET removed_bindings = ROW_COUNT();
    DELETE b FROM aid_role_voice_binding b JOIN aid_retired_tts_voices v ON v.id = b.voice_library_id;
    SET removed_roles = ROW_COUNT();
    DELETE b FROM aid_role_voice_binding b JOIN aid_retired_tts_models m ON m.id = b.model_id;
    SET removed_roles = removed_roles + ROW_COUNT();
    DELETE v FROM aid_ai_voice_library v JOIN aid_retired_tts_voices s ON s.id = v.id;
    SET removed_voices = ROW_COUNT();
    DELETE a FROM aid_ai_model_alias a JOIN aid_retired_tts_models m ON m.id = a.model_id;
    DELETE a FROM aid_ai_model_alias a JOIN aid_retired_tts_models m ON m.id = a.legacy_model_id;
    DELETE b FROM aid_ai_model_protocol_binding b JOIN aid_retired_tts_models m ON m.id = b.model_id;
    DELETE c FROM aid_ai_model_capability c JOIN aid_retired_tts_models m ON m.id = c.model_id;
    DELETE a FROM aid_ai_model a JOIN aid_retired_tts_models m ON m.id = a.id;
    SET removed_models = ROW_COUNT();

    CREATE TEMPORARY TABLE aid_retired_tts_providers (id BIGINT PRIMARY KEY);
    INSERT INTO aid_retired_tts_providers (id)
    SELECT DISTINCT p.id
    FROM aid_ai_provider p JOIN aid_retired_tts_models m ON m.provider_id = p.id
    WHERE NOT EXISTS (SELECT 1 FROM aid_ai_model remaining WHERE remaining.provider_id = p.id);

    DELETE c FROM aid_provider_balance_config c JOIN aid_retired_tts_providers p ON p.id = c.provider_id;
    DELETE p FROM aid_ai_provider p JOIN aid_retired_tts_providers s ON s.id = p.id;
    SET removed_providers = ROW_COUNT();

    COMMIT;
    DROP TEMPORARY TABLE aid_retired_tts_models, aid_retired_tts_voices, aid_retired_tts_providers;
    SELECT removed_models, removed_voices, removed_roles, removed_bindings, removed_providers;
END$$
DELIMITER ;
CALL aid_remove_minimax_tts_config();
DROP PROCEDURE IF EXISTS aid_remove_minimax_tts_config;


SET @aid_workflow_fresh_install := 0;
-- Default model choices for the script-to-video workflow.
-- Keep other models in the catalog so sites can opt in later.
SET @workflow_saved_group_concat := @@session.group_concat_max_len;
SET SESSION group_concat_max_len = 1048576;

DROP TEMPORARY TABLE IF EXISTS tmp_workflow_choice, tmp_workflow_stock, tmp_workflow_pools, tmp_workflow_resolved;
CREATE TEMPORARY TABLE tmp_workflow_choice (
    func_code VARCHAR(100) NOT NULL,
    provider_code VARCHAR(50) NOT NULL,
    model_code VARCHAR(100) NOT NULL,
    capability_code VARCHAR(96) NOT NULL,
    model_order SMALLINT NOT NULL,
    is_default_capability TINYINT NOT NULL,
    PRIMARY KEY (func_code, provider_code, model_code, capability_code)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO tmp_workflow_choice VALUES
    ('ASSISTANT_CREATIVE_TEXT', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('ASSISTANT_CREATIVE_TEXT', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_character_extract', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_character_extract', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_character_form', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_character_form', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_prop_extract', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_prop_extract', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_prop_form', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_prop_form', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_scene_extract', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_scene_extract', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_scene_form', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_scene_form', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_script', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_script', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_script_two', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_script_two', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_stylist', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_stylist', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_stylist_two', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_stylist_two', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_video_prompt', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_video_prompt', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_video_prompt_dub_two', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_video_prompt_dub_two', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_video_prompt_grid', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_video_prompt_grid', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_video_prompt_grid_two', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_video_prompt_grid_two', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_video_prompt_image', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_video_prompt_image', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_video_prompt_image_two', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_video_prompt_image_two', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_storyboard_video_prompt_two', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('main_storyboard_video_prompt_two', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('main_character_image', 'openai', 'gpt-image-2.6-flare', 'text_to_image', 0, 1),
    ('main_character_image', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 0),
    ('main_character_image', 'openai', 'gpt-image-2', 'text_to_image', 1, 1),
    ('main_character_image', 'openai', 'gpt-image-2', 'image_to_image', 1, 0),
    ('main_character_image', 'openai', 'gpt-image-2.5-flare', 'text_to_image', 2, 1),
    ('main_character_image', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 0),
    ('main_character_image', 'openai', 'gpt-image-2.5-sunburst', 'text_to_image', 3, 1),
    ('main_character_image', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 0),
    ('main_character_card_image', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 1),
    ('main_character_card_image', 'openai', 'gpt-image-2', 'image_to_image', 1, 1),
    ('main_character_card_image', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 1),
    ('main_character_card_image', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 1),
    ('main_prop_image', 'openai', 'gpt-image-2.6-flare', 'text_to_image', 0, 1),
    ('main_prop_image', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 0),
    ('main_prop_image', 'openai', 'gpt-image-2', 'text_to_image', 1, 1),
    ('main_prop_image', 'openai', 'gpt-image-2', 'image_to_image', 1, 0),
    ('main_prop_image', 'openai', 'gpt-image-2.5-flare', 'text_to_image', 2, 1),
    ('main_prop_image', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 0),
    ('main_prop_image', 'openai', 'gpt-image-2.5-sunburst', 'text_to_image', 3, 1),
    ('main_prop_image', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 0),
    ('main_scene_image', 'openai', 'gpt-image-2.6-flare', 'text_to_image', 0, 1),
    ('main_scene_image', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 0),
    ('main_scene_image', 'openai', 'gpt-image-2', 'text_to_image', 1, 1),
    ('main_scene_image', 'openai', 'gpt-image-2', 'image_to_image', 1, 0),
    ('main_scene_image', 'openai', 'gpt-image-2.5-flare', 'text_to_image', 2, 1),
    ('main_scene_image', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 0),
    ('main_scene_image', 'openai', 'gpt-image-2.5-sunburst', 'text_to_image', 3, 1),
    ('main_scene_image', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 0),
    ('main_storyboard_image', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 1),
    ('main_storyboard_image', 'openai', 'gpt-image-2.6-flare', 'text_to_image', 0, 0),
    ('main_storyboard_image', 'openai', 'gpt-image-2', 'image_to_image', 1, 1),
    ('main_storyboard_image', 'openai', 'gpt-image-2', 'text_to_image', 1, 0),
    ('main_storyboard_image', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 1),
    ('main_storyboard_image', 'openai', 'gpt-image-2.5-flare', 'text_to_image', 2, 0),
    ('main_storyboard_image', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 1),
    ('main_storyboard_image', 'openai', 'gpt-image-2.5-sunburst', 'text_to_image', 3, 0),
    ('image_edit', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 1),
    ('image_edit', 'openai', 'gpt-image-2', 'image_to_image', 1, 1),
    ('image_edit', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 1),
    ('image_edit', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 1),
    ('image_multi_view', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 1),
    ('image_multi_view', 'openai', 'gpt-image-2', 'image_to_image', 1, 1),
    ('image_multi_view', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 1),
    ('image_multi_view', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 1),
    ('image_multi_grid', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 1),
    ('image_multi_grid', 'openai', 'gpt-image-2', 'image_to_image', 1, 1),
    ('image_multi_grid', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 1),
    ('image_multi_grid', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 1),
    ('image_upscale', 'topaz', 'topaz-standard-2', 'image_upscale', 0, 1),
    ('image_upscale', 'dashscope', 'wan2.6-image', 'image_to_image', 1, 1),
    ('main_storyboard_video_image', 'volcengine', 'doubao-seedance-2.5', 'image_to_video', 0, 1),
    ('main_storyboard_video_image', 'volcengine', 'doubao-seedance-2.0', 'image_to_video', 1, 1),
    ('main_storyboard_video_grid', 'volcengine', 'doubao-seedance-2.5', 'image_to_video', 0, 1),
    ('main_storyboard_video_grid', 'volcengine', 'doubao-seedance-2.5', 'reference_to_video', 0, 0),
    ('main_storyboard_video_grid', 'volcengine', 'doubao-seedance-2.0', 'image_to_video', 1, 1),
    ('main_storyboard_video_grid', 'volcengine', 'doubao-seedance-2.0', 'reference_to_video', 1, 0),
    ('main_storyboard_video', 'volcengine', 'doubao-seedance-2.5', 'reference_to_video', 0, 1),
    ('main_storyboard_video', 'volcengine', 'doubao-seedance-2.5', 'text_to_video', 0, 0),
    ('main_storyboard_video', 'volcengine', 'doubao-seedance-2.5', 'image_to_video', 0, 0),
    ('main_storyboard_video', 'volcengine', 'doubao-seedance-2.0', 'reference_to_video', 1, 1),
    ('main_storyboard_video', 'volcengine', 'doubao-seedance-2.0', 'text_to_video', 1, 0),
    ('main_storyboard_video', 'volcengine', 'doubao-seedance-2.0', 'image_to_video', 1, 0),
    ('main_storyboard_video_multi_pro', 'volcengine', 'doubao-seedance-2.5', 'reference_to_video', 0, 1),
    ('main_storyboard_video_multi_pro', 'volcengine', 'doubao-seedance-2.5', 'text_to_video', 0, 0),
    ('main_storyboard_video_multi_pro', 'volcengine', 'doubao-seedance-2.5', 'image_to_video', 0, 0),
    ('main_storyboard_video_multi_pro', 'volcengine', 'doubao-seedance-2.0', 'reference_to_video', 1, 1),
    ('main_storyboard_video_multi_pro', 'volcengine', 'doubao-seedance-2.0', 'text_to_video', 1, 0),
    ('main_storyboard_video_multi_pro', 'volcengine', 'doubao-seedance-2.0', 'image_to_video', 1, 0),
    ('main_storyboard_video_edge', 'volcengine', 'doubao-seedance-2.5', 'start_end_to_video', 0, 1),
    ('main_storyboard_video_edge', 'volcengine', 'doubao-seedance-2.0', 'start_end_to_video', 1, 1),
    ('main_storyboard_video_edge', 'vidu', 'vidu-q3-pro-img2video', 'start_end_to_video', 2, 1);

CREATE TEMPORARY TABLE tmp_workflow_stock (
    func_code VARCHAR(100) NOT NULL,
    state_hash CHAR(64) NOT NULL,
    PRIMARY KEY (func_code, state_hash)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Signatures of the unmodified public pool and strategy data before this migration.
INSERT INTO tmp_workflow_stock VALUES
    ('ASSISTANT_CREATIVE_TEXT', '781543779870e2d0bbcbe90454ae2ee47fd7ae39c59b23164c9420a2f75bfa5f'),
    ('image_edit', '1f652c6006f3106c2fb0cd64fec03468e437cd8dc9f8ea7bf7d8f929ad2e52f6'),
    ('image_multi_grid', '6d47e2ae0cffee13bba71831c4fde3c39ae9c78654703a96f059f4cca0f29350'),
    ('image_multi_view', '4e88aa9cbe200b7c4a9b0ad39a428004a9d766b788dac99b050e8a37c122e4de'),
    ('image_upscale', 'f925b38e605cdf9ac55d23b4127e74c54c05934e053078e48a7305dda5ad3332'),
    ('main_character_card_image', 'fd350fb60d5101bd62ed7b63051feb2f0f0a3387618b7d13fd9ebb3ec43c48aa'),
    ('main_character_extract', '2642ea518f73439b9474d13bcc0729279a231e26045067a6259ef7ef3a936c5b'),
    ('main_character_form', '63978f4709e4119c714ad891b31c97f59cb07d850eead8ad0e29876889414b42'),
    ('main_character_image', '488389b5c8c0d729ee2c3974a48c98065bea72a2d030ad2ac73351c4441cb1c5'),
    ('main_prop_extract', '3201b77bedbe84195a3beb381ee3a5e85804806f0d15baf0676d892dd97105af'),
    ('main_prop_form', 'a72430a6c0059ad0b2e3c01c4bb551306932a7db9777cef8b419ae1ca7ff0f53'),
    ('main_prop_image', 'd0525323dd3b1eaf2e1a33a13de36685e545451dd28e950a8a4c036dad193842'),
    ('main_scene_extract', '14777c1a58bdaf486ab102b6939103e61259a980f26aa1532a51d340919f2ed7'),
    ('main_scene_form', '336196a103942d6ccd5b0e8b40b57d7e3f88d5522ef97b17690fc659f75628c2'),
    ('main_scene_image', '44108f4145bbb62d93ead86fa03b95d514f79b09cf682a6062e24b6efca6cb06'),
    ('main_storyboard_image', 'd37d14878c401cf93c657bb542d28cb0852c161c6ae52fc43058814c1a051a97'),
    ('main_storyboard_script', '96c604bea2d7f7919411ce0a7d7f67cade1457dde725172a9282ac2d46672c05'),
    ('main_storyboard_script_two', '089cdd55294406c5bf982a799b553c593a248949065ce26f3c2d03897a492bb2'),
    ('main_storyboard_stylist', '417f47f9766fdae24b8d7dab80da1cd7121e9e7a0fb27b317157c5af3f124390'),
    ('main_storyboard_stylist_two', 'ad117b0552c58553e8b2455005dc9669cf6b6a05957ca48760c73f1c8ee7e8b0'),
    ('main_storyboard_video', '3ef90f6a99ae8a84a7bccc39ffbf936e1e2d85a03777870a410d4ee8199a6a86'),
    ('main_storyboard_video_edge', 'c273c042a8eeb7b630d85a8a6059b925ac72d485e9790a9312d9a474fa5123ed'),
    ('main_storyboard_video_grid', '689003a3c6d75226ebb13ef54265f323df6546df077c40779aeb3afb39efa118'),
    ('main_storyboard_video_image', 'cdbe903b1deac082ca506980ad8df913ce3826ae4704eef5ffa67a1aa2f5a9dc'),
    ('main_storyboard_video_multi_pro', '67486ac39c130b412f4f9db9faf197cc8eebcc3b6c5648408b3bc63f2afb7825'),
    ('main_storyboard_video_prompt', 'e7ecc8c56b4f60d601695925c122e5b14eacca691cdba1d1eb2a6d68c13b29f8'),
    ('main_storyboard_video_prompt_dub_two', '96ff27075a44da5dac162ed71cbd31853d1f988719d2ddc083d0a054d8b23db5'),
    ('main_storyboard_video_prompt_grid', '00388371e4477b956ad912dd8698d6496f88d352a995c39f8a890a884e970647'),
    ('main_storyboard_video_prompt_grid_two', '1177df2f007d1e92ea1360b631ac558e074e9837484beed4646f6d391db10c7a'),
    ('main_storyboard_video_prompt_image', '5ffb57dac3cc9f751853761e5d61dfeb22c6b31c79c565af47d66a055c8a0b8b'),
    ('main_storyboard_video_prompt_image_two', '9c9fb8f1056254494def55333af846bbb71d1186996edf721c96d2cd9aa58ec8'),
    ('main_storyboard_video_prompt_two', 'de3f00aec51103cd27b91ab602af242d53445d6c532e7c61a921dd609600b3cc'),
    ('image_edit', '74921209da52a76768d251b308e7f99ad7f07f306eb7cd0ae145f3644bdfe67c'),
    ('image_multi_grid', '1bf09e8ffd0316af1c7f3391177bc0f10e25736b2212f5d8f35ec6f946a8b0ae'),
    ('image_multi_view', 'd5641d12bebc243fbd02d908df26fec9e9317af3248fb11a485a101a8a6bcdd1'),
    ('main_character_card_image', '5eb4e97cdb540223b42aa6207af49e81b3073f1d993b06d21b7404a7f1017ea1'),
    ('main_character_extract', 'c81d5fff7dd1da836264cc9f1d8c80db2e6a4d87cf040775bad952309535dcf8'),
    ('main_character_form', '7167b04485ce5b015c8cfcdecf406986ec6d3f5d5bb27886f0b51e9bc000f925'),
    ('main_character_image', 'c174ea3671fd63860c29e0b4c98e3cb5b546c0261804ab5cf2161dd90c24259e'),
    ('main_prop_extract', 'c6977c7128cfc185c1f0174411034fe26be1e69142d18f07fed5f9293bde6bb1'),
    ('main_prop_form', '596b2dd4ec2bf9f6bed9f7120f83a241ba442fd6b7dfbc1350f6ba06c51e14d0'),
    ('main_prop_image', '99bedb772f5657766c884ec7959e1cb48f17e51a6bc5982812851367f4d4fd33'),
    ('main_scene_extract', '13cbef1c09a6bf539120a4f07784b6473b1dc889e3c6f4541e54a40e1a74ebdb'),
    ('main_scene_form', '4b2a37f0748000e4c81c244d16beb3098844d0f15e02e249bf8c117b624fa2df'),
    ('main_scene_image', 'e357c5992f96c857c6e2b9e24123719f29eade8789d0b2b422b65dfa56d7c683'),
    ('main_storyboard_image', 'a14c09c5527880328f273f268755305c1faee9eaf4b683cd8a941ce339713196'),
    ('main_storyboard_script', 'b2234ca13033e3c873195b2eee1d5a7d01436e273a4010a5ff1ea58b62f3fa10'),
    ('main_storyboard_script_two', '9b2d662a55f5711573f34e07c547bd228085b55fec87284b7602c77683d3b007'),
    ('main_storyboard_stylist', '4d8600a9b01414ab813d0a52d64df36e28f7f02a41d80751d2a52fdfe248d225'),
    ('main_storyboard_stylist_two', 'a552f330ff501ebe45c44262f04cfb14f8ebfb1695d565802d37f1d75cc49a14'),
    ('main_storyboard_video', '4b333d66feb17008a3ef57db6591101c6c5fcf622e7c1c278cdbba404b55c45c'),
    ('main_storyboard_video', '515d0abc7b09818d01e6333306d2af6bbf1f9b4936f52b3259dcae7d4ecae317'),
    ('main_storyboard_video_edge', 'a200888081279ffd5b34bd505a6d19701f0afd09fa2f5ea7030fb5559c6980e3'),
    ('main_storyboard_video_edge', 'acfa54ad83b5a02b932ba0d26425dfda490f726c75ed5616702da279f1dd302c'),
    ('main_storyboard_video_grid', '4dcf05e73a6d906371b91b04c2e0fde24031e7722b49a226bc2204e76bc1d775'),
    ('main_storyboard_video_grid', '63404ffce09a56388e892becc3bf7ff8b1893ba1b7cf5953b6731c16c4d89ee1'),
    ('main_storyboard_video_image', '35cda5765ff55fcc2174f75d8e3720693298aca790cc06b75fa1b4d1c8855319'),
    ('main_storyboard_video_image', '6b64d168f1fa6be1df6cf533eae4613db6c33b35bc8d6da49c0e7c3d1ba585f2'),
    ('main_storyboard_video_multi_pro', '46a4b3e1dd65aca0c1f203ce48d0c2b794289745a5d6d4fc7196607da97b116b'),
    ('main_storyboard_video_multi_pro', 'a97d150f6f1fd181cb14e46cd1a052e7c189b71048e95caba5ecca75498e393c'),
    ('main_storyboard_video_prompt', 'dc584be3c2f2637ce9e3e96b6467beb47471c5b30a7efed933faff5834c0eb97'),
    ('main_storyboard_video_prompt_dub_two', '37c41292ec63125d414eb6828cb8fd284ab2616c8352c65b560d8552d8a9d7f4'),
    ('main_storyboard_video_prompt_grid', '2117b0cca43564b4121b01f42df5be52a1f5aba69d92d2183d22fc175441b1a5'),
    ('main_storyboard_video_prompt_grid_two', 'e1af3112dad8e782d99bec0759cea8c59867ad24088fc1526646201905fa2b63'),
    ('main_storyboard_video_prompt_image', 'efa57419227405a0f06fdfa60a85a4d20786a8c7b77c813c2d018bd80599940a'),
    ('main_storyboard_video_prompt_image_two', '4824216978c9311c36d494cfe02687ea03331cb9b3f770541957b203cb3603d8'),
    ('main_storyboard_video_prompt_two', 'f88e71146e5401c12daf4374585e68aab3d5c3e2575ec865cdc4fec34051c570');

START TRANSACTION;

-- GPT Image 2.5 uses the seeded GPT Image 2 generation and reference-image contract.
-- Reuse the catalog contract only where no explicit definition exists for that capability.
INSERT INTO aid_ai_model_capability
    (model_id, capability_code, generate_mode, definition_json, sort_order, create_time, create_by)
SELECT m.id, c.capability_code, c.generate_mode, c.definition_json, c.sort_order, NOW(), 'system'
FROM aid_ai_model m
JOIN aid_ai_provider p ON p.id=m.provider_id AND p.provider_code='openai'
JOIN aid_ai_model src ON src.provider_id=p.id AND src.model_code='gpt-image-2' AND src.del_flag='0'
JOIN aid_ai_model_capability c ON c.model_id=src.id AND c.capability_code IN ('text_to_image','image_to_image')
WHERE m.model_code IN ('gpt-image-2.5-flare','gpt-image-2.5-sunburst')
  AND m.real_model_code=m.model_code AND m.del_flag='0'
  AND NOT EXISTS (SELECT 1 FROM aid_ai_model_capability x
    WHERE x.model_id=m.id AND x.capability_code=c.capability_code);

INSERT INTO aid_ai_model_protocol_binding
    (model_id, capability_code, binding_code, protocol, definition_json, sort_order, create_time, create_by)
SELECT m.id, b.capability_code, b.binding_code, b.protocol,
       JSON_SET(b.definition_json,'$.upstreamModel',m.real_model_code), b.sort_order, NOW(), 'system'
FROM aid_ai_model m
JOIN aid_ai_provider p ON p.id=m.provider_id AND p.provider_code='openai'
JOIN aid_ai_model src ON src.provider_id=p.id AND src.model_code='gpt-image-2' AND src.del_flag='0'
JOIN aid_ai_model_protocol_binding b ON b.model_id=src.id AND b.capability_code IN ('text_to_image','image_to_image')
  AND b.protocol='openai-image'
LEFT JOIN aid_ai_model_protocol_binding existing
  ON existing.model_id=m.id AND existing.capability_code=b.capability_code
WHERE m.model_code IN ('gpt-image-2.5-flare','gpt-image-2.5-sunburst')
  AND m.real_model_code=m.model_code AND m.del_flag='0' AND existing.id IS NULL;

CREATE TEMPORARY TABLE tmp_workflow_resolved
SELECT c.*, m.id AS model_id
FROM tmp_workflow_choice c
JOIN aid_ai_provider p ON p.provider_code=c.provider_code AND p.del_flag='0'
JOIN aid_ai_model m ON m.provider_id=p.id AND m.model_code=c.model_code AND m.del_flag='0'
JOIN aid_ai_model_capability a ON a.model_id=m.id AND a.capability_code=c.capability_code
  AND JSON_UNQUOTE(JSON_EXTRACT(a.definition_json,'$.enabled'))='true'
WHERE EXISTS (SELECT 1 FROM aid_ai_model_protocol_binding b
  WHERE b.model_id=m.id AND b.capability_code=c.capability_code
    AND JSON_UNQUOTE(JSON_EXTRACT(b.definition_json,'$.enabled'))='true');

CREATE TEMPORARY TABLE tmp_workflow_pools
SELECT f.func_code, target.model_ids, target.default_model_code
FROM aid_ai_model_func_config f
JOIN (
    SELECT func_code,
           CONCAT('[',GROUP_CONCAT(DISTINCT model_id ORDER BY model_order SEPARATOR ','),']') AS model_ids,
           MAX(IF(model_order=0,model_code,NULL)) AS default_model_code,
           COUNT(*) AS route_count
    FROM tmp_workflow_resolved
    GROUP BY func_code
) target ON target.func_code=f.func_code
JOIN (SELECT func_code,COUNT(*) AS route_count FROM tmp_workflow_choice GROUP BY func_code) requested
  ON requested.func_code=f.func_code AND requested.route_count=target.route_count
LEFT JOIN (
    SELECT func_code, SHA2(GROUP_CONCAT(SHA2(JSON_ARRAY(model_id,capability_code,default_capability,
                            defaults_json,sort_order),256)
                      ORDER BY model_id,capability_code SEPARATOR ''),256) AS digest
    FROM aid_ai_business_model_binding GROUP BY func_code
) binding_state ON binding_state.func_code=f.func_code
LEFT JOIN (
    SELECT biz_category_code, SHA2(GROUP_CONCAT(SHA2(JSON_ARRAY(step,creation_mode,script_type,strategy,
                            agent_code,model_code,resolution,aspect_ratio,is_default,sort_order,status,del_flag),256)
                      ORDER BY id SEPARATOR ''),256) AS digest
    FROM aid_gen_agent_pool GROUP BY biz_category_code
) matrix_state ON matrix_state.biz_category_code=f.func_code
WHERE f.del_flag='0' AND f.status='0'
  AND (@aid_workflow_fresh_install=1 OR (
    EXISTS (SELECT 1 FROM tmp_workflow_stock s
      WHERE s.func_code=f.func_code AND s.state_hash=SHA2(JSON_ARRAY(f.model_type,f.generate_mode,CAST(f.model_ids AS CHAR),
      binding_state.digest,matrix_state.digest),256))
    -- A configured channel is an operator decision. Preserve its existing pool selection.
    AND NOT EXISTS (SELECT 1 FROM aid_ai_model m JOIN aid_ai_provider p ON p.id=m.provider_id
      WHERE m.del_flag='0'
        AND (JSON_CONTAINS(f.model_ids,CAST(m.id AS JSON))
          OR JSON_CONTAINS(f.model_ids,JSON_QUOTE(CAST(m.id AS CHAR)))
          OR JSON_CONTAINS(CAST(target.model_ids AS JSON),CAST(m.id AS JSON)))
        AND (NULLIF(TRIM(p.api_key),'') IS NOT NULL OR NULLIF(TRIM(p.api_secret),'') IS NOT NULL))
  ));

-- Retain alternate capability definitions for future operator selection. The pool member
-- list controls customer-facing eligibility and its first ID controls the default order.
UPDATE aid_ai_business_model_binding b
JOIN tmp_workflow_pools f ON f.func_code=b.func_code
JOIN tmp_workflow_resolved c ON c.func_code=b.func_code AND c.model_id=b.model_id
    AND c.is_default_capability=1
SET b.default_capability=0
WHERE b.default_capability=1 AND b.capability_code<>c.capability_code;

INSERT INTO aid_ai_business_model_binding
    (func_code, model_id, capability_code, default_capability, sort_order, create_time, create_by)
SELECT c.func_code, c.model_id, c.capability_code, c.is_default_capability, c.model_order, NOW(), 'system'
FROM tmp_workflow_resolved c
JOIN tmp_workflow_pools f ON f.func_code=c.func_code
ON DUPLICATE KEY UPDATE default_capability=VALUES(default_capability), sort_order=VALUES(sort_order);

UPDATE aid_ai_model m
JOIN tmp_workflow_resolved c ON c.model_id=m.id
JOIN tmp_workflow_pools f ON f.func_code=c.func_code
SET m.status='0'
WHERE m.status<>'0';

UPDATE aid_ai_model_func_config f
JOIN tmp_workflow_pools p ON p.func_code=f.func_code
SET f.model_ids=CAST(p.model_ids AS JSON), f.update_by='system', f.update_time=NOW()
WHERE BINARY CAST(f.model_ids AS CHAR)<>BINARY CAST(CAST(p.model_ids AS JSON) AS CHAR);

UPDATE aid_gen_agent_pool a
JOIN tmp_workflow_pools p ON p.func_code=a.biz_category_code
SET a.model_code=p.default_model_code, a.update_by='system', a.update_time=NOW()
WHERE a.del_flag='0' AND a.status='0' AND NOT (a.model_code <=> p.default_model_code);

-- The official Pro chat endpoint supports streamed tool calls. Keep the existing
-- billing and input contract and leave custom transports in the operator's control.
UPDATE aid_ai_model m
JOIN aid_ai_provider p ON p.id=m.provider_id AND p.provider_code='deepseek'
JOIN aid_ai_model_protocol_binding b ON b.model_id=m.id AND b.capability_code='text'
JOIN tmp_workflow_pools f ON f.func_code='ASSISTANT_CREATIVE_TEXT'
SET m.protocol='deepseek:chat-completions',
    m.capability_json=JSON_SET(m.capability_json,'$.supportsStreaming',TRUE,'$.supportsToolCalling',TRUE),
    b.protocol='deepseek:chat-completions',
    b.definition_json=JSON_SET(b.definition_json,'$.protocol','deepseek:chat-completions',
      '$.capability.supportsStreaming',TRUE,'$.capability.supportsToolCalling',TRUE)
WHERE m.model_code='deepseek-v4-pro' AND m.real_model_code=m.model_code AND m.del_flag='0'
  AND p.del_flag='0' AND TRIM(TRAILING '/' FROM p.base_url)='https://api.deepseek.com'
  AND m.protocol='openai-compatible-text' AND b.protocol='openai-compatible-text' AND b.binding_code='route_96'
  AND JSON_EXTRACT(b.definition_json,'$.capability.supportsToolCalling') IS NULL
  AND JSON_EXTRACT(b.definition_json,'$.capability.supportsStreaming') IS NULL
  AND JSON_EXTRACT(m.capability_json,'$.supportsToolCalling') IS NULL
  AND JSON_EXTRACT(m.capability_json,'$.supportsStreaming') IS NULL;

-- Publish a new built-in Screenwriter configuration while keeping pinned versions intact.
SET @workflow_writer_old := (
  SELECT v.id
  FROM aid_runtime_agent a
  JOIN aid_runtime_agent_version v ON v.id=a.current_version_id AND v.agent_id=a.id
  JOIN aid_runtime_module_agent_binding b ON b.runtime_agent_id=a.id AND b.active_version_id=v.id
  WHERE a.agent_code='story_script_agent' AND a.owner_type='PLATFORM' AND a.status='0' AND a.del_flag='0'
    AND v.version_code='3.0.0-community-starter-v3' AND v.create_by='community-starter'
    AND v.publish_status='FROZEN' AND v.status='0' AND v.del_flag='0'
    AND b.module_code='SCREENWRITER' AND b.status='ACTIVE' AND b.del_flag='0'
    AND COALESCE(b.update_by,'') IN ('','community-starter','system')
    AND JSON_UNQUOTE(JSON_EXTRACT(v.model_config_json,'$.defaultModelCode'))='deepseek-flash'
    AND JSON_LENGTH(v.model_config_json,'$.selectableModelCodes')=1
    AND JSON_UNQUOTE(JSON_EXTRACT(v.model_config_json,'$.selectableModelCodes[0]'))='deepseek-flash'
    AND EXISTS (SELECT 1 FROM tmp_workflow_pools p WHERE p.func_code='ASSISTANT_CREATIVE_TEXT')
    AND EXISTS (
      SELECT 1 FROM aid_ai_model m JOIN aid_ai_provider pr ON pr.id=m.provider_id
      JOIN aid_ai_model_protocol_binding route ON route.model_id=m.id
        AND route.capability_code='text' AND route.protocol='deepseek:chat-completions'
      WHERE m.model_code='deepseek-v4-pro' AND m.status='0' AND m.del_flag='0' AND pr.provider_code='deepseek'
        AND JSON_UNQUOTE(JSON_EXTRACT(route.definition_json,'$.capability.supportsToolCalling'))='true'
        AND JSON_UNQUOTE(JSON_EXTRACT(route.definition_json,'$.capability.supportsStreaming'))='true'
    )
    AND NOT EXISTS (SELECT 1 FROM aid_runtime_agent_version n
                    WHERE n.agent_id=a.id AND n.version_code='community-screenwriter-model-options-v1')
);
SET @workflow_writer_config := (
  SELECT JSON_SET(model_config_json,'$.selectableModelCodes',JSON_ARRAY('deepseek-flash','deepseek-v4-pro'))
  FROM aid_runtime_agent_version WHERE id=@workflow_writer_old
);
SET @workflow_writer_definition := (
  SELECT JSON_SET(definition_json,'$.packageVersionCode','community-screenwriter-model-options-v1')
  FROM aid_runtime_agent_version WHERE id=@workflow_writer_old
);
INSERT INTO aid_runtime_agent_version (agent_id,version_code,publish_status,instruction,model_config_json,input_schema_json,
  output_schema_json,definition_json,package_digest,status,del_flag,create_by,create_time,update_by,update_time)
SELECT agent_id,'community-screenwriter-model-options-v1','FROZEN',instruction,@workflow_writer_config,input_schema_json,
  output_schema_json,@workflow_writer_definition,
  SHA2(CONCAT_WS(CHAR(10),instruction,@workflow_writer_config,input_schema_json,output_schema_json,@workflow_writer_definition),256),
  '0','0','community-starter',NOW(),'community-starter',NOW()
FROM aid_runtime_agent_version WHERE id=@workflow_writer_old;
SET @workflow_writer_new := IF(ROW_COUNT()=1,LAST_INSERT_ID(),NULL);
INSERT INTO aid_runtime_agent_skill_ref (agent_version_id,skill_id,skill_version_id,skill_code,package_digest)
SELECT @workflow_writer_new,skill_id,skill_version_id,skill_code,package_digest FROM aid_runtime_agent_skill_ref
WHERE agent_version_id=@workflow_writer_old AND @workflow_writer_new IS NOT NULL;
INSERT INTO aid_runtime_agent_tool_ref (agent_version_id,tool_code,contract_version,schema_digest)
SELECT @workflow_writer_new,tool_code,contract_version,schema_digest FROM aid_runtime_agent_tool_ref
WHERE agent_version_id=@workflow_writer_old AND @workflow_writer_new IS NOT NULL;
UPDATE aid_runtime_agent SET current_version_id=@workflow_writer_new
WHERE agent_code='story_script_agent' AND current_version_id=@workflow_writer_old AND @workflow_writer_new IS NOT NULL;
UPDATE aid_runtime_module_agent_binding
SET active_version_id=@workflow_writer_new,binding_revision=binding_revision+1
WHERE module_code='SCREENWRITER' AND active_version_id=@workflow_writer_old AND @workflow_writer_new IS NOT NULL;
SET @workflow_writer_old := NULL, @workflow_writer_new := NULL,
    @workflow_writer_config := NULL, @workflow_writer_definition := NULL;

-- Gate new-install providers until the operator configures their credentials.
UPDATE aid_ai_provider p
JOIN tmp_workflow_resolved c ON c.provider_code=p.provider_code
JOIN tmp_workflow_pools f ON f.func_code=c.func_code
SET p.status='1'
WHERE @aid_workflow_fresh_install=1 AND p.del_flag='0' AND p.status='0'
  AND NULLIF(TRIM(p.api_key),'') IS NULL AND NULLIF(TRIM(p.api_secret),'') IS NULL;

-- Update built-in application links and retain site-specific addresses.
UPDATE aid_ai_provider
SET api_key_apply_url=CASE provider_code
    WHEN 'dashscope' THEN 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key'
    WHEN 'volcengine' THEN 'https://console.volcengine.com/ark/region:cn-beijing/apiKey'
    WHEN 'topaz' THEN 'https://topazlabs.com/my-account/'
    WHEN 'deepseek' THEN 'https://platform.deepseek.com/api_keys'
    WHEN 'openai' THEN 'https://platform.openai.com/api-keys'
    WHEN 'vidu' THEN 'https://platform.vidu.cn/'
    WHEN 'volcengine_tts' THEN 'https://console.volcengine.com/speech/new/setting/apikeys'
END
WHERE del_flag='0' AND provider_code IN ('dashscope','volcengine','topaz','deepseek','openai','vidu','volcengine_tts')
  AND (NULLIF(TRIM(api_key_apply_url),'') IS NULL
    OR (provider_code='dashscope' AND api_key_apply_url='https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key')
    OR (provider_code='volcengine' AND api_key_apply_url='https://console.volcengine.com/ark')
    OR (provider_code='topaz' AND api_key_apply_url IN ('https://topazlabs.com/api','https://www.topazlabs.com/api','https://developer.topazlabs.com/')));

COMMIT;

DROP TEMPORARY TABLE tmp_workflow_pools, tmp_workflow_resolved, tmp_workflow_choice, tmp_workflow_stock;
SET SESSION group_concat_max_len = @workflow_saved_group_concat;
SET @workflow_saved_group_concat := NULL, @aid_workflow_fresh_install := NULL;


SET @aid_canvas_fresh_install := 0;
-- Canvas entry points keep their own model choices and leave other catalogs intact.
SET NAMES utf8mb4 COLLATE utf8mb4_general_ci;
SET @canvas_saved_group_concat := @@session.group_concat_max_len;
SET SESSION group_concat_max_len=1048576;

DROP TEMPORARY TABLE IF EXISTS tmp_canvas_options, tmp_canvas_stock,
    tmp_canvas_new_pools, tmp_canvas_routes, tmp_canvas_managed;
CREATE TEMPORARY TABLE tmp_canvas_options (
    func_code VARCHAR(100) NOT NULL,
    provider_code VARCHAR(50) NOT NULL,
    model_code VARCHAR(100) NOT NULL,
    capability_code VARCHAR(96) NOT NULL,
    model_order SMALLINT NOT NULL,
    is_default_capability TINYINT NOT NULL,
    PRIMARY KEY (func_code,provider_code,model_code,capability_code)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO tmp_canvas_options VALUES
    ('canvas.text.generate', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('canvas.text.generate', 'deepseek', 'deepseek-v4-pro', 'text', 1, 1),
    ('canvas.text.image_describe', 'deepseek', 'deepseek-flash', 'text', 0, 1),
    ('canvas.image.text_to_image', 'openai', 'gpt-image-2.6-flare', 'text_to_image', 0, 1),
    ('canvas.image.text_to_image', 'openai', 'gpt-image-2', 'text_to_image', 1, 1),
    ('canvas.image.text_to_image', 'openai', 'gpt-image-2.5-flare', 'text_to_image', 2, 1),
    ('canvas.image.text_to_image', 'openai', 'gpt-image-2.5-sunburst', 'text_to_image', 3, 1),
    ('canvas.image.image_to_image', 'openai', 'gpt-image-2.6-flare', 'image_to_image', 0, 1),
    ('canvas.image.image_to_image', 'openai', 'gpt-image-2', 'image_to_image', 1, 1),
    ('canvas.image.image_to_image', 'openai', 'gpt-image-2.5-flare', 'image_to_image', 2, 1),
    ('canvas.image.image_to_image', 'openai', 'gpt-image-2.5-sunburst', 'image_to_image', 3, 1),
    ('canvas.image.upscale', 'topaz', 'topaz-standard-2', 'image_upscale', 0, 1),
    ('canvas.image.redraw', 'openai', 'gpt-image-2.6-sunburst', 'image_edit', 0, 1),
    ('canvas.image.redraw', 'openai', 'gpt-image-2.6-sunburst', 'image_inpainting', 0, 0),
    ('canvas.image.erase', 'openai', 'gpt-image-2.6-sunburst', 'image_inpainting', 0, 1),
    ('canvas.image.expand', 'openai', 'gpt-image-2.6-sunburst', 'image_outpainting', 0, 1),
    ('canvas.image.relight', 'openai', 'gpt-image-2.6-sunburst', 'image_edit', 0, 1),
    ('canvas.image.emotion', 'openai', 'gpt-image-2.6-sunburst', 'image_edit', 0, 1),
    ('canvas.image.portrait_texture', 'openai', 'gpt-image-2.6-sunburst', 'image_edit', 0, 1),
    ('canvas.image.multi_view', 'openai', 'gpt-image-2.6-sunburst', 'image_edit', 0, 1),
    ('canvas.image.style_apply', 'openai', 'gpt-image-2.6-sunburst', 'image_edit', 0, 1),
    ('canvas.image.touch_edit', 'openai', 'gpt-image-2.6-sunburst', 'image_edit', 0, 1),
    ('canvas.image.layer_split', 'volcengine', 'doubao-seedream-5-0-pro-260628', 'image_layer_decomposition', 0, 1),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.5', 'text_to_video', 0, 1),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.5', 'image_to_video', 0, 0),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.5', 'start_end_to_video', 0, 0),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.5', 'reference_to_video', 0, 0),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.0', 'text_to_video', 1, 1),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.0', 'image_to_video', 1, 0),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.0', 'start_end_to_video', 1, 0),
    ('canvas.video.generate', 'volcengine', 'doubao-seedance-2.0', 'reference_to_video', 1, 0),
    ('canvas.video.reshoot', 'volcengine', 'doubao-seedance-2.5', 'video_edit', 0, 1),
    ('canvas.video.continue', 'volcengine', 'doubao-seedance-2.5', 'video_extend', 0, 1),
    ('canvas.video.subject_edit', 'kling', 'kling-3.0-omni-t2v', 'video_edit', 0, 1),
    ('video_enhance', 'topaz', 'topaz-proteus-video-express', 'video_enhance', 0, 1),
    ('video_depth_map', 'wavespeed', 'wavespeed-depth-anything-video', 'video_depth_map', 0, 1),
    ('video_portrait_segmentation', 'tencent_ci_media', 'tencent-ci-video-portrait-segmentation', 'portrait_foreground', 0, 1),
    ('video_portrait_segmentation', 'tencent_ci_media', 'tencent-ci-video-portrait-segmentation', 'portrait_mask', 0, 0),
    ('video_portrait_segmentation', 'tencent_ci_media', 'tencent-ci-video-portrait-segmentation', 'portrait_combination', 0, 0),
    ('audio_voice_separation', 'tencent_ci_media', 'tencent-ci-voice-separation', 'voice_only', 0, 1),
    ('audio_voice_separation', 'tencent_ci_media', 'tencent-ci-voice-separation', 'background_only', 0, 0),
    ('audio_voice_separation', 'tencent_ci_media', 'tencent-ci-voice-separation', 'voice_background', 0, 0),
    ('video_subtitle_remove', 'tencent_mps', 'tencent-mps-subtitle-erase', 'video_subtitle_remove', 0, 1),
    ('canvas.audio.generate', 'volcengine_seed_audio', 'seed-audio-1.0', 'post_audio_generate', 0, 1);

CREATE TEMPORARY TABLE tmp_canvas_stock (
    func_code VARCHAR(100) NOT NULL,
    state_hash CHAR(64) NOT NULL,
    PRIMARY KEY (func_code,state_hash)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Pool and capability signatures from the unmodified public initialization and upgrade baselines.
INSERT INTO tmp_canvas_stock VALUES
    ('audio_voice_separation', 'f010e782dea4ff46a4878db91c0f5cbb519e177820955a3f2ee08b346ecd1679'),
    ('canvas.audio.generate', '9ebf24f61196567768354ce0ee7f1b5731d26f6d2219e02200d06b7bf2659567'),
    ('canvas.image.emotion', 'cd315cafe9498e7ecefc0e9118148381207a9468436b5bf328a4c23cf343fcce'),
    ('canvas.image.erase', '850aec470ff510066c302bb4d474be7feba528e7d899be5012fc58ca3bac29ae'),
    ('canvas.image.expand', '65c5472be9fb539d612c13d384c7b03fd61a168af97d874acabbc5cc404625bf'),
    ('canvas.image.layer_split', '63b8af8f5202074de034da7d9e92eaf2a077259c44d5e3ca37c51f1f03a1b5ec'),
    ('canvas.image.multi_view', '51a38c086877f29b71e20a77343e35bff6cd91c6efbe3b037d02daabf52edd71'),
    ('canvas.image.portrait_texture', 'c7820ed77fa7687d5764999b0ec1901ff0100296f4e0852cdceaf439629d6de4'),
    ('canvas.image.redraw', '8a05e5e31f956b4162f203620ed538cad91e35c2da7a893b0afe70b79f17b063'),
    ('canvas.image.relight', '472a29e5a32a715636c60cd35e7d7e31bfa374d93f1450a13efdb7b1c89bb1e9'),
    ('canvas.image.style_apply', '491d1ad747f659cda966607000d3c7e49b995af72a363a8432c84e2c693e3a89'),
    ('canvas.image.touch_edit', 'b92db28a2d32a570789f2a0b6bb7ee57753026dcfeff091fc79397f623cbe325'),
    ('canvas.text.image_describe', 'b020d3f005b48d24519c7adacacebc76f079ceb9c31c3660d88891dc7972aa90'),
    ('canvas.video.continue', '1622d5197c41ec5d13c0b12cb8ea4da9fc6dee511d0689c19c58a92f1c6850d9'),
    ('canvas.video.generate', 'dcf265256b449f579660c4ae811f7b7102a3157704b77519ef79397cd1c3dccf'),
    ('canvas.video.reshoot', '45ecb701cab46f6201ea99a36ff4d405d860e11ba774d435c0f36d28f531624d'),
    ('canvas.video.subject_edit', '64bcc047b9865ff77e5f44e5d7d6fbb9ad0943e74927c70bbcf8871061eea304'),
    ('video_depth_map', '8b15122f43c6c8506e05559469b3d5faddaa449d71940461cb00cb95f7925ea1'),
    ('video_enhance', '744ef8bff2d6190cb0e4ef9bd61be1a2122472fd7fb5fef6f10107a1eb8714a3'),
    ('video_portrait_segmentation', 'b171f180574112e3fdcdb9ed7baad7a2730eb00f116c5631eb7cb927f955bd19'),
    ('video_subtitle_remove', '424b1cdd1044aebb131b598850534b2edf1cfcd78d1ac825e69245b4215361cf'),
    ('audio_voice_separation', '6847a264f78646d206e191597921f3f98a0d11f32af77e7fadfa828e0bc19834'),
    ('canvas.audio.generate', '051c0acd98ad4997d5864f021e1c7ec4ed58bf759f75b77686ec3b65d54d2a34'),
    ('canvas.image.emotion', '4e117ee84d68319febf5912f0e81e237061387c27321fd4a2f93062d52fbafac'),
    ('canvas.image.erase', 'fb428a120d70a09618455d421920788cca566f3541f4b8be2c9a95e28f97dd09'),
    ('canvas.image.expand', '0f5ee99e473490cf16257da6da18760b4266f776ba17964c49c45182c08db45a'),
    ('canvas.image.multi_view', '0be1557cc5f93b672d0a206adda45855397517af19020790a140b761b7eee3e7'),
    ('canvas.image.portrait_texture', '9b897457ce5f77b4399e45dfa45999bf333c76cfb4649e7c26e1e0ed26d488bc'),
    ('canvas.image.redraw', 'a69f5812c4a7de0a6081a19eaab9dc2f2c29eff5eb69338d0012d5ef2d8a968e'),
    ('canvas.image.relight', '4ddccb74e2048b6ca4cd07e3108d2d96db6a789186695aef9fc36df3d9cf21ef'),
    ('canvas.image.style_apply', 'ea3c45471abcde4f3ea2d87c2721d504f6d957bbdf29c192b8d74e29d34c3830'),
    ('canvas.image.touch_edit', '490a9780b92dd503463c526ac06fbf3d9f590ffa62ed7979d42ff8377d573cae'),
    ('canvas.video.continue', '7ac27a17ef619a8651bc5649fadad8fff32f677f64a3f521a7bb7bcf29727cb7'),
    ('canvas.video.generate', '193d07da4147f9668f1278c3c9bb3c3a61a5ad55b82db29e14e880a55e9824e6'),
    ('canvas.video.generate', '3be81c97ad0baa9a83cf44e0976aae0086b897b8c2f36f4651e59c59d0da0449'),
    ('canvas.video.reshoot', 'a1495bd03555503eee9936a41ede05b6c75561e93b307fad0c239ca747e67364'),
    ('canvas.video.reshoot', 'fa2207f6cdfca944400f595485ce1f7bbd539d006c674a827a1107012d79800e'),
    ('canvas.video.subject_edit', '3f163aaf80d4250cb12d509ee9f5957058f33239539d060e6912d6300d6f8a61'),
    ('video_depth_map', '1f1ae35af4070f5acd7d3c90b68a40a5174ddc13e7ef956a5eecc9b6490a5546'),
    ('video_enhance', '130837f904da6b00c948cf9c296ee03e8c71419faf7b352cdfb9cb70a6d06ca6'),
    ('video_portrait_segmentation', '7b0f06a958c0e546dbad8c1986a9f3785ed59695a174501860856b48e2790d4d'),
    ('video_subtitle_remove', 'b3a3e0a15146bd692dedbdacaaa5e93e2101ca7c307f41c9f7e6577468862d73');

CREATE TEMPORARY TABLE tmp_canvas_new_pools (
    func_code VARCHAR(100) PRIMARY KEY,
    func_name VARCHAR(100) NOT NULL,
    model_type VARCHAR(32) NOT NULL,
    generate_mode VARCHAR(32) NOT NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

START TRANSACTION;

INSERT INTO tmp_canvas_new_pools
SELECT s.func_code,s.func_name,s.model_type,s.generate_mode
FROM (
    SELECT 'canvas.text.generate' AS func_code,'画布文本生成' AS func_name,'text' AS model_type,'text' AS generate_mode
    UNION ALL SELECT 'canvas.image.text_to_image','画布文生图','image','text_to_image'
    UNION ALL SELECT 'canvas.image.image_to_image','画布参考图生图','image','image_to_image'
    UNION ALL SELECT 'canvas.image.upscale','画布图片高清','image','image_upscale'
) s
WHERE NOT EXISTS (SELECT 1 FROM aid_ai_model_func_config f WHERE f.func_code=s.func_code);

INSERT INTO aid_ai_model_func_config
    (func_code,func_name,model_type,generate_mode,model_ids,status,del_flag,create_by,create_time)
SELECT func_code,func_name,model_type,generate_mode,JSON_ARRAY(),'0','0','system',NOW()
FROM tmp_canvas_new_pools;

CREATE TEMPORARY TABLE tmp_canvas_routes
SELECT o.*,m.id AS model_id
FROM tmp_canvas_options o
JOIN aid_ai_provider p ON p.provider_code=o.provider_code AND p.del_flag='0'
JOIN aid_ai_model m ON m.provider_id=p.id AND m.model_code=o.model_code AND m.del_flag='0'
JOIN aid_ai_model_capability c ON c.model_id=m.id AND c.capability_code=o.capability_code
  AND JSON_UNQUOTE(JSON_EXTRACT(c.definition_json,'$.enabled'))='true'
WHERE EXISTS (SELECT 1 FROM aid_ai_model_protocol_binding b
  WHERE b.model_id=m.id AND b.capability_code=o.capability_code
    AND JSON_UNQUOTE(JSON_EXTRACT(b.definition_json,'$.enabled'))='true');

CREATE TEMPORARY TABLE tmp_canvas_managed
SELECT f.func_code,target.model_ids
FROM aid_ai_model_func_config f
JOIN (
  SELECT func_code,
         CONCAT('[',GROUP_CONCAT(DISTINCT model_id ORDER BY model_order SEPARATOR ','),']') AS model_ids,
         COUNT(*) AS route_count
  FROM tmp_canvas_routes
  GROUP BY func_code
) target ON target.func_code=f.func_code
JOIN (SELECT func_code,COUNT(*) AS route_count FROM tmp_canvas_options GROUP BY func_code) wanted
  ON wanted.func_code=f.func_code AND wanted.route_count=target.route_count
LEFT JOIN tmp_canvas_new_pools new_pool ON new_pool.func_code=f.func_code
LEFT JOIN (
    SELECT func_code, SHA2(GROUP_CONCAT(SHA2(JSON_ARRAY(model_id,capability_code,default_capability,
                          defaults_json,sort_order),256)
                    ORDER BY model_id,capability_code SEPARATOR ''),256) AS digest
    FROM aid_ai_business_model_binding GROUP BY func_code
) binding_state ON binding_state.func_code=f.func_code
WHERE f.status='0' AND f.del_flag='0'
  AND (@aid_canvas_fresh_install=1 OR new_pool.func_code IS NOT NULL OR (
    EXISTS (SELECT 1 FROM tmp_canvas_stock s
      WHERE s.func_code=f.func_code AND s.state_hash=SHA2(JSON_ARRAY(f.model_type,f.generate_mode,CAST(f.model_ids AS CHAR),binding_state.digest),256))
    AND NOT EXISTS (SELECT 1 FROM aid_ai_model m JOIN aid_ai_provider p ON p.id=m.provider_id
      WHERE m.del_flag='0'
        AND (JSON_CONTAINS(f.model_ids,CAST(m.id AS JSON))
          OR JSON_CONTAINS(f.model_ids,JSON_QUOTE(CAST(m.id AS CHAR)))
          OR JSON_CONTAINS(CAST(target.model_ids AS JSON),CAST(m.id AS JSON)))
        AND (NULLIF(TRIM(p.api_key),'') IS NOT NULL OR NULLIF(TRIM(p.api_secret),'') IS NOT NULL))
  ));

UPDATE aid_ai_business_model_binding b
JOIN tmp_canvas_managed f ON f.func_code=b.func_code
JOIN tmp_canvas_routes r ON r.func_code=b.func_code AND r.model_id=b.model_id AND r.is_default_capability=1
SET b.default_capability=0
WHERE b.default_capability=1 AND b.capability_code<>r.capability_code;

INSERT INTO aid_ai_business_model_binding
    (func_code,model_id,capability_code,default_capability,sort_order,create_time,create_by)
SELECT r.func_code,r.model_id,r.capability_code,r.is_default_capability,r.model_order,NOW(),'system'
FROM tmp_canvas_routes r
JOIN tmp_canvas_managed f ON f.func_code=r.func_code
ON DUPLICATE KEY UPDATE default_capability=VALUES(default_capability),sort_order=VALUES(sort_order);

-- The ordered pool controls visibility while preserving catalog records and other business pools.
UPDATE aid_ai_model_func_config f
JOIN tmp_canvas_managed target ON target.func_code=f.func_code
SET f.model_ids=CAST(target.model_ids AS JSON),f.update_by='system',f.update_time=NOW()
WHERE BINARY CAST(f.model_ids AS CHAR)<>BINARY CAST(CAST(target.model_ids AS JSON) AS CHAR);

UPDATE aid_ai_model m
JOIN aid_ai_provider p ON p.id=m.provider_id
JOIN tmp_canvas_routes r ON r.model_id=m.id
JOIN tmp_canvas_managed f ON f.func_code=r.func_code
SET m.status='0'
WHERE m.status<>'0'
  AND (@aid_canvas_fresh_install=1 OR (
    NULLIF(TRIM(p.api_key),'') IS NULL AND NULLIF(TRIM(p.api_secret),'') IS NULL));

-- Leave unconfigured built-in direct channels disabled. Keep custom routing and
-- the shared Tencent media configuration under their own credential rules.
UPDATE aid_ai_provider p
JOIN tmp_canvas_routes r ON r.provider_code=p.provider_code
JOIN tmp_canvas_managed f ON f.func_code=r.func_code
SET p.status='1'
WHERE p.del_flag='0' AND p.status='0'
  AND p.provider_code NOT IN ('tencent_ci_media','tencent_mps')
  AND NULLIF(TRIM(p.api_key),'') IS NULL AND NULLIF(TRIM(p.api_secret),'') IS NULL
  AND (@aid_canvas_fresh_install=1 OR (
    COALESCE(p.update_by,'') IN ('','system','installation')
    AND COALESCE(JSON_LENGTH(p.extra_headers),0)=0
    AND COALESCE(JSON_LENGTH(p.extra_query),0)=0
    AND NOT EXISTS (SELECT 1 FROM aid_config g WHERE g.category='official_gateway'
      AND g.config_name='enabled' AND g.del_flag='0'
      AND LOWER(TRIM(g.config_value)) IN ('true','1','on','yes'))
  ));

UPDATE aid_ai_provider
SET api_key_apply_url='https://wavespeed.ai/accesskey'
WHERE provider_code='wavespeed' AND del_flag='0' AND NULLIF(TRIM(api_key_apply_url),'') IS NULL;

-- Publish the new built-in universal assistant model list without changing frozen history.
SET @canvas_universal_old := (
  SELECT v.id
  FROM aid_runtime_agent a
  JOIN aid_runtime_agent_version v ON v.id=a.current_version_id AND v.agent_id=a.id
  JOIN aid_runtime_module_agent_binding b ON b.runtime_agent_id=a.id AND b.active_version_id=v.id
  WHERE a.agent_code='universal_canvas_agent' AND a.owner_type='PLATFORM' AND a.status='0' AND a.del_flag='0'
    AND v.version_code='3.0.0-community-starter-v3' AND v.create_by='community-starter'
    AND v.publish_status='FROZEN' AND v.status='0' AND v.del_flag='0'
    AND b.module_code='UNIVERSAL' AND b.status='ACTIVE' AND b.del_flag='0'
    AND COALESCE(b.update_by,'') IN ('','community-starter','system')
    AND JSON_UNQUOTE(JSON_EXTRACT(v.model_config_json,'$.defaultModelCode'))='deepseek-flash'
    AND JSON_LENGTH(v.model_config_json,'$.selectableModelCodes')=1
    AND JSON_UNQUOTE(JSON_EXTRACT(v.model_config_json,'$.selectableModelCodes[0]'))='deepseek-flash'
    AND EXISTS (SELECT 1 FROM aid_ai_model m JOIN aid_ai_provider p ON p.id=m.provider_id
      JOIN aid_ai_model_protocol_binding route ON route.model_id=m.id
        AND route.capability_code='text' AND route.protocol='deepseek:chat-completions'
      WHERE m.model_code='deepseek-v4-pro' AND m.status='0' AND m.del_flag='0' AND p.provider_code='deepseek'
        AND JSON_UNQUOTE(JSON_EXTRACT(route.definition_json,'$.capability.supportsToolCalling'))='true'
        AND JSON_UNQUOTE(JSON_EXTRACT(route.definition_json,'$.capability.supportsStreaming'))='true'
        AND (@aid_canvas_fresh_install=1 OR NULLIF(TRIM(p.api_key),'') IS NULL))
    AND NOT EXISTS (SELECT 1 FROM aid_runtime_agent_version n
                    WHERE n.agent_id=a.id AND n.version_code='community-universal-model-options-v1')
);
SET @canvas_universal_model := (
  SELECT JSON_SET(model_config_json,'$.selectableModelCodes',JSON_ARRAY('deepseek-flash','deepseek-v4-pro'))
  FROM aid_runtime_agent_version WHERE id=@canvas_universal_old
);
SET @canvas_universal_definition := (
  SELECT JSON_SET(definition_json,'$.packageVersionCode','community-universal-model-options-v1')
  FROM aid_runtime_agent_version WHERE id=@canvas_universal_old
);
INSERT INTO aid_runtime_agent_version (agent_id,version_code,publish_status,instruction,model_config_json,input_schema_json,
  output_schema_json,definition_json,package_digest,status,del_flag,create_by,create_time,update_by,update_time)
SELECT agent_id,'community-universal-model-options-v1','FROZEN',instruction,@canvas_universal_model,input_schema_json,
  output_schema_json,@canvas_universal_definition,
  SHA2(CONCAT_WS(CHAR(10),instruction,@canvas_universal_model,input_schema_json,output_schema_json,@canvas_universal_definition),256),
  '0','0','community-starter',NOW(),'community-starter',NOW()
FROM aid_runtime_agent_version WHERE id=@canvas_universal_old;
SET @canvas_universal_new := IF(ROW_COUNT()=1,LAST_INSERT_ID(),NULL);
INSERT INTO aid_runtime_agent_skill_ref (agent_version_id,skill_id,skill_version_id,skill_code,package_digest)
SELECT @canvas_universal_new,skill_id,skill_version_id,skill_code,package_digest FROM aid_runtime_agent_skill_ref
WHERE agent_version_id=@canvas_universal_old AND @canvas_universal_new IS NOT NULL;
INSERT INTO aid_runtime_agent_tool_ref (agent_version_id,tool_code,contract_version,schema_digest)
SELECT @canvas_universal_new,tool_code,contract_version,schema_digest FROM aid_runtime_agent_tool_ref
WHERE agent_version_id=@canvas_universal_old AND @canvas_universal_new IS NOT NULL;
UPDATE aid_runtime_agent SET current_version_id=@canvas_universal_new
WHERE agent_code='universal_canvas_agent' AND current_version_id=@canvas_universal_old AND @canvas_universal_new IS NOT NULL;
UPDATE aid_runtime_module_agent_binding
SET active_version_id=@canvas_universal_new,binding_revision=binding_revision+1
WHERE module_code='UNIVERSAL' AND active_version_id=@canvas_universal_old AND @canvas_universal_new IS NOT NULL;

COMMIT;

DROP TEMPORARY TABLE tmp_canvas_managed,tmp_canvas_routes,tmp_canvas_new_pools,tmp_canvas_stock,tmp_canvas_options;
SET SESSION group_concat_max_len=@canvas_saved_group_concat;
SET @canvas_saved_group_concat := NULL, @aid_canvas_fresh_install := NULL,
    @canvas_universal_old := NULL, @canvas_universal_new := NULL,
    @canvas_universal_model := NULL, @canvas_universal_definition := NULL;

-- Community canvas Skill authoring package. Keep operator-owned packages and bindings.
SET NAMES utf8mb4;
START TRANSACTION;
SET @au_code='skill_authoring_flow', @au_version='1.0.0-community', @au_digest='6789f2081988c9feda417983db762967631f66db18d22126e2b9375d38172ee5';
SET @au_prompt='把用户确认的方法整理成可复用的私人 Skill 草稿。先核对来源、输入和交付形式，读取主文件及对应来源说明，按当前计划调用保存工具。结果以草稿回执为准。', @au_input='{"type":"object","x-aid-input-mode":"FREE_FORM","examples":["把一段文字概括为一句话，保存为私人 Skill 草稿。"]}', @au_output='{"type":"object","examples":["私人 Skill 草稿已保存，可查看草稿。"]}';
SET @au_model='deepseek-flash', @au_model_config='{"defaultModelCode":"deepseek-flash","selectableModelCodes":["deepseek-flash"]}', @au_definition='{"communityStarter":true,"outputKind":"TEXT"}';
SET @au_manifest='{"formatVersion":"2","code":"skill_authoring_flow","version":"1.0.0-community","invocationScope":"INTERNAL","source":"DATABASE","digestAlgorithm":"aid-db-package-v3","files":{"skill":{"digest":"9159b9e0afa1b210ee72e0f22b76e5734329ca9f04773f1bec4b8ffbcd78baba","path":"SKILL.md"},"systemPrompt":{"digest":"22234c5e7324f98870a94903ba00ddd0b7900e94984aa22672ae0f74498a236e","path":"system_prompt.md"}},"resources":[{"path":"references/canvas_recipe.md","key":"canvas_recipe","route":{"always":false},"digest":"453a48ea1ef2796a17453d011900422ab20660e705c1097396afb505a9f6e797"},{"path":"references/dialogue_recipe.md","key":"dialogue_recipe","route":{"always":false},"digest":"0d71e63c4ec01421b82eb799fae590c75f4a63e4a8f6ddcd4dd40f77ea7165d9"},{"path":"references/idea_workshop.md","key":"idea_workshop","route":{"always":false},"digest":"528240298a0f361a7ad80add76071f909a7609440401639cdf7c0b6c66594e3a"}]}';
INSERT INTO aid_skill (skill_code,name,description,owner_type,visibility,invocation_scope,executor_type,
  model_code,input_schema_json,output_schema_json,system_prompt,definition_json,config_hash,status,del_flag,create_by,create_time)
SELECT @au_code,'技能编制','从想法、对话或画布生成私人 Skill 草稿','PLATFORM','PUBLIC','INTERNAL','PROMPT',
  @au_model,@au_input,@au_output,@au_prompt,@au_definition,@au_digest,'0','0','community-starter',NOW()
WHERE NOT EXISTS (SELECT 1 FROM aid_skill WHERE skill_code='skill_authoring_flow');
SET @au_new_skill=IF(ROW_COUNT()=1,LAST_INSERT_ID(),NULL);
INSERT INTO aid_skill_version (skill_id,version_code,visibility,invocation_scope,publish_status,executor_type,model_code,
  model_config_json,package_digest,manifest_json,input_schema_json,output_schema_json,system_prompt,definition_json,
  max_output_tokens,context_window_tokens,safety_margin_tokens,status,del_flag,create_by,create_time,update_by,update_time)
SELECT @au_new_skill,@au_version,'PUBLIC','INTERNAL','PUBLISHED','PROMPT',@au_model,@au_model_config,@au_digest,
  @au_manifest,@au_input,@au_output,@au_prompt,@au_definition,8192,128000,8192,'0','0','community-starter',NOW(),'community-starter',NOW()
WHERE @au_new_skill IS NOT NULL;
SET @au_new_version=IF(ROW_COUNT()=1,LAST_INSERT_ID(),NULL);
SET @au_text=CONCAT_WS(CHAR(10),
  '---',
  'name: skill_authoring_flow',
  'description: 从想法、对话或画布提炼私人 Skill 草稿',
  '---',
  '确认用途、输入样例、预期结果和来源。按来源选择 SCRATCH、CONVERSATION 或 CANVAS。当前计划先读取同一固定版本的主文件和对应参考，再按已批准的计划调用 aid.skill.propose-draft-v2。选择当前渠道可用的模型。文字方法声明 TEXT、输入模式和输入输出样例，结构化输出另设 methodOutputMode 为 JSON。直接生图使用 IMAGE 和平台支持的图片能力及共享契约。编制可复用的步骤，将示例和固定规则分开。校验失败时按字段修订。收到保存回执后报告私人草稿，发布由用户决定。');
INSERT INTO aid_skill_resource (skill_version_id,resource_key,resource_type,object_key,content_digest,mime_type,
  size_bytes,route_json,content_text,status,del_flag,create_by,create_time)
SELECT @au_new_version,'__skill_md','PACKAGE',CONCAT('database:skills/platform/official/',@au_code,'/',@au_version,'/SKILL.md'),
  SHA2(@au_text,256),'text/markdown',OCTET_LENGTH(@au_text),'{}',@au_text,'0','0','community-starter',NOW()
WHERE @au_new_version IS NOT NULL;
SET @au_text='核对当前用户已授权的画布或素材引用。保留来源类型与 canonicalRef，把节点关系、依赖和预期结果转为通用步骤。缺少可读来源时请用户选取画布素材。保存用 CANVAS 和本次授权的 sourceRefs。';
INSERT INTO aid_skill_resource (skill_version_id,resource_key,resource_type,object_key,content_digest,mime_type,
  size_bytes,route_json,content_text,status,del_flag,create_by,create_time)
SELECT @au_new_version,'canvas_recipe','REFERENCE',CONCAT('database:skills/platform/official/',@au_code,'/',@au_version,'/references/canvas_recipe.md'),
  SHA2(@au_text,256),'text/markdown',OCTET_LENGTH(@au_text),'{"always":false}',@au_text,'0','0','community-starter',NOW()
WHERE @au_new_version IS NOT NULL;
SET @au_text='从可验证的创作对话提取用户确认的输入、步骤和交付样例。移除姓名、账号和任务特有参数。保存用 CONVERSATION，由宿主校验对话来源。仅有新想法时用 SCRATCH。';
INSERT INTO aid_skill_resource (skill_version_id,resource_key,resource_type,object_key,content_digest,mime_type,
  size_bytes,route_json,content_text,status,del_flag,create_by,create_time)
SELECT @au_new_version,'dialogue_recipe','REFERENCE',CONCAT('database:skills/platform/official/',@au_code,'/',@au_version,'/references/dialogue_recipe.md'),
  SHA2(@au_text,256),'text/markdown',OCTET_LENGTH(@au_text),'{"always":false}',@au_text,'0','0','community-starter',NOW()
WHERE @au_new_version IS NOT NULL;
SET @au_text='从用户的想法确定用途、输入与一次成功输出的样例，补问会影响契约的缺项。把方法写成可以对新输入重复执行的步骤。保存用 SCRATCH，sourceRefs 为空。';
INSERT INTO aid_skill_resource (skill_version_id,resource_key,resource_type,object_key,content_digest,mime_type,
  size_bytes,route_json,content_text,status,del_flag,create_by,create_time)
SELECT @au_new_version,'idea_workshop','REFERENCE',CONCAT('database:skills/platform/official/',@au_code,'/',@au_version,'/references/idea_workshop.md'),
  SHA2(@au_text,256),'text/markdown',OCTET_LENGTH(@au_text),'{"always":false}',@au_text,'0','0','community-starter',NOW()
WHERE @au_new_version IS NOT NULL;

UPDATE aid_skill SET current_version_id=@au_new_version WHERE id=@au_new_skill AND current_version_id IS NULL;
SET @au_skill=(SELECT id FROM aid_skill WHERE skill_code='skill_authoring_flow' AND owner_type='PLATFORM' AND visibility='PUBLIC'
  AND invocation_scope='INTERNAL' AND status='0' AND del_flag='0' AND create_by='community-starter');
SET @au_version_id=(SELECT v.id FROM aid_skill_version v JOIN aid_skill s ON s.id=v.skill_id AND s.current_version_id=v.id
  WHERE s.id=@au_skill AND BINARY v.package_digest=BINARY @au_digest AND v.publish_status='PUBLISHED' AND v.status='0' AND v.del_flag='0');

-- Freeze a successor so existing runs keep the skill/tool contract they approved.
SET @au_old=(SELECT v.id FROM aid_runtime_module_agent_binding b
  JOIN aid_runtime_agent a ON a.id=b.runtime_agent_id AND a.current_version_id=b.active_version_id
  JOIN aid_runtime_agent_version v ON v.agent_id=a.id AND v.id=b.active_version_id
  WHERE @au_version_id IS NOT NULL AND b.module_code='UNIVERSAL' AND b.status='ACTIVE' AND b.del_flag='0'
    AND COALESCE(b.update_by,'') IN ('','system','community-starter')
    AND a.agent_code='universal_canvas_agent' AND a.owner_type='PLATFORM' AND a.status='0' AND a.del_flag='0'
    AND v.create_by='community-starter' AND v.version_code IN ('3.0.0-community-starter-v3','community-universal-model-options-v1')
    AND v.status='0' AND v.del_flag='0' AND v.publish_status='FROZEN'
    AND NOT EXISTS (SELECT 1 FROM aid_runtime_agent_skill_ref r WHERE r.agent_version_id=v.id AND r.skill_code='skill_authoring_flow')
    AND (SELECT COUNT(DISTINCT t.tool_code) FROM aid_runtime_agent_tool_ref t WHERE t.agent_version_id=v.id
      AND t.tool_code IN ('aid.skill.directory','aid.skill.read-resource','aid.skill.propose-draft-v2'))=3
  FOR UPDATE);
SET @au_agent_version='community-universal-skill-authoring-v1';
SET @au_agent_definition=(SELECT JSON_ARRAY_APPEND(JSON_SET(definition_json,'$.packageVersionCode',@au_agent_version),
  '$.skillBindings',JSON_OBJECT('skillCode',@au_code,'skillId',CAST(@au_skill AS CHAR),
    'skillVersionId',CAST(@au_version_id AS CHAR),'packageDigest',@au_digest))
  FROM aid_runtime_agent_version WHERE id=@au_old);
INSERT INTO aid_runtime_agent_version (agent_id,version_code,publish_status,instruction,model_config_json,input_schema_json,
  output_schema_json,definition_json,package_digest,status,del_flag,create_by,create_time,update_by,update_time)
SELECT agent_id,@au_agent_version,'FROZEN',instruction,model_config_json,input_schema_json,output_schema_json,@au_agent_definition,
  SHA2(CONCAT_WS(CHAR(10),instruction,model_config_json,input_schema_json,output_schema_json,@au_agent_definition),256),
  '0','0','community-starter',NOW(),'community-starter',NOW() FROM aid_runtime_agent_version WHERE id=@au_old;
SET @au_new_agent=IF(ROW_COUNT()=1,LAST_INSERT_ID(),NULL);
INSERT INTO aid_runtime_agent_skill_ref (agent_version_id,skill_id,skill_version_id,skill_code,package_digest)
SELECT @au_new_agent,skill_id,skill_version_id,skill_code,package_digest FROM aid_runtime_agent_skill_ref WHERE agent_version_id=@au_old;
INSERT INTO aid_runtime_agent_skill_ref (agent_version_id,skill_id,skill_version_id,skill_code,package_digest)
SELECT @au_new_agent,@au_skill,@au_version_id,@au_code,@au_digest FROM DUAL WHERE @au_new_agent IS NOT NULL;
INSERT INTO aid_runtime_agent_tool_ref (agent_version_id,tool_code,contract_version,schema_digest)
SELECT @au_new_agent,tool_code,contract_version,schema_digest FROM aid_runtime_agent_tool_ref WHERE agent_version_id=@au_old;
UPDATE aid_runtime_agent SET current_version_id=@au_new_agent WHERE agent_code='universal_canvas_agent' AND current_version_id=@au_old;
UPDATE aid_runtime_module_agent_binding SET active_version_id=@au_new_agent,binding_revision=binding_revision+1
WHERE module_code='UNIVERSAL' AND active_version_id=@au_old;
COMMIT;
