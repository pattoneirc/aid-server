package com.aid.compose.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ComposeFrameSizeTest
{
    @Test
    void fitsTheProjectAspectRatioWithinTheResolutionTier()
    {
        assertEquals(new ComposeFrameSize(1920, 1080), ComposeFrameSize.resolve("FHD", "16:9"));
        assertEquals(new ComposeFrameSize(720, 1280), ComposeFrameSize.resolve("HD", "9:16"));
        assertEquals(new ComposeFrameSize(1080, 1080), ComposeFrameSize.resolve("FHD", "1:1"));
        assertEquals(new ComposeFrameSize(1918, 822), ComposeFrameSize.resolve("FHD", "21:9"));
    }

    @Test
    void leavesLegacySourceBasedSizingAvailable()
    {
        assertNull(ComposeFrameSize.resolve("FHD", null));
        assertNull(ComposeFrameSize.resolve("FHD", "adaptive"));
    }
}
