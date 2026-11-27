package com.aid.model.requestlog;

import com.aid.common.config.AidAppConfig;
import com.aid.diagnostics.DiagnosticSanitizer;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.LongAdder;
import java.util.concurrent.locks.LockSupport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/** Bounded best-effort persistence. No filesystem or database operations on model request threads. */
@Service
public class ModelRequestLogStore {
    public static final Set<String> TYPES = Set.of("text", "image", "video", "audio", "music", "asr");
    public static final int BODY_LIMIT = 256 * 1024;
    private static final String FILE_PATTERN = "[0-9a-f-]{36}\\.json";
    private static final String LOCATION = "aid-model-request-logs";
    private static final Logger LOG = LoggerFactory.getLogger(ModelRequestLogStore.class);
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final DiagnosticSanitizer sanitizer;
    private final Path configuredRoot;
    private final RequestLogQueue<Record> queue = new RequestLogQueue<>(256, 32L * 1024 * 1024);
    private final LongAdder failed = new LongAdder();
    private volatile Settings policy = new Settings(Set.of(), 7, 512, false, "");
    private volatile boolean stopped;
    private Thread writer;

    public record Settings(Set<String> enabledTypes, int retentionDays, int maxMiB,
                           boolean customStorage, String storageDirectory) {}
    public record Status(Settings settings, String effectiveDirectory, long dropped, long failed) {}
    public record Page(List<Map<String, Object>> records, String nextCursor) {}
    record Record(String modelCode, String providerCode, String modelType, String operation,
                  Long taskId, Long businessId, String businessType, Instant started, long elapsedMs,
                  String status, Map<String, Object> body, List<String> secrets) {}

    public ModelRequestLogStore(JdbcTemplate jdbc, ObjectMapper json, DiagnosticSanitizer sanitizer,
                                @Value("${aid.model-request-log.directory:}") String directory) {
        this.jdbc = jdbc;
        this.json = json;
        this.sanitizer = sanitizer;
        this.configuredRoot = directory.isBlank() ? null : Path.of(directory);
    }

    @PostConstruct
    void start() {
        refresh();
        writer = new Thread(this::consume, "model-request-log-writer");
        writer.setDaemon(true);
        writer.start();
    }

    @PreDestroy
    void stop() {
        stopped = true;
        if (writer != null) LockSupport.unpark(writer);
    }

    public boolean enabled(String type) {
        return type != null && policy.enabledTypes().contains(type.toLowerCase(Locale.ROOT));
    }

    boolean anyEnabled() {
        return !policy.enabledTypes().isEmpty();
    }

    void offer(Record record, long bytes) {
        if (stopped || !enabled(record.modelType())) return;
        if (queue.offer(bytes, () -> stopped ? null : record)) LockSupport.unpark(writer);
    }

    void drop() { failed.increment(); }

    public Status status() {
        Settings current = policy;
        return new Status(current, rootFor(current).toString(), queue.droppedCount(), failed.sum());
    }

    public synchronized Status save(Settings settings) throws IOException {
        Settings valid = validate(settings);
        // A bad mount is reported while saving. It never affects model generation.
        if (!valid.enabledTypes().isEmpty()) writableRoot(rootFor(valid));
        byte[] payload = json.writeValueAsBytes(valid);
        jdbc.update("INSERT INTO aid_model_request_log_policy(id,settings_json) VALUES(1,?) "
                + "ON DUPLICATE KEY UPDATE settings_json=VALUES(settings_json)",
                new String(payload, StandardCharsets.UTF_8));
        policy = valid;
        return status();
    }

    @Scheduled(fixedDelay = 15000, initialDelay = 15000)
    synchronized void refresh() {
        try {
            var found = jdbc.queryForList("SELECT settings_json FROM aid_model_request_log_policy WHERE id=1", String.class);
            if (found.isEmpty()) {
                policy = new Settings(Set.of(), 7, 512, false, "");
            } else {
                policy = validate(json.readValue(found.get(0), Settings.class));
            }
        } catch (Exception failure) {
            Settings current = policy;
            if (!current.enabledTypes().isEmpty()) {
                policy = new Settings(Set.of(), current.retentionDays(), current.maxMiB(),
                        current.customStorage(), current.storageDirectory());
                LOG.warn("Model request log policy could not be read. Capture paused.");
            }
        }
    }

    static Settings validate(Settings settings) {
        if (settings == null || settings.enabledTypes() == null || !TYPES.containsAll(settings.enabledTypes())
                || settings.retentionDays() < 1 || settings.retentionDays() > 90
                || settings.maxMiB() < 32 || settings.maxMiB() > 16384) {
            throw new IllegalArgumentException("日志设置不符合范围");
        }
        String directory = settings.storageDirectory() == null ? "" : settings.storageDirectory().trim();
        if (directory.length() > 512 || directory.indexOf('\0') >= 0
                || (settings.customStorage() && (directory.isBlank() || !Path.of(directory).isAbsolute()))) {
            throw new IllegalArgumentException("请填写服务器上的绝对目录");
        }
        return new Settings(Set.copyOf(settings.enabledTypes()), settings.retentionDays(), settings.maxMiB(),
                settings.customStorage(), directory);
    }

    public Page list(String type, String provider, String model, Long before, int pageSize) {
        int limit = Math.max(1, Math.min(100, pageSize));
        StringBuilder sql = new StringBuilder("""
                SELECT CAST(id AS CHAR) AS id, model_code AS modelCode, provider_code AS providerCode,
                  model_type AS modelType, operation, CAST(task_id AS CHAR) AS taskId,
                  CAST(business_id AS CHAR) AS businessId, business_type AS businessType,
                  started_at AS startedAt, elapsed_ms AS elapsedMs, status
                FROM aid_model_request_log WHERE 1=1
                """);
        List<Object> args = new ArrayList<>();
        filter(sql, args, "model_type", type);
        filter(sql, args, "provider_code", provider);
        filter(sql, args, "model_code", model);
        if (before != null) { sql.append(" AND id<?"); args.add(before); }
        sql.append(" ORDER BY aid_model_request_log.id DESC LIMIT ?");
        args.add(limit + 1);
        List<Map<String, Object>> rows = jdbc.queryForList(sql.toString(), args.toArray());
        String next = rows.size() > limit ? String.valueOf(rows.get(limit - 1).get("id")) : null;
        return new Page(List.copyOf(rows.subList(0, Math.min(limit, rows.size()))), next);
    }

    public String detail(long id) throws IOException {
        var rows = jdbc.queryForList("SELECT storage_dir,file_name,file_bytes FROM aid_model_request_log WHERE id=?", id);
        if (rows.isEmpty()) throw new java.io.FileNotFoundException("日志已清理");
        var row = rows.get(0);
        Path file = storedFile((String) row.get("storage_dir"), (String) row.get("file_name"));
        long bytes = ((Number) row.get("file_bytes")).longValue();
        if (bytes < 1 || bytes > BODY_LIMIT || Files.size(file) != bytes) throw new IOException("日志正文不可用");
        try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            byte[] data = input.readNBytes(BODY_LIMIT + 1);
            if (data.length != bytes || json.readTree(data) == null) throw new IOException("日志正文不完整");
            return new String(data, StandardCharsets.UTF_8);
        }
    }

    private static void filter(StringBuilder sql, List<Object> args, String column, String value) {
        if (value != null && !value.isBlank()) {
            sql.append(" AND ").append(column).append("=?");
            args.add(value.trim());
        }
    }

    private void consume() {
        while (!stopped) {
            var item = queue.poll();
            if (item == null) {
                LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(250));
                continue;
            }
            try {
                if (enabled(item.value().modelType())) persist(item.value());
            } catch (Exception failure) {
                failed.increment();
                if (failed.sum() == 1 || failed.sum() % 100 == 0)
                    LOG.warn("Model request log write failed ({}).", failure.getClass().getSimpleName());
            } finally { queue.complete(item); }
        }
    }

    private void persist(Record record) throws IOException {
        Settings current = policy;
        Path root = writableRoot(rootFor(current));
        if (Files.getFileStore(root).getUsableSpace() < 64L * 1024 * 1024) {
            failed.increment();
            return;
        }
        String source = json.writeValueAsString(record.body());
        for (String secret : record.secrets()) {
            if (secret == null || secret.isBlank()) continue;
            String encoded = json.writeValueAsString(secret);
            source = source.replace(encoded.substring(1, encoded.length() - 1), "[已过滤]");
        }
        byte[] body = json.writeValueAsBytes(sanitizer.clean(json.readValue(source, Map.class)));
        if (body.length > BODY_LIMIT) { failed.increment(); return; }
        String name = UUID.randomUUID() + ".json";
        Path file = root.resolve(name);
        Path temp;
        if (root.getFileSystem().supportedFileAttributeViews().contains("posix"))
            temp = Files.createTempFile(root, ".pending-", ".tmp", PosixFilePermissions.asFileAttribute(
                    PosixFilePermissions.fromString("rw-------")));
        else temp = Files.createTempFile(root, ".pending-", ".tmp");
        boolean indexed = false;
        try {
            try (var out = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(body);
                while (buffer.hasRemaining()) out.write(buffer);
                out.force(true);
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE);
            if (!enabled(record.modelType())) return;
            jdbc.update("""
                    INSERT INTO aid_model_request_log
                    (model_code,provider_code,model_type,operation,task_id,business_id,business_type,
                     started_at,elapsed_ms,status,storage_dir,file_name,file_bytes)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, record.modelCode(), record.providerCode(), record.modelType(), record.operation(),
                    record.taskId(), record.businessId(), record.businessType(), Timestamp.from(record.started()),
                    record.elapsedMs(), record.status(), current.customStorage() ? root.toString() : "", name, body.length);
            indexed = true;
        } finally {
            Files.deleteIfExists(temp);
            if (!indexed) Files.deleteIfExists(file);
        }
    }

    @Scheduled(fixedDelay = 60000, initialDelay = 60000)
    void clean() {
        try {
            Settings current = policy;
            long budget = current.maxMiB() * 1024L * 1024;
            Long used = jdbc.queryForObject("SELECT COALESCE(SUM(file_bytes),0) FROM aid_model_request_log", Long.class);
            long remaining = used == null ? 0 : used;
            Timestamp cutoff = Timestamp.from(Instant.now().minusSeconds(current.retentionDays() * 86400L));
            int batches = 0;
            for (; batches < 4; batches++) {
                var rows = remaining > budget
                        ? jdbc.queryForList("SELECT id,storage_dir,file_name,file_bytes FROM aid_model_request_log ORDER BY id LIMIT 250")
                        : jdbc.queryForList("SELECT id,storage_dir,file_name,file_bytes FROM aid_model_request_log "
                                + "WHERE started_at<? ORDER BY started_at,id LIMIT 250", cutoff);
                if (rows.isEmpty()) break;
                for (var row : rows) {
                    Path file = storedFile((String) row.get("storage_dir"), (String) row.get("file_name"));
                    Files.deleteIfExists(file);
                    jdbc.update("DELETE FROM aid_model_request_log WHERE id=?", row.get("id"));
                    remaining -= ((Number) row.get("file_bytes")).longValue();
                }
            }
            cleanupIncomplete(rootFor(current));
        } catch (Exception failure) {
            LOG.debug("Model request log retention skipped ({})", failure.getClass().getSimpleName());
        }
    }

    private void cleanupIncomplete(Path root) throws IOException {
        if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) return;
        Path canonical = verifyRoot(root);
        var stale = Instant.now().minusSeconds(3600);
        try (var files = Files.newDirectoryStream(canonical, ".pending-*.tmp")) {
            for (Path file : files) {
                if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                        && Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toInstant().isBefore(stale))
                    Files.deleteIfExists(file);
            }
        }
    }

    private Path rootFor(Settings settings) {
        if (settings.customStorage()) return Path.of(settings.storageDirectory()).normalize().resolve(LOCATION);
        return defaultRoot();
    }

    private Path defaultRoot() {
        if (configuredRoot != null) return configuredRoot.toAbsolutePath().normalize();
        return Path.of(AidAppConfig.getPrivateProfile()).toAbsolutePath().normalize().resolve(LOCATION);
    }

    private static Path writableRoot(Path root) throws IOException {
        verifyRoot(root);
        Files.createDirectories(root);
        return verifyRoot(root);
    }

    private static Path verifyRoot(Path root) throws IOException {
        Path absolute = root.toAbsolutePath().normalize();
        Path publicRoot = Path.of(AidAppConfig.getProfile()).toAbsolutePath().normalize();
        if (absolute.startsWith(publicRoot) || publicRoot.startsWith(absolute))
            throw new IOException("日志目录必须与公开资源目录分离");
        if (!LOCATION.equals(absolute.getFileName().toString()))
            throw new IOException("日志目录名称无效");
        for (Path cursor = absolute; cursor != null; cursor = cursor.getParent()) {
            if (Files.isSymbolicLink(cursor)) throw new IOException("日志目录包含链接");
        }
        return absolute;
    }

    private Path storedFile(String root, String name) throws IOException {
        if (name == null || !name.matches(FILE_PATTERN)) throw new IOException("日志文件标识无效");
        Path file = verifyRoot(root.isEmpty() ? defaultRoot() : Path.of(root)).resolve(name);
        if (Files.isSymbolicLink(file)) throw new IOException("日志文件包含链接");
        return file;
    }
}
