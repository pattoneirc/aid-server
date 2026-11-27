package com.aid.storyboard.service.impl;

import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.util.ModelCapabilityResolver.ImageSizeSpec;
import com.aid.storyboard.dto.StoryboardImageGenerateRequest;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StoryboardImageSizeTest
{
    @Test
    void forwardsBothTheAgnesSizeTierAndTheChosenAspectRatio()
    {
        AiModelConfigVo model = new AiModelConfigVo();
        model.setProviderCode("agnes");
        model.setCapabilityJson("""
                {"defaultAspectRatio":"1:1","aspectRatioOptions":["1:1","16:9"],"sizeOptions":["1K","2K"]}
                """);
        StoryboardImageGenerateRequest request = new StoryboardImageGenerateRequest();
        request.setSize("1K");
        request.setAspectRatio("16:9");

        ImageSizeSpec size = ReflectionTestUtils.invokeMethod(new StoryboardImageGenerationServiceImpl(),
                "resolveImageSizeSpec", model, request, List.of(1L), 1L);

        assertEquals(new ImageSizeSpec("1K", "16:9"), size);
    }
}
