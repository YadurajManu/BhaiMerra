// The full site map. Used by the mobile menu and kept next to the footer
// columns so the two can never drift apart.
export const SITE_MAP = [
  {
    heading: 'Product',
    links: [
      ['How it works', '#how'],
      ['Failover', '#failover'],
      ['Compare', '#compare'],
      ['CLI and API', '#cli'],
      ['Pricing', '#pricing'],
      ['Who built this', '#builder'],
      ['Changelog', '#/changelog'],
    ],
  },
  {
    heading: 'Developers',
    links: [
      ['Documentation', '#/docs'],
      ['fleet.yaml spec', '#/docs/fleet-yaml'],
      ['Scheduler', '#/docs/scheduler'],
      ['Mesh networking', '#/docs/mesh'],
      ['Failover and reclaim', '#/docs/failover'],
      ['CLI reference', '#/docs/cli'],
      ['REST API', '#/docs/api'],
      ['Self-hosting', '#/docs/self-hosting'],
      ['Source', '#/github'],
    ],
  },
  {
    heading: 'Company',
    links: [
      ['About', '#/about'],
      ['Who builds it', '#/founder'],
      ['Writing', '#/blog'],
      ['Roadmap', '#/roadmap'],
      ['Security', '#/security'],
      ['Status', '#/status'],
      ['Contact', '#/contact'],
      ['Community', '#/community'],
    ],
  },
  {
    heading: 'Legal',
    links: [
      ['Privacy notice', '#/legal/privacy'],
      ['Terms of service', '#/legal/terms'],
      ['Licence', '#/legal/licence'],
    ],
  },
]
