package com.aid.tokendance.provider.audio;

import cn.hutool.core.util.StrUtil;
import com.aid.common.exception.ServiceException;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.dto.MediaAudioGenerateRequest;
import com.aid.media.provider.AudioProviderClient;
import com.aid.media.provider.ModelCodeResolver;
import com.aid.media.provider.ProviderSubmitResult;
import com.aid.media.provider.ProviderTaskResult;
import com.aid.media.util.AudioDurationProber;
import com.aid.voice.service.VoiceReferenceSampleService;
import com.aid.tokendance.provider.common.TokenDanceHttpResponse;
import com.aid.tokendance.provider.common.TokenDanceResponseMapper;
import com.aid.tokendance.provider.common.TokenDanceTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/** TokenDance 语音合成门面，处理方舟与 MiMo 音频协议。 */
@Component
@RequiredArgsConstructor
public class TokenDanceAudioProviderClient implements AudioProviderClient {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String ARK = "tokendance:ark:tts";
    private static final int MAX_SSE_BYTES = 96 * 1024 * 1024;
    private final TokenDanceTransport transport;
    private final VoiceReferenceSampleService referenceSamples;
    private final TokenDanceAudioRecoveryStore recoveryStore;

    @Override public String protocol() { return ARK; }
    @Override public boolean supportsProtocol(String protocol) { return Set.of(ARK, "tokendance:ark:tts_ws", "tokendance:openai:chat-completions").contains(protocol == null ? "" : protocol); }
    @Override public boolean supportsProviderCode(String code) { return "tokendance".equalsIgnoreCase(code == null ? "" : code.trim()); }
    @Override public boolean supportsModel(String name) { return false; }

    @Override
    public ProviderSubmitResult submit(AiModelConfigVo config, MediaAudioGenerateRequest request) {
        TokenDanceAudioPayloads.validate(config, request);
        if (request.isPreviewMode()) throw new ServiceException("请创建试听任务");
        try {
            if ("tokendance:ark:tts_ws".equals(config.getProtocol())) {
                return TokenDanceWebSocketAudioSupport.submit(config, request, recoveryStore);
            }
            if ("tokendance:openai:chat-completions".equals(config.getProtocol())) {
                VoiceReferenceSampleService.Sample sample = VoiceReferenceSampleService.isReferenceModel(config)
                        ? referenceSamples.forSubmission(request) : null;
                return TokenDanceMimoAudioSupport.submit(config, request, sample == null ? null : sample.bytes(),
                        sample == null ? null : sample.mime(), transport, recoveryStore);
            }
            if (ARK.equals(config.getProtocol())) return recoveryStore.recoverOrGenerate(
                    config, request, null, () -> ark(config, request));
            throw new ServiceException("配音协议未接通");
        } catch (ServiceException ex) { throw ex; }
        catch (Exception ex) {
            // 请求结果未知时不自动重试合成；统一任务链路负责保存失败/人工恢复提示。
            throw new ServiceException("配音结果待确认");
        }
    }

    private TokenDanceAudioRecoveryStore.GenerationResult ark(AiModelConfigVo config,
                                                               MediaAudioGenerateRequest request) throws Exception {
        AtomicReference<TokenDanceAudioPayloads.DecodedAudio> decoded = new AtomicReference<>();
        TokenDanceHttpResponse response = transport.exchangeStream("POST", config,
                com.aid.tokendance.provider.common.TokenDanceEndpoints.submitPath(config, "/gateway/ark/v3/tts/unidirectional"), MAPPER.writeValueAsBytes(TokenDanceAudioPayloads.ark(config, request)),
                Map.of("X-Api-Resource-Id", ModelCodeResolver.resolveUpstreamModel(config, request.getModelName()),
                        "X-Control-Require-Usage-Tokens-Return", "*"),
                (stream, status, contentType, recovery) -> {
                    byte[] bytes = stream.readNBytes(MAX_SSE_BYTES + 1);
                    if (bytes.length > MAX_SSE_BYTES) throw new ServiceException("音频响应过大");
                    decoded.set(TokenDanceAudioPayloads.decodeArkSse(new String(bytes, StandardCharsets.UTF_8)));
                });
        if (!response.isSuccessful()) {
            if (TokenDanceAudioRecoveryStore.isDefinitiveHttpRejection(response)) {
                return TokenDanceAudioRecoveryStore.GenerationResult.failure(failure(response));
            }
            throw new ServiceException("配音结果待确认，已阻止自动重发");
        }
        TokenDanceAudioPayloads.DecodedAudio audio = decoded.get();
        if (audio == null) throw new ServiceException("音频响应未完成");
        String format = StrUtil.blankToDefault(request.getAudioFormat(), "mp3");
        Integer durationMs = AudioDurationProber.probeDurationMs(audio.bytes());
        Map<String, Object> usage = new java.util.LinkedHashMap<>();
        JsonNode words = audio.terminal().path("usage").path("text_words");
        if (words.isIntegralNumber() && words.longValue() >= 0) usage.put("usage_characters", words.longValue());
        return TokenDanceAudioRecoveryStore.GenerationResult.success(
                new TokenDanceAudioRecoveryStore.GeneratedAudio(audio.bytes(), format,
                        durationMs == null ? null : durationMs.longValue(), usage,
                        audio.terminal().toString(), null));
    }

    private ProviderSubmitResult failure(TokenDanceHttpResponse response) {
        return ProviderSubmitResult.builder().rawResponse(TokenDanceResponseMapper.auditBody(response)).build();
    }

    @Override public ProviderTaskResult query(AiModelConfigVo config, String taskId) {
        return ProviderTaskResult.builder().status("PROCESSING").querySuccessful(false).terminalConfirmed(false)
                .errorMessage("同步音频无需查询").build();
    }
}
