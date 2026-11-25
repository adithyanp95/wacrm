# WASenda AI salesperson (`agent/`)

A separate always-on Node app that answers WhatsApp leads for the CRM.

```
WhatsApp ─► CRM webhook ─► CRM saves message (+ voice transcript)
                              │  message.received (signed)
                              ▼
                        agent/  ── waits for the lead to stop typing
                              │  reads conversation   GET  /api/v1/agent/conversations/:id
                              │  searches knowledge    GET  /api/v1/agent/knowledge?q=
                              │  thinks (OpenAI)
                              ▼
                        replies / hands off  POST /api/v1/agent/conversations/:id/{reply,handoff,typing}
```

The CRM enforces every rule (AI on/off, **Take over**, pause, reply limit, stale replies). The agent can only ask; the CRM decides.

## What a turn does

1. A `message.received` webhook arrives. The agent waits `DEBOUNCE_MS` (10 s) for more messages, but never longer than `MAX_WAIT_MS` (30 s).
2. It reads the conversation. If the CRM says it may not reply (AI off, assigned, paused, limit reached), it stops.
3. It shows "typing…", searches the Knowledge base, and asks the model for a JSON decision:
   - `reply`: 1–3 short WhatsApp messages, sent with natural typing pauses.
   - `handoff`: an optional holding message, then the thread is paused and assigned to your handoff agent with a note.
4. If the lead wrote again meanwhile, the reply is dropped and the newer message gets its own turn. If the model fails, the thread is handed off rather than left silent.

Logs contain ids and outcomes only, never message text.

## Set it up (Hostinger)

Do the steps in this order, so there's never a gap where nobody replies.

### 1. CRM settings (Settings → AI)

- **AI** on, **Auto-reply** on (the agent respects these switches).
- **Reply limit**: 20. **Handoff agent**: whoever should get handed-off leads.
- **System prompt**: your business persona and sales flow (see `META_ADS_SALES_PROMPT_PRESET` in `src/lib/ai/defaults.ts`).
- **Knowledge base**: your current prices and offers.

### 2. Two API keys (Settings → API keys)

- **Agent key**: only the `ai:agent` scope. This goes into the agent's `WACRM_API_KEY`.
- **Setup key**: only `webhooks:manage`, used once in step 4. Revoke it afterwards.

### 3. Deploy the agent on Hostinger

Add a new **Node.js app** from the same GitHub repo and the `deployment` branch:

| Setting | Value |
|---|---|
| Framework preset | **Express** (not Next.js) |
| Root directory | `agent` |
| Node version | 22 |
| Package manager | npm |
| Entry file | `server.js` (the default) |
| Domain | Hostinger's own `*.hostingersite.com` address, or e.g. `agent.yourdomain.com` |

The Express preset has no build command, and none is needed: `npm install` compiles the TypeScript through the `postinstall` script, and `server.js` starts the compiled app.

Environment variables (see `.env.example`): `WACRM_URL`, `WACRM_API_KEY`, `OPENAI_API_KEY`, and `WACRM_WEBHOOK_SECRET` (from step 4; redeploy after adding it).

Check `https://agent.yourdomain.com/health` returns `{"ok":true,…}`.

### 4. Point the CRM's webhook at the agent

```powershell
$headers = @{ Authorization = "Bearer <setup key>" }
$body = '{"url":"https://agent.yourdomain.com/webhooks/wacrm","events":["message.received"]}'
Invoke-RestMethod -Method Post -Uri "https://<your CRM>/api/v1/webhooks" -Headers $headers -ContentType "application/json" -Body $body
```

The response contains `secret` **once**. Put it in the agent's `WACRM_WEBHOOK_SECRET` and redeploy the agent.

### 5. Switch the CRM to external mode

On the **CRM** app in Hostinger, add `AI_AGENT_MODE=external` and redeploy. The built-in auto-reply now stands down and the agent answers. To roll back, remove the variable and redeploy.

### 6. Test

Send "META", then a voice note, from a phone that isn't assigned to anyone. You should see "typing…", then 1–3 short replies. Ask for a call: you should get a holding message, and the chat moves to your handoff agent with a note.

## Working with the agent day to day

- **Replying by hand?** Click **Take over** first. Otherwise the agent may answer the lead's next message too.
- **Give a chat back to the AI:** **Resume AI**. This also resets that chat's reply count.
- **Why didn't it reply?** Check the agent's logs in Hostinger for `skip` lines with a `reason`.

## Known limits (next milestones)

- The CRM sends each webhook once. If the agent is down at that moment, that message isn't answered until the lead writes again. A catch-up sweep is planned.
- Pending turns live in memory, so a redeploy drops any turn that was waiting out its 10 s debounce.
- No lead memory, CRM write-back, research or voice replies yet (Phases 2–4).

## Develop

```powershell
cd agent
npm install
npm test
npm run build
```
