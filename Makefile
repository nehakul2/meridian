# Meridian developer commands. See README "Quick start".
SOLANA_VERSION := 2.3.13
ANCHOR_VERSION := 0.31.1
PROGRAM_DIR    := programs/meridian
IDL            := $(PROGRAM_DIR)/idl/meridian.json

.PHONY: doctor build idl idl-check test test-quick prop fmt clippy

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
