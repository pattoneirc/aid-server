package com.aid.assistant.artifact.vo;

import com.aid.assistant.vo.AssistantTargetViews;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

public final class ArtifactViews {
    private ArtifactViews() {
    }

    @Data
    public static class Page<T> {
        private List<T> items = new ArrayList<>();
        private String nextCursor;
    }

    @Data
    public static class Summary {
        private String artifactId;
        private String presentationRole;
        private String logicalArtifactId;
        private Long revision;
        private String artifactType;
        private String schemaVersion;
        private String contentHash;
        private String reviewStatus;
        private String summary;
        private String status;
        private String producerRunId;
        private String producerStepId;
        private Object metadata;
        private String createdAt;
        private AssistantTargetViews.TargetEffect latestTargetEffect;
    }

    @lombok.EqualsAndHashCode(callSuper = false)
    @Data
    public static class Detail extends Summary {
        private Long parentRevision;
        private String sourceContextDigest;
        private Object sourceContextRefs;
        private String resourceId;
        private String fileId;
        private Object resourceRef;
        private Integer chunkCount;
        private Integer charCount;
        private Integer wordCount;
        private String agentVersionId;
        private Long planRevision;
    }

    @Data
    public static class Chunk {
        private Integer chunkIndex;
        private Integer charStart;
        private Integer charEnd;
        private Integer charCount;
        private Integer wordCount;
        private String contentHash;
        private String content;
    }

    @Data
    public static class ContentPage {
        private String artifactId;
        private String contentHash;
        private List<Chunk> chunks = new ArrayList<>();
        private Integer nextAfterChunkIndex;
        private boolean complete;
    }

    @Data
    public static class Media {
        private String artifactId;
        private String artifactType;
        private String mediaTaskId;
        private Integer resultIndex;
        private String resourceUrl;
        private String mimeType;
        private Long fileSize;
        private Long durationSeconds;
        private String archiveStatus;
        private String contentHash;
        private String contentHashKind;
        private boolean creativeQualityVerified;
    }

    @Data
    public static class Review {
        private String reviewId;
        private String reviewArtifactId;
        private String verdict;
        private Object severityCounts;
        private String contentHash;
        private String createdAt;
    }

    @Data
    public static class CoverageProgress {
        private String sourceRevisionId;
        private Integer totalChunks;
        private Integer coveredChunks;
        private List<Coverage> items = new ArrayList<>();
        private String nextCursor;
    }

    @Data
    public static class SourceRevision {
        private String sourceRevisionId;
        private String sourceKind;
        private String sourceObjectId;
        private String sourceRevision;
        private String contentHash;
        private Integer charCount;
        private Integer wordCount;
        private Integer chunkCount;
        private String status;
        private String createdAt;
    }

    @Data
    public static class SourceManifest {
        private String runId;
        private String contextDigest;
        private Long runRevision;
        private String runStatus;
        private List<String> allowedActions = new ArrayList<>();
        private List<SourceManifestItem> items = new ArrayList<>();
    }

    @Data
    public static class SourceManifestItem {
        private String documentId;
        private String kind;
        private String scriptId;
        private String projectId;
        private String episodeId;
        private String version;
        private String contentHash;
        private Object selection;
        private String access;
        private String sourceRevisionId;
        private String snapshotStatus;
        private String nextAction;
    }

    @Data
    public static class Coverage {
        private String coverageId;
        private String sourceRevisionId;
        private Integer chunkIndex;
        private String purpose;
        private String coverageStatus;
        private String evidenceArtifactId;
        private Long revision;
        private String notes;
        private String updatedAt;
    }

    @Data
    public static class Adoption {
        private String adoptionId;
        private String artifactId;
        private String targetKind;
        private String targetObjectId;
        private String targetRevision;
        private String status;
        private Object receipt;
    }

    @Data
    public static class AdoptionCapabilities {
        private String artifactId;
        private List<AdoptionCapability> targets = new ArrayList<>();
    }

    @Data
    public static class AdoptionCapability {
        private String targetKind;
        private String targetObjectId;
        private String currentTargetRevision;
        private boolean allowed;
        private String reasonCode;
        private String displayName;
        private Object requiredContext;
    }
}
