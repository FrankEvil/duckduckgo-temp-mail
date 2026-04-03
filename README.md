# DuckDuckGo Temp Mail Extension

一个基于 Chromium 浏览器插件形态的临时邮箱工具。

当前版本支持两条能力：

- 使用 DuckDuckGo `Email Protection` 的 token 生成新的 `@duck.com` 别名
- 使用 Temp Mail 协议创建收件箱并拉取邮件列表，在插件里直接查看摘要和 raw 预览

## 当前功能

- DuckDuckGo 配置保存与恢复
- Temp Mail 配置保存与恢复
- 生成 DuckDuckGo 临时别名
- 创建 Temp Mail 收件箱会话
- 同步邮件列表
- 查看邮件详情和 raw 预览

## 技术栈

- React 18
- TypeScript
- Vite
- CRXJS
- Chrome Extension Manifest V3

## 环境要求

- Node.js 18 及以上
- Chrome / Edge 等 Chromium 浏览器
- 可用的 DuckDuckGo token
- 可用的 Temp Mail 服务地址和认证信息

## 安装依赖

```bash
npm install
```

## 构建插件

```bash
npm run build
```

构建完成后会生成 `dist/` 目录。

## 在浏览器中加载

### Chrome / Edge

1. 打开扩展管理页
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前项目下的 `dist` 目录
5. 加载成功后，就能在浏览器工具栏看到插件图标

## 第一次使用

### 1. 打开设置页

可以通过两种方式进入：

- 点击插件图标，在弹窗右上角点击“打开设置”
- 或者在扩展管理页里打开该插件的“扩展选项”

### 2. 填写 DuckDuckGo 配置

设置页里需要这几个字段：

| 字段 | 说明 | 是否必填 | 推荐值 |
| --- | --- | --- | --- |
| `API Base URL` | DuckDuckGo 别名生成接口根地址 | 是 | `https://quack.duckduckgo.com` |
| `Token` | DuckDuckGo Bearer token | 是 | 你抓到的 token |
| `Alias Domain` | 别名域名 | 是 | `duck.com` |

保存后页面会显示成功提示。

### 3. 填写 Temp Mail 配置

设置页里需要这几个字段：

| 字段 | 说明 | 是否必填 |
| --- | --- | --- |
| `Base URL` | 你的 Temp Mail 服务地址 | 是 |
| `Admin Auth` | Temp Mail 的 `x-admin-auth` | 是 |
| `Custom Auth` | 如果启用了私有站点密码，则填写 `x-custom-auth` | 否 |
| `Domain` | 创建邮箱地址时使用的域名 | 是 |
| `Name Prefix` | 自动生成收件箱地址时的前缀 | 否 |
| `轮询间隔（ms）` | 后续同步邮件时使用的间隔参数 | 否 |
| `轮询超时（ms）` | 后续同步邮件时使用的超时参数 | 否 |
| `创建地址时启用前缀` | 是否启用接口中的 `enablePrefix` | 否 |

保存后页面会显示成功提示。

## 正常使用流程

### 1. 生成 Duck 地址

打开插件弹窗后点击：

```text
生成 Duck 地址
```

成功后你会看到：

- 顶部出现成功提示
- 页面下方的 Duck 地址列表新增一个 `xxx@duck.com`

### 2. 创建 Temp 收件箱

点击：

```text
创建 Temp 收件箱
```

成功后你会看到：

- 顶部出现成功提示
- “当前收件箱”区域显示新创建的地址
- 设置页里的“收件箱会话”区域也能看到 `address` 和 `addressJwt`

### 3. 同步邮件

当你的 Temp Mail 收件箱已经有邮件后，点击：

```text
同步邮件
```

成功后你会看到：

- 邮件列表中出现主题、发件人、时间和摘要
- 点击某一封邮件后，下方会显示邮件详情和 raw 预览

## DuckDuckGo Token 获取方法

可以参考你本地这个项目中的说明：

- [/Users/liuzhaojun/IdeaProjects/codex-register/README.md](/Users/liuzhaojun/IdeaProjects/codex-register/README.md)

简化步骤如下：

1. 安装 DuckDuckGo 浏览器扩展
2. 开启 `Email Protection`
3. 打开浏览器开发者工具的 `Network`
4. 在 DuckDuckGo 扩展里执行一次“生成新地址”
5. 找到请求：

```text
https://quack.duckduckgo.com/api/email/addresses
```

6. 复制请求头里的：

```text
Authorization: Bearer <你的 token>
```

7. 把 `Bearer ` 后面的内容填进插件设置页的 `Token`

## Temp Mail 协议说明

当前项目按这套文档接入：

- [查看邮件 API](https://temp-mail-docs.awsl.uk/zh/guide/feature/mail-api.html)
- [新建邮箱地址 API](https://temp-mail-docs.awsl.uk/zh/guide/feature/new-address-api.html)

当前用到的核心接口是：

### 创建收件箱

```text
POST /admin/new_address
```

请求头：

```text
x-admin-auth: <你的 admin 密码>
x-custom-auth: <可选，你的网站密码>
```

请求体大致是：

```json
{
  "enablePrefix": true,
  "name": "duckrelay-xxxxxx12",
  "domain": "inbox.example.com"
}
```

### 拉取邮件

```text
GET /api/mails?limit=20&offset=0
```

请求头：

```text
Authorization: Bearer <addressJwt>
```

注意：

- 邮件接口默认返回的是 `raw MIME`
- 当前插件会优先展示主题、发件人、时间和摘要
- 如果接口没有直接返回结构化字段，插件会尝试从 raw 头部提取 `Subject`、`From`、`Date`

## 项目结构

```text
src/
  background/              后台脚本
  content/                 内容脚本
  features/
    ddg/                   DuckDuckGo 接口
    temp-mail/             Temp Mail 接口
    settings/              设置模型
  options/                 设置页
  popup/                   插件弹窗主页
  shared/
    config/                默认配置
    storage/               chrome.storage 封装
    styles/                全局样式
    types/                 共享类型
preview/
  extension-ui-preview.html  静态 UI 预览稿
```

## 常见问题

### 1. 点击“生成 Duck 地址”失败

优先检查：

- DuckDuckGo token 是否有效
- `API Base URL` 是否仍然是 `https://quack.duckduckgo.com`
- 你的 DuckDuckGo 扩展账号状态是否正常

### 2. 点击“创建 Temp 收件箱”失败

优先检查：

- `Base URL` 是否可访问
- `Admin Auth` 是否正确
- `Domain` 是否是 Temp Mail 服务支持的域名
- 如果目标站点启用了私有站点密码，是否填写了 `Custom Auth`

### 3. 点击“同步邮件”没有看到内容

优先检查：

- 当前是否已经先创建了 Temp Mail 收件箱
- 该收件箱是否真的收到了邮件
- `addressJwt` 是否有效
- 服务端 `/api/mails` 是否返回了可读数据

### 4. 为什么看到的是 raw 预览，不是完整正文

因为当前版本没有接入完整 MIME 解析器。
第一版只保证“能收、能看摘要、能看原始内容”，后续如果需要可以继续加上正文解析与更漂亮的渲染。

## 开发命令

```bash
npm run dev
npm run build
npm run check
```

## 当前限制

- 只支持 DuckDuckGo + Temp Mail 协议
- 还不支持 Gmail / Outlook
- 还不支持自动填表
- 还不支持附件展示
- 还不支持完整 HTML 正文解析
