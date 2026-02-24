interface Env {
	DB: D1Database;
	MEMO_KV: KVNamespace;
	APP_PASSWORD: string;
	SESSION_TTL_SECONDS?: string;
	CLIP_TTL_SECONDS?: string;
	CACHE_TTL_SECONDS?: string;
	CORS_ALLOWED_ORIGINS?: string;
}

type MemoRow = {
	id: number;
	content: string;
	created_at: string;
	updated_at: string;
};

const API_PREFIX = "/api";
const MEMO_LIST_CACHE_KEY = "memo:list";
const CLIP_CACHE_KEY = "clip:latest";
const CORS_ALLOW_METHODS = "GET,POST,PUT,DELETE,OPTIONS";

function jsonResponse(data: unknown, init: ResponseInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(data), { ...init, headers });
}

function parseAllowedOrigins(value: string | undefined) {
	if (!value) return ["*"];
	return value
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
}

function getCorsHeaders(request: Request, env: Env) {
	const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
	const requestOrigin = request.headers.get("origin");
	let allowOrigin: string | null = null;

	if (allowedOrigins.includes("*")) {
		allowOrigin = "*";
	} else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
		allowOrigin = requestOrigin;
	}

	if (!allowOrigin) {
		return null;
	}

	const headers = new Headers();
	headers.set("access-control-allow-origin", allowOrigin);
	headers.set("access-control-allow-methods", CORS_ALLOW_METHODS);
	const requestedHeaders = request.headers.get("access-control-request-headers");
	headers.set("access-control-allow-headers", requestedHeaders ?? "content-type, authorization");
	headers.set("access-control-max-age", "86400");
	if (allowOrigin !== "*") {
		headers.set("vary", "origin");
	}
	return headers;
}

function applyCors(response: Response, corsHeaders: Headers | null) {
	if (!corsHeaders) {
		return response;
	}
	const headers = new Headers(response.headers);
	corsHeaders.forEach((value, key) => headers.set(key, value));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function getNumberEnv(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}

function getBearerToken(request: Request) {
	const header = request.headers.get("authorization") || "";
	const [type, token] = header.split(" ");
	if (type !== "Bearer" || !token) {
		return null;
	}
	return token;
}

async function requireAuth(request: Request, env: Env) {
	const token = getBearerToken(request);
	if (!token) {
		return { ok: false as const, response: jsonResponse({ error: "unauthorized" }, { status: 401 }) };
	}
	const exists = await env.MEMO_KV.get(`auth:token:${token}`);
	if (!exists) {
		return { ok: false as const, response: jsonResponse({ error: "unauthorized" }, { status: 401 }) };
	}
	return { ok: true as const, token };
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const { pathname } = url;
		const corsHeaders = getCorsHeaders(request, env);
		const respond = (response: Response) => applyCors(response, corsHeaders);
		const respondJson = (data: unknown, init: ResponseInit = {}) => respond(jsonResponse(data, init));

		if (request.method === "OPTIONS") {
			return respond(new Response(null, { status: 204 }));
		}

		if (!pathname.startsWith(API_PREFIX)) {
			return respond(new Response(null, { status: 404 }));
		}

		if (pathname === `${API_PREFIX}/login` && request.method === "POST") {
			const body = await readJson<{ password?: string }>(request);
			if (!body?.password || body.password !== env.APP_PASSWORD) {
				return respondJson({ error: "invalid_credentials" }, { status: 401 });
			}
			const token = crypto.randomUUID();
			const ttl = getNumberEnv(env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 7);
			await env.MEMO_KV.put(`auth:token:${token}`, "1", { expirationTtl: ttl });
			return respondJson({ token });
		}

		const auth = await requireAuth(request, env);
		if (!auth.ok) {
			return respond(auth.response);
		}

		if (pathname === `${API_PREFIX}/memos` && request.method === "GET") {
			const cached = await env.MEMO_KV.get(MEMO_LIST_CACHE_KEY);
			if (cached) {
				return respondJson(JSON.parse(cached));
			}
			const result = await env.DB.prepare(
				"SELECT id, content, created_at, updated_at FROM memos ORDER BY updated_at DESC",
			).all<MemoRow>();
			const rows = result.results ?? [];
			const ttl = getNumberEnv(env.CACHE_TTL_SECONDS, 60);
			await env.MEMO_KV.put(MEMO_LIST_CACHE_KEY, JSON.stringify(rows), { expirationTtl: ttl });
			return respondJson(rows);
		}

		if (pathname === `${API_PREFIX}/memos` && request.method === "POST") {
			const body = await readJson<{ content?: string }>(request);
			if (!body || typeof body.content !== "string") {
				return respondJson({ error: "invalid_payload" }, { status: 400 });
			}
			const now = new Date().toISOString();
			const result = await env.DB.prepare(
				"INSERT INTO memos (content, created_at, updated_at) VALUES (?1, ?2, ?3)",
			)
				.bind(body.content, now, now)
				.run();
			const id = Number(result.meta.last_row_id);
			await env.MEMO_KV.delete(MEMO_LIST_CACHE_KEY);
			const memo: MemoRow = { id, content: body.content, created_at: now, updated_at: now };
			return respondJson(memo, { status: 201 });
		}

		const memoIdMatch = pathname.match(/^\/api\/memos\/(\d+)$/);
		if (memoIdMatch) {
			const id = Number(memoIdMatch[1]);
			const cacheKey = `memo:${id}`;

			if (request.method === "GET") {
				const cached = await env.MEMO_KV.get(cacheKey);
				if (cached) {
					return respondJson(JSON.parse(cached));
				}
				const row = await env.DB.prepare(
					"SELECT id, content, created_at, updated_at FROM memos WHERE id = ?1",
				)
					.bind(id)
					.first<MemoRow>();
				if (!row) {
					return respondJson({ error: "not_found" }, { status: 404 });
				}
				const ttl = getNumberEnv(env.CACHE_TTL_SECONDS, 60);
				await env.MEMO_KV.put(cacheKey, JSON.stringify(row), { expirationTtl: ttl });
				return respondJson(row);
			}

			if (request.method === "PUT") {
				const body = await readJson<{ content?: string }>(request);
				if (!body || typeof body.content !== "string") {
					return respondJson({ error: "invalid_payload" }, { status: 400 });
				}
				const now = new Date().toISOString();
				const result = await env.DB.prepare(
					"UPDATE memos SET content = ?1, updated_at = ?2 WHERE id = ?3",
				)
					.bind(body.content, now, id)
					.run();
				if (!result.meta.changes) {
					return respondJson({ error: "not_found" }, { status: 404 });
				}
				await env.MEMO_KV.delete(MEMO_LIST_CACHE_KEY);
				await env.MEMO_KV.delete(cacheKey);
				const row = await env.DB.prepare(
					"SELECT id, content, created_at, updated_at FROM memos WHERE id = ?1",
				)
					.bind(id)
					.first<MemoRow>();
				return respondJson(row ?? { id, content: body.content, created_at: now, updated_at: now });
			}

			if (request.method === "DELETE") {
				const result = await env.DB.prepare("DELETE FROM memos WHERE id = ?1").bind(id).run();
				if (!result.meta.changes) {
					return respondJson({ error: "not_found" }, { status: 404 });
				}
				await env.MEMO_KV.delete(MEMO_LIST_CACHE_KEY);
				await env.MEMO_KV.delete(cacheKey);
				return respond(new Response(null, { status: 204 }));
			}
		}

		if (pathname === `${API_PREFIX}/clip` && request.method === "GET") {
			const cached = await env.MEMO_KV.get(CLIP_CACHE_KEY);
			if (!cached) {
				return respondJson({ text: null });
			}
			return respondJson(JSON.parse(cached));
		}

		if (pathname === `${API_PREFIX}/clip` && request.method === "POST") {
			const body = await readJson<{ text?: string }>(request);
			if (!body || typeof body.text !== "string") {
				return respondJson({ error: "invalid_payload" }, { status: 400 });
			}
			const payload = { text: body.text, created_at: new Date().toISOString() };
			const ttl = getNumberEnv(env.CLIP_TTL_SECONDS, 60 * 60 * 24);
			await env.MEMO_KV.put(CLIP_CACHE_KEY, JSON.stringify(payload), { expirationTtl: ttl });
			return respondJson(payload, { status: 201 });
		}

		return respondJson({ error: "not_found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
