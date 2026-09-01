import { useEffect } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import Reveal from './ui/Reveal'
import StatusDot from './ui/StatusDot'
import { EASE } from '../lib/motion'

/**
 * The founder page.
 *
 * Deliberately not a PAGES entry: the doc shell gives every page a breadcrumb,
 * a "last updated" stamp and a table of contents, and all three are wrong for
 * this. Nobody wants a table of contents for a person.
 *
 * The argument the page has to make is narrow. Fleet OS asks for your machines,
 * your registry credentials and your customers' data. One person maintains it.
 * That is either disqualifying or it is the reason to trust it, and the only
 * way to land on the second is to be specific about both halves — which is why
 * "what one person can't give you" is on the page at the same size as what it
 * can.
 */

const WORK = [
  {
    name: 'Aarogya Setu',
    tag: 'multi-tenant SaaS',
    what: 'Hospital management for OPD and IPD — patient queues, electronic records, billing, separate tenants per hospital.',
    took: 'Tenancy is not a column you add later. It has to be in the first query you write or it is in none of them.',
  },
  {
    name: 'MuhDikhai',
    tag: 'realtime',
    what: 'Anonymous video chat. The WebRTC signalling is written by hand rather than rented from a service.',
    took: 'It is also the first real workload Fleet OS ever deployed, onto a mini PC on a college LAN. Everything that broke that day is fixed in the code now.',
  },
  {
    name: 'SecondMind / CortX',
    tag: 'firmware',
    what: 'A cognitive OS running on an ESP32-S3: voice in, a local model, speech back out, no phone in the loop.',
    took: 'Working in 512KB of RAM makes you honest about what a system actually needs. The Fleet agent is a single static binary for the same reason.',
  },
  {
    name: 'Tollgate',
    tag: 'current',
    what: 'Cost observability for LLM APIs — where the spend went, per route, per model.',
    took: 'In progress, and running on Fleet.',
  },
  {
    name: 'CineVerse',
    tag: 'product',
    what: 'Social film tracking across 500k+ titles from TMDB.',
    took: 'The first thing I built that strangers used, which is a different discipline from building something that works.',
  },
  {
    name: 'Maakosh',
    tag: 'sensors',
    what: 'Maternal health monitoring with wearable sensor integration.',
    took: 'Data from hardware is late, wrong and missing. Systems that assume otherwise fail in the field.',
  },
]

const BELIEFS = [
  {
    n: '01',
    claim: 'Your hardware is not a second-class deploy target.',
    why: 'A four-year-old laptop has more RAM than the instance most startups pay monthly for. The gap was never the machine, it was that nothing would schedule onto it.',
  },
  {
    n: '02',
    claim: 'The control plane should never be able to reach into your node.',
    why: 'Agents are outbound-only. There is no inbound port to expose, no key of mine on your machine, and nothing for me to compromise even if I wanted to. This closes doors for me as much as for an attacker, which is the point.',
  },
  {
    n: '03',
    claim: 'An error should say what to do, not what happened.',
    why: '"Deployment failed" is a shrug. "Waited 47s for a health check on :8080, container is running, nothing is listening" is an instruction. Almost every error string in Fleet has been rewritten at least once for this.',
  },
  {
    n: '04',
    claim: 'Nothing gets deleted because a machine guessed.',
    why: 'A service that vanishes from your fleet.yaml is reported, never removed. Volumes are never reclaimed automatically. A typo should not cost you data.',
  },
  {
    n: '05',
    claim: 'If you cannot leave, it is not really yours.',
    why: 'MIT licence, the whole control plane in one Docker Compose file, no telemetry. The exit is not a feature I tolerate — it is the only thing that makes the rest of the promises checkable.',
  },
]

const LINKS = [
  ['yaduraj.me', 'https://yaduraj.me', 'Everything else I have built.'],
  ['github.com/YadurajManu', 'https://github.com/YadurajManu', 'The source, and where issues get answered.'],
  ['linkedin.com/in/yadurajenc', 'https://www.linkedin.com/in/yadurajenc', 'The formal version.'],
]

function Whoami() {
  const reduce = useReducedMotion()
  const lines = [
    ['$', 'whoami'],
    ['>', 'yaduraj singh'],
    ['>', 'full-stack engineer · ai/ml · dehradun, india'],
    ['>', 'building fleet os, alone, in the open'],
  ]

  return (
    <div className="border border-[var(--color-line)] bg-[#07080a]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2">
        <span className="mono-label">session · founder</span>
        <StatusDot size={5} />
      </div>
      <div className="px-4 py-3.5 font-mono text-[12.5px] leading-[1.85]">
        {lines.map(([prefix, text], i) => (
          <motion.div
            key={text}
            initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.25 + i * 0.16, ease: EASE.expo }}
            className="flex gap-2.5"
          >
            <span className={prefix === '$' ? 'text-[var(--color-signal)]' : 'text-[var(--color-fg-dim)]'}>
              {prefix}
            </span>
            <span className={prefix === '$' ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]'}>
              {text}
            </span>
            {i === lines.length - 1 && <span className="caret" aria-hidden="true" />}
          </motion.div>
        ))}
      </div>
    </div>
  )
}

export default function Founder() {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  return (
    <article className="relative">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] dot-bg opacity-40" />

      {/* ── who ─────────────────────────────────────────────────────── */}
      <header className="rail relative border-b border-[var(--color-line)] pb-16 pt-28 lg:pt-32">
        <Reveal className="flex items-center gap-2.5 font-mono text-[11px]" y={8} duration={0.5}>
          <a href="#top" className="link-draw text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]">
            fleet·os
          </a>
          <span className="text-[var(--color-line-2)]">/</span>
          <span className="text-[var(--color-signal)]">the person behind it</span>
        </Reveal>

        <div className="mt-8 grid gap-12 lg:grid-cols-[1.15fr_1fr] lg:items-end">
          <div>
            <Reveal i={1}>
              <h1 className="text-[clamp(2.6rem,7vw,4.6rem)] font-semibold leading-[0.98] tracking-[-0.045em] text-balance">
                Yaduraj Singh
              </h1>
            </Reveal>
            <Reveal i={2}>
              <p className="mt-6 max-w-[46ch] text-[17px] leading-[1.65] text-[var(--color-fg-muted)] text-pretty">
                I am twenty, I write systems software, and I build the infrastructure I
                wanted to exist and could not find. Fleet OS is the largest of those, and
                the only one other people now depend on.
              </p>
            </Reveal>
          </div>

          <Reveal i={2}>
            <Whoami />
          </Reveal>
        </div>
      </header>

      {/* ── the letter ──────────────────────────────────────────────── */}
      <section className="border-b border-[var(--color-line)]">
        <div className="rail grid gap-12 py-20 lg:grid-cols-12 lg:py-24">
          <div className="lg:col-span-3">
            <Reveal className="sticky top-24">
              <span className="mono-label">why this exists</span>
            </Reveal>
          </div>

          <div className="min-w-0 lg:col-span-8">
            {[
              'I had a drawer of working computers. A Raspberry Pi, a laptop with a dead screen, a mini PC bought for a project that ended. Together that was more memory and more cores than anything I was renting, and every month I paid for cloud instances anyway — because there was no way to treat those machines as one place to deploy to.',
              'The tools that existed did not fit. Kubernetes wants a homogeneous cluster and a person to run it. Docker Compose stops at one host. The platform-as-a-service products are excellent and will happily rent you back a fraction of the hardware already sitting in your room. Nothing in the middle was interested in machines that were different from each other, sometimes off, and behind a home router with no static IP.',
              'So Fleet OS started as the thing I needed on a Sunday: point it at whatever you own, write one file, push. It picks a node that can actually run the thing — right architecture, enough memory, a GPU if you asked for one — builds for that architecture, routes traffic to it through a tunnel so nothing has to be port-forwarded, and moves the service somewhere else when the machine goes away.',
              'It stopped being a weekend project the first time it deployed something real. That was MuhDikhai, onto a mini PC on a college LAN, and it went badly in ways I could not have invented: a 111MB dependency turning image pulls into timeouts, a build cache too large for the CDN in front of it that failed the build after the image had already pushed, and a rollout state machine that decided healthy services were failures and tore them down. Every one of those is fixed, with a test, because I was the person the outage happened to.',
              'That is still the whole method. I run my own work on it. When it breaks it breaks for me first, and I do not get to close the ticket by explaining that it is working as designed.',
            ].map((para, i) => (
              <Reveal key={i} i={Math.min(i, 3)}>
                <p
                  className={
                    i === 0
                      ? 'text-[17.5px] leading-[1.7] text-[var(--color-fg)] text-pretty'
                      : 'mt-6 text-[15.5px] leading-[1.78] text-[var(--color-fg-muted)] text-pretty'
                  }
                >
                  {para}
                </p>
              </Reveal>
            ))}

            <Reveal i={3} className="mt-10 flex items-center gap-4 border-t border-[var(--color-line)] pt-7">
              <span className="h-px w-8 bg-[var(--color-signal)]" />
              <span className="font-mono text-[12px] text-[var(--color-fg-muted)]">
                Yaduraj · Dehradun, India
              </span>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── the honest trade ────────────────────────────────────────── */}
      <section className="border-b border-[var(--color-line)]">
        <div className="rail py-20 lg:py-24">
          <Reveal className="flex items-center gap-3" y={10} duration={0.5}>
            <span className="mono-label">what one person means</span>
            <span className="h-px flex-1 bg-[var(--color-line)]" />
          </Reveal>

          <Reveal i={1}>
            <h2 className="mt-5 max-w-[24ch] text-[clamp(1.8rem,4vw,2.8rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-balance">
              Both halves of it, at the same size.
            </h2>
          </Reveal>

          <Reveal i={2}>
            <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--color-fg-muted)] text-pretty">
              Every solo project page lists the advantages. The reason to read this one is
              that it also lists the cost, and you should weigh the second column before
              you put anything on Fleet that you cannot afford to lose.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-px bg-[var(--color-line)] lg:grid-cols-2">
            <Reveal className="bg-[var(--color-ink-950)] p-8 lg:p-10">
              <div className="flex items-center gap-2.5">
                <StatusDot size={6} />
                <span className="mono-label">what you get</span>
              </div>
              <ul className="mt-7 space-y-5">
                {[
                  ['The person who answers wrote the line that broke.', 'No first-line triage, no escalation path, no ticket that dies in a queue. You get the author, or you get nobody — and it has never yet been nobody.'],
                  ['Nothing ships to make a quarter look good.', 'There is no roadmap committee and no revenue target shaping what gets built. Features exist because something was actually annoying.'],
                  ['Decisions are cheap to reverse.', 'Managed databases, replicas and volume backups each went from idea to shipped inside a day. That speed is the one thing a small team beats a large one at.'],
                  ['You can read all of it.', 'MIT, every line, including the parts I am not proud of. There is no enterprise fork with the good bits in it.'],
                ].map(([h, p], i) => (
                  <li key={h} style={{ transitionDelay: `${i * 40}ms` }}>
                    <div className="text-[14.5px] font-medium leading-snug tracking-[-0.015em] text-[var(--color-fg)]">
                      {h}
                    </div>
                    <p className="mt-1.5 text-[13px] leading-[1.65] text-[var(--color-fg-muted)] text-pretty">
                      {p}
                    </p>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal i={1} className="bg-[var(--color-ink-950)] p-8 lg:p-10">
              <div className="flex items-center gap-2.5">
                <StatusDot size={6} tone="warn" />
                <span className="mono-label">what you do not</span>
              </div>
              <ul className="mt-7 space-y-5">
                {[
                  ['A support rota that covers the night.', 'I sleep. If your fleet falls over at 3am, it stays over until I am awake. Nothing about a paid tier changes this, and I will not sell you an SLA I cannot staff.'],
                  ['A bus factor above one.', 'If I stop, the project stops. The licence and the self-hosting path are the honest mitigation: the control plane is a Compose file and your nodes keep running whatever they are running, with or without me.'],
                  ['A compliance department.', 'No SOC 2, no signed BAA, no procurement questionnaire I can return. If your organisation requires those, Fleet OS is not yet the right choice and I would rather say so here than in a sales call.'],
                  ['Certainty about the shape of it in two years.', 'This is a young project. Interfaces will move. Where they move, migrations and a changelog entry come with them — but I am not going to pretend to a stability I have not yet earned.'],
                ].map(([h, p]) => (
                  <li key={h}>
                    <div className="text-[14.5px] font-medium leading-snug tracking-[-0.015em] text-[var(--color-fg)]">
                      {h}
                    </div>
                    <p className="mt-1.5 text-[13px] leading-[1.65] text-[var(--color-fg-muted)] text-pretty">
                      {p}
                    </p>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── prior work ──────────────────────────────────────────────── */}
      <section className="border-b border-[var(--color-line)]">
        <div className="rail py-20 lg:py-24">
          <Reveal className="flex items-center gap-3" y={10} duration={0.5}>
            <span className="mono-label">before this</span>
            <span className="h-px flex-1 bg-[var(--color-line)]" />
          </Reveal>

          <Reveal i={1}>
            <h2 className="mt-5 max-w-[26ch] text-[clamp(1.8rem,4vw,2.8rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-balance">
              Six things that had to survive contact with real use.
            </h2>
          </Reveal>

          <Reveal i={2}>
            <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--color-fg-muted)] text-pretty">
              Firmware in half a megabyte of RAM through to multi-tenant SaaS. The range is
              the point: Fleet OS is a Go agent, a TypeScript control plane, a React
              dashboard and a CLI, and it needed someone who had already been wrong in all
              four of those places.
            </p>
          </Reveal>

          <div className="mt-14 border-t border-[var(--color-line)]">
            {WORK.map((w, i) => (
              <Reveal
                key={w.name}
                i={Math.min(i, 3)}
                className="group grid gap-4 border-b border-[var(--color-line)] py-7 transition-colors duration-400 hover:bg-[var(--color-ink-900)] lg:grid-cols-12 lg:gap-8"
              >
                <div className="flex items-baseline gap-3 lg:col-span-3">
                  <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <div className="text-[16px] font-medium tracking-[-0.02em] text-[var(--color-fg)]">
                      {w.name}
                    </div>
                    <div className="mt-1 font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
                      {w.tag}
                    </div>
                  </div>
                </div>
                <p className="text-[13.5px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty lg:col-span-4">
                  {w.what}
                </p>
                <p className="border-l-2 border-[var(--color-line-2)] pl-4 text-[13px] leading-[1.7] text-[var(--color-fg-dim)] text-pretty transition-colors duration-400 group-hover:border-[var(--color-signal-dim)] lg:col-span-5">
                  {w.took}
                </p>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-8">
            <p className="font-mono text-[11.5px] leading-[1.9] text-[var(--color-fg-dim)]">
              TypeScript · Go · Swift · C/C++ · React · Next.js · Node · WebRTC · Postgres ·
              Redis · Docker · ESP32-S3
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── beliefs ─────────────────────────────────────────────────── */}
      <section className="border-b border-[var(--color-line)]">
        <div className="rail py-20 lg:py-24">
          <Reveal className="flex items-center gap-3" y={10} duration={0.5}>
            <span className="mono-label">what the product argues</span>
            <span className="h-px flex-1 bg-[var(--color-line)]" />
          </Reveal>

          <Reveal i={1}>
            <h2 className="mt-5 max-w-[24ch] text-[clamp(1.8rem,4vw,2.8rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-balance">
              Five positions it would be expensive to be wrong about.
            </h2>
          </Reveal>

          <div className="mt-14 grid gap-px bg-[var(--color-line)]">
            {BELIEFS.map((b, i) => (
              <Reveal
                key={b.n}
                i={Math.min(i, 3)}
                className="group grid gap-3 bg-[var(--color-ink-950)] p-7 transition-colors duration-400 hover:bg-[var(--color-ink-900)] lg:grid-cols-12 lg:gap-8 lg:p-9"
              >
                <div className="flex items-start gap-4 lg:col-span-6">
                  <span className="mt-1 font-mono text-[11px] text-[var(--color-signal)]">{b.n}</span>
                  <h3 className="text-[17px] font-medium leading-[1.35] tracking-[-0.025em] text-[var(--color-fg)] text-balance">
                    {b.claim}
                  </h3>
                </div>
                <p className="text-[13.5px] leading-[1.75] text-[var(--color-fg-muted)] text-pretty lg:col-span-6">
                  {b.why}
                </p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── reach ───────────────────────────────────────────────────── */}
      <section>
        <div className="rail py-20 lg:py-28">
          <div className="grid gap-14 lg:grid-cols-[1fr_1fr] lg:gap-20">
            <div>
              <Reveal className="flex items-center gap-3" y={10} duration={0.5}>
                <span className="mono-label">say something</span>
                <span className="h-px flex-1 bg-[var(--color-line)]" />
              </Reveal>

              <Reveal i={1}>
                <h2 className="mt-5 text-[clamp(1.8rem,4vw,2.8rem)] font-semibold leading-[1.05] tracking-[-0.035em] text-balance">
                  Mail reaches a person, not a queue.
                </h2>
              </Reveal>

              <Reveal i={2}>
                <p className="mt-5 max-w-[48ch] text-[15px] leading-relaxed text-[var(--color-fg-muted)] text-pretty">
                  Bug reports, a fleet doing something inexplicable, an argument with
                  something on this page, or a question about whether Fleet fits what you
                  are trying to do — including when the answer is that it does not.
                </p>
              </Reveal>

              <Reveal i={3} className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
                <a
                  href="mailto:hello@fleet-os.dev"
                  className="group font-mono text-[13.5px] text-[var(--color-signal)]"
                >
                  <span className="link-draw">hello@fleet-os.dev</span>
                </a>
                <a
                  href="https://github.com/YadurajManu"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-draw font-mono text-[13px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:text-[var(--color-fg)]"
                >
                  open an issue ↗
                </a>
              </Reveal>
            </div>

            <div className="grid gap-px self-start bg-[var(--color-line)]">
              {LINKS.map(([label, href, desc], i) => (
                <Reveal key={href} i={i}>
                  <motion.a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    whileHover={{ x: 3 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 24 }}
                    className="group block bg-[var(--color-ink-950)] p-6 transition-colors duration-400 hover:bg-[var(--color-ink-900)]"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-mono text-[13px] text-[var(--color-fg)]">{label}</span>
                      <span className="font-mono text-[11px] text-[var(--color-fg-dim)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
                        ↗
                      </span>
                    </div>
                    <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                      {desc}
                    </p>
                  </motion.a>
                </Reveal>
              ))}
            </div>
          </div>

          <Reveal className="mt-16 border-t border-[var(--color-line)] pt-8">
            <div className="flex flex-wrap items-center gap-x-7 gap-y-2 font-mono text-[12px]">
              <a href="#top" className="link-draw text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
                ← the product
              </a>
              <a href="#/docs" className="link-draw text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
                documentation
              </a>
              <a href="#/changelog" className="link-draw text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
                what shipped recently
              </a>
              <a href="#/about" className="link-draw text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
                about the project
              </a>
            </div>
          </Reveal>
        </div>
      </section>
    </article>
  )
}
