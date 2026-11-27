import type { PrevizScene, PrevizAsset } from "@/types/previz";
import type { PrevizEditorSnapshot } from "./remoteWorkspace";
import { previzNetworkScene } from './sceneProjection';
import { digestSha256Hex } from '../sha256';

const assetHashes=new WeakMap<PrevizAsset,{dataUrl:string;hash:Promise<string>}>();
const hashText = (value: string) => digestSha256Hex(new TextEncoder().encode(value));
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
  return value;
}
/** Hash one asset at a time, without copying its binary into a model request. Object-key order is immaterial. */
export async function editorSceneDigest(scene: PrevizScene): Promise<string> {
  const assets=[];
  for(const asset of scene.assets){
    let cached=assetHashes.get(asset);
    if(!cached||cached.dataUrl!==asset.dataUrl){cached={dataUrl:asset.dataUrl,hash:hashText(asset.dataUrl)};assetHashes.set(asset,cached);}
    const {dataUrl:_bytes,...metadata}=asset;assets.push({...metadata,contentSha256:await cached.hash});
  }
  return hashText(JSON.stringify(canonical({...previzNetworkScene(scene),assets})));
}

export async function captureEditorSnapshot(scene: PrevizScene, selected: string[], frame: number, selectedObjectId?: string): Promise<PrevizEditorSnapshot> {
  if(selected.some(id=>!scene.nodes.some(node=>node.id===id)))throw new Error("选中的对象已不存在，请重新选择续改目标");
  const nodes = scene.nodes.map(({ id, name, kind, localTransform, visible, locked, assetOverrides, assetPlayback, assetId, parentId, color, assetObjectIds, assetPivotId }) => ({
    id, name, kind, localTransform, visible, locked, parentId, color,
    ...(assetObjectIds ? {assetObjectIds} : {}), ...(assetPivotId ? {assetPivotId} : {}),
    ...(assetOverrides ? { assetOverrides } : {}),
    ...(assetPlayback ? { assetPlayback } : {}),
    ...(scene.assets.find(asset => asset.id === assetId)?.buildOrigin ? { buildOrigin: scene.assets.find(asset => asset.id === assetId)!.buildOrigin } : {}),
  }));
  const generated = nodes.filter(node => node.buildOrigin && !node.locked);
  const chosen = generated.filter(node => selected.includes(node.id));
  return { sceneDigest: await editorSceneDigest(scene), frame, targetNodeId: (chosen.length===1?chosen[0]:generated.length===1?generated[0]:undefined)?.id || null, nodes,selectedNodeIds:selected,
    ...(selectedObjectId&&selected.length===1?{selectedObjects:[{nodeId:selected[0],objectId:selectedObjectId}]}:{}) };
}
