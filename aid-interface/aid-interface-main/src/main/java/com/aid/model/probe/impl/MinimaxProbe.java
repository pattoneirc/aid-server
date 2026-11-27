package com.aid.model.probe.impl;

import java.util.Objects;

import org.springframework.stereotype.Component;

import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.aid.aid.domain.AidAiModel;
import com.aid.aid.domain.AidAiProvider;
import com.aid.model.probe.ProbeResult;
import com.aid.common.utils.ProviderEndpointUtils;


/**
 * MiniMax 视频任务列表只读探测。
 */
@Component
public class MinimaxProbe extends AbstractReadOnlyProbe {

    private static final String PROVIDER_CODE = "minimax";

    @Override
    public String protocol() {
        return null;
    }

    @Override
    public String providerCode() {
        return PROVIDER_CODE;
    }

    @Override
    protected String resolvePath(AidAiModel model, AidAiProvider provider) {
        String template = ProviderEndpointUtils.normalizeTaskQueryTemplate(provider.getTaskQuerySuffix());
        String listPath = template.replaceAll("/%s(?:\\?.*)?$", "");
        if (Objects.equals(listPath, template)) {
            throw new IllegalArgumentException("查询路径无法推导列表");
        }
        return ProbeHttpSupport.addQuery(listPath, "page_num", "1") + "&page_size=1";
    }

    @Override
    protected ProbeResult interpret(AidAiModel model, AidAiProvider provider, ProbeHttpResponse response) {
        if (!ProbeHttpSupport.isHttpSuccess(response)) {
            return ProbeHttpSupport.unexpected(response);
        }
        JSONObject root = ProbeHttpSupport.parseObject(response.body());
        if (Objects.isNull(root)) {
            return ProbeHttpSupport.unexpected(response);
        }
        JSONArray items = root.getJSONArray("items");
        if (Objects.nonNull(items)) {
            return ProbeResult.ok("鉴权查询正常");
        }
        return ProbeHttpSupport.unexpected(response);
    }

}
