package com.aid.storyboard.dto;

import java.util.List;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import lombok.Data;

/**
 * 发起配音任务请求DTO
 *
 * @author 视觉AID
 */
@Data
public class GenerateAudioRequest {

    /** 分镜ID */
    @NotNull(message = "分镜ID不能为空")
    private Long storyboardId;

    /** 需要配音的文字 */
    @NotBlank(message = "配音文字不能为空")
    private String ttsText;

    /**
     * 配音大模型ID（兼容老入参）。
     * 新链路推荐传 {@link #voiceLibraryId} 由后端反查；老入参仍支持，此时 {@link #voiceLibraryId} 可为空。
     */
    private Long voiceModelId;

    /**
     * 音色编码（兼容老入参，等价于厂商侧 voice_code）。
     * 新链路推荐用 {@link #voiceLibraryId} 反查；两者同时存在时以 voiceLibraryId 为准。
     */
    private String timbreCode;

    /**
     * 音色库记录ID。
     * 若传入该字段，后端优先按 aid_ai_voice_library 反查并使用其 model_id / voice_code，
     * 同时会按音色库的启用 / 下架时间做强校验。
     */
    private Long voiceLibraryId;

    /** 情感（可选，如 happy / sad），仅在音色支持情感时生效 */
    private String emotion;

    /** 情感强度（可选，1~5，默认 4） */
    @Min(value = 1, message = "情感强度无效")
    @Max(value = 5, message = "情感强度无效")
    private Integer emotionScale;

    /** 语速（可选，[-50,100]） */
    @Min(value = -50, message = "语速无效")
    @Max(value = 100, message = "语速无效")
    private Integer speechRate;

    /** 音量（可选，[-50,100]） */
    @Min(value = -50, message = "音量无效")
    @Max(value = 100, message = "音量无效")
    private Integer loudnessRate;

    /** 音调（可选，[-12,12]） */
    @Min(value = -12, message = "音调无效")
    @Max(value = 12, message = "音调无效")
    private Integer pitch;

    /** 音频编码格式（可选，默认 mp3） */
    @Pattern(regexp = "(?i)mp3|wav|pcm|ogg_opus|opus|flac", message = "音频格式无效")
    private String audioFormat;

    /** 音频采样率（可选，默认 24000） */
    @Min(value = 8000, message = "采样率无效")
    @Max(value = 48000, message = "采样率无效")
    private Integer sampleRate;
}
