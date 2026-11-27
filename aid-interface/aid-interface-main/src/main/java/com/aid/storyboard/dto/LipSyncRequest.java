package com.aid.storyboard.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

/**
 * 发起分镜对口型：使用已登记的上传录音，或先将分镜台词合成为音频。
 *
 * @author 视觉AID
 */
@Data
public class LipSyncRequest {

    /** 分镜ID */
    @NotNull(message = "分镜ID不能为空")
    private Long storyboardId;

    /** 已登记的本地录音 ID；存在时直接用原声驱动对口型。 */
    @Min(value = 1, message = "录音ID无效")
    private Long referenceAudioId;

    /** 兜底音色库ID（可选）：分镜台词解析不出「角色→绑定音色」时（纯旁白/角色未绑定）用此音色 TTS */
    private Long voiceLibraryId;

    /** 兜底配音模型ID（兼容老入参，与 timbreCode 成对使用；voiceLibraryId 存在时忽略） */
    private Long voiceModelId;

    /** 兜底音色编码（兼容老入参，与 voiceModelId 成对使用） */
    private String timbreCode;

    /** 情感（可选，供应商原生编码，仅音色支持情感时生效） */
    private String emotion;

    /** 情感强度（可选，1~5） */
    @Min(value = 1, message = "情感强度无效")
    @Max(value = 5, message = "情感强度无效")
    private Integer emotionScale;

    /** 语速偏移（可选，[-50,100]） */
    @Min(value = -50, message = "语速无效")
    @Max(value = 100, message = "语速无效")
    private Integer speechRate;

    /** 音量偏移（可选，[-50,100]） */
    @Min(value = -50, message = "音量无效")
    @Max(value = 100, message = "音量无效")
    private Integer loudnessRate;

    /** 语调偏移（可选，半音 [-12,12]） */
    @Min(value = -12, message = "音调无效")
    @Max(value = 12, message = "音调无效")
    private Integer pitch;
}
