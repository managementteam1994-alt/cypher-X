# Cypher X-MD

Multi-session WhatsApp group-management bot (Baileys). Anyone can link their own number through the web pairing page.

## Setup (Katabump or any Node host)

1. Upload the project **without** `node_modules`. Node 20+ is required.
2. Startup command: `npm start` (it runs `npm install` first if the panel does not).
3. Add the variables from `.env.example` (panel variables, or a `.env` file):
   - `OWNER_NUMBER` – your number, country code, digits only (your main session)
   - `BOT_NAME`, `OWNER_NAME`
   - `PAIR_ACCESS_KEY` – **set this**, otherwise anyone who finds the page can link numbers
4. Start it. The console prints a pairing code for your main number:
   WhatsApp → Linked Devices → Link with phone number.
5. Others pair at `/pair.html` on your public URL (needs the access key if you set one).

Keep the `auth_info/` folder and the `*.json` state files on persistent storage.

## Large groups

- Group metadata is cached (10 min TTL, refreshed on join/leave/promote events) and shared between handlers.
- Activity counters live in memory and are flushed to disk every 5 s (atomic write) instead of rewriting the file on every message.
- Settings JSON is re-parsed only when the file changes.
- Incoming messages go through a per-chat ordered queue with a global concurrency cap, so one slow command or one busy group can't block the rest.
- Messages older than 3 minutes (offline backlog after a restart) are skipped instead of replayed.
- Outgoing messages are paced (5 concurrent, 100 ms gap) to avoid rate limits.
- Device lookups for big groups are batched (`scripts/patch-baileys.js`, applied on `npm install`).

All limits are tunable from the environment (see `.env.example`).

## Security notes

- Nobody has hidden access. Owner rights on other people's sessions are **off** unless you set `HOST_ADMIN_ACCESS=true`, and you should tell your users if you do.
- The Telegram gateway is off unless you set your own `TELEGRAM_BOT_TOKEN`.
- Pairing endpoint: access key, per-IP and per-number rate limits, and a `MAX_SESSIONS` cap.
- The Baileys dependency is a third-party fork (`@innovatorssoft/baileys`). Review it, or switch to the official `@whiskeysockets/baileys` and re-test.

## Games (trivia, quiz, scramble)

`!game start trivia easy 10` · `!game start quiz medium 10` · `!game start scramble easy 10`
`!game scores` (anyone) · `!game stop` (admins/owner). Add `first` to score only the first correct answer.

- Every member who answers correctly earns +5 points; the round closes a few seconds after the first correct answer (`GAME_GRACE_SECONDS`), then the next question follows.
- Trivia/quiz: reply A, B, C or D, one try per member per round. Options are reshuffled each round.
- Scramble: type the word; wrong guesses are ignored.
- Only real answers are consumed by the game; other chat still goes through anti-spam/anti-link/badwords.
- Questions don't repeat between games in the same group until the pool runs out.
- Other games in the menu (guess, emoji, lyrics...) are not built yet and reply "coming soon".
