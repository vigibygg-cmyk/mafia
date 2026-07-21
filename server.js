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
    phase: 'LOBBY',
    players: {},
    nightActions: {
        mafiaTarget: null,
        doctorTarget: null,
        detectiveTarget: null
    },
    dayVotes: {}
};

io.on('connection', (socket) => {
    console.log('Naujas prisijungimas:', socket.id);

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

    socket.on('start_game', () => {
        const playerIds = Object.keys(gameState.players);
        
        if (playerIds.length < 6) {
            socket.emit('error_message', `Trūksta žaidėjų! Yra ${playerIds.length}, reikia bent 6.`);
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

    socket.on('night_action', (targetId) => {
        const player = gameState.players[socket.id];
        if (!player || !player.isAlive || gameState.phase !== 'NIGHT') return;

        if (player.role === 'MAFIJA') {
            gameState.nightActions.mafiaTarget = targetId;
            console.log('Mafija pasirinko auką:', targetId);
        } else if (player.role === 'DAKTARAS') {
            gameState.nightActions.doctorTarget = targetId;
            console.log('Daktaras pasirinko gydyti:', targetId);
        } else if (player.role === 'DETEKTYVAS') {
            const targetPlayer = gameState.players[targetId];
            const isMafia = targetPlayer ? targetPlayer.role === 'MAFIJA' : false;
            socket.emit('detective_result', {
                targetName: targetPlayer ? targetPlayer.name : 'Neminimas',
                isMafia: isMafia
            });
            gameState.nightActions.detectiveTarget = targetId;
            console.log('Detektyvas patikrino:', targetId);
        }

        checkNightPhaseEnd();
    });

    socket.on('cast_vote', (targetId) => {
        const player = gameState.players[socket.id];
        if (!player || !player.isAlive || gameState.phase !== 'DAY_VOTING') return;

        gameState.dayVotes[socket.id] = targetId;
        console.log(`Žaidėjas ${player.name} atidavė balsą.`);

        const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
        if (Object.keys(gameState.dayVotes).length >= alivePlayers.length) {
            processDayVotingResults();
        }
    });

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

    console.log('--- PRASIDEDA NAKTIS ---');

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
    const alivePlayers = Object.values(gameState.players).filter(p => p.isAlive);
    
    const hasMafia = alivePlayers.some(p => p.role === 'MAFIJA');
    const hasDoctor = alivePlayers.some(p => p.role === 'DAKTARAS');
    const hasDetective = alivePlayers.some(p => p.role === 'DETEKTYVAS');

    const mafiaDone = !hasMafia || gameState.nightActions.mafiaTarget !== null;
    const doctorDone = !hasDoctor || gameState.nightActions.doctorTarget !== null;
    const detectiveDone = !hasDetective || gameState.nightActions.detectiveTarget !== null;

    if (mafiaDone && doctorDone && detectiveDone) {
        processNightResults();
    }
}

function processNightResults() {
    let killedId = null;
    // Nužudoma tik jei Mafija pasirinko auką IR Daktaras jos neišgydė
    if (gameState.nightActions.mafiaTarget && gameState.nightActions.mafiaTarget !== gameState.nightActions.doctorTarget) {
        killedId = gameState.nightActions.mafiaTarget;
        if (gameState.players[killedId]) {
            gameState.players[killedId].isAlive = false;
        }
    }

    // Tikriname, ar žaidimas nepasibaigė po nakties
    if (checkWinCondition()) return;

    gameState.phase = 'DAY_VOTING';
    gameState.dayVotes = {};

    const killedPlayer = killedId ? gameState.players[killedId].name : null;

    console.log('--- PRASIDEDA DIENA. Nužudytas:', killedPlayer);

    io.emit('phase_change', {
        phase: 'DAY_VOTING',
        killedPlayer: killedPlayer,
        players: Object.values(gameState.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive }))
    });
}

function processDayVotingResults() {
    const voteCounts = {};
    Object.values(gameState.dayVotes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let executedId = null;
    let maxVotes = 0;
    let isTie = false;

    Object.keys(voteCounts).forEach(id => {
        if (voteCounts[id] > maxVotes) {
            maxVotes = voteCounts[id];
            executedId = id;
            isTie = false;
        } else if (voteCounts[id] === maxVotes) {
            isTie = true; // Lygiosios
        }
    });

    // Jei lygiosios - niekas neišmetamas. Jei ne - išmetamas daugiausiai balsų gavęs
    if (executedId && !isTie && gameState.players[executedId]) {
        gameState.players[executedId].isAlive = false;
        console.log('Miestas išbalsavo žaidėją:', gameState.players[executedId].name);
    } else {
        console.log('Balsavimas baigėsi lygiosiomis arba be rezultatų. Niekas nemirė.');
    }

    // Tikriname laimėjimo sąlygas
    if (checkWinCondition()) return;

    // Jei žaidimas tęsiasi – vėl naktis
    startNightPhase();
}

function checkWinCondition() {
    const alive = Object.values(gameState.players).filter(p => p.isAlive);
    const mafiaAlive = alive.filter(p => p.role === 'MAFIJA').length;
    const innocentsAlive = alive.length - mafiaAlive;

    let winner = null;

    if (mafiaAlive === 0) {
        winner = 'TAIKŪS GYVENTOJAI';
    } else if (mafiaAlive >= innocentsAlive) {
        winner = 'MAFIJA';
    }

    if (winner) {
        gameState.phase = 'GAME_OVER';
        io.emit('game_over', { winner: winner });
        return true;
    }

    return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveris sėkmingai pasileido ant prievado ${PORT}`);
});
