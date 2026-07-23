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
const RECONNECT_GRACE_MS = 20 * 1000; // Kiek laiko laukiamajame laukiame, kol žaidėjas persijungs po refresh

// ============================================================================
// SVARBU: žaidėjo TAPATYBĖ dabar yra stabilus "token" (klientas jį sugeneruoja
// ir saugo sessionStorage, siunčia su kiekvienu join_game), o NE socket.id.
// Anksčiau viskas (balsai, kaltinamasis ir t.t.) buvo saugoma pagal socket.id,
// kuris pasikeisdavo kiekvieną kartą atnaujinus (F5) puslapį - dėl to po
// persijungimo senos balso/veiksmo įrašai "nukarodavo" (nebeatitikdavo joks
// gyvo žaidėjo), balsavimai užstrigdavo, o vardo patikra klaidingai rodydavo
// "jau užimtas". Dabar room.players yra raktas = token (pastovus), o
// player.socketId nurodo, koks socket.id šiuo metu su juo susietas (jei
// prisijungęs) - tai keičiasi laisvai, žaidimo logika nuo to nebepriklauso.
// ============================================================================

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
    Object.values(room.players).forEach(p => { if (p.leaveTimer) clearTimeout(p.leaveTimer); });
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
    const ids = Object.keys(room.players);
    if (ids.length === 0) return;
    if (!ids.some(id => room.players[id].isHost)) {
        room.players[ids[0]].isHost = true;
    }
}

function publicPlayers(room) {
    return Object.values(room.players).map(x => ({ id: x.id, name: x.name, isAlive: x.isAlive, isHost: x.isHost }));
}

// Siunčia žinutę konkrečiam žaidėjui (pagal jo DABARTINĮ socket.id, jei prisijungęs).
function sendToPlayer(room, playerId, event, payload) {
    const p = room.players[playerId];
    if (p && p.socketId) io.to(p.socketId).emit(event, payload);
}

// Apsauga: viena netikėta klaida bet kuriame įvykio apdorojime NEBETURI nutraukti viso proceso.
process.on('uncaughtException', (err) => {
    console.error('NETIKĖTA KLAIDA (serveris tęsia darbą):', err);
});
process.on('unhandledRejection', (err) => {
    console.error('NEAPDOROTAS PAŽADO ATMETIMAS (serveris tęsia darbą):', err);
});

io.on('connection', (socket) => {
    socket.on('join_game', (data) => {
      try {
        const { playerName, roomCode, token } = data || {};

        if (typeof playerName !== 'string' || playerName.trim().length === 0 || playerName.trim().length > 20) {
            return socket.emit('error_message', 'ERR_BAD_NAME');
        }
        if (typeof token !== 'string' || token.length < 4 || token.length > 100) {
            return socket.emit('error_message', 'ERR_BAD_NAME');
        }
        const cleanName = playerName.trim();

        let code = roomCode ? String(roomCode).trim().toUpperCase() : null;

        if (!code) {
            code = generateRoomCode();
            rooms[code] = {
                phase: 'LOBBY',
                players: {},
                mafiaVotes: {}, doctorTarget: null, detectiveTarget: null,
                doctorActed: false, detectiveActed: false,
                dayVotes: {}, accusedId: null,
                defenseVotes: { yes: 0, no: 0, voted: {} },
                timerSeconds: 0, nightTimer: null
            };
        }

        const room = rooms[code];
        if (!room) return socket.emit('error_message', 'ERR_ROOM_NOT_FOUND');

        socket.join(code);
        socket.roomCode = code;
        socket.playerToken = token;

        // 1) Šis token'as jau žinomas šiame kambaryje -> tai TAS PATS žaidėjas persijungia (refresh ir pan).
        if (room.players[token]) {
            const player = room.players[token];
            if (player.leaveTimer) { clearTimeout(player.leaveTimer); player.leaveTimer = null; }

            player.name = cleanName; // leidžiam atnaujinti vardo rašybą, jei keitė
            player.socketId = socket.id;
            player.connected = true;

            assignHostIfMissing(code);
            resetInactivityTimer(code);

            if (room.phase === 'LOBBY') {
                io.to(code).emit('update_players', { roomCode: code, players: Object.values(room.players) });
            } else if (room.phase === 'GAME_OVER' && room.lastGameOver) {
                socket.emit('game_over', room.lastGameOver);
            } else {
                socket.emit('phase_change', {
                    roomCode: code,
                    phase: room.phase,
                    role: player.role,
                    isAlive: player.isAlive,
                    isHost: player.isHost,
                    accusedName: room.accusedId && room.players[room.accusedId] ? room.players[room.accusedId].name : null,
                    accusedId: room.accusedId || null,
                    timer: room.phase === 'NIGHT' ? room.timerSeconds : undefined,
                    players: publicPlayers(room)
                });
            }
            return;
        }

        // 2) Naujas token'as, bet vardas jau naudojamas kito ŠIUO METU prisijungusio žaidėjo -> tikras konfliktas.
        const nameClash = Object.values(room.players).find(
            p => p.name.toLowerCase() === cleanName.toLowerCase() && p.connected
        );
        if (nameClash) return socket.emit('error_message', 'ERR_NAME_TAKEN');

        // 3) Naujas žaidėjas - leidžiama tik laukiamajame.
        if (room.phase !== 'LOBBY') return socket.emit('error_message', 'ERR_ALREADY_STARTED');

        room.players[token] = {
            id: token,
            name: cleanName,
            role: null,
            isAlive: true,
            isHost: Object.keys(room.players).length === 0,
            connected: true,
            socketId: socket.id,
            leaveTimer: null
        };

        resetInactivityTimer(code);
        io.to(code).emit('update_players', { roomCode: code, players: Object.values(room.players) });
      } catch (err) {
        console.error('Klaida join_game metu (nesugriuvo visas serveris):', err);
        socket.emit('error_message', 'ERR_ROOM_NOT_FOUND');
      }
    });

    socket.on('start_game', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const player = room.players[socket.playerToken];
        if (!player || !player.isHost) return socket.emit('error_message', 'ERR_NOT_HOST');

        const playerIds = Object.keys(room.players);
        if (playerIds.length < 6) return socket.emit('error_message', 'ERR_NEED_6');
        if (room.phase !== 'LOBBY') return;

        resetInactivityTimer(code);

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

    // TYLUS MAFIJOS BALSAVIMAS IR KITI NAKTIES VEIKSMAI
    socket.on('night_action', (targetId) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || room.phase !== 'NIGHT') return;

        const player = room.players[socket.playerToken];
        if (!player || !player.isAlive) return;

        resetInactivityTimer(code);

        if (player.role === 'ROLE_MAFIA') {
            room.mafiaVotes[player.id] = targetId;

            const counts = {};
            Object.values(room.mafiaVotes).forEach(tid => { counts[tid] = (counts[tid] || 0) + 1; });

            Object.values(room.players)
                .filter(p => p.role === 'ROLE_MAFIA' && p.isAlive)
                .forEach(p => sendToPlayer(room, p.id, 'mafia_votes_update', counts));

        } else if (player.role === 'ROLE_DOCTOR') {
            // Taisyklės: gydytojas gali apsigalvoti - kiekvienas paspaudimas PAKEIČIA ankstesnį
            // pasirinkimą, galioja tik paskutinis. Rezultatas paskelbiamas tik ryte.
            room.doctorTarget = targetId;
            room.doctorActed = true;
        } else if (player.role === 'ROLE_DETECTIVE') {
            // Taip pat ir detektyvas - gali keisti pasirinkimą iki nakties pabaigos, galioja paskutinis.
            room.detectiveTarget = targetId;
            room.detectiveActed = true;
        }
        // ROLE_CITIZEN veiksmai ignoruojami serveryje (naudojami tik kaip dekoracija kliente)
    });

    // DIENOS BALSAVIMAS (NOMINAVIMAS)
    socket.on('cast_vote', (targetId) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || room.phase !== 'DAY_VOTING') return;

        const player = room.players[socket.playerToken];
        if (!player || !player.isAlive) return;
        if (!room.players[targetId] || !room.players[targetId].isAlive) return;

        resetInactivityTimer(code);
        room.dayVotes[player.id] = targetId;

        const aliveCount = Object.values(room.players).filter(p => p.isAlive).length;
        const counts = {};
        Object.values(room.dayVotes).forEach(tid => { counts[tid] = (counts[tid] || 0) + 1; });
        const anyMajority = Object.values(counts).some(c => c > aliveCount / 2);
        const allVoted = Object.keys(room.dayVotes).length >= aliveCount;

        if (anyMajority || allVoted) processDayVotingResults(code);
    });

    // GYNYBINĖS KALBOS BALSAVIMAS (TAIP/NE)
    socket.on('defense_vote', (value) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || room.phase !== 'DAY_DEFENSE') return;

        const player = room.players[socket.playerToken];
        if (!player || !player.isAlive || room.defenseVotes.voted[player.id]) return;
        if (player.id === room.accusedId) return; // kaltinamasis nebalsuoja dėl savo likimo

        resetInactivityTimer(code);
        room.defenseVotes.voted[player.id] = true;
        if (value) room.defenseVotes.yes++; else room.defenseVotes.no++;

        const eligibleVoters = Object.values(room.players).filter(p => p.isAlive && p.id !== room.accusedId);
        if (Object.keys(room.defenseVotes.voted).length >= eligibleVoters.length) {
            finalizeElimination(code);
        }
    });

    socket.on('play_again', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const player = room.players[socket.playerToken];
        if (!player || !player.isHost) return;

        if (room.nightTimer) clearInterval(room.nightTimer);
        if (room.dayTimeout) clearTimeout(room.dayTimeout);
        if (room.defenseTimeout) clearTimeout(room.defenseTimeout);

        room.phase = 'LOBBY';
        room.mafiaVotes = {};
        room.doctorTarget = null;
        room.detectiveTarget = null;
        room.doctorActed = false;
        room.detectiveActed = false;
        room.dayVotes = {};
        room.accusedId = null;
        room.lastGameOver = null;

        Object.keys(room.players).forEach(id => {
            room.players[id].role = null;
            room.players[id].isAlive = true;
        });

        io.to(code).emit('update_players', { roomCode: code, players: Object.values(room.players) });
    });

    socket.on('reset_game', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;
        const player = room.players[socket.playerToken];
        if (player && player.isHost) deleteRoom(code);
        else socket.emit('error_message', 'ERR_NOT_HOST');
    });

    socket.on('leave_room', () => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (room && room.players[socket.playerToken]) {
            const player = room.players[socket.playerToken];
            if (player.leaveTimer) clearTimeout(player.leaveTimer);
            delete room.players[socket.playerToken];
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
        const token = socket.playerToken;
        if (room && token && room.players[token] && room.players[token].socketId === socket.id) {
            const player = room.players[token];
            player.connected = false;
            player.socketId = null;

            if (room.phase === 'LOBBY') {
                // Laukiamajame duodame trumpą laiką (persijungimui po refresh), tik tada realiai pašaliname.
                player.leaveTimer = setTimeout(() => {
                    const r = rooms[code];
                    if (r && r.players[token] && !r.players[token].connected) {
                        delete r.players[token];
                        assignHostIfMissing(code);
                        io.to(code).emit('update_players', { roomCode: code, players: Object.values(r.players) });
                        if (Object.keys(r.players).length === 0) deleteRoom(code);
                    }
                }, RECONNECT_GRACE_MS);
            }
            // NIGHT / DAY_VOTING / DAY_DEFENSE / GAME_OVER metu žaidėjas NEŠALINAMAS -
            // jis lieka kambaryje kaip "vaiduoklis", kad galėtų persijungti bet kada tuo pačiu token'u.
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
    room.doctorActed = false;
    room.detectiveActed = false;
    room.timerSeconds = NIGHT_DURATION;

    if (room.nightTimer) clearInterval(room.nightTimer);

    room.nightTimer = setInterval(() => {
        room.timerSeconds--;
        io.to(roomCode).emit('timer_tick', room.timerSeconds);
        if (room.timerSeconds <= 0) {
            clearInterval(room.nightTimer);
            processNightResults(roomCode);
        }
    }, 1000);

    io.to(roomCode).emit('phase_change', {
        roomCode: roomCode,
        phase: 'NIGHT',
        timer: NIGHT_DURATION,
        players: publicPlayers(room)
    });
    // Vaidmuo/gyvumas kiekvienam siunčiamas individualiai (skirtingi vaidmenys skirtingiems žaidėjams).
    Object.values(room.players).forEach(p => {
        sendToPlayer(room, p.id, 'phase_change', {
            roomCode: roomCode, phase: 'NIGHT', role: p.role, isAlive: p.isAlive, isHost: p.isHost,
            timer: NIGHT_DURATION, players: publicPlayers(room)
        });
    });
}

function processNightResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.nightTimer) clearInterval(room.nightTimer);

    const voteCounts = {};
    Object.values(room.mafiaVotes).forEach(tid => { voteCounts[tid] = (voteCounts[tid] || 0) + 1; });

    let mafiaTarget = null, maxVotes = 0;
    Object.keys(voteCounts).forEach(tid => {
        if (voteCounts[tid] > maxVotes) { maxVotes = voteCounts[tid]; mafiaTarget = tid; }
    });

    let killedId = null;
    if (mafiaTarget && mafiaTarget !== room.doctorTarget) {
        killedId = mafiaTarget;
        if (room.players[killedId]) room.players[killedId].isAlive = false;
    }

    let doctorOutcome = 'NONE';
    if (room.doctorActed) {
        doctorOutcome = (mafiaTarget && room.doctorTarget && mafiaTarget === room.doctorTarget) ? 'SUCCESS' : 'FAIL';
    }
    let detectiveOutcome = 'NONE';
    if (room.detectiveActed && room.detectiveTarget) {
        const checkedPlayer = room.players[room.detectiveTarget];
        detectiveOutcome = (checkedPlayer && checkedPlayer.role === 'ROLE_MAFIA') ? 'SUCCESS' : 'FAIL';
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

    const killedPlayer = killedId && room.players[killedId] ? room.players[killedId].name : null;

    io.to(roomCode).emit('phase_change', {
        roomCode: roomCode,
        phase: 'DAY_VOTING',
        killedPlayer: killedPlayer,
        doctorOutcome: doctorOutcome,
        detectiveOutcome: detectiveOutcome,
        players: publicPlayers(room)
    });
}

function processDayVotingResults(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'DAY_VOTING') return;

    if (room.dayTimeout) { clearTimeout(room.dayTimeout); room.dayTimeout = null; }

    const aliveCount = Object.values(room.players).filter(p => p.isAlive).length;
    const voteCounts = {};
    Object.values(room.dayVotes).forEach(targetId => { voteCounts[targetId] = (voteCounts[targetId] || 0) + 1; });

    let accusedId = null, maxVotes = 0;
    Object.keys(voteCounts).forEach(id => {
        if (voteCounts[id] > maxVotes) { maxVotes = voteCounts[id]; accusedId = id; }
    });

    // Reikalinga TIKRA dauguma - daugiau nei pusė VISŲ gyvų žaidėjų, ne tik tų, kurie pabalsavo.
    if (!accusedId || maxVotes <= aliveCount / 2 || !room.players[accusedId] || !room.players[accusedId].isAlive) {
        startNightPhase(roomCode);
        return;
    }

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
        players: publicPlayers(room)
    });
}

function finalizeElimination(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'DAY_DEFENSE') return;

    if (room.defenseTimeout) { clearTimeout(room.defenseTimeout); room.defenseTimeout = null; }

    if (room.defenseVotes.yes > room.defenseVotes.no && room.accusedId && room.players[room.accusedId]) {
        room.players[room.accusedId].isAlive = false;
    }
    room.accusedId = null;

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
        if (room.dayTimeout) clearTimeout(room.dayTimeout);
        if (room.defenseTimeout) clearTimeout(room.defenseTimeout);
        room.phase = 'GAME_OVER';
        const payload = {
            winner: winner,
            summary: Object.values(room.players).map(x => ({ name: x.name, role: x.role, isAlive: x.isAlive }))
        };
        room.lastGameOver = payload;
        io.to(roomCode).emit('game_over', payload);
        return true;
    }
    return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveris veikia ant prievado ${PORT}`));
