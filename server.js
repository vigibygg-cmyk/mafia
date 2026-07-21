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

let gameState = {
    phase: 'LOBBY', // LOBBY, NIGHT, DAY_DISCUSSION, DAY_VOTING
    players: {},
    nightActions: {
        mafiaTarget: null,
        doctorTarget: null,
        detectiveTarget: null
    },
    dayVotes: {}
};

io.on('connection', (socket) => {
    // 1. Prisijungimas
    socket.on('join_game', (playerName) => {
        if (gameState.phase !== 'LOBBY') {
            socket.emit('error_message', 'Žaidimas jau prasidėjęs.');
            return;
        }
        
        gameState.players[socket.id] = {
            id: socket.id,
            name: playerName,
            role: null,
            isAlive: true
        };
        io.emit('update_players', Object.values(gameState.players));
    });

    // 2. Žaidimo pradžia
    socket.on('start_game', () => {
        const playerIds = Object.keys(gameState.players);
        
        if (playerIds.length < 6) {
            socket.emit('error_message', 'Reikia bent 6 žaidėjų!');
            return;
        }

        if (gameState.phase !== 'LOBBY') return;

        // Sumaišom žaidėjus
        for (let i = playerIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
        }

        // Paskirstom vaidmenis
        let mafiaCount = playerIds.length >= 8 ? 2 : 1;
        let assigned = 0;
        
        for(let i=0; i<mafiaCount; i++) gameState.players[playerIds[assigned++]].role = 'MAFIJA';
        gameState.players[playerIds[assigned++]].role = 'DETEKTYVAS';
        gameState.players[playerIds[assigned++]].role = 'DAKTARAS';
        
        while(assigned < playerIds.length) {
            gameState.players[playerIds[assigned++]].role = 'MIESTIETIS';
        }

        startNightPhase();
    });

    // 3. Nakties veiksmai
    socket.on('night_action', (targetId) => {
        const player = gameState.players[socket.id];
        if (!player || !player.isAlive || gameState.phase !== 'NIGHT') return;

        if (player.role === 'MAFIJA') {
            gameState.nightActions.mafiaTarget = targetId;
        } else if (player.role === 'DAKTARAS') {
            gameState.nightActions.doctorTarget = targetId;
        } else if (player.role === 'DETEKTYVAS') {
            const targetPlayer = gameState.players[targetId];
            const isMafia = targetPlayer ? targetPlayer.role === 'MAFIJA' : false;
            socket.emit('detective_result', {
                targetName: targetPlayer ? targetPlayer.name : 'Neminimas',
                isMafia: isMafia
            });
            gameState.nightActions.detectiveTarget = targetId;
        }

        checkNightPhaseEnd();
    });

    // 4. Dienos balsavimas
    socket.on('cast_vote', (targetId) => {
        const player = gameState.players[socket.id];
        if (!player || !player.isAlive || gameState.phase !== 'DAY_VOTING') return;

        gameState.dayVotes[socket.id] = targetId;
        
        // Patikrinam, ar visi gyvi atidavė balsus
        const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
        if (Object.keys(gameState.dayVotes).length >= alivePlayers.length) {
            processDayVotingResults();
        }
    });

    // 5. Atsijungimas
    socket.on('disconnect', () => {
        if (gameState.players[socket.id]) {
            delete gameState.players[socket.id];
            if (gameState.phase === 'LOBBY') {
                io.emit('update_players', Object.values(gameState.players));
            }
        }
    });
});

function startNightPhase() {
    gameState.phase = 'NIGHT';
    gameState.nightActions = { mafiaTarget: null, doctorTarget: null, detectiveTarget: null };

    Object.keys(gameState.players).forEach(id => {
        const p = gameState.players[id];
        io.to(id).emit('phase_change', {
            phase: 'NIGHT',
            role: p.role,
            isAlive: p.isAlive,
            players: Object.values(gameState.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive }))
        });
    });
}

function checkNightPhaseEnd() {
    // Paprasta taisyklė: kai Mafija ir Daktaras atlieka veiksmus - naktis baigiasi
    const hasMafia = Object.values(gameState.players).some(p => p.role === 'MAFIJA' && p.isAlive);
    const hasDoctor = Object.values(gameState.players).some(p => p.role === 'DAKTARAS' && p.isAlive);

    const mafiaDone = !hasMafia || gameState.nightActions.mafiaTarget !== null;
    const doctorDone = !hasDoctor || gameState.nightActions.doctorTarget !== null;

    if (mafiaDone && doctorDone) {
        processNightResults();
    }
}

function processNightResults() {
    let killedId = null;
    if (gameState.nightActions.mafiaTarget && gameState.nightActions.mafiaTarget !== gameState.nightActions.doctorTarget) {
        killedId = gameState.nightActions.mafiaTarget;
        if (gameState.players[killedId]) {
            gameState.players[killedId].isAlive = false;
        }
    }

    gameState.phase = 'DAY_VOTING';
    gameState.dayVotes = {};

    const killedPlayer = killedId ? gameState.players[killedId].name : null;

    io.emit('phase_change', {
        phase: 'DAY_VOTING',
        killedPlayer: killedPlayer,
        players: Object.values(gameState.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive }))
    });
}

function processDayVotingResults() {
    // Suskaičiuojam balsus
    const voteCounts = {};
    Object.values(gameState.dayVotes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let executedId = null;
    let maxVotes = 0;
    Object.keys(voteCounts).forEach(id => {
        if (voteCounts[id] > maxVotes) {
            maxVotes = voteCounts[id];
            executedId = id;
        }
    });

    if (executedId && gameState.players[executedId]) {
        gameState.players[executedId].isAlive = false;
    }

    const executedPlayer = executedId ? gameState.players[executedId].name : null;

    // Po balsavimo vėl prasideda naktis
    startNightPhase();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveris sėkmingai pasileido ant prievado ${PORT}`);
});
