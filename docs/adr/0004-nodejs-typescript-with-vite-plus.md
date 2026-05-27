# Built in Node + TypeScript, tooled with Vite+

Devtrees is implemented in TypeScript on Node.js and distributed on npm. Project tooling is **Vite+** (`vite-plus` / `vp`), VoidZero's unified toolchain that bundles Vite, Vitest, Oxlint, Oxfmt, Rolldown, and tsdown behind one CLI.

## Considered Options

- **Go** (matches process-compose, which is also Go): rejected for now. It would yield a single static binary with no runtime dependency and a path to eventually embedding process-compose, but Node is the only runtime already present on the author's machine and gives the fastest path to a working CLI for a personal-to-team tool. Revisit if wide distribution to Node-less users, or embedding process-compose, becomes a goal.
- **Established Node tooling** (tsup/unbuild + Vitest + ESLint/Prettier): a safe, mature alternative to Vite+. Chosen against in favour of Vite+'s single unified toolchain.

## Consequences

- Devtrees shells out to the external `process-compose` binary; it does not embed it. Users must have process-compose installed (devtrees can check for it).
- Vite+ is in **alpha** (announced March 2026, MIT). Betting on it accepts churn/instability risk in exchange for one integrated toolchain; the fallback is the established Node tooling above if Vite+ proves unstable.
