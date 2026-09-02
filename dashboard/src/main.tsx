import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import Shell from './components/Shell'
import SignIn from './pages/SignIn'
import Overview from './pages/Overview'
import Nodes from './pages/Nodes'
import Services from './pages/Services'
import ServiceDetail from './pages/ServiceDetail'
import Events from './pages/Events'
import Alerts from './pages/Alerts'
import Settings from './pages/Settings'
import Doctor from './pages/Doctor'
import Logs from './pages/Logs'
import CliAuth from './pages/CliAuth'
import ResetPassword from './pages/ResetPassword'
import VerifyEmail from './pages/VerifyEmail'
import { Logo } from './components/ui'
import './index.css'

function Gate() {
  const { ready, email } = useAuth()

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Logo size={30} />
      </div>
    )
  }
  // Reset and verify have to be reachable while signed out - that is the whole
  // situation they exist for. Returning <SignIn /> for every route when there
  // is no session would swallow both, and the link in the email would land on
  // a sign-in form the reader cannot get past.
  if (!email) {
    return (
      <Routes>
        <Route path="reset" element={<ResetPassword />} />
        <Route path="verify" element={<VerifyEmail />} />
        <Route path="*" element={<SignIn />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="cli-auth" element={<CliAuth />} />
      <Route path="reset" element={<ResetPassword />} />
      <Route path="verify" element={<VerifyEmail />} />
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="nodes" element={<Nodes />} />
        <Route path="services" element={<Services />} />
        <Route path="services/:serviceId" element={<ServiceDetail />} />
        <Route path="events" element={<Events />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="doctor" element={<Doctor />} />
        <Route path="logs" element={<Logs />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
