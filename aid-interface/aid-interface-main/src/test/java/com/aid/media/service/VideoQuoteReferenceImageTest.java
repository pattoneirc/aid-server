package com.aid.media.service;

import com.aid.common.exception.ServiceException;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.dto.AuthorizedImageAssetSnapshot;
import com.aid.media.dto.MediaVideoGenerateRequest;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class VideoQuoteReferenceImageTest {
    private final VerifiedMediaMetadataService metadata = mock(VerifiedMediaMetadataService.class);
    private final VerifiedMediaInputService service = new VerifiedMediaInputService(metadata);

    @Test
    void collectsBothViolationsWithoutReadingFilesAndAcceptsCorrectedInputs() {
        var model = model();
        var failure = assertThrows(ServiceException.class, () -> service.validateVideoQuoteImages(model, request(
                image(101, 2759, 1024, 1), image(102, 768, 1024, 1),
                image(103, 768, 1024, 1), image(104, 768, 1024, 34))));
        assertEquals(422, failure.getCode());
        var details = failure.getClientErrorData();
        assertEquals("VIDEO_QUOTE_REFERENCE_IMAGES_INVALID", details.getErrorCode());
        var issues = details.getReferenceImageIssues();
        assertEquals(List.of("ASPECT_RATIO", "FILE_SIZE"), issues.stream().map(issue -> issue.kind()).toList());
        assertEquals(List.of("101", "104"), issues.stream().map(issue -> issue.resourceId()).toList());
        assertEquals(List.of(1, 4), issues.stream().map(issue -> issue.index()).toList());
        assertDoesNotThrow(() -> service.validateVideoQuoteImages(model, request(
                image(105, 2560, 1024, 1), image(106, 768, 1024, 30))));
        verifyNoInteractions(metadata);
    }

    @Test
    void requestsMissingMetadataBeforeReportingTheCompleteList() {
        var missing = image(102, 768, 1024, 1);
        missing.setWidth(null);
        var failure = assertThrows(ServiceException.class, () ->
                service.validateVideoQuoteImages(model(), request(image(101, 2759, 1024, 1), missing)));
        assertEquals("MEDIA_INPUT_METADATA_REQUIRED", failure.getClientErrorData().getErrorCode());
        assertEquals(List.of("102"), failure.getClientErrorData().getResourceIds());
    }

    private static AiModelConfigVo model() {
        var model = new AiModelConfigVo();
        model.setCapabilityJson("""
                {"referenceImageMinAspectRatio":0.4,"referenceImageMaxAspectRatio":2.5,"referenceImageMaxFileSizeMb":30}
                """);
        return model;
    }

    private static MediaVideoGenerateRequest request(AuthorizedImageAssetSnapshot... images) {
        var request = new MediaVideoGenerateRequest();
        var snapshots = new LinkedHashMap<String, AuthorizedImageAssetSnapshot>();
        for (var image : images) snapshots.put(image.getLocator(), image);
        request.setQuoteReferenceImages(snapshots);
        return request;
    }

    private static AuthorizedImageAssetSnapshot image(long id, int width, int height, long mib) {
        var image = new AuthorizedImageAssetSnapshot();
        image.setResourceId(id);
        image.setLocator("/canvas/test/" + id + ".png");
        image.setMimeType("image/png");
        image.setWidth(width);
        image.setHeight(height);
        image.setFileSize(mib * 1024 * 1024);
        image.setResourceIdentityDigest("a".repeat(64));
        return image;
    }
}
