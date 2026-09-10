"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

interface SupabaseConnectionWizardProps {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly connectionId?: string;
  readonly onClose: () => void;
}

export function SupabaseConnectionWizard({
  workspaceId,
  projectId,
  connectionId,
  onClose,
}: SupabaseConnectionWizardProps) {
  const router = useRouter();
  const [projectName, setProjectName] = useState("");
  const [connectionName, setConnectionName] = useState("Primary Supabase");
  const [projectUrl, setProjectUrl] = useState("");
  const [serviceRoleKey, setServiceRoleKey] = useState("");
  const [managementApiToken, setManagementApiToken] = useState("");
  const [managementApiTokenExpiresAt, setManagementApiTokenExpiresAt] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (managementApiToken && !managementApiTokenExpiresAt) {
      setError(
        "Add the management API token expiry date so Foundry can remind you before it expires.",
      );
      return;
    }
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/provider-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          ...(connectionId ? { connectionId } : {}),
          ...(projectId ? { projectId } : { projectName }),
          name: connectionName,
          projectUrl,
          serviceRoleKey,
          ...(managementApiToken ? { managementApiToken } : {}),
          ...(managementApiTokenExpiresAt
            ? {
                managementApiTokenExpiresAt: new Date(
                  `${managementApiTokenExpiresAt}T23:59:59.999`,
                ).toISOString(),
              }
            : {}),
          ...(databaseUrl ? { databaseUrl } : {}),
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setError(body.error?.message ?? "We could not connect that Supabase project.");
        return;
      }

      setServiceRoleKey("");
      setManagementApiToken("");
      setManagementApiTokenExpiresAt("");
      setDatabaseUrl("");
      router.refresh();
      onClose();
    } catch {
      setError("We could not reach the control plane. Try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="foundry-wizard-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="foundry-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="supabase-wizard-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="foundry-wizard-header">
          <div>
            <p className="foundry-card-eyebrow">
              01 / {connectionId ? "renew a connection" : "connect a backend"}
            </p>
            <h2 id="supabase-wizard-title">
              {connectionId
                ? "Keep the Supabase connection alive."
                : "Bring Supabase into the room."}
            </h2>
            <p>
              {connectionId
                ? "Paste the replacement credentials from Supabase. Foundry checks them server-side and keeps the keys encrypted."
                : "Foundry checks the project server-side, keeps the keys encrypted, and only brings back the connection state."}
            </p>
          </div>
          <button
            className="foundry-icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form className="foundry-wizard-form" onSubmit={handleSubmit}>
          {!projectId ? (
            <label>
              Project name
              <input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Marketing site"
                required
                autoFocus
              />
              <small>This creates the first project in your current workspace.</small>
            </label>
          ) : null}
          <label>
            Connection name
            <input
              value={connectionName}
              onChange={(event) => setConnectionName(event.target.value)}
              placeholder="Primary Supabase"
              required
            />
          </label>
          <label>
            Project URL
            <input
              type="url"
              value={projectUrl}
              onChange={(event) => setProjectUrl(event.target.value)}
              placeholder="https://your-project.supabase.co"
              spellCheck={false}
              required
            />
          </label>
          <label>
            Service-role key
            <input
              type="password"
              value={serviceRoleKey}
              onChange={(event) => setServiceRoleKey(event.target.value)}
              placeholder="Paste once — never returned"
              autoComplete="new-password"
              required
            />
          </label>
          <div className="foundry-wizard-grid">
            <label>
              Management API token <span>optional</span>
              <input
                type="password"
                value={managementApiToken}
                onChange={(event) => {
                  setManagementApiToken(event.target.value);
                  if (!event.target.value) setManagementApiTokenExpiresAt("");
                }}
                placeholder="For project metadata"
                autoComplete="new-password"
              />
              <small>Optional. Foundry uses it for project metadata, not database access.</small>
            </label>
            <label>
              Database URL <span>optional</span>
              <input
                type="password"
                value={databaseUrl}
                onChange={(event) => setDatabaseUrl(event.target.value)}
                placeholder="For SQL surfaces"
                autoComplete="new-password"
              />
            </label>
          </div>
          {managementApiToken ? (
            <div className="foundry-token-expiry">
              <label>
                Management token expires <span>required with a token</span>
                <input
                  type="date"
                  value={managementApiTokenExpiresAt}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(event) => setManagementApiTokenExpiresAt(event.target.value)}
                  required
                />
              </label>
              <p>
                We will show an in-app reminder 7 days before this date and ask you to replace the
                token if it expires.
              </p>
            </div>
          ) : null}
          {!workspaceId ? (
            <p className="foundry-form-error" role="alert">
              Your workspace is still being prepared. Refresh this page before connecting a backend.
            </p>
          ) : null}
          {error ? (
            <p className="foundry-form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="foundry-wizard-footer">
            <p>
              <span className="foundry-status-dot" /> Keys stay server-side and are encrypted at
              rest.
            </p>
            <div>
              <button
                className="foundry-button foundry-button-secondary"
                type="button"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="foundry-button foundry-button-primary"
                type="submit"
                disabled={isSubmitting || !workspaceId}
              >
                {isSubmitting ? "Checking project…" : "Connect Supabase"}
                <span className="foundry-button-arrow">↗</span>
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
