import { useEffect } from 'react'
import Nav from './components/Nav'
import Hero from './components/Hero'
import Problem from './components/Problem'
import HowItWorks from './components/HowItWorks'
import Features from './components/Features'
import Failover from './components/Failover'
import Comparison from './components/Comparison'
import Terminal from './components/Terminal'
import Pricing from './components/Pricing'
import FinalCTA from './components/FinalCTA'
import Footer from './components/Footer'
import PageShell from './components/PageShell'
import { useSmoothScroll } from './lib/useCapability'
import { useRoute } from './lib/router'
import { useDocumentTitle } from './lib/useDocumentTitle'

function Landing() {
  return (
    <>
      <Hero />
      <Problem />
      <HowItWorks />
      <Features />
      <Failover />
      <Comparison />
      <Terminal />
      <Pricing />
      <FinalCTA />
    </>
  )
}

export default function App() {
  const route = useRoute()
  useDocumentTitle(route)
  useSmoothScroll()

  // Arriving at the landing page with a section anchor (from a sub-page link)
  // needs the section to exist before we can scroll to it.
  useEffect(() => {
    if (route !== null) return
    const id = window.location.hash.slice(1)
    if (!id || id.startsWith('/')) return
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' })
    }, 60)
    return () => clearTimeout(t)
  }, [route])

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="grain" aria-hidden="true" />
      <Nav onPage={route !== null} />
      <main id="main" tabIndex={-1}>
        {route === null ? <Landing /> : <PageShell route={route} />}
      </main>
      <Footer />
    </>
  )
}
