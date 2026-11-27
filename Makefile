# Meridian developer commands. See README "Quick start".
SOLANA_VERSION := 2.3.13
ANCHOR_VERSION := 0.31.1
PROGRAM_DIR    := programs/meridian
IDL            := $(PROGRAM_DIR)/idl/meridian.json

.PHONY: doctor build idl idl-check test test-quick prop fmt clippy automation-test automation-build data-test api-test app-dev app-test

doctor:
	@./scripts/doctor.sh $(SOLANA_VERSION) $(ANCHOR_VERSION)

build:
	cd $(PROGRAM_DIR) && cargo build-sbf

idl:
	anchor idl build -p meridian -o $(IDL)

# Fails if the program's IDL differs from the committed one (MER-02 drift check).
idl-check:
	anchor idl build -p meridian -o /tmp/meridian.idl.json
	diff -u $(IDL) /tmp/meridian.idl.json

# Full program suite, including the 10,000-sequence property test.
test: build
	cargo test -p meridian

# Same suite with a 200-sequence property run, for the edit-test loop.
test-quick: build
	PROP_SEQUENCES=200 cargo test -p meridian

# Replay one failing property sequence: make prop SEED=1234
prop: build
	PROP_SEED=$(SEED) cargo test -p meridian --test invariants_prop -- --nocapture

fmt:
	cargo fmt --all -- --check

clippy:
	cargo clippy -p meridian --all-targets

# Automation service (Phase 4). LiteSVM suites need the program built; Postgres suites start a
# local cluster or use TEST_DATABASE_URL.
automation-test: build
	cd services/automation && npm ci && npm run typecheck && npm test

automation-build:
	cd services/automation && npm ci && npm run build

# Indexer and PG Writer (Phase 5): no program build needed, they run on the recorded fixture.
data-test:
	cd services/indexer && npm ci && npm run typecheck && npm test
	cd services/pg-writer && npm ci && npm run typecheck && npm test

# REST API, Tx Builder and WebSocket gateway (Phase 6). The Tx Builder suites execute on LiteSVM.
api-test: build
	cd services/api && npm ci && npm run typecheck && npm test
	cd services/txb && npm ci && npm run typecheck && npm test
	cd services/ws && npm ci && npm run typecheck && npm test

# Frontend (Phase 7). app-dev runs the stub backend and the Next dev server; app-test runs
# typecheck, component tests, the static build and the Playwright suite against the stub.
app-dev:
	cd app && npm ci && (npm run stub & npm run dev)

app-test:
	cd app && npm ci && npm run typecheck && npm test && npx next build && npx playwright test e2e/frontend.spec.ts
