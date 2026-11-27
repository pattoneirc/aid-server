package com.aid.media.service;

import com.aid.common.core.domain.ApiErrorDetails;
import com.aid.common.core.domain.ApiErrorDetails.ReferenceImageIssue;
import com.aid.common.exception.ServiceException;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.media.dto.MediaTextGenerateRequest;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.media.dto.ReferenceAudioInput;
import com.aid.media.dto.ReferenceVideoInput;
import com.aid.media.provider.TextModelCapabilityValidator;
import com.aid.media.provider.ReferenceAudioLimiter;
import com.aid.media.util.ModelCapabilityResolver;
import com.aid.media.util.ModelInputCapabilityValidator;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** 共用输入校验层，只在存在相应限制时补齐旧素材的可信元数据。 */
@Service
@RequiredArgsConstructor
public class VerifiedMediaInputService {
    private static final BigDecimal MB = BigDecimal.valueOf(1024L * 1024L);
    private final VerifiedMediaMetadataService metadata;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private ManagedTextImageService managedImages;

    public void configured(AiModelConfigVo model, Object request) {
        com.aid.model.definition.ModelMaterialValidator.validate(model, request, metadata);
    }

    public void image(AiModelConfigVo model, MediaImageGenerateRequest request) {
        configured(model, request);
        JsonNode root = ModelCapabilityResolver.parseCapability(model.getCapabilityJson());
        List<JsonNode> rules = rules(root, ModelInputCapabilityValidator.imageScene(model, request));
        Set<String> images = new LinkedHashSet<>();
        collect(images, request.getReferenceImageUrl());
        collectOptions(images, request.getOptions(), "referenceImages", "images", "key_images", "image_settings");
        long bytes = validateImages(images, rules);
        for (JsonNode rule : rules) range(rule, null, "maxInputMediaTotalFileSizeMb", BigDecimal.valueOf(bytes).divide(MB));
    }

    /** 报价从已授权素材快照一次收集参考图问题，不下载素材。 */
    public void validateVideoQuoteImages(AiModelConfigVo model, MediaVideoGenerateRequest request) {
        var snapshots = request.getQuoteReferenceImages();
        if (snapshots == null || snapshots.isEmpty()) return;
        JsonNode root = ModelCapabilityResolver.parseCapability(model.getCapabilityJson());
        List<JsonNode> rules = rules(root, ModelInputCapabilityValidator.videoScene(model, request));
        BigDecimal minimumRatio = rules.stream().map(rule -> positiveLimit(rule, "referenceImageMinAspectRatio"))
                .filter(Objects::nonNull).max(BigDecimal::compareTo).orElse(null);
        BigDecimal maximumRatio = minimumUpperLimit(rules, "referenceImageMaxAspectRatio");
        BigDecimal maximumSize = minimumUpperLimit(rules, "referenceImageMaxFileSizeMb");
        if (minimumRatio == null && maximumRatio == null && maximumSize == null) return;
        Set<String> missing = new LinkedHashSet<>();
        List<ReferenceImageIssue> problems = new ArrayList<>();
        int index = 0;
        for (var entry : snapshots.entrySet()) {
            index++;
            var image = entry.getValue();
            try {
                image.requireValid(entry.getKey(), "参考图");
            } catch (ServiceException rejected) {
                if (MediaPreparationErrorCode.read(rejected.getDetailMessage())
                        != MediaPreparationErrorCode.MEDIA_INPUT_METADATA_REQUIRED) throw rejected;
                missing.add(image.getResourceId().toString());
                continue;
            }
            String id = image.getResourceId().toString();
            int width = image.getWidth();
            int height = image.getHeight();
            BigDecimal ratio = aspectRatio(width, height);
            if (outside(ratio, minimumRatio, maximumRatio)) {
                problems.add(new ReferenceImageIssue(id, index, "ASPECT_RATIO",
                        ratio.setScale(6, RoundingMode.HALF_UP).stripTrailingZeros(), minimumRatio, maximumRatio, width, height));
            }
            BigDecimal size = BigDecimal.valueOf(image.getFileSize()).divide(MB);
            if (outside(size, null, maximumSize)) {
                problems.add(new ReferenceImageIssue(id, index, "FILE_SIZE",
                        size.setScale(4, RoundingMode.HALF_UP).stripTrailingZeros(), null, maximumSize, width, height));
            }
        }
        if (!missing.isEmpty()) {
            throw MediaPreparationErrorCode.imageMetadataRequired("references", List.copyOf(missing));
        }
        if (!problems.isEmpty()) {
            long count = problems.stream().map(ReferenceImageIssue::resourceId).distinct().count();
            String message = "%d 张参考图需要调整".formatted(count);
            ApiErrorDetails details = new ApiErrorDetails();
            details.setErrorCode("VIDEO_QUOTE_REFERENCE_IMAGES_INVALID");
            details.setField("references");
            details.setReason(message);
            details.setReferenceImageIssues(problems);
            throw new ServiceException(message, 422).setClientErrorData(details)
                    .setDetailMessage(MediaPreparationErrorCode.MEDIA_INPUTS_INVALID.name());
        }
    }

    private static BigDecimal minimumUpperLimit(List<JsonNode> rules, String field) {
        return rules.stream().map(rule -> positiveLimit(rule, field))
                .filter(Objects::nonNull).min(BigDecimal::compareTo).orElse(null);
    }

    private static boolean outside(BigDecimal actual, BigDecimal minimum, BigDecimal maximum) {
        return minimum != null && actual.compareTo(minimum) < 0
                || maximum != null && actual.compareTo(maximum) > 0;
    }

    public void video(AiModelConfigVo model, MediaVideoGenerateRequest request) {
        configured(model, request);
        JsonNode root = ModelCapabilityResolver.parseCapability(model.getCapabilityJson());
        List<JsonNode> rules = rules(root, ModelInputCapabilityValidator.videoScene(model, request));
        Set<String> images = new LinkedHashSet<>();
        collect(images, request.getImageUrl());
        collectOptions(images, request.getOptions(), "referenceImages", "images", "key_images", "image_settings", "lastFrameImageUrl");
        long totalBytes = validateImages(images, rules);
        boolean dmc = "dmc-h3-video".equalsIgnoreCase(model.getProtocol());
        if (dmc) for (String image : images) {
            var actual = metadata.inspect(image, "image");
            if (actual.frameCount() != 1) throw new ServiceException("DMC 仅支持静态图片");
        }
        JsonNode frameRatioLimit = root.path("maxFrameAspectRatioDifference");
        if (frameRatioLimit.isNumber() && frameRatioLimit.decimalValue().signum() > 0 && request.getImageUrl() != null
                && request.getOptions() != null && request.getOptions().get("lastFrameImageUrl") instanceof String last) {
            var firstMeta = metadata.inspect(request.getImageUrl(), "image");
            var lastMeta = metadata.inspect(last, "image");
            if (firstMeta.height() <= 0 || lastMeta.height() <= 0) throw new ServiceException("首尾帧尺寸无效");
            BigDecimal firstRatio = BigDecimal.valueOf(firstMeta.width()).divide(BigDecimal.valueOf(firstMeta.height()), 12, RoundingMode.HALF_UP);
            BigDecimal lastRatio = BigDecimal.valueOf(lastMeta.width()).divide(BigDecimal.valueOf(lastMeta.height()), 12, RoundingMode.HALF_UP);
            if (firstRatio.signum() == 0 || firstRatio.subtract(lastRatio).abs().divide(firstRatio, 8, RoundingMode.HALF_UP)
                    .compareTo(frameRatioLimit.decimalValue()) > 0) throw new ServiceException("首尾帧比例不符");
        }
        if (request.getReferenceAudios() != null) {
            ReferenceAudioLimiter.limit(request.getReferenceAudios(), model, model.getModelCode());
            if (!request.getReferenceAudios().isEmpty() && !ReferenceAudioLimiter.readCapability(model).isUsable()) {
                throw new ServiceException("模型不支持参考音频");
            }
            BigDecimal totalAudioSeconds = BigDecimal.ZERO;
            Set<String> audioUrls = new LinkedHashSet<>();
            for (ReferenceAudioInput audio : request.getReferenceAudios()) {
                if (audio == null) throw new ServiceException("参考音频无效");
                var actual = metadata.inspect(audio.getSampleUrl(), "audio");
                if (dmc && !("aac".equals(actual.codec()) || "mp3".equals(actual.codec())
                        || "pcm_s16le".equals(actual.codec()) || "pcm_s24le".equals(actual.codec())
                        || "pcm_f32le".equals(actual.codec()))) throw new ServiceException("参考音频编码不支持");
                audio.setDurationMs(actual.durationSeconds().multiply(BigDecimal.valueOf(1000)).setScale(0, RoundingMode.CEILING).intValueExact());
                audio.setFormat(actual.format());
                for (JsonNode rule : rules) validate(actual, rule, "referenceAudio");
                if (audioUrls.add(audio.getSampleUrl())) {
                    JsonNode clip = root.path("referenceAudioClipDurationSeconds");
                    BigDecimal counted = clip.isNumber() && clip.decimalValue().signum() > 0
                            ? actual.durationSeconds().min(clip.decimalValue()) : actual.durationSeconds();
                    totalAudioSeconds = totalAudioSeconds.add(counted);
                    totalBytes = Math.addExact(totalBytes, actual.sizeBytes());
                }
            }
            for (JsonNode rule : rules) range(rule, null, "referenceAudioMaxTotalDurationSeconds", totalAudioSeconds);
        }
        Set<String> videos = new LinkedHashSet<>();
        if (dmc && request.getResolvedReferenceVideos() != null) {
            for (ReferenceVideoInput video : request.getResolvedReferenceVideos()) {
                var actual = metadata.inspect(video.getVideoUrl(), "video");
                if (!Set.of("h264", "hevc").contains(actual.codec())) throw new ServiceException("参考视频编码不支持");
                if (actual.sizeBytes() > 50_000_000L) throw new ServiceException("参考视频文件过大");
            }
        }
        collectOptions(videos, request.getOptions(), "referenceVideos", "videos", "featureVideoUrl", "referenceVideoUrl", "baseVideoUrl", "inputVideoUrl", "videoUrl", "video_url");
        if (videos.isEmpty()) {
            for (JsonNode rule : rules) range(rule, null, "maxInputMediaTotalFileSizeMb", BigDecimal.valueOf(totalBytes).divide(MB));
            return;
        }
        if (!"tokendance".equalsIgnoreCase(model.getProviderCode())
                && !com.aid.model.definition.ModelMaterialStatistics.required(model.getResolvedDefinition())
                && rules.stream().noneMatch(rule -> requiresMetadata(rule, "referenceVideo") || requiresMetadata(rule, "maxInputMediaTotal"))) return;
        List<ReferenceVideoInput> resolved = new ArrayList<>();
        Map<String, ReferenceVideoInput> prior = new LinkedHashMap<>();
        if (request.getResolvedReferenceVideos() != null) request.getResolvedReferenceVideos().forEach(value -> prior.put(value.getVideoUrl(), value));
        BigDecimal total = BigDecimal.ZERO;
        List<BigDecimal> durations = new ArrayList<>();
        for (String video : videos) {
            ReferenceVideoInput known = prior.get(video);
            if (known == null || known.getDurationMs() == null || known.getFileSizeBytes() == null || known.getWidth() == null || known.getHeight() == null || known.getFps() == null || known.getFormat() == null) {
                var actual = metadata.inspect(video, "video");
                known = new ReferenceVideoInput(known == null ? null : known.getRecordId(), video,
                        actual.durationSeconds().multiply(BigDecimal.valueOf(1000)).setScale(0, RoundingMode.CEILING).longValueExact(),
                        actual.sizeBytes(), actual.width(), actual.height(), actual.fps(), actual.format());
            }
            resolved.add(known);
            totalBytes = Math.addExact(totalBytes, known.getFileSizeBytes());
            BigDecimal seconds = BigDecimal.valueOf(known.getDurationMs()).divide(BigDecimal.valueOf(1000));
            total = total.add(seconds);
            durations.add(seconds);
        }
        request.setResolvedReferenceVideos(resolved);
        Map<String, Object> options = new LinkedHashMap<>(request.getOptions());
        options.put("referenceVideoDurations", durations);
        options.put("referenceVideoSeconds", total);
        options.put("inputVideoSeconds", total);
        request.setOptions(options);
        for (JsonNode rule : rules) range(rule, null, "maxInputMediaTotalFileSizeMb", BigDecimal.valueOf(totalBytes).divide(MB));
    }

    public void normalizeText(AiModelConfigVo model, MediaTextGenerateRequest request, boolean verifyMetadata) {
        TextModelCapabilityValidator.normalizeAndValidate(model, request, verifyMetadata,
                metadata::isConfiguredStorageUrl);
    }

    public void text(AiModelConfigVo model, MediaTextGenerateRequest request) {
        configured(model, request);
        TextModelCapabilityValidator.validateStructure(model, request, metadata::isConfiguredStorageUrl);
        if (request.getMessages() == null) return;
        JsonNode capability = ModelCapabilityResolver.parseCapability(model.getCapabilityJson());
        BigDecimal totalBytes = BigDecimal.ZERO;
        for (var message : request.getMessages()) {
            if (message == null || message.getParts() == null) continue;
            for (var part : message.getParts()) {
                String type = part.getType().toLowerCase(Locale.ROOT);
                if (!Set.of("image", "audio", "video").contains(type)) continue;
                String title = type.substring(0, 1).toUpperCase(Locale.ROOT) + type.substring(1);
                if (ManagedTextImageService.isReference(part.getUrl())) {
                    if (!"image".equals(type) || managedImages == null) throw new com.aid.common.exception.ServiceException("内部图片引用不可用于当前输入");
                    var image = managedImages.resolve(request.getUserId(), part.getUrl());
                    var actual = new VerifiedMediaMetadataService.Metadata(image.bytes().length, null, image.width(), image.height(), null,
                            image.mimeType().substring("image/".length()), null, 1);
                    part.setSizeBytes(actual.sizeBytes()); part.setWidth(actual.width()); part.setHeight(actual.height()); part.setMimeType(image.mimeType());
                    totalBytes = totalBytes.add(BigDecimal.valueOf(actual.sizeBytes()));
                    validate(actual, capability, "inputImage");
                    continue;
                }
                if (!requiresMetadata(capability, "maxInput" + title) && !requiresMetadata(capability, "input" + title)
                        && !requiresMetadata(capability, "maxInputMediaTotal")) continue;
                var actual = metadata.inspect(part.getUrl(), type);
                totalBytes = totalBytes.add(BigDecimal.valueOf(actual.sizeBytes()));
                part.setSizeBytes(actual.sizeBytes());
                part.setDurationSeconds(actual.durationSeconds() == null ? null : actual.durationSeconds().doubleValue());
                part.setWidth(actual.width() > 0 ? actual.width() : null);
                part.setHeight(actual.height() > 0 ? actual.height() : null);
                part.setFps(actual.fps() == null || actual.fps().signum() <= 0
                        ? null : actual.fps().doubleValue());
                part.setMimeType(type + "/" + actual.format());
                validate(actual, capability, "input" + title);
            }
        }
        if (capability != null) range(capability, null, "maxInputMediaTotalFileSizeMb", totalBytes.divide(MB));
    }

    private long validateImages(Set<String> images, List<JsonNode> rules) {
        if (rules.stream().noneMatch(rule -> requiresMetadata(rule, "referenceImage") || requiresMetadata(rule, "maxInputMediaTotal"))) return 0L;
        long bytes = 0;
        int index = 0;
        for (String url : images) {
            index++;
            var actual = metadata.inspect(url, "image");
            bytes = Math.addExact(bytes, actual.sizeBytes());
            for (JsonNode rule : rules) {
                validate(actual, rule, "referenceImage");
                validateReferenceImageAspectRatio(rule, actual.width(), actual.height(), index);
            }
        }
        return bytes;
    }

    private boolean requiresMetadata(JsonNode rule, String prefix) {
        if (rule == null || !rule.isObject()) return false;
        var fields = rule.fields();
        while (fields.hasNext()) {
            var field = fields.next();
            String key = field.getKey();
            if (key.startsWith(prefix) && (key.contains("Duration") || key.contains("FileSize") || key.contains("SizeMB") || key.contains("Dimension")
                    || key.contains("Width") || key.contains("Height") || key.contains("AspectRatio") || key.contains("Pixels") || key.contains("Fps") || key.endsWith("Formats"))) {
                JsonNode value = field.getValue();
                if (value.isNumber() && value.decimalValue().signum() > 0 || value.isArray() && !value.isEmpty()) return true;
            }
        }
        return false;
    }

    private void validate(VerifiedMediaMetadataService.Metadata value, JsonNode rule, String prefix) {
        range(rule, null, prefix + "MaxFileSizeMb", BigDecimal.valueOf(value.sizeBytes()).divide(MB));
        range(rule, prefix + "MinDurationSeconds", null, value.durationSeconds());
        JsonNode clip = rule.path(prefix + "ClipDurationSeconds");
        BigDecimal counted = value.durationSeconds() != null && clip.isNumber() && clip.decimalValue().signum() > 0
                ? value.durationSeconds().min(clip.decimalValue()) : value.durationSeconds();
        range(rule, null, prefix + "MaxDurationSeconds", counted);
        range(rule, prefix + "MinDimensionPixels", prefix + "MaxDimensionPixels", BigDecimal.valueOf(value.width()));
        range(rule, prefix + "MinDimensionPixels", prefix + "MaxDimensionPixels", BigDecimal.valueOf(value.height()));
        range(rule, prefix + "MinWidth", prefix + "MaxWidth", BigDecimal.valueOf(value.width()));
        range(rule, prefix + "MinHeight", prefix + "MaxHeight", BigDecimal.valueOf(value.height()));
        range(rule, prefix + "MinFps", prefix + "MaxFps", value.fps());
        range(rule, prefix + "MinPixels", prefix + "MaxPixels", BigDecimal.valueOf(value.width()).multiply(BigDecimal.valueOf(value.height())));
        if (!"referenceImage".equals(prefix)) {
            range(rule, prefix + "MinAspectRatio", prefix + "MaxAspectRatio",
                    aspectRatio(value.width(), value.height()));
        }
        JsonNode formats = rule.path(prefix + "Formats");
        if (formats.isArray() && !formats.isEmpty()) {
            boolean accepted = false;
            for (JsonNode item : formats) if ("*".equals(item.asText()) || normalize(item.asText()).equals(normalize(value.format()))) accepted = true;
            if (!accepted) throw new ServiceException("素材格式不支持");
        }
    }

    private void validateReferenceImageAspectRatio(JsonNode rule, int width, int height, int index) {
        BigDecimal minimum = positiveLimit(rule, "referenceImageMinAspectRatio");
        BigDecimal maximum = positiveLimit(rule, "referenceImageMaxAspectRatio");
        if (minimum == null && maximum == null) return;
        BigDecimal actual = aspectRatio(width, height);
        if (actual == null) throw new ServiceException("参考图尺寸无效");
        if (outside(actual, minimum, maximum)) {
            String allowed = minimum == null ? "不超过" + maximum.stripTrailingZeros().toPlainString()
                    : maximum == null ? "至少" + minimum.stripTrailingZeros().toPlainString()
                    : minimum.stripTrailingZeros().toPlainString() + "至" + maximum.stripTrailingZeros().toPlainString();
            throw MediaPreparationErrorCode.MEDIA_INPUTS_INVALID.reject(
                    "第%d张参考图的宽高比为%s（%d×%d），要求%s。请裁剪或更换这张图。".formatted(
                            index, actual.setScale(6, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString(),
                            width, height, allowed));
        }
    }

    private static BigDecimal aspectRatio(int width, int height) {
        return height > 0 ? BigDecimal.valueOf(width)
                .divide(BigDecimal.valueOf(height), 12, RoundingMode.HALF_UP) : null;
    }

    private static BigDecimal positiveLimit(JsonNode rule, String key) {
        JsonNode value = rule.get(key);
        return value != null && value.isNumber() && value.decimalValue().signum() > 0
                ? value.decimalValue() : null;
    }

    private void range(JsonNode rule, String minKey, String maxKey, BigDecimal value) {
        JsonNode min = minKey == null ? null : rule.get(minKey);
        JsonNode max = maxKey == null ? null : rule.get(maxKey);
        boolean hasMin = min != null && min.isNumber() && min.decimalValue().signum() > 0;
        boolean hasMax = max != null && max.isNumber() && max.decimalValue().signum() > 0;
        if ((hasMin || hasMax) && value == null) throw new ServiceException("素材元数据不可用");
        if (hasMin && value.compareTo(min.decimalValue()) < 0 || hasMax && value.compareTo(max.decimalValue()) > 0) throw new ServiceException("素材参数超限");
    }

    private List<JsonNode> rules(JsonNode root, String scene) {
        if (root == null || !root.isObject()) return List.of();
        JsonNode specific = root.path("sceneRules").path(scene);
        return specific.isObject() ? List.of(root, specific) : List.of(root);
    }

    private String normalize(String value) {
        String normalized = value.toLowerCase(Locale.ROOT).replaceFirst("^(image|audio|video)/", "");
        return switch (normalized) { case "jpg" -> "jpeg"; case "tif" -> "tiff"; case "mpeg" -> "mp3"; case "heic" -> "heif"; default -> normalized; };
    }

    private void collectOptions(Set<String> result, Map<String, Object> options, String... keys) {
        if (options != null) for (String key : keys) collect(result, options.get(key));
    }

    private void collect(Set<String> result, Object value) {
        if (value instanceof String url && !url.isBlank()) result.add(url.trim());
        else if (value instanceof List<?> values) values.forEach(item -> collect(result, item));
        else if (value instanceof Map<?, ?> object) {
            for (String key : List.of("url", "image_url", "imageUrl", "key_image", "keyImage", "video_url", "videoUrl")) {
                if (object.get(key) != null) { collect(result, object.get(key)); return; }
            }
        }
    }
}
