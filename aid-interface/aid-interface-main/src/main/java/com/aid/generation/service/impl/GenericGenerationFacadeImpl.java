package com.aid.generation.service.impl;

import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.crypto.SecureUtil;
import com.aid.common.aid.json.JsonSafeId;
import com.aid.common.exception.ServiceException;
import com.aid.billing.vo.BillingQuoteVO;
import com.aid.canvas.domain.CanvasEntities.TaskBinding;
import com.aid.canvas.domain.CanvasEntities.CanvasObject;
import com.aid.canvas.mapper.CanvasMapper;
import com.aid.canvas.service.CanvasPlainText;
import com.aid.generation.dto.GenerationRequests;
import com.aid.generation.service.GenerationInvocationContext;
import com.aid.generation.service.GenerationConversationStore;
import com.aid.generation.service.GenerationConversationStore.SessionState;
import com.aid.generation.service.GenerationConversationStore.StoredMessage;
import com.aid.generation.service.GenerationConversationStore.StoredPart;
import com.aid.generation.service.GenerationConversationStore.Turn;
import com.aid.generation.service.GenerationResourceResolver;
import com.aid.generation.service.GenerationResourceResolver.ResolvedMessages;
import com.aid.generation.service.GenerationResourceResolver.ResolvedResource;
import com.aid.generation.service.GenerationStreamSink;
import com.aid.generation.service.GenerationTargetBindingService;
import com.aid.generation.service.IGenericGenerationFacade;
import com.aid.generation.vo.GenerationResponse;
import com.aid.generation.vo.GenerationTaskView;
import com.aid.generation.vo.GenerationHistoryResponse;
import com.aid.generation.vo.GenerationSessionPage;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.media.dto.MediaTaskResponse;
import com.aid.media.dto.MediaTextGenerateRequest;
import com.aid.media.provider.StructuredOutputSupport;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.media.service.IMediaGenerationService;
import com.aid.media.service.MediaBillingQuoteService;
import com.aid.media.service.MediaTextStreamSink;
import com.aid.project.service.ProjectStyleSnapshotService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.redisson.api.RLock;
import org.redisson.api.RedissonClient;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/** 将受控通用请求适配到统一媒体任务体系。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class GenericGenerationFacadeImpl implements IGenericGenerationFacade {
    private static final String BIZ_TYPE = "GENERIC_GENERATION";
    private static final String IMAGE_DESCRIBE_FUNC = "canvas.text.image_describe";
    private static final ObjectMapper FINGERPRINT_MAPPER = new ObjectMapper()
            .configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
            .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
    private final IMediaGenerationService mediaGenerationService;
    private final MediaBillingQuoteService mediaBillingQuoteService;
    private final GenerationResourceResolver resourceResolver;
    private final com.aid.common.aid.oss.util.MediaUrlResolver mediaUrlResolver;
    private final GenerationConversationStore conversationStore;
    private final GenerationTargetBindingService targetBindingService;
    private final CanvasMapper canvasMapper;
    private final RedissonClient redissonClient;
    private final ProjectStyleSnapshotService styleSnapshotService;

    @Override
    public GenerationResponse generateText(GenerationRequests.Text request,
                                           GenerationInvocationContext context) {
        return text(request, context, false);
    }

    @Override
    public GenerationResponse submitText(GenerationRequests.Text request,
                                         GenerationInvocationContext context) {
        return text(request, context, true);
    }

    @Override
    public BillingQuoteVO quoteText(GenerationRequests.Text request,
                                    GenerationInvocationContext context) {
        requireQuoteRequest(request);
        validateImageDescribe(request, true);
        GenerationInvocationContext trusted = quoteContext(request, requireContext(context), "TEXT");
        Long projectId = resourceResolver.resolveProjectScope(
                request.getWorkspaceId(), request.getProjectId(), request.getEpisodeId(), trusted.getUserId());
        SessionState session = conversationStore.preview(request.getSession(), trusted.getUserId(),
                request.getWorkspaceId(), projectId, request.getEpisodeId());
        TextInvocation invocation = textRequest(request, trusted, false, session.history(),
                session.workspaceId(), session.projectId(), session.episodeId(), true);
        validateConversationTurn(session, invocation.currentMessages());
        return mediaBillingQuoteService.quoteText("MEDIA_TEXT", invocation.request(), 1);
    }

    private GenerationResponse text(GenerationRequests.Text request,
                                    GenerationInvocationContext context, boolean deferred) {
        validateImageDescribe(request, false);
        GenerationInvocationContext trusted = canvasContext(request, requireContext(context), "TEXT");
        return withSessionLock(request, trusted, "TEXT", () -> generateTextLocked(request, trusted, deferred));
    }

    private GenerationResponse generateTextLocked(GenerationRequests.Text request,
                                                   GenerationInvocationContext trusted, boolean deferred) {
        Long projectId = resourceResolver.resolveProjectScope(
                request.getWorkspaceId(), request.getProjectId(), request.getEpisodeId(), trusted.getUserId());
        SessionState session = conversationStore.open(request.getSession(), trusted.getUserId(),
                request.getWorkspaceId(), projectId, request.getEpisodeId(),
                createKey("TEXT", request.getClientRequestId()), nodeObjectId(request));
        projectId = session.projectId();
        String requestHash = requestHash("TEXT", request, trusted, session);
        GenerationResponse existing = existing(session, request, requestHash, trusted.getUserId());
        if (existing != null) return normalizeCanvasResponse(existing, request);
        requireSessionIdle(session);
        TextInvocation invocation = textRequest(request, trusted, false, session.history(),
                session.workspaceId(), projectId, session.episodeId(), false);
        validateConversationTurn(session, invocation.currentMessages());
        MediaTaskResponse task = submitNodeGeneration(request, trusted, "TEXT", requestHash,
                () -> deferred ? mediaGenerationService.submitText(invocation.request())
                        : mediaGenerationService.generateText(invocation.request()));
        Turn turn = conversationStore.record(session, request.getClientRequestId(), requestHash,
                invocation.currentMessages(), "TEXT", task);
        refreshConversationTask(session, task);
        return normalizeCanvasResponse(response(task, session.sessionId(), turn.assistantMessageId()), request);
    }

    @Override
    public void generateTextStream(GenerationRequests.Text request, GenerationInvocationContext context,
                                   GenerationStreamSink sink) {
        validateImageDescribe(request, false);
        GenerationInvocationContext trusted = canvasContext(request, requireContext(context), "TEXT");
        withSessionLock(request, trusted, "TEXT", () -> {
            generateTextStreamLocked(request, trusted, sink);
            return null;
        });
    }

    private void generateTextStreamLocked(GenerationRequests.Text request, GenerationInvocationContext trusted,
                                          GenerationStreamSink sink) {
        Long projectId = resourceResolver.resolveProjectScope(
                request.getWorkspaceId(), request.getProjectId(), request.getEpisodeId(), trusted.getUserId());
        SessionState session = conversationStore.open(request.getSession(), trusted.getUserId(),
                request.getWorkspaceId(), projectId, request.getEpisodeId(),
                createKey("TEXT", request.getClientRequestId()), nodeObjectId(request));
        projectId = session.projectId();
        String requestHash = requestHash("TEXT", request, trusted, session);
        GenerationConversationStore.ExistingTurn existing = conversationStore.findExisting(
                session, request.getClientRequestId(), requestHash);
        if (existing != null) {
            emitExisting(existing, session, sink, request);
            return;
        }
        requireSessionIdle(session);
        TextInvocation invocation = textRequest(request, trusted, true, session.history(),
                session.workspaceId(), projectId, session.episodeId(), false);
        validateConversationTurn(session, invocation.currentMessages());
        AtomicLong preparedTaskId = new AtomicLong();
        GenerationTargetBindingService.StreamStarter streamStarter = binder ->
                mediaGenerationService.generateTextStream(invocation.request(), new MediaTextStreamSink() {
                    @Override
                    public void onTaskPrepared(long taskId) {
                        preparedTaskId.set(taskId);
                        MediaTaskResponse prepared = mediaGenerationService.queryTaskLocal(taskId);
                        if (prepared == null) {
                            prepared = MediaTaskResponse.builder().taskId(taskId).mediaType("TEXT")
                                    .status("PROCESSING").modelName(request.getModelName()).build();
                        }
                        binder.accept(prepared);
                        Turn turn = conversationStore.record(session, request.getClientRequestId(), requestHash,
                                invocation.currentMessages(), "TEXT", prepared);
                        sink.onPrepared(taskId, session.sessionId(), turn.assistantMessageId());
                    }

                    @Override
                    public void onDetached(long taskId) {
                        sink.onDetached(taskId);
                    }

                    @Override
                    public void onDelta(String content) {
                        sink.onDelta(content);
                    }

                    @Override
                    public void onPublicReasoningSummaryDelta(String content) {
                        sink.onPublicReasoningSummaryDelta(content);
                    }

                    @Override
                    public void onDone(String fullText, String truncatedRawSnapshot) {
                        String complete = request.getCanvasNode() == null ? fullText
                                : CanvasPlainText.normalize(fullText == null ? "" : fullText, request.getResultFormat());
                        conversationStore.complete(preparedTaskId.get(), complete, null);
                        sink.onDone(complete);
                    }

                    @Override
                    public void onFailed(String userMessage) {
                        conversationStore.complete(preparedTaskId.get(), null, userMessage);
                        sink.onFailed(userMessage);
                    }
                });
        if (request.getCanvasNode() == null) {
            streamStarter.start(ignored -> { });
            return;
        }
        MediaTaskResponse recovered = targetBindingService.streamNode(request, trusted.getUserId(),
                "TEXT", requestHash, trusted.getCallId(), streamStarter);
        if (recovered == null) return;
        preparedTaskId.set(recovered.getTaskId());
        Turn turn = conversationStore.record(session, request.getClientRequestId(), requestHash,
                invocation.currentMessages(), "TEXT", recovered);
        sink.onPrepared(recovered.getTaskId(), session.sessionId(), turn.assistantMessageId());
        emitTask(recovered, sink, request);
    }

    @Override
    public GenerationResponse generateImage(GenerationRequests.Image request,
                                            GenerationInvocationContext context) {
        return image(request, context, false);
    }

    @Override
    public GenerationResponse submitImage(GenerationRequests.Image request,
                                          GenerationInvocationContext context) {
        return image(request, context, true);
    }

    @Override
    public BillingQuoteVO quoteImage(GenerationRequests.Image request,
                                     GenerationInvocationContext context) {
        requireQuoteRequest(request);
        GenerationInvocationContext trusted = quoteContext(request, requireContext(context), "IMAGE");
        Long projectId = resourceResolver.resolveProjectScope(
                request.getWorkspaceId(), request.getProjectId(), request.getEpisodeId(), trusted.getUserId());
        MediaImageGenerateRequest mediaRequest = imageRequest(request, trusted,
                request.getWorkspaceId(), projectId, request.getEpisodeId());
        return mediaBillingQuoteService.quoteImage("MEDIA_IMAGE", mediaRequest, 1);
    }

    private GenerationResponse image(GenerationRequests.Image request,
                                     GenerationInvocationContext context, boolean deferred) {
        GenerationInvocationContext trusted = canvasContext(request, requireContext(context), "IMAGE");
        return withSessionLock(request, trusted, "IMAGE", () -> generateImageLocked(request, trusted, deferred));
    }

    private GenerationResponse generateImageLocked(GenerationRequests.Image request,
                                                    GenerationInvocationContext trusted, boolean deferred) {
        Long projectId = resourceResolver.resolveProjectScope(
                request.getWorkspaceId(), request.getProjectId(), request.getEpisodeId(), trusted.getUserId());
        SessionState session = conversationStore.open(request.getSession(), trusted.getUserId(),
                request.getWorkspaceId(), projectId, request.getEpisodeId(),
                createKey("IMAGE", request.getClientRequestId()), nodeObjectId(request));
        projectId = session.projectId();
        String requestHash = requestHash("IMAGE", request, trusted, session);
        GenerationResponse existing = existing(session, request, requestHash, trusted.getUserId());
        if (existing != null) return existing;
        requireSessionIdle(session);
        List<ResolvedResource> resources = resourceResolver.resolve(
                session.workspaceId(), request.getReferences(), trusted.getUserId());
        List<ResolvedResource> storedResources = new ArrayList<>(resources);
        MediaImageGenerateRequest mediaRequest = imageRequest(request, trusted,
                session.workspaceId(), projectId, session.episodeId(), resources, storedResources);
        String conversationPrompt = request.getImageEdit() == null
                ? request.getPrompt() : mediaRequest.getPrompt();
        validateConversationTurn(session, List.of(storedPrompt(conversationPrompt, storedResources)));
        MediaTaskResponse task = submitNodeGeneration(request, trusted, "IMAGE", requestHash,
                () -> deferred ? mediaGenerationService.submitImage(mediaRequest)
                        : mediaGenerationService.generateImage(mediaRequest));
        Turn turn = conversationStore.record(session, request.getClientRequestId(), requestHash,
                List.of(storedPrompt(conversationPrompt, storedResources)), "IMAGE", task);
        refreshConversationTask(session, task);
        return response(task, session.sessionId(), turn.assistantMessageId());
    }

    private MediaImageGenerateRequest imageRequest(GenerationRequests.Image request,
                                                    GenerationInvocationContext trusted,
                                                    Long workspaceId, Long projectId, Long episodeId) {
        List<ResolvedResource> resources = resourceResolver.resolve(
                workspaceId, request.getReferences(), trusted.getUserId());
        return imageRequest(request, trusted, workspaceId, projectId, episodeId, resources, null);
    }

    private MediaImageGenerateRequest imageRequest(GenerationRequests.Image request,
                                                    GenerationInvocationContext trusted,
                                                    Long workspaceId, Long projectId, Long episodeId,
                                                    List<ResolvedResource> resources,
                                                    List<ResolvedResource> storedResources) {
        MediaImageGenerateRequest target = new MediaImageGenerateRequest();
        common(request, trusted, target, projectId, episodeId);
        target.setPrompt(mediaPrompt(request.getPrompt(), resources, workspaceId, request.getNodeReferences(), trusted.getUserId()));
        target.setNegativePrompt(request.getNegativePrompt());
        target.setSize(request.getSize());
        target.setExpectedImageCount(request.getExpectedImageCount());
        Map<String, Object> options = resourceResolver.sanitizeParameters(request.getParameters());
        List<String> images = urls(resources, "IMAGE", null);
        rejectNonImage(resources);
        Map<String, com.aid.media.dto.AuthorizedImageAssetSnapshot> authorizedImages =
                GenerationResourceResolver.authorizedImageSnapshots(resources);
        if (!authorizedImages.isEmpty()) target.setAuthorizedReferenceImages(authorizedImages);
        if (resources.size() == 1) {
            target.setAuthorizedReferenceImage(authorizedImages.get(resources.get(0).url()));
        }
        if (CollectionUtil.isNotEmpty(images)) options.put("referenceImages", images);
        target.setOptions(options);
        ResolvedResource editSource = applyImageEdit(request, trusted.getUserId(), workspaceId, target);
        if (storedResources != null && editSource != null) storedResources.add(editSource);
        return target;
    }

    private ResolvedResource applyImageEdit(GenerationRequests.Image request, Long userId, Long workspaceId,
                                            MediaImageGenerateRequest target) {
        GenerationRequests.ImageEdit edit = request.getImageEdit();
        if (edit == null) {
            if (isImageEditFunction(request.getFuncCode())) {
                throw new ServiceException("图片编辑参数缺失");
            }
            return null;
        }
        if (StrUtil.isBlank(edit.getOperation()) || edit.getSourceResourceId() == null
                || edit.getSourceResourceId() <= 0) {
            throw new ServiceException("图片编辑操作或原图资源缺失");
        }
        rejectImageEditProviderOverrides(request.getParameters());
        String operation = edit.getOperation().trim().toUpperCase(java.util.Locale.ROOT);
        boolean hasMask = edit.getMaskResourceId() != null;
        if (hasMask && edit.getMaskResourceId() <= 0) throw new ServiceException("蒙版资源错误");
        boolean structuredEdit = Set.of("TOUCH_EDIT", "EMOTION", "PORTRAIT_TEXTURE", "MULTI_VIEW", "STYLE_APPLY")
                .contains(operation);
        if (hasMask && ("EXPAND".equals(operation) || "RELIGHT".equals(operation)
                || "LAYER_SPLIT".equals(operation) || structuredEdit)) {
            throw new ServiceException("当前操作不支持蒙版");
        }
        if (("ERASE".equals(operation) || "EXPAND".equals(operation) || "LAYER_SPLIT".equals(operation)
                || structuredEdit)
                && CollectionUtil.isNotEmpty(request.getReferences())) {
            throw new ServiceException("当前操作不支持额外参考图");
        }
        String capabilityCode = switch (operation) {
            case "REDRAW" -> hasMask ? "image_inpainting" : "image_edit";
            case "ERASE" -> "image_inpainting";
            case "EXPAND" -> "image_outpainting";
            case "RELIGHT" -> "image_edit";
            case "LAYER_SPLIT" -> "image_layer_decomposition";
            case "TOUCH_EDIT", "EMOTION", "PORTRAIT_TEXTURE", "MULTI_VIEW", "STYLE_APPLY" -> "image_edit";
            default -> throw new ServiceException("图片编辑操作错误");
        };
        String funcCode = switch (operation) {
            case "REDRAW" -> "canvas.image.redraw";
            case "ERASE" -> "canvas.image.erase";
            case "EXPAND" -> "canvas.image.expand";
            case "RELIGHT" -> "canvas.image.relight";
            case "LAYER_SPLIT" -> "canvas.image.layer_split";
            case "TOUCH_EDIT" -> "canvas.image.touch_edit";
            case "EMOTION" -> "canvas.image.emotion";
            case "PORTRAIT_TEXTURE" -> "canvas.image.portrait_texture";
            case "MULTI_VIEW" -> "canvas.image.multi_view";
            case "STYLE_APPLY" -> "canvas.image.style_apply";
            default -> throw new ServiceException("图片编辑操作错误");
        };
        if (StrUtil.isNotBlank(request.getCapabilityCode())
                && !capabilityCode.equals(request.getCapabilityCode())) {
            throw new ServiceException("模型能力与操作不匹配");
        }
        if (StrUtil.isNotBlank(request.getFuncCode()) && !funcCode.equals(request.getFuncCode())) {
            throw new ServiceException("功能编码与操作不匹配");
        }
        if (("ERASE".equals(operation) || hasMask)
                && (edit.getMaskResourceId() == null || StrUtil.isBlank(edit.getMaskEncoding()))) {
            throw new ServiceException("蒙版资源或语义缺失");
        }
        if (hasMask && !Set.of("BLACK_WHITE", "ALPHA").contains(
                edit.getMaskEncoding().trim().toUpperCase(java.util.Locale.ROOT))) {
            throw new ServiceException("蒙版语义错误");
        }
        if (!hasMask && StrUtil.isNotBlank(edit.getMaskEncoding())) {
            throw new ServiceException("蒙版资源缺失");
        }
        GenerationResourceResolver.ResolvedResource source = resourceResolver.resolveImage(
                workspaceId, edit.getSourceResourceId(), "SOURCE", userId);
        if ("LAYER_SPLIT".equals(operation) || structuredEdit) {
            requireLayerSourceNode(workspaceId, edit);
        }
        if ("LAYER_SPLIT".equals(operation)) {
            if (StrUtil.isNotBlank(request.getNegativePrompt()) || !target.getOptions().isEmpty()) {
                throw new ServiceException("图层分离不支持负向提示词或附加参数");
            }
            if (request.getExpectedImageCount() != null && request.getExpectedImageCount() != 17) {
                throw new ServiceException("图层分离预估输出数量必须为 17");
            }
            target.setExpectedImageCount(17);
            if (StrUtil.isBlank(target.getSize())) target.setSize("1.5K");
        }
        target.setReferenceImageUrl(source.url());
        target.setAuthorizedReferenceImage(source.authorizedImageSnapshot());
        target.setCapabilityCode(capabilityCode);
        target.setBusinessFuncCode(funcCode);
        if (hasMask) {
            if (Objects.equals(edit.getSourceResourceId(), edit.getMaskResourceId())) {
                throw new ServiceException("蒙版不能与原图相同");
            }
            GenerationResourceResolver.ResolvedResource mask = resourceResolver.resolveImage(
                    workspaceId, edit.getMaskResourceId(), "MASK", userId);
            target.setMaskImageUrl(mask.url());
            target.setAuthorizedMaskImage(mask.authorizedImageSnapshot());
            target.setMaskEncoding(edit.getMaskEncoding().trim().toUpperCase(java.util.Locale.ROOT));
        }
        if ("EXPAND".equals(operation)) {
            if (edit.getExpand() == null) throw new ServiceException("扩图参数缺失");
            validateExpand(edit.getExpand());
            target.setTargetWidth(edit.getExpand().getTargetWidth());
            target.setTargetHeight(edit.getExpand().getTargetHeight());
            target.setSourceX(edit.getExpand().getSourceX());
            target.setSourceY(edit.getExpand().getSourceY());
            applyExpandOutputSize(target);
        } else if (edit.getExpand() != null) {
            throw new ServiceException("当前操作不支持扩图参数");
        }
        if ("RELIGHT".equals(operation)) {
            if (edit.getLighting() == null) throw new ServiceException("灯光参数缺失");
            validateLighting(edit.getLighting());
            applyLighting(edit.getLighting(), target);
        } else if (edit.getLighting() != null) {
            throw new ServiceException("当前操作不支持灯光参数");
        }
        if ("ERASE".equals(operation) && StrUtil.isBlank(request.getPrompt())) {
            target.setPrompt("移除蒙版选区中的物体，并根据周围内容自然补全背景");
        }
        if (structuredEdit) applyStructuredImageEdit(operation, edit, target.getPrompt(), userId, target);
        else if (edit.getSelections() != null || edit.getFaces() != null || edit.getPortrait() != null
                || edit.getCamera() != null || edit.getStyle() != null) {
            throw new ServiceException("当前操作包含不适用的编辑参数");
        }
        return source;
    }

    private void applyStructuredImageEdit(String operation, GenerationRequests.ImageEdit edit, String userPrompt,
                                          Long userId, MediaImageGenerateRequest target) {
        if (edit.getExpand() != null || edit.getLighting() != null || StrUtil.isNotBlank(edit.getMaskEncoding())
                || (edit.getSelections() != null && !"TOUCH_EDIT".equals(operation))
                || (edit.getFaces() != null && !"EMOTION".equals(operation))
                || (edit.getPortrait() != null && !"PORTRAIT_TEXTURE".equals(operation))
                || (edit.getCamera() != null && !"MULTI_VIEW".equals(operation))
                || (edit.getStyle() != null && !"STYLE_APPLY".equals(operation))) {
            throw new ServiceException("当前操作包含不适用的编辑参数");
        }
        String instruction;
        switch (operation) {
            case "TOUCH_EDIT" -> {
                if (CollectionUtil.isEmpty(edit.getSelections()) || edit.getSelections().size() > 8)
                    throw new ServiceException("请选择1至8个编辑区域");
                List<String> parts = new ArrayList<>();
                int index = 0;
                for (GenerationRequests.ImageRegion region : edit.getSelections()) {
                    validateRegion(region);
                    if (StrUtil.isBlank(region.getInstruction())) throw new ServiceException("区域编辑要求不能为空");
                    if (region.getInstruction().length() > 2000) throw new ServiceException("区域编辑要求过长");
                    parts.add("区域" + (++index) + "（原图归一化坐标" + regionText(region) + "）："
                            + region.getInstruction().trim());
                }
                instruction = "按所选区域依次编辑图片；其他区域和人物身份尽量保持一致。" + String.join("；", parts);
            }
            case "EMOTION" -> {
                if (CollectionUtil.isEmpty(edit.getFaces()) || edit.getFaces().size() > 8)
                    throw new ServiceException("请提供1至8个人脸区域");
                List<String> parts = new ArrayList<>();
                int index = 0;
                for (GenerationRequests.FaceExpression face : edit.getFaces()) {
                    if (face == null || face.getRegion() == null || StrUtil.isBlank(face.getExpression()))
                        throw new ServiceException("人脸区域或目标表情缺失");
                    if (face.getExpression().length() > 80) throw new ServiceException("表情描述过长");
                    validateRegion(face.getRegion());
                    parts.add("人脸" + (++index) + "（原图归一化坐标" + regionText(face.getRegion())
                            + "）调整为" + face.getExpression().trim());
                }
                instruction = "只调整指定人脸的表情，尽量保持人物身份与画面其他内容。" + String.join("；", parts);
            }
            case "PORTRAIT_TEXTURE" -> {
                GenerationRequests.PortraitTexture portrait = edit.getPortrait();
                if (portrait == null || (portrait.getSkinTexture() == null && portrait.getSurfaceTexture() == null
                        && portrait.getSharpness() == null)) throw new ServiceException("人像质感参数缺失");
                requireRange(portrait.getSkinTexture(), -100, 100, "肤质");
                requireRange(portrait.getSurfaceTexture(), -100, 100, "表面纹理");
                requireRange(portrait.getSharpness(), -100, 100, "清晰度");
                instruction = "调整人像质感，尽量保持人物身份和画面构图；肤质="
                        + Objects.toString(portrait.getSkinTexture(), "保持") + "，表面纹理="
                        + Objects.toString(portrait.getSurfaceTexture(), "保持") + "，清晰度="
                        + Objects.toString(portrait.getSharpness(), "保持") + "。数值范围为-100至100，0表示中性。";
            }
            case "MULTI_VIEW" -> {
                GenerationRequests.Camera camera = edit.getCamera();
                if (camera == null || camera.getYaw() == null || camera.getPitch() == null
                        || camera.getFraming() == null
                        || !Set.of("WIDE", "MEDIUM", "CLOSE").contains(camera.getFraming()))
                    throw new ServiceException("机位参数缺失或景别错误");
                requireRange(camera.getYaw(), 0, 359, "水平角");
                requireRange(camera.getPitch(), -90, 90, "垂直角");
                String framing = switch (camera.getFraming()) {
                    case "WIDE" -> "远景";
                    case "MEDIUM" -> "中景";
                    default -> "近景";
                };
                instruction = "基于原图生成一个新机位画面，水平旋转" + camera.getYaw() + "度，垂直角"
                        + camera.getPitch() + "度，景别为" + framing + "；尽量保持主体身份和场景一致。";
            }
            case "STYLE_APPLY" -> {
                GenerationRequests.Style style = edit.getStyle();
                if (style == null || style.getStyleAssetId() == null || style.getStyleAssetId() <= 0
                        || StrUtil.isBlank(style.getStyleSource())) throw new ServiceException("请选择有效风格");
                var resolved = styleSnapshotService.resolve(style.getStyleSource(), style.getStyleAssetId(), userId);
                instruction = "将原图转换为所选风格，尽量保持主体与构图。风格：" + resolved.styleName()
                        + "。风格描述：" + resolved.publicPrompt();
            }
            default -> throw new ServiceException("图片编辑操作错误");
        }
        String combined = StrUtil.isBlank(userPrompt) ? instruction : instruction + "\n补充要求：" + userPrompt.trim();
        if (combined.length() > 100000) throw new ServiceException("编辑要求过长");
        target.setPrompt(combined);
    }

    private void validateRegion(GenerationRequests.ImageRegion region) {
        if (region == null || region.getX() == null || region.getY() == null
                || region.getWidth() == null || region.getHeight() == null
                || !Double.isFinite(region.getX()) || !Double.isFinite(region.getY())
                || !Double.isFinite(region.getWidth()) || !Double.isFinite(region.getHeight())
                || region.getX() < 0 || region.getY() < 0 || region.getWidth() <= 0 || region.getHeight() <= 0
                || region.getX() + region.getWidth() > 1 || region.getY() + region.getHeight() > 1) {
            throw new ServiceException("选区坐标须为原图归一化范围内的矩形");
        }
    }

    private String regionText(GenerationRequests.ImageRegion region) {
        return "x=" + region.getX() + ",y=" + region.getY() + ",宽=" + region.getWidth()
                + ",高=" + region.getHeight();
    }

    private void requireLayerSourceNode(Long workspaceId, GenerationRequests.ImageEdit edit) {
        if (StrUtil.isBlank(edit.getSourceObjectId()) || edit.getSourceExpectedVersion() == null) {
            throw new ServiceException("图片编辑需要源节点 ID 和版本");
        }
        CanvasObject sourceNode = canvasMapper.selectCanvasObject(workspaceId, edit.getSourceObjectId());
        if (sourceNode == null || !"NODE".equals(sourceNode.getObjectType())
                || !Objects.equals(sourceNode.getDeleted(), 0)
                || !Objects.equals(sourceNode.getObjectVersion(), edit.getSourceExpectedVersion())) {
            throw new ServiceException("源节点版本已变化");
        }
        com.alibaba.fastjson2.JSONObject content;
        try {
            content = com.alibaba.fastjson2.JSON.parseObject(sourceNode.getContentJson());
        } catch (RuntimeException invalid) {
            throw new ServiceException("源节点内容无效");
        }
        com.alibaba.fastjson2.JSONArray resourceIds = content == null ? null : content.getJSONArray("resourceIds");
        if (resourceIds == null || resourceIds.stream().noneMatch(id ->
                Objects.equals(String.valueOf(id), String.valueOf(edit.getSourceResourceId())))) {
            throw new ServiceException("源节点未引用原图资源");
        }
    }

    /** HTTP Bean Validation 之外的服务层门禁，保证 Skill/Agent 内部调用也遵守同一契约。 */
    private void validateExpand(GenerationRequests.Expand expand) {
        if (expand.getTargetWidth() == null || expand.getTargetWidth() <= 0
                || expand.getTargetHeight() == null || expand.getTargetHeight() <= 0
                || expand.getSourceX() == null || expand.getSourceX() < 0
                || expand.getSourceY() == null || expand.getSourceY() < 0) {
            throw new ServiceException("扩图参数错误");
        }
    }

    private void validateLighting(GenerationRequests.Lighting lighting) {
        requireRange(lighting.getBrightness(), -100, 100, "亮度");
        requireRange(lighting.getColorTemperature(), 1000, 20000, "色温");
        requireRange(lighting.getKeyLightAzimuth(), 0, 359, "主光方位角");
        requireRange(lighting.getKeyLightElevation(), -90, 90, "主光高度角");
        requireRange(lighting.getRimLightAzimuth(), 0, 359, "轮廓光方位角");
        requireRange(lighting.getRimLightElevation(), -90, 90, "轮廓光高度角");
    }

    private void requireRange(Integer value, int min, int max, String label) {
        if (value != null && (value < min || value > max)) {
            throw new ServiceException(label + "参数超出范围");
        }
    }

    private boolean isImageEditFunction(String funcCode) {
        return Set.of("canvas.image.redraw", "canvas.image.erase", "canvas.image.expand", "canvas.image.relight",
                        "canvas.image.layer_split", "canvas.image.touch_edit", "canvas.image.emotion",
                        "canvas.image.portrait_texture", "canvas.image.multi_view", "canvas.image.style_apply")
                .contains(StrUtil.blankToDefault(funcCode, ""));
    }

    /** 图片编辑只接收业务语义，供应商 function、原图和蒙版地址均由可信适配层生成。 */
    private void rejectImageEditProviderOverrides(Object value) {
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                String key = Objects.toString(entry.getKey(), "")
                        .toLowerCase(java.util.Locale.ROOT).replace("-", "_");
                if (Set.of("function", "base_image_url", "mask_image_url", "image_url", "images")
                        .contains(key)) {
                    throw new ServiceException("图片编辑参数包含供应商保留字段");
                }
                rejectImageEditProviderOverrides(entry.getValue());
            }
        } else if (value instanceof java.util.Collection<?> collection) {
            for (Object item : collection) rejectImageEditProviderOverrides(item);
        }
    }

    /** 扩图输出尺寸以目标画布为唯一权威值，显式 size/ratio 冲突直接拒绝。 */
    private void applyExpandOutputSize(MediaImageGenerateRequest target) {
        String expected = target.getTargetWidth() + "x" + target.getTargetHeight();
        if (StrUtil.isNotBlank(target.getSize()) && !expected.equals(normalizeDimensions(target.getSize()))) {
            throw new ServiceException("扩图目标尺寸与输出尺寸冲突");
        }
        Map<String, Object> options = target.getOptions();
        if (options != null) {
            Object optionSize = options.get("size");
            if (optionSize != null && !expected.equals(normalizeDimensions(String.valueOf(optionSize)))) {
                throw new ServiceException("扩图目标尺寸与输出尺寸冲突");
            }
            Object ratio = options.containsKey("aspectRatio")
                    ? options.get("aspectRatio") : options.get("aspect_ratio");
            if (ratio != null && !matchesRatio(target.getTargetWidth(), target.getTargetHeight(), String.valueOf(ratio))) {
                throw new ServiceException("扩图目标尺寸与画幅比例冲突");
            }
        }
        // 目标画布由 targetWidth/targetHeight 表达。是否需要再下发 size 由已选模型的
        // 结构化能力在媒体预检阶段决定，避免给不支持规格档位的协议强塞像素尺寸。
    }

    private String normalizeDimensions(String value) {
        if (StrUtil.isBlank(value)) return null;
        String[] parts = value.trim().split("[*xX×]");
        if (parts.length != 2) return null;
        try {
            int width = Integer.parseInt(parts[0].trim());
            int height = Integer.parseInt(parts[1].trim());
            return width > 0 && height > 0 ? width + "x" + height : null;
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private boolean matchesRatio(int width, int height, String value) {
        if (StrUtil.isBlank(value)) return false;
        String[] parts = value.trim().split(":");
        if (parts.length != 2) return false;
        try {
            double requested = Double.parseDouble(parts[0]) / Double.parseDouble(parts[1]);
            return Double.isFinite(requested) && Math.abs((double) width / height - requested) <= 0.01D;
        } catch (NumberFormatException | ArithmeticException ex) {
            return false;
        }
    }

    private void applyLighting(GenerationRequests.Lighting lighting, MediaImageGenerateRequest target) {
        target.setBrightness(lighting.getBrightness());
        target.setColorTemperature(lighting.getColorTemperature());
        target.setKeyLightAzimuth(lighting.getKeyLightAzimuth());
        target.setKeyLightElevation(lighting.getKeyLightElevation());
        target.setRimLightEnabled(lighting.getRimLightEnabled());
        target.setRimLightAzimuth(lighting.getRimLightAzimuth());
        target.setRimLightElevation(lighting.getRimLightElevation());
        StringBuilder instruction = new StringBuilder(StrUtil.blankToDefault(target.getPrompt(), "调整图片灯光"));
        appendLighting(instruction, "亮度", lighting.getBrightness());
        appendLighting(instruction, "色温", lighting.getColorTemperature());
        appendLighting(instruction, "主光方位角", lighting.getKeyLightAzimuth());
        appendLighting(instruction, "主光高度角", lighting.getKeyLightElevation());
        if (lighting.getRimLightEnabled() != null) {
            instruction.append("；轮廓光=").append(Boolean.TRUE.equals(lighting.getRimLightEnabled()) ? "开启" : "关闭");
        }
        appendLighting(instruction, "轮廓光方位角", lighting.getRimLightAzimuth());
        appendLighting(instruction, "轮廓光高度角", lighting.getRimLightElevation());
        target.setPrompt(instruction.toString());
    }

    private void appendLighting(StringBuilder instruction, String label, Integer value) {
        if (value != null) instruction.append('；').append(label).append('=').append(value);
    }

    @Override
    public GenerationResponse generateVideo(GenerationRequests.Video request,
                                            GenerationInvocationContext context) {
        return video(request, context, false);
    }

    @Override
    public GenerationResponse submitVideo(GenerationRequests.Video request,
                                          GenerationInvocationContext context) {
        return video(request, context, true);
    }

    @Override
    public BillingQuoteVO quoteVideo(GenerationRequests.Video request,
                                     GenerationInvocationContext context) {
        requireQuoteRequest(request);
        GenerationInvocationContext trusted = quoteContext(request, requireContext(context), "VIDEO");
        Long projectId = resourceResolver.resolveProjectScope(
                request.getWorkspaceId(), request.getProjectId(), request.getEpisodeId(), trusted.getUserId());
        SessionState session = conversationStore.preview(request.getSession(), trusted.getUserId(),
                request.getWorkspaceId(), projectId, request.getEpisodeId());
        VideoInvocation invocation = videoRequest(request, trusted,
                session.workspaceId(), session.projectId(), session.episodeId());
        validateConversationTurn(session, List.of(storedPrompt(request.getPrompt(), invocation.resources())));
        var quoteImages = new LinkedHashMap<String, com.aid.media.dto.AuthorizedImageAssetSnapshot>();
        for (ResolvedResource resource : invocation.resources()) {
            if ("IMAGE".equals(resource.mediaType())) {
                quoteImages.putIfAbsent(resource.url(), resource.imageSnapshot());
            }
        }
        invocation.request().setQuoteReferenceImages(quoteImages);
        return mediaBillingQuoteService.quoteReadOnlyVideo("MEDIA_VIDEO", invocation.request(), 1);
    }

    private GenerationResponse video(GenerationRequests.Video request,
                                     GenerationInvocationContext context, boolean deferred) {
        GenerationInvocationContext trusted = canvasContext(request, requireContext(context), "VIDEO");
        return withSessionLock(request, trusted, "VIDEO", () -> generateVideoLocked(request, trusted, deferred));
    }

    private GenerationResponse generateVideoLocked(GenerationRequests.Video request,
                                                    GenerationInvocationContext trusted, boolean deferred) {
        Long projectId = resourceResolver.resolveProjectScope(
                request.getWorkspaceId(), request.getProjectId(), request.getEpisodeId(), trusted.getUserId());
        SessionState session = conversationStore.open(request.getSession(), trusted.getUserId(),
                request.getWorkspaceId(), projectId, request.getEpisodeId(),
                createKey("VIDEO", request.getClientRequestId()), nodeObjectId(request));
        projectId = session.projectId();
        String requestHash = requestHash("VIDEO", request, trusted, session);
        GenerationResponse existing = existing(session, request, requestHash, trusted.getUserId());
        if (existing != null) return existing;
        requireSessionIdle(session);
        VideoInvocation invocation = videoRequest(request, trusted,
                session.workspaceId(), projectId, session.episodeId());
        List<ResolvedResource> resources = invocation.resources();
        MediaVideoGenerateRequest mediaRequest = invocation.request();
        validateConversationTurn(session, List.of(storedPrompt(request.getPrompt(), resources)));
        MediaTaskResponse task = submitNodeGeneration(request, trusted, "VIDEO", requestHash,
                () -> deferred ? mediaGenerationService.submitVideo(mediaRequest)
                        : mediaGenerationService.generateVideo(mediaRequest));
        Turn turn = conversationStore.record(session, request.getClientRequestId(), requestHash,
                List.of(storedPrompt(request.getPrompt(), resources)), "VIDEO", task);
        refreshConversationTask(session, task);
        return response(task, session.sessionId(), turn.assistantMessageId());
    }

    private String mediaPrompt(String prompt, List<ResolvedResource> resources, Long workspaceId,
                               List<GenerationRequests.CanvasTextReference> references, Long userId) {
        String resolved = resourceResolver.resolveMentions(prompt, resources);
        String context = resourceResolver.resolveCanvasTextReferences(workspaceId, references, userId);
        return context.isEmpty() ? resolved : StrUtil.blankToDefault(resolved, "") + "\n\n" + context;
    }

    private VideoInvocation videoRequest(GenerationRequests.Video request,
                                         GenerationInvocationContext trusted,
                                         Long workspaceId, Long projectId, Long episodeId) {
        List<ResolvedResource> resources = resourceResolver.resolve(
                workspaceId, request.getReferences(), trusted.getUserId());
        MediaVideoGenerateRequest mediaRequest = new MediaVideoGenerateRequest();
        common(request, trusted, mediaRequest, projectId, episodeId);
        mediaRequest.setWorkspaceId(workspaceId);
        mediaRequest.setPrompt(mediaPrompt(request.getPrompt(), resources, workspaceId, request.getNodeReferences(), trusted.getUserId()));
        mediaRequest.setDurationSeconds(request.getDurationSeconds());
        mediaRequest.setAspectRatio(request.getAspectRatio());
        mediaRequest.setAudio(request.getAudio());
        mediaRequest.setBgm(request.getBgm());
        mediaRequest.setAudioType(request.getAudioType());
        mediaRequest.setVoiceId(request.getVoiceId());
        Map<String, Object> options = resourceResolver.sanitizeParameters(request.getParameters());
        com.aid.generation.service.GenerationVideoReferences.apply(mediaRequest, resources, options, mediaUrlResolver);
        return new VideoInvocation(mediaRequest, List.copyOf(resources));
    }

    @Override
    public GenerationHistoryResponse history(Long sessionId, Long beforeSeq, Integer limit,
                                             GenerationInvocationContext context) {
        GenerationInvocationContext trusted = requireContext(context);
        return conversationStore.history(sessionId, beforeSeq, limit, trusted.getUserId());
    }

    @Override
    public GenerationSessionPage sessions(Integer pageNum, Integer pageSize,
                                          GenerationInvocationContext context) {
        GenerationInvocationContext trusted = requireContext(context);
        return conversationStore.sessions(pageNum, pageSize, trusted.getUserId());
    }

    @Override
    public GenerationTaskView task(Long taskId, GenerationInvocationContext context) {
        GenerationInvocationContext trusted = requireContext(context);
        MediaTaskResponse task = mediaGenerationService.queryTaskByOwner(taskId, trusted.getUserId());
        conversationStore.complete(task);
        GenerationTaskView view = GenerationTaskView.from(task);
        TaskBinding canvasBinding = canvasMapper.selectTaskBinding(taskId);
        if (view != null && canvasBinding != null && "TEXT".equals(canvasBinding.getMediaType())
                && view.getTextContent() != null) {
            view.setTextContent(CanvasPlainText.normalize(view.getTextContent(), canvasBinding.getResultFormat()));
        }
        return view;
    }

    private TextInvocation textRequest(GenerationRequests.Text request,
                                       GenerationInvocationContext context,
                                       boolean streaming,
                                       List<MediaTextGenerateRequest.TextMessageItem> history,
                                       Long workspaceId,
                                       Long projectId,
                                       Long episodeId,
                                       boolean quoteOnly) {
        if (CollectionUtil.isNotEmpty(request.getNodeReferences())
                && request.getCanvasNode() == null && !quoteOnly) {
            throw new ServiceException("节点引用仅支持画布节点生成");
        }
        String nodeContext = resourceResolver.resolveCanvasTextReferences(
                workspaceId, request.getNodeReferences(), context.getUserId());
        if (StrUtil.isBlank(request.getPrompt()) && CollectionUtil.isEmpty(request.getMessages())
                && nodeContext.isEmpty()) {
            throw new ServiceException("文本消息不能为空");
        }
        MediaTextGenerateRequest target = new MediaTextGenerateRequest();
        target.setModelName(request.getModelName());
        target.setCapabilityCode(request.getCapabilityCode());
        target.setProjectId(projectId);
        target.setEpisodeId(episodeId);
        List<ResolvedResource> promptResources = resourceResolver.resolve(
                workspaceId, request.getReferences(), context.getUserId());
        if (IMAGE_DESCRIBE_FUNC.equals(request.getFuncCode())
                && (promptResources.size() != 1 || !"IMAGE".equals(promptResources.get(0).mediaType()))) {
            throw new ServiceException("图片反推文字仅接受一张图片资源");
        }
        String resolvedPrompt = resourceResolver.resolveMentions(request.getPrompt(), promptResources);
        if (!nodeContext.isEmpty()) resolvedPrompt = (resolvedPrompt == null ? "" : resolvedPrompt) + nodeContext;
        List<MediaTextGenerateRequest.TextMessageItem> messages = new ArrayList<>();
        if (StrUtil.isNotBlank(context.getSystemPrompt())) {
            MediaTextGenerateRequest.TextMessageItem system = new MediaTextGenerateRequest.TextMessageItem();
            system.setRole("system");
            system.setContent(context.getSystemPrompt());
            messages.add(system);
        }
        if (CollectionUtil.isNotEmpty(history)) messages.addAll(history);
        ResolvedMessages current = resourceResolver.resolveMessages(
                workspaceId, request.getMessages(), context.getUserId());
        messages.addAll(current.providerMessages());
        List<StoredMessage> stored = new ArrayList<>(current.storedMessages());
        if (CollectionUtil.isNotEmpty(promptResources)) {
            MediaTextGenerateRequest.TextMessageItem referencedPrompt = new MediaTextGenerateRequest.TextMessageItem();
            referencedPrompt.setRole("user");
            referencedPrompt.setContent(resolvedPrompt);
            referencedPrompt.setParts(resourceResolver.toTextParts(promptResources));
            messages.add(referencedPrompt);
            stored.add(storedPrompt(resolvedPrompt, promptResources));
            target.setPrompt(null);
        } else {
            target.setPrompt(resolvedPrompt);
            if (StrUtil.isNotBlank(resolvedPrompt)) stored.add(storedPrompt(resolvedPrompt, List.of()));
        }
        target.setMessages(messages);
        target.setOptions(resourceResolver.sanitizeParameters(request.getParameters()));
        if (context.getStructuredOutputEnabled() != null) {
            target.getOptions().remove("response_format");
            target.getOptions().put(StructuredOutputSupport.ENABLED_KEY, context.getStructuredOutputEnabled());
        }
        target.setStream(streaming);
        target.setReasoningEnabled(request.getReasoningEnabled());
        target.setReasoningLevel(request.getReasoningLevel());
        target.setReasoningBudgetTokens(request.getReasoningBudgetTokens());
        target.setIncludeReasoning(request.getIncludeReasoning());
        trusted(target, request.getClientRequestId(), context, "TEXT");
        return new TextInvocation(target, stored);
    }

    private static void validateImageDescribe(GenerationRequests.Text request, boolean quoteOnly) {
        if (StrUtil.isBlank(request.getFuncCode())) return;
        if (!IMAGE_DESCRIBE_FUNC.equals(request.getFuncCode())) {
            throw new ServiceException("文本功能编码不可用: " + request.getFuncCode());
        }
        if ((!quoteOnly && request.getCanvasNode() == null) || request.getWorkspaceId() == null) {
            throw new ServiceException("图片反推文字必须指定画布结果节点和工作区");
        }
        if (StrUtil.isBlank(request.getModelName())) {
            throw new ServiceException("图片反推文字必须选择业务模型");
        }
        if (StrUtil.isBlank(request.getPrompt()) || request.getSession() != null
                || CollectionUtil.isNotEmpty(request.getMessages())
                || CollectionUtil.isNotEmpty(request.getNodeReferences())) {
            throw new ServiceException("图片反推文字需要文字要求和一张图片，不接受会话、消息或节点引用");
        }
        if (request.getReferences() == null || request.getReferences().size() != 1
                || request.getReferences().get(0) == null
                || !"REFERENCE".equalsIgnoreCase(request.getReferences().get(0).getRole())) {
            throw new ServiceException("图片反推文字需要一张已登记的参考图片");
        }
        if (request.getResultFormat() != null && !"TEXT".equals(request.getResultFormat())) {
            throw new ServiceException("图片反推文字仅支持纯文本结果");
        }
    }

    private void common(GenerationRequests.Base request, GenerationInvocationContext context,
                        MediaImageGenerateRequest target, Long projectId, Long episodeId) {
        target.setModelName(request.getModelName());
        target.setCapabilityCode(request.getCapabilityCode());
        target.setProjectId(projectId);
        target.setEpisodeId(episodeId);
        target.setUserId(context.getUserId());
        target.setBusinessFuncCode(context.getBusinessFuncCode());
        target.setBizTaskId(context.getBizTaskId());
        target.setBizTaskType(StrUtil.blankToDefault(context.getBizTaskType(), BIZ_TYPE));
        target.setCallId(callId(request.getClientRequestId(), context, "IMAGE"));
        target.setCallIdentity(context.getCallIdentity());
    }

    private void common(GenerationRequests.Base request, GenerationInvocationContext context,
                        MediaVideoGenerateRequest target, Long projectId, Long episodeId) {
        target.setModelName(request.getModelName());
        target.setCapabilityCode(request.getCapabilityCode());
        target.setProjectId(projectId);
        target.setEpisodeId(episodeId);
        target.setUserId(context.getUserId());
        target.setBusinessFuncCode(context.getBusinessFuncCode());
        target.setBizTaskId(context.getBizTaskId());
        target.setBizTaskType(StrUtil.blankToDefault(context.getBizTaskType(), BIZ_TYPE));
        target.setCallId(callId(request.getClientRequestId(), context, "VIDEO"));
        target.setCallIdentity(context.getCallIdentity());
    }

    private void trusted(MediaTextGenerateRequest target, String clientRequestId,
                         GenerationInvocationContext context, String mediaType) {
        target.setUserId(context.getUserId());
        target.setBusinessFuncCode(context.getBusinessFuncCode());
        target.setBizTaskId(context.getBizTaskId());
        target.setBizTaskType(StrUtil.blankToDefault(context.getBizTaskType(), BIZ_TYPE));
        target.setCallId(callId(clientRequestId, context, mediaType));
        target.setCallIdentity(context.getCallIdentity());
        target.setBillingExempt(Boolean.TRUE.equals(context.getBillingExempt()));
        target.setAuthorizedPreHoldCap(context.getAuthorizedPreHoldCap());
    }

    private String callId(String clientRequestId, GenerationInvocationContext context, String mediaType) {
        if (StrUtil.isNotBlank(context.getCallId())) return context.getCallId();
        return SecureUtil.sha256("generic|" + mediaType + "|" + context.getUserId() + "|" + clientRequestId);
    }

    private static List<String> urls(List<ResolvedResource> resources, String mediaType, String role) {
        List<String> result = new ArrayList<>();
        for (ResolvedResource resource : resources) {
            if (mediaType.equals(resource.mediaType()) && (role == null || role.equals(resource.role()))) {
                result.add(resource.url());
            }
        }
        return result;
    }

    private static void rejectNonImage(List<ResolvedResource> resources) {
        if (resources.stream().anyMatch(resource -> !"IMAGE".equals(resource.mediaType())
                || !"REFERENCE".equals(resource.role()))) {
            throw new ServiceException("图片生成仅支持参考图片");
        }
    }

    private MediaTaskResponse submitNodeGeneration(GenerationRequests.Base request,
                                                   GenerationInvocationContext context,
                                                   String mediaType,
                                                   String requestHash,
                                                   Supplier<MediaTaskResponse> submitter) {
        if (request.getCanvasNode() == null) return submitter.get();
        return targetBindingService.submitNode(request, context.getUserId(), mediaType,
                requestHash, context.getCallId(), submitter);
    }

    private static GenerationInvocationContext canvasContext(GenerationRequests.Base request,
                                                             GenerationInvocationContext context,
                                                             String mediaType) {
        if (request.getCanvasNode() == null) return context;
        if (request.getWorkspaceId() == null) throw new ServiceException("画布节点生成必须指定工作区");
        String callId = "canvas:" + request.getWorkspaceId() + ":" + request.getClientRequestId();
        return GenerationInvocationContext.builder()
                .userId(context.getUserId())
                .systemPrompt(context.getSystemPrompt())
                .structuredOutputEnabled(context.getStructuredOutputEnabled())
                .businessFuncCode("TEXT".equals(mediaType) && IMAGE_DESCRIBE_FUNC.equals(request.getFuncCode())
                        ? IMAGE_DESCRIBE_FUNC : context.getBusinessFuncCode())
                .bizTaskId(context.getBizTaskId())
                .bizTaskType(StrUtil.blankToDefault(context.getBizTaskType(), "canvas_node"))
                .callId(callId)
                .callIdentity(StrUtil.blankToDefault(context.getCallIdentity(),
                        "canvas-" + mediaType.toLowerCase()))
                .billingExempt(context.getBillingExempt())
                .authorizedPreHoldCap(context.getAuthorizedPreHoldCap())
                .build();
    }

    private static GenerationInvocationContext quoteContext(GenerationRequests.Base request,
                                                            GenerationInvocationContext context,
                                                            String mediaType) {
        if (request.getWorkspaceId() == null) return context;
        String callId = "canvas-quote:" + request.getWorkspaceId() + ":" + request.getClientRequestId();
        return GenerationInvocationContext.builder()
                .userId(context.getUserId())
                .systemPrompt(context.getSystemPrompt())
                .structuredOutputEnabled(context.getStructuredOutputEnabled())
                .businessFuncCode("TEXT".equals(mediaType) && IMAGE_DESCRIBE_FUNC.equals(request.getFuncCode())
                        ? IMAGE_DESCRIBE_FUNC : context.getBusinessFuncCode())
                .bizTaskId(context.getBizTaskId())
                .bizTaskType(StrUtil.blankToDefault(context.getBizTaskType(), "canvas_quote"))
                .callId(callId)
                .callIdentity(StrUtil.blankToDefault(context.getCallIdentity(),
                        "canvas-" + mediaType.toLowerCase() + "-quote"))
                .billingExempt(context.getBillingExempt())
                .authorizedPreHoldCap(context.getAuthorizedPreHoldCap())
                .build();
    }

    private static void requireQuoteRequest(GenerationRequests.Base request) {
        if (request == null) throw new ServiceException("请求不能为空");
        if (request.getCanvasNode() != null) {
            throw new ServiceException("报价请求不能携带画布编辑租约");
        }
    }

    private static void emitTask(MediaTaskResponse task, GenerationStreamSink sink, GenerationRequests.Text request) {
        if ("SUCCEEDED".equals(task.getStatus())) {
            String full = task.getTextContent() == null ? "" : task.getTextContent();
            sink.onDone(request.getCanvasNode() == null ? full : CanvasPlainText.normalize(full, request.getResultFormat()));
        } else if ("FAILED".equals(task.getStatus()) || "CANCELLED".equals(task.getStatus())) {
            sink.onFailed(StrUtil.blankToDefault(task.getUserMessage(),
                    StrUtil.blankToDefault(task.getErrorMessage(), "生成失败")));
        } else {
            sink.onDetached(task.getTaskId());
        }
    }

    private static GenerationInvocationContext requireContext(GenerationInvocationContext context) {
        if (context == null || context.getUserId() == null || context.getUserId() <= 0) {
            throw new ServiceException("用户身份无效");
        }
        return context;
    }

    private static GenerationResponse response(MediaTaskResponse task, Long sessionId, Long messageId) {
        return GenerationResponse.builder().sessionId(JsonSafeId.value(sessionId))
                .messageId(JsonSafeId.value(messageId)).task(GenerationTaskView.from(task)).build();
    }

    private static GenerationResponse normalizeCanvasResponse(GenerationResponse response, GenerationRequests.Text request) {
        if (request.getCanvasNode() != null && response != null && response.getTask() != null
                && response.getTask().getTextContent() != null) {
            response.getTask().setTextContent(CanvasPlainText.normalize(
                    response.getTask().getTextContent(), request.getResultFormat()));
        }
        return response;
    }

    private GenerationResponse existing(SessionState session, GenerationRequests.Base request,
                                        String requestHash, Long userId) {
        GenerationConversationStore.ExistingTurn existing = conversationStore.findExisting(
                session, request.getClientRequestId(), requestHash);
        if (existing == null) return null;
        MediaTaskResponse task = mediaGenerationService.queryTaskLocal(existing.mediaTaskId());
        if (task == null) throw new ServiceException("关联任务不存在");
        if (request.getCanvasNode() != null) {
            task = targetBindingService.visibleNodeTask(request.getWorkspaceId(), existing.mediaTaskId(), userId);
        }
        return response(task, session.sessionId(), existing.assistantMessageId());
    }

    private void emitExisting(GenerationConversationStore.ExistingTurn existing, SessionState session,
                              GenerationStreamSink sink, GenerationRequests.Text request) {
        MediaTaskResponse task = mediaGenerationService.queryTaskLocal(existing.mediaTaskId());
        if (task == null) throw new ServiceException("关联任务不存在");
        sink.onPrepared(task.getTaskId(), session.sessionId(), existing.assistantMessageId());
        if ("SUCCEEDED".equals(task.getStatus())) {
            String full = task.getTextContent() == null ? "" : task.getTextContent();
            sink.onDone(request.getCanvasNode() == null ? full : CanvasPlainText.normalize(full, request.getResultFormat()));
        } else if ("FAILED".equals(task.getStatus()) || "CANCELLED".equals(task.getStatus())) {
            sink.onFailed(StrUtil.blankToDefault(task.getErrorMessage(), "生成失败"));
        } else {
            sink.onDetached(task.getTaskId());
        }
    }

    @SuppressWarnings("unchecked")
    private static String requestHash(String mediaType, GenerationRequests.Base request,
                                      GenerationInvocationContext context, SessionState session) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("mediaType", mediaType);
        Map<String, Object> requestFields = FINGERPRINT_MAPPER.convertValue(request, Map.class);
        requestFields.remove("session");
        requestFields.remove("workspaceId");
        requestFields.remove("projectId");
        requestFields.remove("episodeId");
        requestFields.remove("stream");
        Object canvasNode = requestFields.get("canvasNode");
        if (canvasNode instanceof Map<?, ?> nodeFields) {
            Map<String, Object> stableNode = new LinkedHashMap<>();
            nodeFields.forEach((key, value) -> stableNode.put(String.valueOf(key), value));
            stableNode.remove("editSessionId");
            stableNode.remove("lockToken");
            requestFields.put("canvasNode", stableNode);
        }
        canonical.put("request", requestFields);
        canonical.put("sessionId", session.sessionId());
        canonical.put("workspaceId", session.workspaceId());
        canonical.put("projectId", session.projectId());
        canonical.put("episodeId", session.episodeId());
        canonical.put("userId", context.getUserId());
        canonical.put("systemPrompt", context.getSystemPrompt());
        if (context.getStructuredOutputEnabled() != null) {
            canonical.put("structuredOutputEnabled", context.getStructuredOutputEnabled());
        }
        canonical.put("businessFuncCode", context.getBusinessFuncCode());
        canonical.put("bizTaskId", context.getBizTaskId());
        canonical.put("bizTaskType", context.getBizTaskType());
        canonical.put("callId", context.getCallId());
        canonical.put("callIdentity", context.getCallIdentity());
        canonical.put("billingExempt", context.getBillingExempt());
        try {
            return SecureUtil.sha256(FINGERPRINT_MAPPER.writeValueAsString(canonical));
        } catch (Exception error) {
            throw new ServiceException("请求摘要计算失败");
        }
    }

    private static StoredMessage storedPrompt(String prompt, List<ResolvedResource> resources) {
        List<StoredPart> parts = new ArrayList<>(resources.size());
        for (ResolvedResource resource : resources) {
            Map<String, Object> metadata = new LinkedHashMap<>();
            if (resource.fileSize() != null) metadata.put("sizeBytes", resource.fileSize());
            if (StrUtil.isNotBlank(resource.metadataJson())) {
                try { metadata.putAll(com.alibaba.fastjson2.JSON.parseObject(resource.metadataJson())); }
                catch (RuntimeException error) { throw new ServiceException("素材元数据无效"); }
            }
            parts.add(new StoredPart(resource.mediaType(), null, resource.resourceId(), resource.role(),
                    resource.url(), resource.mimeType(), metadata));
        }
        return new StoredMessage("user", prompt, null, parts);
    }

    private static String nodeObjectId(GenerationRequests.Base request) {
        return request.getCanvasNode() == null ? null : request.getCanvasNode().getObjectId();
    }

    private static String createKey(String mediaType, String clientRequestId) {
        return SecureUtil.sha256("generic-session|" + mediaType + "|" + clientRequestId);
    }

    private <T> T withSessionLock(GenerationRequests.Base request, GenerationInvocationContext context,
                                  String mediaType, Supplier<T> action) {
        if (request.getSession() == null) return action.get();
        String scope = request.getSession().getSessionId() == null
                ? "new:" + context.getUserId() + ":" + createKey(mediaType, request.getClientRequestId())
                : "id:" + request.getSession().getSessionId();
        RLock lock = redissonClient.getLock("generation:session:" + scope);
        if (!lock.tryLock()) throw new ServiceException("会话正在处理上一条消息");
        try {
            return action.get();
        } finally {
            if (lock.isHeldByCurrentThread()) lock.unlock();
        }
    }

    private static void validateConversationTurn(SessionState session, List<StoredMessage> messages) {
        if (!session.enabled()) return;
        int parts = messages.stream().mapToInt(message -> message.parts() == null ? 0 : message.parts().size()).sum();
        if (messages.size() > 20 || parts > 256) throw new ServiceException("会话单轮消息内容过多");
    }

    private void requireSessionIdle(SessionState session) {
        if (session == null || !session.enabled()) return;
        Long taskId = conversationStore.activeTaskId(session.sessionId());
        if (taskId == null) return;
        MediaTaskResponse task = mediaGenerationService.queryTaskLocal(taskId);
        if (task != null && ("SUCCEEDED".equals(task.getStatus()) || "FAILED".equals(task.getStatus())
                || "CANCELLED".equals(task.getStatus()))) {
            conversationStore.complete(task);
            if (conversationStore.activeTaskId(session.sessionId()) == null) return;
        }
        throw new ServiceException("会话正在处理上一条消息");
    }

    private void refreshConversationTask(SessionState session, MediaTaskResponse task) {
        if (session == null || !session.enabled() || task == null || task.getTaskId() == null) return;
        try {
            conversationStore.complete(mediaGenerationService.queryTaskLocal(task.getTaskId()));
        } catch (RuntimeException error) {
            log.error("通用会话任务状态复核失败, taskId={}", task.getTaskId(), error);
        }
    }

    private record TextInvocation(MediaTextGenerateRequest request,
                                  List<StoredMessage> currentMessages) { }

    private record VideoInvocation(MediaVideoGenerateRequest request,
                                   List<ResolvedResource> resources) { }
}
