"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

interface SupabaseConnectionWizardProps {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly onClose: () => void;
}

export function SupabaseConnectionWizard({
  workspaceId,
  projectId,
  onClose,
}: SupabaseConnectionWizardProps) {
  const router = useRouter();
  const [projectName, setProjectName] = useState("");
  const [connectionName, setConnectionName] = useState("Primary Supabase");
  const [projectUrl, setProjectUrl] = useState("");
  const [serviceRoleKey, setServiceRoleKey] = useState("");
  const [managementApiToken, setManagementApiToken] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/provider-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          ...(projectId ? { projectId } : { projectName }),
          name: connectionName,
          projectUrl,
          serviceRoleKey,
          ...(managementApiToken ? { managementApiToken } : {}),
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
            <p className="foundry-card-eyebrow">01 / connect a backend</p>
            <h2 id="supabase-wizard-title">Bring Supabase into the room.</h2>
            <p>
              Foundry checks the project server-side, keeps the keys encrypted, and only brings back
              the connection state.
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
                onChange={(event) => setManagementApiToken(event.target.value)}
                placeholder="For project metadata"
                autoComplete="new-password"
              />
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
