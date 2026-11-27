package com.aid.storyboard.support;

import com.aid.aid.domain.AidRolePropSceneFormImage;
import com.aid.aid.domain.AidStoryboard;
import com.aid.aid.service.IAidRolePropSceneFormImageService;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.common.exception.ServiceException;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.media.util.MediaTaskPayloadSanitizer;
import com.aid.rps.resolver.StoryboardImageReferenceResolver;
import com.aid.storyboard.dto.StoryboardImageReference;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class StoryboardImageBindingsTest {
    @BeforeAll
    static void initTableInfo() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), "storyboard-bindings-test"),
                AidRolePropSceneFormImage.class);
    }

    private final IAidRolePropSceneFormImageService images = mock(IAidRolePropSceneFormImageService.class);
    private final MediaUrlResolver urls = mock(MediaUrlResolver.class);
    private final StoryboardImageReferenceResolver legacy = mock(StoryboardImageReferenceResolver.class);
    private final StoryboardImageBindings bindings = new StoryboardImageBindings(images, urls, legacy);

    @Test
    void resolvesTwoSameNameImagesByIdentityAndSendsTheirBytesInPromptOrder() {
        when(images.list(any(Wrapper.class))).thenReturn(List.of(image(11L, "/dog-a.png"), image(22L, "/dog-b.png")));
        when(urls.isSiteImageUrl(anyString())).thenReturn(true);
        when(urls.toRelativePath(anyString())).thenAnswer(call -> call.getArgument(0));
        when(urls.toFullUrl(anyString())).thenAnswer(call -> "https://assets.example.test" + call.getArgument(0));

        var selected = List.of(new StoryboardImageReference(8, "小狗", 22L, "/dog-a.png"),
                new StoryboardImageReference(9, "小狗", 11L, null));
        var plan = bindings.resolve(shot(), "@图片8[小狗] 和 @图片9[小狗]", selected, false);
        assertEquals(List.of("https://assets.example.test/dog-b.png", "https://assets.example.test/dog-a.png"), plan.urls());
        assertEquals(List.of(22L, 11L), plan.manifest().stream().map(ref -> ref.getImageId()).toList());
        assertEquals("@图片1[小狗] 和 @图片2[小狗]", plan.prompt());
        assertEquals(plan.saved(), StoryboardImageBindings.read(StoryboardImageBindings.write(plan.saved())));
        verifyNoInteractions(legacy);
    }

    @Test
    void attachesAnExplicitScriptReferenceEvenWhenTheGeneratedPromptOmitsIt() {
        when(images.list(any(Wrapper.class))).thenReturn(List.of(image(22L, "/dog-b.png")));
        when(urls.isSiteImageUrl("/dog-b.png")).thenReturn(true);
        when(urls.toRelativePath("/dog-b.png")).thenReturn("/dog-b.png");
        when(urls.toFullUrl("/dog-b.png")).thenReturn("https://assets.example.test/dog-b.png");
        var plan = bindings.resolve(shot(), "爷爷带着小狗", List.of(
                new StoryboardImageReference(1, "小狗", 22L, null)), true);
        assertEquals("爷爷带着小狗\n参考「小狗」对应 @图片1[小狗]", plan.prompt());
        assertEquals(List.of("https://assets.example.test/dog-b.png"), plan.urls());
    }

    @Test
    void rejectsAnUnavailableExplicitImageInsteadOfFallingBackToItsName() {
        var selected = List.of(new StoryboardImageReference(1, "小狗", 22L, "/dog-a.png"));
        assertThrows(ServiceException.class, () -> bindings.resolve(shot(), "@图片1[小狗]", selected, false));
        verifyNoInteractions(legacy);
    }

    @Test
    void preservesOwnedStorageLocatorsForQueuedDeliveryButRejectsThemAsClientInput() throws Exception {
        String owned = "https://assets.example.test/dog-b.png";
        String external = "https://outside.example.test/dog-a.png";
        String manifest = "[{\"imageId\":22,\"url\":\"" + owned + "\"},{\"url\":\"" + external + "\"}]";
        when(urls.isSiteMediaUrl(owned)).thenReturn(true);

        var request = new MediaImageGenerateRequest();
        request.setStoredReferenceImages(bindings.storedReferences(manifest, List.of(external, owned)));
        var json = new ObjectMapper();
        var payload = json.readTree(MediaTaskPayloadSanitizer.serializeRequest(request));
        assertEquals(1, payload.path("storedReferenceImages").size());
        assertEquals(owned, payload.path("storedReferenceImages").get(0).asText());
        assertEquals(null, json.readValue(payload.toString(), MediaImageGenerateRequest.class).getStoredReferenceImages());
    }

    private static AidStoryboard shot() {
        AidStoryboard shot = new AidStoryboard();
        shot.setProjectId(2572L);
        shot.setUserId(48L);
        return shot;
    }

    private static AidRolePropSceneFormImage image(long id, String url) {
        AidRolePropSceneFormImage image = new AidRolePropSceneFormImage();
        image.setId(id);
        image.setImageUrl(url);
        return image;
    }
}
