import z from "@deepseek-ai/schemastery";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import "@deepseek-ai/cordis";
import { homedir, hostname, platform, userInfo } from "node:os";
import { isAbsolute as isAbsolute$1, join as join$1 } from "node:path/posix";
import { createHash, randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
//#region src/mount-once.ts
/**
* Host single-instance guard shared by the plugin family. The family bundle
* (dsh-web-all / dsh-skins) namespaces every child row id (web-ui-*), so
* the loader accepts a standalone install of the same package side by side;
* without this guard the second instance would still re-register the same
* webserver routes, tools, settings namespaces, and system-prompt sections
* and fail the boot. mountOnce makes a mount of an already-mounted package a
* no-op for as long as the first instance lives (the browser half is already
* deduped by package name in the client module host).
*
* A no-op is only safe while the holder is ALIVE. The holder can be disposed
* long after the refused mount ran its course: the Host reloads a profile by
* creating the new loader entries before the old ones are torn down (a
* plugin-manager enable/disable/install write, a settings-driven row reload,
* HMR), so the new aggregate shell entry mounts its family plugin while the
* previous entry still owns the name. Dropping that refused mount lost the
* plugin for good - the previous entry then disposed its own mount, releasing
* the name with nobody left to take it, and the family row stayed listed as
* active while its host routes 404ed (the task-board panel showed
* "board.hostError.notMounted", no degraded record appeared, and only a Host
* restart recovered it).
*
* The refused mount is therefore QUEUED, not dropped, and replayed the moment
* the holder releases the name - if the waiting fiber is still alive then. The
* single-instance guarantee is unchanged: exactly one mount is live per
* package name, and the replay re-enters the guard so a later mount still
* dedupes against it.
*
* The registry rides a global symbol so two module instances of the same
* package (npm copy vs repository link) still share one verdict. That symbol
* is a CROSS-REPOSITORY contract, not this file's private state: the four
* satellite packages (dsh-skins / dsh-pet / dsh-presets /
* dsh-community-plugins) are separate repositories carrying their own copy of
* this guard, rebuilt on their own schedule, so the value under `MOUNTED`
* must keep the shape every published copy reads (a `Set` of package names
* with `has`/`add`/`delete`). The wait queues this guard added therefore live
* under their own additive key, and the registry reads back a `Set` even when
* some other build left a different value there. Changing `MOUNTED`'s shape
* in place broke that contract once: a satellite's legacy copy created a
* `Set`, the family's new copy read it as a `Map`, and every family row
* mounted after it failed with "claims.get is not a function".
*
* cordis `ctx.effect` runs its callback immediately and treats the callback's
* return value as the fiber disposer, so the unmarker is returned, not run.
*/
/** Published cross-repository contract: package names currently mounted. */
const MOUNTED = Symbol.for("dsh-web.mounted-plugins");
/** Additive key this guard owns: refused mounts waiting for the name. */
const WAITERS = Symbol.for("dsh-web.mounted-plugins.waiters");
/**
* The shared name registry, always a `Set` whatever another build stored here:
* a foreign value (an interim shape, a hand-written global) must not take every
* family plugin down with it.
* @returns the process-wide set of mounted package names.
*/
function mountedSet() {
	const registry = globalThis;
	const existing = registry[MOUNTED];
	if (existing instanceof Set) return existing;
	const created = /* @__PURE__ */ new Set();
	registry[MOUNTED] = created;
	return created;
}
/** Queue per package name for mounts refused while a holder was alive. */
function mountWaiters() {
	const registry = globalThis;
	return registry[WAITERS] ??= /* @__PURE__ */ new Map();
}
/**
* Wrap a cordis plugin apply so the package runs at most once per process.
* The first mount registers normally and releases the name when its fiber
* disposes; a mount refused while that name is held waits for the release and
* then runs, unless its own fiber disposes first.
* @param packageName - npm package identity shared by every install source.
* @param fn - the original plugin apply.
* @returns an apply of the same shape.
*/
function mountOnce(packageName, fn) {
	const mount = (...args) => {
		const mounted = mountedSet();
		const ctx = args[0];
		if (mounted.has(packageName)) {
			const waiters = mountWaiters();
			const queue = waiters.get(packageName) ?? [];
			let alive = true;
			const pending = { run: () => {
				if (alive) mount(...args);
			} };
			ctx?.effect?.(() => () => {
				alive = false;
				const index = queue.indexOf(pending);
				if (index >= 0) queue.splice(index, 1);
			});
			queue.push(pending);
			waiters.set(packageName, queue);
			return;
		}
		mounted.add(packageName);
		ctx?.effect?.(() => () => {
			mounted.delete(packageName);
			const waiters = mountWaiters();
			const queue = waiters.get(packageName);
			if (queue === void 0) return;
			waiters.delete(packageName);
			for (const waiter of queue.splice(0)) queueMicrotask(() => {
				waiter.run();
			});
		});
		return fn(...args);
	};
	return mount;
}
//#endregion
//#region ../../node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.1-rc.2_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-brand/lib/index.js
/**
* Duplicate-install-safe nominal primitive helpers.
*
* A brand makes structurally identical strings or numbers non-interchangeable
* at the type level: a `SessionId` cannot be passed where a `ToolCallId` is
* expected, and an event sequence cannot be passed as a log offset. Comparison,
* logging, and serialization retain the underlying primitive behavior.
*
* This package owns no concrete domain value and keeps no runtime identity or mutable
* state, so independently installed copies produce interchangeable values.
*
* @module @deepseek-ai/dsh-brand
*/
/**
* Apply a compile-time string brand without changing the value.
* @param value - string admitted by the domain that owns the target brand.
* @returns the same string with the requested compile-time brand.
*/
function brandString(value) {
	return value;
}
//#endregion
//#region ../../node_modules/.pnpm/@deepseek-ai+dsh-credential_2be073937f192ef01e0580d4ecee1ed9/node_modules/@deepseek-ai/dsh-credentials/lib/index.js
/**
* Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
* *references* to secrets — environment-variable names — while providers own
* the actual values and their storage. Consumers resolve a reference once per
* operation, so a changed credential reaches the next operation without any
* plugin restart, and configuration surfaces describe a reference without
* ever seeing its value.
* @module @deepseek-ai/dsh-credentials
*/
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Both halves of a {@link CredentialKey}; the `/` between them is what keeps it out of {@link REF_PATTERN}. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link CredentialRef}.
* @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
* @returns the branded reference.
*/
function credentialRef(value) {
	if (!isCredentialRefName(value)) throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`);
	return brandString(value);
}
/**
* Whether a raw string could name a reference at all. Consumers that receive
* environment-variable names from somewhere else — a provider library's own
* ambient discovery, a hook payload — ask this before resolving, because a name
* outside the grammar has no reference to miss and should read as "not set"
* rather than as a thrown error.
* @param value - candidate reference.
* @returns true when {@link credentialRef} would accept it.
*/
function isCredentialRefName(value) {
	return REF_PATTERN.test(value);
}
/**
* Brand a scope and an id as a {@link CredentialKey}.
* @param scope - the owning plugin's registered name, such as `llm-pi-ai`.
* @param id - that plugin's own addressing unit, such as a provider route key.
* @returns the branded key.
* @throws TypeError when either segment is not a lowercase hyphenated identifier.
*/
function credentialKey(scope, id) {
	for (const segment of [scope, id]) if (!KEY_SEGMENT_PATTERN.test(segment)) throw new TypeError(`credential key segment "${segment}" must match ${String(KEY_SEGMENT_PATTERN)}`);
	return brandString(`${scope}/${id}`);
}
//#endregion
//#region src/dsh-home.ts
/**
* DSH_HOME resolution shared by the plugin family's Host halves: the
* environment override wins, the platform home fallback follows. Mirrors
* what dsh-pet and dsh-liangshen each used to implement locally.
*/
/** Expand a leading ~ (or ~user) in a path, platform-style. */
function expandHome(path, home = homedir()) {
	const j = home.startsWith("/") ? join$1 : join;
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return j(home, path.slice(2));
	return path;
}
/**
* Resolve the DSH home directory.
* @param env - process environment to read DSH_HOME from.
* @param home - platform home directory fallback (test seam).
* @returns the absolute DSH home path.
*/
function resolveDshHome(env = process.env, home = homedir()) {
	const isPosix = home.startsWith("/");
	const j = isPosix ? join$1 : join;
	const isAbs = isPosix ? isAbsolute$1 : isAbsolute;
	const raw = env.DSH_HOME;
	if (raw !== void 0 && raw.trim() !== "") {
		const expanded = expandHome(raw.trim(), home);
		return isAbs(expanded) ? expanded : j(process.cwd(), expanded);
	}
	return j(home, ".dsh");
}
/** Resolve the DSH home directory from the live environment. */
function dshHome() {
	return resolveDshHome();
}
//#endregion
//#region src/host/http.ts
/** Family-default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/**
* Request init that asks a remote origin for an uncompressed body.
*
* The DSH host boots `@deepseek-ai/dsh-http-proxy`, whose top-level import of
* the npm `undici` copy replaces the legacy `undici.globalDispatcher.1` slot
* Node's built-in `fetch()` reads. That cross-major wrapper drops the
* `content-encoding` header and automatic decompression, so a plain fetch
* resolves to raw gzip/brotli/zstd bytes — compressed noise no JSON or text
* consumer can read. Every host fetch that parses a remote body must request
* identity encoding. Caller headers survive; `accept-encoding` is forced to
* `identity` because a caller value has no decoder behind it in this host.
* @param init - the caller's request init (signal, headers, method, ...).
* @returns a copy with `accept-encoding: identity` merged in.
*/
function withIdentityEncoding(init = {}) {
	const headers = new Headers(init.headers);
	headers.set("accept-encoding", "identity");
	return {
		...init,
		headers
	};
}
/**
* Write one JSON response. Default headers are the family defaults
* (content-type and referrer-policy); caller headers are appended or
* override them.
*/
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(payload);
}
//#endregion
//#region src/core/adapters.ts
/** Parse a string/number into a finite number, else undefined. */
function toNum(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/** Read a string field that must be a non-empty string. */
function str(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** Clamp a provider percentage into the renderable 0-100 band. */
function clampPercent(value) {
	return Math.max(0, Math.min(100, value));
}
/** Format a number to a fixed 2-decimal display string. */
function money(value) {
	return value.toFixed(2);
}
/** Millisecond epoch or ISO string → normalized ISO 8601, else undefined. */
function toIso(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		const ms = value < 0xe8d4a51000 ? value * 1e3 : value;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? void 0 : date.toISOString();
	}
	const text = str(value);
	if (text === void 0) return void 0;
	if (/^\d+$/.test(text)) return toIso(Number(text));
	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? void 0 : date.toISOString();
}
/** Used-percent helper guarding zero/absent limits. */
function usedPercent(used, limit) {
	const usedNum = toNum(used);
	const limitNum = toNum(limit);
	if (usedNum === void 0 || limitNum === void 0 || limitNum <= 0) return void 0;
	return Math.max(0, Math.min(100, usedNum / limitNum * 100));
}
function bearer(apiKey) {
	return { authorization: `Bearer ${apiKey}` };
}
const DEEPSEEK = {
	ids: ["deepseek", "deepseek-official"],
	familyOnlyIds: ["deepseek-account"],
	displayName: "DeepSeek",
	balance: {
		origin: "https://api.deepseek.com",
		build: ({ apiKey }) => ({
			url: "https://api.deepseek.com/user/balance",
			headers: bearer(apiKey)
		}),
		parse: (status, body) => {
			if (status !== 200 || typeof body !== "object" || body === null) return void 0;
			const infos = body.balance_infos;
			if (!Array.isArray(infos) || infos.length === 0) return void 0;
			const first = infos[0];
			if (typeof first !== "object" || first === null) return void 0;
			const currency = str(first.currency);
			const total = str(first.total_balance);
			if (currency === void 0 || total === void 0) return void 0;
			return {
				currency,
				totalBalance: total
			};
		}
	}
};
/** Moonshot pay-as-you-go balance; CN bills in CNY, international in USD. */
function moonshotBalance(host, currency, ids) {
	return {
		ids,
		displayName: "Moonshot AI",
		balance: {
			build: ({ apiKey }) => ({
				url: `https://${host}/v1/users/me/balance`,
				headers: bearer(apiKey)
			}),
			parse: (status, body) => {
				if (status !== 200 || typeof body !== "object" || body === null) return void 0;
				const data = body.data;
				if (typeof data !== "object" || data === null) return void 0;
				const available = toNum(data.available_balance);
				if (available === void 0) return void 0;
				return {
					currency,
					totalBalance: money(available)
				};
			}
		}
	};
}
/** Kimi For Coding quota: top-level `usage` is the weekly summary, `limits[]` the per-window rows. */
const KIMI_CODING = {
	ids: ["kimi-coding"],
	displayName: "Kimi For Coding",
	plan: {
		build: ({ apiKey }) => ({
			url: "https://api.kimi.com/coding/v1/usages",
			headers: bearer(apiKey)
		}),
		parse: (status, body) => {
			if (status !== 200 || typeof body !== "object" || body === null) return void 0;
			const root = body;
			const windows = [];
			const limits = root.limits;
			if (Array.isArray(limits)) for (const entry of limits) {
				if (typeof entry !== "object" || entry === null) continue;
				const detail = entry.detail;
				const window = entry.window;
				if (typeof detail !== "object" || detail === null) continue;
				const row = detail;
				const duration = typeof window === "object" && window !== null ? toNum(window.duration) : void 0;
				const unit = typeof window === "object" && window !== null ? str(window.timeUnit) : void 0;
				const key = duration === 300 && unit === "TIME_UNIT_MINUTE" ? "5h" : duration !== void 0 ? `w-${duration}` : "window";
				const percent = usedPercent(row.used, row.limit);
				windows.push({
					key,
					name: str(row.name),
					percent,
					resetsAt: toIso(row.resetTime)
				});
			}
			const usage = root.usage;
			if (typeof usage === "object" && usage !== null) {
				const weekly = usage;
				windows.push({
					key: "week",
					name: "Weekly",
					percent: usedPercent(weekly.used, weekly.limit),
					resetsAt: toIso(weekly.resetTime)
				});
			}
			if (windows.length === 0) return void 0;
			const user = root.user;
			const membership = typeof user === "object" && user !== null ? user.membership : void 0;
			return {
				planName: typeof membership === "object" && membership !== null ? str(membership.level) : void 0,
				windows
			};
		}
	}
};
/**
* GLM Coding Plan quota windows, keyed by the provider's own `unit` code
* rather than by row position so an added or reordered limit cannot shift a
* window's meaning: 3 = the rolling 5-hour window, 6 = the weekly window,
* 5 = the monthly one. Two row kinds carry quota — `TOKENS_LIMIT` (token
* plans) and `CREDIT_LIMIT` (credit plans, whose exact ratio is
* `currentValue` / `usage`) — while `TIME_LIMIT` is the MCP request cap and
* is not a plan window at all. Auth is the RAW key without a Bearer prefix.
*/
const GLM_UNIT_KEYS = {
	3: "5h",
	5: "month",
	6: "week"
};
/** Percent from a credit row's exact ratio, else the provider's own percentage. */
function glmCreditPercent(row) {
	const used = toNum(row.currentValue);
	const limit = toNum(row.usage);
	if (used !== void 0 && limit !== void 0 && limit > 0) return clampPercent(used / limit * 100);
	const percentage = toNum(row.percentage);
	return percentage === void 0 ? void 0 : clampPercent(percentage);
}
function glmPlan(host, ids) {
	return {
		ids,
		displayName: "GLM Coding Plan",
		plan: {
			build: ({ apiKey }) => ({
				url: `https://${host}/api/monitor/usage/quota/limit`,
				headers: {
					authorization: apiKey,
					"accept-language": "en-US,en"
				}
			}),
			parse: (status, body) => {
				if (status !== 200 || typeof body !== "object" || body === null) return void 0;
				const root = body;
				if (root.success !== true) return void 0;
				const data = root.data;
				if (typeof data !== "object" || data === null) return void 0;
				const limits = data.limits;
				if (!Array.isArray(limits)) return void 0;
				const windows = [];
				for (const entry of limits) {
					if (typeof entry !== "object" || entry === null) continue;
					const row = entry;
					const kind = str(row.type);
					if (kind === "TIME_LIMIT") continue;
					const key = GLM_UNIT_KEYS[toNum(row.unit) ?? NaN];
					if (key === void 0) continue;
					if (kind !== "TOKENS_LIMIT" && kind !== "CREDIT_LIMIT") continue;
					windows.push({
						key,
						percent: kind === "CREDIT_LIMIT" ? glmCreditPercent(row) : (() => {
							const percentage = toNum(row.percentage);
							return percentage === void 0 ? void 0 : clampPercent(percentage);
						})(),
						resetsAt: toIso(row.nextResetTime)
					});
				}
				if (windows.length === 0) return void 0;
				return {
					planName: str(data.level),
					windows
				};
			}
		}
	};
}
/** OpenCode Go quota: percent-only rolling/weekly/monthly windows. */
const OPENCODE_GO = {
	ids: ["opencode-go"],
	displayName: "OpenCode Go",
	plan: {
		build: ({ apiKey }) => ({
			url: "https://opencode.ai/zen/go/v1/usage",
			headers: bearer(apiKey)
		}),
		parse: (status, body) => {
			if (status !== 200 || typeof body !== "object" || body === null) return void 0;
			const usage = body.usage;
			if (typeof usage !== "object" || usage === null) return void 0;
			const windows = [];
			for (const [field, key] of [
				["rolling", "5h"],
				["weekly", "week"],
				["monthly", "month"]
			]) {
				const entry = usage[field];
				if (typeof entry !== "object" || entry === null) continue;
				const row = entry;
				const percent = toNum(row.percent);
				windows.push({
					key,
					percent: percent === void 0 ? void 0 : Math.max(0, Math.min(100, percent)),
					resetsAt: percent === 0 ? void 0 : toIso(row.resetsAt)
				});
			}
			if (windows.length === 0) return void 0;
			return { windows };
		}
	}
};
/** MiniMax coding-plan remains: remaining-percent semantics, `general` model entry. */
function minimaxPlan(host, ids) {
	return {
		ids,
		displayName: "MiniMax Coding Plan",
		plan: {
			build: ({ apiKey }) => ({
				url: `https://${host}/v1/api/openplatform/coding_plan/remains`,
				headers: bearer(apiKey)
			}),
			parse: (status, body) => {
				if (status !== 200 || typeof body !== "object" || body === null) return void 0;
				const remains = body.model_remains;
				if (!Array.isArray(remains)) return void 0;
				const general = remains.find((entry) => typeof entry === "object" && entry !== null && entry.model_name === "general");
				if (typeof general !== "object" || general === null) return void 0;
				const row = general;
				const windows = [];
				const intervalRemaining = toNum(row.current_interval_remaining_percent);
				if (intervalRemaining !== void 0) windows.push({
					key: "5h",
					percent: Math.max(0, Math.min(100, 100 - intervalRemaining)),
					resetsAt: toIso(row.end_time)
				});
				if (row.current_weekly_status === 1) {
					const weeklyRemaining = toNum(row.current_weekly_remaining_percent);
					if (weeklyRemaining !== void 0) windows.push({
						key: "week",
						percent: Math.max(0, Math.min(100, 100 - weeklyRemaining)),
						resetsAt: toIso(row.weekly_end_time)
					});
				}
				if (windows.length === 0) return void 0;
				return { windows };
			}
		}
	};
}
const OPENROUTER = {
	ids: ["openrouter"],
	displayName: "OpenRouter",
	balance: {
		build: ({ apiKey }) => ({
			url: "https://openrouter.ai/api/v1/credits",
			headers: bearer(apiKey)
		}),
		parse: (status, body) => {
			if (status !== 200 || typeof body !== "object" || body === null) return void 0;
			const data = body.data;
			if (typeof data !== "object" || data === null) return void 0;
			const credits = toNum(data.total_credits);
			const used = toNum(data.total_usage) ?? 0;
			if (credits === void 0) return void 0;
			return {
				currency: "USD",
				totalBalance: money(credits - used)
			};
		}
	}
};
function siliconFlow(host, ids, currency) {
	return {
		ids,
		displayName: "SiliconFlow",
		balance: {
			build: ({ apiKey }) => ({
				url: `https://${host}/v1/user/info`,
				headers: bearer(apiKey)
			}),
			parse: (status, body) => {
				if (status !== 200 || typeof body !== "object" || body === null) return void 0;
				const data = body.data;
				if (typeof data !== "object" || data === null) return void 0;
				const total = str(data.totalBalance);
				if (total === void 0) return void 0;
				return {
					currency,
					totalBalance: total
				};
			}
		}
	};
}
const ZENMUX = {
	ids: ["zenmux"],
	displayName: "ZenMux",
	balance: {
		build: ({ apiKey }) => ({
			url: "https://zenmux.ai/api/v1/management/payg/balance",
			headers: bearer(apiKey)
		}),
		parse: (status, body) => {
			if (status !== 200 || typeof body !== "object" || body === null) return void 0;
			const data = body.data;
			if (typeof data !== "object" || data === null) return void 0;
			const credits = toNum(data.total_credits);
			if (credits === void 0) return void 0;
			return {
				currency: "USD",
				totalBalance: money(credits)
			};
		}
	}
};
/**
* OpenAI Codex (ChatGPT subscription) quota over the OAuth access token the
* pi-ai grant stores — the one plan adapter whose credential is an OAuth
* token rather than an API key. A 401 here means the stored access token has
* expired; it refreshes when the harness next runs a Codex request, so the
* error line tells the user to use Codex once and refresh.
*/
const OPENAI_CODEX = {
	ids: ["openai-codex"],
	displayName: "Codex (ChatGPT 订阅)",
	plan: {
		build: ({ apiKey, accountId }) => ({
			url: "https://chatgpt.com/backend-api/wham/usage",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"user-agent": "codex-cli",
				accept: "application/json",
				...accountId !== void 0 ? { "chatgpt-account-id": accountId } : {}
			}
		}),
		parse: (status, body) => {
			if (status !== 200 || typeof body !== "object" || body === null) return void 0;
			const rateLimit = body.rate_limit;
			if (typeof rateLimit !== "object" || rateLimit === null) return void 0;
			const windows = [];
			const rows = rateLimit.primary_window !== void 0 || rateLimit.secondary_window !== void 0 ? [rateLimit.primary_window, rateLimit.secondary_window] : [];
			for (const entry of rows) {
				if (typeof entry !== "object" || entry === null) continue;
				const row = entry;
				const percent = toNum(row.used_percent);
				if (percent === void 0) continue;
				const seconds = toNum(row.limit_window_seconds);
				windows.push({
					key: codexWindowKey(seconds),
					percent: Math.max(0, Math.min(100, percent)),
					resetsAt: toIso(row.reset_at)
				});
			}
			if (windows.length === 0) return void 0;
			return { windows };
		}
	}
};
/** Map a Codex window length in seconds onto the shared window key vocabulary. */
function codexWindowKey(seconds) {
	if (seconds === void 0) return "window";
	if (seconds === 18e3) return "5h";
	if (seconds === 604800) return "week";
	if (seconds === 2592e3) return "month";
	const hours = seconds / 3600;
	return hours >= 24 ? `${Math.round(hours / 24)}_day` : `${Math.round(hours)}_hour`;
}
/**
* The adapter registry, in no particular order. Route keys come from the
* pi-ai provider catalog plus the routes this deployment observed in user
* configuration (`zenmux`).
*/
const PROVIDER_ADAPTERS = [
	DEEPSEEK,
	moonshotBalance("api.moonshot.cn", "CNY", ["moonshotai-cn"]),
	moonshotBalance("api.moonshot.ai", "USD", ["moonshotai"]),
	KIMI_CODING,
	glmPlan("open.bigmodel.cn", ["zai-coding-cn"]),
	glmPlan("api.z.ai", ["zai", "zai-coding"]),
	OPENCODE_GO,
	minimaxPlan("api.minimaxi.com", ["minimax-cn"]),
	minimaxPlan("api.minimax.io", ["minimax"]),
	OPENAI_CODEX,
	OPENROUTER,
	siliconFlow("api.siliconflow.cn", ["siliconflow", "siliconflow-cn"], "CNY"),
	siliconFlow("api.siliconflow.com", ["siliconflow-intl"], "USD"),
	ZENMUX
];
/** Find the adapter serving a provider route key, if any. */
function adapterFor(provider) {
	return PROVIDER_ADAPTERS.find((adapter) => adapter.ids.includes(provider));
}
/** Origin of a configured base URL, or undefined when it cannot be parsed. */
function originOf(baseURL) {
	if (baseURL === void 0 || baseURL.trim() === "") return void 0;
	try {
		return new URL(baseURL).origin;
	} catch {
		return;
	}
}
/**
* Whether an adapter's balance endpoint reports THIS route's account.
*
* Some adapter families share one route key across providers that merely
* speak the same API: `deepseek` is both the official DeepSeek catalog entry
* and a common id for an OpenAI-compatible reseller (Alibaba Bailian, ...)
* pointed at another host by the profile's `baseURL`. The balance endpoint is
* per ORIGIN, not per route key, so probing the official endpoint for a
* reseller profile reports the official account's money under the reseller's
* name (issue #1688). An adapter published with a fixed `origin` therefore
* only applies to a route whose configured base URL is that origin, or to a
* route that pins no base URL at all (the catalog alias of the official
* route, which resolves the family's own credential).
*
* @param adapter - the matched adapter.
* @param baseURL - the route's configured base URL (pi-ai profile), if any.
* @returns true when the adapter may probe its balance endpoint for the route.
*/
function balanceAppliesToRoute(adapter, baseURL) {
	const expected = adapter.balance?.origin;
	if (expected === void 0) return true;
	const configured = originOf(baseURL);
	if (configured === void 0) return true;
	return configured === expected;
}
/**
* Whether a provider route belongs to the official DeepSeek family: the only
* family with a spend price book and a settings-section-owned env credential
* (llm-deepseek) rather than a pi-ai profile. Drives the fold-time cost
* stamping, the client fold-time spend estimate, and the whale-yuan bank.
*
* Family membership is wider than the probe directory. The account route
* (deepseek-account) bills the same account but authenticates with the account
* token, so it prices and mints while `adapterFor()` still returns undefined
* for it and no probe or env-credential fallback can reach it. Every caller of
* this predicate is an accounting decision; the credential and probing
* decisions read `adapterFor()` instead, so the two never widen together
* (issue #1772).
*/
function isDeepSeekProviderRoute(provider) {
	if (adapterFor(provider) === DEEPSEEK) return true;
	return DEEPSEEK.familyOnlyIds?.includes(provider) === true;
}
/**
* Best-effort human message from a provider error body, for the per-provider
* error line. Never throws; truncated to one short sentence.
*/
function providerErrorMessage(status, body) {
	let message;
	if (typeof body === "object" && body !== null) {
		const root = body;
		const nested = typeof root.error === "object" && root.error !== null ? root.error : void 0;
		message = str(root.message) ?? str(root.msg) ?? (nested !== void 0 ? str(nested.message) : void 0);
	}
	return `HTTP ${status}${message === void 0 ? "" : `: ${message.slice(0, 120)}`}`;
}
//#endregion
//#region src/core/provider-routes.ts
/**
* Alias folding for the enumerated provider routes. Kept in core because the
* rule is pure — the host enumerates routes and this decides which of two
* routes serving one adapter family survives.
* @module @linxin666/dsh-usage/core/provider-routes
*/
/**
* Drop dormant catalog aliases that shadow a live route of the same adapter
* family. The pi-ai catalog ships route keys the runtime serves nothing on
* until a profile declares them: for DeepSeek the catalog entry `deepseek`
* sits beside the llm-deepseek runtime route `deepseek-official`, and both
* resolve the same credential (the family's `apiKeyEnv` fallback), so probing
* and rendering both turns one account into two identical balance rows.
*
* A family keeps every live route it has — two configured profiles are two
* real accounts, not aliases. A route with no adapter, or one whose family
* has no live route at all, is returned untouched.
*/
function foldAliasRoutes(routes) {
	return routes.filter((route) => {
		if (route.live) return true;
		const family = adapterFor(route.id);
		if (family === void 0) return true;
		return !routes.some((other) => other.live && adapterFor(other.id) === family);
	});
}
//#endregion
//#region src/core/holidays.ts
/**
* Chinese public-holiday dates, Beijing calendar days, as `YYYY-MM-DD`.
*
* The DeepSeek peak rule bills a public holiday off-peak in full, and the
* State Council publishes these dates per year, so they cannot be derived
* from a rule. This module is that data; `pricing.ts` keeps the arithmetic.
*
* Adjusted workdays are deliberately absent: the provider counts the
* calendar day, so an adjusted Saturday or Sunday is off-peak exactly like
* any other weekend and listing it would price it as peak.
*
* Source: the yearly schedules in bastengao/chinese-holidays-node
* (`data/<year>.json`, MIT). Only the `holiday` entries are taken; that
* package's runtime code (which fetches over the network) and its
* dependencies are not vendored.
*
* Coverage ends at the newest year below. A year with no entry is priced as
* if it had no holidays, which is the documented default of
* {@link PublicHolidayCalendar} in `pricing.ts`.
* @module @linxin666/dsh-usage/core/holidays
*/
/** Public-holiday dates keyed by Beijing calendar year. */
const CHINESE_PUBLIC_HOLIDAYS = {
	"2020": [
		"2020-01-24",
		"2020-01-25",
		"2020-01-26",
		"2020-01-27",
		"2020-01-28",
		"2020-01-29",
		"2020-01-30",
		"2020-04-04",
		"2020-04-05",
		"2020-04-06",
		"2020-05-01",
		"2020-05-02",
		"2020-05-03",
		"2020-05-04",
		"2020-05-05",
		"2020-06-25",
		"2020-06-26",
		"2020-06-27",
		"2020-10-01",
		"2020-10-02",
		"2020-10-03",
		"2020-10-04",
		"2020-10-05",
		"2020-10-06",
		"2020-10-07",
		"2020-10-08"
	],
	"2021": [
		"2021-01-01",
		"2021-01-02",
		"2021-01-03",
		"2021-02-11",
		"2021-02-12",
		"2021-02-13",
		"2021-02-14",
		"2021-02-15",
		"2021-02-16",
		"2021-02-17",
		"2021-04-03",
		"2021-04-04",
		"2021-04-05",
		"2021-05-01",
		"2021-05-02",
		"2021-05-03",
		"2021-05-04",
		"2021-05-05",
		"2021-06-12",
		"2021-06-13",
		"2021-06-14",
		"2021-09-19",
		"2021-09-20",
		"2021-09-21",
		"2021-10-01",
		"2021-10-02",
		"2021-10-03",
		"2021-10-04",
		"2021-10-05",
		"2021-10-06",
		"2021-10-07"
	],
	"2022": [
		"2022-01-01",
		"2022-01-02",
		"2022-01-03",
		"2022-01-31",
		"2022-02-01",
		"2022-02-02",
		"2022-02-03",
		"2022-02-04",
		"2022-02-05",
		"2022-02-06",
		"2022-04-03",
		"2022-04-04",
		"2022-04-05",
		"2022-04-30",
		"2022-05-01",
		"2022-05-02",
		"2022-05-03",
		"2022-05-04",
		"2022-06-03",
		"2022-06-04",
		"2022-06-05",
		"2022-09-10",
		"2022-09-11",
		"2022-09-12",
		"2022-10-01",
		"2022-10-02",
		"2022-10-03",
		"2022-10-04",
		"2022-10-05",
		"2022-10-06",
		"2022-10-07"
	],
	"2023": [
		"2022-12-31",
		"2023-01-01",
		"2023-01-02",
		"2023-01-21",
		"2023-01-22",
		"2023-01-23",
		"2023-01-24",
		"2023-01-25",
		"2023-01-26",
		"2023-01-27",
		"2023-04-29",
		"2023-04-30",
		"2023-05-01",
		"2023-05-02",
		"2023-05-03",
		"2023-06-22",
		"2023-06-23",
		"2023-06-24",
		"2023-09-29",
		"2023-09-30",
		"2023-10-01",
		"2023-10-02",
		"2023-10-03",
		"2023-10-04",
		"2023-10-05",
		"2023-10-06"
	],
	"2024": [
		"2023-12-30",
		"2023-12-31",
		"2024-01-01",
		"2024-02-10",
		"2024-02-11",
		"2024-02-12",
		"2024-02-13",
		"2024-02-14",
		"2024-02-15",
		"2024-02-16",
		"2024-02-17",
		"2024-04-04",
		"2024-04-05",
		"2024-04-06",
		"2024-05-01",
		"2024-05-02",
		"2024-05-03",
		"2024-05-04",
		"2024-05-05",
		"2024-06-08",
		"2024-06-09",
		"2024-06-10",
		"2024-09-15",
		"2024-09-16",
		"2024-09-17",
		"2024-10-01",
		"2024-10-02",
		"2024-10-03",
		"2024-10-04",
		"2024-10-05",
		"2024-10-06",
		"2024-10-07"
	],
	"2025": [
		"2025-01-28",
		"2025-01-29",
		"2025-01-30",
		"2025-01-31",
		"2025-02-01",
		"2025-02-02",
		"2025-02-03",
		"2025-02-04",
		"2025-04-04",
		"2025-04-05",
		"2025-04-06",
		"2025-05-01",
		"2025-05-02",
		"2025-05-03",
		"2025-05-04",
		"2025-05-05",
		"2025-05-31",
		"2025-06-01",
		"2025-06-02",
		"2025-10-01",
		"2025-10-02",
		"2025-10-03",
		"2025-10-04",
		"2025-10-05",
		"2025-10-06",
		"2025-10-07",
		"2025-10-08"
	],
	"2026": [
		"2026-01-01",
		"2026-01-02",
		"2026-01-03",
		"2026-02-15",
		"2026-02-16",
		"2026-02-17",
		"2026-02-18",
		"2026-02-19",
		"2026-02-20",
		"2026-02-21",
		"2026-02-22",
		"2026-02-23",
		"2026-04-04",
		"2026-04-05",
		"2026-04-06",
		"2026-05-01",
		"2026-05-02",
		"2026-05-03",
		"2026-05-04",
		"2026-05-05",
		"2026-06-19",
		"2026-06-20",
		"2026-06-21",
		"2026-09-25",
		"2026-09-26",
		"2026-09-27",
		"2026-10-01",
		"2026-10-02",
		"2026-10-03",
		"2026-10-04",
		"2026-10-05",
		"2026-10-06",
		"2026-10-07"
	]
};
//#endregion
//#region src/core/pricing.ts
/** The published peak windows: weekday 09:00-12:00 and 14:00-18:00. */
const PEAK_WINDOWS = [{
	from: 540,
	to: 720
}, {
	from: 840,
	to: 1080
}];
/** Beijing is UTC+8 year-round (no DST), so a fixed shift is exact. */
const BEIJING_UTC_OFFSET_MS = 288e5;
/** deepseek-flash (DeepSeek-V4.1-Flash), including the retired flash-class ids it now serves. */
const FLASH_PRICE = {
	cacheHit: {
		offPeak: .02,
		peak: .04
	},
	inputMiss: {
		offPeak: 1,
		peak: 2
	},
	output: {
		offPeak: 4,
		peak: 8
	}
};
/** deepseek-v4-pro (DeepSeek-V4-Pro-0813); superseded by the flash row at the retirement instant. */
const PRO_PRICE = {
	cacheHit: {
		offPeak: .15,
		peak: .3
	},
	inputMiss: {
		offPeak: 4.5,
		peak: 9
	},
	output: {
		offPeak: 13.5,
		peak: 27
	}
};
/**
* The instant DeepSeek starts serving `deepseek-v4-pro` requests from
* V4.1-Flash and billing the flash row: 2026-09-14 12:00 Beijing (UTC+8).
* Drop the pro row's time fence once V4.1 Pro ships with a published row.
*/
const V4_PRO_FOLDED_INTO_FLASH_AT_MS = Date.UTC(2026, 8, 14, 4, 0);
function withinWindow(minuteOfDay) {
	return PEAK_WINDOWS.find((window) => minuteOfDay >= window.from && minuteOfDay < window.to);
}
/**
* The default calendar: the published Chinese public-holiday table, so a holiday
* weekday prices off-peak instead of over-reporting at the peak rate. A year the
* table does not cover holds no dates and falls back to peak on weekdays, which
* is the safe direction to be wrong in: the estimate reads high rather than low.
*/
const CN_PUBLIC_HOLIDAYS = { isPublicHoliday: (date) => {
	const year = date.slice(0, 4);
	if (Number(year) > 2026) return false;
	return CHINESE_PUBLIC_HOLIDAYS[year]?.includes(date) ?? false;
} };
/** The Beijing-time `YYYY-MM-DD` calendar day of `ms` (UTC+8 has no DST, so the shift is exact). */
function beijingDate(ms) {
	const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS);
	const month = `${shifted.getUTCMonth() + 1}`.padStart(2, "0");
	const day = `${shifted.getUTCDate()}`.padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${month}-${day}`;
}
/**
* Whether `ms` falls on a peak-eligible Beijing day: Monday-Friday that is
* not a public holiday. A Saturday or Sunday is never eligible, including on
* an adjusted workday — the provider counts the calendar day, not the
* working schedule.
*/
function isPeakDay(ms, calendar) {
	const weekday = new Date(ms + BEIJING_UTC_OFFSET_MS).getUTCDay();
	if (weekday < 1 || weekday > 5) return false;
	return !calendar.isPublicHoliday(beijingDate(ms));
}
/**
* The DeepSeek billing period at `ms`, plus when it next flips. The clock is
* Beijing time regardless of the host timezone (UTC+8 has no DST, so a fixed
* shift is exact). `boundaryMs` is the instant the current period ends — the
* window's close while peaking, the next window's open otherwise.
*/
function deepseekPeriodAt(ms, calendar = CN_PUBLIC_HOLIDAYS) {
	const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS);
	const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
	const current = isPeakDay(ms, calendar) ? withinWindow(minuteOfDay) : void 0;
	if (current !== void 0) return {
		peak: true,
		boundaryMs: ms + (current.to - minuteOfDay) * 6e4 - shifted.getUTCSeconds() * 1e3 - shifted.getUTCMilliseconds()
	};
	for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
		const dayStartMs = ms + dayOffset * 864e5;
		if (!isPeakDay(dayStartMs, calendar)) continue;
		const day = new Date(dayStartMs + BEIJING_UTC_OFFSET_MS);
		const realDayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - BEIJING_UTC_OFFSET_MS;
		for (const window of PEAK_WINDOWS) {
			if (dayOffset === 0 && window.from <= minuteOfDay) continue;
			return {
				peak: false,
				boundaryMs: realDayStart + window.from * 6e4
			};
		}
	}
	return {
		peak: false,
		boundaryMs: ms + 864e5
	};
}
/** The price row for a model id at `atMs`; unknown ids take the flash-class row (documented estimate). */
function priceFor(model, atMs) {
	return model.includes("v4-pro") && atMs < V4_PRO_FOLDED_INTO_FLASH_AT_MS ? PRO_PRICE : FLASH_PRICE;
}
/**
* Estimate one call's DeepSeek spend in CNY from its token totals, priced in
* the billing period at `atMs`. Uncatalogued model ids take the flash-class
* row; ids from other providers never reach this function (the service gates
* by route family). Rounded to micro-CNY so the ledger stays readable.
*/
function deepseekModelSpend(model, totals, atMs, calendar = CN_PUBLIC_HOLIDAYS) {
	const price = priceFor(model, atMs);
	const column = deepseekPeriodAt(atMs, calendar).peak ? "peak" : "offPeak";
	const spend = (totals.cacheReadTokens * price.cacheHit[column] + (totals.inputTokens + totals.cacheWriteTokens) * price.inputMiss[column] + totals.outputTokens * price.output[column]) / 1e6;
	return Math.round(spend * 1e6) / 1e6;
}
//#endregion
//#region src/core/types.ts
/** A zeroed totals bucket. */
function emptyTotals() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		calls: 0,
		cost: 0
	};
}
/** Add `right` into `left` in place. */
function addTotals(left, right) {
	left.inputTokens += right.inputTokens;
	left.outputTokens += right.outputTokens;
	left.cacheReadTokens += right.cacheReadTokens;
	left.cacheWriteTokens += right.cacheWriteTokens;
	left.reasoningTokens += right.reasoningTokens;
	left.calls += right.calls;
	left.cost += right.cost;
	return left;
}
//#endregion
//#region src/core/ledger.ts
/**
* The usage ledger: a pure fold from session usage facts into a per-day,
* per-provider, per-model totals document, plus its JSON serialization.
* Host-side state lives only in the document; the service owns persistence.
* @module @linxin666/dsh-usage/core/ledger
*/
/** Local-date key (`YYYY-MM-DD`) for an epoch ms timestamp. */
function localDateKey(ms) {
	const date = new Date(ms);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
/**
* Whether `key` is a real local-date key (`YYYY-MM-DD`). The shape check is
* round-tripped: an impossible date (9999-99-99) parses to NaN and a rollover
* (2026-02-30) lands on another day, so both would otherwise fold into a bogus,
* never-pruned bucket. Shared by the persisted-document reader and the day
* route's query gate.
*/
function isLedgerDateKey(key) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
	const atMs = (/* @__PURE__ */ new Date(key + "T12:00:00")).getTime();
	return Number.isFinite(atMs) && localDateKey(atMs) === key;
}
/** An empty ledger document. */
function createLedgerDocument() {
	return {
		version: 1,
		days: {}
	};
}
/**
* Bucket keys come from untrusted directions (persisted JSON, provider and
* model ids out of session events), so they must never collide with
* `Object.prototype` plumbing: assigning `day['__proto__']` or reading
* `day['constructor']` would pollute every object in the host process.
*/
function isSafeBucketKey(key) {
	return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}
/**
* Fold one usage report into the ledger in place. `provider` is the route key
* and `model` the provider-owned model id the step ran under. Reports keyed
* by prototype-plumbing names are dropped.
*/
function foldUsage(doc, atMs, provider, model, usage) {
	if (!isSafeBucketKey(provider) || !isSafeBucketKey(model)) return;
	if (usage.calls <= 0 && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) return;
	const dayKey = localDateKey(atMs);
	const day = doc.days[dayKey] ?? {};
	const models = day[provider] ?? {};
	const totals = models[model] ?? emptyTotals();
	addTotals(totals, usage);
	models[model] = totals;
	day[provider] = models;
	doc.days[dayKey] = day;
}
/**
* Sum every bucket of `source` into `target`, in place.
*
* Distinct from a re-load of the SAME document: two devices that each ran a
* model on one shared account did both spend those tokens, so their ledgers
* add. `foldUsage` is the primitive because a bucket sum is exactly what it
* does; the day key comes from the stored date, so a peer's timestamps never
* leak into the local clock.
*/
function mergeLedgerSum(target, source) {
	for (const [dayKey, providers] of Object.entries(source.days)) {
		if (!isLedgerDateKey(dayKey)) continue;
		const atMs = (/* @__PURE__ */ new Date(dayKey + "T12:00:00")).getTime();
		if (!Number.isFinite(atMs)) continue;
		for (const [provider, models] of Object.entries(providers)) {
			if (typeof models !== "object" || models === null) continue;
			for (const [model, totals] of Object.entries(models)) {
				if (typeof totals !== "object" || totals === null) continue;
				foldUsage(target, atMs, provider, model, totals);
			}
		}
	}
}
/** Total tokens of a bucket (billed input + output; reasoning is inside output). */
function totalTokens(totals) {
	return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens;
}
/**
* Merge `source` into `target`, keeping the larger value of every field.
*
* The right rule when two processes on ONE machine write the same ledger file:
* both observe a subset of the same calls, so a bucket sum would count the
* calls both of them saw twice, while the larger value is the more complete
* view of that day. (Peer devices are the opposite case — see mergeLedgerSum.)
*
* The merge is per field, not per bucket: choosing one bucket wholesale and
* copying it over the other drops every field `totalTokens` ignores (a bucket
* with cache-read tokens or a cost estimate loses them to a larger-but-poorer
* one). Buckets only ever grow, so the per-field maximum is also monotone.
*/
function mergeLedgerMax(target, source) {
	for (const [dayKey, providers] of Object.entries(source.days)) {
		if (!isLedgerDateKey(dayKey)) continue;
		if (typeof providers !== "object" || providers === null) continue;
		for (const [provider, models] of Object.entries(providers)) {
			if (!isSafeBucketKey(provider) || typeof models !== "object" || models === null) continue;
			for (const [model, totals] of Object.entries(models)) {
				if (!isSafeBucketKey(model) || typeof totals !== "object" || totals === null) continue;
				const bucket = target.days[dayKey]?.[provider]?.[model];
				const day = target.days[dayKey] ?? (target.days[dayKey] = {});
				const route = day[provider] ?? (day[provider] = {});
				route[model] = bucket === void 0 ? { ...totals } : maxTotals(bucket, totals);
			}
		}
	}
}
/**
* `bucket` minus `extra`, floored at zero per field.
*
* Only used by the one-time duplicate-replay repair, where `extra` is a copy
* that was folded twice. `cost` comes back as 0 because the caller reprices
* the shrunken bucket from its tokens — a stored cost cannot be split.
*/
function subtractTotals(bucket, extra) {
	const cut = (value, by) => Math.max(0, value - by);
	return {
		inputTokens: cut(bucket.inputTokens, extra.inputTokens),
		outputTokens: cut(bucket.outputTokens, extra.outputTokens),
		cacheReadTokens: cut(bucket.cacheReadTokens, extra.cacheReadTokens),
		cacheWriteTokens: cut(bucket.cacheWriteTokens, extra.cacheWriteTokens),
		reasoningTokens: cut(bucket.reasoningTokens, extra.reasoningTokens),
		calls: cut(bucket.calls, extra.calls),
		cost: 0
	};
}
/**
* Per-field maximum of two totals.
*
* The floor of a correction: subtracting a duplicate copy may never take a
* bucket below what the deduped replay says that day really billed.
*/
function maxTotals(a, b) {
	const pick = (x, y) => x > y ? x : y;
	return {
		inputTokens: pick(a.inputTokens, b.inputTokens),
		outputTokens: pick(a.outputTokens, b.outputTokens),
		cacheReadTokens: pick(a.cacheReadTokens, b.cacheReadTokens),
		cacheWriteTokens: pick(a.cacheWriteTokens, b.cacheWriteTokens),
		reasoningTokens: pick(a.reasoningTokens, b.reasoningTokens),
		calls: pick(a.calls, b.calls),
		cost: pick(a.cost, b.cost)
	};
}
/**
* Add `current`'s growth since `baseline` onto `target`, per bucket.
*
* The write path of one process that shares its ledger file with another: the
* file already holds what both of them counted up to their last writes, so only
* the calls folded since our own last write may be added. Growth is floored at
* zero, so a bucket that shrank (a repair, a prune) never subtracts from the
* other process's numbers.
*/
function mergeLedgerDelta(target, current, baseline) {
	for (const [dayKey, providers] of Object.entries(current.days)) {
		if (!isLedgerDateKey(dayKey)) continue;
		if (typeof providers !== "object" || providers === null) continue;
		for (const [provider, models] of Object.entries(providers)) {
			if (!isSafeBucketKey(provider) || typeof models !== "object" || models === null) continue;
			for (const [model, totals] of Object.entries(models)) {
				if (!isSafeBucketKey(model) || typeof totals !== "object" || totals === null) continue;
				const base = baseline.days[dayKey]?.[provider]?.[model];
				const grow = (now, then) => Math.max(0, now - then);
				const delta = {
					inputTokens: grow(totals.inputTokens, base?.inputTokens ?? 0),
					outputTokens: grow(totals.outputTokens, base?.outputTokens ?? 0),
					cacheReadTokens: grow(totals.cacheReadTokens, base?.cacheReadTokens ?? 0),
					cacheWriteTokens: grow(totals.cacheWriteTokens, base?.cacheWriteTokens ?? 0),
					reasoningTokens: grow(totals.reasoningTokens, base?.reasoningTokens ?? 0),
					calls: grow(totals.calls, base?.calls ?? 0),
					cost: grow(totals.cost, base?.cost ?? 0)
				};
				if (delta.calls === 0 && totalTokens(delta) === 0 && delta.cost === 0) continue;
				const atMs = (/* @__PURE__ */ new Date(dayKey + "T12:00:00")).getTime();
				if (!Number.isFinite(atMs)) continue;
				foldUsage(target, atMs, provider, model, delta);
			}
		}
	}
}
/**
* Aggregate whole per-day maps (each `provider -> model -> totals`) into the
* per-provider/per-model summary the overview serves for one day or a range:
* disjoint bucket sums per provider, per-model rows heaviest first, and the
* grand total. Pure: reads its inputs, allocates fresh buckets.
*/
function summarizeDays(days) {
	const merged = /* @__PURE__ */ new Map();
	for (const day of days) for (const [provider, models] of Object.entries(day)) {
		if (!isSafeBucketKey(provider) || typeof models !== "object" || models === null) continue;
		let modelMap = merged.get(provider);
		if (modelMap === void 0) {
			modelMap = /* @__PURE__ */ new Map();
			merged.set(provider, modelMap);
		}
		for (const [model, totals] of Object.entries(models)) {
			if (typeof totals !== "object" || totals === null) continue;
			const bucket = modelMap.get(model) ?? emptyTotals();
			addTotals(bucket, totals);
			modelMap.set(model, bucket);
		}
	}
	const providers = [];
	const totals = emptyTotals();
	for (const [provider, modelMap] of merged) {
		const providerTotals = emptyTotals();
		const modelRows = [...modelMap].map(([model, modelTotals]) => ({
			model,
			totals: modelTotals
		}));
		for (const row of modelRows) addTotals(providerTotals, row.totals);
		modelRows.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
		providers.push({
			provider,
			totals: providerTotals,
			models: modelRows.slice(0, 12)
		});
	}
	providers.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
	for (const row of providers) addTotals(totals, row.totals);
	return {
		totals,
		providers
	};
}
/** All local-date keys in the ledger, ascending. */
function ledgerDayKeys(doc) {
	return Object.keys(doc.days).sort();
}
/** Local-date key of the oldest day `retainDays` keeps. */
function pruneCutoffKey(todayKey, retainDays) {
	const cutoff = /* @__PURE__ */ new Date(todayKey + "T00:00:00");
	cutoff.setDate(cutoff.getDate() - Math.max(0, retainDays - 1));
	return localDateKey(cutoff.getTime());
}
/**
* How many recorded days a prune with these settings would delete.
*
* Split out from `pruneLedger` so a caller can refuse a suspicious prune before
* it happens: a forward clock jump makes every recorded day look ancient, and
* deleting them would destroy the history the plugin exists to keep.
*/
function countPrunable(doc, todayKey, retainDays) {
	const cutoffKey = pruneCutoffKey(todayKey, retainDays);
	let count = 0;
	for (const key of Object.keys(doc.days)) if (key < cutoffKey) count += 1;
	return count;
}
/**
* Drop every day older than `retainDays` local days before `todayKey`, in
* place. Returns the number of pruned days.
*/
function pruneLedger(doc, todayKey, retainDays) {
	const cutoffKey = pruneCutoffKey(todayKey, retainDays);
	let pruned = 0;
	for (const key of Object.keys(doc.days)) if (key < cutoffKey) {
		delete doc.days[key];
		pruned += 1;
	}
	return pruned;
}
function reviveTotals(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const source = value;
	const num = (key) => typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] : 0;
	return {
		inputTokens: num("inputTokens"),
		outputTokens: num("outputTokens"),
		cacheReadTokens: num("cacheReadTokens"),
		cacheWriteTokens: num("cacheWriteTokens"),
		reasoningTokens: num("reasoningTokens"),
		calls: num("calls"),
		cost: num("cost")
	};
}
/**
* Parse a ledger document from untrusted JSON: unknown shapes resolve to an
* empty document, malformed entries are dropped, numbers are coerced to
* finite values. Never throws.
*/
function deserializeLedger(value) {
	const doc = createLedgerDocument();
	if (typeof value !== "object" || value === null) return doc;
	const days = value.days;
	if (typeof days !== "object" || days === null) return doc;
	for (const [dateKey, providers] of Object.entries(days)) {
		if (!isLedgerDateKey(dateKey) || typeof providers !== "object" || providers === null) continue;
		const atMs = (/* @__PURE__ */ new Date(dateKey + "T12:00:00")).getTime();
		for (const [provider, models] of Object.entries(providers)) {
			if (typeof models !== "object" || models === null) continue;
			for (const [model, totals] of Object.entries(models)) {
				const revived = reviveTotals(totals);
				if (revived !== void 0) foldUsage(doc, atMs, provider, model, revived);
			}
		}
	}
	return doc;
}
//#endregion
//#region src/host/device-ledger.ts
/**
* Per-device ledger files: the storage shape that makes multi-device totals
* additive without ever overwriting another machine's history.
*
* Why one file per device
* -----------------------
* A backup/restore round trip has to answer "whose numbers win?" and every
* answer loses something:
*  - overwrite: the restoring device's own usage disappears;
*  - sum: importing the same file twice double-counts;
*  - max: two devices on one account undercount.
*
* So there is no merge policy here at all: each device only ever writes ITS
* OWN file (`usage-ledger.<deviceId>.json`), and the overview sums whatever
* files are present. Peer files are read, never written, so syncing the same
* file twice is idempotent by construction — the totals depend on the set of
* files, not on how many times one arrived.
*
* Import is the same statement from the other side: installing a peer's
* document REPLACES that peer's file (keyed by the device id inside it), so a
* re-import converges instead of accumulating.
* @module @linxin666/dsh-usage/host/device-ledger
*/
/** Prefix shared by every ledger file in the persist directory. */
const LEDGER_FILE_PREFIX = "usage-ledger.";
/** The pre-device-split single file; migrated into the local device file. */
const LEGACY_LEDGER_FILE = "usage-ledger.json";
/** Suffix all ledger files carry. */
const LEDGER_FILE_SUFFIX = ".json";
/** A device id must survive being used as a filename on every platform. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
/**
* Whether a string is a usable device id. Rejects path separators, dot-only
* names, leading/trailing punctuation, and anything over 64 characters — an
* id arrives from an imported file, so it is untrusted input that becomes a
* filename.
*
* A dot is rejected outright: every id this plugin mints is a host slug plus a
* hex digest, so a dotted name is never one of ours — it is a copy sitting next
* to the real file (`usage-ledger.<id>.bak.json`). Reading those as devices is
* how one machine's history gets summed twice.
*/
function isDeviceId(value) {
	if (!DEVICE_ID_PATTERN.test(value)) return false;
	if (value.includes(".")) return false;
	return value !== "." && value !== "..";
}
/**
* Stable, filesystem-safe id for this machine.
*
* Deterministic rather than random: two runs (and a fresh install) must agree,
* or every restart would start a new ledger file. The hash covers host name,
* platform, and home directory so two machines sharing a default host name
* (`DESKTOP-XXXX`) still differ.
*/
function localDeviceId() {
	return `${machineSlug()}-${machineDigest().slice(0, 6)}`;
}
/**
* Full digest of this machine's identity, derived from host, platform and user.
*
* Only a fallback: the authoritative machine id is the random one this plugin
* persists (`ensureMachineId`), because a digest that follows the host name
* changes when the machine is renamed — and then the file written under the old
* name looks like a peer holding a copy of this machine's own history.
*/
function localMachineId() {
	return machineDigest();
}
/** Name of the file that pins this machine's identity inside the persist dir. */
const MACHINE_ID_FILE = "machine-id.json";
/**
* The machine id this profile has already minted, creating one on first run.
*
* Random rather than derived, and written once: it has to survive a host rename,
* a user rename, and a reinstall of the plugin, because it is what tells "this
* machine, renamed" apart from "a second machine". A digest of the host name
* cannot do that — it changes exactly when the rename happens.
*/
async function ensureMachineId(dir) {
	const path = join(dir, MACHINE_ID_FILE);
	const read = async () => {
		try {
			const id = JSON.parse(await readFile(path, "utf8"))?.machineId;
			return typeof id === "string" && MACHINE_ID_PATTERN.test(id) ? id : void 0;
		} catch {
			return;
		}
	};
	const known = await read();
	if (known !== void 0) return known;
	const minted = randomUUID().replace(/-/g, "");
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(path, machineIdBody(minted, []), {
			encoding: "utf8",
			flag: "wx"
		});
	} catch (error) {
		let settled = await read();
		for (let attempt = 0; settled === void 0 && attempt < 20; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			settled = await read();
		}
		if (settled !== void 0) return settled;
		if (error.code !== "EEXIST") return localMachineId();
		const salvage = (await readRawIds(path)).filter((id) => id !== minted);
		try {
			await writeFile(path, machineIdBody(minted, salvage), "utf8");
			return minted;
		} catch {
			return localMachineId();
		}
	}
	return minted;
}
/** The pinned-id file body: the live id plus every id this profile used before. */
function machineIdBody(machineId, previous) {
	return `${JSON.stringify({
		version: 2,
		machineId,
		previous
	}, null, 2)}\n`;
}
/** Every id-shaped string in a file we failed to parse, newest first. */
async function readRawIds(path) {
	try {
		const found = (await readFile(path, "utf8")).match(/[0-9a-f]{32}/g) ?? [];
		return [...new Set(found)];
	} catch {
		return [];
	}
}
/**
* Ids this profile has used before.
*
* A re-minted pin (a lost `machine-id.json`, a moved profile, an upgrade from a
* build that never pinned one) leaves older files stamped with the old id. Those
* files are this machine's own history, so they have to be folded in rather than
* summed as a second device — the difference is a permanently doubled total.
*/
async function readMachineAliases(dir) {
	try {
		const list = JSON.parse(await readFile(join(dir, MACHINE_ID_FILE), "utf8"))?.previous;
		if (!Array.isArray(list)) return [];
		return list.filter((id) => typeof id === "string" && MACHINE_ID_PATTERN.test(id));
	} catch {
		return [];
	}
}
/** How many earlier ids the pin file keeps: a handful of renames, not a log. */
const MACHINE_ALIAS_MAX = 16;
/**
* Record `id` as an id this profile has written under before.
*
* `readMachineAliases` can only know what the pin file says, and a fresh mint
* writes `previous: []` — so the durable list was always empty in practice and the
* only working alias source was the local ledger's own `machine` stamp, which the
* first flush overwrites with the new pin. Losing the pin while an older file under
* the previous id still exists would then turn that file into a phantom peer whose
* days are summed on top of the replay. This is where the outgoing id is carried
* over, before the flush can replace it.
*/
async function rememberMachineAlias(dir, id) {
	if (!MACHINE_ID_PATTERN.test(id)) return;
	const path = join(dir, MACHINE_ID_FILE);
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
	const body = parsed;
	const current = body?.machineId;
	if (typeof current !== "string" || !MACHINE_ID_PATTERN.test(current) || current === id) return;
	const previous = Array.isArray(body?.previous) ? body.previous.filter((entry) => typeof entry === "string" && MACHINE_ID_PATTERN.test(entry)) : [];
	if (previous.includes(id)) return;
	const next = [id, ...previous.filter((entry) => entry !== current)].slice(0, MACHINE_ALIAS_MAX);
	await writeFile(path, machineIdBody(current, next), "utf8").catch(() => void 0);
}
/** 32 lowercase hex characters: what `ensureMachineId` mints and accepts. */
const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/;
/** The slug half of the device id (host name, made filename-safe). */
function machineSlug() {
	return readHost().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "dsh";
}
/** sha256 over host, platform and user — the whole identity, not a truncation. */
function machineDigest() {
	return createHash("sha256").update(`${readHost()}\u0000${platform()}\u0000${readUser()}`).digest("hex");
}
function readHost() {
	try {
		return hostname();
	} catch {
		return "dsh";
	}
}
function readUser() {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}
/** File name a device's ledger lives under. */
function ledgerFileName(deviceId) {
	return `${LEDGER_FILE_PREFIX}${deviceId}${LEDGER_FILE_SUFFIX}`;
}
/**
* Device id encoded in a ledger file name, or undefined for any other entry
* (`usage-ledger.json` included — that legacy file is handled separately, and
* an unrelated `usage-ledger.json.bak` must not be read as a device).
*/
function deviceIdOfFile(name) {
	if (!name.startsWith("usage-ledger.") || !name.endsWith(LEDGER_FILE_SUFFIX)) return void 0;
	const id = name.slice(13, name.length - 5);
	return isDeviceId(id) ? id : void 0;
}
/**
* The document as it is written to disk: the ledger plus the identity of the
* machine that wrote it.
*
* `days` stays at the top level on purpose. An older build reads a document
* whose `days` is missing as an empty ledger, so nesting the payload (the
* `/export` envelope does exactly that) would let a downgrade overwrite the
* history with nothing. `repairedAt` marks the last correction, so a process
* that loaded before the correction cannot raise a bucket a newer write
* lowered. `retentionDays` records which window the writer pruned to: without
* it a restart cannot tell "the user lowered retention while we were down" from
* "the clock jumped", and it refuses the prune forever.
*/
function ledgerFileDocument(doc, extra) {
	return {
		...doc,
		deviceId: localDeviceId(),
		machine: extra?.machine ?? localMachineId(),
		...extra?.repairedAt !== void 0 ? { repairedAt: extra.repairedAt } : {},
		...extra?.retentionDays !== void 0 ? { retentionDays: extra.retentionDays } : {}
	};
}
/**
* Parse one peer ledger document from untrusted JSON.
*
* Accepts both the bare document (`{ version, days }`) and the export envelope
* (`{ deviceId, ledger }`) so a hand-copied file works either way. Returns
* `undefined` for anything unparseable — a corrupt peer file must degrade to
* "that device is missing", never to a broken overview.
*/
function parsePeerLedger(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	const machine = typeof record.machine === "string" && record.machine !== "" ? record.machine : void 0;
	const retentionDays = typeof record.retentionDays === "number" && Number.isFinite(record.retentionDays) ? record.retentionDays : void 0;
	if (typeof record.deviceId === "string") {
		if (!isDeviceId(record.deviceId)) return void 0;
		const payload = hasDayMap(record.ledger) ? record.ledger : hasDayMap(value) ? value : void 0;
		if (payload === void 0) return void 0;
		return {
			deviceId: record.deviceId,
			machine,
			doc: deserializeLedger(payload),
			retentionDays
		};
	}
	if (hasDayMap(value)) return {
		deviceId: "",
		machine,
		doc: deserializeLedger(value),
		retentionDays
	};
}
/** Whether `value` is a document-shaped payload with a `days` object. */
function hasDayMap(value) {
	if (typeof value !== "object" || value === null) return false;
	const days = value.days;
	return typeof days === "object" && days !== null && Array.isArray(days) === false;
}
//#endregion
//#region src/host/session-log-backfill.ts
/**
* Recover billed model calls from the session transcripts.
*
* `session/event` only delivers records appended while a usage-service instance
* is mounted, so every call made before the first mount — and every call made
* during a remount window — never reaches the live fold. The transcripts under
* `<dshHome>/sessions/<workspace>/<session>/session.v4.jsonl.zstd` keep the
* complete record instead: one `assistant/message` event per billed model call,
* each carrying its own `usage` and `message.source` route. Replaying them
* yields a day/provider/model document that is merged back into the ledger.
*
* A transcript is a concatenation of independent zstd frames (one per append
* batch) and `zstdDecompressSync` decodes only the leading frame, so the frame
* walk below is required, not defensive. A seeded subagent's transcript opens
* with a verbatim copy of its parent's messages, so one pass dedupes the whole
* run by message id before folding.
* @module @linxin666/dsh-usage/host/session-log-backfill
*/
/** zstd frame magic number, little-endian. */
const ZSTD_MAGIC_BYTES = Buffer.from([
	40,
	181,
	47,
	253
]);
/** Frame-content-size field width in bytes, indexed by its 2-bit flag. */
const ZSTD_FCS_BYTES = [
	0,
	2,
	4,
	8
];
/** Dictionary-id field width in bytes, indexed by its 2-bit flag. */
const ZSTD_DICT_ID_BYTES = [
	0,
	1,
	2,
	4
];
/** Transcript file name; the version segment is accepted forward-compatibly. */
const SESSION_LOG_PATTERN = /^session\.[^/\\]+\.jsonl\.zstd$/;
/** A transcript larger than this is skipped: a runaway log must not stall startup. */
const SESSION_LOG_MAX_BYTES = 268435456;
/** The backfill replays at most this many transcripts per start. */
const SESSION_LOG_MAX_FILES = 2048;
/**
* Offset just past the zstd frame that starts at `start`, or -1 when the frame
* header or any of its blocks runs past the end of `buf`.
*/
function zstdFrameEnd(buf, start) {
	let pos = start + 4;
	if (pos >= buf.length) return -1;
	const descriptor = buf[pos];
	pos += 1;
	const fcsFlag = descriptor >> 6;
	const singleSegment = descriptor >> 5 & 1;
	const checksum = descriptor >> 2 & 1;
	const dictIdFlag = descriptor & 3;
	if (singleSegment === 0) pos += 1;
	pos += ZSTD_DICT_ID_BYTES[dictIdFlag];
	pos += fcsFlag === 0 ? singleSegment === 1 ? 1 : 0 : ZSTD_FCS_BYTES[fcsFlag];
	while (pos + 3 <= buf.length) {
		const header = buf[pos] | buf[pos + 1] << 8 | buf[pos + 2] << 16;
		const last = header & 1;
		const type = header >> 1 & 3;
		pos += 3;
		pos += type === 1 ? 1 : header >>> 3;
		if (pos > buf.length) return -1;
		if (last === 1) {
			if (checksum === 1) pos += 4;
			return pos > buf.length ? -1 : pos;
		}
	}
	return -1;
}
/**
* Decode every zstd frame in `buf` into one UTF-8 string. A truncated tail costs
* only the newest records, which the live fold owns anyway, so failed frames are
* skipped rather than failing the transcript.
*/
function zstdDecodeAll(buf) {
	const chunks = [];
	let pos = 0;
	while (pos + 4 <= buf.length) {
		if (buf.indexOf(ZSTD_MAGIC_BYTES, pos) !== pos) {
			const next = buf.indexOf(ZSTD_MAGIC_BYTES, pos + 1);
			if (next === -1) break;
			pos = next;
		}
		const end = zstdFrameEnd(buf, pos);
		if (end === -1) break;
		try {
			chunks.push(zstdDecompressSync(buf.subarray(pos, end)));
		} catch {}
		pos = end;
	}
	return chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
}
/** Normalize an untrusted transcript `usage` object into ledger totals for one call. */
function transcriptTotals(usage) {
	const read = (key) => {
		const value = usage[key];
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
	};
	return {
		inputTokens: read("inputTokens"),
		outputTokens: read("outputTokens"),
		cacheReadTokens: read("cacheReadTokens"),
		cacheWriteTokens: read("cacheWriteTokens"),
		reasoningTokens: read("reasoningTokens"),
		calls: 1,
		cost: 0
	};
}
/**
* Fold every billed model call in one decoded transcript into `doc`. Records
* without a provider route are skipped: the live fold cannot attribute them
* either, and inventing a bucket would only distort the totals.
*
* A seeded subagent's transcript opens with a verbatim copy of its parent's
* assistant messages (same message id, time and usage), so a replay that folds
* every file double-counts them. `seen` carries the message ids of the whole
* run: the first copy folds, later ones are reported to `onDuplicate` and
* dropped. Pass the same set for every transcript of one pass.
*/
function foldTranscript(text, doc, seen, onDuplicate) {
	/** Keys already met inside this file, so a no-id record still folds once. */
	const local = /* @__PURE__ */ new Set();
	for (const line of text.split("\n")) {
		if (line === "" || line[0] !== "{") continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const rec = record;
		if (rec?.type !== "assistant/message") continue;
		const usage = rec.data?.usage;
		if (typeof usage !== "object" || usage === null) continue;
		const source = rec.data?.message?.source;
		if (typeof source?.provider !== "string" || source.provider === "") continue;
		const model = typeof source.model === "string" && source.model !== "" ? source.model : "unknown";
		const atMs = typeof rec.time === "number" && Number.isFinite(rec.time) ? rec.time : Date.now();
		const totals = transcriptTotals(usage);
		const id = rec.data?.message?.id;
		if (seen !== void 0) {
			const key = typeof id === "string" && id !== "" ? source.provider + "\0" + model + "\0" + id : "c\0" + [
				source.provider,
				model,
				String(atMs),
				String(totals.inputTokens),
				String(totals.outputTokens),
				String(totals.cacheReadTokens),
				String(totals.cacheWriteTokens)
			].join("\0");
			const fromThisFile = local.has(key);
			if (seen.has(key) && (typeof id === "string" && id !== "" || !fromThisFile)) {
				onDuplicate?.(localDateKey(atMs), source.provider, model, totals);
				continue;
			}
			seen.add(key);
			local.add(key);
		}
		foldUsage(doc, atMs, source.provider, model, totals);
	}
}
/** Every transcript path under `<dshHome>/sessions`, two directory levels deep. */
async function discoverSessionLogs(root) {
	const files = [];
	let workspaces;
	try {
		workspaces = await readdir(root, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const workspace of workspaces) {
		if (workspace.isDirectory() !== true) continue;
		let sessions;
		try {
			sessions = await readdir(join(root, workspace.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (session.isDirectory() !== true) continue;
			const dir = join(root, workspace.name, session.name);
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) if (entry.isFile() === true && SESSION_LOG_PATTERN.test(entry.name)) files.push(join(dir, entry.name));
		}
	}
	return files;
}
/**
* Every transcript path under `<dshHome>/sessions`, newest first.
*
* The order matters when the per-start cap bites: the transcripts that are
* dropped are the oldest ones, whose calls the live fold and the earlier days
* of the ledger already hold, not the session the user is working in right now.
*/
async function listSessionLogs(root) {
	const discovered = await discoverSessionLogs(root);
	const stamped = await Promise.all(discovered.map(async (path) => ({
		path,
		mtime: await stat(path).then((info) => info.mtimeMs, () => 0)
	})));
	stamped.sort((a, b) => b.mtime - a.mtime);
	return stamped.map((entry) => entry.path);
}
/**
* Replay the session transcripts into a fresh ledger-shaped document and hand it
* to `merge`. Returns how many transcripts were found and how many actually
* contributed, how many records were dropped as copies of a call another
* transcript already carried, and how many transcripts the per-start cap left
* out (so a truncated replay is never mistaken for a complete one).
*/
async function collectSessionLogUsage(root, merge, onDuplicate) {
	const discovered = await listSessionLogs(root);
	const files = discovered.slice(0, SESSION_LOG_MAX_FILES);
	const doc = createLedgerDocument();
	const seen = /* @__PURE__ */ new Set();
	let replayed = 0;
	let duplicates = 0;
	const reportDuplicate = (dayKey, provider, model, totals) => {
		duplicates += 1;
		onDuplicate?.(dayKey, provider, model, totals);
	};
	for (const file of files) try {
		const info = await stat(file);
		if (!info.isFile() || info.size <= 0 || info.size > SESSION_LOG_MAX_BYTES) continue;
		const text = zstdDecodeAll(await readFile(file));
		if (text === "") continue;
		foldTranscript(text, doc, seen, reportDuplicate);
		replayed += 1;
	} catch {}
	merge(doc);
	return {
		files: discovered.length,
		replayed,
		duplicates,
		skipped: discovered.length - files.length
	};
}
//#endregion
//#region src/host/usage-service.ts
/**
* The dsh-usage host service: folds live session usage into the persistent
* ledger, probes each configured provider's balance/coding-plan endpoint on
* a poll cycle, and serves the current provider's strip-ready view inside
* the overview document. Secrets stay in the host process; the browser only
* ever sees the overview document.
* @module @linxin666/dsh-usage/host/usage-service
*/
/**
* The bucket for one route inside one day, matched loosely.
*
* Provider and model spellings arrive from two places that do not agree: the
* transcript records and the persisted ledger. An exact lookup misses a bucket
* whose name drifted (`WorkBuddy` vs `workbuddy`), and the repair would then
* skip it while the replay adds a second bucket beside it — one day, two rows,
* and the copies stay counted.
*/
function findLedgerBucket(day, provider, model) {
	if (day === void 0) return void 0;
	const exact = day[provider]?.[model];
	if (exact !== void 0) return {
		provider,
		model,
		totals: exact
	};
	const wantProvider = provider.trim().toLowerCase();
	const wantModel = model.trim().toLowerCase();
	for (const [name, models] of Object.entries(day)) {
		if (name.trim().toLowerCase() !== wantProvider) continue;
		for (const [label, totals] of Object.entries(models)) if (label.trim().toLowerCase() === wantModel) return {
			provider: name,
			model: label,
			totals
		};
	}
}
/**
* Marker key for one bucket: the day, the route and the model it belongs to.
*
* The route id and the model name reach this file from two places — the ledger
* carries the spelling the client wrote, the replay carries the transcript's — and
* they differ in case often enough that the floor filed under one spelling was
* invisible to the next start. The guard then degraded from "this bucket is still
* at the repaired total" to "exactly one copy above the clean total", which is the
* case it exists to catch.
*/
function repairKey(dayKey, provider, model) {
	return `${dayKey}\u0000${provider.trim().toLowerCase()}\u0000${model.trim().toLowerCase()}`;
}
/**
* The device a ledger document claims to belong to, when that device is not
* this machine.
*
* A document naming another device is not a corrupt local ledger: it is that
* device's export, or a copy of its file, put down on the local path by a
* restore. Quarantining it as `.corrupt-` would look exactly like lost history,
* so the caller adopts it under its own device's file name instead — where the
* peer scan already knows how to count it, once.
*/
function foreignDeviceOf(error) {
	const match = /^names device (.+)$/.exec(error);
	if (match === null) return void 0;
	const claimed = match[1].trim();
	if (!isDeviceId(claimed)) return void 0;
	return claimed === localDeviceId() ? void 0 : claimed;
}
/** Probe timeout per HTTP call. */
const PROBE_TIMEOUT_MS = 1e4;
/** Ledger flush debounce. */
const FLUSH_DEBOUNCE_MS = 3e3;
/**
* Sidecar marker for the one-time duplicate-replay repair. Its presence means
* the correction ran on this machine; the repair subtracts exactly the extra
* copies, so running it twice would take real calls away.
*/
const DEDUPE_MARKER_FILE = "usage-dedupe-marker.json";
/** How long a failed ledger read waits before trying again. */
const LOAD_RETRY_MS = 2e4;
/** How many times a failed ledger read is retried before the boot gives up on persisting. */
const LOAD_RETRY_MAX = 5;
/** How many times a flush tries to take the ledger lock before writing anyway. */
const LOCK_ATTEMPTS = 12;
/** How long one flush waits between lock attempts. */
const LOCK_RETRY_MS = 25;
/**
* Age after which a lock file is assumed to be left behind by a crash.
*
* A flush takes milliseconds, so a second is far too short to tell a crashed
* holder from a live one: measured on Windows a second process could delete the
* lock while the first was still inside the critical section. Fifteen seconds
* is longer than any write, and a crash still clears after that.
*/
const LOCK_STALE_MS = 15e3;
/** How many distinct note kinds the panel's line keeps in memory. */
const NOTE_MAX = 24;
/** `schema` tag carried by an export envelope, so an import can tell it apart from a bare ledger. */
const LEDGER_EXPORT_SCHEMA = "dsh-usage-ledger";
/** Largest import body accepted; a ledger of one device's history stays far below this. */
const IMPORT_MAX_BYTES$1 = 8388608;
/**
* A rejected import, distinguished from an I/O failure so the route can answer
* 400 for "that file is not a ledger" and 500 for "the disk refused".
*/
var UsageImportError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageImportError";
	}
};
/** Best-effort typed service read: absent services resolve to undefined at runtime. */
function service(ctx, name) {
	try {
		return ctx.get(name);
	} catch {
		return;
	}
}
/**
* Read a totals-shaped value back from JSON, or undefined when it is not one.
*
* Used for the repair marker, which is written by this code but must never be
* trusted blindly: a hand-edited or truncated marker would otherwise seed the
* repair's floor with garbage and skew the subtraction.
*/
function readTotals(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	const num = (key) => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : 0;
	return {
		inputTokens: num("inputTokens"),
		outputTokens: num("outputTokens"),
		cacheReadTokens: num("cacheReadTokens"),
		cacheWriteTokens: num("cacheWriteTokens"),
		reasoningTokens: num("reasoningTokens"),
		calls: num("calls"),
		cost: num("cost")
	};
}
/**
* Read the persisted spend watch back, or undefined when it is not usable.
*
* Strict on purpose: the watch is an accrual the user reads as real money, so a
* damaged value is dropped rather than half-trusted.
*/
function readSpendWatch(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const watch = value;
	if (typeof watch.accruedCny !== "number" || !Number.isFinite(watch.accruedCny) || watch.accruedCny < 0) return void 0;
	if (typeof watch.since !== "number" || !Number.isFinite(watch.since) || watch.since <= 0) return void 0;
	return {
		accruedCny: watch.accruedCny,
		since: watch.since,
		...typeof watch.lastBalanceCny === "number" && Number.isFinite(watch.lastBalanceCny) ? { lastBalanceCny: watch.lastBalanceCny } : {}
	};
}
/**
* Atomic JSON write through a unique temp file + fsync + rename. The temp
* name carries a per-call sequence number as well as pid and clock: two writes
* in the same millisecond would otherwise share a temp path and interleave into
* one file, which is exactly the corruption the rename is meant to prevent.
*/
let writeSequence = 0;
async function writeJsonAtomic(path, value) {
	writeSequence += 1;
	const temp = `${path}.${process.pid}.${Date.now()}.${writeSequence}.tmp`;
	try {
		const handle = await open(temp, "w");
		try {
			await handle.writeFile(JSON.stringify(value, null, 1), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}
function unwrapVolatiles(value) {
	if (value === null || value === void 0) return value;
	if (typeof value === "object") {
		if (typeof value.get === "function") return unwrapVolatiles(value.get());
		if (Array.isArray(value)) return value.map(unwrapVolatiles);
		const result = {};
		for (const [k, v] of Object.entries(value)) result[k] = unwrapVolatiles(v);
		return result;
	}
	return value;
}
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepMerge(base, patch) {
	if (!isPlainObject(base) || !isPlainObject(patch)) return patch !== void 0 ? patch : base;
	const result = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === void 0) continue;
		result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value;
	}
	return result;
}
/**
* Read a foreign settings namespace's resolved value (the llm adapter
* profiles, the agent default model). Resolves across pre-0.1.7 settings.get(),
* 0.1.7 SettingsForms.describe(), live loader entries, and configEditor.
* Unregistered namespaces read as undefined; nothing here throws into the poll loop.
*/
function readNamespace(ctx, ns) {
	try {
		const settings = service(ctx, "settings");
		if (settings !== void 0) {
			if (typeof settings.get === "function") {
				const value = settings.get(ns);
				if (value !== void 0) return unwrapVolatiles(value);
			}
			if (typeof settings.describe === "function") {
				const descriptors = settings.describe({ redactSecrets: false });
				if (Array.isArray(descriptors)) {
					const match = descriptors.find((d) => d.ns === ns || ns === "llm-pi-ai" && (d.ns === "llm" || isPlainObject(d.value?.providers)) || ns === "llm-deepseek" && (d.ns === "llm-deepseek" || d.ns === "llm-deepseek-api-key"));
					if (match !== void 0 && match.value !== void 0) return unwrapVolatiles(match.value);
				}
			}
		}
		const loader = ctx.root?.loader ?? ctx.loader;
		if (loader !== void 0 && typeof loader.entries === "function") for (const entry of loader.entries()) {
			const id = entry.options?.id;
			const name = entry.options?.name;
			if (id === ns || name === `@deepseek-ai/dsh-${ns}` || name?.endsWith(`/${ns}`) || ns === "llm-pi-ai" && (id === "llm" || name === "@deepseek-ai/dsh-llm-pi-ai") || ns === "llm-deepseek" && (id === "llm-deepseek-api-key" || name === "@deepseek-ai/dsh-llm-deepseek-api-key")) {
				if (entry.fiber?.config !== void 0) return unwrapVolatiles(entry.fiber.config);
			}
		}
		const editor = service(ctx, "configEditor");
		if (editor !== void 0 && typeof editor.configuration === "function") {
			const match = editor.configuration().find((r) => {
				const id = r.entry.options.id;
				const name = r.entry.options.name;
				return id === ns || name === `@deepseek-ai/dsh-${ns}` || name?.endsWith(`/${ns}`) || ns === "llm-pi-ai" && (id === "llm" || name === "@deepseek-ai/dsh-llm-pi-ai") || ns === "llm-deepseek" && (id === "llm-deepseek-api-key" || name === "@deepseek-ai/dsh-llm-deepseek-api-key");
			});
			if (match !== void 0) {
				if (match.entry.fiber?.config !== void 0) return unwrapVolatiles(match.entry.fiber.config);
				return unwrapVolatiles(deepMerge(match.inherited, match.override));
			}
		}
	} catch {
		return;
	}
}
var UsageService = class {
	ctx;
	options;
	persistDir;
	/**
	* This machine's own ledger file. Every write goes here and nowhere else —
	* see device-ledger.ts for why there is no "import overwrites" path.
	*/
	ledgerPath;
	snapshotsPath;
	/** This machine's stable id; peers are keyed by theirs. */
	deviceId;
	/**
	* Peer ledgers, keyed by device id. Read-only: refreshed on load, on flush,
	* and on demand from the panel. They are summed into the served view but
	* never written back to disk.
	*/
	peers = [];
	/** Last peer scan failure, surfaced in the overview so a silent empty merge is visible. */
	peersError;
	/**
	* Last ledger load failure, surfaced in the overview. A file that could not be
	* read is never overwritten, so this is the only trace of why the totals are
	* empty this boot.
	*/
	ledgerError;
	/**
	* A condition the user should know about that is not an error: a replay cut
	* short by the per-start cap, or a file that turned out to belong to another
	* device. Shown next to `ledgerError`, because a silently shortened history
	* reads exactly like a complete one.
	*
	* Keyed by kind, so a condition that repeats every flush states itself once
	* instead of growing a sentence longer on every write.
	*/
	notes = /* @__PURE__ */ new Map();
	/** The document as it was before the first load absorb, so a retry starts clean. */
	loadBaseline;
	/** True once the persisted document has been folded into memory this boot. */
	loadAbsorbed = false;
	/**
	* The smallest retention this process has seen applied.
	*
	* A lower setting than this means the user shrank the window on purpose, which
	* the "clock jumped" guard in `pruneForWrite` must not veto. Seeded from the
	* retention the file itself records, so a setting changed while the app was
	* closed is still recognised as a shrink instead of looking like a jump.
	*/
	retentionSeen;
	/**
	* The window the file on disk was last pruned to, as recorded in the file.
	*
	* `retentionSeen` cannot answer "was this day written under a clock that was
	* behind this one?" after the first prune, because it is lowered to the
	* current setting; the file's own window can, and it is what tells a clock
	* that jumped from a retention the user lowered.
	*/
	fileRetention;
	/** The window a shrink in this session asked for, so later prunes still read as one. */
	shrankTo;
	/**
	* This machine's identity as recorded in every file it writes.
	*
	* Pinned in `machine-id.json` on first run rather than derived from the host
	* name: a rename must not make this machine look like a second device.
	*/
	machine = localMachineId();
	/**
	* Ids this profile used before the current pin: a re-minted pin leaves files
	* stamped with an older id, and those are this machine's own history, not a
	* second device. Folded in (max merge) instead of summed.
	*/
	machineAliases = /* @__PURE__ */ new Set();
	/**
	* The deduped replay of this boot, kept so a flush that must not max-merge
	* (a file another process repaired) can still add the buckets only the replay
	* recovers — those are not expressible as growth since our last write.
	*/
	replayDoc;
	ledger = createLedgerDocument();
	/**
	* The document this process last wrote to disk. Another process on this
	* machine writes the same file, so a flush adds only what we folded since
	* this snapshot — adding the whole document would count its calls twice.
	*/
	ledgerWritten;
	/**
	* Newest `repairedAt` this process has already accounted for. A file carrying
	* a later stamp was corrected by another process after we loaded, and its
	* (lower) buckets must not be raised again by our stale copy.
	*/
	seenRepairedAt = 0;
	snapshots = /* @__PURE__ */ new Map();
	/** The official DeepSeek family's real-spend watch (see SpendWatch). */
	spendWatch;
	/** Per-live-session route attribution (WeakMap: disposed sessions age out). */
	sessionRoutes = /* @__PURE__ */ new WeakMap();
	/** The most recent route seen this boot; the sidebar strip and the header highlight follow it. */
	current = { source: "default" };
	sessionListenerDisposer;
	pollTimer;
	flushTimer;
	pollInFlight = false;
	/** The running poll cycle; manual refresh joins it instead of no-oping. */
	pollPromise;
	/** Serialized ledger flushes: overlapping debounce/stop flushes queue, never interleave. */
	flushChain = Promise.resolve();
	/** True once loadPersisted finished; nothing may overwrite the files before that. */
	loaded = false;
	/** Retry bookkeeping for a ledger file that could not be read this boot. */
	loadRetries = 0;
	loadRetryTimer;
	disposed = false;
	/** Last prune guard: once per local day, and whenever retention shrinks. */
	lastPrune;
	constructor(ctx, options) {
		this.ctx = ctx;
		this.options = options;
		this.persistDir = join(dshHome(), "dsh-usage");
		this.deviceId = localDeviceId();
		this.ledgerPath = join(this.persistDir, ledgerFileName(this.deviceId));
		this.snapshotsPath = join(this.persistDir, "provider-snapshots.json");
		this.retentionSeen = options.retainDays;
	}
	/** Start the listeners, load persisted state, and arm the first poll. */
	start() {
		this.sessionListenerDisposer = this.ctx.on("session/event", (session, event) => this.onSessionEvent(session, event));
		this.loadPersisted();
		this.rearmPoll(2e3);
	}
	/**
	* Stop timers and flush pending ledger writes. The returned promise
	* resolves after the final flush lands, so a successor instance (the Host
	* reloads the profile row on a config change) can serialize its first load
	* behind it.
	*/
	stop() {
		this.disposed = true;
		if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
		if (this.flushTimer !== void 0) clearTimeout(this.flushTimer);
		if (this.loadRetryTimer !== void 0) clearTimeout(this.loadRetryTimer);
		this.sessionListenerDisposer?.();
		return this.flushLedger();
	}
	/** Re-apply options to this running instance; retention shrink prunes now. */
	applyOptions(options) {
		this.options = options;
		this.pruneIfNeeded();
	}
	/** Force one poll now (manual refresh route); joins an in-flight cycle. */
	async refresh() {
		await this.rescanPeers();
		await this.pollNow();
	}
	/** This machine's stable id — the key its exported ledger carries. */
	get device() {
		return this.deviceId;
	}
	/**
	* This device's own ledger as a portable export envelope.
	*
	* Contains only this machine's history: peers are already counted on the
	* receiving side when their files are present, so re-exporting them would
	* make totals grow with each round trip.
	*/
	exportLedger() {
		return {
			schema: LEDGER_EXPORT_SCHEMA,
			version: 1,
			deviceId: this.deviceId,
			machine: this.machine,
			exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
			ledger: this.ledger
		};
	}
	/**
	* Install a peer's exported ledger as that device's file.
	*
	* REPLACES the peer file rather than merging into it, which is what makes a
	* repeated import idempotent: the totals served are a sum over files that
	* exist, so importing the same document twice changes nothing. The device id
	* comes from inside the document (validated as a filename-safe token), so the
	* receiving machine never has to know the sender's file name.
	* @param text - raw JSON of an export envelope or a bare ledger document.
	* @returns the device id that was written.
	*/
	async importPeer(text) {
		if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES$1) throw new UsageImportError(`ledger exceeds ${IMPORT_MAX_BYTES$1} bytes`);
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new UsageImportError("not JSON");
		}
		const record = typeof parsed === "object" && parsed !== null ? parsed : void 0;
		if (record === void 0) throw new UsageImportError("not a ledger document");
		const claimedId = typeof record.deviceId === "string" ? record.deviceId : void 0;
		if (claimedId === void 0) throw new UsageImportError("missing deviceId: export the file from the plugin instead of hand-writing it");
		if (!isDeviceId(claimedId)) throw new UsageImportError(`unusable deviceId ${JSON.stringify(claimedId)}`);
		if (claimedId === this.deviceId) throw new UsageImportError("this file was exported by THIS device; nothing to import");
		const doc = parsePeerLedger(parsed);
		if (doc === void 0) throw new UsageImportError("unreadable ledger payload");
		await mkdir(this.persistDir, { recursive: true });
		const target = join(this.persistDir, ledgerFileName(claimedId));
		const existing = await readFile(target, "utf8").then((text) => {
			try {
				return parsePeerLedger(JSON.parse(text));
			} catch {
				return;
			}
		}, () => void 0);
		const merged = existing === void 0 ? doc.doc : structuredClone(existing.doc);
		if (existing !== void 0) mergeLedgerMax(merged, doc.doc);
		if (existing !== void 0) {
			const kept = ledgerDayKeys(existing.doc).filter((key) => doc.doc.days[key] === void 0);
			if (kept.length > 0) this.note(`import:${claimedId}`, `import merged into the peer file; ${kept.length} day(s) it already held were kept`);
		}
		await writeJsonAtomic(target, {
			schema: LEDGER_EXPORT_SCHEMA,
			version: 1,
			deviceId: claimedId,
			...doc.machine === void 0 ? {} : { machine: doc.machine },
			exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
			ledger: merged
		});
		await this.refreshPeers();
		return { deviceId: claimedId };
	}
	/** Re-scan peer files; the panel calls this after a file is dropped in by hand. */
	async rescanPeers() {
		await this.refreshPeers();
		return this.deviceEntries();
	}
	/** Assemble the overview document the browser section renders. */
	overview() {
		const todayKey = localDateKey(Date.now());
		const routes = this.listProviderRoutes();
		const providers = [];
		for (const route of routes) {
			const adapter = adapterFor(route.id);
			const snapshot = this.snapshots.get(route.id);
			const error = snapshot?.balanceError ?? snapshot?.planError;
			providers.push({
				provider: route.id,
				displayName: route.displayName || adapter?.displayName || route.id,
				credential: snapshot?.credential ?? "none",
				supported: adapter !== void 0 && (adapter.balance !== void 0 || adapter.plan !== void 0),
				...adapter?.balance !== void 0 && balanceAppliesToRoute(adapter, this.routeBaseUrl(route.id)) ? { balanceSupported: true } : {},
				...adapter?.balance !== void 0 && !balanceAppliesToRoute(adapter, this.routeBaseUrl(route.id)) ? { balanceSupported: false } : {},
				...adapter?.plan !== void 0 ? { planSupported: true } : {},
				...snapshot?.balance !== void 0 ? { balance: snapshot.balance } : {},
				...snapshot?.plan !== void 0 ? { plan: snapshot.plan } : {},
				...error !== void 0 ? { error } : {},
				...snapshot?.updatedAt !== void 0 ? { updatedAt: snapshot.updatedAt } : {}
			});
		}
		providers.sort((a, b) => Number(b.supported) - Number(a.supported) || a.displayName.localeCompare(b.displayName));
		const merged = this.mergedLedger();
		const allKeys = ledgerDayKeys(merged);
		const oldest = localDateKey(Date.now() - 25056e5);
		const days = allKeys.filter((key) => key >= oldest);
		const range = summarizeDays(days.map((key) => merged.days[key] ?? {}));
		const all = summarizeDays(allKeys.map((key) => merged.days[key] ?? {}));
		return {
			updatedAt: Date.now(),
			providers,
			current: this.currentView(),
			usage: {
				today: this.daySummary(todayKey),
				days: days.map((date) => {
					return {
						date,
						totals: this.daySummary(date).totals
					};
				}),
				range: {
					from: days[0] ?? todayKey,
					to: days[days.length - 1] ?? todayKey,
					totals: range.totals,
					providers: range.providers
				},
				availableDays: ledgerDayKeys(this.ledger),
				all: {
					from: allKeys[0] ?? todayKey,
					to: allKeys[allKeys.length - 1] ?? todayKey,
					totals: all.totals,
					providers: all.providers
				},
				...this.spendWatch !== void 0 && this.spendWatch.accruedCny > 0 ? { observedSpend: {
					cny: this.spendWatch.accruedCny,
					since: this.spendWatch.since
				} } : {},
				devices: this.deviceEntries(),
				deviceId: this.deviceId,
				...this.peersError !== void 0 ? { devicesError: this.peersError } : {},
				...this.ledgerError !== void 0 ? { ledgerError: this.ledgerError } : {},
				...this.ledgerNoteText() !== void 0 ? { ledgerNote: this.ledgerNoteText() } : {}
			}
		};
	}
	/** Every ledger file backing the served totals, this device first. */
	deviceEntries() {
		return [{
			deviceId: this.deviceId,
			role: "local"
		}, ...this.peers.map((peer) => ({
			deviceId: peer.deviceId,
			role: "peer"
		}))];
	}
	/**
	* The served document: this device's ledger plus every peer's, summed.
	*
	* Summed, not merged by max: two devices on one account genuinely spent both
	* sets of tokens, so the ledger a user expects is the sum. Nothing here is
	* ever written back — `this.ledger` stays this device's own history, which is
	* what makes a repeated peer import idempotent (the same file is read twice,
	* not added twice).
	*/
	mergedLedger() {
		if (this.peers.length === 0) return this.ledger;
		const merged = createLedgerDocument();
		mergeLedgerSum(merged, this.ledger);
		for (const peer of this.peers) mergeLedgerSum(merged, peer.doc);
		return merged;
	}
	/**
	* The strip-ready current-provider view: the resolved display name plus
	* today's ledger totals for the provider's adapter family (the route
	* itself when adapter-less). `today` is absent on a day without usage —
	* a strip about nothing is noise, not information.
	*/
	currentView() {
		const provider = this.current.provider;
		if (provider === void 0) return { ...this.current };
		let snapshot = this.snapshots.get(provider);
		if (snapshot === void 0) {
			const family = adapterFor(provider);
			if (family !== void 0) {
				for (const [id, candidate] of this.snapshots) if (adapterFor(id) === family) {
					snapshot = candidate;
					break;
				}
			}
		}
		const displayName = snapshot?.displayName ?? this.routeDisplayName(provider);
		const today = this.familyUsageToday(provider);
		return {
			...this.current,
			displayName,
			...today.calls > 0 && totalTokens(today) > 0 ? { today } : {}
		};
	}
	/**
	* One retained local day aggregated per provider and model, as the day
	* route serves it. A day the ledger never held — pruned by retention, or
	* simply without usage — reads as a zeroed day rather than an error, so a
	* picker selection that aged out degrades to "no usage" instead of a broken
	* panel. The route gates the key's shape before it gets here.
	*/
	day(dateKey) {
		return this.daySummary(dateKey);
	}
	/**
	* One window aggregated per provider and model, plus the per-day series the
	* trend chart buckets. Reads the merged ledger (local + imported peers), so
	* a single request answers a window that would otherwise cost one small
	* fetch per recorded day — the shape that makes multi-month windows viable.
	* Each series row also carries the day's per-model split aggregated across
	* providers, so the browser can stack the trend bars by model without one
	* day fetch per recorded day.
	* @param from - local date key `YYYY-MM-DD`, inclusive.
	* @param to - local date key `YYYY-MM-DD`, inclusive.
	*/
	range(from, to) {
		const merged = this.mergedLedger();
		const keys = ledgerDayKeys(merged).filter((date) => date >= from && date <= to);
		const { totals, providers } = summarizeDays(keys.map((key) => merged.days[key] ?? {}));
		return {
			from,
			to,
			totals,
			providers,
			series: keys.map((date) => {
				const day = this.daySummaryIn(merged, date);
				const models = {};
				for (const row of day.providers) for (const model of row.models) {
					const bucket = models[model.model] ?? emptyTotals();
					addTotals(bucket, model.totals);
					models[model.model] = bucket;
				}
				return {
					date,
					totals: day.totals,
					models
				};
			})
		};
	}
	/** One day of the merged ledger aggregated per provider. */
	daySummaryIn(doc, dateKey) {
		const { totals, providers } = summarizeDays([doc.days[dateKey] ?? {}]);
		return {
			date: dateKey,
			totals,
			providers
		};
	}
	/** One local day aggregated per provider. */
	daySummary(dateKey) {
		const { totals, providers } = summarizeDays([this.mergedLedger().days[dateKey] ?? {}]);
		return {
			date: dateKey,
			totals,
			providers
		};
	}
	/**
	* Today's ledger totals for one provider's adapter family — the exact
	* route when adapter-less, the merged family otherwise, so aliased routes
	* of one account (the deepseek catalog id and its runtime alias) fold
	* together.
	*/
	familyUsageToday(provider) {
		const family = adapterFor(provider);
		let merged = emptyTotals();
		for (const row of this.daySummary(localDateKey(Date.now())).providers) if (family === void 0 ? row.provider === provider : adapterFor(row.provider) === family) merged = addTotals(merged, row.totals);
		return merged;
	}
	/**
	* Accrue the official DeepSeek family's real spend from observed CNY
	* balance decreases; a balance rise is a top-up and never counts. The
	* family's route ids can alias one account, so the watch follows the
	* largest balance seen this cycle and accrues only decreases of that
	* series — a failed probe keeps the stale balance and accrues nothing
	* until the next success reports the whole drop at once.
	*/
	accrueDeepSeekSpend() {
		let balanceCny;
		for (const [id, snapshot] of this.snapshots) {
			if (!isDeepSeekProviderRoute(id)) continue;
			const balance = snapshot.balance;
			if (balance === void 0 || balance.currency.toUpperCase() !== "CNY") continue;
			const value = Number(balance.totalBalance);
			if (!Number.isFinite(value)) continue;
			balanceCny = balanceCny === void 0 ? value : Math.max(balanceCny, value);
		}
		if (balanceCny === void 0) return;
		const watch = this.spendWatch ?? {
			accruedCny: 0,
			since: Date.now()
		};
		if (watch.lastBalanceCny !== void 0 && balanceCny < watch.lastBalanceCny) watch.accruedCny += watch.lastBalanceCny - balanceCny;
		watch.lastBalanceCny = balanceCny;
		this.spendWatch = watch;
	}
	/**
	* The display name for a route key: the LLM runtime's first, then the
	* adapter's, then the id itself — the snapshot may not exist for
	* adapter-less routes, yet the sidebar strip still needs a legible title.
	*/
	routeDisplayName(provider) {
		return this.listProviderRoutes().find((entry) => entry.id === provider)?.displayName || adapterFor(provider)?.displayName || provider;
	}
	onSessionEvent(session, event) {
		try {
			if (event.type === "request/header") {
				const config = event.data.header?.config;
				if (config?.provider !== void 0) {
					this.sessionRoutes.set(session, {
						provider: config.provider,
						model: config.model ?? ""
					});
					this.current = {
						provider: config.provider,
						model: config.model,
						source: "live"
					};
				}
			} else if (event.type === "request/context") {
				const data = event.data;
				if (data.provider !== void 0) {
					this.sessionRoutes.set(session, {
						provider: data.provider,
						model: data.model ?? ""
					});
					this.current = {
						provider: data.provider,
						model: data.model,
						source: "live"
					};
				}
			} else if (event.type === "assistant/message") {
				const data = event.data;
				const usage = data.usage;
				if (usage === void 0) return;
				const source = data.message?.source;
				const route = typeof source?.provider === "string" && source.provider !== "" ? {
					provider: source.provider,
					model: source.model ?? ""
				} : this.sessionRoutes.get(session);
				if (route === void 0 || route.provider === "") return;
				const atMs = typeof event.time === "number" ? event.time : Date.now();
				foldUsage(this.ledger, atMs, route.provider, route.model || "unknown", this.totalsFrom(usage, route.provider, route.model || "unknown", atMs));
				this.scheduleFlush();
			}
		} catch {}
	}
	/**
	* Normalize a provider TokenUsage into the ledger bucket (one call). The
	* DeepSeek official family is priced at the fold instant (its billing
	* period is time-of-day); other families stay unpriced (cost 0).
	*/
	totalsFrom(usage, provider, model, atMs) {
		const totals = emptyTotals();
		totals.inputTokens = usage.inputTokens;
		totals.outputTokens = usage.outputTokens;
		totals.cacheReadTokens = usage.cacheReadTokens ?? 0;
		totals.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
		totals.reasoningTokens = usage.reasoningTokens ?? 0;
		totals.calls = 1;
		if (isDeepSeekProviderRoute(provider)) totals.cost = deepseekModelSpend(model, totals, atMs);
		return totals;
	}
	/**
	* Read this device's ledger file, telling the three failures apart: absent,
	* unreadable (locked or permission-denied — the data may still be there), and
	* corrupt (present but unparseable). Only "absent" may start a fresh file;
	* treating either failure as "no history" would let the next flush replace a
	* real ledger with an empty one.
	*/
	async readLedgerFile() {
		let raw;
		try {
			raw = await readFile(this.ledgerPath, "utf8");
		} catch (error) {
			const code = error.code;
			return code === "ENOENT" ? { kind: "missing" } : {
				kind: "unreadable",
				error: String(code ?? error)
			};
		}
		const parsed = this.ledgerFromJson(raw);
		return parsed.kind === "ok" ? {
			kind: "ok",
			doc: parsed.doc,
			repairedAt: parsed.repairedAt,
			machine: parsed.machine,
			retentionDays: parsed.retentionDays
		} : {
			kind: "corrupt",
			error: parsed.error
		};
	}
	/**
	* Parse ledger JSON, accepting the `/export` envelope as well as a bare document.
	*
	* An export wraps the document as `{schema, version, deviceId, exportedAt,
	* ledger}`, and restoring a backup means dropping exactly that file back in
	* place. Reading only the top-level `days` would call it a valid *empty*
	* ledger, and the first flush would then write that emptiness over the
	* history — while `importPeer` refuses this device's own export, leaving no
	* recovery path at all. So the envelope is unwrapped here, and a file naming
	* another device is refused instead of adopted (it belongs in the peers path).
	*/
	ledgerFromJson(raw) {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			return {
				kind: "corrupt",
				error: error instanceof Error ? error.message : String(error)
			};
		}
		if (typeof parsed !== "object" || parsed === null) return {
			kind: "corrupt",
			error: "not a ledger document"
		};
		const record = parsed;
		const deviceId = typeof record.deviceId === "string" ? record.deviceId : "";
		if (deviceId !== "" && deviceId !== localDeviceId()) return {
			kind: "corrupt",
			error: `names device ${deviceId}`
		};
		const inner = typeof record.ledger === "object" && record.ledger !== null ? record.ledger : record;
		if (typeof inner.days !== "object" || inner.days === null) return {
			kind: "corrupt",
			error: "no days in document"
		};
		const repairedAt = typeof record.repairedAt === "number" && Number.isFinite(record.repairedAt) ? record.repairedAt : void 0;
		const machine = typeof record.machine === "string" && record.machine !== "" ? record.machine : void 0;
		const retentionDays = typeof record.retentionDays === "number" && Number.isFinite(record.retentionDays) ? record.retentionDays : void 0;
		try {
			return {
				kind: "ok",
				doc: deserializeLedger(inner),
				...repairedAt !== void 0 ? { repairedAt } : {},
				...machine !== void 0 ? { machine } : {},
				...retentionDays !== void 0 ? { retentionDays } : {}
			};
		} catch (error) {
			return {
				kind: "corrupt",
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}
	async loadPersisted() {
		try {
			if (this.loadBaseline === void 0) this.loadBaseline = structuredClone(this.ledger);
			else if (!this.loadAbsorbed) this.ledger = structuredClone(this.loadBaseline);
			await this.loadPersistedOnce();
			if (this.loaded) this.loadBaseline = void 0;
		} catch (error) {
			this.ledgerError = `ledger load failed (${error instanceof Error ? error.message : String(error)})`;
			this.scheduleLoadRetry();
		}
	}
	async loadPersistedOnce() {
		this.machine = await ensureMachineId(this.persistDir);
		for (const alias of await readMachineAliases(this.persistDir)) this.machineAliases.add(alias);
		let read = await this.readLedgerFile();
		/** True when this boot starts without the history the ledger used to hold. */
		let lostHistory = false;
		if (read.kind === "unreadable") {
			this.ledgerError = `ledger unreadable (${read.error})`;
			if (this.loadRetries < LOAD_RETRY_MAX) {
				this.scheduleLoadRetry();
				return;
			}
			const kept = `${this.ledgerPath}.unreadable-${Date.now()}.json`;
			if (!await rename(this.ledgerPath, kept).then(() => true, () => false)) {
				this.note("ledger-unreadable", `ledger unreadable (${read.error}); this session will not write`);
				return;
			}
			this.ledgerError = `ledger unreadable (${read.error}); kept as ${basename(kept)}`;
			this.note("ledger-unreadable", `ledger unreadable (${read.error}); kept as ${basename(kept)}, counting into a fresh file`);
			lostHistory = true;
			read = { kind: "missing" };
		}
		if (read.kind === "corrupt") {
			const foreign = foreignDeviceOf(read.error);
			const target = foreign === void 0 ? void 0 : join(this.persistDir, ledgerFileName(foreign));
			const taken = target === void 0 ? true : await stat(target).then(() => true, () => false);
			if (target !== void 0 && !taken) {
				if (await rename(this.ledgerPath, target).then(() => true, () => false)) {
					this.note(`adopted:${foreign}`, `ledger named device ${foreign}; adopted as ${basename(target)}`);
					read = { kind: "missing" };
				}
			} else if (target !== void 0) this.note(`adopted:${foreign}`, `ledger named device ${foreign}, whose file is already present`);
			if (read.kind === "corrupt") {
				const kept = `${this.ledgerPath}.corrupt-${Date.now()}.json`;
				const renamed = await rename(this.ledgerPath, kept).then(() => true, () => false);
				this.ledgerError = renamed ? `ledger corrupt (${read.error}); kept as ${basename(kept)}` : `ledger corrupt (${read.error}); left in place`;
				if (!renamed) {
					this.scheduleLoadRetry();
					return;
				}
				lostHistory = true;
			}
		}
		if (read.kind === "ok") {
			if (!this.loadAbsorbed) {
				this.absorb(this.ledger, read.doc);
				this.loadAbsorbed = true;
			}
			this.seenRepairedAt = read.repairedAt ?? 0;
			await this.rememberMachine(read.machine);
			if (read.retentionDays !== void 0) {
				this.retentionSeen = Math.max(this.retentionSeen, read.retentionDays);
				this.fileRetention = read.retentionDays;
			}
			if (read.retentionDays !== void 0 && read.retentionDays === this.options.retainDays) this.clearNote("retention");
		} else if (read.kind === "missing") await this.adoptLegacyLedger();
		if (lostHistory) await this.restoreMigratedHistory();
		await this.loadSnapshots();
		const replay = await this.replaySessionLogs();
		this.replayDoc = replay.doc;
		await this.refreshPeers();
		if (replay.skipped > 0) this.note("replay-cap", `${replay.skipped} older transcripts beyond the replay cap of ${SESSION_LOG_MAX_FILES} were not replayed`);
		const prior = await this.readRepairRecord();
		const repaired = await this.repairDuplicatedReplay(replay, prior);
		this.lastPrune = void 0;
		this.pruneIfNeeded();
		this.loaded = true;
		this.loadRetries = 0;
		this.ledgerWritten = structuredClone(this.ledger);
		if (read.kind !== "corrupt") this.ledgerError = void 0;
		if (repaired.buckets > 0) {
			const written = await this.persistRepair(repaired.repaired);
			if (written !== void 0 && written.corrected.size > 0) await writeJsonAtomic(join(this.persistDir, DEDUPE_MARKER_FILE), {
				version: 2,
				appliedAt: Date.now(),
				buckets: written.corrected.size,
				removedTokens: written.removedTokens,
				after: {
					...Object.fromEntries([...prior].map(([key, totals]) => [key, totals])),
					...Object.fromEntries([...written.corrected])
				}
			}).catch(() => void 0);
		}
		this.scheduleFlush();
	}
	/**
	* Record a non-fatal note the panel shows beside the numbers.
	*
	* Notes are keyed: a condition that holds on every flush ("retention
	* skipped …") must not append itself again and again, or the line the user
	* reads grows for as long as the process runs.
	*/
	note(kind, text) {
		this.notes.delete(kind);
		this.notes.set(kind, text);
		while (this.notes.size > NOTE_MAX) {
			const oldest = this.notes.keys().next();
			if (oldest.done === true) break;
			this.notes.delete(oldest.value);
		}
	}
	/** Drop a note whose condition no longer holds. */
	clearNote(kind) {
		this.notes.delete(kind);
	}
	/** Drop every note whose kind starts with `prefix` (peer notes, per scan). */
	clearNotesWithPrefix(prefix) {
		for (const kind of [...this.notes.keys()]) if (kind.startsWith(prefix)) this.notes.delete(kind);
	}
	/**
	* Whether a machine id taken from a file names this machine.
	*
	* Three cases count: the live pin, an id this profile used before (a lost
	* `machine-id.json` mints a new one while older files keep the old stamp), and
	* the derived digest that builds before the pin stamped into their files. All
	* three hold this machine's own history; summing any of them as a second device
	* would count those calls twice. Two machines whose host name, user and
	* platform are identical share a digest — that undercounts, which is the lesser
	* evil compared with a permanently doubled history.
	*/
	sameMachine(id) {
		if (id === this.machine) return true;
		if (this.machineAliases.has(id)) return true;
		return id === localMachineId();
	}
	/** Remember an id this profile has written under, so its old files fold in. */
	async rememberMachine(id) {
		if (id === void 0 || id === this.machine) return;
		this.machineAliases.add(id);
		await rememberMachineAlias(this.persistDir, id).catch(() => {});
	}
	/** The notes as one line, oldest first, capped so the panel stays readable. */
	ledgerNoteText() {
		const texts = [...this.notes.values()].slice(-3);
		return texts.length === 0 ? void 0 : texts.join("; ");
	}
	/** Retry a ledger read that failed for a transient reason (lock, sharing). */
	scheduleLoadRetry() {
		if (this.disposed || this.loadRetryTimer !== void 0) return;
		if (this.loadRetries >= LOAD_RETRY_MAX) return;
		this.loadRetries += 1;
		this.loadRetryTimer = setTimeout(() => {
			this.loadRetryTimer = void 0;
			this.loadPersisted();
		}, LOAD_RETRY_MS);
	}
	/** Revive the probe cache and the spend watch; both are best-effort. */
	async loadSnapshots() {
		let raw;
		try {
			raw = await readFile(this.snapshotsPath, "utf8");
		} catch (error) {
			const code = error.code;
			if (code !== "ENOENT") this.note("snapshots", `probe cache unreadable (${String(code ?? error)}); balances start empty`);
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && typeof parsed.providers === "object" && parsed.providers !== null) {
				for (const [provider, snapshot] of Object.entries(parsed.providers)) if (typeof snapshot === "object" && snapshot !== null && typeof snapshot.provider === "string") this.snapshots.set(provider, snapshot);
			}
			const watch = readSpendWatch(parsed.spendWatch);
			if (watch !== void 0) this.spendWatch = watch;
		} catch {}
	}
	/**
	* Fold the session transcripts back into the ledger.
	*
	* `session/event` only carries records appended while an instance is
	* mounted, so calls made before the first mount — or during a remount
	* window — exist nowhere else. Every bucket is merged field by field with the
	* larger value winning: replay never shrinks a live bucket, and a ledger
	* rebuilt from an older transcript never loses a newer live fold, so running
	* this on every start is idempotent. (Field by field, because the two sides
	* can each carry a field the other lacks — a cost estimate, cache-read
	* tokens — and picking one bucket wholesale would delete them.)
	*
	* The pass also reports the duplicate copies it dropped, so the repair below
	* can use them without walking the transcripts (287 MB, ~18 s) again.
	*/
	async replaySessionLogs() {
		const pass = {
			doc: createLedgerDocument(),
			duplicates: /* @__PURE__ */ new Map(),
			files: 0,
			replayed: 0,
			skipped: 0
		};
		try {
			const counts = await collectSessionLogUsage(join(dshHome(), "sessions"), (replay) => {
				pass.doc = replay;
				for (const [dayKey, providers] of Object.entries(replay.days)) {
					const atMs = (/* @__PURE__ */ new Date(dayKey + "T12:00:00")).getTime();
					if (!Number.isFinite(atMs)) continue;
					const day = this.ledger.days[dayKey] ?? (this.ledger.days[dayKey] = {});
					for (const [provider, models] of Object.entries(providers)) for (const [model, totals] of Object.entries(models)) {
						const folded = isDeepSeekProviderRoute(provider) ? {
							...totals,
							cost: deepseekModelSpend(model, totals, atMs)
						} : totals;
						const found = findLedgerBucket(day, provider, model);
						if (found !== void 0) {
							day[found.provider][found.model] = maxTotals(found.totals, folded);
							continue;
						}
						const route = day[provider] ?? (day[provider] = {});
						route[model] = folded;
					}
				}
			}, (dayKey, provider, model, totals) => {
				const key = repairKey(dayKey, provider, model);
				const entry = pass.duplicates.get(key);
				if (entry === void 0) pass.duplicates.set(key, {
					dayKey,
					provider,
					model,
					totals: { ...totals }
				});
				else entry.totals = addTotals(entry.totals, totals);
			});
			pass.files = counts.files;
			pass.replayed = counts.replayed;
			pass.skipped = counts.skipped;
		} catch {}
		return pass;
	}
	/**
	* Correction for the seeded-subagent duplicate.
	*
	* A seeded subagent's transcript opens with a verbatim copy of its parent's
	* assistant messages (same id, time and usage), and the replay used to fold
	* both copies into the same bucket. Deduping the replay stops new inflation
	* but cannot undo what is already written — the merge rule keeps the larger
	* total, so an inflated bucket would never come back down. The extra copies
	* are therefore subtracted once, and a sidecar marker records what was done.
	*
	* The subtraction is judged twice over, because a wrong subtraction cannot be
	* undone by any later merge:
	*
	* - `clean` is the deduped replay, the truth for that day. A bucket at or
	*   below it holds no copy at all, so it is left alone.
	* - `prior` is what an earlier start already left in the bucket (read back
	*   from the marker). A bucket still at that floor has already been corrected
	*   — subtracting again on every start would slowly eat real calls, which is
	*   exactly what a plain "big enough to subtract" guard allows once the day
	*   holds calls the replay cannot see.
	*/
	async repairDuplicatedReplay(replay, prior) {
		const repaired = /* @__PURE__ */ new Map();
		let buckets = 0;
		let removedTokens = 0;
		for (const [key, duplicate] of replay.duplicates) {
			const target = findLedgerBucket(this.ledger.days[duplicate.dayKey], duplicate.provider, duplicate.model);
			if (target === void 0) continue;
			const bucket = target.totals;
			const clean = findLedgerBucket(replay.doc.days[duplicate.dayKey], duplicate.provider, duplicate.model)?.totals ?? emptyTotals();
			const base = prior.get(key) ?? clean;
			if (bucket.calls - base.calls !== duplicate.totals.calls) continue;
			if (totalTokens(bucket) - totalTokens(base) !== totalTokens(duplicate.totals)) continue;
			const next = maxTotals(subtractTotals(bucket, duplicate.totals), base);
			const dropped = totalTokens(bucket) - totalTokens(next);
			if (dropped <= 0) continue;
			const repriced = this.priceBucket(duplicate.dayKey, target.provider, target.model, next);
			this.ledger.days[duplicate.dayKey][target.provider][target.model] = repriced;
			repaired.set(key, {
				...duplicate,
				provider: target.provider,
				model: target.model,
				clean,
				after: repriced
			});
			buckets += 1;
			removedTokens += dropped;
		}
		return {
			buckets,
			removedTokens,
			repaired
		};
	}
	/**
	* Price one bucket at its day's noon rate.
	*
	* Shared by the repair and the file-side pass so both write the same numbers:
	* the day is priced as a whole, which is why the noon instant stands in for
	* the calls inside it.
	*/
	priceBucket(dayKey, provider, model, totals) {
		const atMs = (/* @__PURE__ */ new Date(dayKey + "T12:00:00")).getTime();
		return isDeepSeekProviderRoute(provider) && Number.isFinite(atMs) ? {
			...totals,
			cost: deepseekModelSpend(model, totals, atMs)
		} : totals;
	}
	/**
	* What the last repair left in each bucket, read back from the marker.
	*
	* The marker is a record, not a gate: the numbers it holds are the floor a
	* later start must not subtract below. A marker written before this field
	* existed (or one damaged by hand) yields an empty map, and the repair then
	* falls back to the replay's own total.
	*/
	async readRepairRecord() {
		const record = /* @__PURE__ */ new Map();
		let raw;
		try {
			raw = await readFile(join(this.persistDir, DEDUPE_MARKER_FILE), "utf8");
		} catch {
			return record;
		}
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed.after !== "object" || parsed.after === null) return record;
			for (const [key, value] of Object.entries(parsed.after)) {
				const totals = readTotals(value);
				if (totals !== void 0) record.set(key, totals);
			}
		} catch {}
		return record;
	}
	/**
	* Fold a parsed document into a target ledger.
	*
	* Accumulates rather than replaces: folds that landed while the file was
	* being read (a session finishing during startup) must survive the load.
	*/
	absorb(into, from) {
		for (const [dayKey, providers] of Object.entries(from.days)) {
			const atMs = (/* @__PURE__ */ new Date(dayKey + "T12:00:00")).getTime();
			for (const [provider, models] of Object.entries(providers)) for (const [model, totals] of Object.entries(models)) foldUsage(into, atMs, provider, model, totals);
		}
	}
	/**
	* One-time migration off `usage-ledger.json`.
	*
	* Renamed rather than deleted: if the migration is wrong the user's only
	* pre-existing history would otherwise be gone, and a `.migrated` sibling is
	* cheap. A failed rename (read-only directory) leaves the legacy file in
	* place — the next start retries, and the ledger is still summed in.
	*
	* The `.migrated` sibling is read as well: it is what a successful migration
	* leaves behind, and it is the only copy of the pre-migration history once
	* this device's file is deleted or damaged. Re-adopting it is safe — the fold
	* is a merge, and the buckets it restores are the ones the file states.
	*/
	/**
	* Fold the pre-migration history back in after the ledger was lost.
	*
	* The oldest days predate the session transcripts this build replays, so the
	* ledger file is their only copy. When a corrupt file is quarantined the fresh
	* document starts empty and that history would be gone for good; the legacy
	* file (or its `.migrated` sibling) still states it, and the merge is a max —
	* it can only restore days the new document does not have.
	*/
	async restoreMigratedHistory() {
		const legacyPath = join(this.persistDir, LEGACY_LEDGER_FILE);
		let restored = 0;
		for (const path of [legacyPath, `${legacyPath}.migrated`]) {
			const raw = await readFile(path, "utf8").catch(() => void 0);
			if (raw === void 0) continue;
			try {
				const doc = deserializeLedger(JSON.parse(raw));
				const days = Object.keys(doc.days).length;
				if (days === 0) continue;
				mergeLedgerMax(this.ledger, doc);
				restored += days;
			} catch {}
		}
		if (restored === 0) return;
		this.pruneForWrite(this.ledger);
		this.note("legacy-restore", "the quarantined ledger was rebuilt from the pre-migration file");
	}
	async adoptLegacyLedger() {
		const legacyPath = join(this.persistDir, LEGACY_LEDGER_FILE);
		const migratedPath = `${legacyPath}.migrated`;
		const source = await readFile(legacyPath, "utf8").then((raw) => ({
			raw,
			path: legacyPath
		}), () => readFile(migratedPath, "utf8").then((raw) => ({
			raw,
			path: migratedPath
		}), () => void 0));
		if (source === void 0) return;
		try {
			this.absorb(this.ledger, deserializeLedger(JSON.parse(source.raw)));
			pruneLedger(this.ledger, localDateKey(Date.now()), this.options.retainDays);
			this.lastPrune = {
				dayKey: localDateKey(Date.now()),
				retainDays: this.options.retainDays
			};
		} catch {
			return;
		}
		if (await writeJsonAtomic(this.ledgerPath, ledgerFileDocument(this.ledger, { machine: this.machine })).then(() => true, () => false) && source.path === legacyPath) await rename(legacyPath, migratedPath).catch(() => void 0);
	}
	/**
	* Re-read every peer ledger file in the persist directory.
	*
	* Peers are whatever `usage-ledger.<deviceId>.json` files are present, so
	* "importing" a device is just dropping its file in — and re-importing the
	* same file changes nothing, because the totals are derived from the set of
	* files rather than accumulated into state.
	*
	* A file only counts as a device when its own document proves which machine
	* wrote it: this build stamps `deviceId` and `machine` into every ledger it
	* writes, so a file without them is a copy (a renamed backup, a hand-placed
	* duplicate) and summing it would count this machine's calls twice. Every
	* refusal is reported rather than swallowed, because a silently missing
	* device reads exactly like a device that never existed.
	*/
	async refreshPeers() {
		let names;
		try {
			names = await readdir(this.persistDir);
		} catch (error) {
			this.peersError = `peer scan failed (${error instanceof Error ? error.message : String(error)})`;
			return;
		}
		const peers = [];
		const failures = [];
		this.clearNotesWithPrefix("unverified:");
		this.clearNotesWithPrefix("renamed:");
		for (const name of names) {
			const deviceId = deviceIdOfFile(basename(name));
			if (deviceId === void 0) continue;
			if (deviceId === this.deviceId) continue;
			const filePath = join(this.persistDir, name);
			try {
				const [raw, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
				const parsed = parsePeerLedger(JSON.parse(raw));
				if (parsed === void 0) {
					failures.push(`${name}: not a usage ledger`);
					continue;
				}
				if (parsed.deviceId === "") {
					failures.push(`${name}: no device id in the document, not summed`);
					continue;
				}
				if (parsed.deviceId !== deviceId) {
					failures.push(`${name}: names device ${parsed.deviceId}`);
					continue;
				}
				if (parsed.machine === void 0) {
					const unrecorded = {};
					for (const [day, buckets] of Object.entries(parsed.doc.days)) if (this.ledger.days[day] === void 0) unrecorded[day] = buckets;
					const taken = Object.keys(unrecorded).length;
					peers.push({
						deviceId,
						machine: void 0,
						doc: {
							...parsed.doc,
							days: unrecorded
						},
						updatedAt: info.mtimeMs
					});
					this.note(`unverified:${deviceId}`, taken === 0 ? `${name}: unverified (no machine id in the document), and every day in it is already recorded here, so it was not counted` : `${name}: unverified (no machine id in the document), so only the ${taken} day(s) this machine has not recorded were counted`);
					continue;
				}
				if (parsed.machine !== void 0 && this.sameMachine(parsed.machine)) {
					mergeLedgerMax(this.ledger, parsed.doc);
					this.note(`renamed:${deviceId}`, `${name}: this machine under an older name, folded in rather than summed`);
					continue;
				}
				peers.push({
					deviceId,
					machine: parsed.machine,
					doc: parsed.doc,
					updatedAt: info.mtimeMs
				});
			} catch {
				failures.push(`${name}: unreadable`);
			}
		}
		peers.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
		this.peers = peers;
		this.peersError = failures.length === 0 ? void 0 : failures.join("; ");
	}
	scheduleFlush() {
		if (this.flushTimer !== void 0 || this.disposed) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = void 0;
			this.flushLedger();
		}, FLUSH_DEBOUNCE_MS);
	}
	/**
	* Queue one ledger flush behind the previous one. Debounce and stop-time
	* flushes serialize here, so two `writeJsonAtomic` calls can never run
	* concurrently on the same path.
	*/
	flushLedger() {
		const next = this.flushChain.then(() => this.writeLedgerOnce());
		this.flushChain = next.catch(() => {});
		return next;
	}
	async writeLedgerOnce() {
		if (!this.loaded) return;
		try {
			await mkdir(dirname(this.ledgerPath), { recursive: true });
			await this.withLedgerLock(() => this.writeLedgerLocked());
		} catch (error) {
			this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`;
		}
	}
	/**
	* Run `work` while holding the ledger lock file.
	*
	* The lock is advisory and best effort by design: a stale lock (a crashed
	* process) must not block writing forever, so it is broken after
	* `LOCK_STALE_MS`, and a run that cannot take it proceeds anyway — losing one
	* interleaved write is recoverable on the next replay, while refusing to write
	* at all loses every call made after it.
	*/
	async withLedgerLock(work) {
		const lockPath = `${this.ledgerPath}.lock`;
		const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
		let handle;
		for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) try {
			handle = await open(lockPath, "wx");
			await handle.writeFile(token).catch(() => {});
			break;
		} catch (error) {
			if (error.code !== "EEXIST") break;
			if (await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0) > LOCK_STALE_MS) {
				await rm(lockPath, { force: true });
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
		try {
			await work();
		} finally {
			await handle?.close().catch(() => {});
			if (handle !== void 0) {
				if (await readFile(lockPath, "utf8").catch(() => void 0) === token) await rm(lockPath, { force: true }).catch(() => {});
			}
		}
	}
	async writeLedgerLocked() {
		const disk = await this.readDiskLedger();
		if (disk.kind === "bad") {
			this.ledgerError = `ledger unreadable (${disk.error}); write skipped`;
			return;
		}
		if (disk.kind === "ok") {
			const target = disk.doc;
			const stamp = disk.repairedAt ?? 0;
			await this.rememberMachine(disk.machine);
			if (stamp > this.seenRepairedAt) {
				this.seenRepairedAt = stamp;
				if (this.ledgerWritten !== void 0) mergeLedgerDelta(target, this.ledger, this.ledgerWritten);
				if (this.replayDoc !== void 0) mergeLedgerMax(target, this.replayDoc);
			} else if (this.seenRepairedAt > 0 && stamp < this.seenRepairedAt) {
				this.note("stale-writer", "the file on disk predates the ledger repair; its inflated buckets were not re-adopted");
				const own = structuredClone(this.ledger);
				for (const [dayKey, providers] of Object.entries(target.days)) for (const [provider, models] of Object.entries(providers)) for (const [model, totals] of Object.entries(models)) {
					const day = own.days[dayKey] ?? (own.days[dayKey] = {});
					if (findLedgerBucket(day, provider, model) !== void 0) continue;
					day[provider] = {
						...day[provider] ?? {},
						[model]: { ...totals }
					};
				}
				if (this.replayDoc !== void 0) mergeLedgerMax(own, this.replayDoc);
				this.pruneForWrite(own);
				this.ledger = own;
				await writeJsonAtomic(this.ledgerPath, this.ledgerFileDocument());
				this.ledgerWritten = structuredClone(this.ledger);
				this.ledgerError = void 0;
				this.fileRetention = this.options.retainDays;
				this.shrankTo = void 0;
				return;
			} else {
				if (this.ledgerWritten !== void 0) mergeLedgerDelta(target, this.ledger, this.ledgerWritten);
				mergeLedgerMax(target, this.ledger);
			}
			this.pruneForWrite(target);
			this.ledger = target;
		} else this.pruneForWrite(this.ledger);
		await writeJsonAtomic(this.ledgerPath, this.ledgerFileDocument());
		this.ledgerWritten = structuredClone(this.ledger);
		this.ledgerError = void 0;
		this.fileRetention = this.options.retainDays;
		this.shrankTo = void 0;
		this.clearNote("stale-writer");
	}
	/** This process's ledger as a file document: the identity travels with it. */
	ledgerFileDocument() {
		return ledgerFileDocument(this.ledger, {
			machine: this.machine,
			...this.seenRepairedAt > 0 ? { repairedAt: this.seenRepairedAt } : {},
			retentionDays: this.options.retainDays
		});
	}
	/**
	* Prune a document about to be written, refusing a prune that would delete
	* most of the history at once.
	*
	* Retention is measured against the clock, so one jump forward (a dead BIOS
	* battery, an NTP correction, a timezone change read as a new date) would
	* otherwise drop every day outside the window in a single flush — silently,
	* because the panel simply shows fewer days.
	*/
	pruneForWrite(doc) {
		const todayKey = localDateKey(Date.now());
		const days = Object.keys(doc.days).length;
		const prunable = countPrunable(doc, todayKey, this.options.retainDays);
		const seenBefore = this.retentionSeen;
		const shrank = this.options.retainDays < seenBefore || this.shrankTo === this.options.retainDays;
		if (shrank) this.shrankTo = this.options.retainDays;
		this.retentionSeen = Math.min(this.retentionSeen, this.options.retainDays);
		const stale = countPrunable(doc, todayKey, Math.max(this.fileRetention ?? this.options.retainDays, this.options.retainDays));
		const survivors = days - prunable;
		if (days > 0 && (stale > 0 && days >= 4 && survivors < 2 || prunable === days && !shrank)) {
			this.note("retention", `retention skipped: the clock would drop ${prunable} of ${days} recorded days`);
			return 0;
		}
		const pruned = pruneLedger(doc, todayKey, this.options.retainDays);
		const jumped = days >= 4 && pruned > days * .3;
		if (pruned > 0 && shrank) this.note("retention", `pruned ${pruned} of ${days} recorded days to honour the ${this.options.retainDays}-day window`);
		else if (pruned > 0 && jumped) this.note("retention", `pruned ${pruned} of ${days} recorded days at once — the clock may have jumped`);
		return pruned;
	}
	/** The ledger file as another writer left it: absent, parsed, or unreadable. */
	async readDiskLedger() {
		let raw;
		try {
			raw = await readFile(this.ledgerPath, "utf8");
		} catch (error) {
			const code = error.code;
			return code === "ENOENT" ? { kind: "missing" } : {
				kind: "bad",
				error: String(code ?? error)
			};
		}
		const parsed = this.ledgerFromJson(raw);
		return parsed.kind === "ok" ? {
			kind: "ok",
			doc: parsed.doc,
			repairedAt: parsed.repairedAt,
			machine: parsed.machine
		} : {
			kind: "bad",
			error: parsed.error
		};
	}
	/**
	* Write the duplicate repair over the file, keeping what other writers added.
	*
	* A verbatim overwrite would also drop the calls another process folded while
	* this one spent ~18 s replaying the transcripts, so the correction is applied
	* to the file's own document: a bucket is capped at its repaired value only
	* while it still carries the inflated total.
	*
	* Returns only the buckets that were really written, so the marker records a
	* correction that happened rather than one that was intended.
	*/
	async persistRepair(repaired) {
		try {
			await mkdir(dirname(this.ledgerPath), { recursive: true });
			let result;
			await this.withLedgerLock(async () => {
				result = await this.persistRepairLocked(repaired);
			});
			return result;
		} catch (error) {
			this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`;
			return;
		}
	}
	async persistRepairLocked(repaired) {
		try {
			const disk = await this.readDiskLedger();
			if (disk.kind === "bad") {
				this.ledgerError = `ledger unreadable (${disk.error}); repair not written`;
				return;
			}
			const target = disk.kind === "ok" ? disk.doc : this.ledger;
			const corrected = /* @__PURE__ */ new Map();
			let removedTokens = 0;
			for (const entry of repaired.values()) {
				const found = findLedgerBucket(target.days[entry.dayKey], entry.provider, entry.model);
				if (found === void 0) continue;
				const bucket = found.totals;
				if (bucket.calls - entry.after.calls !== entry.totals.calls) continue;
				if (totalTokens(bucket) - totalTokens(entry.after) !== totalTokens(entry.totals)) continue;
				const next = maxTotals(subtractTotals(bucket, entry.totals), entry.after);
				target.days[entry.dayKey][found.provider][found.model] = this.priceBucket(entry.dayKey, found.provider, found.model, next);
				const key = repairKey(entry.dayKey, found.provider, found.model);
				corrected.set(key, next);
				removedTokens += totalTokens(entry.totals);
			}
			this.pruneForWrite(target);
			if (corrected.size === 0) return {
				corrected,
				removedTokens: 0
			};
			this.seenRepairedAt = Math.max(this.seenRepairedAt, Date.now());
			try {
				await writeJsonAtomic(this.ledgerPath, ledgerFileDocument(target, {
					machine: this.machine,
					repairedAt: this.seenRepairedAt,
					retentionDays: this.options.retainDays
				}));
			} catch (error) {
				this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`;
				return;
			}
			this.ledgerWritten = structuredClone(target);
			this.ledgerError = void 0;
			return {
				corrected,
				removedTokens
			};
		} catch (error) {
			this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`;
			return;
		}
	}
	/**
	* Prune days past retention. Runs at most once per local day and whenever
	* `retainDays` shrinks — not only at startup, so long-lived processes and
	* live settings changes both honor retention.
	*/
	pruneIfNeeded() {
		const todayKey = localDateKey(Date.now());
		if (this.lastPrune?.dayKey === todayKey && this.lastPrune.retainDays === this.options.retainDays) return;
		const pruned = this.pruneForWrite(this.ledger);
		this.lastPrune = {
			dayKey: todayKey,
			retainDays: this.options.retainDays
		};
		if (pruned > 0) this.scheduleFlush();
	}
	/**
	* Persist the probe snapshots and the spend watch.
	*
	* Two processes on one machine share this file too, and the watch is an
	* accrual: a blind overwrite lets the slower writer erase the spend the faster
	* one already counted. The merge keeps the larger accrual (it can only grow),
	* its own `since`, and its own last balance, so the pair stays consistent.
	*/
	async persistSnapshots() {
		if (!this.loaded) return;
		try {
			await mkdir(dirname(this.snapshotsPath), { recursive: true });
			const theirs = readSpendWatch((await readFile(this.snapshotsPath, "utf8").then((raw) => JSON.parse(raw), () => void 0))?.spendWatch);
			const ours = this.spendWatch;
			const watch = ours === void 0 ? theirs : theirs === void 0 || ours.accruedCny >= theirs.accruedCny ? ours : theirs;
			await writeJsonAtomic(this.snapshotsPath, {
				version: 1,
				providers: Object.fromEntries(this.snapshots),
				...watch !== void 0 ? { spendWatch: watch } : {}
			});
			this.clearNote("snapshots");
		} catch (error) {
			this.note("snapshots", `snapshot write failed (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	rearmPoll(delayMs) {
		if (this.disposed) return;
		if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => {
			this.pollTimer = void 0;
			this.pollNow().catch(() => {}).finally(() => this.rearmPoll(Math.max(30, this.options.pollIntervalSec) * 1e3));
		}, delayMs);
	}
	/**
	* One poll cycle: enumerate routes, resolve credentials, probe.
	* A call while a cycle is already running joins that cycle instead of
	* returning immediately, so a manual refresh always waits for real probes.
	*/
	pollNow() {
		if (this.pollInFlight) return this.pollPromise ?? Promise.resolve();
		if (this.disposed) return Promise.resolve();
		this.pollInFlight = true;
		const cycle = (async () => {
			try {
				this.pruneIfNeeded();
				const routes = this.listProviderRoutes();
				const seen = /* @__PURE__ */ new Set();
				for (const route of routes) {
					if (this.disposed) return;
					seen.add(route.id);
					const adapter = adapterFor(route.id);
					if (adapter === void 0 || adapter.balance === void 0 && adapter.plan === void 0) continue;
					await this.probeRoute(route, adapter);
				}
				for (const id of [...this.snapshots.keys()]) if (!seen.has(id)) this.snapshots.delete(id);
				if (this.disposed) return;
				this.accrueDeepSeekSpend();
				await this.persistSnapshots();
			} finally {
				this.pollInFlight = false;
				this.pollPromise = void 0;
			}
		})();
		this.pollPromise = cycle;
		return cycle;
	}
	/**
	* Every route the service probes and renders: the runtime's live providers
	* plus the configurable directory's catalog entries, then alias-folded so a
	* dormant catalog entry cannot shadow the live route of the same adapter
	* family (see foldAliasRoutes).
	*/
	listProviderRoutes() {
		const routes = /* @__PURE__ */ new Map();
		const runtime = service(this.ctx, "llm");
		if (runtime !== void 0) try {
			for (const provider of runtime.listProviders()) if (provider.id !== "") routes.set(provider.id, {
				id: provider.id,
				displayName: provider.name,
				live: true
			});
			for (const provider of runtime.listConfigurableProviders()) if (!routes.has(provider.provider)) routes.set(provider.provider, {
				id: provider.provider,
				displayName: provider.displayName,
				live: false
			});
		} catch {}
		return foldAliasRoutes([...routes.values()]);
	}
	async probeRoute(route, adapter) {
		const credential = await this.resolveCredential(route.id);
		const previous = this.snapshots.get(route.id);
		const balanceApplies = balanceAppliesToRoute(adapter, this.routeBaseUrl(route.id));
		if (credential.key === void 0) {
			this.snapshots.set(route.id, {
				provider: route.id,
				displayName: route.displayName || adapter.displayName,
				credential: credential.kind,
				supported: true,
				updatedAt: Date.now()
			});
			return;
		}
		const snapshot = {
			provider: route.id,
			displayName: route.displayName || adapter.displayName,
			credential: credential.kind,
			supported: true,
			...adapter.balance !== void 0 && !balanceApplies ? { balanceSupported: false } : {},
			updatedAt: Date.now()
		};
		const runProbe = async (kind) => {
			const half = adapter[kind];
			if (half === void 0) return void 0;
			if (kind === "balance" && !balanceApplies) return void 0;
			try {
				const spec = half.build({
					apiKey: credential.key,
					...credential.accountId !== void 0 ? { accountId: credential.accountId } : {}
				});
				const response = await fetch(spec.url, withIdentityEncoding({
					headers: spec.headers,
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
				}));
				const body = await response.json().catch(() => void 0);
				if (!response.ok) throw new Error(providerErrorMessage(response.status, body));
				const parsed = half.parse(response.status, body);
				if (parsed === void 0) throw new Error("unrecognized response shape");
				const updatedAt = Date.now();
				if (kind === "balance") {
					const fact = parsed;
					return {
						currency: fact.currency,
						totalBalance: fact.totalBalance,
						updatedAt
					};
				}
				const plan = parsed;
				return {
					planName: plan.planName,
					windows: plan.windows,
					updatedAt
				};
			} catch (error) {
				const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
				if (kind === "balance") snapshot.balanceError = message;
				else snapshot.planError = message;
				return;
			}
		};
		const balance = await runProbe("balance");
		if (balance !== void 0) snapshot.balance = balance;
		else if (previous?.balance !== void 0) snapshot.balance = previous.balance;
		const plan = await runProbe("plan");
		if (plan !== void 0) snapshot.plan = plan;
		else if (previous?.plan !== void 0) snapshot.plan = previous.plan;
		this.snapshots.set(route.id, snapshot);
	}
	/**
	* Resolve the credential backing one route: pi-ai credential records
	* first, then the profile's apiKeyEnv reference, then the DeepSeek
	* official adapter's env reference. OAuth grants hand their stored access
	* token to the oauth-aware adapters (Codex plan quota); a stale token
	* fails its probe with a 401 and refreshes the next time the harness
	* itself runs that provider.
	*/
	async resolveCredential(provider) {
		const credentials = service(this.ctx, "credentials");
		if (credentials === void 0) return { kind: "none" };
		try {
			const record = await credentials.readRecord(credentialKey("llm-pi-ai", provider));
			if (record?.kind === "api-key" && typeof record.key === "string" && record.key !== "") return {
				kind: "api-key",
				key: record.key
			};
			if (record?.kind === "grant" && typeof record.payload === "object" && record.payload !== null) {
				const payload = record.payload;
				const access = typeof payload.access === "string" && payload.access !== "" ? payload.access : void 0;
				const accountId = typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id !== "" ? payload.chatgpt_account_id : void 0;
				if (access !== void 0) return {
					kind: "oauth",
					key: access,
					...accountId !== void 0 ? { accountId } : {}
				};
				return { kind: "oauth" };
			}
		} catch {}
		try {
			const envName = this.piAiProfile(provider)?.apiKeyEnv ?? (isDeepSeekProviderRoute(provider) ? this.deepseekApiKeyEnv() : void 0);
			if (typeof envName === "string" && envName !== "") {
				const resolved = await credentials.resolve(credentialRef(envName));
				if (resolved?.value !== void 0 && resolved.value !== "") return {
					kind: "env",
					key: resolved.value
				};
			}
		} catch {}
		return { kind: "none" };
	}
	/** The llm-pi-ai profile object for one provider route, when configured. */
	piAiProfile(provider) {
		return readNamespace(this.ctx, "llm-pi-ai")?.providers?.[provider];
	}
	/** The DeepSeek official adapter's credential reference name. */
	deepseekApiKeyEnv() {
		return readNamespace(this.ctx, "llm-deepseek")?.apiKeyEnv ?? "DEEPSEEK_API_KEY";
	}
	/** The DeepSeek official adapter's configured baseURL. */
	deepseekBaseUrl() {
		return readNamespace(this.ctx, "llm-deepseek")?.baseURL;
	}
	/** The effective base URL for a provider route (pi-ai or deepseek). */
	routeBaseUrl(provider) {
		return this.piAiProfile(provider)?.baseURL ?? (isDeepSeekProviderRoute(provider) ? this.deepseekBaseUrl() : void 0);
	}
};
//#endregion
//#region src/host/loopback.ts
/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
/**
* Whether a reverse proxy stood between the client and this host: the request
* carries CF-Connecting-IP or X-Forwarded-For. Either header is stamped by a
* hop that forwards traffic, so the request did not originate on this machine.
* @param request - node HTTP request.
* @returns true when a forwarding header is present.
*/
function isProxiedRequest(request) {
	return request.headers["cf-connecting-ip"] !== void 0 || request.headers["x-forwarded-for"] !== void 0;
}
/**
* Request-level trust fence: a loopback socket address AND a loopback Host
* header, plus browser same-origin markers. The socket address is
* authoritative for a direct connection; a request that carries a forwarding
* header is refused outright, because a proxy in front of the host makes both
* the socket address and the Host header describe the proxy rather than the
* client. X-Forwarded-For is therefore never evidence *for* loopback.
*/
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	if (isProxiedRequest(request)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/host/pair-access.ts
/**
* Whether this request may enter the plugin's host routes.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param request - the incoming HTTP request.
* @returns true for loopback, or a live paired-device cookie.
*/
function isPairedOrLoopbackAllowed(ctx, request) {
	if (isLoopbackRequest(request)) return true;
	const fromGet = typeof ctx.get === "function" ? ctx.get("remoteWebUiPairing", false) : void 0;
	return (isPairingAccess(fromGet) ? fromGet : ctx.remoteWebUiPairing)?.isPairedDevice(request) === true;
}
function isPairingAccess(value) {
	return value !== void 0 && value !== null && typeof value.isPairedDevice === "function";
}
//#endregion
//#region src/host/access.ts
/**
* Whether this request may read the usage overview or trigger a refresh.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param request - the incoming HTTP request.
* @returns true for loopback, or a live paired-device cookie.
*/
function isUsageAllowed(ctx, request) {
	return isPairedOrLoopbackAllowed(ctx, request);
}
//#endregion
//#region src/host/routes.ts
/**
* Overview route: provider balances, plan quotas, and token usage totals.
* Personal account data behind the family trust fence — loopback always
* passes, and a live paired-device cookie passes too when remote-web-ui is
* loaded (issue #1592: the sidebar usage panel reads this from a paired LAN
* browser); every unpaired LAN request keeps its 403.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param service - the usage service.
* @returns the route.
*/
function makeUsageOverviewRoute(ctx, service) {
	return {
		kind: "exact",
		path: "/api/dsh-usage/overview",
		handler: async (req, res) => {
			if (!isUsageAllowed(ctx, req)) {
				writeJson(res, 403, {
					ok: false,
					error: "forbidden: loopback-only"
				});
				return;
			}
			writeJson(res, 200, service.overview(), { "cache-control": "no-store" });
		}
	};
}
/**
* One retained day route: `GET /api/dsh-usage/day?date=YYYY-MM-DD` answers
* that local day's per-provider and per-model totals, so the section's day
* pickers can show a past day instead of only today. Same trust fence as the
* overview route, and a key that is not a real local date is refused with 400
* rather than folded into a bogus day.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param service - the usage service.
* @returns the route.
*/
function makeUsageDayRoute(ctx, service) {
	return {
		kind: "exact",
		path: "/api/dsh-usage/day",
		handler: (req, res) => {
			if (!isUsageAllowed(ctx, req)) {
				writeJson(res, 403, {
					ok: false,
					error: "forbidden: loopback-only"
				});
				return;
			}
			const date = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("date") ?? "";
			if (!isLedgerDateKey(date)) {
				writeJson(res, 400, {
					ok: false,
					error: "date must be YYYY-MM-DD"
				});
				return;
			}
			writeJson(res, 200, {
				ok: true,
				day: service.day(date)
			}, { "cache-control": "no-store" });
		}
	};
}
/**
* One window-aggregate route: `GET /api/dsh-usage/range?from=YYYY-MM-DD&to=YYYY-MM-DD`
* answers the whole-window summary (per-provider, per-model breakdown) plus the
* per-day series the trend chart buckets, in ONE request. This is what makes
* the multi-month and multi-year windows viable — the per-day fetch path that
* the short windows use would cost one request per recorded day, which for a
* year-long window means hundreds of loopback round trips.
* Same trust fence as the overview route; a malformed or inverted range is
* refused with 400 rather than folded into a bogus span.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param service - the usage service.
* @returns the route.
*/
function makeUsageRangeRoute(ctx, service) {
	return {
		kind: "exact",
		path: "/api/dsh-usage/range",
		handler: (req, res) => {
			if (!isUsageAllowed(ctx, req)) {
				writeJson(res, 403, {
					ok: false,
					error: "forbidden: loopback-only"
				});
				return;
			}
			const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
			const from = query.get("from") ?? "";
			const to = query.get("to") ?? "";
			if (!isLedgerDateKey(from) || !isLedgerDateKey(to) || from > to) {
				writeJson(res, 400, {
					ok: false,
					error: "from and to must be YYYY-MM-DD dates with from <= to"
				});
				return;
			}
			writeJson(res, 200, {
				ok: true,
				...service.range(from, to)
			}, { "cache-control": "no-store" });
		}
	};
}
/**
* Manual refresh: forces one probe cycle now and answers with the fresh
* overview. Same trust fence as the overview route.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param service - the usage service.
* @returns the route.
*/
function makeUsageRefreshRoute(ctx, service) {
	return {
		kind: "exact",
		path: "/api/dsh-usage/refresh",
		handler: async (req, res) => {
			if (!isUsageAllowed(ctx, req)) {
				writeJson(res, 403, {
					ok: false,
					error: "forbidden: loopback-only"
				});
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			try {
				await service.refresh();
			} catch (error) {
				writeJson(res, 500, {
					ok: false,
					error: error instanceof Error ? error.message : "refresh failed"
				});
				return;
			}
			writeJson(res, 200, service.overview(), { "cache-control": "no-store" });
		}
	};
}
/**
* Ledger export: this device's own history as a portable JSON document.
*
* Only this machine's ledger is exported. Peers are already counted wherever
* their files exist, so exporting them too would make totals grow with every
* round trip — the one failure mode the per-device file layout exists to avoid.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param service - the usage service.
* @returns the route.
*/
function makeUsageExportRoute(ctx, service) {
	return {
		kind: "exact",
		path: "/api/dsh-usage/export",
		handler: (req, res) => {
			if (!isUsageAllowed(ctx, req)) {
				writeJson(res, 403, {
					ok: false,
					error: "forbidden: loopback-only"
				});
				return;
			}
			if (req.method !== "GET") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			const envelope = service.exportLedger();
			const body = JSON.stringify(envelope, null, 2);
			writeJson(res, 200, envelope, {
				"cache-control": "no-store",
				"content-disposition": `attachment; filename="dsh-usage-ledger-${envelope.deviceId}.json"`,
				"x-usage-export-bytes": String(Buffer.byteLength(body, "utf8"))
			});
		}
	};
}
/** Largest import body accepted, mirroring the service's own guard. */
const IMPORT_MAX_BYTES = 8388608;
/**
* Read a request body with a hard byte cap.
*
* The cap is enforced while streaming, not after: an oversized upload must not
* be buffered into memory before being rejected.
*/
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(/* @__PURE__ */ new Error(`body exceeds ${limit} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/**
* Ledger import: install another device's export as that device's file.
*
* Replaces the peer's file (keyed by the device id inside the document) rather
* than merging numbers, so importing the same file twice is a no-op. Never
* touches this device's own ledger, which is what makes "restore without
* overwriting my data" true by construction rather than by policy.
* @param ctx - host context; may expose remoteWebUiPairing.
* @param service - the usage service.
* @returns the route.
*/
function makeUsageImportRoute(ctx, service) {
	return {
		kind: "exact",
		path: "/api/dsh-usage/import",
		handler: async (req, res) => {
			if (!isUsageAllowed(ctx, req)) {
				writeJson(res, 403, {
					ok: false,
					error: "forbidden: loopback-only"
				});
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, {
					ok: false,
					error: "method not allowed"
				});
				return;
			}
			let body;
			try {
				body = await readBody(req, IMPORT_MAX_BYTES);
			} catch (error) {
				writeJson(res, 413, {
					ok: false,
					error: error instanceof Error ? error.message : "unreadable body"
				});
				return;
			}
			try {
				writeJson(res, 200, {
					ok: true,
					deviceId: (await service.importPeer(body)).deviceId,
					devices: service.overview().usage.devices ?? []
				});
			} catch (error) {
				if (error instanceof UsageImportError) {
					writeJson(res, 400, {
						ok: false,
						error: error.message
					});
					return;
				}
				writeJson(res, 500, {
					ok: false,
					error: error instanceof Error ? error.message : "import failed"
				});
			}
		}
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-usage";
const inject = ["webServer"];
/**
* Family settings namespace this row serves. Since 0.1.7 the settings surface
* addresses one form per profile entry id and the Host generates this row's
* page from the Config schema below, so the namespace is only the alias the
* family settings bridge (dsh-web-settings) resolves onto this row's entry id.
*/
const USAGE_SETTINGS_NAMESPACE = "dsh-usage";
/**
* Plugin config schema. Under the 0.1.7 settings model this schema IS the
* entry's settings page: the Host derives one form per profile entry from it
* and serves it only when at least one field is `volatile()`. The marker is
* also what admits a write and what keeps the edit on the live path — the
* Loader commits the new value into the field's reference and announces
* `loader/volatile-update` on this fiber instead of remounting the row, so the
* probe cycle, its ledger and its route registrations survive a settings save.
*
* The schema is left to inference rather than annotated with
* `z<UsageConfigFields>`: a volatile field's parsed output is a reference while
* its accepted input stays the plain value, so the two sides no longer share
* one shape and the annotation would reject the schema the Host must be given.
*/
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	pollIntervalSec: z.number().min(30).max(3600).default(60).volatile(),
	retainDays: z.number().min(7).max(730).default(180).volatile()
});
/** Read one config field, following the live reference the schema produces. */
function readConfigField(field) {
	if (field === void 0) return void 0;
	if (typeof field === "object" && field !== null && typeof field.get === "function") return field.get();
	return field;
}
/** Read one numeric field, falling back when the value is absent or not a usable number. */
function readNumber(field, fallback) {
	const value = readConfigField(field);
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/**
* Resolve the effective settings of one activation. Volatile references are
* read here, so every re-arm observes the latest committed values rather than
* whatever the row was activated with.
* @param config - the config the Host passed to the activation.
* @returns the resolved settings.
*/
function resolveConfig(config) {
	return {
		enabled: readConfigField(config?.enabled) ?? true,
		pollIntervalSec: readNumber(config?.pollIntervalSec, 60),
		retainDays: readNumber(config?.retainDays, 180)
	};
}
/**
* Tail of the process-wide flush chain; undefined while no predecessor's final
* ledger flush is still in flight. The Host reloads this profile row when its
* configuration changes, so a successor activation is a dispose + apply pair in
* the same process: its first ledger load must serialize behind its
* predecessor's final write (and behind the reloads before that one).
*/
let pendingStop;
/**
* Host body. The plugin's own Config schema above is the settings document the
* 0.1.7 Host serves for this row; the effective config arrives here as the
* `config` argument, and a settings save re-enters this body through the
* volatile path rather than a row reload (see {@link Config}).
* @param ctx - host root context.
* @param config - the row's resolved configuration.
*/
const apply = mountOnce("@linxin666/dsh-usage", (ctx, config) => {
	let live = true;
	let service;
	let disposeRoutes;
	/** True while this activation has a start queued behind a predecessor's flush. */
	let queued = false;
	/** Register the service's routes; the returned disposer unregisters them. */
	const mountRoutes = (next) => {
		const disposers = [
			makeUsageOverviewRoute(ctx, next),
			makeUsageDayRoute(ctx, next),
			makeUsageRefreshRoute(ctx, next),
			makeUsageRangeRoute(ctx, next),
			makeUsageExportRoute(ctx, next),
			makeUsageImportRoute(ctx, next)
		].map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) try {
				dispose();
			} catch {}
		};
	};
	/** Start a fresh activation, unless this fiber is down or one already runs. */
	const launch = () => {
		queued = false;
		if (!live || service !== void 0) return;
		const value = resolveConfig(config);
		if (!value.enabled) return;
		const next = new UsageService(ctx, value);
		service = next;
		next.start();
		disposeRoutes = mountRoutes(next);
	};
	/** Tear the running activation down, chaining its final flush for any successor. */
	const stop = () => {
		disposeRoutes?.();
		disposeRoutes = void 0;
		const stopping = service?.stop();
		service = void 0;
		if (stopping !== void 0) pendingStop = (pendingStop ?? Promise.resolve()).then(() => stopping);
	};
	/**
	* Apply the activation's current settings: a disabled row mounts nothing (no
	* probe cycle, no ledger, no routes), an enabled one starts on first use and
	* otherwise re-applies its options in place.
	*/
	const rearm = () => {
		const value = resolveConfig(config);
		if (!value.enabled) {
			queued = false;
			stop();
			return;
		}
		if (service !== void 0) {
			service.applyOptions(value);
			return;
		}
		if (queued) return;
		if (pendingStop === void 0) {
			launch();
			return;
		}
		queued = true;
		pendingStop = pendingStop.then(launch, launch).then(() => void 0);
	};
	ctx.on("loader/volatile-update", () => {
		rearm();
	});
	ctx.effect(() => {
		rearm();
		return () => {
			live = false;
			queued = false;
			stop();
		};
	}, "dsh-usage: runtime");
});
//#endregion
export { Config, USAGE_SETTINGS_NAMESPACE, apply, inject, name, resolveConfig };
