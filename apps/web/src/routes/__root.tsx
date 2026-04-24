import { createRootRouteWithContext, Link, Outlet, useRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useLiveSync } from "../useLiveSync";

interface Ctx {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<Ctx>()({
  component: RootLayout,
});

function RootLayout() {
  useLiveSync();
  const router = useRouter();
  const { data: spaces } = useQuery({ queryKey: ["spaces"], queryFn: api.listSpaces });
  const { data: gh } = useQuery({
    queryKey: ["gh-status"],
    queryFn: api.githubStatus,
    refetchInterval: 30_000,
  });
  const currentPath = router.state.location.pathname;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo-wordmark-sm.png" alt="kanco" className="brand-wordmark" />
        </div>
        <Link to="/" className={`nav-item ${currentPath === "/" ? "active" : ""}`}>
          Home
        </Link>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)", letterSpacing: 1 }}>SPACES</div>
        {(spaces ?? []).map((s) => (
          <Link
            key={s.id}
            to="/spaces/$spaceId"
            params={{ spaceId: s.id }}
            className={`nav-item ${currentPath.includes(`/spaces/${s.id}`) ? "active" : ""}`}
          >
            {s.name}
          </Link>
        ))}
        <div style={{ flex: 1 }} />
        <Link
          to="/settings"
          className={`nav-item ${currentPath === "/settings" ? "active" : ""}`}
        >
          Settings
        </Link>
        <div className="gh-status" title={gh?.connected ? "GitHub connected" : "GitHub not connected"}>
          <span className={`status-dot ${gh?.connected ? "ok" : "down"}`} />
          <span className="gh-status-text">
            GitHub:{" "}
            {gh?.connected ? (
              <strong>@{gh.login ?? "connected"}</strong>
            ) : (
              <span className="muted">not connected</span>
            )}
          </span>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
