package com.aid.media.provider.impl;


import cn.hutool.http.HttpRequest;
import cn.hutool.core.bean.BeanUtil;
import cn.hutool.http.HttpResponse;
import cn.hutool.json.JSONUtil;
import cn.hutool.json.JSONObject;
import com.aid.common.error.ErrorNormalizer;
import com.aid.common.error.TaskErrorSnapshot;
import com.aid.common.exception.ServiceException;
import com.aid.common.constant.HttpConstants;
import com.aid.common.utils.ProviderEndpointUtils;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.constants.MediaInternalOptionKeys;
import com.aid.media.constants.VolcengineConstants;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.media.dto.ReferenceAudioInput;
import com.aid.media.provider.ProviderSubmitResult;
import com.aid.media.provider.ProviderTaskResult;
import com.aid.media.provider.ReferenceAudioLimiter;
import com.aid.media.provider.ReferenceImageBase64Support;
import com.aid.media.provider.ReferenceImageLimiter;
import com.aid.media.provider.ReferencePromptSanitizer;
import com.aid.media.provider.VideoProviderClient;
import com.aid.media.util.ModelCapabilityResolver;
import com.aid.media.util.ModelCapabilityValidator;
import com.volcengine.ark.runtime.model.content.generation.CreateContentGenerationTaskRequest;
import com.volcengine.ark.runtime.model.content.generation.CreateContentGenerationTaskResult;
import com.volcengine.ark.runtime.model.content.generation.GetContentGenerationTaskResponse;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 火山引擎 Seedance 视频生成，复用官方 DTO 映射并按配置的 HTTP 路径提交与查询。
 */
@Slf4j
@Component
public class VolcengineVideoProviderClient implements VideoProviderClient {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    /** Seedance 2.0 多模态参考图官方上限 9；运营可在 capability_json.maxReferenceImages 覆盖。 */
    private static final int DEFAULT_MAX_REFERENCE_IMAGES = 9;
    private static final int DEFAULT_MAX_REFERENCE_VIDEOS = 10;

    private static final String SCENE_LEGACY = "legacy";
    private static final String SCENE_TEXT = "text";
    private static final String SCENE_FIRST_FRAME = "first_frame";
    private static final String SCENE_FIRST_LAST_FRAME = "first_last_frame";
    private static final String SCENE_REFERENCE = "reference";
    private static final String SCENE_EDIT = "edit";
    private static final String SCENE_EXTEND = "extend";

    private static final String OPTION_SERVICE_TIER = "service_tier";
    private static final String OPTION_EXECUTION_EXPIRES_AFTER = "execution_expires_after";
    private static final String OPTION_PRIORITY = "priority";
    private static final String OPTION_SAFETY_IDENTIFIER = "safety_identifier";
    private static final String OPTION_FRAMES = "frames";
    private static final String OPTION_DRAFT = "draft";
    private static final String OPTION_DRAFT_TASK_ID = "draft_task_id";
    private static final String OPTION_TOOLS = "tools";
    private static final Set<String> STRICT_ARK_OPTION_KEYS = Set.of(
            "lastFrameImageUrl", "endImageUrl", "end_image_url", "referenceImages", "images",
            "featureVideoUrl", "referenceVideoUrl", "baseVideoUrl", "inputVideoUrl", "videoUrl", "video_url",
            "referenceVideos", "videos", "referenceVideoDurations", "videoDurations", "inputVideoDurations",
            "inputVideoSeconds", "referenceVideoSeconds", "videoSeconds", "resolution", "size", "ratio",
            "aspect_ratio", "generate_audio", "audio", "seed", "enhance_prompt", "omni_reference_task_type",
            "generateMode", "start_end", "videoScenario", "operation");
    private static final Set<String> REQUEST_OPTION_KEYS = Set.of(
            "lastFrameImageUrl", "endImageUrl", "end_image_url",
            "referenceImages", "images",
            "featureVideoUrl", "referenceVideoUrl", "baseVideoUrl", "inputVideoUrl",
            "videoUrl", "video_url", "referenceVideos", "videos",
            "referenceVideoDurations", "videoDurations", "inputVideoDurations",
            "inputVideoSeconds", "referenceVideoSeconds", "videoSeconds",
            "resolution", "size", "ratio", "aspect_ratio",
            "generate_audio", "audio", "watermark", "seed", "camera_fixed",
            "return_last_frame", "callback_url", "omni_reference_task_type", "output_format",
            "generateMode", "start_end", "videoScenario", "operation",
            OPTION_SERVICE_TIER, OPTION_EXECUTION_EXPIRES_AFTER, OPTION_PRIORITY,
            OPTION_SAFETY_IDENTIFIER, OPTION_FRAMES, OPTION_DRAFT, OPTION_DRAFT_TASK_ID,
            OPTION_TOOLS);
    private static final Pattern FRACTIONAL_TIMESTAMP = Pattern.compile(
            "(?i)(?:第\\s*)?\\d+\\.\\d+\\s*(?:s|秒)");

    @Override
    public String protocol() {
        return VolcengineConstants.PROTOCOL_SEEDANCE_VIDEO;
    }

    @Override
    public Integer fallbackMaxReferenceImages(AiModelConfigVo modelConfig) {
        return DEFAULT_MAX_REFERENCE_IMAGES;
    }

    @Override
    public Integer fallbackMaxReferenceVideos(AiModelConfigVo modelConfig) {
        return DEFAULT_MAX_REFERENCE_VIDEOS;
    }

    @Override
    public boolean supportsProviderCode(String providerCode) {
        // 火山方舟 Seedance 视频：按 provider_code 精确归属
        return providerCode != null
                && VolcengineConstants.PROVIDER_CODE.equalsIgnoreCase(providerCode.trim());
    }

    @Override
    public ProviderSubmitResult submit(AiModelConfigVo modelConfig, MediaVideoGenerateRequest request) {
        boolean strictArk = usesStrictArkContract(modelConfig);
        if (strictArk) {
            // 内容构造会归一化提示词，任务快照仍使用入参。
            MediaVideoGenerateRequest outbound = new MediaVideoGenerateRequest();
            BeanUtil.copyProperties(request, outbound);
            request = outbound;
        }
        String effectiveModel = resolveEffectiveModel(modelConfig, request);
        List<CreateContentGenerationTaskRequest.Content> contents = buildContents(request, modelConfig);
        Object createRequest = strictArk ? buildStrictArkRequest(effectiveModel, contents, request, modelConfig, false)
                : buildCreateRequest(effectiveModel, contents, request, modelConfig);

        log.info("Volcengine 视频生成提交(Seedance), model={}, promptLen={}", effectiveModel,
                StringUtils.length(request.getPrompt()));

        String arkBody = null;
        if (strictArk) {
            try {
                arkBody = strictArkWireBody(OBJECT_MAPPER.writeValueAsString(createRequest), request);
            } catch (Exception ex) {
                return com.aid.media.provider.ProviderSubmissionFailures.localPreparationFailure(ex);
            }
        }
        CreateContentGenerationTaskResult result;
        try {
            String body = strictArk ? arkBody : com.aid.model.definition.ModelConfiguredRequestBody.applyJson(
                    modelConfig, OBJECT_MAPPER.writeValueAsString(createRequest), request);
            HttpResult response = doPost(buildSubmitUrl(modelConfig), modelConfig.getApiKey(),
                    body);
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.error("Volcengine 视频生成提交失败, model={}, httpStatus={}, responseLength={}",
                        effectiveModel, response.statusCode(), StringUtils.length(response.body()));
                if (strictArk) {
                    String id = com.aid.media.provider.ProviderResponseHelper.readText(
                            com.aid.media.provider.ProviderResponseHelper.readTree(response.body()),
                            "id", "details.generation_id", "error.details.generation_id");
                    if (StringUtils.isNotBlank(id)) {
                        ProviderSubmitResult accepted = com.aid.media.provider.ProviderSubmissionFailures
                                .unknownResponse("上游返回任务标识，继续查询确认结果");
                        accepted.setProviderTaskId(id);
                        return accepted;
                    }
                }
                ProviderSubmitResult rejection = com.aid.media.provider.ProviderSubmissionFailures.httpResponse(
                        response.statusCode(), response.body(), effectiveModel);
                if (strictArk && rejection.getConfirmedFailureCode() != null) {
                    applyStrictArkError(rejection, modelConfig, response.statusCode(), response.body());
                }
                return rejection;
            }
            com.fasterxml.jackson.databind.JsonNode envelope = OBJECT_MAPPER.readTree(response.body());
            if (envelope != null && envelope.path("error").isObject()) {
                if (StringUtils.isNotBlank(envelope.path("id").asText(null))) {
                    ProviderSubmitResult accepted = com.aid.media.provider.ProviderSubmissionFailures.unknownResponse(
                            "上游同时返回错误和任务标识，继续按任务标识核实结果");
                    accepted.setProviderTaskId(envelope.path("id").asText());
                    return accepted;
                }
                ProviderSubmitResult rejection = com.aid.media.provider.ProviderSubmissionFailures.reportedFailure(
                        response.body(), effectiveModel);
                if (strictArk && rejection.getConfirmedFailureCode() != null) {
                    applyStrictArkError(rejection, modelConfig, response.statusCode(), response.body());
                }
                return rejection;
            }
            result = OBJECT_MAPPER.readValue(response.body(), CreateContentGenerationTaskResult.class);
        } catch (Exception e) {
            log.error("Volcengine 视频生成提交失败, model={}", effectiveModel, e);
            return com.aid.media.provider.ProviderSubmissionFailures.unknownResponse(e.getMessage());
        }

        String taskId = result == null ? null : result.getId();
        if (StringUtils.isBlank(taskId))
            return com.aid.media.provider.ProviderSubmissionFailures.unknownResponse(
                    "上游提交响应未返回任务标识，无法按任务号核对结果");
        log.info("Volcengine 视频生成任务已创建, taskId={}", taskId);

        return ProviderSubmitResult.builder()
                .providerTaskId(taskId)
                .rawResponse(JSONUtil.toJsonStr(result))
                .build();
    }

    @Override
    public ProviderTaskResult query(AiModelConfigVo modelConfig, String providerTaskId) {
        String raw;
        try {
            HttpResult response = doGet(buildQueryUrl(modelConfig, providerTaskId), modelConfig.getApiKey());
            raw = response.body();
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn("Volcengine 视频生成查询HTTP异常, taskId={}, httpStatus={}, responseLength={}",
                        providerTaskId, response.statusCode(), StringUtils.length(raw));
                return ProviderTaskResult.builder()
                        .status(VolcengineConstants.TASK_STATUS_PROCESSING)
                        .errorMessage("上游查询暂不可用")
                        .rawResponse(raw)
                        .querySuccessful(Boolean.FALSE)
                        .terminalConfirmed(Boolean.FALSE)
                        .build();
            }
            return parseQueryResponse(modelConfig, raw, providerTaskId);
        } catch (Exception e) {
            log.error("Volcengine 视频生成查询失败, taskId={}", providerTaskId, e);
            return ProviderTaskResult.builder()
                    .status(VolcengineConstants.TASK_STATUS_PROCESSING)
                    .errorMessage("上游查询暂不可用")
                    .querySuccessful(Boolean.FALSE)
                    .terminalConfirmed(Boolean.FALSE)
                    .build();
        }
    }

    ProviderTaskResult parseQueryResponse(AiModelConfigVo modelConfig, String raw, String providerTaskId)
            throws Exception {
        GetContentGenerationTaskResponse resp = OBJECT_MAPPER.readValue(
                raw, GetContentGenerationTaskResponse.class);
        String videoUrl = null;
        if (resp.getContent() != null) {
            videoUrl = resp.getContent().getVideoUrl();
        }

        String errorMessage = null;
        if (resp.getError() != null) {
            errorMessage = resp.getError().getMessage();
        }

        boolean arkEnded = usesStrictArkContract(modelConfig)
                && ("expired".equalsIgnoreCase(resp.getStatus()) || "cancelled".equalsIgnoreCase(resp.getStatus()));
        String normalized = arkEnded ? VolcengineConstants.TASK_STATUS_FAILED : normalizeStatus(resp.getStatus());
        log.info("Volcengine 视频生成查询, taskId={}, status={}, normalized={}", providerTaskId, resp.getStatus(), normalized);

        if (!arkEnded && !isKnownStatus(resp.getStatus())) {
            return ProviderTaskResult.builder()
                    .status(VolcengineConstants.TASK_STATUS_PROCESSING)
                    .errorMessage(StringUtils.isBlank(resp.getStatus())
                            ? "上游响应缺少状态" : "上游返回未知状态:" + resp.getStatus())
                    .rawResponse(raw)
                    .querySuccessful(Boolean.FALSE)
                    .providerStatus(resp.getStatus())
                    .terminalConfirmed(Boolean.FALSE)
                    .build();
        }
        if (VolcengineConstants.TASK_STATUS_SUCCEEDED.equals(normalized) && StringUtils.isBlank(videoUrl)) {
            return ProviderTaskResult.builder()
                    .status(VolcengineConstants.TASK_STATUS_PROCESSING)
                    .errorMessage("上游成功但结果链接未就绪")
                    .rawResponse(raw)
                    .querySuccessful(Boolean.FALSE)
                    .providerStatus(resp.getStatus())
                    .terminalConfirmed(Boolean.FALSE)
                    .build();
        }
        int completionTokens = resp.getUsage() == null ? 0 : resp.getUsage().getCompletionTokens();
        int totalTokens = resp.getUsage() == null ? 0 : resp.getUsage().getTotalTokens();
        if (VolcengineConstants.TASK_STATUS_SUCCEEDED.equals(normalized)
                && requiresPositiveCompletionTokens(modelConfig) && completionTokens <= 0) {
            // TOKEN 视频只能依据方舟真实 usage 结算。结果链先于 usage 可见时继续轮询，
            // 由统一调度超时机制最终结束，不得用最大预冻金额当实际费用。
            return ProviderTaskResult.builder()
                    .status(VolcengineConstants.TASK_STATUS_PROCESSING)
                    .errorMessage("上游成功但Token用量未就绪")
                    .rawResponse(raw)
                    .querySuccessful(Boolean.FALSE)
                    .providerStatus(resp.getStatus())
                    .terminalConfirmed(Boolean.FALSE)
                    .build();
        }
        return ProviderTaskResult.builder()
                .status(normalized)
                .resultUrl(videoUrl)
                .errorMessage(errorMessage)
                .rawResponse(raw)
                .querySuccessful(Boolean.TRUE)
                .providerStatus(resp.getStatus())
                .terminalConfirmed(arkEnded || isTerminalStatus(resp.getStatus()))
                .videoDurationSeconds(resp.getDuration() == null || resp.getDuration() <= 0
                        ? null : Math.toIntExact(Math.min(resp.getDuration(), Integer.MAX_VALUE)))
                .completionTokens(completionTokens <= 0 ? null : completionTokens)
                .totalTokens(totalTokens <= 0 ? null : totalTokens)
                .build();
    }

    private boolean requiresPositiveCompletionTokens(AiModelConfigVo modelConfig) {
        if (modelConfig == null || StringUtils.isBlank(modelConfig.getBillingRuleJson())) {
            return false;
        }
        try {
            JSONObject billingRule = JSONUtil.parseObj(modelConfig.getBillingRuleJson());
            return "TOKEN".equalsIgnoreCase(billingRule.getStr("meterType"))
                    && "VIDEO".equalsIgnoreCase(billingRule.getStr("chargeType"));
        } catch (Exception ex) {
            log.warn("Volcengine 视频查询无法解析计费规则, model={}, err={}",
                    modelConfig.getModelCode(), ex.getMessage());
            return false;
        }
    }

    List<CreateContentGenerationTaskRequest.Content> buildContents(MediaVideoGenerateRequest request,
                                                                    AiModelConfigVo modelConfig) {
        return buildContents(request, modelConfig, true);
    }

    private List<CreateContentGenerationTaskRequest.Content> buildContents(MediaVideoGenerateRequest request,
                                                                            AiModelConfigVo modelConfig,
                                                                            boolean convertImagesToBase64) {
        validateSceneMaterials(request, modelConfig);
        validateSupportedRequestOptions(request, modelConfig);
        List<CreateContentGenerationTaskRequest.Content> contents = new ArrayList<>();
        Map<String, Object> options = request.getOptions();
        String scene = resolveScene(modelConfig);
        // Base64 传图开关：官方 image 支持 data URI（data:image/<格式>;base64,...），启用时下载转内联下发
        boolean useBase64 = convertImagesToBase64 && ReferenceImageBase64Support.isBase64Enabled(modelConfig);

        if (StringUtils.isNotBlank(request.getPrompt())) {
            contents.add(CreateContentGenerationTaskRequest.Content.builder()
                    .type(VolcengineConstants.CONTENT_TYPE_TEXT)
                    .text(request.getPrompt())
                    .build());
        }

        String lastFrameUrl = getLastFrameUrl(options);
        if (SCENE_FIRST_LAST_FRAME.equals(scene)) {
            require(!hasRawReferenceVideos(options) && !hasRawReferenceImages(options)
                            && !hasRawReferenceAudios(request),
                    "首尾帧不接收其他参考素材", modelConfig);
            require(StringUtils.isNotBlank(request.getImageUrl()) && StringUtils.isNotBlank(lastFrameUrl),
                    "首尾帧不能为空", modelConfig);
            contents.add(CreateContentGenerationTaskRequest.Content.builder()
                    .type(VolcengineConstants.CONTENT_TYPE_IMAGE_URL)
                    .imageUrl(CreateContentGenerationTaskRequest.ImageUrl.builder()
                            .url(toBase64IfEnabled(request.getImageUrl(), useBase64)).build())
                    .role(VolcengineConstants.ROLE_FIRST_FRAME)
                    .build());
            contents.add(CreateContentGenerationTaskRequest.Content.builder()
                    .type(VolcengineConstants.CONTENT_TYPE_IMAGE_URL)
                    .imageUrl(CreateContentGenerationTaskRequest.ImageUrl.builder()
                            .url(toBase64IfEnabled(lastFrameUrl, useBase64)).build())
                    .role(VolcengineConstants.ROLE_LAST_FRAME)
                    .build());
        } else if (SCENE_FIRST_FRAME.equals(scene)) {
            require(!hasRawReferenceVideos(options) && StringUtils.isBlank(lastFrameUrl)
                            && !hasRawReferenceImages(options) && !hasRawReferenceAudios(request),
                    "首帧不接收其他参考素材", modelConfig);
            require(StringUtils.isNotBlank(request.getImageUrl()), "首帧不能为空", modelConfig);
            contents.add(imageContent(request.getImageUrl(), VolcengineConstants.ROLE_FIRST_FRAME, useBase64));
        } else if (SCENE_REFERENCE.equals(scene) || SCENE_EDIT.equals(scene) || SCENE_EXTEND.equals(scene)) {
            List<String> referenceImages = collectReferenceImages(request, modelConfig);
            List<String> referenceVideos = collectReferenceVideos(options, modelConfig);
            List<ReferenceAudioInput> referenceAudios = ReferenceAudioLimiter.limit(
                    request.getReferenceAudios(), modelConfig, "Volcengine");
            require(!SCENE_EDIT.equals(scene) && !SCENE_EXTEND.equals(scene) || !referenceVideos.isEmpty(),
                    "参考视频不能为空", modelConfig);
            require(!SCENE_REFERENCE.equals(scene)
                            || !referenceImages.isEmpty() || !referenceVideos.isEmpty() || !referenceAudios.isEmpty(),
                    "参考素材不能为空", modelConfig);
            for (String refUrl : referenceImages) {
                contents.add(imageContent(refUrl, VolcengineConstants.ROLE_REFERENCE, useBase64));
            }
            for (String refUrl : referenceVideos) {
                contents.add(CreateContentGenerationTaskRequest.Content.builder()
                        .type(VolcengineConstants.CONTENT_TYPE_VIDEO_URL)
                        .videoUrl(CreateContentGenerationTaskRequest.VideoUrl.builder().url(refUrl).build())
                        .role(VolcengineConstants.ROLE_REFERENCE_VIDEO)
                        .build());
            }
            addReferenceAudios(contents, referenceAudios);
        } else if (SCENE_TEXT.equals(scene)) {
            require(StringUtils.isBlank(request.getImageUrl()) && StringUtils.isBlank(lastFrameUrl)
                            && !hasRawReferenceImages(options) && !hasRawReferenceVideos(options)
                            && !hasRawReferenceAudios(request),
                    "文生视频不接收素材", modelConfig);
        } else {
            // 兼容既有 Seedance 2.0 配置。
            if (StringUtils.isNotBlank(request.getImageUrl()) && StringUtils.isNotBlank(lastFrameUrl)) {
                contents.add(imageContent(request.getImageUrl(), VolcengineConstants.ROLE_FIRST_FRAME, useBase64));
                contents.add(imageContent(lastFrameUrl, VolcengineConstants.ROLE_LAST_FRAME, useBase64));
            } else {
                List<String> referenceImages = collectReferenceImages(request, modelConfig);
                if (!referenceImages.isEmpty()) {
                    for (String refUrl : referenceImages) {
                        contents.add(imageContent(refUrl, VolcengineConstants.ROLE_REFERENCE, useBase64));
                    }
                } else if (StringUtils.isNotBlank(request.getImageUrl())) {
                    contents.add(imageContent(request.getImageUrl(), null, useBase64));
                }
                for (String refUrl : collectReferenceVideos(options, modelConfig)) {
                    contents.add(CreateContentGenerationTaskRequest.Content.builder()
                            .type(VolcengineConstants.CONTENT_TYPE_VIDEO_URL)
                            .videoUrl(CreateContentGenerationTaskRequest.VideoUrl.builder().url(refUrl).build())
                            .role(VolcengineConstants.ROLE_REFERENCE_VIDEO)
                            .build());
                }
            }
            addReferenceAudios(contents, ReferenceAudioLimiter.limit(
                    request.getReferenceAudios(), modelConfig, "Volcengine"));
        }

        applySeedancePromptContract(request, contents, modelConfig);
        return contents;
    }

    private void applySeedancePromptContract(MediaVideoGenerateRequest request,
                                              List<CreateContentGenerationTaskRequest.Content> contents,
                                              AiModelConfigVo modelConfig) {
        int imageCount = 0;
        int videoCount = 0;
        int audioCount = 0;
        for (CreateContentGenerationTaskRequest.Content content : contents) {
            if (VolcengineConstants.CONTENT_TYPE_IMAGE_URL.equals(content.getType())) {
                imageCount++;
            } else if (VolcengineConstants.CONTENT_TYPE_VIDEO_URL.equals(content.getType())) {
                videoCount++;
            } else if (VolcengineConstants.CONTENT_TYPE_AUDIO_URL.equals(content.getType())) {
                audioCount++;
            }
        }
        ReferencePromptSanitizer.sanitizeInPlaceForSeedance(request, imageCount, videoCount, audioCount);
        int maxImages = readCapabilityInt(modelConfig, "maxReferenceImages", -1);
        int maxVideos = readCapabilityInt(modelConfig, "maxReferenceVideos", -1);
        int maxAudios = readCapabilityInt(modelConfig, "maxReferenceAudios", -1);
        int maxMaterials = readCapabilityInt(modelConfig, "maxReferenceMaterials", -1);
        require(maxImages < 0 || imageCount <= maxImages, "reference image count exceeded", modelConfig);
        require(maxVideos < 0 || videoCount <= maxVideos, "reference video count exceeded", modelConfig);
        require(maxAudios < 0 || audioCount <= maxAudios, "reference audio count exceeded", modelConfig);
        require(maxMaterials < 0 || imageCount + videoCount + audioCount <= maxMaterials,
                "reference material count exceeded", modelConfig);
        if (Boolean.TRUE.equals(readCapabilityBoolean(modelConfig,
                "referenceAudioRequiresVisualInput"))) {
            require(audioCount == 0 || imageCount + videoCount > 0,
                    "reference audio requires image or video", modelConfig);
        }
        if (!contents.isEmpty() && VolcengineConstants.CONTENT_TYPE_TEXT.equals(contents.get(0).getType())) {
            contents.set(0, CreateContentGenerationTaskRequest.Content.builder()
                    .type(VolcengineConstants.CONTENT_TYPE_TEXT)
                    .text(request.getPrompt())
                    .build());
        }
    }

    private CreateContentGenerationTaskRequest.Content imageContent(String url, String role, boolean useBase64) {
        return CreateContentGenerationTaskRequest.Content.builder()
                .type(VolcengineConstants.CONTENT_TYPE_IMAGE_URL)
                .imageUrl(CreateContentGenerationTaskRequest.ImageUrl.builder()
                        .url(toBase64IfEnabled(url, useBase64)).build())
                .role(role)
                .build();
    }

    private void addReferenceAudios(List<CreateContentGenerationTaskRequest.Content> contents,
                                    List<ReferenceAudioInput> referenceAudios) {
        for (ReferenceAudioInput audio : referenceAudios) {
            if (audio == null || StringUtils.isBlank(audio.getSampleUrl())) {
                continue;
            }
            contents.add(CreateContentGenerationTaskRequest.Content.builder()
                    .type(VolcengineConstants.CONTENT_TYPE_AUDIO_URL)
                    .audioUrl(CreateContentGenerationTaskRequest.AudioUrl.builder().url(audio.getSampleUrl()).build())
                    .role(VolcengineConstants.ROLE_REFERENCE_AUDIO)
                    .build());
        }
    }

    private List<String> collectReferenceImages(MediaVideoGenerateRequest request, AiModelConfigVo modelConfig) {
        Set<String> images = new LinkedHashSet<>();
        if (StringUtils.isNotBlank(request.getImageUrl())) {
            images.add(request.getImageUrl());
        }
        images.addAll(getOptionStringList(request.getOptions(), VolcengineConstants.OPTIONS_REFERENCE_IMAGES));
        images.addAll(getOptionStringList(request.getOptions(), "images"));
        return ReferenceImageLimiter.limit(new ArrayList<>(images), modelConfig,
                DEFAULT_MAX_REFERENCE_IMAGES, "Volcengine");
    }

    private List<String> collectReferenceVideos(Map<String, Object> options, AiModelConfigVo modelConfig) {
        Set<String> videos = new LinkedHashSet<>();
        for (String key : new String[]{"featureVideoUrl", VolcengineConstants.OPTIONS_REFERENCE_VIDEO_URL, "baseVideoUrl",
                "inputVideoUrl", "videoUrl", "video_url"}) {
            String value = getOptionString(options, key);
            if (StringUtils.isNotBlank(value)) {
                videos.add(value);
            }
        }
        videos.addAll(getOptionStringList(options, VolcengineConstants.OPTIONS_REFERENCE_VIDEOS));
        videos.addAll(getOptionStringList(options, "videos"));
        int max = readCapabilityInt(modelConfig, "maxReferenceVideos", DEFAULT_MAX_REFERENCE_VIDEOS);
        List<String> result = new ArrayList<>(videos);
        if (max == 0) {
            if (!result.isEmpty()) {
                log.info("Volcengine 模型禁止参考视频: actual={}", result.size());
                throw new ServiceException("模型不支持参考视频");
            }
            return result;
        }
        if (max > 0 && result.size() > max) {
            log.info("Volcengine 参考视频数量不符合模型限制: max={}, actual={}", max, result.size());
            throw new ServiceException("参考视频数量超限");
        }
        return result;
    }

    private boolean hasRawReferenceVideos(Map<String, Object> options) {
        if (options == null || options.isEmpty()) {
            return false;
        }
        for (String key : new String[]{"featureVideoUrl", VolcengineConstants.OPTIONS_REFERENCE_VIDEO_URL, "baseVideoUrl",
                "inputVideoUrl", "videoUrl", "video_url"}) {
            if (StringUtils.isNotBlank(getOptionString(options, key))) {
                return true;
            }
        }
        return !getOptionStringList(options, VolcengineConstants.OPTIONS_REFERENCE_VIDEOS).isEmpty()
                || !getOptionStringList(options, "videos").isEmpty();
    }

    private boolean hasRawReferenceImages(Map<String, Object> options) {
        return !getOptionStringList(options, VolcengineConstants.OPTIONS_REFERENCE_IMAGES).isEmpty()
                || !getOptionStringList(options, "images").isEmpty();
    }

    private boolean hasRawReferenceAudios(MediaVideoGenerateRequest request) {
        if (request == null || request.getReferenceAudios() == null) {
            return false;
        }
        return request.getReferenceAudios().stream()
                .anyMatch(audio -> audio != null && StringUtils.isNotBlank(audio.getSampleUrl()));
    }

    /**
     * 按开关把单张图片转data URI；启用时转换失败立即拒绝，不回退URL。
     */
    private String toBase64IfEnabled(String imageUrl, boolean useBase64) {
        if (!useBase64 || StringUtils.isBlank(imageUrl)) {
            return imageUrl;
        }
        List<String> converted = ReferenceImageBase64Support
                .toDataUris(Collections.singletonList(imageUrl));
        return converted.get(0);
    }

    CreateContentGenerationTaskRequest buildCreateRequest(
            String model,
            List<CreateContentGenerationTaskRequest.Content> contents,
            MediaVideoGenerateRequest request,
            AiModelConfigVo modelConfig) {

        validateSceneOptions(request, modelConfig);
        CreateContentGenerationTaskRequest.Builder builder = CreateContentGenerationTaskRequest.builder()
                .model(model)
                .content(contents)
                .watermark(VolcengineConstants.DEFAULT_WATERMARK);

        String ratio = resolveRatio(request, modelConfig);
        if (StringUtils.isNotBlank(ratio)) {
            builder.ratio(ratio);
        }
        String resolution = resolveResolution(request, modelConfig);
        if (StringUtils.isNotBlank(resolution)) {
            builder.resolution(resolution.trim().toLowerCase());
        }

        if (request.getDurationSeconds() != null) {
            builder.duration(request.getDurationSeconds().longValue());
        } else if (modelConfig.getDefaultDurationSeconds() != null) {
            builder.duration(modelConfig.getDefaultDurationSeconds().longValue());
        } else {
            builder.duration(VolcengineConstants.DEFAULT_VIDEO_DURATION_SECONDS);
        }

        applyVideoOptions(builder, request, modelConfig);

        return builder.build();
    }

    /** 任务落库和预冻结前的无网络完整契约校验。 */
    public static void validateFullRequest(AiModelConfigVo modelConfig, MediaVideoGenerateRequest request) {
        validateFullRequest(modelConfig, request, false);
    }

    public static void validateFullRequest(AiModelConfigVo modelConfig, MediaVideoGenerateRequest request,
                                           boolean promptPending) {
        VolcengineVideoProviderClient validator = new VolcengineVideoProviderClient();
        if (validator.usesStrictArkContract(modelConfig)) {
            MediaVideoGenerateRequest outbound = new MediaVideoGenerateRequest();
            BeanUtil.copyProperties(request, outbound);
            List<CreateContentGenerationTaskRequest.Content> contents = validator.buildContents(outbound, modelConfig, false);
            validator.buildStrictArkRequest(validator.resolveEffectiveModel(modelConfig, outbound),
                    contents, outbound, modelConfig, promptPending);
            return;
        }
        List<CreateContentGenerationTaskRequest.Content> contents =
                validator.buildContents(request, modelConfig, false);
        ModelCapabilityValidator.validatePrompt(modelConfig, request.getPrompt());
        validator.validateTimestampInstructions(request, modelConfig);
        validator.buildCreateRequest(validator.resolveEffectiveModel(modelConfig, request),
                contents, request, modelConfig);
    }

    private void applyStrictArkError(ProviderSubmitResult rejection, AiModelConfigVo config,
                                     int httpStatus, String body) {
        // 供应商规则读取原始 Ark 错误信封，任务仅持久化安全错误快照。
        var error = ErrorNormalizer.classify(config.getProviderCode(), config.getModelCode(), httpStatus, body);
        rejection.setErrorDetailJson(TaskErrorSnapshot.write(error));
        rejection.setSubmissionErrorMessage(error.getUserMessage());
        var envelope = com.aid.media.provider.ProviderResponseHelper.readTree(body);
        String code = com.aid.media.provider.ProviderResponseHelper.readText(envelope, "error.code", "code");
        if (code != null && code.matches("[A-Za-z][A-Za-z0-9_.-]{0,63}")) {
            log.warn("Ark 兼容视频请求被拒绝, provider={}, httpStatus={}, upstreamCode={}",
                    config.getProviderCode(), httpStatus, code);
        }
    }

    private boolean usesStrictArkContract(AiModelConfigVo modelConfig) {
        return Boolean.TRUE.equals(readCapabilityBoolean(modelConfig, "strictArkCompatibility"));
    }

    private String strictArkWireBody(String json, MediaVideoGenerateRequest request) throws Exception {
        Map<String, Object> body = OBJECT_MAPPER.readValue(json, new TypeReference<>() {});
        String protectedJson = OBJECT_MAPPER.writeValueAsString(
                com.aid.media.security.PromptConfidentialityPolicy.protectMediaBody(body, request));
        if (protectedJson.getBytes(StandardCharsets.UTF_8).length > 64_000_000) {
            throw com.aid.media.provider.ProviderSubmissionFailures.notSent("视频请求超过 64000000 字节");
        }
        return protectedJson;
    }

    /** Ark 兼容端点只接受显式允许的字段，不带入火山专用默认值。 */
    private Map<String, Object> buildStrictArkRequest(String model, List<CreateContentGenerationTaskRequest.Content> contents,
                                                   MediaVideoGenerateRequest request, AiModelConfigVo config,
                                                   boolean promptPending) {
        Map<String, Object> options = request.getOptions() == null ? Map.of() : request.getOptions();
        String prompt = request.getPrompt();
        require(promptPending || !contents.isEmpty(), "需要提示词或参考素材", config);
        require(prompt == null || prompt.codePointCount(0, prompt.length()) <= 15000, "提示词最多 15000 字符", config);
        require(contents.size() <= 21, "参考素材超过上限", config);
        List<Map<String, Object>> media = new ArrayList<>(contents.size());
        for (var content : contents) {
            String type = content.getType();
            if (VolcengineConstants.CONTENT_TYPE_TEXT.equals(type)) {
                require(StringUtils.isNotBlank(content.getText()), "提示词不能为空", config);
                media.add(Map.of("type", type, "text", content.getText()));
                continue;
            }
            String url = switch (type) {
                case VolcengineConstants.CONTENT_TYPE_IMAGE_URL -> content.getImageUrl().getUrl();
                case VolcengineConstants.CONTENT_TYPE_VIDEO_URL -> content.getVideoUrl().getUrl();
                case VolcengineConstants.CONTENT_TYPE_AUDIO_URL -> content.getAudioUrl().getUrl();
                default -> throw new ServiceException("参考素材类型无效");
            };
            validateStrictArkMediaUrl(url, type.substring(0, type.length() - "_url".length()), config);
            require(StringUtils.isNotBlank(content.getRole()), "参考素材角色不能为空", config);
            media.add(Map.of("type", type, "role", content.getRole(), type, Map.of("url", url)));
        }
        String resolution = resolveResolution(request, config);
        String ratio = resolveRatio(request, config);
        Integer duration = request.getDurationSeconds() == null ? config.getDefaultDurationSeconds() : request.getDurationSeconds();
        require("1080p".equalsIgnoreCase(resolution), "分辨率仅支持 1080p", config);
        require(isSeedance25Ratio(ratio) && !"adaptive".equalsIgnoreCase(ratio), "比例无效", config);
        require(duration != null && duration >= 4 && duration <= 30, "时长必须为 4–30 秒", config);
        validateCapabilityOption(config, "sizeOptions", resolution, "resolution unsupported");
        validateCapabilityOption(config, "aspectRatioOptions", ratio, "ratio unsupported");
        validateCapabilityOption(config, "durationOptions", String.valueOf(duration), "duration unsupported");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("content", media);
        body.put("duration", duration);
        body.put("ratio", ratio);
        body.put("resolution", "1080p");
        Boolean audio = resolveGenerateAudio(request);
        if (audio != null) {
            body.put("generate_audio", audio);
        }
        if (options.get("enhance_prompt") != null) {
            body.put("enhance_prompt", requireBooleanOption(options, "enhance_prompt", config));
        }
        if (options.containsKey("seed")) {
            long seed = requireLongOption(options, "seed", config);
            require(seed >= -1 && seed <= 4294967295L, "随机种子超出范围", config);
            body.put("seed", seed);
        }
        if (options.containsKey("omni_reference_task_type")) {
            require("auto".equals(options.get("omni_reference_task_type")), "参考任务类型仅支持 auto", config);
            body.put("omni_reference_task_type", "auto");
        }
        return body;
    }

    private void validateStrictArkMediaUrl(String source, String type, AiModelConfigVo config) {
        require(StringUtils.isNotBlank(source), "参考素材地址不能为空", config);
        if (source.startsWith("data:") && !"video".equals(type)) {
            require(source.startsWith("data:" + type + "/") && source.indexOf(";base64,") > 0,
                    "参考素材的内联格式无效", config);
            return;
        }
        try {
            URI uri = URI.create(source);
            if ("asset".equals(uri.getScheme()) && source.matches("asset://[1-9][0-9]{0,18}")) {
                Long.parseLong(uri.getAuthority());
                return;
            }
            require(source.length() <= 8192 && "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                    && uri.getRawUserInfo() == null && uri.getRawFragment() == null, "参考素材须使用 HTTPS 地址", config);
        } catch (IllegalArgumentException invalidUrl) {
            throw new ServiceException("参考素材地址无效");
        }
    }

    private void validateSceneMaterials(MediaVideoGenerateRequest request, AiModelConfigVo modelConfig) {
        require(request != null, "请求不能为空", modelConfig);
        String scene = resolveScene(modelConfig);
        if (SCENE_LEGACY.equals(scene)) {
            return;
        }
        Map<String, Object> options = request.getOptions();
        String lastFrameUrl = getLastFrameUrl(options);
        List<String> videos = collectReferenceVideos(options, modelConfig);
        List<ReferenceAudioInput> audios = ReferenceAudioLimiter.limit(
                request.getReferenceAudios(), modelConfig, "Volcengine");
        int maxMaterials = readCapabilityInt(modelConfig, "maxReferenceMaterials", -1);
        int dispatchedMaterials = collectReferenceImages(request, modelConfig).size() + videos.size() + audios.size();
        require(maxMaterials <= 0 || dispatchedMaterials <= maxMaterials,
                "参考素材超过上限", modelConfig);
        if (SCENE_TEXT.equals(scene)) {
            require(StringUtils.isBlank(request.getImageUrl()) && StringUtils.isBlank(lastFrameUrl)
                            && !hasRawReferenceImages(options) && !hasRawReferenceVideos(options)
                            && !hasRawReferenceAudios(request),
                    "文生视频不接收素材", modelConfig);
        } else if (SCENE_FIRST_FRAME.equals(scene)) {
            require(StringUtils.isNotBlank(request.getImageUrl()), "首帧不能为空", modelConfig);
            require(StringUtils.isBlank(lastFrameUrl) && !hasRawReferenceImages(options)
                            && !hasRawReferenceVideos(options) && !hasRawReferenceAudios(request),
                    "首帧不接收其他参考素材", modelConfig);
        } else if (SCENE_FIRST_LAST_FRAME.equals(scene)) {
            require(StringUtils.isNotBlank(request.getImageUrl()) && StringUtils.isNotBlank(lastFrameUrl),
                    "首尾帧不能为空", modelConfig);
            require(!hasRawReferenceImages(options) && !hasRawReferenceVideos(options)
                            && !hasRawReferenceAudios(request),
                    "首尾帧不接收其他参考素材", modelConfig);
        } else {
            List<String> images = collectReferenceImages(request, modelConfig);
            if (SCENE_REFERENCE.equals(scene)) {
                require(!images.isEmpty() || !videos.isEmpty() || !audios.isEmpty(),
                        "参考素材不能为空", modelConfig);
            } else {
                require(!videos.isEmpty(), "参考视频不能为空", modelConfig);
            }
        }
    }

    /** 2.5 场景约束必须在服务端再校验，API 直调不能绕过后台能力配置。 */
    private void validateSceneOptions(MediaVideoGenerateRequest request, AiModelConfigVo modelConfig) {
        String scene = resolveScene(modelConfig);
        String ratio = resolveRatio(request, modelConfig);
        Integer duration = request.getDurationSeconds() == null
                ? modelConfig.getDefaultDurationSeconds() : request.getDurationSeconds();
        String resolution = resolveResolution(request, modelConfig);
        validateCapabilityOption(modelConfig, "sizeOptions", resolution, "resolution unsupported");
        require(isAllowedResolution(modelConfig, resolution),
                "分辨率无效", modelConfig);
        if ((isSeedance25Model(modelConfig) && (SCENE_FIRST_FRAME.equals(scene) || SCENE_FIRST_LAST_FRAME.equals(scene)))
                || SCENE_EDIT.equals(scene) || SCENE_EXTEND.equals(scene)) {
            require("adaptive".equalsIgnoreCase(ratio), "比例必须自适应", modelConfig);
        } else {
            require(isSeedance25Ratio(ratio), "比例无效", modelConfig);
        }
        if (SCENE_EDIT.equals(scene)) {
            require(duration != null && duration == -1, "编辑时长必须自动", modelConfig);
        } else {
            require(duration != null && (duration == -1 || duration >= 4 && duration <= 30),
                    "时长范围无效", modelConfig);
        }
        validateCapabilityOption(modelConfig, "aspectRatioOptions", ratio, "ratio unsupported");
        validateCapabilityOption(modelConfig, "durationOptions",
                duration == null ? null : String.valueOf(duration), "duration unsupported");
    }

    private boolean isSeedance25Model(AiModelConfigVo modelConfig) {
        String upstream = StringUtils.defaultIfBlank(modelConfig.getRealModelCode(), modelConfig.getModelCode());
        return upstream != null && upstream.toLowerCase(java.util.Locale.ROOT)
                .replace('.', '-').contains("seedance-2-5");
    }

    private boolean isSeedance25Ratio(String ratio) {
        return ratio != null && ("adaptive".equalsIgnoreCase(ratio)
                || "16:9".equals(ratio) || "9:16".equals(ratio) || "4:3".equals(ratio)
                || "3:4".equals(ratio) || "1:1".equals(ratio) || "21:9".equals(ratio));
    }

    private void applyVideoOptions(CreateContentGenerationTaskRequest.Builder builder,
                                   MediaVideoGenerateRequest request, AiModelConfigVo modelConfig) {
        Map<String, Object> options = request == null ? null : request.getOptions();
        // 音画同出：仅 capability.supportsAudio=true 时下发；优先顶层 audio，其次 options.generate_audio
        Boolean generateAudio = resolveGenerateAudio(request);
        if (generateAudio != null) {
            builder.generateAudio(generateAudio);
        }

        if (options == null || options.isEmpty()) {
            applySeedance25SceneOptions(builder, modelConfig, null);
            return;
        }

        if (options.containsKey(VolcengineConstants.OPTIONS_RESOLUTION)) {
            // 官方枚举为小写 480p/720p/1080p/4k；业务层/capability 多为 720P，下发前统一转小写
            String resolution = String.valueOf(options.get(VolcengineConstants.OPTIONS_RESOLUTION)).trim();
            if (StringUtils.isNotBlank(resolution)) {
                builder.resolution(resolution.toLowerCase());
            }
        }

        if (options.containsKey(VolcengineConstants.JSON_WATERMARK)) {
            builder.watermark(requireBooleanOption(options, VolcengineConstants.JSON_WATERMARK, modelConfig));
        }

        if (options.containsKey(VolcengineConstants.OPTIONS_RETURN_LAST_FRAME)) {
            requireCapability(modelConfig, "supportsReturnLastFrame", "return_last_frame unsupported");
            builder.returnLastFrame(requireBooleanOption(options,
                    VolcengineConstants.OPTIONS_RETURN_LAST_FRAME, modelConfig));
        }

        if (options.containsKey(VolcengineConstants.JSON_SEED)) {
            requireCapability(modelConfig, "supportsSeed", "seed unsupported");
            builder.seed(requireLongOption(options, VolcengineConstants.JSON_SEED, modelConfig));
        }

        if (options.containsKey(VolcengineConstants.OPTIONS_CAMERA_FIXED)) {
            requireCapability(modelConfig, "supportsCameraFixed", "camera_fixed unsupported");
            builder.cameraFixed(requireBooleanOption(options,
                    VolcengineConstants.OPTIONS_CAMERA_FIXED, modelConfig));
        }

        if (options.containsKey(VolcengineConstants.OPTIONS_CALLBACK_URL)) {
            builder.callbackUrl(requireTextOption(options,
                    VolcengineConstants.OPTIONS_CALLBACK_URL, modelConfig));
        }
        applyExecutionOptions(builder, options, modelConfig);
        applySeedance25SceneOptions(builder, modelConfig, options);
    }

    private void applySeedance25SceneOptions(CreateContentGenerationTaskRequest.Builder builder,
                                              AiModelConfigVo modelConfig, Map<String, Object> options) {
        String scene = resolveScene(modelConfig);
        String outputFormat = getOptionString(options, VolcengineConstants.JSON_OUTPUT_FORMAT);
        if (StringUtils.isBlank(outputFormat)) {
            outputFormat = readCapabilityString(modelConfig, "defaultOutputFormat");
        }
        if (StringUtils.isNotBlank(outputFormat)) {
            String normalized = outputFormat.trim().toLowerCase();
            require("mp4".equals(normalized) || "mov".equals(normalized), "输出格式无效", modelConfig);
            validateCapabilityOption(modelConfig, "outputFormatOptions", normalized,
                    "output format unsupported");
            if (!Boolean.FALSE.equals(readCapabilityBoolean(modelConfig,
                    "supportsOutputFormatParameter"))) {
                builder.outputFormat(normalized);
            } else if (options != null && options.containsKey(VolcengineConstants.JSON_OUTPUT_FORMAT)) {
                throw new ServiceException("output_format unsupported");
            }
        }
        String requestedTaskType = getOptionString(options,
                VolcengineConstants.OPTIONS_OMNI_REFERENCE_TASK_TYPE);
        String inferredTaskType = SCENE_REFERENCE.equals(scene) ? "auto"
                : SCENE_EDIT.equals(scene) ? "edit"
                : SCENE_EXTEND.equals(scene) ? "extend" : null;
        String taskType = StringUtils.defaultIfBlank(requestedTaskType, inferredTaskType);
        if (StringUtils.isNotBlank(taskType)) {
            List<String> allowed = seedanceTaskTypeOptions(modelConfig);
            String matched = ModelCapabilityResolver.matchOption(allowed, taskType);
            if (matched == null) {
                require(StringUtils.isBlank(requestedTaskType),
                        "omni_reference_task_type unsupported", modelConfig);
                return;
            }
            if (SCENE_EDIT.equals(scene)) {
                require("edit".equalsIgnoreCase(matched), "task type conflicts with edit scene", modelConfig);
            } else if (SCENE_EXTEND.equals(scene)) {
                require("extend".equalsIgnoreCase(matched), "task type conflicts with extend scene", modelConfig);
            } else if (SCENE_REFERENCE.equals(scene)) {
                require("auto".equalsIgnoreCase(matched) || "reference".equalsIgnoreCase(matched),
                        "task type conflicts with reference scene", modelConfig);
            } else {
                require(false, "omni_reference_task_type unsupported for scene", modelConfig);
            }
            builder.omniReferenceTaskType(matched);
        }
    }

    private void applyExecutionOptions(CreateContentGenerationTaskRequest.Builder builder,
                                       Map<String, Object> options, AiModelConfigVo modelConfig) {
        if (options.containsKey(OPTION_SERVICE_TIER)) {
            String serviceTier = requireTextOption(options, OPTION_SERVICE_TIER, modelConfig).toLowerCase();
            List<String> allowed = ModelCapabilityResolver.readOptions(
                    ModelCapabilityResolver.parseCapability(modelConfig.getCapabilityJson()),
                    "serviceTierOptions");
            String matched = ModelCapabilityResolver.matchOption(allowed, serviceTier);
            require(matched != null, "service_tier unsupported", modelConfig);
            builder.serviceTier(matched);
        }
        if (options.containsKey(OPTION_EXECUTION_EXPIRES_AFTER)) {
            long seconds = requireLongOption(options, OPTION_EXECUTION_EXPIRES_AFTER, modelConfig);
            require(seconds > 0, "execution_expires_after must be positive", modelConfig);
            builder.executionExpiresAfter(seconds);
        }
        if (options.containsKey(OPTION_PRIORITY)) {
            requireCapability(modelConfig, "supportsPriority", "priority unsupported");
            long priority = requireLongOption(options, OPTION_PRIORITY, modelConfig);
            require(priority >= Integer.MIN_VALUE && priority <= Integer.MAX_VALUE,
                    "priority invalid", modelConfig);
            builder.priority((int) priority);
        }
        if (options.containsKey(OPTION_SAFETY_IDENTIFIER)) {
            builder.safetyIdentifier(requireTextOption(options, OPTION_SAFETY_IDENTIFIER, modelConfig));
        }
        if (options.containsKey(OPTION_FRAMES)) {
            requireCapability(modelConfig, "supportsFrames", "frames unsupported", true);
            long frames = requireLongOption(options, OPTION_FRAMES, modelConfig);
            require(frames > 0, "frames must be positive", modelConfig);
            builder.frames(frames);
        }
        if (options.containsKey(OPTION_DRAFT)) {
            requireCapability(modelConfig, "supportsDraft", "draft unsupported", true);
            builder.draft(requireBooleanOption(options, OPTION_DRAFT, modelConfig));
        }
        if (options.containsKey(OPTION_DRAFT_TASK_ID)) {
            requireCapability(modelConfig, "supportsDraftUpgrade", "draft upgrade unsupported", true);
            require(false, "draft upgrade is not available for this Seedance model", modelConfig);
        }
        if (options.containsKey(OPTION_TOOLS)) {
            requireCapability(modelConfig, "supportsWebSearch", "web_search unsupported", true);
            builder.tools(parseTools(options.get(OPTION_TOOLS), modelConfig));
        }
    }

    private List<CreateContentGenerationTaskRequest.ContentGenerationTool> parseTools(
            Object raw, AiModelConfigVo modelConfig) {
        require(raw instanceof List<?>, "tools must be an array", modelConfig);
        List<?> values = (List<?>) raw;
        require(!values.isEmpty(), "tools must not be empty", modelConfig);
        List<CreateContentGenerationTaskRequest.ContentGenerationTool> tools = new ArrayList<>();
        for (Object value : values) {
            require(value instanceof Map<?, ?>, "tool must be an object", modelConfig);
            Map<?, ?> item = (Map<?, ?>) value;
            require(item.size() == 1 && item.get("type") instanceof CharSequence,
                    "tool fields unsupported", modelConfig);
            String type = String.valueOf(item.get("type")).trim().toLowerCase();
            require("web_search".equals(type), "tool type unsupported", modelConfig);
            CreateContentGenerationTaskRequest.ContentGenerationTool tool =
                    new CreateContentGenerationTaskRequest.ContentGenerationTool();
            tool.setType(type);
            tools.add(tool);
        }
        return tools;
    }

    private void validateTimestampInstructions(MediaVideoGenerateRequest request,
                                                AiModelConfigVo modelConfig) {
        if (Boolean.TRUE.equals(readCapabilityBoolean(modelConfig, "timestampIntegerOnly"))
                && StringUtils.isNotBlank(request.getPrompt())
                && FRACTIONAL_TIMESTAMP.matcher(request.getPrompt()).find()) {
            require(false, "timestamp instructions must use integer seconds", modelConfig);
        }
    }

    private void validateSupportedRequestOptions(MediaVideoGenerateRequest request,
                                                   AiModelConfigVo modelConfig) {
        if (request == null || request.getOptions() == null) {
            return;
        }
        Set<String> allowed = usesStrictArkContract(modelConfig) ? STRICT_ARK_OPTION_KEYS : REQUEST_OPTION_KEYS;
        for (String key : request.getOptions().keySet()) {
            // 业务扇入、恢复和计费元数据只在站内消费，不属于厂商参数。
            // 请求体仍由官方字段显式组装，未知的生成参数继续拒绝。
            if (MediaInternalOptionKeys.isInternal(key)) {
                continue;
            }
            require(allowed.contains(key), "unsupported option: " + key, modelConfig);
        }
    }

    private String getLastFrameUrl(Map<String, Object> options) {
        return consistentOptionText(options, VolcengineConstants.OPTIONS_LAST_FRAME_IMAGE_URL,
                "endImageUrl", "end_image_url");
    }

    private String resolveResolution(MediaVideoGenerateRequest request, AiModelConfigVo modelConfig) {
        String requested = consistentOptionText(request.getOptions(),
                VolcengineConstants.OPTIONS_RESOLUTION, "size");
        return StringUtils.defaultIfBlank(requested, modelConfig.getDefaultSizeCode());
    }

    private String resolveRatio(MediaVideoGenerateRequest request, AiModelConfigVo modelConfig) {
        String optionRatio = consistentOptionText(request.getOptions(), "ratio", "aspect_ratio");
        if (StringUtils.isNotBlank(request.getAspectRatio()) && StringUtils.isNotBlank(optionRatio)
                && !request.getAspectRatio().trim().equalsIgnoreCase(optionRatio.trim())) {
            require(false, "conflicting ratio options", modelConfig);
        }
        return StringUtils.defaultIfBlank(request.getAspectRatio(),
                StringUtils.defaultIfBlank(optionRatio, modelConfig.getDefaultAspectRatio()));
    }

    private String consistentOptionText(Map<String, Object> options, String... keys) {
        String selected = null;
        for (String key : keys) {
            String candidate = getOptionString(options, key);
            if (StringUtils.isBlank(candidate)) {
                continue;
            }
            if (selected != null && !selected.trim().equalsIgnoreCase(candidate.trim())) {
                throw new ServiceException("conflicting option aliases");
            }
            selected = candidate;
        }
        return selected;
    }

    private boolean isAllowedResolution(AiModelConfigVo modelConfig, String resolution) {
        List<String> allowed = ModelCapabilityResolver.readOptions(
                ModelCapabilityResolver.parseCapability(modelConfig.getCapabilityJson()), "sizeOptions");
        if (!allowed.isEmpty()) {
            return ModelCapabilityResolver.matchOption(allowed, resolution) != null;
        }
        return "480p".equalsIgnoreCase(resolution) || "720p".equalsIgnoreCase(resolution);
    }

    private List<String> seedanceTaskTypeOptions(AiModelConfigVo modelConfig) {
        List<String> configured = ModelCapabilityResolver.readOptions(
                ModelCapabilityResolver.parseCapability(modelConfig.getCapabilityJson()),
                "seedanceTaskTypeOptions");
        if (!configured.isEmpty()) {
            return configured;
        }
        String upstream = modelConfig == null ? null : modelConfig.getRealModelCode();
        if (StringUtils.isBlank(upstream) && modelConfig != null) {
            upstream = modelConfig.getModelCode();
        }
        return StringUtils.containsIgnoreCase(upstream, "seedance-2-5")
                ? List.of("auto", "edit", "extend") : Collections.emptyList();
    }

    private void validateCapabilityOption(AiModelConfigVo modelConfig, String key,
                                          String value, String message) {
        if (StringUtils.isBlank(value)) {
            return;
        }
        List<String> allowed = ModelCapabilityResolver.readOptions(
                ModelCapabilityResolver.parseCapability(modelConfig.getCapabilityJson()), key);
        if (!allowed.isEmpty()) {
            require(ModelCapabilityResolver.matchOption(allowed, value) != null, message, modelConfig);
        }
    }

    private Boolean readCapabilityBoolean(AiModelConfigVo modelConfig, String key) {
        if (modelConfig == null) {
            return null;
        }
        com.fasterxml.jackson.databind.JsonNode capability =
                ModelCapabilityResolver.parseCapability(modelConfig.getCapabilityJson());
        com.fasterxml.jackson.databind.JsonNode value = capability == null ? null : capability.get(key);
        return value != null && value.isBoolean() ? value.asBoolean() : null;
    }

    private void requireCapability(AiModelConfigVo modelConfig, String key, String message) {
        requireCapability(modelConfig, key, message, false);
    }

    private void requireCapability(AiModelConfigVo modelConfig, String key, String message,
                                   boolean requireExplicitSupport) {
        Boolean supported = readCapabilityBoolean(modelConfig, key);
        require(Boolean.TRUE.equals(supported) || supported == null && !requireExplicitSupport,
                message, modelConfig);
    }

    private Boolean requireBooleanOption(Map<String, Object> options, String key,
                                         AiModelConfigVo modelConfig) {
        Object raw = options.get(key);
        if (raw instanceof Boolean value) {
            return value;
        }
        if (raw instanceof CharSequence value) {
            String normalized = value.toString().trim();
            require("true".equalsIgnoreCase(normalized) || "false".equalsIgnoreCase(normalized),
                    key + " must be boolean", modelConfig);
            return Boolean.valueOf(normalized);
        }
        require(false, key + " must be boolean", modelConfig);
        return null;
    }

    private long requireLongOption(Map<String, Object> options, String key,
                                   AiModelConfigVo modelConfig) {
        Object raw = options.get(key);
        if (raw instanceof Byte || raw instanceof Short || raw instanceof Integer || raw instanceof Long) {
            return ((Number) raw).longValue();
        }
        if (raw instanceof CharSequence value) {
            try {
                return Long.parseLong(value.toString().trim());
            } catch (NumberFormatException ignored) {
                // Rejected below with the provider contract error.
            }
        }
        require(false, key + " must be an integer", modelConfig);
        return 0L;
    }

    private String requireTextOption(Map<String, Object> options, String key,
                                     AiModelConfigVo modelConfig) {
        Object raw = options.get(key);
        require(raw instanceof CharSequence && StringUtils.isNotBlank(raw.toString()),
                key + " must be text", modelConfig);
        return raw.toString().trim();
    }

    /**
     * 解析 Seedance 音画同出开关：能力门禁与顶层 audio / options.generate_audio 的归一
     * 已由 ModelCapabilityValidator 在建任务前统一完成，此处只读归一结果，不重复解析 capability_json。
     */
    private Boolean resolveGenerateAudio(MediaVideoGenerateRequest request) {
        if (request == null) {
            return null;
        }
        Map<String, Object> options = request.getOptions();
        if (options == null || !options.containsKey(VolcengineConstants.OPTIONS_GENERATE_AUDIO)
                && !options.containsKey("audio")) {
            return request.getAudio();
        }
        Boolean generateAudio = options.containsKey(VolcengineConstants.OPTIONS_GENERATE_AUDIO)
                ? requireBooleanOption(options, VolcengineConstants.OPTIONS_GENERATE_AUDIO, null) : null;
        Boolean audio = options.containsKey("audio")
                ? requireBooleanOption(options, "audio", null) : null;
        if (generateAudio != null && audio != null && !generateAudio.equals(audio)) {
            throw new ServiceException("conflicting audio options");
        }
        Boolean optionValue = generateAudio != null ? generateAudio : audio;
        if (request.getAudio() != null && optionValue != null
                && !request.getAudio().equals(optionValue)) {
            throw new ServiceException("conflicting audio options");
        }
        return request.getAudio() != null ? request.getAudio() : optionValue;
    }

    private String normalizeStatus(String status) {
        if (StringUtils.isBlank(status)) {
            return VolcengineConstants.TASK_STATUS_PROCESSING;
        }
        String lower = status.toLowerCase();
        if (VolcengineConstants.VENDOR_STATUS_SUCCEEDED.equals(lower)) {
            return VolcengineConstants.TASK_STATUS_SUCCEEDED;
        }
        if (VolcengineConstants.VENDOR_STATUS_FAILED.equals(lower)) {
            return VolcengineConstants.TASK_STATUS_FAILED;
        }
        return VolcengineConstants.TASK_STATUS_PROCESSING;
    }

    private boolean isKnownStatus(String status) {
        if (StringUtils.isBlank(status)) {
            return false;
        }
        String lower = status.trim().toLowerCase();
        return VolcengineConstants.VENDOR_STATUS_SUCCEEDED.equals(lower)
                || VolcengineConstants.VENDOR_STATUS_FAILED.equals(lower)
                || "queued".equals(lower)
                || "running".equals(lower)
                || "processing".equals(lower);
    }

    private boolean isTerminalStatus(String status) {
        String lower = StringUtils.defaultString(status).trim().toLowerCase();
        return VolcengineConstants.VENDOR_STATUS_SUCCEEDED.equals(lower)
                || VolcengineConstants.VENDOR_STATUS_FAILED.equals(lower);
    }

    private String resolveEffectiveModel(AiModelConfigVo modelConfig, MediaVideoGenerateRequest request) {
        // 解析真实上游模型名：展示码 model_code 与真实模型名 real_model_code 解耦
        String resolved = com.aid.media.provider.ModelCodeResolver.resolveUpstreamModel(modelConfig,
                request == null ? null : request.getModelName());
        if (StringUtils.isNotBlank(resolved)) {
            return resolved;
        }
        return VolcengineConstants.DEFAULT_VIDEO_MODEL;
    }

    String resolveScene(AiModelConfigVo modelConfig) {
        String configured = readCapabilityString(modelConfig, "videoScenario");
        if (StringUtils.isBlank(configured)) {
            return SCENE_LEGACY;
        }
        String normalized = configured.trim().toLowerCase();
        return switch (normalized) {
            case SCENE_TEXT, SCENE_FIRST_FRAME, SCENE_FIRST_LAST_FRAME,
                    SCENE_REFERENCE, SCENE_EDIT, SCENE_EXTEND -> normalized;
            default -> throw new ServiceException("视频场景配置无效");
        };
    }

    private String readCapabilityString(AiModelConfigVo modelConfig, String key) {
        if (modelConfig == null || StringUtils.isBlank(modelConfig.getCapabilityJson())) {
            return null;
        }
        try {
            JSONObject json = JSONUtil.parseObj(modelConfig.getCapabilityJson());
            return json.getStr(key);
        } catch (Exception ex) {
            log.warn("Volcengine capability_json解析失败, model={}, key={}, err={}",
                    modelConfig.getModelCode(), key, ex.getMessage());
            return null;
        }
    }

    private int readCapabilityInt(AiModelConfigVo modelConfig, String key, int fallback) {
        if (modelConfig == null || StringUtils.isBlank(modelConfig.getCapabilityJson())) {
            return fallback;
        }
        try {
            Integer value = JSONUtil.parseObj(modelConfig.getCapabilityJson()).getInt(key);
            return value == null ? fallback : value;
        } catch (Exception ex) {
            log.warn("Volcengine capability_json解析失败, model={}, key={}, err={}",
                    modelConfig.getModelCode(), key, ex.getMessage());
            return fallback;
        }
    }

    static String buildSubmitUrl(AiModelConfigVo modelConfig) {
        if (modelConfig == null) {
            throw new IllegalArgumentException("模型配置不能为空");
        }
        return ProviderEndpointUtils.buildSubmitUrl(
                modelConfig.getBaseUrl(), modelConfig.getApiSuffix());
    }

    static String buildQueryUrl(AiModelConfigVo modelConfig, String providerTaskId) {
        if (modelConfig == null) {
            throw new IllegalArgumentException("模型配置不能为空");
        }
        return ProviderEndpointUtils.buildTaskQueryUrl(
                modelConfig.getBaseUrl(), modelConfig.getTaskQuerySuffix(), providerTaskId);
    }

    private HttpResult doPost(String url, String apiKey, String body) {
        requireApiKey(apiKey);
        try (HttpResponse response = HttpRequest.post(url)
                .header(HttpConstants.HEADER_AUTHORIZATION, HttpConstants.AUTH_BEARER_PREFIX + apiKey.trim())
                .header(HttpConstants.HEADER_CONTENT_TYPE, HttpConstants.CONTENT_TYPE_JSON)
                .body(body)
                .timeout(VolcengineConstants.HTTP_TIMEOUT_SECONDS * 1000)
                .execute()) {
            return new HttpResult(response.getStatus(), response.body());
        }
    }

    private HttpResult doGet(String url, String apiKey) {
        requireApiKey(apiKey);
        try (HttpResponse response = HttpRequest.get(url)
                .header(HttpConstants.HEADER_AUTHORIZATION, HttpConstants.AUTH_BEARER_PREFIX + apiKey.trim())
                .header(HttpConstants.HEADER_CONTENT_TYPE, HttpConstants.CONTENT_TYPE_JSON)
                .timeout(VolcengineConstants.HTTP_TIMEOUT_SECONDS * 1000)
                .execute()) {
            return new HttpResult(response.getStatus(), response.body());
        }
    }

    private void requireApiKey(String apiKey) {
        if (StringUtils.isBlank(apiKey)) {
            throw com.aid.media.provider.ProviderSubmissionFailures.notSent("方舟密钥未配置");
        }
    }

    private void require(boolean condition, String message, AiModelConfigVo modelConfig) {
        if (condition) {
            return;
        }
        log.error("Volcengine Seedance参数校验失败, model={}, reason={}",
                modelConfig == null ? null : modelConfig.getModelCode(), message);
        throw new ServiceException(message);
    }

    private String getOptionString(Map<String, Object> options, String key) {
        if (options == null || !options.containsKey(key)) {
            return null;
        }
        Object value = options.get(key);
        if (value == null) {
            return null;
        }
        if (!(value instanceof CharSequence)) {
            throw new ServiceException(key + " must be text");
        }
        return value.toString();
    }

    private List<String> getOptionStringList(Map<String, Object> options, String key) {
        if (options == null || !options.containsKey(key)) {
            return Collections.emptyList();
        }
        Object value = options.get(key);
        if (value instanceof List<?> list) {
            List<String> result = new ArrayList<>();
            for (Object item : list) {
                if (item != null && !(item instanceof CharSequence)) {
                    throw new ServiceException(key + " entries must be text");
                }
                if (item != null && StringUtils.isNotBlank(item.toString())) {
                    result.add(item.toString().trim());
                }
            }
            return result;
        }
        throw new ServiceException(key + " must be an array");
    }

    private record HttpResult(int statusCode, String body) {
    }
}
