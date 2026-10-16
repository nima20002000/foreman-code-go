# Add a CircleCI org as CI capacity

Each CircleCI org runs its own 30 free open-source jobs at once. Main adds every further org by itself once the org
follows a copy of the workspace CI mirror; nothing is configured in Foreman.

Main counts a GitHub organization as a CircleCI org when:

- Main's GitHub login (`gh`) is an active member of the organization, and
- Main's CircleCI login sees `gh/<organization>/<mirror name>`, where `<mirror name>` is the workspace mirror's
  repository name (for example `foreman-code-ci`).

Main checks every ten minutes. The org then shows up as `CircleCI <organization>` slots in `ci_computers_list` and in
the sidebar, and the dispatcher spreads tickets over all slots.

## Steps

1. Create a free GitHub organization owned by the GitHub account Main uses (github.com → New organization → Free →
   "My personal account").
2. Create the public mirror copy with the same name, and seed `main` from the current mirror as one commit without
   history:

   ```sh
   gh repo create <org>/foreman-code-ci --public --description "CI mirror." --disable-issues --disable-wiki
   git init --bare seed && cd seed
   git fetch --depth 1 https://github.com/<mirror owner>/foreman-code-ci.git main:refs/heads/main
   git push https://github.com/<org>/foreman-code-ci.git \
     "$(git -c user.name=ci -c user.email=ci@localhost commit-tree 'main^{tree}' -m 'CI mirror seed')":refs/heads/main
   ```

3. Grant the CircleCI OAuth app access to the organization: GitHub → Settings → Applications → Authorized OAuth Apps →
   CircleCI → Organization access → Grant. GitHub asks for a sudo confirmation.
4. Open `https://app.circleci.com/projects/project-dashboard/github/<org>/`, choose **Set up** on the mirror, and
   select "Use the .circleci/config.yml in my repo" on `main`.
5. Check: `circleci project get --project gh/<org>/foreman-code-ci --json` succeeds and
   `circleci project setting list --project gh/<org>/foreman-code-ci` shows `oss`, `dynamic-config` and
   `unversioned-config` set to `true`.

`circleci org list` can lag behind a new org for a while. Discovery uses the project lookup, not that list.
