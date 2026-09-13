export function App() {
  return (
    <main className="shell" data-testid="app-shell">
      <section className="shell-card" aria-labelledby="app-title">
        <p className="eyebrow">Frontend product wireframe</p>
        <h1 id="app-title">graphql</h1>
        <p className="description">
          This is the Phase 1 frontend product wireframe for graphql. It is not
          GraphQL protocol tooling; no backend or query execution is connected
          yet.
        </p>
        <div className="status" role="status">
          <span className="status-dot" aria-hidden="true" />
          Phase 1 · Mock data
        </div>
        <p>
          <a href="/workspaces/workspace-1">Open Website workspace</a>
        </p>
      </section>
    </main>
  )
}
