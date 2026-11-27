package com.aid.model.probe.impl;

import com.aid.aid.domain.AidAiModel;
import com.aid.aid.domain.AidAiProvider;
import com.aid.common.utils.ProviderEndpointUtils;
import com.aid.media.constants.VolcengineConstants;
import com.aid.model.probe.ProbeResult;
import org.springframework.stereotype.Component;

import java.util.concurrent.ThreadLocalRandom;

/** Sand Ark 兼容接口仅提供已知 ID 的只读查询。 */
@Component
public class SandAiProbe extends AbstractReadOnlyProbe {
    @Override
    public String protocol() {
        return null;
    }

    @Override
    public String providerCode() {
        return "sand_ai";
    }

    @Override
    public boolean requiresModel() {
        return true;
    }

    @Override
    public boolean supportsModel(AidAiModel model) {
        return model != null && VolcengineConstants.PROTOCOL_SEEDANCE_VIDEO.equals(model.getProtocol());
    }

    @Override
    protected String resolvePath(AidAiModel model, AidAiProvider provider) {
        long id = ThreadLocalRandom.current().nextLong(1_000_000_000_000_000_000L, Long.MAX_VALUE);
        return ProviderEndpointUtils.normalizeTaskQueryTemplate(provider.getTaskQuerySuffix())
                .replace("%s", Long.toString(id));
    }

    @Override
    protected ProbeResult interpret(AidAiModel model, AidAiProvider provider, ProbeHttpResponse response) {
        var root = ProbeHttpSupport.parseObject(response.body());
        var error = root == null ? null : root.getJSONObject("error");
        if (response.status() == 404 && error != null && "ResourceNotFound".equals(error.getString("code"))) {
            return ProbeResult.ok("鉴权查询正常，余额和生成权限未验证");
        }
        return ProbeHttpSupport.unexpected(response);
    }
}
