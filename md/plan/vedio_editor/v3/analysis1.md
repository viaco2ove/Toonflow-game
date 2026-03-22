# Toonflow 当前实现为何“像一坨屎”

## 一句话结论
当前实现把“分镜生成流程”“时间轴编辑”“音频/台词生产”三套不同领域硬塞进同一套数据与接口，导致状态来源不唯一、接口语义反复漂移、前端组件过载、播放同步脆弱。你感受到的“屎感”，本质是架构失配，而不是单点 bug。

## 关键问题与证据

### P0（必须优先处理）
1. **领域模型混乱，`t_videoConfig` 过载**  
   证据：`D:/Users/viaco/tools/toonflow-app-run/src/lib/initDB.ts:234-259` 同时承载视频参数、音频/台词轨、语音配置、结果选择等多上下文字段。
2. **草稿态与持久态双轨并行，语义冲突**  
   证据：`chatStoryboard.ts:285-306` 使用负 ID 草稿映射；`upDateVideoConfig.ts:69-213` 同接口按 `id<0 / id>0` 执行两套逻辑；`deleteVideoConfig.ts:56-131` 同时删两种状态。
3. **时间轴不是“多轨编辑器”，只是顺排列表**  
   证据：`Toonflow-web/.../videoTimelineEditor.vue:400-405` 通过 `cursor += duration` 线性拼接；`912-918` 音频/台词轨只是过滤视图，不是独立 clip 模型。
4. **播放依赖多媒体对象手工对齐，天然漂移**  
   证据：`videoTimelineEditor.vue:1171-1201` 分别维护 `new Audio()` 并手动同步 `currentTime`。

### P1（会持续拉低迭代效率）
1. **单组件职责失控**：`videoTimelineEditor.vue` 约 1790 行，包含播放、轨道、缓存、上传、TTS、重生成等全流程逻辑。  
2. **前后端契约不统一**：返回格式混用（`success(...)` vs `{message}`）；`reviseVideoStoryboards.ts:14` 将 `duration` 定义为字符串。  
3. **状态不可复现**：音频覆盖逻辑依赖 `localStorage`（`videoTimelineEditor.vue:608-636`），跨设备不一致。  
4. **多用户边界薄弱**：多个接口硬编码 `userId = 1`（如 `getVoiceModelList.ts:8`）。

## 根因归类
1. **领域边界未建模**：时间轴、素材版本、渲染任务、语音生产没有拆分成独立实体。  
2. **状态机缺失**：草稿、已保存、渲染中、已发布没有统一生命周期。  
3. **前端架构错误**：编辑器核心状态散落在一个超大组件，无法稳定演进。  
4. **工程治理不足**：接口契约、类型约束、回归测试都不够硬。

## 最小止血方案（2-3 周）
1. 引入统一 `TimelineClip` DTO（`trackType/start/end/assetRef/version`），禁止继续扩展 `t_videoConfig`。  
2. 取消负 ID 分支，草稿改为显式 `draft` 表或单独接口。  
3. 将 `videoTimelineEditor.vue` 拆为：播放控制、轨道渲染、素材面板、任务面板四块。  
4. 播放改为“单主时钟 + 从轨订阅”，不再多 `Audio` 实例互相追赶。  
5. 去掉 `localStorage` 作为业务真相源，仅做临时 UI 缓存。

## 可持续重构路径（4-8 周）
1. 后端重建模型：`video_project`、`timeline_track`、`timeline_clip`、`asset_version`、`render_job`。  
2. 接口改为资源化：`PATCH /timeline/clips/:id`、`POST /assets/:id/regenerate`。  
3. 建立时间轴回归测试：seek、拖拽、切段、重生成后对齐一致性。  
4. 定义可观测指标：播放漂移、渲染失败率、跨设备一致性。

## 验收指标（建议）
- 30 分钟时间轴连续播放音画漂移 < 100ms。  
- 彻底移除负 ID 草稿逻辑。  
- 编辑器主文件降到 < 500 行（其余下沉到子模块）。  
- 同项目跨设备打开后轨道状态一致（不依赖本地覆盖）。
