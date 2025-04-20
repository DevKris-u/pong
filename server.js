const WebSocket = require('ws');
const express = require('express');
const sanitizeHtml = require('sanitize-html');
const path = require('path');
const fs = require('fs');

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
const UPDATE_INTERVAL = 1000 / 25; // 25 FPS
const MAX_BALL_SPEED = 10; // Maksymalna prędkość piłki

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
            lastHitTime: 0 // Czas ostatniego odbicia
        };
    }
}

wss.on('connection', (ws) => {
    let clientId, roomName, nickname, isSpectator = false;

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
            createRoom(roomName);

            if (!isSpectator) {
                const playerCount = Object.keys(rooms[roomName].players).length;
                if (playerCount >= 2) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Pokój pełny!' }));
                    ws.close();
                    return;
                }
                clientId = playerCount.toString();
                rooms[roomName].players[clientId] = { x: clientId === '0' ? 10 : 780, y: 170, id: clientId, nickname };
                resetBall(roomName); // Reset piłki przy nowym graczu
            } else {
                clientId = `s_${Object.keys(rooms[roomName].spectators).length}`;
                rooms[roomName].spectators[clientId] = { nickname };
            }

            ws.clientId = clientId;
            ws.isSpectator = isSpectator;
            ws.roomName = roomName;
            rooms[roomName].activity[clientId] = Date.now();
            ws.send(JSON.stringify({ type: 'init', id: clientId, players: rooms[roomName].players, isSpectator, startTime: rooms[roomName].startTime }));
            broadcast(roomName, { type: 'update', p: rooms[roomName].players, b: rooms[roomName].ball, s: rooms[roomName].scores });
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

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
});

function handleDisconnect(ws) {
    const { clientId, roomName, isSpectator } = ws;
    if (clientId && roomName && rooms[roomName]) {
        if (isSpectator) delete rooms[roomName].spectators[clientId];
        else {
            delete rooms[roomName].players[clientId];
            delete rooms[roomName].pendingUpdates[clientId];
            resetBall(roomName);
            rooms[roomName].scores = [0, 0]; // Reset wyników po rozłączeniu
        }
        delete rooms[roomName].activity[clientId];
        broadcast(roomName, { type: 'update', p: rooms[roomName].players, b: rooms[roomName].ball, s: rooms[roomName].scores });
        if (!Object.keys(rooms[roomName].players).length && !Object.keys(rooms[roomName].spectators).length) {
            delete rooms[roomName];
        }
        broadcastRooms();
    }
}

setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(room => {
        Object.keys(rooms[room].activity).forEach(id => {
            if (now - rooms[room].activity[id] > 10000) {
                if (rooms[room].players[id]) {
                    delete rooms[room].players[id];
                    delete rooms[room].pendingUpdates[id];
                } else if (rooms[room].spectators[id]) {
                    delete rooms[room].spectators[id];
                }
                delete rooms[room].activity[id];
                resetBall(room);
                broadcast(room, { type: 'update', p: rooms[room].players, b: rooms[room].ball, s: rooms[room].scores });
            }
        });
        if (!Object.keys(rooms[room].players).length && !Object.keys(rooms[room].spectators).length) {
            delete rooms[room];
        }
    });
    broadcastRooms();
}, 1000);

setInterval(() => {
    Object.keys(rooms).forEach(room => {
        const { ball, players, scores, pendingUpdates, lastHitTime } = rooms[room];
        if (Object.keys(players).length < 2) return; // Pauza, jeśli brak graczy

        Object.keys(pendingUpdates).forEach(id => players[id].y = pendingUpdates[id]);
        rooms[room].pendingUpdates = {};

        ball.x += ball.dx;
        ball.y += ball.dy;
        if (ball.y + ball.r > 400 || ball.y - ball.r < 0) ball.dy = -ball.dy;

        const now = Date.now();
        let hit = false;
        if (now - lastHitTime > 100) { // Minimalny czas między odbiciami
            Object.values(players).forEach(p => {
                if (ball.x - ball.r < p.x + 10 && ball.x + ball.r > p.x && ball.y > p.y && ball.y < p.y + 60) {
                    ball.dx = -ball.dx * 1.05;
                    ball.dx = Math.max(-MAX_BALL_SPEED, Math.min(MAX_BALL_SPEED, ball.dx)); // Ograniczenie prędkości
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

        broadcast(room, { type: 'update', p: players, b: ball, s: scores, h: hit });
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
    if (winner) {
        const existing = db.data.scores.find(s => s.nickname === winner.nickname);
        if (existing) existing.score++;
        else db.data.scores.push({ nickname: winner.nickname, score: 1 });
        db.data.scores.sort((a, b) => b.score - a.score).splice(10);
        db.write().catch(() => {});
    }
}
