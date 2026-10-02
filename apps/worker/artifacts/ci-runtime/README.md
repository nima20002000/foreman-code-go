Build the CI runtime from a committed source snapshot:

```sh
node scripts/build-ci-runtime-context.mjs /new/private/context
podman build --file /new/private/context/Containerfile --tag localhost/graphql-ci:reviewed /new/private/context
```

The context contains only committed lockfile, workspace policy, package manifests and image controls. It excludes working-tree files, source credentials and caches. The base manifest, Node 22.23.3, Corepack 0.36.0 and pnpm 11.27.0 are pinned. Frozen-lock dependency fetching retains the repository's strict 48-hour release-age policy. The installed Corepack wrapper uses its fixed image cache and disables network acquisition at workload runtime.

Build or pull during separately authorized image preparation. Record the actual immutable image ID and measured toolchain digest for runtime qualification; a rebuilt image must not reuse another build's receipt or tag as identity. This recipe does not provision worker cgroups, create approved roots, initialize operation journals, qualify the runtime, or authorize execution. Existing filesystem, no-new-privileges, network and descendant-containment guards remain mandatory.
