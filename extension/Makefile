.PHONY: install dev build typecheck lint test test-coverage test-race-note

install:
	npm install

dev:
	npm run dev

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npx web-ext lint --source-dir dist

test:
	npm test

# Opens the coverage report inline in the terminal. For an HTML/web view,
# see epic-2-report.md's note on Node's --experimental-test-coverage vs
# a browser-viewable report.
test-coverage:
	npm run test:coverage

# Node's built-in test runner has no --race equivalent (that's a Go
# concept, not a JS one — there's no data-race detector for single-
# threaded JS). Documented here so this isn't just a silently missing
# target; see epic-2-report.md for the full explanation.
test-race-note:
	@echo "No JS equivalent to 'go test -race' — see epic-2-report.md."
