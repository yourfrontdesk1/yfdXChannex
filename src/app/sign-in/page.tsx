"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "That password was not right");
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h2>Sign in</h2>
      <p className="lede">
        This service writes rates and availability straight through to the
        channel manager, so it is not left open.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="password" style={{ display: "block", marginBottom: 6 }}>
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: "8px 10px", marginBottom: 12 }}
        />
        {error ? (
          <p style={{ color: "#ff6b6b", marginBottom: 12 }} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function SignIn() {
  return (
    <Suspense fallback={<div className="card">Loading</div>}>
      <SignInForm />
    </Suspense>
  );
}
