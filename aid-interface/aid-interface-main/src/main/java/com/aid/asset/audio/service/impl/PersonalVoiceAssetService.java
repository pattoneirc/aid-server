package com.aid.asset.audio.service.impl;

import java.io.IOException;
import java.util.Collection;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import com.aid.aid.domain.AidAudioAsset;
import com.aid.aid.service.IAidAudioAssetService;
import com.aid.aid.service.IOssBusinessService;
import com.aid.common.aid.oss.core.OssTemplate;
import com.aid.common.aid.oss.util.MediaUrlResolver;
import com.aid.common.exception.ServiceException;
import com.aid.common.exception.file.InvalidExtensionException;
import com.aid.common.utils.file.FileUploadUtils;
import com.aid.media.util.AudioDurationProber;
import com.aid.media.util.WavAudioSupport;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;

import cn.hutool.core.io.FileUtil;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;

@Service
@Slf4j
public class PersonalVoiceAssetService {
    private static final int UPLOADED_AUDIO = 2;
    private static final long MAX_AUDIO_BYTES = 32L * 1024 * 1024;
    private static final Set<String> AUDIO_FORMATS = Set.of("wav", "mp3");

    @Resource
    private IAidAudioAssetService audioAssets;

    @Resource
    private IOssBusinessService ossBusinessService;

    @Resource
    private OssTemplate ossTemplate;

    @Resource
    private MediaUrlResolver mediaUrlResolver;

    static void filterPersonalVoices(LambdaQueryWrapper<AidAudioAsset> query) {
        query.eq(AidAudioAsset::getAudioSource, UPLOADED_AUDIO)
                .isNull(AidAudioAsset::getProjectId)
                .isNull(AidAudioAsset::getAudioRecordId)
                .isNotNull(AidAudioAsset::getDurationMs);
    }

    public Map<Long, AidAudioAsset> findOwned(Collection<Long> ids, Long userId) {
        if (ids.isEmpty()) return Map.of();
        LambdaQueryWrapper<AidAudioAsset> query = Wrappers.<AidAudioAsset>lambdaQuery()
                .select(AidAudioAsset::getId, AidAudioAsset::getAssetTitle, AidAudioAsset::getAvatarUrl,
                        AidAudioAsset::getAudioUrl, AidAudioAsset::getAudioFormat, AidAudioAsset::getDurationMs)
                .eq(AidAudioAsset::getUserId, userId)
                .eq(AidAudioAsset::getDelFlag, "0")
                .in(AidAudioAsset::getId, ids);
        filterPersonalVoices(query);
        return audioAssets.list(query).stream().collect(Collectors.toMap(AidAudioAsset::getId, Function.identity()));
    }

    public AidAudioAsset requireOwned(Long id, Long userId) {
        AidAudioAsset asset = findOwned(List.of(id), userId).get(id);
        if (asset == null) throw new ServiceException("音频不存在");
        return asset;
    }

    public Long upload(MultipartFile file, String name, MultipartFile avatar, Long userId) {
        String title = validateName(name);
        validateAvatar(avatar);
        String format = FileUtil.extName(file.getOriginalFilename()).toLowerCase(Locale.ROOT);
        if (!AUDIO_FORMATS.contains(format)) throw new ServiceException("录音仅支持 WAV 或 MP3");
        if (file.isEmpty() || file.getSize() > MAX_AUDIO_BYTES) {
            throw new ServiceException("请上传不超过 32 MB 的录音");
        }
        Integer duration;
        try {
            byte[] bytes = file.getBytes();
            duration = WavAudioSupport.isWav(bytes) == "wav".equals(format)
                    ? AudioDurationProber.probeDurationMs(bytes) : null;
        } catch (IOException e) {
            throw new ServiceException("录音读取失败，请重新上传");
        }
        if (duration == null || duration <= 0) throw new ServiceException("无法读取录音，请检查文件格式");

        String audioUrl = store(file, "audio");
        String avatarUrl = null;
        try {
            if (avatar != null) avatarUrl = store(avatar, "image");
            AidAudioAsset asset = new AidAudioAsset();
            asset.setUserId(userId);
            asset.setAudioSource(UPLOADED_AUDIO);
            asset.setAssetTitle(title);
            asset.setAudioUrl(mediaUrlResolver.toRelativePath(audioUrl));
            asset.setAvatarUrl(avatarUrl == null ? null : mediaUrlResolver.toRelativePath(avatarUrl));
            asset.setDurationMs(duration);
            asset.setAudioFormat(format);
            asset.setFileSize(file.getSize());
            asset.setDelFlag("0");
            asset.setCreateBy(userId.toString());
            asset.setCreateTime(new Date());
            if (!audioAssets.save(asset)) throw new ServiceException("录音保存失败");
            return asset.getId();
        } catch (RuntimeException e) {
            discardUpload(audioUrl);
            discardUpload(avatarUrl);
            throw e;
        }
    }

    public void update(Long id, String name, MultipartFile avatar, boolean resetAvatar, Long userId) {
        requireOwned(id, userId);
        String title = validateName(name);
        if (resetAvatar && avatar != null) throw new ServiceException("请选择一种头像操作");
        validateAvatar(avatar);
        String avatarUrl = avatar == null ? null : store(avatar, "image");
        try {
            boolean saved = audioAssets.update(Wrappers.<AidAudioAsset>lambdaUpdate()
                    .eq(AidAudioAsset::getId, id)
                    .eq(AidAudioAsset::getUserId, userId)
                    .eq(AidAudioAsset::getDelFlag, "0")
                    .set(AidAudioAsset::getAssetTitle, title)
                    .set(resetAvatar || avatarUrl != null, AidAudioAsset::getAvatarUrl,
                            avatarUrl == null ? null : mediaUrlResolver.toRelativePath(avatarUrl))
                    .set(AidAudioAsset::getUpdateBy, userId.toString())
                    .set(AidAudioAsset::getUpdateTime, new Date()));
            if (!saved) throw new ServiceException("音频不存在");
        } catch (RuntimeException e) {
            discardUpload(avatarUrl);
            throw e;
        }
    }

    private static String validateName(String name) {
        String title = name.strip();
        if (title.isEmpty() || title.length() > 128) throw new ServiceException("展示名称需为 1 至 128 字");
        return title;
    }

    private void validateAvatar(MultipartFile avatar) {
        if (avatar == null) return;
        try {
            FileUploadUtils.assertFileTypeAllowed(avatar, new String[]{"png", "jpg", "jpeg"});
        } catch (InvalidExtensionException e) {
            throw new ServiceException("头像须为 PNG 或 JPEG 图片");
        }
        ossTemplate.validate(avatar);
    }

    private String store(MultipartFile file, String directory) {
        return ossBusinessService.uploadList(List.of(file), directory).get(0).getUrl();
    }

    private void discardUpload(String url) {
        if (url == null) return;
        try {
            ossBusinessService.deleteListByUrl(List.of(url));
        } catch (RuntimeException e) {
            log.warn("未能清理未登记的个人音色文件", e);
        }
    }
}
