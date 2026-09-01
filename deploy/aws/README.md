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
