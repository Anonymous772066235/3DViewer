/* 插件注册表：MV.plugins
 * 插件文件里 MV.plugins.register({ id, name, init(app) })；
 * app 启动后调用 MV.plugins.initAll(app)（未加载插件时 MV.plugins 不存在，主程序用 if 保护）。
 * 关闭某个插件：注释掉 index.html 里对应的 <script>，主程序不受影响。
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    var list = [];

    global.MV.plugins = {
        register: function (p)
        {
            if (p && p.id)
            {
                list.push(p);
            }
        },

        initAll: function (app)
        {
            for (var i = 0; i < list.length; i++)
            {
                var p = list[i];
                if (p.enabled === false)
                {
                    continue;
                }
                try
                {
                    if (typeof p.init === 'function')
                    {
                        p.init(app);
                    }
                }
                catch (e)
                {
                    console.error('[plugin:' + p.id + ']', e);
                }
            }
        },

        list: function ()
        {
            var out = [];
            for (var i = 0; i < list.length; i++)
            {
                out.push({ id: list[i].id, name: list[i].name, enabled: list[i].enabled !== false });
            }
            return out;
        }
    };

})(window);
