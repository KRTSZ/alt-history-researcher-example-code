"""
Alternative History Explorer — FastAPI backend
===============================================
All AI API calls and credentials live here.
The browser never sees a key or the system prompt.

Run:    uvicorn main:app --reload
Visit:  http://localhost:8000

Security model
--------------
- API keys are loaded from .env via python-dotenv; never hardcoded.
- The system prompt is stored here server-side only.
- The /api/ask endpoint proxies requests to the chosen AI provider.
- Free-tier users get FREE_DAILY_LIMIT requests/day (tracked by IP in memory).
  Replace _rate_counts with Redis for multi-process or production deployments.
- User-supplied keys are forwarded to the provider and never logged or stored.
- CORS is not configured; the frontend is served from the same origin.
"""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from datetime import date
from typing import Any, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

load_dotenv()  # reads .env into os.environ before anything else

# ── Configuration ──────────────────────────────────────────────────────────────

ANTHROPIC_KEY    = os.getenv("ANTHROPIC_KEY", "")
OPENAI_KEY       = os.getenv("OPENAI_KEY", "")
GOOGLE_KEY       = os.getenv("GOOGLE_KEY", "")
XAI_KEY          = os.getenv("XAI_KEY", "")
FREE_DAILY_LIMIT = int(os.getenv("FREE_DAILY_LIMIT", "5"))

# ── App setup ──────────────────────────────────────────────────────────────────

app = FastAPI(title="Alternative History Explorer")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# In-memory rate-limit store: { "IP:YYYY-MM-DD": count }
# For production (multiple workers / restarts), swap for Redis:
#   from redis import Redis; _redis = Redis(); _redis.incr(key); _redis.expire(key, 90000)
_rate_counts: dict[str, int] = defaultdict(int)

# ── System prompt ───────────────────────────────────────────────────────────────
# Kept server-side so the client never sees it. This reduces the prompt-injection
# surface and keeps your application logic private.

SYSTEM_PROMPT = """You are a rigorous historian and alternative history analyst \
with deep comparative knowledge across economic history, military history, \
institutional analysis, religious and intellectual history, and the histories \
of civilizations beyond the Western canon.

VERIFICATION PROTOCOL — apply before writing every sentence:
(1) TEMPORAL EXISTENCE: Verify every institution, technology, concept, or social \
structure existed in the specific time and place you describe.
(2) PERIODIZATION: Name the century and specific polity — never treat periods as \
homogeneous.
(3) CAUSAL CONNECTIONS: Verify scholarly support before asserting causation.
(4) SCHOLARLY VS. POPULAR: Flag where specialist consensus diverges from popular \
narrative.
(5) GEOGRAPHIC SPECIFICITY: Do not aggregate across regions with meaningfully \
different conditions.
(6) ANACHRONISM GUARD: Flag when using modern analytical categories as retrospective \
frameworks.

If this message follows prior messages, build directly on the prior exchange.

OUTPUT FORMAT:
- Output ONLY a single valid JSON object. No markdown, no code fences, no preamble.
- No // comments in the output. No literal newlines inside strings. No trailing commas.
- Arrays: scholarly_divergences 3-6; primary_sources 4-7; deep_dives 5-7; \
key_sources 5-8; unknowns 6-10.

{
  "pushback": "Argue back with genuine grounds, anchored in a specific named case. \
Empty string if no genuine objection.",
  "scholarly_divergences": [{"popular_claim": "...", "scholarly_reality": "...", \
"why_it_matters": "..."}],
  "reform": {"feasibility_pct": 0, "feasibility_label": \
"Not feasible|Marginally possible|Partially achievable|Substantially achievable|\
Highly feasible", "champions": "...", "resistance": "...", "closest_analog": "...", \
"realistic_ceiling": "..."},
  "scenario": "Multi-paragraph exploration.",
  "mindsets": "2-3 paragraphs on worldviews, religious assumptions, class structures.",
  "parallels": "3-4 historical parallels including disconfirming cases.",
  "primary_sources": [{"name": "...", "type": "Chronicle|Administrative record|\
Legal/fiscal text|Literary work|Inscription|Papyrus/manuscript|\
Archaeological evidence|Cartographic document|Numismatic evidence|\
Oral tradition (recorded)|Other", "period": "...", "what_it_contains": "...", \
"relevance": "...", "how_to_adapt": "...", "limitations": "...", "access": "..."}],
  "deep_dives": [{"topic": "...", "hook": "...", "best_source": "Author, Title (Year)",\
 "reliability": "Established|Supported|Debated|Speculative", "note": "..."}],
  "unknowns": ["..."],
  "key_sources": [{"claim": "...", "source": "...", \
"reliability": "Established|Supported|Debated|Speculative", \
"access": "Widely available|Major libraries|Academic databases (JSTOR etc.)|\
Specialized archives"}],
  "confidence": 0,
  "confidence_label": "Highly speculative|Speculative|Reasoned estimate|Well-grounded",
  "confidence_reason": "2-3 sentences."
}"""

# ── Request model ───────────────────────────────────────────────────────────────

class AskRequest(BaseModel):
    question:      str
    provider:      str            = "anthropic"
    model:         str            = "claude-opus-4-7"
    effort:        str            = "medium"
    user_key:      Optional[str]  = None   # user's own key; never logged or stored
    parent_q:      Optional[str]  = None   # previous question for follow-ups
    parent_result: Optional[dict] = None   # previous result for follow-ups

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/")
async def index(request: Request):
    """Serve the main HTML page, injecting server-side config into the template."""
    return templates.TemplateResponse("index.html", {
        "request":        request,
        "free_limit":     FREE_DAILY_LIMIT,
        "has_server_key": bool(ANTHROPIC_KEY),
    })


@app.get("/api/free-usage")
async def free_usage(request: Request):
    """
    Return today's free-tier usage for the caller's IP.
    The client uses this to show the "X of 5 free questions left" badge
    without storing the count in the browser (which users could manipulate).
    """
    ip    = _client_ip(request)
    today = str(date.today())
    used  = _rate_counts.get(f"{ip}:{today}", 0)
    return {"used": used, "limit": FREE_DAILY_LIMIT}


@app.post("/api/ask")
async def ask(body: AskRequest, request: Request) -> dict:
    """
    Proxy an AI request to the chosen provider.

    Key resolution order:
      1. body.user_key is set   → use it, skip rate limiting
      2. Server has a key for this provider → use it, apply rate limit (Anthropic only)
      3. Neither                → 400 error
    """
    user_key = (body.user_key or "").strip()
    api_key, apply_rate_limit = _resolve_key(body.provider, user_key)

    # Check and record rate limit before the (expensive) upstream call
    ip_day_key = ""
    if apply_rate_limit:
        ip        = _client_ip(request)
        today     = str(date.today())
        ip_day_key = f"{ip}:{today}"
        used      = _rate_counts[ip_day_key]
        if used >= FREE_DAILY_LIMIT:
            raise HTTPException(
                status_code=429,
                detail={
                    "error":        f"Daily free limit of {FREE_DAILY_LIMIT} questions reached.",
                    "rate_limited": True,
                    "used":         used,
                    "limit":        FREE_DAILY_LIMIT,
                },
            )

    messages = _build_messages(body)

    try:
        result, thinking = await _call_provider(
            body.provider, api_key, body.model, messages, body.effort
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Increment only after a successful response
    if apply_rate_limit and ip_day_key:
        _rate_counts[ip_day_key] += 1

    return {"result": result, "thinking": thinking}

# ── Internal helpers ────────────────────────────────────────────────────────────

def _client_ip(request: Request) -> str:
    """Return the real client IP, honouring X-Forwarded-For when behind a proxy."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _resolve_key(provider: str, user_key: str) -> tuple[str, bool]:
    """
    Return (api_key_to_use, should_rate_limit).

    - user_key present → always use it, no rate limit regardless of provider.
    - No user_key → fall back to the server-side key from .env.
      Only the Anthropic server key is rate-limited (it's the free-tier key).
      Other server keys (if configured) are not rate-limited.
    """
    if user_key:
        return user_key, False

    server_keys: dict[str, str] = {
        "anthropic": ANTHROPIC_KEY,
        "openai":    OPENAI_KEY,
        "google":    GOOGLE_KEY,
        "xai":       XAI_KEY,
    }
    key = server_keys.get(provider, "")
    if key:
        rate_limit = (provider == "anthropic")  # only the free-tier Anthropic key is limited
        return key, rate_limit

    raise HTTPException(
        status_code=400,
        detail=f"No API key available for '{provider}'. "
               f"Enter your own key in the app settings.",
    )


def _build_messages(body: AskRequest) -> list[dict]:
    """Build the messages array, prepending parent context for follow-up questions."""
    messages: list[dict] = []
    if body.parent_q and body.parent_result:
        messages.append({"role": "user",      "content": body.parent_q})
        messages.append({"role": "assistant", "content": json.dumps(body.parent_result)})
    messages.append({"role": "user", "content": body.question})
    return messages


async def _call_provider(
    provider: str,
    api_key:  str,
    model:    str,
    messages: list[dict],
    effort:   str,
) -> tuple[dict, str]:
    """Dispatch to the correct provider adapter."""
    if provider == "anthropic":
        return await _anthropic(api_key, model, messages, effort)
    if provider == "openai":
        return await _openai(api_key, model, messages)
    if provider == "google":
        return await _google(api_key, model, messages)
    if provider == "xai":
        return await _xai(api_key, model, messages)
    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")


def _parse_ai_json(text: str) -> dict:
    """
    Parse JSON from an AI response, tolerating common model mistakes:
    markdown code fences, leading // comment lines, extra blank lines.
    Falls back to extracting the outermost {...} block if direct parse fails.
    """
    clean = re.sub(r"^```json\s*", "", text, flags=re.MULTILINE)
    clean = re.sub(r"^```\s*",     "", clean, flags=re.MULTILINE)
    clean = re.sub(r"\s*```$",     "", clean, flags=re.MULTILINE)
    clean = re.sub(r"^\s*//[^\n]*","", clean, flags=re.MULTILINE)
    clean = clean.strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", clean)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
    raise HTTPException(
        status_code=502,
        detail=f"Model returned invalid JSON. First 300 chars: {clean[:300]}",
    )

# ── Provider adapters ───────────────────────────────────────────────────────────

async def _anthropic(
    api_key: str, model: str, messages: list[dict], effort: str
) -> tuple[dict, str]:
    """
    Call the Anthropic Messages API.
    Note: anthropic-dangerous-direct-browser-access is NOT sent because this
    request originates from a server, not a browser.
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key":         api_key,
                "anthropic-version": "2023-06-01",
                "content-type":      "application/json",
            },
            json={
                "model":         model,
                "max_tokens":    24000,
                "thinking":      {"type": "adaptive"},
                "output_config": {"effort": effort},
                "system":        SYSTEM_PROMPT,
                "messages":      messages,
            },
        )

    data = resp.json()
    if not resp.is_success:
        msg = data.get("error", {}).get("message", str(data))
        raise HTTPException(status_code=502, detail=f"Anthropic {resp.status_code}: {msg}")
    if data.get("stop_reason") == "max_tokens":
        raise HTTPException(
            status_code=502,
            detail="Response truncated (max_tokens). Try a shorter or simpler question.",
        )

    thinking_text = ""
    main_text     = ""
    for block in data.get("content", []):
        if block.get("type") == "thinking":
            thinking_text += block.get("thinking", "")
        elif block.get("type") == "text":
            main_text += block.get("text", "")

    return _parse_ai_json(main_text), thinking_text


async def _openai(api_key: str, model: str, messages: list[dict]) -> tuple[dict, str]:
    """
    Call the OpenAI Chat Completions API.
    o-series models use the 'developer' system role and don't support
    response_format=json_object.
    """
    is_o_series = bool(re.match(r"^o\d", model))
    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "developer" if is_o_series else "system", "content": SYSTEM_PROMPT},
            *messages,
        ],
        "max_completion_tokens": 16000,
    }
    if not is_o_series:
        payload["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
            json=payload,
        )

    data = resp.json()
    if not resp.is_success:
        msg = data.get("error", {}).get("message", str(data))
        raise HTTPException(status_code=502, detail=f"OpenAI {resp.status_code}: {msg}")

    return _parse_ai_json(data["choices"][0]["message"]["content"]), ""


async def _google(api_key: str, model: str, messages: list[dict]) -> tuple[dict, str]:
    """Call the Google Gemini GenerateContent API."""
    contents = [
        {
            "role":  "model" if m["role"] == "assistant" else "user",
            "parts": [{"text": m["content"]}],
        }
        for m in messages
    ]
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            f"?key={api_key}",
            headers={"content-type": "application/json"},
            json={
                "contents":          contents,
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "generationConfig":  {
                    "responseMimeType": "application/json",
                    "maxOutputTokens":  16000,
                },
            },
        )

    data = resp.json()
    if not resp.is_success:
        msg = data.get("error", {}).get("message", str(data))
        raise HTTPException(status_code=502, detail=f"Google {resp.status_code}: {msg}")

    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return _parse_ai_json(text), ""


async def _xai(api_key: str, model: str, messages: list[dict]) -> tuple[dict, str]:
    """Call the xAI Grok API (OpenAI-compatible format)."""
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.x.ai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
            json={
                "model":           model,
                "messages":        [{"role": "system", "content": SYSTEM_PROMPT}, *messages],
                "response_format": {"type": "json_object"},
                "max_tokens":      16000,
            },
        )

    data = resp.json()
    if not resp.is_success:
        msg = data.get("error", {}).get("message", str(data))
        raise HTTPException(status_code=502, detail=f"xAI {resp.status_code}: {msg}")

    return _parse_ai_json(data["choices"][0]["message"]["content"]), ""
