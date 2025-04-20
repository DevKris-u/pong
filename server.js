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

// Serwowanie plików statycznych
app.use(express.static(__dirname));

// Serwowanie index.html
app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Plik index.html nie znaleziony');
    }
});

// Reset liderów (tylko dla testów)
app.get('/reset-leaderboard', (req, res) => {
    if (db) {
        db.data.scores = [];
        db.write().then(() => res.send('Tabela liderów zresetowana')).catch(err => res.status(500).send('Błąd resetowania'));
    } else {
        fallbackScores.scores = [];
        res.send('Tabela liderów zresetowana (pamięć tymczasowa)');
    }
});

// Inicjalizacja bazy danych
let fallbackScores = { scores: [] };
if (Low) {
    const filePath = path.join(__dirname, 'scores.json');
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify({ scores: [] }));
    }
    const adapter = new JSONFile(filePath);
    db = new Low(adapter, { scores: [] });
    db.read().catch(err => {
        console.error('Błąd inicjalizacji bazy danych:', err);
        db.data = { scores: [] };
    });
} else {
    console.warn('Lowdb niedostępne, używam pamięci tymczasowej');
    db = { data: fallbackScores, write: () => Promise.resolve() };
}

// Serwer WebSocket
const server = app.listen(process.env.PORT || 3000, () => {
    console.log('Serwer działa na porcie', process.env.PORT || 3000);
});
const wss = new WebSocket.Server({ server });

const rooms = {};
const UPDATE_INTERVAL = 1000 / 30; // Aktualizacja gry co 33ms (30 FPS)

function createRoom(room) {
    if (!rooms[room]) {
        rooms[room] = {
            players: {},
            spectators: {},
            ball: { x: 400, y: 200, dx: 5, dy: 5, radius: 10 },
            scores: [0, 0],
            activity: {},
            startTime: Date.now(),
            pendingUpdates: {} // Bufor zmian pozycji graczy
        };
    }
}

wss.on('connection', (ws) => {
    let clientId;
    let roomName;
    let nickname;
    let isSpectator = false;

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Błąd parsowania wiadomości:', e);
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
                    ws.send(JSON.stringify({ type: 'error', message: 'Pokój pełny dla graczy! Dołącz jako widz.' }));
                    ws.close();
                    return;
                }
                clientId = playerCount.toString();
                rooms[roomName].players[clientId] = { x: clientId === '0' ? 10 : 780, y: 170, id: clientId, nickname };
            } else {
                clientId = `s_${Object.keys(rooms[roomName].spectators).length}`;
                rooms[roomName].spectators[clientId] = { nickname };
            }

            ws.clientId = clientId;
            ws.isSpectator = isSpectator;
            ws.roomName = roomName;
            rooms[roomName].activity[clientId] = Date.now();
            ws.send(JSON.stringify({ type: 'init', id: clientId, players: rooms[roomName].players, isSpectator, startTime: rooms[roomName].startTime }));
            broadcast(roomName, { type: 'update', players: rooms[roomName].players, ball: rooms[roomName].ball });
            broadcastRooms();
        } else if (data.type === 'move' && clientId && !isSpectator && rooms[roomName]) {
            rooms[roomName].pendingUpdates[clientId] = Math.max(0, Math.min(400 - 60, data.y));
            rooms[roomName].activity[clientId] = Date.now();
        } else if (data.type === 'chat' && clientId && rooms[roomName]) {
            const cleanMessage = sanitizeHtml(data.message).slice(0, 100);
            if (cleanMessage) {
                broadcast(roomName, { type: 'chat', nickname, message: cleanMessage });
            }
            rooms[roomName].activity[clientId] = Date.now();
        } else if (data.type === 'spectatorChat' && clientId && isSpectator && rooms[roomName]) {
            const cleanMessage = sanitizeHtml(data.message).slice(0, 100);
            if (cleanMessage) {
                broadcastSpectators(roomName, { type: 'spectatorChat', nickname, message: cleanMessage });
            }
            rooms[roomName].activity[clientId] = Date.now();
        } else if (data.type === 'getRooms') {
            broadcastRooms();
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });

    ws.on('error', (err) => {
        console.error(`Błąd WebSocket dla klienta ${clientId}:`, err);
        handleDisconnect(ws);
    });
});

function handleDisconnect(ws) {
    const { clientId, roomName, isSpectator } = ws;
    if (clientId && roomName && rooms[roomName]) {
        if (isSpectator) {
            delete rooms[roomName].spectators[clientId];
        } else {
            delete rooms[roomName].players[clientId];
            delete rooms[roomName].pendingUpdates[clientId];
        }
        delete rooms[roomName].activity[clientId];
        resetBall(roomName);
        broadcast(roomName, { type: 'update', players: rooms[roomName].players, ball: rooms[roomName].ball });
        if (Object.keys(rooms[roomName].players).length === 0 && Object.keys(rooms[roomName].spectators).length === 0) {
            delete rooms[roomName];
        }
        broadcastRooms();
    }
}

// Sprawdzanie nieaktywnych klientów
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(room => {
        Object.keys(rooms[room].activity).forEach(id => {
            if (now - rooms[room].activity[id] > 15000) { // Skrócono do 15s
                if (rooms[room].players[id]) {
                    delete rooms[room].players[id];
                    delete rooms[room].pendingUpdates[id];
                } else if (rooms[room].spectators[id]) {
                    delete rooms[room].spectators[id];
                }
                delete rooms[room].activity[id];
                resetBall(room);
                broadcast(room, { type: 'update', players: rooms[room].players, ball: rooms[room].ball });
            }
        });
        if (Object.keys(rooms[room].players).length === 0 && Object.keys(rooms[room].spectators).length === 0) {
            delete rooms[room];
        }
    });
    broadcastRooms();
}, 1000);

// Logika gry
setInterval(() => {
    Object.keys(rooms).forEach(room => {
        const { ball, players, scores, pendingUpdates } = rooms[room];

        // Aktualizacja pozycji graczy z bufora
        Object.keys(pendingUpdates).forEach(id => {
            players[id].y = pendingUpdates[id];
        });
        rooms[room].pendingUpdates = {};

        // Aktualizacja piłki
        ball.x += ball.dx;
        ball.y += ball.dy;

        if (ball.y + ball.radius > 400 || ball.y - ball.radius < 0) {
            ball.dy = -ball.dy;
        }

        let hit = false;
        Object.values(players).forEach(player => {
            if (
                ball.x - ball.radius < player.x + 10 &&
                ball.x + ball.radius > player.x &&
                ball.y > player.y &&
                ball.y < player.y + 60
            ) {
                ball.dx = -ball.dx * 1.05; // Lekkie przyspieszenie po odbiciu
                hit = true;
            }
        });

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

        // Wysyłanie skompresowanego stanu gry
        broadcast(room, {
            type: 'update',
            players: Object.fromEntries(Object.entries(players).map(([id, p]) => [id, { x: p.x, y: p.y, id: p.id }])),
            ball: { x: ball.x, y: ball.y, dx: ball.dx, dy: ball.dy, radius: ball.radius },
            hit
        });
    });
}, UPDATE_INTERVAL);

function resetBall(room) {
    if (rooms[room]) {
        rooms[room].ball.x = 400;
        rooms[room].ball.y = 200;
        rooms[room].ball.dx = 5 * (Math.random() > 0.5 ? 1 : -1);
        rooms[room].ball.dy = 5 * (Math.random() > 0.5 ? 1 : -1);
    }
}

function broadcast(room, message) {
    if (!rooms[room]) return;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && (rooms[room].players[client.clientId] || rooms[room].spectators[client.clientId])) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {
                console.error(`Błąd wysyłania do klienta ${client.clientId}:`, e);
            }
        }
    });
}

function broadcastSpectators(room, message) {
    if (!rooms[room]) return;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && rooms[room].spectators[client.clientId]) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {
                console.error(`Błąd wysyłania do widza ${client.clientId}:`, e);
            }
        }
    });
}

function broadcastRooms() {
    const roomData = Object.keys(rooms).map(room => ({
        room,
        players: Object.keys(rooms[room].players).length,
        spectators: Object.keys(rooms[room].spectators).length
    }));
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify({ type: 'rooms', rooms: roomData }));
            } catch (e) {
                console.error(`Błąd wysyłania listy pokoi do klienta ${client.clientId}:`, e);
            }
        }
    });
}

function broadcastScore(room) {
    if (!rooms[room]) return;
    broadcast(room, { type: 'score', scores: rooms[room].scores, leaderboard: db.data.scores });
}

function updateLeaderboard(room, winnerId) {
    if (!rooms[room]) return;
    const winner = rooms[room].players[winnerId];
    if (winner) {
        const existing = db.data.scores.find(s => s.nickname === winner.nickname);
        if (existing) {
            existing.score++;
        } else {
            db.data.scores.push({ nickname: winner.nickname, score: 1 });
        }
        db.data.scores.sort((a, b) => b.score - a.score);
        db.data.scores = db.data.scores.slice(0, 10);
        db.write().catch(err => console.error('Błąd zapisu bazy danych:', err));
    }
}
