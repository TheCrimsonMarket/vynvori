"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

type Profile = { email: string | null; firstName: string | null; lastName: string | null };
type Order = { id: string; status: string; createdAt: string };
type View = "loading" | "ready" | "setup" | "pending" | "conflict" | "contact" | "unavailable";
type Props = { post: (path: string, body: Record<string, unknown>) => Promise<Response>; onSessionExpired: () => void };

/** Uses the application's cookie boundary; customer/service tokens stay server-side. */
export function AccountDetails({ post, onSessionExpired }: Props) {
  const [view, setView] = useState<View>("loading"), [profile, setProfile] = useState<Profile | null>(null);
  const [orders, setOrders] = useState<Order[]>([]), [hasMore, setHasMore] = useState(false), [busy, setBusy] = useState(false);
  const mounted = useRef(false), revision = useRef(0), operation = useRef(false);
  const load = useCallback(async () => {
    const ticket = ++revision.current;
    const current = () => mounted.current && ticket === revision.current;
    try {
      const response = await fetch("/api/account/profile", { credentials: "same-origin", cache: "no-store" });
      const value = await response.json();
      if (!current()) return;
      if (response.status === 401) { onSessionExpired(); return; }
      if (!response.ok) { setProfile(null); setOrders([]); setView(value?.error?.code === "AUTH_COMMERCE_SETUP_REQUIRED" ? "setup" : "unavailable"); return; }
      const p: unknown = value?.profile;
      if (!p || typeof p !== "object" || !["email", "firstName", "lastName"].every(key => key in p && (p[key as keyof typeof p] === null || typeof p[key as keyof typeof p] === "string"))) throw new Error();
      // No identifiers or arbitrary server fields are retained in profile state.
      const contact = p as Profile;
      setProfile({ email: contact.email, firstName: contact.firstName, lastName: contact.lastName });
      const orderResponse = await fetch("/api/account/orders", { credentials: "same-origin", cache: "no-store" });
      const result = await orderResponse.json();
      if (!current()) return;
      if (orderResponse.status === 401) { onSessionExpired(); return; }
      if (!orderResponse.ok || !Array.isArray(result?.orders) || result.orders.length > 50 || typeof result.hasMore !== "boolean" ||
          !result.orders.every((row: Order) => row && typeof row.id === "string" && typeof row.status === "string" && typeof row.createdAt === "string")) throw new Error();
      setOrders(result.orders.map((row: Order) => ({ id: row.id, status: row.status, createdAt: row.createdAt })));
      setHasMore(result.hasMore); setView("ready");
    } catch { if (current()) { setProfile(null); setOrders([]); setView("unavailable"); } }
  }, [onSessionExpired]);
  useEffect(() => {
    mounted.current = true; const requests = revision;
    void Promise.resolve().then(() => { if (mounted.current) return load(); });
    return () => { mounted.current = false; requests.current++; };
  }, [load]);

  async function prepare(action: "ensure" | "reconcile") {
    if (operation.current) return;
    operation.current = true; const ticket = ++revision.current; setBusy(true);
    try {
      const response = await post("/api/auth/commerce", { action }), result = await response.json();
      if (!mounted.current || ticket !== revision.current) return;
      if (response.status === 401) { onSessionExpired(); return; }
      if (response.ok && result?.state === "ready") { await load(); return; }
      if (response.status === 202 && result?.state === "reconcile_required") setView("pending");
      else if (response.status === 409 && result?.state === "conflict") setView("conflict");
      else if (result?.error?.code === "AUTH_CONTACT_REQUIRED") setView("contact");
      else setView("unavailable");
    } catch { if (mounted.current && ticket === revision.current) setView("pending"); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Account details" aria-busy={view === "loading" || busy}>
    <h2>Your details</h2>
    <div role="status" aria-live="polite">
      {view === "loading" && <p>Loading your account…</p>}
      {view === "setup" && <p>Set up your shopping profile to view your account details.</p>}
      {view === "pending" && <p>Your profile setup needs a status check. You can check it without starting another setup.</p>}
      {view === "conflict" && <p>We could not safely connect your shopping profile. Please contact support.</p>}
      {view === "contact" && <p>Add a contact email to your TCM account, then try again. Your sign-in remains active.</p>}
      {view === "unavailable" && <p>Your account details are temporarily unavailable.</p>}
    </div>
    {view === "ready" && profile && <>
      <p>{[profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Your shopping profile"}</p>
      {profile.email && <p>{profile.email}</p>}
      <h2>Recent orders</h2>
      {orders.length ? <ul>{orders.map(order => <li key={order.id}>{order.id} — {order.status}</li>)}</ul> : <p>You have no orders yet.</p>}
      {hasMore && <p>Showing your 50 most recent orders.</p>}
    </>}
    {(view === "setup" || view === "contact") && <Button disabled={busy} onClick={() => void prepare("ensure")}>{busy ? "Setting up…" : "Set up shopping profile"}</Button>}
    {view === "pending" && <Button variant="outline" disabled={busy} onClick={() => void prepare("reconcile")}>{busy ? "Checking…" : "Check setup status"}</Button>}
    {(view === "ready" || view === "unavailable") && <Button variant="outline" disabled={busy} onClick={() => void load()}>Reload details</Button>}
  </section>;
}
