import { digestSha256Hex } from '../sha256';
import type {
  PrevizAgentRequest,
  PrevizCandidate,
  PrevizCommand,
  PrevizDeliveryRequest,
  PrevizGateway,
  PrevizWorkingCopyStore,
  PrevizProject,
  PrevizSaveRequest,
} from "@/types/previz";
import {
  copy,
  createNode,
  createScene,
  resizeDuration,
  uid,
  validateScene,
} from "./core";

export class PrevizConflictError extends Error {
  constructor() {
    super("此工程已在另一窗口保存。当前草稿已保留，请选择重新载入或另存副本。");
    this.name = "PrevizConflictError";
  }
}
export const PREVIZ_BACKEND_CONTRACT = {
  status: "PROPOSED_NOT_CONNECTED",
  moduleCode: "PREVIZ",
  contextType: "PREVIZ_PROJECT",
  basePath: "/api/user/previz",
  assistantBasePath: "/api/user/assistant",
  project: [
    "space/current",
    "capabilities",
    "project/create",
    "project/page",
    "project/detail",
    "project/commands",
    "project/version/page",
    "project/version/restore",
    "project/remove",
  ],
  exports: ["export/quote", "export/create", "export/detail"],
  delivery: ["delivery/prepare", "delivery/commit", "delivery/detail"],
} as const;

type StoredProject = PrevizProject & { localAssetPool?: string[] };
// Historical scene snapshots share immutable embedded assets on disk instead of duplicating
// a 25MB model for every revision. The gateway always hydrates the public contract on read.
function packProject(project: PrevizProject): StoredProject {
  const stored: StoredProject = copy(project),
    pool: string[] = [],
    indices = new Map<string, number>();
  for (const scene of [stored.scene, ...stored.versions.map((v) => v.scene)])
    for (const asset of scene.assets) {
      let index = indices.get(asset.dataUrl);
      if (index === undefined) {
        index = pool.length;
        pool.push(asset.dataUrl);
        indices.set(asset.dataUrl, index);
      }
      asset.dataUrl = `@asset:${index}`;
    }
  stored.localAssetPool = pool;
  return stored;
}
function unpackProject(value: StoredProject): PrevizProject {
  if (!value.localAssetPool) return value;
  for (const scene of [value.scene, ...value.versions.map((v) => v.scene)])
    for (const asset of scene.assets)
      if (asset.dataUrl.startsWith("@asset:")) {
        const source = value.localAssetPool[Number(asset.dataUrl.slice(7))];
        if (!source) throw new Error("本地资产记录损坏，请导入工程备份");
        asset.dataUrl = source;
      }
  delete value.localAssetPool;
  return value;
}

function openDb(owner: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`aid-previz-v3:${owner}`, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("projects", { keyPath: "id" });
      req.result.createObjectStore("receipts", { keyPath: "id" });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () =>
      reject(new Error("本地工程库无法打开，请允许浏览器存储后重试"));
    req.onblocked = () =>
      reject(new Error("工程库升级被其他窗口阻止，请关闭旧窗口后重试"));
  });
}
async function read<T>(owner: string, store: string, id?: string): Promise<T> {
  const db = await openDb(owner);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly"),
      req = id ? tx.objectStore(store).get(id) : tx.objectStore(store).getAll();
    let result: T;
    req.onsuccess = () => {
      result =
        store === "projects"
          ? Array.isArray(req.result)
            ? req.result.map(unpackProject)
            : req.result
              ? unpackProject(req.result)
              : undefined
          : req.result;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("读取本地工程失败"));
    };
  });
}
/** IndexedDB readwrite transactions provide real multi-tab CAS and receipt atomicity. */
async function write<T>(
  owner: string,
  action: (
    projects: IDBObjectStore,
    receipts: IDBObjectStore,
    done: (value: T) => void,
    abort: (error: Error) => void,
  ) => void,
): Promise<T> {
  const db = await openDb(owner);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["projects", "receipts"], "readwrite");
    let result: T;
    let failure: Error | undefined;
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(
        failure ??
          tx.error ??
          new Error("保存失败，可能是浏览器存储空间不足；请导出工程备份"),
      );
    };
    try {
      action(
        tx.objectStore("projects"),
        tx.objectStore("receipts"),
        (value) => {
          result = value;
        },
        (error) => {
          failure = error;
          tx.abort();
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      tx.abort();
    }
  });
}
/** Local recovery repository; no model execution, paid generation or server-success claims. */
export function createPrevizWorkingCopyStore(owner: string): PrevizWorkingCopyStore {
  return {
    list: async () =>
      (await read<PrevizProject[]>(owner, "projects")).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    get: (id) => read(owner, "projects", id),
    create: async (project) => {
      validateScene(project.scene);
      return write(owner, (projects, _receipts, done, abort) => {
        const req = projects.get(project.id);
        req.onsuccess = () => {
          if (req.result) {
            abort(new Error("工程 ID 已存在"));
            return;
          }
          projects.add(packProject(project));
          done(copy(project));
        };
      });
    },
    save: async ({
      project,
      expectedRevision,
      operationId,
      summary,
    }: PrevizSaveRequest) => {
      validateScene(project.scene);
      const fingerprint = await digestSha256Hex(
        new TextEncoder().encode(JSON.stringify({ project, expectedRevision })),
      );
      return write(owner, (projects, receipts, done, abort) => {
        const receipt = receipts.get(operationId);
        receipt.onsuccess = () => {
          if (receipt.result) {
            if (
              receipt.result.projectId !== project.id ||
              receipt.result.fingerprint !== fingerprint
            ) {
              abort(new Error("同一操作 ID 不允许用于不同保存请求"));
              return;
            }
            const existing = projects.get(project.id);
            existing.onsuccess = () => {
              if (!existing.result) abort(new Error("工程已删除"));
              else done(unpackProject(existing.result));
            };
            return;
          }
          const current = projects.get(project.id);
          current.onsuccess = () => {
            if (!current.result) {
              abort(new Error("工程已删除，请另存副本"));
              return;
            }
            if (current.result.revision !== expectedRevision) {
              abort(new PrevizConflictError());
              return;
            }
            const previous = unpackProject(current.result);
            const next = copy(project),
              changed =
                JSON.stringify(next.scene) !== JSON.stringify(previous.scene);
            next.revision = expectedRevision + 1;
            next.updatedAt = new Date().toISOString();
            next.versionId = changed ? uid() : previous.versionId;
            next.versions = previous.versions;
            if (changed)
              next.versions = [
                ...next.versions,
                {
                  id: previous.versionId,
                  revision: previous.revision,
                  createdAt: previous.updatedAt,
                  summary: summary || "编辑场景",
                  scene: previous.scene,
                },
              ].slice(-20);
            projects.put(packProject(next));
            receipts.put({
              id: operationId,
              projectId: project.id,
              fingerprint,
              revision: next.revision,
              createdAt: next.updatedAt,
            });
            done(next);
            // Save receipt cleanup must never evict simulated delivery receipts.
            const savedReceipts = receipts.getAll();
            savedReceipts.onsuccess = () => {
              const rows = savedReceipts.result
                .filter((r) => typeof r.fingerprint === "string")
                .sort((a, b) =>
                  (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
                );
              if (rows.length > 1000)
                rows
                  .slice(0, rows.length - 1000)
                  .forEach((r) => receipts.delete(r.id));
            };
          };
        };
      });
    },
    remove: (id, expectedRevision) =>
      write(owner, (projects, _receipts, done, abort) => {
        const req = projects.get(id);
        req.onsuccess = () => {
          if (req.result && req.result.revision !== expectedRevision) {
            abort(new PrevizConflictError());
            return;
          }
          projects.delete(id);
          done(undefined);
        };
      }),
  };
}

/** Compatibility entry for explicit local demonstrations, never the server project repository. */
export function createMockPrevizGateway(owner: string): PrevizGateway {
  return {
    ...createPrevizWorkingCopyStore(owner),
    capabilities: {
      mode: "mock",
      models: [{ code: "mock-previz-v1", name: "白模演示智能体" }],
      cloudSave: false,
      officialExport: false,
      delivery: false,
      reason: "仅本地白模演示，不代表模型生成或服务器执行结果",
    },
    generate: mockGenerate,
    deliver: (request: PrevizDeliveryRequest) =>
      write(owner, (projects, receipts, done, abort) => {
        const current = projects.get(request.projectId);
        current.onsuccess = () => {
          if (
            !current.result ||
            current.result.versionId !== request.versionId
          ) {
            abort(new Error("来源工程已变化，请从当前版本重新导出"));
            return;
          }
          if (
            request.target.kind === "CANVAS" &&
            !request.target.workspaceId?.trim()
          ) {
            abort(new Error("请输入目标画布 ID"));
            return;
          }
          if (
            request.target.kind === "FLOW" &&
            (!request.target.projectId?.trim() ||
              !request.target.episodeId?.trim() ||
              !request.target.storyboardId?.trim())
          ) {
            abort(new Error("请输入目标项目、剧集和分镜 ID"));
            return;
          }
          const receipt = receipts.get(request.operationId);
          receipt.onsuccess = () => {
            const fingerprint = JSON.stringify(request);
            if (receipt.result) {
              if (receipt.result.fingerprint !== fingerprint) {
                abort(new Error("交付操作 ID 已用于其他请求"));
                return;
              }
              done(receipt.result.result);
              return;
            }
            const result = { id: uid(), status: "SIMULATED" as const };
            receipts.put({ id: request.operationId, fingerprint, result });
            done(result);
          };
        };
      }),
  };
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("已停止", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
/** Deterministic scene commands simulate the transport, not a paid/general language model. */
export async function mockGenerate(
  request: PrevizAgentRequest,
  signal: AbortSignal,
  stage: (stage: string) => void,
): Promise<PrevizCandidate> {
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length > 4000) throw new Error("描述须为 1–4000 字");
  validateScene(request.scene);
  for (const text of [
    "正在分析空间与镜头",
    "正在构建可编辑白模",
    "正在校验动画与镜头区间",
  ]) {
    stage(text);
    await delay(420, signal);
  }
  if (/模拟失败|模拟错误/.test(prompt))
    throw new Error("演示任务失败：未应用任何场景改动，可修改描述后重试");
  const commands: PrevizCommand[] = [],
    scene = request.scene;
  const selected = scene.nodes.filter(
    (n) => request.selectedObjectIds.includes(n.id) && !n.locked,
  );
  const target =
    selected[0] ?? scene.nodes.find((n) => n.kind === "ACTOR" && !n.locked);
  let summary = "";
  if (
    /生成|创建场景|搭建|新建场景/.test(prompt) ||
    scene.nodes.every((n) => ["PLANE", "CAMERA", "LIGHT"].includes(n.kind))
  ) {
    const next = createScene(
      /追逐|跑/.test(prompt)
        ? "chase"
        : /街|巷|户外|门廊/.test(prompt)
          ? "street"
          : "meeting",
    );
    next.aspectRatio = scene.aspectRatio;
    next.assets = copy(scene.assets);
    const seconds = prompt.match(/(\d+)\s*秒/);
    if (seconds)
      commands.push(
        resizeDuration(
          next,
          Math.min(1800, Math.max(30, Number(seconds[1]) * 30)),
        ),
      );
    else commands.push({ type: "scene.replace", scene: next });
    summary =
      "生成了可编辑人物、语义道具、走位和两个硬切镜头。演示智能体按会面、街巷或追逐模板构建，不进行真实模型推理。";
  } else if (/夜|白天|灯光|背景/.test(prompt)) {
    const preset = /夜/.test(prompt) ? "night" : "day";
    commands.push({
      type: "scene.settings",
      patch: {
        environment: {
          ...scene.environment,
          presetCode: preset,
          background: preset === "night" ? "#17202e" : "#56616b",
          exposure: preset === "night" ? 0.7 : 1.3,
        },
      },
    });
    summary = "调整了环境与布光，其他对象、轨道和镜头保持不变。";
  } else if (/时长|延长|缩短/.test(prompt)) {
    const seconds = prompt.match(/(\d+)\s*秒/);
    if (!seconds)
      throw new Error("请给出 1–60 秒的明确时长，例如“时长改为 10 秒”");
    if (+seconds[1] < 1 || +seconds[1] > 60)
      throw new Error("时长范围为 1–60 秒");
    commands.push(resizeDuration(scene, +seconds[1] * 30));
    summary = "按比例调整镜头区间与关键帧，保留对象及手工设置。";
  } else if (/添加|增加/.test(prompt)) {
    const kind = /椅/.test(prompt)
      ? "CHAIR"
      : /树/.test(prompt)
        ? "TREE"
        : /人物|角色/.test(prompt)
          ? "ACTOR"
          : /相机|机位/.test(prompt)
            ? "CAMERA"
            : "TABLE";
    const node = createNode(kind);
    if (kind === "CAMERA") {
      const source =
        selected.find((n) => n.kind === "CAMERA") ??
        scene.nodes.find(
          (n) =>
            n.id ===
            (
              scene.shots.find((s) => request.selectedShotIds.includes(s.id)) ??
              scene.shots[0]
            ).cameraId,
        )!;
      node.localTransform = copy(source.localTransform);
      node.camera = copy(source.camera);
      node.parentId = source.parentId;
    } else
      node.localTransform.position[0] +=
        scene.nodes.filter((n) => n.kind === kind).length * 1.5;
    commands.push({ type: "node.add", node });
    summary = `添加了${node.name}，现有内容保持不变。`;
  } else if (/删除|移除/.test(prompt)) {
    if (!selected.length) throw new Error("请先选择要删除的对象");
    selected.forEach((n) => commands.push({ type: "node.remove", id: n.id }));
    summary = "移除了所选对象及其轨道。";
  } else if (/近景|焦距|机位|镜头/.test(prompt)) {
    const camera =
      selected.find((n) => n.kind === "CAMERA") ??
      scene.nodes.find(
        (n) =>
          n.id ===
          scene.shots.find((s) => request.selectedShotIds.includes(s.id))
            ?.cameraId,
      ) ??
      scene.nodes.find((n) => n.kind === "CAMERA")!;
    commands.push({
      type: "node.update",
      id: camera.id,
      patch: {
        camera: { ...camera.camera!, fov: /广角|远/.test(prompt) ? 65 : 30 },
      },
    });
    summary = `调整了${camera.name}的视野，保留镜头切换时间。`;
  } else if (
    target &&
    /走|跑|挥手|坐|停止|移动|左|右|前|后|颜色/.test(prompt)
  ) {
    if (/走|跑|挥手|坐|停止/.test(prompt))
      commands.push({
        type: "node.update",
        id: target.id,
        patch: {
          action: /跑/.test(prompt)
            ? "run"
            : /挥手/.test(prompt)
              ? "wave"
              : /坐/.test(prompt)
                ? "sit"
                : /停止/.test(prompt)
                  ? "idle"
                  : "walk",
        },
      });
    if (/移动|左|右|前|后/.test(prompt)) {
      const position = [...target.localTransform.position] as [
          number,
          number,
          number,
        ],
        amount = Number(prompt.match(/(\d+(?:\.\d+)?)\s*米/)?.[1] ?? 1);
      if (/左/.test(prompt)) position[0] -= amount;
      if (/右/.test(prompt)) position[0] += amount;
      if (/前/.test(prompt)) position[2] += amount;
      if (/后/.test(prompt)) position[2] -= amount;
      commands.push({
        type: "node.update",
        id: target.id,
        patch: { localTransform: { ...target.localTransform, position } },
      });
      // Existing position tracks receive the same delta so the adjustment remains visible on playback.
      const timeline = copy(scene.timeline),
        old = target.localTransform.position;
      for (const track of timeline.tracks.filter(
        (t) => t.nodeId === target.id && t.channel === "position",
      ))
        track.keys.forEach((k) => {
          k.value = k.value.map((v, i) => v + position[i] - old[i]) as [
            number,
            number,
            number,
          ];
        });
      commands.push({ type: "timeline.replace", timeline, shots: scene.shots });
    }
    if (/颜色/.test(prompt))
      commands.push({
        type: "node.update",
        id: target.id,
        patch: {
          color: /红/.test(prompt)
            ? "#d89d91"
            : /蓝/.test(prompt)
              ? "#8baac4"
              : "#d5c5a1",
        },
      });
    summary = `局部修改了${target.name}，其他对象和镜头保持不变。`;
  } else
    throw new Error(
      "演示支持生成会面／街巷／追逐、添加道具、所选对象移动／动作／颜色、近景、夜景与时长修改。请具体描述上述操作。",
    );
  return {
    id: request.clientRequestId,
    baseVersionId: request.baseVersionId,
    commands,
    summary,
  };
}
