# 同时支持 Vue 和 HTML
同时支持 Vue 和 HTML 格式的插件的前端部分的开发。

## HTML +js 
适合简单插件开发。但是js 格式不可控。错误发生率极高。老掉牙的技术

# vue
适合复杂插件开发。 Vue 框架 自带脚本验证能力。
而且有较好的组件拆分能力。
vue/src/App.vue   ←  你在改这里
        ↓
    yarn vite build
        ↓
ui/game.html    ←  iframe 加载，其他形式的嵌入，事件响应等