package com.aid.config.test;

import com.aid.billing.service.BillingPreHoldCalculationService;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.common.config.test.ConfigTestResult;
import com.aid.common.exception.ServiceException;
import com.aid.common.utils.SecurityUtils;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.media.dto.PreparedMediaBillingInput;
import com.aid.media.provider.ImageOutputItem;
import com.aid.media.provider.ImageProviderClient;
import com.aid.media.provider.ProviderSubmitResult;
import com.aid.media.provider.ProviderTaskResult;
import com.aid.media.provider.VideoProviderClient;
import com.aid.media.service.MediaBillingQuotePreparer;
import com.aid.media.util.ModelCapabilityResolver;
import com.aid.service.IAiModelConfigService;
import jakarta.annotation.PreDestroy;
import java.math.BigDecimal;
import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** Read-only quotes and isolated upstream tests. No business tasks or credit holds are created. */
@Service
@RequiredArgsConstructor
public class AdminMediaModelTest {
    private static final Duration QUOTE_TTL = Duration.ofMinutes(3);
    private static final Duration RUN_TTL = Duration.ofMinutes(15);
    private static final int MAX_ENTRIES = 128;
    private static final Pattern PIXELS = Pattern.compile("(\\d{2,5})[x×](\\d{2,5})");
    private static final Pattern TIER = Pattern.compile("(\\d+(?:\\.\\d+)?)(p|k)");
    private final IAiModelConfigService configurations;
    private final MediaBillingQuotePreparer quotes;
    private final BillingPreHoldCalculationService billing;
    private final MediaUrlResolver urls;
    private final List<ImageProviderClient> imageClients;
    private final List<VideoProviderClient> videoClients;
    private final Map<String, Ticket> tickets = new LinkedHashMap<>();
    private final Map<String, Run> runs = new LinkedHashMap<>();
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2,
            0L, TimeUnit.SECONDS, new ArrayBlockingQueue<>(2), task -> {
                Thread worker = new Thread(task, "admin-media-model-test");
                worker.setDaemon(true);
                return worker;
            });

    private record Plan(AiModelConfigVo config, String type, String spec, BigDecimal estimate,
                        String identity, java.util.function.Supplier<ProviderSubmitResult> submit,
                        Function<String, ProviderTaskResult> poll) {}

    private record Ticket(Long modelId, Long operatorId, String identity, String spec,
                          BigDecimal estimate, long expires) {}

    private static final class Run {
        private final Long operatorId;
        private final Long modelId;
        private final long expires;
        private volatile ConfigTestResult result;

        private Run(Long operatorId, Long modelId, ConfigTestResult result) {
            this.operatorId = operatorId;
            this.modelId = modelId;
            this.result = result;
            expires = deadline(RUN_TTL);
        }
    }

    public ConfigTestResult execute(Long modelId, String type, Map<String, Object> payload) {
        Long operator = SecurityUtils.getUserId();
        String runId = token(payload.get("testRunId"));
        String confirmation = token(payload.get("confirmationToken"));
        if (runId != null) return readRun(modelId, operator, runId);
        if (confirmation != null) return confirm(modelId, operator, type, confirmation);
        try {
            Plan plan = prepare(modelId, type);
            var result = result(plan, "confirmation", "请确认本次模型生成测试");
            synchronized (tickets) {
                tickets.values().removeIf(ticket -> expired(ticket.expires()));
                if (tickets.size() >= MAX_ENTRIES) return ConfigTestResult.fail("测试请求较多，请稍后再试");
                String id = UUID.randomUUID().toString();
                tickets.put(id, new Ticket(modelId, operator, plan.identity(), plan.spec(),
                        plan.estimate(), deadline(QUOTE_TTL)));
                result.setConfirmationToken(id);
            }
            return result;
        } catch (ServiceException unsupported) {
            return ConfigTestResult.fail(unsupported.getMessage());
        }
    }

    private ConfigTestResult confirm(Long modelId, Long operator, String type, String id) {
        Ticket ticket;
        synchronized (tickets) {
            ticket = tickets.get(id);
            if (ticket == null || expired(ticket.expires()) || !Objects.equals(operator, ticket.operatorId())
                    || !Objects.equals(modelId, ticket.modelId())) {
                return ConfigTestResult.fail("确认已失效，请重新获取报价");
            }
            tickets.remove(id);
        }
        Plan plan;
        try {
            plan = prepare(modelId, type);
        } catch (ServiceException unsupported) {
            return ConfigTestResult.fail(unsupported.getMessage());
        }
        if (!ticket.identity().equals(plan.identity()) || !ticket.spec().equals(plan.spec())
                || ticket.estimate().compareTo(plan.estimate()) != 0) {
            return ConfigTestResult.fail("模型配置或报价已变化，请重新获取报价");
        }
        String runId = UUID.randomUUID().toString();
        ConfigTestResult pending = result(plan, "running", "正在请求上游生成");
        pending.setTestRunId(runId);
        Run run = new Run(operator, modelId, pending);
        synchronized (runs) {
            runs.values().removeIf(entry -> expired(entry.expires));
            if (runs.size() >= MAX_ENTRIES) return ConfigTestResult.fail("测试请求较多，请稍后再试");
            runs.put(runId, run);
        }
        try {
            workers.execute(() -> run.result = generate(plan));
        } catch (RejectedExecutionException busy) {
            synchronized (runs) { runs.remove(runId); }
            return ConfigTestResult.fail("生成测试正在排队，请稍后重新确认");
        }
        return pending;
    }

    private ConfigTestResult readRun(Long modelId, Long operator, String id) {
        synchronized (runs) {
            Run run = runs.get(id);
            if (run == null || expired(run.expires) || !Objects.equals(run.operatorId, operator)
                    || !Objects.equals(run.modelId, modelId)) {
                return ConfigTestResult.fail("测试记录已过期");
            }
            return run.result;
        }
    }

    private Plan prepare(Long modelId, String type) {
        AiModelConfigVo initial = configurations.selectByModelId(modelId, null);
        if (initial == null || blank(initial.getBaseUrl()) || blank(initial.getApiKey())) {
            throw new ServiceException("模型调用地址或密钥未配置");
        }
        String textMode = "image".equals(type) ? "text_to_image" : "text_to_video";
        if (!textMode.equals(initial.getGenerateMode()) && initial.getResolvedCapabilities() != null) {
            var alternate = initial.getResolvedCapabilities().stream()
                    .filter(item -> Boolean.TRUE.equals(item.getEnabled()) && textMode.equals(item.getGenerateMode()))
                    .findFirst();
            if (alternate.isPresent()) initial = configurations.selectByModelId(modelId, alternate.get().getCode());
        }
        if (initial == null || Boolean.FALSE.equals(initial.getSupportsTextInput())) {
            throw new ServiceException("当前模型只支持参考素材输入，无法用文本样例测试");
        }
        var capability = ModelCapabilityResolver.parseCapability(initial.getCapabilityJson());
        String size = smallestSize(ModelCapabilityResolver.readOptions(capability, "sizeOptions"),
                ModelCapabilityResolver.resolveSize(initial, null));
        String ratio = ModelCapabilityResolver.resolveAspectRatio(initial, null);
        if ("image".equals(type)) {
            MediaImageGenerateRequest request = new MediaImageGenerateRequest();
            request.setModelName(initial.getModelCode());
            request.setCapabilityCode(initial.getCapabilityCode());
            request.setPrompt("A small blue circle on a plain white background.");
            request.setSize(size);
            request.setExpectedImageCount(1);
            var options = new LinkedHashMap<String, Object>();
            if (ratio != null && !ModelCapabilityResolver.isExplicitPixelSize(size)) options.put("aspectRatio", ratio);
            request.setOptions(options);
            var prepared = quotes.prepareImageBilling(request);
            AiModelConfigVo config = checkedModel(initial, prepared);
            ImageProviderClient client = unique(imageClients, item -> item.supportsProtocol(config.getProtocol()));
            return plan(type, printable(request.getSize()) + " · 1 张", prepared,
                    () -> client.submit(config, request), id -> client.query(config, id));
        }
        MediaVideoGenerateRequest request = new MediaVideoGenerateRequest();
        request.setModelName(initial.getModelCode());
        request.setCapabilityCode(initial.getCapabilityCode());
        request.setPrompt("A small blue circle moves slowly across a plain white background. Fixed camera.");
        request.setAspectRatio(ModelCapabilityResolver.resolveVideoAspectRatio(initial, null));
        request.setDurationSeconds(shortestDuration(initial));
        var options = new LinkedHashMap<String, Object>();
        if (size != null) options.put("resolution", size);
        request.setOptions(options);
        var prepared = quotes.prepareReadOnlyVideoBilling(request);
        AiModelConfigVo config = checkedModel(initial, prepared);
        VideoProviderClient client = unique(videoClients, item -> item.supportsProtocol(config.getProtocol()));
        String spec = printable(Objects.toString(request.getOptions().get("resolution"), size))
                + " · " + printable(Objects.toString(request.getDurationSeconds(), null)) + " 秒 · 1 个";
        return plan(type, spec, prepared, () -> client.submit(config, request), id -> client.query(config, id));
    }

    private Plan plan(String type, String spec, PreparedMediaBillingInput prepared,
                      java.util.function.Supplier<ProviderSubmitResult> submit,
                      Function<String, ProviderTaskResult> poll) {
        var price = billing.calculate(prepared.modelConfig(), prepared.billingInput());
        if (price == null || !price.isMatched() || price.getAmount() == null) {
            throw new ServiceException("当前测试规格暂无可用计费规则");
        }
        var config = prepared.modelConfig();
        String identity = cn.hutool.crypto.SecureUtil.sha256(Objects.toString(config.getId()) + "|" +
                config.getCapabilityCode() + "|" + config.getBindingCode() + "|" + config.getConfigVersion()
                + "|" + config.getProtocol() + "|" + config.getRealModelCode() + "|" + config.getBaseUrl()
                + "|" + config.getApiKey() + "|" + config.getApiSecret() + "|" + config.getBillingVersion());
        return new Plan(config, type, spec, price.getAmount(), identity, submit, poll);
    }

    private static AiModelConfigVo checkedModel(AiModelConfigVo expected, PreparedMediaBillingInput prepared) {
        AiModelConfigVo actual = prepared.modelConfig();
        if (!Objects.equals(expected.getId(), actual.getId())
                || !Objects.equals(expected.getBindingCode(), actual.getBindingCode())
                || !Objects.equals(expected.getBaseUrl(), actual.getBaseUrl())
                || !Objects.equals(expected.getApiKey(), actual.getApiKey())) {
            throw new ServiceException("无法为此模型的当前连接获取报价");
        }
        return actual;
    }

    private ConfigTestResult generate(Plan plan) {
        try {
            ProviderSubmitResult submitted = plan.submit().get();
            if (submitted == null || submitted.getConfirmedFailureCode() != null || submitted.isCapacityRejected()) {
                return failure(plan, "上游未接受生成请求，请检查模型配置和额度");
            }
            var direct = new ArrayList<String>();
            direct.add(submitted.getOssUrl());
            direct.add(submitted.getDirectUrl());
            if (submitted.getResultUrls() != null) direct.addAll(submitted.getResultUrls());
            if (submitted.getImageOutputs() != null) submitted.getImageOutputs().stream()
                    .filter(Objects::nonNull).map(ImageOutputItem::getUrl).forEach(direct::add);
            String url = preview(direct);
            if (url != null) return complete(plan, url);
            if (blank(submitted.getProviderTaskId())) return failure(plan, "上游未返回可预览结果或任务");
            long end = deadline(Duration.ofMinutes(5));
            while (!expired(end) && !Thread.currentThread().isInterrupted()) {
                TimeUnit.SECONDS.sleep(5);
                ProviderTaskResult response = plan.poll().apply(submitted.getProviderTaskId());
                if (response == null || Boolean.FALSE.equals(response.getQuerySuccessful())) continue;
                if ("FAILED".equals(response.getStatus()) && !Boolean.FALSE.equals(response.getTerminalConfirmed())) {
                    return failure(plan, "上游任务生成失败，请检查供应商任务记录");
                }
                if ("SUCCEEDED".equals(response.getStatus())) {
                    var results = new ArrayList<String>();
                    if (response.getPersistedResultUrls() != null) results.addAll(response.getPersistedResultUrls());
                    results.add(response.getResultUrl());
                    if (response.getResultUrls() != null) results.addAll(response.getResultUrls());
                    url = preview(results);
                    if (url != null) return complete(plan, url);
                }
            }
            return failure(plan, "测试等待超时，上游任务可能仍在运行");
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
            return failure(plan, "测试已中断");
        } catch (RuntimeException upstream) {
            return failure(plan, "上游请求失败，请检查模型连接或查看请求日志");
        }
    }

    private String preview(List<String> values) {
        for (String value : values) {
            if (blank(value)) continue;
            try {
                URI uri = URI.create(urls.toFullUrl(value));
                if (uri.getHost() != null && uri.getUserInfo() == null
                        && ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))) {
                    return uri.toASCIIString();
                }
            } catch (IllegalArgumentException invalid) {
                // Try another returned output.
            }
        }
        return null;
    }

    static String smallestSize(List<String> options, String fallback) {
        return options.stream().filter(option -> pixels(option) < Long.MAX_VALUE)
                .min(Comparator.comparingLong(AdminMediaModelTest::pixels)).orElse(fallback);
    }

    private static long pixels(String value) {
        String normalized = value.strip().toLowerCase(Locale.ROOT);
        var dimensions = PIXELS.matcher(normalized);
        if (dimensions.matches()) return Long.parseLong(dimensions.group(1)) * Long.parseLong(dimensions.group(2));
        var tier = TIER.matcher(normalized);
        if (tier.matches()) {
            long height = (long) (Double.parseDouble(tier.group(1)) * ("k".equals(tier.group(2)) ? 540 : 1));
            return height * height * 16 / 9;
        }
        return Long.MAX_VALUE;
    }

    static Integer shortestDuration(AiModelConfigVo config) {
        var capability = ModelCapabilityResolver.parseCapability(config.getCapabilityJson());
        var options = ModelCapabilityResolver.readOptions(capability, "durationOptions").stream()
                .filter(value -> value.matches("[1-9]\\d{0,3}")).map(Integer::valueOf).toList();
        if (!options.isEmpty()) return options.stream().min(Integer::compareTo).orElseThrow();
        if (config.getResolvedDefinition() != null && config.getResolvedDefinition().getParameters() != null) {
            for (var parameter : config.getResolvedDefinition().getParameters()) {
                if (!List.of("duration", "durationSeconds").contains(parameter.getName())) continue;
                if (parameter.getChoices() != null) {
                    var choice = parameter.getChoices().stream().map(String::valueOf)
                            .filter(value -> value.matches("[1-9]\\d{0,3}"))
                            .map(Integer::valueOf).min(Integer::compareTo);
                    if (choice.isPresent()) return choice.get();
                }
                if (parameter.getMinimum() != null && parameter.getMinimum().signum() > 0) {
                    return parameter.getMinimum().setScale(0, java.math.RoundingMode.CEILING).intValueExact();
                }
            }
        }
        Integer fallback = config.getDefaultDurationSeconds();
        return fallback != null && fallback > 0 ? fallback : null;
    }

    private static <T> T unique(List<T> clients, Predicate<T> match) {
        var choices = clients.stream().filter(match).toList();
        if (choices.size() != 1) throw new ServiceException("当前模型未绑定唯一的正式生成协议");
        return choices.get(0);
    }

    private static ConfigTestResult result(Plan plan, String status, String message) {
        var result = ConfigTestResult.ok(message, plan.config().getProviderCode());
        result.setMediaStatus(status);
        result.setMediaType(plan.type());
        result.setEstimatedCredits(plan.estimate());
        result.setTestSpec(plan.spec());
        return result;
    }

    private static ConfigTestResult complete(Plan plan, String url) {
        var result = result(plan, "complete", "实际生成成功");
        result.setMediaUrl(url);
        return result;
    }

    private static ConfigTestResult failure(Plan plan, String message) {
        var result = result(plan, "failed", message);
        result.setSuccess(false);
        return result;
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }
    private static String printable(String value) { return blank(value) ? "默认" : value; }
    private static String token(Object value) { return value instanceof String name ? name : null; }
    private static long deadline(Duration duration) { return System.nanoTime() + duration.toNanos(); }
    private static boolean expired(long deadline) { return System.nanoTime() - deadline >= 0; }

    @PreDestroy
    void shutdown() { workers.shutdownNow(); }
}
