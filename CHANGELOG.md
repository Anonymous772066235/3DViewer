# viewer3d 改动日志（CHANGELOG）

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

- 父仓库 `OptimizeHole2D/.gitignore` 增加 `viewer3d/`（父仓库从未跟踪该目录，直接生效，无需 `git rm --cached`），为 `viewer3d` 建立**独立仓库**做准备。


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
