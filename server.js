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

let rooms = {};

const INACTIVITY_LIMIT = 20 * 60 * 1000;
const DISCONNECT_LIMIT = 5 * 60 * 1000;

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function resetInactivityTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
    room.inactivityTimer = setTimeout(() => {
        deleteRoom(roomCode);
    }, INACTIVITY_LIMIT);
}

function checkDisconnectStatus(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const roomSockets = io.sockets.adapter.rooms.get(roomCode);
    const activeSocketsCount = roomSockets ? roomSockets.size : 0;

    if (room.phase !== 'LOBBY' && activeSocketsCount < 6) {
        if (!room.disconnectTimer) {
            room.disconnectTimer = setTimeout(() => {
                deleteRoom(roomCode);
            }, DISCONNECT_LIMIT);
        }
    } else {
        if (room.disconnectTimer) {
            clearTimeout(room.disconnectTimer);
            room.disconnectTimer = null;
        }
    }
}

function deleteRoom(roomCode) {
    if (rooms[roomCode]) {
        if (rooms[roomCode].inactivityTimer) clearTimeout(rooms[roomCode].inactivityTimer);
        if (rooms[roomCode].disconnectTimer) clearTimeout(rooms[roomCode].disconnectTimer);
        io.to(roomCode).emit('game_reset', 'MSG_ROOM_DELETED');
        delete rooms[roomCode];
    }
}

function assignHostIfMissing(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    const playerIds = Object.keys(room.players);
    if (playerIds.length === 0) return;

    const hasHost = playerIds.some(id => room.players[id].isHost);
    if (!hasHost) {
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
                nightActions: { mafiaTarget: null, doctorTarget: null, detectiveTarget: null },
                dayVotes: {},
                inactivityTimer: null,
                disconnectTimer: null
            };
        }

        const room = rooms[code];

        if (!room) {
            socket.emit('error_message', 'ERR_ROOM_NOT_FOUND');
            return;
        }

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
                players: Object.values(room.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive, isHost: x.isHost }))
            });

            resetInactivityTimer(code);
            checkDisconnectStatus(code);
            return;
        }

        if (room.phase !== 'LOBBY') {
            socket.emit('error_message', 'ERR_ALREADY_STARTED');
            return;
        }

        const isFirstPlayer = Object.keys(room.players).length === 0;

        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            role: null,
            isAlive: true,
            isHost: isFirstPlayer
        };

        resetInactivityTimer(code);
        io.to(code).emit('update_players', { 
            roomCode: code, 
            players: Object.values(room.players)
        });
    });

    socket.on('start_game', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const player = room.players[socket.id];
        if (!player || !player.isHost) {
            socket.emit('error_message', 'ERR_NOT_HOST');
            return;
        }

        resetInactivityTimer(code);
        const playerIds = Object.keys(room.players);
        
        if (playerIds.length < 6) {
            socket.emit('error_message', 'ERR_NEED_6');
            return;
        }

        if (room.phase !== 'LOBBY') return;

        for (let i = playerIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
        }

        // MAFIJOS SKAIČIAUS MATEMATIKA PAGAL ŽAIDĖJŲ KIEKĮ
        let mafiaCount = 1;
        if (playerIds.length >= 8 && playerIds.length <= 11) mafiaCount = 2;
        else if (playerIds.length >= 12 && playerIds.length <= 17) mafiaCount = 3;
        else if (playerIds.length >= 18) mafiaCount = 4;

        let assigned = 0;
        
        for(let i=0; i<mafiaCount; i++) room.players[playerIds[assigned++]].role = 'ROLE_MAFIA';
        room.players[playerIds[assigned++]].role = 'ROLE_DETECTIVE';
        room.players[playerIds[assigned++]].role = 'ROLE_DOCTOR';
        
        while(assigned < playerIds.length) {
            room.players[playerIds[assigned++]].role = 'ROLE_CITIZEN';
        }

        startNightPhase(code);
    });

    socket.on('night_action', (targetId) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        resetInactivityTimer(code);
        const player = room.players[socket.id];
        if (!player || !player.isAlive || room.phase !== 'NIGHT') return;

        // Jei yra kelios mafijos, serveris įsimena to taikinį, kuris paspaudė paskutinis.
        if (player.role === 'ROLE_MAFIA') {
            room.nightActions.mafiaTarget = targetId;
        } else if (player.role === 'ROLE_DOCTOR') {
            room.nightActions.doctorTarget = targetId;
        } else if (player.role === 'ROLE_DETECTIVE') {
            const targetPlayer = room.players[targetId];
            const isMafia = targetPlayer ? targetPlayer.role === 'ROLE_MAFIA' : false;
            socket.emit('detective_result', {
                targetName: targetPlayer ? targetPlayer.name : 'Unknown',
                isMafia: isMafia
            });
            room.nightActions.detectiveTarget = targetId;
        }

        checkNightPhaseEnd(code);
    });

    socket.on('cast_vote', (targetId) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        resetInactivityTimer(code);
        const player = room.players[socket.id];
        if (!player || !player.isAlive || room.phase !== 'DAY_VOTING') return;

        room.dayVotes[socket.id] = targetId;

        const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
        if (Object.keys(room.dayVotes).length >= alivePlayers.length) {
            processDayVotingResults(code);
        }
    });

    socket.on('play_again', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const player = room.players[socket.id];
        if (!player || !player.isHost) return;

        room.phase = 'LOBBY';
        room.nightActions = { mafiaTarget: null, doctorTarget: null, detectiveTarget: null };
        room.dayVotes = {};

        Object.keys(room.players).forEach(id => {
            room.players[id].role = null;
            room.players[id].isAlive = true;
        });

        io.to(code).emit('update_players', { 
            roomCode: code, 
            players: Object.values(room.players)
        });
    });

    socket.on('reset_game', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const player = room.players[socket.id];
        if (player && player.isHost) {
            deleteRoom(code);
        } else {
            socket.emit('error_message', 'ERR_NOT_HOST_RESET');
        }
    });

    socket.on('leave_room', () => {
        const code = socket.roomCode;
        const room = rooms[code];

        if (room && room.players[socket.id]) {
            delete room.players[socket.id];
            socket.leave(code);
            socket.roomCode = null;

            assignHostIfMissing(code);

            if (Object.keys(room.players).length === 0) {
                deleteRoom(code);
            } else {
                io.to(code).emit('update_players', { 
                    roomCode: code, 
                    players: Object.values(room.players)
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const code = socket.roomCode;
        const room = rooms[code];

        if (room && room.players[socket.id]) {
            if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') {
                delete room.players[socket.id];
                assignHostIfMissing(code);
                io.to(code).emit('update_players', { 
                    roomCode: code, 
                    players: Object.values(room.players)
                });
            }
            
            checkDisconnectStatus(code);

            if (Object.keys(room.players).length === 0) {
                deleteRoom(code);
            }
        }
    });
});

function startNightPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'NIGHT';
    room.nightActions = { mafiaTarget: null, doctorTarget: null, detectiveTarget: null };

    Object.keys(room.players).forEach(id => {
        const p = room.players[id];
        io.to(id).emit('phase_change', {
            roomCode: roomCode,
            phase: 'NIGHT',
            role: p.role,
            isAlive: p.isAlive,
            isHost: p.isHost,
            players: Object.values(room.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive, isHost: x.isHost }))
        });
    });
}

function checkNightPhaseEnd(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
    
    const hasMafia = alivePlayers.some(p => p.role === 'ROLE_MAFIA');
    const hasDoctor = alivePlayers.some(p => p.role === 'ROLE_DOCTOR');
    const hasDetective = alivePlayers.some(p => p.role === 'ROLE_DETECTIVE');

    const mafiaDone = !hasMafia || room.nightActions.mafiaTarget !== null;
    const doctorDone = !hasDoctor || room.nightActions.doctorTarget !== null;
    const detectiveDone = !hasDetective || room.nightActions.detectiveTarget !== null;

    if (mafiaDone && doctorDone && detectiveDone) {
        processNightResults(roomCode);
    }
}

function processNightResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    let killedId = null;
    if (room.nightActions.mafiaTarget && room.nightActions.mafiaTarget !== room.nightActions.doctorTarget) {
        killedId = room.nightActions.mafiaTarget;
        if (room.players[killedId]) {
            room.players[killedId].isAlive = false;
        }
    }

    if (checkWinCondition(roomCode)) return;

    room.phase = 'DAY_VOTING';
    room.dayVotes = {};

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

    const voteCounts = {};
    Object.values(room.dayVotes).forEach(targetId => {
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
            isTie = true;
        }
    });

    if (executedId && !isTie && room.players[executedId]) {
        room.players[executedId].isAlive = false;
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

    if (mafiaAlive === 0) {
        winner = 'WIN_CITIZENS';
    } else if (mafiaAlive >= innocentsAlive) {
        winner = 'WIN_MAFIA';
    }

    if (winner) {
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
server.listen(PORT, () => {
    console.log(`Serveris sėkmingai pasileido ant prievado ${PORT}`);
});
