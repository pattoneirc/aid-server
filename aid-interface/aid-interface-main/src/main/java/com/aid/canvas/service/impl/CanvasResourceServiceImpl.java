package com.aid.canvas.service.impl;

import com.aid.aid.domain.AidAudioAsset;
import com.aid.aid.domain.AidComicAsset;
import com.aid.aid.domain.AidComicProject;
import com.aid.aid.domain.AidGenRecord;
import com.aid.aid.domain.AidUserComicAsset;
import com.aid.aid.domain.dto.OssUploadResponse;
import com.aid.aid.domain.media.AidMediaTask;
import com.aid.aid.domain.media.AidMediaResult;
import com.aid.asset.center.dto.AssetCenterDetailRequest;
import com.aid.asset.center.service.IAssetCenterService;
import com.aid.asset.center.vo.AssetCenterDetailVO;
import com.aid.enums.AssetCenterCategoryEnum;
import com.aid.asset.dto.UserComicAssetCreateRequest;
import com.aid.asset.constants.UserAssetTypeConstants;
import com.aid.asset.service.IUserComicAssetService;
import com.aid.aid.mapper.AidAudioAssetMapper;
import com.aid.aid.mapper.AidComicAssetMapper;
import com.aid.aid.mapper.AidMediaTaskMapper;
import com.aid.aid.mapper.AidMediaResultMapper;
import com.aid.aid.mapper.AidUserComicAssetMapper;
import com.aid.aid.service.IAidGenRecordService;
import com.aid.canvas.domain.CanvasEntities.CanvasResource;
import com.aid.canvas.domain.CanvasEntities.Operation;
import com.aid.canvas.domain.CanvasEntities.ProjectSetting;
import com.aid.canvas.domain.CanvasEntities.Workspace;
import com.aid.canvas.dto.CanvasRequests;
import com.aid.canvas.mapper.CanvasMapper;
import com.aid.canvas.service.CanvasAccessService;
import com.aid.canvas.service.CanvasCollaborationService;
import com.aid.canvas.service.CanvasImageEditTaskGuard;
import com.aid.canvas.service.CanvasResourceService;
import com.aid.common.aid.json.JsonSafeId;
import com.aid.common.core.domain.ApiErrorDetails;
import com.aid.common.exception.ServiceException;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.media.service.VerifiedMediaMetadataService;
import com.alibaba.fastjson2.JSON;
import lombok.RequiredArgsConstructor;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Semaphore;

/** 将外部素材转换为工作区内可验证的资源引用，节点永远不直接信任客户端 URL。 */
@Service
@RequiredArgsConstructor
public class CanvasResourceServiceImpl implements CanvasResourceService {
    private static final Set<String> SOURCES = Set.of(
            "USER_ASSET", "OFFICIAL_ASSET", "AUDIO_ASSET", "MEDIA_TASK", "MEDIA_RESULT", "ASSET_CENTER");
    private final CanvasMapper canvasMapper;
    private final CanvasAccessService accessService;
    private final AidUserComicAssetMapper userAssetMapper;
    private final AidComicAssetMapper officialAssetMapper;
    private final AidAudioAssetMapper audioAssetMapper;
    private final AidMediaTaskMapper mediaTaskMapper;
    private final AidMediaResultMapper mediaResultMapper;
    private final IUserComicAssetService userComicAssetService;
    private final IAssetCenterService assetCenterService;
    private final IAidGenRecordService genRecordService;
    private final CanvasCollaborationService collaborationService;
    private final MediaUrlResolver mediaUrlResolver;
    private final VerifiedMediaMetadataService verifiedMediaMetadataService;
    private final Semaphore metadataSlots = new Semaphore(2, true);
    @Value("${canvas.resource.document.max-file-bytes:20971520}")
    private long maxDocumentFileBytes;
    @Value("${canvas.resource.document.max-batch-bytes:62914560}")
    private long maxDocumentBatchBytes;

    @Override
    @Transactional(rollbackFor = Exception.class)
    public Map<String, Object> register(CanvasRequests.ResourceRegister request, Long userId) {
        Workspace workspace = accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR");
        String sourceType = request.getSourceType().trim().toUpperCase(Locale.ROOT);
        if (!SOURCES.contains(sourceType)) throw new ServiceException("不支持的素材来源类型");
        if (request.getSourceId() == null || request.getSourceId() <= 0) throw new ServiceException("素材来源 ID 无效");
        ResolvedSource source = null;
        if ("ASSET_CENTER".equals(sourceType)) {
            AssetCenterCategoryEnum category = AssetCenterCategoryEnum.getByCode(
                    request.getSourceCategoryCode() == null ? null : request.getSourceCategoryCode().trim());
            if (category == null) throw new ServiceException("资产中心分类不支持");
            source = resolveAssetCenter(category, request.getSourceId(), userId);
            // 分类属于来源身份，不能与其他业务表的同号 ID 复用资源记录。
            sourceType = "CENTER_" + category.getCode().toUpperCase(Locale.ROOT);
        } else if (!blank(request.getSourceCategoryCode())) {
            throw new ServiceException("当前素材来源不接受资产中心分类");
        }
        if ("AUDIO_ASSET".equals(sourceType)) {
            source = resolve(sourceType, request.getSourceId(), workspace, userId);
        }
        CanvasResource existing = canvasMapper.selectCanvasResourceBySource(workspace.getId(), sourceType, request.getSourceId());
        if (existing != null) {
            if (source != null && (!"ACTIVE".equals(existing.getStatus())
                    || !Objects.equals(source.mediaType(), existing.getMediaType())
                    || !Objects.equals(source.url(), existing.getStorageUrl()))) {
                throw new ServiceException("已登记素材与当前来源不一致");
            }
            return view(existing);
        }
        if (source == null) source = resolve(sourceType, request.getSourceId(), workspace, userId);
        CanvasResource resource = new CanvasResource();
        resource.setProjectId(workspace.getProjectId());
        resource.setWorkspaceId(workspace.getId());
        resource.setOwnerUserId(source.ownerUserId());
        resource.setSourceType(sourceType);
        resource.setSourceId(request.getSourceId());
        resource.setMediaType(source.mediaType());
        resource.setStorageUrl(source.url());
        resource.setFileSize(source.fileSize());
        resource.setStatus("ACTIVE");
        resource.setCreateTime(new Date());
        resource.setUpdateTime(new Date());
        if (canvasMapper.insertCanvasResource(resource) != 1) {
            existing = canvasMapper.selectCanvasResourceBySource(workspace.getId(), sourceType, request.getSourceId());
            if (existing != null) return view(existing);
            throw new ServiceException("素材登记失败");
        }
        return view(resource);
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public Map<String, Object> transfer(CanvasRequests.ResourceTransfer request, Long userId) {
        Workspace accessible = accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR", "VIEWER");
        Workspace workspace = canvasMapper.selectWorkspaceForUpdate(accessible.getId());
        if (workspace == null) throw new ServiceException("工作区不存在或已失效");
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("resourceId", request.getResourceId());
        canonical.put("targetCategory", request.getTargetCategory());
        canonical.put("assetName", request.getAssetName());
        canonical.put("remark", request.getRemark());
        canonical.put("actorUserId", userId);
        String requestHash = sha256(JSON.toJSONString(canonical));
        Operation existingOperation = canvasMapper.selectOperation(workspace.getId(), request.getOperationId());
        if (existingOperation != null) {
            if (!requestHash.equals(existingOperation.getPayloadHash())
                    || !"ASSET_TRANSFER".equals(existingOperation.getOperationType())) {
                throw new ServiceException("operationId 已被不同内容使用");
            }
            return JSON.parseObject(existingOperation.getPayloadJson(), LinkedHashMap.class);
        }

        CanvasResource resource = canvasMapper.selectCanvasResource(request.getResourceId());
        if (resource == null || !Objects.equals(resource.getWorkspaceId(), workspace.getId())) {
            throw new ServiceException("素材不存在或不属于当前工作区");
        }
        AidComicProject project = canvasMapper.selectCanvasProject(workspace.getProjectId());
        if (project == null) throw new ServiceException("项目不存在或已失效");
        boolean projectOwner = Objects.equals(project.getUserId(), userId);
        boolean resourceOwner = Objects.equals(resource.getOwnerUserId(), userId);
        if (!projectOwner && !resourceOwner) {
            String role = accessService.requireRole(workspace.getProjectId(), userId, "EDITOR", "VIEWER");
            ProjectSetting setting = canvasMapper.selectProjectSetting(workspace.getProjectId(), "asset.transfer.member.enabled");
            boolean memberEnabled = setting != null && Boolean.TRUE.equals(JSON.parseObject(setting.getSettingValue(), Boolean.class));
            if (!"EDITOR".equals(role) || !memberEnabled) throw new ServiceException("项目未授权成员转存该素材");
        }
        Long assetId;
        String targetCategory;
        if ("IMAGE".equals(resource.getMediaType())) {
            targetCategory = request.getTargetCategory() == null || request.getTargetCategory().isBlank()
                    ? "file" : request.getTargetCategory().trim().toLowerCase();
            if (!UserAssetTypeConstants.ALLOWED_ASSET_TYPES.contains(targetCategory)) throw new ServiceException("目标图片资产分类不支持");
            UserComicAssetCreateRequest create = new UserComicAssetCreateRequest();
            create.setAssetType(targetCategory);
            create.setAssetName(request.getAssetName().trim());
            create.setImageUrl(resource.getStorageUrl());
            create.setRemark(request.getRemark());
            assetId = userComicAssetService.createAsset(create, userId);
        } else if ("VIDEO".equals(resource.getMediaType())) {
            if (request.getTargetCategory() != null && !request.getTargetCategory().isBlank()) {
                throw new ServiceException("视频转存不接受图片资产分类");
            }
            if (!mediaUrlResolver.isSiteMediaUrl(resource.getStorageUrl())) {
                throw new ServiceException("视频尚未完成本站存储，暂不能转存");
            }
            AidGenRecord record = new AidGenRecord();
            record.setUserId(userId);
            record.setProjectId(workspace.getProjectId());
            record.setEpisodeId(0L);
            record.setStoryboardId(0L);
            record.setGenType("upload_video");
            record.setFileUrl(mediaUrlResolver.toRelativePath(resource.getStorageUrl()));
            record.setStatus(1);
            record.setIsSelected(0);
            record.setDelFlag("0");
            record.setGenParams(JSON.toJSONString(Map.of("source", "CANVAS_TRANSFER",
                    "assetName", request.getAssetName().trim(), "remark", Objects.toString(request.getRemark(), ""))));
            record.setCreateBy(Long.toString(userId));
            record.setCreateTime(new Date());
            record.setUpdateBy(Long.toString(userId));
            record.setUpdateTime(new Date());
            if (genRecordService.insertAidGenRecord(record) != 1 || record.getId() == null) throw new ServiceException("视频转存失败");
            assetId = record.getId();
            targetCategory = "upload_video";
        } else {
            throw new ServiceException("当前资产库暂不支持转存该媒体类型");
        }

        if (canvasMapper.applyWorkspaceDelta(workspace.getId(), 0, 0, 0, 0L) != 1) throw new ServiceException("工作区已失效");
        Workspace updated = canvasMapper.selectWorkspace(workspace.getId());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("assetId", JsonSafeId.value(assetId));
        result.put("resourceId", JsonSafeId.value(resource.getId()));
        result.put("mediaType", resource.getMediaType());
        result.put("targetCategory", targetCategory);
        result.put("revision", updated.getRevision());
        result.put("eventSeq", updated.getEventSeq());
        String resultJson = JSON.toJSONString(result);
        Operation operation = new Operation();
        operation.setProjectId(workspace.getProjectId());
        operation.setWorkspaceId(workspace.getId());
        operation.setOperationId(request.getOperationId());
        operation.setActorUserId(userId);
        operation.setWorkspaceRevision(updated.getRevision());
        operation.setEventSeq(updated.getEventSeq());
        operation.setOperationType("ASSET_TRANSFER");
        operation.setPayloadJson(resultJson);
        operation.setPayloadHash(requestHash);
        if (canvasMapper.insertOperation(operation) != 1) throw new ServiceException("素材转存日志写入失败");
        Map<String, Object> event = new LinkedHashMap<>(result);
        event.put("type", "ASSET_TRANSFERRED");
        event.put("operationId", request.getOperationId());
        afterCommit(() -> collaborationService.publishWorkspaceEvent(workspace.getId(), JSON.toJSONString(event)));
        return result;
    }

    @Override
    public List<UploadMetadata> inspectUploads(List<String> mediaTypes, List<MultipartFile> files) {
        if (mediaTypes == null || files == null || mediaTypes.size() != files.size()) {
            throw new ServiceException("每个上传文件必须指定 mediaType");
        }
        List<UploadMetadata> result = new ArrayList<>(files.size());
        long documentBatchBytes = 0L;
        for (int i = 0; i < files.size(); i++) {
            MultipartFile file = files.get(i);
            if (file == null || file.isEmpty()) throw new ServiceException("上传文件不能为空");
            String mediaType = normalizeMediaType(mediaTypes.get(i));
            if ("DOCUMENT".equals(mediaType)) {
                if (maxDocumentFileBytes <= 0 || maxDocumentBatchBytes <= 0) {
                    throw new ServiceException("文档上传大小配置无效");
                }
                if (file.getSize() > maxDocumentFileBytes) throw new ServiceException("单个文档超过上传大小限制");
                try {
                    documentBatchBytes = Math.addExact(documentBatchBytes, file.getSize());
                } catch (ArithmeticException error) {
                    throw new ServiceException("文档批次大小超过限制");
                }
                if (documentBatchBytes > maxDocumentBatchBytes) throw new ServiceException("文档批次大小超过限制");
            }
            if (Set.of("VIDEO", "IMAGE", "AUDIO").contains(mediaType)) {
                acquireMetadataSlot();
                try {
                    String kind = mediaType.toLowerCase(Locale.ROOT);
                    VerifiedMediaMetadataService.Metadata verified = verifiedMediaMetadataService.inspectUpload(file, kind);
                    requireCompleteMediaMetadata(mediaType, verified);
                    result.add(new UploadMetadata(mediaType, mediaMimeType(kind, verified.format()), 0, verified));
                } finally {
                    metadataSlots.release();
                }
            } else {
                TrustedFileMetadata inspected = inspect(file, mediaType);
                result.add(new UploadMetadata(mediaType, inspected.mimeType(), inspected.pageCount()));
            }
        }
        return result;
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public List<Map<String, Object>> registerUploads(Long workspaceId, List<OssUploadResponse> uploads,
                                                     List<UploadMetadata> metadata,
                                                     String uploadRequestId, String requestHash, Long userId) {
        Workspace workspace = accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR");
        if (uploads == null || uploads.isEmpty()) throw new ServiceException("上传结果不能为空");
        if (metadata == null || metadata.size() != uploads.size()) throw new ServiceException("上传文件元数据缺失");
        List<Map<String, Object>> result = new ArrayList<>();
        for (int i = 0; i < uploads.size(); i++) {
            OssUploadResponse upload = uploads.get(i);
            UploadMetadata inspected = metadata.get(i);
            String mediaType = normalizeMediaType(inspected.mediaType());
            if (upload == null || upload.getUrl() == null || upload.getUrl().isBlank()) throw new ServiceException("上传结果缺少存储地址");
            CanvasResource resource = new CanvasResource();
            resource.setProjectId(workspace.getProjectId());
            resource.setWorkspaceId(workspaceId);
            resource.setOwnerUserId(userId);
            resource.setSourceType("UPLOAD");
            if (uploadRequestId != null) {
                resource.setSourceId(uploadSourceId(workspaceId, userId, uploadRequestId, i));
            }
            resource.setMediaType(mediaType);
            resource.setStorageUrl(upload.getUrl());
            resource.setFileSize(upload.getFileSize());
            resource.setMimeType(inspected.mimeType());
            Map<String, Object> uploadMetadata = new LinkedHashMap<>();
            if ("VIDEO".equals(mediaType)) {
                VerifiedMediaMetadataService.Metadata video = inspected.verifiedMetadata();
                requireCompleteVideoMetadata(video);
                if (!Objects.equals(upload.getFileSize(), video.sizeBytes())) {
                    throw new ServiceException("视频上传文件大小不一致");
                }
                uploadMetadata.putAll(videoMetadata(video));
            }
            if ("IMAGE".equals(mediaType)) {
                VerifiedMediaMetadataService.Metadata image = inspected.verifiedMetadata();
                requireCompleteImageMetadata(image);
                if (!Objects.equals(upload.getFileSize(), image.sizeBytes())) {
                    throw new ServiceException("图片上传文件大小不一致");
                }
                uploadMetadata.putAll(imageMetadata(image));
            }
            if ("AUDIO".equals(mediaType)) {
                VerifiedMediaMetadataService.Metadata audio = inspected.verifiedMetadata();
                requireCompleteMediaMetadata(mediaType, audio);
                if (!Objects.equals(upload.getFileSize(), audio.sizeBytes())) {
                    throw new ServiceException("音频上传文件大小不一致");
                }
                uploadMetadata.putAll(audioMetadata(audio));
            }
            if ("DOCUMENT".equals(mediaType)) uploadMetadata.put("pageCount", inspected.pageCount());
            if (requestHash != null) uploadMetadata.put("uploadRequestHash", requestHash);
            resource.setMetadataJson(uploadMetadata.isEmpty() ? null : JSON.toJSONString(uploadMetadata));
            resource.setStatus("ACTIVE");
            canvasMapper.insertCanvasResource(resource);
            result.add(view(resource));
        }
        return result;
    }

    @Override
    public List<Map<String, Object>> recoverUploads(Long workspaceId, String uploadRequestId,
            String requestHash, int fileCount, Long userId) {
        accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR");
        if (uploadRequestId == null) return null;
        List<Map<String, Object>> recovered = new ArrayList<>(fileCount);
        for (int index = 0; index < fileCount; index++) {
            CanvasResource resource = canvasMapper.selectCanvasResourceBySource(workspaceId, "UPLOAD",
                    uploadSourceId(workspaceId, userId, uploadRequestId, index));
            if (resource == null) continue;
            String storedHash = resource.getMetadataJson() == null ? null
                    : JSON.parseObject(resource.getMetadataJson()).getString("uploadRequestHash");
            if (!Objects.equals(resource.getOwnerUserId(), userId) || !"ACTIVE".equals(resource.getStatus())
                    || !requestHash.equals(storedHash)) {
                throw new ServiceException("上传请求标识已被不同文件使用");
            }
            recovered.add(view(resource));
        }
        if (recovered.isEmpty()) return null;
        if (recovered.size() != fileCount) throw new ServiceException("上传请求登记不完整，请联系管理员处理");
        return recovered;
    }

    private static long uploadSourceId(Long workspaceId, Long userId, String requestId, int index) {
        String hex = sha256(workspaceId + ":" + userId + ":" + requestId + ":" + index);
        return Long.parseUnsignedLong(hex.substring(0, 15), 16) + 1;
    }

    @Override
    public List<CanvasResource> requireResources(Long workspaceId, List<Long> ids, Long userId) {
        accessService.requireWorkspace(workspaceId, userId, "OWNER", "EDITOR", "VIEWER");
        if (ids == null || ids.isEmpty()) return List.of();
        LinkedHashSet<Long> unique = new LinkedHashSet<>(ids);
        if (unique.size() != ids.size() || unique.contains(null)) throw new ServiceException("素材编号不能为空或重复");
        List<CanvasResource> resources = canvasMapper.selectCanvasResources(workspaceId, new ArrayList<>(unique));
        if (resources.size() != unique.size()) throw new ServiceException("素材不存在或不属于当前工作区");
        Map<Long, CanvasResource> indexed = new LinkedHashMap<>();
        resources.forEach(resource -> indexed.put(resource.getId(), resource));
        return ids.stream().map(indexed::get).toList();
    }

    /** 显式准备操作在事务外探测，只对仍然相同的资源以 CAS 保存结果。报价始终只读。 */
    @Override
    public Map<String, Object> prepareMetadata(CanvasRequests.ResourceMetadataPrepare request, Long userId) {
        CanvasResource original = requireEditableMedia(request, userId);
        if (completePreparedMetadata(original)) return metadataView(original);
        acquireMetadataSlot();
        VerifiedMediaMetadataService.Metadata inspected;
        try {
            String kind = original.getMediaType().toLowerCase(Locale.ROOT);
            inspected = verifiedMediaMetadataService.inspect(original.getStorageUrl(), kind);
            requireCompleteMediaMetadata(original.getMediaType(), inspected);
        } finally {
            metadataSlots.release();
        }
        CanvasResource current = requireEditableMedia(request, userId);
        if (!sameResource(original, current)) throw metadataChanged();
        if (completePreparedMetadata(current)) return metadataView(current);
        String expectedMetadata = current.getMetadataJson();
        Map<String, Object> metadata = parseMetadata(expectedMetadata);
        metadata.putAll(switch (current.getMediaType()) {
            case "VIDEO" -> videoMetadata(inspected);
            case "AUDIO" -> audioMetadata(inspected);
            default -> imageMetadata(inspected);
        });
        current.setMetadataJson(JSON.toJSONString(metadata));
        current.setFileSize(inspected.sizeBytes());
        current.setMimeType(mediaMimeType(current.getMediaType().toLowerCase(Locale.ROOT), inspected.format()));
        if (canvasMapper.updateCanvasResourceMetadata(current, expectedMetadata) != 1) {
            CanvasResource raced = requireEditableMedia(request, userId);
            if (sameResource(original, raced) && completePreparedMetadata(raced)) return metadataView(raced);
            throw metadataChanged();
        }
        return metadataView(current);
    }

    private CanvasResource requireEditableMedia(CanvasRequests.ResourceMetadataPrepare request, Long userId) {
        Workspace workspace = accessService.requireWorkspace(request.getWorkspaceId(), userId, "OWNER", "EDITOR");
        CanvasResource resource = canvasMapper.selectCanvasResource(request.getResourceId());
        if (resource == null || !Objects.equals(resource.getWorkspaceId(), workspace.getId())
                || !Objects.equals(resource.getProjectId(), workspace.getProjectId())
                || !"ACTIVE".equals(resource.getStatus())
                || !Set.of("IMAGE", "VIDEO", "AUDIO").contains(resource.getMediaType())
                || !mediaUrlResolver.isSiteMediaUrl(resource.getStorageUrl())) {
            throw new ServiceException("媒体素材不存在、不可编辑或尚未完成本站存储");
        }
        return resource;
    }

    private static boolean sameResource(CanvasResource left, CanvasResource right) {
        return Objects.equals(left.getId(), right.getId())
                && Objects.equals(left.getWorkspaceId(), right.getWorkspaceId())
                && Objects.equals(left.getProjectId(), right.getProjectId())
                && Objects.equals(left.getOwnerUserId(), right.getOwnerUserId())
                && Objects.equals(left.getStorageUrl(), right.getStorageUrl());
    }

    private void acquireMetadataSlot() {
        if (!metadataSlots.tryAcquire()) {
            ApiErrorDetails details = new ApiErrorDetails();
            details.setErrorCode("CANVAS_RESOURCE_METADATA_PREPARATION_BUSY");
            details.setRetryable(false);
            throw new ServiceException("媒体信息正在准备，请稍后重试", 409).setClientErrorData(details);
        }
    }

    private static ServiceException metadataChanged() {
        ApiErrorDetails details = new ApiErrorDetails();
        details.setErrorCode("CANVAS_RESOURCE_METADATA_CHANGED");
        details.setRetryable(false);
        return new ServiceException("素材已变更，请重新选择后报价", 409).setClientErrorData(details);
    }

    private static Map<String, Object> parseMetadata(String value) {
        if (blank(value)) return new LinkedHashMap<>();
        try {
            Map<String, Object> metadata = JSON.parseObject(value, LinkedHashMap.class);
            return metadata == null ? new LinkedHashMap<>() : metadata;
        } catch (RuntimeException invalid) {
            return new LinkedHashMap<>();
        }
    }

    private static boolean completeVideoMetadata(CanvasResource resource) {
        Map<String, Object> metadata = parseMetadata(resource.getMetadataJson());
        return positive(metadata.get("durationSeconds")) && positive(metadata.get("width"))
                && positive(metadata.get("height")) && positive(metadata.get("fps"))
                && positive(resource.getFileSize()) && validVideoFormat(metadata.get("format"));
    }

    private static boolean completeImageMetadata(CanvasResource resource) {
        Map<String, Object> metadata = parseMetadata(resource.getMetadataJson());
        return positiveImageDimension(metadata.get("width")) && positiveImageDimension(metadata.get("height"))
                && positive(resource.getFileSize()) && validVideoFormat(metadata.get("format"))
                && resource.getMimeType() != null
                && resource.getMimeType().trim().toLowerCase(Locale.ROOT).startsWith("image/");
    }

    private static boolean completePreparedMetadata(CanvasResource resource) {
        if (resource == null) return false;
        return switch (resource.getMediaType()) {
            case "VIDEO" -> completeVideoMetadata(resource);
            case "IMAGE" -> completeImageMetadata(resource);
            case "AUDIO" -> {
                Map<String, Object> metadata = parseMetadata(resource.getMetadataJson());
                yield positive(metadata.get("durationSeconds")) && validVideoFormat(metadata.get("format"))
                        && positive(resource.getFileSize());
            }
            default -> false;
        };
    }

    private static boolean positive(Object value) {
        try { return value != null && new BigDecimal(value.toString()).signum() > 0; }
        catch (NumberFormatException invalid) { return false; }
    }

    private static boolean positiveImageDimension(Object value) {
        try {
            if (value == null) return false;
            BigDecimal number = new BigDecimal(value.toString()).stripTrailingZeros();
            return number.signum() > 0 && number.scale() <= 0
                    && number.compareTo(BigDecimal.valueOf(Integer.MAX_VALUE)) <= 0;
        } catch (NumberFormatException invalid) {
            return false;
        }
    }

    private static boolean validVideoFormat(Object value) {
        return value instanceof String text && text.matches("[a-z0-9][a-z0-9_-]{0,31}");
    }

    private static void requireCompleteVideoMetadata(VerifiedMediaMetadataService.Metadata video) {
        if (video == null || video.sizeBytes() <= 0 || !positive(video.durationSeconds())
                || video.width() <= 0 || video.height() <= 0 || !positive(video.fps())
                || !validVideoFormat(video.format())) throw new ServiceException("视频元数据不完整，无法准备报价");
    }

    private static void requireCompleteImageMetadata(VerifiedMediaMetadataService.Metadata image) {
        if (image == null || image.sizeBytes() <= 0 || image.width() <= 0 || image.height() <= 0
                || !validVideoFormat(image.format())) throw new ServiceException("图片元数据不完整，无法准备报价");
    }

    private static void requireCompleteMediaMetadata(String mediaType, VerifiedMediaMetadataService.Metadata media) {
        switch (mediaType) {
            case "VIDEO" -> requireCompleteVideoMetadata(media);
            case "IMAGE" -> requireCompleteImageMetadata(media);
            case "AUDIO" -> {
                if (media == null || media.sizeBytes() <= 0 || !positive(media.durationSeconds())
                        || !validVideoFormat(media.format())) throw new ServiceException("音频元数据不完整");
            }
            default -> throw new IllegalArgumentException("Unsupported verified media type");
        }
    }

    private static Map<String, Object> audioMetadata(VerifiedMediaMetadataService.Metadata audio) {
        return Map.of("durationSeconds", audio.durationSeconds(), "format", audio.format(), "sizeBytes", audio.sizeBytes());
    }

    private static Map<String, Object> imageMetadata(VerifiedMediaMetadataService.Metadata image) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("width", image.width());
        result.put("height", image.height());
        result.put("format", image.format());
        result.put("sizeBytes", image.sizeBytes());
        if (!blank(image.codec())) result.put("codec", image.codec());
        return result;
    }

    private static Map<String, Object> videoMetadata(VerifiedMediaMetadataService.Metadata video) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("durationSeconds", video.durationSeconds());
        result.put("width", video.width());
        result.put("height", video.height());
        result.put("fps", video.fps());
        result.put("format", video.format());
        result.put("sizeBytes", video.sizeBytes());
        if (!blank(video.codec())) result.put("codec", video.codec());
        return result;
    }

    private static String videoMimeType(String format) {
        return switch (format) {
            case "mp4" -> "video/mp4";
            case "mov" -> "video/quicktime";
            case "webm" -> "video/webm";
            case "matroska" -> "video/x-matroska";
            case "avi" -> "video/x-msvideo";
            default -> "video/" + format;
        };
    }

    private static String mediaMimeType(String kind, String format) {
        if ("video".equals(kind)) return videoMimeType(format);
        if ("audio".equals(kind)) return switch (format) {
            case "mp3" -> "audio/mpeg";
            case "m4a" -> "audio/mp4";
            default -> "audio/" + format;
        };
        return "image/" + switch (format) {
            case "jpeg" -> "jpeg";
            case "heif" -> "heif";
            case "tiff" -> "tiff";
            default -> format;
        };
    }

    private ResolvedSource resolveAssetCenter(AssetCenterCategoryEnum category, Long sourceId, Long userId) {
        String mediaType = switch (category) {
            case ROLE_IMAGE, SCENE_IMAGE, PROP_IMAGE, STORYBOARD_IMAGE -> "IMAGE";
            case STORYBOARD_VIDEO, PREVIEW_VIDEO -> "VIDEO";
            default -> throw new ServiceException("此资产中心分类不包含可登记图片或视频");
        };
        AssetCenterDetailRequest detailRequest = new AssetCenterDetailRequest();
        detailRequest.setCategoryCode(category.getCode());
        detailRequest.setId(sourceId);
        AssetCenterDetailVO detail = assetCenterService.detail(detailRequest, userId);
        Map<String, Object> content = detail.getContent() == null ? Map.of() : detail.getContent();
        boolean completed = switch (category) {
            case ROLE_IMAGE, SCENE_IMAGE, PROP_IMAGE -> "completed".equals(content.get("imageStatus"));
            case STORYBOARD_IMAGE, STORYBOARD_VIDEO -> "1".equals(String.valueOf(content.get("status")));
            case PREVIEW_VIDEO -> "2".equals(String.valueOf(content.get("exportStatus")));
            default -> false;
        };
        String url = "VIDEO".equals(mediaType) ? detail.getVideoUrl() : detail.getImageUrl();
        if (!completed || blank(url)) throw new ServiceException("素材尚未完成，无法登记到画布");
        return new ResolvedSource(mediaType, url, null, userId);
    }

    private ResolvedSource resolve(String sourceType, Long sourceId, Workspace workspace, Long userId) {
        return switch (sourceType) {
            case "USER_ASSET" -> {
                AidUserComicAsset asset = userAssetMapper.selectById(sourceId);
                if (asset == null || !Objects.equals(asset.getUserId(), userId) || !"0".equals(asset.getDelFlag())
                        || !"0".equals(asset.getStatus()) || blank(asset.getImageUrl())) throw new ServiceException("用户素材不存在或无权使用");
                yield new ResolvedSource("IMAGE", asset.getImageUrl(), null, asset.getUserId());
            }
            case "OFFICIAL_ASSET" -> {
                AidComicAsset asset = officialAssetMapper.selectById(sourceId);
                if (asset == null || !"0".equals(asset.getDelFlag()) || blank(asset.getImageUrl())) throw new ServiceException("公共素材不存在或已删除");
                yield new ResolvedSource("IMAGE", asset.getImageUrl(), null, userId);
            }
            case "AUDIO_ASSET" -> {
                AidAudioAsset asset = audioAssetMapper.selectById(sourceId);
                if (asset == null || !Objects.equals(asset.getUserId(), userId) || !"0".equals(asset.getDelFlag())
                        || blank(asset.getAudioUrl())) throw new ServiceException("音频素材不存在或无权使用");
                yield new ResolvedSource("AUDIO", asset.getAudioUrl(), asset.getFileSize(), asset.getUserId());
            }
            case "MEDIA_TASK" -> {
                AidMediaTask task = mediaTaskMapper.selectById(sourceId);
                boolean sameActor = task != null && Objects.equals(task.getUserId(), userId);
                boolean sameProject = task != null && Objects.equals(task.getProjectId(), workspace.getProjectId());
                String url = task == null || CanvasImageEditTaskGuard.isProtectionPending(task)
                        ? null : firstNonBlank(task.getOssUrl(), task.getOriginUrl());
                if (task == null || !"SUCCEEDED".equals(task.getStatus()) || (!sameActor && !sameProject) || blank(url)) {
                    throw new ServiceException("媒体任务结果不存在或无权使用");
                }
                yield new ResolvedSource(normalizeMediaType(task.getMediaType()), url, null, task.getUserId());
            }
            case "MEDIA_RESULT" -> {
                AidMediaResult mediaResult = mediaResultMapper.selectById(sourceId);
                AidMediaTask task = mediaResult == null ? null : mediaTaskMapper.selectById(mediaResult.getTaskId());
                boolean sameActor = task != null && Objects.equals(task.getUserId(), userId);
                boolean sameProject = task != null && Objects.equals(task.getProjectId(), workspace.getProjectId());
                String url = mediaResult == null || CanvasImageEditTaskGuard.isProtectionPending(task)
                        ? null : mediaResult.getOssUrl();
                if (mediaResult == null || task == null || !"SUCCEEDED".equals(task.getStatus())
                        || (!sameActor && !sameProject) || blank(url)) {
                    throw new ServiceException("媒体结果不存在、尚未持久化或无权使用");
                }
                yield new ResolvedSource(normalizeMediaType(mediaResult.getMediaType()), url,
                        mediaResult.getFileSize(), task.getUserId());
            }
            default -> throw new ServiceException("不支持的素材来源类型");
        };
    }

    private static Map<String, Object> view(CanvasResource resource) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("resourceId", JsonSafeId.value(resource.getId()));
        result.put("workspaceId", JsonSafeId.value(resource.getWorkspaceId()));
        result.put("sourceType", resource.getSourceType());
        result.put("sourceId", JsonSafeId.value(resource.getSourceId()));
        result.put("ownerUserId", JsonSafeId.value(resource.getOwnerUserId()));
        result.put("mediaType", resource.getMediaType());
        result.put("resourceUrl", com.aid.canvas.runtime.CanvasModelAccessUrl.resolve(resource.getId(),resource.getStorageUrl(),resource.getMediaType()));
        result.put("fileSize", resource.getFileSize());
        result.put("mimeType", resource.getMimeType());
        result.put("metadata", resource.getMetadataJson() == null ? Map.of() : JSON.parseObject(resource.getMetadataJson()));
        result.put("status", resource.getStatus());
        return result;
    }

    /** This new endpoint has a strict string-ID response contract for every ID size. */
    private static Map<String, Object> metadataView(CanvasResource resource) {
        Map<String, Object> result = view(resource);
        result.put("resourceId", resource.getId().toString());
        result.put("workspaceId", resource.getWorkspaceId().toString());
        return result;
    }

    private static String normalizeMediaType(String value) {
        String normalized = value == null ? "" : value.trim().toUpperCase();
        if (!Set.of("IMAGE", "VIDEO", "AUDIO", "DOCUMENT").contains(normalized)) {
            throw new ServiceException("mediaType 类型不支持");
        }
        return normalized;
    }
    private static boolean blank(String value) { return value == null || value.isBlank(); }
    private static String firstNonBlank(String first, String second) { return blank(first) ? second : first; }
    private static String sha256(String value) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private static TrustedFileMetadata inspect(MultipartFile file, String mediaType) {
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase();
        String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        if (!"DOCUMENT".equals(mediaType)) {
            return new TrustedFileMetadata(null, 0);
        }
        try {
            return switch (extension) {
                case "pdf" -> {
                    try (InputStream input = file.getInputStream()) {
                        byte[] magic = input.readNBytes(5);
                        if (magic.length < 5 || magic[0] != '%' || magic[1] != 'P' || magic[2] != 'D'
                                || magic[3] != 'F' || magic[4] != '-') {
                            throw new ServiceException("PDF 文件内容无效");
                        }
                    }
                    Path temporary = Files.createTempFile("canvas-document-", ".pdf");
                    try {
                        try (InputStream input = file.getInputStream()) {
                            Files.copy(input, temporary, StandardCopyOption.REPLACE_EXISTING);
                        }
                        try (PDDocument document = Loader.loadPDF(temporary.toFile())) {
                            yield new TrustedFileMetadata("application/pdf", document.getNumberOfPages());
                        }
                    } finally {
                        Files.deleteIfExists(temporary);
                    }
                }
                case "txt" -> new TrustedFileMetadata("text/plain", 1);
                default -> throw new ServiceException("文档格式不支持");
            };
        } catch (ServiceException error) {
            throw error;
        } catch (Exception error) {
            throw new ServiceException("文档元数据解析失败");
        }
    }
    private static void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { action.run(); }
            });
        } else action.run();
    }
    private record ResolvedSource(String mediaType, String url, Long fileSize, Long ownerUserId) { }
    private record TrustedFileMetadata(String mimeType, int pageCount) { }
}
