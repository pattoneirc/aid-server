package com.aid.common.storage;

import java.nio.file.Path;
import java.util.*;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

@Component
public final class CoreLocalStorageAreas implements LocalStorageAreaProvider {
    public List<Area> areas(Environment env,Path profile){
        Path home=Path.of(System.getProperty("user.home")),privateRoot=profile.resolveSibling(profile.getFileName()+"-private");
        Path reasoning=Path.of(env.getProperty("assistant.reasoning-archive.directory",home.resolve(".aid-private/reasoning").toString()));
        return List.of(
            area(env,"aid.skill.mirror-root","skill-packages",Path.of(System.getProperty("java.io.tmpdir"),"aid-private","skill-packages")),
            area(env,"assistant.reasoning-archive.directory","reasoning",reasoning),
            area(env,"assistant.native-turn-archive.directory","reasoning/native-turns",reasoning.resolve("native-turns")),
            area(env,"aid.assistant.source.private-storage-root","assistant-source",profile.resolveSibling(".aid-private").resolve("assistant-source")),
            area(env,"canvas.publication.storage-root","canvas-publication",privateRoot.resolve("canvas-publication")),
            area(env,"log.archive.path","log-archive",Path.of("./log-archive").toAbsolutePath()),
            area(env,"aid.model-request-log.directory","aid-model-request-logs",privateRoot.resolve("aid-model-request-logs")),
            area(env,"aid.error-rule-cache.directory","cache",home.resolve(".aid/cache")),
            area(env,"assistant.session-archive.directory","assistant-sessions",privateRoot.resolve("assistant-sessions")));
    }
    private Area area(Environment e,String property,String relative,Path fallback){
        String value=e.getProperty(property);return new Area(property,relative,value==null||value.isBlank()?fallback:Path.of(value).toAbsolutePath().normalize());
    }
    public Set<String> dependentBeans(){return Set.of("tomcatServletWebServerFactory","multipartConfigElement","aidAppConfig","resourcesConfig","ossConfigManager","errorRuleCache","logArchiveServiceImpl","ffmpegRuntimeValidator","skillPackageDiskMirror","assistantReasoningArchive","nativeAssistantTurnArchive","privateAssistantSourceBlobStore","canvasPublicationFiles","canvasPublicationMediaStore","modelHealthArchiveServiceImpl","tokenDanceCatalogManager","assistantSessionDeletionService","modelRequestLogStore");}
}
