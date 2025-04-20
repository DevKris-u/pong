const WebSocket = require('ws');
const express = require('express');
const sanitizeHtml = require('sanitize-html');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let Low, JSONFile, db;
try {
    Low = require('lowdb').Low;
    JSONFile = require('lowdb/node').JSONFile;
} catch (e) {
    console.error('Błąd ładowania lowdb:', e.message);
    Low = null;
}

const app = express();
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/reset-leaderboard', (req, res) => {
    if (db) {
        db.data.scores = [];
        db.write().then(() => res.send('Tabela liderów zresetowana')).catch(() => res.status(500).send('Błąd'));
    } else {
        fallbackScores.scores = [];
        res.send('Tabela liderów zresetowana');
    }
});

let fallbackScores = { scores: [] };
if (Low) {
    const filePath = path.join(__dirname, 'scores.json');
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify({ scores: [] }));
    const adapter = new JSONFile(filePath);
    db = new Low(adapter, { scores: [] });
    db.read().catch(() => db.data = { scores: [] });
} else {
    db = { data: fallbackScores, write: () => Promise.resolve() };
}

const server = app.listen(process.env.PORT || 3000);
const wss = new WebSocket.Server({ server });
const rooms = {};
const sessions = {};
const UPDATE_INTERVAL = 1000 / 20; // 20 FPS
const MAX_BALL_SPEED = 10;
const KEEP_ALIVE_INTERVAL = 10000; // Ping co 10s

function createRoom(room) {
    if (!rooms[room]) {
        rooms[room] = {
            players: {},
            spectators: {},
            ball: { x: 400, y: 200, dx: 5, dy: 5, r: 10 },
            scores: [0, 0],
            activity: {},
            startTime: Date.now(),
            pendingUpdates: {},
            lastHitTime: 0
        };
    }
}

function syncRoomState(room) {
    if (!rooms[room]) return;
    broadcast(room, {
        type: 'update',
        p: rooms[room].players,
        b: rooms[room].ball,
        s: rooms[room].scores
    });
}

// Keep-alive
setInterval(() => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
            client.lastPing = Date.now();
        }
    });
}, KEEP_ALIVE_INTERVAL);

wss.on('connection', (ws) => {
    let clientId, roomName, nickname, isSpectator = false, sessionId = uuidv4();

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch {
            return;
        }

        if (data.type === 'join') {
            nickname = sanitizeHtml(data.nickname || 'Widz').slice(0, 20);
            roomName = sanitizeHtml(data.room || 'default').slice(0, 20);
            isSpectator = data.isSpectator || false;
            sessionId = data.sessionId || sessionId;
            createRoom(roomName);

            if (!isSpectator) {
                let playerCount = Object.keys(rooms[roomName].players).length;
                if (sessions[sessionId] && sessions[sessionId].room === roomName && rooms[roomName].players[sessions[sessionId].clientId]) {
                    clientId = sessions[sessionId].clientId;
                    rooms[roomName].players[clientId].nickname = nickname;
                    rooms[roomName].players[clientId].disconnected = false;
                    console.log(`Gracz ${nickname} ponownie dołączył jako ${clientId}`);
                } else if (playerCount >= 2) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Pokój pełny!' }));
                    ws.close();
                    return;
                } else {
                    clientId = playerCount.toString();
                    rooms[roomName].players[clientId] = { x: clientId === '0' ? 10 : 780, y: 170, id: clientId, nickname, disconnected: false };
                    sessions[sessionId] = { room: roomName, clientId };
                    console.log(`Nowy gracz ${nickname} dołączył jako ${clientId}`);
                }
                resetBall(roomName);
            } else {
                clientId = `s_${Object.keys(rooms[roomName].spectators).length}`;
                rooms[roomName].spectators[clientId] = { nickname };
            }

            ws.clientId = clientId;
            ws.isSpectator = isSpectator;
            ws.roomName = roomName;
            ws.sessionId = sessionId;
            rooms[roomName].activity[clientId] = Date.now();
            ws.send(JSON.stringify({
                type: 'init',
                id: clientId,
                sessionId,
                players: rooms[roomName].players,
                ball: rooms[roomName].ball,
                scores: rooms[roomName].scores,
                isSpectator,
                startTime: rooms[roomName].startTime
            }));
            syncRoomState(roomName); // Synchronizuj stan dla wszystkich
            broadcastRooms();
        } else if (data.type === 'move' && clientId && !isSpectator && rooms[roomName]) {
            rooms[roomName].pendingUpdates[clientId] = Math.max(0, Math.min(400 - 60, data.y));
            rooms[roomName].activity[clientId] = Date.now();
        } else if (data.type === 'chat' && clientId && rooms[roomName]) {
            const msg = sanitizeHtml(data.message).slice(0, 100);
            if (msg) broadcast(roomName, { type: 'chat', n: nickname, m: msg });
            rooms[roomName].activity[clientId] = Date.now();
        } else if (data.type === 'spectatorChat' && clientId && isSpectator && rooms[roomName]) {
            const msg = sanitizeHtml(data.message).slice(0, 100);
            if (msg) broadcastSpectators(roomName, { type: 'spectatorChat', n: nickname, m: msg });
            rooms[roomName].activity[clientId] = Date.now();
        } else if (data.type === 'getRooms') {
            broadcastRooms();
        }
    });

    ws.on('pong', () => {
        ws.lastPing = Date.now();
    });

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
});

function handleDisconnect(ws) {
    const { clientId, roomName, isSpectator, sessionId } = ws;
    if (clientId && roomName && rooms[roomName]) {
        if (isSpectator) {
            delete rooms[roomName].spectators[clientId];
        } else {
            rooms[roomName].players[clientId].disconnected = true;
            rooms[roomName].activity[clientId] = Date.now();
            console.log(`Gracz ${clientId} rozłączony w pokoju ${roomName}`);
        }
        syncRoomState(roomName);
        if (!Object.keys(rooms[roomName].players).length && !Object.keys(rooms[roomName].spectators).length) {
            delete rooms[roomName];
            delete sessions[sessionId];
        }
        broadcastRooms();
    }
}

setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(room => {
        Object.keys(rooms[room].activity).forEach(id => {
            if (now - rooms[room].activity[id] > 30000) {
                if (rooms[room].players[id]) {
                    delete rooms[room].players[id];
                    delete rooms[room].pendingUpdates[id];
                    resetBall(room);
                    rooms[room].scores = [0, 0];
                } else if (rooms[room].spectators[id]) {
                    delete rooms[room].spectators[id];
                }
                delete rooms[room].activity[id];
                syncRoomState(room);
            }
        });
        if (!Object.keys(rooms[room].players).length && !Object.keys(rooms[room].spectators).length) {
            delete rooms[room];
        }
    });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.lastPing && now - client.lastPing > 15000) {
            client.terminate();
        }
    });
    broadcastRooms();
}, 1000);

setInterval(() => {
    Object.keys(rooms).forEach(room => {
        const { ball, players, scores, pendingUpdates, lastHitTime } = rooms[room];
        if (Object.keys(players).length < 2 || Object.values(players).some(p => p.disconnected)) return;

        Object.keys(pendingUpdates).forEach(id => players[id].y = pendingUpdates[id]);
        rooms[room].pendingUpdates = {};

        ball.x += ball.dx;
        ball.y += ball.dy;
        if (ball.y + ball.r > 400 || ball.y - ball.r < 0) ball.dy = -ball.dy;

        const now = Date.now();
        let hit = false;
        if (now - lastHitTime > 100) {
            Object.values(players).forEach(p => {
                if (!p.disconnected && ball.x - ball.r < p.x + 10 && ball.x + ball.r > p.x && ball.y > p.y && ball.y < p.y + 60) {
                    ball.dx = -ball.dx * 1.05;
                    ball.dx = Math.max(-MAX_BALL_SPEED, Math.min(MAX_BALL_SPEED, ball.dx));
                    ball.dy = Math.max(-MAX_BALL_SPEED, Math.min(MAX_BALL_SPEED, ball.dy));
                    hit = true;
                    rooms[room].lastHitTime = now;
                }
            });
        }

        if (ball.x < 0) {
            scores[1]++;
            updateLeaderboard(room, 1);
            resetBall(room);
            broadcastScore(room);
        } else if (ball.x > 800) {
            scores[0]++;
            updateLeaderboard(room, 0);
            resetBall(room);
            broadcastScore(room);
        }

        syncRoomState(room);
    });
}, UPDATE_INTERVAL);

function resetBall(room) {
    if (rooms[room]) {
        const { ball } = rooms[room];
        ball.x = 400;
        ball.y = 200;
        ball.dx = 5 * (Math.random() > 0.5 ? 1 : -1);
        ball.dy = 5 * (Math.random() > 0.5 ? 1 : -1);
        rooms[room].lastHitTime = 0;
    }
}

function broadcast(room, msg) {
    if (!rooms[room]) return;
    const data = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && (rooms[room].players[client.clientId] || rooms[room].spectators[client.clientId])) {
            client.send(data);
        }
    });
}

function broadcastSpectators(room, msg) {
    if (!rooms[room]) return;
    const data = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && rooms[room].spectators[client.clientId]) {
            client.send(data);
        }
    });
}

function broadcastRooms() {
    const roomData = Object.keys(rooms).map(room => ({
        room,
        players: Object.keys(rooms[room].players).length,
        spectators: Object.keys(rooms[room].spectators).length
    }));
    const data = JSON.stringify({ type: 'rooms', rooms: roomData });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    });
}

function broadcastScore(room) {
    if (!rooms[room]) return;
    broadcast(room, { type: 'score', s: rooms[room].scores, l: db.data.scores });
}

function updateLeaderboard(room, winnerId) {
    if (!rooms[room]) return;
    const winner = rooms[room].players[winnerId];
    if (winner && !winner.disconnected) {
        const existing = db.data.scores.find(s => s.nickname === winner.nickname);
        if (existing) existing.score++;
        else db.data.scores.push({ nickname: winner.nickname, score: 1 });
        db.data.scores.sort((a, b) => b.score - a.score).splice(10);
        db.write().catch(() => {});
    }
}
