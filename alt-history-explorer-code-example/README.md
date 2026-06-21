# Alternative History Explorer

A web app for exploring counterfactual history questions with AI. Ask "What if the Byzantine Empire had not fallen in 1453?" and get a structured, scholarly analysis across 11 interactive panels — covering the alternative scenario, historian objections, primary sources, scholarly divergences, and more.

Supports multiple AI providers (Anthropic, OpenAI, Google Gemini, xAI Grok) with a secure proxy architecture that keeps API keys server-side.

## Features

- **Multi-provider AI** — query Anthropic Claude, OpenAI GPT, Google Gemini, or xAI Grok; compare responses side by side
- **Secure API key proxy** — a Cloudflare Worker sits between the browser and AI APIs; your real API key never touches the client
- **Free tier with rate limiting** — 5 free questions/day per IP, tracked in Cloudflare KV; users can add their own API key for unlimited use
- **11-panel carousel UI** — swipeable cards covering: scenario narrative, historian's objection, scholarly divergences, reform feasibility, period mindsets, historical parallels, primary sources, deep dives, unknowns, key sources with citations, and confidence assessment
- **Search history** — previous questions stored locally with instant replay
- **Mobile-first** — designed for Android/iOS with PWA support (add to home screen)
- **FastAPI alternative** — full Python backend included for local development or self-hosted deployments

## Architecture

```
Browser (vanilla JS)
  |
  |  POST /  (JSON body — same shape as Anthropic Messages API)
  v
Cloudflare Worker (alt-history-worker.js)
  |
  |  Adds API key from encrypted secret
  |  Enforces rate limit via KV counter
  v
AI Provider API (Anthropic / OpenAI / Google / xAI)
```

**Security model:**
- API keys are stored as Cloudflare Secrets (encrypted at rest, never in code)
- The Worker never returns the key in any response
- Rate limiting is enforced server-side; the client-side counter is just UX
- User-supplied keys are forwarded to the provider and never logged or stored

## Quick Start — Cloudflare Worker

1. **Sign up** at [cloudflare.com](https://cloudflare.com) (free, no credit card)

2. **Install Wrangler** (Cloudflare's CLI):
   ```bash
   npm install -g wrangler
   wrangler login
   ```

3. **Deploy the Worker:**
   ```bash
   wrangler deploy
   ```

4. **Add your API key** as a secret:
   ```bash
   wrangler secret put ANTHROPIC_KEY
   # Paste your sk-ant-... key when prompted
   ```

5. **Create a KV namespace** for rate limiting:
   ```bash
   wrangler kv namespace create RATE_LIMITS
   ```
   Copy the namespace ID into `wrangler.toml` (replace `YOUR_KV_NAMESPACE_ID_HERE`), then redeploy:
   ```bash
   wrangler deploy
   ```

6. **Visit your Worker URL** — shown after deploy, e.g. `https://alt-history-researcher.your-subdomain.workers.dev`

## Quick Start — FastAPI (Local)

```bash
cd alt-history-fastapi
python -m venv .venv && source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt

# Create .env with your API keys
cat > .env << EOF
ANTHROPIC_KEY=sk-ant-...
OPENAI_KEY=sk-...
GOOGLE_KEY=AIza...
XAI_KEY=xai-...
FREE_DAILY_LIMIT=5
EOF

uvicorn main:app --reload
# Visit http://localhost:8000
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | Vanilla JS, CSS (no framework) |
| API Proxy | Cloudflare Workers |
| Rate Limiting | Cloudflare KV |
| Deployment | Wrangler CLI |
| Backend Alt | FastAPI (Python) |
| AI Providers | Anthropic Claude, OpenAI, Google Gemini, xAI Grok |

## Project Structure

```
alt-history-showcase/
  alt-history-worker.js    # Cloudflare Worker — API proxy + rate limiter
  wrangler.toml            # Cloudflare deployment config
  public/
    index.html             # Single-page app (carousel UI, all providers)
  alt-history-fastapi/     # Alternative Python backend
    main.py                # FastAPI server with all provider adapters
    requirements.txt
    static/                # Frontend assets (FastAPI version)
    templates/             # Jinja2 templates
```

## License

MIT
