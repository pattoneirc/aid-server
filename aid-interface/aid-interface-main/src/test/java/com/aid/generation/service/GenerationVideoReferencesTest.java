package com.aid.generation.service;

import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.generation.service.GenerationResourceResolver.ResolvedResource;
import com.aid.media.dto.MediaVideoGenerateRequest;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GenerationVideoReferencesTest {
    @Test
    void projectsRegisteredRecordingAsAnAbsoluteUrlWithVerifiedMetadata() {
        var mediaUrlResolver = mock(MediaUrlResolver.class);
        String storedPath = "/aid/audio/recording.wav";
        String providerUrl = "https://cdn.example.test" + storedPath;
        when(mediaUrlResolver.toFullUrl(storedPath)).thenReturn(providerUrl);
        var recording = new ResolvedResource(2L, "角色原录音", "REFERENCE", "AUDIO", storedPath,
                277780L, "audio/wav", "{\"format\":\"wav\",\"durationSeconds\":6.297}", "recording");
        var request = new MediaVideoGenerateRequest();
        request.setCapabilityCode("reference_to_video");

        GenerationVideoReferences.apply(request, List.of(recording), new LinkedHashMap<>(), mediaUrlResolver);

        var audio = request.getReferenceAudios().get(0);
        assertEquals(providerUrl, audio.getSampleUrl());
        assertEquals(2L, audio.getReferenceAudioId());
        assertEquals(6297, audio.getDurationMs());
        assertEquals("wav", audio.getFormat());
    }
}
