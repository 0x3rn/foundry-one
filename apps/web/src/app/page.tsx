import { headers } from "next/headers";
import Link from "next/link";
import { getAuth } from "@foundry/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch {
    // Session check fails gracefully if auth is not yet configured or cookies are absent
  }

  return (
    <div className="foundry-landing">
      {/* Top Navigation */}
      <header className="foundry-landing-header">
        <div className="foundry-landing-nav-container">
          <Link href="/" className="foundry-brand">
            <div className="foundry-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <p className="foundry-brand-name">Foundry One</p>
              <p className="foundry-brand-kicker">Universal control plane</p>
            </div>
          </Link>

          <nav className="foundry-landing-links" aria-label="Primary navigation">
            <a href="#capabilities">Capabilities</a>
            <a href="#architecture">Architecture</a>
            <a href="#providers">Providers</a>
            <a href="#security">Security</a>
          </nav>

          <div className="foundry-landing-nav-actions">
            {session ? (
              <Link href="/dashboard" className="foundry-button foundry-button-primary">
                Open Dashboard <span className="foundry-button-arrow">↗</span>
              </Link>
            ) : (
              <>
                <Link href="/login" className="foundry-landing-login-link">
                  Sign in
                </Link>
                <Link href="/register" className="foundry-button foundry-button-primary">
                  Get Started <span className="foundry-button-arrow">↗</span>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="foundry-landing-hero">
        <div className="foundry-landing-container">
          <div className="foundry-landing-hero-badge">
            <span className="foundry-status-dot-pulse" aria-hidden="true" />
            <span>OPERATIONAL INTELLIGENCE & CONTROL PLANE</span>
          </div>

          <h1 className="foundry-landing-title">
            A quieter way to run the backend.
          </h1>

          <p className="foundry-landing-subtitle">
            One calm, observable workspace for your databases, authentication, storage, and security
            across multiple Supabase and Firebase projects. Provider-neutral by design.
          </p>

          <div className="foundry-landing-hero-actions">
            {session ? (
              <Link href="/dashboard" className="foundry-button foundry-button-primary foundry-landing-cta-btn">
                Continue to Dashboard <span className="foundry-button-arrow">↗</span>
              </Link>
            ) : (
              <>
                <Link href="/register" className="foundry-button foundry-button-primary foundry-landing-cta-btn">
                  Create account <span className="foundry-button-arrow">↗</span>
                </Link>
                <Link href="/login" className="foundry-button foundry-button-secondary foundry-landing-cta-btn">
                  Sign in to workspace
                </Link>
              </>
            )}
            <a href="#architecture" className="foundry-landing-secondary-link">
              Explore the architecture ↓
            </a>
          </div>

          {/* High-Density Control Room Preview */}
          <div className="foundry-preview-shell">
            <div className="foundry-preview-topbar">
              <div className="foundry-preview-traffic">
                <span />
                <span />
                <span />
              </div>
              <div className="foundry-preview-title">
                foundry.corstack.dev — Production Control Center
              </div>
              <div className="foundry-preview-status">
                <span className="foundry-status-indicator foundry-status-healthy" />
                <span>All Providers Operational</span>
              </div>
            </div>

            <div className="foundry-preview-body">
              <div className="foundry-preview-metrics-row">
                <div className="foundry-preview-stat">
                  <span className="foundry-preview-stat-label">CONNECTED BACKENDS</span>
                  <span className="foundry-preview-stat-val">3 Projects</span>
                  <span className="foundry-preview-stat-sub">Supabase, Firebase, Neon</span>
                </div>
                <div className="foundry-preview-stat">
                  <span className="foundry-preview-stat-label">RLS COVERAGE</span>
                  <span className="foundry-preview-stat-val" style={{ color: "var(--teal)" }}>100% Active</span>
                  <span className="foundry-preview-stat-sub">0 exposed tables</span>
                </div>
                <div className="foundry-preview-stat">
                  <span className="foundry-preview-stat-label">CREDENTIAL VAULT</span>
                  <span className="foundry-preview-stat-val">AES-256-GCM</span>
                  <span className="foundry-preview-stat-sub">Versioned envelopes</span>
                </div>
                <div className="foundry-preview-stat">
                  <span className="foundry-preview-stat-label">RUNTIME ENGINE</span>
                  <span className="foundry-preview-stat-val">Cloudflare Edge</span>
                  <span className="foundry-preview-stat-sub">OpenNext + WASM</span>
                </div>
              </div>

              <div className="foundry-preview-table">
                <div className="foundry-preview-table-header">
                  <span>PROJECT</span>
                  <span>PROVIDER</span>
                  <span>ENVIRONMENT</span>
                  <span>STATUS</span>
                  <span>CAPABILITIES</span>
                </div>
                <div className="foundry-preview-table-row">
                  <span className="font-medium">billing-ledger-prod</span>
                  <span><span className="foundry-tag">Supabase</span></span>
                  <span>Production</span>
                  <span className="flex items-center gap-1.5">
                    <span className="foundry-status-dot" style={{ background: "#4bb587" }} /> Healthy
                  </span>
                  <span className="foundry-preview-caps">Relational DB • SQL Studio • Auth • Storage • RLS</span>
                </div>
                <div className="foundry-preview-table-row">
                  <span className="font-medium">mobile-telemetry-sync</span>
                  <span><span className="foundry-tag">Firebase</span></span>
                  <span>Production</span>
                  <span className="flex items-center gap-1.5">
                    <span className="foundry-status-dot" style={{ background: "#4bb587" }} /> Healthy
                  </span>
                  <span className="foundry-preview-caps">Firestore • Functions • Auth • Rules Audit</span>
                </div>
                <div className="foundry-preview-table-row">
                  <span className="font-medium">analytics-branch-stg</span>
                  <span><span className="foundry-tag">Supabase</span></span>
                  <span>Staging</span>
                  <span className="flex items-center gap-1.5">
                    <span className="foundry-status-dot" style={{ background: "#4bb587" }} /> Healthy
                  </span>
                  <span className="foundry-preview-caps">Relational DB • Schema Snapshots • Diff Engine</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Capabilities Section */}
      <section id="capabilities" className="foundry-landing-section">
        <div className="foundry-landing-container">
          <div className="foundry-landing-section-header">
            <p className="foundry-overline">Core Capabilities</p>
            <h2>Everything needed to keep software alive.</h2>
            <p>
              Replace fragmented provider dashboards with an unified, dense, keyboard-driven operational surface.
            </p>
          </div>

          <div className="foundry-landing-grid">
            <div className="foundry-card foundry-feature-card">
              <div className="foundry-feature-icon">01</div>
              <h3>Relational Schema Explorer & Data Editor</h3>
              <p>
                Inspect tables, views, columns, foreign keys, indexes, and constraints. Edit table rows
                with spreadsheet ergonomics, pagination, sorting, and safe bulk operations.
              </p>
              <ul className="foundry-feature-list">
                <li>Visual relationship & ERD foreign-key mappings</li>
                <li>Schema snapshots with environment diff tracking</li>
                <li>CSV import with field mapping & JSON exports</li>
              </ul>
            </div>

            <div className="foundry-card foundry-feature-card">
              <div className="foundry-feature-icon">02</div>
              <h3>SQL Studio with Safety Classifications</h3>
              <p>
                Execute PostgreSQL statements with syntax highlighting, execution timing, and bounded result sets.
                Destructive queries are automatically categorized and require explicit operator confirmation.
              </p>
              <ul className="foundry-feature-list">
                <li>Automatic classification: read-only, mutating, destructive, critical</li>
                <li>Query history with saved queries and folder grouping</li>
                <li>Server-side cancellation and connection lock visibility</li>
              </ul>
            </div>

            <div className="foundry-card foundry-feature-card">
              <div className="foundry-feature-icon">03</div>
              <h3>Encrypted Zero-Trust Credential Vault</h3>
              <p>
                Provider service-role keys and Management API tokens are encrypted server-side using AES-256-GCM.
                Secrets are decrypted only for the shortest possible duration during execution.
              </p>
              <ul className="foundry-feature-list">
                <li>Versioned envelope encryption with IV and authentication tags</li>
                <li>Master key kept isolated outside PostgreSQL</li>
                <li>Zero secrets exposed to browser bundles or client API responses</li>
              </ul>
            </div>

            <div className="foundry-card foundry-feature-card">
              <div className="foundry-feature-icon">04</div>
              <h3>Automated Security & Exposure Scanner</h3>
              <p>
                Continuously scan connected backends for missing Row Level Security (RLS), exposed tables,
                overly broad policies, and dangerous grants.
              </p>
              <ul className="foundry-feature-list">
                <li>Normalized findings with severity levels and evidence chains</li>
                <li>Step-by-step remediation suggestions and SQL preview</li>
                <li>Firebase Rules analysis and anonymous write exposure detection</li>
              </ul>
            </div>

            <div className="foundry-card foundry-feature-card">
              <div className="foundry-feature-icon">05</div>
              <h3>Cross-Project Observability & Health</h3>
              <p>
                Aggregate health indicators, query latency, storage capacity, and error signatures across your entire
                fleet of projects without fabricated data or missing signals.
              </p>
              <ul className="foundry-feature-list">
                <li>Real-time provider status (Healthy, Degraded, Disconnected)</li>
                <li>Durable metric snapshots stored in PostgreSQL</li>
                <li>Comprehensive audit logs for every operator action</li>
              </ul>
            </div>

            <div className="foundry-card foundry-feature-card">
              <div className="foundry-feature-icon">06</div>
              <h3>Provider-Neutral Architecture</h3>
              <p>
                Shared platform code consumes normalized capability contracts rather than direct vendor SDKs.
                Expand from Supabase to Firebase, Neon, and D1 without rewriting product logic.
              </p>
              <ul className="foundry-feature-list">
                <li>Dynamic capability detection per connection</li>
                <li>Consistent UI patterns across different backend models</li>
                <li>Built for long-term scalability and independence</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Architecture & Invariants */}
      <section id="architecture" className="foundry-landing-section foundry-landing-section-muted">
        <div className="foundry-landing-container">
          <div className="foundry-landing-section-header">
            <p className="foundry-overline">Security Architecture</p>
            <h2>Engineered for absolute operational safety.</h2>
            <p>
              Foundry One acts as an airlock between operators and powerful backend infrastructures.
            </p>
          </div>

          <div className="foundry-arch-flow">
            <div className="foundry-arch-step">
              <span className="foundry-arch-step-num">1</span>
              <h4>Browser Client</h4>
              <p>React 19 & Next.js App Router. Receives only normalized, redacted metadata. Zero credentials.</p>
            </div>
            <div className="foundry-arch-arrow">→</div>
            <div className="foundry-arch-step">
              <span className="foundry-arch-step-num">2</span>
              <h4>Control Plane Airlock</h4>
              <p>Cloudflare Worker running on edge isolates. Enforces Better Auth sessions and Workspace RBAC.</p>
            </div>
            <div className="foundry-arch-arrow">→</div>
            <div className="foundry-arch-step">
              <span className="foundry-arch-step-num">3</span>
              <h4>Encrypted Vault</h4>
              <p>AES-256-GCM envelope decryption in ephemeral server memory for immediate adapter execution.</p>
            </div>
            <div className="foundry-arch-arrow">→</div>
            <div className="foundry-arch-step">
              <span className="foundry-arch-step-num">4</span>
              <h4>Target Backends</h4>
              <p>Supabase Management API, PostgreSQL TCP sockets, and Firebase Admin SDK.</p>
            </div>
          </div>

          <div id="security" className="foundry-security-invariants-box">
            <h3 className="text-base font-semibold mb-3">Core Security Invariants</h3>
            <div className="foundry-invariants-grid">
              <div className="foundry-invariant-item">
                <strong>No Plaintext in Database:</strong> Credentials undergo authenticated AES-256-GCM encryption before persistence.
              </div>
              <div className="foundry-invariant-item">
                <strong>Destructive Safeguards:</strong> DROP, TRUNCATE, and mass deletions require two-step operator confirmation.
              </div>
              <div className="foundry-invariant-item">
                <strong>Full Auditability:</strong> Every query, modification, and credential operation produces an immutable audit record.
              </div>
              <div className="foundry-invariant-item">
                <strong>Provider Isolation:</strong> Third-party SDK errors are caught and sanitized to prevent stack or token leakage.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Supported Providers */}
      <section id="providers" className="foundry-landing-section">
        <div className="foundry-landing-container">
          <div className="foundry-landing-section-header">
            <p className="foundry-overline">Ecosystem</p>
            <h2>Supported Backend Platforms</h2>
            <p>A single interface to govern your heterogeneous backend stack.</p>
          </div>

          <div className="foundry-providers-row">
            <div className="foundry-provider-card">
              <div className="foundry-provider-badge foundry-provider-active">Production Ready</div>
              <h4>Supabase</h4>
              <p>Full support for PostgreSQL databases, Schema Snapshots, SQL Studio, Auth users, Storage buckets, and RLS policies.</p>
            </div>

            <div className="foundry-provider-card">
              <div className="foundry-provider-badge">Adapter Ready</div>
              <h4>Firebase</h4>
              <p>Normalized management for Firestore collections, Realtime Database trees, Firebase Auth, and Security Rules auditing.</p>
            </div>

            <div className="foundry-provider-card">
              <div className="foundry-provider-badge">Integrated</div>
              <h4>PostgreSQL & Neon</h4>
              <p>Driver adapter connectivity via PrismaPg, supporting serverless connections, branching workflows, and query safety.</p>
            </div>

            <div className="foundry-provider-card">
              <div className="foundry-provider-badge">Native</div>
              <h4>Cloudflare Workers & D1</h4>
              <p>Deployed as an OpenNext edge worker with WASM query engine execution and zero server cold-start overhead.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="foundry-landing-cta-section">
        <div className="foundry-landing-container">
          <div className="foundry-card foundry-landing-cta-card">
            <p className="foundry-overline">First, make it yours</p>
            <h2>Start with a clear room.</h2>
            <p className="max-w-xl mx-auto mb-6 text-sm text-[var(--ink-soft)]">
              Bring the systems behind your product into one calm, observable workspace.
              Set up your Foundry identity and connect your first backend in minutes.
            </p>
            <div className="flex items-center justify-center gap-4">
              <Link href="/register" className="foundry-button foundry-button-primary foundry-landing-cta-btn">
                Create account <span className="foundry-button-arrow">↗</span>
              </Link>
              <Link href="/login" className="foundry-button foundry-button-secondary foundry-landing-cta-btn">
                Sign in to existing workspace
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="foundry-landing-footer">
        <div className="foundry-landing-container foundry-landing-footer-inner">
          <div className="foundry-brand">
            <div className="foundry-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <p className="foundry-brand-name">Foundry One</p>
              <p className="foundry-brand-kicker">Universal backend control plane</p>
            </div>
          </div>
          <p className="foundry-landing-footer-copy">
            Provider-neutral by design. Built for the people who keep software alive.
          </p>
          <div className="foundry-landing-footer-links">
            <Link href="/login">Sign in</Link>
            <Link href="/register">Register</Link>
            <Link href="/dashboard">Dashboard</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
