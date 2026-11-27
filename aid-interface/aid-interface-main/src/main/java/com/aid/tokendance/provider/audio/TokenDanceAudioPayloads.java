package com.aid.tokendance.provider.audio;

import cn.hutool.core.util.StrUtil;
import com.aid.common.exception.ServiceException;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.dto.MediaAudioGenerateRequest;
import com.aid.media.util.WaveAudioAssembler;
import com.aid.tokendance.provider.common.TokenDancePayloadSupport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** TokenDance 音频协议字段映射与 SSE 解码；不复用其他供应商的默认鉴权和路由。 */
public final class TokenDanceAudioPayloads {
    private static final Set<String> ARK_FORMATS = Set.of("mp3", "wav", "pcm", "ogg_opus");
    private static final int MAX_AUDIO_BYTES = 64 * 1024 * 1024;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private TokenDanceAudioPayloads() { }

    public static void validate(AiModelConfigVo config, MediaAudioGenerateRequest request) {
        if (!"tokendance".equalsIgnoreCase(config.getProviderCode())) return;
        String protocol = config.getProtocol();
        if (request.isPreviewMode()) throw new ServiceException("请创建试听任务");
        if ("tokendance:openai:chat-completions".equals(protocol)) {
            TokenDanceMimoAudioSupport.validate(config, request);
            return;
        }
        if ("tokendance:ark:tts_ws".equals(protocol)) {
            TokenDanceWebSocketAudioSupport.validate(config, request);
            return;
        }
        if (!"tokendance:ark:tts".equals(protocol)) throw new ServiceException("配音协议未核验");
        String format = StrUtil.blankToDefault(request.getAudioFormat(), "mp3");
        if (!ARK_FORMATS.contains(format)) throw new ServiceException("音频格式不支持");
        if (StrUtil.isBlank(request.getTtsText()) || StrUtil.isBlank(request.getVoiceCode())) throw new ServiceException("配音参数不完整");
        // 已存在的正式任务校验还会校验语速、音量、音调与采样率；Provider 重复调用时同样保护。
        range(request.getSpeechRate(), -50, 100, "语速无效");
        range(request.getLoudnessRate(), -50, 100, "音量无效");
        range(request.getPitch(), -12, 12, "音调无效");
        if (StrUtil.isNotBlank(request.getEmotion())) {
            // 声音情感受具体音色控制；不能在未核验时假装按通用字段发送。
            throw new ServiceException("音色情感未核验");
        }
        if (request.getEmotionScale() != null) throw new ServiceException("音色情感未核验");
        if (request.getSampleRate() != null
                && !Set.of(8000, 16000, 22050, 24000, 32000, 44100, 48000).contains(request.getSampleRate())) {
            throw new ServiceException("采样率不支持");
        }
        if (Boolean.TRUE.equals(request.getEnableTimestamp())) throw new ServiceException("字幕回传尚未接通");
        Map<String, Object> options = request.getOptions();
        if (options != null) {
            TokenDancePayloadSupport.rejectUnknownRequestOptions(config, options, Set.of("silenceDurationMs"));
            if (options.get("silenceDurationMs") != null) {
                try { range(Integer.valueOf(String.valueOf(options.get("silenceDurationMs"))), 0, 30000, "静音时长无效"); }
                catch (NumberFormatException ex) { throw new ServiceException("静音时长无效"); }
            }
        }
    }

    public static Map<String, Object> ark(AiModelConfigVo config, MediaAudioGenerateRequest request) {
        validate(config, request);
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("text", request.getTtsText());
        params.put("speaker", request.getVoiceCode());
        Map<String, Object> audio = new LinkedHashMap<>();
        audio.put("format", StrUtil.blankToDefault(request.getAudioFormat(), "mp3"));
        audio.put("sample_rate", request.getSampleRate() == null ? 24000 : request.getSampleRate());
        if (request.getSpeechRate() != null) audio.put("speech_rate", request.getSpeechRate());
        if (request.getLoudnessRate() != null) audio.put("loudness_rate", request.getLoudnessRate());
        params.put("audio_params", audio);
        Map<String, Object> additions = new LinkedHashMap<>();
        if (request.getPitch() != null) additions.put("post_process", Map.of("pitch", request.getPitch()));
        if (request.getOptions() != null && request.getOptions().get("silenceDurationMs") != null) {
            try {
                int silence = Integer.parseInt(String.valueOf(request.getOptions().get("silenceDurationMs")));
                range(silence, 0, 30000, "静音时长无效");
                additions.put("silence_duration", silence);
            } catch (NumberFormatException ex) { throw new ServiceException("静音时长无效"); }
        }
        if (!additions.isEmpty()) params.put("additions", stringify(additions));
        return com.aid.model.definition.ModelConfiguredRequestBody.apply(config, Map.of("req_params", params), request);
    }

    /** SSE 必须包含官方成功终态；断流即使收到音频也不能作为成功。 */
    public static DecodedAudio decodeArkSse(String response) {
        WaveAudioAssembler audio = new WaveAudioAssembler();
        boolean completed = false;
        JsonNode terminal = MAPPER.createObjectNode();
        try {
            StringBuilder event = new StringBuilder();
            String normalized = response == null ? "" : response.replace("\r\n", "\n");
            for (String line : (normalized + "\n\n").split("\n", -1)) {
                if (line.startsWith("data:")) {
                    if (!event.isEmpty()) event.append('\n');
                    event.append(line.substring(5).stripLeading());
                } else if (line.isEmpty() && !event.isEmpty()) {
                    JsonNode frame = MAPPER.readTree(event.toString());
                    event.setLength(0);
                    int code = frame.path("code").asInt(-1);
                    if (code == 20000000) { completed = true; terminal = frame; break; }
                    if (code != 0) throw new ServiceException("语音合成失败");
                    String encoded = frame.path("data").asText();
                    if (!encoded.isEmpty()) {
                        if (encoded.length() > MAX_AUDIO_BYTES * 2L) throw new ServiceException("音频响应过大");
                        byte[] chunk = Base64.getDecoder().decode(encoded);
                        if (audio.size() + (long) chunk.length > MAX_AUDIO_BYTES) throw new ServiceException("音频响应过大");
                        audio.append(chunk);
                    }
                }
            }
            if (!completed || audio.size() == 0) throw new ServiceException("音频响应未完成");
            return new DecodedAudio(audio.finish(), terminal);
        } catch (ServiceException ex) { throw ex; }
        catch (Exception ex) { throw new ServiceException("音频响应无效"); }
    }

    public record DecodedAudio(byte[] bytes, JsonNode terminal) {
        @Override public String toString() { return "DecodedAudio[bytes=" + bytes.length + "]"; }
    }

    private static void range(Integer value, int min, int max, String message) {
        if (value != null && (value < min || value > max)) throw new ServiceException(message);
    }

    private static String stringify(Object object) {
        try { return MAPPER.writeValueAsString(object); }
        catch (Exception ex) { throw new ServiceException("音频参数无效"); }
    }

}
