# Changelog

## [0.0.6](https://github.com/pantoninho/devtrees/compare/v0.0.5...v0.0.6) (2026-09-09)


### Bug Fixes

* attribute a worktree-instance socket failure to the worktree, not shared ([#166](https://github.com/pantoninho/devtrees/issues/166)) ([8bfa50c](https://github.com/pantoninho/devtrees/commit/8bfa50c461ef8d882de8239b4477854841297692))
* bind control sockets in a short runtime dir so deep checkouts can start ([#164](https://github.com/pantoninho/devtrees/issues/164)) ([560d3e5](https://github.com/pantoninho/devtrees/commit/560d3e5dc5f2c930a24264c6e487ed13809799fc))
* pass depends_on conditions through for same-tier edges ([#167](https://github.com/pantoninho/devtrees/issues/167)) ([00febfb](https://github.com/pantoninho/devtrees/commit/00febfbd743779fac5a5713f3d6d95e8303b79b2)), closes [#158](https://github.com/pantoninho/devtrees/issues/158)
* report dropped cross-tier depends_on edges from `up --dry-run` ([#169](https://github.com/pantoninho/devtrees/issues/169)) ([b9b22ab](https://github.com/pantoninho/devtrees/commit/b9b22ab833c352bb910ddf6c2e31d792341a689e)), closes [#168](https://github.com/pantoninho/devtrees/issues/168)

## [0.0.5](https://github.com/pantoninho/devtrees/compare/v0.0.4...v0.0.5) (2026-06-29)


### Bug Fixes

* run shutdown hook from a valid cwd so prune reaps orphaned stacks ([#152](https://github.com/pantoninho/devtrees/issues/152)) ([c0f6698](https://github.com/pantoninho/devtrees/commit/c0f66987a44fc344810df0c97f8a0d3923428f45))

## [0.0.4](https://github.com/pantoninho/devtrees/compare/v0.0.3...v0.0.4) (2026-06-26)


### Bug Fixes

* add repository metadata so npm publish provenance validates ([#149](https://github.com/pantoninho/devtrees/issues/149)) ([6789780](https://github.com/pantoninho/devtrees/commit/6789780c18792d105ec8041083c1c65444308a11))

## [0.0.3](https://github.com/pantoninho/devtrees/compare/v0.0.2...v0.0.3) (2026-06-25)


### Bug Fixes

* **prune:** reconcile dead registry reservations against live worktrees ([#142](https://github.com/pantoninho/devtrees/issues/142)) ([#143](https://github.com/pantoninho/devtrees/issues/143)) ([9c8cbe8](https://github.com/pantoninho/devtrees/commit/9c8cbe8c195191cd03ab5a78052e34eb3e470e38))
