IMAGE_NAME := cowatch-server
PORT       := 8080
JOIN_BASE_URL ?= http://localhost:$(PORT)

.PHONY: go-build go-run go-test go-test-cover go-test-race docker-build docker-run install dev build package typecheck lint test test-coverage verify

install:
	npm --prefix extension ci

dev:
	npm --prefix extension run dev

build:
	npm --prefix extension run build

package:
	npm --prefix extension run package

typecheck:
	npm --prefix extension run typecheck

lint:
	cd extension && npx web-ext lint --source-dir dist

test:
	npm --prefix extension test

test-coverage:
	npm --prefix extension run test:coverage

go-build:
	cd server && go build -o bin/server .

go-run:
	cd server && go run .

go-test:
	cd server && go test ./...

go-test-cover:
	cd server && go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out

go-test-race:
	cd server && go test -race ./...

docker-build:
	docker build --platform linux/amd64 -t $(IMAGE_NAME) -f server/Dockerfile ./server

docker-run:
	docker run --rm -p $(PORT):$(PORT) \
		-e ADDR=:$(PORT) \
		-e JOIN_BASE_URL=$(JOIN_BASE_URL) \
		$(IMAGE_NAME)

verify: go-test typecheck test-coverage build lint
