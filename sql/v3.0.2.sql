-- AID Studio v3.0.2
-- Idempotent model connection and opt-in request log upgrade.
-- 模型专属连接，已有模型默认使用原供应商配置。
SET @aid_model_conn_ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE()
    AND table_name = 'aid_ai_model' AND column_name = 'dedicated_connection_enabled'
), 'SELECT 1', 'ALTER TABLE aid_ai_model ADD COLUMN dedicated_connection_enabled TINYINT(1) NOT NULL DEFAULT 0');
PREPARE aid_model_conn_stmt FROM @aid_model_conn_ddl;
EXECUTE aid_model_conn_stmt;
DEALLOCATE PREPARE aid_model_conn_stmt;

SET @aid_model_conn_ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE()
    AND table_name = 'aid_ai_model' AND column_name = 'dedicated_connection_revision'
), 'SELECT 1', 'ALTER TABLE aid_ai_model ADD COLUMN dedicated_connection_revision BIGINT NULL');
PREPARE aid_model_conn_stmt FROM @aid_model_conn_ddl;
EXECUTE aid_model_conn_stmt;
DEALLOCATE PREPARE aid_model_conn_stmt;

CREATE TABLE IF NOT EXISTS aid_ai_model_connection (
  model_id BIGINT NOT NULL,
  revision BIGINT NOT NULL,
  base_url VARCHAR(1024) NOT NULL,
  encrypted_key TEXT NOT NULL,
  PRIMARY KEY (model_id, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='模型专属连接凭据版本';

-- Model request logs contain only searchable metadata. The separate policy has no enabled defaults.
CREATE TABLE IF NOT EXISTS `aid_model_request_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `model_code` VARCHAR(191) NOT NULL,
  `provider_code` VARCHAR(100) DEFAULT NULL,
  `model_type` VARCHAR(32) NOT NULL,
  `operation` VARCHAR(48) NOT NULL,
  `task_id` BIGINT DEFAULT NULL,
  `business_id` BIGINT DEFAULT NULL,
  `business_type` VARCHAR(64) DEFAULT NULL,
  `started_at` DATETIME(3) NOT NULL,
  `elapsed_ms` BIGINT NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `storage_dir` VARCHAR(768) NOT NULL,
  `file_name` CHAR(41) NOT NULL,
  `file_bytes` BIGINT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_model_request_log_file` (`file_name`),
  KEY `idx_model_request_log_type` (`model_type`, `id`),
  KEY `idx_model_request_log_provider` (`provider_code`, `id`),
  KEY `idx_model_request_log_model` (`model_code`, `id`),
  KEY `idx_model_request_log_time` (`started_at`, `id`),
  KEY `idx_model_request_log_bytes` (`file_bytes`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `aid_model_request_log_policy` (
  `id` TINYINT NOT NULL,
  `settings_json` TEXT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @model_log_parent := (SELECT MIN(`menu_id`) FROM `sys_menu` WHERE `parent_id`=0 AND `menu_type`='M' AND `path`='task');
INSERT INTO `sys_menu` (`menu_name`,`parent_id`,`order_num`,`path`,`component`,`menu_type`,`visible`,`status`,`perms`,`icon`,`create_by`,`create_time`,`remark`)
SELECT '模型请求日志',@model_log_parent,9,'model-request-log','aid/model-request-log/index','C','0','0','system:model-request-log:list','log','system',NOW(),'查询上游模型请求'
WHERE @model_log_parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `sys_menu` WHERE `perms`='system:model-request-log:list');
SET @model_log_menu := (SELECT MIN(`menu_id`) FROM `sys_menu` WHERE `perms`='system:model-request-log:list');
INSERT INTO `sys_menu` (`menu_name`,`parent_id`,`order_num`,`path`,`component`,`menu_type`,`visible`,`status`,`perms`,`icon`,`create_by`,`create_time`,`remark`)
SELECT '查看模型请求正文',@model_log_menu,1,'#','','F','0','0','system:model-request-log:detail','#','system',NOW(),''
WHERE @model_log_menu IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `sys_menu` WHERE `perms`='system:model-request-log:detail');
INSERT INTO `sys_menu` (`menu_name`,`parent_id`,`order_num`,`path`,`component`,`menu_type`,`visible`,`status`,`perms`,`icon`,`create_by`,`create_time`,`remark`)
SELECT '管理模型请求日志',@model_log_menu,2,'#','','F','0','0','system:model-request-log:manage','#','system',NOW(),''
WHERE @model_log_menu IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `sys_menu` WHERE `perms`='system:model-request-log:manage');
