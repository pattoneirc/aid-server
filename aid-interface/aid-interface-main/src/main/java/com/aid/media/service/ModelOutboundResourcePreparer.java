package com.aid.media.service;

import org.springframework.stereotype.Service;

import com.aid.domain.vo.AiModelConfigVo;
import com.aid.media.dto.MediaAudioGenerateRequest;
import com.aid.media.dto.MediaImageGenerateRequest;
import com.aid.media.dto.MediaTextGenerateRequest;
import com.aid.media.dto.MediaVideoGenerateRequest;

import lombok.RequiredArgsConstructor;

/**
 * Provider 提交前的统一资源准备入口。任务快照保持原地址，重试时按存储标准访问规则重新签名。
 */
@Service
@RequiredArgsConstructor
public class ModelOutboundResourcePreparer
{
    private final ManagedTextImageService managedImages;
    private final ModelResourceUrlSigner signer;

    public void prepare(AiModelConfigVo config, MediaImageGenerateRequest request) {
        prepare(config, request, com.aid.media.provider.ImageProviderClient.InputDelivery.URL);
    }

    protected java.util.Map<String, java.util.function.Supplier<com.aid.media.provider.ImageEditAssetSupport.BinaryImage>>
    authorizedImageLoaders(MediaImageGenerateRequest request) {
        java.util.Map<String, java.util.function.Supplier<com.aid.media.provider.ImageEditAssetSupport.BinaryImage>> loaders = new java.util.LinkedHashMap<>();
        if (request.getManagedReferenceImages() != null) request.getManagedReferenceImages().forEach((url, reference) ->
                loaders.put(url, () -> com.aid.media.provider.ImageEditAssetSupport.decodeBinary(
                        managedImages.resolve(request.getUserId(), reference).bytes(), "图片素材")));
        if (request.getStoredReferenceImages() != null) {
            var slots = com.aid.media.provider.ImageInputExecutionScope.slots(request).values();
            for (String locator : request.getStoredReferenceImages()) {
                if (!slots.contains(locator)) throw new IllegalArgumentException("IMAGE_STORAGE_REFERENCE_INVALID");
                loaders.putIfAbsent(locator, () -> com.aid.media.provider.ImageEditAssetSupport.readStoredReference(locator));
            }
        }
        return loaders;
    }

    public void prepare(AiModelConfigVo config, MediaImageGenerateRequest request,
                        com.aid.media.provider.ImageProviderClient.InputDelivery delivery) {
        if (request == null) return;
        var scope = com.aid.media.provider.ImageInputExecutionScope.current();
        if (scope != null) {
            scope.register(request, authorizedImageLoaders(request));
            scope.verifyRegistered();
        } else {
            com.aid.media.provider.ImageEditAssetSupport.verifyAuthorizedAssets(request);
        }
        var before = com.aid.media.provider.ImageInputExecutionScope.slots(request);
        if (delivery == com.aid.media.provider.ImageProviderClient.InputDelivery.URL) signer.sign(request);
        var after = com.aid.media.provider.ImageInputExecutionScope.slots(request);
        if (scope != null) scope.bindDelivery(before, after);
        // Read and validate every binary input before entering the model submission boundary.
        if (delivery == com.aid.media.provider.ImageProviderClient.InputDelivery.INLINE
                && com.aid.media.provider.ReferenceImageBase64Support.isBase64Enabled(config))
            com.aid.media.provider.ReferenceImageBase64Support.verifyInputs(new java.util.ArrayList<>(after.values()));
        else if (delivery != com.aid.media.provider.ImageProviderClient.InputDelivery.URL)
            for (String value : after.values()) com.aid.media.provider.ImageEditAssetSupport.read(value, "参考图");
        if (delivery == com.aid.media.provider.ImageProviderClient.InputDelivery.URL)
            for (String value : after.values()) {
                if (value.startsWith("data:image/")) continue;
                try {
                    var uri = java.net.URI.create(value);
                    if (uri.getScheme() == null || !java.util.Set.of("http", "https").contains(uri.getScheme()) || uri.getHost() == null)
                        throw new IllegalArgumentException();
                } catch (IllegalArgumentException invalid) {
                    throw com.aid.media.provider.ProviderSubmissionFailures.notSent("当前模型需要可访问的图片资源地址，请核对存储访问配置");
                }
            }
    }

    public void prepare(AiModelConfigVo config, MediaVideoGenerateRequest request)
    {
        // Tencent CI stages registered media directly inside the configured COS bucket.
        // Replacing the registered CDN URL with a signed COS URL here would hide the
        // trusted bucket object path from that staging step and force an external download.
        if (config == null || !"tencent_ci_media".equalsIgnoreCase(config.getProviderCode()))
        {
            signer.sign(request);
        }
    }

    public void prepare(AiModelConfigVo config, MediaAudioGenerateRequest request)
    {
        signer.sign(request);
    }

    public void prepare(AiModelConfigVo config, MediaTextGenerateRequest request)
    {
        signer.sign(request);
    }
}
