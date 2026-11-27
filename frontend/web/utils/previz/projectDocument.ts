import type {PrevizProject, PrevizScene, PrevizAsset, PrevizAnnotation, PrevizVersion} from '@/types/previz';
import {validateScene} from './core';
import {createPrevizWorkspaceApi} from './remoteWorkspace';
import {previzNetworkScene} from './sceneProjection';
import {digestSha256Hex} from '../sha256';

type Api=ReturnType<typeof createPrevizWorkspaceApi>;
type BlobRef={sha256:string;sizeBytes:number;mimeType:string};
type StoredScene=Omit<PrevizScene,'assets'> & {assets:(Omit<PrevizAsset,'dataUrl'> & {blob:BlobRef})[]};
export type ProjectDocument={schemaVersion:1;title:string;scene:StoredScene;versions:(Omit<PrevizVersion,'scene'> & {scene:StoredScene})[];annotations:(Omit<PrevizAnnotation,'image'> & {imageRef:BlobRef})[];thumbnail?:BlobRef;adoptedBuildSteps?:string[]};
type Guard=()=>void;
function base64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);}
function bytes(encoded:string){const raw=atob(encoded);const result=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)result[i]=raw.charCodeAt(i);return result;}
const yieldUI=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

/** Transfer one asset at a time. Never send embedded scene assets in the document request. */
export async function packProjectDocument(project:PrevizProject,projectId:string,api:Api,guard:Guard,onProgress:(message:string)=>void):Promise<ProjectDocument>{
 if(project.scene.timeline.frameCount>1800||project.scene.nodes.length>1000)throw new Error('当前建模服务仅支持60秒、1000个对象的编辑投影；完整场景已保留本机，请导出完整工程。');
 const cache=new Map<string,BlobRef>();let count=0;
 async function upload(url:string):Promise<BlobRef>{
  guard();const cached=cache.get(url);if(cached)return cached;
  const match=/^data:(model\/gltf-binary|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if(!match||match[2].length>Math.ceil(33554432/3)*4)throw new Error('项目资产格式或大小无效');
  const data=bytes(match[2]);if(!data.length||data.length>33554432)throw new Error('项目资产超过 32 MiB');
  const digest=await digestSha256Hex(data);guard();const ref={sha256:digest,sizeBytes:data.length,mimeType:match[1]};
  const upload=await api.assetBegin(projectId,digest,data.length,match[1]);guard();
  if(!upload.complete){const received=new Set(upload.uploadedChunks);for(let index=0;index<upload.chunkCount;index++){
   guard();if(received.has(index))continue;const chunk=data.subarray(index*upload.chunkBytes,(index+1)*upload.chunkBytes);
   onProgress(`正在保存素材 ${count+1} · ${index+1}/${upload.chunkCount}`);
   await api.assetChunk(projectId,upload.uploadId,index,base64(chunk),await digestSha256Hex(chunk));await yieldUI();
  }guard();await api.assetComplete(projectId,upload.uploadId);}
  cache.set(url,ref);count++;return ref;
 }
 async function scene(value:PrevizScene):Promise<StoredScene>{validateScene(value);const assets:StoredScene['assets']=[];for(const asset of value.assets){const {dataUrl,...rest}=asset;assets.push({...rest,blob:await upload(dataUrl)});}return {...previzNetworkScene(value),assets};}
 const current=await scene(project.scene),versions:ProjectDocument['versions']=[],annotations:ProjectDocument['annotations']=[];
 for(const version of project.versions)versions.push({...version,scene:await scene(version.scene)});
 for(const annotation of project.annotations){const {image,...rest}=annotation;annotations.push({...rest,imageRef:await upload(image)});}
 const thumbnail=project.thumbnail?await upload(project.thumbnail):undefined;guard();
 return {schemaVersion:1,title:project.title,scene:current,versions,annotations,...(thumbnail?{thumbnail}:{}),adoptedBuildSteps:project.adoptedBuildSteps||[]};
}

export async function unpackProjectDocument(raw:unknown,projectId:string,api:Api,guard:Guard,onProgress:(message:string)=>void,reusableAssets:PrevizAsset[]=[]):Promise<Pick<PrevizProject,'title'|'scene'|'versions'|'annotations'|'thumbnail'|'adoptedBuildSteps'>>{
 const doc=raw as ProjectDocument;
 if(!doc||doc.schemaVersion!==1||typeof doc.title!=='string'||!Array.isArray(doc.versions)||doc.versions.length>20||!Array.isArray(doc.annotations)||doc.annotations.length>1000)throw new Error('项目文档格式无效');
 const cache=new Map<string,string>();
 for(const asset of reusableAssets){guard();const match=/^data:(model\/gltf-binary|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(asset.dataUrl);if(!match)continue;const value=bytes(match[2]);if(value.length>33554432)continue;cache.set(`${await digestSha256Hex(value)}:${value.length}:${match[1]}`,asset.dataUrl);}
 async function download(ref:BlobRef):Promise<string>{
  guard();if(!ref||!/^[a-f0-9]{64}$/.test(ref.sha256)||!Number.isInteger(ref.sizeBytes)||ref.sizeBytes<1||ref.sizeBytes>33554432||!['model/gltf-binary','image/png','image/jpeg','image/webp'].includes(ref.mimeType))throw new Error('项目资产引用无效');
  const key=`${ref.sha256}:${ref.sizeBytes}:${ref.mimeType}`,cached=cache.get(key);if(cached)return cached;
  const data=new Uint8Array(ref.sizeBytes);for(let offset=0;offset<data.length;offset+=262144){
   guard();onProgress(`正在读取素材 ${cache.size+1} · ${Math.floor(offset/262144)+1}/${Math.ceil(data.length/262144)}`);
   const part=await api.assetRead(projectId,ref.sha256,offset,Math.min(262144,data.length-offset));const chunk=bytes(part.contentBase64);
   if(chunk.length!==Math.min(262144,data.length-offset)||await digestSha256Hex(chunk)!==part.chunkSha256)throw new Error('项目素材分块校验失败');data.set(chunk,offset);await yieldUI();
  }if(await digestSha256Hex(data)!==ref.sha256)throw new Error('项目素材完整性校验失败');guard();const url=`data:${ref.mimeType};base64,${base64(data)}`;cache.set(key,url);return url;
 }
 async function scene(value:StoredScene):Promise<PrevizScene>{
  if(!value||!Array.isArray(value.assets)||value.assets.length>32)throw new Error('场景资产列表无效');const assets:PrevizAsset[]=[];
  for(const asset of value.assets){const {blob,...rest}=asset;assets.push({...rest,dataUrl:await download(blob)});}const output={...value,assets};validateScene(output);return output;
 }
 const current=await scene(doc.scene),versions:PrevizVersion[]=[],annotations:PrevizAnnotation[]=[];
 for(const version of doc.versions)versions.push({...version,scene:await scene(version.scene)});
 for(const annotation of doc.annotations){const {imageRef,...rest}=annotation;annotations.push({...rest,image:await download(imageRef)});}
 const thumbnail=doc.thumbnail?await download(doc.thumbnail):undefined;guard();return {title:doc.title,scene:current,versions,annotations,thumbnail,adoptedBuildSteps:doc.adoptedBuildSteps||[]};
}
