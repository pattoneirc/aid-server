package com.aid.aid.controller;

import com.aid.common.core.domain.AjaxResult;
import com.aid.model.requestlog.ModelRequestLogStore;
import com.aid.model.requestlog.ModelRequestLogStore.Settings;
import java.io.IOException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/aid/model-request-log")
public class ModelRequestLogController {
    private final ModelRequestLogStore logs;

    public ModelRequestLogController(ModelRequestLogStore logs) {
        this.logs = logs;
    }

    @PreAuthorize("@ss.hasPermi('system:model-request-log:list')")
    @GetMapping
    public AjaxResult list(@RequestParam(required = false) String type,
                           @RequestParam(required = false) String provider,
                           @RequestParam(required = false) String model,
                           @RequestParam(required = false) Long before,
                           @RequestParam(defaultValue = "30") int size) {
        return AjaxResult.success(logs.list(type, provider, model, before, size));
    }

    @PreAuthorize("@ss.hasPermi('system:model-request-log:detail')")
    @GetMapping("/{id}")
    public AjaxResult detail(@PathVariable long id) {
        try { return AjaxResult.success((Object) logs.detail(id)); }
        catch (IOException unavailable) { return AjaxResult.error("日志正文已清理或不可用"); }
    }

    @PreAuthorize("@ss.hasPermi('system:model-request-log:manage')")
    @GetMapping("/settings")
    public AjaxResult settings() { return AjaxResult.success(logs.status()); }

    @PreAuthorize("@ss.hasPermi('system:model-request-log:manage')")
    @PutMapping("/settings")
    public AjaxResult save(@RequestBody Settings settings) {
        try { return AjaxResult.success(logs.save(settings)); }
        catch (IllegalArgumentException invalid) { return AjaxResult.error("请核对日志类型、目录和保留范围"); }
        catch (IOException unavailable) { return AjaxResult.error("日志目录不可写或与公开资源目录冲突"); }
    }
}
