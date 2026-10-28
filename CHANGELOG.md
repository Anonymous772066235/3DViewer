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

1. 版本号**从末位递增**：`1.0.0.0` → `1.0.0.1` → `1.0.0.2` …（不是 `1.0.1.0`）；每次提交同步改 `index.html` 的 `?v=` 与副标题、以及本文件的标题行；
2. 条目写「**改了什么 + 为什么**」，不只写「优化代码」；
3. 修复类条目记录**根因**（例如「`2^22` 键溢出」「前三点共线导致绕序失效」），便于回溯；
4. 新增文件、URL 参数、环境变量同步更新附录 A / B。
