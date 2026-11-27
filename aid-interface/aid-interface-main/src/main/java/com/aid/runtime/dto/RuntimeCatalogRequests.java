package com.aid.runtime.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

public final class RuntimeCatalogRequests {
    private RuntimeCatalogRequests() { }

    @Data public static class GroupPage {
        @Size(max = 64) private String parentCode;
        @Min(1) private Integer pageNum = 1;
        @Min(1) @Max(100) private Integer pageSize = 20;
    }

    @Data public static class MemberPage {
        @NotBlank @Size(max = 64) private String groupCode;
        @Min(1) private Integer pageNum = 1;
        @Min(1) @Max(100) private Integer pageSize = 20;
    }

    @lombok.EqualsAndHashCode(callSuper = false)
    @Data public static class ModelPage extends MemberPage { }
}
