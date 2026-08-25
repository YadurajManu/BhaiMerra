import express from 'express'

const app = express()
const port = process.env.PORT || 3000

app.use(express.json())

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Fleet OS Demo API</title>
        <style>
          body { font-family: monospace; background: #0b0f12; color: #55ee9c; display: flex; height: 100vh; align-items: center; justify-content: center; margin: 0; }
          .card { border: 1px solid #1f2933; padding: 2rem; border-radius: 8px; background: #12181f; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
          h1 { color: #ffffff; margin-bottom: 0.5rem; }
          p { color: #8d99a6; }
          .badge { background: rgba(85, 238, 156, 0.1); border: 1px solid rgba(85, 238, 156, 0.3); padding: 4px 12px; border-radius: 4px; display: inline-block; font-size: 14px; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>⚡ Deployed with Fleet OS (`fleet up`)</h1>
          <p>Running live on your node: <strong>vattyji</strong></p>
          <div class="badge">Status: HEALTHY</div>
        </div>
      </body>
    </html>
  `)
})

app.get('/api/info', (req, res) => {
  res.json({
    service: 'demo-api',
    deployedWith: 'fleet up',
    node: process.env.NODE_NAME || 'vattyji',
    uptimeSeconds: Math.floor(process.uptime()),
  })
})

app.listen(port, () => {
  console.log(`Demo API listening on port ${port}`)
})
