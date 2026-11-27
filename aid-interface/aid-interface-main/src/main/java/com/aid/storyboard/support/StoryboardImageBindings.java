package com.aid.storyboard.support;

import com.aid.aid.domain.AidRolePropSceneFormImage;
import com.aid.aid.domain.AidStoryboard;
import com.aid.aid.service.IAidRolePropSceneFormImageService;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.common.exception.ServiceException;
import com.aid.rps.resolver.StoryboardImageReferenceResolver;
import com.aid.storyboard.dto.StoryboardImageReference;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/** 将分镜中明确选中的原图和兼容名称引用组装为同一份有序图片列表。 */
@Component
@RequiredArgsConstructor
public class StoryboardImageBindings {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern TOKEN = Pattern.compile("@图片(\\d{1,9})\\[([^\\]]+)\\]");
    private static final int MAX_SAVED_REFERENCES = 64;

    private final IAidRolePropSceneFormImageService images;
    private final MediaUrlResolver urls;
    private final StoryboardImageReferenceResolver legacyResolver;

    public record Plan(String prompt, List<StoryboardImageReference> saved, List<String> urls,
                       List<StoryboardImageReferenceResolver.ResolvedImageReference> manifest) {
    }

    public static List<StoryboardImageReference> read(String json) {
        if (json == null) return null;
        try {
            return JSON.readValue(json, new TypeReference<>() {});
        } catch (JsonProcessingException ex) {
            throw new ServiceException("分镜参考图记录不完整，请重新选择");
        }
    }

    public static String write(List<StoryboardImageReference> references) {
        try {
            return JSON.writeValueAsString(references);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("分镜参考图序列化失败", ex);
        }
    }

    public List<StoryboardImageReference> forDisplay(String json) {
        List<StoryboardImageReference> references = read(json);
        return references == null ? null : references.stream()
                .map(ref -> new StoryboardImageReference(ref.index(), ref.name(), ref.imageId(),
                        urls.toFullUrl(ref.sourceUrl())))
                .toList();
    }

    /** Only owned asset rows selected into the manifest may use the storage reader. */
    public List<String> storedReferences(String manifest, List<String> requestUrls) {
        try {
            var stored = new HashSet<String>();
            for (var reference : JSON.readTree(manifest)) {
                String url = reference.path("url").asText(null);
                if (url != null && reference.hasNonNull("imageId") && urls.isSiteMediaUrl(url)) stored.add(url);
            }
            return requestUrls.stream().filter(stored::contains).toList();
        } catch (JsonProcessingException ex) {
            throw new ServiceException("分镜参考图清单无效");
        }
    }

    public List<StoryboardImageReference> validate(AidStoryboard shot, List<StoryboardImageReference> references) {
        if (references.size() > MAX_SAVED_REFERENCES) throw new ServiceException("分镜参考图数量超限");
        if (references.stream().anyMatch(Objects::isNull)) throw new ServiceException("分镜参考图格式无效");
        List<Long> ids = references.stream().map(StoryboardImageReference::imageId)
                .filter(Objects::nonNull).distinct().toList();
        Map<Long, AidRolePropSceneFormImage> fromProject = ids.isEmpty() ? Map.of() : images.list(
                Wrappers.<AidRolePropSceneFormImage>lambdaQuery()
                        .select(AidRolePropSceneFormImage::getId, AidRolePropSceneFormImage::getImageUrl)
                        .eq(AidRolePropSceneFormImage::getUserId, shot.getUserId())
                        .eq(AidRolePropSceneFormImage::getProjectId, shot.getProjectId())
                        .eq(AidRolePropSceneFormImage::getDelFlag, "0")
                        .in(AidRolePropSceneFormImage::getId, ids))
                .stream().collect(Collectors.toMap(AidRolePropSceneFormImage::getId, Function.identity()));
        List<StoryboardImageReference> validated = new ArrayList<>();
        for (StoryboardImageReference ref : references) {
            String name = ref.name() == null ? "" : ref.name().replace("]", "）").strip();
            if (name.isBlank() || name.length() > 255 || ref.index() == null || ref.index() < 1) {
                throw new ServiceException("分镜参考图格式无效");
            }
            AidRolePropSceneFormImage stored = ref.imageId() == null ? null : fromProject.get(ref.imageId());
            String source = ref.imageId() == null ? ref.sourceUrl()
                    : stored == null ? null : stored.getImageUrl();
            if (source == null || !urls.isSiteImageUrl(source)) {
                throw new ServiceException("参考图「" + name + "」已失效，请重新选择");
            }
            validated.add(new StoryboardImageReference(ref.index(), name, ref.imageId(),
                    urls.toRelativePath(source)));
        }
        return validated;
    }

    public Plan resolve(AidStoryboard shot, String prompt, List<StoryboardImageReference> selected, boolean fromScript) {
        List<StoryboardImageReference> explicit = validate(shot, selected);
        Map<Integer, String> names = new TreeMap<>();
        Matcher matcher = TOKEN.matcher(prompt);
        while (matcher.find()) names.putIfAbsent(Integer.parseInt(matcher.group(1)), matcher.group(2));
        int nextIndex = names.keySet().stream().mapToInt(Integer::intValue).max().orElse(0) + 1;
        Map<Integer, StoryboardImageReference> byIndex = new LinkedHashMap<>();
        for (StoryboardImageReference ref : explicit) {
            int index = ref.index();
            if (fromScript) {
                index = names.entrySet().stream()
                        .filter(entry -> !byIndex.containsKey(entry.getKey()) && entry.getValue().equals(ref.name()))
                        .map(Map.Entry::getKey).findFirst().orElse(nextIndex);
            }
            if (byIndex.putIfAbsent(index, ref) != null) throw new ServiceException("参考图编号冲突，请重新选择");
            if (!names.containsKey(index)) {
                names.put(index, ref.name());
                prompt += "\n参考「" + ref.name() + "」对应 " + token(index, ref.name());
                nextIndex = Math.max(nextIndex, index + 1);
            }
        }
        String legacyTokens = names.entrySet().stream().filter(entry -> !byIndex.containsKey(entry.getKey()))
                .map(entry -> token(entry.getKey(), entry.getValue())).collect(Collectors.joining("\n"));
        Map<Integer, StoryboardImageReferenceResolver.ResolvedImageReference> legacy = legacyTokens.isEmpty()
                ? Map.of() : legacyResolver.resolveRich(legacyTokens, shot.getProjectId(), shot.getUserId())
                        .stream().collect(Collectors.toMap(StoryboardImageReferenceResolver.ResolvedImageReference::getN,
                                Function.identity()));
        Map<String, Integer> indexByUrl = new LinkedHashMap<>();
        Map<Integer, Integer> compact = new LinkedHashMap<>();
        List<StoryboardImageReferenceResolver.ResolvedImageReference> manifest = new ArrayList<>();
        List<StoryboardImageReference> saved = new ArrayList<>();
        Set<Integer> savedIndexes = new HashSet<>();
        for (var entry : names.entrySet()) {
            StoryboardImageReference direct = byIndex.get(entry.getKey());
            var ref = legacy.get(entry.getKey());
            if (direct != null) {
                ref = new StoryboardImageReferenceResolver.ResolvedImageReference();
                ref.setName(direct.name());
                ref.setAssetName(direct.name());
                ref.setImageId(direct.imageId());
                ref.setType(StoryboardImageReferenceResolver.RefType.REFERENCE);
                ref.setUrl(urls.toFullUrl(direct.sourceUrl()));
            }
            if (ref == null || ref.getUrl() == null) continue;
            Integer index = indexByUrl.get(ref.getUrl());
            if (index == null) {
                index = manifest.size() + 1;
                indexByUrl.put(ref.getUrl(), index);
                ref.setN(index);
                manifest.add(ref);
            }
            compact.put(entry.getKey(), index);
            if (direct != null && savedIndexes.add(index)) {
                saved.add(new StoryboardImageReference(index, direct.name(), direct.imageId(), direct.sourceUrl()));
            }
        }
        String rewritten = TOKEN.matcher(prompt).replaceAll(match -> {
            Integer index = compact.get(Integer.parseInt(match.group(1)));
            return Matcher.quoteReplacement(index == null ? match.group(2) : token(index, manifest.get(index - 1).getName()));
        });
        return new Plan(rewritten, saved, new ArrayList<>(indexByUrl.keySet()), manifest);
    }

    private static String token(int index, String name) {
        return "@图片" + index + "[" + name + "]";
    }
}
