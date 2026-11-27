package com.aid.media.provider;

import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;

/** Local transport ownership only: losing it is never a user cancellation or billing decision. */
public final class TextExecutionTransportScope implements AutoCloseable {
    public static final class OwnershipLostException extends IllegalStateException {
        public OwnershipLostException() { super("MEDIA_EXECUTION_PERMIT_LOST"); }
    }

    private static final ThreadLocal<TextExecutionTransportScope> CURRENT = new ThreadLocal<>();
    private final List<AutoCloseable> resources = new ArrayList<>();
    private boolean cancelled;

    private TextExecutionTransportScope() { }

    public static TextExecutionTransportScope open() {
        if (CURRENT.get() != null) throw new IllegalStateException("Nested text execution transport");
        var scope = new TextExecutionTransportScope();
        CURRENT.set(scope);
        return scope;
    }

    public static void attach(AutoCloseable resource) {
        var scope = CURRENT.get();
        if (scope != null && resource != null) scope.register(resource);
    }

    private void register(AutoCloseable resource) {
        synchronized (this) {
            if (!cancelled) {
                resources.add(resource);
                return;
            }
        }
        closeQuietly(resource);
        throw new OwnershipLostException();
    }

    public synchronized void requireActive() {
        if (cancelled) throw new OwnershipLostException();
    }

    public void cancel() {
        List<AutoCloseable> closing;
        synchronized (this) {
            if (cancelled) return;
            cancelled = true;
            closing = new ArrayList<>(resources);
            resources.clear();
        }
        for (AutoCloseable resource : closing) closeQuietly(resource);
    }

    public static <T> HttpResponse<T> send(HttpClient client, HttpRequest request,
            HttpResponse.BodyHandler<T> handler) throws IOException, InterruptedException {
        var exchange = com.aid.model.requestlog.ModelRequestLogCapture.begin(request);
        if (exchange == null) return sendOwned(client, request, handler);
        HttpRequest sampledRequest;
        HttpResponse.BodyHandler<T> sampledHandler;
        try {
            sampledRequest = exchange.wrap(request);
            sampledHandler = exchange.watch(handler);
        } catch (RuntimeException instrumentationFailure) {
            return sendOwned(client, request, handler);
        }
        try {
            return sendOwned(client, sampledRequest, sampledHandler);
        } catch (IOException | InterruptedException | RuntimeException failure) {
            exchange.failure(failure);
            throw failure;
        }
    }

    private static <T> HttpResponse<T> sendOwned(HttpClient client, HttpRequest request,
            HttpResponse.BodyHandler<T> handler) throws IOException, InterruptedException {
        var scope = CURRENT.get();
        if (scope == null) return client.send(request, handler);
        // Register and start under the same lock so cancellation cannot precede a new send.
        java.util.concurrent.CompletableFuture<HttpResponse<T>> future;
        synchronized (scope) {
            if (scope.cancelled) throw new OwnershipLostException();
            future = client.sendAsync(request, handler);
            scope.resources.add(() -> future.cancel(true));
        }
        try {
            HttpResponse<T> response = future.get();
            if (response.body() instanceof AutoCloseable body) attach(body);
            return response;
        } catch (CancellationException cancelled) {
            throw new OwnershipLostException();
        } catch (ExecutionException failure) {
            scope.requireActive();
            if (failure.getCause() instanceof CancellationException) throw new OwnershipLostException();
            if (failure.getCause() instanceof IOException io) throw io;
            if (failure.getCause() instanceof RuntimeException runtime) throw runtime;
            throw new IOException("Text transport failed", failure.getCause());
        } catch (InterruptedException interrupted) {
            future.cancel(true);
            throw interrupted;
        }
    }

    @Override public void close() {
        if (CURRENT.get() == this) CURRENT.remove();
        cancel();
    }

    private static void closeQuietly(AutoCloseable resource) {
        try { resource.close(); } catch (Exception ignored) { }
    }
}
