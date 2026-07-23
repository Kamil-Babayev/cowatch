# Repository Guidelines

## Project Structure & Module Organization

CoWatch consists of a Go synchronization server and a Firefox Manifest V3 extension. Server entry code is in `server/main.go`; HTTP, WebSocket, storage, configuration, and ID generation packages live under `server/internal/`. Embedded landing and room pages are in `server/static/`. Extension code is organized by runtime context under `extension/src/` (`background/`, `content/`, `popup/`, and `landing-bridge/`), with shared protocol and sync utilities in `extension/src/shared/`. TypeScript tests are colocated with their subjects as `*.test.ts`. Read `cowatch-project-plan.md`, `cowatch-implementation-sequence.md`, and the epic reports before changing architecture or advancing stories.

## Build, Test, and Development Commands

- `make go-build` builds the server to `server/bin/server`.
- `make go-run` starts the server locally on the configured address.
- `make go-test` runs all Go tests; `make go-test-race` also checks data races.
- `cd extension && npm ci` installs the pinned extension toolchain.
- `cd extension && npm run build` bundles the extension into `extension/dist/`.
- `cd extension && npm run dev` rebuilds on changes and launches Firefox through `web-ext`.
- `cd extension && npm test` runs Node's native TypeScript tests; `npm run test:coverage` reports coverage.
- `cd extension && npm run typecheck && npx web-ext lint --source-dir dist` performs static and manifest validation.

## Coding Style & Naming Conventions

Format Go with `gofmt`; use standard tabs and short, lowercase package names. TypeScript uses two-space indentation, single quotes, trailing commas, `camelCase` values, and `PascalCase` types/classes. Use kebab-case filenames such as `message-router.ts`. Relative TypeScript imports must include `.ts`. Do not use constructor parameter properties: Node's type-stripping test runner cannot transform them. Keep browser APIs, DOM access, and networking in thin adapters behind injected plain interfaces so core behavior remains testable.

## Testing Guidelines

Add focused `*.test.ts` coverage beside changed extension modules. Use dependency-injected fakes for browser APIs and `jsdom` only for DOM behavior. For server changes, add package-level `_test.go` tests and run the race suite. Treat passing unit tests as insufficient for browser wiring; manually verify affected flows in Firefox when possible.

## Commit & Pull Request Guidelines

History favors concise, outcome-focused subjects, often prefixed with a story ID (for example, `US 3.3 implemented overlay styling`). Keep each commit scoped to one story or fix. Pull requests should summarize behavior, list verification commands, link the relevant story or issue, and include screenshots for popup, overlay, or landing-page changes. Update planning documents in the same change whenever implementation and documented design diverge.
