/**
 * What Fleet's own failure codes mean.
 *
 * These are not logs from somebody else's build — they are messages this
 * system wrote about itself, from a fixed vocabulary. So the answer is known
 * ahead of time, and asking a model would be worse in every direction: slower,
 * charged against a daily limit, and liable to explain the English word
 * "drift" rather than what Fleet does when a container goes missing.
 *
 * The AI explainer stays for what genuinely needs reading: a build log Fleet
 * has never seen. This covers what it already knows.
 */

export type ReasonHelp = {
  /** Plain-language restatement — what actually happened. */
  what: string
  /** What to do about it, or why nothing needs doing. */
  next: string
}

const CODES: Record<string, ReasonHelp> = {
  drift: {
    what:
      'The control plane expected this container to be running on the node, and the node reported it missing. ' +
      'Something removed or stopped it outside of Fleet — a manual `docker rm`, a daemon restart, or the machine running out of memory.',
    next:
      'Deploy again to put it back. If it keeps happening, check the node for something else managing containers, ' +
      'and look at the container logs from before it disappeared.',
  },
  no_eligible_node: {
    what:
      'The scheduler had nowhere to put this service. Every node was either offline, out of the memory the service asks for, ' +
      'the wrong architecture, or excluded by a pin or anti-affinity rule.',
    next:
      'On a single-node fleet this usually means that node was down at the time. It is retried automatically when a node comes back, ' +
      'so a service that failed this way while a node was restarting will return on its own.',
  },
  node_down_pinned: {
    what:
      'This service is pinned to one node, and that node went offline. Fleet did not move it — pinned services are never relocated ' +
      'automatically, because their data lives on that machine and a database that follows the scheduler is a database that loses its disk.',
    next:
      'Bring the node back and Fleet resumes the service there by itself. Nothing needs doing here unless the node is gone for good, ' +
      'in which case restore from a backup onto another node.',
  },
}

/**
 * Messages that are a single line but not from the fixed vocabulary.
 *
 * Matched on a distinctive fragment rather than the whole string, because they
 * carry the offending path and would otherwise need an entry per project.
 */
const PATTERNS: Array<{ test: RegExp; help: ReasonHelp }> = [
  {
    test: /build context .* does not exist in the checkout/,
    help: {
      what:
        'The control plane had no copy of the source to build. A service that builds from a directory rather than a connected ' +
        'repository only has source on the machine that ran `fleet up`: the CLI uploads it with each deploy, and it is removed once the build finishes.',
      next:
        'Run `fleet up <service>` from the project directory. Deploying this service from the dashboard cannot work — there is nothing on the server to build.',
    },
  },
  {
    // "the container is restarting and never reported healthy…" — a crash
    // loop, which reads like a timeout and is not one. Distinct from the
    // pattern below: there the node said nothing, here it said the container
    // is up and failing.
    test: /the container is .* and never reported healthy/,
    help: {
      what:
        'The container started, failed its health check, and Docker restarted it — repeatedly — until the deploy gave up. ' +
        'The image is fine; something inside it is exiting or refusing requests.',
      next:
        'Read the container logs for this deployment: the reason is almost always in the first few lines after each restart — ' +
        'a missing environment variable, a database it cannot reach, or a port it is not listening on.',
    },
  },
  {
    test: /never reported this container within the rollout window/,
    help: {
      what:
        'The deployment was given a window to start and report healthy, and the node never confirmed the container within it. ' +
        'Usually the node was unreachable while the clock ran, rather than the container being genuinely broken.',
      next:
        'Check whether the node was online at that time. If it was, look at the container logs — an image that crashes on startup looks the same from here.',
    },
  },
]

/** The explanation for a failure reason, or null when there is nothing to add. */
export function helpFor(reason: string | null | undefined): ReasonHelp | null {
  if (!reason) return null
  const code = reason.trim()
  if (CODES[code]) return CODES[code]!
  return PATTERNS.find((p) => p.test.test(code))?.help ?? null
}
