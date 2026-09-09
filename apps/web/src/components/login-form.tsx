"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        setError("That email and password combination did not work.");
        return;
      }

      router.replace("/");
    } catch {
      setError("We could not reach the control plane. Try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="foundry-login-page">
      <aside className="foundry-login-aside">
        <div className="foundry-brand">
          <div className="foundry-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="foundry-brand-name">Foundry One</p>
            <p className="foundry-brand-kicker">Control plane</p>
          </div>
        </div>
        <div className="foundry-login-statement">
          <p className="foundry-overline">A quieter way to run the backend</p>
          <h1>See the whole estate. Keep the signal.</h1>
          <p>Foundry One gives your team one clear room for the systems behind the product.</p>
        </div>
        <p className="foundry-login-aside-note">
          Provider-neutral by design. Built for the people who keep software alive.
        </p>
      </aside>
      <section className="foundry-login-content">
        <div className="foundry-login-card">
          <div className="foundry-login-copy">
            <p className="foundry-card-eyebrow">Welcome back</p>
            <h2>Enter the control plane.</h2>
            <p>Sign in to continue to your workspace.</p>
          </div>
          <form onSubmit={handleSubmit}>
            <label htmlFor="email">
              Work email
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label htmlFor="password">
              Password
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
              />
            </label>
            {error ? (
              <p className="foundry-form-error" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="foundry-button foundry-button-primary foundry-login-button"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Opening workspace…" : "Sign in"}
              <span className="foundry-button-arrow">↗</span>
            </button>
          </form>
          <p className="foundry-login-footnote">
            Your workspace is protected by Foundry identity and server-side authorization.
          </p>
          <p className="foundry-auth-switch">
            New to Foundry One? <Link href="/register">Create an account</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
