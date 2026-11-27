"use client";

import { digestSha256Hex } from "@/utils/sha256";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPrevizWorkspaceApi } from "@/utils/previz/remoteWorkspace";
import { assistantErrorMessage } from "@/utils/assistant/assistantRequestCoordinator";
import { downloadPreviz } from "@/utils/previz/export";

type NativeFile = { stepId: string; name: string; sizeBytes: number; sha256: string };
export function PrevizBuildFiles({ projectId, stepIds }: { projectId: string; stepIds: string[] }) {
  const api = useMemo(createPrevizWorkspaceApi, [projectId]);
  const [files, setFiles] = useState<NativeFile[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const downloadLock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void Promise.all(stepIds.map(async stepId => {
      const manifest = await api.buildManifest(projectId, stepId);
      if (manifest.runtimeStepId !== stepId || manifest.projectId !== projectId) throw new Error("工程文件归属不一致");
      return (manifest.nativeArtifacts || []).map(file => {
        if (file.name !== "scene.blend" || !/^[a-f0-9]{64}$/.test(file.sha256)
            || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > 128 * 1024 * 1024)
          throw new Error("工程文件清单无效");
        return { ...file, stepId };
      });
    })).then(groups => { if (active) { setFiles(groups.flat()); setError(""); } })
      .catch(failure => { if (active) setError(assistantErrorMessage(failure)); });
    return () => { active = false; };
  }, [api, projectId, stepIds, retry]);
  const download = async (file: NativeFile) => {
    if (downloadLock.current) return;
    downloadLock.current = true; setLoading(true); setError("");
    try {
      const blob = await api.nativeFile(projectId, file.stepId);
      if (!(blob instanceof Blob) || blob.size !== file.sizeBytes) throw new Error("工程文件下载不完整，请重试");
      const digest = await digestSha256Hex(await blob.arrayBuffer());
      if (digest !== file.sha256) throw new Error("工程文件校验失败，请重试");
      if (!alive.current) return;
      downloadPreviz(blob, file.name);
    } catch (failure) { if (alive.current) setError(assistantErrorMessage(failure)); }
    finally { downloadLock.current = false; if (alive.current) setLoading(false); }
  };
  return <div className="pv-reference-images">
    {files.map((file, index) => <button type="button" key={file.stepId} disabled={loading} onClick={() => void download(file)}>
      {loading ? "正在校验下载…" : `下载 Blender 工程${files.length > 1 ? ` ${index + 1}` : ""}`}
    </button>)}
    {error ? <p role="alert">{error} <button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>重新读取文件</button></p> : null}
  </div>;
}
