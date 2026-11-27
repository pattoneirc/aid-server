package com.aid.generation.service;

import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.util.StrUtil;
import com.aid.common.core.domain.ApiErrorDetails;
import com.aid.common.exception.ServiceException;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.generation.service.GenerationResourceResolver.ResolvedResource;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.media.dto.ReferenceAudioInput;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Shared projection of already-authorized resources; performs no lookup, quoting or submission. */
public final class GenerationVideoReferences {
    private GenerationVideoReferences() { }
    public static void apply(MediaVideoGenerateRequest mediaRequest, List<ResolvedResource> resources,
                             Map<String, Object> options, MediaUrlResolver mediaUrlResolver) {
        for (ResolvedResource resource : resources) {
            if ("DOCUMENT".equals(resource.mediaType())) throw new ServiceException("视频生成不支持文档素材");
            if ("FIRST_FRAME".equals(resource.role())) {
                if (!"IMAGE".equals(resource.mediaType()) || StrUtil.isNotBlank(mediaRequest.getImageUrl())) {
                    throw new ServiceException("首帧素材配置错误");
                }
                mediaRequest.setImageUrl(resource.url());
                if ("portrait_combination".equals(mediaRequest.getCapabilityCode())) {
                    mediaRequest.setBackgroundImageResourceId(resource.resourceId());
                }
            } else if ("LAST_FRAME".equals(resource.role())) {
                if (!"IMAGE".equals(resource.mediaType()) || options.containsKey("lastFrameImageUrl")) {
                    throw new ServiceException("尾帧素材配置错误");
                }
                options.put("lastFrameImageUrl", resource.url());
            }
        }
        List<String> referenceImages = urls(resources, "IMAGE", "REFERENCE");
        List<String> referenceVideos = urls(resources, "VIDEO", "REFERENCE");
        List<Long> referenceVideoResourceIds = resources.stream()
                .filter(resource -> "VIDEO".equals(resource.mediaType()) && "REFERENCE".equals(resource.role()))
                .map(ResolvedResource::resourceId).toList();
        if (!referenceVideoResourceIds.isEmpty()) {
            mediaRequest.setReferenceVideoResourceIds(referenceVideoResourceIds);
        }
        if (CollectionUtil.isNotEmpty(referenceImages)) options.put("referenceImages", referenceImages);
        if (CollectionUtil.isNotEmpty(referenceVideos)) options.put("referenceVideos", referenceVideos);
        List<ReferenceAudioInput> audios = new ArrayList<>();
        List<String> missingAudioMetadata = new ArrayList<>();
        int audioIndex = 0;
        for (ResolvedResource resource : resources) {
            if (!"AUDIO".equals(resource.mediaType())) continue;
            if (!"REFERENCE".equals(resource.role())) throw new ServiceException("音频素材角色错误");
            ReferenceAudioInput audio = new ReferenceAudioInput();
            audio.setIndex(++audioIndex);
            audio.setName(resource.mention());
            audio.setSourceType(ReferenceAudioInput.SOURCE_UPLOAD);
            audio.setReferenceAudioId(resource.resourceId());
            audio.setSampleUrl(mediaUrlResolver.toFullUrl(resource.url()));
            applyAudioMetadata(audio, resource.metadataJson());
            if (StrUtil.isBlank(audio.getFormat()) || audio.getDurationMs() == null) {
                missingAudioMetadata.add(resource.resourceId().toString());
            }
            audios.add(audio);
        }
        if (!missingAudioMetadata.isEmpty() && "reference_to_video".equals(mediaRequest.getCapabilityCode())) {
            ApiErrorDetails details = new ApiErrorDetails();
            details.setErrorCode("CANVAS_QUOTE_REFERENCE_AUDIO_METADATA_UNAVAILABLE");
            details.setField("references");
            details.setReason("参考音频缺少服务端确认的格式或时长");
            details.setRetryable(true);
            details.setResourceIds(missingAudioMetadata);
            throw new ServiceException("请先准备参考音频", 422).setClientErrorData(details);
        }
        mediaRequest.setReferenceAudios(audios);
        mediaRequest.setOptions(options);
    }

    private static void applyAudioMetadata(ReferenceAudioInput audio, String value) {
        if (StrUtil.isBlank(value)) return;
        try {
            JSONObject metadata = JSON.parseObject(value);
            if (metadata == null) return;
            String format = metadata.getString("format");
            BigDecimal duration = metadata.getBigDecimal("durationSeconds");
            if (format != null && format.matches("[a-z0-9][a-z0-9_-]{0,31}")
                    && duration != null && duration.signum() > 0) {
                audio.setDurationMs(duration.movePointRight(3).setScale(0, RoundingMode.HALF_UP).intValueExact());
                audio.setFormat(format);
            }
        } catch (RuntimeException invalidMetadata) {
            // Historical resources can prepare a fresh snapshot through the authorized resource endpoint.
        }
    }
    private static List<String> urls(List<ResolvedResource> resources, String mediaType, String role) {
        List<String> result = new ArrayList<>();
        for (ResolvedResource resource : resources) {
            if (mediaType.equals(resource.mediaType()) && role.equals(resource.role())) result.add(resource.url());
        }
        return result;
    }
}
