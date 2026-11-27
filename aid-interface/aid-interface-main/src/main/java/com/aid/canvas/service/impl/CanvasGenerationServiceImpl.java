package com.aid.canvas.service.impl;

import com.aid.aid.domain.media.AidMediaTask;
import com.aid.aid.mapper.AidMediaTaskMapper;
import com.aid.canvas.domain.CanvasEntities.CanvasObject;
import com.aid.canvas.domain.CanvasEntities.CanvasResource;
import com.aid.canvas.domain.CanvasEntities.Operation;
import com.aid.canvas.domain.CanvasEntities.OperationObject;
import com.aid.canvas.domain.CanvasEntities.NodeResultSelection;
import com.aid.canvas.domain.CanvasEntities.TaskBinding;
import com.aid.canvas.domain.CanvasEntities.Workspace;
import com.aid.canvas.dto.CanvasRequests;
import com.aid.canvas.mapper.CanvasMapper;
import com.aid.canvas.service.CanvasAccessService;
import com.aid.canvas.service.CanvasCollaborationService;
import com.aid.canvas.service.CanvasGenerationService;
import com.aid.canvas.service.CanvasImageEditTaskGuard;
import com.aid.canvas.service.CanvasResourceService;
import com.aid.canvas.service.CanvasPlainText;
import com.aid.canvas.service.CanvasProjectService;
import com.aid.billing.dto.BillingCalcResult;
import com.aid.billing.service.BillingPreHoldCalculationService;
import com.aid.billing.service.BillingQuoteAssembler;
import com.aid.billing.vo.BillingQuoteVO;
import com.aid.runtime.domain.AidRuntimeRun;
import com.aid.runtime.domain.AidRuntimeRunStep;
import com.aid.runtime.mapper.AidRuntimeRunMapper;
import com.aid.runtime.mapper.AidRuntimeRunStepMapper;
import com.aid.common.aid.json.JsonSafeId;
import com.aid.common.error.TaskErrorResult;
import com.aid.common.error.TaskErrorSnapshot;
import com.aid.common.exception.ServiceException;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.generation.dto.GenerationRequests;
import com.aid.generation.service.GenerationTargetBindingService;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.media.dto.ReferenceAudioInput;
import com.aid.media.dto.MediaTaskResponse;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.media.dto.PreparedMediaBillingInput;
import com.aid.media.event.MediaTaskCompletedEvent;
import com.aid.media.event.MediaTaskOssPersistedEvent;
import com.aid.media.eta.MediaEtaService;
import com.aid.media.service.IMediaGenerationService;
import com.aid.media.service.MediaBillingQuotePreparer;
import com.alibaba.fastjson2.JSON;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.redisson.api.RLock;
import org.redisson.api.RedissonClient;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Date;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/** 画布生成适配层。统一媒体服务继续负责计费、排队与生成并发。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class CanvasGenerationServiceImpl implements CanvasGenerationService, GenerationTargetBindingService {
    @org.springframework.beans.factory.annotation.Autowired
    private org.springframework.beans.factory.ObjectProvider<com.aid.runtime.service.RuntimeToolRegistry> toolRegistries;
    private static final Set<String> TERMINAL = Set.of("SUCCEEDED", "FAILED", "CANCELLED");
    private static final Set<String> RESOURCE_MEDIA_TYPES = Set.of("IMAGE", "VIDEO", "AUDIO");
    private static final long SUBMIT_INTENT_TIMEOUT_MILLIS = TimeUnit.MINUTES.toMillis(2);
    private final com.aid.media.provider.audio.OfficialAudioAttachmentService audioAttachments;
    private final CanvasMapper canvasMapper;
    private final AidMediaTaskMapper mediaTaskMapper;
    private final IMediaGenerationService mediaGenerationService;
    private final MediaEtaService mediaEtaService;
    private final com.aid.media.service.MediaConcurrencyLimiter mediaConcurrencyLimiter;
    private final CanvasAccessService accessService;
    private final CanvasCollaborationService collaborationService;
    private final CanvasResourceService resourceService;
    private final CanvasProjectService projectService;
    private final AidRuntimeRunMapper runtimeRunMapper;
    private final AidRuntimeRunStepMapper runtimeRunStepMapper;
    private final PlatformTransactionManager transactionManager;
    private final RedissonClient redissonClient;
    private final MediaUrlResolver mediaUrlResolver;
    private final MediaBillingQuotePreparer mediaBillingQuotePreparer;
    private final BillingPreHoldCalculationService billingPreHoldCalculationService;
    private final BillingQuoteAssembler billingQuoteAssembler;
    private final com.aid.runtime.assistant.admission.RuntimeOperationSubmissionGuard assistantSubmissionGuard;


    @Override
    public Map<String, Object> prepareAudioAttachment(CanvasRequests.AudioAttachment input, Long userId) {
        var workspace = accessService.requireWorkspace(input.getWorkspaceId(), userId, "OWNER", "EDITOR");
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        var owned = resourceService.requireResources(workspace.getId(), List.of(input.getResourceId()), userId);
        String id = audioAttachments.prepare(input.getModelCode(), input.getCapabilityCode(), "canvas.audio.generate",
                input.getField(), mediaUrlResolver.toFullUrl(owned.get(0).getStorageUrl()), userId);
        return Map.of("referenceId", id, "resourceId", input.getResourceId().toString());
    }

    @Override
    public BillingQuoteVO quoteAudio(CanvasRequests.AudioQuote input, Long userId) {
        Workspace workspace = accessService.requireWorkspace(input.getWorkspaceId(), userId, "OWNER", "EDITOR");
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        var resources = resourceService.requireResources(workspace.getId(), input.getResourceIds(), userId);
        var request = audioRequest(input.getRequest(), workspace, userId, "canvas:audio:quote:" + workspace.getId(), resources);
        return audioPrice(request);
    }

    @Override
    public MediaTaskResponse generateAudio(CanvasRequests.GenerateAudio input, Long userId) {
        Workspace workspace = accessService.requireWorkspace(input.getWorkspaceId(), userId, "OWNER", "EDITOR");
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        NodeSubmission node = new NodeSubmission(input.getObjectId(), input.getExpectedVersion(), input.getSessionId(),
                input.getLockToken(), input.getOperationId(), null);
        return withSubmissionLock(workspace.getId(), node.operationId(), () -> {
            String callId = "canvas:" + workspace.getId() + ":" + input.getOperationId();
            String digest = requestHash(input, input.getRequest(), "AUDIO", userId);
            // 既有回执先恢复；模型停用或额度变化不能让重试创建第二项任务。
            var existing = canvasMapper.selectTaskBindingByOperation(workspace.getId(), node.operationId());
            if (existing != null) {
                CanvasObject originalIdentity = new CanvasObject();
                originalIdentity.setObjectId(node.objectId()); originalIdentity.setObjectVersion(node.expectedVersion());
                validateDuplicate(existing, originalIdentity, userId, "AUDIO", digest);
                if (existing.getTaskId() != null) return visibleTask(existing, userId);
                var recovered = recoverSubmittedTask(existing, callId, userId);
                if (recovered != null) return recovered;
            }
            var target = requireNode(workspace.getId(), node.objectId(), node.expectedVersion());
            if (!isAudioNode(JSON.parseObject(target.getContentJson()))) throw new ServiceException("请选择音频节点");
            var resources = resourceService.requireResources(workspace.getId(), input.getResourceIds(), userId);
            var request = audioRequest(input.getRequest(), workspace, userId, callId, resources);
            // 在节点占用、提交意图、冻结及上游生成之前拒绝契约、素材与价格错误。
            audioPrice(request);
            return submitPreparedGeneration(node, workspace, userId, "AUDIO", digest, callId,
                    () -> mediaGenerationService.generateAudio(request));
        });
    }

    private BillingQuoteVO audioPrice(com.aid.media.dto.MediaAudioGenerateRequest request) {
        PreparedMediaBillingInput prepared = mediaBillingQuotePreparer.prepareTrustedAudioBilling(request);
        BillingCalcResult price = billingPreHoldCalculationService.calculate(prepared.modelConfig(), prepared.billingInput());
        if (price == null || !price.isMatched()) throw new ServiceException(price == null ? "计费规则缺失" : price.getErrorMessage());
        return billingQuoteAssembler.single("MEDIA_AUDIO", prepared.modelConfig(), price, 1);
    }

    private com.aid.media.dto.MediaAudioGenerateRequest audioRequest(
            com.aid.media.dto.OfficialAudioGenerateRequest input, Workspace workspace, Long userId, String callId,
            List<CanvasResource> resources) {
        var request = input.toInternal(userId);
        request.setBusinessFuncCode("canvas.audio.generate");
        request.setProjectId(workspace.getProjectId());
        request.setEpisodeId(0L);
        request.setBizTaskType("canvas_node");
        request.setCallId(callId);
        request.setCallIdentity("canvas-audio");
        request.setOfficialIdempotencyKey(callId);
        Set<String> allowedUrls = resources.stream().map(CanvasResource::getStorageUrl)
                .map(mediaUrlResolver::toFullUrl).collect(java.util.stream.Collectors.toSet());
        validateAudioResourceUrls(request.getOptions(), "", allowedUrls);
        return request;
    }

    private void validateAudioResourceUrls(Object value, String key, Set<String> allowed) {
        if (value instanceof Map<?, ?> map) {
            for (var entry : map.entrySet()) validateAudioResourceUrls(entry.getValue(), String.valueOf(entry.getKey()), allowed);
        } else if (value instanceof List<?> list) {
            for (Object item : list) validateAudioResourceUrls(item, key, allowed);
        } else if (value instanceof String text && (key.endsWith("url") || Set.of("video", "videos", "file").contains(key))) {
            if (!allowed.contains(text)) throw new ServiceException("音频素材未授权");
        } else if (key.endsWith("_base64") || key.endsWith("_data")) {
            throw new ServiceException("请上传素材文件");
        }
    }

    @Override
    public MediaTaskResponse generateImage(CanvasRequests.GenerateImage request, Long userId) {
        return generate(request, request.getRequest(), null, userId, "IMAGE");
    }

    @Override
    public MediaTaskResponse generateVideo(CanvasRequests.GenerateVideo request, Long userId) {
        return generate(request, null, request.getRequest(), userId, "VIDEO");
    }

    @Override
    public BillingQuoteVO quoteVideoTool(CanvasRequests.VideoToolQuote input, Long userId) {
        Workspace workspace = accessService.requireWorkspace(input.getWorkspaceId(), userId, "OWNER", "EDITOR");
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        List<CanvasResource> resources = resourceService.requireResources(workspace.getId(), input.getResourceIds(), userId);
        MediaVideoGenerateRequest request = input.getRequest();
        prepareVideoToolCapability(input.getVideoTool(), request);
        sanitize(request, workspace, userId, "canvas:quote:" + workspace.getId(), resources);
        applyVideoTool(input.getVideoTool(), request, workspace.getId(), resources);
        PreparedMediaBillingInput prepared = mediaBillingQuotePreparer.prepareVideoBilling(request);
        BillingCalcResult price = billingPreHoldCalculationService.calculate(prepared.modelConfig(), prepared.billingInput());
        if (price == null || !price.isMatched()) {
            throw new ServiceException(price == null ? "计费规则缺失" : price.getErrorMessage());
        }
        return billingQuoteAssembler.single("MEDIA_VIDEO", prepared.modelConfig(), price, 1);
    }

    @Override
    public MediaTaskResponse submitNode(GenerationRequests.Base request, Long userId, String mediaType,
                                        String requestHash, String callId,
                                        Supplier<MediaTaskResponse> submitter) {
        NodeSubmission node = nodeSubmission(request);
        Workspace workspace = accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR");
        return withSubmissionLock(workspace.getId(), node.operationId(), () -> submitPreparedGeneration(
                node, workspace, userId, mediaType, requestHash, callId, submitter));
    }

    @Override
    public MediaTaskResponse streamNode(GenerationRequests.Base request, Long userId, String mediaType,
                                        String requestHash, String callId,
                                        GenerationTargetBindingService.StreamStarter streamStarter) {
        NodeSubmission node = nodeSubmission(request);
        Workspace workspace = accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR");
        RLock submitLock = acquireSubmissionLock(workspace.getId(), node.operationId());
        try {
            PreparedSubmission prepared = prepareSubmission(node, workspace, userId, mediaType, requestHash, callId);
            if (prepared.existingTask() != null) return prepared.existingTask();
            AtomicBoolean bound = new AtomicBoolean(false);
            try {
                streamStarter.start(task -> {
                    bindSubmittedResponse(prepared.binding(), task, userId);
                    bound.set(true);
                    unlockSubmissionLock(submitLock);
                });
                if (!bound.get()) {
                    throw new ServiceException("文本生成未返回有效任务编号");
                }
                return null;
            } catch (RuntimeException failure) {
                if (bound.get()) throw failure;
                MediaTaskResponse recovered = recoverSubmittedTask(prepared.binding(), callId, userId);
                if (recovered != null) return recovered;
                failTaskIntent(prepared.binding());
                throw failure;
            }
        } finally {
            unlockSubmissionLock(submitLock);
        }
    }

    private MediaTaskResponse generate(CanvasRequests.GenerationBase base, MediaImageGenerateRequest image,
                                       MediaVideoGenerateRequest video, Long userId, String mediaType) {
        Workspace workspace = accessService.requireWorkspace(base.getWorkspaceId(), userId, "OWNER", "EDITOR");
        NodeSubmission node = new NodeSubmission(base.getObjectId(), base.getExpectedVersion(), base.getSessionId(),
                base.getLockToken(), base.getOperationId(), null);
        return withSubmissionLock(workspace.getId(), node.operationId(), () -> {
            List<CanvasResource> resources = resourceService.requireResources(
                    workspace.getId(), base.getResourceIds(), userId);
            String callId = "canvas:" + workspace.getId() + ":" + base.getOperationId();
            String requestHash = requestHash(base, image == null ? video : image, mediaType, userId);
            if (image != null) sanitize(image, workspace, userId, callId, resources);
            else {
                if (base instanceof CanvasRequests.GenerateVideo videoRequest
                        && videoRequest.getVideoTool() != null) {
                    prepareVideoToolCapability(videoRequest.getVideoTool(), video);
                }
                sanitize(video, workspace, userId, callId, resources);
                if (base instanceof CanvasRequests.GenerateVideo videoRequest
                        && videoRequest.getVideoTool() != null) {
                    applyVideoTool(videoRequest.getVideoTool(), video, workspace.getId(), resources);
                }
            }
            return submitPreparedGeneration(node, workspace, userId, mediaType, requestHash, callId,
                    () -> image != null ? mediaGenerationService.submitImage(image)
                            : mediaGenerationService.submitVideo(video));
        });
    }

    @Override
    public void prepareAssistantImageReferences(Long workspaceId, Long userId, String callId,
            List<Long> resourceIds, MediaImageGenerateRequest request) {
        Workspace workspace = accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR");
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        sanitize(request, workspace, userId, callId, resourceService.requireResources(workspaceId, resourceIds, userId));
    }

    @Override
    public void prepareAssistantVideoReferences(Long workspaceId, Long userId, String callId,
            List<Long> resourceIds, MediaVideoGenerateRequest request) {
        Workspace workspace = accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR");
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        sanitize(request, workspace, userId, callId, resourceService.requireResources(workspaceId, resourceIds, userId));
    }

    @Override
    public void prepareAssistantVideoReferences(Long workspaceId, Long userId, String callId,
            List<Long> resourceIds, Map<Long, String> roles, MediaVideoGenerateRequest request) {
        if (roles == null || roles.isEmpty()) {
            prepareAssistantVideoReferences(workspaceId, userId, callId, resourceIds, request);
            return;
        }
        if (resourceIds == null || !new java.util.HashSet<>(resourceIds).containsAll(roles.keySet())
                || roles.values().stream().anyMatch(role -> role == null
                || !Set.of("REFERENCE", "FIRST_FRAME", "LAST_FRAME").contains(role)))
            throw new ServiceException("引用素材与角色不一致");
        Workspace workspace = accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR");
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        List<CanvasResource> resources = resourceService.requireResources(workspaceId, resourceIds, userId);
        if (resources.stream().anyMatch(resource -> resource.getMediaType() == null
                || !Set.of("IMAGE", "VIDEO", "AUDIO").contains(resource.getMediaType())))
            throw new ServiceException("视频生成只接受已登记的图片、视频和参考音频");
        sanitize(request, workspace, userId, callId, List.of());
        var resolved = resources.stream().map(resource -> new com.aid.generation.service.GenerationResourceResolver.ResolvedResource(
                resource.getId(), "canvas-resource-" + resource.getId(), roles.getOrDefault(resource.getId(), "REFERENCE"),
                resource.getMediaType(), mediaUrlResolver.toFullUrl(resource.getStorageUrl()), resource.getFileSize(),
                resource.getMimeType(), resource.getMetadataJson(), null)).toList();
        Map<String, Object> options = new java.util.LinkedHashMap<>(request.getOptions() == null ? Map.of() : request.getOptions());
        com.aid.generation.service.GenerationVideoReferences.apply(request, resolved, options, mediaUrlResolver);
    }

    @Override
    public MediaTaskResponse submitAssistantMedia(com.aid.canvas.runtime.RuntimeScopeAccess.Scope target,
            com.aid.runtime.assistant.admission.RuntimeOperationSubmissionClaim claim,
            String mediaType, String requestHash, Supplier<MediaTaskResponse> submitter) {
        if (target == null || claim == null || submitter == null
                || !Objects.equals(target.runId(), claim.getRunId())
                || !Objects.equals(target.userId(), claim.getUserId())
                || !Set.of("IMAGE", "VIDEO", "AUDIO").contains(mediaType)
                || requestHash == null || !requestHash.matches("[a-f0-9]{64}")) {
            throw new ServiceException("CANVAS_ASSISTANT_MEDIA_IDENTITY_INVALID");
        }
        String operationId = assistantMediaOperationId(claim.getRunId(), claim.getIdempotencyKey());
        String callId = claim.getIdempotencyKey();
        Workspace workspace = accessService.requireWorkspace(target.workspaceId(), target.userId(), "OWNER", "EDITOR");
        if (!Objects.equals(workspace.getProjectId(), target.projectId())) {
            throw new ServiceException("CANVAS_ASSISTANT_MEDIA_PROJECT_CHANGED");
        }
        return withSubmissionLock(workspace.getId(), operationId, () -> {
            // Runtime graph is locked before touching Canvas rows, matching every writing Tool.
            TaskBinding intent = tx().execute(status -> {
                var decision = assistantSubmissionGuard.assertBeforeTaskBinding(claim);
                accessService.requireFeature(target.userId(), target.projectId(), "canvas.generate");
                CanvasObject node = requireNode(target.workspaceId(), target.objectId(), target.objectVersion());
                var existing = canvasMapper.selectTaskBindingByOperation(target.workspaceId(), operationId);
                if (existing != null) {
                    validateDuplicate(existing, node, target.userId(), mediaType, requestHash);
                    if (!Objects.equals(existing.getCallId(), callId)) {
                        throw new ServiceException("CANVAS_ASSISTANT_MEDIA_CALL_CHANGED");
                    }
                    return existing;
                }
                if (decision != com.aid.runtime.assistant.admission.RuntimeOperationSubmissionDecision.PROCEED_NEW_CLAIM) {
                    throw new ServiceException("CANVAS_ASSISTANT_MEDIA_RECEIPT_PENDING");
                }
                // Match Canvas mutation lock order: Runtime graph, project quota, then node/fence.
                canvasMapper.lockProjectMemberQuota(target.projectId());
                long fence = collaborationService.requireAssistantRuntimeFence(target.workspaceId(), target.objectId(),
                        target.objectVersion(), target.userId(), target.runId(), target.runtimeFencingToken());
                if (!Objects.equals(fence, target.nodeFence())) {
                    throw new ServiceException("CANVAS_ASSISTANT_MEDIA_FENCE_CHANGED");
                }
                return createIntent(workspace, node, operationId, requestHash, callId, target.userId(), mediaType, null, fence);
            });
            if (intent == null) throw new ServiceException("CANVAS_ASSISTANT_MEDIA_INTENT_MISSING");
            if (intent.getTaskId() != null) return visibleTask(intent, target.userId());
            MediaTaskResponse recovered = recoverSubmittedTask(intent, callId, target.userId());
            if (recovered != null) return recovered;
            if (TERMINAL.contains(intent.getStatus())) {
                throw new ServiceException("CANVAS_ASSISTANT_MEDIA_INTENT_TERMINAL");
            }
            try {
                collaborationService.beginAssistantTaskLock(target.workspaceId(), target.objectId(),
                        target.objectVersion(), target.userId(), target.runId(), target.runtimeFencingToken(),
                        target.nodeFence(), operationId, callId);
                // No SQL transaction is open while the unified media service submits/adopts its task.
                return bindSubmittedResponse(intent, submitter.get(), target.userId());
            } catch (RuntimeException failure) {
                recovered = recoverSubmittedTask(intent, callId, target.userId());
                if (recovered != null) return recovered;
                failTaskIntent(intent);
                throw failure;
            }
        });
    }

    public static String assistantMediaOperationId(Long runId, String callId) {
        if (runId == null || runId < 1 || callId == null || callId.isBlank() || callId.length() > 100) {
            throw new ServiceException("CANVAS_ASSISTANT_MEDIA_IDENTITY_INVALID");
        }
        return "asst_media_" + runId + "_" + sha256(callId).substring(0, 32);
    }

    private MediaTaskResponse submitPreparedGeneration(NodeSubmission node, Workspace workspace, Long userId,
                                                       String mediaType, String requestHash, String callId,
                                                       Supplier<MediaTaskResponse> submitter) {
        PreparedSubmission prepared = prepareSubmission(node, workspace, userId, mediaType, requestHash, callId);
        if (prepared.existingTask() != null) return prepared.existingTask();
        try {
            return bindSubmittedResponse(prepared.binding(), submitter.get(), userId);
        } catch (RuntimeException failure) {
            MediaTaskResponse recovered = recoverSubmittedTask(prepared.binding(), callId, userId);
            if (recovered != null) return recovered;
            failTaskIntent(prepared.binding());
            throw failure;
        }
    }

    private PreparedSubmission prepareSubmission(NodeSubmission node, Workspace workspace, Long userId,
                                                 String mediaType, String requestHash, String callId) {
        accessService.requireFeature(userId, workspace.getProjectId(), "canvas.generate");
        CanvasObject object = requireNode(workspace.getId(), node.objectId(), node.expectedVersion());
        TaskBinding intent = canvasMapper.selectTaskBindingByOperation(workspace.getId(), node.operationId());
        if (intent != null) {
            validateDuplicate(intent, object, userId, mediaType, requestHash);
            if (intent.getTaskId() != null) return new PreparedSubmission(intent, visibleTask(intent, userId));
            if (TERMINAL.contains(intent.getStatus())) {
                throw new ServiceException("该生成请求未创建媒体任务，请使用新的 clientRequestId 重试");
            }
            MediaTaskResponse recovered = recoverSubmittedTask(intent, callId, userId);
            if (recovered != null) return new PreparedSubmission(intent, recovered);
            return new PreparedSubmission(intent, null);
        }

        long editFence = collaborationService.requireEditFence(workspace.getId(), object.getObjectId(),
                node.sessionId(), node.lockToken(), userId);
        collaborationService.beginTaskLock(workspace.getId(), object.getObjectId(), node.sessionId(), node.lockToken(),
                userId, node.operationId());
        try {
            intent = createIntent(workspace, object, node.operationId(), requestHash, callId, userId,
                    mediaType, node.resultFormat(), editFence);
        } catch (RuntimeException failure) {
            collaborationService.releasePendingTaskLock(workspace.getId(), object.getObjectId(), userId, node.operationId());
            throw failure;
        }
        validateDuplicate(intent, object, userId, mediaType, requestHash);
        if (intent.getTaskId() != null) return new PreparedSubmission(intent, visibleTask(intent, userId));
        return new PreparedSubmission(intent, null);
    }

    private MediaTaskResponse bindSubmittedResponse(TaskBinding intent, MediaTaskResponse response, Long userId) {
        if (response == null || response.getTaskId() == null) {
            throw new ServiceException("媒体任务未返回有效任务编号");
        }
        TaskBinding bound = bindResponse(intent, response);
        collaborationService.bindTaskLock(bound.getWorkspaceId(), bound.getObjectId(), userId,
                bound.getOperationId(), bound.getTaskId());
        settleTask(response.getTaskId());
        return withCanvasIdentity(response, bound);
    }

    private MediaTaskResponse recoverSubmittedTask(TaskBinding intent, String callId, Long userId) {
        AidMediaTask recovered = findTask(callId);
        return recovered == null ? null : bindSubmittedTask(intent, recovered, userId);
    }

    private <T> T withSubmissionLock(Long workspaceId, String operationId, Supplier<T> action) {
        RLock submitLock = acquireSubmissionLock(workspaceId, operationId);
        try {
            return action.get();
        } finally {
            unlockSubmissionLock(submitLock);
        }
    }

    private RLock acquireSubmissionLock(Long workspaceId, String operationId) {
        RLock submitLock = redissonClient.getLock(submitLockName(workspaceId, operationId));
        boolean locked;
        try {
            locked = submitLock.tryLock(10, TimeUnit.SECONDS);
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new ServiceException("生成请求等待被中断");
        }
        if (!locked) throw new ServiceException("相同生成请求正在提交，请稍后重试");
        return submitLock;
    }

    private static void unlockSubmissionLock(RLock submitLock) {
        if (submitLock != null && submitLock.isHeldByCurrentThread()) submitLock.unlock();
    }

    private static NodeSubmission nodeSubmission(GenerationRequests.Base request) {
        GenerationRequests.CanvasNode node = request.getCanvasNode();
        if (node == null || request.getWorkspaceId() == null) {
            throw new ServiceException("画布节点生成缺少工作区或节点上下文");
        }
        return new NodeSubmission(node.getObjectId(), node.getExpectedVersion(), node.getEditSessionId(),
                node.getLockToken(), request.getClientRequestId(),
                request instanceof GenerationRequests.Text text ? text.getResultFormat() : null);
    }

    private record NodeSubmission(String objectId, Long expectedVersion, String sessionId,
                                  String lockToken, String operationId, String resultFormat) { }

    private record PreparedSubmission(TaskBinding binding, MediaTaskResponse existingTask) { }

    private TaskBinding createIntent(Workspace workspace, CanvasObject object, String operationId, String requestHash,
                                     String callId, Long userId, String mediaType, String resultFormat, long editFence) {
        return tx().execute(status -> {
            canvasMapper.lockProjectMemberQuota(workspace.getProjectId());
            if (canvasMapper.selectCanvasProject(workspace.getProjectId()) == null) throw new ServiceException("项目已失效");
            Long issuedFence = canvasMapper.selectObjectFenceForUpdate(workspace.getId(), object.getObjectId());
            if (!Objects.equals(issuedFence, editFence)) throw new ServiceException("节点占用已变化，请重新提交");
            TaskBinding duplicate = canvasMapper.selectTaskBindingByOperation(workspace.getId(), operationId);
            if (duplicate != null) return duplicate;
            CanvasObject current = canvasMapper.selectCanvasObjectForUpdate(workspace.getId(), object.getObjectId());
            if (current == null || current.getDeleted() == 1 || !"NODE".equals(current.getObjectType())) {
                throw new ServiceException("生成目标节点不存在");
            }
            if (!Objects.equals(current.getObjectVersion(), object.getObjectVersion())) {
                throw new ServiceException("节点内容已变化，请确认最新输入后重试");
            }
            TaskBinding binding = new TaskBinding();
            binding.setProjectId(workspace.getProjectId());
            binding.setWorkspaceId(workspace.getId());
            binding.setObjectId(current.getObjectId());
            binding.setInputObjectVersion(current.getObjectVersion());
            binding.setActorUserId(userId);
            binding.setMediaType(mediaType);
            binding.setResultFormat(resultFormat);
            binding.setOperationId(operationId);
            binding.setRequestHash(requestHash);
            binding.setStatus("SUBMITTING");
            binding.setCallId(callId);
            canvasMapper.insertTaskBinding(binding);
            return binding;
        });
    }

    private TaskBinding bindResponse(TaskBinding intent, MediaTaskResponse response) {
        return tx().execute(status -> {
            String storedStatus = TERMINAL.contains(response.getStatus()) ? "PROCESSING" : normalizeActiveStatus(response.getStatus());
            if (canvasMapper.bindMediaTask(intent.getId(), response.getTaskId(), storedStatus) != 1) {
                TaskBinding current = canvasMapper.selectTaskBindingByOperation(intent.getWorkspaceId(), intent.getOperationId());
                if (current == null || !Objects.equals(current.getTaskId(), response.getTaskId())) {
                    throw new ServiceException("生成任务绑定状态已变化");
                }
                return current;
            }
            TaskBinding bound = canvasMapper.selectTaskBinding(response.getTaskId());
            persistTaskEventTx(bound, response, "TASK_ACCEPTED");
            return bound;
        });
    }

    private MediaTaskResponse bindSubmittedTask(TaskBinding intent, AidMediaTask task, Long userId) {
        if (!Objects.equals(intent.getActorUserId(), task.getUserId()) || !Objects.equals(intent.getProjectId(), task.getProjectId())) {
            throw new ServiceException("恢复的媒体任务归属不匹配");
        }
        MediaTaskResponse response = mediaGenerationService.queryTaskLocal(task.getId());
        TaskBinding bound = bindResponse(intent, response);
        collaborationService.bindTaskLock(bound.getWorkspaceId(), bound.getObjectId(), userId,
                bound.getOperationId(), bound.getTaskId());
        settleTask(task.getId());
        return withCanvasIdentity(response, bound);
    }

    @Override
    public MediaTaskResponse taskDetail(Long workspaceId, Long taskId, Long userId) {
        accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR", "VIEWER");
        TaskBinding binding = canvasMapper.selectTaskBinding(taskId);
        if (binding == null || !Objects.equals(binding.getWorkspaceId(), workspaceId)) throw new ServiceException("任务不属于当前工作区");
        settleTask(taskId);
        return visibleTask(binding, userId);
    }

    @Override
    public MediaTaskResponse visibleNodeTask(Long workspaceId, Long taskId, Long userId) {
        return taskDetail(workspaceId, taskId, userId);
    }

    @Override
    public Map<String, Object> activeTasks(Long workspaceId, Long userId) {
        accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR", "VIEWER");
        List<TaskBinding> bindings = canvasMapper.selectWorkspaceActiveTaskBindings(workspaceId);
        List<Long> taskIds = bindings.stream().map(TaskBinding::getTaskId).filter(Objects::nonNull).distinct().toList();
        Map<Long, AidMediaTask> tasks = loadTaskStates(taskIds, false);
        if (!taskIds.isEmpty()) {
            boolean settled = false;
            for (AidMediaTask task : tasks.values()) {
                if (!TERMINAL.contains(task.getStatus())) continue;
                if (CanvasImageEditTaskGuard.isProtectionPending(task) || isMediaResultPending(task)) {
                    settleTask(task.getId());
                    continue;
                }
                settleTask(task.getId());
                settled = true;
            }
            if (settled) {
                bindings = canvasMapper.selectWorkspaceActiveTaskBindings(workspaceId);
                taskIds = bindings.stream().map(TaskBinding::getTaskId).filter(Objects::nonNull).distinct().toList();
                tasks = loadTaskStates(taskIds, false);
            }
        }

        Map<String, Map<String, Object>> latestByObject = new LinkedHashMap<>();
        List<AidRuntimeRun> activeRuns = runtimeRunMapper.selectList(new LambdaQueryWrapper<AidRuntimeRun>()
                .eq(AidRuntimeRun::getWorkspaceId, workspaceId)
                .eq(AidRuntimeRun::getDelFlag, "0")
                .in(AidRuntimeRun::getStatus, "CREATED", "RUNNING", "WAITING_INPUT")
                .isNotNull(AidRuntimeRun::getNodeObjectId)
                .orderByDesc(AidRuntimeRun::getCreateTime, AidRuntimeRun::getId));
        for (AidRuntimeRun run : activeRuns) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("objectId", run.getNodeObjectId());
            item.put("runId", JsonSafeId.value(run.getId()));
            item.put("taskId", JsonSafeId.value(run.getMediaTaskId()));
            item.put("sourceType", "RUNTIME_RUN");
            item.put("memberType", run.getMemberType());
            item.put("actorUserId", JsonSafeId.value(run.getUserId()));
            item.put("mediaType", run.getOutputKind());
            item.put("status", run.getStatus());
            item.put("inputObjectVersion", run.getNodeVersion());
            item.put("canCancel", Objects.equals(run.getUserId(), userId));
            item.put("createTime", run.getCreateTime());
            item.put("updateTime", run.getUpdateTime());
            latestByObject.put(run.getNodeObjectId(), item);
        }
        for (TaskBinding binding : bindings) {
            if (latestByObject.containsKey(binding.getObjectId())) continue;
            AidMediaTask task = binding.getTaskId() == null ? null : tasks.get(binding.getTaskId());
            boolean protectionPending = CanvasImageEditTaskGuard.isProtectionPending(task)
                    || isMediaResultPending(task);
            String status = task == null ? binding.getStatus()
                    : protectionPending ? "PROCESSING" : publicStatus(task.getStatus());
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("objectId", binding.getObjectId());
            item.put("taskId", JsonSafeId.value(binding.getTaskId()));
            item.put("operationId", binding.getOperationId());
            item.put("actorUserId", JsonSafeId.value(binding.getActorUserId()));
            item.put("mediaType", binding.getMediaType());
            item.put("status", status);
            Integer queuePosition = mediaConcurrencyLimiter.getModelQueuePosition(task);
            item.put("queuePosition", queuePosition);
            item.put("eta", task == null || protectionPending ? null : mediaEtaService.estimateMediaTask(task, queuePosition));
            item.put("executionPhase", executionPhase(task, protectionPending));
            item.put("queueWaitReason", mediaConcurrencyLimiter.getCapacityWaitReason(task));
            item.put("inputObjectVersion", binding.getInputObjectVersion());
            item.put("canCancel", !protectionPending && task != null
                    && "QUEUED".equals(task.getStatus())
                    && (task.getProviderTaskId() == null || task.getProviderTaskId().isBlank())
                    && task.getUpstreamAcceptTime() == null
                    && ("IMAGE".equals(task.getMediaType()) || "VIDEO".equals(task.getMediaType()))
                    && Objects.equals(binding.getActorUserId(), userId));
            item.put("createTime", binding.getCreateTime());
            item.put("updateTime", binding.getUpdateTime());
            latestByObject.put(binding.getObjectId(), item);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("workspaceId", JsonSafeId.value(workspaceId));
        result.put("items", new ArrayList<>(latestByObject.values()));
        result.put("total", latestByObject.size());
        return result;
    }

    @Override
    public Map<String, Object> taskHistory(CanvasRequests.TaskHistory request, Long userId) {
        accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR", "VIEWER");
        CanvasObject node = canvasMapper.selectCanvasObject(request.getWorkspaceId(), request.getObjectId());
        if (node == null || node.getDeleted() == 1 || !"NODE".equals(node.getObjectType())) throw new ServiceException("节点不存在");
        int pageNum = request.getPageNum() == null ? 1 : request.getPageNum();
        int pageSize = request.getPageSize() == null ? 20 : request.getPageSize();
        List<TaskBinding> bindings = canvasMapper.selectObjectTaskBindings(request.getWorkspaceId(), request.getObjectId(),
                (pageNum - 1) * pageSize, pageSize);
        List<Long> taskIds = bindings.stream().map(TaskBinding::getTaskId).filter(Objects::nonNull).distinct().toList();
        Map<Long, AidMediaTask> tasksById = loadTaskStates(taskIds, true);
        List<Map<String, Object>> mediaResults = taskIds.isEmpty() ? List.of() : canvasMapper.selectMediaResultsByTaskIds(taskIds);
        Map<Long, List<Map<String, Object>>> resultsByTask = new LinkedHashMap<>();
        for (Map<String, Object> result : mediaResults) {
            Long taskId = asLong(result.get("taskId"));
            resultsByTask.computeIfAbsent(taskId, ignored -> new ArrayList<>()).add(result);
        }
        NodeResultSelection selection = canvasMapper.selectNodeResultSelection(request.getWorkspaceId(), request.getObjectId());
        List<Map<String, Object>> items = new ArrayList<>();
        for (TaskBinding binding : bindings) {
            AidMediaTask task = binding.getTaskId() == null ? null : tasksById.get(binding.getTaskId());
            boolean protectionPending = CanvasImageEditTaskGuard.isProtectionPending(task);
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("taskId", JsonSafeId.value(binding.getTaskId()));
            item.put("operationId", binding.getOperationId());
            item.put("actorUserId", JsonSafeId.value(binding.getActorUserId()));
            item.put("mediaType", binding.getMediaType());
            item.put("inputObjectVersion", binding.getInputObjectVersion());
            item.put("status", task == null ? binding.getStatus()
                    : protectionPending ? "PROCESSING" : publicStatus(task.getStatus()));
            item.put("createTime", binding.getCreateTime());
            item.put("updateTime", binding.getUpdateTime());
            TaskErrorResult failure = protectionPending ? null : taskError(task);
            item.put("errorCode", failure == null ? null : failure.getErrorCode());
            item.put("errorType", failure == null ? null : failure.getErrorType());
            item.put("errorSource", failure == null ? null : failure.getErrorSource());
            item.put("userMessage", failure == null ? null : failure.getUserMessage());
            item.put("retryable", failure != null && failure.isRetryable());
            boolean actor = Objects.equals(binding.getActorUserId(), userId);
            item.put("needRecharge", actor && failure != null && failure.isNeedRecharge());
            item.put("rechargeOwner", actor && failure != null ? failure.getRechargeOwner() : null);
            List<Map<String, Object>> taskResults = new ArrayList<>();
            for (Map<String, Object> stored : resultsByTask.getOrDefault(binding.getTaskId(), List.of())) {
                taskResults.add(resultView(stored, selection));
            }
            if (taskResults.isEmpty() && task != null && ("TEXT".equals(binding.getMediaType()) || isAudioTextResult(task))
                    && task.getResultText() != null) {
                Map<String, Object> textResult = new LinkedHashMap<>();
                textResult.put("resultId", null);
                textResult.put("taskId", JsonSafeId.value(binding.getTaskId()));
                textResult.put("mediaType", "TEXT");
                textResult.put("textContent", CanvasPlainText.normalize(task.getResultText(), binding.getResultFormat()));
                textResult.put("selected", false);
                textResult.put("persisting", false);
                taskResults.add(textResult);
            }
            if (taskResults.isEmpty() && !protectionPending && binding.getResultUrl() != null) {
                Map<String, Object> fallback = new LinkedHashMap<>();
                fallback.put("resultId", null);
                fallback.put("taskId", JsonSafeId.value(binding.getTaskId()));
                fallback.put("mediaType", binding.getMediaType());
                fallback.put("resultUrl", binding.getResultUrl());
                fallback.put("selected", false);
                fallback.put("persisting", true);
                taskResults.add(fallback);
            }
            item.put("results", taskResults);
            items.add(item);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("items", items);
        result.put("total", canvasMapper.countObjectTaskBindings(request.getWorkspaceId(), request.getObjectId()));
        LambdaQueryWrapper<AidRuntimeRun> runFilter = new LambdaQueryWrapper<AidRuntimeRun>()
                .eq(AidRuntimeRun::getWorkspaceId, request.getWorkspaceId())
                .eq(AidRuntimeRun::getNodeObjectId, request.getObjectId())
                .eq(AidRuntimeRun::getDelFlag, "0");
        Long runtimeTotal = runtimeRunMapper.selectCount(runFilter);
        List<AidRuntimeRun> runs = runtimeRunMapper.selectList(new LambdaQueryWrapper<AidRuntimeRun>()
                .eq(AidRuntimeRun::getWorkspaceId, request.getWorkspaceId())
                .eq(AidRuntimeRun::getNodeObjectId, request.getObjectId())
                .eq(AidRuntimeRun::getDelFlag, "0")
                .orderByDesc(AidRuntimeRun::getCreateTime, AidRuntimeRun::getId)
                .last("LIMIT " + ((pageNum - 1) * pageSize) + "," + pageSize));
        Map<Long, List<AidRuntimeRunStep>> stepsByRun = new LinkedHashMap<>();
        if (!runs.isEmpty()) {
            List<Long> runIds = runs.stream().map(AidRuntimeRun::getId).toList();
            for (AidRuntimeRunStep step : runtimeRunStepMapper.selectList(new LambdaQueryWrapper<AidRuntimeRunStep>()
                    .in(AidRuntimeRunStep::getRunId, runIds)
                    .eq(AidRuntimeRunStep::getDelFlag, "0")
                    .orderByAsc(AidRuntimeRunStep::getRunId, AidRuntimeRunStep::getStepIndex))) {
                stepsByRun.computeIfAbsent(step.getRunId(), ignored -> new ArrayList<>()).add(step);
            }
        }
        List<Map<String, Object>> runtimeItems = new ArrayList<>();
        for (AidRuntimeRun run : runs) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("sourceType", "RUNTIME_RUN");
            item.put("runId", JsonSafeId.value(run.getId()));
            item.put("memberType", run.getMemberType());
            item.put("actorUserId", JsonSafeId.value(run.getUserId()));
            item.put("mediaType", run.getOutputKind());
            item.put("inputObjectVersion", run.getNodeVersion());
            item.put("status", run.getStatus());
            item.put("taskId", JsonSafeId.value(run.getMediaTaskId()));
            item.put("createTime", run.getCreateTime());
            item.put("updateTime", run.getUpdateTime());
            List<Map<String, Object>> runSteps = new ArrayList<>();
            for (AidRuntimeRunStep step : stepsByRun.getOrDefault(run.getId(), List.of())) {
                Map<String, Object> stepView = new LinkedHashMap<>();
                stepView.put("stepIndex", step.getStepIndex());
                stepView.put("stepKind", step.getStepKind());
                stepView.put("status", step.getStatus());
                stepView.put("taskId", JsonSafeId.value(step.getMediaTaskId()));
                runSteps.add(stepView);
            }
            item.put("steps", runSteps);
            if ("SUCCEEDED".equals(run.getStatus()) && run.getResultJson() != null) {
                try {
                    com.alibaba.fastjson2.JSONObject preview = JSON.parseObject(run.getResultJson());
                    if ("TEXT".equals(run.getOutputKind()) && preview.get("textContent") instanceof String body) {
                        item.put("resultPreview", Map.of("textContent", CanvasPlainText.normalize(body,
                                preview.getString("textFormat"))));
                    }
                } catch (RuntimeException invalidStoredResult) {
                    log.warn("画布运行结果快照无法读取: runId={}", run.getId());
                }
            }
            runtimeItems.add(item);
        }
        result.put("runtimeRuns", runtimeItems);
        result.put("runtimeTotal", runtimeTotal);
        result.put("currentResult", selection == null ? null : selectionView(selection));
        return result;
    }

    @Override
    public Map<String, Object> selectResult(CanvasRequests.SelectResult request, Long userId) {
        return tx().execute(status -> {
            Workspace accessible = accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR");
            Workspace workspace = canvasMapper.selectWorkspaceForUpdate(accessible.getId());
            if (workspace == null) throw new ServiceException("工作区不存在或已失效");
            String requestHash = sha256(JSON.toJSONString(Map.of("objectId", request.getObjectId(),
                    "expectedVersion", request.getExpectedVersion(), "resultId", request.getResultId())));
            Operation duplicate = canvasMapper.selectOperation(workspace.getId(), request.getOperationId());
            if (duplicate != null) {
                if (!requestHash.equals(duplicate.getPayloadHash()) || !"RESULT_SELECTED".equals(duplicate.getOperationType())) {
                    throw new ServiceException("operationId 已被不同内容使用");
                }
                return JSON.parseObject(duplicate.getPayloadJson(), LinkedHashMap.class);
            }
            collaborationService.requireEditFence(workspace.getId(), request.getObjectId(), request.getSessionId(),
                    request.getLockToken(), userId);
            CanvasObject node = requireNode(workspace.getId(), request.getObjectId(), request.getExpectedVersion());
            Map<String, Object> mediaResult = canvasMapper.selectMediaResultForNode(workspace.getId(), node.getObjectId(), request.getResultId());
            if (mediaResult == null) throw new ServiceException("结果不存在或尚未完成持久化");
            if (isAudioNode(JSON.parseObject(node.getContentJson()))
                    && !"AUDIO".equalsIgnoreCase(Objects.toString(mediaResult.get("mediaType"), ""))) throw new ServiceException("请选择音频结果");
            Long inputVersion = asLong(mediaResult.get("inputObjectVersion"));
            Long taskId = asLong(mediaResult.get("taskId"));
            NodeResultSelection selection = canvasMapper.selectNodeResultSelection(workspace.getId(), node.getObjectId());
            if (selection == null) {
                selection = new NodeResultSelection();
                selection.setProjectId(workspace.getProjectId());
                selection.setWorkspaceId(workspace.getId());
                selection.setObjectId(node.getObjectId());
                selection.setTaskId(taskId);
                selection.setResultId(request.getResultId());
                selection.setInputObjectVersion(inputVersion);
                selection.setSelectionVersion(1L);
                selection.setLastActorUserId(userId);
                if (canvasMapper.insertNodeResultSelection(selection) != 1) throw new ServiceException("当前结果保存失败");
            } else {
                if (canvasMapper.updateNodeResultSelection(workspace.getId(), node.getObjectId(), taskId,
                        request.getResultId(), inputVersion, userId) != 1) throw new ServiceException("当前结果保存失败");
                selection = canvasMapper.selectNodeResultSelection(workspace.getId(), node.getObjectId());
            }
            return persistResultSelectionEvent(workspace, selection, request.getOperationId(), requestHash,
                    "RESULT_SELECTED", userId);
        });
    }

    @Override
    public Map<String, Object> adoptTextResult(CanvasRequests.AdoptTextResult request, Long userId) {
        Workspace authorized = accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR");
        AidRuntimeRun run = runtimeRunMapper.selectById(request.getRunId());
        if (run == null || !"0".equals(run.getDelFlag()) || !Objects.equals(run.getUserId(), userId)
                || !Objects.equals(run.getWorkspaceId(), request.getWorkspaceId())
                || !Objects.equals(run.getProjectId(), authorized.getProjectId())
                || !Set.of("AGENT", "SKILL").contains(run.getMemberType())
                || !"TEXT".equals(run.getOutputKind()) || !"SUCCEEDED".equals(run.getStatus())
                || run.getNodeObjectId() == null || run.getNodeVersion() == null) {
            throw new ServiceException("运行结果不存在、未完成或无权采纳");
        }
        if (run.getMediaTaskId() != null) {
            AidMediaTask source = mediaTaskMapper.selectById(run.getMediaTaskId());
            Long linkedSteps = runtimeRunStepMapper.selectCount(new LambdaQueryWrapper<AidRuntimeRunStep>()
                    .eq(AidRuntimeRunStep::getRunId, run.getId())
                    .eq(AidRuntimeRunStep::getMediaTaskId, run.getMediaTaskId())
                    .eq(AidRuntimeRunStep::getDelFlag, "0"));
            if (source == null || !Objects.equals(source.getUserId(), userId)
                    || !Objects.equals(source.getProjectId(), run.getProjectId())
                    || !"RUNTIME_RUN".equals(source.getBizTaskType())
                    || !Objects.equals(source.getBizTaskId(), run.getId())
                    || !"SUCCEEDED".equals(source.getStatus()) || linkedSteps == 0) {
                throw new ServiceException("运行结果来源不匹配");
            }
        }
        boolean create = "CREATE_NODE".equals(request.getMode());
        if (create ? request.getExpectedVersion() != 0 || request.getObjectId().equals(run.getNodeObjectId())
                : !request.getObjectId().equals(run.getNodeObjectId())
                    || !Objects.equals(request.getExpectedVersion(), run.getNodeVersion())) {
            throw new ServiceException("采纳目标与运行节点版本不匹配");
        }
        String requestHash = sha256(JSON.toJSONString(List.of(run.getId(), request.getMode(),
                request.getObjectId(), request.getExpectedVersion(), Objects.toString(request.getTitle(), ""))));
        Operation previous = canvasMapper.selectOperation(request.getWorkspaceId(), request.getOperationId());
        if (previous != null) {
            Map<String, Object> previousResult = JSON.parseObject(previous.getPayloadJson(), LinkedHashMap.class);
            Object previousHash = null;
            Object objects = previousResult.get("objects");
            if (objects instanceof List<?> list && !list.isEmpty() && list.get(0) instanceof Map<?, ?> item
                    && item.get("content") instanceof Map<?, ?> content
                    && content.get("adoption") instanceof Map<?, ?> adoption) {
                previousHash = adoption.get("requestHash");
            }
            if (!"MUTATE".equals(previous.getOperationType()) || !requestHash.equals(previousHash)
                    || !Objects.equals(previous.getActorUserId(), userId)) {
                throw new ServiceException("operationId 已被不同内容使用");
            }
            return previousResult;
        }
        if (run.getResultJson() == null) throw new ServiceException("运行结果正文缺失");
        com.alibaba.fastjson2.JSONObject output = JSON.parseObject(run.getResultJson());
        Object raw = output.get("textContent");
        if (!(raw instanceof String body)) throw new ServiceException("运行结果正文缺失");
        String plain = CanvasPlainText.normalize(body, output.getString("textFormat"));
        CanvasObject target = canvasMapper.selectCanvasObject(request.getWorkspaceId(), request.getObjectId());
        if (!create) {
            if (target == null || target.getDeleted() == 1 || !"NODE".equals(target.getObjectType())
                    || !Objects.equals(target.getObjectVersion(), request.getExpectedVersion())) {
                throw new ServiceException("采纳目标节点版本已变化");
            }
            com.alibaba.fastjson2.JSONObject content = JSON.parseObject(target.getContentJson());
            if (!"TEXT".equalsIgnoreCase(content.getString("nodeType"))) throw new ServiceException("采纳目标不是文本节点");
            if ("APPEND".equals(request.getMode())) {
                String prior = CanvasPlainText.normalize(content.getString("textContent") == null
                        ? Objects.toString(content.get("content"), "") : content.getString("textContent"),
                        content.getString("textFormat"));
                plain = prior + (prior.isEmpty() || plain.isEmpty() ? "" : "\n") + plain;
            }
        } else if (target != null && target.getDeleted() == 0) {
            throw new ServiceException("新节点ID已存在");
        }
        if (plain.length() > 65536) throw new ServiceException("采纳正文超过节点限制");
        Map<String, Object> adoption = new LinkedHashMap<>();
        adoption.put("sourceType", "RUNTIME_RUN");
        adoption.put("sourceRunId", run.getId().toString());
        adoption.put("mode", request.getMode());
        adoption.put("requestHash", requestHash);
        Map<String, Object> payload = new LinkedHashMap<>();
        if (create) {
            payload.put("nodeType", "TEXT");
            payload.put("title", request.getTitle() == null ? "文本结果" : request.getTitle());
        }
        payload.put("textContent", plain);
        payload.put("adoption", adoption);
        CanvasRequests.Mutation mutation = new CanvasRequests.Mutation();
        mutation.setObjectId(request.getObjectId());
        mutation.setObjectType("NODE");
        mutation.setAction(create ? "UPSERT" : "PATCH");
        mutation.setExpectedVersion(request.getExpectedVersion());
        mutation.setLockToken(request.getLockToken());
        mutation.setPayload(payload);
        CanvasRequests.Mutate mutate = new CanvasRequests.Mutate();
        mutate.setWorkspaceId(request.getWorkspaceId());
        mutate.setSessionId(request.getSessionId());
        mutate.setOperationId(request.getOperationId());
        mutate.setMutations(List.of(mutation));
        Map<String, Object> result = projectService.mutate(mutate, userId);
        // Source provenance lives in the node payload. The returned operation is the shared mutation result.
        return result;
    }

    @EventListener
    public void onMediaTaskCompleted(MediaTaskCompletedEvent event) {
        try {
            settleTask(event.getTaskId());
        } catch (RuntimeException ex) {
            // 画布登记可由对账重试，不能阻断同一终态事件的 OSS 转存监听器。
            log.warn("画布任务终态登记待重试, taskId={}", event.getTaskId(), ex);
        }
    }

    @EventListener
    public void onMediaTaskOssPersisted(MediaTaskOssPersistedEvent event) {
        settleTask(event.getTaskId());
    }

    public void settleTask(Long taskId) {
        // Terminal events are published from the media transaction's afterCommit callback.
        // A REQUIRED transaction would join that already-committed context: the binding may
        // persist, but callbacks registered below would never run, so WebSocket misses terminal
        // and result-selection events. Give settlement its own commit boundary.
        TransactionTemplate settlementTx = tx();
        settlementTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        settlementTx.executeWithoutResult(status -> {
            TaskBinding binding = canvasMapper.selectTaskBinding(taskId);
            if (binding == null) return;
            AidMediaTask task = mediaTaskMapper.selectById(taskId);
            if (task == null || !TERMINAL.contains(task.getStatus())) return;
            if (!Objects.equals(binding.getActorUserId(), task.getUserId()) || !Objects.equals(binding.getProjectId(), task.getProjectId())) {
                throw new ServiceException("画布任务归属校验失败");
            }
            if (CanvasImageEditTaskGuard.isProtectionPending(task)) {
                // 上游结果只作为平台像素保护的可恢复检查点；完成 OSS 保护前保持节点占用。
                collaborationService.renewTaskLock(binding.getWorkspaceId(), binding.getObjectId(), taskId);
                canvasMapper.touchTaskBinding(binding.getId());
                return;
            }
            if (isMediaResultPending(task)) {
                // 上游成功不等于本站结果已保存；等待 OSS 就绪事件后再登记资源和释放占用。
                collaborationService.renewTaskLock(binding.getWorkspaceId(), binding.getObjectId(), taskId);
                canvasMapper.touchTaskBinding(binding.getId());
                return;
            }
            if ("SUCCEEDED".equals(task.getStatus()) && !isAudioTextResult(task) && RESOURCE_MEDIA_TYPES.contains(binding.getMediaType())) {
                if (!matchesTaskMedia(binding, task)) {
                    throw new ServiceException("画布任务媒体类型不一致");
                }
                // Successful media is a workspace resource before it becomes the selected result.
                // This keeps later quote/reference preparation read-only and makes retries idempotent.
                registerMediaResults(binding, isLayerSplitTask(task));
            }
            String resultUrl = "SUCCEEDED".equals(task.getStatus()) ? firstNonBlank(task.getOssUrl(), task.getOriginUrl()) : null;
            int changed = canvasMapper.completeTaskBinding(taskId, task.getStatus(), resultUrl);
            if (changed == 1) {
                binding.setStatus(task.getStatus());
                binding.setResultUrl(resultUrl);
                persistTaskEventTx(binding, mediaGenerationService.queryTaskLocal(taskId), "TASK_TERMINAL");
            }
            if ("SUCCEEDED".equals(task.getStatus())) {
                if (isAudioTextResult(task) || "TEXT".equals(binding.getMediaType()) && !"RUNTIME_RUN".equals(task.getBizTaskType())) {
                    autoApplyText(binding, task);
                }
                else autoSelectResult(binding);
            }
            afterCommit(() -> collaborationService.releaseTaskLock(binding.getWorkspaceId(), binding.getObjectId(), taskId));
        });
    }

    private boolean matchesTaskMedia(TaskBinding binding, AidMediaTask task) {
        if (Objects.equals(binding.getMediaType(), task.getMediaType())) return true;
        if (toolRegistries == null || !com.aid.billing.dto.BillingBudgetContext.isBudgetManagedBizTaskType(task.getBizTaskType())
                || task.getBizTaskId() == null) return false;
        var step = runtimeRunStepMapper.selectById(task.getBizTaskId());
        if (step == null || step.getToolCode() == null || !Objects.equals(step.getMediaTaskId(), task.getId())) return false;
        var toolRegistry = toolRegistries.getObject();
        var output = toolRegistry.billingMediaType(step.getToolCode());
        return output != null && output.name().equals(binding.getMediaType())
                && Objects.equals(toolRegistry.persistedMediaType(step.getToolCode()), task.getMediaType());
    }

    /** AUDIO is the API type; existing Web voice nodes persist VOICE. */
    private static boolean isAudioNode(com.alibaba.fastjson2.JSONObject content) {
        String type = content.getString("nodeType");
        return "AUDIO".equalsIgnoreCase(type) || "VOICE".equalsIgnoreCase(type);
    }

    private boolean isAudioTextResult(AidMediaTask task) {
        if (task == null || !"AUDIO".equals(task.getMediaType()) || task.getResultText() == null) return false;
        try {
            String code = JSON.parseObject(task.getRequestJson()).getString("capabilityCode");
            return Set.of("post_lyrics_generate", "post_lyrics_extend", "post_lyrics_generation").contains(code);
        } catch (RuntimeException invalid) { return false; }
    }

    private boolean isLayerSplitTask(AidMediaTask task) {
        if (task == null || task.getRequestJson() == null) return false;
        try {
            return "image_layer_decomposition".equals(
                    JSON.parseObject(task.getRequestJson()).getString("capabilityCode"));
        } catch (RuntimeException invalid) {
            throw new ServiceException("图层分离任务参数无效");
        }
    }

    private boolean isMediaResultPending(AidMediaTask task) {
        // Every generated workspace media result must be durably stored before it is selectable.
        // The terminal provider receipt can arrive before the existing OSS persistence event.
        return task != null && task.getMediaType() != null && "SUCCEEDED".equals(task.getStatus())
                && (RESOURCE_MEDIA_TYPES.contains(task.getMediaType()) || "COMPOSE".equals(task.getMediaType()))
                && (task.getOssUrl() == null || task.getOssUrl().isBlank());
    }

    private void registerMediaResults(TaskBinding binding, boolean layerSplit) {
        List<Map<String, Object>> results = canvasMapper.selectMediaResultsByTaskIds(List.of(binding.getTaskId()));
        if (results.isEmpty() || results.size() > (layerSplit ? 17 : 50)) {
            throw new ServiceException(layerSplit ? "图层分离结果数量无效" : "画布媒体结果数量无效");
        }
        for (Map<String, Object> stored : results) {
            Long resultId = asLong(stored.get("resultId"));
            String ossUrl = Objects.toString(stored.get("ossUrl"), "");
            String metadataJson = Objects.toString(stored.get("metadataJson"), "");
            String mediaType = Objects.toString(stored.get("mediaType"), "").toUpperCase();
            if (resultId == null || ossUrl.isBlank() || layerSplit && metadataJson.isBlank()
                    || !(RESOURCE_MEDIA_TYPES.contains(mediaType) || "AUDIO".equals(binding.getMediaType()) && "FILE".equals(mediaType))
                    || !"AUDIO".equals(binding.getMediaType()) && !Objects.equals(binding.getMediaType(), mediaType)) {
                throw new ServiceException("画布媒体结果尚未完整保存");
            }
            CanvasResource resource = new CanvasResource();
            resource.setProjectId(binding.getProjectId());
            resource.setWorkspaceId(binding.getWorkspaceId());
            resource.setOwnerUserId(binding.getActorUserId());
            resource.setSourceType("MEDIA_RESULT");
            resource.setSourceId(resultId);
            resource.setMediaType("FILE".equals(mediaType) ? "DOCUMENT" : mediaType);
            resource.setStorageUrl(ossUrl);
            resource.setFileSize(asLong(stored.get("fileSize")));
            resource.setMimeType(firstNonBlank(Objects.toString(stored.get("mimeType"), null),
                    layerSplit ? "image/png" : null));
            resource.setMetadataJson(metadataJson.isBlank() ? null : metadataJson);
            resource.setStatus("ACTIVE");
            if (canvasMapper.insertCanvasResource(resource) != 1
                    && canvasMapper.selectCanvasResourceBySource(
                    binding.getWorkspaceId(), "MEDIA_RESULT", resultId) == null) {
                throw new ServiceException("画布媒体结果资源登记失败");
            }
        }
    }

    @Override
    public void reconcileBoundTasks() {
        for (TaskBinding binding : canvasMapper.selectCanvasTaskReconcileCandidates(100)) {
            RLock submitLock = redissonClient.getLock(submitLockName(binding.getWorkspaceId(), binding.getOperationId()));
            boolean locked = false;
            try {
                locked = submitLock.tryLock();
                if (!locked) continue;
                if (binding.getTaskId() == null) {
                    AidMediaTask recovered = findTask(binding.getCallId());
                    if (recovered != null) {
                        bindSubmittedTask(binding, recovered, binding.getActorUserId());
                    } else if (isStaleSubmitting(binding)) {
                        failStaleTaskIntent(binding);
                    }
                    continue;
                }
                AidMediaTask task = mediaTaskMapper.selectById(binding.getTaskId());
                if (task != null && TERMINAL.contains(task.getStatus())) settleTask(task.getId());
                else {
                    collaborationService.renewTaskLock(binding.getWorkspaceId(), binding.getObjectId(), binding.getTaskId());
                    canvasMapper.touchTaskBinding(binding.getId());
                }
            } catch (RuntimeException e) {
                log.warn("画布生成任务对账失败: bindingId={}, taskId={}", binding.getId(), binding.getTaskId(), e);
            } finally {
                if (locked && submitLock.isHeldByCurrentThread()) submitLock.unlock();
            }
        }
    }

    private void failTaskIntent(TaskBinding binding) {
        tx().executeWithoutResult(status -> {
            if (canvasMapper.failTaskIntent(binding.getId()) == 1) {
                afterCommit(() -> collaborationService.releasePendingTaskLock(binding.getWorkspaceId(),
                        binding.getObjectId(), binding.getActorUserId(), binding.getOperationId()));
            }
        });
    }

    private void failStaleTaskIntent(TaskBinding binding) {
        Date cutoff = new Date(System.currentTimeMillis() - SUBMIT_INTENT_TIMEOUT_MILLIS);
        tx().executeWithoutResult(status -> {
            if (canvasMapper.failStaleTaskIntent(binding.getId(), cutoff) == 1) {
                log.warn("画布生成提交意图超时且未找到媒体任务，已释放占用: bindingId={}, callId={}",
                        binding.getId(), binding.getCallId());
                afterCommit(() -> collaborationService.releasePendingTaskLock(binding.getWorkspaceId(),
                        binding.getObjectId(), binding.getActorUserId(), binding.getOperationId()));
            }
        });
    }

    private static boolean isStaleSubmitting(TaskBinding binding) {
        return binding.getCreateTime() != null
                && binding.getCreateTime().getTime() <= System.currentTimeMillis() - SUBMIT_INTENT_TIMEOUT_MILLIS;
    }

    private static String submitLockName(Long workspaceId, String operationId) {
        return "canvas:generate:submit:" + workspaceId + ":" + operationId;
    }

    private void persistTaskEventTx(TaskBinding binding, MediaTaskResponse response, String eventType) {
        Workspace workspace = canvasMapper.selectWorkspaceForUpdate(binding.getWorkspaceId());
        if (workspace == null) return;
        String operationId = eventType + ":" + binding.getTaskId();
        if (canvasMapper.selectOperation(workspace.getId(), operationId) != null) return;
        if (canvasMapper.applyWorkspaceDelta(workspace.getId(), 0, 0, 0, 0L) != 1) throw new ServiceException("工作区已失效");
        Workspace updated = canvasMapper.selectWorkspace(workspace.getId());
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", eventType);
        event.put("workspaceId", JsonSafeId.value(binding.getWorkspaceId()));
        event.put("taskId", JsonSafeId.value(binding.getTaskId()));
        event.put("objectId", binding.getObjectId());
        event.put("inputObjectVersion", binding.getInputObjectVersion());
        event.put("operationId", binding.getOperationId());
        event.put("actorUserId", JsonSafeId.value(binding.getActorUserId()));
        event.put("mediaType", binding.getMediaType());
        event.put("status", response == null ? binding.getStatus() : response.getStatus());
        event.put("eta", response == null ? null : response.getEta());
        event.put("resultUrl", response == null ? binding.getResultUrl() : firstNonBlank(response.getOssUrl(), response.getOriginUrl()));
        event.put("errorCode", response == null ? null : response.getErrorCode());
        event.put("userMessage", response == null ? null : response.getUserMessage());
        event.put("revision", updated.getRevision());
        event.put("eventSeq", updated.getEventSeq());
        String json = JSON.toJSONString(event);
        Operation operation = new Operation();
        operation.setProjectId(binding.getProjectId());
        operation.setWorkspaceId(binding.getWorkspaceId());
        operation.setOperationId(operationId);
        operation.setActorUserId(binding.getActorUserId());
        operation.setWorkspaceRevision(updated.getRevision());
        operation.setEventSeq(updated.getEventSeq());
        operation.setOperationType(eventType);
        operation.setPayloadJson(json);
        operation.setPayloadHash(sha256(json));
        operation.setCreateTime(new Date());
        canvasMapper.insertOperation(operation);
        afterCommit(() -> collaborationService.publishWorkspaceEvent(binding.getWorkspaceId(), json));
    }

    /** 仅普通文本生成自动写回；迟到结果保留历史但不覆盖新版本。 */
    private void autoApplyText(TaskBinding binding, AidMediaTask task) {
        if (task.getResultText() == null) return;
        String operationId = "TEXT_AUTO:" + binding.getTaskId();
        if (canvasMapper.selectOperation(binding.getWorkspaceId(), operationId) != null) return;
        Workspace workspace = canvasMapper.selectWorkspaceForUpdate(binding.getWorkspaceId());
        if (workspace == null) return;
        CanvasObject node = canvasMapper.selectCanvasObjectForUpdate(binding.getWorkspaceId(), binding.getObjectId());
        if (node == null || node.getDeleted() == 1 || !"NODE".equals(node.getObjectType())
                || !Objects.equals(node.getObjectVersion(), binding.getInputObjectVersion())) return;
        com.alibaba.fastjson2.JSONObject content = JSON.parseObject(node.getContentJson());
        if (!"TEXT".equalsIgnoreCase(content.getString("nodeType"))
                && !(isAudioTextResult(task) && isAudioNode(content))) return;
        String plain = CanvasPlainText.normalize(task.getResultText(), binding.getResultFormat());
        if (plain.length() > 65536) return;
        content.put("textContent", plain);
        if (isAudioTextResult(task)) {
            var metadata = content.getJSONObject("metadata");
            if (metadata == null) { metadata = new com.alibaba.fastjson2.JSONObject(); content.put("metadata", metadata); }
            var stored = metadata.getJSONObject("studioData");
            if (stored == null) { stored = new com.alibaba.fastjson2.JSONObject(); metadata.put("studioData", stored); }
            stored.put("audioTextTaskId", task.getId().toString());
            var selection = canvasMapper.selectNodeResultSelection(binding.getWorkspaceId(), binding.getObjectId());
            stored.put("audioTextSelectionVersion", selection == null ? 0 : selection.getSelectionVersion());
        }
        content.remove("textFormat");
        content.remove("content");
        String json = content.toJSONString();
        long delta = json.getBytes(StandardCharsets.UTF_8).length
                - node.getContentJson().getBytes(StandardCharsets.UTF_8).length;
        if (json.getBytes(StandardCharsets.UTF_8).length > 128 * 1024) return;
        Long fence = canvasMapper.selectObjectFenceForUpdate(binding.getWorkspaceId(), binding.getObjectId());
        if (fence == null || node.getLockFence() == null || fence < node.getLockFence()) return;
        if (canvasMapper.updateCanvasObject(binding.getWorkspaceId(), binding.getObjectId(), node.getObjectVersion(),
                json, sha256(json), 0, binding.getActorUserId(), fence) != 1) return;
        if (canvasMapper.applyWorkspaceDelta(binding.getWorkspaceId(), 0, 0, 0, delta) != 1) {
            throw new ServiceException("工作区存储量更新失败");
        }
        Workspace updated = canvasMapper.selectWorkspace(binding.getWorkspaceId());
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("revision", updated.getRevision());
        data.put("eventSeq", updated.getEventSeq());
        data.put("objectId", binding.getObjectId());
        data.put("objectVersion", node.getObjectVersion() + 1);
        data.put("taskId", JsonSafeId.value(binding.getTaskId()));
        data.put("textContent", plain);
        Operation operation = new Operation();
        operation.setProjectId(binding.getProjectId());
        operation.setWorkspaceId(binding.getWorkspaceId());
        operation.setOperationId(operationId);
        operation.setActorUserId(binding.getActorUserId());
        operation.setWorkspaceRevision(updated.getRevision());
        operation.setEventSeq(updated.getEventSeq());
        operation.setOperationType("TEXT_AUTO_APPLIED");
        operation.setPayloadJson(JSON.toJSONString(data));
        operation.setPayloadHash(sha256(binding.getTaskId() + ":" + binding.getInputObjectVersion()));
        if (canvasMapper.insertOperation(operation) != 1) throw new ServiceException("文本结果日志写入失败");
        OperationObject snapshot = new OperationObject();
        snapshot.setOperationRowId(operation.getId());
        snapshot.setProjectId(binding.getProjectId());
        snapshot.setWorkspaceId(binding.getWorkspaceId());
        snapshot.setOperationId(operationId);
        snapshot.setObjectId(binding.getObjectId());
        snapshot.setObjectType("NODE");
        snapshot.setBeforeVersion(node.getObjectVersion());
        snapshot.setAfterVersion(node.getObjectVersion() + 1);
        snapshot.setBeforeDeleted(0);
        snapshot.setAfterDeleted(0);
        snapshot.setBeforeContentJson(node.getContentJson());
        if (canvasMapper.insertOperationObjects(List.of(snapshot)) != 1) throw new ServiceException("文本结果快照写入失败");
        Map<String, Object> event = new LinkedHashMap<>(data);
        event.put("type", "TEXT_AUTO_APPLIED");
        event.put("operationId", operationId);
        afterCommit(() -> collaborationService.publishWorkspaceEvent(binding.getWorkspaceId(), JSON.toJSONString(event)));
    }

    /** 成功结果只在输入版本仍未变化且节点尚无当前结果时自动选中，迟到结果只保留在历史。 */
    private void autoSelectResult(TaskBinding binding) {
        if (binding.getTaskId() == null) return;
        List<Map<String, Object>> results = canvasMapper.selectMediaResultsByTaskIds(List.of(binding.getTaskId()));
        if (results.isEmpty()) return;
        Workspace workspace = canvasMapper.selectWorkspaceForUpdate(binding.getWorkspaceId());
        if (workspace == null) return;
        CanvasObject node = canvasMapper.selectCanvasObjectForUpdate(binding.getWorkspaceId(), binding.getObjectId());
        if (node == null || node.getDeleted() == 1 || !Objects.equals(node.getObjectVersion(), binding.getInputObjectVersion())) return;
        NodeResultSelection existing = canvasMapper.selectNodeResultSelection(binding.getWorkspaceId(), binding.getObjectId());
        if (existing != null && Objects.equals(existing.getInputObjectVersion(), node.getObjectVersion())) return;
        Map<String, Object> primary = results.stream().filter(result -> Objects.equals(binding.getMediaType(), result.get("mediaType")))
                .findFirst().orElse(null);
        if (primary == null) return;
        Long resultId = asLong(primary.get("resultId"));
        if (resultId == null) return;
        NodeResultSelection selection = new NodeResultSelection();
        selection.setProjectId(binding.getProjectId());
        selection.setWorkspaceId(binding.getWorkspaceId());
        selection.setObjectId(binding.getObjectId());
        selection.setTaskId(binding.getTaskId());
        selection.setResultId(resultId);
        selection.setInputObjectVersion(binding.getInputObjectVersion());
        selection.setSelectionVersion(1L);
        selection.setLastActorUserId(binding.getActorUserId());
        if (existing == null) {
            if (canvasMapper.insertNodeResultSelection(selection) != 1) return;
        } else {
            if (canvasMapper.updateNodeResultSelection(binding.getWorkspaceId(), binding.getObjectId(), binding.getTaskId(),
                    resultId, binding.getInputObjectVersion(), binding.getActorUserId()) != 1) return;
            selection = canvasMapper.selectNodeResultSelection(binding.getWorkspaceId(), binding.getObjectId());
        }
        String operationId = "RESULT_AUTO:" + binding.getTaskId() + ":" + resultId;
        String requestHash = sha256(operationId);
        if (canvasMapper.selectOperation(workspace.getId(), operationId) == null) {
            persistResultSelectionEvent(workspace, selection, operationId, requestHash,
                    "RESULT_AUTO_SELECTED", binding.getActorUserId());
        }
    }

    private Map<String, Object> persistResultSelectionEvent(Workspace workspace, NodeResultSelection selection,
                                                            String operationId, String requestHash,
                                                            String eventType, Long actorUserId) {
        if (canvasMapper.applyWorkspaceDelta(workspace.getId(), 0, 0, 0, 0L) != 1) throw new ServiceException("工作区已失效");
        Workspace updated = canvasMapper.selectWorkspace(workspace.getId());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("objectId", selection.getObjectId());
        result.put("taskId", JsonSafeId.value(selection.getTaskId()));
        result.put("resultId", JsonSafeId.value(selection.getResultId()));
        result.put("inputObjectVersion", selection.getInputObjectVersion());
        result.put("selectionVersion", selection.getSelectionVersion());
        result.put("revision", updated.getRevision());
        result.put("eventSeq", updated.getEventSeq());
        String json = JSON.toJSONString(result);
        Operation operation = new Operation();
        operation.setProjectId(workspace.getProjectId());
        operation.setWorkspaceId(workspace.getId());
        operation.setOperationId(operationId);
        operation.setActorUserId(actorUserId);
        operation.setWorkspaceRevision(updated.getRevision());
        operation.setEventSeq(updated.getEventSeq());
        operation.setOperationType(eventType);
        operation.setPayloadJson(json);
        operation.setPayloadHash(requestHash);
        operation.setCreateTime(new Date());
        if (canvasMapper.insertOperation(operation) != 1) throw new ServiceException("结果选择日志写入失败");
        Map<String, Object> event = new LinkedHashMap<>(result);
        event.put("type", eventType);
        event.put("operationId", operationId);
        event.put("actorUserId", JsonSafeId.value(actorUserId));
        afterCommit(() -> collaborationService.publishWorkspaceEvent(workspace.getId(), JSON.toJSONString(event)));
        return result;
    }

    private Map<String, Object> resultView(Map<String, Object> stored, NodeResultSelection selection) {
        Map<String, Object> result = new LinkedHashMap<>();
        Long resultId = asLong(stored.get("resultId"));
        boolean protectionPending = CanvasImageEditTaskGuard.isProtectionPending(
                Objects.toString(stored.get("taskStatus"), null),
                Objects.toString(stored.get("taskOssUrl"), null),
                Objects.toString(stored.get("taskRequestJson"), null));
        result.put("resultId", JsonSafeId.value(resultId));
        result.put("taskId", JsonSafeId.value(asLong(stored.get("taskId"))));
        result.put("resultIndex", stored.get("resultIndex"));
        result.put("mediaType", stored.get("mediaType"));
        result.put("resultUrl", protectionPending ? null : mediaUrlResolver.toFullUrl(firstNonBlank(
                Objects.toString(stored.get("ossUrl"), null),
                Objects.toString(stored.get("originUrl"), null))));
        result.put("mimeType", stored.get("mimeType"));
        result.put("fileSize", stored.get("fileSize"));
        result.put("resourceId", JsonSafeId.value(asLong(stored.get("resourceId"))));
        result.put("metadata", stored.get("metadataJson") == null ? Map.of()
                : JSON.parseObject(Objects.toString(stored.get("metadataJson"))));
        result.put("durationSeconds", stored.get("durationSeconds"));
        result.put("selected", selection != null && Objects.equals(selection.getResultId(), resultId));
        result.put("persisting", protectionPending || stored.get("ossUrl") == null
                || Objects.toString(stored.get("ossUrl"), "").isBlank());
        return result;
    }

    private static Map<String, Object> selectionView(NodeResultSelection selection) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("taskId", JsonSafeId.value(selection.getTaskId()));
        result.put("resultId", JsonSafeId.value(selection.getResultId()));
        result.put("inputObjectVersion", selection.getInputObjectVersion());
        result.put("selectionVersion", selection.getSelectionVersion());
        result.put("updateTime", selection.getUpdateTime());
        return result;
    }

    private static Long asLong(Object value) {
        if (value == null) return null;
        if (value instanceof Number number) return number.longValue();
        try { return Long.parseLong(value.toString()); }
        catch (NumberFormatException ignored) { return null; }
    }

    private MediaTaskResponse visibleTask(TaskBinding binding, Long viewerUserId) {
        if (binding.getTaskId() == null) throw new ServiceException("生成请求正在提交，请使用相同 operationId 重试");
        MediaTaskResponse response = mediaGenerationService.queryTaskLocal(binding.getTaskId());
        if (response == null) throw new ServiceException("媒体任务不存在");
        AidMediaTask stored = mediaTaskMapper.selectById(binding.getTaskId());
        boolean saving = isMediaResultPending(stored) || CanvasImageEditTaskGuard.isProtectionPending(stored);
        response.setExecutionPhase(executionPhase(stored, saving));
        if (stored != null && "QUEUED".equals(stored.getStatus())) {
            Integer position = mediaConcurrencyLimiter.getModelQueuePosition(stored);
            response.setQueuePosition(position);
            response.setEta(mediaEtaService.estimateMediaTask(stored, position));
            response.setQueueWaitReason(mediaConcurrencyLimiter.getCapacityWaitReason(stored));
        }
        if (saving) {
            response.setEta(null);
            response.setStatus("PROCESSING");
            response.setOriginUrl(null);
            response.setOssUrl(null);
        }
        if ("TEXT".equals(binding.getMediaType()) && response.getTextContent() != null) {
            response.setTextContent(CanvasPlainText.normalize(response.getTextContent(), binding.getResultFormat()));
        }
        if (!Objects.equals(binding.getActorUserId(), viewerUserId)) {
            response.setBillingStatus(null);
            response.setPreHoldAmount(null);
            response.setActualCost(null);
            response.setBillingMode(null);
            response.setRefundStatus(null);
            response.setNeedRecharge(false);
            response.setRechargeOwner(null);
        }
        return withCanvasIdentity(response, binding);
    }

    private static String executionPhase(AidMediaTask task, boolean saving) {
        if (saving) return "SAVING_MEDIA";
        if (task == null || TERMINAL.contains(task.getStatus())) return null;
        if ("QUEUED".equals(task.getStatus())) return "WAITING_FOR_CAPACITY";
        if (task.getUpstreamAcceptTime() != null || !isBlank(task.getProviderTaskId())) return "UPSTREAM_PROCESSING";
        return "SUBMITTING";
    }

    private static MediaTaskResponse withCanvasIdentity(MediaTaskResponse response, TaskBinding binding) {
        response.setWorkspaceId(String.valueOf(binding.getWorkspaceId()));
        response.setObjectId(binding.getObjectId());
        response.setInputObjectVersion(binding.getInputObjectVersion());
        response.setOperationId(binding.getOperationId());
        return response;
    }

    private CanvasObject requireNode(Long workspaceId, String objectId, Long expectedVersion) {
        CanvasObject object = canvasMapper.selectCanvasObject(workspaceId, objectId);
        if (object == null || object.getDeleted() == 1 || !"NODE".equals(object.getObjectType())) throw new ServiceException("生成目标节点不存在");
        if (!Objects.equals(object.getObjectVersion(), expectedVersion)) throw new ServiceException("节点内容已变化，请确认最新输入后重试");
        return object;
    }

    private void validateDuplicate(TaskBinding binding, CanvasObject object, Long userId, String mediaType, String requestHash) {
        if (!Objects.equals(binding.getActorUserId(), userId) || !Objects.equals(binding.getObjectId(), object.getObjectId())
                || !Objects.equals(binding.getInputObjectVersion(), object.getObjectVersion())
                || !Objects.equals(binding.getMediaType(), mediaType) || !Objects.equals(binding.getRequestHash(), requestHash)) {
            throw new ServiceException("operationId 已被不同生成请求使用");
        }
    }

    private AidMediaTask findTask(String callId) {
        if (callId == null || callId.isBlank()) return null;
        return mediaTaskMapper.selectOne(new LambdaQueryWrapper<AidMediaTask>()
                .eq(AidMediaTask::getIdempotencyKey, callId).last("LIMIT 1"));
    }

    private void sanitize(MediaImageGenerateRequest request, Workspace workspace, Long userId, String callId,
                          List<CanvasResource> resources) {
        rejectUntrustedOptions(request.getOptions());
        request.setReferenceImageUrl(null);
        List<String> images = resources.stream().filter(r -> "IMAGE".equals(r.getMediaType()))
                .map(CanvasResource::getStorageUrl).map(mediaUrlResolver::toFullUrl).toList();
        if (resources.size() != images.size()) throw new ServiceException("图片生成只能引用图片素材");
        if (!images.isEmpty()) {
            request.setReferenceImageUrl(images.get(0));
            Map<String, Object> options = request.getOptions() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(request.getOptions());
            options.put("referenceImages", images);
            request.setOptions(options);
        }
        request.setUserId(userId);
        request.setProjectId(workspace.getProjectId());
        request.setEpisodeId(0L);
        request.setRecordId(null);
        request.setCategory(null);
        request.setBizTaskId(null);
        request.setBizTaskType("canvas_node");
        request.setCallId(callId);
        request.setCallIdentity("canvas-image");
        request.setInvocationIdentity(callId);
        request.setBusinessFuncCode(null);
    }

    private void sanitize(MediaVideoGenerateRequest request, Workspace workspace, Long userId, String callId,
                          List<CanvasResource> resources) {
        rejectUntrustedOptions(request.getOptions());
        request.setImageUrl(null);
        request.setReferenceAudios(null);
        request.setReferenceVideoRecordIds(null);
        request.setReferenceVideoResourceIds(null);
        request.setResolvedReferenceVideos(null);
        request.setBackgroundImageResourceId(null);
        List<CanvasResource> images = resources.stream().filter(r -> "IMAGE".equals(r.getMediaType())).toList();
        List<CanvasResource> videos = resources.stream().filter(r -> "VIDEO".equals(r.getMediaType())).toList();
        List<CanvasResource> audios = resources.stream().filter(r -> "AUDIO".equals(r.getMediaType())).toList();
        if (images.size() > 16) throw new ServiceException("视频参考图片数量过多");
        boolean firstFrame = !images.isEmpty() && !Set.of("video_edit", "video_extend", "reference_to_video")
                .contains(Objects.toString(request.getCapabilityCode(), ""));
        if (firstFrame && images.size() > 1) throw new ServiceException("首帧模式最多引用一张图片");
        if (firstFrame) request.setImageUrl(mediaUrlResolver.toFullUrl(images.get(0).getStorageUrl()));
        if (!images.isEmpty() && "portrait_combination".equals(request.getCapabilityCode())) {
            request.setBackgroundImageResourceId(images.get(0).getId());
        }
        for (CanvasResource resource : resources) {
            if ("IMAGE".equals(resource.getMediaType()) || "VIDEO".equals(resource.getMediaType())
                    || "AUDIO".equals(resource.getMediaType())) continue;
            throw new ServiceException("视频生成只接受已登记的图片、视频和参考音频");
        }
        if (!videos.isEmpty() || !images.isEmpty() && !firstFrame) {
            Map<String, Object> trusted = new java.util.LinkedHashMap<>(
                    request.getOptions() == null ? Map.of() : request.getOptions());
            if (!images.isEmpty() && !firstFrame) trusted.put("referenceImages", images.stream()
                    .map(resource -> mediaUrlResolver.toFullUrl(resource.getStorageUrl())).toList());
            if (!videos.isEmpty()) trusted.put("referenceVideos", videos.stream()
                    .map(resource -> mediaUrlResolver.toFullUrl(resource.getStorageUrl())).toList());
            request.setOptions(trusted);
        }
        if (!videos.isEmpty()) {
            request.setReferenceVideoResourceIds(videos.stream().map(CanvasResource::getId).toList());
        }
        if (!audios.isEmpty()) {
            List<ReferenceAudioInput> referenceAudios = new java.util.ArrayList<>();
            for (int index = 0; index < audios.size(); index++) {
                CanvasResource resource = audios.get(index);
                ReferenceAudioInput audio = new ReferenceAudioInput();
                audio.setIndex(index + 1);
                audio.setName("canvas-resource-" + resource.getId());
                audio.setSourceType(ReferenceAudioInput.SOURCE_UPLOAD);
                audio.setReferenceAudioId(resource.getId());
                audio.setSampleUrl(mediaUrlResolver.toFullUrl(resource.getStorageUrl()));
                referenceAudios.add(audio);
            }
            request.setReferenceAudios(referenceAudios);
        }
        request.setUserId(userId);
        request.setProjectId(workspace.getProjectId());
        request.setWorkspaceId(workspace.getId());
        request.setEpisodeId(0L);
        request.setRecordId(null);
        request.setCategory(null);
        request.setBizTaskId(null);
        request.setBizTaskType("canvas_node");
        request.setParentTaskId(null);
        request.setCallId(callId);
        request.setCallIdentity("canvas-video");
        request.setInvocationIdentity(callId);
        request.setBusinessFuncCode("canvas.video.generate");
    }

    private void applyVideoTool(CanvasRequests.VideoTool tool, MediaVideoGenerateRequest request,
                                Long workspaceId, List<CanvasResource> resources) {
        if (tool.getSourceResourceId() == null || tool.getSourceExpectedVersion() == null
                || tool.getSourceObjectId() == null || tool.getOperation() == null) {
            throw new ServiceException("视频工具缺少源节点、版本或资源");
        }
        CanvasResource source = resources.stream()
                .filter(item -> Objects.equals(item.getId(), tool.getSourceResourceId()))
                .findFirst().orElseThrow(() -> new ServiceException("源视频资源未登记在当前工作区"));
        if (!"VIDEO".equals(source.getMediaType())) throw new ServiceException("源资源必须为视频");
        CanvasObject sourceNode = canvasMapper.selectCanvasObject(workspaceId, tool.getSourceObjectId());
        if (sourceNode == null || !"NODE".equals(sourceNode.getObjectType())
                || !Objects.equals(sourceNode.getDeleted(), 0)
                || !Objects.equals(sourceNode.getObjectVersion(), tool.getSourceExpectedVersion())) {
            throw new ServiceException("源视频节点版本已变化，请重新提交");
        }
        com.alibaba.fastjson2.JSONObject content;
        try {
            content = JSON.parseObject(sourceNode.getContentJson());
        } catch (RuntimeException invalid) {
            throw new ServiceException("源视频节点内容无效");
        }
        com.alibaba.fastjson2.JSONArray ids = content == null ? null : content.getJSONArray("resourceIds");
        boolean referencedInput = ids != null && ids.stream().anyMatch(id ->
                Objects.equals(String.valueOf(id), String.valueOf(source.getId())));
        Long selectedResourceId = canvasMapper.selectNodeCurrentResourceId(workspaceId, tool.getSourceObjectId());
        boolean selectedOutput = Objects.equals(selectedResourceId, source.getId());
        if (!referencedInput && !selectedOutput) {
            throw new ServiceException("源视频节点未引用所选资源");
        }
        VideoToolRoute route = videoToolRoute(tool.getOperation());
        if (request.getCapabilityCode() != null && !request.getCapabilityCode().isBlank()
                && !route.capabilityCode().equals(request.getCapabilityCode())) {
            throw new ServiceException("视频工具与模型能力不匹配");
        }
        request.setBusinessFuncCode(route.funcCode());
        request.setCapabilityCode(route.capabilityCode());
        if ("SUBTITLE_AUTO".equals(tool.getOperation()) || "SUBTITLE_REGION".equals(tool.getOperation())) {
            String expected = "SUBTITLE_AUTO".equals(tool.getOperation()) ? "AUTO" : "CUSTOM";
            Object actual = request.getOptions() == null ? null : request.getOptions().get("eraseMode");
            if (actual != null && !expected.equals(actual)) throw new ServiceException("去字幕模式与操作不匹配");
            Map<String, Object> options = new LinkedHashMap<>(
                    request.getOptions() == null ? Map.of() : request.getOptions());
            options.put("eraseMode", expected);
            request.setOptions(options);
        }
    }

    private void prepareVideoToolCapability(CanvasRequests.VideoTool tool, MediaVideoGenerateRequest request) {
        VideoToolRoute route = videoToolRoute(tool.getOperation());
        if (request.getCapabilityCode() != null && !request.getCapabilityCode().isBlank()
                && !route.capabilityCode().equals(request.getCapabilityCode())) {
            throw new ServiceException("视频工具与模型能力不匹配");
        }
        request.setCapabilityCode(route.capabilityCode());
    }

    private VideoToolRoute videoToolRoute(String operation) {
        return switch (operation) {
            case "ENHANCE" -> new VideoToolRoute("video_enhance", "video_enhance");
            case "DEPTH_CAPTURE" -> new VideoToolRoute("video_depth_map", "video_depth_map");
            case "SUBTITLE_AUTO", "SUBTITLE_REGION" -> new VideoToolRoute("video_subtitle_remove", "video_subtitle_remove");
            case "PORTRAIT_MASK" -> new VideoToolRoute("video_portrait_segmentation", "portrait_mask");
            case "PORTRAIT_FOREGROUND" -> new VideoToolRoute("video_portrait_segmentation", "portrait_foreground");
            case "PORTRAIT_COMBINATION" -> new VideoToolRoute("video_portrait_segmentation", "portrait_combination");
            case "VOICE_ONLY" -> new VideoToolRoute("audio_voice_separation", "voice_only");
            case "BACKGROUND_ONLY" -> new VideoToolRoute("audio_voice_separation", "background_only");
            case "VOICE_BACKGROUND" -> new VideoToolRoute("audio_voice_separation", "voice_background");
            case "RESHOOT" -> new VideoToolRoute("canvas.video.reshoot", "video_edit");
            case "CONTINUE" -> new VideoToolRoute("canvas.video.continue", "video_extend");
            case "SUBJECT_REMOVE", "SUBJECT_MODIFY", "SUBJECT_REPLACE" ->
                    new VideoToolRoute("canvas.video.subject_edit", "video_edit");
            default -> throw new ServiceException("视频工具操作错误");
        };
    }

    private record VideoToolRoute(String funcCode, String capabilityCode) { }

    private static void rejectUntrustedOptions(Map<String, Object> options) {
        rejectUntrustedValue(options);
    }

    private static void rejectUntrustedValue(Object value) {
        if (value instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                String key = Objects.toString(entry.getKey(), "");
                String normalized = key.toLowerCase();
                if (normalized.contains("url") || normalized.contains("reference") || normalized.contains("callback")
                        || normalized.contains("userid") || normalized.contains("projectid") || normalized.contains("priority")) {
                    throw new ServiceException("生成 options 包含仅允许服务端设置的字段: " + key);
                }
                rejectUntrustedValue(entry.getValue());
            }
        } else if (value instanceof Iterable<?> items) {
            for (Object item : items) rejectUntrustedValue(item);
        }
    }

    private static String requestHash(CanvasRequests.GenerationBase base, Object request, String mediaType, Long userId) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("workspaceId", base.getWorkspaceId());
        canonical.put("objectId", base.getObjectId());
        canonical.put("expectedVersion", base.getExpectedVersion());
        canonical.put("actorUserId", userId);
        canonical.put("mediaType", mediaType);
        canonical.put("resourceIds", base.getResourceIds());
        canonical.put("request", request);
        if (base instanceof CanvasRequests.GenerateVideo video && video.getVideoTool() != null) {
            canonical.put("videoTool", video.getVideoTool());
        }
        return sha256(JSON.toJSONString(canonical));
    }

    private static String normalizeActiveStatus(String status) {
        return Set.of("QUEUED", "PENDING", "PROCESSING").contains(status) ? status : "PENDING";
    }
    private static String publicStatus(String status) {
        return "WAIT_POLL".equals(status) || "WAIT_CALLBACK".equals(status) ? "PROCESSING" : status;
    }
    private Map<Long, AidMediaTask> loadTaskStates(List<Long> taskIds, boolean includeTextResult) {
        Map<Long, AidMediaTask> tasks = new LinkedHashMap<>();
        if (taskIds.isEmpty()) return tasks;
        LambdaQueryWrapper<AidMediaTask> query = new LambdaQueryWrapper<>();
        if (includeTextResult) {
            query.select(AidMediaTask::getId, AidMediaTask::getStatus, AidMediaTask::getResultText,
                    AidMediaTask::getModelName, AidMediaTask::getMediaType, AidMediaTask::getOssUrl,
                    AidMediaTask::getRequestJson, AidMediaTask::getErrorMessage, AidMediaTask::getErrorDetailJson);
        } else {
            query.select(AidMediaTask::getId, AidMediaTask::getStatus, AidMediaTask::getUserId,
                    AidMediaTask::getMediaType, AidMediaTask::getProtocol, AidMediaTask::getModelName,
                    AidMediaTask::getOssUrl, AidMediaTask::getRequestJson,
                    AidMediaTask::getCreateTime, AidMediaTask::getUpstreamAcceptTime, AidMediaTask::getProviderTaskId);
        }
        query.in(AidMediaTask::getId, taskIds);
        for (AidMediaTask task : mediaTaskMapper.selectList(query)) tasks.put(task.getId(), task);
        return tasks;
    }
    private static TaskErrorResult taskError(AidMediaTask task) {
        if (task == null || (isBlank(task.getErrorMessage()) && isBlank(task.getErrorDetailJson()))) return null;
        return TaskErrorSnapshot.fromTask(task);
    }
    private static boolean isBlank(String value) { return value == null || value.isBlank(); }
    private static String firstNonBlank(String first, String second) { return first != null && !first.isBlank() ? first : second; }
    private static String sha256(String value) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private TransactionTemplate tx() { return new TransactionTemplate(transactionManager); }
    private static void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { action.run(); }
            });
        } else action.run();
    }
}
