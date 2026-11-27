package com.aid.model.definition;

import com.aid.aid.domain.media.AidMediaTask;
import com.aid.compose.ComposeConstants;
import com.aid.domain.vo.AiModelConfigVo;
import com.aid.common.utils.ProviderEndpointUtils;
import com.aid.service.IAiModelConfigService;
import com.aid.tokendance.credential.TokenDanceCredentialStore;
import com.aid.tokendance.credential.TokenDanceTaskRouteSnapshot;
import com.alibaba.fastjson2.JSON;
import lombok.RequiredArgsConstructor;
import java.util.Objects;
import org.springframework.stereotype.Service;

/** 排队提交、调度补偿与轮询共用任务提交时的路由。 */
@Service
@RequiredArgsConstructor
public class ModelTaskConfigurationResolver {
    private final IAiModelConfigService configurations;
    private final TokenDanceCredentialStore tokenDanceCredentials;

    public AiModelConfigVo resolve(AidMediaTask task) {
        if (task == null || task.getModelName() == null) return null;
        String snapshot = task.getProviderRouteSnapshotJson();
        if (ModelTaskRouteSnapshot.supports(snapshot)) {
            var route = JSON.parseObject(snapshot);
            Long modelId = route.getLong("id");
            Long revision = route.getLong("dedicatedConnectionRevision");
            return ModelTaskRouteSnapshot.restore(snapshot, revision == null
                    ? configurations.selectTaskCredentials(modelId, task.getModelName(), task.getUserId())
                    : configurations.selectDedicatedTaskCredentials(modelId, task.getModelName(), revision));
        }
        if (snapshot != null && !snapshot.isBlank()) return TokenDanceTaskRouteSnapshot.restore(snapshot, tokenDanceCredentials);
        if (ComposeConstants.MEDIA_TYPE_COMPOSE.equals(task.getMediaType())) return configurations.selectByModelCode(task.getModelName());
        return configurations.selectByModelCodeForUser(task.getModelName(), task.getUserId());
    }

    /**
     * 查询路径属于可修复的运维配置，不得把错误路径永久冻结在历史任务中。
     * 仅在原供应商、网关和协议仍一致时使用当前查询路径；提交与计费仍使用原快照。
     */
    public AiModelConfigVo resolveForQuery(AidMediaTask task) {
        if (task == null || !ModelTaskRouteSnapshot.supports(task.getProviderRouteSnapshotJson())) {
            return resolve(task);
        }
        var snapshot = JSON.parseObject(task.getProviderRouteSnapshotJson());
        Long modelId = snapshot.getLong("id");
        if (snapshot.getLong("dedicatedConnectionRevision") != null) return resolve(task);
        String capabilityCode = snapshot.getString("capabilityCode");
        String bindingCode = snapshot.getString("bindingCode");
        AiModelConfigVo current = (capabilityCode == null || capabilityCode.isBlank())
                && (bindingCode == null || bindingCode.isBlank())
                ? configurations.selectTaskCredentials(modelId, task.getModelName(), task.getUserId())
                : configurations.selectTaskCredentials(modelId, task.getModelName(), task.getUserId(), capabilityCode, bindingCode);
        String currentQueryPath = current == null ? null : current.getTaskQuerySuffix();
        boolean sameProtocol = current != null && task.getProtocol() != null
                && Objects.equals(task.getProtocol(), current.getProtocol());
        // restore 校验原供应商和网关，并会覆盖 current；须在调用前保存查询配置。
        AiModelConfigVo restored = ModelTaskRouteSnapshot.restore(task.getProviderRouteSnapshotJson(), current);
        if (sameProtocol && currentQueryPath != null && !currentQueryPath.isBlank()) {
            restored.setTaskQuerySuffix(ProviderEndpointUtils.normalizeTaskQueryTemplate(currentQueryPath));
        }
        return restored;
    }
}
