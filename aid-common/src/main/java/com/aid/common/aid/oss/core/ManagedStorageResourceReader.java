package com.aid.common.aid.oss.core;

import com.aid.common.aid.oss.config.OssConfigManager;
import com.aid.common.aid.oss.properties.OssProperties;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.common.config.AidAppConfig;
import com.aid.common.constant.Constants;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Storage read facade. Callers must first establish business authorization for the locator. */
@Slf4j
@Component
@RequiredArgsConstructor
public class ManagedStorageResourceReader {
    private final OssConfigManager config;
    private final OssTemplate storage;
    private final MediaUrlResolver resolver;

    public record Content(byte[] bytes, boolean truncated, Integer httpStatus, String failureKind) {
        static Content failure(Integer status, String kind) { return new Content(new byte[0], false, status, kind); }
    }

    private interface ReadStrategy {
        boolean supports(String mode);
        Content read(String locator, int maxBytes, int timeoutMs) throws Exception;
    }

    public Content read(String locator, int maxBytes, int timeoutMs) {
        if (locator == null || locator.isBlank() || maxBytes < 1 || timeoutMs < 1)
            return Content.failure(null, "INVALID_READ_ARGUMENTS");
        try {
            if (!resolver.isSiteMediaUrl(locator) || !storage.isManagedResourceUrl(locator))
                return Content.failure(null, "UNMANAGED_RESOURCE");
            OssProperties properties = config.getOssProperties();
            String mode = properties == null || properties.getUploadMode() == null ? ""
                    : properties.getUploadMode().toLowerCase(Locale.ROOT);
            List<ReadStrategy> strategies = List.of(new LocalReadStrategy(properties), new ObjectStorageReadStrategy());
            for (ReadStrategy strategy : strategies)
                if (strategy.supports(mode)) return strategy.read(locator, maxBytes, timeoutMs);
            return Content.failure(null, "STORAGE_MODE_UNSUPPORTED");
        } catch (Exception failure) {
            // A signed storage URL can contain credentials; never log URLs or exception messages here.
            log.warn("authorized storage read failed, failureKind={}", failure.getClass().getSimpleName());
            return Content.failure(null, failure.getClass().getSimpleName());
        }
    }

    private final class LocalReadStrategy implements ReadStrategy {
        private final OssProperties properties;

        private LocalReadStrategy(OssProperties properties) {
            this.properties = properties;
        }

        @Override public boolean supports(String mode) { return "local".equals(mode); }
        @Override public Content read(String locator, int maxBytes, int timeoutMs) throws Exception {
            String prefix = Constants.RESOURCE_PREFIX + "/";
            String relative = locator;
            if (!locator.startsWith("/")) {
                String publicPrefix = URI.create(properties.getEffectiveResourceAccessDomain()).getRawPath() + "/";
                String publicPath = URI.create(locator).getRawPath();
                if (publicPath == null || !publicPath.startsWith(publicPrefix))
                    return Content.failure(null, "LOCAL_PATH_INVALID");
                relative = prefix + publicPath.substring(publicPrefix.length());
            }
            if (!relative.startsWith(prefix) || relative.contains("..") || relative.contains("\\")
                    || AidAppConfig.getProfile() == null)
                return Content.failure(null, "LOCAL_PATH_INVALID");
            Path base = Path.of(AidAppConfig.getProfile()).toRealPath();
            Path file = base.resolve(relative.substring(prefix.length())).normalize().toRealPath();
            if (!file.startsWith(base) || !Files.isRegularFile(file))
                return Content.failure(null, "LOCAL_PATH_OUTSIDE_STORAGE");
            try (InputStream stream = Files.newInputStream(file)) { return bounded(stream, maxBytes, null); }
        }
    }

    /** The existing storage facade selects the COS, OSS or Qiniu signing adapter. */
    private final class ObjectStorageReadStrategy implements ReadStrategy {
        @Override public boolean supports(String mode) { return Set.of("cos", "oss", "qiniu").contains(mode); }
        @Override public Content read(String locator, int maxBytes, int timeoutMs) throws Exception {
            String signed = storage.getSignedUrl(locator, 120);
            if (signed == null || signed.equals(locator)) return Content.failure(null, "STORAGE_READ_URL_UNAVAILABLE");
            URI uri = URI.create(signed);
            if (uri.getScheme() == null || !Set.of("http", "https").contains(uri.getScheme())
                    || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null)
                return Content.failure(null, "STORAGE_READ_URL_INVALID");
            // Only server-generated storage URLs may use the configured storage's private endpoint.
            // Arbitrary external URLs continue through the separate public-media downloader.
            HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(timeoutMs);
                connection.setReadTimeout(timeoutMs);
                int status = connection.getResponseCode();
                if (status != HttpURLConnection.HTTP_OK) return Content.failure(status, "HTTP_STATUS");
                if (connection.getContentLengthLong() > maxBytes)
                    return new Content(new byte[0], true, status, "BYTE_LIMIT");
                try (InputStream stream = connection.getInputStream()) { return bounded(stream, maxBytes, status); }
            } finally { connection.disconnect(); }
        }
    }

    private static Content bounded(InputStream stream, int maxBytes, Integer status) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maxBytes, 8192));
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) != -1) {
            int remaining = maxBytes - output.size();
            if (read > remaining) {
                output.write(chunk, 0, remaining);
                return new Content(output.toByteArray(), true, status, "BYTE_LIMIT");
            }
            output.write(chunk, 0, read);
        }
        return new Content(output.toByteArray(), false, status, null);
    }
}
