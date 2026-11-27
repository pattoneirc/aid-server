"use client";
import { digestSha256Hex } from "@/utils/sha256";
import {useEffect,useMemo,useState} from "react";
import {Modal} from "antd";
import {createPrevizWorkspaceApi} from "@/utils/previz/remoteWorkspace";
import {assistantErrorMessage} from "@/utils/assistant/assistantRequestCoordinator";

export function PrevizPreviewResult({projectId,stepId}:{projectId:string;stepId:string}) {
  const api=useMemo(createPrevizWorkspaceApi,[projectId]);
  const [open,setOpen]=useState(false),[image,setImage]=useState(""),[error,setError]=useState("");
  const [description,setDescription]=useState("");
  const [zoom,setZoom]=useState(false);
  useEffect(()=>{
    if(!open)return;
    let active=true,url="";setError("");
    void (async()=>{
      const result=await api.previewResult(projectId,stepId);
      if(result.projectId!==projectId)throw new Error("预览工程不一致");
      const media=await api.referenceImage(projectId,result.imageId);
      const maxPreviewBytes=16*1024*1024;
      if(media.contentBase64.length>Math.ceil(maxPreviewBytes/3)*4||!['image/png','image/jpeg'].includes(media.mimeType))throw new Error("预览图片格式无效");
      const bytes=Uint8Array.from(atob(media.contentBase64),char=>char.charCodeAt(0));
      if(bytes.length>maxPreviewBytes)throw new Error("预览图片超过大小限制");
      const digest = await digestSha256Hex(bytes);
      if(digest!==result.sha256||digest!==media.sha256)throw new Error("预览图片校验失败");
      if(!active)return;
      url=URL.createObjectURL(new Blob([bytes],{type:media.mimeType}));setImage(url);
      setDescription(`${result.width}×${result.height} · ${result.actualTime.toFixed(2)} 秒${result.cameraId?` · ${result.cameraId}`:''}${result.addedPreviewLight?' · 使用预览补光':''}`);
    })().catch(failure=>{if(active)setError(assistantErrorMessage(failure));});
    return()=>{active=false;if(url)URL.revokeObjectURL(url);setImage("");};
  },[api,projectId,stepId,open]);
  return <details open={open} onToggle={event=>{setOpen(event.currentTarget.open);if(!event.currentTarget.open)setZoom(false);}}>
    <summary>场景单帧预览</summary>
    {image?<><button type="button" aria-label="放大场景预览" onClick={()=>setZoom(true)} style={{display:"block",padding:0,border:0,background:"transparent",cursor:"zoom-in",maxWidth:"100%"}}>
      <img src={image} alt="已构建场景的真实单帧预览" style={{display:"block",maxWidth:"100%",width:320,height:"auto"}}/>
    </button><p>{description}</p>
      <Modal title="场景单帧预览" open={zoom} onCancel={()=>setZoom(false)} footer={null} width="min(960px, 94vw)" rootClassName="pv-modal">
        <img src={image} alt="场景预览完整图片" style={{display:"block",margin:"auto",maxWidth:"100%",maxHeight:"75vh",width:"auto",height:"auto"}}/>
        <p>{description}</p>
      </Modal>
    </>:!error?<p role="status">正在读取预览…</p>:null}
    {error?<p role="alert">{error}</p>:null}
    <p>此图对应构建时的固定编辑版本；之后的调整以当前视口为准。单帧不代表整段动画已验收。</p>
  </details>;
}
