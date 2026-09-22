const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const express = require('express');

const { BOT_NAME, DISPLAY_CREATOR_NUMBER } = require('./bot/config');
const sessionManager = require('./bot/sessionManager');
const { startTelegramGateway } = require('./bot/telegramGateway');

const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 30);
const PAIR_ACCESS_KEY = process.env.PAIR_ACCESS_KEY || '';
const PAIR_WINDOW_MS = 10 * 60 * 1000;

let isExpressRunning = false;

// ---------- tiny in-memory rate limiter for the public pairing endpoint ----------
const hits = new Map();
function rateLimited(key, max, windowMs = PAIR_WINDOW_MS) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
        hits.set(key, recent);
        return true;
    }
    recent.push(now);
    hits.set(key, recent);
    return false;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
        if (!arr.some(t => now - t < PAIR_WINDOW_MS)) hits.delete(k);
    }
}, PAIR_WINDOW_MS).unref();

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function startExpressServer(commandsMap) {
    if (isExpressRunning) return;

    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '2kb' }));
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/', (req, res) => {
        res.send(`${BOT_NAME} is running.`);
    });

    // Tells the pair page whether it must show the access-key field.
    app.get('/api/pair/config', (req, res) => {
        res.json({ keyRequired: !!PAIR_ACCESS_KEY, botName: BOT_NAME });
    });

    app.post('/api/pair', async (req, res) => {
        if (PAIR_ACCESS_KEY && !safeEqual(req.body && req.body.key, PAIR_ACCESS_KEY)) {
            return res.status(401).json({ error: 'Invalid access key.' });
        }

        const cleanNumber = String((req.body && req.body.number) || '').replace(/[^0-9]/g, '');
        if (cleanNumber.length < 8 || cleanNumber.length > 15) {
            return res.status(400).json({ error: 'Enter a valid number with country code, digits only.' });
        }

        if (rateLimited(`ip:${req.ip}`, 5) || rateLimited(`num:${cleanNumber}`, 3)) {
            return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
        }

        const sessionId = `web-${cleanNumber}`;
        const active = sessionManager.getActiveSessions();
        const existing = active.find(s => s.sessionId === sessionId);

        if (existing && existing.connected) {
            return res.status(409).json({ error: 'This number is already linked.' });
        }
        if (!existing && active.length >= MAX_SESSIONS) {
            return res.status(503).json({ error: 'The bot is full right now. Try again later.' });
        }

        let responded = false;
        let timer = null;
        const respond = (status, body) => {
            if (responded) return;
            responded = true;
            clearTimeout(timer);
            res.status(status).json(body);
        };
        timer = setTimeout(() => respond(504, { error: 'Timed out waiting for pairing code.' }), 20000);

        try {
            await sessionManager.startSession({
                sessionId,
                ownerNumber: cleanNumber,
                isMain: false,
                commandsMap,
                onPairingCode: (code, errMsg) => {
                    if (code) respond(200, { code });
                    else respond(500, { error: errMsg || 'Pairing failed.' });
                }
            });
        } catch (err) {
            respond(500, { error: err.message || 'Failed to start session.' });
        }
    });

    app.listen(PORT, () => {
        isExpressRunning = true;
        console.log(`🌐 Web server listening on port ${PORT}`);
    });
}

process.on('uncaughtException', err => {
    console.error('🔥 [UNCAUGHT EXCEPTION]:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', reason => {
    console.error('🔥 [UNHANDLED REJECTION]:', reason);
});

function loadCommands() {
    const commandsMap = new Map();
    const commandPath = path.join(__dirname, 'commands');

    if (!fs.existsSync(commandPath)) {
        return commandsMap;
    }

    try {
        const commandFiles = fs
            .readdirSync(commandPath)
            .filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            try {
                const filePath = path.join(
                    commandPath,
                    file
                );

                delete require.cache[
                    require.resolve(filePath)
                ];

                const required = require(filePath);

                if (Array.isArray(required)) {
                    for (const cmd of required) {
                        if (cmd.name) {
                            commandsMap.set(
                                cmd.name,
                                cmd
                            );

                            if (Array.isArray(cmd.aliases)) {
                                for (const alias of cmd.aliases) {
                                    if (alias) {
                                        commandsMap.set(
                                            alias,
                                            cmd
                                        );
                                    }
                                }
                            }
                        }
                    }
                } else if (
                    required &&
                    required.name
                ) {
                    commandsMap.set(
                        required.name,
                        required
                    );

                    if (Array.isArray(required.aliases)) {
                        for (const alias of required.aliases) {
                            if (alias) {
                                commandsMap.set(
                                    alias,
                                    required
                                );
                            }
                        }
                    }
                }
            } catch (cmdLoadErr) {
                console.error(
                    `🔥 [COMMAND LOAD ERROR] File ${file}:`,
                    cmdLoadErr
                );
            }
        }

        console.log(
            `📂 Loaded ${commandsMap.size} commands successfully.`
        );
    } catch (dirErr) {
        console.error(
            '🔥 [COMMAND DIR ERROR]:',
            dirErr
        );
    }

    return commandsMap;
}

async function bootstrap() {
    console.log(`🔄 Starting ${BOT_NAME} (multi-session)...`);

    const commandsMap = loadCommands();

    startExpressServer(commandsMap);
    startTelegramGateway(commandsMap);

    if (DISPLAY_CREATOR_NUMBER) {
        await sessionManager.startSession({
            sessionId: 'main',
            ownerNumber: DISPLAY_CREATOR_NUMBER,
            isMain: true,
            commandsMap
        });
    } else {
        console.warn('⚠️ OWNER_NUMBER is not set: the main session was not started. ' +
            'Set OWNER_NUMBER in your environment/.env and restart to pair your own number.');
    }

    await sessionManager.restoreSessions(commandsMap);
}

bootstrap().catch(err => {
    console.error('🔥 [BOOTSTRAP ERROR]:', err);
});
