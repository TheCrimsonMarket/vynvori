import "server-only";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { opaqueAuthSecret } from "./auth-vault";
import { AuthSessionError, type authSessionService } from "./auth-sessions";
import { LoginTransactionError, type loginTransactions } from "./login-transactions";

export const authCookies = Object.freeze({ session: "__Host-vynvori_session", transaction: "__Host-vynvori_login", csrf: "__Host-vynvori_csrf" });
export class AuthHttpError extends Error { constructor(readonly status: number, readonly code: "INVALID_REQUEST" | "FORBIDDEN") { super(code); } }
type Config = Readonly<{ enabled: boolean; appOrigin: string }>;
type Sessions = Pick<ReturnType<typeof authSessionService>, "completeLogin" | "verify" | "refresh" | "logout" | "claimGuest" | "ensureCommerce" | "reconcileCommerce" | "customer">;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const messages: Record<string, string> = { INVALID_REQUEST: "Invalid authentication request.", FORBIDDEN: "This request is not permitted.", DISABLED: "Sign-in is unavailable.", REAUTH_REQUIRED: "Please sign in again.", RENEW_REQUIRED: "Your session needs renewal.", UNAVAILABLE: "Account services are temporarily unavailable.", CONTACT_REQUIRED: "Contact information is required to set up commerce.", INSUFFICIENT_SCOPE: "Required account permission was not granted.", COMMERCE_SETUP_REQUIRED: "Your account needs to be set up.", NOT_FOUND: "The requested resource was not found." };
function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.slice(0, part.indexOf("=")) === name);
  if (values.length > 1) throw new AuthHttpError(400, "INVALID_REQUEST");
  return values[0]?.slice(name.length + 1) ?? null;
}
function setCookie(name: string, value: string, maxAge: number, strict = false): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${strict ? "Strict" : "Lax"}; Max-Age=${maxAge}`;
}
function headers(): Headers { return new Headers({ "cache-control": "no-store, max-age=0", pragma: "no-cache", vary: "Cookie", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" }); }
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: headers() }); }
function failure(error: unknown): Response {
  let code = "UNAVAILABLE", status = 503;
  if (error instanceof AuthHttpError) { code = error.code; status = error.status; }
  if (error instanceof LoginTransactionError) { code = "REAUTH_REQUIRED"; status = 401; }
  if (error instanceof AuthSessionError) {
    code = error.code.toUpperCase();
    status = ["reauth_required", "renew_required"].includes(error.code) ? 401 : ["forbidden", "insufficient_scope"].includes(error.code) ? 403 : ["contact_required", "commerce_setup_required"].includes(error.code) ? 409 : error.code === "not_found" ? 404 : 503;
  }
  return json({ error: { code: `AUTH_${code}`, message: messages[code] ?? messages.UNAVAILABLE, retryable: code === "UNAVAILABLE", correlationId: randomUUID() } }, status);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !request.body) throw new AuthHttpError(400, "INVALID_REQUEST");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AuthHttpError(400, "INVALID_REQUEST")), 3000); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.length;
      if (size > 2048) throw new AuthHttpError(400, "INVALID_REQUEST");
      chunks.push(part.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new AuthHttpError(400, "INVALID_REQUEST"); }
  finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
function exactFields(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new AuthHttpError(400, "INVALID_REQUEST"); }

/** Framework-independent HTTP boundary, used directly by the Node Next route wrappers. */
export function authHttpHandlers(input: Config, sessions?: Sessions, transactions?: Pick<ReturnType<typeof loginTransactions>, "begin" | "consume">, now = Date.now) {
  const config = Object.freeze({ ...input });
  if (config.enabled) {
    const url = new URL(config.appOrigin);
    if (url.protocol !== "https:" || url.origin !== config.appOrigin) throw new Error("Invalid auth HTTP origin");
    if (!sessions || !transactions) throw new Error("Authentication dependencies missing");
  }
  function guard(request: Request, method: string, path: string, callback = false) {
    if (!config.enabled) throw new AuthSessionError("disabled");
    const url = new URL(request.url);
    if (request.method !== method || url.origin !== config.appOrigin || url.pathname !== path || (!callback && url.search)) throw new AuthHttpError(400, "INVALID_REQUEST");
    if (method === "POST") {
      if (request.headers.get("origin") !== config.appOrigin || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) throw new AuthHttpError(403, "FORBIDDEN");
      const supplied = request.headers.get("x-vynvori-csrf"), stored = cookie(request, authCookies.csrf);
      if (!supplied || !stored || !opaque.test(supplied) || !opaque.test(stored) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(stored))) throw new AuthHttpError(403, "FORBIDDEN");
    }
  }
  function sessionSecret(request: Request): string { const value = cookie(request, authCookies.session); if (!value || !opaque.test(value)) throw new AuthSessionError("reauth_required"); return value; }
  const wrapped = (handler: (request: Request) => Promise<Response>) => async (request: Request): Promise<Response> => { try { return await handler(request); } catch (error) { return failure(error); } };
  return Object.freeze({
    profile: wrapped(async request => {
      guard(request, "GET", "/api/account/profile");
      const data = await sessions!.customer(sessionSecret(request), { action: "read_customer" });
      if (data.kind !== "customer") throw new AuthSessionError("unavailable");
      return json({ profile: { email: data.customer.email, firstName: data.customer.firstName, lastName: data.customer.lastName } });
    }),
    orders: wrapped(async request => {
      guard(request, "GET", "/api/account/orders");
      const data = await sessions!.customer(sessionSecret(request), { action: "read_orders" });
      if (data.kind !== "orders") throw new AuthSessionError("unavailable");
      return json({ orders: data.orders, hasMore: data.hasMore });
    }),
    cart: wrapped(async request => {
      guard(request, "GET", "/api/account/cart", true); const url = new URL(request.url);
      if ([...url.searchParams.keys()].some(key => key !== "cartId") || url.searchParams.getAll("cartId").length !== 1 || !/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get("cartId") ?? "")) throw new AuthHttpError(400, "INVALID_REQUEST");
      const data = await sessions!.customer(sessionSecret(request), { action: "read_cart", resourceId: url.searchParams.get("cartId")! });
      if (data.kind !== "cart") throw new AuthSessionError("unavailable"); return json(data);
    }),
    csrf: wrapped(async request => {
      guard(request, "GET", "/api/auth/csrf");
      if (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") throw new AuthHttpError(403, "FORBIDDEN");
      const csrfToken = opaqueAuthSecret(), response = json({ csrfToken });
      response.headers.append("set-cookie", setCookie(authCookies.csrf, csrfToken, 1800, true)); return response;
    }),
    start: wrapped(async request => {
      guard(request, "POST", "/api/auth/tcm/start"); const data = await body(request); exactFields(data, ["returnPath"]);
      if (typeof data.returnPath !== "string" || !["/account", "/studio", "/customize"].includes(data.returnPath)) throw new AuthHttpError(400, "INVALID_REQUEST");
      const started = await transactions!.begin(data.returnPath);
      const response = json({ authorizeUrl: started.authorizeUrl }); response.headers.append("set-cookie", setCookie(authCookies.transaction, started.browserBinding, 600)); return response;
    }),
    callback: async (request: Request): Promise<Response> => {
      let response: Response;
      try {
        guard(request, "GET", "/auth/tcm/callback", true);
        const url = new URL(request.url);
        if (url.search.length > 4096 || [...url.searchParams.keys()].some(key => !["state", "code", "error", "error_description"].includes(key)) ||
            [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw new AuthHttpError(400, "INVALID_REQUEST");
        const state = url.searchParams.get("state"), browserBinding = cookie(request, authCookies.transaction);
        if (!state || !browserBinding) throw new AuthHttpError(400, "INVALID_REQUEST");
        const code = url.searchParams.get("code"), denied = url.searchParams.get("error");
        if (!!code === !!denied) throw new AuthHttpError(400, "INVALID_REQUEST");
        if (denied) {
          await transactions!.consume(state, browserBinding);
          response = new Response(null, { status: 303, headers: headers() }); response.headers.set("location", `${config.appOrigin}/account?auth=cancelled`);
        } else {
          const completed = await sessions!.completeLogin(state, browserBinding, code!);
          if (!["/account", "/studio", "/customize"].includes(completed.returnPath)) throw new AuthHttpError(400, "INVALID_REQUEST");
          const lifetime = Math.min(28800, Math.floor((completed.expiresAt - now()) / 1000)); if (lifetime < 1) throw new AuthSessionError("reauth_required");
          response = new Response(null, { status: 303, headers: headers() }); response.headers.set("location", config.appOrigin + completed.returnPath);
          response.headers.append("set-cookie", setCookie(authCookies.session, completed.cookieSecret, lifetime));
        }
      } catch (error) { response = failure(error); }
      // Every callback outcome ends this browser transaction. Persisted consumption independently prevents replay.
      response.headers.append("set-cookie", setCookie(authCookies.transaction, "", 0)); return response;
    },
    session: wrapped(async request => { guard(request, "GET", "/api/auth/session"); await sessions!.verify(sessionSecret(request)); return json({ authenticated: true }); }),
    refresh: wrapped(async request => { guard(request, "POST", "/api/auth/tcm/refresh"); const data = await body(request); exactFields(data, []); await sessions!.refresh(sessionSecret(request)); return json({ authenticated: true }); }),
    logout: wrapped(async request => {
      guard(request, "POST", "/api/auth/logout"); const data = await body(request); exactFields(data, []);
      const result = await sessions!.logout(sessionSecret(request)), response = json(result);
      response.headers.append("set-cookie", setCookie(authCookies.session, "", 0)); response.headers.append("set-cookie", setCookie(authCookies.csrf, "", 0, true)); return response;
    }),
    commerce: wrapped(async request => {
      guard(request, "POST", "/api/auth/commerce"); const data = await body(request); exactFields(data, ["action"]);
      if (!["ensure", "reconcile"].includes(String(data.action))) throw new AuthHttpError(400, "INVALID_REQUEST");
      const result = await (data.action === "ensure" ? sessions!.ensureCommerce(sessionSecret(request)) : sessions!.reconcileCommerce(sessionSecret(request)));
      return json({ state: result.state }, result.state === "conflict" ? 409 : result.state === "reconcile_required" ? 202 : result.state === "unavailable" ? 503 : 200);
    }),
    claimGuest: wrapped(async request => {
      guard(request, "POST", "/api/auth/guest/claim"); const data = await body(request); exactFields(data, ["draftId", "capability"]);
      if (typeof data.draftId !== "string" || typeof data.capability !== "string") throw new AuthHttpError(400, "INVALID_REQUEST");
      await sessions!.claimGuest(sessionSecret(request), data.draftId, data.capability); return json({ claimed: true });
    }),
  });
}
