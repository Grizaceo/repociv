# Contributing to RepoCiv

Thanks for your interest in contributing. RepoCiv is a single-user alpha, and
contributions should be small, focused, and dogfooding-driven.

`docs/SCOPE.md` is the single source of truth for what is (and isn't) in
scope — read it before proposing a feature. Historical roadmaps and plans live
in `docs/archive/` (e.g. `docs/archive/ROADMAP.md`) and do not describe the
current trunk.

## Getting Up and Running

### Prerequisites

- Node.js 20+ (see `.nvmrc`)
- Python 3.11+ (see `.python-version`)
- A running Hermes Agent instance (optional, for live agent features)

### Setup

```bash
git clone <repo-url> repociv
cd repociv

# Frontend
npm install

# Backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Development

```bash
# Terminal 1 — Backend (auto-reload disabled for determinism)
python -m server.bridge

# Terminal 2 — Frontend (Vite dev server)
npm run dev

# Open http://localhost:5273
```

### Environment

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

For local dev, leave `REPOCIV_TOKEN` empty (auth is bypassed).

## Running Tests

The full gate is one command. In order it runs: TypeScript typecheck, ESLint
(zero warnings), Prettier check, Vitest with the coverage floor, the Vite
production build, Ruff over `server/` and `scripts/`, Pytest (≥50% coverage),
and the asset/bundle budgets (terrain atlas ≤6 MiB, props ≤1.5 MiB, eager JS
≤185 KiB gzip). Knip and mypy run afterwards as non-blocking reports.

```bash
bash scripts/check.sh
```

You can also run the individual layers:

```bash
# Frontend (Vitest)
npm test

# Frontend with coverage
npm run test:coverage

# Backend (pytest)
pytest server/ -v

# Backend with coverage (the gate enforces ≥50%)
pytest server/ --cov=server --cov-fail-under=50 --cov-report=term-missing
```

### Playwright e2e

The e2e suite boots the app against the synthetic `demo-workspace` fixture, so
it never touches your real `~/.hermes` state. To reproduce the CI conditions
locally (same seed and env vars, isolated `XDG_STATE_HOME`, ports 5373-5375):

```bash
# Full suite, like CI
bash scripts/e2e-ci-sim.sh

# One spec
bash scripts/e2e-ci-sim.sh e2e/repociv.spec.ts
```

The helper is deliberately frugal: it pins the run to two CPUs (`taskset`) at
the lowest priority (`nice -n 19`) with one Playwright worker, so the machine
stays usable while it runs. Use `E2E_SIM_FULL=1` for the CI shape (all CPUs,
two workers).

The two live specs (`activity-live`, `dashboard-live-inventory`) skip unless
`REPOCIV_LIVE_INVENTORY=1`: they read the real local Hermes/kanban stores and
are opt-in dogfood checks, not CI gates.

### Pre-push hook (optional)

To run the full gate automatically before every `git push`:

```bash
git config core.hooksPath scripts/hooks
```

Bypass with `git push --no-verify` if needed.

## Code Style

- TypeScript strict mode is enabled.
- ESLint + Prettier enforce formatting. Run `npm run format` to auto-fix.
- Python is linted by Ruff (`line-length = 100`, Python 3.11 syntax).
- Commit messages follow the Conventional Commits style when possible:
  `feat:`, `fix:`, `docs:`, `chore:`, `test:`.

## Submitting Changes

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your change. Keep it small.
4. Ensure the full gate passes: `bash scripts/check.sh`
5. Commit with a descriptive message.
6. Open a Pull Request against `main`.

## What We're Looking For

- Bug fixes with regression tests.
- Small, focused feature additions that solve a real dogfooding need.
- Documentation improvements.
- Performance improvements (the hex map targets 60 FPS).

## What We're Not Looking For

- Large refactors without prior discussion.
- Features that aren't needed by the primary user yet.
- Anything `docs/SCOPE.md` marks as out of scope — multi-tenant/multi-user,
  real-time multiplayer, voice/TTS and achievement systems.
- Large features that belong on a parallel branch (e.g. the mobile client
  `feat/multi-device-mobile`) — those merge only when stable and demonstrably
  valuable.
- Picking a side between renderers: both the Canvas 2D (`flat`, the default)
  and the WebGL/Three.js (`webgl`, opt-in) modes are official trunk; the rule
  is frictionless switching, not "2D only".

## Code of Conduct

Be respectful. Critique ideas, not people. Keep discussions technical and
on-topic.
