# Fleet OS CLI (`fleet`)

The command-line interface for **Fleet OS** — git-push deploys onto hardware you already own.

## Installation

### Via npm (Global)
```bash
npm install -g @yadurajfleetos/cli
```

### Run Directly via npx
```bash
npx @yadurajfleetos/cli --help
```

### Build and Install from Source
```bash
git clone https://github.com/YadurajManu/fleet-os.git fleet-os
cd fleet-os/cli
npm install
npm run build
npm link
```

---

## Quick Start

### 1. Sign In
```bash
# Hosted control plane (default: https://fleetapi.plastikworld.xyz)
fleet auth login

# Self-hosted control plane
fleet auth login --api https://fleetapi.example.com
```

### 2. Pair a Machine
```bash
fleet nodes pair
```
Run the generated `curl -fsSL ... | sh` command on the machine you want to add to your fleet.

### 3. Check Fleet Status & Health
```bash
fleet status
fleet doctor
```

### 4. Deploy a Service
```bash
# Validate manifest
fleet validate

# Apply services to fleet
fleet apply

# Plan and deploy a service
fleet deploy web
```

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `fleet auth login` | Sign in and save secure local session |
| `fleet config show` | Show active control plane and selected fleet |
| `fleet use <fleet>` | Choose default fleet |
| `fleet nodes pair` | Generate single-use pairing token for a new node |
| `fleet nodes` | List nodes, status, and resource usage |
| `fleet doctor` | Diagnostic health check across cluster |
| `fleet apply [file]` | Apply `fleet.yaml` manifest |
| `fleet deploy <svc>` | Plan, build, schedule, and roll out a service |
| `fleet logs <svc> -f` | Follow live container logs |
| `fleet restart <svc>` | Restart a service |
| `fleet rollback <svc>` | Roll back to previous deployment |
| `fleet where <svc>` | Explain scheduler placement and candidate scores |

---

## License

MIT License.
