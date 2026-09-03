#!/usr/bin/env bash
#
# What is wrong with the control-plane box, and what to reclaim.
#
# Written for the case where SSH itself has stopped working. Lightsail's
# browser console reports UPSTREAM_ERROR [515] when the instance closes the
# connection, and AWS lists the causes as: sshd down, sshd moved off port 22,
# or CPU/memory exhausted. A box that keeps serving traffic while refusing new
# logins is the signature of the third one - resident containers are already
# mapped and keep answering, but nothing new can fork.
#
# On this box the usual culprit is not mysterious. It builds multi-arch images
# with `docker buildx` and hosts a registry, and neither prunes itself. A day
# of deploys is tens of gigabytes of build cache.
#
# Read-only by default. Nothing is deleted unless you pass --reclaim.
set -uo pipefail

h() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

h "disk"
df -h / /var/lib/docker 2>/dev/null | awk 'NR==1 || /\//'
# The number that matters: a filesystem at 100% cannot fork a login shell,
# write a lock file, or accept a push.
FULL=$(df --output=pcent / 2>/dev/null | tr -dc '0-9')
[ -n "${FULL:-}" ] && [ "$FULL" -ge 90 ] && printf '  \033[31mroot filesystem at %s%%\033[0m\n' "$FULL"

h "memory"
free -h 2>/dev/null || vm_stat 2>/dev/null | head -5

h "what the kernel killed"
# An OOM kill is the difference between "slow" and "sshd could not start".
(journalctl -k --since '24 hours ago' 2>/dev/null | grep -iE 'oom|killed process' | tail -10) \
  || echo "  no journal access"

h "sshd"
systemctl is-active ssh.socket ssh 2>/dev/null | paste -sd' ' -
ss -tlnp 2>/dev/null | grep -E ':(22|2222) ' || echo "  NOTHING IS LISTENING ON 22 OR 2222"
# Socket activation caps concurrent connections. A public IP on port 22 attracts
# continuous brute-force traffic, and saturating the cap refuses everyone -
# including Lightsail's own relay, which looks exactly like a 515.
systemctl show ssh.socket -p MaxConnections -p NAccepted -p NConnections 2>/dev/null | sed 's/^/  /'

h "docker space, largest first"
docker system df 2>/dev/null || echo "  docker unavailable"

h "containers"
docker ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null

h "biggest directories under /var"
du -xh --max-depth=2 /var 2>/dev/null | sort -rh | head -8

if [ "${1:-}" = "--reclaim" ]; then
  h "reclaiming"
  # Build cache only. Deliberately NOT `system prune -a`, which would delete
  # the images the running stack was built from and the registry's own data -
  # the two things on this box that are expensive to recreate.
  docker buildx prune -af 2>/dev/null | tail -2
  docker image prune -f 2>/dev/null | tail -1
  # Journals are the other quiet consumer: uncapped, they grow to 10% of disk.
  journalctl --vacuum-size=200M 2>/dev/null | tail -1
  apt-get clean 2>/dev/null
  h "disk after"
  df -h / | awk 'NR==1 || /\//'
  echo
  echo "  To stop this recurring, cap the journal and prune weekly:"
  echo "    sudo sed -i 's/^#\\?SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf"
  echo "    sudo systemctl restart systemd-journald"
  echo "    echo '0 4 * * 0 docker buildx prune -af' | sudo crontab -"
else
  printf '\n  Read-only pass. Re-run with --reclaim to free space.\n'
fi
