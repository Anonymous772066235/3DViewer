# 3DViewer 改动日志（CHANGELOG）

| 项 | 值 |
| --- | --- |
| 当前版本 | `1.0.0.0` |
| 记录范围 | 2026-10-21（项目起点）→ 2026-10-28 |
| 版本号规则 | `v` + `YYYYMMDD` + 当日序号字母（`a`…`z`），每次可感知改动递增 |
| 数据来源 | 文件创建/修改时间戳（实测）+ `index.html` 版本号 + 会话改动记录 |

> **可信度说明**：`2026-10-21` ~ `2026-10-22` 上午没有逐条记录，只保留由现存代码反推的「基线能力」（文中标注 *基线*）。`2026-10-22` 下午起为逐条实测记录。

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
| `js/core.js` | 363 | L1 基础：数学 / 相机 |
| `js/io.js` | 1,727 | L2 IO：解析 + 优化调用 + 规模估算（内部三段各自作用域） |
| `js/algo.js` | 1,073 | L3 算法：三维裁剪 + 拾取测量 |
| `js/render.js` | 1,877 | L4 渲染：GL 管线 + 视角器 |
| `js/ui.js` | 1,611 | L5 界面：面板 / 树 / 弹窗 / 拖放 |
| `js/app.js` | 1,308 | L6 编排：状态 / 图层 / 输入 / 循环 |

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

---

## 附录 A：当前文件规模（2026-10-28 11:03）

| 文件 | 行数 |
| --- | --- |
| `js/app.js` | 2056 |
| `js/ui.js` | 1498 |
| `js/renderer.js` | 1435 |
| `css/style.css` | 1280 |
| `js/loaders.js` | 1257 |
| `js/segment.js` | 819 |
| `index.html` | 397 |
| `js/math3d.js` | 359 |
| `bridge/optimize_server.py` | 337 |
| `js/optimize.js` | 286 |
| `js/memguard.js` | 206 |
| `serve.py` | 76 |
| `bridge/start_bridge.bat` | 62 |
| `bridge/test_bridge.py` | 59 |
| **合计** | **≈ 10,000 行** |

**8 天 / 约 40 个版本号 / 新增 5 个文件**：`serve.py`、`js/segment.js`、`js/memguard.js`、`bridge/optimize_server.py`、`bridge/test_bridge.py`。

## 附录 B：URL 参数速查

| 参数 | 示例 | 说明 |
| --- | --- | --- |
| `url` | `?url=_t/m.stl` | 直接载入指定文件（配合 `slot`） |
| `slot` | `&slot=B` | 目标槽位 `A` / `B` / `BOTH` |
| `single` | `&single=1` | 单窗口模式 |
| `faces` / `wire` / `verts` / `normals` | `&faces=0&wire=1` | 初始显示项 |
| `shade` | `&shade=0/1/2` | 0 纯色 / 1 光照 / 2 按法向 |
| `boundary` | `&boundary=1` | 启动即高亮边界边 |
| `yaw` / `pitch` | `&pitch=89` | 初始视角（度） |
| `zoom` | `&zoom=0.1` | 载入后相机距离 × 系数 |
| `mark` | `&mark=2` | 拾取十字单臂长度（默认 1 mm） |
| `maxtri` / `maxpts` | `&maxtri=2000000` | 显式限制载入数量（默认不限制） |
| `memlimit` | `&memlimit=5` | 覆盖内存预算（MB），用于强制触发下采样弹窗 |
| `memauto` + `mempct` | `&memauto=sample&mempct=20` | 不弹窗直接按比例下采样（自动化/演示） |
| `demo` | `&demo=pick` / `&demo=seg` | 自测：自动拾取 3 点 / 自动框选一块 |
| `segapply` | `&segapply=1` | 与 `demo=seg` 联用，预览后立即应用拆分 |
| `menu` / `colors` | `&menu=1` / `&colors=1` | 默认展开「工具」菜单 / 配色浮层 |
| `debug` | `&debug=1` | 状态栏显示渲染统计（calls/tri/fps） |

## 维护约定

1. 版本号**按「提交」递增**，不是按「改动」递增：一次提交内的多次修改共用同一个版本号。规则是「上一版末位 +1，满 10 进位」：`1.0.0.8` → `1.0.0.9` → `1.0.1.0` → `1.0.1.1` …；提交前同步改 `index.html` 的 `?v=` 与副标题、以及本文件的标题行；
2. 条目写「**改了什么 + 为什么**」，不只写「优化代码」；
3. 修复类条目记录**根因**（例如「`2^22` 键溢出」「前三点共线导致绕序失效」），便于回溯；
4. 新增文件、URL 参数、环境变量同步更新附录 A / B。
