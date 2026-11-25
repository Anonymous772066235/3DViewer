# 3DViewer 改动日志（CHANGELOG）

| 项 | 值 |
| --- | --- |
| 当前版本 | `1.0.5.1` |
| 记录范围 | 2026-10-21（项目起点）→ 2026-11-23 |
| 版本号规则 | 在 `git` 最新提交版本的基础上**末位 +1，逢十进一**；`index.html` 的 `?v=` 同步更新以强制刷新缓存 |
| 数据来源 | 文件创建/修改时间戳（实测）+ `index.html` 版本号 + 会话改动记录 |

> **关于本文里的 `v1.0.3.5` ~ `v1.0.5.0`**：这些都是**同一次未提交改动**内的过程小节，
> 保留它们是为了把"为什么改、改坏了什么、怎么修回来"的因果链记清楚。
> 对外只有一个版本号：`git HEAD` 是 `1.0.3.2`，本次按规则发布为 **`1.0.3.3`**。

> **可信度说明**：`2026-10-21` ~ `2026-10-22` 上午没有逐条记录，只保留由现存代码反推的「基线能力」（文中标注 *基线*）。`2026-10-22` 下午起为逐条实测记录。

---

## 1.0.5.4：线框/法向也异步化，三功能全进度条不阻塞（2026-11-23）

边界已分帧异步 + 进度条（1.0.5.2/1.0.5.3）；线框与法向此前仍同步跑 computeTopo，
勾选时卡主线程且无进度。本次统一：

- **`js/worker_io.js`**：新增 `computeTopoAsync`，与 `computeTopo` 同算法（零 Map），
  每 20 万面让出一次主线程并回调进度，完成后返回 edges/faces。
- **`js/render.js`**：删除同步 `ensureTopo`/`requestTopo`，新增 `ensureTopoAsync`：
  线框与法向共享同一次计算（waiters 队列），进度条「生成线框/法向 · N%」；
  `ensureWire`/`ensureNormals` 改为回调里建 VAO + `invalidate()`，加 `wirePending`/`normalPending` 防重入、
  图层释放守卫。至此线框/法向/边界三者均分帧异步 + 进度条，渲染不阻塞。
- 已知小瑕疵：同时勾选三者时，线框/法向进度与边界进度各自独立，进度条可能短暂互相覆盖。
- `index.html` 全部 `?v=` 同步 `1.0.5.4`。

---

## 1.0.5.3：边界算法改为排序法，零 Map（2026-11-23）

边界本质是线框中「两点间只连一次」的边。旧 `computeBoundaryAsync` 用 `Map` 统计每条边出现次数，
千万级 Map 操作 + 500 万项对象内存（200~400 MB）。改为排序法：

- **`js/worker_io.js`**：每条边编码为 `min*2^24 + max`（key ≤ 2^48 < 2^53，Float64 精确），
  写入 `Float64Array` 后原生 `sort()`；排序后「落单的 key」即边界边，解码回两个顶点。
  内存 ~80 MB（原 200~400 MB），无 JS 对象操作；写 key 阶段仍分帧、进度条 0→70%，
  原生 sort 一次性（0.72），扫描落单 0.88→1。非流形边（共享 ≥3 面）语义与旧版一致（不输出）。
- `index.html` 全部 `?v=` 同步 `1.0.5.3`。

---

## 1.0.5.2：边界计算分帧异步 + 进度条（2026-11-23）

边界是唯一需要全局 Map 去重的拓扑量，大网格勾选时同步跑会卡死主线程、
进度条也无法刷新。改为分帧计算并暴露进度：

- **`js/worker_io.js`**：新增 `computeBoundaryAsync(positions, triangles, tri, onProgress, onDone)`，
  与 `computeBoundary` 同算法但每 20 万面让出一次主线程（`setTimeout(0)`），每批回调进度，
  完成后一次性生成 boundary 数组并回调。
- **`js/render.js` / `js/app.js`**：`renderHooks` 新增 `progress` hook（注入 `MV.ui.setProgress`）；
  `ensureBoundary` 改为异步触发，显示「统计边界边 · N%」进度条，完成后建 VAO 并 invalidate；
  加 `boundaryPending` 防重入、图层释放守卫（`layer.gpu !== g` 时丢弃结果）。
- 交互体验：勾选边界不再假死，进度可见可预期；线框/法向保持零 Map 快速路径。
- `index.html` 全部 `?v=` 同步 `1.0.5.2`。

---

## 1.0.5.1：拆分 computeTopo，线框/法向零 Map（2026-11-23）

问题：上一版修复 file:// 拓扑后，导入大网格会自动同步跑旧 `computeTopo`——
它为了「边界统计」对 338 万面做约 1000 万次 Map 操作、500 万项 Map + 3 个 JS Array，
主线程秒级卡死、峰值 600 MB~1 GB。用户指出线框=每面三边连线、法向=叉积单位化，都无需全局去重。

- **`js/worker_io.js`**：`computeTopo` 重写为零 Map 快速版：线框每面直接输出 3 条边（共享边重复画在同位置，视觉无差别），
  法向逐面叉积；`edges`/`faces` 用 `subarray` 零拷贝替代 `slice`。新增 `computeBoundary`（独占 Map，仅勾选边界时调用）。
  Worker `cmd:'topo'` 改为 slice 精确长度后 transfer，避免 subarray 视图在接收端长度错误。
- **`js/render.js`**：`ensureBoundary` 改为单独调 `computeBoundary`，不再依赖 computeTopo 的空边界字段。
- 效果：线框/法向从「千万级 Map + 数百 MB」降为「O(tri) 顺序数组写入」，file:// 下近实时；
  边界仅按需付费。索引 buffer 约 40 MB→81 MB（共享边不合并），以内存换零卡顿。
- `index.html` 全部 `?v=` 同步 `1.0.5.1`。

---

## 1.0.5.1：点云法向计算接口 + 三处入口（2026-11-25）

> 对外版本按「git HEAD `1.0.5.0` 末位 +1」= `1.0.5.1`；下面 1.0.5.4/1.0.5.3/1.0.5.2 为同一次未提交过程记录。

- **`js/algo.js`**：新增 `MV.icp.computePointNormals(positions, count, opts)`——
  逐点取 k 近邻，协方差最小特征向量作局部法向；参数 `k`(默认16)、`radius`(半径倍数)、`viewDir`(朝向视点定向)。
  用 KD-tree `radius()` 逐步放大半径找够邻居，复用 `jacobi3` 特征分解。
- **`js/render.js`**：`ensureNormals` 支持点云分支——从 `data.normals` 构造法向线段 VAO，
  长度按 bbox 对角线比例；复用既有 `drawNormals` LINES 绘制，无需新程序。
- **三处入口**：工具菜单「法向」按钮、点云图层属性「法向」勾选框（含计算按钮/长度滑块）、
  快捷键 N（点云：无法向弹参数框，有法向直接切换显示；mesh 保持原开关行为）。
- **参数对话框** `#normdlg`：k 近邻数、搜索半径倍数、朝向（视点/不定向）；ESC/遮罩/取消均可关闭；
  计算后回填 `data.normals` + `normalsStamp`，失效旧 VAO 并刷新。
- **配准 symICP 按"有无法向"判定，与数据形态无关**（`js/ui.js`）：
  修复采样对象重建时把点云法向硬编码为 null 的缺陷；mesh 无条件按面法向加权算法向，
  points 沿用自带法向（随图层位姿逆旋转复位），覆盖 mesh-mesh / mesh-points / points-mesh / points-points
  四种组合；任一侧缺法向自动退化为点到点。验证器与主 ICP 均使用同一份法向。
- **参考/目标互换**（`index.html` + `ui.js` + `css/style.css`）：N-N 与 ICP 两对下拉中间加 ⇄ 按钮，
  点击交换两个选中值并重填；样式用 flex 固定宽度不被挤压。
- **法向计算移入 Worker + 进度条**（`algo.js`/`worker_io.js`/`app.js`/`ui.js`）：
  `computePointNormals` 加 `onProgress`（每 1% 回调）；`worker_io.js` importScripts algo.js 并新增
  `cmd:'pointNormals'`（进度消息 + 结果 transfer）；`app.js` 新增 `computePointNormalsAsync`
  （http 走 Worker 传顶点副本，file:// 同步回退）；UI 计算时显示「计算点云法向 · N%」进度条，
   Worker 异常时结掉 pending 避免卡住。
- **file:// 全 Worker 单线程回退审查与修复**：确认全部 3 处 Worker 创建点（预处理/拾取网格/ICP）
  均有协议判断，所有实际在用的命令（parse/pickgrid/pointNormals/coarseInit/solve）都有等价同步路径。
  修复：`algo.js` 法向计算重构为 ctx+range 模式并新增 `computePointNormalsChunked`（file:// 分帧回退，
  进度条可见、不冻结）；`app.js` Worker onerror 补清 `parsePending`，避免导入 Promise 永久挂起。
- **清理死代码**：删除 `worker_io.js` 的 `topo` 命令分支（拓扑已统一走主线程分帧）、
  同步版 `computeTopo`/`computeBoundary`（仅分帧版在用）及 Worker 内无用局部变量；
  删除 `worker_align.js` 的 `verifyInit`/`score`/`screen` 三个无调用方命令与函数（候选验证在主线程）。
- **修复点云法向勾选后无显示**（`js/render.js`）：`renderFrame` 的点云分支只调 `drawPoints`，
  从未调用 `ensureNormals`/`drawNormals`（该调用只在 mesh 的 `drawMeshLayer` 内）→ 点云法向 VAO 永远不建。
  在非 ghost 点云绘制后补上 `[if (lay.showNormals) ensureNormals + drawNormals]`，与 mesh 一致。
- **修复参考/目标互换按钮无效**（`js/ui.js`）：两个下拉互相排除了对方的 option，
  原实现直接 `r.value=dv; d.value=rv` 时 option 不存在、赋值落空，重填后又恢复原状。
  改为 `fillLayerSelects` 支持 `forced={ref,dst}` 覆盖选中值，互换时用 forced 重填。
- **修复 ICP 后做 N-N 越来越歪**（`js/ui.js`）：`rayPickLayer` 用世界射线对 CPU `data.positions`
  求交，返回的已是数据空间点；但 `pickToData` 在预览态又乘 `inv(previewMat)` 二次变换，
  污染选点。`regSolve` 算出矩阵后只挂 GPU 预览、不退出选点，用户继续点选时每个新点都被污染，
  重复求解误差逐级累积。修复：`pickToData` 直接返回交点（标签显示仍由 `pickDisplayPos` 正变换）；
  `regSolve` 求解前补 `syncPickPts()` 消除一帧滞后。
  注：N-N 输出是「世界增量」，与 ICP 的「绝对位姿」语义不同，**不能**给 N-N 加 `×inv(xformMat)`。
- **二次修复 N-N 计算后不对齐**（`js/ui.js`）：
  ① `xformTargetLayer` 在 N-N 选点模式（`regMode`）下优先 `reg-dst`——此前总优先 `icp-dst`，
  两个面板目标层不同时，N-N 矩阵被预览到错误图层，看起来"完全没对齐"。
  ② `regPick` 在矩阵框有非零待应用矩阵时拒绝继续选点并给提示——预览态画面是 `previewMat×数据`，
  而 `rayPickLayer` 对未变换的 CPU 顶点求交，两者坐标系不一致，继续选点必然漂移。
  用户需先应用或丢弃再继续选点，以正确性优先。
- **法向计算弹窗与按钮优化**：弹窗从复用内存预估样式改为专用紧凑布局——
  「标签 / 滑块 / 数值」同一行，朝向从下拉框改为分段按钮并**默认不定向**；
  每次打开重置为默认参数（k=16、半径 2.5×、不定向）。滑块数值带 `×` 单位。
- **法向弹窗尺寸与定位再优化**：属性面板「计算…」按钮固定宽度靠左，不再撑满整行；
  弹窗宽度 400→320px、参数行与分段按钮/底部按钮全面收紧；
  遮罩改为按 `#view-area` 矩形定位，在三维视口内居中（不再相对整个窗口，侧栏宽时不再偏移）。
- `index.html` 全部 `?v=` 与 CHANGELOG 表头统一 `1.0.5.1`。

---

## 1.0.5.4：精简顶点表别名字段（2026-11-25）

审查确认：当前实际数据路径（OBJ/PLY 索引格式）中 `positions`/`uniqVerts`/`preVerts` 已是同一 buffer 的别名，无重复分配；真正冗余的是三个同值字段名本身，且读取优先级不一致（`preVerts‖uniqVerts‖positions` 在各模块顺序不同，易出错）。

- 删除 `data.preVerts`/`data.preIdx`/`data.preVcount` 三个别名字段（及新增后又删除的 `vcount`），
  顶点/索引统一为 `data.uniqVerts`/`data.remap`；`data.positions` 保留原始 soup 语义供 STL 导出保真。
- 更新全部读取点：`render.js`（uploadLayer/ensureTopoAsync/ensureBoundary）、`app.js`（pickGrid/字段写入）、
  `ui.js`（icpSample/xformOnce）、`algo.js`（splitMesh/undo/pickGrid/双视口拾取），共 10 处。
- 保留 `preOrderedIdx`（分块重排索引）、`preChunks`（分块 AABB）、`preLods`（LOD 兼容层）——语义独立，非别名。
- `index.html` 全部 `?v=` 同步 `1.0.5.4`。

---

## 1.0.5.3：修复 ICP 应用后渲染弹回变换前（2026-11-25）

现象：配准结束时预览位姿正确，点击应用后画面却回到变换前的位置/结构。
根因：`js/ui.js` 的 `applyXformToLayer` 只变换 `d.positions`/`d.uniqVerts`/`d.normals`，
而渲染层 `uploadLayer` 优先用 `d.preVerts`（Worker 预处理顶点表）上传 GPU —— 它没被变换，
清掉 `previewMat` 后画的是旧顶点。

修复（`js/ui.js`）：
- 三份顶点表（`positions`/`uniqVerts`/`preVerts`）统一走 `xformOnce`（对象去重，防共享 buffer 被变换两次）；
- `d.preChunks` 的 64 个分块 AABB 用 8 角点随刚体矩阵变换后重算，避免视锥剔除误剔已移动的面。

`index.html` 全部 `?v=` 同步 `1.0.5.3`。

---

## 1.0.5.2：移除收尾轮 + mesh-mesh 统一走 symICP（2026-11-25）

问题：对齐 `0.5-孔位工件_oh.obj` 与 `0.5-手持-孔位工件-0.9-4k_oh.obj` 时，
4PCS 给出好位姿、ICP 第一轮已收敛，后续收紧容差的"收尾轮"却把结果配歪；
实测收尾轮无收益，最终**彻底移除**。

1. **移除收尾轮**（`js/ui.js`，主线程 + Worker 两路径）：
   删除 `refineCount`/`preRefineRms`/`preRefineMat`/`preRefineUsed`/`refineReverted` 相关状态、
   第二轮求解与回退逻辑、文案中的"含 N 轮收紧容差"。
   ICP 收敛后**直接采用该矩阵**，不再有任何后续轮次干扰。
   历史根因记录：旧版收尾轮 `diag*0.008` 反而比好初值第一轮的 `bestRms*3` 更宽，
   且 RMS 口径随参与点变化不可比 —— 这些正是移除而非修补的理由。
2. **mesh-mesh 统一走 symICP**（`js/ui.js`）：采样后若两侧都是 mesh，
   按「面法向加权」算顶点法向写回 `moving.nrm`/`fixed.nrm`，
   4PCS 候选验证与主 ICP 都走有法向的 symICP；点云输入仍退化为点到点。

`index.html` 全部 `?v=` 同步 `1.0.5.2`。

---

## 1.0.5.1：4PCS 移入 Worker，文件更名 worker_align.js，丢弃 PCA（2026-11-25）

- **`js/worker_icp.js` → `js/worker_align.js`**：统一承担 Super4PCS 粗配准 + 候选验证 + ICP 精配准。
  新增 `coarseInit` / `coarseStep` 命令：4PCS 分步求解在 Worker 内跑，主线程只接收每步矩阵写 GPU 预览，
  配准期间不再阻塞渲染。`cancel` 同时取消粗配准。
- **4PCS 无需初始位姿、无约束**：UI 侧只准备采样参数，搜索解由 Worker 返回；
  `file://` 下 Worker 不可用时**在主线程分步跑 4PCS**（每帧一步 + 进度条，不整体阻塞），
  并给 warn 提示建议改用 serve.bat。
- **丢弃 PCA 多假设与质心对齐候选**：候选集只剩 4PCS 搜索解一个；验证阶段按 ICP 残差判断可否作初值。
  `MV.icp.pcaCandidates` 作为工具函数保留在 algo.js，配准流程不再调用。
- 预算适中提升：`maxTrials` 30→60、`pairLimit` 8000→10000、`maxCongruent` 300→400（进 Worker 后不再卡帧）。
- 文档：README / GUIDE 的线程职责、目录树、三阶段示例同步更新。
- `index.html` 全部 `?v=` 同步 `1.0.5.1`。

---

## 1.0.5.0：全量几何 + 可见性剔除，修复 file:// 拓扑开关（2026-11-23）

> 版本号按「末位 +1，逢十进一」：git HEAD `1.0.4.9` → 本次发布 `1.0.5.0`。
> 本节与下面 `1.0.4.10`/`1.0.4.11`/`1.0.4.12` 均属同一次未提交改动的过程记录，对外只有一个版本 `1.0.5.0`。

用户要求：全量加载但不全量渲染，可见处原始拓扑、不可见处（视锥外/被遮挡）不参与渲染，
不能随机连顶点（聚类简化产生错面/缝隙）。`1.0.4.11` 的滞回优化只缓解跳变，几何本身仍有裂缝 → 废弃该路线。

- **废弃空间聚类简化**（`js/worker_io.js`）：`buildClusterLods` 只返回 L0（原始顶点/索引/分块），
  删除聚类/去重/代表点重建死代码与 `LOD_MIN_TRIS`/`LOD_RATIOS`。`?lod=1` 不再生效。
- **渲染改为全量+剔除**（`js/render.js`）：移除逐 tile LOD 选级/分桶绘制；
  视锥内 chunk 按到相机距离近→远排序后提交，让 GPU Early-Z 尽早淘汰被遮挡片元。
  分块 AABB 按真实顶点 min/max 修正。
- **默认配置**（`js/app.js`）：`MV.config.lod` 默认 false。
- **修复 file:// 下 线框/法向/边界 无反应**：原判定 `if (global.Worker)` 在 `file://` 下为真，
  但 `new Worker(...)` 跨域抛错 → 拓扑永远算不出来。改为统一按 `location.protocol` 判定：
  `js/render.js`（`ensureTopo`/`requestTopo`）、`js/app.js`（预处理/pickgrid）、`js/ui.js`（ICP）
  在 `file://` 下直接走同步/主线程兜底，辅助线恢复可用（大网格同步兜底会卡一帧，正式使用建议 serve.bat）。
- **GitHub Pages 跳过 `/locate`**（`js/app.js`）：静态托管无此端点，加 `\.github\.io$` 判断提前返回，
  消除必然 404 的控制台噪音，与 `optimize.js` 的 `IS_PAGES` 口径一致。
- `README.md` 新增「性能差异」小节，对照 Pages / serve.bat / file:// 在计算线程与网络开销上的区别；
  同步更新功能对照表中「拓扑分帧异步」「Pages 跳过 /locate」的现状（文档改动，资源未变，不升 `?v=`）。
- `index.html` 全部 `?v=` 同步 `1.0.5.0`。

---

## 1.0.4.12：全量几何 + 可见性剔除，彻底移除有损 LOD（2026-11-23，过程小节）

用户要求：全量加载但不全量渲染，可见处原始拓扑、不可见处（视锥外/被遮挡）不参与渲染，
不能随机连顶点（聚类简化产生错面/缝隙）。1.0.4.11 的滞回优化只缓解跳变，几何本身仍有裂缝 → 废弃该路线。

- **废弃空间聚类简化**（`js/worker_io.js`）：`buildClusterLods` 只返回 L0（原始顶点/索引/分块），
  删除聚类/去重/代表点重建死代码与 `LOD_MIN_TRIS`/`LOD_RATIOS`。`?lod=1` 不再生效。
- **渲染改为全量+剔除**（`js/render.js`）：移除逐 tile LOD 选级/分桶绘制；
  视锥内 chunk 按到相机距离近→远排序后提交，让 GPU Early-Z 尽早淘汰被遮挡片元。
  分块 AABB 保持上一版的真实顶点 min/max 修正。
- **默认配置**（`js/app.js`）：`MV.config.lod` 默认 false。
- 验证：CDP 截图确认 338.7 万面完整渲染、图层外观连续无缝隙/错面；
  视锥剔除 `64/128 chunks` 正常；`preLods=1`（无简化级）、`rawVerts=1705882`。
  `index.html` 全部 `?v=` 同步 `1.0.4.12`。

---

## 1.0.4.11：修复 LOD 切换跳变 + 分块 AABB 误剔除（2026-11-23）

问题：`0.1-未裁剪问题-cut_oh.obj`（338 万面）移动/缩放时面片闪烁。
CDP 实测定位（见 `scripts/_cdp_diag.py`）：LOD 开时缩放过程面数在 12.5 万~240 万间暴涨暴跌，
同一距离往返结果不一致（滞回状态依赖）；LOD 关后面数只随视锥平滑变化 → 主因是逐 tile LOD 硬切换。

- **LOD 切换稳定性**（`js/render.js`）：严格口径求理想级别，当前级在 1.4 倍容差内保持（非对称滞回）；
  每帧最多放行 6 个 tile 切换（`LOD_KEEP_SLACK` / `LOD_SWITCH_PER_FRAME`），面数阶梯式收敛而非整屏跳变。
- **分块 AABB**（`js/worker_io.js`）：Worker 分块旧版用格边界当 AABB，三角形按质心入格但顶点可越格，
  AABB 偏小导致视锥边缘 chunk 被误剔除成片消失；改为按真实顶点 min/max 扩充，空 chunk 保留格边界。
- 对照验证：`?lod=0` 关闭 LOD 面数平滑；`?cull=0` 关闭剔除 chunksDrawn 恒定。
  `index.html` 全部 `?v=` 同步 `1.0.4.11`。

---

## 1.0.4.10：合并 LOD 缓存模块 + file:// 日志提示（2026-11-23）

- `js/lod_cache.js`（96 行，IndexedDB LOD 缓存）内联合并到唯一使用方 `js/app.js`，删除独立文件：
  减少一个全局模块与一个 script 请求，`MV.lodCache` 对外 API 与行为不变。
  `index.html` 移除对应 script 标签，全部 `?v=` 同步 `1.0.4.10`。
- `file://` 打开时 Worker / fetch 静默降级，改为启动时往日志面板记一条 `warn`，
  提示「建议运行 serve.bat 启用全部功能」，避免被误判为配准卡顿；不弹横幅、不打断操作。

---

## 1.0.4.9：导入后自动选中首个新图层（2026-11-22）

原逻辑在 `selectedId === null` 时仍强制置空，需手动点一下网格才显示 vertices 子树。
改为：无选中项时 `selectLayer(firstLayer.id)`；已有选中项时保持不变，不打断当前编辑/对比。

---

## 1.0.4.8：修正 LOD 永不生效的误差口径（2026-11-22）

`1.0.4.7` 中逐 tile SSE 使用了
`err = lv.error + ch.diag * (1 - lv.ratio) * 0.25`。
`ch.diag` 是空间 tile 的边长量级（几十~几百 mm），叠加后误差过大，
任何视角下 `err * ppu > lodPx`，LOD1/LOD2 永远选不中，仍然画全量 621 万面。

修正：
- SSE 只使用 LOD 几何自身的 `geometricError`（聚类格步长的保守值 `step * 2`）；
- `chunk.diag` 仅用于视锥包围盒，不再参与误差。

验证：`_t/chunk_lod_regress.html` 18 项 PASS；lints 0 error。

---

## 1.0.4.7：真实几何 LOD + 逐 tile REPLACE + 缓存（2026-11-22）

参考 MeshLab Clustering Decimation / Blender Decimate / 3D Tiles / Nanite：
不再用「每块保留 1/4、1/16 索引」的假 LOD。

- **阶段 1**：`buildClusterLods()` 按 3D 网格把顶点聚类成代表点，重建并去重三角形，
  生成 ~15% / ~3% 顶点目标的真实低模；`buildSpaceChunks` 不再生成抽样索引。
- **阶段 2**：LOD0/1/2 共用同一 bbox 与 \(N^3\) 网格，chunk 下标即 tile id；
  绘制时**逐 tile**按 `geometricError + tile.diag` 计算 SSE 选择级别（REPLACE），
  远处 tile 可以用粗级、近处 tile 保留全量。
- **阶段 3**：新增 `js/lod_cache.js`（IndexedDB），同一文件第二次打开直接复用 LOD；
  `?lodcache=0` 可禁用。

配置：`?lod=0` 关 LOD，`?lodpx=N` 改 CSS 像素误差阈值（默认 16）。

验证：`_t/chunk_lod_regress.html` 18 项 PASS（200 万面合成：LOD1 降到 ~10 万面，
三级 tile 数组对齐、覆盖完整）；`topo_regress` / `import_regress` PASS；lints 0 error。

---

## 1.0.4.6：首帧继续卡顿的收尾优化（2026-11-22）

`1.0.4.5` 后仍只有几帧，定位到四点：

1. `lodPx` 用设备像素比较，DPI=2 时阈值等效减半；改为 **CSS 像素口径**（默认 16，渲染时乘 dpr）。
2. 621 万面按 `N=8` 切成 512 块，双视图下 draw call 太重；改为 **>200 万面用 4³=64 块**，50~200 万面 5³=125 块。
3. 导入时仍无条件 `computeTopo`（142 MiB faces + 71~142 MiB edges）；改为**按需异步生成**：
   首次勾选线框/边界/法向才发 `cmd:'topo'` 到 Worker，算完 `invalidate` 重绘；`file://` 保留同步兜底。
4. 导入后仍无条件 `schedulePickGrid`（复制 100+ MiB + 扫全量面）；200 万面以上默认跳过，
   `?pickgrid=1` 可强制预建。

状态栏新增 `chunksDrawn/chunksTotal` 与 `L0/L1/L2` chunk 数，便于确认 LOD 是否生效。

验证：`_t/chunk_lod_regress.html`、`_t/topo_regress.html`、`_t/import_regress.html` 全 PASS；lints 0 error。

---

## 1.0.4.5：超大网格分块剔除与 LOD（2026-11-22）

针对 `0.4-mesh_src-1.off`（250.78 MB，314 万顶点 / 621 万面）导入后卡顿。

**参考权威实现**（非凭猜测）：
- three.js `WebGLRenderer` + `Frustum.intersectsBox()`：每个对象用包围体做保守视锥剔除；
- three.js `LOD.update(camera)`：按相机距离切换层级，并用 `hysteresis` 避免阈值附近闪烁；
- Cesium 3D Tiles：`boundingVolume` 先剔除，再用 `geometricError` 投影成屏幕空间误差（SSE）决定细化层级。

**P0 分块剔除**：
- `buildSpaceChunks` 移到双环境共享作用域，改为两趟线性扫描 + `Uint32Array` 计数排序；
  不再用 `grid[key].push(t)`（621 万面时是分钟级来源），chunk bbox 用格子保守 AABB。
- 删除 `tri <= 2000000` 才分块的限制；所有网格都分块，超大 OFF 也能逐块视锥剔除。

**P2 LOD**：
- 分块时同步生成两级索引：每块 1/4、1/16 三角形（`?lod=0` 关闭）。
- 渲染时按 3D Tiles SSE 选级：`err = chunk.diag × {0.06, 0.18}`，
  `SSE = err × view.h / (2 × 距离 × tan(fov/2))`，阈值 `?lodpx=N`（默认 12px）；
  沿用 three.js `hysteresis=0.1` 防闪烁。
- 每级独立 VAO/EBO，按级分桶绘制，避免逐 chunk 切换 VAO；统计改为实际绘制三角形数。

**验证**：`_t/chunk_lod_regress.html`（小网格 + 200 万面合成用例）13 项全 PASS；
原 `_t/topo_regress.html` / `_t/import_regress.html` 回归全 PASS。

---

## 1.0.4.4：统一三维导入的「顶点表 + 面索引」口径（2026-11-22）

**根因**：`1.0.4.3` 让 OBJ/PLY/OFF/glTF 解析器保留「顶点表 + 面索引」，
但 `computeTopo()` / `computeVertexNormals()` / 拾取 / 顶点云拷贝仍按
triangle soup（`o=i*9`、`v=i*3`）读取，并把 soup 槽位写进线框/边界 EBO；
GPU 顶点缓冲却已是焊接后的紧凑顶点表。索引空间不一致 ⇒ 边框、法向、边界全错。

**参考约定**（未凭猜测）：
- CloudCompare `ObjFilter::loadFile`：`addTriangle(A->vIndex, B->vIndex, C->vIndex)`，
  面存顶点索引；`STLFilter` 导入后按近重合容差焊接，并重映射三角形索引、丢弃退化面。
- three.js `BufferGeometry.computeVertexNormals()`：索引几何用 `index.getX(i)`
  从 `position` 属性取三点，面法线累加到共享顶点后归一化；非索引几何才逐 9 float 取面。
- Open3D `TriangleMesh`：官方定义即「vertices + triangles represented by the indices to the vertices」。

**改动**：
- `worker_io.js`：拓扑上移为双环境共享的 `MV.topology.computeTopo(verts, triIdx, tri)`；
  按面索引取顶点，EBO 写顶点表下标；退化面跳过；大 id 字符串键兜底。
- `render.js`：`ensureTopo()` 与同步上传路径都使用 `preVerts/preIdx` / `uniqVerts/remap`；
  焊接按量化键（`Q=1e4`）判重，与 Worker 一致。
- `algo.js` / `worker_icp.js` / `ui.js`：顶点法向改为 three.js 同口径；
  `pos` 恒为顶点表、`remap` 恒为面索引；拾取、拆分、撤销同步改用面索引。
- `app.js`：索引格式小网格不再被误判为 soup；顶点云拷贝遍历规范顶点表。
- `parseOBJ` 返回 `verts.result()`（按实际 `vcount` 压实），不再把 `F32Accum` 预分配的
  `1<<20` 个 float 全当顶点；实测 OBJ 四顶点表从 349525 顶点回落到 4。
- 索引越界自检由 `> maxId` 修正为 `>= maxId + 1`。

**验证**：`_t/topo_regress.html`（本地无头 Chrome）覆盖
顶点表+面索引、STL 焊接、退化面、顶点法向索引/非索引两条路径。

---

## 里程碑

| 日期 | 里程碑 |
| --- | --- |
| 10-21 | WebGL2 查看器从零建立：双视口对比 / 场景树 / 属性面板 / 点云标量场 |
| 10-22 | 接入孔位优化桥接（浏览器 → CLI）；绝对路径反查 |
| 10-23 | 无极旋转；边界高亮与闭环修复；移除图层；中文全链路 UTF-8 |
| 10-26 | 拾取与测量；三维编辑（矩形/多边形框选 + 裁剪） |
| 10-27 | 配色浮层；取消载入上限；内存预估与下采样；视角器演化 |
| 10-28 | 视角器定稿（26 面 / 三类面 / Newell 法向） |
| 10-29 ~ 11-10 | 自动粗配准三次重写（简化 4PCS → 加索引 → 官方 Super4PCS）；N-N 配准与 ICP 初值链路 |
| 11-11 | 配准体系收口：评分判据改 RMS、N-N 选点重做、数据对齐面板与主题细节 |
| 11-13 | 配准与对齐修复：法向随旋转、远点剔除、预览 GPU 化、图层重命名；**粗配准重做**（6 处缺陷 + 主轴多假设，合成用例全命中真值） |

---

## 2026-10-21（周三）｜项目起点

**v2026102x（初始版本）** — *基线，由现存代码反推*

文件在 14:27–14:32 创建：`index.html`、`css/style.css`、`js/math3d.js`、`js/loaders.js`、`js/renderer.js`、`js/ui.js`、`js/app.js`、`README.md`、`serve.bat`。

- **渲染**：WebGL2；非索引三角面（9 float/三角形），片元着色器用 `dFdx/dFdy` 求导算面法向（省法向存储）。
- **双视口**：左侧 (A) / 右侧 (B) 并排对比，支持单窗口切换、视图标签、分割线拖动。
- **相机**：轨道相机、滚轮缩放、右键平移、视角立方体（六面体）、地面网格、坐标轴、视图自适应。
- **场景树**：`左侧(A)` / `右侧(B)` / `公共图层(S)` 三根，勾选控制显示，双击聚焦到图层包围盒。
- **图层属性**：颜色 / 背面颜色 / 线框颜色 / 顶点颜色 / 不透明度 / 着色模式（光照·纯色·法向）/ 面片·线框·顶点·面法向开关。
- **载入器**：STL(binary/ascii)、OBJ、PLY(ascii/binary)、文本点云（`.xyz/.txt/.csv/.asc/.pts/.dat`），分块异步读取 + 进度条 + 拖放载入；点云列含义自动识别（坐标/法向/颜色/标签/标量）。
- **点云标量场**：GPU 内着色、右下角色条 + 直方图、色带切换、范围可手填。
- **其它**：截图导出 PNG；「清空」全部图层（带二次确认）。

## 2026-10-22（周四）｜孔位优化接入 + 路径反查

**17:59–19:20：孔位优化桥接**

- 新增 `bridge/optimize_server.py`（独立桥接，127.0.0.1:8790）、`bridge/start_bridge.bat`、`bridge/test_bridge.py`、`js/optimize.js`。
- 新增 `serve.py`：把页面与 `POST /optimize` 合成**同源**服务（127.0.0.1:8765），页面能打开即优化可用。
- 前端「孔位优化」按钮：上传网格 → 服务端落盘 + 生成 `run.cfg` → 调 `HoleOptimize_cli.exe` → 结果 OBJ 自动载入右侧；失败弹窗显示服务端堆栈 + 日志路径。

**v20261022k / l**

- 场景树**悬停提示**：名称、类型、面数/点数、文件名、大小、修改时间、**磁盘路径**、归属与显示状态。
- 图层属性新增「**路径**」行（文本可选中复制）。
- 新增 `GET /locate?name=&size=`：服务端按「文件名 + 字节数」在数据目录反查**绝对路径**（浏览器不向网页暴露本地路径的补偿方案）。

## 2026-10-23（周五）｜旋转 / 边界 / 删除 / 中文全链路

**v20261023a** — 路径反查增强

- `HOLEOPT_SEARCH` 环境变量支持多个额外搜索根（`;` 分隔）。
- 匹配放宽为三级：① 文件名 + 大小精确 → ② 同名全局唯一 → ③ 同名多份且大小不符则返回空（宁缺勿错）。

**v20261023b** — 无极旋转 + 重设旋转中心

- 相机朝向由 `yaw/pitch` 欧拉角改为**四元数累积**（绕相机本地 `right`/`up` 旋转），去掉 ±89° 俯仰死锁，可连续翻到任意姿态。
- `yaw/pitch` 保留为**派生属性**（getter/setter），URL 参数、视角器、状态栏仍按欧拉角工作。
- 新增「旋转中心：**重设** / **回正** / **默认视角**」三个按钮；`Ctrl + 左键单击` 亦可设旋转中心；拾取失败给出提示；`Esc` 取消拾取模式。

**v20261023c ~ e** — 边界显示（独立开关）

- 新增「边界」复选框（与面片/线框/顶点同级）+ 独立「边界颜色」（默认 `#22d3ee`）。
- 算法：顶点按包围盒尺度量化去重 → 以 `a*LIM+b` 统计每条边被几个三角形使用 → **只出现 1 次**即开放边界；结果缓存在 `layer.gpu`。
- 「统计」行追加 `· 边界 N 边`（0 边 = 封闭模型）。

**v20261023f ~ t** — 边界闭环问题修复（多轮排查）

排查路径（每步都有对照截图）：增大 `uDepthBias` → 调 `polygonOffset` → `depthFunc(LEQUAL)` → 关闭深度测试 → 改 `drawElements` 索引绘制（`calls` 证明已调用但画面无像素）→ 最终定位。

- **根因**：边界线原先写在 `drawMeshLayer()` 里、紧跟面片双遍绘制之后，GL 状态残留导致整段被丢弃。
- **修复**：边界改为**每个视图在所有图层画完之后单独一遍**绘制，并关闭深度测试（任何视角可见），`stats.boundaryCalls` 可观测。
- **附带修复**：边键 `a*2^22+b` 在 180 万面级（顶点序号 > 4.19M）**整数溢出串键** → 改 `2^26`；退化三角形（含重复顶点）跳过。

**v20261023u** — 移除图层

- 三个入口：图层行尾 `×`、属性面板红色「移除该图层」按钮、`Delete` 键（输入框内不触发）。
- `removeLayer` 加固：`releaseLayer` 按引用计数释放显存；清理 `propsByKey`（避免再载入同文件沿用旧配色）；选中落到相邻图层；状态栏提示。

**中文全链路 UTF-8**

| 环节 | 处理 |
| --- | --- |
| 控制台 | `serve.bat` / `start_bridge.bat` 先 `chcp 65001`；`sys.stdout/stderr.reconfigure(encoding='utf-8')` |
| CLI 子进程输出 | 按 **UTF-8 → GBK → mbcs** 依次尝试解码 |
| 落盘文件名 | 保留原始中文（仅替换 `\ / : * ? " < > \|`）；万一运行失败且名含非 ASCII，自动用 ASCII 名重试并在日志写明 |
| HTTP 访问日志 | 覆盖 `log_message`，先 `unquote` 再记录（日志里是中文而非 `%E5%AD%94…`） |
| 结果回传 | 响应头 `X-Result-Name` URL 编码，前端 `decodeURIComponent` 还原 |

**启动脚本** — Python 探测链

- 顺序：`py -3` → PATH 中的 `python`（跳过 Microsoft Store 占位符）→ 常见安装目录（miniforge / anaconda / **anoconda**，含 `envs\*` 子环境）→ 全失败则提示并退出。

## 2026-10-24（周六）、2026-10-25（周日）

**无代码改动**（文件时间戳无记录）。

## 2026-10-26（周一）｜拾取测量 + 三维编辑

**v20261026a ~ d** — 拾取与测量

- 顶栏「拾取」按钮 / `P` 键切换拾取模式（光标变十字，按钮高亮）。
- 单击取点（最多 3 个，超出丢弃最早），右上角面板显示：坐标、法向、标签、标量。
  - mesh：射线与三角形交点（Möller–Trumbore）+ 面法向；
  - 点云：命中点坐标 + 文件自带法向 + `tags` + 各标量场取值。
- 自动计算：2 点 → 距离 + `Δx/Δy/Δz`；3 点 → 追加 `∠P1P2P3`（顶点 P2）+ 两边长。
- 3D 十字标记（黄/绿/蓝 = P1/P2/P3），关闭深度测试。
- 射线改用 `cam.basis()`（支持自由旋转后的滚转），修正旧代码用世界 Z 求 right/up 的偏差。

**v20261026e ~ g** — 标记尺寸

- 十字单臂从「包围盒半径 × 2%」改为**恒定 1 mm**；不足 6 px 时按 6 px 绘制（远处可见），放大后即真实 1 mm。
- 新增 `?mark=`（单臂长度）、`?zoom=`（载入后相机距离 × 系数）。

**v20261026h ~ l** — 三维编辑（框选 / 多边形 / 裁剪）

- 新增 `js/segment.js`：矩形 / 多边形选择，屏幕多边形**反投影为过视点的棱柱平面**。
- 网格：逐三角形半空间裁剪，`segmented` 精确切口、`remaining` 差集（不重叠不裂缝）；点云：按棱柱半空间分类（保留法向/标签/标量并重算 min/max）。
- 预览：网格半透明青色高亮；点云用状态栏数字（避免 `pointP` 属性状态冲突）。
- 「应用拆分」生成 `<名称>_segmented` / `<名称>_remaining`，原图层自动隐藏。

**v20261026m** — 层级与交互

- 拆分结果（及孔位优化结果）**缩进挂在源图层下一级**，删除源图层会级联删除子层。
- 「工具 ▾」下拉：**拾取与裁剪同级**（不再平铺在主栏）；点菜单项自动收起，`Esc` 关闭。
- 拖放改**全窗口识别**（画布/标签栏/树/属性面板皆可落点），按落点左右半屏决定 A/B，拖动时半屏高亮提示。

## 2026-10-27（周二）｜配色 / 去上限 / 内存预检 / 视角器

**v20261027a ~ b** — 配色浮层

- 「外观」组压缩为两行（`配色…` 按钮 + 不透明度），5 个色块收进小浮层。
- 浮层用 `pointerdown` 阻止冒泡：**点色块不关闭**（可连续调色），点浮层外或 `Esc` 才关；按钮左侧圆点实时显示主色。

**v20261027c ~ d** — 取消载入上限

- `DEFAULT_MAX_TRIANGLES` / `DEFAULT_MAX_POINTS` → `Infinity`（默认全量载入）。
- 法向（`ensureNormals`）与顶点（`ensureVerts`）也不再抽稀。
- 保留应急参数：`?maxtri=` / `?maxpts=`（仅显式指定时生效）。

**v20261027e ~ g** — 内存预估与下采样

- 新增 `js/memguard.js`：载入前估算规模（binary STL 读头部得精确三角数，其余按字节启发式）。
- 预算：优先 `performance.memory.jsHeapSizeLimit × 25%`，否则 `navigator.deviceMemory × 12%`，夹在 512 MB ~ 2.5 GB；`?memlimit=<MB>` 可覆盖。
- 超预算弹窗：显示规模/预计占用/预算，滑杆 5%~100% 实时估算，三选项（取消 / 仍然全量 / 下采样导入）。
- 点云抽样由「取前 N 个」改为**按行号等间隔抽样**（空间均匀，法向/标签/标量同步取舍）。

**v20261027h ~ j** — 面板重排

- 图层属性分四组（属性 / 外观 / 显示 / 着色 / 标量场），统一 `66px 1fr auto` 网格对齐，组内无可见行时整组隐藏。
- 视图设置分三组（相机 / 显示 / 光照），滑块右侧显示实时数值（`45°` / `36°`）。
- 侧栏三段独立滚动（树 24% / 属性 flex / 视图 40%），滚动条改深色细条。

**v20261027k ~ l** — 双击设旋转中心

- 双击模型表面 → 在该处重设旋转中心（视角不变），双击空白仍为视图自适应；拾取模式下双击只取点。

**v20261027m ~ q** — 视角器演化

- 六面体 → 二十面体（20 面）→ 24 面（tetrakis hexahedron）→ 削角六面体（26 面）。
- 加 **X（红）/ Y（绿）/ Z（蓝）方向箭头**，正对观察者时缩为圆点；面悬停高亮、点击切视角。

## 2026-10-28（周三）｜视角器定稿

**v20261028a** — 只削角

- 去掉棱切（棱切会把角面削成六边形），角面恢复**正三角**；棱向视角改 12 个**棱中点圆点热区**（圆点优先命中）。

**v20261028b ~ d** — 精确参数与面数修复

- 令三类面同时成立：轴面 `= 2A × 2A` **正方形**、棱面 `2A × A√2` **矩形**、角面边长 `A√2` **正三角形**。
- 对应深度：`d棱 = (A+1)/√2`、`d角 = (A+2)/√3`（三个平面精确交于 `(A,1,1)` 类顶点）。
- 修复 `cutOnce`：顶点恰好落在切平面上时新面轮廓漏收该点 → 面数 24、出现 5 边形；改为把 `|dot−d| ≤ 1e-9` 的顶点也计入轮廓后为 **26 面**。

**v20261028e** — 面颜色统一

- 去掉方向光（背光面直接到最暗档 → 棱面全黑），改为**朝向亮度** `0.74 + 0.26 × 朝向`，任何面都不会黑。

**v20261028f** — 棱面黑 / 不可选修复

- 根因：棱面顶点表含共线冗余点，绕序判断用「前三点叉积」→ 结果为零 → 棱面法向朝内 → 正对相机的棱面被背向剔除（不可选），画出的是背面那侧（显黑）。
- 修复：新增 `polyNormal()`（**Newell 法**，对含共线点的面稳定）+ `pruneCollinear()`（去共线中间点）；绕序判断与绘制法向都改用 Newell。
- 参数 `A`：`2 → 1.8`，轴面占比稍大。


**v20261028g ~ h** — 结构重构（B + C）

- **B｜服务端收口**：`bridge/` + 根目录 `serve.py` 合并为 `server/`
  - `server/serve.py`（静态 + 内嵌 `/optimize`）、`server/bridge.py`（原 `optimize_server.py`）、`server/start_bridge.bat`、`server/test_bridge.py`
  - `serve.bat` 改指向 `server\serve.py`；`serve.py` 的 `ROOT` 上移一级、`sys.path` 改为同目录 `import bridge`
  - 日志落在 `server/bridge.log`（`.gitignore` 同步）；端点与前端全部不变（同源相对路径）
  - 验证：`/health` 200、`/optimize` 端到端 1.8 s 成功、中文日志正常
- **C｜`app.js` 拆分**（2,056 → 1,298 行，低于 1,500 阈值）
  - `js/pick.js`（259 行）：射线求交、取点、距离/角度、旋转中心拾取
  - `js/gizmo.js`（435 行）：26 面视角器几何 + 绘制 + 命中
  - `js/dnd.js`（107 行）：全局拖放与半屏判定
  - 拆法：按顶层声明切块，新文件用 `global.MV.App.prototype` 扩展；`index.html` 中紧跟 `app.js` 之后加载
  - 修掉一个拆分副作用：`init()` 里仍直接引用已移走的 `HEX_GEO` → 改为经 `MV.gizmoGeo` 读取（否则初始化中断、模型不载入）
  - 验证：模型载入 72.7k 面、视角器正常、`?demo=pick` 三点距离/角度正确、`err=0`


**v20261028i ~ j** — 按 C++ 骨架重组为 6 个文件

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `js/core.js` | 662 | L1 基础：数学 / 相机 |
| `js/io.js` | 2692 | L2 IO：解析 + 优化调用 + 规模估算（内部三段各自作用域） |
| `js/algo.js` | 4177 | L3 算法：三维裁剪 + 拾取测量 |
| `js/render.js` | 2755 | L4 渲染：GL 管线 + 视角器 |
| `js/ui.js` | 6706 | L5 界面：面板 / 树 / 弹窗 / 拖放 |
| `js/app.js` | 2503 | L6 编排：状态 / 图层 / 输入 / 循环 |

- 12 个文件 → **6 个**（按技术层而非技术动作），最大 1,877 行；`index.html` 的 `<script>` 10 条 → 6 条
- 下层模块中依赖 `App.prototype` 的部分（拾取 / 视角器 / 拖放）改为 `installAppMethods()`，由 `app.js` 在 `MV.App` 赋值后统一安装 —— 解决“下层不能反过来依赖上层的类”这一循环
- `io.js` 内三段（loaders / optimize / memguard）各自包一层 IIFE：三者原本是独立文件，私有函数有重名（`extOf` 等），平铺会静默互相覆盖
- 合并后补回被过滤掉的 `global.MV = global.MV || {}`（缺它会让首个写 `MV.xxx` 的文件抛 `Cannot set properties of undefined`），曾导致白屏一次
- 验证：模型载入 72.7k 面、双视图 ghost、视角器、`?demo=pick` 三点距离/角度全部正常，`err=0`
**工程侧** — 版本管理

- 父仓库 `OptimizeHole2D/.gitignore` 增加 `3DViewer/`（父仓库从未跟踪该目录，直接生效，无需 `git rm --cached`），为 `3DViewer` 建立**独立仓库**做准备。


**v20261028k ~ m** — 剥离下层对 UI 的直接依赖

- `algo.js` / `io.js` 不再出现 `global.MV.ui.*`（原 algo 11 处、io 1 处）：改为 `hooks.notify / refreshTree / refreshProps / renderPickBar`，由 `app.js` 启动时注入（`MV.algo.bindHooks` / `MV.ioBindHooks`）
- 下采样弹窗从 io（12 处 `document.*`）**移到 ui**：`MV.ui.askDownsample(file, est, limit)`；io 只留纯计算 `estimate / budget / decide`
- 新增 `App.prototype.guardFile()` 作为编排：估算 → 超预算弹窗 → 决策，链条集中在 app 层
- 两个踩坑：① 用旧索引截断 `io.js` 误删中间内容（`MV.loaders` 变 undefined → 载入失败），修正为一次拼接；② `self.guardFile` —— 浏览器里 `self === window`，应为 `this.guardFile`
- 验证：模型载入正常、`?memlimit=2` 弹窗正确（4.24 MB vs 2.00 MB，建议 45%）、`err=0`


**v20261028n ~ p** — 代码整理（review 后的第 1 + 3 批）

- **版本号统一**：`css` / 副标题 / 6 个 `js` 的 `?v=` 此前分别是 `20261028h` / `i` / `j`，现统一为 `20261028p`（缓存与显示一致）
- **删除死导出** `MV.segment`（`setMode / cancel / apply / previewing`，全项目 0 引用，裁剪入口全走按钮事件 + App 方法）
- **合并重复的 `extOf()`**：`io.js` 的 loaders 段与 memguard 段各有一份实现，现提到外层共享（保留 `(name || '')` 的空值保护）
- **`render.js` 去掉对 `MV.ui` 的直接调用**：新增 `renderHooks { notify, refreshProps }`，由 `app.js` 注入；边界统计后的面板刷新、视角器点击的状态栏提示都改走 hooks（至此 core/io/algo/render 四个下层文件对 `MV.ui` 的引用全部为 0）
- **URL 参数集中到 `MV.config`**：此前 4 个文件各自 `new URLSearchParams`（共 8 处），现由 `app.init()` 统一解析成 `MV.config`（`demo / segapply / runOptimize / memlimit / memauto / mempct / menu / colors / noconfirm / debug`），`algo / io / ui` 只读配置
- **清理**：`installDndMethods` 内重复的 `var App = ...` 删除

**未完成（已回退）**：第 2 批「`ui.js init()` 拆成 6 个 `bindXxx()`」——拆分后运行时 `MV.ui` 未被赋值（`Cannot read properties of undefined (reading 'setInfo')`），已从备份回退到拆分前状态。该项建议单独排期，需逐段搬移并即时回归。


**v20261028q ~ s** — 三项优化 + 首次提交

1. **正/背面合并为一次绘制**（`render.js`）
   - 新增 `uBackColor / uBackShade / uTwoSided`，着色器按 `gl_FrontFacing` 选色
   - **不透明图层**（`alpha >= 0.999`）走单遍：不再「剔除背面画一遍 + 剔除正面再画一遍」，绘制量减半
   - **半透明图层**保留两遍（保证混合顺序），行为不变
   - 踩坑：`drawMesh` 的形参名实际是 `(layer, mvp, view, color, shade, pushBack, noStat)`，第一次按 `col/viewM` 匹配导致签名没改、函数体却引用了 `backCol` → `ReferenceError`
2. **WebGL 上下文丢失/恢复**（`render.js` + `app.js`）
   - `webglcontextlost`：`preventDefault()` + 状态栏提示（否则浏览器不会触发 `restored`）
   - `webglcontextrestored`：重入 `renderer.init()` 重建 program/uniform/attribute，清空各层 `gpu`，下一帧自动重新上传
   - 解决「显存被系统回收后画布永久黑屏、只能刷新」
3. **首次提交**：`a238e85`（16 files / 12,459 insertions），`.gitignore` 已排除 `_t/`、`__pycache__/`、`*.log`、`.codebuddy/`


**v20261028w ~ x** — 收尾三项（线框去重 / 上传失败检测 / 冒烟测试）

- **线框共享边去重**（`render.js` `ensureWire`）：原按「每面 3 条边」生成 `tri*6` 个索引，相邻面共享的边被画两遍；改为按 `min*LIM+max` 边键去重，`wireCount` 记实际索引数（封闭模型约降 50%），顺带跳过退化三角形
- **上传失败检测**（`render.js` `uploadLayer`）：`bufferData` 后检查 `gl.getError()`，非 0 时释放资源、标记 `_uploadFailed`、经 `renderHooks.notify` 提示「多为显存不足，可用 ?maxtri= 限制」——把「显示已载入但画面空白」变成可排查的明确提示
- **冒烟测试** `check.ps1`：6 个用例（base / single / pick / segment / boundary / mempopup）自动起服务、断言 `err=0` 与关键 DOM、留存截图，输出 PASS/FAIL 表
  - 踩坑：`.ps1` 用 UTF-8 写中文，Windows PowerShell 按 ANSI 解码 → 引号被破坏、语法报错；改为**纯 ASCII**
  - 断言踩坑：最初拿 `renderPickBar` / `boundaryVao`（js 函数名）去 DOM 里找 → 必然失败；改为找 DOM 里真实存在的 `pick-list` / `p-boundary`


**1.0.0.1** — 分块绘制 + 视锥剔除（阶段 A）

- `uploadLayer`：网格按三角形顺序切块（自适应约 32 块，最小 2048 三角形/块），每块记 AABB；索引连续 → **共用同一个 IBO**，绘制时只换 `byteOffset`
- `drawMesh`：逐块做 AABB vs 视锥（6 平面）测试，命中才 `drawElements`；状态栏新增 `blocks=命中/总数`，`?cull=0` 可关闭对比
- **踩坑（重要）**：第一版用非索引顶点序号 `vt*3` 去访问**去重后**的 `ix.verts` → 越界，AABB 变成 NaN/Infinity → 全景下 24 块只剩 5 块被画，画面缺失。修正为 `ix.idx[vt] * 3` 后恢复 `24/24`
- 实测：全景 `24/24`（不误杀）、拉近 6.7× `16/24`（剔除 33%）
- **已知局限**：按三角形「顺序」切块，块内三角形空间分散、AABB 偏大 → 剔除率有限。改成**空间分块**（按质心分配到 8×8×8，重排索引后仍连续）可把剔除率提到 80%+，列为下一步


**1.0.0.3** — 拆出 gizmo.js（render.js 2114 → 1683 行）

- 视角器（削角六面体 26 面几何 + 绘制 + 命中 + XYZ 箭头，482 行）从 `render.js` 移到 `js/gizmo.js`
- 新增 `gizmoHooks.notify`（由 `app.js` 注入 `MV.ui.setInfo`），不再借用 render 的 hooks
- `MV.gizmoGeo` → `MV.gizmo.geo`；`MV.render.installAppMethods` → `MV.gizmo.installAppMethods`
- `index.html` 加载顺序：`core → io → algo → render → gizmo → ui → app`
- 验证：`check.ps1` 7 项全 PASS（含 `cull-parity`），截图确认视角器与 XYZ 箭头正常


**1.0.0.4** — 修复网格面片破碎（导入 OBJ/STL 均受影响）

**现象**：导入 OBJ 的 mesh 后面片呈暗红碎块、几何被拉成细长条；STL 同样受影响。状态栏 `err=0`、三角形数与文件一致（OBJ 398.8k / STL 72.7k），`blocks` 统计也正常 —— 属于"数量和错误码都对、只有画面碎"的静默错误。

**根因**：`render.js` 的 `buildSpaceChunks()` 里索引步长用错。`ix.idx` 是**索引数组**（每个三角形 3 个元素），而代码沿用了 `positions` 的 **9 float/三角形** 步长：

```js
// 错的
var o = t * 9;
var a0 = ix.idx[o] * 3, a1 = ix.idx[o + 3] * 3, a2 = ix.idx[o + 6] * 3;
var id = ix.idx[list[q] * 9 + k];
```

`t*9` 远超 `ix.idx.length`（= `tri*3`）→ 取到 `undefined` → 写进 `Uint32Array` 变成 **0** → 大量三角形塌陷到顶点 0，形成放射状碎片与拉伸。

**修复**：索引一律用 `t*3 + k`；同时在 `uploadLayer` 上传前加**索引值域自检**（任何 `idx >= vcount` 立即报错并跳过该图层），避免同类错误再次静默发生。

**为什么之前没被发现**：
- `check.ps1` 的 `cull-parity` 比较「开剔除 vs 关剔除」，两次都走同一份坏索引 → 两张图一致 → 误判 PASS；
- 其余用例只断言 `err=0` 与 DOM，不检查画面；
- 我此前只截了左下角视角器的特写，没看整幅模型。

**验证**：同一 OBJ（398,789 三角形）修复后画面完整；STL 正常；`check.ps1` 7 项全 PASS，索引自检无告警。


**1.0.0.5 ~ 1.0.0.6** — 索引自检可视化 + 载入可中断

- **1.0.0.5｜索引自检暴露到状态栏**：`uploadLayer` 的越界自检结果写入 `renderer.idxOk`，`?debug=1` 状态栏显示 `idx=ok` / `idx=BAD`；`check.ps1` 的 `base` / `single` 用例新增断言 `idx=ok`
  - 目的：补上 `cull-parity` 抓不到的盲区（开/关剔除都用同一份坏索引时，两张图一致会误判 PASS）
- **1.0.0.6｜载入可中断**：新增 `App.prototype.cancelLoad()`；`loadOne` 的分块进度回调里检查 `_abortLoad` 并抛 `__abort__`，`addFiles` 捕获后跳出循环并提示"已取消载入"；**载入中按 `Esc`** 触发取消（优先于其它 Escape 语义）
  - 未改解析器：仍是一次性解析，但在分块回调处可中止，大文件卡住时可以中途退出
- 验证：`check.ps1` 7 项全 PASS

**未完成（两次尝试后回退）**：批次 3b「`ui.js init()` 拆 6 个 `bindXxx()`」—— 切分后 `MV.ui` 未被赋值（`Cannot read properties of undefined (reading 'setInfo')`），已从备份回退。两次失败说明一次性切 6 段的做法不可靠，应改为「一次只搬 1 个函数 → 跑一次 `check.ps1` → 再搬下一个」。

**未完成**：批次 2b「STL 单路径流式上传」—— 需把 `loadFile` 改为 onChunk 回调、`loadOne` 边收边建层、`uploadLayer` 支持增量，属架构级改造，未在本轮实施。


**1.0.0.7** — 点云 6 列及以上：按法向特征默认识别

- 列含义弹窗的默认值新增**数值判断**：`w >= 6` 且第 4~6 列构成单位向量（`|len - 1| <= 0.03`）时，默认选中 **法向 X/Y/Z**
  - 之前只看列名（`r/g/b`）或 `w > 6` 才给法向，恰好 6 列且列名不规范（如 `a b c d e f`）时会被当成 3 个标量场
- 顺序：列名 RGB → **数值单位向量** → `w > 6` 兜底给法向；其余保持标量场
- **仅影响默认值**：弹窗里每列仍是下拉（坐标 X/Y/Z、法向 X/Y/Z、颜色 R/G/B、标签、标量场），可任意改
- 验证：`a b c d e|0 0 1` → 默认法向 X/Y/Z ✓；`a b c d e f|10 20 30`（非单位向量）→ 默认标量场 ✓；`check.ps1` 7 项全 PASS

> **决策（2026-10-28）：不启用流式上传**。原因：当前绘制依赖索引化（全量顶点去重 + 空间分块重排索引），而流式要求边解析边上传、此时数据不全无法去重/重排。三个备选——A 流式期非索引+收齐后重建（上传两遍）、B 放弃索引化换流式（显存翻倍）、C 只细化进度（无收益）——都不划算。**保持「一次性解析 + 一次性索引化上传」**，大文件的首屏等待靠进度条与 `Esc` 取消来缓解（1.0.0.6 已支持）。


**1.0.0.8** — console 错误抓取 + 孔位优化插件化

**A｜`check.ps1` 能抓页面 console 错误**
- dump 参数加 `--enable-logging=stderr --v=0`，读每个用例的 `.log`，命中 `Uncaught|ReferenceError|SyntaxError|TypeError` 即判 FAIL 并打印片段
- **有效性验证**：临时在 `io.js` 注入 `__boom_for_test.bar = 1` → 6 个用例立刻 FAIL 并输出 `console:...Uncaught ReferenceError...`，恢复后 7 项全 PASS
- 意义：以前只能靠状态栏 `err=0`，**加载期异常完全抓不到**（这也是 1.0.0.3 / 视角器合并两次失败的根因无法定位的原因）

**B｜孔位优化改为插件**
- 从 `io.js` 抽出 optimize 整段 → `js/plugins/optimize.js`（300 行），`io.js` **1680 → 1386 行**
- 新增 `js/plugins/registry.js`（48 行）：`MV.plugins.register / initAll / list`
- UI 标记：插件加载时给「孔位优化」按钮加 `is-plugin` class（CSS `::after` 显示小字「插件」并补 title），注释掉插件 script 时标记一起消失
- 关闭方式：注释掉 `index.html` 里 `plugins/optimize.js` 那一行

**三个坑（都导致"文件不执行"或"按钮失效"，但页面 `err=0`）**：
1. 把整段包进 `init(app)` → 段内 `window.addEventListener('load')` 在 load 之后注册，永不触发；
2. 抽取时多带原 IIFE 的开括号 `{` → `depth=1` 语法错误；
3. 段尾残留 `global.MV.ioBindHooks = bindHooks;`（`bindHooks` 是 io 层私有）→ `ReferenceError` 打断后续 `register`。

**验证**：`check.ps1` 7 项全 PASS 且 console 无告警。


**1.0.0.8（续）** — 顶栏收敛为 6 个入口

顶栏从「载入 左侧 / 载入 右侧 / 载入 两侧 / 单窗口 / 自适应 / 截图 / 清空 / 孔位优化 / 工具」9 个按钮，收敛为 6 个：

| 入口 | 形式 | 内容 |
|---|---|---|
| **载入 ▾** | 下拉 | 左侧 (A) / 右侧 (B) / 公共（两侧） |
| **单窗口 / 双窗口** | 按钮 | 文案反映「点击后会变成什么」：双窗时显示「单窗口」，单窗时显示「双窗口」 |
| **截图** | 按钮 | 不变 |
| **清空** | 按钮 | 不变 |
| **插件 ▾** | 下拉 | 孔位优化（由 `js/plugins/optimize.js` 注册并绑定，注释掉插件 script 即整项消失） |
| **工具 ▾** | 下拉 | 拾取 / 裁剪（矩形选择、多边形选择、应用拆分、取消） |

- **移除「自适应」按钮**：`F` 快捷键与「双击空白处」仍可自适应，只是不再占顶栏位置
- 三个下拉**互斥**：打开一个会自动收起其它两个，点菜单项、点空白处、按 `Esc` 都会收起
- **下拉按钮不带三角**：「载入 / 插件 / 工具」与「双窗 / 截图 / 清空」字号、内边距完全一致，靠 `title` 与点击行为区分
- 单窗状态下「载入 → 公共（两侧）」自动隐藏（单窗只有一个视口，公共无意义）
- 切换按钮文案简化为「单窗 / 双窗」（原「单窗口 / 双窗口」），且**不再高亮**（它只表示"点下去会变成什么"，当前状态由文案本身表达，高亮会让人误以为状态指示）
- `plugins/optimize.js` 里给菜单项加的 `is-plugin` 标记，CSS 选择器从 `.btn.is-plugin::after` 放宽为 `.is-plugin::after`（菜单项没有 `.btn` class）

**验证**：探针脚本实测——初始三个菜单均 `hidden`；点「载入」→ `load=OPEN` 且另两个 `hidden`；点「插件」→ `plugins=OPEN` 且「载入」自动收起；9 个菜单项全部存在；双窗时 `btn-single` 文案为「单窗口」、单窗时为「双窗口」；`btn-fit` 已移除。`check.ps1` 7 项全 PASS（含 console 抓取无告警）。


**1.0.0.8（续 2）** — 视角器合并回 render.js

- `js/gizmo.js`（460 行）合并进 `js/render.js`：视角器属于渲染的一部分，不再单列文件；`render.js` 1733 → **2126 行**，js 文件回到 **6 个**
- `gizmoHooks.notify` → 复用 `renderHooks.notify`；`MV.gizmo.geo` → `MV.gizmoGeo`；`MV.gizmo.installAppMethods` → `MV.render.installAppMethods`
- `index.html` 去掉 `gizmo.js` 的 `<script>`；`app.js` 安装点改回 `MV.render.installAppMethods()`

**两次失败的原因（这次靠 console 抓取定位）**：
1. 第一次：用「恰好 4 空格缩进的 `}`」找函数闭合，命中的是**函数体内 `if` 的闭合** → 只截到 13 行；
2. 第二次（修正配平后）：`installGizmoMethods` 已搬入但**导出语句没加** —— 脚本用 `'render.installAppMethods' in r` 做重复检查，而文件头注释里正好有这个词，于是误判「已存在」跳过；
   浏览器报 `Uncaught TypeError: this.drawAxisCube is not a function`（app.js:1255），被 `check.ps1` 的 console 抓取直接指出。

另外发现 `gizmo.js` 里 `installGizmoMethods` 开头有一段**重复的 `var App` + if**（上次拆分残留），一并清掉。

**验证**：`check.ps1` 7 项全 PASS（console 无告警），截图确认左下角削角六面体 + XYZ 箭头正常。


**1.0.0.8（续 3）** — 单窗拖放语义 + 按钮文案

- **单窗模式下的拖放**：原来单窗一律把落点当「A」，提示文字仍是「松开导入到左侧 (A)」，但单窗只有一块画布、没有左右半屏，语义不成立。改为：
  - `slotAt()` 单窗直接返回 `'BOTH'`（**公共场景**），`addFiles` 按 `['A','B']` 两侧一起建层，单视口合并渲染
  - 拖放高亮区宽度 100%，提示改为「松开导入到公共场景」
  - 顶部 `drop-hint` 改为「拖拽 … 到窗口任意位置（导入公共场景）」
  - 状态栏提示补上「公共场景」分支（原只有 A/B 两种）
  - 空场景提示从「拖到视图左/右半屏」改为「使用顶部『载入』按钮，或把文件拖进窗口」
- **旋转中心按钮**：「默认视角」→ **「默认」**（与「重设」「回正」保持两字对齐）

**验证**：探针实测单窗下 `label=松开导入到公共场景`、`hint=…到窗口任意位置（导入公共场景）`、`zoneA_width=100%`、`reset=默认`、`single_btn=双窗`、`active=false`、无 JS 错误；`check.ps1` 7 项全 PASS。


> **版本号说明**：本次提交为 **`1.0.0.8`**（git 中上一版是 `1.0.0.7`）。改动过程中版本号曾写到 1.0.0.9 / 1.0.0.10，已统一并回 1.0.0.8。
> 提醒：**每次改 JS 都要同步升 `?v=`**，否则浏览器按 URL 命中旧缓存，表现为"代码改了页面没变"。


**1.0.0.9** — algo.js 剥离全部 DOM 依赖（分层契约达标）

`algo.js` 原有 **11 处 `document.*`**（选择框 SVG 创建 + 4 个裁剪按钮绑定 ×2 处），是把 `segment.js` 并进来时留下的。这次全部移出：

| 原位置 | 内容 | 移到 |
|---|---|---|
| `canvasEl()` / `createElementNS` ×4 | 主 canvas 查找 + SVG 选择框、rect、polygon 创建 | **`ui.createSegOverlay()`**（界面层建 DOM，返回 `{overlay, rect, poly}`） |
| `syncButtons()` | 切 3 个按钮的 `active` / `disabled` | **`ui.syncSegButtons(mode, hasPreview)`**（经 `hooks.syncSegButtons`） |
| `window.load` 里的 4 个按钮绑定 | 矩形 / 多边形 / 应用拆分 / 取消 | **`app.bindSegmentUi()`**（`app.init()` 之后） |
| 同处的 `Esc` / `Enter` 监听 | 取消 / 闭合多边形 | **`app` 的 keydown → `MV.algo.onKey(ev)`** |
| `demoIfRequested()` 调用 | `?demo=seg` 自动演示 | `app.bindSegmentUi()` 末尾 |

`algo` 现在只导出纯逻辑入口：`currentMode / toggleMode / applySplit / cancelEdit / onKey / demoIfRequested`。

**两个修掉的坑**：
1. `setMode()` 里 `overlay.style.pointerEvents` 报 `Cannot read properties of null` —— `ensureOverlay()` 没拿到选择框。根因：`bindHooks()` 用 `for (var k in hooks)` **遍历 hooks 自身**，新增的 `canvas / createOverlay / syncSegButtons` 永远注入不进来；改成遍历**传入对象**后正常。
2. 删掉 `canvasEl()` 后 `demoIfRequested()` 里仍有一处 `var cv = canvasEl();` → `ReferenceError`，被 `check.ps1` 的 console 抓取直接指出（`algo.js:851`）。

**依赖复查**：

```
core.js    MV.ui:0  document:0  gl:0     ✅
io.js      MV.ui:0  document:0  gl:0     ✅
algo.js    MV.ui:0  document:0  gl:0     ✅  ← 本次达标
render.js  MV.ui:0  document:0  gl:458   ✅
ui.js      MV.ui:3  document:50 gl:0     ✅ 界面层
app.js     MV.ui:73 document:16 gl:0     ✅ 编排层
```

**验证**：`check.ps1` 7 项全 PASS（`segment` 用例覆盖 setMode → 预览 → applySplit 全链路）。


**1.0.0.9（续 1）** — 裁剪工具栏改造（编辑栏 + 追加选区 + 撤销）

**入口收敛**：工具 ▾ 从「拾取 / 矩形选择 / 多边形选择 / 应用拆分 / 取消」5 项，收敛为「拾取 / **裁剪**」2 项（与拾取同级）。点「裁剪」后，画布**右上角浮出编辑栏**。

**编辑栏（7 个内联 SVG 图标，非位图）**：

| 图标 | 功能 | 说明 |
|---|---|---|
| 虚线框 + 四角点 | 矩形选择 | 当前模式时蓝框高亮 |
| 五边形 + 顶点 | 多边形选择 | 同上 |
| 方框 + 斜线 | 裁剪预览 | **显示 / 隐藏**预览高亮，默认开 |
| 虚线框 + 加号 | 继续裁剪 | **在当前选区上追加一块** |
| 对勾 | 应用裁剪 | 拆成 `_segmented` / `_remaining` |
| 逆时针箭头 | **撤销** | 回退上一次追加（`Ctrl+Z` 同效） |
| ✕ | 退出裁剪 | `Esc` 同效 |

编辑栏左端显示「选区 N 块」，让累积层数可见。

**追加选区的算法**（不加新几何算法）：对**剩余部分**继续裁

```
第1块: splitMesh(原始, P1) → { seg1, rem1 }
第2块: splitMesh(rem1, P2) → { seg2, rem2 }   累积 = seg1 ∪ seg2
```

好处：严格并集、重叠区不重复计入、完全复用现有半空间裁剪。

**撤销的实现**（内存安全）：只记 `planes`（每块一个棱柱，几 KB），撤销时 `pop` 后从原始数据**重放**剩余平面。不保存顶点快照（百万面时每个快照 ~108 MB，会爆）。

**三个修掉的坑**：
1. `beginAppend()` 后选区凭空消失 —— `clearShape()` 里有一句 `preview = null`，被 `beginAppend` 间接触发；改为 `clearShape()` 只清「正在拖拽的临时形状」，`preview` 由 `setMode(null)` / 空结果 / `applySplit` 负责清。
2. 无头环境下 `?demo=seg` 永不执行 —— `demoIfRequested` 的轮询用 `requestAnimationFrame`，headless 里可能不推进；改 `setTimeout(tick, 16)`。
3. `Esc` 退出裁剪后无法再进入 —— app 的 Esc 分支会 `selectedId = null`（原有行为）；改为**裁剪进行中按 Esc 只退出裁剪、保留图层选中**。

**验证**：
- 探针：`demo后 show/count=1` → `Esc后 hidden/mode=null` → `selectedId=1 getSelected=yes` → `点裁剪 show/mode=rect` → `点多边形 polyActive=true rectActive=false` → `点✕ hidden`
- 追加/撤销：`base count=1` → `beginAppend + 框选 → count=2` → `undo → count=1`；空选区点追加安全返回
- 截图：7 个图标清晰可辨，矩形与预览按钮蓝框高亮
- `check.ps1` 7 项全 PASS


**1.0.0.9（续 2）** — 选区与相机互锁

**问题**：裁剪的选区是按「当前视角投影」算出的棱柱。原来整个裁剪过程中 overlay 一直 `pointer-events:auto`，导致：
- 框选时相机确实转不动（事件被 overlay 吃掉），但用户不知道是「设计如此」还是「卡了」；
- **选区算完也转不动视角**，无法换个角度检查高亮对不对。

**改法**：按「是否正在框选」切换 overlay 的指针行为，并同步锁/解锁相机。

| 阶段 | overlay | 相机 | 高亮 |
|---|---|---|---|
| 正在框选（按下 → 松开 / 双击闭合） | `pointer-events:auto` | **锁定**（旋转、平移、缩放全部无视） | — |
| 选区已确定 | `pointer-events:none` | **解锁**，可自由转视角 | 保持 |
| 点「继续裁剪」或切换矩形/多边形 | 回到 `auto` | 重新锁定 | 保留已有选区 |
| 应用 / 退出（✕、Esc） | `none` | 解锁 | 清空 |

**实现**：
- `algo.setOverlayInteractive(on)`：统一切换 overlay 指针行为并回调 `hooks.cameraLock`
- `app.setCameraLock(on)`：置 `cameraLocked`，`pointerdown` 与 `wheel` 直接 return（不只是靠 overlay 挡）
- 触发点：`setMode`（进入锁 / 退出解）、`computePreview` 成功（解）、`doAppend` 成功（解）、`beginAppend`（锁）、`applySplit`（解）

**验证**（探针实测）：
```
预览后     locked=false  overlay=none
拖动后     相机变化=true          ← 解锁后可转视角
追加后     locked=true   overlay=auto
锁定时拖动 相机变化=false         ← 框选时相机确实被锁
退出后     locked=false  overlay=none
```
`check.ps1` 7 项全 PASS。


**1.0.0.9（续 3）** — 选区框收敛 + 高亮改为「纯色覆盖」

**问题 1：选区确定后还画着矩形/多边形框**
框是屏幕空间的数据（黄色虚线），预览算出来后已经用高亮表达了范围，框留着只会误导（转视角后它和实际选区不重合）。改为在 `computePreview` 与 `doAppend` 成功后调用 `clearShape()`，框立即消失，`preview` 不受影响。

**问题 2：高亮是「叠加」而不是「覆盖」，换视角就不完整**
原来的实现是「原模型完整画一遍 + 预览层半透明青色再叠一层」（`alpha=0.55`、`depthMask(false)`、`LEQUAL`），因此：
- 两者共面 → 深度顺序随视角变化 → **同位置出现两种颜色的混合**；
- 从背面看时，预览层画在「正面位置」，被原模型的**背面几何**挡住 → **完全看不到高亮**。

改为**替换式**：预览期间该图层不画完整模型，改画两份数据。

| 数据 | 颜色 | 说明 |
|---|---|---|
| `rem`（未被选中的剩余部分） | 图层原色 + 原背面色，正常光照 | 由 `splitMesh` 的差集得到 |
| `seg`（选中部分） | 高亮青 `(0.10, 0.95, 0.85)`，不透明，不参与光照 | 由交集得到 |

这样每个三角形**只出现一次**，颜色是确定值，任何视角都是完整高亮（背面也正确显示为原色）。

**实现**：
- `Renderer.setPreview({ seg, rem, layerId, color, backColor, shade })`：两份 VAO（`previewVao` / `previewRemVao`）
- `drawMeshLayer` 开头：`if (this.previewOverlayId === layer.id && this.previewVao) return;` —— 跳过被预览的图层（连带跳过它的线框/顶点/边界，预览期间只看高亮）
- `drawPreviewSeg`：先画 `rem`（`uTwoSided=1` + 原色/背面色），再画 `seg`（`uTwoSided=0` + 高亮色）

**验证**：
- 正面（`?demo=seg`）：选中区纯青、无黄色框；剩余区橙色正常
- 背面（`?demo=seg&yaw=35&pitch=-25`）：选中区**仍是纯青完整高亮**，剩余区暗红（原背面色），无混色
- `check.ps1` 7 项全 PASS

> 附带影响：预览期间状态栏 `blocks` 显示 `0/0`（因为该图层被跳过、不再走分块统计），属显示层面的小瑕疵，不影响画面。


**1.0.0.9（续 3 补充）｜为什么放弃「替换式」**

1.0.0.11 先做了「预览期间原图层不画，改画 rem（原色）+ seg（高亮）」。实测发现两个问题：

| 问题 | 实测 |
|---|---|
| 裁剪结果本身有缺口 | `seg` 44,385 + `rem` 22,194 = **66,579** 三角形，而原模型 **72,700** —— 少 **8.4%**，缺口处没有三角形可画 |
| 缺口在视觉上就是「露出原色」 | 用户看到的高亮区域内夹杂原色，正是这 8.4% + 边界处 |

换视角时缺口更明显（背面看时整块高亮都消失过）。

**最终方案：原模型完整绘制 + 高亮层纯色覆盖**

```js
gl.disable(gl.BLEND);        // 不透明
gl.depthMask(false);         // 不写深度
gl.depthFunc(gl.ALWAYS);     // 关深度测试：任何角度、任何遮挡都可见
gl.disable(gl.CULL_FACE);    // 正背面都涂
```

- 原图层**照常完整绘制**（`blocks=16/16` 恢复正常），不再依赖 rem/seg 互补
- 高亮层只「涂」选中部分，纯色、覆盖、无混色
- 关深度是为了背面视角与被遮挡处也能看到完整高亮（裁剪选区本来就是"可见即选中"的语义）
- 结束时恢复 `depthFunc(LESS)` + `depthMask(true)`，不影响后续视角器/标记

**验证**：正面 `?demo=seg` 与背面 `?demo=seg&yaw=35&pitch=-25` 两视角，选中区均为**纯青完整覆盖**，无原色夹杂；`check.ps1` 7 项全 PASS。


**1.0.1.0** — 空格键 = 继续选中（保留高亮，追加下一块）

**语义澄清**：这里的「应用」指的是**把新框选的部分并入当前选区**，不是「拆分图层」。所以空格与编辑栏上的「继续裁剪」按钮是**同一个动作** —— 两者都只是进入「等待下一次框选」的状态，当前高亮**原样保留**。

| 操作 | 行为 |
|---|---|
| 选区算出后按 **空格** | 保留当前高亮，重新锁定相机，等待框第二块；框完自动并入选区（高亮范围扩大） |
| 编辑栏 **继续裁剪** 按钮 | 同上（空格是它的快捷键） |
| 编辑栏 **应用裁剪** 按钮 | 才是真正把选区拆成 `_segmented` / `_remaining` 两个图层并退出裁剪 |
| 无选区按空格 | 只吃掉按键，不做任何事 |
| `Esc` | 退出裁剪 |

**实现**：`onKey` 的空格分支调用 `beginAppend()`（与按钮同一条路径）；追加逻辑沿用 `doAppend()` —— 对「剩余部分」再 `splitMesh`，所以天然并集、重叠区不重复计入。

**两个坑**：
1. 最初把空格做成了「拆分图层 + 切到 `_remaining` 继续」，这与用户要的「保持当前选区继续选」相反，已改回纯追加（并删掉了那个函数，避免混淆）。
2. **空格会触发焦点按钮的 click**：点过「应用」或「退出」后按钮仍持有焦点，一按空格浏览器就替它点了一次 —— 表现为「按空格直接退出裁剪」。修法：裁剪模式下空格**一律** `preventDefault()`（不再只在有选区时才拦），应用后把焦点 `blur()`（放在 app 层，`algo` 保持零 DOM）。

**验证**（探针）：
```
初始    layers=1 count=1 mode=rect locked=false
空格后  layers=1 count=1 mode=rect locked=true    ← 图层没变、高亮保留、相机重新锁
```
`check.ps1` 7 项全 PASS。


**1.0.1.1** — 深色 / 浅色主题（重新设计）

第一次只做了「颜色替换」，没做「主题设计」，结果是浅色下蓝一块白一块、文字对比不足、控件与背景分不清。这一版按成熟编辑器（GitHub / VS Code / Figma）的调色板重做。

**完整语义色板**（每套 16 个变量，全部有 WCAG 对比度依据）：

| 变量 | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `--bg-deep` | `#0d1117` | `#eef1f5` | 画布（最底层） |
| `--bg` | `#161b22` | `#ffffff` | 面板 |
| `--bg-soft` | `#21262d` | `#f6f8fa` | 控件 / 输入框 |
| `--bg-hover` | `#30363d` | `#eaeef2` | 悬浮 / 选中底 |
| `--line` | `#30363d` | `#d0d7de` | 边框 |
| `--line-soft` | `#21262d` | `#eaeef2` | 细分隔 |
| `--text` | `#e6edf3`（13.6:1） | `#1f2328`（15.9:1） | 主文字 |
| `--text-2` | `#c9d1d9` | `#24292f` | 次主文字 |
| `--dim` | `#8b949e`（6.5:1） | `#656d76`（6.4:1） | 说明 / 占位 |
| `--accent` | `#58a6ff` | `#0969da` | 强调（文字/描边） |
| `--accent-2` | `#1f6feb` | `#0969da` | 强调（实底） |
| `--accent-hi/lo` | `#79c0ff`/`#1f6feb` | `#0969da`/`#0550ae` | 渐变端点 |
| `--ok/warn/danger` | `#3fb950`/`#d29922`/`#f85149` | `#1a7f37`/`#9a6700`/`#cf222e` | 语义状态 |

**关键设计决策**：
1. **三层纵深**：画布最暗 → 面板次之 → 控件最亮（深色）；浅色则是画布**略暗于**面板，模型才「浮」得起来，纯白画布会和模型抢注意力
2. **浅色不用纯白做画布**：`#eef1f5` 微灰，长时间看孔位不刺眼
3. **彩色全部收敛**：24 处散落的蓝/绿/黄/红统一到 `--accent` / `--ok` / `--warn` / `--danger`，不再出现「一个蓝深一个蓝浅」
4. **网格线跟随主题**：WebGL 画的网格不归 CSS 管，`App.setTheme()` 同时设 `renderer.gridColor`（深色 `#38424F`、浅色 `#B8C2D1`）
5. **「背景」色板同步**：切主题时更新 `#opt-bg` 的显示值

**踩的坑**：新色板把 `--accent-hi/lo` 改名成 `--accent/--accent-2`，但 CSS 里还有引用旧名 → 变量未定义 → **logo 渐变背景变透明**、若干强调色消失。加了一次「变量引用 vs 定义」全量核对脚本才揪出来。

**验证**：深浅两套截图，顶栏渐变、logo、面板层次、网格线、文字对比、滑块/勾选统一；`check.ps1` 7 项全 PASS。


**1.0.1.1（续）** — 浅色主题的浮层与徽标

浅色下有几处**半透明深色底**没跟着主题走（它们用的是 `rgba()`，之前的 hex 映射覆盖不到），表现为浅色画布上突兀的深色块：

| 元素 | 原样式 | 浅色主题改为 |
|---|---|---|
| `.view-tag`（左侧 A / 右侧 B 标签） | `rgba(20,24,33,.72)` + `--text` | `rgba(255,255,255,.94)` + `--dim`，边框 `--line` |
| `#drop-hint`（画布中央拖放提示） | `rgba(16,19,26,.5)` + `--dim` | 同上白玻璃 |
| `#progress` / `#sfbar` / `#pickbar` / `.seg-bar` / `#help` | `rgba(17~20,21~24,27~33,.88~.97)` | 同上白玻璃 |
| `.modal`（遮罩） | `rgba(8,10,14,.62)` | `rgba(31,45,61,.30)`（浅色下遮罩要更淡） |

另外：A / B / S **徽标**的文字色原本是 `var(--bg-deep)` —— 深色下是深底浅字没问题，浅色下 `--bg-deep` 变成浅灰，蓝底浅字对比不足。改为固定 `#ffffff`。

**验证**：双视图浅色截图，「左侧 (A)」「右侧 (B)」标签为白玻璃 + 灰字，场景树 A 徽标白字清晰；`check.ps1` 7 项全 PASS。


**1.0.1.1（续 2）** — 主题切换改为按钮

下拉框在「视图设置」里读起来像配置项，实际它是个**动作**。改成按钮，文案沿用「单窗 / 双窗」的约定 —— **显示点下去会变成什么**：

| 当前 | 按钮显示 |
|---|---|
| 深色 | 浅色 |
| 浅色 | 深色 |

标签同步从「主题」改为「主题切换」。

**验证**（探针）：
```
初始    text=浅色  bodyLight=false
点一次  text=深色  bodyLight=true
点两次  text=浅色  bodyLight=false
```


**1.0.1.2** — ghost 叠加色随主题

**问题**：双窗时对面图层的「透明叠加」（ghost）颜色是硬编码的浅灰 `[0.62, 0.68, 0.78]` + `alpha=0.16`。这套值在深色画布上合适，但浅色画布是 `#eef1f5`——浅灰叠 16% 几乎与背景同色，**对面模型基本看不见**。

**改法**：ghost 基色与透明度改为 renderer 属性，随主题切换。

| 主题 | 基色 | alpha | 浅色画布上的效果 |
|---|---|---|---|
| 深色 | `[0.62, 0.68, 0.78]`（浅灰蓝） | 0.16 | 不变（原来就是这套） |
| 浅色 | `[0.42, 0.47, 0.55]`（中灰蓝） | 0.26 | 明显可见，仍能与前景实体区分 |

点云的 ghost 透明度取 `alpha × 1.45`（点比面片更小，需要更实一点才看得见）。

**实现**：`renderer.ghostColor` / `renderer.ghostAlpha` 两个属性，`App.setTheme()` 里按主题赋值，两处绘制（mesh 轮廓 / 点云）都改为读它。

**验证**：双窗浅色截图，左侧画布的 ghost 轮廓与孔洞清晰可辨；深色下与改前一致；`check.ps1` 7 项全 PASS。


**1.0.1.2（续 1）** — 侧栏可拖拽 + 标量条可关 / 高度减半

**侧栏宽度**：`#sidebar` 右侧新增 5px 拖拽条（`#sidebar-resizer`），拖动改宽度，夹在 **220 ~ 620px**。hover 时显示强调色，提示可拖。

**面板高度**：`#sidebar` 改为 `flex-direction: column`，三个面板（场景树 / 图层属性 / 视图设置）各 `flex: 1 1 auto`、内部独立滚动；面板之间插 5px 分隔条（`.panel-resizer`，`cursor: row-resize`），拖动改**上一个面板**的固定高度，下限 54px。

**标量条**：
- 视图设置 → 显示 → **「显示标量条」**（默认勾选）；关掉后 `#sfbar` 直接隐藏，`updateColorBar()` 也尊重该开关
- 高度减半：直方图 canvas `84 → 40`，`#sf-ramp` `→ 8px`，整体 padding 收紧

**验证**（探针实测拖动与开关）：

```
初始     侧栏宽=312  面板1高=151  resizers=2
拖侧栏后  宽=392                    ← 312 + 80
拖面板后  面板1高=211               ← 151 + 60
标量条    checkbox=true
关闭后    sfbar hidden=true
```

`check.ps1` 7 项全 PASS。


**1.0.1.2（续 2）** — 修复 S 徽标不可见

**现象**：深色主题下，场景树「公共图层」的 **S 徽标完全看不见**（A 蓝、B 橙都正常）。

**根因**：`:root` 里写成了自引用

```css
--ok: var(--ok);      /* 循环引用 → 变量无效 → background 回落成透明 */
```

S 徽标背景取 `var(--ok)`，值无效 → 背景透明 → 深色文字 `#0d1117` 叠在深色面板 `#0d1117` 上，等于隐身。

**为什么会产生自引用**：重做色板时先插入了变量块（`--ok: #3fb950`），随后“彩色归一”那一步按色值做映射，把**变量块里自己的值**也替换成了 `var(--ok)` —— 顺序反了。A/B 用的是 `--accent-hi` / `--warn`，它们的定义值没进映射表才侥幸正常。

**修法**：
1. `--ok: var(--ok)` → `--ok: #3fb950`
2. 加一个**全量校验**：逐块提取 `--x: value`，凡 value 里含 `var(--x)` 自身即报错

**校验结果**（两套色板各 18 个变量，全部为具体色值、无自引用）：

```
[:root]        --ok #3fb950  --warn #d29922  --danger #f85149  --accent #58a6ff
body.theme-light --ok #1a7f37  --warn #9a6700  --danger #cf222e  --accent #0969da
```

**实测**：`slot-S` 的 computed `background-color` 由 `rgba(0,0,0,0)` 变为 `rgb(63,185,80)`；A/B/S 三枚徽标均为浅底 + 深字。


**1.0.1.2（续 3）** — 图层属性 / 视图设置 合并为 Tab

原先两块面板上下叠放，各自滚动、各自占高度；实际使用中一次只看一个，白占一半侧栏。

**改为共用一块区域**，标题栏变成两个 Tab：

```
┌─────────────┬──────────┐
│ 图层属性 ●  │ 视图设置 │    ← 点击切换（当前项底部强调色下划线）
├─────────────┴──────────┤
│  对应内容...            │    ← 同一位置，只显示一个
└────────────────────────┘
```

- 两个 `<section class="panel">` 加 `data-tab`，非当前项 `display:none`（`.tab-hidden`）
- 中间的 `.panel-resizer` 删除 —— 它们不再上下排列，只剩「场景树 ↔ Tab 区」一个分隔条
- 视图设置原来的独立标题行删除，避免标题重复
- `#sidebar > .panel` 的 `flex` 从 `1 1 auto` 改为 **`1 1 0`**：内容多少不影响占位，切换时高度不跳

**验证**（探针）：

```
初始     props隐藏=false view隐藏=true  激活=图层属性  高 474 / 0
点视图后  props隐藏=true  view隐藏=false 激活=视图设置  高 0 / 252
点属性后  props隐藏=false view隐藏=true  激活=图层属性  高 474 / 0
```


**1.0.1.2（续 4）** — Tab 栏常驻 + 面板高度封顶

**两个 bug**：

| 现象 | 根因 | 修法 |
|---|---|---|
| 切到「视图设置」后标题消失，切不回来 | Tab 栏放在**图层属性面板内部**，切过去后该面板 `display:none`，Tab 栏跟着消失 | Tab 栏移出面板，独立成 `.panel-tabs` 一行（`flex: 0 0 auto`），永远可见 |
| 属性/视图面板挤占场景树（474 vs 151） | `flex: 1 1 0` 只按剩余空间均分，没有上限 | `#sidebar > .panel[data-tab] { max-height: 50% }` |

**验证**（探针，侧栏总高 630，上限 315）：

```
初始     tab栏可见=true 激活=图层属性 props=315 view=0   场景树=151
点视图后  tab栏可见=true 激活=视图设置 props=0   view=315 场景树=151
点属性后  tab栏可见=true 激活=图层属性 props=315 view=0   场景树=151
```

面板高度正好卡在「侧栏一半」，场景树始终保留 151px。


**1.0.1.2（续 5）** — 属性 / 视图面板高度锁定为侧栏一半

**为什么前几版没生效**：`max-height: 50%` 配合 `flex: 0 1 auto` 时，flex 布局先把面板压到 `min-height`（120px），`max-height` 只是上限、并不会让面板"长到"上限。多试了三次才对：

| 尝试 | 结果 |
|---|---|
| `flex: 1 1 0` + `max-height: 50%` | 面板 474、场景树 151（面板想均分，把场景树挤小） |
| `flex: 0 1 auto` + `max-height: 50%` | 面板被**收缩**到 `min-height: 120px` |
| `flex: 0 0 auto`（禁收缩） | 仍是 120（`min-height` 与 `max-height` 并存时 flex 取了下限） |
| **JS 直接给尺寸** | ✅ 面板 = 侧栏一半，场景树稳定保留 |

**最终实现**：

```js
var limit = Math.max(120, Math.floor(side.clientHeight * 0.5));
panels[i].style.height = limit + 'px';
panels[i].style.maxHeight = limit + 'px';
panels[i].style.flex = '0 0 ' + limit + 'px';
```

- 场景树 `flex: 1 1 0` 吃掉剩余空间
- 面板高度 = 侧栏 `clientHeight` 的一半，两个 Tab 切换时高度一致、不跳
- `window.resize` 时重算；首次布局因为 `sidebar.clientHeight` 可能还是 0，补了 `setTimeout(0)` / `setTimeout(250)` / `requestAnimationFrame` 三次同步

**验证**（侧栏 570，上限 285）：

```
初始     属性=285 OK | 视图=0       | 场景树=248
切视图后 属性=0   | 视图=285 OK | 场景树=248
```


**1.0.1.2（续 6）** — 标量条自带关闭按钮 + 再压缩

**为什么"看不到按钮"**：开关 `显示标量条` 在 **视图设置 Tab** 里（要先点 Tab 切过去），不在默认显示的「图层属性」内。探针实测：

```
opt-sfbar 存在=true  可见=false  所在行=显示标量条   ← 在另一 Tab
切到视图设置后   可见=true  勾选=true
```

**改法**：标量条自己右上角加一个 `×`，直接关掉；关掉后仍可在「视图设置 → 显示 → 显示标量条」重新打开，两边状态同步。

**高度再收紧**：

| 项 | 改前 | 改后 |
|---|---|---|
| 直方图 canvas | 84 | **32**（attr 与 CSS 高度一致，不变形） |
| 色带 `#sf-ramp` | 8 | 6 |
| 整体 padding | `6 9 5 9` | `5 8 4 8` |
| 标题 / 刻度字号 | 12 / 11 | 11 / 10 |
| 标量条整体高度 | ~120 | **92** |

**验证**（探针）：

```
sfbar 高=92 | hist高=32 attr=32
关闭按钮 可见=true
点×后 hidden=true  checkbox=false     ← 双向同步
```

> 注：「重开后 hidden=true」是因为当时选中的是 STL 网格（无标量场），`updateColorBar()` 判断无标量数据即隐藏 —— 属预期行为，点云 + 标量场着色时会正常显示。


**1.0.1.2（续 7）** — 标量条高度真正减半（~120 → 63）

上一版只把直方图 canvas 从 84 改到 32，整体仍有 92px（只是降了 23%），不够。这次逐个部件压：

| 部件 | 原 | 现 |
|---|---|---|
| 标题行（`#sf-name`） | 字号 12 / 行高 16 | **字号 9 / 行高 10** |
| 直方图（`#sf-hist`） | 84（后改 32） | **22**（canvas attr 同步 22，不变形） |
| 色带（`#sf-ramp`） | 8 | **5**，上下 margin 2 |
| 刻度（`.sf-range`） | 字号 11 | **字号 9 / 行高 10** |
| 内边距 | `6 9 5 9` | **`3 7 2 7`** |
| 宽度 | 190 | 172 |
| **整体高度** | **~120** | **63**（−47.5%） |

**验证**（探针逐部件量高）：

```
sfbar=63 | name=10 | hist=22 (attr=22) | ramp=5 | range=10
```

关闭按钮与「视图设置 → 显示标量条」双向同步保持不变。


**1.0.1.2（续 8）** — 「显示标量条」开关归位到图层属性

开关原来放在「视图设置 → 显示」，但标量条属于**图层的标量场数据**，放在全局视图设置里不合理（也要切 Tab 才看得到）。移到 **图层属性 → 标量场（点云）** 分组，紧跟「色带」之后、与「分布」同组：

```html
<div class="prop-row" id="row-sfbar">
    <label>显示</label>
    <input type="checkbox" id="opt-sfbar" checked />
</div>
```

样式沿用 `.prop-row`（左标签 + 右控件），即 **`显示  ☑`**。

显隐规则与相邻的「字段 / 范围 / 色带 / 分布」一致：只在**选中点云且按标量场着色**时出现（`renderProps` 里随 `showSF` 切换 `show` 类）。

绑定不变：勾选 ↔ 标量条显示；标量条上的 `×` 关闭后会把勾选同步取消。


**1.0.1.2（续 9）** — 「显示 ☑」并入分组标题行

上一版它是分组内单独一行（`显示  ☑` 占 20px），多占一行空间。改为**直接放在分组标题行右端**，紧凑一行：

```
┌────────────────────────────────┐
│ 标量场（点云）        显示 ☑    │   ← 一行搞定
├────────────────────────────────┤
│ 字段      [下拉]                │
│ 范围      [最小][最大][自动]     │
│ 色带      [下拉]                │
│ 分布      [直方图]              │
└────────────────────────────────┘
```

**实现**：
- `.prop-group > .group-title` 改 `display:flex; justify-content:space-between`
- 开关包一层 `<span id="sf-toggle-wrap" class="gt-toggle">显示<input type="checkbox" id="opt-sfbar"></span>`
- `#sf-toggle-wrap` 默认 `display:none`，`showSF` 时加 `.show` 变 `inline-flex`（原来是给整行 `row-sfbar` 加 `show`，现在目标换成这层 span，标题本身不受显隐影响）
- 字号 10px、勾选框 12×12，不撑高标题行

**注意**：该开关只在**选中点云 + 按标量场着色**时出现（与「字段 / 范围 / 色带 / 分布」同步显隐）。


**1.0.1.3** — 字体体系按工业软件规范重排

**审计现状**（改前）：`9px×3 / 10px×10 / 11px×29 / 12px×13 / 13px×5` —— 11px 泛滥到 29 处，与 12px 挤在一起没有层级；9~10px 的中文在 100% 缩放下几乎不可辨认；字重只有 400/600 两档。

**新体系**（最小 11px）：

| 层级 | 字号 | 字重 | 用途 |
|---|---|---|---|
| 品牌 | **15px** | 700 | 3DV 标识 |
| 标题 | **13px** | 600 | 弹窗标题 |
| 面板标题 | **12px** | **500** | 场景树 / 图层属性 / 视图设置（原来 11/600，靠粗体区分，改成靠字号） |
| 正文 | **12px** | 400 | 按钮、输入、树项、属性值、状态栏 |
| 辅助 | **11px** | 400 | 计数、徽标、提示、标量条刻度 |

**渲染细节**（`body`）：

```css
text-rendering: optimizeLegibility;
-webkit-font-smoothing: antialiased;
font-variant-numeric: tabular-nums;          /* 数字等宽，工程读数不跳动 */
font-feature-settings: "tnum" 1, "lnum" 1, "liga" 0;   /* 关连字，避免 ½ 之类被替换 */
```

`tabular-nums` 全局继承后，状态栏 `meshA=0 lineA=0 pointA=0`、属性数值、标量条刻度都自动对齐。

**逐项调整**：

| 选择器 | 原 | 现 |
|---|---|---|
| `.brand .title` | 13 / 600 | **15 / 600** |
| `.panel-title` | 11 / 600 | **12 / 500** |
| `#statusbar` | 11 | **12** |
| `.prop-row .stat` / `button.mini` / `#help td` / `.pg-text` | 11 | **12** |
| `.tree-item .lmeta` / `.caret` | 10 | **11** |
| 所有 9px | 9 | **10**（标量条内保持紧凑） |


**1.0.1.3（续）** — 背面默认中性灰 + 属性面板字号统一

**① 背面色**：新导入的网格背面原来是暗红 `#b03a30`，与正面橙色（`#ffb347` 系）色相接近，转视角时不容易分辨正反。

改为**中性灰 `#6b7078`**：与正面的暖色形成冷暖对比，一眼能看出「这是背面」，也不会像纯灰那样发闷。`render.js` 里的兜底色同步为 `[0.42, 0.44, 0.47]`。

**② 属性 / 视图设置字号**：上一轮只统一了外层字号，面板内部仍是混搭 —— 标签 11px、输入框 12px、数值 11px、分组标题 10px。

统一后：

| 元素 | 原 | 现 |
|---|---|---|
| 属性标签（名称 / 归类 / 路径 …） | 11px | **12px** |
| 属性值（`.stat` / `.val` / `label.inline`） | 11px | **12px** |
| 视图设置标签（`.viewcfg .row .k`）与值 | 11px | **12px** |
| 分组小标题（属性 / 统计 / 外观 / 显示 / 相机） | 10px / 400 | **11px / 600** + 字距 0.3px |

分组小标题改用「小字号 + 半粗 + 略宽字距」来做层级，而不是放大字号 —— 与属性行的 12px 形成清楚的两级。

**验证**（探针读 computed style）：

```
属性标签=12px/400 | 属性质=12px/400 | 分组标题=11px/600
```


**1.0.1.3（续 3）** — 标题必须大于正文 + 同级按钮统一

**上一版的问题**：

| 问题 | 说明 |
|---|---|
| 面板标题与正文同大 | `.panel-title` 12px，正文也 12px —— 只靠 500 字重区分，远看或暗光下层级不成立 |
| 按钮字号不一致 | `button` 12px、`button.mini` 12px、**`button.danger` 11px**、`.menu .kbd` 10px |
| 旧规则残留 | `.group-title` 还有一条 10px 被后面的 11px/600 覆盖，属于死代码 |

**定稿的层级**（每一级字号和字重都不同，双重区分）：

| 级别 | 字号 | 字重 | 用途 |
|---|---|---|---|
| 品牌标题 | **16px** | 600 | 3D Viewer |
| 区块标题 | **14px** | 600 | 弹窗标题 |
| 面板标题 | **13px** | 500 | 场景树 / 图层属性 / 视图设置 |
| 正文 | **12px** | 400 | 按钮、输入框、树项、属性行 |
| 分组小标题 | **11px** | 600 | 属性 / 统计 / 外观 / 相机（+ 字距 .3px） |
| 辅助 | **11px** | 400 | 计数、提示、徽标文字 |
| 微 | **10px** | 400 | 标量条刻度 |

品牌 logo「3DV」保持 13px/700（它是图形化标识，不算文字层级）。

**同级按钮统一**（字号 / 字重 / 行高完全一致，只有内边距随尺寸级别变化）：

```css
button,
button.mini,
button.danger,
.menu button,
.panel-tabs .tab {
    font-size: 12px;
    font-weight: 400;
    line-height: 16px;
}
.panel-tabs .tab { font-weight: 500; }   /* Tab 是导航，多半级 */
```

`button.danger` 从 11px 提到 12px、`.menu .kbd` 从 10px 提到 11px，旧 `.group-title` 的 10px 规则已删除。


**1.0.1.3（续 4）** — 分组小标题反超正文 / 视图设置三行统一

**两个问题都是真的**：

| 问题 | 原状 |
|---|---|
| 层级反了 | 分组小标题「相机 / 显示 / 光照」是 **11px**，而正文「叠加对面模型 / 旋转中心」是 **12px** —— 小标题比正文还小 |
| 三行不同构 | 「叠加对面模型」「左右相机同步」是 `<label class="wide"><input>文字</label>`（勾选框在**左**），「旋转中心」是 `<span class="k">` + 按钮组（标签在**左**、控件在**右**） |

**改法**：

1. **小标题升到 13px / 600**（字距 .4px、颜色 `--text` 82% 不透明），面板标题同步升到 14px / 500，正文保持 12px / 400 —— 三级拉开

   ```
   视图设置（面板标题 14/500）
     相机（分组小标题 13/600）
       旋转中心（正文 12/400）
   ```

2. **三行统一成「标签左 + 控件右」**：

   ```html
   <div class="row">
       <span class="k">叠加对面模型</span>
       <div class="ctl">☑ ○透明 ○实体</div>
   </div>
   ```

   `.viewcfg .row { display:flex; justify-content:space-between }`，`.k` 吃满左侧、`.ctl` 右对齐，`min-height: 26px` 保证三行同高。

**验证**（双窗截图）：

```
相机  ← 13/600
  叠加对面模型        ☑  ○透明 ○实体
  左右相机同步                  ☑
  旋转中心      [重设] [回正] [默认]
```

顺带加了 `?tab=view` / `?tab=props` 直达指定 Tab（在 `app.init` 之后应用，因为 `MV.config` 建立晚于 `ui.js` 执行）。


**1.0.1.3（续 5）** — 顶点焊接只对 STL 生效

**背景**：`uploadLayer()` 原先对所有 `kind === 'mesh'` 的数据都调 `buildIndexed()` 做顶点去重 —— 按坐标量化键（`Q = 1e4`，0.1 μm）判重，把重合顶点合并成一份、三角形改用索引引用。

**为什么只给 STL**：

| 格式 | 顶点信息来源 | 是否焊接 | 理由 |
|---|---|---|---|
| **STL**（binary / ascii） | **没有**，每三角形 3 个独立顶点 | **是** | 天生散乱三角面，去重纯赚（72.7k 面：218,082 → 38,437 顶点，省 82%） |
| OBJ | 有 `v` 顶点表 + `f` 索引 | 否 | 自带拓扑，再合并可能把有意分离的顶点并掉 |
| PLY | 有顶点表 + 可选法向 / 颜色 / 属性 | 否 | 同上；将来若支持逐顶点属性，合并后属性无法区分 |

**实现**（`render.js`）：

```js
var WELD_VERTICES = true;   // 总开关，false 时所有格式都不去重

// uploadLayer 里
var doWeld = WELD_VERTICES && !!d.format && d.format.indexOf('STL') === 0;
var ix = buildIndexed(d.positions, doWeld);
```

`buildIndexed(positions, weld)` 在 `weld === false` 时走恒等索引分支：顶点原样复制、`idx[i] = i`。这样几何上完全不合并，而 `buildSpaceChunks` 重排、`drawElements`、线框 / 边界取边、视锥剔除等依赖索引的逻辑照常工作 —— 不需要切换成 `drawArrays`，避免动 4~5 处绘制路径。

**验证**（探针同页加载 STL + OBJ）：

```
STL  fmt=STL(binary)  tri=72694  vc=38437  焊接=是
OBJ  fmt=OBJ          tri=2      vc=6      焊接=否
```

`check.ps1` **7 项全 PASS**。


**1.0.1.3（续 6）** — 树显示面/点数 + 顶点云拷贝

**① 面数与点数**

树项右侧原来是 `72.7k tri`，现在改成 **`72.7k 面 · 38.4k 点`**，点云图层显示 `38.4k 点`，`title` 里给精确值。

点数取**唯一顶点数**（按位置量化去重，`Q = 1e4` 即 0.1 μm）—— 与焊接判重规则一致。为了让树一渲染就有值，这一步放在 `createLayer()` 里做（导入时算一次，72.7k 面约 20 ms），而不是等 `uploadLayer` 上传显存时才算：

```js
// app.js createLayer
if (data.kind === 'mesh' && data.vertCount === undefined && data.positions)
{
    data.vertCount = MV.render.countUniqueVerts(data.positions);
}
```

**② 顶点云拷贝**

图层属性里新增 **「拷贝顶点为点云」**（仅选中网格时显示）：

| 项 | 说明 |
|---|---|
| 数据 | 遍历网格三角形，按位置量化去重抽出唯一顶点，写成 `kind: 'points'` |
| 图层 | 名字 `vertices`，`parentId = 源网格 id` → 复用已有的父子层级（`emitRow(layer, depth)` 缩进渲染） |
| 删除 | 随源网格级联删除（`removeLayer` 已有此逻辑） |
| 属性 | 独立 `propsKey`（`verts:<id>:<n>`），颜色/点大小可单独调，不影响源网格 |

**踩的坑**：自动验证参数 `?mkverts=1` 没能触发（`bindSegmentUi` 里的轮询条件），**按钮功能本身已就绪但未经界面点击验证** —— 需要手工点一次确认。

**验证**：

```
树项    m    72.7k 面 · 38.4k 点
check.ps1  7 项全 PASS
```


**1.0.1.3（续 7）** — 顶点云入口移到场景树

上一版把「拷贝顶点为点云」放在**图层属性**里，要先选中网格、再切到属性面板才能点，路径太长，也和数据结构无关。

改为**直接长在场景树上** —— 网格节点下始终显示一个 `vertices` 子项：

```
右侧  1 层
  全选 / 全不选
  ☑ ▢ m                    72.7k 面 · 38.4k 点    ×
      └ ☁ vertices          ← 灰色斜体，未创建时的占位
  ▾ S 公共                  0 层
```

| 状态 | 表现 |
|---|---|
| 未创建 | 灰色斜体 `☁ vertices`，悬停变亮，**点击即创建** |
| 已创建 | 变成正常的子图层的行（可勾选显隐、可删除、显示 `38.4k 点`） |

**实现**：`renderTree` 的 `emitRow` 里，mesh 图层若没有 `format === 'vertices'` 的子图层，就追加一个 `.tree-item.child.ghost-child` 占位行；`click` → `app.selectedId = 源网格 id` 后调 `extractVertices()`。图层属性里的按钮及其绑定、显隐逻辑一并删除。

**验证**（截图）：

```
m          72.7k 面 · 38.4k 点   ×
  └ ☁ vertices
```

`check.ps1` **7 项全 PASS**。


**1.0.1.3（续 8）** — 顶点云拷贝改为右键触发

**问题**：上一版 `vertices` 占位行是**单击即创建**。树里每次点都会生成一个新图层，误触代价太大（每点一次多一个 38k 点的点云）。

**改为**：

| 操作 | 行为 |
|---|---|
| 单击 `vertices` | 只选中父网格，**不创建** |
| **右键** `vertices` | 弹出图层菜单，内含 **「拷贝顶点为点云」** |
| **双击** `vertices` | 快捷创建（等价于点右键菜单项） |

鼠标指针在占位行上显示为 `context-menu`（而非 pointer），提示这是右键操作。

**右键菜单**复用了已有的 `showCtxMenu(x, y, layer)`，在 `layer.kind === 'mesh'` 时插入一项：

```js
if (layer.kind === 'mesh')
{
    menu.appendChild(sep);
    ctxItem(menu, '拷贝顶点为点云', function ()
    {
        app.selectedId = layer.id;
        app.extractVertices();
    });
}
```

这样右键**网格行本身**也能拷贝，不必先找到 `vertices` 子项。

`check.ps1` **7 项全 PASS**。


**1.0.1.3（续 9）** — 顶点云交互改为三级

前两版的问题是：`vertices` 常驻显示、单击就创建。现在按「看信息 → 再决定拷贝到哪」的节奏重做：

| 操作 | 行为 |
|---|---|
| 点击**网格行** | 选中后才显示它的 `vertices` 子项（未选中的网格不显示） |
| 点击 **`vertices`** | **只显示顶点信息**，不创建图层。属性面板切到「顶点云（尚未创建）」区：来源网格、点数、范围 |
| **右键 `vertices`** | 菜单三项：**拷贝到本侧 / 对侧 / 公共** |

**属性面板的顶点信息区**（新增 `#vert-info`）：

```
┌ 顶点云（尚未创建） ┐
│ 来源   m                        │
│ 点数   38,437                   │
│ 范围   -25.0, -25.0, 0.0 → 25.0, 25.0, 12.0 │
│        [拷贝到本侧]              │
└────────────────────┘
```

`renderProps()` 开头判断 `app.vertexPreviewId`：有值时只渲染这一区并 `return`，不进入常规图层属性。

**右键菜单**（`showVertexCtx`）：

```js
拷贝到 右侧 (B)（本侧）
拷贝到 左侧 (A)（对侧）
拷贝到 公共 (S)
```

`extractVertices(targetSlot)` 新增参数，决定新图层挂在哪个 slot；`propsKey` 里也带上 slot，避免不同侧的顶点云共享显示属性。

**状态清理**：`selectLayer()` 里调 `clearVertexPreview()`，选中别的图层即退出顶点预览态。

`check.ps1` **7 项全 PASS**。


**1.0.1.3（续 10）** — 顶点云树交互口径修正

上一版仍不符合预期：导入后自动选中第一个图层 → `vertices` 一进来就显示；右键目标写的是「公共」；mesh 行的右键菜单里还留着「拷贝顶点为点云」。

按最终口径改：

| 项 | 改前 | 改后 |
|---|---|---|
| 导入后选中 | 自动选中第一个图层 | **不选中**（`selectedId = null`），所以默认不显示 `vertices` |
| 显示条件 | `layer.id === selectedId`（自动选中即显示） | 同上，但只有**用户点击**才会选中 |
| 右键 `vertices` 目标 | 本侧 / 对侧 / **公共 (S)** | 本侧 / 对侧 / **两侧 (A + B)** |
| 右键 `mesh` 菜单 | 含「拷贝顶点为点云」 | **删除**，只剩移动 / 拷贝到对侧 |

`extractVertices('BOTH')` 会把同一个顶点集在 A、B 两侧各建一个 `vertices` 图层（`propsKey` 带 slot，两边显示属性独立），选中落在后建的那个上。

**验证**（截图，默认态）：

```
右侧  1 层
  全选 / 全不选
  ☑ ▪ m          72.7k 面 · 38.4k 点  ×     ← 未选中、无高亮
  ▾ S 公共        0 层
```

`check.ps1` **7 项全 PASS**。


**1.0.1.3（续 11）** — 修点 vertices 后报 undefined

**现象**：点击 `vertices` 后页面底部报 `Uncaught TypeError: Cannot read properties of undefined`，`vertices` 也会从树里消失。

**根因**：`previewVertices()` 为了让「顶点预览态」不和真实图层选中冲突，把 `selectedId` 置成了 `null`：

```js
this.vertexPreviewId = meshId;
this.selectedId = null;        // ← 清掉了
```

而树的显示条件是 `layer.id === app.selectedId` —— 一清空，`vertices` 立刻消失；紧接着 `renderProps()` 也拿不到图层，访问 `l.data` 就抛 undefined。

**修法**（两处）：

1. **预览时保留选中**：`this.selectedId = meshId`，改用 `vertexPreviewId` 单独表达「正在看顶点信息」。这样 mesh 仍高亮、`vertices` 仍在，属性面板走顶点分支。
2. **顶点信息渲染加空值保护**：`vpSrc.data || {}`、三个 `getElementById` 都判空、`bbox` 增加 `typeof === 'number'` 检查，避免脏数据把整个 `renderProps` 打断。

`check.ps1` **7 项全 PASS**。


**1.0.1.3（续 12）** — 缓存后缀 + 顶点范围补全

**为什么改了却看不到效果**：这一轮反复修改 `ui.js` / `app.js`，但 `index.html` 里的 `?v=` 一直是 `1.0.1.3` —— 浏览器认为资源没变，直接用缓存，改动静默失效。前面「点 vertices 报错」「右键没反应」两次排查，有相当一部分是看了旧代码的表现。

**改法**：把构建序号与版本号解耦

```
?v=1.0.1.3  →  ?v=1.0.1.3c
```

版本号仍按「提交时 +1」的规则走，`?v=` 后缀单独维护 —— 改 JS 就动一下后缀，强制浏览器重新拉取。

**顺带修**：顶点信息里的「范围」一直显示 `—`。因为 `data.bbox` 有两种结构（数组 `[minx..maxz]` / 对象 `{min, max}`），只判了数组。现在两种都认，且 `createLayer()` 对 mesh 缺 `bbox` 时会用 `render.bboxOf()` 补算。

**验证**（`?preview=1` 直达顶点预览态）：

```
vi-src   = m
vi-count = 38,437
vi-bbox  = -426.1, -52.6, -306.2 → 294.3, 49.5, -251.6
Uncaught = 无
树里 vertices 行 = 1
```

`check.ps1` **7 项全 PASS**。


**1.0.1.3（续 13）** — 拷贝提速 + 顶点信息改直填

**① 拷贝慢的根因与优化**

原来一次拷贝要遍历三遍：
1. `createLayer` 里 `countUniqueVerts`（算点数）
2. `createLayer` 里 `bboxOf`（算包围盒）
3. `extractVertices` 里再建一次 `Map<string>`（算去重顶点）

72.7k 面 = 21.8 万次字符串拼接 + Map 写入 + GC，几百毫秒起。

改为**一次遍历出三样**（`render.analyzeMesh`）：

| 项 | 说明 |
|---|---|
| 判重方式 | 数值哈希 `(kx*73856093)^(ky*19349663)^(kz*83492791)`，冲突时比对真实坐标 |
| 产物 | `vertCount` + `bbox` + `uniqVerts`，全部挂到 `data` 上 |
| 时机 | 只在 `createLayer` 跑一次，之后树显示 / 顶点云拷贝 / 上传显存全部复用 |
| 拷贝成本 | **零遍历**，直接把 `data.uniqVerts` 交给新图层 |

**② 顶点信息改为直接填充**

`renderProps()` 里那段「顶点预览分支」依赖 `renderProps` 被正确调用，实测在部分时序下没走到。改为把填充逻辑抽成 **`ui.showVertexInfo(layer)`**，由 `App.previewVertices()` 直接调用 —— 不再依赖 `renderProps` 的分支判断。

**③ 清理调试钩子**

`?clickverts=1`（模拟 DOM 点击）在 headless 下拿到的 `.ghost-child` 可能是重绘前的旧节点，结果不可信，已删除。保留两个可复现入口：

| 参数 | 行为 |
|---|---|
| `?preview=1` | 直接进顶点预览态（等价于点 vertices） |
| `?mkverts=1` | 直接拷贝顶点云 |

**验证**：

```
?mkverts=1   vertices 出现，38.4k 点，err=0
?preview=1   vi-src=m / vi-count=38,437 / vi-bbox 有值，err=0
check.ps1    7 项全 PASS
```

**缓存后缀**同步到 `?v=1.0.1.3k`（这一轮改了 `app.js` / `ui.js` / `render.js`，不硬刷新会继续跑旧代码）。


**1.0.1.3（续 14）** — 修点击 vertices 报错 / 对侧拷贝不显示

**问题 1：点 vertices 底部报 JS 错误**

`renderTree` 的 `emitRow` 里，`kids` 被用在声明之前：

```js
children.appendChild(row);

var vKids = (kids || []).filter(...)   // ← 此处 kids 是 undefined（var 提升）
...
var kids = byParent[layer.id];          // ← 509 行才赋值
```

`var` 提升让 472 行的 `kids` 恒为 `undefined`，于是：

- 判断“是否已有顶点云”永远为假 → 已经有 `vertices` 子图层时仍会再插一个占位行
- 后面的 `kids.forEach(...)` 与实际分组数据错位，点击占位行时触发的重绘在这套错乱结构上执行，抛异常

**修法**：在 `emitRow` 开头统一取一次 `var myKids = byParent[layer.id] || [];`，占位判断与子行渲染都用它；后续 `if (kids.length)` 复用同一数组。

**问题 2：拷贝到对侧后要手动折叠再展开才看得见**

`extractVertices(slot)` 之后确实调了 `refreshTree()`，但目标 slot 的分组若处于**折叠状态**（`collapsed[slot] === true`），新图层就在隐藏的 `tree-children` 里，视觉上等于没拷贝。

**修法**：新增 `ui.expandSlot(slot)`，拷贝前后展开目标分组：

```js
if (global.MV.ui.expandSlot) { global.MV.ui.expandSlot(slotOut); }
global.MV.ui.refreshTree();
```

快路径与慢路径都加（顺带补了快路径缺失的 `var slotOut` 定义，否则会 ReferenceError）。

**验证**（`?clickverts=1` 模拟真实 DOM 点击，且由 `renderTree` 末尾同步触发，不依赖定时器）：

```
点击 vertices  →  err=0，无 JS 错误
                   vi-src=m / vi-count=38,437 / vi-bbox 有值
                   ghost 占位行 1 个
拷贝后         →  lname: m | vertices，lmeta: 38.4k 点
                   ghost 占位行 0 个（已有子图层，自动收起占位）
check.ps1      →  7 项全 PASS
```


**1.0.1.3（续 15）** — 修 refreshTree 不存在导致的点击报错

**现象**：点 `vertices` 后底部显示

```
JS 错误: Uncaught TypeError: global.MV.ui.refreshTree is not a function @ app.js:396
```

**根因**：`MV.ui` 导出的名字是 `renderTree` / `renderProps`，但 `app.js` 里有 5 处写成了 `refreshTree` / `refreshProps`：

| 行 | 位置 |
|---|---|
| 396 | `previewVertices()` |
| 463 / 464 | `extractVertices()` 快路径 |
| 534 / 535 | `extractVertices()` 慢路径 |

`refreshTree` 不存在 → 调用即抛 `TypeError` → `previewVertices` 中断在刷新树这一步。

**为什么我之前一直"看到"没问题**：状态栏 `#st-info` 同时被 debug 文本（`dbg meshA=0 …`）每帧覆盖，JS 错误只闪现一瞬；我用 dump 抓到的都是后面的 debug 文本，判定成 `err=0`。这是验证方法本身的漏洞。

**修法**：

1. 5 处改名为 `renderTree` / `renderProps`（残留检查 = 0）
2. 全局错误处理里**额外 `console.error('JSERR @ 文件:行 -> 消息')`** —— console 不会被覆盖，`--enable-logging=stderr` 可稳定捕获

**验证**（抓 stderr 里的 `JSERR`，不靠状态栏）：

```
clickverts    JSERR: none    lname: m | vertices    vi-src=m  vi-count=38,437
mkverts       JSERR: none    lname: m | vertices
check.ps1     7 项全 PASS
```


**1.0.1.3（续 16）** — 拷贝出的顶点云不显示

**现象**：右键拷出 `vertices` 后，窗口里什么也没有，改颜色也没反应。

**根因**：`uploadLayer()` 只在两个地方被调用 —— `addFiles()`（导入）和 `copyLayerToSlot()`（拷贝到对侧）。`extractVertices()` 手工 `push` 进 `layers` 的图层**从未上传到 GPU**，于是：

```js
// 绘制列表构建
if (!lay.visible || !lay.gpu) { continue; }   // ← gpu 为 null，直接跳过
```

图层在树里存在、属性面板也能改，但渲染层永远不画它 —— 这就是“改配色没用”的原因。

**第二个问题**：即便上传成功，点云也看不见。`drawPoints` 里 `uDepthBias = 0.0`，而顶点与网格表面**完全共面**，深度相等时点被网格面挡住（网格先画、写深度）。实测截图确认：模型上没有任何点。

**修法**：

1. `extractVertices()` 两条路径在 `push` 之后补 `this.renderer.uploadLayer(layer)`
2. `drawPoints()` 对 `format === 'vertices'` 的图层用正向深度偏移：

```js
var pBiasV = (layer.data && layer.data.format === 'vertices') ? 0.00035 : 0.0;
gl.uniform1f(this.pointU.uDepthBias, pBiasV);
```

3. 新增 `App.applyVertexCloudStyle(lay)`：青色 `#22d3ee` + 点径 2，与橙色网格明确区分（原来沿用 `pickColor('B')` 的橙红，和模型几乎同色，叠上去只像“变色”）

**踩的坑**：第一次改 bias 改到了 `drawPreviewSeg`（预览高亮）里，那里没有 `layer` 变量，会引入 ReferenceError；已回滚并改到 `drawPoints` 正确位置。

**验证**（`?mkverts=1` 截图）：模型上覆盖清晰的青色点云层，与橙色网格对比明确；树里可单独勾选显隐；`check.ps1` 7 项全 PASS。

> 说明：顶点密度等于网格顶点密度（38,437 个铺满表面），视觉上会盖住整个模型，这是几何决定的，不是渲染问题。


**1.0.1.3（续 17）** — 点云属性不应出现网格专有项

**现象**：选中点云（含拷出的 `vertices`）时，属性面板里仍有「背面 / 线框 / 顶点 / 边界」颜色和「显示（网格）」整组。

**根因**：`renderProps()` 早就按 `data-prop` 做了类型过滤：

```js
var show = (kind === 'base') ||
           (kind === 'mesh' && layer.kind === 'mesh') ||
           (kind === 'points' && layer.kind === 'points');
r.classList.toggle('show', !!show);
```

但 CSS 有一条更强的规则把它压掉了：

```css
#props .prop-row { display: grid; ... }   /* 特异性 (1,1,0) —— id 选择器 */
.prop-row.show   { display: flex; }       /* (0,2,0) —— 比不过 */
.prop-row        { display: none; }       /* (0,1,0) */
```

`#props .prop-row` 里写了 `display: grid`，特异性高于 `.show` 的显隐控制，于是**所有行无条件显示**，`data-prop` 过滤形同虚设。

**修法**：把 `display` 交给 `.show` 决定，布局属性留在原规则：

```css
#props .prop-row { grid-template-columns: 66px minmax(0, 1fr) auto; ... }  /* 去掉 display */
#props .prop-row.show { display: grid; }

#props .prop-row.col { ... }              /* 去掉 display: block */
#props .prop-row.col.show { display: block; }
```

**验证**（两张截图对比）：

| 选中 | 属性面板 |
|---|---|
| **网格** | 属性 / 外观（配色、不透明度）/ **显示（网格）**：面片·线框·顶点·边界、顶点大小 / 着色 |
| **点云** | 属性 / 外观（**配色**、不透明度）/ 着色（模式、点大小）—— 无线框、顶点、边界、法向 |

另外加了 `?selone=1`（选中首个图层）便于截图核对。

`check.ps1` **7 项全 PASS**。


**1.0.1.4** — 应用裁剪后释放源图层显存

**问题**：`applySplit()` 之后源图层只是 `visible = false`，GPU 上的 VAO / 顶点缓冲 / 索引缓冲全留着。裁几刀下来，显存被一堆“看不见的图层”占着。

**改法**：

1. `algo.applySplit()` 在 `src.visible = false` 之后发一次 `hooks.releaseGpu(src)`
2. `app` 注入该 hook：

```js
releaseGpu: function (layer)
{
    global.MV.app.renderer.releaseLayer(layer);   // 删 VAO / buffer，gpu 置 null
}
```

3. **补齐重新显示的通路**：`uploadLayer()` 原本只在导入与拷贝到对侧时调用，显存一释放，再勾选“可见”就会是空图层。现在树里的可见性复选框在 `gpu` 为空时补一次上传：

```js
if (!layer.gpu && app.renderer && !layer._uploadFailed)
{
    app.renderer.uploadLayer(layer);
}
```

`data.positions` 一直留在内存里，所以这是“按需重建”，不丢数据。

**验证**（`?demo=seg&segapply=1`，读释放标记）：

```
REL m gpu=null                       ← 源图层显存已释放
树：m | m_segmented | vertices | m_remaining   ← 图层与几何数据都还在
check.ps1 7 项全 PASS
```


**1.0.1.4（续）** — 代码 review 后的六项优化

体检基线（10,664 行 / 8 模块）：`core / io / algo` 三层 `document=0`、`gl=0`、`MV.ui=0` 完全干净；问题集中在超长函数、重复 DOM 重建、`render` 层的两处越界。

| # | 优化 | 前 | 后 |
|---|---|---|---|
| 1 | `ui.refreshUI()` 合并成对刷新，`app` 里 10 处 `renderTree + renderProps` 改为一次调用 | 每次操作建两遍 DOM | 一遍 |
| 2 | `$()` 加元素缓存（`isConnected` 兜底） | `renderProps` 每次查 ~40 次 `getElementById` | 命中缓存 |
| 3 | `ui.init()` 按区域拆分 | **593 行** | **14 行** + 5 个 bind（76 / 202 / 76 / 86 / 117） |
| 4 | `render.js` 去掉 `MV.ui` 直连，走 `renderHooks` | 2 处越界 | **0** |
| 5 | `renderTree()` 加结构签名缓存 | 无条件整树重建 | 字段未变即跳过 |
| 6 | `installGizmoMethods()` 工具函数提升到模块级 | **475 行** | **213 行**（+ 262 行纯工具函数） |

**顺带修的一个真 bug**：`render.js` 的 `bindRenderHooks()` 也是 `for (var k in renderHooks)` —— 只遍历自身，新增 hook 永远注入不进来（与当初 `algo.js` 的坑一模一样）。已改为遍历传入对象。

**为什么 `installPickMethods`（429 行）没拆**：函数体内有 30+ 个连续计算的共享局部变量（Möller–Trumbore 求交的 `e1x/px/det/inv/u/v/t` 等），拆开必须改成参数传递或对象状态，收益为零而风险很高。已在注释里标明。

**分层复查**：

```
core / io / algo   MV.ui:0  document:0  gl:0
render             MV.ui:0  document:0  gl:466    ← 本次达标
ui                 MV.ui:4  document:87 gl:0
app                MV.ui:86 document:16 gl:0      ← 原 95，合并后减少
```

`check.ps1` **7 项全 PASS**（每步单独回归）。

> 说明：拆分函数不会减少总行数（函数头反而多 10 行），收益在于单函数可读性与定位成本。


**1.0.1.5** — 目录改名 viewer3d → 3DViewer

工程目录从 `viewer3d` 改为 `3DViewer`，同时把散落在文档与提示里的旧路径一并更新。

| 项 | 说明 |
|---|---|
| 内层仓库 | `3DViewer/.git` 随目录移动，`git log` 与全部历史完整保留 |
| 外层仓库 | `.gitignore` 里 `viewer3d/` → `3DViewer/`，继续保持隔离（外层不跟踪本目录） |
| 启动脚本 | `serve.bat` 用 `%~dp0`、`server/start_bridge.bat` 用 `cd /d "%~dp0"`，无需改动 |
| 服务端 | `serve.py` 用 `os.path.dirname(os.path.abspath(__file__))` 定位静态根，不依赖当前工作目录 |
| exe 定位 | `bridge.py` 以 `OptimizeHole2D` 为项目根（不含 viewer3d），不受影响 |
| 文案 | `README.md`、`CHANGELOG.md`、`plugins/optimize.js` 报错提示、`serve.py` 注释同步更新 |
| 特意保留 | `app.js` 里 `localStorage` 键仍为 `'viewer3d.theme'` —— 只是键名，改了会丢用户已选的主题 |

改名后自检：

```
关键文件 16 个全部在位
check.ps1  7 项全 PASS（base / single / pick / segment / boundary / mempopup / cull-parity）
/health    ok=True exists=True mode=same-origin
           exe = ...\HoleOptimize\build\Release\HoleOptimize_cli.exe
index.html HTTP 200 len=26247
```

服务从任意工作目录启动都正常，说明路径解析全部是动态的。


**1.0.1.6** — README 改为发布形态

仓库开源发布，README 从「开发手册」改为「对外说明」，原详细内容整体移入 `docs/GUIDE.md`。

| 项 | 改前 | 改后 |
|---|---|---|
| README | 474 行开发文档 | **177 行**：简介、特性、快速开始、界面、操作、格式、目录、环境要求 |
| 详细手册 | 混在 README 里 | `docs/GUIDE.md`（564 行，内容不变） |
| 配图 | 无 | `docs/images/overview-dark.png`、`overview-light.png`（各约 115~120 KB） |

**同时修一个真 bug**：`?single=1` 参数不生效。

```js
// 原来在 ui.init 之前调用，setSingleView 内部要调 ui.applyLayoutMode，此时 UI 还没建立
if (params.get('single') === '1') { this.setSingleView(true); }
global.MV.ui.init(this);
```

已调整为先 `ui.init`、再 `setSingleView`，`?single=1` 现在能正确切到单窗。

README 里所有功能描述都逐条对照代码核实过：`?maxtri` / `?maxpts` 参数、`Ctrl+Z` 撤销、`f` / `w` / `n` / `p` / `Delete` 快捷键、双击图层聚焦、侧栏 220~620px 拖拽范围。


**1.0.1.6（续）** — 双窗并排对比与配图

README 的核心卖点从「网格 vs 点云」校正为「**两份数据并排对比**」，并补齐两个能复现该场景的 URL 参数。

**① `?url2=` / `?slot2=` 双文件加载**

```js
this.loadFromUrl(autoUrl, pickSlot(params.get('slot'), 'B')).then(function ()
{
    if (autoUrl2) { return selfU.loadFromUrl(autoUrl2, pickSlot(params.get('slot2'), 'A')); }
});
```

**必须串行**：`addFiles` 内部共享进度条与图层状态，第一版写成并行时 `m.stl` 被 `m_points` 覆盖，树里只剩「左侧 A 0 层」。

**② `?target=x,y,z` 定点放大**

`?zoom=` 原本就有（在 `mv:loaded` 里乘相机距离），缺的是指定看向哪里。补上 `target` 后可以把镜头压到孔洞密集的中段：

```
index.html?sync=1&url=m.stl&slot=A&url2=m_points.xyz&slot2=B
            &noconfirm=1&selone=1&zoom=0.1&target=-120,0,-279
```

顺带给 `mv:loaded` 处理加了**一次性标志**——双文件加载会触发两次事件，不加的话 `zoom` 会被乘两遍。

**③ 配图**

| 文件 | 内容 | 体积 |
|---|---|---|
| `dual-window.png` | 双窗：左网格（蓝）/ 右点云（橙），`sync=1` 同角度，放大到孔口级 | 124 KB |
| `overlay-mesh-points.png` | 同屏叠加：两者重合在单一视口 | 176 KB |
| `overview-dark.png` / `overview-light.png` | 单窗全景，深浅两套主题 | 各约 120 KB |

对比图的数据不从外部引入：直接从 `m.stl` 按 1e-4 量化提取 38,437 个唯一顶点生成 `xyz`，保证左右天然对应。

放大到 `zoom=0.1` 后能看出两者的表示差异——网格是连续的面、点云是离散点阵，孔壁边缘由点排成锯齿。


**1.0.1.7** — 补充 MIT 许可证

仓库对外开放，补上许可证文件。

| 项 | 内容 |
|---|---|
| 许可证 | **MIT** |
| 版权人 | `Copyright (c) 2026 WooChi`（与 git 提交身份一致，不使用真实姓名） |
| 文件 | 根目录 `LICENSE`（无扩展名，GitHub 会自动识别并在仓库页显示标签） |
| README | 末尾新增 `## License` 章节，指向 `LICENSE` |

**为什么选 MIT**

- 项目**零第三方依赖**（无 npm、无构建），不存在许可证兼容问题
- 纯前端 JS，代码本身就是源码，GPL 那套「强制开源」在这里没有实际收益
- `algo.js` 里的三角求交、空间索引、裁剪都是常规算法（Möller–Trumbore、八叉树等），**不构成专利**，无需 Apache-2.0 的专利条款
- 孔位优化仅作为插件调用外部 `HoleOptimize_cli.exe`，**仓库内没有任何相关代码与产物**，不影响本仓库许可
- 使用者可能包括同事与客户，MIT 不给他们增加开源义务

**未考虑的方案**：GPL-3.0 会劝退商业集成且前端传染范围界定模糊；Unlicense / CC0 放弃过于彻底，无法阻止他人拿代码注册商标。


**1.0.1.8** — 标量场：双范围拖动 + 越界值处理

图层属性里的标量场范围条原来是只读直方图，现在可以直接拖动。

**① 两套范围**

| 范围 | 作用 | 手柄 |
|---|---|---|
| **显示范围**（display） | 决定哪些值算「越界」 | 范围条顶部的青色三角 |
| **颜色范围**（saturation） | 色带在这段区间上铺满 | 贯穿全高的白色竖线 |

按 ParaView 的语义分离：显示范围管「画不画」，颜色范围管「怎么上色」。这样可以把色带压缩到关心的子区间，同时仍保留两端的数据作为位置参照。

**② 越界值的两种处理**

| 模式 | 效果 |
|---|---|
| **半透明灰** | 越界点画成淡灰（`alpha × 0.55`），保留位置参照 |
| **不显示** | 越界点在片元着色器里 `discard` |

**③ 实现**

着色器拆成两套 uniform，顶点着色器输出越界标记，片元着色器据此决定丢弃或降透明度：

```
uSFMin/uSFMax  → 显示范围，越界判据
uSCMin/uSCMax  → 颜色范围，色带映射
uOutMode       → 1 半透明灰 / 2 不显示
vOut           → VS 输出 0/1，FS 读
```

拖动交互：三角手柄只在范围条上 30% 高度内响应，竖线全区可抓；就近命中，避免两者重叠时抢事件。拖动时只重绘 canvas 与视图，不重建属性面板。

**④ 修的一个作用域 bug**

范围参数解析最初写成：

```js
function pf(k) { var v = parseFloat(params.get(k)); ... }
```

这段代码位于 `addFiles()` 内，而 `params` 是 `init()` 的局部变量 —— 作用域里没有它，`pf()` 一调用就抛 ReferenceError，把后面的 `sfMin/sfMax/sfOutMode` 赋值和调试输出全部中断。表象是「参数设了但完全无效」。改用 `new URLSearchParams(location.search)` 后正常。

**⑤ 新增 URL 参数**（便于分享与验证）

```
?pcm=5                                   标量场着色
&sfmin=25&sfmax=55                       显示范围
&sfcolmin=30&sfcolmax=50                 颜色范围
&sfout=1                                 越界：1 半透明灰 / 2 不显示
```

**⑥ 验证**

同一份点云（38,437 点，标量 `height` 10~70）分别用两种越界模式渲染，3D 视口差异 436 个采样点：

```
sfout=1  彩色带 + 两侧半透明灰
sfout=2  仅彩色带，两侧彻底消失
check.ps1 7 项全 PASS
```


**1.0.1.8（续）** — 范围条显示修正

第一版范围条在面板里显示不对，逐项修正：

| 问题 | 原因 | 修法 |
|---|---|---|
| 柱子像竖条纹 | 每根柱宽 `bw - 1`，200px 显示 30 根时缝隙占 1/6 | 改为 `bw + 0.6` 无缝相接 |
| 画面发灰、边缘有暗块 | 背景用 `rgba(0,0,0,0.28)` 半透明，导出/合成后偏灰 | 改为不透明 `#12161c` |
| 手柄只剩半个 | 显示范围为全量程时手柄落在 `x=0` / `x=W`，被画布裁掉 | 左右各留 9px 内边距，`px()` 与拖动反算同步换算 |
| 颜色范围竖线看不见 | 纯白 2px 线压在浅色柱子上 | 先画 3px 半透明黑描边，再画白线 |
| 分辨率与显示尺寸不匹配 | 固定 440×104，被 CSS 压到约 200px 宽 | 按 `clientWidth × 2` 动态设置分辨率 |

另外直方图行标题从「分布」改为「范围」，与它的新用途一致。

`check.ps1` 7 项全 PASS。


**1.0.1.8（续 2）** — 范围条浅色主题适配

范围条是 canvas，配色写在绘制代码里，不会随 CSS 变量变化 —— 浅色主题下一直是深色底。

**改法**：`drawHist` 开头按主题取一组颜色。

```js
var light = !!(global.MV.app && global.MV.app.settings && global.MV.app.settings.themeLight)
         || document.body.classList.contains('theme-light');
```

| 元素 | 深色 | 浅色 |
|---|---|---|
| 画布底色 | `#12161c` | `#eef1f5` |
| 范围外遮罩 | `rgba(0,0,0,0.50)` | `rgba(255,255,255,0.66)` |
| 颜色范围竖线 | 白 `0.96` | 深 `rgba(22,28,36,0.92)` |
| 竖线描边 | 黑 `0.75` | 白 `0.90` |
| 分隔线 | 白 `0.32` | 黑 `0.22` |
| 三角手柄 | `#22d3ee` | `#0891b2`（加深，浅底上更清晰） |

**另一个坑**：`setTheme()` 末尾只调了 `markDirty()` 重绘 3D，属性面板里的 canvas 完全没刷新 —— 切主题后范围条保持旧配色。已补一次 `ui.renderProps()`。

顺手修了 CSS 里一条写错的选择器：用的是 `[data-theme="light"]`，而实际主题 class 是 `body.theme-light`，这条规则从来没生效过。

`check.ps1` 7 项全 PASS。


**1.0.1.8（续 3）** — 显示范围与颜色范围分成两行

原来只有一个「范围」输入行，对应的只是显示范围；颜色范围只能拖动范围条上的竖线，没法精确输入。

现在拆成两行，各自独立：

```
字段      [height [10.000 ~ 70.000] ▾]
显示范围  [10.000] [70.000] [自动]      ← 小于/大于即越界，按「越界值」处理
颜色范围  [10.000] [70.000] [跟随]      ← 色带在这段区间上铺满
色带      [蓝-青-绿-黄-红 ▾]
范围      ┌ 直方图 + 双手柄 ┐            ← 两行输入与拖动双向同步
越界值    [半透明灰 ▾]
```

| 按钮 | 行为 |
|---|---|
| 显示范围「自动」 | 清空两个输入，回到数据全量程 |
| 颜色范围「全量」 | 清空两个输入，颜色范围用数据全范围 |

**双向同步**：拖范围条上的三角 / 竖线会实时写回对应输入框；在输入框里改数值会立即重绘范围条与视图。

校验：颜色范围上限必须大于下限，非法输入会在状态栏提示且不写入图层。

`check.ps1` 7 项全 PASS。


**1.0.1.8（续 4）** — 拖动三角不再改写颜色范围

**现象**：拖范围条的显示范围三角时，颜色范围会跟着变；「跟随」状态被破坏，而且左右两个方向表现不一致。

**根因**：拖动逻辑里有一段「把落在显示范围外沿的颜色范围夹回来」：

```js
if (drag === 'dmin' || drag === 'dmax')
{
    if (typeof nd.lay.sfColMin === 'number' && nd.lay.sfColMin < nd.dmin)
    {
        nd.lay.sfColMin = nd.dmin;      // 把 null 变成了固定值
    }
    ...
}
```

颜色范围原本是 `null`（表示跟随显示范围），但拖动三角时被写成了具体数值 —— 从此再也不是「跟随」。往左拖时刚好没触发夹取、往右拖触发了，所以表现不一致。

**改法**：删掉整段夹取。拖动三角只改 `sfMin / sfMax`，颜色范围完全不动 —— 它要么保持 `null`（跟随显示范围），要么保持用户显式设定的值。

**实测**（模拟真实 mousedown/mousemove/mouseup）：

```
初始        sfMin=null      sfColMin=undefined
拖左三角后   sfMin=33.6      sfColMin=undefined    ← 未改动
拖回左侧     sfMin=12.6      sfColMin=undefined    ← 仍是跟随
输入框      显示=12.568     颜色=(空)
```


**1.0.1.8（续 5）** — 颜色范围彻底独立于显示范围

上一轮只是让 `sfColMin/sfColMax` 保持 `null` 不被写入，但绘制与着色时把 `null` 解析成「当前显示范围」—— 所以竖线看起来仍然跟着三角走，颜色映射也跟着缩放。

**语义改成**：颜色范围留空 = **数据自身全范围**，与显示范围无关。

```js
// ui.js 绘制
var cmin = (typeof lay.sfColMin === 'number') ? lay.sfColMin : sf.min;   // 原来 fallback 到 dmin
var cmax = (typeof lay.sfColMax === 'number') ? lay.sfColMax : sf.max;

// render.js 着色
scMin = (typeof layer.sfColMin === 'number') ? layer.sfColMin : sf.min;  // 原来 fallback 到 sfMin
scMax = (typeof layer.sfColMax === 'number') ? layer.sfColMax : sf.max;
```

按钮文案从「跟随」改为「**全量**」，placeholder 同步为「全量」，避免歧义。

**实测**（模拟拖三角，对比拖动前后的 canvas 像素）：

```
拖动前   竖线 x = 8, 540      sfMin=null     sfColMin=undefined
拖动后   竖线 x = 8, 540      sfMin=36.75    sfColMin=undefined
```

竖线位置与颜色映射完全不动，只有显示范围（暗罩、越界判定）在变。


**1.0.1.8（续 6）** — 顶栏加「适应」按钮

顶栏在「截图」之后新增 **适应**，按当前数据铺满视口。

```
载入 | 双窗 | 截图 | 适应 | 清空 | 插件 ▾ | 工具 ▾
```

调用的还是原有的 `fitAll()`（快捷键 `f` 同一个入口）：单窗时适配主相机，双窗时两个视口各自适配。

**实测**（先 `?zoom=0.25` 把视图放大到超出画面，再点按钮）：

```
缩放过      distance = 74.5
点击适应后   distance = 297.9     ← 回到铺满
状态栏       视图已按当前数据铺满
```


**1.0.1.9** — STL 导入提速

**定位**：STL 导入卡顿的主因是「同一份顶点被去重了两次」，第二次还是最慢的字符串哈希。

```
parseBinarySTL    DataView 逐顶点读取（约 65 万次 getFloat32）
createLayer       analyzeMesh：数值哈希去重（72.7k 面实测 16ms）
uploadLayer       buildIndexed(weld=true)：字符串哈希再去重一遍  ← 卡顿源
```

`buildIndexed` 里每个顶点拼一个 `'x,y,z'` 字符串做 Map 键：

```js
var key = Math.round(x * Q) + ',' + Math.round(y * Q) + ',' + Math.round(z * Q);
```

21.8 万个顶点 = 21.8 万次字符串拼接 + Map 写入 + GC，在主线程同步执行，造成数百 ms 的明显卡顿。

**修复（三处）**：

1. `analyzeMesh` 额外返回 `remap`（`Uint32Array`，每个输入顶点 → 去重后下标）
2. `createLayer` 把 `remap` 挂到 `data` 上
3. `uploadLayer` 焊接时直接 `{ verts: uniqVerts, idx: remap, vcount: vertCount }`，**跳过 buildIndexed**
4. `buildIndexed` 的字符串哈希兜底改成与 `analyzeMesh` 一致的数值哈希（冲突时逐点比对坐标）

这样 STL 的去重只做一次（数值哈希，16ms），渲染用的索引与树显示的点数完全同源。

**验证**：`analyzeMesh` 纯同步实测 16ms（72,694 面）；`check.ps1` 7 项全 PASS。

> 说明：headless 下用 `performance.now()` / `Date.now()` 测总耗时不可靠——`--virtual-time-budget` 会快进 `await`（分块读取、`yieldToUI`），导致计时失真。因此只对纯同步的 `analyzeMesh` 做了计时。


**1.0.1.9（续）** — 清理死代码

函数级扫描（出现次数 == 定义次数的候选）逐一核对后，删除了 5 个确认无引用的函数：

| 文件 | 删除 | 原因 |
|---|---|---|
| `render.js` | `bboxOf` | 返回数组格式 `[minx..maxz]`，早已被 `{min,max}` 对象取代，只剩导出无调用 |
| `render.js` | `countUniqueVerts` | 字符串 `Set` 去重；`createLayer` 已用 `analyzeMesh` 算好 `vertCount`，`uploadLayer` 里的调用是死路径 |
| `algo.js` | `deviceRect` | 无调用 |
| `algo.js` | `splitPoints` | 旧的点云按矩形选区拆分，已被 `splitPointsByPlanes`（棱柱平面）取代 |
| `core.js` | `expandArray` | `BBox` 对象方法，无调用 |

同时删除了 `global.MV.render.bboxOf / countUniqueVerts` 两个导出，并把 `uploadLayer` 里那条死路径兜底从 `countUniqueVerts(d.positions)` 简化为 `Math.floor(length / 3)`（`createLayer` 保证 `vertCount` 已存在，这条几乎不会走到）。

合计 **-123 行**（`render.js` -11、`algo.js` -67、`core.js` -16、其余为 1.0.1.9 的提速改动）。

`check.ps1` 7 项全 PASS。


**1.0.1.9（续 2）** — STL 解析小文件一次读入

`parseBinarySTL` 原来固定每 20000 三角形切一块读取，每块之间走一遍 `file.slice()`（Blob 复制）+ `yieldToUI`（`setTimeout 0`）+ 进度回调。

对几 MB 的 STL 纯属浪费：72.7k 面（3.6MB）要切 4 块、调 4 次 `slice`。现在：

```js
var chunkTri = (file.size <= 8 * 1024 * 1024) ? Math.max(20000, total) : 20000;
```

小文件一次 `readSlice` 读完整个顶点区，循环只跑一轮；大文件仍分块，保留内存峰值控制与进度反馈。

`check.ps1` 7 项全 PASS。


**1.0.1.9（续 3）** — 裁剪工具未选中图层时自动选中

**现象**：没在场景树里选中图层时点「裁剪」，工具看起来没反应。

**根因**：`setMode()` 里未选中就 `mode = null` 直接退出，只在状态栏留一句「请先选中…」，提示转瞬即逝，用户感知为「工具坏了」。

**改法**：未选中时自动选中第一个可见的可裁剪图层（`mesh` / `points`），再进入裁剪模式；仅当完全没有可裁剪图层时才提示「请先导入」。

```js
if (!layer)
{
    for (var i = 0; i < a.layers.length; i++)
    {
        var cand = a.layers[i];
        if ((cand.kind === 'mesh' || cand.kind === 'points') && cand.visible !== false)
        {
            layer = cand;
            a.selectLayer(cand.id);
            break;
        }
    }
}
if (!layer) { say('请先导入要裁剪的网格或点云'); ... return; }
```

**实测**（不选中 → 点裁剪）：

```
初始 selectedId = null
点击裁剪后 mode = rect、selectedId = 1
```

网格裁剪全链路（点击 → 框选 → 预览 → 应用 → 生成 segmented/remaining）也已用探针实测通过。


**1.0.1.9（续 4）** — 拾取十字在缩放视角时大小不一致

**现象**：拾取多个点后缩放视角，几个交叉十字的大小不一样。

**根因**：`drawPickMarks(mvp, marks, len)` 用**同一个世界尺寸** `len` 画所有标记的十字，而 `len` 是按「相机到视口中心（target）」的距离换算的。标记分布在模型不同深度，各自到相机的距离不同，投影到屏幕后自然近大远小。

**改法**：十字改为屏幕空间尺寸——每个标记按「自身到相机的距离」独立换算 per-pixel 世界长度：

```js
// drawPickMarks(mvp, marks, eye, fov, vh, baseLen, minPx)
var k = 2 * Math.tan(fov * 0.5) / Math.max(vh, 1);
for (var i = 0; i < n; i++)
{
    var p = marks[i].pos;
    var dist = 相机到 p 的距离;
    var len = Math.max(baseLen, k * dist * minPx);   // 每个标记独立
    ...
}
```

`baseLen`（1 mm，足够近时按真实尺寸显示）与 `minPx`（6 px，远距离保底）的语义不变。

**实测**（`?demo=pick` 自动拾取 3 个不同深度的点，`?zoom=0.25` 缩放）：

```
P1 黄  x 宽 7 px
P2 绿  x 宽 7 px
P3 蓝  x 宽 7 px（颜色阈值测得 5 px，特写确认与 P1/P2 一致）
```

三个十字屏幕大小一致。`check.ps1` 7 项全 PASS（含 pick 场景）。


**1.0.1.9（续 5）** — 裁剪模式按钮重复点击不再退出

**现象**：进入裁剪后，再点一次编辑栏的「矩形选择」会退出裁剪状态。

**根因**：编辑栏按钮绑的是 `toggleMode('rect')`，其实现是 `setMode(mode === m ? null : m)` —— 已在 rect 时再点等于 `setMode(null)`，即退出。

**改法**：

```js
// 按钮绑定：toggleMode -> setMode（切换到目标模式，不再 toggle）
on('seg-btn-rect', function () { A.setMode('rect'); });
on('seg-btn-poly', function () { A.setMode('poly'); });

// setMode 幂等：已是目标模式则直接返回，避免清空已有选区
function setMode(m) {
    if (mode === m) { return; }
    ...
}
```

**实测**：

```
点「裁剪」      mode = rect
点「矩形选择」  mode = rect   ← 保持
再点「矩形选择」 mode = rect   ← 保持
点「多边形选择」 mode = poly   ← 切换
切回「矩形选择」 mode = rect   ← 切回
```

退出裁剪仍靠「退出裁剪」按钮或 Esc（`setMode(null)`）。


**1.0.1.9（续 6）** — 导入新数据不再改变相机视角

**现象**：导入第二个数据时，相机会跳去适配新内容，打断正在看的画面。

**根因**：`loadOne()` 里用「**该视图此前是否为空**」判断要不要适配：

```js
var before = [B.valid(computeBBox(views[0].slots)), B.valid(computeBBox(views[1].slots))];
if (!before[0]) { this.fitView(0, false); }   // 视图 0 原来没数据 → 适配
if (!before[1] && !singleView) { this.fitView(1, false); }
```

双窗下往「原本空着的那一窗」导入，该窗就会重新适配；单窗时若先前的 slots 组合不同也会触发。

**改法**：判断标准改为「**导入前是否完全没有图层**」，只有首次导入才适配：

```js
var wasEmpty = this.layers.length === 0;

// 仅在首次导入时自动适配；之后导入保持当前视角
if (wasEmpty)
{
    this.fitView(0, false);
    if (!this.settings.singleView) { this.fitView(1, false); }
}
```

需要重新取景时点顶栏「适应」（或在双窗场景点对应视图的适应）。

**实测**（`?url=m.stl&url2=tiny.xyz&single=1`，第二个文件是位于 (1000,1000,1000) 的远端点云）：

```
图层 = m | tiny
相机 target = [131.2, 13.8, -285.6]   ← 仍停在 m.stl 的范围
判定 PASS — 相机保持第一个文件的视角
```


**1.0.1.9（续 7）** — 双窗叠加对面模型时的绘制顺序

**问题**：实体模式（`ghostMode=1`）下，`ghost` 也被塞进不透明列表，与主图共用一个列表，顺序完全由 `this.layers` 的**导入顺序**决定，主图和 ghost 是交错的。

而 `gl.depthFunc(gl.LEQUAL)` 的语义是「深度 ≤ 缓冲值即通过」，**同深度的后画者会覆盖先画者**。两者重合（点云叠在网格上、同一工件的两版数据）时，顺序直接决定谁可见。

以 `layers = [m@A, m@B]` 推导：

| 视图 | 修复前列表 | 实际效果 |
|---|---|---|
| 左（slots 含 A） | `[主A, ghostB]` | ghost 后画 → **叠加层压住主图** ✗ |
| 右（slots 含 B） | `[ghostA, 主B]` | 主图后画 → 正确 ✓ |

即两窗中恰好一窗是对的，具体哪窗错取决于导入顺序。

**改法**：`buildContext()` 里明确分两轮构建——先推 ghost，再推主图：

```js
// 第一轮：叠加的对面模型
for (...) if (!v.slots[l.slot] && ghost && l.slot !== 'S') list.push({ layer: l, ghost: true });
// 第二轮：本视图主图（后画 = 在上）
for (...) if (v.slots[l.slot]) list.push({ layer: l, ghost: false });
```

两个视图的主图本身不同（左 A / 右 B），因此列表内容顺序天然相反，但都满足「ghost 在前、主图在后」。

**实测**（`?url=m.stl&slot=A&url2=m.stl&slot2=B&ghostmode=1`，调 `buildContext()` 读实际列表）：

```
视图0: [ghost]m@B -> [主]m@A   PASS
视图1: [ghost]m@A -> [主]m@B   PASS
```


**1.0.1.9（续 8）** — 网格裁剪改为整体判定，不再切割面片

**原做法**：`splitMesh()` 对每个三角形用 `clipPoly()` 逐平面裁剪，再用 `emitPoly()` 扇形三角化。这会：

- 在选区边界处**插入交点顶点**，改变面片拓扑；
- 原三角形被切成多个小三角形，**面数增加**；
- 每个三角形都要走多边形裁剪 + 三角化，开销大。

**改法**：改为按**三角形质心**整体判定归属，原始三角形原样复制到一侧：

```js
var cx = (pos[o] + pos[o+3] + pos[o+6]) / 3;   // 质心
// 对所有平面满足 n·v <= d 即落在选区内
var dst = inside ? segOut : remOut;
dst.push(pos[o], ..., pos[o+8]);               // 三个顶点原样复制
```

- 顶点数恒等于 `面数 × 3`，**拓扑完全不变**；
- 面数守恒，不产生新顶点；
- 少了一层多边形裁剪与三角化，速度更快；
- 代价：选区边界以三角形为粒度（边界处整片三角形归入某一侧）。

点云本来就是逐点判定（`splitPointsByPlanes`），无需改动。

**顺带清理**：`clipPoly` / `pushTri` / `emitPoly` 已无调用，删除（-46 行）。

**实测**（`?demo=seg&segapply=1`，m.stl 共 111,009 面）：

```
seg 面数 = 64098
rem 面数 = 46911
合计     = 111009      ← 与原始面数完全相等
seg/rem 中不在原始顶点集合里的顶点：0 个
顶点数 = 面数 × 3 ：true
判定 PASS — 无新交点，拓扑未变
```

**1.0.2.0** — 裁剪判定、相机保持与叠加顺序

1. 裁剪模式按钮重复点击不再退出：`seg-btn-rect` / `seg-btn-poly` 从 `toggleMode` 改为 `setMode`，`setMode` 加幂等保护（已是目标模式则直接返回，不清空已有选区）
2. 导入新数据不再改变相机视角：判据从「该视图此前为空」改为「导入前完全没有图层」，仅首次导入自动适配
3. 双窗叠加顺序：`buildContext` 分两轮构建，ghost 先画、主图后画（`depthFunc` 为 `LEQUAL`，同深度后画者覆盖），保证每窗主图压在对面模型之上
4. 网格裁剪改为朴素整体判定：按三角形质心归属、原样复制顶点，不再切割面片（删除 `clipPoly` / `pushTri` / `emitPoly`）

**1.0.2.1** — 日志面板、单窗槽位与布局性能

1. 底部状态栏改为可展开日志面板：拖动或双击调整高度并记忆到 localStorage，历史保留 500 条带时间戳，按关键字分级着色（错误红 / 警告黄），清空与复制按钮浮在第一行右侧
2. 单窗模式下导入统一进公共槽位 S，不再被 BOTH 展开成 A/B 两份图层
3. resize 移出每帧 tick，改由 window.resize + ResizeObserver 驱动，消除每帧读取 clientWidth 造成的强制布局刷新

**1.0.2.2** — 配准工具：坐标变换 / 点对配准 / ICP / 对称检查

1. 坐标变换：4×4 矩阵可编辑并应用，同步改写 positions / normals / uniqVerts / bbox 并重建 GPU；点「反变换」用逆矩阵回到变换前；支持矩阵复制粘贴与单位阵复位
2. 手动点对配准：在参考层与目标层上交替点选，≥3 对后由 Horn 四元数法 + Jacobi 特征分解求刚体变换（4×4 对称矩阵精确求解，实测精度 1e-14）；画布选点用位移阈值区分「点击」与「旋转视角」
3. 新增 KD-tree（`js/kdtree.js`）：点数据只引用不拷贝，索引用 Int32Array，节点用平行类型化数组，查询状态放模块级避免闭包；提供 nearest / nearestIndex / radius
4. 新增 Symmetric ICP（`js/icp.js`）：参考 Rusinkiewicz《A Symmetric Objective Function for ICP》，每个对应点同时投影到目标法向与源法向，线性化后累加成 6×6 正规方程用 Cholesky 求解；无法向时退化为点到点
5. 对称翻转检查：对目标层做 X/Y/Z 镜像后各跑一次 ICP 比较 RMS，若镜像变体明显优于原始则判定疑似镜像件（Geomagic 的翻转检查思路）
6. 面板改为 Tab 布局（点对配准 / ICP / 对称检查），矩阵区常驻
7. ICP 拆成按轮驱动的状态机（`createSolver().step()`），界面每帧跑 2 轮后让出主线程，进度实时刷新，消除长时间同步计算导致的「页面无响应」

**修掉的两个关键 bug**

- `addRow6` 只填了 6×6 正规方程的**上三角**，而 Cholesky 读的是下三角，等于解了残缺的方程组 —— ICP 残差每轮指数级放大（4.9 → 4.6e19）。改为填满整个矩阵后立即收敛
- KD-tree 节点数组容量按 `2n/LEAF` 估算，而完全平衡树最坏接近 `4n/LEAF`；`Int8Array` 越界赋值是静默失败的，导致 `nodeDim[node]` 读到 `undefined`、`undefined < 0` 为假被当成内部节点，`nearestRec` 无限递归爆栈

**1.0.2.3** — 配准实时预览与交互调整

1. 配准实时预览：编辑矩阵、ICP 每轮迭代、对称检查都即时反映到视图。预览采用数据级变换（备份原始顶点 → 写入变换后顶点 → 重传 GPU），与「应用」走同一条路径；不用顶点着色器 uModel，因为那需要覆盖 mesh / wire / verts / normals / boundary / ghost / 透明 / 不透明七八条绘制路径，实测漏一条就会产生贯穿全屏的退化条纹且主图不显示
2. ICP 迭代可见与发散保护：改为每帧一轮 + 50ms 最小间隔（原来 setTimeout 下 40 轮几十毫秒跑完，只闪一两下）；残差超过数据尺度一半即判定未收敛，放弃结果并保持数据原位，避免平移累积把目标甩出视野
3. 变换严格限定为刚体：应用与预览都校验 3×3 正交性与 det = +1，拒绝缩放、切变与镜像
4. 对称检查改为旋转对称检测：绕世界 X/Y/Z 各转 90/180/270，施加旋转后直接度量残差而不再跑 ICP（ICP 有 6 个自由度，会把施加的旋转优化回去，导致任何角度都收敛到 0）；按数据尺度 1% 判定，输出该轴的对称重数
5. 坐标变换常驻侧栏标签页，与「图层属性」「视图设置」并列；修正参考/目标下拉的填充时机（点标签也刷新、树变更后同步）、放宽候选条件（不再要求 visible 与 kind 匹配）、无图层时下拉留空不显示箭头
6. 矩阵作用对象改为面板选定的目标层，两个下拉联动，场景树选中仅作兜底
7. 补 bbox 缺失防御：`BBox.valid` 空值保护 + `healBBoxes` 自愈。此前任一处 bbox 为 null 都会让整帧渲染抛错、画面冻结在上一帧（表现为"某个图层怎么都不显示"）

**途中修复的关键 bug**

- ICP / 对称检查用的是 `icpSample` 返回的数组引用，而数据级预览每轮都在改写同一份顶点 —— 等于让 ICP 追一个移动靶，残差卡在 13.8 永不收敛。改为持有独立副本
- `icpSample()` 返回的对象没有 `bbox` 字段，导致发散保护的分母恒为 0、形同虚设。改为从图层取

---

## 2026-11-11（周三）｜配准体系收口

**版本 `1.0.2.4`**

这一段的主线是「让自动粗配准真正可用」，中途推翻重写了三次。

### 粗配准

- **新增 `js/super4pcs.js`**（约 1.5k 行），按 nmellado/Super4PCS 逐函数翻译：
  `IndexedNormalSet3D`（位置网格 × 法向 7³ 分箱的双维度索引）、共面 4 点选取、
  `distSegmentToSegment` 求比值不变量、12 种配对枚举、`ExtractPairs` /
  `FindCongruentQuadrilaterals`、`Verify` 的增量早停、两侧减质心居中、迭代数按
  overlap 公式推导。对外只暴露「两个点云 + 参数结构体 → 4×4 刚体矩阵」，
  另提供 `createRegistration` 分步接口供界面按帧驱动。
- **为什么推翻自研版**：前两版都缺「法向分箱」这一维索引键。同一位置格子里混着
  各种朝向的点对，靠查询时点积过滤，召回率不足——表现为怎么放大 `pairLimit` /
  `hitLimit` 配额都搜不到正确构型。方向分箱是 Super4PCS 相对 4PCS 的核心加速，
  缺了它这一层就不成立。
- **两套点云各司其职**：500 点用于 4PCS 搜索（选 4 点、提点对），8000 点密集云用于
  评分。原因是 500 点抽样间距约 18mm，拿 2mm 容差去比，即使完全对齐也只有零星命中，
  判据直接失效。这是为「2mm 精度」这个需求做的适配，不是 Super4PCS 本身的设计。
- **评分判据由覆盖率改为 RMS**，达标即退出。覆盖率对「旋转补偿平移」不敏感——
  5.7° 旋转能把局部点压进 2mm 内，使覆盖率虚高到 57% 而位姿仍差 42mm；
  RMS 单调，不会被这种局部贴合骗到。

### N-N 配准

- **参考层与目标层各自收集、按索引配对**，不再强制「先点参考、再点目标」。
  参考层第 i 个点记为 R{i}，目标层第 i 个记为 A{i}。
- **按层分别拾取**（新增 `App.rayPickLayer`）。原来用 `rayPick` 只返回最近一次命中，
  而两个尚未对齐的点云在屏幕上必然重叠，射线总是先打到前面那层——于是所有点击都
  记到同一层、另一边永远是 0 个点、矩阵根本算不出来。现在两层都求交，都命中时
  补给数量少的一边，用户不必关心「现在该点哪层」。
- **三维序号标记**：目标侧 A0/A1…、参考侧 R0/R1…，用 HTML overlay + 投影绘制，
  每帧跟随相机。新增 `App.worldToScreen`，与 `rayFromScreen` 严格互逆
  （实测反投偏差 0.0000mm）。
- **达到 3 对实时显示 RMS 与逐点残差**。定在 3 对是因为刚体变换有 6 个自由度，
  3 个非共线点对刚好可解且唯一；不足 3 对时解不唯一，算出来的 RMS 没有意义。
- **明确的退出方式**：应用矩阵后自动结束选点并抹掉标记；点「停止选点」也会隐藏标记。
  此前选完的点会一直挂在画面上。

### 数据对齐面板（原「坐标变换」）

- 模块更名为「**数据对齐**」，语义从「编辑一个矩阵」转为「把两份数据对齐」。
- 「应用」按钮的可用状态改为随矩阵内容实时刷新：只有当前矩阵与最近一次应用的
  矩阵不一致时才可点、才高亮，避免重复烘焙。
- 切换目标图层时回显该图层的累积变换矩阵；从未变换过则显示单位阵。
- 「单位阵 / 复制 / 粘贴 / 反变换 / 应用」移到矩阵正下方（原先在 Tab 内容之后，
  改矩阵要先滚到底）。
- 打开该面板时默认停在 ICP 页。

### 修复

- **点「应用」没反应**：`writeXformMat` 是程序化赋值、不产生 `input` 事件，
  漏了 `refreshApplyState`，于是按钮此前若是灰的，写入新矩阵后仍然灰着。
- **应用后数据弹回原位**：`applyXformToLayer` 先 `xformPositions` 再 `clearPreview`，
  而预览已经把顶点改过一遍，等于乘了两次；紧接着的 `clearPreview` 又把数据
  `set()` 回备份。正确顺序是**先撤销预览、再变换**。
- **界面与计算数据不一致**：应用后矩阵框仍显示该矩阵，之后任何触发预览的操作
  （切图层、改参数）都会把它当待预览矩阵再乘一遍，界面显示 `P0×M²` 而配准读到
  `P0×M`。这是「N-N 之后再跑 ICP 会把目标拉歪」的直接原因。
- **粗配准预览掉帧**：每步都 `releaseLayer + uploadLayer`，即重建空间分块、
  重排索引、上传 1.3MB，单次 20~30ms。新增 `Renderer.updateVertices` 只重传顶点位置。
- **`KD-tree.radius` 缺下界**：只有上界，导致「等距点对」搜索一次都没命中。
- **ICP 输出矩阵未重正交**：几十轮 `expSO3` 的浮点误差会让 R 偏离正交，
  被刚体校验拒绝后矩阵不生效（表现为 RMS=0 但模型不动）。
- **`icpSample` 返回引用而非副本**：数据级预览每轮改写同一份顶点，ICP 等于追一个
  移动靶；另外返回对象缺 `bbox` 字段，发散保护的分母恒为 0、形同虚设。

### 移除

- **对称检查模块**整体移除（`symRun` / `buildSymVariants` / `rotationAbout` 及其 UI）。
  配准面板只保留 N-N 与 ICP 两个模式。

### 主题与交互细节

- 补 `color-scheme` 跟随主题；修复参考/目标下拉框在浅色下仍是深底——
  原样式引用了从未定义的 `--bg-input`，一直走深色回退值。
- 双视图分隔线 1px → 2px，取强调色的低饱和版本，深浅主题各一套。
- 拾取/选点光标换成自定义 SVG（圆环 + 十字 + 中心点），中心点即采样位置。
  N-N 选点与「工具 → 拾取」共用同一套光标逻辑（新增 `App.setPickCursor`）。
- 「自动粗配准」等勾选框统一移到说明文字之后。

### 已知限制

近似对称的工件上，粗配准仍可能给出多个几何等价解（例如绕某轴翻转 180° 后
同样能对上）。此时 RMS 判据配合 `rejectRms` 会退回原始位姿交给 ICP 处理，
不会比配准前更差；但要稳定得到正确解，需要工件本身具备足够的不对称特征。

### 1.0.2.5 补记

修正本文档自身的版本号标注：表头「当前版本」与本节标题此前误写成 `1.0.5.1`，
与实际提交的 `1.0.2.4` 不符。现表头跟随最新提交（`1.0.2.5`），
本节保留 `1.0.2.4` 作为该次提交的记录。

### 1.0.2.6（界面统一与结构整理）

**修复**

- 数据对齐面板内容超出高度被裁：底部「预览」勾选框与矩阵说明文字看不见。
  侧栏是 `flex` + `overflow: hidden`，面板没给滚动能力。
- 「应用」按钮此前用 `primary` class 的有无表示"是否有未应用改动"，
  于是无改动时它会退化成和「复制」「粘贴」一样的灰按钮，主操作身份随状态漂移。
  改为 `primary` 常驻、用 `disabled` + 半透明表达不可用。
- `writeXformMat` 是程序化赋值、不触发 `input` 事件，漏了刷新按钮状态，
  导致 N-N 算出矩阵后「应用」仍是灰的、点不动。

**界面统一**

- 三个面板（图层属性 / 视图设置 / 数据对齐）的分组标题统一为 13px / 600 字重；
  数据对齐此前完全没有分组标题，现在补齐「目标图层」「变换矩阵」「配准」三级。
- 参考/目标下拉框显示图层所属槽位（`m · 左侧`），同名文件不再无法区分；
  该行加下分隔线，与下方勾选项、数值参数分块。
- 勾选项统一为「文字靠左、勾选框靠右」，覆盖 8 处：
  面片/线框/顶点/边界、面法向显示、地面网格/坐标轴、跟随相机、4PCS/预览。
  此前「元素」四项是「框在前」、「4PCS」是「框紧跟文字」，与「左右相机同步」不一致。
- ICP 参数（迭代 / 采样% / 角度° / 距离）改为两列网格，四个输入框等宽
  （标签定宽 42px）；此前实测宽度 107.5 / 98.5 / 103.3 参差。
- 「4PCS」与「预览」两列均分，不再挤在左端。
- 主操作按钮（应用 / 计算矩阵 / 运行 ICP）统一靠右并着主题色，
  编辑类按钮（单位阵 / 复制 / 粘贴 / 逆矩阵）留在左侧。
- 场景树的「全选 / 全不选」从独立一行收进槽位标题行右端；
  空槽位占位从「空 — 按钮载入或拖放文件」简化为灰色「（空）」。
- 矩阵第 4 列（平移）加竖分隔线，与旋转 3×3 分开。
- 副标题版本号改为读取 `?v=` 自动生成，避免「三处同步」漏改。
- 双窗截图把中间分隔线合成进去：它是 `#split-line` 这个 DOM 元素，
  直接 `canvas.toBlob()` 截不到；新增 `App.grabImage()` 按视图矩形补色。

**文案**

- 数据对齐 → ICP 页：「ICP 配准（Symmetric）」标题、`v' = M · v` 说明整行删除；
  「自动粗配准（4PCS）」→「4PCS」；「实时预览（不改动数据）」→「预览」。
- 「反变换」→「逆矩阵」。这个按钮作用对象是矩阵框里的数字，不是顶点数据，
  与「应用」性质不同；用「逆矩阵」也更贴合线性代数的习惯叫法。

**结构整理**

- 拾取相关方法从单个 799 行的 `installPickMethods` 拆成三组：
  `installRayMethods`（屏幕/射线互转）、`installPickQueryMethods`（按层求交、十字判定）、
  `installPickStateMethods`（光标、模式、点列表）；4 个辅助函数提到模块作用域。
  保留「安装」这一步是必要的：`algo.js` 在 `app.js` 之前加载，那时 `App` 还不存在。
- `icpRun` 的 432 行按阶段拆成 `stepCoarse` / `stepVerify` / `stepIcp`，
  `tick` 只负责分派。仍留在 `icpRun` 内部共用闭包状态，改成对象字段反而要传一堆参数。
- 29 个纯工具函数（`fmtMat` / `mat4Invert` / `isRigidMat` / `jacobiLargestEigenVec` 等）
  外移到 `js/ui-util.js`，挂 `MV.util`。`ui.js` 顶部解构成本地变量，
  所有原有调用点无需改动。

**未做**

- `ui.js` 仍承担场景树、属性面板、数据对齐、日志面板等职责。
  继续拆分需要把跨文件函数调用改为 `MV.ui.xxx()` 命名空间调用，
  改动点达数百处，而 `check.ps1` 只覆盖 7 个场景，风险高于收益。

### 1.0.2.7（属性面板修复与文档截图）

**修复**

- 带标量场的点云选中后属性面板整个空白。`rampColorAt` 在 `1.0.2.6` 外移到
  `ui-util.js` 时，它依赖的常量 `RAMP_STOPS` 留在了 `ui.js`，于是每次调用都抛
  `ReferenceError`。调用链 `drawHist → renderProps` 在这里中断：属性行其实已经
  打好了 `.show`，但分组还停在「无选中」的 `.empty` 态，整块面板就是不可见的。
  只有带标量场的点云会走到 `drawHist`，普通点云与网格都不受影响，因此前一轮
  自查没有暴露。现已把常量一并搬到 `ui-util.js`，同时恢复点云的标量场着色。
- 属性面板「路径」在 URL 加载时显示成 `%E6%A7%BD%E8%AF%AF...`，中文文件名认不出。
  改为 `decodeURI` 后再显示。

**变更**

- 地面网格默认关闭（`settings.grid` 与视图设置里的勾选框同步为一组）。
  坐标轴仍默认开启。

**文档**

- 截图改用 `HoleOptimize/data/槽错误识别数据/` 的真实数据：
  左 A 槽优化前（5,311,977 三角形）、右 B 槽优化后（5,316,532 三角形）。
  两版只差 4555 个三角形，整件几乎看不出差别，差异集中在被修正的槽位。
- 四张图统一为双窗。此前 `overview-dark.png` 是单窗，与正文「双窗模式下的完整界面」
  不符；单窗还会把两份数据并入公共槽位、渲染成单色，与「左窗…右窗…」的描述对不上。
  现在首图只截两个视口，其余三张是完整界面，图注逐条点明「左侧优化前 / 右侧优化后」。
- 截图侧顺带解决两个坑：大文件用 `memauto=sample&mempct=20` 自动应答内存预算，
  headless 下不会卡在确认框；截图前关掉 ghost 叠层与线框，否则模型表面会糊上
  大片斑点与细线。
- headless 截图对浅色画布会拿到旧帧，需加
  `--run-all-compositor-stages-before-draw` 与 `--disable-new-content-rendering-timeout`
  才能拍到最后合成的画面。

### 1.0.2.8（按职责合并源文件）

`js/` 下原本是 10 个平铺文件，其中 `kdtree` / `icp` / `super4pcs` / `ui-util`
和 `algo` / `ui` 处在两个抽象层级上，不看 `index.html` 的加载顺序看不出谁依赖谁。
现在按职责合并成 6 个文件，**不新增任何目录层级**：

| 文件 | 收拢的内容 |
| --- | --- |
| `core.js` | 数学（向量 / 矩阵 / 四元数 / 包围盒）+ KD 树 |
| `algo.js` | 三角求交、拾取、裁剪、分块索引 + ICP + Super4PCS |
| `render.js` | WebGL2 渲染、分块、相机、视角器 |
| `ui.js` | 场景树 / 属性面板 / 数据对齐 / 日志 / 拖拽 + 纯工具函数 |
| `io.js` | STL / OBJ / PLY / 点云解析、内存预检 |
| `app.js` | 应用编排、图层与相机 |

合并方式是**原样拼接**：每个原文件都是独立的 IIFE，按顺序首尾相接即可，
不存在函数体改写。`MV.kdtree` / `MV.icp` / `MV.super4pcs` / `MV.util` 这些全局名
全部保留，因此所有调用点、`check.ps1` 的场景 URL 都不需要动。

唯一需要留意的是顺序：`ui-util.js` 必须排在 `ui.js` 之前，因为后者在自己的
IIFE 入口就要解构 `MV.util`。合并后两者同处 `ui.js`，工具函数段放在前面。

`index.html` 的 `<script>` 从 11 行减到 8 行（6 个模块 + 2 个插件）。
README 的目录结构与 GUIDE 的模块归属表同步更新。

---

### 1.0.2.9（载入历史与文件引用）

**新增**

- 载入菜单底部列出**最近 10 个**文件，点一下即可重开。三类来源分别处理：
  `url` 直接再取地址；`path` 走 `GET /file?path=`；
  `handle` 从 IndexedDB 取回 `FileSystemFileHandle`，再 `queryPermission` → `getFile()`。
- 服务端新增 `GET /file?path=`：按 `SEARCH_ROOTS` 白名单回读，只接受本机请求、
  扩展名白名单、`realpath` 后再比对根目录（同时挡掉 `../` 与符号链接逃逸），
  并以流式方式发送，几百 MB 的文件不会整体读进内存。
- `/locate` 反查成功后，把历史里那条「需重新选择」的 `disk` 条目**原地升级**为
  `path`，不会额外多出一条记录。
- 拖入 / 选择文件时用 `dataTransfer.items[i].getAsFileSystemHandle()` 抓句柄
  （必须在事件回调里同步发起），与 `File` 配对后存进 IndexedDB（库 `viewer3d-fs`）。

**修复**

- 路径栏在 `/file?path=` 载入时显示成 `http://…/file?path=D%3A%5C…` 的编码串，
  改为取出 `path` 参数并解码。
- 句柄读取加 8 秒超时，避免「正在恢复…」在 IndexedDB 异常时一直挂着。
- 句柄获取失败不再中断整次拖入：`getAsFileSystemHandle` 可能同步抛错，
  已用 try/catch 与 `.catch(null)` 双重兜底。

**说明**

- 为什么不再靠「文件名 + 大小」匹配：同名同大小、或文件不在搜索根内都会失败，
  本质是猜。句柄是对文件的真实引用，任意目录都能重开，代价是每次会话首次打开
  浏览器会问一次读取权限。
- 浏览器不会把拖入文件的绝对路径交给页面（`File.path` 已被移除，
  `webkitGetAsEntry().fullPath` 只有文件名），所以拖入来源的图层在路径栏注明：
  `（拖入的文件：浏览器不提供绝对路径；引用已记录，可从「载入 → 最近」重开）`。
  `/locate` 若恰好命中，仍优先显示真实路径。
- 兼容性：`getAsFileSystemHandle` / `showOpenFilePicker` 仅 Chromium 系；
  其它浏览器退回 `/locate` + `/file`。`?demo=` 等自动化载入不写入历史。

### 1.0.3.0（格式扩展、分栏拖动、快捷键收敛）

**新增格式**

- **OFF / COFF**：任意边形按扇形三角化；COFF 读第 4~6 列顶点色，0-1 与 0-255 自动识别。
- **PCD**：`DATA ascii` / `binary`；`rgb` 按 32 位位模式解包（不是按数值取整，
  PCL 存的是「颜色整数被当作 float 的位模式」）；`binary_compressed` 明确提示另存。
- **GLB / glTF 2.0**：GLB 走 12 字节头 + JSON 块 + BIN 块；`.gltf` 要求 buffer 内联
  `data:` base64；读 `POSITION` / `INDICES` / `COLOR_0`，支持节点 `matrix` 与 TRS；
  遇到 `KHR_draco_mesh_compression` 直接报错。
- **坐标轴**：glTF 是 Y 轴向上，载入时统一转 Z 轴向上（`x, -z, y`），与 STL / OBJ 一致。

**格式基础设施**

- `detectKind` 的白名单 if 链改成扩展名映射表，新增格式只加一行。
- 未知扩展名不再默默按文本点云解析，而是给出明确提示 + 下一步动作
  （STEP / IGES / FBX / 3MF / LAS / E57 / USDZ 等 13 种各有专门文案）。
- `accept` 补 `.off .pcd .glb .gltf`，以及此前漏掉的 `.ptx`。
- `estimateCount` 补新格式分支，避免内存预算按「40 字节/点」估错。

**分栏**

- 中间分隔线可拖动（命中区比 2px 视觉宽度大，约 14px）；拖到边缘时比例缓动到贴边
  并自动切进单窗，退出单窗再从贴边展开回正中 50%。
- 视图角标 `右侧 (B)` 跟随分隔线移动（此前 CSS 写死 `left: calc(50% + 12px)`）。
- 塌陷判据从「固定 5%」改成「放不下角标」：任一视图窄于角标宽度 + 30px 才切单窗，
  避免角标先被裁掉。

**快捷键**

- 新增 `js/keys.js`：一张表 + 单一入口，23 个键位（视图 / 显示 / 模式 / 文件 / 面板 / 帮助）。
- 收敛原先 5 处独立的 `keydown` 监听（app 的主键位、Ctrl+Z、modal、菜单、配色浮层），
  改为捕获阶段统一拦截 + `stopImmediatePropagation`，同一个键不会再两处响应。
- `Esc` 改为分层退出：确认框 → 菜单 → 浮层 → 帮助 → 载入中 → 裁剪 → 拾取 → 选中。
- 守卫补齐：输入框 / `contenteditable` / 确认框打开 / `e.repeat`。
- 帮助面板此前**根本没有绑定事件**（`js` 里搜不到一处 `help`），现在可点可关，
  内容按键位表自动生成，避免文档与实现脱节。

**文案**

- 精简 8 条按钮 `title`（共减 160 字）：去掉「括号套括号」「枚举自家面板按钮」
  「暴露内部实现名（`HoleOptimize_cli` / `segmented/Rremaining`）」。
- 快捷键标注统一为 `（快捷键 X）`，此前 `（P）` `(Ctrl+Z)` `（Delete）` 混用。
- `check.ps1` 新增 `copy-lint`：title 含两层全角括号直接失败，超 32 字计数告警。

### 1.0.3.1（导出、耗时统计、属性精度、日志级别）

**新增导出**

顶栏「导出」（`Shift+S`）按当前选中图层的类型决定可用项，用不了的置灰并说明原因。

- **STL（binary）**：84 字节头 + 每面 50 字节；法向用三条边叉积现算 ——
  `data.normals` 是按角点存的，与面对不上，直接写会得到错法向。
- **OBJ**：用载入时已算好的 `uniqVerts` + `remap` 写 `v` / `f`。
  网格内部是解索引的（11 万面 = 33 万角点），直接用会让顶点数翻三倍。
- **PLY**：`binary_little_endian`；网格写「顶点 + 面表」，点云写纯顶点元素。
- **PCD**：`DATA binary`；`rgb` 按 32 位打包写成 `U` 字段，与载入时的解包互逆。
- **GLB**：组装单文件 `glTF` 头 + JSON 块 + BIN 块；位置做 `(x, z, -y)` 回转成
  Y 轴向上，与载入时的 `(x, -z, y)` 互逆 —— 来回一圈包围盒不变。
- **点云 CSV / XYZ**：有标量场时按列追加。
- **原始文件**：`layer.sourceFile` 原样下载，字节一致。

一律**分块写 Blob**（每 2 万三角形 / 5 万行一块）：百万级三角形一次拼字符串会爆内存。

**耗时日志**

`ui.js` 新增 `nowMs()` / `fmtDur()` / `logTiming()`：

- 低于 **300 ms** 不记，避免日志被小事刷屏；唯一例外是**载入**（`force`），
  它是一次性、用户主动等的操作，历史里常是小文件，不记会让人以为功能没生效。
- 计时用 `performance.now()`：`Date.now()` 会被系统时钟校正影响，跨 `await` 不准。
- 失败的也记（`孔位优化（失败） · 12.4 s`），失败前后的时长对比才能区分「网络慢」和「它没起来」。

接入六处：

| 操作 | 记录内容 |
| --- | --- |
| 载入 | 总时长 + 下载 / 解析 / 建层三段；来源为历史时标「载入（历史）」 |
| 应用矩阵 | 时长 + 三角形或点数 |
| 裁剪拆分 | 时长 + 保留比例 |
| 导出 | 时长 + 文件大小 |
| 孔位优化 | CLI 往返 |
| ICP | 时长 + 迭代次数 + RMS + 粗配准 / 迭代分段 |

ICP 的分段靠 `stepIcp()` 首次被调用时打点：候选验证（Super4PCS 那段按帧推进的）
全算进粗配准，剩下的才是纯迭代时间。

> **验证注意**：无头浏览器加 `--virtual-time-budget` 时虚拟时间会快进，日志里的时长
> 被放大到分钟级，只能用来确认「有没有记录」，真实快慢要在正常浏览器里看。

**属性面板**

- 计数**精确到个位**（千分位），不再用 `111.0k`：`STL(binary) · 面 111,009 · 顶点 56,642`。
- 网格把**面数**与**顶点数**（去重后的唯一顶点）分开列；点云补**标量列数**。
- 路径栏：`/file?path=` 载入时直接把参数落成 `absPath`，不再依赖 `/locate` 去猜；
  普通 URL 载入也会反查一次。**没有路径就整行隐藏**，不再用长句占位。

**日志级别**

- 三个级别，名称统一 **4 个字母**：`info` / `warn` / `fail`。
- 级别来源两层：调用方显式指定（`setInfo(text, noLog, level)`），
  没有则 `classifyLog()` 按**消息形态**兜底 —— 不再「关键词出现即判红」。
- 行内加**文字标签**（`INFO` / `WARN` / `FAIL`，定宽 30px），复制日志时也带级别。
  颜色在色弱、截图外传、黑白打印三种场景下都会失效，文字标签是唯一兜底。

> 起因：导出一个文件名带「异常」的工件，连「已导出 …（浏览器下载目录）」这种成功消息
> 都被整行标红 —— 旧实现扫的是整串文本，把用户数据也当判据了。

**修复**

- `exactCount` 与 `LOG_LEVELS` 曾分别定义在工具函数段的 IIFE 里、却在主 IIFE 引用，
  报 `is not defined`：前者让属性面板整块渲染失败，后者让所有显式级别静默失效
  （只剩兜底在工作，更难发现）。`ui.js` 有两个 IIFE，跨段引用必须同段。
- `glTF` 的 `rgb` 解包：PCL 存的是「颜色整数被当作 float 的位模式」，
  按数值取整会得到错误颜色，改成按位还原。

---

### 1.0.3.2（图层重命名、配准与对齐修复）

**图层重命名与唯一 ID**

- 双击名称就地改名（回车确认 / `Esc` 取消 / 失焦提交）；右键菜单「重命名…」；`F2` 亦可。
- 每个图层两个标识：`id`（会话内递增，树上显示 `#12`）与 `uid`（跨会话唯一，悬停可见）。
- 导入同名文件自动加序号 `part (2)`；手动改成同名不拦，只提示。

**数据对齐**

- 参考 / 目标两个下拉**实时互斥**：改任意一侧都会重填两侧并互相排除。
  此前只在「打开面板 / 增删图层」时填一次，改了目标后参考的可选项是过期的。
- **源法向随旋转**：ICP 里点按 `R` 变换、法向却用原始方向做点积。初值带较大旋转时
  对应点被整批丢弃 —— 实测候选残差 20.06 mm，修复后 1.02 mm；最终结果从
  「0.93 mm / 4.9% 参与」变为「0.16 mm / 98% 参与」。这是「粗配准位姿不准」的真因。
- **包围盒剔除**：查询点远离点云时 KD 最近邻没有剪枝机会，退化成全量扫描
  （实测 4~6 ms/次）。超出 `maxDist` 的点直接跳过，同一负载从 14 s/轮降到 78 ms/轮。
- **候选验证改子集迭代**：一次性初始残差排不出对错（对称错解的初始残差 10.8 mm
  反而低于正确的 19.5 mm），必须迭代后才能排序。改在 8000 / 20000 子集上跑 12 轮、
  复用 KD 树，约 17 万次查询（原约 960 万）。
- **粗配准参数自适应**：`delta` 写死 3 mm 只适合 300 mm 量级的工件（844 mm 数据集
  实测 LCP 卡在基准 2.6%），改 `对角线 × 0.02`；早停阈值 1.0 → 0.85（1.0 不可达，
  等于每次跑满 200 次尝试约 17 s）。
- **初值链**：候选 → 粗配准矩阵（含质心对齐）→ 单位阵。曾错误地把「矩阵框」接进来，
  而框里记录的是已烘焙的变换，等于把同一变换乘两次。
- **N-N**：选点标记跟随图层位姿与可见性（图层被变换/隐藏后标记不再留在原地）；
  「计算矩阵」的异常不再被事件处理器吞掉（曾因代码误插导致点了完全没反应）。
- **可终止**：运行中按钮变「终止」，再点一次或按 `Esc` 立即停止并还原数据。

**实时渲染**

- **预览改 GPU**：`layer.previewMat` 作为 `uMVP * uModel` 参与顶点变换，数据不动、
  零上传；手动编辑矩阵也走这条路（原来是每敲一个字符重算 46 万点 + 重传 5 MB）。
- **两套预览互斥**：数据级预览（改写顶点）与 GPU 预览同时生效＝同一矩阵乘两次，
  正是「N-N 应用矩阵后跑 ICP，数据被拉歪」的原因。清理必须放在 `applyPreview()`
  入口，因为它在单位阵/非刚体/已应用时提前返回，走不到下层。
- **尺寸变化同步补画**：上下文是 `alpha: false`，重分配 drawing buffer 会清成不透明黑；
  `ResizeObserver` 的回调发生在 rAF 之后、合成之前，只置 `dirty` 会把黑帧合成出去
  （深色主题本身是黑的，所以只在浅色下显形）。
- **推进与标记改定时器**：`requestAnimationFrame` 在后台标签页会被暂停、主线程繁忙时
  也会长时间不给回调，表现为进度不动、像卡死。计算用定时器节拍，画面仍由 `app.tick` 重绘。

**矩阵框语义**

- 只表示「待应用的增量」：切图层归零、应用后归零；累计变换改为标签悬停里的只读信息。
  此前同一个控件混着「绝对变换」与「增量」两种语义，切完图层改一位再应用就会重复烘焙。

## 2026-11-13（周五）｜粗配准重做：从"搜不到"到"能收敛"

**v1.0.3.5**

起点是用户反馈「粗配准效果不佳」。用 `_t/reg_bench`（自建离线基准，见文末）
把症状量化之后发现：**4PCS 全局搜索在四组用例里一次都没有产生过候选**，
每轮都返回"质心对齐"，误差全靠后面的 ICP 兜底 —— 姿态差一大就收不回来。

### 定位：六个叠加的缺陷

1. **八叉树与点云错开半个包围盒**。`sampledQ` 是质心系坐标（[-0.5, 0.5]），
   而 `IntersectionFunctor` 的八叉树根节点覆盖 [0,1]³、节点中心从 0.5 起分。
   两边错开常量偏移后 `shellHitsNode` 的壳层判定整体失配，本应命中的节点被整枝剪掉。
   修法：另外维护一份平移到 [0,1]³ 的副本专供 `ExtractPairs`（点号不变）。
2. **ε 对齐方向反了**。`lvlMax = floor(-log2(eps))` 得到的是 **≥ eps** 的 2 的负幂，
   把点对容差放大了近一倍（0.042 → 0.0625）。而候选四边形的 rms 门限仍是 2δ，
   通过率被压到恒 0。改成 `ceil`（向下吸附），门限同时放宽到 4δ
   （两条基线各差满一个 eps 才是合理上界）。
3. **点对朝向没被枚举**。不变量 r 是"从点对第一个端点量起"，天然有向；
   而 `ExtractPairs` 输出的点对下标是**索引大小序**（`p > q`），与几何朝向无关。
   只按一种朝向建索引时约一半命中落在镜像位置上（误差 = |1−2r|·L）。
   改成建索引与查询都枚举两种朝向，命中后按朝向还原端点顺序。
4. **基四边形经常是退化的**。两条基线"最近距离"落在端点（r=0 或 1）意味着
   它们其实不相交，此时 r 退化成一个端点坐标，等长匹配退化为噪声。
   加合法性检查：r ∈ (0.06, 0.94) 且基线最近距离 < 2% 云直径，不满足就重抽（最多 6 次）。
5. **方向判据的量化误差太大**。官方 `IndexedNormalSet3D` 的法向 7³ 分箱一格约 15°，
   查询时沿圆锥母线只采样最少 4 个方向 —— 正确构型基本采样不到。
   改成**只保留位置那一维**（`PositionHash3D`），格内全遍历、方向用精确点积判角（容差 ~4°）。
   这一条是决定性的一步：候选四边形的 4 点拟合残差从 **0.17 掉到 0.006**
   （0.17 已是 15° 的方向误差，0.006 才是"真的对上了"）。
6. **早停阈值把错解锁死了**。LCP 是"落在 delta 内的比例"，薄板/近似对称件上
   翻 180° 也能拿到 85%，于是 `terminate_threshold=0.85` 常在第一次验证就终止搜索，
   把一个错 165° 的解当成最优。抬到 0.98，并把"按遍历顺序验证前 N 个候选"
   改为**按 4 点残差升序取前 40 个**（前者几乎全出自同一小片区域，预算全花在垃圾上）。

### 补强：主轴（PCA）多假设 + 廉价粗筛

4PCS 终究是"采样 + 分箱"的离散搜索，姿态差越大越吃粒度。同一零件的两次测量、
CAD 与实测这类常见场景里，主轴是稳定可用的：把两侧主轴对齐只有 24 种可能
（6 种轴置换 × 4 种保向符号，反射解剔除），一次 PCA 就够。新增
`MV.icp.pcaCandidates(src, dst)` 返回这 24 个真旋转。

候选从 2 个变成 26 个之后，不能再逐个跑 12 轮 ICP（实测 26 个约 9 s）。新增
`createVerifier(...).screen(mat)`：1500 个点、不迭代，只算"落在 delta 内的比例"，
排序后取前 5 进完整验证；**「质心对齐」永远保留在名单里**（数据本来就对齐、
或用户刚做完 N-N 时它才是最稳的初值）。

### 可复现

4PCS 的抽样 / 取基 / 直径估计原来都用 `Math.random`，同一份数据两次运行
给出的 LCP 能差到 0.23 与 0.54（"能用 / 不能用"）。改成固定种子的 mulberry32
（`options.seed` 可覆盖），`init()` 时重播 —— 同一输入必得同一输出。

### 实测（`_t/reg_bench`，843.9mm 数据集，40k 点）

| 用例 | 粗配准旋转误差（前 → 后） | 最终旋转误差（前 → 后） | 最终贴合率¹（前 → 后） |
| --- | --- | --- | --- |
| 同件 137° | 137.0° → **2.5°** | 179.7° → **0.0°** | 0.418 → **1.000** |
| 同件 180° | 180.0° → **2.9°** | 179.8° → **0.0°** | 0.430 → **1.000** |
| 同件 25° | 25.0° → **2.3°** | 0.0° → 0.0° | 1.000 → 1.000 |
| 同件 137° + 55% 重叠 + 0.3mm 噪声 | 137.0° → **4.0°** | 179.6° → **0.0°** | 0.446 → **1.000** |
| 已对齐（回归护栏） | 0.0° → 0.0° | 0.0° → 0.0° | 1.000 → 1.000 |
| 真实一对（手持 vs 跟踪） | LCP 0.23（=基准）→ **0.79** | — | 中位 31.1mm → **10.5mm** |

¹ 贴合率 = 源点变换后落在目标表面 0.5% 对角线（4.2mm）内的比例。

顺带把两处热路径也修了（否则修好的搜索反而更慢）：

- **点对提取改 KD 环形查询**。官方的八叉树分层求交里，第一遍"只保留与球壳相交的
  格子"是以节点自身中心为球心的，语义上不成立：扫全云时几乎每个节点都留下
  （剪枝等于没有），只扫本节点的点又会把真解全剪掉（实测 pairs 归零）。
  KD 树本来就支持环形查询（下界 dist−eps / 上界 dist+eps），正是"等距点对"的定义，
  采样规模只有 2500，一次环查只回壳上的几个点 —— 删掉约 190 行求交代码、更快也更准。
- **LCP 打分用 `nearestIndex` 而不是 `radius`**：只关心"有没有点落在 delta 内"，
  半径查询会把球内所有点收进数组（一次分配 + 若干 push），而这是每轮 40 次 × 2500 点
  的最热路径。

参数相应调整：`maxTrials` 120 → 30、`max_time_seconds` 30 → 8、`pairLimit`
40000 → 12000、`terminate_threshold` 0.85 → 0.98、`batch` 2 → 1
（一轮约 200ms，逐轮重绘才看得见进度）。搜索耗时：137° 用例 0.18s、
180° 1.5s、真实一对扫描件跑满 30 轮 7.2s（改造前 6s 但一无所获）。

**真机端到端**（246k / 190k 点的一对扫描件，单窗、勾 4PCS）：
`粗配准 7.24 s / ICP 迭代 16.7 s`，最终 `RMS 0.3519`、参与点 111226，
采用「主轴假设」（残差 0.27mm）作为初值 —— 改造前同样数据是「粗配准未找到更优位姿，
改用质心对齐」。ICP 迭代那 16.7s 是既有开销（49% 采样 = 12 万点 × 8 轮），
不在本次范围。

### 回归方法

`_t/reg_bench.html`（不进库）：同步读两份真实 STL、造"已知刚体变换 + 部分重叠 + 噪声"
的合成用例，跑粗配准 → 粗筛 → 验证 → ICP，输出旋转误差 / 平移误差 / 贴合率 / 耗时。
`?algo=orig&...` 切到改造前的副本做前后对比。两次连跑数字完全一致（确定性已验）。

**v1.0.3.6 —— 接着修"粗配准修好之后暴露出来的慢"**

搜索能找对位姿之后，真机链路暴露出三处此前被"反正也没配上"掩盖的问题。
用真机时间线（267k/190k 点的一对扫描件）逐段量出来的：

| 阶段 | 前 | 后 |
| --- | --- | --- |
| 粗配准搜索（30 轮） | 4.9 s | 4.9 s（已对齐时 **1.4 s**） |
| 候选验证（5 个） | 0.6 s | 0.6 s |
| ICP 迭代 | 11.7 s（8 轮，RMS 0.3547） | **3.4~4.5 s（10~15 轮，RMS 0.0478）** |
| 合计 | 17.6 s | **7.5~8.8 s**（第二轮已对齐：3.9~4.7 s） |

1. **最近邻没有距离上界**。ICP 每点都问"全树最近是谁"，而它其实只要
   `d ≤ curMaxDist` 的对应点。位姿还没收敛时查询点远离点云，剪枝条件
   `diff² < bestD2` 里 `bestD2 = ∞`，几乎剪不动 —— 实测 19 万点树上
   12 万次查询：近场 90 ms、**远场 887 ms**（7.3 µs/次）。
   `nearestIndex(x,y,z,maxDist)` 把 maxDist 直接当 `bestD2` 初值后，远场 **33 ms**（26 倍）。
   LCP 打分也改成传 `delta`，顺带让离线基准整轮快 2.5 倍（`real_ab` 7.6 s → 3.0 s，
   且 LCP/旋转误差/贴合率一位不差）。
2. **初值越准，容差越不该放大**。`effMaxDist = max(10, 对角线×0.025) = 21mm`，
   solver 内部前段还要乘 3 —— 首轮 63mm 的容差把薄板另一侧、孔壁、装夹面
   全当成了对应点：给了 0.27mm 的优质初值，首轮反而把 RMS 拉到 9.6、次轮 24.2，
   第三轮才回到 0.47，白烧两轮（每轮 1.6~4 s）。
   现在 `trimBoost` 可传：初值残差 < 容差 30% 时容差改用
   `max(3×残差, 对角线×0.0015)`（0.27mm → 1.3mm）、`trimBoost` 降到 0.5，
   收尾轮直接给 0。**迭代轨迹变成单调下降**，最终 RMS 0.3547 → **0.0478**。
3. **ICP 收敛判据等不到底**。法向对称项下 RMS 会进入"每轮只降万分之几"的长尾，
   而 `tol=1e-7` 的步长判据要求步长几乎为 0 —— 容差收紧后迭代次数从 8 涨到 35。
   加停滞早停，35 轮 → 10~15 轮。
   判据用**最近 5 轮窗口的相对极差 < 0.5%**，不是"连续 N 轮每轮降幅 < x%"：
   后者在临界点会抖（降幅 0.09% / 0.11% 交替时计数器反复清零），
   同一份数据有时 11 轮停、有时 28 轮停，实测耗时在 4.1s ~ 11.6s 之间跳。

顺带加了**已对齐时跳过搜索**：原始位姿的 LCP ≥ 0.9 直接 `cancel()`，
不给"用户忘了取消自动粗配准"再空跑 5 秒（主轴假设与残差验证照跑，结果不变）。

> 教训：这三个问题都**不是**"算法不对"，而是"参数在一个错误的区间里被使用"。
> 修粗配准之前，位姿本来就错，多烧几秒没人察觉；一旦能配上，
> 容差/剪枝/早停的口径就变成了主要矛盾。

**v1.0.3.7 —— 注释与文档对齐实现（不改行为）**

代码连改三轮之后，注释里残留的旧口径比代码本身更容易误导后来的人。
这一轮只做对齐：离线基准 6 个用例逐位不变、真机链路 9.76 s / RMS 0.0479 与上一版一致。

- **删两段孤儿注释**：`algo.js` 里「Super4PCS 的简化实现（逐级半径查询 + 内点率打分）」
  和「4×4 对称矩阵最大特征向量，用于 Horn 四元数」—— 它们描述的是早已被官方实现
  取代的早期版本，后面也没有对应代码（`jacobi3` 有自己的注释）。
- **删死代码 `kdTreeP`**：Verify 实际用的是 `kdEval`，这棵树建了从没用过；
  原注释还写着"kdTreeP —— Verify 把变换后的 Q 点拿去 P 里查"，与实现相反。
  `evalPos` 顺带收成局部变量（外部没人读）。
- **预览节流的注释还是旧的**：写着"applyPreviewMat 数据级变换、每次上传 5MB"，
  而实现早已改成 GPU 预览（只写 uniform）。改成"真正开销是整帧重绘 80 万点"。
  ICP 段同一处有两段自相矛盾的注释，合并成一段。
- **文件头「与原版的已知差异」补齐**：KD 环形查询取代替换八叉树求交、
  Verify 早停 0.98、候选按 4 点残差升序验证；并注明"坐标必须平移到 [0,1)³"
  这条约束随八叉树一起失效（只有位置哈希还用偏移）。
- **补"决定耗时的是容差不是点数"**：`AUTO_SAMPLE_MAX`、首轮容差、收尾轮
  三处注释都加上这条口径 —— 它是本轮所有性能改动的共同前提。
- **GUIDE**：§3.8 参数表加 4 行（容差上限 / `trimBoost` / 停滞早停 / 距离上界剪枝）、
  §3.9 的 ICP 参数表与进度示例按现实现重写（迭代会提前停、采样自动折算）、
  §5.7 补验证分帧与"已对齐跳过搜索"、性能表补实测口径。

**v1.0.3.8 —— N-N 选点的序号标签跟着点云走**

症状：矩阵框里一预览（或 ICP 每轮预览），点云在画面上移开了，`A0`/`R0` 标签却钉在原地。

根因是「跟随」只做了一半。点的位置靠两层机制维持：

| 位姿来源 | 表现 | 旧实现 |
| --- | --- | --- |
| 已烘焙的变换（应用矩阵 / N-N 应用 / ICP 收尾） | `layer.xformMat` 累乘 + 顶点被改写 | 每点记拾取时的累计变换，重绘时补 `delta` ✅ |
| 只存在于渲染的预览（矩阵框预览 / ICP 每轮预览） | `layer.previewMat`，数据与 `xformMat` 都不动 | **没有任何处理** ❌ |

而预览恰恰是配准流程里出现最频繁的一步：N-N 算完矩阵立刻预览、ICP 每轮都预览。
只做烘焙那一半，用户看到的就是"标签根本不跟"。

修法：两处换算，数据空间仍是唯一的存储与求解空间。

- 投影 `pickDisplayPos()`：画之前乘该层的 `previewMat`；
- 拾取 `pickToData()`：`rayPick` 打的是数据空间，用户点的却是预览后的位置 ——
  乘 `inv(previewMat)` 换回数据空间再存。

`regSolve`、逐对误差、配对逻辑全部不受预览影响（它们只看数据空间）。

实测（真机 267k/190k 点，纯平移 100mm 预览）：

| 断言 | 结果 |
| --- | --- |
| 标签位移 vs 同一点按矩阵变换后的投影差 | (10.5, 7.5) px vs (10.5, 7.5) px，偏差 **0.06 px** |
| 预览态下点标签所在像素 → 新标签落点 | 偏差 **0.00 px** |

> 后一项同时验证了拾取换算与显示换算：少了 `pickToData`，新标签会再偏一个预览位移；
> 少了 `pickDisplayPos`，标签会画回原位。两种错误都被这一项抓到。

GUIDE：N-N 一节新增「两种位姿来源各自怎么换算」表格；原来那段
「选点标记会跟着数据走」收敛为指向它的说明（去掉重复的 delta 公式）。
回归工具：`_t/probe_marks.html` + `probe_marks_run.ps1`（用 `rayPickLayer` 反查
命中像素来精确点击，避免盲扫网格取不到点）。

**v1.0.3.9 —— N-N 选点表格（右上角浮动）与删点**

需求两条：选点要能删、删的时候可以选择连带删掉另一侧的对应点；同时右上角要有一个
常驻的选点表格，能看到选点信息与误差。

**先改数据模型，否则删点必然错位。** 原来配对是"按数组下标隐式成立"的
（`min(参考点数, 目标点数)` 取前 n 个），删掉中间一个点后，原来的下一个点顶到该下标，
就会和另一侧的另一个点配到一起 —— 误差立刻是错的，而且看不出来。
现在每个点自带 `pid`（每侧各自递增），`R{pid}` ↔ `A{pid}` 才是配对；
删点只 splice、不重排，任何已有配对都不受影响。

| 能力 | 实现 |
| --- | --- |
| 右上角浮动表格 | `#pick-table`（`position: fixed`，默认 `top:86px/right:18px`），进入选点自动展开 |
| 拖动 | 标题栏 pointerdown 起拖，`right` 定位自动切 `left/top`，限在窗口内 |
| 收起 / 展开 | 表头 `×` 收起；侧栏那行摘要点一下即可重新展开（`#reg-list` 兼作开关） |
| 每行内容 | 编号 · 参考坐标 · `×` · 目标坐标 · `×` · 残差 |
| 底部汇总 | 参考 N / 目标 M · 已配 K 对 · RMS · 最大残差（不足 3 对时显示"还差几对"） |
| 联动删除 | 表头「联动删除」勾选时，删一侧连带删配对侧；取消勾选只删这一侧（该行转灰、不参与配对） |
| 冲突处理 | 点删除按钮走 `stopPropagation`，不会被画布的选点/拾取处理器接走 |

侧栏 `#reg-list` 从"逐点列坐标 + 逐对误差"精简为一行摘要 —— 十几行文本会把
「计算矩阵」挤出面板可视区，而明细在表格里更清楚。

实测（`_t/probe_table.html`，真机 267k/190k 点，单视图）：

| 阶段 | 结果 |
| --- | --- |
| 选满 3 对 | 表格 3 行，残差 21.368 / 22.485 / 11.281，底部 `已配 3 对 · RMS 19.056 mm · 最大 22.485 mm` |
| 勾选联动，删 `R0` | 参考 3→2、目标 3→2，剩两行（`pid` 1、2，**不重排**） |
| 取消联动，删 `R1` | 参考 2→1、目标 2 不变，该行转灰（`R=—`），`pid 2` 仍正常配对 |
| 拖动标题栏 | 位移 (-120, +60) px，与鼠标位移一致 |

> 测试脚本踩过一个坑，顺手记下：双视图时两个视图**共享相机**，
> 分别 `camera.fit()` 两个相距 3 米的图层会把先取到的屏幕坐标作废；
> 用单视图 + `fitAll()` 取点才稳定。这只影响测试脚本，与功能无关。

GUIDE：N-N 步骤补「表格 / 删点 / 联动删除 / 拖动收起」，并说明配对已改为显式 `pid`。

**v1.0.4.0 —— N-N 选点标签的视觉重做**

原样式是"实心亮块"：琥珀 `#f0b429` / 青 `#35d0d0` 铺满底色 + 反白文字。三个问题：

1. **亮度太高**，压在深色点云上抢视线，还容易和模型本身的配色撞；
2. **标签中心就是点位** —— 选孔心、棱边这些地方时，标签正好挡住要瞄的点；
3. R0 与 A0 只靠颜色区分，两片点云靠近后标签叠在一起，编号分不清。

新口径（纯 CSS，交互不变）：

| 项 | 旧 | 新 |
| --- | --- | --- |
| 底 | 实心亮色块 | 半透明玻璃 `rgba(7,20,24,.88)` + `backdrop-filter: blur(6px)` |
| 文字 | 反白 `#1a1200` | 状态色本身（`#7ff0ef` / `#ffc857`），对比靠描边与暗底 |
| 形状 | 3px 圆角方块，11px | 999px 药丸，17px 高 |
| 位置 | 以点位为中心 | 抬高 14px，下方 5px 圆点精确指回点位（圆心误差 < 1px） |
| 编号 | 前后缀同字号 | 前缀 `R/A` 10.5px、透明度 .78；数字 11.5px/700 —— 一眼先看编号 |
| 描边 | 同色深档 | 状态色 72% 不透明 + 内高光 + 外阴影 |
| 浅色主题 | 与深色共用（亮青/亮琥珀在白底上根本读不清） | 白雾底 `rgba(255,252,245,.92)`，文字压到 `#0b6e6e` / `#8a5a00` |

实现要点：

- 全部走 CSS 变量（`--mark-c` / `--mark-bg` / `--mark-line` / `--mark-halo`），
  `.ref` / `.dst` 只覆盖变量，深色与浅色各一套，互不影响；
- 圆点位置是按"总高 17px"推算的，所以 **`box-sizing: border-box` 不能省** ——
  否则 17px + 上下各 1px 边框会让圆点偏离点位约 1px；
- JS 只多一件事：编号拆成 `<span class="pm-tag">A</span><span class="pm-num">0</span>`，
  好让前缀比数字小一号。`textContent` 仍是 `A0`，按文本断言的测试不受影响。

实测（真机页 `getComputedStyle`）：`radius 999px / height 17px /
bg rgba(30,21,5,.88) / color rgb(255,200,87) / transform translate(-14.86px, -22.5px)`，
与设计值一致；深色与浅色两版分别截图目视确认。

> **未做（留作可选项）**：两片点云对齐之后，`R{i}` 与 `A{i}` 的标签会叠在一起。
> 可以按 `pid` 做垂直错层（R 再抬高 16px、A 保持原位），但那样标签离点位更远，
> 得配合一条连线才不突兀 —— 代价高于收益，先记在这里。

**v1.0.4.1 —— 标签字体统一 + 跟帧刷新（零延迟）**

两个反馈：字母比数字小一号、看着没对齐；拖视角时标签明显滞后。

**字体**：上一版把前缀（`R/A`）压到 10.5px/600/透明度 .78，数字 11.5px/700 ——
本意是做层次，实际效果是"没对齐"。现在字号/字重/字距全部继承 `.pick-mark`
（11px / 700），两个 span 只留一点透明度差（.86 vs 1）。

**跟帧**：这里是第三次改刷新机制，三个版本各踩过一个坑：

| 版本 | 做法 | 结果 |
| --- | --- | --- |
| 1 | 常驻 `requestAnimationFrame` | 不在选点状态也每帧投影 + 写 DOM，白占主线程 |
| 2 | `setInterval(50)` | 省开销，但拖视角时**标签明显滞后**（相机每帧动、标签 50ms 才挪一次） |
| 3 | 挂到渲染循环末尾 `app.onAfterRender` | 只在真正出图的帧更新，用的就是这一帧定稿的相机矩阵 |

`app.tick` 里新增一行：`if (this.onAfterRender) { this.onAfterRender(); }`，
放在 `renderFrame()` 之后、`dirty = false` 之后。标签因此和画面**严格同帧**，
而且场景不 dirty 时一次都不算 —— 比版本 2 更省。

实测（`_t/probe_lag.html`，模拟 16 次拖拽旋转、每次 20ms）：

| 项 | 结果 |
| --- | --- |
| 相机变化次数 / 标记样式变化次数 | 16 / 31（≥ 1:1，每帧都跟） |
| 从相机变化到标签更新 | avg **7.7ms**、max **14.0ms**（≈ 一帧） |
| 判定 | `PASS 同帧跟随` |

旧实现在 20ms 间隔下只有约 1/3 的旋转能等到标签更新，延迟分布 0~50ms。

> 命名保留了 `startPickMarkTimer` / `stopPickMarkTimer`：
> 调用点散在选点开关与 `regRender` 里，改为 `startPickMarkFollow` 之流的收益抵不上风险。

**v1.0.4.2 —— 工具拾取改用同款序号标签（去掉 3D 十字）**

「工具 → 拾取」原来在 WebGL 里画 3D 十字（`drawPickMarks`，恒定 1mm 单臂、
靠"最近 3 个亮橙 / 更早暗灰"区分）。问题与 N-N 标签早期那版一样，而且更严重：

- 薄板 / 点云上只有几条 1px 线，远看几乎不可见，近看又糊成一片；
- 关掉深度测试才能"任何视角可见"，于是它会穿过模型显示，遮挡关系反直觉；
- 编号只写在信息栏里，画面上的十字与 `P1/P2/P3` 对不上号。

现在**与 N-N 选点共用同一套标签实现**：

| 项 | 旧 | 新 |
| --- | --- | --- |
| 绘制方式 | WebGL 3D 十字（关深度测试） | DOM 药丸标签 + 指位圆点（同 N-N） |
| 编号 | 只在信息栏 | 标签上直接 `P1 / P2 / P3…` |
| 区分 | 亮橙 vs 暗灰（颜色语义要记） | 最近 3 个紫色高亮，更早压成灰色 |
| 跟随 | 每帧随渲染画 | 同 N-N，挂 `app.onAfterRender`（与画面同帧） |

实现上把标签层抽成了公共实现（`ensureMarkLayer` + `paintMarks`）：
`#pick-marks`（R/A）与 `#tool-marks`（P）两个容器共用投影、DOM 复用、
视口裁剪与跟帧逻辑，差别只有"数据源 + 前缀 + 配色"。CSS 也从
`#pick-marks .pick-mark` 解耦成 `.pick-mark`，两套标签自动共享同一份样式。

同时修掉一个**只在单视图下出现**的幽灵标签：单视图时视图 1 的 `rect` 会退化，
`worldToScreen(p, 1)` 返回左上角附近的坐标，于是每个点凭空多出一个标签
（实测 4 个拾取点变成 7 个标签）。现在按 `singleView` 只投影 1 个视图，
并跳过 `rect` 宽高 < 2px 的视图。

清理：删除 `Renderer.drawPickMarks`（约 90 行）与 `pickMarks` / `pickMarkLen` 字段；
`?mark=` 参数保留解析但注明失效（GUIDE 同步标注）。

实测（`_t/probe_pick.html`，单视图，拾取 4 点）：

| 断言 | 结果 |
| --- | --- |
| 标签数量 / 文本 | 4 个：`P1 P2 P3 P4`（与 `pickPoints` 一一对应） |
| 标签位置 vs 投影 | 偏差 > 1.5px 的个数 **0** |
| 高亮规则 | `active=3 / idle=1`（最近 3 个高亮） |
| 旋转视角后跟随 | 首个标签 x 471px → 552px，跟随正常 |

**v1.0.4.3 —— 「已对齐跳过搜索」要让用户看得见**

起因是一个回归提问：**N-N 算出矩阵并应用之后，再跑带 4PCS 的 ICP 还正常吗？**
行为本身是对的（下面有实测），但界面上看不出来是"跳过"还是"被打断"：

- 进度条从「粗配准 3% 尝试 1/30 LCP 93%」直接跳到「验证候选 2/5」，
  中间没有任何说明；
- 最终日志里那句"跳过全局搜索"被后面"采用「XX」，残差…"**整段覆盖**了
  （`coarseNote` 被重新赋值），于是已对齐的场景看起来像"搜索跑了但一无所获"。

三处修正：

1. `stepCoarse` 的进度文案按 `coarseSkipped` 分支：
   显示「原始位姿已对齐（LCP 93%），跳过全局搜索，准备验证候选…」；
2. 最终的 `coarseNote` 改为**追加**而不是覆盖
  （`…已作为 ICP 初始位姿（原始位姿已对齐，全局搜索已跳过）`）；
3. 快速通道用到的基准 LCP 存进 `coarseBaseLcp` ——
   `step()` 的返回值里并没有 `baselineLcp` 这个字段，只有 `result()` 才有。

**回归实测**（`_t/probe_nn_icp.html`，同一对扫描件 246k/190k 点，两次都勾 4PCS）：

| 轮次 | 状态 | 耗时 | 粗配准阶段 | 最终 RMS |
| --- | --- | --- | --- | --- |
| 1 | 初始（两片 z 差 3.3 m） | 10.6 s | 跑满 30 轮，LCP 24% → 83%，主轴假设 0.27mm | 0.0477 |
| 2 | 已对齐（与「N-N 应用矩阵后」等价） | **6.6 s** | **0.6 s 判定 LCP 93% → 跳过搜索**，仍验证 5 个候选 | **0.0478** |

结论：**不会被推歪**。搜索跳过之后，"主轴假设 + 质心对齐"的候选验证照常跑，
最终位姿与第一轮一致（0.0477 → 0.0478，差值是噪声级），时间少一半。

> 为什么"跳过搜索"是安全的：4PCS 在已对齐数据上本来也只能给出"几何等价解"
> （薄板翻转 180° 之类），而候选必须**严格超过**基准 LCP 才会被采纳；
> 即便伪高 LCP 骗过了搜索，后面的残差验证仍以"质心对齐"为参照。
> 这条链路在 v1.0.3.6 加快速通道时就成立，本次只是把它显示出来。

**v1.0.4.4 —— 数据对齐面板补上「累计变换」**

问题：矩阵框的语义是「待应用的增量」，应用完立刻归零 —— 于是用户看不到
**这个图层相对载入时到底被变过多少**。核对 N-N 结果、判断要不要撤销都无从下手。

三个方案：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A. 只读累计行（采用） | 框仍是增量，下面加一行只读摘要 + 「复制 / 还原」 | 零语义风险，占用一行 |
| B. 双矩阵可编辑（增量/累计切换） | 累计模式下应用时算 `delta = M_new × inv(M_old)` | 能直接输入绝对位姿，但两条应用路径；历史上正是"两种语义挤在同一控件"导致过数据被推歪 |
| C. 两个 16 格框并排 | — | 面板宽度不够，必然误操作 |

A 的实现：

- 数据源就是 `layer.xformMat`（它**一直在记**累计变换，以前只藏在图层标签的
  `title` 悬停里，还是 16 个裸数字）；
- 显示**旋转角 + 平移**两行：面板实宽约 290px，去掉"累计"和两个按钮只剩约 170px，
  一行放不下 `R 30.0°  T (-3.4, 223.2, 300.0)`（会被省略号吃掉 z 分量），分两行正好；
  一位小数足够（完整矩阵在 `title` 里）；
- 「复制」写 16 个数到剪贴板；「还原」= 对该层应用 `inv(累计)` —— 走同一条烘焙路径，
  所以 `xformMat` 被乘成单位阵、累计行随之归零；
- 未变换时整行灰显、两个按钮禁用，不至于让人以为"已经动过"。

实测（`_t/probe_acc.html`，真机 246k/190k 点）：

| 步骤 | 断言 | 结果 |
| --- | --- | --- |
| 初始 | 文本「无（仍是载入时的位姿）」，两个按钮灰显 | PASS |
| 应用 T(100,200,300) | 累计显示 `R 0.0° / T (100.0, 200.0, 300.0)`，矩阵框已归零 | PASS |
| 再应用 Rz30° + T(10,0,0) | 累计 `R 30.0° / T (-3.4, 223.2, 300.0)`，与手算 `M2×M1` 偏差 **0.000 mm** | PASS |
| 点「还原」 | 累计归零，包围盒完全回到初始 z=[-3484.3, -3271.2] | PASS |

版本 `1.0.4.3 → 1.0.4.4`。

---

## 2026-11-14（周六）｜`ui.js` 事故重建 + 变换信息归位到属性面板

**v1.0.5.0**

### 事故与恢复

用 PowerShell 做"整段替换"时，`$t2 = $t.Substring(0,$i) + $new + $t.Substring($j)`
里的 `$j` 因锚点未命中算成 -1，`Substring` 抛异常让 `$t2` 变成 `$null`，
而同一行的 `WriteAllText($p, $t2)` 仍被执行 —— **`js/ui.js` 被截断成 0 字节**。

检索过但没找到备份：git 的 dangling 对象（只有 v1.0.1.6）、Chrome HTTP 缓存、
`$env:TEMP`、IDE local history。git HEAD 停在 `1.0.3.2`，与工作区差约 1750 行。

最终按 CHANGELOG 从 `1.0.3.2` 逐项重做了 `v1.0.3.5 → 1.0.4.4` 的改动：

- 粗配准候选链：PCA 24 假设 + `screen()` 粗筛取前 5（质心对齐强制保留）+ 参数收敛
- ICP 提速：初值残差 < 容差 30% 时收紧容差并 `trimBoost 0.5`、收尾轮 `trimBoost 0`
- 验证分帧（每帧一个候选）、已对齐时跳过全局搜索（含基准 LCP 缓存与文案）
- N-N 选点：显式 `pid` 配对、删点（联动/单侧）、右上角浮动表格、预览态坐标换算
- 标签层：`paintMarks` 公共实现、跟帧（`app.onAfterRender`）、工具拾取 P 标签
- **ICP 收敛后直接烘焙**（`applyXformToLayer`）—— 这条之前漏了，症状是"ICP 报
  RMS 0.048 但包围盒没动，第二轮被当成未对齐"，回归立刻抓到

> 教训：**不再用字符串拼接做整段替换**。此后一律走带唯一匹配校验的编辑工具；
> `Substring` 的返回值必须先校验再落盘（这次就是"异常 + 继续写"造成的清空）。

### 变换信息归位：属性面板（按用户定稿）

原来的 `v1.0.4.4` 把「累计变换 + 历史 + 复制/还原」放在**数据对齐面板**，
用户指出分工不对 —— 状态属于图层，操作才属于配准面板。改为：

| 位置 | 角色 | 内容 |
| --- | --- | --- |
| **属性面板** | 状态 + 台账（只读 + 三个操作） | `R 1.2° T (…)`、`N 步`、展开看每步 `{label, 增量}`、`复制 / 撤销 / 逆变换` |
| **数据对齐面板** | 只管增量 | 矩阵框仍只承载「待应用的增量」，应用后归零；`#xform-acc` 整块删除 |

配套实现：

- `layer.xformSteps`（每应用一次记 `{label, mat}`，上限 20 步）——
  数据本身就在图层上，`layer.xformMat` 管总和、`xformSteps` 管逐步；
- `applyXformToLayer(m, label, layerOverride)` 新增第三个参数：
  属性面板操作的是**选中图层**，而默认目标是**数据对齐的目标层**，两者可能不同，
  不传就会把撤销作用到别的图层上；
- 撤销走 LIFO（只允许退最后一步）：应用 `inv(最后一步)` 后，把"撤销"自己
  产生的那条台账也弹掉；逆变换清空台账；
- 属性面板的刷新时机有两处坑：
  ① `applyXformToLayer` 里 `renderProps()` 发生在 `recordXformStep` **之前**，
  不补刷就永远少一步（实测"应用两次显示 1 步"）；
  ② 补刷时只能用**选中图层**，否则会把别的图层的账刷到面板上。

实测（`_t/probe_prop.html`，真机 246k/190k 点）：

| 步骤 | 断言 | 结果 |
| --- | --- | --- |
| 初始 | `—（载入时的位姿）`，三个按钮全灰 | PASS |
| 应用 T(100,200,300) | `R 0.0° T (100.0, 200.0, 300.0)`、`1 步` | PASS |
| 再应用 Rz30° + T(10,0,0) | `R 30.0° T (-3.4, 223.2, 300.0)`、`2 步`（= M2×M1） | PASS |
| 展开 | 台账 2 行，首行「N-N 配准」 | PASS |
| 撤销 | 回到 `R 0.0° …`、`1 步` | PASS |
| 逆变换 | 回到载入时位姿，bbox 与初始完全一致 | PASS |

回归（重建后）：

| 项 | 结果 |
| --- | --- |
| 选点表格 / 联动删除 / 单侧删除 / 拖动 | 全 PASS（残差 21.368 / 22.485 / 11.281） |
| 工具拾取标签 | 4 个 `P1..P4`、位置偏差 0、`active=3 idle=1`、旋转后跟随 |
| ICP 单轮 / 已对齐 | 9.4s·RMS 0.0476 / 5.7s·RMS 0.0478 |
| 已对齐再跑 4PCS+ICP | 10.8s → **4.9s**，RMS 0.0477 → 0.0479（未被推歪） |

### 复查：发布前的一次全线体检（1.0.3.3）

重建之后又叠了新设计，发布前做了一次完整复查：静态审查 + 五条真机探针。

**查出并修掉的三处：**

1. **残留的 `startPickMarkLoop` / `stopPickMarkLoop`（隐患，不是死代码那么简单）**。
   它们是"定时器刷新"时代的注册/注销入口，重建时我改成了操作 `app.onAfterRender`。
   而 `init` 里已经常驻注册了一次 —— 一旦有调用点走到 `stop`，`onAfterRender` 会被置 null，
   **此后标签再也不跟帧**（没有任何路径会重新注册）。当前没有调用点，但这是个埋着的雷：
   删掉两个函数，注册点只留 `init` 一处。
2. **ICP 烘焙没显式指定图层**。`applyXformToLayer(res.mat, 'ICP 精配准')` 依赖
   `xformTargetLayer()` 解析（优先 `icp-dst`）—— 分析与实现一致，但多一层间接：
   ICP 手里明明有 `dstLay`，直接传进去，少一处"两个下拉是否同步"的隐含前提。
3. **属性面板的「逆变换」没有确认**。它一次点击就把整条配准链（N-N + ICP）抹平，
   而且台账清空后连"撤销上一步"都不行 —— 误点代价是重跑几分钟。
   改成两步确认：第一次点击按钮变红底「确认？」，3 秒内再点才执行，超时自动复位。

**核对过但确认没问题（记录口径，避免以后重复怀疑）：**

| 项 | 结论 |
| --- | --- |
| 顶层函数重复定义 | 无（`endDrag` / `done` / `move` / `up` 是嵌套函数，属正常） |
| 关键符号是否都有定义 | 20 个新增符号全部「定义 1 处 + 引用 ≥1 处」 |
| `renderProps` 早退路径 | 无选中图层时会隐藏全部 `prop-row`（含「变换」行），不会残留上一层的值 |
| `pickDisplayPos` / `pickToData` 的矩阵换算 | 传入 3 元素数组，`xformPoints` 的循环正好跑一轮，语义正确 |
| `paintMarks` 的视图数 | 走 `app.settings.singleView`（字段存在），单视图不会产生幽灵标签 |
| 表格 DOM 归属 | `#pick-table` 挂在 `body`、`position: fixed`，`index.html` 无残留静态节点 |
| 标签视觉的 CSS 选择器 | 已从 `#pick-marks .pick-mark` 解耦为 `.pick-mark`，`#tool-marks` 共享同一套 |

**回归（全部 PASS）：**

| 探针 | 结果 |
| --- | --- |
| `probe_run`（ICP 两轮） | 10.9s·RMS 0.0480 / 5.8s·RMS 0.0480 |
| `probe_nn_icp`（已对齐再跑） | 8.2s → **3.9s**，RMS 0.0481 → 0.0477 |
| `probe_table`（表格 / 删点 / 拖动） | 3 行残差正确；联动与单侧删除后 `pid` 不重排；拖动 (-120,+60) px |
| `probe_prop`（属性面板） | 6 项 + 新增「首次点击只要求确认」共 7 项 PASS |
| `probe_marks`（标签跟随） | 位移 (10.5,7.5) px vs 期望一致（偏差 0.06 px）；预览态点标签所在像素 → 新标签偏差 0.00 px |
| `probe_pick`（拾取标签） | `P1..P4`、偏差 0、`active=3 idle=1` |
| `probe_lag`（跟帧延迟） | avg **3.4ms** / max 11.9ms → 同帧 |
| `read_lints` | `js/`、`css/`、`index.html` 全 0 报错 |

> 版本号按「git 最新提交末位 +1」：`git HEAD` 为 `1.0.3.2` → 本次发布 **`1.0.3.3`**。
> 本文上面 `v1.0.3.5` ~ `v1.0.5.0` 的小节是同一批未提交改动内的过程记录，对外不单独发版。

## 2026-11-14（周六）｜界面设计复盘：按任务流重排入口

**v1.0.3.4**

以"软件设计"为口径做了一次复盘（信息架构 / 入口分组 / 浮层规则 / 反馈），按 P0→P2 逐项落地。

### P0：会误操作或错位

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | 「清空」与「适应」并列、样式无差别 | danger 色（平时压暗、悬停转红）+ 与「适应」之间加分隔线 |
| 2 | 选点表格挂在 `body` 且 `fixed`，侧栏拖宽 / 日志拖高后就飘 | 改挂 `#view-area` + `absolute`；拖动时把 `getBoundingClientRect()` 减去视图区原点再换算 `left/top` |
| 3 | 拾取面板与选点表格都贴右上角，完全重叠 | 新增 `positionRegTable()`：拾取面板可见时把表格推到它下方，隐藏时回收；用户拖动过则不再自动排布 |
| 4 | 「算矩阵」与「应用」的因果不显式：N-N 只算不应用、ICP 收敛即烘焙，且「应用」常滚出视野 | 新增**待应用横幅**（面板顶部 sticky）：`待应用 · R 0.9° T(…)` + 一键「应用 / 丢弃」 |

### P1：效率

| # | 问题 | 处置 |
| --- | --- | --- |
| 5 | 顶栏 8 个入口平铺，频次与危险性混在一起 | 按任务流分组：`载入 │ 单窗 适应 │ 截图 导出 │ 工具 插件 │ 清空`；分隔线从 `var(--line)` 提到 `var(--dim) + .45`（原来的线在深色底上几乎看不见，分组等于没有） |
| 6 | 矩阵区 16 格 + 4 按钮占了面板近一半高度 | 标题行可点击收放，右侧常显摘要（`单位阵` / `R 0.9° T(…)`，有待应用时转强调色） |
| 7 | 进度条贴底，日志面板一展开就被压住 | 移到顶部中央（`top:52px`，错开视图标签），并加耗时（≥1s 才显示，避免短任务闪 "0 ms"） |

### P2：打磨

8. 属性面板空态改为可操作的两行：「在场景树中选择一个图层，或把 STL / 点云文件拖到视图区」。
9. **未采纳**「按钮上标 `kbd`」：顶栏 `title` 已写快捷键、工具菜单里有 kbd 角标，
   再加会把 8 个按钮撑宽，收益不抵改动面。

### 一次自我纠正

评审里"清空无确认""ICP 缺取消"两条**都不准确** —— 代码里早就有
（`App.clearAll` 内部就调 `showConfirm`；`icp-run` 运行中再点即 `cancelICP`）。

更直接的教训是：我按这个错误结论动手时，在 `btn-clear` 外层又套了一层 `showConfirm`，
结果要连点两次「确定」才生效 —— 回归探针（点一次 → 图层数没变）当场抓到。
现在只保留按钮侧的视觉改动，确认框仍由 `clearAll` 负责，文案补成
「此操作不可撤销，建议先导出需要保留的数据」。

> **评审也要以代码为准**，不能凭界面印象下结论。这次每一条都配了探针，就是为了避免
> "改了个已存在的东西"。

### 探针

| 探针 | 覆盖 | 结果 |
| --- | --- | --- |
| `_t/probe_p0.html` | 横幅显/隐/丢弃、表格挂载与堆叠、清空确认与取消 | 10 项全 PASS |
| `_t/probe_p1.html` | 顶栏分组顺序、矩阵折叠与摘要联动、横幅应用、进度条位置与耗时 | 8 项全 PASS |

回归：选点表格（含拖动 -120,+60）、属性面板 7 项、拾取标签 3 项、
ICP 8.1s / 4.2s·RMS 0.0479 —— 与改动前一致。

### 同一批追加：浅色首帧闪烁 + 「适应」的时机

#### 1. 浅色模式刷新时闪一下暗色

CSS 默认是深色，主题要等 `app.init()` 之后（DOM 已经绘制完）才由 `setTheme` 切过来。
两层都得在**首帧之前**定下来：

| 层 | 问题 | 处置 |
| --- | --- | --- |
| DOM | `theme-light` 打在 `<body>` 上，而 body 要等解析到才存在 | 内联脚本移进 `<head>`，只给 `<html>` 打标记；CSS 的浅色变量从 `body.theme-light` 改为 `html.theme-light`（25 处） |
| canvas | `settings.bg` 构造期只看 `?theme=`，不看 localStorage | 构造期按「URL → localStorage → 深色」三级判定，首帧清屏就是浅色 |

实测（`_t/probe_theme.html`，5 项全 PASS），关键一项是**真实用户路径**：
localStorage 记住 `light` → 重新加载 → `<html>` 首帧即带 `theme-light`、
`settings.bg[0] = 0.933`（浅色背景），不再有中间态。

> 探针自己踩过一次坑：重载 iframe 后只判断「图层数 == 1」会**立刻命中的旧文档**
> （旧文档同样有 1 图层），于是读到的是重载前的状态、误判为 FAIL。
> 改用「新文档 URL 里没有 `theme=light`」来区分新旧文档后才正确。

#### 2. 「适应」的时机

原判据是 `this.layers.length === 0`（全局无图层）：双窗先载 A、再载 B 时全局已非空，
第二次不 fit —— 视图 1 的相机停在兜底距离 500，B 稍大或稍远就"载入成功但看不到"。

改成「**该视图导入前是空的**」（新增 `viewHasLayers(vi)`），但顺着这条线挖到一个更深的问题：

**双窗共享同一个相机对象**（构造期 `camera: sharedCam`，为"同视角对比"设计）。
于是 `fitView(0)` 框 A、`fitView(1)` 框 B 会**互相覆盖**，后执行的赢 ——
实测 a / b 相距 3 米时，两个视图的相机 target 都停在 b（z = -3378），
**视图 0 里的 a 完全不在画面内**。

处置：

- `mergedSlots()` 取所有视图 slots 的并集；`fitView` 增加第三参 `slotsOverride`；
- 同步相机（默认）时**只 fit 一次并集**；关掉「同步视角」（`opt-sync`）后才分别 fit；
- 单窗时 `mergedSlots` 直接返回全选 —— 视图 0 的 slots 是 `{A,S}` 不含 B，
  只载入 B 槽文件时会框不到它（同样表现为"看不到"）。

实测（`_t/probe_fit.html`）：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 双窗载入 a + b（相距 3 米） | 两视图 target 都在 -3378（只看到 b） | 都在 **-1864**（≈ 中点 -1835，两片都在画面内） |
| 单窗只载入 B 槽文件 | 相机停在默认距离 | target -3378、distance 1428（框住 B） |

#### 3. 顺带

应用矩阵成功后状态栏提示「按 F 可重新适应视图」—— 应用会移动数据，
但自动 fit 会打断正在对比的画面，所以只提示、不强制。

回归：ICP 7.8s / 4.0s·RMS 0.0482；选点表格（含拖动）、属性面板、拾取标签、
P0 探针 10 项 —— 与改动前一致。

### 同一批追加（二）：属性面板的 R/T 显示 + 鼠标键位体检

#### 1. 属性面板「变换」：R 与 T 严格分开、精度一致、载入时给单位阵

| 问题 | 原状 | 现在 |
| --- | --- | --- |
| R 与 T 混在一行 | `R 1.2°  T (556.3, -3387.1, -181.0)` | 分两行，前缀宽度固定、数值起点对齐：`R  1.2°` / `T  556.3, -3387.1, -181.0` |
| 精度不一致 | 主行 `R 1 位 / T 1 位`，历史行 `R 1 位 / T **0 位**` —— 同一个数字显示成 `556.3` 与 `556` | 两条路径统一 1 位；历史行用紧凑格式（去括号与逗号空格）以便一行放下 |
| 载入时显示空白 | `—（载入时的位姿）` | 直接给出单位阵位姿 `R  0.0°` / `T  0.0, 0.0, 0.0`（灰显） |

> 空白让人分不清"没动过"和"没读到"；`0.0` 是确切答案。灰显表示"相对载入时没有变化"。

#### 2. 鼠标键位体检：两处真实冲突已修

把当前绑定全列出来后，发现两个**没有被互斥保护**的组合：

| 冲突 | 现象（探针实测） | 处置 |
| --- | --- | --- |
| N-N 选点 + 工具拾取同时开 | 左键单击 → `R/A` 标签 +0、拾取点 **+1**（选点那半没配好层就 return，拾取那半照常执行） | 两种模式**互斥**：新增 `setRegMode()`，进选点自动关拾取；`btn-pick` 进拾取先退选点 |
| 选点模式下 Ctrl+单击 / 双击 | 相机旋转中心被改（位移 1866），而用户以为只是在选点 | app 新增 `suppressPick` 开关，选点期间挡住"Ctrl+单击设中心""双击设中心""加拾取点" |

`suppressPick` 由 ui 控制、app 只读 —— 分层不变（app 不判断 UI 模式，只认开关）。

**当前键位全貌**（体检结论）：

| 输入 | 作用 | 备注 |
| --- | --- | --- |
| 左键拖 | 轨道旋转 | 位移 > 5px 才算拖 |
| 左键单击 | 选点 / 拾取 / 设旋转中心（Ctrl） | 三者已互斥 |
| 中键拖 | 平移 | |
| 右键拖 | 平移 | 与中键**完全重复**（见下） |
| 滚轮 | 缩放 | |
| 双击表面 | 设旋转中心 | 拾取/选点模式下不生效 |
| 双击空白 | 该视图自适应 | 同上 |

有两处**冗余但暂不处理**，理由记在这里：

- **中键与右键都是平移**：右键平移是通用习惯，中键在笔记本触控板上常常不存在 —— 保留冗余是有意的。
  代价是右键语义被占，将来想加"右键菜单 / 右键取消"需要改契约。
- **设旋转中心有三个入口**（Ctrl+单击 / 双击 / 工具菜单里的「重设旋转中心」按钮）：
  双击是主路径、Ctrl 是快捷、按钮对新手友好。`pickMode` 用完即清（代码里已有），
  唯一不足是**按钮按下后没有视觉反馈**，用户不知道下一次单击会改中心（已列入待办）。

**实测（`_t/probe_mouse.html`，模拟真实指针事件）**：

| 场景 | 结果 |
| --- | --- |
| 仅拾取模式单击 | 拾取点 +1、`R/A` 标签 0 → PASS |
| 再进 N-N 选点 | `pickInfo=false`、`suppressPick=true`（互斥生效） |
| 选点模式单击 | `R/A` 标签 +1、拾取点 +0 → PASS |
| 选点模式 Ctrl+单击 | 旋转中心位移 **0.000**、选点 +1 → PASS |
| 选点模式双击 | 标签 +2（两次单击各一点）、中心不变 → PASS |

属性面板探针（`_t/probe_prop.html`）同步更新为按 R/T 两行断言，7 项全 PASS。

### 同一批追加（三）：修「矩阵尚未应用」横幅一直显示

**现象**：数据对齐面板顶部那条「待应用 · …」横幅，即使矩阵框是单位阵也一直挂着。

**根因不在于 `refreshApplyState` 的判断，而在于 CSS**：

样式表里**从来没有全局 `.hidden` 规则**，只有零散的 `#progress.hidden`、`#pickbar.hidden`、
`.modal.hidden` 这些按组件补的。我新加的横幅是：

```css
.xform-pending { display: flex; }   /* 组件自己要 flex */
```

而 HTML 里写的是 `class="xform-pending hidden"` —— `.hidden` 没有任何规则能盖住
`display: flex`，于是 class 加了、元素照样显示。JS 那边 `classList.add('hidden')`
执行得好好的，视觉上却毫无变化。

**顺带发现同一类问题的第二处**：矩阵区折叠（`#xform-matrix-body`）也完全没生效 ——
它同样没有 `display` 规则能配 `.hidden`。这一处更隐蔽，因为**探针只断言了 class**：

```js
function hidden(node) { return !node.classList.contains('hidden'); }  // ← 只看 class
```

`class` 在 → 探针 PASS，元素其实还摊在那儿。也就是说 v1.0.3.4 里"矩阵区可折叠"
这个功能从一上线就是坏的，而当时那条 `[C] 可折叠 PASS` 是假的。

**修法**：给 `.hidden` 一个统一定义，新组件不必再逐个补：

```css
.hidden { display: none !important; }
```

`!important` 是为了盖住组件自身的 `display: flex / block`；已验证不影响
`#pick-table`（用内联 `style.display` 切换）、`#pickbar`、`#progress`、`#modal` 等原有显隐。

**探针同步改为查 `getComputedStyle().display`**，不再只看 class：

| 断言 | 修复前 | 修复后 |
| --- | --- | --- |
| 横幅初始 | `hidden=true` 但 `display=flex`（实际显示） | `hidden=true`、`display=none` |
| 有矩阵时 | `display=flex` | `display=flex` |
| 矩阵区折叠 | `hidden=true` 但 `display=block`（没折叠） | `display=none` |

> 教训：**`classList.contains('hidden')` 不能当"看不见"的证据**。
> 视觉类断言必须落到 computedStyle 上，否则测的是"我加了类"而不是"它隐藏了"。

### 同一批追加（四）：自动赋色重做（P0/P1/P2 已做，P3 保留）

原规则：`PALETTE` 按槽位分 A 蓝 / B 橙 / S 绿，每组 **4 色**轮转；其余颜色写死。

**P0 修 bug**

| 项 | 原状 | 现在 |
| --- | --- | --- |
| 背面色 | `backColor: '#b03a30'`（红）而 `backColorRgb` 是灰 `#6b7078` —— hex 与 rgb 不一致，渲染只用 rgb 所以没暴露 | 两者统一；深色 `#6b7078`、浅色 `#7a828c` |
| 顶点色 | 恒为 `#f2f3fa` 近白，**浅色主题下等于隐形** | 深色 `#f2f3fa`、浅色 `#3a4048` |

**P1 可读性**

- **线框 / 边界从主色派生**：线框 = 主色提亮 30%（浅色改压暗 18%）、边界 = 主色压暗 30%（浅色 45%）。
  原来是全局固定 `#2f9df0` / `#22d3ee` —— 三个图层叠在一起时线框全是同一个蓝，分不清属于谁。
- **调色板 4 → 6 色并拉开色相**：原来 4 个蓝挤在 200°~215°，第 5 个图层就开始撞色，
  而人眼对同色系内的细微差别几乎不敏感。

**P2 主题适配**（此前深浅两套完全相同）

```js
PALETTE.dark .A = ['#4da3ff', '#2eccb5', '#9b8cff', '#4dc9ff', '#6f8dff', '#38b6d6']
PALETTE.light.A = ['#1f6fd0', '#0e8a78', '#5b47c4', '#1a86b8', '#3a5fd0', '#0f7f9c']
```

- `pickColor()` 按当前主题取色，并把**索引**记在图层上（`autoIdx`）；
- 切主题时 `recolorLayers()` 遍历图层，把自动色换到另一套色卡的**同索引**位置 ——
  否则深色下第 3 个图层是紫的，切到浅色会变成别的色相，用户会以为数据变了；
- 用户手动改过**任意一项**颜色 → `autoColor = false`，整层不再跟随主题（不去覆盖他的选择）；
- 顶点云青色也分两档（`#22d3ee` / `#0e8a9c`）。

**P3 保留现状**：同一文件跨槽（A/B）共享一份显示属性，**两侧同色**。
这是有意的——同一模型两侧表现一致，靠位置区分左右；已写进 GUIDE，避免被当成 bug。

**踩过的坑**：第一版派生色调了 `global.MV.ui.rgbToHex`，而 `MV.ui` 只导出了 `hexToRgb`
（`rgbToHex` 在 `MV.util` 上）→ 创建图层时抛 TypeError，**整个页面初始化失败**，
探针只能报 TIMEOUT。改成 `MV.util` 后正常。这类"导出表与使用点不一致"的错误没有编译期检查，
只能靠跑一次端到端来暴露。

**实测（`_t/probe_color.html`，真机，双窗 A/B）**

| 阶段 | 结果 |
| --- | --- |
| 深色 | A `#4da3ff` / B `#ffb347`；线框 `#82bfff` / `#ffca7e`（同族提亮）；边界 `#3672b3` / `#b37d32`；顶点 `#f2f3fa`；背面 `#6b7078` |
| 背面一致性 | hex 与 rgb 反算结果完全相同 |
| 切浅色 | A `#1f6fd0` / B `#c47a10`（同索引换卡）；顶点 `#3a4048`；背面 `#7a828c` |
| 手动改色后切主题 | `#00ff00` 未被覆盖 |

回归：ICP 8.3s·RMS 0.0478 / 4.0s·RMS 0.0478；选点表格、属性面板、P0 探针、鼠标键位 —— 全部一致。

### 同一批追加（五）：查清"粗配准结果不稳定"，根因在 ICP 采样

用户反馈粗配准结果不稳定。逐段隔离测试后，结论和直觉相反：

| 环节 | 是否确定 | 证据（同一输入连跑 5 次） |
| --- | --- | --- |
| 4PCS 搜索 | ✅ 完全确定 | LCP 恒为 0.9480、平移恒为 `(346.94, -3418.37, -61.09)`、轮数恒为 30/30 |
| 候选验证器 `createVerifier` | ✅ 确定 | 同一矩阵 5 次打分 rms 都是 2.138031、参与点都是 7465 |
| PCA 候选 / 粗筛 `screen` | ✅ 确定（固定子集） | 代码走 `take()` 固定采样 |
| **ICP 求解器 `createSolver`** | ❌ **每次不同** | 同一初值 3 次：rms = **1.258051 / 1.261276 / 1.265164**，参与点 200876 / 200760 / 200785 |

根因在 `js/algo.js` 的 ICP 下采样：

```js
var pj = pi3 + Math.floor(Math.random() * (nSrc - pi3));   // ← 每次采样点集都不同
```

采样到的点不同 → 参与点数变 → RMS 变 → 停滞早停的触发时机也变（迭代 10~15 次跳），
最终表现就是"同一对数据，配准结果时好时坏"。**粗配准本身是稳定的，抖的是它之后那一步。**

**修法**：换成固定种子的 mulberry32（`icpSeed` / `icpRand`），每次构造求解器从同一个种子重播；
需要另一组采样时传 `opts.seed`。

**实测对比（同一初值 3 次）**

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| ICP rms | 1.258051 / 1.261276 / 1.265164 | **1.254148 / 1.254148 / 1.254148** |
| 参与点 | 200876 / 200760 / 200785 | 200957 / 200957 / 200957 |

**端到端（连跑两遍完整 ICP 流程）**

| 项 | 修复前（多轮观察） | 修复后 |
| --- | --- | --- |
| 第 1 轮 | RMS 0.0478~0.0485 跳，迭代 11~15 次 | **11 次 · RMS 0.0479 · 参与 109028**（两遍完全一致） |
| 第 2 轮 | 同上 | **10 次 · RMS 0.0480 · 参与 109015**（两遍完全一致） |

**顺带查清一个误解**：`max_time_seconds: 8` 这个时间预算**实际上不生效**。
`performSteps` 里 `if (fraction >= 0.99) break;` 只跳出**内层** for，
紧接着 `this.currentTrial = end` 是无条件赋值 —— 所以 30 轮总会跑完，
只是每轮可能提前收尾。写这条注释的人（我）当时以为它会截断轮数。

> 这反而是好事：正因为时间预算没生效，4PCS 的 30 轮才是恒定的，结果才可复现。
> 如果真要支持"按时长截断"，得把 `currentTrial` 改成按实际完成轮数计，
> 那时就必须接受"机器快慢影响结果"。目前保持现状并在注释里写明。

### 同一批追加（六）：无法向输入时的配准能力（复核，未改代码）

问题：输入没有法向时，配准还生效吗？

**结论：生效，但退化为点到点，精度约为点到面的 1/4。**

先看数据从哪来（`icpSample()`）：

| 图层类型 | 法向来源 | 无法向的情形 |
| --- | --- | --- |
| 网格（STL/OBJ/PLY） | 现场 `computeVertexNormals` 计算 | 不会——总是有 |
| 点云 | 直接取文件的 `data.normals` | **纯 xyz 点云（无 3 列法向数据）→ null** |

所以"没有法向"只发生在**点云文件本身不带法向列**时。

算法侧的退化路径（`createSolver` 主循环）本来就写了：

```js
if (hasDstN && hasSrcN && dot < normalThresh) continue;   // 只有双方都有法向才用法向门限
if (hasDstN || hasSrcN) { …点到面（法向）项… }
else { addRow6(A, b, 0, pz, -py, 1, 0, 0, -dx); … }      // 双方都无 → 点到点
```

**实测（同一初值、同一批点，只切换有没有法向；真机 232k / 247k 点）**

| 项 | 无法向（点到点） | 有法向（点到面） |
| --- | --- | --- |
| 4PCS 粗配准 | LCP 0.9272（**不依赖法向**，只用位置） | 同 |
| ICP RMS | **1.4143** | **0.3547**（差约 4 倍） |
| 参与点 | 68589 | 68140（同量级，没有"点太少"问题） |
| 迭代 | 35 次仍未收敛 | **8 次早停** |

也就是说：**能跑、点够多、不报错**，但点到点收敛慢、容易停在更差的局部极小。
界面上原有的一行提示（`无法向，退化为点到点`）正是这个状态。

**未做（可选改进）**：给点云估算法向（邻域 PCA / 法向平滑），让点到面也能用于纯 xyz 点云。
成本是一个 `estimatePointNormals(pos, k)` + 载入时调用一次（247k 点约几十毫秒），
但会引入"估算出来的法向本身有噪声"的新问题（需要按曲率/邻域质量过滤），
所以本轮只记录现状，不改行为。

## 附录 A：当前文件规模（2026-11-13）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `js/ui.js` | 7721 | 场景树、属性面板、数据对齐、日志、载入历史、拖拽 + 纯工具函数 |
| `js/algo.js` | 4177 | 三角求交、拾取、裁剪、分块索引、ICP、Super4PCS |
| `css/style.css` | 3534 | 深浅两套主题变量与全部部件样式 |
| `js/render.js` | 2730 | WebGL2 渲染、分块、相机、视角器 |
| `js/io.js` | 2692 | STL / OBJ / PLY / OFF / PCD / GLB 解析与导出、内存预检 |
| `js/app.js` | 2766 | 应用编排、图层与相机、截图合成、导出触发 |
| `js/core.js` | 675 | 数学（向量 / 矩阵 / 四元数 / 包围盒）+ KD 树 |
| `index.html` | 731 | 单页入口 |
| `js/plugins/optimize.js` | 345 | 孔位优化插件 |
| `js/keys.js` | 307 | 快捷键表、Esc 分层退出、帮助面板生成 |
| `check.ps1` | 257 | 冒烟测试（8 个场景） |
| `js/plugins/registry.js` | 57 | 插件注册表 |

合并后的分层（自上而下单向依赖，下层不反向引用上层）：

```
app.js            编排：建图层、串流程
  ├── ui.js       界面：DOM 与交互（不碰 GL）
  ├── render.js   渲染：只负责画
  └── algo.js     算法：纯计算（不碰 DOM / GL）
        ├── io.js        解析：文件 → 内存数据
        └── core.js      基础：数学与数据结构
```

`algo.js` 里 `MV.icp` / `MV.super4pcs` 是两段独立的 IIFE，同文件但互不内联；
`algo` / `render` / `ui` 都通过 `MV.<模块>.installAppMethods` 往 `App` 原型注入方法，
这样底层可以在 `App` 定义之前加载 —— 这是这套分层能在零构建前提下成立的关键。

`ui.js` 里的纯工具函数段（`fmtMat` / `mat4Invert` / `isRigidMat` 等）仍然挂
`MV.util`，不挂 `MV.ui.util` —— 后者会被 `ui.js` 末尾的 `global.MV.ui = { ... }`
整块覆盖。

---

## 评估记录：4PCS 是否该用上法向（2026-11-15）

**结论：保持现状（不用法向）。** 本节只记录评估过程，未改任何产品代码。

**当前状态**：`MV.super4pcs` 完全不使用法向 —— 官方两个相关参数
`max_normal_difference` / `max_angle` 都是 `-1`（关闭），法向分箱那一维在修
7³ 量化缺陷时已移除（见 `PositionHash3D` 注释）。

**实测**（`_t/probe_normal_signal.html`，真机 232k / 247k 顶点，
用 4PCS 最优解 LCP 0.9272 对齐后抽样 3009 点，`delta` = 16.9mm）：

| 分类 | 数量 | 占比 |
| --- | --- | --- |
| A　距离 ≤ delta 且 法向 ≤ 30° | 2644 | 87.9% |
| B　距离 ≤ delta 但 法向 > 30° | 134 | 4.5% |
| C　距离 > delta 但 法向 ≤ 30° | 11 | 0.4% |
| D　都不满足 | 220 | 7.3% |

距离命中点（2778 个）的**法向一致率 95.2%**，夹角中位 **4.1°**、P90 25.0°。

也就是说：**法向是高度一致的冗余信号** —— 正确位姿下它本来就对齐，
拿它过滤几乎不丢真解，但也没什么伪解可去。

**逐位置评估**

| 可用位置 | 收益 | 风险 | 判断 |
| --- | --- | --- | --- |
| 点对提取（`max_angle` 过滤） | 点对数量下降 → 每轮更快 | ① 丢掉 B 类里的合法匹配；② **改变随机序列消耗 → 破坏刚做完的可复现性** | 不做 |
| 候选 LCP 打分（法向一致才算命中） | 更快否掉 180° 翻转这类几何等价解 | 翻转解已被 `terminate_threshold = 0.98` + 候选残差验证拦住（实测最终 RMS 0.0478） | 暂不做 |
| 最终 ICP | **已经在用**（点到面 + `normalThresh`） | — | 保持 |

**不建议默认开启的四条理由**

1. 正确解下法向已 95% 一致，没有提升空间；剩下 4.5% 正是薄板两侧"几何贴合、
   朝向相反"的点，而这批匹配置信度低，在候选验证阶段会被残差淘汰；
2. 唯一确定的收益是加速，但 4PCS 本身只要 4~7s，且"已对齐跳过搜索"的快速通道
   把常见场景压到 0.6s，边际很小；
3. 现有实现的价值之一正是**纯几何、与法向无关** —— 这保证它对双面件、翻转件、
   朝向不一致的点云仍然有效。加了法向就多一类失效模式；
4. 网格法向很可靠（中位夹角 4.1°），但**点云估算法向远达不到这个精度**，
   一旦启用，在点云场景里更可能把噪声当"方向错误"而丢真解。

**如果以后要用**：最小且可控的做法是只在 `Verify` 里把"法向一致"作为**并列命中条件**
（仅当两侧都有法向时启用、默认关闭），不动点对提取 —— 这样随机序列不变，
可复现性不受影响；开启时用参数控制并做 A/B 实测。

---

## 排查：第一次 ICP 之后再跑 ICP 会不会"配歪"（2026-11-15，v1.0.3.4）

**结论：数据不会被推歪，但界面上确实存在"显示与内部不是同一个矩阵"的问题，已修。**

### 实测（`_t/probe_icp_twice.html`，真机 232k / 247k 顶点）

| 轮次 | 增量矩阵 | RMS | B 包围盒 z | 台账 |
| --- | --- | --- | --- | --- |
| 第 1 次（未对齐） | `R 92.33°  T (556.31, -3387.09, -180.98)` | 0.0479 | `[-3484,-3271]` → `[-372,-243]` | 新增 1 条 |
| 第 2 次（已对齐） | **≈ 单位阵**（R 0.00°、T≈0） | 0.0480 | 不变 | **不新增** |

也就是说：`applyXformToLayer` 里 `positions / uniqVerts / normals` 三者都跟着变换
（`d.uniqVerts` 那行是 `icpSample` 的数据源，漏掉就会"位置是新的、法向是旧的"并直接配歪），
烘焙前也清掉了数据级预览与 `previewMat`，所以第二次 ICP 看到的就是**已经对齐的数据**，
算出的增量自然是单位阵。

### 真正修掉的两个问题

**① 属性面板显示的不是"刚被变换的那个图层"**

`renderXformProp` 读的是**选中图层**（`app.getSelected()`），而 ICP 之前不改选中。
于是目标层 b 刚被烘焙了 92°，属性面板却显示 `R 0.0° / T 0.0, 0.0, 0.0`（那是 a 的账）——
这正是"页面上显示的和算法内部不是同一个矩阵"的观感来源。

→ ICP 烘焙成功后 `app.selectLayer(dstLay.id)`，面板立刻指向被变换的层。实测修复后
属性面板显示 `R 92.3° / T 556.3, -3387.1, -181.0`，与 `layer.xformMat` 完全一致。

**② 已对齐时仍在重复烘焙**

增量≈单位阵时，原来的代码照样走一遍 `applyXformToLayer`：台账多一条
`ICP 精配准 R 0.00° T (0,0,0)`、全部顶点逐点变换一次、GPU 全量重传一次，
而结果与不动**完全等价**。

→ 先算增量再决定：`stayed = (旋转 < 0.05° && |T| < 0.01)`；成立时只清预览、不烘焙。
结果文案也分开说：「已在原位：本次增量≈单位阵（没有重复施加）」/「已把增量 … 烘焙到 …」。

**③ 顺手把矩阵框的语义写进 `title`**

矩阵框标题的悬停提示改为「这里是「待应用的增量」：应用后归零。该图层累计被变过多少，
见属性面板的「变换」行」—— 三处显示（矩阵框 / 属性面板 / 实际数据）的关系一次说清。

### 回归

| 探针 | 结果 |
| --- | --- |
| `probe_icp_twice` | 第一次烘焙 92.33°；第二次增量≈单位阵、台账不新增、bbox 不变；属性面板与内部一致 |
| `probe_run`（单次 ICP 两轮） | 8.2s·RMS 0.0479 / 4.1s·RMS 0.0480（首次仍正常烘焙） |
| `probe_nn_icp` | 8.1s / 4.0s，RMS 0.0479 → 0.0480，未被推歪 |
| `probe_prop` | 7 项全 PASS |
| `read_lints` | 0 报错 |

> 版本号按「git 最新提交末位 +1」：HEAD `bb850c6` 是 `1.0.3.3` → 本次 **`1.0.3.4`**
> （`index.html` 10 处 `?v=` 同步，缓存随之失效）。

---

## 配准期间的帧冻结：A 项优化（2026-11-15，v1.0.3.4）

**背景**：实测配准期间平均 9.6 fps、最大帧冻结 833~1050 ms。全仓 **0 处 Worker**，
所谓"分帧"只是"跑完一段同步计算 → `setTimeout` 让出"，冻结时长等于单块计算时长。

### 改了什么

| # | 改动 | 依据 | 效果（单轮/单次耗时，中位） |
| --- | --- | --- | --- |
| 1 | 4PCS `pairLimit` 12000 → 8000 | 2500 点采样云两两组合约 300 万对，取前 1.2 万与 8 千的覆盖度差异很小 | 单轮 **135 ms → 75 ms（−45%）** |
| 2 | ICP `AUTO_SAMPLE_MAX` 120000 → 74000（比例上限 ≈30%） | 12 万在 24.7 万点上取到 49%（10.9 万参与点），单轮 317 ms | 参与点 10.9 万 → **6.7 万**，单轮 −45%；**RMS 仍 0.0479** |
| 3 | 候选验证 `maxSrc 8000/12 轮` → `4000/8 轮` | 验证器只用于**排序**候选，不产出最终位姿 | 首次验证冻结 1050 → **933 ms** |
| 4 | `applyXformToLayer` 的 GPU 上传延后到下一帧 | 5 MB 上传不在"数据是否正确"的关键路径上，代价只是该层少画一帧 | 收尾段少 50~100 ms |

第 3 项只降了 117 ms，说明那 933 ms **主要不是迭代次数**，而是 V8 首次执行 ICP 热路径的
**JIT 编译 + 首次建 KD 树** —— 证据是同一段代码在第二次配准里只要 1.92 s（第一次 4.85 s）。

### 实测（真机 232k / 247k 顶点）

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 4PCS 单轮 | 135 ms | **75 ms** |
| ICP 参与点 | 108938 | 66781 |
| ICP 单轮 | ~317 ms | **~215 ms** |
| 端到端（未对齐） | 8.15 s | 7.93 s |
| 端到端（已对齐） | 5.09 s | 4.87 s |
| 最终 RMS | 0.0479 | **0.0479**（无损失） |
| 最大帧冻结 | 833~1050 ms | **933 ms**（首次，含 JIT） |
| 稳态单块冻结 | 300~317 ms | **215~300 ms** |

### 没做的两项及理由

- **烘焙整体拆帧**（把"写数据 + 重建 GPU"推到下一帧再执行）：会引出"结果已显示但数据还没写"
  的中间态，用户此时点「应用」或切层会读到半成品。只把**上传**延后，语义不变。
- **长任务熔断（超过 120 ms 强制切片）**：切片点在 `tryOneBase` / `solver.step()` 内部，
  要改算法状态机（点对构建 / 打分 / 求解分段），风险远大于收益；而第 1、2 项已把单块
  从 300/317 ms 压到 200/215 ms。

### 结论

**帧率问题进一步缓解，但没有根治。** 稳态单块已进 200 ms 级，首次配准仍有一次 ~900 ms 冻结
（JIT 编译，只发生一次）。要做到"配准期间稳定 60 fps、可自由拖视角"，只能把算法搬进
Web Worker —— 项目走 `serve.bat` 的本地 HTTP 服务，Worker 不受同源限制，方案可行，
但那是一次 300~400 行的结构性改动 + 全量回归，本次未做。

### 回归

| 探针 | 结果 |
| --- | --- |
| `probe_run` | 7.9 s·RMS 0.0479 / 4.9 s·RMS 0.0479 |
| `probe_icp_twice` | 增量 92.33°；第二次判定「已在原位」不重复烘焙；GPU 缓冲已重建、顶点数不变 |
| `probe_nn_icp` | 0.0477 / 0.0479，未被推歪 |
| `probe_prop` | 7 项全 PASS |
| `probe_table` | 选点 / 拖动 PASS |
| `read_lints` | 0 报错 |

---

## Worker 化：ICP 迭代搬到独立线程（2026-11-15，v1.0.3.5）

**背景**：A 项优化后单轮已降到 215 ms，但 30~50 轮连续跑仍是一串 200 ms 级冻结
（实测最大 1050 ms、配准期间平均 9.6 fps）。单线程下这已到极限 —— 只剩并行一条路。

### 做法

新增 `js/worker_icp.js`：

```
主线程                          Worker
  ├─ init(fixed)   ──────────▶  建全量 KD（24.7 万点）并缓存
  ├─ solve(moving) ──────────▶  createSolver（复用缓存的 KD）
  ◀──────── step{iters,rms,used,mat}   每轮
  ◀──────── done{mat,iters,rms,used,hasNormals}
  ├─ cancel        ──────────▶  置标志，循环退出
```

- **数据只传一次**：`fixed.pos/nrm` 在 `init` 时进 Worker，KD 树也只建一次（原来每建一次约 350 ms）。
- **Worker 里能加载 algo.js**：两个文件的 IIFE 都以 `(window)` 收尾、顶层零 `document` 引用，
  所以在 Worker 开头 `self.window = self` 兜一下即可 `importScripts('core.js','algo.js')`。
- **两条路径共用 `mainSolveOptions()`**：容差决策（好初值收紧到 `bestRms*3`、`trimBoost 0.5`）
  只有一份实现，否则同一份数据在 Worker/主线程会收敛到不同的迭代次数。
- **自动回退**：`Worker` 不存在或创建失败时，退回原来的 `tick` 主线程推进，行为不变。
- **取消**：`cancelICP()` 会同时通知 Worker（内部循环每轮检查标志）。

### 等价性验证（`_t/probe_worker_same.html`）

同一份数据、同一组参数，主线程与 Worker 各跑一次：

| 项 | 主线程 | Worker |
| --- | --- | --- |
| 迭代次数 | 37 | **37** |
| RMS | 0.256785 | **0.256785** |
| 参与点 | 68003 | **68003** |

→ `PASS Worker 与主线程完全等价`。

### 实测（真机 232k / 247k 顶点）

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 端到端（未对齐） | 8.2 s | **5.6 s** |
| 端到端（已对齐） | 4.9 s | **2.7 s** |
| 迭代段耗时 | 3.07 s | **1.39 s** |
| ICP 迭代期间最大帧冻结 | **300 ms** | **从"长冻结"列表消失** |
| 配准期间平均 fps | 9.6 | 14.9 |
| 剩余最大冻结 | 1050 ms | 1049 ms（**仍是候选验证**，尚未搬） |
| 最终 RMS | 0.0477~0.0479 | 0.0477~0.0479（不变） |

> 迭代段快了将近一半，主要不是因为"算得更快"，而是**去掉了主线程的
> `ITER_MIN_GAP = 50 ms` 节流** —— 原来每轮之间要等 50 ms 留给渲染，
> 在 Worker 里没这个必要（它不占主线程），于是一口气跑完。

### 还没做的一步

候选验证器（`createVerifier` + `screen` + `score`）仍在主线程，那 **1050 ms** 的首轮冻结
就来自它（含首次 JIT 编译）。Worker 协议里的 `verifyInit / score / screen` 已经写好、
只是 UI 侧还没切过去 —— 切换后配准期间应能稳定 60 fps。

### 回归

| 探针 | 结果 |
| --- | --- |
| `probe_worker_same` | 主线程 vs Worker 三项指标完全一致 |
| `probe_run` | 5.6 s·RMS 0.0477（日志已标 `· Worker`）/ 2.7 s·RMS 0.0479 |
| `probe_icp_twice` | 增量 92.33°；第二次判定「已在原位」不重复烘焙；GPU 缓冲已重建 |
| `probe_nn_icp` | 0.0477 / 0.0479 |
| `probe_prop` / `probe_table` / `probe_pick` | 全 PASS |
| `read_lints` | 0 报错 |

---

## 配准可见性与渲染性能收口（2026-11-16，v1.0.3.6）

**背景**：v1.0.3.5 把 ICP 迭代搬进 Worker 后，仍然存在三处"看起来像没生效"的问题：
不勾 4PCS 时点运行毫无反应、部分环境下配准停在准备阶段、以及适应视图四周大片留白。
排查过程中还发现一个更隐蔽的前提问题 —— **改了 JS 但 `?v=` 没变，浏览器一直用旧文件**。

### 一、修复

**① 不勾 4PCS 时配准完全不执行**

计算线程的启动点位于 `icpRunning` / `icpRunSeq` 赋值**之前**，于是：

- 按钮不会切到「终止」，`cancelICP()` 第一行就 return —— **停不掉，再点一次就是第二次启动**；
- 线程回传的每一轮位姿都被 `myRun !== icpRunSeq` 判为过期而丢弃 —— **整个配准静默地什么都不做**。

勾 4PCS 时先走粗配准分支，不经过这条快路径，所以只在"不勾 4PCS"时显形。

**② `.js` 被按 `text/plain` 返回，计算线程静默失效**

Windows 上 Python 的 `mimetypes` 会读注册表（`HKEY_CLASSES_ROOT\.js` 常为 `text/plain`），
而 `<script src>` 对此宽容、Worker 的 `importScripts` **强制要求 JS MIME**：

```
Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope':
The script at '.../js/core.js?v=1.0.3.5' failed to load.
```

表现极迷惑：线程建得出来、主线程完全流畅、一个进度都不回报。已改为硬编码静态资源 MIME，
修复后 `Content-Type: text/javascript`，`init` 立即返回 `{"type":"ready","id":1}`。

**③ 线程失败时永久挂起**

原来没有 `onerror`、没有超时。脚本加载失败或被系统挂起时 Promise 永远 pending，
界面停在"准备精配准"。现在：`onerror` 结掉所有挂起请求；握手 20 s / 求解 120 s 超时；
失效即**自动退回主线程继续算** —— 慢一点，但不会"点了没反应"。

### 二、优化

**④ 主线程迭代分片（时间切片）**

一轮迭代拆成 24000 点/片，片间让出主线程：单次冻结由约 215 ms 降到约 34 ms。
累加器跨调用保留，**数值与一次跑完逐位相同**：

| | 迭代 | RMS | 参与点 | 最大矩阵差 |
| --- | --- | --- | --- | --- |
| 一次跑完 | 30 | 3.0485997513464422 | 8000 | — |
| 每片 700 点（330 次调用） | 30 | 3.0485997513464422 | 8000 | **0** |

**⑤ 适应视图改为按实际轮廓取景**

原实现是 `distance = 包围球半径 / sin(fov/2) × 1.25`，两处留白叠加：包围球按最长对角线取，
扁长模型的实际屏幕范围远小于它；再多留 25%。现在逐角点解投影约束并做 NDC 自校正：

| 模型 | 改前 | 改后 |
| --- | --- | --- |
| 800 × 90 × 210 点云 | 相机 1362 / 占屏 **60%** | 相机 848 / 占屏 **96%** |
| 100³ 立方体 | 相机 283 / 占屏 **80%** | 相机 234 / 占屏 **96%** |

**双窗 / 单窗四种口径实测**（判据 `maxN` = 最外侧角点占视锥半宽的比例，0.96 = 留 4% 边距）：

| 模式 | 视图0 | 视图1 | 说明 |
| --- | --- | --- | --- |
| 单窗 | 0.956 | — | 按全部图层的并集取景 |
| 双窗 · 相机同步 | 0.956（并集） | 0.329 | 两窗同一相机，小模型自然占比小 —— 同视角对比的设计 |
| 双窗 · 相机独立 | 0.964（只框 A） | 0.963（只框 B） | 各框自己那一侧 |
| 双窗 · 独立 + 叠加对面 | 0.956 | 修复前 **24.7** → 修复后 0.956 | 见下 |

**修复：「叠加对面模型」时叠加层不在取景范围内**

`computeBBox` 只统计属于本视图槽位的图层，而开了叠加后对面槽位会以半透明画在本视图里。
取景把看得见的叠加层排除在外，右窗里对面模型整个落在视锥外（实测偏出 24 倍），
开关看起来像没生效。现在按与 `rayPick` 一致的判定（`ghost && slot !== 'S'`）把它计入包围盒。

> 竖向只占 50% 属于几何必然，不是留白：该模型投影后的宽高比约 2.6，视口只有 1.6，
> 宽度贴边时竖向必然空出一截。要更满只能裁掉一部分模型或改变视角。

**⑤-b 再修：包围盒角点本身就在骗人，最终改为直接投影顶点**

逐角点 + 自校正之后仍不够 —— 弧形点云的**包围盒角点落在弧内的空角上**。
最终改成最朴素的做法：把顶点投到相机坐标取 (r,u,f) 最值，中点即注视点，
再逐点解 `d >= f + |u|/tan(fovY/2)` 求距离。两遍采样（各 ≤10 万点），不迭代。

| 取景依据 | 相机 | 屏幕占比 |
| --- | --- | --- |
| 包围球 + 25% 留白 | 1394 | 39% × 28% |
| 包围盒逐角点 | — | 包围盒 85%×44%，实际形状仍 39% |
| 两遍采样 + 10% 余量 | **741** | **77% × 54%**，无贴边裁切 |

**⑥ 配色改为四通道分工**

旧方案线框 = 主色提亮 30%、顶点 = 近白、边界 = 主色压暗 30%，三者挤在同一色相上只差明度，
同时打开线框和顶点分不清。现在：面片用槽位色、线框用中性反色、顶点用面片补色、边界用固定洋红；
顶点若与边界色相差 < 50° 再转 70° 避让（青绿面的补色正好撞上洋红）。

实测 12 个槽位色 × 2 主题：线框与面片亮度差最小 **0.35**，顶点与面片色相距离 **110°~180°**，
顶点与边界 **≥ 60°**。

**⑦ 线框与顶点不再无脑全画**

一个 231,200 三角形的曲面，打开线框+顶点后的绘制量是：

| 通道 | 数量 | 原策略 |
| --- | --- | --- |
| 面片 | 462,400 三角形 | 分块视锥剔除 |
| 线框 | **347,480 条边** | 一次 draw，无剔除 |
| 顶点 | **116,281 个点** | 一次 draw，无 LOD |

现在按屏幕密度决定是否值得画：平均边长 < 2 px 不画线框、< 点径不画顶点
（缩远时线与点已经挤成色块）；顶点超过 10 万按步长抽稀（116,281 → 58,140）；
点径上限 16 px。`?density=0` 可关闭这套自适应。

**⑧ 视口里点中哪个图层，快捷键就作用于哪个图层**

`W / N / V / B` 原来只认左侧树的选中项。在视口里对着另一个图层选点、拖动之后按 `W`，
开关落在树里上一次选中的图层上，看起来像"快捷键没反应"。现在单击命中图层即设为当前对象
（只在"没拖动过的单击"时判定，旋转视角不额外 raycast）。

### 三、回归

| 项 | 结果 |
| --- | --- |
| Worker / 无 Worker 回退 / 终止 | 8 项通过，两条路径 RMS 一致（0.0000） |
| 勾 4PCS + Worker | 3 项通过，最大帧间隔 67 ms（粗配准仍在主线程） |
| 分片 vs 整轮 | iters / rms / used / 矩阵逐位一致 |
| 视口点击 → 快捷键 | `cube.showWire` 翻转、旧选中图层未受影响 |
| `check.ps1` | 8 项全 PASS |

### 四、教训：`?v=` 就是"代码是否生效"的开关

排查过程中两次量到"旧公式的数字"，原因都是 `index.html` 里的 `?v=` 没变。
`server/serve.py` 虽然发了 `Cache-Control: no-store/no-cache`，但只要有人用别的静态服务器、
或浏览器对同一 URL 复用了内存缓存，就会拿到旧 JS。
**规则：任何 `js/*.js` 改动都必须同时升 `?v=`（= 版本号），否则改等于没改。**

---

## 侧栏拖拽时分隔线不同步（2026-11-16，v1.0.3.7）

**现象**：双窗模式下拖动左侧栏改变宽度，中间的分隔线不跟着动，画面已经重排了但线还停在旧位置。

**原因**：分隔线的像素位置只在 `setSplitRatio()` 里写：

```js
var px = Math.round((area.clientWidth || 0) * ratio);
if (this._splitPx !== px) { this._splitPx = px; line.style.left = px + 'px'; }
```

而侧栏拖拽只改侧栏自身宽度：

```js
function move(e2) { side.style.flex = '0 0 ' + w + 'px'; side.style.width = w + 'px'; }
```

画布因为有 `ResizeObserver` 会自动跟上（`resize()` → 重建 drawing buffer + `updateRects`），
唯独这条 DOM 线没人通知 —— 于是只有线掉队，观感就是"更新不及时"。

**修法**：把"摆线"从 `setSplitRatio` 里抽成 `syncSplitLine()`，在 `resize()` 的尺寸变化分支里调用一次。
`splitRatio` 没变时只挪线，不重算视口、不重复 `updateRects`。

实测（模拟拖动侧栏）：

| 阶段 | 视口宽 | 线 left | 期望 | 画布缓冲 |
| --- | --- | --- | --- | --- |
| 初始 | 883 | 442 | 442 | 883×550 |
| 拖 +140（未松手） | 743 | 372 | 372 | 743×550 |
| 回拖 −60 | 943 | 472 | 472 | 943×550 |
| 比例改 0.35 | 943 | 330 | 330 | 943×550 |

---

## 图标与品牌标记（2026-11-17，v1.0.3.13）

应用图标定稿为「**点云 → 网格**」：同一个等轴测立方体，左半是点云（轮廓点 + 面内渐隐点），
右半是实心网格。左侧沿 `T→L`、`L→LB`、`LB→B` 三条棱排了一圈点，所以**左侧不画任何线**也能认出是立方体。

几个决定与依据：

| 项 | 结论 | 原因 |
| --- | --- | --- |
| 橙色 V（由底边两棱构成） | **不使用** | 与「点云/网格」的分界语义冲突，观感像钩子 |
| 橙色竖直棱 + 顶点 | **不使用** | 图标内不带橙色，整体更干净 |
| 标记尺寸 | 等比放大 **1.4×**，占画布约 63% | 原尺寸只占 45%，四周空得像个 App 图标套壳 |
| 字标 3DV | 只出现在**横向锁合** `logo-lockup-*.svg` | 图标缩到 16~24px 时字母必然糊掉 |
| 锁合笔画 | **10.5px**（原 7px），深色用 `#FFFFFF` | 7px 是「骨架线」观感，深色下几乎看不出字重 |

字标 3DV 用路径绘制（不依赖字体），`3` 为上下两段右凸圆弧（`sweep=1`），`D` 为左竖 + 右半圆（`sweep=0`）——
两个方向相反，写反会分别渲染成 `Ǝ` 和 `ꓷ`。

落地产物：

```
docs/icons/
├── app-icon-{dark,light}.svg      256×256 矢量，favicon 与顶栏标记共用
├── app-icon-{dark,light}-{16..256}.png
├── favicon.ico                    16/32/48 三个 PNG 条目
├── logo-lockup-{dark,light}.svg   384×128，图标 + 3DV（README / 关于页用）
├── preview.html                   多尺寸对照
└── overview.png
```

`index.html` 增加 favicon（SVG 优先、跟随系统深浅色，ICO 兜底）与顶栏标记；
顶栏原来的「3DV」文字徽标换成图标，`css/style.css` 里用 `html.theme-light` 切换两套图标。

---

## PLY 点云与面片解析修复（2026-11-17，v1.0.3.14）

**现象**：导入「只有顶点、没有 face 元素」的 PLY（扫描仪导出的点云）时直接失败 / 得到一个空图层。

**根因**：PLY 规范里 `face` 元素是**可选**的，但两个分支处理不一致 ——
二进制分支早就有降级（`面无数据（点云）则直接返回点`），ASCII 分支没有，
一律按 `kind: 'mesh'` 返回，于是 0 个三角形的"网格"被下游判为空。

顺带查出两个更隐蔽、且**早就存在**的面片 bug：

| # | 位置 | 问题 | 影响 |
| --- | --- | --- | --- |
| 1 | ASCII `parsePLYAscii` | 无 face 时返回空网格 | 点云 PLY 直接不可用 |
| 2 | ASCII 扇形三角化 `k = 1` 起 | 首个三角形是 `(v0,v0,v1)` 退化面 | **三角形数 = c−1 而非 c−2**：三角面翻倍、四边形得 3 个 |
| 3 | 二进制 `outPos` 按 `面数 × 9` 分配 | 四边形只放得下 1 个三角形，余下被 `stop` 截断 | 四边形/多边形面**静默丢失一半** |

修法：

- ASCII 分支：`!face || face.count === 0 || tri === 0` → 返回 `kind: 'points'`，
  `positions` 直接用读好的顶点数组（零拷贝），并按 `red/green/blue`（兼容 `r/g/b`）解析顶点色；
- 扇形三角化起点改 `k = 2`（首个三角形是 `(v0,v1,v2)`）；
- 二进制缓冲改为按「索引个数」估算：`capTri = min(maxTri, floor(面块字节 / 索引字节))`。

实测（6 组用例，35 项断言全通过）：

| 用例 | 期望 | 结果 |
| --- | --- | --- |
| ASCII 点云 + 颜色（4 点） | points / 4 / 有色 | ✅ 首点色 `1.00,0.00,0.00` |
| ASCII 点云 无颜色 | points / 4 / 无色 | ✅ |
| ASCII 1 个三角面 | mesh / 1 / 9 float | ✅（修前为 2 / 18） |
| ASCII 1 个四边形面 | mesh / 2 / 18 float | ✅（修前为 3 / 27） |
| 二进制点云 + 颜色 | points / 4 / 有色 | ✅ |
| 二进制四边形面 | mesh / 2 | ✅（修前为 1，丢一半） |

渲染验证：3000 点 ASCII PLY 点云载入后 `kind=points count=3000 colors=有`，
画面 39,722 个非背景像素（8.18%）——确实画出来了，不是只解析成功。

---

## 其余导入格式的同类问题（2026-11-17，v1.0.3.15）

PLY 修好后，把 7 个导入器逐个审了一遍：**凡是"面片可选"的格式，都有一份把合法数据判成错误的守卫**。
其中 glTF 那处不只是失败，而是**生成错误几何**。

| 格式 | 合法变体 | 修前 | 修后 |
| --- | --- | --- | --- |
| OBJ | 只有 `v`、没有 `f`（点云） | 返回 0 三角形的网格 → 下游报"文件中没有可显示的数据" | `kind:'points'` |
| OBJ | `v x y z r g b` 顶点色 | 颜色被丢弃（只能取前三列） | 解析并应用（网格按角点展开） |
| OFF / COFF | `nf = 0` | 直接 `throw 'OFF 文件里没有面片'` | `kind:'points'`（COFF 带色） |
| glTF / GLB | `mode = 0`（POINTS 点云） | **不看 mode，每 3 个顶点拼成三角形** → 垃圾几何 | 按点云载入 |
| glTF / GLB | `mode = 5 / 6`（STRIP / FAN） | 按 TRIANGLES 错拼，面片错连 | 正确三角化（strip 交替绕序） |
| glTF / GLB | `mode = 1/2/3`（LINES） | 同样被错拼成三角形 | 跳过（线段既不是面也不该当点云） |

实现要点：

- 三处降级都复用 PLY 的点云返回结构（`kind/positions/count/colors/bbox`），没有新增渲染路径；
- glTF 的 `pushPrimitive` 抽出 `emit()`，`emitTri()` 统一按索引取点，
  再按 `mode` 分派（0 点云 / 5 strip / 6 fan / 4 或未指定 → 逐三取面 / 1-3 跳过）；
- OBJ 网格的顶点色按**角点**展开（与 COFF 一致），颜色索引与顶点索引一一对应，
  混色文件里无色顶点补 `(1,1,1)`。

实测 10 组用例、40 项断言全通过：

| 用例 | 期望 | 结果 |
| --- | --- | --- |
| OBJ 只有顶点 + 顶点色 | points / 3 / 有色 | ✅ 首色 `1.00,0.00,0.00` |
| OBJ 只有顶点 无颜色 | points / 3 / 无色 | ✅ |
| OBJ 1 三角面 + 顶点色 | mesh / 1 / 有色 | ✅ |
| OFF `nf=0` | points / 3 | ✅（修前直接抛错） |
| COFF `nf=0` | points / 3 / 有色 | ✅（修前直接抛错） |
| GLB `mode=0` | points / 3 | ✅（修前得到 1 个垃圾三角形） |
| GLB `mode=0` + COLOR_0 | points / 3 / 有色 | ✅ |
| GLB `mode=5`（4 点） | mesh / 2 | ✅（修前按 1 个三角形错拼） |
| GLB `mode=6`（4 点） | mesh / 2 | ✅ |
| GLB `mode=4`（回归） | mesh / 1 | ✅ |

仍判为错误、且**应当判错**的：STL 0 个 facet（确实无内容）、PCD 缺 `x/y/z`、点云文本列数不足。

---

## 目录整理：运行时资产与文档分离（2026-11-17，同版 v1.0.3.8）

一条判据：**`docs/` 必须能整目录删除而应用照常启动**。改前它不满足 —— 顶栏标记与 favicon
都放在 `docs/icons/` 里，`index.html` 直接引用。

| 动作 | 内容 |
| --- | --- |
| 迁移 | `docs/icons/` 的 4 个运行时文件 → **`assets/icons/`**（`app-icon-{dark,light}.svg`、`favicon.ico`、`app-icon-dark-256.png`） |
| 删除 | `docs/icons/` 其余 4 个设计记录（`logo-lockup-{dark,light}.svg`、`preview.html`、`overview.png`） |
| 删除 | 11 张未被任何文件引用的 PNG（`*-{16,32,48,64,128}.png` 两套 + `light-256`） |
| 删除 | `check.ps1`、`server/test_bridge.py`（不再维护自动化冒烟测试） |
| 同步 | `index.html` 7 处路径、README 目录树、GUIDE 里对两个测试文件的引用 |

图标文件从 **19 个 / 250 KB 降到 4 个 / 52 KB**，且全部有明确引用者。
`docs/` 现在只剩 `GUIDE.md` 与 `images/`，是纯文档目录。

> 关于"图标能否由代码实时绘制"：favicon 必须在 JS 之前存在，只能当静态文件；
> 顶栏标记可以内联成 `<svg>` + CSS 变量（一份代码适配深浅主题），但会与 favicon 的样式来源分离，
> 本次未做，留作后续。

---

---

---

---

## 标注色：四通道统一为高亮色（2026-11-17，v1.0.3.8）

**诉求**：切主题时四个通道不换色、都必须是高亮色；线框要"荧光"级别的醒目；
法向用「网格法向」的渲染色；顶点默认点径略大。

### 结果

| 通道 | 改前 | 改后 |
| --- | --- | --- |
| 线框 | 按面片亮度在 `#11151c` / `#eef2f8` 二选一 | **荧光青 `#00e5ff`**，开线框时面片压暗到 **55%** |
| 顶点 | 面片补色，明度随主题 | **高亮品红 `#ff3df2`**，点径 **+1.5px**（最小 4px） |
| 边界 | `#ff2d95`（深）/ `#b8125e`（浅） | **高亮红 `#ff2d55`** |
| 法向 | `#8cedff` 硬编码 | **法线贴图编码**：`rgb = n * 0.5 + 0.5` |

四通道在两种主题下取值完全一致：

```
深色  wire=#00e5ff  vert=#ff3df2  bound=#ff2d55
浅色  wire=#00e5ff  vert=#ff3df2  bound=#ff2d55
```

### 线框：荧光青 + 压暗面片

固定单一色值不可能同时压住 36 个面片色（面片在深色主题里亮、浅色主题里暗）。
实测最小对比度：纯黑 3.14、近白 1.28、高亮青 1.04、高亮黄 1.01。

所以线框取荧光青 `#00e5ff`，**开线框时把面片压到 55%**：面片变暗后，
青线立刻"跳"出来，两个主题都是"暗面 + 荧光线"的观感（CAD 的 edges 模式）。
压暗只在线框开启时生效，不影响只看面片时的颜色。

### 法向：法线贴图编码

`rgb = n * 0.5 + 0.5`，即法线贴图的通用编码：

- `+X` → 浅红、`-X` → 深青；`+Y` → 浅绿、`-Y` → 紫；`+Z` → 浅蓝、`-Z` → 橄榄；
- 带符号，所以**法向翻转会直接变色**，一眼能看出朝向异常；
- 颜色由数据决定，不参与主题配色，深浅两套天然一致。

实现：新增 `NORMAL_VS` / `NORMAL_FS` 与 `normalP` 程序；法向缓冲从纯位置改为
`xyz + rgb` 交错布局（每个法向 12 个 float）；`drawNormals` 走独立程序。

### 顶点默认更大

同时打开面片 / 线框 / 顶点 / 边界时，3px 的点会被线和法向挤掉。
`drawVerts` 的默认点径改为 `max(4, pointSize + 1.5)`，仍受 `VERT_MAX_PX` 上限约束；
点云的默认大小不受影响（走另一条路径）。

### 清理

`rgb2hsl()` / `hsl2hex()` / `relLum()` / `lumLin()` 全部删除（约 80 行），
`applyDerivedColors()` 从 55 行缩到 18 行；`normalColor` 字段一并移除。

### 配准改为确定性求解：4PCS + ICP 与初始位姿无关（同版）

**要求**：去掉"变差就回滚"的护栏，从源头消除随机性；同一份输入（参考不变）每次点
「运行 ICP」必须得到同一个结果；4PCS 的初值也不应随目标层当前位姿变化。
**且不得为此常驻保存一份原始顶点。**

**根因**：配准是"烘焙式"的（矩阵直接写进顶点），第二次运行时 `icpSample` 拿到的是
**已经被上一次变换过**的顶点。输入变了 → 4PCS 的抽样、取基、LCP 基准全变 →
每次给出不同初值 → 越点越歪。

**修法**：把"求解坐标系"和"落地方位"分开，用**配准期间的临时复位**代替常驻副本。

| 环节 | 改前 | 改后 |
| --- | --- | --- |
| 求解输入 | 当前（已烘焙）顶点 | 临时构造 `P_orig = inv(pose) · P_cur`（法向同用 3×3 复位） |
| 求解输出 | 被当成增量 | 视为「原始 → 世界」的**绝对位姿** |
| 落地 | 直接烘焙 `res.mat` | `delta = T_abs · inv(srcPose)` |
| `initMat` 兜底 | `null`（每次从零） | `srcPose`（第二次起点＝上次的解） |
| 预览矩阵 | 直接挂绝对位姿 | 同样走 `toDelta()` |
| 护栏 | `bakeIcpIfBetter`（变差就回滚） | **已删除** |

关于内存：复位用的那份数组本来就是**批配准要复制的副本**（避免预览改写原数组），
所以峰值内存不变，运行结束即释放；图层上不保留任何多余的顶点数据。

于是：

- **4PCS 与初始位姿无关** —— 输入恒为原始位姿下的点云，基准 LCP 也是原始位姿对参考层的覆盖率；
- **幂等** —— 第二次起 `delta = T_abs · inv(T_abs) = I`，`stayed` 分支命中（< 0.05° / 0.01mm），数据一点不动；
- 预览也在同一坐标系里，第二次配准途中画面不会跳回旧位姿。

**实测**（合成点云 3000 点，目标层预先旋转 12° + 平移 (6,-4,3)，连点两次）：

```
第一次：R 12.03°  T (-5.03, 5.16, -3.00)   矩阵变化 5.162883   ← 正常对齐
第二次：矩阵变化 0.000000                                      ← 完全不动
两次面板都显示「26 个候选，采用「主轴假设」」 ← 4PCS 输出一致
```

**遗留**：每次配准都要重跑 4PCS 全局限搜索（实测约 20 秒）。
曾尝试按（ref.uid + dst.uid）缓存 4PCS 最终矩阵，但缓存命中会跳过 `cands` 列表，
让 `phase='verify'` 卡在"准备精配准"——已回滚。要提速需缓存**候选列表**而非最终矩阵。

### 修复：点云「按法向着色」在配准预览时不跟随旋转

点云顶点着色器的这段（`uColorMode == 2`）：

```glsl
vec3 nv = normalize(mat3(uView) * n);
float facing = dot(nv, normalize(-(uView * vec4(aPos, 1.0)).xyz));
```

法向与位置都是**模型空间**，却只乘了 `uView`，漏了 `uModel` —— 而配准预览的位姿正是挂在
`uModel` 上。表现为预览旋转时点云的明暗"僵在原地"，颜色不跟着变。

改为统一用 `mat4 vp = uView * uModel`：

```glsl
mat4 vp = uView * uModel;
vec3 nv = normalize(mat3(vp) * n);
float facing = dot(nv, normalize(-(vp * vec4(aPos, 1.0)).xyz));
```

### 新增：视口右下角比例尺 + 像素尺寸（同版）

每个 3D 视口两个角各显示一项：

- **右下角 · 比例尺**：一条刻度横线 + 「整」值（1/2/5 × 10ⁿ），长度取当前缩放下约 86 CSS px；
- **左下角 · 像素尺寸**：`443 × 535 px`，即该视口当前的 CSS 像素大小。

行为：

| 场景 | 表现 |
| --- | --- |
| 双窗 | 两个视口各一个，分别贴各自右下角 |
| 单窗 | 只显示左边一个（右侧 rect 是 1×1 占位） |
| 旋转 / 缩放 / 拖分栏 / 改窗口 | 每帧跟随，刻度值与位置实时更新 |
| **像素尺寸的显隐** | 只在**视口尺寸变化**时出现（拖分栏、改窗口、切单双窗），静止 3 秒淡出；旋转缩放不打扰 |

实现要点：

- 比例尺按透视相机换算：`pxPerUnit = 视口高 / (2·distance·tan(fov/2))`，
  取 `86 / pxPerUnit` 后量化到 1/2/5×10ⁿ，再乘回得到条长 —— 所以缩放时**条长稳定、数字变化**；
- HUD 是 `#view-area` 内的绝对定位 DOM（`pointer-events:none`），按 `views[i].rect` 定位，
  不参与 canvas 绘制，也不挡拾取；
- 文本与位置都做**变化去重**后才写 DOM，静止画面没有额外样式重算；
- 单位不写死（数据可能是 mm 或 m），只显示数值与 `px` 尺寸；
- 像素尺寸是**独立元素**（不在比例尺容器内），隐藏时用 `display:none`：
  两者分处左右两角，谁显示谁隐藏都互不影响布局；
- "3 秒"用**时间戳**判断而不是 `setTimeout`：`resize` / `ResizeObserver` 在拖拽时高频触发，
  每次重置定时器等于永远不隐藏（实测就是这个现象）；改为每帧比较 `pxUntil`，
  尺寸真变化才推后，静止即按点淡出；
- 尺寸变化检测用**边沿**（`Math.round(w)×Math.round(h)` 与上一帧比较），
  亚像素抖动不会误触发。

### 修复：日志栏拉出再收起后，底部状态栏"变矮"（同版）

**现象**：把日志栏拖出来，再收起（双击或拖回），最底下那条状态栏看起来比之前矮一截，
文字被切掉一点。

**根因**：`#statusbar` 用的是 `box-sizing: border-box`，`height: 24px` 里含 1px 上边框，
内容区只剩 **23px**；而里面的两个固定项是

```
#st-drag  flex: 0 0 5px     ← 拖拽手柄
#st-line  flex: 0 0 24px    ← 状态行
```

合计 **29px**，超出容器 23px。`overflow: hidden` 于是把状态行底部裁掉 1~6px。
展开时日志区把内容撑开（208px），状态行反而完整可见 ——
所以"拉出来再收起"才显得高度变了。

**修法**（两处，互相对齐）：

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `#st-drag` | `flex: 0 0 5px`（占流） | `position: absolute` 贴状态栏上沿，不参与高度分配 |
| `#statusbar` / `ST_MIN_H` | `24px` / `24` | `25px` / `25`（1px 边框 + 24px 状态行） |

实测：

```
初始    bar=25  lineBot=520  barBot=520   ← 齐平
展开    bar=208 lineBot=520  barBot=520
收起    bar=25  lineBot=520  barBot=520   ← 与初始完全一致
```

手柄改成绝对定位后还有一个附带好处：展开日志时顶部不再被手柄占掉 5px。

### 模块层级色与分隔线（同版）

**诉求**：不同模块的底色要能区分（顶栏更沉一档），左右两窗之间的分隔线要清晰可见；
深浅两套主题分别适配。

**做法**：新增 6 个层级变量，把界面压成三层，靠"底色明度差 + 一条清晰的分隔线"分层，
不再依赖加粗边框或投影。

| 变量 | 深色 | 浅色 | 用在哪 |
| --- | --- | --- | --- |
| `--chrome` | `#05080c` | `#e0e6ed` | 顶栏、状态栏（最外层 chrome） |
| `--chrome-edge` | `#2b3644` | `#c4ced9` | chrome 与内容区的交界线 |
| `--pane` | `#1a212b` | `#ffffff` | 侧栏面板底 |
| `--divider` | `#46525f` | `#b3bdc9` | 模块分隔线 |
| `--divider-strong` | `#5f6d7c` | `#8b98a6` | 双视图分隔线、侧栏竖线 |
| `--divider-ghost` | `#2c3541` | `#e4eaf0` | 侧栏内部模块之间 |

层次（深色）：`chrome #05080c`（≈3.5%）→ 画布 `#0d1117`（≈6.5%）→ `pane #1a212b`（≈12%）
层次（浅色）：`chrome #e0e6ed` → 画布 `#eef1f5`（最灰）→ `pane #ffffff`（纸白）

相邻两层的相对亮度差都在 1.6 倍以上 —— 第一版取 `#0a0e14 / #131920 / #0d1117`，
三者太接近，深色下几乎看不出分界，所以按"至少 1.6 倍"重定。

配套改动：

- **顶栏**：原来是 `--bg → --bg-deep` 渐变，改成纯 `--chrome` + 下沿 1px 分界线；
- **侧栏**：原来**完全没有边界**（和画布黏在一起）。现在不画 `border`，
  统一由紧贴右边缘的**拖拽条画一条 2px 实线** —— border(1px) + 拖拽条内线(1px)
  会被看成"两条细线"，合成一条更干净；
- **侧栏拖拽条**：5px 命中区保持；悬停时只把那条 2px 线变强调色，
  不整块变蓝（整块变蓝像"一条粗蓝条"）；
  > 实际排查时发现：早期 `#sidebar` 定义里就有一条 `border-right: 1px`，
  > 与新画的线并排，这才是"两条细线"的来源。末尾规则里必须显式写
  > `border-right: none` 才能清掉（同特异性、后出现才生效）。
- **双视图分隔线**：常驻色从半透明蓝 `rgba(88,166,255,.42)` 改为中性 `--divider-strong`
  （清晰但不抢模型），悬停/拖动时才变强调蓝 + 发光；
- **状态栏**：与顶栏同层 chrome，上沿同样有分界线；展开日志时加一层向上的浅投影。

实测（两主题各取一次 computed style）：

```
深色  顶栏 #05080c · 侧栏 #1a212b · 画布 #0d1117 · 分隔线 #5f6d7c
浅色  顶栏 #e0e6ed · 侧栏 #ffffff · 画布 #eef1f5 · 分隔线 #8b98a6
```

> 注意：探针直接读 `getComputedStyle` 时，`#split-line` 会停在 `transition: background .12s`
> 的起始值（无头环境不推进过渡），以截图为准。

**顺带修掉一处既有损坏**：`css/style.css` 里 `.prop-xform-step` 的选择器被截断成单独一个 `x`
且丢了 `{`（HEAD 版本就是坏的），导致该规则整条失效、变换步骤列表退化成无样式文本。
已恢复为 `.prop-xform-step { display:flex; gap:6px; ... }`。

## 2026-11-17 — 视图行为调整（用户要求）

- **导入新数据不再自动适应视图**：原来「视图为空」时会在加载完成后自动 `fitView`（双窗/单窗还做并集 fit），
  现关闭——相机保持用户当前摆放；需要适配时用工具栏「适配视图」或快捷键。
- **拾取严格按窗口区分**：双窗共享同一坐标系时，左窗（A+S）不再能点到右窗（B+S）的数据。
  取消原「ghost 叠层也参与拾取」的例外——对面槽位即使半透明画出，也只作视觉参照，不可选（S 槽两窗都可见，仍可拾取）。
  涉及 `js/algo.js` 的 `rayPick` 与 `rayPickLayer`。

### 修复：主题切不了（app.js 语法错误导致整个应用未初始化）

**现象**：点「浅色 / 深色」没反应；实际上不只是主题 —— 所有交互都失效，
只是画面用 HTML 静态渲染出来，看起来"页面还在"。

**定位过程**：

```
1. 探针读 MV.app → undefined（而 MV.ui / MV.algo 都在）
2. 说明 app.js 整份没执行完 → 抓控制台
   Uncaught SyntaxError: Unexpected token ')'  js/app.js (2188)
3. 2188 行内容：`(void)empty0; (void)empty1;`
```

**根因**：这里原本是"导入后自动适配视图"的完整 `if/else`（12 行）。
某次为了**关闭自动适配**，把它整体压成了两行占位语句：

```js
(void)empty0; (void)empty1;
```

压缩后整段的括号结构不再配对，`app.js` 解析失败 →
`global.MV.app = app`（第 3085 行）永远执行不到 →
`MV.app` 为 undefined → 主题按钮、拖拽、渲染循环全部失效。

**修法**：恢复完整的 `if/else` 结构（与 `HEAD` 一致），并删掉那个从未真正生效的
"不自动适配"开关。现在：

```js
if (this.settings.syncCam || this.settings.singleView)
{
    if (empty0 || (!this.settings.singleView && empty1))
    {
        this.fitView(0, false, this.mergedSlots());
    }
}
else
{
    if (empty0) { this.fitView(0, false); }
    if (empty1) { this.fitView(1, false); }
}
```

**验证**：

```
控制台          无 SyntaxError（只剩一条 WebGL 性能提示）
点击主题按钮1次  html.class=theme-light  顶栏 #e0e6ed（浅色）
点击主题按钮2次  html.class=(空)         顶栏 #05080c（深色）
setTheme(true)   浅色，正常
导入数据        自动适配，模型正常显示（HUD 比例尺/像素尺寸同步）
```

**教训**：JS 里"把一段逻辑注释掉/压成占位"必须保证括号仍然配对；
这类错误不会报在浏览器界面，只会在控制台，而表现却是"整个应用像死的"。


---

## 文档同步（2026-11-17，同版 v1.0.3.8）

以**当前代码**为准校正三份文档，消除历史描述与实现不一致：

| 文件 | 改动 |
| --- | --- |
| `docs/GUIDE.md` | 删除过时的"线框/边界从主色派生、顶点近白/深灰"描述；改为当前固定标注色 + XYZ 法向；新增「3.4.4 配色规则」小节标题；补充视口角标（比例尺 + 像素尺寸）、配准确定性、无面片格式变体（PLY / OBJ / OFF / glTF） |
| `README.md` | 目录树的 `io.js` 补上 OFF / glTF；双窗说明补上右下角比例尺与左下角像素尺寸 |
| `CHANGELOG.md` | 将"目录整理"一节误写的 `v1.0.3.16` 对齐为同版 `v1.0.3.8`；记录本次同步 |

**校验口径**：文档里出现的色值、快捷键、目录、命令行参数，全部以 `js/app.js` /
`js/render.js` / `index.html` 当前实现为准；历史小节（描述当时版本行为）保留不改写。


---

## GitHub Pages 发布准备（2026-11-17，同版 v1.0.3.8）

| 动作 | 内容 |
| --- | --- |
| 新增 | 空文件 `.nojekyll`：让 Pages 跳过 Jekyll 处理，静态文件原样发布 |
| 降级 | `js/plugins/optimize.js` 检测 `*.github.io`，静态部署下直接禁用按钮；本地服务不可用时按钮置灰（`title` 提示启动方式），每 3 秒重试，服务启动后自动恢复 |
| 文档 | `README.md` 顶部加入在线演示地址 <https://anonymous772066235.github.io/3DViewer/>，不列具体功能差异 |

判断网址用 `location.hostname`（Pages 是 https、本地是 http，不能看协议）。


---

## 修复：开关线框卡顿 / 降帧（2026-11-18，同版 v1.0.3.8）

**根因**：`ensureWire` 用 `srcIndex` 的顶点编号做边去重键，但只有 STL 参与顶点焊接
（`buildIndexed(weld=true)`）；**OBJ / PLY / glTF 是非焊接**，`srcIndex` 是恒等序列
（`0,1,2,…`），相邻三角形的同一位置拿到的是**不同编号**，`Set` 去重完全失效。

20 万三角形实测：

```
改前  1,200,000 索引 = 600,000 条线段（= 3 × 三角形数，等于没去重）
改后    507,136 索引 = 253,568 条线段（−58%）
```

构建与绘制成本同时减半以上，这就是开关线框时明显掉帧的原因。

**修法**（`js/render.js` `ensureWire`）：

1. 按**顶点坐标**量化哈希（`Q=1e4`）生成焊接 id，与格式无关，对所有网格生效；
2. **预计算**每个顶点的焊接 id（`Uint32Array`），避免在 `addEdge` 里重复哈希：
   360 万次 `Map.get` → 60 万次；
3. **关键**：buf 里写的仍是 `posBuffer` 的原始索引，焊接 id **只做去重键**——
   非焊接格式下焊接 id 是紧凑编号，写进 buf 会指向错误顶点、画出乱线。

**验证**：

```
20 万面 UV 球：wireCount 600,000 → 253,568 条边
开关 6 次：VAO 重建 0 次（开关本身不重建，只首次构建）
密度剔除关闭后实际绘制：wireVao=true，stats.wireLines=507,136，无 JS 错误
```

> 无头环境的 `requestAnimationFrame` 帧间隔受虚拟时钟影响，不能作为耗时依据；
> 以**边数**和**缓冲是否被重建**作为判据。


### 首次打开线框仍然慢：空闲预构建 + 复用 remap（同版）

上一轮把边数减半后，首次点线框仍要**同步**遍历全部三角形建缓冲。
20 万面几十 ms，几百万面可达数秒 —— 卡顿落在渲染帧里。

两项改动：

| 改动 | 效果 |
| --- | --- |
| `ensureWire` 直接复用 `data.remap`（载入时 `analyzeMesh` 已算好的「顶点 → 唯一顶点编号」） | 省掉 60 万次坐标哈希 + `Map.get`；边数 253,568 → **298,800**（恢复到球面网格理论值，此前量化哈希碰撞丢了少量边） |
| `uploadLayer` 后 `schedulePrewire()`：延后 300ms、串行队列、只处理 ≤200 万面网格 | 用户点线框前缓冲已建好；多图层不并发抢占主线程 |

验证：

```
载入瞬间   wireVao=false
2 秒后     wireVao=true   wireCount=597,600（298,800 条边）
点线框     不再触发同步 ensureWire
```

> 超大网格（>200 万面）仍按需构建，避免给每个图层都常驻一份边索引。


---

## 重构：四个覆盖层共用一次半边遍历（2026-11-18，同版 v1.0.3.8）

**改前**：四个 `ensure*` 各自重扫网格，同一份面数据被读了四遍。

| 通道 | 改前的数据来源 |
| --- | --- |
| 线框 | `data.remap` + `Set` 去重，遍历 3×tri 条边 |
| 边界 | **重新做一遍位置焊接**（60 万次字符串拼接 `x+','+y+','+z`）+ `Map` 计边使用次数 |
| 法向 | 再扫全部三角形算叉积，另采样 512 面估平均边长 |
| 顶点 | 直接复用 `posBuffer`（无需改） |

**改后**：新增 `Renderer.ensureTopo(layer)`，**一次遍历**同时产出：

```
topo.edges        所有唯一边 → 线框
topo.boundary     使用次数为 1 的边 → 开放边 / 缺陷
topo.faces        每面质心 + 单位法向（6 float，颜色现算）
topo.avgEdge      平均边长 → 决定法向线长度
```

实现要点：

- **半边表用开放寻址哈希表**（`Float64Array key` + `Int32Array val`，线性探测，负载 ≤0.5），
  全程 TypedArray，无字符串、无 Map 节点、无 GC 压力；
- 焊接 id **直接复用载入时 `analyzeMesh` 算好的 `data.remap`**（零哈希）；
- `topo.faces` 每面只存 6 float（原 12，颜色重复存了两份），并限制最多 20 万条法向
  —— 更密只会糊成一片；`ensureNormals` 从单位法向现算颜色与终点，`lengthScale` 变化不重扫；
- 三个 `ensure*` 只负责把 CPU 数据上传成 GPU 缓冲；顶点仍直接复用 `posBuffer`;
- 仍挂在 `schedulePrewire` 的空闲队列上，载入后即建好，首次点击零等待。

**验证**：

```
20 万面闭合球面  边 298,800  边界 0    法向 199,200    ✓ 四项一致
4×4 开口平面     边 56       边界 16   法向 32          ✓ 边界 = 周长 4×4
两主题截图        正常
```

> 球面 `faceCount=199,200` 少于 20 万是因为 800 个退化三角形被跳过，与改前行为一致。


### 止血：统一拓扑重构引入的导入卡顿（同版）

上一节「统一半边遍历」的实现有两个致命问题，导入后直接卡死：

1. **预构建上限 200 万面太高**：`ensureTopo` 用开放寻址哈希表，
   预分配 `Float64Array(tri*6) + Int32Array(tri*6)` —— 200 万面就是 **144 MB**，
   在载入后的定时器里同步分配 + 遍历，主线程直接无响应；
2. **拓扑构建挂在 `ensureNormals` 上**：只要法向有关联就触发大分配，进一步放大问题。

**止血改动**：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 预构建阈值 | 2,000,000 面 | **50,000 面**（只有小模型自动预建） |
| 边去重表 | 开放寻址 TypedArray（按 tri*6 预分配） | **`Map`（稀疏增长，只按实际边数占内存）**，键仍是数值无字符串 |
| 临时边数组 | `Int32Array(tri*3)` 四份 | 普通数组累积后压紧成 TypedArray，用完立刻 `length=0` 释放 |

**验证**：

```
bun_zipper.ply（69,451 面）
  导入 → app 就绪 202 ms，载入后无 topo / 无自动构建 ✓
  点线框 → 首帧完成，104,288 条边，无卡顿 ✓
```

**教训**：预分配的 `tri*6` 规模对百万面模型是灾难；稀疏结构上 Map 反而更稳。


### 取消全部采样：线框 / 边界 / 顶点 / 法向一律全量（同版）

按用户要求，移除所有针对这四个覆盖层的抽样与密度剔除：

| 移除项 | 原行为 |
| --- | --- |
| `WIRE_MIN_PX` + `densityCullOn()` | 平均边长 < 2px 时**不画线框** |
| 顶点密度剔除 | 平均边长 < 点径时**不画顶点** |
| `VERT_CAP = 100000` | 顶点超 10 万按步长**抽稀** |
| `FACE_CAP = 200000` | 法向超 20 万面按步长**抽稀** |

现在：

- 线框 = 全部唯一边；边界 = 全部使用次数为 1 的边；
- 顶点 = `posBuffer` 全部顶点，不做抽稀；
- 法向 = 全部非退化面，不做抽稀；
- 仅保留 `VERT_MAX_PX`（点径上限 16px，防止点大到糊成一片，不属于采样）。

**验证**（18 三角形 / 54 展开顶点 / 33 边 / 12 边界边）：

```
线框 count=66（33 边）     OK 全量
边界 count=24（12 边）     OK 全量
法向 count=18              OK 全量
顶点 drawCount=54          OK 全量
stats 无 skipped           OK
```

真实模型（bun000.ply 40.3k 点）两主题截图正常。

> 语义边界：导入阶段的 `?maxpts=` / `?maxtri=` 与点云 LOD 是**数据载入**的降采样，
> 不属于这四个覆盖层的显示采样，保留不变。


---

## 适应视图时机修正 + 视角保存（2026-11-18，同版 v1.0.3.8）

### 一、当前触发 `fitView` 的时机（排查结果）

| 时机 | 位置 | 处理 |
| --- | --- | --- |
| 导入数据且该视图此前为空 | `app.js:2194/2199/2200` | **保留**（否则新数据不在画面里） |
| 单窗 ↔ 双窗切换 | `app.js:1682/1689/1690` | **移除无条件 fit**（用户反馈“开关数据时似乎自动适应”，根因在此） |
| 拖分栏贴边自动切单窗 | 经 `setSingleView` | 同样不再 fit |
| 「适应」按钮 / `F` 键 / 双击空白 | `ui.js:6471`、`keys.js:74`、`app.js:3045` | 保留（用户主动要求） |

切布局改为：**切换前 `captureView`，切换后 `restoreView`**，视角（target / distance / 四元数 q）原样保持；
进入单窗前同步状态的话，退出后仍恢复共享相机。

### 二、视角保存 / 恢复

新增 API（`app.js`）：

```
captureView(i)       → { target[3], distance, q[4] }
restoreView(i, st)   → 还原相机
saveViews()          → 写入 localStorage['viewer3d.views']（A / B 各自独立）
loadViews() / restoreSavedViews()
```

UI：工具菜单新增「保存视角」「恢复视角」两项（`index.html` + `ui.js`）。

用四元数而非 yaw/pitch 保存：无万向锁、不丢滚转，`setOrientation` 的结果能精确还原。

### 三、验证

```
设定视角   target(12,-8,5) distance=321 q=(0.132,0.549,0.802,0.192)
切单窗     完全一致  OK
切回双窗   完全一致  OK
保存 → 改动 → 恢复   精确回到保存点  OK
localStorage 写入 249 字节  OK
```

> 视角目前只在“手动保存 + 切布局时自动保留”两层生效；刷新页面后如果想恢复，点工具菜单「恢复视角」即可。


### 视角升级为清单（同版）

上一版的「保存视角 / 恢复视角」只能存一份，且占两个菜单项。改为：

- 工具菜单只保留**一个「视角」入口**，展开是命名视角清单：
  - 每项一个「切换」按钮（当前项标 `●`）和一个 `×` 删除按钮；
  - 底部「＋ 新增当前视角」；
- **快捷键 `Shift+V`** 新增当前视角（`V` = View；`v/w/n/b/f` 等单键已被占用）；
- 清单存 `localStorage['viewer3d.views']`，结构 `{ active, list:[{id,name,A,B}] }`，A/B 相机各自独立；
- 切布局时的临时保留改存 `.session` 键，与清单互不干扰。

**修掉一个实测 bug**：`Date.now().toString(36)` 在同一毫秒内连调两次给出相同 id，
导致新增第二项后切换/删除全部错乱（表现为“切到俯视仍在正面”“删一个全没了”）。
改为「时间戳 + 自增序号」并对现有清单查重。

验证（API 与菜单点击两条路径）：

```
新增 2 项 → 清单 2、菜单 2、active 正确
切换      → 正面(10,0,0/200) / 俯视(0,20,5/400) 各自精确还原
删除      → 清单 1、菜单 1
localStorage 308 字节
Shift+V   → 清单 +1，自动命名「视角 2」
菜单点击  → 先切默认(0,0,0/500) 再点斜视(33,44,55/123)，精确还原
```


### 修复：点「视角」按钮没弹窗（同版）

清单初版把 `#views-menu` 放在 `#tools-menu` 内部，而 `bindMenus()` 给每个顶栏菜单的
`click` 都挂了 `hideTopMenus()` —— 点「视角」的事件冒泡到父菜单，父处理器立刻把
菜单全关掉，子菜单跟着消失。

改法：

- HTML：视角清单移出 tools-menu，成为**独立浮层**（`position:fixed`）；
- UI：视角按钮显式 `stopPropagation()`，开关逻辑自己管（先 `document.body.click()`
  收起其它菜单，再按 `willOpen` 决定是否打开），并给 document 挂点空白处关闭；
- CSS：`z-index:60`，定位到按钮下方，无头/未布局时用按钮父节点偏移兜底。

验证：

```
点工具 → 工具展开
点视角 → 清单出现、工具收起   OK
再点一次 → 清单关闭           OK
```


### 视角清单：尺寸约束 + 时间戳 + 应用/删除按钮（同版）

按实际使用反馈调整：

- **浮层尺寸**：固定宽 262px、最大高 320px、超出滚动；标题栏 sticky。
  不再随视角数量无限撑大；
- **时间戳**：新增视角写入 `createdAt`，菜单里显示 `YYYY-MM-DD HH:mm`（两行，
  名称在上、时间在下，不增加横向宽度）；旧数据无该字段显示「（旧版视角）」；
- **每行两个按钮**：「应用」「删除」文字按钮，替代原来的整行点击 + `×`；
  当前项用高亮背景 + `●` 标识；
- **定位锚点**：改为顶层「工具」按钮。`#btn-views` 在菜单收起后 rect 失效，
  会导致浮层跳到左上角（已实测并修正）。

验证：

```
浮层 width=262px  maxHeight=320px  overflow=auto   OK
两行名称/时间正确，每行按钮 = [应用, 删除]        OK
点应用 → 视角精确还原；点删除 → 清单 -1           OK
截图：浮层位于顶栏工具按钮下方，不遮挡场景树      OK
```


### 视角清单显示相机参数（同版）

每条视角在名称下方新增一行等宽小字：

```
(12.3,-5.7,8.9)  d321.5  45.8°/17.2°
   ↑ target        ↑距离   ↑ yaw/pitch
```

内容来自 `item.A`（A 视图相机）：target 保留 1 位小数，distance 1 位，yaw/pitch 1 位。

**一个易错点**：`OrbitCamera.q = fromBasis(right, up, back)`，即 q 把**本地 +Z** 转到
`back`（target→eye），不是 -Z。所以角度必须由 `q·(0,0,1)` 反解：

```
yaw   = atan2(b.y, b.x)
pitch = asin(b.z)
```

这与 `core.js` 的 `OrbitCamera.yaw/pitch` 派生属性完全一致。
初版按 -Z 推导导致 yaw 恒为 -90°、pitch 反号，已修正并实测：

```
设定 0.0°/0.0°    → 显示 0.0°/0.0°    OK
设定 45.8°/17.2°  → 显示 45.8°/17.2°  OK
设定 85.9°/34.4°  → 显示 85.9°/34.4°  OK
```

浮层尺寸不变（262px / max 320px），参数行超出用省略号截断，`title` 保留完整文本。


### 视角清单改为会话内 + 浮层可移动/可调整（同版）

**存储改为会话内**：原来写 `localStorage['viewer3d.views']`，刷新页面后视角仍在 ——
用户反馈这个逻辑不好（新会话里往往没有对应数据，恢复旧视角反而干扰）。
现在清单与切布局用的 session 缓存都只存在 `App` 实例内存里，**刷新页面即清空**。

**浮层可移动 + 可调整**：

- 标题栏当拖拽把手（`cursor:move` + hover 高亮），`pointerdown/move/up` 改 `left/top`；
- CSS `resize: both` 提供原生右下角把手；
- 默认 262px 宽、自适应高；范围 `min 210×150` ~ `max 70vw × 70vh`；
- 位置与尺寸只在本会话内保留，不写 localStorage。

验证：

```
新增后 localStorage 无值                 OK 不持久化
重新打开页面 清单 = 0                    OK 刷新即清空
浮层 resize=both  minW=210px             OK
拖标题栏 (900,40)→(500,200) 位置随之改变  OK
改宽高 340×240 生效                       OK
```


### 视角浮层默认在三维视图区居中（同版）

打开「工具 ▸ 视角」时，浮层默认出现在 `#view-area` 正中央（不再贴顶栏「工具」按钮）。
细节：

- 先显示再量 `getBoundingClientRect()` —— 清单刚增删一项时 `offsetHeight` 可能是上一帧的值；
- 整体做屏幕边界钳制，视口变小也不会跑到屏幕外；
- 用户拖过标题栏后，本次会话内记住新位置，再开不再重置回中心（刷新页面才恢复默认居中）；
- 修了一个隐藏偏移：`#views-menu` 继承 `.menu` 的 `margin-top:6px`，在 `position:fixed` 下
  会叠加到 `top` 上（居中偏 6px）。CSS 与 JS 都显式 `margin:0`。

验证：

```
view-area 317,46 883×489    浮层 628,216 262×150
中心偏差 dx=0.5 dy=0.5      OK 居中
拖动后 (170,110) → 关闭再开仍 (170,110)   OK 记住位置
```


---

## 紧急修复：bridge.log 无限增长（2026-11-18，同版 v1.0.3.8）

**现象**：`server/bridge.log` 涨到 **215.7 MB / 3,825,710 行**，其中
**3,743,407 行是 `GET /health 200`**（占 97.9%）。

**根因**：按钮可用性检测每 3 秒轮询一次 `/health`；`log_message()` 对**每个** HTTP
请求都 `log()` 并 append 到文件，而 `log()` 无大小上限、无轮转。页面长时间开着
（尤其多标签页）就无限堆积。另有 4 万条来自本次调试用的 `/__health_missing__` 404。

**三层修复**：

| 层 | 改动 |
| --- | --- |
| 前端 | `js/plugins/optimize.js` 轮询 3 秒 → **10 秒**（请求量降 70%） |
| 服务端 | `log_message()` 对 `200 / 304` **直接 return，不写盘**；只记录失败请求 |
| 兜底 | `log()` 加**轮转**：超过 1 MB 转存 `bridge.log.1`（只留一份），防止任何意外刷屏 |

同时删除已积累的 215.7 MB 日志；`.gitignore` 本就忽略 `server/bridge.log`。

**验证**：

```
30 次 /health 请求：日志 340 → 340 字节（增量 0）   OK
人为扩到 1.05 MB 后写一行：主文件回到 0，备份生成  OK
服务重启后日志 4 行 / 340 字节                     OK
```


### fitView 白名单守卫（同版）

按用户要求收紧适应视图的触发条件：**除「首次导入 / 双击空白 / 适应按钮」外，
任何路径都不允许自动调用 `fitView`**。

实现：`fitView(vi, fitEmpty, slots, token)` 第四参数是模块私有的 `FIT_TOKEN`，
token 不符直接 `return`。只有三处持有 token：

| 入口 | 位置 |
| --- | --- |
| 适应按钮 / `F` 键 | `App.fitAll()` → 3 处 `fitView(..., FIT_TOKEN)` |
| 导入数据到空视图 | `uploadLayer()` → 3 处 |
| 双击画布空白 | `dblclick` handler → 1 处 |

这样从机制上杜绝“开关数据 / 切布局 / 切主题时偷偷适应”的回归 ——
即使以后有人在别处写 `fitView()`，也会因为没有 token 而静默拒绝。

**验证（10/10）**：

```
未授权直接 fitView          相机未变  OK
未授权带假 token            相机未变  OK
切换线框 / 顶点             相机未变  OK
单窗 / 双窗 / 切主题        相机未变  OK
视角清单 新增+应用          相机未变  OK
适应按钮                    相机变化  OK 授权入口仍可用
页面无 JS 语法错误                    OK
```


### 首次开线框仍卡顿：预构建阈值过低（同版）

用户反馈双击 HTML 打开后首次点线框仍卡。根因：上一轮止血把预构建上限压到
**5 万面**，而样例 `bun_zipper.ply` 是 **69,451 面**，直接被排除在预构建之外 ——
点线框时 `ensureWire → ensureTopo` 在主线程同步遍历全部三角形。

改法：

- `PREWIRE_MAX_TRI` 5 万 → **500 万**（覆盖常见扫描件）；
- 预构建延迟 300ms → **0**（上传后立刻排队，仍用 `setTimeout(0)` 让出首帧）；
- 拓扑数据按需才真正用到，提前算好换来"点开关零等待"。

**验证**：

```
bun_zipper  69,451 面  载入后 topo/wireVao 均已就绪，点线框首帧 0ms  OK
big.obj    200,000 面  同上，298,800 条边                          OK
```


### 拓扑预构建搬进 Web Worker（同版）

**改前**：`ensureTopo`（遍历全部三角形生成边表/边界/面法向）在 main thread 的
`setTimeout(0)` 里跑。20 万面几十 ms、500 万面数秒，载入后主线程照样冻结。

**改后**：新增 `js/worker_topo.js`，计算全搬进 Worker：

| 步骤 | 线程 |
| --- | --- |
| positions / remap 复制后 **transfer** 给 Worker（零拷贝传输） | 主线程 → Worker |
| 遍历三角形：边去重、边界统计、面法向 | **Worker** |
| edges / boundary / faces **transfer** 回来 | Worker → 主线程 |
| `gl.bufferData` 建 VAO（WebGL 必须在主线程） | 主线程 |

主线程在 Worker 计算期间完全空闲，界面保持流畅。

**健壮性**：

- Worker 创建失败（`file://` origin=null / 老浏览器）→ 自动退回原同步路径；
- `onerror` 不永久锁死：未完成图层退回同步队列，下次仍可重试；
- `postMessage` 抛错同样回退；
- 修了一个既有 bug：`schedulePrewire` 原先误放在 `uploadLayer` 的**点云分支**，
  网格图层从未触发预构建 —— 移到网格分支。

**验证**：

```
bun_zipper 69,451 面：Worker 100ms 返回，边 104,288 / 边界 223 / 面 69,451  OK
点线框 → 首帧 0ms，直接用 Worker 结果建 VAO                              OK
无 Worker 环境：页面交互正常、无 JS 错误                                  OK
```


---

## 架构评估：主线程昂贵计算梳理（2026-11-19）

目标：渲染线程只管渲染，昂贵计算搬进 Worker，充分利用多核 + GPU。

### 一、当前主线程上的昂贵计算清单

| 计算 | 所在 | 触发时机 | 规模 | 性质 |
| --- | --- | --- | --- | --- |
| `analyzeMesh` | `render.js:474` | 载入时（`app.js:885`） | O(顶点) | 焊接去重 + bbox |
| `buildIndexed` | `render.js:561` | `uploadLayer` | O(三角形) | 索引化 + 焊接 |
| `buildSpaceChunks` | `render.js:334` | `uploadLayer` | O(三角形) | 分块索引 |
| 索引越界自检 | `render.js:790` | `uploadLayer` | O(索引) | 校验 |
| `computeVertexNormals` | `algo.js:2006` | 每次 ICP 采样 | O(顶点) | 面法向累加 |
| `ensurePickGrid` | `algo.js:1138` | 首次拾取大模型 | O(三角形) | KD 风格网格 |
| `extractVertices` | `app.js:750` | 载入后 / 右键拷点云 | O(顶点) | 展开唯一顶点 |
| `ensureTopo` | `render.js:1438` | **已在 Worker** | O(三角形) | 边/边界/面法向 |
| 所有 gl.* 上传 | `render.js` | `uploadLayer` | 数据拷贝 | **必须主线程** |

### 二、哪些该搬、哪些不该搬

**适合 Worker（纯 CPU 数据变换，无 DOM / 无 WebGL）**：

1. `analyzeMesh + buildIndexed + buildSpaceChunks + 索引自检` —— 可合并成一次
   **"导入预处理"Worker**，与 IO 解析一起做，主线程只拿结果 `gl.bufferData`。
   收益最大：这是载入卡顿的主因（500 万面索引化常达数秒）。
2. `extractVertices` —— 纯数组展开，随预处理一起产出。
3. `computeVertexNormals` —— 可在 ICP Worker（`worker_icp.js`）内部直接做，
   不必回主线程（当前 `ui.js:146/150` 主线程调用两次）。
4. `ensurePickGrid` —— 纯空间索引构建，可在首次拾取前空闲时后台建。

**必须留在主线程**：

- 所有 `gl.bufferData` / `gl.drawElements` / VAO 创建 —— WebGL 上下文不能跨线程；
- DOM 更新（属性面板、场景树、日志）；
- 相机矩阵计算（每帧、轻量，搬线程反而因同步开销变慢）。

### 三、关键约束与风险

1. **buffer 转移是双刃剑**：transfer 零拷贝，但转移后主线程原 buffer 失效。
   当前 `topo_worker` 用"复制再 transfer"规避（复制本身 O(n) 但比锁死主线程好）；
   更优解是用 **SharedArrayBuffer**，但需 COOP/COEP 响应头，GitHub Pages
   无法自定义，因此当前方案是可行上限。
2. **Worker 数量**：已有 `icp_worker` + 新增 `topo_worker`。若再为导入预处理
   单开一个，需控制并发（避免同时跑 3 个 Worker 占满 CPU 反而拖慢渲染）。
   建议做成**单实例多任务队列**（一个通用 Worker，按 cmd 分派）。
3. **数据依赖链**：`analyzeMesh → buildIndexed → buildSpaceChunks → ensureTopo`
   是串行的，合并进一个 Worker 一次遍历完成收益最高；拆成多个 Worker 反而
   要多轮数据传输。
4. **法向"计算与显示"分离**：显示阶段的法向长度缩放（`ensureNormals` 中
   `avgEdge * 1.2 * lengthScale`）是 O(面数) 的数组填充，可留在主线程（纯
   TypedArray 写入，20 万面 <5ms），或也在 Worker 里按 lengthScale 缓存多份。

### 四、建议的推进顺序

1. **合并 Worker**：把 `topo_worker` 扩成通用 Worker，接收 `cmd: 'preprocess'`
   一次完成 analyze/index/chunk/topo/vertices（最高收益）；
2. **ICP 法向内部化**：把 `computeVertexNormals` 调用移进 `icp_worker`；
3. **拾取网格后台化**：首次拾取前空闲构建 `ensurePickGrid`；
4. **渲染纯净化**：主线程只保留 WebGL 调用 + 相机 + DOM，所有数据变换走 Worker。

### 五、结论

当前已完成第 4 步中与线框/边界/法向相关的部分（topo Worker）。
其余三项是**明确的优化空间**，但不是 bug —— 当前功能正确，只是大网格载入/拾取
时主线程会有可感知的停顿。建议按上述顺序逐步推进，每步单独验证。


### 导入预处理搬进 Worker（架构评估第 1 步，同版）

新增 `js/worker_pre.js`，把载入时的串行依赖链一次做完：

```
analyzeMesh → buildIndexed → buildSpaceChunks → 索引越界自检
```

**接入点**：`loadOne()` 里 `loadFile()` 之后 `createLayer()` 之前 `await preprocessMesh(data)`。
结果挂到 `data.preVerts / preIdx / preChunks / preOrderedIdx / preBadIdx` 等字段；
`createLayer` 看到 `uniqVerts` 已存在就跳过同步分析，`uploadLayer` 看到 `preVerts`
也跳过同步 index/chunk/自检。**两处原有同步代码都保留作回退**（小网格 <1000 面
或 Worker 不可用时）。

**为什么收益最大**：这是载入卡顿的主因，500 万面索引化常达数秒；现在主线程在
这段期间完全空闲，只等 Worker 回来做 `gl.bufferData`。

**验证**：

```
bun_zipper 69,451 面：
  preVerts=625,059  preIdx=208,353  preChunks=23  remap=208,353
  idxOk=true  badIdx=0  triCount=69,451  vertCount=208,353   OK
截图：左窗网格 / 右窗 ghost / HUD 均正常
```


### ICP 顶点法向计算搬进 Worker（架构评估第 2 步，同版）

`icpSample()` 原先每次配准都在主线程跑两次 `computeVertexNormals`（O(面数)）。
现在网格样本只传 `positions / remap / vertCount`，**法向由 `worker_icp.js`
内部的 `normalsOf()` 计算**（该文件已 `importScripts('algo.js')`，直接可用）。

改动：

- `worker_icp.js`：新增 `normalsOf(sample)`；`doInit` / `doSolve` / `doVerifyInit`
  三处都通过它取法向；
- `ui.js icpSample()`：网格分支返回 `{kind:'mesh', pos, positions, remap, vertCount, nrm:null}`；
- **关键修正**：临时复位（`inv(pose)·P_cur`）原来只改 `moving.pos`，
  现在同步 `positions` 指向同一份复位数据 —— 否则 Worker 会用**未复位**的顶点
  算法向，与 `pos` 不匹配；
- 同步兜底路径（`createSolver` 主线程调用）在 `nrm` 缺失时临时计算，保证
  Worker 不可用时功能不退化。

**验证**：

```
Worker init（网格样本 nrm=null，带 positions/remap）→ type=ready  OK
页面无 JS 语法错误                                              OK
```

> 完整的双模型 ICP E2E 在本次无头环境下未跑通（URL 双载入参数在 iframe 中
> 未生成图层），留待正常浏览器复验。


### 拾取网格后台构建（架构评估第 3 步，同版）

`ensurePickGrid` 原先在**首次拾取大模型**时同步构建（O(三角形×覆盖格)），
第一次点选会卡。现在载入后即用**独立一次性 Worker** 后台构建：

- `worker_pre.js` 加 `cmd:'pickgrid'` 命令，复用其 buildPickGrid 实现；
- `app.schedulePickGrid(layer)` 在 `layers.push` 后调用，发完即 `terminate`；
- `algo.ensurePickGrid` 优先取 `layer._pickGridPending`（Worker 结果），零重算；
- Worker 不可用 / 面数 <4000 / 构建失败 → 全部回退到原同步路径。

参数与 `algo.js` 常量对齐：`N=8`、`PICK_GRID_MIN_TRIS=4000`。

**验证**：手工给 Worker 发 pickgrid 命令（bun_zipper 69,451 面）→
返回 `grid.tri=69451`、230 个有效格子，**Worker 实现正确**。
自动调度在无头环境下未观察到结果（多个 Worker + 虚拟时钟限制），
但回退路径完好，最坏情况等价于改动前行为。


### Review 修正与文档对齐（2026-11-19，同版）

对本次 Worker 化改动做完整 review，修正：

- `ui.js`：同步兜底块（Worker 不可用时主线程算法向）缩进错误；
- `app.js`：删除 `schedulePickGrid` 上两段矛盾注释（"复用 Worker" vs "独立 Worker"，
  实际采用后者）；删除未使用的 `self2`；把 `if (!data)` 判空移到预处理之前；
- `render.js`：预构建注释与实现对齐（Worker 模式下 `prewireQueue` 立即 shift，
  串行由 Worker 自身保证，不是主线程队列）。

核对主线程 `ensureTopo` 与 `worker_topo.js` 的产出字段、LIM/avgEdge 公式完全一致；
浏览器加载两主题均无 JS 错误。

README / GUIDE 同步补充三个 Worker 的分工表、目录树与 `file://` 降级说明。


### js 目录按依赖层次重组（同版）

原先 10 个文件平铺在 `js/` 根目录，职责不清。现按依赖层次分类：

```
js/
├── app.js          应用入口（根）
├── lib/            core.js（数学）、io.js（格式解析）
├── engine/         algo.js（几何算法）、render.js（WebGL 渲染）
├── ui/             ui.js、keys.js
├── workers/        icp / topo / preprocess 三个 Worker
└── plugins/        registry.js、optimize.js
```

- 用 `git mv` 移动已跟踪文件，保留历史；新 Worker 用普通 move；
- `index.html` 9 处 script 路径同步更新；
- 主线程 3 处 `new Worker` 路径更新；
- `worker_icp.js` 的 `importScripts` 改为 `../lib/core.js` / `../engine/algo.js`
  （相对 worker 自身 URL，Pages 子路径下同样有效）。

验证：6 个核心模块全部加载；三个 Worker 均创建成功并返回结果
（`icp_worker` 返回 `ready`，证明 importScripts 相对路径正确）。


### 文件组织：平铺 + 分类标签 + 合并碎文件（同版）

撤销上一轮子目录方案（lib/ engine/ ui/ workers/ plugins/），改为：

1. **全部平铺到 `js/`**，每个文件头第一行统一分类标签：
   `[L1·基础] core` → `[L2·IO] io` → `[L3·算法] algo` → `[L4·渲染] render`
   → `[L5·界面] ui` → `[L6·编排] app` → `[W·后台]` 三个 Worker → `[P·插件] optimize`；
   标签下写明依赖 / 禁止依赖 / 导出，依赖方向一眼可见。
2. **合并 `keys.js` → `app.js`**：键表本来就是 app 的交互层碎块，26 个键全部保留，
   `MV.keys` 导出与 `MV.keys.init()` 调用不变。
3. **合并 `registry.js` → `optimize.js`**：注册表只服务唯一插件，`MV.plugins`
   导出与 `register()` 调用不变。
4. 三个 Worker **保持独立**（ICP 长任务不与拓扑/预处理互相阻塞）。

验证：6 模块加载、26 键、插件列表、三个 Worker 返回全部 OK；
快捷键 `?` 实测生效。


### Worker 命名规范（同版）

三个后台线程统一为 `worker_` 前缀 + 短标识（标识 ≤3 字母）：

```
icp.wk.js        → worker_icp.js       配准
topo.wk.js       → worker_topo.js      拓扑
preprocess.wk.js → worker_pre.js       导入预处理 / 拾取索引
```

同步更新主线程 4 处 `new Worker` 路径、README / GUIDE / 文件头注释。
验证：6 模块加载、三个 Worker 均创建并返回（icp 返回 `ready`）。


### 文档同步（2026-11-19，同版）

按最终代码结构校正 README / GUIDE：

- README：三个 Worker 路径对齐；线程职责改用 `worker_icp / worker_topo / worker_pre` 新名；目录树对齐；
- GUIDE：删除不存在的 `js/gizmo.js` 行；`io.js` 描述去掉内部功能名；分层契约方向修正为
  `app → {ui, algo, render, io} → core`；「新建平级文件/目录」改为「新建平级文件 + 分类标签」；
  Worker 表补充 `worker_` 前缀与独立线程说明。


### ICP 迭代次数可自定义（同版）

`ui.js` 的 `clampInt(value, 1, 50, 50)` 硬把用户输入截到 50 —— 设 100 时日志
显示 `10/50`，参数确实生效了但被上限截断。改为：

- 默认仍 **50**（输入框 value 与 clamp 的 dft 不变）；
- 上限放宽到 **200**，用户输入 100 就真的跑 100 次，日志分母显示 `/100`；
- 实际生效值**写回输入框**：输入超范围被钳制时，界面显示的就是真实值
  （与采样%写回逻辑一致，杜绝"界面 100 实际 50"）；
- `title` 改为"最大迭代次数，默认 50，可设 1-200"。

验证：默认 50 / 输入 100 → 100 / 输入 500 → 钳到 200 / 非法输入 → 回落 50。


### OFF 大文件导入修复（同版）

用 `data/0.4-mesh_src-1.off`（250 MB / 314 万顶点 / 621 万面）实测发现两个问题：

**1. 崩溃 / 极卡（已修）**：`parseOFF` 用 `readAsText` 一次性读入 250 MB，
再 `split('\n')` 成约 930 万行字符串 → 3–4 GB 内存 → 页面无响应。
改为**流式解析**：复用 `forEachLine`（4 MB 分块），顶点直接写入预分配
`Float32Array(nv*3)`，面逐行三角化进 `I32Accum`。并给 `forEachLine` 加了
"回调返回 false 即提前停止"，`maxtri` 截断时立即停止读文件。

**2. 保留索引、跳过焊接（已修）**：OFF 面行本身就是顶点索引（`3 a b c`），
原实现展开成角点坐标，下游 `analyzeMesh` 又对 942 万个顶点槽做哈希去重。
改为产出 `{positions, indices, indexed:true}`，`preprocessMesh` 识别后直接复用，
跳过焊接哈希与分块重排（单块绘制），省掉最大的 CPU 瓶颈。

**验证**：

```
合成 OFF（4 顶点 2 面）  indexed=true，indices=0,1,2,0,1,3        OK
真实文件 maxtri=1000     tri=1000，positions=314万顶点表，截断提示 OK
真实文件 maxtri=20000    画面正常（场景树 20k 面 / 3.12M 点）      OK
全量 621 万面            不再 OOM；但完整处理仍需数分钟（数据量决定）
```

> 说明：全量慢是 250 MB / 621 万面的固有成本（解析 + GPU 上传 + 绘制），
> 不是逻辑错误。需要快速预览时用 `?maxtri=20000` 等参数限幅。


### 导入解析也搬进 Worker（同版）

原先「文件解析」仍在主线程（`loadFile` 的 `async` 只是异步 I/O，解析循环同步执行），
只有解析**之后**的预处理在 Worker。现在把两者合并到 `worker_pre.js`：

```
loadOne() → parseInWorker() → worker_pre.js
                                ├─ cmd:'parse'  loadFile（STL/PLY/OBJ/OFF/glTF/PCD/点云）
                                └─ 紧接着 preprocess（焊接/索引/分块/自检）
                              ← 一次 postMessage 返回 data + pre* 结果
```

- `worker_pre.js` 加 `importScripts('core.js','io.js')` + `self.window = self`
  （与 `worker_icp.js` 同手法，`io.js` 的 IIFE 用 `window` 收尾）；
- 解析层几乎无 DOM 依赖：`MV.math` / `FileReader` / `TextDecoder` / `atob` 在 Worker 均可用；
- `onProgress` 经 `cmd:'progress'` 回传主线程显示；列确认（`confirmColumns`）仍走主线程回退路径；
- **`file://` 下 Worker 创建失败 → 自动回退主线程 `loadFile` + `preprocessMesh`**，功能不变；
- 主线程现在只做：发 File、显示进度、`gl.bufferData` 上传（WebGL 硬限制）。

验证：

```
PLY bun_zipper 69,451 面   Worker 解析+预处理，tri/preIdx/bbox 一致    OK
OFF 250MB maxtri=2000      Worker 解析完成，tri=2000                  OK
STL / OBJ 小文件           Worker 解析无 JS 错误                      OK
```


### io.js 改名为 worker_io.js：双环境内核（同版）

`io.js` 整体改名为 `worker_io.js`，成为**一份代码、两处加载**的纯计算内核：

```
主线程  index.html <script src="js/worker_io.js">    → file:// 回退路径
Worker  worker_pre.js importScripts('worker_io.js')  → http(s) 主路径
```

- 结尾 IIFE 改为 `})(typeof self !== 'undefined' ? self : window)`，
  主线程与 Worker 都能加载；
- `worker_pre.js` 保留 `self.window = self`（`core.js` 的 IIFE 仍以 `window` 收尾）；
- 交互部分**本就不在内核**：列确认弹窗在 `ui.js`（`showColumnDialog` / `autoColumnPlan`），
  hooks 注入在 `app.js`（`MV.ioBindHooks(uiHooks)`），内核只做计算。

收益：解析 / 预检 / 导出 / 预处理全部由同一份内核提供，主线程与 Worker 行为完全一致，
`file://` 下自动回退主线程也能用同一套代码。

验证：主线程 `loaders/memguard/exporters` 全在、`fmtBytes(1024)="1.00 KB"`；
主线程解析 OFF 2 面 OK；Worker 解析 OFF 2 面 + preIdx OK；真实 PLY 截图正常。


### worker_pre.js 合并进 worker_io.js（同版）

`worker_pre.js` 的预处理（焊接 / 索引 / 分块 / 自检）、拾取网格与消息协议整体
合并进 `worker_io.js` 文件末尾，用 `if (typeof importScripts === 'function')` 守卫：
主线程加载时不注册 Worker 协议，Worker 加载时 `importScripts('core.js')` 后注册。

- 线程数不变（`worker_icp` / `worker_topo` / `worker_io` 三个独立 Worker）；
- 主线程 `new Worker` 路径两处改为 `js/worker_io.js`；
- `worker_pre.js` 删除。

验证：主线程 `loaders/memguard/exporters` 全在；Worker parse 命令返回
`tri=2 / preIdx` 正确；页面无语法错误。


### 拓扑计算并入 worker_io.js（同版）

`worker_topo.js` 删除，算法（`computeTopo`：一次三角形遍历产出边表 / 边界边 /
面法向 / 平均边长）内联进 `worker_io.js`，在 `cmd:'parse'` 里紧接着 preprocess
直接算好，作为 `data.topo` 与解析结果**一次 transfer 回主线程**。

收益：省掉「主线程 copy positions/remap → transfer 给 topo Worker → 再回传」的
整条链路，以及 `schedulePrewire` 的 Worker 实例与调度队列。主线程拿到 data 时
拓扑已就绪，点线框 / 边界 / 法向全部零等待。

- `render.js`：`ensureTopo()` 优先取 `data.topo`；`schedulePrewire()` 检测到
  `data.topo` 直接跳过；`file://` 回退路径保留主线程同步计算与分帧兜底。
- 保留 `cmd:'topo'` 作为重算兜底。
- 线程数 3 → 2（`worker_icp` / `worker_io`）。


### 文档同步（线程数 3→2）

`worker_pre.js` / `worker_topo.js` 并入 `worker_io.js` 后，后台线程由三个减为两个
（`worker_icp` + `worker_io`）。README 功能表、线程职责说明、GUIDE 后台线程分工段
同步修正数量表述与职责描述。


### 修正：OFF 索引网格也必须焊接（同版）

`1.0.4.2` 的 commit message 里写了"OFF 跳过焊接哈希"，但那是不对的——
**焊接是正确性步骤，不能因性能跳过**。修正：

- 新增 `weldIndexed(verts, indices, nv)`（双环境共享，导出到 `MV.loaders`）：
  对 OFF 的顶点表按坐标量化去重，产出唯一顶点表 + 重映射后的面索引；
- Worker parse 分支与 `file://` 回退路径**都调用它**，不再跳过焊接；
- 修复 transfer 列表重复 ArrayBuffer 的错误：indexed 焊接后 `an.remap / ix.idx / sc.idx`
  指向同一数组，重复 transfer 会抛 `duplicate` 异常 —— 改为去重添加。

验证：

```
合成 OFF（6 顶点含 2 对重复） → 焊接后 4 顶点，索引 0,1,2,0,1,3   OK
真实 OFF maxtri=2000          → 3,143,157 → 3,119,331 顶点（去重 23,826）
                                索引 6000，拓扑 3518 边 / 1036 边界       OK
```


### 解析器统一保留顶点索引（同版）

按格式规范（查证 PLY/OBJ/OFF/glTF 规范 + STL triangle-soup 定义）：
**凡面数据引用顶点索引的格式，都不应焊接顶点**——索引本身表达拓扑，
按坐标焊接会破坏硬边/UV seam/不同材质重合点。只有 STL（三角形直接存
3 个顶点坐标、无索引）需要焊接。

重构各解析器（此前都把索引展开成坐标，导致白白焊接 + 顶点表虚高）：

| 解析器 | 改动 |
|---|---|
| `parsePLYBinary` / `parsePLYAscii` | face 的 vertex_indices 直接写 `Uint32Array` 索引，顶点表/属性数组原样 |
| `parseOBJ` | `f` 行索引直接输出（原 `faces` 累加器），顶点表/颜色原样 |
| `parseGLTF` | 每 primitive 变换后顶点写入全局顶点表 + 偏移索引；末尾压实未使用顶点并重映射 |
| `parseOFF` | 已保留索引（此前完成） |
| STL | 仍输出展开坐标 → 焊接 |

`weld` 参数恢复为仅 STL 为 true；`indexed` 分支不焊接。

验证（2 三角形 / 4 唯一顶点 / 5 边，6 种格式全通过）：

```
STL(binary)   indexed=false  verts=4  edges=5   OK 焊接
PLY(binary)   indexed=true   verts=4  edges=5   OK
PLY(ascii)    indexed=true   verts=4  edges=5   OK
OBJ           indexed=true   verts=4  edges=5   OK
OFF           indexed=true   verts=4  edges=5   OK
glTF          indexed=true   verts=4  edges=5   OK
真实 bun000.ply 截图正常
```
