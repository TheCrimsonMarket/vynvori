"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { AccountDetails } from "./account-details";

type Status = "checking" | "signed-in" | "signed-out" | "unavailable";
async function authPost(path: string, payload: Record<string, unknown>): Promise<Response> {
  const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" });
  const data: unknown = await csrfResponse.json();
  if (!csrfResponse.ok || !data || typeof data !== "object" || !("csrfToken" in data) || typeof data.csrfToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)) throw new Error("Account services unavailable");
  return fetch(path, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json", "x-vynvori-csrf": data.csrfToken }, body: JSON.stringify(payload) });
}
async function sessionStatus(): Promise<Status> {
  try {
    let response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 401) {
      const value = await response.clone().json();
      if (value?.error?.code === "AUTH_RENEW_REQUIRED") {
        // One deliberate renewal; uncertain rotations are never automatically retried.
        const renewed = await authPost("/api/auth/tcm/refresh", {});
        response = renewed.ok ? await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" }) : renewed;
      }
    }
    if (response.ok) return (await response.json())?.authenticated === true ? "signed-in" : "unavailable";
    return response.status === 401 ? "signed-out" : "unavailable";
  } catch { return "unavailable"; }
}
export function AuthPanel() {
  const [status, setStatus] = useState<Status>("checking"), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const mounted = useRef(false), checking = useRef(false), operation = useRef(false), revision = useRef(0);
  const sessionExpired = useCallback(() => { revision.current++; setStatus("signed-out"); setNotice("Your session needs to be renewed. Please sign in again."); }, []);
  const load = useCallback(async () => {
    if (checking.current || operation.current) return;
    checking.current = true;
    const started = ++revision.current;
    try {
      const result = await sessionStatus();
      if (mounted.current && revision.current === started) setStatus(result);
    }
    finally { checking.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!checking.current) {
      checking.current = true; const started = ++revision.current;
      void sessionStatus().then(result => { if (mounted.current && revision.current === started) setStatus(result); }).finally(() => { checking.current = false; });
    }
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  async function signIn() {
    operation.current = true; revision.current++;
    setBusy(true); setNotice("");
    try {
      const response = await authPost("/api/auth/tcm/start", { returnPath: "/account" });
      const data = await response.json();
      if (!response.ok || typeof data?.authorizeUrl !== "string") throw new Error();
      const url = new URL(data.authorizeUrl);
      if (url.origin !== "https://dev.portal.raum.au" || url.pathname !== "/oauth/authorize") throw new Error();
      window.location.assign(url.toString());
    } catch { setNotice("Sign-in is temporarily unavailable. Please try again."); setBusy(false); operation.current = false; }
  }
  async function signOut() {
    operation.current = true; revision.current++;
    setBusy(true); setNotice("");
    try {
      const response = await authPost("/api/auth/logout", {}), result = await response.json();
      if (!response.ok || result?.localRevoked !== true) throw new Error();
      setStatus("signed-out");
      setNotice(result.upstream === "confirmed" ? "Signed out of VYNVORI." : "You are signed out here. Some connected access may take longer to close.");
    } catch { setNotice("We could not confirm sign-out. Please try again."); }
    finally { setBusy(false); operation.current = false; }
  }
  return <div aria-busy={status === "checking" || busy}>
    <p className="lede" role="status" aria-live="polite">{status === "checking" ? "Checking your session…" : status === "signed-in" ? "You are signed in to VYNVORI." : status === "signed-out" ? "Sign in with your TCM account to continue." : "Account services are temporarily unavailable."}</p>
    {notice && <p role="status" aria-live="polite">{notice}</p>}
    {status === "signed-in" && !busy && <AccountDetails post={authPost} onSessionExpired={sessionExpired} />}
    {status === "signed-in" ? <Button variant="outline" disabled={busy} onClick={() => void signOut()}>{busy ? "Signing out…" : "Sign out"}</Button>
      : status === "signed-out" ? <Button disabled={busy} onClick={() => void signIn()}>{busy ? "Opening sign-in…" : "Continue with TCM"}</Button>
      : status === "unavailable" ? <Button variant="outline" disabled={busy} onClick={() => void load()}>Try again</Button> : null}
    <p>Purchasing and paid creation remain unavailable.</p>
  </div>;
}
