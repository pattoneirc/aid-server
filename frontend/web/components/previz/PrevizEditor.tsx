"use client";

import { digestSha256Hex } from "@/utils/sha256";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { App, Button, Modal } from "antd";
import {
  CheckOutlined,
  CloseOutlined,
  DownloadOutlined,
  FileImageOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  CameraOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type {
  PrevizAnnotation,
  PrevizCommand,
  PrevizWorkingCopyStore,
  PrevizNode,
  PrevizProject,
  PrevizScene,
} from "@/types/previz";
import type { CanvasSceneAdoption } from "@/types/canvas-api";
import { previzArchivedBuildSteps, previzAutomaticAdoptionSteps, previzBuildToolCodes, type PrevizAutomaticAdoptionCandidate } from "@/utils/previz/automaticBuildAdoption";
import {
  copy,
  applyCommands,
  createNode,
  PREVIZ_KINDS,
  uid,
} from "@/utils/previz/core";
import {
  dataUrlBytes,
  inspectGlb,
  exportGlb,
  buildRuntime,
} from "@/utils/previz/runtime";
import {
  downloadPreviz,
  exportScreenshot,
  exportVideo,
  fileDataUrl,
  projectPackage,
} from "@/utils/previz/export";
import { StudioCanvasAssistantAction, StudioCanvasAssistantTurn } from "@/components/studio/shell/StudioCanvasAssistantTurn";
import { BoxMark, Choice, NumberField, Tool } from "./PrevizControls";
import type { usePrevizSession } from "./usePrevizSession";
import { PrevizInspector } from "./PrevizInspector";
import { PrevizAdoptionScopeDialog } from "./PrevizAdoptionScopeDialog";
import { PrevizTimelineRows } from "./PrevizTimeline";
import { PrevizObjectList } from "./PrevizObjectList";
import { useDirectorPlaybackStore } from "@/components/studio/director/directorPlaybackStore";
import { moveTrackKey } from "@/utils/previz/interaction";
import { AssistantSessionPanel, type AssistantComposerDraftStore } from "@/components/assistant/AssistantSessionPanel";
import { PrevizAgentActionGlyph } from "./PrevizAgentVisuals";
import { StudioCanvasTooltip } from "@/components/studio/canvas/StudioCanvasTooltip";
import { PrevizAssistantDock } from "./PrevizAssistantDock";
import { PrevizComposerAttachments } from "./PrevizComposerAttachments";
import { PrevizAgentDock } from "./PrevizAgentDock";
import { PrevizBuildFiles } from "./PrevizBuildFiles";
import { PrevizBuildResult } from "./PrevizBuildResult";
import { usePrevizAssistantIdentity } from "./usePrevizAssistantIdentity";
import { openLoginModal } from "@/stores/loginModal";
import { mainAssistantTransport } from "@/utils/business/assistant";
import { previzAssistantTransport } from "@/utils/previz/assistantTransport";
import { createPrevizWorkspaceApi, type PrevizBuildArtifact, type PrevizEditorSnapshot, type PrevizTextModelOptions, type PrevizSceneEditReceipt } from "@/utils/previz/remoteWorkspace";
import { unpackProjectDocument } from "@/utils/previz/projectDocument";
import { mergePublishedSceneEdit } from "@/utils/previz/sceneEditMerge";
import {ModelBillingRules} from "@/components/common/ModelBillingRules";
import { editorSceneDigest } from "@/utils/previz/editorSnapshot";
import { assessGlbReplacement } from "@/utils/previz/adoptionSafety";
import { glbObjectsFromDocument, type GlbObject } from "@/utils/previz/glbObjects";
import { scopedBuildCommands, type PrevizBuildOperation } from "@/utils/previz/buildAdoption";
import { PrevizPreviewResult } from "./PrevizPreviewResult";
import { usePrevizCloudSave } from "./usePrevizCloudSave";
import { PREVIZ_GLB_MAX_BYTES } from "@/utils/previz/limits";
import { previzBuildArtifactBytes } from "@/utils/previz/buildArtifactBytes";
import { previzEditorSourceBinding, preparePrevizEditorSnapshot } from "@/utils/previz/editorSourceBinding";
import { resizePrevizShot } from '@/utils/previz/shotEditing';
import { generatedCameraChoices, initialGeneratedCameraShot } from '@/utils/previz/generatedCameras';
import { createFollowCamera } from '@/utils/previz/followCamera';
import { PrevizFollowCamera } from './PrevizFollowCamera';
import type { AssistantSessionSnapshot, AssistantContextRef } from "@/types/assistant-api";
import { assistantErrorMessage } from "@/utils/assistant/assistantRequestCoordinator";
import { previzRunFeedback } from "@/utils/previz/runFeedback";
import { notifyStudioGenerationComplete, requestStudioDesktopNotificationPermission, studioGenerationCompleteNotice } from "@/utils/studio/studioDesktopNotification";

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export type PrevizEditorSession = Omit<ReturnType<typeof usePrevizSession>, 'flush'> & {
  flush: (adoption?: Omit<CanvasSceneAdoption, 'sceneId'>) => Promise<void>;
  canvasManaged?: boolean;
};
export interface PrevizAuthoringTools {
  primitives: ReactNode;
  objects: { count: number; render: (search: string) => ReactNode };
  cameras: { count: number; render: (search: string) => ReactNode };
  assets: ReactNode;
  inspector: ReactNode;
  assistant: (tools: ReactNode) => ReactNode;
  exposure: ReactNode;
  timeline: (frameCount: number) => ReactNode;
  status: ReactNode;
  openProjects: () => void;
  openHistory: () => void;
  openExport: () => void;
  openAnnotation: () => void;
}

export function PrevizAuthoring({
  initial, owner, session, selection, onSelect, capture, getCameraSnapshot, onPreviewCamera,
  onOpenProjects, onOpenInspector, onDeleteObject, children,
}: {
  initial: PrevizProject;
  owner: string;
  session: PrevizEditorSession;
  selection: { id: string; objectId?: string };
  onSelect: (id: string, objectId?: string) => void;
  capture: () => string;
  getCameraSnapshot: (cameraId?: string) => Pick<PrevizNode, "localTransform" | "camera"> | undefined;
  onPreviewCamera: (cameraId: string) => void;
  onOpenProjects: () => void;
  onOpenInspector: () => void;
  onDeleteObject: (id: string) => void;
  children: (tools: PrevizAuthoringTools) => ReactNode;
}) {
  const { project, ref, mutate, execute, flush } = session,
    scene = project.scene;
  const pendingAdoption = useRef<Omit<CanvasSceneAdoption, 'sceneId'> | undefined>(undefined);
  const cloudSave = usePrevizCloudSave(project,()=>ref.current,flush,patch=>mutate(p=>({...p,...patch})), !session.canvasManaged);
  const flushAdoption = async (adoption: Omit<CanvasSceneAdoption, 'sceneId'>) => {
    pendingAdoption.current = adoption;
    await flush(adoption);
    if (pendingAdoption.current === adoption) pendingAdoption.current = undefined;
  };
  const selected = selection.id;
  const selectedObjectId = selection.objectId;
  const [selectedShot, setSelectedShot] = useState(scene.shots[0].id);
  const currentFrame = () => Math.min(ref.current.scene.timeline.frameCount - 1, Math.round(useDirectorPlaybackStore.getState().playhead * 30));
  const setFrame = (value: number) => useDirectorPlaybackStore.getState().setPlayhead(value / 30);
  const setPlaying = (value: boolean) => useDirectorPlaybackStore.getState().setPlaying(value);
  const assistantIdentity = usePrevizAssistantIdentity();
  const [assistantAvailability, setAssistantAvailability] = useState<{identity: string; available: boolean}>();
  const assistantAvailable = assistantAvailability?.identity === assistantIdentity.identity && assistantAvailability.available;
  useEffect(() => {
    if (!assistantIdentity.actorId) return;
    let active = true;
    const api = createPrevizWorkspaceApi();
    const refresh = () => {
      void api.sceneAssistantAvailability().then(({ available }) => {
        if (active) setAssistantAvailability({identity: assistantIdentity.identity, available});
      }).catch(() => {
        if (active) setAssistantAvailability({identity: assistantIdentity.identity, available: false});
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [assistantIdentity.identity, assistantIdentity.actorId]);
  const [agentOpen, setAgentOpen] = useState(() => Boolean(initial.initialBuildPrompt?.trim()));
  const [agentView, setAgentView] = useState<"build" | "guidance">("build");
  const [guidanceOpened, setGuidanceOpened] = useState(false);
  const [buildOpened, setBuildOpened] = useState(() => Boolean(initial.initialBuildPrompt?.trim()));
  const [exposureHint, setExposureHint] = useState(false);
  const alive = useRef(true),
    assetLock = useRef(false),
    importInput = useRef<HTMLInputElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [exportKind, setExportKind] = useState("MP4"),
    [exporting, setExporting] = useState(false),
    [progress, setProgress] = useState(0),
    [exportError, setExportError] = useState(""),
    [exportResult, setExportResult] = useState<{
      id: string;
      versionId: string;
      blob: Blob;
      name: string;
    } | null>(null);
  const exportController = useRef<AbortController | null>(null),
    exportLock = useRef(false);
  const [exportPreviewUrl, setExportPreviewUrl] = useState("");
  useEffect(() => {
    if (!exportOpen || !exportResult || !["video/mp4", "image/png"].includes(exportResult.blob.type)) {
      setExportPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(exportResult.blob);
    setExportPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [exportOpen, exportResult]);
  const [annotationOpen, setAnnotationOpen] = useState(false),
    [annotationImage, setAnnotationImage] = useState(""),
    [annotationPoints, setAnnotationPoints] = useState<[number, number][]>([]),
    [annotationNote, setAnnotationNote] = useState(""),
    annotationDrawing = useRef(false),
    [annotationContext, setAnnotationContext] = useState({
      frame: 0,
      nodeIds: [] as string[],
    });
  const [importing, setImporting] = useState(false);
  type AdoptionChoice = "retain" | "reset" | "separate" | "cancel";
  const [adoptionConflict, setAdoptionConflict] = useState<{ reason: string; canRetain: boolean; canReplace: boolean } | null>(null);
  const [scopeSelection,setScopeSelection]=useState<{objects:GlbObject[];scene:PrevizScene;editorVersion:string;targetNodeId?:string}|null>(null);
  const scopeDecision=useRef<((operation:PrevizBuildOperation|null)=>void)|null>(null);
  const chooseScope=(operation:PrevizBuildOperation|null)=>{const resolve=scopeDecision.current;scopeDecision.current=null;setScopeSelection(null);resolve?.(operation);};
  useEffect(()=>()=>{scopeDecision.current?.(null);scopeDecision.current=null;},[]);
  const adoptionDecision = useRef<((choice: AdoptionChoice) => void) | null>(null);
  const finishAdoptionDecision = (choice: AdoptionChoice) => {
    const resolve = adoptionDecision.current; adoptionDecision.current = null;
    setAdoptionConflict(null); resolve?.(choice);
  };
  useEffect(() => () => { adoptionDecision.current?.("cancel"); adoptionDecision.current = null; }, []);
  const selectedNode = scene.nodes.find(node => node.id === selected);
  const { modelNodes, cameraNodes } = useMemo(() => {
    const nodes = scene.nodes.filter(node => !node.directorBinding);
    const treeRoots = (items: typeof nodes) => {
      const ids = new Set(items.map(node => node.id));
      return items.map(node => node.parentId && !ids.has(node.parentId) ? { ...node, parentId: null } : node);
    };
    return {
      modelNodes: treeRoots(nodes.filter(node => node.kind !== "CAMERA")),
      cameraNodes: treeRoots(nodes.filter(node => node.kind === "CAMERA")),
    };
  }, [scene.nodes]);
  const generatedCameras = generatedCameraChoices(scene);
  const embeddedCameras = generatedCameras.filter(camera => !cameraNodes.some(node => node.id === camera.id));
  const setSessionError = session.setError;
  const safeExecute = useCallback(
    (commands: PrevizCommand[]) => {
      try {
        execute(commands);
      } catch (e) {
        setSessionError(errorText(e));
      }
    },
    [execute, setSessionError],
  );
  const selectNode = (id: string, objectId?: string) => {
    setPlaying(false);
    onSelect(id, objectId);
  };
  useEffect(() => {
    if (!scene.shots.some(shot => shot.id === selectedShot)) setSelectedShot(scene.shots[0].id);
  }, [scene.shots, selectedShot]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; exportController.current?.abort(); };
  }, []);
  const openAgent = () => {
    setAgentOpen(true);
    if (agentView === "guidance") setGuidanceOpened(true);
    if (agentView === "build") setBuildOpened(true);
  };
  const enterCamera = (id: string) => {
    setPlaying(false);
    onPreviewCamera(id);
  };
  const createViewCamera = (cameraId?: string) => {
    const node = createNode(
      "CAMERA",
      `机位 ${ref.current.scene.nodes.filter((n) => n.kind === "CAMERA").length + 1}`,
    );
    const snapshot = getCameraSnapshot(cameraId);
    if (snapshot) Object.assign(node, snapshot);
    return node;
  };
  const add = (kind: string) => {
    const node =
      kind === "CAMERA"
        ? createViewCamera()
        : createNode(kind as PrevizNode["kind"]);
    safeExecute([{ type: "node.add", node }]);
    selectNode(node.id);
  };
  const importAsset = async (file: File, buildStep?: string, initialExposure?: number, buildOrigin?: PrevizScene["assets"][number]["buildOrigin"], replaceNodeId?: string, clearInternalEdits = false, operation?: PrevizBuildOperation, baselineNodes?: Partial<PrevizNode>[]): Promise<boolean> => {
    if (buildStep && ref.current.adoptedBuildSteps?.includes(buildStep)) {
      try {
        const pending = pendingAdoption.current;
        if (pending?.stepId === buildStep) await flushAdoption(pending);
        else await flush();
        return true;
      } catch { return false; }
    }
    if (assetLock.current) return false;
    assetLock.current = true;
    setImporting(true);
    const sourceScene = ref.current.scene;
    try {
      const glb = file.name.toLowerCase().endsWith(".glb");
      if (file.size > (glb ? PREVIZ_GLB_MAX_BYTES : 5 * 1024 * 1024))
        throw new Error(glb ? "GLB 最大 32MB" : "参考图最大 5MB");
      if (
        !glb &&
        !["image/png", "image/jpeg", "image/webp"].includes(file.type)
      )
        throw new Error("请选择 GLB、PNG、JPEG 或 WebP 文件");
      const dataUrl = await fileDataUrl(
        glb ? new Blob([file], { type: "model/gltf-binary" }) : file,
      );
      const glbDocument = glb ? inspectGlb(dataUrlBytes(dataUrl)) : null;
      if (!glb) {
        const bitmap = await createImageBitmap(file);
        const tooLarge = bitmap.width > 8192 || bitmap.height > 8192;
        bitmap.close();
        if (tooLarge) throw new Error("参考图尺寸不能超过 8192px");
      }
      if (!alive.current) return false;
      if (ref.current.scene !== sourceScene)
        throw new Error("读取文件期间场景已变化，请重新选择文件导入");
      const asset = {
        id: uid(),
        name: file.name.slice(0, 200),
        kind: glb ? ("GLB" as const) : ("IMAGE" as const),
        mime: glb ? "model/gltf-binary" : file.type,
        dataUrl,
        ...(buildOrigin ? { buildOrigin } : {}),
      };
      const replacement = replaceNodeId ? sourceScene.nodes.find(item => item.id === replaceNodeId) : undefined;
      if (replaceNodeId && (!replacement || replacement.kind !== "GLB" || replacement.locked)) throw new Error("续改目标已删除或锁定，生成结果仍保留");
      const retainedAssets = replacement && !sourceScene.nodes.some(item => item.id !== replacement.id && item.assetId === replacement.assetId)
        ? sourceScene.assets.filter(item => item.id !== replacement.assetId) : sourceScene.assets;
      let commands: PrevizCommand[] = [
        {
          type: "assets.replace",
          assets: [...retainedAssets, asset],
        },
      ];
      let node: PrevizNode | undefined;
      if(glb&&operation&&glbDocument){
        let adoptionScene=sourceScene;
        const before:PrevizCommand[]=[];
        if(operation.kind==="MODIFY"&&operation.targetNodeIds.length===1){
          const targetId=operation.targetNodeIds[0],safety=assessGlbReplacement(sourceScene,targetId,glbDocument);
          if(!safety.canRetain){
            const choice=await new Promise<AdoptionChoice>(resolve=>{adoptionDecision.current=resolve;setAdoptionConflict(safety);});
            if(choice==="cancel"||!alive.current)return false;
            if(ref.current.scene!==sourceScene)throw new Error("选择期间场景再次变化，请重新采用生成结果");
            if(choice==="separate"){
              const roots=glbObjectsFromDocument(glbDocument).filter(p=>!p.parentId).map(p=>p.id);
              operation={...operation,kind:"ADD",targetNodeIds:[],outputObjectIds:roots};
            }else if(choice==="reset"&&safety.canReplace){
              const clip=glbDocument.animations?.[0];
              before.push({type:"node.update",id:targetId,patch:{assetOverrides:{},assetPlayback:clip?{clipIndex:0,loop:false,...(typeof clip.name==="string"&&clip.name.length<=200?{clipName:clip.name}:{})}:undefined}},
                {type:"timeline.replace",timeline:{...sourceScene.timeline,tracks:sourceScene.timeline.tracks.filter(t=>t.nodeId!==targetId||!t.objectId)},shots:sourceScene.shots});
              adoptionScene=applyCommands(sourceScene,before);
            }else throw new Error("此结果不能安全替换原模型，请保留原场景");
          }
        }
        const adoption=scopedBuildCommands(adoptionScene,asset,glbDocument,operation,baselineNodes);
        commands=[...before,...adoption.commands];
        node=applyCommands(sourceScene,commands).nodes.find(n=>n.id===adoption.nodeIds[0]);
      }else if (glb) {
        if (replacement) {
          const firstClip = glbDocument?.animations?.[0];
          const playback = firstClip ? { clipIndex: 0, ...(typeof firstClip.name === "string" && firstClip.name.length<=200 ? {clipName:firstClip.name} : {}), loop:false } : undefined;
          const patch = { assetId: asset.id, ...(clearInternalEdits ? { assetOverrides: {}, assetPlayback: playback } : {}) };
          node = { ...replacement, ...patch };
          commands.push({ type: "node.update", id: replacement.id, patch });
        } else {
        node = createNode(
          "GLB",
          file.name.replace(/\.glb$/i, "").slice(0, 120),
        );
        node.assetId = asset.id;
        if (glbDocument?.animations?.length) {
          const clip = glbDocument.animations[0];
          node.assetPlayback = { clipIndex: 0, ...(typeof clip.name === "string" && clip.name && clip.name.length<=200 ? { clipName: clip.name } : {}), loop: false };
        }
        commands.push({ type: "node.add", node });
        }
        if (initialExposure !== undefined && Number.isFinite(initialExposure) && initialExposure >= 2 ** -16 && initialExposure <= 2 ** 8
            && sourceScene.environment.exposure === 1.15 && !sourceScene.assets.some(asset => asset.kind === "GLB")
            && !sourceScene.nodes.some(item => item.kind === "LIGHT")) {
          commands.push({ type: "scene.settings", patch: { environment: { ...sourceScene.environment, exposure: initialExposure } } });
        }
      }
      if (glb && buildStep) {
        const cameraShot = initialGeneratedCameraShot(sourceScene, applyCommands(sourceScene, commands), asset.id);
        if (cameraShot) commands.push(cameraShot);
      }
      // Decode textures, skins and animation before committing the asset, so a bad file
      // cannot make an otherwise valid project viewport unusable.
      if (glb) {
        const checked = await buildRuntime(
          applyCommands(ref.current.scene, commands),
        );
        checked.dispose();
        if (!alive.current) return false;
        if (ref.current.scene !== sourceScene)
          throw new Error("模型校验期间场景已变化，请重新导入");
      }
      execute(commands,buildStep?{adoptedBuildSteps:[...new Set([...(ref.current.adoptedBuildSteps||[]),buildStep])],...(buildOrigin?{remoteWorkspaceId:buildOrigin.projectId,remoteSourceVersion:buildOrigin.sourceVersionId}:{})}:{});
      if(glbDocument?.extensions?.KHR_lights_punctual?.lights?.length && !sourceScene.assets.some(item=>item.kind==='GLB'))setExposureHint(true);
      if (node) selectNode(node.id);
      if (buildStep && buildOrigin) await flushAdoption({ projectId: buildOrigin.projectId, stepId: buildStep });
      else await flush();
      return true;
    } catch (e) {
      if (alive.current) session.setError(errorText(e));
      return false;
    } finally {
      assetLock.current = false;
      if (alive.current) setImporting(false);
    }
  };
  const beginExport = async () => {
    if (exportLock.current) return;
    exportLock.current = true;
    setExporting(true);
    setPlaying(false);
    setProgress(0);
    setExportError("");
    setExportResult(null);
    const controller = new AbortController();
    exportController.current = controller;
    try {
      await flush();
      controller.signal.throwIfAborted();
      const snapshot = copy({ ...ref.current, versions: [] }),
        versionId = snapshot.versionId;
      let blob: Blob, ext: string;
      if (exportKind === "PACKAGE") {
        blob = projectPackage(snapshot);
        ext = "aid-box.json";
      } else if (exportKind === "PNG") {
        blob = await exportScreenshot(
          snapshot.scene,
          currentFrame(),
        );
        ext = "png";
      } else if (exportKind === "GLB") {
        blob = await exportGlb(snapshot.scene, controller.signal, setProgress);
        ext = "glb";
      } else {
        blob = await exportVideo(snapshot.scene, controller.signal, (p) => {
          if (alive.current) setProgress(p);
        });
        ext = "mp4";
      }
      controller.signal.throwIfAborted();
      if (!alive.current) return;
      const result = {
        id: uid(),
        versionId,
        blob,
        name: `${snapshot.title}.${ext}`,
      };
      setExportResult(result);
      setProgress(1);
    } catch (e) {
      if (alive.current)
        setExportError(
          controller.signal.aborted
            ? "已取消导出，工程内容保持。"
            : errorText(e),
        );
    } finally {
      exportLock.current = false;
      if (alive.current) setExporting(false);
    }
  };
  const openAnnotation = () => {
    if (!capture) {
      session.setError("请等待三维视口准备完成");
      return;
    }
    try {
      const image = capture();
      if (!image) throw new Error("视口尚未准备好");
      setAnnotationImage(image);
      setAnnotationPoints([]);
      setAnnotationNote("");
      setAnnotationContext({
        frame: currentFrame(),
        nodeIds: selected ? [selected] : [],
      });
      setAnnotationOpen(true);
      setPlaying(false);
    } catch (e) {
      session.setError(errorText(e));
    }
  };
  const annotation: PrevizAnnotation = {
    id: uid(),
    frame: annotationContext.frame,
    nodeIds: annotationContext.nodeIds,
    image: annotationImage,
    note: annotationNote,
    points: annotationPoints,
  };
  const onMoveKey = (
    trackId: string,
    from: number,
    to: number,
    source: PrevizScene,
  ) => {
    const document = ref.current.scene;
    if (source !== document) {
      setSessionError("场景已变化，请重新拖动关键帧");
      return;
    }
    const track = document.timeline.tracks.find((t) => t.id === trackId);
    if (!track || document.nodes.find((n) => n.id === track.nodeId)?.locked)
      return;
    try {
      const moved = moveTrackKey(track, from, to, document.timeline.frameCount);
      if (moved !== track)
        safeExecute([
          {
            type: "timeline.replace",
            timeline: {
              ...document.timeline,
              tracks: document.timeline.tracks.map((t) =>
                t.id === trackId ? moved : t,
              ),
            },
            shots: document.shots,
          },
        ]);
      setFrame(to);
    } catch (error) {
      setSessionError(errorText(error));
    }
  };

  return (
    <>
      {children({
        primitives: <section className="director-tool-section">
          <h3>场景组件</h3>
          <div className="director-choice-list">
            {Object.entries(PREVIZ_KINDS).filter(([kind]) => !["GLB", "ACTOR", "CAMERA", "BOX", "SPHERE", "CONE"].includes(kind))
              .map(([kind, label]) => <button key={kind} type="button" onClick={() => add(kind)}>
                <BoxMark /><span>{label}</span><em>+</em>
              </button>)}
          </div>
        </section>,
        objects: { count: modelNodes.length, render: search => <div className="director-modeling-controls">
          <div className="pv-object-list-container">
            <PrevizObjectList viewport="embedded" assets={scene.assets} nodes={modelNodes} search={search} selectedId={selected}
              selectedObjectId={selectedObjectId} onSelect={selectNode} execute={safeExecute} onDelete={onDeleteObject} />
          </div>
        </div> },
        cameras: { count: cameraNodes.length + embeddedCameras.length, render: search => <>
          {cameraNodes.length ? <PrevizObjectList viewport="embedded" assets={scene.assets} nodes={cameraNodes} search={search} selectedId={selected}
            onSelect={(id) => { selectNode(id); onPreviewCamera(id) }} execute={safeExecute} onDelete={onDeleteObject} /> : null}
          {embeddedCameras.filter(camera=>!search||camera.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
          .map(camera=><StudioCanvasTooltip key={camera.id} title={`查看生成机位：${camera.name}`}>
            <button type="button" className="director-tree-row is-camera is-generated-camera" aria-label={`查看生成机位 ${camera.name}`} onClick={()=>onPreviewCamera(camera.id)}>
              <CameraOutlined aria-hidden/><span>{camera.name}</span>
            </button>
          </StudioCanvasTooltip>)}
        </> },
        assets: <>
                <button
                  className="pv-upload-zone"
                  onClick={() => importInput.current?.click()}
                >
                  <UploadOutlined />
                  <strong>
                    {importing ? "正在读取并校验…" : "导入 GLB / 参考图片"}
                  </strong>
                  <span>模型 32MB · 图片 5MB · 随工程保存</span>
                </button>
                <p className="pv-help">
                  模型保留层级、骨骼和动画。要按图片搭建，请在场景搭建对话中添加参考图。
                </p>
                <div className="pv-assets">
                  {scene.assets.map((asset) => (
                    <div key={asset.id} className="pv-asset">
                      {asset.kind === "IMAGE" ? (
                        <img src={asset.dataUrl} alt={asset.name} />
                      ) : (
                        <BoxMark />
                      )}
                      <span>{asset.name}</span>
                      <Tool
                        label={`移除资产 ${asset.name}`}
                        icon={<CloseOutlined />}
                        onClick={() => {
                          if (scene.nodes.some((n) => n.assetId === asset.id)) {
                            session.setError("请先删除使用该资产的场景对象");
                            return;
                          }
                          safeExecute([
                            {
                              type: "assets.replace",
                              assets: scene.assets.filter(
                                (a) => a.id !== asset.id,
                              ),
                            },
                          ]);
                        }}
                      />
                    </div>
                  ))}
                </div>
</>,
        inspector: <LivePrevizInspector
                followCameraControl={selectedNode && !['CAMERA','LIGHT','PLANE'].includes(selectedNode.kind) ? <PrevizFollowCamera
                  key={`${project.id}:${selected}:${selectedObjectId || ''}`} scene={scene} node={selectedNode} selectedObjectId={selectedObjectId}
                  readOnly={project.remoteRole === 'VIEWER'} onCreate={async (subject, signal, onProgress) => {
                    const source = ref.current.scene, projectId = ref.current.id, identity = mainAssistantTransport.identityKey();
                    const assertCurrent = () => {
                      if (!alive.current || ref.current.id !== projectId || ref.current.scene !== source || mainAssistantTransport.identityKey() !== identity)
                        throw new Error('工程或模型已变化，请重新添加跟随机位');
                      if (ref.current.remoteRole === 'VIEWER') throw new Error('当前工程为只读，不能添加机位');
                    };
                    setPlaying(false);
                    const result = await createFollowCamera(source, { subject, signal, onProgress, assertCurrent, shotId: selectedShot, view: getCameraSnapshot() });
                    assertCurrent(); signal.throwIfAborted();
                    execute(result.commands);
                    selectNode(result.cameraId);
                    enterCamera(result.cameraId);
                  }} /> : undefined}
                selectedObjectId={selectedObjectId}
                onSelectObject={id => selectNode(selected, id)}
                scene={scene}
                selectedId={selected}
                selectedShotId={selectedShot}
                execute={safeExecute}
                onSelect={selectNode}
                onShot={(id) => {
                  setSelectedShot(id);
                  const shot = scene.shots.find((s) => s.id === id);
                  if (shot) {
                    setFrame(shot.startFrame);
                    setPlaying(false);
                  }
                }}
                onCreateCamera={(shotId) => {
                  const node = createViewCamera(scene.shots.find(shot=>shot.id===shotId)?.cameraId);
                  safeExecute([
                    { type: "node.add", node },
                    {
                      type: "timeline.replace",
                      timeline: scene.timeline,
                      shots: scene.shots.map((s) =>
                        s.id === shotId ? { ...s, cameraId: node.id } : s,
                      ),
                    },
                  ]);
                  selectNode(node.id);
                }}
                getCameraSnapshot={(id) => getCameraSnapshot(id)}
                onEnterCamera={enterCamera}
              />,
        exposure: <div className="director-modeling-controls">
          <NumberField label="曝光补偿（EV）" value={Math.log2(scene.environment.exposure)} min={-16} max={8} step={0.25}
            onChange={ev => safeExecute([{ type: "scene.settings", patch: { environment: { ...scene.environment, exposure: 2 ** ev } } }])} />
        </div>,
        assistant: toolbar => assistantAvailable ? <PrevizAgentDock expanded={agentOpen} mode={agentView}
          tools={toolbar} onOpen={openAgent} onCollapse={() => setAgentOpen(false)}>
            <div className="pv-agent-dock-heading">
              <Choice label="助手模式" value={agentView}
                items={[{key:"build",label:"场景搭建"},{key:"guidance",label:"空间方案"}]}
                onChange={value => {
                  setAgentView(value as typeof agentView);
                  if (value === "build") setBuildOpened(true);
                  if (value === "guidance") setGuidanceOpened(true);
                }} />
            </div>
            {guidanceOpened ? (
              <div
                className="pv-guidance-shell"
                role="region"
                aria-label="空间方案助手"
                hidden={agentView !== "guidance"}
                inert={agentView !== "guidance"}
              >
                <div className="pv-guidance-boundary" role="status">
                  <strong>仅方案模式</strong>
                  <span>
                    提供镜头布局、人物站位和运镜建议；暂不读取或修改当前 3D
                    工程，不生成或导出场景。
                  </span>
                </div>
                <PrevizGuidanceSession open={agentOpen && agentView === "guidance"} />
              </div>
            ) : null}
            {buildOpened ? (
              <div className="pv-guidance-shell" role="region" aria-label="场景搭建助手"
                hidden={agentView !== "build"} inert={agentView !== "build"}>
                <PrevizGuidanceSession open={agentOpen && agentView === "build"} saveFeedback={{ message: cloudSave.error, busy: cloudSave.busy, retry: () => void cloudSave.retry().catch(() => undefined), hasReportedFailure: cloudSave.hasReportedFailure }} localProjectId={project.id} projectTitle={project.title} workspaceProjectId={project.remoteWorkspaceId} initialTextModelCode={project.initialTextModelCode} initialReferenceImages={project.initialReferenceImages}
                  composerDraftStore={{
                    read: sessionId => project.buildDrafts?.[sessionId] ?? project.initialBuildPrompt ?? "",
                    update: (sessionId, value) => mutate(current => {
                      const before = current.buildDrafts?.[sessionId] ?? current.initialBuildPrompt ?? "";
                      const next = typeof value === "function" ? value(before) : value;
                      const drafts = { ...current.buildDrafts };
                      if (next) drafts[sessionId] = next; else delete drafts[sessionId];
                      return { ...current, initialBuildPrompt: undefined, buildDrafts: drafts };
                    }),
                  }}
                  isAdopted={stepId => pendingAdoption.current?.stepId !== stepId && Boolean(ref.current.adoptedBuildSteps?.includes(stepId))}
                  hasNewerAdoption={stepId => (ref.current.adoptedBuildSteps ?? []).some(adopted => BigInt(adopted) > BigInt(stepId))}
                  onSceneEdit={async receipt=>{
                    if (pendingAdoption.current?.stepId === receipt.runtimeStepId) {
                      await flushAdoption(pendingAdoption.current);
                      return;
                    }
                    if(ref.current.adoptedBuildSteps?.includes(receipt.runtimeStepId))return;
                    const identity=mainAssistantTransport.identityKey(),projectId=receipt.projectId;
                    const guard=()=>{if(!alive.current||identity!==mainAssistantTransport.identityKey()||ref.current.remoteWorkspaceId!==projectId)throw new Error('账号或工程已变化，本机草稿保留');};
                    await cloudSave.duringRemoteUpdate(async()=>{
                      guard();const api=createPrevizWorkspaceApi();
                      const [base,published]=await Promise.all([api.documentRead(projectId,receipt.baseDocumentVersion),api.documentRead(projectId,receipt.documentVersion)]);guard();
                      if(base.sourceVersion!==published.sourceVersion)throw new Error('源码已变化，请重新打开服务器工程核对；本机草稿保留');
                      const reusable=ref.current.scene.assets;
                      const before=await unpackProjectDocument(base.document,projectId,api,guard,()=>{},reusable);
                      const remote=await unpackProjectDocument(published.document,projectId,api,guard,()=>{},reusable);guard();
                      const next=mergePublishedSceneEdit(before.scene,ref.current.scene,remote.scene);
                      execute([{type:'scene.replace',scene:next}],{remoteDocumentVersion:published.documentVersion,remoteSourceVersion:published.sourceVersion,editorVersion:receipt.editorVersion,
                        adoptedBuildSteps:[...new Set([...(ref.current.adoptedBuildSteps||[]),...(remote.adoptedBuildSteps||[]),receipt.runtimeStepId])]});
                      cloudSave.adoptServerSnapshot(remote);
                      await flushAdoption({ projectId, stepId: receipt.runtimeStepId });
                    });
                  }}
                  captureScene={() => ref.current.scene}
                  captureEditor={async (projectId,sourceVersion,confirmedBuildSteps) => {
                    const api = createPrevizWorkspaceApi();
                    previzEditorSourceBinding(ref.current, projectId, sourceVersion);
                    const identity = mainAssistantTransport.identityKey(), localProject = ref.current.id;
                    const assertCurrent = () => { if (!alive.current || ref.current.id !== localProject || mainAssistantTransport.identityKey() !== identity) throw new Error('账号或工程已变化，请重新打开当前项目对话'); previzEditorSourceBinding(ref.current,projectId,sourceVersion); };
                    const before = ref.current.scene;
                    const missing = before.assets.filter(asset => asset.kind === "GLB" && !asset.buildOrigin);
                    // The historical adoption list also contains scene-edit receipts.
                    // Only confirmed build steps can supply the origin of a GLB.
                    const adoptedSteps = new Set(ref.current.adoptedBuildSteps ?? []);
                    const buildSteps = confirmedBuildSteps.filter(stepId => adoptedSteps.has(stepId));
                    if (missing.length && buildSteps.length) {
                      const manifests = [];
                      for (const stepId of buildSteps) { manifests.push(await api.buildManifest(projectId, stepId)); assertCurrent(); }
                      const updated = [...before.assets];
                      for (const asset of missing) {
                        const hash = await digestSha256Hex(dataUrlBytes(asset.dataUrl));
                        const matches = manifests.filter(item => item.artifact.sha256 === hash);
                        if (matches.length === 1) {
                          const match = matches[0];
                          updated[updated.findIndex(item => item.id === asset.id)] = { ...asset, buildOrigin: {
                            projectId, stepId: match.runtimeStepId, sourceVersionId: match.sourceVersionId, engine: match.engine, sha256: hash,
                          } };
                        }
                      }
                      assertCurrent();
                      if (ref.current.scene !== before) throw new Error("读取来源期间场景已修改，请重新发送");
                      execute([{ type: "assets.replace", assets: updated }]);
                      await flush();
                    }
                    if(ref.current.remoteWorkspaceId!==projectId){
                      const metadata=await api.detail(projectId);assertCurrent();mutate(p=>({...p,remoteWorkspaceId:projectId,remoteRole:metadata.accessRole}));
                    }
                    return preparePrevizEditorSnapshot({ projectId, sourceVersion, getProject: () => ref.current, assertCurrent,
                      flushDocument: () => cloudSave.flush(true), flushLocal: () => flush(), currentEditor: () => api.currentEditor(projectId),
                      selected: selected ? [selected] : [], frame: currentFrame(), selectedObjectId });
                  }}
                  onEditorSaved={async version => { mutate(current => ({ ...current, editorVersion: version })); await flush(); }}
                  onArtifact={async (artifact, expectedScene, recovered) => {
                    if (expectedScene !== ref.current.scene) throw new Error("载入期间场景已修改，生成结果已保留；请确认当前场景后重新载入");
                    const bytes = await previzBuildArtifactBytes(artifact);
                    const editor = artifact.editorVersion ? await createPrevizWorkspaceApi().readEditor(artifact.projectId, artifact.editorVersion) : undefined;
                    if (expectedScene !== ref.current.scene) throw new Error("校验期间场景已修改，生成结果已保留；请确认当前场景后重新载入");
                    if(artifact.operation){
                      if(!editor||artifact.operation.editorVersion!==artifact.editorVersion||artifact.operation.sceneDigest!==editor.sceneDigest)throw new Error("构建采用范围与编辑基线不一致，结果已保留");
                      if (artifact.operation.kind === 'REBUILD_SCENE' || recovered && artifact.operation.kind === 'ADD') {
                        const unchanged = await editorSceneDigest(expectedScene) === editor.sceneDigest;
                        if (!unchanged || expectedScene !== ref.current.scene) {
                          throw new Error('生成期间工程已有编辑，本次构建未覆盖这些改动；产物已保留，请核对当前工程后明确采用范围');
                        }
                      }
                      return importAsset(new File([bytes],`${artifact.engine}-${artifact.sceneId}.glb`,{type:"model/gltf-binary"}),artifact.runtimeStepId,
                        artifact.previewSettings?.lightingUnits === "PHOTOMETRIC" ? artifact.previewSettings.exposure : undefined,
                        {projectId:artifact.projectId,stepId:artifact.runtimeStepId,sourceVersionId:artifact.sourceVersionId,engine:artifact.engine,sha256:artifact.artifact.sha256,
                          ...(artifact.runtimeRunId?{runtimeRunId:artifact.runtimeRunId,sceneId:artifact.sceneId,...(artifact.editorVersion?{editorVersion:artifact.editorVersion}:{}),...(artifact.entry?{entry:artifact.entry}:{})}:{})},
                        undefined,false,artifact.operation,editor.nodes);
                    }
                    {
                      const choiceScene=ref.current.scene;
                      const operation=await new Promise<PrevizBuildOperation|null>(resolve=>{
                        scopeDecision.current=resolve;setScopeSelection({objects:glbObjectsFromDocument(inspectGlb(bytes.buffer)),scene:choiceScene,editorVersion:artifact.editorVersion||"manual",targetNodeId:editor?.targetNodeId||undefined});
                      });
                      if(!operation||!alive.current)return false;
                      if(ref.current.scene!==choiceScene)throw new Error("选择期间场景已变化，原场景未修改，请重新选择采用范围");
                      return importAsset(new File([bytes],`${artifact.engine}-${artifact.sceneId}.glb`,{type:"model/gltf-binary"}),artifact.runtimeStepId,
                        artifact.previewSettings?.lightingUnits === "PHOTOMETRIC" ? artifact.previewSettings.exposure : undefined,
                        {projectId:artifact.projectId,stepId:artifact.runtimeStepId,sourceVersionId:artifact.sourceVersionId,engine:artifact.engine,sha256:artifact.artifact.sha256},undefined,false,operation,choiceScene.nodes);
                    }
                  }} />
              </div>
            ) : null}
          </PrevizAgentDock> : toolbar,
        timeline: frameCount => <PrevizTimelineRows scene={scene} frameCount={frameCount} selectedShot={selectedShot}
          onInteractionStart={() => setPlaying(false)}
          onFrame={value => { setPlaying(false); setFrame(value); }} onShot={setSelectedShot} onMoveKey={onMoveKey}
          onResizeShot={(id, edge, value, source) => {
            if (ref.current.scene !== source) { setSessionError('场景已变化，请重新拖动镜头'); return; }
            setPlaying(false);
            try { safeExecute([resizePrevizShot(source,id,edge,value,frameCount)]); setFrame(Math.min(currentFrame(),ref.current.scene.timeline.frameCount-1)); }
            catch (cause) { setSessionError(errorText(cause)); }
          }} />,
        status: <>
      {exposureHint ? <div className="pv-exposure-notice" role="status">
        <span>模型带有物理灯光，可在环境属性中调整曝光。</span>
        <button type="button" className="pv-secondary" onClick={() => { onSelect(""); onOpenInspector(); setExposureHint(false); }}>环境属性</button>
        <button type="button" className="pv-secondary" onClick={() => setExposureHint(false)}>知道了</button>
      </div> : null}
      {session.error ? <div className="pv-error-banner" role="alert"><span>{session.error}</span><Button type="text" aria-label="关闭提示" onClick={() => session.setError("")}><CloseOutlined /></Button></div> : null}
        </>,
        openProjects: onOpenProjects,
        openHistory: () => setHistoryOpen(true),
        openExport: () => setExportOpen(true),
        openAnnotation,
      })}
      <input
        ref={importInput}
        type="file"
        accept=".glb,image/png,image/jpeg,image/webp"
        hidden
        aria-label="导入模型或参考图"
        disabled={importing}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importAsset(file);
        }}
      />
      <Modal
        title="确认采用生成结果"
        open={Boolean(adoptionConflict)} onCancel={() => finishAdoptionDecision("cancel")}
        footer={null} centered rootClassName="pv-modal"
      >
        <p>{adoptionConflict?.reason}生成结果已保存，请选择采用方式。</p>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <Button block type="primary" disabled={!adoptionConflict?.canRetain} onClick={() => finishAdoptionDecision("retain")}>替换模型，保留当前手动编辑</Button>
          <Button block danger style={{height:"auto",whiteSpace:"normal",padding:"8px 12px"}} disabled={!adoptionConflict?.canReplace} onClick={() => finishAdoptionDecision("reset")}>替换模型，清除内部对象编辑并重选首个动画</Button>
          <Button block onClick={() => finishAdoptionDecision("separate")}>作为独立模型加入，保留原模型</Button>
          <Button block onClick={() => finishAdoptionDecision("cancel")}>暂不采用</Button>
        </div>
        <p>替换保留模型根位置及工程镜头。无法匹配的镜头引用仍需先调整；不会静默丢弃。采用后可撤销。</p>
      </Modal>
      {scopeSelection?<PrevizAdoptionScopeDialog {...scopeSelection} onChoose={chooseScope}/>:null}
      <Modal
        title="历史版本 · 本机"
        open={historyOpen}
        onCancel={() => setHistoryOpen(false)}
        footer={null}
        centered
        rootClassName="pv-modal"
      >
        <p className="pv-help">
          保留最近 20 个场景版本。恢复产生新版本，可撤销；不会回退工程修订号。
        </p>
        {project.versions.length ? (
          [...project.versions].reverse().map((v) => (
            <div className="pv-version" key={v.id}>
              <span>
                <strong>修订 {v.revision}</strong>
                <small>
                  {new Date(v.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {v.scene.nodes.length} 个对象
                </small>
              </span>
              <button
                className="pv-secondary"
                onClick={() => {
                  safeExecute([{ type: "scene.replace", scene: v.scene }]);
                  setHistoryOpen(false);
                }}
              >
                恢复为新版本
              </button>
            </div>
          ))
        ) : (
          <p>尚无已保存的场景历史。编辑并保存后会出现在这里。</p>
        )}
      </Modal>
      <Modal
        title="导出预演"
        destroyOnHidden
        open={exportOpen}
        onCancel={() => {
          if (exporting) exportController.current?.abort();
          setExportOpen(false);
          setExportResult(null);
          setExportError("");
        }}
        footer={null}
        centered
        width={560}
        rootClassName="pv-modal pv-export-modal"
      >
        <p className="pv-help">
          固定保存版本 · {scene.aspectRatio} · {scene.timeline.frameCount / 30}{" "}
          秒 · 30fps · 无声
        </p>
        <Choice
          label="导出格式"
          value={exportKind}
          items={[
            {
              key: "MP4",
              label: "MP4 · 本地精确逐帧 / H.264",
              description: "720p，要求浏览器支持 WebCodecs",
            },
            {
              key: "GLB",
              label: "GLB · 场景与烘焙动画",
              description: "镜头区间等编辑语义请同时导出工程包",
            },
            {
              key: "PACKAGE",
              label: "AID 工程包 · 完整可编辑",
              description: "含对象、镜头、动画和内嵌资产",
            },
            {
              key: "PNG",
              label: "PNG · 当前帧拍摄截图",
              description: "使用当前镜头，不含辅助线",
            },
          ]}
          disabled={exporting}
          onChange={setExportKind}
        />
        <p className="pv-help">
          当前为 Web 本地导出。云端渲染、权威报价和资源登记等待后端接入。
          {exportKind === "MP4"
            ? " 视频按时间轴机位切换；单机位预览不改变成片镜头。"
            : exportKind === "PNG"
              ? " 截图使用当前预览机位，场景模式下使用时间轴机位。"
              : ""}
        </p>
        {exporting ? (
          <div className="pv-export-progress" role="status">
            <progress max={1} value={progress} />
            <span>{Math.round(progress * 100)}% · 正在导出</span>
            <button
              className="pv-secondary"
              onClick={() => exportController.current?.abort()}
            >
              取消导出
            </button>
          </div>
        ) : (
          <button
            className="pv-primary pv-wide"
            onClick={() => void beginExport()}
          >
            <DownloadOutlined /> 生成导出文件
          </button>
        )}
        {exportError ? (
          <p className="pv-inline-error" role="alert">
            {exportError}
          </p>
        ) : null}
        {exportResult ? (
          <div className="pv-export-result">
            <strong>
              <CheckOutlined /> 已生成 {exportResult.name}
            </strong>
            <p>
              {(exportResult.blob.size / 1024 / 1024).toFixed(2)} MB · 固定版本{" "}
              {exportResult.versionId.slice(0, 8)}
            </p>
            <button
              className="pv-secondary"
              onClick={() =>
                downloadPreviz(exportResult.blob, exportResult.name)
              }
            >
              下载文件
            </button>
            {exportPreviewUrl && exportResult.blob.type === "video/mp4" ? (
              <video className="pv-export-preview" src={exportPreviewUrl} controls preload="metadata" playsInline aria-label="导出的无声预演视频" />
            ) : exportPreviewUrl && exportResult.blob.type === "image/png" ? (
              <img className="pv-export-preview" src={exportPreviewUrl} alt="导出的场景截图" />
            ) : null}
          </div>
        ) : null}
      </Modal>
      <Modal
        title="标注当前画面"
        open={annotationOpen}
        onCancel={() => setAnnotationOpen(false)}
        onOk={() => {
          mutate((p) => ({
            ...p,
            annotations: [...p.annotations, annotation].slice(-5),
          }));
          setAnnotationOpen(false);
          openAgent();
        }}
        okText="加入对话参考"
        cancelText="取消"
        centered
        width={760}
        rootClassName="pv-modal"
      >
        <p className="pv-help">
          标注绑定第 {annotationContext.frame}{" "}
          帧和当时选中对象；作为下一轮上下文，不直接修改三维场景。
        </p>
        <div
          className="pv-annotation"
          onPointerDown={(e) => {
            annotationDrawing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            const r = e.currentTarget.getBoundingClientRect();
            setAnnotationPoints([
              [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height],
            ]);
          }}
          onPointerMove={(e) => {
            if (!annotationDrawing.current) return;
            const r = e.currentTarget.getBoundingClientRect();
            const p: [number, number] = [
              Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
              Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
            ];
            setAnnotationPoints((points) =>
              points.length < 500 ? [...points, p] : points,
            );
          }}
          onPointerUp={() => {
            annotationDrawing.current = false;
          }}
          onPointerCancel={() => {
            annotationDrawing.current = false;
          }}
        >
          <img src={annotationImage} alt="当前帧标注参考" />
          <svg
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              points={annotationPoints
                .map(([x, y]) => `${x * 1000},${y * 1000}`)
                .join(" ")}
              fill="none"
              stroke="#e99577"
              strokeWidth="5"
            />
          </svg>
        </div>
        <label className="pv-field">
          标注说明
          <textarea
            aria-label="标注说明"
            maxLength={1000}
            value={annotationNote}
            onChange={(e) => setAnnotationNote(e.target.value)}
            placeholder="例如：人物沿箭头前进，镜头跟随…"
          />
        </label>
        <button
          className="pv-secondary"
          onClick={() => setAnnotationPoints([])}
        >
          清除笔迹
        </button>
      </Modal>
    </>
  );
}

function LivePrevizInspector(props: Omit<ComponentProps<typeof PrevizInspector>, "frame">) {
  const frame = useDirectorPlaybackStore(state => Math.min(props.scene.timeline.frameCount - 1, Math.round(state.playhead * 30)));
  return <PrevizInspector {...props} frame={frame} />;
}

function PrevizGuidanceSession({ open, saveFeedback, localProjectId, projectTitle, workspaceProjectId, initialTextModelCode, initialReferenceImages, isAdopted, hasNewerAdoption, captureScene, captureEditor, onEditorSaved, onArtifact, onSceneEdit, composerDraftStore }: {
  open: boolean;
  saveFeedback?: { message: string; busy: boolean; retry: () => void; hasReportedFailure: (cause: unknown) => boolean };
  localProjectId?: string;
  projectTitle?: string;
  workspaceProjectId?: string;
  initialTextModelCode?: string;
  initialReferenceImages?: Extract<AssistantContextRef, {kind:"PREVIZ_IMAGE"}>[];
  isAdopted?: (stepId: string) => boolean;
  hasNewerAdoption?: (stepId: string) => boolean;
  captureScene?: () => PrevizScene;
  captureEditor?: (projectId: string, sourceVersion: string | null, confirmedBuildSteps: string[]) => Promise<{state: PrevizEditorSnapshot; expectedVersion: string | null}>;
  onEditorSaved?: (version: string) => Promise<void>;
  onArtifact?: (artifact: PrevizBuildArtifact, expectedScene?: PrevizScene, recovered?: boolean) => Promise<boolean>;
  onSceneEdit?:(receipt:PrevizSceneEditReceipt)=>Promise<void>;
  composerDraftStore?: AssistantComposerDraftStore;
}) {
  const { message } = App.useApp();
  const identity = usePrevizAssistantIdentity();
  const workspaceApi = useMemo(() => createPrevizWorkspaceApi(), [identity.identity]);
  const [remote, setRemote] = useState<{ identity: string; localId: string; id: string; role?: string } | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const [textModels, setTextModels] = useState<PrevizTextModelOptions['models']>([]);
  const [pricingOpen,setPricingOpen]=useState(false);
  const [textModel, setTextModel] = useState("");
  const textModelRef = useRef("");
  const [modelError, setModelError] = useState("");
  const [adoptionMessage, setAdoptionMessage] = useState("");
  const [referenceImages, setReferenceImages] = useState<Extract<AssistantContextRef, { kind: "PREVIZ_IMAGE" }>[]>(initialReferenceImages??[]);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [buildFileSteps, setBuildFileSteps] = useState<string[]>([]);
  const [previewSteps,setPreviewSteps]=useState<string[]>([]);
  useEffect(()=>setPreviewSteps([]),[identity.identity,localProjectId]);
  useEffect(() => { setReferenceImages(initialReferenceImages??[]); setReferenceUploading(false); setBuildFileSteps([]); }, [identity.identity, localProjectId, initialReferenceImages]);
  const [failedAdoption, setFailedAdoption] = useState<{ projectId: string; stepId: string;kind:'build'|'edit'; recovered?: boolean } | null>(null);
  const seenBuilds = useRef(new Set<string>());
  const observedSession = useRef("");
  const queuedBuilds = useRef(new Set<string>());
  const adoptionChain = useRef(Promise.resolve());
  const automaticAdoptionSignature = useRef("");
  const archivedAdoptionSignature = useRef("");
  const buildManifests = useRef(new Map<string, ReturnType<typeof workspaceApi.buildManifest>>());
  const latestAdopter = useRef({ isAdopted, hasNewerAdoption, captureScene, onArtifact, onSceneEdit });
  latestAdopter.current = { isAdopted, hasNewerAdoption, captureScene, onArtifact, onSceneEdit };
  const adoptionScope = useRef("");
  adoptionScope.current = `${identity.identity}:${localProjectId || ""}`;
  useEffect(() => () => { adoptionScope.current = ""; }, []);
  const readBuildManifest = (projectId: string, stepId: string) => {
    const pending = buildManifests.current.get(stepId);
    if (pending) return pending;
    const request = workspaceApi.buildManifest(projectId, stepId).catch(error => {
      buildManifests.current.delete(stepId);
      throw error;
    });
    buildManifests.current.set(stepId, request);
    return request;
  };
  const queueAdoption = (projectId: string, stepId: string, announce = true,kind:'build'|'edit'='build', recovered = false) => {
    if (queuedBuilds.current.has(stepId)) return;
    queuedBuilds.current.add(stepId);
    const scope = adoptionScope.current;
    setFailedAdoption(null);
    adoptionChain.current = adoptionChain.current.then(async () => {
      if (scope !== adoptionScope.current || identity.identity !== mainAssistantTransport.identityKey()) return;
      if (latestAdopter.current.isAdopted?.(stepId) || recovered && latestAdopter.current.hasNewerAdoption?.(stepId)) return;
      if(kind==='edit'){
        setAdoptionMessage('正在同步已保存的对象编辑…');const receipt=await workspaceApi.sceneEditReceipt(projectId,stepId);
        if(scope!==adoptionScope.current)return;
        if(receipt.projectId!==projectId||receipt.runtimeStepId!==stepId||receipt.state!=='APPLIED')throw new Error('对象编辑回执与工程不一致');
        await latestAdopter.current.onSceneEdit?.(receipt);if(scope===adoptionScope.current)setAdoptionMessage('对象编辑已同步到工作副本');return;
      }
      const expectedScene = latestAdopter.current.captureScene?.();
      setAdoptionMessage("正在校验并载入生成场景…");
      const artifact = await workspaceApi.artifact(projectId, stepId);
      if (scope !== adoptionScope.current) return;
      if (artifact.runtimeStepId !== stepId || artifact.projectId !== projectId) throw new Error("生成结果与工程不一致");
      if (recovered && !artifact.operation) throw new Error("历史构建没有记录采用范围，请在生成结果中查看或下载");
      if (!await latestAdopter.current.onArtifact?.(artifact, expectedScene, recovered)) throw new Error("模型已构建，本机导入未完成；产物仍保留");
      if (scope !== adoptionScope.current || identity.identity !== mainAssistantTransport.identityKey()) return;
      setAdoptionMessage(artifact.warnings.length ? `场景已载入工作副本，另有 ${artifact.warnings.length} 项导出兼容提示` : "生成场景已载入并保存在工作副本");
      if (announce) {
        const notice = { kind: 'previz_scene' as const, nodeId: `${projectId}:${stepId}`, projectName: projectTitle };
        message.success(studioGenerationCompleteNotice(notice).toastTitle);
        notifyStudioGenerationComplete(notice);
      }
    }).catch(error => {
      if (scope !== adoptionScope.current) return;
      setAdoptionMessage(assistantErrorMessage(error)); setFailedAdoption({ projectId, stepId,kind,recovered });
    }).finally(() => queuedBuilds.current.delete(stepId));
  };
  const [retryProject, setRetryProject] = useState(0);
  useEffect(() => {
    if (!localProjectId || !identity.actorId) return;
    let active = true;
    setRemoteError("");
    // Legacy local-project bootstrap must retain its original title for idempotent replay.
    void (workspaceProjectId?workspaceApi.detail(workspaceProjectId):workspaceApi.create(`3D-HUB ${localProjectId}`, `previz-local-${localProjectId}`))
      .then((value) => {
        if (!active) return;
        if (!value.id) throw new Error("助手工程响应缺少项目标识");
        setRemote({ identity: identity.identity, localId: localProjectId, id: value.id, role: value.accessRole });
      })
      .catch((error) => { if (active) setRemoteError(assistantErrorMessage(error)); });
    return () => { active = false; };
  }, [identity.actorId, identity.identity, localProjectId, workspaceProjectId, workspaceApi, retryProject]);
  useEffect(() => {
    let active = true;
    setTextModels([]); setTextModel(""); textModelRef.current = ""; setModelError("");
    if (!remote || remote.identity !== identity.identity || remote.localId !== localProjectId) return;
    void workspaceApi.models(remote.id).then(options => {
      if (!active) return;
      if (!Array.isArray(options.models)) throw new Error("助手暂未返回可用模型");
      setTextModels(options.models);
      const selected=initialTextModelCode || options.modelCode;
      if(!options.models.some(model=>model.code===selected)){setModelError("首页所选模型已不可用，请重新选择");return;}
      setTextModel(selected); textModelRef.current = selected;
    }).catch(error => { if (active) setModelError(assistantErrorMessage(error)); });
    return () => { active = false; };
  }, [remote, identity.identity, localProjectId, workspaceApi, retryProject, initialTextModelCode]);
  const saveNotice = saveFeedback?.message ? <StudioCanvasAssistantTurn author="场景搭建" label="工程保存确认" className="pv-save-feedback">
    <div role="alert"><strong>核对工程保存</strong><p>{saveFeedback.message}</p></div>
    <div className="canvas-assistant-actions">
      <StudioCanvasAssistantAction primary onClick={saveFeedback.retry} disabled={saveFeedback.busy}>
        {saveFeedback.busy ? "正在核对…" : "重试保存"}
      </StudioCanvasAssistantAction>
    </div>
  </StudioCanvasAssistantTurn> : null;
  if (!identity.actorId) {
    const message = identity.error || "正在读取账号…";
    return (
      <div className="pv-guidance-login">
        <p role={identity.error ? "alert" : "status"}>{message}</p>
        {saveNotice}
        {identity.error ? (
          <div className="pv-guidance-login-actions">
            {identity.connected ? (
              <button className="pv-secondary" type="button" onClick={identity.retry}>
                重新读取
              </button>
            ) : (
              <button
                className="pv-primary"
                type="button"
                onClick={() =>
                  openLoginModal({
                    tab: "password",
                    redirect: null,
                  })
                }
              >
                登录 3D预演
              </button>
            )}
          </div>
        ) : null}
      </div>
    );
  }
  const remoteId = remote?.identity === identity.identity && remote.localId === localProjectId ? remote.id : undefined;
  const selectedModelBilling=textModels.find(model=>model.code===textModel)?.billing;
  if (localProjectId && !remoteId) return <div className="pv-guidance-login">
    <p role={remoteError ? "alert" : "status"}>{remoteError || "正在打开项目助手…"}</p>
    {saveNotice}
    {remoteError ? <button type="button" className="pv-secondary" onClick={() => setRetryProject(value => value + 1)}>重试</button> : null}
  </div>;
  return (
    <div className="pv-guidance-session">
      <Modal title="当前文本模型费用说明" open={pricingOpen} onCancel={()=>setPricingOpen(false)} footer={null}>
        {selectedModelBilling?.rules?.length?<ModelBillingRules billing={selectedModelBilling} maxRules={selectedModelBilling.rules.length}/>:<p role="status">暂缺权威计费明细，请重新读取模型；不能据此视为免费。</p>}
        <p>实际结算以真实用量为准；生成前的预算属于预估。</p>
      </Modal>
      <AssistantSessionPanel
        modalRootClassName="studio-workspace-modal pv-modal create-flow-modal"
        composerSendIcon={() => <PrevizAgentActionGlyph />}
        composerStopIcon={<PrevizAgentActionGlyph stop />}
        composerPlaceholder={remoteId ? "描述想创建的模型、摆放位置或场景细节…" : "描述想讨论的站位、镜头或运镜…"}
        composerActionMode="exclusive"
        composerFeedbackPlacement="thread"
        isContextErrorHandled={saveFeedback?.hasReportedFailure}
        key={`${remoteId || "spatial-previs"}:${identity.identity}`}
        scope={remoteId ? { moduleCode: "PREVIZ_3DBOX", previzProjectId: remoteId } : { moduleCode: "SPATIAL_PREVIS" }}
        requiredContext={Boolean(remoteId)}
        executionPreference="AUTO"
        composerDraftStore={composerDraftStore}
        renderArtifact={remoteId ? artifact => artifact.type === "PREVIZ_SCENE"
          ? <PrevizBuildResult projectId={remoteId} artifact={artifact} />
          : artifact.type === "PREVIZ_PREVIEW" ? artifact.producerStepId
            ? <PrevizPreviewResult projectId={remoteId} stepId={artifact.producerStepId} />
            : <p>预览已归档，正在同步预览标识…</p> : undefined : undefined}
        attachmentTools={remoteId ? ({ disabled, openDocuments }) => <PrevizComposerAttachments
          key={remoteId} projectId={remoteId} disabled={disabled} images={referenceImages}
          onChange={setReferenceImages} onBusyChange={setReferenceUploading} openDocuments={openDocuments} /> : undefined}
        messageDisabledReason={remote?.role==='VIEWER'?"你拥有此项目的只读权限，不能提交生成或修改源码":referenceUploading ? "正在保存参考图，请稍候…" : remoteId && !textModel ? modelError || "正在读取可用文本模型…" : undefined}
        captureSelectedTextModelCode={remoteId ? () => textModelRef.current || undefined : undefined}
        composerTools={remoteId ? ({ disabled, skillLocked }) => <div className="pv-conversation-dock__sessions">
          <Choice label="场景搭建文本模型" value={textModel || "unavailable"}
            disabled={disabled || skillLocked || !textModels.length}
            items={textModels.length ? textModels.map(model=>({key:model.code,label:model.name})) : [{key:"unavailable",label:"暂无可用模型"}]}
            onChange={value=>{textModelRef.current=value;setTextModel(value);setModelError("");}} />
          <StudioCanvasTooltip title="费用说明"><button type="button" className="pv-composer-pricing" aria-label="费用说明" disabled={!textModel} onClick={()=>setPricingOpen(true)}><InfoCircleOutlined /></button></StudioCanvasTooltip>
        </div> : undefined}
        resolveContext={remoteId ? async () => {
          const current = await workspaceApi.currentSource(remoteId, true);
          const editorState = await captureEditor?.(remoteId,current.sourceVersionId??null,buildFileSteps);
          const editor = editorState ? await workspaceApi.saveEditor(remoteId, editorState.expectedVersion, editorState.state) : undefined;
          if (editor) await onEditorSaved?.(editor.editorVersion);
          return [{ kind: "PREVIZ_PROJECT", previzProjectId: remoteId, sourceVersion: current.sourceVersionId, label: "当前三维项目" },
            ...(editor ? [{ kind: "PREVIZ_EDITOR" as const, previzProjectId: remoteId, objectId: editor.editorVersion, contentHash: editor.editorVersion, label: "当前场景编辑状态" }] : []),
            ...referenceImages.filter(image => image.previzProjectId === remoteId)];
        } : undefined}
        actorId={identity.actorId}
        onMessageSubmit={remoteId ? requestStudioDesktopNotificationPermission : undefined}
        onSnapshot={remoteId ? (snapshot: AssistantSessionSnapshot) => {
          const sessionScope = `${adoptionScope.current}:${snapshot.sessionId}`;
          const restored = observedSession.current !== sessionScope;
          observedSession.current = sessionScope;
          const previews=snapshot.steps.filter(step=>step.toolCode==='aid.previz.preview'&&step.status==='SUCCEEDED').map(step=>step.stepId).slice(-4);
          setPreviewSteps(previous=>previous.join(',')===previews.join(',')?previous:previews);
          const liveBuilds = snapshot.steps.filter(step => previzBuildToolCodes.includes(step.toolCode || '') && step.status === "SUCCEEDED").map(step => step.stepId);
          const archivedBuilds = previzArchivedBuildSteps(snapshot);
          const completedBuilds = [...archivedBuilds, ...liveBuilds];
          if (completedBuilds.length) setBuildFileSteps(previous => completedBuilds.every(id => previous.includes(id)) ? previous : [...new Set([...previous, ...completedBuilds])]);
          if (remote?.role === 'VIEWER') return;
          const mutations = snapshot.steps.filter(step => [...previzBuildToolCodes, "aid.previz.scene-edit"].includes(step.toolCode||'') && step.status === "SUCCEEDED")
            .sort((a,b)=>BigInt(a.stepId)<BigInt(b.stepId)?-1:1);
          // Recover the preceding run even if the current turn is still checking a preview or reading context.
          const recoverable = mutations.length ? [] : archivedBuilds.filter(stepId =>
            !latestAdopter.current.isAdopted?.(stepId) && !latestAdopter.current.hasNewerAdoption?.(stepId));
          const archiveSignature = `${sessionScope}:${recoverable.join(',')}`;
          if (archivedAdoptionSignature.current !== archiveSignature) {
            archivedAdoptionSignature.current = archiveSignature;
            if (recoverable.length) {
              const scope = adoptionScope.current;
              void Promise.allSettled(recoverable.map(async stepId => {
                const manifest = await readBuildManifest(remoteId, stepId);
                return { stepId, kind: 'build' as const, operation: manifest.operation };
              })).then(receipts => {
                if (scope !== adoptionScope.current || archivedAdoptionSignature.current !== archiveSignature) return;
                const newest = receipts.at(-1);
                if (newest?.status === 'rejected') {
                  setAdoptionMessage(assistantErrorMessage(newest.reason));
                  setFailedAdoption({ projectId: remoteId, stepId: recoverable.at(-1)!, kind: 'build', recovered: true });
                  return;
                }
                if (!newest?.value.operation) {
                  setAdoptionMessage("历史构建没有记录采用范围，请在生成结果中查看或下载");
                  return;
                }
                const candidates = receipts.flatMap(receipt => receipt.status === 'fulfilled' && receipt.value.operation ? [receipt.value] : []);
                for (const stepId of previzAutomaticAdoptionSteps(candidates, true)) {
                  if (seenBuilds.current.has(stepId)) continue;
                  seenBuilds.current.add(stepId);
                  queueAdoption(remoteId, stepId, false, 'build', true);
                }
              });
            }
          }
          const schedule = (selected: string[]) => {
            for (const step of mutations) {
              if (!selected.includes(step.stepId) || seenBuilds.current.has(step.stepId) || latestAdopter.current.isAdopted?.(step.stepId)) continue;
              seenBuilds.current.add(step.stepId);
              queueAdoption(remoteId, step.stepId, !restored,step.toolCode==='aid.previz.scene-edit'?'edit':'build');
            }
          };
          if (snapshot.activeRun?.executionPreference !== 'AUTO') schedule(mutations.map(step=>step.stepId));
          else {
            const scope=adoptionScope.current;
            const settled=['SUCCEEDED','COMPLETED','FAILED','STOPPED','CANCELLED','CANCELED'].includes(snapshot.activeRun.status);
            const signature=`${scope}:${snapshot.sessionId}:${snapshot.activeRun.runId}:${settled}:${mutations.map(step=>step.stepId).join(',')}`;
            if (automaticAdoptionSignature.current===signature) return;
            automaticAdoptionSignature.current=signature;
            void Promise.all(mutations.map(async (step):Promise<PrevizAutomaticAdoptionCandidate>=>{
              if(step.toolCode==='aid.previz.scene-edit')return {stepId:step.stepId,kind:'edit'};
              const manifest=await readBuildManifest(remoteId,step.stepId);
              return {stepId:step.stepId,kind:'build',operation:manifest.operation};
            })).then(candidates=>{
              if(scope!==adoptionScope.current||signature!==automaticAdoptionSignature.current)return;
              const selected = previzAutomaticAdoptionSteps(candidates, settled);
              if (!settled && selected.length < candidates.length) setAdoptionMessage('正在完成场景预览与校验，结束后自动载入最终结果…');
              schedule(selected);
            }).catch(error=>{
              if(scope!==adoptionScope.current||signature!==automaticAdoptionSignature.current)return;
              setAdoptionMessage(assistantErrorMessage(error));
              const latest=mutations.filter(step=>step.toolCode!=='aid.previz.scene-edit').at(-1);
              if(latest)setFailedAdoption({projectId:remoteId,stepId:latest.stepId,kind:'build'});
            });
          }
        } : undefined}
        transport={previzAssistantTransport}
        conversational
        segmentedTimeline
        renderShell={({ snapshot, displaySnapshot, hasConversation, thread, composer, composerDisabled, insertComposerPrompt, loading, error, errorPresentation, retry, updateToken }) => {
          const feedback = previzRunFeedback(snapshot, !remoteId);
          const connectionError = errorPresentation?.kind === "CONNECTION";
          const status = error ? connectionError ? "会话连接异常，可重试" : "本次操作未完成"
            : (feedback.busy ? feedback.label : adoptionMessage || feedback.label) || (loading ? "正在同步会话…" : undefined);
          return <PrevizAssistantDock
            open={open}
            scopeKey={displaySnapshot?.sessionId || snapshot?.sessionId || "new"}
            updateToken={updateToken}
            initialLoading={loading && !hasConversation}
            onInsertModelingExample={open && remoteId && remote?.role !== 'VIEWER' && !hasConversation && !loading && !error && !composerDisabled
              ? () => insertComposerPrompt("搭建一张浅木色圆桌和两把椅子，靠窗摆放，给人物留出活动空间。")
              : undefined}
            busy={loading || feedback.busy}
            status={status}
            thread={<>
              {!hasConversation && !loading && !error ? <p className="pv-conversation-empty">{remoteId ? "想先搭建什么场景？描述你的想法，也可以添加参考素材。" : "想先讨论哪个镜头？告诉我场景和拍摄想法。"}</p> : null}
              {thread}
              {remoteId ? <div className="pv-conversation-recovery">
                {modelError ? <button type="button" disabled={loading} onClick={() => setRetryProject(value => value + 1)}>重新读取模型</button> : null}
                {feedback.busy && adoptionMessage ? <p role="status">{adoptionMessage}</p> : null}
                {failedAdoption ? <button type="button" onClick={() => queueAdoption(failedAdoption.projectId, failedAdoption.stepId, true, failedAdoption.kind, failedAdoption.recovered)}>{failedAdoption.kind==='edit'?'重新同步已保存编辑':'重新载入已生成场景'}</button> : null}
                <PrevizBuildFiles key={`${identity.identity}:${remoteId}`} projectId={remoteId} stepIds={buildFileSteps} />
              </div> : null}
              {remoteId ? previewSteps.map(stepId=><PrevizPreviewResult key={stepId} projectId={remoteId} stepId={stepId}/>) : null}
              {saveNotice}
              {error && connectionError ? <button type="button" className="pv-secondary" onClick={retry}>重新连接</button> : null}
              {error && errorPresentation?.kind === "UNKNOWN" ? <button type="button" className="pv-secondary" onClick={retry}>重新同步会话</button> : null}
            </>}
            composer={composer}
          />
        }}
      />
    </div>
  );
}
