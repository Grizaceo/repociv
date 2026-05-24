# Contributing to RepoCiv

Thanks for your interest in contributing. RepoCiv is a single-user alpha, and
contributions should be small, focused, and dogfooding-driven.

## Getting Up and Running

### Prerequisites

- Node.js 22+
- Python 3.12+
- A running Hermes Agent instance (optional, for live agent features)

### Setup

```bash
git clone https://github.com/yourusername/repociv.git
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

# Open http://localhost:5277
```

### Environment

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

For local dev, leave `REPOCIV_TOKEN` empty (auth is bypassed).

## Running Tests

```bash
# Frontend (Vitest)
npm test

# Frontend with coverage
npm run test:coverage

# Backend (pytest)
pytest server/ -v

# Backend with coverage
pytest server/ --cov=server --cov-report=term-missing
```

## Code Style

- TypeScript strict mode is enabled.
- ESLint + Prettier enforce formatting. Run `npm run format` to auto-fix.
- Commit messages follow the Conventional Commits style when possible:
  `feat:`, `fix:`, `docs:`, `chore:`, `test:`.

## Submitting Changes

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your change. Keep it small.
4. Ensure tests pass: `npm test && pytest server/ -v`
5. Ensure typecheck passes: `npx tsc --noEmit`
6. Commit with a descriptive message.
7. Open a Pull Request against `main`.

## What We're Looking For

- Bug fixes with regression tests.
- Small, focused feature additions that solve a real dogfooding need.
- Documentation improvements.
- Performance improvements (the hex map targets 60 FPS).

## What We're Not Looking For

- Large refactors without prior discussion.
- Features that aren't needed by the primary user yet.
- Multiplayer, 3D renderer, marketplace, or mobile PWA (see ROADMAP.md).

## Code of Conduct

Be respectful. Critique ideas, not people. Keep discussions technical and
on-topic.
