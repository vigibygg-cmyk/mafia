const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Centrinė žaidimo būsena
let gameState = {
    phase: 'LOBBY', // Galimos fazės: LOBBY, NIGHT, DAY_DISCUSSION, DAY_VOTING
    players: {},    // Žaidėjų sąrašas (raktas: socket.id)
    votes: {}       // Balsavimo rezultatai
};

io.on('connection', (socket) => {
    // 1. Žaidėjo prisijungimas į laukiamąjį
    socket.on('join_game', (playerName) => {
        if (gameState.phase !== 'LOBBY') {
            socket.emit('error_message', 'Žaidimas jau prasidėjęs. Prisijungti negalima.');
            return;
        }
        
        gameState.players[socket.id] = {
            id: socket.id,
            name: playerName,
            role: null,
            isAlive: true
        };
        
        // Atnaujinto sąrašo išsiuntimas visiems klientams
        io.emit('update_players', Object.values(gameState.players));
    });

    // 2. Atsijungimo valdymas LOBBY fazėje
    socket.on('disconnect', () => {
        if (gameState.players[socket.id]) {
            delete gameState.players[socket.id];
            io.emit('update_players', Object.values(gameState.players));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveris sėkmingai pasileido ant prievado ${PORT}`);
});
