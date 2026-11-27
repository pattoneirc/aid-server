package com.aid.canvas.controller;

import com.aid.canvas.service.CanvasConversationService;
import com.aid.common.aid.crypto.annotation.CryptoIgnore;
import com.aid.common.core.controller.BaseController;
import com.aid.common.core.domain.AjaxResult;
import com.aid.common.utils.SecurityUtils;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import com.alibaba.fastjson2.JSON;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/** Personal conversation state; generated canvas objects continue to use project permissions. */
@RestController
@RequestMapping("/api/user/canvas/conversation")
@RequiredArgsConstructor
public class CanvasConversationController extends BaseController {
    private final CanvasConversationService service;
    private final CopyOnWriteArrayList<Subscription> subscribers = new CopyOnWriteArrayList<>();
    private static final class Subscription {
        private final Long sessionId;
        private final Long userId;
        private final SseEmitter emitter;
        private volatile String lastSnapshot;
        private Subscription(Long sessionId, Long userId, SseEmitter emitter, String lastSnapshot) {
            this.sessionId = sessionId; this.userId = userId; this.emitter = emitter; this.lastSnapshot = lastSnapshot;
        }
    }

    @Data public static class Workspace { @NotNull private Long workspaceId; }
    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class Session extends Workspace { @NotNull private Long sessionId; }
    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class Quote extends Session {
        @NotBlank @Size(max = 10000) private String prompt;
        @NotBlank @Size(max = 100) private String modelCode;
        @Size(max = 10) private List<@Valid Reference> references;
    }
    @Data public static class Reference {
        @NotBlank @Size(max = 64) private String objectId;
        @NotNull private Long expectedVersion;
    }
    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class Send extends Quote {
        @NotBlank @Size(max = 64) private String clientRequestId;
        @NotNull @DecimalMin("0") @Digits(integer = 12, fraction = 6) private BigDecimal authorizedCredits;
    }
    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class Retry extends Session {
        @NotNull @DecimalMin("0") @Digits(integer = 12, fraction = 6) private BigDecimal authorizedCredits;
    }
    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class Edit extends Session {
        @NotBlank @Size(max = 10000) private String prompt;
        @NotBlank @Size(max = 100) private String modelCode;
        @NotNull private Integer planVersion;
    }
    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class Confirm extends Session {
        @NotNull private Integer planVersion;
        @NotBlank @Size(max = 10) private String mode;
        @NotNull @DecimalMin("0") @Digits(integer = 12, fraction = 6) private BigDecimal quotedCredits;
        @NotNull @DecimalMin("0") @Digits(integer = 12, fraction = 6) private BigDecimal budgetCap;
    }
    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class Step extends Session {
        @NotNull private Integer planVersion;
        @NotNull @DecimalMin("0") @Digits(integer = 12, fraction = 6) private BigDecimal quotedCredits;
    }

    @PostMapping("/open") public AjaxResult open(@Valid @RequestBody Workspace body) {
        return success(service.open(body.getWorkspaceId(), SecurityUtils.getUserId()));
    }
    @PostMapping("/list") public AjaxResult list(@Valid @RequestBody Workspace body) {
        return success(service.list(body.getWorkspaceId(), SecurityUtils.getUserId()));
    }
    @PostMapping("/detail") public AjaxResult detail(@Valid @RequestBody Session body) {
        return success(service.detail(body.getSessionId(), user(body)));
    }
    @PostMapping("/message/quote") public AjaxResult quote(@Valid @RequestBody Quote body) {
        return success(service.quote(body, user(body)));
    }
    @PostMapping("/message/send") public AjaxResult send(@Valid @RequestBody Send body) {
        return success(service.send(body, user(body)));
    }
    @PostMapping("/message/requote") public AjaxResult requote(@Valid @RequestBody Session body) {
        return success(service.requoteChat(body.getSessionId(), user(body)));
    }
    @PostMapping("/message/retry") public AjaxResult retry(@Valid @RequestBody Retry body) {
        return success(service.retryChat(body, user(body)));
    }
    @PostMapping("/plan/update") public AjaxResult update(@Valid @RequestBody Edit body) {
        return success(service.update(body, user(body)));
    }
    @PostMapping("/plan/quote") public AjaxResult planQuote(@Valid @RequestBody Session body) {
        return success(service.quotePlan(body.getSessionId(), user(body)));
    }
    @PostMapping("/plan/confirm") public AjaxResult confirm(@Valid @RequestBody Confirm body) {
        return success(service.confirm(body, user(body)));
    }
    @PostMapping("/step/confirm") public AjaxResult step(@Valid @RequestBody Step body) {
        return success(service.confirmStep(body, user(body)));
    }
    @PostMapping("/run/cancel") public AjaxResult cancel(@Valid @RequestBody Session body) {
        return success(service.cancel(body.getSessionId(), user(body)));
    }

    private Long user(Session body) {
        Long userId = SecurityUtils.getUserId();
        service.requireScope(body.getSessionId(), body.getWorkspaceId(), userId);
        return userId;
    }

    /** Reconnection always sends the current authoritative state, including any terminal result missed offline. */
    @CryptoIgnore
    @PostMapping(value = "/run/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@Valid @RequestBody Session body) throws IOException {
        Long userId = user(body);
        Map<String, Object> state = service.detail(body.getSessionId(), userId);
        SseEmitter emitter = new SseEmitter(15L * 60L * 1000L);
        Subscription subscription = new Subscription(body.getSessionId(), userId, emitter, JSON.toJSONString(state));
        subscribers.add(subscription);
        emitter.onCompletion(() -> subscribers.remove(subscription));
        emitter.onTimeout(() -> subscribers.remove(subscription));
        emitter.onError(error -> subscribers.remove(subscription));
        emitter.send(SseEmitter.event().name("state").id(String.valueOf(System.currentTimeMillis())).data(state));
        return emitter;
    }

    @Scheduled(fixedDelay = 2500)
    public void pushStates() {
        for (Subscription subscriber : subscribers) {
            try {
                Map<String, Object> state = service.detail(subscriber.sessionId, subscriber.userId);
                String snapshot = JSON.toJSONString(state);
                if (!snapshot.equals(subscriber.lastSnapshot)) {
                    subscriber.lastSnapshot = snapshot;
                    subscriber.emitter.send(SseEmitter.event().name("state")
                            .id(String.valueOf(System.currentTimeMillis())).data(state));
                } else subscriber.emitter.send(SseEmitter.event().comment("keepalive"));
            } catch (RuntimeException | IOException error) {
                subscribers.remove(subscriber);
                subscriber.emitter.complete();
            }
        }
    }
}
