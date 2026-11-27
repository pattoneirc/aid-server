package com.aid.compose.domain;

import com.aid.enums.AspectRatioEnum;

import java.util.Locale;

/** 项目成片画幅在分辨率档内可用的最大偶数像素尺寸。 */
public record ComposeFrameSize(int width, int height)
{
    public static ComposeFrameSize resolve(String resolution, String aspectRatio)
    {
        AspectRatioEnum ratio = AspectRatioEnum.getByValue(aspectRatio);
        if (ratio == null)
        {
            return null;
        }

        String[] units = ratio.getValue().split(":");
        int horizontal = Integer.parseInt(units[0]);
        int vertical = Integer.parseInt(units[1]);
        int divisor = gcd(horizontal, vertical);
        horizontal /= divisor;
        vertical /= divisor;
        String tier = resolution == null ? "FHD" : resolution.trim().toUpperCase(Locale.ROOT);
        int[] bounds = switch (tier)
        {
            case "SD" -> new int[] {854, 480};
            case "HD" -> new int[] {1280, 720};
            case "2K" -> new int[] {2560, 1440};
            case "4K" -> new int[] {3840, 2160};
            default -> new int[] {1920, 1080};
        };
        boolean landscape = horizontal >= vertical;
        int maxWidth = bounds[landscape ? 0 : 1];
        int maxHeight = bounds[landscape ? 1 : 0];
        int multiplier = Math.min(maxWidth / horizontal, maxHeight / vertical);
        multiplier -= multiplier % 2;
        return new ComposeFrameSize(horizontal * multiplier, vertical * multiplier);
    }

    private static int gcd(int first, int second)
    {
        while (second != 0)
        {
            int remainder = first % second;
            first = second;
            second = remainder;
        }
        return first;
    }
}
