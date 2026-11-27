package com.aid.model.requestlog;

import cn.hutool.http.HttpResponse;
import com.aid.aid.domain.media.AidMediaTask;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.dto.MediaAudioGenerateRequest;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.media.dto.MediaTextGenerateRequest;
import com.aid.media.dto.MediaVideoGenerateRequest;
import com.aid.media.provider.ProviderSubmitResult;
import com.aid.media.provider.ProviderTaskResult;
import jakarta.annotation.PostConstruct;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import org.springframework.stereotype.Component;

/** Retains only bounded transport samples and releases them when the provider call returns. */
@Component
public class ModelRequestLogCapture {
    private static final int MAX_EXCHANGES = 8;
    private static final int MAX_BODY = 100 * 1024;
    private static final ThreadLocal<Scope> ACTIVE = new ThreadLocal<>();
    private static final ThreadLocal<AidMediaTask> TASK = new ThreadLocal<>();
    private static volatile ModelRequestLogStore sink;
    private final ModelRequestLogStore store;

    public ModelRequestLogCapture(ModelRequestLogStore store) {
        this.store = store;
    }

    @PostConstruct
    void initialize() { sink = store; }

    public interface TaskScope extends AutoCloseable {
        @Override void close();
    }

    private static final TaskScope NO_TASK_SCOPE = () -> {};
    public static TaskScope task(AidMediaTask task) {
        ModelRequestLogStore current = sink;
        if (current == null || !current.anyEnabled()) return NO_TASK_SCOPE;
        AidMediaTask previous = TASK.get();
        TASK.set(task);
        return () -> {
            if (previous == null) TASK.remove(); else TASK.set(previous);
        };
    }

    public Scope open(AiModelConfigVo config, String operation, Object request) {
        if (config == null || !store.enabled(config.getModelType()) || ACTIVE.get() != null) return null;
        var scope = new Scope(store, config, operation, request, TASK.get());
        ACTIVE.set(scope);
        return scope;
    }

    public static final class Scope {
        private final ModelRequestLogStore store;
        private final AiModelConfigVo config;
        private final String operation;
        private final Instant started = Instant.now();
        private final long startedNanos = System.nanoTime();
        private final Long taskId;
        private final Long businessId;
        private final String businessType;
        private final Map<String, Object> invocation = new LinkedHashMap<>();
        private final List<Exchange> exchanges = new ArrayList<>();
        private Exchange hutool;
        private boolean overflow;

        Scope(ModelRequestLogStore store, AiModelConfigVo config, String operation, Object request, AidMediaTask task) {
            this.store = store;
            this.config = config;
            this.operation = operation;
            this.taskId = task == null ? null : task.getId();
            if (task != null) {
                businessId = task.getBizTaskId();
                businessType = task.getBizTaskType();
            } else if (request instanceof MediaTextGenerateRequest input) {
                businessId = input.getBizTaskId(); businessType = input.getBizTaskType();
            } else if (request instanceof MediaImageGenerateRequest input) {
                businessId = input.getBizTaskId(); businessType = input.getBizTaskType();
            } else if (request instanceof MediaVideoGenerateRequest input) {
                businessId = input.getBizTaskId(); businessType = input.getBizTaskType();
            } else if (request instanceof MediaAudioGenerateRequest input) {
                businessId = input.getBizTaskId(); businessType = input.getBizTaskType();
            } else {
                businessId = null; businessType = null;
            }
            invocation.put("model", config.getRealModelCode());
            invocation.put("protocol", config.getProtocol());
            invocation.put("capability", config.getCapabilityCode());
        }

        Exchange exchange(String url, String method) {
            if (exchanges.size() >= MAX_EXCHANGES) { overflow = true; return null; }
            var exchange = new Exchange(onlyEndpoint(url), method);
            exchanges.add(exchange);
            return exchange;
        }

        public void finish(Object result, Throwable failure) {
            ACTIVE.remove();
            try {
                if (!store.enabled(config.getModelType())) return;
                if (overflow) store.drop();
                String fallback = result instanceof ProviderSubmitResult submit ? submit.getRawResponse()
                        : result instanceof ProviderTaskResult query ? query.getRawResponse() : null;
                if (exchanges.isEmpty()) {
                    var boundary = new Exchange(null, operation);
                    boundary.omission = "当前协议未提供传输层正文";
                    exchanges.add(boundary);
                }
                for (int i = 0; i < exchanges.size(); i++) {
                    persist(exchanges.get(i), i == exchanges.size() - 1 ? fallback : null, failure);
                }
            } catch (RuntimeException captureFailure) { store.drop(); }
        }

        private void persist(Exchange exchange, String fallback, Throwable failure) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("invocation", invocation);
            body.put("endpoint", exchange.url);
            body.put("method", exchange.method);
            body.put("requestBody", exchange.request.text());
            String reply = exchange.response.text();
            String response = reply == null && exchange.omission == null ? bounded(fallback) : reply;
            body.put("responseBody", response);
            if (exchange.status != 0) body.put("httpStatus", exchange.status);
            if (exchange.omission != null) body.put("omission", exchange.omission);
            if (response == null && exchange.omission == null)
                body.put("omission", "当前调用没有可保存的响应正文");
            if (exchange.request.overflow || exchange.response.overflow)
                body.put("omission", "正文超过单条日志上限，超限正文未保存");
            if (failure != null) body.put("failureType", failure.getClass().getSimpleName());
            if (exchange.failure != null) body.put("transportFailureType", exchange.failure);
            List<String> secrets = new ArrayList<>(2);
            if (config.getApiKey() != null) secrets.add(config.getApiKey());
            if (config.getApiSecret() != null) secrets.add(config.getApiSecret());
            String status = failure != null || exchange.failure != null || exchange.status >= 400 ? "FAILED"
                    : exchange.status == 0 ? "UNKNOWN" : "RESPONDED";
            long estimated = 4096L + 4L * (length((String) body.get("requestBody"))
                    + length((String) body.get("responseBody")));
            store.offer(new ModelRequestLogStore.Record(config.getModelCode(), config.getProviderCode(),
                    config.getModelType().toLowerCase(Locale.ROOT), operation, taskId, businessId, businessType,
                    started, (System.nanoTime() - startedNanos) / 1_000_000, status, body, secrets), estimated);
        }
    }

    public static void hutoolRequest(cn.hutool.http.HttpRequest request) {
        var scope = ACTIVE.get();
        if (scope == null) return;
        try {
            var exchange = scope.exchange(request.getUrl(), String.valueOf(request.getMethod()));
            scope.hutool = exchange;
            if (exchange == null) return;
            if (textContent(request.header("Content-Type"))) exchange.request.add(request.bodyBytes());
            else exchange.omission = "文件或多媒体正文未保存";
        } catch (RuntimeException ignored) { scope.overflow = true; }
    }

    public static void hutoolResponse(HttpResponse response) {
        var scope = ACTIVE.get();
        if (scope == null || scope.hutool == null) return;
        try {
            var exchange = scope.hutool;
            exchange.status = response.getStatus();
            // Hutool can expose a deferred stream here. Use the adapter's raw response after it reads the body.
            if (!textContent(response.header("Content-Type"))) exchange.omission = "文件或多媒体正文未保存";
        } catch (RuntimeException ignored) {
            scope.hutool.omission = "响应正文未在传输层保存";
        }
    }

    public static Exchange begin(HttpRequest request) {
        var scope = ACTIVE.get();
        if (scope == null) return null;
        try { return scope.exchange(request.uri().toString(), request.method()); }
        catch (RuntimeException ignored) { scope.overflow = true; return null; }
    }

    public static <T> java.net.http.HttpResponse<T> send(java.net.http.HttpClient client, HttpRequest request,
            java.net.http.HttpResponse.BodyHandler<T> handler) throws java.io.IOException, InterruptedException {
        var exchange = begin(request);
        if (exchange == null) return client.send(request, handler);
        HttpRequest sampledRequest;
        java.net.http.HttpResponse.BodyHandler<T> sampledHandler;
        try {
            sampledRequest = exchange.wrap(request);
            sampledHandler = exchange.watch(handler);
        } catch (RuntimeException ignored) {
            return client.send(request, handler);
        }
        try {
            return client.send(sampledRequest, sampledHandler);
        } catch (java.io.IOException | InterruptedException | RuntimeException failure) {
            exchange.failure(failure);
            throw failure;
        }
    }

    public static final class Exchange {
        private final String url;
        private final String method;
        private final Sample request = new Sample();
        private final Sample response = new Sample();
        private volatile int status;
        private volatile String failure;
        private volatile String omission;

        Exchange(String url, String method) { this.url = url; this.method = method; }

        public void failure(Throwable problem) { failure = problem.getClass().getSimpleName(); }

        public HttpRequest wrap(HttpRequest original) {
            var body = original.bodyPublisher();
            if (body.isEmpty()) return original;
            if (!textContent(original.headers().firstValue("Content-Type").orElse(null))) {
                omission = "文件或多媒体正文未保存";
                return original;
            }
            HttpRequest.BodyPublisher observed = new HttpRequest.BodyPublisher() {
                public long contentLength() { return body.get().contentLength(); }
                public void subscribe(Flow.Subscriber<? super ByteBuffer> downstream) {
                    body.get().subscribe(new Flow.Subscriber<ByteBuffer>() {
                        public void onSubscribe(Flow.Subscription subscription) { downstream.onSubscribe(subscription); }
                        public void onNext(ByteBuffer chunk) { request.add(chunk); downstream.onNext(chunk); }
                        public void onError(Throwable error) { downstream.onError(error); }
                        public void onComplete() { downstream.onComplete(); }
                    });
                }
            };
            return HttpRequest.newBuilder(original, (name, value) -> true).method(original.method(), observed).build();
        }

        public <T> java.net.http.HttpResponse.BodyHandler<T> watch(java.net.http.HttpResponse.BodyHandler<T> handler) {
            return info -> {
                status = info.statusCode();
                var downstream = handler.apply(info);
                if (!textContent(info.headers().firstValue("Content-Type").orElse(null))) {
                    omission = "文件或多媒体正文未保存";
                    return downstream;
                }
                return new java.net.http.HttpResponse.BodySubscriber<T>() {
                    public CompletionStage<T> getBody() { return downstream.getBody(); }
                    public void onSubscribe(Flow.Subscription subscription) { downstream.onSubscribe(subscription); }
                    public void onNext(List<ByteBuffer> chunks) {
                        for (ByteBuffer chunk : chunks) response.add(chunk);
                        downstream.onNext(chunks);
                    }
                    public void onError(Throwable error) { failure(error); downstream.onError(error); }
                    public void onComplete() { downstream.onComplete(); }
                };
            };
        }
    }

    private static final class Sample {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private boolean overflow;

        synchronized void add(byte[] value) {
            if (value != null) add(ByteBuffer.wrap(value));
        }

        synchronized void add(ByteBuffer original) {
            if (overflow || !original.hasRemaining()) return;
            if (original.remaining() > MAX_BODY - bytes.size()) {
                overflow = true;
                bytes.reset();
                return;
            }
            ByteBuffer copy = original.asReadOnlyBuffer();
            byte[] slice = new byte[copy.remaining()];
            copy.get(slice);
            bytes.writeBytes(slice);
        }

        synchronized String text() {
            return bytes.size() == 0 || overflow ? null : bytes.toString(StandardCharsets.UTF_8);
        }
    }

    private static boolean textContent(String contentType) {
        if (contentType == null || contentType.isBlank()) return true;
        String type = contentType.toLowerCase(Locale.ROOT);
        return type.contains("json") || type.startsWith("text/") || type.contains("form-urlencoded");
    }

    private static String onlyEndpoint(String url) {
        try {
            var parsed = URI.create(url);
            if (parsed.getHost() == null) return null;
            return new URI(parsed.getScheme(), null, parsed.getHost(), parsed.getPort(), parsed.getPath(), null, null).toString();
        } catch (Exception invalid) { return null; }
    }

    private static int length(String value) { return value == null ? 0 : value.length(); }
    private static String bounded(String value) { return length(value) > MAX_BODY ? null : value; }
}
