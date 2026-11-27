package com.aid.model.requestlog;

import com.aid.domain.vo.AiModelConfigVo;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.stereotype.Component;

@Aspect
@Component
public class ModelRequestLogAspect {
    private final ModelRequestLogCapture capture;

    public ModelRequestLogAspect(ModelRequestLogCapture capture) {
        this.capture = capture;
    }

    @Around("(execution(public * com.aid.media.provider.ImageProviderClient+.submit(..)) "
            + "|| execution(public * com.aid.media.provider.ImageProviderClient+.query(..)) "
            + "|| execution(public * com.aid.media.provider.VideoProviderClient+.submit(..)) "
            + "|| execution(public * com.aid.media.provider.VideoProviderClient+.query(..)) "
            + "|| execution(public * com.aid.media.provider.AudioProviderClient+.submit(..)) "
            + "|| execution(public * com.aid.media.provider.AudioProviderClient+.query(..)) "
            + "|| execution(public * com.aid.media.provider.TextProviderClient+.submit(..)) "
            + "|| execution(public * com.aid.media.provider.TextProviderClient+.chatSync(..)) "
            + "|| execution(public * com.aid.media.provider.TextProviderClient+.streamChat(..))) "
            + "&& args(config,request,..)")
    public Object provider(ProceedingJoinPoint call, AiModelConfigVo config, Object request) throws Throwable {
        String name = call.getSignature().getName();
        var entry = capture.open(config, name, request);
        if (entry == null) return call.proceed();
        Object result = null;
        Throwable failure = null;
        try {
            result = call.proceed();
            return result;
        } catch (Throwable problem) {
            failure = problem;
            throw problem;
        } finally {
            entry.finish(result, failure);
        }
    }
}
