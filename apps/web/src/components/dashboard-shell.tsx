"use client";

import { useEffect, useMemo, useState } from "react";
import { capabilityIsAvailable, filterItems, paginateItems, type CapabilityKey } from "@foundry/ui";
import { SupabaseConnectionWizard } from "@/components/supabase-connection-wizard";
import { DatabaseExplorer } from "@/components/database-explorer";
import {
  buildControlCenterSummary,
  formatBytes,
  formatConnectionState,
  formatCount,
  formatMetricForProject,
  getProjectCapabilities,
  getProjectConnectionState,
  type ControlCenterData,
} from "@/lib/control-center";

interface DashboardShellProps {
  user: { name: string; email: string };
  workspaceId?: string;
  projectId?: string;
  controlCenter: ControlCenterData;
}

interface NavigationItem {
  label: string;
  key: string;
  capability?: CapabilityKey;
  status?: string;
}

interface ProjectRow {
  id: string;
  name: string;
  provider: string;
  environment: string;
  status: string;
}

const navigationGroups: Array<{ label: string; items: NavigationItem[] }> = [
  { label: "Command", items: [{ label: "Overview", key: "overview" }] },
  { label: "Estate", items: [{ label: "Projects", key: "projects", status: "Empty" }] },
  {
    label: "Surface",
    items: [
      { label: "Database", key: "database", capability: "database" },
      { label: "Authentication", key: "authentication", capability: "authentication" },
      { label: "Storage", key: "storage", capability: "storage" },
      { label: "Functions", key: "functions", capability: "functions" },
    ],
  },
  {
    label: "Signals",
    items: [
      { label: "Observability", key: "observability", capability: "observability" },
      { label: "Security", key: "security", capability: "security" },
      { label: "Analytics", key: "analytics", capability: "analytics" },
      { label: "Alerts", key: "alerts", capability: "alerts" },
    ],
  },
  { label: "System", items: [{ label: "Settings", key: "settings" }] },
];

const featureCards: Array<{
  eyebrow: string;
  title: string;
  detail: string;
  capability: CapabilityKey;
  accent: string;
}> = [
  {
    eyebrow: "01 / relational",
    title: "Database",
    detail: "Tables, SQL Studio, schema changes",
    capability: "database",
    accent: "teal",
  },
  {
    eyebrow: "02 / identity",
    title: "Authentication",
    detail: "Users, sessions, policies",
    capability: "authentication",
    accent: "violet",
  },
  {
    eyebrow: "03 / files",
    title: "Storage",
    detail: "Buckets, files, signed access",
    capability: "storage",
    accent: "orange",
  },
  {
    eyebrow: "04 / runtime",
    title: "Functions",
    detail: "Deployments, logs, runtime health",
    capability: "functions",
    accent: "blue",
  },
];

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function DashboardShell({
  user,
  workspaceId,
  projectId,
  controlCenter,
}: DashboardShellProps) {
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [projectPage, setProjectPage] = useState(1);
  const [projectFilter, setProjectFilter] = useState<"all" | "ready">("all");
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId);

  const summary = useMemo(() => buildControlCenterSummary(controlCenter), [controlCenter]);
  const selectedProject = useMemo(
    () =>
      controlCenter.projects.find((project) => project.id === selectedProjectId) ??
      controlCenter.projects[0],
    [controlCenter.projects, selectedProjectId],
  );
  const capabilities = useMemo(() => getProjectCapabilities(selectedProject), [selectedProject]);
  const projectRows = useMemo<ProjectRow[]>(
    () =>
      controlCenter.projects.map((project) => {
        const connection = project.connections[0];
        return {
          id: project.id,
          name: project.name,
          provider: connection?.provider === "supabase" ? "Supabase" : "Firebase",
          environment: project.environment,
          status: formatConnectionState(getProjectConnectionState(project)),
        };
      }),
    [controlCenter.projects],
  );
  const capabilityRows: Array<[string, boolean | undefined]> = [
    [
      "Database",
      Boolean(capabilities.database || capabilities.relationalDatabase || capabilities.sql),
    ],
    ["Auth", Boolean(capabilities.authentication || capabilities.auth)],
    ["Storage", capabilities.storage],
    ["Functions", capabilities.functions],
    [
      "Observability",
      Boolean(capabilities.observability || capabilities.logs || capabilities.metrics),
    ],
    ["Security", capabilities.security],
  ];

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("foundry-theme");
    const nextIsDark = storedTheme
      ? storedTheme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = nextIsDark ? "dark" : "light";

    const timeoutId = window.setTimeout(() => setIsDark(nextIsDark), 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandOpen(true);
      }
      if (event.key === "Escape") {
        setIsCommandOpen(false);
        setIsNavOpen(false);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  function toggleTheme() {
    const nextIsDark = !isDark;
    setIsDark(nextIsDark);
    document.documentElement.dataset.theme = nextIsDark ? "dark" : "light";
    window.localStorage.setItem("foundry-theme", nextIsDark ? "dark" : "light");
  }

  const filteredProjects = useMemo(() => {
    const searched = filterItems(
      projectRows,
      projectQuery,
      (project) => `${project.name} ${project.provider}`,
    );
    return projectFilter === "ready"
      ? searched.filter((project) => project.status === "Healthy")
      : searched;
  }, [projectFilter, projectQuery, projectRows]);
  const paginatedProjects = useMemo(
    () => paginateItems(filteredProjects, projectPage, 5),
    [filteredProjects, projectPage],
  );

  function changeProjectQuery(query: string) {
    setProjectQuery(query);
    setProjectPage(1);
  }

  return (
    <div className="foundry-app">
      <div
        className={`foundry-scrim ${isNavOpen ? "is-visible" : ""}`}
        onClick={() => setIsNavOpen(false)}
      />
      <aside className={`foundry-sidebar ${isNavOpen ? "is-open" : ""}`}>
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
          <button
            className="foundry-icon-button foundry-mobile-close"
            type="button"
            onClick={() => setIsNavOpen(false)}
            aria-label="Close navigation"
          >
            ×
          </button>
        </div>

        <button
          className="foundry-workspace-switcher"
          type="button"
          onClick={() => setIsCommandOpen(true)}
        >
          <span className="foundry-workspace-symbol">F</span>
          <span className="foundry-switcher-copy">
            <span className="foundry-switcher-label">Workspace</span>
            <strong>{controlCenter.workspace.name}</strong>
          </span>
          <span className="foundry-chevron">⌄</span>
        </button>

        <nav className="foundry-nav" aria-label="Main navigation">
          {navigationGroups.map((group) => (
            <div className="foundry-nav-group" key={group.label}>
              <p className="foundry-nav-label">{group.label}</p>
              {group.items.map((item) => {
                const isUnsupported =
                  item.capability && !capabilityIsAvailable(capabilities, item.capability);
                const isActive = item.key === "overview";
                return (
                  <button
                    className={`foundry-nav-item ${isActive ? "is-active" : ""} ${isUnsupported ? "is-disabled" : ""}`}
                    key={item.key}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    aria-disabled={isUnsupported}
                    onClick={() => {
                      if (!isUnsupported) setIsNavOpen(false);
                    }}
                  >
                    <span className={`foundry-nav-glyph glyph-${item.key}`} aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.status || item.key === "projects" ? (
                      <span className="foundry-nav-status">
                        {item.key === "projects" ? summary.totalProjects : item.status}
                      </span>
                    ) : null}
                    {isUnsupported ? (
                      <span
                        className="foundry-nav-lock"
                        aria-label="Unavailable until a project is connected"
                      >
                        ·
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="foundry-sidebar-footer">
          <div className="foundry-connection-status">
            <span className="foundry-status-dot" />
            <span>
              <strong>Control plane online</strong>
              <small>
                {summary.totalProjects === 0
                  ? "Awaiting first project"
                  : `${summary.connectedProjects} of ${summary.totalProjects} connected`}
              </small>
            </span>
          </div>
          <p className="foundry-version">Foundry One / 0.1.0</p>
        </div>
      </aside>

      <main className="foundry-main">
        <header className="foundry-topbar">
          <button
            className="foundry-menu-button foundry-icon-button"
            type="button"
            onClick={() => setIsNavOpen(true)}
            aria-label="Open navigation"
          >
            <span />
            <span />
            <span />
          </button>
          <div className="foundry-breadcrumbs" aria-label="Breadcrumb">
            <span>{controlCenter.workspace.name}</span>
            <span>/</span>
            <strong>Overview</strong>
          </div>
          <div className="foundry-topbar-actions">
            <button
              className="foundry-search-trigger"
              type="button"
              onClick={() => setIsCommandOpen(true)}
            >
              <span className="foundry-search-icon" aria-hidden="true" />
              <span>Search anything</span>
              <kbd>⌘ K</kbd>
            </button>
            <button
              className="foundry-icon-button"
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            >
              <span
                className={`foundry-theme-icon ${isDark ? "is-moon" : "is-sun"}`}
                aria-hidden="true"
              />
            </button>
            <button
              className="foundry-avatar"
              type="button"
              onClick={() => setIsCommandOpen(true)}
              aria-label={`Open ${user.name} account menu`}
            >
              {initials(user.name)}
            </button>
          </div>
        </header>

        <div className="foundry-content">
          <section className="foundry-page-heading">
            <div>
              <p className="foundry-overline">Control center / workspace overview</p>
              <h1>One view of your backend estate.</h1>
              <p className="foundry-lede">
                A calm control room for the systems that keep your products moving.
              </p>
            </div>
            <div className="foundry-heading-actions">
              <button
                className="foundry-button foundry-button-secondary"
                type="button"
                onClick={() => setIsWizardOpen(true)}
              >
                <span className="foundry-button-plus">+</span> Connect backend
              </button>
              <button
                className="foundry-button foundry-button-primary"
                type="button"
                onClick={() => setIsCommandOpen(true)}
              >
                Open command palette <span className="foundry-button-arrow">↗</span>
              </button>
            </div>
          </section>

          <section className="foundry-readiness-grid" aria-label="Control plane status">
            <div className="foundry-readiness-card">
              <div className="foundry-readiness-orbit" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="foundry-readiness-copy">
                <p className="foundry-card-eyebrow">
                  Control plane / {summary.health === "attention" ? "attention" : "ready"}
                </p>
                <h2>
                  {summary.totalProjects === 0
                    ? "Your workspace is clear."
                    : `${summary.connectedProjects} project${summary.connectedProjects === 1 ? " is" : "s are"} in view.`}
                </h2>
                <p>
                  {summary.totalProjects === 0
                    ? "Connect a Supabase or Firebase project to bring its operational surfaces into this room."
                    : "Connection health, capability gaps, findings, and stored metrics stay visible from one calm control room."}
                </p>
                <button
                  className="foundry-inline-link"
                  type="button"
                  onClick={() => setIsWizardOpen(true)}
                >
                  See what you can connect <span>→</span>
                </button>
              </div>
              <div className="foundry-readiness-index">01</div>
            </div>
            <div className="foundry-signal-card">
              <div className="foundry-signal-header">
                <span className="foundry-card-eyebrow">System signal</span>
                <span className="foundry-signal-live">
                  <i /> LIVE
                </span>
              </div>
              <div className="foundry-signal-line" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="foundry-signal-footer">
                <strong>{summary.connectedProjects}</strong>
                <span>
                  projects connected
                  <br />
                  <em>
                    {summary.totalProjects === 0
                      ? "no signal to measure yet"
                      : `${summary.providerCounts.supabase} Supabase / ${summary.providerCounts.firebase} Firebase`}
                  </em>
                </span>
              </div>
            </div>
          </section>

          <section className="foundry-stat-grid" aria-label="Workspace summary">
            {[
              [
                "Connected projects",
                formatCount(summary.connectedProjects),
                `${summary.totalProjects} total in workspace`,
              ],
              [
                "Open findings",
                formatCount(summary.openFindings),
                summary.openFindings ? "Needs a closer look" : "Security checks appear here",
              ],
              [
                "Recent events",
                formatCount(controlCenter.activity.length),
                summary.recentErrors
                  ? `${summary.recentErrors} need attention`
                  : "No failed actions recorded",
              ],
              [
                "Workspace health",
                summary.health === "awaiting" ? "—" : summary.health,
                summary.health === "awaiting"
                  ? "Connect a project to score it"
                  : "Based on connection state and activity",
              ],
            ].map(([label, value, detail], index) => (
              <div className={`foundry-stat-card stat-accent-${index + 1}`} key={label}>
                <p>{label}</p>
                <strong>{value}</strong>
                <span>{detail}</span>
              </div>
            ))}
          </section>

          <div className="foundry-section-grid">
            <section className="foundry-panel foundry-projects-panel">
              <div className="foundry-panel-header">
                <div>
                  <p className="foundry-card-eyebrow">Your estate</p>
                  <h2>Projects</h2>
                </div>
                <button
                  className="foundry-text-button"
                  type="button"
                  onClick={() => setIsCommandOpen(true)}
                >
                  View all <span>↗</span>
                </button>
              </div>
              <div className="foundry-table-toolbar">
                <label className="foundry-table-search">
                  <span className="foundry-search-icon" aria-hidden="true" />
                  <input
                    value={projectQuery}
                    onChange={(event) => changeProjectQuery(event.target.value)}
                    placeholder="Filter projects"
                    aria-label="Filter projects"
                  />
                </label>
                <div className="foundry-filter-pills" role="group" aria-label="Project filters">
                  <button
                    className={projectFilter === "all" ? "is-selected" : ""}
                    type="button"
                    onClick={() => setProjectFilter("all")}
                  >
                    All
                  </button>
                  <button
                    className={projectFilter === "ready" ? "is-selected" : ""}
                    type="button"
                    onClick={() => setProjectFilter("ready")}
                  >
                    Ready
                  </button>
                </div>
              </div>
              {paginatedProjects.items.length === 0 ? (
                <div className="foundry-empty-state">
                  <div className="foundry-empty-icon" aria-hidden="true">
                    <span />
                    <span />
                  </div>
                  <h3>No projects in this workspace.</h3>
                  <p>
                    Your connected backends will appear here with health, provider, and environment
                    context.
                  </p>
                  <button
                    className="foundry-button foundry-button-secondary"
                    type="button"
                    onClick={() => setIsWizardOpen(true)}
                  >
                    Connect your first project <span>→</span>
                  </button>
                </div>
              ) : (
                <div className="foundry-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Provider</th>
                        <th>Environment</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedProjects.items.map((project) => (
                        <tr key={project.id}>
                          <td>
                            <button
                              className="foundry-project-row-button"
                              type="button"
                              onClick={() => setSelectedProjectId(project.id)}
                            >
                              {project.name}
                            </button>
                          </td>
                          <td>{project.provider}</td>
                          <td>{project.environment}</td>
                          <td>{project.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="foundry-pagination">
                <span>{paginatedProjects.state.total} projects</span>
                <div>
                  <button
                    type="button"
                    disabled={paginatedProjects.state.page === 1}
                    onClick={() => setProjectPage((page) => Math.max(1, page - 1))}
                    aria-label="Previous page"
                  >
                    ←
                  </button>
                  <span>
                    Page {paginatedProjects.state.page} / {paginatedProjects.state.pageCount}
                  </span>
                  <button
                    type="button"
                    disabled={paginatedProjects.state.page === paginatedProjects.state.pageCount}
                    onClick={() =>
                      setProjectPage((page) =>
                        Math.min(paginatedProjects.state.pageCount, page + 1),
                      )
                    }
                    aria-label="Next page"
                  >
                    →
                  </button>
                </div>
              </div>
            </section>
            <section className="foundry-panel foundry-activity-panel">
              <div className="foundry-panel-header">
                <div>
                  <p className="foundry-card-eyebrow">Workspace pulse</p>
                  <h2>Activity</h2>
                </div>
                <span className="foundry-panel-more">•••</span>
              </div>
              {controlCenter.activity.length === 0 ? (
                <div className="foundry-activity-empty">
                  <div className="foundry-activity-line" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <h3>Nothing has moved yet.</h3>
                  <p>
                    Actions, connections, and security events will collect here as your estate comes
                    online.
                  </p>
                  <button
                    className="foundry-inline-link"
                    type="button"
                    onClick={() => setIsWizardOpen(true)}
                  >
                    Connect a backend <span>→</span>
                  </button>
                </div>
              ) : (
                <div className="foundry-activity-list">
                  {controlCenter.activity.slice(0, 5).map((event) => (
                    <div className="foundry-activity-item" key={event.id}>
                      <span
                        className={`foundry-activity-dot ${event.result.toLowerCase() === "success" ? "is-success" : "is-warning"}`}
                      />
                      <div>
                        <strong>{event.action.replaceAll("_", " ")}</strong>
                        <span>
                          {event.resourceType} · {event.result}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {selectedProject ? (
            <section
              className="foundry-panel foundry-project-focus"
              aria-label="Selected project control center"
            >
              <div className="foundry-panel-header">
                <div>
                  <p className="foundry-card-eyebrow">Project control center</p>
                  <h2>{selectedProject.name}</h2>
                </div>
                <span className="foundry-project-tag">{selectedProject.environment}</span>
              </div>
              <div className="foundry-project-focus-grid">
                <div className="foundry-project-health">
                  <span className="foundry-card-eyebrow">Connection health</span>
                  <strong>
                    {formatConnectionState(getProjectConnectionState(selectedProject))}
                  </strong>
                  <p>
                    {selectedProject.connections[0]?.lastCheckedAt
                      ? `Last checked ${new Date(selectedProject.connections[0].lastCheckedAt).toLocaleString()}`
                      : "This connection has not completed a health check yet."}
                  </p>
                </div>
                <div className="foundry-project-metric">
                  <span>Users</span>
                  <strong>
                    {formatCount(
                      formatMetricForProject(selectedProject, [
                        "auth.users",
                        "users",
                        "total_users",
                      ]),
                    )}
                  </strong>
                  <small>stored snapshot</small>
                </div>
                <div className="foundry-project-metric">
                  <span>Database</span>
                  <strong>
                    {formatBytes(
                      formatMetricForProject(selectedProject, [
                        "database.storage_bytes",
                        "database.bytes",
                      ]),
                    )}
                  </strong>
                  <small>stored snapshot</small>
                </div>
                <div className="foundry-project-metric">
                  <span>Findings</span>
                  <strong>
                    {formatCount(
                      selectedProject.findings.filter((finding) =>
                        ["open", "acknowledged"].includes(finding.state),
                      ).length,
                    )}
                  </strong>
                  <small>open or acknowledged</small>
                </div>
              </div>
              <div className="foundry-capability-strip">
                {capabilityRows.map(([label, available]) => (
                  <span className={available ? "is-available" : "is-unavailable"} key={label}>
                    <i /> {label} · {available ? "available" : "not captured"}
                  </span>
                ))}
              </div>
              {capabilities.database || capabilities.relationalDatabase || capabilities.sql ? (
                <DatabaseExplorer projectId={selectedProject.id} />
              ) : (
                <div className="foundry-database-empty foundry-database-empty-inset">
                  Database browsing is unavailable until a database credential is checked.
                </div>
              )}
            </section>
          ) : null}

          <section className="foundry-panel foundry-surface-panel">
            <div className="foundry-panel-header">
              <div>
                <p className="foundry-card-eyebrow">Provider-neutral surface</p>
                <h2>What you can bring under control</h2>
              </div>
              <span className="foundry-muted-note">
                Capabilities appear when a project is connected
              </span>
            </div>
            <div className="foundry-feature-grid">
              {featureCards.map((card) => {
                const isAvailable = capabilityIsAvailable(capabilities, card.capability);
                return (
                  <button
                    className={`foundry-feature-card accent-${card.accent} ${isAvailable ? "" : "is-unavailable"}`}
                    type="button"
                    key={card.title}
                    disabled={!isAvailable}
                  >
                    <span className="foundry-feature-number">{card.eyebrow}</span>
                    <span className="foundry-feature-glyph" aria-hidden="true" />
                    <strong>{card.title}</strong>
                    <span>{card.detail}</span>
                    <small>{isAvailable ? "Open surface →" : "Connect a project first"}</small>
                  </button>
                );
              })}
            </div>
          </section>
          <footer className="foundry-footer">
            <span>Built for the people who keep software alive.</span>
            <span>Foundry One / local control plane</span>
          </footer>
        </div>
      </main>

      {isCommandOpen ? (
        <div
          className="foundry-command-backdrop"
          role="presentation"
          onMouseDown={() => setIsCommandOpen(false)}
        >
          <section
            className="foundry-command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="foundry-command-input">
              <span className="foundry-search-icon" aria-hidden="true" />
              <input autoFocus placeholder="Jump to a surface, project, or action..." />
              <kbd>esc</kbd>
            </div>
            <div className="foundry-command-section">
              <p>Suggested actions</p>
              <button
                type="button"
                onClick={() => {
                  setIsCommandOpen(false);
                  setIsWizardOpen(true);
                }}
              >
                <span className="command-symbol">+</span>
                <span>
                  <strong>Connect a backend</strong>
                  <small>Start a new provider connection</small>
                </span>
                <kbd>↵</kbd>
              </button>
              <button type="button" onClick={() => setIsCommandOpen(false)}>
                <span className="command-symbol">⌁</span>
                <span>
                  <strong>View workspace settings</strong>
                  <small>Members, permissions, and preferences</small>
                </span>
                <kbd>⌘ ,</kbd>
              </button>
            </div>
            <div className="foundry-command-footer">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> Navigate
              </span>
              <span>
                <kbd>esc</kbd> Close
              </span>
            </div>
          </section>
        </div>
      ) : null}
      {isWizardOpen ? (
        <SupabaseConnectionWizard
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setIsWizardOpen(false)}
        />
      ) : null}
    </div>
  );
}
