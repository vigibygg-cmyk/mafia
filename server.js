const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let rooms = {};

// Kambarys ištrinamas tik jei NIEKAS 10 minučių neatlieka jokio veiksmo (ne tik prisijungimo).
const INACTIVITY_LIMIT = 10 * 60 * 1000;
const NIGHT_DURATION = 180; // Sekundės nakties veiksmams
const DAY_VOTE_LIMIT = 5 * 60 * 1000;    // Apsauga: jei kas nors neprisijungęs/AFK - diena vis tiek pasibaigs
const DEFENSE_VOTE_LIMIT = 3 * 60 * 1000; // Apsauga: gynybinis balsavimas irgi negali kaboti amžinai

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function resetInactivityTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
    room.inactivityTimer = setTimeout(() => deleteRoom(roomCode), INACTIVITY_LIMIT);
}

function clearAllRoomTimers(room) {
    if (room.nightTimer) clearInterval(room.nightTimer);
    if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
    if (room.dayTimeout) clearTimeout(room.dayTimeout);
    if (room.defenseTimeout) clearTimeout(room.defenseTimeout);
}

function deleteRoom(roomCode) {
    if (rooms[roomCode]) {
        clearAllRoomTimers(rooms[roomCode]);
        io.to(roomCode).emit('game_reset', 'MSG_ROOM_DELETED');
        delete rooms[roomCode];
    }
}

function assignHostIfMissing(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) return;
    if (!playerIds.some(id => room.players[id].isHost)) {
        room.players[playerIds[0]].isHost = true;
    }
}

io.on('connection', (socket) => {
    socket.on('join_game', ({ playerName, roomCode }) => {
        let code = roomCode ? roomCode.trim().toUpperCase() : null;

        if (!code) {
            code = generateRoomCode();
            rooms[code] = {
                phase: 'LOBBY',
                players: {},
                mafiaVotes: {}, // key: voterSocketId, value: targetSocketId
                doctorTarget: null,
                detectiveTarget: null,
                dayVotes: {},
                accusedId: null,
                defenseVotes: { yes: 0, no: 0, voted: {} },
                timerSeconds: 0,
                nightTimer: null
            };
        }

        const room = rooms[code];
        if (!room) return socket.emit('error_message', 'ERR_ROOM_NOT_FOUND');

        const existingSocketId = Object.keys(room.players).find(
            id => room.players[id].name.toLowerCase() === playerName.toLowerCase()
        );

        socket.join(code);
        socket.roomCode = code;

        if (existingSocketId && room.phase !== 'LOBBY') {
            const playerData = room.players[existingSocketId];
            delete room.players[existingSocketId];
            playerData.id = socket.id;
            room.players[socket.id] = playerData;

            assignHostIfMissing(code);
            socket.emit('phase_change', {
                roomCode: code,
                phase: room.phase,
                role: playerData.role,
                isAlive: playerData.isAlive,
                isHost: playerData.isHost,
                accusedName: room.accusedId && room.players[room.accusedId] ? room.players[room.accusedId].name : null,
                players: Object.values(room.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive, isHost: x.isHost }))
            });
            return;
        }

        if (room.phase !== 'LOBBY') return socket.emit('error_message', 'ERR_ALREADY_STARTED');

        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            role: null,
            isAlive: true,
            isHost: Object.keys(room.players).length === 0
        };

        resetInactivityTimer(code);
        io.to(code).emit('update_players', { roomCode: code, players: Object.values(room.players) });
    });

    socket.on('start_game', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const player = room.players[socket.id];
        if (!player || !player.isHost) return socket.emit('error_message', 'ERR_NOT_HOST');

        const playerIds = Object.keys(room.players);
        if (playerIds.length < 6) return socket.emit('error_message', 'ERR_NEED_6');
        if (room.phase !== 'LOBBY') return;

        resetInactivityTimer(code);

        // Sumaišymas
        for (let i = playerIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
        }

        let mafiaCount = 1;
        if (playerIds.length >= 8 && playerIds.length <= 11) mafiaCount = 2;
        else if (playerIds.length >= 12 && playerIds.length <= 17) mafiaCount = 3;
        else if (playerIds.length >= 18 && playerIds.length <= 19) mafiaCount = 4;
        else if (playerIds.length >= 20) mafiaCount = Math.min(7, Math.max(5, Math.round(playerIds.length / 5)));

        let assigned = 0;
        for (let i = 0; i < mafiaCount; i++) room.players[playerIds[assigned++]].role = 'ROLE_MAFIA';
        room.players[playerIds[assigned++]].role = 'ROLE_DETECTIVE';
        room.players[playerIds[assigned++]].role = 'ROLE_DOCTOR';
        while (assigned < playerIds.length) room.players[playerIds[assigned++]].role = 'ROLE_CITIZEN';

        startNightPhase(code);
    });

    // TYLUS MAFIJOS BALSAVIMAS IR KITI VEIKSMAI
    socket.on('night_action', (targetId) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || room.phase !== 'NIGHT') return;

        const player = room.players[socket.id];
        if (!player || !player.isAlive) return;

        resetInactivityTimer(code);

        if (player.role === 'ROLE_MAFIA') {
            room.mafiaVotes[socket.id] = targetId;

            // Realaus laiko suvestinės siuntimas TIK MAFIJAI
            const mafiaSockets = Object.values(room.players).filter(p => p.role === 'ROLE_MAFIA' && p.isAlive).map(p => p.id);
            const votesSummary = {};
            Object.values(room.mafiaVotes).forEach(tid => {
                votesSummary[tid] = (votesSummary[tid] || 0) + 1;
            });

            mafiaSockets.forEach(sid => {
                io.to(sid).emit('mafia_votes_update', votesSummary);
            });
        } else if (player.role === 'ROLE_DOCTOR') {
            room.doctorTarget = targetId;
        } else if (player.role === 'ROLE_DETECTIVE') {
            const targetPlayer = room.players[targetId];
            socket.emit('detective_result', {
                targetName: targetPlayer ? targetPlayer.name : 'Unknown',
                isMafia: targetPlayer ? targetPlayer.role === 'ROLE_MAFIA' : false
            });
            room.detectiveTarget = targetId;
        }
        // ROLE_CITIZEN veiksmai ignoruojami serveryje (naudojami tik kaip dekoracija kliente)
    });

    // DIENOS BALSAVIMAS (NOMINAVIMAS)
    socket.on('cast_vote', (targetId) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || room.phase !== 'DAY_VOTING') return;

        const player = room.players[socket.id];
        if (!player || !player.isAlive) return;

        resetInactivityTimer(code);
        room.dayVotes[socket.id] = targetId;

        const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
        if (Object.keys(room.dayVotes).length >= alivePlayers.length) {
            processDayVotingResults(code);
        }
    });

    // GYNYBINĖS KALBOS PATVIRTINIMO BALSAVIMAS (TAIP / NE)
    socket.on('defense_vote', (confirmElimination) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || room.phase !== 'DAY_DEFENSE') return;

        const player = room.players[socket.id];
        if (!player || !player.isAlive || room.defenseVotes.voted[socket.id]) return;
        if (socket.id === room.accusedId) return; // kaltinamasis nebalsuoja dėl savo likimo

        resetInactivityTimer(code);
        room.defenseVotes.voted[socket.id] = true;
        if (confirmElimination) room.defenseVotes.yes++;
        else room.defenseVotes.no++;

        const eligibleVoters = Object.values(room.players).filter(p => p.isAlive && p.id !== room.accusedId);
        if (Object.keys(room.defenseVotes.voted).length >= eligibleVoters.length) {
            finalizeElimination(code);
        }
    });

    socket.on('play_again', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || !room.players[socket.id]?.isHost) return;

        room.phase = 'LOBBY';
        room.mafiaVotes = {};
        room.doctorTarget = null;
        room.detectiveTarget = null;
        room.dayVotes = {};
        room.accusedId = null;

        Object.keys(room.players).forEach(id => {
            room.players[id].role = null;
            room.players[id].isAlive = true;
        });

        io.to(code).emit('update_players', { roomCode: code, players: Object.values(room.players) });
    });

    socket.on('reset_game', () => {
        const code = socket.roomCode;
        if (rooms[code]?.players[socket.id]?.isHost) deleteRoom(code);
    });

    socket.on('leave_room', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (room && room.players[socket.id]) {
            delete room.players[socket.id];
            socket.leave(code);
            socket.roomCode = null;
            assignHostIfMissing(code);
            if (Object.keys(room.players).length === 0) deleteRoom(code);
            else io.to(code).emit('update_players', { roomCode: code, players: Object.values(room.players) });
        }
    });

    socket.on('disconnect', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (room && room.players[socket.id]) {
            if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') {
                delete room.players[socket.id];
                assignHostIfMissing(code);
                io.to(code).emit('update_players', { roomCode: code, players: Object.values(room.players) });
            }
            if (Object.keys(room.players).length === 0) deleteRoom(code);
        }
    });
});

function startNightPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'NIGHT';
    room.mafiaVotes = {};
    room.doctorTarget = null;
    room.detectiveTarget = null;
    room.timerSeconds = NIGHT_DURATION;

    if (room.nightTimer) clearInterval(room.nightTimer);

    // Laikmatis naktiniai fazei
    room.nightTimer = setInterval(() => {
        room.timerSeconds--;
        io.to(roomCode).emit('timer_tick', room.timerSeconds);

        if (room.timerSeconds <= 0) {
            clearInterval(room.nightTimer);
            processNightResults(roomCode);
        }
    }, 1000);

    Object.keys(room.players).forEach(id => {
        const p = room.players[id];
        io.to(id).emit('phase_change', {
            roomCode: roomCode,
            phase: 'NIGHT',
            role: p.role,
            isAlive: p.isAlive,
            isHost: p.isHost,
            timer: NIGHT_DURATION,
            players: Object.values(room.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive, isHost: x.isHost }))
        });
    });
}

function processNightResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.nightTimer) clearInterval(room.nightTimer);

    // Išrenkama mafijos auka pagal daugumą
    const voteCounts = {};
    Object.values(room.mafiaVotes).forEach(tid => {
        voteCounts[tid] = (voteCounts[tid] || 0) + 1;
    });

    let mafiaTarget = null;
    let maxVotes = 0;
    Object.keys(voteCounts).forEach(tid => {
        if (voteCounts[tid] > maxVotes) {
            maxVotes = voteCounts[tid];
            mafiaTarget = tid;
        }
    });

    let killedId = null;
    if (mafiaTarget && mafiaTarget !== room.doctorTarget) {
        killedId = mafiaTarget;
        if (room.players[killedId]) room.players[killedId].isAlive = false;
    }

    if (checkWinCondition(roomCode)) return;

    room.phase = 'DAY_VOTING';
    room.dayVotes = {};

    if (room.dayTimeout) clearTimeout(room.dayTimeout);
    room.dayTimeout = setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].phase === 'DAY_VOTING') {
            processDayVotingResults(roomCode);
        }
    }, DAY_VOTE_LIMIT);

    const killedPlayer = killedId ? room.players[killedId].name : null;

    io.to(roomCode).emit('phase_change', {
        roomCode: roomCode,
        phase: 'DAY_VOTING',
        killedPlayer: killedPlayer,
        players: Object.values(room.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive, isHost: x.isHost }))
    });
}

function processDayVotingResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.dayTimeout) { clearTimeout(room.dayTimeout); room.dayTimeout = null; }

    const voteCounts = {};
    Object.values(room.dayVotes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let accusedId = null;
    let maxVotes = 0;
    let isTie = false;

    Object.keys(voteCounts).forEach(id => {
        if (voteCounts[id] > maxVotes) {
            maxVotes = voteCounts[id];
            accusedId = id;
            isTie = false;
        } else if (voteCounts[id] === maxVotes) {
            isTie = true;
        }
    });

    // Jei yra lygiosios arba niekas nepabalsuotas – naktis prasideda iš naujo
    if (!accusedId || isTie || maxVotes <= Object.keys(room.dayVotes).length / 2) {
        startNightPhase(roomCode);
        return;
    }

    // Pereinama į Gynybinės kalbos ir patvirtinimo fazę
    room.phase = 'DAY_DEFENSE';
    room.accusedId = accusedId;
    room.defenseVotes = { yes: 0, no: 0, voted: {} };

    if (room.defenseTimeout) clearTimeout(room.defenseTimeout);
    room.defenseTimeout = setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].phase === 'DAY_DEFENSE') {
            finalizeElimination(roomCode);
        }
    }, DEFENSE_VOTE_LIMIT);

    io.to(roomCode).emit('phase_change', {
        roomCode: roomCode,
        phase: 'DAY_DEFENSE',
        accusedName: room.players[accusedId].name,
        accusedId: accusedId,
        players: Object.values(room.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive, isHost: x.isHost }))
    });
}

function finalizeElimination(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.defenseTimeout) { clearTimeout(room.defenseTimeout); room.defenseTimeout = null; }

    // Jei Dauguma patvirtino išmetimą
    if (room.defenseVotes.yes > room.defenseVotes.no && room.accusedId && room.players[room.accusedId]) {
        room.players[room.accusedId].isAlive = false;
    }

    if (checkWinCondition(roomCode)) return;

    startNightPhase(roomCode);
}

function checkWinCondition(roomCode) {
    const room = rooms[roomCode];
    if (!room) return false;

    const alive = Object.values(room.players).filter(p => p.isAlive);
    const mafiaAlive = alive.filter(p => p.role === 'ROLE_MAFIA').length;
    const innocentsAlive = alive.length - mafiaAlive;

    let winner = null;
    if (mafiaAlive === 0) winner = 'WIN_CITIZENS';
    else if (mafiaAlive >= innocentsAlive) winner = 'WIN_MAFIA';

    if (winner) {
        if (room.nightTimer) clearInterval(room.nightTimer);
        room.phase = 'GAME_OVER';
        io.to(roomCode).emit('game_over', {
            winner: winner,
            summary: Object.values(room.players).map(x => ({ name: x.name, role: x.role, isAlive: x.isAlive }))
        });
        return true;
    }
    return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveris veikia ant prievado ${PORT}`));
