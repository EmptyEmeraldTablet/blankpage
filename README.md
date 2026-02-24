# blankpage

Single-user memo app built with Vue + Cloudflare Workers. Data lives in D1, cache/auth/clip in KV.

## Project overview

Blankpage is a minimal, self-hosted memo app template designed for personal use. It ships with a Vue SPA frontend and a Worker API backend, with a simple password-based login and no registration or admin panel. Memos are stored in D1, while KV is used for authentication tokens, memo caching, and a short-lived cloud clipboard.

Key features:

- Single-user auth with a password set in `wrangler.jsonc`
- Memo CRUD backed by D1 with KV caching
- Cloud clip stored in KV with TTL and auto-expiration
- Autosave, search, and clipboard actions in the UI
- Worker-only or assets+worker deploy modes

Storage and architecture:

- D1: persistent memo data
- KV: auth tokens, memo cache, cloud clip
- Worker routes under `/api/*` with optional CORS via `CORS_ALLOWED_ORIGINS`

## Quickstart

```sh
npm install
npm run setup
npm run dev
```

`npm run setup` can create KV/D1 and write `wrangler.jsonc`. It also optionally writes `.env.local` for `VITE_API_BASE`.

## Manual setup

1. Copy template config:

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

2. Create resources (or use existing ones):

```sh
npx wrangler kv:namespace create MEMO_KV
npx wrangler kv:namespace create MEMO_KV --preview
npx wrangler d1 create memo_db
```

3. Fill `wrangler.jsonc` placeholders:

- `REPLACE_WITH_KV_ID`
- `REPLACE_WITH_KV_PREVIEW_ID`
- `REPLACE_WITH_D1_ID`
- `REPLACE_WITH_APP_PASSWORD`
- `REPLACE_WITH_CORS_ALLOWED_ORIGINS`

4. Apply local migrations:

```sh
npx wrangler d1 migrations apply memo_db --local
```

5. (Optional) configure API base URL:

```sh
cp .env.example .env.local
```

Set `VITE_API_BASE` when calling a remote Worker.

## Development

```sh
npm run dev
```

## Deploy

Worker-only:

```sh
npx wrangler deploy --config wrangler.jsonc --env worker_only
```

Frontend assets + Worker:

```sh
npm run build
npx wrangler deploy --config wrangler.jsonc --env frontend
```

## Notes

- `wrangler.jsonc` is ignored by git. Use `wrangler.example.jsonc` as the shared template.
- Set `CORS_ALLOWED_ORIGINS` to your Pages domain in production.
