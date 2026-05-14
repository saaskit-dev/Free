SHELL := /bin/bash

.PHONY: help install build build-self dev typecheck lint test verify source-install-smoke local-full-test local-stop \
	workbench-export workbench-deploy \
	relay-typecheck relay-dev relay-deploy relay-deploy-dry-run \
	relay-e2e relay-e2e-local relay-migrate-local relay-migrate-remote remote-prod-smoke pack-local package-install-check clean

PACKAGE_VERSION := $(shell node -p "require('./package.json').version")
TARBALL := .tmp/pack/free-$(PACKAGE_VERSION).tgz
INSTALL_DIR := .tmp/install
FREE_BIN := $(INSTALL_DIR)/node_modules/.bin/free

help:
	@printf "%s\n" \
		"Free commands:" \
		"  make install              Install workspace dependencies" \
		"  make build                Build acp-runtime dependency and Free" \
		"  make build-self           Build only Free TypeScript" \
		"  make dev                  Watch Free TypeScript" \
		"  make typecheck            Typecheck Free and relay" \
		"  make test                 Run unit tests" \
		"  make verify               Run typecheck, tests, package, and install smoke" \
		"  make source-install-smoke Run the source installer from a clean git clone" \
		"  make local-full-test      Run verify plus local Wrangler relay e2e" \
		"  make local-stop           Stop local Free Workbench and relay dev servers" \
		"  make pack-local           Build local npm tarball under .tmp/pack" \
		"  make package-install-check Install the tarball and smoke-test the CLI" \
		"  make workbench-export     Export Workbench Web static assets" \
		"  make workbench-deploy     Deploy Workbench Web static assets to Cloudflare Pages" \
		"" \
		"Relay commands:" \
		"  make relay-dev            Run Cloudflare Worker locally" \
		"  make relay-deploy         Deploy production Worker acp-relay-worker" \
		"  make relay-deploy-dry-run Validate production Worker config without deploy" \
		"  make relay-e2e            Run relay HTTP e2e against RELAY_URL" \
		"  make relay-e2e-local      Start local Worker, run relay HTTP e2e, then stop it" \
		"  make relay-migrate-local  Apply D1 migrations locally" \
		"  make relay-migrate-remote Apply D1 migrations to acp-relay" \
		"  make remote-prod-smoke    Run hosted relay smoke"

install:
	pnpm --dir ../acp-runtime install --frozen-lockfile
	pnpm install --frozen-lockfile

build:
	pnpm --dir ../acp-runtime --filter @saaskit-dev/simulator-agent-acp build
	pnpm --dir ../acp-runtime run build:lib
	rm -rf dist
	pnpm exec tsc -p tsconfig.json
	chmod +x dist/bin.js

build-self:
	rm -rf dist
	pnpm exec tsc -p tsconfig.json
	chmod +x dist/bin.js

dev:
	pnpm exec tsc -p tsconfig.json --watch

typecheck: build-self relay-typecheck

lint: build relay-typecheck

test:
	pnpm exec vitest run

verify: typecheck test pack-local package-install-check source-install-smoke relay-deploy-dry-run

source-install-smoke:
	scripts/source-install-smoke.sh

local-full-test: verify relay-e2e-local

local-stop:
	scripts/stop-local-dev.sh

relay-typecheck:
	pnpm --dir relay exec tsc --noEmit -p tsconfig.json

relay-dev: relay-migrate-local
	pnpm --dir relay exec wrangler dev --ip 127.0.0.1 --port "$${RELAY_PORT:-8791}"

relay-deploy: relay-migrate-remote
	pnpm --dir relay exec wrangler deploy --domain "$${RELAY_DOMAIN:-free-relay.saaskit.app}"

relay-deploy-dry-run:
	pnpm --dir relay exec wrangler deploy --dry-run --domain "$${RELAY_DOMAIN:-free-relay.saaskit.app}"

workbench-export:
	: "$${EXPO_PUBLIC_RELAY_URL:?Set EXPO_PUBLIC_RELAY_URL to the public relay/API origin.}"
	: "$${EXPO_PUBLIC_WORKBENCH_ORIGIN:?Set EXPO_PUBLIC_WORKBENCH_ORIGIN to the public Workbench origin.}"
	pnpm --dir apps/workbench export:web
	printf '%s\n' '{"version":1,"include":["/*"],"exclude":["/_expo/*","/assets/*","/*.js","/*.css","/*.wasm","/*.ico","/*.png","/*.jpg","/*.svg","/*.ttf"]}' > apps/workbench/dist/_routes.json
	printf '%s\n' '/* /index.html 200' > apps/workbench/dist/_redirects

workbench-deploy: workbench-export
	pnpm --dir relay exec wrangler pages deploy ../apps/workbench/dist --project-name "$${WORKBENCH_PAGES_PROJECT:-free-app}" --commit-dirty=true --commit-message "deploy $$(git rev-parse --short HEAD 2>/dev/null || printf manual)"

relay-e2e:
	node relay/test-e2e.mjs

relay-e2e-local:
	@set -euo pipefail; \
	mkdir -p .tmp; \
	created_dev_vars=; \
	if [ ! -f relay/.dev.vars ]; then \
		created_dev_vars=1; \
		printf "%s\n" \
			"ACP_RELAY_ACCOUNT_SESSION_KEY_ID=free-default-2026-05-10" \
			"ACP_RELAY_ACCOUNT_SESSION_PRIVATE_KEY=MC4CAQAwBQYDK2VwBCIEIE3QzRbUWyHMh9gdhq_2qUXX_NzCJpJFhxtndaTTRvb3" \
			"ACP_RELAY_ACCOUNT_SESSION_PUBLIC_KEYS=[{\"kid\":\"free-default-2026-05-10\",\"publicKey\":\"D9wpO03lAtMNl2FFXCCuGpm64weG7IbRH8ZDFtEs0wA\"}]" \
			"ACP_RELAY_CONTROL_PLANE_SECRET=local-control-plane-secret" > relay/.dev.vars; \
	fi; \
	cleanup() { \
		status=$$?; \
		if [ -n "$${worker_pid:-}" ]; then kill "$$worker_pid" >/dev/null 2>&1 || true; wait "$$worker_pid" >/dev/null 2>&1 || true; fi; \
		if [ -n "$$created_dev_vars" ]; then rm -f relay/.dev.vars; fi; \
		if [ $$status -ne 0 ]; then printf "%s\n" "--- wrangler dev log ---"; tail -120 .tmp/relay-e2e-wrangler.log 2>/dev/null || true; fi; \
		exit $$status; \
	}; \
	trap cleanup EXIT; \
	scripts/stop-local-relay-port.sh "$${RELAY_PORT:-8791}"; \
	$(MAKE) relay-migrate-local >/dev/null; \
	pnpm --dir relay exec wrangler dev --ip 127.0.0.1 --port "$${RELAY_PORT:-8791}" > .tmp/relay-e2e-wrangler.log 2>&1 & \
	worker_pid=$$!; \
	for _ in {1..60}; do \
		if curl -fsS "http://127.0.0.1:$${RELAY_PORT:-8791}/health" >/dev/null 2>&1; then break; fi; \
		sleep 0.5; \
	done; \
	curl -fsS "http://127.0.0.1:$${RELAY_PORT:-8791}/health" >/dev/null; \
	RELAY_URL="http://127.0.0.1:$${RELAY_PORT:-8791}" node relay/test-e2e.mjs

relay-migrate-local:
	pnpm --dir relay exec wrangler d1 migrations apply acp-relay --local

relay-migrate-remote:
	pnpm --dir relay exec wrangler d1 migrations apply acp-relay --remote

remote-prod-smoke:
	node scripts/remote-prod-smoke.mjs

pack-local:
	scripts/pack-local.sh

package-install-check: $(TARBALL)
	rm -rf "$(INSTALL_DIR)"
	mkdir -p "$(INSTALL_DIR)"
	npm install --prefix "$(INSTALL_DIR)" "$(TARBALL)" --ignore-scripts
	test -x "$(FREE_BIN)"
	"$(FREE_BIN)" --help >/dev/null
	"$(FREE_BIN)" auth --help >/dev/null
	"$(FREE_BIN)" bridge config --relay-url ws://127.0.0.1:8791 --command "$(FREE_BIN)" --format generic >/dev/null

$(TARBALL):
	$(MAKE) pack-local

clean:
	rm -rf dist .tmp
