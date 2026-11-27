package com.aid.runtime.legacy.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

public final class LegacyRuntimeAgentRequests {
    public static final String ADMIN_FAMILY_HEADER = "X-Aid-Runtime-Agent-Family";
    public static final String LEGACY_PLAN = "LEGACY_PLAN";

    private LegacyRuntimeAgentRequests() { }

    @Data public static class Page {
        @Min(1) private Integer pageNum = 1;
        @Min(1) @Max(100) private Integer pageSize = 20;
        @Size(max = 100) private String keyword;
        @Pattern(regexp = "0|1") private String status;
    }

    @Data public static class Id {
        @NotNull @Positive private Long id;
    }

    @Data public static class Create {
        @NotBlank @Pattern(regexp = "[a-z][a-z0-9._-]{1,63}") private String agentCode;
        @NotBlank @Size(max = 100) private String name;
        @Size(max = 1000) private String description;
        @Size(max = 500) private String iconUrl;
        @Pattern(regexp = "PUBLIC|PRIVATE") private String visibility = "PRIVATE";
        @Positive private Long templateVersionId;
    }

    @Data public static class Identity {
        @NotNull @Positive private Long id;
        @NotBlank @Size(max = 100) private String name;
        @Size(max = 1000) private String description;
        @Size(max = 500) private String iconUrl;
        @Pattern(regexp = "PUBLIC|PRIVATE") private String visibility;
    }

    @Data public static class Status {
        @NotNull @Positive private Long id;
        @NotBlank @Pattern(regexp = "0|1") private String status;
    }

    @Data public static class VersionPage {
        @NotNull @Positive private Long agentId;
        @Min(1) private Integer pageNum = 1;
        @Min(1) @Max(100) private Integer pageSize = 20;
    }

    @Data public static class DraftDetail {
        @NotNull @Positive private Long agentId;
        @Positive private Long baseVersionId;
    }

    @Data public static class Step {
        @NotBlank @Pattern(regexp = "[a-z][a-z0-9._-]{0,63}") private String stepKey;
        @NotBlank @Pattern(regexp = "MODEL|TOOL|SKILL") private String kind;
        @Size(max = 100) private String toolCode;
        @Size(max = 64) private String skillCode;
        @Size(max = 10000) private String instruction;
    }

    @Data public static class DraftPayload {
        @NotNull @Positive private Long agentId;
        @Positive private Long baseVersionId;
        @NotBlank @Size(max = 100000) private String instruction;
        @NotBlank @Pattern(regexp = "MODEL_PLAN|SKILL_ORCHESTRATOR")
        private String executorType = "MODEL_PLAN";
        @Size(max = 64) private String delegatedSkillCode;
        @NotBlank @Pattern(regexp = "TEXT|IMAGE|VIDEO") private String outputKind = "TEXT";
        @NotBlank @Size(max = 100) private String defaultModelCode;
        @Size(min = 1, max = 20) private List<@NotBlank String> selectableModelCodes = new ArrayList<>();
        @Size(max = 16) private List<@NotBlank String> allowedSkillCodes = new ArrayList<>();
        @Size(max = 16) private List<@NotBlank String> allowedToolCodes = new ArrayList<>();
        @Min(1) @Max(8) private Integer maxSteps = 4;
        @Min(1) @Max(12) private Integer maxTaskCount = 6;
        @Min(10) @Max(3600) private Integer maxDurationSeconds = 600;
        @Min(256) @Max(2000000) private Integer maxEstimatedTokens = 128000;
        private Boolean clarificationEnabled = Boolean.FALSE;
        @Valid @Size(max = 8) private List<@NotNull Step> steps = new ArrayList<>();
    }

    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class DraftSave extends DraftPayload {
        @Positive private Long draftId;
        @Pattern(regexp = "[0-9a-f]{64}") private String draftDigest;
    }

    @Data public static class Publish {
        @NotNull @Positive private Long draftId;
        @NotBlank @Pattern(regexp = "[0-9a-f]{64}") private String draftDigest;
        @NotBlank @Pattern(regexp = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")
        private String versionCode;
    }

    @Data public static class Activate {
        @NotNull @Positive private Long agentId;
        @NotNull @Positive private Long versionId;
        @Positive private Long expectedCurrentVersionId;
    }

    @Data public static class RunPage {
        @Positive private Long agentId;
        @Positive private Long userId;
        @Pattern(regexp = "CREATED|RUNNING|WAITING_INPUT|SUCCEEDED|FAILED|CANCELED") private String status;
        @Min(1) private Integer pageNum = 1;
        @Min(1) @Max(100) private Integer pageSize = 20;
    }
}
