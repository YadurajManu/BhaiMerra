# Fleet OS control plane on AWS

Two CloudFormation stacks. The control plane runs on a Lightsail instance
rather than EC2 because it mounts the host's Docker socket to run multi-arch
builds — that rules out every platform-as-a-service, but needs nothing else EC2
offers. Lightsail is the same virtual machine at a fixed price with egress
included, and egress is the bill that grows: a registry spends its life serving
image layers to nodes that are not in this VPC.

| Stack | Template | What it creates |
| --- | --- | --- |
| `fleet-os-control-plane` | `control-plane.yaml` | Lightsail instance, static IP, daily snapshots |
| `fleet-os-backups` | `backups.yaml` | S3 bucket for database dumps, scoped IAM writer |

## Deploy

```bash
MYIP=$(curl -fsS https://checkip.amazonaws.com)

aws cloudformation deploy --region ap-south-1 \
  --template-file deploy/aws/control-plane.yaml \
  --stack-name fleet-os-control-plane \
  --parameter-overrides "SshCidr=${MYIP}/32"

aws cloudformation deploy --region ap-south-1 \
  --template-file deploy/aws/backups.yaml \
  --stack-name fleet-os-backups \
  --capabilities CAPABILITY_NAMED_IAM
```

The instance needs a Lightsail key pair named `fleet-os` to exist first:

```bash
aws lightsail import-key-pair --region ap-south-1 \
  --key-pair-name fleet-os \
  --public-key-base64 "$(cat ~/.ssh/id_ed25519.pub)"
```

## When SSH stops working

Two different causes, and they need different fixes.

**Your address changed.** `SshCidr` pins port 22 to one address, so moving
between home, campus and a phone hotspot locks you out of a perfectly healthy
box. Re-run the deploy with your new address:

```bash
aws cloudformation deploy --region ap-south-1 \
  --template-file deploy/aws/control-plane.yaml \
  --stack-name fleet-os-control-plane \
  --parameter-overrides "SshCidr=$(curl -fsS https://checkip.amazonaws.com)/32"
```

**Your network blocks port 22 outright.** Campus and corporate networks
routinely filter 22 by port number while allowing everything else. The symptom
is a connection timeout to *every* SSH host, not just this one — test with
`nc -z github.com 22`. That is why `AltSshPort` (2222 by default) exists.

Opening the firewall port is not enough; `sshd` has to listen on it too. Ubuntu
24.04 activates ssh through a systemd **socket**, so a `Port` line in
`sshd_config` is silently ignored — the socket unit decides what to listen on.
Run this once, from the Lightsail browser console (Connect → Connect using SSH),
which reaches the box over HTTPS and is unaffected by any port filtering:

```bash
sudo bash -c '
set -e
if systemctl is-enabled ssh.socket >/dev/null 2>&1; then
  mkdir -p /etc/systemd/system/ssh.socket.d
  printf "[Socket]\nListenStream=\nListenStream=22\nListenStream=2222\n" \
    > /etc/systemd/system/ssh.socket.d/override.conf
  systemctl daemon-reload
  systemctl restart ssh.socket
else
  printf "Port 22\nPort 2222\n" > /etc/ssh/sshd_config.d/99-altport.conf
  systemctl restart ssh
fi
ss -tlnp | grep -E ":(22|2222) "
'
```

Then connect with `ssh -p 2222 ubuntu@<ip>`.

**Your network blocks bare IP addresses.** A stricter filter than the one
above, and the alternate port does not save you from it. The tell is that
`nc -z 1.1.1.1 443` fails while `curl https://cloudflare.com` succeeds: the
network forces everything through a proxy that resolves hostnames, so *no*
connection to a literal address completes, on any port. Measured on this
campus network on 2026-09-03 — 22, 2222, 80 and 443 to the instance all
timed out, as did 1.1.1.1:443, while `ssh.github.com:443` connected fine.

Nothing on the AWS side can fix this, and the firewall is not the cause;
check it before you go changing it:

```bash
aws lightsail get-instance-port-states --region ap-south-1 \
  --instance-name fleet-os-control-plane --output table
```

Two ways through, in order of how little they cost you:

1. **The Lightsail browser console** (Connect → Connect using SSH). It reaches
   the box over HTTPS to `console.aws.amazon.com`, a hostname, so the proxy
   passes it. Paste the deploy commands from `## Deploying a new build` there.
2. **A phone hotspot.** Carrier networks do not filter this way, so a normal
   `ssh ubuntu@<ip>` works — but the instance's firewall may be pinned to your
   old address, so re-run the `SshCidr` deploy above from the hotspot first.

## Deploying a new build

There is deliberately no deploy-on-push job: a green CI run means the tests
passed, not that the change is ready to serve traffic. Deploys are one command,
run on the box:

```bash
cd "$(docker inspect fleet-control-plane \
      --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
git pull
docker compose -f deploy/docker-compose.yml up -d --build control-plane dashboard
```

The first line asks the running container where its compose file came from,
rather than hardcoding a path. The checkout was placed by hand during the
migration from the laptop, so the path is not in this repository and a guess
would send `git pull` into the wrong directory — or into no directory, which is
the better of the two outcomes.

Check what is actually serving afterwards, because a build that fails still
leaves the previous container running and healthy:

```bash
curl -s https://fleet.plastikworld.xyz | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'
```

The hash changes on every dashboard build. If it did not change, the new code
is not live no matter what the build log said.

## When the box refuses SSH but keeps serving traffic

The Lightsail browser console shows `UPSTREAM_ERROR [515]`, meaning the
instance closed the connection. AWS lists three causes: sshd is down, sshd is
no longer on port 22, or CPU and memory are exhausted.

Check the site before assuming the box is down, because the third cause looks
nothing like an outage:

```bash
curl -s https://fleetapi.plastikworld.xyz/healthz
```

If that returns `"status":"ok"` while SSH refuses you, the box is alive and the
problem is that nothing *new* can start on it. Resident containers are already
running and keep answering; forking a login shell needs memory and a writable
filesystem, and it is not getting one. On this box that is nearly always the
`docker buildx` cache, which grows with every multi-arch deploy and is never
pruned.

`scripts/server-doctor.sh` reports all of it and reclaims space with
`--reclaim`. When the disk is too full to `git pull` it, paste the short
version into the browser console instead:

```bash
df -h /; docker system df; free -h
journalctl -k --since '24 hours ago' | grep -iE 'oom|killed process' | tail
```

Then, if the cache is the problem:

```bash
docker buildx prune -af && journalctl --vacuum-size=200M && df -h /
```

`buildx prune` rather than `system prune -a`: the latter also deletes the
images the running stack was built from and the registry's own data, which are
the two things here that are expensive to recreate.

If the filesystem has room and memory is clear, the connection cap is the next
suspect. Port 22 is reachable from `0.0.0.0/0` on a public address, so it
takes continuous brute-force traffic, and socket-activated sshd refuses
everyone once its concurrent-connection cap is saturated — including AWS's own
relay, which presents as a 515. Scope the port to your own address:

```bash
aws lightsail put-instance-public-ports --region ap-south-1 \
  --instance-name fleet-os-control-plane \
  --port-infos \
    "fromPort=22,toPort=22,protocol=tcp,cidrs=$(curl -fsS https://checkip.amazonaws.com)/32" \
    "fromPort=80,toPort=80,protocol=tcp,cidrs=0.0.0.0/0" \
    "fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0"
```

`put-instance-public-ports` **replaces** the whole rule set rather than adding
to it, so every port you still want has to appear in that one call. Leaving 80
and 443 out of it takes the site down.

## Cost

`large_3_1` is USD 44/month, fixed, including 2.5 TB of transfer. The S3 bucket
holds gzipped database dumps measured in tens of kilobytes and expires them
after 30 days, so it stays inside the free tier for a long while.

## Tearing it down

```bash
aws cloudformation delete-stack --region ap-south-1 --stack-name fleet-os-control-plane
```

The backup bucket is `DeletionPolicy: Retain` and survives deliberately —
deleting the stack should never be the thing that destroys your only copy of
the database. Empty and remove it by hand when you actually mean to.
