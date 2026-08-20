VERSION ?= 0.1.0
LDFLAGS := -s -w -X main.Version=$(VERSION)
OUT     := dist

# Static binaries with no libc dependency: the install script has to work on
# a Pi running Raspberry Pi OS and on an Alpine VPS without asking questions.
GO_BUILD = CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)"

.PHONY: all build test vet fmt clean dist checksums

all: vet test build

build:
	$(GO_BUILD) -o $(OUT)/fleet-agent ./cmd/agent

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

## dist cross-compiles every architecture the control plane schedules onto.
dist: clean
	@mkdir -p $(OUT)
	GOOS=linux  GOARCH=arm64        $(GO_BUILD) -o $(OUT)/fleet-agent-linux-arm64  ./cmd/agent
	GOOS=linux  GOARCH=arm GOARM=7  $(GO_BUILD) -o $(OUT)/fleet-agent-linux-armv7  ./cmd/agent
	GOOS=linux  GOARCH=amd64        $(GO_BUILD) -o $(OUT)/fleet-agent-linux-amd64  ./cmd/agent
	GOOS=darwin GOARCH=arm64        $(GO_BUILD) -o $(OUT)/fleet-agent-darwin-arm64 ./cmd/agent
	GOOS=darwin GOARCH=amd64        $(GO_BUILD) -o $(OUT)/fleet-agent-darwin-amd64 ./cmd/agent
	@$(MAKE) checksums
	@ls -lh $(OUT)

checksums:
	@cd $(OUT) && shasum -a 256 fleet-agent-* > SHA256SUMS

clean:
	rm -rf $(OUT)
