# Release automation with release-please, OIDC publish, and conventional-commit PR titles

Releases are driven by [release-please](https://github.com/googleapis/release-please). It watches `main`, and from the conventional-commit subjects since the last release it maintains a standing "release PR" that bumps `package.json` and the `CHANGELOG.md`. Merging that PR creates the `vX.Y.Z` tag and GitHub release, and a single `release.yml` workflow then publishes to npm from CI. This replaces the prior manual flow (run `npm publish` locally, then open a bookkeeping `chore(release)` PR and rebase-merge it so the tag SHA matched).

Four decisions are bundled here because they only make sense together:

- **Pre-1.0 version policy:** `bump-minor-pre-major: true`. While devtrees is `0.x`, `fix:` bumps patch, `feat:` bumps minor, and a breaking change (`feat!:` / `BREAKING CHANGE`) bumps **minor too** — it does **not** auto-promote to `1.0.0`. We cut `1.0.0` by hand when the CLI/agent surface is declared stable, not as a side effect of the first breaking commit.
- **npm authentication:** OIDC trusted publishing, not a stored `NPM_TOKEN`. GitHub Actions mints a short-lived token npm trusts (the package's trusted publisher is registered once on npmjs.com), and provenance is attested automatically. No long-lived npm credential exists in repo secrets.
- **release-please credential:** the default `GITHUB_TOKEN`, not a PAT. The release PR is therefore a bookkeeping-only change that runs **no** CI (GitHub does not trigger workflows for `GITHUB_TOKEN`-authored events). `main` requires status checks for ordinary feature PRs; the release PR is merged by a repo admin via "merge without waiting for requirements" (`enforce_admins` stays off). No PAT, so no second long-lived secret.
- **Commit-subject hygiene:** PRs are squash-merged, so the squash subject is the PR title, and release-please parses exactly that. A required PR-title check rejects any PR whose title is not a valid conventional commit, so a release is never silently missed or misclassified.

## Considered Options

- **Keep the manual flow** (publish locally, bookkeep after): rejected — publishing happens off a developer's machine with no provenance, the version bump and tag are hand-maintained, and "remember to `npm publish`" is an unguarded step.
- **Full SemVer defaults** (no pre-major knobs): rejected — the first `feat!` would auto-promote `0.x` to `1.0.0`, declaring the surface stable before we intend to.
- **`bump-patch-for-minor-pre-major` as well** (lock everything in `0.0.x`): rejected — too coarse; we want `feat` vs `fix` to remain visible in the minor digit while pre-1.0.
- **`NPM_TOKEN` secret:** rejected — a long-lived credential that can leak and must be rotated; OIDC removes it entirely and adds provenance.
- **PAT for release-please** (so the release PR runs CI and satisfies required checks automatically): rejected — reintroduces the long-lived stored secret OIDC was chosen to avoid. The release PR only changes `package.json` + `CHANGELOG.md` on an already-green `main`, so gating it with CI is low value; an admin override per release is cheaper than maintaining a PAT.
- **No required checks on feature PRs** (which would make the default-token release PR mergeable with no special-casing): rejected — we want feature PRs gated on green CI; the admin-override on the release PR is the price of keeping both that and the zero-secret design.

## Consequences

- **A one-time human prerequisite gates the first publish:** the trusted publisher must be registered on npmjs.com (package `devtrees` → repo `pantoninho/devtrees` → workflow `release.yml`) before auto-publish works. Until then the tag and GitHub release still succeed but the `npm publish` step fails.
- **The release PR is unchecked by design.** It carries no CI status; a maintainer admin-merges it. This is safe only because release-please releases solely already-merged `main` commits, and `main` was green when the PR was cut.
- **Releases depend on PR-title discipline being machine-enforced.** Disabling the PR-title check would let non-conventional squash subjects land and silently drop changes from the next release.
- **Merge method must stay squash.** Rebase- or merge-commit-merging a multi-commit PR puts its individual (possibly non-conventional) commit subjects on `main`, which release-please would parse directly. The repo should disable non-squash merge methods.
- **The publish job needs a current npm CLI** (OIDC trusted publishing requires npm ≥ 11.5.1; the pinned Node ships an older npm), and runs the existing `prepublishOnly` guard (build + check + test) as a last line of defence before publishing.
- **`1.0.0` is now an explicit, deliberate act** rather than an emergent one — the version number stays an honest "still pre-stable" signal until we decide otherwise.

## Operational prerequisites (discovered during the first automated release, v0.0.4)

The decisions above assumed OIDC trusted publishing and provenance would "just work"; the first real release surfaced three prerequisites that are easy to miss and fail confusingly. Recorded here so a future maintainer — or a fork — does not rediscover them the hard way:

- **The repository must be public.** npm provenance (`npm publish --provenance`) can only be generated from a public source repo — the sigstore attestation links to a publicly verifiable build — so from a private repo the publish fails with a `422`. Going public also unlocked branch protection on the free plan (required checks need GitHub Pro on a private repo). `devtrees` was made public for both reasons.
- **GitHub Actions must be permitted to create pull requests.** The repo toggle _Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"_ must be on, or release-please cannot open its release PR with the default `GITHUB_TOKEN` (it fails with "GitHub Actions is not permitted to create or approve pull requests"). The workflow's own job-level `permissions:` block does **not** override this account/repo setting.
- **`package.json` must carry a `repository.url` matching the repo.** Provenance verification cross-checks it against the build's source; an empty or absent field fails the publish with a `422` ("repository.url is ''"). `repository` (with `homepage`/`bugs`) is now part of the package metadata.

Concrete settings as configured:

- **Required status checks on `main`:** `Vite+ build & test`, `fallow code-quality gate`, and `Validate PR title (conventional commit)`. The `real-pc smoke` check is deliberately **not** required — it is path-filtered (it runs only when specific `src/` modules change), so requiring it would permanently block any PR that doesn't touch those paths. `enforce_admins` stays off so the unchecked release PR can be admin-merged.
- **The first release skipped a patch on npm.** `v0.0.3` was tagged and GitHub-released before the `repository` fix landed, so its publish step failed; the fix shipped as `v0.0.4` (release-please is forward-only — it does not retry a tagged version). `v0.0.3` remains a GitHub-only tag/release, and its code is included in `0.0.4`.
