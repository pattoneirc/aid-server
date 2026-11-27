import type { PrevizBuildArtifact } from './remoteWorkspace';
import { PREVIZ_GLB_MAX_BYTES } from './limits';
import { digestSha256Hex } from '../sha256';

/** One bounded integrity gate for adopting or downloading an authoritative build artifact. */
export async function previzBuildArtifactBytes(artifact: PrevizBuildArtifact): Promise<Uint8Array<ArrayBuffer>> {
  const metadata=artifact.artifact;
  if(artifact.mimeType!=='model/gltf-binary'||!metadata||!Number.isSafeInteger(metadata.glbBytes)
    ||metadata.glbBytes<20||metadata.glbBytes>PREVIZ_GLB_MAX_BYTES||!/^[a-f0-9]{64}$/.test(metadata.sha256)
    ||typeof artifact.contentBase64!=='string'||artifact.contentBase64.length>Math.ceil(PREVIZ_GLB_MAX_BYTES/3)*4+4)
    throw new Error('生成模型文件清单或长度无效');
  const bytes=Uint8Array.from(atob(artifact.contentBase64),character=>character.charCodeAt(0));
  if(bytes.byteLength!==metadata.glbBytes)throw new Error('模型文件长度校验失败');
  const header=new DataView(bytes.buffer);
  if(header.getUint32(0,true)!==0x46546c67||header.getUint32(4,true)!==2||header.getUint32(8,true)!==bytes.byteLength)
    throw new Error('模型文件格式校验失败');
  const digest = await digestSha256Hex(bytes);
  if(digest!==metadata.sha256)throw new Error('模型文件指纹校验失败');
  return bytes;
}
