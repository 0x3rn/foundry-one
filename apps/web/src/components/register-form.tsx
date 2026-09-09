"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

interface AuthErrorBody {
  readonly message?: string;
  readonly error?: { readonly message?: string };
}

function getAuthError(body: AuthErrorBody | null): string {
  return body?.error?.message ?? body?.message ?? "We could not create your account.";
}

export function RegisterForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      setError("Enter your name to continue.");
      return;
    }

    if (password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail, password }),
      });

      const body = (await response.json().catch(() => null)) as AuthErrorBody | null;
      if (!response.ok) {
        setError(getAuthError(body));
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
          <h1>Start with a clear room.</h1>
          <p>Bring the systems behind your product into one calm, observable workspace.</p>
        </div>
        <p className="foundry-login-aside-note">
          Provider-neutral by design. Built for the people who keep software alive.
        </p>
      </aside>
      <section className="foundry-login-content">
        <div className="foundry-login-card">
          <div className="foundry-login-copy">
            <p className="foundry-card-eyebrow">First, make it yours</p>
            <h2>Create your account.</h2>
            <p>Set up your Foundry identity, then connect your first backend.</p>
          </div>
          <form onSubmit={handleSubmit}>
            <label htmlFor="name">
              Name
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
              />
            </label>
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
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
              />
            </label>
            <label htmlFor="confirm-password">
              Confirm password
              <input
                id="confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
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
              {isSubmitting ? "Creating workspace access…" : "Create account"}
              <span className="foundry-button-arrow">↗</span>
            </button>
          </form>
          <p className="foundry-login-footnote">
            Your password is handled by Foundry identity and is never shown in the workspace.
          </p>
          <p className="foundry-auth-switch">
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
