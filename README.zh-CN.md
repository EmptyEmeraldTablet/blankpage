# blankpage

Blankpage 是一个面向个人的备忘录应用模板，前端为 Vue SPA，后端为 Cloudflare Worker API。使用 D1 保存备忘录，KV 用于鉴权、缓存与云剪贴板的短期存储。内置单用户密码登录，无注册、无后台管理。

功能亮点：

- 单用户密码登录（密码在 `wrangler.jsonc` 中设置）
- 备忘录增删改查（D1 持久化 + KV 缓存）
- 云剪贴板（KV 保存并自动过期）
- 自动保存、搜索、复制/粘贴等前端交互
- 支持 Worker-only 或 资产 + Worker 的部署模式

存储与架构：

- D1：备忘录持久化数据
- KV：鉴权 token、备忘录缓存、云剪贴板
- Worker：`/api/*` 路由，可配置 CORS（`CORS_ALLOWED_ORIGINS`）

## 快速开始

```sh
npm install
npm run setup
npm run dev
```

`npm run setup` 会引导创建 KV/D1、写入 `wrangler.jsonc`，并可选写入 `.env.local`（用于 `VITE_API_BASE`）。

## 手动配置

1. 复制模板配置：

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

2. 创建资源（或使用已有资源）：

```sh
npx wrangler kv:namespace create MEMO_KV
npx wrangler kv:namespace create MEMO_KV --preview
npx wrangler d1 create memo_db
```

3. 填写 `wrangler.jsonc` 中的占位符：

- `REPLACE_WITH_KV_ID`
- `REPLACE_WITH_KV_PREVIEW_ID`
- `REPLACE_WITH_D1_ID`
- `REPLACE_WITH_APP_PASSWORD`
- `REPLACE_WITH_CORS_ALLOWED_ORIGINS`

4. 应用本地迁移：

```sh
npx wrangler d1 migrations apply memo_db --local
```

5. （可选）配置 API 基地址：

```sh
cp .env.example .env.local
```

当需要调用远端 Worker 时设置 `VITE_API_BASE`。

## 本地开发

```sh
npm run dev
```

## 部署

仅部署 Worker：

```sh
npx wrangler deploy --config wrangler.jsonc --env worker_only
```

部署前端静态资源 + Worker：

```sh
npm run build
npx wrangler deploy --config wrangler.jsonc --env frontend
```

## 说明

- `wrangler.jsonc` 已被忽略，仓库内使用 `wrangler.example.jsonc` 作为模板。
- 生产环境请将 `CORS_ALLOWED_ORIGINS` 设置为你的 Pages 域名。
