export function MainRuntimeSetup() {
  return <section aria-label="Main runtime setup">
    <h2 className="computers-title">Main PC runtime setup</h2>
    <p className="computer-hint">Automatic runtime preparation is unavailable on Main.
      It supports reviewed verification profiles on paired computers.</p>
    <p className="computer-hint">A person must install or repair the protected CI runtime locally on Main.
      After installation, ask Operator to capture the installed runtime for the workspace's saved profile
      and run qualification. If qualification needs recovery, ask Operator to reconcile its original command first.</p>
  </section>
}
