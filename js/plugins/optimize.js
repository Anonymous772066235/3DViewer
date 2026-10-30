/* 插件：孔位优化（调用 HoleOptimize_cli 优化当前网格，结果载入右侧）
 * 依赖：core / io / ui 已加载；按钮与错误弹窗在 window load 时绑定
 * 关闭方式：注释掉 index.html 里本文件的 <script> 即可，主程序完全不受影响
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    function notify(msg)
    {
        if (global.MV.ui && global.MV.ui.setInfo)
        {
            global.MV.ui.setInfo(msg);
        }
    }

    // ===== 功能开关：改 false 或整段注释即可一键关闭 =====
    var ENABLE_OPTIMIZE = true;
    if (!ENABLE_OPTIMIZE)
    {
        return;
    }

    // 同源优先：通过 serve.bat / serve.py 打开时（http），/optimize 与页面同源，
    // 只要页面能打开，优化服务一定在；file:// 打开时退回独立桥接服务 8790。
    var IS_HTTP = /^https?:$/i.test(global.location.protocol);
    var BASE = IS_HTTP ? '' : 'http://127.0.0.1:8790';
    var ENDPOINT = BASE + '/optimize';
    var HEALTH = BASE + '/health';

    function $id(id)
    {
        return document.getElementById(id);
    }

    function say(msg)
    {
        notify(msg);
    }

    function showError(title, detail)
    {
        var dlg = $id('errdlg');
        if (!dlg)
        {
            global.alert(title + '\n\n' + detail);
            return;
        }
        $id('err-title').textContent = title;
        $id('err-text').textContent = detail;
        dlg.classList.remove('hidden');
    }

    async function checkHealth()
    {
        var ctrl = new global.AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 2000);
        try
        {
            var resp = await global.fetch(HEALTH, { signal: ctrl.signal, cache: 'no-store' });
            return await resp.json();
        }
        finally
        {
            clearTimeout(timer);
        }
    }

    // 输入 = 当前显示的网格里“最新启用/载入”的那一个（不看选中项，避免误用已隐藏或旧图层）
    // 优先非优化产物：避免连续点击时把上一次的 *_oh.obj 再优化成 *_oh_oh.obj
    function findMeshLayer()
    {
        var app = global.MV.app;
        var best = null;
        var result = null;

        for (var i = 0; i < app.layers.length; i++)
        {
            var l = app.layers[i];
            if (l.kind !== 'mesh' || !l.visible || !l.sourceFile)
            {
                continue;
            }
            if (l.isResult)
            {
                if (!result || (l.shownAt || 0) >= (result.shownAt || 0))
                {
                    result = l;
                }
                continue;
            }
            if (!best || (l.shownAt || 0) >= (best.shownAt || 0))
            {
                best = l;
            }
        }
        return best || result;
    }

    function findEdgeFile()
    {
        // 同批拖入的 edge_pts.txt 优先；否则由服务端按文件名在 data 下自动查找
        var layers = global.MV.app.layers;
        for (var i = layers.length - 1; i >= 0; i--)
        {
            var l = layers[i];
            if (l.kind === 'points' && l.sourceFile && /edge_pts/i.test(l.sourceFile.name))
            {
                return l.sourceFile;
            }
        }
        return null;
    }

    var running = false;

    async function run()
    {
        if (running)
        {
            return;
        }

        var layer = findMeshLayer();
        if (!layer)
        {
            say('当前没有显示的网格');
            showError('没有可优化的网格',
                '当前没有处于显示状态（勾选）的网格。\n\n' +
                '请先在场景树里勾选一个 STL / OBJ 网格，或在左侧导入一个，再点击「孔位优化」。\n\n' +
                '提示：需要配套的 edge_pts.txt（边界点云），可一起拖入，\n' +
                '或把网格放在 HoleOptimize/data/<数据集>/ 下（同目录含 edge_pts.txt）。');
            return;
        }

        running = true;
        var btn = $id('btn-optimize');
        if (btn)
        {
            btn.disabled = true;
            btn.textContent = '优化中…';
        }

        function resetBtn()
        {
            running = false;
            if (btn)
            {
                btn.disabled = false;
                btn.textContent = '孔位优化';
            }
        }

        // 0) 先确认 bridge 在线、exe 存在，避免只抛出含糊的 "Failed to fetch"
        var health = null;
        try
        {
            health = await checkHealth();
        }
        catch (e)
        {
            resetBtn();
            say('优化失败：本地服务未运行');
            var tip;
            if (IS_HTTP)
            {
                tip = '优化接口不可达。通常是 serve.bat 的控制台窗口已被关闭：\n\n' +
                    '重新双击  3DViewer\\serve.bat  即可（页面与优化接口在同一个服务里）。\n\n' +
                    '若反复失败，请查看 serve 窗口中的 Python 报错。';
            }
            else
            {
                tip = '当前是直接双击 index.html（file://）打开的。\n\n' +
                    '浏览器安全模型不允许网页启动本地程序，所以这一步必须由你触发一次：\n\n' +
                    '    双击  3DViewer\\serve.bat\n\n' +
                    '它会在 http://127.0.0.1:8765/ 打开同一页面，并且页面与优化接口同源，\n' +
                    '之后点「孔位优化」不再需要任何额外步骤。\n\n' +
                    '（也可只双击 bridge\\start_bridge.bat，仅启动优化服务）';
            }
            showError('无法连接优化服务', tip);
            return;
        }

        if (health && health.exists === false)
        {
            resetBtn();
            say('优化失败：找不到 HoleOptimize_cli.exe');
            showError('找不到 HoleOptimize_cli.exe',
                '服务端使用的路径：\n  ' + (health.exe || '(未知)') + '\n\n' +
                '请先构建 C++ 程序：\n' +
                '  cd HoleOptimize\n' +
                '  cmake --build build --config Release --parallel\n\n' +
                '构建后重启 start_bridge.bat；\n' +
                '也可用环境变量 HOLEOPT_EXE 指定 exe 路径。');
            return;
        }

        say('正在优化：' + layer.name + (layer.isResult ? '（结果图层）' : '') + ' …');

        try
        {
            var fd = new global.FormData();
            fd.append('mesh', layer.sourceFile, layer.sourceFile.name);

            var edge = findEdgeFile();
            if (edge)
            {
                fd.append('edge', edge, edge.name);
            }

            var resp = await global.fetch(ENDPOINT, {
                method: 'POST',
                body: fd,
                headers: { 'X-Mesh-Name': encodeURIComponent(layer.sourceFile.name) }
            });

            if (!resp.ok)
            {
                var txt = await resp.text();
                var obj = null;
                try
                {
                    obj = JSON.parse(txt);
                }
                catch (e)
                {
                    obj = null;
                }

                var brief = (obj && obj.error) || txt || ('HTTP ' + resp.status);
                var detail = brief;
                if (obj && obj.trace)
                {
                    detail += '\n\n--- 服务端堆栈 ---\n' + obj.trace;
                }
                if (obj && obj.log)
                {
                    detail += '\n\n日志文件：' + obj.log;
                }

                var httpErr = new Error(detail);
                httpErr.brief = String(brief).split('\n')[0];
                throw httpErr;
            }

            var blob = await resp.blob();
            var name = decodeURIComponent(resp.headers.get('X-Result-Name') || '') || 'result_oh.obj';
            var file = new global.File([blob], name, { type: 'application/octet-stream' });

            await global.MV.app.addFiles([file], 'B');

            // 标记为“优化产物”：下次点击优先选原始网格，避免 _oh -> _oh_oh
            var layers = global.MV.app.layers;
            for (var li = layers.length - 1; li >= 0; li--)
            {
                if (layers[li].sourceFile === file)
                {
                    layers[li].isResult = true;
                    layers[li].parentId = layer.id;   // 结果挂到被优化的源图层下
                    break;
                }
            }

            say('优化完成，已自动载入右侧：' + name);
        }
        catch (err)
        {
            if (global.console)
            {
                global.console.error('[optimize]', err);
            }
            showError('孔位优化失败', err.message || String(err));
            say('优化失败：' + (err.brief || String(err.message || err).split('\n')[0]));
        }
        finally
        {
            resetBtn();
        }
    }

    // 便于调试/自动化：带 ?runoptimize=1 时，左侧载入完成后自动执行一次
    function autoRunIfRequested()
    {
        var cfg = global.MV.config || {};
        if (!cfg.runOptimize)
        {
            return;
        }

        var fired = false;
        function attempt()
        {
            if (fired || !findMeshLayer())
            {
                return;
            }
            fired = true;
            run();
        }

        global.addEventListener('mv:loaded', attempt);
        attempt();                       // ?url= 可能在监听前就已加载完成
        setTimeout(attempt, 3000);       // 兜底
    }

    window.addEventListener('load', function ()
    {
        var btn = $id('btn-optimize');
        if (btn)
        {
            btn.addEventListener('click', run);
            // UI 上标注：这是插件功能（注释掉插件 script 时标记一起消失）
            btn.classList.add('is-plugin');
            btn.title = '［插件］' + btn.title;
        }

        var errClose = $id('err-close');
        if (errClose)
        {
            errClose.addEventListener('click', function ()
            {
                var dlg = $id('errdlg');
                if (dlg)
                {
                    dlg.classList.add('hidden');
                }
            });
        }

        autoRunIfRequested();
    });

    global.MV.optimize = { run: run, enabled: ENABLE_OPTIMIZE };

    if (global.MV.plugins && global.MV.plugins.register)
    {
        global.MV.plugins.register({ id: 'optimize', name: '孔位优化', init: function () {} });
    }

})(window);
