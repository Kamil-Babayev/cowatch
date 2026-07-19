IMAGE_NAME := cowatch-server
PORT       := 8080

.PHONY: go-build go-run go-test go-test-cover go-test-race docker-build docker-run install dev build typecheck lint test test-coverage

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


test-coverage:
	npm run test:coverage

go-build:
	cd server && go build -o bin/server .

go-run:
	cd server && go run .

go-test:
	cd server && go test ./...

go-test-cover:
	cd server && go test -coverprofile=coverage.out ./... && go tool cover -html=coverage.out

go-test-race:
	cd server && go test -race ./...

docker-build:
	docker build -t $(IMAGE_NAME) -f server/Dockerfile ./server

docker-run:
	docker run --rm -p $(PORT):$(PORT) \
		-e ADDR=:$(PORT) \
		-e JOIN_BASE_URL=http://localhost:$(PORT) \
		$(IMAGE_NAME)