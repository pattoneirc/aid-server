package com.aid.director.dto;

import com.alibaba.fastjson2.JSONObject;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;
import lombok.Data;
import lombok.EqualsAndHashCode;
import java.util.List;

/** 场景、配对及录制请求。 */
public final class DirectorRequests {
    private DirectorRequests() { }

    public abstract static class Input {
        @com.fasterxml.jackson.annotation.JsonAnySetter
        public void rejectUnknown(String key, Object value) { throw com.aid.director.DirectorException.invalid(); }
    }

    @lombok.EqualsAndHashCode(callSuper = false)
    @Data
    public static class Scope extends Input {
        @NotBlank private String projectId;
        private String workspaceId;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class SceneKey extends Scope {
        @NotBlank @Size(max = 64) private String sceneId;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class SceneSave extends SceneKey {
        @NotBlank @Size(max = 64) private String requestId;
        @NotNull @Min(0) private Long expectedRevision;
        @NotBlank @Size(max = 100) private String name;
        @NotNull private JSONObject scene;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class SceneDelete extends SceneKey {
        @NotBlank @Size(max = 64) private String requestId;
        @NotNull @Min(1) private Long expectedRevision;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class SceneList extends Scope {
        private String cursor;
        @Min(1) @Max(100) private int pageSize = 20;
    }

    @lombok.EqualsAndHashCode(callSuper = false)
    @Data
    public static class Session extends Input {
        @NotBlank @Size(max = 64) private String sessionId;
        @Size(max = 64) private String requestId;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Create extends SceneKey {
        @NotBlank @Size(max = 64) private String requestId;
        @NotBlank @Size(max = 64) private String cameraId;
        @NotNull @Min(1) @Max(1) private Integer protocolVersion;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Join extends Session {
        @NotBlank @Size(min = 43, max = 43) private String pairingCode;
        @Size(max = 50) private String deviceName;
        @NotNull @Min(1) @Max(1) private Integer protocolVersion;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Action extends Session {
        @NotBlank private String expectedRoomEpoch;
        @NotNull @Min(0) private Long expectedStateVersion;
        @NotBlank private String action;
        @Size(max = 64) private String cameraId;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Negotiate extends Session {
        @NotNull @Min(0) private Long expectedPeerEpoch;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Lease extends Session {
        @NotNull @Min(1) private Long peerEpoch;
        @NotNull @Min(1) private Long bindingEpoch;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class RecordingControl extends Session {
        @NotBlank @Size(max = 64) private String commandId;
        @NotBlank private String action;
        private String takeId;
        @NotNull @Min(1) private Long peerEpoch;
        @NotNull @Min(1) private Long bindingEpoch;
    }

    @lombok.EqualsAndHashCode(callSuper = false)
    @Data
    public static class TakeKey extends Input {
        @NotBlank private String takeId;
        @Size(max = 64) private String requestId;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Confirm extends TakeKey {
        @NotBlank private String result;
        @NotBlank private String commandId;
        @NotNull @Min(1) private Long contextVersion;
    }

    @lombok.EqualsAndHashCode(callSuper = false)
    @Data
    public static class Sample extends Input {
        @NotNull @Min(0) @com.fasterxml.jackson.annotation.JsonProperty("tMs")
        @com.alibaba.fastjson2.annotation.JSONField(name = "tMs") private Long tMs;
        @NotNull @Size(min = 3, max = 3) private List<Double> position;
        @NotNull @Size(min = 3, max = 3) private List<Double> target;
        @NotNull private Double fov;
        @NotNull private Double roll;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Chunk extends TakeKey {
        @NotNull @Min(1) private Long contextVersion;
        @NotNull @Min(0) private Integer chunkNo;
        @NotNull @Min(0) private Long firstFrameSeq;
        @NotNull @Min(0) private Long lastFrameSeq;
        @NotNull @Size(min = 1, max = 300)
        @jakarta.validation.Valid private List<Sample> samples;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Finalize extends TakeKey {
        @NotNull @Min(1) private Long contextVersion;
        @NotNull @Min(0) private Integer expectedLastChunkNo;
        @NotNull @Min(2) @Max(18000) private Integer expectedFrameCount;
        @NotBlank private String mode;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Apply extends TakeKey {
        @NotNull @Min(1) private Long contextVersion;
        @NotNull @Min(1) private Long expectedSceneRevision;
        @NotNull @Min(0) @Max(86400000) private Long timelineStartMs;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Recover extends TakeKey {
        @NotNull @Min(1) private Long expectedContextVersion;
        @NotBlank private String sessionId;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class TakeList extends SceneKey {
        private String cursor;
        @Min(1) @Max(100) private int pageSize = 20;
    }

    @Data @EqualsAndHashCode(callSuper = true)
    public static class Read extends TakeKey {
        @Min(0) private int chunkCursor;
    }
}
