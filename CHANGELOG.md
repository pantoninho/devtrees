# Changelog

## [0.2.0](https://github.com/pantoninho/devtrees/compare/v0.1.0...v0.2.0) (2026-10-13)


### Features

* stop -n and restart -n act on every isolated service of a namespace ([#231](https://github.com/pantoninho/devtrees/issues/231)) ([86255b7](https://github.com/pantoninho/devtrees/commit/86255b7587882e384c4964e0724a21233a8abbb2))


### Bug Fixes

* bare devtrees restart fails INVALID_ARGS with the booted namespaces' down + up ([#225](https://github.com/pantoninho/devtrees/issues/225)) ([#232](https://github.com/pantoninho/devtrees/issues/232)) ([c963423](https://github.com/pantoninho/devtrees/commit/c96342301c6a690838879b5f175c80d2890700af))

## [0.1.0](https://github.com/pantoninho/devtrees/compare/v0.0.5...v0.1.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* reverses #128's default, where a bare `up` started every namespace. A bare fresh `up` now starts only services with no `namespace:`, and fails with NO_SERVICES_SELECTED if every service declares one. Pass `-n <ns>` (repeatable, e.g. `-n default -n app`) to start named namespaces.
* devtrees requires process-compose v1.122.0 or newer; `up` fails on older releases.

### Features

* devtrees restart &lt;service...&gt; restarts named isolated services in place ([#229](https://github.com/pantoninho/devtrees/issues/229)) ([b365151](https://github.com/pantoninho/devtrees/commit/b365151f773187197ec0ef8a398cdcb0888c5e69))
* devtrees stop &lt;service...&gt; stops named services until the next up ([#223](https://github.com/pantoninho/devtrees/issues/223)) ([#228](https://github.com/pantoninho/devtrees/issues/228)) ([62799a4](https://github.com/pantoninho/devtrees/commit/62799a4ec4baab814e999af33084cbbd03360eae))
* list-valued namespaces and dropped cross-namespace dependency warnings ([#193](https://github.com/pantoninho/devtrees/issues/193)) ([4499bed](https://github.com/pantoninho/devtrees/commit/4499bed6c86790d0b659658c06273c42734be393))
* ls shows booted namespaces and per-service state (--services) ([#227](https://github.com/pantoninho/devtrees/issues/227)) ([c84f2ee](https://github.com/pantoninho/devtrees/commit/c84f2eefe516838240ec87e32210a2562859ca0c))
* namespaces are opt-in; bare up starts only default ([#184](https://github.com/pantoninho/devtrees/issues/184)) ([4c3885f](https://github.com/pantoninho/devtrees/commit/4c3885f26e105f20b6ea9b43332826fdddbb683f))
* require process-compose v1.122.0 ([#181](https://github.com/pantoninho/devtrees/issues/181)) ([d7d1fe8](https://github.com/pantoninho/devtrees/commit/d7d1fe8b1a4466a06e9787e0c6eeb9f67636559b))
* up restarts dead isolated services on a running instance ([#195](https://github.com/pantoninho/devtrees/issues/195)) ([f0834c1](https://github.com/pantoninho/devtrees/commit/f0834c15f7b248113c19138cacb73dfbb5fe411a))


### Bug Fixes

* attribute a worktree-instance socket failure to the worktree, not shared ([#166](https://github.com/pantoninho/devtrees/issues/166)) ([8bfa50c](https://github.com/pantoninho/devtrees/commit/8bfa50c461ef8d882de8239b4477854841297692))
* bind control sockets in a short runtime dir so deep checkouts can start ([#164](https://github.com/pantoninho/devtrees/issues/164)) ([560d3e5](https://github.com/pantoninho/devtrees/commit/560d3e5dc5f2c930a24264c6e487ed13809799fc))
* bound devtrees down so a service that never stops can't hang it ([#204](https://github.com/pantoninho/devtrees/issues/204)) ([1f124dd](https://github.com/pantoninho/devtrees/commit/1f124dd123e2fd083cef6510e13312bc977e0908))
* bound every process list read so a wedged instance can't hang up or ls ([#196](https://github.com/pantoninho/devtrees/issues/196)) ([45b8232](https://github.com/pantoninho/devtrees/commit/45b82327a34ed1d4cf6ae36197165de7f6c77ad7)), closes [#192](https://github.com/pantoninho/devtrees/issues/192)
* bound up's hot-reload so a never-stopping process can't hang it ([#189](https://github.com/pantoninho/devtrees/issues/189)) ([48cd889](https://github.com/pantoninho/devtrees/commit/48cd889ed2b7dab962d98952a2d8f10993c79e52))
* down force-kills the old process a timed-out hot-reload left behind ([#206](https://github.com/pantoninho/devtrees/issues/206)) ([#208](https://github.com/pantoninho/devtrees/issues/208)) ([e17504b](https://github.com/pantoninho/devtrees/commit/e17504b04bccd0cfc2e1e43606ac1e7a8e4267df))
* down stops service process trees and reports what outlives it ([#155](https://github.com/pantoninho/devtrees/issues/155)) ([#219](https://github.com/pantoninho/devtrees/issues/219)) ([dd336f6](https://github.com/pantoninho/devtrees/commit/dd336f6f82c4ce78e1ef5ce869cd3e7f6651f6ce))
* fail INSTANCE_NOT_FOUND when the instance is stopped during up's health wait ([#205](https://github.com/pantoninho/devtrees/issues/205)) ([#207](https://github.com/pantoninho/devtrees/issues/207)) ([bffa128](https://github.com/pantoninho/devtrees/commit/bffa1286dc93d18bde4b81b15bb401eaa7b76d3e))
* fail NO_SERVICES_SELECTED when -n selects no services ([#203](https://github.com/pantoninho/devtrees/issues/203)) ([#209](https://github.com/pantoninho/devtrees/issues/209)) ([d2b5bcb](https://github.com/pantoninho/devtrees/commit/d2b5bcb4f1877346c32cc5d2b6e16cbe8ca6ba1a))
* hot-reload restarts only changed services, even right after boot ([#198](https://github.com/pantoninho/devtrees/issues/198)) ([e56666f](https://github.com/pantoninho/devtrees/commit/e56666f229d05b419fff9e76ee00406e32072d62)), closes [#194](https://github.com/pantoninho/devtrees/issues/194)
* include every forwarded process-compose field in the stack hash ([#183](https://github.com/pantoninho/devtrees/issues/183)) ([e032cb8](https://github.com/pantoninho/devtrees/commit/e032cb8341300258f63098d14d19b9798811e2dc)), closes [#175](https://github.com/pantoninho/devtrees/issues/175)
* keep a live instance's control socket when its probe is inconclusive ([#199](https://github.com/pantoninho/devtrees/issues/199)) ([010eb57](https://github.com/pantoninho/devtrees/commit/010eb57c257e498272cd385d7a8aa68985ff18e8))
* never report health ready for a process that is not running ([#182](https://github.com/pantoninho/devtrees/issues/182)) ([4ca2a8e](https://github.com/pantoninho/devtrees/commit/4ca2a8e21a55ac6ad6eac6637d7c95812e070515)), closes [#174](https://github.com/pantoninho/devtrees/issues/174)
* pass depends_on conditions through for same-tier edges ([#167](https://github.com/pantoninho/devtrees/issues/167)) ([00febfb](https://github.com/pantoninho/devtrees/commit/00febfbd743779fac5a5713f3d6d95e8303b79b2)), closes [#158](https://github.com/pantoninho/devtrees/issues/158)
* refuse to hot-reload while an earlier reload is still pending ([#191](https://github.com/pantoninho/devtrees/issues/191)) ([#202](https://github.com/pantoninho/devtrees/issues/202)) ([92e3e98](https://github.com/pantoninho/devtrees/commit/92e3e98ef8ba20a5dc0956cb4fbfd53304b6757b))
* report dropped cross-tier depends_on edges from `up --dry-run` ([#169](https://github.com/pantoninho/devtrees/issues/169)) ([b9b22ab](https://github.com/pantoninho/devtrees/commit/b9b22ab833c352bb910ddf6c2e31d792341a689e)), closes [#168](https://github.com/pantoninho/devtrees/issues/168)
* stale-port preflight sees holders on 0.0.0.0, ::1 and :: ([#163](https://github.com/pantoninho/devtrees/issues/163)) ([#217](https://github.com/pantoninho/devtrees/issues/217)) ([41479ba](https://github.com/pantoninho/devtrees/commit/41479ba97dc03f41cac91e63362069c634469bc4))
* stop shared-only field edits hot-reloading the worktree, and warn they won't apply ([#197](https://github.com/pantoninho/devtrees/issues/197)) ([7277454](https://github.com/pantoninho/devtrees/commit/72774543f0e43ed790d11c545c2519b5f824a198)), closes [#185](https://github.com/pantoninho/devtrees/issues/185)
* up --dry-run previews the running instance ([#210](https://github.com/pantoninho/devtrees/issues/210)) ([#212](https://github.com/pantoninho/devtrees/issues/212)) ([64ca9bb](https://github.com/pantoninho/devtrees/commit/64ca9bb2b7d0a10add12673258727ab5ea9b8f99))
* up verifies a running instance and fails loudly instead of reporting is up ([#187](https://github.com/pantoninho/devtrees/issues/187)) ([561eb6e](https://github.com/pantoninho/devtrees/commit/561eb6ec76ee1f7959fdbea894fee710ae7cbb92))
* warn when a command uses ${NAME} for a devtrees-injected variable ([#200](https://github.com/pantoninho/devtrees/issues/200)) ([#201](https://github.com/pantoninho/devtrees/issues/201)) ([0a96178](https://github.com/pantoninho/devtrees/commit/0a961787c79bd6f771649d860aa4defc7b3f87d9))

## [0.0.5](https://github.com/pantoninho/devtrees/compare/v0.0.4...v0.0.5) (2026-06-29)


### Bug Fixes

* run shutdown hook from a valid cwd so prune reaps orphaned stacks ([#152](https://github.com/pantoninho/devtrees/issues/152)) ([c0f6698](https://github.com/pantoninho/devtrees/commit/c0f66987a44fc344810df0c97f8a0d3923428f45))

## [0.0.4](https://github.com/pantoninho/devtrees/compare/v0.0.3...v0.0.4) (2026-06-26)


### Bug Fixes

* add repository metadata so npm publish provenance validates ([#149](https://github.com/pantoninho/devtrees/issues/149)) ([6789780](https://github.com/pantoninho/devtrees/commit/6789780c18792d105ec8041083c1c65444308a11))

## [0.0.3](https://github.com/pantoninho/devtrees/compare/v0.0.2...v0.0.3) (2026-06-25)


### Bug Fixes

* **prune:** reconcile dead registry reservations against live worktrees ([#142](https://github.com/pantoninho/devtrees/issues/142)) ([#143](https://github.com/pantoninho/devtrees/issues/143)) ([9c8cbe8](https://github.com/pantoninho/devtrees/commit/9c8cbe8c195191cd03ab5a78052e34eb3e470e38))
