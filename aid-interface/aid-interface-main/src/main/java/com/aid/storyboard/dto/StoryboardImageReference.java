package com.aid.storyboard.dto;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "分镜参考图。项目形态图使用 imageId，导入图片使用本站存储路径。")
public record StoryboardImageReference(Integer index, String name,
        @JsonSerialize(using = ToStringSerializer.class) Long imageId, String sourceUrl)
{
}
