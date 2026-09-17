# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Everyday Chrome users who want an AI agent to do things on web pages for them: filling forms, pulling out data, or scanning a page for personal data. They aren't necessarily technical, and the panel has to make sense to anyone at first glance. Many handle Indian identity documents (Aadhaar, PAN) and payment cards.

## Product Purpose
PRY Agent is a Chrome side-panel agent that carries out tasks on the current page. It detects and redacts passwords, IDs, and personal data on the device *before* any screenshot or page text reaches an AI model. Success means the user gets the task done and can see that nothing sensitive left the browser.

## Positioning
The redaction runs on the device and is provable: OCR plus checksum validation (Luhn, Verhoeff) runs in the browser, a MAIN-world tripwire watches outbound requests, and every run writes a tamper-evident privacy ledger. The model only ever sees redacted pixels and tokenized text.

## Operating Context
- The extension lives in Chrome's side panel, a narrow column (about 360–420px) next to the page being worked on.
- The user types a task or picks a suggestion, watches the steps stream in, and approves risky actions.
- Afterwards they can inspect the privacy audit, tripwire radar, history, and self-improvement stats.

## Capabilities and Constraints
- Supported model providers: Ollama (local, no key), Anthropic, OpenAI, OpenRouter, Groq, and NVIDIA NIM. Keys are the user's own and stored in `chrome.storage.local`.
- There is no backend.
- The shipped JS is minified build output with no source in this folder. UI changes must keep every element ID and class the bundles reference.
- The CSP forbids remote scripts.

## Brand Commitments
- Name: **Pawtrol** (renamed from PRY Agent on 2026-09-16; pet-themed, since the agent fetches things and guards your data). Internal identifiers keep the `pry-` / `__PRY_` prefix so saved data keeps working.
- The user supplied a binding visual reference: a light grey ground, a steel-blue accent, condensed uppercase labels, a "run ledger" framed with crosshair corners, a greeting that rotates per new chat ("Hey [name], what's on your mind?"), and the model switcher next to the composer. The overall feel should be minimal and simple for anyone.

## Evidence on Hand
Page entity counts come only from real privacy-audit and tripwire data. Latency, customer, or benchmark figures don't exist and must not be invented.

## Product Principles
- Privacy you can see: always show what was detected and what was blocked.
- Plain language first; technical detail stays one tap away.
- Never obstruct the task. Suggestions and state support typing, not replace it.
