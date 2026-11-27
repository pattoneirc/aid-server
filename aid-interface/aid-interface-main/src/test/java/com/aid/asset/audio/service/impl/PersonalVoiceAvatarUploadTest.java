package com.aid.asset.audio.service.impl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;

import com.aid.common.aid.oss.config.OssConfigManager;
import com.aid.common.aid.oss.core.OssTemplate;
import com.aid.common.aid.oss.exception.OssException;
import com.aid.common.aid.oss.properties.OssProperties;
import com.aid.common.exception.ServiceException;

class PersonalVoiceAvatarUploadTest {
    private final OssProperties properties = new OssProperties();
    private final PersonalVoiceAssetService service = new PersonalVoiceAssetService();
    private final MockMultipartFile badRecording =
            new MockMultipartFile("file", "recording.txt", "text/plain", new byte[]{1});

    @BeforeEach
    void setUp() {
        OssConfigManager config = mock(OssConfigManager.class);
        when(config.getOssProperties()).thenReturn(properties);
        ReflectionTestUtils.setField(service, "ossTemplate", new OssTemplate(config));
    }

    @Test
    void acceptsAvatarExactlyAtConfiguredLimitAboveThePreviousFiveMbCap() {
        configureImageLimit(10);
        ServiceException error = assertThrows(ServiceException.class,
                () -> service.upload(badRecording, "旁白", pngAvatar(10L * 1024 * 1024), 1L));
        assertEquals("录音仅支持 WAV 或 MP3", error.getMessage());
    }

    @Test
    void rejectsAvatarAboveConfiguredImageLimitBeforeUploading() {
        configureImageLimit(2);
        OssException error = assertThrows(OssException.class,
                () -> service.upload(badRecording, "旁白", pngAvatar(2L * 1024 * 1024 + 1), 1L));
        assertEquals("图片大小不能超过 2MB", error.getMessage());
    }

    @Test
    void rejectsInvalidPngContentsEvenWithinSizeLimit() {
        configureImageLimit(10);
        MockMultipartFile invalid = new MockMultipartFile("avatar", "avatar.png", "image/png", new byte[20]);
        ServiceException error = assertThrows(ServiceException.class,
                () -> service.upload(badRecording, "旁白", invalid, 1L));
        assertEquals("头像须为 PNG 或 JPEG 图片", error.getMessage());
    }

    private void configureImageLimit(long limitMb) {
        OssProperties.UploadTypeLimit rule = new OssProperties.UploadTypeLimit();
        rule.setName("图片");
        rule.setMaxSizeMb(limitMb);
        rule.setMaxBytes(limitMb * 1024 * 1024);
        rule.setExtensions(Set.of("png", "jpg", "jpeg"));
        properties.setUploadTypeLimits(List.of(rule));
    }

    private static MockMultipartFile pngAvatar(long size) {
        return new MockMultipartFile("avatar", "avatar.png", "image/png",
                new byte[]{(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}) {
            @Override
            public long getSize() {
                return size;
            }
        };
    }
}
