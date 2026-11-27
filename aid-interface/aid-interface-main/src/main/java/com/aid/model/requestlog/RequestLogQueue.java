package com.aid.model.requestlog;

import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;
import java.util.function.Supplier;

/** Shared memory quota includes records still being written or indexed. */
final class RequestLogQueue<T> {
    private final ConcurrentLinkedQueue<Entry<T>> queue = new ConcurrentLinkedQueue<>();
    private final Semaphore slots;
    private final AtomicLong reserved = new AtomicLong();
    private final long maxBytes;
    private final LongAdder dropped = new LongAdder();

    RequestLogQueue(int maxEntries, long maxBytes) {
        if (maxEntries < 1 || maxBytes < 1) throw new IllegalArgumentException("Invalid log queue limit");
        this.slots = new Semaphore(maxEntries);
        this.maxBytes = maxBytes;
    }

    boolean offer(long estimatedBytes, Supplier<T> boundedSnapshot) {
        if (estimatedBytes <= 0 || estimatedBytes > maxBytes || !slots.tryAcquire()) {
            dropped.increment();
            return false;
        }
        long used = reserved.get();
        if (used > maxBytes - estimatedBytes || !reserved.compareAndSet(used, used + estimatedBytes)) {
            slots.release();
            dropped.increment();
            return false;
        }
        boolean accepted = false;
        try {
            T snapshot = boundedSnapshot.get();
            if (snapshot == null) return false;
            accepted = queue.offer(new Entry<>(snapshot, estimatedBytes));
            return accepted;
        } catch (RuntimeException failure) {
            return false;
        } finally {
            if (!accepted) {
                reserved.addAndGet(-estimatedBytes);
                slots.release();
                dropped.increment();
            }
        }
    }

    Entry<T> poll() {
        return queue.poll();
    }

    void complete(Entry<T> entry) {
        reserved.addAndGet(-entry.bytes());
        slots.release();
    }

    long droppedCount() {
        return dropped.sum();
    }

    record Entry<T>(T value, long bytes) {}
}
